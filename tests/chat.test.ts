import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContainer, type Container } from "../src/server/container";
import type { Ephemeral } from "../src/core/bus";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { createGitFixture, gitOut, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";
import { transferChat } from "../src/chat/transfer";

describe("chats and workspaces", () => {
  let fx: GitFixture;
  let c: Container;
  let runtime: FakeRuntime;

  const boot = () => {
    fx = createGitFixture();
    runtime = new FakeRuntime();
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime, llm: offlineLlm, idleMs: 60_000 });
    c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null });
    c.start();
  };

  afterEach(() => {
    c.stop();
    c.db.close();
    fx.cleanup();
  });

  const newChat = async () => {
    const ws = await c.workspaces.createInProject(null, "Quiet hours", "user");
    return { ws, chat: c.engine.createChat({ workspaceId: ws.id }) };
  };
  const idle = (chatId: string) => until(() => c.q.chat(chatId)!.status === "idle");

  it("creates a workspace on its own branch and runs a chat turn in it", async () => {
    boot();
    const { ws, chat } = await newChat();
    expect(ws.branch).toMatch(/^cadence\/quiet-hours-[0-9a-f]{4}$/);
    expect(existsSync(ws.path)).toBe(true);

    const deltas: Ephemeral[] = [];
    c.bus.subscribe((e) => deltas.push(e));
    runtime.next(async (ctx) => {
      ctx.say(`You said: ${ctx.message.text}`);
      return "done";
    });
    await c.engine.send(chat.id, { text: "Add a quiet hours toggle" });
    await idle(chat.id);

    const items = c.q.chatItems(chat.id);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "turn"]);
    expect(items[1]).toMatchObject({ kind: "assistant", text: "You said: Add a quiet hours toggle" });
    expect(c.q.chat(chat.id)).toMatchObject({ title: "Add a quiet hours toggle", unread: true, sessionId: expect.any(String), slashCommands: ["review", "init"], costUsd: 0.01 });
    expect(deltas.some((d) => d.type === "delta")).toBe(true);
    expect(runtime.sessions[0]!.options.cwd).toBe(ws.path);
    expect(runtime.sessions[0]!.options.instructions).toContain(`on git branch ${ws.branch}`);

    c.engine.markRead(chat.id);
    expect(c.q.chat(chat.id)!.unread).toBe(false);
  });

  it("queues messages sent mid-turn and delivers them after, in order", async () => {
    boot();
    const { chat } = await newChat();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    runtime.next(
      async () => {
        await gate;
      },
      async (ctx) => ctx.say(`second: ${ctx.message.text}`),
    );
    await c.engine.send(chat.id, { text: "first" });
    await until(() => c.q.chat(chat.id)!.status === "running");
    expect(await c.engine.send(chat.id, { text: "follow up" })).toEqual({ queued: true });
    const [queued] = c.q.queued(chat.id);
    c.engine.editQueued(chat.id, queued!.id, "follow up, edited");
    release();
    await until(() => c.q.chatItems(chat.id).some((i) => i.kind === "assistant"));
    await idle(chat.id);
    expect(c.q.queued(chat.id)).toHaveLength(0);
    const texts = c.q.chatItems(chat.id).filter((i) => i.kind === "user" || i.kind === "assistant").map((i) => ("text" in i ? i.text : ""));
    expect(texts).toEqual(["first", "follow up, edited", "second: follow up, edited"]);
  });

  it("steers a running turn and can interrupt it", async () => {
    boot();
    const { chat } = await newChat();
    let steered: string[] = [];
    runtime.next(async (ctx) => {
      await until(() => ctx.steered.length > 0 || ctx.signal.aborted);
      steered = ctx.steered.map((m) => m.text);
      await new Promise((r, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    await c.engine.send(chat.id, { text: "start" });
    await until(() => c.q.chat(chat.id)!.status === "running");
    await c.engine.send(chat.id, { text: "use the existing toggle component" }, "user", { steer: true });
    await until(() => steered.length > 0);
    expect(steered).toEqual(["use the existing toggle component"]);
    expect(c.q.chatItems(chat.id).find((i) => i.kind === "user" && i.steer)).toBeTruthy();
    await c.engine.interrupt(chat.id);
    await until(() => c.q.chat(chat.id)!.status === "interrupted");
  });

  it("asks the person a question and passes the answers back", async () => {
    boot();
    const { chat } = await newChat();
    let answer: unknown;
    runtime.next(async (ctx) => {
      answer = await ctx.approve("AskUserQuestion", { questions: [{ question: "Per user or per workspace?", header: "Scope", options: [{ label: "Per user", description: "" }, { label: "Per workspace", description: "" }], multiSelect: false }] });
    });
    await c.engine.send(chat.id, { text: "go" });
    await until(() => c.q.pendingInteractions().length === 1);
    const [q] = c.q.pendingInteractions();
    expect(q).toMatchObject({ kind: "question", questions: [expect.objectContaining({ header: "Scope" })] });
    expect(c.q.chat(chat.id)!.status).toBe("waiting");
    await expect(c.engine.resolve(q!.id, { kind: "tool", allow: true })).rejects.toThrow(/question request/);
    await c.engine.resolve(q!.id, { kind: "question", answers: { "Per user or per workspace?": "Per user" } });
    await idle(chat.id);
    expect(answer).toMatchObject({ allow: true, updatedInput: { answers: { "Per user or per workspace?": "Per user" } } });
    expect(c.q.interaction(q!.id)).toMatchObject({ status: "resolved", resolution: "Per user or per workspace? Per user" });
  });

  it("approves a plan: saves it as a doc and switches to editing", async () => {
    boot();
    const issue = c.issues.createIssue({ title: "Quiet hours" });
    const ws = await c.workspaces.forIssue(issue, "user");
    const chat = c.engine.createChat({ workspaceId: ws.id, mode: "plan" });
    runtime.next(async (ctx) => {
      await ctx.approve("ExitPlanMode", { plan: "1. Add toggle\n2. Store window" });
    });
    await c.engine.send(chat.id, { text: "plan it" });
    await until(() => c.q.pendingInteractions().length === 1);
    const [plan] = c.q.pendingInteractions();
    expect(plan).toMatchObject({ kind: "plan", plan: "1. Add toggle\n2. Store window" });
    await c.engine.resolve(plan!.id, { kind: "plan", action: "approve" });
    await idle(chat.id);
    expect(c.q.chat(chat.id)!.mode).toBe("acceptEdits");
    expect(runtime.sessions[0]!.options.mode).toBe("acceptEdits");
    expect(c.q.docsForIssue(issue.id)[0]).toMatchObject({ title: "Plan: plan it", body: "1. Add toggle\n2. Store window" });
  });

  it("executes an approved plan in a fresh chat, or sends feedback to keep planning", async () => {
    boot();
    const { ws, chat } = await newChat();
    const answers: unknown[] = [];
    runtime.next(async (ctx) => {
      answers.push(await ctx.approve("ExitPlanMode", { plan: "v1" }));
      answers.push(await ctx.approve("ExitPlanMode", { plan: "v2" }));
    });
    runtime.next(async (ctx) => ctx.say(`executing: ${ctx.message.text.split("\n")[0]}`));
    await c.engine.send(chat.id, { text: "plan" });
    await until(() => c.q.pendingInteractions().length === 1);
    await c.engine.resolve(c.q.pendingInteractions()[0]!.id, { kind: "plan", action: "revise", feedback: "Cover errors" });
    await until(() => c.q.pendingInteractions().length === 1 && c.q.pendingInteractions()[0]!.plan === "v2");
    const { newChatId } = await c.engine.resolve(c.q.pendingInteractions()[0]!.id, { kind: "plan", action: "execute_fresh" });
    expect(answers[0]).toMatchObject({ allow: false, message: expect.stringContaining("Cover errors") });
    expect(answers[1]).toMatchObject({ allow: false, interrupt: true });
    await idle(newChatId!);
    expect(c.q.chat(newChatId!)).toMatchObject({ workspaceId: ws.id, mode: "acceptEdits", title: "Execute: plan" });
    expect(c.q.chatItems(newChatId!).find((i) => i.kind === "assistant")).toMatchObject({ text: "executing: Implement this approved plan." });
  });

  it("restarts an idle session when effort changes and resumes from the session id", async () => {
    boot();
    const { chat } = await newChat();
    await c.engine.send(chat.id, { text: "one" });
    await idle(chat.id);
    c.engine.setEffort(chat.id, "max");
    expect(runtime.sessions[0]!.closed).toBe(true);
    await c.engine.send(chat.id, { text: "two" });
    await idle(chat.id);
    expect(runtime.sessions[1]!.options).toMatchObject({ effort: "max", resumeSessionId: c.q.chat(chat.id)!.sessionId });
  });

  it("turns the harness's running cost total into per-turn costs, including after a resume", async () => {
    boot();
    const { chat } = await newChat();
    await c.engine.send(chat.id, { text: "one" });
    await idle(chat.id);
    await c.engine.send(chat.id, { text: "two" });
    await idle(chat.id);
    const turns = () => c.q.chatItems(chat.id).filter((i) => i.kind === "turn").map((i) => Number((i as { costUsd: number }).costUsd.toFixed(3)));
    expect(turns()).toEqual([0.01, 0.01]);
    expect(c.q.chat(chat.id)!.costUsd).toBeCloseTo(0.02);

    // A resumed process reports the saved total plus new spend.
    c.engine.close(chat.id);
    runtime.savedCost = 0.02;
    await c.engine.send(chat.id, { text: "three" });
    await idle(chat.id);
    expect(turns()).toEqual([0.01, 0.01, 0.01]);
    expect(c.q.chat(chat.id)!.costUsd).toBeCloseTo(0.03);
  });

  it("stays running while a steered message is still unanswered (the harness splits it into its own turn)", async () => {
    boot();
    runtime.splitSteer = true;
    const { chat } = await newChat();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    runtime.next(
      async (ctx) => {
        await until(() => ctx.steered.length > 0);
      },
      async (ctx) => {
        await gate;
        ctx.say(`handled: ${ctx.message.text}`);
      },
    );
    await c.engine.send(chat.id, { text: "start" });
    await until(() => c.q.chat(chat.id)!.status === "running");
    await c.engine.send(chat.id, { text: "and this" }, "user", { steer: true });
    // The first result arrives, but it does not answer the steer: still busy.
    await until(() => c.q.chatItems(chat.id).filter((i) => i.kind === "turn").length === 1);
    expect(c.q.chat(chat.id)!.status).toBe("running");
    expect(await c.engine.send(chat.id, { text: "queued meanwhile" })).toEqual({ queued: true });
    release();
    await until(() => c.q.chatItems(chat.id).some((i) => i.kind === "assistant"));
    await idle(chat.id);
    expect(c.q.chatItems(chat.id).filter((i) => i.kind === "turn")).toHaveLength(3);
  });

  it("ends turns on results alone when the harness does not say which messages were answered", async () => {
    fx = createGitFixture();
    runtime = new FakeRuntime(false, 0, false);
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime, llm: offlineLlm });
    c.start();
    const { chat } = await newChat();
    await c.engine.send(chat.id, { text: "hello" });
    await idle(chat.id);
    expect(c.q.chatItems(chat.id).map((i) => i.kind)).toEqual(["user", "turn"]);
  });

  it("treats an idle signal as authoritative when the harness sends one", async () => {
    fx = createGitFixture();
    runtime = new FakeRuntime(true, 0, false);
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime, llm: offlineLlm });
    c.start();
    const { chat } = await newChat();
    await c.engine.send(chat.id, { text: "hello" });
    await idle(chat.id);
    expect(c.q.chat(chat.id)!.status).toBe("idle");
  });

  it("marks chats interrupted after a restart and cancels their pending requests", async () => {
    boot();
    const { chat } = await newChat();
    runtime.next(async (ctx) => {
      await ctx.approve("Bash", { command: "ls" });
    });
    await c.engine.send(chat.id, { text: "go" });
    await until(() => c.q.pendingInteractions().length === 1);
    c.engine.recover();
    expect(c.q.chat(chat.id)!.status).toBe("interrupted");
    expect(c.q.pendingInteractions()).toHaveLength(0);
  });

  it("never adopts an existing branch: a colliding issue branch gets a suffix", async () => {
    boot();
    gitOut(fx.repo, "branch", "cadence/cad-1-export");
    const issue = c.issues.createIssue({ title: "Export" });
    const ws = await c.workspaces.forIssue(issue, "user");
    expect(ws.branch).toBe("cadence/cad-1-export-2");
    expect(c.q.issue(issue.id)!.branch).toBe("cadence/cad-1-export-2");
  });

  it("archives, restores, reports status, and deletes workspaces", async () => {
    boot();
    const { ws } = await newChat();
    writeFileSync(join(ws.path, "new.txt"), "hello\n");
    const status = await c.workspaces.status(ws.id);
    expect(status.files).toEqual([{ path: "new.txt", status: "A" }]);
    expect(await c.workspaces.diff(ws.id, "new.txt")).toContain("+hello");

    await c.workspaces.archive(ws.id);
    expect(existsSync(ws.path)).toBe(false);
    expect(gitOut(fx.repo, "branch", "--list", ws.branch!)).toContain(ws.branch!);
    await c.workspaces.restore(ws.id);
    expect(existsSync(ws.path)).toBe(true);

    await c.workspaces.remove(ws.id, true);
    expect(c.q.workspace(ws.id)).toBeNull();
    expect(gitOut(fx.repo, "branch", "--list", ws.branch!)).toBe("");
  });

  it("moves a chat to another workspace and starts there with the conversation so far", async () => {
    boot();
    const { ws, chat } = await newChat();
    const other = await c.workspaces.createInProject(null, "Night mode", "user");
    runtime.next(async (ctx) => (ctx.say("Use a cron job for quiet hours."), "done"));
    await c.engine.send(chat.id, { text: "How should quiet hours work?" });
    await idle(chat.id);
    expect(c.q.chat(chat.id)!.sessionId).toBeTruthy();

    const d = { engine: c.engine, store: c.store, q: c.q };
    expect(() => transferChat(d, chat.id, ws.id)).toThrow(/already/);
    const moved = transferChat(d, chat.id, other.id);
    expect(moved).toMatchObject({ workspaceId: other.id, sessionId: null, carryOver: true });
    expect(c.q.chatsForWorkspace(other.id).map((x) => x.id)).toContain(chat.id);
    expect(c.q.chatsForWorkspace(ws.id).map((x) => x.id)).not.toContain(chat.id);

    runtime.next(async (ctx) => (ctx.say("Continuing."), "done"));
    await c.engine.send(chat.id, { text: "Go on" });
    await idle(chat.id);
    const second = runtime.sessions[1]!.options;
    expect(second.cwd).toBe(other.path);
    expect(second.resumeSessionId).toBeNull();
    expect(second.instructions).toContain("## Conversation so far");
    expect(second.instructions).toContain("You: Use a cron job for quiet hours.");
    expect(c.q.chat(chat.id)!.carryOver).toBe(false);
    expect(c.q.chatItems(chat.id).some((i) => i.kind === "notice" && i.text.startsWith("Moved to Night mode"))).toBe(true);
  });
});
