import type { Frame } from "./parse";

export type ArrangeOp = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "distribute-h" | "distribute-v";

export const ARRANGE_OPS: ArrangeOp[] = ["left", "hcenter", "right", "top", "vcenter", "bottom", "distribute-h", "distribute-v"];

/**
 * Aligns frames to the selection's edge or center, or spaces them evenly
 * (equal gaps between neighbors, the outermost two staying put). Returns only
 * the frames that move. No DOM or Node APIs, so the board and server share it.
 */
export function arrange(frames: Record<string, Frame>, op: ArrangeOp): Record<string, Frame> {
  const items = Object.entries(frames);
  if (items.length < 2) return {};
  const fs = items.map(([, f]) => f);
  const minX = Math.min(...fs.map((f) => f.x));
  const maxX = Math.max(...fs.map((f) => f.x + f.width));
  const minY = Math.min(...fs.map((f) => f.y));
  const maxY = Math.max(...fs.map((f) => f.y + f.height));
  const out: Record<string, Frame> = {};
  const set = (id: string, f: Frame, patch: Partial<Frame>) => {
    const next = { ...f, ...patch };
    if (next.x !== f.x || next.y !== f.y) out[id] = next;
  };
  if (op === "distribute-h" || op === "distribute-v") {
    const h = op === "distribute-h";
    if (items.length < 3) return {};
    const sorted = [...items].sort(([, a], [, b]) => (h ? a.x - b.x : a.y - b.y));
    const size = sorted.reduce((n, [, f]) => n + (h ? f.width : f.height), 0);
    const gap = ((h ? maxX - minX : maxY - minY) - size) / (sorted.length - 1);
    let at = h ? minX : minY;
    for (const [id, f] of sorted) {
      set(id, f, h ? { x: Math.round(at) } : { y: Math.round(at) });
      at += (h ? f.width : f.height) + gap;
    }
    return out;
  }
  for (const [id, f] of items) {
    if (op === "left") set(id, f, { x: minX });
    else if (op === "right") set(id, f, { x: maxX - f.width });
    else if (op === "hcenter") set(id, f, { x: Math.round((minX + maxX) / 2 - f.width / 2) });
    else if (op === "top") set(id, f, { y: minY });
    else if (op === "bottom") set(id, f, { y: maxY - f.height });
    else set(id, f, { y: Math.round((minY + maxY) / 2 - f.height / 2) });
  }
  return out;
}
