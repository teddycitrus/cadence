import type { PullRequestInfo } from "./github";

export interface PrInsights {
  days: number;
  opened: number;
  merged: number;
  closedUnmerged: number;
  open: number;
  /** Median hours from open to merge, for PRs merged in the window. */
  medianHoursToMerge: number | null;
  byAuthor: { author: string; opened: number; merged: number }[];
  /** Merged PRs per day, oldest first. */
  mergedPerDay: { date: string; count: number }[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Throughput and cycle-time numbers for a repository's recent pull requests. */
export function pullRequestInsights(prs: PullRequestInfo[], days: number, now: Date): PrInsights {
  const since = now.getTime() - days * 86_400_000;
  const openedIn = prs.filter((p) => Date.parse(p.createdAt) >= since);
  const mergedIn = prs.filter((p) => p.mergedAt && Date.parse(p.mergedAt) >= since);
  const authors = new Map<string, { opened: number; merged: number }>();
  for (const p of openedIn) {
    const a = authors.get(p.author) ?? { opened: 0, merged: 0 };
    a.opened++;
    authors.set(p.author, a);
  }
  for (const p of mergedIn) {
    const a = authors.get(p.author) ?? { opened: 0, merged: 0 };
    a.merged++;
    authors.set(p.author, a);
  }
  const perDay = new Map<string, number>();
  for (let d = 0; d < days; d++) perDay.set(new Date(now.getTime() - (days - 1 - d) * 86_400_000).toISOString().slice(0, 10), 0);
  for (const p of mergedIn) {
    const key = p.mergedAt!.slice(0, 10);
    if (perDay.has(key)) perDay.set(key, perDay.get(key)! + 1);
  }
  const hours = mergedIn.map((p) => (Date.parse(p.mergedAt!) - Date.parse(p.createdAt)) / 3_600_000);
  const med = median(hours);
  return {
    days,
    opened: openedIn.length,
    merged: mergedIn.length,
    closedUnmerged: openedIn.filter((p) => p.state === "closed" && !p.merged).length,
    open: prs.filter((p) => p.state === "open").length,
    medianHoursToMerge: med === null ? null : Math.round(med * 10) / 10,
    byAuthor: [...authors].map(([author, v]) => ({ author, ...v })).sort((a, b) => b.merged - a.merged || b.opened - a.opened),
    mergedPerDay: [...perDay].map(([date, count]) => ({ date, count })),
  };
}
