import { describe, expect, it, afterEach } from "vitest";
import { arrange } from "../src/canvas/arrange";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";

const f = (x: number, y: number, width = 100, height = 100) => ({ x, y, width, height });

describe("aligning and distributing frames", () => {
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    fx?.cleanup();
    fx = null;
  });

  it("aligns edges and centers, moving only what changes", () => {
    const frames = { A: f(0, 0), B: f(300, 50, 200, 100), C: f(150, 400, 100, 300) };
    expect(arrange(frames, "left")).toEqual({ B: f(0, 50, 200, 100), C: f(0, 400, 100, 300) });
    expect(arrange(frames, "right")).toEqual({ A: f(400, 0), C: f(400, 400, 100, 300) });
    expect(arrange(frames, "hcenter")).toEqual({ A: f(200, 0), B: f(150, 50, 200, 100), C: f(200, 400, 100, 300) });
    expect(arrange(frames, "top")).toEqual({ B: f(300, 0, 200, 100), C: f(150, 0, 100, 300) });
    expect(arrange(frames, "bottom")).toEqual({ A: f(0, 600), B: f(300, 600, 200, 100) });
    expect(arrange({ A: f(0, 0) }, "left")).toEqual({});
  });

  it("spaces three or more evenly, keeping the outermost in place", () => {
    const frames = { A: f(0, 0), B: f(120, 0, 50, 100), C: f(600, 0) };
    // 700 wide, 250 of frames: 225 between each.
    expect(arrange(frames, "distribute-h")).toEqual({ B: f(325, 0, 50, 100) });
    expect(arrange({ A: f(0, 0), B: f(0, 500) }, "distribute-v")).toEqual({});
  });

  it("arranges frames in the source, refusing locked ones", async () => {
    const canvas = [
      `export default { name: "App" };`,
      `export const A = { name: "A", html: "a.html", frame: { x: 0, y: 0, width: 100, height: 100 } };`,
      `export const B = { name: "B", html: "a.html", frame: { x: 300, y: 80, width: 100, height: 100 } };`,
      `export const C = { name: "C", html: "a.html", frame: { x: 600, y: 0, width: 100, height: 100 }, locked: true };`,
      ``,
    ].join("\n");
    fx = createGitFixture({ "app.canvas.tsx": canvas, "a.html": "<p>a</p>\n" });
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "x", path: fx.repo, baseBranch: "main", githubRepo: null });
    const ws = await team.c.workspaces.createInProject(project.id, "Design", "system");
    const url = `/workspaces/${ws.id}/canvas/arrange`;
    const done = await team.local("POST", url, { path: "app.canvas.tsx", storyIds: ["A", "B"], op: "top" });
    expect(done.status).toBe(200);
    expect(done.json.storyboards.map((s: { frame: { y: number } }) => s.frame.y)).toEqual([0, 0, 0]);
    expect((await team.local("POST", url, { path: "app.canvas.tsx", storyIds: ["A", "C"], op: "left" })).status).toBe(400);
    expect((await team.local("POST", url, { path: "app.canvas.tsx", storyIds: ["A", "Nope"], op: "left" })).status).toBe(400);
    expect((await team.local("POST", url, { path: "app.canvas.tsx", storyIds: ["A", "B"], op: "spin" })).status).toBe(400);
  });
});
