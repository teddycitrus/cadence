import type { Finding } from "../../../../agents/review-tools";

const TONE: Record<Finding["severity"], string> = { high: "bg-red-950 text-red-300", medium: "bg-amber-950 text-amber-300", low: "bg-zinc-800 text-zinc-300" };

/** A review's findings, worst first. */
export function FindingsCard({ input }: { input: Record<string, unknown> }) {
  const findings = Array.isArray(input.findings) ? (input.findings as Finding[]) : [];
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <div className="rounded-lg bg-zinc-900 text-xs ring-1 ring-zinc-800">
      <p className="border-b border-zinc-800 px-3 py-2 font-medium text-zinc-200">
        {typeof input.title === "string" && input.title ? input.title : "Review findings"}
        <span className="ml-2 font-normal text-zinc-500">{sorted.length ? `${sorted.length} found` : "nothing found"}</span>
      </p>
      {sorted.length > 0 && (
        <div className="divide-y divide-zinc-800">
          {sorted.map((f, i) => (
            <div key={i} className="space-y-0.5 px-3 py-2">
              <p className="flex items-center gap-2">
                <span className={`rounded px-1.5 text-[10px] uppercase ${TONE[f.severity] ?? TONE.low}`}>{f.severity}</span>
                <span className="font-mono text-zinc-400">
                  {f.file}
                  {f.line ? `:${f.line}` : ""}
                </span>
              </p>
              <p className="text-zinc-100">{f.summary}</p>
              {f.failureScenario && <p className="text-zinc-400">{f.failureScenario}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
