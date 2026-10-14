import { useState } from "react";
import type { Snapshot, Stage, StageCategory } from "../../../../core/types";
import { STAGE_CATEGORIES } from "../../../../core/types";
import { api } from "../../api";
import { Button, ErrorText, inputClass, useAction } from "../ui";

const CATEGORY_LABEL: Record<StageCategory, string> = { triage: "Triage", in_progress: "In Progress", in_review: "In Review", done: "Done", cancelled: "Cancelled" };

function StageRow({ stage, stages, onMove }: { stage: Stage; stages: Stage[]; onMove: (dir: -1 | 1) => void }) {
  const action = useAction();
  const [deleting, setDeleting] = useState(false);
  const [target, setTarget] = useState(stages.find((s) => s.id !== stage.id)?.id ?? "");
  const patch = (p: Record<string, unknown>) => action.run(() => api.updateStage(stage.id, p));
  return (
    <div className="space-y-2 border-b border-zinc-900 px-3 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <input type="color" className="size-6 shrink-0 rounded bg-transparent" value={stage.color} onChange={(e) => patch({ color: e.target.value })} />
        <input className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none" defaultValue={stage.name} onBlur={(e) => e.target.value.trim() && e.target.value !== stage.name && patch({ name: e.target.value })} />
        <label className="flex items-center gap-1 text-xs text-zinc-400" title="Agents cannot move cards out of this stage">
          <input type="checkbox" checked={stage.humanGate} onChange={(e) => patch({ humanGate: e.target.checked })} /> Sign-off stage
        </label>
        <label className="flex items-center gap-1 text-xs text-zinc-400">
          <input type="checkbox" checked={stage.hidden} onChange={(e) => patch({ hidden: e.target.checked })} /> Hidden
        </label>
        <Button variant="ghost" onClick={() => onMove(-1)} title="Move up">
          ↑
        </Button>
        <Button variant="ghost" onClick={() => onMove(1)} title="Move down">
          ↓
        </Button>
        <Button variant="danger" onClick={() => setDeleting((d) => !d)}>
          Delete
        </Button>
      </div>
      {deleting && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-zinc-400">Move its issues to</span>
          <select className={`${inputClass} w-56`} value={target} onChange={(e) => setTarget(e.target.value)}>
            {stages
              .filter((s) => s.id !== stage.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          <Button variant="danger" onClick={() => action.run(() => api.deleteStage(stage.id, target))}>
            Delete stage
          </Button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

export function StagesEditor({ snapshot }: { snapshot: Snapshot }) {
  const stages = snapshot.stages;
  const action = useAction();
  const [adding, setAdding] = useState<StageCategory | null>(null);
  const [name, setName] = useState("");

  const move = (stage: Stage, dir: -1 | 1) => {
    // Reorder within the stage's category; categories keep their fixed order.
    const ordered = STAGE_CATEGORIES.flatMap((c) => stages.filter((s) => s.category === c));
    const peers = ordered.filter((s) => s.category === stage.category);
    const idx = peers.findIndex((s) => s.id === stage.id);
    const swap = peers[idx + dir];
    if (!swap) return;
    const order = ordered.map((s) => s.id);
    const a = order.indexOf(stage.id);
    const b = order.indexOf(swap.id);
    [order[a], order[b]] = [order[b]!, order[a]!];
    void action.run(() => api.reorderStages(order));
  };

  return (
    <div className="max-w-3xl space-y-5">
      {STAGE_CATEGORIES.map((cat) => (
        <section key={cat} className="overflow-hidden rounded-xl bg-zinc-900/60 ring-1 ring-zinc-800">
          <header className="flex items-center justify-between bg-zinc-900 px-3 py-2">
            <h2 className="text-sm font-medium">{CATEGORY_LABEL[cat]}</h2>
            <button className="text-lg leading-none text-zinc-500 hover:text-zinc-100" onClick={() => setAdding(cat)}>
              +
            </button>
          </header>
          {stages
            .filter((s) => s.category === cat)
            .map((s) => (
              <StageRow key={s.id} stage={s} stages={stages} onMove={(dir) => move(s, dir)} />
            ))}
          {adding === cat && (
            <form
              className="flex gap-2 p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await action.run(() => api.createStage({ name, category: cat, color: "#a39383" }))) {
                  setName("");
                  setAdding(null);
                }
              }}
            >
              <input autoFocus className={inputClass} placeholder="Stage name" value={name} onChange={(e) => setName(e.target.value)} />
              <Button variant="primary" type="submit" disabled={!name.trim()}>
                Add
              </Button>
            </form>
          )}
        </section>
      ))}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}
