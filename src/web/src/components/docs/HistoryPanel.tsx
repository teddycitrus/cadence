import { useState } from "react";
import type { DocVersion, Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { useLive } from "../../live";
import { Markdown } from "../Markdown";
import { actorName, Button, ErrorText, timeAgo, useAction } from "../ui";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Collapses bursts of autosaves by the same person into one entry (the latest). */
export function groupVersions(versions: DocVersion[]): { latest: DocVersion; count: number }[] {
  const groups: { latest: DocVersion; count: number; oldest: DocVersion }[] = [];
  for (const v of versions) {
    const last = groups.at(-1);
    if (last && last.oldest.actor === v.actor && Date.parse(last.oldest.ts) - Date.parse(v.ts) < GROUP_WINDOW_MS) {
      last.count += 1;
      last.oldest = v;
    } else groups.push({ latest: v, count: 1, oldest: v });
  }
  return groups;
}

/** Every saved version of a doc, with preview and restore. */
export function HistoryPanel({ docId, snapshot, currentVersion, onClose }: { docId: string; snapshot: Snapshot; currentVersion: number; onClose: () => void }) {
  const { data: versions } = useLive(() => api.docHistory(docId), [docId, currentVersion], (e) => e.aggregate === "doc" && e.aggregateId === docId);
  const [open, setOpen] = useState<number | null>(null);
  const action = useAction();
  const preview = versions?.find((v) => v.version === open);
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-900 px-4 py-2.5">
        <h2 className="text-sm font-semibold">History</h2>
        <button className="text-zinc-500 hover:text-zinc-100" onClick={onClose} aria-label="Close history">
          ×
        </button>
      </header>
      <ul className="max-h-72 shrink-0 overflow-y-auto border-b border-zinc-900 p-2">
        {versions &&
          groupVersions(versions).map(({ latest: v, count }) => (
            <li key={v.seq}>
              <button onClick={() => setOpen(v.version)} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${open === v.version ? "bg-zinc-800" : "hover:bg-zinc-900"}`}>
                <span className="font-mono text-xs text-zinc-500">v{v.version}</span>
                <span className="truncate">
                  {actorName(v.actor, snapshot)}
                  {count > 1 && <span className="text-zinc-500"> · {count} edits</span>}
                </span>
                <span className="ml-auto shrink-0 text-xs text-zinc-500">{v.version === currentVersion ? "current" : timeAgo(v.ts)}</span>
              </button>
            </li>
          ))}
      </ul>
      {preview ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium">{preview.title}</h3>
            {preview.version !== currentVersion && (
              <Button variant="primary" className="ml-auto" disabled={action.busy} onClick={() => action.run(() => api.restoreDoc(docId, preview.version))}>
                Restore v{preview.version}
              </Button>
            )}
          </div>
          <ErrorText>{action.error}</ErrorText>
          <Markdown>{preview.body || "_Empty_"}</Markdown>
        </div>
      ) : (
        <p className="p-4 text-sm text-zinc-500">Pick a version to preview it.</p>
      )}
    </aside>
  );
}
