import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

/** Read-model tables. Each row is one JSON document keyed by id. */
export const DOC_TABLES = ["stages", "labels", "issues", "projects", "agents", "runs", "docs", "workspaces", "chats", "queued", "interactions", "assets", "pullRequests", "canvasEdits", "canvasComments", "members", "shares", "skills", "machines", "issueViews", "issueReads", "settings"] as const;
export type DocTable = (typeof DOC_TABLES)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_aggregate ON events (aggregate, aggregate_id);
CREATE INDEX IF NOT EXISTS events_type_ts ON events (type, ts);

${DOC_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, parent TEXT, sort TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ${t}_parent ON ${t} (parent);`,
).join("\n")}

CREATE TABLE IF NOT EXISTS comments (
  seq INTEGER PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  ts TEXT NOT NULL,
  edited_at TEXT,
  reactions TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS comments_issue ON comments (issue_id);

CREATE TABLE IF NOT EXISTS chat_items (
  seq INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  data TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_items_chat ON chat_items (chat_id);

-- Lookups by an issue's key (CAD-12) and the run queue's unfinished runs; queries use these exact expressions.
CREATE INDEX IF NOT EXISTS issues_key ON issues (lower(json_extract(data, '$.key')));
CREATE INDEX IF NOT EXISTS runs_status ON runs (json_extract(data, '$.status'));
`;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // Databases from before comment editing and reactions.
  addColumn(db, "comments", "edited_at", "TEXT");
  addColumn(db, "comments", "reactions", "TEXT NOT NULL DEFAULT '{}'");
  return db;
}

function addColumn(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function clearProjections(db: Db): void {
  for (const table of [...DOC_TABLES, "comments", "chat_items"]) db.exec(`DELETE FROM ${table}`);
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Typed JSON-document access to the read-model tables. */
const statements = new WeakMap<Db, Map<string, StatementSync>>();

/** A prepared statement, compiled once per database and reused (the SQL text is the key). */
export function prepared(db: Db, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) cache.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

export class DocStore {
  constructor(private db: Db) {}

  get<T>(table: DocTable, id: string): T | null {
    const row = prepared(this.db, `SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  put(table: DocTable, id: string, data: object, parent: string | null = null, sort: string | null = null): void {
    prepared(
      this.db,
      `INSERT INTO ${table} (id, parent, sort, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent = excluded.parent, sort = excluded.sort, data = excluded.data`,
    ).run(id, parent, sort, JSON.stringify(data));
  }

  delete(table: DocTable, id: string): void {
    prepared(this.db, `DELETE FROM ${table} WHERE id = ?`).run(id);
  }

  /** `where` is SQL written in this codebase (never user text); values go in `params`. */
  all<T>(table: DocTable, where = "", ...params: string[]): T[] {
    const rows = prepared(this.db, `SELECT data FROM ${table} ${where}`).all(...params) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }
}
