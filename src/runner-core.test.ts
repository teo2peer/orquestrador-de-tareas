import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HQ } from './hq.ts';
import { builtinTools, openaiChat, runBuiltin, runTurn, trimHistory, type ChatMessage, type Hooks, type Session } from './runner-core.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orq-runner-'));
const call = (id: string, name: string, args: object) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('builtin tools', () => {
  test('readers get no Write/Edit', () => {
    expect(builtinTools(false).map((t) => t.name)).toEqual(['Bash', 'Read']);
    expect(builtinTools(true).map((t) => t.name)).toEqual(['Bash', 'Read', 'Write', 'Edit']);
  });

  test('Write, Read with range, Edit (exactly one match) and Bash', async () => {
    const cwd = tmp();
    await runBuiltin('Write', { file_path: 'a/x.txt', content: 'one\ntwo\nthree\ntwo' }, cwd);
    expect(await runBuiltin('Read', { file_path: 'a/x.txt', offset: 2, limit: 1 }, cwd)).toBe('2\ttwo');
    expect(await runBuiltin('Edit', { file_path: 'a/x.txt', old_string: 'two', new_string: 'X' }, cwd)).toContain('matches 2 times');
    expect(await runBuiltin('Edit', { file_path: 'a/x.txt', old_string: 'three', new_string: '$&' }, cwd)).toContain('Edited');
    expect(fs.readFileSync(path.join(cwd, 'a/x.txt'), 'utf8')).toContain('$&');
    const sh = await runBuiltin('Bash', { command: 'echo hi; echo err >&2; exit 3' }, cwd);
    expect(sh).toContain('hi');
    expect(sh).toContain('[stderr]\nerr');
    expect(sh).toEndWith('[exit 3]');
    expect(await runBuiltin('Read', { file_path: 'missing' }, cwd)).toStartWith('Error:');
  });

  test('old tool outputs are trimmed first when the history is too big', () => {
    const big = 'x'.repeat(1000);
    const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'tool', content: big, tool_call_id: '1' }, { role: 'user', content: 'keep me' }];
    const out = trimHistory(msgs, 500);
    expect(out[1]!.content).toBe('[old tool output trimmed]');
    expect(out[2]!.content).toBe('keep me');
    expect(trimHistory(msgs, 5000)).toBe(msgs);
  });
});

describe('chat client', () => {
  const ok = (message: object) => new Response(JSON.stringify({ choices: [{ message }] }));

  test('sends bearer key, model and tools; retries a 429', async () => {
    const seen: any[] = [];
    let n = 0;
    const chat = openaiChat({
      baseUrl: 'https://api.test/v1/',
      apiKey: 'k',
      model: 'm',
      retryMs: 1,
      fetchImpl: (async (url: string, init: any) => {
        seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
        return n++ ? ok({ role: 'assistant', content: 'hi' }) : new Response('slow down', { status: 429 });
      }) as any,
    });
    const r = await chat([{ role: 'user', content: 'x' }], builtinTools(false));
    expect(r.content).toBe('hi');
    expect(seen.length).toBe(2);
    expect(seen[0]).toMatchObject({ url: 'https://api.test/v1/chat/completions', auth: 'Bearer k' });
    expect(seen[0].body.model).toBe('m');
    expect(seen[0].body.tools[0].function.name).toBe('Bash');
  });

  test('a 4xx is not retried and reports the API error', async () => {
    let n = 0;
    const chat = openaiChat({ baseUrl: 'https://x', apiKey: 'k', model: 'm', retryMs: 1, fetchImpl: (async () => (n++, new Response('bad key', { status: 401 }))) as any });
    await expect(chat([], [])).rejects.toThrow('401 bad key');
    expect(n).toBe(1);
  });
});

describe('runTurn', () => {
  function setup(replies: ChatMessage[], hq: (p: any) => any = () => ({})) {
    const cwd = tmp();
    const sent: any[] = [];
    const queue = [...replies];
    const prompts: ChatMessage[][] = [];
    const hooks: Hooks = {
      send: async (p) => (sent.push(p), hq(p)),
      mcp: async (name, args) => `mcp:${name}:${JSON.stringify(args)}`,
    };
    const chat = async (m: ChatMessage[]) => (prompts.push(m.map((x) => ({ ...x }))), queue.shift()!);
    const session = { sessionId: 's1', messages: [{ role: 'system', content: 'sys' }] as ChatMessage[] };
    const opts = { chat, tools: builtinTools(true), mcpNames: new Set(['mcp__company__report']), cwd, hooks };
    return { cwd, sent, session, opts, prompts };
  }

  test('tool loop: hooks in order, builtin and MCP tools run, final text returned', async () => {
    const t = setup([
      { role: 'assistant', content: null, tool_calls: [call('1', 'Write', { file_path: 'f.txt', content: 'hello' }), call('2', 'mcp__company__report', { to: 'cto' })] },
      { role: 'assistant', content: 'done' },
    ]);
    expect(await runTurn(t.session, 'go', t.opts)).toBe('done');
    expect(t.sent.map((p) => `${p.hook_event_name}${p.tool_name ? ':' + p.tool_name : ''}`)).toEqual([
      'UserPromptSubmit', 'PreToolUse:Write', 'PostToolUse:Write', 'PreToolUse:mcp__company__report', 'PostToolUse:mcp__company__report', 'Stop',
    ]);
    expect(fs.readFileSync(path.join(t.cwd, 'f.txt'), 'utf8')).toBe('hello');
    expect(t.session.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual([expect.stringContaining('Wrote'), 'mcp:report:{"to":"cto"}']);
  });

  test('a PreToolUse deny blocks the tool and the model sees why', async () => {
    const t = setup(
      [{ role: 'assistant', content: null, tool_calls: [call('1', 'Bash', { command: 'touch SHOULD_NOT_EXIST' })] }, { role: 'assistant', content: 'ok' }],
      (p) => (p.hook_event_name === 'PreToolUse' ? { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'nope' } } : {}),
    );
    await runTurn(t.session, 'go', t.opts);
    expect(fs.existsSync(path.join(t.cwd, 'SHOULD_NOT_EXIST'))).toBe(false);
    expect(t.session.messages.find((m) => m.role === 'tool')!.content).toBe('Blocked: nope');
  });

  test('a Stop block continues the turn with the inbox as the next user message', async () => {
    let stops = 0;
    const t = setup(
      [{ role: 'assistant', content: 'first' }, { role: 'assistant', content: 'second' }],
      (p) => (p.hook_event_name === 'Stop' && stops++ === 0 ? { decision: 'block', reason: '📬 new task' } : {}),
    );
    expect(await runTurn(t.session, 'go', t.opts)).toBe('second');
    expect(t.session.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['go', '📬 new task']);
  });

  test('works against a real HTTP server (OpenAI wire format)', async () => {
    const bodies: any[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push(await req.json());
        return Response.json({ choices: [{ message: { role: 'assistant', content: `answer ${bodies.length}` } }] });
      },
    });
    try {
      const t = setup([]);
      const chat = openaiChat({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: 'k', model: 'grok-x' });
      expect(await runTurn(t.session, 'hello', { ...t.opts, chat })).toBe('answer 1');
      expect(bodies[0].messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    } finally {
      server.stop(true);
    }
  });
});

describe('HQ launch for openai providers', () => {
  const role = { id: 'dev', name: 'Dev', title: 'Dev', accessory: 'none', color: 'cyan', writes: false, description: '', prompt: '', scope: 'global', file: '' } as any;

  test('grok role: runner script and private config without the key value', () => {
    const hq = new HQ({ roles: [], permMode: 'auto', cwd: tmp(), provider: 'grok' });
    const agent: any = { id: 'dev', role: { ...role, model: 'opus' }, status: 'starting', task: '', children: [], sessionId: 's1', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    const script = fs.readFileSync((hq as any).writeLaunchFiles(agent), 'utf8');
    expect(script).toContain('runner.ts');
    expect(script).toContain('${XAI_API_KEY:?');
    expect(script).toContain('stty -echo');
    expect(script).not.toContain('exec claude');
    const raw = fs.readFileSync(path.join(hq.privateDir, 'dev', 'runner.json'), 'utf8');
    const cfg = JSON.parse(raw);
    expect(cfg).toMatchObject({ baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', model: 'grok-4', writes: false });
    expect(agent.model).toBe('grok-4');
  });
});

describe('context control', () => {
  const big = 'y'.repeat(2000);
  const history = (): ChatMessage[] => [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: null, tool_calls: [call('1', 'Bash', { command: 'x' })] },
    { role: 'tool', tool_call_id: '1', content: big },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: null, tool_calls: [call('2', 'Bash', { command: 'y' })] },
    { role: 'tool', tool_call_id: '2', content: big },
  ];

  test('/clear keeps only the system prompt', async () => {
    const { clearSession } = await import('./runner-core.ts');
    const s: Session = { sessionId: 's', messages: history() };
    clearSession(s);
    expect(s.messages.map((m) => m.role)).toEqual(['system']);
    expect(s.contextTokens).toBeLessThan(5);
  });

  test('/compact keeps the last 2 user turns, shortens their tool outputs and never leaves an orphan tool result', async () => {
    const { compactSession } = await import('./runner-core.ts');
    const s: Session = { sessionId: 's', messages: history() };
    compactSession(s);
    expect(s.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool']);
    expect(s.messages.at(-1)!.content).toContain('shortened by /compact');
    expect(s.messages[1]!.content).toBe('u2');
  });

  test('the API prompt size becomes the context reported with Stop and PostToolUse', async () => {
    const sent: any[] = [];
    const replies = [
      { role: 'assistant', content: null, tool_calls: [call('1', 'Bash', { command: 'true' })], promptTokens: 1234 },
      { role: 'assistant', content: 'done', promptTokens: 1500 },
    ];
    const session = { sessionId: 's', messages: [{ role: 'system', content: 'sys' }] as ChatMessage[] } as any;
    await runTurn(session, 'go', { chat: async () => replies.shift() as any, tools: builtinTools(false), mcpNames: new Set(), cwd: tmp(), hooks: { send: async (p) => (sent.push(p), {}), mcp: async () => '' } });
    expect(sent.find((p) => p.hook_event_name === 'PostToolUse').context_tokens).toBe(1234);
    expect(sent.at(-1)).toMatchObject({ hook_event_name: 'Stop', context_tokens: 1500 });
    expect(session.messages.some((m: any) => 'promptTokens' in m)).toBe(false);
  });
});

describe('HQ context handling for non-Claude agents', () => {
  const role = { id: 'dev', name: 'Dev', title: 'Dev', accessory: 'none', color: 'cyan', writes: true, description: '', prompt: '', scope: 'global', file: '' } as any;
  const withAgent = (provider: string) => {
    const hq = new HQ({ roles: [], permMode: 'auto', cwd: tmp(), provider });
    const a: any = { id: 'dev', role, status: 'idle', task: '', children: [], sessionId: 's', tmux: 't', inbox: [], timeline: [], stopBlocks: 0 };
    (hq as any).agents.set('dev', a);
    return { hq, a };
  };

  test('context_tokens from a hook sets the agent context; a compact SessionStart keeps the reported value', () => {
    const { hq, a } = withAgent('grok');
    (hq as any).onHook('dev', { hook_event_name: 'Stop', context_tokens: 4321 });
    expect(a.ctxTokens).toBe(4321);
    a.compactedFrom = 9000;
    (hq as any).onHook('dev', { hook_event_name: 'SessionStart', source: 'compact', context_tokens: 800 });
    expect(a.ctxTokens).toBe(800);
  });

  test('opencode agents are never sent /clear or /compact; the runner and claude are', () => {
    const oc = withAgent('opencode');
    expect(oc.hq.clear('dev')).toBe(false);
    expect(oc.hq.compact('dev')).toBe(false);
    const typed: string[] = [];
    const gr = withAgent('grok');
    (gr.hq as any).typeCommand = (_a: any, cmd: string) => typed.push(cmd);
    expect(gr.hq.compact('dev')).toBe(true);
    expect(typed).toEqual(['/compact']);
  });
});
