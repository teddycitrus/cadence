import { useState, type ReactNode } from "react";
import type { Chat, Snapshot, Workspace } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { useAction } from "../ui";

/** A "..." button with a dropdown of actions, so headers stay one line however narrow the window. */
export function MoreMenu({ label = "More", onOpen, children }: { label?: string; onOpen?: () => void; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button aria-label={label} title={label} onClick={() => (!open && onOpen?.(), setOpen(!open))} className={`grid h-7 min-w-8 place-items-center rounded-md px-2 text-sm ${open ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"}`}>
        ...
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-50 mt-1 w-56 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700">{children(() => setOpen(false))}</div>
        </>
      )}
    </div>
  );
}

export function MenuItem({ onClick, danger, disabled, children, title }: { onClick: () => void; danger?: boolean; disabled?: boolean; children: ReactNode; title?: string }) {
  return (
    <button disabled={disabled} title={title} onClick={onClick} className={`block w-full px-3 py-1.5 text-left disabled:opacity-50 ${danger ? "text-red-400 hover:bg-red-950/60" : "text-zinc-200 hover:bg-zinc-800"}`}>
      {children}
    </button>
  );
}

const Divider = () => <div className="my-1 border-t border-zinc-800" />;

/** The workspace's less frequent actions: pin, open its folder elsewhere, archive, delete. */
export function WorkspaceMenu({ ws, snapshot }: { ws: Workspace; snapshot: Snapshot }) {
  const action = useAction();
  const [targets, setTargets] = useState<{ id: string; label: string }[] | null>(null);
  const host = snapshot.viewer.role !== "member";
  return (
    <MoreMenu label="Workspace actions" onOpen={() => host && !targets && void api.openInTargets(ws.id).then((r) => setTargets(r.targets), () => setTargets([]))}>
      {(close) => {
        const run = (fn: () => Promise<unknown>) => () => void action.run(fn).then(close);
        return (
          <>
            <MenuItem onClick={run(() => api.updateWorkspace(ws.id, { pinned: !ws.pinned }))}>{ws.pinned ? "Unpin" : "Pin to the top"}</MenuItem>
            {host && (
              <>
                <Divider />
                <p className="px-3 pt-1 pb-0.5 text-xs text-zinc-500">Open folder in</p>
                {!targets && <p className="px-3 py-1 text-xs text-zinc-500">Looking for apps...</p>}
                {targets?.map((t) => (
                  <MenuItem key={t.id} onClick={run(() => api.openIn(ws.id, t.id))}>
                    {t.label}
                  </MenuItem>
                ))}
              </>
            )}
            <Divider />
            {ws.archived ? (
              <MenuItem onClick={run(() => api.restoreWorkspace(ws.id))}>Restore workspace</MenuItem>
            ) : (
              <MenuItem onClick={run(() => api.archiveWorkspace(ws.id))} title="Remove the worktree but keep the branch">
                Archive workspace
              </MenuItem>
            )}
            <MenuItem
              danger
              onClick={() => {
                if (!confirm(`Delete the "${ws.name}" workspace? Its worktree is removed.`)) return;
                const deleteBranch = Boolean(ws.branch) && confirm(`Also delete the branch ${ws.branch}?`);
                void action.run(async () => {
                  await api.deleteWorkspace(ws.id, deleteBranch);
                  navigate("chats");
                });
              }}
            >
              Delete workspace
            </MenuItem>
            {action.error && <p className="px-3 py-1 text-xs text-red-400">{action.error}</p>}
          </>
        );
      }}
    </MoreMenu>
  );
}

/** The open chat's actions: move it to another workspace, archive, delete, and showing archived chats. */
export function ChatMenu({ chat, snapshot, showArchived, onShowArchived }: { chat: Chat | undefined; snapshot: Snapshot; showArchived: boolean; onShowArchived: (v: boolean) => void }) {
  const action = useAction();
  const busy = chat?.status === "running" || chat?.status === "waiting";
  const moveTargets = chat && !chat.agentId && !chat.docId && !chat.archived ? snapshot.workspaces.filter((w) => w.id !== chat.workspaceId && !w.archived) : [];
  return (
    <MoreMenu label="Chat actions">
      {(close) => {
        const run = (fn: () => Promise<unknown>) => () => void action.run(fn).then(close);
        return (
          <>
            {chat && moveTargets.length > 0 && (
              <>
                <p className="px-3 pt-1 pb-0.5 text-xs text-zinc-500">{busy ? "Move to (after this turn)" : "Move chat to"}</p>
                <div className="max-h-48 overflow-y-auto">
                  {moveTargets.map((w) => (
                    <MenuItem key={w.id} disabled={busy} onClick={run(() => api.transferChat(chat.id, w.id))}>
                      <span className="block truncate">{w.name}</span>
                      {w.branch && <span className="block truncate font-mono text-[11px] text-zinc-500">{w.branch}</span>}
                    </MenuItem>
                  ))}
                </div>
                <Divider />
              </>
            )}
            {chat && (
              <>
                <MenuItem onClick={run(() => api.updateChat(chat.id, { archived: !chat.archived }))}>{chat.archived ? "Unarchive chat" : "Archive chat"}</MenuItem>
                <MenuItem danger onClick={() => confirm("Delete this chat and its transcript?") && void action.run(() => api.deleteChat(chat.id)).then(close)}>
                  Delete chat
                </MenuItem>
                <Divider />
              </>
            )}
            <label className="flex items-center gap-2 px-3 py-1.5 text-zinc-300">
              <input type="checkbox" checked={showArchived} onChange={(e) => onShowArchived(e.target.checked)} /> Show archived chats
            </label>
            {action.error && <p className="px-3 py-1 text-xs text-red-400">{action.error}</p>}
          </>
        );
      }}
    </MoreMenu>
  );
}
