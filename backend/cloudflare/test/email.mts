// Brief 04 receive-only email: allocation, parsing, pipeline,
// verification completion, consume-then-delete codes, cross-user
// isolation, and the no-send-path assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { SimulatedDecider, emailCodeAllowedForTask, runMission } from "../src/agent.ts";
import { LLMClient } from "../src/llm.ts";
import {
  MemoryEmailAddressDb,
  addressForUser,
  allocateHyggeAddress,
  attachEmailToTasks,
  classifyEmail,
  extractEmailCode,
  extractEmailHighlights,
  parseOwnerEmailCommand,
  senderEmailOf,
  generateSitePassword,
  handleEmailAddressRequest,
  isSafeVerificationLink,
  isStrongSitePassword,
  parseMimeMessage,
  parseRecipientDigits,
  processInboundEmail,
  senderPassesAuthentication,
  takeFreshCode,
  type InboundEmailDelivery,
} from "../src/email.ts";

function rngDigits(...seq: string[]) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

test("address allocation: unique digits, forced-collision retry, idempotent per user", async () => {
  const db = new MemoryEmailAddressDb();
  const first = await allocateHyggeAddress(db, "user-a", { nextDigits: rngDigits("4839201847") });
  assert.equal(first.digits, "4839201847");
  // Same first draw collides with user-a; retry must land elsewhere.
  const second = await allocateHyggeAddress(db, "user-b", { nextDigits: rngDigits("4839201847", "1122334455") });
  assert.equal(second.digits, "1122334455");
  assert.notEqual(first.digits, second.digits);
  // Re-allocating for the same user returns the same address.
  const again = await allocateHyggeAddress(db, "user-a", { nextDigits: rngDigits("9999999999") });
  assert.equal(again.digits, "4839201847");
});

test("allocation output is independent of user profile fields", async () => {
  // allocateHyggeAddress accepts no name/email input; two users with
  // any profile draw purely from the random sequence, in order.
  const db = new MemoryEmailAddressDb();
  const seq = rngDigits("5000000001", "5000000002");
  const sam = await allocateHyggeAddress(db, "uid-sam-leeds", { nextDigits: seq });
  const other = await allocateHyggeAddress(db, "uid-unrelated", { nextDigits: seq });
  assert.equal(sam.digits, "5000000001");
  assert.equal(other.digits, "5000000002");
  assert.match(sam.digits, /^\d{10}$/);
});

test("recipient parsing: only 10-digit @usehygge.cc addresses route", () => {
  assert.equal(parseRecipientDigits("4839201847@usehygge.cc"), "4839201847");
  assert.equal(parseRecipientDigits("Hygge <4839201847@UseHygge.CC>"), "4839201847");
  assert.equal(parseRecipientDigits("sam@usehygge.cc"), null);
  assert.equal(parseRecipientDigits("483920184@usehygge.cc"), null);
  assert.equal(parseRecipientDigits("4839201847@example.com"), null);
  assert.equal(parseRecipientDigits(""), null);
});

test("cross-user: address endpoint only ever returns the caller's own address", async () => {
  const db = new MemoryEmailAddressDb();
  await allocateHyggeAddress(db, "user-a", { nextDigits: rngDigits("4839201847") });
  const env = { HYGGE_EMAIL_DOMAIN: "usehygge.cc" } as any;
  const get = (userId: string) => handleEmailAddressRequest(
    new Request("https://api/email/address"), env, userId, db);
  const mine = await (await get("user-a")).json() as any;
  assert.equal(mine.hyggeEmail.address, "4839201847@usehygge.cc");
  const theirs = await (await get("user-b")).json() as any;
  assert.equal(theirs.hyggeEmail, null); // no digits parameter exists to hunt with
  assert.equal((await addressForUser(db, "user-b")) , null);
  assert.equal((await addressForUser(db, "user-a"))?.digits, "4839201847");
});

const VERIFICATION_RAW = [
  "From: Rover <no-reply@rover.com>",
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=rover.com; spf=pass smtp.mailfrom=no-reply@rover.com",
  "To: 4839201847@usehygge.cc",
  "Subject: Verify your email to finish signing up",
  "Date: Sat, 31 Oct 2026 10:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Welcome! Tap to verify: https://www.rover.com/verify?token=SUPERSECRETTOKEN",
  "Or enter this verification code: 731904",
].join("\r\n");

test("MIME parse: headers, links, code extraction, classification", () => {
  const parsed = parseMimeMessage(VERIFICATION_RAW);
  assert.equal(parsed.from.includes("rover.com"), true);
  assert.equal(parsed.subject, "Verify your email to finish signing up");
  assert.deepEqual(parsed.links, ["https://www.rover.com/verify?token=SUPERSECRETTOKEN"]);
  assert.equal(extractEmailCode(parsed.subject, parsed.text), "731904");
  assert.equal(classifyEmail(parsed), "verification");
});

test("MIME parse: attachment bodies dropped, metadata only", () => {
  const payload = Buffer.from("ATTACHMENT-SECRET-CONTENT").toString("base64");
  const raw = [
    "From: Site <mail@gigs.example.com>",
    "To: 4839201847@usehygge.cc",
    "Subject: Your statement",
    'Content-Type: multipart/mixed; boundary="B42"',
    "",
    "--B42",
    "Content-Type: text/plain",
    "",
    "Your monthly statement is ready.",
    "--B42",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="statement.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    payload,
    "--B42--",
  ].join("\r\n");
  const parsed = parseMimeMessage(raw);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, "statement.pdf");
  assert.equal(parsed.attachments[0].contentType, "application/pdf");
  assert.ok(parsed.attachments[0].size > 0);
  assert.equal(JSON.stringify(parsed).includes("ATTACHMENT-SECRET"), false);
  assert.equal(parsed.text.includes("monthly statement"), true);
});

test("code extraction handles grouped and keyword-first forms", () => {
  assert.equal(extractEmailCode("Your sign-in code is 482 913"), "482913");
  assert.equal(extractEmailCode("Use 991-204 as your passcode"), "991204");
  assert.equal(extractEmailCode("No codes in this newsletter from 2026"), null);
  assert.equal(isSafeVerificationLink("https://rover.com/verify?token=x"), true);
  assert.equal(isSafeVerificationLink("http://rover.com/verify"), false);
  assert.equal(isSafeVerificationLink("https://127.0.0.1/verify"), false);
  assert.equal(isSafeVerificationLink("https://user:pw@rover.com/verify"), false);
});

async function pipeline(raw: string, to = "4839201847@usehygge.cc") {
  const db = new MemoryEmailAddressDb();
  await allocateHyggeAddress(db, "owner-1", { nextDigits: rngDigits("4839201847") });
  const deliveries: { userId: string; delivery: InboundEmailDelivery }[] = [];
  const followed: string[] = [];
  const result = await processInboundEmail({ to, raw }, {
    db,
    now: () => new Date("2026-10-31T10:05:00.000Z"),
    deliver: async (userId, delivery) => { deliveries.push({ userId, delivery }); },
    followLink: async (url) => { followed.push(url); return { ok: true, status: 200 }; },
  });
  return { db, deliveries, followed, result };
}

test("end-to-end: verification mail completes a pending Hygge signup, code nowhere in outputs", async () => {
  const { deliveries, followed, result } = await pipeline(VERIFICATION_RAW);
  assert.equal(result.disposition, "delivered");
  assert.equal(result.kind, "verification");
  assert.equal(followed.length, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].userId, "owner-1");
  // The sealed-store delivery carries the code; nothing else may.
  assert.equal(deliveries[0].delivery.code, "731904");
  assert.equal(JSON.stringify(result).includes("731904"), false);
  assert.equal(JSON.stringify(deliveries[0].delivery.summary).includes("731904"), false);
  assert.equal(JSON.stringify(deliveries[0].delivery.summary).includes("SUPERSECRETTOKEN"), false);

  const pending = {
    id: "t1", kind: "signup", status: "needsHuman",
    target_url: "https://www.rover.com/join", email_choice: "hygge",
    awaiting_email_verification: true, log: ["Drafted."],
  };
  const otherSite = { id: "t2", kind: "signup", status: "needsHuman", target_url: "https://upwork.com", log: [] };
  const updated = attachEmailToTasks([pending, otherSite], deliveries[0].delivery);
  assert.equal(updated[0].status, "succeeded");
  assert.equal(updated[1].status, "needsHuman"); // different site untouched
  assert.equal(JSON.stringify(updated).includes("731904"), false);
  assert.equal(JSON.stringify(updated).includes("SUPERSECRETTOKEN"), false);
});

test("forwarded mail from the user's own mailbox lands in the same pipeline", async () => {
  const raw = [
    "From: Sam Example <sam@gmail.com>",
    "To: 4839201847@usehygge.cc",
    "Subject: Fwd: New dog-sitting request on Rover",
    "Content-Type: text/plain",
    "",
    "Forwarded for Hygge to file: a new request for this weekend near Leeds.",
  ].join("\r\n");
  const { deliveries, result } = await pipeline(raw);
  assert.equal(result.disposition, "delivered"); // attributed by recipient digits
  assert.equal(result.kind, "other");
  assert.equal(deliveries[0].userId, "owner-1");
  assert.equal(deliveries[0].delivery.code, null);
  assert.match(deliveries[0].delivery.summary.summary, /new request/);
});

test("sender authentication: aligned pass required; spoofed mail is only filed", async () => {
  assert.equal(senderPassesAuthentication("mx; dkim=pass header.d=rover.com", "rover.com"), true);
  assert.equal(senderPassesAuthentication("mx; dkim=pass header.d=mail.rover.com", "rover.com"), true);
  assert.equal(senderPassesAuthentication("mx; dmarc=pass header.from=rover.com", "rover.com"), true);
  assert.equal(senderPassesAuthentication("mx; spf=pass smtp.mailfrom=bounce@rover.com", "rover.com"), true);
  assert.equal(senderPassesAuthentication("mx; dkim=pass header.d=evil.example", "rover.com"), false);
  assert.equal(senderPassesAuthentication("mx; dkim=fail header.d=rover.com", "rover.com"), false);
  assert.equal(senderPassesAuthentication("", "rover.com"), false);
  assert.equal(parseMimeMessage(VERIFICATION_RAW).senderAuthenticated, true);

  // Same verification mail with the authentication header stripped:
  // filed as ordinary mail, link never followed, no code carried.
  const spoofed = VERIFICATION_RAW.replace(/Authentication-Results:.*\r\n/, "");
  assert.equal(parseMimeMessage(spoofed).senderAuthenticated, false);
  const { deliveries, followed, result } = await pipeline(spoofed);
  assert.equal(result.disposition, "delivered");
  assert.equal(result.kind, "other");
  assert.equal(followed.length, 0);
  assert.equal(deliveries[0].delivery.code, null);
  assert.equal(deliveries[0].delivery.verification, null);

  // A forged code mail with a failing result seals nothing either.
  const forgedCode = [
    "From: Upwork <security@upwork.com>",
    "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=upwork.com; spf=fail smtp.mailfrom=security@upwork.com",
    "To: 4839201847@usehygge.cc",
    "Subject: Your sign-in code",
    "Content-Type: text/plain",
    "",
    "Your one-time code is 999999. It expires soon.",
  ].join("\r\n");
  const forged = await pipeline(forgedCode);
  assert.equal(forged.result.kind, "other");
  assert.equal(forged.deliveries[0].delivery.code, null);
});

test("emailed 2FA code: consumed once then gone; expired codes never chosen", async () => {
  const raw = [
    "From: Upwork <security@upwork.com>",
    "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=upwork.com",
    "To: 4839201847@usehygge.cc",
    "Subject: Your sign-in code",
    "Content-Type: text/plain",
    "",
    "Your one-time code is 246810. It expires soon.",
  ].join("\r\n");
  const { deliveries, result } = await pipeline(raw);
  assert.equal(result.kind, "security_code");
  assert.equal(JSON.stringify(result).includes("246810"), false);
  assert.equal(JSON.stringify(deliveries[0].delivery.summary).includes("246810"), false);

  // Pending-code store contract used by UserSandbox.consumeEmailCode:
  // take the fresh record, delete it, and a second take finds none.
  const store = [{ id: "c1", senderDomain: "upwork.com", receivedAt: "2026-10-31T10:05:00.000Z", code: deliveries[0].delivery.code }];
  const now = Date.parse("2026-10-31T10:06:00.000Z");
  const taken = takeFreshCode(store, "upwork.com", now);
  assert.equal(taken?.code, "246810");
  const remaining = store.filter((r) => r.id !== taken!.id);
  assert.equal(takeFreshCode(remaining, "upwork.com", now), null); // deleted after consumption
  assert.equal(takeFreshCode(store, "upwork.com", now + 31 * 60 * 1000), null); // expired
  assert.equal(takeFreshCode(store, "rover.com", now), null); // wrong site
});

test("mission consumes an emailed code once via valueRef; without one it attempts then asks", async () => {
  const cfg = { baseUrl: "https://api.meta.ai/v1", modelFast: "muse-spark-1.3", modelStrong: "muse-wonder-1.0" };
  const makeBrowser = () => {
    let verified = false;
    let codeTyped = false;
    const acts: any[] = [];
    const snap = () => ({
      sessionID: "s1", currentURLString: "https://upwork.com/check", mode: "fake",
      title: verified ? "Dashboard" : "Enter the verification code we sent",
      elements: verified
        ? [{ label: "Dashboard", kind: "text" }]
        : [{ label: "Verification code", kind: "type" }, { label: "Verify button", kind: "click" }],
    });
    return {
      mode: "fake", acts,
      createSession: async () => snap(),
      snapshot: async () => snap(),
      act: async (_id: string, action: any) => {
        acts.push(action);
        // The page only verifies once the real code was entered;
        // clicking Verify empty-handed cannot clear the check.
        if (action.action === "type" && action.value === "246810") codeTyped = true;
        if (action.action === "click" && codeTyped) verified = true;
        return snap();
      },
      extract: async () => (verified ? ["Welcome back"] : []),
      closeSession: async () => true,
    };
  };
  const task = {
    kind: "apply", target_url: "https://upwork.com/check", goal: "Check messages",
    drafted_payload: {}, log: [],
  };
  let fills = 0;
  const browser = makeBrowser();
  const result = await runMission({
    browser, task,
    decider: new SimulatedDecider(new LLMClient(cfg)),
    hasEmailCode: true,
    fillEmailCodeValue: async (target: string, sessionID: string) => {
      fills += 1; // the sandbox deletes the sealed row before this types
      await browser.act(sessionID, { action: "type", target, value: "246810" });
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(fills, 1); // consumed exactly once
  assert.equal(JSON.stringify(result.trace).includes("246810"), false);
  assert.equal(JSON.stringify(result.log).includes("246810"), false);

  // Same page, no emailed code waiting: bounded attempts happen,
  // no code is invented, and the mission ends by asking.
  const browser2 = makeBrowser();
  const paused = await runMission({
    browser: browser2, task: { ...task, log: [] },
    decider: new SimulatedDecider(new LLMClient(cfg)),
    hasEmailCode: false,
  });
  assert.equal(paused.status, "needs_human");
  assert.ok(browser2.acts.length > 0, "expected attempt actions");
  assert.ok(browser2.acts.every((a: any) => a.action !== "type"), "no literal code may be typed");
});

test("merged Brief 04+05: a scheduled scan attempts a check but never spends an emailed code", async () => {
  assert.equal(emailCodeAllowedForTask({ scheduled_scan: true }), false);
  assert.equal(emailCodeAllowedForTask({ scheduled_scan: false }), true);
  assert.equal(emailCodeAllowedForTask({}), true);
  const cfg = { baseUrl: "https://api.meta.ai/v1", modelFast: "muse-spark-1.3", modelStrong: "muse-wonder-1.0" };
  const acts: any[] = [];
  const snap = () => ({
    sessionID: "s1", currentURLString: "https://upwork.com/check", mode: "fake",
    title: "Enter the verification code we sent",
    elements: [{ label: "Verification code", kind: "type" }, { label: "Verify button", kind: "click" }],
  });
  const browser = {
    mode: "fake", acts,
    createSession: async () => snap(),
    snapshot: async () => snap(),
    act: async (_id: string, action: any) => { acts.push(action); return snap(); },
    extract: async () => [],
    closeSession: async () => true,
  };
  // A code is pending for a user mission. Even if a caller wrongly
  // offers it, the scheduled-scan mission may attempt the check
  // with ordinary controls but must never spend the code.
  const pending = [{ id: "c1", senderDomain: "upwork.com", code: "246810" }];
  let fills = 0;
  const result = await runMission({
    browser,
    task: {
      kind: "discover", target_url: "https://upwork.com/check", goal: "Find new listings",
      drafted_payload: {}, log: [], scheduled_scan: true,
    },
    decider: new SimulatedDecider(new LLMClient(cfg)),
    hasEmailCode: true,
    fillEmailCodeValue: async () => { fills += 1; pending.pop(); },
  });
  assert.equal(result.status, "needs_human");
  assert.equal(fills, 0);
  assert.ok(acts.length > 0, "scan attempts the check with ordinary controls");
  assert.ok(acts.every((a: any) => a.action !== "type"), "no code typed during a scan");
  assert.equal(pending.length, 1); // still waiting for the user's own mission
});

test("unknown-digit and malformed mail drop silently: count only, nothing delivered", async () => {
  const db = new MemoryEmailAddressDb();
  await allocateHyggeAddress(db, "owner-1", { nextDigits: rngDigits("4839201847") });
  let delivered = 0;
  const deps = { db, deliver: async () => { delivered += 1; } };
  const unknown = await processInboundEmail({ to: "0000000001@usehygge.cc", raw: VERIFICATION_RAW }, deps);
  assert.equal(unknown.disposition, "dropped_unknown");
  const malformed = await processInboundEmail({ to: "sam@usehygge.cc", raw: VERIFICATION_RAW }, deps);
  assert.equal(malformed.disposition, "dropped_malformed");
  assert.equal(delivered, 0);
  // Counts are the only trace — the counter store holds no content.
  assert.equal(db.count("dropped_unknown"), 1);
  assert.equal(db.count("dropped_malformed"), 1);
  assert.equal(JSON.stringify([...db.counts.keys()]).includes("731904"), false);
  assert.equal(JSON.stringify([...db.counts.keys()]).includes("rover"), false);
});

test("suggested site passwords meet the strength policy and vary", () => {
  const a = generateSitePassword();
  const b = generateSitePassword();
  assert.equal(isStrongSitePassword(a), true);
  assert.equal(a.length, 20);
  assert.notEqual(a, b);
  assert.equal(isStrongSitePassword("short"), false);
});

test("receive-only inbox: the only mail-send path is magic-link auth mail", () => {
  // Brief 04's own-address inbox stays receive-only. The single later
  // exception (user decision 2026-11-01): auth.ts sends magic sign-in
  // links through the send_email binding, pinned to one sender. This
  // test keeps that exception from growing into general sending.
  const srcDir = new URL("../src/", import.meta.url).pathname;
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes("email.ts"));
  const codeOnly = (file: string) => readFileSync(srcDir + file, "utf8")
    .split("\n").filter((line) => !/^\s*(\/\/|\*)/.test(line)).join("\n");
  const sendShaped = [
    /send_email/i, /SendEmail/, /\bsmtp\b/i, /nodemailer/i, /sendMail\s*\(/,
    /api\.sendgrid|mailgun|postmark|resend\.com|ses\..*SendEmail/i,
    /env\.EMAIL/,
  ];
  const alwaysBanned = [/message\.forward\s*\(/, /message\.reply\s*\(/, /setReject\s*\(/];
  for (const file of files) {
    const text = codeOnly(file);
    for (const pattern of alwaysBanned) {
      assert.equal(pattern.test(text), false, `${file} matches banned pattern ${pattern}`);
    }
    if (file === "auth.ts" || file === "env.ts") continue; // the one send path + its binding type
    for (const pattern of sendShaped) {
      assert.equal(pattern.test(text), false, `${file} matches send pattern ${pattern}`);
    }
  }
  // auth.ts may send only as the pinned login sender.
  assert.match(codeOnly("auth.ts"), /login@usehygge\.app/);
  for (const cfg of ["wrangler.staging.jsonc", "wrangler.production.jsonc"]) {
    const text = readFileSync(new URL(`../${cfg}`, import.meta.url), "utf8");
    assert.match(text, /"send_email": \[\s*\{\s*"name": "EMAIL",\s*"allowed_sender_addresses": \["login@usehygge\.app"\]\s*\}\s*\]/, cfg);
    assert.equal(/\bsmtp\b/i.test(text), false, cfg);
  }
  // The Email Worker entry exists and is inbound-shaped.
  const index = readFileSync(srcDir + "index.ts", "utf8");
  assert.match(index, /email:\s*handleEmailMessage/);
});

// ---- triage: owner mail, site highlights, owner commands -----------------

test("triage: owner mail counts only with an aligned pass from a verified address", async () => {
  const ownerRaw = (auth: boolean, from = "Sam Example <sam@gmail.com>") => [
    `From: ${from}`,
    ...(auth ? ["Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com"] : []),
    "To: 4839201847@usehygge.cc",
    "Subject: Please look on Rover",
    "Content-Type: text/plain",
    "",
    "Scan Rover for new jobs when you can.",
  ].join("\r\n");
  const run = async (raw: string) => {
    const db = new MemoryEmailAddressDb();
    await allocateHyggeAddress(db, "owner-1", { nextDigits: rngDigits("4839201847") });
    const deliveries: InboundEmailDelivery[] = [];
    await processInboundEmail({ to: "4839201847@usehygge.cc", raw }, {
      db,
      verifiedEmailsFor: async (userId) => (userId === "owner-1" ? ["sam@gmail.com"] : []),
      deliver: async (_u, d) => { deliveries.push(d); },
    });
    return deliveries[0];
  };
  const mine = await run(ownerRaw(true));
  assert.equal(mine.triage?.ownerVerified, true);
  assert.equal(mine.triage?.senderEmail, "sam@gmail.com");
  // Same address, no aligned authentication: never the owner.
  assert.equal((await run(ownerRaw(false))).triage?.ownerVerified, false);
  // Authenticated, but a different person.
  assert.equal((await run(ownerRaw(true, "Other <other@gmail.com>"))).triage?.ownerVerified, false);
  assert.equal(senderEmailOf("Sam Example <SAM@Gmail.com>"), "sam@gmail.com");
});

test("triage: site-mail highlights are plain, deterministic mentions", () => {
  const kinds = (raw: string) => extractEmailHighlights(parseMimeMessage(raw)).map((h) => h.kind);
  const mail = (subject: string, body: string) => [
    "From: Rover <no-reply@rover.com>", "To: 4839201847@usehygge.cc",
    `Subject: ${subject}`, "Content-Type: text/plain", "", body,
  ].join("\r\n");
  assert.ok(kinds(mail("New message from Alex", "Alex sent you a message about Saturday. Reply: https://www.rover.com/inbox")).includes("client_message"));
  assert.ok(kinds(mail("3 new jobs near you", "New dog walking jobs were just posted: https://www.rover.com/jobs")).includes("job_alert"));
  assert.ok(kinds(mail("Booking confirmed", "Your booking for Saturday is confirmed.")).includes("booking"));
  assert.ok(kinds(mail("Payment sent", "You received a payment for last weekend.")).includes("payment"));
  assert.deepEqual(kinds(mail("Our November newsletter", "Season's greetings from the team.")), []);
});

test("triage: owner commands parse strictly, forwarded mail never does", () => {
  const sites = [{ siteID: "rover", name: "Rover", domain: "rover.com" }];
  assert.deepEqual(parseOwnerEmailCommand({ subject: "", text: "Scan Rover for new jobs" }, sites), { type: "scan", siteID: "rover" });
  assert.deepEqual(parseOwnerEmailCommand({ subject: "Rover", text: "please re-add Rover" }, sites), { type: "readd", siteID: "rover" });
  assert.deepEqual(parseOwnerEmailCommand({ subject: "", text: "add pawshake.com" }, sites), { type: "add", domain: "pawshake.com" });
  assert.deepEqual(parseOwnerEmailCommand({ subject: "pause", text: "" }, sites), { type: "pause" });
  assert.equal(parseOwnerEmailCommand({ subject: "", text: "don't scan Rover" }, sites), null);
  assert.equal(parseOwnerEmailCommand({ subject: "", text: "Thanks, great week so far!" }, sites), null);
  assert.equal(parseOwnerEmailCommand({ subject: "Fwd: scan Rover", text: "Scan Rover for new jobs" }, sites), null);
});
