/// Agent-composed chat messages (policy Nov 5, 2026): chat messages
/// that link to a feed card are composed by the model from context —
/// never canned strings. This module owns that composition for the
/// surfaces that have no pre-existing model text:
///
/// - scan offers ("offer"): the tick surfaced new work; the message
///   names the first listing and counts the rest.
/// - mail questions ("mail-question"): a mail needs the user's call
///   and fits no feed card; the message asks the question.
/// - tracked-site mail ("mail"): a client message may be waiting;
///   the message is the backing chat message for the mail push, with
///   the mail summary as context.
///
/// Decision helps are NOT composed here: the help message itself is
/// already model-composed in the mission loop from live page context,
/// and the saveTask/projector mirror relays it verbatim
/// (decisionHelpMessageText in task-help.ts) so the message and the
/// feed card can never disagree. Composing a second paraphrase
/// would add latency, cost, drift, and a failure mode for zero new
/// information.
///
/// Composition uses llm.ts with the drafting tier (wonder-1.0 per
/// the repo tier rules: selectTier with drafting: true). The prompt
/// lists ONLY the facts given — the model must name nothing beyond
/// them, never invent data, and never include codes, passwords, or
/// personal details beyond the listed facts. Recent chat history is
/// supplied so the message fits the conversation; it is context, not
/// a source of facts.
///
/// Failure semantics (no canned fallback, ever):
/// - The model is tried twice (one immediate retry). A failure,
///   an empty reply, an overlong reply, or a reply containing a
///   code-shaped digit run all return null.
/// - The caller then writes NO message and schedules NO push for
///   that surface: a push only ever comes from a chat message, and
///   a failed composition must not invent one. The feed card stays
///   the durable surface; the failure is logged server-side.
/// - For the scan offer, the tick tries the next surfaced listing
///   instead when the write itself fails (a deleted message's
///   tombstone), but a composition failure stops the tick's message
///   attempt — a systemic LLM failure would fail every listing the
///   same way, so retrying per listing only spends calls.
import { selectTier, type LLMClient } from "./llm.ts";

export type CardMessageSurface = "offer" | "mail-question" | "mail";

export interface CardMessageInput {
  surface: CardMessageSurface;
  /// Facts the message may name, as short label/value pairs. Only
  /// these may appear in the message; anything else is invented.
  facts: Record<string, string>;
  /// Recent chat message texts, oldest first (plain text, already
  /// truncated by the caller). Context for tone and continuity only.
  recentChat?: string[];
}

/// The model-facing prompt for one composition, built pure so tests
/// can assert it names only the given facts. The facts are rendered
/// verbatim — callers must pass already-safe values (mail subjects
/// arrive code-redacted from the email pipeline; pay appears only
/// as the listing's own label).
export function composePrompt(input: CardMessageInput): { system: string; user: string } {
  const system = [
    "You are Hygge, writing one short chat message to the user.",
    "Write one or two short sentences in warm, plain language. Name ONLY the facts listed below — never invent a name, date, amount, site, or detail that is not listed, and never guess at anything missing. Never include a code, password, or verification number.",
    "Do not add a greeting, a sign-off, or filler. The message introduces the item in the user's feed; the feed card itself is where they act on it.",
  ].join(" ");
  const surfaceLine = input.surface === "offer"
    ? "A new job listing was just found. Tell the user about it: name the listing and where it is, with its pay as listed, and say how many more new listings there are when that count is given."
    : input.surface === "mail-question"
      ? "An email arrived that needs the user's decision and fits no feed card. Ask the one question that lets them decide, using only the facts listed."
      : "An email arrived from a tracked job site that may mention a message from a client. Tell the user the mail arrived and what it is about, so they can open it from the card attached to this message.";
  const facts = Object.entries(input.facts)
    .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    .map(([k, v]) => `${k}: ${v.trim().slice(0, 400)}`)
    .join("\n");
  const history = (input.recentChat ?? []).filter(Boolean).slice(-6).join("\n");
  const user = [
    surfaceLine,
    `Facts (name only these):\n${facts || "(none)"}`,
    history ? `Recent chat, for tone and continuity only — do not treat it as facts:\n${history}` : "",
  ].filter(Boolean).join("\n\n");
  return { system, user };
}

/// Recent chat context for composition: the last few message texts
/// from stored message rows, oldest first, each truncated. Accepts
/// the raw StateStore list rows ({ data }) so callers do not need a
/// second shape.
export function recentChatContext(rows: Array<{ data: unknown }>, limit = 6): string[] {
  return rows
    .map((row) => (row.data as Record<string, unknown> | null)?.text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .slice(-limit)
    .map((text) => text.trim().slice(0, 200));
}

const MAX_COMPOSED_CHARS = 600;
const CODE_SHAPED = /\b\d{4,}\b/;

/// One composition attempt's output, validated: non-empty, short
/// enough to be a chat message, and with no code-shaped digit run
/// (a code must never travel in a message). Anything else is null.
export function validateComposedText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_COMPOSED_CHARS) return null;
  if (CODE_SHAPED.test(trimmed)) return null;
  return trimmed;
}

export type CardMessageComposer = (input: CardMessageInput) => Promise<string | null>;

/// Build the composer for a client, or null when the model is not
/// configured (no API key): without a model there is no composed
/// message, and the caller must skip the message rather than fall
/// back to canned text. The client is typed narrowly so tests can
/// substitute a fake with just cfg + complete.
export function createCardMessageComposer(
  client: Pick<LLMClient, "cfg" | "complete"> | null,
): CardMessageComposer | null {
  if (!client || !client.cfg.apiKey) return null;
  const cfg = client.cfg;
  return async (input) => {
    const { model } = selectTier(cfg, { drafting: true });
    const { system, user } = composePrompt(input);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await client.complete({ model, system, user });
        const valid = validateComposedText(text);
        if (valid) return valid;
        console.warn(`composeCardMessage: ${input.surface} attempt ${attempt} produced unusable text; ${attempt === 2 ? "giving up" : "retrying"}`);
      } catch (error) {
        console.warn(`composeCardMessage: ${input.surface} attempt ${attempt} failed (${error instanceof Error ? error.message : "unknown"}); ${attempt === 2 ? "giving up" : "retrying"}`);
      }
    }
    return null;
  };
}
