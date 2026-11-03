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
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 600 });
await page.setContent(await readFile(new URL('../test/fixtures/browser-page.html', import.meta.url), 'utf8'));
const live = new BrowserLive(page);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/tasks') res.end('{"tasks":[]}');
  else { res.statusCode = 404; res.end('{}'); }
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/sessions/preview/stream') { socket.destroy(); return; }
  sockets.handleUpgrade(request, socket, head, ws => {
    console.log('Viewer connected');
    void live.connect(ws as any, async () => () => console.log('Browser handed back'));
  });
});
server.listen(8768, '127.0.0.1', () => console.log('Local real-browser fixture listening on 8768'));
process.on('SIGTERM', () => { live.finish('Fixture stopped'); server.close(); void browser.close().finally(() => process.exit(0)); });
