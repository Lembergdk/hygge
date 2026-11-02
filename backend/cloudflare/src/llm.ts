import { withSpan, clip, agentAttrs } from "./tracing.ts";

/// Model routing + client for the mission-loop agent.
/// muse-spark-1.3 for routine per-step decisions; muse-wonder-1.0
/// for escalation (failures, loops, high-stakes final submits,
/// drafting user-facing text). Secrets are never model input.

export interface LLMConfig {
  apiKey?: string;
  baseUrl: string;
  modelFast: string;
  modelStrong: string;
  /// Agent-tracing identity + payload gate (staging records
  /// prompts/replies; production keeps metadata + usage only).
  agentName?: string;
  agentId?: string;
  tracePayloads?: boolean;
  /// Cloudflare AI Gateway: when baseUrl routes through a gateway,
  /// this scoped Run token authenticates at the gateway (the
  /// provider key above still goes through as Authorization).
  gatewayToken?: string;
  /// Whether the gateway may store raw request/response bodies in
  /// its logs. Undefined is treated as false (metadata only).
  gatewayCollectPayload?: boolean;
}

/// Meta Model API list prices in USD per token (Standard mode;
/// spark $1.25/$0.15 cached/$4.25 and wonder $4/$0.20 cached/$20
/// per 1M in/out). The gateway has no built-in pricing for the
/// custom provider, so these go out as cf-aig-custom-cost and
/// gateway logs/analytics price each request from its token
/// usage. Meta publishes no cache-write rate, so cache writes
/// price at the input rate (the gateway default when only a
/// read rate is given).
export const MODEL_PRICES_USD_PER_TOKEN: Record<string, { input: number; output: number; cacheRead: number }> = {
  "muse-spark-1.3": { input: 0.00000125, output: 0.00000425, cacheRead: 0.00000015 },
  "muse-wonder-1.0": { input: 0.000004, output: 0.00002, cacheRead: 0.0000002 },
};

/// Headers for one chat-completions request. Gateway headers are
/// only sent when a gateway token is configured, so a direct
/// provider baseUrl keeps working unchanged.
export function llmRequestHeaders(cfg: LLMConfig, model: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (cfg.gatewayToken) {
    headers["cf-aig-authorization"] = `Bearer ${cfg.gatewayToken}`;
    headers["cf-aig-collect-log-payload"] = cfg.gatewayCollectPayload ? "true" : "false";
    headers["cf-aig-metadata"] = JSON.stringify({
      agent: cfg.agentName ?? "hygge-browser-agent",
      agent_id: cfg.agentId ?? "hygge-dev",
    });
    const price = MODEL_PRICES_USD_PER_TOKEN[model];
    if (price) {
      headers["cf-aig-custom-cost"] = JSON.stringify({
        per_token_in: price.input,
        per_token_out: price.output,
        per_cache_read_token: price.cacheRead,
      });
    }
  }
  return headers;
}

const HIGH_STAKES = new Set(["signup", "apply", "bookCalendar"]);

export interface TierContext {
  taskKind?: string;
  failures?: number;
  repeatedAction?: boolean;
  isFinalSubmit?: boolean;
  drafting?: boolean;
  /// Brief 02 routing: "active" = shared skill loaded, "candidate" =
  /// per-user candidate being corroborated, "none" = no skill at all.
  /// Undefined keeps the pre-Brief-02 behavior (routine Spark).
  skillCoverage?: "active" | "candidate" | "none";
}

export function selectTier(cfg: LLMConfig, ctx: TierContext) {
  const { taskKind, failures = 0, repeatedAction = false, isFinalSubmit = false, drafting = false } = ctx;
  const pick = (tier: "spark" | "wonder", reason: string) => ({
    tier,
    model: tier === "wonder" ? cfg.modelStrong : cfg.modelFast,
    reason,
  });
  if (failures >= 2) return pick("wonder", "repeated failures — escalating to replan");
  if (repeatedAction) return pick("wonder", "agent is looping — escalating to replan");
  if (isFinalSubmit && taskKind && HIGH_STAKES.has(taskKind)) return pick("wonder", "final submit on a high-stakes mission");
  if (drafting) return pick("wonder", "composing user-facing text");
  if (failures === 1) return pick("wonder", "previous action failed — escalating to replan");
  if (ctx.skillCoverage === "none") return pick("wonder", "no active skill for this site/outcome — Wonder authoring mode");
  if (ctx.skillCoverage === "candidate") return pick("wonder", "skill candidate not yet corroborated — Wonder confirming mode");
  return pick("spark", ctx.skillCoverage === "active" ? "active shared skill loaded" : "routine browsing decision");
}

export class LLMClient {
  cfg: LLMConfig;
  constructor(cfg: LLMConfig) {
    this.cfg = cfg;
  }

  get configured(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  private chatAttrs(model: string, conversationId?: string) {
    return {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model,
      "gen_ai.system": "meta",
      ...agentAttrs(this.cfg.agentName ?? "hygge-browser-agent", this.cfg.agentId ?? "hygge-dev", conversationId),
    };
  }

  private payloadAttrs(span: { setAttribute(k: string, v: string): void },
                       system: string, user: string, output?: string) {
    if (!this.cfg.tracePayloads) return;
    span.setAttribute("gen_ai.system_instructions", clip(system));
    span.setAttribute("gen_ai.input.messages", clip(JSON.stringify([{ role: "user", content: user }])));
    if (output !== undefined) {
      span.setAttribute("gen_ai.output.messages", clip(JSON.stringify([{ role: "assistant", content: output }])));
    }
  }

  async complete({ model, system, user, conversationId }: { model: string; system: string; user: string; conversationId?: string }): Promise<string> {
    return withSpan(`chat ${model}`, this.chatAttrs(model, conversationId), async (span) => {
      this.payloadAttrs(span, system, user);
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: llmRequestHeaders(this.cfg, model),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`LLM ${model} returned ${res.status}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      if (data.usage?.prompt_tokens !== undefined) span.setAttribute("gen_ai.usage.input_tokens", data.usage.prompt_tokens);
      if (data.usage?.completion_tokens !== undefined) span.setAttribute("gen_ai.usage.output_tokens", data.usage.completion_tokens);
      const text = data.choices?.[0]?.message?.content ?? "";
      this.payloadAttrs(span, system, user, text);
      return text;
    });
  }

  async completeStream(
    { model, system, user, conversationId }: { model: string; system: string; user: string; conversationId?: string },
    onDelta: (delta: string) => void,
  ): Promise<string> {
    return withSpan(`chat ${model}`, this.chatAttrs(model, conversationId), async (span) => {
    this.payloadAttrs(span, system, user);
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: llmRequestHeaders(this.cfg, model),
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${model} returned ${res.status}`);
    if (!res.body) throw new Error("LLM stream had no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          if (chunk.usage?.prompt_tokens !== undefined) span.setAttribute("gen_ai.usage.input_tokens", chunk.usage.prompt_tokens);
          if (chunk.usage?.completion_tokens !== undefined) span.setAttribute("gen_ai.usage.output_tokens", chunk.usage.completion_tokens);
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          /* partial/keepalive lines are ignored */
        }
      }
    }
    this.payloadAttrs(span, system, user, full);
    return full;
    });
  }
}

/// Extract the first JSON object from a model reply (tolerates fences/prose).
export function parseDecision(text: unknown): Record<string, unknown> | null {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
