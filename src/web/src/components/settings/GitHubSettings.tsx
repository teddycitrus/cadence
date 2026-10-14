import { useEffect, useState } from "react";
import type { Snapshot } from "../../../../core/types";
import { api, type PrInsights } from "../../api";
import { Button, ErrorText, Field, inputClass, useAction } from "../ui";

const SOURCE: Record<string, string> = {
  env: "Connected through the GITHUB_TOKEN environment variable.",
  settings: "Connected with a token saved on this machine.",
  gh: "Connected through your GitHub CLI (gh) login.",
};

function Insights({ repos }: { repos: string[] }) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<PrInsights | null>(null);
  const action = useAction();
  useEffect(() => {
    if (repo) void action.run(async () => setData(await api.prInsights(repo, days)));
  }, [repo, days]);

  if (!repos.length) return <p className="text-sm text-zinc-500">Set a GitHub repository on a project to see its pull request insights.</p>;
  const max = Math.max(1, ...(data?.mergedPerDay.map((d) => d.count) ?? [1]));
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <select className={`${inputClass} w-auto`} value={repo} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <select className={`${inputClass} w-auto`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 30, 90].map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </div>
      <ErrorText>{action.error}</ErrorText>
      {data && (
        <>
          <div className="grid grid-cols-4 gap-3">
            {[
              ["Opened", data.opened],
              ["Merged", data.merged],
              ["Open now", data.open],
              ["Median time to merge", data.medianHoursToMerge === null ? "n/a" : data.medianHoursToMerge < 48 ? `${data.medianHoursToMerge}h` : `${(data.medianHoursToMerge / 24).toFixed(1)}d`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-zinc-900 p-3 ring-1 ring-zinc-800">
                <p className="text-xs text-zinc-500">{label}</p>
                <p className="font-display mt-1 text-2xl">{value}</p>
              </div>
            ))}
          </div>
          <div>
            <p className="mb-1 text-xs text-zinc-500">Merged per day</p>
            <div className="flex h-24 items-end gap-px rounded-lg bg-zinc-900 p-2 ring-1 ring-zinc-800">
              {data.mergedPerDay.map((d) => (
                <div key={d.date} title={`${d.date}: ${d.count}`} className="flex-1 rounded-sm bg-violet-500/80" style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? 2 : 0 }} />
              ))}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500">
              <tr>
                <th className="py-1 font-normal">Author</th>
                <th className="font-normal">Opened</th>
                <th className="font-normal">Merged</th>
              </tr>
            </thead>
            <tbody>
              {data.byAuthor.map((a) => (
                <tr key={a.author} className="border-t border-zinc-900">
                  <td className="py-1">{a.author}</td>
                  <td>{a.opened}</td>
                  <td>{a.merged}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** GitHub connection (for pull requests and checks) and PR insights. */
export function GitHubSettings({ snapshot }: { snapshot: Snapshot }) {
  const [status, setStatus] = useState(snapshot.github);
  const [token, setToken] = useState("");
  const action = useAction();
  const repos = [...new Set(snapshot.projects.map((p) => p.githubRepo).filter((r): r is string => Boolean(r)))];

  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-3">
        <p className="text-sm">
          {status.connected ? <span className="text-emerald-400">● </span> : <span className="text-zinc-500">○ </span>}
          {status.connected ? SOURCE[status.source ?? ""] : "Not connected. Cadence uses GITHUB_TOKEN, a token saved here, or your gh CLI login, in that order."}
        </p>
        <Field label="Personal access token" hint="Needs repo read/write for pull requests and checks. Stored on this machine only and never shown again.">
          <input className={inputClass} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_..." />
        </Field>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={action.busy || !token.trim()}
            onClick={() =>
              action.run(async () => {
                setStatus(await api.saveGithubToken(token.trim()));
                setToken("");
              })
            }
          >
            {action.busy ? "Checking..." : "Save token"}
          </Button>
          {status.source === "settings" && (
            <Button variant="ghost" onClick={() => action.run(async () => setStatus(await api.saveGithubToken(null)))}>
              Remove saved token
            </Button>
          )}
        </div>
        <ErrorText>{action.error}</ErrorText>
      </section>
      <section className="space-y-3">
        <h2 className="font-medium">Pull request insights</h2>
        {status.connected ? <Insights repos={repos} /> : <p className="text-sm text-zinc-500">Connect GitHub to see throughput and time to merge.</p>}
      </section>
    </div>
  );
}
