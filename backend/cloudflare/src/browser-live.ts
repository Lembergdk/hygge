import { CDPSessionEvent } from "@cloudflare/puppeteer/internal/api/CDPSession.js";
import { BrowserControl, validateBrowserInput } from "./browser-control.ts";

/** A single CDP screencast, multiplexed to authenticated app viewers.
 * These are pushed compositor frames, not a screenshot polling loop. */
export class BrowserLive {
  private viewers = new Map<WebSocket, { owner: string; awaitingFrame: boolean; sequence: number }>();
  private cdp: any;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private frame: string | null = null;
  private sequence = 0;
  private closed = false;
  private pointer = { x: 0.5, y: 0.5 };
  private buttons = 0;
  readonly control = new BrowserControl();
  private page: any;
  constructor(page: any) {
    this.page = page;
    this.page.once("close", () => this.finish("This browser session has finished."));
  }
  get ended() { return this.closed; }
  state() {
    const viewport = this.page.viewport() ?? { width: 1365, height: 900 };
    return { type: "state", url: this.page.url(), width: viewport.width, height: viewport.height,
      humanControlled: this.control.human, epoch: this.control.epoch, pointer: this.pointer };
  }
  private send(socket: WebSocket, value: unknown) {
    try { socket.send(JSON.stringify(value)); } catch { this.remove(socket); }
  }
  noteAgentPointer(x: number, y: number) {
    const size = this.state();
    this.pointer = { x: Math.max(0, Math.min(1, x / size.width)), y: Math.max(0, Math.min(1, y / size.height)) };
    this.broadcast();
  }
  broadcast() { for (const socket of this.viewers.keys()) this.send(socket, this.state()); }
  private async start() {
    if (this.cdp) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // stopScreencast affects the page, even when sent on an older CDP session.
      // Finish detaching the previous viewer before starting its replacement.
      await this.stopping;
      if (this.closed || !this.viewers.size) return;
      const cdp = await this.page.createCDPSession();
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (event: any) => {
        this.frame = event.data;
        this.sequence++;
        for (const [socket, viewer] of this.viewers) {
          // At most one unacknowledged frame per consumer; slow previews don't queue video.
          if (!viewer.awaitingFrame) {
            viewer.awaitingFrame = true;
            viewer.sequence = this.sequence;
            this.send(socket, { type: "frame", data: event.data });
          }
        }
        void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      });
      cdp.on("Page.frameNavigated", () => this.broadcast());
      cdp.on(CDPSessionEvent.Disconnected, () => this.finish("The browser connection ended."));
      await cdp.send("Page.enable");
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1600, maxHeight: 1600, everyNthFrame: 1 });
    })();
    try { await this.starting; }
    catch (error) { this.stopCapture(); throw error; }
    finally { this.starting = null; if (!this.viewers.size) this.stopCapture(); }
  }
  async connect(socket: WebSocket, onResume: () => Promise<(() => void) | void>) {
    if (this.closed) { this.send(socket, { type: "ended", message: "This browser session has ended." }); socket.close(1000, "Session finished"); return; }
    const owner = crypto.randomUUID();
    // Periodically reconnect through the authenticated HTTP route, including token revocation.
    const lifetime = setTimeout(() => socket.close(1001, "Reconnect to continue"), 15 * 60 * 1000);
    socket.addEventListener("close", () => clearTimeout(lifetime));
    socket.addEventListener("error", () => clearTimeout(lifetime));
    this.viewers.set(socket, { owner, awaitingFrame: false, sequence: -1 });
    let chain = Promise.resolve();
    let pending = 0;
    let heartbeatPending = false;
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string" || event.data.length > 10000 || pending >= 64) {
        socket.close(1008, "Invalid input"); return;
      }
      // Heartbeats must not queue behind a handoff waiting for an agent action.
      // A static page is still live; verify CDP without requiring another frame.
      let incoming: any;
      try { incoming = JSON.parse(event.data); } catch { socket.close(1008, "Invalid input"); return; }
      if (incoming?.type === "ping") {
        if (heartbeatPending || !this.cdp || !this.viewers.has(socket)) return;
        heartbeatPending = true;
        const cdp = this.cdp;
        void cdp.send("Page.getLayoutMetrics").then(() => {
          if (this.cdp === cdp && this.viewers.has(socket)) { this.send(socket, { type: "pong" }); this.broadcast(); }
        }).catch(() => {
          // A ping from a departed viewer can reject when its old CDP detaches.
          if (this.cdp === cdp && this.viewers.has(socket)) this.finish("The browser connection ended.");
        }).finally(() => heartbeatPending = false);
        return;
      }
      pending++;
      chain = chain.then(async () => {
        let message: any;
        try {
          if (!this.viewers.has(socket)) return;
          message = incoming;
          if (message.type === "ack") {
            const viewer = this.viewers.get(socket);
            if (viewer) {
              viewer.awaitingFrame = false;
              if (this.frame && viewer.sequence < this.sequence) {
                viewer.awaitingFrame = true; viewer.sequence = this.sequence;
                this.send(socket, { type: "frame", data: this.frame });
              }
            }
            return;
          }
          if (message.type === "takeControl") {
            await this.control.acquire(owner);
            this.broadcast();
            this.send(socket, { type: "controlled", requestID: message.requestID }); return;
          }
          if (message.type === "releaseControl") {
            await this.control.input(owner, async () => {
              if (this.buttons) await this.pointerEvent({ phase: "up", ...this.pointer });
            });
            const resume = await onResume();
            await this.control.release(owner);
            resume?.();
            this.broadcast();
            this.send(socket, { type: "released", requestID: message.requestID }); return;
          }
          if (message.type === "viewport") {
            if (![message.width, message.height].every(n => Number.isInteger(n) && n >= 100 && n <= 2048)) throw new Error("Invalid viewport.");
            const resize = async () => { await this.page.setViewport({ width: message.width, height: message.height }); this.broadcast(); };
            if (this.control.human) await this.control.input(owner, resize);
            else await this.control.agent(this.control.epoch, resize);
            return;
          }
          if (!validateBrowserInput(message)) throw new Error("Unsupported browser input.");
          await this.control.input(owner, async () => {
            if (message.type === "pointer") await this.pointerEvent(message);
            else if (message.type === "scroll") {
              const size = this.state();
              await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: this.pointer.x * size.width,
                y: this.pointer.y * size.height, deltaX: message.dx, deltaY: message.dy });
            } else if (message.type === "text") await this.cdp.send("Input.insertText", { text: message.text });
            else if (message.type === "key") {
              const codes: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Delete: 46,
                ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 };
              const params = { key: message.key, windowsVirtualKeyCode: codes[message.key] ?? message.key.toUpperCase().charCodeAt(0), modifiers: message.modifiers ?? 0 };
              await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
              await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
            }
          });
        } catch (error) {
          this.send(socket, { type: "error", requestID: message?.requestID,
            message: error instanceof Error ? error.message : "The browser action could not finish." });
        } finally { pending--; }
      });
    });
    socket.addEventListener("close", () => this.remove(socket));
    socket.addEventListener("error", () => this.remove(socket));
    try {
      await this.start();
      if (!this.viewers.has(socket) || this.closed) return;
      this.send(socket, this.state());
      if (this.frame) { this.viewers.get(socket)!.awaitingFrame = true; this.viewers.get(socket)!.sequence = this.sequence; this.send(socket, { type: "frame", data: this.frame }); }
    } catch {
      this.send(socket, { type: "error", message: "Live browsing could not connect. Please reconnect." });
      socket.close(1011, "Live browser unavailable");
    }
  }
  private async pointerEvent(message: any) {
    this.pointer = { x: message.x, y: message.y };
    const size = this.state();
    const position = { x: message.x * size.width, y: message.y * size.height };
    const button = message.button ?? "left";
    const dispatch = async (type: string, buttons: number) => this.cdp.send("Input.dispatchMouseEvent", {
      type, ...position, button: type === "mouseMoved" && !buttons ? "none" : button,
      buttons, clickCount: type === "mouseMoved" ? 0 : 1,
    });
    if (message.phase === "click") { await dispatch("mousePressed", button === "right" ? 2 : 1); await dispatch("mouseReleased", 0); }
    if (message.phase === "down") { this.buttons = button === "right" ? 2 : 1; await dispatch("mousePressed", this.buttons); }
    if (message.phase === "up") { this.buttons = 0; await dispatch("mouseReleased", 0); }
    if (message.phase === "move") await dispatch("mouseMoved", this.buttons);
    this.broadcast();
    if (message.phase === "click") {
      // Discover focus without reading field values, including same-page frames.
      let keyboard = false;
      for (const frame of this.page.frames()) {
        keyboard ||= await frame.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return !!el && (el.isContentEditable || el.tagName === "TEXTAREA" ||
            (el.tagName === "INPUT" && !["button", "submit", "checkbox", "radio", "file", "range", "color"].includes((el as HTMLInputElement).type)));
        }).catch(() => false);
      }
      for (const socket of this.viewers.keys()) this.send(socket, { type: "focus", keyboard });
    }
  }
  private remove(socket: WebSocket) {
    const viewer = this.viewers.get(socket);
    if (!viewer) return;
    this.viewers.delete(socket);
    // Release a held mouse button but retain the human pause.
    if (this.control.owner === viewer.owner && this.buttons && this.cdp) {
      void this.pointerEvent({ phase: "up", ...this.pointer }).catch(() => {});
    }
    this.control.disconnect(viewer.owner);
    this.broadcast();
    if (!this.viewers.size && !this.starting) this.stopCapture();
  }
  private stopCapture() {
    const cdp = this.cdp;
    if (!cdp) return;
    this.cdp = null; this.frame = null;
    cdp.removeAllListeners();
    this.stopping = this.stopping.then(async () => {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    });
  }

  finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const socket of [...this.viewers.keys()]) {
      this.send(socket, { type: "ended", message: reason });
      socket.close(1000, "Session ended");
      this.remove(socket);
    }
  }
}
