import { launchIssue } from '../providers.ts';
import { Box, Text, useStdin, useStdout } from 'ink';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { HQ, runIsServed } from '../hq.ts';
import { loadRun } from '../runs.ts';
import { PROJECT_DIR } from '../paths.ts';
import { loadDepartments, loadRoles } from '../library.ts';
import { type Alert, teamOf } from '../session.ts';
import type { CostProfile, Department, Msg, Notice, PermMode, ResumeMode, Role, TeamMode } from '../types.ts';
import { loadPrefs, savePrefs } from './prefs.ts';
import { type ComposeMode, missingFrom } from './area-plan.ts';
import { copyText } from './clipboard.ts';
import { createDraftStore } from './drafts.ts';
import { DISABLE_MOUSE, enableMouse } from './mouse.tsx';
import { g } from './glyphs.ts';
import { cycleZone, useConfirmLeave, useLeave, useModal, useShortcuts } from './keymap.tsx';
import { launchStep, useFocusState } from './widgets.tsx';
import { BORDER, PERM_NAME, reducedMotion, setLiveReducedMotion } from './theme.ts';

export type Tab = 'teams' | 'roles' | 'office' | 'terminals' | 'messages' | 'sessions';

/** What the reply popup shows: a pending alert, or a message from the Messages tab. */
export type ReplyTarget = { alert?: Alert; msg?: Msg };

/** Toasts raised outside the app context (the keymap provider sits above it). */
export let toastSink: (s: string) => void = () => {};
/** Whether an edit form is open, and whether it has unsaved changes. */
export type FormState = 'none' | 'open' | 'dirty';

type AppState = {
  roles: Role[];
  depts: Department[];
  reload: () => void;
  hq: HQ | null;
  tab: Tab;
  setTab: (t: Tab) => void;
  launch: (roleIds: string[], lead: string | undefined, mode?: PermMode) => void;
  /** Starts a new session from full Role objects (generated code-area roles); never adds to a running one. */
  /** How the Teams tab composes the next team (kept across tab switches). */
  composeMode: ComposeMode;
  setComposeMode: (m: ComposeMode) => void;
  /**
   * Launches full Role objects (auto-composed teams). With a session open, 'role' teams add
   * only the roles it lacks; 'area' teams are refused (one team mode per session).
   */
  /** Unsent text of the text boxes by key (see useDraft). */
  drafts: DraftStore;
  launchRoles: (team: Role[], lead: string, mode?: PermMode, teamMode?: TeamMode) => number;
  /** Reopens a run; `mode` picks how stopped agents come back (light summary / full transcript). */
  resume: (dir: string, mode?: ResumeMode | 'auto') => Promise<void>;
  detachRun: () => void;
  stopRun: () => void;
  openEditor: (file: string) => void;
  toast: string;
  toastError: boolean;
  setToast: (s: string) => void;
  /** Error toast: stays until the next key press or click. */
  setError: (s: string) => void;
  /** Keyboard launch (l): always asks, always in Auto mode. */
  confirmLaunch: (roleIds: string[], lead?: string) => void;
  reply: ReplyTarget | null;
  openReply: (t: ReplyTarget) => void;
  closeReply: () => void;
  reduced: boolean; // reduced motion (ORQ_REDUCED_MOTION, toggled live with "m")
  toggleMotion: () => void;
  form: FormState;
  /** Edit forms report their state; `save` lets the "unsaved changes" dialog save them. */
  setForm: (f: FormState, save?: () => void) => void;
  saveForm: () => void;
  expandMsg: string | null;
  showMessage: (id: string) => void;
  perm: PermMode;
  setPerm: (v: PermMode) => void;
  /** Cost profile of the next launch (remembered in ~/.orq/ui.json; default Máximo). */
  profile: CostProfile;
  /** Provider forced on every agent of the next launch ('' = each role's own; remembered in ~/.orq/ui.json). */
  provider: string;
  setProvider: (p: string) => void;
  setProfile: (p: CostProfile) => void;
  selection: Set<string>; // loose roles picked in the Roles tab
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  unreadMsgs: number; // messages since the Messages tab was last open
  openAgent: { id: string; tab: 'history' | 'claude' } | null; // request to open an agent panel in the office
  showAgent: (id: string, tab?: 'history' | 'claude') => void;
  clearOpenAgent: () => void;
};

/** Draft text by key; survives tab switches, modals and unmounts; persisted per run. */
export type DraftStore = { get: (key: string) => string; set: (key: string, value: string) => void; /** Changes when the run's drafts are (un)loaded. */ version: number };

const Ctx = createContext<AppState>(null as any);
export const useApp = () => useContext(Ctx);

let redrawHook: () => void = () => {};
export const setRedrawHook = (fn: () => void) => (redrawHook = fn);

export function AppProvider({
  children,
  initialTab = 'teams',
  resumeDir,
  initialHq = null,
}: {
  children: React.ReactNode;
  initialTab?: Tab;
  resumeDir?: string;
  /** Test seam: start with an already built HQ (layout harnesses without claude). */
  initialHq?: HQ | null;
}) {
  const [roles, setRoles] = useState(loadRoles);
  const [depts, setDepts] = useState(loadDepartments);
  const [hq, setHq] = useState<HQ | null>(initialHq);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [toast, setToastText] = useState('');
  const [toastError, setToastError] = useState(false);
  const setToast = (s: string) => (setToastError(false), setToastText(s));
  const setError = (s: string) => (setToastError(true), setToastText(s));
  const modal = useModal();
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  // Keyboard launch (l): the permission mode chosen in the selector; risky modes read in
  // DANGER and the focus starts on Cancelar (the modal's default).
  const confirmLaunch = (ids: string[], lead?: string) => {
    if (!ids.length) return setError('Selecciona al menos un rol');
    const spec = launchConfirm(ids.length, hq ? null : perm, hq?.cwd ?? PROJECT_DIR);
    modal.open({
      title: spec.title,
      lines: spec.lines,
      actions: [{ label: spec.action, run: () => launch(ids, lead, perm), variant: spec.variant }],
      footer: 'confirm.launch',
    });
  };
  const [reduced, setReduced] = useState(reducedMotion);
  setLiveReducedMotion(reduced);
  const [form, setFormState] = useState<FormState>('none');
  const formSave = React.useRef<(() => void) | undefined>(undefined);
  const setForm = (f: FormState, save?: () => void) => {
    formSave.current = f === 'none' ? undefined : save;
    if (f !== form) setFormState(f);
  };
  toastSink = setToast;
  const [seenMsgs, setSeenMsgs] = useState(0);
  const [openAgent, setOpenAgent] = useState<AppState['openAgent']>(null);
  const showAgent = (id: string, t: 'history' | 'claude' = 'history') => {
    setOpenAgent({ id, tab: t });
    setTab('office');
  };
  const [expandMsg, setExpandMsg] = useState<string | null>(null);
  const showMessage = (id: string) => {
    setExpandMsg(id);
    setTab('messages');
  };
  const [perm, setPerm] = useState<PermMode>('auto');
  const [profile, setProfileState] = useState<CostProfile>(() => loadPrefs().profile ?? 'max');
  const setProfile = (p: CostProfile) => (setProfileState(p), savePrefs({ profile: p }));
  const [provider, setProviderState] = useState<string>(() => loadPrefs().provider ?? '');
  const setProvider = (p: string) => (setProviderState(p), savePrefs({ provider: p }));
  const [composeMode, setComposeMode] = useState<ComposeMode>('dept');
  // Drafts live outside React state (typing must not re-render the whole app). The run's
  // drafts.json is attached synchronously while rendering, so boxes mounted with the new
  // hq already see its drafts; `version` makes mounted boxes re-read theirs.
  const store = React.useRef(createDraftStore()).current;
  const runDir = hq?.store?.dir;
  if (runDir) store.attach(runDir);
  else store.detach();
  const drafts: DraftStore = { get: store.get, set: store.set, version: store.version };
  useEffect(() => () => store.detach(), []);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const toggleSelection = (id: string) => {
    const next = new Set(selection);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelection(next);
  };
  const clearSelection = () => setSelection(new Set());
  const [, setVersion] = useState(0);
  const { setRawMode, stdin } = useStdin();

  // Error toasts are dismissed by the next click (keys are handled by the shell).
  useEffect(() => {
    if (!toastError || !toast) return;
    const on = (d: Buffer | string) => /\x1b\[<\d+;\d+;\d+M/.test(String(d)) && setToastText('');
    stdin.on('data', on);
    return () => void stdin.off('data', on);
  }, [toastError, toast, stdin]);

  useEffect(() => {
    if (!hq) return;
    const on = () => setVersion(hq.version);
    hq.on('change', on);
    return () => void hq.off('change', on);
  }, [hq]);

  useEffect(() => {
    // `orq --resume`: live agents reattach as they are; stopped ones come back the way
    // the user chose last time in the resume dialog (light by default).
    if (resumeDir) void resume(resumeDir, recommendedMode(resumeDir));
  }, []);

  const msgCount = hq?.messages.length ?? 0;
  // Messages restored from a resumed or reattached session count as read.
  useEffect(() => setSeenMsgs(hq?.messages.length ?? 0), [hq]);
  useEffect(() => {
    if (tab === 'messages' || msgCount < seenMsgs) setSeenMsgs(msgCount);
  }, [tab, msgCount]);

  useEffect(() => {
    if (!toast || toastError) return;
    const t = setTimeout(() => setToastText(''), 4000);
    return () => clearTimeout(t);
  }, [toast, toastError]);

  const reload = () => {
    setRoles(loadRoles());
    setDepts(loadDepartments());
  };

  const teamFor = (lead: string | undefined, ids: string[]) => teamOf(depts, lead, ids);

  const launch = (roleIds: string[], lead: string | undefined, mode?: PermMode) => {
    const picked = roleIds.map((id) => roles.find((r) => r.id === id)).filter(Boolean) as Role[];
    if (!picked.length) return setError('Selecciona al menos un rol');
    const issue = launchIssue(picked, hq?.provider ?? provider);
    if (issue) return setError(issue);
    if (hq) {
      for (const r of picked) hq.hire(r);
      setToast(picked.length === 1 ? '1 agente añadido a la sesión' : `${picked.length} agentes añadidos a la sesión`);
    } else {
      const ordered = lead ? [...picked.filter((r) => r.id === lead), ...picked.filter((r) => r.id !== lead)] : picked;
      const next = new HQ({ roles: ordered, lead, permMode: mode ?? perm, profile, provider: provider || undefined, ...teamFor(lead, roleIds) });
      next.start();
      setHq(next);
    }
    setTab('office');
  };

  const launchRoles = (team: Role[], lead: string, mode?: PermMode, teamMode: TeamMode = 'area') => {
    if (!team.length) return (setError('No hay agentes que lanzar'), 0);
    const issue = launchIssue(team, hq?.provider ?? provider);
    if (issue) return (setError(issue), 0);
    if (hq) {
      if (teamMode === 'area') return (setError('Detén la sesión para componer por partes'), 0);
      const add = missingFrom(team, hq.agents.keys());
      for (const r of add) hq.hire(r);
      setTab('office');
      return add.length;
    }
    const ordered = [...team.filter((r) => r.id === lead), ...team.filter((r) => r.id !== lead)];
    const next = new HQ({ roles: ordered, lead, permMode: mode ?? perm, mode: teamMode, profile, provider: provider || undefined, ...teamFor(lead, team.map((r) => r.id)) });
    next.start();
    setHq(next);
    setTab('office');
    return ordered.length;
  };

  const resume = async (dir: string, mode?: ResumeMode | 'auto') => {
    if (hq) return setError('Detén o desconecta la sesión actual antes de reanudar otra.');
    let meta: ReturnType<typeof loadRun>;
    try {
      meta = loadRun(dir);
    } catch (e) {
      return setError(`No pude leer la sesión: ${(e as Error).message}`);
    }
    if (await runIsServed(meta.runId)) return setError('Esa sesión ya está abierta en otra ventana de orq.');
    const next = new HQ({ roles: [], permMode: meta.permMode ?? perm, resume: meta, resumeMode: mode });
    next.start();
    setHq(next);
    setTab('office');
    if (mode) setToast(`Sesión reanudada (${mode === 'light' ? 'ligera' : 'completa'}): ${nAgents(meta.agents.length)}`);
  };

  const detachRun = () => {
    hq?.detach();
    setHq(null);
    setTab('sessions');
  };

  const stopRun = () => {
    hq?.stop();
    setHq(null);
    setTab('teams');
  };

  const openEditor = (file: string) => {
    const editor = (process.env.VISUAL || process.env.EDITOR || 'nano').split(' ');
    process.stdout.write(DISABLE_MOUSE + '\x1b[?1049l');
    setRawMode(false);
    Bun.spawnSync([...editor, file], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    setRawMode(true);
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
    enableMouse();
    reload();
    redrawHook();
  };

  return (
    <Ctx.Provider value={{ roles, depts, reload, hq, tab, setTab, launch, launchRoles, drafts, composeMode, setComposeMode, resume, detachRun, stopRun, openEditor, toast, setToast, expandMsg, showMessage, perm, setPerm, profile, setProfile, provider, setProvider, selection, toggleSelection, clearSelection, toastError, setError, confirmLaunch, reply, openReply: setReply, closeReply: () => setReply(null), reduced, toggleMotion: () => (setLiveReducedMotion(!reduced), setReduced(!reduced)), form, setForm, saveForm: () => formSave.current?.(), unreadMsgs: Math.max(0, msgCount - seenMsgs), openAgent, showAgent, clearOpenAgent: () => setOpenAgent(null) }}>
      {children}
    </Ctx.Provider>
  );
}

/** At or above this width tabs show grid + side panel; below it the detail opens full screen. */
export const WIDE_COLS = 140;
/** Below this width grids collapse to a single column (one card per row). */
export const NARROW_COLS = 100;
/** Below this height grids should use compact cards (cards get a `compact` variant in phase 2). */
export const SHORT_ROWS = 30;

/** Single place where the grid/detail layout mode is chosen from the terminal size. */
export function gridLayout(cols: number, rows: number) {
  return {
    side: cols >= WIDE_COLS, // detail panel beside the grid; otherwise full screen
    oneCol: cols < NARROW_COLS, // one full-width compact card per row (list)
    // Lists stay light: sprites live in the detail panel and the Oficina, not on every card.
    compactCards: true,
    compactTabs: rows < SHORT_ROWS, // one-row ChromeTabs
  };
}

/** One-column vertical rule that separates a grid from its (borderless) detail panel. */
export function VSep({ height }: { height: number }) {
  return (
    <Box flexDirection="column" width={1} height={height} flexShrink={0} marginX={0}>
      {Array.from({ length: height }, (_, i) => (
        <Text key={i} color={BORDER}>
          {g.vLine}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Reports an edit form to the shell while mounted: 'open', or 'dirty' with unsaved
 * changes (so tab switches and quitting ask first, and single-key shortcuts are off).
 */
export function useFormState(dirty: boolean, save: () => boolean | void, name: string) {
  const { setForm } = useApp();
  useConfirmLeave(dirty, { name, onSave: save });
  useEffect(() => setForm(dirty ? 'dirty' : 'open', save));
  useEffect(() => () => setForm('none'), []);
}

/**
 * Keyboard for an edit form: Tab/⇧Tab walk the text fields, Ctrl+S saves (also while
 * typing), Esc cancels (asking first when there are unsaved changes).
 */
export function useFormKeys(fields: string[], save: () => unknown, cancel: () => void, active = true) {
  const { focused, setFocused } = useFocusState();
  const leave = useLeave();
  const step = (dir: 1 | -1) => setFocused(cycleZone(fields, focused ?? '', dir));
  useShortcuts(
    'form',
    [
      { keys: ['tab'], run: () => step(1), modes: ['nav', 'text'] },
      { keys: ['shift+tab'], run: () => step(-1), modes: ['nav', 'text'] },
      { keys: ['ctrl+s'], run: () => void save(), modes: ['nav', 'text'] },
      { keys: ['esc'], run: () => leave(cancel) },
    ],
    { active, footer: 'form' },
  );
  useShortcuts('form/field', [], { active: active && !!focused && fields.includes(focused), footer: 'form.field' });
}

export { type Alert, alertsOf } from '../session.ts';
export const isPermission = (a: Alert) => a.kind === 'trust' || a.kind === 'bypass' || a.kind === 'blocked';

/** "1 agente" / "3 agentes". */
export const nAgents = (n: number) => `${n} agente${n === 1 ? '' : 's'}`;

/** "hace 3 min" style relative time. */
export function ago(ts: number | undefined, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}


// One shared terminal-size store. On resize Ink first repaints the old (wider) frame at the
// new width; real terminals re-wrap those long lines and Ink's relative erase then leaves
// them behind (huge tabs at the top). So after every resize the whole screen is wiped and
// Ink's frame state reset before the new layout renders.
type Size = { cols: number; rows: number };
const sizeSubs = new Set<(s: Size) => void>();
let sizeNow: Size | null = null;
let sizeOut: NodeJS.WriteStream | null = null;
const onResize = () => {
  if (!sizeOut) return;
  sizeNow = { cols: sizeOut.columns, rows: sizeOut.rows };
  sizeOut.write('\x1b[2J\x1b[H');
  redrawHook();
  for (const fn of sizeSubs) fn(sizeNow);
};

export function useSize() {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  if (sizeOut !== stdout) {
    sizeOut?.off('resize', onResize);
    sizeOut = stdout;
    sizeNow = { cols: stdout.columns ?? 120, rows: stdout.rows ?? 40 };
    stdout.on('resize', onResize);
  }
  const [size, setSize] = useState<Size>(sizeNow!);
  useEffect(() => {
    sizeSubs.add(setSize);
    // A resize may have happened between render and subscription.
    if (sizeNow && (sizeNow.cols !== size.cols || sizeNow.rows !== size.rows)) setSize(sizeNow);
    return () => void sizeSubs.delete(setSize);
  }, []);
  return size;
}

/** 10 Hz animation clock; frozen at 0 with reduced motion. */
export function useTick(active = true) {
  const { reduced } = useApp();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active || reduced) return setTick(0);
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [active, reduced]);
  return reduced ? 0 : tick;
}

export function wrap(text: string, width: number, maxLines = Infinity): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if ((line + word).length > width) {
        if (line.trim()) out.push(line.trimEnd());
        line = word.trimStart();
        while (line.length > width) {
          out.push(line.slice(0, width));
          line = line.slice(width);
        }
      } else line += word;
    }
    out.push(line.trimEnd());
    if (out.length >= maxLines) break;
  }
  if (out.length > maxLines) {
    out.length = maxLines;
    out[maxLines - 1] = out[maxLines - 1]!.slice(0, width - 1) + '…';
  }
  return out;
}

/**
 * Text of a box kept as a draft under `key`: it survives tab switches, modals, Esc and
 * unmounts, and comes back when the key comes back (e.g. the composer's recipient).
 * `recovered` is true while a draft restored on mount (or on a key change) is untouched.
 * Clear it with `set('')` after sending (Ctrl+U in the box empties it too).
 */
export function useDraft(key: string): { value: string; set: (v: string) => void; recovered: boolean } {
  const { drafts } = useApp();
  const fresh = () => {
    const value = drafts.get(key);
    return { key, version: drafts.version, value, recovered: !!value };
  };
  const [state, setState] = useState(fresh);
  // Another key (recipient) or the run's drafts were (un)loaded: show what the store has.
  const stale = state.key !== key || state.version !== drafts.version;
  if (stale) setState(fresh());
  const set = (v: string) => {
    drafts.set(key, v);
    setState({ key, version: drafts.version, value: v, recovered: false });
  };
  const cur = stale ? fresh() : state;
  return { value: cur.value, set, recovered: cur.recovered && !!cur.value };
}

/** Note shown in a box holding a recovered draft. */
export const DRAFT_NOTE = 'Borrador recuperado · Alt+D descartar';

/** Copies text to the clipboard (OSC 52 / pbcopy) and says so in a toast. */
export function useCopy() {
  const { setToast, setError } = useApp();
  return (text: string) => {
    if (!text.trim()) return setToast('Nada que copiar');
    if (copyText(text)) setToast('Copiado al portapapeles');
    else setError('No pude copiar: tu terminal no admite el portapapeles');
  };
}

/**
 * Text of the keyboard-launch confirmation. `perm` null = adding to the open session.
 * Risky modes (Auto + YOLO opcional, YOLO) say so in the title and use a danger button.
 */
export function launchConfirm(n: number, perm: PermMode | null, dir: string) {
  // The same question and consequences as the confirmation step of <LaunchButtons>.
  const step = launchStep({ count: n, mode: perm ?? 'auto', running: !perm });
  if (!perm) return { title: step.question, lines: [`Directorio: ${dir}`, ...step.consequences], action: step.action, variant: 'primary' as const };
  return {
    title: step.danger ? step.question : `¿Lanzar ${nAgents(n)} en modo ${PERM_NAME[perm]}?`,
    lines: [`Directorio: ${dir}`, ...step.consequences],
    action: step.action,
    variant: step.danger ? ('danger' as const) : ('primary' as const),
  };
}

/**
 * Mode for `orq --resume` (no dialog): decided per agent ('auto': full where its prompt cache is
 * still warm, light where it went cold); the last choice, then light, if the run cannot be read.
 */
export function recommendedMode(dir: string): ResumeMode | 'auto' {
  try {
    loadRun(dir);
    return 'auto';
  } catch {
    return loadPrefs().resumeMode ?? 'light';
  }
}
