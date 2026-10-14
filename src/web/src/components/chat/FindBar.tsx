import { useEffect, useRef, useState, type RefObject } from "react";

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = () => (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
const HighlightCtor = () => (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

/** Every match of `query` in the container's text, as ranges. */
function findRanges(root: HTMLElement, query: string): Range[] {
  const out: Range[] = [];
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && out.length < 500; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? "";
    for (let i = text.indexOf(needle); i >= 0 && out.length < 500; i = text.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

/** Find in this chat: highlights every match and steps through them with Enter. */
export function FindBar({ scope, onClose }: { scope: RefObject<HTMLElement | null>; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const ranges = useRef<Range[]>([]);
  useEffect(() => {
    const root = scope.current;
    const reg = registry();
    const Ctor = HighlightCtor();
    ranges.current = root && query.trim().length > 1 ? findRanges(root, query.trim()) : [];
    setIndex(0);
    if (reg && Ctor) {
      if (ranges.current.length) reg.set("cadence-find", new Ctor(...ranges.current));
      else reg.delete("cadence-find");
    }
    ranges.current[0]?.startContainer.parentElement?.scrollIntoView({ block: "center" });
    return () => reg?.delete("cadence-find");
  }, [query]);
  const step = (by: number) => {
    const n = ranges.current.length;
    if (!n) return;
    const next = (index + by + n) % n;
    setIndex(next);
    ranges.current[next]!.startContainer.parentElement?.scrollIntoView({ block: "center" });
  };
  return (
    <div className="flex items-center gap-2 border-b border-zinc-900 px-4 py-1.5 text-xs">
      <input
        autoFocus
        className="w-64 rounded bg-zinc-900 px-2 py-1 text-zinc-100 ring-1 ring-zinc-800 outline-none focus:ring-violet-500"
        placeholder="Find in this chat"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") onClose();
        }}
      />
      <span className="text-zinc-500">{ranges.current.length ? `${index + 1} of ${ranges.current.length}` : query.trim().length > 1 ? "No matches" : ""}</span>
      <button className="text-zinc-500 hover:text-zinc-100" onClick={() => step(-1)} aria-label="Previous match">
        Up
      </button>
      <button className="text-zinc-500 hover:text-zinc-100" onClick={() => step(1)} aria-label="Next match">
        Down
      </button>
      <button className="ml-auto text-zinc-500 hover:text-zinc-100" onClick={onClose} aria-label="Close find">
        ×
      </button>
    </div>
  );
}
