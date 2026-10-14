import { useEffect, useMemo, useState } from "react";
import type { Issue, Snapshot, Stage, StageCategory } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { AgentAvatar, Button, Chip, Dot, ErrorText, inputClass, PriorityIcon, UserAvatar, useAction } from "../ui";
import { DEFAULT_DISPLAY, DEFAULT_FILTERS, groupIssues, isAwaiting, isUnread, matches, orderIssues, type CardProp, type FilterContext, type IssueDisplay, type IssueFilters } from "../../../../core/issue-views";
import { BoardAssistant } from "./BoardAssistant";
import { CreateWorkspacesDialog } from "./CreateWorkspacesDialog";
import { IssueList } from "./IssueList";
import { ViewBar } from "./ViewBar";
import { CardControls } from "./CardControls";
import { NewIssueDialog } from "./NewIssueDialog";
import { Timeline } from "./Timeline";
import { BoardActivity } from "./BoardActivity";
import { IssueDetail } from "./IssueDetail";
import { PrBadge } from "../git/PrPanel";
import { useGrowingList } from "../useGrowingList";

const CATEGORY_LABEL: Record<StageCategory, string> = { triage: "Triage", in_progress: "In Progress", in_review: "In Review", done: "Done", cancelled: "Cancelled" };

function IssueCard({ issue, snapshot, awaiting, show, onOpen }: { issue: Issue; snapshot: Snapshot; awaiting: boolean; show: (p: CardProp) => boolean; onOpen: () => void }) {
  const unread = isUnread(issue, snapshot.viewer.memberId, snapshot.issueReads[issue.id]);
  const runs = snapshot.runs.filter((r) => r.issueId === issue.id);
  const running = runs.find((r) => r.status === "running" || r.status === "queued");
  const waiting = runs.find((r) => r.status === "waiting");
  const labels = snapshot.labels.filter((l) => issue.labelIds.includes(l.id));
  const prs = snapshot.pullRequests.filter((pr) => pr.issueId === issue.id);
  const linearRef = issue.links.find((l) => l.kind === "linear")?.title;
  // The hover controls hold dozens of menu options; a card builds them the first time it is hovered or focused.
  const [hot, setHot] = useState(false);
  return (
    <div
      onPointerEnter={() => setHot(true)}
      onFocus={() => setHot(true)}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/issue", issue.id)}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className="group w-full cursor-pointer rounded-lg bg-zinc-900 p-2.5 text-left ring-1 ring-zinc-800 transition hover:ring-zinc-600"
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
        {show("priority") && <PriorityIcon priority={issue.priority} />}
        {show("key") && <span className="font-mono">{issue.key}</span>}
        {show("estimate") && issue.estimate !== null && <span className="rounded bg-zinc-800 px-1 text-[10px]">{issue.estimate} pt</span>}
        {unread && <span className="size-1.5 rounded-full bg-sky-400" title="Changed since you last opened it" />}
        <span className="ml-auto flex -space-x-1">
          {show("assignees") &&
            issue.assignees.map((a) => {
              if (a.kind === "user") return <UserAvatar key={a.id} size="size-4" member={snapshot.members.find((m) => m.id === a.id)} />;
              const agent = snapshot.agents.find((x) => x.id === a.id);
              return agent ? <AgentAvatar key={a.id} agent={agent} size="size-4" /> : null;
            })}
        </span>
      </div>
      <p className="text-sm leading-snug text-zinc-100">{issue.title}</p>
      {((show("labels") && labels.length > 0) || (show("type") && issue.type === "bug") || linearRef) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {linearRef && <Chip color="#5e6ad2">{linearRef}</Chip>}
          {show("type") && issue.type === "bug" && <Chip color="#a8382a">bug</Chip>}
          {show("labels") &&
            labels.map((l) => (
              <Chip key={l.id} color={l.color}>
                {l.name}
              </Chip>
            ))}
        </div>
      )}
      {show("agent") && (waiting || awaiting) && <p className="mt-2 text-xs text-amber-300">Awaiting response</p>}
      {show("agent") && !waiting && !awaiting && running && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-violet-300">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          {snapshot.agents.find((a) => a.id === running.agentId)?.name} {running.status === "queued" ? "queued" : "working"}
        </p>
      )}
      {!show("prs") ? null : prs.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {prs.map((pr) => (
            <PrBadge key={pr.id} pr={pr} link={false} />
          ))}
        </div>
      ) : (
        issue.links.some((l) => l.kind === "pr") && <p className="mt-1 text-xs text-zinc-500">PR linked</p>
      )}
      {hot && <CardControls issue={issue} snapshot={snapshot} />}
    </div>
  );
}

function QuickAdd({ stage, onDone }: { stage: Stage; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const action = useAction();
  return (
    <form
      className="space-y-1"
      onSubmit={async (e) => {
        e.preventDefault();
        if (title.trim() && (await action.run(() => api.createIssue({ title, stageId: stage.id })))) {
          setTitle("");
          onDone();
        }
      }}
    >
      <input autoFocus className={inputClass} placeholder="Issue title, then Enter" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => !title && onDone()} />
      <ErrorText>{action.error}</ErrorText>
    </form>
  );
}

/** A column's own actions: rename, hide, add a stage after it, or delete it (its issues move). */
function StageMenu({ stage, snapshot, count }: { stage: Stage; snapshot: Snapshot; count: number }) {
  const [open, setOpen] = useState(false);
  const action = useAction();
  const items: [string, () => void][] = [
    [
      "Rename",
      () => {
        const name = prompt("Rename stage", stage.name);
        if (name?.trim() && name.trim() !== stage.name) void action.run(() => api.updateStage(stage.id, { name: name.trim() }));
      },
    ],
    ["Hide from the board", () => void action.run(() => api.updateStage(stage.id, { hidden: true }))],
    [
      "Add a stage after",
      () => {
        const name = prompt(`New stage after ${stage.name}`);
        if (!name?.trim()) return;
        void action.run(async () => {
          const { id } = (await api.createStage({ name: name.trim(), category: stage.category, color: stage.color })) as { id: string };
          // New stages land at the end; put it right after this one.
          const order = snapshot.stages.map((s) => s.id);
          order.splice(order.indexOf(stage.id) + 1, 0, id);
          await api.reorderStages(order);
        });
      },
    ],
    [
      "Delete",
      () => {
        const target = snapshot.stages.find((s) => s.id !== stage.id && s.category === stage.category) ?? snapshot.stages.find((s) => s.id !== stage.id);
        if (!target) return;
        if (confirm(`Delete "${stage.name}"?${count ? ` Its ${count} issue${count === 1 ? "" : "s"} move to "${target.name}".` : ""}`)) void action.run(() => api.deleteStage(stage.id, target.id));
      },
    ],
  ];
  return (
    <span className="relative">
      <button className="text-zinc-500 hover:text-zinc-200" onClick={() => setOpen(!open)} title="Stage actions" aria-label="Stage actions">
        ...
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute top-6 right-0 z-40 w-48 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700">
            {items.map(([label, run]) => (
              <button key={label} className={`block w-full px-3 py-1.5 text-left hover:bg-zinc-800 ${label === "Delete" ? "text-red-400" : "text-zinc-200"}`} onClick={() => (setOpen(false), run())}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <ErrorText>{action.error}</ErrorText>
    </span>
  );
}

function Column({ stage, issues, snapshot, awaiting, show, onOpen, manual }: { stage: Stage; issues: Issue[]; snapshot: Snapshot; awaiting: (issue: Issue) => boolean; show: (p: CardProp) => boolean; onOpen: (key: string) => void; manual: boolean }) {
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(false);
  const move = useAction();
  const { visible, more, sentinel } = useGrowingList(issues);
  return (
    <section
      className={`flex w-72 shrink-0 flex-col rounded-xl p-2 transition-colors ${over ? "bg-zinc-800/60" : "bg-zinc-900/40"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData("text/issue");
        if (!id) return;
        // Under manual ordering an empty spot means the bottom of the column.
        const last = issues.filter((i) => i.id !== id).at(-1);
        void move.run(() => (manual ? api.reorderIssue(id, { above: last?.id ?? null, stageId: stage.id }) : api.moveIssue(id, stage.id)));
      }}
    >
      <header className="mb-2 flex items-center gap-2 px-1">
        <Dot color={stage.color} />
        <h2 className="truncate text-sm font-medium">{stage.name}</h2>
        <span className="text-xs text-zinc-500">{issues.length}</span>
        {stage.humanGate && (
          <span title="Sign-off stage: agents cannot move cards out of this stage" className="rounded bg-zinc-800 px-1 text-[10px] tracking-wide text-zinc-400 uppercase">
            gate
          </span>
        )}
        <button className="ml-auto text-lg leading-none text-zinc-500 hover:text-zinc-200" onClick={() => setAdding(true)} title="Add issue">
          +
        </button>
        {snapshot.viewer.role !== "member" && <StageMenu stage={stage} snapshot={snapshot} count={issues.length} />}
      </header>
      <ErrorText>{move.error}</ErrorText>
      <div className="min-h-16 flex-1 space-y-2 overflow-y-auto">
        {adding && <QuickAdd stage={stage} onDone={() => setAdding(false)} />}
        {visible.map((issue, n) => (
          <div
            key={issue.id}
            onDrop={(e) => {
              if (!manual) return;
              const id = e.dataTransfer.getData("text/issue");
              if (!id || id === issue.id) return;
              // Dropped on a card: it goes just above that card.
              e.stopPropagation();
              setOver(false);
              const above = issues.slice(0, n).filter((i) => i.id !== id).at(-1);
              void move.run(() => api.reorderIssue(id, { above: above?.id ?? null, below: issue.id, stageId: stage.id }));
            }}
          >
            <IssueCard issue={issue} snapshot={snapshot} awaiting={awaiting(issue)} show={show} onOpen={() => onOpen(issue.key)} />
          </div>
        ))}
        {more > 0 && (
          <p ref={sentinel} className="py-2 text-center text-xs text-zinc-500">
            {more} more...
          </p>
        )}
      </div>
    </section>
  );
}

const VIEW_KEY = "cadence.board";

function storedBoard(): { filters: IssueFilters; display: IssueDisplay; viewId: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as { filters: IssueFilters; display: IssueDisplay; viewId: string | null } | null;
    if (v) return { filters: { ...DEFAULT_FILTERS, ...v.filters }, display: { ...DEFAULT_DISPLAY, ...v.display }, viewId: v.viewId };
  } catch {
    // storage unavailable or old data
  }
  return { filters: DEFAULT_FILTERS, display: DEFAULT_DISPLAY, viewId: null };
}

export function IssuesView({ snapshot, selected }: { snapshot: Snapshot; selected: string | null }) {
  const [board, setBoard] = useState(storedBoard);
  const [assistant, setAssistant] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [creating, setCreating] = useState(false);
  const [activity, setActivity] = useState(false);
  useEffect(() => {
    // "C" files a new issue, unless you are typing somewhere.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "c" || e.ctrlKey || e.metaKey || e.altKey || t?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const { filters, display } = board;
  const view = snapshot.issueViews.find((v) => v.id === board.viewId) ?? null;
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(board));
    } catch {
      // storage unavailable
    }
  }, [board]);

  const ctx = useMemo<FilterContext>(() => {
    const chatsByWorkspace = new Map<string, string[]>();
    for (const ch of snapshot.chats) if (ch.workspaceId) chatsByWorkspace.set(ch.workspaceId, [...(chatsByWorkspace.get(ch.workspaceId) ?? []), ch.id]);
    return {
      viewerId: snapshot.viewer.memberId,
      runs: snapshot.runs,
      pending: snapshot.pendingInteractions,
      issueChats: (issue) => [...snapshot.workspaces.filter((w) => w.issueId === issue.id).flatMap((w) => chatsByWorkspace.get(w.id) ?? []), ...snapshot.runs.filter((r) => r.issueId === issue.id && r.chatId).map((r) => r.chatId!)],
    };
  }, [snapshot]);
  const issues = useMemo(
    () =>
      orderIssues(
        snapshot.issues.filter((i) => matches(i, filters, ctx)),
        display.orderBy,
      ),
    [snapshot.issues, filters, display.orderBy, ctx],
  );
  const awaiting = (issue: Issue) => isAwaiting(issue, ctx);
  const show = (p: CardProp) => !display.properties || display.properties.includes(p);

  const stages = snapshot.stages.filter((s) => display.showHidden || !s.hidden);
  const categories = [...new Set(stages.map((s) => s.category))];
  const open = (key: string) => navigate("issues", key);
  const names = {
    stages,
    member: (id: string) => snapshot.members.find((m) => m.id === id)?.name,
    agent: (id: string) => snapshot.agents.find((a) => a.id === id)?.name,
    project: (id: string) => snapshot.projects.find((p) => p.id === id)?.name,
  };
  const groups = useMemo(
    () =>
      groupIssues(issues, display.groupBy, names)
        .filter((g) => display.groupBy !== "stage" || stages.some((s) => s.id === g.key))
        .map((g) => ({ ...g, sub: display.subGroupBy && display.subGroupBy !== "none" && display.subGroupBy !== display.groupBy ? groupIssues(g.issues, display.subGroupBy, names) : null })),
    [issues, display.groupBy, display.subGroupBy, display.showHidden, snapshot],
  );

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-900 px-4 py-3">
          <h1 className="mr-2 font-semibold">Issues</h1>
          <div className="min-w-0 flex-1">
            <ViewBar
              snapshot={snapshot}
              filters={filters}
              display={display}
              view={view}
              onChange={(f, d) => setBoard({ ...board, filters: f, display: d })}
              onView={(v) => setBoard(v ? { filters: v.filters, display: v.display, viewId: v.id } : { ...board, viewId: null })}
            />
          </div>
          <Button variant="primary" onClick={() => setCreating(true)} title="New issue (C)">
            New issue
          </Button>
          <Button onClick={() => setBulk(true)} title="One workspace per issue in this view">
            Create workspaces
          </Button>
          <Button variant={activity ? "secondary" : "ghost"} onClick={() => (setActivity(!activity), setAssistant(false))} title="What happened on the board lately">
            Activity
          </Button>
          {snapshot.viewer.role !== "member" && (
            <Button variant={assistant ? "secondary" : "ghost"} onClick={() => (setAssistant(!assistant), setActivity(false))} title="A chat with the board tools">
              Ask AI
            </Button>
          )}
        </header>
        {display.layout === "timeline" ? (
          <Timeline issues={issues} snapshot={snapshot} onOpen={open} />
        ) : display.layout === "list" ? (
          <IssueList groups={groups} snapshot={snapshot} awaiting={awaiting} show={show} onOpen={open} />
        ) : (
          <div className="flex min-h-0 flex-1 gap-6 overflow-x-auto p-4">
            {categories.map((cat) => (
              <div key={cat} className="flex min-h-0 flex-col">
                <p className="mb-2 px-1 text-xs font-medium tracking-wide text-zinc-500 uppercase">{CATEGORY_LABEL[cat]}</p>
                <div className="flex min-h-0 flex-1 gap-2">
                  {stages
                    .filter((s) => s.category === cat)
                    .map((stage) => (
                      <Column key={stage.id} stage={stage} issues={issues.filter((i) => i.stageId === stage.id)} snapshot={snapshot} awaiting={awaiting} show={show} onOpen={open} manual={display.orderBy === "manual"} />
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && <IssueDetail key={selected} issueKey={selected} snapshot={snapshot} onClose={() => navigate("issues")} />}
      {creating && <NewIssueDialog snapshot={snapshot} onClose={() => setCreating(false)} />}
      {bulk && <CreateWorkspacesDialog issues={issues} snapshot={snapshot} onClose={() => setBulk(false)} />}
      {activity && !selected && <BoardActivity snapshot={snapshot} onClose={() => setActivity(false)} />}
      {assistant && !selected && <BoardAssistant snapshot={snapshot} onClose={() => setAssistant(false)} />}
    </div>
  );
}
