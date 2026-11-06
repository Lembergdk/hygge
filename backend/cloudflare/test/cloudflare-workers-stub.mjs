// Minimal `cloudflare:workers` stand-in for Node unit tests (see
// register-cloudflare-stub.mjs, loaded by `npm test` via --import).
// Only the surface the backend's Durable Object / entrypoint
// classes extend: the constructor stashes ctx + env, nothing else.
// Production code never imports this file.
export class DurableObject {
  ctx;
  env;
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  ctx;
  env;
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
