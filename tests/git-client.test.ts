import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/git/client";
import { GitError } from "../src/git/git";
import { createGitFixture, gitOut, type GitFixture } from "./helpers/git-fixture";

// Many real git processes per test; under a full parallel run they need more than the default 20s.
describe("git client", { timeout: 60_000 }, () => {
  let fx: GitFixture;
  afterEach(() => fx.cleanup());

  const setup = () => {
    fx = createGitFixture();
    gitOut(fx.repo, "config", "user.email", "t@t");
    gitOut(fx.repo, "config", "user.name", "T");
    return new GitClient(fx.repo);
  };

  it("reports staged, unstaged, and untracked files separately and stages/unstages them", async () => {
    const g = setup();
    writeFileSync(join(fx.repo, "README.md"), "# changed\n");
    writeFileSync(join(fx.repo, "new.txt"), "hello\n");
    let st = await g.state();
    expect(st.branch).toBe("main");
    expect(st.staged).toEqual([]);
    expect(st.unstaged).toEqual([
      { path: "README.md", status: "M" },
      { path: "new.txt", status: "?" },
    ]);
    await g.stage(["README.md"]);
    st = await g.state();
    expect(st.staged).toEqual([{ path: "README.md", status: "M" }]);
    expect(await g.fileDiff("README.md", true)).toContain("+# changed");
    expect(await g.fileDiff("new.txt", false)).toContain("+hello");
    await g.unstage(["README.md"]);
    expect((await g.state()).staged).toEqual([]);
  });

  it("commits with amend and sign-off, shows the log, and undoes the last commit", async () => {
    const g = setup();
    writeFileSync(join(fx.repo, "a.txt"), "a\n");
    await expect(g.commit({ message: "  " })).rejects.toThrow(GitError);
    await g.commit({ message: "Add a", all: true, signoff: true });
    let log = await g.log(5);
    expect(log[0]!.subject).toBe("Add a");
    expect(gitOut(fx.repo, "log", "-1", "--format=%B")).toContain("Signed-off-by:");
    writeFileSync(join(fx.repo, "b.txt"), "b\n");
    await g.stageAll();
    await g.commit({ message: "Add a and b", amend: true });
    log = await g.log(5);
    expect(log.map((c) => c.subject)).toEqual(["Add a and b", "initial"]);
    await g.undoLastCommit();
    expect((await g.state()).staged.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("discards tracked changes and deletes untracked files", async () => {
    const g = setup();
    writeFileSync(join(fx.repo, "README.md"), "oops\n");
    writeFileSync(join(fx.repo, "junk.txt"), "x\n");
    await g.discard(["README.md", "junk.txt"]);
    expect(readFileSync(join(fx.repo, "README.md"), "utf8")).toBe("# demo\n");
    expect(existsSync(join(fx.repo, "junk.txt"))).toBe(false);
  });

  it("creates, renames, switches, and deletes branches, and rejects option-like names", async () => {
    const g = setup();
    await g.createBranch("feature/x");
    expect((await g.state()).branch).toBe("feature/x");
    await g.renameBranch("feature/x", "feature/y");
    await g.switchBranch("main");
    expect((await g.branches()).filter((b) => !b.remote).map((b) => [b.name, b.current])).toEqual([
      ["feature/y", false],
      ["main", true],
    ]);
    await g.deleteBranch("feature/y");
    await expect(g.createBranch("--force")).rejects.toThrow(GitError);
    await expect(g.stage(["../outside"])).rejects.toThrow(GitError);
  });

  it("publishes, pushes, fetches, pulls, and tracks ahead/behind against a remote", async () => {
    const g = setup();
    const bare = join(fx.root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    await expect(g.push()).rejects.toThrow(/no remote/);
    await g.addRemote("origin", bare);
    expect(await g.remotes()).toEqual([{ name: "origin", url: bare }]);
    await g.push();
    expect((await g.state()).upstream).toBe("origin/main");

    // A teammate pushes a commit.
    const other = join(fx.root, "other");
    execFileSync("git", ["clone", "-q", bare, other]);
    writeFileSync(join(other, "team.txt"), "from teammate\n");
    gitOut(other, "add", "-A");
    gitOut(other, "-c", "user.name=O", "-c", "user.email=o@o", "commit", "-qm", "teammate change");
    gitOut(other, "push", "-q");

    await g.fetch();
    expect((await g.state()).behind).toBe(1);
    await g.pull();
    expect(readFileSync(join(fx.repo, "team.txt"), "utf8")).toBe("from teammate\n");

    writeFileSync(join(fx.repo, "mine.txt"), "mine\n");
    await g.commit({ message: "mine", all: true });
    expect((await g.state()).ahead).toBe(1);
    await g.push();
    expect((await g.state()).ahead).toBe(0);
  });

  it("stashes and restores work, and manages tags", async () => {
    const g = setup();
    writeFileSync(join(fx.repo, "README.md"), "wip\n");
    writeFileSync(join(fx.repo, "untracked.txt"), "u\n");
    await g.stash("wip");
    expect((await g.state()).unstaged).toEqual([]);
    expect((await g.stashes())[0]!.message).toContain("wip");
    await g.stashPop(0);
    expect(readFileSync(join(fx.repo, "README.md"), "utf8")).toBe("wip\n");
    expect(existsSync(join(fx.repo, "untracked.txt"))).toBe(true);

    await g.createTag("v1.0.0", "First release");
    expect(await g.tags()).toEqual(["v1.0.0"]);
    await g.deleteTag("v1.0.0");
    expect(await g.tags()).toEqual([]);
  });

  it("stages and unstages single hunks", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    fx = createGitFixture({ "notes.txt": lines.join("\n") + "\n" });
    gitOut(fx.repo, "config", "user.email", "t@t");
    gitOut(fx.repo, "config", "user.name", "T");
    const g = new GitClient(fx.repo);
    const changed = [...lines];
    changed[1] = "line 2 CHANGED";
    changed[27] = "line 28 CHANGED";
    writeFileSync(join(fx.repo, "notes.txt"), changed.join("\n") + "\n");
    expect(await g.hunks("notes.txt", false)).toHaveLength(2);

    await g.stageHunk("notes.txt", 1);
    const staged = gitOut(fx.repo, "diff", "--cached");
    expect(staged).toContain("+line 28 CHANGED");
    expect(staged).not.toContain("+line 2 CHANGED");
    expect(await g.hunks("notes.txt", false)).toHaveLength(1);

    await g.stageHunk("notes.txt", 0, true);
    expect(gitOut(fx.repo, "diff", "--cached")).toBe("");
    await expect(g.stageHunk("notes.txt", 5)).rejects.toThrow(/no longer there/);
  });

  it("discards one unstaged hunk and keeps the others", async () => {
    const g = setup();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(fx.repo, "notes.txt"), lines.join("\n") + "\n");
    gitOut(fx.repo, "add", "-A");
    gitOut(fx.repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "notes");
    const changed = [...lines];
    changed[1] = "line 2 CHANGED";
    changed[27] = "line 28 CHANGED";
    writeFileSync(join(fx.repo, "notes.txt"), changed.join("\n") + "\n");
    await g.discardHunk("notes.txt", 0);
    const text = readFileSync(join(fx.repo, "notes.txt"), "utf8");
    expect(text).toContain("line 2\n");
    expect(text).toContain("line 28 CHANGED");
    await expect(g.discardHunk("notes.txt", 3)).rejects.toThrow(/no longer there/);
  });

  it("syncs: pulls teammates' commits under local ones, then pushes", async () => {
    const g = setup();
    const bare = join(fx.root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    await g.addRemote("origin", bare);
    await g.push();
    const other = join(fx.root, "other");
    execFileSync("git", ["clone", "-q", bare, other]);
    writeFileSync(join(other, "team.txt"), "t\n");
    gitOut(other, "add", "-A");
    gitOut(other, "-c", "user.name=O", "-c", "user.email=o@o", "commit", "-qm", "theirs");
    gitOut(other, "push", "-q");
    writeFileSync(join(fx.repo, "mine.txt"), "m\n");
    await g.commit({ message: "mine", all: true });
    await g.fetch();
    await g.sync();
    const st = await g.state();
    expect([st.ahead, st.behind]).toEqual([0, 0]);
    expect((await g.log(3)).map((c) => c.subject)).toEqual(["mine", "theirs", "initial"]);
  });

  it("detects a conflicted merge and aborts it", async () => {
    const g = setup();
    await g.createBranch("side");
    writeFileSync(join(fx.repo, "README.md"), "side\n");
    await g.commit({ message: "side", all: true });
    await g.switchBranch("main");
    writeFileSync(join(fx.repo, "README.md"), "main\n");
    await g.commit({ message: "main", all: true });
    try {
      gitOut(fx.repo, "merge", "side");
    } catch {
      // expected conflict
    }
    const st = await g.state();
    expect(st.operation).toBe("merge");
    expect(st.conflicted).toEqual([{ path: "README.md", status: "U" }]);
    await g.abortOperation();
    expect((await g.state()).operation).toBeNull();
  });
});

describe("status branch header", () => {
  it("reads branch, upstream, and ahead/behind from git status --branch", async () => {
    const { parseBranchHeader } = await import("../src/git/client");
    expect(parseBranchHeader("main...origin/main [ahead 2, behind 1]")).toEqual({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1 });
    expect(parseBranchHeader("feature/x...origin/feature/x [gone]")).toEqual({ branch: "feature/x", upstream: "origin/feature/x", ahead: 0, behind: 0 });
    expect(parseBranchHeader("main")).toEqual({ branch: "main", upstream: null, ahead: 0, behind: 0 });
    expect(parseBranchHeader("No commits yet on main")).toEqual({ branch: "main", upstream: null, ahead: 0, behind: 0 });
    expect(parseBranchHeader("HEAD (no branch)")).toEqual({ branch: null, upstream: null, ahead: 0, behind: 0 });
  });
});
