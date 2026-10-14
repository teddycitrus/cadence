import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { JsonRpcPeer, RpcError } from "./jsonrpc";

export const ACP_PROTOCOL_VERSION = 1;

export interface AgentCapabilities {
  loadSession?: boolean;
  /** Newer harnesses can pick a session back up without replaying it. */
  sessionCapabilities?: { resume?: object };
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
}

export interface AcpLaunch {
  /** Harness label for messages, like "Codex". */
  label: string;
  command: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Shown when the harness says it needs a sign-in. */
  signInHint: string;
  /** A key was saved in Settings > Providers, so a key-based sign-in is worth trying. */
  hasKey?: boolean;
}

/** Inside `root`, or null. Harness file requests stay in the workspace. */
function inside(root: string, path: string): string | null {
  const full = resolve(root, path);
  const rel = relative(resolve(root), full);
  return rel.startsWith("..") || isAbsolute(rel) ? null : full;
}

/**
 * A running ACP harness: the child process, its JSON-RPC connection, and the
 * client side of the protocol that is the same for every session (file
 * access within the workspace, the handshake, sign-in).
 */
export class AcpConnection {
  readonly peer: JsonRpcPeer;
  readonly proc: ChildProcessWithoutNullStreams;
  capabilities: AgentCapabilities = {};
  authMethods: { id: string; name: string; description?: string }[] = [];
  private stderr = "";
  private killed = false;
  readonly exited: Promise<number | null>;

  constructor(private launch: AcpLaunch) {
    // A shell resolves npx, .cmd shims, and quoting the same way a terminal would.
    // Its own process group on POSIX, so closing ends the shell and the harness under it.
    this.proc = spawn(launch.command, { cwd: launch.cwd, env: launch.env, shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.proc.stdin.on("error", () => undefined);
    this.peer = new JsonRpcPeer(this.proc.stdout, this.proc.stdin);
    this.exited = new Promise((done) => {
      this.proc.on("error", (err) => {
        this.stderr += `\n${err.message}`;
        this.peer.fail(new Error(this.describeExit(null)));
        done(null);
      });
      this.proc.on("exit", (code) => {
        this.peer.fail(new Error(this.describeExit(code)));
        done(code);
      });
    });
    this.peer.on("fs/read_text_file", async (p: { path: string; line?: number; limit?: number }) => {
      const file = inside(launch.cwd, p.path);
      if (!file) throw new RpcError(-32602, `${p.path} is outside the workspace`);
      let content = await readFile(file, "utf8");
      if (p.line || p.limit) {
        const lines = content.split("\n");
        const start = Math.max(0, (p.line ?? 1) - 1);
        content = lines.slice(start, p.limit ? start + p.limit : undefined).join("\n");
      }
      return { content };
    });
    this.peer.on("fs/write_text_file", async (p: { path: string; content: string }) => {
      const file = inside(launch.cwd, p.path);
      if (!file) throw new RpcError(-32602, `${p.path} is outside the workspace`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, p.content, "utf8");
      return null;
    });
  }

  get wasKilled(): boolean {
    return this.killed;
  }

  /** Why the process ended, with the tail of what it printed. */
  describeExit(code: number | null): string {
    const tail = this.stderr.trim().split("\n").slice(-6).join("\n");
    const notFound = /not (found|recognized)|ENOENT|No such file/i.test(this.stderr);
    if (notFound) return `${this.launch.label} is not installed or its command is wrong (${this.launch.command}). Install it, or fix the command in Settings > Providers.`;
    return `${this.launch.label} stopped${code !== null ? ` (exit code ${code})` : ""}${tail ? `: ${tail}` : ""}`;
  }

  async initialize(): Promise<void> {
    const init = await this.peer.request<{ protocolVersion: number; agentCapabilities?: AgentCapabilities; authMethods?: AcpConnection["authMethods"] }>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "cadence", title: "Cadence", version: "0.1.0" },
    });
    this.capabilities = init.agentCapabilities ?? {};
    this.authMethods = init.authMethods ?? [];
  }

  /**
   * Runs a session call, signing in once if the harness asks. Only methods
   * that work without a browser are tried: API keys from Settings > Providers.
   */
  async withAuth<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof RpcError) || err.code !== -32000) throw err;
      const method = this.launch.hasKey ? this.authMethods.find((m) => /key|token|env/i.test(`${m.id} ${m.name}`)) : undefined;
      if (method) {
        try {
          await this.peer.request("authenticate", { methodId: method.id });
          return await call();
        } catch {
          // fall through to the sign-in message
        }
      }
      throw new Error(`${this.launch.label} needs you to sign in. ${this.launch.signInHint}`);
    }
  }

  /** Ends the harness and anything it started. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.peer.fail(new Error("closed"));
    if (this.proc.exitCode !== null || this.proc.pid === undefined) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else {
      try {
        process.kill(-this.proc.pid, "SIGTERM");
      } catch {
        this.proc.kill("SIGTERM");
      }
    }
  }
}
