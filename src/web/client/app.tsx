import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Run as AnsiRun, parseAnsi } from '../ansi.ts';
import type { Snapshot } from '../snapshot.ts';

type Run = NonNullable<Snapshot['run']>;
type Agent = Run['agents'][number];
type Tab = 'teams' | 'roles' | 'office' | 'terminals' | 'messages' | 'sessions';
type Perm = 'auto' | 'auto-insecure' | 'yolo';
type Profile = 'saver' | 'balanced' | 'max';
type AutoPlan = Omit<import('../auto.ts').AutoPlan, 'team' | 'generated'>;
type Compose = 'dept' | 'role' | 'area';
type Outcome = { ok: true; message: string } | { ok: false; error: string };

const TOKEN = document.querySelector<HTMLMetaElement>('meta[name=orq-token]')!.content;

async function act(body: Record<string, unknown>): Promise<Outcome> {
  try {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-orq-token': TOKEN }, body: JSON.stringify(body) });
    return (await r.json()) as Outcome;
  } catch (e) {
    return { ok: false, error: `Sin conexión con orq: ${(e as Error).message}` };
  }
}

/** Live snapshot of the server (SSE); the browser reconnects by itself. */
function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${TOKEN}`);
    es.onmessage = (e) => (setOnline(true), setSnap(JSON.parse(e.data)));
    // A restarted server issues a new token: the old page can only be reloaded.
    es.onerror = () => (setOnline(false), es.readyState === EventSource.CLOSED && location.reload());
    return () => es.close();
  }, []);
  return { snap, online };
}

const COLORS: Record<string, string> = { red: '#d1453b', green: '#2e8b57', yellow: '#c79a1c', blue: '#2f6fb0', magenta: '#a24fb3', cyan: '#1f9aa8', white: '#8a8f98', gray: '#8a8f98', orange: '#e0782f' };
const colorOf = (c: string) => (c.startsWith('#') ? c : (COLORS[c] ?? '#8a8f98'));
const STATUS: Record<string, string> = { dormant: 'en espera', starting: 'arrancando', idle: 'libre', working: 'trabajando', waiting: 'esperando', error: 'error', stopped: 'parado' };
const PERM_NAME: Record<Perm, string> = { auto: 'Auto', 'auto-insecure': 'Auto + permisivo', yolo: 'YOLO' };
const PROFILE_NAME: Record<Profile, string> = { max: 'Máximo', balanced: 'Equilibrado', saver: 'Ahorro' };
const when = (ts: number) => new Date(ts).toLocaleString('es-ES', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Dot({ status, color }: { status?: string; color?: string }) {
  return <span className={`dot ${status ? `status-${status}` : ''}`} style={color ? { background: colorOf(color) } : undefined} />;
}

function Confirm({ title, lines, action, danger, onYes, onNo }: { title: string; lines: string[]; action: string; danger?: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className="overlay" onClick={onNo}>
      <div className="dialog" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {lines.map((l) => (
          <p key={l} className="muted">{l}</p>
        ))}
        <div className="row">
          <button className="btn" autoFocus onClick={onNo}>Cancelar</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onYes}>{action}</button>
        </div>
      </div>
    </div>
  );
}

type Tell = (o: Outcome) => void;

/** «Auto por rol» / «Auto por partes del código»: the server analyses the directory, the user trims and launches. */
function useAuto(kind: Compose, running: boolean, version: number) {
  const [off, setOff] = useState<string[]>([]);
  const [lead, setLead] = useState('');
  const [save, setSave] = useState(false);
  const [plan, setPlan] = useState<AutoPlan | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (kind === 'dept') return;
    const q = new URLSearchParams({ token: TOKEN, kind, lead, save: save ? '1' : '0' });
    for (const o of off) q.append('off', o);
    let live = true;
    fetch(`/api/auto?${q}`)
      .then((r) => r.json())
      .then((d) => live && ('error' in d ? (setError(d.error), setPlan(null)) : (setError(''), setPlan(d))))
      .catch((e) => live && setError(String(e)));
    return () => void (live = false);
  }, [kind, off.join(), lead, save, running, nonce]);
  useEffect(() => (setOff([]), setLead(''), setPlan(null), setError('')), [kind]);
  return { plan, error, off, lead, save, setSave, setLead, reanalyse: () => (setOff([]), setLead(''), setNonce((n) => n + 1)), toggle: (id: string) => setOff((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id])) };
}

function AutoPreview({ kind, auto }: { kind: 'role' | 'area'; auto: ReturnType<typeof useAuto> }) {
  const { plan, error } = auto;
  if (error) return <p className="alert">{error}</p>;
  if (!plan) return <p className="muted">Analizando el directorio…</p>;
  return (
    <>
      {plan.stack.length > 0 && <p className="muted small">Detectado: {plan.stack.join(' · ')}</p>}
      {plan.items.length === 0 && <p className="muted">No encontré nada que proponer en este directorio.</p>}
      <div className="grid">
        {plan.items.map((it) => (
          <label key={it.id} className={`card ${it.off ? '' : 'sel'}`} style={{ cursor: 'pointer' }}>
            <h3><input type="checkbox" checked={!it.off} onChange={() => auto.toggle(it.id)} /> <Dot color={it.color} /> {it.name} {it.lead && '★'} <span className="small muted">{it.writes ? '✎ escribe' : '👁 lee'}</span></h3>
            {it.paths && <div className="small"><code>{it.paths.join(', ') || 'sin rutas'}</code> · {it.files} fich.</div>}
            <div className="small muted">{it.base} — {it.reason}</div>
          </label>
        ))}
      </div>
      <fieldset>
        <legend>Líder</legend>
        <select value={plan.lead} onChange={(e) => auto.setLead(e.target.value)}>
          {plan.leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </fieldset>
      {plan.issues.map((i, k) => <div key={k} className="alert" style={{ borderColor: i.level === 'error' ? 'var(--danger)' : 'var(--warn)' }}>{i.text}</div>)}
      {plan.blocked && <p className="small" style={{ color: 'var(--danger)' }}>{plan.blocked}</p>}
      <label className="opt"><input type="checkbox" checked={auto.save} onChange={(e) => auto.setSave(e.target.checked)} /> Guardar en este proyecto (<code>.orq/</code>)</label>
      {auto.save && plan.conflicts.map((c) => <div key={c} className="small muted">{c}</div>)}
      <div style={{ marginTop: 6 }}><button className="btn" onClick={auto.reanalyse}>↻ Reanalizar</button></div>
    </>
  );
}

function Teams({ snap, tell, goOffice }: { snap: Snapshot; tell: Tell; goOffice: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState('');
  const [perm, setPerm] = useState<Perm>('auto');
  const [profile, setProfile] = useState<Profile>(snap.prefs.profile);
  const [provider, setProvider] = useState(snap.prefs.provider);
  const [ask, setAsk] = useState(false);
  const [compose, setCompose] = useState<Compose>('dept');
  const running = !!snap.run;
  const auto = useAuto(compose, running, snap.run?.version ?? 0);
  const autoCount = auto.plan ? auto.plan.items.filter((i) => !i.off).length + (compose === 'area' ? 1 : 0) : 0;
  const autoBlocked = compose !== 'dept' && (!auto.plan || !!auto.plan.blocked || autoCount === 0);
  const roleById = useMemo(() => new Map(snap.roles.map((r) => [r.id, r])), [snap.roles]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const pickDept = (d: Snapshot['depts'][number]) => {
    setPicked(d.roles.filter((id) => roleById.has(id)));
    setLead(d.lead ?? '');
  };
  const effLead = picked.includes(lead) ? lead : (picked[0] ?? '');
  const risky = perm !== 'auto';
  const n = compose === 'dept' ? picked.length : autoCount;
  const go = async () => {
    setAsk(false);
    const out = compose === 'dept' ? await act({ type: 'launch', roleIds: picked, lead: effLead, perm, profile, provider }) : await act({ type: 'launchAuto', kind: compose, off: auto.off, lead: auto.lead, save: auto.save, perm, profile, provider });
    tell(out);
    if (out.ok) goOffice();
  };
  const categories = [...new Set(snap.depts.map((d) => d.category))];
  return (
    <>
      <p className="muted">Directorio: <code>{snap.cwd}</code></p>
      <div className="row">
        {([['dept', 'Departamento'], ['role', 'Auto por rol'], ['area', 'Auto por partes del código']] as [Compose, string][]).map(([id, label]) => (
          <button key={id} className={`chip ${compose === id ? 'sel' : ''}`} onClick={() => setCompose(id)}>{label}</button>
        ))}
      </div>
      {compose !== 'dept' && <AutoPreview kind={compose} auto={auto} />}
      {compose === 'dept' && categories.map((cat) => (
        <section key={cat}>
          <h2>{cat}</h2>
          <div className="grid">
            {snap.depts.filter((d) => d.category === cat).map((d) => {
              const sel = d.roles.length > 0 && d.roles.every((id) => picked.includes(id)) && picked.length === d.roles.length;
              return (
                <button key={d.id} className={`card ${sel ? 'sel' : ''}`} onClick={() => pickDept(d)}>
                  <h3><span style={{ color: colorOf(d.color) }}>{d.icon}</span> {d.name}</h3>
                  <div className="muted small">{d.description}</div>
                  <div className="small">{d.roles.length} roles</div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {compose === 'dept' && <><h2>Roles sueltos</h2>
      <div className="row">
        {snap.roles.map((r) => (
          <button key={r.id} className={`chip ${picked.includes(r.id) ? 'sel' : ''}`} title={r.description} onClick={() => toggle(r.id)}>
            <Dot color={r.color} /> {r.name}
          </button>
        ))}
      </div></>}

      <h2>Lanzar</h2>
      {compose === 'dept' && <fieldset>
        <legend>Líder</legend>
        <select value={effLead} onChange={(e) => setLead(e.target.value)} disabled={!picked.length || running}>
          {picked.map((id) => (
            <option key={id} value={id}>{roleById.get(id)?.name ?? id}</option>
          ))}
        </select>
      </fieldset>}
      <fieldset disabled={running}>
        <legend>Permisos</legend>
        {(Object.keys(PERM_NAME) as Perm[]).map((p) => (
          <label key={p} className="opt"><input type="radio" checked={perm === p} onChange={() => setPerm(p)} /> {PERM_NAME[p]}</label>
        ))}
      </fieldset>
      <fieldset disabled={running}>
        <legend>Perfil de coste</legend>
        {(Object.keys(PROFILE_NAME) as Profile[]).map((p) => (
          <label key={p} className="opt"><input type="radio" checked={profile === p} onChange={() => setProfile(p)} /> {PROFILE_NAME[p]}</label>
        ))}
      </fieldset>
      <fieldset disabled={running}>
        <legend>Proveedor</legend>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">Cada rol, el suyo</option>
          {snap.providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </fieldset>
      <button className="btn primary" disabled={compose === 'dept' ? !picked.length : autoBlocked} onClick={() => (risky && !running ? setAsk(true) : void go())}>
        {running ? `Añadir ${n} a la sesión` : compose === 'dept' ? `Lanzar ${n} agente${n === 1 ? '' : 's'}` : `Crear y lanzar ${n} agente${n === 1 ? '' : 's'}`}
      </button>
      {ask && (
        <Confirm
          title={`¿Lanzar ${n} agente${n === 1 ? '' : 's'} en modo ${PERM_NAME[perm]}?`}
          lines={[`Directorio: ${snap.cwd}`, perm === 'yolo' ? 'YOLO: los agentes ejecutan cualquier herramienta sin pedir permiso.' : 'Los agentes piden menos confirmaciones de lo normal.']}
          action="Lanzar"
          danger
          onYes={go}
          onNo={() => setAsk(false)}
        />
      )}
    </>
  );
}


type RoleInfo = Snapshot['roles'][number];
const COLOR_NAMES = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'orange'];

function RoleForm({ snap, role, tell, done }: { snap: Snapshot; role: RoleInfo | null; tell: Tell; done: () => void }) {
  const [f, setF] = useState({ name: role?.name ?? '', title: role?.title ?? '', description: role?.description ?? '', color: role?.color ?? 'cyan', writes: role?.writes ?? true, provider: role?.provider ?? '', model: role?.model ?? '', scope: role?.scope ?? 'global', prompt: '' });
  const [loaded, setLoaded] = useState(!role);
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    if (!role) return;
    fetch(`/api/role?id=${encodeURIComponent(role.id)}`, { headers: { 'x-orq-token': TOKEN } })
      .then((r) => r.json())
      .then((d: { prompt: string }) => (setF((x) => ({ ...x, prompt: d.prompt })), setLoaded(true)));
  }, [role?.id]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const out = await act({ type: 'saveRole', id: role?.id, ...f });
    tell(out);
    if (out.ok) done();
  };
  return (
    <div className="card">
      <h3>{role ? `Editar «${role.name}»` : 'Nuevo rol'}</h3>
      <fieldset><legend>Nombre</legend><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} /></fieldset>
      <fieldset><legend>Título</legend><input type="text" value={f.title} onChange={(e) => set('title', e.target.value)} /></fieldset>
      <fieldset><legend>Descripción</legend><textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></fieldset>
      <fieldset><legend>Prompt{role?.fromSource ? ' (del archivo fuente; editarlo lo reemplaza)' : ''}</legend><textarea rows={10} disabled={!loaded} value={f.prompt} onChange={(e) => set('prompt', e.target.value)} /></fieldset>
      <div className="row">
        <select value={f.color} onChange={(e) => set('color', e.target.value)} style={{ width: 'auto' }}>
          {[...new Set([f.color, ...COLOR_NAMES])].map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={f.provider} onChange={(e) => set('provider', e.target.value)} style={{ width: 'auto' }}>
          <option value="">Proveedor por defecto</option>
          {snap.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input type="text" placeholder="Modelo (opcional)" value={f.model} onChange={(e) => set('model', e.target.value)} style={{ width: 160 }} />
        <select value={f.scope} onChange={(e) => set('scope', e.target.value as 'global' | 'project')} style={{ width: 'auto' }}>
          <option value="global">Global (~/.orq)</option>
          <option value="project">Proyecto (.orq)</option>
        </select>
        <label className="opt"><input type="checkbox" checked={f.writes} onChange={(e) => set('writes', e.target.checked)} /> Escribe archivos</label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={!loaded} onClick={save}>Guardar</button>
        <button className="btn" onClick={done}>Cancelar</button>
        <span className="spacer" />
        {role && <button className="btn danger" onClick={() => setAsk(true)}>Borrar</button>}
      </div>
      {ask && role && <Confirm title={`¿Borrar «${role.name}»?`} lines={['Se elimina su archivo de la biblioteca.']} action="Borrar" danger onYes={async () => { setAsk(false); const out = await act({ type: 'deleteRole', id: role.id }); tell(out); if (out.ok) done(); }} onNo={() => setAsk(false)} />}
    </div>
  );
}

function Roles({ snap, tell }: { snap: Snapshot; tell: Tell }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | 'new' | null>(null);
  const list = snap.roles.filter((r) => `${r.name} ${r.title} ${r.description} ${r.pack ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const cur = sel && sel !== 'new' ? (snap.roles.find((r) => r.id === sel) ?? null) : null;
  return (
    <div className="layout">
      <div>
        <div className="row"><input type="text" placeholder="Filtrar roles" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} /><button className="btn primary" onClick={() => setSel('new')}>＋ Nuevo</button></div>
        <div className="grid" style={{ marginTop: 12 }}>
          {list.map((r) => (
            <button key={r.id} className={`card ${sel === r.id ? 'sel' : ''}`} onClick={() => setSel(r.id)}>
              <h3><Dot color={r.color} /> {r.name}</h3>
              <div className="small muted">{r.title}{r.pack ? ` · ${r.pack}` : ''} · {r.scope === 'project' ? 'proyecto' : 'global'}</div>
              <div className="small">{r.description}</div>
            </button>
          ))}
        </div>
      </div>
      {sel === 'new' ? <RoleForm key="new" snap={snap} role={null} tell={tell} done={() => setSel(null)} /> : cur ? <RoleForm key={cur.id} snap={snap} role={cur} tell={tell} done={() => setSel(null)} /> : <p className="muted">Elige un rol para editarlo o crea uno nuevo.</p>}
    </div>
  );
}

type TermData = { lines: string[]; cursor: { x: number; y: number } | null; mouse: boolean; alt: boolean; back: number };

/** One row as styled spans; the cursor cell is drawn inverted. */
function Row({ line, cursorX }: { line: string; cursorX?: number }) {
  let runs: AnsiRun[] = parseAnsi(line);
  if (cursorX !== undefined) {
    const out: AnsiRun[] = [];
    let at = 0;
    let done = false;
    for (const r of runs) {
      const chars = [...r.text];
      if (!done && cursorX < at + chars.length) {
        const k = cursorX - at;
        if (k > 0) out.push({ text: chars.slice(0, k).join(''), style: r.style });
        out.push({ text: chars[k]!, style: { ...r.style, backgroundColor: '#e5e5e5', color: '#1e1e1e' } });
        if (k + 1 < chars.length) out.push({ text: chars.slice(k + 1).join(''), style: r.style });
        done = true;
      } else out.push(r);
      at += chars.length;
    }
    if (!done) out.push({ text: ' '.repeat(Math.max(0, cursorX - at)) + ' ', style: { backgroundColor: '#e5e5e5' } });
    runs = out;
  }
  return <div>{runs.length ? runs.map((r, i) => <span key={i} style={r.style}>{r.text}</span>) : ' '}</div>;
}

/** tmux key name of a browser key event (null: not a special key; printable text goes as literal). */
function tmuxKey(e: React.KeyboardEvent): string | null {
  const map: Record<string, string> = { Enter: 'Enter', Escape: 'Escape', Tab: e.shiftKey ? 'BTab' : 'Tab', Backspace: 'BSpace', Delete: 'DC', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
  if (map[e.key]) return map[e.key]!;
  if (e.ctrlKey && /^[a-z]$/i.test(e.key)) return `C-${e.key.toLowerCase()}`;
  return null;
}

function Terminals({ run, tell }: { run: Run | null; tell: Tell }) {
  const live = run?.agents.filter((a) => a.status !== 'dormant') ?? [];
  const [id, setId] = useState('');
  const [win, setWin] = useState<'claude' | 'shell'>('claude');
  const [type, setType] = useState(false);
  const [back, setBack] = useState(0);
  const [data, setData] = useState<TermData | null>(null);
  const [error, setError] = useState('');
  const cur = live.find((a) => a.id === id)?.id ?? live[0]?.id ?? '';
  useEffect(() => setBack(0), [cur, win]);
  useEffect(() => {
    if (!cur) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/term?id=${encodeURIComponent(cur)}&win=${win}&back=${back}`, { headers: { 'x-orq-token': TOKEN } });
        const d = await r.json();
        if (!alive) return;
        if ('error' in d) return setError(d.error);
        setError('');
        setData(d);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void poll();
    const t = setInterval(poll, type ? 250 : 700);
    return () => (alive = false, clearInterval(t));
  }, [cur, win, back, type]);
  const [paste, setPaste] = useState('');
  const send = (body: Record<string, unknown>) => void act({ type: 'termKeys', id: cur, win, ...body }).then((o) => !o.ok && tell(o));
  if (!run) return <p className="muted">No hay sesión abierta.</p>;
  if (!live.length) return <p className="muted">Todavía no hay agentes arrancados.</p>;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey) return;
    const k = tmuxKey(e);
    if (k) return e.preventDefault(), send({ keys: [k] });
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey) return e.preventDefault(), send({ text: e.key });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (data?.mouse) return void act({ type: 'termWheel', id: cur, win, up: e.deltaY < 0 });
    if (data?.alt) return;
    setBack((b) => Math.max(0, b + (e.deltaY < 0 ? 3 : -3)));
  };
  return (
    <>
      <div className="row">
        {live.map((a) => <button key={a.id} className={`chip ${a.id === cur ? 'sel' : ''}`} onClick={() => setId(a.id)}><Dot status={a.status} /> {a.name}</button>)}
        <span className="spacer" />
        {(['claude', 'shell'] as const).map((w) => <button key={w} className={`chip ${win === w ? 'sel' : ''}`} onClick={() => setWin(w)}>{w === 'claude' ? 'Terminal Claude' : 'Terminal comandos'}</button>)}
      </div>
      <div className="row" style={{ margin: '8px 0' }}>
        <button className={`btn ${type ? 'primary' : ''}`} onClick={() => setType(!type)}>{type ? '⌨ Escribiendo (clic fuera para salir)' : '⌨ Escribir'}</button>
        {back > 0 && <><span className="small muted">↑ historial · {back} líneas</span><button className="btn" onClick={() => setBack(0)}>Volver al vivo</button></>}
        {error && <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>}
      </div>
      <div className={`term ${type ? 'typing' : ''}`} tabIndex={0} onKeyDown={type ? onKey : undefined} onBlur={() => setType(false)} onWheel={onWheel} ref={(el) => {
        if (type) el?.focus();
      }}>
        {(data?.lines ?? []).map((l, i) => <Row key={i} line={l} cursorX={type && data?.cursor?.y === i ? data.cursor.x : undefined} />)}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <textarea rows={2} placeholder="Pegar texto en el terminal (se envía tal cual, sin Enter)" value={paste} onChange={(e) => setPaste(e.target.value)} style={{ flex: 1 }} />
        <button className="btn" disabled={!paste} onClick={() => (send({ text: paste }), setPaste(''))}>Pegar</button>
        <button className="btn" onClick={() => send({ keys: ['Enter'] })}>↵ Enter</button>
      </div>
    </>
  );
}

function AgentPanel({ run, agent, tell }: { run: Run; agent: Agent; tell: Tell }) {
  const [text, setText] = useState('');
  const send = async () => {
    const out = await act({ type: 'send', to: agent.id, body: text });
    tell(out);
    if (out.ok) setText('');
  };
  return (
    <div className="card">
      <h3><Dot color={agent.color} /> {agent.name} <span className="muted small">· {agent.title}{run.lead === agent.id ? ' · líder' : ''}</span></h3>
      <div className="small muted">{STATUS[agent.status]}{agent.model ? ` · ${agent.model}` : ''}{agent.ctxTokens ? ` · ${Math.round(agent.ctxTokens / 1000)}k ctx` : ''}</div>
      <textarea rows={3} placeholder={`Tarea o mensaje para ${agent.name}`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void send()} />
      <div className="row">
        <button className="btn primary" disabled={!text.trim()} onClick={send}>Enviar</button>
        <button className="btn" onClick={async () => tell(await act({ type: 'compact', id: agent.id }))}>Compactar</button>
        <button className="btn" onClick={async () => tell(await act({ type: 'clear', id: agent.id }))}>Empezar limpio</button>
      </div>
      <div className="tl">
        {agent.timeline.length === 0 && <div className="muted">Sin actividad todavía</div>}
        {[...agent.timeline].reverse().map((t, i) => (
          <div key={i}><span className="muted">{new Date(t.ts).toLocaleTimeString('es-ES', { hour12: false })} {t.kind}</span> {t.text}</div>
        ))}
      </div>
    </div>
  );
}

function Office({ run, tell, goTeams }: { run: Run | null; tell: Tell; goTeams: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [ask, setAsk] = useState<'stop' | null>(null);
  if (!run) return <p className="muted">No hay sesión abierta. <button className="btn" onClick={goTeams}>Elegir un equipo</button></p>;
  const cur = run.agents.find((a) => a.id === open) ?? run.agents[0];
  return (
    <>
      <div className="row">
        <h2 style={{ margin: 0 }}>{run.title || `Sesión ${run.runId}`}</h2>
        <span className="muted small">{PERM_NAME[run.permMode]} · {PROFILE_NAME[run.profile]}</span>
        <span className="spacer" />
        <button className="btn" onClick={async () => tell(await act({ type: 'detach' }))}>Desconectar</button>
        <button className="btn danger" onClick={() => setAsk('stop')}>Detener</button>
      </div>
      <div className="layout" style={{ marginTop: 12 }}>
        <div className="grid">
          {run.agents.map((a) => (
            <button key={a.id} className={`card ${cur?.id === a.id ? 'sel' : ''}`} onClick={() => setOpen(a.id)}>
              <h3><Dot status={a.status} /> {a.name}</h3>
              <div className="small muted">{STATUS[a.status]}{a.children ? ` · ${a.children} sub` : ''}</div>
              <div className="small">{a.task || a.lastOut || a.lastIn || ' '}</div>
              {a.lastTool && <div className="small muted">⚙ {a.lastTool}</div>}
            </button>
          ))}
        </div>
        {cur && <AgentPanel key={cur.id} run={run} agent={cur} tell={tell} />}
      </div>
      {ask && <Confirm title={`¿Detener la sesión? Se cerrarán sus ${run.agents.length} agentes.`} lines={['El historial se guarda; podrás reanudarla desde Sesiones.']} action="Detener" danger onYes={async () => (setAsk(null), tell(await act({ type: 'stop' })))} onNo={() => setAsk(null)} />}
    </>
  );
}

function Reply({ msgId, options, tell }: { msgId: string; options?: string[]; tell: Tell }) {
  const [text, setText] = useState('');
  const send = async (t: string) => {
    const out = await act({ type: 'reply', msgId, text: t });
    tell(out);
    if (out.ok) setText('');
  };
  return (
    <>
      <div className="row" style={{ margin: '6px 0' }}>
        {options?.map((o) => (
          <button key={o} className="btn" onClick={() => void send(o)}>{o}</button>
        ))}
      </div>
      <div className="row">
        <input type="text" placeholder="Otra respuesta" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && void send(text)} style={{ flex: 1 }} />
        <button className="btn primary" disabled={!text.trim()} onClick={() => void send(text)}>Responder</button>
      </div>
    </>
  );
}

function Messages({ run, tell }: { run: Run | null; tell: Tell }) {
  if (!run) return <p className="muted">No hay sesión abierta.</p>;
  const answered = new Set(run.messages.filter((m) => m.replyTo).map((m) => m.replyTo));
  return (
    <>
      {run.alerts.length > 0 && <h2>Pendiente de ti</h2>}
      {run.alerts.map((a) => (
        <div key={a.id} className="alert">
          <strong>{a.from}</strong> <span className="muted small">{a.kind}</span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{a.text}</div>
          {a.kind === 'question' && a.msgId ? (
            <Reply msgId={a.msgId} options={a.options} tell={tell} />
          ) : a.kind === 'blocked' ? (
            <div className="muted small">Está esperando en su terminal (tmux): respóndele allí.</div>
          ) : (
            <div className="row">
              {(a.kind === 'trust' || a.kind === 'bypass' || a.kind === 'hire') && <button className="btn primary" onClick={async () => tell(await act({ type: 'notice', id: a.id, accept: true }))}>{a.kind === 'hire' ? 'Aprobar' : 'Aceptar'}</button>}
              <button className="btn" onClick={async () => tell(await act({ type: 'notice', id: a.id, accept: false }))}>{a.kind === 'info' ? 'Cerrar' : 'Rechazar'}</button>
            </div>
          )}
        </div>
      ))}
      <h2>Historial</h2>
      {[...run.messages].reverse().map((m) => (
        <div key={m.id} className={`msg ${m.to === 'user' ? 'to-user' : ''}`}>
          <div className="small muted">{when(m.ts)} · {m.from} → {m.to} · {m.type}{answered.has(m.id) ? ' · respondida' : ''}</div>
          {m.body}
        </div>
      ))}
      {run.messages.length === 0 && <p className="muted">Sin mensajes todavía.</p>}
    </>
  );
}

function Sessions({ snap, tell, goOffice }: { snap: Snapshot; tell: Tell; goOffice: () => void }) {
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [stopAsk, setStopAsk] = useState<string | null>(null);
  const open = snap.run?.runId;
  const resume = async (dir: string) => {
    const out = await act({ type: 'resume', dir });
    tell(out);
    if (out.ok) goOffice();
  };
  return (
    <>
      {open && <p className="muted">Hay una sesión abierta ({open}). Desconéctala o deténla para reanudar otra.</p>}
      {snap.runs.length === 0 && <p className="muted">Todavía no hay sesiones.</p>}
      {snap.runs.map((r) => (
        <div key={r.runId} className="card" style={{ marginBottom: 8 }}>
          <div className="row">
            <Dot status={r.live > 0 ? 'working' : 'stopped'} />
            {renaming?.id === r.runId ? (
              <input type="text" autoFocus value={renaming.value} onChange={(e) => setRenaming({ id: r.runId, value: e.target.value })} onKeyDown={async (e) => {
                if (e.key === 'Escape') return setRenaming(null);
                if (e.key !== 'Enter') return;
                const out = await act({ type: 'rename', runId: r.runId, title: renaming.value });
                tell(out);
                if (out.ok) setRenaming(null);
              }} style={{ flex: 1 }} />
            ) : (
              <strong>{r.title || r.runId}</strong>
            )}
            <span className="muted small">{when(r.updatedAt)} · {r.team.length} agentes · {r.live > 0 ? `${r.live} en vivo` : 'parada'} · {r.messages} mensajes</span>
            <span className="spacer" />
            <button className="btn" onClick={() => setRenaming({ id: r.runId, value: r.title && !r.titleProvisional ? r.title : '' })}>Renombrar</button>
            <button className="btn primary" disabled={!!open || !r.exists} onClick={() => void resume(r.dir)}>{r.live > 0 ? 'Reconectar' : 'Reanudar'}</button>
            {r.live > 0 && <button className="btn danger" onClick={() => setStopAsk(r.runId)}>Detener</button>}
            {r.live === 0 && r.runId !== open && <button className="btn" onClick={async () => tell(await act({ type: 'forget', runId: r.runId }))}>Quitar</button>}
          </div>
          <div className="small muted">{r.cwd}{r.lastReport ? ` — ${r.lastReport.slice(0, 160)}` : ''}</div>
        </div>
      ))}
      {stopAsk && <Confirm title="¿Detener la sesión? Se cerrarán sus agentes." lines={['El historial se guarda; podrás reanudarla desde Sesiones.']} action="Detener" danger onYes={async () => (setStopAsk(null), tell(await act({ type: 'stopRun', runId: stopAsk })))} onNo={() => setStopAsk(null)} />}
    </>
  );
}

function App() {
  const { snap, online } = useSnapshot();
  const [tab, setTab] = useState<Tab>('teams');
  const [toast, setToast] = useState<{ text: string; err: boolean } | null>(null);
  const tell = useCallback<Tell>((o) => setToast({ text: o.ok ? o.message : o.error, err: !o.ok }), []);
  useEffect(() => {
    if (!toast || toast.err) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  if (!snap) return <main className="muted">Conectando con orq…</main>;
  const pending = snap.run?.alerts.length ?? 0;
  const tabs: [Tab, string, number?][] = [['teams', 'Equipos'], ['roles', 'Roles'], ['office', 'Oficina'], ['terminals', 'Terminales'], ['messages', 'Mensajes', pending], ['sessions', 'Sesiones']];
  return (
    <>
      <header>
        <h1>orq</h1>
        <nav>
          {tabs.map(([id, label, n]) => (
            <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              {label}{n ? <span className="badge">{n}</span> : null}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {!online && <span className="small" style={{ color: 'var(--danger)' }}>sin conexión con orq… (si cerraste `orq web`, ábrelo de nuevo)</span>}
        <span className="usage">{snap.usage.map((u) => `${u.label} ${Math.round(u.pct)}%`).join(' · ')}</span>
      </header>
      <main>
        {tab === 'teams' && <Teams snap={snap} tell={tell} goOffice={() => setTab('office')} />}
        {tab === 'roles' && <Roles snap={snap} tell={tell} />}
        {tab === 'office' && <Office run={snap.run} tell={tell} goTeams={() => setTab('teams')} />}
        {tab === 'terminals' && <Terminals run={snap.run} tell={tell} />}
        {tab === 'messages' && <Messages run={snap.run} tell={tell} />}
        {tab === 'sessions' && <Sessions snap={snap} tell={tell} goOffice={() => setTab('office')} />}
      </main>
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`} onClick={() => setToast(null)} role="status">{toast.text}</div>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
