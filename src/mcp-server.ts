// `company` MCP server, spawned by each agent's claude over stdio. Forwards every tool call to HQ.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SOCKET = process.env.ORQ_SOCKET!;
const AGENT = process.env.ORQ_AGENT_ID!;

async function call(tool: string, args: Record<string, unknown>) {
  try {
    const res = await fetch('http://hq/tool', {
      unix: SOCKET,
      method: 'POST',
      body: JSON.stringify({ agent: AGENT, tool, args }),
    } as RequestInit);
    const j = (await res.json()) as { result?: unknown; error?: string };
    if (j.error) return { content: [{ type: 'text' as const, text: j.error }], isError: true };
    const text = typeof j.result === 'string' ? j.result : JSON.stringify(j.result);
    return { content: [{ type: 'text' as const, text }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Company HQ unreachable: ${e}` }], isError: true };
  }
}

const server = new McpServer({ name: 'company', version: '0.2.0' });

server.registerTool(
  'team',
  {
    description: 'Without `agent`: live board of the team (who does what, blocked, done, recent messages). With `agent`: that colleague\'s recent history (`view: "activity"`) or current terminal (`view: "screen"`).',
    inputSchema: {
      agent: z.string().optional().describe('Employee id'),
      view: z.enum(['activity', 'screen']).optional(),
      lines: z.number().int().min(5).max(200).optional(),
    },
  },
  (args) => call('team', args),
);

server.registerTool(
  'send_message',
  {
    description: 'Message an employee (id) or the human owner (`user`). Keep it short.',
    inputSchema: { to: z.string(), body: z.string(), type: z.enum(['message', 'question', 'answer']).optional() },
  },
  (args) => call('send_message', args),
);

server.registerTool(
  'delegate_task',
  {
    description: 'Assign a task: goal, context, constraints, owned paths (writers), expected deliverable. They `report` back.',
    inputSchema: { to: z.string(), task: z.string() },
  },
  (args) => call('delegate_task', args),
);

server.registerTool(
  'report',
  {
    description: 'Report a task result to whoever asked. `summary`: at most ~10 lines (longer is cut for the recipient). `details`: optional long text, saved to the run log for the user only.',
    inputSchema: {
      to: z.string(),
      summary: z.string(),
      status: z.enum(['done', 'blocked', 'partial']),
      details: z.string().optional(),
    },
  },
  (args) => call('report', args),
);

server.registerTool(
  'log',
  {
    description: 'Append text without reading anything: to the run log the user reads (no `file`), or to a project file such as a changelog or bug list (`file`, writers only).',
    inputSchema: { text: z.string(), file: z.string().optional().describe('Path inside the working directory') },
  },
  (args) => call('log', args),
);

server.registerTool(
  'set_status',
  { description: 'Short text (<60 chars) shown under your character: what you are doing now.', inputSchema: { task: z.string() } },
  (args) => call('set_status', args),
);

server.registerTool('inbox', { description: 'Fetch pending messages addressed to you.' }, () => call('inbox', {}));

server.registerTool(
  'memory',
  {
    description: 'Durable memory. `save`: keep a short fact you must not lose (decision, path, constraint); it survives /clear and resume. `search`: look up past messages and notes (this run, or `scope: "project"` for earlier runs) instead of asking or re-reading.',
    inputSchema: {
      action: z.enum(['save', 'search']),
      text: z.string().describe('Note to save, or search words'),
      scope: z.enum(['run', 'project']).optional(),
      limit: z.number().int().min(1).max(15).optional(),
    },
  },
  (args) => call('memory', args),
);

server.registerTool(
  'ask_user',
  {
    description: 'Ask the human owner ONE question, only when essential (destructive or irreversible action, credentials, money, scope change). 2-4 options, recommended first with "(recomendado)". The answer arrives later as a message.',
    inputSchema: { question: z.string(), options: z.array(z.string()).max(4).optional() },
  },
  (args) => call('ask_user', args),
);

server.registerTool(
  'set_title',
  { description: 'Coordinator only: session title (at most 6 words, Spanish).', inputSchema: { title: z.string() } },
  (args) => call('set_title', args),
);

server.registerTool(
  'request_hire',
  { description: 'Ask the user to hire a role from the library that is not in the company.', inputSchema: { role: z.string(), reason: z.string() } },
  (args) => call('request_hire', args),
);

await server.connect(new StdioServerTransport());
