import { prepared, type Db } from "../core/db";
import { ConflictError } from "../core/errors";
import type { Queries } from "../core/queries";
import type { Chat } from "../core/types";
import { providerInfo } from "../core/providers";

export interface UsageRow {
  key: string;
  label: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageReport {
  /** "YYYY-MM", in UTC. */
  month: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  byProvider: UsageRow[];
  byModel: UsageRow[];
  byAgent: UsageRow[];
  byPerson: UsageRow[];
  byDay: { day: string; usd: number }[];
  budgetUsd: number | null;
  agentBudgets: { agentId: string; name: string; budgetUsd: number; usd: number }[];
}

interface UsageEvent {
  chatId: string;
  usd: number;
  input: number;
  output: number;
  ts: string;
  /** The model at the time; older events fall back to the chat's model. */
  model: string | null;
}

export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);

function bounds(month: string): [string, string] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ConflictError(`"${month}" is not a month (YYYY-MM)`);
  const [y, m] = month.split("-").map(Number) as [number, number];
  return [new Date(Date.UTC(y, m - 1, 1)).toISOString(), new Date(Date.UTC(y, m, 1)).toISOString()];
}

/** Dollars, with a third decimal for small amounts so $0.015 does not read as $0.01. */
const money = (n: number) => `$${n < 1 ? n.toFixed(3).replace(/0$/, "") : n.toFixed(2)}`;

/**
 * What chats and agents cost, from the usage each turn reports, and the
 * monthly spending limits: one for the organization, and optional ones per
 * agent. Cadence runs on your own harness logins and keys, so this is where
 * spend is watched and capped.
 */
export class UsageService {
  constructor(
    private db: Db,
    private q: Queries,
  ) {}

  private events(month: string): UsageEvent[] {
    const [from, to] = bounds(month);
    const rows = prepared(this.db, "SELECT aggregate_id, payload, ts FROM events WHERE type = 'ChatUsage' AND ts >= ? AND ts < ? ORDER BY seq").all(from, to) as { aggregate_id: string; payload: string; ts: string }[];
    return rows.map((r) => {
      const p = JSON.parse(r.payload) as { costUsd: number; inputTokens: number; outputTokens: number; model?: string };
      return { chatId: r.aggregate_id, usd: p.costUsd, input: p.inputTokens, output: p.outputTokens, ts: r.ts, model: p.model ?? null };
    });
  }

  /** Spend this month, for the whole organization or one agent. */
  spent(filter: { agentId?: string } = {}, month = monthOf()): number {
    let total = 0;
    for (const e of this.events(month)) {
      if (filter.agentId && this.q.chat(e.chatId)?.agentId !== filter.agentId) continue;
      total += e.usd;
    }
    return total;
  }

  report(month = monthOf()): UsageReport {
    const groups = { byProvider: new Map<string, UsageRow>(), byModel: new Map<string, UsageRow>(), byAgent: new Map<string, UsageRow>(), byPerson: new Map<string, UsageRow>() };
    const days = new Map<string, number>();
    const total = { usd: 0, input: 0, output: 0, turns: 0 };
    const add = (map: Map<string, UsageRow>, key: string, label: string, e: UsageEvent) => {
      const row = map.get(key) ?? { key, label, usd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
      row.usd += e.usd;
      row.inputTokens += e.input;
      row.outputTokens += e.output;
      row.turns++;
      map.set(key, row);
    };
    for (const e of this.events(month)) {
      total.usd += e.usd;
      total.input += e.input;
      total.output += e.output;
      total.turns++;
      days.set(e.ts.slice(0, 10), (days.get(e.ts.slice(0, 10)) ?? 0) + e.usd);
      const chat = this.q.chat(e.chatId);
      add(groups.byProvider, chat?.provider ?? "unknown", chat ? providerInfo(chat.provider).label : "Deleted chats", e);
      const model = e.model ?? chat?.model ?? "";
      add(groups.byModel, model || "default", model || "Default model", e);
      if (chat?.agentId) add(groups.byAgent, chat.agentId, this.q.agent(chat.agentId)?.name ?? "Deleted agent", e);
      else {
        const person = chat?.createdBy ?? "unknown";
        const memberId = person === "user" ? "me" : person.startsWith("member:") ? person.slice(7) : null;
        add(groups.byPerson, person, memberId ? (this.q.member(memberId)?.name ?? "Former member") : chat ? person.replace(/:.*/, "") : "Deleted chats", e);
      }
    }
    const sorted = (m: Map<string, UsageRow>) => [...m.values()].sort((a, b) => b.usd - a.usd || b.outputTokens - a.outputTokens);
    const settings = this.q.settings();
    return {
      month,
      usd: total.usd,
      inputTokens: total.input,
      outputTokens: total.output,
      turns: total.turns,
      byProvider: sorted(groups.byProvider),
      byModel: sorted(groups.byModel),
      byAgent: sorted(groups.byAgent),
      byPerson: sorted(groups.byPerson),
      byDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, usd]) => ({ day, usd })),
      budgetUsd: settings.monthlyBudgetUsd ?? null,
      agentBudgets: this.q
        .agents()
        .filter((a) => a.monthlyBudgetUsd != null)
        .map((a) => ({ agentId: a.id, name: a.name, budgetUsd: a.monthlyBudgetUsd!, usd: groups.byAgent.get(a.id)?.usd ?? 0 })),
    };
  }

  /** Throws when the chat's organization, or its agent, has used up this month's budget. */
  check(chat: Pick<Chat, "agentId">): void {
    const budget = this.q.settings().monthlyBudgetUsd;
    if (budget != null) {
      const spent = this.spent();
      if (spent >= budget) throw new ConflictError(`This organization has used its monthly budget (${money(spent)} of ${money(budget)}). An admin can raise it in Settings > Usage.`);
    }
    const agent = chat.agentId ? this.q.agent(chat.agentId) : null;
    if (agent?.monthlyBudgetUsd != null) {
      const spent = this.spent({ agentId: agent.id });
      if (spent >= agent.monthlyBudgetUsd) throw new ConflictError(`${agent.name} has used its monthly budget (${money(spent)} of ${money(agent.monthlyBudgetUsd)}). Raise it on the agent to keep it running.`);
    }
  }
}
