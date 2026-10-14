import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseCanvas } from "../src/canvas/parse";
import { cloneRepo, openFolder, repoName, scaffoldProject } from "../src/projects/starter";
import type { FakeRuntime } from "./helpers/fake-runtime";
import { until } from "./helpers/fake-runtime";
import { createGitFixture, gitOut, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";
import { removeTempDir } from "./helpers/temp-dir";

describe("starting projects", () => {
  let dir: string;
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    fx?.cleanup();
    fx = null;
    removeTempDir(dir);
  });

  it("scaffolds prototype, mockup, and blank projects as committed repositories", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-start-"));
    const proto = await scaffoldProject(dir, "prototype", "Habit Tracker", { install: false });
    expect(proto).toMatch(/habit-tracker$/);
    expect(gitOut(proto, "log", "--oneline")).toContain("Start Habit Tracker");
    expect(JSON.parse(readFileSync(join(proto, "package.json"), "utf8"))).toMatchObject({ name: "habit-tracker", scripts: { dev: "vite" } });
    expect(parseCanvas(readFileSync(join(proto, "src/app.canvas.tsx"), "utf8")).storyboards.map((s) => s.kind)).toEqual(["route", "route"]);
    const mock = await scaffoldProject(dir, "mockup", "Habit Tracker");
    expect(mock).toMatch(/habit-tracker-2$/);
    expect(parseCanvas(readFileSync(join(mock, "mockups.canvas.tsx"), "utf8")).storyboards.map((s) => s.html)).toEqual(["mockups/index.html", "mockups/index.html"]);
    const blank = await scaffoldProject(dir, "blank", "Empty");
    expect(gitOut(blank, "ls-files")).toBe(".gitignore");
  });

  it("opens repositories and empty folders, and asks before starting git in a folder with files", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-open-"));
    fx = createGitFixture();
    mkdirSync(join(fx.repo, "packages", "web"), { recursive: true });
    // A subfolder of a repository opens the repository.
    expect((await openFolder(join(fx.repo, "packages", "web"))).path.toLowerCase()).toBe(fx.repo.toLowerCase());
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(await openFolder(empty)).toEqual({ path: empty, initialized: true });
    expect(gitOut(empty, "log", "--oneline")).toContain("Start project");
    const full = join(dir, "full");
    mkdirSync(full);
    writeFileSync(join(full, "notes.txt"), "hi");
    await expect(openFolder(full)).rejects.toThrow(/not a git repository yet/);
    expect((await openFolder(full, { initialize: true })).initialized).toBe(true);
    expect(gitOut(full, "ls-files")).toContain("notes.txt");
  });

  it("clones repositories and refuses URLs that are not git remotes", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-clone-"));
    fx = createGitFixture();
    expect(repoName("https://github.com/acme/web-app.git")).toBe("web-app");
    expect(repoName("git@github.com:acme/api.git")).toBe("api");
    const cloned = await cloneRepo(join(dir, "repos"), pathToFileURL(fx.repo).href);
    expect(existsSync(join(cloned, ".git"))).toBe(true);
    await expect(cloneRepo(dir, "--upload-pack=evil")).rejects.toThrow(/git URL/);
    await expect(cloneRepo(dir, "javascript:alert(1)")).rejects.toThrow(/git URL/);
    await expect(cloneRepo(join(dir, "repos"), pathToFileURL(join(dir, "nothing-here")).href)).rejects.toThrow(/Could not clone/);
  });

  it("generates a project with a workspace and an agent already working, for admins only", async () => {
    const team = await bootTeam();
    close = team.close;
    dir = team.c.dataDir;
    const runtime = team.c.runtime as FakeRuntime;
    runtime.next(async () => "done");
    const r = await team.local("POST", "/start/generate", { kind: "mockup", idea: "A pricing page for a sauna rental" });
    expect(r.status).toBe(201);
    const project = team.c.q.project(r.json.projectId)!;
    expect(project).toMatchObject({ name: "A pricing page for a", baseBranch: "main", setupScript: null });
    expect(team.c.q.workspace(r.json.workspaceId)).toMatchObject({ projectId: project.id });
    await until(() => team.c.q.chatItems(r.json.chatId).some((i) => i.kind === "user"));
    const task = team.c.q.chatItems(r.json.chatId).find((i) => i.kind === "user")!;
    expect(task.kind === "user" && task.text).toContain("A pricing page for a sauna rental");
    expect((await team.local("POST", "/start/generate", { kind: "mockup", idea: "" })).status).toBe(400);
    const opened = await team.local("POST", "/start/open", { path: project.path });
    expect(opened.status).toBe(409);
    const notGit = join(team.c.dataDir, "loose");
    mkdirSync(notGit);
    writeFileSync(join(notGit, "a.txt"), "x");
    expect((await team.local("POST", "/start/open", { path: notGit })).json).toMatchObject({ needsInit: true });
    expect((await team.local("POST", "/start/open", { path: notGit, initialize: true })).status).toBe(201);
    const member = await team.join("member", "Mo");
    expect((await member.call("POST", "/start/generate", { kind: "blank" })).status).toBe(403);
  });

  it("records onboarding answers and starts the starter agents in their own workspaces", async () => {
    fx = createGitFixture();
    const team = await bootTeam();
    close = team.close;
    dir = team.c.dataDir;
    const project = team.c.agents.addProject({ name: "shop", path: fx.repo, baseBranch: "main", githubRepo: null });
    expect((await team.local("PUT", "/members/me/onboarding", { jobRole: "designer" })).json).toMatchObject({ jobRole: "designer" });
    expect((await team.local("PUT", "/members/me/onboarding", { jobRole: "astronaut" })).status).toBe(400);
    const tasks = (await team.local("GET", "/start/tasks")).json as unknown as { id: string; needsNote: boolean }[];
    expect(tasks.map((t) => t.id)).toEqual(["plan-feature", "component-map", "check-ci", "start-agents"]);
    expect((await team.local("POST", "/start/tasks", { task: "plan-feature", projectId: project.id })).status).toBe(400);
    (team.c.runtime as FakeRuntime).next(async () => "done");
    const started = await team.local("POST", "/start/tasks", { task: "check-ci", projectId: project.id });
    expect(started.status).toBe(201);
    expect(team.c.q.workspace(started.json.workspaceId)).toMatchObject({ name: "Check my tests and CI", projectId: project.id });
    await until(() => team.c.q.chatItems(started.json.chatId).some((i) => i.kind === "user"));
    const task = team.c.q.chatItems(started.json.chatId).find((i) => i.kind === "user")!;
    expect(task.kind === "user" && task.text).toContain("CI and test audit");
    const done = await team.local("PUT", "/members/me/onboarding", { done: true });
    expect(done.json.onboardedAt).toEqual(expect.any(String));
  });
});
