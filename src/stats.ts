import { readRunEvents } from './store.ts';
import { runTokenCost, type TokenType } from './tokens.ts';
import type { RunMeta } from './types.ts';

/** Where a run's tokens went, from the agents' transcripts and the run's events. */
export type RunStats = {
  /** Weighted cost, in input-token equivalents (COST_WEIGHTS). */
  cost: number;
  perAgent: { id: string; cost: number; share: number }[];
  byType: Record<TokenType, { tokens: number; cost: number; share: number }>;
  /** Cache reads over everything read as input (0..1); null without any request. */
  cacheHit: number | null;
  /** Sessions started after the first one: light resumes and /clear. */
  restarts: number;
  messages: number;
  notes: number;
};

export function runStats(meta: RunMeta): RunStats {
  const c = runTokenCost(meta);
  const share = (x: number) => (c.total ? x / c.total : 0);
  const byType = Object.fromEntries(
    (Object.keys(c.byType) as TokenType[]).map((k) => [k, { ...c.byType[k], share: share(c.byType[k].cost) }]),
  ) as RunStats['byType'];
  const input = c.byType.input.tokens + c.byType.cacheWrite.tokens + c.byType.cacheRead.tokens;
  const events = readRunEvents(meta.dir, meta.runId, ['message', 'note']);
  return {
    cost: c.total,
    perAgent: Object.entries(c.perAgent).map(([id, cost]) => ({ id, cost, share: share(cost) })).sort((a, b) => b.cost - a.cost),
    byType,
    cacheHit: input ? c.byType.cacheRead.tokens / input : null,
    restarts: meta.agents.reduce((n, a) => n + (a.prevSessionIds?.length ?? 0), 0),
    messages: events.filter((e) => e.kind === 'message').length,
    notes: events.filter((e) => e.kind === 'note').length,
  };
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Plain-text report for `orq stats`, with the hints that follow from the numbers. */
export function formatStats(meta: RunMeta, s: RunStats): string {
  const out = [`Run ${meta.runId}${meta.title ? ` · ${meta.title}` : ''}`, `Coste ponderado: ${k(s.cost)} tokens-entrada equivalentes`, ''];
  out.push('Por tipo de token (tokens · coste · % del coste):');
  const label: Record<TokenType, string> = { input: 'entrada nueva', cacheWrite: 'escritura de caché', cacheRead: 'lectura de caché', output: 'salida' };
  for (const t of Object.keys(label) as TokenType[]) out.push(`  ${label[t].padEnd(19)} ${k(s.byType[t].tokens).padStart(7)} · ${k(s.byType[t].cost).padStart(7)} · ${pct(s.byType[t].share)}`);
  out.push('', 'Por agente:');
  for (const a of s.perAgent) out.push(`  ${a.id.padEnd(20)} ${k(a.cost).padStart(7)} · ${pct(a.share)}`);
  out.push('', `Acierto de caché: ${s.cacheHit === null ? '—' : pct(s.cacheHit)} · reinicios de sesión: ${s.restarts} · mensajes: ${s.messages} · notas: ${s.notes}`);
  const hints: string[] = [];
  if (s.byType.cacheWrite.share > 0.4) hints.push('Más del 40% del coste son escrituras de caché: hay muchas reanudaciones/limpiezas o agentes inactivos pasado el TTL.');
  if (s.cacheHit !== null && s.cacheHit < 0.7) hints.push('Acierto de caché bajo (<70%): las sesiones se reinician o enfrían a menudo.');
  const top = s.perAgent[0];
  if (top && s.perAgent.length > 2 && top.share > 0.5) hints.push(`\`${top.id}\` concentra más de la mitad del coste: revisa su rol (modelo, tools) o reparte su trabajo.`);
  if (s.restarts > 0 && s.notes === 0) hints.push('Hubo reinicios y ningún agente usó `memory save`: el resumen solo se apoya en heurísticas.');
  if (hints.length) out.push('', 'Pistas:', ...hints.map((h) => `  - ${h}`));
  return out.join('\n');
}
