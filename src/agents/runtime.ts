import type { McpServerConfig } from "../integrations/mcp-servers";
import type { Attachment, ChatMode, Effort, ChatItemData } from "../core/types";
import type { BoardTool, ToolContext } from "./board-tools";

/** What the harness reports while a session runs. */
export type RuntimeEvent =
  /** `commandHints`: what each command does (and its arguments), when the harness says. */
  | { type: "session"; sessionId: string; slashCommands: string[]; commandHints?: Record<string, string> }
  | { type: "text_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | { type: "compacted"; preTokens: number }
  /**
   * A result. `sessionCostUsd` is the running total for this process, not this
   * turn's cost. `answered` lists the ids of the sent messages this result
   * consumed (several when a steer folds in), or null when the harness does
   * not say.
   */
  | { type: "turn_end"; result: string; sessionCostUsd: number; numTurns: number; durationMs: number; inputTokens: number; outputTokens: number; isError: boolean; error: string | null; answered: string[] | null; contextTokens?: number; contextWindow?: number }
  /** The harness's authoritative busy/idle signal, when it sends one. */
  | { type: "state"; state: "idle" | "running" | "requires_action" }
  | { type: "closed"; error: string | null };

/** A tool call the harness wants approved; questions and plan approvals arrive the same way. */
export interface ApprovalRequest {
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
}

export type ApprovalAnswer =
  | { allow: true; always?: boolean; updatedInput?: Record<string, unknown> }
  | { allow: false; message: string; interrupt?: boolean };

export interface OutgoingMessage {
  /** Echoed back in `turn_end.answered` so turns can be matched to the messages they answer. */
  id: string;
  text: string;
  attachments: Attachment[];
  /** "now" folds into the turn in progress (steering); "next" waits for it. */
  priority: "now" | "next";
}

export interface SessionOptions {
  cwd: string;
  model: string;
  effort: Effort;
  /** Faster output where the harness offers it (Claude Code); others ignore it. */
  fast?: boolean;
  /** Claude Code's Remote Control bridge, so claude.ai/code can drive the session too. */
  remoteControl?: boolean;
  /** The team's MCP servers this chat uses, besides Cadence's own tools. */
  mcpServers?: McpServerConfig[];
  mode: ChatMode;
  instructions: string;
  maxTurns: number;
  tools: BoardTool[];
  toolContext: ToolContext;
  resumeSessionId: string | null;
  onEvent(event: RuntimeEvent): void;
  onApproval(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

/** A long-lived harness process for one chat. Messages stream in; events stream out. */
export interface LiveSession {
  send(message: OutgoingMessage): void;
  interrupt(): Promise<void>;
  setMode(mode: ChatMode): Promise<void>;
  setModel(model: string): Promise<void>;
  close(): void;
  readonly closed: Promise<void>;
}

export interface ChatRuntime {
  readonly name: string;
  start(options: SessionOptions): LiveSession;
  /** A single tool-free answer, for small jobs like writing a commit message. */
  complete(prompt: string, options: { cwd: string; model: string; system: string }): Promise<string>;
  /** CLI mode: the harness's own terminal UI on the same session, when the harness has one. */
  readonly cli?: CliSupport;
}

export interface CliSupport {
  /** The shell command that opens (resume) or starts (new id) the session in the harness CLI. */
  command(options: { sessionId: string; resume: boolean; model: string; mode: ChatMode }): string;
  /** The session's transcript, oldest first: each message's id and the chat items it becomes. */
  transcript(sessionId: string, cwd: string): Promise<{ id: string; items: ChatItemData[] }[]>;
  /**
   * For harnesses whose CLI cannot start a session under an id Cadence picks:
   * creates one first, so the CLI can resume it.
   */
  ensureSession?(cwd: string): Promise<string>;
}
