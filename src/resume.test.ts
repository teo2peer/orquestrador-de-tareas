import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HQ } from './hq.ts';
import { SUMMARY_MAX_CHARS, buildResumeSummary, estimateResume, recommendResume } from './resume.ts';
import type { Role, RunMeta } from './types.ts';

/** Simulated tmux for deliveries: the paste never lingers in the input box and confirms at once. */
function simulateTmux(hq: any) {
  hq.deliveryTiming = { pollMs: 1, pasteWaitMs: 0, backoffMs: [1] };
  hq.inputShows = () => false;
  hq.pressEnter = () => {};
  hq.clearInput = () => {};
}


const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-resume-test-'));
const RUN_ID = '19990101-000000'; // fixed id: one run dir per test cwd
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const role = (id: string): Role => ({ id, name: id, title: `Title ${id}`, accessory: 'none', color: 'blue', writes: true, description: '', prompt: '', scope: 'project', file: '' });

function meta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: RUN_ID,
    cwd: '/proj',
    dir: path.join(tmp, 'run'),
    permMode: 'auto',
    lead: 'cto',
    startedAt: 0,
    updatedAt: 0,
    agents: [
      { id: 'cto', title: 'CTO', sessionId: 's-cto', tmux: `orq-${RUN_ID}-cto`, status: 'stopped', role: role('cto') },
      { id: 'backend', title: 'Backend', sessionId: 's-be', tmux: `orq-${RUN_ID}-backend`, status: 'stopped', role: role('backend') },
    ],
    ...over,
  };
}

const EVENTS = [
  { ts: 1, kind: 'message', id: 'm1', from: 'cto', to: 'backend', type: 'task', body: 'Old task' },
  { ts: 2, kind: 'message', id: 'm2', from: 'backend', to: 'cto', type: 'report', body: '[done] Old task finished' },
  { ts: 3, kind: 'message', id: 'm3', from: 'cto', to: 'backend', type: 'task', body: 'Implement resume light' },
  { ts: 4, kind: 'timeline', agent: 'backend', tkind: 'status', text: 'Writing resume.ts' },
  { ts: 5, kind: 'timeline', agent: 'backend', tkind: 'tool', text: 'Edit /proj/src/resume.ts' },
  { ts: 6, kind: 'timeline', agent: 'backend', tkind: 'tool', text: 'Write /proj/src/resume.test.ts' },
  { ts: 7, kind: 'timeline', agent: 'backend', tkind: 'tool', text: 'Bash bun test' },
  { ts: 8, kind: 'message', id: 'm4', from: 'backend', to: 'cto', type: 'report', body: '[partial] halfway' },
  { ts: 9, kind: 'message', id: 'm5', from: 'qa', to: 'backend', type: 'message', body: 'Which command runs the tests?' },
  { ts: 10, kind: 'timeline', agent: 'cto', tkind: 'status', text: 'cto stuff' },
];

describe('buildResumeSummary', () => {
  test('includes role, status, pending task, last report, unanswered messages, files and recent activity', () => {
    const s = buildResumeSummary('backend', EVENTS, meta());
    expect(s).toContain('Title backend (`backend`)');
    expect(s).toContain('Writing resume.ts');
    expect(s).toMatch(/## Latest goal \(open task\)\n.*Implement resume light/);
    expect(s).toContain('[partial] halfway');
    expect(s).toContain('Which command runs the tests?');
    expect(s).toContain('- src/resume.ts');
    expect(s).toContain('- src/resume.test.ts');
    expect(s).toContain('Bash bun test');
    expect(s).toMatch(/## Team \(one line each\)\n- `cto` \(Title cto\) \[coordinator\]: cto stuff/);
    expect(s).toContain('## Recent messages');
  });

  test('edited files come with their full path from edit events (timeline text is truncated)', () => {
    const cwd = '/Users/someone/PersonalData/Nextcloud/proyectos/Personales/2_Utilidades/Orquestrador de tareas';
    const file = `${cwd}/src/a/very/long/path/that/goes/beyond/ninety/characters/component.tsx`;
    const ev = [
      { ts: 1, kind: 'timeline', agent: 'backend', tkind: 'tool', text: `Edit ${file}`.slice(0, 89) + '…' },
      { ts: 1, kind: 'edit', agent: 'backend', file },
      { ts: 2, kind: 'edit', agent: 'cto', file: `${cwd}/other.ts` },
    ];
    const s = buildResumeSummary('backend', ev, meta({ cwd }));
    expect(s).toContain('- src/a/very/long/path/that/goes/beyond/ninety/characters/component.tsx');
    expect(s).not.toContain('other.ts');
    expect(s).not.toMatch(/Files you edited\n[^#]*…/);
  });

  test('the team section lists at most 20 colleagues', () => {
    const m = meta();
    for (let i = 0; i < 25; i++) m.agents.push({ ...m.agents[0]!, id: `x${i}` });
    const s = buildResumeSummary('backend', [], m);
    expect(s).toContain('- +6 más (`team`)');
    expect(s).not.toContain('`x24`');
  });

  test('is deterministic', () => {
    expect(buildResumeSummary('backend', EVENTS, meta())).toBe(buildResumeSummary('backend', EVENTS, meta()));
  });

  test('area agents keep their OWNED PATHS in the summary', () => {
    const m = meta();
    m.agents[1]!.role = { ...role('backend'), area: { paths: ['src/*', 'src/ui'] } };
    expect(buildResumeSummary('backend', EVENTS, m)).toContain('OWNED PATHS: `src/*`, `src/ui`');
  });

  test('marks the coordinator and survives an agent without events', () => {
    const s = buildResumeSummary('cto', [], meta());
    expect(s).toContain('coordinator of the team');
    expect(s).toContain('# Session resumed (light)');
  });

  test('stays within ~3k tokens with a huge history', () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({ ts: i, kind: 'timeline', agent: 'backend', tkind: 'tool', text: `Edit /proj/src/f${i}.ts ${'x'.repeat(500)}` }));
    const msgs = Array.from({ length: 50 }, (_, i) => ({ ts: 5000 + i, kind: 'message', id: `q${i}`, from: 'qa', to: 'backend', type: 'question', body: 'y'.repeat(5000) }));
    const goal = { ts: 4000, kind: 'message', id: 'g', from: 'cto', to: 'backend', type: 'task', body: `GOAL ${'z'.repeat(3000)}` };
    const s = buildResumeSummary('backend', [...big, goal, ...msgs], meta());
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(s).toContain('## You');
    // Priorities: the goal and the team survive; the timeline goes first.
    expect(s).toContain('GOAL zzz');
    expect(s).toContain('## Team');
    expect(s).not.toContain('## Recent activity');
  });
});

describe('estimateResume', () => {
  test('full is null without transcripts; light counts the summaries', () => {
    const m = meta({ dir: path.join(tmp, 'none') });
    const e = estimateResume(m, () => false);
    expect(e.full).toBeNull();
    expect(e.light).toBeGreaterThan(0);
    expect(e.lightPerAgent).toBe(Math.round(e.light / 2));
  });

  test('full is transcript bytes / 4', () => {
    const dir = path.join(tmp, 'est');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 't.jsonl'), 'x'.repeat(4000));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), EVENTS.map((e) => JSON.stringify(e)).join('\n'));
    const m = meta({ dir });
    m.agents[0]!.transcript = path.join(dir, 't.jsonl');
    m.agents[1]!.transcript = path.join(dir, 'missing.jsonl');
    const e = estimateResume(m, () => false);
    // No usage in the transcript: context = bytes/4 = 1000; age unknown ⇒ cold 1-hour write ×2.
    expect(e).toMatchObject({ full: 2000, fullCold: 2000, recommended: 'light', reason: { kind: 'unknown' } });
    // Live agents are reattached, not resumed: excluded.
    expect(estimateResume(m, (name) => name === `orq-${RUN_ID}-cto`)).toMatchObject({ full: null, lightPerAgent: expect.any(Number) });
    expect(e.light).toBeLessThan(2 * (SUMMARY_MAX_CHARS / 4));
  });
});

describe('estimateResume: recommended mode by cache age', () => {
  const T = Date.parse('2026-10-13T12:00:00.000Z');
  /** A transcript whose last request was at `at`, with context `ctx` and 1h or 5m cache writes. */
  function transcriptAt(name: string, at: number, ctx: number, ttl: '1h' | '5m' = '1h') {
    const f = path.join(tmp, `${name}.jsonl`);
    const cc = ttl === '1h' ? { ephemeral_1h_input_tokens: 10 } : { ephemeral_5m_input_tokens: 10 };
    fs.writeFileSync(f, JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: name, usage: { input_tokens: ctx, cache_creation: cc } } }) + '\n');
    return f;
  }
  const run = (...transcripts: (string | undefined)[]) =>
    meta({ dir: path.join(tmp, 'est-none'), agents: transcripts.map((t, i) => ({ id: `a${i}`, title: 'A', sessionId: 's', tmux: `orq-${RUN_ID}-a${i}`, status: 'stopped' as const, role: role(`a${i}`), transcript: t })) });
  const H = 3_600_000;

  test('just before the 1-hour TTL is warm (full); exactly at it is cold (light)', () => {
    const before = estimateResume(run(transcriptAt('b1', T - H + 1, 100_000)), () => false, T);
    expect(before).toMatchObject({ recommended: 'full', reason: { kind: 'warm', maxAgeMs: H - 1 } });
    expect(before.agents).toEqual([{ id: 'a0', lastRequestAt: T - H + 1, ageMs: H - 1, ttlMs: H, warm: true }]);
    expect(before.full).toBe(before.fullWarm);
    const at = estimateResume(run(transcriptAt('b2', T - H, 100_000)), () => false, T);
    expect(at).toMatchObject({ recommended: 'light', reason: { kind: 'cold', maxAgeMs: H } });
    expect(at.full).toBe(at.fullCold);
  });

  test('agents without a transcript are left out of the decision; none at all ⇒ light', () => {
    const none = estimateResume(run(undefined), () => false, T);
    expect(none).toMatchObject({ recommended: 'light', reason: { kind: 'unknown' }, agents: [], fullWarm: null, fullCold: null, full: null });
    const withIdle = recommendResume(run(transcriptAt('x1', T - 60_000, 10_000), undefined), () => false, T);
    expect(withIdle).toMatchObject({ recommended: 'full', agents: [{ id: 'a0', warm: true }] });
  });

  test('an agent without transcript + the rest warm ⇒ full; it does not count in agents nor maxAgeMs', () => {
    const e = estimateResume(run(transcriptAt('y1', T - 120_000, 10_000), undefined, transcriptAt('y2', T - 60_000, 10_000)), () => false, T);
    expect(e.recommended).toBe('full');
    expect(e.agents.map((x) => x.id)).toEqual(['a0', 'a2']);
    expect(e.reason).toEqual({ kind: 'warm', maxAgeMs: 120_000 });
  });

  test('a transcript without any request yet has an unknown age ⇒ light', () => {
    const f = path.join(tmp, 'nousage.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    const e = recommendResume(run(f, transcriptAt('x2', T - 60_000, 10_000)), () => false, T);
    expect(e).toMatchObject({ recommended: 'light', reason: { kind: 'unknown', maxAgeMs: 60_000 } });
    expect(e.agents[0]).toEqual({ id: 'a0', ttlMs: H, warm: false });
  });

  test('estimateResume reuses a given recommendation (same decision for the pill and the full cost)', () => {
    const m = run(transcriptAt('g1', T - 60_000, 10_000));
    const rec = recommendResume(m, () => false, T);
    // Two hours later the cache is cold, but the given recommendation is the one used.
    const e = estimateResume(m, () => false, T + 2 * 3_600_000, rec);
    expect(e).toMatchObject({ recommended: 'full', reason: rec.reason, agents: rec.agents, full: rec.fullWarm });
  });

  test('recommendResume is the cheap part of estimateResume', () => {
    const m = run(transcriptAt('r1', T - 60_000, 10_000));
    const { full, light, lightPerAgent, ...rec } = estimateResume(m, () => false, T);
    expect(recommendResume(m, () => false, T)).toEqual(rec);
  });

  test('mixed agents: one warm and one cold recommends light', () => {
    const e = estimateResume(run(transcriptAt('m1', T - 60_000, 50_000), transcriptAt('m2', T - 2 * H, 50_000)), () => false, T);
    expect(e).toMatchObject({ recommended: 'light', reason: { kind: 'cold', maxAgeMs: 2 * H } });
    expect(e.agents.map((x) => x.warm)).toEqual([true, false]);
  });

  test('5-minute caches: cold after 5 min, written at 1.25×', () => {
    const warm = estimateResume(run(transcriptAt('f1', T - 4 * 60_000, 100_000, '5m')), () => false, T);
    expect(warm).toMatchObject({ recommended: 'full', agents: [{ ttlMs: 300_000, warm: true }] });
    const cold = estimateResume(run(transcriptAt('f2', T - 5 * 60_000, 100_000, '5m')), () => false, T);
    expect(cold.recommended).toBe('light');
    expect(cold.fullCold).toBe(100_000 * 1.25);
  });

  test('warm < cold, with the documented formula', () => {
    const e = estimateResume(run(transcriptAt('w1', T - 60_000, 100_000)), () => false, T);
    expect(e.fullWarm).toBe(100_000 * 0.1 + 2_000 * 2);
    expect(e.fullCold).toBe(100_000 * 2);
    expect(e.fullWarm!).toBeLessThan(e.fullCold!);
  });

  test('live and dormant agents are not counted', () => {
    const m = run(transcriptAt('l1', T - 2 * H, 1000), transcriptAt('l2', T - 60_000, 1000));
    m.agents[0]!.status = 'dormant';
    expect(estimateResume(m, () => false, T)).toMatchObject({ recommended: 'full', agents: [{ id: 'a1' }] });
    expect(estimateResume(m, (name) => name.endsWith('a1'), T)).toMatchObject({ recommended: 'light', agents: [], reason: { kind: 'unknown' } });
  });
});

describe('HQ restore', () => {
  /** Restore a run without touching tmux/claude: launch is stubbed. */
  function restore(resumeMode: 'light' | 'full' | 'auto' | undefined, transcript?: string, events: Record<string, any>[] = EVENTS, live = false) {
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    const m = meta({ cwd, dir: path.join(cwd, '.orq', 'runs', RUN_ID) });
    m.agents[1]!.transcript = transcript;
    const hq = new HQ({ roles: [], permMode: 'auto', resume: m, resumeMode });
    fs.writeFileSync(path.join(hq.store.dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const launched: [string, boolean][] = [];
    (hq as any).launch = (a: { id: string }, resume = false) => launched.push([a.id, resume]);
    (hq as any).sessionAlive = () => live;
    const typed: string[] = [];
    (hq as any).typeInto = (_: unknown, text: string) => typed.push(text);
    simulateTmux(hq);
    hq.wakeDelayMs = 60_000;
    (hq as any).restore(m);
    (hq as any).clearWakeTimers();
    return { hq, launched, typed };
  }

  // A run with delivery tracking: m3 and m5 were never delivered to backend.
  const TRACKED = [{ ts: 0, kind: 'run_start', v: 2 }, ...EVENTS, { ts: 3, kind: 'delivered', agent: 'backend', ids: ['m1'] }, { ts: 3, kind: 'hook', agent: 'backend', event: 'Stop' }];

  test('undelivered messages are re-queued: full', () => {
    const t = path.join(tmp, 'tr-full.jsonl');
    fs.writeFileSync(t, '{}\n');
    const { hq } = restore('full', t, TRACKED);
    expect(hq.agents.get('backend')!.inbox.map((m) => m.id)).toEqual(['m3', 'm5']);
  });

  test('full: messages delivered in a turn that never finished (no Stop after them) go again', () => {
    const t = path.join(tmp, 'tr-cut.jsonl');
    fs.writeFileSync(t, '{}\n');
    const cut = [...TRACKED, { ts: 4, kind: 'delivered', agent: 'backend', ids: ['m3'] }];
    const { hq } = restore('full', t, cut);
    expect(hq.agents.get('backend')!.inbox.map((m) => m.id)).toEqual(['m3', 'm5']);
    const finished = [...cut, { ts: 5, kind: 'hook', agent: 'backend', event: 'Stop' }];
    expect(restore('full', t, finished).hq.agents.get('backend')!.inbox.map((m) => m.id)).toEqual(['m5']);
  });

  test('open work lists the 5 most recent open tasks and counts the older ones', () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({ ts: 10 + i, kind: 'message', id: `t${i}`, from: 'cto', to: 'backend', type: 'task', body: `open task ${i}` }));
    const s = buildResumeSummary('backend', tasks, meta());
    const openWork = s.split('## Open work')[1]!.split('\n## ')[0]!;
    expect(openWork).toContain('+3 more older tasks without a done report');
    expect(openWork).not.toContain('open task 2');
    for (const i of [3, 4, 5, 6, 7]) expect(openWork).toContain(`open task ${i}`);
    expect(s).toMatch(/Latest goal \(open task\)\n.*open task 8/);
  });

  test("'auto' resumes warm agents full and cold ones light", () => {
    const stamp = (name: string, at: number) => {
      const f = path.join(tmp, `${name}.jsonl`);
      fs.writeFileSync(f, JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: name, usage: { input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } } }) + '\n');
      return f;
    };
    const warm = restore('auto', stamp('auto-warm', Date.now() - 60_000), TRACKED);
    expect(warm.launched).toContainEqual(['backend', true]);
    const cold = restore('auto', stamp('auto-cold', Date.now() - 2 * 3_600_000), TRACKED);
    expect(cold.launched).toContainEqual(['backend', false]);
    expect(cold.hq.agents.get('backend')!.inbox[0]!.body).toContain('# Session resumed (light)');
    expect(restore('auto', undefined, TRACKED).launched).toContainEqual(['backend', false]);
  });

  test('undelivered messages are re-queued: light, after the summary', () => {
    const { hq } = restore('light', undefined, TRACKED);
    const inbox = hq.agents.get('backend')!.inbox;
    expect(inbox[0]!.body).toContain('# Session resumed (light)');
    expect(inbox.slice(1).map((m) => m.id)).toEqual(['m3', 'm5']);
  });

  test('undelivered messages are re-queued: live sessions reattached', () => {
    const { hq, typed } = restore('full', undefined, TRACKED, true);
    // Live and idle in 'max': delivered right away.
    expect(typed.find((t) => t.includes('Implement resume light') && t.includes('Which command runs the tests?'))).toBeDefined();
    expect(hq.agents.get('backend')!.timeline.some((e) => e.text === 'Reconectado a la sesión viva')).toBe(true);
  });

  test('re-queued messages are not repeated inside the summary', () => {
    const { hq } = restore('light', undefined, TRACKED);
    const [summary, ...rest] = hq.agents.get('backend')!.inbox;
    expect(rest.map((m) => m.id)).toEqual(['m3', 'm5']);
    expect(summary!.body).toContain('2 messages you never received follow this summary in full');
    expect(summary!.body).not.toContain('Implement resume light');
    expect(summary!.body).not.toContain('Which command runs the tests?');
  });

  test('a resumed run with history takes at most its first task as title, never new messages', () => {
    const { hq } = restore('light');
    expect(hq).toMatchObject({ title: 'Old task', titleProvisional: true });
    const noTasks = restore('light', undefined, EVENTS.filter((e) => e.type !== 'task')).hq;
    expect(noTasks.title).toBeUndefined();
    noTasks.post('user', 'cto', 'Sí, adelante', 'message');
    noTasks.post('cto', 'backend', 'new task', 'task');
    expect(noTasks.title).toBeUndefined();
  });

  test('summaries of earlier light resumes are not re-queued', () => {
    const old = { ts: 4, kind: 'message', id: 'sum', from: 'system', to: 'backend', type: 'system', body: '# Session resumed (light)\nold' };
    const { hq } = restore('light', undefined, [...TRACKED, old]);
    const inbox = hq.agents.get('backend')!.inbox;
    expect(inbox.filter((m) => m.body.startsWith('# Session resumed'))).toHaveLength(1);
    expect(inbox.map((m) => m.id)).not.toContain('sum');
  });

  test('old runs without delivery tracking re-queue nothing', () => {
    const t = path.join(tmp, 'tr-old.jsonl');
    fs.writeFileSync(t, '{}\n');
    expect(restore('full', t).hq.agents.get('backend')!.inbox).toEqual([]);
    const live = restore('full', undefined, EVENTS, true);
    expect(live.hq.agents.get('backend')!.inbox).toEqual([]);
    expect(live.typed).toEqual([]);
  });

  test('light: new session id, previous kept, summary queued, timeline entry', () => {
    const { hq, launched } = restore('light');
    const be = hq.agents.get('backend')!;
    expect(launched).toContainEqual(['backend', false]);
    expect(be.sessionId).not.toBe('s-be');
    expect(be.prevSessionIds).toEqual(['s-be']);
    expect(be.inbox.at(-1)!.body).toContain('# Session resumed (light)');
    expect(be.timeline.some((e) => e.text === 'Reanudado con resumen (ligera)')).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(hq.store.dir, 'run.json'), 'utf8'));
    expect(saved.agents.find((a: any) => a.id === 'backend').prevSessionIds).toEqual(['s-be']);
  });

  test('area roles survive a light resume (summary and run.json)', () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    const m = meta({ cwd, dir: path.join(cwd, '.orq', 'runs', RUN_ID), mode: 'area' });
    m.agents[1]!.role = { ...role('area-src'), id: 'backend', area: { paths: ['src'] } };
    const hq = new HQ({ roles: [], permMode: 'auto', resume: m, resumeMode: 'light' });
    (hq as any).launch = () => {};
    (hq as any).restore(m);
    expect(hq.mode).toBe('area');
    expect(hq.agents.get('backend')!.role.area).toEqual({ paths: ['src'] });
    expect(hq.agents.get('backend')!.inbox.at(-1)!.body).toContain('OWNED PATHS: `src`');
    const saved = JSON.parse(fs.readFileSync(path.join(hq.store.dir, 'run.json'), 'utf8'));
    expect(saved.agents.find((a: any) => a.id === 'backend').role.area).toEqual({ paths: ['src'] });
  });

  test('full with a transcript keeps the session; without one it falls back to light', () => {
    const t = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(t, '{}\n');
    const { hq, launched } = restore(undefined, t);
    expect(launched).toContainEqual(['backend', true]);
    expect(hq.agents.get('backend')!.sessionId).toBe('s-be');
    expect(hq.agents.get('backend')!.timeline.some((e) => e.text === 'Reanudado con conversación completa')).toBe(true);
    // cto has no transcript: always light.
    expect(launched).toContainEqual(['cto', false]);
    expect(hq.agents.get('cto')!.prevSessionIds).toEqual(['s-cto']);
  });
});
