import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HQ, ROLE_TOOL_DEFAULTS, SAVER_TOOLS, TITLE_MAX, USER, inputBox, profileFlags, userMcpServers } from './hq.ts';
import { renameRun } from './runs.ts';
import { INDEX_DIR } from './store.ts';
import type { Agent, Role } from './types.ts';

// Timer-driven behaviour (wake-ups, retries, watchdogs) runs on a simulated clock: deterministic.
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});
/** Advance the simulated clock (timers and Date.now). */
const tick = (ms: number) => jest.advanceTimersByTime(ms);

/** Simulated tmux for deliveries: the paste never lingers in the input box and confirms at once. */
function simulateTmux(hq: any) {
  hq.deliveryTiming = { pollMs: 1, pasteWaitMs: 0, backoffMs: [1] };
  hq.inputShows = () => false;
  hq.pressEnter = () => {};
  hq.clearInput = () => {};
}


const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-hq-test-'));
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));
// HQs on a fixed run id (ORQ_HOME is a temporary dir in tests, see test-setup.ts).
const FAKE_RUN = '19990101-000001';
const newHQ = (profile?: 'saver' | 'balanced' | 'max') =>
  new HQ({ roles: [], permMode: 'auto', resume: { runId: FAKE_RUN, cwd, dir: '', permMode: 'auto', profile, startedAt: 0, updatedAt: 0, agents: [] } });
const findIndex = (runId: string) => JSON.parse(fs.readFileSync(path.join(INDEX_DIR, `${runId}.json`), 'utf8'));

const role: Role = { id: 'cto', name: 'CTO', title: 'CTO', accessory: 'none', color: 'cyan', writes: false, description: '', prompt: '', scope: 'project', file: '' };

/** An HQ with one agent that is busy, so delivering messages never touches tmux. */
function setup() {
  const hq = newHQ();
  const agent: Agent = { id: 'cto', role, status: 'working', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
  hq.agents.set('cto', agent);
  const tool = (name: string, args: Record<string, unknown>) => (hq as any).onTool('cto', name, args);
  return { hq, agent, tool };
}

describe('memory', () => {
  test('the first done report reminds the agent to save notes, once, and not if it already has notes', () => {
    // Runs before any test saves a note as `cto`: the tests share one run id and DB.
    const { tool } = setup();
    expect(tool('report', { to: 'user', summary: 'ok', status: 'done' })).toContain('`memory`');
    expect(tool('report', { to: 'user', summary: 'ok', status: 'done' })).toBe('reported');
    const b = setup();
    b.tool('memory', { action: 'save', text: 'fact' });
    expect(b.tool('report', { to: 'user', summary: 'ok', status: 'done' })).toBe('reported');
  });

  test('save then search finds the note; empty input is rejected', () => {
    const { tool } = setup();
    expect(() => tool('memory', { action: 'save', text: ' ' })).toThrow('empty');
    tool('memory', { action: 'save', text: 'La API usa tokens JWT con expiración corta' });
    expect(tool('memory', { action: 'search', text: 'expiracion jwt' })).toContain('[note]');
    expect(tool('memory', { action: 'search', text: 'zzzinexistente' })).toBe('No matches.');
  });
});

describe('ask_user', () => {
  test('options reach the message and the notice', () => {
    const { hq, tool } = setup();
    tool('ask_user', { question: '¿Qué base de datos?', options: ['Postgres (recomendado)', 'SQLite'] });
    const msg = hq.messages.at(-1)!;
    expect(msg).toMatchObject({ from: 'cto', to: USER, type: 'question', body: '¿Qué base de datos?', options: ['Postgres (recomendado)', 'SQLite'] });
    expect(hq.notices).toHaveLength(1);
    expect(hq.notices[0]).toMatchObject({ kind: 'question', from: 'cto', options: ['Postgres (recomendado)', 'SQLite'], msgId: msg.id });
  });

  test('options are optional and capped at 4', () => {
    const { hq, tool } = setup();
    tool('ask_user', { question: 'a' });
    expect(hq.messages.at(-1)!.options).toBeUndefined();
    tool('ask_user', { question: 'b', options: ['1', '2', '3', '4', '5'] });
    expect(hq.messages.at(-1)!.options).toEqual(['1', '2', '3', '4']);
  });

  test('options are persisted with the message', () => {
    const { hq, tool } = setup();
    tool('ask_user', { question: 'persist?', options: ['Sí', 'No'] });
    const events = fs.readFileSync(path.join(hq.store.dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.find((e) => e.kind === 'message' && e.body === 'persist?')?.options).toEqual(['Sí', 'No']);
  });
});

describe('reply', () => {
  test('posts an answer to the asking agent and resolves the notice', () => {
    const { hq, agent, tool } = setup();
    tool('ask_user', { question: '¿Seguimos?', options: ['Sí', 'No'] });
    const q = hq.messages.at(-1)!;
    const a = hq.reply(q.id, 'Sí. Y documenta la decisión')!;
    expect(a).toMatchObject({ from: USER, to: 'cto', type: 'answer', body: 'Sí. Y documenta la decisión', replyTo: q.id });
    expect(hq.notices).toHaveLength(0);
    expect(hq.answerOf(q.id)?.id).toBe(a.id);
    expect(agent.inbox.at(-1)?.id).toBe(a.id);
    expect((hq as any).formatInbox([a])).toContain('re: "¿Seguimos?"');
  });

  test('closing a notice without answering keeps the question unanswered', () => {
    const { hq, tool } = setup();
    tool('ask_user', { question: 'x' });
    const q = hq.messages.at(-1)!;
    expect(hq.answerOf(q.id)).toBeUndefined();
    expect(hq.reply('missing', 'y')).toBeUndefined();
  });
});

describe('session title', () => {
  const RUN_ID = '19990101-000002';

  /** HQ on a fake run (fixed id) with a lead `cto` and a worker `qa`, both busy so nothing touches tmux. */
  function titled() {
    const hq = new HQ({ roles: [], permMode: 'auto', resume: { runId: RUN_ID, cwd, dir: '', permMode: 'auto', startedAt: 0, updatedAt: 0, agents: [] } });
    hq.lead = 'cto';
    for (const id of ['cto', 'qa'])
      hq.agents.set(id, { id, role: { ...role, id }, status: 'working', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 });
    const tool = (agent: string, name: string, args: Record<string, unknown>) => (hq as any).onTool(agent, name, args);
    return { hq, tool };
  }
  const saved = () => JSON.parse(fs.readFileSync(path.join(cwd, '.orq', 'runs', RUN_ID, 'run.json'), 'utf8'));

  test("provisional title from the user's first message to the lead, truncated", () => {
    const { hq } = titled();
    hq.post(USER, 'qa', 'not to the lead');
    expect(hq.title).toBeUndefined();
    hq.post(USER, 'cto', 'Añade un modo de composición del equipo por partes del código con validación de solapes');
    expect(hq.title!.length).toBeLessThanOrEqual(50);
    expect(hq.title).toStartWith('Añade un modo de composición');
    expect(hq.titleProvisional).toBe(true);
    hq.post(USER, 'cto', 'second message');
    expect(hq.title).toStartWith('Añade');
    expect(saved()).toMatchObject({ title: hq.title, titleProvisional: true });
  });

  test("the user's answers never give the provisional title", () => {
    const { hq } = titled();
    hq.post(USER, 'cto', 'Sí, adelante', 'answer');
    expect(hq.title).toBeUndefined();
    hq.post(USER, 'cto', 'Rediseña la barra superior', 'task');
    expect(hq).toMatchObject({ title: 'Rediseña la barra superior', titleProvisional: true });
  });

  test('without a user message, the first task gives the provisional title', () => {
    const { hq } = titled();
    hq.post('cto', 'qa', 'Valida AC1 a AC5', 'task');
    expect(hq).toMatchObject({ title: 'Valida AC1 a AC5', titleProvisional: true });
  });

  test('set_title: lead only, at most 6 words, definitive', () => {
    const { hq, tool } = titled();
    hq.post(USER, 'cto', 'algo provisional');
    expect(() => tool('qa', 'set_title', { title: 'Hola' })).toThrow(/coordinator/);
    expect(() => tool('cto', 'set_title', { title: 'uno dos tres cuatro cinco seis siete' })).toThrow(/6 words/);
    expect(() => tool('cto', 'set_title', { title: '  ' })).toThrow();
    tool('cto', 'set_title', { title: 'Modo de equipo por áreas' });
    expect(hq).toMatchObject({ title: 'Modo de equipo por áreas', titleProvisional: false });
    hq.setTitle('otro provisional', 'auto');
    expect(hq.title).toBe('Modo de equipo por áreas');
    expect(saved()).toMatchObject({ title: 'Modo de equipo por áreas', titleProvisional: false, titleSource: 'lead' });
  });

  test('titles are limited to TITLE_MAX characters', () => {
    const { hq, tool } = titled();
    expect(() => tool('cto', 'set_title', { title: `${'x'.repeat(40)} ${'y'.repeat(30)}` })).toThrow(/60 characters/);
    hq.setTitle('z'.repeat(100));
    expect(hq.title).toBe('z'.repeat(TITLE_MAX));
  });

  test("the user's title wins: set_title is ignored with an explanation, auto never applies", () => {
    const { hq, tool } = titled();
    hq.setTitle('Mi título');
    expect(hq).toMatchObject({ title: 'Mi título', titleProvisional: false, titleSource: 'user' });
    expect(tool('cto', 'set_title', { title: 'Otro título' })).toContain('already named');
    hq.post(USER, 'cto', 'primer mensaje');
    expect(hq.title).toBe('Mi título');
    hq.setTitle('Renombrado');
    expect(hq.title).toBe('Renombrado');
  });

  test('the title survives a resume, and renameRun renames a stopped run', () => {
    const { hq } = titled();
    hq.setTitle('Provisional', 'auto');
    const meta = saved();
    const again = new HQ({ roles: [], permMode: 'auto', resume: meta });
    expect(again).toMatchObject({ title: 'Provisional', titleProvisional: true, titleSource: 'auto' });
    expect(renameRun(RUN_ID, '  Nuevo   título ')).toBe(true);
    expect(saved()).toMatchObject({ title: 'Nuevo título', titleProvisional: false, titleSource: 'user' });
    expect(findIndex(RUN_ID)).toMatchObject({ title: 'Nuevo título', titleProvisional: false, titleSource: 'user' });
    expect(renameRun('19990101-999999', 'x')).toBe(false);
    fs.writeFileSync(path.join(INDEX_DIR, `${RUN_ID}.json`), '{broken');
    expect(renameRun(RUN_ID, 'x')).toBe(false);
  });
});

describe('lead board (T1)', () => {
  /** HQ with lead `cto` and workers `qa`, `backend` (busy, so nothing touches tmux). */
  const RUN_ID = '19990101-000003';
  function team(profile: 'saver' | 'max') {
    const hq = new HQ({ roles: [], permMode: 'auto', resume: { runId: RUN_ID, cwd, dir: '', permMode: 'auto', profile, startedAt: 0, updatedAt: 0, agents: [] } });
    hq.lead = 'cto';
    for (const id of ['cto', 'qa', 'backend'])
      hq.agents.set(id, { id, role: { ...role, id }, status: 'working', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 });
    const hook = (event: string) => (hq as any).onHook('cto', { hook_event_name: event, prompt: 'x' });
    const ctx = (event: string) => hook(event).hookSpecificOutput?.additionalContext as string | undefined;
    return { hq, hook, ctx };
  }

  test('saver: full board on session start, then nothing while nothing changes', () => {
    const { ctx } = team('saver');
    expect(ctx('SessionStart')).toContain('Live team board');
    expect(ctx('UserPromptSubmit')).toBeUndefined();
    expect(ctx('UserPromptSubmit')).toBeUndefined();
  });

  test('saver: one change gives only that change', () => {
    const { hq, ctx } = team('saver');
    ctx('SessionStart');
    hq.agents.get('qa')!.lastDone = 'AC1-AC5 validados';
    const c = ctx('UserPromptSubmit')!;
    expect(c).toMatch(/^Team changes since \d\d:\d\d: qa → done «AC1-AC5 validados»\. \(Full board/);
    expect(c).not.toContain('backend');
    expect(ctx('UserPromptSubmit')).toBeUndefined();
  });

  test('saver: no loss — status, task, notice, joins and leaves all show up in the next turn', () => {
    const { hq, ctx } = team('saver');
    ctx('SessionStart');
    const be = hq.agents.get('backend')!;
    be.status = 'idle';
    be.task = 'T1';
    hq.agents.get('qa')!.notice = 'Permission needed';
    hq.agents.set('ux', { ...be, id: 'ux', status: 'starting', task: '' });
    hq.agents.delete('qa');
    const c = ctx('UserPromptSubmit')!;
    expect(c).toContain('backend: idle «T1»');
    expect(c).toMatch(/ux joined \(CTO, read-only\): starting/);
    expect(c).toContain('qa left the team');
  });

  test('saver: the Stop hook appends the diff to the inbox, team_status gives the full board', () => {
    const { hq, hook } = team('saver');
    hook('SessionStart');
    hq.agents.get('cto')!.inbox.push({ id: 'm', ts: 0, from: 'qa', to: 'cto', type: 'report', body: '[done] ok' });
    hq.agents.get('qa')!.status = 'idle';
    const out = hook('Stop');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Team changes since');
    expect(out.reason).not.toContain('Live team board');
    expect((hq as any).onTool('cto', 'team_status', {})).toContain('Live team board');
  });

  test('max: the full board on every turn', () => {
    const { ctx } = team('max');
    expect(ctx('SessionStart')).toContain('Live team board');
    expect(ctx('UserPromptSubmit')).toContain('Live team board');
    expect(ctx('UserPromptSubmit')).toContain('Live team board');
  });
});

describe('strict MCP (T2)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-mcp-test-'));
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeJson = path.join(home, '.claude.json');
  const writeConfig = (project: Record<string, unknown>, key = cwd) =>
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: { context7: { command: 'ctx7', env: { KEY: 'secret' } }, jira: { command: 'jira-user' }, figma: { command: 'figma-user' }, company: { command: 'evil' } },
        projects: { [key]: { mcpServers: { jira: { command: 'jira-local' } }, ...project } },
      }),
    );
  const projectMcp = (servers: Record<string, unknown>) => fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  afterAll(() => fs.rmSync(path.join(cwd, '.mcp.json'), { force: true }));

  test('local > approved project > user; never `company`; unknown names skipped', () => {
    writeConfig({ enabledMcpjsonServers: ['figma'] });
    projectMcp({ figma: { command: 'figma-project' }, jira: { command: 'jira-project' } });
    expect(userMcpServers(['context7', 'jira', 'figma', 'missing', 'company'], cwd, claudeJson)).toEqual({
      context7: { command: 'ctx7', env: { KEY: 'secret' } },
      jira: { command: 'jira-local' },
      figma: { command: 'figma-project' },
    });
    expect(userMcpServers([], cwd, claudeJson)).toEqual({});
    expect(userMcpServers(['context7'], cwd, path.join(home, 'none.json'))).toEqual({});
  });

  test('an unapproved .mcp.json server is ignored in favour of the user one', () => {
    projectMcp({ context7: { command: 'malicious' } });
    writeConfig({});
    expect(userMcpServers(['context7'], cwd, claudeJson)).toEqual({ context7: { command: 'ctx7', env: { KEY: 'secret' } } });
    writeConfig({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ['context7'] });
    expect(userMcpServers(['context7'], cwd, claudeJson).context7).toEqual({ command: 'ctx7', env: { KEY: 'secret' } });
    writeConfig({ enableAllProjectMcpServers: true });
    expect(userMcpServers(['context7'], cwd, claudeJson).context7).toEqual({ command: 'malicious' });
  });

  test('the project entry is also found by realpath (macOS /var → /private/var)', () => {
    projectMcp({ context7: { command: 'approved' } });
    writeConfig({ enabledMcpjsonServers: ['context7'] }, fs.realpathSync(cwd));
    expect(userMcpServers(['context7'], cwd, claudeJson).context7).toEqual({ command: 'approved' });
    fs.rmSync(path.join(cwd, '.mcp.json'));
  });

  function launchFiles(profile: 'saver' | 'max', mcp?: string[]) {
    const hq = newHQ(profile);
    hq.claudeJson = claudeJson;
    const agent = { id: 'dev', role: { ...role, id: 'dev', mcp }, status: 'starting', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    const script = fs.readFileSync((hq as any).writeLaunchFiles(agent), 'utf8');
    const mcpFile = path.join(hq.privateDir, 'dev', 'mcp.json');
    const config = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    const settings = JSON.parse(fs.readFileSync(path.join(hq.store.dir, 'agents', 'dev', 'settings.json'), 'utf8'));
    const system = fs.readFileSync(path.join(hq.store.dir, 'agents', 'dev', 'system.md'), 'utf8');
    return { hq, script, mcpFile, servers: Object.keys(config.mcpServers).sort(), settings, system };
  }

  test("the run's extra dirs reach every agent (--add-dir + system prompt) and the run meta; missing ones are skipped", () => {
    writeConfig({});
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-vault-'));
    const hq = new HQ({ roles: [], permMode: 'auto', cwd, dirs: [vault, '/nonexistent/orq-dir'] });
    hq.claudeJson = claudeJson;
    const agent = { id: 'doc', role: { ...role, id: 'doc' }, status: 'starting', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    const script = fs.readFileSync((hq as any).writeLaunchFiles(agent), 'utf8');
    const system = fs.readFileSync(path.join(hq.store.dir, 'agents', 'doc', 'system.md'), 'utf8');
    expect(script).toContain(`--add-dir '${vault}'`);
    expect(script).not.toContain('nonexistent');
    expect(system).toContain(vault);
    expect((hq as any).currentMeta().dirs).toEqual([vault]);
    fs.rmSync(vault, { recursive: true });
  });

  test("the team's rules are appended to every role prompt and the department is kept for resume", () => {
    writeConfig({});
    const hq = new HQ({ roles: [], permMode: 'auto', cwd, dept: 'acme-x', rules: '## Reglas\nDocumentar SIEMPRE.' });
    hq.claudeJson = claudeJson;
    const agent = { id: 'doc', role: { ...role, id: 'doc', prompt: 'ROLE BODY' }, status: 'starting', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    (hq as any).writeLaunchFiles(agent);
    const system = fs.readFileSync(path.join(hq.store.dir, 'agents', 'doc', 'system.md'), 'utf8');
    expect(system.indexOf('ROLE BODY')).toBeLessThan(system.indexOf('Documentar SIEMPRE.'));
    expect(system).toContain('## Team rules');
    expect((hq as any).currentMeta().dept).toBe('acme-x');
  });

  test('max: no strict flag, only `company`', () => {
    writeConfig({});
    const { hq, script, servers, settings, system } = launchFiles('max', ['jira']);
    expect(script).not.toContain('--strict-mcp-config');
    expect(servers).toEqual(['company']);
    expect(settings.statusLine.command).toContain('statusline.ts');
    expect(system).not.toContain('MCP servers are not loaded');
    hq.stop();
  });

  test('saver: strict, `company` always, plus the allowlists; the omitted ones are named in the prompt', () => {
    writeConfig({});
    const { hq, script, servers, system } = launchFiles('saver', ['jira', 'unknown']);
    expect(script).toContain('--strict-mcp-config');
    expect(servers).toEqual(['company', 'context7', 'jira']);
    expect(system).toContain('these MCP servers are not loaded in this session: figma.');
    expect(system).not.toContain('secret');
    hq.stop();
  });

  test('mcp.json lives in ORQ_HOME/private (0700/0600, even over a 0644 file), never under cwd, and goes away on stop', () => {
    writeConfig({});
    const first = launchFiles('saver');
    fs.chmodSync(first.mcpFile, 0o644);
    const { hq, mcpFile, script } = launchFiles('saver');
    expect(mcpFile.startsWith(cwd)).toBe(false);
    expect(script).toContain(mcpFile);
    expect(fs.statSync(mcpFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(mcpFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(hq.privateDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(hq.store.dir, 'agents', 'dev', 'mcp.json'))).toBe(false);
    // A legacy mcp.json next to the logs (older runs) is removed on launch.
    fs.writeFileSync(path.join(hq.store.dir, 'agents', 'dev', 'mcp.json'), '{"secret":1}');
    launchFiles('saver').hq.stop();
    expect(fs.existsSync(path.join(hq.store.dir, 'agents', 'dev', 'mcp.json'))).toBe(false);
    expect(fs.readFileSync(path.join(cwd, '.orq', 'runs', '.gitignore'), 'utf8')).toBe('*\n');
    hq.stop();
    expect(fs.existsSync(hq.privateDir)).toBe(false);
  });
});

describe('wake-ups (T3/T6)', () => {
  /** Idle team cto/qa/backend; deliveries are captured instead of typed into tmux. */
  function idleTeam(profile: 'saver' | 'max') {
    const hq = newHQ(profile);
    hq.lead = 'cto';
    hq.wakeDelayMs = 20;
    for (const id of ['cto', 'qa', 'backend'])
      hq.agents.set(id, { id, role: { ...role, id }, status: 'idle', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 });
    const typed: [string, string][] = [];
    (hq as any).typeInto = (a: { id: string }, text: string) => typed.push([a.id, text]);
    simulateTmux(hq);
    return { hq, typed, settle: () => tick(60) };
  }

  test('(1) a done report to whoever assigned the task wakes; a copy to a third party waits', async () => {
    const { hq, typed, settle } = idleTeam('saver');
    hq.post('cto', 'qa', 'Validate AC1', 'task');
    await settle();
    typed.length = 0;
    hq.agents.get('qa')!.status = 'working';
    hq.post('qa', 'cto', '[done] AC1 ok', 'report');
    hq.post('qa', 'backend', '[done] AC1 ok', 'report');
    await settle();
    expect(typed.map(([id]) => id)).toEqual(['cto']);
    expect(hq.agents.get('backend')!.inbox).toHaveLength(1);
  });

  test('(2) a blocked report to a third party wakes it', async () => {
    const { hq, typed, settle } = idleTeam('saver');
    hq.post('qa', 'backend', '[blocked] cannot run tests', 'report');
    await settle();
    expect(typed.map(([id]) => id)).toEqual(['backend']);
  });

  test('FYI messages wait; tasks, questions, answers and system alerts wake', async () => {
    const { hq, typed, settle } = idleTeam('saver');
    hq.post('qa', 'backend', 'fyi: tests are slow', 'message');
    await settle();
    expect(typed).toEqual([]);
    for (const type of ['task', 'question', 'answer', 'system'] as const) {
      hq.agents.get('cto')!.status = 'idle';
      hq.post('qa', 'cto', `a ${type}`, type);
      await settle();
      expect(typed.at(-1)).toEqual(['cto', expect.stringContaining(`a ${type}`)]);
    }
  });

  test('(3) max: everything wakes', async () => {
    const { hq, typed, settle } = idleTeam('max');
    hq.post('qa', 'backend', 'fyi', 'message');
    hq.post('qa', 'cto', '[done] copy', 'report');
    await settle();
    expect(typed.map(([id]) => id).sort()).toEqual(['backend', 'cto']);
  });

  test('(4) waiting messages ride along with the next wake-up, batched into one turn', async () => {
    const { hq, typed, settle } = idleTeam('saver');
    hq.post('qa', 'backend', 'fyi one', 'message');
    hq.post('qa', 'backend', 'fyi two', 'message');
    hq.post('cto', 'backend', 'do T1', 'task');
    hq.post('cto', 'backend', 'and T2', 'task');
    await settle();
    expect(typed).toHaveLength(1);
    for (const t of ['fyi one', 'fyi two', 'do T1', 'and T2']) expect(typed[0]![1]).toContain(t);
    expect(hq.agents.get('backend')!.inbox).toEqual([]);
  });

  test('(4b) or with the next prompt typed in its terminal', () => {
    const { hq } = idleTeam('saver');
    hq.post('qa', 'backend', 'fyi three', 'message');
    const out = (hq as any).onHook('backend', { hook_event_name: 'UserPromptSubmit', prompt: 'hola' });
    expect(out.hookSpecificOutput.additionalContext).toContain('fyi three');
    expect(hq.agents.get('backend')!.inbox).toEqual([]);
  });

  test('a prompt typed in the terminal and its plain-text answer go to Mensajes', () => {
    const { hq } = idleTeam('saver');
    const hook = (p: Record<string, unknown>) => (hq as any).onHook('backend', p);
    hook({ hook_event_name: 'UserPromptSubmit', prompt: '¿y el tema del datastream?' });
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Datastream lee de la réplica.' });
    const [q, a] = hq.messages.slice(-2);
    expect(q).toMatchObject({ from: 'user', to: 'backend', body: '¿y el tema del datastream?' });
    expect(a).toMatchObject({ from: 'backend', to: 'user', type: 'answer', body: 'Datastream lee de la réplica.', replyTo: q!.id });
    expect(hq.agents.get('backend')!.inbox).toEqual([]);
    // Slash commands are not messages.
    hook({ hook_event_name: 'UserPromptSubmit', prompt: '/compact' });
    expect(hq.messages).toHaveLength(2);
  });

  test("a user task answered with a report gets no extra answer from the turn's final text", async () => {
    const { hq, settle } = idleTeam('saver');
    hq.post('user', 'backend', 'revisa el log', 'task');
    await settle();
    (hq as any).onHook('backend', { hook_event_name: 'UserPromptSubmit', prompt: '📬 New company messages: …' });
    hq.post('backend', 'user', '[done] revisado', 'report');
    (hq as any).onHook('backend', { hook_event_name: 'Stop', last_assistant_message: 'He revisado el log.' });
    expect(hq.messages.map((m) => m.body)).toEqual(['revisa el log', '[done] revisado']);
  });

  test('a user task answered only in the terminal is recorded as its answer', async () => {
    const { hq, settle } = idleTeam('saver');
    const task = hq.post('user', 'backend', 'revisa el log', 'task');
    await settle();
    (hq as any).onHook('backend', { hook_event_name: 'UserPromptSubmit', prompt: '📬 New company messages: …' });
    (hq as any).onHook('backend', { hook_event_name: 'Stop', last_assistant_message: 'El log está limpio.' });
    expect(hq.messages.at(-1)).toMatchObject({ from: 'backend', to: 'user', type: 'answer', body: 'El log está limpio.', replyTo: task.id });
  });

  test('a plain message answering the recipient wakes it (open conversation)', async () => {
    const { hq, typed, settle } = idleTeam('saver');
    hq.post('cto', 'backend', '¿Qué comando lanza los tests?', 'message');
    await settle();
    typed.length = 0;
    hq.post('backend', 'cto', 'bun test', 'message');
    await settle();
    expect(typed.map(([id]) => id)).toEqual(['cto']);
    // The conversation is answered: another FYI from backend waits.
    hq.agents.get('cto')!.status = 'idle';
    hq.post('backend', 'cto', 'fyi: all green', 'message');
    await settle();
    expect(typed).toHaveLength(1);
  });

  test('messages that did not wake an idle agent are delivered within pendingWakeMs', async () => {
    const { hq, typed } = idleTeam('saver');
    hq.pendingWakeMs = 40;
    hq.post('qa', 'backend', 'fyi', 'message');
    tick(10);
    expect(typed).toEqual([]);
    tick(80);
    expect(typed).toEqual([['backend', expect.stringContaining('fyi')]]);
  });

  test('max: delivery is immediate', () => {
    const { hq, typed } = idleTeam('max');
    hq.post('qa', 'backend', 'fyi', 'message');
    expect(typed.map(([id]) => id)).toEqual(['backend']);
  });

  test('a wake-up that finds the agent busy is retried, not lost', async () => {
    const { hq, typed, settle } = idleTeam('saver');
    const be = hq.agents.get('backend')!;
    be.status = 'waiting';
    hq.post('cto', 'backend', 'task while blocked', 'task');
    await settle();
    expect(typed).toEqual([]);
    expect(be.inbox).toHaveLength(1);
    // "waiting for your input" makes it idle again and wakes it with the pending task.
    (hq as any).onHook('backend', { hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
    await settle();
    expect(typed.map(([id]) => id)).toEqual(['backend']);
  });

  test('max: a working agent with a pending message does not spin timers', async () => {
    const { hq } = idleTeam('max');
    const be = hq.agents.get('backend')!;
    be.status = 'working';
    let calls = 0;
    const real = (hq as any).wakeNow.bind(hq);
    (hq as any).wakeNow = (a: unknown) => (calls++, real(a));
    hq.post('qa', 'backend', 'fyi', 'message');
    tick(500);
    expect(calls).toBeLessThanOrEqual(2);
    expect(be.inbox).toHaveLength(1);
  });

  test('a waiting agent is retried about once a second', async () => {
    const { hq, typed } = idleTeam('saver');
    const be = hq.agents.get('backend')!;
    be.status = 'waiting';
    hq.post('cto', 'backend', 'task', 'task');
    tick(60);
    expect((hq as any).wakeTimers.has('backend')).toBe(true);
    be.status = 'idle';
    tick(1100);
    expect(typed.map(([id]) => id)).toEqual(['backend']);
  });

  test('fire, stop and detach clear the timers', () => {
    const { hq } = idleTeam('saver');
    hq.post('qa', 'backend', 'fyi', 'message');
    hq.post('cto', 'qa', 'task', 'task');
    expect((hq as any).pendingTimers.size + (hq as any).wakeTimers.size).toBe(2);
    hq.fire('backend');
    expect((hq as any).pendingTimers.size).toBe(0);
    hq.detach();
    expect((hq as any).wakeTimers.size).toBe(0);
  });

  test('the protocol forbids acknowledgements in every profile', () => {
    for (const profile of ['saver', 'max'] as const) {
      const { hq } = idleTeam(profile);
      expect((hq as any).systemPrompt(role)).toContain('Do not reply to informational messages or send acknowledgements');
    }
  });
});

describe('context housekeeping (T4)', () => {
  function ctxTeam(profile: 'saver' | 'max', fresh = false, writes = false) {
    const hq = newHQ(profile);
    hq.lead = 'cto';
    hq.wakeDelayMs = 10;
    hq.housekeepDelayMs = 0;
    hq.commandTimeoutMs = { '/clear': 40, '/compact': 40 };
    for (const id of ['cto', 'qa'])
      hq.agents.set(id, { id, role: { ...role, id, writes: id === 'qa' ? writes : false, fresh: id === 'qa' ? fresh : undefined }, status: 'working', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 });
    const commands: [string, string][] = [];
    (hq as any).typeCommand = (a: { id: string }, cmd: string) => commands.push([a.id, cmd]);
    (hq as any).typeInto = () => {};
    simulateTmux(hq);
    const stop = (id: string) => (hq as any).onHook(id, { hook_event_name: 'Stop' });
    return { hq, commands, stop, qa: hq.agents.get('qa')!, settle: () => tick(30) };
  }

  test('no automatic /clear after a done report, even for former fresh roles (it rewrites the cached prefix)', async () => {
    const { hq, commands, stop, qa, settle } = ctxTeam('saver', true);
    hq.post('cto', 'qa', 'Validate', 'task');
    qa.inbox.length = 0; // delivered
    (hq as any).onTool('qa', 'report', { to: 'cto', status: 'done', summary: 'AC ok' });
    stop('qa');
    await settle();
    expect(commands).toEqual([]);
    expect(qa.timeline.some((e) => e.text.includes('limpio'))).toBe(false);
  });

  test('a manual clear leaves the light-resume summary of the agent for its next turn', () => {
    const { hq, commands, qa } = ctxTeam('saver');
    hq.post('cto', 'qa', 'Validate AC1-AC5 of the area mode', 'task');
    qa.inbox.length = 0; // delivered
    qa.status = 'idle';
    expect(hq.clear('qa')).toBe(true);
    expect(commands).toEqual([['qa', '/clear']]);
    qa.status = 'idle';
    const out = (hq as any).onHook('qa', { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    expect(out.hookSpecificOutput.additionalContext).toStartWith('# Session resumed (light)');
    expect(out.hookSpecificOutput.additionalContext).toContain('Validate AC1-AC5 of the area mode');
  });

  test('never mid-task: an open task or a pending inbox blocks the compaction', async () => {
    const { hq, commands, stop, qa, settle } = ctxTeam('saver', true);
    hq.post('cto', 'qa', 'Second task', 'task');
    stop('qa'); // the task is open (and in the inbox)
    await settle();
    qa.inbox.length = 0;
    stop('qa'); // inbox empty, but the task is still open
    await settle();
    qa.ctxTokens = 200_000;
    stop('qa');
    await settle();
    expect(commands).toEqual([]);
  });

  test('a saver reader above 120k restarts from the orq summary instead of paying for /compact', async () => {
    const { commands, stop, qa, settle } = ctxTeam('saver');
    qa.ctxTokens = 150_000;
    stop('qa');
    await settle();
    expect(commands).toEqual([['qa', '/clear']]);
    expect(qa.primer).toContain('# Session resumed (light)');
  });

  test('compact between tasks above 120k, reporting before → after on the next turn', async () => {
    const { commands, stop, qa, settle } = ctxTeam('saver', false, true);
    const t = path.join(cwd, 'ctx.jsonl');
    fs.writeFileSync(t, JSON.stringify({ type: 'assistant', message: { id: 'x', usage: { input_tokens: 150_000 } } }) + '\n');
    qa.transcriptPath = t;
    stop('qa');
    await settle();
    expect(commands).toEqual([['qa', '/compact']]);
    expect(qa.compactedFrom).toBe(150_000);
    fs.writeFileSync(t, JSON.stringify({ type: 'assistant', message: { id: 'y', usage: { input_tokens: 22_000 } } }) + '\n');
    qa.status = 'working';
    stop('qa');
    expect(qa.timeline.some((e) => e.text === 'Contexto compactado (150k → 22k)')).toBe(true);
    expect(qa.ctxTokens).toBe(22_000);
  });

  test('max: no automatic clear or compact; the UI buttons work on idle agents only', async () => {
    const { hq, commands, stop, qa, settle } = ctxTeam('max', true);
    qa.ctxTokens = 500_000;
    stop('qa');
    await settle();
    expect(commands).toEqual([]);
    expect(hq.compact('qa')).toBe(true);
    expect(hq.clear('qa')).toBe(false); // busy compacting
    qa.status = 'idle';
    expect(hq.clear('qa')).toBe(true);
    expect(commands).toEqual([
      ['qa', '/compact'],
      ['qa', '/clear'],
    ]);
  });

  test('a slash command that never completes frees the agent and delivers its inbox', async () => {
    const { hq, commands, qa } = ctxTeam('saver');
    const typed: string[] = [];
    (hq as any).typeInto = (_: unknown, text: string) => typed.push(text);
    simulateTmux(hq);
    (hq as any).clearInput = () => typed.push('<clear input>');
    qa.status = 'idle';
    expect(hq.compact('qa')).toBe(true);
    expect(qa.status as string).toBe('working');
    qa.inbox.push({ id: 'w', ts: 0, from: 'cto', to: 'qa', type: 'task', body: 'next task' });
    tick(80);
    expect(commands).toEqual([['qa', '/compact']]);
    expect(qa.timeline.some((e) => e.text === '⚠ /compact no se completó')).toBe(true);
    expect(qa.compactedFrom).toBeUndefined();
    expect(typed).toEqual(['<clear input>', expect.stringContaining('next task')]);
  });

  test('SessionStart or Stop after the command cancels the watchdog', async () => {
    const { hq, qa } = ctxTeam('saver');
    qa.status = 'idle';
    hq.clear('qa');
    (hq as any).onHook('qa', { hook_event_name: 'SessionStart', source: 'clear' });
    tick(80);
    expect(qa.timeline.some((e) => e.text.includes('no se completó'))).toBe(false);
  });

  test('a slash command typed by the user does not take the inbox', () => {
    const { hq, qa } = ctxTeam('saver');
    qa.inbox.push({ id: 'f', ts: 0, from: 'cto', to: 'qa', type: 'message', body: 'fyi' });
    const out = (hq as any).onHook('qa', { hook_event_name: 'UserPromptSubmit', prompt: '/cost' });
    expect(out.hookSpecificOutput?.additionalContext).toBeUndefined();
    expect(qa.inbox).toHaveLength(1);
  });

  test('housekeeping and command timers are cleared by fire, detach and stop', () => {
    const { hq, stop } = ctxTeam('saver');
    hq.housekeepDelayMs = 60_000;
    stop('qa');
    stop('cto');
    expect((hq as any).housekeepTimers.size).toBe(2);
    hq.fire('qa');
    expect((hq as any).housekeepTimers.size).toBe(1);
    hq.agents.get('cto')!.status = 'idle';
    hq.compact('cto');
    hq.detach();
    expect((hq as any).housekeepTimers.size + (hq as any).commandTimers.size).toBe(0);
  });

  test('edits are recorded with their full path', () => {
    const { hq } = ctxTeam('saver');
    const file = `${cwd}/${'deep/'.repeat(30)}x.ts`;
    (hq as any).onHook('qa', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
    const events = fs.readFileSync(path.join(hq.store.dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.find((e) => e.kind === 'edit')).toMatchObject({ agent: 'qa', file });
  });

  test('a new Claude session id (e.g. after /clear) is tracked', () => {
    const { hq, qa } = ctxTeam('saver');
    (hq as any).onHook('qa', { hook_event_name: 'SessionStart', session_id: 'new-session', source: 'clear' });
    expect(qa.sessionId).toBe('new-session');
    expect(qa.prevSessionIds).toEqual(['s']);
  });
});

describe('model per profile (T5)', () => {
  const ro = (id: string, extra = {}) => ({ ...role, id, writes: false, ...extra });

  test('saver: read-only verifiers get sonnet; never the lead, reviewer, architect, writers or roles with a model', () => {
    const hq = newHQ('saver');
    hq.lead = 'cto';
    expect(hq.effectiveModel(ro('qa'))).toBe('sonnet');
    expect(hq.effectiveModel(ro('analyst'))).toBe('sonnet');
    for (const id of ['cto', 'reviewer', 'architect']) expect(hq.effectiveModel(ro(id))).toBeUndefined();
    expect(hq.effectiveModel({ ...role, id: 'backend', writes: true })).toBeUndefined();
    expect(hq.effectiveModel(ro('qa', { model: 'opus' }))).toBe('opus');
  });

  test('balanced and max keep the role model', () => {
    for (const p of ['balanced', 'max'] as const) {
      const hq = newHQ(p);
      expect(hq.effectiveModel(ro('qa'))).toBeUndefined();
      expect(hq.effectiveModel(ro('qa', { model: 'haiku' }))).toBe('haiku');
    }
  });

  test('the effective model is exposed on the agent and passed to claude', () => {
    const hq = newHQ('saver');
    hq.lead = 'cto';
    const agent: any = { id: 'qa', role: ro('qa'), status: 'starting', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    const script = fs.readFileSync((hq as any).writeLaunchFiles(agent), 'utf8');
    expect(agent.model).toBe('sonnet');
    expect(script).toContain("--model 'sonnet'");
    expect(script).toMatch(/export ORQ_USAGE_FILE='.+usage\.json'/);
  });
});

describe('confirmed delivery (B3 QA fail)', () => {
  /** Idle `backend` with a simulated input box: the paste shows after `showAfter` polls and stays until `submitOn` Enters. */
  function box(opts: { showAfter?: number; submitOn?: number } = {}) {
    const hq = newHQ('saver');
    hq.lead = 'cto';
    hq.wakeDelayMs = 1;
    hq.deliveryTiming = { pollMs: 5, pasteWaitMs: 200, backoffMs: [20, 30, 40] };
    for (const id of ['cto', 'backend'])
      hq.agents.set(id, { id, role: { ...role, id }, status: 'idle', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 });
    const log: string[] = [];
    let polls = 0;
    let enters = 0;
    let inBox = false;
    (hq as any).typeInto = () => {
      log.push('paste');
      inBox = true;
    };
    (hq as any).inputShows = () => {
      polls++;
      return inBox && polls > (opts.showAfter ?? 0);
    };
    (hq as any).pressEnter = () => {
      enters++;
      log.push('enter');
      if (enters >= (opts.submitOn ?? 1)) inBox = false;
    };
    (hq as any).clearInput = () => log.push('escape');
    (hq as any).clearLine = () => log.push('clear');
    const delivered = () =>
      fs
        .readFileSync(path.join(hq.store.dir, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((e) => e.kind === 'delivered' && e.agent === 'backend')
        .flatMap((e) => e.ids);
    return { hq, log, delivered, be: hq.agents.get('backend')!, enters: () => enters };
  }

  test('Enter waits for the paste to show up, then the empty box confirms the delivery', async () => {
    const { hq, log, delivered } = box({ showAfter: 3 });
    const m = hq.post('cto', 'backend', 'big task', 'task');
    tick(10);
    expect(log).toEqual(['paste']); // paste not visible yet: no Enter
    expect(delivered()).not.toContain(m.id);
    tick(100);
    expect(log).toEqual(['paste', 'enter']);
    expect(delivered()).toContain(m.id);
  });

  test('Enter is retried with backoff until the box empties', async () => {
    const { hq, delivered, enters } = box({ submitOn: 3 });
    const m = hq.post('cto', 'backend', 'big task', 'task');
    tick(150);
    expect(enters()).toBe(3);
    expect(delivered()).toContain(m.id);
  });

  test("the agent's UserPromptSubmit confirms it too", async () => {
    const { hq, delivered, be } = box({ submitOn: 99 });
    const m = hq.post('cto', 'backend', 'big task', 'task');
    tick(15);
    (hq as any).onHook('backend', { hook_event_name: 'UserPromptSubmit', prompt: '📬 New company messages' });
    expect(delivered()).toContain(m.id);
    tick(150);
    expect(be.inbox).toEqual([]);
    expect(be.timeline.some((e) => e.text.includes('no confirmada'))).toBe(false);
  });

  test('never submitted: messages back to the inbox, agent idle, input cleared, warning, nothing recorded', async () => {
    const { hq, log, delivered, be } = box({ submitOn: 99 });
    const m = hq.post('cto', 'backend', 'big task', 'task');
    tick(200);
    expect(log).toEqual(['paste', 'enter', 'enter', 'enter', 'clear']);
    expect(be.status).toBe('idle');
    expect(be.inbox.map((x) => x.id)).toEqual([m.id]);
    expect(be.timeline.some((e) => e.text === '⚠ entrega no confirmada')).toBe(true);
    expect(delivered()).not.toContain(m.id);
    (hq as any).clearWakeTimers();
  });

  test('after a completed /compact the context size is unknown until the next turn', () => {
    const { hq, be } = box();
    be.ctxTokens = 150_000;
    be.compactedFrom = 150_000;
    (hq as any).onHook('backend', { hook_event_name: 'SessionStart', source: 'compact' });
    expect(be.ctxTokens).toBeUndefined();
  });
});

describe('delivery reads only the input box', () => {
  const RULE = '─'.repeat(80);
  const screen = (box: string, status = '  ⏵⏵ auto mode on') =>
    ['📬 New company messages:', '', '[task] from cto: earlier task', '> [Pasted text #1 +17 lines]', '', '✻ Done', '', RULE, `❯ ${box}`, RULE, status].join('\n');

  function pane(initial: string) {
    const hq = newHQ('saver');
    hq.lead = 'cto';
    hq.wakeDelayMs = 1;
    hq.deliveryTiming = { pollMs: 2, pasteWaitMs: 50, backoffMs: [10, 10, 10] };
    for (const id of ['cto', 'backend'])
      hq.agents.set(id, { id, role: { ...role, id }, status: 'idle', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 });
    const keys: string[] = [];
    type Pane = { screen: string; onEnter: (st: Pane) => void };
    const state: Pane = { screen: initial, onEnter: () => {} };
    (hq as any).paneText = () => state.screen;
    (hq as any).typeInto = () => (state.screen = screen('[Pasted text #2 +5 lines]'));
    (hq as any).pressEnter = () => (keys.push('Enter'), state.onEnter(state));
    (hq as any).clearLine = () => keys.push('C-u');
    (hq as any).clearInput = () => keys.push('Escape');
    const be = hq.agents.get('backend')!;
    return { hq, keys, state, be };
  }

  test('inputBox: only the rows between the prompt borders', () => {
    expect(inputBox(screen(''))).toBe('❯ ');
    expect(inputBox(screen('[Pasted text #2 +5 lines]'))).toContain('[Pasted text #2');
    expect(inputBox('a\nb\nc')).toBe('a\nb\nc');
  });

  test('old pastes in the history do not count: an emptied box confirms without the hook and without Escape', async () => {
    const { hq, keys, state, be } = pane(screen(''));
    state.onEnter = (st) => (st.screen = screen(''));
    hq.post('cto', 'backend', 'task', 'task');
    tick(80);
    expect(keys).toEqual(['Enter']);
    expect(be.inbox).toEqual([]);
    expect(be.timeline.some((e) => e.text.includes('no confirmada'))).toBe(false);
  });

  test('claude working counts as delivered: no Escape, no re-queue', async () => {
    const { hq, keys, state, be } = pane(screen(''));
    // The paste stays drawn in the box, but claude is running the turn.
    state.onEnter = (st) => (st.screen = screen('[Pasted text #2 +5 lines]', '  ⏵⏵ auto mode on · esc to interrupt'));
    hq.post('cto', 'backend', 'task', 'task');
    tick(80);
    expect(keys).toEqual(['Enter']);
    expect(be.inbox).toEqual([]);
    expect(be.status).toBe('working');
  });

  test('never submitted: only C-u on our paste, never Escape; messages back', async () => {
    const { hq, keys, be } = pane(screen(''));
    const m = hq.post('cto', 'backend', 'task', 'task');
    tick(120);
    expect(keys).toEqual(['Enter', 'Enter', 'Enter', 'C-u']);
    expect(be.inbox.map((x) => x.id)).toEqual([m.id]);
    (hq as any).clearWakeTimers();
  });

  test('a tall expanded paste (10 rows) whose Enter was lost is not confirmed: Enter is retried', async () => {
    const { hq, keys, state, be } = pane(screen(''));
    const tall = (msg: string) =>
      ['history', '📬 old', RULE, '❯ 📬 New company messages:', ...Array.from({ length: 8 }, (_, i) => `  line ${i} of ${msg}`), '  (Answer with the mcp__company__* tools.)', RULE, '  ⏵⏵ auto mode on'].join('\n');
    (hq as any).typeInto = () => (state.screen = tall('task'));
    // Two Enters are lost; the third goes through.
    let enters = 0;
    state.onEnter = (st) => (++enters === 3 ? (st.screen = screen('')) : undefined);
    hq.post('cto', 'backend', 'task', 'task');
    expect(inputBox(tall('x')).split('\n')).toHaveLength(10);
    tick(90);
    // Not confirmed after the lost Enters (else there would be a single Enter), confirmed after the third.
    expect(keys).toEqual(['Enter', 'Enter', 'Enter']);
    expect(be.inbox).toEqual([]);
    expect((hq as any).delivering.has('backend')).toBe(false);
  });

  test('fire drops an in-flight delivery: the agent hired again gets messages', async () => {
    const { hq, keys, be } = pane(screen(''));
    hq.post('cto', 'backend', 'first', 'task');
    tick(3);
    expect((hq as any).delivering.has('backend')).toBe(true);
    hq.fire('backend');
    expect((hq as any).delivering.has('backend')).toBe(false);
    hq.agents.set('backend', { ...be, status: 'idle', inbox: [], timeline: [] });
    hq.post('cto', 'backend', 'second', 'task');
    tick(5);
    expect((hq as any).delivering.get('backend')?.text).toContain('second');
    (hq as any).clearWakeTimers();
    expect(keys).not.toContain('Escape');
  });

  test('restart cancels an in-flight delivery without keys; SessionStart delivers it again', async () => {
    const { hq, keys, be, state } = pane(screen(''));
    (hq as any).launch = () => {};
    const m = hq.post('cto', 'backend', 'task', 'task');
    tick(3);
    hq.restart('backend');
    expect((hq as any).delivering.has('backend')).toBe(false);
    expect(be.inbox.map((x) => x.id)).toEqual([m.id]);
    expect(keys.filter((k) => k !== 'Enter')).toEqual([]); // no Escape, no C-u
    state.onEnter = (st) => (st.screen = screen(''));
    hq.deliveryTiming.pasteWaitMs = 0;
    be.status = 'idle';
    (hq as any).deliver(be);
    tick(40);
    expect(be.inbox).toEqual([]);
  });
});

describe('lazy start (dormant agents)', () => {
  const roles = ['cto', 'qa', 'backend'].map((id) => ({ ...role, id, title: id }));
  // Own run id: the shared FAKE_RUN events would wake these agents on resume.
  const LAZY_RUN = '19990101-000005';
  function launchTeam(profile: 'saver' | 'max') {
    const hq = new HQ({ roles: [], permMode: 'auto', resume: { runId: LAZY_RUN, cwd, dir: '', permMode: 'auto', profile, startedAt: 0, updatedAt: 0, agents: [] } });
    fs.rmSync(path.join(hq.store.dir, 'events.jsonl'), { force: true });
    const launched: string[] = [];
    (hq as any).launch = (a: { id: string }) => launched.push(a.id);
    (hq as any).typeInto = () => {};
    simulateTmux(hq);
    hq.wakeDelayMs = 1;
    hq.sessionStartDeliverMs = 1;
    for (const r of roles) hq.hire(r);
    return { hq, launched };
  }

  test('saver: only the lead starts; the rest are dormant and shown as available', () => {
    const { hq, launched } = launchTeam('saver');
    expect(launched).toEqual(['cto']);
    expect(hq.lead).toBe('cto');
    expect(['qa', 'backend'].map((id) => hq.agents.get(id)!.status)).toEqual(['dormant', 'dormant']);
    const list = (hq as any).onTool('cto', 'list_agents', {});
    expect(list.find((x: any) => x.id === 'qa').status).toBe('dormant — starts on first task');
    expect((hq as any).onTool('cto', 'team_status', {})).toContain('dormant — starts on first task');
    // The watchdog does not mark them stopped for lacking a tmux session.
    (hq as any).checkSessions();
    expect(hq.agents.get('qa')!.status).toBe('dormant');
  });

  test('a task to a dormant agent starts it and SessionStart delivers the message', async () => {
    const { hq, launched } = launchTeam('saver');
    const typed: string[] = [];
    (hq as any).typeInto = (_: unknown, text: string) => typed.push(text);
    hq.post('qa', 'backend', 'fyi', 'message');
    expect(hq.agents.get('backend')!.status).toBe('dormant'); // FYI does not wake it
    hq.post('cto', 'backend', 'Implement T1', 'task');
    expect(launched).toEqual(['cto', 'backend']);
    expect(hq.agents.get('backend')!.status).toBe('starting');
    (hq as any).onHook('backend', { hook_event_name: 'SessionStart', source: 'startup' });
    tick(30);
    expect(typed).toEqual([expect.stringContaining('Implement T1')]);
    expect(typed[0]).toContain('fyi');
  });

  test('max: everyone starts at once', () => {
    const { hq, launched } = launchTeam('max');
    expect(launched).toEqual(['cto', 'qa', 'backend']);
    expect([...hq.agents.values()].every((a) => a.status === 'starting')).toBe(true);
  });

  test('resuming keeps never-started agents dormant', () => {
    const { hq } = launchTeam('saver');
    const meta = JSON.parse(fs.readFileSync(path.join(hq.store.dir, 'run.json'), 'utf8'));
    const again = new HQ({ roles: [], permMode: 'auto', resume: meta, resumeMode: 'light' });
    const launched: string[] = [];
    (again as any).launch = (a: { id: string }) => launched.push(a.id);
    simulateTmux(again);
    (again as any).restore(meta);
    expect(launched).toEqual(['cto']);
    expect(again.agents.get('qa')!.status).toBe('dormant');
  });

  test('the coordinator is told not to greet or broadcast (not in max)', () => {
    const saver = launchTeam('saver').hq;
    expect((saver as any).systemPrompt({ ...role, id: 'cto' })).toContain('Do not greet or broadcast to the team at start');
    const max = launchTeam('max').hq;
    expect((max as any).systemPrompt({ ...role, id: 'cto' })).not.toContain('Do not greet');
  });
});

describe('launch flags per profile and role', () => {
  function flags(profile: 'saver' | 'balanced' | 'max', r: Partial<typeof role> & { id: string }, lead = 'cto') {
    const hq = newHQ(profile);
    hq.lead = lead;
    hq.claudeJson = path.join(cwd, 'no-claude.json');
    const agent: any = { id: r.id, role: { ...role, ...r }, status: 'starting', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    const script = fs.readFileSync((hq as any).writeLaunchFiles(agent), 'utf8');
    const system = fs.readFileSync(path.join(hq.store.dir, 'agents', r.id, 'system.md'), 'utf8');
    const tools = /--tools '([^']*)'/.exec(script)?.[1];
    return { hq, script, system, tools: tools?.split(',') };
  }

  test('max: no skill, memory or tool restrictions', () => {
    const { script, tools } = flags('max', { id: 'qa', writes: false });
    expect(script).not.toContain('--disable-slash-commands');
    expect(script).not.toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    expect(tools).toBeUndefined();
    expect(profileFlags('max')).toEqual([]);
  });

  test('balanced: no auto-memory, all tools; skills stay (disabling them also disables /compact and /clear)', () => {
    const { script, tools, system } = flags('balanced', { id: 'qa', writes: false });
    expect(script).not.toContain('--disable-slash-commands');
    expect(script).toContain('export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
    expect(script).toContain('--strict-mcp-config');
    expect(tools).toBeUndefined();
    expect(system).not.toContain('built-in tools are limited');
  });

  test('saver: readers, writers and the lead get their tool sets; the prompt says how to ask for more', () => {
    expect(flags('saver', { id: 'qa', writes: false }).tools).toEqual(SAVER_TOOLS.reader);
    expect(flags('saver', { id: 'backend', writes: true }).tools).toEqual(SAVER_TOOLS.writer);
    expect(flags('saver', { id: 'cto', writes: false }).tools).toEqual(SAVER_TOOLS.reader);
    const { script, system } = flags('saver', { id: 'qa', writes: false });
    expect(script).toContain("--allowedTools 'mcp__company__*'");
    expect(script).toContain('--disallowedTools Edit Write NotebookEdit');
    expect(system).toContain('your built-in tools are limited to: Bash, Read, Glob, Grep, TaskStop (plus the company tools)');
    expect(system).toContain('`tools:` list of your role');
    expect(profileFlags('saver')).toContain('solo herramientas básicas por rol (todos tienen Bash; Edit/Write solo quien escribe)');
    expect(profileFlags('balanced')).toContain('sin auto-memoria');
    expect(profileFlags('balanced').join(' ')).not.toContain('skills');
  });

  test('every ROLE_TOOL_DEFAULTS role gets its extras in saver, and a role `tools:` replaces them', () => {
    for (const [id, extras] of Object.entries(ROLE_TOOL_DEFAULTS))
      for (const writes of [false, true]) {
        const t = flags('saver', { id, writes }).tools!;
        for (const x of extras) expect(t).toContain(x);
        expect(t).toEqual(expect.arrayContaining(writes ? SAVER_TOOLS.writer : SAVER_TOOLS.reader));
        const own = flags('saver', { id, writes, tools: ['NotebookEdit'] }).tools!;
        expect(own).toContain('NotebookEdit');
        for (const x of extras) expect(own).not.toContain(x);
      }
  });

  test('userSettings: false skips the user settings; by default they load', () => {
    expect(flags('saver', { id: 'qa', writes: false }).script).not.toContain('--setting-sources');
    expect(flags('max', { id: 'qa', writes: false, userSettings: false }).script).toContain('--setting-sources project,local');
  });
});

describe('fresh after the prompt cache expired (saver readers)', () => {
  function team(writes = false, idleMin = 120, ttlMin = 60) {
    const hq = newHQ('saver');
    hq.lead = 'cto';
    hq.wakeDelayMs = 1;
    hq.sessionStartDeliverMs = 1;
    simulateTmux(hq);
    for (const id of ['cto', 'qa'])
      hq.agents.set(id, { id, role: { ...role, id, writes: id === 'qa' ? writes : false }, status: 'idle', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 });
    const commands: string[] = [];
    const typed: string[] = [];
    (hq as any).typeCommand = (_: unknown, cmd: string) => commands.push(cmd);
    (hq as any).typeInto = (a: { id: string }, text: string) => a.id === 'qa' && typed.push(text);
    (hq as any).lastRequestOf = () => ({ at: Date.now() - idleMin * 60_000, ttlMs: ttlMin * 60_000 });
    return { hq, commands, typed, qa: hq.agents.get('qa')! };
  }

  test('a reader idle past the TTL starts clean, then gets the primer and its inbox', async () => {
    const { hq, commands, typed, qa } = team();
    hq.post('cto', 'qa', 'Review PR 12', 'task');
    tick(20);
    expect(commands).toEqual(['/clear']);
    expect(typed).toEqual([]);
    expect(qa.inbox).toHaveLength(1);
    expect(qa.timeline.some((e) => /Empezó limpio: 120 min inactivo \(caché caducada\)/.test(e.text))).toBe(true);
    (hq as any).lastRequestOf = () => undefined; // the new session has no history
    (hq as any).onHook('qa', { hook_event_name: 'SessionStart', source: 'clear' });
    tick(20);
    expect(typed).toHaveLength(1);
    // The summary comes first; the task follows in full and is not repeated inside the summary.
    expect(typed[0]).toStartWith('# Session resumed (light)');
    expect(typed[0]!.indexOf('Review PR 12')).toBeGreaterThan(typed[0]!.indexOf('📬'));
  });

  test('the summary carries the latest goal; a /clear that never completes is not retried', async () => {
    const { hq, commands, typed, qa } = team();
    hq.commandTimeoutMs = { '/clear': 20, '/compact': 20 };
    (hq as any).lastRequestOf = () => undefined; // first task: fresh session
    hq.post('cto', 'qa', 'Audit the parser', 'task');
    tick(10);
    qa.status = 'idle';
    (hq as any).onTool('qa', 'report', { to: 'cto', status: 'done', summary: 'audited' });
    (hq as any).lastRequestOf = () => ({ at: Date.now() - 120 * 60_000, ttlMs: 60 * 60_000 });
    commands.length = 0;
    typed.length = 0;
    hq.post('cto', 'qa', 'Second audit', 'task');
    tick(10);
    expect(commands).toEqual(['/clear']);
    expect(qa.primer).toContain('Audit the parser');
    // Neither SessionStart nor Stop: after the watchdog the inbox goes without the summary, and no more clears.
    tick(60);
    expect(qa.clearFailed).toBe(true);
    expect(qa.timeline.some((e) => e.text === '⚠ /clear no disponible')).toBe(true);
    expect(typed).toEqual([expect.stringContaining('Second audit')]);
    expect(typed[0]).not.toContain('# Session resumed');
    qa.status = 'idle';
    hq.post('cto', 'qa', 'Third audit', 'task');
    tick(20);
    expect(commands).toEqual(['/clear']);
  });

  test('an idle time equal to the TTL is already stale (same boundary as estimateResume)', () => {
    const { hq, qa } = team(false, 60, 60);
    expect((hq as any).staleFor(qa)).toBe(60 * 60_000);
    (hq as any).lastRequestOf = () => ({ at: Date.now() - 60 * 60_000 + 1, ttlMs: 60 * 60_000 });
    expect((hq as any).staleFor(qa)).toBeUndefined();
  });

  test('5-minute caches expire sooner', async () => {
    const { hq, commands } = team(false, 10, 5);
    hq.post('cto', 'qa', 'task', 'task');
    tick(20);
    expect(commands).toEqual(['/clear']);
  });

  test('never for writers, the lead, within the TTL, or with an open task', async () => {
    for (const [writes, idle] of [[true, 120], [false, 30]] as const) {
      const { hq, commands, typed } = team(writes, idle);
      hq.post('cto', 'qa', 'task', 'task');
      tick(20);
      expect(commands).toEqual([]);
      expect(typed).toHaveLength(1);
    }
    const open = team();
    open.hq.post('cto', 'qa', 'first', 'task');
    tick(20); // cleared + still pending: the first task is open
    open.qa.inbox.length = 0;
    open.qa.status = 'idle';
    open.commands.length = 0;
    open.hq.post('cto', 'qa', 'second', 'task');
    tick(20);
    expect(open.commands).toEqual([]);
    const lead = team();
    expect((lead.hq as any).staleFor(lead.hq.agents.get('cto'))).toBeUndefined();
  });
});

describe('reviewer minors (b)', () => {
  test('restart: a dormant agent stays dormant; others resume only with a transcript', () => {
    const hq = newHQ('saver');
    const launched: [string, boolean][] = [];
    (hq as any).launch = (a: { id: string }, resume = false) => launched.push([a.id, resume]);
    simulateTmux(hq);
    hq.hire({ ...role, id: 'cto' });
    hq.hire({ ...role, id: 'qa' });
    launched.length = 0;
    hq.restart('qa');
    expect(launched).toEqual([]);
    expect(hq.agents.get('qa')!.status).toBe('dormant');
    hq.restart('cto'); // no transcript yet
    const t = path.join(cwd, 'restart-t.jsonl');
    fs.writeFileSync(t, '{}\n');
    hq.agents.get('cto')!.transcriptPath = t;
    hq.restart('cto');
    expect(launched).toEqual([
      ['cto', false],
      ['cto', true],
    ]);
  });

  test('a FYI alone never starts a dormant agent, not even after pendingWakeMs', async () => {
    const hq = newHQ('saver');
    (hq as any).launch = () => {};
    simulateTmux(hq);
    hq.pendingWakeMs = 10;
    hq.hire({ ...role, id: 'cto' });
    hq.hire({ ...role, id: 'qa' });
    hq.post('cto', 'qa', 'fyi', 'message');
    tick(40);
    expect(hq.agents.get('qa')!.status).toBe('dormant');
    expect(hq.agents.get('qa')!.inbox).toHaveLength(1);
  });

  test('the transcripts dir is kept across a light resume', () => {
    const hq = newHQ('saver');
    const a: any = { id: 'qa', role, status: 'stopped', task: '', children: [], sessionId: 's1', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    hq.agents.set('qa', a);
    (hq as any).onHook('qa', { hook_event_name: 'PostToolUse', transcript_path: '/x/proj/s1.jsonl' });
    (hq as any).launch = () => {};
    (hq as any).resumeLight(a, [], { runId: 'r', cwd, dir: '', permMode: 'auto', startedAt: 0, updatedAt: 0, agents: [] });
    expect(a.transcriptPath).toBeUndefined();
    expect(a.transcriptDir).toBe('/x/proj');
    (hq as any).saveMeta(); // restore() saves after resuming every agent
    const saved = JSON.parse(fs.readFileSync(path.join(hq.store.dir, 'run.json'), 'utf8')).agents.find((x: any) => x.id === 'qa');
    expect(saved).toMatchObject({ transcriptDir: '/x/proj', prevSessionIds: ['s1'] });
  });
});

describe('compact guard', () => {
  function agent() {
    const hq = newHQ('saver');
    hq.lead = 'cto';
    hq.housekeepDelayMs = 0;
    hq.commandTimeoutMs = { '/clear': 20, '/compact': 20 };
    simulateTmux(hq);
    const a: any = { id: 'qa', role: { ...role, id: 'qa', writes: true }, status: 'idle', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    hq.agents.set('qa', a);
    const commands: string[] = [];
    (hq as any).typeCommand = (_: unknown, cmd: string) => commands.push(cmd);
    const t = path.join(cwd, `guard-${Math.random()}.jsonl`);
    const ctx = (n: number) => fs.writeFileSync(t, JSON.stringify({ type: 'assistant', message: { id: String(n), usage: { input_tokens: n } } }) + '\n');
    a.transcriptPath = t;
    return { hq, a, commands, ctx };
  }

  test('no SessionStart(compact) nor Stop: marked unavailable and never compacted again', async () => {
    const { hq, a, commands, ctx } = agent();
    ctx(150_000);
    a.ctxTokens = 150_000;
    hq.compact('qa');
    a.status = 'idle'; // e.g. a Notification brought it back without compacting
    tick(50);
    expect(a.compactFailed).toBe(true);
    expect(a.timeline.some((e: any) => e.text === '⚠ /compact no disponible')).toBe(true);
    a.status = 'working';
    (hq as any).onHook('qa', { hook_event_name: 'Stop' });
    tick(20);
    expect(commands).toEqual(['/compact']);
  });

  test('a Stop whose context did not shrink also marks it unavailable', async () => {
    const { hq, a, commands, ctx } = agent();
    ctx(150_000);
    a.ctxTokens = 150_000;
    hq.compact('qa');
    ctx(151_000); // "/compact" ran as a plain prompt
    (hq as any).onHook('qa', { hook_event_name: 'Stop' });
    tick(30);
    expect(a.compactFailed).toBe(true);
    expect(commands).toEqual(['/compact']);
  });

  test('a real compaction is reported and can happen again later', async () => {
    const { hq, a, ctx } = agent();
    ctx(150_000);
    a.ctxTokens = 150_000;
    hq.compact('qa');
    (hq as any).onHook('qa', { hook_event_name: 'SessionStart', source: 'compact' });
    ctx(22_000);
    a.status = 'working';
    (hq as any).onHook('qa', { hook_event_name: 'Stop' });
    expect(a.compactFailed).toBeUndefined();
    expect(a.timeline.some((e: any) => e.text === 'Contexto compactado (150k → 22k)')).toBe(true);
  });
});

describe('token savings: log, caps, team tool, auto-compact, .orq guard', () => {
  function launch(profile: 'saver' | 'max') {
    const hq = newHQ(profile);
    hq.claudeJson = path.join(cwd, 'no-claude.json');
    const agent: any = { id: 'dev', role: { ...role, id: 'dev' }, status: 'starting', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    const script = fs.readFileSync((hq as any).writeLaunchFiles(agent), 'utf8');
    const settings = JSON.parse(fs.readFileSync(path.join(hq.store.dir, 'agents', 'dev', 'settings.json'), 'utf8'));
    const system = fs.readFileSync(path.join(hq.store.dir, 'agents', 'dev', 'system.md'), 'utf8');
    return { script, settings, system };
  }

  test.each(['saver', 'max'] as const)('%s: auto-compact at 65%% of a 200k window and .orq denied', (profile) => {
    const { script, settings, system } = launch(profile);
    expect(script).toContain('export CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000');
    expect(script).toContain('export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=65');
    expect(settings.permissions.deny).toContain(`Read(/${path.join(cwd, '.orq')}/**)`);
    expect(system).toContain('NEVER read, search or edit anything inside `.orq/`');
    expect(system).not.toMatch(/team_status|agent_activity|agent_screen|list_agents/);
  });

  test('PreToolUse denies reads of .orq and lets the rest through', () => {
    const { hq, agent } = setup();
    const pre = (tool_name: string, tool_input: Record<string, unknown>) =>
      (hq as any).onHook('cto', { hook_event_name: 'PreToolUse', tool_name, tool_input });
    expect(pre('Read', { file_path: path.join(cwd, '.orq/runs/x/events.jsonl') }).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(pre('Bash', { command: 'tail -n 50 .orq/runs/x/LOG.md' }).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(pre('Read', { file_path: path.join(cwd, 'src/a.ts') })).toEqual({});
    expect(pre('Bash', { command: 'grep -rn "\\.orq" src' })).toEqual({});
    expect(agent.timeline.some((e) => e.text.includes('bloqueado'))).toBe(true);
  });

  test('long reports are cut for agents, kept whole for the user and the run log', () => {
    const { hq, tool } = setup();
    hq.agents.set('pm', { id: 'pm', role: { ...role, id: 'pm' }, status: 'working', task: '', children: [], sessionId: 'p', tmux: 'p', inbox: [], timeline: [], stopBlocks: 0 } as Agent);
    const long = 'palabra '.repeat(600);
    tool('report', { to: 'pm', summary: long, status: 'done', details: 'detalle largo' });
    const msg = hq.messages.at(-1)!;
    expect(msg.body.length).toBeLessThan(2100);
    expect(msg.body).toContain('more characters cut by orq; ask cto');
    const log = fs.readFileSync(path.join(hq.store.dir, 'LOG.md'), 'utf8');
    expect(log).toContain('detalle largo');
    expect(log).toContain(long.trim());
    tool('send_message', { to: USER, body: long });
    expect(hq.messages.at(-1)!.body).toBe(long);
  });

  test('log appends to the run log, or to a project file for writers only', () => {
    const { hq, agent, tool } = setup();
    expect(tool('log', { text: 'decisión: usar SQLite' })).toBe('logged');
    expect(fs.readFileSync(path.join(hq.store.dir, 'LOG.md'), 'utf8')).toContain('decisión: usar SQLite');
    expect(() => tool('log', { text: 'x', file: 'CHANGELOG.md' })).toThrow('read-only');
    agent.role = { ...role, writes: true };
    const file = path.join(cwd, 'docs', 'CHANGELOG.md');
    fs.rmSync(file, { force: true });
    tool('log', { text: '- uno', file: 'docs/CHANGELOG.md' });
    tool('log', { text: '- dos', file: 'docs/CHANGELOG.md' });
    expect(fs.readFileSync(file, 'utf8')).toBe('- uno\n- dos\n');
    expect(() => tool('log', { text: 'x', file: '../fuera.md' })).toThrow('inside the working directory');
    expect(() => tool('log', { text: 'x', file: '.orq/runs/x.md' })).toThrow('Blocked by orq');
  });

  test('team: board without agent, history or screen with one; old names still work', () => {
    const { hq, tool } = setup();
    hq.agents.set('pm', { id: 'pm', role: { ...role, id: 'pm', title: 'PM' }, status: 'idle', task: '', children: [], sessionId: 'p', tmux: 'p', inbox: [], timeline: [{ ts: 0, kind: 'status', text: 'hola' }], stopBlocks: 0 } as Agent);
    expect(tool('team', {})).toContain('Live team board');
    expect(tool('team', { agent: 'pm' })).toContain('[status] hola');
    expect(tool('team_status', {})).toContain('Live team board');
    expect(tool('list_agents', {}).map((x: any) => x.id)).toEqual(['cto', 'pm']);
    expect(() => tool('team', { agent: 'nadie' })).toThrow('Unknown employee');
  });
});

describe('context size during a turn', () => {
  test('PostToolUse re-reads the context size at most every 10 s', () => {
    const { hq, agent } = setup();
    const transcript = path.join(cwd, 'ctx-transcript.jsonl');
    const usage = (n: number) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }) + '\n';
    fs.writeFileSync(transcript, usage(50_000));
    agent.transcriptPath = transcript;
    const post = () => (hq as any).onHook('cto', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} });
    post();
    expect(agent.ctxTokens).toBe(50_000);
    fs.appendFileSync(transcript, usage(60_000));
    post();
    expect(agent.ctxTokens).toBe(50_000);
    tick(10_000);
    post();
    expect(agent.ctxTokens).toBe(60_000);
  });
});
