import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { json } from "./env.ts";
import { LLMClient, type LLMConfig } from "./llm.ts";
import { onboardingMessage, onboardingMessageStream } from "./onboarding.ts";
import { BrowserRunBrowser } from "./browser.ts";
import { makeDecider, runMission, distillHints } from "./agent.ts";
import * as vault from "./vault.ts";

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const CONTAINER_IMAGE = "cloudflare/debian-trixie";

const MEMORY_KIND: Record<string, string> = {
  discover: "searchOpportunities",
  signup: "signup",
  buildProfile: "buildProfile",
  apply: "apply",
  message: "apply",
  bookCalendar: "bookCalendar",
};
const WRITE_KINDS = new Set(["signup", "buildProfile", "apply", "message", "bookCalendar"]);

const STATIC_PROPOSALS: Record<string, { name: string; url: string; rationale: string }[]> = {
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

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type Row = Record<string, unknown>;

/// One UserSandbox (Durable Object + container) per verified user.
/// Holds that user's tasks, credentials (encrypted under their own
/// DEK), site memory, approvals, and sandbox snapshot. The container
/// is a workspace; this object is the system of record.
export class UserSandbox extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private userId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
    // Schema migration guard: CREATE IF NOT EXISTS never migrates,
    // and PRAGMA is unauthorized in DO SQLite — so detect the old
    // scaffold schema via sqlite_schema and rebuild. (Production
    // needs real migrations before any user has data worth keeping.)
    const credSql = [
      ...ctx.storage.sql.exec(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'credentials'",
      ),
    ] as Row[];
    if (credSql.length && !String(credSql[0].sql).includes("(id TEXT PRIMARY KEY")) {
      ctx.storage.sql.exec(`
        DROP TABLE IF EXISTS credentials;
        DROP TABLE IF EXISTS memories;
        DROP TABLE IF EXISTS tasks;
        DROP TABLE IF EXISTS site_memory;
        DROP TABLE IF EXISTS approvals;
      `);
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, domain TEXT NOT NULL, username TEXT NOT NULL,
        iv TEXT NOT NULL, ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, domain TEXT NOT NULL, kind TEXT NOT NULL,
        hints TEXT NOT NULL DEFAULT '[]', success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(domain, kind)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, task TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // ---- plumbing -------------------------------------------------

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private llmConfig(): LLMConfig {
    return {
      apiKey: this.env.HYGGE_LLM_API_KEY,
      baseUrl: this.env.HYGGE_LLM_BASE_URL,
      modelFast: this.env.HYGGE_LLM_MODEL_FAST,
      modelStrong: this.env.HYGGE_LLM_MODEL_STRONG,
    };
  }

  private async startSandbox() {
    const container = this.ctx.container;
    if (!container) throw new Error("No container is configured");
    if (!container.running) {
      const snapshotId = await this.ctx.storage.get<string>("snapshotId");
      container.start({
        ...(snapshotId
          ? { containerSnapshot: { id: snapshotId } }
          : { image: CONTAINER_IMAGE }),
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
      });
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
    return container;
  }

  // ---- vault ----------------------------------------------------

  /// The user's DEK, created once, stored wrapped (AES-KW) under the
  /// environment master key in both this object and D1 `user_keys`.
  private async dek(): Promise<CryptoKey> {
    const master = await vault.masterKey(this.env);
    const wrapped = await this.ctx.storage.get<string>("wrappedDek");
    if (wrapped) return vault.unwrapDEK(wrapped, master);
    const dek = await vault.generateDEK();
    const wrappedNew = await vault.wrapDEK(dek, master);
    await this.ctx.storage.put("wrappedDek", wrappedNew);
    if (this.userId) {
      await this.env.DB.prepare(
        "INSERT INTO users (id, do_instance) VALUES (?1, ?1) ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')",
      )
        .bind(this.userId)
        .run()
        .catch(() => {});
      await this.env.DB.prepare(
        "INSERT INTO user_keys (user_id, wrapped) VALUES (?1, ?2) ON CONFLICT(user_id) DO NOTHING",
      )
        .bind(this.userId, wrappedNew)
        .run()
        .catch(() => {});
    }
    return dek;
  }

  // ---- tasks ----------------------------------------------------

  private loadTask(id: string): any | null {
    const rows = [...this.ctx.storage.sql.exec("SELECT task FROM tasks WHERE id = ?", id)] as Row[];
    return rows.length ? JSON.parse(String(rows[0].task)) : null;
  }

  private saveTask(task: any) {
    this.ctx.storage.sql.exec(
      "INSERT INTO tasks (id, task) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET task = excluded.task",
      task.id,
      JSON.stringify(task),
    );
  }

  private recordOutcome(domain: string, kind: string, trace: any[], extractedItems: string[], success: boolean) {
    const rows = [
      ...this.ctx.storage.sql.exec("SELECT * FROM memories WHERE domain = ? AND kind = ?", domain, kind),
    ] as Row[];
    let memory = rows[0] ?? null;
    if (!memory) {
      if (!success) return null; // learn only from runs that achieved something
      memory = {
        id: crypto.randomUUID(),
        domain,
        kind,
        hints: "[]",
        success_count: 0,
        failure_count: 0,
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO memories (id, domain, kind, hints) VALUES (?, ?, ?, '[]')",
        memory.id,
        domain,
        kind,
      );
    }
    if (success) {
      const hints = distillHints({
        domain,
        trace,
        extractedItems,
        existing: JSON.parse(String(memory.hints)),
      });
      this.ctx.storage.sql.exec(
        "UPDATE memories SET hints = ?, success_count = success_count + 1, updated_at = datetime('now') WHERE id = ?",
        JSON.stringify(hints),
        memory.id,
      );
      return { id: memory.id, hints, successCount: Number(memory.success_count) + 1 };
    }
    this.ctx.storage.sql.exec(
      "UPDATE memories SET failure_count = failure_count + 1, updated_at = datetime('now') WHERE id = ?",
      memory.id,
    );
    return { id: memory.id, hints: JSON.parse(String(memory.hints)), successCount: Number(memory.success_count) };
  }

  private async runTask(task: any, browser: BrowserRunBrowser) {
    const kind = MEMORY_KIND[task.kind] ?? "searchOpportunities";
    const domain = domainOf(task.target_url);
    const rows = [
      ...this.ctx.storage.sql.exec("SELECT hints FROM memories WHERE domain = ? AND kind = ?", domain, kind),
    ] as Row[];
    const hints: string[] = rows.length ? JSON.parse(String(rows[0].hints)) : [];
    task.log.push(
      hints.length
        ? `Mission on ${domain} with ${hints.length} advisory memory hint(s) from past runs (agent still decides from the live page)`
        : `Mission on ${domain} — new site, no memory yet. Agent explores from the goal alone.`,
    );

    const fillCredentialValue = async (valueRef: string, target: string, sessionID: string) => {
      if (!task.credential_id) throw new Error("agent requested a credential but none is stored for this domain");
      const creds = [
        ...this.ctx.storage.sql.exec("SELECT * FROM credentials WHERE id = ?", task.credential_id),
      ] as Row[];
      if (!creds.length) throw new Error("unknown credential");
      const r = creds[0];
      const secret = await vault.open(
        await this.dek(),
        { iv: String(r.iv), ciphertext: String(r.ciphertext) },
        `${r.domain}\n${r.username}`,
      );
      await browser.act(sessionID, {
        action: "type",
        target,
        value: valueRef.endsWith("secret") ? secret : String(r.username),
      });
    };

    const decider = makeDecider(new LLMClient(this.llmConfig()));
    const result = await runMission({
      browser,
      task,
      hints,
      decider,
      fillCredentialValue,
      hasCredential: Boolean(task.credential_id),
    });
    task.browser_trace = result.trace;
    task.extracted_items = result.extractedItems;
    task.session_id = result.sessionID;
    task.log.push(...result.log);
    task.status = result.status === "needs_human" || result.status === "needs_info" ? "needsHuman" : result.status;
    if (result.informationRequests?.length) {
      task.information_requests = result.informationRequests;
      task.log.push("The agent needs information only you can provide — answer in the app and re-approve to resume.");
    }
    const recorded = this.recordOutcome(domain, kind, result.trace, result.extractedItems, result.status === "succeeded");
    if (recorded) {
      task.memory_id = recorded.id;
      if (result.status === "succeeded") {
        task.log.push(
          `Site memory for ${domain} updated (${recorded.hints.length} hint(s), ${recorded.successCount} successful run(s)) — advice for next time, not a script`,
        );
      }
    }
    if (result.status !== "needs_human") await browser.closeSession(result.sessionID).catch(() => {});
    this.saveTask(task);
    return task;
  }

  private async proposeSites(body: any) {
    const { category = "petCare", locationLabel = "", interests = [] } = body ?? {};
    const fallback = STATIC_PROPOSALS[String(category)] ?? [];
    const client = new LLMClient(this.llmConfig());
    if (!client.configured) return fallback;
    try {
      const text = await client.complete({
        model: client.cfg.modelFast,
        system: "Reply with ONLY a JSON array, no prose.",
        user: `List up to 6 real, currently operating websites where someone ${locationLabel ? `based in ${locationLabel} ` : ""}can sign up to earn money in category "${category}" (interests: ${(interests as string[]).join(", ") || category}). Each item: {"name":"...","url":"https://...","rationale":"one clause why this site suits them"}. Only real sites with correct URLs.`,
      });
      const match = String(text).match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : null;
      const valid = (parsed ?? []).filter((x: any) => x?.name && /^https:\/\//.test(x?.url ?? ""));
      return valid.length ? valid.slice(0, 6) : fallback;
    } catch {
      return fallback;
    }
  }

  // ---- routes ---------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    this.userId = request.headers.get("x-hygge-user-id") ?? this.userId;
    const url = new URL(request.url);
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    const body = request.method === "GET" || request.method === "DELETE"
      ? {}
      : ((await request.json().catch(() => ({}))) as any);

    try {
      // Sandbox diagnostics
      if (path.endsWith("/sandbox/verify")) {
        return await this.exclusive(async () => {
          const container = await this.startSandbox();
          const proc = await container.exec(["bash", "-lc", "uname -s; node --version"]);
          const out = await proc.output();
          return json({
            ok: true,
            stdout: new TextDecoder().decode(out.stdout).trim(),
            exitCode: out.exitCode,
          });
        });
      }
      if (path.endsWith("/sandbox/save")) {
        return await this.exclusive(async () => {
          const container = await this.startSandbox();
          const snapshot = await container.snapshotContainer({ name: "workspace" });
          await this.ctx.storage.put("snapshotId", snapshot.id);
          await container.destroy();
          return json({ ok: true, snapshotId: snapshot.id, size: snapshot.size });
        });
      }

      // Credentials (metadata only leaves the vault API)
      if (request.method === "POST" && parts.join("/") === "credentials") {
        const { domain, username, secret } = body;
        if (!domain || !username || !secret) return json({ error: "domain, username, secret required" }, 400);
        const blob = await vault.seal(await this.dek(), String(secret), `${domain}\n${username}`);
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          "INSERT INTO credentials (id, domain, username, iv, ciphertext) VALUES (?, ?, ?, ?, ?)",
          id,
          domain,
          username,
          blob.iv,
          blob.ciphertext,
        );
        return json({ id, domain, username, createdAt: new Date().toISOString() }, 201);
      }
      if (request.method === "GET" && parts.join("/") === "credentials") {
        const rows = [...this.ctx.storage.sql.exec("SELECT id, domain, username, created_at FROM credentials")] as Row[];
        return json({
          credentials: rows.map((r) => ({ id: r.id, domain: r.domain, username: r.username, createdAt: r.created_at })),
        });
      }
      if (request.method === "DELETE" && parts[0] === "credentials") {
        const id = parts[1];
        const before = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM credentials")] as Row[];
        this.ctx.storage.sql.exec("DELETE FROM credentials WHERE id = ?", id);
        const after = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM credentials")] as Row[];
        return json({ removed: Number(after[0].n) < Number(before[0].n) });
      }

      // Site memory
      if (request.method === "GET" && (parts.join("/") === "memory" || parts.join("/") === "skills")) {
        const rows = [...this.ctx.storage.sql.exec("SELECT * FROM memories")] as Row[];
        return json({
          memories: rows.map((r) => ({
            id: r.id,
            domain: r.domain,
            kind: r.kind,
            hints: JSON.parse(String(r.hints)),
            successCount: r.success_count,
            failureCount: r.failure_count,
            updatedAt: r.updated_at,
          })),
        });
      }

      // Onboarding conversation
      if (request.method === "POST" && parts.join("/") === "onboarding/stream") {
        const client = new LLMClient(this.llmConfig());
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const emit = (event: unknown) => {
          void writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        this.ctx.waitUntil(
          (async () => {
            try {
              await onboardingMessageStream({ client, ...(body as object) }, emit);
            } finally {
              await writer.close().catch(() => {});
            }
          })(),
        );
        return new Response(readable, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      if (request.method === "POST" && parts.join("/") === "onboarding/message") {
        return json(await onboardingMessage({ client: new LLMClient(this.llmConfig()), ...(body as object) }));
      }
      if (request.method === "POST" && parts.join("/") === "site-proposals") {
        return json({ proposals: await this.proposeSites(body) });
      }

      // Browser sessions
      const browser = new BrowserRunBrowser(this.env.BROWSER);
      if (request.method === "POST" && parts.join("/") === "sessions") {
        if (!body.url) return json({ error: "url required" }, 400);
        return json(await browser.createSession(body.url), 201);
      }
      if (request.method === "GET" && parts[0] === "sessions") {
        const snap = await browser.snapshot(parts[1]);
        return snap ? json(snap) : json({ error: "unknown session" }, 404);
      }
      if (request.method === "POST" && parts[0] === "sessions" && parts[2] === "act") {
        const snap = await browser.act(parts[1], body);
        return snap ? json(snap) : json({ error: "unknown session" }, 404);
      }
      if (request.method === "DELETE" && parts[0] === "sessions") {
        return json({ closed: await browser.closeSession(parts[1]) });
      }

      // Tasks (approval gate enforced here)
      if (request.method === "POST" && parts.join("/") === "tasks") {
        const kind = body.kind ?? "discover";
        const domain = domainOf(body.target_url ?? "");
        const cred = [
          ...this.ctx.storage.sql.exec("SELECT id FROM credentials WHERE domain = ? LIMIT 1", domain),
        ] as Row[];
        const task = {
          id: crypto.randomUUID(),
          kind,
          target_url: body.target_url ?? "",
          goal: body.goal ?? "",
          title: body.title ?? kind,
          drafted_payload: body.drafted_payload ?? {},
          credential_id: body.credential_id ?? (cred.length ? cred[0].id : null),
          requires_approval: WRITE_KINDS.has(kind),
          status: "awaiting_approval",
          memory_id: null,
          session_id: null,
          browser_trace: [] as any[],
          extracted_items: [] as string[],
          information_requests: [] as string[],
          log: ["Drafted. Waiting for user approval."],
        };
        this.saveTask(task);
        return json(task, 201);
      }
      if (request.method === "GET" && parts.join("/") === "tasks") {
        const rows = [...this.ctx.storage.sql.exec("SELECT task FROM tasks ORDER BY created_at")] as Row[];
        return json({ tasks: rows.map((r) => JSON.parse(String(r.task))) });
      }
      if (request.method === "POST" && parts[0] === "tasks") {
        const task = this.loadTask(parts[1]);
        if (!task) return json({ error: "unknown task" }, 404);
        if (parts[2] === "run" && task.requires_approval) {
          return json({ error: "approval required: POST /tasks/{id}/approve" }, 403);
        }
        if (parts[2] === "reject") {
          if (!["awaiting_approval", "needsHuman"].includes(task.status)) {
            return json({ error: `cannot reject from ${task.status}` }, 409);
          }
          task.status = "rejected";
          task.log.push("Rejected by user");
          this.saveTask(task);
          return json(task);
        }
        if (parts[2] === "approve" || parts[2] === "run") {
          if (task.status !== "awaiting_approval") {
            return json({ error: `task is ${task.status}, not awaiting_approval` }, 409);
          }
          task.status = "approved";
          task.log.push("Approved by user");
          this.saveTask(task);
          return json(await this.runTask(task, browser));
        }
      }

      return json({ error: "not found", path }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }
}
