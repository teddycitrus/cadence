import { useState } from "react";
import type { Workspace } from "../../../../core/types";
import { api } from "../../api";
import { ErrorText, inputClass, useAction } from "../ui";

/** The workspace's branch under the chat; switch to another local branch from here. */
export function BranchPicker({ ws, disabled }: { ws: Workspace; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const action = useAction();
  const show = () => {
    setOpen(!open);
    if (!open) void action.run(async () => setBranches((await api.git(ws.id)).branches.filter((b) => !b.remote).map((b) => b.name)));
  };
  const shown = (branches ?? []).filter((b) => !query || b.toLowerCase().includes(query.toLowerCase()));
  return (
    <span className="relative">
      <button className="block max-w-44 truncate font-mono text-zinc-500 hover:text-zinc-100 disabled:opacity-50" disabled={disabled} onClick={show} title={disabled ? "Wait for the turn to finish" : "Switch this workspace's branch"}>
        {ws.branch}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-6 z-50 w-64 space-y-1 rounded-lg bg-zinc-900 p-2 text-left shadow-2xl ring-1 ring-zinc-700">
            <input autoFocus className={`${inputClass} py-1! text-xs`} placeholder="Search branches" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="max-h-56 overflow-y-auto">
              {branches === null && <p className="px-2 py-1 text-zinc-500">Loading...</p>}
              {shown.map((b) => (
                <button
                  key={b}
                  className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] ${b === ws.branch ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800"}`}
                  onClick={() =>
                    b !== ws.branch &&
                    void action.run(async () => {
                      await api.gitAction(ws.id, "branches/switch", { name: b });
                      setOpen(false);
                    })
                  }
                >
                  {b}
                </button>
              ))}
            </div>
            <ErrorText>{action.error}</ErrorText>
          </div>
        </>
      )}
    </span>
  );
}
