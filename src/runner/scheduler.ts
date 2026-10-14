import { Cron } from "croner";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { TriggerEngine } from "./triggers";

export function isValidCron(expression: string): boolean {
  if (expression.trim().split(/\s+/).length !== 5) return false;
  try {
    new Cron(expression, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}

/** Whether a name is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function nextRun(expression: string, timezone?: string): Date | null {
  try {
    const job = new Cron(expression, { paused: true, ...(timezone ? { timezone } : {}) });
    const next = job.nextRun();
    job.stop();
    return next;
  } catch {
    return null;
  }
}

/** Keeps one cron job per enabled schedule trigger, resynced whenever agents change. */
export class Scheduler {
  private jobs = new Map<string, Cron>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private store: EventStore,
    private q: Queries,
    private triggers: TriggerEngine,
  ) {}

  start(): void {
    this.sync();
    this.unsubscribe = this.store.subscribe((e) => {
      if (e.aggregate === "agent") this.sync();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  sync(): void {
    const wanted = new Map<string, { agentId: string; cron: string; description: string; timezone?: string }>();
    for (const agent of this.q.agents()) {
      if (!agent.enabled) continue;
      for (const t of agent.triggers) {
        if (t.kind === "schedule" && isValidCron(t.cron)) wanted.set(`${agent.id}:${t.id}:${t.cron}:${t.timezone ?? ""}`, { agentId: agent.id, cron: t.cron, description: t.description || t.cron, timezone: t.timezone && isTimeZone(t.timezone) ? t.timezone : undefined });
      }
    }
    for (const [key, job] of this.jobs) {
      if (!wanted.has(key)) {
        job.stop();
        this.jobs.delete(key);
      }
    }
    for (const [key, spec] of wanted) {
      if (this.jobs.has(key)) continue;
      this.jobs.set(
        key,
        new Cron(spec.cron, { protect: true, ...(spec.timezone ? { timezone: spec.timezone } : {}) }, () => {
          this.triggers.fireSchedule(spec.agentId, spec.description);
        }),
      );
    }
  }

  get jobCount(): number {
    return this.jobs.size;
  }
}
