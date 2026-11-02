/// Cloudflare agent tracing via the Workers custom spans API
/// (GenAI semantic conventions), with a no-op fallback so the
/// same code runs in Node unit tests where `cloudflare:workers`
/// does not exist. Spans surface in the dashboard Agents tab and
/// Workers Observability traces when `observability.traces` is on.

type AttrValue = string | number | boolean;

export interface SpanLike {
  setAttribute(key: string, value: AttrValue): void;
}

const NOOP_SPAN: SpanLike = { setAttribute() {} };

let cached: Promise<any> | null = null;
function loadTracing(): Promise<any> {
  cached ??= (async () => {
    try {
      const mod: any = await import("cloudflare:workers");
      return mod?.tracing ?? null;
    } catch {
      return null;
    }
  })();
  return cached;
}

/// Run `fn` inside a named span (child of the active span, if
/// any). Attributes must be scalars; serialize payloads first.
export async function withSpan<T>(
  name: string,
  attrs: Record<string, AttrValue>,
  fn: (span: SpanLike) => Promise<T>,
): Promise<T> {
  const tracing = await loadTracing();
  if (!tracing?.enterSpan) return fn(NOOP_SPAN);
  return tracing.enterSpan(name, async (span: any) => {
    for (const [k, v] of Object.entries(attrs)) {
      try { span.setAttribute(k, v); } catch { /* attributes are best-effort */ }
    }
    try {
      return await fn(span as SpanLike);
    } catch (e) {
      try {
        span.setAttribute("error.type", e instanceof Error ? e.name : "unknown");
      } catch { /* best-effort */ }
      throw e;
    }
  });
}

/// Span payload size limits truncate long values; clip politely.
export function clip(value: string, max = 8000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[clipped]`;
}

/// The GenAI identity attributes the Agents dashboard groups by.
export function agentAttrs(agentName: string, agentId: string, conversationId?: string | null) {
  const attrs: Record<string, AttrValue> = {
    "gen_ai.agent.name": agentName,
    "gen_ai.agent.id": agentId,
  };
  if (conversationId) attrs["gen_ai.conversation.id"] = conversationId;
  return attrs;
}
