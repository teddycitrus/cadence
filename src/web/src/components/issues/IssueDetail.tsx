import { useEffect, useRef, useState } from "react";
import type { Snapshot, Comment, IssueDetail as IssueDetailData, StoredEvent } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { useLive } from "../../live";
import { DiffView } from "../DiffView";
import { Viewers } from "../Viewers";
import { ShareButton } from "../share/ShareButton";
import { CommentCard } from "./CommentCard";
import { PrDetails } from "../git/PrPanel";
import { Markdown } from "../Markdown";
import { actorName, Button, ErrorText, inputClass, timeAgo, useAction } from "../ui";
import { IssueProperties } from "./IssueProperties";
import { RunRow, WorkspacesSection } from "./IssueWork";

type Tab = "activity" | "runs" | "links" | "diff";

export function describe(type: string, p: Record<string, unknown>, snapshot: Snapshot): string | null {
  switch (type) {
    case "IssueCreated":
      return "created the issue";
    case "CommentAdded":
      return `commented: ${String(p.body ?? "").slice(0, 120)}`;
    case "IssueMoved":
      return `moved it to ${snapshot.stages.find((s) => s.id === p.to)?.name ?? "a deleted stage"}`;
    case "AssigneeAdded":
    case "AssigneeRemoved": {
      const a = p.assignee as { kind: string; id: string };
      const who = a.kind === "user" ? (a.id === snapshot.viewer.memberId ? "you" : (snapshot.members.find((m) => m.id === a.id)?.name ?? "a former member")) : (snapshot.agents.find((x) => x.id === a.id)?.name ?? "an agent");
      return `${type === "AssigneeAdded" ? "assigned" : "unassigned"} ${who}`;
    }
    case "LabelAdded":
      return `added label ${snapshot.labels.find((l) => l.id === p.labelId)?.name ?? ""}`;
    case "LinkAdded":
      return `linked ${(p.link as { kind: string; title: string }).kind} ${(p.link as { title: string }).title}`;
    case "BranchCreated":
      return `created branch ${p.branch}`;
    case "IssueUpdated":
      return `edited ${Object.keys(p).join(", ")}`;
    default:
      return null;
  }
}

/** Issues opened one after another in this tab, newest last: the trail back. */
const trail: string[] = [];

export function IssueDetail({ issueKey, snapshot, onClose }: { issueKey: string; snapshot: Snapshot; onClose: () => void }) {
  if (trail.at(-1) !== issueKey) {
    const at = trail.indexOf(issueKey);
    if (at >= 0) trail.splice(at + 1);
    else trail.push(issueKey);
    if (trail.length > 20) trail.shift();
  }
  const back = trail.slice(0, -1).slice(-3);
  // Reload only for events about this issue: its own, and its runs, docs, and workspaces
  // (refetching every comment on any board change made long threads slow).
  const shown = useRef<IssueDetailData | null>(null);
  const concerns = (e: StoredEvent) => {
    const d = shown.current;
    if (!d) return true;
    const p = e.payload as { issueId?: string | null };
    if (e.aggregate === "issue") return e.aggregateId === d.issue.id;
    if (e.aggregate === "run") return p.issueId === d.issue.id || d.runs.some((r) => r.id === e.aggregateId);
    if (e.aggregate === "doc") return p.issueId === d.issue.id || d.docs.some((x) => x.id === e.aggregateId);
    if (e.aggregate === "workspace") return p.issueId === d.issue.id || d.workspaces.some((w) => w.id === e.aggregateId);
    return false;
  };
  const { data, error } = useLive(() => api.issue(issueKey), [issueKey], concerns);
  shown.current = data;
  const minute = Math.floor(Date.now() / 60_000);
  const [tab, setTab] = useState<Tab>("activity");
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [link, setLink] = useState("");
  const action = useAction();

  useEffect(() => {
    if (data && !editing) setBody(data.issue.body);
  }, [data?.issue.body]);

  // Opening the issue (or watching it change) marks it read.
  useEffect(() => {
    if (data) void api.markIssueRead(data.issue.id).catch(() => undefined);
  }, [data?.issue.id, data?.issue.updatedAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (error) return <aside className="w-[40rem] border-l border-zinc-900 p-6 text-sm text-red-400">{error}</aside>;
  if (!data) return <aside className="w-[40rem] border-l border-zinc-900" />;
  const { issue } = data;
  const agentName = (id: string) => snapshot.agents.find((a) => a.id === id)?.name;

  const events = [
    ...data.comments.map((c) => ({ seq: c.seq, ts: c.ts, actor: c.author, comment: c as Comment | null, text: null as string | null })),
    ...data.timeline.map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, comment: null as Comment | null, text: describe(e.type, e.payload, snapshot) })).filter((e) => e.text),
  ].sort((a, b) => a.seq - b.seq);

  return (
    <aside className="flex w-[40rem] max-w-[55vw] shrink-0 flex-col border-l border-zinc-900 bg-zinc-950">
      <header className="flex items-center gap-2 border-b border-zinc-900 px-5 py-3 text-sm">
        {back.map((k) => (
          <a key={k} href={`#/issues/${encodeURIComponent(k)}`} className="font-mono text-xs text-zinc-600 hover:text-zinc-300" title={snapshot.issues.find((i) => i.key === k)?.title}>
            {k} /
          </a>
        ))}
        <span className="font-mono text-zinc-500">{issue.key}</span>
        <Viewers place={`issue:${issue.id}`} snapshot={snapshot} />
        <span className="text-xs text-zinc-600">
          by {actorName(issue.createdBy, snapshot)} · {timeAgo(issue.createdAt)}
        </span>
        <span className="ml-auto">
          <ShareButton kind="issue" refId={issue.id} />
        </span>
        <Button onClick={() => void action.run(async () => navigate("issues", (await api.duplicateIssue(issue.id)).key))} title="A copy with the same fields and labels">
          Duplicate
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            if (confirm(`Delete ${issue.key}?`) && (await action.run(() => api.deleteIssue(issue.id)))) onClose();
          }}
        >
          Delete
        </Button>
        <button className="rounded p-1 text-lg leading-none text-zinc-500 hover:bg-zinc-900" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <input
          className="font-display w-full bg-transparent text-2xl focus:outline-none"
          defaultValue={issue.title}
          key={issue.title}
          onBlur={(e) => e.target.value.trim() && e.target.value !== issue.title && action.run(() => api.updateIssue(issue.id, { title: e.target.value }))}
        />
        {issue.autoMove && issue.autoMove.to === issue.stageId && (
          <p className="flex items-center gap-2 rounded-md bg-zinc-900 px-3 py-2 text-xs text-zinc-400 ring-1 ring-zinc-800">
            Moved to {snapshot.stages.find((s) => s.id === issue.autoMove!.to)?.name} when its pull request {issue.autoMove.reason === "pr_merged" ? "merged" : "opened"}.
            <button className="text-violet-300 hover:underline" onClick={() => void api.undoAutoMove(issue.id)}>
              Undo
            </button>
          </p>
        )}
        <IssueProperties issue={issue} snapshot={snapshot} />

        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xs font-medium text-zinc-500">Description</h3>
            {!editing && (
              <Button variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </div>
          {editing ? (
            <div className="space-y-2">
              <textarea className={`${inputClass} min-h-48 font-mono text-xs`} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="primary" onClick={async () => (await action.run(() => api.updateIssue(issue.id, { body }))) && setEditing(false)}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : issue.body ? (
            <Markdown>{issue.body}</Markdown>
          ) : (
            <p className="text-sm text-zinc-600">No description.</p>
          )}
        </section>
        <ErrorText>{action.error}</ErrorText>

        <nav className="flex gap-4 border-b border-zinc-900 text-sm">
          {(["activity", "runs", "links", "diff"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 pb-2 capitalize ${tab === t ? "border-violet-500 text-zinc-100" : "border-transparent text-zinc-500"}`}>
              {t === "runs" ? `Work (${data.runs.length})` : t === "links" ? `Docs & links (${issue.links.length})` : t}
            </button>
          ))}
        </nav>

        {tab === "activity" && (
          <section className="space-y-3">
            {events.map((e) =>
              e.comment ? (
                <CommentCard key={`c${e.seq}`} comment={e.comment} issueId={issue.id} snapshot={snapshot} minute={minute} />
              ) : (
                <div key={`${e.seq}`} className="text-sm">
                  <p className="text-zinc-400">
                    <span className="font-medium text-zinc-200">{actorName(e.actor, snapshot)}</span> {e.text} <span className="text-xs text-zinc-600">{timeAgo(e.ts)}</span>
                  </p>
                </div>
              ),
            )}
            <form
              className="space-y-2"
              onSubmit={async (ev) => {
                ev.preventDefault();
                if (comment.trim() && (await action.run(() => api.comment(issue.id, comment)))) setComment("");
              }}
            >
              <textarea className={`${inputClass} min-h-16`} placeholder="Leave a comment. Agents assigned here read it on their next run." value={comment} onChange={(e) => setComment(e.target.value)} />
              <Button variant="primary" type="submit" disabled={!comment.trim()}>
                Comment
              </Button>
            </form>
          </section>
        )}

        {tab === "runs" && (
          <section className="space-y-4">
            <WorkspacesSection issueId={issue.id} workspaces={data.workspaces} snapshot={snapshot} />
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-zinc-500">Agent runs</h3>
              {data.runs.length === 0 && <p className="text-sm text-zinc-500">No agent has worked on this issue yet. Assign one above.</p>}
              {data.runs.map((run) => (
                <RunRow key={run.id} run={run} agentName={agentName(run.agentId)} />
              ))}
            </div>
          </section>
        )}

        {tab === "links" && (
          <section className="space-y-3">
            {snapshot.pullRequests
              .filter((pr) => pr.issueId === issue.id)
              .map((pr) => (
                <div key={pr.id} className="rounded-lg bg-zinc-900 px-3 py-2 ring-1 ring-zinc-800">
                  <PrDetails pr={pr} />
                </div>
              ))}
            {issue.links.map((l) => (
              <div key={l.id} className="flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm">
                <span className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-400">{l.kind}</span>
                {l.kind === "doc" ? (
                  <a className="truncate text-violet-300 hover:underline" href={`#/docs/${l.ref}`}>
                    {snapshot.docs.find((d) => d.id === l.ref)?.title ?? l.title}
                  </a>
                ) : l.ref.startsWith("http") ? (
                  <a className="truncate text-violet-300 hover:underline" href={l.ref} target="_blank" rel="noreferrer">
                    {l.title}
                  </a>
                ) : (
                  <span className="truncate">{l.title}</span>
                )}
                <button className="ml-auto text-xs text-zinc-500 hover:text-red-400" onClick={() => action.run(() => api.removeLink(issue.id, l.id))}>
                  Remove
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input className={inputClass} placeholder="Paste a PR or any URL" value={link} onChange={(e) => setLink(e.target.value)} />
              <Button
                disabled={!link.trim()}
                onClick={async () => {
                  const kind = /\/pull\/\d+/.test(link) ? "pr" : "url";
                  if (await action.run(() => api.addLink(issue.id, { kind, ref: link.trim() }))) setLink("");
                }}
              >
                Link
              </Button>
              <Button
                onClick={async () => {
                  let docId = "";
                  if (await action.run(async () => (docId = (await api.createDoc({ title: `${issue.key} spec`, issueId: issue.id })).id))) navigate("docs", docId);
                }}
              >
                New doc
              </Button>
            </div>
          </section>
        )}

        {tab === "diff" && <DiffView issueId={issue.id} version={`${issue.updatedAt}`} />}
      </div>
    </aside>
  );
}
