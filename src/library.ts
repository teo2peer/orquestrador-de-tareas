import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ORQ_HOME, PROJECT_ORQ, libDir } from './paths.ts';
import type { Department, Role, Scope } from './types.ts';

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = FM.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: (YAML.parse(m[1]!) as Record<string, any>) ?? {}, body: m[2]!.trim() };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'item';

export const makeId = slug;

function listFiles(dir: string, ext: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));
}

function resolveSource(src: string) {
  return path.isAbsolute(src) ? src : path.join(ORQ_HOME, src);
}

function readRole(file: string, scope: Scope): Role {
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const id = String(data.id ?? path.basename(file, '.md'));
  let prompt = body;
  if (!prompt && data.source) {
    const src = resolveSource(String(data.source));
    prompt = fs.existsSync(src) ? parseFrontmatter(fs.readFileSync(src, 'utf8')).body : '';
  }
  return {
    id,
    name: String(data.name ?? id),
    title: String(data.title ?? data.name ?? id),
    accessory: String(data.accessory ?? 'none'),
    hair: data.hair ? String(data.hair) : undefined,
    skin: data.skin ? String(data.skin) : undefined,
    color: String(data.color ?? 'white'),
    writes: data.writes !== false,
    model: data.model ? String(data.model) : undefined,
    provider: data.provider ? String(data.provider) : undefined,
    description: String(data.description ?? ''),
    prompt,
    source: data.source ? String(data.source) : undefined,
    pack: data.pack ? String(data.pack) : undefined,
    scope,
    file,
    area: Array.isArray(data.area?.paths) ? { paths: data.area.paths.map(String) } : undefined,
    mcp: Array.isArray(data.mcp) ? data.mcp.map(String) : undefined,
    fresh: typeof data.fresh === 'boolean' ? data.fresh : undefined,
    tools: Array.isArray(data.tools) ? data.tools.map(String) : undefined,
    userSettings: typeof data.userSettings === 'boolean' ? data.userSettings : undefined,
  };
}

function readDept(file: string, scope: Scope): Department {
  const data = (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, any>;
  return {
    id: String(data.id ?? path.basename(file, '.yaml')),
    name: String(data.name ?? data.id),
    icon: String(data.icon ?? '■'),
    color: String(data.color ?? 'white'),
    category: String(data.category ?? 'General'),
    description: String(data.description ?? ''),
    lead: data.lead ? String(data.lead) : undefined,
    roles: Array.isArray(data.roles) ? data.roles.map(String) : [],
    dirs: Array.isArray(data.dirs) ? data.dirs.map(String) : undefined,
    rules: readRules(file),
    scope,
    file,
  };
}

/** The team rules file of a department YAML (`<id>.md` beside it). */
export const deptRulesFile = (yamlFile: string) => yamlFile.replace(/\.yaml$/, '.md');

function readRules(yamlFile: string): string | undefined {
  const f = deptRulesFile(yamlFile);
  const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  return text || undefined;
}

/** Deletes a department: its YAML and its rules file. */
export function deleteDepartment(file: string) {
  deleteFile(file);
  deleteFile(deptRulesFile(file));
}

/** Global library overridden by the project library (same id wins). */
export function loadRoles(): Role[] {
  const map = new Map<string, Role>();
  for (const scope of ['global', 'project'] as const)
    for (const f of listFiles(libDir(scope, 'roles'), '.md')) {
      try {
        const r = readRole(f, scope);
        map.set(r.id, r);
      } catch {
        /* skip malformed role */
      }
    }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadDepartments(): Department[] {
  const map = new Map<string, Department>();
  for (const scope of ['global', 'project'] as const)
    for (const f of listFiles(libDir(scope, 'departments'), '.yaml')) {
      try {
        const d = readDept(f, scope);
        map.set(d.id, d);
      } catch {
        /* skip malformed department */
      }
    }
  return [...map.values()].sort((a, b) => (a.id === 'empresa' ? -1 : b.id === 'empresa' ? 1 : a.name.localeCompare(b.name)));
}

/** `baseDir` overrides the project library root (<cwd>/.orq), for tests. */
export function saveRole(role: Omit<Role, 'file' | 'prompt'> & { prompt?: string; body?: string }, baseDir?: string): string {
  const dir = baseDir && role.scope === 'project' ? path.join(baseDir, 'roles') : libDir(role.scope, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${role.id}.md`);
  const data: Record<string, any> = {
    id: role.id,
    name: role.name,
    title: role.title,
    accessory: role.accessory,
    color: role.color,
    writes: role.writes,
    description: role.description,
  };
  if (role.hair) data.hair = role.hair;
  if (role.skin) data.skin = role.skin;
  if (role.model) data.model = role.model;
  if (role.provider) data.provider = role.provider;
  if (role.source) data.source = role.source;
  if (role.pack) data.pack = role.pack;
  if (role.area) data.area = { paths: role.area.paths };
  if (role.mcp?.length) data.mcp = role.mcp;
  if (role.fresh !== undefined) data.fresh = role.fresh;
  if (role.tools) data.tools = role.tools;
  if (role.userSettings !== undefined) data.userSettings = role.userSettings;
  // Pack roles keep an empty body so the prompt keeps following the source file.
  const body = role.body ?? (role.source ? '' : role.prompt ?? '');
  fs.writeFileSync(file, `---\n${YAML.stringify(data).trim()}\n---\n\n${body}\n`);
  return file;
}

export function deleteFile(file: string) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function saveDepartment(d: Omit<Department, 'file'>, baseDir?: string): string {
  const dir = baseDir && d.scope === 'project' ? path.join(baseDir, 'departments') : libDir(d.scope, 'departments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${d.id}.yaml`);
  const data: Record<string, any> = { id: d.id, name: d.name, icon: d.icon, color: d.color, category: d.category, description: d.description, roles: d.roles };
  if (d.dirs?.length) data.dirs = d.dirs;
  if (d.lead) data.lead = d.lead;
  fs.writeFileSync(file, YAML.stringify(data));
  if (d.rules?.trim()) fs.writeFileSync(deptRulesFile(file), `${d.rules.trim()}\n`);
  else deleteFile(deptRulesFile(file));
  return file;
}

// ------------------------------------------------------------ generated teams

/**
 * Ids already taken in the project and global libraries (file names and declared ids):
 * a project file with a global id would silently override the global one.
 */
function takenIds(kind: 'roles' | 'departments', baseDir: string, globalDir: string) {
  const ext = kind === 'roles' ? '.md' : '.yaml';
  const taken = new Set<string>();
  for (const dir of [path.join(baseDir, kind), path.join(globalDir, kind)])
    for (const f of listFiles(dir, ext)) {
      taken.add(path.basename(f, ext));
      try {
        taken.add(kind === 'roles' ? readRole(f, 'project').id : readDept(f, 'project').id);
      } catch {
        /* the file name is enough */
      }
    }
  return taken;
}

/**
 * Final ids that saving these ids into the project library would use, without writing:
 * an id already taken in the project or global library (or repeated in `ids`) gets a -2, -3… suffix.
 * Callers should pass `baseDir` = path.join(cwd, '.orq') of the run's project; the default is the
 * project orq was started in. `globalDir` (default ORQ_HOME) exists for tests.
 */
export function planSaveIds(ids: string[], kind: 'roles' | 'departments', baseDir = PROJECT_ORQ, globalDir = ORQ_HOME): Record<string, string> {
  const taken = takenIds(kind, baseDir, globalDir);
  const out: Record<string, string> = {};
  for (const id of ids) {
    if (id in out) continue;
    let final = id;
    for (let n = 2; taken.has(final); n++) final = `${id}-${n}`;
    taken.add(final);
    out[id] = final;
  }
  return out;
}

/**
 * Persist an auto-generated team in the project library (never global): only the generated
 * roles, plus a department that references library roles by id and the saved generated ones.
 * Ids are chosen like planSaveIds. Callers should pass `baseDir` = path.join(cwd, '.orq').
 */
export function saveGeneratedTeam(
  input: { name: string; roles: Role[]; lead: string; generatedIds: string[] },
  baseDir = PROJECT_ORQ,
  globalDir = ORQ_HOME,
): { roleFiles: string[]; deptFile: string; idMap: Record<string, string> } {
  const generated = new Set(input.generatedIds);
  const idMap = planSaveIds(
    input.roles.filter((r) => generated.has(r.id)).map((r) => r.id),
    'roles',
    baseDir,
    globalDir,
  );
  const roleFiles = input.roles
    .filter((r) => generated.has(r.id))
    .map(({ file: _file, ...r }) => saveRole({ ...r, id: idMap[r.id]!, scope: 'project', source: undefined, pack: undefined }, baseDir));
  const deptId = slug(input.name);
  const finalDept = planSaveIds([deptId], 'departments', baseDir, globalDir)[deptId]!;
  const ids = input.roles.map((r) => idMap[r.id] ?? r.id);
  const deptFile = saveDepartment(
    {
      id: finalDept,
      name: input.name,
      icon: '■',
      color: 'cyan',
      category: 'Generado',
      description: `Equipo generado automáticamente (${ids.length} roles).`,
      lead: idMap[input.lead] ?? input.lead,
      roles: ids,
      scope: 'project',
    },
    baseDir,
  );
  return { roleFiles, deptFile, idMap };
}

// ---------------------------------------------------------------- role packs

const PACK_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red'];

function guessAccessory(id: string, data: Record<string, any>) {
  if (/orchestrator/.test(id)) return 'headset';
  if (/manager/.test(id)) return 'tie';
  if (/review|audit/.test(id)) return 'glasses';
  if (/test|behat|phpunit/.test(id)) return 'cap';
  if (/frontend|design/.test(id)) return 'beret';
  if (/backend|entity/.test(id)) return 'helmet';
  if (/doc/.test(id)) return 'bowtie';
  if (data.hidden) return 'hood';
  return 'none';
}

function humanize(id: string, pack: string) {
  const prefix = pack.split('-')[0] + '-';
  return id
    .replace(new RegExp(`^${prefix}`), '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Import a directory of agent definitions (Claude/OpenCode markdown with frontmatter)
 * as orq roles. `src` is a local dir or `host:/path` (copied with scp).
 * Existing roles keep the user's customizations; only description/source refresh.
 */
export async function importPack(src: string, name?: string): Promise<{ pack: string; imported: string[] }> {
  const pack = slug(name ?? path.basename(src.replace(/\/+$/, '').split(':').pop()!));
  const dest = path.join(ORQ_HOME, 'packs', pack);
  const isRemote = /^[^/]+:/.test(src) && !fs.existsSync(src);
  if (isRemote) {
    fs.mkdirSync(dest, { recursive: true });
    const p = Bun.spawnSync(['scp', '-q', '-r', '-o', 'BatchMode=yes', '--', `${src.replace(/\/+$/, '')}/.`, dest]);
    if (p.exitCode !== 0) throw new Error(`scp failed: ${p.stderr.toString().trim()}`);
  }
  const root = isRemote ? dest : path.resolve(src);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !['templates', 'node_modules', '.git'].includes(e.name)) walk(full);
      else if (e.isFile() && e.name.endsWith('.md') && !/readme/i.test(e.name) && !e.name.endsWith('.claude.md'))
        files.push(full);
    }
  };
  walk(root);
  const existing = new Map(loadRoles().map((r) => [r.id, r]));
  const imported: string[] = [];
  files.forEach((file, i) => {
    const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const id = slug(String(data.name ?? path.basename(file, '.md')));
    const tools = (data.tools ?? {}) as Record<string, any>;
    const prev = existing.get(id);
    const writes = !(tools.write === false || tools.edit === false);
    saveRole({
      id,
      name: prev?.name ?? humanize(id, pack),
      title: prev?.title ?? humanize(id, pack),
      accessory: prev?.accessory ?? guessAccessory(id, data),
      hair: prev?.hair,
      skin: prev?.skin,
      color: prev?.color ?? PACK_COLORS[i % PACK_COLORS.length]!,
      writes: prev ? prev.writes : writes,
      model: prev?.model,
      provider: prev?.provider,
      description: String(data.description ?? '').split('\n')[0]!.slice(0, 300),
      source: file,
      pack,
      scope: 'global',
      body: prev && !prev.source ? prev.prompt : '',
    });
    imported.push(id);
  });
  return { pack, imported };
}
