import type { IncomingMessage, Server } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocketServer, type WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { RequestIdentity } from "../auth/context";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { StoredEvent } from "../core/types";
import { ConflictError } from "../core/errors";
import { originAllowed } from "../server/terminal-socket";
import { refuseUpgrade } from "../server/refuse-upgrade";

// Wire format (as y-websocket): a varUint message type, then the payload.
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
/** Cadence control messages, as a JSON string. */
export const MSG_CONTROL = 2;

export type Control =
  /** Whether this connection writes the doc's markdown back (exactly one per room does). */
  | { type: "role"; saver: boolean }
  /** The room is empty: load this markdown into the editor (sent to one client only). */
  | { type: "seed"; markdown: string; version: number }
  /** Someone outside the room (an agent, the API) changed the doc: replace the content. */
  | { type: "reset"; markdown: string; version: number };

interface Conn {
  ws: WebSocket;
  id: number;
  clientIds: Set<number>;
}

interface Room {
  docId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Conn>;
  saver: Conn | null;
  seeded: boolean;
  /** The doc version the room's content matches (seeded, saved, or reset). */
  version: number;
  /** True while the room's own save is being written, so it is not echoed back as a reset. */
  saving: boolean;
}

const PATH = /^\/api\/docs\/([0-9a-f-]{36})\/collab$/;

function send(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState === ws.OPEN) ws.send(data);
}

function control(ws: WebSocket, msg: Control): void {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_CONTROL);
  encoding.writeVarString(e, JSON.stringify(msg));
  send(ws, encoding.toUint8Array(e));
}

/**
 * Live co-editing of docs. A room per open doc relays Yjs updates and cursor
 * awareness between editors. The markdown body stays the source of truth: one
 * connection per room (the saver) writes it back, and edits made elsewhere
 * (agents, the API) are pushed into the room.
 */
export class DocCollab {
  private rooms = new Map<string, Room>();
  private nextId = 1;
  private unsubscribe: () => void;

  constructor(
    private store: EventStore,
    private q: Queries,
  ) {
    this.unsubscribe = store.subscribe((e) => this.onEvent(e));
  }

  /**
   * Runs the saver's write. The DocUpdated event fires inside it, so the room
   * must already know the change is its own.
   */
  saveFromRoom<T>(docId: string, body: string | undefined, write: () => T): T {
    // A live room never empties a doc: that is what a not-yet-loaded editor would send.
    if (body !== undefined && !body.trim() && this.q.doc(docId)?.body.trim()) throw new ConflictError("Refusing to save an empty doc from a live editing session");
    const room = this.rooms.get(docId);
    if (!room) return write();
    room.saving = true;
    try {
      return write();
    } finally {
      room.saving = false;
    }
  }

  roomSize(docId: string): number {
    return this.rooms.get(docId)?.conns.size ?? 0;
  }

  private onEvent(e: StoredEvent): void {
    if (e.type !== "DocUpdated") return;
    const room = this.rooms.get(e.aggregateId);
    const doc = this.q.doc(e.aggregateId);
    if (!room || !doc || doc.version <= room.version || e.payload.body === undefined) return;
    if (room.saving) {
      room.version = doc.version;
      return;
    }
    // Changed outside the room: the saver loads it, which reaches everyone as Yjs updates.
    room.version = doc.version;
    if (room.saver) control(room.saver.ws, { type: "reset", markdown: doc.body, version: doc.version });
  }

  attach(server: Server, authorize: (req: IncomingMessage) => RequestIdentity | null): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = PATH.exec(url.pathname);
      if (!m) return;
      const reject = (status: string) => refuseUpgrade(socket, status);
      if (!originAllowed(req)) return reject("403 Forbidden");
      if (!authorize(req)) return reject("401 Unauthorized");
      if (!this.q.doc(m[1]!)) return reject("404 Not Found");
      wss.handleUpgrade(req, socket, head, (ws) => this.join(m[1]!, ws));
    });
  }

  private room(docId: string): Room {
    let room = this.rooms.get(docId);
    if (room) return room;
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const r: Room = { docId, doc, awareness, conns: new Map(), saver: null, seeded: false, version: this.q.doc(docId)?.version ?? 0, saving: false };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, update);
      const msg = encoding.toUint8Array(e);
      for (const c of r.conns.values()) if (c.ws !== origin) send(c.ws, msg);
    });
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const conn = origin ? r.conns.get(origin as WebSocket) : undefined;
      if (conn) {
        for (const id of added) conn.clientIds.add(id);
        for (const id of removed) conn.clientIds.delete(id);
      }
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      const msg = encoding.toUint8Array(e);
      for (const c of r.conns.values()) send(c.ws, msg);
    });
    this.rooms.set(docId, r);
    return r;
  }

  private join(docId: string, ws: WebSocket): void {
    const room = this.room(docId);
    const conn: Conn = { ws, id: this.nextId++, clientIds: new Set() };
    room.conns.set(ws, conn);
    if (!room.saver) room.saver = conn;
    control(ws, { type: "role", saver: room.saver === conn });

    // Start the sync handshake and share who else is here.
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, room.doc);
    send(ws, encoding.toUint8Array(e));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      send(ws, encoding.toUint8Array(a));
    }
    // An empty room is seeded from the markdown by exactly one client.
    if (!room.seeded && room.doc.getXmlFragment("default").length === 0) {
      room.seeded = true;
      const doc = this.q.doc(docId)!;
      room.version = doc.version;
      control(ws, { type: "seed", markdown: doc.body, version: doc.version });
    } else room.seeded = true;

    ws.on("message", (raw: Buffer) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(raw));
        const type = decoding.readVarUint(decoder);
        if (type === MSG_SYNC) {
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, MSG_SYNC);
          syncProtocol.readSyncMessage(decoder, reply, room.doc, ws);
          if (encoding.length(reply) > 1) send(ws, encoding.toUint8Array(reply));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
        }
      } catch {
        ws.close(1003, "Bad message");
      }
    });
    ws.on("close", () => this.leave(room, conn));
  }

  private leave(room: Room, conn: Conn): void {
    room.conns.delete(conn.ws);
    awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.clientIds], null);
    if (room.saver === conn) {
      // Hand saving to someone still here.
      room.saver = room.conns.values().next().value ?? null;
      if (room.saver) control(room.saver.ws, { type: "role", saver: true });
    }
    if (room.conns.size === 0) {
      room.awareness.destroy();
      room.doc.destroy();
      this.rooms.delete(room.docId);
    }
  }

  stop(): void {
    this.unsubscribe();
    for (const room of this.rooms.values()) for (const c of room.conns.keys()) c.close();
  }
}
