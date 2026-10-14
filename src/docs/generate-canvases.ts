import type { Doc, Workspace } from "../core/types";

/**
 * The task an agent gets to turn a doc into canvases: one frame per
 * screen and state the doc describes, built from the project's real
 * components, then embedded back into the doc where each is discussed.
 */
export function generateCanvasesPrompt(doc: Pick<Doc, "id" | "title">, ws: Pick<Workspace, "id" | "name" | "branch">, note: string): string {
  return [
    `Turn the doc "${doc.title}" (doc id ${doc.id}) into canvases in this workspace (id ${ws.id}${ws.branch ? `, branch ${ws.branch}` : ""}).`,
    "",
    "1. Read the doc with docs_get. List every screen, flow step, and state it describes (empty, loading, error, filled, edge cases).",
    "2. Look through the project for the components and styles those screens would use. Reuse real components; only write new ones when nothing fits, and keep them small and in the project's conventions.",
    "3. Create one canvas per screen or flow with canvas_create (or write the *.canvas.tsx file yourself), with one frame per state. Give frames clear names and sensible frame sizes (390x844 for mobile, 1280x800 for desktop).",
    "4. Check each frame with canvas_screenshot and fix anything that renders wrong.",
    "5. Embed the result in the doc next to the section it illustrates, using docs_edit to insert a fenced block:",
    "```canvas",
    `workspace: ${ws.id}`,
    "path: <the canvas file>",
    "story: <a frame export, or leave this line out for the whole canvas>",
    "```",
    "6. Commit the canvases and any new components in one commit, then reply with a short list of what you made.",
    "",
    "Do not build the feature itself beyond what the canvases need, and do not change the doc's text other than adding the embeds.",
    ...(note.trim() ? ["", `Notes from the person who asked: ${note.trim()}`] : []),
  ].join("\n");
}
