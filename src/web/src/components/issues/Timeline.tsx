import { useMemo, useRef } from "react";
import type { Issue, Snapshot } from "../../../../core/types";

const DAY_PX = 28;
const DAY = 86_400_000;
const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const label = (d: number) => new Date(d * DAY).toISOString().slice(5, 10);

/** Issues with dates, as bars on a day grid. Drag to scroll; click a bar to open the issue. */
export function Timeline({ issues, snapshot, onOpen }: { issues: Issue[]; snapshot: Snapshot; onOpen: (key: string) => void }) {
  const dated = issues.filter((i) => i.startDate || i.dueDate);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const { first, days } = useMemo(() => {
    const today = Math.floor(Date.now() / DAY);
    const all = dated.flatMap((i) => [i.startDate, i.dueDate].filter(Boolean).map((d) => day(d!)));
    const lo = Math.min(today, ...all) - 3;
    const hi = Math.max(today, ...all) + 7;
    return { first: lo, days: hi - lo + 1 };
  }, [dated]);
  const today = Math.floor(Date.now() / DAY) - first;
  if (!dated.length) return <p className="p-8 text-center text-sm text-zinc-500">No issues in this view have dates. Give an issue a start or due date to see it here.</p>;
  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 cursor-grab overflow-auto select-none active:cursor-grabbing"
      onMouseDown={(e) => (drag.current = { x: e.clientX, left: scroller.current!.scrollLeft, moved: false })}
      onMouseMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.x;
        if (Math.abs(dx) > 3) drag.current.moved = true;
        scroller.current!.scrollLeft = drag.current.left - dx;
      }}
      onMouseUp={() => setTimeout(() => (drag.current = null))}
      onMouseLeave={() => (drag.current = null)}
    >
      <div style={{ minWidth: 240 + days * DAY_PX }}>
        <div className="sticky top-0 z-10 flex border-b border-zinc-900 bg-zinc-950 text-[10px] text-zinc-500">
          <div className="sticky left-0 z-20 w-60 shrink-0 bg-zinc-950 px-3 py-1">{dated.length} issue{dated.length === 1 ? "" : "s"} with dates</div>
          {Array.from({ length: days }, (_, n) => (
            <div key={n} className={`shrink-0 border-l border-zinc-900 py-1 text-center ${n === today ? "text-violet-300" : ""}`} style={{ width: DAY_PX }}>
              {(first + n) % 7 === 4 || n === today ? label(first + n) : ""}
            </div>
          ))}
        </div>
        {dated.map((i) => {
          const start = day(i.startDate ?? i.dueDate!) - first;
          const end = day(i.dueDate ?? i.startDate!) - first;
          const stage = snapshot.stages.find((s) => s.id === i.stageId);
          return (
            <div key={i.id} className="relative flex h-8 items-center border-b border-zinc-900/60">
              <div className="sticky left-0 z-10 w-60 shrink-0 truncate bg-zinc-950 px-3 text-xs">
                <span className="mr-2 font-mono text-zinc-500">{i.key}</span>
                {i.title}
              </div>
              <div className="absolute top-0 bottom-0 border-l border-violet-500/40" style={{ left: 240 + today * DAY_PX + DAY_PX / 2 }} />
              <button
                className="absolute h-5 truncate rounded px-1.5 text-left text-[11px] text-zinc-950"
                style={{ left: 240 + start * DAY_PX + 2, width: Math.max(1, end - start + 1) * DAY_PX - 4, background: stage?.color ?? "#7a4a6e" }}
                title={`${i.startDate ?? "?"} to ${i.dueDate ?? "?"}`}
                onClick={() => !drag.current?.moved && onOpen(i.key)}
              >
                {i.title}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
