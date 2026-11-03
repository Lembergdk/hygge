import { test } from "node:test";
import assert from "node:assert/strict";
import { handleProfilePhoto, MAX_PROFILE_PHOTO_BYTES, profilePhotoAllowedForTask,
  profilePhotoTargetAllowed, type ProfilePhoto, type ProfilePhotoStore } from "../src/profile-photo.ts";
import { runMission, LLMDecider } from "../src/agent.ts";

// Minimal framed JPEG payload for transport/validation tests (not a UI image).
const jpeg = Uint8Array.from([255,216, 255,192,0,11,8,0,1,0,1,1,1,17,0, 255,218,0,8,1,1,0,0,63,0,0, 255,217]);
class MemoryPhotos implements ProfilePhotoStore {
  value: ProfilePhoto | null = null;
  read() { return this.value; }
  write(photo: ProfilePhoto) { this.value = structuredClone(photo); }
  remove() { this.value = null; }
}
function request(method = "GET", body?: Uint8Array, headers: Record<string, string> = {}) {
  return new Request("https://hygge.test/profile/photo", { method,
    headers: { "content-type": "image/jpeg", ...headers }, body });
}

test("photo survives a new reader, stays account-scoped, and can be replaced/deleted", async () => {
  const alice = new MemoryPhotos(), bob = new MemoryPhotos();
  assert.equal((await handleProfilePhoto(request(), alice)).status, 404);
  const put = await handleProfilePhoto(request("PUT", jpeg), alice);
  assert.equal(put.status, 200);
  const { version } = await put.json();
  const anotherDevice = await handleProfilePhoto(request(), alice);
  assert.equal(anotherDevice.headers.get("etag"), `"${version}"`);
  assert.equal(anotherDevice.headers.get("content-type"), "image/jpeg");
  assert.equal(anotherDevice.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await anotherDevice.arrayBuffer()), jpeg);
  assert.equal((await handleProfilePhoto(request(), bob)).status, 404);
  const changed = jpeg.slice(); changed[changed.length - 3] = 1;
  assert.equal((await handleProfilePhoto(request("PUT", changed), alice)).status, 200);
  assert.notEqual(alice.value?.version, version);
  assert.equal((await handleProfilePhoto(request("DELETE"), alice)).status, 204);
  assert.equal((await handleProfilePhoto(request(), alice)).status, 404);
});

test("legacy migration only fills an empty account; normal replacement remains possible", async () => {
  const store = new MemoryPhotos();
  assert.equal((await handleProfilePhoto(request("PUT", jpeg, { "if-none-match": "*" }), store)).status, 200);
  const before = structuredClone(store.value);
  const changed = jpeg.slice(); changed[changed.length - 3] = 1;
  assert.equal((await handleProfilePhoto(request("PUT", changed, { "if-none-match": "*" }), store)).status, 412);
  assert.deepEqual(store.value, before);
});

test("invalid type, corrupt framing, excessive dimensions and streamed oversize do not replace a photo", async () => {
  const store = new MemoryPhotos();
  await handleProfilePhoto(request("PUT", jpeg), store);
  const before = structuredClone(store.value);
  assert.equal((await handleProfilePhoto(request("PUT", jpeg, { "content-type": "image/svg+xml" }), store)).status, 415);
  assert.equal((await handleProfilePhoto(request("PUT", new TextEncoder().encode("not an image")), store)).status, 400);
  const wide = jpeg.slice(); wide[9] = 127;
  assert.equal((await handleProfilePhoto(request("PUT", wide), store)).status, 400);
  assert.equal((await handleProfilePhoto(request("PUT", new Uint8Array(MAX_PROFILE_PHOTO_BYTES + 1)), store)).status, 413);
  assert.equal((await handleProfilePhoto(request("POST", jpeg), store)).status, 405);
  assert.deepEqual(store.value, before);
});

test("migration rechecks after an interleaved upload", async () => {
  const store = new MemoryPhotos();
  let finish!: () => void;
  const stream = new ReadableStream({ start(controller) { finish = () => { controller.enqueue(jpeg); controller.close(); }; } });
  const pending = handleProfilePhoto(new Request("https://hygge.test/profile/photo", {
    method: "PUT", headers: { "content-type": "image/jpeg", "if-none-match": "*" }, body: stream, duplex: "half",
  } as RequestInit), store);
  await handleProfilePhoto(request("PUT", jpeg), store);
  finish();
  assert.equal((await pending).status, 412);
});

const approved = { kind: "buildProfile", status: "approved", target_url: "https://work.test", goal: "Update my profile", drafted_payload: {} };
const snap = (url = "https://work.test/profile", title = "Edit profile") => ({
  sessionID: "one", currentURLString: url, title, elements: [{ label: "Profile photo", kind: "type", inputType: "file" }],
});
const browser = (url?: string, title?: string) => ({ mode: "test", createSession: async () => snap(url, title), snapshot: async () => snap(url, title) });
function uploaderDecider(valueRef = "profile.photo", action = "upload") {
  let n = 0;
  return { decide: async () => ++n === 1
    ? { action, target: "Profile photo", valueRef } : { action: "done" } };
}

test("approved profile mission can attach the server asset without bytes in its trace", async () => {
  let calls = 0;
  const result = await runMission({ browser: browser(), task: approved, hasProfilePhoto: true,
    uploadProfilePhoto: async (target: string, session: string) => { assert.equal(target, "Profile photo"); assert.equal(session, "one"); calls++; },
    decider: uploaderDecider() });
  assert.equal(calls, 1);
  assert.equal(result.trace[0].succeeded, true);
  assert.equal(result.trace[0].action, "type"); // older iOS clients can decode it
  assert.ok(!JSON.stringify(result).includes(Buffer.from(jpeg).toString("base64")));
});

test("unapproved, discovery, scheduled, wrong-site and literal uploads are refused", async () => {
  for (const options of [
    { task: { ...approved, status: "awaiting_approval" } },
    { task: { ...approved, kind: "discover" } },
    { task: { ...approved, scheduled_scan: true } },
    { browser: browser("https://other.test") },
    { decider: uploaderDecider("https://other.test/photo.jpg") },
    { decider: uploaderDecider("profile.photo", "type") },
  ]) {
    let calls = 0;
    const result = await runMission({ browser: browser(), task: approved, hasProfilePhoto: true,
      decider: uploaderDecider(), uploadProfilePhoto: async () => { calls++; }, ...options });
    assert.equal(calls, 0);
    assert.equal(result.trace[0].succeeded, false);
  }
  assert.equal(profilePhotoAllowedForTask({ ...approved, kind: "signup" }), true);
  assert.equal(profilePhotoTargetAllowed("http://work.test", "https://work.test"), false);
  assert.equal(profilePhotoTargetAllowed("https://work.test.evil.test", "https://work.test"), false);
  assert.equal(profilePhotoTargetAllowed("https://www.work.test", "https://work.test"), true);
});

test("identity checks still stop photo attachment", async () => {
  let calls = 0;
  const result = await runMission({ browser: browser(undefined, "Verify your identity"), task: approved,
    hasProfilePhoto: true, decider: uploaderDecider(), uploadProfilePhoto: async () => { calls++; } });
  assert.equal(result.status, "needs_human");
  assert.equal(calls, 0);
});

test("model receives only photo availability and observed file labels", async () => {
  let prompt = "";
  const client = { cfg: { modelFast: "fast", modelStrong: "strong" }, complete: async (input: any) => {
    prompt = input.user; return '{"action":"done"}';
  } };
  const decider = new LLMDecider(client as any);
  await decider.decide({ hasProfilePhoto: true, snapshot: snap(), history: [], tierContext: {},
    photoBytes: "private-image-bytes", photoURL: "private-url" });
  assert.equal(JSON.parse(prompt).hasProfilePhoto, true);
  assert.deepEqual(JSON.parse(prompt).page.fileInputs, [{ label: "Profile photo", kind: "type", inputType: "file" }]);
  assert.ok(!prompt.includes("private-image-bytes"));
  assert.ok(!prompt.includes("private-url"));
});
