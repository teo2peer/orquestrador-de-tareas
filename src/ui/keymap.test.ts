import { describe, expect, test } from 'bun:test';
import { g } from './glyphs.ts';
import { FOOTER, FOOTER_MAX, accessKey, cycleZone, footerParts, footerText, helpLines, keyNames, moveIndex } from './keymap.tsx';

const dots = (s: string) => s.replaceAll('·', g.sep);
const line = (...args: Parameters<typeof footerParts>) => footerText(footerParts(...args));

describe('keyNames', () => {
  test('macOS Option+letter without Meta answers to its Alt shortcut', () => {
    expect(keyNames('ß', {}, false)).toEqual(['alt+s', 'ß']);
    expect(keyNames('å', {})).toEqual(['alt+a', 'å']);
    expect(keyNames('®', {})).toEqual(['alt+r', '®']);
  });
  test('arrows, enter, esc, shift+tab, delete', () => {
    expect(keyNames('', { upArrow: true })).toEqual(['up']);
    expect(keyNames('\r', { return: true })).toEqual(['enter']);
    expect(keyNames('', { escape: true })).toEqual(['esc']);
    expect(keyNames('', { tab: true, shift: true })).toEqual(['shift+tab']);
    expect(keyNames('', { backspace: true })).toEqual(['delete', 'backspace']);
  });

  test('letters are case-insensitive; j/k also move', () => {
    expect(keyNames('L', {})).toEqual(['l']);
    expect(keyNames('j', {})).toEqual(['j', 'down']);
    expect(keyNames(' ', {})).toEqual(['space']);
    expect(keyNames('s', { ctrl: true })).toEqual(['ctrl+s']);
    expect(keyNames('1', { meta: true })).toEqual(['alt+1', '1']);
  });

  test('ORQ_SINGLE_KEY=0: plain characters stop being shortcuts, Alt+key still works', () => {
    expect(keyNames('l', {}, false)).toEqual([]);
    expect(keyNames('l', { meta: true }, false)).toEqual(['alt+l', 'l']);
    expect(keyNames('', { upArrow: true }, false)).toEqual(['up']);
  });
});

test('accessKey reads the bracketed letter', () => {
  expect(accessKey('[B]orrar «Diseño»')).toBe('b');
  expect(accessKey('Lanzar 12 agentes (↵)')).toBeUndefined();
});

describe('footer', () => {
  test('matches the approved copy', () => {
    expect(line('teams.grid', 'nav', { width: 120 })).toBe(dots('[NAVEGAR] ←↑↓→ mover · ↵ detalle · l lanzar · n nuevo · e editar · ? ayuda'));
    expect(line('mouse', 'nav', { width: 120 })).toBe(dots('[NAVEGAR] clic y rueda · ⌥S copiar texto · 1-6 pestañas · q salir · ? ayuda'));
    expect(line('terminal', 'terminal', { width: 120, exitLabel: 'Ctrl+]' })).toBe(dots('[TERMINAL] lo que escribes va al agente · Ctrl+] salir'));
    expect(line('confirm', 'modal', { width: 120 })).toBe(dots('[CONFIRMAR] letra entre [ ] · ←→ ↵ elegir · Esc cancelar'));
    expect(line('confirm.launch', 'modal', { width: 120 })).toBe(dots('[CONFIRMAR] ←→ elegir · ↵ pulsar · Esc cancelar'));
    expect(line('form.field', 'text', { width: 120 })).toBe(dots('[TEXTO] Tab/⇧Tab campo · Ctrl+S guardar · Esc salir del campo'));
    expect(line('roles.selection', 'nav', { width: 120, vars: { n: 3 } })).toBe(dots('[NAVEGAR] Selección 3 · l lanzar · x limpiar · Espacio añadir · ? ayuda'));
  });

  test('every context fits in 78 columns', () => {
    for (const ctx of Object.keys(FOOTER) as (keyof typeof FOOTER)[]) {
      const text = line(ctx, FOOTER[ctx].mode, { width: 200, vars: { n: 99 } });
      expect([ctx, [...text].length <= FOOTER_MAX]).toEqual([ctx, true]);
    }
  });

  test('narrow: drops items from the right, keeps badge and tail', () => {
    const text = line('teams.grid', 'nav', { width: 40 });
    expect(text.startsWith('[NAVEGAR]')).toBe(true);
    expect(text.endsWith('? ayuda')).toBe(true);
    expect([...text].length).toBeLessThanOrEqual(40);
  });

  test('pending permissions show in any mode; a toast keeps the badge', () => {
    expect(line('composer', 'text', { width: 120, permissions: 2 })).toContain(`${g.warning} 2 permisos pendientes`);
    expect(line('teams.grid', 'nav', { width: 120, toast: 'Guardado' })).toBe('[NAVEGAR] Guardado');
  });

  test('ORQ_SINGLE_KEY=0 shows Alt+key', () => {
    expect(line('teams.grid', 'nav', { width: 120, singleKey: false })).toContain('Alt+l lanzar');
  });

  test('a footer for another mode is not shown', () => {
    expect(line('teams.grid', 'text', { width: 120 })).toBe('[TEXTO] Esc salir');
  });
});

describe('navigation helpers', () => {
  test('cycleZone wraps both ways', () => {
    const z = ['tabs', 'grid', 'panel'];
    expect(cycleZone(z, 'panel', 1)).toBe('tabs');
    expect(cycleZone(z, 'tabs', -1)).toBe('panel');
    expect(cycleZone(z, 'nope', 1)).toBe('tabs');
  });

  test('moveIndex in a 3-wide grid of 7', () => {
    expect(moveIndex(0, 7, 3, 'down')).toBe(3);
    expect(moveIndex(5, 7, 3, 'down')).toBe(5);
    expect(moveIndex(4, 7, 3, 'up')).toBe(1);
    expect(moveIndex(6, 7, 3, 'right')).toBe(6);
    expect(moveIndex(3, 7, 3, 'end')).toBe(6);
    expect(moveIndex(9, 7, 3, 'none')).toBe(6);
  });
});

describe('help overlay', () => {
  test('current tab first, then Global and Modos; exit label filled in', () => {
    const lines = helpLines('office', { width: 60, exitLabel: 'Ctrl+]' });
    const titles = lines.filter((l) => l.kind === 'title').map((l) => l.text);
    expect(titles.slice(0, 3)).toEqual(['Oficina', 'Global', 'Modos (insignia del pie)']);
    expect(titles.at(-1)).toBe('Confirmar');
    expect(lines.some((l) => l.text.includes('{exit}'))).toBe(false);
    expect(lines.every((l) => (l.key ?? '').length + l.text.length <= 60 + 14)).toBe(true);
  });
});

// ------------------------------------------------------------ provider (rendered)

import { render } from 'ink';
import { PassThrough } from 'node:stream';
import React from 'react';
import { KeymapProvider, MODAL_GUARD_MS, Overlays, useConfirmLeave, useFocusState, useInteract, useLeave, useModal, useMode, useShortcuts } from './keymap.tsx';

const h = React.createElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(el: React.ReactElement) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  stdout.resume();
  const inst = render(el, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false });
  const press = async (s: string, wait = 40) => (stdin.write(s), await sleep(wait));
  return { press, unmount: () => inst.unmount() };
}

type Probe = { log: string[]; toasts: string[]; mode?: string; leave?: (then: () => void) => void };

function Harness({ p, interact = false, dirty = false }: { p: Probe; interact?: boolean; dirty?: boolean }) {
  const { setFocused } = useFocusState();
  const modal = useModal();
  p.mode = useMode();
  p.leave = useLeave();
  useInteract(interact);
  useConfirmLeave(dirty, { name: 'Diseño', onDiscard: () => p.log.push('discard') });
  useShortcuts('test', [
    { keys: ['x'], run: () => p.log.push('x') },
    { keys: ['esc'], run: () => p.log.push('esc') },
    { keys: ['ctrl+q'], run: () => p.log.push('quit'), modes: ['nav', 'text'] },
    { keys: ['/'], run: () => setFocused('field') },
    { keys: ['b'], run: () => modal.open({ title: 'Borrar', actions: [{ label: '[B]orrar', run: () => p.log.push('deleted') }], onCancel: () => p.log.push('cancel') }) },
    { keys: ['d'], run: () => modal.open({ title: 'Borrar', actions: [{ label: '[B]orrar', run: () => p.log.push('deleted') }], onCancel: () => p.log.push('cancel') }) },
  ]);
  return null;
}

const app = (p: Probe, props: { interact?: boolean; dirty?: boolean } = {}) =>
  h(KeymapProvider, { onToast: (t: string) => p.toasts.push(t), children: [h(Harness, { key: 'h', p, ...props }), h(Overlays, { key: 'o', width: 80, height: 24, tab: 'teams' })] });

describe('KeymapProvider', () => {
  test('layers: NAVEGAR runs shortcuts; TEXTO only text-mode ones; TERMINAL none', async () => {
    const p: Probe = { log: [], toasts: [] };
    const t = mount(app(p));
    await t.press('x');
    expect(p.log).toEqual(['x']);
    await t.press('/');
    expect(p.mode).toBe('text');
    await t.press('x');
    await t.press('\x11'); // Ctrl+Q
    expect(p.log).toEqual(['x', 'quit']);
    t.unmount();

    const q: Probe = { log: [], toasts: [] };
    const u = mount(app(q, { interact: true }));
    await sleep(20);
    expect(q.mode).toBe('terminal');
    await u.press('x');
    await u.press('\x1b', 120);
    expect(q.log).toEqual([]);
    u.unmount();
  });

  test('modal: input ignored for 300 ms, focus starts on Cancel, opener key is not an access key', async () => {
    const p: Probe = { log: [], toasts: [] };
    const t = mount(app(p));
    await t.press('b', 10);
    expect(p.mode).toBe('modal');
    await t.press('\r', 10); // too soon: ignored
    await t.press('x', 10); // other layers are blocked
    expect(p.log).toEqual([]);
    await sleep(MODAL_GUARD_MS);
    await t.press('b'); // opened with "b": never presses [B]orrar
    expect(p.log).toEqual([]);
    await t.press('\r'); // Cancel has the focus
    expect(p.log).toEqual(['cancel']);

    await t.press('d', MODAL_GUARD_MS + 20);
    await t.press('b'); // opened with "d": [B] works
    expect(p.log).toEqual(['cancel', 'deleted']);
    t.unmount();
  });

  test('modal: ← then ↵ in one chunk presses the action', async () => {
    const p: Probe = { log: [], toasts: [] };
    const t = mount(app(p));
    await t.press('d', MODAL_GUARD_MS + 20);
    await t.press('\x1b[D\r');
    expect(p.log).toEqual(['deleted']);
    t.unmount();
  });

  test('paste in NAVEGAR is dropped with a toast, never run as shortcuts', async () => {
    const p: Probe = { log: [], toasts: [] };
    const t = mount(app(p));
    await t.press('\x1b[200~xxb\x1b[201~');
    expect(p.log).toEqual([]);
    expect(p.mode).toBe('nav');
    expect(p.toasts).toEqual(['Pegado ignorado · i para escribir']);
    t.unmount();
  });

  test('leaving with unsaved changes asks first', async () => {
    const p: Probe = { log: [], toasts: [] };
    const t = mount(app(p, { dirty: true }));
    p.leave!(() => p.log.push('left'));
    await sleep(MODAL_GUARD_MS + 20);
    expect(p.mode).toBe('modal');
    await t.press('d'); // [D]escartar
    expect(p.log).toEqual(['discard', 'left']);
    t.unmount();

    const q: Probe = { log: [], toasts: [] };
    const u = mount(app(q));
    q.leave!(() => q.log.push('left'));
    expect(q.log).toEqual(['left']);
    u.unmount();
  });
});

import { Modal } from './keymap.tsx';
import { TextField } from './widgets.tsx';

describe('<Modal>', () => {
  function Reply({ p, log }: { p: Probe; log: string[] }) {
    const [text, setText] = React.useState('');
    const [open, setOpen] = React.useState(true);
    p.mode = useMode();
    (p as Probe & { text?: string }).text = text;
    return open
      ? h(Modal, {
          title: 'Responder',
          width: 80,
          height: 24,
          lines: ['¿Puedo borrar la rama?'],
          fields: ['reply'],
          initialFocus: 'reply',
          contentRows: 1,
          onClose: () => (log.push('close'), setOpen(false)),
          actions: [
            { label: '[S]í', run: () => log.push('yes') },
            { label: '[E]nviar', run: () => log.push(`send:${text}`) },
          ],
          children: h(TextField, { id: 'reply', value: text, onChange: setText, width: 30 }),
        })
      : null;
  }

  test('initial focus on a field: ↵ edits, Esc leaves the field, Esc again closes', async () => {
    const p: Probe = { log: [], toasts: [] };
    const log: string[] = [];
    const t = mount(h(KeymapProvider, { children: h(Reply, { p, log }) }));
    await sleep(MODAL_GUARD_MS + 20);
    expect(p.mode).toBe('modal');
    await t.press('\r');
    expect(p.mode).toBe('text');
    await t.press('hola');
    expect((p as Probe & { text?: string }).text).toBe('hola');
    await t.press('\x1b', 120); // leaves the field, modal stays
    expect(p.mode).toBe('modal');
    expect(log).toEqual([]);
    await t.press('e'); // [E]nviar
    expect(log).toEqual(['send:hola']);
    await t.press('\x1b', 120);
    expect(log).toEqual(['send:hola', 'close']);
    t.unmount();
  });
});

test('modalContentWidth leaves room for border and padding', async () => {
  const { modalContentWidth } = await import('./keymap.tsx');
  expect(modalContentWidth(80)).toBe(68);
  expect(modalContentWidth(50)).toBe(46);
});
