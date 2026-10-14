import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TerminalService } from "../terminal/service";
import { refuseUpgrade } from "./refuse-upgrade";

const PATH = /^\/api\/terminals\/([0-9a-f-]{36})\/socket$/;

/** Dev UI origins allowed besides the page the server itself serves. */
const DEV_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

/**
 * WebSockets are not covered by CORS, so without this check any website the
 * user visits could open a shell on their machine through localhost.
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (CLI clients, tests)
  if (DEV_ORIGINS.has(origin)) return true;
  const host = req.headers.host;
  return Boolean(host) && (origin === `http://${host}` || origin === `https://${host}`);
}

/** Serves /api/terminals/:id/socket: JSON frames in both directions. `authorize` decides who may open a shell. */
export function attachTerminalSockets(server: Server, terminals: TerminalService, authorize: (req: IncomingMessage) => boolean): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = PATH.exec(url.pathname);
    if (!match) return; // other upgrade handlers (for example Vite) may want it
    const reject = (status: string) => refuseUpgrade(socket, status);
    if (!originAllowed(req)) return reject("403 Forbidden");
    // Browsers cannot set headers on WebSockets, so the API token may come in the URL.
    const token = url.searchParams.get("token");
    if (token && !req.headers.authorization) req.headers.authorization = `Bearer ${token}`;
    if (!authorize(req)) return reject("401 Unauthorized");
    const id = match[1]!;
    try {
      terminals.get(id);
    } catch {
      return reject("404 Not Found");
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, id, terminals));
  });
}

function serve(ws: WebSocket, id: string, terminals: TerminalService): void {
  const send = (m: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const info = terminals.get(id);
  const { scrollback, detach } = terminals.attach(id, send);
  send({ type: "snapshot", data: scrollback, alive: info.alive, exitCode: info.exitCode });
  ws.on("message", (raw) => {
    let m: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === "input" && typeof m.data === "string") terminals.write(id, m.data);
    else if (m.type === "resize" && typeof m.cols === "number" && typeof m.rows === "number") terminals.resize(id, m.cols, m.rows);
  });
  ws.on("close", detach);
}
