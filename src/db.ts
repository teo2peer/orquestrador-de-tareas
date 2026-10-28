import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Local SQLite index of a project's runs, at <cwd>/.orq/runs/orq.db (git-ignored with the runs).
 * events.jsonl stays the append-only source of truth; the DB lets resume read only the kinds it
 * needs and lets agents search past work (`memory` tool) instead of replaying a transcript.
 */

/** Event kinds worth full-text search, and the field holding their text. */
const SEARCHABLE: Record<string, string> = { message: 'body', timeline: 'text', note: 'text' };
/** Kinds searched by default (tool noise stays out unless asked for). */
const DEFAULT_SEARCH = ['message', 'note'];

export type Hit = { ts: number; kind: string; agent: string; run: string; text: string };

export class RunDb {
  private db: Database;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    // Several orq processes (one per run) may open the same project DB at once. The WAL switch and the
    // first schema creation fail with "database is locked" regardless of busy_timeout: retry them.
    for (let attempt = 0; ; attempt++) {
      try {
        this.init();
        break;
      } catch (e: any) {
        if (attempt >= 40 || !/locked|busy/i.test(String(e?.message))) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 30));
      }
    }
  }

  private init() {
    this.db.run('PRAGMA busy_timeout = 5000');
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, run TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, agent TEXT, data TEXT NOT NULL)`);
    this.db.run('CREATE INDEX IF NOT EXISTS events_run ON events (run, kind, id)');
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, run UNINDEXED, agent UNINDEXED, kind UNINDEXED, ts UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`);
  }

  close() {
    this.db.close();
  }

  insert(run: string, e: Record<string, any>) {
    const ts = Number(e.ts) || Date.now();
    const agent = typeof e.agent === 'string' ? e.agent : typeof e.from === 'string' ? e.from : null;
    this.db.query('INSERT INTO events (run, ts, kind, agent, data) VALUES (?, ?, ?, ?, ?)').run(run, ts, String(e.kind), agent, JSON.stringify(e));
    const field = SEARCHABLE[e.kind];
    const text = field ? String(e[field] ?? '').trim() : '';
    if (text) this.db.query('INSERT INTO search (text, run, agent, kind, ts) VALUES (?, ?, ?, ?, ?)').run(text, run, agent ?? '', String(e.kind), ts);
  }

  count(run: string) {
    return (this.db.query('SELECT COUNT(*) AS n FROM events WHERE run = ?').get(run) as { n: number }).n;
  }

  /** Events of a run in order, optionally only some kinds. */
  events(run: string, kinds?: readonly string[]): Record<string, any>[] {
    const where = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    const rows = this.db.query(`SELECT data FROM events WHERE run = ?${where} ORDER BY id`).all(run, ...(kinds ?? [])) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  /** Replace a run's rows with `events` (the index is derived data: the jsonl is the truth). */
  replace(run: string, events: Record<string, any>[]) {
    this.db.transaction(() => {
      this.db.query('DELETE FROM events WHERE run = ?').run(run);
      this.db.query('DELETE FROM search WHERE run = ?').run(run);
      for (const e of events) this.insert(run, e);
    })();
  }

  /** Bulk-load events (e.g. a run that only has events.jsonl) in one transaction. */
  import(run: string, events: Record<string, any>[]) {
    this.db.transaction(() => {
      for (const e of events) this.insert(run, e);
    })();
  }

  /**
   * Full-text search over messages and notes (and timeline entries when `kinds` says so).
   * `run` limits to one run; otherwise every run of the project is searched. Newest first.
   */
  search(query: string, opts: { run?: string; kinds?: readonly string[]; limit?: number } = {}): Hit[] {
    const match = toMatch(query);
    if (!match) return [];
    const kinds = opts.kinds?.length ? opts.kinds : DEFAULT_SEARCH;
    const sql = `SELECT ts, kind, agent, run, snippet(search, 0, '[', ']', '…', 24) AS text FROM search
      WHERE search MATCH ? AND kind IN (${kinds.map(() => '?').join(',')})${opts.run ? ' AND run = ?' : ''}
      ORDER BY rank LIMIT ?`;
    const args: (string | number)[] = [match, ...kinds, ...(opts.run ? [opts.run] : []), opts.limit ?? 8];
    return (this.db.query(sql).all(...args) as Hit[]).sort((a, b) => b.ts - a.ts);
  }
}

/** User text → FTS5 query: every word quoted (no operator injection), joined with OR so any term matches. */
export function toMatch(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, 12).map((w) => `"${w}"`).join(' OR ');
}
