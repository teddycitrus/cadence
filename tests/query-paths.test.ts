import { describe, expect, it } from "vitest";
import { MAX_RUN_CONTEXT, mergeContext } from "../src/core/agent-commands";
import { makeContainer } from "./helpers/setup";
import { bootTeam } from "./helpers/team";

// The indexed lookups must answer exactly what the old full scans did.
describe("indexed query paths", () => {
  it("finds an issue by its key in any case, and by id", () => {
    const { c } = makeContainer();
    const issue = c.issues.createIssue({ title: "Find me" });
    expect(c.q.issue(issue.key.toLowerCase())?.id).toBe(issue.id);
    expect(c.q.issue(issue.key)?.id).toBe(issue.id);
    expect(c.q.issue(issue.id)?.id).toBe(issue.id);
    expect(c.q.issue("NOPE-999")).toBeNull();
  });

  it("merges a repeat trigger into the agent's queued run for the same issue or thread, and only that one", () => {
    const { c } = makeContainer();
    const a = c.agents.createAgent({ name: "A", prompt: "x", enabled: true, triggers: [] });
    const b = c.agents.createAgent({ name: "B", prompt: "x", enabled: true, triggers: [] });
    const issue = c.issues.createIssue({ title: "x" });
    const first = c.agents.queueRun({ agentId: a.id, issueId: issue.id, trigger: "manual", context: "one" })!;
    expect(c.agents.queueRun({ agentId: a.id, issueId: issue.id, trigger: "manual", context: "two" })).toBe(first);
    expect(c.q.run(first)!.context).toBe("one\n\ntwo");
    expect(c.agents.queueRun({ agentId: b.id, issueId: issue.id, trigger: "manual", context: "other agent" })).not.toBe(first);
    const thread = c.agents.queueRun({ agentId: a.id, issueId: null, trigger: "slack", context: "t1", threadKey: "slack:C1:1.0" })!;
    expect(c.agents.queueRun({ agentId: a.id, issueId: null, trigger: "slack", context: "t2", threadKey: "slack:C1:1.0" })).toBe(thread);
    expect(c.agents.queueRun({ agentId: a.id, issueId: null, trigger: "slack", context: "t3", threadKey: "slack:C1:2.0" })).not.toBe(thread);
    // Without an issue or a thread there is nothing to merge into.
    expect(c.agents.queueRun({ agentId: a.id, issueId: null, trigger: "manual", context: "free" })).not.toBe(thread);
    expect(c.q.activeRuns().map((r) => r.status).every((s) => s === "queued")).toBe(true);
    expect(c.q.activeRuns()).toHaveLength(5);
  });

  it("keeps the newest context when triggers pile onto a queued run", () => {
    const merged = mergeContext("old ".repeat(8000), "NEWEST");
    expect(merged.length).toBe(MAX_RUN_CONTEXT);
    expect(merged.startsWith("(Earlier triggers were trimmed")).toBe(true);
    expect(merged.endsWith("NEWEST")).toBe(true);
    expect(mergeContext("a", "b")).toBe("a\n\nb");
  });

  it("sends only a preview of long run contexts in the snapshot; the run itself keeps all of it", async () => {
    const team = await bootTeam();
    try {
      const agent = team.c.agents.createAgent({ name: "Ctx", prompt: "x", enabled: true, triggers: [] });
      const id = team.c.agents.queueRun({ agentId: agent.id, issueId: null, trigger: "manual", context: "c".repeat(5000) })!;
      const snap = await team.local("GET", "/snapshot");
      const listed = (snap.json.runs as { id: string; context: string }[]).find((r) => r.id === id)!;
      expect(listed.context.length).toBeLessThan(300);
      expect((await team.local("GET", `/runs/${id}`)).json.context).toHaveLength(5000);
      // Chats in the snapshot leave out their command lists; the chat itself has them.
      const ws = await team.c.workspaces.createInProject(null, "Cmds", "user");
      const chat = team.c.engine.createChat({ workspaceId: ws.id });
      team.c.store.append({ aggregate: "chat", type: "ChatSessionStarted", aggregateId: chat.id, payload: { sessionId: "s1", slashCommands: ["review"], commandHints: { review: "Review a pull request" } } }, "system");
      const listedChat = ((await team.local("GET", "/snapshot")).json.chats as { id: string; slashCommands: string[]; commandHints?: unknown }[]).find((x) => x.id === chat.id)!;
      expect(listedChat.slashCommands).toEqual([]);
      expect(listedChat.commandHints).toBeUndefined();
      expect((await team.local("GET", `/chats/${chat.id}`)).json.chat).toMatchObject({ slashCommands: ["review"], commandHints: { review: "Review a pull request" } });
    } finally {
      team.close();
    }
  });
});
