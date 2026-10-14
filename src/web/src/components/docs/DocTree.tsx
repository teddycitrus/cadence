import { useState, type DragEvent } from "react";
import type { Doc } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";

const ICONS = ["", "★", "◆", "●", "▲", "■", "✎", "⚑", "☰", "⚙", "✓", "?", "!", "#"];

export function childrenOf(docs: Doc[], parentId: string | null): Doc[] {
  return docs.filter((d) => d.parentId === parentId).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

type Drop = { id: string; where: "before" | "inside" | "after" } | null;

function DocRow({ doc, docs, depth, selected, query, onError, drop, setDrop }: { doc: Doc; docs: Doc[]; depth: number; selected: string | null; query: string; onError: (e: string) => void; drop: Drop; setDrop: (d: Drop) => void }) {
  const children = childrenOf(docs, doc.id);
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState(false);
  const [iconMenu, setIconMenu] = useState(false);
  const act = (fn: () => Promise<unknown>) => fn().catch((e: Error) => onError(e.message));
  const siblings = childrenOf(docs, doc.parentId);
  const index = siblings.findIndex((d) => d.id === doc.id);
  const matches = !query || doc.title.toLowerCase().includes(query);
  const childMatches = (d: Doc): boolean => d.title.toLowerCase().includes(query) || childrenOf(docs, d.id).some(childMatches);
  if (query && !matches && !children.some(childMatches)) return null;

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    setDrop({ id: doc.id, where: y < 0.25 ? "before" : y > 0.75 ? "after" : "inside" });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const moving = e.dataTransfer.getData("text/doc");
    const target = drop;
    setDrop(null);
    if (!moving || !target || moving === doc.id) return;
    if (target.where === "inside") {
      void act(() => api.moveDoc(moving, doc.id, children.filter((d) => d.id !== moving).length));
      return;
    }
    // Positions are counted among the siblings without the doc being moved.
    const at = siblings.filter((d) => d.id !== moving).findIndex((d) => d.id === doc.id);
    void act(() => api.moveDoc(moving, doc.parentId, target.where === "before" ? at : at + 1));
  };
  const marker = drop?.id === doc.id ? drop.where : null;

  return (
    <li>
      <div
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/doc", doc.id)}
        onDragOver={onDragOver}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        className={`group relative flex items-center gap-1 rounded-md pr-1 text-sm ${doc.id === selected ? "bg-zinc-800" : "hover:bg-zinc-900"} ${marker === "inside" ? "ring-1 ring-violet-500" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {marker === "before" && <span className="absolute inset-x-0 top-0 h-0.5 bg-violet-500" />}
        {marker === "after" && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-violet-500" />}
        <button className={`w-4 shrink-0 text-xs text-zinc-500 ${children.length ? "" : "invisible"}`} onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"}>
          {open ? "▾" : "▸"}
        </button>
        <a href={`#/docs/${doc.id}`} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5">
          <span className="w-4 shrink-0 text-center text-xs text-zinc-400">{doc.icon || (doc.kind === "pdf" ? "▤" : "▫")}</span>
          <span className="truncate">{doc.title}</span>
        </a>
        <button className="shrink-0 rounded px-1 text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-800" title="Add sub-page" onClick={() => act(async () => navigate("docs", (await api.createDoc({ title: "Untitled", parentId: doc.id })).id))}>
          +
        </button>
        <button className="shrink-0 rounded px-1 text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-800" title="More" onClick={() => setMenu((m) => !m)}>
          ⋯
        </button>
        {menu && (
          <div className="absolute top-full right-0 z-30 w-48 rounded-lg bg-zinc-900 p-1 text-sm shadow-2xl ring-1 ring-zinc-700" onMouseLeave={() => (setMenu(false), setIconMenu(false))}>
            <button className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" onClick={() => setIconMenu((v) => !v)}>
              Change icon
            </button>
            {iconMenu && (
              <div className="grid grid-cols-7 gap-0.5 p-1">
                {ICONS.map((i) => (
                  <button key={i || "none"} className="rounded py-0.5 text-center hover:bg-zinc-800" onClick={() => act(() => api.updateDoc(doc.id, { icon: i || null }))}>
                    {i || "∅"}
                  </button>
                ))}
              </div>
            )}
            <button className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800 disabled:opacity-40" disabled={index <= 0} onClick={() => act(() => api.moveDoc(doc.id, doc.parentId, index - 1))}>
              Move up
            </button>
            <button className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800 disabled:opacity-40" disabled={index >= siblings.length - 1} onClick={() => act(() => api.moveDoc(doc.id, doc.parentId, index + 1))}>
              Move down
            </button>
            <button className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800 disabled:opacity-40" disabled={!doc.parentId} onClick={() => act(() => api.moveDoc(doc.id, null, childrenOf(docs, null).length))}>
              Move to top level
            </button>
            <button
              className="block w-full rounded px-2 py-1 text-left text-red-400 hover:bg-zinc-800"
              onClick={() => {
                if (!confirm(`Delete "${doc.title}"${children.length ? " and its sub-pages" : ""}?`)) return;
                void act(async () => {
                  await api.deleteDoc(doc.id);
                  if (selected === doc.id) navigate("docs");
                });
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {open && children.length > 0 && (
        <ul>
          {children.map((c) => (
            <DocRow key={c.id} doc={c} docs={docs} depth={depth + 1} selected={selected} query={query} onError={onError} drop={drop} setDrop={setDrop} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function DocTree({ docs, selected, query, onError }: { docs: Doc[]; selected: string | null; query: string; onError: (e: string) => void }) {
  const [drop, setDrop] = useState<Drop>(null);
  return (
    <ul className="space-y-px">
      {childrenOf(docs, null).map((d) => (
        <DocRow key={d.id} doc={d} docs={docs} depth={0} selected={selected} query={query.toLowerCase()} onError={onError} drop={drop} setDrop={setDrop} />
      ))}
    </ul>
  );
}
