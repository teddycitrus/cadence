import { useEffect, useState } from "react";
import type { CanvasComment, Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { useDomainEvents } from "../../live";
import { actorName, timeAgo } from "../ui";

export const OPEN_COMMENT_EVENT = "cadence:open-comment";

type Sort = "newest" | "oldest" | "unread";

/** The canvas's comment threads as a list: filter to open or yours, sort, and jump to one. */
export function ThreadList({ workspaceId, path, snapshot }: { workspaceId: string; path: string; snapshot: Snapshot }) {
  const [all, setAll] = useState<CanvasComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");
  const load = () => void api.canvasComments(workspaceId).then((c) => setAll(c.filter((x) => x.canvasPath === path)), () => undefined);
  useEffect(load, [workspaceId, path]);
  useDomainEvents((e) => e.aggregate === "canvas" && e.type.startsWith("CanvasComment") && load());
  const me = snapshot.viewer.memberId === "me" ? "user" : `member:${snapshot.viewer.memberId}`;
  const thread = (root: CanvasComment) => all.filter((c) => c.id === root.id || c.parentId === root.id);
  const latest = (root: CanvasComment) => thread(root).map((c) => c.editedAt ?? c.createdAt).sort().at(-1)!;
  const unread = (root: CanvasComment) => thread(root).some((c) => c.author !== me && (c.editedAt ?? c.createdAt) > (root.readBy?.[snapshot.viewer.memberId] ?? ""));
  const roots = all
    .filter((c) => !c.parentId && (showResolved || !c.resolved) && (!mine || thread(c).some((x) => x.author === me)))
    .sort((a, b) => (sort === "oldest" ? a.createdAt.localeCompare(b.createdAt) : sort === "unread" ? Number(unread(b)) - Number(unread(a)) || latest(b).localeCompare(latest(a)) : latest(b).localeCompare(latest(a))));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only yours
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Resolved
        </label>
        <select className="ml-auto rounded bg-zinc-900 px-1 py-0.5 text-zinc-300 ring-1 ring-zinc-800" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="newest">Newest activity</option>
          <option value="oldest">Oldest first</option>
          <option value="unread">Unread first</option>
        </select>
      </div>
      {roots.length === 0 && <p className="text-zinc-500">No {showResolved ? "" : "open "}threads{mine ? " of yours" : ""}. Use the Comment tool to pin one.</p>}
      {roots.map((r) => {
        const replies = thread(r).length - 1;
        return (
          <button key={r.id} className="block w-full rounded-md bg-zinc-900 p-2 text-left ring-1 ring-zinc-800 hover:ring-zinc-600" onClick={() => window.dispatchEvent(new CustomEvent<string>(OPEN_COMMENT_EVENT, { detail: r.id }))}>
            <p className="flex items-center gap-2 text-zinc-500">
              {unread(r) && <span className="size-1.5 shrink-0 rounded-full bg-sky-400" />}
              <span className="truncate text-zinc-300">{actorName(r.author, snapshot)}</span>
              {r.storyId && <span className="truncate">on {r.storyId}</span>}
              <span className="ml-auto shrink-0">{timeAgo(latest(r))}</span>
            </p>
            <p className={`mt-0.5 line-clamp-2 whitespace-pre-wrap text-zinc-200 ${r.resolved ? "line-through opacity-60" : ""}`}>{r.body}</p>
            {replies > 0 && <p className="mt-0.5 text-[10px] text-zinc-500">{replies} repl{replies === 1 ? "y" : "ies"}</p>}
          </button>
        );
      })}
    </div>
  );
}
