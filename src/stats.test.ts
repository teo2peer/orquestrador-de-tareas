import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatStats, runStats } from './stats.ts';
import type { RunMeta } from './types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-stats-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const line = (id: string, u: Record<string, unknown>) => JSON.stringify({ type: 'assistant', message: { id, usage: u } });

test('stats split the cost by type and agent, and hint when notes were never used', () => {
  const dir = path.join(tmp, 'runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(tmp, 'a.jsonl');
  const b = path.join(tmp, 'b.jsonl');
  fs.writeFileSync(a, line('1', { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 10 }) + '\n');
  fs.writeFileSync(b, line('2', { input_tokens: 10, output_tokens: 10 }) + '\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [{ ts: 1, kind: 'message', id: 'm', from: 'x', to: 'y', type: 'task', body: 'hi' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const meta = { runId: 'r1', cwd: tmp, dir, permMode: 'auto', lead: 'a', startedAt: 0, updatedAt: 0, title: 'T', agents: [
    { id: 'a', title: 'A', sessionId: 's1', tmux: 't', status: 'idle', transcript: a, prevSessionIds: ['old'] },
    { id: 'b', title: 'B', sessionId: 's2', tmux: 't', status: 'idle', transcript: b },
  ] } as unknown as RunMeta;
  const s = runStats(meta);
  expect(s.perAgent.map((x) => x.id)).toEqual(['a', 'b']);
  expect(s.cacheHit).toBeCloseTo(9000 / 10110, 3);
  expect(s.restarts).toBe(1);
  expect(s.messages).toBe(1);
  expect(s.notes).toBe(0);
  const text = formatStats(meta, s);
  expect(text).toContain('lectura de caché');
  expect(text).toContain('ningún agente usó `memory save`');
});
