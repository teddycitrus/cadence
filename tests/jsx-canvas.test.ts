import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendStory, duplicateStory, removeStory, setCanvasSetting, setFrame, setStoryLocked, setStoryVrt } from "../src/canvas/edit";
import { parseCanvas } from "../src/canvas/parse";
import { setStoryProp, storyProps } from "../src/canvas/story-props";
import { detachComponent, storyComponents } from "../src/canvas/detach";
import { removeTempDir } from "./helpers/temp-dir";
import { canvasSummary } from "../src/canvas/project-config";
import { JSX_HOME_MARKER, JSX_PROJECT_CONFIG, JSX_TAG_IMPORT } from "../src/canvas/jsx-compat";

// A canvas in the component format, as those projects write it.
const SOURCE = `// ${JSX_HOME_MARKER}: the main canvas. Managed marker; do not remove.
import { Canvas, Storyboard, RouteStoryboard } from "${JSX_TAG_IMPORT}";
import { Cart } from "../../../../src/Cart";
import Card from "../../../../src/Card.svelte";

export default function CheckoutCanvas() {
  return (
    <Canvas name="Checkout" backgroundColor="#111">
      <Storyboard id="Empty" name="Empty cart" component={Cart} props={{ items: 0, title: "Bag" }} layout={{ x: 0, y: 0, width: 390, height: 844, intrinsicSizing: "root-element" }} />
      <RouteStoryboard
        id="Home"
        name="Home (/)"
        route="/"
        layout={{ x: 440, y: 0, width: 1280, height: 800 }}
      />
    </Canvas>
  );
}
`;
const FILE = "app/designs/canvases/checkout/index.canvas.tsx";

describe("component-format canvases", () => {
  it("reads the canvas, its frames, and the main-canvas marker", () => {
    const c = parseCanvas(SOURCE, FILE);
    expect(c).toMatchObject({ format: "jsx", name: "Checkout", background: "#111", home: true, errors: [] });
    expect(c.storyboards.map((s) => [s.id, s.name, s.kind, s.route, s.frame])).toEqual([
      ["Empty", "Empty cart", "component", null, { x: 0, y: 0, width: 390, height: 844 }],
      ["Home", "Home (/)", "route", "/", { x: 440, y: 0, width: 1280, height: 800 }],
    ]);
    expect(c.storyboards[0]!.jsx?.component).toBe("Cart");
    // A canvas without a name attribute is named after its folder.
    expect(parseCanvas(`import { Canvas } from "${JSX_TAG_IMPORT}";\nexport default () => <Canvas />;`, FILE).name).toBe("checkout");
  });

  it("moves frames by rewriting layout numbers and keeps other layout keys", () => {
    const moved = setFrame(SOURCE, "Empty", { x: 10, y: 20, width: 400, height: 900 })!;
    expect(moved).toContain(`layout={{ x: 10, y: 20, width: 400, height: 900, intrinsicSizing: "root-element" }}`);
    expect(parseCanvas(moved, FILE).storyboards[0]!.frame).toEqual({ x: 10, y: 20, width: 400, height: 900 });
    // A storyboard with no layout gets one.
    const bare = SOURCE.replace(/ layout=\{\{ x: 0[^}]*\}\}/, "");
    expect(parseCanvas(setFrame(bare, "Empty", { x: 5, y: 6, width: 7, height: 8 })!, FILE).storyboards[0]!.frame).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it("duplicates, adds, and removes frames as elements, importing tags as needed", () => {
    const dup = duplicateStory(SOURCE, "Empty", "EmptyCopy")!;
    const copy = parseCanvas(dup, FILE).storyboards.find((s) => s.id === "EmptyCopy")!;
    expect(copy).toMatchObject({ name: "Empty cart copy", kind: "component", frame: { x: 430, y: 0, width: 390, height: 844 } });
    expect(copy.jsx?.component).toBe("Cart");

    const added = appendStory(SOURCE, "Mock", { name: "Pricing mock", html: "mocks/pricing.html", frame: { x: 0, y: 900, width: 800, height: 600 } });
    expect(added).toContain(`import { Canvas, Storyboard, RouteStoryboard, HtmlStoryboard } from "${JSX_TAG_IMPORT}";`);
    expect(parseCanvas(added, FILE).storyboards.find((s) => s.id === "Mock")).toMatchObject({ kind: "html", html: "mocks/pricing.html" });

    const removed = removeStory(SOURCE, "Home")!;
    expect(parseCanvas(removed, FILE).storyboards.map((s) => s.id)).toEqual(["Empty"]);
    expect(removed).not.toContain("RouteStoryboard\n");
    expect(removed).toContain("    </Canvas>");
  });

  it("writes settings, locks, and visual-test opt-outs as attributes, and the main-canvas marker as a comment", () => {
    let s = setCanvasSetting(SOURCE, "name", 'Checkout "v2"')!;
    s = setCanvasSetting(s, "background", "#222")!;
    s = setCanvasSetting(s, "appUrl", "http://localhost:3000")!;
    const c = parseCanvas(s, FILE);
    expect(c).toMatchObject({ name: 'Checkout "v2"', background: "#222", appUrl: "http://localhost:3000" });
    const notHome = setCanvasSetting(SOURCE, "home", false)!;
    expect(parseCanvas(notHome, FILE).home).toBe(false);
    expect(parseCanvas(setCanvasSetting(notHome, "home", true)!, FILE).home).toBe(true);

    const locked = setStoryLocked(SOURCE, "Home", true)!;
    expect(parseCanvas(locked, FILE).storyboards[1]!.locked).toBe(true);
    expect(parseCanvas(setStoryLocked(locked, "Home", false)!, FILE).storyboards[1]!.locked).toBe(false);
    const off = setStoryVrt(SOURCE, "Empty", false)!;
    expect(off).toContain("vrt={false}");
    expect(parseCanvas(off, FILE).storyboards[0]!.vrt.enabled).toBe(false);
    expect(parseCanvas(setStoryVrt(off, "Empty", true)!, FILE).storyboards[0]!.vrt.enabled).toBe(true);
  });

  it("edits literal props in the props attribute", () => {
    expect(storyProps(SOURCE, "Empty").map((p) => [p.name, p.value])).toEqual([
      ["items", 0],
      ["title", "Bag"],
    ]);
    const next = setStoryProp(SOURCE, "Empty", "title", "Tote")!;
    expect(storyProps(next, "Empty").find((p) => p.name === "title")?.value).toBe("Tote");
  });

  it("forks the component a frame renders", () => {
    const root = mkdtempSync(join(tmpdir(), "cadence-jsx-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "app/designs/canvases/checkout"), { recursive: true });
      writeFileSync(join(root, "src/Cart.tsx"), "export function Cart() { return <div />; }\n");
      expect(storyComponents(SOURCE, "Empty").map((c) => c.name)).toEqual(["Cart"]);
      const out = detachComponent(root, FILE, SOURCE, "Empty", "Cart");
      expect(out.copy).toBe("src/Cart.Empty.tsx");
      expect(out.source).toContain("component={CartEmpty}");
      expect(out.source).toContain(`import { Cart as CartEmpty } from "../../../../src/Cart.Empty";`);
    } finally {
      removeTempDir(root);
    }
  });

  it("reads Svelte frames with the component's path from the project root", () => {
    const svelte = SOURCE.replace(`import { Canvas, Storyboard, RouteStoryboard } from "${JSX_TAG_IMPORT}";`, `import { Canvas, Storyboard, RouteStoryboard, SvelteStoryboard } from "${JSX_TAG_IMPORT}";`).replace(
      "    </Canvas>",
      `      <SvelteStoryboard id="Card" component={Card} props={{ title: "Hi" }} layout={{ x: 0, y: 900, width: 300, height: 200 }} />\n    </Canvas>`,
    );
    expect(parseCanvas(svelte, FILE).storyboards.find((s) => s.id === "Card")).toMatchObject({ kind: "svelte", svelte: "src/Card.svelte" });
  });

  it("takes the project's app from its settings file, unless the canvas sets one or it is unsafe", () => {
    const root = mkdtempSync(join(tmpdir(), "cadence-jsx-cfg-"));
    try {
      mkdirSync(join(root, "app/designs/canvases/checkout"), { recursive: true });
      writeFileSync(join(root, "app", JSX_PROJECT_CONFIG), JSON.stringify({ apps: [{ start: "npm run dev", url: "http://localhost:5173/" }] }));
      expect(canvasSummary(root, FILE, SOURCE)).toMatchObject({ appCommand: "npm run dev", appUrl: "http://localhost:5173" });
      expect(canvasSummary(root, FILE, setCanvasSetting(SOURCE, "appUrl", "http://localhost:3000")!)).toMatchObject({ appCommand: null, appUrl: "http://localhost:3000" });
      writeFileSync(join(root, "app", JSX_PROJECT_CONFIG), JSON.stringify({ apps: [{ start: "npm run dev; rm -rf /", url: "https://evil.example" }] }));
      expect(canvasSummary(root, FILE, SOURCE)).toMatchObject({ appCommand: null, appUrl: null });
    } finally {
      removeTempDir(root);
    }
  });

  it("leaves Cadence's own format alone", () => {
    const own = `export default { name: "Mine" };\nexport const A = { name: "A", route: "/", frame: { x: 0, y: 0, width: 10, height: 10 } };\n`;
    expect(parseCanvas(own, "a.canvas.tsx")).toMatchObject({ format: "objects", name: "Mine" });
  });
});
