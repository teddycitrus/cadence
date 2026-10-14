import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChecksState, PullRequestCheck, ReviewState } from "../core/types";
import type { SecretStore } from "../integrations/secrets";

const exec = promisify(execFile);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidGithubRepo(value: string): boolean {
  return REPO_PATTERN.test(value);
}

/** "owner/name" from a GitHub remote URL (https or ssh), or null for other hosts. */
export function repoFromRemote(url: string): string | null {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** "owner/name" and number from a pull request URL. */
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

/**
 * Finds a GitHub token: GITHUB_TOKEN or GH_TOKEN, then one saved in Cadence's
 * settings (kept in the data dir, never sent back to the browser), then the gh
 * CLI's login.
 */
export class GitHubAuth {
  /** The gh CLI's token, looked up once and shared by every caller (the lookup is a process). */
  private ghToken: Promise<string | null> | null = null;

  constructor(private secrets: SecretStore) {}

  private saved(): string | null {
    return this.secrets.get("githubToken");
  }

  save(token: string | null): void {
    this.secrets.set("githubToken", token);
  }

  async token(): Promise<string | null> {
    const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (env) return env;
    const saved = this.saved();
    if (saved) return saved;
    if (process.env.CADENCE_DISABLE_GH_CLI) return null;
    this.ghToken ??= exec("gh", ["auth", "token"], { windowsHide: true }).then(
      (r) => r.stdout.trim() || null,
      () => null,
    );
    return this.ghToken;
  }

  /** Starts the gh lookup early, so the first page load does not wait for it. */
  warm(): void {
    void this.token();
  }

  async source(): Promise<"env" | "settings" | "gh" | null> {
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return "env";
    if (this.saved()) return "settings";
    return (await this.token()) ? "gh" : null;
  }
}

/** Confirms a token works before saving it. */
export async function verifyToken(token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new GitHubError(`GitHub rejected that token (${res.status})`, 400);
  return ((await res.json()) as { login: string }).login;
}

export interface PullRequestInfo {
  url: string;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  author: string;
  createdAt: string;
  mergedAt: string | null;
}


export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface RawPr {
  html_url: string;
  number: number;
  title: string;
  state: "open" | "closed";
  merged?: boolean;
  merged_at: string | null;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
  created_at: string;
}

function toPr(p: RawPr): PullRequestInfo {
  return {
    url: p.html_url,
    number: p.number,
    title: p.title,
    state: p.state,
    merged: Boolean(p.merged ?? p.merged_at),
    draft: Boolean(p.draft),
    headRef: p.head.ref,
    headSha: p.head.sha,
    baseRef: p.base.ref,
    author: p.user?.login ?? "unknown",
    createdAt: p.created_at,
    mergedAt: p.merged_at,
  };
}

/** The parts of the GitHub REST API Cadence uses. */
export class GitHubApi {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
        message = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
      } catch {
        // keep raw text
      }
      throw new GitHubError(`GitHub ${res.status}: ${message}`, res.status);
    }
    return (await res.json()) as T;
  }

  private repoPath(repo: string): string {
    if (!isValidGithubRepo(repo)) throw new GitHubError(`Invalid GitHub repository "${repo}"`, 400);
    return `/repos/${repo}`;
  }

  /** Opens a pull request, or returns the open one that already exists for this branch. */
  async openPullRequest(input: { repo: string; head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullRequestInfo> {
    const existing = await this.findOpenPullRequest(input.repo, input.head);
    if (existing) return existing;
    const pr = await this.req<RawPr>("POST", `${this.repoPath(input.repo)}/pulls`, { title: input.title, body: input.body, head: input.head, base: input.base, draft: Boolean(input.draft) });
    return toPr(pr);
  }

  async findOpenPullRequest(repo: string, branch: string): Promise<PullRequestInfo | null> {
    const owner = repo.split("/")[0];
    const list = await this.req<RawPr[]>("GET", `${this.repoPath(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    return list[0] ? toPr(list[0]) : null;
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    return toPr(await this.req<RawPr>("GET", `${this.repoPath(repo)}/pulls/${number}`));
  }

  /** Check runs and commit statuses on a commit, combined into one state. */
  async checks(repo: string, sha: string): Promise<{ state: ChecksState; runs: PullRequestCheck[] }> {
    const [runs, statuses] = await Promise.all([
      this.req<{ check_runs: { name: string; status: string; conclusion: string | null; html_url: string | null }[] }>("GET", `${this.repoPath(repo)}/commits/${sha}/check-runs?per_page=100`),
      this.req<{ statuses: { context: string; state: string; target_url: string | null }[] }>("GET", `${this.repoPath(repo)}/commits/${sha}/status`),
    ]);
    const all: PullRequestCheck[] = [
      ...runs.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url })),
      ...statuses.statuses.map((s) => ({ name: s.context, status: s.state === "pending" ? "in_progress" : "completed", conclusion: s.state === "pending" ? null : s.state, url: s.target_url })),
    ];
    const failed = all.some((r) => r.conclusion && ["failure", "error", "timed_out", "cancelled", "action_required"].includes(r.conclusion));
    const pending = all.some((r) => r.status !== "completed");
    return { state: all.length === 0 ? "none" : failed ? "failure" : pending ? "pending" : "success", runs: all };
  }

  /** Each reviewer's latest decision, summarized. */
  async review(repo: string, number: number): Promise<ReviewState> {
    const reviews = await this.req<{ user: { login: string } | null; state: string }[]>("GET", `${this.repoPath(repo)}/pulls/${number}/reviews?per_page=100`);
    const latest = new Map<string, string>();
    for (const r of reviews) if (r.state !== "PENDING" && r.state !== "DISMISSED") latest.set(r.user?.login ?? "?", r.state);
    const states = [...latest.values()];
    if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
    if (states.includes("APPROVED")) return "approved";
    return states.length ? "commented" : "none";
  }

  /**
   * Posts a comment on a pull request, or updates the earlier one carrying the
   * same hidden marker, so repeated reports replace each other instead of piling up.
   */
  async upsertComment(repo: string, number: number, marker: string, body: string): Promise<{ url: string; updated: boolean }> {
    const text = `${body}

<!-- ${marker} -->`;
    const comments = await this.req<{ id: number; body: string | null; html_url: string }[]>("GET", `${this.repoPath(repo)}/issues/${number}/comments?per_page=100`);
    const mine = comments.find((c) => c.body?.includes(`<!-- ${marker} -->`));
    if (mine) {
      const updated = await this.req<{ html_url: string }>("PATCH", `${this.repoPath(repo)}/issues/comments/${mine.id}`, { body: text });
      return { url: updated.html_url, updated: true };
    }
    const created = await this.req<{ html_url: string }>("POST", `${this.repoPath(repo)}/issues/${number}/comments`, { body: text });
    return { url: created.html_url, updated: false };
  }

  /** The pull request comment carrying a hidden marker (see upsertComment), or null. */
  async findComment(repo: string, number: number, marker: string): Promise<{ body: string; url: string; updatedAt: string } | null> {
    const comments = await this.req<{ body: string | null; html_url: string; updated_at: string }[]>("GET", `${this.repoPath(repo)}/issues/${number}/comments?per_page=100`);
    const c = comments.find((x) => x.body?.includes(`<!-- ${marker} -->`));
    return c ? { body: c.body!.replace(`<!-- ${marker} -->`, "").trim(), url: c.html_url, updatedAt: c.updated_at } : null;
  }

  /** Sets a commit status (the check line on a pull request), e.g. context "cadence/visual-review". */
  async setStatus(repo: string, sha: string, status: { state: "pending" | "success" | "failure" | "error"; context: string; description: string; targetUrl?: string | null }): Promise<void> {
    await this.req("POST", `${this.repoPath(repo)}/statuses/${sha}`, { state: status.state, context: status.context, description: status.description.slice(0, 140), ...(status.targetUrl ? { target_url: status.targetUrl } : {}) });
  }

  /** Creates a repository for the signed-in user, or in an organization they can create repos in. */
  async createRepository(input: { name: string; owner: string | null; private: boolean; description: string }): Promise<{ fullName: string; cloneUrl: string; htmlUrl: string }> {
    if (!/^[\w.-]{1,100}$/.test(input.name)) throw new GitHubError("Repository names use letters, digits, ., - and _", 400);
    if (input.owner && !/^[\w-]{1,39}$/.test(input.owner)) throw new GitHubError("That is not a GitHub account or organization name", 400);
    const path = input.owner ? `/orgs/${input.owner}/repos` : "/user/repos";
    const repo = await this.req<{ full_name: string; clone_url: string; html_url: string }>("POST", path, { name: input.name, private: input.private, description: input.description, auto_init: false });
    return { fullName: repo.full_name, cloneUrl: repo.clone_url, htmlUrl: repo.html_url };
  }

  /** Recent pull requests (any state), newest first, for insights. */
  async recentPullRequests(repo: string, max = 300): Promise<PullRequestInfo[]> {
    const out: PullRequestInfo[] = [];
    for (let page = 1; out.length < max && page <= 10; page++) {
      const batch = await this.req<RawPr[]>("GET", `${this.repoPath(repo)}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`);
      out.push(...batch.map(toPr));
      if (batch.length < 100) break;
    }
    return out.slice(0, max);
  }
}
