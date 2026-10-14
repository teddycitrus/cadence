import { useEffect, useState } from "react";
import { navigate } from "../../App";
import { api, type GitFile, type GitOverview, type RepoState } from "../../api";
import { DiffBlock } from "../chat/ChangesPanel";
import { Button, ErrorText, inputClass, useAction } from "../ui";
import { GitExtras } from "./GitExtras";
import { PrPanel } from "./PrPanel";
import { FileList, FileListControls, useFilePrefs } from "./FileList";
import { useRepoReload } from "./useRepoReload";

const STATUS_STYLE: Record<string, string> = { A: "text-emerald-400", M: "text-amber-300", D: "text-red-400", R: "text-sky-400", "?": "text-emerald-400", U: "text-red-400" };
const STATUS_LABEL: Record<string, string> = { "?": "U", U: "!" };

type HunkMode = "stage" | "unstage" | "discard";

function FileRow({ ws, file, staged, version, onAction, onHunk }: { ws: string; file: GitFile; staged: boolean; version: string; onAction: (action: string, paths: string[]) => void; onHunk: (path: string, hunk: number, mode: HunkMode) => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [hunks, setHunks] = useState<{ header: string; text: string }[] | null>(null);
  // Tracked files show hunk by hunk so parts of a file can be staged.
  const byHunk = file.status !== "?" && file.status !== "U";
  const load = () =>
    byHunk
      ? api.gitHunks(ws, file.path, staged).then((d) => (setHunks(d.hunks), setDiff("")), () => setDiff(""))
      : api.gitFileDiff(ws, file.path, staged).then((d) => setDiff(d.diff), () => setDiff(""));
  const toggle = () => (diff === null ? load() : (setDiff(null), setHunks(null)));
  useEffect(() => {
    if (diff !== null) void load();
  }, [version]);
  const name = file.path.split("/").pop();
  const dir = file.path.slice(0, file.path.length - (name?.length ?? 0));
  return (
    <li>
      <div className={`group flex items-center gap-2 px-3 py-0.5 text-xs hover:bg-zinc-900 ${diff !== null ? "bg-zinc-900" : ""}`}>
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => void toggle()} title={file.path}>
          <span className="truncate text-zinc-200">{name}</span>
          <span className="truncate text-[11px] text-zinc-600">{dir}</span>
        </button>
        <span className="hidden shrink-0 gap-1.5 group-hover:flex">
          {!staged && file.status !== "U" && (
            <button className="text-zinc-500 hover:text-red-400" title="Discard changes" onClick={() => confirm(`Discard changes to ${file.path}? This cannot be undone.`) && onAction("discard", [file.path])}>
              ↺
            </button>
          )}
          <button className="text-zinc-400 hover:text-zinc-100" title={staged ? "Unstage" : "Stage"} onClick={() => onAction(staged ? "unstage" : "stage", [file.path])}>
            {staged ? "−" : "+"}
          </button>
        </span>
        <span className={`w-3 shrink-0 text-center font-mono ${STATUS_STYLE[file.status] ?? "text-zinc-400"}`}>{STATUS_LABEL[file.status] ?? file.status}</span>
      </div>
      {diff !== null &&
        (hunks ? (
          hunks.map((h, i) => (
            <div key={`${i}${h.header}`} className="border-t border-zinc-800/60">
              <div className="flex items-center justify-between px-2 pt-1 font-mono text-[10px] text-sky-400/80">
                <span className="truncate">{h.header}</span>
                <span className="flex shrink-0 gap-1">
                  {!staged && (
                    <button className="rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" title="Throw away this change in the file" onClick={() => confirm("Discard this change? It cannot be undone.") && onHunk(file.path, i, "discard")}>
                      Discard
                    </button>
                  )}
                  <button className="rounded px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => onHunk(file.path, i, staged ? "unstage" : "stage")}>
                    {staged ? "Unstage hunk" : "Stage hunk"}
                  </button>
                </span>
              </div>
              <DiffBlock diff={h.text.split("\n").slice(1).join("\n")} />
            </div>
          ))
        ) : (
          <DiffBlock diff={diff} />
        ))}
    </li>
  );
}

function Section({ title, count, actions, children }: { title: string; count: number; actions?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  if (!count) return null;
  return (
    <section>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <button className="flex-1 text-left text-[11px] font-medium tracking-wide text-zinc-500 uppercase" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {title} <span className="ml-1 rounded bg-zinc-800 px-1 text-zinc-400">{count}</span>
        </button>
        {actions}
      </div>
      {open && <ul>{children}</ul>}
    </section>
  );
}

/** The source-control panel: stage, commit, sync, branches, and the workspace's pull request. */
export function SourceControl({ workspaceId, chatIds }: { workspaceId: string; chatIds: ReadonlySet<string> }) {
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [prefs, setPrefs] = useFilePrefs();
  const action = useAction();
  const drafting = useAction();

  const load = () => api.git(workspaceId).then(setOverview, (e: Error) => action.setError(e.message));
  useEffect(() => {
    void load();
  }, [workspaceId]);
  // An agent in this workspace editing files or running git changes the repo under us.
  useRepoReload(load, chatIds);

  const run = (name: string, body: Record<string, unknown> = {}) =>
    action.run(async () => {
      const state: RepoState = await api.gitAction(workspaceId, name, body);
      setOverview((o) => (o ? { ...o, state } : o));
      void load();
    });
  const onFile = (name: string, paths: string[]) => void run(name, { paths });
  const onHunk = (path: string, hunk: number, mode: HunkMode) => void (mode === "discard" ? run("discard-hunk", { path, hunk }) : run("stage-hunk", { path, hunk, unstage: mode === "unstage" }));

  if (!overview) return <div className="p-4 text-sm text-zinc-500">{action.error ?? "Loading..."}</div>;
  const { state } = overview;
  const changes = state.staged.length + state.unstaged.length + state.conflicted.length;
  // Open diffs reload whenever the repository changes.
  const stamp = JSON.stringify([state.staged, state.unstaged, state.headSha]);
  const commitAll = state.staged.length === 0;

  const commit = (sync = false) =>
    action.run(async () => {
      const s = await api.gitAction(workspaceId, "commit", { message, amend, signoff, all: commitAll, sync });
      setOverview((o) => (o ? { ...o, state: s } : o));
      setMessage("");
      setAmend(false);
      void load();
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="space-y-2 border-b border-zinc-900 p-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="truncate font-mono text-zinc-200" title="Current branch">
            {state.branch ?? `detached at ${state.headSha?.slice(0, 7)}`}
          </span>
          {state.upstream ? (
            <span className="shrink-0 whitespace-nowrap text-zinc-500" title={`Tracking ${state.upstream}`}>
              ↑{state.ahead} ↓{state.behind}
            </span>
          ) : (
            <span className="shrink-0 whitespace-nowrap text-zinc-600">not published</span>
          )}
          <span className="ml-auto flex gap-1">
            <Button variant="ghost" className="px-1.5! py-0.5! text-xs" disabled={action.busy} onClick={() => void run("fetch")} title="Fetch from all remotes">
              Fetch
            </Button>
            {state.upstream && (
              <Button variant="ghost" className="px-1.5! py-0.5! text-xs" disabled={action.busy} onClick={() => void run("pull")}>
                Pull
              </Button>
            )}
            <Button variant="ghost" className="px-1.5! py-0.5! text-xs" disabled={action.busy || !state.branch} onClick={() => void run("push")}>
              {state.upstream ? "Push" : "Publish"}
            </Button>
            <select
              className="rounded bg-transparent px-1 text-xs text-zinc-400 hover:text-zinc-100"
              value=""
              title="Have an agent review this branch's changes; it reports findings in a new chat"
              onChange={(e) => e.target.value && void action.run(async () => navigate("chats", (await api.reviewBranch(workspaceId, e.target.value === "deep")).chatId))}
            >
              <option value="">Review...</option>
              <option value="quick">Review these changes</option>
              <option value="deep">Review thoroughly</option>
            </select>
          </span>
        </div>
        {state.operation && (
          <div className="flex items-center gap-2 rounded-md bg-amber-950/40 px-2 py-1.5 text-xs text-amber-200 ring-1 ring-amber-900">
            <span className="flex-1">
              A {state.operation} is in progress{state.conflicted.length ? ` with ${state.conflicted.length} conflicted file${state.conflicted.length === 1 ? "" : "s"}` : ""}. Resolve and commit, or abort.
            </span>
            <button className="underline" onClick={() => void run("abort")}>
              Abort
            </button>
          </div>
        )}
        <textarea
          className={`${inputClass} min-h-16 font-mono text-xs`}
          placeholder={amend ? "Leave empty to keep the last message" : `Message (commits ${commitAll ? "all changes" : "staged changes"})`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (message.trim() || amend)) void commit();
          }}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <Button variant="primary" className="py-1! text-xs" disabled={action.busy || (!message.trim() && !amend) || (!changes && !amend)} onClick={() => void commit()}>
            {amend ? "Amend" : "Commit"}
          </Button>
          {state.upstream && !amend && (
            <Button className="py-1! text-xs" disabled={action.busy || !message.trim() || !changes} title="Commit, pull with rebase, and push" onClick={() => void commit(true)}>
              Commit & sync
            </Button>
          )}
          <Button
            variant="ghost"
            className="py-1! text-xs"
            disabled={drafting.busy || !changes}
            title="Draft a message from the diff with AI"
            onClick={() => drafting.run(async () => setMessage((await api.commitMessage(workspaceId)).message))}
          >
            {drafting.busy ? "Writing..." : "✦ Generate"}
          </Button>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend
          </label>
          <label className="flex items-center gap-1" title="Add a Signed-off-by trailer">
            <input type="checkbox" checked={signoff} onChange={(e) => setSignoff(e.target.checked)} /> Sign off
          </label>
        </div>
        <ErrorText>{action.error ?? drafting.error}</ErrorText>
      </div>

      <div className="py-1">
        {changes && <FileListControls prefs={prefs} onChange={setPrefs} />}
        <Section title="Conflicts" count={state.conflicted.length}>
          <FileList files={state.conflicted} prefs={prefs} row={(f) => <FileRow key={f.path} ws={workspaceId} file={f} staged={false} onAction={onFile} onHunk={onHunk} version={stamp} />} />
        </Section>
        <Section
          title="Staged"
          count={state.staged.length}
          actions={
            <button className="text-[11px] text-zinc-500 hover:text-zinc-100" onClick={() => void run("unstage-all")}>
              Unstage all
            </button>
          }
        >
          <FileList files={state.staged} prefs={prefs} row={(f) => <FileRow key={f.path} ws={workspaceId} file={f} staged onAction={onFile} onHunk={onHunk} version={stamp} />} />
        </Section>
        <Section
          title="Changes"
          count={state.unstaged.length}
          actions={
            <span className="flex gap-2">
              <button className="text-[11px] text-zinc-500 hover:text-red-400" onClick={() => confirm("Discard every uncommitted change, including new files? This cannot be undone.") && void run("discard-all")}>
                Discard all
              </button>
              <button className="text-[11px] text-zinc-500 hover:text-zinc-100" onClick={() => void run("stage-all")}>
                Stage all
              </button>
            </span>
          }
        >
          <FileList files={state.unstaged} prefs={prefs} row={(f) => <FileRow key={f.path} ws={workspaceId} file={f} staged={false} onAction={onFile} onHunk={onHunk} version={stamp} />} />
        </Section>
        {!changes && <p className="px-3 py-2 text-xs text-zinc-500">Working tree clean.</p>}
      </div>

      <PrPanel workspaceId={workspaceId} state={state} lastSubject={overview.log[0]?.subject ?? ""} />
      <GitExtras workspaceId={workspaceId} overview={overview} run={run} busy={action.busy} />
    </div>
  );
}
