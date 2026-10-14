import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { APP_COMMAND } from "./app-command";

const START_TIMEOUT_MS = 180_000;
const LOG_LINES = 60;

interface Running {
  proc: ChildProcess;
  url: string;
  log: string[];
  exited: boolean;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Runs a project's own dev server (next dev, expo start --web, ...) for route
 * frames, with CADENCE=1 so the cadence-build plugins stamp source
 * locations. The port is chosen here and passed as PORT and as {port} in the
 * command.
 */
export class AppDevServers {
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<string>>();

  /** The app's URL, starting it in `cwd` if it is not running. Keyed by folder and command. */
  ensure(cwd: string, command: string): Promise<string> {
    if (!APP_COMMAND.test(command)) return Promise.reject(new Error(`"${command}" is not a dev server command Cadence will run`));
    const key = `${cwd}\0${command}`;
    const r = this.running.get(key);
    if (r && !r.exited) return Promise.resolve(r.url);
    let p = this.starting.get(key);
    if (!p) {
      p = this.start(key, cwd, command).finally(() => this.starting.delete(key));
      this.starting.set(key, p);
    }
    return p;
  }

  private async start(key: string, cwd: string, command: string): Promise<string> {
    const port = await freePort();
    const proc = spawn(command.replace(/\{port\}/g, String(port)), {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      // No CI flag: Expo turns off file watching (and so live reload) under CI. stdin is closed, so nothing prompts.
      env: { ...process.env, CADENCE: "1", PORT: String(port), BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = `http://127.0.0.1:${port}`;
    const entry: Running = { proc, url, log: [], exited: false };
    const keep = (d: Buffer) => {
      entry.log.push(...d.toString("utf8").split(/\r?\n/).filter(Boolean));
      entry.log.splice(0, Math.max(0, entry.log.length - LOG_LINES));
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
    proc.on("exit", () => (entry.exited = true));
    this.running.set(key, entry);

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (entry.exited) throw new Error(`The app's dev server stopped: ${entry.log.slice(-8).join("\n") || "no output"}`);
      try {
        await fetch(url, { signal: AbortSignal.timeout(2000) });
        return url;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    this.kill(entry);
    throw new Error(`The app's dev server did not answer on ${url} within ${START_TIMEOUT_MS / 1000}s. Last output:\n${entry.log.slice(-8).join("\n")}`);
  }

  /** Recent output of a running app, for showing why it fails. */
  log(cwd: string, command: string): string[] {
    return this.running.get(`${cwd}\0${command}`)?.log ?? [];
  }

  private kill(r: Running): void {
    if (r.exited || r.proc.pid === undefined) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(r.proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else {
      try {
        process.kill(-r.proc.pid, "SIGTERM");
      } catch {
        r.proc.kill("SIGTERM");
      }
    }
  }

  /** Whether this app's dev server is up. */
  urlOf(cwd: string, command: string): string | null {
    const r = this.running.get(`${cwd}\0${command}`);
    return r && !r.exited ? r.url : null;
  }

  /** Stops one app's dev server; returns false when it was not running. */
  stop(cwd: string, command: string): boolean {
    const key = `${cwd}\0${command}`;
    const r = this.running.get(key);
    if (!r) return false;
    this.kill(r);
    this.running.delete(key);
    return true;
  }

  stopAll(): void {
    for (const r of this.running.values()) this.kill(r);
    this.running.clear();
  }
}
