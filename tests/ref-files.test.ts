import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readHead, readStashes } from "../src/git/ref-files";
import { removeTempDir } from "./helpers/temp-dir";

const dirs: string[] = [];
const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const gitDir = (cwd: string) => run(cwd, "rev-parse", "--absolute-git-dir");
const head = (cwd: string) => {
  try {
    return run(cwd, "rev-parse", "--verify", "-q", "HEAD");
  } catch {
    return null;
  }
};
const stashes = (cwd: string) => run(cwd, "stash", "list", "--format=%gs").split("\n").filter(Boolean);

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "cadence-refs-"));
  dirs.push(d);
  run(d, "init", "-q", "-b", "main");
  return d;
}

afterAll(() => dirs.forEach(removeTempDir));

describe("reading HEAD and stashes from git's files", () => {
  it("matches git on an empty repo, loose refs, packed refs, and a detached HEAD", () => {
    const d = repo();
    expect(readHead(gitDir(d))).toBeNull();
    expect(readStashes(gitDir(d))).toEqual([]);
    writeFileSync(join(d, "a.txt"), "1");
    run(d, "add", ".");
    run(d, "commit", "-qm", "one");
    expect(readHead(gitDir(d))).toBe(head(d));
    run(d, "pack-refs", "--all");
    expect(readHead(gitDir(d))).toBe(head(d));
    writeFileSync(join(d, "a.txt"), "2");
    run(d, "commit", "-qam", "two");
    run(d, "checkout", "-q", "--detach", "HEAD~1");
    expect(readHead(gitDir(d))).toBe(head(d));
  });

  it("matches git in a linked worktree and lists stashes newest first", () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "1");
    run(d, "add", ".");
    run(d, "commit", "-qm", "one");
    const wt = join(d, "..", `${d.split(/[\\/]/).pop()}-wt`);
    dirs.push(wt);
    run(d, "worktree", "add", "-q", "-b", "feature", wt);
    writeFileSync(join(wt, "a.txt"), "wt");
    run(wt, "commit", "-qam", "in worktree");
    expect(readHead(gitDir(wt))).toBe(head(wt));
    expect(readHead(gitDir(d))).toBe(head(d));
    for (const n of ["first", "second", "third"]) {
      writeFileSync(join(d, "a.txt"), n);
      run(d, "stash", "push", "-qm", n);
    }
    expect(readStashes(gitDir(d))).toEqual(stashes(d));
    expect(readStashes(gitDir(wt))).toEqual(stashes(wt));
    run(d, "stash", "drop", "-q", "stash@{1}");
    expect(readStashes(gitDir(d))).toEqual(stashes(d));
  });
});
