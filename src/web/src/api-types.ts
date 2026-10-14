// Response shapes of the Cadence API, shared by api.ts and the components.
import type { Snapshot } from "../../core/types";

export interface GitFile {
  path: string;
  status: string;
  oldPath?: string;
}

export interface RepoState {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  conflicted: GitFile[];
  operation: "rebase" | "merge" | "cherry-pick" | null;
  headSha: string | null;
}

export interface GitOverview {
  state: RepoState;
  branches: { name: string; current: boolean; upstream: string | null; remote: boolean }[];
  remotes: { name: string; url: string }[];
  stashes: { index: number; message: string }[];
  tags: string[];
  log: { sha: string; shortSha: string; author: string; date: string; subject: string }[];
}

export interface PrInsights {
  days: number;
  opened: number;
  merged: number;
  closedUnmerged: number;
  open: number;
  medianHoursToMerge: number | null;
  byAuthor: { author: string; opened: number; merged: number }[];
  mergedPerDay: { date: string; count: number }[];
}

export interface TerminalInfo {
  id: string;
  workspaceId: string;
  title: string;
  command: string | null;
  alive: boolean;
  exitCode: number | null;
  createdAt: string;
}

export interface SlackStatus {
  configured: boolean;
  connection: "connecting" | "connected" | "disconnected";
  team: string | null;
  teamUrl: string | null;
  botUserId: string | null;
  error: string | null;
  identity?: { name: string | null; iconUrl: string | null };
}

export interface LinearStatus {
  connected: boolean;
  organization: string | null;
  teamIds: string[];
  writeBack: boolean;
  cursor: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface McpToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Integrations {
  slack: SlackStatus;
  linear: LinearStatus;
  figma: { connected: boolean };
  github: Snapshot["github"];
}

export interface EditContext {
  canvasPath: string;
  storyId: string;
  storyName: string;
  copies?: number;
}

export interface CanvasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StarterTaskInfo {
  id: string;
  title: string;
  description: string;
  minutes: number;
  tokens: string;
  needsNote: boolean;
}

export interface UsageRow {
  key: string;
  label: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageReport {
  month: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  byProvider: UsageRow[];
  byModel: UsageRow[];
  byAgent: UsageRow[];
  byPerson: UsageRow[];
  byDay: { day: string; usd: number }[];
  budgetUsd: number | null;
  agentBudgets: { agentId: string; name: string; budgetUsd: number; usd: number }[];
}

export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  /** Image URL, or null for initials. */
  logo?: string | null;
  role: string;
  current: boolean;
  members: number;
  running?: number;
  unread?: number;
}

export type { MachineView, MachineSummary } from "../../machines/hub";
export type { LinkStatus as MachineLinkStatus } from "../../machines/link";

export type { FileContent as WorkspaceFile, SearchHit } from "../../workspaces/files";
export type { McpServerView } from "../../integrations/mcp-servers";
export type { LibraryComponent } from "../../canvas/compose";

export interface DesignToken {
  name: string;
  value: string;
  kind: "color" | "length" | "font" | "shadow" | "other";
  scope: string;
  file: string;
  aliasOf: string | null;
}

export interface AppFrame {
  appUrl: string;
  proxyUrl: string;
}

export interface BuildStatus {
  framework: "next" | "expo" | "vite" | "other";
  configFile: string | null;
  configured: boolean;
  installed: boolean;
  appCommand: string | null;
}

export interface StoryboardInfo {
  id: string;
  name: string;
  kind: "component" | "route" | "html" | "svelte";
  route: string | null;
  html: string | null;
  svelte: string | null;
  frame: CanvasFrame;
  vrt: { enabled: boolean; threshold: number; ignore: CanvasFrame[] };
  locked: boolean;
}

export interface CanvasInfo {
  cover?: string | null;
  /** The main canvas Run opens beside the app. */
  home?: boolean;
  path: string;
  name: string;
  background: string;
  appUrl: string | null;
  appCommand: string | null;
  storyboards: StoryboardInfo[];
  errors: string[];
}

export interface CanvasEntry extends CanvasInfo {
  /** Null for a canvas on a branch nobody has open; opening it makes a workspace. */
  workspaceId: string | null;
  workspaceName: string;
  branch: string | null;
  projectId: string | null;
  updatedAt: string | null;
}

export interface DevServer {
  workspaceId: string;
  url: string;
  port: number;
  usesProjectConfig: boolean;
  /** Whether the project serves a page at its root (route frames without an app load it). */
  hasPage?: boolean;
}

export interface VrtResult {
  storyId: string;
  status: "pass" | "fail" | "new" | "size_changed" | "disabled";
  diffPixels: number;
  diffRatio: number;
  baseline: string;
}

export interface CanvasActivity {
  kind: "commit" | "comment" | "edit";
  at: string;
  who: string;
  text: string;
  ref: string;
  resolved?: boolean;
}

export interface BoardEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  actor: string;
  ts: string;
  issue: { id: string; key: string; title: string };
}
