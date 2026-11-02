// Brief 03: trusted sessions, checkpoint handoff, credential hygiene.
// A scripted fake browser drives the real mission loop (runMission)
// with the simulated decider, so these assert behavior, not mocks of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LLMClient } from "../src/llm.ts";
import { makeDecider, runMission } from "../src/agent.ts";
import { generateDEK } from "../src/vault.ts";
import {
  sealSessionState,
  openSessionState,
  detectCheckpoint,
  probeAuthenticated,
  nextTrustSupport,
  isRememberMeLabel,
  type SessionState,
} from "../src/session-profile.ts";

const decider = makeDecider(new LLMClient({ baseUrl: "https://example.invalid", modelFast: "fast", modelStrong: "strong" }));

const el = (label: string) => ({ label, kind: /field/i.test(label) ? "type" as const : "click" as const });
const snapOf = (id: string, labels: string[], title = "Site", url = "https://rover.com/") => ({
  sessionID: id, currentURLString: url, title, elements: labels.map(el), humanControlled: false, screenshotBase64: null,
});

class FakeBrowser {
  mode = "fake";
  createdWithRestore: unknown = undefined;
  createCalls = 0;
  closed: string[] = [];
  typedTargets: string[] = [];
  clickedTargets: string[] = [];
  labels: string[];
  initial: string[];
  transitions: Record<string, string[]>;
  constructor(initial: string[], transitions: Record<string, string[]> = {}) {
    this.initial = initial;
    this.transitions = transitions;
    this.labels = initial;
  }
  async createSession(_url: string, restore?: SessionState | null) {
    this.createCalls += 1;
    this.createdWithRestore = restore ?? null;
    // A restore the site honours lands signed-in; an expired one shows login.
    this.labels = (restore as any)?.__labels ?? this.initial;
    return snapOf("s1", this.labels);
  }
  async snapshot(id: string) { return id === "s1" || id === "kept" ? snapOf(id, this.labels) : null; }
  async act(id: string, a: { action: string; target?: string; value?: string }) {
    if (a.action === "type" && a.target) this.typedTargets.push(a.target);
    if (a.action === "click" && a.target) {
      this.clickedTargets.push(a.target);
      const next = Object.entries(this.transitions).find(([k]) => a.target!.toLowerCase().includes(k))?.[1];
      if (next) this.labels = next;
    }
    return snapOf(id, this.labels);
  }
  async extract() { return ["Weekend dog sitting listing"]; }
  async exportState(): Promise<SessionState> {
    return { cookies: [{ name: "sess", value: "token-123" }], localStorage: {}, origin: "https://rover.com", savedAt: "2026-10-31T00:00:00Z" };
  }
  async closeSession(id: string) { this.closed.push(id); return true; }
}

const TASK = { kind: "discover", target_url: "https://rover.com", goal: "find listings", drafted_payload: { searchTerms: "dogs" } };
const LOGIN_FLOW = {
  "log in / sign in": ["Email or username field", "Password field", "Remember me", "Log in button"],
  "log in button": ["Search field", "Search button"],
};

test("sealed session state round-trips and never contains the cookie in plaintext", async () => {
  const dek = await generateDEK();
  const state: SessionState = { cookies: [{ name: "sess", value: "token-123" }], localStorage: { a: "b" }, origin: "https://rover.com", savedAt: "x" };
  const blob = await sealSessionState(dek, "rover.com", state);
  assert.ok(!JSON.stringify(blob).includes("token-123"));
  assert.deepEqual(await openSessionState(dek, "rover.com", blob), state);
  await assert.rejects(openSessionState(dek, "other.com", blob)); // AAD binds to the domain
});

test("checkpoint detection: CAPTCHA/2FA/ID pause, ordinary pages do not", () => {
  assert.ok(detectCheckpoint(snapOf("s", ["I'm not a robot", "reCAPTCHA"])));
  assert.ok(detectCheckpoint(snapOf("s", ["Enter the verification code we sent"])));
  assert.ok(detectCheckpoint(snapOf("s", ["Verify your identity with a photo ID"])));
  assert.equal(detectCheckpoint(snapOf("s", ["Search field", "First listing"])), null);
  assert.equal(detectCheckpoint(snapOf("s", ["Verify your email to continue"])), null);
  // Marketing copy about vetted workers is not a checkpoint (this
  // fired on Rover's homepage and stalled live probes):
  assert.equal(detectCheckpoint(snapOf("s", ["Background Check", "All sitters pass a background check", "Sign Up"])), null);
  // But a background check demanded of the visitor still pauses:
  assert.ok(detectCheckpoint(snapOf("s", ["Complete your background check"])));
  assert.ok(detectCheckpoint(snapOf("s", ["Background check required"])));
});

test("probe: password field means the trusted sign-in expired", () => {
  assert.equal(probeAuthenticated(snapOf("s", ["Password field", "Log in button"])), "unauthenticated");
  assert.equal(probeAuthenticated(snapOf("s", ["My account", "Log out"])), "authenticated");
  assert.equal(probeAuthenticated(snapOf("s", ["Search field"])), "unknown");
});

test("trust flag learns from outcomes, never assumes", () => {
  assert.equal(nextTrustSupport("unknown", "probePassed"), "supported");
  assert.equal(nextTrustSupport("unknown", "loginSavedState"), "unknown");
  assert.equal(nextTrustSupport("unknown", "loginSavedNothing"), "unsupported");
  assert.equal(nextTrustSupport("supported", "probeFailed"), "supported");
  assert.ok(isRememberMeLabel("Trust this device"));
  assert.ok(!isRememberMeLabel("Search field"));
});

test("trusted session reuse: second mission skips login entirely", async () => {
  const browser = new FakeBrowser(["Search field", "Search button"], LOGIN_FLOW);
  let fills = 0;
  const restore = { cookies: [{ name: "sess", value: "t" }], localStorage: {}, origin: "https://rover.com", savedAt: "x",
                    __labels: ["Search field", "Search button", "My account"] } as unknown as SessionState;
  const result = await runMission({
    browser, task: TASK, hints: [], decider, hasCredential: true,
    fillCredentialValue: async () => { fills += 1; }, restoreState: restore,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.sessionProbe, "authenticated");
  assert.equal(fills, 0); // vault never touched: login skipped
});

test("expired trusted session: probe fails, vault re-login runs (profile refresh is the caller's export step)", async () => {
  const browser = new FakeBrowser(["Log in / Sign in"], LOGIN_FLOW);
  let fills = 0;
  const restore = { cookies: [{ name: "sess", value: "old" }], localStorage: {}, origin: "https://rover.com", savedAt: "x",
                    __labels: ["Email or username field", "Password field", "Remember me", "Log in button"] } as unknown as SessionState;
  const result = await runMission({
    browser, task: TASK, hints: [], decider, hasCredential: true,
    fillCredentialValue: async (_r: string, target: string, sid: string) => { fills += 1; await browser.act(sid, { action: "type", target }); },
    restoreState: restore,
  });
  assert.equal(result.sessionProbe, "unauthenticated");
  assert.ok(fills >= 2); // username + secret typed from the vault
  assert.equal(result.status, "succeeded");
  assert.ok(browser.clickedTargets.some((t) => isRememberMeLabel(t)), "remember-me ticked before submit");
  const fresh = await browser.exportState();
  assert.ok(fresh.cookies.length > 0); // caller seals+saves this as the refreshed profile
});

test("2FA checkpoint: mission pauses as needs_human and the agent never acts on the checkpoint page", async () => {
  const browser = new FakeBrowser(["Enter the verification code we sent to your phone", "Code field", "Verify button"]);
  let fills = 0;
  const result = await runMission({
    browser, task: TASK, hints: [], decider, hasCredential: true,
    fillCredentialValue: async () => { fills += 1; },
  });
  assert.equal(result.status, "needs_human");
  assert.ok(result.checkpoint);
  assert.equal(fills, 0);
  assert.deepEqual(browser.clickedTargets, []);
  assert.deepEqual(browser.typedTargets, []);
  assert.deepEqual(browser.closed, []); // runMission never closes; caller keeps needs_human sessions open
});

test("resume after human check reuses the kept session without asking for the password", async () => {
  const browser = new FakeBrowser(["Search field", "Search button"]);
  let fills = 0;
  const result = await runMission({
    browser, task: TASK, hints: [], decider, hasCredential: true,
    fillCredentialValue: async () => { fills += 1; }, existingSessionID: "kept",
  });
  assert.equal(browser.createCalls, 0); // same session, not a fresh browser
  assert.equal(result.resumedSession, true);
  assert.equal(result.status, "succeeded");
  assert.equal(fills, 0);
});

test("dead kept session falls back to a fresh session (then vault/profile)", async () => {
  const browser = new FakeBrowser(["Search field", "Search button"]);
  const result = await runMission({
    browser, task: TASK, hints: [], decider, hasCredential: false,
    fillCredentialValue: async () => {}, existingSessionID: "gone",
  });
  assert.equal(browser.createCalls, 1);
  assert.equal(result.resumedSession, false);
  assert.equal(result.status, "succeeded");
});

test("combined: skill-loaded mission hitting a CAPTCHA pauses as needs_human with zero actions and no skill draft", async () => {
  // Integration guard (Brief 02 + Brief 03): an active shared skill
  // must never weaken the pre-decider checkpoint guard.
  const browser = new FakeBrowser(["I'm not a robot", "reCAPTCHA", "Continue button"]);
  let fills = 0;
  const skill: any = {
    id: "skill-test-1", site: "rover.com", outcome: "apply", version: 2,
    body: { summary: "advisory", steps: [], pitfalls: [], notes: [] },
    confidence: 0.8, sourceRunCount: 3, status: "active",
  };
  const result: any = await runMission({
    browser, task: TASK, hints: [], decider, hasCredential: true, skill,
    fillCredentialValue: async () => { fills += 1; },
  });
  assert.equal(result.status, "needs_human");
  assert.equal(result.skillCoverage, "active");
  assert.equal(fills, 0);
  assert.deepEqual(browser.clickedTargets, []);
  assert.deepEqual(browser.typedTargets, []);
  assert.equal(result.skillDraft ?? null, null);
});
