// Browser workers behind one interface (hands/eyes only — no decisions here):
//   createSession(url), snapshot(id), act(id, action), extract(id), closeSession(id)
// All choosing-what-to-do-next lives in agent.mjs's mission loop.
//
// Modes (HYGGE_BROWSER):
// - "cloudflare": a real isolated Chrome per session via Cloudflare Browser
//   Run's CDP endpoint, driven with Playwright/Puppeteer `connectOverCDP` /
//   `connect`. Needs CF_ACCOUNT_ID + CF_API_TOKEN and the `playwright-core`
//   package (`npm i playwright-core`). Endpoint per Cloudflare docs:
//   wss://api.cloudflare.com/client/v4/accounts/{id}/browser-rendering/devtools/browser?keep_alive=600000
// - "simulated" (default): deterministic fake page model so the whole product
//   contract (sessions, takeover, skills, vault injection) is testable offline.
import { randomUUID } from "node:crypto";

function genericElements(url) {
  return [
    { label: "Log in / Sign in", kind: "click" },
    { label: "Sign up / Join", kind: "click" },
    { label: "Search field", kind: "type" },
    { label: "Search button", kind: "click" },
    { label: "First listing card", kind: "click" },
    { label: "Apply / Contact", kind: "click" },
    { label: "Message / cover letter field", kind: "type" },
  ];
}

export class SimulatedBrowser {
  constructor() { this.sessions = new Map(); this.mode = "simulated"; }

  async createSession(url) {
    const id = randomUUID();
    const session = { id, url, title: `Simulated page: ${url}`, humanControlled: false,
                      elements: genericElements(url), history: [] };
    this.sessions.set(id, session);
    return this.snapshot(id);
  }

  snapshot(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return { sessionID: s.id, currentURLString: s.url, title: s.title,
             elements: s.elements, humanControlled: s.humanControlled,
             screenshotBase64: null };
  }

  async act(id, { action, target, value }) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.history.push({ action, target: target ?? "", at: new Date().toISOString() });
    if (action === "navigate" && value) s.url = value;
    if (action === "setHumanControl") s.humanControlled = value === "true";
    // Tiny stateful page model so the mission loop observes real consequences:
    // clicking things changes what the next snapshot contains.
    const t = (target ?? "").toLowerCase();
    if (action === "click" && t.includes("log in / sign in")) {
      s.elements = [
        { label: "Email or username field", kind: "type" },
        { label: "Password field", kind: "type" },
        { label: "Log in button", kind: "click" },
      ];
    } else if (action === "click" && (t.includes("sign up / join") || t === "sign up")) {
      s.elements = [
        { label: "Full name field", kind: "type" },
        { label: "Email field", kind: "type" },
        { label: "Password field", kind: "type" },
        { label: "Phone number field", kind: "type" },
        { label: "Date of birth field", kind: "type" },
        { label: "Create account", kind: "click" },
      ];
    } else if (action === "click" && t.includes("create account")) {
      s.elements = [
        { label: "Welcome — build your profile", kind: "click" },
        { label: "Message / cover letter field", kind: "type" },
      ];
    } else if (action === "click" && t.includes("log in button")) {
      s.elements = genericElements(s.url).filter((e) => !/log in/i.test(e.label));
    } else if (action === "click" && t.includes("first listing")) {
      s.elements = [
        { label: "Listing details (simulated)", kind: "click" },
        { label: "Apply / Contact", kind: "click" },
      ];
    } else if (action === "click" && t.includes("apply / contact")) {
      s.elements = [
        { label: "Message / cover letter field", kind: "type" },
        { label: "Submit application", kind: "click" },
      ];
    }
    return this.snapshot(id);
  }

  async extract(id) {
    if (!this.sessions.get(id)) return [];
    return ["Weekend dog sitting — $45/night (simulated page)",
            "Video editor wanted — $30/hr remote (simulated page)"];
  }

  async closeSession(id) { return this.sessions.delete(id); }
}

export class CloudflareBrowser {
  constructor() { this.mode = "cloudflare"; this.sessions = new Map(); }

  endpoint() {
    const account = process.env.CF_ACCOUNT_ID;
    if (!account || !process.env.CF_API_TOKEN) {
      throw new Error("Set CF_ACCOUNT_ID and CF_API_TOKEN for Cloudflare Browser Run");
    }
    return `wss://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/devtools/browser?keep_alive=600000`;
  }

  async #page(session) { return session.page; }

  async createSession(url) {
    let chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      throw new Error("Install playwright-core (npm i playwright-core) or use HYGGE_BROWSER=simulated");
    }
    const browser = await chromium.connectOverCDP(this.endpoint(), {
      headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const id = randomUUID();
    this.sessions.set(id, { id, browser, page, humanControlled: false });
    return this.snapshot(id);
  }

  async snapshot(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const page = await this.#page(s);
    const elements = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("a,button,input,textarea,select,[role=button]").forEach((el) => {
        const label = (el.innerText || el.placeholder || el.name || el.type || "").trim().slice(0, 60);
        if (label) out.push({ label, kind: el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "type" : "click" });
      });
      return out.slice(0, 80);
    });
    const shot = await page.screenshot({ type: "png" });
    return { sessionID: id, currentURLString: page.url(), title: await page.title(),
             elements, humanControlled: s.humanControlled,
             screenshotBase64: shot.toString("base64") };
  }

  async act(id, { action, target, value }) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const page = await this.#page(s);
    if (action === "navigate" && value) await page.goto(value, { waitUntil: "domcontentloaded" });
    else if (action === "setHumanControl") s.humanControlled = value === "true";
    else if (action === "click" && target) await page.getByText(target, { exact: false }).first().click({ timeout: 5000 });
    else if (action === "type" && target) {
      const field = page.getByPlaceholder(target).or(page.getByLabel(target)).first();
      await field.fill(value ?? "", { timeout: 5000 });
    }
    return this.snapshot(id);
  }

  async closeSession(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.browser.close().catch(() => {});
    return this.sessions.delete(id);
  }

  async extract(id) {
    const s = this.sessions.get(id);
    if (!s) return [];
    const page = await this.#page(s);
    return page.evaluate(() => {
      const DENY = /post a job|go premium|join now|sign (up|in)|log ?in|hire freelance|pricing|menu/i;
      const STRONG = /\/(remote-jobs?|jobs?|position|posting|gigs?|tasks?|listing|opportunit)/i;
      const seen = new Set(); const strong = []; const weak = [];
      document.querySelectorAll("a").forEach((a) => {
        const text = (a.innerText || "").trim().replace(/\s+/g, " ").slice(0, 110);
        const href = a.href || "";
        if (text.length < 10 || seen.has(text) || DENY.test(text)) return;
        if (STRONG.test(href)) { seen.add(text); strong.push(text); }
        else if (/job|task|gig|listing|position/i.test(href + " " + text)) { seen.add(text); weak.push(text); }
      });
      return [...strong, ...weak].slice(0, 8);
    });
  }
}

export function makeBrowser() {
  return process.env.HYGGE_BROWSER === "cloudflare" ? new CloudflareBrowser() : new SimulatedBrowser();
}
