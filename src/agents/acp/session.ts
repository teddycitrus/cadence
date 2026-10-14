import { forAcp } from "../../integrations/mcp-servers";
import { fileURLToPath } from "node:url";
import type { ChatMode } from "../../core/types";
import type { ToolBridge } from "../tool-bridge";
import type { LiveSession, OutgoingMessage, RuntimeEvent, SessionOptions } from "../runtime";
import { AcpConnection, type AcpLaunch } from "./connection";
import { autoAllows, mcpCall, modelFor, optionFor, pickMode, promptBlocks, toolInput, toolName, toolOutput, type AcpMode, type AcpPermissionOption, type AcpToolCall } from "./mapping";
import { commandHint } from "../command-hints";

const PROXY = fileURLToPath(new URL("./mcp-stdio-proxy.mjs", import.meta.url));
export const BRIDGE_SERVER = "cadence";

interface SessionSetup {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: AcpMode[] } | null;
  models?: { currentModelId: string; availableModels: { modelId: string; name?: string }[] } | null;
}

/** The MCP server entry that gives the harness this session's board tools. */
export function bridgeServer(bridge: { url: string; token: string }, http: boolean): Record<string, unknown> {
  if (http) return { type: "http", name: BRIDGE_SERVER, url: bridge.url, headers: [{ name: "Authorization", value: `Bearer ${bridge.token}` }] };
  return { name: BRIDGE_SERVER, command: process.execPath, args: [PROXY, bridge.url], env: [{ name: "CADENCE_MCP_TOKEN", value: bridge.token }] };
}

const PLAN_NOTE = "You are in plan mode: do not change any files or run commands that change state. Investigate, then reply with a step-by-step plan for approval.";

/**
 * One chat's session with an ACP harness. Prompts run one at a time (the
 * protocol has one turn in flight per session); a steering message cancels
 * the turn in progress and goes next.
 */
export function startAcpSession(launch: AcpLaunch, o: SessionOptions, bridge: ToolBridge, hooks: { onModels?(models: string[]): void } = {}): LiveSession {
  const conn = new AcpConnection(launch);
  const emit = o.onEvent;
  const registered = bridge.register(o.tools, o.toolContext);
  const queue: OutgoingMessage[] = [];
  const tools = new Map<string, AcpToolCall & { done?: boolean }>();
  const pendingApprovals = new Set<AbortController>();
  let mode: ChatMode = o.mode;
  let sessionId: string | null = null;
  let modes: AcpMode[] = [];
  let modelIds: string[] = [];
  let currentModelId: string | null = null;
  let loading = false;
  let running: { id: string; cancelled: boolean } | null = null;
  let text = "";
  let lastText = "";
  let toolCalls = 0;
  let firstPrompt = !o.resumeSessionId;
  let slashCommands: string[] = [];
  let commandHints: Record<string, string> = {};
  let usage = { input: 0, output: 0, cost: 0 };
  let closing = false;
  let userClosed = false;
  let startupFailed = false;
  let startupReported = false;
  let startupError: string | null = null;

  const flush = () => {
    if (text.trim()) {
      emit({ type: "assistant_text", text });
      lastText = text;
    }
    text = "";
  };

  const finishTool = (call: AcpToolCall & { done?: boolean }) => {
    if (call.done) return;
    call.done = true;
    emit({ type: "tool_result", id: call.toolCallId, content: toolOutput(call), isError: call.status === "failed" });
  };

  conn.peer.on("session/update", (p: { sessionId: string; update: Record<string, any> }) => {
    const u = p.update;
    // Harnesses often announce their commands before session/new has answered.
    if (u.sessionUpdate === "available_commands_update") {
      const list: { name: string; description?: string; input?: { hint?: string } | null }[] = u.availableCommands ?? [];
      slashCommands = list.map((c) => c.name.replace(/^\//, ""));
      commandHints = Object.fromEntries(list.filter((c) => c.description).map((c) => [c.name.replace(/^\//, ""), commandHint(c.description!, c.input?.hint)]));
      if (sessionId && !loading) emit({ type: "session", sessionId, slashCommands, commandHints });
      return;
    }
    if (loading || p.sessionId !== sessionId) return; // replayed history is already in the transcript
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text" && u.content.text) {
          text += u.content.text;
          emit({ type: "text_delta", text: u.content.text });
        }
        return;
      case "tool_call": {
        flush();
        toolCalls++;
        const call: AcpToolCall = { ...(u as AcpToolCall) };
        tools.set(call.toolCallId, call);
        emit({ type: "tool_use", id: call.toolCallId, name: toolName(call), input: toolInput(call) });
        if (call.status === "completed" || call.status === "failed") finishTool(call);
        return;
      }
      case "tool_call_update": {
        const prev = tools.get(u.toolCallId);
        const { sessionUpdate: _s, ...fields } = u;
        const call = { ...(prev ?? { toolCallId: u.toolCallId }), ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)) } as AcpToolCall & { done?: boolean };
        tools.set(call.toolCallId, call);
        // An update for a call that was never announced still shows up.
        if (!prev) {
          flush();
          toolCalls++;
          emit({ type: "tool_use", id: call.toolCallId, name: toolName(call), input: toolInput(call) });
        }
        if (call.status === "completed" || call.status === "failed") finishTool(call);
        return;
      }
      case "plan": {
        flush();
        const id = `plan-${Date.now()}`;
        const todos = (u.entries ?? []).map((e: { content: string; status: string }) => ({ content: e.content, status: e.status === "in_progress" || e.status === "completed" ? e.status : "pending" }));
        emit({ type: "tool_use", id, name: "TodoWrite", input: { todos } });
        emit({ type: "tool_result", id, content: "Plan updated", isError: false });
        return;
      }
      case "usage_update":
        if (typeof u.cost?.amount === "number") usage.cost = u.cost.amount;
        return;
      default:
        return;
    }
  });

  conn.peer.on("session/request_permission", async (p: { toolCall: AcpToolCall; options: AcpPermissionOption[] }) => {
    const known = tools.get(p.toolCall.toolCallId);
    const call: AcpToolCall = { ...known, ...p.toolCall };
    // Cadence's own board tools are always allowed, like for Claude Code.
    const ours = mcpCall(call)?.server === BRIDGE_SERVER || toolName(call).startsWith(`mcp__${BRIDGE_SERVER}__`);
    const auto = ours ? true : autoAllows(mode, call.kind);
    if (auto === true) return { outcome: { outcome: "selected", optionId: optionFor(p.options, true, false) ?? p.options[0]?.optionId } };
    if (auto === "reject") return { outcome: { outcome: "selected", optionId: optionFor(p.options, false, false) ?? p.options.at(-1)?.optionId } };
    const abort = new AbortController();
    pendingApprovals.add(abort);
    try {
      const answer = await o.onApproval({ toolName: toolName(call), input: toolInput(call), signal: abort.signal });
      if (abort.signal.aborted) return { outcome: { outcome: "cancelled" } };
      if (!answer.allow && answer.interrupt) void cancelTurn();
      const optionId = optionFor(p.options, answer.allow, answer.allow && Boolean(answer.always));
      return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
    } finally {
      pendingApprovals.delete(abort);
    }
  });

  const cancelTurn = async () => {
    if (!running || !sessionId) return;
    running.cancelled = true;
    for (const a of pendingApprovals) a.abort();
    conn.peer.notify("session/cancel", { sessionId });
  };

  const applyMode = async (m: ChatMode) => {
    mode = m;
    const target = pickMode(m, modes);
    if (target && sessionId) await conn.peer.request("session/set_mode", { sessionId, modeId: target.id }).catch(() => undefined);
  };

  const applyModel = async (model: string) => {
    if (!sessionId || !model) return;
    const target = modelFor(model, o.effort, currentModelId, modelIds);
    if (!target || target === currentModelId) return;
    await conn.peer
      .request("session/set_model", { sessionId, modelId: target })
      .then(() => (currentModelId = target))
      .catch(() => undefined);
  };

  const ready = (async () => {
    await conn.initialize();
    const http = Boolean(conn.capabilities.mcpCapabilities?.http);
    const mcpServers = [...(registered ? [bridgeServer(registered, http)] : []), ...forAcp(o.mcpServers ?? [], http)];
    let setup: SessionSetup;
    if (o.resumeSessionId && conn.capabilities.sessionCapabilities?.resume) {
      sessionId = o.resumeSessionId;
      setup = { sessionId: o.resumeSessionId, ...(await conn.withAuth(() => conn.peer.request<Omit<SessionSetup, "sessionId">>("session/resume", { sessionId: o.resumeSessionId, cwd: o.cwd, mcpServers }))) };
    } else if (o.resumeSessionId && conn.capabilities.loadSession) {
      loading = true;
      sessionId = o.resumeSessionId;
      try {
        setup = { sessionId: o.resumeSessionId, ...(await conn.withAuth(() => conn.peer.request<Omit<SessionSetup, "sessionId">>("session/load", { sessionId: o.resumeSessionId, cwd: o.cwd, mcpServers }))) };
      } finally {
        loading = false;
      }
    } else {
      // A harness that cannot reload sessions starts fresh; the instructions go with the first prompt.
      setup = await conn.withAuth(() => conn.peer.request<SessionSetup>("session/new", { cwd: o.cwd, mcpServers }));
      firstPrompt = true;
    }
    sessionId = setup.sessionId;
    modes = setup.modes?.availableModes ?? [];
    modelIds = setup.models?.availableModels.map((m) => m.modelId) ?? [];
    currentModelId = setup.models?.currentModelId ?? null;
    if (modelIds.length) hooks.onModels?.(modelIds);
    emit({ type: "session", sessionId, slashCommands, commandHints });
    await applyMode(mode);
    await applyModel(o.model);
  })();

  const pump = async () => {
    if (running || closing) return;
    const next = queue.shift();
    if (!next) return;
    running = { id: next.id, cancelled: false };
    const started = Date.now();
    toolCalls = 0;
    lastText = "";
    let error: string | null = null;
    let stopReason = "end_turn";
    try {
      await ready;
      const preface = [firstPrompt ? `<cadence_instructions>\n${o.instructions.trim()}\n</cadence_instructions>` : "", mode === "plan" && !pickMode("plan", modes) ? PLAN_NOTE : ""].filter(Boolean).join("\n\n");
      firstPrompt = false;
      const prompt = promptBlocks(preface ? `${preface}\n\n${next.text}` : next.text, next.attachments, conn.capabilities.promptCapabilities ?? {});
      const res = await conn.peer.request<{ stopReason: string; usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number } }>("session/prompt", { sessionId, prompt });
      stopReason = res?.stopReason ?? "end_turn";
      usage.input = res?.usage ? (res.usage.inputTokens ?? 0) + (res.usage.cachedReadTokens ?? 0) : 0;
      usage.output = res?.usage?.outputTokens ?? 0;
      if (stopReason === "refusal") error = `${launch.label} refused to continue`;
      else if (stopReason === "max_tokens") error = "The reply hit the output limit";
      else if (stopReason === "max_turn_requests") error = "The turn hit its step limit";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (startupFailed) startupReported = true;
    }
    flush();
    for (const call of tools.values()) if (!call.done && (call.status === "completed" || call.status === "failed")) finishTool(call);
    const cancelled = running.cancelled || stopReason === "cancelled";
    emit({
      type: "turn_end",
      result: lastText,
      sessionCostUsd: usage.cost,
      numTurns: toolCalls + 1,
      durationMs: Date.now() - started,
      inputTokens: usage.input,
      outputTokens: usage.output,
      isError: Boolean(error) && !cancelled,
      error: cancelled ? null : error,
      answered: [next.id],
    });
    running = null;
    if (!closing && conn.proc.exitCode === null) void pump();
  };

  // Startup failures (not installed, sign-in needed) end the session with the reason.
  ready.catch((err) => {
    if (userClosed) return;
    startupFailed = true;
    startupError = err instanceof Error ? err.message : String(err);
    // Let a waiting prompt report it first, then stop the process.
    setTimeout(() => {
      queue.splice(0);
      closing = true;
      conn.kill();
    }, 0);
  });

  const closed = (async () => {
    const code = await conn.exited;
    registered?.dispose();
    // Let startup settle and a waiting prompt report a startup failure first.
    await ready.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    let error: string | null = null;
    if (userClosed) error = null;
    else if (startupFailed) error = startupReported ? null : startupError;
    else error = conn.describeExit(code);
    emit({ type: "closed", error });
  })();

  return {
    send: (message) => {
      if (message.priority === "now" && running) {
        queue.unshift(message);
        void cancelTurn();
      } else queue.push(message);
      void pump();
    },
    interrupt: async () => {
      queue.splice(0);
      await cancelTurn();
    },
    setMode: async (m) => {
      await ready.catch(() => undefined);
      await applyMode(m);
    },
    setModel: async (model) => {
      await ready.catch(() => undefined);
      await applyModel(model);
    },
    close: () => {
      closing = true;
      userClosed = true;
      for (const a of pendingApprovals) a.abort();
      registered?.dispose();
      conn.kill();
    },
    closed,
  };
}

export type { RuntimeEvent };
