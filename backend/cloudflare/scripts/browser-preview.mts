/** Local real-Chrome transport fixture. No production account or site involved.
 * Start Chrome with --headless --remote-debugging-port=9237 and an isolated profile,
 * then run node --experimental-strip-types scripts/browser-preview.mts.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { connect } from '@cloudflare/puppeteer/lib/esm/puppeteer/puppeteer-core-browser.js';
import { BrowserLive } from '../src/browser-live.ts';
const version = await (await fetch('http://127.0.0.1:9237/json/version')).json() as any;
const browser = await connect({ browserWSEndpoint: version.webSocketDebuggerUrl });
// Retire only previous copies of this isolated fixture, never unrelated tabs.
for (const previous of await browser.pages()) {
  if ((await previous.title()).includes('Workroom · Browser test')) await previous.close();
}
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 600 });
await page.setContent(await readFile(new URL('../test/fixtures/browser-page.html', import.meta.url), 'utf8'));
const live = new BrowserLive(page);
let mode = 'live';
const server = createServer(async (req, res) => {
  // Loopback-only fault injection for native recovery QA. Never a production route.
  if (req.method === 'POST' && req.url?.startsWith('/fixture/mode/')) {
    mode = req.url.split('/').pop()!;
    for (const socket of sockets.clients) socket.close(1001, 'Fixture mode changed');
    res.end('{}'); return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/tasks') res.end('{"tasks":[]}');
  else { res.statusCode = 404; res.end('{}'); }
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/sessions/preview/stream') { socket.destroy(); return; }
  if (mode === 'expired' || mode === 'unauthorized') {
    const status = mode === 'expired' ? '410 Gone' : '401 Unauthorized';
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\n\r\n`); return;
  }
  sockets.handleUpgrade(request, socket, head, ws => {
    if (mode === 'silent') return;
    if (mode === 'offline') { ws.close(1001, 'Fixture offline'); return; }
    console.log('Viewer connected');
    void live.connect(ws as any, async () => () => console.log('Browser handed back'));
  });
});
server.listen(8768, '127.0.0.1', () => console.log('Local real-browser fixture listening on 8768'));
process.on('SIGTERM', () => { live.finish('Fixture stopped'); server.close(); void browser.close().finally(() => process.exit(0)); });
