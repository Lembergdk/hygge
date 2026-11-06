// Node module customization hook: resolve the `cloudflare:workers`
// specifier to the local stub (cloudflare-workers-stub.mjs) so
// backend modules that extend DurableObject can be imported in
// plain Node tests. Every other specifier passes through
// untouched. Registered by register-cloudflare-stub.mjs.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: new URL("./cloudflare-workers-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
