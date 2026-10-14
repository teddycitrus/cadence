import type { EphemeralBus } from "../core/bus";
import type { Actor } from "../core/types";

export interface CanvasEditing {
  workspaceId: string;
  /** The canvas being edited, or null for every canvas in the workspace. */
  path: string | null;
  actor: Actor;
  since: string;
}

/** An agent that never says it finished stops holding the canvas after this long. */
const EXPIRY_MS = 30 * 60_000;

/**
 * Which canvases an agent is working on right now. Not persisted: it only
 * tells open canvas views to show an editing state and to refresh once at the
 * end instead of flickering through every intermediate write.
 */
export class CanvasEditingState {
  private entries = new Map<string, CanvasEditing>();

  constructor(private bus: EphemeralBus) {}

  private key = (workspaceId: string, path: string | null) => `${workspaceId}|${path ?? "*"}`;

  list(workspaceId?: string): CanvasEditing[] {
    const now = Date.now();
    for (const [k, e] of this.entries) if (now - Date.parse(e.since) > EXPIRY_MS) this.entries.delete(k);
    return [...this.entries.values()].filter((e) => !workspaceId || e.workspaceId === workspaceId);
  }

  start(workspaceId: string, path: string | null, actor: Actor): CanvasEditing {
    const entry = { workspaceId, path, actor, since: new Date().toISOString() };
    this.entries.set(this.key(workspaceId, path), entry);
    this.publish();
    return entry;
  }

  /** Ends the session; returns false when none was open at that scope. */
  finish(workspaceId: string, path: string | null): boolean {
    const had = this.entries.delete(this.key(workspaceId, path));
    // Everyone viewing refreshes once, even after an expired or missing session.
    this.bus.emit({ type: "canvas_refresh", workspaceId, path });
    this.publish();
    return had;
  }

  private publish(): void {
    this.bus.emit({ type: "canvas_editing", editing: this.list() });
  }
}
