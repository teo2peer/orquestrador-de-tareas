// Glyphs used by the UI, with ASCII fallbacks.
// ASCII mode: ORQ_ASCII=1, or a locale (LC_ALL > LC_CTYPE > LANG) that is not UTF-8.
// The Unicode set avoids double-width and poorly supported symbols
// (＋ ⚡ ⤷ ⧉ ⇣ ⌨ ◷ ⇥ ♛ ♜ ⚑ ☂); ⚠ and ⚙ have ambiguous width, so they fall back too.

export function asciiMode(env: Record<string, string | undefined> = process.env): boolean {
  if (env.ORQ_ASCII === '1') return true;
  if (env.ORQ_ASCII === '0') return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return !/utf-?8/i.test(locale);
}

/** [unicode, ascii] */
const MAP = {
  add: ['+', '+'],
  copy: ['❐', 'cp'],
  import: ['↓', 'v'],
  edit: ['✎', '*'],
  gear: ['⚙', '*'],
  write: ['❯', '>'],
  detach: ['→', '->'],
  sessions: ['↺', '@'],
  play: ['▶', '>'],
  back: ['←', '<-'],
  next: ['→', '->'],
  prev: ['←', '<-'],
  focus: ['▸', '>'],
  focusEnd: ['◂', '<'],
  cursor: ['▶', '>'],
  fieldL: ['▏', '|'],
  fieldR: ['▕', '|'],
  star: ['★', '*'],
  starOff: ['☆', 'o'],
  checked: ['☑', '[x]'],
  unchecked: ['☐', '[ ]'],
  close: ['✕', 'x'],
  on: ['●', '*'],
  off: ['○', 'o'],
  swatchL: ['▕', '|'],
  swatchR: ['▏', '|'],
  stop: ['■', '#'],
  tick: ['✔', 'v'],
  bullet: ['•', '*'],
  sep: ['·', '-'],
  ellipsis: ['…', '...'],
  readOnly: ['◌', 'o'],
  area: ['▣', '#'],
  merge: ['⇆', '<>'],
  radioOn: ['◉', '(*)'],
  radioOff: ['○', '( )'],
  barOn: ['▰', '#'],
  barOff: ['▱', '-'],
  warning: ['⚠', '!'],
  tool: ['⚙', '*'],
  subagent: ['↳', '\\'],
  mail: ['✉', '@'],
  prompt: ['▶', '>'],
  assistant: ['◀', '<'],
  in: ['←', '<'],
  out: ['→', '>'],
  // agent status
  starting: ['◌', '.'],
  idle: ['○', 'o'],
  working: ['●', '*'],
  waiting: ['◐', '~'],
  error: ['✕', 'x'],
  stopped: ['■', '#'],
  dormant: ['◦', '.'],
  // main tabs
  teams: ['▦', '#'],
  roles: ['◉', '@'],
  office: ['⌂', 'H'],
  terminals: ['▤', '='],
  // drawing
  hLine: ['─', '-'],
  vLine: ['│', '|'],
  vThumb: ['┃', '#'],
  cornerL: ['╯', '-'],
  cornerR: ['╰', '-'],
  block: ['█', '#'],
} as const satisfies Record<string, readonly [string, string]>;

export type GlyphName = keyof typeof MAP;

export function glyphs(ascii = asciiMode()): Record<GlyphName, string> {
  return Object.fromEntries(Object.entries(MAP).map(([k, v]) => [k, v[ascii ? 1 : 0]])) as Record<GlyphName, string>;
}

export const ASCII = asciiMode();
/** Glyph table for the current terminal: `g.add`, `g.copy`, `g.star`… */
export const g = glyphs(ASCII);

/** Box border style that the current terminal can draw. */
export const border = (style: 'round' | 'bold' | 'single' | 'double' = 'round'): 'round' | 'bold' | 'single' | 'double' | 'classic' => (ASCII ? 'classic' : style);

// Symbols that may appear in user data (team/role icons) and their replacements.
const SUBST: Record<string, readonly [string, string]> = {
  '＋': ['+', '+'],
  '⚡': ['↯', '!'],
  '⤷': ['↳', '\\'],
  '⧉': ['❐', 'cp'],
  '⇣': ['↓', 'v'],
  '⌨': ['❯', '>'],
  '◷': ['↺', '@'],
  '⇥': ['→', '->'],
  '♛': ['◆', '*'],
  '♜': ['▣', '#'],
  '⚑': ['▴', '^'],
  '☂': ['◒', 'u'],
  '⚠': ['⚠', '!'],
  '⚙': ['⚙', '*'],
};

/**
 * Makes a free-form icon/label safe to draw: swaps the problematic symbols above
 * and, in ASCII mode, replaces any other non-ASCII symbol with "*".
 * Letters (including accented ones) are kept.
 */
export function safeText(text: string, ascii = ASCII): string {
  let out = '';
  for (const ch of text) {
    const sub = SUBST[ch];
    if (sub) out += sub[ascii ? 1 : 0];
    else if (ascii && ch.codePointAt(0)! > 0x7f && !/\p{L}/u.test(ch)) out += '*';
    else out += ch;
  }
  return out;
}
