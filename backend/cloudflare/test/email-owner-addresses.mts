import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteWorkspace } from "./helpers/workspace-sqlite.mts";
import { EmailOwnerAddresses, normalizeOwnEmail } from "../src/email-owner-addresses.ts";

function fixture() { const f = sqliteWorkspace(); const addresses = new EmailOwnerAddresses(f.storage.sql); addresses.ensure(); return { ...f, addresses }; }
test("personal addresses require exact authenticated, unexpired challenge mail", async () => {
  const f = fixture();
  try {
    const added = await f.addresses.add(" Me@Example.com ");
    assert.equal(added.address, "me@example.com");
    assert.equal(added.verified, false);
    assert.ok(added.verificationSubject);
    assert.equal(await f.addresses.verify("me@example.com", false, added.verificationSubject!), false);
    assert.equal(await f.addresses.verify("someone@example.com", true, added.verificationSubject!), false);
    assert.equal(await f.addresses.verify("me@example.com", true, "Fwd: " + added.verificationSubject!), false);
    assert.equal(await f.addresses.verify("me@example.com", true, added.verificationSubject!), true);
    assert.equal(f.addresses.list()[0].verified, true);
    assert.equal(await f.addresses.verify("me@example.com", true, added.verificationSubject!), false);
    assert.equal(f.sqlite.prepare("SELECT challenge_hash FROM email_owner_addresses").get()!.challenge_hash, null);
  } finally { f.sqlite.close(); }
});
test("expired/replaced challenges fail and address books are isolated", async () => {
  const a = fixture(), b = fixture();
  try {
    const first = await a.addresses.add("me@example.com", new Date("2026-01-01"));
    assert.equal(await a.addresses.verify(first.address, true, first.verificationSubject!, new Date("2026-01-03")), false);
    const replacement = await a.addresses.add(first.address);
    assert.equal(await a.addresses.verify(first.address, true, first.verificationSubject!), false);
    assert.equal(await b.addresses.verify(first.address, true, replacement.verificationSubject!), false);
    assert.equal(await a.addresses.verify(first.address, true, replacement.verificationSubject!), true);
    a.addresses.remove(first.address);
    assert.deepEqual(a.addresses.list(), []);
  } finally { a.sqlite.close(); b.sqlite.close(); }
});
test("invalid personal addresses cannot inject headers", async () => {
  const f = fixture();
  try {
    for (const address of ["bad", "a@example.com\r\nBcc: victim@example.com", "User <me@example.com>", "a@b", "a@b..com"]) {
      assert.equal(normalizeOwnEmail(address), null);
      await assert.rejects(f.addresses.add(address));
    }
  } finally { f.sqlite.close(); }
});
