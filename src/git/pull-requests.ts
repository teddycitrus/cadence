import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { IssueCommands } from "../core/issue-commands";
import type { Queries } from "../core/queries";
import type { Actor, GithubEvent, PullRequest, StoredEvent, Workspace } from "../core/types";
import { GitClient } from "./client";
import { GitHubApi, GitHubError, parsePrUrl, repoFromRemote, type GitHubAuth } from "./github";

export const prId = (repo: string, number: number) => `${repo}#${number}`;

const REFRESH_MS = 60_000;

/**
 * Opens and follows GitHub pull requests: links them to issues, refreshes
 * their checks and reviews, and records transitions (merged, reviewed,
 * ready for review) that GitHub triggers can fire on without a webhook.
 */
export class PullRequestService {
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private store: EventStore,
    private q: Queries,
    private issues: IssueCommands,
    private auth: GitHubAuth,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  start(refreshMs = REFRESH_MS): void {
    // Any PR link added to an issue (by a person or an agent) gets followed.
    this.unsubscribe = this.store.subscribe((e) => this.onEvent(e));
    this.timer = setInterval(() => void this.refreshOpen(), refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  private onEvent(e: StoredEvent): void {
    if (e.type !== "LinkAdded") return;
    const link = e.payload.link as { kind: string; ref: string };
    const parsed = link.kind === "pr" ? parsePrUrl(link.ref) : null;
    if (parsed) queueMicrotask(() => void this.track(link.ref, e.aggregateId, null, "system").catch(() => undefined));
  }

  async api(): Promise<GitHubApi> {
    const token = await this.auth.token();
    if (!token) throw new ConflictError("GitHub is not connected. Add a token in Settings, set GITHUB_TOKEN, or sign in with the gh CLI.");
    return new GitHubApi(token, this.fetchImpl);
  }

  /** The workspace's GitHub repository: the project's setting, else its origin remote. */
  async repoFor(ws: Workspace): Promise<string> {
    const project = ws.projectId ? this.q.project(ws.projectId) : null;
    if (project?.githubRepo) return project.githubRepo;
    const remotes = await new GitClient(ws.path).remotes();
    const repo = remotes.map((r) => repoFromRemote(r.url)).find(Boolean);
    if (!repo) throw new ValidationError("This workspace has no GitHub remote. Add one, or set the project's GitHub repository.");
    return repo;
  }

  async track(url: string, issueId: string | null, workspaceId: string | null, actor: Actor): Promise<PullRequest> {
    const parsed = parsePrUrl(url);
    if (!parsed) throw new ValidationError("That is not a GitHub pull request URL");
    const id = prId(parsed.repo, parsed.number);
    const existing = this.q.pullRequest(id);
    if (existing) {
      if ((issueId && existing.issueId !== issueId) || (workspaceId && existing.workspaceId !== workspaceId)) {
        this.store.append({ aggregate: "pr", type: "PullRequestLinked", aggregateId: id, payload: { issueId, workspaceId } }, actor);
      }
    } else {
      this.store.append({ aggregate: "pr", type: "PullRequestTracked", aggregateId: id, payload: { url, repo: parsed.repo, number: parsed.number, issueId, workspaceId } }, actor);
    }
    await this.refresh(id).catch(() => undefined);
    return this.q.pullRequest(id)!;
  }

  /** Pushes the workspace branch and opens (or finds) its pull request, linking it to the issue. */
  async open(workspaceId: string, input: { title: string; body: string; draft?: boolean }, actor: Actor): Promise<PullRequest> {
    const ws = this.q.workspace(workspaceId);
    if (!ws) throw new NotFoundError("Workspace not found");
    if (!ws.branch || !ws.baseBranch) throw new ValidationError("This workspace is not on a git branch");
    const api = await this.api();
    const repo = await this.repoFor(ws);
    const git = new GitClient(ws.path);
    const st = await git.state();
    if (st.staged.length || st.unstaged.length) throw new ConflictError("Commit or stash your changes before opening a pull request");
    await git.push();
    const issue = ws.issueId ? this.q.issue(ws.issueId) : null;
    const pr = await api.openPullRequest({ repo, head: ws.branch, base: ws.baseBranch, title: input.title, body: input.body, draft: input.draft });
    if (issue && !issue.links.some((l) => l.kind === "pr" && l.ref === pr.url)) this.issues.addLink(issue.id, { kind: "pr", ref: pr.url, title: `#${pr.number} ${pr.title}` }, actor);
    return this.track(pr.url, issue?.id ?? null, ws.id, actor);
  }

  /** The tracked PR for a workspace, discovering an existing one on GitHub by branch. */
  async forWorkspace(workspaceId: string): Promise<PullRequest | null> {
    const tracked = this.q.pullRequests().find((p) => p.workspaceId === workspaceId);
    if (tracked) return tracked;
    const ws = this.q.workspace(workspaceId);
    if (!ws?.branch || !(await this.auth.token())) return null;
    try {
      const repo = await this.repoFor(ws);
      const found = await (await this.api()).findOpenPullRequest(repo, ws.branch);
      return found ? this.track(found.url, ws.issueId, ws.id, "system") : null;
    } catch {
      return null;
    }
  }

  /** Posts (or updates) a marked comment on the workspace's pull request. */
  async comment(workspaceId: string, marker: string, body: string): Promise<{ url: string; updated: boolean; pr: PullRequest }> {
    const pr = await this.forWorkspace(workspaceId);
    if (!pr) throw new ConflictError("This workspace has no pull request yet; open one first");
    const result = await (await this.api()).upsertComment(pr.repo, pr.number, marker, body);
    return { ...result, pr };
  }

  async refresh(id: string): Promise<void> {
    const pr = this.q.pullRequest(id);
    if (!pr) throw new NotFoundError("Pull request not tracked");
    try {
      const api = await this.api();
      const info = await api.getPullRequest(pr.repo, pr.number);
      const [checks, review] = await Promise.all([api.checks(pr.repo, info.headSha), api.review(pr.repo, pr.number)]);
      const transitions: GithubEvent[] = [];
      if (pr.refreshedAt) {
        if (info.merged && !pr.merged) transitions.push("pr_merged");
        if (review !== pr.review && (review === "approved" || review === "changes_requested" || review === "commented")) transitions.push("pr_review_submitted");
        if (pr.draft && !info.draft && info.state === "open") transitions.push("pr_ready_for_review");
      }
      const changed =
        !pr.refreshedAt ||
        pr.error !== null ||
        info.merged !== pr.merged ||
        info.state !== pr.state ||
        info.draft !== pr.draft ||
        info.title !== pr.title ||
        info.headSha !== pr.headSha ||
        checks.state !== pr.checks ||
        review !== pr.review ||
        JSON.stringify(checks.runs) !== JSON.stringify(pr.checkRuns);
      if (!changed) return;
      this.store.append(
        {
          aggregate: "pr",
          type: "PullRequestUpdated",
          aggregateId: id,
          payload: { title: info.title, state: info.state, merged: info.merged, draft: info.draft, headRef: info.headRef, headSha: info.headSha, checks: checks.state, checkRuns: checks.runs, review, transitions },
        },
        "system",
      );
      this.autoMove(this.q.pullRequest(id)!);
    } catch (err) {
      const error = err instanceof GitHubError || err instanceof Error ? err.message : String(err);
      if (pr.error !== error) this.store.append({ aggregate: "pr", type: "PullRequestRefreshFailed", aggregateId: id, payload: { error } }, "system");
    }
  }

  /**
   * Moves the PR's issue along the board: to review when the PR is open and
   * ready, to done when it merges. Only forward, and never past a stage a
   * person has moved it to since. People can undo it from the issue.
   */
  private autoMove(pr: PullRequest): void {
    if (!pr.issueId || this.q.settings().autoMoveIssues === false) return;
    const issue = this.q.issue(pr.issueId);
    const stages = this.q.stages();
    const current = stages.find((s) => s.id === issue?.stageId);
    if (!issue || !current) return;
    const rank: Record<string, number> = { triage: 0, in_progress: 1, in_review: 2, done: 3, cancelled: 4 };
    const target = (category: "in_review" | "done", prefer: RegExp) => {
      const options = stages.filter((s) => s.category === category);
      return options.find((s) => prefer.test(s.name)) ?? options[0];
    };
    const [reason, to] = pr.merged ? (["pr_merged", target("done", /merged/i)] as const) : pr.state === "open" && !pr.draft ? (["pr_opened", target("in_review", /code review|pr review|review/i)] as const) : [null, undefined];
    if (!reason || !to || rank[current.category]! >= rank[to.category]!) return;
    this.issues.moveIssue(issue.id, to.id, "system", reason);
  }

  async refreshOpen(): Promise<void> {
    if (!(await this.auth.token())) return;
    for (const pr of this.q.pullRequests().filter((p) => p.state === "open")) await this.refresh(pr.id);
  }
}
