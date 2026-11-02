import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { magicLandingHtml, magicLinkMessage } from "../src/auth.ts";

const token = "a".repeat(43);
function browser({ mobile = true, hidden = false, iPad = false, blocked = false } = {}) {
  const html = magicLandingHtml(token);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const titles: Record<string, { textContent: string }> = { title: { textContent: "" }, help: { textContent: "" } };
  const opened: string[] = [], history: string[] = [], timers: Array<() => void> = [];
  const handlers = new Set<() => void>();
  const document = {
    visibilityState: hidden ? "hidden" : "visible",
    getElementById: (id: string) => titles[id],
    addEventListener: (_event: string, callback: () => void) => handlers.add(callback),
    removeEventListener: (_event: string, callback: () => void) => handlers.delete(callback),
  };
  vm.runInNewContext(script, {
    navigator: { userAgent: mobile ? "iPhone" : "desktop", platform: iPad ? "MacIntel" : "", maxTouchPoints: iPad ? 5 : 0 },
    document,
    location: { pathname: "/auth/magic", replace: (url: string) => { if (blocked) throw Error("blocked"); opened.push(url); } },
    history: { replaceState: (_state: unknown, _title: string, url: string) => history.push(url) },
    setTimeout: (callback: () => void) => timers.push(callback),
  });
  return { html, opened, history, titles, timers, handlers, document };
}

test("email links remain direct HTTPS Universal Links without a tracking hop", () => {
  const link = `https://api.usehygge.app/auth/magic?token=${token}`;
  const message = magicLinkMessage("sam@example.com", link);
  assert.ok(message.html.includes(`href="${link}"`));
  assert.ok(message.text.includes(link));
  assert.equal(message.html.includes("hygge://"), false);
});

test("visible iPhone fallback attempts one automatic handoff and strips browser history", () => {
  const b = browser();
  assert.deepEqual(b.opened, [`hygge://auth/magic?token=${token}`]);
  assert.deepEqual(b.history, ["/auth/magic"]);
  assert.equal(b.handlers.size, 0);
  assert.match(b.html, /id="open-app"/);
  b.timers.forEach(fn => fn());
  assert.equal(b.titles.title.textContent, "Continue in Hygge");
});

test("iPad desktop mode also attempts the handoff, desktop computers do not", () => {
  assert.equal(browser({ mobile: false, iPad: true }).opened.length, 1);
  const desktop = browser({ mobile: false });
  assert.equal(desktop.opened.length, 0);
  assert.match(desktop.titles.title.textContent, /iPhone or iPad/);
});

test("background previews wait until visible and returning from the app never loops", () => {
  const b = browser({ hidden: true });
  assert.equal(b.opened.length, 0);
  const show = [...b.handlers][0];
  b.document.visibilityState = "visible";
  show();
  b.document.visibilityState = "hidden";
  b.timers.forEach(fn => fn());
  b.document.visibilityState = "visible";
  show();
  assert.equal(b.opened.length, 1);
  assert.equal(b.handlers.size, 0);
});

test("clients that block handoff retain the manual app link without an exception", () => {
  const b = browser({ blocked: true });
  assert.equal(b.opened.length, 0);
  assert.ok(b.html.includes(`href="hygge://auth/magic?token=${token}"`));
});

test("invalid tokens cannot inject markup or trigger app opening", () => {
  for (const invalid of ["", "short", '</script><script>alert("x")</script>', '" onclick="alert(1)']) {
    const html = magicLandingHtml(invalid);
    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes('id="open-app"'), false);
    assert.match(html, /Ask for a new sign-in link/);
  }
});
