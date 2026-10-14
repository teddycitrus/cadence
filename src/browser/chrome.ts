import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

/** Chrome or Edge on this machine (CADENCE_CHROME overrides). */
export function findChrome(): string | null {
  const env = process.env.CADENCE_CHROME;
  if (env && existsSync(env)) return env;
  const pf = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates =
    process.platform === "win32"
      ? [
          join(pf, "Google\\Chrome\\Application\\chrome.exe"),
          join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
          join(local, "Google\\Chrome\\Application\\chrome.exe"),
          join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
          join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export class BrowserError extends Error {}

/**
 * Electron's binary and the browser host script (src/desktop/browser-host.cjs),
 * for machines with no Chrome or Edge: the desktop app's own Chromium, or the
 * electron package when run from source.
 */
export function electronHost(): { binary: string; script: string } | null {
  const script = fileURLToPath(new URL("../desktop/browser-host.cjs", import.meta.url));
  if (!existsSync(script)) return null;
  if (process.versions.electron) return { binary: process.execPath, script };
  try {
    const binary = createRequire(import.meta.url)("electron") as unknown;
    return typeof binary === "string" && existsSync(binary) ? { binary, script } : null;
  } catch {
    return null;
  }
}

// DevTools cannot open or close tabs in Electron; the host does it when asked.
const HOST_OPS: Record<string, string> = { "Target.createTarget": "open", "Target.closeTarget": "close", "Browser.setDownloadBehavior": "downloads" };


type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

/**
 * One headless Chrome process and its DevTools connection. Commands go to
 * the browser or, with a session id, to one attached tab.
 */
export class ChromeConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private closeHandlers = new Set<() => void>();
  closed = false;

  private hostRequests = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  private constructor(
    private proc: ChildProcess,
    private ws: WebSocket,
    /** Electron's Chromium rather than Chrome: tab creation goes through the host process. */
    readonly electron = false,
  ) {
    if (electron) {
      proc.on("message", (m: { id: number; result?: Record<string, unknown>; error?: string }) => {
        const p = this.hostRequests.get(m.id);
        this.hostRequests.delete(m.id);
        if (m.error) p?.reject(new BrowserError(m.error));
        else p?.resolve(m.result ?? {});
      });
    }
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new BrowserError(msg.error.message));
        else p?.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of this.listeners.get(msg.method) ?? []) l(msg.params ?? {}, msg.sessionId);
      }
    });
    ws.on("close", () => this.fail());
    proc.once("exit", () => this.fail());
  }

  /** Starts Chrome with the given profile folder (kept between runs when it is a fixed path). */
  static async launch(profileDir: string, extraArgs: string[] = []): Promise<ChromeConnection> {
    // Chrome or Edge when installed; otherwise Electron's Chromium. CADENCE_BROWSER=chrome|electron picks one.
    const choice = process.env.CADENCE_BROWSER;
    const chrome = choice === "electron" ? null : findChrome();
    const host = !chrome && choice !== "chrome" ? electronHost() : null;
    if (!chrome && !host) throw new BrowserError("No Chrome or Edge found. Install Chrome or set CADENCE_CHROME to its path.");
    // CADENCE_CHROME_ARGS adds flags for unusual hosts, such as --no-sandbox in CI containers.
    const envArgs = (process.env.CADENCE_CHROME_ARGS ?? "").split(/\s+/).filter((a) => a.startsWith("--"));
    const hostEnv = { ...process.env };
    delete hostEnv.ELECTRON_RUN_AS_NODE;
    hostEnv.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
    const proc = chrome
      ? spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "--disable-extensions", ...envArgs, ...extraArgs, "about:blank"], {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        })
      : spawn(host!.binary, [host!.script, `--user-data-dir=${profileDir}`, ...envArgs, ...extraArgs], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true, env: hostEnv });
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new BrowserError("Chrome did not start in time")), 20_000);
      proc.stderr!.on("data", (d) => {
        buf += String(d);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      proc.once("exit", () => {
        clearTimeout(timer);
        reject(new BrowserError(/already in use|ProcessSingleton/i.test(buf) ? "The browser profile is in use by another Chrome" : "Chrome exited before it was ready"));
      });
    });
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new ChromeConnection(proc, ws, !chrome);
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of [...this.pending.values(), ...this.hostRequests.values()]) p.reject(new BrowserError("Chrome closed"));
    this.pending.clear();
    this.hostRequests.clear();
    for (const h of this.closeHandlers) h();
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserError("Chrome closed"));
    const op = this.electron && !sessionId ? HOST_OPS[method] : undefined;
    if (op) {
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.hostRequests.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
        this.proc.send?.({ id, op, ...params });
      });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Ends Chrome; resolves once the process has exited (so its profile folder can be removed). */
  close(): Promise<void> {
    const exited = this.proc.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.ws.close();
    // Chrome's helper processes would keep the profile folder locked on Windows.
    // taskkill runs alongside rather than blocking the server; close() resolves once it has finished too.
    let treeKilled: Promise<void> = Promise.resolve();
    if (process.platform === "win32" && this.proc.pid !== undefined && this.proc.exitCode === null) {
      const killer = spawn("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      treeKilled = new Promise((resolve) => {
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
    } else this.proc.kill();
    this.fail();
    return Promise.all([exited, treeKilled]).then(() => undefined);
  }
}
