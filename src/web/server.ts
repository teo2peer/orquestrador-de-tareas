import path from 'node:path';
import { USER } from '../hq.ts';
import { loadRoles } from '../library.ts';
import { forgetRun, renameRun, stopRunSessions } from '../runs.ts';
import { type Outcome, Session } from '../session.ts';
import { savePrefs } from '../ui/prefs.ts';
import { invalidateRuns, snapshot } from './snapshot.ts';

const CLIENT = path.join(import.meta.dir, 'client');
const PERMS = ['auto', 'auto-insecure', 'yolo'] as const;
const PROFILES = ['saver', 'balanced', 'max'] as const;
const TOKEN_HEADER = 'x-orq-token';

type Action = Record<string, unknown> & { type: string };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const fail = (error: string): Outcome => ({ ok: false, error });

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
