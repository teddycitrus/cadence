import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, GitError, gitWithInput, splitHunks, type Hunk } from "./git";
import { readHead, readStashes } from "./ref-files";

export interface FileEntry {
  path: string;
  /** Porcelain status letter: M, A, D, R, C, U (conflict), ? (untracked). */
  status: string;
  oldPath?: string;
}

export interface RepoState {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileEntry[];
  unstaged: FileEntry[];
  conflicted: FileEntry[];
  operation: "rebase" | "merge" | "cherry-pick" | null;
  headSha: string | null;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
  remote: boolean;
}

/** Rejects refs and paths that could be read as options or escape the repo. */
function safeRef(name: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("-") || name.includes("..") || name.endsWith(".lock")) throw new GitError(`Invalid name "${name}"`);
  return name;
}

function safePath(path: string): string {
  if (!path || path.startsWith("-") || path.split(/[\\/]/).includes("..")) throw new GitError(`Invalid path "${path}"`);
  return path;
}

function parsePorcelain(out: string): { staged: FileEntry[]; unstaged: FileEntry[]; conflicted: FileEntry[] } {
  const staged: FileEntry[] = [];
  const unstaged: FileEntry[] = [];
  const conflicted: FileEntry[] = [];
  const records = out.split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const x = rec[0]!;
    const y = rec[1]!;
    const path = rec.slice(3);
    let oldPath: string | undefined;
    if (x === "R" || x === "C") oldPath = records[++i];
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicted.push({ path, status: "U" });
      continue;
    }
    if (x === "?") {
      unstaged.push({ path, status: "?" });
      continue;
    }
    if (x !== " ") staged.push({ path, status: x, ...(oldPath ? { oldPath } : {}) });
    if (y !== " ") unstaged.push({ path, status: y });
  }
  return { staged, unstaged, conflicted };
}

const gitDirs = new Map<string, Promise<string>>();

/**
 * The `## ...` line `git status --branch` starts with: "main...origin/main [ahead 1, behind 2]",
 * "No commits yet on main", or "HEAD (no branch)" when detached.
 */
export function parseBranchHeader(line: string): { branch: string | null; upstream: string | null; ahead: number; behind: number } {
  const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(line.trim());
  if (!m || m[1] === "HEAD (no branch)") return { branch: null, upstream: null, ahead: 0, behind: 0 };
  const counts = m[3] ?? "";
  return {
    branch: m[1]!,
    upstream: m[2] ?? null,
    ahead: Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(counts)?.[1] ?? 0),
  };
}

/** A git client for one working tree, covering what the source-control panel offers. */
export class GitClient {
  constructor(readonly dir: string) {}

  private run(args: string[]): Promise<string> {
    return git(this.dir, args);
  }

  private async identity(): Promise<string[]> {
    const email = await git(this.dir, ["config", "user.email"], true);
    return email ? [] : ["-c", "user.name=Cadence", "-c", "user.email=cadence@local"];
  }

  /** A working tree's git folder never moves, and each git process costs real time on some machines (Windows especially). */
  private gitDir(): Promise<string> {
    let dir = gitDirs.get(this.dir);
    if (!dir) {
      dir = git(this.dir, ["rev-parse", "--absolute-git-dir"]);
      gitDirs.set(this.dir, dir);
      dir.catch(() => gitDirs.delete(this.dir));
    }
    return dir;
  }

  async state(): Promise<RepoState> {
    // One status call gives the files and (with --branch) the branch, upstream, and ahead/behind.
    const [porcelain, gitDir] = await Promise.all([git(this.dir, ["status", "--porcelain=v1", "--branch", "-z", "-uall"]), this.gitDir()]);
    const fromFiles = readHead(gitDir);
    const head = fromFiles === undefined ? await git(this.dir, ["rev-parse", "HEAD"], true) : fromFiles;
    const header = porcelain.startsWith("## ") ? porcelain.slice(3, porcelain.indexOf("\0") >= 0 ? porcelain.indexOf("\0") : undefined) : "";
    const files = header ? porcelain.slice(porcelain.indexOf("\0") + 1) : porcelain;
    const branch = parseBranchHeader(header);
    const operation = existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply")) ? "rebase" : existsSync(join(gitDir, "MERGE_HEAD")) ? "merge" : existsSync(join(gitDir, "CHERRY_PICK_HEAD")) ? "cherry-pick" : null;
    return { ...branch, ...parsePorcelain(files), operation, headSha: head || null };
  }

  /** Diff for one file: staged (index vs HEAD) or unstaged (worktree vs index); untracked files diff against nothing. */
  async fileDiff(path: string, staged: boolean): Promise<string> {
    safePath(path);
    if (!staged) {
      const tracked = await git(this.dir, ["ls-files", "--error-unmatch", "--", path], true);
      if (!tracked) return git(this.dir, ["diff", "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", path], true);
    }
    return git(this.dir, ["diff", ...(staged ? ["--cached"] : []), "--", path], true);
  }

  async stage(paths: string[]): Promise<void> {
    await this.run(["add", "--", ...paths.map(safePath)]);
  }

  /** The hunks of a tracked file's unstaged (or staged) changes. */
  async hunks(path: string, staged: boolean): Promise<Hunk[]> {
    safePath(path);
    return splitHunks(await git(this.dir, ["diff", ...(staged ? ["--cached"] : []), "--", path], true)).hunks;
  }

  /** Stages one hunk, or with `unstage` takes one staged hunk back out. */
  async stageHunk(path: string, index: number, unstage = false): Promise<void> {
    safePath(path);
    const { head, hunks } = splitHunks(await git(this.dir, ["diff", ...(unstage ? ["--cached"] : []), "--", path], true));
    const hunk = hunks[index];
    if (!hunk) throw new GitError("That change is no longer there; refresh and try again");
    await gitWithInput(this.dir, ["apply", "--cached", ...(unstage ? ["--reverse"] : []), "--whitespace=nowarn", "-"], `${head}
${hunk.text}
`);
  }

  /** Throws away one unstaged hunk in the working tree (the rest of the file's changes stay). */
  async discardHunk(path: string, index: number): Promise<void> {
    safePath(path);
    const { head, hunks } = splitHunks(await git(this.dir, ["diff", "--", path], true));
    const hunk = hunks[index];
    if (!hunk) throw new GitError("That change is no longer there; refresh and try again");
    await gitWithInput(this.dir, ["apply", "--reverse", "--whitespace=nowarn", "-"], `${head}\n${hunk.text}\n`);
  }

  /** Pull (rebasing local commits) and push: one click to be in sync with the remote. */
  async sync(): Promise<void> {
    const st = await this.state();
    if (st.upstream) await this.pull(true);
    await this.push();
  }

  async stageAll(): Promise<void> {
    await this.run(["add", "-A"]);
  }

  async unstage(paths: string[]): Promise<void> {
    const hasHead = Boolean(await git(this.dir, ["rev-parse", "--verify", "HEAD"], true));
    if (hasHead) await this.run(["restore", "--staged", "--", ...paths.map(safePath)]);
    else await this.run(["rm", "--cached", "-r", "--", ...paths.map(safePath)]);
  }

  async unstageAll(): Promise<void> {
    await this.run(["reset", "-q"]);
  }

  /** Throws away working-tree changes to these files, deleting untracked ones. */
  async discard(paths: string[]): Promise<void> {
    const safe = paths.map(safePath);
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const p of safe) ((await git(this.dir, ["ls-files", "--error-unmatch", "--", p], true)) ? tracked : untracked).push(p);
    if (tracked.length) await this.run(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
    if (untracked.length) await this.run(["clean", "-f", "--", ...untracked]);
  }

  async discardAll(): Promise<void> {
    await this.run(["reset", "--hard", "-q"]);
    await this.run(["clean", "-fd"]);
  }

  async commit(input: { message: string; amend?: boolean; signoff?: boolean; all?: boolean }): Promise<string> {
    if (!input.message.trim() && !input.amend) throw new GitError("Write a commit message");
    if (input.all) await this.stageAll();
    const args = [...(await this.identity()), "commit", "-q"];
    if (input.amend) args.push("--amend");
    if (input.signoff) args.push("--signoff");
    if (input.message.trim()) args.push("-m", input.message);
    else args.push("--no-edit");
    await this.run(args);
    return this.run(["rev-parse", "HEAD"]);
  }

  /** Moves the last commit's changes back to staged. */
  async undoLastCommit(): Promise<void> {
    await this.run(["reset", "--soft", "HEAD~1"]);
  }

  async log(limit = 30, base?: string): Promise<CommitInfo[]> {
    const range = base ? [`${safeRef(base)}..HEAD`] : [];
    const out = await git(this.dir, ["log", `-n${Math.min(limit, 200)}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s", ...range], true);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, shortSha, author, date, subject] = l.split("\x1f");
        return { sha: sha!, shortSha: shortSha!, author: author!, date: date!, subject: subject ?? "" };
      });
  }

  async branches(): Promise<BranchInfo[]> {
    const out = await this.run(["for-each-ref", "--format=%(refname)%1f%(HEAD)%1f%(upstream:short)", "refs/heads", "refs/remotes"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [ref, head, upstream] = l.split("\x1f");
        const remote = ref!.startsWith("refs/remotes/");
        return { name: ref!.replace(/^refs\/(heads|remotes)\//, ""), current: head === "*", upstream: upstream || null, remote };
      })
      .filter((b) => !b.name.endsWith("/HEAD"));
  }

  /** Branches and tags from one git call (tags newest first, branches by name), for the panel's overview. */
  async refs(): Promise<{ branches: BranchInfo[]; tags: string[] }> {
    const out = await this.run(["for-each-ref", "--sort=-creatordate", "--format=%(refname)%1f%(HEAD)%1f%(upstream:short)", "refs/heads", "refs/remotes", "refs/tags"]);
    const branches: (BranchInfo & { ref: string })[] = [];
    const tags: string[] = [];
    for (const line of out.split("\n").filter(Boolean)) {
      const [ref, head, upstream] = line.split("\x1f");
      if (ref!.startsWith("refs/tags/")) tags.push(ref!.slice("refs/tags/".length));
      else {
        const name = ref!.replace(/^refs\/(heads|remotes)\//, "");
        if (!name.endsWith("/HEAD")) branches.push({ ref: ref!, name, current: head === "*", upstream: upstream || null, remote: ref!.startsWith("refs/remotes/") });
      }
    }
    branches.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return { branches: branches.map(({ ref: _r, ...b }) => b), tags };
  }

  async createBranch(name: string, from?: string, checkout = true): Promise<void> {
    const args = checkout ? ["switch", "-c", safeRef(name)] : ["branch", safeRef(name)];
    if (from) args.push(safeRef(from));
    await this.run(args);
  }

  async renameBranch(from: string, to: string): Promise<void> {
    await this.run(["branch", "-m", safeRef(from), safeRef(to)]);
  }

  async switchBranch(name: string): Promise<void> {
    await this.run(["switch", safeRef(name)]);
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.run(["branch", force ? "-D" : "-d", safeRef(name)]);
  }

  async remotes(): Promise<{ name: string; url: string }[]> {
    const out = await git(this.dir, ["remote", "-v"], true);
    const seen = new Map<string, string>();
    for (const line of out.split("\n").filter(Boolean)) {
      const [name, url] = line.split(/\s+/);
      if (name && url && !seen.has(name)) seen.set(name, url);
    }
    return [...seen].map(([name, url]) => ({ name, url }));
  }

  async addRemote(name: string, url: string): Promise<void> {
    if (url.startsWith("-") || /\s/.test(url)) throw new GitError("Invalid remote URL");
    await this.run(["remote", "add", safeRef(name), url]);
  }

  async setRemoteUrl(name: string, url: string): Promise<void> {
    if (url.startsWith("-") || /\s/.test(url)) throw new GitError("Invalid remote URL");
    await this.run(["remote", "set-url", safeRef(name), url]);
  }

  async renameRemote(name: string, newName: string): Promise<void> {
    await this.run(["remote", "rename", safeRef(name), safeRef(newName)]);
  }

  async removeRemote(name: string): Promise<void> {
    await this.run(["remote", "remove", safeRef(name)]);
  }

  async fetch(): Promise<void> {
    await this.run(["fetch", "--all", "--prune", "-q"]);
  }

  async pull(rebase = false): Promise<void> {
    await this.run([...(await this.identity()), "pull", rebase ? "--rebase" : "--ff", "-q"]);
  }

  /** Pushes the current branch, setting its upstream on first push ("publish"). */
  async push(force = false): Promise<void> {
    const st = await this.state();
    if (!st.branch) throw new GitError("Check out a branch before pushing");
    if (st.upstream) await this.run(["push", ...(force ? ["--force-with-lease"] : []), "-q"]);
    else {
      const remote = (await this.remotes())[0]?.name;
      if (!remote) throw new GitError("This repository has no remote to push to");
      await this.run(["push", "-u", remote, st.branch, "-q"]);
    }
  }

  async abortOperation(): Promise<void> {
    const { operation } = await this.state();
    if (!operation) throw new GitError("Nothing to abort");
    await this.run([operation, "--abort"]);
  }

  async stashes(): Promise<{ index: number; message: string }[]> {
    const fromFiles = readStashes(await this.gitDir());
    const messages = fromFiles ?? (await git(this.dir, ["stash", "list", "--format=%gs"], true)).split("\n").filter(Boolean);
    return messages.map((message, index) => ({ index, message }));
  }

  async stash(message?: string, includeUntracked = true): Promise<void> {
    await this.run([...(await this.identity()), "stash", "push", ...(includeUntracked ? ["-u"] : []), ...(message ? ["-m", message] : [])]);
  }

  async stashPop(index = 0): Promise<void> {
    await this.run(["stash", "pop", `stash@{${Math.max(0, Math.floor(index))}}`]);
  }

  async stashDrop(index: number): Promise<void> {
    await this.run(["stash", "drop", `stash@{${Math.max(0, Math.floor(index))}}`]);
  }

  async tags(): Promise<string[]> {
    const out = await git(this.dir, ["tag", "--sort=-creatordate"], true);
    return out.split("\n").filter(Boolean);
  }

  async createTag(name: string, message?: string): Promise<void> {
    await this.run([...(await this.identity()), "tag", ...(message ? ["-a", safeRef(name), "-m", message] : [safeRef(name)])]);
  }

  async deleteTag(name: string): Promise<void> {
    await this.run(["tag", "-d", safeRef(name)]);
  }

  /** The staged diff (or, with nothing staged, the whole working diff) for writing a commit message. */
  async diffForMessage(maxChars = 60_000): Promise<string> {
    let diff = await git(this.dir, ["diff", "--cached"], true);
    if (!diff.trim()) diff = await git(this.dir, ["diff"], true);
    return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n... (diff truncated)` : diff;
  }
}
