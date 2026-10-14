import { useEffect, useState } from "react";
import type { Project } from "../../../../core/types";
import { api, type ProjectScripts as Scripts } from "../../api";
import { Button, ErrorText, inputClass, useAction } from "../ui";

type Command = { name: string; command: string };

const ENV_HINT = /Windows/.test(navigator.userAgent) ? "mklink .env %CADENCE_SOURCE_PATH%\\.env" : "ln -sf $CADENCE_SOURCE_PATH/.env .env";

function SetupEditor({ title, hint, value, readOnly, onSave }: { title: string; hint: string; value: string | null; readOnly: boolean; onSave: (v: string | null) => Promise<unknown> }) {
  const [text, setText] = useState(value ?? "");
  const action = useAction();
  useEffect(() => setText(value ?? ""), [value]);
  const dirty = text.trim() !== (value ?? "");
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs text-zinc-500">{hint}</p>
      <textarea className={`${inputClass} min-h-16 font-mono text-xs`} value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} placeholder={ENV_HINT} />
      {dirty && !readOnly && (
        <Button variant="primary" disabled={action.busy} onClick={() => action.run(() => onSave(text.trim() || null))}>
          Save
        </Button>
      )}
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}

function CommandsEditor({ title, hint, value, readOnly, onSave }: { title: string; hint: string; value: Command[]; readOnly: boolean; onSave: (v: Command[]) => Promise<unknown> }) {
  const [rows, setRows] = useState<Command[]>(value);
  const action = useAction();
  useEffect(() => setRows(value), [value]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(value);
  const set = (i: number, patch: Partial<Command>) => setRows((r) => r.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs text-zinc-500">{hint}</p>
      {rows.map((c, i) => (
        <div key={i} className="flex gap-2">
          <input className={`${inputClass} w-32 font-mono text-xs`} value={c.name} readOnly={readOnly} placeholder="test" onChange={(e) => set(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} />
          <input className={`${inputClass} font-mono text-xs`} value={c.command} readOnly={readOnly} placeholder="npm test" onChange={(e) => set(i, { command: e.target.value })} />
          {!readOnly && (
            <Button variant="ghost" title="Remove" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
              ×
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setRows((r) => [...r, { name: "", command: "" }])}>
            + Add script
          </Button>
          {dirty && (
            <Button variant="primary" disabled={action.busy || rows.some((c) => !c.name || !c.command.trim())} onClick={() => action.run(() => onSave(rows))}>
              Save scripts
            </Button>
          )}
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}

/** Shared and personal prep commands and Run commands for one project. */
export function ProjectScripts({ project, canEditShared }: { project: Project; canEditShared: boolean }) {
  const [scripts, setScripts] = useState<Scripts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.projectScripts(project.id).then(setScripts, (e: Error) => setError(e.message));
  }, [project.id]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!scripts) return <p className="text-xs text-zinc-500">Loading scripts...</p>;
  const save = (input: Parameters<typeof api.saveProjectScripts>[1]) => api.saveProjectScripts(project.id, input).then(setScripts);
  return (
    <div className="grid gap-5 rounded-xl bg-zinc-900/60 p-4 ring-1 ring-zinc-800">
      <SetupEditor title="Shared prep command" hint="Runs in every new workspace for this project. Everyone in the organization shares it." value={scripts.sharedPrep} readOnly={!canEditShared} onSave={(v) => save({ scope: "org", setupScript: v })} />
      <CommandsEditor title="Shared Run commands" hint="Named commands for the Run button, for everyone." value={scripts.sharedCommands} readOnly={!canEditShared} onSave={(v) => save({ scope: "org", commands: v })} />
      <SetupEditor title="My prep command" hint="Runs after the shared one. Only you see it." value={scripts.myPrep} readOnly={false} onSave={(v) => save({ scope: "user", setupScript: v })} />
      <CommandsEditor title="My Run commands" hint="Personal Run commands only you see; reusing a shared name replaces that one for you." value={scripts.myCommands} readOnly={false} onSave={(v) => save({ scope: "user", commands: v })} />
      <p className="text-xs text-zinc-500">Scripts get CADENCE_SOURCE_PATH (the source checkout), CADENCE_WORKSPACE_PATH, and CADENCE_PROJECT.</p>
    </div>
  );
}
