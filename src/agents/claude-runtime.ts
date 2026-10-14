import { forClaude } from "../integrations/mcp-servers";
import { createSdkMcpServer, query, tool, type Options, type PermissionMode, type PermissionResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMode } from "../core/types";
import { claudeCli } from "./claude-cli";
import { callBoardTool, toolContent, type BoardTool, type ToolContext } from "./board-tools";
import type { ChatRuntime, LiveSession, OutgoingMessage, RuntimeEvent, SessionOptions } from "./runtime";
import { hintsOf } from "./command-hints";

export const BOARD_SERVER = "cadence";

const MODE: Record<ChatMode, PermissionMode> = { default: "default", acceptEdits: "acceptEdits", plan: "plan", bypassPermissions: "bypassPermissions" };

/** An async queue the SDK reads user messages from (streaming input mode). */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private ended = false;

  push(m: SDKUserMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: m, done: false });
    else this.items.push(m);
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function toUserMessage(m: OutgoingMessage): SDKUserMessage {
  const content: Exclude<SDKUserMessage["message"]["content"], string> = [];
  for (const a of m.attachments) {
    if (a.data && a.mediaType.startsWith("image/")) {
      content.push({ type: "image", source: { type: "base64", media_type: a.mediaType as "image/png", data: a.data } });
    } else if (a.text !== undefined) {
      content.push({ type: "text", text: `<attached_file name="${a.name}">\n${a.text}\n</attached_file>` });
    }
  }
  content.push({ type: "text", text: m.text });
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, priority: m.priority, uuid: m.id as SDKUserMessage["uuid"] };
}

/** Which of our sent messages a result consumed, if the harness says. */
function answeredIds(m: { user_message_uuid?: string; user_message_uuids?: string[] }): string[] | null {
  if (m.user_message_uuids?.length) return m.user_message_uuids;
  if (m.user_message_uuid) return [m.user_message_uuid];
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "[non-text content]")).join("\n");
  }
  return "";
}

function boardServer(tools: BoardTool[], ctx: ToolContext) {
  return createSdkMcpServer({
    name: BOARD_SERVER,
    version: "1.0.0",
    tools: tools.map((t) =>
      tool(t.name, t.description, t.shape, async (args) => {
        const result = await callBoardTool(tools, t.name, args, ctx);
        return { content: toolContent(result), isError: result.isError };
      }),
    ),
  });
}

/**
 * Runs chats through Claude Code via the Agent SDK. Each chat gets one
 * long-lived process: Claude Code's own tools in the workspace, plus the
 * Cadence board tools over an in-process MCP server.
 */
export class ClaudeCodeRuntime implements ChatRuntime {
  readonly name = "claude-code";
  readonly cli = claudeCli;
  /** Environment for the Claude Code process (bring-your-own keys); defaults to this server's. */
  env: (model?: string) => NodeJS.ProcessEnv = () => process.env;

  async complete(prompt: string, o: { cwd: string; model: string; system: string }): Promise<string> {
    const q = query({
      prompt,
      options: {
        cwd: o.cwd,
        env: this.env(o.model),
        model: o.model,
        maxTurns: 1,
        tools: [],
        systemPrompt: o.system,
        settingSources: [],
        strictMcpConfig: true,
        settings: { disableClaudeAiConnectors: true },
      },
    });
    let text = "";
    for await (const m of q) {
      if (m.type === "result") {
        if (m.subtype !== "success") throw new Error(`The model could not answer (${m.subtype})`);
        text = m.result;
      }
    }
    return text.trim();
  }

  start(o: SessionOptions): LiveSession {
    const inbox = new Inbox();
    const abort = new AbortController();
    const boardToolNames = o.tools.map((t) => `mcp__${BOARD_SERVER}__${t.name}`);
    const emit = o.onEvent;
    let contextTokens = 0;

    const options: Options = {
      abortController: abort,
      cwd: o.cwd,
      env: this.env(o.model),
      model: o.model,
      effort: o.effort,
      maxTurns: o.maxTurns,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: o.instructions },
      // The repo's own CLAUDE.md and project settings apply, like for a teammate.
      settingSources: ["project"],
      // Only the board tools: never the user's personal MCP servers or connectors.
      // Board tools, plus the team MCP servers this chat turned on (their tools ask for approval).
      mcpServers: { ...forClaude(o.mcpServers ?? []), [BOARD_SERVER]: boardServer(o.tools, o.toolContext) },
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true, ...(o.fast ? { fastMode: true } : {}), ...(o.remoteControl ? { remoteControlAtStartup: true } : {}) },
      allowedTools: boardToolNames,
      permissionMode: MODE[o.mode],
      ...(o.mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(o.resumeSessionId ? { resume: o.resumeSessionId } : {}),
      canUseTool: async (toolName, input, { signal, suggestions }): Promise<PermissionResult> => {
        if (boardToolNames.includes(toolName)) return { behavior: "allow", updatedInput: input };
        const answer = await o.onApproval({ toolName, input, signal });
        if (answer.allow) {
          return { behavior: "allow", updatedInput: answer.updatedInput ?? input, ...(answer.always && suggestions ? { updatedPermissions: suggestions } : {}) };
        }
        return { behavior: "deny", message: answer.message, ...(answer.interrupt ? { interrupt: true } : {}) };
      },
    };

    const q = query({ prompt: inbox, options });
    let closeError: string | null = null;

    const closed = (async () => {
      try {
        for await (const message of q) handle(message);
      } catch (err) {
        if (!abort.signal.aborted) closeError = err instanceof Error ? err.message : String(err);
      } finally {
        emit({ type: "closed", error: closeError });
      }
    })();

    let sessionIdSeen: string | null = null;
    let terminalOnly = new Set<string>();
    function handle(m: SDKMessage): void {
      if (process.env.CADENCE_DEBUG_SDK) {
        const sub = "subtype" in m ? `:${String(m.subtype)}` : "";
        const extra = m.type === "system" && m.subtype === "session_state_changed" ? ` ${m.state}` : m.type === "result" ? ` answered=${JSON.stringify(answeredIds(m))}` : "";
        if (m.type !== "stream_event") console.error(`[sdk] ${m.type}${sub}${extra}`);
      }
      switch (m.type) {
        case "system":
          if (m.subtype === "init") {
            sessionIdSeen = m.session_id;
            // Hide internal commands and ones that only work in a terminal.
            terminalOnly = new Set(m.terminal_slash_commands ?? []);
            const usable = m.slash_commands.filter((c) => !c.startsWith("_") && !terminalOnly.has(c));
            emit({ type: "session", sessionId: m.session_id, slashCommands: usable });
            // Descriptions come from a separate call; the list shows names until they arrive.
            void q
              .supportedCommands()
              .then((all) => emit({ type: "session", sessionId: m.session_id, slashCommands: usable, commandHints: hintsOf(all, usable) }))
              .catch(() => undefined);
          }
          else if (m.subtype === "commands_changed") {
            const names = m.commands.map((c) => c.name).filter((c) => !c.startsWith("_") && !terminalOnly.has(c));
            if (sessionIdSeen) emit({ type: "session", sessionId: sessionIdSeen, slashCommands: names, commandHints: hintsOf(m.commands, names) });
          } else if (m.subtype === "compact_boundary") emit({ type: "compacted", preTokens: m.compact_metadata.pre_tokens });
          else if (m.subtype === "session_state_changed") emit({ type: "state", state: m.state });
          return;
        case "stream_event":
          if (!m.parent_tool_use_id && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") {
            emit({ type: "text_delta", text: m.event.delta.text });
          }
          return;
        case "assistant": {
          if (m.parent_tool_use_id) return; // sub-agent internals stay out of the transcript
          // What the model was sent this step is how full the context is now.
          const u = m.message.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          if (u) contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          for (const block of m.message.content) {
            if (block.type === "text" && block.text.trim()) emit({ type: "assistant_text", text: block.text });
            else if (block.type === "tool_use") emit({ type: "tool_use", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
          }
          return;
        }
        case "user":
          if (m.parent_tool_use_id || typeof m.message.content === "string") return;
          for (const block of m.message.content) {
            if (block.type === "tool_result") emit({ type: "tool_result", id: block.tool_use_id, content: toolResultText(block.content), isError: Boolean(block.is_error) });
          }
          return;
        case "result": {
          const usage = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          const success = m.subtype === "success";
          emit({
            type: "turn_end",
            result: success ? m.result : "",
            sessionCostUsd: m.total_cost_usd,
            numTurns: m.num_turns,
            durationMs: m.duration_ms,
            inputTokens,
            outputTokens: usage.output_tokens ?? 0,
            isError: !success || m.is_error,
            error: success ? (m.is_error ? m.result.slice(0, 1000) : null) : m.subtype.replace(/_/g, " "),
            answered: answeredIds(m),
            contextTokens: contextTokens || undefined,
            contextWindow: Object.values((m as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {})[0]?.contextWindow,
          });
          return;
        }
        default:
          return;
      }
    }

    return {
      send: (message) => inbox.push(toUserMessage(message)),
      interrupt: async () => {
        await q.interrupt();
      },
      setMode: (mode) => q.setPermissionMode(MODE[mode]),
      setModel: (model) => q.setModel(model),
      close: () => {
        inbox.end();
        abort.abort();
      },
      closed,
    };
  }
}
