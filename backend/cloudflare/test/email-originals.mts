import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMimeMessage, processInboundEmail, MemoryEmailAddressDb, allocateHyggeAddress, validateEmailReading, boundedEmailOriginal } from "../src/email.ts";
import * as vault from "../src/vault.ts";

test("original MIME alternatives are retained separately, without repeating text or including text attachments", () => {
  const raw = ['From: Client <client@example.com>', 'To: 1234567890@usehygge.cc', 'Cc: colleague@example.com', 'Subject: Original subject', 'Content-Type: multipart/mixed; boundary=x', '', '--x', 'Content-Type: text/plain', '', 'Complete original body.', '--x', 'Content-Type: text/html', '', '<p>Complete <b>original</b> body.</p>', '--x', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="notes.txt"', '', 'Private attachment contents', '--x--'].join('\r\n');
  const parsed = parseMimeMessage(raw);
  assert.equal(parsed.original?.text, 'Complete original body.');
  assert.equal(parsed.original?.cc, 'colleague@example.com');
  assert.ok(parsed.original?.html?.includes('<b>original</b>'));
  assert.ok(!parsed.original?.text.includes('Private attachment'));
  assert.equal(parsed.attachments[0].filename, 'notes.txt');
});
test("ordinary original is retained beyond the model text limit; protection mail never delivers an original", async () => {
  const db = new MemoryEmailAddressDb();
  const address = await allocateHyggeAddress(db, 'user');
  for (const protectedMail of [false, true]) {
    const deliveries: any[] = [];
    const raw = ['From: sender@example.com','Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com',`To: ${address.digits}@usehygge.cc`,`Subject: ${protectedMail ? 'Your verification code' : 'Work message'}`, 'Content-Type: text/plain','', protectedMail ? 'Your verification code is 731904' : 'x'.repeat(30_000)].join('\r\n');
    await processInboundEmail({ to: `${address.digits}@usehygge.cc`, raw }, { db, deliver: async (_id, delivery) => deliveries.push(delivery) });
    assert.equal(deliveries.length, 1);
    if (protectedMail) assert.equal(deliveries[0].original, undefined);
    else assert.equal(deliveries[0].original.text.length, 30_000);
  }
});
test("AI titles are bounded and separate from the original subject", () => {
  assert.equal(validateEmailReading({ title: '  Five roles\nfrom Upwork  ', summary: 'A digest.' }, { ownerVerified: false })?.title, 'Five roles from Upwork');
  assert.equal(validateEmailReading({ title: 'a'.repeat(300), summary: 'A digest.' }, { ownerVerified: false })?.title?.length, 100);
  assert.equal(validateEmailReading({ summary: 'Old model output.' }, { ownerVerified: false })?.title, undefined);
});
test("sealed originals cannot be opened under a different message identity or user key", async () => {
  const key = await vault.generateDEK(), other = await vault.generateDEK();
  const sealed = await vault.seal(key, 'Original mail body', 'email-original:one');
  assert.equal(await vault.open(key, sealed, 'email-original:one'), 'Original mail body');
  await assert.rejects(vault.open(key, sealed, 'email-original:two'));
  await assert.rejects(vault.open(other, sealed, 'email-original:one'));
});

test("pathological body escaping stays within the sealed row budget and is explicitly marked partial", () => {
  const original = boundedEmailOriginal({ from: "x@example.com", to: "me@usehygge.cc", subject: "Large mail", date: null, text: "\u0000".repeat(500_000), html: "<p>" + "\u0000".repeat(500_000) + "</p>", truncated: false });
  assert.equal(original.truncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(original)).length <= 750_000);
});
