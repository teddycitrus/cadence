import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_CONTROL = 2;

export type Control = { type: "role"; saver: boolean } | { type: "seed"; markdown: string; version: number } | { type: "reset"; markdown: string; version: number };

type Status = "connecting" | "connected" | "offline";

/**
 * Connects one open doc to its live editing room: Yjs document updates,
 * cursor awareness, and Cadence's control messages (who saves, seeding, and
 * edits made outside the room). Reconnects on its own.
 */
export class CollabProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  status: Status = "connecting";
  saver = false;
  synced = false;
  /** This client was asked to seed the empty room; content is not ready until it does. */
  gotSeed = false;
  private ws: WebSocket | null = null;
  private destroyed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(c: Control | { type: "status" }) => void>();
  /** A seed or reset not yet applied by an editor (it can arrive before the editor mounts). */
  private load: Extract<Control, { type: "seed" | "reset" }> | null = null;

  constructor(private docId: string) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.send(encoding.toUint8Array(e));
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.send(encoding.toUint8Array(e));
    });
    this.connect();
  }

  on(listener: (c: Control | { type: "status" }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The pending seed or reset, handed to exactly one taker. */
  takeLoad(): Extract<Control, { type: "seed" | "reset" }> | null {
    const l = this.load;
    this.load = null;
    return l;
  }

  private emit(c: Control | { type: "status" }): void {
    if (c.type === "seed" || c.type === "reset") this.load = c;
    for (const l of this.listeners) l(c);
  }

  private setStatus(s: Status): void {
    this.status = s;
    this.emit({ type: "status" });
  }

  private send(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/docs/${this.docId}/collab`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.setStatus("connecting");
    ws.onopen = () => {
      this.setStatus("connected");
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep1(e, this.doc);
      this.send(encoding.toUint8Array(e));
      if (this.awareness.getLocalState()) {
        const a = encoding.createEncoder();
        encoding.writeVarUint(a, MSG_AWARENESS);
        encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
        this.send(encoding.toUint8Array(a));
      }
    };
    ws.onmessage = (ev) => {
      const decoder = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      const type = decoding.readVarUint(decoder);
      if (type === MSG_SYNC) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MSG_SYNC);
        const kind = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
        if (encoding.length(reply) > 1) this.send(encoding.toUint8Array(reply));
        if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.emit({ type: "status" });
        }
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
      } else if (type === MSG_CONTROL) {
        const c = JSON.parse(decoding.readVarString(decoder)) as Control;
        if (c.type === "role") this.saver = c.saver;
        if (c.type === "seed") this.gotSeed = true;
        this.emit(c);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.synced = false;
      // Others' cursors are stale until the room answers again.
      awarenessProtocol.removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID), this);
      if (this.destroyed) return;
      this.setStatus("offline");
      this.retry = setTimeout(() => this.connect(), 1500);
    };
  }

  /** Others currently in the room (not counting this tab). */
  peers(): { name: string; color: string }[] {
    return [...this.awareness.getStates().entries()].filter(([id, s]) => id !== this.doc.clientID && s.user).map(([, s]) => s.user as { name: string; color: string });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retry) clearTimeout(this.retry);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.ws?.close();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
