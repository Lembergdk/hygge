import type { EmailSql } from "./email-owner-addresses.ts";

export function readEmailHistory(sql: EmailSql, encodedCursor: string | null) {
  let cursor: { at: string; id: string } | null = null;
  if (encodedCursor !== null) {
    if (encodedCursor.length > 4096) throw new Error("Invalid history cursor.");
    try {
      cursor = JSON.parse(atob(encodedCursor));
      if (!cursor || typeof cursor.at !== "string" || cursor.at.length > 80 || typeof cursor.id !== "string" || cursor.id.length > 128) throw new Error();
    } catch { throw new Error("Invalid history cursor."); }
  }
  const rows = [...sql.exec(`SELECT *, EXISTS(SELECT 1 FROM email_originals o WHERE o.message_id=email_summaries.id) AS has_original
    FROM email_summaries ${cursor ? "WHERE created_at < ? OR (created_at = ? AND id < ?)" : ""}
    ORDER BY created_at DESC, id DESC LIMIT 101`, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []))];
  const page = rows.slice(0, 100), last = page[page.length - 1];
  return { page, nextCursor: rows.length > 100 && last ? btoa(JSON.stringify({ at: last.created_at, id: last.id })) : null };
}
