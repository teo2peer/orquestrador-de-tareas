// Translates opencode tool calls into the Claude-style names/inputs HQ's hook handler understands.

const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  list: 'Glob',
  webfetch: 'WebFetch',
  task: 'Task',
};

/** `company_team` (opencode names MCP tools `<server>_<tool>`) → `mcp__company__team`; builtins → Claude names. */
export function claudeToolName(tool: string): string {
  if (TOOL_NAMES[tool]) return TOOL_NAMES[tool]!;
  return tool.startsWith('company_') ? `mcp__company__${tool.slice('company_'.length)}` : tool;
}

/** opencode args (`filePath`, `path`…) → the keys orq-guard and the timeline read (`file_path`…). */
export function claudeToolInput(tool: string, args: Record<string, any> = {}): Record<string, any> {
  const out: Record<string, any> = { ...args };
  const file = args.filePath ?? args.file_path ?? args.path;
  if (typeof file === 'string' && (tool === 'read' || tool === 'edit' || tool === 'write' || tool === 'patch')) out.file_path = file;
  if (tool === 'task') out.description = args.description ?? args.subagent_type;
  return out;
}

export type OpencodeHook = Record<string, unknown> & { hook_event_name: string };

export const sessionStart = (sessionId: string): OpencodeHook => ({ hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup' });
export const userPrompt = (sessionId: string, prompt: string): OpencodeHook => ({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt });
export const preTool = (sessionId: string, tool: string, args: Record<string, any>): OpencodeHook => ({
  hook_event_name: 'PreToolUse',
  session_id: sessionId,
  tool_name: claudeToolName(tool),
  tool_input: claudeToolInput(tool, args),
});
export const postTool = (sessionId: string, tool: string, args: Record<string, any>): OpencodeHook => ({
  hook_event_name: 'PostToolUse',
  session_id: sessionId,
  tool_name: claudeToolName(tool),
  tool_input: claudeToolInput(tool, args),
});
export const stop = (sessionId: string, lastMessage: string): OpencodeHook => ({ hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: lastMessage });
export const notification = (sessionId: string, message: string): OpencodeHook => ({ hook_event_name: 'Notification', session_id: sessionId, message });

/** What the plugin does with HQ's answer to a hook. */
export function interpretReply(reply: Record<string, any>): { deny?: string; inject?: string } {
  const h = reply?.hookSpecificOutput;
  if (h?.permissionDecision === 'deny') return { deny: String(h.permissionDecisionReason ?? 'Blocked by orq') };
  // opencode cannot block a Stop: the pending messages go in as the next user prompt.
  if (reply?.decision === 'block' && reply.reason) return { inject: String(reply.reason) };
  return {};
}
