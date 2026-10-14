import { afterEach, describe, expect, it } from "vitest";
import { callBoardTool, boardTools } from "../src/agents/board-tools";
import type { LinearIssue, LinearState } from "../src/integrations/linear/api";
import { categoryOf, stateFor } from "../src/integrations/linear/sync";
import { linearTools } from "../src/integrations/linear/tools";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./helpers/temp-dir";

const STATES: LinearState[] = [
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "s-prog", name: "In Progress", type: "started", position: 2 },
  { id: "s-rev", name: "In Review", type: "started", position: 3 },
  { id: "s-done", name: "Done", type: "completed", position: 4 },
  { id: "s-cancel", name: "Canceled", type: "canceled", position: 5 },
];

/** Linear's GraphQL API, reduced to the queries Cadence sends. */
class FakeLinear {
  issues: LinearIssue[] = [];
  comments: { issueId: string; body: string }[] = [];
  stateChanges: { id: string; stateId: string }[] = [];
  queries: string[] = [];
  private clock = Date.parse("2026-10-01T00:00:00Z");

  add(identifier: string, title: string, stateId = "s-todo", priority = 2): LinearIssue {
    const state = STATES.find((s) => s.id === stateId)!;
    const issue: LinearIssue = {
      id: `uuid-${identifier}`,
      identifier,
      title,
      description: `Body of ${identifier}`,
      url: `https://linear.app/acme/issue/${identifier}/slug`,
      priority,
      updatedAt: this.tick(),
      state: { id: state.id, name: state.name, type: state.type },
      team: { id: "team-1", key: "ENG" },
    };
    this.issues.push(issue);
    return issue;
  }

  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  move(identifier: string, stateId: string): void {
    const issue = this.issues.find((i) => i.identifier === identifier)!;
    const s = STATES.find((x) => x.id === stateId)!;
    issue.state = { id: s.id, name: s.name, type: s.type };
    issue.updatedAt = this.tick();
  }

  fetch: typeof fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(String(init!.body)) as { query: string; variables: Record<string, any> };
    this.queries.push(query.trim().split(/[({]/)[0]!.trim() + " " + (query.match(/\b(viewer|teams|issues|issue|searchIssues|workflowStates|commentCreate|issueUpdate)\b/)?.[1] ?? ""));
    const data = (d: unknown) => new Response(JSON.stringify({ data: d }));
    if (query.includes("viewer")) return data({ viewer: { name: "Dana", organization: { name: "Acme" } } });
    if (query.includes("teams(")) return data({ teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } });
    if (query.includes("workflowStates")) return data({ workflowStates: { nodes: STATES } });
    if (query.includes("commentCreate")) {
      this.comments.push(variables.input);
      return data({ commentCreate: { success: true } });
    }
    if (query.includes("issueUpdate")) {
      this.stateChanges.push({ id: variables.id, stateId: variables.input.stateId });
      const issue = this.issues.find((i) => i.id === variables.id)!;
      const s = STATES.find((x) => x.id === variables.input.stateId)!;
      issue.state = { id: s.id, name: s.name, type: s.type };
      issue.updatedAt = this.tick();
      return data({ issueUpdate: { success: true } });
    }
    if (query.includes("searchIssues")) return data({ searchIssues: { nodes: this.issues.filter((i) => i.title.toLowerCase().includes(String(variables.term).toLowerCase())) } });
    if (query.includes("issue(id")) {
      const issue = this.issues.find((i) => i.identifier === variables.id || i.id === variables.id);
      return issue ? data({ issue: { ...issue, comments: { nodes: [{ body: "Seen on prod", createdAt: issue.updatedAt, user: { name: "Sam" } }] } } }) : new Response(JSON.stringify({ errors: [{ message: "Entity not found" }] }));
    }
    if (query.includes("issues(")) {
      const f = variables.filter as { updatedAt?: { gt: string }; state?: { type: { nin: string[] } } };
      const nodes = this.issues.filter((i) => (f.updatedAt ? i.updatedAt > f.updatedAt.gt : !f.state!.type.nin.includes(i.state.type)));
      return data({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    return new Response(JSON.stringify({ errors: [{ message: "unhandled" }] }));
  };
}

describe("Linear", () => {
  let dir: string;
  let c: Container | null = null;
  let linear: FakeLinear;

  const boot = async (writeBack = false) => {
    dir = mkdtempSync(join(tmpdir(), "cadence-linear-"));
    linear = new FakeLinear();
    c = createContainer({ dataDir: dir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm, fetchImpl: linear.fetch });
    await c!.linear.connect("lin_api_test");
    c!.linear.configure({ teamIds: ["team-1"], writeBack });
    c!.linear.start(60_000);
    await c!.linear.sync(); // let the startup pull finish
  };

  afterEach(() => {
    if (!c) return;
    c.stop();
    c.db.close();
    c = null;
    removeTempDir(dir);
  });

  it("maps Linear states to stage categories and back", () => {
    expect(categoryOf({ type: "started", name: "In Review" })).toBe("in_review");
    expect(categoryOf({ type: "backlog", name: "Backlog" })).toBe("triage");
    expect(stateFor("in_review", STATES)?.id).toBe("s-rev");
    expect(stateFor("in_progress", STATES)?.id).toBe("s-prog");
    expect(stateFor("triage", STATES)?.id).toBe("s-todo");
  });

  it("imports open issues from chosen teams, then follows their changes", async () => {
    await boot();
    linear.add("ENG-1", "Login fails on Safari", "s-todo", 1);
    linear.add("ENG-2", "Already shipped", "s-done");
    expect(await c!.linear.sync()).toBe(1);
    const issue = c!.q.issues().find((i) => i.title === "Login fails on Safari")!;
    expect(issue).toMatchObject({ priority: "urgent", body: "Body of ENG-1" });
    expect(c!.q.stage(issue.stageId)!.category).toBe("triage");
    expect(issue.links).toEqual([expect.objectContaining({ kind: "linear", ref: "https://linear.app/acme/issue/ENG-1/slug", title: "ENG-1" })]);

    // Re-syncing with nothing new creates nothing.
    expect(await c!.linear.sync()).toBe(0);
    linear.move("ENG-1", "s-rev");
    linear.issues[0]!.title = "Login fails on Safari 17";
    await c!.linear.sync();
    const updated = c!.q.issue(issue.id)!;
    expect(updated.title).toBe("Login fails on Safari 17");
    expect(c!.q.stage(updated.stageId)!.category).toBe("in_review");
    expect(c!.q.issues()).toHaveLength(1);
    expect(c!.linear.status()).toMatchObject({ connected: true, organization: "Acme", lastError: null });
  });

  it("writes moves and comments back to Linear only when enabled, and never echoes its own changes", async () => {
    await boot(true);
    linear.add("ENG-7", "Export to CSV");
    await c!.linear.sync();
    const issue = c!.q.issues()[0]!;
    const inProgress = c!.q.stages().find((s) => s.category === "in_progress")!;
    c!.issues.moveIssue(issue.id, inProgress.id, "user");
    c!.issues.comment(issue.id, "Picked this up.", "user");
    await c!.linear.idle();
    expect(linear.stateChanges).toEqual([{ id: "uuid-ENG-7", stateId: "s-prog" }]);
    expect(linear.comments).toEqual([{ issueId: "uuid-ENG-7", body: "Picked this up.\n\n_A teammate via Cadence_" }]);

    // The next pull sees Linear in the matching state and changes nothing in Cadence or Linear.
    await c!.linear.sync();
    await c!.linear.idle();
    expect(linear.stateChanges).toHaveLength(1);
    expect(c!.q.issue(issue.id)!.stageId).toBe(inProgress.id);

    c!.linear.configure({ writeBack: false });
    c!.issues.comment(issue.id, "Not mirrored.", "user");
    await c!.linear.idle();
    expect(linear.comments).toHaveLength(1);
  });

  it("gives agents Linear read tools, and write tools only with write-back", async () => {
    await boot(false);
    linear.add("ENG-3", "Slow dashboard");
    await c!.linear.sync();
    const ctx = { actor: "agent:a" as const, runId: null, issueId: null };
    let tools = boardTools({ q: c!.q, issues: c!.issues, docs: c!.docs, extra: linearTools(c!.linear) });
    expect(tools.map((t) => t.name).filter((n) => n.startsWith("linear_"))).toEqual(["linear_search", "linear_get"]);
    const found = await callBoardTool(tools, "linear_search", { query: "dashboard" }, ctx);
    expect(found.text).toMatch(/ENG-3 \[Todo\] Slow dashboard .* · Cadence CAD-\d+/);
    expect((await callBoardTool(tools, "linear_get", { issue: "ENG-3" }, ctx)).text).toContain("- Sam: Seen on prod");

    c!.linear.configure({ writeBack: true });
    tools = boardTools({ q: c!.q, issues: c!.issues, docs: c!.docs, extra: linearTools(c!.linear) });
    expect((await callBoardTool(tools, "linear_set_state", { issue: "ENG-3", state: "in review" }, ctx)).text).toBe("ENG-3 is now In Review.");
    expect((await callBoardTool(tools, "linear_set_state", { issue: "ENG-3", state: "Shipped" }, ctx)).text).toContain("States: Backlog, Todo");
  });

  it("refuses keys that are not Linear API keys", async () => {
    await boot();
    await expect(c!.linear.connect("sk-something")).rejects.toThrow(/lin_api_/);
  });
});
