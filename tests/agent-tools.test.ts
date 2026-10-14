import { describe, expect, it } from "vitest";
import { agentTools } from "../src/agents/agent-tools";
import { callBoardTool } from "../src/agents/board-tools";
import { makeContainer } from "./helpers/setup";

describe("agent management tools", () => {
  it("creates agents disabled, refuses self-rewrites and self-starts, and queues runs", async () => {
    const { c } = makeContainer();
    const tools = agentTools(c.q, c.agents);
    const lead = c.agents.createAgent({ name: "Lead", prompt: "Coordinate", enabled: true });
    const ctx = { actor: `agent:${lead.id}` as const, runId: null, issueId: null };

    expect((await callBoardTool(tools, "agents_create", { name: "Reviewer 2", template: "code-reviewer" }, ctx)).text).toContain("disabled");
    const created = c.q.agent("Reviewer 2")!;
    expect(created).toMatchObject({ enabled: false, templateId: "code-reviewer" });
    expect((await callBoardTool(tools, "agents_create", { name: "X", template: "nope" }, ctx)).isError).toBe(true);

    expect((await callBoardTool(tools, "agents_update", { agent: "Lead", prompt: "I am in charge now" }, ctx)).text).toContain("cannot rewrite its own");
    expect((await callBoardTool(tools, "agents_update", { agent: "Reviewer 2", description: "Second opinion" }, ctx)).isError).toBe(false);
    expect(c.q.agent("Reviewer 2")!.description).toBe("Second opinion");

    expect((await callBoardTool(tools, "agents_run", { agent: "Reviewer 2" }, ctx)).text).toContain("disabled");
    expect((await callBoardTool(tools, "agents_run", { agent: "Lead" }, ctx)).text).toContain("cannot start itself");
    const issue = c.issues.createIssue({ title: "Check copy", body: "", type: "chore", priority: "low" }, "user");
    c.agents.setEnabled(created.id, true, "user");
    expect((await callBoardTool(tools, "agents_run", { agent: "Reviewer 2", issue: issue.key, note: "Second look" }, ctx)).text).toBe(`Queued "Reviewer 2" on ${issue.key}.`);
    expect(c.q.runs().find((r) => r.agentId === created.id)).toMatchObject({ trigger: "manual", context: "Second look", issueId: issue.id });
    expect((await callBoardTool(tools, "agents_list", {}, ctx)).text).toContain(`"Reviewer 2" (private): Second opinion [triggers: assigned`);
    c.stop();
    c.db.close();
  });
});
