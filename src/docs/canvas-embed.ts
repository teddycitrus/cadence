// A canvas embedded in a doc is a fenced block, so markdown stays the source
// of truth and the doc still reads fine anywhere else:
//
//   ```canvas
//   workspace: 3f1c...
//   path: src/checkout.canvas.tsx
//   story: Empty
//   ```
//
// `story` is optional; without it the whole canvas is shown.

export interface CanvasEmbed {
  workspaceId: string;
  path: string;
  story: string | null;
}

const ID = /^[\w-]{1,100}$/;
const PATH = /^[\w./@-]+\.canvas\.[jt]sx?$/;
const STORY = /^[A-Za-z_$][\w$]*$/;

/** The embed a canvas block's text describes, or null when it is not a valid reference. */
export function parseCanvasEmbed(text: string): CanvasEmbed | null {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(workspace|path|story)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) fields.set(m[1]!, m[2]!);
  }
  const workspaceId = fields.get("workspace") ?? "";
  const path = fields.get("path") ?? "";
  const story = fields.get("story") ?? null;
  if (!ID.test(workspaceId) || !PATH.test(path) || path.includes("..") || (story !== null && !STORY.test(story))) return null;
  return { workspaceId, path, story };
}

/** The block body for an embed (without the fences). */
export function canvasEmbedText(e: CanvasEmbed): string {
  return [`workspace: ${e.workspaceId}`, `path: ${e.path}`, ...(e.story ? [`story: ${e.story}`] : [])].join("\n");
}

/** The whole fenced block, ready to put in a doc. */
export function canvasEmbedBlock(e: CanvasEmbed): string {
  return "```canvas\n" + canvasEmbedText(e) + "\n```";
}

/** Every canvas embedded in a doc's markdown. */
export function canvasEmbeds(markdown: string): CanvasEmbed[] {
  const out: CanvasEmbed[] = [];
  for (const m of markdown.matchAll(/^```canvas[^\n]*\n([\s\S]*?)^```/gm)) {
    const e = parseCanvasEmbed(m[1]!);
    if (e) out.push(e);
  }
  return out;
}
