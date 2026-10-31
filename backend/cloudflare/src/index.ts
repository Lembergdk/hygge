import type { Env } from "./env.ts";
import { json, sandboxFor, userIdFromRequest } from "./env.ts";

export { UserSandbox } from "./user-sandbox.ts";

const USER_ROUTES = [
  "/credentials",
  "/memory",
  "/sessions",
  "/tasks",
  "/site-proposals",
  "/onboarding",
  "/sandbox",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "hygge-api", env: env.HYGGE_ENV });
    }

    const isUserRoute = USER_ROUTES.some(
      (r) => url.pathname === r || url.pathname.startsWith(r + "/"),
    );
    if (!isUserRoute) return json({ error: "not found" }, 404);

    const userId = userIdFromRequest(request, env);
    if (!userId) return json({ error: "unauthorized" }, 401);

    // Everything user-scoped happens inside that user's sandbox.
    const stub = sandboxFor(env, userId);
    const forwarded = new Request(request);
    forwarded.headers.set("x-hygge-user-id", userId);
    return stub.fetch(forwarded);
  },
};
