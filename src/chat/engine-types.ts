import type { McpServerConfig } from "../integrations/mcp-servers";
import type { EphemeralBus } from "../core/bus";
import type { EventStore } from "../core/event-store";
import type { IssueCommands } from "../core/issue-commands";
import type { Queries } from "../core/queries";
import type { Chat } from "../core/types";
import type { DocCommands } from "../docs/commands";
import type { PullRequestService } from "../git/pull-requests";
import type { BoardTool } from "../agents/board-tools";
import type { ApprovalAnswer, ChatRuntime, LiveSession } from "../agents/runtime";
import type { WorkspaceService } from "../workspaces/service";

// The chat engine's types, kept apart so engine.ts stays about behavior.

export interface TurnOutcome {
  result: string;
  costUsd: number;
  numTurns: number;
  error: string | null;
}

export interface Session {
  live: LiveSession;
  busy: boolean;
  turnWaiters: ((o: TurnOutcome) => void)[];
  approvals: Map<string, (a: ApprovalAnswer) => void>;
  idleTimer: NodeJS.Timeout | null;
  runId: string | null;
  /** Running cost total reported by this process so far, to turn totals into per-turn costs. */
  lastSessionCost: number | null;
  /** Cost already recorded on the chat when this process started (for resumed sessions). */
  costBefore: number;
  /** Ids of sent messages the harness has not answered yet; the chat is busy while any remain. */
  outstanding: Set<string>;
  /** Set when a person stops the turn, so its result reads as stopped rather than failed. */
  stopped: boolean;
  lastOutcome: TurnOutcome | null;
}

export interface ChatEngineDeps {
  store: EventStore;
  q: Queries;
  issues: IssueCommands;
  docs: DocCommands;
  workspaces: WorkspaceService;
  /** The harness for a provider id (Claude Code, Codex, ...). */
  runtimes: (provider: string) => ChatRuntime;
  bus: EphemeralBus;
  idleMs?: number;
  prs?: PullRequestService;
  /** Integration tools, looked up per session so newly connected integrations apply. */
  extraTools?: () => BoardTool[];
  /** Throws when a chat may not take another message now (a spending limit was reached). */
  guard?: (chat: Chat) => void;
  /** The team's own MCP servers that a chat has turned on. */
  mcpServers?: (chosen: string[] | null | undefined) => McpServerConfig[];
}
