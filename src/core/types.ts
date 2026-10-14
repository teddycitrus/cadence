// Shared domain types. Imported by both the server and the web client, so this
// file must stay free of runtime Node imports.

import type { ProviderId, ProviderSummary } from "./providers";
export type { ProviderId } from "./providers";
export * from "./chat-types";
import type { Chat, ChatItem, Interaction, QueuedMessage } from "./chat-types";

export const STAGE_CATEGORIES = ["triage", "in_progress", "in_review", "done", "cancelled"] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];

export const ISSUE_TYPES = ["bug", "feature", "improvement", "chore"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const PERMISSION_MODES = ["ask", "acceptEdits", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const RUN_STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Who did something: the local user, or an agent (by id). */
/**
 * Who did something. "user" is the owner (the person running Cadence),
 * `member:` a teammate who signed in, `token:` an outside agent over MCP.
 */
export type Actor = "user" | `member:${string}` | `agent:${string}` | `chat:${string}` | "system" | `webhook:${string}` | `token:${string}`;

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** A person in the organization. The owner always has id "me". */
export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  color: string;
  createdAt: string;
  /** Added to every chat this person starts. */
  systemPrompt?: string;
  /** What they do (from onboarding): engineer, designer, product, founder, other. */
  jobRole?: string;
  /** Saved board views this person starred; they show first. */
  favoriteViews?: string[];
  /** Set when this person hides the getting-started checklist. */
  gettingStartedHidden?: boolean;
  /** Canvases this person pinned to the top of the canvas home ("workspaceId|path"). */
  pinnedCanvases?: string[];
  /** When they finished (or skipped) onboarding. */
  onboardedAt?: string;
}

/** A saved workflow a person (or their assistant) can reuse in any chat. */
export interface Skill {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Stage {
  id: string;
  name: string;
  category: StageCategory;
  color: string;
  position: number;
  /** Agents may not move cards out of a gated stage; a human decides. */
  humanGate: boolean;
  /** Hidden stages exist but are not shown as board columns. */
  hidden: boolean;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Assignee {
  kind: "user" | "agent";
  id: string;
}

export type LinkKind = "doc" | "pr" | "branch" | "url" | "linear";

export interface IssueLink {
  id: string;
  kind: LinkKind;
  ref: string;
  title: string;
}

export interface Issue {
  id: string;
  key: string;
  title: string;
  body: string;
  type: IssueType;
  priority: Priority;
  estimate: number | null;
  /** Calendar dates (YYYY-MM-DD); the timeline layout draws issues that have them. */
  startDate?: string | null;
  dueDate?: string | null;
  stageId: string;
  labelIds: string[];
  assignees: Assignee[];
  projectId: string | null;
  branch: string | null;
  worktreePath: string | null;
  links: IssueLink[];
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  /** Who made the latest change, for unread markers. */
  updatedBy?: Actor;
  /** Position under manual ordering (lower first); unset issues sort newest first. See manualKey. */
  rank?: number | null;
  /** The last move Cadence made on its own (from a pull request), until someone moves the issue. */
  autoMove?: { from: string; to: string; reason: "pr_opened" | "pr_merged"; at: string } | null;
}

export const REACTIONS = ["+1", "tada", "heart", "eyes", "rocket", "confused"] as const;
export type Reaction = (typeof REACTIONS)[number];

export interface Comment {
  seq: number;
  issueId: string;
  author: Actor;
  body: string;
  ts: string;
  editedAt: string | null;
  /** Who reacted with each emoji. */
  reactions: Partial<Record<Reaction, Actor[]>>;
}

export interface ProjectCommand {
  name: string;
  command: string;
}

/** One person's own setup script and Run commands for a project, visible only to them. */
export interface PersonalScripts {
  setupScript: string | null;
  commands: ProjectCommand[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  baseBranch: string;
  githubRepo: string | null;
  /** Shared with the whole organization. */
  setupScript: string | null;
  commands: ProjectCommand[];
  /** Per member id. Snapshots only carry the viewer's own entry. */
  personal?: Record<string, PersonalScripts>;
  createdAt: string;
}

export type TriggerKind =
  | "assigned"
  | "issue_created"
  | "issue_moved"
  | "label_added"
  | "issue_commented"
  | "schedule"
  | "webhook"
  | "github"
  | "slack";

export const GITHUB_EVENTS = ["pr_opened", "pr_merged", "pr_ready_for_review", "pr_review_submitted", "release_published"] as const;
export type GithubEvent = (typeof GITHUB_EVENTS)[number];

export const SLACK_EVENTS = ["message", "mention", "reaction"] as const;
export type SlackEvent = (typeof SLACK_EVENTS)[number];

export type Trigger =
  | { id: string; kind: "assigned" }
  | { id: string; kind: "issue_created"; stageIds: string[]; types: IssueType[] }
  | { id: string; kind: "issue_moved"; toStageIds: string[] }
  | { id: string; kind: "label_added"; labelIds: string[] }
  | { id: string; kind: "issue_commented" }
  /** `timezone` is an IANA zone (Europe/Berlin); without one, the server's zone. */
  | { id: string; kind: "schedule"; cron: string; description: string; timezone?: string }
  | { id: string; kind: "webhook"; secret: string }
  /** `authors`: only pull requests (or releases) by these GitHub logins; anyone when empty. */
  | { id: string; kind: "github"; events: GithubEvent[]; secret: string; authors?: string[] }
  /** Slack activity in the listed channels (all channels the bot is in when empty); reactions can be limited to emoji names. */
  | { id: string; kind: "slack"; events: SlackEvent[]; channelIds: string[]; emoji: string[]; includeBots?: boolean };

/** A trigger before it has been given an id. */
export type TriggerInput = Trigger extends infer T ? (T extends Trigger ? Omit<T, "id"> & { id?: string } : never) : never;

export interface Agent {
  id: string;
  name: string;
  description: string;
  color: string;
  icon?: string | null;
  prompt: string;
  /** The harness it runs on. */
  provider: ProviderId;
  /** This agent's own spending limit per month; none when unset. */
  monthlyBudgetUsd?: number | null;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  projectId: string | null;
  enabled: boolean;
  triggers: Trigger[];
  templateId: string | null;
  /** The member whose agent this is; it runs with their setup on the host machine. */
  ownerId: string;
  /** Private agents are only readable by their owner; public ones the whole team can read and copy. */
  visibility: AgentVisibility;
  /** For public agents: whether teammates may only read and copy it ("view", the default) or also change it ("edit"). */
  publicAccess?: AgentPublicAccess;
  createdAt: string;
  updatedAt: string;
}

export const AGENT_VISIBILITIES = ["private", "public"] as const;
export type AgentVisibility = (typeof AGENT_VISIBILITIES)[number];
export const AGENT_PUBLIC_ACCESS = ["view", "edit"] as const;
export type AgentPublicAccess = (typeof AGENT_PUBLIC_ACCESS)[number];

export interface Run {
  id: string;
  agentId: string;
  issueId: string | null;
  workspaceId: string | null;
  chatId: string | null;
  trigger: TriggerKind | "manual";
  context: string;
  /** Runs from the same conversation elsewhere (a Slack thread) share one workspace and chat. */
  threadKey: string | null;
  status: RunStatus;
  summary: string | null;
  error: string | null;
  costUsd: number;
  numTurns: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Workspace {
  id: string;
  projectId: string | null;
  issueId: string | null;
  agentId: string | null;
  name: string;
  branch: string | null;
  baseBranch: string | null;
  path: string;
  pinned: boolean;
  archived: boolean;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export type DocKind = "markdown" | "pdf";

export interface Doc {
  id: string;
  title: string;
  /** Markdown. Agents and people edit the same text. */
  body: string;
  icon: string | null;
  kind: DocKind;
  /** The original file for imported PDFs. */
  assetId: string | null;
  parentId: string | null;
  position: number;
  issueId: string | null;
  /** Increments on every content change; saves must name the version they edited. */
  version: number;
  createdBy: Actor;
  updatedBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export type ChecksState = "none" | "pending" | "success" | "failure";
export type ReviewState = "none" | "approved" | "changes_requested" | "commented";

export interface PullRequestCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

/** A GitHub pull request Cadence follows (linked to an issue or opened from a workspace). */
export interface PullRequest {
  id: string;
  url: string;
  repo: string;
  number: number;
  issueId: string | null;
  workspaceId: string | null;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  checks: ChecksState;
  checkRuns: PullRequestCheck[];
  review: ReviewState;
  refreshedAt: string | null;
  error: string | null;
}

/** A canvas edit that could not be written deterministically, waiting for an agent. */
export interface CanvasEdit {
  id: string;
  workspaceId: string;
  /** Source location "file:line:col" of the element, or the canvas file. */
  loc: string;
  description: string;
  createdAt: string;
}

/** A comment pinned to a point on a canvas (or a frame in it). */
export interface CanvasComment {
  id: string;
  workspaceId: string;
  canvasPath: string;
  storyId: string | null;
  x: number;
  y: number;
  parentId: string | null;
  body: string;
  /** Uploaded images (asset URLs) shown under the message. */
  attachments?: { url: string; name: string }[];
  reactions?: Partial<Record<Reaction, Actor[]>>;
  editedAt?: string | null;
  /** When each member last read the thread (root comments only). */
  readBy?: Record<string, string>;
  author: Actor;
  resolved: boolean;
  createdAt: string;
}

/** Read-only public access to one doc, issue, or canvas. */
export interface ShareLink {
  id: string;
  kind: "doc" | "issue" | "canvas";
  /** Doc or issue id, or "workspaceId|path" for a canvas. */
  ref: string;
  title: string;
  createdBy: Actor;
  createdAt: string;
  revoked: boolean;
}

/** Another computer whose Cadence this hub can open (see src/machines). */
export interface Machine {
  id: string;
  name: string;
  /** sha256 of the connect token; never sent to browsers. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  hostname: string | null;
  platform: string | null;
  version: string | null;
}

export interface Asset {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  file: string;
  createdAt: string;
}

export interface DocVersion {
  seq: number;
  version: number;
  title: string;
  body: string;
  actor: Actor;
  ts: string;
}

export interface Settings {
  concurrency: number;
  /** The harness new chats and agents use unless they pick another. Older data has none: Claude Code. */
  defaultProvider?: ProviderId;
  defaultModel: string;
  defaultEffort: Effort;
  /** Spending limit per calendar month (UTC) for the whole organization; none when unset. */
  monthlyBudgetUsd?: number | null;
  maxTurns: number;
  systemPrompt: string;
  /** Move an issue to review when its pull request opens, and to done when it merges. On unless turned off. */
  autoMoveIssues?: boolean;
}

export interface StoredEvent {
  seq: number;
  aggregate: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  actor: Actor;
  ts: string;
}

export interface Snapshot {
  stages: Stage[];
  labels: Label[];
  issues: Issue[];
  agents: Agent[];
  runs: Run[];
  projects: Project[];
  docs: Doc[];
  workspaces: Workspace[];
  chats: Chat[];
  pullRequests: PullRequest[];
  github: { connected: boolean; source: "env" | "settings" | "gh" | null };
  members: Member[];
  /** The member viewing this snapshot, and their role. */
  viewer: { memberId: string; role: Role };
  pendingInteractions: Interaction[];
  /** Saved board views: the viewer's own and the shared ones. */
  issueViews: IssueView[];
  /** When the viewer last opened each issue (issue id to ISO time). */
  issueReads: Record<string, string>;
  settings: Settings;
  providers: ProviderSummary[];
  runtimeReady: boolean;
}

import type { IssueView } from "./issue-views";

export interface IssueDetail {
  issue: Issue;
  comments: Comment[];
  timeline: StoredEvent[];
  runs: Run[];
  docs: Doc[];
  workspaces: Workspace[];
}

export interface ChatDetail {
  chat: Chat;
  items: ChatItem[];
  queued: QueuedMessage[];
  interactions: Interaction[];
}
