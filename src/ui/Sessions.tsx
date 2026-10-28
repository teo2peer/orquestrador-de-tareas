import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { PROJECT_DIR } from '../paths.ts';
import { type ResumeEstimate, type ResumeRecommendation, estimateResume, recommendResume } from '../resume.ts';
import { runIsServed } from '../hq.ts';
import { type RunSummary, forgetRun, listRuns, loadRun, renameRun, stopRunSessions } from '../runs.ts';
import type { ResumeMode } from '../types.ts';
import { nAgents, useApp, useSize } from './app-context.tsx';
import { Modal, modalContentWidth, useKeyboardCursor, useNav, useShortcuts, useModal } from './keymap.tsx';
import { Clickable, MouseLayer } from './mouse.tsx';
import { deferred, fmtTokens, loadPrefs, resumeAdvice, savePrefs } from './prefs.ts';
import { g } from './glyphs.ts';
import { toHex } from './sprites.ts';
import { DONE, INFO, MUTED, PROFILE_SHORT, PERM_COLOR, PERM_SHORT, PRIMARY, SELECTED_BG, SUCCESS, WARN } from './theme.ts';
import { Button, Divider, OptionPicker, Pill, TextField, Toggle, useFocusState, useScroll, ScrollArea } from './widgets.tsx';

const when = (ts: number) => new Date(ts).toLocaleString('es-ES', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ROW_H = 2;
/** Longest session title (ux). */
export const TITLE_MAX = 60;
/** Title as stored: single spaces, trimmed, at most TITLE_MAX characters; '' when empty. */
export const cleanTitle = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

/**
 * Renames a session: the open one through hq; any other only when no orq window serves it
 * (that window owns its run.json). Returns the error to show, or null when renamed.
 */
export async function renameSession(
  runId: string,
  value: string,
  deps: { hq: { runId: string; setTitle: (t: string) => unknown } | null; isServed: (runId: string) => Promise<boolean>; renameRun: (runId: string, title: string) => boolean },
): Promise<string | null> {
  const t = cleanTitle(value);
  if (!t) return 'Escribe un título.';
  if (deps.hq?.runId === runId) return deps.hq.setTitle(t), null;
  if (await deps.isServed(runId)) return 'Esa sesión está abierta en otra ventana de orq: renómbrala allí.';
  return deps.renameRun(runId, t) ? null : 'No se pudo renombrar la sesión.';
}

export function Sessions({ height }: { height: number }) {
  const { hq, resume, setTab, setToast, setError } = useApp();
  const { focused, setFocused } = useFocusState();
  // Inline title editing (t / ✎ Renombrar): ↵ saves, Esc (leaving the field) cancels.
  const [renaming, setRenaming] = useState<{ runId: string; value: string } | null>(null);
  const startRename = (r: RunSummary) => (setRenaming({ runId: r.runId, value: r.title && !r.titleProvisional ? r.title : '' }), setFocused('run-title'));
  useEffect(() => {
    if (renaming && focused !== 'run-title') setRenaming(null);
  }, [focused]);
  const rename = async (r: RunSummary, value: string) => {
    const err = await renameSession(r.runId, value, { hq, isServed: runIsServed, renameRun });
    if (err) return setError(err);
    setFocused(null);
    setRenaming(null);
    refresh();
    setToast('Sesión renombrada');
  };
  // Stopped run waiting for the light/full choice.
  // Stopped run waiting for the light/full choice: the (cheap) recommendation opens the
  // dialog at once; the (costly) estimate arrives a moment later.
  const [asking, setAsking] = useState<{ run: RunSummary; rec: ResumeRecommendation; est: ResumeEstimate | null } | null>(null);
  const estimating = React.useRef(deferred()).current;
  useEffect(() => () => estimating.cancel(), []);
  // Live runs reconnect as they are; stopped ones ask how (unless no agent has a transcript).
  const reopen = (r: RunSummary) => {
    if (r.live > 0) return void resume(r.dir);
    let meta: ReturnType<typeof loadRun>;
    let rec: ResumeRecommendation;
    try {
      meta = loadRun(r.dir);
      rec = recommendResume(meta);
    } catch (e) {
      return setError(`No pude leer la sesión: ${(e as Error).message}`);
    }
    // No agent with a transcript: nothing to choose, it can only come back light.
    if (!rec.agents.length) return void resume(r.dir, 'light');
    setAsking({ run: r, rec, est: null });
    estimating.run(() => {
      try {
        // The same recommendation as the pill, so the «Completa» figure follows that decision.
        const est = estimateResume(meta, undefined, undefined, rec);
        setAsking((a) => (a && a.run.runId === r.runId ? { ...a, est } : a));
      } catch {
        /* the dialog keeps «calculando…»; resuming still works */
      }
    });
  };
  // Closing or resuming drops a pending estimate (and so does leaving the tab).
  const closeAsking = () => (estimating.cancel(), setAsking(null));
  const modal = useModal();
  const { cols } = useSize();
  const cursor = useKeyboardCursor();
  const [nav, setNav] = useNav('sessions');
  const [scope, setScope] = useState<'here' | 'all'>('here');
  const [runs, setRuns] = useState<RunSummary[]>([]);

  const refresh = () => setRuns(listRuns(scope === 'here' ? PROJECT_DIR : undefined));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [scope, hq?.runId]);

  const live = runs.filter((r) => r.live > 0).length;
  // toolbar · directory (this dir only) · divider · rows · "close the current session" note
  const listH = Math.max(ROW_H, height - 1 - (scope === 'here' ? 1 : 0) - 1 - (hq ? 1 : 0));
  const visible = Math.max(1, Math.floor(listH / ROW_H));
  const scroll = useScroll(runs.length, visible);
  const inner = cols - 2;

  const askStop = (r: RunSummary) =>
    modal.open({
      title: `¿Detener la sesión? Se cerrarán sus ${nAgents(r.live)}.`,
      lines: ['El historial se guarda; podrás reanudarla desde Sesiones.'],
      actions: [{ label: '[D]etener', variant: 'danger', run: () => (stopRunSessions(r.runId), refresh()) }],
    });
  const askForget = (r: RunSummary) =>
    modal.open({
      title: '¿Quitar esta sesión de la lista? El historial sigue en disco.',
      actions: [{ label: '[Q]uitar de la lista', variant: 'danger', run: () => (forgetRun(r.runId), refresh(), setToast('Sesión quitada de la lista (el historial sigue en disco)')) }],
    });

  const ci = Math.min(nav.index, Math.max(0, runs.length - 1));
  const cur = runs[ci];
  const curIsHere = !!cur && hq?.runId === cur.runId;
  const go = (n: number) => {
    const i = Math.max(0, Math.min(runs.length - 1, n));
    setNav({ zone: 'list', index: i });
    if (i < scroll.offset) scroll.scrollTo(i);
    else if (i >= scroll.offset + visible) scroll.scrollTo(i - visible + 1);
  };
  const enter = () => {
    if (!cur) return;
    if (curIsHere) return setTab('office');
    if (!hq && cur.exists) reopen(cur);
  };
  useShortcuts(
    'sessions',
    [
      { keys: ['up'], run: () => go(ci - 1) },
      { keys: ['down'], run: () => go(ci + 1) },
      { keys: ['pageup'], run: () => go(ci - visible) },
      { keys: ['pagedown'], run: () => go(ci + visible) },
      { keys: ['home'], run: () => go(0) },
      { keys: ['end'], run: () => go(runs.length - 1) },
      { keys: ['enter'], run: enter },
      { keys: ['s'], run: () => cur && cur.live > 0 && !curIsHere && askStop(cur) },
      { keys: ['delete'], run: () => cur && !curIsHere && askForget(cur) },
      { keys: ['a'], run: () => setScope(scope === 'here' ? 'all' : 'here') },
      { keys: ['t'], run: () => cur && startRename(cur) },
    ],
    { footer: curIsHere ? 'sessions.current' : cur && cur.live > 0 ? 'sessions.live' : 'sessions.stopped' },
  );

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Toggle
          label="Ámbito"
          value={scope}
          onChange={setScope}
          hint="a"
          options={[
            { value: 'here', label: 'Este directorio' },
            { value: 'all', label: 'Todos los directorios' },
          ]}
        />
        <Text color={MUTED} wrap="truncate">
          {' '}
          {runs.length} sesiones {g.sep} <Text color={SUCCESS}>{live} activas</Text>
        </Text>
      </Box>
      {scope === 'here' && (
        <Text color={MUTED} wrap="truncate">
          {PROJECT_DIR}
        </Text>
      )}
      <Divider width={inner} />
      <ScrollArea scroll={scroll} height={listH} onWheel={(d: number) => scroll.onWheel(Math.sign(d))}>
        {runs.length === 0 && (
          <Text color={MUTED}>
            No hay sesiones guardadas{scope === 'here' ? ' en este directorio' : ''}.
          </Text>
        )}
        {runs.slice(scroll.offset, scroll.offset + visible).map((r, i) => {
          const current = hq?.runId === r.runId;
          const here = cursor.visible && scroll.offset + i === ci;
          const state = current ? { t: 'abierta aquí', c: PRIMARY, gl: g.focus } : r.live > 0 ? { t: `activa ${g.sep} ${nAgents(r.live)}`, c: SUCCESS, gl: g.on } : { t: 'detenida', c: MUTED, gl: g.off };
          const perm = r.permMode ? `${r.permMode === 'auto' ? '' : `${g.warning} `}${PERM_SHORT[r.permMode]}` : PERM_SHORT.auto;
          const editing = renaming?.runId === r.runId;
          return (
            <Box key={r.runId} flexDirection="row" height={ROW_H} flexShrink={0} paddingX={1} backgroundColor={current ? SELECTED_BG : undefined}>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                {editing ? (
                  <TextField
                    id="run-title"
                    label="Título:"
                    value={renaming.value}
                    onChange={(v) => setRenaming({ runId: r.runId, value: v.slice(0, TITLE_MAX) })}
                    onSubmit={(v) => void rename(r, v)}
                    placeholder="↵ guarda · Esc cancela"
                    width={Math.max(20, Math.min(TITLE_MAX + 2, cols - 50))}
                  />
                ) : (
                <Text wrap="truncate" inverse={here}>
                  {here ? `${g.cursor} ` : ''}
                  {r.title ? <Text bold>{r.title}</Text> : <Text color={MUTED}>Sin título</Text>}
                  {r.title && r.titleProvisional ? <Text color={MUTED}> (provisional)</Text> : null}
                  <Text color={r.title ? undefined : MUTED}>
                    {' '}
                    {g.sep} {when(r.startedAt)}
                  </Text>
                  <Text color={state.c}>
                    {' '}
                    {state.gl} {state.t}
                  </Text>
                  <Text color={MUTED}>
                    {' '}
                    {g.sep} {r.runId} {g.sep} <Text color={PERM_COLOR[r.permMode ?? 'auto']}>{perm}</Text> {g.sep}{' '}
                    <Pill color={r.mode === 'area' ? INFO : MUTED}>{r.mode === 'area' ? `${g.area} Por partes` : 'Por rol'}</Pill>
                    {r.profile ? <Pill color={r.profile === 'saver' ? WARN : MUTED}>{`Consumo: ${PROFILE_SHORT[r.profile]}`}</Pill> : null}{r.provider ? <Pill color={INFO}>{`Proveedor: ${r.provider}`}</Pill> : null} {g.sep} {r.messages} mensajes
                  </Text>
                  {scope === 'all' ? (
                    <Text color={WARN}>
                      {' '}
                      {g.sep} {r.cwd}
                    </Text>
                  ) : null}
                </Text>
                )}
                <Text wrap="truncate">
                  {r.team.map((m, i) => (
                    <Text key={m.id} color={toHex(m.color)}>
                      {i ? ', ' : ''}
                      {m.id === r.lead ? g.star : ''}
                      {m.name}
                    </Text>
                  ))}
                  <Text color={MUTED}> {g.sep} </Text>
                  {r.lastReport ? <Text color={DONE}>{`${g.tick} ${r.lastReport.replace(/\s+/g, ' ')}`}</Text> : <Text color={MUTED}>sin informes</Text>}
                </Text>
              </Box>
              <Box flexDirection="column" flexShrink={0} marginLeft={1} alignItems="flex-end">
                <Box flexDirection="row">
                {current ? (
                  <Button variant="primary" label="Ir a la oficina" onClick={() => setTab('office')} />
                ) : (
                  <Button variant="primary" label={r.live > 0 ? 'Reconectar' : 'Reanudar'} disabled={!!hq || !r.exists} onClick={() => reopen(r)} />
                )}
                {r.live > 0 && !current && <Button variant="danger" label={`${g.stop} Detener`} onClick={() => askStop(r)} />}
                {!current && <Button variant="danger" label={`${g.close} Quitar`} onClick={() => askForget(r)} />}
                </Box>
                <Button variant="tertiary" label={`${g.edit} Renombrar`} onClick={() => startRename(r)} />
              </Box>
            </Box>
          );
        })}
      </ScrollArea>
      {hq && (
        <Text color={WARN} wrap="truncate">
          Para reanudar otra sesión, detén o desconecta la actual (arriba a la dcha.)
        </Text>
      )}
      {asking && (
        <MouseLayer>
          <ResumeDialog
            run={asking.run}
            rec={asking.rec}
            est={asking.est}
            // pm decision: the recommendation (cache age) wins over the last choice; the saved
            // choice only preselects when there is no recommendation.
            initial={asking.rec.recommended ?? loadPrefs().resumeMode ?? 'light'}
            width={cols}
            height={height}
            onClose={closeAsking}
            onResume={(mode) => (closeAsking(), savePrefs({ resumeMode: mode }), void resume(asking.run.dir, mode))}
          />
        </MouseLayer>
      )}
    </Box>
  );
}

/** «¿Cómo reanudar …?»: Ligera (summary per agent, default: last choice) or Completa (whole transcripts). */
export function ResumeDialog({
  run,
  rec,
  est,
  initial,
  width,
  height,
  onClose,
  onResume,
}: {
  run: RunSummary;
  /** Recommendation (cheap, known when the dialog opens). */
  rec: ResumeRecommendation;
  /** Token estimates; null while they are being computed («calculando…»). */
  est: ResumeEstimate | null;
  /** Preselected mode: the recommendation (the last choice only when there is none). */
  initial: ResumeMode;
  width: number;
  height: number;
  onClose: () => void;
  onResume: (mode: ResumeMode) => void;
}) {
  const [mode, setMode] = useState<ResumeMode>(initial);
  const name = run.title || when(run.startedAt);
  const modes: ResumeMode[] = ['light', 'full'];
  // `full` is already the warm or cold estimate (whichever applies); a warm one is not «más caro».
  const warm = rec.reason.kind === 'warm';
  const options = [
    // Both in the same unit (total); per agent only as a detail of Ligera.
    { value: 'light', label: `Ligera ${g.sep} ${est ? `≈ ${fmtTokens(est.light)} tokens en total (≈ ${fmtTokens(est.lightPerAgent)} por agente)` : 'calculando…'}`, recommended: rec.recommended === 'light' },
    { value: 'full', label: `Completa ${g.sep} ${est ? `≈ ${fmtTokens(est.full ?? 0)} tokens en total` : 'calculando…'}${warm ? '' : ` ${g.sep} más caro`}`, recommended: rec.recommended === 'full' },
  ];
  const help: Record<ResumeMode, string> = {
    light: 'Cada agente empieza limpio con un resumen de su trabajo, su tarea pendiente y sus mensajes sin leer.',
    full: 'Recupera la conversación entera de cada agente.',
  };
  const contentW = modalContentWidth(width, 76);
  return (
    <Modal
      title={`¿Cómo reanudar «${name}»?`}
      width={width}
      height={height}
      maxWidth={76}
      contentRows={8}
      onClose={onClose}
      onUpDown={(d) => setMode(modes[(modes.indexOf(mode) + d + 2) % 2]!)}
      onKeys={(names) => (names.includes('1') ? (setMode('light'), true) : names.includes('2') ? (setMode('full'), true) : false)}
      color={PRIMARY}
      footer="confirm.launch"
      actions={[
        { label: `${g.play} Reanudar (↵)`, run: () => onResume(mode), variant: 'primary' },
        { label: 'Cancelar (Esc)', run: onClose, variant: 'secondary' },
      ]}
      initialFocus={0}
    >
      <Box flexDirection="column">
        <OptionPicker label="Modo de reanudar" options={options} value={mode} onChange={(v) => setMode(v as ResumeMode)} cursor={modes.indexOf(mode)} width={contentW} />
        <Text color={INFO} wrap="wrap">
          {resumeAdvice(rec.reason)}
        </Text>
        <Text> </Text>
        <Text color={MUTED} wrap="wrap">
          {help[mode]} Cifras aproximadas.
        </Text>
      </Box>
    </Modal>
  );
}

