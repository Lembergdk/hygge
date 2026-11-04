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
  /// Working through a detected site check: bounded, vision-heavy
  /// steps where the stronger model earns its cost.
  checkpointAttempt?: boolean;
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
  if (ctx.checkpointAttempt) return pick("wonder", "working through a site check");
  if (ctx.skillCoverage === "none") return pick("wonder", "no active skill for this site/outcome — Wonder authoring mode");
  if (ctx.skillCoverage === "candidate") return pick("wonder", "skill candidate not yet corroborated — Wonder confirming mode");
  return pick("spark", ctx.skillCoverage === "active" ? "active shared skill loaded" : "routine browsing decision");
}

/// Usage block, both shapes: chat completions (prompt/completion)
/// and the Responses API (input/output). The client moved to the
/// Responses API; the chat-completions fields stay so older gateway
/// payloads and tests keep parsing.
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
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
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (typeof input === "number") attrs["gen_ai.usage.input_tokens"] = input;
  if (typeof output === "number") attrs["gen_ai.usage.output_tokens"] = output;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_token_details?.cached_tokens;
  if (typeof cached === "number") attrs["gen_ai.usage.cache_read.input_tokens"] = cached;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_token_details?.reasoning_tokens;
  if (typeof reasoning === "number") attrs["gen_ai.usage.reasoning.output_tokens"] = reasoning;
  const total = typeof usage.total_tokens === "number"
    ? usage.total_tokens
    : (input ?? 0) + (output ?? 0);
  if (total > 0) attrs["cloudflare.agents.usage.total_tokens"] = total;
  return attrs;
}

/// Preserve HTTP status without logging a provider error body.
function llmHttpError(model: string, status: number): Error & { status: number } {
  const err = new Error(`LLM ${model} returned ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

function assertCompletedResponse(data: { status?: string }): void {
  if (data.status !== "completed") throw new Error(`LLM response did not complete (${data.status ?? "missing status"})`);
}

/// Text of a Responses API response: the message items' output_text
/// parts, in order. Reasoning and other items carry no user-visible
/// text and are skipped. A top-level `output_text` aggregate is the
/// fallback for providers that supply one.
export function extractResponsesText(data: any): string {
  const parts: string[] = [];
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item?.type !== "message") continue;
      for (const part of (item?.content ?? [])) {
        if (part?.type === "output_text" && typeof part?.text === "string") parts.push(part.text);
      }
    }
  }
  if (parts.length) return parts.join("");
  return typeof data?.output_text === "string" ? data.output_text : "";
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

  /** Native conversation turn. Persisted call IDs/results are managed by ChatAgent. */
  async agentTurn(args: { model: string; instructions: string; input: any[]; previousResponseId?: string;
    tools?: any[]; onDelta?: (text: string) => void; onResponseCreated?: (id:string)=>void }): Promise<{ id: string; text: string; calls: Array<{callId:string;name:string;arguments:any}>; inputTokens:number }> {
    return withSpan(`chat ${args.model}`, this.chatAttrs(args.model), async span => {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/responses`, {
        method:'POST', headers:llmRequestHeaders(this.cfg,args.model), signal:AbortSignal.timeout(120000),
        body:JSON.stringify({model:args.model,instructions:args.instructions,input:args.input,store:true,
          ...(args.previousResponseId ? {previous_response_id:args.previousResponseId} : {}),
          ...(args.tools?.length ? {tools:args.tools} : {}),stream:Boolean(args.onDelta)}),
      });
      if(!res.ok) {
        const body:any=await res.json().catch(()=>({}));
        const error=llmHttpError(args.model,res.status) as any;
        // Classify context/expired-chain failures without retaining error payloads.
        const code=String(body?.error?.code??''); const message=String(body?.error?.message??'');
        error.contextExceeded=code==='context_length_exceeded' || /context (?:window|length)|maximum context|too many tokens/i.test(message);
        error.chainExpired=Boolean(args.previousResponseId) && (['response_not_found','previous_response_not_found'].includes(code) || /previous_response_id.*(?:expired|not found)|previous response.*(?:expired|not found)/i.test(message));
        throw error;
      }
      this.gatewayLogAttr(span,res);
      let data:any;
      if(!args.onDelta) data=await res.json();
      else {
        if(!res.body)throw new Error('Missing agent response stream');
        const reader=res.body.getReader(), decoder=new TextDecoder();let buffer='';
        const line=(value:string)=>{
          if(!value.startsWith('data:'))return;
          const raw=value.slice(5).trim();if(!raw||raw==='[DONE]')return;
          const e=JSON.parse(raw);
          if(e.type==='response.created'&&typeof e.response?.id==='string')args.onResponseCreated?.(e.response.id);
          if(e.type==='response.output_text.delta'&&typeof e.delta==='string')args.onDelta!(e.delta);
          if(e.type==='response.completed')data=e.response;
          if(['error','response.failed','response.incomplete','response.cancelled'].includes(e.type))throw new Error('Agent response interrupted');
        };
        try { for(;;){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()??'';lines.forEach(line);}buffer+=decoder.decode();if(buffer.trim())line(buffer); }
        finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      }
      if(!data||data.status!=='completed'||typeof data.id!=='string')throw new Error('Agent response did not complete');
      this.usageAttrs(span,data.usage);
      const calls=(Array.isArray(data.output)?data.output:[]).filter((v:any)=>v.type==='function_call').map((v:any)=>{
        let parsed:any=null;try {parsed=JSON.parse(v.arguments);}catch{}
        if(typeof v.call_id!=='string'||typeof v.name!=='string')throw new Error('Invalid native call identity');
        return {callId:v.call_id,name:v.name,arguments:parsed};
      });
      return {id:data.id,text:extractResponsesText(data),calls,inputTokens:Number(data.usage?.input_tokens??0)};
    });
  }

  async deleteAgentResponse(id:string):Promise<void> {
    const res=await fetch(`${this.cfg.baseUrl.replace(/\/$/,'')}/responses/${encodeURIComponent(id)}`, {
      method:'DELETE',headers:llmRequestHeaders(this.cfg,this.cfg.modelStrong),signal:AbortSignal.timeout(15000)});
    if(res.ok)return;
    const body:any=await res.json().catch(()=>({}));
    if(res.status===404&&(['response_not_found','not_found'].includes(String(body?.error?.code??''))||/response.*(?:deleted|not found)/i.test(String(body?.error?.message??''))))return;
    throw llmHttpError(this.cfg.modelStrong,res.status);
  }

  /// Stateless Responses call. The caller supplies the current snapshot or
  /// canonical app transcript, including actual action outcomes. No provider
  /// conversation state is retained by this transport migration.
  async complete({ model, system, user, conversationId, imageDataURL }: {
    model: string; system: string; user: string; conversationId?: string; imageDataURL?: string;
  }): Promise<string> {
    return withSpan(`chat ${model}`, this.chatAttrs(model, conversationId), async (span) => {
      this.payloadAttrs(span, system, user);
      if (imageDataURL && (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(imageDataURL) || imageDataURL.length > 5_400_000)) throw new Error("Invalid or oversized model image");
      const headers = llmRequestHeaders(this.cfg, model);
      // Images never enter application traces or gateway body logs.
      if (imageDataURL) headers["cf-aig-collect-log-payload"] = "false";
      span.setAttribute("hygge.vision.attached", Boolean(imageDataURL));
      const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/responses`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          instructions: system,
          input: imageDataURL
            ? [{ role: "user", content: [{ type: "input_text", text: user }, { type: "input_image", image_url: imageDataURL }] }]
            : user,
          store: false,
        }),
      });
      if (!res.ok) throw llmHttpError(model, res.status);
      this.gatewayLogAttr(span, res);
      const data = (await res.json()) as {
        id?: string;
        model?: string;
        status?: string;
        output?: unknown;
        output_text?: unknown;
        usage?: ChatUsage;
      };
      this.usageAttrs(span, data.usage);
      this.responseAttrs(span, {
        id: data.id,
        model: data.model,
        finishReason: data.status ?? null,
      }, model);
      assertCompletedResponse(data);
      const text = extractResponsesText(data);
      this.payloadAttrs(span, system, user, text, data.status ?? null);
      return text;
    });
  }

  /// Stream only completed Responses. HTTP 200 is not sufficient: a
  /// failed/incomplete terminal event or an interrupted stream is a failure.
  async completeStream(
    { model, system, user, conversationId }: { model: string; system: string; user: string; conversationId?: string },
    onDelta: (delta: string) => void,
  ): Promise<string> {
    return withSpan(`chat ${model}`, this.chatAttrs(model, conversationId), async (span) => {
    this.payloadAttrs(span, system, user);
    const headers = llmRequestHeaders(this.cfg, model);
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/responses`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        instructions: system,
        input: user,
        stream: true,
        store: false,
      }),
    });
    if (!res.ok) throw llmHttpError(model, res.status);
    if (!res.body) throw new Error("LLM stream had no body");
    this.gatewayLogAttr(span, res);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let responseId: string | undefined;
    let responseModel: string | undefined;
    let finishReason: string | null | undefined;
    let completed = false;
    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]" || !data) return;
      let event: any;
      try { event = JSON.parse(data); } catch { throw new Error("Invalid LLM stream event"); }
      if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
        full += event.delta;
        if (event.delta) onDelta(event.delta);
      } else if (event?.type === "response.created" && event.response?.id) {
        responseId ??= event.response.id;
      } else if (event?.type === "response.completed" && event.response) {
        assertCompletedResponse(event.response);
        completed = true;
        responseId = event.response.id ?? responseId;
        responseModel = event.response.model;
        finishReason = event.response.status;
        this.usageAttrs(span, event.response.usage);
      } else if (["error", "response.failed", "response.incomplete", "response.cancelled"].includes(event?.type)) {
        // Provider details may contain request data; keep errors metadata-only.
        throw new Error(`LLM stream did not complete (${event.type})`);
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);
      if (!completed) throw new Error("LLM stream ended before completion");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
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
