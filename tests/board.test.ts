import { describe, expect, it } from "vitest";
import { GateError, ValidationError } from "../src/core/errors";
import { makeContainer, stageId } from "./helpers/setup";

describe("board", () => {
  it("seeds the default workflow once", () => {
    const { c } = makeContainer();
    const names = c.q.stages().map((s) => s.name);
    expect(names.slice(0, 5)).toEqual(["Ideas", "Shaping", "Plan & Sketch", "Design Pass", "Ready to Build"]);
    expect(c.q.stages().filter((s) => s.humanGate).map((s) => s.name)).toEqual(["Shaping", "Plan & Sketch", "Design Pass", "Code Review"]);
    c.issues.seedDefaults();
    expect(c.q.stages()).toHaveLength(names.length);
  });

  it("numbers issues sequentially and never reuses a deleted key", () => {
    const { c } = makeContainer();
    const a = c.issues.createIssue({ title: "A" });
    c.issues.deleteIssue(a.id);
    expect(c.issues.createIssue({ title: "B" }).key).toBe("CAD-2");
  });

  it("stops agents, but not people, from moving cards out of a sign-off stage", () => {
    const { c } = makeContainer();
    const agent = c.agents.createAgent({ name: "Scoper", prompt: "x" });
    const issue = c.issues.createIssue({ title: "Idea", stageId: stageId(c, "Shaping") });
    expect(() => c.issues.moveIssue(issue.id, "Plan & Sketch", `agent:${agent.id}`)).toThrow(GateError);
    c.issues.moveIssue(issue.id, "Plan & Sketch", "user");
    expect(c.q.issue(issue.id)?.stageId).toBe(stageId(c, "Plan & Sketch"));
    // Agents may move cards into a gate, just not out of one.
    const other = c.issues.createIssue({ title: "Bug", stageId: stageId(c, "Building") });
    c.issues.moveIssue(other.id, "Code Review", `agent:${agent.id}`);
  });

  it("reorders, edits, and deletes stages, moving their issues", () => {
    const { c } = makeContainer();
    const stages = c.q.stages();
    c.issues.reorderStages([...stages].reverse().map((s) => s.id));
    expect(c.q.stages()[0]!.name).toBe(stages.at(-1)!.name);
    expect(() => c.issues.reorderStages([stages[0]!.id])).toThrow(ValidationError);

    const issue = c.issues.createIssue({ title: "x", stageId: stageId(c, "QA") });
    c.issues.deleteStage(stageId(c, "QA"), stageId(c, "Code Review"));
    expect(c.q.stage("QA")).toBeNull();
    expect(c.q.issue(issue.id)?.stageId).toBe(stageId(c, "Code Review"));
  });

  it("tracks labels, assignees, comments, links, and docs on an issue", () => {
    const { c } = makeContainer();
    const agent = c.agents.createAgent({ name: "Builder", prompt: "x" });
    const issue = c.issues.createIssue({ title: "Export", labelIds: ["From a customer"] });
    c.issues.setAssignee(issue.id, { kind: "agent", id: "Builder" }, true);
    c.issues.setAssignee(issue.id, { kind: "user", id: "me" }, true);
    c.issues.comment(issue.id, "Looks good");
    const docId = c.docs.create({ title: "PRD", body: "# PRD", issueId: issue.key }).id;
    const got = c.q.issue(issue.id)!;
    expect(got.assignees).toEqual([{ kind: "agent", id: agent.id }, { kind: "user", id: "me" }]);
    expect(got.links).toEqual([expect.objectContaining({ kind: "doc", ref: docId })]);
    expect(c.q.comments(issue.id)[0]).toMatchObject({ body: "Looks good", author: "user" });
    expect(c.q.docsForIssue(issue.id)).toHaveLength(1);
  });

  it("rebuilds identical read models from the event log", () => {
    const { c } = makeContainer();
    c.agents.createAgent({ name: "A", prompt: "p", triggers: [{ kind: "webhook", secret: "" }] });
    const issue = c.issues.createIssue({ title: "T", body: "b", labelIds: ["Suggested by an agent"] });
    c.issues.moveIssue(issue.id, "Ready to Build");
    c.issues.comment(issue.id, "hi");
    c.docs.create({ title: "Doc", issueId: issue.id });
    c.agents.updateSettings({ concurrency: 7 });
    const snap = () => ({ stages: c.q.stages(), issues: c.q.issues(), agents: c.q.agents(), docs: c.q.docs(), comments: c.q.comments(issue.id), settings: c.q.settings() });
    const before = snap();
    expect(c.store.rebuild()).toBe(c.store.count());
    expect(snap()).toEqual(before);
  });
});
