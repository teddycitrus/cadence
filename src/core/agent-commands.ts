import { randomBytes, randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import type { EventStore } from "./event-store";
import type { AgentFields, DomainEvent } from "./events";
import type { Queries } from "./queries";
import type { Actor, Agent, AgentVisibility, Effort, PermissionMode, Project, ProjectCommand, Settings, Trigger, TriggerInput, TriggerKind } from "./types";
import { currentActor, memberIdOf } from "../auth/context";
import { checkModel, chooseHarness, type ProviderId } from "./providers";

export interface NewAgent {
  name: string;
  description?: string;
  color?: string;
  icon?: string | null;
  prompt: string;
  provider?: ProviderId;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  projectId?: string | null;
  triggers?: TriggerInput[];
  templateId?: string | null;
  enabled?: boolean;
  visibility?: AgentVisibility;
  monthlyBudgetUsd?: number | null;
  /** Defaults to the person (or the calling agent's owner) creating it. */
  ownerId?: string;
}

export { agentAccess, agentForViewer } from "./agent-access";

export type AgentPatch = Omit<AgentFields, "triggers"> & { triggers?: TriggerInput[] };

export const newSecret = () => randomBytes(24).toString("base64url");

/** Gives every trigger an id and fills in secrets for webhook-style triggers. */
export function normalizeTriggers(triggers: TriggerInput[]): Trigger[] {
  const kinds = new Set<TriggerKind>();
  return triggers.map((t) => {
    if (t.kind !== "schedule" && t.kind !== "webhook" && kinds.has(t.kind)) throw new ValidationError(`Only one "${t.kind}" trigger is allowed per agent`);
    kinds.add(t.kind);
    const id = t.id || randomUUID();
    if (t.kind === "webhook" || t.kind === "github") return { ...t, id, secret: t.secret || newSecret() } as Trigger;
    return { ...t, id } as Trigger;
  });
}

/** Write side for agents, projects, settings, and the run lifecycle. */
/** A queued run's context once more triggers pile on: the newest ones are kept. */
export const MAX_RUN_CONTEXT = 24_000;
export function mergeContext(existing: string, added: string): string {
  const merged = `${existing}\n\n${added}`;
  if (merged.length <= MAX_RUN_CONTEXT) return merged;
  const note = "(Earlier triggers were trimmed; these are the latest.)\n\n";
  return note + merged.slice(merged.length - (MAX_RUN_CONTEXT - note.length));
}

export class AgentCommands {
  constructor(
    private store: EventStore,
    private q: Queries,
    private newId: () => string = randomUUID,
  ) {}

  private emit(events: DomainEvent | DomainEvent[], actor: Actor = currentActor()): void {
    this.store.append(events, actor);
  }

  agentOrThrow(idOrName: string): Agent {
    const agent = this.q.agent(idOrName);
    if (!agent) throw new NotFoundError(`Agent ${idOrName} not found`);
    return agent;
  }

  createAgent(input: NewAgent, actor: Actor = currentActor()): Agent {
    if (this.q.agent(input.name)) throw new ConflictError(`An agent named "${input.name}" already exists`);
    if (input.projectId && !this.q.project(input.projectId)) throw new NotFoundError(`Project ${input.projectId} not found`);
    const settings = this.q.settings();
    const { provider, model } = chooseHarness(settings, input);
    const id = this.newId();
    this.emit(
      {
        aggregate: "agent",
        type: "AgentCreated",
        aggregateId: id,
        payload: {
          name: input.name,
          description: input.description ?? "",
          color: input.color ?? "#8b5cf6",
          icon: input.icon ?? null,
          prompt: input.prompt,
          provider,
          model,
          effort: input.effort ?? settings.defaultEffort,
          permissionMode: input.permissionMode ?? "acceptEdits",
          projectId: input.projectId ?? null,
          triggers: normalizeTriggers(input.triggers ?? [{ kind: "assigned" }]),
          templateId: input.templateId ?? null,
          enabled: input.enabled ?? false,
          ownerId: input.ownerId ?? this.ownerFor(actor),
          visibility: input.visibility ?? "private",
          ...(input.monthlyBudgetUsd != null ? { monthlyBudgetUsd: input.monthlyBudgetUsd } : {}),
        },
      },
      actor,
    );
    return this.agentOrThrow(id);
  }

  /** People own what they create; an agent's creations belong to that agent's owner. */
  private ownerFor(actor: Actor): string {
    const member = memberIdOf(actor);
    if (member) return member;
    if (actor.startsWith("agent:")) return this.q.agent(actor.slice(6))?.ownerId ?? "me";
    return "me";
  }

  /** A private, disabled copy of a public agent for the person copying it. */
  copyAgent(id: string, actor: Actor = currentActor()): Agent {
    const source = this.agentOrThrow(id);
    if (source.visibility !== "public" && source.ownerId !== this.ownerFor(actor)) throw new NotFoundError(`Agent ${id} not found`);
    let name = `${source.name} (copy)`;
    for (let n = 2; this.q.agent(name); n++) name = `${source.name} (copy ${n})`;
    return this.createAgent(
      {
        name,
        description: source.description,
        color: source.color,
        icon: source.icon ?? null,
        prompt: source.prompt,
        provider: source.provider,
        model: source.model,
        effort: source.effort,
        permissionMode: source.permissionMode,
        projectId: source.projectId,
        // Fresh ids and secrets: a copy must not answer the original's webhooks.
        triggers: source.triggers.map(({ id: _id, ...t }) => ("secret" in t ? { ...t, secret: "" } : t)) as TriggerInput[],
        templateId: source.templateId,
        enabled: false,
        visibility: "private",
      },
      actor,
    );
  }

  updateAgent(id: string, patch: AgentPatch, actor: Actor = currentActor()): Agent {
    const agent = this.agentOrThrow(id);
    if (patch.name && patch.name !== agent.name && this.q.agent(patch.name)) throw new ConflictError(`An agent named "${patch.name}" already exists`);
    if (patch.projectId && !this.q.project(patch.projectId)) throw new NotFoundError(`Project ${patch.projectId} not found`);
    const { triggers, ...rest } = patch;
    if (rest.provider || rest.model) {
      // Switching harness without naming a model starts on that harness's default.
      const provider = rest.provider ?? agent.provider;
      rest.model = rest.model ?? (provider === agent.provider ? agent.model : chooseHarness(this.q.settings(), { provider }).model);
      checkModel(provider, rest.model);
    }
    const payload: AgentFields = triggers ? { ...rest, triggers: normalizeTriggers(triggers) } : rest;
    this.emit({ aggregate: "agent", type: "AgentUpdated", aggregateId: agent.id, payload }, actor);
    return this.agentOrThrow(agent.id);
  }

  setEnabled(id: string, enabled: boolean, actor: Actor = currentActor()): void {
    const agent = this.agentOrThrow(id);
    if (agent.enabled === enabled) return;
    this.emit({ aggregate: "agent", type: enabled ? "AgentEnabled" : "AgentDisabled", aggregateId: agent.id, payload: {} }, actor);
  }

  deleteAgent(id: string, actor: Actor = currentActor()): void {
    const agent = this.agentOrThrow(id);
    if (this.q.activeRuns().some((r) => r.agentId === agent.id)) throw new ConflictError(`${agent.name} has active runs; cancel them first`);
    const events: DomainEvent[] = [{ aggregate: "agent", type: "AgentDeleted", aggregateId: agent.id, payload: {} }];
    for (const issue of this.q.issues()) {
      if (issue.assignees.some((a) => a.kind === "agent" && a.id === agent.id)) {
        events.push({ aggregate: "issue", type: "AssigneeRemoved", aggregateId: issue.id, payload: { assignee: { kind: "agent", id: agent.id } } });
      }
    }
    this.emit(events, actor);
  }

  /** Queues a run. Skips it when the same agent already has pending work on the same issue. */
  queueRun(input: { agentId: string; issueId: string | null; trigger: TriggerKind | "manual"; context: string; threadKey?: string | null }, actor: Actor = "system"): string | null {
    const agent = this.agentOrThrow(input.agentId);
    const threadKey = input.threadKey ?? null;
    const duplicate = input.issueId ? this.q.queuedRunFor(agent.id, { issueId: input.issueId }) : threadKey !== null ? this.q.queuedRunFor(agent.id, { threadKey }) : null;
    if (duplicate) {
      this.emit({ aggregate: "run", type: "RunContextUpdated", aggregateId: duplicate.id, payload: { context: mergeContext(duplicate.context, input.context) } }, actor);
      return duplicate.id;
    }
    const id = this.newId();
    this.emit({ aggregate: "run", type: "RunQueued", aggregateId: id, payload: { agentId: agent.id, issueId: input.issueId, trigger: input.trigger, context: input.context, threadKey } }, actor);
    return id;
  }

  addProject(input: { name: string; path: string; baseBranch: string; githubRepo: string | null; setupScript?: string | null; commands?: ProjectCommand[] }): Project {
    const id = this.newId();
    this.emit({ aggregate: "project", type: "ProjectAdded", aggregateId: id, payload: { ...input, setupScript: input.setupScript ?? null, commands: input.commands ?? [] } });
    return this.q.project(id)!;
  }

  updateProject(id: string, patch: { name?: string; baseBranch?: string; githubRepo?: string | null; setupScript?: string | null; commands?: ProjectCommand[] }): Project {
    if (!this.q.project(id)) throw new NotFoundError(`Project ${id} not found`);
    this.emit({ aggregate: "project", type: "ProjectUpdated", aggregateId: id, payload: patch });
    return this.q.project(id)!;
  }

  setPersonalScripts(id: string, memberId: string, patch: { setupScript?: string | null; commands?: ProjectCommand[] }): Project {
    if (!this.q.project(id)) throw new NotFoundError(`Project ${id} not found`);
    this.emit({ aggregate: "project", type: "ProjectPersonalScriptsSet", aggregateId: id, payload: { memberId, ...patch } });
    return this.q.project(id)!;
  }

  removeProject(id: string): void {
    if (!this.q.project(id)) throw new NotFoundError(`Project ${id} not found`);
    this.emit({ aggregate: "project", type: "ProjectRemoved", aggregateId: id, payload: {} });
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.defaultProvider || patch.defaultModel) {
      const current = this.q.settings();
      const provider = patch.defaultProvider ?? current.defaultProvider ?? "claude-code";
      const switching = provider !== (current.defaultProvider ?? "claude-code");
      patch = { ...patch, defaultModel: patch.defaultModel ?? (switching ? (provider === "claude-code" ? "claude-opus-5-5" : "default") : current.defaultModel) };
      checkModel(provider, patch.defaultModel!);
    }
    this.emit({ aggregate: "settings", type: "SettingsChanged", aggregateId: "global", payload: patch });
    return this.q.settings();
  }
}
