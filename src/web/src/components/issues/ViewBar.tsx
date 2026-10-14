import { useState, type ReactNode } from "react";
import type { Snapshot } from "../../../../core/types";
import { ISSUE_TYPES, PRIORITIES } from "../../../../core/types";
import { CARD_PROPS, DEFAULT_DISPLAY, DEFAULT_FILTERS, type IssueDisplay, type IssueFilters, type IssueView, type ViewScope } from "../../../../core/issue-views";
import { api } from "../../api";
import { Button, ErrorText, inputClass, useAction } from "../ui";

const SCOPES: [ViewScope, string][] = [
  ["all", "All"],
  ["mine", "Mine"],
  ["agents", "With agents"],
  ["active", "Agent running"],
  ["awaiting", "Needs your reply"],
];

function Popover({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant={count ? "secondary" : "ghost"} onClick={() => setOpen(!open)}>
        {label}
        {count ? <span className="ml-1 rounded bg-violet-500/30 px-1 text-[10px]">{count}</span> : null}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-9 right-0 z-30 max-h-[70vh] w-72 space-y-3 overflow-y-auto rounded-lg bg-zinc-900 p-3 shadow-2xl ring-1 ring-zinc-700">{children}</div>
        </>
      )}
    </div>
  );
}

function Toggles<T extends string>({ title, options, selected, onChange }: { title: string; options: { id: T; label: string; color?: string }[]; selected: T[]; onChange: (next: T[]) => void }) {
  if (!options.length) return null;
  return (
    <section>
      <p className="mb-1 text-[11px] tracking-wide text-zinc-500 uppercase">{title}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const on = selected.includes(o.id);
          return (
            <button key={o.id} onClick={() => onChange(on ? selected.filter((x) => x !== o.id) : [...selected, o.id])} className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ${on ? "bg-violet-500/20 text-violet-200 ring-violet-500" : "text-zinc-400 ring-zinc-700 hover:text-zinc-200"}`}>
              {o.color && <span className="size-1.5 rounded-full" style={{ background: o.color }} />}
              {o.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

const SELECT = "rounded-md bg-zinc-950 px-2 py-1 text-xs text-zinc-200 ring-1 ring-zinc-800";

/** Scope tabs, search, filters, display options, and saved views for the board. */
export function ViewBar({
  snapshot,
  filters,
  display,
  view,
  onChange,
  onView,
}: {
  snapshot: Snapshot;
  filters: IssueFilters;
  display: IssueDisplay;
  view: IssueView | null;
  onChange: (filters: IssueFilters, display: IssueDisplay) => void;
  onView: (view: IssueView | null) => void;
}) {
  const [saving, setSaving] = useState<{ name: string; shared: boolean } | null>(null);
  const action = useAction();
  const setF = (patch: Partial<IssueFilters>) => onChange({ ...filters, ...patch }, display);
  const setD = (patch: Partial<IssueDisplay>) => onChange(filters, { ...display, ...patch });
  const filterCount = filters.priorities.length + filters.types.length + filters.labelIds.length + filters.assigneeIds.length + filters.projectIds.length;
  const dirty = view && JSON.stringify([view.filters, view.display]) !== JSON.stringify([filters, display]);
  const mine = view && (view.ownerId === snapshot.viewer.memberId || snapshot.viewer.role !== "member");
  const body = (name: string, shared: boolean) => ({ name, shared, filters, display });
  const favorites = snapshot.members.find((m) => m.id === snapshot.viewer.memberId)?.favoriteViews ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={SELECT} value={view?.id ?? ""} onChange={(e) => onView(snapshot.issueViews.find((v) => v.id === e.target.value) ?? null)} title="Saved views">
        <option value="">Board</option>
        {[...snapshot.issueViews].sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id))).map((v) => (
          <option key={v.id} value={v.id}>
            {favorites.includes(v.id) ? "* " : ""}
            {v.name}
            {v.shared ? " (shared)" : ""}
          </option>
        ))}
      </select>
      {view && (
        <button className={`text-sm ${favorites.includes(view.id) ? "text-amber-300" : "text-zinc-600 hover:text-zinc-300"}`} title={favorites.includes(view.id) ? "Unstar this view" : "Star this view: starred views list first"} onClick={() => void action.run(() => api.favoriteIssueView(view.id, !favorites.includes(view.id)))}>
          {favorites.includes(view.id) ? "\u2605" : "\u2606"}
        </button>
      )}
      {SCOPES.map(([s, label]) => (
        <Button key={s} variant={filters.scope === s ? "secondary" : "ghost"} onClick={() => setF({ scope: s })}>
          {label}
        </Button>
      ))}
      <input className={`${inputClass} ml-auto w-48`} placeholder="Search issues" value={filters.query} onChange={(e) => setF({ query: e.target.value })} />
      <Popover label="Filter" count={filterCount}>
        <Toggles title="Priority" options={PRIORITIES.map((p) => ({ id: p, label: p === "none" ? "No priority" : p }))} selected={filters.priorities} onChange={(priorities) => setF({ priorities })} />
        <Toggles title="Type" options={ISSUE_TYPES.map((t) => ({ id: t, label: t }))} selected={filters.types} onChange={(types) => setF({ types })} />
        <Toggles title="Labels" options={snapshot.labels.map((l) => ({ id: l.id, label: l.name, color: l.color }))} selected={filters.labelIds} onChange={(labelIds) => setF({ labelIds })} />
        <Toggles title="Assignee" options={[{ id: "none", label: "Unassigned" }, ...snapshot.members.map((m) => ({ id: m.id, label: m.name })), ...snapshot.agents.map((a) => ({ id: a.id, label: a.name, color: a.color }))]} selected={filters.assigneeIds} onChange={(assigneeIds) => setF({ assigneeIds })} />
        <Toggles title="Project" options={[{ id: "none", label: "No project" }, ...snapshot.projects.map((p) => ({ id: p.id, label: p.name }))]} selected={filters.projectIds} onChange={(projectIds) => setF({ projectIds })} />
        {filterCount > 0 && (
          <Button variant="ghost" onClick={() => setF({ ...DEFAULT_FILTERS, scope: filters.scope, query: filters.query })}>
            Clear filters
          </Button>
        )}
      </Popover>
      <Popover label="Display">
        <label className="flex items-center justify-between text-xs text-zinc-300">
          Layout
          <select className={SELECT} value={display.layout} onChange={(e) => setD({ layout: e.target.value as IssueDisplay["layout"] })}>
            <option value="board">Board</option>
            <option value="list">List</option>
            <option value="timeline">Timeline</option>
          </select>
        </label>
        {display.layout === "list" && (
          <label className="flex items-center justify-between text-xs text-zinc-300">
            Group by
            <select className={SELECT} value={display.groupBy} onChange={(e) => setD({ groupBy: e.target.value as IssueDisplay["groupBy"] })}>
              {(["stage", "priority", "assignee", "project", "type", "none"] as const).map((g) => (
                <option key={g} value={g}>
                  {g === "none" ? "No grouping" : g[0]!.toUpperCase() + g.slice(1)}
                </option>
              ))}
            </select>
          </label>
        )}
        {display.layout === "list" && display.groupBy !== "none" && (
          <label className="flex items-center justify-between text-xs text-zinc-300">
            Then by
            <select className={SELECT} value={display.subGroupBy ?? "none"} onChange={(e) => setD({ subGroupBy: e.target.value as IssueDisplay["groupBy"] })}>
              {(["none", "stage", "priority", "assignee", "project", "type"] as const)
                .filter((g) => g === "none" || g !== display.groupBy)
                .map((g) => (
                  <option key={g} value={g}>
                    {g === "none" ? "No sub-grouping" : g[0]!.toUpperCase() + g.slice(1)}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="flex items-center justify-between text-xs text-zinc-300">
          Order by
          <select className={SELECT} value={display.orderBy} onChange={(e) => setD({ orderBy: e.target.value as IssueDisplay["orderBy"] })}>
            <option value="manual">Manual</option>
            <option value="priority">Priority</option>
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="title">Title</option>
          </select>
        </label>
        <Toggles
          title="Show on cards"
          options={CARD_PROPS.map((p) => ({ id: p, label: { key: "ID", priority: "Priority", type: "Type", labels: "Labels", assignees: "Assignees", estimate: "Estimate", prs: "Pull requests", agent: "Agent status" }[p] }))}
          selected={display.properties ?? [...CARD_PROPS]}
          onChange={(properties) => setD({ properties })}
        />
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input type="checkbox" checked={display.showHidden} onChange={(e) => setD({ showHidden: e.target.checked })} /> Show hidden stages
        </label>
        <Button variant="ghost" onClick={() => onChange(filters, DEFAULT_DISPLAY)}>
          Reset display
        </Button>
      </Popover>
      {view && dirty && mine && (
        <Button disabled={action.busy} onClick={() => void action.run(async () => onView(await api.updateIssueView(view.id, body(view.name, view.shared))))}>
          Save view
        </Button>
      )}
      <Button variant="ghost" onClick={() => setSaving({ name: "", shared: false })}>
        Save as...
      </Button>
      {view && mine && (
        <Button variant="ghost" disabled={action.busy} onClick={() => confirm(`Delete the view "${view.name}"?`) && void action.run(async () => (await api.deleteIssueView(view.id), onView(null)))}>
          Delete view
        </Button>
      )}
      {saving && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => setSaving(null)}>
          <form
            className="w-80 space-y-3 rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-700"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                onView(await api.saveIssueView(body(saving.name.trim(), saving.shared)));
                setSaving(null);
              });
            }}
          >
            <p className="font-display text-lg">Save view</p>
            <input autoFocus className={inputClass} placeholder="Bugs this week" value={saving.name} onChange={(e) => setSaving({ ...saving, name: e.target.value })} />
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={saving.shared} onChange={(e) => setSaving({ ...saving, shared: e.target.checked })} /> Share with the organization
            </label>
            <Button type="submit" variant="primary" disabled={!saving.name.trim() || action.busy}>
              Save
            </Button>
          </form>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}
