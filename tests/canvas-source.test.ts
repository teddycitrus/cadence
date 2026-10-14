import { describe, expect, it } from "vitest";
import { duplicateStory, editClassName, editStyle, editText, findElement, removeStory, setFrame } from "../src/canvas/edit";
import { parseCanvas } from "../src/canvas/parse";
import { applyStyles, styleFor } from "../src/canvas/tailwind";

const CANVAS = `import { Cart } from "../src/Cart";

export default { name: "Checkout", background: "#101014" };

export const Empty = {
  name: "Empty cart",
  render: () => <Cart items={[]} />,
  frame: { x: 0, y: 0, width: 390, height: 844 },
};

export const Home = { name: "Home page", route: "/", frame: { x: 440, y: 0, width: 1280, height: 800 } } satisfies object;

export const Mock = { name: "Pricing", html: "mocks/pricing.html" };

export const helper = 3;
`;

describe("canvas source", () => {
  it("parses page settings and every kind of frame", () => {
    const c = parseCanvas(CANVAS, "src/checkout.canvas.tsx");
    expect(c).toMatchObject({ name: "Checkout", background: "#101014", errors: [] });
    expect(c.storyboards.map((s) => [s.id, s.name, s.kind, s.route ?? s.html])).toEqual([
      ["Empty", "Empty cart", "component", null],
      ["Home", "Home page", "route", "/"],
      ["Mock", "Pricing", "html", "mocks/pricing.html"],
    ]);
    expect(c.storyboards[1]!.frame).toEqual({ x: 440, y: 0, width: 1280, height: 800 });
    expect(c.storyboards[2]!.frame).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(parseCanvas("export const A = {", "x.canvas.tsx").errors.length).toBeGreaterThan(0);
  });

  it("writes frames back, adds missing ones, duplicates and removes frames", () => {
    const moved = setFrame(CANVAS, "Empty", { x: 12.4, y: -30, width: 400, height: 900 })!;
    expect(moved).toContain("frame: { x: 12, y: -30, width: 400, height: 900 },");
    expect(moved.replace("{ x: 12, y: -30, width: 400, height: 900 }", "")).toBe(CANVAS.replace("{ x: 0, y: 0, width: 390, height: 844 }", ""));

    const added = setFrame(CANVAS, "Mock", { x: 1, y: 2, width: 3, height: 4 })!;
    expect(parseCanvas(added).storyboards.find((s) => s.id === "Mock")!.frame).toEqual({ x: 1, y: 2, width: 3, height: 4 });

    const dup = duplicateStory(CANVAS, "Empty", "EmptyCopy")!;
    const parsed = parseCanvas(dup).storyboards;
    expect(parsed.map((s) => s.id)).toEqual(["Empty", "EmptyCopy", "Home", "Mock"]);
    expect(parsed[1]).toMatchObject({ name: "Empty cart copy", frame: { x: 430, y: 0, width: 390, height: 844 } });
    expect(duplicateStory(CANVAS, "Empty", "Home")).toBeNull();
    expect(duplicateStory(CANVAS, "Empty", "bad name")).toBeNull();

    const removed = removeStory(CANVAS, "Home")!;
    expect(parseCanvas(removed).storyboards.map((s) => s.id)).toEqual(["Empty", "Mock"]);
  });

  const COMPONENT = `export function Card({ title, tone }) {
  return (
    <div className="p-4 bg-white rounded-lg hover:bg-gray-50">
      <h2 className={\`text-lg font-bold\`}>Hello</h2>
      <p className={tone === "warn" ? "text-red-500" : "text-gray-500"}>{title}</p>
      <span style={{ color: "red", fontSize: 12 }}>Tag</span>
      <Badge label="x" />
      <section>Plain</section>
    </div>
  );
}
`;

  it("finds elements by source position and edits literal classNames", () => {
    expect(findElement(COMPONENT, 3, 4)?.openingElement.name).toMatchObject({ name: "div" });
    const next = editClassName(COMPONENT, 3, 4, (c) => applyStyles(c, { padding: "24", background: "#1d4ed8", radius: "full" }))!;
    expect(next).toContain(`<div className="hover:bg-gray-50 p-[24px] bg-[#1d4ed8] rounded-full">`);
    expect(editClassName(COMPONENT, 4, 6, (c) => applyStyles(c, { fontSize: "20", fontWeight: "500" }))).toContain(`<h2 className="text-[20px] font-medium">`);
    // A computed className cannot be rewritten safely.
    expect(editClassName(COMPONENT, 5, 6, (c) => c)).toBeNull();
    // DOM elements without a className get one; components do not.
    expect(editClassName(COMPONENT, 8, 6, (c) => applyStyles(c, { gap: "8" }))).toContain(`<section className="gap-[8px]">Plain</section>`);
    expect(editClassName(COMPONENT, 7, 6, (c) => applyStyles(c, { gap: "8" }))).toBeNull();
  });

  it("edits inline styles and plain text", () => {
    expect(editStyle(COMPONENT, 6, 6, { fontSize: 14, fontWeight: 600, color: null })).toContain(`<span style={{ fontSize: 14, fontWeight: 600 }}>Tag</span>`);
    expect(editStyle(COMPONENT, 8, 6, { padding: "8px" })).toContain(`<section style={{ padding: "8px" }}>`);
    // A computed value cannot be overwritten without erasing its logic; other properties can still change.
    const DYN = `export const B = ({ on }) => <b style={{ color: on ? "red" : "blue", padding: 4 }}>x</b>;
`;
    expect(editStyle(DYN, 1, 29, { color: "green" })).toBeNull();
    expect(editStyle(DYN, 1, 29, { padding: "8px" })).toContain(`style={{ color: on ? "red" : "blue", padding: "8px" }}`);
    expect(editText(COMPONENT, 4, 6, "Hi {there}")).toContain(`>Hi {"{"}there{"}"}</h2>`);
    expect(editText(COMPONENT, 5, 6, "x")).toBeNull();
  });

  it("maps style panel values to Tailwind classes and inline styles", () => {
    expect(applyStyles(["flex", "flex-row", "items-start", "text-sm", "text-gray-900"], { direction: "column", align: "center", fontSize: "18", color: "#111" })).toEqual([
      "flex",
      "flex-col",
      "items-center",
      "text-[18px]",
      "text-[#111]",
    ]);
    expect(applyStyles(["p-4", "px-2"], { padding: "" })).toEqual(["px-2"]);
    expect(styleFor({ paddingX: "12", radius: "full", opacity: "0.5", direction: "row" })).toEqual({ paddingLeft: "12px", paddingRight: "12px", borderRadius: "9999px", opacity: 0.5, display: "flex", flexDirection: "row" });
  });
});
