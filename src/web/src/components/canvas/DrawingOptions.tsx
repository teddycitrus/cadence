import { useState } from "react";
import { DRAWING_OPTIONS, type DrawingTool, type NewElement } from "../../../../canvas/new-elements";

const KEY = "cadence.drawing";
const choices: Record<DrawingTool, NewElement> = (() => {
  const base: Record<DrawingTool, NewElement> = { div: "column", rectangle: "rectangle", text: "paragraph" };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Record<DrawingTool, NewElement>>) };
  } catch {
    return base;
  }
})();

export const isDrawingTool = (tool: string): tool is DrawingTool => tool in DRAWING_OPTIONS;

/** What the drawing tool adds right now (its last chosen variant). */
export const drawingChoice = (tool: DrawingTool): NewElement => choices[tool];

/** The small menu beside a drawing tool: which box, shape, or text it adds. */
export function DrawingOption({ tool, onPick }: { tool: DrawingTool; onPick: () => void }) {
  const [value, setValue] = useState(choices[tool]);
  const name = tool === "div" ? "Div" : tool === "rectangle" ? "Shape" : "Text";
  const label = DRAWING_OPTIONS[tool].find(([id]) => id === value)?.[1] ?? value;
  // A chevron with the native select laid invisibly over it: the menu opens as usual, but the bar shows no clipped label.
  return (
    <span className="relative flex w-3.5 items-center justify-center text-zinc-500 hover:text-zinc-200" title={`${name}: ${label}`}>
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
        <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <select
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label={`${name} options`}
        value={value}
        onChange={(e) => {
          const next = e.target.value as NewElement;
          choices[tool] = next;
          setValue(next);
          try {
            localStorage.setItem(KEY, JSON.stringify(choices));
          } catch {
            // storage unavailable
          }
          onPick();
        }}
      >
        {DRAWING_OPTIONS[tool].map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </span>
  );
}
