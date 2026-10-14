import { useEffect, useState } from "react";
import { openLinksInside, setOpenLinksInside } from "../../links";
import { setThemePref, setUiSize, stepUiSize, themePref, UI_SIZES, uiSize } from "../../theme";
import { MachinesSettings } from "./MachinesSettings";
import type { Settings, Snapshot } from "../../../../core/types";
import { EFFORTS } from "../../../../core/types";
import { api } from "../../api";
import { Button, ErrorText, Field, inputClass, modelsFor, ProviderSelect, useAction } from "../ui";
import { LabelsEditor, ProjectsEditor } from "./ProjectsAndLabels";
import { StagesEditor } from "./StagesEditor";
import { GitHubSettings } from "./GitHubSettings";
import { IntegrationsSettings } from "./IntegrationsSettings";
import { MembersSettings } from "./MembersSettings";
import { PersonalSettings } from "./PersonalSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { OrgSettings } from "./OrgSettings";
import { UsageSettings } from "./UsageSettings";

type Section = "usage" | "machines" | "organization" | "preferences" | "personal" | "providers" | "members" | "stages" | "labels" | "projects" | "github" | "integrations";

function Preferences({ snapshot }: { snapshot: Snapshot }) {
  const settings = snapshot.settings;
  const [draft, setDraft] = useState(settings);
  const action = useAction();
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const provider = draft.defaultProvider ?? "claude-code";
  const [theme, setTheme] = useState(themePref);
  const [inside, setInside] = useState(openLinksInside);
  const [size, setSize] = useState(uiSize);
  return (
    <div className="max-w-2xl space-y-5">
      <Field label="Theme" hint="Saved in this browser.">
        <div className="flex gap-1">
          {(["light", "dark", "system"] as const).map((t) => (
            <button
              key={t}
              className={`rounded-md px-3 py-1.5 text-sm ring-1 ${theme === t ? "bg-zinc-800 text-zinc-100 ring-zinc-600" : "text-zinc-400 ring-zinc-800 hover:bg-zinc-900"}`}
              onClick={() => {
                setThemePref(t);
                setTheme(t);
              }}
            >
              {{ dark: "Night", light: "Sand", system: "Match system" }[t]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Interface size" hint="Saved in this browser. Ctrl+Alt+= and Ctrl+Alt+- change it anywhere; Ctrl+Alt+0 resets.">
        <div className="flex items-center gap-1">
          <button className="rounded-md px-2.5 py-1 text-sm text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-900 disabled:opacity-40" disabled={size === UI_SIZES[0]} onClick={() => setSize(stepUiSize(-1))} aria-label="Smaller">
            A-
          </button>
          <span className="w-14 text-center text-sm tabular-nums text-zinc-300">{size}%</span>
          <button className="rounded-md px-2.5 py-1 text-sm text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-900 disabled:opacity-40" disabled={size === UI_SIZES.at(-1)} onClick={() => setSize(stepUiSize(1))} aria-label="Larger">
            A+
          </button>
          {size !== 100 && (
            <button className="ml-2 text-xs text-zinc-500 hover:text-zinc-200" onClick={() => (setUiSize(100), setSize(100))}>
              Reset
            </button>
          )}
        </div>
      </Field>
      {snapshot.viewer.role !== "member" && (
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={inside} onChange={(e) => (setOpenLinksInside(e.target.checked), setInside(e.target.checked))} />
          Open links from chats in the workspace's built-in browser (Ctrl or Cmd-click still opens a new tab)
        </label>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Default harness for new chats and agents">
          <ProviderSelect snapshot={snapshot} value={provider} onChange={(p) => setDraft({ ...draft, defaultProvider: p, defaultModel: p === "claude-code" ? "claude-opus-5-5" : "default" })} />
        </Field>
        <Field label="Default model">
          <select className={inputClass} value={draft.defaultModel} onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}>
            {modelsFor(snapshot, provider, draft.defaultModel).map((m) => (
              <option key={m} value={m}>
                {m === "default" ? "Harness default" : m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default effort">
          <select className={inputClass} value={draft.defaultEffort} onChange={(e) => setDraft({ ...draft, defaultEffort: e.target.value as Settings["defaultEffort"] })}>
            {EFFORTS.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        </Field>
        <Field label="Max concurrent agent runs" hint="Extra triggered runs queue until a slot frees.">
          <input type="number" min={1} max={16} className={inputClass} value={draft.concurrency} onChange={(e) => setDraft({ ...draft, concurrency: Number(e.target.value) })} />
        </Field>
        <Field label="Max turns per run">
          <input type="number" min={5} max={1000} className={inputClass} value={draft.maxTurns} onChange={(e) => setDraft({ ...draft, maxTurns: Number(e.target.value) })} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={draft.autoMoveIssues !== false} onChange={(e) => setDraft({ ...draft, autoMoveIssues: e.target.checked })} />
        Move issues to review when their pull request opens, and to done when it merges (each move can be undone from the issue)
      </label>
      <Field label="Team-wide instructions" hint="Added to every agent's instructions: conventions, links, things every agent should know.">
        <textarea className={`${inputClass} min-h-32`} value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} />
      </Field>
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!dirty || action.busy} onClick={() => action.run(() => api.updateSettings(draft))}>
          Save
        </Button>
        <ErrorText>{action.error}</ErrorText>
      </div>
      <p className="text-xs text-zinc-500">Chats and agents run on this machine through the harness you pick, using its own sign-in. Set up harnesses and keys under Providers.</p>
    </div>
  );
}

export function SettingsView({ snapshot, initial }: { snapshot: Snapshot; initial?: string | null }) {
  const [section, setSection] = useState<Section>((initial as Section | null) ?? "preferences");
  useEffect(() => {
    if (initial) setSection(initial as Section);
  }, [initial]);
  const sections: { id: Section; label: string }[] = [
    { id: "preferences", label: "Preferences" },
    { id: "personal", label: "Your assistant" },
    { id: "organization", label: "Organization" },
    ...(snapshot.viewer.role !== "member" ? [{ id: "usage" as const, label: "Usage" }] : []),
    ...(snapshot.viewer.role !== "member" ? [{ id: "machines" as const, label: "Computers" }] : []),
    ...(snapshot.viewer.role !== "member" ? [{ id: "providers" as const, label: "Providers" }] : []),
    { id: "members", label: "Members" },
    { id: "stages", label: "Stages" },
    { id: "labels", label: "Labels" },
    { id: "projects", label: "Projects" },
    { id: "github", label: "GitHub" },
    { id: "integrations", label: "Integrations" },
  ];
  return (
    <div className="flex h-full">
      <aside data-sidebar-pane className="w-52 shrink-0 space-y-0.5 border-r border-zinc-900 p-3">
        <h2 className="px-2 pt-1 pb-3 font-semibold">Settings</h2>
        {sections.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)} className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${section === s.id ? "bg-zinc-800" : "text-zinc-400 hover:bg-zinc-900"}`}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto p-8">
        <h1 className="mb-1 text-lg font-semibold">{sections.find((s) => s.id === section)!.label}</h1>
        <p className="mb-6 text-sm text-zinc-500">
          {
            {
              preferences: "Defaults for agents on this machine.",
              providers: "The agent harnesses this machine runs chats and agents through: Claude Code natively, the others over the Agent Client Protocol. Each uses its own sign-in, or a key you add here.",
              machines: "Other computers you can open from here, and this computer's link to a hub.",
              usage: "What chats and agents cost each month, by harness, agent, and person, and the spending limit that pauses them.",
              organization: "This organization's name. Switch between organizations, or make a new one, from the logo at the top left.",
              personal: "Standing instructions and saved skills for the chats you start. Only you see these; agents do not use them.",
              members: "Who can sign in to this Cadence, and what they can do.",
              stages: "Rename, recolor, reorder, and gate the stages issues move through. Agents cannot move cards out of a gated stage.",
              labels: "Labels agents and people use to route and filter issues.",
              projects: "Git repositories agents work in. Each issue gets its own branch and worktree.",
              integrations: "Connect Slack and Linear so agents can work where your team talks and plans, and let outside agents use the board over MCP.",
              github: "Open pull requests from workspaces, follow their checks and reviews, and trigger agents on merges without a public webhook.",
            }[section]
          }
        </p>
        {section === "preferences" && <Preferences snapshot={snapshot} />}
        {section === "personal" && <PersonalSettings snapshot={snapshot} />}
        {section === "organization" && <OrgSettings />}
        {section === "usage" && <UsageSettings snapshot={snapshot} />}
        {section === "machines" && <MachinesSettings snapshot={snapshot} />}
        {section === "providers" && <ProvidersSettings />}
        {section === "members" && <MembersSettings snapshot={snapshot} />}
        {section === "stages" && <StagesEditor snapshot={snapshot} />}
        {section === "labels" && <LabelsEditor snapshot={snapshot} />}
        {section === "projects" && <ProjectsEditor snapshot={snapshot} />}
        {section === "github" && <GitHubSettings snapshot={snapshot} />}
        {section === "integrations" && <IntegrationsSettings canEdit={snapshot.viewer.role !== "member"} />}
      </div>
    </div>
  );
}
