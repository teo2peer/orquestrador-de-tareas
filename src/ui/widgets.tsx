import { Box, Text, useInput, usePaste } from 'ink';
import stringWidth from 'string-width';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { CostProfile, PermMode } from '../types.ts';
import { border, g } from './glyphs.ts';
import { Clickable } from './mouse.tsx';
import { applyKey, follow, pasteText, rowOf, rowsOf } from './text-edit.ts';
import { cycleProvider } from '../providers.ts';
import { profileHelp, skillsWarning } from './cost.ts';
import { PROJECT_DIR } from '../paths.ts';
import { BORDER, DANGER, FOCUS, INFO, MUTED, PERM_HELP, PERM_NAME, PERM_SHORT, PRIMARY, PROFILE_NAME, PROFILE_SHORT, PROFILE_WARN, PROFILES, SELECTED_BG, SELECTED_FG, SUCCESS, TEXT, WARN, fgOn, liveReducedMotion } from './theme.ts';

export const COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'];
const COLOR_NAMES: Record<string, string> = {
  red: 'rojo',
  green: 'verde',
  yellow: 'amarillo',
  blue: 'azul',
  magenta: 'magenta',
  cyan: 'cian',
  white: 'blanco',
  gray: 'gris',
};

// ---------------------------------------------------------------- focus

export type FocusCtx = { focused: string | null; setFocused: (id: string | null) => void; provided?: boolean };
/** @internal Provided by KeymapProvider (or the deprecated FocusProvider). */
export const FocusContext = createContext<FocusCtx>({ focused: null, setFocused: () => {} });
const Focus = FocusContext;

/**
 * Which text field / terminal has the keyboard.
 * @deprecated Mount <KeymapProvider> (keymap.tsx) instead; it includes this.
 */
export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [focused, setFocused] = useState<string | null>(null);
  return <Focus.Provider value={{ focused, setFocused, provided: true }}>{children}</Focus.Provider>;
}
export const useFocusState = () => useContext(Focus);

// --------------------------------------------------------------- buttons

export type ButtonSize = 'sm' | 'md';
export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger';

/**
 * Whether an sm button draws "[ label ]" (everything clickable has a frame or a fill).
 * Shared by buttonWidth and the button's look so both always agree.
 */
export function looksBracketed(o: { variant?: ButtonVariant; solid?: boolean; color?: string; active?: boolean; explicitSm?: boolean }): boolean {
  if (o.active !== undefined) return false;
  if (o.variant === 'secondary' || o.variant === 'tertiary') return true;
  if (o.variant === 'danger') return !o.solid;
  if (o.variant === 'primary') return false;
  // Legacy (no variant): bracketed unless filled.
  return !(o.solid || o.explicitSm);
}

/**
 * Columns a <Button> takes, including its 1-column right margin, so screens can
 * check whether a row of buttons fits before rendering it. `secondary`, `tertiary`
 * and (non-solid) `danger` sm buttons draw "[ label ]" (2 extra columns).
 */
export function buttonWidth(label: string, size: ButtonSize = 'sm', compact = false, variant?: ButtonVariant, solid = false): number {
  const w = stringWidth(label);
  if (size === 'sm') return w + (looksBracketed({ variant, solid, explicitSm: true }) ? 4 : 2) + 1;
  return w + 2 + (compact ? 2 : 4) + 1;
}

/** `edge`: colour of the "[ ]" when it differs from the label (tertiary: BORDER). */
type Look = { fg: string; bg?: string; bold?: boolean; dim?: boolean; brackets?: boolean; parens?: boolean; frame: string; edge?: string };

function buttonLook(o: { variant?: ButtonVariant; color?: string; solid?: boolean; active?: boolean; disabled?: boolean; explicitSm: boolean }): Look {
  // Disabled reads as "(label)" so it survives NO_COLOR (same width as the enabled button).
  const brackets = looksBracketed(o);
  if (o.disabled) return { fg: MUTED, parens: true, brackets, frame: BORDER };
  if (o.active === true) return { fg: SELECTED_FG, bg: SELECTED_BG, bold: true, frame: SELECTED_BG };
  if (o.active === false) return { fg: MUTED, frame: BORDER };
  switch (o.variant) {
    case 'primary': {
      const bg = o.color ?? PRIMARY;
      return { fg: fgOn(bg), bg, bold: true, frame: bg };
    }
    case 'secondary':
      return { fg: o.color ?? TEXT, brackets, frame: o.color ?? BORDER };
    case 'tertiary':
      return { fg: MUTED, brackets, edge: BORDER, frame: BORDER };
    case 'danger':
      return o.solid ? { fg: fgOn(DANGER), bg: DANGER, bold: true, frame: DANGER } : { fg: DANGER, brackets, frame: DANGER };
  }
  // Legacy props (no variant), kept while screens migrate.
  const color = o.color ?? INFO;
  if (o.solid || o.explicitSm) return { fg: fgOn(color), bg: color, bold: true, frame: color };
  return { fg: color, bold: true, brackets, frame: color };
}

/**
 * Buttons. Default size is `sm` (one row); `md` (bordered, 3 rows) only on request.
 * Variants: `primary` (filled, one per area) · `secondary` ("[ label ]") ·
 * `tertiary` ("[ label ]" muted, brackets in BORDER) · `danger` ("[ ✕ label ]" red;
 * `solid` only on a confirmation step). A click flashes the label for 120 ms
 * (not with reduced motion).
 * `active` turns it into a toggle: true = selected, false = muted.
 * Legacy `color`/`solid` without `variant` still work.
 */
export function Button({
  label,
  onClick,
  variant,
  color,
  disabled,
  active,
  solid,
  size,
  compact,
  cursor,
}: {
  label: string;
  onClick: () => void;
  variant?: ButtonVariant;
  color?: string;
  disabled?: boolean;
  /** Toggle state: true = selected (filled), false = unselected (muted). */
  active?: boolean;
  solid?: boolean;
  size?: ButtonSize;
  /** md only: 1 space of padding instead of 2. */
  compact?: boolean;
  /** Keyboard cursor on it: "▸label◂" (+ underline); md also gets a bold border. Same width. */
  cursor?: boolean;
}) {
  const look = buttonLook({ variant, color, solid, active, disabled, explicitSm: size === 'sm' });
  const aria = { 'aria-role': 'button' as const, 'aria-label': label, 'aria-state': { disabled: !!disabled, selected: active === true || !!cursor } };
  const flash = useFlash();
  const press = disabled ? undefined : () => (flash.fire(), onClick());
  const text = (s: string) => (
    <Text color={look.fg} backgroundColor={look.bg} bold={look.bold || cursor} dimColor={look.dim} underline={cursor && size !== 'md'} inverse={flash.on}>
      {s}
    </Text>
  );
  const [l, r] = [g.focus, g.focusEnd];
  if (size !== 'md') {
    // Brackets in their own colour (tertiary) only when not under the cursor.
    if (look.edge && look.brackets && !look.parens && !cursor)
      return (
        <Clickable {...aria} onClick={press} marginRight={1} flexShrink={0}>
          <Text color={look.edge}>[</Text>
          {text(` ${label} `)}
          <Text color={look.edge}>]</Text>
        </Clickable>
      );
    const s = look.parens
      ? look.brackets
        ? `( ${label} )`
        : `(${label})`
      : look.brackets
        ? cursor
          ? `${l} ${label} ${r}`
          : `[ ${label} ]`
        : cursor
          ? `${l}${label}${r}`
          : ` ${label} `;
    return (
      <Clickable {...aria} onClick={press} marginRight={1} flexShrink={0}>
        {text(s)}
      </Clickable>
    );
  }
  const s = look.parens
    ? compact
      ? `(${label})`
      : ` (${label}) `
    : cursor
      ? compact
        ? `${l}${label}${r}`
        : `${l} ${label} ${r}`
      : compact
        ? ` ${label} `
        : `  ${label}  `;
  return (
    <Clickable {...aria} onClick={press} borderStyle={border(cursor ? 'bold' : 'round')} borderColor={cursor ? FOCUS : look.frame} marginRight={1} flexShrink={0} height={3}>
      {text(s)}
    </Clickable>
  );
}

export type ToggleOption<V extends string> = { value: V; label: string; color?: string };

/** Columns a <Toggle> takes: "[" + " ● label " per option + │ separators + "]" (+ " hint"). */
export const toggleWidth = (labels: string[], hint?: string) =>
  2 + labels.reduce((a, l) => a + stringWidth(l) + 3 + stringWidth(g.on), 0) + Math.max(0, labels.length - 1) + (hint ? 1 + stringWidth(hint) : 0);

/**
 * Segmented control with a frame: "[ ● Tarjetas │ ○ Lista ] v". The active option is
 * filled (selectedBg + bold), the rest in TEXT so they read as pressable; brackets and
 * │ in BORDER, the optional shortcut `hint` in MUTED. The ●/○ glyph keeps the state
 * readable under NO_COLOR.
 */
export function Toggle<V extends string>({
  options,
  value,
  onChange,
  label,
  cursor,
  hint,
}: {
  options: ToggleOption<V>[];
  value: V;
  onChange: (v: V) => void;
  label?: string;
  /** Option under the keyboard cursor: "▸● label◂". */
  cursor?: V;
  /** Shortcut key shown after the control. */
  hint?: string;
}) {
  return (
    <Box flexDirection="row" flexShrink={0} aria-role="radiogroup" aria-label={label}>
      <Text color={BORDER} aria-hidden>
        [
      </Text>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <React.Fragment key={o.value}>
            {i > 0 && (
              <Text color={BORDER} aria-hidden>
                {g.vLine}
              </Text>
            )}
            <Clickable onClick={() => onChange(o.value)} flexShrink={0} aria-role="radio" aria-label={o.label} aria-state={{ checked: on, selected: cursor === o.value }}>
              <Text backgroundColor={on ? SELECTED_BG : undefined} color={on ? SELECTED_FG : o.color ?? TEXT} bold={on || cursor === o.value} underline={cursor === o.value}>
                {cursor === o.value ? `${g.focus}${on ? g.on : g.off} ${o.label}${g.focusEnd}` : ` ${on ? g.on : g.off} ${o.label} `}
              </Text>
            </Clickable>
          </React.Fragment>
        );
      })}
      <Text color={BORDER} aria-hidden>
        ]
      </Text>
      {hint && <Text color={MUTED}> {hint}</Text>}
    </Box>
  );
}

/**
 * «Elegir y confirmar»: vertical radios "◉ 1  label   ‹recomendada›". Clicks only select
 * (the parent shows what will be sent and confirms); the selected row is filled, the
 * keyboard cursor ▸ is independent of it. Controlled by the parent.
 */
type PickOption = { value: string; label: string; recommended?: boolean; danger?: boolean };
const optionHead = (i: number, here: boolean, on: boolean) => `${here ? g.focus : ' '} ${on ? g.radioOn : g.radioOff} ${i + 1}  `;
const optionTag = (o: PickOption) => (o.recommended ? ' recomendada ' : '');

/** Label of option `i` wrapped to the picker's width, at most `maxLines` rows (the last one ends in «…» if cut). */
export function optionLines(o: PickOption, i: number, width: number, maxLines = 1): string[] {
  const w = Math.max(1, width - stringWidth(optionHead(i, false, false)) - stringWidth(optionTag(o)));
  const out: string[] = [];
  let rest = o.label.replace(/\s+/g, ' ').trim();
  while (rest && out.length < maxLines) {
    if (stringWidth(rest) <= w) (out.push(rest), (rest = ''));
    else {
      const sp = rest.lastIndexOf(' ', w);
      const cut = sp > 0 ? sp : w;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
  }
  if (rest) out[out.length - 1] = `${out[out.length - 1]!.slice(0, w - 1)}…`;
  return out.length ? out : [''];
}

/** Rows an <OptionPicker> takes. */
export const optionPickerRows = (options: PickOption[], width: number, maxLines = 1) => options.reduce((n, o, i) => n + optionLines(o, i, width, maxLines).length, 0);

export function OptionPicker({
  options,
  value,
  onChange,
  cursor,
  label = 'Respuestas',
  width,
  maxLines = 1,
}: {
  options: PickOption[];
  value?: string;
  onChange: (v: string) => void;
  /** Row under the keyboard cursor. */
  cursor?: number;
  label?: string;
  width: number;
  /** Long labels wrap up to this many rows. */
  maxLines?: number;
}) {
  return (
    <Box flexDirection="column" flexShrink={0} aria-role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const on = o.value === value;
        const here = cursor === i;
        const tag = optionTag(o);
        const head = optionHead(i, here, on);
        const rows = optionLines(o, i, width, maxLines);
        const indent = ' '.repeat(stringWidth(head));
        return (
          <Clickable
            key={i}
            onClick={() => onChange(o.value)}
            flexDirection="column"
            height={rows.length}
            width={width}
            aria-role="radio"
            aria-label={`${o.label}${o.recommended ? ', recomendada' : ''}${on ? ', seleccionada' : ''}`}
            aria-state={{ checked: on, selected: here }}
          >
            {rows.map((r, j) => (
              <Box key={j} flexDirection="row" height={1}>
                <Text backgroundColor={on ? SELECTED_BG : undefined} color={on ? SELECTED_FG : o.danger ? DANGER : TEXT} bold={on || here} wrap="truncate">
                  {((j ? indent : head) + r).padEnd(Math.max(0, width - (j ? 0 : stringWidth(tag))))}
                </Text>
                {tag && !j && <Text color={fgOn(INFO)} backgroundColor={INFO}>{tag}</Text>}
              </Box>
            ))}
          </Clickable>
        );
      })}
    </Box>
  );
}

/** Columns a <BackButton> takes (with its right margin). */
export const backButtonWidth = (label = 'Volver') => stringWidth(`[ ${g.back} ${label}  Esc ]`) + 1;

/**
 * Common "back" control, always first in a header: "[ ← Volver  Esc ]" with Esc in
 * MUTED; `label` names the destination ("Volver a la vista previa"…). Esc does the same.
 */
export function BackButton({ label = 'Volver', onClick, cursor }: { label?: string; onClick: () => void; cursor?: boolean }) {
  const flash = useFlash();
  return (
    <Clickable onClick={() => (flash.fire(), onClick())} marginRight={1} flexShrink={0} aria-role="button" aria-label={`${label} (Esc)`} aria-state={{ selected: !!cursor }}>
      <Text color={cursor ? FOCUS : BORDER}>{cursor ? `${g.focus} ` : '[ '}</Text>
      <Text color={TEXT} bold={cursor} inverse={flash.on}>
        {g.back} {label}
      </Text>
      <Text color={MUTED}>{'  Esc'}</Text>
      <Text color={cursor ? FOCUS : BORDER}>{cursor ? ` ${g.focusEnd}` : ' ]'}</Text>
    </Clickable>
  );
}

/** Press feedback: `on` for 120 ms after `fire()`; never with reduced motion. */
export function useFlash(ms = 120) {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return {
    on,
    fire: () => {
      if (liveReducedMotion()) return;
      setOn(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), ms);
    },
  };
}

/**
 * Checkbox. Pass `cursor` (true/false) when it takes part in keyboard navigation: it
 * reserves one column for the "▸" marker so moving the cursor shifts nothing.
 */
export function Checkbox({ checked, label, onToggle, color, cursor }: { checked: boolean; label: React.ReactNode; onToggle: () => void; color?: string; cursor?: boolean }) {
  return (
    <Clickable onClick={onToggle} flexShrink={0} aria-role="checkbox" aria-state={{ checked, selected: !!cursor }} aria-label={typeof label === 'string' ? label : undefined}>
      {cursor !== undefined && <Text color={FOCUS}>{cursor ? g.focus : ' '}</Text>}
      <Text color={checked ? color ?? SUCCESS : MUTED}>{checked ? `${g.checked} ` : `${g.unchecked} `}</Text>
      {typeof label === 'string' ? <Text>{label}</Text> : label}
    </Clickable>
  );
}

// ------------------------------------------------------------ text input

export function TextField({
  id,
  value,
  onChange,
  onSubmit,
  placeholder,
  width = 30,
  label,
  cursor: navCursor,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  width?: number;
  label?: string;
  /** Keyboard cursor on the field (not editing yet): bold label + "▸". */
  cursor?: boolean;
}) {
  const { focused, setFocused } = useFocusState();
  const isFocused = focused === id;
  const marked = isFocused || !!navCursor;
  // Cursor position; null = after the last character (follows the value as it grows).
  const [pos, setPosState] = useState<number | null>(null);
  // Refs: several keys can arrive in one chunk before React re-renders.
  const live = useRef({ value, pos: pos as number | null });
  live.current.value = value;
  const setPos = (p: number | null) => ((live.current.pos = p), setPosState(p));
  const cursor = pos === null ? value.length : Math.min(pos, value.length);
  useEffect(() => {
    if (!isFocused) setPos(null);
  }, [isFocused]);
  useInput(
    (input, key) => {
      const v = live.current.value;
      const at = live.current.pos === null ? v.length : Math.min(live.current.pos, v.length);
      const { next, action } = applyKey({ value: v, cursor: at }, input, key);
      if (next.value !== v) {
        live.current.value = next.value;
        onChange(next.value);
      }
      setPos(next.cursor >= next.value.length ? null : next.cursor);
      if (action === 'blur') setFocused(null);
      if (action === 'submit') onSubmit ? onSubmit(next.value) : setFocused(null);
    },
    { isActive: isFocused },
  );
  // Bracketed paste: inserted as text (newlines become spaces), never submitted.
  usePaste(
    (text) => {
      const v = live.current.value;
      const at = live.current.pos === null ? v.length : Math.min(live.current.pos, v.length);
      const next = pasteText({ value: v, cursor: at }, text, false);
      live.current.value = next.value;
      onChange(next.value);
      setPos(next.cursor >= next.value.length ? null : next.cursor);
    },
    { isActive: isFocused },
  );
  // "▏…▕" bounds are drawn inside `width`.
  const inner = Math.max(1, width - 2);
  const view = fieldWindow(value, isFocused ? cursor : value.length, inner);
  const edge = (s: string) => <Text color={marked ? PRIMARY : BORDER}>{s}</Text>;
  return (
    <Box flexDirection="row" flexShrink={0}>
      {label && (
        // The focus marker takes the place of the separating space: no layout shift.
        <Text color={marked ? TEXT : MUTED} bold={marked}>
          {label}
          {marked ? <Text color={PRIMARY}>{g.focus}</Text> : ' '}
        </Text>
      )}
      <Clickable
        onClick={(p) => {
          // A click inside the focused field moves the cursor there.
          if (isFocused) setPos(Math.min(value.length, Math.max(0, cursor - (view.before.length - (p.x - 1)))));
          setFocused(id);
        }}
        width={width}
        flexShrink={0}
        aria-role="textbox"
        aria-label={label ?? placeholder}
        aria-state={{ selected: marked }}
      >
        <Text wrap="truncate">
          {edge(g.fieldL)}
          {isFocused ? (
            <>
              <Text inverse>{view.before}</Text>
              {view.at === ' ' ? g.block : <Text bold underline>{view.at}</Text>}
              <Text inverse>{view.after}</Text>
            </>
          ) : value ? (
            <Text color={TEXT} underline>
              {view.before + view.at + view.after}
            </Text>
          ) : (
            <Text dimColor underline>
              {(placeholder ?? '').slice(0, inner).padEnd(inner)}
            </Text>
          )}
          {edge(g.fieldR)}
        </Text>
      </Clickable>
    </Box>
  );
}

/**
 * Visible slice of a one-line field `width` columns wide with the cursor at `cursor`:
 * text before the cursor, the cell under it, and text after (padded to `width`).
 * Scrolls so the cursor stays visible; a leading "…" marks hidden text.
 */
export function fieldWindow(value: string, cursor: number, width: number): { before: string; at: string; after: string } {
  const w = Math.max(1, width);
  const c = Math.max(0, Math.min(cursor, value.length));
  const start = Math.max(0, c - (w - 1));
  let shown = value.slice(start, start + w).padEnd(w);
  if (start > 0 && w > 1) shown = g.ellipsis.slice(0, 1) + shown.slice(1);
  const i = c - start;
  return { before: shown.slice(0, i), at: shown[i] ?? ' ', after: shown.slice(i + 1) };
}

/**
 * Multi-line text area. Enter submits; Alt+Enter or a trailing "\\" + Enter inserts a
 * newline; pasted text keeps its line breaks. Text wraps to the box width; the view
 * follows the cursor (←→↑↓, word and line keys as in TextField), the wheel scrolls it,
 * and a scrollbar plus "líneas a–b de n" (bottom border) show up when it overflows. ↑↓
 * stop at the first/last row. `note` goes on the bottom border, left (e.g. a recovered
 * draft). The cursor blinks unless ORQ_REDUCED_MOTION is set. Unfocused and empty it
 * shows `placeholder` (keep it short) or "Clic para escribir".
 */
export function TextArea({
  id,
  value,
  onChange,
  onSubmit,
  placeholder,
  width,
  rows = 4,
  color = PRIMARY,
  cursor: navCursor,
  note,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  width: number;
  rows?: number;
  color?: string;
  /** Keyboard cursor on it (not editing yet): bold border. */
  cursor?: boolean;
  note?: string;
}) {
  const { focused, setFocused } = useFocusState();
  const isFocused = focused === id;
  const [blink, setBlink] = useState(true);
  useEffect(() => {
    if (!isFocused || liveReducedMotion()) return setBlink(true);
    const t = setInterval(() => setBlink((b) => !b), 530);
    return () => clearInterval(t);
  }, [isFocused]);
  // Text columns: border + padding take 4, the scrollbar 1.
  const inner = Math.max(1, width - 5);
  const all = rowsOf(value, inner);
  const visible = Math.max(1, rows);
  const [pos, setPosState] = useState<number | null>(null); // null = end
  const [offset, setOffset] = useState<number | null>(null); // null = follow the cursor
  const live = useRef({ value, pos: pos as number | null });
  live.current.value = value;
  const setPos = (p: number | null) => ((live.current.pos = p), setPosState(p));
  const cursor = pos === null ? value.length : Math.min(pos, value.length);
  const crow = rowOf(all, cursor);
  const top = offset === null ? follow(Math.max(0, all.length - visible), crow, visible, all.length) : Math.max(0, Math.min(offset, Math.max(0, all.length - visible)));
  useEffect(() => {
    if (!isFocused) (setPos(null), setOffset(null));
  }, [isFocused]);
  useInput(
    (input, key) => {
      const v = live.current.value;
      const at = live.current.pos === null ? v.length : Math.min(live.current.pos, v.length);
      const { next, action } = applyKey({ value: v, cursor: at }, input, key, { multiline: true, width: inner });
      if (next.value !== v) {
        live.current.value = next.value;
        onChange(next.value);
      }
      setPos(next.cursor >= next.value.length ? null : next.cursor);
      // Any key brings the cursor back into view (after a wheel scroll).
      setOffset(follow(top, rowOf(rowsOf(next.value, inner), next.cursor), visible, rowsOf(next.value, inner).length));
      if (action === 'blur') setFocused(null);
      if (action === 'submit') onSubmit ? onSubmit(next.value) : setFocused(null);
    },
    { isActive: isFocused },
  );
  // Bracketed paste: inserted with its line breaks, never submitted.
  usePaste(
    (text) => {
      const v = live.current.value;
      const at = live.current.pos === null ? v.length : Math.min(live.current.pos, v.length);
      const next = pasteText({ value: v, cursor: at }, text, true);
      live.current.value = next.value;
      onChange(next.value);
      setPos(next.cursor >= next.value.length ? null : next.cursor);
      setOffset(null);
    },
    { isActive: isFocused },
  );
  const on = isFocused && blink;
  const line = (i: number) => {
    const r = all[i]!;
    const text = value.slice(r.start, r.end);
    if (!isFocused || i !== crow) return <Text key={i}>{text || ' '}</Text>;
    const col = cursor - r.start;
    const ch = text[col];
    return (
      <Text key={i}>
        {text.slice(0, col)}
        {ch === undefined ? <Text color={color}>{on ? g.block : ' '}</Text> : <Text inverse={on}>{ch}</Text>}
        {text.slice(col + 1)}
      </Text>
    );
  };
  const range = all.length > rows ? `líneas ${top + 1}–${Math.min(all.length, top + visible)} de ${all.length}` : '';
  const style = border(navCursor && !isFocused ? 'bold' : 'round');
  const frame = isFocused || navCursor ? color : BORDER;
  return (
    <Clickable
      onClick={(p) => {
        // A click puts the cursor where it lands (row and column inside the text).
        if (value) {
          const r = all[Math.min(all.length - 1, top + Math.max(0, p.y - 1))];
          if (r) setPos(Math.min(r.end, r.start + Math.max(0, p.x - 2)));
        }
        setFocused(id);
      }}
      onWheel={(d) => setOffset(Math.max(0, Math.min(Math.max(0, all.length - visible), top + Math.sign(d))))}
      width={width}
      height={rows + 2}
      flexDirection="column"
      flexShrink={0}
      aria-role="textbox"
      aria-label={placeholder}
      aria-state={{ multiline: true, selected: isFocused || !!navCursor }}
    >
      <Box flexDirection="row" height={visible + 1} borderStyle={style} borderColor={frame} borderBottom={false} paddingX={1}>
        <Box flexDirection="column" width={inner} height={visible} overflow="hidden">
          {value ? (
            all.slice(top, top + visible).map((_, k) => line(top + k))
          ) : isFocused ? (
            <Text wrap="truncate">
              <Text color={color}>{on ? g.block : ' '}</Text>
              <Text dimColor> {placeholder ?? ''}</Text>
            </Text>
          ) : (
            <Text color={MUTED} wrap="truncate">
              {placeholder || 'Clic para escribir'}
            </Text>
          )}
        </Box>
        <Scrollbar total={all.length} visible={visible} offset={top} onScroll={(n) => setOffset(n)} height={visible} color={color} />
      </Box>
      <BottomEdge width={width} style={style} color={frame} left={note} right={range} />
    </Clickable>
  );
}

const EDGES = { round: ['╰', '─', '╯'], bold: ['┗', '━', '┛'], single: ['└', '─', '┘'], double: ['╚', '═', '╝'], classic: ['+', '-', '+'] } as const;

/** Bottom border drawn by hand so it can carry muted text on the left and right. */
function BottomEdge({ width, style, color, left, right }: { width: number; style: keyof typeof EDGES; color: string; left?: string; right?: string }) {
  const [l, h, r] = EDGES[style];
  const room = Math.max(0, width - 2);
  const rt = right ? ` ${right} ` : '';
  const lt = left ? ` ${left} `.slice(0, Math.max(0, room - rt.length - 2)) : '';
  const fill = Math.max(0, room - lt.length - rt.length - (lt ? 1 : 0) - (rt ? 1 : 0));
  return (
    <Text wrap="truncate">
      <Text color={color}>
        {l}
        {lt ? h : ''}
      </Text>
      {lt && <Text color={MUTED}>{lt}</Text>}
      <Text color={color}>{h.repeat(fill)}</Text>
      {rt && <Text color={MUTED}>{rt}</Text>}
      <Text color={color}>
        {rt ? h : ''}
        {r}
      </Text>
    </Text>
  );
}

/** Colour swatches: selected "▕██▏", keyboard cursor "▸██◂", plus the selected colour's name. */
export function ColorPicker({ value, onChange, cursor }: { value: string; onChange: (c: string) => void; cursor?: string }) {
  const swatch = g.block.repeat(2);
  return (
    <Box flexDirection="row" aria-role="radiogroup" aria-label="Color">
      {COLORS.map((col) => (
        <Clickable key={col} onClick={() => onChange(col)} marginRight={1} aria-role="radio" aria-label={COLOR_NAMES[col]} aria-state={{ checked: value === col, selected: cursor === col }}>
          <Text color={col}>
            {cursor === col ? (
              <Text color={FOCUS}>{g.focus}</Text>
            ) : value === col ? (
              g.swatchL
            ) : (
              ' '
            )}
            {swatch}
            {cursor === col ? <Text color={FOCUS}>{g.focusEnd}</Text> : value === col ? g.swatchR : ' '}
          </Text>
        </Clickable>
      ))}
      <Text color={TEXT}>{COLOR_NAMES[value] ?? value}</Text>
    </Box>
  );
}

// ------------------------------------------------------------------ tabs

export function Tabs<T extends string>({ tabs, active, onSelect, color = PRIMARY }: { tabs: { id: T; label: string }[]; active: T; onSelect: (t: T) => void; color?: string }) {
  return (
    <Box flexDirection="row" aria-role="tablist">
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <Clickable key={t.id} onClick={() => onSelect(t.id)} marginRight={1} aria-role="tab" aria-label={t.label} aria-state={{ selected: on }}>
            <Text backgroundColor={on ? color : undefined} color={on ? fgOn(color) : color} bold={on}>
              {` ${t.label} `}
            </Text>
          </Clickable>
        );
      })}
    </Box>
  );
}

export function Section({ title, children, color = PRIMARY, ...rest }: { title: string; children: React.ReactNode; color?: string } & Record<string, any>) {
  return (
    <Box flexDirection="column" borderStyle={border()} borderColor={color} paddingX={1} {...rest}>
      <Text color={color} bold>
        {title}
      </Text>
      {children}
    </Box>
  );
}

/** Scrollable list driven by the mouse wheel; renders `height` rows starting at an offset. */
export function useScroll(total: number, height: number, stickBottom = false) {
  const [offset, setOffset] = useState<number | null>(null);
  const max = Math.max(0, total - height);
  const current = offset === null ? (stickBottom ? max : 0) : Math.min(offset, max);
  const scrollTo = (n: number) => {
    const next = Math.max(0, Math.min(max, Math.round(n)));
    setOffset(stickBottom && next >= max ? null : next);
  };
  const onWheel = (d: number) => scrollTo(current + d);
  /** Scrolls the least needed so row `i` is visible (keyboard cursor). */
  const ensureVisible = (i: number) => {
    if (i < current) scrollTo(i);
    else if (i >= current + height) scrollTo(i - height + 1);
  };
  return { offset: current, onWheel, scrollTo, ensureVisible, reset: () => setOffset(null), total, visible: height };
}

// ------------------------------------------------------------- scrollbar

/**
 * Vertical scrollbar: the thumb shows where you are and how much is visible.
 * Click anywhere on the track to jump there, or drag the thumb.
 */
export function Scrollbar({
  total,
  visible,
  offset,
  onScroll,
  height,
  color = PRIMARY,
}: {
  total: number;
  visible: number;
  offset: number;
  onScroll: (offset: number) => void;
  height: number;
  color?: string;
}) {
  const h = Math.max(1, height);
  const max = Math.max(0, total - visible);
  if (max === 0) return <Box width={1} height={h} flexShrink={0} aria-hidden />;
  const thumb = Math.max(1, Math.min(h, Math.round((h * visible) / total)));
  const top = Math.round(((h - thumb) * offset) / max);
  const jump = (p: { y: number }) => {
    // centre the thumb on the pointer
    const pos = Math.max(0, Math.min(h - thumb, p.y - Math.floor(thumb / 2)));
    onScroll(h === thumb ? 0 : (pos / (h - thumb)) * max);
  };
  return (
    <Clickable onDrag={jump} width={1} height={h} flexDirection="column" flexShrink={0} aria-hidden>
      {Array.from({ length: h }, (_, i) => (
        <Text key={i} color={i >= top && i < top + thumb ? color : MUTED}>
          {i >= top && i < top + thumb ? g.vThumb : g.vLine}
        </Text>
      ))}
    </Clickable>
  );
}

/** Row of content plus a scrollbar on its right, driven by a useScroll() state. */
export function ScrollArea({
  scroll,
  height,
  width,
  children,
  color,
  ...box
}: {
  scroll: ReturnType<typeof useScroll>;
  height: number;
  width?: number;
  children: React.ReactNode;
  color?: string;
} & Record<string, any>) {
  return (
    <Box flexDirection="row" height={height} width={width} flexShrink={0}>
      <Clickable onWheel={scroll.onWheel} flexDirection="column" flexGrow={1} height={height} overflow="hidden" {...box}>
        {children}
      </Clickable>
      <Scrollbar total={scroll.total} visible={scroll.visible} offset={scroll.offset} onScroll={scroll.scrollTo} height={height} color={color} />
    </Box>
  );
}

// ------------------------------------------------------ chrome-like tabs

export type TabSpec<T extends string> = {
  id: T;
  label: string;
  badge?: string;
  badgeColor?: string;
  /** Label for the compact mode; defaults to the label's first word (its icon). */
  short?: string;
};

/** Minimum free columns reserved for `right` when its width is not given. */
const RIGHT_MIN = 12;
/** Columns around each tab's text: border + padding (bordered) or padding + separator (one row). */
export const TAB_PAD = { bordered: 4, row: 3 } as const;

export type TabLayout<T extends string> = {
  /** full = label + badge · compact = icon + badge · truncated = compact, cut to fit. */
  mode: 'full' | 'compact' | 'truncated';
  showRight: boolean;
  tabs: { id: T; label: string; badge: string; width: number }[];
};

/**
 * Fits a row of chrome tabs into `width` columns. Degrades in steps: hide `right`,
 * then compact labels (icon + badge), then truncate. Each tab's `width` is exactly
 * what gets rendered (text + `pad`), so the bottom line lines up.
 */
export function layoutTabs<T extends string>(tabs: TabSpec<T>[], width: number, rightWidth?: number, pad: number = TAB_PAD.bordered): TabLayout<T> {
  const avail = width - 1; // leading space
  const build = (compact: boolean) =>
    tabs.map((t) => {
      const label = compact ? t.short ?? t.label.split(' ')[0] ?? t.label : t.label;
      const badge = t.badge ? ` ${t.badge}` : '';
      return { id: t.id, label, badge, width: label.length + badge.length + pad };
    });
  const sum = (ts: { width: number }[]) => ts.reduce((a, t) => a + t.width, 0);
  const full = build(false);
  if (sum(full) + (rightWidth ?? RIGHT_MIN) <= avail) return { mode: 'full', showRight: true, tabs: full };
  if (sum(full) <= avail) return { mode: 'full', showRight: false, tabs: full };
  const compact = build(true);
  if (sum(compact) <= avail) return { mode: 'compact', showRight: false, tabs: compact };
  // Trim the widest tab one column at a time (badge first, then label), keeping 1 char each.
  const cut = compact.map((t) => ({ ...t }));
  let over = sum(cut) - avail;
  while (over > 0) {
    const t = cut.reduce((a, b) => (b.label.length + b.badge.length > a.label.length + a.badge.length ? b : a));
    if (t.label.length + t.badge.length <= 1) break;
    if (t.badge.length) t.badge = t.badge.slice(0, -1).trimEnd();
    else t.label = t.label.slice(0, -1);
    t.width = t.label.length + t.badge.length + pad;
    over = sum(cut) - avail;
  }
  return { mode: 'truncated', showRight: false, tabs: cut };
}

/**
 * Browser-style tabs: the active tab opens into the content below. 3 rows high, or
 * 1 row with `compact` (for short terminals). `right` sits after the tabs and is
 * hidden when it does not fit; pass `rightWidth` (its real width) so it is hidden
 * instead of clipped.
 */
export function ChromeTabs<T extends string>({
  tabs,
  active,
  onSelect,
  width,
  right,
  rightWidth,
  color = PRIMARY,
  compact,
  cursor,
}: {
  tabs: TabSpec<T>[];
  active: T;
  onSelect: (t: T) => void;
  width: number;
  right?: React.ReactNode;
  rightWidth?: number;
  color?: string;
  compact?: boolean;
  /** Tab under the keyboard cursor: "▸label◂" (moving does not activate; Enter/Space does). */
  cursor?: T;
}) {
  const layout = layoutTabs(tabs, width, right ? rightWidth : 0, compact ? TAB_PAD.row : TAB_PAD.bordered);
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const used = 1 + layout.tabs.reduce((a, t) => a + t.width, 0);
  const badge = (t: { id: T; badge: string }, on: boolean) =>
    t.badge ? <Text color={on && compact ? SELECTED_FG : byId.get(t.id)?.badgeColor ?? WARN}>{t.badge}</Text> : null;
  const rightBox =
    right && layout.showRight ? (
      <Box flexGrow={1} flexShrink={1} height={compact ? 1 : 2} overflow="hidden" justifyContent="flex-end" alignItems="flex-end">
        <Box flexDirection="row" flexShrink={1} height={1} overflow="hidden">
          {right}
        </Box>
      </Box>
    ) : null;

  if (compact) {
    return (
      <Box flexDirection="row" width={width} height={1} flexShrink={0} overflow="hidden" aria-role="tablist">
        <Text> </Text>
        {layout.tabs.map((t) => {
          const on = t.id === active;
          return (
            <Clickable key={t.id} onClick={() => onSelect(t.id)} width={t.width} height={1} flexShrink={0} aria-role="tab" aria-label={byId.get(t.id)?.label} aria-state={{ selected: on || cursor === t.id }}>
              <Text wrap="truncate">
                <Text backgroundColor={on ? SELECTED_BG : undefined} color={on ? SELECTED_FG : TEXT} bold={on || cursor === t.id}>
                  {cursor === t.id ? g.focus : ' '}
                  {t.label}
                  {badge(t, on)}
                  {cursor === t.id ? g.focusEnd : ' '}
                </Text>
                <Text color={BORDER}>{g.vLine}</Text>
              </Text>
            </Clickable>
          );
        })}
        {rightBox}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={3} flexShrink={0} overflow="hidden">
      <Box flexDirection="row" height={2} width={width} overflow="hidden" aria-role="tablist">
        <Text> </Text>
        {layout.tabs.map((t) => {
          const on = t.id === active;
          return (
            <Clickable
              key={t.id}
              onClick={() => onSelect(t.id)}
              borderStyle={border()}
              borderBottom={false}
              borderColor={on ? color : BORDER}
              paddingX={cursor === t.id ? 0 : 1}
              width={t.width}
              height={2}
              flexShrink={0}
              aria-role="tab"
              aria-label={byId.get(t.id)?.label}
              aria-state={{ selected: on || cursor === t.id }}
            >
              <Text bold={on || cursor === t.id} color={on || cursor === t.id ? TEXT : MUTED} wrap="truncate">
                {cursor === t.id ? <Text color={FOCUS}>{g.focus}</Text> : null}
                {t.label}
                {badge(t, on)}
                {cursor === t.id ? <Text color={FOCUS}>{g.focusEnd}</Text> : null}
              </Text>
            </Clickable>
          );
        })}
        {rightBox}
      </Box>
      <Text wrap="truncate" aria-hidden>
        <Text color={BORDER}>{g.hLine}</Text>
        {layout.tabs.map((t) => (
          <Text key={t.id} color={t.id === active ? color : BORDER}>
            {t.id === active ? g.cornerL + ' '.repeat(t.width - 2) + g.cornerR : g.hLine.repeat(t.width)}
          </Text>
        ))}
        <Text color={BORDER}>{g.hLine.repeat(Math.max(0, width - used))}</Text>
      </Text>
    </Box>
  );
}

// --------------------------------------------------------------- sub-tabs

/**
 * Secondary, one-row tabs (e.g. categories inside a main tab). Active = colour, bold,
 * underlined. `cursor` marks the keyboard cursor "▸label◂" without activating it.
 */
export function SubTabs({
  tabs,
  active,
  onSelect,
  color = PRIMARY,
  cursor,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onSelect: (id: string) => void;
  color?: string;
  cursor?: string;
}) {
  return (
    <Box flexDirection="row" flexShrink={0} aria-role="tablist">
      {tabs.map((t, i) => {
        const on = t.id === active;
        return (
          <Clickable key={t.id} onClick={() => onSelect(t.id)} flexShrink={0} aria-role="tab" aria-label={t.label} aria-state={{ selected: on || cursor === t.id }}>
            <Text color={BORDER}>{i ? g.vLine : ' '}</Text>
            <Text color={on ? color : TEXT} bold={on || cursor === t.id}>
              {cursor === t.id ? <Text color={FOCUS}>{g.focus}</Text> : ' '}
              <Text underline={on}>{t.label}</Text>
              {t.count !== undefined ? <Text color={MUTED}> {t.count}</Text> : null}
              {cursor === t.id ? <Text color={FOCUS}>{g.focusEnd}</Text> : ' '}
            </Text>
          </Clickable>
        );
      })}
    </Box>
  );
}

// ------------------------------------------------------------ card grid

export type GridLayout = { perRow: number; visibleRows: number; cardWidth: number };

/** Cards per row, card width and visible rows for a CardGrid (see moveIndex in keymap.tsx). */
export function gridLayout(cardW: number, cardH: number, width: number, height: number): GridLayout {
  const innerW = width - 1; // last column is the scrollbar
  // every card carries a 1-column right margin, so a row needs perRow * (w + 1) columns
  const perRow = Math.max(1, Math.floor(innerW / (cardW + 1)));
  return { perRow, visibleRows: Math.max(1, Math.floor(height / cardH)), cardWidth: Math.max(cardW, Math.floor(innerW / perRow) - 1) };
}

/**
 * Wraps cards into rows and scrolls whole rows with the mouse wheel. With `cursor`
 * (item index) the grid scrolls the cursor's row into view and `render` gets
 * `{cursor: true}` for that item. `onCursor` is told when the cursor must be clamped
 * because items went away.
 */
export function CardGrid<T>({
  items,
  cardW,
  cardH,
  width,
  height,
  render,
  cursor,
  onCursor,
}: {
  items: T[];
  cardW: number;
  cardH: number;
  width: number;
  height: number;
  render: (item: T, cardWidth: number, state: { cursor: boolean; index: number }) => React.ReactNode;
  cursor?: number;
  onCursor?: (index: number) => void;
}) {
  // cardW is the minimum width; cards stretch to fill the row.
  const { perRow, visibleRows: visible, cardWidth: w } = gridLayout(cardW, cardH, width, height);
  const innerW = width - 1;
  const rows = Math.ceil(items.length / perRow);
  const max = Math.max(0, rows - visible);
  const [off, setOff] = useState(0);
  const o = Math.min(off, max);
  const to = (n: number) => setOff(Math.max(0, Math.min(max, Math.round(n))));
  useEffect(() => {
    if (cursor === undefined) return;
    if (items.length && cursor > items.length - 1) return onCursor?.(items.length - 1);
    const row = Math.floor(cursor / perRow);
    if (row < o) to(row);
    else if (row >= o + visible) to(row - visible + 1);
  }, [cursor, perRow, visible, items.length]);
  return (
    <Box flexDirection="row" width={width} height={height} flexShrink={0} aria-role="list">
      <Clickable onWheel={(d) => to(o + Math.sign(d))} flexDirection="row" flexWrap="wrap" width={innerW} height={height} overflow="hidden">
        {items.slice(o * perRow, (o + visible) * perRow).map((item, i) => render(item, w, { cursor: cursor === o * perRow + i, index: o * perRow + i }))}
      </Clickable>
      <Scrollbar total={rows} visible={visible} offset={o} onScroll={to} height={height} />
    </Box>
  );
}

export function Pill({ children, color = MUTED, solid }: { children: React.ReactNode; color?: string; solid?: boolean }) {
  return (
    <Text color={solid ? fgOn(color) : color} backgroundColor={solid ? color : undefined}>
      {solid ? ` ${children} ` : `‹${children}›`}
    </Text>
  );
}

/** Horizontal rule with an optional title; the line itself is hidden from screen readers. */
export function Divider({ title, width, color = MUTED }: { title?: string; width: number; color?: string }) {
  const t = title ? `${g.hLine} ${title} ` : '';
  return (
    <Text color={color} wrap="truncate" aria-label={title} aria-hidden={!title}>
      {t}
      {g.hLine.repeat(Math.max(0, width - t.length))}
    </Text>
  );
}

// ------------------------------------------------------------ launching

const MODES: PermMode[] = ['auto', 'auto-insecure', 'yolo'];
const MODE_COLOR: Partial<Record<PermMode, string>> = { 'auto-insecure': WARN, yolo: DANGER };
const agents = (n: number) => `${n} agente${n === 1 ? '' : 's'}`;

/** Whether the launch options (mode, consumption, provider) are unfolded; shared by every launch panel. */
let launchOptionsOpen = false;
const launchOptionsListeners = new Set<() => void>();
export function useLaunchOptions(): [boolean, () => void] {
  const open = React.useSyncExternalStore(
    (fn) => (launchOptionsListeners.add(fn), () => void launchOptionsListeners.delete(fn)),
    () => launchOptionsOpen,
  );
  return [open, () => ((launchOptionsOpen = !launchOptionsOpen), launchOptionsListeners.forEach((fn) => fn()))];
}

/**
 * Rows a <LaunchButtons> takes. The component renders at exactly this height, so
 * screens can reserve it; pass `confirming: true` for the tallest state.
 * Inline it is always 1 row.
 */
export function launchButtonsHeight({ running = false, confirming = false, inline = false, profile = false, collapsed = false }: { running?: boolean; confirming?: boolean; inline?: boolean; profile?: boolean; collapsed?: boolean } = {}): number {
  if (inline) return 1;
  // collapsed: one summary row (mode · consumption · provider) + button | confirmation
  if (collapsed && !running) return 1 + (confirming ? 4 : 1);
  // running: [button] | question + consequence + buttons
  if (running) return confirming ? 3 : 1;
  // counter + toggle (+ Consumo) + (button + help | question + up to 2 consequences + buttons)
  return 2 + (profile ? 2 : 0) + (confirming ? 4 : 2);
}

/**
 * Text of the launch confirmation step, shared by <LaunchButtons> and the keyboard launch
 * (l), so both ask the same thing with the same consequences.
 */
export function launchStep(o: { count: number; mode: PermMode; running?: boolean; confirmAbove?: number; verb?: string }) {
  const { count, mode, running = false, confirmAbove = 8, verb = running ? 'Añadir' : 'Lanzar' } = o;
  const yolo = !running && mode === 'yolo';
  const optional = !running && mode === 'auto-insecure';
  // Any mode other than Auto asks first and reads as danger (YOLO, or YOLO one Shift+Tab away).
  const risky = yolo || optional;
  const question = running
    ? `¿Añadir ${agents(count)} a la sesión?`
    : yolo
      ? `${g.warning} ¿${verb} ${agents(count)} en YOLO?`
      : optional
        ? `${g.warning} ¿${verb} ${agents(count)} en modo ${PERM_NAME[mode]}?`
        : `¿${verb} ${agents(count)} a la vez?`;
  const consequences = [
    yolo ? 'Sin confirmaciones de permisos.' : optional ? 'Cada agente puede pasar a YOLO (sin confirmaciones) con Shift+Tab.' : '',
    count > confirmAbove ? 'Cada uno es una sesión de Claude: consumen cuota y CPU en paralelo.' : '',
  ].filter(Boolean);
  // `action` has no «(↵)»: in a modal the focus starts on Cancelar, so ↵ cancels there.
  return { question, consequences, action: `${verb} ${agents(count)}`, danger: risky, needsConfirm: risky || count > confirmAbove };
}

/**
 * "Lanzar N agentes en modo:", a Toggle of permission modes, one primary launch
 * button and a help line for the mode. YOLO, or more than `confirmAbove` agents,
 * asks first: [Cancelar (Esc)]  [Lanzar N agentes] (no access letter, mouse step).
 * While a session is open, one "add" button (asks above `confirmAbove` too).
 * `mode`/`onModeChange` make the selector controlled; otherwise it starts at 'auto'.
 * `onConfirmingChange` reports the confirmation step (see launchButtonsHeight).
 */
export function LaunchButtons({
  count,
  running,
  onLaunch,
  inline,
  short,
  mode: modeProp,
  onModeChange,
  confirmAbove = 8,
  onConfirmingChange,
  disabled,
  verb: verbProp,
  profile,
  onProfileChange,
  provider,
  onProviderChange,
  collapsed,
  onToggleOptions,
}: {
  count: number;
  running: boolean;
  /** Fold mode / consumption / provider into one summary row with an «Opciones» button (see launchButtonsHeight). */
  collapsed?: boolean;
  onToggleOptions?: () => void;
  onLaunch: (mode?: PermMode) => void;
  /** One row (no help line), for toolbars. */
  inline?: boolean;
  /** Shorter labels for narrow places. */
  short?: boolean;
  mode?: PermMode;
  onModeChange?: (mode: PermMode) => void;
  confirmAbove?: number;
  onConfirmingChange?: (confirming: boolean) => void;
  /** Launch button greyed out (e.g. a plan with validation errors); the caller says why. */
  disabled?: boolean;
  /** Verb of a new launch ("Crear y lanzar"); default "Lanzar". */
  verb?: string;
  /** Cost profile row «Consumo: [ ● Ahorro │ … ] o» (new launches only; +1 row, see launchButtonsHeight). */
  profile?: CostProfile;
  onProfileChange?: (p: CostProfile) => void;
  /** Provider row «Proveedor: [ Por rol │ Claude │ … ]» next to the cost profile ('' = each role's own). */
  provider?: string;
  onProviderChange?: (p: string) => void;
}) {
  const [own, setOwn] = useState<PermMode>('auto');
  const [confirm, setConfirmState] = useState(false);
  const setConfirm = (v: boolean) => (setConfirmState(v), v !== confirm && onConfirmingChange?.(v));
  const mode = modeProp ?? own;
  const setMode = (m: PermMode) => (setOwn(m), onModeChange?.(m), setConfirm(false));
  useEffect(() => {
    setConfirm(false);
  }, [count, running, disabled]);

  // Risky modes always ask (rule in launchStep, shared with the keyboard launch); otherwise
  // ask above `confirmAbove` agents. Adding uses the session's mode.
  const { question, consequences, needsConfirm, danger } = launchStep({ count, mode, running, confirmAbove, verb: running ? 'Añadir' : verbProp ?? 'Lanzar' });
  const go = () => (setConfirm(false), running ? onLaunch() : onLaunch(mode));
  const verb = running ? 'Añadir' : verbProp ?? 'Lanzar';
  const primary = running
    ? `${g.play} Añadir ${count} a la sesión`
    : short
      ? `${g.play} ${verb} ${count}`
      : `${g.play} ${verb} ${agents(count)}`;
  const launch = <Button variant="primary" label={primary} disabled={!count || disabled} onClick={() => (needsConfirm ? setConfirm(true) : go())} />;
  // No access letter (held-key risk): Cancel first, 2 free columns, then the verb.
  const confirmRow = (
    <Box flexDirection="row" flexShrink={0}>
      <Button variant="secondary" label="Cancelar (Esc)" onClick={() => setConfirm(false)} />
      <Box width={1} />
      <Button variant={danger ? 'danger' : 'primary'} solid label={`${verb} ${agents(count)}`} onClick={go} />
    </Box>
  );
  const questionText = (
    <Text color={danger ? DANGER : WARN} bold wrap="truncate">
      {inline ? `${question} ` : question}
    </Text>
  );
  const counter = <Text>{`Lanzar ${agents(count)} en modo:`}</Text>;
  const toggle = <Toggle label="Modo de permisos" value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m, label: short ? PERM_SHORT[m] : PERM_NAME[m], color: MODE_COLOR[m] }))} />;

  if (inline) {
    return (
      <Box flexDirection="row" alignItems="center" flexShrink={0} height={1}>
        {confirm ? (
          <>
            {questionText}
            {confirmRow}
          </>
        ) : running ? (
          launch
        ) : (
          <>
            {counter}
            <Text> </Text>
            {toggle}
            <Text> </Text>
            {launch}
          </>
        )}
      </Box>
    );
  }
  if (collapsed && !running) {
    const bits = [
      <Text key="m" color={MODE_COLOR[mode] ?? TEXT} bold={mode !== 'auto'}>
        {mode !== 'auto' ? `${g.warning} ` : ''}
        {PERM_NAME[mode]}
      </Text>,
      ...(profile ? [<Text key="p">{PROFILE_SHORT[profile]}</Text>] : []),
      ...(provider !== undefined ? [<Text key="v">{provider === '' ? 'Por rol' : provider}</Text>] : []),
    ];
    return (
      <Box flexDirection="column" flexShrink={0} height={launchButtonsHeight({ confirming: confirm, collapsed: true })} overflow="hidden">
        <Box flexDirection="row" flexShrink={0} height={1} overflow="hidden">
          {bits.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <Text color={MUTED}> {g.sep} </Text>}
              {b}
            </React.Fragment>
          ))}
          <Box flexGrow={1} />
          {onToggleOptions && <Button variant="secondary" label={`${g.gear} Opciones`} onClick={onToggleOptions} />}
        </Box>
        {confirm ? (
          <>
            {questionText}
            {consequences.map((line) => (
              <Text key={line} color={MUTED} wrap="truncate">
                {line}
              </Text>
            ))}
            {consequences.length < 2 ? <Text> </Text> : null}
            {confirmRow}
          </>
        ) : (
          <Box flexDirection="row">{launch}</Box>
        )}
      </Box>
    );
  }
  const withProfile = !!profile && !!onProfileChange;
  const profileRow = withProfile && (
    <Box flexDirection="row" flexShrink={0}>
      <Box flexShrink={0}>
        <Text>Consumo: </Text>
      </Box>
      <Toggle label="Consumo" value={profile!} onChange={onProfileChange!} hint="o" options={PROFILES.map((p) => ({ value: p, label: (short ? PROFILE_SHORT : PROFILE_NAME)[p] }))} />
    </Box>
  );
  // Too many options for a toggle in the narrow side panels: one button that cycles through them.
  const nextProvider = () => onProviderChange?.(cycleProvider(provider ?? ''));
  const providerRow = withProfile && provider !== undefined && onProviderChange && (
    <Box flexDirection="row" flexShrink={0}>
      <Box flexShrink={0}>
        <Text>Proveedor: </Text>
      </Box>
      <Button variant="secondary" label={`${provider === '' ? 'Por rol' : provider} ${g.sep} cambiar (v)`} onClick={nextProvider} />
    </Box>
  );
  // A risky permission mode keeps its warning; then a repo whose skills the profile turns
  // off; otherwise the line explains the profile.
  const skills = withProfile ? skillsWarning(profile!, PROJECT_DIR) : '';
  const help =
    skills && mode === 'auto' ? (
      <Text color={WARN} wrap="truncate">
        {g.warning} {skills}
      </Text>
    ) : withProfile && mode === 'auto' ? (
      <Text color={PROFILE_WARN[profile!] ? WARN : MUTED} wrap="truncate">
        {PROFILE_WARN[profile!] ? `${g.warning} ` : ''}
        {profileHelp(profile!)}
      </Text>
    ) : (
      <Text color={MUTED} wrap="truncate">
        {PERM_HELP[mode]}
      </Text>
    );
  return (
    <Box flexDirection="column" flexShrink={0} height={launchButtonsHeight({ running, confirming: confirm, profile: withProfile })} overflow="hidden">
      {!running &&
        (onToggleOptions ? (
          <Box flexDirection="row" flexShrink={0} height={1}>
            {counter}
            <Box flexGrow={1} />
            <Button variant="secondary" label={`${g.gear} Menos`} onClick={onToggleOptions} />
          </Box>
        ) : (
          counter
        ))}
      {!running && toggle}
      {!running && profileRow}
      {!running && (providerRow || (withProfile ? <Text> </Text> : null))}
      {confirm ? (
        <>
          {questionText}
          {consequences.map((line) => (
            <Text key={line} color={MUTED} wrap="truncate">
              {line}
            </Text>
          ))}
          {running && consequences.length === 0 ? <Text> </Text> : null}
          {confirmRow}
        </>
      ) : (
        <>
          <Box flexDirection="row">{launch}</Box>
          {!running && help}
        </>
      )}
    </Box>
  );
}
