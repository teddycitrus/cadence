import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { ValidationError } from "../core/errors";
import { Tunnel } from "./tunnel";

// This machine's connection to a hub: another Cadence that its admins use to
// open this machine's Cadence from anywhere. The machine dials out, so it
// needs no open ports.

export interface LinkConfig {
  hubUrl: string;
  token: string;
}

export interface LinkStatus {
  hubUrl: string | null;
  machineName: string | null;
  state: "off" | "connecting" | "connected" | "error";
  error: string | null;
  connectedAt: string | null;
}

const TOKEN = /^cdm\.([\w-]{1,100})\.([0-9a-f-]{36})\.([\w-]{20,100})$/;
const HOST_PORT = /(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})/g;

export function parseToken(token: string): { org: string; machineId: string } | null {
  const m = TOKEN.exec(token.trim());
  return m ? { org: m[1]!, machineId: m[2]! } : null;
}

export function normalizeHubUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new ValidationError("The hub address must be a URL like https://cadence.example.com");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ValidationError("The hub address must start with http:// or https://");
  return u.origin;
}

export class MachineLink {
  private config: LinkConfig | null = null;
  private tunnel: Tunnel | null = null;
  private ws: WebSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private stopped = false;
  private status: LinkStatus = { hubUrl: null, machineName: null, state: "off", error: null, connectedAt: null };
  /** Ports the hub may reach: Cadence itself, and ports Cadence's own responses point at (canvas servers). */
  private allowed = new Set<number>();

  constructor(
    private dataDir: string,
    private port: number,
    private version = "0.1.0",
  ) {
    this.allowed.add(port);
  }

  private get file(): string {
    return join(this.dataDir, "hub.json");
  }

  /** Connects with the saved settings, or CADENCE_HUB_URL and CADENCE_MACHINE_TOKEN. */
  start(): void {
    const env = process.env.CADENCE_HUB_URL && process.env.CADENCE_MACHINE_TOKEN ? { hubUrl: process.env.CADENCE_HUB_URL, token: process.env.CADENCE_MACHINE_TOKEN } : null;
    let saved: LinkConfig | null = null;
    try {
      if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, "utf8")) as LinkConfig;
    } catch {
      saved = null;
    }
    const config = env ?? saved;
    if (config) this.use(config);
  }

  /** Saves new settings and connects with them. */
  set(config: LinkConfig): LinkStatus {
    const hubUrl = normalizeHubUrl(config.hubUrl);
    if (!parseToken(config.token)) throw new ValidationError("That is not a machine token. Copy it from the hub's Settings > Computers.");
    writeFileSync(this.file, JSON.stringify({ hubUrl, token: config.token.trim() }, null, 2), { mode: 0o600 });
    this.use({ hubUrl, token: config.token.trim() });
    return this.current();
  }

  /** Disconnects and forgets the hub. */
  clear(): LinkStatus {
    rmSync(this.file, { force: true });
    this.disconnect();
    this.config = null;
    this.status = { hubUrl: null, machineName: null, state: "off", error: null, connectedAt: null };
    return this.current();
  }

  current(): LinkStatus {
    return { ...this.status };
  }

  stop(): void {
    this.stopped = true;
    this.disconnect();
  }

  private use(config: LinkConfig): void {
    this.disconnect();
    this.config = config;
    this.stopped = false;
    this.backoff = 1000;
    this.status = { hubUrl: config.hubUrl, machineName: null, state: "connecting", error: null, connectedAt: null };
    this.dial();
  }

  private disconnect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.tunnel?.close();
    this.tunnel = null;
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = null;
  }

  private dial(): void {
    const config = this.config;
    if (!config || this.stopped) return;
    const parsed = parseToken(config.token)!;
    const url = `${config.hubUrl.replace(/^http/, "ws")}/api/machines/connect?org=${encodeURIComponent(parsed.org)}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${config.token}` }, handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on("unexpected-response", (_req, res) => {
      const refused = res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404;
      this.status = { ...this.status, state: "error", error: refused ? "The hub refused this token. It may have been removed; make a new one on the hub." : `The hub answered ${res.statusCode}` };
      ws.terminate();
      // A refused token stays refused; anything else is worth retrying.
      if (!refused) this.later();
    });
    ws.on("open", () => {
      this.backoff = 1000;
      const tunnel = new Tunnel(ws);
      this.tunnel = tunnel;
      tunnel.on("open", (id, port) => this.forward(tunnel, id, port));
      tunnel.on("hello", (info) => (this.status = { ...this.status, machineName: info.hostname }));
      tunnel.control({ t: "hello", info: { hostname: hostname(), platform: platform(), version: this.version, port: this.port } });
      this.status = { ...this.status, state: "connected", error: null, connectedAt: new Date().toISOString() };
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.tunnel = null;
      if (this.status.state === "connected") this.status = { ...this.status, state: "connecting", connectedAt: null };
      this.later();
    });
    ws.on("error", (err) => {
      if (this.ws === ws && this.status.state !== "error") this.status = { ...this.status, state: "connecting", error: err.message };
    });
  }

  private later(): void {
    if (this.stopped || this.retry || !this.config) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.ws?.readyState !== WebSocket.OPEN) this.dial();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  /** Pipes a stream the hub opened to a local port, if that port is shared. */
  private forward(tunnel: Tunnel, id: number, port: number): void {
    if (!this.allowed.has(port)) return tunnel.refuse(id, `Port ${port} is not shared with the hub`);
    const stream = tunnel.accept(id);
    const socket = connect(port, "127.0.0.1");
    let carry = "";
    socket.on("data", (chunk: Buffer) => {
      if (port !== this.port) return;
      // Learn the ports Cadence points the browser at (canvas and app servers).
      const text = carry + chunk.toString("latin1");
      for (const m of text.matchAll(HOST_PORT)) this.allowed.add(Number(m[1]));
      carry = text.slice(-24);
    });
    stream.pipe(socket);
    socket.pipe(stream);
    socket.on("error", (err) => stream.destroy(err));
    stream.on("error", () => socket.destroy());
    stream.on("close", () => socket.destroy());
    socket.on("close", () => stream.destroy());
  }
}
