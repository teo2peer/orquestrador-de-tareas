import { describe, expect, test } from 'bun:test';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import React from 'react';
import { launchConfirm } from './app-context.tsx';
import { g } from './glyphs.ts';
import { MouseProvider } from './mouse.tsx';
import { LaunchButtons, launchStep } from './widgets.tsx';

describe('keyboard launch (l) uses the chosen permission mode', () => {
  test('Auto: plain confirmation; no «(↵)» because the focus starts on Cancelar', () => {
    expect(launchConfirm(3, 'auto', '/p')).toEqual({ title: '¿Lanzar 3 agentes en modo Auto?', lines: ['Directorio: /p'], action: 'Lanzar 3 agentes', variant: 'primary' });
  });
  test('YOLO and Auto + YOLO opcional ask exactly what the launch button asks', () => {
    for (const mode of ['yolo', 'auto-insecure'] as const) {
      const step = launchStep({ count: 2, mode });
      const c = launchConfirm(2, mode, '/p');
      expect(step.danger).toBe(true);
      expect(step.needsConfirm).toBe(true);
      expect(c).toEqual({ title: step.question, lines: ['Directorio: /p', ...step.consequences], action: step.action, variant: 'danger' });
    }
    expect(launchConfirm(2, 'yolo', '/p').title).toBe(`${g.warning} ¿Lanzar 2 agentes en YOLO?`);
    expect(launchConfirm(2, 'auto-insecure', '/p').title).toBe(`${g.warning} ¿Lanzar 2 agentes en modo Auto + YOLO opcional?`);
    expect(launchConfirm(2, 'auto-insecure', '/p').lines).toContain('Cada agente puede pasar a YOLO (sin confirmaciones) con Shift+Tab.');
  });
  test('Auto with few agents does not need the extra step; many agents do', () => {
    expect(launchStep({ count: 2, mode: 'auto' })).toMatchObject({ needsConfirm: false, danger: false });
    expect(launchStep({ count: 9, mode: 'auto' })).toMatchObject({ needsConfirm: true, danger: false });
  });
  test('adding to the open session does not talk about modes', () => {
    expect(launchConfirm(9, null, '/p')).toMatchObject({ title: '¿Añadir 9 agentes a la sesión?', variant: 'primary' });
    expect(launchConfirm(9, null, '/p').lines).toHaveLength(2);
  });
});

describe('<LaunchButtons> with Auto + YOLO opcional', () => {
  test('the first click asks (danger question) and does not launch', async () => {
    const launched: string[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(
      React.createElement(MouseProvider, {
        children: React.createElement(LaunchButtons, { count: 2, running: false, mode: 'auto-insecure', onLaunch: (m?: string) => launched.push(m ?? '') }),
      }),
      { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true },
    );
    await new Promise((r) => setTimeout(r, 50));
    // Rows: counter · toggle · [▶ Lanzar 2 agentes]: click its third cell (SGR, 1-based).
    stdin.write('\x1b[<0;4;3M');
    await new Promise((r) => setTimeout(r, 50));
    expect(launched).toEqual([]);
    const s = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    expect(s).toContain(`${g.warning} ¿Lanzar 2 agentes en modo Auto + YOLO opcional?`);
    expect(s).toContain('Cada agente puede pasar a YOLO (sin confirmaciones) con Shift+Tab.');
    inst.unmount();
  });
});

describe('<LaunchButtons> collapsed', () => {
  const draw = async (props: Record<string, unknown>) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const inst = render(React.createElement(MouseProvider, { children: React.createElement(LaunchButtons, { count: 2, running: false, onLaunch: () => {}, ...props } as never) }), {
      stdin: stdin as never,
      stdout: stdout as never,
      stderr: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    inst.unmount();
    return out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  };
  test('shows a one-line summary and hides the toggles', async () => {
    const s = await draw({ collapsed: true, onToggleOptions: () => {}, profile: 'max', onProfileChange: () => {}, provider: '', onProviderChange: () => {} });
    expect(s).toContain('Auto');
    expect(s).toContain('Opciones');
    expect(s).toContain('Lanzar 2 agentes');
    expect(s).not.toContain('Consumo:');
  });
  test('a risky mode stays visible in the summary', async () => {
    const s = await draw({ collapsed: true, mode: 'yolo', onToggleOptions: () => {}, profile: 'max', onProfileChange: () => {} });
    expect(s).toContain(`${g.warning} YOLO`);
  });
});
