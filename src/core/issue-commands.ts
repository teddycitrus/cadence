import { randomUUID } from "node:crypto";
import { DEFAULT_LABELS, DEFAULT_STAGES, ISSUE_KEY_PREFIX } from "./defaults";
import { ConflictError, GateError, NotFoundError, ValidationError } from "./errors";
import type { EventStore } from "./event-store";
import type { DomainEvent, IssueFields } from "./events";
import type { Queries } from "./queries";
import type { Actor, Assignee, Issue, IssueLink, IssueType, LinkKind, Priority, Reaction, StageCategory } from "./types";
import { currentActor } from "../auth/context";
import { manualKey, orderIssues, rankBetween } from "./issue-views";

export interface NewIssue {
  title: string;
  body?: string;
  type?: IssueType;
  priority?: Priority;
  stageId?: string;
  projectId?: string | null;
  labelIds?: string[];
  assignees?: Assignee[];
}

/** Cadence agents and outside agents (MCP tokens) both stop at sign-off stages. */
const isAgent = (actor: Actor) => actor.startsWith("agent:") || actor.startsWith("token:");

/**
 * Write side for the board: stages, labels, issues, comments, links, docs.
 * Every method validates against current state and records events.
 */
export class IssueCommands {
  constructor(
    private store: EventStore,
    private q: Queries,
    private newId: () => string = randomUUID,
  ) {}

  private emit(events: DomainEvent | DomainEvent[], actor: Actor): void {
    this.store.append(events, actor);
  }

  issueOrThrow(idOrKey: string): Issue {
    const issue = this.q.issue(idOrKey);
    if (!issue) throw new NotFoundError(`Issue ${idOrKey} not found`);
    return issue;
  }

  private stageIdOrThrow(idOrName: string): string {
    const stage = this.q.stage(idOrName);
    if (!stage) throw new NotFoundError(`Stage ${idOrName} not found`);
    return stage.id;
  }

  /** Creates the default workflow the first time Cadence starts. */
  seedDefaults(): void {
    if (this.q.stages().length > 0) return;
    const events: DomainEvent[] = DEFAULT_STAGES.map((s, position) => ({
      aggregate: "stage",
      type: "StageCreated",
      aggregateId: this.newId(),
      payload: { name: s.name, category: s.category, color: s.color, position, humanGate: Boolean(s.humanGate), hidden: Boolean(s.hidden) },
    }));
    for (const l of DEFAULT_LABELS) events.push({ aggregate: "label", type: "LabelCreated", aggregateId: this.newId(), payload: l });
    this.emit(events, "system");
  }

  createStage(input: { name: string; category: StageCategory; color: string; humanGate?: boolean }, actor: Actor = currentActor()): string {
    const id = this.newId();
    const position = this.q.stages().length;
    this.emit({ aggregate: "stage", type: "StageCreated", aggregateId: id, payload: { ...input, humanGate: Boolean(input.humanGate), hidden: false, position } }, actor);
    return id;
  }

  updateStage(id: string, patch: { name?: string; color?: string; humanGate?: boolean; hidden?: boolean }, actor: Actor = currentActor()): void {
    this.stageIdOrThrow(id);
    this.emit({ aggregate: "stage", type: "StageUpdated", aggregateId: id, payload: patch }, actor);
  }

  reorderStages(order: string[], actor: Actor = currentActor()): void {
    const known = new Set(this.q.stages().map((s) => s.id));
    if (order.length !== known.size || !order.every((id) => known.has(id))) throw new ValidationError("The order must list every stage exactly once");
    this.emit({ aggregate: "stage", type: "StagesReordered", aggregateId: "all", payload: { order } }, actor);
  }

  deleteStage(id: string, moveIssuesTo: string, actor: Actor = currentActor()): void {
    this.stageIdOrThrow(id);
    if (id === moveIssuesTo) throw new ValidationError("Pick a different stage for the issues in this one");
    this.stageIdOrThrow(moveIssuesTo);
    this.emit({ aggregate: "stage", type: "StageDeleted", aggregateId: id, payload: { moveIssuesTo } }, actor);
  }

  createLabel(input: { name: string; color: string }, actor: Actor = currentActor()): string {
    if (this.q.label(input.name)) throw new ConflictError(`Label "${input.name}" already exists`);
    const id = this.newId();
    this.emit({ aggregate: "label", type: "LabelCreated", aggregateId: id, payload: input }, actor);
    return id;
  }

  deleteLabel(id: string, actor: Actor = currentActor()): void {
    if (!this.q.label(id)) throw new NotFoundError(`Label ${id} not found`);
    this.emit({ aggregate: "label", type: "LabelDeleted", aggregateId: id, payload: {} }, actor);
  }

  createIssue(input: NewIssue, actor: Actor = currentActor()): Issue {
    const stages = this.q.stages();
    const stageId = input.stageId ? this.stageIdOrThrow(input.stageId) : stages[0]?.id;
    if (!stageId) throw new ConflictError("No stages are configured");
    if (input.projectId && !this.q.project(input.projectId)) throw new NotFoundError(`Project ${input.projectId} not found`);
    const labelIds = (input.labelIds ?? []).map((l) => {
      const label = this.q.label(l);
      if (!label) throw new NotFoundError(`Label ${l} not found`);
      return label.id;
    });
    const id = this.newId();
    const key = `${ISSUE_KEY_PREFIX}-${this.q.nextIssueNumber()}`;
    const events: DomainEvent[] = [
      {
        aggregate: "issue",
        type: "IssueCreated",
        aggregateId: id,
        payload: {
          key,
          title: input.title,
          body: input.body ?? "",
          type: input.type ?? "feature",
          priority: input.priority ?? "none",
          stageId,
          projectId: input.projectId ?? (this.q.projects().length === 1 ? this.q.projects()[0]!.id : null),
          labelIds,
        },
      },
    ];
    for (const a of input.assignees ?? []) events.push(this.assigneeEvent(id, a, true));
    this.emit(events, actor);
    return this.issueOrThrow(id);
  }

  updateIssue(idOrKey: string, patch: IssueFields, actor: Actor = currentActor()): Issue {
    const issue = this.issueOrThrow(idOrKey);
    if (patch.projectId && !this.q.project(patch.projectId)) throw new NotFoundError(`Project ${patch.projectId} not found`);
    if (Object.keys(patch).length) this.emit({ aggregate: "issue", type: "IssueUpdated", aggregateId: issue.id, payload: patch }, actor);
    return this.issueOrThrow(issue.id);
  }

  moveIssue(idOrKey: string, stageIdOrName: string, actor: Actor = currentActor(), auto?: "pr_opened" | "pr_merged"): Issue {
    const issue = this.issueOrThrow(idOrKey);
    const to = this.stageIdOrThrow(stageIdOrName);
    if (to === issue.stageId) return issue;
    const from = this.q.stage(issue.stageId);
    if (isAgent(actor) && from?.humanGate) {
      throw new GateError(`${issue.key} is in "${from.name}", a sign-off stage. Leave it there for a person to review and move.`);
    }
    this.emit({ aggregate: "issue", type: "IssueMoved", aggregateId: issue.id, payload: { from: issue.stageId, to, ...(auto ? { auto } : {}) } }, actor);
    return this.issueOrThrow(issue.id);
  }

  /**
   * Places an issue between two neighbors under manual ordering (either may be
   * omitted for the top or bottom), optionally moving it to another stage too.
   */
  reorderIssue(idOrKey: string, place: { above?: string | null; below?: string | null; stage?: string | null }, actor: Actor = currentActor()): Issue {
    let issue = this.issueOrThrow(idOrKey);
    if (place.stage) issue = this.moveIssue(issue.id, place.stage, actor);
    let above = place.above ? this.issueOrThrow(place.above) : null;
    let below = place.below ? this.issueOrThrow(place.below) : null;
    if (above?.id === issue.id || below?.id === issue.id) throw new ValidationError("An issue cannot be its own neighbor");
    // Neighbors with (nearly) the same key leave no room between them: space everyone out first.
    if (above && below && Math.abs(manualKey(above) - manualKey(below)) < 1e-6) {
      const order = orderIssues(this.q.issues(), "manual");
      this.store.append(order.map((i, n) => ({ aggregate: "issue", type: "IssueRanked", aggregateId: i.id, payload: { rank: n } })), actor);
      above = this.issueOrThrow(above.id);
      below = this.issueOrThrow(below.id);
    }
    const rank = rankBetween(above, below);
    if (rank !== null) this.emit({ aggregate: "issue", type: "IssueRanked", aggregateId: issue.id, payload: { rank } }, actor);
    return this.issueOrThrow(issue.id);
  }

  /** Records that a member opened the issue (only when something changed since they last did). */
  markRead(idOrKey: string, memberId: string, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    const last = this.q.issueReads(memberId)[issue.id];
    if (last && last >= issue.updatedAt) return;
    this.emit({ aggregate: "issue", type: "IssueRead", aggregateId: issue.id, payload: { memberId } }, actor);
  }

  /** A copy of the issue: same fields and labels, a fresh key, nobody assigned. */
  duplicateIssue(idOrKey: string, actor: Actor = currentActor()): Issue {
    const issue = this.issueOrThrow(idOrKey);
    const copy = this.createIssue({ title: `${issue.title} (copy)`.slice(0, 200), body: issue.body, type: issue.type, priority: issue.priority, stageId: issue.stageId, projectId: issue.projectId, labelIds: issue.labelIds }, actor);
    return copy;
  }

  /** Puts an issue back where it was before Cadence moved it for a pull request. */
  undoAutoMove(idOrKey: string, actor: Actor = currentActor()): Issue {
    const issue = this.issueOrThrow(idOrKey);
    if (!issue.autoMove || issue.autoMove.to !== issue.stageId) throw new ValidationError(`${issue.key} has no automatic move to undo`);
    return this.moveIssue(issue.id, issue.autoMove.from, actor);
  }

  setLabel(idOrKey: string, labelIdOrName: string, on: boolean, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    const label = this.q.label(labelIdOrName);
    if (!label) throw new NotFoundError(`Label ${labelIdOrName} not found`);
    if (on === issue.labelIds.includes(label.id)) return;
    this.emit({ aggregate: "issue", type: on ? "LabelAdded" : "LabelRemoved", aggregateId: issue.id, payload: { labelId: label.id } }, actor);
  }

  private assigneeEvent(issueId: string, assignee: Assignee, add: boolean): DomainEvent {
    if (assignee.kind === "agent" && !this.q.agent(assignee.id)) throw new NotFoundError(`Agent ${assignee.id} not found`);
    // "me" (the owner) is always valid, even before the owner's member record exists.
    if (assignee.kind === "user" && assignee.id !== "me" && !this.q.member(assignee.id)) throw new NotFoundError(`Member ${assignee.id} not found`);
    return { aggregate: "issue", type: add ? "AssigneeAdded" : "AssigneeRemoved", aggregateId: issueId, payload: { assignee } };
  }

  setAssignee(idOrKey: string, assignee: Assignee, on: boolean, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    const resolved: Assignee = assignee.kind === "agent" ? { kind: "agent", id: this.q.agent(assignee.id)?.id ?? assignee.id } : assignee;
    const has = issue.assignees.some((a) => a.kind === resolved.kind && a.id === resolved.id);
    if (on === has) return;
    this.emit(this.assigneeEvent(issue.id, resolved, on), actor);
  }

  comment(idOrKey: string, body: string, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    this.emit({ aggregate: "issue", type: "CommentAdded", aggregateId: issue.id, payload: { body } }, actor);
  }

  private commentOrThrow(issueId: string, seq: number) {
    const c = this.q.comments(issueId).find((x) => x.seq === seq);
    if (!c) throw new NotFoundError("Comment not found");
    return c;
  }

  /** Only the author edits their words. */
  editComment(idOrKey: string, seq: number, body: string, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    if (this.commentOrThrow(issue.id, seq).author !== actor) throw new ConflictError("You can only edit your own comments");
    if (!body.trim()) throw new ValidationError("A comment cannot be empty");
    this.emit({ aggregate: "issue", type: "CommentEdited", aggregateId: issue.id, payload: { seq, body } }, actor);
  }

  /** The author, or an admin (`asAdmin`), can delete a comment. */
  deleteComment(idOrKey: string, seq: number, asAdmin: boolean, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    if (this.commentOrThrow(issue.id, seq).author !== actor && !asAdmin) throw new ConflictError("Only the author or an admin can delete a comment");
    this.emit({ aggregate: "issue", type: "CommentDeleted", aggregateId: issue.id, payload: { seq } }, actor);
  }

  react(idOrKey: string, seq: number, reaction: Reaction, on: boolean, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    const c = this.commentOrThrow(issue.id, seq);
    if ((c.reactions[reaction] ?? []).includes(actor) === on) return;
    this.emit({ aggregate: "issue", type: "CommentReacted", aggregateId: issue.id, payload: { seq, reaction, on } }, actor);
  }

  addLink(idOrKey: string, link: { kind: LinkKind; ref: string; title?: string }, actor: Actor = currentActor()): IssueLink {
    const issue = this.issueOrThrow(idOrKey);
    const full: IssueLink = { id: this.newId(), kind: link.kind, ref: link.ref, title: link.title ?? link.ref };
    this.emit({ aggregate: "issue", type: "LinkAdded", aggregateId: issue.id, payload: { link: full } }, actor);
    return full;
  }

  removeLink(idOrKey: string, linkId: string, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    this.emit({ aggregate: "issue", type: "LinkRemoved", aggregateId: issue.id, payload: { linkId } }, actor);
  }

  deleteIssue(idOrKey: string, actor: Actor = currentActor()): void {
    const issue = this.issueOrThrow(idOrKey);
    this.emit({ aggregate: "issue", type: "IssueDeleted", aggregateId: issue.id, payload: {} }, actor);
  }
}
