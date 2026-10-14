import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { callBoardTool } from "../src/agents/board-tools";
import { cropPng, DesignContext } from "../src/canvas/design-context";
import { designContextTools } from "../src/canvas/design-context-tools";
import { makeContainer } from "./helpers/setup";
import { bootTeam } from "./helpers/team";

const element = { loc: "src/Card.tsx:12:4", tag: "button", className: "px-4 py-2 bg-violet-600", text: "Buy", rect: { x: 10, y: 20, width: 30, height: 10 }, ancestors: [{ loc: "src/Card.tsx:8:2", tag: "div", className: "card" }], count: 1 };

describe("selection context for outside agents", () => {
  it("keeps each person's open canvases to themselves and describes the selection", async () => {
    const { c } = makeContainer();
    const ws = await c.workspaces.createInProject(null, "UI", "user");
    const dc = new DesignContext();
    dc.report("me", { id: "tab1", workspaceId: ws.id, path: "src/card.canvas.tsx", storyId: null, element });
    dc.report("other", { id: "tab2", workspaceId: ws.id, path: "src/other.canvas.tsx", storyId: null, element: null });
    expect(() => dc.report("other", { id: "tab1", workspaceId: ws.id, path: "x.canvas.tsx", storyId: null, element: null })).toThrow(/someone else/);
    expect(dc.list("me").map((t) => t.id)).toEqual(["tab1"]);

    const tools = designContextTools(dc, c.canvasRender, c.q);
    const ctx = { actor: "token:t" as const, runId: null, issueId: null, ownerId: "me" };
    expect((await callBoardTool(tools, "design_context_targets", {}, ctx)).text).toContain("tab1: src/card.canvas.tsx");
    const got = await callBoardTool(tools, "design_context_get", {}, ctx);
    expect(got.text).toContain("Element: <button> at src/Card.tsx:12:4");
    expect(got.text).toContain("Classes: px-4 py-2 bg-violet-600");
    expect(got.text).toContain("- <div> src/Card.tsx:8:2 .card");
    expect(got.images).toEqual([]);

    dc.report("me", { id: "tab3", workspaceId: ws.id, path: "src/b.canvas.tsx", storyId: null, element });
    expect((await callBoardTool(tools, "design_context_get", {}, ctx)).text).toMatch(/Several canvases are open/);
    dc.close("me", "tab3");
    dc.close("me", "tab1");
    expect((await callBoardTool(tools, "design_context_get", {}, ctx)).isError).toBe(true);
  });

  it("crops the element out of a frame screenshot", () => {
    const img = new PNG({ width: 100, height: 60 });
    img.data.fill(255);
    const crop = PNG.sync.read(cropPng(PNG.sync.write(img), { x: 10, y: 20, width: 30, height: 10 }, 4)!);
    expect([crop.width, crop.height]).toEqual([38, 18]);
    expect(cropPng(PNG.sync.write(img), { x: 200, y: 0, width: 5, height: 5 })).toBeNull();
  });

  it("takes reports over HTTP only for the viewer's own views", async () => {
    const team = await bootTeam();
    try {
      const ws = await team.c.workspaces.createInProject(null, "UI", "user");
      expect((await team.local("PUT", "/design-context/v1", { workspaceId: ws.id, path: "a.canvas.tsx", storyId: "Primary", element })).status).toBe(200);
      const mia = await team.join("member", "Mia");
      expect((await mia.call("PUT", "/design-context/v1", { workspaceId: ws.id, path: "a.canvas.tsx", storyId: null, element: null })).status).toBe(403);
      expect(team.c.designContext.list("me").map((t) => t.storyId)).toEqual(["Primary"]);
      expect(team.c.designContext.list(mia.id)).toEqual([]);
      await team.local("DELETE", "/design-context/v1");
      expect(team.c.designContext.list("me")).toEqual([]);
    } finally {
      team.close();
    }
  });
});
