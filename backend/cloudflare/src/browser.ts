/// Browser worker: hands/eyes only — no decisions here.
/// A real isolated Chrome per session via the Browser Run binding
/// (@cloudflare/puppeteer). Sessions live in this user's Durable
/// Object; the mission loop (agent.ts) chooses every action.
import { launch, type Browser, type Page } from "@cloudflare/puppeteer";
import type { SessionState } from "./session-profile.ts";
import { BrowserLive } from "./browser-live.ts";
import { BrowserObservation, OBSERVATION_LIMITS, sensitiveElement, redact, type ObservedElement } from "./browser-observation.ts";
import { profilePhotoTargetAllowed } from "./profile-photo.ts";

export interface PageElement extends ObservedElement {}

export interface Snapshot {
  sessionID: string;
  currentURLString: string;
  title: string;
  elements: PageElement[];
  humanControlled: boolean;
  controlEpoch?: number;
  screenshotBase64: string | null;
  notices?: string[];
  pageText?: { url: string; text: string }[];
  accessibility?: { role: string; name: string }[];
  scroll?: { x: number; y: number; width: number; height: number; pageHeight: number };
  observationTruncated?: boolean;
  visionSafe?: boolean;
}

interface Session {
  id: string;
  browser: Browser;
  page: Page;
  live: BrowserLive;
  observation: BrowserObservation;
}

export class BrowserRunBrowser {
  mode = "browser-run";
  private sessions = new Map<string, Session>();

  binding: Fetcher;
  constructor(binding: Fetcher) { this.binding = binding; }

  /// Open a session, optionally restoring a saved trusted sign-in
  /// (cookies before navigation, same-origin localStorage after).
  /// Restore is best-effort: a site that rejects the state simply
  /// shows its login form and the mission re-logs in via the vault.
  async createSession(url: string, restore?: SessionState | null): Promise<Snapshot> {
    const browser = await launch(this.binding, { keep_alive: 600_000 });
    const page = await browser.newPage();
    // Experience parity with an end user's browser: no safe-mode
    // restrictions are imposed anywhere (JavaScript and cookies
    // stay enabled, nothing is content-blocked), the viewport is
    // a normal laptop size instead of the 800x600 automation
    // default, and the UA keeps the real engine/platform/version
    // minus the "Headless" token. Datacenter egress and a fresh
    // profile per session remain inherent to server-side
    // browsing; the user's saved sign-in restores on top below.
    await page.setJavaScriptEnabled(true).catch(() => {});
    await page.setViewport({ width: 1365, height: 900 }).catch(() => {});
    try {
      const ua = (await page.evaluate(() => navigator.userAgent)) as unknown as string;
      if (ua.includes("HeadlessChrome")) {
        const clean = ua.replace("HeadlessChrome", "Chrome");
        // Browser Run ignores puppeteer's setUserAgent; the CDP
        // emulation override is what sticks (header + JS alike).
        let applied = false;
        try {
          const cdp = await (page as any).createCDPSession();
          await cdp.send("Emulation.setUserAgentOverride", { userAgent: clean });
          applied = true;
        } catch { /* fall through */ }
        if (!applied) {
          try { await page.setUserAgent(clean); } catch { /* header below still applies */ }
        }
        // Browser Run may silently ignore both overrides above at
        // the JS level; the header override always reaches servers.
        await page.setExtraHTTPHeaders({ "User-Agent": clean }).catch(() => {});
      }
    } catch { /* keep the default UA */ }
    if (restore?.cookies?.length) {
      await (page as Page).setCookie(...(restore.cookies as never[])).catch(() => {});
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (restore && Object.keys(restore.localStorage).length) {
      await page
        .evaluate((items: Record<string, string>) => {
          for (const [k, v] of Object.entries(items)) {
            try { window.localStorage.setItem(k, v); } catch { /* storage blocked */ }
          }
        }, restore.localStorage)
        .catch(() => {});
    }
    const id = crypto.randomUUID();
    const live = new BrowserLive(page);
    const observation = new BrowserObservation();
    this.sessions.set(id, { id, browser, page, live, observation });
    browser.once("disconnected", () => {
      live.finish("This browser session has expired. Return to chat to continue.");
      void observation.close();
      this.sessions.delete(id);
    });
    return this.snapshot(id) as Promise<Snapshot>;
  }

  hasSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (!session.browser.connected || session.page.isClosed() || session.live.ended) {
      session.live.finish("This browser session has ended. Return to chat to continue.");
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  controlState(id: string) { return this.hasSession(id) ? this.sessions.get(id)?.live.control : undefined; }

  async agentStep<T>(id: string, epoch: number, operation: () => Promise<T>): Promise<T> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("session ended");
    return s.live.control.agent(epoch, operation);
  }

  async stream(id: string, onResume: () => Promise<(() => void) | void>): Promise<Response> {
    const s = this.sessions.get(id);
    if (!s || !this.hasSession(id)) return new Response("Session ended", { status: 410 });
    const pair = new WebSocketPair();
    pair[1].accept();
    void s.live.connect(pair[1], onResume);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /// Capture the reusable sign-in state of a live session. The caller
  /// seals this with the user's vault key before storing it anywhere.
  async exportState(id: string): Promise<SessionState | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const cookies = (await s.page.cookies().catch(() => [])) as unknown[];
    const localStorage = (await s.page
      .evaluate(() => {
        const out: Record<string, string> = {};
        try {
          for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (k) out[k] = window.localStorage.getItem(k) ?? "";
          }
        } catch { /* storage blocked */ }
        return out;
      })
      .catch(() => ({}))) as Record<string, string>;
    return {
      cookies,
      localStorage,
      origin: (() => { try { return new URL(s.page.url()).origin; } catch { return ""; } })(),
      savedAt: new Date().toISOString(),
    };
  }

  async snapshot(id: string): Promise<Snapshot | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const page = s.page;
    const observation = await s.observation.capture(page);
    const shot = (await page.screenshot({ type: "png" })) as unknown as Uint8Array;
    let b64 = "";
    const bytes = new Uint8Array(shot);
    for (let i = 0; i < bytes.length; i += 8192) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return {
      sessionID: id,
      currentURLString: page.url(),
      title: redact(await page.title(), s.observation.secrets),
      ...observation,
      visionSafe: observation.visionSafe && !s.live.control.human && bytes.length <= OBSERVATION_LIMITS.imageBytes,
      humanControlled: s.live.control.human,
      controlEpoch: s.live.control.epoch,
      screenshotBase64: btoa(b64),
    };
  }

  // Compatibility for already-installed clients; still serialized against agent input.
  async legacyAct(id: string, body: { action: string; target?: string; value?: string }): Promise<Snapshot | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (body.action === "setHumanControl") {
      if (body.value === "true") await s.live.control.acquire("legacy-app");
      else await s.live.control.release("legacy-app");
      s.live.broadcast();
      return this.snapshot(id);
    }
    return s.live.control.input("legacy-app", () => this.act(id, body, true));
  }

  async act(
    id: string,
    { action, target, value, sensitive = false }: { action: string; target?: string; value?: string; sensitive?: boolean },
    legacyHuman = false,
  ): Promise<Snapshot | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const page = s.page;
    if (s.live.control.human && !legacyHuman) throw new Error("browser is under human control");
    if (action === "navigate" && value) {
      const destination = new URL(value, page.url());
      if (!["https:", "http:"].includes(destination.protocol)) throw new Error("Only HTTP(S) navigation is supported");
      await page.goto(destination.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    } else if (action === "back" || action === "forward") {
      await (action === "back" ? page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }) : page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 }));
    } else if (action === "wait") {
      const duration = Number(value || "500");
      if (!Number.isFinite(duration) || duration < 100 || duration > 2000) throw new Error("Wait must be between 100 and 2000 milliseconds");
      await new Promise(resolve => setTimeout(resolve, duration));
    } else if (action === "scroll") {
      if (!["up", "down"].includes(value ?? "")) throw new Error("Scroll direction must be up or down");
      await page.evaluate(direction => window.scrollBy(0, (direction === "down" ? 1 : -1) * window.innerHeight * 0.8), value!);
    } else if (["click", "type", "select", "check", "press", "hover"].includes(action) && target) {
      const resolved = await s.observation.resolve(target, action);
      const field = resolved.handle;
      try {
        const box = await field.boundingBox();
        if (box) s.live.noteAgentPointer(box.x + box.width / 2, box.y + box.height / 2);
        if (sensitive || sensitiveElement(resolved.element)) {
          if (value) s.observation.secrets.add(value);
        }
        if (sensitive && new URL(resolved.frame.url()).origin !== new URL(page.url()).origin) {
          throw new Error("Private values cannot be entered in a different-origin frame");
        }
        if (action === "click") await field.click();
        if (action === "hover") await field.hover();
        if (action === "type") {
          // Replace rather than append; never fall back to the first input.
          await field.focus();
          await field.evaluate((el: any) => {
            if (el.readOnly) throw new Error("This field is read-only");
            if (el.isContentEditable) {
              const range = document.createRange(); range.selectNodeContents(el);
              const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
            } else {
              // Native setters also notify controlled inputs when followed by
              // an input event; unlike shortcut keys this works cross-platform.
              const prototype = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, "");
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
          });
          await field.press("Backspace");
          await field.type(value ?? "");
        }
        if (action === "select") {
          if (!resolved.element.options?.some((o: { value: string }) => o.value === value)) throw new Error("Choose an observed option value");
          await field.select(value!);
        }
        if (action === "check") {
          if (!["checkbox", "radio"].includes(resolved.element.role ?? "") || !["true", "false"].includes(value ?? "")) throw new Error("Check requires a checkbox/radio and true or false");
          if (resolved.element.role === "radio" && value === "false") throw new Error("Select another radio option instead");
          if (resolved.element.checked !== (value === "true")) await field.click();
        }
        if (action === "press") {
          if (!["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(value ?? "")) throw new Error("Unsupported key");
          await field.press(value === "Space" ? " " : value);
        }
      } finally { await field.dispose(); }
    } else { throw new Error("Unsupported browser action or missing target"); }
    return this.snapshot(id);
  }

  /// Resolves the private asset in the worker, never a model-provided URL/path.
  /// A unique observed file field and the approved HTTPS host are both required.
  async uploadProfilePhoto(id: string, target: string, base64: string, approvedURL: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.live.control.human) throw new Error("browser is unavailable for photo attachment");
    if (!profilePhotoTargetAllowed(session.page.url(), approvedURL)) throw new Error("photo target is outside the approved site");
    const resolved = await session.observation.resolve(target, "upload");
    try {
      if (resolved.element.inputType !== "file" || !profilePhotoTargetAllowed(resolved.frame.url(), approvedURL)) throw new Error("A photo file input on the approved site is required");
      const attached = await resolved.handle.evaluate((input: HTMLInputElement, base64: string) => {
        if (!input.isConnected || input.disabled || input.type !== "file") return false;
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "profile.jpg", { type: "image/jpeg" }));
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, base64);
      if (!attached) throw new Error("The photo file input changed; observe again");
    } finally { await resolved.handle.dispose(); }
  }

  async extract(id: string): Promise<string[]> {
    const s = this.sessions.get(id);
    if (!s) return [];
    return (await s.page.evaluate(() => {
      const DENY = /post a job|go premium|join now|sign (up|in)|log ?in|hire freelance|pricing|menu/i;
      const STRONG = /\/(remote-jobs?|jobs?|position|posting|gigs?|tasks?|listing|opportunit)/i;
      const seen = new Set<string>();
      const strong: string[] = [];
      const weak: string[] = [];
      document.querySelectorAll("a").forEach((a) => {
        const text = (a.innerText || "").trim().replace(/\s+/g, " ").slice(0, 110);
        const href = a.href || "";
        if (text.length < 10 || seen.has(text) || DENY.test(text)) return;
        if (STRONG.test(href)) {
          seen.add(text);
          strong.push(text);
        } else if (/job|task|gig|listing|position/i.test(href + " " + text)) {
          seen.add(text);
          weak.push(text);
        }
      });
      return [...strong, ...weak].slice(0, 8);
    }) as string[]).map(item => redact(item, s.observation.secrets));
  }

  async closeSession(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.live.finish("This browser session has finished.");
    this.sessions.delete(id);
    await s.observation.close();
    await s.browser.close().catch(() => {});
    return true;
  }
}
