import { describe, expect, it } from "vitest";
import { editStyle, LOCK_ATTR, setElementLocked, setFrame, setNativeLocked, setStoryLocked, setStoryVrt } from "../src/canvas/edit";
import { nativeStyle } from "../src/canvas/editors";
import { parseCanvas } from "../src/canvas/parse";
import { editSvelteClass, editSvelteStyle, editSvelteText, findSvelteElement, setSvelteLocked, stampSvelte, svelteCompiler } from "../src/canvas/svelte";
import { applyStyles, styleFor, validImage } from "../src/canvas/tailwind";

const svelte = svelteCompiler(process.cwd())!;

describe("gradient and image fills", () => {
  it("writes gradients and images as Tailwind classes that replace earlier fills", () => {
    const grad = applyStyles(["p-4", "bg-gradient-to-r", "from-red-500", "to-blue-500"], { backgroundImage: "linear-gradient(90deg, #ff0000 0%, #0000ff 100%)" });
    expect(grad).toEqual(["p-4", "bg-[linear-gradient(90deg,#ff0000_0%,#0000ff_100%)]"]);
    const img = applyStyles(grad, { backgroundImage: "url(/cadence/hero_1.png)", backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" });
    expect(img).toEqual(["p-4", "bg-[url(/cadence/hero%5F1.png)]", "bg-cover", "bg-center", "bg-no-repeat"]);
    // A solid fill keeps working alongside, and clearing the image removes it.
    expect(applyStyles(img, { background: "#ffffff", backgroundImage: "" })).toEqual(["p-4", "bg-cover", "bg-center", "bg-no-repeat", "bg-[#ffffff]"]);
    expect(applyStyles(["bg-[length:20px_20px]"], { backgroundSize: "contain" })).toEqual(["bg-contain"]);
  });

  it("writes text shadows and flips", () => {
    expect(applyStyles(["text-shadow-sm", "p-2"], { textShadow: "0 1px 2px rgba(0, 0, 0, 0.5)" })).toEqual(["p-2", "[text-shadow:0_1px_2px_rgba(0,0,0,0.5)]"]);
    expect(applyStyles(["scale-x-[-1]"], { scaleX: "1", scaleY: "-1" })).toEqual(["scale-x-[1]", "scale-y-[-1]"]);
    expect(styleFor({ scaleX: "-1" })).toEqual({ scale: "-1 1" });
    expect(styleFor({ scaleX: "1", scaleY: "1" })).toEqual({ scale: null });
  });

  it("writes the same fills as inline styles", () => {
    expect(styleFor({ backgroundImage: "radial-gradient(circle, #fff 0%, #000 100%)", backgroundSize: "cover" })).toEqual({ backgroundImage: "radial-gradient(circle, #fff 0%, #000 100%)", backgroundSize: "cover" });
    expect(styleFor({ backgroundImage: "" })).toEqual({ backgroundImage: null });
  });

  it("only accepts gradients, image URLs, and none", () => {
    expect(validImage("linear-gradient(45deg, red, blue)")).toBe(true);
    expect(validImage("url(/img/a.png)")).toBe(true);
    expect(validImage("url(https://example.com/a.png)")).toBe(true);
    expect(validImage("none")).toBe(true);
    expect(validImage("url(javascript:alert(1))")).toBe(false);
    expect(validImage("red; } body { display: none")).toBe(false);
    expect(validImage("expression(alert(1))")).toBe(false);
  });
});

const PAGE = `export function Page() {
  return (
    <main className="p-4">
      <h1 className="text-xl">Title</h1>
    </main>
  );
}
`;

const CANVAS = `export default { name: "Locks" };

export const A = { name: "A", render: () => <div />, frame: { x: 0, y: 0, width: 100, height: 100 } };

export const B = {
  name: "B",
  render: () => <div />,
  frame: { x: 200, y: 0, width: 100, height: 100 },
};
`;

describe("layer locking", () => {
  it("locks and unlocks elements with an attribute in the source", () => {
    const locked = setElementLocked(PAGE, 4, 6, true)!;
    expect(locked).toContain(`<h1 ${LOCK_ATTR} className="text-xl">`);
    expect(setElementLocked(locked, 4, 6, true)).toBe(locked);
    expect(setElementLocked(locked, 4, 6, false)).toBe(PAGE);
    expect(setElementLocked(PAGE, 9, 0, true)).toBeNull();
  });

  it("locks frames in single-line and multi-line objects, and unlocks them cleanly", () => {
    let src = setStoryLocked(CANVAS, "A", true)!;
    expect(src).toContain(`frame: { x: 0, y: 0, width: 100, height: 100 }, locked: true };`);
    src = setStoryLocked(src, "B", true)!;
    expect(src).toContain(`  frame: { x: 200, y: 0, width: 100, height: 100 },\n  locked: true,\n};`);
    expect(parseCanvas(src).storyboards.map((s) => s.locked)).toEqual([true, true]);
    expect(setStoryLocked(setStoryLocked(src, "A", false)!, "B", false)).toBe(CANVAS);
  });

  it("tracks and untracks a frame's visual test, keeping its settings", () => {
    const off = setStoryVrt(CANVAS, "B", false)!;
    expect(off).toContain("  vrt: false,\n};");
    expect(parseCanvas(off).storyboards.map((s) => s.vrt.enabled)).toEqual([true, false]);
    expect(setStoryVrt(off, "B", true)).toBe(CANVAS);
    const tuned = CANVAS.replace("export const B = {", "export const B = {\n  vrt: { threshold: 0.3 },");
    expect(setStoryVrt(tuned, "B", false)).toContain("vrt: false,");
    expect(setStoryVrt(CANVAS, "Missing", false)).toBeNull();
  });

  it("refuses to move a locked frame through the frame writer's caller, but the writer itself still works", () => {
    const src = setStoryLocked(CANVAS, "A", true)!;
    expect(setFrame(src, "A", { x: 5, y: 5, width: 100, height: 100 })).toContain("x: 5");
  });
});

const CARD = `<script>
  let { title = "Card" } = $props();
</script>

<div class="p-4 rounded">
  <h2 style="color: red; background: url(a;b.png)">{title}</h2>
  <p>Plain text</p>
  {#if title}<span>Shown</span>{/if}
</div>

<style>
  div { color: blue; }
</style>
`;

describe("Svelte components", () => {
  it("parses svelte frames in .canvas.ts files", () => {
    const c = parseCanvas(`export const Card = { name: "Card", svelte: "./src/lib/Card.svelte", props: { title: "Hi" } };\nexport const Bad = { name: "Bad", svelte: "../outside.svelte" };`, "src/cards.canvas.ts");
    expect(c.name).toBe("cards");
    expect(c.storyboards.map((s) => [s.id, s.kind, s.svelte])).toEqual([["Card", "svelte", "src/lib/Card.svelte"]]);
  });

  it("stamps every markup element, including inside blocks, and nothing in script or style", () => {
    const out = stampSvelte(CARD, "src/lib/Card.svelte", svelte)!.code;
    expect(out).toContain(`<div data-cadence-loc="src/lib/Card.svelte:5:0" class="p-4 rounded">`);
    expect(out).toContain(`<h2 data-cadence-loc="src/lib/Card.svelte:6:2" style=`);
    expect(out).toContain(`<span data-cadence-loc="src/lib/Card.svelte:8:13">`);
    expect(out).toContain("div { color: blue; }");
    expect(out.match(/data-cadence-loc/g)).toHaveLength(4);
    expect(findSvelteElement(CARD, 7, 2, svelte)?.name).toBe("p");
  });

  it("edits classes, inline styles, text, and locks in .svelte markup", () => {
    expect(editSvelteClass(CARD, 5, 0, (c) => [...c, "shadow"], svelte)).toContain(`<div class="p-4 rounded shadow">`);
    const styled = editSvelteStyle(CARD, 6, 2, { color: null, fontSize: "20px", backgroundImage: "linear-gradient(red, blue)" }, svelte)!;
    expect(styled).toContain(`<h2 style="background: url(a;b.png); font-size: 20px; background-image: linear-gradient(red, blue)">`);
    expect(editSvelteStyle(CARD, 7, 2, { color: "green" }, svelte)).toContain(`<p style="color: green">Plain text</p>`);
    expect(editSvelteText(CARD, 7, 2, "New <text> {x}", svelte)).toContain("<p>New &lt;text> &#123;x&#125;</p>");
    // {title} is an expression, so its text cannot be rewritten mechanically.
    expect(editSvelteText(CARD, 6, 2, "x", svelte)).toBeNull();
    const locked = setSvelteLocked(CARD, 7, 2, true, LOCK_ATTR, svelte)!;
    expect(locked).toContain(`<p ${LOCK_ATTR}>Plain text</p>`);
    expect(setSvelteLocked(locked, 7, 2, false, LOCK_ATTR, svelte)).toBe(CARD);
  });

  it("leaves computed classes to the Agent queue", () => {
    expect(editSvelteClass(`<div class={active ? "a" : "b"}></div>`, 1, 0, (c) => c, svelte)).toBeNull();
  });
});

describe("React Native sources", () => {
  const APP = `import { Text, View } from "react-native";

export default function App() {
  return (
    <View style={{ flex: 1 }}>
      <Text>Hello</Text>
      <div className="web-only" />
    </View>
  );
}
`;

  it("adds styles to components with numeric lengths", () => {
    const out = editStyle(APP, 6, 6, nativeStyle({ padding: "16px", color: "#ff0000", opacity: 0.5 }), { anyElement: true })!;
    expect(out).toContain(`<Text style={{ padding: 16, color: "#ff0000", opacity: 0.5 }}>Hello</Text>`);
    expect(editStyle(APP, 5, 4, nativeStyle({ padding: "8px" }), { anyElement: true })).toContain(`<View style={{ flex: 1, padding: 8 }}>`);
    // Without the React Native flag, components are left to the Agent queue.
    expect(editStyle(APP, 6, 6, { padding: "16px" })).toBeNull();
  });

  it("locks components through dataSet, merging with what is there, and unlocks cleanly", () => {
    const locked = setNativeLocked(APP, 6, 6, true)!;
    expect(locked).toContain(`<Text dataSet={{ cadenceLocked: true }}>Hello</Text>`);
    expect(setNativeLocked(locked, 6, 6, false)).toBe(APP);
    const withSet = APP.replace("<Text>", `<Text dataSet={{ testid: "t" }}>`);
    const merged = setNativeLocked(withSet, 6, 6, true)!;
    expect(merged).toContain(`dataSet={{ testid: "t", cadenceLocked: true }}`);
    expect(setNativeLocked(merged, 6, 6, false)).toBe(withSet);
    // DOM tags in an RN file still use the attribute.
    expect(setNativeLocked(APP, 7, 6, true)).toContain(`<div ${LOCK_ATTR} className="web-only" />`);
  });
});
