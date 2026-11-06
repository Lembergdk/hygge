// Loaded by `npm test` via --import: registers the
// cloudflare:workers stub hook (cloudflare-hooks.mjs) for every
// test subprocess, so tests can import UserSandbox and other
// modules that extend DurableObject. No production effect.
import { register } from "node:module";

register("./cloudflare-hooks.mjs", import.meta.url);
