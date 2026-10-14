import type {
  Agent,
  AgentVisibility, AgentPublicAccess,
  ProviderId,
  Attachment,
  ChatItemData,
  ChatMode,
  ChatStatus,
  ChecksState,
  DocKind,
  GithubEvent,
  PullRequestCheck,
  ReviewState,
  InteractionKind,
  Question,
  Assignee,
  Effort,
  IssueLink,
  IssueType,
  PermissionMode,
  Priority,
  ProjectCommand,
  Settings,
  StageCategory,
  Trigger,
  TriggerKind,
  Role,
  ShareLink,
  Reaction,
} from "./types";
import type { IssueDisplay, IssueFilters } from "./issue-views";

// Every state change in Cadence is recorded as one of these events. Read
// models (tables queried by the API) are projections of the event log and can
// be rebuilt by replaying it.

type E<A extends string, T extends string, P> = { aggregate: A; type: T; aggregateId: string; payload: P };

export type StageEvent =
  | E<"stage", "StageCreated", { name: string; category: StageCategory; color: string; position: number; humanGate: boolean; hidden: boolean }>
  | E<"stage", "StageUpdated", { name?: string; color?: string; humanGate?: boolean; hidden?: boolean }>
  | E<"stage", "StagesReordered", { order: string[] }>
  | E<"stage", "StageDeleted", { moveIssuesTo: string }>;

export type LabelEvent =
  | E<"label", "LabelCreated", { name: string; color: string }>
  | E<"label", "LabelUpdated", { name?: string; color?: string }>
  | E<"label", "LabelDeleted", Record<string, never>>;

export interface IssueFields {
  title?: string;
  body?: string;
  type?: IssueType;
  priority?: Priority;
  estimate?: number | null;
  projectId?: string | null;
  /** Calendar dates (YYYY-MM-DD) for the timeline. */
  startDate?: string | null;
  dueDate?: string | null;
}

export type IssueEvent =
  | E<"issue", "IssueCreated", { key: string; title: string; body: string; type: IssueType; priority: Priority; stageId: string; projectId: string | null; labelIds: string[] }>
  | E<"issue", "IssueUpdated", IssueFields>
  | E<"issue", "IssueRead", { memberId: string }>
  | E<"issue", "IssueMoved", { from: string; to: string; auto?: "pr_opened" | "pr_merged" }>
  | E<"issue", "IssueRanked", { rank: number }>
  | E<"issue", "LabelAdded", { labelId: string }>
  | E<"issue", "LabelRemoved", { labelId: string }>
  | E<"issue", "AssigneeAdded", { assignee: Assignee }>
  | E<"issue", "AssigneeRemoved", { assignee: Assignee }>
  | E<"issue", "CommentAdded", { body: string }>
  | E<"issue", "CommentEdited", { seq: number; body: string }>
  | E<"issue", "CommentDeleted", { seq: number }>
  | E<"issue", "CommentReacted", { seq: number; reaction: Reaction; on: boolean }>
  | E<"issue", "LinkAdded", { link: IssueLink }>
  | E<"issue", "LinkRemoved", { linkId: string }>
  | E<"issue", "BranchCreated", { branch: string; worktreePath: string }>
  | E<"issue", "IssueDeleted", Record<string, never>>;

export type ProjectEvent =
  | E<"project", "ProjectAdded", { name: string; path: string; baseBranch: string; githubRepo: string | null; setupScript: string | null; commands: ProjectCommand[] }>
  | E<"project", "ProjectUpdated", { name?: string; baseBranch?: string; githubRepo?: string | null; setupScript?: string | null; commands?: ProjectCommand[] }>
  | E<"project", "ProjectRemoved", Record<string, never>>
  | E<"project", "ProjectPersonalScriptsSet", { memberId: string; setupScript?: string | null; commands?: ProjectCommand[] }>;

export interface AgentFields {
  name?: string;
  description?: string;
  color?: string;
  /** One of AGENT_ICONS; the agent's initial when unset. */
  icon?: string | null;
  prompt?: string;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  projectId?: string | null;
  triggers?: Trigger[];
  visibility?: AgentVisibility;
  publicAccess?: AgentPublicAccess;
  provider?: ProviderId;
  monthlyBudgetUsd?: number | null;
}

export type AgentEvent =
  | E<"agent", "AgentCreated", Required<Omit<AgentFields, "visibility" | "publicAccess" | "provider" | "monthlyBudgetUsd" | "icon">> & { icon?: string | null; templateId: string | null; enabled: boolean; ownerId?: string; visibility?: AgentVisibility; publicAccess?: AgentPublicAccess; provider?: ProviderId; monthlyBudgetUsd?: number | null }>
  | E<"agent", "AgentUpdated", AgentFields>
  | E<"agent", "AgentEnabled", Record<string, never>>
  | E<"agent", "AgentDisabled", Record<string, never>>
  | E<"agent", "AgentDeleted", Record<string, never>>;

export type RunEvent =
  | E<"run", "RunQueued", { agentId: string; issueId: string | null; trigger: TriggerKind | "manual"; context: string; threadKey?: string | null }>
  | E<"run", "RunStarted", Record<string, never>>
  | E<"run", "RunAttached", { workspaceId: string; chatId: string }>
  | E<"run", "RunContextUpdated", { context: string }>
  | E<"run", "RunSucceeded", { summary: string; costUsd: number; numTurns: number }>
  | E<"run", "RunFailed", { error: string; costUsd: number; numTurns: number }>
  | E<"run", "RunCancelled", Record<string, never>>;

export type WorkspaceEvent =
  | E<"workspace", "WorkspaceCreated", { projectId: string | null; issueId: string | null; agentId: string | null; name: string; branch: string | null; baseBranch: string | null; path: string }>
  | E<"workspace", "WorkspaceUpdated", { name?: string; pinned?: boolean; branch?: string }>
  | E<"workspace", "WorkspaceArchived", Record<string, never>>
  | E<"workspace", "WorkspaceRestored", Record<string, never>>
  | E<"workspace", "WorkspaceDeleted", Record<string, never>>;

export type ChatEvent =
  | E<"chat", "ChatCreated", { workspaceId: string; title: string; provider: string; model: string; effort: Effort; mode: ChatMode; agentId: string | null; docId?: string | null; threadKey?: string | null }>
  | E<"chat", "ChatUpdated", { title?: string; provider?: ProviderId; model?: string; effort?: Effort; mode?: ChatMode; fast?: boolean; mcpServers?: string[] | null; remoteControl?: boolean; slackThreads?: { follow: string[]; muted: string[] } }>
  | E<"chat", "ChatSessionStarted", { sessionId: string; slashCommands: string[]; commandHints?: Record<string, string> }>
  | E<"chat", "ChatStatusChanged", { status: ChatStatus; reason?: "restart" }>
  | E<"chat", "ChatItemAdded", { item: ChatItemData }>
  | E<"chat", "ChatUsage", { costUsd: number; inputTokens: number; outputTokens: number; model?: string }>
  | E<"chat", "ChatRead", Record<string, never>>
  | E<"chat", "ChatMarkedUnread", Record<string, never>>
  | E<"chat", "ChatForked", { fromChatId: string; upToSeq: number }>
  | E<"chat", "ChatArchived", { archived: boolean }>
  | E<"chat", "ChatTransferred", { fromWorkspaceId: string; toWorkspaceId: string }>
  | E<"chat", "ChatDeleted", Record<string, never>>
  | E<"chat", "MessageQueued", { queuedId: string; text: string; attachments: Attachment[] }>
  | E<"chat", "QueuedMessageEdited", { queuedId: string; text: string }>
  | E<"chat", "QueuedMessageRemoved", { queuedId: string }>
  | E<"chat", "InteractionRequested", { interactionId: string; runId: string | null; kind: InteractionKind; toolName: string; input: Record<string, unknown>; questions: Question[]; plan: string | null }>
  | E<"chat", "InteractionResolved", { interactionId: string; status: "resolved" | "cancelled"; resolution: string }>;

export type DocEvent =
  | E<"doc", "DocCreated", { title: string; body: string; icon: string | null; kind: DocKind; assetId: string | null; parentId: string | null; issueId: string | null; position: number }>
  | E<"doc", "DocUpdated", { title?: string; body?: string; icon?: string | null; issueId?: string | null }>
  | E<"doc", "DocMoved", { parentId: string | null; position: number }>
  | E<"doc", "DocDeleted", Record<string, never>>;

export type PullRequestEvent =
  | E<"pr", "PullRequestTracked", { url: string; repo: string; number: number; issueId: string | null; workspaceId: string | null }>
  | E<"pr", "PullRequestUpdated", { title: string; state: "open" | "closed"; merged: boolean; draft: boolean; headRef: string; headSha: string; checks: ChecksState; checkRuns: PullRequestCheck[]; review: ReviewState; transitions: GithubEvent[] }>
  | E<"pr", "PullRequestRefreshFailed", { error: string }>
  | E<"pr", "PullRequestLinked", { issueId: string | null; workspaceId: string | null }>;

export type MemberEvent =
  | E<"member", "MemberJoined", { name: string; email: string; role: Role; color: string }>
  | E<"member", "MemberUpdated", { name?: string; email?: string; role?: Role; systemPrompt?: string; jobRole?: string; onboardedAt?: string; favoriteViews?: string[]; pinnedCanvases?: string[]; gettingStartedHidden?: boolean }>
  | E<"member", "MemberRemoved", {}>;

export type SkillEvent = E<"skill", "SkillSaved", { ownerId: string; name: string; description: string; body: string }> | E<"skill", "SkillDeleted", {}>;

export type ShareEvent = E<"share", "ShareCreated", { kind: ShareLink["kind"]; ref: string; title: string }> | E<"share", "ShareRevoked", {}>;

export type CanvasEvent =
  | E<"canvas", "CanvasEditStaged", { workspaceId: string; loc: string; description: string }>
  | E<"canvas", "CanvasEditRemoved", {}>
  | E<"canvas", "CanvasCommentAdded", { workspaceId: string; canvasPath: string; storyId: string | null; x: number; y: number; parentId: string | null; body: string; attachments?: { url: string; name: string }[] }>
  | E<"canvas", "CanvasCommentReacted", { reaction: Reaction; on: boolean }>
  | E<"canvas", "CanvasCommentEdited", { body: string }>
  | E<"canvas", "CanvasCommentMoved", { x?: number; y?: number; storyId?: string | null; workspaceId?: string }>
  | E<"canvas", "CanvasCommentRead", { memberId: string }>
  | E<"canvas", "CanvasCommentUnread", { memberId: string }>
  | E<"canvas", "CanvasCommentResolved", { resolved: boolean }>
  | E<"canvas", "CanvasCommentDeleted", {}>;

export type AssetEvent = E<"asset", "AssetAdded", { name: string; mediaType: string; size: number; file: string }>;

export type IssueViewEvent =
  | E<"issueView", "IssueViewSaved", { name: string; ownerId: string; shared: boolean; filters: IssueFilters; display: IssueDisplay }>
  | E<"issueView", "IssueViewDeleted", {}>;

export type MachineEvent =
  | E<"machine", "MachineAdded", { name: string; tokenHash: string }>
  | E<"machine", "MachineConnected", { hostname: string; platform: string; version: string }>
  | E<"machine", "MachineRenamed", { name: string }>
  | E<"machine", "MachineRemoved", {}>;

export type SettingsEvent = E<"settings", "SettingsChanged", Partial<Settings>>;

export type DomainEvent = StageEvent | LabelEvent | IssueEvent | ProjectEvent | AgentEvent | RunEvent | WorkspaceEvent | ChatEvent | DocEvent | AssetEvent | PullRequestEvent | CanvasEvent | MemberEvent | ShareEvent | SkillEvent | MachineEvent | IssueViewEvent | SettingsEvent;
export type DomainEventType = DomainEvent["type"];
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

/** The fields an agent definition carries, for templates and validation. */
export type AgentDefinition = Pick<Agent, "name" | "description" | "color" | "prompt" | "model" | "effort" | "permissionMode" | "triggers">;
