import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HQ, HQOptions } from '../hq.ts';
import { Session, teamOf } from '../session.ts';
import type { Department, Role } from '../types.ts';
import { startWeb } from './server.ts';
import { snapshot } from './snapshot.ts';

const role = (id: string, over: Partial<Role> = {}): Role => ({ id, name: id, title: id, accessory: 'none', color: 'cyan', writes: false, description: '', prompt: '', scope: 'project', file: '', ...over });
const dept = (id: string, lead: string, roles: string[]): Department => ({ id, name: id, icon: '*', color: 'cyan', category: 'x', description: '', lead, roles, scope: 'project', file: '' });

/** A stand-in for HQ: records what the Session asks of it and never touches tmux or claude. */
class FakeHQ extends EventEmitter {
  runId = '20990101-000000';
  cwd = '/tmp';
  agents = new Map<string, unknown>();
  messages: unknown[] = [];
  notices: unknown[] = [];
  provider = undefined;
  lead?: string;
  permMode: string;
  profile: string;
  version = 0;
  started = false;
  stopped = false;
  constructor(public opts: HQOptions) {
    super();
    this.permMode = opts.permMode;
    this.profile = opts.profile ?? 'max';
    this.lead = opts.lead;
    for (const r of opts.roles) this.agents.set(r.id, { id: r.id, role: r, status: 'idle', task: '', children: [], timeline: [] });
  }
  start() {
    this.started = true;
  }
  hire(r: Role) {
    this.agents.set(r.id, { id: r.id, role: r, status: 'idle', task: '', children: [], timeline: [] });
  }
  detach() {}
  stop() {
    this.stopped = true;
  }
}

const deps = (roles: Role[], depts: Department[] = []) => ({ roles: () => roles, depts: () => depts, isServed: async () => false, load: (() => ({ runId: '20990101-000000', permMode: 'auto', agents: [] })) as any, cwd: '/tmp' });
const session = (roles: Role[], depts: Department[] = []) => {
  const made: FakeHQ[] = [];
  const s = new Session((o) => (made.push(new FakeHQ(o)), made.at(-1) as unknown as HQ), deps(roles, depts));
  return { s, made };
};

describe('teamOf', () => {
  test('picks the team its lead leads, best match first', () => {
    const depts = [dept('a', 'cto', ['cto', 'dev', 'qa']), dept('b', 'cto', ['cto', 'dev'])];
    expect(teamOf(depts, 'cto', ['cto', 'dev']).dept).toBe('b');
    expect(teamOf(depts, undefined, ['cto'])).toEqual({});
    expect(teamOf(depts, 'nobody', ['x'])).toEqual({});
  });
});

describe('Session', () => {
  test('launch starts a run with the lead first; a second launch only adds the missing roles', () => {
    const { s, made } = session([role('dev'), role('cto'), role('qa')]);
    expect(s.launch({ roleIds: [], perm: 'auto', profile: 'max' })).toEqual({ ok: false, error: 'Selecciona al menos un rol' });
    expect(s.launch({ roleIds: ['dev', 'cto'], lead: 'cto', perm: 'yolo', profile: 'saver' }).ok).toBe(true);
    expect(made[0]!.started).toBe(true);
    expect(made[0]!.opts.roles.map((r) => r.id)).toEqual(['cto', 'dev']);
    expect(made[0]!.opts.permMode).toBe('yolo');
    const again = s.launch({ roleIds: ['dev', 'qa'], perm: 'auto', profile: 'max' });
    expect(again.ok && again.message).toBe('1 agente añadido a la sesión');
    expect(s.launch({ roleIds: ['dev'], perm: 'auto', profile: 'max' })).toEqual({ ok: true, message: 'Esos agentes ya están en la sesión' });
    expect(made).toHaveLength(1);
    expect([...made[0]!.agents.keys()]).toEqual(['cto', 'dev', 'qa']);
  });

  test('refuses to resume over an open run and detaches/stops cleanly', async () => {
    const { s, made } = session([role('cto')]);
    expect(s.stop()).toEqual({ ok: false, error: 'No hay sesión abierta' });
    s.launch({ roleIds: ['cto'], perm: 'auto', profile: 'max' });
    expect((await s.resume('/x')).ok).toBe(false);
    expect(s.stop().ok).toBe(true);
    expect(made[0]!.stopped).toBe(true);
    expect(s.hq).toBeNull();
    expect((await s.resume('/x')).ok).toBe(true);
  });

  test('emits change when the run changes', () => {
    const { s, made } = session([role('cto')]);
    let n = 0;
    s.on('change', () => n++);
    s.launch({ roleIds: ['cto'], perm: 'auto', profile: 'max' });
    const before = n;
    made[0]!.emit('change');
    expect(n).toBe(before + 1);
  });
});

describe('snapshot', () => {
  test('describes the open run and is JSON-serialisable', () => {
    const { s } = session([role('cto')]);
    expect(snapshot(s).run).toBeNull();
    s.launch({ roleIds: ['cto'], lead: 'cto', perm: 'auto', profile: 'balanced' });
    const snap = JSON.parse(JSON.stringify(snapshot(s)));
    expect(snap.run.agents.map((a: any) => a.id)).toEqual(['cto']);
    expect(snap.run.profile).toBe('balanced');
    expect(snap.run.alerts).toEqual([]);
  });
});

describe('role actions', () => {
  test('create, edit (keeping hidden fields) and delete a role in the isolated library', async () => {
    const { perform } = await import('./server.ts');
    const { loadRoles } = await import('../library.ts');
    const { s } = session([]);
    expect((await perform(s, { type: 'saveRole', name: ' ' })).ok).toBe(false);
    const made = await perform(s, { type: 'saveRole', name: 'Web Tester', title: 'QA web', description: 'd', prompt: 'Haz pruebas', color: 'green', writes: false, scope: 'global' });
    expect(made.ok).toBe(true);
    const r = loadRoles().find((x) => x.id === 'web-tester')!;
    expect(r).toMatchObject({ title: 'QA web', writes: false, color: 'green', prompt: 'Haz pruebas' });
    expect((await perform(s, { type: 'saveRole', name: 'Web Tester' })).ok).toBe(false);
    await perform(s, { type: 'saveRole', id: 'web-tester', name: 'Web Tester', title: 'QA', prompt: 'Otro', writes: true, scope: 'global' });
    expect(loadRoles().find((x) => x.id === 'web-tester')).toMatchObject({ title: 'QA', prompt: 'Otro', writes: true });
    expect((await perform(s, { type: 'deleteRole', id: 'web-tester' })).ok).toBe(true);
    expect(loadRoles().some((x) => x.id === 'web-tester')).toBe(false);
  });
});

describe('web server', () => {
  const start = async () => {
    const { s } = session([role('cto')]);
    const web = await startWeb({ session: s, port: 0 });
    return { s, web };
  };
  const post = (web: { url: string; token: string }, body: unknown, token = web.token) =>
    fetch(`${web.url}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orq-token': token }, body: JSON.stringify(body) });

  test('serves the page with the token and the bundled client', async () => {
    const { web } = await start();
    try {
      const html = await (await fetch(web.url)).text();
      expect(html).toContain(web.token);
      const js = await fetch(`${web.url}/app.js`);
      expect(js.headers.get('content-type')).toContain('javascript');
      expect((await js.text()).length).toBeGreaterThan(10_000);
      expect((await fetch(`${web.url}/style.css`)).status).toBe(200);
    } finally {
      web.stop();
    }
  });

  test('rejects API calls without the token and foreign hosts', async () => {
    const { s, web } = await start();
    try {
      expect((await post(web, { type: 'launch', roleIds: ['cto'] }, 'wrong')).status).toBe(403);
      expect((await fetch(`${web.url}/api/events`)).status).toBe(403);
      const evil = await fetch(`${web.url}/`, { headers: { host: 'evil.example' } });
      expect(evil.status).toBe(403);
      expect(s.hq).toBeNull();
    } finally {
      web.stop();
    }
  });

  test('actions run through the session and bad input is an error, not a crash', async () => {
    const { s, web } = await start();
    try {
      expect(await (await post(web, { nope: 1 })).json()).toEqual({ ok: false, error: 'Petición inválida' });
      expect(await (await post(web, { type: 'wat' })).json()).toEqual({ ok: false, error: 'Acción desconocida: wat' });
      expect(await (await post(web, { type: 'send', to: 'cto', body: 'hi' })).json()).toEqual({ ok: false, error: 'No hay sesión abierta' });
      const out = await (await post(web, { type: 'launch', roleIds: ['cto'], lead: 'cto', perm: 'auto', profile: 'max', provider: '' })).json();
      expect(out.ok).toBe(true);
      expect(s.hq).not.toBeNull();
    } finally {
      web.stop();
    }
  });

  test('the event stream starts with a snapshot', async () => {
    const { web } = await start();
    try {
      const res = await fetch(`${web.url}/api/events?token=${web.token}`);
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first.startsWith('data: ')).toBe(true);
      expect(JSON.parse(first.slice(6)).run).toBeNull();
      await reader.cancel();
    } finally {
      web.stop();
    }
  });
});

describe('auto teams', () => {
  const fixture = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-web-auto-'));
    for (const [f, body] of [['package.json', '{"name":"x","dependencies":{"react":"1"}}'], ['src/a.ts', 'a'], ['src/ui/b.tsx', 'b'], ['docs/c.md', 'c']] as const) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    return dir;
  };

  test('area plan: items, leaving one out, and a running session blocks it', async () => {
    const { planAuto } = await import('./auto.ts');
    const dir = fixture();
    try {
      const lib = [role('cto'), role('frontend', { writes: true })];
      const plan = planAuto('area', dir, lib);
      expect(plan.items.length).toBeGreaterThan(0);
      expect(plan.team[0]!.writes).toBe(false);
      expect(plan.team).toHaveLength(plan.items.length + 1);
      const off = planAuto('area', dir, lib, { off: [plan.items[0]!.id] });
      expect(off.team).toHaveLength(plan.team.length - 1);
      expect(planAuto('area', dir, lib, { running: true }).blocked).toBe('Detén la sesión para componer por partes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('role plan: honours off and lead', async () => {
    const { planAuto } = await import('./auto.ts');
    const dir = fixture();
    try {
      const lib = [role('cto'), role('pm'), role('frontend', { writes: true }), role('backend', { writes: true }), role('qa')];
      const plan = planAuto('role', dir, lib);
      expect(plan.team.length).toBeGreaterThan(0);
      const other = plan.items.find((i) => !i.lead)!;
      const t = planAuto('role', dir, lib, { off: [other.id], lead: plan.items.find((i) => i.id !== plan.lead)?.id });
      expect(t.team.some((r) => r.id === other.id)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Session.launchTeam: new run, add roles, refuse areas on an open run', () => {
    const { s, made } = session([]);
    const team = [role('cto'), role('area-x')];
    expect(s.launchTeam({ team: [], lead: 'cto', mode: 'role', perm: 'auto', profile: 'max' }).ok).toBe(false);
    expect(s.launchTeam({ team, lead: 'area-x', mode: 'area', perm: 'auto', profile: 'max' }).ok).toBe(true);
    expect(made[0]!.opts.roles.map((r) => r.id)).toEqual(['area-x', 'cto']);
    expect(made[0]!.opts.mode).toBe('area');
    expect(s.launchTeam({ team, lead: 'cto', mode: 'area', perm: 'auto', profile: 'max' })).toEqual({ ok: false, error: 'Detén la sesión para componer por partes' });
    expect(s.launchTeam({ team: [...team, role('qa')], lead: 'cto', mode: 'role', perm: 'auto', profile: 'max' })).toEqual({ ok: true, message: '1 agente añadido a la sesión' });
  });
});

describe('terminals', () => {
  test('parseAnsi: colours, 256/truecolor, reset, inverse and stray escapes', async () => {
    const { parseAnsi } = await import('./ansi.ts');
    expect(parseAnsi('plain')).toEqual([{ text: 'plain', style: undefined }]);
    const r = parseAnsi('\x1b[1;31mred\x1b[0m ok\x1b[38;5;196m!\x1b[38;2;1;2;3mx\x1b[7mi\x1b[?25l\x1b]0;title\x07');
    expect(r[0]).toEqual({ text: 'red', style: { color: '#cd3131', fontWeight: '700' } });
    expect(r[1]).toEqual({ text: ' ok', style: undefined });
    expect(r[2]!.style).toEqual({ color: 'rgb(255,0,0)' });
    expect(r[3]!.style).toEqual({ color: 'rgb(1,2,3)' });
    expect(r[4]!.style).toMatchObject({ backgroundColor: 'rgb(1,2,3)' });
    expect(r.map((x) => x.text).join('')).toBe('red ok!xi');
  });

  test('only agent windows of the open run are reachable, and only known keys are sent', async () => {
    const { perform, termTarget } = await import('./server.ts');
    const { s } = session([role('cto')]);
    expect(termTarget(s, 'cto', 'claude')).toBeNull();
    s.launch({ roleIds: ['cto'], perm: 'auto', profile: 'max' });
    (s.hq as any).agents.get('cto').tmux = 'orq-20990101-000000-cto';
    expect(termTarget(s, 'cto', 'claude')).toBe('orq-20990101-000000-cto:claude');
    expect(termTarget(s, 'cto', 'shell')).toBe('orq-20990101-000000-cto:shell');
    expect(termTarget(s, 'cto', 'other')).toBeNull();
    expect(termTarget(s, 'nobody', 'claude')).toBeNull();
    expect(await perform(s, { type: 'termKeys', id: 'x', win: 'claude', text: 'hi' })).toEqual({ ok: false, error: 'Ese terminal no está disponible' });
  });
});

describe('terminal endpoints with a real (private) tmux', () => {
  test('reads a pane and types into it through the API', async () => {
    const tmux = await import('../tmux.ts');
    if (!Bun.which('tmux')) return;
    const runId = '20990101-000009';
    tmux.registerRun(runId);
    const name = `orq-${runId}-cto`;
    tmux.newSession(name, os.tmpdir(), 'sh');
    const { s } = session([role('cto')]);
    s.launch({ roleIds: ['cto'], perm: 'auto', profile: 'max' });
    (s.hq as any).agents.get('cto').tmux = name;
    const web = await startWeb({ session: s, port: 0 });
    const get = async (q: string) => (await fetch(`${web.url}/api/term?${q}`, { headers: { 'x-orq-token': web.token } })).json() as Promise<any>;
    const act = (b: object) => fetch(`${web.url}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orq-token': web.token }, body: JSON.stringify(b) }).then((r) => r.json());
    try {
      expect(await act({ type: 'termKeys', id: 'cto', win: 'claude', text: 'echo web-term-ok', keys: ['Enter', 'rm -rf', 'C-c'] })).toEqual({ ok: true, message: '' });
      let text = '';
      for (let i = 0; i < 20 && !text.includes('web-term-ok\n'); i++) {
        await Bun.sleep(100);
        text = ((await get('id=cto&win=claude')).lines as string[]).join('\n');
      }
      expect(text).toMatch(/^web-term-ok$/m);
      expect((await get('id=nobody&win=claude')).error).toBe('Terminal no disponible');
    } finally {
      web.stop();
      tmux.killSession(name);
    }
  });
});
