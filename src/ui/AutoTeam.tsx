import { Box, Text } from 'ink';
import path from 'node:path';
import React, { useEffect, useMemo, useState } from 'react';
import { listProjectFiles, proposeAreas, validateAreas } from '../areas.ts';
import { planSaveIds, saveGeneratedTeam } from '../library.ts';
import { PROJECT_DIR } from '../paths.ts';
import { detectStack, proposeRoleTeam } from '../stack.ts';
import type { PermMode, Role } from '../types.ts';
import {
  type PlanArea,
  type RolePlan,
  addArea,
  addMember,
  buildAreaTeam,
  defaultLeadId,
  formatPaths,
  launchGate,
  resolveLead,
  missingFrom,
  planIssues,
  remapIds,
  roleTeam,
  rolePlanOf,
  saveConflicts,
  toggleMember,
} from './area-plan.ts';
import { AreaReview } from './AreaEditor.tsx';
import { nAgents, useApp, useSize, useTick, wrap } from './app-context.tsx';
import { MiniSprite, writesLabel } from './cards.tsx';
import { g } from './glyphs.ts';
import { moveIndex, useKeyboardCursor, useModal, useShortcuts } from './keymap.tsx';
import { Clickable } from './mouse.tsx';
import { toHex } from './sprites.ts';
import { DANGER, INFO, MUTED, SUCCESS, TEXT, WARN } from './theme.ts';
import { BackButton, Button, Checkbox, Divider, LaunchButtons, launchButtonsHeight, Pill, ScrollArea, useLaunchOptions, useScroll } from './widgets.tsx';

// ------------------------------------------------------------------ drafts

// `files`: the project file list, listed once per analysis and reused by every validation.
type Base = { stack: string[]; error?: string; save: boolean; files: string[] };
export type AreaDraft = Base & { kind: 'area'; original: PlanArea[]; areas: PlanArea[]; originalLead: string; lead: string; history: PlanArea[][] };
export type RoleDraft = Base & { kind: 'role'; original: RolePlan; plan: RolePlan };
export type Draft = AreaDraft | RoleDraft;

// One draft per mode and directory: edits survive tab switches; the analysis runs once (a re-analyse is explicit).
const drafts = new Map<string, Draft>();

function analyse(kind: Draft['kind'], cwd: string, roles: Role[]): Draft {
  let stack: string[] = [];
  let files: string[] = [];
  try {
    files = listProjectFiles(cwd);
    try {
      stack = detectStack(cwd, files).signals;
    } catch {
      /* the stack line is optional */
    }
    if (kind === 'role') {
      const plan = rolePlanOf(proposeRoleTeam(cwd, roles, files));
      return { kind, stack, files, save: false, original: plan, plan };
    }
    const areas = proposeAreas(cwd, { files });
    const lead = defaultLeadId(roles);
    return { kind, stack, files, save: false, original: areas, areas, originalLead: lead, lead, history: [] };
  } catch (e) {
    const error = (e as Error).message;
    const lead = defaultLeadId(roles);
    return kind === 'role'
      ? { kind, stack, files, save: false, error, original: { members: [], off: [], lead: '' }, plan: { members: [], off: [], lead: '' } }
      : { kind, stack, files, save: false, error, original: [], areas: [], originalLead: lead, lead, history: [] };
  }
}

/** `s` padded or cut with … to exactly `w` columns. */
const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));

/** Minimum time the "Analizando…" state stays up, so it does not flicker. */
const ANALYSE_MS = 300;

/**
 * Automatic composition ("Auto por rol" / "Auto por partes del código"): analysis,
 * preview with one main action («Crear y lanzar»), and an optional review.
 */
export function AutoTeam({ kind, width, height, onUseDept }: { kind: Draft['kind']; width: number; height: number; onUseDept: () => void }) {
  const { roles, hq } = useApp();
  const cwd = hq?.cwd ?? PROJECT_DIR;
  const key = `${kind}:${cwd}`;
  const [draft, setDraftState] = useState<Draft | null>(() => drafts.get(key) ?? null);
  const [review, setReview] = useState<number | null>(null); // row to open the review on
  const setDraft = (d: Draft) => (drafts.set(key, d), setDraftState(d));
  // Re-analysing keeps the «Guardar en este proyecto» choice.
  const keepSave = React.useRef<boolean | undefined>(undefined);
  const reanalyse = () => ((keepSave.current = draft?.save), drafts.delete(key), setDraftState(null), setReview(null));

  useEffect(() => {
    const cached = drafts.get(key);
    if (cached) return setDraftState(cached);
    setDraftState(null);
    const t = setTimeout(() => {
      const next = analyse(kind, cwd, roles);
      setDraft({ ...next, save: keepSave.current ?? next.save });
      keepSave.current = undefined;
    }, ANALYSE_MS);
    return () => clearTimeout(t);
  }, [key, draft === null]);

  if (!draft) return <Analysing cwd={cwd} width={width} height={height} />;
  if (review !== null && draft.kind === 'area')
    return <AreaReview draft={draft} setDraft={setDraft} cwd={cwd} width={width} height={height} initial={review} onDone={() => setReview(null)} />;
  if (review !== null && draft.kind === 'role') return <RoleReview draft={draft} setDraft={setDraft} width={width} height={height} initial={review} onDone={() => setReview(null)} />;
  return <Preview draft={draft} setDraft={setDraft} cwd={cwd} width={width} height={height} onReview={setReview} onReanalyse={reanalyse} onUseDept={onUseDept} />;
}

function Analysing({ cwd, width, height }: { cwd: string; width: number; height: number }) {
  useShortcuts('teams/auto/loading', [], { footer: 'teams.auto.loading' });
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text color={INFO}>
        {g.waiting} Analizando {cwd} para componer el equipo…
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------- preview

type Row = { id: string; role: Role; lead?: boolean; base: string; paths?: string[]; files?: number; reason: string; index: number };

const isEdited = (d: Draft) =>
  d.kind === 'area' ? d.lead !== d.originalLead || JSON.stringify(d.areas) !== JSON.stringify(d.original) : JSON.stringify(d.plan) !== JSON.stringify(d.original);

/** Back to the analysis result (undoable for areas with u). */
export const restoreDraft = (d: Draft): Draft =>
  d.kind === 'area' ? { ...d, areas: d.original, lead: d.originalLead, history: [...d.history, d.areas] } : { ...d, plan: d.original };

/** Team the draft would launch, lead first, plus the ids that are generated (saved on «Guardar»). */
export function draftTeam(d: Draft, roles: Role[]): { team: Role[]; lead: string; generated: string[] } {
  if (d.kind === 'role') {
    const t = roleTeam(d.plan);
    return { team: t.roles, lead: t.lead ?? '', generated: t.generated };
  }
  const leadRole = resolveLead(roles, d.lead);
  const team = buildAreaTeam(d.areas, leadRole, roles);
  const lib = new Set(roles.map((r) => r.id));
  return { team, lead: leadRole.id, generated: team.filter((r) => r.area || !lib.has(r.id)).map((r) => r.id) };
}

function Preview({
  draft,
  setDraft,
  cwd,
  width,
  height,
  onReview,
  onReanalyse,
  onUseDept,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  cwd: string;
  width: number;
  height: number;
  onReview: (row: number) => void;
  onReanalyse: () => void;
  onUseDept: () => void;
}) {
  const { roles, hq, perm, setPerm, profile, setProfile, provider, setProvider, launchRoles, reload, setToast, setError } = useApp();
  const modal = useModal();
  const cursor = useKeyboardCursor();
  const tick = useTick(true);
  const { cols } = useSize();
  // The keyboard lands on the preview right away, so its footer (↵ crear y lanzar…) shows from the first render.
  useEffect(() => cursor.reveal(), []);
  const [confirming, setConfirming] = useState(false);
  const area = draft.kind === 'area';
  const { team, lead, generated } = useMemo(() => draftTeam(draft, roles), [draft, roles]);
  const issues = useMemo(() => {
    if (draft.kind !== 'area') return [];
    try {
      return planIssues(draft.areas, validateAreas(draft.areas.filter((a) => !a.off), cwd, draft.files));
    } catch (e) {
      return [{ level: 'error' as const, text: `No pude validar las rutas: ${(e as Error).message}`, agents: [] }];
    }
  }, [draft, cwd]);
  const gate = area ? launchGate(issues, !!hq) : launchGate([], false);
  const toAdd = hq ? missingFrom(team, hq.agents.keys()) : team;
  const edited = isEdited(draft);
  // Always the .orq of the directory on screen, never the default (process.cwd()).
  const orqDir = path.join(cwd, '.orq');
  const conflicts = useMemo(() => (draft.save ? saveConflicts(planSaveIds(generated, 'roles', orqDir)) : []), [draft.save, generated.join(), orqDir]);
  const empty = area ? draft.areas.length === 0 : draft.plan.members.length === 0;

  const rows: Row[] = useMemo(() => {
    if (draft.kind === 'role') {
      const on = draft.plan.members.filter((m) => !draft.plan.off.includes(m.role.id));
      const ordered = [...on.filter((m) => m.role.id === lead), ...on.filter((m) => m.role.id !== lead)];
      return ordered.map((m) => ({ id: m.role.id, role: m.role, lead: m.role.id === lead, base: m.role.id, reason: m.reason, index: draft.plan.members.indexOf(m) }));
    }
    const [leadRole, ...agents] = team;
    const on = draft.areas.map((a, i) => ({ a, i })).filter(({ a }) => !a.off);
    return [
      { id: leadRole!.id, role: leadRole!, lead: true, base: leadRole!.id, reason: 'integra y reparte; sin rutas propias', index: -1 },
      ...on.map(({ a, i }, k) => ({ id: a.id, role: agents[k]!, base: a.base || 'dueño de área', paths: a.paths, files: a.files, reason: a.reason, index: i })),
    ];
  }, [draft, team, lead]);

  const [optsOpen, toggleOpts] = useLaunchOptions();
  const writers = team.filter((r) => r.writes).length;
  const leadRole = team[0];
  const narrow = cols < 100;
  const rowH = narrow ? 2 : 1;
  const inner = width - 2;
  const noteRows = 1 + (draft.save ? 0 : 1) + conflicts.length;
  const statusRows = area ? 1 : 0;
  const pillRow = area && hq ? 1 : 0;
  const fixed = 1 + (draft.stack.length ? 1 : 0) + 1 + statusRows + noteRows + pillRow + launchButtonsHeight({ running: !!hq && !area, confirming, profile: true, collapsed: !optsOpen });
  const listH = Math.max(rowH, height - fixed);
  const scroll = useScroll(rows.length * rowH, listH);
  const [ci, setCi] = useState(0);
  const cur = Math.min(ci, Math.max(0, rows.length - 1));

  const toggleSave = () => setDraft({ ...draft, save: !draft.save });
  const restore = () => setDraft(restoreDraft(draft));
  const askReanalyse = () =>
    edited
      ? modal.open({ title: '¿Descartar cambios y reanalizar?', actions: [{ label: '[R]eanalizar', variant: 'danger', run: onReanalyse }] })
      : onReanalyse();
  const blocked = gate.blocked || !toAdd.length;

  const go = (mode: PermMode = perm) => {
    if (blocked) return;
    let t = team;
    let l = lead;
    let saved = false;
    if (draft.save) {
      try {
        const name = `${area ? 'Partes' : 'Auto'} de ${path.basename(cwd)}`;
        const res = saveGeneratedTeam({ name, roles: team, lead, generatedIds: generated }, orqDir);
        ({ roles: t, lead: l } = remapIds(team, lead, res.idMap));
        saved = true;
        reload();
      } catch (e) {
        return setError(`No se pudo guardar el equipo: ${(e as Error).message}`);
      }
    }
    const n = launchRoles(t, l, mode, area ? 'area' : 'role');
    if (!n) return;
    setToast(hq ? `${nAgents(n)} añadido${n === 1 ? '' : 's'} a la sesión` : `Equipo creado y lanzado: ${nAgents(n)}${saved ? ' y guardado en este proyecto' : ''}`);
  };
  const askLaunch = () => {
    if (blocked) return;
    const n = toAdd.length;
    const list = rows.slice(0, 6).map((r) => `${r.lead ? g.star : ' '} ${r.role.name}${r.paths ? ` ${g.sep} ${formatPaths(r.paths, 2)}` : ''}`);
    if (rows.length > 6) list.push(`+${rows.length - 6} ${area ? 'áreas' : 'roles'} más`);
    modal.open({
      title: hq ? `¿Añadir ${nAgents(n)} a la sesión?` : `¿Crear y lanzar ${nAgents(n)} en modo Auto?`,
      lines: [
        ...list,
        area ? 'Composición automática por partes del código. Cada agente solo escribirá en sus rutas.' : 'Composición automática por rol.',
        ...(draft.save ? [`Se guardará en ${cwd}.`] : []),
      ],
      actions: [{ label: `${hq ? 'Añadir' : 'Crear y lanzar'} ${nAgents(n)}`, run: () => go('auto'), variant: 'primary' }],
      footer: 'confirm.launch',
    });
  };
  const moveRow = (k: string) => {
    const n = moveIndex(cur, rows.length, 1, k, Math.max(1, Math.floor(listH / rowH)));
    setCi(n);
    scroll.ensureVisible(n * rowH);
    scroll.ensureVisible(n * rowH + rowH - 1);
  };
  useShortcuts(
    'teams/auto',
    [
      ...['up', 'down', 'pageup', 'pagedown', 'home', 'end'].map((k) => ({ keys: [k], run: () => moveRow(k) })),
      { keys: ['enter', 'l'], run: askLaunch },
      { keys: ['r'], run: () => !empty && onReview(Math.max(0, rows[cur]?.index ?? 0)) },
      { keys: ['a'], run: askReanalyse },
      { keys: ['g'], run: toggleSave },
    ],
    { footer: 'teams.auto' },
  );

  if (empty) return <Empty draft={draft} cwd={cwd} width={width} height={height} onReanalyse={onReanalyse} onUseDept={onUseDept} onAdd={() => (draft.kind === 'area' ? (setDraft({ ...draft, areas: addArea(draft.areas) }), onReview(0)) : onReview(0))} />;

  const title = area ? 'Equipo por partes' : 'Equipo propuesto';
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Text wrap="truncate">
          <Text bold>{title}</Text>
          <Text color={MUTED}>
            {' '}
            {g.sep} {nAgents(team.length)} {g.sep} {writers} escriben {g.sep} coordina{' '}
          </Text>
          {leadRole ? <Text color={toHex(leadRole.color)}>{`${g.star} ${leadRole.name}`}</Text> : <Text color={MUTED}>nadie</Text>}
        </Text>
        <Box flexGrow={1} />
        {edited && <Pill color={INFO}>editado</Pill>}
        {edited && <Button variant="tertiary" label={`${g.sessions} Restaurar propuesta`} onClick={restore} />}
        <Button variant="tertiary" label={`${g.sessions} Reanalizar`} onClick={askReanalyse} />
        <Button variant={gate.errors.length ? 'primary' : 'secondary'} label="Revisar…" onClick={() => onReview(Math.max(0, rows[cur]?.index ?? 0))} />
      </Box>
      {draft.stack.length > 0 && (
        <Text color={MUTED} wrap="truncate">
          Detectado: {draft.stack.join(` ${g.sep} `)}
        </Text>
      )}
      <Divider width={inner} />
      <ScrollArea scroll={scroll} height={listH} onWheel={(d: number) => scroll.onWheel(Math.sign(d) * rowH)}>
        {rows.slice(Math.floor(scroll.offset / rowH), Math.floor(scroll.offset / rowH) + Math.ceil(listH / rowH)).map((r, k) => {
          const i = Math.floor(scroll.offset / rowH) + k;
          const here = cursor.visible && i === cur;
          const color = toHex(r.role.color);
          const label = `${r.role.name}, ${r.base}, ${r.role.writes ? 'escritor' : 'lector'}${r.paths ? `, rutas ${formatPaths(r.paths, 2)}` : ''}, motivo: ${r.reason}`;
          const rw = r.role.writes ? <Text color={WARN}>{g.write}</Text> : <Text color={MUTED}>{g.readOnly}</Text>;
          return (
            <Clickable key={r.id} onClick={() => (cursor.hide(), setCi(i), onReview(Math.max(0, r.index)))} flexDirection="column" height={rowH} flexShrink={0} aria-role="button" aria-label={label}>
              <Text wrap="truncate" inverse={here}>
                <Text color={WARN}>{r.lead ? g.star : ' '}</Text> {rw}{' '}
                <Text bold color={color}>
                  {narrow ? r.role.name : fit(r.role.name, 18)}
                </Text>{' '}
                <Text color={INFO}>{narrow ? r.base : fit(r.base, 13)}</Text>
                {!narrow && (
                  <Text color={MUTED}>
                    {' '}
                    {r.paths ? `${formatPaths(r.paths, 2) || 'sin rutas'} ${g.sep} ${r.files} fich. ${g.sep} ` : ''}
                    {r.reason}
                  </Text>
                )}
                {narrow && r.files !== undefined ? <Text color={MUTED}>{` ${g.sep} ${r.files} fich.`}</Text> : null}
              </Text>
              {narrow && (
                <Text color={MUTED} wrap="truncate">
                  {'    '}
                  {r.reason}
                </Text>
              )}
            </Clickable>
          );
        })}
      </ScrollArea>
      {area && (
        <Clickable onClick={() => onReview(Math.max(0, draft.areas.findIndex((a) => gate.errors[0]?.agents.includes(a.id))))} flexShrink={0} height={1}>
          {gate.errors.length ? (
            <Text color={DANGER} bold wrap="truncate">
              {g.warning} {gate.errors.length === 1 ? '1 conflicto' : `${gate.errors.length} conflictos`}: revisa antes de lanzar {g.sep} {gate.errors[0]!.text}
            </Text>
          ) : (
            <Text color={SUCCESS} wrap="truncate">
              {g.tick} Rutas sin solapes
              {gate.warnings.length ? <Text color={WARN}>{` ${g.sep} ${g.warning} ${gate.warnings.length === 1 ? '1 aviso' : `${gate.warnings.length} avisos`}: ${gate.warnings[0]!.text}`}</Text> : null}
            </Text>
          )}
        </Clickable>
      )}
      <Checkbox checked={draft.save} label="Guardar en este proyecto" onToggle={toggleSave} />
      {!draft.save && (
        <Text color={MUTED} wrap="truncate">
          {'  '}Si lo activas, este equipo y sus roles quedarán disponibles al abrir orq en {cwd}. Si no, solo existen en esta sesión.
        </Text>
      )}
      {conflicts.map((c) => (
        <Text key={c} color={WARN} wrap="truncate">
          {'  '}
          {g.warning} {c}
        </Text>
      ))}
      {area && hq && (
        <Box flexShrink={0}>
          <Pill color={WARN}>Detén la sesión para componer por partes</Pill>
        </Box>
      )}
      <LaunchButtons
        mode={perm}
        onModeChange={setPerm}
        onConfirmingChange={setConfirming}
        collapsed={!optsOpen}
        onToggleOptions={toggleOpts}
        profile={profile}
        onProfileChange={setProfile}
        provider={provider}
        onProviderChange={setProvider}
        count={toAdd.length}
        running={!!hq && !area}
        disabled={blocked}
        verb="Crear y lanzar"
        onLaunch={(mode) => go(mode)}
      />
    </Box>
  );
}

function Empty({ draft, cwd, width, height, onReanalyse, onUseDept, onAdd }: { draft: Draft; cwd: string; width: number; height: number; onReanalyse: () => void; onUseDept: () => void; onAdd: () => void }) {
  const area = draft.kind === 'area';
  const noFiles = draft.files.length === 0 && !draft.error;
  useShortcuts(
    'teams/auto/empty',
    [
      { keys: ['a'], run: onReanalyse },
      { keys: ['n'], run: onAdd, when: area },
    ],
    { footer: 'teams.auto.loading' },
  );
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      {draft.error ? (
        <>
          <Text color={DANGER} bold>
            {g.close} No pude analizar {cwd}
          </Text>
          <Text color={MUTED} wrap="truncate">
            {draft.error}
          </Text>
        </>
      ) : (
        <>
          <Text bold>
            {g.off} {noFiles ? `La carpeta ${cwd} está vacía` : area ? `No encuentro partes de código en ${cwd}` : `No encuentro roles que proponer para ${cwd}`}
          </Text>
          {wrap('La carpeta está vacía o no tiene una estructura que sepa dividir (src/, packages/, apps/, tests/…).', width - 4, 2).map((l) => (
            <Text key={l} color={MUTED}>
              {l}
            </Text>
          ))}
        </>
      )}
      <Box flexDirection="row" marginTop={1}>
        {draft.error && <Button variant="primary" label={`${g.sessions} Reintentar`} onClick={onReanalyse} />}
        {area && <Button variant={draft.error ? 'secondary' : 'primary'} label={`${g.add} Añadir área a mano`} onClick={onAdd} />}
        <Button variant="secondary" label="Usar «Departamento»" onClick={onUseDept} />
        {!draft.error && <Button variant="secondary" label={`${g.sessions} Reanalizar`} onClick={onReanalyse} />}
      </Box>
    </Box>
  );
}

// ------------------------------------------------------------ role review

function RoleReview({ draft, setDraft, width, height, initial, onDone }: { draft: RoleDraft; setDraft: (d: Draft) => void; width: number; height: number; initial: number; onDone: () => void }) {
  const { roles } = useApp();
  const cursor = useKeyboardCursor();
  const tick = useTick(true);
  const { plan } = draft;
  const setPlan = (p: RolePlan) => setDraft({ ...draft, plan: p });
  const [mc, setMc] = useState(Math.min(initial, Math.max(0, plan.members.length - 1)));
  const addable = roles.filter((r) => !plan.members.some((m) => m.role.id === r.id && !plan.off.includes(r.id)));
  const [pick, setPick] = useState(0);
  const pickRole = addable[Math.min(pick, addable.length - 1)];
  const { lead } = roleTeam(plan);
  const inner = width - 2;
  const listH = Math.max(3, height - 4);
  const scroll = useScroll(plan.members.length * 3, listH);
  const current = plan.members[mc]?.role;
  const move = (k: string) => {
    const n = moveIndex(mc, plan.members.length, 1, k, Math.max(1, Math.floor(listH / 3)));
    setMc(n);
    scroll.ensureVisible(n * 3);
    scroll.ensureVisible(n * 3 + 2);
  };
  const add = () => pickRole && (setPlan(addMember(plan, pickRole)), setPick(0));
  useShortcuts(
    'teams/auto/roles',
    [
      ...['up', 'down', 'pageup', 'pagedown', 'home', 'end'].map((k) => ({ keys: [k], run: () => move(k) })),
      { keys: ['space'], run: () => current && setPlan(toggleMember(plan, current.id)) },
      { keys: ['c'], run: () => current && !plan.off.includes(current.id) && setPlan({ ...plan, lead: current.id }) },
      { keys: ['left'], run: () => setPick((pick + addable.length - 1) % Math.max(1, addable.length)) },
      { keys: ['right'], run: () => setPick((pick + 1) % Math.max(1, addable.length)) },
      { keys: ['n'], run: add },
      { keys: ['esc'], run: onDone },
    ],
    { footer: 'teams.auto.roles' },
  );
  const first = Math.floor(scroll.offset / 3);
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Box flexDirection="row" flexShrink={0} height={1}>
        <BackButton label="Volver a la vista previa" onClick={onDone} />
        <Button variant="primary" label="Listo" onClick={onDone} />
        <Button variant="tertiary" label={`${g.sessions} Restaurar propuesta`} onClick={() => setDraft(restoreDraft(draft))} />
      </Box>
      <Divider title={`Miembros ${g.sep} clic: incluir/excluir ${g.sep} ${g.star} coordinador`} width={inner} />
      <ScrollArea scroll={scroll} height={listH} onWheel={(d: number) => scroll.onWheel(Math.sign(d) * 3)}>
        {plan.members.slice(first, first + Math.ceil(listH / 3)).map((m, k) => {
          const i = first + k;
          const on = !plan.off.includes(m.role.id);
          const here = cursor.visible && i === mc;
          return (
            <Box key={m.role.id} flexDirection="row" height={3} flexShrink={0}>
              <Clickable onClick={() => (cursor.hide(), setMc(i), setPlan(toggleMember(plan, m.role.id)))} flexDirection="row" flexGrow={1} aria-role="checkbox" aria-label={`${m.role.name}, motivo: ${m.reason}`} aria-state={{ checked: on }}>
                <MiniSprite role={m.role} tick={tick + i * 2} dim={!on} />
                <Box flexDirection="column" marginLeft={1} flexGrow={1}>
                  <Text bold={on || here} inverse={here} color={on ? toHex(m.role.color) : MUTED} wrap="truncate">
                    {on ? g.checked : g.unchecked} {m.role.name} <Text color={MUTED}>{m.role.title}</Text>
                    {m.generated ? <Text color={INFO}> (generado)</Text> : null}
                  </Text>
                  <Text color={MUTED} wrap="truncate">
                    {m.reason}
                  </Text>
                  <Text wrap="truncate">{writesLabel(m.role)}</Text>
                </Box>
              </Clickable>
              <Clickable onClick={() => on && setPlan({ ...plan, lead: m.role.id })} width={2} aria-role="radio" aria-label={`Coordinador: ${m.role.name}`} aria-state={{ checked: lead === m.role.id }}>
                <Text color={lead === m.role.id ? WARN : MUTED}>{lead === m.role.id ? g.star : g.starOff}</Text>
              </Clickable>
            </Box>
          );
        })}
      </ScrollArea>
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Text color={MUTED}>Añadir rol </Text>
        {pickRole ? (
          <>
            <Button variant="tertiary" label={g.back} onClick={() => setPick((pick + addable.length - 1) % addable.length)} />
            <Text color={toHex(pickRole.color)}>{pickRole.name} </Text>
            <Button variant="tertiary" label={g.next} onClick={() => setPick((pick + 1) % addable.length)} />
            <Button variant="secondary" label={`${g.add} Añadir rol`} onClick={add} />
          </>
        ) : (
          <Text color={MUTED}>ya están todos los roles de la biblioteca</Text>
        )}
      </Box>
      <Text color={TEXT} wrap="truncate">
        {roleTeam(plan).roles.length} agentes
      </Text>
    </Box>
  );
}
