import { PNG } from "pngjs";
import { ForbiddenError } from "../core/errors";

/** What a person has selected on an open canvas, as the editor reports it. */
export interface SelectionElement {
  loc: string;
  tag: string;
  className: string;
  text: string | null;
  /** Where it sits in the frame, in CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
  ancestors: { loc: string; tag: string; className: string }[];
  /** How many times the same source element renders (lists). */
  count: number;
}

export interface DesignTarget {
  /** One open canvas view (a browser tab). */
  id: string;
  memberId: string;
  workspaceId: string;
  path: string;
  storyId: string | null;
  element: SelectionElement | null;
  at: string;
}

/** Views that stop reporting are dropped after this long. */
const STALE_MS = 2 * 60_000;

/**
 * The live selection in every open canvas view, so an agent outside the
 * editor can ask "what am I looking at" (like attaching the selection to a
 * chat). In memory only; each person sees only their own views.
 */
export class DesignContext {
  private targets = new Map<string, DesignTarget>();

  report(memberId: string, input: Omit<DesignTarget, "memberId" | "at">): DesignTarget {
    const existing = this.targets.get(input.id);
    // A view id belongs to whoever opened it first.
    if (existing && existing.memberId !== memberId) throw new ForbiddenError("That view belongs to someone else");
    const t = { ...input, memberId, at: new Date().toISOString() };
    this.targets.set(input.id, t);
    return t;
  }

  close(memberId: string, id: string): void {
    if (this.targets.get(id)?.memberId === memberId) this.targets.delete(id);
  }

  list(memberId: string): DesignTarget[] {
    const now = Date.now();
    for (const [id, t] of this.targets) if (now - Date.parse(t.at) > STALE_MS) this.targets.delete(id);
    return [...this.targets.values()].filter((t) => t.memberId === memberId).sort((a, b) => b.at.localeCompare(a.at));
  }
}

/** Cuts the element's box out of a frame screenshot (both in CSS pixels at scale 1), padded a little. */
export function cropPng(png: Buffer, rect: SelectionElement["rect"], pad = 8): Buffer | null {
  const src = PNG.sync.read(png);
  const x = Math.max(0, Math.floor(rect.x - pad));
  const y = Math.max(0, Math.floor(rect.y - pad));
  const w = Math.min(src.width - x, Math.ceil(rect.width + pad * 2));
  const h = Math.min(src.height - y, Math.ceil(rect.height + pad * 2));
  if (w <= 0 || h <= 0) return null;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  return PNG.sync.write(out);
}
