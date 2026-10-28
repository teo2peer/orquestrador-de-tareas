import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MCP_SCRIPT, ORQ_HOME } from './paths.ts';

/**
 * Where an agent's model comes from.
 * - `claude`: the `claude` CLI, optionally pointed at an Anthropic-compatible endpoint (z.ai, MiniMax, GLM…).
 *   Hooks, MCP and statusline keep working because it is still Claude Code.
 * - `openai`: orq's own headless runner (runner.ts) over an OpenAI-compatible chat API (Grok, Gemini, OpenAI…).
 * - `opencode`: the `opencode` TUI; a plugin forwards its events to HQ as Claude-style hooks.
 */
export type ProviderKind = 'claude' | 'opencode' | 'openai';

export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  /** claude kind: ANTHROPIC_BASE_URL of the compatible endpoint. Absent: Anthropic itself. */
  baseUrl?: string;
  /** NAME of the env var holding the API key (the value is never stored nor printed). */
  keyEnv?: string;
  /** Default model when the role sets none (claude: also used for the sonnet/opus/haiku aliases). */
  model?: string;
  /** Extra env vars exported before launching. */
  env?: Record<string, string>;
};

export const DEFAULT_PROVIDER = 'claude';

/** Built-in presets. Endpoints and models change often: override any of them in ~/.orq/providers.yaml. */
export const BUILTIN_PROVIDERS: Provider[] = [
  { id: 'claude', name: 'Claude (Anthropic)', kind: 'claude' },
  // Claude Code billed through an API key instead of the subscription (the key is inherited from the shell env).
  { id: 'claude-api', name: 'Claude (API key)', kind: 'claude', keyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'zai', name: 'z.ai · GLM (vía Claude Code)', kind: 'claude', baseUrl: 'https://api.z.ai/api/anthropic', keyEnv: 'ZAI_API_KEY', env: { API_TIMEOUT_MS: '3000000' } },
  { id: 'glm', name: 'GLM · Zhipu (vía Claude Code)', kind: 'claude', baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyEnv: 'ZHIPU_API_KEY', env: { API_TIMEOUT_MS: '3000000' } },
  { id: 'minimax', name: 'MiniMax (vía Claude Code)', kind: 'claude', baseUrl: 'https://api.minimax.io/anthropic', keyEnv: 'MINIMAX_API_KEY', env: { API_TIMEOUT_MS: '3000000' } },
  // OpenAI-compatible endpoints driven by orq's own runner. Models are examples: set yours in providers.yaml.
  { id: 'grok', name: 'Grok · xAI (API)', kind: 'openai', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', model: 'grok-4' },
  { id: 'gemini', name: 'Gemini · Google (API)', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', model: 'gemini-2.5-pro' },
  { id: 'openai', name: 'OpenAI · Codex (API)', kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', model: 'gpt-5' },
  { id: 'opencode', name: 'opencode (modelo de su config)', kind: 'opencode' },
];

export const providersFile = () => path.join(ORQ_HOME, 'providers.yaml');

/** Builtins plus ~/.orq/providers.yaml (a map id → fields; same id overrides the builtin). */
export function listProviders(file = providersFile()): Provider[] {
  const byId = new Map(BUILTIN_PROVIDERS.map((p) => [p.id, p]));
  if (fs.existsSync(file)) {
    let data: Record<string, any> = {};
    try {
      data = (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, any>;
    } catch {
      // A broken file must not stop orq: builtins only.
    }
    for (const [id, v] of Object.entries(data)) {
      if (!v || typeof v !== 'object') continue;
      const base = byId.get(id);
      const kind = v.kind === 'opencode' || v.kind === 'claude' || v.kind === 'openai' ? v.kind : (base?.kind ?? 'claude');
      byId.set(id, {
        id,
        name: String(v.name ?? base?.name ?? id),
        kind,
        baseUrl: v.baseUrl ? String(v.baseUrl) : base?.baseUrl,
        keyEnv: v.keyEnv ? String(v.keyEnv) : base?.keyEnv,
        model: v.model ? String(v.model) : base?.model,
        env: v.env && typeof v.env === 'object' ? Object.fromEntries(Object.entries(v.env).map(([k, x]) => [k, String(x)])) : base?.env,
      });
    }
  }
  return [...byId.values()];
}

/** The provider of a role (unknown ids fall back to claude). */
export function providerOf(role: { provider?: string }, all = listProviders()): Provider {
  return all.find((p) => p.id === (role.provider ?? DEFAULT_PROVIDER)) ?? all.find((p) => p.id === DEFAULT_PROVIDER)!;
}

/** Next choice of the launch selector: '' (each role's own) → every provider → back to ''. */
export function cycleProvider(current: string, all = listProviders()): string {
  const ids = ['', ...all.map((p) => p.id)];
  return ids[(ids.indexOf(current) + 1) % ids.length]!;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Shell lines (launch.sh) that point `claude` at the provider's endpoint. The key is expanded by the
 * shell at launch from the user's own env var: it is never written to disk. Empty for Anthropic itself.
 */
export function claudeProviderEnv(p: Provider, model?: string): string[] {
  if (p.kind !== 'claude') return [];
  // Anthropic itself with an API key: nothing to redirect, only make sure the key is there.
  if (!p.baseUrl) return p.keyEnv && ENV_NAME.test(p.keyEnv) ? [`: "\${${p.keyEnv}:?orq: set ${p.keyEnv} (API key of provider ${p.id}) in your shell environment}"`] : [];
  const lines = [`export ANTHROPIC_BASE_URL=${q(p.baseUrl)}`, 'unset ANTHROPIC_API_KEY'];
  if (p.keyEnv && ENV_NAME.test(p.keyEnv))
    lines.push(`: "\${${p.keyEnv}:?orq: set ${p.keyEnv} (API key of provider ${p.id}) in your shell environment}"`, `export ANTHROPIC_AUTH_TOKEN="$${p.keyEnv}"`);
  const m = model ?? p.model;
  // The third-party endpoint knows no sonnet/opus/haiku: every alias (and subagents) maps to its model.
  if (m)
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'])
      lines.push(`export ${k}=${q(m)}`);
  lines.push('export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
  for (const [k, v] of Object.entries(p.env ?? {})) if (ENV_NAME.test(k)) lines.push(`export ${k}=${q(v)}`);
  return lines;
}

/** Whether a claude-kind provider's key is present in this process env (for UI hints). */
export const providerReady = (p: Provider, env: Record<string, string | undefined> = process.env) =>
  p.kind === 'opencode' ? !!Bun.which('opencode') : !p.keyEnv || !!env[p.keyEnv];

/** Why an agent of this provider could not start right now (missing key or binary), or undefined when it can. */
export function providerIssue(p: Provider, env: Record<string, string | undefined> = process.env): string | undefined {
  if (p.kind === 'opencode' && !Bun.which('opencode')) return '`opencode` no está en el PATH';
  if (p.kind === 'claude' && !Bun.which('claude')) return '`claude` no está en el PATH';
  if (p.keyEnv && !env[p.keyEnv]) return `falta la variable ${p.keyEnv} (API key de ${p.id})`;
  return undefined;
}

/** Path of the plugin that turns opencode events into HQ hooks. */
export const OPENCODE_PLUGIN = path.join(path.dirname(MCP_SCRIPT), 'opencode-plugin.ts');

/**
 * opencode config of one agent (loaded through OPENCODE_CONFIG). Written in the long-standing
 * format (`mcp`, `permission`, `plugin`), which opencode 2.x migrates to its own on load.
 */
export function opencodeConfig(o: { system: string; model?: string; writes: boolean; env: Record<string, string>; extraMcp?: Record<string, unknown> }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    ...(o.model ? { model: o.model } : {}),
    instructions: [o.system],
    plugin: [`file://${OPENCODE_PLUGIN}`],
    permission: { edit: o.writes ? 'allow' : 'deny', bash: 'allow', webfetch: 'allow' },
    mcp: {
      ...(o.extraMcp ?? {}),
      company: { type: 'local', command: [process.execPath, MCP_SCRIPT], environment: o.env, enabled: true },
    },
  };
}

/** launch.sh lines starting an opencode agent. `sessionId` only when resuming a session the plugin reported. */
export function opencodeLaunch(configPath: string, cwd: string, sessionId?: string): string[] {
  return [`export OPENCODE_CONFIG=${q(configPath)}`, `cd ${q(cwd)}`, `exec opencode${sessionId ? ` --session ${q(sessionId)}` : ''}`];
}

export const RUNNER_SCRIPT = path.join(path.dirname(MCP_SCRIPT), 'runner.ts');

/** launch.sh lines starting an openai-kind agent; the key stays in the user's env (checked here, read by the runner). */
export function runnerLaunch(p: Provider, configPath: string, cwd: string): string[] {
  const key = p.keyEnv && ENV_NAME.test(p.keyEnv) ? p.keyEnv : 'OPENAI_API_KEY';
  return [
    `: "\${${key}:?orq: set ${key} (API key of provider ${p.id}) in your shell environment}"`,
    // No tty echo: pasted messages must not be printed back verbatim (HQ checks the pane to confirm deliveries).
    'stty -echo 2>/dev/null',
    `cd ${q(cwd)}`,
    `exec "${'$'}{ORQ_BUN:-bun}" ${q(RUNNER_SCRIPT)} ${q(configPath)}`,
  ];
}

/** First reason a launch of these roles cannot work (missing key or binary of a provider they use); undefined when fine. */
export function launchIssue(roles: { provider?: string }[], override?: string, all = listProviders(), env: Record<string, string | undefined> = process.env): string | undefined {
  const seen = new Set<string>();
  for (const r of roles) {
    const p = providerOf({ provider: override || r.provider }, all);
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const why = providerIssue(p, env);
    if (why) return `Proveedor ${p.id}: ${why}`;
  }
  return undefined;
}
