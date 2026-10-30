// Hygge agent service: mission-driven cloud browsing + site memory + vault.
//
// Browsing model (see agent.mjs): every task is a MISSION. The agent loop is
// observe -> LLM decides one action -> execute -> observe... There are no
// scripts or playbooks. After a run, the trajectory is distilled into
// per-domain memory HINTS that future missions may consult but never replay.
//
// Contract with the iOS app:
// - Write tasks start awaiting_approval; only POST /tasks/{id}/approve runs one.
// - Credentials live encrypted in the vault; the worker fills them via
//   credential placeholders — models/apps/logs never see secrets.
//
// Run (dev, simulated):  node server.mjs
// Run (live):            ./run-live.sh     (keychain: CF token + Meta key)
// Test:                  npm test          (offline)  |  npm run test:live:agent
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "./vault.mjs";
import { makeBrowser } from "./browser.mjs";
import { LLMClient, llmConfigured, MODELS } from "./llm.mjs";
import { makeDecider, runMission, distillHints } from "./agent.mjs";
import { onboardingMessage, onboardingMessageStream } from "./onboarding.mjs";

const DATA_DIR = process.env.HYGGE_DATA_DIR ?? "./data";
mkdirSync(DATA_DIR, { recursive: true });
const MEMORY_FILE = join(DATA_DIR, "memory.json");

if (!process.env.HYGGE_VAULT_KEY) {
  process.env.HYGGE_VAULT_KEY = Buffer.from(randomUUID() + randomUUID(), "utf8")
    .subarray(0, 32).toString("hex");
  console.warn("WARNING: HYGGE_VAULT_KEY unset — using an ephemeral dev key.");
}
const vault = new Vault(join(DATA_DIR, "vault.json"), process.env.HYGGE_VAULT_KEY);
const browser = makeBrowser();
const decider = makeDecider(new LLMClient());
const tasks = new Map();

const MEMORY_KIND = { discover: "searchOpportunities", signup: "signup",
  buildProfile: "buildProfile", apply: "apply", message: "apply", bookCalendar: "bookCalendar" };
const WRITE_KINDS = new Set(["signup", "buildProfile", "apply", "message", "bookCalendar"]);

let memories = existsSync(MEMORY_FILE) ? JSON.parse(readFileSync(MEMORY_FILE, "utf8")) : [];
const saveMemories = () => writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const memoryFor = (domain, kind) => memories.find((m) => m.domain === domain && m.kind === kind);

function recordOutcome(domain, kind, trace, extractedItems, success) {
  let memory = memoryFor(domain, kind);
  if (!memory) {
    if (!success) return null; // learn only from runs that achieved something
    memory = { id: randomUUID(), domain, kind, hints: [], successCount: 0,
               failureCount: 0, updatedAt: new Date().toISOString() };
    memories.push(memory);
  }
  if (success) {
    memory.hints = distillHints({ domain, trace, extractedItems, existing: memory.hints });
    memory.successCount += 1;
  } else {
    memory.failureCount += 1;
  }
  memory.updatedAt = new Date().toISOString();
  saveMemories();
  return memory;
}

async function runTask(task) {
  const kind = MEMORY_KIND[task.kind] ?? "searchOpportunities";
  const domain = domainOf(task.target_url);
  const memory = memoryFor(domain, kind);
  const hints = memory?.hints ?? [];
  task.log.push(hints.length
    ? `Mission on ${domain} with ${hints.length} advisory memory hint(s) from past runs (agent still decides from the live page)`
    : `Mission on ${domain} — new site, no memory yet. Agent explores from the goal alone.`);

  const fillCredentialValue = async (valueRef, target, sessionID) => {
    if (!task.credential_id) throw new Error("agent requested a credential but none is stored for this domain");
    await vault.use(task.credential_id, async ({ username, secret }) => {
      await browser.act(sessionID, {
        action: "type", target,
        value: valueRef.endsWith("secret") ? secret : username,
      });
    });
  };

  const result = await runMission({
    browser, task, hints, decider, fillCredentialValue,
    hasCredential: Boolean(task.credential_id),
  });
  task.browser_trace = result.trace;
  task.extracted_items = result.extractedItems;
  task.session_id = result.sessionID;
  task.log.push(...result.log);
  task.status = (result.status === "needs_human" || result.status === "needs_info") ? "needsHuman" : result.status;
  if (result.informationRequests?.length) {
    task.information_requests = result.informationRequests;
    task.log.push("The agent needs information only you can provide — answer in the app and re-approve to resume.");
  }

  const recorded = recordOutcome(domain, kind, result.trace, result.extractedItems, result.status === "succeeded");
  if (recorded) {
    task.memory_id = recorded.id;
    if (result.status === "succeeded") {
      task.log.push(`Site memory for ${domain} updated (${recorded.hints.length} hint(s), ${recorded.successCount} successful run(s)) — advice for next time, not a script`);
    }
  }
  if (result.status !== "needs_human") await browser.closeSession(result.sessionID).catch(() => {});
  return task;
}

const STATIC_PROPOSALS = {
  petCare: [
    { name: "Rover", url: "https://www.rover.com", rationale: "Largest pet-sitting marketplace; sitters set their own rates" },
    { name: "TrustedHousesitters", url: "https://www.trustedhousesitters.com", rationale: "House/pet sits exchanged for accommodation worldwide" },
    { name: "Pawshake", url: "https://www.pawshake.com", rationale: "Local pet sitting and dog walking bookings" },
    { name: "Nextdoor", url: "https://www.nextdoor.com", rationale: "Neighbours frequently post pet-care requests" },
  ],
  freelance: [
    { name: "Upwork", url: "https://www.upwork.com", rationale: "Largest freelance marketplace across most skills" },
    { name: "Fiverr", url: "https://www.fiverr.com", rationale: "Package your skills as fixed-price gigs" },
    { name: "Contra", url: "https://contra.com", rationale: "Commission-free freelance projects" },
  ],
  localGig: [
    { name: "Taskrabbit", url: "https://www.taskrabbit.com", rationale: "Local tasks: assembly, moving, errands" },
    { name: "Airtasker", url: "https://www.airtasker.com", rationale: "Open local task board you bid on" },
  ],
};

async function proposeSites({ category = "petCare", locationLabel = "", interests = [] }) {
  const fallback = STATIC_PROPOSALS[category] ?? [];
  if (!llmConfigured()) return fallback;
  try {
    const client = new LLMClient();
    const text = await client.complete({
      model: MODELS.spark(),
      system: "Reply with ONLY a JSON array, no prose.",
      user: `List up to 6 real, currently operating websites where someone ${locationLabel ? `based in ${locationLabel} ` : ""}can sign up to earn money in category "${category}" (interests: ${interests.join(", ") || category}). Each item: {"name":"...","url":"https://...","rationale":"one clause why this site suits them"}. Only real sites with correct URLs.`,
    });
    const match = String(text).match(/\[[\s\S]*\]/);
    const parsed = match ? JSON.parse(match[0]) : null;
    const valid = (parsed ?? []).filter((x) => x?.name && /^https:\/\//.test(x?.url ?? ""));
    return valid.length ? valid.slice(0, 6) : fallback;
  } catch {
    return fallback;
  }
}

function checkToken(req) {
  const token = process.env.HYGGE_API_TOKEN;
  return !token || req.headers.authorization === `Bearer ${token}`;
}

const server = createServer(async (req, res) => {
  const reply = (code, obj) => {
    const data = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    res.end(data);
  };
  const body = await new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); } });
  });
  const parts = req.url.split("/").filter(Boolean);

  try {
    if (req.method === "GET" && req.url === "/health") {
      return reply(200, { ok: true, browser: browser.mode, memories: memories.length,
        llm: llmConfigured() ? "live" : "simulated",
        models: { routine: MODELS.spark(), escalated: MODELS.wonder() } });
    }
    if (!checkToken(req)) return reply(401, { error: "unauthorized" });

    if (req.method === "POST" && parts.join("/") === "credentials") return reply(201, vault.add(body));
    if (req.method === "GET" && parts.join("/") === "credentials") return reply(200, { credentials: vault.list() });
    if (req.method === "DELETE" && parts[0] === "credentials") return reply(200, { removed: vault.remove(parts[1]) });

    if (req.method === "GET" && (parts.join("/") === "memory" || parts.join("/") === "skills")) {
      return reply(200, { memories });
    }

    if (req.method === "POST" && parts.join("/") === "onboarding/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      await onboardingMessageStream({ client: new LLMClient(), ...body }, emit);
      res.end();
      return;
    }
    if (req.method === "POST" && parts.join("/") === "onboarding/message") {
      return reply(200, await onboardingMessage({ client: new LLMClient(), ...body }));
    }
    if (req.method === "POST" && parts.join("/") === "site-proposals") {
      return reply(200, { proposals: await proposeSites(body) });
    }
    if (req.method === "POST" && parts.join("/") === "sessions") {
      if (!body.url) return reply(400, { error: "url required" });
      return reply(201, await browser.createSession(body.url));
    }
    if (req.method === "GET" && parts[0] === "sessions") {
      const snap = await browser.snapshot(parts[1]);
      return snap ? reply(200, snap) : reply(404, { error: "unknown session" });
    }
    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "act") {
      const snap = await browser.act(parts[1], body);
      return snap ? reply(200, snap) : reply(404, { error: "unknown session" });
    }
    if (req.method === "DELETE" && parts[0] === "sessions") return reply(200, { closed: await browser.closeSession(parts[1]) });

    if (req.method === "POST" && parts.join("/") === "tasks") {
      const kind = body.kind ?? "discover";
      const task = { id: randomUUID(), kind, target_url: body.target_url ?? "",
        goal: body.goal ?? "", title: body.title ?? kind,
        drafted_payload: body.drafted_payload ?? {},
        credential_id: body.credential_id ?? vault.findByDomain(domainOf(body.target_url ?? ""))?.id ?? null,
        requires_approval: WRITE_KINDS.has(kind), status: "awaiting_approval",
        memory_id: null, session_id: null, browser_trace: [], extracted_items: [], information_requests: [],
        log: ["Drafted. Waiting for user approval."] };
      tasks.set(task.id, task);
      return reply(201, task);
    }
    if (req.method === "GET" && parts.join("/") === "tasks") return reply(200, { tasks: [...tasks.values()] });
    if (req.method === "POST" && parts[0] === "tasks") {
      const task = tasks.get(parts[1]);
      if (!task) return reply(404, { error: "unknown task" });
      if (parts[2] === "run" && task.requires_approval) return reply(403, { error: "approval required: POST /tasks/{id}/approve" });
      if (parts[2] === "reject") {
        if (!["awaiting_approval", "needsHuman"].includes(task.status)) return reply(409, { error: `cannot reject from ${task.status}` });
        task.status = "rejected"; task.log.push("Rejected by user");
        return reply(200, task);
      }
      if (parts[2] === "approve" || parts[2] === "run") {
        if (task.status !== "awaiting_approval") return reply(409, { error: `task is ${task.status}, not awaiting_approval` });
        task.status = "approved"; task.log.push("Approved by user");
        return reply(200, await runTask(task));
      }
    }
    return reply(404, { error: "not found" });
  } catch (e) {
    return reply(500, { error: e.message });
  }
});

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
if (HOST !== "127.0.0.1" && HOST !== "localhost" && !process.env.HYGGE_API_TOKEN) {
  console.error("Refusing to bind non-loopback without HYGGE_API_TOKEN set (the vault API would be LAN-exposed).");
  process.exit(1);
}
server.listen(PORT, HOST, () =>
  console.log(`Hygge agent service on http://${HOST}:${PORT} (browser: ${browser.mode}, llm: ${llmConfigured() ? "live" : "simulated"})`));
