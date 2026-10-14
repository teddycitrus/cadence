import { useState } from "react";
import type { Doc, Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { Button, ErrorText, Field, inputClass, useAction } from "../ui";

/** "Generate canvases": an agent turns the doc's screens and states into canvases and embeds them. */
export function GenerateCanvases({ doc, snapshot }: { doc: Doc; snapshot: Snapshot }) {
  const [open, setOpen] = useState(false);
  const issueWs = doc.issueId ? snapshot.workspaces.find((w) => w.issueId === doc.issueId && !w.archived) : null;
  const [target, setTarget] = useState(() => (issueWs ? `ws:${issueWs.id}` : snapshot.projects[0] ? `project:${snapshot.projects[0].id}` : ""));
  const [note, setNote] = useState("");
  const action = useAction();
  if (snapshot.viewer.role === "member") return null;
  const start = () =>
    action.run(async () => {
      const [kind, id] = target.split(":") as ["ws" | "project", string];
      const r = await api.generateCanvases(doc.id, { ...(kind === "ws" ? { workspaceId: id } : { projectId: id }), note });
      setOpen(false);
      navigate("chats", r.chatId);
    });
  return (
    <div className="relative">
      <Button variant="ghost" onClick={() => setOpen(!open)} title="An agent builds canvases for the screens in this doc and embeds them here">
        Generate canvases
      </Button>
      {open && (
        <div className="absolute top-9 right-0 z-30 w-80 space-y-3 rounded-lg bg-zinc-900 p-3 shadow-2xl ring-1 ring-zinc-700">
          <p className="text-xs text-zinc-400">An agent reads this doc, builds a canvas for each screen and state it describes from your real components, and embeds them next to the sections they show.</p>
          <Field label="Where">
            <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
              {snapshot.projects.map((p) => (
                <option key={p.id} value={`project:${p.id}`}>
                  New workspace in {p.name}
                </option>
              ))}
              {snapshot.workspaces
                .filter((w) => !w.archived && w.branch)
                .map((w) => (
                  <option key={w.id} value={`ws:${w.id}`}>
                    Workspace: {w.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Notes (optional)">
            <textarea className={`${inputClass} min-h-16`} placeholder="Mobile first, skip the admin screens..." value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={!target || action.busy} onClick={() => void start()}>
              Start
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {!target && <p className="text-xs text-amber-300">Add a project under Settings first; canvases live in a repo.</p>}
          <ErrorText>{action.error}</ErrorText>
        </div>
      )}
    </div>
  );
}
