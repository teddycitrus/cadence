import type { Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { Dot, PriorityIcon } from "../ui";

/** The issue an agent just filed or changed, as a card: open it, copy its ID, or give it a workspace. */
export function IssueToolCard({ text, snapshot }: { text: string; snapshot: Snapshot }) {
  const keys = new Set(snapshot.issues.map((i) => i.key));
  const key = [...text.matchAll(/\b([A-Z][A-Z0-9]*-\d+)\b/g)].map((m) => m[1]!).find((k) => keys.has(k));
  const issue = key ? snapshot.issues.find((i) => i.key === key) : null;
  if (!issue) return null;
  const stage = snapshot.stages.find((s) => s.id === issue.stageId);
  return (
    <div className="mt-1 flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs ring-1 ring-zinc-800">
      <PriorityIcon priority={issue.priority} />
      <span className="font-mono text-zinc-500">{issue.key}</span>
      <button className="min-w-0 flex-1 truncate text-left text-sm text-zinc-100 hover:underline" onClick={() => navigate("issues", issue.key)}>
        {issue.title}
      </button>
      {stage && (
        <span className="flex shrink-0 items-center gap-1 text-zinc-400">
          <Dot color={stage.color} className="size-2" />
          {stage.name}
        </span>
      )}
      <button className="shrink-0 text-zinc-500 hover:text-zinc-100" onClick={() => void navigator.clipboard.writeText(issue.key)} title="Copy ID">
        Copy ID
      </button>
      {snapshot.viewer.role !== "member" && (
        <button className="shrink-0 text-violet-300 hover:underline" onClick={() => void api.workspacesFromIssues({ issueIds: [issue.id], prompt: "" }).then((r) => r.created[0] && navigate("chats", r.created[0].chatId))} title="A workspace on its own branch for this issue">
          Workspace
        </button>
      )}
    </div>
  );
}
