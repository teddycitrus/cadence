import { callBoardTool } from "../../src/agents/board-tools";
import type { ApprovalAnswer, ChatRuntime, LiveSession, OutgoingMessage, SessionOptions } from "../../src/agents/runtime";
import type { ChatItemData } from "../../src/core/types";

export interface ScriptContext {
  options: SessionOptions;
  message: OutgoingMessage;
  cwd: string;
  signal: AbortSignal;
  /** Calls a board tool the way the agent would; throws on tool errors. */
  call(name: string, input?: Record<string, unknown>): Promise<string>;
  /** Asks for approval of a tool call, a question, or a plan. */
  approve(toolName: string, input: Record<string, unknown>): Promise<ApprovalAnswer>;
  say(text: string): void;
  /** Messages that arrived with priority "now" while this turn ran. */
  steered: OutgoingMessage[];
}

export type Script = (ctx: ScriptContext) => Promise<string | void>;

let seq = 0;

/**
 * A scripted ChatRuntime. Every message a session receives runs the next
 * script (or the one registered for the agent named in the instructions)
 * against the real board tools and approval flow.
 */
export class FakeRuntime implements ChatRuntime {
  readonly name = "fake";
  /** CLI mode: echoes instead of launching a real CLI; the transcript is whatever a test puts here. */
  readonly cliTranscripts = new Map<string, { id: string; items: ChatItemData[] }[]>();
  readonly cli = {
    command: (o: { sessionId: string; resume: boolean }) => `echo fake-cli ${o.resume ? "resume" : "new"} ${o.sessionId}`,
    transcript: async (sessionId: string) => this.cliTranscripts.get(sessionId) ?? [],
  };

  /** Prompts sent to complete(), and the canned answer it returns. */
  readonly completions: string[] = [];
  completion = "Fix the thing";

  async complete(prompt: string): Promise<string> {
    this.completions.push(prompt);
    return this.completion;
  }
  readonly sessions: { options: SessionOptions; messages: OutgoingMessage[]; closed: boolean }[] = [];
  private queue: Script[] = [];
  private byAgent = new Map<string, Script>();

  /**
   * @param stateEvents send idle/running signals (Claude Code does not today).
   * @param savedCost the running total a resumed session starts from (a transcript's saved total).
   * @param reportAnswered say which message ids each result answered, as Claude Code does.
   * @param splitSteer end the turn when a steer arrives and run it as its own turn, as Claude Code sometimes does.
   */
  constructor(
    private stateEvents = false,
    public savedCost = 0,
    private reportAnswered = true,
    public splitSteer = false,
  ) {}

  next(...scripts: Script[]): this {
    this.queue.push(...scripts);
    return this;
  }

  forAgent(name: string, script: Script): this {
    this.byAgent.set(name, script);
    return this;
  }

  start(options: SessionOptions): LiveSession {
    const record = { options, messages: [] as OutgoingMessage[], closed: false };
    this.sessions.push(record);
    const sessionId = options.resumeSessionId ?? `session-${++seq}`;
    let turn: { abort: AbortController; steered: OutgoingMessage[] } | null = null;
    const backlog: OutgoingMessage[] = [];
    let closeResolve: () => void = () => undefined;
    const closed = new Promise<void>((r) => (closeResolve = r));
    queueMicrotask(() => options.onEvent({ type: "session", sessionId, slashCommands: ["review", "init"] }));

    const agentName = /You are the "([^"]+)" agent/.exec(options.instructions)?.[1];
    let sessionCost = options.resumeSessionId ? this.savedCost : 0;
    const runTurn = async (message: OutgoingMessage) => {
      const abort = new AbortController();
      const steered: OutgoingMessage[] = [];
      turn = { abort, steered };
      if (this.stateEvents) options.onEvent({ type: "state", state: "running" });
      const script = (agentName && this.byAgent.get(agentName)) || this.queue.shift();
      const started = Date.now();
      let error: string | null = null;
      let result = "";
      try {
        const ctx: ScriptContext = {
          options,
          message,
          cwd: options.cwd,
          signal: abort.signal,
          steered,
          call: async (name, input = {}) => {
            options.onEvent({ type: "tool_use", id: `tu_${++seq}`, name: `mcp__cadence__${name}`, input });
            const r = await callBoardTool(options.tools, name, input, options.toolContext);
            if (r.isError) throw new Error(r.text);
            return r.text;
          },
          approve: (toolName, input) => options.onApproval({ toolName, input, signal: abort.signal }),
          say: (text) => {
            options.onEvent({ type: "text_delta", text });
            options.onEvent({ type: "assistant_text", text });
          },
        };
        result = (script ? await script(ctx) : "ok") ?? "done";
        if (abort.signal.aborted) error = "interrupted by user";
      } catch (err) {
        error = abort.signal.aborted ? "interrupted by user" : err instanceof Error ? err.message : String(err);
      }
      turn = null;
      // Like the real SDK, cost is reported as a running total for the process.
      sessionCost += 0.01;
      // Claude Code may answer a steered message in the same result, or end this turn and run it separately.
      const folded = this.splitSteer ? [] : steered;
      const answered = this.reportAnswered ? [message.id, ...folded.map((m) => m.id)] : null;
      options.onEvent({ type: "turn_end", result, sessionCostUsd: sessionCost, numTurns: 2, durationMs: Date.now() - started, inputTokens: 100, outputTokens: 20, isError: Boolean(error), error, answered });
      if (this.splitSteer) backlog.unshift(...steered);
      const next = backlog.shift();
      if (next) void runTurn(next);
      else if (this.stateEvents) options.onEvent({ type: "state", state: "idle" });
    };

    return {
      send: (message) => {
        record.messages.push(message);
        if (turn && message.priority === "now") turn.steered.push(message);
        else if (turn) backlog.push(message);
        else void runTurn(message);
      },
      interrupt: async () => {
        turn?.abort.abort();
      },
      setMode: async (mode) => {
        options.mode = mode;
      },
      setModel: async (model) => {
        options.model = model;
      },
      close: () => {
        if (record.closed) return;
        record.closed = true;
        turn?.abort.abort();
        options.onEvent({ type: "closed", error: null });
        closeResolve();
      },
      closed,
    };
  }
}

/** Polls until the condition holds (sessions run asynchronously). */
export async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}
