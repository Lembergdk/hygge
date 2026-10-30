// Server-side credential vault.
//
// Security model (v1):
// - Secrets are encrypted at rest with AES-256-GCM, a random 96-bit nonce per
//   credential, and the domain+username bound as additional authenticated data.
// - The master key comes from HYGGE_VAULT_KEY (64 hex chars). In production
//   that key must live in a KMS/HSM or secret manager, never in the repo or DB.
// - Secrets are decrypted ONLY inside `use()`, called by the browser worker to
//   fill a login form. No API returns a secret; list/get expose metadata only.
// - Still TODO for production: per-user keys, key rotation, audit log of every
//   `use()`, hardware-backed KMS, and user authn/z on every endpoint.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class Vault {
  constructor(file, masterKeyHex) {
    if (!masterKeyHex || !/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
      throw new Error("HYGGE_VAULT_KEY must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32");
    }
    this.key = Buffer.from(masterKeyHex, "hex");
    this.file = file;
    this.records = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.records, null, 2), { mode: 0o600 });
  }

  add({ domain, username, secret }) {
    if (!domain || !username || !secret) throw new Error("domain, username, secret required");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${domain}\n${username}`));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const record = {
      id: randomUUID(), domain, username,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    this.save();
    return Vault.metadata(record);
  }

  static metadata(r) {
    return { id: r.id, domain: r.domain, username: r.username, createdAt: r.createdAt };
  }

  list() { return this.records.map(Vault.metadata); }

  get(id) {
    const r = this.records.find((x) => x.id === id);
    return r ? Vault.metadata(r) : null;
  }

  findByDomain(domain) {
    const r = this.records.find((x) => x.domain === domain);
    return r ? Vault.metadata(r) : null;
  }

  remove(id) {
    const before = this.records.length;
    this.records = this.records.filter((x) => x.id !== id);
    if (this.records.length !== before) this.save();
    return this.records.length !== before;
  }

  // The ONLY way a secret leaves the vault: decrypted in memory, handed to fn
  // (the browser worker's form-fill), never returned to callers or logged.
  async use(id, fn) {
    const r = this.records.find((x) => x.id === id);
    if (!r) throw new Error("unknown credential");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(r.iv, "base64"));
    decipher.setAAD(Buffer.from(`${r.domain}\n${r.username}`));
    decipher.setAuthTag(Buffer.from(r.tag, "base64"));
    const secret = Buffer.concat([
      decipher.update(Buffer.from(r.ciphertext, "base64")), decipher.final(),
    ]).toString("utf8");
    return fn({ username: r.username, secret });
  }
}
