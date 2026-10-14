import { useEffect, useState } from "react";
import type { Skill, Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { Button, ErrorText, Field, inputClass, timeAgo, useAction } from "../ui";

const EMPTY = { name: "", description: "", body: "" };

function SystemPrompt({ snapshot }: { snapshot: Snapshot }) {
  const saved = snapshot.members.find((m) => m.id === snapshot.viewer.memberId)?.systemPrompt ?? "";
  const [draft, setDraft] = useState(saved);
  const action = useAction();
  useEffect(() => setDraft(saved), [saved]);
  return (
    <section className="space-y-3">
      <Field label="Standing instructions" hint="Added to every chat you start: how you like answers, your conventions, things to always check.">
        <textarea className={`${inputClass} min-h-32`} value={draft} onChange={(e) => setDraft(e.target.value)} />
      </Field>
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={draft === saved || action.busy} onClick={() => action.run(() => api.setPreferences(draft))}>
          Save
        </Button>
        <ErrorText>{action.error}</ErrorText>
      </div>
    </section>
  );
}

function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<typeof EMPTY | null>(null);
  const action = useAction();
  const reload = () => void api.skills().then(setSkills, () => undefined);
  useEffect(reload, []);
  const save = () =>
    editing &&
    action.run(async () => {
      await api.saveSkill(editing);
      setEditing(null);
      reload();
    });
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Skills</h2>
        {!editing && <Button onClick={() => setEditing(EMPTY)}>New skill</Button>}
      </div>
      <p className="text-sm text-zinc-500">Saved workflows your assistant follows when a request matches. You can also ask it in chat to "save this as a skill".</p>
      {editing && (
        <div className="space-y-3 rounded-lg border border-zinc-800 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" hint="Lowercase words joined by dashes.">
              <input className={inputClass} value={editing.name} placeholder="write-release-notes" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="When to use it">
              <input className={inputClass} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </Field>
          </div>
          <Field label="Instructions">
            <textarea className={`${inputClass} min-h-40 font-mono text-xs`} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={!editing.name.trim() || !editing.body.trim() || action.busy} onClick={save}>
              Save skill
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <ErrorText>{action.error}</ErrorText>
          </div>
        </div>
      )}
      <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-900">
        {skills.map((s) => (
          <li key={s.id} className="flex items-start gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-sm">{s.name}</div>
              <div className="truncate text-xs text-zinc-500">
                {s.description || "No description"} · updated {timeAgo(s.updatedAt)}
              </div>
            </div>
            <Button onClick={() => setEditing({ name: s.name, description: s.description, body: s.body })}>Edit</Button>
            <Button onClick={() => action.run(async () => (await api.duplicateSkill(s.id), reload()))}>Duplicate</Button>
            <Button onClick={() => action.run(async () => (await api.deleteSkill(s.id), reload()))}>Delete</Button>
          </li>
        ))}
        {!skills.length && <li className="px-3 py-4 text-sm text-zinc-500">No skills yet.</li>}
      </ul>
    </section>
  );
}

export function PersonalSettings({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="max-w-2xl space-y-8">
      <SystemPrompt snapshot={snapshot} />
      <Skills />
    </div>
  );
}
