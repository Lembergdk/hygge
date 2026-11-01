/// Shared environment bindings + the one rule that matters most:
/// the user id comes from a verified credential, never the request.

export interface Env {
  USER_SANDBOX: DurableObjectNamespace;
  DB: D1Database;
  BROWSER_PROFILES?: R2Bucket; // browser-profile fallback; optional until production bucket exists
  BROWSER: Fetcher;
  HYGGE_ENV: string;
  HYGGE_LLM_BASE_URL: string;
  HYGGE_LLM_MODEL_FAST: string;
  HYGGE_LLM_MODEL_STRONG: string;
  // Secrets (set via `wrangler secret put`, never in config):
  HYGGE_LLM_API_KEY?: string;
  HYGGE_MASTER_KEY?: string; // base64, 32 bytes
  HYGGE_DEV_TOKENS?: string; // staging only: JSON map token -> userId
  HYGGE_APPLE_BUNDLE_ID?: string;
  HYGGE_EMAIL_DOMAIN?: string; // receive-only @usehygge.cc domain (Brief 04)
  HYGGE_APNS_KEY_P8?: string;
  HYGGE_APNS_KEY_ID?: string;
  HYGGE_APNS_TEAM_ID?: string;
}

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
