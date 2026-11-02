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
    try {
      if (typeof span.setAttributes === "function") span.setAttributes(attrs);
      else for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    } catch { /* attributes are best-effort */ }
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

export interface AgentSessionIdentity {
  id?: string | null;
  name?: string | null;
}

/// The identity attributes the Agents dashboard groups by. The
/// scope/session pair mirrors the Agents SDK's compatibility
/// identity block; the GenAI fields carry the standard
/// agent/conversation grouping.
/// `cloudflare.agents.session.id` identifies the durable
/// per-user session, while `gen_ai.conversation.id` identifies
/// the current conversation or mission within it.
export function agentAttrs(
  agentName: string,
  agentId: string,
  conversationId?: string | null,
  session?: AgentSessionIdentity,
) {
  const attrs: Record<string, AttrValue> = {
    "instrumentation_scope.name": "agents",
    "instrumentation_scope.version": "1",
    "gen_ai.agent.name": agentName,
    "gen_ai.agent.id": agentId,
  };
  if (conversationId) attrs["gen_ai.conversation.id"] = conversationId;
  const sessionId = session?.id ?? conversationId;
  if (sessionId) attrs["cloudflare.agents.session.id"] = sessionId;
  if (session?.name) attrs["cloudflare.agents.session.name"] = session.name;
  return attrs;
}
