import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { WorkspaceService } from "../workspaces/service";
import { originAllowed } from "../server/terminal-socket";
import { refuseUpgrade } from "../server/refuse-upgrade";

const PATH = /^\/api\/workspaces\/([\w-]{1,100})\/lsp$/;
const MAX_PER_WORKSPACE = 4;
const require = createRequire(import.meta.url);

/** TypeScript's own language server (TypeScript 7 serves LSP from tsc), started in the workspace folder. */
export function startTypeScriptServer(cwd: string): ChildProcess {
  // The package exports no bin path, so go through its package.json.
  const pkg = require.resolve("typescript/package.json");
  const tsc = join(dirname(pkg), (require(pkg) as { bin: { tsc: string } }).bin.tsc);
  return spawn(process.execPath, [tsc, "--lsp", "--stdio"], { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
}

/** Splits an LSP byte stream (Content-Length framed) into JSON message strings. */
export class LspFramer {
  private buf = Buffer.alloc(0);
  constructor(private onMessage: (json: string) => void) {}

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString("ascii"))?.[1]);
      if (!Number.isFinite(length)) {
        // Not LSP framing: drop what we have rather than wedge the stream.
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < end + 4 + length) return;
      this.onMessage(this.buf.subarray(end + 4, end + 4 + length).toString("utf8"));
      this.buf = this.buf.subarray(end + 4 + length);
    }
  }
}

export const frame = (json: string) => `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;

/**
 * Serves /api/workspaces/:id/lsp: each connection gets its own TypeScript
 * language server in that workspace's folder, with JSON-RPC messages relayed
 * as WebSocket text frames. It reads the workspace's code, so `authorize`
 * admits the same people as terminals.
 */
export function attachLspSockets(server: Server, workspaces: WorkspaceService, authorize: (req: IncomingMessage) => boolean, start: (cwd: string) => ChildProcess = startTypeScriptServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const open = new Map<string, number>();
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
    let path: string;
    try {
      path = workspaces.workspaceOrThrow(id).path;
    } catch {
      return reject("404 Not Found");
    }
    if ((open.get(id) ?? 0) >= MAX_PER_WORKSPACE) return reject("429 Too Many Requests");
    wss.handleUpgrade(req, socket, head, (ws) => {
      open.set(id, (open.get(id) ?? 0) + 1);
      relay(ws, start(path), () => open.set(id, Math.max(0, (open.get(id) ?? 1) - 1)));
    });
  });
}

function relay(ws: WebSocket, proc: ChildProcess, onEnd: () => void): void {
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd();
    if (proc.exitCode === null) proc.kill();
    if (ws.readyState === ws.OPEN) ws.close();
  };
  const framer = new LspFramer((json) => ws.readyState === ws.OPEN && ws.send(json));
  proc.stdout?.on("data", (d: Buffer) => framer.push(d));
  proc.on("exit", end);
  proc.on("error", end);
  ws.on("message", (raw, isBinary) => {
    if (isBinary || !proc.stdin?.writable) return;
    proc.stdin.write(frame(raw.toString()));
  });
  ws.on("close", end);
}
