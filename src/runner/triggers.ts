import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentCommands } from "../core/agent-commands";
import { NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Actor, Agent, Assignee, GithubEvent, Issue, SlackEvent, StoredEvent, Trigger, TriggerKind } from "../core/types";

const LOOP_WINDOW_MS = 60 * 60 * 1000;
const LOOP_LIMIT = 12;

function triggerOf<K extends TriggerKind>(agent: Agent, kind: K): Extract<Trigger, { kind: K }>[] {
  return agent.triggers.filter((t): t is Extract<Trigger, { kind: K }> => t.kind === kind);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Verifies GitHub's X-Hub-Signature-256 header against the raw body. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, header);
}

/** Maps a GitHub webhook delivery to the event names agents subscribe to. */
export function githubEventName(event: string, payload: Record<string, unknown>): GithubEvent | null {
  if (event === "pull_request") {
    const action = payload.action;
    const pr = payload.pull_request as { merged?: boolean } | undefined;
    if (action === "opened") return "pr_opened";
    if (action === "ready_for_review") return "pr_ready_for_review";
    if (action === "closed" && pr?.merged) return "pr_merged";
  }
  if (event === "pull_request_review" && payload.action === "submitted") return "pr_review_submitted";
  if (event === "release" && payload.action === "published") return "release_published";
  return null;
}

function describeActor(actor: Actor, q: Queries): string {
  if (actor === "user") return "a teammate";
  if (actor.startsWith("agent:")) return `the "${q.agent(actor.slice(6))?.name ?? "unknown"}" agent`;
  if (actor.startsWith("chat:")) return "a teammate's AI assistant";
  if (actor.startsWith("webhook:")) return "an incoming webhook";
  if (actor.startsWith("token:")) return "an outside agent (MCP)";
  return actor;
}

/**
 * Turns board activity, schedules, and inbound webhooks into queued runs for
 * the agents whose triggers match. An agent is never triggered by its own
 * actions, and a runaway loop on one issue is cut off.
 */
export class TriggerEngine {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private store: EventStore,
    private q: Queries,
    private agents: AgentCommands,
  ) {}

  start(): void {
    this.unsubscribe = this.store.subscribe((e) => this.onEvent(e));
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private recentRuns(agentId: string, issueId: string): number {
    const since = Date.now() - LOOP_WINDOW_MS;
    return this.q.runsForIssue(issueId).filter((r) => r.agentId === agentId && Date.parse(r.createdAt) > since).length;
  }

  private fire(agent: Agent, issue: Issue | null, trigger: TriggerKind, context: string, cause: Actor, threadKey: string | null = null): string | null {
    if (!agent.enabled) return null;
    if (cause === `agent:${agent.id}`) return null;
    if (issue && this.recentRuns(agent.id, issue.id) >= LOOP_LIMIT) {
      console.warn(`Not triggering ${agent.name} on ${issue.key}: ${LOOP_LIMIT} runs in the last hour`);
      return null;
    }
    if (threadKey && this.q.runs().filter((r) => r.agentId === agent.id && r.threadKey === threadKey && Date.parse(r.createdAt) > Date.now() - LOOP_WINDOW_MS).length >= LOOP_LIMIT) {
      console.warn(`Not triggering ${agent.name} in ${threadKey}: ${LOOP_LIMIT} runs in the last hour`);
      return null;
    }
    return this.agents.queueRun({ agentId: agent.id, issueId: issue?.id ?? null, trigger, context, threadKey }, cause);
  }

  /** PR transitions seen by the watcher fire GitHub triggers, so they work without a public webhook. */
  private onPullRequest(e: StoredEvent): void {
    const transitions = (e.payload.transitions as GithubEvent[] | undefined) ?? [];
    if (!transitions.length) return;
    const pr = this.q.pullRequest(e.aggregateId);
    if (!pr) return;
    const issue = pr.issueId ? this.q.issue(pr.issueId) : null;
    for (const agent of this.q.agents().filter((a) => a.enabled)) {
      const wanted = triggerOf(agent, "github").flatMap((t) => t.events);
      for (const name of transitions.filter((t) => wanted.includes(t))) {
        this.fire(agent, issue, "github", `GitHub event: ${name.replace(/_/g, " ")}.\nPull request: #${pr.number} ${pr.title} ${pr.url}\nBranch: ${pr.headRef}`, "system");
      }
    }
  }

  private onEvent(e: StoredEvent): void {
    if (e.type === "PullRequestUpdated") return this.onPullRequest(e);
    if (e.aggregate !== "issue") return;
    const issue = this.q.issue(e.aggregateId);
    if (!issue) return;
    const who = describeActor(e.actor, this.q);
    const enabled = this.q.agents().filter((a) => a.enabled);

    switch (e.type) {
      case "AssigneeAdded": {
        const assignee = e.payload.assignee as Assignee;
        if (assignee.kind !== "agent") return;
        const agent = this.q.agent(assignee.id);
        if (agent && agent.triggers.some((t) => t.kind === "assigned")) {
          this.fire(agent, issue, "assigned", `${who} assigned you to ${issue.key}.`, e.actor);
        }
        return;
      }
      case "IssueCreated":
        for (const agent of enabled) {
          const match = triggerOf(agent, "issue_created").some((t) => (!t.stageIds.length || t.stageIds.includes(issue.stageId)) && (!t.types.length || t.types.includes(issue.type)));
          if (match) this.fire(agent, issue, "issue_created", `${who} created ${issue.key}.`, e.actor);
        }
        return;
      case "IssueMoved": {
        const to = String(e.payload.to);
        const stage = this.q.stage(to)?.name ?? to;
        for (const agent of enabled) {
          if (triggerOf(agent, "issue_moved").some((t) => t.toStageIds.includes(to))) {
            this.fire(agent, issue, "issue_moved", `${who} moved ${issue.key} to "${stage}".`, e.actor);
          }
        }
        return;
      }
      case "LabelAdded": {
        const labelId = String(e.payload.labelId);
        for (const agent of enabled) {
          if (triggerOf(agent, "label_added").some((t) => t.labelIds.includes(labelId))) {
            this.fire(agent, issue, "label_added", `${who} added the label "${this.q.label(labelId)?.name}" to ${issue.key}.`, e.actor);
          }
        }
        return;
      }
      case "CommentAdded":
        // Only human comments fire this trigger; agent chatter would loop.
        if (e.actor.startsWith("agent:") || e.actor.startsWith("token:")) return;
        for (const agent of enabled) {
          if (triggerOf(agent, "issue_commented").length) {
            this.fire(agent, issue, "issue_commented", `${who} commented on ${issue.key}: "${String(e.payload.body).slice(0, 500)}"`, e.actor);
          }
        }
        return;
    }
  }

  /** Slack activity: every enabled agent whose Slack trigger matches the event, channel, and emoji. */
  fireSlack(a: { kind: SlackEvent; channel: string; emoji: string | null; bot?: boolean }, context: string, threadKey: string, skip: Set<string> = new Set()): string[] {
    const ids: string[] = [];
    for (const agent of this.q.agents().filter((x) => x.enabled && !skip.has(x.id))) {
      const match = triggerOf(agent, "slack").some(
        (t) => t.events.includes(a.kind) && (!a.bot || t.includeBots === true) && (!t.channelIds.length || t.channelIds.includes(a.channel)) && (a.kind !== "reaction" || !t.emoji.length || (a.emoji !== null && t.emoji.includes(a.emoji))),
      );
      const id = match ? this.fire(agent, null, "slack", context, "system", threadKey) : null;
      if (id) ids.push(id);
    }
    return ids;
  }

  /** A reply in a Slack thread an agent is already working: continue that agent's chat. */
  fireSlackThread(agentId: string, context: string, threadKey: string): string | null {
    const agent = this.q.agent(agentId);
    return agent ? this.fire(agent, null, "slack", context, "system", threadKey) : null;
  }

  /** Called by the scheduler when a schedule trigger is due. */
  fireSchedule(agentId: string, description: string): string | null {
    const agent = this.q.agent(agentId);
    if (!agent) return null;
    return this.fire(agent, null, "schedule", `Scheduled run (${description}).`, "system");
  }

  /** Inbound webhook: the secret in the URL must match one of the agent's webhook triggers. */
  fireWebhook(agentId: string, secret: string, body: unknown): string | null {
    const agent = this.q.agent(agentId);
    if (!agent || !triggerOf(agent, "webhook").some((t) => safeEqual(t.secret, secret))) throw new NotFoundError("Unknown webhook");
    const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    if (!text || text === "{}") throw new ValidationError("The webhook body is empty");
    return this.fire(agent, null, "webhook", `Webhook payload:\n${text.slice(0, 20_000)}`, `webhook:${agent.id}`);
  }

  /** Inbound GitHub delivery, already verified against the trigger's secret by the caller. */
  githubSecretFor(agentId: string): string | null {
    const agent = this.q.agent(agentId);
    return agent ? (triggerOf(agent, "github")[0]?.secret ?? null) : null;
  }

  fireGithub(agentId: string, event: string, payload: Record<string, unknown>): string | null {
    const agent = this.q.agent(agentId);
    const name = githubEventName(event, payload);
    if (!agent || !name) return null;
    const pr = payload.pull_request as { html_url?: string; title?: string; head?: { ref?: string }; user?: { login?: string } } | undefined;
    const release = payload.release as { name?: string; tag_name?: string; html_url?: string; body?: string; author?: { login?: string } } | undefined;
    const author = (pr?.user?.login ?? release?.author?.login ?? (payload.sender as { login?: string } | undefined)?.login ?? "").toLowerCase();
    const wants = (t: { events: string[]; authors?: string[] }) => t.events.includes(name) && (!t.authors?.length || t.authors.some((a) => a.toLowerCase() === author));
    if (!triggerOf(agent, "github").some(wants)) return null;
    const context = release
      ? `GitHub event: release published.\nRelease: ${release.name || release.tag_name || ""} (${release.tag_name ?? ""}) ${release.html_url ?? ""}${author ? `\nBy: ${author}` : ""}${release.body ? `\nNotes:\n${release.body.slice(0, 4000)}` : ""}`
      : `GitHub event: ${name.replace(/_/g, " ")}.\nPull request: ${pr?.title ?? ""} ${pr?.html_url ?? ""}\nBranch: ${pr?.head?.ref ?? ""}${author ? `\nAuthor: ${author}` : ""}`;
    const issue = this.q.issues().find((i) => (pr?.html_url && i.links.some((l) => l.ref === pr.html_url)) || (pr?.head?.ref && i.branch === pr.head.ref)) ?? null;
    return this.fire(agent, issue, "github", context, `webhook:${agent.id}`);
  }
}
