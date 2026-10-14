import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Interaction, Machine } from "../core/types";
import { parseToken } from "./link";
import { Relay, type RelayHost } from "./relay";
import { Tunnel, type MachineInfo } from "./tunnel";

// The hub's side of machines: the computers it may open, their live
// connections, and the relays that serve them to the hub's admins.

/** A machine as browsers see it: no token hash, plus whether it is online now. */
export type MachineView = Omit<Machine, "tokenHash"> & { online: boolean; port: number | null };

export interface MachineSummary {
  workspaces: number;
  /** The machine's projects, to start a workspace in from the hub. */
  projects: { id: string; name: string }[];
  /** Open workspaces, newest first, with their latest chat to jump into. */
  recent: { id: string; name: string; branch: string | null; chatId: string | null }[];
  runningChats: { id: string; title: string }[];
  pending: { id: string; chatId: string; chatTitle: string; kind: "tool" | "question" | "plan"; title: string; detail: string }[];
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

interface Live {
  tunnel: Tunnel;
  info: MachineInfo;
  relays: Map<number, Promise<Relay>>;
}

export class MachineHub {
  private live = new Map<string, Live>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  private publicHost = "127.0.0.1";
  private authorize: (req: IncomingMessage) => boolean = () => false;
  private bindHost = "127.0.0.1";

  constructor(
    private store: EventStore,
    private q: Queries,
    private org: () => string,
  ) {}

  /** Who may use machines (owner and admins of this org) and where relays listen. */
  configure(o: { authorize: (req: IncomingMessage) => boolean; bindHost: string }): void {
    this.authorize = o.authorize;
    this.bindHost = o.bindHost;
  }

  list(): MachineView[] {
    return this.q.machines().map((m) => this.view(m));
  }

  private view({ tokenHash: _t, ...m }: Machine): MachineView {
    const live = this.live.get(m.id);
    return { ...m, online: Boolean(live), port: live?.info.port ?? null };
  }

  /** Registers a machine and returns its connect token, shown once. */
  add(name: string): { machine: MachineView; token: string } {
    const clean = name.trim();
    if (!clean || clean.length > 80) throw new ValidationError("Give the machine a name (up to 80 characters)");
    const id = randomUUID();
    const token = `cdm.${this.org()}.${id}.${randomBytes(24).toString("base64url")}`;
    this.store.append({ aggregate: "machine", type: "MachineAdded", aggregateId: id, payload: { name: clean, tokenHash: hash(token) } });
    return { machine: this.view(this.q.machine(id)!), token };
  }

  rename(id: string, name: string): MachineView {
    const clean = name.trim();
    if (!clean || clean.length > 80) throw new ValidationError("Give the machine a name (up to 80 characters)");
    if (!this.q.machine(id)) throw new NotFoundError("Machine not found");
    this.store.append({ aggregate: "machine", type: "MachineRenamed", aggregateId: id, payload: { name: clean } });
    return this.view(this.q.machine(id)!);
  }

  remove(id: string): void {
    if (!this.q.machine(id)) throw new NotFoundError("Machine not found");
    this.drop(id);
    this.store.append({ aggregate: "machine", type: "MachineRemoved", aggregateId: id, payload: {} });
  }

  private machineFor(token: string): Machine | null {
    const parsed = parseToken(token);
    const m = parsed && parsed.org === this.org() ? this.q.machine(parsed.machineId) : null;
    if (!m) return null;
    const a = Buffer.from(hash(token));
    const b = Buffer.from(m.tokenHash);
    return a.length === b.length && timingSafeEqual(a, b) ? m : null;
  }

  /** The WebSocket machines connect to: /api/machines/connect with their token. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const auth = req.headers.authorization ?? "";
    const machine = auth.startsWith("Bearer ") ? this.machineFor(auth.slice(7)) : null;
    if (!machine) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // A machine that reconnects replaces its old connection.
      this.drop(machine.id);
      const tunnel = new Tunnel(ws);
      const alive = setInterval(() => ws.ping(), 20_000);
      tunnel.on("hello", (info) => {
        const clean: MachineInfo = { hostname: String(info.hostname).slice(0, 200), platform: String(info.platform).slice(0, 40), version: String(info.version).slice(0, 40), port: Number(info.port) };
        if (!Number.isInteger(clean.port) || clean.port < 1 || clean.port > 65535) return tunnel.close();
        this.live.set(machine.id, { tunnel, info: clean, relays: new Map() });
        this.store.append({ aggregate: "machine", type: "MachineConnected", aggregateId: machine.id, payload: { hostname: clean.hostname, platform: clean.platform, version: clean.version } }, "system");
        tunnel.control({ t: "hello", info: { ...clean, hostname: machine.name } });
      });
      tunnel.on("close", () => {
        clearInterval(alive);
        if (this.live.get(machine.id)?.tunnel === tunnel) this.drop(machine.id);
      });
    });
  }

  private drop(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    for (const r of live.relays.values()) void r.then((x) => x.close(), () => undefined);
    live.tunnel.close();
  }

  private host(id: string): RelayHost {
    const hub = this;
    return {
      tunnel: () => hub.live.get(id)?.tunnel ?? null,
      authorize: (req) => hub.authorize(req),
      relayFor: (port) => hub.relayFor(id, port),
      publicHost: () => hub.publicHost,
      bindHost: hub.bindHost,
    };
  }

  private relayFor(id: string, port: number): Promise<Relay> {
    const live = this.live.get(id);
    if (!live) return Promise.reject(new ValidationError("This machine is not connected"));
    let r = live.relays.get(port);
    if (!r) {
      r = new Relay(this.host(id), port).listen();
      live.relays.set(port, r);
    }
    return r;
  }

  /** The address to open the machine's Cadence at, through the hub. */
  async open(id: string, viewerHost: string | undefined): Promise<string> {
    const live = this.live.get(id);
    if (!live) throw new ValidationError("This machine is not connected right now");
    if (viewerHost) this.publicHost = viewerHost.replace(/:\d+$/, "");
    return `${(await this.relayFor(id, live.info.port)).origin()}/`;
  }

  /** A request to the machine's own Cadence API, made by the hub. */
  private call<T>(id: string, method: string, path: string, body?: unknown): Promise<T> {
    const live = this.live.get(id);
    if (!live) return Promise.reject(new ValidationError("This machine is not connected right now"));
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          method,
          path,
          headers: { host: `127.0.0.1:${live.info.port}`, "content-type": "application/json", ...(payload ? { "content-length": String(payload.length) } : {}) },
          // No agent: an Agent would dial the port itself instead of using the tunnel.
          createConnection: () => live.tunnel.open(live.info.port) as unknown as Socket,
          timeout: 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 500) >= 400) return reject(new ValidationError(`The machine answered ${res.statusCode}: ${text.slice(0, 200)}`));
            try {
              resolve(JSON.parse(text || "null") as T);
            } catch {
              reject(new ValidationError("The machine sent something that is not JSON"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("The machine took too long to answer")));
      req.on("error", reject);
      req.end(payload);
    });
  }

  /** What is happening on the machine: running chats and what waits for a person. */
  async summary(id: string): Promise<MachineSummary> {
    const snap = await this.call<{ projects: { id: string; name: string }[]; workspaces: { id: string; name: string; branch: string | null; archived: boolean; updatedAt: string }[]; chats: { id: string; title: string; status: string; workspaceId: string | null; updatedAt: string }[]; pendingInteractions: Pick<Interaction, "id" | "chatId" | "kind" | "toolName" | "input" | "questions">[] }>(id, "GET", "/api/snapshot");
    const title = (chatId: string) => snap.chats.find((c) => c.id === chatId)?.title ?? "Chat";
    return {
      workspaces: snap.workspaces.length,
      projects: snap.projects.map((p) => ({ id: p.id, name: p.name })),
      recent: snap.workspaces
        .filter((w) => !w.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 8)
        .map((w) => ({ id: w.id, name: w.name, branch: w.branch, chatId: snap.chats.filter((c) => c.workspaceId === w.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null })),
      runningChats: snap.chats.filter((c) => c.status === "running").map((c) => ({ id: c.id, title: c.title })),
      pending: snap.pendingInteractions.map((p) => ({
        id: p.id,
        chatId: p.chatId,
        chatTitle: title(p.chatId),
        kind: p.kind,
        title: p.kind === "tool" ? p.toolName : p.kind === "plan" ? "Plan ready for review" : (p.questions[0]?.question ?? "A question"),
        detail: p.kind === "tool" ? String(p.input.command ?? p.input.description ?? p.input.file_path ?? JSON.stringify(p.input)).slice(0, 300) : "",
      })),
    };
  }

  /** Starts a workspace (and its first chat) on the machine. */
  createWorkspace(id: string, input: { projectId: string | null; name: string }): Promise<{ workspace: { id: string; name: string; branch: string | null }; chatId: string }> {
    return this.call(id, "POST", "/api/workspaces", input);
  }

  /** Answers an approval waiting on the machine, from the hub. */
  answer(id: string, interactionId: string, answer: Record<string, unknown>): Promise<unknown> {
    if (!/^[\w-]{1,100}$/.test(interactionId)) return Promise.reject(new ValidationError("Bad interaction id"));
    return this.call(id, "POST", `/api/chats/interactions/${interactionId}`, answer);
  }

  stop(): void {
    for (const id of [...this.live.keys()]) this.drop(id);
    this.wss.close();
  }
}
