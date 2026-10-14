import { useEffect, useState } from "react";
import type { Snapshot } from "../../../../core/types";
import { api, type UsageReport, type UsageRow } from "../../api";
import { Button, ErrorText, Field, inputClass, useAction } from "../ui";

const usd = (n: number) => `$${n < 1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function Table({ title, rows }: { title: string; rows: UsageRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-zinc-900">
              <td className="py-1.5">{r.label}</td>
              <td className="py-1.5 text-right text-zinc-500">{r.turns} turns</td>
              <td className="py-1.5 text-right text-zinc-500">{tokens(r.inputTokens + r.outputTokens)} tokens</td>
              <td className="w-20 py-1.5 text-right font-mono">{usd(r.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** What chats and agents cost this month, and the organization's spending limit. */
export function UsageSettings({ snapshot }: { snapshot: Snapshot }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [report, setReport] = useState<UsageReport | null>(null);
  const [budget, setBudget] = useState("");
  const action = useAction();
  const load = () => api.usage(month).then(setReport, (e: Error) => action.setError(e.message));
  useEffect(() => void load(), [month]);
  useEffect(() => setBudget(snapshot.settings.monthlyBudgetUsd != null ? String(snapshot.settings.monthlyBudgetUsd) : ""), [snapshot.settings.monthlyBudgetUsd]);
  if (!report) return <ErrorText>{action.error}</ErrorText>;
  const share = report.budgetUsd ? Math.min(1, report.usd / report.budgetUsd) : 0;
  const peak = Math.max(...report.byDay.map((d) => d.usd), 0.0001);
  const thisMonth = month === new Date().toISOString().slice(0, 7);
  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={() => setMonth(shiftMonth(month, -1))}>
          ←
        </Button>
        <span className="font-mono text-sm">{month}</span>
        <Button variant="ghost" disabled={thisMonth} onClick={() => setMonth(shiftMonth(month, 1))}>
          →
        </Button>
      </div>
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg bg-zinc-900 p-4 ring-1 ring-zinc-800">
          <p className="text-xs text-zinc-500">Spent</p>
          <p className="font-display text-3xl">{usd(report.usd)}</p>
        </div>
        <div className="rounded-lg bg-zinc-900 p-4 ring-1 ring-zinc-800">
          <p className="text-xs text-zinc-500">Tokens</p>
          <p className="font-display text-3xl">{tokens(report.inputTokens + report.outputTokens)}</p>
        </div>
        <div className="rounded-lg bg-zinc-900 p-4 ring-1 ring-zinc-800">
          <p className="text-xs text-zinc-500">Turns</p>
          <p className="font-display text-3xl">{report.turns}</p>
        </div>
      </section>
      {report.budgetUsd != null && thisMonth && (
        <section className="space-y-1">
          <div className="flex justify-between text-xs text-zinc-400">
            <span>Monthly budget</span>
            <span>
              {usd(report.usd)} of {usd(report.budgetUsd)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-zinc-800">
            <div className={`h-full ${share >= 1 ? "bg-red-500" : share >= 0.8 ? "bg-amber-400" : "bg-violet-500"}`} style={{ width: `${share * 100}%` }} />
          </div>
          {share >= 1 && <p className="text-xs text-red-400">The budget is used up: new chat messages and agent runs are paused until next month or until it is raised.</p>}
        </section>
      )}
      {report.byDay.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">By day</h3>
          <div className="flex h-24 items-end gap-1">
            {report.byDay.map((d) => (
              <div key={d.day} className="flex-1 rounded-t bg-violet-500/70" style={{ height: `${Math.max(4, (d.usd / peak) * 100)}%` }} title={`${d.day}: ${usd(d.usd)}`} />
            ))}
          </div>
        </section>
      )}
      <Table title="By harness" rows={report.byProvider} />
      <Table title="By model" rows={report.byModel} />
      <Table title="By agent" rows={report.byAgent} />
      <Table title="People's chats" rows={report.byPerson} />
      {report.agentBudgets.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Agent budgets</h3>
          {report.agentBudgets.map((a) => (
            <p key={a.agentId} className="flex justify-between text-sm">
              <a href={`#/agents/${a.agentId}`} className="hover:underline">
                {a.name}
              </a>
              <span className={a.usd >= a.budgetUsd ? "text-red-400" : "text-zinc-400"}>
                {usd(a.usd)} of {usd(a.budgetUsd)}
              </span>
            </p>
          ))}
        </section>
      )}
      {report.turns === 0 && <p className="text-sm text-zinc-500">Nothing ran this month.</p>}
      <section className="space-y-2 border-t border-zinc-900 pt-6">
        <Field label="Monthly budget (USD)" hint="Chats and agent runs pause when this month's spend reaches it. Leave empty for no limit. Harnesses on a subscription report no cost, so their tokens count but not toward the budget.">
          <div className="flex max-w-xs gap-2">
            <input className={inputClass} type="number" min={0} step="1" placeholder="No limit" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <Button
              variant="primary"
              disabled={action.busy || budget === (snapshot.settings.monthlyBudgetUsd != null ? String(snapshot.settings.monthlyBudgetUsd) : "")}
              onClick={() =>
                action.run(async () => {
                  await api.updateSettings({ monthlyBudgetUsd: budget.trim() === "" ? null : Number(budget) });
                  await load();
                })
              }
            >
              Save
            </Button>
          </div>
        </Field>
        <ErrorText>{action.error}</ErrorText>
      </section>
    </div>
  );
}
