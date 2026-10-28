// Entry point of agents whose provider kind is "openai": `bun runner.ts <config.json>` inside the agent's tmux pane.
// HQ talks to it like to a Claude pane: messages are pasted into the terminal, hooks come back over HQ's socket.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import { clearSession, compactSession, openaiChat, runTurn, builtinTools, type Hooks, type RunnerConfig, type Session, type ToolDef } from './runner-core.ts';

const cfg = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as RunnerConfig;
const apiKey = process.env[cfg.keyEnv];
if (!apiKey) {
  console.error(`orq: set ${cfg.keyEnv} in your shell environment (API key of this provider)`);
  process.exit(1);
}
const SOCKET = process.env.ORQ_SOCKET;
const AGENT = process.env.ORQ_AGENT_ID;

let working = false;
// While a turn runs the last row says "esc to interrupt": HQ reads it to know the agent is busy (same cue as claude).
const status = () => (working ? process.stdout.write('\r\x1b[K… trabajando (esc to interrupt)') : process.stdout.write('\r\x1b[K'));
const say = (line: string) => {
  process.stdout.write('\r\x1b[K');
  console.log(line.length > 600 ? `${line.slice(0, 600)}…` : line);
  status();
};

async function send(payload: Record<string, unknown>): Promise<Record<string, any>> {
  if (!SOCKET || !AGENT) return {};
  try {
    const res = await fetch('http://hq/hook', { unix: SOCKET, method: 'POST', body: JSON.stringify({ agent: AGENT, payload }), signal: AbortSignal.timeout(5000) } as RequestInit);
    return (await res.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

const client = new Client({ name: 'orq-runner', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: cfg.mcp.command, args: cfg.mcp.args, env: { ...(process.env as Record<string, string>), ...cfg.mcp.env } }));
const mcpTools: ToolDef[] = (await client.listTools()).tools.map((t) => ({
  name: `mcp__company__${t.name}`,
  description: t.description ?? t.name,
  parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
}));

const hooks: Hooks = {
  send,
  say,
  mcp: async (name, args) => {
    const r: any = await client.callTool({ name, arguments: args });
    return (r.content ?? []).map((c: any) => c.text ?? '').join('\n') || '(no output)';
  },
};
const chat = openaiChat({ baseUrl: cfg.baseUrl, apiKey, model: cfg.model });
const session: Session = { sessionId: cfg.sessionId, messages: [{ role: 'system', content: fs.readFileSync(cfg.system, 'utf8') }] };
const tools = [...builtinTools(cfg.writes), ...mcpTools];
const mcpNames = new Set(mcpTools.map((t) => t.name));

console.log(`orq runner · ${cfg.model} @ ${cfg.baseUrl}`);
await send({ hook_event_name: 'SessionStart', session_id: cfg.sessionId, source: 'startup' });

// Input: HQ pastes a message and presses Enter. Lines that arrive together (a multi-line paste) are one message.
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let busy = Promise.resolve();
const flush = () => {
  const text = pending.join('\n').trim();
  pending = [];
  if (!text) return;
  // The commands HQ types to free context (same contract as Claude's: SessionStart when done, no turn).
  if (text === '/clear' || text === '/compact') {
    busy = busy.then(async () => {
      (text === '/clear' ? clearSession : compactSession)(session);
      say(`${text === '/clear' ? '↺ contexto limpiado' : '⇣ contexto compactado'} (~${session.contextTokens} tok)`);
      await send({ hook_event_name: 'SessionStart', session_id: cfg.sessionId, source: text === '/clear' ? 'clear' : 'compact', context_tokens: session.contextTokens });
    });
    return;
  }
  busy = busy.then(async () => {
    working = true;
    say(`▶ mensaje recibido (${text.length} car.)`);
    try {
      await runTurn(session, text, { chat, tools, mcpNames, cwd: cfg.cwd, hooks });
    } catch (e: any) {
      say(`⚠ ${e?.message ?? e}`);
      await send({ hook_event_name: 'Notification', session_id: cfg.sessionId, message: `Provider error: ${String(e?.message ?? e).slice(0, 200)}` });
      // Back to idle for HQ: the turn is over even though it failed.
      await send({ hook_event_name: 'Notification', session_id: cfg.sessionId, message: 'Claude is waiting for your input' });
    }
    working = false;
    status();
  });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  pending.push(...chunk.replace(/\x1b\[20[01]~/g, '').split('\n'));
  clearTimeout(timer);
  timer = setTimeout(flush, 350);
});
process.stdin.on('end', () => process.exit(0));
