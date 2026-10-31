/// Vault: per-user AES-256-GCM credential encryption (WebCrypto).
/// Each user gets a random DEK, wrapped by the environment master
/// key (AES-KW) and stored in D1 `user_keys`. Site passwords are
/// encrypted with the user's DEK and stored in their Durable
/// Object. Plaintext exists only transiently in Worker memory to
/// type into a login form — never in prompts, logs, or Responses.

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export async function masterKey(env: { HYGGE_MASTER_KEY?: string }): Promise<CryptoKey> {
  if (!env.HYGGE_MASTER_KEY) throw new Error("HYGGE_MASTER_KEY not configured");
  return crypto.subtle.importKey("raw", unb64(env.HYGGE_MASTER_KEY), "AES-KW", false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

export async function generateDEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function wrapDEK(dek: CryptoKey, master: CryptoKey): Promise<string> {
  return b64(await crypto.subtle.wrapKey("raw", dek, master, "AES-KW"));
}

export async function unwrapDEK(wrapped: string, master: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    unb64(wrapped),
    master,
    "AES-KW",
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export interface VaultBlob {
  iv: string;
  ciphertext: string;
}

/// Seal a secret. The domain+username are bound as additional
/// authenticated data, so a ciphertext cannot be replayed against
/// a different site or account.
export async function seal(dek: CryptoKey, plaintext: string, aad: string): Promise<VaultBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    dek,
    new TextEncoder().encode(plaintext),
  );
  return { iv: b64(iv), ciphertext: b64(ct) };
}

export async function open(dek: CryptoKey, blob: VaultBlob, aad: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(blob.iv), additionalData: new TextEncoder().encode(aad) },
    dek,
    unb64(blob.ciphertext),
  );
  return new TextDecoder().decode(pt);
}
