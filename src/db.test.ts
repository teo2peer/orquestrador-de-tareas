import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunDb, toMatch } from './db.ts';
import { readRunEvents, searchProject } from './store.ts';
import { buildResumeSummary } from './resume.ts';
import type { RunMeta } from './types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-db-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('RunDb', () => {
  const db = new RunDb(path.join(tmp, 'a', 'orq.db'));
  db.insert('r1', { ts: 1, kind: 'message', id: 'm1', from: 'cto', to: 'be', type: 'task', body: 'Migrar la autenticación a JWT' });
  db.insert('r1', { ts: 2, kind: 'note', agent: 'be', text: 'Los tests corren con bun test' });
  db.insert('r1', { ts: 3, kind: 'timeline', agent: 'be', tkind: 'tool', text: 'Bash secretword' });
  db.insert('r2', { ts: 4, kind: 'message', id: 'm2', from: 'cto', to: 'be', type: 'task', body: 'Otra autenticación en otro run' });

  test('events come back in order, filtered by kind', () => {
    expect(db.events('r1').map((e) => e.kind)).toEqual(['message', 'note', 'timeline']);
    expect(db.events('r1', ['note'])).toHaveLength(1);
  });
  test('search ignores accents, scopes by run and skips tool noise by default', () => {
    expect(db.search('autenticacion', { run: 'r1' })).toHaveLength(1);
    expect(db.search('autenticacion').map((h) => h.run).sort()).toEqual(['r1', 'r2']);
    expect(db.search('secretword')).toHaveLength(0);
    expect(db.search('secretword', { kinds: ['timeline'] })).toHaveLength(1);
  });
  test('query text cannot inject FTS operators', () => {
    expect(toMatch('foo" OR NEAR(bar) *')).toBe('"foo" OR "or" OR "near" OR "bar"');
    expect(() => db.search('"( ) AND * ^')).not.toThrow();
    expect(db.search('!!')).toEqual([]);
  });
});

test('concurrent processes write the same DB without losing events (busy timeout)', async () => {
  const file = path.join(tmp, 'shared', 'orq.db');
  const script = `import { RunDb } from ${JSON.stringify(path.resolve(import.meta.dir, 'db.ts'))};
    const db = new RunDb(${JSON.stringify(file)});
    for (let i = 0; i < 300; i++) db.insert(process.argv[1], { ts: i, kind: 'note', agent: 'x', text: 'n' + i });`;
  const spawn = (run: string) => Bun.spawn(['bun', '-e', script, run], { stdout: 'ignore', stderr: 'pipe' });
  const procs = [spawn('ra'), spawn('rb'), spawn('rc')];
  const codes = await Promise.all(procs.map((p) => p.exited));
  expect(codes).toEqual([0, 0, 0]);
  const db = new RunDb(file);
  expect(['ra', 'rb', 'rc'].map((r) => db.count(r))).toEqual([300, 300, 300]);
}, 30_000);

describe('readRunEvents', () => {
  test('rebuilds a run whose index only has the newest events (index created while the run was live)', () => {
    const dir = path.join(tmp, 'c', 'runs', 'r7');
    fs.mkdirSync(dir, { recursive: true });
    const old = [{ ts: 1, kind: 'note', agent: 'x', text: 'antiguo' }, { ts: 2, kind: 'note', agent: 'x', text: 'medio' }, { ts: 3, kind: 'note', agent: 'x', text: 'nuevo' }];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), old.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const db = new RunDb(path.join(tmp, 'c', 'runs', 'orq.db'));
    db.insert('r7', old[2]!); // only the last event reached the index
    db.close();
    expect(readRunEvents(dir, 'r7').map((e) => e.text)).toEqual(['antiguo', 'medio', 'nuevo']);
  });

  test('imports a run that only has events.jsonl, then serves it from the DB', () => {
    const dir = path.join(tmp, 'b', 'runs', 'r9');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [{ ts: 1, kind: 'note', agent: 'x', text: 'hi' }, { ts: 2, kind: 'edit', agent: 'x', file: 'f' }].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
    expect(readRunEvents(dir, 'r9', ['note']).map((e) => e.text)).toEqual(['hi']);
    fs.rmSync(path.join(dir, 'events.jsonl'));
    expect(readRunEvents(dir, 'r9')).toHaveLength(2);
  });
});

test('the resume summary carries the agent\'s own notes, not the others\'', () => {
  const meta = { runId: 'r', cwd: '/p', dir: '/p/.orq/runs/r', permMode: 'auto', lead: 'cto', startedAt: 0, updatedAt: 0, agents: [{ id: 'be', title: 'Backend', sessionId: 's', tmux: 't', status: 'stopped' }] } as unknown as RunMeta;
  const s = buildResumeSummary('be', [{ ts: 1, kind: 'note', agent: 'be', text: 'usar pnpm' }, { ts: 2, kind: 'note', agent: 'qa', text: 'ajeno' }], meta);
  expect(s).toContain('## Your notes');
  expect(s).toContain('usar pnpm');
  expect(s).not.toContain('ajeno');
});

test('searchProject finds notes across the runs of a directory, and is empty without a DB', () => {
  const cwd = path.join(tmp, 'proj');
  expect(searchProject(cwd, 'algo')).toEqual([]);
  const dir = path.join(cwd, '.orq', 'runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: 1, kind: 'note', agent: 'be', text: 'el token expira en 15 minutos' }) + '\n');
  readRunEvents(dir, 'r1'); // imports the jsonl into the DB
  expect(searchProject(cwd, 'expira').map((h) => h.run)).toEqual(['r1']);
});
