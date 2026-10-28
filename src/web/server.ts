import path from 'node:path';
import { USER } from '../hq.ts';
import { deleteFile, loadRoles, makeId, saveRole } from '../library.ts';
import { forgetRun, renameRun, stopRunSessions } from '../runs.ts';
import { PROJECT_DIR } from '../paths.ts';
import { type Outcome, Session } from '../session.ts';
import type { Role } from '../types.ts';
import { savePrefs } from '../ui/prefs.ts';
import { type AutoKind, planAuto, saveAuto } from './auto.ts';
import * as tmux from '../tmux.ts';
import { invalidateRuns, snapshot } from './snapshot.ts';

const CLIENT = path.join(import.meta.dir, 'client');
const PERMS = ['auto', 'auto-insecure', 'yolo'] as const;
const PROFILES = ['saver', 'balanced', 'max'] as const;
const TOKEN_HEADER = 'x-orq-token';

type Action = Record<string, unknown> & { type: string };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const fail = (error: string): Outcome => ({ ok: false, error });

const WINDOWS = ['claude', 'shell'] as const;
/** Named keys the web terminal may send (tmux key names); anything else typed goes as literal text. */
const TERM_KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'BSpace', 'DC', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Space']);
const CTRL_KEY = /^C-[a-z]$/;

/** tmux target of an agent window of the OPEN run only (never an arbitrary session name). */
export function termTarget(session: Session, id: string, w: string): string | null {
  const agent = session.hq?.agents.get(id);
  if (!agent || agent.status === 'dormant' || !WINDOWS.includes(w as 'claude')) return null;
  return tmux.win(agent.tmux, w as 'claude' | 'shell');
}

/** Create or edit a role like the TUI's role editor: fields not in the form (hair, tools, mcp…) are kept. */
function saveRoleAction(a: Action): Outcome {
  const name = str(a.name).trim();
  const title = str(a.title).trim();
  if (!name && !title) return fail('Escribe un nombre');
  const existing = a.id ? loadRoles().find((r) => r.id === str(a.id)) : undefined;
  if (a.id && !existing) return fail('Ese rol no existe');
  const scope = a.scope === 'project' ? 'project' : 'global';
  const id = existing?.id ?? makeId(name || title);
  if (!existing && loadRoles().some((r) => r.id === id)) return fail(`Ya existe un rol con el id «${id}»`);
  const prompt = str(a.prompt);
  const { file: _f, prompt: _p, ...rest } = existing ?? ({} as Partial<Role>);
  const file = saveRole({
    accessory: 'none',
    ...rest,
    id,
    name: name || title,
    title: title || name,
    description: str(a.description),
    color: str(a.color) || existing?.color || 'white',
    writes: a.writes !== false,
    model: str(a.model) || undefined,
    provider: str(a.provider) || undefined,
    scope,
    // A pack role keeps following its source file unless the prompt was edited.
    ...(existing?.source && prompt === existing.prompt ? {} : { body: prompt }),
  } as Parameters<typeof saveRole>[0]);
  if (existing && existing.scope !== scope) deleteFile(existing.file);
  return { ok: true, message: `Rol «${name || title}» guardado en ${file}` };
}

/** Runs one UI action against the session. Same rules as the TUI: it only calls the shared core. */
export async function perform(session: Session, a: Action): Promise<Outcome> {
  const hq = session.hq;
  switch (a.type) {
    case 'launch': {
      const perm = PERMS.find((p) => p === a.perm) ?? 'auto';
      const profile = PROFILES.find((p) => p === a.profile) ?? 'max';
      const provider = str(a.provider);
      savePrefs({ profile, provider });
      return session.launch({ roleIds: strs(a.roleIds), lead: str(a.lead) || undefined, perm, profile, provider });
    }
    case 'launchAuto': {
      const kind: AutoKind = a.kind === 'area' ? 'area' : 'role';
      const perm = PERMS.find((p) => p === a.perm) ?? 'auto';
      const profile = PROFILES.find((p) => p === a.profile) ?? 'max';
      const provider = str(a.provider);
      const cwd = hq?.cwd ?? PROJECT_DIR;
      let plan;
      try {
        plan = planAuto(kind, cwd, loadRoles(), { off: strs(a.off), lead: str(a.lead), running: !!hq });
      } catch (e) {
        return fail(`No pude analizar el proyecto: ${(e as Error).message}`);
      }
      if (plan.blocked) return fail(plan.blocked);
      if (!plan.team.length) return fail('No hay agentes que lanzar');
      let { team, lead } = plan;
      if (a.save === true) {
        try {
          ({ team, lead } = saveAuto(plan));
        } catch (e) {
          return fail(`No se pudo guardar el equipo: ${(e as Error).message}`);
        }
      }
      savePrefs({ profile, provider });
      const out = session.launchTeam({ team, lead, mode: kind, perm, profile, provider });
      return out.ok && a.save === true ? { ok: true, message: `${out.message} y guardado en este proyecto` } : out;
    }
    case 'resume':
      invalidateRuns();
      return session.resume(str(a.dir), a.mode === 'light' || a.mode === 'full' ? a.mode : 'auto');
    case 'detach':
      return session.detach();
    case 'stop':
      return session.stop();
    case 'send': {
      const to = str(a.to);
      const body = str(a.body).trim();
      if (!hq) return fail('No hay sesión abierta');
      if (!body) return fail('Escribe un mensaje');
      if (!hq.agents.has(to)) return fail(`No existe el agente "${to}"`);
      hq.post(USER, to, body, 'task');
      return { ok: true, message: 'Enviado' };
    }
    case 'reply': {
      const text = str(a.text).trim();
      if (!hq) return fail('No hay sesión abierta');
      if (!text) return fail('Escribe una respuesta');
      return hq.reply(str(a.msgId), text) ? { ok: true, message: 'Respondido' } : fail('Esa pregunta ya no existe');
    }
    case 'notice': {
      if (!hq) return fail('No hay sesión abierta');
      hq.answerNotice(str(a.id), a.accept === true, loadRoles());
      return { ok: true, message: a.accept === true ? 'Aceptado' : 'Rechazado' };
    }
    case 'rename': {
      const title = str(a.title);
      if (hq && hq.runId === str(a.runId)) return hq.setTitle(title) ? { ok: true, message: 'Sesión renombrada' } : fail('Escribe un título');
      invalidateRuns();
      return renameRun(str(a.runId), title) ? { ok: true, message: 'Sesión renombrada' } : fail('No se pudo renombrar la sesión');
    }
    case 'stopRun':
      if (hq?.runId === str(a.runId)) return session.stop();
      stopRunSessions(str(a.runId));
      invalidateRuns();
      return { ok: true, message: 'Sesión detenida' };
    case 'forget':
      if (hq?.runId === str(a.runId)) return fail('Detén la sesión abierta antes de quitarla');
      forgetRun(str(a.runId));
      invalidateRuns();
      return { ok: true, message: 'Sesión quitada de la lista (el historial sigue en disco)' };
    case 'saveRole':
      return saveRoleAction(a);
    case 'deleteRole': {
      const r = loadRoles().find((x) => x.id === str(a.id));
      if (!r) return fail('Ese rol no existe');
      deleteFile(r.file);
      return { ok: true, message: `Rol «${r.name}» borrado` };
    }
    case 'termKeys': {
      const target = termTarget(session, str(a.id), str(a.win));
      if (!target) return fail('Ese terminal no está disponible');
      // Text first, then the keys (typing a line and pressing Enter).
      const text = str(a.text);
      if (text) tmux.sendLiteral(target, text);
      for (const k of strs(a.keys)) if (TERM_KEYS.has(k) || CTRL_KEY.test(k)) tmux.sendKeys(target, [k]);
      return { ok: true, message: '' };
    }
    case 'termWheel': {
      const target = termTarget(session, str(a.id), str(a.win));
      if (!target) return fail('Ese terminal no está disponible');
      tmux.sendWheel(target, a.up === true, 40, 12, 3);
      return { ok: true, message: '' };
    }
    case 'compact':
      return hq?.compact(str(a.id)) ? { ok: true, message: 'Compactando…' } : fail('El agente no está libre: espera a que termine');
    case 'clear':
      return hq?.clear(str(a.id)) ? { ok: true, message: 'Empieza limpio' } : fail('El agente no está libre: espera a que termine');
    default:
      return fail(`Acción desconocida: ${a.type}`);
  }
}

/** Bundles the React client once at startup (no build step to run, nothing written to disk). */
async function bundle() {
  const res = await Bun.build({ entrypoints: [path.join(CLIENT, 'app.tsx')], target: 'browser', minify: true });
  if (!res.success) throw new Error(res.logs.map(String).join('\n'));
  return await res.outputs[0]!.text();
}

export type WebServer = { url: string; token: string; port: number; session: Session; stop: () => void };

/**
 * The web UI: a local HTTP server around one Session. Bound to 127.0.0.1 only; every request
 * must carry the per-launch token (embedded in the page) and a localhost Host, so another
 * website cannot drive the agents through the user's browser.
 */
export async function startWeb(opts: { port?: number; session?: Session; open?: boolean } = {}): Promise<WebServer> {
  const session = opts.session ?? new Session();
  const token = crypto.randomUUID();
  const js = await bundle();
  const html = (await Bun.file(path.join(CLIENT, 'index.html')).text()).replace('__TOKEN__', token);
  const css = await Bun.file(path.join(CLIENT, 'style.css')).text();
  const streams = new Set<ReadableStreamDefaultController<string>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = () => {
    if (timer || !streams.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      const data = `data: ${JSON.stringify(snapshot(session))}\n\n`;
      for (const c of streams) {
        try {
          c.enqueue(data);
        } catch {
          streams.delete(c);
        }
      }
    }, 100);
  };
  session.on('change', push);
  // Usage, run list and timers move without an HQ event: refresh now and then.
  const poll = setInterval(push, 3000);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get('host') ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return new Response('Forbidden', { status: 403 });
      if (req.method === 'GET' && url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      if (req.method === 'GET' && url.pathname === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
      if (req.method === 'GET' && url.pathname === '/style.css') return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
      if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
      if ((req.headers.get(TOKEN_HEADER) ?? url.searchParams.get('token')) !== token) return new Response('Forbidden', { status: 403 });

      if (req.method === 'GET' && url.pathname === '/api/events') {
        let ctl!: ReadableStreamDefaultController<string>;
        const stream = new ReadableStream<string>({
          start(c) {
            ctl = c;
            streams.add(c);
            c.enqueue(`data: ${JSON.stringify(snapshot(session))}\n\n`);
          },
          cancel() {
            streams.delete(ctl);
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/term') {
        const target = termTarget(session, url.searchParams.get('id') ?? '', url.searchParams.get('win') ?? 'claude');
        if (!target) return Response.json({ error: 'Terminal no disponible' }, { status: 404 });
        const back = Math.max(0, Math.floor(Number(url.searchParams.get('back')) || 0));
        let snap = tmux.snapshot(target);
        if (snap && back > 0 && !snap.alt && !snap.mouse) {
          const off = Math.min(back, snap.history);
          snap = tmux.snapshot(target, [-off, -off + snap.paneH - 1]) ?? snap;
          return Response.json({ lines: snap.lines, cursor: null, mouse: false, alt: false, back: off });
        }
        if (!snap) return Response.json({ error: 'Terminal no disponible' }, { status: 404 });
        return Response.json({ lines: snap.lines, cursor: snap.cursorOn ? { x: snap.cx, y: snap.cy } : null, mouse: snap.mouse, alt: snap.alt, back: 0 });
      }
      if (req.method === 'GET' && url.pathname === '/api/auto') {
        const p = url.searchParams;
        try {
          const { team: _t, generated: _g, ...plan } = planAuto(p.get('kind') === 'area' ? 'area' : 'role', session.hq?.cwd ?? PROJECT_DIR, loadRoles(), { off: p.getAll('off'), lead: p.get('lead') ?? '', running: !!session.hq, save: p.get('save') === '1' });
          return Response.json(plan);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/role') {
        const r = loadRoles().find((x) => x.id === url.searchParams.get('id'));
        return r ? Response.json({ prompt: r.prompt }) : new Response('Not found', { status: 404 });
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        let action: Action;
        try {
          action = (await req.json()) as Action;
          if (typeof action?.type !== 'string') throw new Error('bad action');
        } catch {
          return Response.json(fail('Petición inválida'), { status: 400 });
        }
        let out: Outcome;
        try {
          out = await perform(session, action);
        } catch (e) {
          out = fail((e as Error).message);
        }
        push();
        return Response.json(out);
      }
      return new Response('Not found', { status: 404 });
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    url: base,
    token,
    port: server.port!,
    session,
    stop: () => {
      clearInterval(poll);
      clearTimeout(timer);
      session.off('change', push);
      for (const c of streams) {
        try {
          c.close();
        } catch {}
      }
      server.stop(true);
    },
  };
}
