import { describe, expect, it } from "vitest";
import { foldDiff } from "../src/web/src/components/chat/diff-fold";

describe("folding unchanged diff lines", () => {
  const ctx = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ` line ${from + i}`);

  it("folds a long unchanged run between changes, keeping three lines each side", () => {
    const diff = ["@@ -1,20 +1,20 @@", "-old", "+new", ...ctx(14), "-old2", "+new2"].join("\n");
    const parts = foldDiff(diff);
    expect(parts.map((p) => [p.kind, p.lines.length])).toEqual([
      ["lines", 6],
      ["fold", 8],
      ["lines", 5],
    ]);
    // Every line is still there, in order.
    expect(parts.flatMap((p) => p.lines).join("\n")).toBe(diff);
  });

  it("leaves short runs alone and trims leading and trailing context fully", () => {
    expect(foldDiff(["-a", "+b", ...ctx(6), "-c"].join("\n")).every((p) => p.kind === "lines")).toBe(true);
    const parts = foldDiff([...ctx(10), "+x", ...ctx(10, 20)].join("\n"));
    expect(parts.map((p) => [p.kind, p.lines.length])).toEqual([
      ["fold", 7],
      ["lines", 7],
      ["fold", 7],
    ]);
  });
});
