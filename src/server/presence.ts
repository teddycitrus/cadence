import type { EphemeralBus } from "../core/bus";

export interface Viewer {
  memberId: string;
  /** What they are looking at, e.g. "issue:<id>", "doc:<id>", "canvas:<ws>|<path>". */
  place: string;
  at: number;
}

const TTL_MS = 40_000;

/**
 * Who is looking at what, from browser heartbeats. Kept in memory only and
 * broadcast over the live stream whenever it changes.
 */
export class Presence {
  private viewers = new Map<string, Viewer>();
  private timer: NodeJS.Timeout;

  constructor(private bus: EphemeralBus) {
    this.timer = setInterval(() => this.expire(), 10_000);
    this.timer.unref?.();
  }

  /** `tab` distinguishes several tabs of one member. */
  beat(memberId: string, tab: string, place: string | null): void {
    const key = `${memberId}:${tab}`;
    const before = this.viewers.get(key)?.place;
    if (place) this.viewers.set(key, { memberId, place, at: Date.now() });
    else this.viewers.delete(key);
    if (before !== (place ?? undefined)) this.publish();
  }

  list(): Viewer[] {
    const seen = new Set<string>();
    return [...this.viewers.values()].filter((v) => {
      const k = `${v.memberId}:${v.place}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  private expire(): void {
    const now = Date.now();
    let changed = false;
    for (const [k, v] of this.viewers) {
      if (now - v.at > TTL_MS) {
        this.viewers.delete(k);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  private publish(): void {
    this.bus.emit({ type: "presence", viewers: this.list() });
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
