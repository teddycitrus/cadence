import { useState } from "react";
import type { Project, Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { Button, Dot, Empty, ErrorText, Field, inputClass, useAction } from "../ui";
import { ProjectScripts } from "./ProjectScripts";

export function LabelsEditor({ snapshot }: { snapshot: Snapshot }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7a4a6e");
  const action = useAction();
  return (
    <div className="max-w-xl space-y-4">
      <ul className="divide-y divide-zinc-900 rounded-xl bg-zinc-900/60 ring-1 ring-zinc-800">
        {snapshot.labels.map((l) => (
          <li key={l.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <Dot color={l.color} />
            {l.name}
            <span className="ml-auto text-xs text-zinc-500">{snapshot.issues.filter((i) => i.labelIds.includes(l.id)).length} issues</span>
            <Button variant="danger" onClick={() => action.run(() => api.deleteLabel(l.id))}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await action.run(() => api.createLabel({ name, color }))) setName("");
        }}
      >
        <input type="color" className="h-8 w-10 rounded bg-transparent" value={color} onChange={(e) => setColor(e.target.value)} />
        <input className={inputClass} placeholder="New label" value={name} onChange={(e) => setName(e.target.value)} />
        <Button variant="primary" type="submit" disabled={!name.trim()}>
          Add
        </Button>
      </form>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

function ProjectForm({ project, onDone }: { project?: Project; onDone: () => void }) {
  const [name, setName] = useState(project?.name ?? "");
  const [path, setPath] = useState(project?.path ?? "");
  const [baseBranch, setBaseBranch] = useState(project?.baseBranch ?? "");
  const [githubRepo, setGithubRepo] = useState(project?.githubRepo ?? "");
  const [setupScript, setSetupScript] = useState(project?.setupScript ?? "");
  const action = useAction();
  return (
    <form
      className="grid gap-3 rounded-xl bg-zinc-900/60 p-4 ring-1 ring-zinc-800 md:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await action.run(() =>
          project
            ? api.updateProject(project.id, { name, baseBranch, githubRepo: githubRepo || null })
            : api.addProject({ name, path, baseBranch: baseBranch || undefined, githubRepo: githubRepo || null, setupScript: setupScript || null }),
        );
        if (ok) onDone();
      }}
    >
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Local path" hint="Absolute path to a git checkout on this machine.">
        <input className={`${inputClass} font-mono`} value={path} onChange={(e) => setPath(e.target.value)} required disabled={Boolean(project)} placeholder="C:\code\my-app" />
      </Field>
      <Field label="Base branch" hint="Defaults to the checked-out branch.">
        <input className={inputClass} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
      </Field>
      <Field label="GitHub repository" hint="owner/name, used to match pull requests.">
        <input className={inputClass} value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="acme/web" />
      </Field>
      {!project && (
        <div className="md:col-span-2">
          <Field label="Prep command" hint="Runs once in each new workspace, e.g. npm install. Change it, and add Run commands, under Scripts later.">
            <input className={`${inputClass} font-mono`} value={setupScript} onChange={(e) => setSetupScript(e.target.value)} placeholder="npm install" />
          </Field>
        </div>
      )}
      <div className="flex items-center gap-2 md:col-span-2">
        <Button variant="primary" type="submit">
          {project ? "Save" : "Add project"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <ErrorText>{action.error}</ErrorText>
      </div>
    </form>
  );
}

export function ProjectsEditor({ snapshot }: { snapshot: Snapshot }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [scriptsFor, setScriptsFor] = useState<string | null>(null);
  const remove = useAction();
  return (
    <div className="max-w-3xl space-y-3">
      {editing === null && (
        <Button variant="primary" onClick={() => setEditing("new")}>
          Add project
        </Button>
      )}
      {editing === "new" && <ProjectForm onDone={() => setEditing(null)} />}
      {snapshot.projects.length === 0 && editing === null && <Empty title="No projects yet">Add a local git repository so agents can work on your code.</Empty>}
      {snapshot.projects.map((p) =>
        editing === p.id ? (
          <ProjectForm key={p.id} project={p} onDone={() => setEditing(null)} />
        ) : (
          <div key={p.id} className="space-y-2">
          <div className="flex flex-wrap items-start gap-2 rounded-xl bg-zinc-900/60 p-4 ring-1 ring-zinc-800">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{p.name}</p>
              <p className="truncate font-mono text-xs text-zinc-500">{p.path}</p>
              <p className="mt-1 text-xs text-zinc-500">
                base {p.baseBranch}
                {p.githubRepo ? ` · GitHub ${p.githubRepo}` : ""}
                {p.setupScript ? ` · setup: ${p.setupScript}` : ""}
                {p.commands.length ? ` · ${p.commands.length} run scripts` : ""}
              </p>
            </div>
            <Button variant="ghost" onClick={() => setScriptsFor(scriptsFor === p.id ? null : p.id)}>
              Scripts
            </Button>
            <Button variant="ghost" onClick={() => setEditing(p.id)}>
              Edit
            </Button>
            <Button variant="danger" title="Removes the project from Cadence. The repository on disk stays." onClick={() => confirm(`Remove ${p.name} from Cadence? Its folder on disk is not touched.`) && remove.run(() => api.removeProject(p.id))}>
              Remove
            </Button>
          </div>
          {scriptsFor === p.id && <ProjectScripts project={p} canEditShared={snapshot.viewer.role !== "member"} />}
          </div>
        ),
      )}
      <ErrorText>{remove.error}</ErrorText>
    </div>
  );
}
