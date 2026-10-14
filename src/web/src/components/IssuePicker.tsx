import { useEffect, useRef, useState } from "react";
import type { Issue } from "../../../core/types";

/**
 * Picks one issue (or none) by searching key and title. A board can hold
 * thousands of issues, so nothing is listed until it opens, and then only the
 * best 50 matches for what is typed.
 */
export function IssuePicker({ issues, value, onChange, none, className = "" }: { issues: Issue[]; value: string | null; onChange: (id: string | null) => void; none: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const current = value ? issues.find((i) => i.id === value) : undefined;
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = open ? issues.filter((i) => words.every((w) => `${i.key} ${i.title}`.toLowerCase().includes(w))).slice(0, 50) : [];
  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  return (
    <div ref={box} className={`relative ${className}`}>
      <button type="button" className="w-full truncate rounded bg-zinc-900 px-1.5 py-0.5 text-left text-xs text-zinc-300 ring-1 ring-zinc-800 hover:ring-zinc-600" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {current ? `${current.key} ${current.title}` : none}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-80 max-w-[80vw] rounded-md bg-zinc-900 p-1 shadow-xl ring-1 ring-zinc-700">
          <input
            autoFocus
            className="mb-1 w-full rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-200 ring-1 ring-zinc-800 outline-none focus:ring-violet-500"
            placeholder="Search by key or title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && matches[0]) pick(matches[0].id);
            }}
          />
          <ul role="listbox" className="max-h-64 overflow-y-auto text-xs">
            <li>
              <button type="button" className="w-full rounded px-2 py-1 text-left text-zinc-400 hover:bg-zinc-800" onClick={() => pick(null)}>
                {none}
              </button>
            </li>
            {matches.map((i) => (
              <li key={i.id}>
                <button type="button" role="option" aria-selected={i.id === value} className={`w-full truncate rounded px-2 py-1 text-left hover:bg-zinc-800 ${i.id === value ? "text-violet-300" : "text-zinc-200"}`} onClick={() => pick(i.id)}>
                  <span className="font-mono text-zinc-500">{i.key}</span> {i.title}
                </button>
              </li>
            ))}
            {!matches.length && <li className="px-2 py-1 text-zinc-500">No issue matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
