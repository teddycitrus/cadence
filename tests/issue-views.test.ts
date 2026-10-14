import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY, DEFAULT_FILTERS, groupIssues, isAwaiting, isUnread, matches, orderIssues, type FilterContext } from "../src/core/issue-views";
import type { Issue, Stage } from "../src/core/types";
import { isTimeZone, nextRun } from "../src/runner/scheduler";
import { bootTeam } from "./helpers/team";

const issue = (over: Partial<Issue>): Issue => ({ id: "i", key: "CAD-1", title: "t", body: "", type: "feature", priority: "none", estimate: null, stageId: "s1", labelIds: [], assignees: [], projectId: null, branch: null, worktreePath: null, links: [], createdBy: "user", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...over });
const ctx: FilterContext = { viewerId: "me", runs: [{ issueId: "b", status: "running", chatId: null }], pending: [{ chatId: "chat-c", kind: "question" }], issueChats: (i) => (i.id === "c" ? ["chat-c"] : []) };

describe("board views", () => {
  const a = issue({ id: "a", key: "CAD-1", title: "Login breaks", type: "bug", priority: "urgent", labelIds: ["l1"], assignees: [{ kind: "user", id: "me" }], updatedAt: "2026-10-03T00:00:00Z" });
  const b = issue({ id: "b", key: "CAD-2", title: "Dark mode", priority: "low", projectId: "p1", assignees: [{ kind: "agent", id: "ag" }], stageId: "s2", createdAt: "2026-10-02T00:00:00Z" });
  const c = issue({ id: "c", key: "CAD-3", title: "Billing page", priority: "high" });

  it("filters by scope, text, and properties", () => {
    const pick = (f: Partial<typeof DEFAULT_FILTERS>) => [a, b, c].filter((i) => matches(i, { ...DEFAULT_FILTERS, ...f }, ctx)).map((i) => i.id);
    expect(pick({})).toEqual(["a", "b", "c"]);
    expect(pick({ scope: "mine" })).toEqual(["a"]);
    expect(pick({ scope: "agents" })).toEqual(["b"]);
    expect(pick({ scope: "active" })).toEqual(["b"]);
    expect(pick({ scope: "awaiting" })).toEqual(["c"]);
    expect(pick({ query: "cad-2" })).toEqual(["b"]);
    expect(pick({ priorities: ["urgent", "high"] })).toEqual(["a", "c"]);
    expect(pick({ types: ["bug"] })).toEqual(["a"]);
    expect(pick({ labelIds: ["l1"] })).toEqual(["a"]);
    expect(pick({ assigneeIds: ["none"] })).toEqual(["c"]);
    expect(pick({ assigneeIds: ["ag", "me"] })).toEqual(["a", "b"]);
    expect(pick({ projectIds: ["none"] })).toEqual(["a", "c"]);
    expect(isAwaiting(c, ctx)).toBe(true);
  });

  it("orders and groups", () => {
    expect(orderIssues([a, b, c], "priority").map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(orderIssues([a, b, c], "updated")[0]!.id).toBe("a");
    expect(orderIssues([a, b, c], "created")[0]!.id).toBe("b");
    expect(orderIssues([a, b, c], "title").map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(orderIssues([c, a], "manual").map((i) => i.id)).toEqual(["c", "a"]);
    const stages = [{ id: "s2", name: "Done", position: 2 }, { id: "s1", name: "Ideas", position: 1 }] as Stage[];
    const names = { stages, member: () => "Me", agent: () => "Bot", project: () => "Web" };
    expect(groupIssues([a, b, c], "stage", names).map((g) => [g.label, g.issues.length])).toEqual([["Ideas", 2], ["Done", 1]]);
    expect(groupIssues([a, b, c], "priority", names).map((g) => g.label)).toEqual(["Urgent", "High", "Low"]);
    expect(groupIssues([a, b, c], "assignee", names).map((g) => g.label)).toEqual(["Bot", "Me", "Unassigned"]);
    expect(groupIssues([a, b, c], "project", names).map((g) => g.label)).toEqual(["Web", "No project"]);
    expect(groupIssues([a, b, c], "none", names)).toHaveLength(1);
  });

  describe("over the API", () => {
    let close = () => {};
    afterEach(() => close());

    it("saves private and shared views, and only owners or admins change them", async () => {
      const team = await bootTeam();
      close = team.close;
      const view = { name: "Urgent bugs", shared: false, filters: { ...DEFAULT_FILTERS, priorities: ["urgent"], types: ["bug"] }, display: { ...DEFAULT_DISPLAY, layout: "list" } };
      const mine = await team.local("POST", "/board/views", view);
      expect(mine.status).toBe(201);
      const shared = await team.local("POST", "/board/views", { ...view, name: "Team board", shared: true });
      expect((await team.local("POST", "/board/views", { ...view, display: { ...view.display, groupBy: "color" } })).status).toBe(400);

      const member = await team.join("member", "Mo");
      const theirs = (await member.call("GET", "/snapshot")).json.issueViews.map((v: { name: string }) => v.name);
      expect(theirs).toEqual(["Team board"]);
      expect((await member.call("PUT", `/board/views/${shared.json.id}`, { ...view, name: "Mine now", shared: true })).status).toBe(403);
      expect((await member.call("DELETE", `/board/views/${mine.json.id}`)).status).toBe(404);
      const own = await member.call("POST", "/board/views", { ...view, name: "Mo's" });
      expect((await member.call("PUT", `/board/views/${own.json.id}`, { ...view, name: "Mo's bugs" })).json.name).toBe("Mo's bugs");

      expect((await team.local("PUT", `/board/views/${shared.json.id}`, { ...view, name: "Team board v2", shared: true })).json).toMatchObject({ name: "Team board v2", shared: true });
      expect((await team.local("DELETE", `/board/views/${mine.json.id}`)).status).toBe(200);
      expect((await team.local("GET", "/snapshot")).json.issueViews.map((v: { name: string }) => v.name)).toEqual(["Team board v2"]);
    });

    it("duplicates issues, tracks what each person has read, and stars views", async () => {
      const team = await bootTeam();
      close = team.close;
      const member = await team.join("member", "Mo");
      const label = team.c.issues.createLabel({ name: "ux", color: "#0af" });
      const issue = team.c.issues.createIssue({ title: "Polish header", body: "Spacing", type: "improvement", priority: "high", labelIds: [label] }, `member:${member.id}`);
      const copy = (await team.local("POST", `/issues/${issue.id}/duplicate`)).json;
      expect(copy).toMatchObject({ title: "Polish header (copy)", body: "Spacing", type: "improvement", priority: "high", labelIds: [label], assignees: [] });
      expect(copy.key).not.toBe(issue.key);

      // The owner comments on Mo's issue: unread for Mo until Mo opens it.
      await team.local("POST", `/issues/${issue.id}/comments`, { body: "Looks off on mobile" });
      const seen = () => member.call("GET", "/snapshot").then((r) => r.json as { issues: Issue[]; issueReads: Record<string, string> });
      let snap = await seen();
      let mine = snap.issues.find((i) => i.id === issue.id)!;
      expect(isUnread(mine, member.id, snap.issueReads[issue.id])).toBe(true);
      await member.call("POST", `/issues/${issue.id}/read`);
      snap = await seen();
      mine = snap.issues.find((i) => i.id === issue.id)!;
      expect(isUnread(mine, member.id, snap.issueReads[issue.id])).toBe(false);
      // Reading again with nothing new records nothing.
      const before = team.c.store.count();
      await member.call("POST", `/issues/${issue.id}/read`);
      expect(team.c.store.count()).toBe(before);
      // Mo's own changes never make it unread for Mo.
      await member.call("POST", `/issues/${issue.id}/comments`, { body: "On it" });
      snap = await seen();
      expect(isUnread(snap.issues.find((i) => i.id === issue.id)!, member.id, snap.issueReads[issue.id])).toBe(false);

      const view = await member.call("POST", "/board/views", { name: "Mine", shared: false, filters: DEFAULT_FILTERS, display: DEFAULT_DISPLAY });
      expect((await member.call("PUT", `/board/views/${view.json.id}/favorite`, { on: true })).json).toEqual({ favoriteViews: [view.json.id] });
      expect((await member.call("GET", "/snapshot")).json.members.find((m: { id: string }) => m.id === member.id).favoriteViews).toEqual([view.json.id]);
      expect((await team.local("PUT", `/board/views/${view.json.id}/favorite`, { on: true })).status).toBe(404);
    });

    it("gives each admin one board assistant chat, and none to members", async () => {
      const team = await bootTeam();
      close = team.close;
      const first = await team.local("POST", "/board/assistant");
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ title: "Board assistant", mode: "acceptEdits" });
      expect((await team.local("POST", "/board/assistant")).json.id).toBe(first.json.id);
      const member = await team.join("member", "Mo");
      expect((await member.call("POST", "/board/assistant")).status).toBe(403);
    });
  });
});

describe("schedule time zones", () => {
  it("validates zones and computes the next run in the chosen one", () => {
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    const tokyo = nextRun("0 9 * * *", "Asia/Tokyo")!;
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(tokyo)).toBe("09");
    const ny = nextRun("0 9 * * *", "America/New_York")!;
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(ny)).toBe("09");
  });
});
