import type { Env } from "./env.ts";
import { json, sandboxFor } from "./env.ts";
import { handleAuthRequest, resolveRequestUserId } from "./auth.ts";

export { UserSandbox } from "./user-sandbox.ts";

const USER_ROUTES = [
  "/credentials",
  "/session-profiles",
  "/memory",
  "/sessions",
  "/tasks",
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
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // Shape matches the app's Health contract (inherited from the
      // retired local service): the app reads `llm == "live"` to
      // decide it is online rather than in simple/offline mode.
      return json({
        ok: true,
        service: "hygge-api",
        env: env.HYGGE_ENV,
        browser: "browser-run",
        llm: env.HYGGE_LLM_API_KEY ? "live" : "simulated",
        models: { routine: env.HYGGE_LLM_MODEL_FAST, escalated: env.HYGGE_LLM_MODEL_STRONG },
      });
    }

    // Identity exchange + login-method management (Brief 00). Sign-in
    // routes are public; method routes require a session inside.
    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      return handleAuthRequest(request, env);
    }

    const isUserRoute = USER_ROUTES.some(
      (r) => url.pathname === r || url.pathname.startsWith(r + "/"),
    );
    if (!isUserRoute) return json({ error: "not found" }, 404);

    const userId = await resolveRequestUserId(request, env);
    if (!userId) return json({ error: "unauthorized" }, 401);

    // Everything user-scoped happens inside that user's sandbox.
    const stub = sandboxFor(env, userId);
    const forwarded = new Request(request);
    forwarded.headers.set("x-hygge-user-id", userId);
    return stub.fetch(forwarded);
  },
};
