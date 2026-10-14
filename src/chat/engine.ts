import { randomUUID } from "node:crypto";
import { snapshotTree } from "./checkpoints";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import type { Actor, Attachment, Chat, ChatItemData, ChatMode, Effort, Interaction } from "../core/types";
import { boardTools } from "../agents/board-tools";
import { buildChatInstructions, buildInstructions } from "../agents/instructions";
import type { ApprovalAnswer, LiveSession, RuntimeEvent } from "../agents/runtime";
import type { ChatEngineDeps, Session, TurnOutcome } from "./engine-types";
import { classify, toApproval, type InteractionAnswer } from "./interactions";
import { expandMentions } from "./mentions";
import { validateSend, type SendInput } from "./send-input";
import { expandSkillCommand } from "../skills/builtin";
import { chatOwner, personalInstructions } from "./skills";
import { carryOverContext } from "./transfer";
import { chooseHarness, checkModel } from "../core/providers";
import { currentActor } from "../auth/context";

export type { SendInput } from "./send-input";

export type { ChatEngineDeps, TurnOutcome } from "./engine-types";

/**
 * Owns every live chat session. A chat keeps one harness process while it is
 * active; messages sent mid-turn are queued (or steer the turn), approvals
 * and questions pause the turn until a person answers, and idle sessions are
 * closed and resumed from their session id on the next message.
 */
export class ChatEngine {
  private sessions = new Map<string, Session>();

  constructor(private d: ChatEngineDeps) {}

  private item(chatId: string, item: ChatItemData, actor: Actor = "system"): void {
    this.d.store.append({ aggregate: "chat", type: "ChatItemAdded", aggregateId: chatId, payload: { item } }, actor);
  }

  /** Adds messages to a chat without running anything (the welcome chat's opening exchange). */
  seed(chatId: string, items: ChatItemData[]): void {
    this.chatOrThrow(chatId);
    for (const i of items) this.item(chatId, i);
  }

  private status(chatId: string, status: Chat["status"]): void {
    if (this.d.q.chat(chatId)?.status !== status) this.d.store.append({ aggregate: "chat", type: "ChatStatusChanged", aggregateId: chatId, payload: { status } }, "system");
  }

  /** The workspace's files right now, so they can be put back to before this message. */
  private async checkpoint(chat: Chat): Promise<string | null> {
    const ws = chat.workspaceId ? this.d.q.workspace(chat.workspaceId) : null;
    return ws?.branch ? snapshotTree(ws.path) : null;
  }

  chatOrThrow(id: string): Chat {
    const chat = this.d.q.chat(id);
    if (!chat) throw new NotFoundError(`Chat ${id} not found`);
    return chat;
  }

  isLive(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  /** Chats handed to another process (CLI mode) refuse GUI turns until released. */
  private locks = new Map<string, string>();

  lock(chatId: string, reason: string): void {
    const chat = this.chatOrThrow(chatId);
    if (chat.status === "running" || chat.status === "waiting") throw new ConflictError("Wait for the current turn to finish, or stop it, first");
    this.close(chatId);
    this.locks.set(chatId, reason);
  }

  unlock(chatId: string): void {
    this.locks.delete(chatId);
  }

  isLocked(chatId: string): boolean {
    return this.locks.has(chatId);
  }

  private assertUnlocked(chatId: string): void {
    const reason = this.locks.get(chatId);
    if (reason) throw new ConflictError(reason);
  }

  /** Adds items produced outside the GUI session (for example CLI turns) to the transcript. */
  importItems(chatId: string, items: ChatItemData[], sessionId: string | null): void {
    const chat = this.chatOrThrow(chatId);
    if (sessionId && chat.sessionId !== sessionId) {
      this.d.store.append({ aggregate: "chat", type: "ChatSessionStarted", aggregateId: chatId, payload: { sessionId, slashCommands: chat.slashCommands } }, "system");
    }
    for (const item of items) this.item(chatId, item, item.kind === "user" ? item.author : "system");
  }

  /** Chats left running by a previous process are marked interrupted. */
  recover(): void {
    for (const chat of this.d.q.chats()) {
      if (chat.status === "running" || chat.status === "waiting") {
        for (const it of this.d.q.interactions(chat.id).filter((i) => i.status === "pending")) {
          this.d.store.append({ aggregate: "chat", type: "InteractionResolved", aggregateId: chat.id, payload: { interactionId: it.id, status: "cancelled", resolution: "Interrupted by a restart" } }, "system");
        }
        this.d.store.append({ aggregate: "chat", type: "ChatItemAdded", aggregateId: chat.id, payload: { item: { kind: "notice", tone: "warn", text: "Interrupted when Cadence stopped. Send a message (or Continue) to pick up where it left off." } } }, "system");
        this.d.store.append({ aggregate: "chat", type: "ChatStatusChanged", aggregateId: chat.id, payload: { status: "interrupted", reason: "restart" } }, "system");
      }
    }
  }

  createChat(input: { workspaceId: string; title?: string; provider?: string; model?: string; effort?: Effort; mode?: ChatMode; agentId?: string | null; docId?: string | null; threadKey?: string | null }, actor: Actor = currentActor()): Chat {
    const ws = this.d.workspaces.workspaceOrThrow(input.workspaceId);
    if (ws.archived) throw new ConflictError("Restore this workspace before starting a chat in it");
    const settings = this.d.q.settings();
    const { provider, model } = chooseHarness(settings, input);
    const id = randomUUID();
    this.d.store.append(
      {
        aggregate: "chat",
        type: "ChatCreated",
        aggregateId: id,
        payload: {
          workspaceId: ws.id,
          title: input.title ?? "New chat",
          provider,
          model,
          effort: input.effort ?? settings.defaultEffort,
          mode: input.mode ?? "acceptEdits",
          agentId: input.agentId ?? null,
          docId: input.docId ?? null,
          threadKey: input.threadKey ?? null,
        },
      },
      actor,
    );
    return this.chatOrThrow(id);
  }

  private async open(chat: Chat): Promise<Session> {
    const existing = this.sessions.get(chat.id);
    if (existing) return existing;
    const ws = this.d.workspaces.workspaceOrThrow(chat.workspaceId);
    await this.d.workspaces.ensureOnDisk(ws);
    const agent = chat.agentId ? this.d.q.agent(chat.agentId) : null;
    const actor: Actor = agent ? `agent:${agent.id}` : `chat:${chat.id}`;
    const session: Session = {
      live: null as unknown as LiveSession,
      busy: false,
      turnWaiters: [],
      approvals: new Map(),
      idleTimer: null,
      runId: null,
      lastSessionCost: null,
      costBefore: chat.sessionId ? chat.costUsd : 0,
      outstanding: new Set(),
      stopped: false,
      lastOutcome: null,
    };
    this.sessions.set(chat.id, session);
    session.live = this.d.runtimes(chat.provider).start({
      cwd: ws.path,
      model: chat.model,
      effort: chat.effort,
      fast: chat.fast,
      remoteControl: chat.remoteControl,
      mcpServers: this.d.mcpServers?.(chat.mcpServers) ?? [],
      mode: chat.mode,
      instructions: agent ? buildInstructions(agent, this.d.q, ws) : buildChatInstructions(this.d.q, ws, chat.docId) + personalInstructions(this.d.q, chat) + carryOverContext(this.d.q, chat),
      maxTurns: this.d.q.settings().maxTurns,
      tools: boardTools({ q: this.d.q, issues: this.d.issues, docs: this.d.docs, prs: this.d.prs, extra: this.d.extraTools?.() }),
      toolContext: { actor, runId: null, issueId: ws.issueId, workspaceId: ws.id, ownerId: chatOwner(chat) },
      resumeSessionId: chat.sessionId,
      onEvent: (e) => {
        // Ignore stragglers from a session that has already been replaced or closed.
        if (this.sessions.get(chat.id) === session || e.type === "closed") this.onEvent(chat.id, e, session);
      },
      onApproval: (req) => this.requestApproval(chat.id, req.toolName, req.input, req.signal),
    });
    return session;
  }

  private armIdle(chatId: string, session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.close(chatId), this.d.idleMs ?? 15 * 60 * 1000);
    session.idleTimer.unref?.();
  }

  /** Ends a chat's harness process; the next message resumes it from its session id. */
  close(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(chatId);
    for (const [id, resolve] of session.approvals) {
      resolve({ allow: false, message: "The session was closed." });
      this.d.store.append({ aggregate: "chat", type: "InteractionResolved", aggregateId: chatId, payload: { interactionId: id, status: "cancelled", resolution: "Session closed" } }, "system");
    }
    session.approvals.clear();
    if (session.busy) {
      session.turnWaiters.splice(0).forEach((w) => w({ result: "", costUsd: 0, numTurns: 0, error: "The session was closed before the turn finished" }));
      this.status(chatId, "interrupted");
    }
    session.live.close();
  }

  private deliver(chatId: string, session: Session, input: SendInput, steer: boolean): void {
    // A built-in workflow's slash command becomes its instructions; the transcript keeps what was typed.
    const text = expandSkillCommand(input.text) + expandMentions(input.mentions ?? [], this.d.q);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.busy = true;
    this.status(chatId, "running");
    this.d.bus.emit({ type: "delta_reset", chatId });
    const id = randomUUID();
    if (!steer) session.stopped = false;
    session.outstanding.add(id);
    session.live.send({ id, text, attachments: input.attachments ?? [], priority: steer ? "now" : "next" });
  }

  /**
   * Sends a message. If the chat is mid-turn it is queued (shown to the
   * user, editable) unless `steer` is set, which folds it into the turn now.
   */
  async send(chatId: string, input: SendInput, actor: Actor = currentActor(), opts: { steer?: boolean } = {}): Promise<{ queued: boolean }> {
    const chat = this.chatOrThrow(chatId);
    if (chat.archived) throw new ConflictError("This chat is archived");
    this.assertUnlocked(chatId);
    validateSend(input);
    this.d.guard?.(chat);
    const session = this.sessions.get(chatId);
    if (session?.busy && !opts.steer) {
      this.d.store.append({ aggregate: "chat", type: "MessageQueued", aggregateId: chatId, payload: { queuedId: randomUUID(), text: input.text, attachments: input.attachments ?? [] } }, actor);
      return { queued: true };
    }
    const checkpoint = opts.steer && session?.busy ? null : await this.checkpoint(chat);
    this.item(chatId, { kind: "user", text: input.text, attachments: input.attachments ?? [], author: actor, steer: Boolean(opts.steer && session?.busy), ...(checkpoint ? { checkpoint } : {}) }, actor);
    if (chat.title === "New chat" && input.text.trim()) this.rename(chatId, input.text.trim().split("\n")[0]!.slice(0, 60), "system");
    const live = session ?? (await this.open(chat));
    this.deliver(chatId, live, input, Boolean(opts.steer && session?.busy));
    return { queued: false };
  }

  /** Sends a message and waits for the turn to finish (used by agent runs). */
  async runTurn(chatId: string, text: string, actor: Actor, runId: string | null): Promise<TurnOutcome> {
    const chat = this.chatOrThrow(chatId);
    this.assertUnlocked(chatId);
    const session = await this.open(chat);
    if (session.busy) throw new ConflictError("This chat is already running");
    session.runId = runId;
    const done = new Promise<TurnOutcome>((resolve) => session.turnWaiters.push(resolve));
    const checkpoint = await this.checkpoint(chat);
    this.item(chatId, { kind: "user", text, attachments: [], author: actor, steer: false, ...(checkpoint ? { checkpoint } : {}) }, actor);
    this.deliver(chatId, session, { text }, false);
    return done;
  }

  sendQueuedNow(chatId: string, queuedId: string): Promise<{ queued: boolean }> {
    const q = this.d.q.queued(chatId).find((m) => m.id === queuedId);
    if (!q) throw new NotFoundError("That queued message was already sent or removed");
    this.d.store.append({ aggregate: "chat", type: "QueuedMessageRemoved", aggregateId: chatId, payload: { queuedId } }, "user");
    return this.send(chatId, { text: q.text, attachments: q.attachments }, "user", { steer: true });
  }

  editQueued(chatId: string, queuedId: string, text: string): void {
    if (!this.d.q.queued(chatId).some((m) => m.id === queuedId)) throw new NotFoundError("That queued message was already sent");
    this.d.store.append({ aggregate: "chat", type: "QueuedMessageEdited", aggregateId: chatId, payload: { queuedId, text } }, "user");
  }

  removeQueued(chatId: string, queuedId: string): void {
    this.d.store.append({ aggregate: "chat", type: "QueuedMessageRemoved", aggregateId: chatId, payload: { queuedId } }, "user");
  }

  async interrupt(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session?.busy) return;
    for (const [id, resolve] of session.approvals) {
      resolve({ allow: false, message: "The user stopped this turn.", interrupt: true });
      this.d.store.append({ aggregate: "chat", type: "InteractionResolved", aggregateId: chatId, payload: { interactionId: id, status: "cancelled", resolution: "Stopped" } }, "user");
    }
    session.approvals.clear();
    session.stopped = true;
    await session.live.interrupt();
  }

  async setMode(chatId: string, mode: ChatMode): Promise<void> {
    this.chatOrThrow(chatId);
    this.d.store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chatId, payload: { mode } }, "user");
    await this.sessions.get(chatId)?.live.setMode(mode);
  }

  async setModel(chatId: string, model: string): Promise<void> {
    checkModel(this.chatOrThrow(chatId).provider, model);
    this.d.store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chatId, payload: { model } }, "user");
    await this.sessions.get(chatId)?.live.setModel(model);
  }

  /** Effort is fixed per process, so an idle session restarts with the new value on the next message. */
  setEffort(chatId: string, effort: Effort): void {
    this.chatOrThrow(chatId);
    this.d.store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chatId, payload: { effort } }, "user");
    if (!this.sessions.get(chatId)?.busy) this.close(chatId);
  }

  setMcpServers(chatId: string, names: string[] | null): void {
    this.chatOrThrow(chatId);
    this.d.store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chatId, payload: { mcpServers: names } }, "user");
    if (!this.sessions.get(chatId)?.busy) this.close(chatId);
  }

  setRemoteControl(chatId: string, remoteControl: boolean): void {
    this.chatOrThrow(chatId);
    this.d.store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chatId, payload: { remoteControl } }, "user");
    if (!this.sessions.get(chatId)?.busy) this.close(chatId);
  }

  setFast(chatId: string, fast: boolean): void {
    this.chatOrThrow(chatId);
    this.d.store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chatId, payload: { fast } }, "user");
    if (!this.sessions.get(chatId)?.busy) this.close(chatId);
  }

  rename(chatId: string, title: string, actor: Actor = currentActor()): void {
    this.d.store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chatId, payload: { title } }, actor);
  }

  markRead(chatId: string): void {
    if (this.d.q.chat(chatId)?.unread) this.d.store.append({ aggregate: "chat", type: "ChatRead", aggregateId: chatId, payload: {} }, "user");
  }

  markUnread(chatId: string): void {
    if (this.chatOrThrow(chatId) && !this.d.q.chat(chatId)!.unread) this.d.store.append({ aggregate: "chat", type: "ChatMarkedUnread", aggregateId: chatId, payload: {} }, "user");
  }

  archive(chatId: string, archived: boolean): void {
    const chat = this.chatOrThrow(chatId);
    if (archived && (chat.status === "running" || chat.status === "waiting")) throw new ConflictError("Stop the chat before archiving it");
    if (archived) this.close(chatId);
    this.d.store.append({ aggregate: "chat", type: "ChatArchived", aggregateId: chatId, payload: { archived } }, "user");
  }

  delete(chatId: string): void {
    const chat = this.chatOrThrow(chatId);
    if (chat.status === "running" || chat.status === "waiting") throw new ConflictError("Stop the chat before deleting it");
    this.close(chatId);
    this.d.store.append({ aggregate: "chat", type: "ChatDeleted", aggregateId: chatId, payload: {} }, "user");
  }

  private requestApproval(chatId: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ApprovalAnswer> {
    const session = this.sessions.get(chatId);
    if (!session || signal.aborted) return Promise.resolve({ allow: false, message: "The session ended." });
    const interactionId = randomUUID();
    const { kind, questions, plan } = classify(toolName, input);
    return new Promise<ApprovalAnswer>((resolve) => {
      session.approvals.set(interactionId, resolve);
      signal.addEventListener(
        "abort",
        () => {
          if (session.approvals.delete(interactionId)) {
            this.d.store.append({ aggregate: "chat", type: "InteractionResolved", aggregateId: chatId, payload: { interactionId, status: "cancelled", resolution: "Cancelled" } }, "system");
            resolve({ allow: false, message: "Cancelled" });
          }
        },
        { once: true },
      );
      this.d.store.append(
        [
          { aggregate: "chat", type: "InteractionRequested", aggregateId: chatId, payload: { interactionId, runId: session.runId, kind, toolName, input, questions, plan } },
          { aggregate: "chat", type: "ChatItemAdded", aggregateId: chatId, payload: { item: { kind: "interaction", interactionId } } },
        ],
        "system",
      );
    });
  }

  /** A person answers an approval, a question, or a plan. */
  async resolve(interactionId: string, answer: InteractionAnswer, actor: Actor = currentActor()): Promise<{ newChatId?: string }> {
    const interaction: Interaction | null = this.d.q.interaction(interactionId);
    if (!interaction) throw new NotFoundError("Unknown request");
    const session = this.sessions.get(interaction.chatId);
    const resolveFn = session?.approvals.get(interactionId);
    if (interaction.status !== "pending" || !session || !resolveFn) throw new ConflictError("That request is no longer waiting for an answer");
    const { approval, resolution } = toApproval(interaction, answer);
    session.approvals.delete(interactionId);
    this.d.store.append({ aggregate: "chat", type: "InteractionResolved", aggregateId: interaction.chatId, payload: { interactionId, status: "resolved", resolution } }, actor);
    resolveFn(approval);

    if (answer.kind !== "plan" || answer.action === "revise") return {};
    const chat = this.chatOrThrow(interaction.chatId);
    const ws = this.d.workspaces.workspaceOrThrow(chat.workspaceId);
    if (interaction.plan) this.d.docs.create({ title: `Plan: ${chat.title}`, body: interaction.plan, issueId: ws.issueId }, actor);
    if (answer.action === "approve") {
      await this.setMode(chat.id, "acceptEdits");
      return {};
    }
    const fresh = this.createChat({ workspaceId: ws.id, title: `Execute: ${chat.title}`, provider: chat.provider, model: chat.model, effort: chat.effort, mode: "acceptEdits" }, actor);
    await this.send(fresh.id, { text: `Implement this approved plan.\n\n${interaction.plan ?? "(The plan was approved in the previous chat.)"}` }, actor);
    return { newChatId: fresh.id };
  }

  private onEvent(chatId: string, e: RuntimeEvent, owner: Session): void {
    const current = this.sessions.get(chatId);
    const session = current === owner ? current : undefined;
    switch (e.type) {
      case "session": {
        const chat = this.d.q.chat(chatId);
        const hintsChanged = e.commandHints !== undefined && JSON.stringify(e.commandHints) !== JSON.stringify(chat?.commandHints ?? {});
        if (chat && (chat.sessionId !== e.sessionId || chat.slashCommands.length !== e.slashCommands.length || hintsChanged)) {
          this.d.store.append({ aggregate: "chat", type: "ChatSessionStarted", aggregateId: chatId, payload: { sessionId: e.sessionId, slashCommands: e.slashCommands, ...(e.commandHints ? { commandHints: e.commandHints } : {}) } }, "system");
        }
        return;
      }
      case "text_delta":
        this.d.bus.emit({ type: "delta", chatId, text: e.text });
        return;
      case "assistant_text":
        this.d.bus.emit({ type: "delta_reset", chatId });
        this.item(chatId, { kind: "assistant", text: e.text });
        return;
      case "tool_use":
        this.item(chatId, { kind: "tool_use", toolUseId: e.id, name: e.name, input: e.input });
        if (e.name === "TodoWrite" && Array.isArray(e.input.todos)) this.item(chatId, { kind: "todo", todos: e.input.todos as never });
        return;
      case "tool_result":
        this.item(chatId, { kind: "tool_result", toolUseId: e.id, content: e.content.length > 20_000 ? `${e.content.slice(0, 20_000)}...` : e.content, isError: e.isError });
        return;
      case "compacted":
        this.item(chatId, { kind: "notice", text: `Compacted the conversation (${Math.round(e.preTokens / 1000)}k tokens) so it can keep going.`, tone: "info" });
        return;
      case "turn_end": {
        if (!session) return;
        // The harness reports a running total; turn it into this turn's cost.
        // A resumed process may start from the total its transcript saved.
        let cost: number;
        if (session.lastSessionCost === null) cost = e.sessionCostUsd >= session.costBefore && session.costBefore > 0 ? e.sessionCostUsd - session.costBefore : e.sessionCostUsd;
        else cost = e.sessionCostUsd >= session.lastSessionCost ? e.sessionCostUsd - session.lastSessionCost : e.sessionCostUsd;
        session.lastSessionCost = e.sessionCostUsd;
        cost = Math.max(0, cost);
        const error = session.stopped ? "Stopped by you" : e.isError ? (e.error ?? "The turn ended with an error") : null;
        this.item(chatId, { kind: "turn", costUsd: cost, durationMs: e.durationMs, numTurns: e.numTurns, inputTokens: e.inputTokens, outputTokens: e.outputTokens, isError: Boolean(error), error, ...(e.contextTokens ? { contextTokens: e.contextTokens, contextWindow: e.contextWindow } : {}) });
        this.d.store.append({ aggregate: "chat", type: "ChatUsage", aggregateId: chatId, payload: { costUsd: cost, inputTokens: e.inputTokens, outputTokens: e.outputTokens, model: this.d.q.chat(chatId)?.model } }, "system");
        const previous = session.lastOutcome;
        session.lastOutcome = {
          result: e.result || previous?.result || "",
          costUsd: (previous?.costUsd ?? 0) + cost,
          numTurns: (previous?.numTurns ?? 0) + e.numTurns,
          error,
        };
        // A result may answer several messages (a steer folds in) or only some of them.
        if (e.answered) e.answered.forEach((id) => session.outstanding.delete(id));
        else session.outstanding.clear();
        if (session.outstanding.size === 0) this.finishTurn(chatId, session);
        else this.status(chatId, "running");
        return;
      }
      case "state":
        // Authoritative when sent: idle means every message has been answered.
        if (session && e.state === "idle" && session.busy) {
          session.outstanding.clear();
          this.finishTurn(chatId, session);
        }
        return;
      case "closed": {
        const wasBusy = session?.busy;
        if (session) {
          this.sessions.delete(chatId);
          if (session.idleTimer) clearTimeout(session.idleTimer);
          for (const [id, resolve] of session.approvals) {
            resolve({ allow: false, message: "The session ended." });
            this.d.store.append({ aggregate: "chat", type: "InteractionResolved", aggregateId: chatId, payload: { interactionId: id, status: "cancelled", resolution: "Session ended" } }, "system");
          }
          const outcome: TurnOutcome = { result: "", costUsd: 0, numTurns: 0, error: e.error ?? "The session ended before the turn finished" };
          session.turnWaiters.splice(0).forEach((w) => w(outcome));
        }
        if (e.error) this.item(chatId, { kind: "notice", text: e.error, tone: "error" });
        if (wasBusy) this.status(chatId, e.error ? "error" : "interrupted");
        return;
      }
    }
  }

  /** The harness has gone idle: settle waiters, then deliver the next queued message or rest. */
  private finishTurn(chatId: string, session: Session): void {
    if (!session.busy) return;
    session.busy = false;
    const outcome = session.lastOutcome ?? { result: "", costUsd: 0, numTurns: 0, error: null };
    session.lastOutcome = null;
    session.turnWaiters.splice(0).forEach((w) => w(outcome));
    session.runId = null;
    const next = this.d.q.queued(chatId)[0];
    if (next) {
      this.d.store.append({ aggregate: "chat", type: "QueuedMessageRemoved", aggregateId: chatId, payload: { queuedId: next.id } }, "user");
      this.item(chatId, { kind: "user", text: next.text, attachments: next.attachments, author: "user", steer: false }, "user");
      this.deliver(chatId, session, { text: next.text, attachments: next.attachments }, false);
    } else {
      this.status(chatId, session.stopped ? "interrupted" : "idle");
      session.stopped = false;
      this.armIdle(chatId, session);
    }
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
