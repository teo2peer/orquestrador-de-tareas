import fs from 'node:fs';
import path from 'node:path';
import { RunDb } from './db.ts';
import { ORQ_HOME } from './paths.ts';

export const INDEX_DIR = path.join(ORQ_HOME, 'index');

const time = (ts = Date.now()) => new Date(ts).toLocaleString('es-ES', { hour12: false });

/**
 * Run persistence under <cwd>/.orq/runs/<runId>/:
 *   run.json        run metadata + agents (session ids, transcripts)
 *   events.jsonl    every event in order (source of truth)
 *   ../orq.db       SQLite index of the events of every run of the project (see db.ts)
 *   agents/<id>.md  human-readable log per agent (prompts in/out, messages, summaries)
 *   REPORT.md       task reports (summaries) of the whole run
 *   LOG.md          long details agents log with the `log` tool (for the user; agents never read it)
 */
const dbs = new Map<string, RunDb>();

/** The project's SQLite index, given a run dir (<cwd>/.orq/runs/<runId>); null if it cannot be opened. */
function dbFor(runDir: string): RunDb | null {
  const file = path.join(path.dirname(runDir), 'orq.db');
  try {
    let db = dbs.get(file);
    if (!db) dbs.set(file, (db = new RunDb(file)));
    return db;
  } catch {
    return null;
  }
}

function parseLines(file: string): Record<string, any>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

/** Runs whose index was checked against their events.jsonl in this process (key: db file + run). */
const synced = new Set<string>();

/**
 * Events of a run, optionally only some kinds. Read from the SQLite index. The first read of a run
 * in this process checks the index against events.jsonl: a run with older or lost rows (events from
 * before the index existed, a deleted DB) is rebuilt from the jsonl. Falls back to the jsonl on DB errors.
 */
export function readRunEvents(runDir: string, runId: string, kinds?: readonly string[]): Record<string, any>[] {
  const jsonl = path.join(runDir, 'events.jsonl');
  const filter = (all: Record<string, any>[]) => (kinds?.length ? all.filter((e) => kinds.includes(e.kind)) : all);
  try {
    const db = dbFor(runDir);
    if (!db) return filter(parseLines(jsonl));
    const key = `${db.file}#${runId}`;
    if (!synced.has(key)) {
      synced.add(key);
      const all = parseLines(jsonl);
      if (db.count(runId) < all.length) db.replace(runId, all);
    }
    return db.events(runId, kinds);
  } catch {
    return filter(parseLines(jsonl));
  }
}

/** Search the messages and notes of every run of a project (the DB at <cwd>/.orq/runs/orq.db); [] when it has none. */
export function searchProject(cwd: string, query: string, limit = 10) {
  const file = path.join(cwd, '.orq', 'runs', 'orq.db');
  if (!fs.existsSync(file)) return [];
  try {
    return dbFor(path.join(cwd, '.orq', 'runs', '_'))?.search(query, { limit }) ?? [];
  } catch {
    return [];
  }
}

export class RunStore {
  readonly dir: string;

  constructor(readonly runId: string, cwd: string) {
    this.dir = path.join(cwd, '.orq', 'runs', runId);
    fs.mkdirSync(path.join(this.dir, 'agents'), { recursive: true });
    // Run logs hold prompts and messages: keep them out of the project's git.
    const ignore = path.join(cwd, '.orq', 'runs', '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  }

  agentDir(id: string) {
    const d = path.join(this.dir, 'agents', id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  event(e: Record<string, unknown>) {
    const row = { ts: Date.now(), ...e };
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify(row) + '\n');
    try {
      dbFor(this.dir)?.insert(this.runId, row);
    } catch {
      // The jsonl is the source of truth: a failing index must not break the run.
    }
  }

  /** Full-text search over the project's messages and notes (this run, or every run). */
  search(query: string, opts: { allRuns?: boolean; kinds?: readonly string[]; limit?: number } = {}) {
    return dbFor(this.dir)?.search(query, { run: opts.allRuns ? undefined : this.runId, kinds: opts.kinds, limit: opts.limit }) ?? [];
  }

  agentLog(id: string, heading: string, text: string) {
    fs.appendFileSync(path.join(this.dir, 'agents', `${id}.md`), `\n### ${time()} · ${heading}\n\n${text.trim()}\n`);
  }

  log(from: string, heading: string, text: string) {
    const file = path.join(this.dir, 'LOG.md');
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# Log of run ${this.runId}\n`);
    fs.appendFileSync(file, `\n## ${time()} · ${from} · ${heading}\n\n${text.trim()}\n`);
  }

  report(from: string, to: string, status: string, summary: string) {
    const file = path.join(this.dir, 'REPORT.md');
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# Run ${this.runId}\n`);
    fs.appendFileSync(file, `\n## ${time()} · ${from} → ${to} [${status}]\n\n${summary.trim()}\n`);
  }

  saveMeta(meta: { runId: string }) {
    fs.writeFileSync(path.join(this.dir, 'run.json'), JSON.stringify(meta, null, 2));
    // Global index so `orq --resume` can list runs of every directory.
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    fs.writeFileSync(path.join(INDEX_DIR, `${meta.runId}.json`), JSON.stringify({ ...meta, agents: undefined, dir: this.dir }, null, 2));
  }

  /** Events of a previous run (optionally only some kinds), for replaying history on resume. */
  readEvents(kinds?: readonly string[]): Record<string, any>[] {
    return readRunEvents(this.dir, this.runId, kinds);
  }
}

export function newRunId() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
