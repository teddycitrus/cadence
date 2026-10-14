import { useEffect, useState } from "react";
import type { Workspace } from "../../../../core/types";
import { api, type CanvasInfo } from "../../api";
import { navigate } from "../../App";
import { openBeside } from "../Workbench";
import { Button, ErrorText, inputClass, useAction } from "../ui";

const route = (wsId: string, path: string) => `${wsId}|${path}`;

/** This workspace's canvases: find one, open it, or start a new one. */
export function WorkspaceCanvases({ ws }: { ws: Workspace }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CanvasInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const action = useAction();
  useEffect(() => {
    if (open) api.workspaceCanvases(ws.id).then((r) => setList(r.canvases), (e: Error) => action.setError(e.message));
  }, [open, ws.id]);
  const shown = (list ?? []).filter((c) => !query || `${c.name} ${c.path}`.toLowerCase().includes(query.toLowerCase()));
  if (!ws.branch) return null;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} title="This workspace's canvases">
        Canvases
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => setOpen(false)}>
          <div className="flex max-h-[70vh] w-[30rem] flex-col gap-3 rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-700" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-zinc-400">
              Canvases on <span className="font-mono text-zinc-200">{ws.branch}</span>
            </p>
            <input autoFocus className={inputClass} placeholder="Find a canvas" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {list === null && <p className="text-sm text-zinc-500">Loading...</p>}
              {list?.length === 0 && <p className="text-sm text-zinc-500">No canvases on this branch yet.</p>}
              {shown.map((c) => (
                <div key={c.path} className="group flex items-center rounded-md hover:bg-zinc-800">
                  <button className="min-w-0 flex-1 px-2 py-1.5 text-left" onClick={() => navigate("canvas", route(ws.id, c.path))}>
                    <p className="text-sm text-zinc-100">
                      {c.name}
                      {c.home && <span className="ml-1.5 rounded bg-violet-950 px-1 text-[10px] text-violet-300">home</span>}
                    </p>
                    <p className="font-mono text-[11px] text-zinc-500">
                      {c.path} · {c.storyboards.length} frame{c.storyboards.length === 1 ? "" : "s"}
                    </p>
                  </button>
                  {!c.home && (
                    <button className="hidden px-2 text-[11px] text-zinc-500 group-hover:block hover:text-zinc-100" title="Run opens the main canvas beside the app" onClick={() => void action.run(async () => (await api.setHomeCanvas(ws.id, c.path), setList((await api.workspaceCanvases(ws.id)).canvases)))}>
                      Make home
                    </button>
                  )}
                  <button
                    className="px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
                    title="Open beside this view"
                    onClick={() => {
                      setOpen(false);
                      openBeside(`#/canvas/${encodeURIComponent(route(ws.id, c.path))}`);
                    }}
                  >
                    Beside
                  </button>
                </div>
              ))}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) void action.run(async () => navigate("canvas", route(ws.id, (await api.createCanvas(ws.id, name.trim())).path)));
              }}
            >
              <input className={inputClass} placeholder="New canvas name" value={name} onChange={(e) => setName(e.target.value)} />
              <Button type="submit" variant="primary" disabled={!name.trim() || action.busy}>
                Create
              </Button>
            </form>
            <ErrorText>{action.error}</ErrorText>
          </div>
        </div>
      )}
    </>
  );
}
