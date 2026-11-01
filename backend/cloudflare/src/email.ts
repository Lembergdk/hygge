/// @usehygge.cc email identity (Brief 04) — RECEIVE ONLY.
///
/// Hard rule for this whole module: Hygge never sends mail from a
/// @usehygge.cc address. No SMTP, no send API, no reply/forward
/// binding, no bounce. The one outbound HTTP call permitted here is
/// a GET on a verification link that arrived IN received mail
/// (acting on received mail, not sending mail).
///
/// Address format (decided): 10 random digits, unique, never
/// derived from the user's name/email/any identifier. 10^10 space:
/// at 100k users a fresh draw collides with probability ~1e-5, and
/// the unique D1 constraint + regenerate-and-retry below absorbs
/// that. The digits -> userId mapping is server-side only (D1,
/// `hygge_email_addresses`); this module logs nothing but daily
/// counts (no addresses, senders, subjects, bodies, or codes).
///
/// Codes are secrets-in-transit: the parsed delivery carries a code
/// only into the owning user's Durable Object, which seals it with
/// the user's DEK, expires it quickly, and deletes it on first
/// consumption. Summaries/results from this module never contain a
/// code or a token-bearing link.
import type { Env } from "./env.ts";
import { json, sandboxFor } from "./env.ts";

export const EMAIL_DOMAIN = "usehygge.cc";
export const ADDRESS_DIGITS = 10;
export const MAX_ALLOCATION_ATTEMPTS = 8;
export const CODE_TTL_MS = 30 * 60 * 1000; // emailed codes die after 30 minutes
export const MAX_RAW_EMAIL_BYTES = 512 * 1024;

export type EmailKind = "verification" | "security_code" | "other";
export type RoutingCountKind =
  | "received" | "dropped_unknown" | "dropped_malformed"
  | "verification" | "security_code" | "other"
  | "link_follow_ok" | "link_follow_failed" | "delivery_failed";

// ---- address format ----------------------------------------------------

export function emailDomain(env?: Pick<Env, "HYGGE_EMAIL_DOMAIN">): string {
  return (env?.HYGGE_EMAIL_DOMAIN || EMAIL_DOMAIN).trim().toLowerCase();
}

export function formatHyggeAddress(digits: string, domain = EMAIL_DOMAIN): string {
  return `${digits}@${domain}`;
}

export function isValidDigits(digits: string): boolean {
  return new RegExp(`^\\d{${ADDRESS_DIGITS}}$`).test(digits);
}

/// Recipient -> digits, or null when the address is not a Hygge
/// numeric address on this domain. Accepts bare and angle forms.
export function parseRecipientDigits(to: string, domain = EMAIL_DOMAIN): string | null {
  const angle = String(to ?? "").match(/<([^<>]+)>/);
  const addr = (angle ? angle[1] : String(to ?? "")).trim().toLowerCase();
  const suffix = `@${domain.toLowerCase()}`;
  if (!addr.endsWith(suffix)) return null;
  const digits = addr.slice(0, -suffix.length);
  return isValidDigits(digits) ? digits : null;
}

/// Random digits only — rejection sampling, no modulo bias, no input
/// from any user field (allocation independence starts here).
export function generateHyggeDigits(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let out = "";
  while (out.length < ADDRESS_DIGITS) {
    for (const b of randomBytes(ADDRESS_DIGITS)) {
      if (b < 250 && out.length < ADDRESS_DIGITS) out += String(b % 10);
    }
  }
  return out;
}

// ---- allocation (D1 in production, in-memory in tests) -----------------

export interface EmailAddressRow {
  digits: string;
  userId: string;
  createdAt: string;
}

export interface EmailAddressDb {
  findByDigits(digits: string): Promise<EmailAddressRow | null>;
  findByUser(userId: string): Promise<EmailAddressRow | null>;
  /// Returns false on a uniqueness conflict (digits or user taken).
  tryInsert(row: EmailAddressRow): Promise<boolean>;
  recordRoutingCount(day: string, kind: RoutingCountKind): Promise<void>;
}

export function d1EmailAddressDb(db: D1Database): EmailAddressDb {
  type Row = Record<string, unknown>;
  const toRow = (r: Row): EmailAddressRow => ({
    digits: String(r.digits), userId: String(r.user_id), createdAt: String(r.created_at),
  });
  const one = async (sql: string, bind: string) =>
    (await db.prepare(sql).bind(bind).first()) as Row | null;
  return {
    async findByDigits(digits) {
      const r = await one("SELECT digits, user_id, created_at FROM hygge_email_addresses WHERE digits = ?1", digits);
      return r ? toRow(r) : null;
    },
    async findByUser(userId) {
      const r = await one("SELECT digits, user_id, created_at FROM hygge_email_addresses WHERE user_id = ?1", userId);
      return r ? toRow(r) : null;
    },
    async tryInsert(row) {
      try {
        await db.prepare("INSERT INTO hygge_email_addresses (digits, user_id, created_at) VALUES (?1, ?2, ?3)")
          .bind(row.digits, row.userId, row.createdAt).run();
        return true;
      } catch {
        return false; // unique constraint: digits or user already allocated
      }
    },
    async recordRoutingCount(day, kind) {
      await db.prepare(
        "INSERT INTO email_routing_counts (day, kind, count) VALUES (?1, ?2, 1) ON CONFLICT(day, kind) DO UPDATE SET count = count + 1",
      ).bind(day, kind).run().catch(() => {}); // counts must never break delivery
    },
  };
}

export class MemoryEmailAddressDb implements EmailAddressDb {
  byDigits = new Map<string, EmailAddressRow>();
  counts = new Map<string, number>();
  async findByDigits(digits: string) { return this.byDigits.get(digits) ?? null; }
  async findByUser(userId: string) {
    for (const row of this.byDigits.values()) if (row.userId === userId) return row;
    return null;
  }
  async tryInsert(row: EmailAddressRow) {
    if (this.byDigits.has(row.digits)) return false;
    if (await this.findByUser(row.userId)) return false;
    this.byDigits.set(row.digits, row);
    return true;
  }
  async recordRoutingCount(day: string, kind: RoutingCountKind) {
    const key = `${day}:${kind}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  count(kind: RoutingCountKind): number {
    let n = 0;
    for (const [k, v] of this.counts) if (k.endsWith(`:${kind}`)) n += v;
    return n;
  }
}

/// Allocate (or return the existing) Hygge address for a user.
/// Idempotent per user; regenerates on a digits collision. Takes no
/// name/email/profile input by design — output depends only on the
/// random source and which digits are already taken.
export async function allocateHyggeAddress(
  db: EmailAddressDb,
  userId: string,
  opts: { nextDigits?: () => string; now?: Date; maxAttempts?: number } = {},
): Promise<EmailAddressRow> {
  if (!userId) throw new Error("userId required");
  const existing = await db.findByUser(userId);
  if (existing) return existing;
  const nextDigits = opts.nextDigits ?? (() => generateHyggeDigits());
  const createdAt = (opts.now ?? new Date()).toISOString();
  const attempts = opts.maxAttempts ?? MAX_ALLOCATION_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    const digits = nextDigits();
    if (!isValidDigits(digits)) continue;
    if (await db.tryInsert({ digits, userId, createdAt })) return { digits, userId, createdAt };
    // Insert can also lose a same-user race; that is still success.
    const raced = await db.findByUser(userId);
    if (raced) return raced;
  }
  throw new Error("could not allocate a Hygge email address");
}

/// The only address read the API offers: the caller's own. There is
/// no lookup-by-digits endpoint for clients, so another user's
/// mapping is never retrievable.
export async function addressForUser(
  db: EmailAddressDb, userId: string, domain = EMAIL_DOMAIN,
): Promise<{ address: string; digits: string; createdAt: string } | null> {
  const row = await db.findByUser(userId);
  return row ? { address: formatHyggeAddress(row.digits, domain), digits: row.digits, createdAt: row.createdAt } : null;
}

// ---- suggested site passwords (own-email path) -------------------------
// Site passwords only — never the Hygge-account password (no such
// generated form exists). Generation happens on-device in the app
// (HyggeCore mirrors this policy) so the plaintext exists only at
// the moment of entry and then goes straight to the vault; this
// server copy exists for policy parity and tests. Generated values
// are never logged here. No endpoint returns one.

export const SITE_PASSWORD_LENGTH = 20;
const PW_LOWER = "abcdefghjkmnpqrstuvwxyz";
const PW_UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const PW_DIGITS = "23456789";
const PW_SYMBOLS = "!@#$%^&*-_=+";

export function generateSitePassword(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const pools = [PW_LOWER, PW_UPPER, PW_DIGITS, PW_SYMBOLS];
  const all = pools.join("");
  const pick = (pool: string) => {
    for (;;) {
      const b = randomBytes(1)[0];
      const limit = 256 - (256 % pool.length);
      if (b < limit) return pool[b % pool.length];
    }
  };
  const chars = pools.map(pick);
  while (chars.length < SITE_PASSWORD_LENGTH) chars.push(pick(all));
  // Fisher-Yates with the same random source.
  for (let i = chars.length - 1; i > 0; i--) {
    let j = 0;
    for (;;) {
      const b = randomBytes(1)[0];
      const limit = 256 - (256 % (i + 1));
      if (b < limit) { j = b % (i + 1); break; }
    }
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function isStrongSitePassword(value: string): boolean {
  return value.length >= SITE_PASSWORD_LENGTH
    && /[a-z]/.test(value) && /[A-Z]/.test(value)
    && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
}

// ---- parsing received mail ----------------------------------------------

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  size: number; // approximate decoded size; the body itself is dropped
}

export interface ParsedEmail {
  from: string;
  to: string;
  subject: string;
  date: string | null;
  text: string;
  links: string[];
  attachments: AttachmentMeta[];
  /// True only when Authentication-Results show an aligned
  /// DKIM/SPF/DMARC pass for the From domain. Sender-attributed
  /// actions (sealing a code, following a verification link,
  /// completing a signup) require it — Hygge addresses are handed
  /// to sites at signup, so forged mail to them is realistic.
  senderAuthenticated: boolean;
}

function domainsAlign(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/\.+$/, "");
  const y = b.toLowerCase().replace(/\.+$/, "");
  return Boolean(x && y) && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

/// Aligned-pass check over an Authentication-Results value:
/// DKIM pass with an aligned signing domain, DMARC pass with an
/// aligned header.from, or SPF pass with an aligned mailfrom.
/// Missing or unaligned results fail closed.
export function senderPassesAuthentication(authResults: string, senderDomain: string): boolean {
  if (!senderDomain) return false;
  for (const segment of String(authResults ?? "").split(";")) {
    const s = segment.toLowerCase();
    const signing = segment.match(/header\.d=([a-z0-9.-]+)/i)?.[1] ?? "";
    const headerFrom = segment.match(/header\.from=(?:[^@\s;]*@)?([a-z0-9.-]+)/i)?.[1] ?? "";
    const mailFrom = segment.match(/(?:^|[\s;.])mailfrom=(?:[^@\s;]*@)?([a-z0-9.-]+)/i)?.[1] ?? "";
    if (/\bdkim=pass\b/.test(s) && domainsAlign(signing, senderDomain)) return true;
    if (/\bdmarc=pass\b/.test(s) && domainsAlign(headerFrom, senderDomain)) return true;
    if (/\bspf=pass\b/.test(s) && domainsAlign(mailFrom, senderDomain)) return true;
  }
  return false;
}

function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _cs, enc, body) => {
    try {
      if (String(enc).toLowerCase() === "b") return new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
      const bytes: number[] = [];
      const q = String(body).replaceAll("_", " ");
      for (let i = 0; i < q.length; i++) {
        if (q[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
          bytes.push(parseInt(q.slice(i + 1, i + 3), 16)); i += 2;
        } else bytes.push(q.charCodeAt(i));
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    } catch { return body; }
  });
}

function decodeQuotedPrintable(body: string): string {
  const cleaned = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16)); i += 2;
    } else bytes.push(cleaned.charCodeAt(i) & 0xff);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBody(body: string, encoding: string): string {
  const enc = encoding.trim().toLowerCase();
  try {
    if (enc === "base64") return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
    if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  } catch { /* fall through with the raw text */ }
  return body;
}

function approxDecodedSize(body: string, encoding: string): number {
  const compact = body.replace(/\s/g, "");
  if (encoding.trim().toLowerCase() === "base64") return Math.floor((compact.length * 3) / 4);
  return new TextEncoder().encode(body).length;
}

function splitHeaders(raw: string): { headers: Map<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const sep = normalized.indexOf("\n\n");
  const head = sep >= 0 ? normalized.slice(0, sep) : normalized;
  const body = sep >= 0 ? normalized.slice(sep + 2) : "";
  const headers = new Map<string, string>();
  let current = "";
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  return { headers, body };
}


export function extractLinks(text: string): string[] {
  const found = String(text ?? "").match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  const cleaned = found.map((u) => u.replace(/[.,;:!?]+$/, ""));
  return [...new Set(cleaned)];
}

function htmlToText(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<(br|\/p|\/div|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ");
}

interface MimePart { headers: Map<string, string>; body: string }

function mimeParts(headers: Map<string, string>, body: string): MimePart[] {
  const type = headers.get("content-type") ?? "text/plain";
  const boundary = type.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!/^multipart\//i.test(type) || !boundary) return [{ headers, body }];
  const parts: MimePart[] = [];
  for (const chunk of body.split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\r?\n/, "").replace(/\r?\n--\s*$/, "");
    if (!trimmed.trim() || trimmed.trim() === "--") continue;
    const { headers: ph, body: pb } = splitHeaders(trimmed.replace(/\n--$/, ""));
    parts.push(...mimeParts(ph, pb));
  }
  return parts.length ? parts : [{ headers, body }];
}

/// Minimal MIME parse for received mail. Attachment bodies are
/// dropped — only filename/type/size survive. Full bodies are not
/// retained beyond the extracted text needed downstream.
export function parseMimeMessage(rawInput: string): ParsedEmail {
  const raw = String(rawInput ?? "").slice(0, MAX_RAW_EMAIL_BYTES);
  const { headers, body } = splitHeaders(raw);
  let text = "";
  const attachments: AttachmentMeta[] = [];
  for (const part of mimeParts(headers, body)) {
    const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
    const disposition = (part.headers.get("content-disposition") ?? "").toLowerCase();
    const encoding = part.headers.get("content-transfer-encoding") ?? "7bit";
    const isAttachment = disposition.includes("attachment") && !type.startsWith("text/");
    if (isAttachment || (!type.startsWith("text/") && !type.startsWith("multipart/"))) {
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1]
        ?? type.match(/name="?([^";]+)"?/i)?.[1] ?? "attachment";
      attachments.push({
        filename: decodeEncodedWords(filename).slice(0, 120),
        contentType: type.split(";")[0].trim() || "application/octet-stream",
        size: approxDecodedSize(part.body, encoding),
      });
      continue; // body deliberately discarded
    }
    const decoded = decodeBody(part.body, encoding);
    text += (type.startsWith("text/html") ? htmlToText(decoded) : decoded) + "\n";
  }
  text = text.trim().slice(0, 20_000);
  const dateRaw = headers.get("date") ?? null;
  const parsedDate = dateRaw ? Date.parse(dateRaw) : NaN;
  const from = decodeEncodedWords(headers.get("from") ?? "").slice(0, 320);
  return {
    from,
    senderAuthenticated: senderPassesAuthentication(
      headers.get("authentication-results") ?? "", senderDomainOf(from)),
    to: decodeEncodedWords(headers.get("to") ?? "").slice(0, 320),
    subject: decodeEncodedWords(headers.get("subject") ?? "").slice(0, 500),
    date: Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString(),
    text,
    links: extractLinks(text),
    attachments,
  };
}

export function senderDomainOf(from: string): string {
  const angle = String(from ?? "").match(/<([^<>]+)>/);
  const addr = (angle ? angle[1] : String(from ?? "")).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1).replace(/[>\s]+$/, "") : "";
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// ---- classification, codes, verification links ---------------------------

const CODE_NEAR = /\b(?:code|passcode|pin|otp|verification|security|confirm)\b([^0-9]{0,24})(\d[\d -]{2,}\d)/i;
const CODE_STANDALONE = /\b(\d{4,8})\b/g;

/// Extract a 4-8 digit emailed code. Keyword-adjacent codes win;
/// hyphens/spaces inside grouped codes are removed. Returns digits
/// only, or null. Callers must treat the result as a secret.
export function extractEmailCode(...texts: string[]): string | null {
  const joined = texts.filter(Boolean).join("\n");
  const near = joined.match(CODE_NEAR);
  if (near) {
    const digits = near[2].replace(/[\s-]/g, "");
    // A year trailing a loose mention ("codes ... from 2026") is not
    // a code; "code is 2026" / "code: 2026" still counts.
    const yearMention = /^(19|20)\d{2}$/.test(digits) && !/(:|\bis\b|-)/.test(near[1]);
    if (!yearMention && /^\d{4,8}$/.test(digits)) return digits;
  }
  // Reverse order: "123456 is your code" puts digits before keyword.
  const before = joined.match(/(\d[\d -]{2,}\d)[^0-9]{0,30}(?:is your|as your|your)?\s*(?:code|passcode|pin|otp)/i);
  if (before) {
    const digits = before[1].replace(/[\s-]/g, "");
    if (/^\d{4,8}$/.test(digits)) return digits;
  }
  for (const m of joined.matchAll(CODE_STANDALONE)) {
    if (/^(19|20)\d{6}$/.test(m[1])) continue; // date-shaped run
    if (/^(19|20)\d{2}$/.test(m[1])) continue; // bare year, e.g. in a footer
    return m[1];
  }
  return null;
}

export function classifyEmail(input: { subject: string; text: string; links: string[] }): EmailKind {
  const hay = `${input.subject}\n${input.text}`.toLowerCase();
  const hasCode = extractEmailCode(input.subject, input.text) !== null;
  const hasVerifyLink = pickVerificationLink(input.links) !== null;
  if (/verif|confirm your|activate your|complete your (sign|registration)|welcome to|confirm.*email|email.*confirm/.test(hay)
      && (hasCode || hasVerifyLink)) return "verification";
  if (hasCode && /code|passcode|\botp\b|two[- ]factor|\b2fa\b|security|sign[- ]in|login/.test(hay)) return "security_code";
  if (hasVerifyLink) return "verification";
  if (hasCode) return "security_code";
  return "other";
}

export function pickVerificationLink(links: string[]): string | null {
  const scored = links.map((link) => {
    const l = link.toLowerCase();
    let score = 0;
    if (/verif|confirm|activate|validate/.test(l)) score += 3;
    if (/token=|code=|signup|sign-up|register|welcome/.test(l)) score += 1;
    if (/unsubscribe|privacy|terms|support|help/.test(l)) score -= 3;
    return { link, score };
  }).sort((a, b) => b.score - a.score);
  return scored.length && scored[0].score > 0 ? scored[0].link : null;
}

/// Only https links to public hostnames may be followed. Blocks
/// embedded credentials, localhost, and IP literals (SSRF basics).
export function isSafeVerificationLink(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
    return host.includes(".");
  } catch { return false; }
}

// ---- summaries (never carry codes or token links) ------------------------

export interface EmailSummary {
  sender: string;
  senderDomain: string;
  subject: string;
  date: string | null;
  kind: EmailKind;
  summary: string;
  actionableItems: string[];
  attachments: AttachmentMeta[];
}

/// Redact any code-shaped run and every link (replaced by its host)
/// so a filed summary can never leak a secret or a live token.
export function redactForSummary(text: string, code?: string | null): string {
  let out = String(text ?? "");
  if (code) out = out.replaceAll(code, "[code]");
  out = out.replace(/https?:\/\/[^\s<>"')\]]+/gi, (u) => `[link to ${hostOf(u) || "a site"}]`);
  out = out.replace(/\b\d{4,8}\b/g, "[code]");
  return out.replace(/\s+/g, " ").trim();
}

export function summarizeEmail(parsed: ParsedEmail, kind: EmailKind, code?: string | null): EmailSummary {
  const senderDomain = senderDomainOf(parsed.from);
  const safeSubject = redactForSummary(parsed.subject, code).slice(0, 200);
  const firstLines = redactForSummary(parsed.text, code).slice(0, 400);
  const actionableItems: string[] = [];
  if (kind === "verification") actionableItems.push("Email verification for a signup");
  if (kind === "security_code") actionableItems.push("Sign-in code received");
  for (const host of [...new Set(parsed.links.map(hostOf).filter(Boolean))].slice(0, 3)) {
    actionableItems.push(`Link to ${host}`);
  }
  if (parsed.attachments.length) actionableItems.push(`${parsed.attachments.length} attachment(s) noted (not kept)`);
  return {
    sender: redactForSummary(parsed.from, code).slice(0, 200),
    senderDomain,
    subject: safeSubject,
    date: parsed.date,
    kind,
    summary: firstLines,
    actionableItems,
    attachments: parsed.attachments,
  };
}

// ---- delivery to the owning user's sandbox ------------------------------

export interface VerificationLinkOutcome {
  followed: boolean;
  ok: boolean;
  status: number | null;
  host: string; // host only — the full token link is never stored
}

/// Payload sent ONLY into the owning user's Durable Object. `code`
/// is the one secret field: the DO seals it on receipt and it is
/// excluded from every summary/result this module returns outward.
export interface InboundEmailDelivery {
  kind: EmailKind;
  receivedAt: string;
  summary: EmailSummary;
  code: string | null;
  verification: VerificationLinkOutcome | null;
}

export interface InboundResult {
  disposition: "delivered" | "dropped_unknown" | "dropped_malformed" | "delivery_failed";
  kind: EmailKind | null;
  verification: VerificationLinkOutcome | null;
}

export interface InboundDeps {
  db: EmailAddressDb;
  domain?: string;
  deliver: (userId: string, delivery: InboundEmailDelivery) => Promise<void>;
  followLink?: (url: string) => Promise<{ ok: boolean; status: number | null }>;
  now?: () => Date;
}

async function defaultFollowLink(url: string): Promise<{ ok: boolean; status: number | null }> {
  try {
    const res = await fetch(url, {
      method: "GET", redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Hygge email verification (receive-only)" },
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

/// The inbound pipeline: recipient digits -> user, parse, classify,
/// (verification: follow the link), deliver into that user's DO.
/// Unknown digits drop silently — a daily count is the only trace,
/// no content retained and no bounce that could leak addressing.
export async function processInboundEmail(
  input: { to: string; from?: string; raw?: string; parsed?: ParsedEmail },
  deps: InboundDeps,
): Promise<InboundResult> {
  const now = deps.now ? deps.now() : new Date();
  const day = now.toISOString().slice(0, 10);
  const count = (kind: RoutingCountKind) => deps.db.recordRoutingCount(day, kind).catch(() => {});
  await count("received");
  const domain = (deps.domain ?? EMAIL_DOMAIN).toLowerCase();
  const parsed = input.parsed ?? parseMimeMessage(input.raw ?? "");
  const digits = parseRecipientDigits(input.to || parsed.to, domain);
  if (!digits) {
    await count("dropped_malformed");
    return { disposition: "dropped_malformed", kind: null, verification: null };
  }
  const owner = await deps.db.findByDigits(digits);
  if (!owner) {
    await count("dropped_unknown");
    return { disposition: "dropped_unknown", kind: null, verification: null };
  }
  if (!parsed.from && input.from) parsed.from = input.from;
  // Fail closed on sender attribution: without an aligned
  // authentication pass, mail is only ever filed. No code is
  // extracted for sealing, no verification link is followed, and
  // no signup can be completed by it.
  const classified = classifyEmail(parsed);
  const kind: EmailKind = parsed.senderAuthenticated ? classified : "other";
  const code = kind === "other" ? null : extractEmailCode(parsed.subject, parsed.text);
  let verification: VerificationLinkOutcome | null = null;
  if (kind === "verification") {
    const link = pickVerificationLink(parsed.links);
    if (link && isSafeVerificationLink(link)) {
      const followed = await (deps.followLink ?? defaultFollowLink)(link);
      verification = { followed: true, ok: followed.ok, status: followed.status, host: hostOf(link) };
      await count(followed.ok ? "link_follow_ok" : "link_follow_failed");
    } else if (link) {
      verification = { followed: false, ok: false, status: null, host: hostOf(link) };
    }
  }
  const delivery: InboundEmailDelivery = {
    kind,
    receivedAt: now.toISOString(),
    summary: summarizeEmail(parsed, kind, code),
    code,
    verification,
  };
  await count(kind);
  try {
    await deps.deliver(owner.userId, delivery);
  } catch {
    await count("delivery_failed");
    return { disposition: "delivery_failed", kind, verification };
  }
  // The outward result deliberately omits the code and the summary.
  return { disposition: "delivered", kind, verification };
}

// ---- pending signup / waiting-task attachment (pure) ---------------------

type TaskLike = Record<string, any>;

function taskDomain(task: TaskLike): string {
  try { return new URL(String(task.target_url ?? "")).hostname.replace(/^www\./, ""); }
  catch { return String(task.target_url ?? ""); }
}

function sameSite(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/// Attach a delivery to the matching pending task. Pure so the
/// end-to-end "verification mail completes a pending signup" path
/// is unit-testable. Never writes the code into the task — codes
/// live only in the sealed pending-code store until consumed.
export function attachEmailToTask(task: TaskLike, delivery: InboundEmailDelivery): TaskLike | null {
  const domain = taskDomain(task);
  const hosts = [delivery.summary.senderDomain, delivery.verification?.host ?? ""];
  if (!hosts.some((h) => sameSite(h, domain))) return null;
  const pending = ["awaiting_approval", "needsHuman", "approved"].includes(String(task.status));
  if (!pending) return null;
  const next: TaskLike = { ...task, log: [...(task.log ?? [])] };
  if (delivery.kind === "verification") {
    next.email_verification = {
      host: delivery.verification?.host ?? delivery.summary.senderDomain,
      linkFollowed: Boolean(delivery.verification?.followed),
      linkOk: Boolean(delivery.verification?.ok),
      hasCode: Boolean(delivery.code),
      at: delivery.receivedAt,
    };
    next.log.push(delivery.verification?.ok
      ? "Email verification finished from your Hygge inbox — no need to open your email."
      : "A verification email arrived in your Hygge inbox and is attached to this signup.");
    const awaiting = next.awaiting_email_verification === true || next.email_choice === "hygge";
    if (awaiting && delivery.verification?.ok && task.kind === "signup") {
      next.status = "succeeded";
      next.awaiting_email_verification = false;
      next.log.push("Signup confirmed by email. This step is complete.");
    }
    return next;
  }
  if (delivery.kind === "security_code") {
    next.email_code_available = true;
    next.log.push("A sign-in code arrived in your Hygge inbox. It will be used on the next run and then deleted.");
    return next;
  }
  return null; // other mail is filed to the journal, not pinned to a task
}

export function attachEmailToTasks(tasks: TaskLike[], delivery: InboundEmailDelivery): TaskLike[] {
  return tasks.map((t) => attachEmailToTask(t, delivery) ?? t);
}

// ---- pending codes: consume-then-delete selection (pure) ----------------

export interface PendingCodeRecord {
  id: string;
  senderDomain: string;
  receivedAt: string; // ISO
}

/// Choose the freshest unexpired code for a site. The caller
/// deletes that row as part of consuming it — a code is never
/// usable twice and never survives CODE_TTL_MS.
export function takeFreshCode<T extends PendingCodeRecord>(
  records: T[], siteDomain: string, nowMs = Date.now(),
): T | null {
  const fresh = records
    .filter((r) => sameSite(r.senderDomain, siteDomain)
      && nowMs - Date.parse(r.receivedAt) <= CODE_TTL_MS
      && Date.parse(r.receivedAt) <= nowMs + 60_000)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return fresh[0] ?? null;
}

// ---- Email Worker + address HTTP handlers --------------------------------

interface ForwardableEmailLike {
  from: string;
  to: string;
  raw: ReadableStream;
  headers: Headers;
}

async function readRaw(message: ForwardableEmailLike): Promise<string> {
  const reader = message.raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total <= MAX_RAW_EMAIL_BYTES) chunks.push(value);
    }
  }
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(joined);
}

/// Cloudflare Email Workers entry point (catch-all route target).
/// Receive-only: this handler has no forward/reply/send call and
/// sets no rejection — unknown mail simply ends here, counted only.
export async function handleEmailMessage(message: ForwardableEmailLike, env: Env): Promise<void> {
  const raw = await readRaw(message).catch(() => "");
  const parsed = parseMimeMessage(raw);
  // Cloudflare may surface authentication results on the message
  // headers even when they are not in the raw stream.
  const headerAuth = message.headers?.get?.("authentication-results") ?? "";
  if (headerAuth) {
    parsed.senderAuthenticated = parsed.senderAuthenticated
      || senderPassesAuthentication(headerAuth, senderDomainOf(message.from || parsed.from));
  }
  await processInboundEmail(
    { to: message.to, from: message.from, parsed },
    {
      db: d1EmailAddressDb(env.DB),
      domain: emailDomain(env),
      deliver: async (userId, delivery) => {
        const stub = sandboxFor(env, userId);
        const res = await stub.fetch(new Request("https://user-sandbox/email/inbound", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hygge-user-id": userId,
            "x-hygge-email-delivery": "1",
          },
          body: JSON.stringify(delivery),
        }));
        if (!res.ok) throw new Error(`inbound delivery failed: ${res.status}`);
      },
    },
  );
}

/// GET/POST /email/address for the authenticated user. GET returns
/// the caller's own address or null; POST allocates on first use
/// (the moment they choose a Hygge address). No digits parameter
/// exists anywhere, so no other user's mapping can be read.
export async function handleEmailAddressRequest(
  request: Request, env: Env, userId: string, db: EmailAddressDb = d1EmailAddressDb(env.DB),
): Promise<Response> {
  const domain = emailDomain(env);
  if (request.method === "GET") {
    const mine = await addressForUser(db, userId, domain);
    return json({ hyggeEmail: mine });
  }
  if (request.method === "POST") {
    const row = await allocateHyggeAddress(db, userId);
    return json({
      hyggeEmail: { address: formatHyggeAddress(row.digits, domain), digits: row.digits, createdAt: row.createdAt },
    }, 201);
  }
  return json({ error: "method not allowed" }, 405);
}
