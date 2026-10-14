import type { AgentCommands } from "../core/agent-commands";
import { ConflictError, NotFoundError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Actor, Agent, ChatMode, Run } from "../core/types";
import { buildRunPrompt } from "../agents/instructions";
import type { ChatEngine } from "../chat/engine";
import type { WorkspaceService } from "../workspaces/service";

export interface RunQueueDeps {
  store: EventStore;
  q: Queries;
  agents: AgentCommands;
  engine: ChatEngine;
  workspaces: WorkspaceService;
}

const AGENT_MODE: Record<Agent["permissionMode"], ChatMode> = { ask: "default", acceptEdits: "acceptEdits", bypassPermissions: "bypassPermissions" };

/**
 * Executes queued agent runs with bounded concurrency. Each run is a turn in
 * the agent's chat inside the issue's workspace (or the agent's home
 * workspace), so people can open it, watch it live, steer it, and continue it.
 */
export class RunQueue {
  private active = new Map<string, { cancelled: boolean; chatId: string | null }>();
  private idleWaiters: (() => void)[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(private d: RunQueueDeps) {}

  start(): void {
    for (const run of this.d.q.activeRuns()) {
      if (run.status === "running") {
        this.d.store.append({ aggregate: "run", type: "RunFailed", aggregateId: run.id, payload: { error: "Interrupted by a restart", costUsd: run.costUsd, numTurns: run.numTurns } }, "system");
      }
    }
    this.unsubscribe = this.d.store.subscribe((e) => {
      if (e.type === "RunQueued" || e.type === "SettingsChanged" || e.type === "AgentEnabled") queueMicrotask(() => this.tick());
    });
    this.tick();
  }

  // Once stopped (shutdown), runs that end late neither record anything nor start more: the database may be closed.
  private stopped = false;

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
  }

  get activeCount(): number {
    return this.active.size;
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.active.size === 0 && !this.runnable().length;
  }

  private runnable(): Run[] {
    return this.d.q.activeRuns().filter((r) => r.status === "queued" && !this.active.has(r.id) && this.d.q.agent(r.agentId)?.enabled);
  }

  tick(): void {
    if (this.stopped) return;
    const limit = Math.max(1, this.d.q.settings().concurrency);
    for (const run of this.runnable()) {
      if (this.active.size >= limit) break;
      void this.execute(run);
    }
    if (this.isIdle()) this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  cancel(runId: string): void {
    const run = this.d.q.run(runId);
    if (!run) throw new NotFoundError(`Run ${runId} not found`);
    const active = this.active.get(runId);
    if (active) {
      active.cancelled = true;
      if (active.chatId) void this.d.engine.interrupt(active.chatId);
      return;
    }
    if (run.status !== "queued") throw new ConflictError("This run has already finished");
    this.d.store.append({ aggregate: "run", type: "RunCancelled", aggregateId: runId, payload: {} });
    this.tick();
  }

  /** Runs a failed or cancelled run again, with the same agent, issue, and context. */
  retry(runId: string, actor: Actor): string {
    const run = this.d.q.run(runId);
    if (!run) throw new NotFoundError(`Run ${runId} not found`);
    if (run.status !== "failed" && run.status !== "cancelled") throw new ConflictError("Only failed or cancelled runs can be retried");
    const note = run.error ? `This retries an earlier run that failed with: ${run.error}

` : "";
    const id = this.d.agents.queueRun({ agentId: run.agentId, issueId: run.issueId, trigger: run.trigger, context: `${note}${run.context}`, threadKey: run.threadKey }, actor);
    this.tick();
    return id ?? runId;
  }

  /** Cancels every queued run (of one agent, or all). Running ones keep going. */
  cancelQueued(agentId: string | null, actor: Actor): number {
    const queued = this.d.q.activeRuns().filter((r) => r.status === "queued" && (!agentId || r.agentId === agentId));
    for (const r of queued) this.d.store.append({ aggregate: "run", type: "RunCancelled", aggregateId: r.id, payload: {} }, actor);
    return queued.length;
  }

  /** The agent's existing chat in this workspace, or a new one. */
  private chatFor(agent: Agent, workspaceId: string, title: string, actor: Actor): string {
    // A chat on another harness (the agent was switched since) cannot carry on the session.
    const existing = this.d.q.chatsForWorkspace(workspaceId).find((c) => c.agentId === agent.id && c.provider === agent.provider && !c.archived && c.status !== "running" && c.status !== "waiting");
    if (existing) return existing.id;
    return this.d.engine.createChat({ workspaceId, title, provider: agent.provider, model: agent.model, effort: agent.effort, mode: AGENT_MODE[agent.permissionMode], agentId: agent.id }, actor).id;
  }

  /**
   * A conversation from outside (a Slack thread) gets its own workspace and
   * chat on the first message; later replies continue that same chat.
   */
  private async threadChat(agent: Agent, threadKey: string, context: string, actor: Actor): Promise<string> {
    const existing = this.d.q.chats().find((c) => c.threadKey === threadKey && c.agentId === agent.id && !c.archived);
    if (existing && this.d.q.workspace(existing.workspaceId) && !this.d.q.workspace(existing.workspaceId)!.archived) return existing.id;
    const firstLine = context.split("\n").find((l) => l.trim() && !l.startsWith("Slack ")) ?? agent.name;
    const title = `${agent.name} · ${firstLine.replace(/^[>\s"]+/, "")}`.slice(0, 60);
    const ws = await this.d.workspaces.createInProject(agent.projectId ?? null, title, actor);
    return this.d.engine.createChat({ workspaceId: ws.id, title, provider: agent.provider, model: agent.model, effort: agent.effort, mode: AGENT_MODE[agent.permissionMode], agentId: agent.id, threadKey }, actor).id;
  }

  private async execute(run: Run): Promise<void> {
    const { store, q, engine, workspaces } = this.d;
    const state = { cancelled: false, chatId: null as string | null };
    this.active.set(run.id, state);
    const agent = q.agent(run.agentId)!;
    const actor: Actor = `agent:${agent.id}`;
    store.append({ aggregate: "run", type: "RunStarted", aggregateId: run.id, payload: {} }, actor);

    try {
      const issue = run.issueId ? q.issue(run.issueId) : null;
      const notes: string[] = [];
      const chatId = issue
        ? this.chatFor(agent, (await workspaces.forIssue(issue, actor, (m) => notes.push(m))).id, `${agent.name} · ${issue.key}`, actor)
        : run.threadKey
          ? await this.threadChat(agent, run.threadKey, run.context, actor)
          : this.chatFor(agent, (await workspaces.homeForAgent(agent, actor, (m) => notes.push(m))).id, agent.name, actor);
      const ws = q.workspace(q.chat(chatId)!.workspaceId)!;
      state.chatId = chatId;
      store.append({ aggregate: "run", type: "RunAttached", aggregateId: run.id, payload: { workspaceId: ws.id, chatId } }, actor);
      if (state.cancelled) throw new Error("cancelled");

      const prompt = [buildRunPrompt(run, issue ? q.issue(issue.id) : null, q), ...notes].join("\n\n");
      const outcome = await engine.runTurn(chatId, prompt, actor, run.id);
      if (state.cancelled) {
        store.append({ aggregate: "run", type: "RunCancelled", aggregateId: run.id, payload: {} }, actor);
      } else if (outcome.error) {
        store.append({ aggregate: "run", type: "RunFailed", aggregateId: run.id, payload: { error: outcome.error, costUsd: outcome.costUsd, numTurns: outcome.numTurns } }, actor);
      } else {
        store.append({ aggregate: "run", type: "RunSucceeded", aggregateId: run.id, payload: { summary: outcome.result, costUsd: outcome.costUsd, numTurns: outcome.numTurns } }, actor);
      }
      // Agent sessions are not kept warm; opening the chat later resumes it.
      if (!engine.isLive(chatId) || q.queued(chatId).length === 0) engine.close(chatId);
    } catch (err) {
      if (this.stopped) return;
      if (state.cancelled) {
        store.append({ aggregate: "run", type: "RunCancelled", aggregateId: run.id, payload: {} }, actor);
      } else {
        const error = err instanceof Error ? err.message : String(err);
        if (state.chatId) store.append({ aggregate: "chat", type: "ChatItemAdded", aggregateId: state.chatId, payload: { item: { kind: "notice", text: error, tone: "error" } } }, "system");
        store.append({ aggregate: "run", type: "RunFailed", aggregateId: run.id, payload: { error, costUsd: 0, numTurns: 0 } }, actor);
      }
    } finally {
      this.active.delete(run.id);
      this.tick();
    }
  }
}
