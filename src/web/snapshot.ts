import { loadDepartments, loadRoles } from '../library.ts';
import { loadPrefs } from '../ui/prefs.ts';
import { listProviders } from '../providers.ts';
import { PROJECT_DIR } from '../paths.ts';
import { type RunSummary, listRuns } from '../runs.ts';
import { type Alert, type Session, alertsOf } from '../session.ts';
import { readUsage } from '../usage.ts';
import type { AgentStatus, CostProfile, Msg, PermMode, TimelineEvent } from '../types.ts';

/** Everything the web UI draws, as plain JSON. The client never reads files or HQ directly. */
export type Snapshot = {
  cwd: string;
  roles: { id: string; name: string; title: string; color: string; writes: boolean; description: string; provider?: string; model?: string; scope: 'global' | 'project'; pack?: string; fromSource: boolean }[];
  depts: { id: string; name: string; icon: string; color: string; category: string; description: string; lead?: string; roles: string[] }[];
  providers: { id: string; name: string }[];
  prefs: { profile: CostProfile; provider: string };
  usage: { label: string; pct: number }[];
  runs: RunSummary[];
  run: null | {
    runId: string;
    title?: string;
    cwd: string;
    lead?: string;
    permMode: PermMode;
    profile: CostProfile;
    version: number;
    agents: {
      id: string;
      name: string;
      title: string;
      color: string;
      status: AgentStatus;
      task: string;
      lastIn?: string;
      lastOut?: string;
      lastTool?: string;
      notice?: string;
      model?: string;
      ctxTokens?: number;
      children: number;
      timeline: TimelineEvent[];
    }[];
    messages: Msg[];
    alerts: Alert[];
  };
};

/** Keeps the payload small: only the tail of long histories travels. */
const MAX_MESSAGES = 300;
const MAX_TIMELINE = 40;

/** listRuns reads every run's event log: cached for a few seconds (the Sessions tab polls the same way). */
let runsCache: { at: number; runs: RunSummary[] } | null = null;
const RUNS_TTL_MS = 3000;
export const invalidateRuns = () => (runsCache = null);
const cachedRuns = () => {
  if (!runsCache || Date.now() - runsCache.at > RUNS_TTL_MS) runsCache = { at: Date.now(), runs: listRuns() };
  return runsCache.runs;
};

export function snapshot(session: Session): Snapshot {
  const hq = session.hq;
  const prefs = loadPrefs();
  return {
    cwd: PROJECT_DIR,
    roles: loadRoles().map((r) => ({ id: r.id, name: r.name, title: r.title, color: r.color, writes: r.writes, description: r.description, provider: r.provider, model: r.model, scope: r.scope, pack: r.pack, fromSource: !!r.source })),
    depts: loadDepartments().map((d) => ({ id: d.id, name: d.name, icon: d.icon, color: d.color, category: d.category, description: d.description, lead: d.lead, roles: d.roles })),
    providers: listProviders().map((p) => ({ id: p.id, name: p.name })),
    prefs: { profile: prefs.profile ?? 'max', provider: prefs.provider ?? '' },
    usage: (readUsage().snapshot?.metrics ?? []).map((m) => ({ label: m.label, pct: m.pct })),
    runs: cachedRuns(),
    run: hq
      ? {
          runId: hq.runId,
          title: hq.title,
          cwd: hq.cwd,
          lead: hq.lead,
          permMode: hq.permMode,
          profile: hq.profile,
          version: hq.version,
          agents: [...hq.agents.values()].map((a) => ({
            id: a.id,
            name: a.role.name,
            title: a.role.title,
            color: a.role.color,
            status: a.status,
            task: a.task,
            lastIn: a.lastIn,
            lastOut: a.lastOut,
            lastTool: a.lastTool,
            notice: a.notice,
            model: a.model,
            ctxTokens: a.ctxTokens,
            children: a.children.length,
            timeline: a.timeline.slice(-MAX_TIMELINE),
          })),
          messages: hq.messages.slice(-MAX_MESSAGES),
          alerts: alertsOf(hq),
        }
      : null,
  };
}
