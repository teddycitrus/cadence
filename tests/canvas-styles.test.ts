import { describe, expect, it } from "vitest";
import { applyStyles, styleFor } from "../src/canvas/tailwind";

describe("more style panel properties", () => {
  it("writes each as Tailwind classes and replaces only its own", () => {
    expect(applyStyles(["flex", "flex-nowrap", "grid-cols-2"], { wrap: "wrap", gridColumns: "3" })).toEqual(["flex", "flex-wrap", "grid-cols-3"]);
    expect(applyStyles([], { gridColumns: "200px 1fr", gridRows: "auto 1fr" })).toEqual(["grid-cols-[200px_1fr]", "grid-rows-[auto_1fr]"]);
    expect(applyStyles(["relative", "top-0"], { position: "absolute", top: "8", left: "12px", zIndex: "20" })).toEqual(["absolute", "top-[8px]", "left-[12px]", "z-[20]"]);
    expect(applyStyles(["aspect-video", "max-w-sm"], { aspectRatio: "4/3", maxWidth: "640" })).toEqual(["aspect-[4/3]", "max-w-[640px]"]);
    expect(applyStyles(["font-bold", "leading-6", "uppercase"], { lineHeight: "1.4", letterSpacing: "0.5", textTransform: "none", fontStyle: "italic", textDecoration: "underline" })).toEqual([
      "font-bold",
      "leading-[1.4]",
      "tracking-[0.5px]",
      "normal-case",
      "italic",
      "underline",
    ]);
    expect(applyStyles(["font-sans"], { fontFamily: "Inter, sans-serif" })).toEqual(["[font-family:Inter,sans-serif]"]);
    // Border style is separate from border width and color.
    expect(applyStyles(["border", "border-red-500", "border-solid"], { borderStyle: "dashed" })).toEqual(["border", "border-red-500", "border-dashed"]);
    expect(applyStyles(["outline", "outline-red-500", "outline-offset-2"], { outlineWidth: "2", outlineColor: "#00f", outlineStyle: "dashed", outlineOffset: "4" })).toEqual(["outline-[2px]", "outline-[#00f]", "outline-dashed", "outline-offset-[4px]"]);
    expect(applyStyles(["shadow-md", "blur-sm"], { boxShadow: "0 2px 8px rgba(0,0,0,0.2)", blur: "4", backdropBlur: "none" })).toEqual(["shadow-[0_2px_8px_rgba(0,0,0,0.2)]", "blur-[4px]", "backdrop-blur-none"]);
    expect(applyStyles(["rotate-45", "scale-110"], { rotate: "-15", scale: "1.2", translateX: "10", translateY: "-4" })).toEqual(["rotate-[-15deg]", "scale-[1.2]", "translate-x-[10px]", "translate-y-[-4px]"]);
    // SVG paint: color and width share the stroke- prefix but stay apart.
    expect(applyStyles(["fill-red-500", "stroke-blue-500", "stroke-2"], { fill: "#ff0", strokeWidth: "3" })).toEqual(["stroke-blue-500", "fill-[#ff0]", "stroke-3"]);
    expect(applyStyles(["stroke-2"], { stroke: "none" })).toEqual(["stroke-2", "stroke-none"]);
    expect(applyStyles(["overflow-auto"], { overflow: "hidden" })).toEqual(["overflow-hidden"]);
  });

  it("edits one breakpoint or state without touching the others", () => {
    const base = ["p-2", "md:p-4", "hover:bg-red-500", "md:hover:p-6"];
    expect(applyStyles(base, { padding: "8" }, "md")).toEqual(["p-2", "hover:bg-red-500", "md:hover:p-6", "md:p-[8px]"]);
    expect(applyStyles(base, { padding: "1" })).toEqual(["md:p-4", "hover:bg-red-500", "md:hover:p-6", "p-[1px]"]);
    expect(applyStyles(base, { background: "#000" }, "hover")).toEqual(["p-2", "md:p-4", "md:hover:p-6", "hover:bg-[#000]"]);
    expect(applyStyles(["flex"], { direction: "column" }, "lg")).toEqual(["flex", "lg:flex-col"]);
    expect(applyStyles(["block"], { direction: "row" }, "lg")).toEqual(["block", "lg:flex-row", "lg:flex"]);
  });

  it("falls back to inline styles for projects without Tailwind", () => {
    expect(styleFor({ wrap: "wrap", gridColumns: "3", position: "absolute", top: "4", zIndex: "2", aspectRatio: "video" })).toEqual({
      flexWrap: "wrap",
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      position: "absolute",
      top: "4px",
      zIndex: 2,
      aspectRatio: "16 / 9",
    });
    expect(styleFor({ blur: "6", backdropBlur: "2", rotate: "30", scale: "0.9", translateX: "5", translateY: "7" })).toEqual({
      filter: "blur(6px)",
      backdropFilter: "blur(2px)",
      rotate: "30deg",
      scale: 0.9,
      translate: "5px 7px",
    });
    expect(styleFor({ boxShadow: "0 1px 2px #000", fill: "#fff", strokeWidth: "2", lineHeight: "1.5", letterSpacing: "1" })).toEqual({ boxShadow: "0 1px 2px #000", fill: "#fff", strokeWidth: "2px", lineHeight: "1.5", letterSpacing: "1px" });
  });
});
