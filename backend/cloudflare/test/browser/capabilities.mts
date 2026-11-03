import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@cloudflare/puppeteer/lib/esm/puppeteer/puppeteer-core-browser.js';
import { BrowserRunBrowser } from '../../src/browser.ts';
import { BrowserObservation } from '../../src/browser-observation.ts';
import { BrowserLive } from '../../src/browser-live.ts';

const html = `<!doctype html><title>Browser capabilities fixture</title>
<style>body {font:18px sans-serif} label {display:block;margin:12px} input,select,button{padding:8px} #hidden{display:none}</style>
<h1>Find a good project</h1><p role="alert">Your profile needs a headline.</p>
<button id="first" onclick="window.clicked='first'">Continue</button>
<button id="second" onmouseenter="window.hovered=true" onclick="window.clicked='second'">Continue</button>
<button id="hidden">Hidden control</button><button disabled>Unavailable</button>
<label>Headline<input id="headline" name="headline" value="Old headline"></label>
<label>Work type<select id="work"><option value="design">Design</option><option value="writing">Writing</option></select></label>
<label><input id="remember" type="checkbox">Remember this device</label>
<div contenteditable="true" aria-label="Biography">Old biography</div>
<label>Password<input id="secret" type="password" autocomplete="current-password"></label>
<input id="photo" type="file" aria-label="Profile photo" style="display:none">
<div id="shadow"></div><iframe title="Address" src="/frame"></iframe>
<a href="/next">Next page</a><div style="height:1400px">More work below</div>
<button id="bottom">At the bottom</button>
<script>shadow.attachShadow({mode:'open'}).innerHTML='<button aria-label="Open shadow menu">Menu</button>';</script>`;

test('real Chrome: semantic observations, precise actions, redaction, stale refs and navigation', { timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'hygge-browser-capabilities-'));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/frame' ? '<label>City<input name="city"></label>' : req.url === '/next' ? '<title>Next page</title><h1>Next page</h1>' : html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const executable = process.env.BROWSER_TEST_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
  const child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let startError: Error | undefined; child.on('error', error => { startError = error; });
  let browser: any;
  try {
    let port = '';
    for (let n = 0; n < 100 && !port; n++) {
      if (startError) throw startError;
      port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(s => s.split('\n')[0]).catch(() => '');
      if (!port) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(port, 'Chrome starts with an isolated profile');
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any;
    browser = await connect({ browserWSEndpoint: version.webSocketDebuggerUrl });
    const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    if (process.env.BROWSER_TEST_BUNDLE) {
      const bundle = await readFile(process.env.BROWSER_TEST_BUNDLE, 'utf8');
      const source = bundle.match(/^function inspectDocument\(args\) \{[\s\S]*?^\}/m)?.[0];
      assert.ok(source, 'Worker bundle contains the page observer');
      const bundledObserver = new Function(`return (${source})`)();
      const observation = await page.evaluate(bundledObserver, { key: '__hygge_bundle_fixture', frameID: 'fixture', documentID: 'bundle', limit: 160, secrets: [] });
      assert.ok(observation.elements.some((e: any) => e.label === 'Headline'), 'bundled observer runs without Worker-only helpers');
    }
    const adapter = new BrowserRunBrowser({} as any);
    (adapter as any).sessions.set('fixture', { id: 'fixture', browser, page, live: new BrowserLive(page), observation: new BrowserObservation() });
    let snap = (await adapter.snapshot('fixture'))!;
    const named = (label: string) => { const e = snap.elements.find(e => e.label === label); assert.ok(e, `observed ${label}`); return e!; };
    assert.ok(snap.pageText!.some(f => f.text.includes('Your profile needs a headline')));
    assert.ok(snap.accessibility!.some(n => n.name.includes('Find a good project')));
    assert.ok(!snap.elements.some(e => e.label === 'Hidden control'));
    assert.equal(named('Unavailable').disabled, true);
    assert.equal(snap.visionSafe, true);
    assert.ok(snap.screenshotBase64!.length > 100);
    assert.equal(named('Profile photo').inputType, 'file');
    assert.ok(named('City').ref);
    assert.ok(named('Open shadow menu').ref);
    const duplicates = snap.elements.filter(e => e.label === 'Continue');
    assert.equal(duplicates.length, 2); assert.notEqual(duplicates[0].ref, duplicates[1].ref);
    await assert.rejects(adapter.act('fixture', { action: 'click', target: 'Continue' }), /ambiguous/);
    await adapter.act('fixture', { action: 'hover', target: duplicates[1].ref });
    assert.equal(await page.evaluate(() => (window as any).hovered), true);
    await adapter.act('fixture', { action: 'click', target: duplicates[1].ref });
    assert.equal(await page.evaluate(() => (window as any).clicked), 'second');
    await assert.rejects(adapter.act('fixture', { action: 'click', target: named('Unavailable').ref }), /disabled/);
    const headline = named('Headline').ref!;
    await adapter.act('fixture', { action: 'type', target: headline, value: 'Designer & writer' });
    assert.equal(await page.$eval('#headline', (el: any) => el.value), 'Designer & writer');
    await assert.rejects(adapter.act('fixture', { action: 'type', target: 'missing-ref', value: 'Wrong field' }), /missing/);
    assert.equal(await page.$eval('#headline', (el: any) => el.value), 'Designer & writer');
    snap = (await adapter.snapshot('fixture'))!;
    assert.equal(named('Headline').ref, headline, 'reference stable for same DOM node');
    await adapter.act('fixture', { action: 'select', target: named('Work type').ref, value: 'writing' });
    assert.equal(await page.$eval('#work', (el: any) => el.value), 'writing');
    snap = (await adapter.snapshot('fixture'))!;
    await adapter.act('fixture', { action: 'check', target: named('Remember this device').ref, value: 'true' });
    snap = (await adapter.snapshot('fixture'))!;
    await adapter.act('fixture', { action: 'check', target: named('Remember this device').ref, value: 'true' });
    assert.equal(await page.$eval('#remember', (el: any) => el.checked), true, 'check is idempotent');
    await adapter.act('fixture', { action: 'type', target: named('City').ref, value: 'Austin' });
    const frame = page.frames().find((f: any) => f.url().endsWith('/frame'));
    assert.equal(await frame.$eval('input', (el: any) => el.value), 'Austin');
    await adapter.act('fixture', { action: 'click', target: named('Open shadow menu').ref });
    await adapter.act('fixture', { action: 'type', target: named('Biography').ref, value: 'I write thoughtful copy.' });
    assert.equal(await page.$eval('[contenteditable]', (el: any) => el.textContent), 'I write thoughtful copy.');
    await adapter.act('fixture', { action: 'press', target: headline, value: 'Tab' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'work');
    const liveControl = adapter.controlState('fixture')!;
    await liveControl.acquire('fixture-user');
    assert.equal((await adapter.snapshot('fixture'))!.visionSafe, false, 'human control withholds model images');
    await liveControl.release('fixture-user');
    await adapter.act('fixture', { action: 'type', target: named('Password').ref, value: 'private-Secret-573!', sensitive: true });
    snap = (await adapter.snapshot('fixture'))!;
    assert.equal(snap.visionSafe, false, 'filled password never becomes a model image');
    assert.ok(!JSON.stringify({ elements: snap.elements, text: snap.pageText, ax: snap.accessibility }).includes('private-Secret-573!'));
    await page.evaluate(() => { (document.querySelector('#secret') as HTMLInputElement).type = 'text'; });
    snap = (await adapter.snapshot('fixture'))!; assert.equal(snap.visionSafe, false, 'revealed passwords also exclude the screenshot');
    await page.evaluate(() => { (document.querySelector('#secret') as HTMLInputElement).value = ''; const p = document.createElement('p'); p.textContent = 'private-Secret-573!'; document.body.append(p); });
    snap = (await adapter.snapshot('fixture'))!;
    assert.equal(snap.visionSafe, false, 'echoed private values exclude screenshot');
    assert.ok(snap.pageText![0].text.includes('[redacted]'));
    await page.evaluate(() => { document.querySelector('#headline')!.outerHTML = '<input aria-label="Different field">'; });
    await assert.rejects(adapter.act('fixture', { action: 'type', target: headline, value: 'wrong' }), /Stale|changed/);
    await adapter.act('fixture', { action: 'scroll', value: 'down' });
    assert.ok(await page.evaluate(() => scrollY > 0));
    await adapter.act('fixture', { action: 'wait', value: '100' });
    await assert.rejects(adapter.act('fixture', { action: 'wait', value: '100000' }), /between/);
    await assert.rejects(adapter.act('fixture', { action: 'navigate', value: 'javascript:alert(1)' }), /HTTP/);
    await adapter.act('fixture', { action: 'navigate', value: `${base}/next` });
    await adapter.act('fixture', { action: 'back' }); assert.equal(page.url(), `${base}/`);
    await adapter.act('fixture', { action: 'forward' }); assert.equal(page.url(), `${base}/next`);
    await adapter.act('fixture', { action: 'back' });
    await page.reload({ waitUntil: 'load' });
    snap = (await adapter.snapshot('fixture'))!;
    assert.notEqual(named('Headline').ref, headline, 'navigation creates a new document identity');
    await page.evaluate(() => {
      document.body.innerHTML = Array.from({ length: 200 }, (_, i) => `<p>Project ${i}: ${'Writing opportunity. '.repeat(12)}</p><button>Open project ${i}</button>`).join('');
      window.scrollTo(0, 0);
    });
    snap = (await adapter.snapshot('fixture'))!;
    assert.equal(snap.elements.length, 160); assert.equal(snap.observationTruncated, true);
    assert.ok(!snap.elements.some(e => e.label === 'Open project 199'));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    snap = (await adapter.snapshot('fixture'))!;
    assert.ok(named('Open project 199').ref, 'viewport controls take priority over off-screen controls');
    assert.ok(snap.pageText![0].text.includes('Project 199'), 'long-page text includes current viewport');
    await adapter.closeSession('fixture'); browser = null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
