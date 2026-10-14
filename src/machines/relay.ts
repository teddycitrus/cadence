import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Tunnel } from "./tunnel";

// The hub's side of a machine: each port the machine shares gets a listener
// on the hub, so pages from the machine run with their usual absolute paths.
// URLs pointing at the machine's own ports are rewritten to these listeners
// on the way out, and back again on the way in.

const LOCAL = /\b(https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})/g;
const REWRITE_TYPES = /json|html|javascript|ecmascript|css|text\/plain|svg|xml/;

export interface RelayHost {
  /** The tunnel to the machine, while it is connected. */
  tunnel(): Tunnel | null;
  /** Whether this request comes from someone allowed to use the machine. */
  authorize(req: IncomingMessage): boolean;
  /** The relay for one of the machine's ports, started on first use. */
  relayFor(port: number): Promise<Relay>;
  /** How the browser reaches the hub: the hostname relays are addressed by. */
  publicHost(): string;
  /** Interface the relay listeners bind to. */
  bindHost: string;
}

export class Relay {
  private server: Server;
  port = 0;

  constructor(
    private host: RelayHost,
    readonly remotePort: number,
  ) {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, this.host.bindHost, () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  /** This relay as the browser reaches it, by the hostname it used (or the hub's). */
  origin(scheme = "http", hostname = this.host.publicHost()): string {
    return `${scheme}://${hostname}:${this.port}`;
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  /** Headers as the machine should see them: a local request, without hub credentials. */
  private upstreamHeaders(req: IncomingMessage): IncomingHttpHeaders {
    const h: IncomingHttpHeaders = { ...req.headers, host: `127.0.0.1:${this.remotePort}`, "accept-encoding": "identity" };
    for (const k of ["origin", "referer"] as const) {
      const v = h[k];
      if (typeof v === "string") h[k] = v.replace(new RegExp(`^(https?)://[^/]+:${this.port}(?=/|$)`), `$1://127.0.0.1:${this.remotePort}`);
    }
    // The hub's session cookies never leave the hub.
    if (h.cookie) {
      const kept = h.cookie.split(";").filter((c) => !c.trim().startsWith("cadence_session"));
      if (kept.length) h.cookie = kept.join(";");
      else delete h.cookie;
    }
    // Nor does an API token meant for the hub.
    delete h.authorization;
    delete h["x-forwarded-for"];
    delete h.forwarded;
    return h;
  }

  /** Points every URL at one of the machine's ports to that port's relay. */
  async rewrite(text: string, hostname?: string): Promise<string> {
    const ports = new Set([...text.matchAll(LOCAL)].map((m) => Number(m[2])));
    const relays = new Map<number, Relay>();
    for (const p of ports) relays.set(p, p === this.remotePort ? this : await this.host.relayFor(p));
    return text.replace(LOCAL, (_m, scheme: string, port: string) => relays.get(Number(port))!.origin(scheme, hostname));
  }

  private refuse(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Cadence</title><body style="font:14px system-ui;padding:40px;background:#e6d1af;color:#4b2434">${message}</body>`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.host.authorize(req)) return this.refuse(res, 401, "Sign in to the hub as an owner or admin, then open the computer again from Settings &gt; Computers.");
    const tunnel = this.host.tunnel();
    if (!tunnel) return this.refuse(res, 502, "This machine is not connected to the hub right now.");
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "") || undefined;
    const upstream = request({ method: req.method, path: req.url, headers: this.upstreamHeaders(req), createConnection: () => tunnel.open(this.remotePort) as unknown as import("node:net").Socket });
    upstream.on("error", (err) => (res.headersSent ? res.destroy() : this.refuse(res, 502, `Could not reach the machine: ${err.message}`)));
    req.pipe(upstream);
    upstream.on("response", async (up) => {
      const headers = { ...up.headers };
      if (Array.isArray(headers["set-cookie"])) headers["set-cookie"] = headers["set-cookie"].filter((c) => !c.startsWith("cadence_session"));
      for (const k of ["location", "access-control-allow-origin", "content-security-policy"]) {
        const v = headers[k];
        if (typeof v === "string") headers[k] = await this.rewrite(v, hostname);
      }
      const type = String(headers["content-type"] ?? "");
      if (!REWRITE_TYPES.test(type) || type.includes("event-stream") || headers["content-encoding"]) {
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      up.on("data", (c: Buffer) => chunks.push(c));
      up.on("error", () => res.destroy());
      up.on("end", async () => {
        const body = Buffer.from(await this.rewrite(Buffer.concat(chunks).toString("utf8"), hostname), "utf8");
        delete headers["transfer-encoding"];
        headers["content-length"] = String(body.length);
        res.writeHead(up.statusCode ?? 502, headers);
        res.end(body);
      });
    });
  }

  /** WebSockets (terminals, live updates, HMR) pass through as raw bytes after the handshake. */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const tunnel = this.host.tunnel();
    if (!this.host.authorize(req) || !tunnel) {
      socket.end(`HTTP/1.1 ${tunnel ? "401 Unauthorized" : "502 Bad Gateway"}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const stream = tunnel.open(this.remotePort);
    const headers = this.upstreamHeaders(req);
    delete headers["accept-encoding"];
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
    stream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) stream.write(head);
    stream.pipe(socket);
    socket.pipe(stream);
    socket.on("error", () => stream.destroy());
    stream.on("error", () => socket.destroy());
    stream.on("close", () => socket.destroy());
    socket.on("close", () => stream.destroy());
  }
}
