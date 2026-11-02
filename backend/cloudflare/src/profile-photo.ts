// Private account asset, deliberately separate from profile JSON imports and
// shared skills. Fits in one per-user SQLite row; no public bucket or URL.
export const MAX_PROFILE_PHOTO_BYTES = 512 * 1024;
export interface ProfilePhoto { base64: string; version: string }
export interface ProfilePhotoStore {
  read(): ProfilePhoto | null;
  write(photo: ProfilePhoto): void;
  remove(): void;
}

export function photoBytes(photo: ProfilePhoto): Uint8Array {
  return Uint8Array.from(atob(photo.base64), (c) => c.charCodeAt(0));
}

function encoded(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

// Validate JPEG framing and dimensions before accepting a bounded thumbnail.
// The native picker decodes/re-encodes the image, removing original metadata.
export function isProfileJPEG(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 ||
      bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return false;
  let at = 2;
  let dimensions = false;
  while (at + 3 < bytes.length) {
    if (bytes[at++] !== 255) return false;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 218) return dimensions; // start of compressed scan
    const length = (bytes[at] << 8) | bytes[at + 1];
    if (length < 2 || at + length > bytes.length) return false;
    if ([192, 193, 194].includes(marker)) {
      if (length < 8) return false;
      const height = (bytes[at + 3] << 8) | bytes[at + 4];
      const width = (bytes[at + 5] << 8) | bytes[at + 6];
      if (width < 1 || height < 1 || width > 1024 || height > 1024) return false;
      dimensions = true;
    }
    at += length;
  }
  return false;
}

const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
function reply(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...headers, "content-type": "application/json" } });
}

// Caller is the authenticated user's Durable Object, never a client-selected ID.
export async function handleProfilePhoto(request: Request, store: ProfilePhotoStore): Promise<Response> {
  if (request.method === "GET") {
    const photo = store.read();
    return photo ? new Response(photoBytes(photo).slice().buffer, {
      headers: { ...headers, "content-type": "image/jpeg", etag: `"${photo.version}"` },
    }) : reply(404, { error: "no profile photo" });
  }
  if (request.method === "DELETE") {
    store.remove();
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "PUT") return reply(405, { error: "method not allowed" });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/jpeg") {
    return reply(415, { error: "profile photo must be JPEG" });
  }
  if (Number(request.headers.get("content-length")) > MAX_PROFILE_PHOTO_BYTES) {
    return reply(413, { error: "profile photo too large" });
  }
  const reader = request.body?.getReader();
  if (!reader) return reply(400, { error: "photo required" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_PROFILE_PHOTO_BYTES) {
      await reader.cancel();
      return reply(413, { error: "profile photo too large" });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (!isProfileJPEG(bytes)) return reply(400, { error: "invalid profile photo" });
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const version = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  // Check after all awaits: a legacy phone must not overwrite another device's
  // already-uploaded photo during one-time migration.
  if (request.headers.get("if-none-match") === "*" && store.read()) return reply(412, { error: "photo already exists" });
  store.write({ base64: encoded(bytes), version });
  return reply(200, { version });
}

export function profilePhotoAllowedForTask(task: any): boolean {
  return task?.status === "approved" && task?.scheduled_scan !== true && task?.drafted_payload?.setupMode !== "connect" &&
    ["signup", "buildProfile"].includes(task?.kind);
}

export function profilePhotoTargetAllowed(currentURL: string, targetURL: string): boolean {
  try {
    const current = new URL(currentURL), target = new URL(targetURL);
    return current.protocol === "https:" && target.protocol === "https:" &&
      current.hostname.replace(/^www\./, "") === target.hostname.replace(/^www\./, "");
  } catch { return false; }
}
