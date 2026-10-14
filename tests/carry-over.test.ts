import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

describe("new workspaces and the project folder's uncommitted work", () => {
  let fx: GitFixture;
  let c: Container;
  afterEach(() => {
    c.stop();
    c.db.close();
    fx.cleanup();
  });

  const boot = () => {
    fx = createGitFixture({ "README.md": "# demo\n", "src/math.js": "export const add = (a, b) => a + b;\n", "old.txt": "gone soon\n", ".gitignore": "node_modules/\n" });
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
    const project = c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null });
    // Local work nobody has committed yet.
    writeFileSync(join(fx.repo, "src/math.js"), "export const add = (a, b) => a + b + 0;\n");
    mkdirSync(join(fx.repo, "notes"), { recursive: true });
    writeFileSync(join(fx.repo, "notes/plan.md"), "# plan\n");
    rmSync(join(fx.repo, "old.txt"));
    mkdirSync(join(fx.repo, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(fx.repo, "node_modules/pkg/index.js"), "ignored\n");
    return project;
  };

  it("brings it into a workspace a person creates, and leaves the project folder as it was", async () => {
    const project = boot();
    const ws = await c.workspaces.createInProject(project.id, "Mine", "user");
    expect(readFileSync(join(ws.path, "src/math.js"), "utf8")).toContain("+ 0");
    expect(readFileSync(join(ws.path, "notes/plan.md"), "utf8")).toBe("# plan\n");
    expect(existsSync(join(ws.path, "old.txt"))).toBe(false);
    expect(existsSync(join(ws.path, "node_modules/pkg/index.js"))).toBe(false);
    expect(c.workspaces.takeCarried(ws.id)).toEqual({ copied: 2, deleted: 1, skipped: null });
    expect(c.workspaces.takeCarried(ws.id)).toBeNull();
    // The project folder is untouched.
    expect(readFileSync(join(fx.repo, "notes/plan.md"), "utf8")).toBe("# plan\n");
    expect(existsSync(join(fx.repo, "old.txt"))).toBe(false);
  });

  it("starts an agent's workspace from the last commit", async () => {
    const project = boot();
    const agent = c.agents.createAgent({ name: "Builder", prompt: "x", enabled: true, triggers: [] });
    const ws = await c.workspaces.createInProject(project.id, "Agent work", `agent:${agent.id}`);
    expect(readFileSync(join(ws.path, "src/math.js"), "utf8")).not.toContain("+ 0");
    expect(existsSync(join(ws.path, "notes/plan.md"))).toBe(false);
    expect(existsSync(join(ws.path, "old.txt"))).toBe(true);
    expect(c.workspaces.takeCarried(ws.id)).toBeNull();
  });
});
