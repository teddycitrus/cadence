import { useState, type ReactNode } from "react";
import type { GitFile } from "../../api";

export type FileSort = "path" | "name" | "status";
export type FileView = "list" | "tree";

const PREF = "cadence.git.files";

function stored(): { sort: FileSort; view: FileView } {
  try {
    const v = JSON.parse(localStorage.getItem(PREF) ?? "null") as { sort?: FileSort; view?: FileView } | null;
    return { sort: v?.sort ?? "path", view: v?.view ?? "list" };
  } catch {
    return { sort: "path", view: "list" };
  }
}

/** How the changes lists are sorted and shown, remembered per browser. */
export function useFilePrefs() {
  const [prefs, setPrefs] = useState(stored);
  const set = (next: Partial<typeof prefs>) =>
    setPrefs((p) => {
      const merged = { ...p, ...next };
      try {
        localStorage.setItem(PREF, JSON.stringify(merged));
      } catch {
        // storage unavailable
      }
      return merged;
    });
  return [prefs, set] as const;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function sortFiles(files: GitFile[], sort: FileSort): GitFile[] {
  const out = [...files];
  if (sort === "name") return out.sort((a, b) => base(a.path).localeCompare(base(b.path)) || a.path.localeCompare(b.path));
  if (sort === "status") return out.sort((a, b) => a.status.localeCompare(b.status) || a.path.localeCompare(b.path));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The sort and view switches above the changes lists. */
export function FileListControls({ prefs, onChange }: { prefs: { sort: FileSort; view: FileView }; onChange: (p: Partial<{ sort: FileSort; view: FileView }>) => void }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-1 text-[11px] text-zinc-500">
      <label className="flex items-center gap-1">
        Sort
        <select className="rounded bg-zinc-900 px-1 py-0.5 text-zinc-300 ring-1 ring-zinc-800" value={prefs.sort} onChange={(e) => onChange({ sort: e.target.value as FileSort })}>
          <option value="path">Path</option>
          <option value="name">Name</option>
          <option value="status">Status</option>
        </select>
      </label>
      <button className="ml-auto rounded px-1.5 py-0.5 hover:bg-zinc-900 hover:text-zinc-200" title="Switch changes view" onClick={() => onChange({ view: prefs.view === "list" ? "tree" : "list" })}>
        {prefs.view === "list" ? "Tree view" : "List view"}
      </button>
    </div>
  );
}

/** Files as a flat list, or grouped under their folders. */
export function FileList({ files, prefs, row }: { files: GitFile[]; prefs: { sort: FileSort; view: FileView }; row: (f: GitFile) => ReactNode }) {
  if (prefs.view === "list") return <>{sortFiles(files, prefs.sort).map(row)}</>;
  const groups = new Map<string, GitFile[]>();
  for (const f of sortFiles(files, prefs.sort)) groups.set(dir(f.path), [...(groups.get(dir(f.path)) ?? []), f]);
  return (
    <>
      {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([folder, list]) => (
        <div key={folder || "."}>
          <p className="truncate px-3 pt-1 font-mono text-[11px] text-zinc-500">{folder ? `${folder}/` : "./"}</p>
          <div className="pl-3">{list.map(row)}</div>
        </div>
      ))}
    </>
  );
}
