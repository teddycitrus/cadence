import { useEffect, useState } from "react";
import type { Snapshot } from "../../../../core/types";
import { api, type TemplateSummary } from "../../api";
import { navigate } from "../../App";
import { AgentAvatar, Button, ErrorText, inputClass, useAction } from "../ui";
import { AgentEditor } from "./AgentEditor";

const TRIGGER_LABEL: Record<string, string> = {
  assigned: "Given to this agent",
  issue_created: "New issue",
  issue_moved: "Stage change",
  label_added: "Label added",
  issue_commented: "Comment",
  schedule: "Schedule",
  webhook: "Webhook",
  github: "GitHub",
};

function Landing({ snapshot }: { snapshot: Snapshot }) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const action = useAction();
  useEffect(() => {
    api.templates().then(setTemplates, () => setTemplates([]));
  }, []);
  const create = (fn: () => Promise<{ id: string }>) =>
    action.run(async () => {
      const agent = await fn();
      navigate("agents", agent.id);
    });

  return (
    <div className="mx-auto max-w-5xl space-y-10 p-8">
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Give every human a team of agents</h1>
        <p className="max-w-2xl text-zinc-400">
          Agents are teammates you set up once. Assign them issues, or let them start on their own when something happens: an issue is filed or moved, a label is added, a schedule ticks, or another tool calls their webhook. They work in parallel on their own branches and stop at the sign-off stages.
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => create(() => api.createAgent({ name: `Agent ${snapshot.agents.length + 1}`, prompt: "Describe what this agent does." }))}>
            New agent
          </Button>
        </div>
        <ErrorText>{action.error}</ErrorText>
      </section>
      <section>
        <h2 className="mb-1 text-sm font-semibold">Templates</h2>
        <p className="mb-3 text-sm text-zinc-500">A starting pipeline. Picking one fills in the editor; nothing runs until you review and enable it.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <button key={t.id} onClick={() => create(() => api.agentFromTemplate(t.id))} className="flex flex-col gap-2 rounded-xl bg-zinc-900 p-4 text-left ring-1 ring-zinc-800 transition hover:ring-zinc-600">
              <span className="flex items-center gap-2">
                <AgentAvatar agent={t} size="size-6" />
                <span className="font-medium">{t.name}</span>
              </span>
              <span className="text-sm text-zinc-400">{t.description}</span>
              <span className="mt-auto flex flex-wrap gap-1 pt-1">
                {t.triggers.map((tr, i) => (
                  <span key={i} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                    {TRIGGER_LABEL[tr.kind]}
                  </span>
                ))}
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500">effort {t.effort}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function AgentsView({ snapshot, selected }: { snapshot: Snapshot; selected: string | null }) {
  const [query, setQuery] = useState("");
  const agent = selected ? snapshot.agents.find((a) => a.id === selected) : undefined;
  const agents = snapshot.agents.filter((a) => a.name.toLowerCase().includes(query.toLowerCase()));
  const me = snapshot.viewer.memberId;
  const groups = [
    { label: "Yours", agents: agents.filter((a) => a.ownerId === me) },
    { label: "Shared with the team", agents: agents.filter((a) => a.ownerId !== me && a.visibility === "public") },
    { label: "Teammates' private agents", agents: agents.filter((a) => a.ownerId !== me && a.visibility === "private") },
  ];

  return (
    <div className="flex h-full">
      <aside data-sidebar-pane className="flex w-64 shrink-0 flex-col border-r border-zinc-900">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="font-semibold">Agents</h2>
          <a href="#/agents" className="text-lg leading-none text-zinc-500 hover:text-zinc-100" title="New agent or template">
            +
          </a>
        </div>
        <div className="px-3 pb-2">
          <input className={inputClass} placeholder="Search agents" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {(() => {
          // Runs of my agents that failed in the last day, newest first, so nothing fails quietly.
          const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
          const failed = snapshot.runs.filter((r) => r.status === "failed" && r.createdAt >= dayAgo && snapshot.agents.find((a) => a.id === r.agentId)?.ownerId === me);
          if (!failed.length) return null;
          return (
            <div className="mx-3 mb-2 space-y-1 rounded-lg bg-red-950/40 p-2 text-xs ring-1 ring-red-900">
              <p className="font-medium text-red-300">{failed.length} run{failed.length === 1 ? "" : "s"} failed in the last day</p>
              {failed.slice(0, 4).map((r) => (
                <p key={r.id} className="flex items-center gap-2">
                  <a className="min-w-0 flex-1 truncate text-zinc-300 hover:underline" href={`#/agents/${r.agentId}`} title={r.error ?? undefined}>
                    {snapshot.agents.find((a) => a.id === r.agentId)?.name}: {r.error ?? "failed"}
                  </a>
                  <button className="shrink-0 text-violet-300 hover:underline" onClick={() => void api.retryRun(r.id)}>
                    Retry
                  </button>
                </p>
              ))}
            </div>
          );
        })()}
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2">
          {groups.map(
            (g) =>
              g.agents.length > 0 && (
                <li key={g.label}>
                  <p className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{g.label}</p>
                  <ul className="space-y-0.5">
                    {g.agents.map((a) => {
                      const runs = snapshot.runs.filter((r) => r.agentId === a.id);
                      const busy = runs.filter((r) => r.status === "running").length;
                      const queued = runs.filter((r) => r.status === "queued").length;
                      return (
                        <li key={a.id}>
                          <a href={`#/agents/${a.id}`} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${a.id === selected ? "bg-zinc-800" : "hover:bg-zinc-900"}`}>
                            <AgentAvatar agent={a} />
                            <span className={`truncate ${a.enabled ? "" : "text-zinc-500"}`}>{a.name}</span>
                            <span className="ml-auto text-xs text-zinc-500">
                              {busy > 0 && <span className="text-violet-300">{busy} running</span>}
                              {busy === 0 && queued > 0 && `${queued} queued`}
                              {!a.enabled && "off"}
                            </span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ),
          )}
          {snapshot.agents.length === 0 && <li className="px-2 py-6 text-center text-sm text-zinc-500">No agents yet</li>}
        </ul>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">{agent ? <AgentEditor key={agent.id} agent={agent} snapshot={snapshot} /> : <Landing snapshot={snapshot} />}</div>
    </div>
  );
}
