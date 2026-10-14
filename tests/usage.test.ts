import { afterEach, describe, expect, it } from "vitest";
import { createContainer, type Container } from "../src/server/container";
import { monthOf } from "../src/usage/service";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

// The fake harness reports $0.01 per turn.
describe("usage and budgets", () => {
  let fx: GitFixture;
  let c: Container;
  let runtime: FakeRuntime;
  afterEach(() => {
    c.stop();
    c.db.close();
    fx.cleanup();
  });

  const boot = () => {
    fx = createGitFixture();
    runtime = new FakeRuntime();
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime, llm: offlineLlm, idleMs: 60_000 });
    c.start();
  };
  const turn = async (chatId: string, text: string) => {
    runtime.next(async () => "done");
    await c.engine.send(chatId, { text });
    await until(() => c.q.chat(chatId)!.status === "idle");
  };

  it("reports spend by harness, person, agent, and day", async () => {
    boot();
    const ws = await c.workspaces.createInProject(null, "Usage", "user");
    const mine = c.engine.createChat({ workspaceId: ws.id, model: "claude-sonnet-5-5" });
    await turn(mine.id, "one");
    await turn(mine.id, "two");
    const agent = c.agents.createAgent({ name: "Helper", prompt: "Help", enabled: true });
    const agentChat = c.engine.createChat({ workspaceId: ws.id, agentId: agent.id });
    await turn(agentChat.id, "three");

    const r = c.usage.report();
    expect(r.month).toBe(monthOf());
    expect(r.usd).toBeCloseTo(0.03);
    expect(r.turns).toBe(3);
    expect(r.byProvider).toEqual([expect.objectContaining({ key: "claude-code", turns: 3 })]);
    expect(r.byModel.map((m) => [m.key, m.turns])).toEqual([
      ["claude-sonnet-5-5", 2],
      [c.q.chat(agentChat.id)!.model || "default", 1],
    ]);
    expect(r.byPerson).toEqual([expect.objectContaining({ label: "Owner", turns: 2 })]);
    expect(r.byAgent).toEqual([expect.objectContaining({ label: "Helper", turns: 1 })]);
    expect(r.byDay).toHaveLength(1);
    expect(c.usage.report("2001-01").usd).toBe(0);
    expect(() => c.usage.report("2001-13")).toThrow(/not a month/);
  });

  it("stops new messages once the organization or an agent is over budget", async () => {
    boot();
    const ws = await c.workspaces.createInProject(null, "Budget", "user");
    const chat = c.engine.createChat({ workspaceId: ws.id });
    await turn(chat.id, "one");
    c.agents.updateSettings({ monthlyBudgetUsd: 0.015 });
    await turn(chat.id, "two");
    await expect(c.engine.send(chat.id, { text: "three" })).rejects.toThrow(/used its monthly budget \(\$0\.02 of \$0\.015\)/);
    expect(c.usage.report().budgetUsd).toBe(0.015);

    c.agents.updateSettings({ monthlyBudgetUsd: null });
    const agent = c.agents.createAgent({ name: "Spender", prompt: "Spend", enabled: true, monthlyBudgetUsd: 0.01 });
    const agentChat = c.engine.createChat({ workspaceId: ws.id, agentId: agent.id });
    await turn(agentChat.id, "first");
    await expect(c.engine.send(agentChat.id, { text: "second" })).rejects.toThrow(/Spender has used its monthly budget/);
    // People's own chats are not held by an agent's budget.
    await turn(chat.id, "four");
    expect(c.usage.report().agentBudgets).toEqual([{ agentId: agent.id, name: "Spender", budgetUsd: 0.01, usd: expect.closeTo(0.01) }]);
    c.agents.updateAgent(agent.id, { monthlyBudgetUsd: null });
    await turn(agentChat.id, "second");
  });
});
