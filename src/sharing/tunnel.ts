import { spawn, type ChildProcess } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { killTree } from "../core/kill-tree";

// One cloudflared process giving a local port a public HTTPS address: a quick
// tunnel (a fresh *.trycloudflare.com address each time, no account needed)
// or a named tunnel run from a token, for an address of the person's own.

export type TunnelSpec =
  | { kind: "quick"; port: number; /** Sent to the local server as Host, for servers that check it. */ hostHeader?: string }
  | { kind: "named"; token: string; url: string };

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** cloudflared logs this once a named tunnel's connection is up. */
const NAMED_READY = /Registered tunnel connection|Connection [0-9a-f-]+ registered/;

export class Tunnel {
  private proc: ChildProcess | null = null;
  url: string | null = null;
  private exitHandlers = new Set<(error: string | null) => void>();

  constructor(
    private binary: string,
    readonly spec: TunnelSpec,
    private options: {
      /** Arguments before cloudflared's own (tests run a stand-in script through node). */
      prefix?: string[];
      /** Wait for a quick tunnel's new hostname to resolve before handing it out (off in tests). */
      waitForDns?: boolean;
    } = {},
  ) {}

  /** Starts cloudflared and resolves to the public address once it is reachable. */
  start(timeoutMs = 75_000): Promise<string> {
    const args =
      this.spec.kind === "quick"
        ? ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.spec.port}`, ...(this.spec.hostHeader ? ["--http-host-header", this.spec.hostHeader] : [])]
        : ["tunnel", "--no-autoupdate", "run", "--token", this.spec.token];
    const proc = spawn(this.binary, [...(this.options.prefix ?? []), ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    return new Promise((resolve, reject) => {
      let log = "";
      let announced = false;
      const timer = setTimeout(() => fail(`cloudflared did not connect within ${Math.round(timeoutMs / 1000)} seconds`), timeoutMs);
      const settle = (url: string) => {
        clearTimeout(timer);
        this.url = url;
        resolve(url);
      };
      const fail = (message: string) => {
        clearTimeout(timer);
        this.stop();
        reject(new Error(message));
      };
      const read = (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-8000);
        if (this.url) return;
        if (this.spec.kind === "quick") {
          const m = QUICK_URL.exec(log);
          if (m && !announced) {
            announced = true;
            const url = m[0];
            // A brand-new hostname takes a few seconds to reach DNS; a browser that looks it up
            // too early caches "not found" and the page fails until it is reloaded.
            void (this.options.waitForDns === false ? Promise.resolve() : resolvable(new URL(url).hostname)).then(() => proc.exitCode === null && settle(url));
          }
        } else if (NAMED_READY.test(log)) settle(this.spec.url);
      };
      proc.stdout?.on("data", read);
      proc.stderr?.on("data", read);
      proc.once("error", (err) => fail(`cloudflared could not start: ${err.message}`));
      proc.once("exit", (code) => {
        this.proc = null;
        if (!this.url) fail(lastError(log) ?? `cloudflared stopped (exit code ${code})`);
        const error = code === 0 || code === null ? null : (lastError(log) ?? `cloudflared stopped (exit code ${code})`);
        this.url = null;
        for (const h of this.exitHandlers) h(error);
      });
    });
  }

  /** Called when the tunnel ends on its own after starting (a lost connection, a revoked token). */
  onExit(handler: (error: string | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  get running(): boolean {
    return Boolean(this.proc);
  }

  stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.url = null;
    return proc ? killTree(proc) : Promise.resolve();
  }
}

/**
 * Resolves once public DNS (Cloudflare's and Google's resolvers, asked directly so this machine's
 * own cache never stores an early "not found") has the hostname, or after the timeout anyway.
 */
export async function resolvable(hostname: string, timeoutMs = 40_000): Promise<boolean> {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await resolver.resolve4(hostname)).length) return true;
    } catch {
      // not there yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** The last error line cloudflared logged, for showing why a tunnel failed. */
function lastError(log: string): string | null {
  const line = log
    .split(/\r?\n/)
    .reverse()
    .find((l) => /\b(ERR|error|failed)\b/i.test(l));
  return line ? line.replace(/^\S+\s+(ERR|INF|WRN)\s+/, "").trim().slice(0, 300) : null;
}
