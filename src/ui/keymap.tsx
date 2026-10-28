import { Box, Text, type Key, useInput, useIsScreenReaderEnabled, usePaste } from 'ink';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { profileHelp } from './cost.ts';
import { border, g } from './glyphs.ts';
import { DANGER, MUTED, PRIMARY, SURFACE, TEXT, WARN } from './theme.ts';
import { Clickable } from './mouse.tsx';
import { Button, type ButtonVariant, FocusContext, Scrollbar, useFocusState } from './widgets.tsx';

export { useFocusState };

// One central useInput dispatches keys by layer: MODAL > TERMINAL > TEXTO > NAVEGAR.
// Screens register shortcuts per scope (tab/zone) with useShortcuts(); the topmost
// active scope also picks the footer. The help overlay and footer copy live here too,
// so this file is the single source of truth for key labels.

// ------------------------------------------------------------------ modes

export type Mode = 'nav' | 'text' | 'terminal' | 'modal';
export const MODE_BADGE: Record<Mode, string> = { nav: '[NAVEGAR]', text: '[TEXTO]', terminal: '[TERMINAL]', modal: '[CONFIRMAR]' };
/** FocusProvider id that means "keys go to the agent's terminal". */
export const TERMINAL_FOCUS = 'tmux';

/** ORQ_SINGLE_KEY=0 moves one-key shortcuts to Alt+key. */
export const singleKeyEnabled = (env: Record<string, string | undefined> = process.env) => env.ORQ_SINGLE_KEY !== '0';

// ------------------------------------------------------------------- keys

const NAV_KEYS = new Set(['up', 'down', 'left', 'right', 'tab', 'shift+tab', 'pageup', 'pagedown', 'home', 'end']);
/** Letters that can never be modal access keys (movement and launch). */
export const RESERVED_ACCESS = new Set(['j', 'k', 'l']);

/**
 * Characters macOS terminals send for Option+letter when Option is not set as Meta
 * (Terminal.app, VS Code and iTerm2 defaults), mapped to the Alt shortcut they stand for.
 */
const MAC_OPTION: Record<string, string> = { 'ß': 's', 'å': 'a', '®': 'r' };

/**
 * Names a key press answers to, most specific first: "up", "enter", "esc", "space",
 * "delete", "ctrl+s", "alt+1", "shift+tab", or the character itself (letters lowercased,
 * so Caps Lock does not matter). j/k also answer to down/up. With `singleKey` off,
 * printable characters only count when pressed with Alt.
 */
export function keyNames(input: string, key: Partial<Key>, singleKey = true): string[] {
  const out: string[] = [];
  if (key.upArrow) out.push('up');
  if (key.downArrow) out.push('down');
  if (key.leftArrow) out.push('left');
  if (key.rightArrow) out.push('right');
  if (key.pageUp) out.push('pageup');
  if (key.pageDown) out.push('pagedown');
  if (key.home) out.push('home');
  if (key.end) out.push('end');
  if (key.return) out.push(key.meta ? 'alt+enter' : 'enter');
  if (key.escape) out.push('esc');
  if (key.tab) out.push(key.shift ? 'shift+tab' : 'tab');
  if (key.backspace || key.delete) out.push('delete', 'backspace');
  if (out.length) return out;
  if (!input) return out;
  const ch = input.length === 1 ? input.toLowerCase() : input;
  if (key.ctrl) return input.length === 1 ? [`ctrl+${ch}`] : [];
  if (input === ' ') return ['space'];
  if (input.length !== 1) return [];
  if (MAC_OPTION[input]) return [`alt+${MAC_OPTION[input]}`, input];
  if (key.meta) return [`alt+${ch}`, ch, ...(ch === 'j' ? ['down'] : ch === 'k' ? ['up'] : [])];
  if (!singleKey) return [];
  return [ch, ...(ch === 'j' ? ['down'] : ch === 'k' ? ['up'] : [])];
}

/** Access letter of a label written as "[B]orrar", lowercased. */
export const accessKey = (label: string) => /\[(.)\]/.exec(label)?.[1]?.toLowerCase();

// ------------------------------------------------------------- shortcuts

export type Shortcut = {
  /** Key names (see keyNames): 'l', 'enter', 'delete', 'ctrl+s', '['… */
  keys: string[];
  run: () => void;
  /** Disabled when false. */
  when?: boolean;
  /** Layers where it fires; default ['nav']. Add 'text' for Ctrl+Q, Alt+1..6… */
  modes?: Mode[];
};

export type FooterContext = keyof typeof FOOTER;
type ScopeOpts = {
  /** Scope on/off (e.g. off while a form is being edited). `when` is an alias. */
  active?: boolean;
  when?: boolean;
  footer?: FooterContext;
  vars?: Record<string, string | number>;
};
type LeaveGuard = { id: number; dirty: React.RefObject<boolean>; opts: React.RefObject<LeaveOpts> };
export type LeaveOpts = {
  /** Shown as «name» in "Hay cambios sin guardar en «name»." */
  name: string;
  /** Return false to stay (e.g. validation failed). */
  onSave?: () => boolean | void;
  onDiscard?: () => void;
};
type Scope = { id: number; name: string; shortcuts: React.RefObject<Shortcut[]>; opts: ScopeOpts };

// ------------------------------------------------------------------ modal

export type ModalAction = { label: string; run: () => void; variant?: ButtonVariant; disabled?: boolean };
export type ModalSpec = {
  title: string;
  lines?: string[];
  /** Verbs, e.g. "[B]orrar «Diseño»". A "[x]" letter presses it; launch/add go without one. */
  actions: ModalAction[];
  onCancel?: () => void;
  cancelLabel?: string;
  /** Footer: 'confirm' (access letters) or 'confirm.launch' (no letters). */
  footer?: 'confirm' | 'confirm.launch';
  /** Box width cap (default 72), e.g. wider to read long texts. */
  maxWidth?: number;
};
/** Input is ignored this long after a modal opens (held keys, double clicks). */
export const MODAL_GUARD_MS = 300;

/** A mounted <Modal>: the topmost one gets the keys. */
type ModalLayer = { id: number; handle: React.RefObject<(names: string[]) => void>; footer: FooterContext };

// ---------------------------------------------------------------- context

type Ctx = {
  mode: Mode;
  singleKey: boolean;
  exitLabel: string;
  /** Keyboard cursor shown? Latent until the first navigation key. */
  cursorVisible: boolean;
  revealCursor: () => void;
  hideCursor: () => void;
  nav: (tab: string) => NavState;
  setNav: (tab: string, nav: NavState) => void;
  register: (s: Scope) => () => void;
  /** Where a bracketed paste outside a text field goes (e.g. a type-to-filter list); null = dropped. */
  pasteSink: React.MutableRefObject<((text: string) => void) | null>;
  scopes: () => Scope[];
  version: number;
  /** Imperative modal opened with useModal().open(), rendered by <Overlays>. */
  spec: ModalSpec | null;
  openModal: (m: ModalSpec) => void;
  closeModal: (cancelled?: boolean) => void;
  addLayer: (l: ModalLayer) => () => void;
  topLayer: () => ModalLayer | undefined;
  /** Last key name dispatched (a modal ignores it as an access key). */
  lastKey: () => string;
  help: boolean;
  setHelp: (v: boolean) => void;
  helpScroll: number;
  setHelpScroll: (n: number) => void;
  setInteract: (on: boolean) => void;
  addLeaveGuard: (g: LeaveGuard) => () => void;
  requestLeave: (then: () => void) => void;
};
export type NavState = { zone: string; index: number };

const K = createContext<Ctx | null>(null);
const useK = () => {
  const c = useContext(K);
  if (!c) throw new Error('KeymapProvider missing');
  return c;
};

let scopeSeq = 0;

type ProviderProps = {
  children: React.ReactNode;
  /** Short notices, e.g. a paste ignored outside a text field. */
  onToast?: (text: string) => void;
  /** Label of ORQ_TERMINAL_EXIT for the footer and help ("Ctrl+]"). */
  exitLabel?: string;
};

/**
 * Central keyboard handling. Mount once at the root, in place of <FocusProvider>
 * (it includes it; useFocusState() keeps working). Inside an existing FocusProvider
 * it reuses that one.
 */
export function KeymapProvider(props: ProviderProps) {
  const outer = useFocusState();
  const [focused, setFocusedState] = useState<string | null>(null);
  // A ref too, so keys in the same chunk as "/" already see the text layer.
  const focusedRef = useRef<string | null>(null);
  const value = useMemo(
    () => ({ focused, setFocused: (id: string | null) => ((focusedRef.current = id), setFocusedState(id)), provided: true }),
    [focused],
  );
  if (outer.provided) return <KeymapCore {...props} focusedRef={null} />;
  return (
    <FocusContext.Provider value={value}>
      <KeymapCore {...props} focusedRef={focusedRef} />
    </FocusContext.Provider>
  );
}

function KeymapCore({ children, onToast, exitLabel = 'Ctrl+]', focusedRef }: ProviderProps & { focusedRef: React.RefObject<string | null> | null }) {
  const { focused } = useFocusState();
  const screenReader = useIsScreenReaderEnabled() || process.env.INK_SCREEN_READER === 'true';
  const singleKey = useMemo(() => singleKeyEnabled(), []);
  const scopes = useRef(new Map<number, Scope>());
  const navs = useRef(new Map<string, NavState>());
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [cursorShown, setCursorShown] = useState(false);
  const [spec, setSpecState] = useState<ModalSpec | null>(null);
  const specRef = useRef<ModalSpec | null>(null);
  const setSpec = (m: ModalSpec | null) => ((specRef.current = m), setSpecState(m));
  const layers = useRef(new Map<number, ModalLayer>());
  const [interact, setInteract] = useState(false);
  const guards = useRef(new Map<number, LeaveGuard>());
  // Refs mirror state so several keys arriving in one chunk see each other's effect.
  const scrollRef = useRef(0);
  const lastKey = useRef('');
  const [help, setHelpState] = useState(false);
  const helpRef = useRef(false);
  const setHelp = (v: boolean) => ((helpRef.current = v), setHelpState(v));
  const [helpScroll, setHelpScrollState] = useState(0);
  const setHelpScroll = (n: number) => ((scrollRef.current = Math.max(0, n)), setHelpScrollState(Math.max(0, n)));

  const modalOpen = () => helpRef.current || !!specRef.current || layers.current.size > 0;
  // A text field inside a modal is the text layer; the modal gets keys again once it lets go.
  const layerOf = (f: string | null): Mode =>
    modalOpen() ? (f && !helpRef.current ? 'text' : 'modal') : interact || f === TERMINAL_FOCUS ? 'terminal' : f ? 'text' : 'nav';
  const mode: Mode = layerOf(focused);
  const cursorVisible = screenReader || cursorShown;

  const ordered = () => [...scopes.current.values()].filter((s) => s.opts.active !== false && s.opts.when !== false).sort((a, b) => b.id - a.id);
  const closeModal = (cancelled = false) => {
    const m = specRef.current;
    setSpec(null);
    if (cancelled) m?.onCancel?.();
  };
  const topLayer = () => [...layers.current.values()].sort((a, b) => b.id - a.id)[0];

  useInput((input, key) => {
    const names = keyNames(input, key, singleKey);
    if (!names.length) return;
    lastKey.current = names.find((n) => n.length === 1) ?? names[0]!;

    // Refs, not state: several keys can arrive in one chunk (e.g. "l" + Enter).
    const f = focusedRef ? focusedRef.current : focused;
    if (helpRef.current) {
      if (names.includes('esc') || names.includes('?')) return setHelp(false);
      const s = scrollRef.current;
      if (names.includes('up')) return setHelpScroll(s - 1);
      if (names.includes('down')) return setHelpScroll(s + 1);
      if (names.includes('pageup')) return setHelpScroll(s - 10);
      if (names.includes('pagedown')) return setHelpScroll(s + 10);
      if (names.includes('home')) return setHelpScroll(0);
      return;
    }
    if (modalOpen()) {
      if (f) return; // a field inside the modal is typing
      // Not mounted yet (opened earlier in this same chunk): swallow, the guard would anyway.
      return topLayer()?.handle.current?.(names);
    }
    const layer = layerOf(f);
    if (layer === 'terminal') return; // every key belongs to tmux; LivePane handles the exit keys

    if (layer === 'nav') {
      if (!cursorVisible && names.some((n) => NAV_KEYS.has(n) || n === 'j' || n === 'k')) return setCursorShown(true);
      if (names.includes('?') && !findShortcut(ordered(), names, layer)) return (setHelpScroll(0), setHelp(true));
    }
    findShortcut(ordered(), names, layer)?.run();
  });

  // Bracketed paste outside a text field is dropped instead of firing shortcuts.
  const pasteSink = useRef<((text: string) => void) | null>(null);
  usePaste((text) => (pasteSink.current ? pasteSink.current(text) : onToast?.('Pegado ignorado · i para escribir')), { isActive: mode === 'nav' || mode === 'modal' });

  const ctx: Ctx = {
    mode,
    singleKey,
    exitLabel,
    cursorVisible,
    revealCursor: () => setCursorShown(true),
    hideCursor: () => setCursorShown(false),
    nav: (tab) => navs.current.get(tab) ?? { zone: '', index: 0 },
    setNav: (tab, n) => {
      const prev = navs.current.get(tab);
      if (prev?.zone === n.zone && prev.index === n.index) return;
      navs.current.set(tab, n);
      bump();
    },
    pasteSink,
    register: (s) => {
      scopes.current.set(s.id, s);
      bump();
      return () => {
        scopes.current.delete(s.id);
        bump();
      };
    },
    scopes: ordered,
    version,
    spec,
    openModal: setSpec,
    closeModal,
    addLayer: (l) => {
      layers.current.set(l.id, l);
      bump();
      return () => {
        layers.current.delete(l.id);
        bump();
      };
    },
    topLayer,
    lastKey: () => lastKey.current,
    help,
    setHelp,
    helpScroll,
    setHelpScroll,
    setInteract,
    addLeaveGuard: (gd) => {
      guards.current.set(gd.id, gd);
      return () => void guards.current.delete(gd.id);
    },
    requestLeave: (then) => {
      const gd = [...guards.current.values()].find((x) => x.dirty.current);
      if (!gd) return then();
      const o = gd.opts.current!;
      setSpec({
        title: 'Cambios sin guardar',
        lines: [`Hay cambios sin guardar en «${o.name}».`],
        actions: [
          { label: '[G]uardar', run: () => o.onSave?.() !== false && then() },
          { label: '[D]escartar', run: () => (o.onDiscard?.(), then()), variant: 'danger' },
        ],
      });
    },
  };
  return <K.Provider value={ctx}>{children}</K.Provider>;
}

function findShortcut(scopes: Scope[], names: string[], layer: Mode): Shortcut | undefined {
  for (const s of scopes)
    for (const sc of s.shortcuts.current ?? [])
      if (sc.when !== false && (sc.modes ?? ['nav']).includes(layer) && sc.keys.some((k) => names.includes(k.toLowerCase()))) return sc;
  return undefined;
}

// ------------------------------------------------------------------ hooks

/**
 * Registers shortcuts for a scope (e.g. "teams/grid") while mounted and `active`.
 * Newer scopes win over older ones. `footer` picks the footer copy shown while this
 * is the topmost scope that declares one; `vars` fill its {placeholders}.
 */
export function useShortcuts(name: string, shortcuts: Shortcut[], opts: ScopeOpts = {}) {
  const k = useK();
  const ref = useRef(shortcuts);
  ref.current = shortcuts;
  const optsKey = JSON.stringify(opts);
  useEffect(() => k.register({ id: ++scopeSeq, name, shortcuts: ref, opts }), [name, optsKey]);
}

/** Current layer: modal > terminal > text > nav. */
export const useMode = () => useK().mode;

/** Per-tab keyboard position, kept across tab switches. */
export function useNav(tab: string) {
  const k = useK();
  return [k.nav(tab), (n: NavState) => k.setNav(tab, n)] as const;
}

/**
 * Latent keyboard cursor: hidden until the first navigation key (which only reveals
 * it), always visible for screen readers. After a click call `hide()` and move the
 * nav position to the clicked element.
 */
export function useKeyboardCursor() {
  const k = useK();
  return { visible: k.cursorVisible, reveal: k.revealCursor, hide: k.hideCursor };
}

/** Opens a confirmation modal; render <Overlays/> once at the root to show it. */
export function useModal() {
  const k = useK();
  return { open: k.openModal, close: () => k.closeModal(true), isOpen: !!k.spec };
}

/**
 * TERMINAL layer while `on` (LivePane interact): the provider stops handling keys.
 * Call with the interact state; it is cleared on unmount.
 */
/** While mounted (and `active`), bracketed pastes outside text fields go to `fn` instead of being dropped. */
export function usePasteSink(fn: (text: string) => void, active = true) {
  const k = useK();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const sink = (t: string) => ref.current(t);
    k.pasteSink.current = sink;
    return () => {
      if (k.pasteSink.current === sink) k.pasteSink.current = null;
    };
  }, [active]);
}

export function useInteract(on: boolean) {
  const k = useK();
  useEffect(() => {
    k.setInteract(on);
    return () => k.setInteract(false);
  }, [on]);
}

let guardSeq = 0;
/**
 * While `dirty`, leaving (q, Ctrl+Q, tab change — anything routed through
 * useLeave()) first asks "Hay cambios sin guardar en «name»" · [G]uardar · [D]escartar · Cancelar.
 */
export function useConfirmLeave(dirty: boolean, opts: LeaveOpts) {
  const k = useK();
  const d = useRef(dirty);
  d.current = dirty;
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => k.addLeaveGuard({ id: ++guardSeq, dirty: d, opts: o }), []);
}

/** `leave(() => setTab(t))` runs now, or after the unsaved-changes modal. */
export const useLeave = () => useK().requestLeave;

export function useHelp() {
  const k = useK();
  return { open: k.help, toggle: () => (k.setHelpScroll(0), k.setHelp(!k.help)), close: () => k.setHelp(false) };
}

/** Next/previous region for Tab / ⇧Tab (wraps around). */
export function cycleZone(zones: string[], current: string, dir: 1 | -1): string {
  if (!zones.length) return current;
  const i = zones.indexOf(current);
  if (i < 0) return dir > 0 ? zones[0]! : zones[zones.length - 1]!;
  return zones[(i + dir + zones.length) % zones.length]!;
}

/** Index after a movement key in a grid of `count` items, `perRow` per row. */
export function moveIndex(index: number, count: number, perRow: number, key: string, pageRows = 1): number {
  if (count <= 0) return 0;
  const last = count - 1;
  const clamp = (n: number) => Math.max(0, Math.min(last, n));
  switch (key) {
    case 'left':
      return clamp(index - 1);
    case 'right':
      return clamp(index + 1);
    case 'up':
      return index - perRow >= 0 ? index - perRow : index;
    case 'down':
      return index + perRow <= last ? index + perRow : index;
    case 'pageup':
      return clamp(index - perRow * pageRows);
    case 'pagedown':
      return clamp(index + perRow * pageRows);
    case 'home':
      return 0;
    case 'end':
      return last;
  }
  return clamp(index);
}

// ----------------------------------------------------------------- footer

type FooterItem = [key: string, label: string];
type FooterDef = { mode: Mode; items: FooterItem[]; tail?: string };

/** Footer copy by context (ux-writer v3). {n} and {exit} are filled at render time. */
export const FOOTER = {
  mouse: { mode: 'nav', items: [['clic y rueda', ''], ['⌥S', 'copiar texto'], ['1-6', 'pestañas'], ['q', 'salir']] },
  'teams.grid': { mode: 'nav', items: [['←↑↓→', 'mover'], ['↵', 'detalle'], ['l', 'lanzar'], ['n', 'nuevo'], ['e', 'editar']] },
  'teams.auto': { mode: 'nav', items: [['↵', 'crear y lanzar'], ['r', 'revisar'], ['a', 'reanalizar'], ['g', 'guardar'], ['p', 'modo']] },
  'teams.auto.loading': { mode: 'nav', items: [['p', 'modo']] },
  'teams.auto.roles': { mode: 'nav', items: [['Espacio', 'incluir'], ['c', 'coordinador'], ['←→', 'rol'], ['n', 'añadir'], ['Esc', 'volver']] },
  'teams.parts': { mode: 'nav', items: [['Espacio', 'incluir'], ['n', 'añadir'], ['e', 'renombrar'], ['b', 'base'], ['Supr', 'quitar'], ['u', 'deshacer']] },
  'teams.parts.detail': { mode: 'nav', items: [['Tab', 'campo'], ['↵', 'añadir ruta'], ['Supr', 'quitar ruta'], ['Esc', 'volver']] },
  'teams.detail': { mode: 'nav', items: [['Espacio', 'incluir'], ['c', 'coordinador'], ['l', 'lanzar'], ['Esc', 'volver']] },
  search: { mode: 'text', items: [['escribe para filtrar', ''], ['↵', 'ir a resultados']] },
  'search.empty': { mode: 'nav', items: [['Sin resultados', ''], ['Esc', 'borrar filtro'], ['/', 'buscar otra vez']] },
  'roles.grid': { mode: 'nav', items: [['←↑↓→', 'mover'], ['Espacio', 'seleccionar'], ['l', 'lanzar'], ['/', 'buscar']] },
  'roles.selection': { mode: 'nav', items: [['Selección {n}', ''], ['l', 'lanzar'], ['x', 'limpiar'], ['Espacio', 'añadir']] },
  form: { mode: 'nav', items: [['Tab/⇧Tab', 'campo'], ['↵', 'activar'], ['Ctrl+S', 'guardar'], ['Esc', 'cancelar']] },
  'form.field': { mode: 'text', items: [['Tab/⇧Tab', 'campo'], ['Ctrl+S', 'guardar']], tail: 'Esc salir del campo' },
  'office.grid': { mode: 'nav', items: [['←↑↓→', 'mover'], ['↵', 'abrir'], ['i', 'escribir tarea'], ['c', 'contratar']] },
  'office.grid.alerts': { mode: 'nav', items: [['←↑↓→', 'mover'], ['↵', 'abrir'], ['i', 'escribir tarea'], ['!', '{n} avisos']] },
  'office.panel': { mode: 'nav', items: [['[ ]', 'pestaña'], ['w', 'escribir'], ['y', 'copiar'], ['Supr', 'despedir'], ['Esc', 'volver']] },
  selection: { mode: 'nav', items: [['Esc', 'salir del modo selección']] },
  'alert.request': { mode: 'nav', items: [['↑↓', 'aviso'], ['v', 'ver y decidir'], ['Esc', 'volver']] },
  'alert.info': { mode: 'nav', items: [['↑↓', 'aviso'], ['v', 'ver'], ['a', 'cerrar'], ['Esc', 'volver']] },
  hire: { mode: 'nav', items: [['←→', 'rol'], ['↵', 'elegir y confirmar'], ['Tab', 'más'], ['Esc', 'cerrar']] },
  'hire.more': { mode: 'modal', items: [['escribe', 'filtrar'], ['↑↓', 'mover'], ['↵', 'elegir · contratar'], ['Esc', 'cerrar']] },
  composer: { mode: 'text', items: [['↵', 'enviar'], ['Alt+↵', 'nueva línea'], ['⇧Tab', 'destinatario'], ['Alt+C', 'copiar']] },
  terminal: { mode: 'terminal', items: [['lo que escribes va al agente', '']] },
  'terminals.grid': { mode: 'nav', items: [['←↑↓→', 'mover'], ['↵', 'ampliar'], ['RePág/AvPág', 'página']] },
  'terminals.zoom': { mode: 'nav', items: [['[ ]', 'Claude/Comandos'], ['w', 'escribir'], ['Esc', 'volver a todas']] },
  messages: { mode: 'nav', items: [['↑↓', 'mover'], ['↵', 'desplegar'], ['Inicio', 'primeros'], ['Fin', 'últimos']] },
  'sessions.stopped': { mode: 'nav', items: [['↵', 'reanudar'], ['t', 'renombrar'], ['Supr', 'quitar'], ['a', 'aquí/todos']] },
  'sessions.live': { mode: 'nav', items: [['↵', 'reconectar'], ['t', 'renombrar'], ['s', 'detener'], ['Supr', 'quitar'], ['a', 'aquí/todos']] },
  'sessions.current': { mode: 'nav', items: [['↵', 'ir a la oficina'], ['t', 'renombrar'], ['a', 'aquí/todos']] },
  'office.empty': { mode: 'nav', items: [['↑↓', 'mover'], ['↵', 'ir a Equipos']] },
  confirm: { mode: 'modal', items: [['letra entre [ ]', ''], ['←→ ↵', 'elegir']] },
  'reply.pick': { mode: 'modal', items: [['↑↓ 1-4', 'elegir'], ['rueda RePág', 'leer'], ['↵', 'enviar'], ['i', 'comentar'], ['Esc', 'cerrar']] },
  'confirm.launch': { mode: 'modal', items: [['←→', 'elegir'], ['↵', 'pulsar']] },
} satisfies Record<string, FooterDef>;

const TAIL: Record<Mode, string> = { nav: '? ayuda', text: 'Esc salir', terminal: '{exit} salir', modal: 'Esc cancelar' };
export const FOOTER_MAX = 78;

export type FooterPart = { text: string; kind: 'badge' | 'warn' | 'key' | 'label' | 'sep' | 'plain' };

/**
 * Footer as styled parts: "[MODO] ⚠ N permisos pendientes · key label · … · tail".
 * Items are dropped from the right until it fits in min(width, 78); the badge, the
 * permissions warning and the tail are never dropped. With `singleKey` off, one-key
 * shortcuts show as Alt+key.
 */
export function footerParts(
  ctx: FooterContext | null,
  mode: Mode,
  opts: { width: number; vars?: Record<string, string | number>; permissions?: number; toast?: string; singleKey?: boolean; exitLabel?: string },
): FooterPart[] {
  const max = Math.min(opts.width, FOOTER_MAX);
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, v: string) => String(v === 'exit' ? opts.exitLabel ?? 'Ctrl+]' : opts.vars?.[v] ?? ''));
  const alt = (k: string) => (opts.singleKey === false && [...k].length === 1 ? `Alt+${k}` : k);
  const def: FooterDef | undefined = ctx ? FOOTER[ctx] : undefined;
  const sep: FooterPart = { text: ` ${g.sep} `, kind: 'sep' };
  const space: FooterPart = { text: ' ', kind: 'plain' };

  const head: FooterPart[] = [{ text: MODE_BADGE[mode], kind: 'badge' }];
  if (opts.permissions) {
    const n = opts.permissions;
    head.push(space, { text: `${g.warning} ${n} ${n === 1 ? 'permiso pendiente' : 'permisos pendientes'}`, kind: 'warn' });
  }
  if (opts.toast) return [...head, space, { text: opts.toast, kind: 'plain' }];

  const tailText = fill(def?.mode === mode && def.tail ? def.tail : TAIL[mode]);
  const cut = tailText.indexOf(' ');
  const tail: FooterPart[] = [
    { text: alt(tailText.slice(0, cut)), kind: 'key' },
    { text: tailText.slice(cut), kind: 'label' },
  ];
  const items = def && def.mode === mode ? def.items.map(([k, l]) => [fill(alt(k)), fill(l)] as const) : [];
  const item = ([k, l]: readonly [string, string]): FooterPart[] => (l ? [{ text: k, kind: 'key' }, { text: ` ${l}`, kind: 'label' }] : [{ text: k, kind: 'plain' }]);
  const len = (ps: FooterPart[]) => ps.reduce((a, p) => a + [...p.text].length, 0);
  // Drop items from the right until it fits; head and tail always stay.
  for (let n = items.length; ; n--) {
    const body = items.slice(0, n).flatMap((it, i) => [...(i ? [sep] : []), ...item(it)]);
    const out = [...head, head.length > 1 ? sep : space, ...body, ...(body.length ? [sep] : []), ...tail];
    if (n === 0 || len(out) <= max) return out;
  }
}

export const footerText = (parts: FooterPart[]) => parts.map((p) => p.text).join('');

/**
 * Footer line: mode badge (always, also over a toast), the topmost scope's footer
 * copy (or `context`), and the fixed tail. While the cursor is latent in NAVEGAR it
 * shows the mouse footer.
 */
export function FooterHints({ width, context, vars, permissions, toast }: { width: number; context?: FooterContext; vars?: Record<string, string | number>; permissions?: number; toast?: string }) {
  const k = useK();
  const mode = k.mode;
  const top = k.scopes().find((s) => s.opts.footer && FOOTER[s.opts.footer].mode === mode);
  let ctx: FooterContext | null = context ?? top?.opts.footer ?? null;
  const layer = k.topLayer();
  if (layer && mode === 'modal' && !context) ctx = layer.footer;
  if (mode === 'terminal' && !context) ctx = 'terminal';
  if (mode === 'nav' && !k.cursorVisible && !context) ctx = 'mouse';
  const parts = footerParts(ctx, mode, { width, vars: vars ?? top?.opts.vars, permissions, toast, singleKey: k.singleKey, exitLabel: k.exitLabel });
  const style = (p: FooterPart) =>
    p.kind === 'badge' ? { inverse: true, bold: true } : p.kind === 'warn' ? { color: WARN, bold: true } : p.kind === 'key' ? { color: PRIMARY, bold: true } : p.kind === 'label' ? { color: TEXT } : { color: MUTED };
  return (
    <Box width={width} height={1} flexShrink={0} overflow="hidden">
      <Text wrap="truncate">
        {parts.map((p, i) => (
          <Text key={i} {...style(p)}>
            {p.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

// ------------------------------------------------------------------- help

type HelpSection = { title: string; tab?: string; rows: [string, string][]; note?: string };

/** Overlay copy (ux-writer v3 + design-lead delta: no g/G, launch without letter). */
export const HELP: HelpSection[] = [
  {
    title: 'Global',
    rows: [
      ['1-6', 'Ir a una pestaña (Equipos … Sesiones)'],
      ['Alt+1…6', 'Ir a una pestaña, también escribiendo ¹'],
      ['Tab / ⇧Tab', 'Siguiente / anterior elemento, en orden visual'],
      ['←↑↓→ · j/k', 'Mover'],
      ['Inicio/Fin', 'Primero / último'],
      ['RePág/AvPág', 'Página anterior / siguiente'],
      ['↵', 'Abrir o activar'],
      ['Esc', 'Volver un nivel (nunca sale de orq)'],
      ['!', 'Ir al aviso más antiguo'],
      ['Alt+A · Alt+R', 'Abrir el aviso más antiguo con aceptar / rechazar ya elegido (confirma con ↵)'],
      ['?', 'Abrir o cerrar esta ayuda'],
      ['q · Ctrl+C', 'Salir (pregunta si hay una sesión abierta)'],
      ['Ctrl+Q', 'Salir, también escribiendo'],
    ],
    note: '¹ En macOS, activa «Usar Opción como Meta» en el terminal.',
  },
  {
    title: 'Modos (insignia del pie)',
    rows: [
      ['[NAVEGAR]', 'Las teclas son atajos.'],
      ['[TEXTO]', 'Escribes en un campo. Esc para salir.'],
      ['[TERMINAL]', 'Escribes en la terminal del agente. {exit} para salir.'],
      ['[CONFIRMAR]', 'Pulsa la letra entre [ ]. Esc cancela.'],
    ],
  },
  {
    title: 'Escribir',
    rows: [
      ['⌥⌫ · Ctrl+W', 'Borrar la palabra anterior'],
      ['Ctrl+U', 'Borrar hasta el inicio de la línea'],
      ['Alt+D', 'Descartar el borrador entero (compositor y respuestas)'],
      ['Ctrl+K', 'Borrar hasta el final de la línea'],
      ['Supr', 'Borrar el carácter siguiente'],
      ['⌥← ⌥→', 'Saltar palabra'],
      ['Inicio/Fin · Ctrl+A/E', 'Inicio / final de la línea'],
      ['↑ ↓', 'Línea anterior / siguiente (cajas de varias líneas)'],
      ['Alt+↵ · \\+↵', 'Nueva línea'],
    ],
    note: 'Lo que escribes se guarda como borrador hasta que lo envías. En Terminal.app activa Ajustes › Perfiles › Teclado › «Usar Opción como tecla Meta».',
  },
  {
    title: 'Consumo (perfil al lanzar)',
    rows: [
      ['Máximo', profileHelp('max')],
      ['Equilibrado', profileHelp('balanced')],
      ['Ahorro (exp.)', profileHelp('saver')],
    ],
  },
  {
    title: 'Uso de Claude',
    rows: [['u', 'Ver el uso de Claude (5 h y semanal) y el gasto de la sesión']],
    note: 'En las sesiones de orq, la barra de estado de Claude la gestiona orq para leer el uso.',
  },
  {
    title: 'Copiar y seleccionar',
    rows: [
      ['y', 'Copiar el mensaje o la salida del agente'],
      ['Alt+C', 'Copiar el borrador del compositor'],
      ['Alt+S', 'Modo selección: el ratón selecciona texto (Esc vuelve)'],
    ],
    note: 'En iTerm2 y Ghostty, ⌥ + arrastrar selecciona sin cambiar de modo. Dentro de tmux: set -g set-clipboard on.',
  },
  {
    title: 'Equipos',
    tab: 'teams',
    rows: [
      ['↵', 'Ver el detalle del equipo'],
      ['l · L', 'Lanzar (siempre pide confirmación)'],
      ['n', 'Nuevo equipo'],
      ['e', 'Editar'],
      ['d', 'Duplicar'],
      ['Supr / ⌫', 'Borrar (pide confirmación)'],
      ['[ ]', 'Categoría anterior / siguiente'],
      ['/', 'Buscar equipo'],
      ['Detalle: Espacio', 'Incluir / excluir miembro'],
      ['Detalle: c', 'Hacer coordinador'],
      ['Editor: /', 'Filtrar roles'],
      ['p', 'Componer: Departamento / Auto por rol / Auto por partes'],
      ['o', 'Consumo del próximo lanzamiento: Ahorro / Equilibrado / Máximo'],
      ['v', 'Proveedor del próximo lanzamiento: por rol / claude / claude-api / zai / glm / minimax / grok / gemini / openai / opencode'],
      ['Auto: ↵ · l', 'Crear y lanzar (pide confirmación)'],
      ['Auto: r · g · a', 'Revisar · guardar en este proyecto · reanalizar'],
      ['Revisar: Espacio · c', 'Incluir · cambiar coordinador'],
      ['Revisar: w · b · e', 'Escribe/lee · rol base · renombrar'],
      ['Revisar: n · f · Supr · u', 'Añadir · fusionar · quitar área · deshacer'],
    ],
  },
  {
    title: 'Roles',
    tab: 'roles',
    rows: [
      ['Espacio', 'Añadir a la selección / quitar'],
      ['l · L', 'Lanzar la selección (siempre pide confirmación)'],
      ['x', 'Limpiar la selección'],
      ['/', 'Buscar rol'],
      ['[ ]', 'Pack anterior / siguiente'],
      ['i', 'Importar roles'],
      ['n', 'Nuevo rol'],
      ['e', 'Editar'],
      ['d', 'Duplicar'],
      ['Supr / ⌫', 'Borrar (pide confirmación)'],
    ],
  },
  {
    title: 'Oficina',
    tab: 'office',
    rows: [
      ['↵', 'Abrir el agente y elegirlo como destinatario'],
      ['i', 'Escribir una tarea'],
      ['v', 'Ver como tarjetas / lista'],
      ['c', 'Contratar un agente'],
      ['Avisos: a', 'Aceptar (en los informativos: cerrar)'],
      ['Avisos: r', 'Rechazar'],
      ['Avisos: v', 'Ver'],
      ['Panel: [ ]', 'Historial / Claude / Comandos'],
      ['Panel: w', 'Escribir en la terminal del agente'],
      ['Panel: r', 'Reiniciar (pide confirmación)'],
      ['Panel: Supr', 'Despedir (pide confirmación)'],
      ['Tarea: ↵', 'Enviar'],
      ['Tarea: Alt+↵ · \\↵', 'Nueva línea'],
      ['Tarea: ⇧Tab', 'Elegir destinatario'],
      ['Tarea: Ctrl+U', 'Borrar el texto'],
    ],
  },
  {
    title: 'Terminales',
    tab: 'terminals',
    rows: [
      ['↵', 'Ampliar'],
      ['RePág/AvPág', 'Página de terminales'],
      ['Ampliada: [ ]', 'Claude / Comandos'],
      ['Ampliada: w · ↵', 'Escribir en la terminal'],
      ['Ampliada: Esc', 'Volver a todas'],
      ['Escribiendo: {exit}', 'Dejar de escribir'],
      ['Escribiendo: Esc Esc Esc', '(rápido) también deja de escribir'],
      ['Escribiendo: Ctrl+C', 'Se envía al agente (lo interrumpe)'],
    ],
  },
  {
    title: 'Mensajes',
    tab: 'messages',
    rows: [
      ['↑↓', 'Mover'],
      ['↵ · Espacio', 'Desplegar / plegar'],
      ['Inicio / Fin', 'Primeros / últimos (con Fin se siguen los nuevos)'],
    ],
  },
  {
    title: 'Sesiones',
    tab: 'sessions',
    rows: [
      ['↵', 'Reconectar, reanudar o ir a la oficina'],
      ['s', 'Detener la sesión (pide confirmación)'],
      ['Supr / ⌫', 'Quitar de la lista (pide confirmación)'],
      ['a', 'Este directorio / Todos'],
    ],
  },
  {
    title: 'Confirmar',
    rows: [
      ['[letra]', 'Pulsa la letra entre corchetes del botón'],
      ['←→ · Tab', 'Elegir botón'],
      ['↵', 'Pulsar el botón elegido'],
      ['Esc', 'Cancelar (es la opción con el foco al abrir)'],
    ],
    note: 'Lanzar y Añadir: elige el botón con ←→ y pulsa ↵ (sin letra, para evitar lanzar por error)',
  },
];

const KEY_COL = 14;

/**
 * Help lines for `tab`, in order: this tab › Global › Modos › other tabs › Confirmar.
 * Each line is [key, action] or a section heading / note ([text, '']).
 */
export function helpLines(tab: string, opts: { width: number; exitLabel?: string; singleKey?: boolean }): { kind: 'title' | 'row' | 'note' | 'blank'; key?: string; text: string }[] {
  const fill = (s: string) => s.replace(/\{exit\}/g, opts.exitLabel ?? 'Ctrl+]');
  const own = HELP.filter((s) => s.tab === tab);
  const rest = HELP.filter((s) => s.tab && s.tab !== tab);
  const order = [...own, ...HELP.filter((s) => !s.tab && s.title !== 'Confirmar'), ...rest, ...HELP.filter((s) => s.title === 'Confirmar')];
  const out: ReturnType<typeof helpLines> = [];
  const textW = Math.max(10, opts.width - KEY_COL - 1);
  for (const s of order) {
    if (out.length) out.push({ kind: 'blank', text: '' });
    out.push({ kind: 'title', text: s.title });
    for (const [k, t] of s.rows) {
      const key = fill(k);
      const lines = wrapWords(fill(t), textW);
      if (key.length >= KEY_COL) out.push({ kind: 'row', key, text: '' });
      lines.forEach((l, i) => out.push({ kind: 'row', key: i === 0 && key.length < KEY_COL ? key : '', text: l }));
    }
    if (s.note) for (const l of wrapWords(fill(s.note), opts.width)) out.push({ kind: 'note', text: l });
  }
  return out;
}

/** Word wrap; words longer than `width` (paths, URLs) are split so nothing is cut off. */
export function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (let w of text.split(' ')) {
    if (line && (line + ' ' + w).length > width) (out.push(line), (line = ''));
    while ((line ? line.length + 1 : 0) + w.length > width && width > 0) {
      const cut = width - (line ? line.length + 1 : 0);
      out.push(line ? `${line} ${w.slice(0, cut)}` : w.slice(0, cut));
      line = '';
      w = w.slice(cut);
    }
    line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

const TAB_TITLE: Record<string, string> = { teams: 'Equipos', roles: 'Roles', office: 'Oficina', terminals: 'Terminales', messages: 'Mensajes', sessions: 'Sesiones' };

/** Paints `lines` over whatever is below: every cell is written, so nothing shows through. */
function Sheet({ width, height, title, lines, footer, color = PRIMARY }: { width: number; height: number; title: string; lines: React.ReactNode[]; footer?: React.ReactNode; color?: string }) {
  const inner = width - 2;
  const body = height - 2 - (footer ? 1 : 0);
  const pad = (n: number) => <Text>{' '.repeat(Math.max(0, n))}</Text>;
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle={border('round')} borderColor={color} backgroundColor={SURFACE} flexShrink={0}>
      {/* Blank every inner cell first; the content below is painted on top. */}
      <Box position="absolute" flexDirection="column" width={inner} height={height - 2} aria-hidden>
        {Array.from({ length: height - 2 }, (_, i) => (
          <Text key={i}>{' '.repeat(inner)}</Text>
        ))}
      </Box>
      <Text bold color={color} wrap="truncate">
        {` ${title}`.padEnd(inner)}
      </Text>
      {Array.from({ length: Math.max(0, body - 1) }, (_, i) => (
        <Box key={i} width={inner} height={1} overflow="hidden">
          {lines[i] ?? pad(inner)}
        </Box>
      ))}
      {footer ? (
        <Box width={inner} height={1} overflow="hidden">
          {footer}
        </Box>
      ) : null}
    </Box>
  );
}

/** The `?` overlay: centred box up to 80x24, full screen below 100x30, scrollable. */
export function HelpOverlay({ width, height, tab }: { width: number; height: number; tab: string }) {
  const k = useK();
  const full = width < 100 || height < 30;
  const w = full ? width : Math.min(width, 66);
  const h = full ? height : Math.min(height, 24);
  const inner = w - 2;
  const lines = helpLines(tab, { width: inner - 2, exitLabel: k.exitLabel, singleKey: k.singleKey });
  const visible = h - 4;
  const max = Math.max(0, lines.length - visible);
  const off = Math.min(k.helpScroll, max);
  // Keep the stored offset in range so ↑ responds right after scrolling past the end.
  useEffect(() => {
    if (k.helpScroll > max) k.setHelpScroll(max);
  }, [k.helpScroll, max]);
  const rows = lines.slice(off, off + visible).map((l, i) => (
    <Text key={i} wrap="truncate">
      {' '}
      {l.kind === 'title' ? (
        <Text bold color={PRIMARY}>
          {l.text.padEnd(inner - 1)}
        </Text>
      ) : l.kind === 'row' && (l.key ?? '').length >= KEY_COL ? (
        <Text color={PRIMARY} bold>
          {(l.key ?? '').padEnd(inner - 1)}
        </Text>
      ) : l.kind === 'row' ? (
        <>
          <Text color={PRIMARY} bold>
            {(l.key ?? '').padEnd(KEY_COL)}
          </Text>
          <Text color={TEXT}>{l.text.padEnd(inner - 1 - KEY_COL)}</Text>
        </>
      ) : (
        <Text color={MUTED}>{l.text.padEnd(inner - 1)}</Text>
      )}
    </Text>
  ));
  const footer = (
    <Text color={MUTED} wrap="truncate">
      {` ↑↓ desplazar ${g.sep} Esc o ? cerrar${max ? `  (${off + 1}-${Math.min(lines.length, off + visible)}/${lines.length})` : ''}`.padEnd(inner)}
    </Text>
  );
  return <Sheet width={w} height={h} title={`Atajos de teclado ${g.sep} ${TAB_TITLE[tab] ?? tab}`} lines={rows} footer={footer} />;
}

let layerSeq = 0;

/** Columns available to a <Modal>'s `children` (inside border and padding). */
export const modalContentWidth = (screenWidth: number, maxWidth = 72) => Math.min(screenWidth, maxWidth) - 4;
/** Rows a <Modal>'s body takes once wrapped (same width as the modal uses). */
export const modalBodyLines = (lines: string[], screenWidth: number, maxWidth = 72) => lines.flatMap((l) => wrapWords(l, Math.min(screenWidth, maxWidth) - 5)).length;

export type ModalProps = {
  title: string;
  /** Screen size: the modal covers it (absolute) and centres itself. Render it as the last child of the full-screen root. */
  width: number;
  height: number;
  /** Box width cap (default 72). */
  maxWidth?: number;
  /** Body text, wrapped; scrolls with ↑↓ RePág/AvPág when longer than `bodyRows`. */
  lines?: string[];
  /** Rows for the body text (default: all lines, capped by the screen). */
  bodyRows?: number;
  /** Free content under the body (e.g. a TextArea). Function form gets the field under the cursor. */
  children?: React.ReactNode | ((s: { cursor: string | null }) => React.ReactNode);
  /** Rows `children` take, so the box can be sized and painted. */
  contentRows?: number;
  /** Buttons, left to right. "[X]abc" labels get access letter X. They do not close the modal: do it in `run`. */
  actions: ModalAction[];
  /** Ids of TextField/TextArea inside `children` that join the focus ring, before the actions. ↵ edits, Tab leaves. */
  fields?: string[];
  /** Action index or field id with the initial focus (default: the last action, usually Cancelar). */
  initialFocus?: number | string;
  /** Esc (and nothing else) calls it. */
  onClose: () => void;
  /** ↑↓ go here instead of scrolling the body (e.g. a radio group in the content). */
  onUpDown?: (dir: -1 | 1) => void;
  /** Sees every key first (names as in keyNames); return true to consume it. */
  onKeys?: (names: string[]) => boolean;
  /** Footer while open: 'confirm' (access letters) or 'confirm.launch'. */
  footer?: FooterContext;
  color?: string;
};

/**
 * Modal dialog: title, scrollable body, free content and a row of actions.
 * Traps the keyboard (only the topmost modal gets keys), ignores input for 300 ms
 * after opening (keys and clicks), never takes the opening key as an access letter,
 * ←→/Tab/⇧Tab move, ↵ presses, Esc = onClose. j/k/l are never access letters.
 */
export function Modal({
  title,
  width,
  height,
  maxWidth = 72,
  lines = [],
  bodyRows,
  children,
  contentRows = 0,
  actions,
  fields = [],
  initialFocus,
  onClose,
  onUpDown,
  onKeys,
  footer = 'confirm',
  color,
}: ModalProps) {
  const k = useK();
  const { setFocused, focused } = useFocusState();
  const openedAt = useRef(Date.now());
  const opener = useRef(k.lastKey());
  const ring = [...fields.map((f) => ({ field: f })), ...actions.map((_, i) => ({ action: i }))] as ({ field: string } | { action: number })[];
  const start = typeof initialFocus === 'string' ? fields.indexOf(initialFocus) : fields.length + (initialFocus ?? actions.length - 1);
  const [pos, setPosState] = useState(Math.max(0, Math.min(ring.length - 1, start)));
  const posRef = useRef(pos);
  const setPos = (n: number) => ((posRef.current = n), setPosState(n));
  const [scroll, setScrollState] = useState(0);
  const scrollRef = useRef(0);

  const w = Math.min(width, maxWidth);
  const inner = w - 2;
  const wrapped = lines.flatMap((l) => wrapWords(l, inner - 3));
  const fixed = 2 + 1 + 1 + 1 + 1 + contentRows; // border, title, blank, blank, actions, content
  const rowsFor = Math.max(1, Math.min(bodyRows ?? wrapped.length, height - fixed));
  const maxScroll = Math.max(0, wrapped.length - rowsFor);
  const setScroll = (n: number) => {
    const v = Math.max(0, Math.min(maxScroll, n));
    scrollRef.current = v;
    setScrollState(v);
  };
  const ready = () => Date.now() - openedAt.current >= MODAL_GUARD_MS;
  const press = (i: number) => {
    const a = actions[i];
    if (a && !a.disabled) a.run();
  };
  const activate = (n: number) => {
    const item = ring[n];
    if (!item) return;
    if ('field' in item) setFocused(item.field);
    else press(item.action);
  };

  const handle = useRef<(names: string[]) => void>(() => {});
  handle.current = (names) => {
    if (!ready()) return;
    const has = (n: string) => names.includes(n);
    const p = posRef.current;
    if (has('esc')) return onClose();
    if (onKeys?.(names)) return;
    if (has('left') || has('shift+tab')) return setPos((p + ring.length - 1) % ring.length);
    if (has('right') || has('tab')) return setPos((p + 1) % ring.length);
    if (has('up')) return onUpDown ? onUpDown(-1) : setScroll(scrollRef.current - 1);
    if (has('down')) return onUpDown ? onUpDown(1) : setScroll(scrollRef.current + 1);
    if (has('pageup')) return setScroll(scrollRef.current - rowsFor);
    if (has('pagedown')) return setScroll(scrollRef.current + rowsFor);
    if (!onUpDown && has('home')) return setScroll(0);
    if (!onUpDown && has('end')) return setScroll(maxScroll);
    if (has('enter') || has('space')) return activate(p);
    const letter = names.find((n) => n.length === 1);
    if (letter && letter !== opener.current && !RESERVED_ACCESS.has(letter)) {
      const i = actions.findIndex((a) => accessKey(a.label) === letter);
      if (i >= 0) return press(i);
    }
  };
  useEffect(() => k.addLayer({ id: ++layerSeq, handle, footer }), [footer]);

  const cursorItem = ring[pos];
  const fieldCursor = cursorItem && 'field' in cursorItem && focused !== cursorItem.field ? cursorItem.field : null;
  const content = typeof children === 'function' ? children({ cursor: fieldCursor }) : children;
  const h = Math.min(height, fixed + rowsFor);
  const tone = color ?? (actions.some((a) => a.variant === 'danger') ? DANGER : WARN);
  const body = wrapped.slice(scroll, scroll + rowsFor);
  return (
    <Box position="absolute" width={width} height={height} alignItems="center" justifyContent="center" aria-role="menu" aria-label={title}>
      <Box flexDirection="column" width={w} height={h} borderStyle={border('round')} borderColor={tone} backgroundColor={SURFACE} flexShrink={0}>
        {/* Blank every inner cell first; the content below is painted on top. */}
        <Box position="absolute" flexDirection="column" width={inner} height={h - 2} aria-hidden>
          {Array.from({ length: h - 2 }, (_, i) => (
            <Text key={i}>{' '.repeat(inner)}</Text>
          ))}
        </Box>
        <Text bold color={tone} wrap="truncate">
          {` ${title}`}
        </Text>
        {/* The wheel scrolls the body; the scrollbar can be clicked or dragged. */}
        <Box flexDirection="row" height={rowsFor}>
          <Clickable onWheel={maxScroll > 0 ? (d) => setScroll(scrollRef.current + d) : undefined} flexDirection="column" width={inner - 1}>
            {body.map((l, i) => (
              <Text key={i} color={scroll + i === 0 ? TEXT : MUTED} bold={scroll + i === 0} wrap="truncate">
                {` ${l}`}
              </Text>
            ))}
          </Clickable>
          {maxScroll > 0 ? <Scrollbar total={wrapped.length} visible={rowsFor} offset={scroll} onScroll={setScroll} height={rowsFor} color={tone} /> : null}
        </Box>
        {contentRows > 0 ? (
          <Box flexDirection="column" height={contentRows} paddingX={1} overflow="hidden">
            {content}
          </Box>
        ) : (
          content
        )}
        <Text> </Text>
        <Box flexDirection="row" paddingLeft={1} height={1}>
          {actions.map((a, i) => (
            <React.Fragment key={a.label}>
              {i > 0 && <Box width={1} />}
              <Button
                label={a.label}
                variant={a.variant ?? (i === actions.length - 1 && actions.length > 1 ? 'secondary' : 'primary')}
                solid
                disabled={a.disabled}
                cursor={pos === fields.length + i && !focused}
                onClick={() => ready() && (setPos(fields.length + i), press(i))}
              />
            </React.Fragment>
          ))}
        </Box>
        <Text> </Text>
      </Box>
    </Box>
  );
}

/** Imperative modal from useModal().open(): actions + «Cancelar (Esc)», focus on Cancel. */
function SpecModal({ width, height }: { width: number; height: number }) {
  const k = useK();
  const m = k.spec!;
  const close = () => k.closeModal(true);
  const actions: ModalAction[] = [
    ...m.actions.map((a) => ({ ...a, run: () => (k.closeModal(false), a.run()) })),
    { label: m.cancelLabel ?? 'Cancelar (Esc)', run: close, variant: 'secondary' as const },
  ];
  return <Modal title={m.title} width={width} height={height} maxWidth={m.maxWidth} lines={m.lines} actions={actions} onClose={close} footer={m.footer ?? 'confirm'} />;
}

/**
 * Render once at the root, after the screens: the help overlay or the open modal,
 * centred over the app (absolute, nothing shows through).
 */
export function Overlays({ width, height, tab }: { width: number; height: number; tab: string }) {
  const k = useK();
  if (k.help)
    return (
      <Box position="absolute" width={width} height={height} alignItems="center" justifyContent="center" aria-role="menu">
        <HelpOverlay width={width} height={height} tab={tab} />
      </Box>
    );
  return k.spec ? <SpecModal width={width} height={height} /> : null;
}

