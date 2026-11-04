import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteWorkspace } from "./helpers/workspace-sqlite.mts";
import { readEmailHistory } from "../src/email-history.ts";
test("history pages tied timestamps without repeating or losing mail", () => {
  const f = sqliteWorkspace();
  try {
    f.sqlite.exec('CREATE TABLE email_summaries(id TEXT PRIMARY KEY, created_at TEXT); CREATE TABLE email_originals(message_id TEXT, ciphertext TEXT)');
    for (let i=0;i<205;i++) f.storage.sql.exec('INSERT INTO email_summaries VALUES (?, ?)', String(i).padStart(3,'0'), '2026-11-04 12:00:00');
    f.storage.sql.exec('INSERT INTO email_originals VALUES (?, ?)', '204', 'sealed-secret');
    const first = readEmailHistory(f.storage.sql, null);
    const second = readEmailHistory(f.storage.sql, first.nextCursor);
    const third = readEmailHistory(f.storage.sql, second.nextCursor);
    assert.equal(first.page.length,100); assert.equal(second.page.length,100); assert.equal(third.page.length,5);
    assert.equal(new Set([...first.page,...second.page,...third.page].map(r=>r.id)).size,205);
    assert.equal(third.nextCursor,null);
    assert.equal(first.page[0].has_original,1);
    assert.equal(first.page[0].ciphertext,undefined);
    for (const cursor of ['bad',btoa('{}'),btoa('{"at":42,"id":"x"}')]) assert.throws(()=>readEmailHistory(f.storage.sql,cursor));
  } finally { f.sqlite.close(); }
});
