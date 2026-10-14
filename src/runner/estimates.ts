import { Cron } from "croner";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Agent, Assignee, Trigger } from "../core/types";
import { isTimeZone, isValidCron } from "./scheduler";

// How often an agent's triggers fire, so people can see what an agent will
// cost before turning it on. Schedules are counted ahead; everything else is
// measured from the last two weeks of this board's activity.

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;

export interface TriggerEstimate {
  triggerId: string;
  kind: Trigger["kind"];
  /** Expected runs per day; null when there is nothing to go on yet. */
  perDay: number | null;
  basis: string;
}

export interface ScheduleStatus {
  triggerId: string;
  cron: string;
  description: string;
  timezone: string | null;
  next: string | null;
  lastRunAt: string | null;
}

/** The next run and the last run of each schedule trigger. */
export function scheduleStatus(agent: Agent, q: Queries): ScheduleStatus[] {
  const runs = q.runs().filter((r) => r.agentId === agent.id && r.trigger === "schedule");
  const last = runs.map((r) => r.createdAt).sort().at(-1) ?? null;
  return agent.triggers.flatMap((t) => {
    if (t.kind !== "schedule") return [];
    const zone = t.timezone && isTimeZone(t.timezone) ? t.timezone : undefined;
    let next: string | null = null;
    if (isValidCron(t.cron)) {
      const job = new Cron(t.cron, { paused: true, ...(zone ? { timezone: zone } : {}) });
      next = job.nextRun()?.toISOString() ?? null;
      job.stop();
    }
    return [{ triggerId: t.id, cron: t.cron, description: t.description, timezone: zone ?? null, next, lastRunAt: last }];
  });
}

const round = (n: number) => Math.round(n * 10) / 10;

export function estimateTriggers(agent: Agent, store: EventStore, q: Queries, now = Date.now()): TriggerEstimate[] {
  const since = new Date(now - WINDOW_DAYS * DAY).toISOString();
  const events = store.ofTypesSince(["IssueCreated", "IssueMoved", "LabelAdded", "CommentAdded", "AssigneeAdded"], since);
  const assignedIssues = new Set(q.issues().filter((i) => i.assignees.some((a) => a.kind === "agent" && a.id === agent.id)).map((i) => i.id));
  const perDay = (n: number) => round(n / WINDOW_DAYS);
  const recentRuns = (kind: Trigger["kind"]) => q.runs().filter((r) => r.agentId === agent.id && r.trigger === kind && r.createdAt >= since).length;

  return agent.triggers.map((t): TriggerEstimate => {
    const base = { triggerId: t.id, kind: t.kind };
    switch (t.kind) {
      case "schedule": {
        if (!isValidCron(t.cron)) return { ...base, perDay: null, basis: "The schedule is not valid" };
        const zone = t.timezone && isTimeZone(t.timezone) ? t.timezone : undefined;
        const job = new Cron(t.cron, { paused: true, ...(zone ? { timezone: zone } : {}) });
        const until = now + 7 * DAY;
        const upcoming = job.nextRuns(2000, new Date(now)).filter((d) => d.getTime() <= until).length;
        job.stop();
        return { ...base, perDay: round(upcoming / 7), basis: "From the schedule, over the next week" };
      }
      case "issue_created": {
        const n = events.filter((e) => e.type === "IssueCreated" && (!t.stageIds.length || t.stageIds.includes(String(e.payload.stageId))) && (!t.types.length || t.types.includes(e.payload.type as never))).length;
        return { ...base, perDay: perDay(n), basis: `${n} matching issues created in the last ${WINDOW_DAYS} days` };
      }
      case "issue_moved": {
        const n = events.filter((e) => e.type === "IssueMoved" && (!t.toStageIds.length || t.toStageIds.includes(String(e.payload.to)))).length;
        return { ...base, perDay: perDay(n), basis: `${n} matching moves in the last ${WINDOW_DAYS} days` };
      }
      case "label_added": {
        const n = events.filter((e) => e.type === "LabelAdded" && (!t.labelIds.length || t.labelIds.includes(String(e.payload.labelId)))).length;
        return { ...base, perDay: perDay(n), basis: `${n} matching labels added in the last ${WINDOW_DAYS} days` };
      }
      case "issue_commented": {
        const n = events.filter((e) => e.type === "CommentAdded" && assignedIssues.has(e.aggregateId) && !String(e.actor).startsWith("agent:")).length;
        return { ...base, perDay: perDay(n), basis: `${n} comments on its issues in the last ${WINDOW_DAYS} days` };
      }
      case "assigned": {
        const n = events.filter((e) => e.type === "AssigneeAdded" && (e.payload.assignee as Assignee).kind === "agent" && (e.payload.assignee as Assignee).id === agent.id).length;
        return { ...base, perDay: perDay(n), basis: `Assigned ${n} times in the last ${WINDOW_DAYS} days` };
      }
      default: {
        const n = recentRuns(t.kind);
        return { ...base, perDay: n ? perDay(n) : null, basis: n ? `${n} runs from ${t.kind} in the last ${WINDOW_DAYS} days` : "Depends on outside activity; no runs from it yet" };
      }
    }
  });
}
