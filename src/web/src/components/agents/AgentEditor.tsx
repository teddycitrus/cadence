import { useEffect, useState } from "react";
import { AGENT_ICON_NAMES } from "../../../../core/agent-icons";
import type { Agent, Snapshot, TriggerInput } from "../../../../core/types";
import { EFFORTS } from "../../../../core/types";
import { api, type AgentDraft } from "../../api";
import { navigate } from "../../App";
import { AgentAvatar, Button, ErrorText, Field, inputClass, modelsFor, ProviderSelect, RunStatusBadge, timeAgo, useAction } from "../ui";
import { TriggersEditor } from "./TriggersEditor";
import { agentAccess } from "../../../../core/agent-access";
import { IssuePicker } from "../IssuePicker";

const PERMISSIONS = [
  { value: "acceptEdits", label: "Edit files freely, ask before shell commands" },
  { value: "ask", label: "Ask before every edit and command" },
  { value: "bypassPermissions", label: "Never ask (full access on this machine)" },
] as const;

function toDraft(a: Agent): AgentDraft {
  return {
    name: a.name,
    description: a.description,
    color: a.color,
    icon: a.icon ?? null,
    prompt: a.prompt,
    provider: a.provider,
    model: a.model,
    effort: a.effort,
    permissionMode: a.permissionMode,
    projectId: a.projectId,
    triggers: a.triggers as TriggerInput[],
    visibility: a.visibility,
    publicAccess: a.publicAccess ?? "view",
    monthlyBudgetUsd: a.monthlyBudgetUsd ?? null,
  };
}

function CopyButton({ agent }: { agent: Agent }) {
  const action = useAction();
  return (
    <>
      <Button
        disabled={action.busy}
        title="Make your own private, disabled copy"
        onClick={() =>
          action.run(async () => {
            const copy = await api.copyAgent(agent.id);
            navigate("agents", copy.id);
          })
        }
      >
        Copy
      </Button>
      <ErrorText>{action.error}</ErrorText>
    </>
  );
}

function RunNow({ agent, snapshot }: { agent: Agent; snapshot: Snapshot }) {
  const [issueId, setIssueId] = useState("");
  const [note, setNote] = useState("");
  const action = useAction();
  return (
    <div className="space-y-2 rounded-lg bg-zinc-900 p-3 ring-1 ring-zinc-800">
      <p className="text-sm font-medium">Run now</p>
      <IssuePicker issues={snapshot.issues} value={issueId || null} none="No issue (general task)" onChange={(id) => setIssueId(id ?? "")} />
      <textarea className={`${inputClass} min-h-14`} placeholder="Optional instructions for this run" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={action.busy} onClick={() => action.run(() => api.runAgent(agent.id, { issueId: issueId || null, note }))}>
          Start run
        </Button>
        {!agent.enabled && <span className="text-xs text-amber-300">Queued runs start once the agent is enabled.</span>}
      </div>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

export function AgentEditor({ agent, snapshot }: { agent: Agent; snapshot: Snapshot }) {
  const [draft, setDraft] = useState<AgentDraft>(() => toDraft(agent));
  const [tab, setTab] = useState<"settings" | "runs">("settings");
  const action = useAction();
  useEffect(() => setDraft(toDraft(agent)), [agent.updatedAt]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(agent));
  const set = (patch: AgentDraft) => setDraft((d) => ({ ...d, ...patch }));
  const runs = snapshot.runs.filter((r) => r.agentId === agent.id);
  const access = agentAccess(agent, snapshot.viewer);
  const owner = snapshot.members.find((m) => m.id === agent.ownerId);
  const ownerLabel = agent.ownerId === snapshot.viewer.memberId ? "you" : (owner?.name ?? "a former member");

  if (!access.read) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <header className="flex items-center gap-3">
          <AgentAvatar agent={agent} size="size-9" />
          <h1 className="truncate text-lg font-semibold">{agent.name}</h1>
        </header>
        <p className="text-sm text-zinc-400">{agent.description}</p>
        <p className="text-sm text-zinc-500">This is {ownerLabel}'s private agent. Its instructions and triggers are only visible to them.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <AgentAvatar agent={{ name: draft.name || "?", color: draft.color ?? agent.color, icon: draft.icon }} size="size-9" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{agent.name}</h1>
          <p className="text-xs text-zinc-500">
            {agent.visibility === "public" ? "Public" : "Private"} agent owned by {ownerLabel}. {agent.enabled ? "Enabled: triggers fire and assigned work runs." : "Disabled: nothing fires until it is enabled."}
          </p>
        </div>
        <CopyButton agent={agent} />
        {access.manage && (
          <>
            <Button variant={agent.enabled ? "secondary" : "primary"} disabled={action.busy} onClick={() => action.run(() => api.setAgentEnabled(agent.id, !agent.enabled))}>
              {agent.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (confirm(`Delete the ${agent.name} agent?`) && (await action.run(() => api.deleteAgent(agent.id)))) navigate("agents");
              }}
            >
              Delete
            </Button>
          </>
        )}
      </header>
      {!access.manage && <p className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-400">You can read this public agent and copy it, but only {ownerLabel} or an admin can change or run it.</p>}
      <ErrorText>{action.error}</ErrorText>

      <nav className="flex gap-4 border-b border-zinc-900 text-sm">
        {(["settings", "runs"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 pb-2 capitalize ${tab === t ? "border-violet-500" : "border-transparent text-zinc-500"}`}>
            {t === "runs" ? `Runs (${runs.length})` : t}
          </button>
        ))}
      </nav>

      {tab === "settings" && (
        <fieldset disabled={!access.manage} className="space-y-5">
          <Field label="Visibility" hint="Public agents can be read and copied by the whole team; they still run with their owner's setup.">
            <select className={inputClass} value={draft.visibility} disabled={agent.ownerId !== snapshot.viewer.memberId && agent.visibility === "public"} onChange={(e) => set({ visibility: e.target.value as Agent["visibility"] })}>
              <option value="private">Private: only you</option>
              <option value="public">Public: the whole team</option>
            </select>
          </Field>
          {draft.visibility === "public" && (
            <Field label="Teammates can" hint="Editors can change its instructions and settings; running it, deleting it, and changing who may edit stay with its owner and admins.">
              <select className={inputClass} value={draft.publicAccess ?? "view"} disabled={!access.own} onChange={(e) => set({ publicAccess: e.target.value as NonNullable<Agent["publicAccess"]> })}>
                <option value="view">View and copy</option>
                <option value="edit">Edit</option>
              </select>
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
            <Field label="Name">
              <input className={inputClass} value={draft.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Color">
              <input type="color" className="h-8 w-full rounded bg-zinc-900" value={draft.color} onChange={(e) => set({ color: e.target.value })} />
            </Field>
          </div>
          <Field label="Icon">
            <div className="flex flex-wrap gap-1">
              <button type="button" onClick={() => set({ icon: null })} className={`rounded-md p-0.5 ring-1 ${!draft.icon ? "ring-violet-500" : "ring-transparent hover:ring-zinc-700"}`} title="Initial">
                <AgentAvatar agent={{ name: draft.name || "?", color: draft.color ?? agent.color }} size="size-6" />
              </button>
              {AGENT_ICON_NAMES.map((icon) => (
                <button type="button" key={icon} onClick={() => set({ icon })} className={`rounded-md p-0.5 ring-1 ${draft.icon === icon ? "ring-violet-500" : "ring-transparent hover:ring-zinc-700"}`} title={icon}>
                  <AgentAvatar agent={{ name: icon, color: draft.color ?? agent.color, icon }} size="size-6" />
                </button>
              ))}
            </div>
          </Field>
          <Field label="Description" hint="Teammates (and other agents) see this when deciding who to hand work to.">
            <input className={inputClass} value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field label="Instructions" hint="What this agent does in the pipeline. Board rules (gates, handoffs, short comments) are added automatically.">
            <textarea className={`${inputClass} min-h-72 font-mono text-xs leading-5`} value={draft.prompt ?? ""} onChange={(e) => set({ prompt: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Harness">
              <ProviderSelect snapshot={snapshot} value={draft.provider ?? agent.provider} onChange={(provider) => set({ provider, model: provider === agent.provider ? agent.model : provider === "claude-code" ? "claude-opus-5-5" : "default" })} />
            </Field>
            <Field label="Model">
              <select className={inputClass} value={draft.model} onChange={(e) => set({ model: e.target.value })}>
                {modelsFor(snapshot, draft.provider ?? agent.provider, draft.model).map((m) => (
                  <option key={m} value={m}>
                    {m === "default" ? "Harness default" : m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Effort">
              <select className={inputClass} value={draft.effort} onChange={(e) => set({ effort: e.target.value as Agent["effort"] })}>
                {EFFORTS.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </Field>
            <Field label="Default project">
              <select className={inputClass} value={draft.projectId ?? ""} onChange={(e) => set({ projectId: e.target.value || null })}>
                <option value="">The issue's project</option>
                {snapshot.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Monthly budget (USD)" hint="This agent stops taking work when its spend this month reaches this. Empty for no limit (the organization's budget still applies).">
            <input className={`${inputClass} w-40`} type="number" min={0} placeholder="No limit" value={draft.monthlyBudgetUsd ?? ""} onChange={(e) => set({ monthlyBudgetUsd: e.target.value === "" ? null : Number(e.target.value) })} />
          </Field>
          <Field label="Permissions">
            <select className={inputClass} value={draft.permissionMode} onChange={(e) => set({ permissionMode: e.target.value as Agent["permissionMode"] })}>
              {PERMISSIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-zinc-400">Triggers</h2>
            <TriggersEditor triggers={draft.triggers ?? []} onChange={(triggers) => set({ triggers })} snapshot={snapshot} agentId={agent.id} />
          </section>
          {access.manage && (
            <>
              <div className="sticky bottom-0 flex items-center gap-2 border-t border-zinc-900 bg-zinc-950 py-3">
                <Button variant="primary" disabled={!dirty || action.busy} onClick={() => action.run(() => api.updateAgent(agent.id, draft))}>
                  Save changes
                </Button>
                {dirty && (
                  <Button variant="ghost" onClick={() => setDraft(toDraft(agent))}>
                    Discard
                  </Button>
                )}
              </div>
              <RunNow agent={agent} snapshot={snapshot} />
            </>
          )}
        </fieldset>
      )}

      {tab === "runs" && (
        <div className="space-y-2">
          {runs.length === 0 && <p className="text-sm text-zinc-500">No runs yet.</p>}
          {runs.some((r) => r.status === "queued") && (
            <Button className="py-1! text-xs" onClick={() => void api.cancelQueuedRuns(agent.id)}>
              Cancel {runs.filter((r) => r.status === "queued").length} queued
            </Button>
          )}
          {runs.map((run) => {
            const issue = snapshot.issues.find((i) => i.id === run.issueId);
            return (
              <div key={run.id} className="space-y-1 rounded-lg bg-zinc-900 p-3 ring-1 ring-zinc-800">
                <div className="flex items-center gap-2 text-sm">
                  <RunStatusBadge status={run.status} />
                  <span className="truncate">{issue ? `${issue.key} ${issue.title}` : run.trigger.replace(/_/g, " ")}</span>
                  <span className="ml-auto shrink-0 text-xs text-zinc-500">{timeAgo(run.createdAt)}</span>
                  {run.chatId && (
                    <a href={`#/chats/${run.chatId}`} className="shrink-0 text-xs text-violet-300 hover:underline">
                      Open chat
                    </a>
                  )}
                  {(run.status === "failed" || run.status === "cancelled") && (
                    <button className="shrink-0 text-xs text-violet-300 hover:underline" onClick={() => void api.retryRun(run.id)}>
                      Retry
                    </button>
                  )}
                </div>
                {run.summary && <p className="line-clamp-3 text-xs whitespace-pre-wrap text-zinc-400">{run.summary}</p>}
                {run.error && <p className="text-xs text-red-400">{run.error}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
