import type { Interaction, Issue, IssueType, Priority, Run, Stage } from "./types";

// Saved views of the board: which issues to show and how to lay them out.
// The filtering is shared by the server (validation, tests) and the web app.

export const VIEW_SCOPES = ["all", "mine", "agents", "active", "awaiting"] as const;
export type ViewScope = (typeof VIEW_SCOPES)[number];
export const VIEW_LAYOUTS = ["board", "list", "timeline"] as const;
export const VIEW_GROUPS = ["stage", "priority", "assignee", "project", "type", "none"] as const;
export const VIEW_ORDERS = ["manual", "priority", "updated", "created", "title"] as const;
/** What a card or row shows besides its title. */
export const CARD_PROPS = ["key", "priority", "type", "labels", "assignees", "estimate", "prs", "agent"] as const;
export type CardProp = (typeof CARD_PROPS)[number];
export type ViewGroup = (typeof VIEW_GROUPS)[number];
export type ViewOrder = (typeof VIEW_ORDERS)[number];

export interface IssueFilters {
  scope: ViewScope;
  query: string;
  priorities: Priority[];
  types: IssueType[];
  labelIds: string[];
  /** Member ids, agent ids, or "none" for unassigned. */
  assigneeIds: string[];
  /** Project ids, or "none" for issues without a project. */
  projectIds: string[];
}

export interface IssueDisplay {
  layout: (typeof VIEW_LAYOUTS)[number];
  groupBy: ViewGroup;
  orderBy: ViewOrder;
  showHidden: boolean;
  /** Groups within each group (list layout). */
  subGroupBy?: ViewGroup;
  /** Card details to show; all of them when unset. */
  properties?: CardProp[];
}

export interface IssueView {
  id: string;
  name: string;
  /** The member who saved it. */
  ownerId: string;
  /** Shared views show for everyone in the org; others only for their owner. */
  shared: boolean;
  filters: IssueFilters;
  display: IssueDisplay;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_FILTERS: IssueFilters = { scope: "all", query: "", priorities: [], types: [], labelIds: [], assigneeIds: [], projectIds: [] };
export const DEFAULT_DISPLAY: IssueDisplay = { layout: "board", groupBy: "stage", orderBy: "manual", showHidden: false };

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export interface FilterContext {
  viewerId: string;
  runs: Pick<Run, "issueId" | "status" | "chatId">[];
  /** Pending interactions, for "awaiting response". */
  pending: Pick<Interaction, "chatId" | "kind">[];
  /** Chat ids that belong to each issue (through its workspaces or runs). */
  issueChats: (issue: Issue) => string[];
}

/**
 * Changed by someone else since the viewer last opened it. Only for issues
 * the viewer is part of (created or assigned), so the whole board is not unread.
 */
export function isUnread(issue: Issue, viewerId: string, readAt: string | undefined): boolean {
  const me = viewerId === "me" ? "user" : `member:${viewerId}`;
  const involved = issue.createdBy === me || issue.assignees.some((a) => a.kind === "user" && a.id === viewerId);
  if (!involved || !issue.updatedBy || issue.updatedBy === me) return false;
  return !readAt || issue.updatedAt > readAt;
}

/** Whether an agent on this issue is waiting for a person (an approval or an answer). */
export function isAwaiting(issue: Issue, ctx: FilterContext): boolean {
  if (ctx.runs.some((r) => r.issueId === issue.id && r.status === "waiting")) return true;
  const chats = new Set(ctx.issueChats(issue));
  return ctx.pending.some((p) => chats.has(p.chatId));
}

export function matches(issue: Issue, f: IssueFilters, ctx: FilterContext): boolean {
  const needle = f.query.trim().toLowerCase();
  if (needle && !`${issue.key} ${issue.title} ${issue.body}`.toLowerCase().includes(needle)) return false;
  if (f.priorities.length && !f.priorities.includes(issue.priority)) return false;
  if (f.types.length && !f.types.includes(issue.type)) return false;
  if (f.labelIds.length && !f.labelIds.some((l) => issue.labelIds.includes(l))) return false;
  if (f.projectIds.length && !f.projectIds.includes(issue.projectId ?? "none")) return false;
  if (f.assigneeIds.length) {
    const ids = issue.assignees.map((a) => a.id);
    if (!f.assigneeIds.some((id) => (id === "none" ? ids.length === 0 : ids.includes(id)))) return false;
  }
  switch (f.scope) {
    case "mine":
      return issue.assignees.some((a) => a.kind === "user" && a.id === ctx.viewerId);
    case "agents":
      return issue.assignees.some((a) => a.kind === "agent");
    case "active":
      return ctx.runs.some((r) => r.issueId === issue.id && ["queued", "running", "waiting"].includes(r.status));
    case "awaiting":
      return isAwaiting(issue, ctx);
    default:
      return true;
  }
}

/** Sort key under manual ordering: the issue's rank, or newest first for issues never placed by hand. */
export function manualKey(issue: Pick<Issue, "rank" | "createdAt">): number {
  return issue.rank ?? -Date.parse(issue.createdAt) / 1000;
}

/** A rank that puts an issue between two neighbors (either may be missing: the top or bottom of the list). */
export function rankBetween(above: Pick<Issue, "rank" | "createdAt"> | null, below: Pick<Issue, "rank" | "createdAt"> | null): number | null {
  if (above && below) return (manualKey(above) + manualKey(below)) / 2;
  if (above) return manualKey(above) + 1;
  if (below) return manualKey(below) - 1;
  return null;
}

/** "manual" is the hand-placed order (newest first until someone drags); the others sort, keeping that order for ties. */
export function orderIssues(issues: Issue[], order: ViewOrder): Issue[] {
  const out = [...issues];
  if (order === "manual") return out.sort((a, b) => manualKey(a) - manualKey(b));
  const index = new Map(issues.map((i, n) => [i.id, n]));
  switch (order) {
    case "priority":
      return out.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || index.get(a.id)! - index.get(b.id)!);
    case "updated":
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    case "created":
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case "title":
      return out.sort((a, b) => a.title.localeCompare(b.title));
    default:
      return out;
  }
}

export interface Group {
  key: string;
  label: string;
  issues: Issue[];
}

/** Groups for the list layout, in a stable, meaningful order. */
export function groupIssues(issues: Issue[], by: ViewGroup, names: { stages: Stage[]; member: (id: string) => string | undefined; agent: (id: string) => string | undefined; project: (id: string) => string | undefined }): Group[] {
  if (by === "none") return [{ key: "all", label: "All issues", issues }];
  const groups = new Map<string, Group>();
  const add = (key: string, label: string, issue: Issue) => {
    const g = groups.get(key) ?? { key, label, issues: [] };
    g.issues.push(issue);
    groups.set(key, g);
  };
  for (const i of issues) {
    if (by === "stage") add(i.stageId, names.stages.find((s) => s.id === i.stageId)?.name ?? "Unknown stage", i);
    else if (by === "priority") add(i.priority, i.priority === "none" ? "No priority" : i.priority[0]!.toUpperCase() + i.priority.slice(1), i);
    else if (by === "type") add(i.type, i.type[0]!.toUpperCase() + i.type.slice(1), i);
    else if (by === "project") add(i.projectId ?? "none", i.projectId ? (names.project(i.projectId) ?? "Unknown project") : "No project", i);
    else if (!i.assignees.length) add("none", "Unassigned", i);
    else for (const a of i.assignees) add(a.id, (a.kind === "user" ? names.member(a.id) : names.agent(a.id)) ?? "Unknown", i);
  }
  const list = [...groups.values()];
  if (by === "stage") return list.sort((a, b) => (names.stages.find((s) => s.id === a.key)?.position ?? 0) - (names.stages.find((s) => s.id === b.key)?.position ?? 0));
  if (by === "priority") return list.sort((a, b) => PRIORITY_RANK[a.key as Priority] - PRIORITY_RANK[b.key as Priority]);
  return list.sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.label.localeCompare(b.label)));
}
