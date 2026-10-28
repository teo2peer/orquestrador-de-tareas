import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot } from '../snapshot.ts';

type Run = NonNullable<Snapshot['run']>;
type Agent = Run['agents'][number];
type Tab = 'teams' | 'office' | 'messages' | 'sessions';
type Perm = 'auto' | 'auto-insecure' | 'yolo';
type Profile = 'saver' | 'balanced' | 'max';
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
    es.onerror = () => setOnline(false);
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

function Teams({ snap, tell, goOffice }: { snap: Snapshot; tell: Tell; goOffice: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState('');
  const [perm, setPerm] = useState<Perm>('auto');
  const [profile, setProfile] = useState<Profile>(snap.prefs.profile);
  const [provider, setProvider] = useState(snap.prefs.provider);
  const [ask, setAsk] = useState(false);
  const running = !!snap.run;
  const roleById = useMemo(() => new Map(snap.roles.map((r) => [r.id, r])), [snap.roles]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const pickDept = (d: Snapshot['depts'][number]) => {
    setPicked(d.roles.filter((id) => roleById.has(id)));
    setLead(d.lead ?? '');
  };
  const effLead = picked.includes(lead) ? lead : (picked[0] ?? '');
  const risky = perm !== 'auto';
  const go = async () => {
    setAsk(false);
    const out = await act({ type: 'launch', roleIds: picked, lead: effLead, perm, profile, provider });
    tell(out);
    if (out.ok) goOffice();
  };
  const categories = [...new Set(snap.depts.map((d) => d.category))];
  return (
    <>
      <p className="muted">Directorio: <code>{snap.cwd}</code></p>
      {categories.map((cat) => (
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
      <h2>Roles sueltos</h2>
      <div className="row">
        {snap.roles.map((r) => (
          <button key={r.id} className={`chip ${picked.includes(r.id) ? 'sel' : ''}`} title={r.description} onClick={() => toggle(r.id)}>
            <Dot color={r.color} /> {r.name}
          </button>
        ))}
      </div>

      <h2>Lanzar</h2>
      <fieldset>
        <legend>Líder</legend>
        <select value={effLead} onChange={(e) => setLead(e.target.value)} disabled={!picked.length || running}>
          {picked.map((id) => (
            <option key={id} value={id}>{roleById.get(id)?.name ?? id}</option>
          ))}
        </select>
      </fieldset>
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
      <button className="btn primary" disabled={!picked.length} onClick={() => (risky && !running ? setAsk(true) : void go())}>
        {running ? `Añadir ${picked.length} a la sesión` : `Lanzar ${picked.length} agente${picked.length === 1 ? '' : 's'}`}
      </button>
      {ask && (
        <Confirm
          title={`¿Lanzar ${picked.length} agente${picked.length === 1 ? '' : 's'} en modo ${PERM_NAME[perm]}?`}
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
  const tabs: [Tab, string, number?][] = [['teams', 'Equipos'], ['office', 'Oficina'], ['messages', 'Mensajes', pending], ['sessions', 'Sesiones']];
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
        {!online && <span className="small" style={{ color: 'var(--danger)' }}>sin conexión…</span>}
        <span className="usage">{snap.usage.map((u) => `${u.label} ${Math.round(u.pct)}%`).join(' · ')}</span>
      </header>
      <main>
        {tab === 'teams' && <Teams snap={snap} tell={tell} goOffice={() => setTab('office')} />}
        {tab === 'office' && <Office run={snap.run} tell={tell} goTeams={() => setTab('teams')} />}
        {tab === 'messages' && <Messages run={snap.run} tell={tell} />}
        {tab === 'sessions' && <Sessions snap={snap} tell={tell} goOffice={() => setTab('office')} />}
      </main>
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`} onClick={() => setToast(null)} role="status">{toast.text}</div>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
