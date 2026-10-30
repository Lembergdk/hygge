// Model routing + client for the mission-loop agent.
//
// Two tiers, one Meta Model API key (https://dev.meta.ai):
// - muse-spark-1.3  — default per-step decisions in the browsing loop.
// - muse-wonder-1.0 — escalation: repeated failures/deviations, high-stakes
//                     missions (signup/apply/book), drafting user-facing text.
//
// There are no scripts for the models to "follow": every call is one decision
// — given the mission and the current page observation, choose the next
// action. Secrets are never model input (vault placeholders only).
//
// Env: MUSE_LLM_API_KEY (required for live), MUSE_LLM_BASE_URL
// (default https://api.meta.ai/v1), MUSE_SPARK_MODEL, MUSE_WONDER_MODEL.

export const MODELS = {
  spark: () => process.env.MUSE_SPARK_MODEL ?? "muse-spark-1.3",
  wonder: () => process.env.MUSE_WONDER_MODEL ?? "muse-wonder-1.0",
};

export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export function baseURL() {
  return (process.env.MUSE_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}
export function llmConfigured() {
  return Boolean(process.env.MUSE_LLM_API_KEY);
}

const HIGH_STAKES = new Set(["signup", "apply", "bookCalendar"]);

/**
 * Tier for ONE decision in the mission loop.
 * ctx: { taskKind, failures, repeatedAction, isFinalSubmit, drafting }
 */
export function selectTier(ctx) {
  const { taskKind, failures = 0, repeatedAction = false, isFinalSubmit = false, drafting = false } = ctx;
  const pick = (tier, reason) => ({ tier, model: MODELS[tier](), reason });
  if (failures >= 2) return pick("wonder", "repeated failures — escalating to replan");
  if (repeatedAction) return pick("wonder", "agent is looping — escalating to replan");
  if (isFinalSubmit && HIGH_STAKES.has(taskKind)) return pick("wonder", "final submit on a high-stakes mission");
  if (drafting) return pick("wonder", "composing user-facing text");
  if (failures === 1) return pick("wonder", "previous action failed — escalating to replan");
  return pick("spark", "routine browsing decision");
}

export class LLMClient {
  constructor(fetchImpl = fetch) { this.fetch = fetchImpl; }

  async complete({ model, system, user }) {
    const res = await this.fetch(`${baseURL()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MUSE_LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${model} returned ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  /**
   * Stream a completion. onDelta receives raw text fragments as the provider
   * emits them; resolves with the full text. Uses the provider's SSE
   * (stream: true, OpenAI-shaped chunks).
   */
  async completeStream({ model, system, user }, onDelta) {
    const res = await this.fetch(`${baseURL()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MUSE_LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model, stream: true,
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
    let buffer = ""; let full = "";
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
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) { full += delta; onDelta(delta); }
        } catch { /* partial/non-JSON keepalive lines are ignored */ }
      }
    }
    return full;
  }
}

/// Extract the first JSON object from a model reply (tolerates fences/prose).
export function parseDecision(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}
