/** Per-session, live-document element references. Page content is untrusted data. */
export interface ObservedElement {
  ref?: string;
  label: string;
  kind: "type" | "click";
  role?: string;
  inputType?: string;
  sensitive?: boolean;
  disabled?: boolean;
  checked?: boolean;
  expanded?: string | null;
  description?: string;
  required?: boolean;
  invalid?: string | null;
  href?: string;
  options?: { label: string; value: string; selected: boolean }[];
  frameURL?: string;
}
export const OBSERVATION_LIMITS = { elements: 160, frames: 8, text: 12000, axNodes: 160, imageBytes: 4_000_000 };
const PRIVATE = /password|passcode|one.?time|verification.?code|security.?code|\botp\b|\bcvv\b|secret|token/i;
export function sensitiveElement(element: ObservedElement | undefined): boolean {
  return !!element && (element.sensitive === true || PRIVATE.test(`${element.label} ${element.inputType ?? ""}`));
}
export function redact(value: string, secrets: Iterable<string>): string {
  for (const secret of secrets) if (secret) value = value.split(secret).join("[redacted]");
  return value;
}
export function safePageURL(value: string): string {
  try {
    const url = new URL(value); url.username = ""; url.password = "";
    for (const key of [...url.searchParams.keys()]) if (/token|secret|password|code|key|auth/i.test(key)) url.searchParams.set(key, "[redacted]");
    if (/token|secret|password|code|auth/i.test(url.hash)) url.hash = "[redacted]";
    return url.href;
  } catch { return ""; }
}
export function elementSignature(element: ObservedElement): string {
  const { ref, frameURL, ...semantics } = element;
  return JSON.stringify(semantics);
}

// Runs inside each frame, including open shadow roots. Values of editable
// controls are deliberately never returned. References survive observations,
// but not replacement of their DOM nodes or navigation to a new document.
export function inspectDocument(args: { key: string; frameID: string; limit: number; secrets: string[]; documentID: string }) {
  const win = window as any;
  let registry = win[args.key];
  if (!registry) {
    registry = { ids: new WeakMap(), nodes: new Map(), next: 0, documentID: args.documentID };
    Object.defineProperty(win, args.key, { value: registry, configurable: true });
  }
  for (const [id, node] of registry.nodes) if (!node.isConnected) registry.nodes.delete(id);
  const all: Element[] = [];
  // Object methods remain self-contained when Wrangler preserves function
  // names; standalone nested arrows would capture its external __name helper.
  const helpers = {
    visible(el: Element) {
      const style = getComputedStyle(el); const box = el.getBoundingClientRect();
      return (!(el as any).checkVisibility || (el as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && box.width > 0 && box.height > 0;
    },
    inViewport(el: Element) {
      const box = el.getBoundingClientRect();
      return box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
    },
    walk(root: Document | ShadowRoot) {
      for (const el of root.querySelectorAll("*")) {
        all.push(el); if (el.shadowRoot) helpers.walk(el.shadowRoot);
      }
    },
    trim(value: string | null | undefined) { return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 160); },
    labelText(label: Element) {
      const copy = label.cloneNode(true) as Element;
      copy.querySelectorAll("input,textarea,select,button").forEach(e => e.remove());
      return copy.textContent ?? "";
    },
    describe(el: Element) {
      const e = el as HTMLInputElement;
      const root = el.getRootNode() as Document | ShadowRoot;
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map(id => root.querySelector(`[id="${CSS.escape(id)}"]`)?.textContent ?? "").join(" ");
      const label = trim(el.getAttribute("aria-label") || labelledBy || Array.from(e.labels ?? []).map(labelText).join(" ") ||
        (el.tagName === "SELECT" ? e.name : (e.innerText || e.placeholder || e.name)) || el.getAttribute("title") || el.getAttribute("alt") || e.type || el.tagName.toLowerCase());
      const inputType = e.type || (el.hasAttribute("contenteditable") ? "contenteditable" : undefined);
      const role = el.getAttribute("role") || ({ A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox" } as Record<string, string>)[el.tagName] ||
        (inputType === "checkbox" || inputType === "radio" ? inputType : "textbox");
      const kind: "type" | "click" = ["INPUT", "TEXTAREA"].includes(el.tagName) && !["checkbox", "radio", "file", "submit", "button"].includes(e.type) || el.hasAttribute("contenteditable") ? "type" : "click";
      return { label, role, kind, inputType,
        sensitive: /password|passcode|one.?time|verification.?code|security.?code|\botp\b|\bcvv\b|secret|token/i.test(`${label} ${e.type} ${e.autocomplete} ${e.name} ${e.id}`), disabled: !!e.disabled || el.getAttribute("aria-disabled") === "true",
        ...(["checkbox", "radio"].includes(role) ? { checked: typeof e.checked === "boolean" ? e.checked : el.getAttribute("aria-checked") === "true" } : {}),
        expanded: el.getAttribute("aria-expanded"), required: !!e.required || el.getAttribute("aria-required") === "true", invalid: el.getAttribute("aria-invalid"),
        description: trim((el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map(id => root.querySelector(`[id="${CSS.escape(id)}"]`)?.textContent ?? "").join(" ")) ,
        ...(el.tagName === "A" ? { href: (el as HTMLAnchorElement).href } : {}),
        ...(el.tagName === "SELECT" ? { options: Array.from((el as unknown as HTMLSelectElement).options).slice(0, 60).map(o => ({ label: trim(o.text), value: o.value.slice(0, 200), selected: o.selected })) } : {}),
      };
    }
  };
  const { visible, inViewport, trim, labelText, describe } = helpers;
  helpers.walk(document);
  const selector = 'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
  registry.describe = describe; registry.visible = visible;
  let sensitive = false;
  let truncated = false;
  const elements: ObservedElement[] = [];
  const privateField = /password|passcode|one.?time|verification.?code|security.?code|\botp\b|\bcvv\b|secret|token/i;
  // Prioritize the viewport so scrolling reveals controls beyond the cap.
  const candidates = all.filter(el => el.matches(selector));
  candidates.sort((a, b) => Number(inViewport(b)) - Number(inViewport(a)));
  for (const el of candidates) {
    if (!el.matches(selector) || (!visible(el) && (el as HTMLInputElement).type !== "file")) continue;
    const description = describe(el);
    const e = el as HTMLInputElement;
    // A filled secret, including a reveal-password input, excludes the image.
    if (e.value && (privateField.test(`${description.label} ${e.type} ${e.autocomplete} ${e.name} ${e.id}`) || args.secrets.some(s => s && e.value.includes(s)))) sensitive = true;
    if (elements.length >= args.limit) { truncated = true; continue; }
    let id = registry.ids.get(el);
    if (!id) { id = `${args.frameID}-${registry.documentID}-${++registry.next}`; registry.ids.set(el, id); }
    registry.nodes.set(id, el);
    elements.push({ ref: id, ...description });
  }
  const text = [document.body?.innerText ?? "", ...all.filter(e => e.shadowRoot).map(e => e.shadowRoot!.textContent ?? "")].join("\n");
  if (args.secrets.some(secret => secret && text.includes(secret))) sensitive = true;
  const notices = all.filter(el => el.matches('h1,h2,[role="alert"],[role="dialog"]') && visible(el)).slice(0, 12).map(el => (el as HTMLElement).innerText.slice(0, 400));
  const viewportText = all.filter(el => visible(el) && inViewport(el) && !el.children.length &&
    !el.matches("input,textarea,select,option,script,style,noscript")).map(el => (el as HTMLElement).innerText || el.textContent || "").join("\n");
  const boundedText = text.length > 12000 ? `Current viewport:\n${viewportText.slice(0, 6000)}\nPage context:\n${text.slice(0, 5900)}` : text;
  return { elements, text: boundedText, notices, sensitive, truncated: truncated || text.length > 12000, scroll: { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, pageHeight: document.documentElement.scrollHeight } };
}

export class BrowserObservation {
  private key = `__hygge_${crypto.randomUUID().replaceAll("-", "")}`;
  private frameIDs = new WeakMap<object, string>();
  private nextFrame = 0;
  private references = new Map<string, { frame: any; url: string; element: ObservedElement }>();
  readonly secrets = new Set<string>();
  private ax: any = null;

  async capture(page: any) {
    const references = new Map<string, { frame: any; url: string; element: ObservedElement }>();
    const elements: ObservedElement[] = [];
    const notices: string[] = [];
    const frames: { url: string; text: string }[] = [];
    let sensitive = false, truncated = false, scroll: any = null;
    const allFrames = page.frames();
    for (const frame of allFrames.slice(0, OBSERVATION_LIMITS.frames)) {
      let frameID = this.frameIDs.get(frame);
      if (!frameID) { frameID = `e${++this.nextFrame}`; this.frameIDs.set(frame, frameID); }
      try {
        const data = await frame.evaluate(inspectDocument, { key: this.key, frameID, limit: Math.max(0, OBSERVATION_LIMITS.elements - elements.length), secrets: [...this.secrets], documentID: crypto.randomUUID().replaceAll("-", "").slice(0, 16) });
        for (const element of data.elements) {
          references.set(element.ref, { frame, url: frame.url(), element });
          elements.push({ ...element, ...(element.href ? { href: safePageURL(element.href) } : {}), frameURL: safePageURL(frame.url()) });
        }
        const remaining = OBSERVATION_LIMITS.text - frames.reduce((n, f) => n + f.text.length, 0);
        if (remaining > 0) frames.push({ url: safePageURL(frame.url()), text: data.text.slice(0, remaining) });
        notices.push(...data.notices);
        sensitive ||= data.sensitive;
        truncated ||= data.truncated || data.text.length > remaining;
        if (frame === page.mainFrame()) scroll = data.scroll;
      } catch { sensitive = true; truncated = true; }
    }
    if (allFrames.length > OBSERVATION_LIMITS.frames) { sensitive = true; truncated = true; }
    this.references = references;
    let accessibility: any[] = [];
    try {
      this.ax ??= await page.createCDPSession();
      const tree = await this.ax.send("Accessibility.getFullAXTree");
      accessibility = tree.nodes.filter((n: any) => !n.ignored && n.name?.value).slice(0, OBSERVATION_LIMITS.axNodes).map((n: any) => ({
        role: String(n.role?.value ?? "").slice(0, 60), name: String(n.name.value).slice(0, 240),
        // Values are intentionally excluded: AX textbox values may be secrets.
      }));
      if (accessibility.some(n => [...this.secrets].some(secret => secret && n.name.includes(secret)))) sensitive = true;
    } catch { /* Semantic DOM observations remain available on older CDP engines. */ }
    const clean = (value: any): any => {
      if (typeof value === "string") return redact(value, this.secrets);
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clean(v)]));
      return value;
    };
    return { elements: clean(elements), notices: clean(notices.slice(0, 20)), pageText: clean(frames), accessibility: clean(accessibility), scroll,
      observationTruncated: truncated, visionSafe: !sensitive };
  }

  /** Strict references for the agent; exact unique labels only for old clients. */
  async resolve(target: string, action?: string) {
    let item = this.references.get(target);
    if (!item) {
      const matches = [...this.references.values()].filter(r => r.element.label === target);
      if (matches.length !== 1) throw new Error("Target is missing or ambiguous; observe again and use an element reference");
      item = matches[0];
    }
    if (item.frame.isDetached() || item.frame.url() !== item.url) throw new Error("Stale element reference; observe again");
    const ref = item.element.ref;
    const handle = await item.frame.evaluateHandle(({ key, ref }: any) => (window as any)[key]?.nodes.get(ref), { key: this.key, ref });
    const element = handle.asElement();
    if (!element) { await handle.dispose(); throw new Error("Stale element reference; observe again"); }
    try {
      const current = await element.evaluate((el: any, args: any) => {
        const registry = (window as any)[args.key];
        return el.isConnected && (registry?.visible(el) || (args.action === "upload" && el.type === "file")) ? registry.describe(el) : null;
      }, { key: this.key, action });
      if (!current || elementSignature(current) !== elementSignature(item.element)) throw new Error("Element changed; observe again");
      if (current.disabled) throw new Error("This control is disabled");
      if (action === "type" && current.kind !== "type") throw new Error("Target is not an editable field");
      return { handle: element, element: { ...current, ref }, frame: item.frame };
    } catch (error) { await handle.dispose(); throw error; }
  }
  async close() { await this.ax?.detach().catch(() => {}); this.references.clear(); this.secrets.clear(); }
}
