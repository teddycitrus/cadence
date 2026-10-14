import { useEffect, useMemo, useState } from "react";
import { WorkspaceCanvases } from "./WorkspaceCanvases";
import { RIGHT_PANEL_EVENT } from "../../shell";
import { BROWSE_EVENT, type BrowseDetail } from "../../links";
import type { Chat, Snapshot, Workspace } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { AgentAvatar, Button, ErrorText, inputClass, useAction } from "../ui";
import { WorkspacePanel } from "./WorkspacePanel";
import { OPEN_FILE_EVENT, RUN_EVENT, RunButton, type OpenFileDetail, type RunDetail } from "./RunButton";
import { ChatView } from "./ChatView";
import { useGrowingList } from "../useGrowingList";
import { OpenInMenu } from "./OpenInMenu";

function chatIndicator(chats: Chat[]): "running" | "waiting" | "unread" | null {
  if (chats.some((c) => c.status === "waiting")) return "waiting";
  if (chats.some((c) => c.status === "running")) return "running";
  if (chats.some((c) => c.unread)) return "unread";
  return null;
}

const INDICATOR: Record<string, string> = { running: "animate-pulse bg-violet-400", waiting: "bg-amber-400", unread: "bg-sky-400" };

function NewWorkspace({ snapshot, projectId, onDone }: { snapshot: Snapshot; projectId: string | null; onDone: () => void }) {
  const [name, setName] = useState("");
  const action = useAction();
  return (
    <form
      className="space-y-1 px-2 py-1"
      onSubmit={async (e) => {
        e.preventDefault();
        await action.run(async () => {
          const res = await api.createWorkspace({ projectId, name: name.trim() || "New workspace" });
          onDone();
          navigate("chats", res.chatId);
        });
      }}
    >
      <input autoFocus className={inputClass} placeholder={snapshot.projects.length ? "Workspace name" : "Name (scratch folder, no project)"} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => !name && onDone()} />
      <ErrorText>{action.error}</ErrorText>
    </form>
  );
}

/** Moves a person's chat to another workspace (agent and doc chats stay put). */
function MoveChat({ chat, snapshot, onMove }: { chat: Chat | undefined; snapshot: Snapshot; onMove: (workspaceId: string) => void }) {
  if (!chat || chat.agentId || chat.docId || chat.archived) return null;
  const targets = snapshot.workspaces.filter((w) => w.id !== chat.workspaceId && !w.archived);
  if (!targets.length) return null;
  return (
    <select
      className="bg-transparent text-xs text-zinc-500 hover:text-zinc-100"
      value=""
      disabled={chat.status === "running" || chat.status === "waiting"}
      title="Move this chat and its history to another workspace"
      onChange={(e) => e.target.value && onMove(e.target.value)}
    >
      <option value="">Move to...</option>
      {targets.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}

type SidebarOrder = "recent" | "unread" | "name" | "created";

/** Lookups the sidebar needs for every row, built once per snapshot instead of searched per row. */
interface SidebarIndex {
  chats: Map<string, Chat[]>;
  issues: Map<string, Snapshot["issues"][number]>;
  agents: Map<string, Snapshot["agents"][number]>;
}

function sidebarIndex(snapshot: Snapshot): SidebarIndex {
  const chats = new Map<string, Chat[]>();
  for (const c of snapshot.chats) {
    if (c.archived) continue;
    const list = chats.get(c.workspaceId);
    if (list) list.push(c);
    else chats.set(c.workspaceId, [c]);
  }
  return { chats, issues: new Map(snapshot.issues.map((i) => [i.id, i])), agents: new Map(snapshot.agents.map((a) => [a.id, a])) };
}

function WorkspaceRow({ ws, index, active }: { ws: Workspace; index: SidebarIndex; active: boolean }) {
  const chats = index.chats.get(ws.id) ?? [];
  const indicator = chatIndicator(chats);
  const issue = ws.issueId ? index.issues.get(ws.issueId) : null;
  const agent = ws.agentId ? index.agents.get(ws.agentId) : null;
  const first = chats[0];
  return (
    <a href={first ? `#/chats/${first.id}` : `#/chats/${ws.id}`} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${active ? "bg-zinc-800" : "hover:bg-zinc-900"} ${ws.archived ? "opacity-50" : ""}`}>
      {agent ? <AgentAvatar agent={agent} size="size-4" /> : <span className="grid size-4 place-items-center text-[10px] text-zinc-500">{ws.pinned ? "★" : "#"}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{issue ? issue.title : ws.name}</span>
        <span className="block truncate font-mono text-[10px] text-zinc-500">{issue ? issue.key : (ws.branch ?? "scratch")}</span>
      </span>
      {indicator && <span title={indicator} className={`size-2 shrink-0 rounded-full ${INDICATOR[indicator]}`} />}
    </a>
  );
}

/** A group's rows, built in batches as the sidebar scrolls (an install can collect thousands of workspaces). */
function Batched<T>({ items, children }: { items: T[]; children: (item: T) => React.ReactNode }) {
  const { visible, more, sentinel } = useGrowingList(items, 80);
  return (
    <>
      {visible.map(children)}
      {more > 0 && (
        <p ref={sentinel} className="px-2 py-1 text-xs text-zinc-600">
          {more} more...
        </p>
      )}
    </>
  );
}

function WorkspaceHeader({ ws, snapshot, onToggleChanges, showChanges }: { ws: Workspace; snapshot: Snapshot; onToggleChanges: () => void; showChanges: boolean }) {
  const action = useAction();
  const issue = ws.issueId ? snapshot.issues.find((i) => i.id === ws.issueId) : null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-zinc-800 px-4 py-2 text-sm [scrollbar-width:none]">
      <input
        className="min-w-24 flex-1 truncate bg-transparent font-medium focus:outline-none"
        title={ws.name}
        defaultValue={ws.name}
        key={ws.name}
        onBlur={(e) => e.target.value.trim() && e.target.value !== ws.name && action.run(() => api.updateWorkspace(ws.id, { name: e.target.value }))}
      />
      {issue && (
        <a href={`#/issues/${issue.key}`} className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs text-violet-300 hover:underline">
          {issue.key}
        </a>
      )}
      {ws.branch && (
        <button className="max-w-56 truncate rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs text-zinc-400 hover:text-zinc-100" title={`Copy branch name: ${ws.branch}`} onClick={() => navigator.clipboard.writeText(ws.branch!)}>
          {ws.branch}
        </button>
      )}
      <Button variant="ghost" onClick={() => action.run(() => api.updateWorkspace(ws.id, { pinned: !ws.pinned }))}>
        {ws.pinned ? "Unpin" : "Pin"}
      </Button>
      <RunButton ws={ws} snapshot={snapshot} />
      {snapshot.viewer.role !== "member" && <OpenInMenu workspaceId={ws.id} />}
      <WorkspaceCanvases ws={ws} />
      <Button variant={showChanges ? "secondary" : "ghost"} onClick={onToggleChanges}>
        Side panel
      </Button>
      {ws.archived ? (
        <Button onClick={() => action.run(() => api.restoreWorkspace(ws.id))}>Restore</Button>
      ) : (
        <Button variant="ghost" onClick={() => action.run(() => api.archiveWorkspace(ws.id))} title="Remove the worktree but keep the branch">
          Archive
        </Button>
      )}
      <Button
        variant="danger"
        onClick={() => {
          if (!confirm(`Delete the "${ws.name}" workspace? Its worktree is removed.`)) return;
          const deleteBranch = Boolean(ws.branch) && confirm(`Also delete the branch ${ws.branch}?`);
          void action.run(async () => {
            await api.deleteWorkspace(ws.id, deleteBranch);
            navigate("chats");
          });
        }}
      >
        Delete
      </Button>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

function WorkspaceView({ ws, chatId, snapshot }: { ws: Workspace; chatId: string | null; snapshot: Snapshot }) {
  const [showChanges, setShowChanges] = useState(true);
  const [run, setRun] = useState<(RunDetail & { n: number }) | null>(null);
  // The Run button opens the side panel's terminal on the command.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<RunDetail>).detail;
      if (d.workspaceId !== ws.id) return;
      setShowChanges(true);
      setRun((r) => ({ ...d, n: (r?.n ?? 0) + 1 }));
    };
    window.addEventListener(RUN_EVENT, on);
    return () => window.removeEventListener(RUN_EVENT, on);
  }, [ws.id]);
  const [openPath, setOpenPath] = useState<{ path: string; n: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<OpenFileDetail>).detail;
      if (d.workspaceId !== ws.id) return;
      setShowChanges(true);
      setOpenPath((o) => ({ path: d.path, n: (o?.n ?? 0) + 1 }));
    };
    window.addEventListener(OPEN_FILE_EVENT, on);
    return () => window.removeEventListener(OPEN_FILE_EVENT, on);
  }, [ws.id]);
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<{ chatId: string; x: number; y: number } | null>(null);
  const action = useAction();
  const chats = snapshot.chats.filter((c) => c.workspaceId === ws.id && (showArchived || !c.archived || c.id === chatId));
  const active = chatId && chats.some((c) => c.id === chatId) ? chatId : chats[0]?.id;

  useEffect(() => {
    if (active && active !== chatId) navigate("chats", active);
  }, [active, chatId]);
  useEffect(() => {
    const on = () => setShowChanges((s) => !s);
    window.addEventListener(RIGHT_PANEL_EVENT, on);
    return () => window.removeEventListener(RIGHT_PANEL_EVENT, on);
  }, []);
  // A link sent to this workspace's browser opens the side panel.
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<BrowseDetail>).detail.workspaceId === ws.id && setShowChanges(true);
    window.addEventListener(BROWSE_EVENT, on);
    return () => window.removeEventListener(BROWSE_EVENT, on);
  }, [ws.id]);

  const menuChat = menu ? snapshot.chats.find((c) => c.id === menu.chatId) : null;
  return (
    <div className="flex h-full min-w-0 flex-1" data-workspace-id={ws.id}>
      {menu && menuChat && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
          <div className="fixed z-50 w-44 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700" style={{ left: menu.x, top: menu.y }}>
            {(
              [
                [
                  "Rename",
                  () => {
                    const title = prompt("Rename chat", menuChat.title);
                    if (title?.trim()) void action.run(() => api.updateChat(menuChat.id, { title: title.trim() }));
                  },
                ],
                ["Mark as unread", () => void action.run(() => api.markChatUnread(menuChat.id))],
                [menuChat.archived ? "Unarchive" : "Archive", () => void action.run(() => api.updateChat(menuChat.id, { archived: !menuChat.archived }))],
                ["Delete", () => confirm("Delete this chat and its transcript?") && void action.run(() => api.deleteChat(menuChat.id))],
              ] as [string, () => void][]
            ).map(([label, run]) => (
              <button key={label} className={`block w-full px-3 py-1.5 text-left hover:bg-zinc-800 ${label === "Delete" ? "text-red-400" : "text-zinc-200"}`} onClick={() => (setMenu(null), run())}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader ws={ws} snapshot={snapshot} showChanges={showChanges} onToggleChanges={() => setShowChanges((s) => !s)} />
        <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-900 px-3 py-1.5">
          {chats.map((c) => {
            const agent = c.agentId ? snapshot.agents.find((a) => a.id === c.agentId) : null;
            return (
              <a
                key={c.id}
                href={`#/chats/${c.id}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ chatId: c.id, x: e.clientX, y: e.clientY });
                }}
                className={`group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs ${c.id === active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"} ${c.archived ? "opacity-50" : ""}`}
              >
                {agent && <AgentAvatar agent={agent} size="size-3.5" />}
                <span className="max-w-48 truncate">{c.title}</span>
                {c.status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-violet-400" />}
                {c.status === "waiting" && <span className="size-1.5 rounded-full bg-amber-400" />}
                {c.unread && c.id !== active && <span className="size-1.5 rounded-full bg-sky-400" />}
              </a>
            );
          })}
          {!ws.archived && (
            <button
              className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={() =>
                action.run(async () => {
                  const chat = await api.createChat({ workspaceId: ws.id });
                  navigate("chats", chat.id);
                })
              }
            >
              + New chat
            </button>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {active && (
              <>
                <MoveChat chat={snapshot.chats.find((c) => c.id === active)} snapshot={snapshot} onMove={(to) => action.run(() => api.transferChat(active, to))} />
                <button className="text-xs text-zinc-500 hover:text-zinc-100" onClick={() => action.run(() => api.updateChat(active, { archived: !snapshot.chats.find((c) => c.id === active)?.archived }))}>
                  {snapshot.chats.find((c) => c.id === active)?.archived ? "Unarchive chat" : "Archive chat"}
                </button>
                <button className="text-xs text-zinc-500 hover:text-red-400" onClick={() => confirm("Delete this chat and its transcript?") && action.run(() => api.deleteChat(active))}>
                  Delete chat
                </button>
              </>
            )}
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
            </label>
          </span>
        </div>
        <ErrorText>{action.error}</ErrorText>
        {ws.archived ? (
          <p className="p-8 text-center text-sm text-zinc-500">This workspace is archived. Its branch is kept; restore it to keep working.</p>
        ) : active ? (
          <ChatView key={active} chatId={active} snapshot={snapshot} />
        ) : (
          <p className="p-8 text-center text-sm text-zinc-500">No chats yet. Start one above.</p>
        )}
      </div>
      {showChanges && <WorkspacePanel ws={ws} snapshot={snapshot} run={run} openPath={openPath} />}
    </div>
  );
}

export function ChatsView({ snapshot, selected }: { snapshot: Snapshot; selected: string | null }) {
  const [adding, setAdding] = useState<string | "none" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const bulk = useAction();
  const selectedChat = selected ? snapshot.chats.find((c) => c.id === selected) : undefined;
  const ws = selectedChat ? snapshot.workspaces.find((w) => w.id === selectedChat.workspaceId) : selected ? snapshot.workspaces.find((w) => w.id === selected) : undefined;
  const [order, setOrderState] = useState<SidebarOrder>(() => {
    try {
      return (localStorage.getItem("cadence.chats.order") as SidebarOrder | null) ?? "recent";
    } catch {
      return "recent";
    }
  });
  const setOrder = (o: SidebarOrder) => {
    setOrderState(o);
    try {
      localStorage.setItem("cadence.chats.order", o);
    } catch {
      // storage unavailable
    }
  };
  const visible = snapshot.workspaces.filter((w) => showArchived || !w.archived);
  const groups: { id: string | null; name: string }[] = [...snapshot.projects.map((p) => ({ id: p.id, name: p.name })), { id: null, name: "No project" }];
  const index = useMemo(() => sidebarIndex(snapshot), [snapshot]);
  const unreadIn = (w: Workspace) => (index.chats.get(w.id) ?? []).some((c) => c.unread);
  const sorted = (list: Workspace[]) =>
    [...list].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (order === "unread" ? Number(unreadIn(b)) - Number(unreadIn(a)) : 0) ||
        (order === "name" ? a.name.localeCompare(b.name) : order === "created" ? b.createdAt.localeCompare(a.createdAt) : 0) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );

  return (
    <div className="flex h-full">
      <aside data-sidebar-pane className="flex w-64 shrink-0 flex-col border-r border-zinc-900">
        <div className="flex items-center justify-between gap-2 px-4 pt-4">
          <h2 className="font-semibold">Chats</h2>
          <button className="text-xs text-zinc-500 hover:text-zinc-100" onClick={() => setPicked(picked ? null : new Set())} title="Select several workspaces">
            {picked ? "Done" : "Select"}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-2 text-xs text-zinc-500">
          <select className="-ml-1 rounded bg-transparent hover:text-zinc-200" title="Sort workspaces (pinned stay on top)" value={order} onChange={(e) => setOrder(e.target.value as SidebarOrder)}>
            <option value="recent">Sort: recent</option>
            <option value="unread">Sort: unread first</option>
            <option value="name">Sort: name</option>
            <option value="created">Sort: created</option>
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
          </label>
        </div>
        {picked && (
          <div className="mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-md bg-zinc-900 px-2 py-1.5 text-xs ring-1 ring-zinc-800">
            <span className="text-zinc-400">{picked.size} selected</span>
            {(
              [
                ["Archive", (id: string) => api.archiveWorkspace(id)],
                ["Restore", (id: string) => api.restoreWorkspace(id)],
                [
                  "Mark unread",
                  async (id: string) => {
                    const latest = snapshot.chats.filter((c) => c.workspaceId === id && !c.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
                    if (latest) await api.markChatUnread(latest.id);
                  },
                ],
              ] as [string, (id: string) => Promise<unknown>][]
            ).map(([label, run]) => (
              <button
                key={label}
                className="text-violet-300 hover:underline disabled:opacity-40"
                disabled={!picked.size || bulk.busy}
                onClick={() =>
                  void bulk.run(async () => {
                    for (const id of picked) await run(id);
                    setPicked(new Set());
                  })
                }
              >
                {label}
              </button>
            ))}
            <ErrorText>{bulk.error}</ErrorText>
          </div>
        )}
        <div className="flex-1 space-y-4 overflow-y-auto px-2 pb-4">
          {groups.map((g) => {
            const list = sorted(visible.filter((w) => w.projectId === g.id));
            if (g.id === null && !list.length && snapshot.projects.length) return null;
            const key = g.id ?? "none";
            return (
              <section key={key}>
                <div className="flex items-center justify-between px-2 pb-1">
                  <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{g.name}</p>
                  <button className="text-zinc-500 hover:text-zinc-100" title="New workspace" onClick={() => setAdding(key)}>
                    +
                  </button>
                </div>
                {adding === key && <NewWorkspace snapshot={snapshot} projectId={g.id} onDone={() => setAdding(null)} />}
                <div className="space-y-0.5">
                  <Batched items={list}>
                  {(w) =>
                    picked ? (
                      <label key={w.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-zinc-900">
                        <input
                          type="checkbox"
                          checked={picked.has(w.id)}
                          onChange={(e) =>
                            setPicked((p) => {
                              const next = new Set(p);
                              e.target.checked ? next.add(w.id) : next.delete(w.id);
                              return next;
                            })
                          }
                        />
                        <span className={`truncate ${w.archived ? "text-zinc-500" : "text-zinc-200"}`}>{w.name}</span>
                      </label>
                    ) : (
                      <WorkspaceRow key={w.id} ws={w} index={index} active={w.id === ws?.id} />
                    )}
                  </Batched>
                  {!list.length && adding !== key && <p className="px-2 text-xs text-zinc-600">No workspaces yet</p>}
                </div>
              </section>
            );
          })}
        </div>
      </aside>
      {ws ? (
        <WorkspaceView key={ws.id} ws={ws} chatId={selectedChat?.id ?? null} snapshot={snapshot} />
      ) : (
        <div className="grid flex-1 place-items-center p-8 text-center">
          <div className="max-w-md space-y-2">
            <p className="font-display text-3xl">What are we making?</p>
            <p className="text-sm text-zinc-500">Each workspace is its own git branch with as many chats as you need. Agents' runs show up here too, so you can watch them, steer them, and pick up where they left off.</p>
            <Button variant="primary" onClick={() => setAdding(snapshot.projects[0]?.id ?? "none")}>
              New workspace
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
