/// Shared environment bindings + the one rule that matters most:
/// the user id comes from a verified credential, never the request.

/// Cloudflare Email Sending binding (magic-link auth mail only).
/// Structural on purpose: auth.ts fakes this exact shape in tests,
/// and the wrangler configs pin the one allowed sender address.
export interface MagicEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
}

export interface Env {
  USER_SANDBOX: DurableObjectNamespace;
  DB: D1Database;
  /// Durable mission queue (see jobs.ts). Optional only so local
  /// and unit environments without the binding keep the inline
  /// request-driven path; deployed configs always set it.
  MISSION_QUEUE?: Queue;
  EMAIL?: MagicEmailBinding; // send_email binding (login@usehygge.app only)
  BROWSER_PROFILES?: R2Bucket; // browser-profile fallback; optional until production bucket exists
  BROWSER: Fetcher;
  /** Wave 2 is opt-in; configs remain unchanged until staging acceptance. */
  HYGGE_WORKSPACE_MODE?: 'legacy' | 'retained-v2';
  WORKSPACE_CHECKPOINTS?: R2Bucket;
  SELF?: Fetcher;
  HYGGE_WORKSPACE_IMAGE?: string; // immutable image@sha256 reference
  HYGGE_WORKSPACE_NAMESPACE?: string;
  HYGGE_SKILL_REGISTRY?: string; // reviewed configuration, never request/model input
  HYGGE_WORKSPACE_POSTCONDITIONS?: string; // reviewed observable completion rules
  HYGGE_MAINTAINER_SECRET?: string; // secret; shared-skill quarantine authority when set
  HYGGE_ENV: string;
  HYGGE_LLM_BASE_URL: string;
  HYGGE_LLM_MODEL_FAST: string;
  HYGGE_LLM_MODEL_STRONG: string;
  // Secrets (set via `wrangler secret put`, never in config):
  HYGGE_LLM_API_KEY?: string;
  /// AI Gateway Run token (cf-aig-authorization) for the gateway in
  /// HYGGE_LLM_BASE_URL; absent = direct provider calls.
  HYGGE_AIG_TOKEN?: string;
  /// "1" lets the gateway store raw prompt/response bodies in its
  /// logs (staging only, mirroring HYGGE_TRACE_PAYLOADS).
  HYGGE_AIG_COLLECT_PAYLOAD?: string;
  /// Agent tracing: "1" records prompt/reply payloads on spans
  /// (staging only; production keeps metadata + usage).
  HYGGE_TRACE_PAYLOADS?: string;
  HYGGE_MASTER_KEY?: string; // base64, 32 bytes
  HYGGE_DEV_TOKENS?: string; // staging only: JSON map token -> userId
  HYGGE_APPLE_BUNDLE_ID?: string;
  HYGGE_MAGIC_BASE_URL?: string; // public API origin magic links point at
  HYGGE_EMAIL_DOMAIN?: string; // receive-only @usehygge.cc domain (Brief 04)
  // Brief 07 APNs (see push.ts): HYGGE_APNS_KEY_P8 is a wrangler
  // secret only; key/team ids may be vars or secrets. APNs host is
  // chosen by HYGGE_APNS_ENVIRONMENT ("sandbox" | "production").
  HYGGE_APNS_KEY_P8?: string;
  HYGGE_APNS_KEY_ID?: string;
  HYGGE_APNS_TEAM_ID?: string;
  HYGGE_APNS_ENVIRONMENT?: string;
}

/// Every authenticated per-user path prefix the router admits.
/// A handler behind a prefix missing here is unreachable (404),
/// however correct the handler is — subscriptions shipped that
/// way once. Lives beside Env so tests can hold it to the
/// D1-side endpoints without importing the worker entry.
export const USER_ROUTES = [
  "/credentials",
  "/session-profiles",
  "/memory",
  "/sessions",
  "/tasks",
  "/skills",
  "/site-proposals",
  "/onboarding",
  "/sandbox",
  // Brief 01 per-user state (see state.ts / user-sandbox.ts).
  "/state",
  "/feed-items",
  "/messages",
  "/profile",
  "/sites",
  "/opportunities",
  "/applications",
  "/proposals",
  "/account-states",
  "/journal-events",
  "/beliefs",
  "/search-evidence",
  // Brief 06 per-user learning state.
  "/feedback-events",
  "/learning-profiles",
  // Brief 05 scheduled scanning (manual tick + status; the cron
  // sweeper calls the same per-user tick).
  "/scheduled-scan",
  // Brief 04 receive-only email: own address + filed mail + codes meta.
  "/email",
  // Brief 07 push: own device-token registration (D1, see push.ts).
  "/device-tokens",
  // Pricing: Plus subscription record + status (D1, subscriptions.ts).
  "/subscriptions",
];

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/// Staging-only bridge (real sessions resolve in auth.ts).
/// Staging bridge (phase 1): HYGGE_DEV_TOKENS maps a bearer token to
/// a user id. Production uses server-issued sessions (auth.ts).
export function userIdFromRequest(request: Request, env: Env): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  if (env.HYGGE_ENV === "staging" && env.HYGGE_DEV_TOKENS) {
    try {
      const map = JSON.parse(env.HYGGE_DEV_TOKENS) as Record<string, string>;
      return map[token] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/// The Durable Object name IS the isolation boundary: one user id,
/// one object, one sandbox, one vault.
export function sandboxFor(env: Env, userId: string): DurableObjectStub {
  return env.USER_SANDBOX.get(env.USER_SANDBOX.idFromName(userId));
}
