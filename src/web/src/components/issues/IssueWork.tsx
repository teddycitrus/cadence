import { useState } from "react";
import type { Run, Snapshot, Workspace } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { Button, ErrorText, inputClass, RunStatusBadge, timeAgo, useAction } from "../ui";

/** One agent run with a link into the chat where it happened. */
export function RunRow({ run, agentName }: { run: Run; agentName?: string }) {
  const action = useAction();
  const active = run.status === "queued" || run.status === "running";
  return (
    <div className="space-y-1 rounded-lg bg-zinc-900 p-3 text-sm ring-1 ring-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{agentName ?? "Agent"}</span>
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-zinc-500">
          {run.trigger.replace(/_/g, " ")} · {timeAgo(run.createdAt)}
          {run.costUsd > 0 && ` · $${run.costUsd.toFixed(2)}`}
        </span>
        <span className="ml-auto flex gap-2">
          {run.chatId && (
            <a href={`#/chats/${run.chatId}`} className="text-xs text-violet-300 hover:underline">
              Open chat
            </a>
          )}
          {active && (
            <button className="text-xs text-red-400 hover:underline" onClick={() => action.run(() => api.cancelRun(run.id))}>
              Cancel
            </button>
          )}
        </span>
      </div>
      {run.summary && <p className="line-clamp-4 text-xs whitespace-pre-wrap text-zinc-400">{run.summary}</p>}
      {run.error && <p className="text-xs text-red-400">{run.error}</p>}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

/** The issue's workspaces, and a way to start one with the issue attached. */
export function WorkspacesSection({ issueId, workspaces, snapshot }: { issueId: string; workspaces: Workspace[]; snapshot: Snapshot }) {
  const [prompt, setPrompt] = useState("");
  const action = useAction();
  const start = () =>
    action.run(async () => {
      const res = await api.workspacesFromIssues({ issueIds: [issueId], prompt });
      navigate("chats", res.created[0]!.chatId);
    });
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-zinc-500">Workspaces</h3>
      {workspaces.map((w) => {
        const chats = snapshot.chats.filter((c) => c.workspaceId === w.id);
        return (
          <a key={w.id} href={`#/chats/${chats[0]?.id ?? w.id}`} className="flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm ring-1 ring-zinc-800 hover:ring-zinc-600">
            <span className="truncate font-mono text-xs text-zinc-400">{w.branch ?? "scratch"}</span>
            <span className="ml-auto text-xs text-zinc-500">
              {chats.length} chat{chats.length === 1 ? "" : "s"}
              {w.archived ? " · archived" : ""}
            </span>
          </a>
        );
      })}
      <div className="flex gap-2">
        <input className={inputClass} placeholder={workspaces.length ? "Start another chat on this issue..." : "What should the AI do first? (optional)"} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <Button variant="primary" disabled={action.busy} onClick={start}>
          {workspaces.length ? "Open chat" : "Start workspace"}
        </Button>
      </div>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}
