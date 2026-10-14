import { useState } from "react";
import type { Issue, Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { Button, ErrorText, inputClass, PriorityIcon, useAction } from "../ui";
import { useGrowingList } from "../useGrowingList";

/** Spins off one workspace per selected issue, each opening with the issue attached and the prompt sent. */
export function CreateWorkspacesDialog({ issues, snapshot, onClose }: { issues: Issue[]; snapshot: Snapshot; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { visible, more, sentinel } = useGrowingList(issues, 100);
  const [prompt, setPrompt] = useState("Read the issue and its linked docs, then propose an approach before changing code.");
  const action = useAction();
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-zinc-950 shadow-2xl ring-1 ring-zinc-800" onClick={(e) => e.stopPropagation()}>
        <header className="border-b border-zinc-900 px-5 py-4">
          <h2 className="font-semibold">Create workspaces</h2>
          <p className="text-sm text-zinc-500">Each issue gets its own branch and a chat that starts with the issue attached and this prompt.</p>
        </header>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.map((i) => (
            <li key={i.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-zinc-900">
                <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                <PriorityIcon priority={i.priority} />
                <span className="font-mono text-xs text-zinc-500">{i.key}</span>
                <span className="truncate">{i.title}</span>
                <span className="ml-auto shrink-0 text-xs text-zinc-500">{snapshot.stages.find((s) => s.id === i.stageId)?.name}</span>
              </label>
            </li>
          ))}
          {more > 0 && (
            <li ref={sentinel} className="px-3 py-1.5 text-xs text-zinc-500">
              {more} more...
            </li>
          )}
        </ul>
        <footer className="space-y-2 border-t border-zinc-900 p-4">
          <textarea className={`${inputClass} min-h-20`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={!selected.size || action.busy}
              onClick={() =>
                action.run(async () => {
                  const res = await api.workspacesFromIssues({ issueIds: [...selected], prompt });
                  onClose();
                  navigate("chats", res.created[0]!.chatId);
                })
              }
            >
              Create {selected.size || ""} workspace{selected.size === 1 ? "" : "s"}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <ErrorText>{action.error}</ErrorText>
          </div>
        </footer>
      </div>
    </div>
  );
}
