/** Integration check against the isolated loopback Chrome fixture only. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { connect } from '@cloudflare/puppeteer/lib/esm/puppeteer/puppeteer-core-browser.js';
const version = await (await fetch('http://127.0.0.1:9237/json/version')).json() as any;
const browser = await connect({ browserWSEndpoint: version.webSocketDebuggerUrl, defaultViewport: null });
const pages = await browser.pages();
let page: any;
for (const candidate of pages) if ((await candidate.title()).includes('Browser test')) page = candidate;
assert.ok(page, 'isolated fixture page exists');
const messages: any[] = [];
const ws = new WebSocket('ws://127.0.0.1:8768/sessions/preview/stream');
ws.on('message', bytes => {
  const message = JSON.parse(bytes.toString()); messages.push(message);
  if (message.type === 'frame') ws.send(JSON.stringify({ type: 'ack' }));
});
const wait = async (test: () => boolean, label: string) => {
  const deadline = Date.now() + 12000;
  while (!test() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(test(), label);
};
const send = (value: any) => ws.send(JSON.stringify(value));
try {
  await wait(() => messages.filter(m => m.type === 'frame').length >= 3, 'receives continuous compositor frames');
  const frames = messages.filter(m => m.type === 'frame');
  assert.notEqual(frames[0].data, frames[frames.length - 1].data, 'animation changes streamed image');
  send({ type: 'takeControl', requestID: 'control' });
  await wait(() => messages.some(m => m.type === 'controlled'), 'takeover acknowledged');
  const target = await page.evaluate(() => { const r = document.querySelector('#title')!.getBoundingClientRect(); return { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight }; });
  send({ type: 'pointer', phase: 'click', ...target });
  await wait(() => messages.some(m => m.type === 'focus' && m.keyboard), 'actual remote input focused');
  send({ type: 'text', text: ' TEST' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.match(await page.$eval('#title', (el: any) => el.value), / TEST/);
  send({ type: 'key', key: 'Backspace' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(!(await page.$eval('#title', (el: any) => el.value)).includes(' TEST'));
  send({ type: 'scroll', dx: 0, dy: 300 });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(await page.evaluate(() => scrollY > 0), 'wheel scroll reaches remote page');
  send({ type: 'releaseControl', requestID: 'release' });
  await wait(() => messages.some(m => m.type === 'released'), 'handback acknowledged');
  await page.evaluate(() => document.getAnimations().forEach(animation => animation.cancel()));
  const pongs = messages.filter(m => m.type === 'pong').length;
  for (let i = 0; i < 4; i++) {
    send({ type: 'ping' });
    await wait(() => messages.filter(m => m.type === 'pong').length > pongs + i, 'static page remains responsive');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  await new Promise<void>(resolve => { ws.once('close', () => resolve()); ws.close(); });
  for (let i = 0; i < 8; i++) {
    const again = new WebSocket('ws://127.0.0.1:8768/sessions/preview/stream');
    let freshFrame = false;
    again.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'frame') { freshFrame = true; again.send(JSON.stringify({ type: 'ack' })); }
    });
    try { await wait(() => freshFrame, 'static page sends a fresh frame after reopening'); }
    finally { await new Promise<void>(resolve => { again.once('close', () => resolve()); again.close(); }); }
  }
  console.log('PASS: live frames, click/focus, text, Backspace, scroll, handback, static-page heartbeat and eight rapid reopenings');
} finally {
  ws.close();
  await page.evaluate(() => { (document.querySelector('#title') as HTMLInputElement).value = 'Brand designer & writer'; scrollTo(0, 0); });
  await browser.disconnect();
}
