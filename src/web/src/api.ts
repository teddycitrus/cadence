import type {
  Agent,
  Attachment,
  CanvasComment,
  CanvasEdit,
  Chat,
  ChatDetail,
  ChatMode,
  Doc,
  DocVersion,
  Effort,
  Issue,
  IssueDetail,
  IssueLink,
  Member,
  ShareLink,
  Skill,
  Project,
  PullRequest,
  Run,
  Settings,
  Snapshot,
  TriggerInput,
  Workspace,
} from "../../core/types";
import type { ProviderId, ProviderStatus } from "../../core/providers";
import { currentOrg } from "./org";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The full error response, e.g. the current doc on a save conflict. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** `keepalive`: let the request finish after the page closes (browsers allow this only for small bodies). */
async function request<T>(method: string, path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "x-cadence-org": currentOrg(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: text,
    keepalive: Boolean(opts.keepalive) && (text?.length ?? 0) < 60_000,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  // The session ended (or never began): the app shows sign-in.
  if (res.status === 401 && (data as { signIn?: boolean }).signIn) window.dispatchEvent(new Event("cadence:signed-out"));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data as Record<string, unknown>);
  return data as T;
}

export type { Requirement } from "../../projects/requirements";
import type { Requirement } from "../../projects/requirements";

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  color: string;
  effort: string;
  needs?: string;
  triggers: TriggerInput[];
  prompt: string;
}

export type AgentDraft = Partial<Omit<Agent, "id" | "triggers" | "ownerId" | "templateId" | "enabled" | "createdAt" | "updatedAt">> & { triggers?: TriggerInput[] };

export interface WorkspaceStatus {
  branch: string | null;
  baseBranch: string | null;
  files: { path: string; status: string }[];
  ahead: number;
  behind: number;
  onDisk: boolean;
}

export interface MessageInput {
  text: string;
  attachments: Attachment[];
  mentions: { kind: "file" | "doc" | "issue"; ref: string }[];
  steer: boolean;
}

const q = encodeURIComponent;

export const api = {
  snapshot: () => request<Snapshot>("GET", "/snapshot"),
  templates: () => request<TemplateSummary[]>("GET", "/templates"),
  updateSettings: (patch: Partial<Settings>) => request<Settings>("PATCH", "/settings", patch),

  createStage: (input: { name: string; category: string; color: string; humanGate?: boolean }) => request("POST", "/stages", input),
  updateStage: (id: string, patch: Record<string, unknown>) => request("PATCH", `/stages/${id}`, patch),
  reorderStages: (order: string[]) => request("POST", "/stages/reorder", { order }),
  deleteStage: (id: string, moveIssuesTo: string) => request("DELETE", `/stages/${id}`, { moveIssuesTo }),
  createLabel: (input: { name: string; color: string }) => request<{ id: string }>("POST", "/labels", input),
  deleteLabel: (id: string) => request("DELETE", `/labels/${id}`),

  issue: (id: string) => request<IssueDetail>("GET", `/issues/${id}`),
  createIssue: (input: Record<string, unknown>) => request<Issue>("POST", "/issues", input),
  updateIssue: (id: string, patch: Record<string, unknown>) => request<Issue>("PATCH", `/issues/${id}`, patch),
  deleteIssue: (id: string) => request("DELETE", `/issues/${id}`),
  retryRun: (id: string) => request<{ runId: string }>("POST", `/runs/${id}/retry`),
  cancelQueuedRuns: (agentId?: string) => request<{ cancelled: number }>("POST", "/runs/cancel-queued", { agentId }),
  triggerStatus: (agentId: string) => request<TriggerStatus>("GET", `/agents/${agentId}/triggers/status`),
  markIssueRead: (id: string) => request<{ ok: true }>("POST", `/issues/${id}/read`),
  duplicateIssue: (id: string) => request<Issue>("POST", `/issues/${id}/duplicate`),
  favoriteIssueView: (id: string, on: boolean) => request<{ favoriteViews: string[] }>("PUT", `/board/views/${id}/favorite`, { on }),
  hideGettingStarted: () => request<Member>("PUT", "/members/me/onboarding", { hideGettingStarted: true }),
  undoAutoMove: (id: string) => request<Issue>("POST", `/issues/${id}/undo-auto-move`),
  moveIssue: (id: string, stageId: string) => request<Issue>("POST", `/issues/${id}/move`, { stageId }),
  reorderIssue: (id: string, place: { above?: string | null; below?: string | null; stageId?: string | null }) => request<Issue>("POST", `/issues/${id}/reorder`, place),
  toggleLabel: (id: string, labelId: string, on: boolean) => request<Issue>("POST", `/issues/${id}/labels`, { labelId, on }),
  toggleAssignee: (id: string, assignee: { kind: "user" | "agent"; id: string }, on: boolean) => request<Issue>("POST", `/issues/${id}/assignees`, { assignee, on }),
  comment: (id: string, body: string) => request("POST", `/issues/${id}/comments`, { body }),
  addLink: (id: string, link: { kind: string; ref: string; title?: string }) => request<IssueLink>("POST", `/issues/${id}/links`, link),
  removeLink: (id: string, linkId: string) => request("DELETE", `/issues/${id}/links/${linkId}`),
  diff: (id: string) => request<{ diff: string }>("GET", `/issues/${id}/diff`),

  createDoc: (input: { title: string; body?: string; icon?: string | null; parentId?: string | null; issueId?: string | null }) => request<Doc>("POST", "/docs", input),
  doc: (id: string) => request<Doc>("GET", `/docs/${id}`),
  updateDoc: (id: string, patch: { title?: string; body?: string; icon?: string | null; issueId?: string | null; baseVersion?: number; collab?: boolean }, opts?: { keepalive?: boolean }) => request<Doc>("PATCH", `/docs/${id}`, patch, opts),
  moveDoc: (id: string, parentId: string | null, position: number) => request("POST", `/docs/${id}/move`, { parentId, position }),
  deleteDoc: (id: string) => request("DELETE", `/docs/${id}`),
  docHistory: (id: string) => request<DocVersion[]>("GET", `/docs/${id}/history`),
  restoreDoc: (id: string, version: number) => request<Doc>("POST", `/docs/${id}/restore/${version}`),
  importDoc: (input: { name: string; mediaType: string; data: string; parentId?: string | null; issueId?: string | null }) => request<Doc>("POST", "/docs/import", input),
  docChat: (id: string) => request<Chat>("POST", `/docs/${id}/chat`),
  uploadAsset: (input: { name: string; mediaType: string; data: string }) => request<{ id: string; url: string }>("POST", "/assets", input),

  createAgent: (draft: AgentDraft) => request<Agent>("POST", "/agents", draft),
  agentFromTemplate: (templateId: string) => request<Agent>("POST", `/agents/from-template/${templateId}`),
  updateAgent: (id: string, patch: AgentDraft) => request<Agent>("PATCH", `/agents/${id}`, patch),
  copyAgent: (id: string) => request<Agent>("POST", `/agents/${id}/copy`),
  setAgentEnabled: (id: string, enabled: boolean) => request<Agent>("POST", `/agents/${id}/${enabled ? "enable" : "disable"}`),
  deleteAgent: (id: string) => request("DELETE", `/agents/${id}`),
  runAgent: (id: string, input: { issueId?: string | null; note?: string }) => request<{ runId: string }>("POST", `/agents/${id}/run`, input),
  cronFromText: (text: string) => request<{ cron: string; description: string; next: string | null }>("POST", "/agents/cron-from-text", { text }),

  run: (id: string) => request<Run>("GET", `/runs/${id}`),
  cancelRun: (id: string) => request("POST", `/runs/${id}/cancel`),

  addProject: (input: { name: string; path: string; baseBranch?: string; githubRepo: string | null; setupScript: string | null }) => request<Project>("POST", "/projects", input),
  updateProject: (id: string, patch: Record<string, unknown>) => request<Project>("PATCH", `/projects/${id}`, patch),
  removeProject: (id: string) => request("DELETE", `/projects/${id}`),
  inbox: () => request<InboxItem[]>("GET", "/inbox"),
  projectScripts: (id: string) => request<ProjectScripts>("GET", `/projects/${id}/scripts`),
  saveProjectScripts: (id: string, input: { scope: "org" | "user"; setupScript?: string | null; commands?: { name: string; command: string }[] }) => request<ProjectScripts>("PUT", `/projects/${id}/scripts`, input),

  createWorkspace: (input: { projectId: string | null; name: string }) => request<{ workspace: Workspace; chatId: string }>("POST", "/workspaces", input),
  workspacesFromIssues: (input: { issueIds: string[]; prompt: string; model?: string; effort?: Effort }) =>
    request<{ created: { workspaceId: string; chatId: string }[] }>("POST", "/workspaces/from-issues", input),
  updateWorkspace: (id: string, patch: { name?: string; pinned?: boolean }) => request<Workspace>("PATCH", `/workspaces/${id}`, patch),
  archiveWorkspace: (id: string) => request("POST", `/workspaces/${id}/archive`),
  restoreWorkspace: (id: string) => request("POST", `/workspaces/${id}/restore`),
  deleteWorkspace: (id: string, deleteBranch: boolean) => request("DELETE", `/workspaces/${id}`, { deleteBranch }),
  openInTargets: (id: string) => request<{ targets: { id: string; label: string }[] }>("GET", `/workspaces/${id}/open-in`),
  openIn: (id: string, target: string) => request<{ ok: true }>("POST", `/workspaces/${id}/open-in`, { target }),
  workspaceStatus: (id: string, against?: string) => request<WorkspaceStatus>("GET", `/workspaces/${id}/status${against ? `?against=${q(against)}` : ""}`),
  workspaceDiff: (id: string, path?: string, against?: string) => request<{ diff: string }>("GET", `/workspaces/${id}/diff?${path ? `path=${q(path)}&` : ""}${against ? `against=${q(against)}` : ""}`),
  workspaceFiles: (id: string, query: string) => request<{ files: string[] }>("GET", `/workspaces/${id}/files?q=${q(query)}`),

  createChat: (input: { workspaceId: string; title?: string; mode?: ChatMode; provider?: ProviderId }) => request<Chat>("POST", "/chats", input),
  chat: (id: string, after = 0) => request<ChatDetail>("GET", `/chats/${id}?after=${after}`),
  chatPage: (id: string, opts: { limit: number; before?: number } | { after: number }) =>
    request<ChatDetail & { earlier: boolean }>("GET", `/chats/${id}?${"after" in opts ? `after=${opts.after}` : `limit=${opts.limit}${opts.before ? `&before=${opts.before}` : ""}`}`),
  transferChat: (id: string, workspaceId: string) => request<Chat>("POST", `/chats/${id}/transfer`, { workspaceId }),
  providers: () => request<ProviderStatus[]>("GET", "/providers"),
  /** Whether people elsewhere can reach this Cadence, and the owner's tunnel controls. */
  sharing: () => request<SharingStatus & { canManage: boolean }>("GET", "/sharing"),
  startSharing: (mode: "quick" | "named") => request<SharingStatus>("POST", "/sharing/start", { mode }),
  stopSharing: () => request<SharingStatus>("POST", "/sharing/stop"),
  setNamedTunnel: (tunnel: { token: string; url: string } | null) => request<SharingStatus>("PUT", "/sharing/named", { tunnel }),
  updateProvider: (id: ProviderId, patch: { command?: string | null; cliCommand?: string | null; env?: Record<string, string | null>; modelEnv?: Record<string, Record<string, string | null>> }) => request<ProviderStatus>("PUT", `/providers/${id}`, patch),
  /** Opens a terminal running the harness's own sign-in. */
  providerSignIn: (id: ProviderId) => request<TerminalInfo>("POST", `/providers/${id}/sign-in`, { cols: 100, rows: 24 }),
  providerAccount: (id: ProviderId) => request<{ account: ClaudeAccount | null }>("GET", `/providers/${id}/account`),
  checkProvider: (id: ProviderId) => request<{ ok: boolean; reply?: string; error?: string }>("POST", `/providers/${id}/check`),
  restoreFiles: (id: string, seq: number) => request<{ restored: number; removed: number }>("POST", `/chats/${id}/restore`, { seq }),
  forkChat: (id: string, upToSeq: number) => request<Chat>("POST", `/chats/${id}/fork`, { upToSeq }),
  markChatUnread: (id: string) => request<{ ok: true }>("POST", `/chats/${id}/unread`),
  updateChat: (id: string, patch: { title?: string; provider?: ProviderId; model?: string; effort?: Effort; fast?: boolean; remoteControl?: boolean; mcpServers?: string[] | null; mode?: ChatMode; archived?: boolean }) => request<Chat>("PATCH", `/chats/${id}`, patch),
  deleteChat: (id: string) => request("DELETE", `/chats/${id}`),
  sendMessage: (id: string, input: MessageInput) => request<{ queued: boolean }>("POST", `/chats/${id}/messages`, input),
  interrupt: (id: string) => request("POST", `/chats/${id}/interrupt`),
  markRead: (id: string) => request("POST", `/chats/${id}/read`),
  editQueued: (id: string, queuedId: string, text: string) => request("PATCH", `/chats/${id}/queued/${queuedId}`, { text }),
  removeQueued: (id: string, queuedId: string) => request("DELETE", `/chats/${id}/queued/${queuedId}`),
  sendQueuedNow: (id: string, queuedId: string) => request("POST", `/chats/${id}/queued/${queuedId}/send-now`),
  answer: (interactionId: string, answer: Record<string, unknown>) => request<{ newChatId?: string }>("POST", `/chats/interactions/${interactionId}`, answer),

  git: (ws: string) => request<GitOverview>("GET", `/workspaces/${ws}/git`),
  gitHunks: (ws: string, path: string, staged: boolean) => request<{ hunks: { header: string; text: string }[] }>("GET", `/workspaces/${ws}/git/hunks?path=${q(path)}&staged=${staged}`),
  gitFileDiff: (ws: string, path: string, staged: boolean) => request<{ diff: string }>("GET", `/workspaces/${ws}/git/file-diff?path=${q(path)}&staged=${staged}`),
  /** Any source-control action; answers with the fresh repository state. */
  reviewBranch: (ws: string, deep: boolean) => request<{ chatId: string }>("POST", `/workspaces/${ws}/git/review`, { deep }),
  gitAction: (ws: string, action: string, body: Record<string, unknown> = {}) => request<RepoState>("POST", `/workspaces/${ws}/git/${action}`, body),
  commitMessage: (ws: string) => request<{ message: string }>("POST", `/workspaces/${ws}/git/commit-message`),
  workspacePr: (ws: string) => request<{ pullRequest: PullRequest | null }>("GET", `/workspaces/${ws}/git/pr`),
  openPr: (ws: string, input: { title: string; body: string; draft?: boolean }) => request<PullRequest>("POST", `/workspaces/${ws}/git/pr`, input),
  refreshPr: (id: string) => request<PullRequest>("POST", `/prs/${q(id)}/refresh`),
  trackPr: (url: string, issueId: string | null) => request<PullRequest>("POST", "/prs", { url, issueId }),
  github: () => request<Snapshot["github"]>("GET", "/github"),
  saveGithubToken: (token: string | null) => request<Snapshot["github"]>("PUT", "/github/token", { token }),
  prInsights: (repo: string, days: number) => request<PrInsights>("GET", `/github/insights?repo=${q(repo)}&days=${days}`),

  cliStatus: (chatId: string) => request<{ active: boolean; terminalId: string | null; available: boolean }>("GET", `/chats/${chatId}/cli`),
  enterCli: (chatId: string) => request<{ active: boolean; terminalId: string | null; available: boolean }>("POST", `/chats/${chatId}/cli`, {}),
  exitCli: (chatId: string) => request<{ imported: number }>("DELETE", `/chats/${chatId}/cli`),
  integrations: () => request<Integrations>("GET", "/integrations"),
  slackManifest: () => request<Record<string, unknown>>("GET", "/integrations/slack/manifest"),
  connectSlack: (botToken: string, appToken: string) => request<SlackStatus>("POST", "/integrations/slack", { botToken, appToken }),
  disconnectSlack: () => request<SlackStatus>("DELETE", "/integrations/slack"),
  slackChannels: () => request<{ id: string; name: string; is_member: boolean; is_private: boolean }[]>("GET", "/integrations/slack/channels"),
  connectLinear: (apiKey: string) => request<LinearStatus>("POST", "/integrations/linear", { apiKey }),
  configureLinear: (patch: { teamIds?: string[]; writeBack?: boolean }) => request<LinearStatus>("PATCH", "/integrations/linear", patch),
  disconnectLinear: () => request<LinearStatus>("DELETE", "/integrations/linear"),
  linearTeams: () => request<{ id: string; key: string; name: string }[]>("GET", "/integrations/linear/teams"),
  syncLinear: () => request<{ changed: number; status: LinearStatus }>("POST", "/integrations/linear/sync"),
  saveFigmaToken: (token: string | null) => request<{ connected: boolean; handle: string | null }>("PUT", "/integrations/figma", { token }),
  importFigma: (ws: string, path: string, url: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/figma`, { path, url }),
  setSlackIdentity: (identity: { name: string | null; iconUrl: string | null }) => request<SlackStatus>("PUT", "/integrations/slack/identity", identity),
  mcpServers: () => request<McpServerView[]>("GET", "/integrations/mcp-servers"),
  saveMcpServer: (name: string, server: Record<string, unknown>) => request<McpServerView[]>("PUT", `/integrations/mcp-servers/${encodeURIComponent(name)}`, server),
  removeMcpServer: (name: string) => request<McpServerView[]>("DELETE", `/integrations/mcp-servers/${encodeURIComponent(name)}`),
  mcpTokens: () => request<McpToken[]>("GET", "/integrations/mcp-tokens"),
  createMcpToken: (name: string) => request<{ token: string; info: McpToken }>("POST", "/integrations/mcp-tokens", { name }),
  revokeMcpToken: (id: string) => request("DELETE", `/integrations/mcp-tokens/${id}`),
  canvases: () => request<CanvasEntry[]>("GET", "/canvases"),
  setHomeCanvas: (ws: string, path: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/home`, { path }),
  workspaceCanvases: (ws: string) => request<{ canvases: CanvasInfo[]; dev: DevServer | null }>("GET", `/workspaces/${ws}/canvas`),
  createCanvas: (ws: string, name: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas`, { name }),
  canvasDev: (ws: string) => request<DevServer>("POST", `/workspaces/${ws}/canvas/dev`),
  canvasFile: (ws: string, path: string) => request<CanvasInfo & { source: string }>("GET", `/workspaces/${ws}/canvas/file?path=${q(path)}`),
  snapshotStory: (ws: string, path: string, storyId: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/snapshot`, { path, storyId }),
  storyProps: (ws: string, path: string, story: string) => request<{ name: string; value: string | number | boolean }[]>("GET", `/workspaces/${ws}/canvas/props?path=${q(path)}&story=${q(story)}`),
  setStoryProp: (ws: string, path: string, storyId: string, name: string, value: string | number | boolean) => request<CanvasInfo>("PUT", `/workspaces/${ws}/canvas/props`, { path, storyId, name, value }),
  arrangeStories: (ws: string, path: string, storyIds: string[], op: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/arrange`, { path, storyIds, op }),
  setFrame: (ws: string, path: string, storyId: string, frame: CanvasFrame) => request<CanvasInfo>("PUT", `/workspaces/${ws}/canvas/frame`, { path, storyId, frame }),
  duplicateStory: (ws: string, path: string, storyId: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/duplicate`, { path, storyId }),
  removeStory: (ws: string, path: string, storyId: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/remove-story`, { path, storyId }),
  editElement: (ws: string, loc: string, change: { styles?: Record<string, string>; text?: string; variant?: string }, context?: EditContext) =>
    request<{ applied: boolean; via: string; file: string; ledgerId?: string }>("POST", `/workspaces/${ws}/canvas/element`, { loc, change, context }),
  requirements: () => request<Requirement[]>("GET", "/start/requirements"),
  installNode: () => request<{ version: string; requirements: Requirement[] }>("POST", "/start/requirements/node"),
  setOnboarding: (input: { jobRole?: string; done?: boolean }) => request<Member>("PUT", "/members/me/onboarding", input),
  starterTasks: () => request<StarterTaskInfo[]>("GET", "/start/tasks"),
  startWelcome: (projectId: string | null) => request<{ workspaceId: string; chatId: string; canvasPath: string }>("POST", "/start/welcome", { projectId }),
  startTask: (input: { task: string; projectId: string; note: string; prompt?: string; model?: string; effort?: Effort }) => request<{ workspaceId: string; chatId: string }>("POST", "/start/tasks", input),
  starterPrompt: (task: string, note: string) => request<{ prompt: string }>("GET", `/start/tasks/${task}/prompt?note=${encodeURIComponent(note)}`),
  generateProject: (input: { kind: "mockup" | "prototype" | "blank"; idea: string; provider?: string; model?: string; effort?: Effort }) => request<{ projectId: string; workspaceId: string; chatId: string }>("POST", "/start/generate", input),
  openFolder: (path: string, initialize = false) => request<Project>("POST", "/start/open", { path, initialize }),
  importProject: (url: string, parent?: string) => request<Project>("POST", "/start/import", { url, ...(parent ? { parent } : {}) }),
  usage: (month: string) => request<UsageReport>("GET", `/usage?month=${month}`),
  orgs: () => request<OrgInfo[]>("GET", "/orgs"),
  createOrg: (input: { name: string; slug?: string }) => request<OrgInfo>("POST", "/orgs", input),
  updateOrg: (id: string, patch: { name?: string; slug?: string; logo?: string | null }) => request<{ id: string; name: string; slug: string; logo?: string | null }>("PATCH", `/orgs/${id}`, patch),
  deleteOrg: (id: string) => request("DELETE", `/orgs/${id}`),
  emailSettings: () => request<{ configured: boolean; host: string | null; from: string | null }>("GET", "/members/email"),
  saveEmailSettings: (input: { host: string; port: number; secure: boolean; user: string; pass: string; from: string } | null) => request<{ configured: boolean; host: string | null; from: string | null }>("PUT", "/members/email", input),
  generateCanvases: (docId: string, input: { workspaceId?: string; projectId?: string; note: string }) => request<{ chatId: string; workspaceId: string }>("POST", `/docs/${docId}/generate-canvases`, input),
  canvasApp: (ws: string, path: string) => request<AppFrame | null>("POST", `/workspaces/${ws}/canvas/app`, { path }),
  canvasBuild: (ws: string) => request<BuildStatus>("GET", `/workspaces/${ws}/canvas/build`),
  setupCanvasBuild: (ws: string, path: string) => request<{ status: BuildStatus; changed: string[] }>("POST", `/workspaces/${ws}/canvas/build`, { path }),
  storyComponents: (ws: string, path: string, storyId: string) => request<{ name: string; source: string; imported: string }[]>("GET", `/workspaces/${ws}/canvas/components?path=${q(path)}&story=${q(storyId)}`),
  detachComponent: (ws: string, path: string, storyId: string, component: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/detach`, { path, storyId, component }),
  runDesignTool: (ws: string, tool: "generate" | "audit" | "review" | "harden", note = "") => request<{ chatId: string }>("POST", `/workspaces/${ws}/canvas/design-tool`, { tool, note }),
  searchFiles: (ws: string, o: { q: string; regex: boolean; word: boolean; matchCase: boolean }) =>
    request<{ hits: SearchHit[]; truncated: boolean }>("GET", `/workspaces/${ws}/files/search?q=${encodeURIComponent(o.q)}&regex=${o.regex ? 1 : 0}&word=${o.word ? 1 : 0}&case=${o.matchCase ? 1 : 0}`),
  repoImages: (ws: string) => request<{ url: string; path: string }[]>("GET", `/workspaces/${ws}/files/images`),
  fileTree: (ws: string) => request<string[]>("GET", `/workspaces/${ws}/files/tree`),
  readWorkspaceFile: (ws: string, path: string) => request<WorkspaceFile>("GET", `/workspaces/${ws}/files/content?path=${encodeURIComponent(path)}`),
  saveWorkspaceFile: (ws: string, path: string, text: string, create = false) => request<WorkspaceFile>("PUT", `/workspaces/${ws}/files/content`, { path, text, create }),
  renameWorkspaceFile: (ws: string, from: string, to: string) => request<{ path: string }>("POST", `/workspaces/${ws}/files/rename`, { from, to }),
  deleteWorkspaceFile: (ws: string, path: string) => request<{ ok: true }>("DELETE", `/workspaces/${ws}/files/content?path=${encodeURIComponent(path)}`),
  openBranchCanvas: (projectId: string, branch: string) => request<{ workspaceId: string }>("POST", "/canvases/open", { projectId, branch }),
  pinCanvas: (key: string, on: boolean) => request<{ pinnedCanvases: string[] }>("PUT", "/canvases/pins", { key, on }),
  setCanvasCover: (ws: string, path: string, storyId: string) => request<CanvasInfo>("PUT", `/workspaces/${ws}/canvas/cover`, { path, storyId }),
  canvasActivity: (ws: string, path: string) => request<CanvasActivity[]>("GET", `/workspaces/${ws}/canvas/activity?path=${encodeURIComponent(path)}`),
  addPageToCanvas: (ws: string, url: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/add-page`, { url }),
  trackVisual: (ws: string, path: string, storyId: string, enabled: boolean) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/vrt/track`, { path, storyId, enabled }),
  acceptAllVisuals: (ws: string, path: string) => request<{ baselines: string[] }>("POST", `/workspaces/${ws}/canvas/vrt/accept-all`, { path }),
  tidyCanvas: (ws: string, path: string) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/tidy`, { path }),
  componentLibrary: (ws: string) => request<LibraryComponent[]>("GET", `/workspaces/${ws}/canvas/library`),
  insertComponent: (ws: string, loc: string, component: LibraryComponent, variant?: { props: Record<string, unknown>; children: string | null } | null) => request<{ file: string }>("POST", `/workspaces/${ws}/canvas/insert`, { loc, component, variant: variant ?? null }),
  elementOp: (ws: string, loc: string, op: "forward" | "backward" | "front" | "back" | "duplicate" | "delete") => request<{ file: string }>("POST", `/workspaces/${ws}/canvas/element`, { loc, op }),
  insertElement: (ws: string, loc: string, kind: NewElement) => request<{ file: string }>("POST", `/workspaces/${ws}/canvas/insert-element`, { loc, kind }),
  canvasAssets: (ws: string) => request<AssetLibraries>("GET", `/workspaces/${ws}/canvas/assets`),
  boardActivity: () => request<BoardEvent[]>("GET", "/issues/activity"),
  saveIssueView: (view: Pick<IssueView, "name" | "shared" | "filters" | "display">) => request<IssueView>("POST", "/board/views", view),
  updateIssueView: (id: string, view: Pick<IssueView, "name" | "shared" | "filters" | "display">) => request<IssueView>("PUT", `/board/views/${id}`, view),
  deleteIssueView: (id: string) => request<{ ok: true }>("DELETE", `/board/views/${id}`),
  boardAssistant: () => request<Chat>("POST", "/board/assistant"),
  machines: () => request<MachineView[]>("GET", "/machines"),
  addMachine: (name: string) => request<{ machine: MachineView; token: string }>("POST", "/machines", { name }),
  createMachineWorkspace: (id: string, input: { projectId: string | null; name: string }) => request<{ workspace: { id: string }; chatId: string }>("POST", `/machines/${id}/workspaces`, input),
  renameMachine: (id: string, name: string) => request<MachineView>("PATCH", `/machines/${id}`, { name }),
  removeMachine: (id: string) => request<void>("DELETE", `/machines/${id}`),
  openMachine: (id: string) => request<{ url: string }>("POST", `/machines/${id}/open`),
  machineSummary: (id: string) => request<MachineSummary>("GET", `/machines/${id}/summary`),
  answerOnMachine: (id: string, interactionId: string, answer: Record<string, unknown>) => request<unknown>("POST", `/machines/${id}/interactions/${interactionId}`, answer),
  machineLink: () => request<MachineLinkStatus>("GET", "/machine-link"),
  connectMachineLink: (input: { hubUrl: string; token: string }) => request<MachineLinkStatus>("PUT", "/machine-link", input),
  disconnectMachineLink: () => request<MachineLinkStatus>("DELETE", "/machine-link"),
  postVisualsToPr: (ws: string) => request<{ url: string; updated: boolean; changed: number }>("POST", `/workspaces/${ws}/canvas/vrt/pr`),
  designTokens: (ws: string) => request<DesignToken[]>("GET", `/workspaces/${ws}/canvas/tokens`),
  saveDesignToken: (ws: string, change: { file: string; name: string; scope?: string; value: string; add?: boolean }) => request<DesignToken[]>("PUT", `/workspaces/${ws}/canvas/tokens`, change),
  lockElement: (ws: string, loc: string, locked: boolean) => request<{ file: string }>("POST", `/workspaces/${ws}/canvas/lock`, { loc, locked }),
  lockStory: (ws: string, path: string, storyId: string, locked: boolean) => request<CanvasInfo>("POST", `/workspaces/${ws}/canvas/lock`, { path, storyId, locked }),
  saveCanvasImage: (ws: string, input: { name: string; mediaType: string; data: string }) => request<{ url: string; path: string }>("POST", `/workspaces/${ws}/canvas/image`, input),
  canvasLedger: (ws: string) => request<CanvasEdit[]>("GET", `/workspaces/${ws}/canvas/ledger`),
  stageEdit: (ws: string, loc: string, description: string, context?: EditContext) => request<{ id: string }>("POST", `/workspaces/${ws}/canvas/ledger`, { loc, description, context }),
  unstageEdit: (ws: string, id: string) => request("DELETE", `/workspaces/${ws}/canvas/ledger/${id}`),
  applyLedger: (ws: string) => request<{ chatId: string }>("POST", `/workspaces/${ws}/canvas/ledger/apply`),
  canvasComments: (ws: string) => request<CanvasComment[]>("GET", `/workspaces/${ws}/canvas/comments`),
  editCanvasComment: (ws: string, id: string, body: string) => request<CanvasComment>("PUT", `/workspaces/${ws}/canvas/comments/${id}/body`, { body }),
  moveCanvasComment: (ws: string, id: string, to: { x?: number; y?: number; workspaceId?: string }) => request<CanvasComment>("PUT", `/workspaces/${ws}/canvas/comments/${id}/position`, to),
  unreadCanvasThread: (ws: string, id: string) => request<{ ok: true }>("POST", `/workspaces/${ws}/canvas/comments/${id}/unread`),
  readCanvasThread: (ws: string, id: string) => request<{ ok: true }>("POST", `/workspaces/${ws}/canvas/comments/${id}/read`),
  reactToCanvasComment: (ws: string, id: string, reaction: string, on: boolean) => request<CanvasComment>("PUT", `/workspaces/${ws}/canvas/comments/${id}/reactions/${reaction}`, { on }),
  addCanvasComment: (ws: string, input: { canvasPath: string; storyId: string | null; x: number; y: number; parentId: string | null; body: string; attachments?: { url: string; name: string }[] }) =>
    request<CanvasComment>("POST", `/workspaces/${ws}/canvas/comments`, input),
  resolveCanvasComment: (ws: string, id: string, resolved: boolean) => request("PATCH", `/workspaces/${ws}/canvas/comments/${id}`, { resolved }),
  deleteCanvasComment: (ws: string, id: string) => request("DELETE", `/workspaces/${ws}/canvas/comments/${id}`),
  checkVisuals: (ws: string, path: string, storyId?: string) => request<VrtResult[]>("POST", `/workspaces/${ws}/canvas/vrt`, { path, storyId }),
  acceptBaseline: (ws: string, path: string, storyId: string) => request<{ baseline: string }>("POST", `/workspaces/${ws}/canvas/vrt/accept`, { path, storyId }),
  editComment: (issueId: string, seq: number, body: string) => request("PATCH", `/issues/${issueId}/comments/${seq}`, { body }),
  deleteComment: (issueId: string, seq: number) => request("DELETE", `/issues/${issueId}/comments/${seq}`),
  reactToComment: (issueId: string, seq: number, reaction: string, on: boolean) => request("PUT", `/issues/${issueId}/comments/${seq}/reactions/${q(reaction)}`, { on }),
  shareFor: (kind: ShareLink["kind"], ref: string) => request<ShareLink | null>("GET", `/shares?kind=${kind}&ref=${q(ref)}`),
  createShare: (kind: ShareLink["kind"], ref: string) => request<ShareLink>("POST", "/shares", { kind, ref }),
  revokeShare: (id: string) => request("DELETE", `/shares/${q(id)}`),
  me: () => request<{ signedIn: boolean; member: Member | null; role: string | null; team: boolean }>("GET", "/auth/me"),
  login: (email: string, password: string) => request<{ member: Member }>("POST", "/auth/login", { email, password }),
  logout: () => request("POST", "/auth/logout"),
  peekInvite: (token: string) => request<{ valid: boolean; role?: string }>("GET", `/auth/invite/${q(token)}`),
  acceptInvite: (token: string, input: { name: string; email: string; password: string }) => request<{ member: Member }>("POST", `/auth/invite/${q(token)}`, input),
  requestAccess: (input: { name: string; email: string; message: string }) => request("POST", "/auth/request-access", input),
  setPreferences: (systemPrompt: string) => request<Member>("PUT", "/members/me/preferences", { systemPrompt }),
  skills: () => request<Skill[]>("GET", "/members/me/skills"),
  builtinSkills: () => request<{ name: string; title: string; description: string; argumentHint: string }[]>("GET", "/members/me/skills/builtin"),
  saveSkill: (input: { name: string; description: string; body: string }) => request<Skill>("PUT", "/members/me/skills", input),
  duplicateSkill: (id: string) => request<Skill>("POST", `/members/me/skills/${id}/duplicate`),
  deleteSkill: (id: string) => request("DELETE", `/members/me/skills/${id}`),
  members: () => request<Member[]>("GET", "/members"),
  updateMember: (id: string, patch: { name?: string; email?: string; role?: "admin" | "member" }) => request<Member>("PATCH", `/members/${id}`, patch),
  removeMember: (id: string) => request("DELETE", `/members/${id}`),
  setPassword: (password: string) => request("PUT", "/members/me/password", { password }),
  invites: () => request<{ id: string; role: string; createdBy: string; createdAt: string; expiresAt: string; email?: string }[]>("GET", "/members/invites"),
  createInvite: (role: "admin" | "member", email?: string) => request<{ token: string; emailed: boolean }>("POST", "/members/invites", { role, ...(email ? { email } : {}) }),
  revokeInvite: (id: string) => request("DELETE", `/members/invites/${id}`),
  accessRequests: () => request<{ id: string; name: string; email: string; message: string; createdAt: string }[]>("GET", "/members/requests"),
  approveRequest: (id: string, role: "admin" | "member") => request<{ token: string; emailed: boolean }>("POST", `/members/requests/${id}/approve`, { role }),
  denyRequest: (id: string) => request("DELETE", `/members/requests/${id}`),
  terminals: (workspaceId: string) => request<TerminalInfo[]>("GET", `/terminals?workspaceId=${q(workspaceId)}`),
  openTerminal: (input: { workspaceId: string; cols?: number; rows?: number; command?: string | null; title?: string }) => request<TerminalInfo>("POST", "/terminals", input),
  renameTerminal: (id: string, title: string) => request<TerminalInfo>("PATCH", `/terminals/${id}`, { title }),
  closeTerminal: (id: string) => request("DELETE", `/terminals/${id}`),
};

export * from "./api-types";
import type { IssueView } from "../../core/issue-views";
import type { McpServerView } from "../../integrations/mcp-servers";
import type { LibraryComponent } from "../../canvas/compose";
import type { ScheduleStatus, TriggerEstimate } from "../../runner/estimates";
export type TriggerStatus = { schedules: ScheduleStatus[]; estimates: TriggerEstimate[] };
import type { AppFrame, BuildStatus, CanvasEntry, CanvasFrame, CanvasInfo, DesignToken, DevServer, EditContext, GitFile, GitOverview, Integrations, LinearStatus, MachineLinkStatus, MachineSummary, MachineView, McpToken, OrgInfo, PrInsights, RepoState, SlackStatus, StarterTaskInfo, StoryboardInfo, TerminalInfo, UsageReport, UsageRow, VrtResult, WorkspaceFile, CanvasActivity, BoardEvent, SearchHit } from "./api-types";
export interface ProjectScripts {
  sharedPrep: string | null;
  sharedCommands: { name: string; command: string }[];
  myPrep: string | null;
  myCommands: { name: string; command: string }[];
}
export type { InboxItem } from "../../canvas/inbox";
import type { InboxItem } from "../../canvas/inbox";
export type { AssetLibraries, Asset as CanvasAsset } from "../../canvas/assets";
import type { AssetLibraries } from "../../canvas/assets";
import type { NewElement } from "../../canvas/new-elements";
export type { ClaudeAccount } from "../../agents/claude-binary";
import type { ClaudeAccount } from "../../agents/claude-binary";
export type { SharingStatus } from "../../sharing/service";
import type { SharingStatus } from "../../sharing/service";
