import { describe, expect, it } from "vitest";
import { deleteElement, duplicateElement, reorderElement } from "../src/canvas/element-ops";

const SRC = `export const A = () => (
  <main>
    <h1>Title</h1>
    <p>One</p>
    <p>Two</p>
  </main>
);
`;

describe("element operations from the canvas", () => {
  it("moves an element forward, backward, to the front, and to the back, keeping whitespace", () => {
    expect(reorderElement(SRC, 3, 4, "forward")).toContain("    <p>One</p>\n    <h1>Title</h1>\n    <p>Two</p>");
    expect(reorderElement(SRC, 5, 4, "backward")).toContain("    <h1>Title</h1>\n    <p>Two</p>\n    <p>One</p>");
    expect(reorderElement(SRC, 3, 4, "front")).toContain("    <p>One</p>\n    <p>Two</p>\n    <h1>Title</h1>");
    expect(reorderElement(SRC, 5, 4, "back")).toContain("    <p>Two</p>\n    <h1>Title</h1>\n    <p>One</p>");
    // Already last: nothing to do.
    expect(reorderElement(SRC, 5, 4, "forward")).toBeNull();
    expect(reorderElement(SRC, 2, 2, "forward")).toBeNull();
  });

  it("duplicates an element onto its own line", () => {
    expect(duplicateElement(SRC, 4, 4)).toContain("    <p>One</p>\n    <p>One</p>\n    <p>Two</p>");
    expect(duplicateElement("const x = <div><b>a</b></div>;", 1, 15)).toBe("const x = <div><b>a</b><b>a</b></div>;");
  });

  it("deletes an element and its line, but never a component's root", () => {
    expect(deleteElement(SRC, 4, 4)).toBe(SRC.replace("    <p>One</p>\n", ""));
    expect(deleteElement(SRC, 2, 2)).toBeNull();
    expect(deleteElement("const x = <div><b>a</b> c</div>;", 1, 15)).toBe("const x = <div> c</div>;");
  });
});

describe("drawing tool variants", () => {
  it("every box, shape, and text variant inserts as valid JSX", async () => {
    const { NEW_ELEMENTS } = await import("../src/canvas/new-elements");
    const { insertElement } = await import("../src/canvas/compose");
    const { parseSource } = await import("../src/canvas/parse");
    expect(NEW_ELEMENTS).toEqual(expect.arrayContaining(["div", "rectangle", "text", "row", "grid", "ellipse", "star", "hexagon", "heading", "link"]));
    for (const kind of NEW_ELEMENTS) {
      const out = insertElement(SRC, 2, 2, kind);
      expect(out, kind).not.toBeNull();
      expect(() => parseSource(out!), kind).not.toThrow();
    }
    expect(insertElement(SRC, 2, 2, "star")).toContain('<polygon points="50,4 61,38');
  });
});
