// Release copy audit: fail if developer/system vocabulary appears in
// user-facing Swift string literals outside #if DEBUG regions.
// Run: node scripts/check-user-copy.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BANNED = [/agent service/i, /simulated/i, /\bmission(s)?\b/i, /payload/i,
  /browser worker/i, /\bserver\b/i, /vault credential/i, /run-live/i, /node server/i];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".swift") ? [path] : [];
  });
}

let failures = 0;
for (const file of walk(new URL("../App", import.meta.url).pathname)) {
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
if (failures) { console.error(`FAIL: ${failures} banned copy hit(s)`); process.exit(1); }
console.log("PASS: no banned developer vocabulary in release UI strings");
