#!/usr/bin/env bun
import { render } from 'ink';
import React from 'react';
import { importPack } from './library.ts';
import { PROJECT_DIR, ensureHome } from './paths.ts';
import { findRun, listRuns, loadRun } from './runs.ts';
import { formatStats, runStats } from './stats.ts';
import { searchProject } from './store.ts';
import { App } from './ui/App.tsx';
import { setRedrawHook } from './ui/app-context.tsx';
import { DISABLE_MOUSE } from './ui/mouse.tsx';

const [cmd, ...rest] = process.argv.slice(2);

ensureHome();

if (cmd === 'import') {
  // orq import <dir | host:/dir> [pack-name]
  if (!rest[0]) {
    console.error('Usage: orq import <dir | host:/dir> [pack-name]');
    process.exit(1);
  }
  const r = await importPack(rest[0], rest[1]);
  console.log(`Pack "${r.pack}": ${r.imported.length} roles → ${r.imported.join(', ')}`);
  process.exit(0);
}

if (cmd === 'search') {
  // orq search <words>: messages and notes of every past run in this directory
  const query = rest.join(' ');
  if (!query.trim()) {
    console.error('Usage: orq search <words>');
    process.exit(1);
  }
  const hits = searchProject(PROJECT_DIR, query);
  if (!hits.length) console.log('Sin resultados.');
  for (const h of hits) console.log(`${new Date(h.ts).toLocaleString('es-ES', { hour12: false })} · ${h.run} · ${h.agent} [${h.kind}]\n  ${h.text.replace(/\s+/g, ' ')}`);
  process.exit(0);
}

if (cmd === 'stats') {
  // orq stats [runId | --last]: where the tokens of a run went
  const arg = rest[0];
  const run = !arg || arg === '--last' ? listRuns(PROJECT_DIR)[0] : findRun(arg);
  if (!run?.exists) {
    console.error(arg && arg !== '--last' ? `No existe la sesión ${arg}.` : 'No hay sesiones en este directorio.');
    process.exit(1);
  }
  const meta = loadRun(run.dir);
  console.log(formatStats(meta, runStats(meta)));
  process.exit(0);
}

// `claude` (or opencode / an API key) is checked per provider when launching (providers.ts launchIssue).
for (const bin of ['tmux']) {
  if (!Bun.which(bin)) {
    console.error(`orq needs \`${bin}\` in PATH.`);
    process.exit(1);
  }
}

// orq web [--port N]: the same office in the browser (local only), see src/web/
if (cmd === 'web') {
  const i = rest.indexOf('--port');
  const port = i >= 0 ? Number(rest[i + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Usage: orq web [--port N]');
    process.exit(1);
  }
  const { startWeb } = await import('./web/server.ts');
  const web = await startWeb({ port }).catch((e: Error) => {
    console.error(`No pude abrir el servidor web${port ? ` en el puerto ${port}` : ''}: ${e.message}`);
    process.exit(1);
  });
  console.log(`orq web → ${web.url}\nCtrl+C para cerrar (los agentes siguen en tmux).`);
  // Like quitting the TUI: the agents keep running in tmux and the run can be reattached.
  const bye = () => (web.session.hq?.detach(), web.stop(), process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  await new Promise(() => {});
}

// orq --resume            → open the Sessions tab for this directory
// orq --resume <runId>    → resume / reattach that run directly
// orq --resume --last     → resume the most recent run of this directory
let initialTab: 'teams' | 'sessions' = 'teams';
let resumeDir: string | undefined;
if (cmd === '--resume' || cmd === '-r') {
  initialTab = 'sessions';
  const arg = rest[0];
  if (arg) {
    const run = arg === '--last' ? listRuns(PROJECT_DIR)[0] : findRun(arg);
    if (!run) {
      console.error(arg === '--last' ? 'No hay sesiones en este directorio.' : `No existe la sesión ${arg}. Usa \`orq --resume\` para verlas.`);
      process.exit(1);
    }
    resumeDir = run.dir;
  }
} else if (cmd === '--help' || cmd === '-h') {
  console.log(`orq — empresa de agentes Claude en tmux

  orq                      abre la interfaz en el directorio actual
  orq --resume             lista las sesiones (este directorio / todos)
  orq --resume <runId>     reanuda o reconecta una sesión
  orq --resume --last      reanuda la última sesión de este directorio
  orq web [--port N]       la misma interfaz en el navegador (solo local)
  orq search <palabras>    busca en mensajes y notas de las sesiones de este directorio
  orq stats [runId|--last] en qué se fueron los tokens de una sesión
  orq import <dir|host:/dir> [pack]   importa agentes markdown como roles`);
  process.exit(0);
}

const instance = render(<App initialTab={initialTab} resumeDir={resumeDir} />, { alternateScreen: true, exitOnCtrlC: false, maxFps: 20 });
setRedrawHook(() => instance.clear());
process.on('exit', () => process.stdout.write(DISABLE_MOUSE));
await instance.waitUntilExit();
process.exit(0);
