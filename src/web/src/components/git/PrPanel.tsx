import { useEffect, useState } from "react";
import type { PullRequest } from "../../../../core/types";
import { api, type RepoState } from "../../api";
import { useDomainEvents } from "../../live";
import { Button, ErrorText, inputClass, useAction } from "../ui";

const CHECKS: Record<PullRequest["checks"], { label: string; cls: string }> = {
  none: { label: "No checks", cls: "text-zinc-500" },
  pending: { label: "Checks running", cls: "text-amber-300" },
  success: { label: "Checks passed", cls: "text-emerald-400" },
  failure: { label: "Checks failed", cls: "text-red-400" },
};

const REVIEW: Record<PullRequest["review"], { label: string; cls: string }> = {
  none: { label: "No reviews", cls: "text-zinc-500" },
  approved: { label: "Approved", cls: "text-emerald-400" },
  changes_requested: { label: "Changes requested", cls: "text-red-400" },
  commented: { label: "Reviewed", cls: "text-sky-300" },
};

/** A compact state pill, shared with issue views. */
export function PrBadge({ pr, link = true }: { pr: PullRequest; link?: boolean }) {
  const state = pr.merged ? { label: "Merged", cls: "bg-violet-950 text-violet-300" } : pr.state === "closed" ? { label: "Closed", cls: "bg-red-950 text-red-300" } : pr.draft ? { label: "Draft", cls: "bg-zinc-800 text-zinc-300" } : { label: "Open", cls: "bg-emerald-950 text-emerald-300" };
  const body = (
    <>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${state.cls}`}>{state.label}</span>
      <span className="text-zinc-300">#{pr.number}</span>
      {!pr.merged && pr.state === "open" && (
        <span className={CHECKS[pr.checks].cls} title={`${CHECKS[pr.checks].label} · ${REVIEW[pr.review].label}`}>
          ●
        </span>
      )}
    </>
  );
  return link ? (
    <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs hover:underline" title={pr.title}>
      {body}
    </a>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs" title={pr.title}>
      {body}
    </span>
  );
}

export function PrDetails({ pr }: { pr: PullRequest }) {
  const action = useAction();
  const failing = pr.checkRuns.filter((r) => r.conclusion && !["success", "skipped", "neutral"].includes(r.conclusion));
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex items-center gap-2">
        <PrBadge pr={pr} />
        <span className="min-w-0 flex-1 truncate text-zinc-300">{pr.title}</span>
        <button className="text-zinc-500 hover:text-zinc-100" disabled={action.busy} onClick={() => action.run(() => api.refreshPr(pr.id))} title="Refresh from GitHub">
          {action.busy ? "..." : "↻"}
        </button>
      </div>
      <p className="flex gap-3">
        <span className={CHECKS[pr.checks].cls}>{CHECKS[pr.checks].label}</span>
        <span className={REVIEW[pr.review].cls}>{REVIEW[pr.review].label}</span>
      </p>
      {pr.checkRuns.length > 0 && (
        <ul className="space-y-0.5">
          {pr.checkRuns.map((r) => (
            <li key={r.name} className="flex items-center gap-1.5 text-zinc-400">
              <span className={r.status !== "completed" ? "text-amber-300" : failing.includes(r) ? "text-red-400" : "text-emerald-400"}>{r.status !== "completed" ? "○" : failing.includes(r) ? "✕" : "✓"}</span>
              {r.url ? (
                <a className="truncate hover:underline" href={r.url} target="_blank" rel="noreferrer">
                  {r.name}
                </a>
              ) : (
                <span className="truncate">{r.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {pr.error && <p className="text-amber-300">Could not refresh: {pr.error}</p>}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

/** The workspace's pull request, or a form to open one. */
export function PrPanel({ workspaceId, state, lastSubject }: { workspaceId: string; state: RepoState; lastSubject: string }) {
  const [pr, setPr] = useState<PullRequest | null | undefined>(undefined);
  const [form, setForm] = useState<{ title: string; body: string; draft: boolean } | null>(null);
  const [github, setGithub] = useState<boolean | null>(null);
  const action = useAction();

  const load = () => api.workspacePr(workspaceId).then((r) => setPr(r.pullRequest), () => setPr(null));
  useEffect(() => {
    void load();
    api.github().then((g) => setGithub(g.connected), () => setGithub(false));
  }, [workspaceId]);
  useDomainEvents((e) => {
    if (e.aggregate === "pr") void load();
  });

  return (
    <section className="space-y-2 border-t border-zinc-900 p-3">
      <p className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Pull request</p>
      {pr ? (
        <PrDetails pr={pr} />
      ) : github === false ? (
        <p className="text-xs text-zinc-500">
          Connect GitHub in <a className="text-violet-300 hover:underline" href="#/settings">Settings</a> to open pull requests and follow their checks.
        </p>
      ) : form ? (
        <div className="space-y-1.5">
          <input className={`${inputClass} text-xs`} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" />
          <textarea className={`${inputClass} min-h-20 text-xs`} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="What changed and how it was tested" />
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <Button
              variant="primary"
              className="py-1! text-xs"
              disabled={action.busy || !form.title.trim()}
              onClick={() =>
                action.run(async () => {
                  setPr(await api.openPr(workspaceId, form));
                  setForm(null);
                })
              }
            >
              {action.busy ? "Pushing..." : "Create pull request"}
            </Button>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={form.draft} onChange={(e) => setForm({ ...form, draft: e.target.checked })} /> Draft
            </label>
            <button className="ml-auto text-zinc-500 hover:text-zinc-100" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <Button className="py-1! text-xs" disabled={!state.branch || pr === undefined} onClick={() => setForm({ title: lastSubject, body: "", draft: false })}>
            Open pull request
          </Button>
          {(state.staged.length > 0 || state.unstaged.length > 0) && <p className="text-[11px] text-zinc-500">Commit your changes first; the branch is pushed when the PR opens.</p>}
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}
