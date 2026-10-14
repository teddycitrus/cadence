import { describe, expect, it } from "vitest";
import { boardTone } from "../src/web/src/components/canvas/Board";

describe("canvas board tone", () => {
  it("tells dark boards from light ones in hex and rgb, and leaves other colors alone", () => {
    expect(boardTone("#18181b")).toBe("dark");
    expect(boardTone("#1e1a16")).toBe("dark");
    expect(boardTone("#d7c09b")).toBe("light");
    expect(boardTone("#fff")).toBe("light");
    expect(boardTone("rgb(20, 20, 30)")).toBe("dark");
    expect(boardTone("rgba(240,230,210,0.9)")).toBe("light");
    expect(boardTone("var(--surface)")).toBeUndefined();
  });
});
