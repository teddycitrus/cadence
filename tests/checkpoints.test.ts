import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreTree, snapshotTree } from "../src/chat/checkpoints";
import type { FakeRuntime } from "./helpers/fake-runtime";
import { until } from "./helpers/fake-runtime";
import { createGitFixture, gitOut, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";

describe("file checkpoints", () => {
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    fx?.cleanup();
    fx = null;
  });

  it("snapshots the working copy and restores it exactly, leaving staging and ignored files alone", async () => {
    fx = createGitFixture({ "README.md": "# demo\n", "src/math.js": "export const add = (a, b) => a + b;\n", ".gitignore": "dist/\n" });
    const dir = fx.repo;
    writeFileSync(join(dir, "draft.txt"), "an untracked note\n");
    gitOut(dir, "add", "README.md");
    const tree = (await snapshotTree(dir))!;
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(gitOut(dir, "status", "--porcelain")).toContain("?? draft.txt");

    // An agent edits, adds, and deletes; a build writes an ignored file.
    writeFileSync(join(dir, "src/math.js"), "export const add = (a, b) => a - b;\n");
    writeFileSync(join(dir, "src/new.js"), "export {};\n");
    rmSync(join(dir, "draft.txt"));
    writeFileSync(join(dir, "dist.js"), "x");
    writeFileSync(join(dir, ".gitignore"), "dist/\ndist.js\n");

    const r = await restoreTree(dir, tree);
    expect(readFileSync(join(dir, "src/math.js"), "utf8")).toBe("export const add = (a, b) => a + b;\n");
    expect(readFileSync(join(dir, "draft.txt"), "utf8")).toBe("an untracked note\n");
    expect(existsSync(join(dir, "src/new.js"))).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("dist/\n");
    expect(r.removed).toBeGreaterThanOrEqual(1);
    await expect(restoreTree(dir, "not-a-tree")).rejects.toThrow(/checkpoint/);
  });

  it("records a checkpoint with each message and restores files from the chat", async () => {
    fx = createGitFixture();
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "x", path: fx.repo, baseBranch: "main", githubRepo: null });
    const ws = await team.c.workspaces.createInProject(project.id, "Fix", "user");
    const chat = team.c.engine.createChat({ workspaceId: ws.id });
    const runtime = team.c.runtime as FakeRuntime;
    runtime.next(async () => {
      writeFileSync(join(ws.path, "src/math.js"), "broken\n");
      return "done";
    });
    await team.c.engine.send(chat.id, { text: "fix add" });
    await until(() => team.c.q.chat(chat.id)!.status === "idle");
    expect(readFileSync(join(ws.path, "src/math.js"), "utf8")).toBe("broken\n");
    const sent = team.c.q.chatItems(chat.id).find((i) => i.kind === "user")!;
    expect(sent.kind === "user" && sent.checkpoint).toMatch(/^[0-9a-f]{40}$/);
    expect((await team.local("POST", `/chats/${chat.id}/restore`, { seq: sent.seq })).status).toBe(200);
    expect(readFileSync(join(ws.path, "src/math.js"), "utf8")).toBe("export const add = (a, b) => a - b;\n");
    expect(team.c.q.chatItems(chat.id).at(-1)).toMatchObject({ kind: "notice", text: expect.stringContaining("Files restored") });
  });
});
