import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boardTools, callBoardTool } from "../src/agents/board-tools";
import { parseFigmaUrl } from "../src/canvas/figma";
import { canvasTools } from "../src/canvas/tools";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** Figma's REST API for one file with one frame. */
const figmaFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
  if (url.hostname === "figma-alpha-api.s3.us-west-2.amazonaws.com") return new Response(PNG_1X1);
  if ((init?.headers as Record<string, string>)?.["X-Figma-Token"] !== "figd_test") return json({ err: "forbidden" }, 403);
  if (url.pathname === "/v1/me") return json({ handle: "dana" });
  if (url.pathname === "/v1/files/AbC123/nodes") return json({ nodes: { "12:34": { document: { name: "Checkout / Mobile", absoluteBoundingBox: { width: 390, height: 844 } } } } });
  if (url.pathname === "/v1/images/AbC123") return json({ images: { "12:34": "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc.png" } });
  return json({ err: "not found" }, 404);
};

describe("canvas tools, comments, and Figma import", () => {
  let fx: GitFixture;
  let c: Container;
  let wsId: string;

  const boot = async () => {
    fx = createGitFixture({ "package.json": `{ "name": "demo" }\n`, "src/Card.tsx": "export const Card = () => <div>Card</div>;\n" });
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm, fetchImpl: figmaFetch });
    c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null });
    wsId = (await c.workspaces.createInProject(c.q.projects()[0]!.id, "design", "user")).id;
    booted = true;
  };

  let booted = false;
  afterEach(() => {
    if (!booted) return;
    booted = false;
    c.stop();
    c.db.close();
    fx.cleanup();
  });

  it("lets agents create and list canvases, and work comment threads", async () => {
    await boot();
    const tools = boardTools({ q: c.q, issues: c.issues, docs: c.docs, extra: canvasTools(c.canvases, c.canvasRender, c.q) });
    const ctx = { actor: "agent:designer" as const, runId: null, issueId: null, workspaceId: wsId };
    expect((await callBoardTool(tools, "canvas_list", {}, ctx)).text).toContain("No canvases yet");
    const created = await callBoardTool(tools, "canvas_create", { name: "Cards", storyboards: [{ id: "Default", name: "Default card", import: "../Card", component: "Card" }] }, ctx);
    expect(created.text).toBe("Created src/canvases/cards.canvas.tsx with 1 frame(s). People can open it under Canvases.");
    const source = readFileSync(join(c.q.workspace(wsId)!.path, "src/canvases/cards.canvas.tsx"), "utf8");
    expect(source).toContain(`import { Card } from "../Card";`);
    expect(source).toContain("render: () => <Card />");
    expect((await callBoardTool(tools, "canvas_list", {}, ctx)).text).toContain(`src/canvases/cards.canvas.tsx "Cards"\n  - Default "Default card" component at 0,0 800x600`);
    expect((await callBoardTool(tools, "canvas_list", {}, { ...ctx, workspaceId: null })).isError).toBe(true);

    const pin = c.canvases.comment(wsId, { canvasPath: "src/canvases/cards.canvas.tsx", storyId: "Default", x: 10, y: 20, parentId: null, body: "Padding feels tight" }, "user");
    const listed = await callBoardTool(tools, "canvas_comments", {}, ctx);
    expect(listed.text).toContain(`[${pin.id}] src/canvases/cards.canvas.tsx on Default\n  teammate: Padding feels tight`);
    expect((await callBoardTool(tools, "canvas_reply", { comment_id: pin.id, body: "Bumped to 24px", resolve: true }, ctx)).text).toBe("Replied and resolved.");
    const thread = c.canvases.comments(wsId);
    expect(thread).toHaveLength(2);
    expect(thread.find((x) => x.id === pin.id)!.resolved).toBe(true);
    expect(thread.find((x) => x.parentId === pin.id)).toMatchObject({ author: "agent:designer", body: "Bumped to 24px" });
    expect((await callBoardTool(tools, "canvas_comments", {}, ctx)).text).toBe("No open comments.");

    c.canvases.deleteComment(pin.id);
    expect(c.canvases.comments(wsId)).toEqual([]);
  });

  it("parses Figma links", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/AbC123/Shop?node-id=12-34&t=x")).toEqual({ fileKey: "AbC123", nodeId: "12:34" });
    expect(parseFigmaUrl("https://figma.com/file/AbC123/Shop?node-id=12%3A34")).toEqual({ fileKey: "AbC123", nodeId: "12:34" });
    expect(parseFigmaUrl("https://www.figma.com/design/AbC123/Shop")).toBeNull();
    expect(parseFigmaUrl("https://evil.example/design/AbC123?node-id=1-2")).toBeNull();
  });

  it("imports a Figma frame as a reference frame beside the others", async () => {
    await boot();
    const canvas = c.canvases.create(wsId, { name: "Checkout" });
    await expect(c.figma.import(wsId, canvas.path, "https://www.figma.com/design/AbC123/Shop?node-id=12-34")).rejects.toThrow(/Figma personal access token/);
    await expect(c.figma.saveToken("figd_wrong")).rejects.toThrow(/rejected/);
    expect(await c.figma.saveToken("figd_test")).toBe("dana");

    const out = await c.figma.import(wsId, canvas.path, "https://www.figma.com/design/AbC123/Shop?node-id=12-34");
    const story = out.storyboards.find((s) => s.kind === "html")!;
    expect(story).toMatchObject({ id: "FigmaCheckoutMobile", name: "Checkout / Mobile (Figma)", html: ".cadence/figma/checkout-mobile-12-34.html", frame: { x: 840, y: 0, width: 390, height: 844 } });
    const ws = c.q.workspace(wsId)!;
    expect(readFileSync(join(ws.path, ".cadence/figma/checkout-mobile-12-34.png"))).toEqual(PNG_1X1);
    expect(readFileSync(join(ws.path, ".cadence/figma/checkout-mobile-12-34.html"), "utf8")).toContain(`<img src="./checkout-mobile-12-34.png"`);

    // Importing the same frame again gets a distinct frame id.
    const again = await c.figma.import(wsId, canvas.path, "https://www.figma.com/design/AbC123/Shop?node-id=12-34");
    expect(again.storyboards.map((s) => s.id)).toEqual(["Starter", "FigmaCheckoutMobile", "FigmaCheckoutMobile2"]);
    expect(existsSync(join(fx.dataDir, "secrets.json"))).toBe(true);
  });
});
