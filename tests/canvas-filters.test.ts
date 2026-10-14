import { describe, expect, it } from "vitest";
import { applyStyles, classFor, styleFor } from "../src/canvas/tailwind";
import { filterChange } from "../src/web/src/components/canvas/InspectPanel";

describe("filters, blend modes, and box sizing on the style panel", () => {
  it("writes Tailwind classes that replace only their own", () => {
    expect(classFor("brightness", "1.2")).toBe("brightness-[1.2]");
    expect(classFor("hueRotate", "-30")).toBe("-hue-rotate-[30deg]");
    expect(classFor("blendMode", "multiply")).toBe("mix-blend-multiply");
    expect(classFor("blendMode", "bogus")).toBeNull();
    expect(classFor("boxSizing", "border-box")).toBe("box-border");
    expect(applyStyles(["p-4", "brightness-[0.5]", "contrast-125", "mix-blend-screen"], { brightness: "1.1", blendMode: "overlay" })).toEqual(["p-4", "contrast-125", "brightness-[1.1]", "mix-blend-overlay"]);
  });

  it("rebuilds inline filter from every value, so changing one keeps the others", () => {
    const change = filterChange("blur(4px) brightness(1.2)", "contrast", "1.5");
    expect(change).toEqual({ blur: "4px", brightness: "1.2", contrast: "1.5" });
    expect(styleFor(change)).toEqual({ filter: "blur(4px) brightness(1.2) contrast(1.5)" });
    // Clearing the last one removes the property.
    expect(styleFor(filterChange("sepia(0.4)", "sepia", ""))).toEqual({ filter: null });
    expect(styleFor({ hueRotate: "90" })).toEqual({ filter: "hue-rotate(90deg)" });
    expect(styleFor({ blendMode: "multiply", boxSizing: "border-box" })).toEqual({ mixBlendMode: "multiply", boxSizing: "border-box" });
  });
});
