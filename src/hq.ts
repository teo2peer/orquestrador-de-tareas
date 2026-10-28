import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT, HOOK_SCRIPT, MCP_SCRIPT, ORQ_HOME, PROJECT_DIR } from './paths.ts';
import { ORQ_DATA_DENIED, denyRules, orqDataAccess } from './orq-guard.ts';
import { SUMMARY_KINDS, buildResumeSummary, cacheWarm } from './resume.ts';
import { loadDepartments } from './library.ts';
import { claudeProviderEnv, opencodeConfig, opencodeLaunch, providerOf, runnerLaunch } from './providers.ts';
import type { RunnerConfig } from './runner-core.ts';
import { contextTokens, lastRequest } from './tokens.ts';
import { usageFile } from './usage.ts';
import { RunStore, newRunId } from './store.ts';
import * as tmux from './tmux.ts';
import type { Agent, Msg, MsgType, Notice, CostProfile, PermMode, ResumeMode, Role, RunMeta, TeamMode, TitleSource, TimelineKind } from './types.ts';


/**
 * Built-in tools per kind of agent in the 'saver' profile (`--tools`; MCP tools such as `company`
 * are not affected). Names checked against claude 2.1.296: no TodoWrite (the lead gets the reader
 * set) and no BashOutput/KillShell: background Bash output is read with Read and stopped with
 * TaskStop. Unknown names are silently ignored by claude.
 */
export const SAVER_TOOLS = {
  reader: ['Bash', 'Read', 'Glob', 'Grep', 'TaskStop'],
  writer: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TaskStop'],
  lead: [] as string[],
};
/**
 * Extra built-in tools some library roles need in 'saver' (a role's own `tools:` replaces these).
 * Infra roles (devops, sysadmin, linux-admin, network-engineer, web-admin,
 * monitoring) work through Bash (ssh, docker, systemctl, curl), which every agent has.
 */
export const ROLE_TOOL_DEFAULTS: Record<string, string[]> = {
  researcher: ['WebFetch', 'WebSearch'],
  'fact-checker': ['WebFetch', 'WebSearch'],
  'ux-researcher': ['WebFetch', 'WebSearch'],
  secops: ['WebFetch'],
  'trend-researcher': ['WebFetch', 'WebSearch'],
  'social-strategist': ['WebFetch', 'WebSearch'],
  'seo-writer': ['WebFetch', 'WebSearch'],
  'product-marketer': ['WebFetch', 'WebSearch'],
  'paid-ads': ['WebFetch', 'WebSearch'],
  'pr-partnerships': ['WebFetch', 'WebSearch'],
};

/** What each profile leaves out, in words for the UI. */
export function profileFlags(profile: CostProfile): string[] {
  if (profile === 'max') return [];
  const common = ['solo los MCP permitidos (company + context7 si lo tienes)', 'sin auto-memoria', 'los agentes arrancan con su primera tarea', 'compacta el contexto a partir de 120k'];
  if (profile === 'balanced') return common;
  return [...common, 'solo herramientas básicas por rol (todos tienen Bash; Edit/Write solo quien escribe)', 'modelo más barato para los verificadores de solo lectura'];
}

/** Context size above which an idle agent with nothing pending is compacted between tasks. */
export const COMPACT_AT: Record<CostProfile, number | undefined> = { saver: 120_000, balanced: 120_000, max: undefined };
const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

/**
 * Model for read-only verifiers per profile. Only 'saver' downgrades, to `sonnet` (not `haiku`):
 * reviewing and testing still need solid reasoning. Never applied to the lead, to roles that write,
 * to NEVER_CHEAP roles, or when the role sets its own model.
 */
export const PROFILE_READONLY_MODEL: Record<CostProfile, string | undefined> = { saver: 'sonnet', balanced: undefined, max: undefined };
const NEVER_CHEAP = new Set(['reviewer', 'architect']);

/** MCP servers every agent of a profile gets (when the user has them configured), besides `company`. */
export const PROFILE_MCP: Record<CostProfile, string[]> = { saver: ['context7'], balanced: ['context7'], max: [] };

const readJson = (file: string): Record<string, any> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

export const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

/** Keys ~/.claude.json may use for this project: cwd, its realpath and its git root. */
function projectKeys(cwd: string) {
  const keys = [cwd];
  try {
    keys.push(fs.realpathSync(cwd));
  } catch {}
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd, stdout: 'pipe', stderr: 'ignore', timeout: 2000 });
    if (r.exitCode === 0) keys.push(r.stdout.toString().trim());
  } catch {}
  return [...new Set(keys.filter(Boolean))];
}

/**
 * Every MCP server the user has configured for this project, read-only: ~/.claude.json user scope,
 * <cwd>/.mcp.json (only servers the user approved for this project, as Claude Code does) and the
 * per-project local scope; local > project > user. Definitions may hold secrets: never log them.
 */
export function configuredMcpServers(cwd: string, claudeJson = CLAUDE_JSON): Record<string, unknown> {
  const user = readJson(claudeJson);
  const key = projectKeys(cwd).find((k) => user?.projects?.[k]);
  const proj: Record<string, any> = (key && user?.projects?.[key]) || {};
  const approved = (name: string) =>
    !(proj.disabledMcpjsonServers ?? []).includes(name) && (proj.enableAllProjectMcpServers === true || (proj.enabledMcpjsonServers ?? []).includes(name));
  const shared = Object.entries(readJson(path.join(cwd, '.mcp.json'))?.mcpServers ?? {}).filter(([name]) => approved(name));
  return { ...user?.mcpServers, ...Object.fromEntries(shared), ...proj.mcpServers };
}

/** Definitions of the named servers (see configuredMcpServers); unknown names and `company` are skipped. */
export function userMcpServers(names: string[], cwd: string, claudeJson = CLAUDE_JSON): Record<string, unknown> {
  if (!names.length) return {};
  const all = configuredMcpServers(cwd, claudeJson) as Record<string, unknown>;
  return Object.fromEntries(names.filter((n) => n !== 'company' && all[n]).map((n) => [n, all[n]]));
}

/** Extra directories, absolute (`~/` expanded); missing ones are skipped. */
export const resolveDirs = (dirs: string[] = []) =>
  dirs.map((d) => (d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : path.resolve(d))).filter((d) => fs.existsSync(d));

const STATUSLINE_SCRIPT = path.join(APP_ROOT, 'src', 'statusline.ts');
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification'];
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const MAX_STOP_BLOCKS = 8; // consecutive Stop-hook injections before letting the agent rest
const MAX_TIMELINE = 400;
/**
 * Claude's own auto-compaction for every agent and profile: at AUTO_COMPACT_PCT % of an
 * AUTO_COMPACT_WINDOW-token window (~130k). Current models have a 1M window, so a percentage of
 * the full window alone would compact far too late.
 */
export const AUTO_COMPACT_WINDOW = 200_000;
export const AUTO_COMPACT_PCT = 65;
/** Context size (tokens) at which claude compacts by itself. */
export const AUTO_COMPACT_AT = (AUTO_COMPACT_WINDOW * AUTO_COMPACT_PCT) / 100;
/** How often the context size is re-read from the transcript during a turn (on PostToolUse). */
const CTX_REFRESH_MS = 10_000;
/** Longest message or report body delivered to another agent; the rest goes to the run log (LOG.md). */
export const MAX_DELIVERED = 2000;

// Startup dialogs claude shows before the session begins. They are security decisions,
// so HQ only surfaces them; the user accepts from the UI.
const who = (n: number) => (n > 1 ? `${n} agentes piden` : 'Claude pide');
const DIALOGS: { kind: 'trust' | 'bypass'; re: RegExp; text: (cwd: string, n: number) => string }[] = [
  { kind: 'trust', re: /trust this folder|one you trust/i, text: (cwd, n) => `${who(n)} confirmar que confías en la carpeta ${cwd}` },
  { kind: 'bypass', re: /Bypass Permissions mode/i, text: (_, n) => `${who(n)} confirmar el modo YOLO (--dangerously-skip-permissions)` },
];

export const PERM_LABEL: Record<PermMode, string> = { auto: 'auto', 'auto-insecure': 'auto + permisivo', yolo: 'YOLO' };
const PERM_ARGS: Record<PermMode, string> = {
  auto: '--permission-mode auto',
  // Starts in auto mode but lets the session switch to bypass mode (shift+tab).
  'auto-insecure': '--permission-mode auto --allow-dangerously-skip-permissions',
  yolo: '--dangerously-skip-permissions',
};

export const USER = 'user';

const short = (s: string, n = 80) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
type BoardRow = { status: string; task: string; lastDone: string; notice: string };
/** Events format version: 2 = deliveries ('delivered') and edits ('edit') are recorded. */
const EVENTS_VERSION = 2;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const PROVISIONAL_TITLE_CHARS = 50;
const MAX_TITLE_WORDS = 6;
/** Longest session title, in characters (same limit as the UI). */
export const TITLE_MAX = 60;
const uid = () => Math.random().toString(36).slice(2, 10);

export type HQOptions = {
  roles: Role[];
  lead?: string;
  permMode: PermMode;
  mode?: TeamMode;
  /** Token-saving profile (default 'max': current behaviour). Restored from `resume`. */
  profile?: CostProfile;
  /** Provider id forcing every agent of the session onto it (absent: each role's own). Restored from `resume`. */
  provider?: string;
  cwd?: string;
  /** Previous run to continue: reattach live sessions, relaunch dead ones (see resumeMode). */
  resume?: RunMeta;
  /** How dead agents of `resume` come back (default 'full'). Agents without a transcript always resume light. */
  /** 'auto': per agent, full where its prompt cache is still warm, light where it went cold. */
  resumeMode?: ResumeMode | 'auto';
  /** Directories outside the cwd every agent works with (the launched team's `dirs`). */
  dirs?: string[];
  /** Department launched (its rules go into every agent's prompt; re-read from the library on resume). */
  dept?: string;
  /** Team rules; default: those of `dept` in the library. */
  rules?: string;
};

const socketFor = (runId: string) => path.join(os.tmpdir(), `orq-${runId}.sock`);

/** True when another orq process is already serving this run's socket. */
export async function runIsServed(runId: string) {
  try {
    const r = await fetch('http://hq/ping', { unix: socketFor(runId), signal: AbortSignal.timeout(800) } as RequestInit);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Headquarters: owns the run, the tmux sessions, the message bus and the
 * unix socket that hooks and the `company` MCP server talk to.
 */
export class HQ extends EventEmitter {
  readonly runId: string;
  readonly cwd: string;
  readonly store: RunStore;
  readonly socketPath: string;
  readonly startedAt: number;
  readonly agents = new Map<string, Agent>();
  readonly messages: Msg[] = [];
  notices: Notice[] = [];
  lead?: string;
  permMode: PermMode;
  mode: TeamMode;
  profile: CostProfile;
  /** Session-wide provider override (see providers.ts); undefined: each role's own. */
  provider?: string;
  /** Directories outside the cwd every agent gets (--add-dir), resolved. */
  readonly dirs: string[];
  /** Department the run was launched as, and its rules (appended to every role prompt). */
  readonly dept?: string;
  readonly rules?: string;
  /** Session title; provisional until the lead (set_title) or the user sets it. */
  title?: string;
  titleProvisional = false;
  titleSource?: TitleSource;
  /** Resumed runs with history never take an automatic title from new messages. */
  private noAutoTitle = false;
  version = 0;
  private server?: ReturnType<typeof Bun.serve>;
  private watchdog?: ReturnType<typeof setInterval>;
  private emitTimer?: ReturnType<typeof setTimeout>;
  /** Last team board each coordinator was given, to send only what changed (profiles other than 'max'). */
  private boardSent = new Map<string, { at: number; rows: Record<string, BoardRow>; msgs: number }>();

  constructor(private opts: HQOptions) {
    super();
    this.runId = opts.resume?.runId ?? newRunId();
    tmux.registerRun(this.runId);
    this.cwd = opts.resume?.cwd ?? opts.cwd ?? PROJECT_DIR;
    this.store = new RunStore(this.runId, this.cwd);
    this.socketPath = socketFor(this.runId);
    this.startedAt = opts.resume?.startedAt ?? Date.now();
    this.permMode = opts.resume?.permMode ?? opts.permMode;
    this.lead = opts.resume?.lead ?? opts.lead;
    this.mode = opts.resume?.mode ?? opts.mode ?? 'role';
    this.profile = opts.resume?.profile ?? opts.profile ?? 'max';
    this.provider = opts.resume?.provider ?? opts.provider ?? undefined;
    this.dirs = resolveDirs(opts.resume?.dirs ?? opts.dirs);
    this.dept = opts.resume?.dept ?? opts.dept;
    this.rules = opts.rules ?? (this.dept ? loadDepartments().find((d) => d.id === this.dept)?.rules : undefined);
    this.title = opts.resume?.title;
    this.titleProvisional = !!this.title && !!opts.resume?.titleProvisional;
    this.titleSource = this.title ? (opts.resume?.titleSource ?? (this.titleProvisional ? 'auto' : 'lead')) : undefined;
  }

  // ------------------------------------------------------------- lifecycle

  start() {
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
    this.server = Bun.serve({
      unix: this.socketPath,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = (await req.json().catch(() => ({}))) as any;
        try {
          if (url.pathname === '/ping') return new Response('orq');
          if (url.pathname === '/hook') return Response.json(this.onHook(body.agent, body.payload ?? {}));
          if (url.pathname === '/tool') return Response.json({ result: this.onTool(body.agent, body.tool, body.args ?? {}) });
        } catch (e: any) {
          return Response.json({ error: String(e?.message ?? e) });
        }
        return new Response('not found', { status: 404 });
      },
    });
    if (this.opts.resume) this.restore(this.opts.resume);
    else {
      this.store.event({ kind: 'run_start', v: EVENTS_VERSION, cwd: this.cwd, permMode: this.permMode, mode: this.mode, profile: this.profile, lead: this.lead });
      for (const r of this.opts.roles) this.hire(r);
    }
    this.watchdog = setInterval(() => this.checkSessions(), 3000);
  }

  /** Rebuild state from a previous run; reattach live sessions, resume dead ones. */
  private restore(meta: RunMeta) {
    for (const m of meta.agents) {
      const live = this.sessionAlive(m.tmux);
      const agent: Agent = {
        id: m.id,
        role: m.role,
        // Never started: stays asleep until a waking message.
        status: live ? 'idle' : m.status === 'dormant' ? 'dormant' : 'starting',
        task: '',
        children: [],
        sessionId: m.sessionId,
        prevSessionIds: m.prevSessionIds,
        tmux: m.tmux,
        inbox: [],
        timeline: [],
        transcriptPath: m.transcript,
        transcriptDir: m.transcriptDir ?? (m.transcript ? path.dirname(m.transcript) : undefined),
        stopBlocks: 0,
        ctxTokens: contextTokens(m.transcript),
      };
      agent.model = this.effectiveModel(m.role);
      this.agents.set(m.id, agent);
    }
    const events = this.store.readEvents();
    const delivered = new Set<string>();
    // Messages delivered after an agent's last finished turn (Stop): lost if that turn was cut.
    const sinceStop = new Map<string, string[]>();
    for (const e of events) {
      const a = e.agent ? this.agents.get(e.agent) : undefined;
      if (e.kind === 'hook' && e.event === 'Stop' && e.agent) sinceStop.set(e.agent, []);
      if (e.kind === 'delivered' && Array.isArray(e.ids) && e.agent) sinceStop.set(e.agent, [...(sinceStop.get(e.agent) ?? []), ...e.ids.map(String)]);
      if (e.kind === 'delivered' && Array.isArray(e.ids)) for (const id of e.ids) delivered.add(String(id));
      if (e.kind === 'timeline' && a) {
        a.timeline.push({ ts: e.ts, kind: e.tkind, text: e.text });
        if (e.tkind === 'status') a.task = e.text;
      } else if (e.kind === 'message') {
        const msg: Msg = { id: e.id, ts: e.ts, from: e.from, to: e.to, type: e.type, body: e.body, options: e.options, replyTo: e.replyTo };
        this.messages.push(msg);
        const from = this.agents.get(msg.from);
        const to = this.agents.get(msg.to);
        if (from) from.lastOut = `→ ${msg.to}: ${short(msg.body, 120)}`;
        if (to) to.lastIn = `← ${msg.from}: ${short(msg.body, 120)}`;
        if (from && msg.type === 'report' && msg.body.startsWith('[done]')) {
          from.lastDone = short(msg.body.replace(/^\[done\]\s*/, ''), 120);
          from.task = '';
        }
      }
    }
    // A resumed run with history gets no title from new messages: at most its first task.
    if (this.messages.length) {
      this.noAutoTitle = true;
      const first = this.messages.find((m) => m.type === 'task');
      if (!this.title && first) this.setTitle(short(first.body, PROVISIONAL_TITLE_CHARS), 'auto');
    }
    // Questions to the user that never got an answer are pending again.
    for (const m of this.messages)
      if (m.to === USER && m.type === 'question' && !this.answerOf(m.id))
        this.notices.push({ id: m.id, kind: 'question', from: m.from, text: m.body, options: m.options, msgId: m.id });
    // Messages never delivered go back to their inbox. Runs older than delivery tracking have no
    // record of what was delivered: nothing is re-queued for them (it would replay old history).
    const tracked = events.some((e) => (e.kind === 'run_start' && Number(e.v) >= EVENTS_VERSION) || e.kind === 'delivered');
    const oldSummary = (m: Msg) => m.type === 'system' && m.body.startsWith('# Session resumed');
    const pending = (id: string) => (tracked ? this.messages.filter((m) => m.to === id && !delivered.has(m.id) && !oldSummary(m)) : []);
    const mode = this.opts.resumeMode ?? 'full';
    this.store.event({ kind: 'run_resume', permMode: this.permMode, resumeMode: mode });
    for (const a of this.agents.values()) {
      if (a.status === 'dormant') {
        a.inbox.push(...pending(a.id));
        if (a.inbox.some((m) => this.wakes(m))) this.wakeDormant(a);
        else if (a.inbox.length) this.schedulePending(a);
        continue;
      }
      if (a.status === 'idle') {
        a.inbox.push(...pending(a.id));
        this.track(a, 'system', 'Reconectado a la sesión viva');
        if (a.inbox.length) this.scheduleWake(a);
        continue;
      }
      tmux.killSession(a.tmux);
      // `--resume` needs an existing transcript; without one the agent always resumes light.
      if ((mode === 'full' || (mode === 'auto' && cacheWarm(a.transcriptPath))) && a.transcriptPath && fs.existsSync(a.transcriptPath)) {
        // The conversation reloads up to its last saved turn: what came in during a turn that never
        // finished goes again, before what was never delivered.
        const cut = new Set(sinceStop.get(a.id) ?? []);
        a.inbox.push(...this.messages.filter((m) => cut.has(m.id) && !oldSummary(m)), ...pending(a.id));
        this.launch(a, true);
        this.track(a, 'system', 'Reanudado con conversación completa');
      } else {
        // Undelivered messages follow the summary in full (and only there): they carry their own
        // delivery record, so a failed delivery is retried on the next resume instead of being lost.
        const rest = pending(a.id);
        this.resumeLight(a, events, meta, new Set(rest.map((m) => m.id)));
        a.inbox.push(...rest);
      }
    }
    this.saveMeta();
    this.changed();
  }

  /** Whether an agent's tmux session is still running claude. */
  private sessionAlive(name: string) {
    return tmux.hasSession(name) && !tmux.isPaneDead(name);
  }

  /** Fresh Claude session for a dead agent, primed with a summary of where it left off. */
  private resumeLight(a: Agent, events: Record<string, any>[], meta: RunMeta, skip: ReadonlySet<string> = new Set()) {
    a.prevSessionIds = [...(a.prevSessionIds ?? []), a.sessionId];
    a.sessionId = crypto.randomUUID();
    if (a.transcriptPath) a.transcriptDir = path.dirname(a.transcriptPath);
    a.transcriptPath = undefined;
    a.ctxTokens = 0;
    this.launch(a);
    this.track(a, 'system', 'Reanudado con resumen (ligera)');
    this.store.event({ kind: 'resume_light', agent: a.id, sessionId: a.sessionId, prev: a.prevSessionIds.at(-1) });
    // Queued until the new session starts (SessionStart delivers the inbox).
    this.post('system', a.id, buildResumeSummary(a.id, events, meta, skip), 'system');
  }

  /** Close HQ but leave the agents running in tmux so the run can be reattached later. */
  detach() {
    clearInterval(this.watchdog);
    this.clearWakeTimers();
    this.store.event({ kind: 'run_detach' });
    this.saveMeta();
    this.server?.stop(true);
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
  }

  stop() {
    clearInterval(this.watchdog);
    this.clearWakeTimers();
    fs.rmSync(this.privateDir, { recursive: true, force: true });
    for (const a of this.agents.values()) tmux.killSession(a.tmux);
    this.server?.stop(true);
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
    this.store.event({ kind: 'run_stop' });
    this.saveMeta();
  }

  private changed() {
    this.version++;
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit('change');
    }, 80);
  }

  private saveMeta() {
    const meta = this.currentMeta();
    this.store.saveMeta({ ...meta, team: meta.agents.map((a) => ({ id: a.id, name: a.role.name, color: a.role.color })) } as RunMeta);
  }

  /** The run as stored in run.json right now. */
  private currentMeta(): RunMeta {
    return {
      runId: this.runId,
      cwd: this.cwd,
      dir: this.store.dir,
      permMode: this.permMode,
      mode: this.mode,
      profile: this.profile,
      ...(this.provider ? { provider: this.provider } : {}),
      lead: this.lead,
      ...(this.dirs.length ? { dirs: this.dirs } : {}),
      ...(this.dept ? { dept: this.dept } : {}),
      ...(this.title ? { title: this.title, titleProvisional: this.titleProvisional, titleSource: this.titleSource } : {}),
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      agents: [...this.agents.values()].map((a) => ({
        id: a.id,
        title: a.role.title,
        sessionId: a.sessionId,
        ...(a.prevSessionIds?.length ? { prevSessionIds: a.prevSessionIds } : {}),
        tmux: a.tmux,
        transcript: a.transcriptPath,
        ...(a.transcriptDir ? { transcriptDir: a.transcriptDir } : {}),
        status: a.status,
        role: a.role,
      })),
    };
  }

  /**
   * Set the session title. 'auto' is provisional and never replaces an existing title; a title the
   * user set is only replaced by the user. Returns whether the title changed.
   */
  setTitle(title: string, source: TitleSource = 'user'): boolean {
    // Same normalisation as the UI (cleanTitle): single spaces, trimmed, cut at TITLE_MAX.
    const t = title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
    if (!t || (source === 'auto' && this.title) || (source === 'lead' && this.titleSource === 'user')) return false;
    this.title = t;
    this.titleProvisional = source === 'auto';
    this.titleSource = source;
    this.store.event({ kind: 'title', title: t, source });
    this.saveMeta();
    this.changed();
    return true;
  }

  // ---------------------------------------------------------------- agents

  hire(role: Role) {
    if (this.agents.has(role.id)) return this.agents.get(role.id)!;
    const sessionId = crypto.randomUUID();
    if (!this.lead) this.lead = role.id;
    // Outside 'max' only the lead starts at once; the rest sleep until their first waking message.
    const dormant = this.profile !== 'max' && role.id !== this.lead;
    const agent: Agent = {
      id: role.id,
      role,
      status: dormant ? 'dormant' : 'starting',
      task: '',
      children: [],
      sessionId,
      tmux: `orq-${this.runId}-${role.id}`,
      inbox: [],
      timeline: [],
      stopBlocks: 0,
    };
    // Known before launch, so the UI can show it for dormant agents too.
    agent.model = this.effectiveModel(role);
    this.agents.set(role.id, agent);
    if (!dormant) this.launch(agent);
    this.track(agent, 'system', dormant ? 'Contratado: en espera hasta su primera tarea' : `Contratado (${PERM_LABEL[this.permMode]})`);
    this.store.event({ kind: 'hire', agent: role.id, sessionId });
    this.saveMeta();
    this.changed();
    return agent;
  }

  /** Start a dormant agent; SessionStart then delivers its inbox. */
  private wakeDormant(a: Agent) {
    if (a.status !== 'dormant') return;
    a.status = 'starting';
    this.launch(a);
    this.track(a, 'system', `Arrancado al recibir su primer mensaje (${PERM_LABEL[this.permMode]})`);
    this.saveMeta();
    this.changed();
  }

  fire(id: string) {
    const a = this.agents.get(id);
    if (!a) return;
    this.clearWakeTimers(id);
    tmux.killSession(a.tmux);
    this.agents.delete(id);
    if (this.lead === id) this.lead = this.agents.keys().next().value;
    this.store.event({ kind: 'fire', agent: id });
    this.saveMeta();
    this.changed();
  }

  /** Restart an agent keeping its conversation (e.g. after toggling YOLO). */
  restart(id: string) {
    const a = this.agents.get(id);
    // A dormant agent has no session yet: it starts (with the current mode) on its first task.
    if (!a || a.status === 'dormant') return;
    // An unconfirmed delivery goes back to the inbox; SessionStart delivers it to the new session.
    this.cancelDelivery(a);
    tmux.killSession(a.tmux);
    a.status = 'starting';
    this.launch(a, !!a.transcriptPath && fs.existsSync(a.transcriptPath));
    this.track(a, 'system', `Reiniciado (${PERM_LABEL[this.permMode]})`);
    this.changed();
  }

  private launch(agent: Agent, resume = false) {
    const script = this.writeLaunchFiles(agent, resume);
    tmux.newSession(agent.tmux, this.cwd, `bash '${script.replace(/'/g, `'\\''`)}'`);
  }

  /** Delay before delivering the inbox to a session that just started (claude settling its TUI). */
  sessionStartDeliverMs = 1500;

  /** ~/.claude.json, read for the user's MCP servers (overridable in tests). */
  claudeJson = CLAUDE_JSON;

  private mcpAllowlist(role: Role) {
    return [...new Set([...PROFILE_MCP[this.profile], ...(role.mcp ?? [])])];
  }

  /** Protocol line listing the built-in tools of a 'saver' agent and how to get more. */
  private toolsLine(role: Role) {
    const tools = this.effectiveTools(role);
    if (!tools) return '';
    return `\n- To save tokens your built-in tools are limited to: ${tools.join(', ')} (plus the company tools). If your work needs another one (e.g. WebFetch), ask your coordinator or the user to add it to the \`tools:\` list of your role.`;
  }

  /** Protocol line naming the user's MCP servers this profile leaves out (names only). */
  private omittedMcpLine(role: Role) {
    if (this.profile === 'max') return '';
    let all: string[];
    try {
      all = Object.keys(configuredMcpServers(this.cwd, this.claudeJson));
    } catch {
      return '';
    }
    const allowed = new Set(this.mcpAllowlist(role));
    const omitted = all.filter((n) => n !== 'company' && !allowed.has(n)).sort();
    if (!omitted.length) return '';
    return `\n- To save tokens these MCP servers are not loaded in this session: ${omitted.join(', ')}. If your work needs one, ask your coordinator or the user to add it to the \`mcp:\` list of your role.`;
  }

  /** Per-run private dir (ORQ_HOME/private/<runId>): 0700, removed when the run stops. */
  get privateDir() {
    return path.join(ORQ_HOME, 'private', this.runId);
  }

  /** Write a 0600 file under privateDir/<agentId> (tmp + chmod + rename, also over an existing file). */
  private writePrivate(agentId: string, name: string, content: string) {
    const dir = path.join(this.privateDir, agentId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const d of [path.join(ORQ_HOME, 'private'), this.privateDir, dir]) fs.chmodSync(d, 0o700);
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return file;
  }

  /** Built-in tools of an agent in 'saver' (undefined elsewhere: all of them). */
  effectiveTools(role: Role): string[] | undefined {
    if (this.profile !== 'saver') return undefined;
    const base = role.writes ? SAVER_TOOLS.writer : SAVER_TOOLS.reader;
    const lead = role.id === this.lead ? SAVER_TOOLS.lead : [];
    return [...new Set([...base, ...lead, ...(role.tools ?? ROLE_TOOL_DEFAULTS[role.id] ?? [])])];
  }

  /** Provider of a role in this session: the session override, else the role's own. */
  providerFor(role: Role) {
    return providerOf({ provider: this.provider ?? role.provider });
  }

  /** Model an agent of this role runs with: the role's own, or the profile's cheaper one for read-only verifiers. */
  effectiveModel(role: Role): string | undefined {
    if (role.model) return role.model;
    const cheap = PROFILE_READONLY_MODEL[this.profile];
    if (!cheap || role.writes || role.id === this.lead || NEVER_CHEAP.has(role.id)) return undefined;
    return cheap;
  }

  /** system.md, mcp.json, settings.json and launch.sh of an agent; returns the launch script. */
  private writeLaunchFiles(agent: Agent, resume = false) {
    const role = agent.role;
    const dir = this.store.agentDir(agent.id);
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    // The statusLine of orq sessions is set by orq (statusline.ts → usage.ts); it writes where the UI reads.
    const env = { ORQ_SOCKET: this.socketPath, ORQ_AGENT_ID: agent.id, ORQ_USAGE_FILE: usageFile() };
    fs.writeFileSync(path.join(dir, 'system.md'), this.systemPrompt(role));
    // Outside 'max', only `company` plus the role/profile allowlist load (--strict-mcp-config).
    const strict = this.profile !== 'max';
    const extra = strict ? userMcpServers(this.mcpAllowlist(role), this.cwd, this.claudeJson) : {};
    // May hold the user's MCP secrets: kept outside the project, private to the user.
    // Runs before private configs wrote it next to the logs: never leave secrets there.
    fs.rmSync(path.join(dir, 'mcp.json'), { force: true });
    const mcpConfig = this.writePrivate(agent.id, 'mcp.json', JSON.stringify({ mcpServers: { ...extra, company: { command: process.execPath, args: [MCP_SCRIPT], env } } }, null, 2));
    const provider = this.providerFor(role);
    if (provider.kind === 'openai') {
      agent.model = role.model && !/^(opus|sonnet|haiku|fable)$/i.test(role.model) ? role.model : provider.model;
      const cfg: RunnerConfig = {
        baseUrl: provider.baseUrl ?? '',
        keyEnv: provider.keyEnv ?? 'OPENAI_API_KEY',
        model: agent.model ?? '',
        system: path.join(dir, 'system.md'),
        cwd: this.cwd,
        writes: role.writes,
        sessionId: agent.sessionId,
        // Next to the run's other logs (privateDir is wiped when the run stops, a resume must still find it).
        historyFile: path.join(dir, `history-${agent.sessionId}.json`),
        mcp: { command: process.execPath, args: [MCP_SCRIPT], env },
      };
      const cfgFile = this.writePrivate(agent.id, 'runner.json', JSON.stringify(cfg, null, 2));
      const script = path.join(dir, 'launch.sh');
      fs.writeFileSync(script, ['#!/bin/bash', ...Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`), `export ORQ_BUN=${q(process.execPath)}`, ...runnerLaunch(provider, cfgFile, this.cwd), ''].join('\n'), { mode: 0o755 });
      return script;
    }
    if (provider.kind === 'opencode') {
      // No hooks/settings.json: the plugin in the opencode config reports to HQ. Resumes reuse the session id it reported.
      // Claude aliases (opus/sonnet/haiku) mean nothing to opencode: it needs provider/model.
      agent.model = role.model?.includes('/') ? role.model : provider.model;
      const cfg = opencodeConfig({ system: path.join(dir, 'system.md'), model: agent.model, writes: role.writes, env });
      const cfgFile = this.writePrivate(agent.id, 'opencode.json', JSON.stringify(cfg, null, 2));
      const script = path.join(dir, 'launch.sh');
      fs.writeFileSync(
        script,
        ['#!/bin/bash', ...Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`), ...opencodeLaunch(cfgFile, this.cwd, resume ? agent.sessionId : undefined), ''].join('\n'),
        { mode: 0o755 },
      );
      return script;
    }
    const hookCmd = `"${process.execPath}" "${HOOK_SCRIPT}"`;
    const hooks = Object.fromEntries(
      HOOK_EVENTS.map((e) => [e, [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }]]),
    );
    // The statusLine feeds the account usage (rate limits) to orq; see usage.ts.
    const statusLine = { type: 'command', command: `"${process.execPath}" "${STATUSLINE_SCRIPT}"` };
    // Agents never read orq's own data (see orq-guard.ts); the PreToolUse hook also covers Bash.
    const permissions = { deny: denyRules(this.cwd, ORQ_HOME) };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks, statusLine, permissions }, null, 2));

    const args = [
      resume ? `--resume ${agent.sessionId}` : `--session-id ${agent.sessionId}`,
      `--name ${q(`orq · ${role.title}`)}`,
      `--append-system-prompt-file ${q(path.join(dir, 'system.md'))}`,
      `--mcp-config ${q(mcpConfig)}`,
      ...(strict ? ['--strict-mcp-config'] : []),
      `--settings ${q(path.join(dir, 'settings.json'))}`,
      `--allowedTools 'mcp__company__*'`,
      PERM_ARGS[this.permMode],
    ];
    if (!role.writes) args.push(`--disallowedTools Edit Write NotebookEdit`);
    for (const d of this.dirs) args.push(`--add-dir ${q(d)}`);
    // saver: only the tools the agent needs (MCP tools still load). No --disable-slash-commands:
    // in claude 2.1.296 it also disables the built-in /compact and /clear orq relies on.
    const tools = this.effectiveTools(role);
    if (tools) args.push(`--tools ${q(tools.join(','))}`);
    if (role.userSettings === false) args.push('--setting-sources project,local');
    agent.model = this.effectiveModel(role);
    if (agent.model) args.push(`--model ${q(agent.model)}`);
    const script = path.join(dir, 'launch.sh');
    fs.writeFileSync(
      script,
      [
        '#!/bin/bash',
        ...Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`),
        ...(this.profile !== 'max' ? ['export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1'] : []),
        ...claudeProviderEnv(provider),
        `export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${AUTO_COMPACT_WINDOW}`,
        `export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${AUTO_COMPACT_PCT}`,
        `cd ${q(this.cwd)}`,
        `exec claude ${args.join(' \\\n  ')}`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return script;
  }

  private systemPrompt(role: Role) {
    const team = [...this.opts.roles, ...[...this.agents.values()].map((a) => a.role)]
      .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
      .map((r) => `- \`${r.id}\` — ${r.title}${r.id === this.lead ? ' (coordinator)' : ''}: ${short(r.description, 140)}`)
      .join('\n');
    return `# Orq virtual company — you are "${role.title}" (id: \`${role.id}\`)

You are one employee of a virtual company of Claude Code agents. Each employee is a separate
Claude session with a single responsibility. The human owner is \`${USER}\`.
Working directory (shared with the other agents): ${this.cwd}

## Your role
${role.prompt || role.description}
${this.rules ? `\n## Team rules (apply to every member, on top of your role)\n${this.rules}\n` : ''}
## Team at launch (call \`team\` for the live board)
${team}

## Company protocol (mandatory)
- Talk to other employees and to the user ONLY through the \`mcp__company__*\` tools.
  Plain text in your terminal is not seen by anyone.
- When you receive a task: call \`set_status\` with a short summary (<60 chars) of what you are doing.
- When you finish a task: call \`report\` to whoever asked you with a SHORT summary (at most ~10 lines:
  outcome, files touched, open issues) and the final status (done | blocked | partial). Put long details
  (file lists, command output, reasoning) in its \`details\` field or in \`log\`: they go to the run log the
  user reads, not to the recipient. Messages longer than ${MAX_DELIVERED} characters are cut for the recipient.
- To keep a record (decisions, progress, findings), call \`log\` instead of writing log files by hand;
  with \`file\` it appends to a project file (e.g. a changelog or bug list) without you reading it first.
- To keep a fact across a /clear or resume (a decision, a path, a constraint) call \`memory\` with \`save\`; to
  recall past messages or notes call it with \`search\` instead of asking again or re-reading.
- NEVER read, search or edit anything inside \`.orq/\` or \`~/.orq/\`: it is orq's private run data
  (logs, events, transcripts, configs). It is blocked, and the company tools tell you everything you need.
- Do not reply to informational messages or send acknowledgements; reply only to task/question/answer messages that need action.${this.omittedMcpLine(role)}${this.toolsLine(role)}
- Stay within your responsibility. Delegate the rest with \`delegate_task\` to the right employee.
  If your instructions mention delegating to another named agent and that agent is on the \`team\` board,
  use \`delegate_task\` instead of a local subagent. If the needed role is missing, use \`request_hire\`.
- Work autonomously. Do NOT ask the user unless it is essential: an irreversible or destructive action on real data/infrastructure, credentials or access only the user has, spending money, or a change of product scope. For anything else pick the most sensible option, state the assumption in your report and continue.
- When you must ask, use \`ask_user\` with ONE concise question, 2-4 short \`options\` (put your recommended one first and mark it '(recomendado)'), and keep working on whatever does not depend on the answer.
- ${role.writes ? 'You may modify files, but only the paths your coordinator assigned to you. Never edit files owned by another writer.' : 'You are READ-ONLY: never modify project files. Analyse, verify and report.'}
${this.dirs.length ? `- Besides the project directory this team always works with: ${this.dirs.map((d) => `\`${d}\``).join(', ')} (absolute paths, wherever orq was opened; your coordinator's instructions say what is there).\n` : ''}- Messages from colleagues arrive as "📬" prompts. Answer them with the company tools.
- \`team\` shows the live board; \`team\` with \`agent\` shows that colleague's history (\`view: activity\`) or terminal (\`view: screen\`).
- Communicate in Spanish with the user; code, commits and technical docs in English.
${role.id === this.lead ? `
## You are the COORDINATOR of this team
${
  this.profile === 'max'
    ? `- Every prompt you receive comes with a "Live team board": status, task, current tool, last finished task
  and last messages of every colleague, plus the recent conversations between them. Use it: you are
  responsible for knowing who is doing what, what is blocked and what is done.`
    : `- You get the full "Live team board" when your session starts; after that, each prompt carries only a
  "Team changes since HH:MM" line (status, task, last done, blocks, joins/leaves) when something changed.
  Call \`team\` for the full board. You are responsible for knowing who is doing what, what is
  blocked and what is done.`
}
- Before delegating, check the board: do not assign work to someone busy with something more important,
  and never give overlapping file paths to two writers.
- When a colleague is blocked (waiting for permission, stopped, no progress), act: unblock, reassign
  or tell the user. You will receive system alerts for blocked or stopped colleagues.
- When you need more than the board shows, use \`team\` with \`agent\` (their history, or \`view: screen\`
  for their terminal right now) before asking them.
- Your final report must reflect the whole team's work, not only yours.${
  this.profile === 'max'
    ? ''
    : `
- Do not greet or broadcast to the team at start; contact a colleague only when you have a concrete task or question for them.
  Colleagues marked "dormant — starts on first task" are available: your first task starts their session.`
}
- As soon as the goal is clear, call \`set_title\` with a short title for this session (at most ${MAX_TITLE_WORDS} words,
  in Spanish, e.g. "Modo de equipo por áreas"). Update it if the goal changes substantially.
` : ''}`;
  }

  /** Live snapshot of every other employee, given to the coordinator so it knows what the team is doing. */
  teamBoard(forId: string) {
    const clock = (ts: number) => new Date(ts).toLocaleTimeString('es-ES', { hour12: false });
    const rows = [...this.agents.values()]
      .filter((x) => x.id !== forId)
      .map((x) =>
        [
          `- \`${x.id}\` (${x.role.title}, ${x.role.writes ? 'writer' : 'read-only'}) — ${statusText(x)}${x.notice ? ` ⚠ ${short(x.notice, 100)}` : ''}`,
          `  task: ${x.task || '—'}`,
          x.status === 'working' && x.lastTool ? `  doing now: ${x.lastTool}` : '',
          x.lastDone ? `  last done: ${x.lastDone}` : '',
          x.lastOut ? `  last sent ${x.lastOut}` : '',
          x.lastIn ? `  last received ${x.lastIn}` : '',
          x.children.length ? `  subagents: ${x.children.map((c) => c.desc).join(', ')}` : '',
          x.inbox.length ? `  unread messages: ${x.inbox.length}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    const cross = this.messages
      .filter((m) => m.from !== forId && m.to !== forId)
      .slice(-10)
      .map((m) => `- ${clock(m.ts)} ${m.from} → ${m.to} [${m.type}]: ${short(m.body, 200)}`);
    // Hook context is capped at 10k chars: fall back to one line per employee for big teams.
    let body = rows.join('\n');
    if (body.length > 6500)
      body = [...this.agents.values()]
        .filter((x) => x.id !== forId)
        .map((x) => `- \`${x.id}\` ${statusText(x)}${x.notice ? ' ⚠ blocked' : ''} · task: ${short(x.task || '—', 70)}${x.lastDone ? ` · done: ${short(x.lastDone, 50)}` : ''}`)
        .join('\n');
    return [
      `## Live team board (${clock(Date.now())})`,
      body || '(no other employees)',
      '',
      '## Recent messages between other employees',
      cross.join('\n') || '(none)',
      '',
      'Use `team` with `agent` for more detail on anyone (history, or `view: "screen"` for their terminal).',
    ].join('\n');
  }

  private boardRows(forId: string): Record<string, BoardRow> {
    const rows: Record<string, BoardRow> = {};
    for (const x of this.agents.values())
      if (x.id !== forId) rows[x.id] = { status: x.status, task: x.task, lastDone: x.lastDone ?? '', notice: x.notice ?? '' };
    return rows;
  }

  /**
   * Team board context for a coordinator turn. The full board on session start, in profile 'max' or
   * when nothing was sent yet; otherwise one compact line with what changed since the last board it
   * got (status, task, last done, blocked notice, joins/leaves, messages between others), or
   * undefined when nothing changed.
   */
  boardFor(forId: string, full = false): string | undefined {
    const rows = this.boardRows(forId);
    const prev = this.boardSent.get(forId);
    // Computing the board moves the baseline: the caller must send what this returns.
    this.boardSent.set(forId, { at: Date.now(), rows, msgs: this.messages.length });
    if (full || this.profile === 'max' || !prev) return this.teamBoard(forId);
    const changes: string[] = [];
    for (const [id, r] of Object.entries(rows)) {
      const p = prev.rows[id];
      const state = `${r.status}${r.task ? ` «${short(r.task, 60)}»` : ''}`;
      if (!p) {
        const r2 = this.agents.get(id)!.role;
        changes.push(`${id} joined (${r2.title}, ${r2.writes ? 'writer' : 'read-only'}): ${state}`);
        continue;
      }
      if (r.lastDone && r.lastDone !== p.lastDone) changes.push(`${id} → done «${short(r.lastDone, 80)}»`);
      if (r.status !== p.status || r.task !== p.task) changes.push(`${id}: ${state}`);
      if (r.notice && r.notice !== p.notice) changes.push(`${id} ⚠ «${short(r.notice, 80)}»`);
      else if (!r.notice && p.notice) changes.push(`${id} unblocked`);
    }
    for (const id of Object.keys(prev.rows)) if (!rows[id]) changes.push(`${id} left the team`);
    const cross = this.messages.slice(prev.msgs).filter((m) => m.from !== forId && m.to !== forId);
    if (cross.length)
      changes.push(
        `${cross.length} new message${cross.length === 1 ? '' : 's'} between others: ${cross
          .slice(-3)
          .map((m) => `${m.from} → ${m.to} [${m.type}] «${short(m.body, 60)}»`)
          .join(' | ')}`,
      );
    if (!changes.length) return undefined;
    const clock = new Date(prev.at).toLocaleTimeString('es-ES', { hour12: false, hour: '2-digit', minute: '2-digit' });
    return `Team changes since ${clock}: ${changes.join('; ')}. (Full board: \`team\`.)`;
  }

  private isCoordinator(id: string) {
    return id === this.lead;
  }

  /** Tell the coordinator about something it cannot see from its own session. */
  private alertLead(about: Agent, text: string) {
    if (!this.lead || this.lead === about.id || !this.agents.has(this.lead)) return;
    this.post('system', this.lead, text, 'system');
  }

  private checkSessions() {
    let dirty = false;
    // One notice per dialog kind, saying how many agents are showing it right now.
    const showing = new Map<string, string[]>();
    for (const a of this.agents.values()) {
      if (a.status === 'stopped' || a.status === 'dormant') continue;
      if (a.status === 'starting') {
        const screen = tmux.capture(tmux.win(a.tmux, 'claude'));
        for (const d of DIALOGS) if (d.re.test(screen)) showing.set(d.kind, [...(showing.get(d.kind) ?? []), a.id]);
      }
      if (!tmux.hasSession(a.tmux) || tmux.isPaneDead(a.tmux)) {
        a.status = 'stopped';
        this.track(a, 'system', 'La sesión de claude ha terminado');
        this.alertLead(a, `Employee \`${a.id}\` (${a.role.title}) is no longer running: its Claude session ended. Its current task was: ${a.task || '—'}. Reassign the work or ask the user to restart it.`);
        dirty = true;
      }
    }
    for (const d of DIALOGS) {
      const ids = showing.get(d.kind);
      if (!ids) continue;
      const text = d.text(this.cwd, ids.length);
      const existing = this.notices.find((n) => n.kind === d.kind);
      if (!existing) this.notices.push({ id: uid(), kind: d.kind, from: ids[0]!, text });
      else if (existing.text === text) continue;
      else existing.text = text;
      dirty = true;
    }
    if (dirty) this.changed();
  }

  private track(a: Agent, kind: TimelineKind, text: string) {
    a.timeline.push({ ts: Date.now(), kind, text });
    this.store.event({ kind: 'timeline', agent: a.id, tkind: kind, text });
    if (a.timeline.length > MAX_TIMELINE) a.timeline.splice(0, a.timeline.length - MAX_TIMELINE);
  }

  // ------------------------------------------------------------------- bus

  post(from: string, to: string, body: string, type: MsgType = 'message', extra: Pick<Msg, 'options' | 'replyTo'> = {}): Msg {
    if (to !== USER && !this.agents.has(to)) throw new Error(`Unknown employee "${to}". Use the \`team\` tool.`);
    const msg: Msg = { id: uid(), ts: Date.now(), from, to, type, body, ...(extra.options?.length ? { options: extra.options } : {}), ...(extra.replyTo ? { replyTo: extra.replyTo } : {}) };
    this.messages.push(msg);
    this.store.event({ kind: 'message', ...msg });
    // Provisional title: the user's first task or message to the lead (never an answer), or else the first task.
    const asks = from === USER && to === this.lead && (type === 'task' || type === 'message');
    if (!this.title && !this.noAutoTitle && (asks || type === 'task')) this.setTitle(short(body, PROVISIONAL_TITLE_CHARS), 'auto');
    const sender = this.agents.get(from);
    if (sender) {
      sender.lastOut = `→ ${to}: ${short(body, 120)}`;
      this.track(sender, 'msg_out', `[${type}] → ${to}: ${body}`);
      this.store.agentLog(from, `${type} → ${to}`, body);
    }
    const target = this.agents.get(to);
    if (target) {
      target.lastIn = `← ${from}: ${short(body, 120)}`;
      target.lastInAt = Date.now();
      target.inbox.push(msg);
      this.track(target, 'msg_in', `[${type}] ← ${from}: ${body}`);
      this.store.agentLog(to, `${type} ← ${from}`, body);
      if (type === 'task') target.task = short(body, 60);
      if (this.wakes(msg)) this.scheduleWake(target);
      else this.schedulePending(target);
    } else if (to === USER && (type === 'question' || type === 'report')) {
      this.notices.push({ id: msg.id, kind: type === 'question' ? 'question' : 'info', from, text: body, options: msg.options, msgId: msg.id });
    }
    this.changed();
    return msg;
  }

  /** The user's answer to a message (usually a question): posted as 'answer' and the notice resolved. */
  reply(msgId: string, text: string): Msg | undefined {
    const q = this.messages.find((m) => m.id === msgId);
    if (!q || !this.agents.has(q.from)) return;
    this.notices = this.notices.filter((n) => n.msgId !== msgId && n.id !== msgId);
    return this.post(USER, q.from, text, 'answer', { replyTo: msgId });
  }

  /** The answer the user gave to a message, if any. */
  answerOf(msgId: string): Msg | undefined {
    return this.messages.find((m) => m.replyTo === msgId);
  }

  /** Pending messages of an agent (plus its primer after a clear), formatted, and emptied. */
  /** Pending messages of an agent (plus its primer after a clear), formatted, and emptied; recorded as delivered. */
  private takeInbox(a: Agent) {
    const { text, msgs } = this.takePending(a);
    this.markDelivered(a, msgs);
    return text;
  }

  private takePending(a: Agent) {
    const primer = a.primer;
    a.primer = undefined;
    const msgs = a.inbox.splice(0);
    const text = [primer, msgs.length ? this.formatInbox(msgs) : ''].filter(Boolean).join('\n\n');
    return { text, msgs, primer };
  }

  private markDelivered(a: Agent, msgs: Msg[]) {
    if (msgs.length) this.store.event({ kind: 'delivered', agent: a.id, ids: msgs.map((m) => m.id) });
    const asked = msgs.findLast((m) => m.from === USER && (m.type === 'task' || m.type === 'message'));
    if (asked) a.answering = asked.id;
  }

  /** A prompt the user typed in an agent's terminal, recorded in Mensajes (already delivered: never queued). */
  private recordTerminalPrompt(a: Agent, body: string) {
    const msg: Msg = { id: uid(), ts: Date.now(), from: USER, to: a.id, type: 'message', body };
    this.messages.push(msg);
    this.store.event({ kind: 'message', ...msg });
    this.store.event({ kind: 'delivered', agent: a.id, ids: [msg.id] });
    a.lastIn = `← ${USER}: ${short(body, 120)}`;
    a.lastInAt = msg.ts;
    a.answering = msg.id;
  }

  /**
   * End of a turn started by a user task/message: if the agent wrote nothing to the user meanwhile
   * (it answered in its terminal), its final text is recorded in Mensajes as the answer.
   */
  private recordTurnAnswer(a: Agent, text: string | undefined) {
    const askedId = a.answering;
    a.answering = undefined;
    const i = askedId ? this.messages.findIndex((m) => m.id === askedId) : -1;
    if (i < 0 || !text) return;
    if (this.messages.slice(i + 1).some((m) => m.from === a.id && m.to === USER)) return;
    const msg: Msg = { id: uid(), ts: Date.now(), from: a.id, to: USER, type: 'answer', body: text, replyTo: askedId };
    this.messages.push(msg);
    this.store.event({ kind: 'message', ...msg });
    a.lastOut = `→ ${USER}: ${short(text, 120)}`;
  }

  private formatInbox(msgs: Msg[]) {
    const lines = msgs.map((m) => {
      const who = m.from === USER ? 'the user (user)' : `${this.agents.get(m.from)?.role.title ?? m.from} (${m.from})`;
      const q = m.replyTo ? this.messages.find((x) => x.id === m.replyTo) : undefined;
      const re = q ? ` (re: "${short(q.body, 120)}")` : '';
      return `[${m.type}] from ${who}${re}:\n${m.body}`;
    });
    return `📬 New company messages:\n\n${lines.join('\n\n---\n\n')}\n\n(Answer with the mcp__company__* tools.)`;
  }

  /**
   * Whether a message wakes its (idle) recipient. In 'max' everything does. Otherwise these wait in
   * the inbox for the next wake-up (never dropped, and at most pendingWakeMs): FYI messages that do
   * not answer an open conversation, and report copies to third parties. Tasks, questions, answers,
   * system alerts, blocked/partial reports, reports to whoever assigned the task and messages
   * answering the recipient wake at once.
   */
  private wakes(msg: Msg): boolean {
    if (this.profile === 'max') return true;
    const i = this.messages.indexOf(msg);
    const before = i >= 0 ? this.messages.slice(0, i) : this.messages;
    if (msg.type === 'message') {
      // Open conversation: the recipient wrote to the sender after the sender's last message to it.
      const asked = before.findLastIndex((m) => m.from === msg.to && m.to === msg.from);
      const said = before.findLastIndex((m) => m.from === msg.from && m.to === msg.to);
      return asked >= 0 && asked > said;
    }
    if (msg.type !== 'report') return true;
    if (/^\[(blocked|partial)\]/.test(msg.body)) return true;
    return before.some((m) => m.type === 'task' && m.from === msg.to && m.to === msg.from);
  }

  /** Delay that batches several messages into one wake-up (never delays a wake-up more than this; 0 in 'max'). */
  wakeDelayMs = 2000;
  /** Longest an idle agent keeps messages that did not wake it. */
  pendingWakeMs = 60_000;
  private wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Clear the wake, pending, housekeeping, command and delivery timers (of one agent, or all), and in-flight deliveries. */
  private clearWakeTimers(id?: string) {
    for (const k of [...this.delivering.keys()]) if (!id || k === id) this.delivering.delete(k);
    for (const timers of [this.wakeTimers, this.pendingTimers, this.housekeepTimers, this.commandTimers, this.deliveryTimers])
      for (const [k, t] of timers)
        if (!id || k === id) {
          clearTimeout(t);
          timers.delete(k);
        }
  }

  /** Wake the agent soon (batching), or once it is idle again if it is busy right now. */
  private scheduleWake(a: Agent) {
    if (a.status === 'dormant') return this.wakeDormant(a);
    if (this.profile === 'max' && a.status === 'idle') return this.deliver(a);
    if (this.wakeTimers.has(a.id)) return;
    this.wakeTimers.set(
      a.id,
      setTimeout(() => {
        this.wakeTimers.delete(a.id);
        this.wakeNow(a);
      }, this.profile === 'max' ? 0 : this.wakeDelayMs),
    );
  }

  /** The agent just became idle: replace any slow retry by a normal (batched) wake-up. */
  private wakeAgain(a: Agent) {
    clearTimeout(this.wakeTimers.get(a.id));
    this.wakeTimers.delete(a.id);
    this.scheduleWake(a);
  }

  /** Make sure messages that did not wake an idle agent reach it within pendingWakeMs. */
  private schedulePending(a: Agent) {
    if (this.pendingTimers.has(a.id)) return;
    this.pendingTimers.set(
      a.id,
      setTimeout(() => {
        this.pendingTimers.delete(a.id);
        this.wakeNow(a);
      }, this.pendingWakeMs),
    );
  }

  /**
   * Deliver now if idle. A working agent gets its inbox from its own hooks (Stop, Notification,
   * SessionStart), so nothing is retried; waiting/starting agents are retried at most once a second.
   */
  private wakeNow(a: Agent) {
    if (this.agents.get(a.id) !== a || !a.inbox.length || a.status === 'stopped' || a.status === 'working') return;
    // A dormant agent only starts for a waking message: FYI alone waits for one.
    if (a.status === 'dormant') return a.inbox.some((m) => this.wakes(m)) ? this.wakeDormant(a) : undefined;
    if (a.status === 'idle') return this.deliver(a);
    if (this.wakeTimers.has(a.id)) return;
    this.wakeTimers.set(
      a.id,
      setTimeout(() => {
        this.wakeTimers.delete(a.id);
        this.wakeNow(a);
      }, Math.max(this.wakeDelayMs, 1000)),
    );
  }

  /** Wake an idle agent by typing its pending messages into its session. */
  /**
   * Type the inbox into an idle agent's session. It counts as delivered only once confirmed (its
   * UserPromptSubmit, or the input box emptied after Enter); otherwise Enter is retried with backoff
   * and, if it never goes through, the messages go back to the inbox.
   */
  private deliver(a: Agent) {
    if (a.status !== 'idle' || a.inbox.length === 0 || this.delivering.has(a.id)) return;
    // Its prompt cache expired: the whole context would be written again. A reader between tasks
    // starts clean instead; SessionStart then delivers the primer and the inbox.
    const idleMs = this.staleFor(a);
    if (idleMs !== undefined) return this.clearSession(a, `Empezó limpio: ${Math.round(idleMs / 60_000)} min inactivo (caché caducada)`);
    const { text, msgs, primer } = this.takePending(a);
    a.status = 'working';
    this.delivering.set(a.id, { msgs, primer, text });
    this.typeInto(a, text);
    this.submitStep(a, 0, Date.now());
  }

  /** Timing of the submit confirmation (overridable in tests). */
  deliveryTiming = { pollMs: 250, pasteWaitMs: 2000, backoffMs: [1000, 1500, 2500] };
  private delivering = new Map<string, { msgs: Msg[]; primer?: string; text: string }>();
  private deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private later(a: Agent, ms: number, fn: () => void) {
    this.deliveryTimers.set(
      a.id,
      setTimeout(() => {
        this.deliveryTimers.delete(a.id);
        if (this.delivering.has(a.id) && this.agents.get(a.id) === a) fn();
      }, ms),
    );
  }

  /** Wait for the paste to show, press Enter, check; `tries` Enters pressed so far. */
  private submitStep(a: Agent, tries: number, since: number) {
    const d = this.delivering.get(a.id)!;
    const t = this.deliveryTiming;
    if (tries === 0 && !this.inputShows(a, d.text) && Date.now() - since < t.pasteWaitMs) return this.later(a, t.pollMs, () => this.submitStep(a, 0, since));
    // Submitted: the input box no longer holds our paste, or claude is already working on it.
    if (tries > 0 && (!this.inputShows(a, d.text) || this.claudeWorking(a))) return this.deliveryConfirmed(a);
    if (tries >= t.backoffMs.length) return this.deliveryFailed(a);
    this.pressEnter(a);
    this.later(a, t.backoffMs[tries]!, () => this.submitStep(a, tries + 1, since));
  }

  private deliveryConfirmed(a: Agent) {
    const d = this.delivering.get(a.id);
    if (!d) return;
    this.delivering.delete(a.id);
    clearTimeout(this.deliveryTimers.get(a.id));
    this.deliveryTimers.delete(a.id);
    this.markDelivered(a, d.msgs);
  }

  /**
   * Enter never went through. Never interrupts claude: if it is working the delivery counts as
   * done; otherwise only our paste is erased (C-u, no Escape) and the messages go back to the inbox.
   */
  private deliveryFailed(a: Agent) {
    if (this.claudeWorking(a)) return this.deliveryConfirmed(a);
    const d = this.delivering.get(a.id)!;
    if (this.inputShows(a, d.text)) this.clearLine(a);
    this.cancelDelivery(a);
    a.status = 'idle';
    this.track(a, 'system', '⚠ entrega no confirmada');
    this.schedulePending(a);
    this.changed();
  }

  /** Drop an in-flight delivery, putting its messages (and primer) back at the front of the inbox. */
  private cancelDelivery(a: Agent) {
    const d = this.delivering.get(a.id);
    if (!d) return;
    this.delivering.delete(a.id);
    clearTimeout(this.deliveryTimers.get(a.id));
    this.deliveryTimers.delete(a.id);
    a.inbox.unshift(...d.msgs);
    a.primer ??= d.primer;
  }

  private typeInto(a: Agent, text: string) {
    tmux.paste(a.tmux, text);
  }

  private pressEnter(a: Agent) {
    tmux.sendKeys(tmux.win(a.tmux, 'claude'), ['Enter']);
  }

  private clearLine(a: Agent) {
    tmux.sendKeys(tmux.win(a.tmux, 'claude'), ['C-u']);
  }

  /** Visible text of the agent's claude pane, without ANSI escapes. */
  private paneText(a: Agent) {
    return tmux.capture(tmux.win(a.tmux, 'claude')).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  }

  /**
   * Whether our paste still sits in the input box. Only the box is read (the last rows, between the
   * prompt borders): earlier pastes stay visible in the history above it.
   */
  private inputShows(a: Agent, text: string) {
    const box = inputBox(this.paneText(a));
    const lines = text.split('\n').filter((l) => l.trim());
    const first = lines[0]?.trim().slice(0, 40) ?? '';
    // The inbox always ends with this fixed line: visible when the box only shows the paste's tail.
    const last = lines.at(-1)?.trim().slice(-40) ?? '';
    return /\[Pasted text #\d+/.test(box) || (!!first && box.includes(first)) || (!!last && box.includes(last));
  }

  /** claude is running a turn (its status line offers "esc to interrupt"). */
  private claudeWorking(a: Agent) {
    return /esc (to )?interrupt/i.test(this.paneText(a).split('\n').slice(-12).join('\n'));
  }

  answerNotice(id: string, accept: boolean, roles: Role[]) {
    const n = this.notices.find((x) => x.id === id);
    this.notices = this.notices.filter((x) => x.id !== id);
    const dialog = DIALOGS.find((d) => d.kind === n?.kind);
    if (dialog) {
      // Both dialogs list "No, exit" first: move down to the accept option, or confirm the exit.
      for (const a of this.agents.values())
        if (a.status === 'starting' && dialog.re.test(tmux.capture(tmux.win(a.tmux, 'claude'))))
          tmux.sendKeys(tmux.win(a.tmux, 'claude'), accept ? ['Down', 'Enter'] : ['Enter']);
    }
    if (n?.kind === 'hire' && n.role) {
      const role = roles.find((r) => r.id === n.role);
      if (accept && role) this.hire(role);
      if (this.agents.has(n.from))
        this.post('system', n.from, accept && role ? `Hire approved: \`${n.role}\` has joined.` : `Hire of \`${n.role}\` rejected by the user.`, 'system');
    }
    this.changed();
  }

  // ------------------------------------------------------------- context

  /** Whether the agent has a task it has not reported done yet. */
  private hasOpenTask(a: Agent, ignore: ReadonlySet<Msg> = new Set()) {
    const task = this.messages.findLastIndex((m) => m.to === a.id && m.type === 'task' && !ignore.has(m));
    const done = this.messages.findLastIndex((m) => m.from === a.id && m.type === 'report' && m.body.startsWith('[done]'));
    return task > done;
  }

  /** Idle between tasks: no open task and nothing in the inbox (so no wake-up on its way). */
  private betweenTasks(a: Agent) {
    return a.status === 'idle' && !a.inbox.length && !this.hasOpenTask(a);
  }

  housekeepDelayMs = 1500;

  /** After a turn, once claude has settled: a big context gets compacted between tasks. */
  private housekeepTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleHousekeep(a: Agent) {
    if (this.profile === 'max') return;
    clearTimeout(this.housekeepTimers.get(a.id));
    this.housekeepTimers.set(
      a.id,
      setTimeout(() => {
        this.housekeepTimers.delete(a.id);
        this.housekeep(a);
      }, this.housekeepDelayMs),
    );
  }

  /** Whether `/clear` and `/compact` mean something in this agent's terminal (Claude Code and orq's own runner; not opencode). */
  private hasContextCommands(a: Agent) {
    return this.providerFor(a.role).kind !== 'opencode';
  }

  private housekeep(a: Agent) {
    if (!this.hasContextCommands(a) || this.profile === 'max' || this.agents.get(a.id) !== a || !this.betweenTasks(a)) return;
    // Only compaction above the profile threshold. Clearing is manual (hq.clear): an automatic /clear
    // after each task rewrote the ~45k cached prefix and cost more than it saved (qa measurement).
    const limit = COMPACT_AT[this.profile];
    if (!limit || (a.ctxTokens ?? 0) <= limit) return;
    // A 'saver' reader restarts from orq's summary + `memory` notes: /compact would pay for a model
    // call over the whole context, /clear only rewrites the small primer (writers and the lead keep theirs).
    if (this.profile === 'saver' && !a.role.writes && a.id !== this.lead && !a.clearFailed) this.clearSession(a, `Contexto reiniciado con resumen de orq (${kTokens(a.ctxTokens ?? 0)})`);
    else if (!a.compactFailed) this.compactSession(a);
  }

  /** UI button: clear an idle agent's context (keeps its role and protocol). */
  clear(id: string): boolean {
    const a = this.agents.get(id);
    if (!a || a.status !== 'idle' || !this.hasContextCommands(a)) return false;
    this.clearSession(a, 'Contexto limpiado');
    return true;
  }

  /** UI button: compact an idle agent's context. */
  compact(id: string): boolean {
    const a = this.agents.get(id);
    if (!a || a.status !== 'idle' || !this.hasContextCommands(a)) return false;
    this.compactSession(a);
    return true;
  }

  /** Last request time and cache TTL of an agent (from its transcript; overridable in tests). */
  private lastRequestOf(a: Agent) {
    return lastRequest(a.transcriptPath);
  }

  /**
   * How long a 'saver' reader with no open task (besides what is in its inbox) has been idle past its
   * prompt cache TTL; undefined when it should just get its messages (writers and the lead never clear).
   */
  private staleFor(a: Agent): number | undefined {
    if (this.profile !== 'saver' || a.role.writes || a.id === this.lead || a.clearFailed) return undefined;
    if (this.hasOpenTask(a, new Set(a.inbox))) return undefined;
    const last = this.lastRequestOf(a);
    if (!last) return undefined;
    const idle = Date.now() - last.at;
    // Same boundary as estimateResume: an age equal to the TTL is already cold.
    return idle >= last.ttlMs ? idle : undefined;
  }

  private clearSession(a: Agent, text: string) {
    a.ctxTokens = 0;
    // The new session starts from the light-resume summary of this agent; what waits in its inbox
    // follows in full, so it is left out of the summary.
    a.primer = buildResumeSummary(a.id, this.store.readEvents(SUMMARY_KINDS), this.currentMeta(), new Set(a.inbox.map((m) => m.id)));
    // Busy until claude restarts the session (SessionStart, source "clear").
    a.status = 'working';
    this.runCommand(a, '/clear');
    this.track(a, 'system', text);
    this.changed();
  }

  private compactSession(a: Agent) {
    a.compactedFrom = a.ctxTokens ?? 0;
    a.status = 'working';
    this.runCommand(a, '/compact');
    this.track(a, 'system', `Compactando contexto (${kTokens(a.compactedFrom)})`);
    this.changed();
  }

  /** How long a slash command may take before the agent is considered stuck and freed. */
  commandTimeoutMs: Record<string, number> = { '/clear': 30_000, '/compact': 300_000 };
  private commandTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Type a slash command; if claude never restarts or finishes a turn, free the agent again. */
  private runCommand(a: Agent, cmd: '/clear' | '/compact') {
    this.typeCommand(a, cmd);
    clearTimeout(this.commandTimers.get(a.id));
    this.commandTimers.set(
      a.id,
      setTimeout(() => {
        this.commandTimers.delete(a.id);
        if (this.agents.get(a.id) !== a) return;
        // Neither SessionStart nor Stop came: the command is not available in this session.
        if (cmd === '/compact' && a.compactedFrom !== undefined) this.compactUnavailable(a);
        if (cmd === '/clear') {
          // The context was not cleared: the summary meant for a new session would be noise.
          a.primer = undefined;
          if (!a.clearFailed) {
            a.clearFailed = true;
            this.track(a, 'system', '⚠ /clear no disponible');
          }
        }
        if (a.status !== 'working') return this.changed();
        a.status = 'idle';
        this.track(a, 'system', `⚠ ${cmd} no se completó`);
        // The command may still sit typed in the input line: clear it before pasting the inbox.
        this.clearInput(a);
        this.deliver(a);
        this.changed();
      }, this.commandTimeoutMs[cmd] ?? 60_000),
    );
  }

  /** Never compact this agent automatically again. */
  private compactUnavailable(a: Agent) {
    a.compactedFrom = undefined;
    if (a.compactFailed) return;
    a.compactFailed = true;
    this.track(a, 'system', '⚠ /compact no disponible');
  }

  /** The command finished (SessionStart or Stop from the agent). */
  private commandDone(id: string) {
    clearTimeout(this.commandTimers.get(id));
    this.commandTimers.delete(id);
  }

  private clearInput(a: Agent) {
    tmux.sendKeys(tmux.win(a.tmux, 'claude'), ['Escape', 'C-u']);
  }

  private typeCommand(a: Agent, cmd: string) {
    const win = tmux.win(a.tmux, 'claude');
    // Clear whatever the user may have left typed in the input line first.
    tmux.sendKeys(win, ['C-u']);
    tmux.sendLiteral(win, cmd);
    setTimeout(() => tmux.sendKeys(win, ['Enter']), 300);
  }

  // ----------------------------------------------------------------- hooks

  /** Last time each agent's context size was read during a turn. */
  private ctxReadAt = new Map<string, number>();

  private onHook(id: string, p: Record<string, any>): Record<string, unknown> {
    const a = this.agents.get(id);
    if (!a) return {};
    if (p.transcript_path) {
      a.transcriptPath = p.transcript_path;
      a.transcriptDir = path.dirname(p.transcript_path);
    }
    // /clear (and some resumes) continue in a new Claude session: keep the old id for accounting.
    if (p.session_id && p.session_id !== a.sessionId) {
      a.prevSessionIds = [...(a.prevSessionIds ?? []), a.sessionId];
      a.sessionId = String(p.session_id);
      this.saveMeta();
    }
    const ev = p.hook_event_name as string;
    // Agents that are not Claude Code (runner.ts) report their own context size.
    if (typeof p.context_tokens === 'number') a.ctxTokens = p.context_tokens;
    let out: Record<string, unknown> = {};
    const withBoard = (event: string) => {
      const board = this.isCoordinator(id) ? this.boardFor(id, event === 'SessionStart') : undefined;
      return board ? { hookSpecificOutput: { hookEventName: event, additionalContext: board } } : {};
    };
    switch (ev) {
      case 'SessionStart':
        this.commandDone(id);
        // After a compaction the old size is stale until the next turn reports it.
        if ((p.source === 'compact' || a.compactedFrom !== undefined) && typeof p.context_tokens !== 'number') a.ctxTokens = undefined;
        a.status = 'idle';
        this.saveMeta();
        setTimeout(() => this.deliver(a), this.sessionStartDeliverMs);
        out = withBoard('SessionStart');
        break;
      case 'UserPromptSubmit': {
        a.status = 'working';
        a.notice = undefined;
        const ours = this.delivering.has(a.id);
        this.deliveryConfirmed(a);
        // Bracketed pastes reach the prompt wrapped in <pasted_content> tags.
        const prompt = String(p.prompt ?? '').replace(/<\/?pasted_content[^>]*>/g, '').trim();
        this.track(a, 'prompt', prompt);
        if (!prompt.startsWith('📬')) this.store.agentLog(id, 'prompt (terminal)', prompt);
        // Typed by the user in the agent's terminal (not a delivery or a slash command): it goes to Mensajes too.
        if (!ours && prompt && !prompt.startsWith('📬') && !prompt.startsWith('/')) this.recordTerminalPrompt(a, prompt);
        out = withBoard('UserPromptSubmit');
        // Messages that did not wake the agent ride along with its next real turn (not slash commands).
        if ((a.inbox.length || a.primer) && !prompt.startsWith('/')) {
          const inbox = this.takeInbox(a);
          const prev = (out as any).hookSpecificOutput?.additionalContext;
          out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: prev ? `${inbox}\n\n${prev}` : inbox } };
        }
        break;
      }
      case 'PreToolUse': {
        a.status = 'working';
        a.notice = undefined;
        const tool = String(p.tool_name ?? '');
        const input = (p.tool_input ?? {}) as Record<string, any>;
        const denied = orqDataAccess(tool, input, this.cwd, ORQ_HOME);
        if (denied) {
          this.track(a, 'system', `⛔ Acceso a datos de orq bloqueado (${tool}: ${short(denied, 80)})`);
          this.store.event({ kind: 'hook', agent: id, event: ev, tool, denied });
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: ORQ_DATA_DENIED } };
        }
        a.lastTool = describeTool(tool, input);
        if (!tool.startsWith('mcp__company__')) this.track(a, 'tool', a.lastTool);
        // Full path (the timeline text is truncated), for the light-resume summary.
        const file = input.file_path ?? input.notebook_path;
        if (EDIT_TOOLS.has(tool) && typeof file === 'string') this.store.event({ kind: 'edit', agent: id, file });
        if (SUBAGENT_TOOLS.has(tool)) {
          const desc = String(input.description ?? input.subagent_type ?? 'subagente');
          a.children.push({ id: String(p.tool_use_id ?? uid()), desc, startedAt: Date.now() });
          this.track(a, 'subagent', `Lanza subagente: ${desc}`);
        }
        break;
      }
      case 'PostToolUse': {
        const tool = String(p.tool_name ?? '');
        // Keep the context size fresh during long turns (otherwise it only updates on Stop).
        if (a.compactedFrom === undefined && Date.now() - (this.ctxReadAt.get(id) ?? 0) >= CTX_REFRESH_MS) {
          this.ctxReadAt.set(id, Date.now());
          a.ctxTokens = contextTokens(a.transcriptPath) ?? a.ctxTokens;
        }
        if (SUBAGENT_TOOLS.has(tool)) {
          const desc = String(p.tool_input?.description ?? '');
          const i = a.children.findIndex((c) => c.id === p.tool_use_id || c.desc === desc);
          if (i >= 0) a.children.splice(i, 1);
        }
        break;
      }
      case 'Notification': {
        const msg = String(p.message ?? '');
        if (/waiting for your input/i.test(msg)) {
          a.status = 'idle';
          if (a.inbox.some((m) => this.wakes(m))) this.wakeAgain(a);
        }
        else {
          const was = a.status;
          a.status = 'waiting';
          a.notice = msg;
          this.track(a, 'system', `⚠ ${msg}`);
          if (was !== 'waiting')
            this.alertLead(a, `Employee \`${a.id}\` (${a.role.title}) is blocked: "${msg}". The user has to answer it in that agent's terminal. Its task: ${a.task || '—'}.`);
        }
        break;
      }
      case 'Stop': {
        // The hook payload has this turn's final text; the transcript may not be flushed yet.
        const last = String(p.last_assistant_message ?? '').trim() || lastAssistantText(a.transcriptPath);
        if (last) {
          this.track(a, 'assistant', last);
          this.store.agentLog(id, 'assistant', last);
        }
        a.children = [];
        if (a.inbox.length && a.stopBlocks < MAX_STOP_BLOCKS) {
          a.stopBlocks++;
          const inbox = this.takeInbox(a);
          const board = this.isCoordinator(id) ? this.boardFor(id) : undefined;
          const reason = board ? `${inbox}\n\n${board}` : inbox;
          this.changed();
          return { decision: 'block', reason };
        }
        a.stopBlocks = 0;
        a.status = 'idle';
        this.recordTurnAnswer(a, last);
        this.commandDone(id);
        // Out of Stop-hook injections with messages still pending: wake it again shortly.
        if (a.inbox.some((m) => this.wakes(m))) this.wakeAgain(a);
        a.ctxTokens = contextTokens(a.transcriptPath) ?? a.ctxTokens;
        if (a.compactedFrom !== undefined && a.ctxTokens !== undefined) {
          // A context that did not shrink means /compact did not run (e.g. typed as a plain prompt).
          if (a.ctxTokens >= a.compactedFrom) this.compactUnavailable(a);
          else this.track(a, 'system', `Contexto compactado (${kTokens(a.compactedFrom)} → ${kTokens(a.ctxTokens)})`);
          a.compactedFrom = undefined;
        }
        this.scheduleHousekeep(a);
        break;
      }
    }
    this.store.event({ kind: 'hook', agent: id, event: ev, tool: p.tool_name });
    this.changed();
    return out;
  }

  // ------------------------------------------------------------- MCP tools

  /**
   * Body as delivered to another agent: at most MAX_DELIVERED characters. The full text always goes to
   * the run log (and to the user unchanged), so nothing is lost; the recipient can ask for more.
   */
  private capForAgent(from: Agent, to: string, body: string) {
    if (to === USER || body.length <= MAX_DELIVERED) return body;
    this.store.log(from.id, `full message → ${to}`, body);
    const cut = body.slice(0, MAX_DELIVERED).replace(/\s+\S*$/, '');
    return `${cut}\n… [${body.length - cut.length} more characters cut by orq; ask ${from.id} if you need them]`;
  }

  /** `log` tool: append to the run log (LOG.md), or to a project file without reading it. */
  private appendLog(a: Agent, text: string, file?: string) {
    if (!text.trim()) throw new Error('Nothing to log: `text` is empty.');
    if (!file) {
      this.store.log(a.id, 'log', text);
      this.track(a, 'system', `📝 ${short(text, 100)}`);
      return 'logged';
    }
    if (!a.role.writes) throw new Error('You are read-only: you can only log to the run log (omit `file`).');
    const abs = path.resolve(this.cwd, file);
    const rel = path.relative(this.cwd, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('`file` must be inside the working directory.');
    if (orqDataAccess('Write', { file_path: abs }, this.cwd, ORQ_HOME)) throw new Error(ORQ_DATA_DENIED);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    fs.appendFileSync(abs, `${prev && !prev.endsWith('\n') ? '\n' : ''}${text.replace(/\s+$/, '')}\n`);
    this.store.event({ kind: 'edit', agent: a.id, file: abs });
    this.track(a, 'tool', `log → ${rel}`);
    return `appended to ${rel}`;
  }

  private onTool(id: string, tool: string, args: Record<string, any>): unknown {
    const a = this.agents.get(id);
    if (!a) throw new Error(`Unknown agent ${id}`);
    switch (tool) {
      case 'team': {
        // No agent: the live board. With an agent: its history or its terminal.
        if (!args.agent) return this.boardFor(id, true);
        return this.onTool(id, args.view === 'screen' ? 'agent_screen' : 'agent_activity', args);
      }
      // Pre-`team` tool names, still served for sessions launched with the old company server.
      case 'list_agents':
        return [...this.agents.values()].map((x) => ({
          id: x.id,
          title: x.role.title,
          coordinator: x.id === this.lead,
          status: statusText(x),
          current_task: x.task,
          doing_now: x.status === 'working' ? x.lastTool : undefined,
          last_done: x.lastDone,
          blocked_on: x.notice,
          writes_files: x.role.writes,
        }));
      case 'team_status':
        return this.boardFor(id, true);
      case 'agent_activity': {
        const t = this.agents.get(String(args.agent));
        if (!t) throw new Error(`Unknown employee "${args.agent}". Use the \`team\` tool.`);
        const n = Math.min(100, Number(args.limit ?? args.lines ?? 30));
        const clock = (ts: number) => new Date(ts).toLocaleTimeString('es-ES', { hour12: false });
        return [
          `# ${t.id} (${t.role.title}) — ${t.status}; task: ${t.task || '—'}`,
          ...t.timeline.slice(-n).map((e) => `${clock(e.ts)} [${e.kind}] ${short(e.text, 300)}`),
        ].join('\n');
      }
      case 'agent_screen': {
        const t = this.agents.get(String(args.agent));
        if (!t) throw new Error(`Unknown employee "${args.agent}". Use the \`team\` tool.`);
        const lines = Math.min(200, Number(args.lines ?? args.limit ?? 40));
        const screen = tmux
          .capture(tmux.win(t.tmux, 'claude'))
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\s+$/, '')
          .split('\n');
        return `# Terminal of ${t.id} (last ${lines} lines)\n${screen.slice(-lines).join('\n')}`;
      }
      case 'send_message': {
        const to = String(args.to);
        this.post(id, to, this.capForAgent(a, to, String(args.body)), (args.type as MsgType) ?? 'message');
        return 'sent';
      }
      case 'delegate_task':
        this.post(id, String(args.to), String(args.task), 'task');
        return `Task delegated to ${args.to}. They will report back to you.`;
      case 'report': {
        const status = String(args.status ?? 'done');
        const to = String(args.to);
        const summary = String(args.summary ?? '');
        if (args.details) this.store.log(id, `details of report → ${to} [${status}]`, String(args.details));
        this.post(id, to, `[${status}] ${this.capForAgent(a, to, summary)}`, 'report');
        this.store.report(id, to, status, summary);
        this.track(a, 'report', `${status}: ${summary}`);
        if (status === 'done') {
          a.task = '';
          a.lastDone = short(summary, 120);
        }
        return args.details ? 'reported (details saved to the run log)' : 'reported';
      }
      case 'log':
        return this.appendLog(a, String(args.text ?? ''), args.file ? String(args.file) : undefined);
      case 'set_status':
        a.task = short(String(args.task ?? ''), 60);
        this.track(a, 'status', a.task);
        this.changed();
        return 'ok';
      case 'memory': {
        // Notes and search live in the project's SQLite index: the sanctioned way to look at the
        // past, since agents may not read .orq/ (and replaying a transcript is what costs tokens).
        const text = String(args.text ?? '').trim();
        if (args.action === 'save') {
          if (!text) throw new Error('Nothing to save: `text` is empty.');
          this.store.event({ kind: 'note', agent: id, text: short(text, 1000) });
          return 'saved; it comes back in your summary after a /clear or resume';
        }
        if (!text) throw new Error('Nothing to search: `text` is empty.');
        const hits = this.store.search(text, { allRuns: args.scope === 'project', limit: Math.min(Number(args.limit) || 6, 15) });
        if (!hits.length) return 'No matches.';
        const out = hits.map((h) => `- ${new Date(h.ts).toLocaleString('es-ES', { hour12: false })} ${h.agent} [${h.kind}]${h.run !== this.runId ? ` run ${h.run}` : ''}: ${short(h.text, 300)}`).join('\n');
        return out.length > 2000 ? out.slice(0, 1999) + '…' : out;
      }
      case 'inbox':
        return a.inbox.length || a.primer ? this.takeInbox(a) : 'No pending messages.';
      case 'ask_user': {
        const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, 4) : undefined;
        this.post(id, USER, String(args.question), 'question', { options });
        return 'Question sent to the user. Their answer will arrive as a message; keep working on whatever does not depend on it.';
      }
      case 'set_title': {
        if (!this.isCoordinator(id)) throw new Error('Only the coordinator can set the session title.');
        const title = String(args.title ?? '').replace(/\s+/g, ' ').trim();
        if (!title) throw new Error('The title cannot be empty.');
        if (title.split(' ').length > MAX_TITLE_WORDS) throw new Error(`The title must have at most ${MAX_TITLE_WORDS} words.`);
        if (title.length > TITLE_MAX) throw new Error(`The title must have at most ${TITLE_MAX} characters.`);
        if (!this.setTitle(title, 'lead')) return `The user already named this session "${this.title}"; the title was not changed.`;
        this.track(a, 'system', `Título de la sesión: ${title}`);
        return `Session title set: ${title}`;
      }
      case 'request_hire': {
        const role = String(args.role);
        this.notices.push({ id: uid(), kind: 'hire', from: id, role, text: String(args.reason ?? '') });
        this.track(a, 'system', `Pide contratar a ${role}`);
        this.changed();
        return 'Hire request sent to the user. You will get a system message with the decision.';
      }
    }
    throw new Error(`Unknown tool ${tool}`);
  }
}

/** Agent status as told to the team: dormant agents are available, they start on their first task. */
const statusText = (a: Agent) => (a.status === 'dormant' ? 'dormant — starts on first task' : a.status);

const BOX_ROWS = 6;
/** Rows searched for the prompt borders: an expanded (not collapsed) paste can be tall. */
const BOX_SEARCH_ROWS = 40;
const isBorder = (l: string) => /^\s*[╭╰─━]/.test(l) && /[─━]{4,}/.test(l);

/** The input box of a claude pane: the rows between the last two prompt borders, or else the last BOX_ROWS rows. */
export function inputBox(screen: string): string {
  const lines = screen.replace(/\s+$/, '').split('\n');
  const tail = lines.slice(-BOX_SEARCH_ROWS);
  const borders = tail.map((l, i) => (isBorder(l) ? i : -1)).filter((i) => i >= 0);
  if (borders.length >= 2) return tail.slice(borders.at(-2)! + 1, borders.at(-1)!).join('\n');
  return lines.slice(-BOX_ROWS).join('\n');
}

function describeTool(tool: string, input: Record<string, any>) {
  if (tool.startsWith('mcp__company__')) return `📨 ${tool.replace('mcp__company__', '')}`;
  const arg = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? input.query ?? '';
  return short(`${tool} ${typeof arg === 'string' ? arg : ''}`, 90);
}

/** Last assistant text block of a Claude transcript (JSONL). */
/** User transcript entry typed as a prompt (tool results are user entries too). */
const isPrompt = (c: unknown) => typeof c === 'string' || (Array.isArray(c) && c.some((x: any) => x?.type === 'text') && !c.some((x: any) => x?.type === 'tool_result'));

function lastAssistantText(file?: string): string | undefined {
  if (!file || !fs.existsSync(file)) return;
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
      const o = JSON.parse(lines[i]!);
      // A real prompt before any reply text: this turn's answer is not written yet (never the previous one).
      if (o.type === 'user' && isPrompt(o.message?.content)) return;
      if (o.type !== 'assistant') continue;
      const content = o.message?.content;
      const text = Array.isArray(content)
        ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
        : typeof content === 'string'
          ? content
          : '';
      if (text.trim()) return text.trim();
    }
  } catch {}
}
