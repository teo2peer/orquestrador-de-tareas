import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_SCRIPT } from './paths.ts';

// End to end: the real runner process against a fake OpenAI server and a fake HQ socket (real company MCP server in between).
test('runner: message on stdin → model → company tool through MCP → Stop hook', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-e2e-'));
  const sock = path.join(dir, 'hq.sock');
  const hooks: any[] = [];
  const tools: any[] = [];
  const hq = Bun.serve({
    unix: sock,
    async fetch(req) {
      const url = new URL(req.url);
      const body: any = await req.json();
      if (url.pathname === '/hook') return (hooks.push(body.payload), Response.json({}));
      tools.push(body);
      return Response.json({ result: 'board: all idle' });
    },
  });
  let turn = 0;
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: any = await req.json();
      turn++;
      if (turn === 1) {
        expect(body.tools.map((t: any) => t.function.name)).toContain('mcp__company__team');
        return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__company__team', arguments: '{}' } }] } }] });
      }
      const toolMsg = body.messages.find((m: any) => m.role === 'tool');
      return Response.json({ choices: [{ message: { role: 'assistant', content: `saw: ${toolMsg.content}` } }] });
    },
  });
  const system = path.join(dir, 'system.md');
  fs.writeFileSync(system, 'You are a test agent');
  const cfg = path.join(dir, 'runner.json');
  fs.writeFileSync(cfg, JSON.stringify({ baseUrl: `http://localhost:${api.port}/v1`, keyEnv: 'ORQ_E2E_KEY', model: 'm', system, cwd: dir, writes: false, sessionId: 's1', mcp: { command: process.execPath, args: [MCP_SCRIPT], env: { ORQ_SOCKET: sock, ORQ_AGENT_ID: 'dev' } } }));
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, 'runner.ts'), cfg], {
    cwd: dir,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ORQ_SOCKET: sock, ORQ_AGENT_ID: 'dev', ORQ_E2E_KEY: 'secret' },
  });
  try {
    const until = async (cond: () => boolean, ms = 10_000) => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error(`timeout; hooks: ${hooks.map((h) => h.hook_event_name)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until(() => hooks.some((h) => h.hook_event_name === 'SessionStart'));
    proc.stdin.write('📬 hello\nsecond line\n\n');
    proc.stdin.flush();
    await until(() => hooks.some((h) => h.hook_event_name === 'Stop'));
    expect(hooks.map((h) => h.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(hooks[1].prompt).toBe('📬 hello\nsecond line');
    expect(hooks.at(-1).last_assistant_message).toBe('saw: board: all idle');
    expect(tools[0]).toMatchObject({ agent: 'dev', tool: 'team' });
  } finally {
    proc.kill();
    hq.stop(true);
    api.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('runner without its API key exits with a clear message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-e2e-'));
  const cfg = path.join(dir, 'runner.json');
  fs.writeFileSync(cfg, JSON.stringify({ baseUrl: 'http://x', keyEnv: 'ORQ_E2E_MISSING', model: 'm', system: cfg, cwd: dir, writes: false, sessionId: 's', mcp: { command: 'x', args: [], env: {} } }));
  const env = { ...process.env };
  delete env.ORQ_E2E_MISSING;
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, 'runner.ts'), cfg], { stdout: 'pipe', stderr: 'pipe', env });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain('set ORQ_E2E_MISSING');
  fs.rmSync(dir, { recursive: true, force: true });
});
