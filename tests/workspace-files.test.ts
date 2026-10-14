import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteWorkspaceFile, listImages, MAX_FILE_BYTES, readWorkspaceFile, renameWorkspaceFile, resolveIn, searchFiles, writeWorkspaceFile } from "../src/workspaces/files";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";
import { removeTempDir } from "./helpers/temp-dir";

describe("workspace files", () => {
  const dirs: string[] = [];
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    fx?.cleanup();
    fx = null;
    for (const d of dirs.splice(0)) removeTempDir(d);
  });

  it("keeps every path inside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "cadence-files-"));
    const outside = mkdtempSync(join(tmpdir(), "cadence-outside-"));
    dirs.push(root, outside);
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/Windows/x", ".git/config", "node_modules/a/index.js", "", "."]) expect(() => resolveIn(root, bad), bad).toThrow();
    expect(resolveIn(root, "./src\\app.ts").clean).toBe("src/app.ts");
    // A link inside the workspace that points outside it is refused.
    try {
      symlinkSync(outside, join(root, "escape"), "junction");
      expect(() => resolveIn(root, "escape/secret.txt")).toThrow(/outside/);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    }
  });

  it("reads text, refuses binary and huge files, and writes, renames, and deletes", () => {
    const root = mkdtempSync(join(tmpdir(), "cadence-files-"));
    dirs.push(root);
    writeFileSync(join(root, "a.txt"), "hello");
    writeFileSync(join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(root, "big.log"), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
    expect(readWorkspaceFile(root, "a.txt")).toEqual({ path: "a.txt", text: "hello", size: 5, reason: null });
    expect(readWorkspaceFile(root, "img.png")).toMatchObject({ text: null, reason: "binary" });
    expect(readWorkspaceFile(root, "big.log")).toMatchObject({ text: null, reason: "too_large" });
    expect(() => writeWorkspaceFile(root, "new/file.ts", "x")).toThrow(/not found/);
    writeWorkspaceFile(root, "new/file.ts", "export {};\n", { create: true });
    expect(() => writeWorkspaceFile(root, "new/file.ts", "", { create: true })).toThrow(/already exists/);
    writeWorkspaceFile(root, "new/file.ts", "export const x = 1;\n");
    expect(readFileSync(join(root, "new/file.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(renameWorkspaceFile(root, "new/file.ts", "lib/x.ts")).toBe("lib/x.ts");
    expect(existsSync(join(root, "new/file.ts"))).toBe(false);
    deleteWorkspaceFile(root, "lib/x.ts");
    expect(existsSync(join(root, "lib/x.ts"))).toBe(false);
  });

  it("lists the images an app serves from public or static folders", async () => {
    fx = createGitFixture({ "public/hero.png": "x", "apps/web/static/img/logo.svg": "<svg/>", "src/assets/icon.png": "x", "public/notes.txt": "x" });
    expect(await listImages(fx.repo)).toEqual([
      { url: "/img/logo.svg", path: "apps/web/static/img/logo.svg" },
      { url: "/hero.png", path: "public/hero.png" },
    ]);
  });

  it("searches files like an editor's find in files", async () => {
    fx = createGitFixture({ "README.md": "# Shop\nAdd to cart\n", "src/cart.ts": "export const addToCart = () => 1;\nconst cartTotal = 2;\n", ".gitignore": "dist/\n" });
    mkdirSync(join(fx.repo, "dist"), { recursive: true });
    writeFileSync(join(fx.repo, "dist/out.js"), "addToCart");
    writeFileSync(join(fx.repo, "notes.md"), "remember the cart\n");
    const plain = await searchFiles(fx.repo, "cart");
    expect(plain.hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual(["README.md:2", "notes.md:1", "src/cart.ts:1", "src/cart.ts:2"]);
    expect((await searchFiles(fx.repo, "cart", { word: true })).hits.map((h) => h.path).sort()).toEqual(["README.md", "notes.md"]);
    expect((await searchFiles(fx.repo, "Cart", { matchCase: true })).hits.map((h) => h.path)).toEqual(["src/cart.ts"]);
    expect((await searchFiles(fx.repo, "add[A-Z]\\w+", { regex: true, matchCase: true })).hits).toHaveLength(1);
    expect((await searchFiles(fx.repo, "")).hits).toEqual([]);
  });

  it("compares a workspace with any branch, and adds browser pages to a canvas", async () => {
    fx = createGitFixture({ "README.md": "# shop\n" });
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "shop", path: fx.repo, baseBranch: "main", githubRepo: null });
    const a = await team.c.workspaces.createInProject(project.id, "A", "system");
    const b = await team.c.workspaces.createInProject(project.id, "B", "system");
    writeFileSync(join(b.path, "b.txt"), "b\n");
    expect((await team.local("GET", `/workspaces/${b.id}/status`)).json.files.map((f: { path: string }) => f.path)).toEqual(["b.txt"]);
    expect((await team.local("GET", `/workspaces/${b.id}/status?against=${encodeURIComponent(a.branch!)}`)).json.baseBranch).toBe(a.branch);
    expect((await team.local("GET", `/workspaces/${b.id}/diff?path=b.txt&against=${encodeURIComponent(a.branch!)}`)).json.diff).toContain("+b");
    expect((await team.local("GET", `/workspaces/${b.id}/status?against=nope`)).status).toBe(400);
    expect((await team.local("GET", `/workspaces/${b.id}/status?against=--output=x`)).status).toBe(400);

    const first = (await team.local("POST", `/workspaces/${a.id}/canvas/add-page`, { url: "http://localhost:5173/settings/profile?tab=2" })).json;
    expect(first.appUrl).toBe("http://localhost:5173");
    const again = (await team.local("POST", `/workspaces/${a.id}/canvas/add-page`, { url: "http://localhost:5173/settings/profile?tab=2" })).json;
    const [p1, p2] = again.storyboards.slice(-2) as { id: string; route: string; frame: { x: number; width: number } }[];
    expect([p1!.id, p1!.route, p2!.id, p2!.route]).toEqual(["SettingsProfileTab2", "/settings/profile?tab=2", "SettingsProfileTab22", "/settings/profile?tab=2"]);
    expect(p2!.frame.x).toBe(p1!.frame.x + p1!.frame.width + 80);
    expect((await team.local("POST", `/workspaces/${a.id}/canvas/add-page`, { url: "https://example.com/" })).status).toBe(400);

    // A code review runs in a new chat that reports findings.
    const review = await team.local("POST", `/workspaces/${b.id}/git/review`, { deep: true });
    expect(review.status).toBe(201);
    const chat = team.c.q.chat(review.json.chatId)!;
    expect([chat.title, chat.effort, chat.workspaceId]).toEqual(["Deep code review", "xhigh", b.id]);
    expect(JSON.stringify(team.c.q.chatItems(chat.id))).toContain("report_findings");
  });

  it("serves the tree and edits over the API, leaving @-mention search alone", async () => {
    fx = createGitFixture({ "README.md": "# shop\n", "src/app.ts": "export const app = 1;\n" });
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "shop", path: fx.repo, baseBranch: "main", githubRepo: null });
    const ws = await team.c.workspaces.createInProject(project.id, "Edit", "system");
    mkdirSync(join(ws.path, "notes"), { recursive: true });
    writeFileSync(join(ws.path, "notes/todo.md"), "- ship\n");
    expect((await team.local("GET", `/workspaces/${ws.id}/files/tree`)).json).toEqual(["README.md", "notes/todo.md", "src/app.ts"]);
    expect((await team.local("GET", `/workspaces/${ws.id}/files?q=app`)).json).toEqual({ files: ["src/app.ts"] });
    expect((await team.local("GET", `/workspaces/${ws.id}/files/content?path=src/app.ts`)).json.text).toBe("export const app = 1;\n");
    expect((await team.local("PUT", `/workspaces/${ws.id}/files/content`, { path: "src/app.ts", text: "export const app = 2;\n" })).status).toBe(200);
    expect(readFileSync(join(ws.path, "src/app.ts"), "utf8")).toBe("export const app = 2;\n");
    expect((await team.local("GET", `/workspaces/${ws.id}/files/content?path=../../secrets`)).status).toBe(400);
    const member = await team.join("member", "Mo");
    expect((await member.call("GET", `/workspaces/${ws.id}/files/content?path=README.md`)).status).toBe(200);
    expect((await member.call("PUT", `/workspaces/${ws.id}/files/content`, { path: "README.md", text: "x" })).status).toBe(403);
  });
});
