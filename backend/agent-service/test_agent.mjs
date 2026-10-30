// Mission-loop checks (offline): the agent must navigate from observations,
// not a script. Includes a page-variant test no canned step list could pass.
import { SimulatedDecider, runMission, distillHints } from "./agent.mjs";
import { SimulatedBrowser } from "./browser.mjs";

const assert = (c, m) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); };
const noFill = async () => { throw new Error("no credential in this test"); };

// 1) Discover mission on the simulated page: explores, extracts, done.
{
  const browser = new SimulatedBrowser();
  const task = { kind: "discover", target_url: "https://pets.example", goal: "Find pet-sitting gigs",
                 drafted_payload: { searchTerms: "dog sitting" } };
  const r = await runMission({ browser, task, decider: new SimulatedDecider(),
                               hasCredential: false, fillCredentialValue: noFill });
  assert(r.status === "succeeded", `discover mission should succeed, got ${r.status}`);
  assert(r.extractedItems.length > 0, "should extract listings");
  assert(r.trace.at(-1).action === "done", "agent should decide it is done");
  const hints = distillHints({ domain: "pets.example", trace: r.trace, extractedItems: r.extractedItems });
  assert(hints.length > 0, "successful run should distil memory hints");
}

// 2) Page VARIANT with no search UI at all: a scripted flow (type-in-search,
// click-search-button) would fail; an observing agent just extracts.
{
  const fakeBrowser = {
    mode: "fake",
    async createSession(url) { return { sessionID: "s1", currentURLString: url }; },
    async snapshot() {
      return { sessionID: "s1", currentURLString: "https://boards.example", title: "Board",
               elements: [{ label: "Listing: Cat sitting Sat", kind: "click" },
                          { label: "Listing: Dog walking weekdays", kind: "click" }],
               humanControlled: false };
    },
    async act() { return this.snapshot(); },
    async extract() { return ["Cat sitting Sat — $30", "Dog walking weekdays — $20/walk"]; },
    async closeSession() { return true; },
  };
  const task = { kind: "discover", target_url: "https://boards.example",
                 goal: "Find pet gigs", drafted_payload: { searchTerms: "pets" } };
  const r = await runMission({ browser: fakeBrowser, task, decider: new SimulatedDecider(),
                               hasCredential: false, fillCredentialValue: noFill });
  assert(r.status === "succeeded", "agent should adapt to a page with no search UI");
  assert(!r.trace.some((t) => !t.succeeded && /search/i.test(t.target)),
    "agent must not fail trying to use a search field that does not exist");
}

// 3) A decider that tries to type a literal password is refused by the worker.
{
  const browser = new SimulatedBrowser();
  let calls = 0;
  const badDecider = { simulated: true, async decide() {
    calls++;
    if (calls === 1) return { action: "type", target: "Password field", value: "hunter2", tier: null };
    return { action: "done", target: "", tier: null };
  } };
  const task = { kind: "apply", target_url: "https://x.example", goal: "g", drafted_payload: {} };
  const r = await runMission({ browser, task, decider: badDecider,
                               hasCredential: false, fillCredentialValue: noFill });
  assert(r.trace[0].succeeded === false && /Refused/.test(r.trace[0].summary),
    "literal password typing must be refused");
}

// 4) Looping decider is stopped by the harness, not allowed to spin forever.
{
  const browser = new SimulatedBrowser();
  const loopy = { simulated: true, async decide() {
    return { action: "click", target: "Search button", tier: null };
  } };
  const task = { kind: "discover", target_url: "https://x.example", goal: "g", drafted_payload: {} };
  const r = await runMission({ browser, task, decider: loopy,
                               hasCredential: false, fillCredentialValue: noFill, maxSteps: 30 });
  assert(r.status === "failed" && r.trace.length <= 30, "looping agent must be stopped");
}

// 5) Signup unknowns: agent must ASK for info it does not have, then resume
//    and finish once answers are in the mission draft. It must not invent data.
{
  const browser = new SimulatedBrowser();
  const task = { kind: "signup", target_url: "https://pets.example", goal: "Create my sitter account",
                 drafted_payload: {} };
  const r = await runMission({ browser, task, decider: new SimulatedDecider(),
                               hasCredential: false, fillCredentialValue: noFill });
  assert(r.status === "needs_info", `signup without required info should ask the user, got ${r.status}`);
  assert(r.informationRequests.some((q) => /phone/i.test(q)), "should ask for a phone number");

  const browser2 = new SimulatedBrowser();
  const answered = { ...task, drafted_payload: { phone: "+44 7000 000000", dateOfBirth: "1990-01-01" } };
  const r2 = await runMission({ browser: browser2, task: answered, decider: new SimulatedDecider(),
                                hasCredential: false, fillCredentialValue: noFill });
  assert(r2.status === "succeeded", `signup with answers should complete, got ${r2.status}`);
}

console.log("PASS: mission loop explores, adapts to page variants, refuses literal passwords, stops loops, asks user for signup unknowns");
