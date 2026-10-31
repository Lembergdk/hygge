/// Browser worker: hands/eyes only — no decisions here.
/// A real isolated Chrome per session via the Browser Run binding
/// (@cloudflare/puppeteer). Sessions live in this user's Durable
/// Object; the mission loop (agent.ts) chooses every action.
import { launch, type Browser, type Page } from "@cloudflare/puppeteer";

export interface PageElement {
  label: string;
  kind: "type" | "click";
}

export interface Snapshot {
  sessionID: string;
  currentURLString: string;
  title: string;
  elements: PageElement[];
  humanControlled: boolean;
  screenshotBase64: string | null;
}

interface Session {
  id: string;
  browser: Browser;
  page: Page;
  humanControlled: boolean;
}

export class BrowserRunBrowser {
  mode = "browser-run";
  private sessions = new Map<string, Session>();

  binding: Fetcher;
  constructor(binding: Fetcher) { this.binding = binding; }

  async createSession(url: string): Promise<Snapshot> {
    const browser = await launch(this.binding);
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const id = crypto.randomUUID();
    this.sessions.set(id, { id, browser, page, humanControlled: false });
    return this.snapshot(id) as Promise<Snapshot>;
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
          const label = (e.innerText || e.placeholder || e.name || e.type || "").trim().slice(0, 60);
          if (label) {
            out.push({
              label,
              kind: el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "type" : "click",
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
      humanControlled: s.humanControlled,
      screenshotBase64: btoa(b64),
    };
  }

  async act(
    id: string,
    { action, target, value }: { action: string; target?: string; value?: string },
  ): Promise<Snapshot | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const page = s.page;
    if (action === "navigate" && value) {
      await page.goto(value, { waitUntil: "domcontentloaded" });
    } else if (action === "setHumanControl") {
      s.humanControlled = value === "true";
    } else if (action === "click" && target) {
      const safe = target.replaceAll('"', "'");
      const exact = await page.$$(`xpath///a[normalize-space(text())="${safe}"] | //button[normalize-space(text())="${safe}"]`);
      const el = exact[0] ?? (await page.$$(`xpath///a[contains(normalize-space(text()), "${safe}")] | //button[contains(normalize-space(text()), "${safe}")]`))[0];
      if (!el) throw new Error(`element not found: ${target}`);
      await (el as { click(): Promise<void> }).click();
    } else if (action === "type" && target) {
      const field =
        (await page.$(`input[placeholder*="${target}" i], textarea[placeholder*="${target}" i]`)) ??
        (await page.$(`input[name*="${target.toLowerCase()}" i]`)) ??
        (await page.$("input, textarea"));
      if (!field) throw new Error(`field not found: ${target}`);
      await field.type(value ?? "");
    }
    return this.snapshot(id);
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
    await s.browser.close().catch(() => {});
    return this.sessions.delete(id);
  }
}
