// Small per-user UI choices remembered across sessions (~/.orq/ui.json): the last resume
// mode and the last cost profile. Best effort: a missing or broken file means defaults.
import fs from 'node:fs';
import path from 'node:path';
import { ORQ_HOME } from '../paths.ts';
import type { CostProfile, ResumeMode } from '../types.ts';

export type Prefs = { resumeMode?: ResumeMode; profile?: CostProfile; /** '' = each role's own provider */ provider?: string };

export const prefsFile = () => path.join(ORQ_HOME, 'ui.json');

const PROFILES: CostProfile[] = ['saver', 'balanced', 'max'];
const RESUME_MODES: ResumeMode[] = ['light', 'full'];

/** Saved choices; anything unknown (hand-edited, older versions) is dropped. */
export function loadPrefs(file = prefsFile()): Prefs {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return {};
    const out: Prefs = {};
    if (PROFILES.includes(data.profile)) out.profile = data.profile;
    if (typeof data.provider === 'string') out.provider = data.provider;
    if (RESUME_MODES.includes(data.resumeMode)) out.resumeMode = data.resumeMode;
    return out;
  } catch {
    return {};
  }
}

export function savePrefs(patch: Prefs, file = prefsFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic: a crash never leaves a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...loadPrefs(file), ...patch }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* preferences are best effort */
  }
}

/** "≈ 3 k" / "≈ 1,2 M" token counts for estimates. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} M`;
  if (n >= 1000) return `${Math.round(n / 1000)} k`;
  return String(Math.max(0, Math.round(n)));
}

/** "12 min", "3 h", "2 días": how long ago a session's last request was. */
export function ageText(ms: number): string {
  // floor: «59 min» until a full hour has passed (a warm cache never reads as «1 h»).
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} días`;
}

/** Why the resume dialog recommends a mode (from estimateResume's `reason`). */
export function resumeAdvice(reason: { kind: 'warm' | 'cold' | 'unknown'; maxAgeMs?: number }): string {
  if (reason.kind === 'unknown' || reason.maxAgeMs === undefined) return 'Sin datos de antigüedad: Ligera es la opción segura';
  const ago = `Sesión de hace ${ageText(reason.maxAgeMs)}`;
  return reason.kind === 'warm' ? `${ago}: la caché sigue activa, Completa sale más barata` : `${ago}: Ligera es más barata`;
}

/** One pending deferred call (setTimeout 0) that can be cancelled: a newer `run` or `cancel` drops the previous one. */
export function deferred() {
  let id: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (id) clearTimeout(id);
    id = null;
  };
  return {
    run(fn: () => void) {
      cancel();
      id = setTimeout(() => ((id = null), fn()), 0);
    },
    cancel,
    get pending() {
      return id !== null;
    },
  };
}
