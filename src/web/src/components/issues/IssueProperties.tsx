import { useState } from "react";
import type { Issue, Snapshot } from "../../../../core/types";
import { ISSUE_TYPES, PRIORITIES } from "../../../../core/types";
import { api } from "../../api";
import { AgentAvatar, Dot, ErrorText, priorityLabel, UserAvatar, useAction } from "../ui";

const select = "w-full rounded-md bg-zinc-900 px-2 py-1 text-sm ring-1 ring-zinc-800 focus:outline-none focus:ring-violet-500";

const NEW_LABEL_COLORS = ["#a8382a", "#b8862e", "#6a8a4a", "#4e8a84", "#4b7a8c", "#7a4a6e", "#b5606f", "#8a7b6c"];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-start gap-2 text-sm">
      <span className="pt-1 text-xs text-zinc-500">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The editable property grid in the issue panel. */
export function IssueProperties({ issue, snapshot }: { issue: Issue; snapshot: Snapshot }) {
  const action = useAction();
  const [picking, setPicking] = useState(false);
  const patch = (p: Record<string, unknown>) => action.run(() => api.updateIssue(issue.id, p));
  const assigned = (kind: "user" | "agent", id: string) => issue.assignees.some((a) => a.kind === kind && a.id === id);
  const toggle = (kind: "user" | "agent", id: string) => action.run(() => api.toggleAssignee(issue.id, { kind, id }, !assigned(kind, id)));

  return (
    <div className="space-y-2.5">
      <Row label="Stage">
        <select className={select} value={issue.stageId} onChange={(e) => action.run(() => api.moveIssue(issue.id, e.target.value))}>
          {snapshot.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.humanGate ? " (gate)" : ""}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Assignees">
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.assignees.map((a) => {
            const agent = a.kind === "agent" ? snapshot.agents.find((x) => x.id === a.id) : null;
            const member = a.kind === "user" ? snapshot.members.find((m) => m.id === a.id) : null;
            return (
              <button key={`${a.kind}:${a.id}`} onClick={() => toggle(a.kind, a.id)} title="Click to unassign" className="flex items-center gap-1 rounded-full bg-zinc-800 py-0.5 pr-2 pl-0.5 text-xs hover:bg-zinc-700">
                {agent ? <AgentAvatar agent={agent} size="size-4" /> : <UserAvatar size="size-4" member={member} />}
                {agent ? agent.name : a.id === snapshot.viewer.memberId ? "Me" : (member?.name ?? "Former member")}
                {agent && !agent.enabled && <span className="text-zinc-500">(off)</span>}
              </button>
            );
          })}
          <button onClick={() => setPicking((p) => !p)} className="rounded-full px-2 py-0.5 text-xs text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-100">
            + Assign
          </button>
        </div>
        {picking && (
          <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto rounded-lg bg-zinc-900 p-1 ring-1 ring-zinc-800">
            {[...snapshot.members].sort((a, b) => Number(b.id === snapshot.viewer.memberId) - Number(a.id === snapshot.viewer.memberId)).map((m) => (
              <button key={m.id} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-zinc-800" onClick={() => toggle("user", m.id)}>
                <UserAvatar size="size-4" member={m} /> {m.id === snapshot.viewer.memberId ? `${m.name} (you)` : m.name}
                {assigned("user", m.id) && <span className="ml-auto text-xs text-zinc-500">assigned</span>}
              </button>
            ))}
            {snapshot.agents.map((a) => (
              <button key={a.id} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-zinc-800" onClick={() => toggle("agent", a.id)}>
                <AgentAvatar agent={a} size="size-4" />
                <span className="truncate">{a.name}</span>
                <span className="ml-auto text-xs text-zinc-500">{assigned("agent", a.id) ? "assigned" : a.enabled ? "" : "disabled"}</span>
              </button>
            ))}
            {snapshot.agents.length === 0 && <p className="px-2 py-1 text-xs text-zinc-500">No agents yet. Create one in Agents.</p>}
          </div>
        )}
      </Row>
      <Row label="Type">
        <select className={select} value={issue.type} onChange={(e) => patch({ type: e.target.value })}>
          {ISSUE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Row>
      <Row label="Priority">
        <select className={select} value={issue.priority} onChange={(e) => patch({ priority: e.target.value })}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityLabel(p)}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Estimate">
        <input
          className={select}
          type="number"
          min={0}
          max={100}
          defaultValue={issue.estimate ?? ""}
          placeholder="Points"
          onBlur={(e) => patch({ estimate: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </Row>
      <Row label="Dates">
        <div className="flex items-center gap-1">
          <input className={select} type="date" value={issue.startDate ?? ""} max={issue.dueDate ?? undefined} onChange={(e) => patch({ startDate: e.target.value || null })} title="Start" />
          <span className="text-zinc-600">to</span>
          <input className={select} type="date" value={issue.dueDate ?? ""} min={issue.startDate ?? undefined} onChange={(e) => patch({ dueDate: e.target.value || null })} title="Due" />
        </div>
      </Row>
      <Row label="Project">
        <select className={select} value={issue.projectId ?? ""} onChange={(e) => patch({ projectId: e.target.value || null })}>
          <option value="">None</option>
          {snapshot.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Labels">
        <div className="flex flex-wrap gap-1">
          {snapshot.labels.map((l) => {
            const on = issue.labelIds.includes(l.id);
            return (
              <button
                key={l.id}
                onClick={() => action.run(() => api.toggleLabel(issue.id, l.id, !on))}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${on ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 ring-1 ring-zinc-800 hover:text-zinc-300"}`}
              >
                <Dot color={l.color} className="size-1.5" />
                {l.name}
              </button>
            );
          })}
          {/* A label that does not exist yet: type it and press Enter. */}
          <input
            className="w-24 rounded-full bg-transparent px-2 py-0.5 text-xs ring-1 ring-zinc-800 outline-none placeholder:text-zinc-600 focus:ring-zinc-600"
            placeholder="+ new label"
            onKeyDown={(e) => {
              const input = e.currentTarget;
              const name = input.value.trim();
              if (e.key !== "Enter" || !name) return;
              void action.run(async () => {
                const existing = snapshot.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
                const id = existing?.id ?? ((await api.createLabel({ name, color: NEW_LABEL_COLORS[snapshot.labels.length % NEW_LABEL_COLORS.length]! })) as { id: string }).id;
                if (!issue.labelIds.includes(id)) await api.toggleLabel(issue.id, id, true);
                input.value = "";
              });
            }}
          />
        </div>
      </Row>
      {issue.branch && (
        <Row label="Branch">
          <code className="block truncate pt-1 text-xs text-zinc-400">{issue.branch}</code>
        </Row>
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}
