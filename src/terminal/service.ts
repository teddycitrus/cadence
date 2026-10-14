import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as pty from "node-pty";
import { findOnPath } from "../core/path-search";
import { NotFoundError, ValidationError } from "../core/errors";
import type { WorkspaceService } from "../workspaces/service";

const SCROLLBACK_CHARS = 200_000;
const MAX_TERMINALS = 20;
/** The workspace id sign-in terminals carry: they belong to no workspace. */
export const SIGN_IN = "sign-in";

export interface TerminalInfo {
  id: string;
  workspaceId: string;
  title: string;
  /** The command it was opened to run, if any (a project command). */
  command: string | null;
  alive: boolean;
  exitCode: number | null;
  createdAt: string;
}

export type TerminalMessage = { type: "output"; data: string } | { type: "exit"; code: number };

interface Live {
  info: TerminalInfo;
  proc: pty.IPty;
  scrollback: string;
  listeners: Set<(m: TerminalMessage) => void>;
}

/** The user's login shell: PowerShell on Windows, $SHELL elsewhere. */
export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.CADENCE_SHELL || "powershell.exe", args: ["-NoLogo"] };
  return { file: process.env.CADENCE_SHELL || process.env.SHELL || "/bin/bash", args: ["-l"] };
}

/**
 * Real shells running in workspace folders. They live as long as the server
 * (not in the event log) and keep scrollback so a reconnecting tab sees what
 * already happened.
 */
export class TerminalService {
  private terms = new Map<string, Live>();
  /** Shells told to stop that have not exited yet (they still hold their folder open). */
  private exiting = new Set<Promise<void>>();

  constructor(private workspaces: WorkspaceService) {}

  list(workspaceId?: string): TerminalInfo[] {
    return [...this.terms.values()].map((t) => t.info).filter((t) => !workspaceId || t.workspaceId === workspaceId);
  }

  get(id: string): TerminalInfo {
    const t = this.terms.get(id);
    if (!t) throw new NotFoundError("Terminal not found");
    return t.info;
  }

  async open(workspaceId: string, opts: { cols?: number; rows?: number; command?: string | null; title?: string } = {}): Promise<TerminalInfo> {
    if (this.terms.size >= MAX_TERMINALS) throw new ValidationError(`At most ${MAX_TERMINALS} terminals can be open; close one first`);
    const ws = this.workspaces.workspaceOrThrow(workspaceId);
    if (ws.archived) throw new ValidationError("Restore this workspace before opening a terminal");
    await this.workspaces.ensureOnDisk(ws);
    const shell = defaultShell();
    const proc = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: clamp(opts.cols ?? 100, 20, 500),
      rows: clamp(opts.rows ?? 30, 5, 200),
      cwd: ws.path,
      env: { ...process.env, TERM: "xterm-256color", CADENCE_WORKSPACE: ws.id, ...this.workspaces.scriptEnvFor(ws) } as Record<string, string>,
    });
    const command = opts.command?.trim() || null;
    const info = this.track(proc, workspaceId, opts.title?.trim() || command || shell.file.replace(/^.*[\\/]/, "").replace(/\.exe$/i, ""), command);
    if (command) proc.write(`${command}\r`);
    return info;
  }

  /**
   * Runs one program (a harness's own sign-in) in a terminal of its own, in the home folder,
   * outside any workspace. Only the fixed programs from agents/sign-in.ts come here.
   */
  openProgram(program: { file: string; args: string[]; title: string }, opts: { cols?: number; rows?: number } = {}): TerminalInfo {
    if (this.terms.size >= MAX_TERMINALS) throw new ValidationError(`At most ${MAX_TERMINALS} terminals can be open; close one first`);
    const found = /[\\/]/.test(program.file) ? program.file : (findOnPath(program.file) ?? program.file);
    // npm installs Windows launchers as .cmd files, which only cmd.exe can start.
    const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(found);
    const proc = pty.spawn(viaCmd ? (process.env.ComSpec ?? "cmd.exe") : found, viaCmd ? ["/d", "/s", "/c", `"${found}" ${program.args.join(" ")}`] : program.args, {
      name: "xterm-256color",
      cols: clamp(opts.cols ?? 100, 20, 500),
      rows: clamp(opts.rows ?? 30, 5, 200),
      cwd: homedir(),
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    return this.track(proc, SIGN_IN, program.title, [program.file, ...program.args].join(" "));
  }

  private track(proc: pty.IPty, workspaceId: string, title: string, command: string | null): TerminalInfo {
    const info: TerminalInfo = { id: randomUUID(), workspaceId, title, command, alive: true, exitCode: null, createdAt: new Date().toISOString() };
    const live: Live = { info, proc, scrollback: "", listeners: new Set() };
    this.terms.set(info.id, live);
    proc.onData((data) => {
      live.scrollback = (live.scrollback + data).slice(-SCROLLBACK_CHARS);
      for (const l of live.listeners) l({ type: "output", data });
    });
    proc.onExit(({ exitCode }) => {
      info.alive = false;
      info.exitCode = exitCode;
      for (const l of live.listeners) l({ type: "exit", code: exitCode });
    });
    return info;
  }

  /** Subscribes to output; the returned scrollback is what was printed before. */
  attach(id: string, listener: (m: TerminalMessage) => void): { scrollback: string; detach: () => void } {
    const t = this.terms.get(id);
    if (!t) throw new NotFoundError("Terminal not found");
    t.listeners.add(listener);
    return { scrollback: t.scrollback, detach: () => t.listeners.delete(listener) };
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id);
    if (t?.info.alive) t.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (t?.info.alive) t.proc.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
  }

  rename(id: string, title: string): TerminalInfo {
    const info = this.get(id);
    info.title = title.trim().slice(0, 80) || info.title;
    return info;
  }

  close(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    if (t.info.alive) {
      const exited = new Promise<void>((resolve) => t.proc.onExit(() => resolve()));
      this.exiting.add(exited);
      void exited.then(() => this.exiting.delete(exited));
      try {
        t.proc.kill();
      } catch {
        // already gone
        this.exiting.delete(exited);
      }
    }
    t.listeners.clear();
  }

  closeWorkspace(workspaceId: string): void {
    for (const t of this.list(workspaceId)) this.close(t.id);
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id);
  }

  /** Resolves once every closed shell has exited, or after `timeoutMs`; for shutdown and cleanup. */
  async exited(timeoutMs = 3000): Promise<void> {
    if (!this.exiting.size) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(this.exiting), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(n) ? n : min)));
}
