import { useState } from "react";
import type { Issue, Snapshot } from "../../../../core/types";
import { PRIORITIES } from "../../../../core/types";
import { isUnread, type CardProp, type Group } from "../../../../core/issue-views";
import { api } from "../../api";
import { AgentAvatar, Button, Dot, ErrorText, PriorityIcon, UserAvatar, timeAgo, useAction } from "../ui";
import { CreateWorkspacesDialog } from "./CreateWorkspacesDialog";
import { useGrowingList } from "../useGrowingList";

const SELECT = "rounded-md bg-zinc-950 px-2 py-1 text-xs text-zinc-200 ring-1 ring-zinc-800";

/** What to do with several issues at once. */
function BulkBar({ issues, snapshot, onDone }: { issues: Issue[]; snapshot: Snapshot; onDone: () => void }) {
  const action = useAction();
  const [workspaces, setWorkspaces] = useState(false);
  const each = (fn: (i: Issue) => Promise<unknown>) =>
    action.run(async () => {
      for (const i of issues) await fn(i);
      onDone();
    });
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-violet-900 bg-zinc-950 px-4 py-2 text-xs">
      <span className="font-medium text-violet-200">{issues.length} selected</span>
      <select className={SELECT} value="" onChange={(e) => e.target.value && void each((i) => api.moveIssue(i.id, e.target.value))}>
        <option value="">Move to...</option>
        {snapshot.stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <select className={SELECT} value="" onChange={(e) => e.target.value && void each((i) => api.updateIssue(i.id, { priority: e.target.value }))}>
        <option value="">Priority...</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select
        className={SELECT}
        value=""
        onChange={(e) => {
          const [kind, id] = e.target.value.split(":") as ["user" | "agent", string];
          if (id) void each((i) => (i.assignees.some((a) => a.id === id) ? Promise.resolve() : api.toggleAssignee(i.id, { kind, id }, true)));
        }}
      >
        <option value="">Assign to...</option>
        {snapshot.members.map((m) => (
          <option key={m.id} value={`user:${m.id}`}>
            {m.name}
          </option>
        ))}
        {snapshot.agents.map((a) => (
          <option key={a.id} value={`agent:${a.id}`}>
            {a.name} (agent)
          </option>
        ))}
      </select>
      <select className={SELECT} value="" onChange={(e) => e.target.value && void each((i) => (i.labelIds.includes(e.target.value) ? Promise.resolve() : api.toggleLabel(i.id, e.target.value, true)))}>
        <option value="">Add label...</option>
        {snapshot.labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <Button className="py-1! text-xs" onClick={() => setWorkspaces(true)}>
        Create workspaces
      </Button>
      <Button className="py-1! text-xs text-red-400" variant="ghost" disabled={action.busy} onClick={() => confirm(`Delete ${issues.length} issue${issues.length === 1 ? "" : "s"}?`) && void each((i) => api.deleteIssue(i.id))}>
        Delete
      </Button>
      <Button className="ml-auto py-1! text-xs" variant="ghost" onClick={onDone}>
        Clear selection
      </Button>
      <ErrorText>{action.error}</ErrorText>
      {workspaces && <CreateWorkspacesDialog issues={issues} snapshot={snapshot} onClose={() => setWorkspaces(false)} />}
    </div>
  );
}

/** The board as grouped rows, with selection for bulk changes. */
export function IssueList({ groups, snapshot, awaiting, show, onOpen }: { groups: (Group & { sub?: Group[] | null })[]; snapshot: Snapshot; awaiting: (issue: Issue) => boolean; show: (p: CardProp) => boolean; onOpen: (key: string) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const all = groups.flatMap((g) => g.issues);
  const row = (issue: Issue) => {
    const stage = snapshot.stages.find((s) => s.id === issue.stageId);
    return (
      <div key={issue.id} className={`flex items-center gap-3 border-b border-zinc-900/60 px-4 py-1.5 text-sm hover:bg-zinc-900/60 ${selected.has(issue.id) ? "bg-violet-950/30" : ""}`}>
        <input type="checkbox" checked={selected.has(issue.id)} onChange={(e) => toggle([issue.id], e.target.checked)} aria-label={`Select ${issue.key}`} />
        {show("priority") && <PriorityIcon priority={issue.priority} />}
        {show("key") && <span className="w-16 shrink-0 font-mono text-xs text-zinc-500">{issue.key}</span>}
        <span className={`size-1.5 shrink-0 rounded-full ${isUnread(issue, snapshot.viewer.memberId, snapshot.issueReads[issue.id]) ? "bg-sky-400" : ""}`} />
        <button className="min-w-0 flex-1 truncate text-left text-zinc-100" onClick={() => onOpen(issue.key)}>
          {issue.title}
        </button>
        {show("estimate") && issue.estimate !== null && <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{issue.estimate} pt</span>}
        {show("agent") && awaiting(issue) && <span className="shrink-0 rounded bg-amber-950 px-1.5 text-[10px] text-amber-300">Awaiting response</span>}
        {stage && (
          <span className="flex w-36 shrink-0 items-center gap-1.5 truncate text-xs text-zinc-400">
            <Dot color={stage.color} className="size-2" />
            {stage.name}
          </span>
        )}
        <span className="flex w-16 shrink-0 justify-end -space-x-1">
          {show("assignees") &&
            issue.assignees.map((a) => {
              if (a.kind === "user") return <UserAvatar key={a.id} size="size-5" member={snapshot.members.find((m) => m.id === a.id)} />;
              const agent = snapshot.agents.find((x) => x.id === a.id);
              return agent ? <AgentAvatar key={a.id} agent={agent} size="size-5" /> : null;
            })}
        </span>
        <span className="w-16 shrink-0 text-right text-xs text-zinc-500">{timeAgo(issue.updatedAt)}</span>
      </div>
    );
  };
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    setSelected(next);
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {selected.size > 0 && <BulkBar issues={all.filter((i) => selected.has(i.id))} snapshot={snapshot} onDone={() => setSelected(new Set())} />}
      {groups.map((g) => (
        <section key={g.key}>
          <header className="flex items-center gap-2 border-b border-zinc-900 bg-zinc-900/40 px-4 py-1.5 text-xs">
            <input
              type="checkbox"
              checked={g.issues.every((i) => selected.has(i.id))}
              onChange={(e) =>
                toggle(
                  g.issues.map((i) => i.id),
                  e.target.checked,
                )
              }
              aria-label={`Select ${g.label}`}
            />
            <span className="font-medium text-zinc-300">{g.label}</span>
            <span className="text-zinc-500">{g.issues.length}</span>
          </header>
          {g.sub
            ? g.sub.map((sg) => (
                <div key={sg.key}>
                  <p className="border-b border-zinc-900/60 bg-zinc-950 px-8 py-1 text-[11px] text-zinc-500">
                    {sg.label} <span className="text-zinc-600">{sg.issues.length}</span>
                  </p>
                  <Rows issues={sg.issues} row={row} />
                </div>
              ))
            : <Rows issues={g.issues} row={row} />}
        </section>
      ))}
      {!all.length && <p className="p-8 text-center text-sm text-zinc-500">No issues match this view.</p>}
    </div>
  );
}

/** A group's rows, built in batches as they scroll into view. */
function Rows({ issues, row }: { issues: Issue[]; row: (issue: Issue) => React.ReactNode }) {
  const { visible, more, sentinel } = useGrowingList(issues, 100);
  return (
    <>
      {visible.map(row)}
      {more > 0 && (
        <p ref={sentinel} className="px-4 py-1.5 text-xs text-zinc-500">
          {more} more...
        </p>
      )}
    </>
  );
}
