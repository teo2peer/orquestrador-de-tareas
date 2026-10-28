import { EventEmitter } from 'node:events';
import { HQ, type HQOptions, runIsServed } from './hq.ts';
import { loadDepartments, loadRoles } from './library.ts';
import { PROJECT_DIR } from './paths.ts';
import { launchIssue } from './providers.ts';
import { loadRun } from './runs.ts';
import type { CostProfile, Department, Notice, PermMode, ResumeMode, Role, TeamMode } from './types.ts';

/**
 * The team a run is launched as (the department its lead leads, also when launched alone):
 * its rules and extra directories reach every agent. Shared by the TUI and the web UI.
 */
export function teamOf(depts: Department[], lead: string | undefined, ids: string[]): { dept?: string; dirs?: string[] } {
  const led = lead ? depts.filter((x) => x.lead === lead) : [];
  // A lead of several teams: the one whose members best match the agents launched.
  const score = (x: Department) => ids.filter((id) => x.roles.includes(id)).length - x.roles.filter((id) => !ids.includes(id)).length;
  const d = led.sort((x, y) => score(y) - score(x))[0];
  return d ? { dept: d.id, dirs: d.dirs } : {};
}

export type LaunchRequest = {
  roleIds: string[];
  lead?: string;
  perm: PermMode;
  profile: CostProfile;
  /** Provider forced on every agent ('' = each role's own). */
  provider?: string;
};

export type Outcome = { ok: true; message: string } | { ok: false; error: string };
const fail = (error: string): Outcome => ({ ok: false, error });
const ok = (message: string): Outcome => ({ ok: true, message });

/**
 * UI-agnostic owner of the open run (the web UI's counterpart of the TUI's AppProvider):
 * launching, resuming, detaching and stopping with the same checks as the TUI.
 * Emits 'change' whenever the run or its state changes.
 */
export class Session extends EventEmitter {
  hq: HQ | null = null;
  private onChange = () => this.emit('change');

  constructor(
    private make: (o: HQOptions) => HQ = (o) => new HQ(o),
    private deps = { roles: loadRoles, depts: loadDepartments, isServed: runIsServed, load: loadRun, cwd: PROJECT_DIR },
  ) {
    super();
  }

  private open(hq: HQ) {
    this.hq = hq;
    hq.on('change', this.onChange);
    hq.start();
    this.emit('change');
  }

  private close() {
    this.hq?.off('change', this.onChange);
    this.hq = null;
    this.emit('change');
  }

  /** Starts a new run, or adds the roles it lacks to the open one. */
  launch(req: LaunchRequest): Outcome {
    const all = this.deps.roles();
    const picked = req.roleIds.map((id) => all.find((r) => r.id === id)).filter(Boolean) as Role[];
    if (!picked.length) return fail('Selecciona al menos un rol');
    const issue = launchIssue(picked, this.hq?.provider ?? req.provider);
    if (issue) return fail(issue);
    if (this.hq) {
      const add = picked.filter((r) => !this.hq!.agents.has(r.id));
      for (const r of add) this.hq.hire(r);
      if (!add.length) return ok('Esos agentes ya están en la sesión');
      return ok(add.length === 1 ? '1 agente añadido a la sesión' : `${add.length} agentes añadidos a la sesión`);
    }
    const ordered = req.lead ? [...picked.filter((r) => r.id === req.lead), ...picked.filter((r) => r.id !== req.lead)] : picked;
    this.open(this.make({ roles: ordered, lead: req.lead, permMode: req.perm, profile: req.profile, provider: req.provider || undefined, cwd: this.deps.cwd, ...teamOf(this.deps.depts(), req.lead, req.roleIds) }));
    return ok(`Sesión lanzada con ${ordered.length} agente${ordered.length === 1 ? '' : 's'}`);
  }

  /**
   * Launches full Role objects (auto-composed teams). With a run open, 'role' teams add only the
   * roles it lacks and 'area' teams are refused (one team mode per session); returns the count.
   */
  launchTeam(req: Omit<LaunchRequest, 'roleIds'> & { team: Role[]; lead: string; mode: TeamMode }): Outcome {
    if (!req.team.length) return fail('No hay agentes que lanzar');
    const issue = launchIssue(req.team, this.hq?.provider ?? req.provider);
    if (issue) return fail(issue);
    if (this.hq) {
      if (req.mode === 'area') return fail('Detén la sesión para componer por partes');
      const add = req.team.filter((r) => !this.hq!.agents.has(r.id));
      for (const r of add) this.hq.hire(r);
      return add.length ? ok(`${add.length} agente${add.length === 1 ? '' : 's'} añadido${add.length === 1 ? '' : 's'} a la sesión`) : ok('Esos agentes ya están en la sesión');
    }
    const ordered = [...req.team.filter((r) => r.id === req.lead), ...req.team.filter((r) => r.id !== req.lead)];
    this.open(this.make({ roles: ordered, lead: req.lead, permMode: req.perm, mode: req.mode, profile: req.profile, provider: req.provider || undefined, cwd: this.deps.cwd, ...teamOf(this.deps.depts(), req.lead, req.team.map((r) => r.id)) }));
    return ok(`Equipo creado y lanzado: ${ordered.length} agente${ordered.length === 1 ? '' : 's'}`);
  }

  /** Reopens a run; live agents reattach, stopped ones come back the way `mode` says. */
  async resume(dir: string, mode: ResumeMode | 'auto' = 'auto'): Promise<Outcome> {
    if (this.hq) return fail('Detén o desconecta la sesión actual antes de reanudar otra.');
    let meta: ReturnType<typeof loadRun>;
    try {
      meta = this.deps.load(dir);
    } catch (e) {
      return fail(`No pude leer la sesión: ${(e as Error).message}`);
    }
    if (await this.deps.isServed(meta.runId)) return fail('Esa sesión ya está abierta en otra ventana de orq.');
    // The dialog-less path of the TUI (`orq --resume`): per agent, full where its cache is warm.
    this.open(this.make({ roles: [], permMode: meta.permMode, resume: meta, resumeMode: mode, cwd: this.deps.cwd }));
    return ok(`Sesión reanudada: ${meta.agents.length} agente${meta.agents.length === 1 ? '' : 's'}`);
  }

  /** Close the UI's hold on the run; the agents keep working in tmux. */
  detach(): Outcome {
    if (!this.hq) return fail('No hay sesión abierta');
    this.hq.detach();
    this.close();
    return ok('Sesión desconectada: los agentes siguen en tmux');
  }

  stop(): Outcome {
    if (!this.hq) return fail('No hay sesión abierta');
    this.hq.stop();
    this.close();
    return ok('Sesión detenida');
  }
}

/** A pending item for the user: a stored notice or an agent blocked on a prompt in its terminal. */
export type Alert = Omit<Notice, 'kind'> & { kind: Notice['kind'] | 'blocked' };

/**
 * Notices plus one 'blocked' alert per agent waiting on its terminal. Blocked alerts are
 * derived from the agent state, so they disappear by themselves once the agent moves on.
 */
export function alertsOf(hq: HQ | null): Alert[] {
  if (!hq) return [];
  const blocked = [...hq.agents.values()]
    .filter((a) => a.status === 'waiting' && a.notice)
    .map((a) => ({ id: `blocked:${a.id}`, kind: 'blocked' as const, from: a.id, text: a.notice! }));
  return [...hq.notices, ...blocked];
}
