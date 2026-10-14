import { randomUUID } from "node:crypto";
import { ConflictError, ValidationError } from "../core/errors";
import type { Queries } from "../core/queries";
import type { ChatRuntime } from "../agents/runtime";
import type { TerminalService } from "../terminal/service";
import type { WorkspaceService } from "../workspaces/service";
import type { ChatEngine } from "./engine";

interface Active {
  terminalId: string;
  sessionId: string;
  /** Transcript message ids that already existed when the CLI opened. */
  seen: Set<string>;
}

export interface CliStatus {
  active: boolean;
  terminalId: string | null;
  available: boolean;
}

/**
 * Hands a chat to the harness's own CLI in an embedded terminal, on the same
 * session, and brings the CLI's turns back into the transcript afterwards.
 * The GUI session is closed and the chat locked meanwhile, so two processes
 * never write to one session.
 */
export class CliMode {
  private active = new Map<string, Active>();

  constructor(
    private engine: ChatEngine,
    private terminals: TerminalService,
    private workspaces: WorkspaceService,
    private q: Queries,
    private runtimes: (provider: string) => ChatRuntime,
  ) {}

  private runtimeOf(chatId: string): ChatRuntime {
    return this.runtimes(this.engine.chatOrThrow(chatId).provider);
  }

  status(chatId: string): CliStatus {
    const a = this.active.get(chatId);
    return { active: Boolean(a), terminalId: a?.terminalId ?? null, available: Boolean(this.runtimeOf(chatId).cli) };
  }

  async enter(chatId: string, size: { cols?: number; rows?: number } = {}): Promise<CliStatus> {
    const runtime = this.runtimeOf(chatId);
    const cli = runtime.cli;
    if (!cli) throw new ValidationError(`The ${runtime.name} harness has no CLI mode`);
    if (this.active.has(chatId)) return this.status(chatId);
    const chat = this.engine.chatOrThrow(chatId);
    if (chat.archived) throw new ConflictError("This chat is archived");
    const ws = this.workspaces.workspaceOrThrow(chat.workspaceId);
    this.engine.lock(chatId, "This chat is open in the CLI. Switch back to the chat view to send from here.");
    try {
      // Some harness CLIs can only resume a session that already exists.
      const created = !chat.sessionId && cli.ensureSession ? await cli.ensureSession(ws.path) : null;
      const sessionId = chat.sessionId ?? created ?? randomUUID();
      const resume = Boolean(chat.sessionId ?? created);
      const seen = new Set(resume ? (await cli.transcript(sessionId, ws.path)).map((m) => m.id) : []);
      const command = cli.command({ sessionId, resume, model: chat.model, mode: chat.mode });
      const term = await this.terminals.open(ws.id, { ...size, command, title: `CLI · ${chat.title}`.slice(0, 80) });
      this.active.set(chatId, { terminalId: term.id, sessionId, seen });
      return this.status(chatId);
    } catch (err) {
      this.engine.unlock(chatId);
      throw err;
    }
  }

  /** Closes the CLI and imports what happened there. Returns how many messages came back. */
  async exit(chatId: string): Promise<{ imported: number }> {
    const a = this.active.get(chatId);
    if (!a) return { imported: 0 };
    this.active.delete(chatId);
    this.terminals.close(a.terminalId);
    try {
      const chat = this.engine.chatOrThrow(chatId);
      const ws = this.q.workspace(chat.workspaceId);
      const cli = this.runtimes(chat.provider).cli;
      const transcript = ws && cli ? await cli.transcript(a.sessionId, ws.path) : [];
      const fresh = transcript.filter((m) => !a.seen.has(m.id));
      const items = fresh.flatMap((m) => m.items);
      // A brand-new session the CLI never wrote to is not worth remembering.
      const sessionId = transcript.length ? a.sessionId : null;
      this.engine.importItems(chatId, [...(items.length ? [{ kind: "notice" as const, text: "Continued in the CLI", tone: "info" as const }] : []), ...items], sessionId);
      return { imported: fresh.length };
    } finally {
      this.engine.unlock(chatId);
    }
  }

  exitAll(): void {
    for (const chatId of [...this.active.keys()]) void this.exit(chatId).catch(() => undefined);
  }
}
