// Headless agent loop for OpenAI-compatible chat APIs (Grok, Gemini, OpenAI…): the model gets a few
// builtin tools (named like Claude's so HQ's hooks and orq-guard apply) plus the `company` MCP tools.
// Pure of process/tty concerns so it can be tested against a fake server; runner.ts is the entry point.
import fs from 'node:fs';
import path from 'node:path';

export type RunnerConfig = {
  baseUrl: string;
  keyEnv: string;
  model: string;
  system: string;
  cwd: string;
  writes: boolean;
  sessionId: string;
  /** Where the conversation is saved after every turn and reloaded from when the agent restarts (resume). */
  historyFile?: string;
  mcp: { command: string; args: string[]; env: Record<string, string> };
};

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

const MAX_OUTPUT = 20_000;
const MAX_HISTORY_CHARS = 400_000;
const BASH_TIMEOUT_MS = 120_000;

const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[… ${s.length - MAX_OUTPUT} chars cut]` : s);
const obj = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required });
const str = (description: string) => ({ type: 'string', description });

export function builtinTools(writes: boolean): ToolDef[] {
  const tools: ToolDef[] = [
    { name: 'Bash', description: 'Run a shell command in the project directory (120 s timeout). Use it for search (rg/find), git, builds and tests.', parameters: obj({ command: str('Command') }, ['command']) },
    { name: 'Read', description: 'Read a text file (optionally a line range).', parameters: obj({ file_path: str('Path'), offset: { type: 'integer', description: 'First line (1-based)' }, limit: { type: 'integer', description: 'Max lines' } }, ['file_path']) },
  ];
  if (writes)
    tools.push(
      { name: 'Write', description: 'Create or overwrite a file.', parameters: obj({ file_path: str('Path'), content: str('Full content') }, ['file_path', 'content']) },
      { name: 'Edit', description: 'Replace one exact occurrence of old_string with new_string in a file.', parameters: obj({ file_path: str('Path'), old_string: str('Exact text, unique in the file'), new_string: str('Replacement') }, ['file_path', 'old_string', 'new_string']) },
    );
  return tools;
}

/** Runs one builtin tool; failures come back as text for the model, never thrown. */
export async function runBuiltin(name: string, input: Record<string, any>, cwd: string): Promise<string> {
  const abs = (p: unknown) => path.resolve(cwd, String(p ?? '').replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  try {
    if (name === 'Bash') {
      const proc = Bun.spawn(['bash', '-c', String(input.command ?? '')], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
      const timer = setTimeout(() => proc.kill(), BASH_TIMEOUT_MS);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      clearTimeout(timer);
      return clip(`${out}${err ? `\n[stderr]\n${err}` : ''}${code ? `\n[exit ${code}]` : ''}`.trim() || '(no output)');
    }
    if (name === 'Read') {
      const lines = fs.readFileSync(abs(input.file_path), 'utf8').split('\n');
      const from = Math.max(1, Number(input.offset) || 1);
      const slice = lines.slice(from - 1, input.limit ? from - 1 + Number(input.limit) : undefined);
      return clip(slice.map((l, i) => `${from + i}\t${l}`).join('\n'));
    }
    if (name === 'Write') {
      const file = abs(input.file_path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(input.content ?? ''));
      return `Wrote ${file}`;
    }
    if (name === 'Edit') {
      const file = abs(input.file_path);
      const text = fs.readFileSync(file, 'utf8');
      const old = String(input.old_string ?? '');
      const n = old ? text.split(old).length - 1 : 0;
      if (n !== 1) return `Error: old_string matches ${n} times in ${file} (needs exactly 1)`;
      fs.writeFileSync(file, text.replace(old, () => String(input.new_string ?? '')));
      return `Edited ${file}`;
    }
    return `Error: unknown tool ${name}`;
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}

/** Drops the oldest tool results once the history is too big (the model keeps its own notes in assistant turns). */
export function trimHistory(messages: ChatMessage[], maxChars = MAX_HISTORY_CHARS): ChatMessage[] {
  let total = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  if (total <= maxChars) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (const m of out) {
    if (total <= maxChars) break;
    if (m.role === 'tool' && (m.content?.length ?? 0) > 200) {
      total -= m.content!.length - 24;
      m.content = '[old tool output trimmed]';
    }
  }
  return out;
}

/** A model reply plus the prompt size the API reported (the context in tokens). */
export type Reply = ChatMessage & { promptTokens?: number };
export type Chat = (messages: ChatMessage[], tools: ToolDef[]) => Promise<Reply>;

/** chat/completions client with retries on 429/5xx. */
export function openaiChat(o: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch; retryMs?: number }): Chat {
  const f = o.fetchImpl ?? fetch;
  return async (messages, tools) => {
    const body = JSON.stringify({
      model: o.model,
      messages,
      ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}),
    });
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, (o.retryMs ?? 2000) * attempt));
      const res = await f(`${o.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` }, body });
      if (res.ok) {
        const j = (await res.json()) as any;
        const m = j.choices?.[0]?.message;
        if (!m) throw new Error(`API returned no message: ${JSON.stringify(j).slice(0, 300)}`);
        const promptTokens = typeof j.usage?.prompt_tokens === 'number' ? j.usage.prompt_tokens : undefined;
        return { role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}), ...(promptTokens !== undefined ? { promptTokens } : {}) };
      }
      last = `${res.status} ${(await res.text()).slice(0, 300)}`;
      if (res.status !== 429 && res.status < 500) break;
    }
    throw new Error(`API error: ${last}`);
  };
}

export type Hooks = {
  /** Sends a Claude-style hook payload to HQ and returns its reply. */
  send: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  /** Calls a `company` MCP tool (name without prefix). */
  mcp: (name: string, args: Record<string, unknown>) => Promise<string>;
  say?: (line: string) => void;
};

export type Session = { messages: ChatMessage[]; sessionId: string; /** Context size in tokens: the API's last report, or an estimate after local edits. */ contextTokens?: number };

/** Rough size (4 chars per token) for when the API has not reported one. */
export const estimateTokens = (messages: ChatMessage[]) => Math.round(messages.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) / 4);

/** `/clear`: back to the system prompt only. */
export function clearSession(s: Session) {
  s.messages = s.messages.filter((m) => m.role === 'system');
  s.contextTokens = estimateTokens(s.messages);
}

/**
 * `/compact`: keeps the system prompt and the last `keepUsers` user turns (each starts a clean tool-call pair
 * boundary), with every tool output of those shortened. No model call: it must be free and instant.
 */
export function compactSession(s: Session, keepUsers = 2) {
  const users = s.messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const from = users.length > keepUsers ? users[users.length - keepUsers]! : users[0] ?? s.messages.length;
  const kept = s.messages.slice(from).map((m) => (m.role === 'tool' && (m.content?.length ?? 0) > 300 ? { ...m, content: `${m.content!.slice(0, 300)}\n[… shortened by /compact]` } : m));
  s.messages = [...s.messages.filter((m) => m.role === 'system'), ...kept];
  s.contextTokens = estimateTokens(s.messages);
}

/**
 * One user turn: the model answers, runs tools until it stops, HQ's Stop hook may hand back more messages
 * (the inbox), which continue the same turn. Returns the final assistant text.
 */
export async function runTurn(s: Session, prompt: string, o: { chat: Chat; tools: ToolDef[]; mcpNames: Set<string>; cwd: string; hooks: Hooks; maxSteps?: number }): Promise<string> {
  const { hooks } = o;
  const say = hooks.say ?? (() => {});
  let next: string | undefined = prompt;
  let last = '';
  while (next !== undefined) {
    const text: string = next;
    next = undefined;
    await hooks.send({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId, prompt: text });
    s.messages.push({ role: 'user', content: text });
    for (let step = 0; step < (o.maxSteps ?? 60); step++) {
      const { promptTokens, ...reply } = await o.chat(trimHistory(s.messages), o.tools);
      if (promptTokens !== undefined) s.contextTokens = promptTokens;
      s.messages.push(reply);
      if (reply.content) (last = reply.content), say(reply.content);
      if (!reply.tool_calls?.length) break;
      for (const call of reply.tool_calls) {
        let input: Record<string, any> = {};
        try {
          input = JSON.parse(call.function.arguments || '{}');
        } catch {
          // malformed arguments: the tool reports it
        }
        const tool = call.function.name;
        const pre = await hooks.send({ hook_event_name: 'PreToolUse', session_id: s.sessionId, tool_name: tool, tool_input: input, tool_use_id: call.id });
        let result: string;
        if (pre.hookSpecificOutput?.permissionDecision === 'deny') result = `Blocked: ${pre.hookSpecificOutput.permissionDecisionReason ?? 'denied by orq'}`;
        else if (o.mcpNames.has(tool)) result = await hooks.mcp(tool.replace(/^mcp__company__/, ''), input).catch((e) => `Error: ${e?.message ?? e}`);
        else result = await runBuiltin(tool, input, o.cwd);
        say(`⚙ ${tool}`);
        s.messages.push({ role: 'tool', tool_call_id: call.id, content: clip(result) });
        await hooks.send({ hook_event_name: 'PostToolUse', session_id: s.sessionId, tool_name: tool, tool_input: input, tool_use_id: call.id, context_tokens: s.contextTokens });
      }
    }
    const stop = await hooks.send({ hook_event_name: 'Stop', session_id: s.sessionId, last_assistant_message: last, context_tokens: s.contextTokens });
    if (stop.decision === 'block' && stop.reason) next = String(stop.reason);
  }
  return last;
}

/** Saves the conversation (atomic). Best effort: a failure only means no history on resume. */
export function saveHistory(file: string, s: Session) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s.messages), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // ignore
  }
}

/** Messages saved by a previous run of the same session, or undefined. Requires a system prompt first and no orphan tool results. */
export function loadHistory(file: string): ChatMessage[] | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as ChatMessage[];
    if (!Array.isArray(m) || m[0]?.role !== 'system') return undefined;
    const open = new Set<string>();
    for (const x of m) {
      for (const c of x.tool_calls ?? []) open.add(c.id);
      if (x.role === 'tool') open.delete(x.tool_call_id ?? '');
    }
    // A turn cut in the middle (tool calls without results) cannot be sent back to the API: drop its tail.
    if (open.size) {
      const cut = m.findLastIndex((x) => x.role === 'user');
      return cut > 0 ? m.slice(0, cut) : [m[0]!];
    }
    return m;
  } catch {
    return undefined;
  }
}
