import { useEffect, useState } from "react";
import type { Actor, Snapshot } from "../../../../core/types";
import { api, type CanvasActivity } from "../../api";
import { actorName, ErrorText, timeAgo } from "../ui";
import { ThreadList } from "./ThreadList";

const LABEL: Record<CanvasActivity["kind"], string> = { commit: "Commit", comment: "Comment", edit: "Waiting for an agent" };

/** A canvas's history: commits to its file, comments, and edits waiting for an agent. */
export function ActivityPanel({ workspaceId, path, snapshot, onClose }: { workspaceId: string; path: string; snapshot: Snapshot; onClose: () => void }) {
  const [items, setItems] = useState<CanvasActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"activity" | "threads">("threads");
  useEffect(() => {
    api.canvasActivity(workspaceId, path).then(setItems, (e: Error) => setError(e.message));
  }, [workspaceId, path]);
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-900 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2">
        {(["threads", "activity"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-2 py-0.5 text-xs capitalize ${tab === t ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"}`}>
            {t === "threads" ? "Comments" : "Activity"}
          </button>
        ))}
        <button className="ml-auto text-zinc-500 hover:text-zinc-100" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs">
        {tab === "threads" && <ThreadList workspaceId={workspaceId} path={path} snapshot={snapshot} />}
        {tab === "activity" && items?.length === 0 && <p className="text-zinc-500">Nothing yet. Commits, comments, and staged edits on this canvas show here.</p>}
        {tab === "activity" && items?.map((i, n) => (
          <div key={`${i.kind}${i.ref}${n}`} className="rounded-md bg-zinc-900 p-2 ring-1 ring-zinc-800">
            <p className="flex items-center gap-2 text-zinc-500">
              <span className={i.kind === "commit" ? "text-violet-300" : i.kind === "edit" ? "text-amber-300" : "text-sky-300"}>{LABEL[i.kind]}</span>
              {i.who && <span className="truncate text-zinc-300">{i.kind === "comment" ? actorName(i.who as Actor, snapshot) : i.who}</span>}
              <span className="ml-auto shrink-0">{timeAgo(i.at)}</span>
            </p>
            <p className={`mt-0.5 line-clamp-3 whitespace-pre-wrap text-zinc-200 ${i.resolved ? "line-through opacity-60" : ""}`}>{i.text}</p>
            {i.kind === "commit" && <p className="mt-0.5 font-mono text-[10px] text-zinc-600">{i.ref}</p>}
          </div>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
    </aside>
  );
}
