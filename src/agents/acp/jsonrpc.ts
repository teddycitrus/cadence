import type { Readable, Writable } from "node:stream";

/** A JSON-RPC error the other side sent back. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Handler = (params: any) => unknown;

/**
 * One end of a newline-delimited JSON-RPC 2.0 connection, as the Agent Client
 * Protocol uses over a child process's stdio. Both sides send requests, so
 * this both calls methods and serves them.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Handler>();
  private buffer = "";
  private closedError: Error | null = null;

  constructor(
    input: Readable,
    private output: Writable,
    /** Called for incoming requests and notifications nobody registered for. */
    private fallback?: (method: string, params: unknown) => unknown,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.read(chunk));
    // Output closes just before a process exits; give the owner a moment to fail
    // pending calls with the exit reason, which is more useful than this.
    input.on("end", () => setTimeout(() => this.fail(new Error("The agent process closed its output")), 250).unref?.());
    input.on("error", (err) => this.fail(err));
  }

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closedError) this.write({ jsonrpc: "2.0", method, params });
  }

  /** Rejects every call still waiting, for when the process goes away. */
  fail(err: Error): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private write(message: unknown): void {
    try {
      this.output.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // agents sometimes log plain text to stdout; skip it
      }
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: any): Promise<void> {
    if (msg && "id" in msg && !("method" in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code ?? -32603, msg.error.message ?? "Agent error", msg.error.data));
      else p.resolve(msg.result ?? null);
      return;
    }
    if (!msg || typeof msg.method !== "string") return;
    const handler = this.handlers.get(msg.method);
    const isRequest = "id" in msg && msg.id !== null && msg.id !== undefined;
    try {
      const result = handler ? await handler(msg.params) : this.fallback ? await this.fallback(msg.method, msg.params) : undefined;
      if (!handler && !this.fallback && isRequest) {
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        return;
      }
      if (isRequest) this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
    } catch (err) {
      if (isRequest) {
        const code = err instanceof RpcError ? err.code : -32603;
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
      }
    }
  }
}
