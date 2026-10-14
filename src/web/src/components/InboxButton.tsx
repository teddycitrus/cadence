import { useEffect, useState } from "react";
import type { Snapshot } from "../../../core/types";
import { api, type InboxItem } from "../api";

function author(snapshot: Snapshot, actor: string): string {
  if (actor === "user") return snapshot.members.find((m) => m.id === "me")?.name ?? "Owner";
  if (actor.startsWith("member:")) return snapshot.members.find((m) => m.id === actor.slice(7))?.name ?? "Former member";
  if (actor.startsWith("agent:")) return snapshot.agents.find((a) => a.id === actor.slice(6))?.name ?? "Agent";
  return "Someone";
}

/** Canvas comments waiting for the viewer: mentions, and replies in their threads. */
export function InboxButton({ snapshot }: { snapshot: Snapshot }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [open, setOpen] = useState(false);
  // The snapshot refreshes on every pushed change, which is when the inbox can change.
  useEffect(() => {
    api.inbox().then(setItems, () => setItems([]));
  }, [snapshot]);
  const go = (i: InboxItem) => {
    setOpen(false);
    void api.readCanvasThread(i.workspaceId, i.threadId).catch(() => undefined);
    window.location.hash = `/canvas/${encodeURIComponent(`${i.workspaceId}|${i.canvasPath}`)}?comment=${encodeURIComponent(i.threadId)}`;
  };
  return (
    <span className="relative">
      <button title={items.length ? `${items.length} unread comments` : "Inbox: comment mentions and replies"} onClick={() => setOpen((o) => !o)} className="relative grid size-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />
        </svg>
        {items.length > 0 && <span className="absolute top-0.5 right-0.5 grid min-w-3.5 place-items-center rounded-full bg-sky-500 px-0.5 text-[9px] leading-3.5 font-medium text-white">{items.length > 9 ? "9+" : items.length}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed bottom-24 left-16 z-50 w-80 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700">
            <p className="px-3 py-1.5 text-xs font-medium text-zinc-400">Inbox</p>
            {items.length === 0 && <p className="px-3 pb-3 text-xs text-zinc-500">Nothing unread. Mentions and replies on canvas comments show here.</p>}
            {items.map((i) => (
              <button key={i.threadId} className="block w-full px-3 py-2 text-left hover:bg-zinc-800" onClick={() => go(i)}>
                <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <span className={`rounded px-1 text-[10px] ${i.reason === "mention" ? "bg-sky-950 text-sky-300" : "bg-zinc-800 text-zinc-400"}`}>{i.reason === "mention" ? "Mentioned you" : "Reply"}</span>
                  <span className="truncate">{i.canvasPath}</span>
                </span>
                <span className="mt-0.5 block truncate text-zinc-200">
                  <span className="text-zinc-400">{author(snapshot, i.latest.author)}:</span> {i.latest.body}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
