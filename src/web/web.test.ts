import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
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
