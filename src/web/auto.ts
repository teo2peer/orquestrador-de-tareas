import path from 'node:path';
import { listProjectFiles, proposeAreas, validateAreas } from '../areas.ts';
import { planSaveIds, saveGeneratedTeam } from '../library.ts';
import { detectStack, proposeRoleTeam } from '../stack.ts';
import type { Role } from '../types.ts';
import { type PlanArea, type PlanIssue, buildAreaTeam, defaultLeadId, leadCandidates, launchGate, planIssues, remapIds, resolveLead, roleTeam, rolePlanOf, saveConflicts } from '../ui/area-plan.ts';

export type AutoKind = 'role' | 'area';

/** A row of the proposal as the web shows it. */
export type AutoItem = { id: string; name: string; color: string; writes: boolean; lead: boolean; base: string; reason: string; paths?: string[]; files?: number; off: boolean };

export type AutoPlan = {
  kind: AutoKind;
  cwd: string;
  stack: string[];
  items: AutoItem[];
  lead: string;
  leads: { id: string; name: string }[];
  issues: PlanIssue[];
  /** Why launching is blocked (area conflicts, or a running session), if it is. */
  blocked?: string;
  /** Ids a «Guardar» would rename because the project already has them. */
  conflicts: string[];
  team: Role[];
  generated: string[];
};

/**
 * The automatic team of `cwd` (the same analysis as the TUI's «Auto por rol» / «Auto por partes»),
 * with `off` ids left out and `lead` chosen. Deterministic, so the web recomputes it on launch
 * instead of trusting a client-sent team.
 */
export function planAuto(kind: AutoKind, cwd: string, library: Role[], opts: { off?: string[]; lead?: string; running?: boolean; save?: boolean } = {}): AutoPlan {
  const off = new Set(opts.off ?? []);
  const files = listProjectFiles(cwd);
  let stack: string[] = [];
  try {
    stack = detectStack(cwd, files).signals;
  } catch {
    /* the stack line is optional */
  }
  let plan: AutoPlan;
  if (kind === 'role') {
    const prop = rolePlanOf(proposeRoleTeam(cwd, library, files));
    const t = roleTeam({ ...prop, off: [...off], lead: opts.lead || prop.lead });
    plan = {
      kind,
      cwd,
      stack,
      lead: t.lead ?? '',
      leads: prop.members.map((m) => ({ id: m.role.id, name: m.role.name })),
      items: prop.members.map((m) => ({ id: m.role.id, name: m.role.name, color: m.role.color, writes: m.role.writes, lead: m.role.id === t.lead, base: m.role.id, reason: m.reason, off: off.has(m.role.id) })),
      issues: [],
      conflicts: [],
      team: t.roles,
      generated: t.generated,
    };
  } else {
    const areas: PlanArea[] = proposeAreas(cwd, { files }).map((a) => ({ ...a, off: off.has(a.id) }));
    const leadRole = resolveLead(library, opts.lead || defaultLeadId(library));
    const team = buildAreaTeam(areas, leadRole, library);
    const issues = planIssues(areas, validateAreas(areas.filter((a) => !a.off), cwd, files));
    const gate = launchGate(issues, !!opts.running);
    const lib = new Set(library.map((r) => r.id));
    const on = areas.filter((a) => !a.off);
    plan = {
      kind,
      cwd,
      stack,
      lead: leadRole.id,
      leads: leadCandidates(library).map((r) => ({ id: r.id, name: r.name })),
      items: areas.map((a) => ({ id: a.id, name: a.name, color: team[on.indexOf(a) + 1]?.color ?? 'white', writes: a.writes, lead: false, base: a.base || 'dueño de área', reason: a.reason, paths: a.paths, files: a.files, off: !!a.off })),
      issues,
      blocked: gate.reason,
      conflicts: [],
      team,
      generated: team.filter((r) => r.area || !lib.has(r.id)).map((r) => r.id),
    };
  }
  if (opts.save) plan.conflicts = saveConflicts(planSaveIds(plan.generated, 'roles', path.join(cwd, '.orq')));
  return plan;
}

/** Saves the generated roles and department into the project library; returns the team with the final ids. */
export function saveAuto(plan: AutoPlan): { team: Role[]; lead: string } {
  const name = `${plan.kind === 'area' ? 'Partes' : 'Auto'} de ${path.basename(plan.cwd)}`;
  const res = saveGeneratedTeam({ name, roles: plan.team, lead: plan.lead, generatedIds: plan.generated }, path.join(plan.cwd, '.orq'));
  const { roles, lead } = remapIds(plan.team, plan.lead, res.idMap);
  return { team: roles, lead };
}
