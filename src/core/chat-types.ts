// Chats, their transcripts, and what agents ask people mid-turn. Re-exported
// from types.ts; like it, free of runtime Node imports.

import type { Actor, Effort, ProviderId } from "./types";

export const CHAT_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

export const CHAT_STATUSES = ["idle", "running", "waiting", "interrupted", "error"] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

export interface Chat {
  id: string;
  workspaceId: string;
  /** Who started it (agents' chats: the agent). */
  createdBy: Actor;
  /** Set when the chat belongs to an outside conversation, such as a Slack thread. */
  threadKey: string | null;
  /** Slack threads this chat also follows, and threads it stopped listening to (thread keys). */
  slackThreads?: { follow: string[]; muted: string[] };
  title: string;
  provider: string;
  model: string;
  effort: Effort;
  /** Claude Code's fast mode: the same model with faster output, at a higher price. */
  fast?: boolean;
  /** Team MCP servers turned on in this chat; unset means the ones on by default. */
  mcpServers?: string[] | null;
  mode: ChatMode;
  agentId: string | null;
  /** Set for a doc's assistant chat. */
  docId: string | null;
  sessionId: string | null;
  /** Set after a move to another workspace: the next session starts fresh and is handed the conversation so far. */
  carryOver?: boolean;
  /** The chat this one was forked from (its transcript up to a point was copied in). */
  forkedFrom?: string | null;
  /** Claude Code's Remote Control: the session can be driven from claude.ai/code or the Claude app. */
  remoteControl?: boolean;
  status: ChatStatus;
  /** Set when the chat was cut off because Cadence stopped; cleared by its next status change. */
  stoppedByRestart?: boolean;
  unread: boolean;
  archived: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  slashCommands: string[];
  /** Descriptions of the harness's commands, by name, when it gave them. */
  commandHints?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  name: string;
  mediaType: string;
  /** Base64 data for images; text files carry their contents in `text`. */
  data?: string;
  text?: string;
}

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type ChatItemData =
  /** `checkpoint`: the working copy (a git tree) just before this message, to restore files to. */
  | { kind: "user"; text: string; attachments: Attachment[]; author: Actor; steer: boolean; checkpoint?: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_use"; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { kind: "todo"; todos: TodoEntry[] }
  | { kind: "interaction"; interactionId: string }
  | { kind: "notice"; text: string; tone: "info" | "warn" | "error" }
  | { kind: "turn"; costUsd: number; durationMs: number; numTurns: number; inputTokens: number; outputTokens: number; isError: boolean; error: string | null; contextTokens?: number; contextWindow?: number };

export type ChatItem = ChatItemData & { seq: number; chatId: string; ts: string };

export interface QueuedMessage {
  id: string;
  chatId: string;
  text: string;
  attachments: Attachment[];
  createdAt: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export type InteractionKind = "tool" | "question" | "plan";

/** Something a running agent is waiting on a person for. */
export interface Interaction {
  id: string;
  chatId: string;
  runId: string | null;
  kind: InteractionKind;
  toolName: string;
  input: Record<string, unknown>;
  questions: Question[];
  plan: string | null;
  status: "pending" | "resolved" | "cancelled";
  resolution: string | null;
  createdAt: string;
}
