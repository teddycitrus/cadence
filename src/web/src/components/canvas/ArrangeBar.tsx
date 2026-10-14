import type { ArrangeOp } from "../../../../canvas/arrange";

const OPS: [ArrangeOp, string, string][] = [
  ["left", "Left", "Align left edges"],
  ["hcenter", "Center", "Align horizontal centers"],
  ["right", "Right", "Align right edges"],
  ["top", "Top", "Align top edges"],
  ["vcenter", "Middle", "Align vertical centers"],
  ["bottom", "Bottom", "Align bottom edges"],
  ["distribute-h", "Space H", "Equal gaps left to right (3 or more)"],
  ["distribute-v", "Space V", "Equal gaps top to bottom (3 or more)"],
];

/** Shown while frames are Shift+clicked together: align or space them out. */
export function ArrangeBar({ count, busy, onArrange, onClear }: { count: number; busy: boolean; onArrange: (op: ArrangeOp) => void; onClear: () => void }) {
  return (
    <div className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-zinc-900 px-2 py-1 text-xs shadow-xl ring-1 ring-zinc-700">
      <span className="pr-1 text-zinc-400">{count} selected</span>
      {OPS.map(([op, label, title]) => (
        <button key={op} className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40" disabled={busy || (op.startsWith("distribute") && count < 3)} onClick={() => onArrange(op)} title={title}>
          {label}
        </button>
      ))}
      <button className="rounded px-1.5 py-0.5 text-zinc-500 hover:text-zinc-100" onClick={onClear} title="Clear the selection (Esc)">
        x
      </button>
    </div>
  );
}
