import { useEffect, useState } from "react";
import type { Chat, Snapshot } from "../../../../core/types";
import { api, type CanvasInfo } from "../../api";
import { PrBadge } from "../git/PrPanel";

const chip = "flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 ring-1 ring-zinc-800 hover:ring-zinc-600";

/** What this chat's work produced: its branch, pull request, issue, docs, and canvases. */
export function ArtifactStrip({ chat, snapshot }: { chat: Chat; snapshot: Snapshot }) {
  const ws = snapshot.workspaces.find((w) => w.id === chat.workspaceId);
  const [canvases, setCanvases] = useState<CanvasInfo[]>([]);
  const turns = chat.inputTokens + chat.outputTokens;
  useEffect(() => {
    if (!ws?.branch) return;
    let live = true;
    api.workspaceCanvases(ws.id).then((r) => live && setCanvases(r.canvases), () => undefined);
    return () => {
      live = false;
    };
    // Refresh when the agent finishes a turn: that is when new canvases appear.
  }, [ws?.id, chat.status === "idle", turns > 0]);
  if (!ws) return null;
  const prs = snapshot.pullRequests.filter((p) => p.workspaceId === ws.id);
  const issue = ws.issueId ? snapshot.issues.find((i) => i.id === ws.issueId) : null;
  const docs = snapshot.docs.filter((d) => (issue && d.issueId === issue.id) || d.id === chat.docId);
  if (!ws.branch && !prs.length && !issue && !docs.length && !canvases.length) return null;
  return (
    <div className="relative z-10 flex flex-wrap items-center gap-1.5 border-b border-zinc-900 px-4 py-1.5">
      {ws.branch && (
        <span className={chip} title="This workspace's branch">
          <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9" />
          </svg>
          <span className="font-mono">{ws.branch}</span>
        </span>
      )}
      {prs.map((pr) => (
        <PrBadge key={pr.id} pr={pr} />
      ))}
      {issue && (
        <a className={chip} href={`#/issues/${encodeURIComponent(issue.key)}`}>
          <span className="font-mono text-zinc-500">{issue.key}</span>
          <span className="max-w-48 truncate">{issue.title}</span>
        </a>
      )}
      {docs.map((d) => (
        <a key={d.id} className={chip} href={`#/docs/${encodeURIComponent(d.id)}`}>
          Doc: <span className="max-w-40 truncate">{d.title}</span>
        </a>
      ))}
      {canvases.map((c) => (
        <a key={c.path} className={`${chip} group/thumb relative`} href={`#/canvas/${encodeURIComponent(`${ws.id}|${c.path}`)}`} title={c.path}>
          Canvas: <span className="max-w-40 truncate">{c.name}</span>
          {/* A preview of the canvas on hover, loaded only then. */}
          <span className="pointer-events-none absolute top-7 left-0 z-30 hidden w-72 overflow-hidden rounded-lg bg-zinc-900 shadow-2xl ring-1 ring-zinc-700 group-hover/thumb:block">
            <img src={`/api/workspaces/${ws.id}/canvas/thumbnail?path=${encodeURIComponent(c.path)}`} alt="" loading="lazy" className="w-full" />
          </span>
        </a>
      ))}
    </div>
  );
}
