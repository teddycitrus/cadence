import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "../../../../core/types";
import { api, type CanvasEntry } from "../../api";
import { navigate } from "../../App";
import { Button, Empty, ErrorText, inputClass, timeAgo, useAction } from "../ui";
import { CanvasEditor } from "./CanvasEditor";

type GroupBy = "branch" | "folder" | "project" | "none";
type SortBy = "recent" | "name" | "storyboards";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const canvasRouteId = (workspaceId: string, path: string) => `${workspaceId}|${path}`;

function NewCanvas({ snapshot, onDone }: { snapshot: Snapshot; onDone: () => void }) {
  const choices = snapshot.workspaces.filter((w) => !w.archived && w.branch);
  const [ws, setWs] = useState(choices[0]?.id ?? "");
  const [name, setName] = useState("");
  const action = useAction();
  if (!choices.length) return <p className="text-sm text-zinc-500">Create a workspace in a project first; canvases live in its branch.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-900 p-3 ring-1 ring-zinc-800">
      <select className={`${inputClass} w-auto`} value={ws} onChange={(e) => setWs(e.target.value)}>
        {choices.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} ({w.branch})
          </option>
        ))}
      </select>
      <input className={`${inputClass} w-64`} placeholder="Canvas name, e.g. Checkout" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <Button
        variant="primary"
        disabled={!name.trim() || !ws || action.busy}
        onClick={() =>
          action.run(async () => {
            const created = await api.createCanvas(ws, name.trim());
            onDone();
            navigate("canvas", canvasRouteId(ws, created.path));
          })
        }
      >
        Create
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

function Thumb({ entry }: { entry: CanvasEntry }) {
  const [failed, setFailed] = useState(false);
  if (!entry.workspaceId) {
    return (
      <div className="grid aspect-video place-items-center rounded-t-lg text-xs text-zinc-500" style={{ background: entry.background }}>
        On {entry.branch}; open it to preview
      </div>
    );
  }
  const src = `/api/workspaces/${entry.workspaceId}/canvas/thumbnail?path=${encodeURIComponent(entry.path)}`;
  return (
    <div className="grid aspect-video place-items-center overflow-hidden rounded-t-lg" style={{ background: entry.background }}>
      {entry.storyboards.length === 0 || failed ? (
        <span className="text-xs text-zinc-500">{entry.storyboards.length ? "No preview" : "Empty canvas"}</span>
      ) : (
        <img src={src} alt="" loading="lazy" className="max-h-full max-w-full object-contain" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

/** Canvases across every live workspace, grouped by branch. */
function CanvasHome({ snapshot }: { snapshot: Snapshot }) {
  const [entries, setEntries] = useState<CanvasEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const opening = useAction();
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (stored("cadence.canvasGroup") as GroupBy | null) ?? "branch");
  const [sortBy, setSortBy] = useState<SortBy>(() => (stored("cadence.canvasSort") as SortBy | null) ?? "recent");
  useEffect(() => {
    api.canvases().then(setEntries, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("cadence.canvasGroup", groupBy);
      localStorage.setItem("cadence.canvasSort", sortBy);
    } catch {
      // storage unavailable
    }
  }, [groupBy, sortBy]);
  const groups = useMemo(() => {
    const keyOf = (e: CanvasEntry) => {
      if (groupBy === "branch") return `${e.branch} · ${e.workspaceName}`;
      if (groupBy === "folder") return e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "(top level)";
      if (groupBy === "project") return snapshot.projects.find((p) => p.id === e.projectId)?.name ?? "No project";
      return "All canvases";
    };
    const order = (a: CanvasEntry, b: CanvasEntry) => (sortBy === "name" ? a.name.localeCompare(b.name) : sortBy === "storyboards" ? b.storyboards.length - a.storyboards.length : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const out = new Map<string, CanvasEntry[]>();
    for (const e of [...(entries ?? [])].sort(order)) {
      if (query && !`${e.name} ${e.path} ${e.branch ?? ""}`.toLowerCase().includes(query.toLowerCase())) continue;
      out.set(keyOf(e), [...(out.get(keyOf(e)) ?? []), e]);
    }
    return [...out].sort(([a], [b]) => a.localeCompare(b));
  }, [entries, query, groupBy, sortBy, snapshot.projects]);

  const keyOf = (e: CanvasEntry) => `${e.workspaceId ?? `branch:${e.projectId}:${e.branch}`}|${e.path}`;
  const pins = snapshot.members.find((m) => m.id === snapshot.viewer.memberId)?.pinnedCanvases ?? [];
  const pinned = (entries ?? []).filter((e) => pins.includes(keyOf(e)));
  const open = (e: CanvasEntry) =>
    e.workspaceId
      ? navigate("canvas", canvasRouteId(e.workspaceId, e.path))
      : void opening.run(async () => {
          const { workspaceId } = await api.openBranchCanvas(e.projectId!, e.branch!);
          navigate("canvas", canvasRouteId(workspaceId, e.path));
        });
  const card = (e: CanvasEntry) => {
    const isPinned = pins.includes(keyOf(e));
    return (
      <div key={keyOf(e)} className="group relative rounded-lg bg-zinc-900 ring-1 ring-zinc-800 transition hover:ring-violet-500/60">
        <button className="block w-full text-left" onClick={() => open(e)} disabled={opening.busy}>
          <Thumb entry={e} />
          <div className="p-3">
            <p className="truncate text-sm font-medium">{e.name}</p>
            <p className="truncate font-mono text-[11px] text-zinc-500">
              {e.path} · {e.storyboards.length} frame{e.storyboards.length === 1 ? "" : "s"}
            </p>
            {groupBy !== "branch" && (
              <p className="truncate font-mono text-[11px] text-zinc-600">
                {e.branch}
                {e.updatedAt ? ` · ${timeAgo(e.updatedAt)}` : ""}
              </p>
            )}
            {!e.workspaceId && <p className="mt-1 text-[11px] text-zinc-500">Not open in a workspace</p>}
            {e.errors.length > 0 && <p className="mt-1 text-[11px] text-amber-300">Has syntax errors</p>}
          </div>
        </button>
        <button
          className={`absolute top-2 right-2 rounded-md bg-zinc-950/80 px-1.5 py-0.5 text-xs ${isPinned ? "text-amber-300" : "hidden text-zinc-400 group-hover:block hover:text-zinc-100"}`}
          title={isPinned ? "Unpin" : "Pin to the top"}
          onClick={() => void opening.run(() => api.pinCanvas(keyOf(e), !isPinned))}
        >
          {isPinned ? "Pinned" : "Pin"}
        </button>
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Canvases</h1>
        <input className={`${inputClass} ml-auto w-64`} placeholder="Search canvases" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className={`${inputClass} w-auto`} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} title="Group by">
          <option value="branch">By branch</option>
          <option value="folder">By folder</option>
          <option value="project">By project</option>
          <option value="none">No grouping</option>
        </select>
        <select className={`${inputClass} w-auto`} value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} title="Sort">
          <option value="recent">Recently changed</option>
          <option value="name">Name</option>
          <option value="storyboards">Most frames</option>
        </select>
        <Button variant="primary" onClick={() => setAdding(true)}>
          New canvas
        </Button>
      </div>
      {adding && (
        <div className="mb-6">
          <NewCanvas snapshot={snapshot} onDone={() => setAdding(false)} />
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {entries === null && !error && <p className="text-sm text-zinc-500">Looking for canvases...</p>}
      {entries?.length === 0 && (
        <Empty title="No canvases yet">
          A canvas is a <code>*.canvas.tsx</code> file in your repo with frames: components in their states, live routes, or HTML mocks. Create one here, or ask an agent to.
        </Empty>
      )}
      <div className="space-y-8">
        {pinned.length > 0 && (
          <section>
            <p className="mb-2 font-mono text-xs text-zinc-500">Pinned</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">{pinned.map(card)}</div>
          </section>
        )}
        {groups.map(([group, list]) => (
          <section key={group}>
            <p className="mb-2 font-mono text-xs text-zinc-500">{group}</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">{list.map(card)}</div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function CanvasView({ snapshot, selected }: { snapshot: Snapshot; selected: string | null }) {
  if (selected) {
    const cut = selected.indexOf("|");
    if (cut > 0) return <CanvasEditor key={selected} snapshot={snapshot} workspaceId={selected.slice(0, cut)} path={selected.slice(cut + 1)} />;
  }
  return <CanvasHome snapshot={snapshot} />;
}
