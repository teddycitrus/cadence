// What the canvas toolbar's drawing tools add: a layout box, a shape, or text,
// each in a few variants. Plain inline styles, so the markup works whether or
// not the project uses Tailwind; the style panel takes it from there.

export const DRAWING_OPTIONS = {
  div: [
    ["column", "Column"],
    ["row", "Row"],
    ["grid", "Grid"],
    ["box", "Box"],
  ],
  rectangle: [
    ["rectangle", "Rectangle"],
    ["ellipse", "Ellipse"],
    ["line", "Line"],
    ["triangle", "Triangle"],
    ["diamond", "Diamond"],
    ["star", "Star"],
    ["hexagon", "Hexagon"],
  ],
  text: [
    ["heading", "Heading"],
    ["paragraph", "Paragraph"],
    ["label", "Label"],
    ["link", "Link"],
  ],
} as const;

export type DrawingTool = keyof typeof DRAWING_OPTIONS;
export type NewElement = { [T in DrawingTool]: (typeof DRAWING_OPTIONS)[T][number][0] }[DrawingTool] | DrawingTool;

export const NEW_ELEMENTS = [...new Set([...Object.keys(DRAWING_OPTIONS), ...Object.values(DRAWING_OPTIONS).flatMap((o) => o.map(([id]) => id))])] as [NewElement, ...NewElement[]];

const FILL = "#d4d4d8";

/** An SVG polygon shape at 120x120, points in a 0-100 box. */
const polygon = (points: string) => `<svg width={120} height={120} viewBox="0 0 100 100"><polygon points="${points}" fill="${FILL}" /></svg>`;

/** Starting markup for an element drawn from the canvas toolbar. */
export function newElementJsx(kind: NewElement): string {
  switch (kind) {
    case "div":
    case "column":
      return `<div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }} />`;
    case "row":
      return `<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, padding: 16 }} />`;
    case "grid":
      return `<div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, padding: 16 }} />`;
    case "box":
      return `<div style={{ padding: 16 }} />`;
    case "rectangle":
      return `<div style={{ width: 120, height: 80, background: "${FILL}", borderRadius: 4 }} />`;
    case "ellipse":
      return `<div style={{ width: 120, height: 120, background: "${FILL}", borderRadius: "50%" }} />`;
    case "line":
      return `<div style={{ width: 160, height: 2, background: "${FILL}" }} />`;
    case "triangle":
      return polygon("50,6 96,94 4,94");
    case "diamond":
      return polygon("50,2 98,50 50,98 2,50");
    case "star":
      return polygon("50,4 61,38 97,38 68,59 79,94 50,73 21,94 32,59 3,38 39,38");
    case "hexagon":
      return polygon("25,6 75,6 98,50 75,94 25,94 2,50");
    case "heading":
      return `<h2 style={{ fontSize: 24, fontWeight: 600 }}>Heading</h2>`;
    case "text":
    case "paragraph":
      return `<p>Text</p>`;
    case "label":
      return `<span style={{ fontSize: 12 }}>Label</span>`;
    case "link":
      return `<a href="#">Link</a>`;
  }
}
