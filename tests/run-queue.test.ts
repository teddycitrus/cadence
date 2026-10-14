import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { createGitFixture, gitOut, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

// End to end through triggers, the queue, workspaces, chats, and the board
// tools, with a scripted runtime standing in for Claude Code.
describe("run queue", () => {
  let fx: GitFixture;
  let c: Container;
  let runtime: FakeRuntime;

  const boot = () => {
    fx = createGitFixture();
    runtime = new FakeRuntime();
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime, llm: offlineLlm });
    c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null });
    c.start();
  };

  afterEach(() => {
    c.stop();
    c.db.close();
    fx.cleanup();
  });

  it("runs the bug lane: the fixer works in the issue workspace and hands off to the reviewer", async () => {
    boot();
    const fixer = c.agents.createAgent({ name: "Bug Squasher", prompt: "Fix bugs", enabled: true });
    c.agents.createAgent({ name: "Code Reviewer", prompt: "Review", enabled: true });

    runtime.forAgent("Bug Squasher", async (ctx) => {
      expect(await ctx.call("issues_get", { issue: "CAD-1" })).toContain("add() subtracts");
      writeFileSync(join(ctx.cwd, "src/math.js"), "export const add = (a, b) => a + b;\n");
      gitOut(ctx.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix add");
      ctx.say("Fixed the operator.");
      await ctx.call("issues_move", { issue: "CAD-1", stage: "Code Review" });
      await ctx.call("issues_assign", { issue: "CAD-1", assignee: "Code Reviewer", add: true });
      await ctx.call("issues_assign", { issue: "CAD-1", assignee: "Bug Squasher", add: false });
      return "Fixed add()";
    });
    runtime.forAgent("Code Reviewer", async (ctx) => {
      await ctx.call("issues_assign", { issue: "CAD-1", assignee: "me", add: true });
      await ctx.call("issues_assign", { issue: "CAD-1", assignee: "Code Reviewer", add: false });
      return "LGTM";
    });

    const issue = c.issues.createIssue({ title: "add() subtracts", type: "bug", stageId: c.q.stage("Ready to Build")!.id });
    c.issues.setAssignee(issue.id, { kind: "agent", id: fixer.id }, true);
    await c.queue.whenIdle();

    const done = c.q.issue(issue.id)!;
    expect(c.q.stage(done.stageId)?.name).toBe("Code Review");
    expect(done.assignees).toEqual([{ kind: "user", id: "me" }]);
    expect(done.branch).toBe("cadence/cad-1-add-subtracts");
    expect(gitOut(fx.repo, "show", `${done.branch}:src/math.js`)).toContain("a + b");
    expect(readFileSync(join(fx.repo, "src/math.js"), "utf8")).toContain("a - b");

    // One workspace for the issue, one chat per agent in it, both linked to their runs.
    const [ws] = c.q.workspacesForIssue(issue.id);
    const chats = c.q.chatsForWorkspace(ws!.id);
    expect(chats.map((ch) => ch.title).sort()).toEqual(["Bug Squasher · CAD-1", "Code Reviewer · CAD-1"]);
    const runs = c.q.runsForIssue(issue.id);
    expect(runs.every((r) => r.status === "succeeded" && r.workspaceId === ws!.id && r.chatId)).toBe(true);
    const fixerItems = c.q.chatItems(runs.find((r) => r.agentId === fixer.id)!.chatId!);
    expect(fixerItems.map((i) => i.kind)).toEqual(expect.arrayContaining(["user", "tool_use", "assistant", "turn"]));
    expect(runtime.sessions.every((s) => s.closed)).toBe(true);
  });

  it("continues the same agent chat on a follow-up run", async () => {
    boot();
    const agent = c.agents.createAgent({ name: "Helper", prompt: "x", enabled: true });
    const issue = c.issues.createIssue({ title: "Flaky" });
    runtime.forAgent("Helper", async () => "ok");
    c.issues.setAssignee(issue.id, { kind: "agent", id: agent.id }, true);
    await c.queue.whenIdle();
    c.agents.queueRun({ agentId: agent.id, issueId: issue.id, trigger: "manual", context: "again" });
    await c.queue.whenIdle();
    const runs = c.q.runsForIssue(issue.id);
    expect(new Set(runs.map((r) => r.chatId)).size).toBe(1);
    expect(runtime.sessions[1]!.options.resumeSessionId).toBe(c.q.chat(runs[0]!.chatId!)!.sessionId);
  });

  it("records failures as a failed run and an error notice in the chat", async () => {
    boot();
    const agent = c.agents.createAgent({ name: "Broken", prompt: "x", enabled: true });
    runtime.forAgent("Broken", async () => {
      throw new Error("tool exploded");
    });
    const runId = c.agents.queueRun({ agentId: agent.id, issueId: null, trigger: "manual", context: "" })!;
    await c.queue.whenIdle();
    expect(c.q.run(runId)).toMatchObject({ status: "failed", error: "tool exploded" });
    expect(c.q.workspace(c.q.run(runId)!.workspaceId!)).toMatchObject({ agentId: agent.id, name: "Broken home" });
  });

  it("cancels a run waiting on approval", async () => {
    boot();
    const agent = c.agents.createAgent({ name: "Careful", prompt: "x", enabled: true, permissionMode: "ask" });
    runtime.forAgent("Careful", async (ctx) => {
      const answer = await ctx.approve("Bash", { command: "rm -rf build" });
      if (!answer.allow) throw new Error(answer.message);
    });
    const runId = c.agents.queueRun({ agentId: agent.id, issueId: null, trigger: "manual", context: "" })!;
    await until(() => c.q.pendingInteractions().length === 1);
    expect(c.q.chat(c.q.run(runId)!.chatId!)!.status).toBe("waiting");
    c.queue.cancel(runId);
    await c.queue.whenIdle();
    expect(c.q.run(runId)!.status).toBe("cancelled");
    expect(c.q.pendingInteractions()).toHaveLength(0);
  });

  it("respects the concurrency limit and does not run disabled agents", async () => {
    boot();
    c.agents.updateSettings({ concurrency: 1 });
    const a = c.agents.createAgent({ name: "Slow", prompt: "x", enabled: true });
    const off = c.agents.createAgent({ name: "Off", prompt: "x", enabled: false });
    let concurrent = 0;
    let peak = 0;
    runtime.forAgent("Slow", async () => {
      peak = Math.max(peak, ++concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    });
    for (let i = 0; i < 3; i++) c.agents.queueRun({ agentId: a.id, issueId: null, trigger: "manual", context: String(i) });
    const offRun = c.agents.queueRun({ agentId: off.id, issueId: null, trigger: "manual", context: "" })!;
    await c.queue.whenIdle();
    expect(peak).toBe(1);
    expect(c.q.run(offRun)!.status).toBe("queued");
  });
});
