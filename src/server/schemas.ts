import { z } from "zod";
import { AGENT_ICON_NAMES } from "../core/agent-icons";
import { isTimeZone } from "../runner/scheduler";
import { PROVIDER_IDS } from "../core/providers";
import { AGENT_VISIBILITIES, AGENT_PUBLIC_ACCESS, CHAT_MODES, EFFORTS, GITHUB_EVENTS, SLACK_EVENTS, ISSUE_TYPES, PERMISSION_MODES, PRIORITIES, STAGE_CATEGORIES } from "../core/types";

// Input validation for everything that enters over HTTP.

const text = (max: number) => z.string().trim().min(1).max(max);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb color");
const id = z.string().min(1).max(100);
const nullableId = z.string().max(100).nullish().transform((v) => v || null);
/** Any harness's model id; which ids a harness takes is checked against it later. */
const modelId = z.string().regex(/^[A-Za-z0-9._:/@[\]-]{1,120}$/, "Use a model id");

export const StageInput = z.object({ name: text(60), category: z.enum(STAGE_CATEGORIES), color, humanGate: z.boolean().optional() });
export const StagePatch = z.object({ name: text(60), color, humanGate: z.boolean(), hidden: z.boolean() }).partial();
export const StageOrder = z.object({ order: z.array(id).min(1) });
export const StageDelete = z.object({ moveIssuesTo: id });

export const LabelInput = z.object({ name: text(40), color });

const AssigneeInput = z.object({ kind: z.enum(["user", "agent"]), id });

export const IssueInput = z.object({
  title: text(200),
  body: z.string().max(100_000).default(""),
  type: z.enum(ISSUE_TYPES).default("feature"),
  priority: z.enum(PRIORITIES).default("none"),
  stageId: id.optional(),
  projectId: nullableId,
  labelIds: z.array(id).max(20).default([]),
  assignees: z.array(AssigneeInput).max(10).default([]),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates look like 2026-10-31").refine((d) => !Number.isNaN(Date.parse(d)), "Not a real date");

export const IssuePatch = z
  .object({
    title: text(200),
    body: z.string().max(100_000),
    type: z.enum(ISSUE_TYPES),
    priority: z.enum(PRIORITIES),
    estimate: z.number().min(0).max(100).nullable(),
    projectId: z.string().max(100).nullable(),
    startDate: isoDate.nullable(),
    dueDate: isoDate.nullable(),
  })
  .partial()
  .refine((p) => !p.startDate || !p.dueDate || p.startDate <= p.dueDate, "The start date must not be after the due date");

export const MoveInput = z.object({ stageId: id });
export const ToggleLabel = z.object({ labelId: id, on: z.boolean() });
export const ToggleAssignee = z.object({ assignee: AssigneeInput, on: z.boolean() });
export const CommentInput = z.object({ body: text(10_000) });
export const LinkInput = z.object({ kind: z.enum(["doc", "pr", "branch", "url", "linear"]), ref: text(2000), title: z.string().max(200).optional() });

export const DocInput = z.object({ title: text(200), body: z.string().max(500_000).default(""), icon: z.string().max(16).nullish().transform((v) => v || null), parentId: nullableId, issueId: nullableId });
export const DocPatch = z
  .object({ title: text(200), body: z.string().max(500_000), icon: z.string().max(16).nullable(), issueId: z.string().max(100).nullable(), baseVersion: z.number().int().min(1), collab: z.boolean() })
  .partial();

const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().optional(), kind: z.literal("assigned") }),
  z.object({ id: z.string().optional(), kind: z.literal("issue_created"), stageIds: z.array(id).default([]), types: z.array(z.enum(ISSUE_TYPES)).default([]) }),
  z.object({ id: z.string().optional(), kind: z.literal("issue_moved"), toStageIds: z.array(id).min(1) }),
  z.object({ id: z.string().optional(), kind: z.literal("label_added"), labelIds: z.array(id).min(1) }),
  z.object({ id: z.string().optional(), kind: z.literal("issue_commented") }),
  z.object({ id: z.string().optional(), kind: z.literal("schedule"), cron: text(100), description: z.string().max(200).default(""), timezone: z.string().max(100).refine(isTimeZone, "Unknown time zone").optional() }),
  z.object({ id: z.string().optional(), kind: z.literal("webhook"), secret: z.string().max(200).default("") }),
  z.object({ id: z.string().optional(), kind: z.literal("github"), events: z.array(z.enum(GITHUB_EVENTS)).min(1), secret: z.string().max(200).default(""), authors: z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/, "Use GitHub logins")).max(50).optional() }),
  z.object({
    id: z.string().optional(),
    kind: z.literal("slack"),
    events: z.array(z.enum(SLACK_EVENTS)).min(1),
    channelIds: z.array(z.string().regex(/^[CGD][A-Z0-9]+$/, "Use Slack channel ids like C0123ABCD")).max(50).default([]),
    emoji: z.array(z.string().regex(/^[a-z0-9_+-]+$/)).max(20).default([]),
    includeBots: z.boolean().optional(),
  }),
]);

const agentFields = {
  name: text(60),
  description: z.string().max(500),
  color,
  icon: z.enum(AGENT_ICON_NAMES as [string, ...string[]]).nullable(),
  prompt: text(50_000),
  provider: z.enum(PROVIDER_IDS),
  // Checked against the provider by the commands.
  model: modelId,
  effort: z.enum(EFFORTS),
  permissionMode: z.enum(PERMISSION_MODES),
  projectId: z.string().max(100).nullable(),
  triggers: z.array(TriggerSchema).max(20),
  visibility: z.enum(AGENT_VISIBILITIES),
  publicAccess: z.enum(AGENT_PUBLIC_ACCESS),
  monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable(),
};

export const AgentInput = z.object(agentFields).partial().required({ name: true, prompt: true }).extend({ templateId: z.string().max(100).nullish(), enabled: z.boolean().optional() });
export const AgentPatchInput = z.object(agentFields).partial();
export const CronFromText = z.object({ text: text(200) });


const CommandInput = z.object({ name: z.string().regex(/^[a-z0-9_-]{1,32}$/), command: text(500) });
const GithubRepo = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/name").nullish().transform((v) => v || null);

export const ProjectInput = z.object({
  name: text(100),
  path: text(1000),
  baseBranch: z.string().trim().max(200).optional(),
  githubRepo: GithubRepo,
  setupScript: z.string().max(2000).nullish().transform((v) => v || null),
  commands: z.array(CommandInput).max(20).default([]),
});

export const ProjectPatch = z
  .object({ name: text(100), baseBranch: text(200), githubRepo: GithubRepo, setupScript: z.string().max(2000).nullable(), commands: z.array(CommandInput).max(20) })
  .partial();

export const ScriptsInput = z.object({
  scope: z.enum(["org", "user"]),
  setupScript: z.string().max(2000).nullish().transform((v) => (v === undefined ? undefined : v?.trim() || null)),
  commands: z.array(CommandInput).max(20).optional(),
});

export const SettingsPatch = z
  .object({
    concurrency: z.number().int().min(1).max(16),
    defaultProvider: z.enum(PROVIDER_IDS),
    defaultModel: modelId,
    defaultEffort: z.enum(EFFORTS),
    maxTurns: z.number().int().min(5).max(1000),
    systemPrompt: z.string().max(20_000),
    monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable(),
    autoMoveIssues: z.boolean(),
  })
  .partial();

export const WorkspaceInput = z.object({ projectId: nullableId, name: text(120) });
export const WorkspaceFromIssues = z.object({ issueIds: z.array(id).min(1).max(50), prompt: z.string().max(20_000).default(""), model: z.string().max(100).optional(), effort: z.enum(EFFORTS).optional() });
export const WorkspacePatch = z.object({ name: text(120), pinned: z.boolean() }).partial();
export const WorkspaceDelete = z.object({ deleteBranch: z.boolean().default(false) });

const AttachmentInput = z.object({
  name: text(200),
  mediaType: z.string().max(100),
  data: z.string().max(7_000_000).optional(),
  text: z.string().max(1_000_000).optional(),
});
const MentionInput = z.object({ kind: z.enum(["file", "doc", "issue"]), ref: text(1000) });

export const ChatInput = z.object({
  workspaceId: id,
  title: z.string().max(120).optional(),
  provider: z.enum(PROVIDER_IDS).optional(),
  model: modelId.optional(),
  effort: z.enum(EFFORTS).optional(),
  mode: z.enum(CHAT_MODES).optional(),
});
export const ChatPatch = z
  .object({ title: text(120), provider: z.enum(PROVIDER_IDS), model: modelId, effort: z.enum(EFFORTS), fast: z.boolean(), remoteControl: z.boolean(), mcpServers: z.array(z.string().max(41)).max(50).nullable(), mode: z.enum(CHAT_MODES), archived: z.boolean() })
  .partial();
export const ChatTransferInput = z.object({ workspaceId: id });
export const SendInput = z.object({
  text: z.string().max(200_000).default(""),
  attachments: z.array(AttachmentInput).max(10).default([]),
  mentions: z.array(MentionInput).max(50).default([]),
  steer: z.boolean().default(false),
});
export const QueuedEdit = z.object({ text: text(200_000) });
export const InteractionAnswerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool"), allow: z.boolean(), always: z.boolean().optional(), message: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("question"), answers: z.record(z.string(), z.string().max(5000)) }),
  z.object({ kind: z.literal("plan"), action: z.enum(["approve", "revise", "execute_fresh"]), feedback: z.string().max(10_000).optional() }),
]);

const gitPaths = z.array(z.string().min(1).max(1000)).min(1).max(1000);
const gitRef = z.string().trim().min(1).max(200);

export const GitPaths = z.object({ paths: gitPaths });
export const GitCommit = z.object({ message: z.string().max(20_000).default(""), amend: z.boolean().optional(), signoff: z.boolean().optional(), all: z.boolean().optional(), sync: z.boolean().optional() });
export const GitHunk = z.object({ path: z.string().min(1).max(1000), hunk: z.number().int().min(0).max(10_000), unstage: z.boolean().default(false) });
export const GitBranchInput = z.object({ name: gitRef, from: gitRef.optional(), checkout: z.boolean().default(true) });
export const GitBranchRename = z.object({ from: gitRef, to: gitRef });
export const GitRef = z.object({ name: gitRef, force: z.boolean().optional() });
export const GitRemoteInput = z.object({ name: gitRef, url: z.string().trim().min(1).max(1000) });
export const GitPull = z.object({ rebase: z.boolean().default(false) });
export const GitPush = z.object({ force: z.boolean().default(false) });
export const GitStash = z.object({ message: z.string().max(500).optional(), includeUntracked: z.boolean().default(true) });
export const GitStashIndex = z.object({ index: z.number().int().min(0).max(10_000) });
export const GitTagInput = z.object({ name: gitRef, message: z.string().max(5000).optional() });
export const PrOpen = z.object({ title: text(200), body: z.string().max(60_000).default(""), draft: z.boolean().optional() });
export const PrTrack = z.object({ url: z.string().url().max(500), issueId: nullableId });
export const GithubToken = z.object({ token: z.string().trim().max(500).nullable() });
