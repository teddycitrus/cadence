import { useEffect, useState } from "react";
import { api, type WorkspaceStatus } from "../../api";
import { foldDiff } from "./diff-fold";
import { useRepoReload } from "../git/useRepoReload";

const STATUS_STYLE: Record<string, string> = { A: "text-emerald-400", M: "text-amber-300", D: "text-red-400", R: "text-sky-400" };

const lineClass = (line: string) =>
  line.startsWith("+") && !line.startsWith("+++")
    ? "bg-emerald-950/50 text-emerald-300"
    : line.startsWith("-") && !line.startsWith("---")
      ? "bg-red-950/50 text-red-300"
      : line.startsWith("@@")
        ? "text-sky-400"
        : "text-zinc-500";

/** A colored unified diff; long unchanged stretches fold away until clicked. */
export function DiffBlock({ diff }: { diff: string }) {
  const [opened, setOpened] = useState<Set<number>>(new Set());
  useEffect(() => setOpened(new Set()), [diff]);
  if (!diff) return <p className="p-3 text-xs text-zinc-500">No differences.</p>;
  return (
    <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-4">
      {foldDiff(diff).map((part) =>
        part.kind === "fold" && !opened.has(part.start) ? (
          <button key={part.start} className="block w-full bg-zinc-900/60 px-1 text-left text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" onClick={() => setOpened((s) => new Set(s).add(part.start))}>
            ... {part.lines.length} unchanged lines
          </button>
        ) : (
          part.lines.map((line, i) => (
            <div key={part.start + i} className={lineClass(line)}>
              {line || " "}
            </div>
          ))
        ),
      )}
    </pre>
  );
}

/** Files changed on this workspace's branch (committed or not), with per-file diffs. */
export function ChangesPanel({ workspaceId, root, chatIds }: { workspaceId: string; root?: string; chatIds: ReadonlySet<string> }) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  // Compare with the base branch, or any other branch.
  const [against, setAgainst] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const load = () => api.workspaceStatus(workspaceId, against || undefined).then(setStatus, () => setStatus(null));

  useEffect(() => {
    void load();
  }, [workspaceId, against]);
  useRepoReload(load, chatIds);
  useEffect(() => {
    if (open) api.workspaceDiff(workspaceId, open, against || undefined).then((d) => setDiff(d.diff), () => setDiff(""));
  }, [open, status]);

  if (!status) return <p className="p-4 text-sm text-zinc-500">Loading changes...</p>;
  if (!status.branch) return <p className="p-4 text-sm text-zinc-500">This workspace is a scratch folder without git.</p>;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="space-y-1 border-b border-zinc-900 p-3 text-xs text-zinc-400">
        <p className="truncate font-mono text-zinc-300">{status.branch}</p>
        <p>
          {status.files.length} changed file{status.files.length === 1 ? "" : "s"} vs{" "}
          <select
            className="rounded bg-zinc-900 px-1 font-mono text-zinc-300 ring-1 ring-zinc-800"
            value={against}
            onFocus={() => !branches.length && void api.git(workspaceId).then((o) => setBranches(o.branches.map((b) => b.name).filter((b) => b !== status.branch)), () => undefined)}
            onChange={(e) => setAgainst(e.target.value)}
            title="Compare with another branch"
          >
            <option value="">{against ? "base branch" : status.baseBranch}</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>{" "}
          · {status.ahead} ahead, {status.behind} behind
        </p>
        <button className="text-violet-300 hover:underline" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {status.files.map((f) => (
          <li key={f.path} className="group relative">
            <button onClick={() => setOpen(open === f.path ? null : f.path)} className={`flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs hover:bg-zinc-900 ${open === f.path ? "bg-zinc-900" : ""}`}>
              <span className={`w-3 ${STATUS_STYLE[f.status] ?? "text-zinc-400"}`}>{f.status}</span>
              <span className="truncate">{f.path}</span>
            </button>
            {root && f.status !== "D" && (
              <span className="absolute top-1 right-2 hidden gap-2 text-[11px] group-hover:flex">
                {/* Opens the file in an editor installed on this computer. */}
                <a className="text-zinc-500 hover:text-zinc-100" href={`vscode://file/${encodeURI(`${root.replace(/\\/g, "/")}/${f.path}`)}`}>
                  VS Code
                </a>
                <a className="text-zinc-500 hover:text-zinc-100" href={`cursor://file/${encodeURI(`${root.replace(/\\/g, "/")}/${f.path}`)}`}>
                  Cursor
                </a>
              </span>
            )}
            {open === f.path && <DiffBlock diff={diff} />}
          </li>
        ))}
        {status.files.length === 0 && <li className="p-3 text-xs text-zinc-500">No changes yet.</li>}
      </ul>
    </div>
  );
}
