/// Model routing + client for the mission-loop agent.
/// muse-spark-1.3 for routine per-step decisions; muse-wonder-1.0
/// for escalation (failures, loops, high-stakes final submits,
/// drafting user-facing text). Secrets are never model input.

export interface LLMConfig {
  apiKey?: string;
  baseUrl: string;
  modelFast: string;
  modelStrong: string;
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

  async complete({ model, system, user }: { model: string; system: string; user: string }): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${model} returned ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async completeStream(
    { model, system, user }: { model: string; system: string; user: string },
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
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
          const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
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
    return full;
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
