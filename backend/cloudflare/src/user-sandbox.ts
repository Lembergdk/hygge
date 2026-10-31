import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { json } from "./env";

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const CONTAINER_IMAGE = "cloudflare/debian-trixie";

/// One UserSandbox (Durable Object + container) per verified user.
/// Holds that user's mission state, credentials (encrypted), site
/// memory, and their sandbox filesystem snapshot id. The container
/// is a workspace; this object is the system of record.
export class UserSandbox extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (
        site_id TEXT PRIMARY KEY, username TEXT, iv TEXT, ciphertext TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS site_memory (
        site_id TEXT PRIMARY KEY, memory TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS approvals (
        site_id TEXT PRIMARY KEY, status TEXT NOT NULL, decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/verify")) {
      // Step-1 acceptance: prove the per-user sandbox executes.
      return this.exclusive(async () => {
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

    if (path.endsWith("/save")) {
      return this.exclusive(async () => {
        const container = await this.startSandbox();
        const snapshot = await container.snapshotContainer({ name: "workspace" });
        await this.ctx.storage.put("snapshotId", snapshot.id);
        await container.destroy();
        return json({ ok: true, snapshotId: snapshot.id, size: snapshot.size });
      });
    }

    // Agent routes (credentials, memory, sessions, tasks,
    // site-proposals, onboarding) land in step 3.
    return json({ error: "not implemented yet", path }, 501);
  }
}
