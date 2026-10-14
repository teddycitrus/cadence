import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChrome } from "../src/canvas/browser";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

const CARD = `<script>
  let { title = "Card", tone = "#2563eb" } = $props();
</script>

<div style="padding: 16px; background: #ffffff; height: 100vh">
  <h2 style="margin: 0; padding: 12px; background: {tone}; color: #ffffff">{title}</h2>
  <p class="note">Plain text</p>
</div>
`;

const CANVAS = `export default { name: "Cards", background: "#111111" };

export const Blue = {
  name: "Blue card",
  svelte: "src/lib/Card.svelte",
  props: { title: "Hello from Svelte", tone: "#2563eb" },
  frame: { x: 0, y: 0, width: 240, height: 120 },
};
`;

// A Svelte project with no node_modules: the canvas devserver uses Cadence's own Svelte.
describe("Svelte frames on a real devserver", () => {
  let fx: GitFixture;
  let c: Container;
  let wsId: string;
  const hasChrome = Boolean(findChrome());

  beforeAll(async () => {
    fx = createGitFixture({ "package.json": `{ "name": "cards", "private": true, "type": "module" }\n`, ".gitignore": "node_modules\n", "src/lib/Card.svelte": CARD, "src/cards.canvas.ts": CANVAS });
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm, uiOrigins: ["http://127.0.0.1:4317"] });
    c.agents.addProject({ name: "cards", path: fx.repo, baseBranch: "main", githubRepo: null });
    wsId = (await c.workspaces.createInProject(c.q.projects()[0]!.id, "design", "user")).id;
  }, 60_000);

  afterAll(async () => {
    c.stop();
    await c.canvasDev.stopAll();
    c.db.close();
    await new Promise((r) => setTimeout(r, 500));
    fx.cleanup();
  });

  it("finds .canvas.ts canvases and their Svelte frames", async () => {
    const list = await c.canvases.list(wsId);
    expect(list.map((x) => [x.path, x.storyboards.map((s) => [s.id, s.kind, s.svelte])])).toEqual([["src/cards.canvas.ts", [["Blue", "svelte", "src/lib/Card.svelte"]]]]);
  });

  it("serves a mounting entry and the component compiled with source locations", async () => {
    const dev = await c.canvasDev.ensure(wsId);
    const entry = await (await fetch(`${dev.url}/@cadence/story?canvas=src%2Fcards.canvas.ts&story=Blue`)).text();
    expect(entry).toContain("svelte.mount");
    expect(entry).not.toContain("react");
    const compiled = await (await fetch(`${dev.url}/src/lib/Card.svelte`)).text();
    expect(compiled).toContain("src/lib/Card.svelte:5:0");
    expect(compiled).toContain("src/lib/Card.svelte:7:2");
  }, 60_000);

  it("writes panel edits into the .svelte file", () => {
    expect(c.canvases.editElement(wsId, "src/lib/Card.svelte:7:2", { styles: { fontSize: "18" }, text: "Edited" })).toEqual({ applied: true, via: "style", file: "src/lib/Card.svelte" });
    const ws = c.q.workspace(wsId)!;
    expect(readFileSync(join(ws.path, "src/lib/Card.svelte"), "utf8")).toContain(`<p style="font-size: 18px" class="note">Edited</p>`);
    // The heading's style has an expression ({tone}), so it goes to the Agent queue.
    expect(c.canvases.editElement(wsId, "src/lib/Card.svelte:6:2", { styles: { padding: "4" } })).toMatchObject({ applied: false, via: "ledger" });
    c.canvases.lockElement(wsId, "src/lib/Card.svelte:7:2", true);
    expect(readFileSync(join(ws.path, "src/lib/Card.svelte"), "utf8")).toContain(`<p data-cadence-locked style="font-size: 18px" class="note"`);
  });

  it.runIf(hasChrome)(
    "renders the Svelte component with its props in Chrome",
    async () => {
      const shot = await c.canvasRender.screenshot(wsId, "src/cards.canvas.ts", "Blue");
      const img = PNG.sync.read(shot);
      expect([img.width, img.height]).toEqual([240, 120]);
      const i = (img.width * 30 + 60) << 2;
      const [r, g, b] = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
      // Inside the heading: the tone prop's blue, so the component mounted with its props.
      expect(Math.abs(r - 0x25) + Math.abs(g - 0x63) + Math.abs(b - 0xeb)).toBeLessThan(24);
    },
    90_000,
  );
});

describe("svelte detection", () => {
  it("loads the Svelte plugin only for projects that use Svelte", async () => {
    const { usesSvelte } = await import("../src/canvas/devserver");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const react = mkdtempSync(join(tmpdir(), "cadence-react-"));
    writeFileSync(join(react, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }));
    mkdirSync(join(react, "node_modules", "lib"), { recursive: true });
    writeFileSync(join(react, "node_modules", "lib", "Ignored.svelte"), "<p />");
    expect(usesSvelte(react)).toBe(false);
    const dep = mkdtempSync(join(tmpdir(), "cadence-svelte-"));
    writeFileSync(join(dep, "package.json"), JSON.stringify({ devDependencies: { svelte: "5.0.0" } }));
    expect(usesSvelte(dep)).toBe(true);
    const file = mkdtempSync(join(tmpdir(), "cadence-svelte-file-"));
    mkdirSync(join(file, "src", "lib"), { recursive: true });
    writeFileSync(join(file, "src", "lib", "Card.svelte"), "<p />");
    expect(usesSvelte(file)).toBe(true);
  });
});
