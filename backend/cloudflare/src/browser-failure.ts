// Only allowlisted facts leave the error boundary. Never copy exception messages,
// URLs, selectors, input values or provider response bodies into traces or chat.
const descriptions = {
  target_missing: ["The requested control was missing or ambiguous.", "Observe again and choose an available element reference.", "I couldn't find the control needed for this step."],
  target_changed: ["The page changed before the action could run.", "Observe the current page and choose a fresh reference.", "The page changed before I could finish this step."],
  target_disabled: ["The requested control is unavailable.", "Check required fields and page notices; do not repeat the disabled action.", "The site wouldn't let me use the control needed for this step."],
  invalid_action: ["The requested action did not match the browser tool contract.", "Correct the action arguments. Navigation requires an HTTP(S) URL in value.", "I couldn't complete this step with the browser controls."],
  session_ended: ["The browser session is no longer available.", "Open a new session, inspect signed-in state and verify prior effects before continuing.", "The browser session ended before this step was finished."],
  timeout: ["The browser operation timed out; its effect is unconfirmed.", "Inspect the page before retrying. The previous action may have taken effect.", "The site took too long to respond, so I couldn't confirm whether this step finished."],
  navigation_failed: ["The requested page could not be loaded.", "Inspect the current page and use another observed route if available.", "I couldn't load the page needed to continue."],
  repeated_action: ["The same action was repeated without verified progress.", "Inspect the current state and choose a different route; do not replay the failed sequence.", "I kept reaching the same step without making progress, so I stopped."],
  step_limit: ["The attempt reached its step limit without verified completion.", "Inspect the current state before continuing; never assume the mission completed.", "I reached the limit for this attempt before I could confirm it was finished."],
  model_unavailable: ["No usable browser decision was available.", "Inspect the page again before choosing the next action.", "I couldn't work out the next browser step, so I stopped."],
  unknown: ["The browser action failed; its effect is unconfirmed.", "Inspect the current page before retrying; do not assume no change occurred.", "Something interrupted this step, and I couldn't confirm whether it finished."],
} as const;
export type FailureCode = keyof typeof descriptions;
export function failureFeedback(code: string = "unknown") {
  const key: FailureCode = Object.hasOwn(descriptions, code) ? code as FailureCode : "unknown";
  const [summary, nextStep, userMessage] = descriptions[key];
  return { code: key, summary, nextStep, userMessage, outcome: "unconfirmed" as const };
}
export function classifyBrowserFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const code: FailureCode = /session ended|session closed|target closed|connection closed|browser has disconnected/i.test(message) ? "session_ended"
    : /timeout|timed out/i.test(message) ? "timeout"
    : /missing or ambiguous/i.test(message) ? "target_missing"
    : /stale element|element changed|input changed/i.test(message) ? "target_changed"
    : /disabled|read-only/i.test(message) ? "target_disabled"
    : /unsupported|missing target|only HTTP|invalid URL|requires|must be|observed option|not an editable/i.test(message) ? "invalid_action"
    : /net::ERR_|navigation failed/i.test(message) ? "navigation_failed" : "unknown";
  return failureFeedback(code);
}
