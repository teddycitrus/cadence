import { ValidationError } from "../../core/errors";
import type { EventStore } from "../../core/event-store";
import type { IssueCommands } from "../../core/issue-commands";
import type { Queries } from "../../core/queries";
import type { Actor, Issue, Priority, StageCategory, StoredEvent } from "../../core/types";
import type { SecretStore } from "../secrets";
import { LinearApi, LinearError, type LinearIssue, type LinearState, type LinearStateType } from "./api";

export interface LinearConfig {
  teamIds: string[];
  /** Agents and people's moves and comments in Cadence are mirrored to Linear. */
  writeBack: boolean;
  cursor: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface LinearStatus extends LinearConfig {
  connected: boolean;
  organization: string | null;
}

const DEFAULT: LinearConfig = { teamIds: [], writeBack: false, cursor: null, lastSyncAt: null, lastError: null };
const PRIORITY: Record<number, Priority> = { 0: "none", 1: "urgent", 2: "high", 3: "medium", 4: "low" };
const POLL_MS = 60_000;

export const identifierOf = (url: string) => /\/issue\/([A-Z][A-Z0-9]*-\d+)/.exec(url)?.[1] ?? null;

export function categoryOf(state: { type: LinearStateType; name: string }): StageCategory {
  switch (state.type) {
    case "started":
      return /review/i.test(state.name) ? "in_review" : "in_progress";
    case "completed":
      return "done";
    case "canceled":
      return "cancelled";
    default:
      return "triage";
  }
}

/** The Linear state an issue should move to for a Cadence stage category. */
export function stateFor(category: StageCategory, states: LinearState[]): LinearState | null {
  const of = (...types: LinearStateType[]) => states.filter((s) => types.includes(s.type));
  switch (category) {
    case "in_progress":
      return of("started").find((s) => !/review/i.test(s.name)) ?? of("started")[0] ?? null;
    case "in_review":
      return of("started").find((s) => /review/i.test(s.name)) ?? of("started")[0] ?? null;
    case "done":
      return of("completed")[0] ?? null;
    case "cancelled":
      return of("canceled")[0] ?? null;
    default:
      return of("unstarted")[0] ?? of("backlog")[0] ?? of("triage")[0] ?? null;
  }
}

/**
 * Two-way sync between chosen Linear teams and the board. Linear issues become
 * Cadence issues (linked back by URL) and follow their Linear state; with
 * write-back on, moves and comments made in Cadence go to Linear. Changes the
 * sync itself makes are by "system" and never written back, so nothing echoes.
 */
export class LinearSync {
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private organization: string | null = null;
  private syncing: Promise<number> | null = null;

  constructor(
    private store: EventStore,
    private q: Queries,
    private issues: IssueCommands,
    private secrets: SecretStore,
    private settings: SecretStore,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  config(): LinearConfig {
    const raw = this.settings.get("linear");
    return raw ? { ...DEFAULT, ...(JSON.parse(raw) as Partial<LinearConfig>) } : { ...DEFAULT };
  }

  private save(patch: Partial<LinearConfig>): LinearConfig {
    const next = { ...this.config(), ...patch };
    this.settings.set("linear", JSON.stringify(next));
    return next;
  }

  status(): LinearStatus {
    return { ...this.config(), connected: this.secrets.has("linearApiKey"), organization: this.organization };
  }

  api(): LinearApi {
    const key = this.secrets.get("linearApiKey");
    if (!key) throw new LinearError("Linear is not connected. Connect it in Settings > Integrations.", 409);
    return new LinearApi(key, this.fetchImpl);
  }

  async connect(apiKey: string): Promise<LinearStatus> {
    if (!apiKey.startsWith("lin_api_")) throw new ValidationError("A Linear personal API key starts with lin_api_");
    const viewer = await new LinearApi(apiKey, this.fetchImpl).viewer();
    this.secrets.set("linearApiKey", apiKey);
    this.organization = viewer.organization;
    return this.status();
  }

  disconnect(): LinearStatus {
    this.secrets.set("linearApiKey", null);
    this.settings.set("linear", null);
    this.organization = null;
    return this.status();
  }

  /** Choosing different teams restarts the sync from their open issues. */
  configure(patch: { teamIds?: string[]; writeBack?: boolean }): LinearStatus {
    const current = this.config();
    const teamsChanged = patch.teamIds !== undefined && patch.teamIds.join() !== current.teamIds.join();
    this.save({ ...patch, ...(teamsChanged ? { cursor: null } : {}) });
    return this.status();
  }

  start(pollMs = POLL_MS): void {
    this.unsubscribe = this.store.subscribe((e) => this.onEvent(e));
    this.timer = setInterval(() => void this.sync().catch(() => undefined), pollMs);
    this.timer.unref?.();
    void this.sync().catch(() => undefined);
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** Waits for queued write-backs (tests). */
  idle(): Promise<unknown> {
    return this.chain;
  }

  /** One pull from Linear; returns how many board issues it created or changed. Concurrent calls share one pull. */
  sync(): Promise<number> {
    this.syncing ??= this.pull().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async pull(): Promise<number> {
    const cfg = this.config();
    if (!this.secrets.has("linearApiKey") || !cfg.teamIds.length) return 0;
    try {
      const changed = await this.api().changedIssues(cfg.teamIds, cfg.cursor);
      let applied = 0;
      for (const li of changed) if (this.upsert(li)) applied++;
      // The cursor only ever takes Linear's own timestamps, so clock skew cannot skip changes.
      this.save({ cursor: changed.at(-1)?.updatedAt ?? cfg.cursor, lastSyncAt: new Date().toISOString(), lastError: null });
      return applied;
    } catch (err) {
      this.save({ lastError: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  linked(li: { identifier: string }): Issue | null {
    return this.q.issues().find((i) => i.links.some((l) => l.kind === "linear" && identifierOf(l.ref) === li.identifier)) ?? null;
  }

  private firstStage(category: StageCategory): string | null {
    return this.q.stages().find((s) => s.category === category && !s.hidden)?.id ?? this.q.stages().find((s) => s.category === category)?.id ?? null;
  }

  private upsert(li: LinearIssue): boolean {
    const category = categoryOf(li.state);
    const existing = this.linked(li);
    const priority = PRIORITY[li.priority] ?? "none";
    if (!existing) {
      if (category === "done" || category === "cancelled") return false;
      const created = this.issues.createIssue({ title: li.title.slice(0, 200), body: li.description ?? "", type: "feature", priority, stageId: this.firstStage(category) ?? undefined }, "system");
      this.issues.addLink(created.id, { kind: "linear", ref: li.url, title: li.identifier }, "system");
      return true;
    }
    const patch: { title?: string; body?: string; priority?: Priority } = {};
    if (existing.title !== li.title.slice(0, 200)) patch.title = li.title.slice(0, 200);
    if ((li.description ?? "") !== existing.body) patch.body = li.description ?? "";
    if (priority !== existing.priority) patch.priority = priority;
    if (Object.keys(patch).length) this.issues.updateIssue(existing.id, patch, "system");
    const stage = this.q.stage(existing.stageId);
    const target = this.firstStage(category);
    const move = stage?.category !== category && target !== null;
    if (move) this.issues.moveIssue(existing.id, target, "system");
    return move || Object.keys(patch).length > 0;
  }

  private onEvent(e: StoredEvent): void {
    if (e.aggregate !== "issue" || e.actor === "system" || (e.type !== "IssueMoved" && e.type !== "CommentAdded")) return;
    if (!this.config().writeBack || !this.secrets.has("linearApiKey")) return;
    const issue = this.q.issue(e.aggregateId);
    const link = issue?.links.find((l) => l.kind === "linear");
    const identifier = link ? identifierOf(link.ref) : null;
    if (!issue || !identifier) return;
    this.chain = this.chain.then(() => this.writeBack(e, identifier).catch((err) => this.save({ lastError: `Write-back for ${identifier} failed: ${err instanceof Error ? err.message : String(err)}` })));
  }

  private async writeBack(e: StoredEvent, identifier: string): Promise<void> {
    const api = this.api();
    const li = await api.issue(identifier);
    if (e.type === "CommentAdded") {
      await api.comment(li.id, `${String(e.payload.body)}\n\n_${this.describe(e.actor)} via Cadence_`);
      return;
    }
    const from = this.q.stage(String(e.payload.from))?.category;
    const to = this.q.stage(String(e.payload.to))?.category;
    if (!to || from === to || categoryOf(li.state) === to) return;
    const state = stateFor(to, await api.states(li.team.id));
    if (state && state.id !== li.state.id) await api.setState(li.id, state.id);
  }

  private describe(actor: Actor): string {
    if (actor.startsWith("agent:")) return `Agent "${this.q.agent(actor.slice(6))?.name ?? "unknown"}"`;
    return "A teammate";
  }
}
