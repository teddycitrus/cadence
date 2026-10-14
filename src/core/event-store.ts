import { clearProjections, prepared, transaction, type Db } from "./db";
import type { DomainEvent } from "./events";
import { project } from "./projections";
import type { Actor, StoredEvent } from "./types";
import { currentActor } from "../auth/context";

export type EventListener = (event: StoredEvent) => void;

interface EventRow {
  seq: number;
  aggregate: string;
  aggregate_id: string;
  type: string;
  payload: string;
  actor: Actor;
  ts: string;
}

function toStored(row: EventRow): StoredEvent {
  return {
    seq: row.seq,
    aggregate: row.aggregate,
    aggregateId: row.aggregate_id,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    actor: row.actor,
    ts: row.ts,
  };
}

function asDomainEvent(e: StoredEvent): DomainEvent {
  return { aggregate: e.aggregate, aggregateId: e.aggregateId, type: e.type, payload: e.payload } as DomainEvent;
}

/**
 * Append-only event log. Each append writes the events and updates the read
 * models in one transaction, then notifies subscribers after commit.
 */
export class EventStore {
  private listeners = new Set<EventListener>();

  constructor(
    readonly db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  append(events: DomainEvent | DomainEvent[], actor: Actor = currentActor()): StoredEvent[] {
    const list = Array.isArray(events) ? events : [events];
    const insert = prepared(this.db, "INSERT INTO events (aggregate, aggregate_id, type, payload, actor, ts) VALUES (?, ?, ?, ?, ?, ?)");
    const stored = transaction(this.db, () =>
      list.map((event) => {
        const ts = this.now().toISOString();
        const result = insert.run(event.aggregate, event.aggregateId, event.type, JSON.stringify(event.payload), actor, ts);
        const seq = Number(result.lastInsertRowid);
        project(this.db, event, seq, ts, actor);
        return { seq, aggregate: event.aggregate, aggregateId: event.aggregateId, type: event.type, payload: event.payload as Record<string, unknown>, actor, ts };
      }),
    );
    for (const event of stored) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (err) {
          console.error("event listener failed", err);
        }
      }
    }
    return stored;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  forAggregate(aggregate: string, id: string): StoredEvent[] {
    const rows = prepared(this.db, "SELECT * FROM events WHERE aggregate = ? AND aggregate_id = ? ORDER BY seq").all(aggregate, id) as unknown as EventRow[];
    return rows.map(toStored);
  }

  /** Events of these types since a time (ISO), oldest first. Uses the (type, ts) index. */
  ofTypesSince(types: string[], since: string): StoredEvent[] {
    if (!types.length) return [];
    const rows = prepared(this.db, `SELECT * FROM events WHERE type IN (${types.map(() => "?").join(",")}) AND ts >= ? ORDER BY seq`).all(...types, since) as unknown as EventRow[];
    return rows.map(toStored);
  }

  /** Up to `limit` events after `seq`, oldest first (for clients catching up after a reconnect). */
  after(seq: number, limit: number): StoredEvent[] {
    const rows = prepared(this.db, "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as unknown as EventRow[];
    return rows.map(toStored);
  }

  /** The newest event's sequence number (0 when there are none). */
  lastSeq(): number {
    return Number((prepared(this.db, "SELECT COALESCE(MAX(seq), 0) AS n FROM events").get() as { n: number }).n);
  }

  count(): number {
    return Number((prepared(this.db, "SELECT COUNT(*) AS n FROM events").get() as { n: number }).n);
  }

  /** Drops all read models and rebuilds them from the log. */
  rebuild(): number {
    const rows = prepared(this.db, "SELECT * FROM events ORDER BY seq").all() as unknown as EventRow[];
    transaction(this.db, () => {
      clearProjections(this.db);
      for (const row of rows) project(this.db, asDomainEvent(toStored(row)), row.seq, row.ts, row.actor);
    });
    return rows.length;
  }
}
