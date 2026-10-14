import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubEventName, verifyGithubSignature } from "../src/runner/triggers";
import { makeContainer, stageId } from "./helpers/setup";

// Trigger matching only: the queue is not started, so runs stay queued.
describe("triggers", () => {
  const setup = () => {
    const { c } = makeContainer();
    c.triggers.start();
    return c;
  };

  it("queues a run when an enabled agent is assigned, and not for disabled agents", () => {
    const c = setup();
    const builder = c.agents.createAgent({ name: "Builder", prompt: "x", enabled: true });
    const idle = c.agents.createAgent({ name: "Idle", prompt: "x", enabled: false });
    const issue = c.issues.createIssue({ title: "Feature" });
    c.issues.setAssignee(issue.id, { kind: "agent", id: builder.id }, true);
    c.issues.setAssignee(issue.id, { kind: "agent", id: idle.id }, true);
    const runs = c.q.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: builder.id, issueId: issue.id, trigger: "assigned", status: "queued" });
    expect(runs[0]!.context).toContain("a teammate assigned you to CAD-1");
  });

  it("never triggers an agent from its own actions", () => {
    const c = setup();
    const agent = c.agents.createAgent({ name: "Self", prompt: "x", enabled: true, triggers: [{ kind: "assigned" }, { kind: "issue_created", stageIds: [], types: [] }] });
    const issue = c.issues.createIssue({ title: "x" }, `agent:${agent.id}`);
    c.issues.setAssignee(issue.id, { kind: "agent", id: agent.id }, true, `agent:${agent.id}`);
    expect(c.q.runs()).toHaveLength(0);
  });

  it("matches issue-created filters, stage moves, labels, and human comments", () => {
    const c = setup();
    const bugs = c.agents.createAgent({ name: "Bugs", prompt: "x", enabled: true, triggers: [{ kind: "issue_created", stageIds: [], types: ["bug"] }] });
    const mover = c.agents.createAgent({ name: "Mover", prompt: "x", enabled: true, triggers: [{ kind: "issue_moved", toStageIds: [stageId(c, "Ready to Build")] }] });
    const labeler = c.agents.createAgent({ name: "Labeler", prompt: "x", enabled: true, triggers: [{ kind: "label_added", labelIds: [c.q.label("Needs a product call")!.id] }] });
    const listener = c.agents.createAgent({ name: "Listener", prompt: "x", enabled: true, triggers: [{ kind: "issue_commented" }] });

    c.issues.createIssue({ title: "feature" });
    const bug = c.issues.createIssue({ title: "bug", type: "bug" });
    c.issues.moveIssue(bug.id, "Backlog");
    c.issues.moveIssue(bug.id, "Ready to Build");
    c.issues.setLabel(bug.id, "Needs a product call", true);
    c.issues.comment(bug.id, "from a person");
    c.issues.comment(bug.id, "from an agent", `agent:${bugs.id}`);

    const by = (id: string) => c.q.runs().filter((r) => r.agentId === id);
    expect(by(bugs.id)).toHaveLength(1);
    expect(by(mover.id)[0]!.context).toContain('moved CAD-2 to "Ready to Build"');
    expect(by(labeler.id)).toHaveLength(1);
    expect(by(listener.id)).toHaveLength(1);
  });

  it("folds repeat triggers into the already-queued run", () => {
    const c = setup();
    const agent = c.agents.createAgent({ name: "Listener", prompt: "x", enabled: true, triggers: [{ kind: "issue_commented" }] });
    const issue = c.issues.createIssue({ title: "x" });
    c.issues.comment(issue.id, "one");
    c.issues.comment(issue.id, "two");
    const runs = c.q.runs().filter((r) => r.agentId === agent.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.context).toContain("one");
    expect(runs[0]!.context).toContain("two");
  });

  it("accepts webhooks only with the right secret", () => {
    const c = setup();
    const agent = c.agents.createAgent({ name: "Hook", prompt: "x", enabled: true, triggers: [{ kind: "webhook", secret: "" }] });
    const secret = (agent.triggers[0] as { secret: string }).secret;
    expect(secret.length).toBeGreaterThan(20);
    expect(() => c.triggers.fireWebhook(agent.id, "wrong", { a: 1 })).toThrow();
    const runId = c.triggers.fireWebhook(agent.id, secret, { message: "Export is broken" })!;
    expect(c.q.run(runId)!.context).toContain("Export is broken");
  });

  it("verifies GitHub signatures and maps merged PRs to their issue", () => {
    const c = setup();
    const agent = c.agents.createAgent({ name: "Sync", prompt: "x", enabled: true, triggers: [{ kind: "github", events: ["pr_merged"], secret: "s3cret" }] });
    const issue = c.issues.createIssue({ title: "x" });
    c.issues.addLink(issue.id, { kind: "pr", ref: "https://github.com/o/r/pull/7" });

    const body = Buffer.from('{"action":"closed"}');
    const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifyGithubSignature("s3cret", body, sig)).toBe(true);
    expect(verifyGithubSignature("s3cret", body, "sha256=00")).toBe(false);

    expect(githubEventName("pull_request", { action: "closed", pull_request: { merged: false } })).toBeNull();
    const runId = c.triggers.fireGithub(agent.id, "pull_request", { action: "closed", pull_request: { merged: true, html_url: "https://github.com/o/r/pull/7", title: "Fix", head: { ref: "b" } } });
    expect(c.q.run(runId!)).toMatchObject({ issueId: issue.id, trigger: "github" });
  });
});

describe("release and author-filtered GitHub triggers, and bot messages from Slack", () => {
  it("fires on a published release, and only for the listed authors", () => {
    const { c } = makeContainer();
    const notes = c.agents.createAgent({ name: "Release notes", prompt: "x", enabled: true, triggers: [{ kind: "github", events: ["release_published"], secret: "s" }] });
    const deps = c.agents.createAgent({ name: "Dep bot reviewer", prompt: "x", enabled: true, triggers: [{ kind: "github", events: ["pr_opened"], secret: "s", authors: ["dependabot[bot]"] }] });
    expect(githubEventName("release", { action: "published" })).toBe("release_published");
    expect(githubEventName("release", { action: "created" })).toBeNull();
    const runId = c.triggers.fireGithub(notes.id, "release", { action: "published", release: { name: "v2.0", tag_name: "v2.0.0", html_url: "https://github.com/o/r/releases/v2.0.0", body: "Big release", author: { login: "ada" } } });
    expect(c.q.run(runId!)!.context).toMatch(/release published[\s\S]*v2\.0 \(v2\.0\.0\)[\s\S]*By: ada[\s\S]*Big release/);
    const pr = (login: string) => ({ action: "opened", pull_request: { html_url: `https://github.com/o/r/pull/${login.length}`, title: "Bump", head: { ref: "x" }, user: { login } } });
    expect(c.triggers.fireGithub(deps.id, "pull_request", pr("ada"))).toBeNull();
    expect(c.triggers.fireGithub(deps.id, "pull_request", pr("Dependabot[bot]"))).toBeTruthy();
  });

  it("passes other bots' messages only to triggers that include bots, and never Cadence's own", () => {
    const { c } = makeContainer();
    const withBots = c.agents.createAgent({ name: "Alerts", prompt: "x", enabled: true, triggers: [{ kind: "slack", events: ["message"], channelIds: [], emoji: [], includeBots: true }] });
    c.agents.createAgent({ name: "Humans only", prompt: "x", enabled: true, triggers: [{ kind: "slack", events: ["message"], channelIds: [], emoji: [] }] });
    const msg = c.slack.normalize({ event: { type: "message", channel: "C1", ts: "1.1", bot_id: "B9", subtype: "bot_message", text: "Deploy failed" } } as never)!;
    expect(msg).toMatchObject({ kind: "message", bot: true, user: "B9" });
    const ids = c.triggers.fireSlack(msg, "ctx", "slack:C1:1.1");
    expect(ids.map((id) => c.q.run(id)!.agentId)).toEqual([withBots.id]);
    // Edits and joins are still ignored.
    expect(c.slack.normalize({ event: { type: "message", channel: "C1", ts: "1.2", subtype: "message_changed" } } as never)).toBeNull();
  });
});
