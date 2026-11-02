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
  /// Durable per-user session identity for Agents grouping.
  /// A per-call conversation ID can still identify one mission
  /// or onboarding conversation inside that session.
  sessionId?: string;
  sessionName?: string;
  /// Default conversation when a caller does not supply one.
  conversationId?: string;
  tracePayloads?: boolean;
  /// Cloudflare AI Gateway: when baseUrl routes through a gateway,
  /// this scoped Run token authenticates at the gateway and the
  /// provider key stays in the gateway's stored keys (BYOK), so
  /// no provider Authorization is sent. Without it, requests go
  /// direct with apiKey as Authorization.
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

/// Headers for one chat-completions request. With a gateway
/// token, the gateway injects its stored provider key — it only
/// does so when Authorization is absent, so the provider key
/// must not be sent. Without a gateway token this is a direct
/// provider call with apiKey as Authorization.
export function llmRequestHeaders(cfg: LLMConfig, model: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!cfg.gatewayToken) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
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

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_token_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  output_token_details?: { reasoning_tokens?: number };
}

/// Current GenAI message shape used by session replay: a role
/// plus typed parts, rather than a legacy flat `content` string.
export function genAiTextMessage(role: string, text: string, finishReason?: string | null) {
  return {
    role,
    parts: [{ type: "text", content: text }],
    ...(finishReason ? { finish_reason: finishReason } : {}),
  };
}

export function traceUsageAttributes(usage: ChatUsage | undefined) {
  const attrs: Record<string, number> = {};
  if (!usage) return attrs;
  if (typeof usage.prompt_tokens === "number") attrs["gen_ai.usage.input_tokens"] = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") attrs["gen_ai.usage.output_tokens"] = usage.completion_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_token_details?.cached_tokens;
  if (typeof cached === "number") attrs["gen_ai.usage.cache_read.input_tokens"] = cached;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_token_details?.reasoning_tokens;
  if (typeof reasoning === "number") attrs["gen_ai.usage.reasoning.output_tokens"] = reasoning;
  const total = typeof usage.total_tokens === "number"
    ? usage.total_tokens
    : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  if (total > 0) attrs["cloudflare.agents.usage.total_tokens"] = total;
  return attrs;
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
    const effectiveConversationId = conversationId ?? this.cfg.conversationId;
    return {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "meta",
      "gen_ai.request.model": model,
      "gen_ai.system": "meta",
      ...agentAttrs(
        this.cfg.agentName ?? "hygge-browser-agent",
        this.cfg.agentId ?? "hygge-dev",
        effectiveConversationId,
        { id: this.cfg.sessionId ?? effectiveConversationId, name: this.cfg.sessionName },
      ),
    };
  }

  private payloadAttrs(span: { setAttribute(k: string, v: string): void },
                       system: string, user: string, output?: string, finishReason?: string | null) {
    if (!this.cfg.tracePayloads) return;
    span.setAttribute("gen_ai.system_instructions", clip(JSON.stringify([{ type: "text", content: system }])));
    span.setAttribute("gen_ai.input.messages", clip(JSON.stringify([genAiTextMessage("user", user)])));
    if (output !== undefined) {
      span.setAttribute(
        "gen_ai.output.messages",
        clip(JSON.stringify([genAiTextMessage("assistant", output, finishReason)])),
      );
    }
  }

  private responseAttrs(span: { setAttribute(k: string, v: string | number): void },
                        response: { id?: string; model?: string; finishReason?: string | null }, fallbackModel: string) {
    if (response.id) span.setAttribute("gen_ai.response.id", response.id);
    span.setAttribute("gen_ai.response.model", response.model ?? fallbackModel);
    if (response.finishReason) {
      span.setAttribute("gen_ai.response.finish_reasons", JSON.stringify([response.finishReason]));
      span.setAttribute("cloudflare.agents.response.finish_reason", response.finishReason);
    }
  }

  private usageAttrs(span: { setAttribute(k: string, v: number): void }, usage: ChatUsage | undefined) {
    for (const [key, value] of Object.entries(traceUsageAttributes(usage))) {
      span.setAttribute(key, value);
    }
  }

  private gatewayLogAttr(span: { setAttribute(k: string, v: string): void }, response: Response) {
    const logId = response.headers.get("cf-aig-log-id") ?? response.headers.get("cf-aig-logid");
    if (logId) span.setAttribute("cloudflare.ai_gateway.log.id", logId.slice(0, 256));
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
      this.gatewayLogAttr(span, res);
      const data = (await res.json()) as {
        id?: string;
        model?: string;
        choices?: { finish_reason?: string | null; message?: { content?: string } }[];
        usage?: ChatUsage;
      };
      this.usageAttrs(span, data.usage);
      this.responseAttrs(span, {
        id: data.id,
        model: data.model,
        finishReason: data.choices?.[0]?.finish_reason,
      }, model);
      const text = data.choices?.[0]?.message?.content ?? "";
      this.payloadAttrs(span, system, user, text, data.choices?.[0]?.finish_reason);
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
    this.gatewayLogAttr(span, res);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let responseId: string | undefined;
    let responseModel: string | undefined;
    let finishReason: string | null | undefined;
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
            id?: string;
            model?: string;
            choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
            usage?: ChatUsage;
          };
          responseId ??= chunk.id;
          responseModel ??= chunk.model;
          finishReason ??= chunk.choices?.[0]?.finish_reason ?? undefined;
          this.usageAttrs(span, chunk.usage);
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
    this.responseAttrs(span, { id: responseId, model: responseModel, finishReason }, model);
    this.payloadAttrs(span, system, user, full, finishReason);
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
