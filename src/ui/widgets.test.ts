import { describe, expect, test } from 'bun:test';
import { g } from './glyphs.ts';
import { TAB_PAD, backButtonWidth, buttonWidth, fieldWindow, launchButtonsHeight, layoutTabs, toggleWidth, type TabSpec } from './widgets.tsx';

const TABS: TabSpec<string>[] = [
  { id: 'teams', label: '▦ Equipos' },
  { id: 'roles', label: '◉ Roles' },
  { id: 'office', label: '⌂ Oficina', badge: '2/5' },
  { id: 'terminals', label: '▤ Terminales', badge: '5' },
  { id: 'messages', label: '✉ Mensajes' },
  { id: 'sessions', label: '◷ Sesiones', badge: '1 vivas' },
];
const total = (l: ReturnType<typeof layoutTabs>) => 1 + l.tabs.reduce((a, t) => a + t.width, 0);

describe('buttonWidth', () => {
  test('sm (default) = label + 2 padding + 1 margin', () => expect(buttonWidth('Salir')).toBe(8));
  test('secondary sm adds the brackets', () => expect(buttonWidth('Salir', 'sm', false, 'secondary')).toBe(10));
  test('md = label + 2 border + 4 padding + 1 margin', () => expect(buttonWidth('Salir', 'md')).toBe(12));
  test('compact md trims padding to 1', () => expect(buttonWidth('Salir', 'md', true)).toBe(10));
  test('tertiary and danger sm are framed like secondary; solid danger is not', () => {
    expect(buttonWidth('Salir', 'sm', false, 'tertiary')).toBe(10);
    expect(buttonWidth('✕ Quitar', 'sm', false, 'danger')).toBe(13);
    expect(buttonWidth('Borrar', 'sm', false, 'danger', true)).toBe(9);
  });
  test('toggle = brackets + " ● label " per option + separators (+ " hint")', () => {
    expect(toggleWidth(['Auto', 'YOLO'])).toBe(19);
    expect(toggleWidth(['Tarjetas', 'Lista'], 'v')).toBe(2 + 12 + 9 + 1 + 2);
  });
  test('back button = "[ ← Volver  Esc ]" + margin', () => expect(backButtonWidth()).toBe(`[ ${g.back} Volver  Esc ]`.length + 1));
});

describe('layoutTabs', () => {
  test('wide: full labels and right side', () => {
    const l = layoutTabs(TABS, 160, 40);
    expect(l.mode).toBe('full');
    expect(l.showRight).toBe(true);
    expect(l.tabs[2]).toMatchObject({ label: '⌂ Oficina', badge: ' 2/5', width: 4 + 9 + 4 });
  });

  test('right is hidden first when it does not fit', () => {
    const l = layoutTabs(TABS, 100, 40);
    expect(l.mode).toBe('full');
    expect(l.showRight).toBe(false);
    expect(total(l)).toBeLessThanOrEqual(100);
  });

  test('then compact: icon + badge', () => {
    const l = layoutTabs(TABS, 60);
    expect(l.mode).toBe('compact');
    expect(l.tabs.map((t) => t.label + t.badge)).toEqual(['▦', '◉', '⌂ 2/5', '▤ 5', '✉', '◷ 1 vivas']);
    expect(total(l)).toBeLessThanOrEqual(60);
  });

  test('explicit short label wins in compact mode', () => {
    const l = layoutTabs([{ id: 'a', label: 'Producto y diseño', short: 'Prod' }, ...TABS], 70);
    expect(l.tabs[0]!.label).toBe('Prod');
  });

  test('one-row tabs use padding + separator', () => {
    const l = layoutTabs(TABS, 160, 0, TAB_PAD.row);
    expect(l.tabs[0]!.width).toBe('▦ Equipos'.length + 3);
  });

  test('then truncated, and every width matches its text', () => {
    const l = layoutTabs(TABS, 40);
    expect(l.mode).toBe('truncated');
    expect(total(l)).toBeLessThanOrEqual(40);
    for (const t of l.tabs) expect(t.width).toBe(t.label.length + t.badge.length + 4);
  });
});

describe('fieldWindow', () => {
  const join = (w: ReturnType<typeof fieldWindow>) => w.before + w.at + w.after;

  test('short value is padded and cursor sits after it', () => {
    const w = fieldWindow('abc', 3, 6);
    expect(w).toEqual({ before: 'abc', at: ' ', after: '  ' });
  });

  test('cursor in the middle selects that character', () => {
    expect(fieldWindow('abcdef', 2, 10)).toMatchObject({ before: 'ab', at: 'c' });
  });

  test('long value scrolls to keep the cursor visible and marks hidden text', () => {
    const w = fieldWindow('0123456789', 10, 5);
    expect(join(w)).toBe('…789 ');
    expect(w.at).toBe(' ');
  });

  test('cursor at the start of a long value shows its head', () => {
    expect(join(fieldWindow('0123456789', 0, 5))).toBe('01234');
  });
});

describe('launchButtonsHeight', () => {
  test('inline is one row', () => expect(launchButtonsHeight({ inline: true, confirming: true })).toBe(1));
  test('launch: counter + toggle + button + help', () => expect(launchButtonsHeight()).toBe(4));
  test('launch confirming: room for question, 2 consequences and buttons', () => expect(launchButtonsHeight({ confirming: true })).toBe(6));
  test('collapsed: summary row + button, 5 rows while confirming', () => {
    expect(launchButtonsHeight({ profile: true, collapsed: true })).toBe(2);
    expect(launchButtonsHeight({ profile: true, collapsed: true, confirming: true })).toBe(5);
  });
  test('collapsed does not change an open session', () => expect(launchButtonsHeight({ running: true, collapsed: true })).toBe(1));
  test('session open: one button, 3 rows while confirming', () => {
    expect(launchButtonsHeight({ running: true })).toBe(1);
    expect(launchButtonsHeight({ running: true, confirming: true })).toBe(3);
  });
});

import { render } from 'ink';
import { PassThrough } from 'node:stream';
import React from 'react';
import { setLiveReducedMotion } from './theme.ts';
import { useFlash } from './widgets.tsx';

describe('press flash', () => {
  function Probe({ seen }: { seen: boolean[] }) {
    const f = useFlash(1000);
    React.useEffect(() => f.fire(), []);
    seen.push(f.on);
    return null;
  }
  const mount = (seen: boolean[]) => {
    const io = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    return render(React.createElement(Probe, { seen }), { stdin: io as never, stdout: io as never, exitOnCtrlC: false, patchConsole: false });
  };
  test('follows the live reduced-motion switch (m), not only the environment', async () => {
    setLiveReducedMotion(false);
    const on: boolean[] = [];
    let i = mount(on);
    await new Promise((r) => setTimeout(r, 30));
    expect(on.includes(true)).toBe(true);
    i.unmount();
    setLiveReducedMotion(true);
    const off: boolean[] = [];
    i = mount(off);
    await new Promise((r) => setTimeout(r, 30));
    expect(off.includes(true)).toBe(false);
    i.unmount();
    setLiveReducedMotion(false);
  });
});
