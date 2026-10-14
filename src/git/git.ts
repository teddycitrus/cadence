import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitError extends Error {}

/** Runs git with an argument array (never through a shell). */
export async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    // Some commands (diff --no-index) exit non-zero with useful output.
    if (allowFailure) return (e.stdout ?? "").trimEnd();
    throw new GitError(`git ${args.join(" ")} failed: ${(e.stderr || e.message).trim()}`);
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return (await git(path, ["rev-parse", "--is-inside-work-tree"], true)) === "true";
}

export async function currentBranch(path: string): Promise<string> {
  return git(path, ["symbolic-ref", "--short", "HEAD"]);
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return (await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], true)) !== "";
}

export async function addWorktree(repoPath: string, dir: string, branch: string, base: string): Promise<void> {
  if (existsSync(dir)) return;
  if (await branchExists(repoPath, branch)) {
    await git(repoPath, ["worktree", "add", dir, branch]);
  } else {
    await git(repoPath, ["worktree", "add", "-b", branch, dir, base]);
  }
}

export async function removeWorktree(repoPath: string, dir: string): Promise<void> {
  // A linked node_modules (see canvas devserver) points at the main checkout's.
  // Remove the link itself first so nothing can recurse into the real folder.
  const deps = join(dir, "node_modules");
  try {
    if (lstatSync(deps).isSymbolicLink()) unlinkSync(deps);
  } catch {
    // no node_modules
  }
  await git(repoPath, ["worktree", "remove", "--force", dir], true);
}

async function identityArgs(dir: string): Promise<string[]> {
  const email = await git(dir, ["config", "user.email"], true);
  return email ? [] : ["-c", "user.name=Cadence Agent", "-c", "user.email=agent@cadence.local"];
}

/** Stages and commits everything in the worktree. Returns the new sha, or null if nothing changed. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ["add", "-A"]);
  const status = await git(dir, ["status", "--porcelain"]);
  if (!status) return null;
  await git(dir, [...(await identityArgs(dir)), "commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export async function diffAgainst(dir: string, base: string, maxChars = 400_000): Promise<string> {
  const committed = await git(dir, ["diff", `${base}...HEAD`], true);
  const pending = await git(dir, ["diff", "HEAD"], true);
  const out = [committed, pending].filter(Boolean).join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n... diff truncated ...` : out;
}

export async function changedFiles(dir: string, base: string): Promise<string[]> {
  const out = await git(dir, ["diff", "--name-only", `${base}...HEAD`], true);
  return out ? out.split("\n") : [];
}

export async function push(dir: string, branch: string): Promise<void> {
  await git(dir, ["push", "-u", "origin", branch]);
}

export interface FileChange {
  path: string;
  status: string;
}

/** Working-tree changes plus everything committed on the branch since it left base. */
export async function changes(dir: string, base: string | null): Promise<FileChange[]> {
  const byPath = new Map<string, string>();
  if (base) {
    const committed = await git(dir, ["diff", "--name-status", `${base}...HEAD`], true);
    for (const line of committed.split("\n").filter(Boolean)) {
      const [status, ...rest] = line.split("\t");
      byPath.set(rest.at(-1)!, status!.slice(0, 1));
    }
  }
  const porcelain = await git(dir, ["status", "--porcelain", "-uall"], true);
  for (const line of porcelain.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2).trim() || "M";
    const path = line.slice(3).split(" -> ").at(-1)!;
    byPath.set(path, code === "??" ? "A" : code.slice(0, 1));
  }
  return [...byPath].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
}

export async function aheadBehind(dir: string, base: string): Promise<{ ahead: number; behind: number }> {
  const out = await git(dir, ["rev-list", "--left-right", "--count", `${base}...HEAD`], true);
  const [behind, ahead] = out.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

export async function diffFile(dir: string, base: string | null, path: string): Promise<string> {
  const tracked = await git(dir, ["ls-files", "--error-unmatch", "--", path], true);
  if (!tracked) return git(dir, ["diff", "--no-index", "--", "/dev/null", path], true);
  return git(dir, ["diff", base ? base : "HEAD", "--", path], true);
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ["branch", "-D", branch], true);
}

/** The first of `name`, `name-2`, `name-3`... that is not already a branch in the repo. */
export async function freeBranchName(repoPath: string, name: string): Promise<string> {
  if (!(await branchExists(repoPath, name))) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`;
    if (!(await branchExists(repoPath, candidate))) return candidate;
  }
}

/** Runs git with `input` on stdin (for git apply). */
export function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new GitError(`git ${args.join(" ")} failed: ${err.trim()}`))));
    child.stdin.end(input);
  });
}

export interface Hunk {
  header: string;
  /** The hunk's own lines, starting with its @@ line. */
  text: string;
}

/** Splits a one-file diff into its file header and hunks. */
export function splitHunks(diff: string): { head: string; hunks: Hunk[] } {
  const lines = diff.split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return { head: diff, hunks: [] };
  const head = lines.slice(0, first).join("\n");
  const hunks: Hunk[] = [];
  let cur: string[] = [];
  for (const l of lines.slice(first)) {
    if (l.startsWith("@@") && cur.length) {
      hunks.push({ header: cur[0]!, text: cur.join("\n") });
      cur = [];
    }
    if (l !== "" || cur.length) cur.push(l);
  }
  if (cur.length) hunks.push({ header: cur[0]!, text: cur.join("\n").replace(/\n+$/, "") });
  return { head, hunks };
}
