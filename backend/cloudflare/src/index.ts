import type { Env } from "./env.ts";
import { json, sandboxFor } from "./env.ts";
import { handleAuthRequest, resolveRequestUserId } from "./auth.ts";
import { handleEmailAddressRequest, handleEmailMessage } from "./email.ts";

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
  // Brief 04 receive-only email: own address + filed mail + codes meta.
  "/email",
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

    // Own Hygge address lives in D1 (fleet-wide allocation), not the
    // DO. Everything else user-scoped goes into the user's sandbox.
    if (url.pathname === "/email/address") {
      return handleEmailAddressRequest(request, env, userId);
    }

    // Everything user-scoped happens inside that user's sandbox.
    const stub = sandboxFor(env, userId);
    const forwarded = new Request(request);
    forwarded.headers.set("x-hygge-user-id", userId);
    return stub.fetch(forwarded);
  },

  // Brief 04: Cloudflare Email Routing catch-all target. Receive
  // only — see src/email.ts. Routing itself is enabled in the
  // Cloudflare dashboard (docs/email-usehygge-cc.md).
  email: handleEmailMessage,
};
