import { scrypt, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// OWASP scrypt profile: 32 MiB, r=8, p=3. Native Workers crypto avoids
// a JS hashing dependency. Fixed version/parameters prevent attacker-chosen cost.
const prefix = "scrypt-v1$32768$8$3$";
const dummySalt = Buffer.alloc(16, 0);
const dummyHash = Buffer.alloc(32, 0);

export function isValidPassword(value: string): boolean {
  const length = [...value].length;
  return length >= 15 && length <= 128;
}

function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  const key = await derive(password, salt);
  return `${prefix}${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const match = /^scrypt-v1\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded ?? "");
  const actual = await derive(password, match ? Buffer.from(match[1], "hex") : dummySalt);
  const same = timingSafeEqual(actual, match ? Buffer.from(match[2], "hex") : dummyHash);
  return !!match && same;
}
