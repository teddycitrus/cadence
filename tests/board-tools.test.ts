import { describe, expect, it } from "vitest";
import { boardTools, callBoardTool } from "../src/agents/board-tools";
import { makeContainer } from "./helpers/setup";

describe("board tools", () => {
  const setup = () => {
    const { c } = makeContainer();
    const agent = c.agents.createAgent({ name: "Triage", prompt: "x", description: "Files issues" });
    c.agents.createAgent({ name: "Bug Squasher", prompt: "x", description: "Fixes bugs" });
    const tools = boardTools({ q: c.q, issues: c.issues, docs: c.docs });
    const ctx = { actor: `agent:${agent.id}` as const, runId: null, issueId: null };
    const call = (name: string, input: Record<string, unknown> = {}) => callBoardTool(tools, name, input, ctx);
    return { c, call };
  };

  it("describes the board, including gates and teammates", async () => {
    const { call } = setup();
    const { text } = await call("board_overview");
    expect(text).toContain("Shaping (id");
    expect(text).toContain("SIGN-OFF STAGE");
    expect(text).toContain('agent "Bug Squasher"');
  });

  it("creates, finds, updates, labels, assigns, and comments as the agent", async () => {
    const { c, call } = setup();
    expect((await call("issues_create", { title: "Login fails on Safari", body: "From support", type: "bug", priority: "high", labels: ["From a customer"], assignees: ["Bug Squasher"] })).text).toBe("Created CAD-1.");
    expect((await call("issues_list", { query: "safari" })).text).toContain("CAD-1 [Ideas] Login fails on Safari");
    expect((await call("issues_list", { assignee: "Bug Squasher" })).text).toContain("CAD-1");
    await call("issues_update", { issue: "CAD-1", estimate: 3 });
    await call("issues_move", { issue: "CAD-1", stage: "ready to build" });
    await call("issues_comment", { issue: "CAD-1", body: "Routed to bug lane." });
    const issue = c.q.issue("CAD-1")!;
    expect(issue).toMatchObject({ estimate: 3, createdBy: expect.stringMatching(/^agent:/) });
    expect(c.q.stage(issue.stageId)?.name).toBe("Ready to Build");
    expect((await call("issues_get", { issue: "CAD-1" })).text).toContain("Routed to bug lane.");
  });

  it("reports gate violations and bad input as tool errors instead of throwing", async () => {
    const { c, call } = setup();
    c.issues.createIssue({ title: "x", stageId: c.q.stage("Shaping")!.id });
    expect(await call("issues_move", { issue: "CAD-1", stage: "Ready to Build" })).toMatchObject({ isError: true, text: expect.stringContaining("sign-off stage") });
    expect(await call("issues_create", { title: "" })).toMatchObject({ isError: true });
    expect(await call("issues_assign", { issue: "CAD-1", assignee: "Nobody", add: true })).toMatchObject({ isError: true });
  });

  it("writes docs linked to issues", async () => {
    const { c, call } = setup();
    c.issues.createIssue({ title: "Quiet hours" });
    const created = await call("docs_create", { title: "Quiet hours PRD", body: "## Problem", issue: "CAD-1" });
    const docId = created.text.match(/Created doc (\S+)\./)![1]!;
    await call("docs_update", { doc: docId, body: "## Problem\nUpdated" });
    expect((await call("docs_list", { issue: "CAD-1" })).text).toContain("Quiet hours PRD");
    expect((await call("docs_get", { doc: docId })).text).toContain("Updated");
  });
});
