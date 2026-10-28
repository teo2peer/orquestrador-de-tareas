import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recommendedMode } from './app-context.tsx';
import { loadRun } from '../runs.ts';

describe('orq --resume without the dialog', () => {
  test("decides per agent ('auto') for a readable run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-resume-cli-'));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: 'r-cli', cwd: dir, dir, permMode: 'auto', startedAt: 0, updatedAt: 0, agents: [] }));
    expect(recommendedMode(dir)).toBe('auto');
    fs.rmSync(dir, { recursive: true });
  });
  test('an unreadable run falls back to light (no saved choice in the test home)', () => {
    expect(recommendedMode('/nonexistent/orq-run')).toBe('light');
  });
});

import { estimateResume } from '../resume.ts';

describe('dialog figure follows the pill', () => {
  test('estimateResume with the recommendation the dialog already has keeps its decision and figure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-resume-rec-'));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: 'r-rec', cwd: dir, dir, permMode: 'auto', startedAt: 0, updatedAt: 0, agents: [] }));
    const rec = { agents: [], recommended: 'full' as const, reason: { kind: 'warm' as const, maxAgeMs: 60_000 }, fullWarm: 20_000, fullCold: 180_000 };
    const est = estimateResume(loadRun(dir), undefined, undefined, rec);
    expect(est.recommended).toBe('full');
    expect(est.reason).toEqual(rec.reason);
    expect(est.full).toBe(20_000);
    fs.rmSync(dir, { recursive: true });
  });
});
