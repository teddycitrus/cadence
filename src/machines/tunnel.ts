import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import type { WebSocket } from "ws";

// One WebSocket between a machine and the hub carries many TCP streams.
// Control messages are JSON text frames; stream bytes are binary frames of
// [1 byte kind][4 byte stream id][payload].

const DATA = 1;
/** Pause writers while this much is queued on the socket. */
const HIGH_WATER = 8 * 1024 * 1024;

export interface MachineInfo {
  hostname: string;
  platform: string;
  version: string;
  /** The port the machine's own Cadence listens on. */
  port: number;
}

export type Control =
  | { t: "hello"; info: MachineInfo }
  | { t: "open"; id: number; port: number }
  | { t: "end"; id: number }
  | { t: "close"; id: number; error?: string };

/** A stream through the tunnel. Looks enough like a socket for node:http. */
export class TunnelStream extends Duplex {
  remoteAddress = "127.0.0.1";
  private closedByPeer = false;

  constructor(
    private tunnel: Tunnel,
    readonly id: number,
  ) {
    super({ allowHalfOpen: true });
    // Users follow "close"; an error nobody listens for must not crash the hub.
    this.on("error", () => undefined);
  }

  _read(): void {}

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.tunnel.sendData(this.id, chunk, cb);
  }

  _final(cb: (err?: Error | null) => void): void {
    this.tunnel.control({ t: "end", id: this.id });
    cb();
  }

  _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    if (!this.closedByPeer) this.tunnel.control({ t: "close", id: this.id, ...(err ? { error: err.message } : {}) });
    this.tunnel.forget(this.id);
    cb(err);
  }

  /** The other side closed it: no need to tell them. */
  peerClosed(error?: string): void {
    this.closedByPeer = true;
    this.destroy(error ? new Error(error) : undefined);
  }

  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

/**
 * The multiplexer over one WebSocket. The hub opens streams to ports on the
 * machine; the machine accepts (or refuses) them.
 */
export class Tunnel extends EventEmitter<{ open: [id: number, port: number]; hello: [info: MachineInfo]; close: [] }> {
  private streams = new Map<number, TunnelStream>();
  private nextId = 1;
  private closed = false;

  constructor(private ws: WebSocket) {
    super();
    ws.on("message", (data, binary) => (binary ? this.onData(data as Buffer) : this.onControl(String(data))));
    ws.on("close", () => this.shutdown());
    ws.on("error", () => this.shutdown());
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Hub side: a new stream to a port on the machine. */
  open(port: number): TunnelStream {
    const stream = new TunnelStream(this, this.nextId++);
    this.streams.set(stream.id, stream);
    if (this.closed) process.nextTick(() => stream.peerClosed("The machine is not connected"));
    else this.control({ t: "open", id: stream.id, port });
    return stream;
  }

  /** Machine side: takes a stream the hub opened. */
  accept(id: number): TunnelStream {
    const stream = new TunnelStream(this, id);
    this.streams.set(id, stream);
    return stream;
  }

  refuse(id: number, error: string): void {
    this.control({ t: "close", id, error });
  }

  control(msg: Control): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendData(id: number, chunk: Buffer, cb: (err?: Error | null) => void): void {
    if (this.closed) return cb(new Error("The tunnel closed"));
    const head = Buffer.alloc(5);
    head[0] = DATA;
    head.writeUInt32BE(id, 1);
    this.ws.send(Buffer.concat([head, chunk]), { binary: true }, (err) => {
      if (err) return cb(err);
      if (this.ws.bufferedAmount < HIGH_WATER) return cb();
      const wait = setInterval(() => {
        if (this.closed || this.ws.bufferedAmount < HIGH_WATER) {
          clearInterval(wait);
          cb();
        }
      }, 20);
    });
  }

  forget(id: number): void {
    this.streams.delete(id);
  }

  close(): void {
    this.ws.close();
    this.shutdown();
  }

  private onData(frame: Buffer): void {
    if (frame.length < 5 || frame[0] !== DATA) return;
    this.streams.get(frame.readUInt32BE(1))?.push(frame.subarray(5));
  }

  private onControl(text: string): void {
    let msg: Control;
    try {
      msg = JSON.parse(text) as Control;
    } catch {
      return;
    }
    if (msg.t === "hello") this.emit("hello", msg.info);
    else if (msg.t === "open" && Number.isInteger(msg.id) && Number.isInteger(msg.port)) this.emit("open", msg.id, msg.port);
    else if (msg.t === "end") this.streams.get(msg.id)?.push(null);
    else if (msg.t === "close") this.streams.get(msg.id)?.peerClosed(msg.error);
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.streams.values()]) s.peerClosed("The machine disconnected");
    this.streams.clear();
    this.emit("close");
  }
}
