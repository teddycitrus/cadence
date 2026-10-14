import { useEffect, useState } from "react";
import type { Actor, Snapshot } from "../../../../core/types";
import { api, type BoardEvent } from "../../api";
import { actorName, timeAgo } from "../ui";
import { describe } from "./IssueDetail";

/** Everything that happened on the board in the last two weeks, newest first. Refreshes as the board changes. */
export function BoardActivity({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [events, setEvents] = useState<BoardEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = snapshot.issues.reduce((t, i) => (i.updatedAt > t ? i.updatedAt : t), "");
  useEffect(() => {
    api.boardActivity().then(setEvents, (e: Error) => setError(e.message));
  }, [changed]);
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-900 px-4 py-2.5">
        <h2 className="text-sm font-semibold">Activity</h2>
        <button className="text-zinc-500 hover:text-zinc-100" onClick={onClose} aria-label="Close activity">
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 text-xs">
        {error && <p className="text-red-400">{error}</p>}
        {events?.length === 0 && <p className="text-zinc-500">Nothing in the last two weeks.</p>}
        {events?.map((e) => {
          const text = describe(e.type, e.payload, snapshot);
          if (!text) return null;
          return (
            <a key={e.seq} href={`#/issues/${encodeURIComponent(e.issue.key)}`} className="block rounded-md px-2 py-1.5 hover:bg-zinc-900">
              <p className="text-zinc-300">
                <span className="text-zinc-100">{actorName(e.actor as Actor, snapshot)}</span> {text}
              </p>
              <p className="flex gap-2 text-zinc-500">
                <span className="font-mono">{e.issue.key}</span>
                <span className="min-w-0 flex-1 truncate">{e.issue.title}</span>
                <span className="shrink-0">{timeAgo(e.ts)}</span>
              </p>
            </a>
          );
        })}
      </div>
    </aside>
  );
}
