import type { Issue, Snapshot } from "../../../../core/types";
import { ISSUE_TYPES, PRIORITIES } from "../../../../core/types";
import { api } from "../../api";

const SELECT = "min-w-0 rounded bg-zinc-950 px-1 py-0.5 text-[11px] text-zinc-300 ring-1 ring-zinc-800 hover:ring-zinc-600";

/** Quick edits on a board card, shown on hover: stage, priority, type, estimate, and assignee. */
export function CardControls({ issue, snapshot }: { issue: Issue; snapshot: Snapshot }) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const assignee = (value: string) => {
    if (!value) return;
    const [kind, id] = value.split(":") as ["user" | "agent", string];
    const on = !issue.assignees.some((a) => a.kind === kind && a.id === id);
    void api.toggleAssignee(issue.id, { kind, id }, on);
  };
  return (
    <div className="mt-2 hidden flex-wrap gap-1 group-hover:flex" onClick={stop} onPointerDown={stop} onKeyDown={stop}>
      <select className={SELECT} value={issue.stageId} title="Stage" onChange={(e) => void api.moveIssue(issue.id, e.target.value)}>
        {snapshot.stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <select className={SELECT} value={issue.priority} title="Priority" onChange={(e) => void api.updateIssue(issue.id, { priority: e.target.value })}>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p === "none" ? "No priority" : p}
          </option>
        ))}
      </select>
      <select className={SELECT} value={issue.type} title="Type" onChange={(e) => void api.updateIssue(issue.id, { type: e.target.value })}>
        {ISSUE_TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <select className={SELECT} value={issue.estimate ?? ""} title="Estimate" onChange={(e) => void api.updateIssue(issue.id, { estimate: e.target.value === "" ? null : Number(e.target.value) })}>
        <option value="">No estimate</option>
        {[1, 2, 3, 5, 8, 13].map((n) => (
          <option key={n} value={n}>
            {n} pt
          </option>
        ))}
      </select>
      <select className={SELECT} value="" title="Assign or unassign" onChange={(e) => assignee(e.target.value)}>
        <option value="">Assign...</option>
        {snapshot.members.map((m) => (
          <option key={m.id} value={`user:${m.id}`}>
            {issue.assignees.some((a) => a.id === m.id) ? "- " : "+ "}
            {m.name}
          </option>
        ))}
        {snapshot.agents.map((a) => (
          <option key={a.id} value={`agent:${a.id}`}>
            {issue.assignees.some((x) => x.id === a.id) ? "- " : "+ "}
            {a.name} (agent)
          </option>
        ))}
      </select>
    </div>
  );
}
