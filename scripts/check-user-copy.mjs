// Release copy audit: fail if developer/system vocabulary appears in
// user-facing Swift string literals outside #if DEBUG regions, or in
// backend help messages (the user-facing text the server writes into
// chat). Run: node scripts/check-user-copy.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BANNED = [/agent service/i, /simulated/i, /\bmission(s)?\b/i, /payload/i,
  /browser worker/i, /\bserver\b/i, /vault credential/i, /run-live/i, /node server/i];

function walk(dir, ext) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, ext) : path.endsWith(ext) ? [path] : [];
  });
}

let failures = 0;
for (const file of walk(new URL("../App", import.meta.url).pathname, ".swift")) {
  const lines = readFileSync(file, "utf8").split("\n");
  let inDebug = 0;
  lines.forEach((line, i) => {
    if (/^\s*#if DEBUG/.test(line)) inDebug++;
    if (/^\s*#endif/.test(line)) inDebug = Math.max(0, inDebug - 1);
    if (inDebug > 0) return;
    if (line.includes("replacingOccurrences")) return; // match-inputs in the humanizer, never displayed
    const strings = line.match(/"[^"]*"/g) ?? [];
    for (const literal of strings) {
      for (const pattern of BANNED) {
        if (pattern.test(literal)) {
          console.log(`${file}:${i + 1} banned release copy ${pattern}: ${literal}`);
          failures++;
        }
      }
    }
  });
}

// Backend help messages: every user-facing help the server writes goes
// through the help() constructor (task-help.ts), so the message argument
// of each help( call is the user-facing text. Scan only those literals —
// log strings, error codes and identifiers elsewhere in the backend
// legitimately use the same words, so a whole-file scan would drown in
// false positives. Model-composed text (decision.reason, the chat
// composer, onboarding replies) cannot be checked statically and is out
// of scope here; the literal fallbacks around it are checked.
// Deliberately NOT banned: session, check, verify — legitimate verbs and
// nouns in help copy ("Check your saved login", "open a new session",
// "verify your sign-in"). Bracketed codes ([WORKSPACE_ACTION_UNCERTAIN])
// are the precise leak: no legitimate help ever contains one.
const BACKEND_BANNED = [/agent service/i, /simulated/i, /\bmission(s)?\b/i, /payload/i,
  /browser worker/i, /\bserver\b/i, /vault credential/i, /run-live/i, /node server/i,
  /\bworkspace\b/i, /\beffect\b/i, /\bturn\b/i, /\[[A-Z][A-Z_]{3,}\]/];

function backendHelpLiterals(file) {
  const src = readFileSync(file, "utf8");
  const segments = []; // {text, line}: literal text inside a help( call
  let i = 0, line = 1, mode = "code", helpParen = 0;
  let segStart = 0, segLine = 1, stringStartLine = 1;
  const frames = []; // {type:'template'} | {type:'interp', braces:number}
  const isWord = (c) => /[A-Za-z0-9_$]/.test(c ?? "");
  const emit = (text, startLine) => { if (helpParen > 0 && text.length) segments.push({ text, line: startLine }); };
  while (i < src.length) {
    const c = src[i], n = src[i + 1] ?? "";
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "lineComment"; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "blockComment"; i += 2; continue; }
      if (c === "'") { mode = "single"; stringStartLine = line; segStart = i + 1; i++; continue; }
      if (c === '"') { mode = "double"; stringStartLine = line; segStart = i + 1; i++; continue; }
      if (c === "`") { mode = "template"; frames.push({ type: "template" }); segStart = i + 1; segLine = line; i++; continue; }
      if (c === "h" && src.startsWith("help", i) && !isWord(src[i - 1]) && src[i - 1] !== ".") {
        let j = i + 4;
        while (src[j] === " " || src[j] === "\t") j++;
        if (src[j] === "(") { helpParen = helpParen === 0 ? 1 : helpParen + 1; i = j + 1; continue; }
      }
      if (c === "(" && helpParen > 0) helpParen++;
      if (c === ")" && helpParen > 0) { helpParen--; i++; continue; }
      if (c === "{" && frames.length && frames[frames.length - 1].type === "interp") frames[frames.length - 1].braces++;
      if (c === "}") {
        if (frames.length && frames[frames.length - 1].type === "interp") {
          const f = frames[frames.length - 1];
          if (f.braces > 0) { f.braces--; i++; continue; }
          frames.pop(); mode = "template"; segStart = i + 1; segLine = line; i++; continue;
        }
      }
      if (c === "\n") line++;
      i++; continue;
    }
    if (mode === "lineComment") { if (c === "\n") { mode = "code"; line++; } i++; continue; }
    if (mode === "blockComment") {
      if (c === "*" && n === "/") { mode = "code"; i += 2; continue; }
      if (c === "\n") line++;
      i++; continue;
    }
    if (mode === "single" || mode === "double") {
      const q = mode === "single" ? "'" : '"';
      if (c === "\\") { i += 2; continue; }
      if (c === q) { emit(src.slice(segStart, i), stringStartLine); mode = "code"; i++; continue; }
      if (c === "\n") { mode = "code"; line++; i++; continue; }
      i++; continue;
    }
    if (mode === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { emit(src.slice(segStart, i), segLine); frames.pop(); mode = "code"; i++; continue; }
      if (c === "$" && n === "{") {
        emit(src.slice(segStart, i), segLine);
        frames.push({ type: "interp", braces: 0 }); mode = "code"; i += 2; continue;
      }
      if (c === "\n") line++;
      i++; continue;
    }
  }
  return segments;
}

for (const file of walk(new URL("../backend/cloudflare/src", import.meta.url).pathname, ".ts")) {
  for (const { text, line: n } of backendHelpLiterals(file)) {
    for (const pattern of BACKEND_BANNED) {
      if (pattern.test(text)) {
        console.log(`${file}:${n} banned backend help copy ${pattern}: ${JSON.stringify(text.slice(0, 120))}`);
        failures++;
      }
    }
  }
}
if (failures) { console.error(`FAIL: ${failures} banned copy hit(s)`); process.exit(1); }
console.log("PASS: no banned developer vocabulary in release UI strings");
