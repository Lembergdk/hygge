import type { Env } from "./env.ts";
import { json, sandboxFor } from "./env.ts";
import { handleAuthRequest, resolveRequestUserId } from "./auth.ts";
import { runDateOf, slotForCron, sweepOrder } from "./scan.ts";
import { handleEmailAddressRequest, handleEmailMessage } from "./email.ts";
import { d1PushDb, handleDeviceTokenRequest } from "./push.ts";

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
  // Brief 06 per-user learning state.
  "/feedback-events",
  "/learning-profiles",
  // Brief 05 scheduled scanning (manual tick + status; the cron
  // sweeper below calls the same per-user tick).
  "/scheduled-scan",
  // Brief 04 receive-only email: own address + filed mail + codes meta.
  "/email",
  // Brief 07 push: own device-token registration (D1, see push.ts).
  "/device-tokens",
];

/// Fleet sweeper (Brief 05): one cron tick fans out to every user's
/// sandbox, which decides for itself — server-side pause flag,
/// approved sites, cadence tiers, exhaustion, daily cap. This
/// handler knows only user ids; per-user isolation is unchanged
/// because every scan runs inside that user's own object with the
/// same dispatch as an authenticated request (verified id header
/// set here, never from outside input).
///
/// Known scaling limit, documented not hidden: the sweep is
/// sequential within one scheduled invocation, so total latency
/// grows with users x sites. The rotating visit order
/// (sweepOrder) keeps an over-long sweep fair; sharding ticks or
/// moving to per-user alarms is the follow-up if the fleet grows.
async function sweepScheduledScans(env: Env, cron: string, scheduledTime: number): Promise<void> {
  const slot = slotForCron(cron);
  const now = new Date(scheduledTime || Date.now());
  let userIds: string[] = [];
  try {
    const result = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();
    userIds = (result.results ?? []).map((r) => String(r.id)).filter(Boolean);
  } catch (e) {
    console.log(`scheduled scan sweep: user list unavailable (${String((e as Error)?.message ?? e)})`);
    return;
  }
  const ordered = sweepOrder(userIds, `${cron}|${runDateOf(now)}`);
  let scannedUsers = 0;
  let failedUsers = 0;
  for (const userId of ordered) {
    try {
      const stub = sandboxFor(env, userId);
      const response = await stub.fetch(new Request("https://hygge.internal/scheduled-scan/tick", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hygge-user-id": userId,
          "x-hygge-scheduled-sweep": "1",
        },
        body: JSON.stringify({ slot, now: now.toISOString() }),
      }));
      // A paused user (or one with nothing scannable) still counts
      // as visited: the decision lives in the user's object.
      if (response.ok) scannedUsers += 1; else failedUsers += 1;
      await response.body?.cancel().catch(() => {});
    } catch {
      failedUsers += 1; // one user's failure never stops the sweep
    }
  }
  console.log(
    `scheduled scan sweep slot=${slot} cron="${cron}" users=${userIds.length} visited=${scannedUsers} failed=${failedUsers}`,
  );
}

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

    // Device tokens also live in D1 (the sender runs outside any
    // one user's object during scan ticks only via that user's DO,
    // but registration itself is a fleet-table write).
    if (url.pathname === "/device-tokens" || url.pathname.startsWith("/device-tokens/")) {
      return handleDeviceTokenRequest(request, userId, d1PushDb(env.DB));
    }

    // Everything user-scoped happens inside that user's sandbox.
    const stub = sandboxFor(env, userId);
    const forwarded = new Request(request);
    // Only server-side callers may present trust markers: the
    // cron sweeper (scheduled scans) and the Email Worker
    // (inbound mail delivery into the sandbox). An outside
    // caller can still tick their OWN scans (manual trigger)
    // but cannot impersonate the fleet sweep or fabricate a
    // mail delivery into even their own inbox.
    forwarded.headers.delete("x-hygge-scheduled-sweep");
    forwarded.headers.delete("x-hygge-email-delivery");
    forwarded.headers.set("x-hygge-user-id", userId);
    return stub.fetch(forwarded);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepScheduledScans(env, controller.cron, controller.scheduledTime));
  },

  // Brief 04: Cloudflare Email Routing catch-all target. Receive
  // only — see src/email.ts. Routing itself is enabled in the
  // Cloudflare dashboard (docs/email-usehygge-cc.md).
  email: handleEmailMessage,
};
