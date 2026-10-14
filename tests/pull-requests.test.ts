import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callBoardTool, boardTools } from "../src/agents/board-tools";
import { pullRequestInsights } from "../src/git/insights";
import { createApp } from "../src/server/app";
import type { AddressInfo } from "node:net";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { createGitFixture, gitOut, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

/** An in-memory stand-in for the slice of GitHub's REST API Cadence calls. */
class FakeGitHub {
  prs: { number: number; title: string; body: string; head: string; base: string; state: "open" | "closed"; merged: boolean; draft: boolean; sha: string; created: string; mergedAt: string | null }[] = [];
  checkRuns: { name: string; status: string; conclusion: string | null; html_url: string | null }[] = [];
  reviews: { user: { login: string }; state: string }[] = [];
  calls: string[] = [];

  private raw(p: FakeGitHub["prs"][number]) {
    return {
      html_url: `https://github.com/acme/demo/pull/${p.number}`,
      number: p.number,
      title: p.title,
      state: p.state,
      merged: p.merged,
      merged_at: p.mergedAt,
      draft: p.draft,
      head: { ref: p.head, sha: p.sha },
      base: { ref: p.base },
      user: { login: "dev" },
      created_at: p.created,
    };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const path = url.pathname;
    if (path === "/user") return json({ login: "dev" });
    if (path === "/repos/acme/demo/pulls" && method === "GET") {
      const head = url.searchParams.get("head")?.split(":")[1];
      return json(this.prs.filter((p) => (!head || p.head === head) && (url.searchParams.get("state") === "all" || p.state === "open")).map((p) => this.raw(p)));
    }
    if (path === "/repos/acme/demo/pulls" && method === "POST") {
      const b = JSON.parse(String(init!.body)) as { title: string; body: string; head: string; base: string; draft: boolean };
      const pr = { number: this.prs.length + 1, title: b.title, body: b.body, head: b.head, base: b.base, state: "open" as const, merged: false, draft: b.draft, sha: "abc123", created: new Date().toISOString(), mergedAt: null };
      this.prs.push(pr);
      return json(this.raw(pr), 201);
    }
    const one = /^\/repos\/acme\/demo\/pulls\/(\d+)(\/reviews)?$/.exec(path);
    if (one) {
      const pr = this.prs.find((p) => p.number === Number(one[1]));
      if (!pr) return json({ message: "Not Found" }, 404);
      return json(one[2] ? this.reviews : this.raw(pr));
    }
    if (/\/commits\/[^/]+\/check-runs$/.test(path)) return json({ check_runs: this.checkRuns });
    if (/\/commits\/[^/]+\/status$/.test(path)) return json({ statuses: [] });
    return json({ message: `Unhandled ${method} ${path}` }, 404);
  };
}

// Real git processes and a local server; slow under a full parallel run.
describe("pull requests", { timeout: 60_000 }, () => {
  let fx: GitFixture | null = null;
  let c: Container;
  let gh: FakeGitHub;
  let runtime: FakeRuntime;

  const boot = () => {
    fx = createGitFixture();
    const bare = join(fx!.root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    gitOut(fx!.repo, "remote", "add", "origin", bare);
    gitOut(fx!.repo, "push", "-q", "-u", "origin", "main");
    gh = new FakeGitHub();
    runtime = new FakeRuntime();
    c = createContainer({ dataDir: fx!.dataDir, dbFile: ":memory:", runtime, llm: offlineLlm, fetchImpl: gh.fetch });
    c.agents.addProject({ name: "demo", path: fx!.repo, baseBranch: "main", githubRepo: "acme/demo" });
    c.github.save("test-token");
    c.start();
  };

  afterEach(() => {
    if (!fx) return;
    c.stop();
    c.db.close();
    fx.cleanup();
    fx = null;
  });

  it("opens a PR from a workspace: pushes the branch, links the PR to the issue, and tracks checks", async () => {
    boot();
    const issue = c.issues.createIssue({ title: "Fix add", body: "", type: "bug", priority: "high" }, "user");
    const ws = await c.workspaces.forIssue(issue, "user");
    gh.checkRuns = [{ name: "test", status: "in_progress", conclusion: null, html_url: null }];

    await expect(c.prs.open(ws.id, { title: "Fix add", body: "Done" }, "user")).resolves.toBeTruthy();
    // Nothing committed yet: the branch is the base, but GitHub still accepts it in this fake; a dirty tree is refused.
    writeFileSync(join(ws.path, "dirty.txt"), "x\n");
    await expect(c.prs.open(ws.id, { title: "again", body: "" }, "user")).rejects.toThrow(/Commit or stash/);

    const pr = c.q.pullRequests()[0]!;
    expect(pr).toMatchObject({ repo: "acme/demo", number: 1, issueId: issue.id, workspaceId: ws.id, checks: "pending", review: "none", state: "open" });
    expect(c.q.issue(issue.id)!.links.some((l) => l.kind === "pr" && l.ref === pr.url)).toBe(true);
    expect(gitOut(fx!.repo, "ls-remote", "--heads", "origin")).toContain(ws.branch!);
    expect(gh.prs).toHaveLength(1);
  });

  it("turns merges and reviews seen on refresh into GitHub trigger runs", async () => {
    boot();
    c.agents.createAgent({ name: "Shipper", prompt: "Ship", enabled: true, triggers: [{ kind: "github", events: ["pr_merged"], secret: "s".repeat(32) }] });
    runtime.forAgent("Shipper", async () => "Shipped");
    const issue = c.issues.createIssue({ title: "Fix add", body: "", type: "bug", priority: "high" }, "user");
    gh.prs.push({ number: 7, title: "Fix add", body: "", head: "fix", base: "main", state: "open", merged: false, draft: false, sha: "s1", created: new Date().toISOString(), mergedAt: null });

    // A PR link added to an issue (here by a person) is followed automatically.
    c.issues.addLink(issue.id, { kind: "pr", ref: "https://github.com/acme/demo/pull/7", title: "#7" }, "user");
    await until(() => c.q.pullRequest("acme/demo#7")?.refreshedAt != null);
    expect(c.q.runs().filter((r) => r.trigger === "github")).toHaveLength(0);

    gh.reviews = [{ user: { login: "rev" }, state: "APPROVED" }];
    gh.checkRuns = [{ name: "ci", status: "completed", conclusion: "success", html_url: null }];
    Object.assign(gh.prs[0]!, { state: "closed", merged: true, mergedAt: new Date().toISOString() });
    await c.prs.refreshOpen();

    const pr = c.q.pullRequest("acme/demo#7")!;
    expect(pr).toMatchObject({ merged: true, review: "approved", checks: "success", issueId: issue.id });
    const runs = c.q.runs().filter((r) => r.trigger === "github");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.issueId).toBe(issue.id);
    expect(runs[0]!.context).toContain("pr merged");
    await until(() => c.q.run(runs[0]!.id)?.status === "succeeded");

    // A second refresh with nothing new records nothing and fires nothing.
    const before = c.store.count();
    await c.prs.refresh(pr.id);
    expect(c.store.count()).toBe(before);
  });

  it("gives agents pr_open and pr_status tools scoped to their workspace", async () => {
    boot();
    const issue = c.issues.createIssue({ title: "Fix add", body: "", type: "bug", priority: "high" }, "user");
    const ws = await c.workspaces.forIssue(issue, "user");
    writeFileSync(join(ws.path, "src/math.js"), "export const add = (a, b) => a + b;\n");
    gitOut(ws.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "fix add");

    const tools = boardTools({ q: c.q, issues: c.issues, docs: c.docs, prs: c.prs });
    const ctx = { actor: "agent:x" as const, runId: null, issueId: issue.id, workspaceId: ws.id };
    const opened = await callBoardTool(tools, "pr_open", { title: "Fix add", body: "Swapped the operator." }, ctx);
    expect(opened).toMatchObject({ text: "Pull request #1 is open: https://github.com/acme/demo/pull/1", isError: false });

    gh.checkRuns = [{ name: "lint", status: "completed", conclusion: "failure", html_url: null }];
    const status = await callBoardTool(tools, "pr_status", {}, ctx);
    expect(status.text).toContain("Checks: failure (failing: lint)");
    expect((await callBoardTool(tools, "pr_open", { title: "x", body: "y" }, { ...ctx, workspaceId: null })).isError).toBe(true);
  });

  it("refuses to open a PR without a GitHub connection", async () => {
    boot();
    c.github.save(null);
    const issue = c.issues.createIssue({ title: "x", body: "", type: "bug", priority: "low" }, "user");
    const ws = await c.workspaces.forIssue(issue, "user");
    await expect(c.prs.open(ws.id, { title: "x", body: "" }, "user")).rejects.toThrow(/not connected/);
  });

  it("serves the source-control panel over HTTP", async () => {
    boot();
    const issue = c.issues.createIssue({ title: "Fix add", body: "", type: "bug", priority: "high" }, "user");
    const ws = await c.workspaces.forIssue(issue, "user");
    const server = createApp(c, { apiToken: null, staticDir: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/${ws.id}/git`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    try {
      writeFileSync(join(ws.path, "src/math.js"), "export const add = (a, b) => a + b;\n");
      let r = await call("POST", "/stage", { paths: ["src/math.js"] });
      expect(r.json.staged).toEqual([{ path: "src/math.js", status: "M" }]);

      runtime.completion = "Fix add() to sum its arguments";
      r = await call("POST", "/commit-message");
      expect(r.json.message).toBe("Fix add() to sum its arguments");
      expect(runtime.completions[0]).toContain("+export const add = (a, b) => a + b;");

      r = await call("POST", "/commit", { message: r.json.message });
      expect(r.status).toBe(200);
      expect(r.json.staged).toEqual([]);
      r = await call("GET", "");
      expect(r.json.log[0].subject).toBe("Fix add() to sum its arguments");
      expect(r.json.remotes).toEqual([{ name: "origin", url: join(fx!.root, "remote.git") }]);

      expect((await call("POST", "/branches", { name: "--upload-pack=evil" })).status).toBe(409);
      expect((await call("POST", "/switch-nowhere")).status).toBe(404);
      expect((await call("POST", "/stash/pop", { index: 0 })).status).toBe(409);

      r = await call("POST", "/push");
      expect(r.json.upstream).toBe(`origin/${ws.branch}`);
    } finally {
      server.close();
    }
  });

  it("moves the issue to review when its PR opens and to done when it merges, with undo", async () => {
    boot();
    const stageName = (id: string) => c.q.stages().find((s) => s.id === c.q.issue(id)!.stageId)!.name;
    const issue = c.issues.createIssue({ title: "Fix add", body: "", type: "bug", priority: "high" }, "user");
    const before = stageName(issue.id);
    gh.prs.push({ number: 3, title: "Fix add", body: "", head: "fix", base: "main", state: "open", merged: false, draft: false, sha: "s1", created: new Date().toISOString(), mergedAt: null });
    c.issues.addLink(issue.id, { kind: "pr", ref: "https://github.com/acme/demo/pull/3", title: "#3" }, "user");
    await until(() => c.q.issue(issue.id)!.autoMove != null);
    expect(stageName(issue.id)).toBe("Code Review");
    expect(c.q.issue(issue.id)!.autoMove).toMatchObject({ reason: "pr_opened" });

    // Undo puts it back; a person's move is never undone by the next refresh.
    c.issues.undoAutoMove(issue.id, "user");
    expect(stageName(issue.id)).toBe(before);
    expect(() => c.issues.undoAutoMove(issue.id, "user")).toThrow(/no automatic move/);

    Object.assign(gh.prs[0]!, { state: "closed", merged: true, mergedAt: new Date().toISOString(), sha: "s2" });
    await c.prs.refreshOpen();
    expect(stageName(issue.id)).toBe("Merged");
    expect(c.q.issue(issue.id)!.autoMove).toMatchObject({ reason: "pr_merged" });

    // Teams can turn it off.
    c.store.append({ aggregate: "settings", type: "SettingsChanged", aggregateId: "global", payload: { autoMoveIssues: false } }, "user");
    const other = c.issues.createIssue({ title: "Docs", body: "", type: "chore", priority: "low" }, "user");
    gh.prs.push({ number: 4, title: "Docs", body: "", head: "docs", base: "main", state: "open", merged: false, draft: false, sha: "s3", created: new Date().toISOString(), mergedAt: null });
    c.issues.addLink(other.id, { kind: "pr", ref: "https://github.com/acme/demo/pull/4", title: "#4" }, "user");
    await until(() => c.q.pullRequest("acme/demo#4")?.refreshedAt != null);
    expect(c.q.issue(other.id)!.autoMove ?? null).toBeNull();
  });

  it("summarizes PR throughput and time to merge", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const pr = (n: number, created: string, mergedAt: string | null, author = "a", state: "open" | "closed" = mergedAt ? "closed" : "open") => ({
      url: "",
      number: n,
      title: "",
      state,
      merged: Boolean(mergedAt),
      draft: false,
      headRef: "",
      headSha: "",
      baseRef: "main",
      author,
      createdAt: created,
      mergedAt,
    });
    const out = pullRequestInsights(
      [pr(1, "2026-10-05T00:00:00Z", "2026-10-05T10:00:00Z"), pr(2, "2026-10-04T00:00:00Z", "2026-10-06T00:00:00Z", "b"), pr(3, "2026-10-06T00:00:00Z", null), pr(4, "2026-10-01T00:00:00Z", null, "b", "closed"), pr(5, "2026-01-01T00:00:00Z", null)],
      7,
      now,
    );
    expect(out).toMatchObject({ opened: 4, merged: 2, closedUnmerged: 1, open: 2, medianHoursToMerge: 29 });
    expect(out.mergedPerDay).toHaveLength(7);
    expect(out.mergedPerDay.at(-1)).toEqual({ date: "2026-10-06", count: 1 });
    expect(out.byAuthor[0]).toEqual({ author: "a", opened: 2, merged: 1 });
  });
});
