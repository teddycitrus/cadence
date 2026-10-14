import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callBoardTool } from "../src/agents/board-tools";
import { layoutFrames, moreCanvasTools } from "../src/canvas/tools-more";
import type { Ephemeral } from "../src/core/bus";
import { makeContainer } from "./helpers/setup";

describe("canvas agent protocol and checks", () => {
  it("lays new frames out in rows below the existing ones", () => {
    expect(layoutFrames([], [{ width: 400, height: 300 }])).toEqual([{ x: 0, y: 0, width: 400, height: 300 }]);
    const frames = layoutFrames([{ x: 0, y: 0, width: 800, height: 600 }], [{ width: 1600, height: 200 }, { width: 1600, height: 400 }, { width: 300, height: 100 }]);
    expect(frames).toEqual([
      { x: 0, y: 680, width: 1600, height: 200 },
      // 1600 + 80 + 1600 passes 3000, so it wraps.
      { x: 0, y: 960, width: 1600, height: 400 },
      { x: 1680, y: 960, width: 300, height: 100 },
    ]);
  });

  it("brackets an editing session, validates, shares, and deletes a canvas", async () => {
    const { c } = makeContainer();
    const ws = await c.workspaces.createInProject(null, "Design", "user");
    execFileSync("git", ["init", "-q", ws.path], { stdio: "pipe" });
    const seen: Ephemeral[] = [];
    c.bus.subscribe((e) => seen.push(e));
    const tools = [...c.workspaceTools()];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["canvas_start_working", "canvas_validate", "canvas_guide"]));
    const ctx = { actor: "agent:a1" as const, runId: null, issueId: null, workspaceId: ws.id };

    mkdirSync(join(ws.path, "src"), { recursive: true });
    writeFileSync(join(ws.path, "src/Button.tsx"), "export const Button = () => <button>Go</button>;\n");
    writeFileSync(
      join(ws.path, "src/ui.canvas.tsx"),
      [
        'import { Button } from "./Button";',
        'import { Missing } from "./Nope";',
        'export default { name: "UI" };',
        "export const A = { name: \"A\", render: () => <Button />, frame: { x: 0, y: 0, width: 300, height: 200 } };",
        "export const B = { name: \"B\", render: () => <Missing />, frame: { x: 100, y: 50, width: 300, height: 200 } };",
        'export const Page = { name: "Page", html: "mockups/none.html", frame: { x: 0, y: 400, width: 300, height: 200 } };',
      ].join("\n"),
    );

    await callBoardTool(tools, "canvas_start_working", { path: "src/ui.canvas.tsx" }, ctx);
    expect(c.canvasEditing.list(ws.id)).toEqual([expect.objectContaining({ path: "src/ui.canvas.tsx", actor: "agent:a1" })]);
    const validation = (await callBoardTool(tools, "canvas_validate", { path: "src/ui.canvas.tsx" }, ctx)).text;
    expect(validation).toContain("A and B overlap");
    expect(validation).toContain("Import ./Nope does not resolve");
    expect(validation).toContain("mockups/none.html does not exist");
    expect(validation).not.toContain("./Button");

    const layout = JSON.parse((await callBoardTool(tools, "canvas_layout", { path: "src/ui.canvas.tsx", sizes: [{ width: 200, height: 100 }] }, ctx)).text);
    expect(layout[0].y).toBe(680);

    expect((await callBoardTool(tools, "canvas_finish_working", { path: "src/ui.canvas.tsx" }, ctx)).text).toBe("Done; views refreshed.");
    expect(c.canvasEditing.list(ws.id)).toEqual([]);
    expect(seen.map((e) => e.type)).toEqual(["canvas_editing", "canvas_refresh", "canvas_editing"]);

    // One main canvas per workspace.
    writeFileSync(join(ws.path, "src/home.canvas.tsx"), 'export default { name: "Home", home: true };\nexport const Root = { name: "Root", route: "/", frame: { x: 0, y: 0, width: 1280, height: 800 } };\n');
    await callBoardTool(tools, "canvas_set_home", { path: "src/ui.canvas.tsx" }, ctx);
    expect((await c.canvases.list(ws.id)).filter((x) => x.home).map((x) => x.path)).toEqual(["src/ui.canvas.tsx"]);

    expect((await callBoardTool(tools, "canvas_share", { path: "src/ui.canvas.tsx" }, ctx)).text).toMatch(/#\/share\//);
    expect((await callBoardTool(tools, "canvas_guide", {}, ctx)).text).toContain("canvas_finish_working exactly once");
    await callBoardTool(tools, "canvas_delete", { path: "src/ui.canvas.tsx", confirm: true }, ctx);
    expect(existsSync(join(ws.path, "src/ui.canvas.tsx"))).toBe(false);
  });
});
