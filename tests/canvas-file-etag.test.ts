import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";

const CANVAS = `export default { name: "App" };\nexport const Home = { name: "Home", html: "index.html" };\n`;

describe("re-reading an open canvas", { timeout: 60_000 }, () => {
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    fx?.cleanup();
    fx = null;
  });

  it("answers 304 while the file is unchanged and the new file once it changes", async () => {
    fx = createGitFixture({ "app.canvas.tsx": CANVAS, "index.html": "<p>hi</p>\n" });
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "x", path: fx.repo, baseBranch: "main", githubRepo: null });
    const opened = await team.local("POST", "/canvases/open", { projectId: project.id, branch: "main" });
    const ws = team.c.q.workspace(opened.json.workspaceId as string)!;
    await team.c.workspaces.ensureOnDisk(ws);
    const url = `${team.localBase}/workspaces/${ws.id}/canvas/file?path=app.canvas.tsx`;

    const first = await fetch(url);
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\//);
    expect(((await first.json()) as { source: string }).source).toBe(CANVAS);
    expect((await fetch(url, { headers: { "If-None-Match": tag } })).status).toBe(304);

    const changed = CANVAS.replace('"Home"', '"Landing"');
    writeFileSync(join(ws.path, "app.canvas.tsx"), changed);
    utimesSync(join(ws.path, "app.canvas.tsx"), new Date(), new Date(Date.now() + 5000));
    const after = await fetch(url, { headers: { "If-None-Match": tag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(tag);
    expect(((await after.json()) as { source: string }).source).toBe(changed);
  });
});
