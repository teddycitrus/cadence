import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { BuiltInBrowser } from "../browser/service";
import type { BrowserTab } from "../browser/tab";
import type { WorkspaceService } from "../workspaces/service";
import { originAllowed } from "./terminal-socket";
import { refuseUpgrade } from "./refuse-upgrade";

const PATH = /^\/api\/workspaces\/([\w-]{1,100})\/browser\/socket$/;

type Incoming =
  | { type: "navigate"; url: string }
  | { type: "back" | "forward" | "reload" | "tabs" | "close" }
  | { type: "resize"; width: number; height: number }
  | { type: "mouse"; event: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button?: "left" | "right" | "middle" | "none"; clickCount?: number; modifiers?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; event: "keyDown" | "keyUp" | "rawKeyDown" | "char"; key: string; code?: string; text?: string; keyCode?: number; modifiers?: number }
  | { type: "text"; text: string }
  | { type: "find"; text: string; backwards?: boolean };

const finite = (...n: unknown[]) => n.every((x) => typeof x === "number" && Number.isFinite(x));

/**
 * Serves /api/workspaces/:id/browser/socket: JPEG frames of the workspace's
 * built-in browser out (binary messages), page state as JSON, and the
 * person's mouse, keys, and navigation in. `authorize` decides who may drive it.
 */
export function attachBrowserSockets(server: Server, browser: BuiltInBrowser, workspaces: WorkspaceService, authorize: (req: IncomingMessage) => boolean): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = PATH.exec(url.pathname);
    if (!match) return;
    const reject = (status: string) => refuseUpgrade(socket, status);
    if (!originAllowed(req)) return reject("403 Forbidden");
    const token = url.searchParams.get("token");
    if (token && !req.headers.authorization) req.headers.authorization = `Bearer ${token}`;
    if (!authorize(req)) return reject("401 Unauthorized");
    const id = match[1]!;
    try {
      workspaces.workspaceOrThrow(id);
    } catch {
      return reject("404 Not Found");
    }
    const index = Number(url.searchParams.get("tab") ?? 0);
    if (!Number.isInteger(index) || index < 0 || index >= BuiltInBrowser.MAX_TABS) return reject("400 Bad Request");
    wss.handleUpgrade(req, socket, head, (ws) => void serve(ws, id, index, browser));
  });
}

async function serve(ws: WebSocket, workspaceId: string, index: number, browser: BuiltInBrowser): Promise<void> {
  const json = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  // Listen at once, so input sent while the tab opens is not lost; handlers wait for it.
  const opening = browser.tab(workspaceId, index);
  ws.on("message", (raw, isBinary) => void opening.then((tab) => handle(tab, raw, isBinary)).catch(() => undefined));
  let tab: BrowserTab;
  try {
    tab = await opening;
  } catch (err) {
    json({ type: "error", message: err instanceof Error ? err.message : String(err) });
    ws.close();
    return;
  }
  // Frames are dropped while the socket is still sending the last ones, so a slow link never queues up.
  const stop = tab.watch(
    (jpeg) => {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(jpeg, { binary: true });
    },
    (state) => json({ type: "state", state }),
  );
  ws.on("close", stop);
  async function handle(tab: BrowserTab, raw: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) return;
    let m: Incoming;
    try {
      m = JSON.parse(String(raw)) as Incoming;
    } catch {
      return;
    }
    try {
      if (m.type === "navigate" && typeof m.url === "string") await tab.navigate(m.url);
      else if (m.type === "tabs") json({ type: "tabs", open: browser.open(workspaceId) });
      // The agents' tab stays open; extra tabs close for good.
      else if (m.type === "close" && index > 0) {
        await browser.closeTab(workspaceId, index);
        ws.close();
      }
      else if (m.type === "back") await tab.history(-1);
      else if (m.type === "forward") await tab.history(1);
      else if (m.type === "reload") await tab.reload();
      else if (m.type === "resize" && finite(m.width, m.height)) await tab.resize(m.width, m.height);
      else if (m.type === "mouse" && finite(m.x, m.y)) await tab.mouse({ type: m.event, x: m.x, y: m.y, button: m.button, clickCount: m.clickCount, modifiers: m.modifiers });
      else if (m.type === "wheel" && finite(m.x, m.y, m.deltaX, m.deltaY)) await tab.wheel(m.x, m.y, m.deltaX, m.deltaY);
      else if (m.type === "key" && typeof m.key === "string") await tab.key({ type: m.event, key: m.key, code: m.code, text: m.text, keyCode: m.keyCode, modifiers: m.modifiers });
      else if (m.type === "text" && typeof m.text === "string") await tab.insertText(m.text.slice(0, 10_000));
      else if (m.type === "find" && typeof m.text === "string") json({ type: "found", ...(await tab.find(m.text, m.backwards === true)) });
    } catch (err) {
      json({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
}
