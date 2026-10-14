import type { Snapshot } from "../../../../core/types";
import { useCanvasEditing } from "../../live";

function editorName(snapshot: Snapshot, actor: string): string {
  if (actor.startsWith("agent:")) return snapshot.agents.find((a) => a.id === actor.slice(6))?.name ?? "An agent";
  if (actor.startsWith("chat:")) return "The assistant";
  if (actor.startsWith("token:")) return "An outside agent";
  return "Someone";
}

/** Shown while an agent edits this canvas (canvas_start_working until canvas_finish_working). */
export function AgentEditingBanner({ snapshot, workspaceId, path }: { snapshot: Snapshot; workspaceId: string; path: string }) {
  const editing = useCanvasEditing(workspaceId, path);
  if (!editing) return null;
  return (
    <div className="pointer-events-none absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-violet-950/90 px-3 py-1 text-xs text-violet-200 ring-1 ring-violet-800">
      <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-violet-400" />
      {editorName(snapshot, editing.actor)} is editing this canvas. It refreshes when they finish.
    </div>
  );
}
