import fs from 'node:fs';
import { CACHE_WRITE_1H, COST_WEIGHTS, TTL_1H, TTL_5M, lastUsage } from './tokens.ts';
import { readRunEvents } from './store.ts';
import * as tmux from './tmux.ts';
import type { RunMeta } from './types.ts';

/*
 * Light resume: instead of `claude --resume` (which reloads the whole transcript), an agent gets
 * a fresh session and a summary of where it left off, built from the run's events (no LLM).
 */

/** Budget of a summary, in characters (~3k tokens at ~4 chars/token). */
export const SUMMARY_MAX_CHARS = 12_000;
const RECENT = 15;
const MAX_MESSAGES = 8;
/** Older open tasks beyond this many are only counted (a newer task may well supersede them). */
const MAX_OPEN = 5;
const MAX_FILES = 25;
const MAX_NOTES = 20;
const MAX_TEAM = 20;
const EDIT_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit) (.+)$/;

const tokens = (chars: number) => Math.ceil(chars / 4);
const short = (s: string, n: number) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
const clock = (ts: number) => new Date(ts).toLocaleString('es-ES', { hour12: false });

/** Event kinds a summary reads. */
export const SUMMARY_KINDS = ['message', 'timeline', 'edit', 'note'] as const;

type Section = { title: string; lines: string[]; prio: number; keep: number };

/**
 * Summary of an agent's state in a previous run, to start a fresh session from. Deterministic and
 * at most SUMMARY_MAX_CHARS: when too long, the least important sections lose lines first
 * (timeline < files < recent messages < team < status/report < open work < latest goal).
 */
export function buildResumeSummary(agentId: string, events: Record<string, any>[], meta: RunMeta, skip: ReadonlySet<string> = new Set()): string {
  const agent = meta.agents.find((a) => a.id === agentId);
  const role = agent?.role;
  const timelineOf = (id: string) => events.filter((e) => e.kind === 'timeline' && e.agent === id);
  const timeline = timelineOf(agentId);
  // `skip`: undelivered messages that follow the summary in full (kept out of it to avoid duplicates).
  const messages = events.filter((e) => e.kind === 'message' && !skip.has(String(e.id)));
  const sent = messages.filter((m) => m.from === agentId);
  const received = messages.filter((m) => m.to === agentId);

  const lastStatus = timeline.filter((e) => e.tkind === 'status').at(-1);
  const lastReport = sent.filter((m) => m.type === 'report').at(-1);
  const lastDoneTs = sent.filter((m) => m.type === 'report' && String(m.body).startsWith('[done]')).at(-1)?.ts ?? 0;
  const tasks = received.filter((m) => m.type === 'task');
  const open = tasks.filter((m) => m.ts > lastDoneTs);
  const goal = open.at(-1) ?? tasks.at(-1);
  const lastSentTs = sent.at(-1)?.ts ?? 0;
  const unanswered = received
    .filter((m) => m.type !== 'task' && m.from !== 'system' && (m.ts > lastSentTs || (m.type === 'question' && !messages.some((x) => x.replyTo === m.id))))
    .slice(-MAX_MESSAGES);
  // Full paths come from 'edit' events; older runs only have the (truncated) timeline text.
  const edits = events.filter((e) => e.kind === 'edit' && e.agent === agentId).map((e) => String(e.file));
  const fromTimeline = () =>
    timeline
      .filter((e) => e.tkind === 'tool')
      .map((e) => EDIT_TOOL.exec(String(e.text))?.[2])
      .filter((f): f is string => !!f && !f.endsWith('…'));
  const files = [
    ...new Set((edits.length ? edits : fromTimeline()).map((f) => (meta.cwd && f.startsWith(meta.cwd + '/') ? f.slice(meta.cwd.length + 1) : f))),
  ].slice(-MAX_FILES);
  // Durable notes the agent saved with the `memory` tool: the one thing it chose to carry over.
  const notes = events.filter((e) => e.kind === 'note' && e.agent === agentId).slice(-MAX_NOTES);
  const msgLine = (m: Record<string, any>, n: number) => `- ${clock(m.ts)} [${m.type}] ${m.from} → ${m.to}: ${short(m.body, n)}`;

  const others = meta.agents.filter((a) => a.id !== agentId);
  const team = others
    .slice(0, MAX_TEAM)
    .map((a) => {
      const st = timelineOf(a.id).filter((e) => e.tkind === 'status').at(-1);
      const done = messages.filter((m) => m.from === a.id && m.type === 'report').at(-1);
      return `- \`${a.id}\` (${a.role?.title ?? a.title})${a.id === meta.lead ? ' [coordinator]' : ''}: ${st ? short(st.text, 60) : '—'}${done ? ` · last report: ${short(done.body, 70)}` : ''}`;
    });
  if (others.length > MAX_TEAM) team.push(`- +${others.length - MAX_TEAM} más (\`team\`)`);

  const you = [`${role?.title ?? agentId} (\`${agentId}\`)${agentId === meta.lead ? ' — coordinator of the team' : ''}`];
  if (skip.size) you.push(`${skip.size} message${skip.size === 1 ? '' : 's'} you never received follow${skip.size === 1 ? 's' : ''} this summary in full: handle ${skip.size === 1 ? 'it' : 'them'} too.`);
  if (role?.area?.paths.length) you.push(`OWNED PATHS: ${role.area.paths.map((p) => `\`${p}\``).join(', ')}`);

  const sections: Section[] = [
    { title: 'You', lines: you, prio: 0, keep: you.length },
    { title: open.length ? 'Latest goal (open task)' : 'Latest goal (last task, already reported done)', lines: goal ? [msgLine(goal, 2400)] : [], prio: 1, keep: 1 },
    {
      title: 'Open work: tasks not reported done and messages you may not have answered',
      lines: [
        ...(open.length - 1 > MAX_OPEN ? [`- +${open.length - 1 - MAX_OPEN} more older tasks without a done report (\`inbox\`/history if needed)`] : []),
        ...open.slice(0, -1).slice(-MAX_OPEN).map((m) => msgLine(m, 800)),
        ...unanswered.map((m) => msgLine(m, 600)),
      ],
      prio: 2,
      keep: 2,
    },
    { title: 'Your notes (facts you verified and saved with `memory`: trust them, do not re-read files only to confirm them)', lines: notes.map((n) => `- ${short(n.text, 400)}`), prio: 2, keep: 3 },
    {
      title: 'Your state',
      lines: [
        ...(lastStatus ? [`- last status: ${short(lastStatus.text, 200)}`] : []),
        ...(lastReport ? [`- last report to ${lastReport.to}: ${short(lastReport.body, 1200)}`] : []),
      ],
      prio: 3,
      keep: 1,
    },
    { title: 'Team (one line each)', lines: team, prio: 4, keep: team.length },
    { title: 'Recent messages', lines: [...sent, ...received].sort((a, b) => a.ts - b.ts).slice(-8).map((m) => msgLine(m, 300)), prio: 5, keep: 2 },
    { title: 'Files you edited', lines: files.map((f) => `- ${f}`), prio: 6, keep: 0 },
    {
      title: 'Recent activity',
      // Messages have their own sections (and skipped ones follow the summary): not repeated here.
      lines: timeline
        .filter((e) => e.tkind !== 'system' && e.tkind !== 'msg_in' && e.tkind !== 'msg_out')
        .slice(-RECENT)
        .map((e) => `- ${clock(e.ts)} [${e.tkind}] ${short(e.text, 300)}`),
      prio: 7,
      keep: 0,
    },
  ];
  const head = [
    `# Session resumed (light)`,
    `Your previous Claude session was not reloaded, to save tokens. Below is a summary of where you left off,`,
    `built from the company log of this run. Continue from here; use \`inbox\`, \`team\`, \`memory\` (search past messages and notes) and the files`,
    `on disk for anything else. Do not redo finished work.`,
  ].join('\n');
  const render = () =>
    [head, ...sections.filter((x) => x.lines.length).map((x) => `## ${x.title}\n${x.lines.join('\n')}`)].join('\n\n');

  let out = render();
  // 1) Drop the oldest lines of the least important sections, down to what each must keep.
  for (const sec of [...sections].sort((a, b) => b.prio - a.prio))
    while (out.length > SUMMARY_MAX_CHARS && sec.lines.length > sec.keep) {
      sec.lines.shift();
      out = render();
    }
  // 2) Shorten the kept lines, least important sections first.
  for (const len of [400, 200, 120])
    for (const sec of [...sections].sort((a, b) => b.prio - a.prio)) {
      if (out.length <= SUMMARY_MAX_CHARS) break;
      sec.lines = sec.lines.map((l) => short(l, len));
      out = render();
    }
  return out.length > SUMMARY_MAX_CHARS ? out.slice(0, SUMMARY_MAX_CHARS - 1) + '…' : out;
}

/** Whether a transcript's prompt cache is still warm (its last request is younger than the TTL). */
export function cacheWarm(transcript?: string, now = Date.now()): boolean {
  if (!transcript || !fs.existsSync(transcript)) return false;
  const last = lastUsage(transcript);
  return last?.at !== undefined && now - last.at < last.ttlMs;
}

/** Small fresh cache write a warm full resume still makes (the new prompt and a few headers), in tokens. */
export const WARM_WRITE_TOKENS = 2_000;

export type ResumeAgentAge = { id: string; lastRequestAt?: number; ageMs?: number; ttlMs: number; warm: boolean };
export type ResumeRecommendation = {
  /** Agents the decision is about: resumed (neither live nor dormant) and with a transcript. */
  agents: ResumeAgentAge[];
  recommended: 'full' | 'light';
  reason: { kind: 'warm' | 'cold' | 'unknown'; maxAgeMs?: number };
  fullWarm: number | null;
  fullCold: number | null;
};
export type ResumeEstimate = ResumeRecommendation & {
  /** Estimated cost of a full resume: fullWarm when recommended is 'full', else fullCold (null: no transcript). */
  full: number | null;
  /** Tokens of the light summaries (total and per agent). */
  light: number;
  lightPerAgent: number;
};

const isAlive = (name: string) => tmux.hasSession(name) && !tmux.isPaneDead(name);
/** Agents a resume would relaunch: live ones are reattached and dormant ones never started. */
const resumedAgents = (meta: RunMeta, alive: (name: string) => boolean) => meta.agents.filter((a) => a.status !== 'dormant' && !alive(a.tmux));

/**
 * Which resume mode to use, cheaply (one tail read per transcript, no events). Only resumed agents
 * WITH a transcript count: the others never worked, HQ resumes them light and they have no context
 * to lose (none at all ⇒ 'light', kind 'unknown').
 *
 * Full resume, per agent, from its context size C (last request in its transcript, else bytes/4) in
 * input-token units (COST_WEIGHTS):
 *   warm cache (age < TTL): C × cacheRead (0.1) + WARM_WRITE_TOKENS × cache write
 *   cold cache:             C × cache write (CACHE_WRITE_1H = 2 for 1-hour caches, 1.25 for 5-minute)
 * The TTL is the lastRequest/staleFor rule (1 h, or 5 min when the last usage only wrote ephemeral_5m).
 * 'full' is recommended only when EVERY counted agent is warm; an age equal to the TTL is cold, and an
 * unknown age (transcript without any request yet) recommends 'light'.
 */
export function recommendResume(meta: RunMeta, alive = isAlive, now = Date.now()): ResumeRecommendation {
  const ages: ResumeAgentAge[] = [];
  let warmCost = 0;
  let coldCost = 0;
  for (const a of resumedAgents(meta, alive)) {
    if (!a.transcript || !fs.existsSync(a.transcript)) continue;
    const last = lastUsage(a.transcript);
    const ttlMs = last?.ttlMs ?? TTL_1H;
    const ageMs = last?.at !== undefined ? now - last.at : undefined;
    const warm = ageMs !== undefined && ageMs < ttlMs;
    ages.push({ id: a.id, ...(ageMs !== undefined ? { lastRequestAt: last!.at, ageMs } : {}), ttlMs, warm });
    const ctx = last?.context ?? bytesTokens(a.transcript);
    const write = ttlMs === TTL_5M ? COST_WEIGHTS.cacheWrite : CACHE_WRITE_1H;
    warmCost += ctx * COST_WEIGHTS.cacheRead + WARM_WRITE_TOKENS * write;
    coldCost += ctx * write;
  }
  const recommended = ages.length > 0 && ages.every((x) => x.warm) ? 'full' : 'light';
  const known = ages.filter((x) => x.ageMs !== undefined).map((x) => x.ageMs!);
  const kind = recommended === 'full' ? 'warm' : ages.some((x) => x.ageMs !== undefined && !x.warm) ? 'cold' : 'unknown';
  return {
    agents: ages,
    recommended,
    reason: { kind, ...(known.length ? { maxAgeMs: Math.max(...known) } : {}) },
    fullWarm: ages.length ? Math.round(warmCost) : null,
    fullCold: ages.length ? Math.round(coldCost) : null,
  };
}

/**
 * recommendResume plus the cost of a light resume (reads the run's events and builds every summary).
 * Pass `rec` (from recommendResume) to reuse it, so the recommended mode and the full cost shown
 * next to it come from the same decision.
 */
export function estimateResume(meta: RunMeta, alive = isAlive, now = Date.now(), rec = recommendResume(meta, alive, now)): ResumeEstimate {
  const agents = resumedAgents(meta, alive);
  const events = readRunEvents(meta.dir, meta.runId, SUMMARY_KINDS);
  const light = agents.reduce((n, a) => n + tokens(buildResumeSummary(a.id, events, meta).length), 0);
  return {
    ...rec,
    full: rec.recommended === 'full' ? rec.fullWarm : rec.fullCold,
    light,
    lightPerAgent: agents.length ? Math.round(light / agents.length) : 0,
  };
}

/** Tokens of a transcript by size (bytes/4), for transcripts without any request yet. */
function bytesTokens(transcript: string): number {
  try {
    return tokens(fs.statSync(transcript).size);
  } catch {
    return 0;
  }
}
