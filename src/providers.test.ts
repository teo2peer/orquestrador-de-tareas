import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HQ } from './hq.ts';
import { claudeToolInput, claudeToolName, interpretReply, preTool } from './opencode-map.ts';
import { claudeProviderEnv, launchIssue, listProviders, opencodeConfig, providerOf } from './providers.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orq-prov-'));

describe('providers', () => {
  test('builtins: claude, claude-compatible endpoints, openai-compatible APIs and opencode', () => {
    const ids = listProviders(path.join(tmp(), 'none.yaml')).map((p) => p.id);
    expect(ids).toEqual(['claude', 'claude-api', 'zai', 'glm', 'minimax', 'grok', 'gemini', 'openai', 'opencode']);
  });

  test('providers.yaml overrides a builtin and adds new ones; a broken file is ignored', () => {
    const dir = tmp();
    const file = path.join(dir, 'providers.yaml');
    fs.writeFileSync(file, 'zai:\n  model: glm-x\nmine:\n  baseUrl: https://x.test/anthropic\n  keyEnv: MINE_KEY\n');
    const all = listProviders(file);
    expect(all.find((p) => p.id === 'zai')).toMatchObject({ model: 'glm-x', baseUrl: 'https://api.z.ai/api/anthropic' });
    expect(all.find((p) => p.id === 'mine')).toMatchObject({ kind: 'claude', keyEnv: 'MINE_KEY' });
    fs.writeFileSync(file, ': : not yaml [');
    expect(listProviders(file).length).toBe(9);
  });

  test('unknown or missing provider falls back to claude', () => {
    expect(providerOf({}).id).toBe('claude');
    expect(providerOf({ provider: 'nope' }).id).toBe('claude');
    expect(providerOf({ provider: 'zai' }).id).toBe('zai');
  });

  test('claude env: nothing for Anthropic; endpoint + key by reference (never the value) for others', () => {
    expect(claudeProviderEnv(providerOf({}))).toEqual([]);
    const lines = claudeProviderEnv({ ...providerOf({ provider: 'zai' }), model: 'glm-x' }).join('\n');
    expect(lines).toContain("ANTHROPIC_BASE_URL='https://api.z.ai/api/anthropic'");
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"');
    expect(lines).toContain('${ZAI_API_KEY:?');
    expect(lines).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL='glm-x'");
    expect(lines).toContain('unset ANTHROPIC_API_KEY');
  });

  test('claude-api only checks the key and does not redirect the endpoint', () => {
    const lines = claudeProviderEnv(providerOf({ provider: 'claude-api' }));
    expect(lines.length).toBe(1);
    expect(lines.join('\n')).toContain('${ANTHROPIC_API_KEY:?');
    expect(lines.join('\n')).not.toContain('ANTHROPIC_BASE_URL');
  });

  test('an invalid keyEnv name is never interpolated into the shell script', () => {
    const lines = claudeProviderEnv({ id: 'bad', name: 'bad', kind: 'claude', baseUrl: 'https://x', keyEnv: 'A; rm -rf /' }).join('\n');
    expect(lines).not.toContain('rm -rf');
  });

  test('opencode config: company MCP, instructions, plugin, edit denied for read-only roles', () => {
    const c = opencodeConfig({ system: '/s.md', model: 'zai/glm-4.6', writes: false, env: { ORQ_AGENT_ID: 'qa' } }) as any;
    expect(c.model).toBe('zai/glm-4.6');
    expect(c.instructions).toEqual(['/s.md']);
    expect(c.permission.edit).toBe('deny');
    expect(c.mcp.company.environment.ORQ_AGENT_ID).toBe('qa');
    expect(c.plugin[0]).toContain('opencode-plugin.ts');
  });
});

describe('opencode event mapping', () => {
  test('tool names and inputs become Claude-style so orq-guard applies', () => {
    expect(claudeToolName('bash')).toBe('Bash');
    expect(claudeToolName('company_report')).toBe('mcp__company__report');
    expect(claudeToolName('custom')).toBe('custom');
    expect(claudeToolInput('read', { filePath: '/a/b' }).file_path).toBe('/a/b');
    expect(preTool('s', 'edit', { filePath: 'x.ts' })).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'x.ts' } });
  });

  test('HQ replies: deny blocks the call, a Stop block becomes an injected prompt', () => {
    expect(interpretReply({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } })).toEqual({ deny: 'no' });
    expect(interpretReply({ decision: 'block', reason: '📬 hi' })).toEqual({ inject: '📬 hi' });
    expect(interpretReply({})).toEqual({});
  });
});

describe('HQ launch per provider', () => {
  const role = { id: 'dev', name: 'Dev', title: 'Dev', accessory: 'none', color: 'cyan', writes: true, description: '', prompt: '', scope: 'global', file: '' } as any;
  const launch = (r: any, resume = false) => {
    const hq = new HQ({ roles: [], permMode: 'auto', cwd: tmp() });
    const agent = { id: 'dev', role: r, status: 'starting', task: '', children: [], sessionId: 'ses_1', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    const script = fs.readFileSync((hq as any).writeLaunchFiles(agent, resume), 'utf8');
    return { hq, script };
  };

  test('z.ai role still runs claude, with the endpoint env', () => {
    const { script } = launch({ ...role, provider: 'zai' });
    expect(script).toContain('exec claude');
    expect(script).toContain('ANTHROPIC_BASE_URL');
  });

  test('default role has no provider env', () => {
    expect(launch(role).script).not.toContain('ANTHROPIC_BASE_URL');
  });

  test('opencode role runs opencode with a private config; resume reuses the reported session', () => {
    const a = launch({ ...role, provider: 'opencode', model: 'zai/glm-4.6' });
    expect(a.script).toContain('exec opencode');
    expect(a.script).not.toContain('--session');
    expect(a.script).not.toContain('claude');
    const cfg = JSON.parse(fs.readFileSync(path.join(a.hq.privateDir, 'dev', 'opencode.json'), 'utf8'));
    expect(cfg.model).toBe('zai/glm-4.6');
    expect(launch({ ...role, provider: 'opencode' }, true).script).toContain("--session 'ses_1'");
  });
});

describe('session-wide provider override', () => {
  const role = { id: 'dev', name: 'Dev', title: 'Dev', accessory: 'none', color: 'cyan', writes: true, description: '', prompt: '', scope: 'global', file: '' } as any;
  const agentOf = (r: any) => ({ id: 'dev', role: r, status: 'starting', task: '', children: [], sessionId: 'ses_1', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 });

  test('overrides every role, even ones with their own provider; none keeps each role’s own', () => {
    const cwd = tmp();
    const own = new HQ({ roles: [], permMode: 'auto', cwd });
    expect(own.providerFor({ ...role, provider: 'zai' } as any).id).toBe('zai');
    expect(own.providerFor(role).id).toBe('claude');
    const forced = new HQ({ roles: [], permMode: 'auto', cwd, provider: 'minimax' });
    expect(forced.providerFor({ ...role, provider: 'zai' } as any).id).toBe('minimax');
    expect(forced.providerFor(role).id).toBe('minimax');
    expect(fs.readFileSync((forced as any).writeLaunchFiles(agentOf(role)), 'utf8')).toContain('api.minimax.io');
  });

  test('is saved in the run meta and restored on resume', () => {
    const hq = new HQ({ roles: [], permMode: 'auto', cwd: tmp(), provider: 'opencode' });
    const meta = (hq as any).currentMeta();
    expect(meta.provider).toBe('opencode');
    const back = new HQ({ roles: [], permMode: 'auto', resume: meta });
    expect(back.provider).toBe('opencode');
  });

  test('opencode ignores Claude model aliases and keeps provider/model ones', () => {
    const hq = new HQ({ roles: [], permMode: 'auto', cwd: tmp(), provider: 'opencode' });
    for (const [model, expected] of [['opus', undefined], ['zai/glm-4.6', 'zai/glm-4.6']] as const) {
      const a: any = agentOf({ ...role, model });
      (hq as any).writeLaunchFiles(a);
      expect(a.model).toBe(expected);
    }
  });
});

describe('launch checks', () => {
  test('missing API key of a used provider blocks the launch with a clear message', () => {
    expect(launchIssue([{ provider: 'grok' }], undefined, undefined, {})).toBe('Proveedor grok: falta la variable XAI_API_KEY (API key de grok)');
    expect(launchIssue([{ provider: 'grok' }], undefined, undefined, { XAI_API_KEY: 'x' })).toBeUndefined();
  });
  test('the session override decides, not the roles', () => {
    expect(launchIssue([{ provider: 'grok' }, {}], 'gemini', undefined, {})).toContain('GEMINI_API_KEY');
    expect(launchIssue([{ provider: 'grok' }], 'claude', undefined, {})).toBeUndefined();
  });
});
