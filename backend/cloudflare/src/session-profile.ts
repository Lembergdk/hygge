/// Trusted ("remember this device") session profiles + human-checkpoint
/// detection. Pure logic, unit-tested in test/session-profile.mts.
///
/// A session profile is the browser state (cookies + same-origin
/// localStorage) captured after a successful login so the next mission
/// on that domain can skip the login form where the site permits.
/// Profiles are sealed with the user's vault DEK before storage
/// (R2 BROWSER_PROFILES, falling back to Durable Object storage):
/// cookies are credentials and get the same treatment as passwords —
/// never in prompts, logs, or API responses. Only metadata
/// (domain, trustSupport, hasProfile, updatedAt) ever leaves.
import * as vault from "./vault.ts";
import type { Snapshot } from "./browser.ts";

export type TrustSupport = "supported" | "unsupported" | "unknown";

export interface SessionState {
  cookies: unknown[];
  localStorage: Record<string, string>;
  origin: string;
  savedAt: string;
}

export interface SessionProfileMeta {
  domain: string;
  trustSupport: TrustSupport;
  hasProfile: boolean;
  updatedAt: string | null;
}

export function profileAAD(domain: string): string {
  return `session-profile\n${domain}`;
}

export async function sealSessionState(
  dek: CryptoKey,
  domain: string,
  state: SessionState,
): Promise<vault.VaultBlob> {
  return vault.seal(dek, JSON.stringify(state), profileAAD(domain));
}

export async function openSessionState(
  dek: CryptoKey,
  domain: string,
  blob: vault.VaultBlob,
): Promise<SessionState> {
  const parsed = JSON.parse(await vault.open(dek, blob, profileAAD(domain)));
  return {
    cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
    localStorage: parsed.localStorage ?? {},
    origin: String(parsed.origin ?? ""),
    savedAt: String(parsed.savedAt ?? ""),
  };
}

export function isEmptyState(state: SessionState | null | undefined): boolean {
  if (!state) return true;
  return state.cookies.length === 0 && Object.keys(state.localStorage).length === 0;
}

/// --- human checkpoints -------------------------------------------------
/// Server-side guard, checked before the model may act on a page. A hit
/// pauses the mission as needsHuman with the session kept open. There
/// is deliberately no code path that clicks/types through/around these.
const CHECKPOINT_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /re?captcha|hcaptcha|turnstile/i, why: "CAPTCHA check" },
  { pattern: /are you (a )?(robot|human)|prove you('| a)re (human|not a robot)|not a robot|human verification/i, why: "bot check" },
  { pattern: /two[- ]factor|\b2fa\b|authenticator (app|code)|one[- ]time (code|passcode)|verification code|enter (the )?\d? ?code (we|sent)|check your (phone|email|authenticator)/i, why: "two-factor check" },
  // No bare "background check": gig homepages advertise background-
  // checked workers in ordinary marketing copy (Rover's fired this
  // guard on its front page). The check must be demanded of the
  // visitor, in action language, to pause a mission.
  { pattern: /verify your identity|identity verification|government[- ]issued id|photo id check|complete (a |your )?background check|background check (is )?required|submit to a background check|pass a background check to/i, why: "identity check" },
  { pattern: /security check|unusual (sign[- ]?in|activity)/i, why: "security check" },
];

export function detectCheckpoint(snapshot: Snapshot): string | null {
  const haystack = [
    snapshot.title ?? "",
    snapshot.currentURLString ?? "",
    ...(snapshot.elements ?? []).map((e) => e.label),
  ].join("\n");
  for (const { pattern, why } of CHECKPOINT_PATTERNS) {
    if (pattern.test(haystack)) return why;
  }
  return null;
}

/// --- session health probe ----------------------------------------------
/// Cheap post-restore check. "unauthenticated" only when the page
/// clearly shows a login form; "authenticated" only on a clear
/// signed-in marker; otherwise "unknown" — attempt the mission and
/// let the login path engage on auth failure (brief default probe).
export type ProbeResult = "authenticated" | "unauthenticated" | "unknown";

export function probeAuthenticated(snapshot: Snapshot): ProbeResult {
  const labels = (snapshot.elements ?? []).map((e) => e.label.toLowerCase());
  const hasPasswordField = (snapshot.elements ?? []).some(
    (e) => e.kind === "type" && /password/.test(e.label.toLowerCase()),
  );
  if (hasPasswordField) return "unauthenticated";
  const signedIn = labels.some((l) =>
    /log ?out|sign ?out|my account|account settings|dashboard|your profile|edit profile/.test(l),
  );
  if (signedIn) return "authenticated";
  return "unknown";
}

/// --- trust flag learning ------------------------------------------------
export type TrustEvent =
  | "probePassed"
  | "probeFailed"
  | "loginSavedState"
  | "loginSavedNothing";

export function nextTrustSupport(current: TrustSupport, event: TrustEvent): TrustSupport {
  switch (event) {
    case "probePassed":
      return "supported"; // the site demonstrably honoured the trusted sign-in
    case "loginSavedNothing":
      return "unsupported"; // logged in, but the site left nothing reusable
    case "probeFailed":
      // One expired sign-in says nothing about support; keep learning.
      return current === "supported" ? "supported" : current;
    case "loginSavedState":
      return current; // promising, unproven until a restore passes the probe
  }
}

export function isRememberMeLabel(label: string): boolean {
  return /remember me|remember this device|trust this device|stay signed in|keep me (signed|logged) in/i.test(label);
}
