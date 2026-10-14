import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty } from "./ui";

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-zinc-500";
  if (line.startsWith("diff --git")) return "mt-3 font-semibold text-zinc-200";
  if (line.startsWith("@@")) return "text-sky-400";
  if (line.startsWith("+")) return "bg-emerald-950/60 text-emerald-300";
  if (line.startsWith("-")) return "bg-red-950/60 text-red-300";
  return "text-zinc-400";
}

export function DiffView({ issueId, version }: { issueId: string; version: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    api.diff(issueId).then((d) => setDiff(d.diff), () => setDiff(""));
  }, [issueId, version]);

  if (diff === null) return <p className="text-sm text-zinc-500">Loading diff...</p>;
  if (!diff) return <Empty title="No changes yet">The diff against the base branch appears here once an agent starts building.</Empty>;
  return (
    <pre className="overflow-x-auto rounded-lg bg-zinc-900/60 p-3 font-mono text-xs leading-5 ring-1 ring-zinc-800">
      {diff.split("\n").map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}
