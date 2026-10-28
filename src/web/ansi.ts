/** Minimal ANSI SGR parser for tmux `capture-pane -e` rows: styled runs, no dependencies. */
export type Run = { text: string; style?: Record<string, string> };

const BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5'];
const BRIGHT = ['#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

/** xterm 256-colour palette entry as a CSS colour. */
export function color256(n: number): string {
  if (n < 8) return BASIC[n]!;
  if (n < 16) return BRIGHT[n - 8]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const lv = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${lv(Math.floor(c / 36))},${lv(Math.floor(c / 6) % 6)},${lv(c % 6)})`;
}

type State = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean };

function apply(st: State, params: number[]): State {
  const s = { ...st };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) return apply({}, params.slice(i + 1));
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) (s.bold = false), (s.dim = false);
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p >= 30 && p <= 37) s.fg = BASIC[p - 30];
    else if (p >= 90 && p <= 97) s.fg = BRIGHT[p - 90];
    else if (p >= 40 && p <= 47) s.bg = BASIC[p - 40];
    else if (p >= 100 && p <= 107) s.bg = BRIGHT[p - 100];
    else if (p === 39) s.fg = undefined;
    else if (p === 49) s.bg = undefined;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5 && params[i + 2] !== undefined) (s[key] = color256(params[i + 2]!)), (i += 2);
      else if (params[i + 1] === 2 && params[i + 4] !== undefined) (s[key] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`), (i += 4);
    }
  }
  return s;
}

const toStyle = (st: State): Run['style'] => {
  const [fg, bg] = st.inverse ? [st.bg ?? '#1e1e1e', st.fg ?? '#e5e5e5'] : [st.fg, st.bg];
  const style: Record<string, string> = {};
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (st.bold) style.fontWeight = '700';
  if (st.dim) style.opacity = '0.6';
  if (st.italic) style.fontStyle = 'italic';
  if (st.underline) style.textDecoration = 'underline';
  return Object.keys(style).length ? style : undefined;
};

/** One captured row → runs of text with a style; other escape sequences are dropped. */
export function parseAnsi(line: string): Run[] {
  const runs: Run[] = [];
  let st: State = {};
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ text: buf, style: toStyle(st) }), (buf = '');
  };
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const m = /^\x1b\[([0-?]*)[ -\/]*([@-~])/.exec(line.slice(i, i + 40));
      if (m) {
        if (m[2] === 'm') {
          flush();
          st = apply(st, m[1] ? m[1].split(/[;:]/).map((x) => Number(x) || 0) : [0]);
        }
        i += m[0].length;
        continue;
      }
      // Non-CSI escape (OSC etc.): skip it up to the terminator.
      const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(line.slice(i));
      i += osc ? osc[0].length : 1;
      continue;
    }
    buf += line[i++];
  }
  flush();
  return runs;
}
