import { afterEach, describe, expect, it } from "vitest";
import { createGitFixture, gitOut, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";

const CANVAS = `export default { name: "App" };\nexport const Home = { name: "Home", html: "index.html" };\nexport const About = { name: "About", html: "index.html" };\n`;

describe("canvas home and comment threads", { timeout: 60_000 }, () => {
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    fx?.cleanup();
    fx = null;
  });

  it("lists canvases on branches nobody has open, opens them, pins them, and picks a cover", async () => {
    fx = createGitFixture({ "README.md": "# x\n", "app.canvas.tsx": CANVAS, "index.html": "<p>hi</p>\n" });
    gitOut(fx.repo, "checkout", "-q", "-b", "redesign");
    gitOut(fx.repo, "-c", "user.name=T", "-c", "user.email=t@e.x", "mv", "app.canvas.tsx", "new.canvas.tsx");
    gitOut(fx.repo, "-c", "user.name=T", "-c", "user.email=t@e.x", "commit", "-q", "-m", "rename");
    gitOut(fx.repo, "checkout", "-q", "main");
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "x", path: fx.repo, baseBranch: "main", githubRepo: null });

    const list = (await team.local("GET", "/canvases")).json as unknown as { workspaceId: string | null; branch: string; path: string; name: string }[];
    expect(list.map((e) => [e.branch, e.path, e.workspaceId])).toEqual(
      expect.arrayContaining([
        ["main", "app.canvas.tsx", null],
        ["redesign", "new.canvas.tsx", null],
      ]),
    );
    const opened = await team.local("POST", "/canvases/open", { projectId: project.id, branch: "redesign" });
    const ws = team.c.q.workspace(opened.json.workspaceId)!;
    expect(ws.branch).toBe("redesign");
    // Opening it again reuses the workspace; the branch now lists as open.
    expect((await team.local("POST", "/canvases/open", { projectId: project.id, branch: "redesign" })).json.workspaceId).toBe(ws.id);
    const again = (await team.local("GET", "/canvases")).json as unknown as { workspaceId: string | null; branch: string }[];
    expect(again.filter((e) => e.branch === "redesign").map((e) => e.workspaceId)).toEqual([ws.id]);
    // The base branch is checked out in the project folder, so it opens on a fresh branch.
    const fromMain = team.c.q.workspace((await team.local("POST", "/canvases/open", { projectId: project.id, branch: "main" })).json.workspaceId)!;
    expect(fromMain.branch).toMatch(/^cadence\//);
    expect((await team.local("POST", "/canvases/open", { projectId: project.id, branch: "nope" })).status).toBe(404);

    const key = `${ws.id}|new.canvas.tsx`;
    expect((await team.local("PUT", "/canvases/pins", { key, on: true })).json.pinnedCanvases).toEqual([key]);
    expect((await team.local("PUT", "/canvases/pins", { key, on: false })).json.pinnedCanvases).toEqual([]);

    const cover = await team.local("PUT", `/workspaces/${ws.id}/canvas/cover`, { path: "new.canvas.tsx", storyId: "About" });
    expect(cover.json.cover).toBe("About");
    expect((await team.local("PUT", `/workspaces/${ws.id}/canvas/cover`, { path: "new.canvas.tsx", storyId: "Nope" })).status).toBe(404);
  });

  it("edits, moves, reads, and deletes comments with the right permissions", async () => {
    fx = createGitFixture({ "README.md": "# x\n", "app.canvas.tsx": CANVAS, "index.html": "<p>hi</p>\n" });
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "x", path: fx.repo, baseBranch: "main", githubRepo: null });
    const ws = await team.c.workspaces.createInProject(project.id, "One", "user");
    const other = await team.c.workspaces.createInProject(project.id, "Two", "user");
    const base = `/workspaces/${ws.id}/canvas/comments`;
    const member = await team.join("member", "Mo");
    const root = (await team.local("POST", base, { canvasPath: "app.canvas.tsx", x: 10, y: 20, body: "Too tight" })).json;
    const reply = (await member.call("POST", base, { canvasPath: "app.canvas.tsx", x: 10, y: 20, parentId: root.id, body: "Agreed" })).json;

    expect((await member.call("PUT", `${base}/${root.id}/body`, { body: "hijack" })).status).toBe(403);
    expect((await team.local("PUT", `${base}/${root.id}/body`, { body: "Too tight on mobile" })).json).toMatchObject({ body: "Too tight on mobile", editedAt: expect.any(String) });
    expect((await team.local("PUT", `${base}/${root.id}/position`, { x: 50, y: 60 })).json).toMatchObject({ x: 50, y: 60 });
    expect((await team.local("PUT", `${base}/${reply.id}/position`, { x: 1 })).status).toBe(400);

    await team.local("POST", `${base}/${root.id}/read`);
    const read = team.c.q.canvasComments(ws.id).find((c) => c.id === root.id)!;
    expect(Object.keys(read.readBy ?? {})).toEqual(["me"]);
    const count = team.c.store.count();
    await team.local("POST", `${base}/${root.id}/read`);
    expect(team.c.store.count()).toBe(count);

    const activity = (await team.local("GET", `/workspaces/${ws.id}/canvas/activity?path=app.canvas.tsx`)).json as unknown as { kind: string; text: string }[];
    expect(activity.filter((a) => a.kind === "comment").map((a) => a.text).sort()).toEqual(["Agreed", "Too tight on mobile"]);
    expect(activity.some((a) => a.kind === "commit")).toBe(true);

    // Moving the thread takes its replies along.
    await team.local("PUT", `${base}/${root.id}/position`, { workspaceId: other.id });
    expect(team.c.q.canvasComments(ws.id)).toHaveLength(0);
    expect(team.c.q.canvasComments(other.id).map((c) => c.body).sort()).toEqual(["Agreed", "Too tight on mobile"]);

    const otherBase = `/workspaces/${other.id}/canvas/comments`;
    expect((await member.call("DELETE", `${otherBase}/${root.id}`)).status).toBe(403);
    expect((await member.call("DELETE", `${otherBase}/${reply.id}`)).status).toBe(200);
    expect(team.c.q.canvasComments(other.id)).toHaveLength(1);
  });
});
