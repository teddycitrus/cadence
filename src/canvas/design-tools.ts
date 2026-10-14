import { starterTaskPrompt } from "../projects/starter-tasks";

// Agent jobs about a project's design system, started from the canvas.

export const DESIGN_TOOLS = ["generate", "audit", "review", "harden"] as const;
export type DesignTool = (typeof DESIGN_TOOLS)[number];

export const DESIGN_TOOL_INFO: { id: DesignTool; title: string; description: string }[] = [
  { id: "generate", title: "Map the components", description: "A canvas for each group of components, the tokens, and the inconsistencies found." },
  { id: "audit", title: "Find drift", description: "Find colors, sizes, and one-off components that stray from the design system." },
  { id: "review", title: "Review the UI", description: "Review this branch's UI changes against the design system and the canvases." },
  { id: "harden", title: "Tighten components", description: "Narrow the design system's components so drift is harder to write. Proposes first." },
];

export function designToolPrompt(tool: DesignTool, note: string): string {
  const extra = note.trim() ? ["", `Notes: ${note.trim()}`] : [];
  switch (tool) {
    case "generate":
      return starterTaskPrompt("component-map", note);
    case "audit":
      return [
        "Audit this codebase against its design system.",
        "",
        "1. Establish the system: the design tokens (CSS variables, Tailwind theme), and the blessed components (the design-system canvases if there are any, else the shared component folder).",
        "2. Find violations: colors and sizes written as raw values where a token exists, values off the spacing and type scales, components that re-implement a blessed one by hand, and use of anything marked deprecated.",
        "3. Group the findings by kind and by how often they occur. For each group give two or three file:line examples and the fix (which token or component to use).",
        "4. Write them up as a doc titled \"Design system violations\", worst first, and add a frame to a Design debt canvas for the three most visible ones, showing the violation next to the correct version. Do not fix the code.",
        ...extra,
      ].join("\n");
    case "review":
      return [
        "Review the UI changes on this branch (git diff against its base) for design quality. Two separate passes:",
        "",
        "1. Adherence: every color, size, font, radius, and shadow comes from the design tokens; blessed components are used instead of new look-alikes; nothing deprecated is used. List each problem with file:line and the fix.",
        "2. Visual judgment: render the affected frames (canvas_screenshot) and judge them as a designer would: hierarchy, alignment, spacing rhythm, contrast, empty and error states, and how it fits next to the existing canvases. Be specific.",
        "",
        "Rank findings as must fix, should fix, or nit. Reply with the review; if there is a pull request, also post a short summary on it. Do not change the code.",
        ...extra,
      ].join("\n");
    case "harden":
      return [
        "Make the design system's components harder to misuse. This changes code that others use, so propose before changing anything:",
        "",
        "1. Look at the shared components and how they are called across the codebase.",
        "2. Find loose surface: props that accept any string where a fixed set is used (variants, sizes, colors), className or style escape hatches that callers use to break the system, dead props nobody passes, and duplicate ways to do the same thing.",
        "3. Propose each change with: the component, the change (for example size: string becomes \"sm\" | \"md\" | \"lg\"), every caller that must change, and the risk. Then stop and wait for my approval.",
        "4. Once approved, make the approved changes, migrate every caller, run the typecheck and tests, and commit.",
        ...extra,
      ].join("\n");
  }
}
