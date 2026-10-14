import WebSocket from "ws";

/** A Slack Events API event as delivered inside a Socket Mode envelope. */
export interface SlackEventEnvelope {
  event_id?: string;
  team_id?: string;
  event: Record<string, unknown> & { type: string };
}

export interface SocketModeOptions {
  /** Returns a fresh wss:// URL (apps.connections.open). */
  openUrl: () => Promise<string>;
  onEvent: (e: SlackEventEnvelope) => void;
  onStatus?: (status: "connecting" | "connected" | "disconnected", detail?: string) => void;
  /** For tests. */
  createSocket?: (url: string) => WebSocket;
}

/**
 * Slack Socket Mode: Slack pushes events over a WebSocket Cadence opens, so a
 * local app needs no public URL. Every envelope is acknowledged right away
 * (Slack retries unacknowledged ones), then handled.
 */
export class SocketModeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private o: SocketModeOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    this.o.onStatus?.("disconnected");
  }

  private retry(detail: string): void {
    if (this.stopped) return;
    this.o.onStatus?.("disconnected", detail);
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6));
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.o.onStatus?.("connecting");
    let url: string;
    try {
      url = await this.o.openUrl();
    } catch (err) {
      return this.retry(err instanceof Error ? err.message : String(err));
    }
    if (this.stopped) return;
    const ws = this.o.createSocket ? this.o.createSocket(url) : new WebSocket(url);
    this.ws = ws;
    ws.on("message", (raw) => {
      let msg: { type?: string; envelope_id?: string; payload?: SlackEventEnvelope; reason?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === "hello") {
        this.attempt = 0;
        this.o.onStatus?.("connected");
      } else if (msg.type === "disconnect") {
        // Slack rotates connections; open a new one before this closes.
        ws.removeAllListeners();
        ws.close();
        void this.connect();
      } else if (msg.type === "events_api" && msg.payload?.event) {
        this.o.onEvent(msg.payload);
      }
    });
    ws.on("close", () => {
      if (this.ws === ws) this.retry("connection closed");
    });
    ws.on("error", (err) => {
      if (this.ws === ws) {
        ws.removeAllListeners();
        this.retry(err.message);
      }
    });
  }
}
