/// Browser worker: hands/eyes only — no decisions here.
/// A real isolated Chrome per session via the Browser Run binding
/// (@cloudflare/puppeteer). Sessions live in this user's Durable
/// Object; the mission loop (agent.ts) chooses every action.
import { launch, type Browser, type Page } from "@cloudflare/puppeteer";
import type { SessionState } from "./session-profile.ts";
import { BrowserLive } from "./browser-live.ts";
import { profilePhotoTargetAllowed } from "./profile-photo.ts";

export interface PageElement {
  label: string;
  kind: "type" | "click";
  inputType?: string;
}

export interface Snapshot {
  sessionID: string;
  currentURLString: string;
  title: string;
  elements: PageElement[];
  humanControlled: boolean;
  controlEpoch?: number;
  screenshotBase64: string | null;
}

interface Session {
  id: string;
  browser: Browser;
  page: Page;
  live: BrowserLive;
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
    this.sessions.set(id, { id, browser, page, live });
    browser.once("disconnected", () => {
      live.finish("This browser session has expired. Return to chat to continue.");
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
    const elements = (await page.evaluate(() => {
      const out: PageElement[] = [];
      document
        .querySelectorAll("a,button,input,textarea,select,[role=button]")
        .forEach((el) => {
          const e = el as HTMLInputElement;
          const label = (e.type === "file"
            ? (e.getAttribute("aria-label") || e.labels?.[0]?.textContent || e.name || "file")
            : (e.innerText || e.placeholder || e.name || e.type || "")).trim().slice(0, 60);
          if (label) {
            out.push({
              label,
              kind: el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "type" : "click",
              ...(e.type === "file" ? { inputType: "file" } : {}),
            });
          }
        });
      return out.slice(0, 80);
    })) as PageElement[];
    const shot = (await page.screenshot({ type: "png" })) as unknown as Uint8Array;
    let b64 = "";
    const bytes = new Uint8Array(shot);
    for (let i = 0; i < bytes.length; i += 8192) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return {
      sessionID: id,
      currentURLString: page.url(),
      title: await page.title(),
      elements,
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
    { action, target, value }: { action: string; target?: string; value?: string },
    legacyHuman = false,
  ): Promise<Snapshot | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const page = s.page;
    if (s.live.control.human && !legacyHuman) throw new Error("browser is under human control");
    if (action === "navigate" && value) {
      await page.goto(value, { waitUntil: "domcontentloaded" });
    } else if (action === "setHumanControl") {
      throw new Error("Use the live connection to transfer browser control.");
    } else if (action === "click" && target) {
      const safe = target.replaceAll('"', "'");
      // normalize-space(.) covers labels split across nested spans;
      // text() equality missed them (live: Rover's Sign Up button).
      const exact = await page.$$(`xpath///a[normalize-space(.)="${safe}"] | //button[normalize-space(.)="${safe}"]`);
      const el = exact[0] ?? (await page.$$(`xpath///a[contains(normalize-space(.), "${safe}")] | //button[contains(normalize-space(.), "${safe}")]`))[0];
      if (!el) throw new Error(`element not found: ${target}`);
      const box = await (el as any).boundingBox();
      if (box) s.live.noteAgentPointer(box.x + box.width / 2, box.y + box.height / 2);
      await (el as { click(): Promise<void> }).click();
    } else if (action === "type" && target) {
      const field =
        (await page.$(`input[placeholder*="${target}" i], textarea[placeholder*="${target}" i]`)) ??
        (await page.$(`input[name*="${target.toLowerCase()}" i]`)) ??
        (await page.$("input, textarea"));
      if (!field) throw new Error(`field not found: ${target}`);
      const box = await field.boundingBox();
      if (box) s.live.noteAgentPointer(box.x + box.width / 2, box.y + box.height / 2);
      await field.type(value ?? "");
    }
    return this.snapshot(id);
  }

  /// Resolves the private asset in the worker, never a model-provided URL/path.
  /// A unique observed file field and the approved HTTPS host are both required.
  async uploadProfilePhoto(id: string, target: string, base64: string, approvedURL: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.live.control.human) throw new Error("browser is unavailable for photo attachment");
    if (!profilePhotoTargetAllowed(session.page.url(), approvedURL)) throw new Error("photo target is outside the approved site");
    const host = new URL(approvedURL).hostname.replace(/^www\./, "");
    const attached = await session.page.evaluate(({ target, base64, host }) => {
      if (location.protocol !== "https:" || location.hostname.replace(/^www\./, "") !== host) return false;
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
      const matches = inputs.filter((e) =>
        (e.getAttribute("aria-label") || e.labels?.[0]?.textContent || e.name || "file").trim().slice(0, 60) === target);
      if (matches.length !== 1 || matches[0].disabled) return false;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "profile.jpg", { type: "image/jpeg" }));
      matches[0].files = transfer.files;
      matches[0].dispatchEvent(new Event("input", { bubbles: true }));
      matches[0].dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { target, base64, host });
    if (!attached) throw new Error("a unique photo file input was not found on the approved site");
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
    })) as string[];
  }

  async closeSession(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.live.finish("This browser session has finished.");
    this.sessions.delete(id);
    await s.browser.close().catch(() => {});
    return true;
  }
}
