import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { PNG } from "pngjs";
import { createApp } from "../src/server/app";
import { findChrome } from "../src/canvas/browser";
import { canvasTools } from "../src/canvas/tools";
import { callBoardTool, toolContent } from "../src/agents/board-tools";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

const BUTTON = `export function Button({ label }: { label: string }) {
  return (
    <button style={{ background: "#2563eb", color: "#ffffff", padding: 12, border: "none" }}>{label}</button>
  );
}
`;

const CANVAS = `import { Button } from "./Button";

export default { name: "Payments", background: "#111111" };

export const Primary = {
  name: "Primary button",
  render: () => (
    <div style={{ padding: 24, background: "#ffffff", height: "100%" }}>
      <Button label="Pay now" />
    </div>
  ),
  frame: { x: 0, y: 0, width: 240, height: 120 },
};

export const Home = { name: "Home route", route: "/", frame: { x: 300, y: 0, width: 240, height: 120 } };
`;

const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="/src/main.tsx"></script></body></html>
`;
const MAIN = `import { createRoot } from "react-dom/client";
import { Button } from "./Button";
createRoot(document.getElementById("app")!).render(<div style={{ padding: 24, background: "#ffffff", height: "100vh" }}><Button label="Home" /></div>);
`;

// Drives a real Vite devserver (and Chrome, when installed) over a tiny React project.
describe("canvas devserver and rendering", () => {
  let fx: GitFixture;
  let c: Container;
  let wsId: string;
  const hasChrome = Boolean(findChrome());

  beforeAll(async () => {
    fx = createGitFixture({ "package.json": `{ "name": "demo", "private": true, "type": "module" }\n`, ".gitignore": "node_modules\n", "src/Button.tsx": BUTTON, "src/payments.canvas.tsx": CANVAS, "index.html": INDEX_HTML, "src/main.tsx": MAIN });
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm, uiOrigins: ["http://127.0.0.1:4317"] });
    c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null });
    wsId = (await c.workspaces.createInProject(c.q.projects()[0]!.id, "design", "user")).id;
  }, 60_000);

  afterAll(async () => {
    c.stop();
    await c.canvasDev.stopAll();
    c.db.close();
    await new Promise((r) => setTimeout(r, 500));
    fx.cleanup();
  });

  it("lists canvases from git and parses their frames", async () => {
    const list = await c.canvases.list(wsId);
    expect(list.map((x) => [x.path, x.name, x.storyboards.map((s) => s.id)])).toEqual([["src/payments.canvas.tsx", "Payments", ["Primary", "Home"]]]);
  });

  it("serves a frame page, the bridge, and source-stamped modules", async () => {
    const dev = await c.canvasDev.ensure(wsId);
    expect(dev.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await (await fetch(`${dev.url}/__cadence/story?canvas=src%2Fpayments.canvas.tsx&story=Primary`)).text();
    expect(page).toContain("/@cadence/bridge");
    expect(page).toContain("/@cadence/story?canvas=src%2Fpayments.canvas.tsx");
    const bridge = await (await fetch(`${dev.url}/@cadence/bridge`)).text();
    expect(bridge).toContain(`["http://127.0.0.1:4317"]`);
    const button = await (await fetch(`${dev.url}/src/Button.tsx`)).text();
    expect(button).toContain(`"data-cadence-loc": "src/Button.tsx:3:4"`);
    // Path tricks in the story entry are refused.
    // Route frames load the app itself, which gets the bridge too.
    const app = await (await fetch(`${dev.url}/`)).text();
    expect(app).toContain("/@cadence/bridge");
    expect(app).toContain("/src/main.tsx");
    const evil = await (await fetch(`${dev.url}/@cadence/story?canvas=..%2F..%2Fsecret.canvas.tsx&story=X`)).text();
    expect(evil).toContain("Invalid frame reference");
  }, 60_000);

  it("writes style panel edits to source, and stages what it cannot write", async () => {
    const r = c.canvases.editElement(wsId, "src/Button.tsx:3:4", { styles: { padding: "16", radius: "8" } });
    expect(r).toEqual({ applied: true, via: "style", file: "src/Button.tsx" });
    const ws = c.q.workspace(wsId)!;
    expect(readFileSync(join(ws.path, "src/Button.tsx"), "utf8")).toContain(`padding: "16px", border: "none", borderRadius: "8px"`);
    // The canvas <div> has a literal style too, but text inside a component call is not plain text.
    const staged = c.canvases.editElement(wsId, "src/payments.canvas.tsx:8:4", { text: "Hello" });
    expect(staged).toMatchObject({ applied: false, via: "ledger" });
    expect(c.canvases.ledger(wsId)).toEqual([expect.objectContaining({ loc: "src/payments.canvas.tsx:8:4", description: 'text: "Hello"' })]);
    expect(c.canvases.takeLedger(wsId)).toContain('1. Element at src/payments.canvas.tsx:8:4: text: "Hello"');
    expect(c.canvases.ledger(wsId)).toEqual([]);
    expect(() => c.canvases.editElement(wsId, "../outside.tsx:1:0", { text: "x" })).toThrow(/Invalid path/);

    // Over HTTP too: the style panel sends one property at a time.
    const server = createApp(c, { apiToken: null, staticDir: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/${wsId}/canvas/element`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loc: "src/Button.tsx:3:4", change: { styles: { opacity: "1" } } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ applied: true, via: "style", file: "src/Button.tsx" });
    } finally {
      server.close();
    }
  });

  it.runIf(hasChrome)(
    "renders frames in Chrome and catches visual changes",
    async () => {
      const shot = await c.canvasRender.screenshot(wsId, "src/payments.canvas.tsx", "Primary");
      expect(shot.subarray(1, 4).toString()).toBe("PNG");
      expect(shot.readUInt32BE(16)).toBe(240);
      expect(shot.readUInt32BE(20)).toBe(120);
      // The button really rendered: a pixel inside it is the button's blue, not an error page.
      const img = PNG.sync.read(shot);
      const at = (x: number, y: number) => {
        const i = (img.width * y + x) << 2;
        return [img.data[i], img.data[i + 1], img.data[i + 2]];
      };
      const [r, g, b] = at(40, 45) as [number, number, number];
      // #2563eb within rasterization tolerance.
      expect(Math.abs(r - 0x25) + Math.abs(g - 0x63) + Math.abs(b - 0xeb)).toBeLessThan(24);
      expect(at(5, 5)).toEqual([255, 255, 255]);

      // Agents get the same render as an image in the tool result.
      const tools = canvasTools(c.canvases, c.canvasRender, c.q);
      const viaTool = await callBoardTool(tools, "canvas_screenshot", { path: "src/payments.canvas.tsx", story: "Primary" }, { actor: "agent:x", runId: null, issueId: null, workspaceId: wsId });
      expect(viaTool.images).toHaveLength(1);
      expect(Buffer.from(viaTool.images[0]!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
      expect(toolContent(viaTool).map((b) => b.type)).toEqual(["text", "image"]);
      // The agent checks the frame renders the same every time, and can diagnose it.
      const ws1 = { actor: "agent:x" as const, runId: null, issueId: null, workspaceId: wsId };
      expect((await callBoardTool(c.workspaceTools(), "canvas_verify_visual", { path: "src/payments.canvas.tsx", story: "Primary", runs: 2 }, ws1)).text).toBe("Stable: 2 renders matched.");
      expect((await callBoardTool(c.workspaceTools(), "canvas_debug", { path: "src/payments.canvas.tsx", story: "Primary" }, ws1)).text).toMatch(/Canvas devserver: running at http[\s\S]*Rendering Primary: ok \(240x120\)/);

      // The route frame renders the running app.
      const home = PNG.sync.read(await c.canvasRender.screenshot(wsId, "src/payments.canvas.tsx", "Home"));
      const i = (home.width * 45 + 40) << 2;
      expect(Math.abs(home.data[i]! - 0x25) + Math.abs(home.data[i + 1]! - 0x63) + Math.abs(home.data[i + 2]! - 0xeb)).toBeLessThan(24);

      expect((await c.canvasRender.check(wsId, "src/payments.canvas.tsx", "Primary")).status).toBe("new");
      expect(await c.canvasRender.accept(wsId, "src/payments.canvas.tsx", "Primary")).toBe(".cadence/vrt/src/payments/Primary.png");
      expect((await c.canvasRender.check(wsId, "src/payments.canvas.tsx", "Primary")).status).toBe("pass");

      const ws = c.q.workspace(wsId)!;
      const file = join(ws.path, "src/Button.tsx");
      writeFileSync(file, readFileSync(file, "utf8").replace("#2563eb", "#dc2626"));
      await new Promise((r) => setTimeout(r, 500));
      const changed = await c.canvasRender.check(wsId, "src/payments.canvas.tsx", "Primary");
      expect(changed.status).toBe("fail");
      expect(changed.diffPixels).toBeGreaterThan(100);
      expect(changed.diffFile).toBeTruthy();

      // A snapshot freezes the render as static HTML beside the canvas, and renders the same.
      const snap = await c.canvasRender.snapshot(wsId, "src/payments.canvas.tsx", "Primary");
      const added = snap.storyboards.find((s) => s.id === "PrimarySnapshot")!;
      expect(added).toMatchObject({ kind: "html", html: "src/snapshots/PrimarySnapshot.html", frame: { x: 320, y: 0, width: 240, height: 120 } });
      const html = readFileSync(join(ws.path, "src/snapshots/PrimarySnapshot.html"), "utf8");
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain("Pay now");
      expect(html).not.toMatch(/<script|data-cadence|2147483647/);
      const frozen = PNG.sync.read(await c.canvasRender.screenshot(wsId, "src/payments.canvas.tsx", "PrimarySnapshot"));
      // (30, 45) sits in the button's left padding, clear of anti-aliased text.
      const j = (frozen.width * 45 + 30) << 2;
      expect(Math.abs(frozen.data[j]! - 0xdc) + Math.abs(frozen.data[j + 1]! - 0x26) + Math.abs(frozen.data[j + 2]! - 0x26)).toBeLessThan(24);
      expect((await c.canvasRender.snapshot(wsId, "src/payments.canvas.tsx", "Primary")).storyboards.some((s) => s.id === "PrimarySnapshot2")).toBe(true);
    },
    120_000,
  );
});
