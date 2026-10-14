import { useState } from "react";
import type { Assignee, IssueType, Priority, Snapshot } from "../../../../core/types";
import { ISSUE_TYPES, PRIORITIES } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { Button, ErrorText, inputClass, useAction } from "../ui";

const SELECT = "rounded-md bg-zinc-950 px-2 py-1 text-xs text-zinc-200 ring-1 ring-zinc-800";
const LABEL_COLORS = ["#a8382a", "#b8862e", "#6a8a4a", "#4e8a84", "#4b7a8c", "#7a4a6e", "#b5606f", "#8a7b6c"];

/** A full new-issue form: every property up front, and "create more" for filing several in a row. */
export function NewIssueDialog({ snapshot, stageId, onClose }: { snapshot: Snapshot; stageId?: string; onClose: () => void }) {
  const first = { title: "", body: "", type: "feature" as IssueType, priority: "none" as Priority, stageId: stageId ?? snapshot.stages[0]?.id ?? "", projectId: snapshot.projects.length === 1 ? snapshot.projects[0]!.id : "", labelIds: [] as string[], assignees: [] as Assignee[] };
  const [draft, setDraft] = useState(first);
  const [more, setMore] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const action = useAction();
  const dirty = Boolean(draft.title.trim() || draft.body.trim());
  const close = () => (!dirty || confirm("Discard this issue?")) && onClose();

  const create = (open: boolean) =>
    action.run(async () => {
      const issue = await api.createIssue({ ...draft, title: draft.title.trim(), projectId: draft.projectId || null });
      if (open) {
        onClose();
        navigate("issues", issue.key);
      } else if (more) setDraft({ ...first, stageId: draft.stageId, projectId: draft.projectId, type: draft.type });
      else onClose();
    });
  const toggleAssignee = (a: Assignee) => setDraft({ ...draft, assignees: draft.assignees.some((x) => x.id === a.id) ? draft.assignees.filter((x) => x.id !== a.id) : [...draft.assignees, a] });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={close}>
      <form
        className="w-[36rem] space-y-3 rounded-xl bg-zinc-900 p-5 shadow-2xl ring-1 ring-zinc-700"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.title.trim()) void create(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && draft.title.trim()) void create(false);
        }}
      >
        <input autoFocus className="w-full bg-transparent text-lg font-medium outline-none placeholder:text-zinc-600" placeholder="Issue title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <textarea className={`${inputClass} min-h-28 text-sm`} placeholder="Description (markdown)" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        <div className="flex flex-wrap gap-2">
          <select className={SELECT} value={draft.stageId} onChange={(e) => setDraft({ ...draft, stageId: e.target.value })} title="Stage">
            {snapshot.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select className={SELECT} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as IssueType })} title="Type">
            {ISSUE_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select className={SELECT} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })} title="Priority">
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p === "none" ? "No priority" : p}
              </option>
            ))}
          </select>
          {snapshot.projects.length > 0 && (
            <select className={SELECT} value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })} title="Project">
              <option value="">No project</option>
              {snapshot.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {snapshot.labels.map((l) => {
            const on = draft.labelIds.includes(l.id);
            return (
              <button type="button" key={l.id} onClick={() => setDraft({ ...draft, labelIds: on ? draft.labelIds.filter((x) => x !== l.id) : [...draft.labelIds, l.id] })} className={`flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ${on ? "bg-zinc-800 text-zinc-100 ring-zinc-500" : "text-zinc-400 ring-zinc-800"}`}>
                <span className="size-1.5 rounded-full" style={{ background: l.color }} />
                {l.name}
              </button>
            );
          })}
          <input
            className="w-28 rounded-full bg-transparent px-2 py-0.5 ring-1 ring-zinc-800 outline-none placeholder:text-zinc-600 focus:ring-zinc-600"
            placeholder="+ new label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !newLabel.trim()) return;
              e.preventDefault();
              const name = newLabel.trim();
              void action.run(async () => {
                const { id } = (await api.createLabel({ name, color: LABEL_COLORS[snapshot.labels.length % LABEL_COLORS.length]! })) as { id: string };
                setDraft((d) => ({ ...d, labelIds: [...d.labelIds, id] }));
                setNewLabel("");
              });
            }}
          />
        </div>
        <div className="flex flex-wrap gap-1 text-xs">
          {[...snapshot.members.map((m) => ({ a: { kind: "user" as const, id: m.id }, name: m.name })), ...snapshot.agents.map((g) => ({ a: { kind: "agent" as const, id: g.id }, name: `${g.name} (agent)` }))].map(({ a, name }) => (
            <button type="button" key={a.id} onClick={() => toggleAssignee(a)} className={`rounded-md px-2 py-0.5 ring-1 ${draft.assignees.some((x) => x.id === a.id) ? "bg-violet-500/20 text-violet-200 ring-violet-500" : "text-zinc-400 ring-zinc-800"}`}>
              {name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <label className="mr-auto flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={more} onChange={(e) => setMore(e.target.checked)} /> Create more
          </label>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!draft.title.trim() || action.busy} onClick={() => void create(true)}>
            Create and open
          </Button>
          <Button type="submit" variant="primary" disabled={!draft.title.trim() || action.busy}>
            Create
          </Button>
        </div>
        <ErrorText>{action.error}</ErrorText>
      </form>
    </div>
  );
}
