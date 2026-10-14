import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { cadenceCodeTheme } from "../../editor-theme";
import { api, type SearchHit, type WorkspaceFile } from "../../api";
import { Button, ErrorText, inputClass, useAction } from "../ui";
import { codeIntelligence } from "./lsp";

/** Language support for a file name; each loads on first use. */
async function languageFor(path: string): Promise<Extension[]> {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext)) return [(await import("@codemirror/lang-javascript")).javascript({ jsx: ext.endsWith("x"), typescript: ext.startsWith("t") || ext.startsWith("m") || ext.startsWith("c") })];
  if (["css", "scss", "pcss"].includes(ext)) return [(await import("@codemirror/lang-css")).css()];
  if (["html", "htm", "svelte", "vue"].includes(ext)) return [(await import("@codemirror/lang-html")).html()];
  if (ext === "json") return [(await import("@codemirror/lang-json")).json()];
  if (["md", "markdown", "mdx"].includes(ext)) return [(await import("@codemirror/lang-markdown")).markdown()];
  if (ext === "py") return [(await import("@codemirror/lang-python")).python()];
  return [];
}

interface Node {
  name: string;
  path: string;
  children: Node[] | null;
}

function buildTree(paths: string[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const p of paths) {
    let at = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      let next = at.children!.find((c) => c.name === part && (c.children === null) === leaf);
      if (!next) {
        next = { name: part, path: parts.slice(0, i + 1).join("/"), children: leaf ? null : [] };
        at.children!.push(next);
      }
      at = next;
    });
  }
  const sort = (nodes: Node[]): Node[] => nodes.sort((a, b) => (a.children === null) === (b.children === null) ? a.name.localeCompare(b.name) : a.children === null ? 1 : -1).map((n) => (n.children ? { ...n, children: sort(n.children) } : n));
  return sort(root.children!);
}

function Tree({ nodes, open, onOpen, onMenu, depth = 0 }: { nodes: Node[]; open: string | null; onOpen: (path: string) => void; onMenu: (path: string, x: number, y: number) => void; depth?: number }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return (
    <>
      {nodes.map((n) =>
        n.children ? (
          <div key={n.path}>
            <button className="flex w-full items-center gap-1 truncate px-2 py-0.5 text-left text-xs text-zinc-400 hover:bg-zinc-900" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => setExpanded((s) => (s.has(n.path) ? new Set([...s].filter((x) => x !== n.path)) : new Set([...s, n.path])))}>
              <span className="w-3 text-zinc-600">{expanded.has(n.path) || open?.startsWith(`${n.path}/`) ? "v" : ">"}</span>
              {n.name}
            </button>
            {(expanded.has(n.path) || open?.startsWith(`${n.path}/`)) && <Tree nodes={n.children} open={open} onOpen={onOpen} onMenu={onMenu} depth={depth + 1} />}
          </div>
        ) : (
          <button key={n.path} className={`block w-full truncate px-2 py-0.5 text-left font-mono text-xs ${open === n.path ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900"}`} style={{ paddingLeft: 20 + depth * 12 }} onClick={() => onOpen(n.path)} onContextMenu={(e) => (e.preventDefault(), onMenu(n.path, e.clientX, e.clientY))}>
            {n.name}
          </button>
        ),
      )}
    </>
  );
}

/** Browse and edit the workspace's files. Agents and people share the same folder. */
export function FilesPanel({ workspaceId, openPath, root, intelligence = false }: { workspaceId: string; openPath?: { path: string; n: number } | null; root?: string; intelligence?: boolean }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState({ q: "", regex: false, word: false, matchCase: false });
  const [hits, setHits] = useState<{ hits: SearchHit[]; truncated: boolean } | null>(null);
  const jumpTo = useRef<number | null>(null);
  useEffect(() => {
    if (!searching || search.q.length < 2) return setHits(null);
    const t = window.setTimeout(() => void api.searchFiles(workspaceId, search).then(setHits, (e: Error) => action.setError(e.message)), 250);
    return () => window.clearTimeout(t);
  }, [searching, search, workspaceId]);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const action = useAction();
  const load = () => api.fileTree(workspaceId).then(setPaths, (e: Error) => action.setError(e.message));
  useEffect(() => void load(), [workspaceId]);

  const save = () =>
    file &&
    view.current &&
    action.run(async () => {
      setFile(await api.saveWorkspaceFile(workspaceId, file.path, view.current!.state.doc.toString()));
      setDirty(false);
    });
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    view.current?.destroy();
    view.current = null;
    if (!file || file.text === null || !host.current) return;
    let cancelled = false;
    void languageFor(file.path).then((lang) => {
      if (cancelled || !host.current) return;
      const editor = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: file.text!,
          extensions: [
            basicSetup,
            ...lang,
            ...(intelligence && root ? codeIntelligence(workspaceId, root, file.path) : []),
            cadenceCodeTheme,
            keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) }]),
            EditorView.updateListener.of((u) => u.docChanged && setDirty(true)),
            EditorView.theme({ "&": { height: "100%", fontSize: "12px" }, ".cm-scroller": { fontFamily: "var(--font-mono)" } }),
          ],
        }),
      });
      view.current = editor;
      // Opened from a search result: put the cursor on that line.
      const line = jumpTo.current;
      jumpTo.current = null;
      if (line && line <= editor.state.doc.lines) {
        const at = editor.state.doc.line(line).from;
        editor.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
        editor.focus();
      }
    });
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
  }, [file?.path, file === null]);

  const openFile = (path: string) => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    void action.run(async () => {
      setFile(await api.readWorkspaceFile(workspaceId, path));
      setDirty(false);
    });
  };
  // A file named in the chat opens here.
  useEffect(() => {
    if (openPath) openFile(openPath.path);
  }, [openPath?.n]);
  const tree = useMemo(() => buildTree((paths ?? []).filter((p) => !filter || p.toLowerCase().includes(filter.toLowerCase()))), [paths, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-zinc-900 p-2">
        <input className={`${inputClass} py-1! text-xs`} placeholder="Find a file" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button className="py-1! text-xs" variant={searching ? "secondary" : "ghost"} onClick={() => setSearching(!searching)} title="Search in files">
          Search
        </Button>
        <Button
          className="py-1! text-xs"
          onClick={() => {
            const name = prompt("New file path (e.g. src/utils/dates.ts)");
            if (name) void action.run(async () => (setFile(await api.saveWorkspaceFile(workspaceId, name, "", true)), setDirty(false), await load()));
          }}
        >
          New
        </Button>
        <Button
          className="py-1! text-xs"
          onClick={() => {
            const dir = prompt("New folder path (e.g. src/features/billing)")?.trim().replace(/\/+$/, "");
            if (dir) void action.run(async () => (await api.saveWorkspaceFile(workspaceId, `${dir}/.gitkeep`, "", true), await load()));
          }}
          title="Git keeps a folder once it has a file, so it starts with an empty .gitkeep"
        >
          Folder
        </Button>
      </div>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
          <div className="fixed z-50 w-40 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700" style={{ left: menu.x, top: menu.y }}>
            <button className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800" onClick={() => (setMenu(null), openFile(menu.path))}>
              Open
            </button>
            <button
              className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
              onClick={() => {
                setMenu(null);
                const to = prompt("Rename to", menu.path);
                if (to && to !== menu.path) void action.run(async () => (await api.renameWorkspaceFile(workspaceId, menu.path, to), file?.path === menu.path && setFile(null), await load()));
              }}
            >
              Rename
            </button>
            <button className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800" onClick={() => (setMenu(null), void navigator.clipboard.writeText(menu.path))}>
              Copy path
            </button>
            <button
              className="block w-full px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
              onClick={() => {
                setMenu(null);
                if (confirm(`Delete ${menu.path}?`)) void action.run(async () => (await api.deleteWorkspaceFile(workspaceId, menu.path), file?.path === menu.path && setFile(null), await load()));
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
      {searching && (
        <div className="space-y-1 border-b border-zinc-900 p-2 text-xs">
          <input autoFocus className={`${inputClass} py-1! text-xs`} placeholder="Search in files" value={search.q} onChange={(e) => setSearch({ ...search, q: e.target.value })} />
          <div className="flex gap-3 text-zinc-400">
            {(
              [
                ["matchCase", "Match case"],
                ["word", "Whole word"],
                ["regex", "Regular expression"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1">
                <input type="checkbox" checked={search[k]} onChange={(e) => setSearch({ ...search, [k]: e.target.checked })} /> {label}
              </label>
            ))}
          </div>
          <div className="max-h-56 overflow-y-auto">
            {hits?.hits.length === 0 && <p className="text-zinc-500">No matches.</p>}
            {hits?.hits.map((h, i) => (
              <button
                key={`${h.path}:${h.line}:${i}`}
                className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[11px] hover:bg-zinc-900"
                onClick={() => {
                  const v = view.current;
                  if (file?.path === h.path && v && h.line <= v.state.doc.lines) {
                    const at = v.state.doc.line(h.line).from;
                    v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
                    v.focus();
                  } else {
                    jumpTo.current = h.line;
                    openFile(h.path);
                  }
                }}
              >
                <span className="text-zinc-500">
                  {h.path}:{h.line}
                </span>{" "}
                <span className="text-zinc-300">{h.text.trim()}</span>
              </button>
            ))}
            {hits?.truncated && <p className="text-zinc-500">Showing the first 500 matches.</p>}
          </div>
        </div>
      )}
      <div className="max-h-[40%] min-h-24 overflow-y-auto border-b border-zinc-900 py-1">{paths === null ? <p className="p-2 text-xs text-zinc-500">Loading...</p> : <Tree nodes={tree} open={file?.path ?? null} onOpen={openFile} onMenu={(path, x, y) => setMenu({ path, x, y })} />}</div>
      {file && (
        <div className="flex items-center gap-2 border-b border-zinc-900 px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
            {file.path}
            {dirty && <span className="text-amber-300"> (unsaved)</span>}
          </span>
          <Button className="py-0.5! text-xs" variant="primary" disabled={!dirty || action.busy} onClick={() => void save()}>
            Save
          </Button>
          <Button
            className="py-0.5! text-xs"
            variant="ghost"
            onClick={() => {
              const to = prompt("Rename to", file.path);
              if (to && to !== file.path) void action.run(async () => (setFile(await api.readWorkspaceFile(workspaceId, (await api.renameWorkspaceFile(workspaceId, file.path, to)).path)), await load()));
            }}
          >
            Rename
          </Button>
          <Button className="py-0.5! text-xs text-red-400" variant="ghost" onClick={() => confirm(`Delete ${file.path}?`) && void action.run(async () => (await api.deleteWorkspaceFile(workspaceId, file.path), setFile(null), setDirty(false), await load()))}>
            Delete
          </Button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
      {file && file.text === null ? (
        <p className="p-4 text-sm text-zinc-500">{file.reason === "binary" ? "This is a binary file." : "This file is too large to edit here."} ({Math.round(file.size / 1024)} KB)</p>
      ) : (
        <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
      )}
      {!file && <p className="p-4 text-sm text-zinc-500">Pick a file to view or edit it. Save with Ctrl+S.</p>}
    </div>
  );
}
