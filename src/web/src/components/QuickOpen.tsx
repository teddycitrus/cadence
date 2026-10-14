import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "../../../core/types";
import { api, type CanvasEntry } from "../api";

interface Item {
  section: "Chats" | "Issues" | "Docs" | "Canvases" | "Agents" | "Workspaces" | "Go to";
  label: string;
  detail: string;
  href: string;
}

/** Scores how well a query matches: all words must appear; earlier and whole-word hits rank higher. */
function score(text: string, words: string[]): number {
  const t = text.toLowerCase();
  let total = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i < 0) return -1;
    total += i === 0 ? 3 : /\W/.test(t[i - 1] ?? "") ? 2 : 1;
  }
  return total;
}

/** Ctrl+K (Cmd+K): jump to any chat, issue, doc, canvas, agent, or workspace by name. */
export function QuickOpen({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [canvases, setCanvases] = useState<CanvasEntry[]>([]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.canvases().then(setCanvases, () => undefined);
  }, []);

  const all = useMemo<Item[]>(
    () => [
      ...(["home", "chats", "issues", "agents", "docs", "canvas", "settings"] as const).map((v) => ({ section: "Go to" as const, label: v === "canvas" ? "Canvases" : v[0]!.toUpperCase() + v.slice(1), detail: "", href: `#/${v}` })),
      ...snapshot.chats.filter((c) => !c.archived).map((c) => ({ section: "Chats" as const, label: c.title, detail: snapshot.workspaces.find((w) => w.id === c.workspaceId)?.name ?? "", href: `#/chats/${c.id}` })),
      ...snapshot.issues.map((i) => ({ section: "Issues" as const, label: i.title, detail: i.key, href: `#/issues/${encodeURIComponent(i.key)}` })),
      ...snapshot.docs.map((d) => ({ section: "Docs" as const, label: d.title, detail: "", href: `#/docs/${d.id}` })),
      ...canvases.filter((c) => c.workspaceId).map((c) => ({ section: "Canvases" as const, label: c.name, detail: `${c.branch ?? ""} · ${c.path}`, href: `#/canvas/${encodeURIComponent(`${c.workspaceId}|${c.path}`)}` })),
      ...snapshot.agents.map((a) => ({ section: "Agents" as const, label: a.name, detail: a.description, href: `#/agents/${a.id}` })),
      ...snapshot.workspaces.filter((w) => !w.archived).map((w) => {
        const chat = snapshot.chats.find((c) => c.workspaceId === w.id && !c.archived);
        return { section: "Workspaces" as const, label: w.name, detail: w.branch ?? "", href: chat ? `#/chats/${chat.id}` : "#/chats" };
      }),
    ],
    [snapshot, canvases],
  );

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = words.length
    ? all
        .map((i) => ({ i, s: Math.max(score(i.label, words) * 2, score(`${i.label} ${i.detail}`, words)) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((r) => r.i)
    : all.filter((i) => i.section === "Go to" || i.section === "Chats").slice(0, 20);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const go = (item: Item | undefined) => {
    if (!item) return;
    window.location.hash = item.href.slice(1);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/50 pt-[15vh]" onClick={onClose}>
      <div className="flex max-h-[60vh] w-[36rem] flex-col overflow-hidden rounded-xl bg-zinc-900 shadow-2xl ring-1 ring-zinc-700" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="border-b border-zinc-800 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-zinc-500"
          placeholder="Jump to a chat, issue, doc, canvas, agent..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setIndex((n) => Math.min(n + 1, results.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((n) => Math.max(n - 1, 0)));
            else if (e.key === "Enter") go(results[index]);
            else if (e.key === "Escape") onClose();
          }}
        />
        <div ref={list} className="min-h-0 overflow-y-auto py-1">
          {results.length === 0 && <p className="px-4 py-3 text-sm text-zinc-500">Nothing matches.</p>}
          {results.map((r, n) => (
            <button key={`${r.section}${r.href}`} data-index={n} className={`flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm ${n === index ? "bg-zinc-800" : ""}`} onMouseEnter={() => setIndex(n)} onClick={() => go(r)}>
              <span className="w-20 shrink-0 text-[11px] text-zinc-500">{r.section}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-100">{r.label}</span>
              {r.detail && <span className="max-w-48 shrink-0 truncate font-mono text-[11px] text-zinc-500">{r.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
