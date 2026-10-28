export type Scope = 'global' | 'project';

/** How the team is composed: by role (library roles) or by code area (one owner per path set). */
export type TeamMode = 'role' | 'area';

export type Role = {
  id: string;
  name: string;
  title: string;
  accessory: string; // sprite accessory (see ACCESSORIES in ui/sprites.ts)
  hair?: string;
  skin?: string;
  color: string;
  writes: boolean;
  model?: string;
  /** Provider id (see providers.ts): claude (default), zai, glm, minimax, opencode or one of ~/.orq/providers.yaml. */
  provider?: string;
  description: string;
  prompt: string; // resolved prompt (own body, or the source file body)
  source?: string; // optional external prompt file (role packs)
  pack?: string;
  scope: Scope;
  file: string;
  /** Present only on generated code-area roles: the paths this agent owns. */
  area?: { paths: string[] };
  /** Extra MCP servers (names from the user's Claude config) this role gets besides `company`. */
  mcp?: string[];
  /** @deprecated no longer used by HQ (no automatic clear); still read/saved so role files keep it. */
  fresh?: boolean;
  /** Extra built-in tools in the 'saver' profile, replacing ROLE_TOOL_DEFAULTS (e.g. ["WebFetch", "WebSearch"]). */
  tools?: string[];
  /** false: skip the user's Claude settings (~/.claude CLAUDE.md, rules, hooks, plugins). Default: loaded. */
  userSettings?: boolean;
};

export type Department = {
  id: string;
  name: string;
  icon: string;
  color: string;
  category: string;
  description: string;
  lead?: string;
  roles: string[];
  /** Directories outside the cwd the team always works with (absolute or ~/…): every agent of its runs gets them (--add-dir). */
  dirs?: string[];
  /** Team rules (its AGENTS.md): Markdown in `<id>.md` next to the YAML, appended to every member's role prompt. */
  rules?: string;
  scope: Scope;
  file: string;
};

export type PermMode = 'auto' | 'auto-insecure' | 'yolo';

/**
 * Token-saving profile. saver: strict MCP, lead board as a diff, fresh/compact between tasks and a
 * cheaper model for read-only verifiers; balanced: the same without the model change; max: no savings.
 */
/** Who set the session title: automatic provisional, the lead (set_title) or the user. */
export type TitleSource = 'auto' | 'lead' | 'user';

export type CostProfile = 'saver' | 'balanced' | 'max';

/** How dead agents come back: 'full' reloads the transcript (`claude --resume`), 'light' starts a fresh session with a summary. */
export type ResumeMode = 'light' | 'full';

export type RunAgentMeta = {
  id: string;
  title: string;
  sessionId: string;
  /** Earlier Claude sessions of this agent (light resumes start a new one). */
  prevSessionIds?: string[];
  tmux: string;
  transcript?: string;
  /** Directory of this agent's transcripts (kept when a light resume drops `transcript`). */
  transcriptDir?: string;
  status: AgentStatus;
  role: Role;
};

export type RunMeta = {
  runId: string;
  cwd: string;
  dir: string;
  permMode: PermMode;
  /** Absent on runs created before team modes existed: means 'role'. */
  mode?: TeamMode;
  /** Absent on older runs: means 'max'. */
  profile?: CostProfile;
  /** Session-wide provider override; absent: each role's own. */
  provider?: string;
  lead?: string;
  /** Session title: provisional (first user message / first task) until the lead or the user sets it. */
  title?: string;
  titleProvisional?: boolean;
  titleSource?: TitleSource;
  /** Extra directories of the run (from the launched team), absolute. */
  dirs?: string[];
  /** Department the run was launched as: its rules are re-read on resume. */
  dept?: string;
  startedAt: number;
  updatedAt: number;
  agents: RunAgentMeta[];
};

/** 'dormant': hired but not started yet (no tmux, no claude) until its first waking message. */
export type AgentStatus = 'dormant' | 'starting' | 'idle' | 'working' | 'waiting' | 'error' | 'stopped';

export type MsgType = 'message' | 'task' | 'report' | 'question' | 'answer' | 'system';

export type Msg = {
  id: string;
  ts: number;
  from: string;
  to: string;
  type: MsgType;
  body: string;
  /** Suggested answers of a question to the user (ask_user). */
  options?: string[];
  /** Id of the message this one answers. */
  replyTo?: string;
};

export type Child = { id: string; desc: string; startedAt: number };

export type TimelineKind =
  | 'prompt'
  | 'assistant'
  | 'tool'
  | 'msg_in'
  | 'msg_out'
  | 'status'
  | 'report'
  | 'subagent'
  | 'system';

export type TimelineEvent = { ts: number; kind: TimelineKind; text: string };

export type Agent = {
  id: string;
  role: Role;
  status: AgentStatus;
  task: string;
  lastIn?: string;
  lastOut?: string;
  lastDone?: string;
  lastInAt?: number;
  lastTool?: string;
  notice?: string;
  children: Child[];
  sessionId: string;
  prevSessionIds?: string[];
  tmux: string;
  inbox: Msg[];
  timeline: TimelineEvent[];
  transcriptPath?: string;
  transcriptDir?: string;
  stopBlocks: number;
  /** Tokens in the context window after its last turn (from the transcript usage). */
  ctxTokens?: number;
  /** Effective model this agent was launched with (role model, or the profile's override). */
  model?: string;
  /** Context size when a /compact was sent, to report "before → after" on the next turn. */
  compactedFrom?: number;
  /** /compact did not work for this agent (no compaction, or no smaller context): never retried automatically. */
  compactFailed?: boolean;
  /** /clear did not work for this agent: it is never cleared automatically again. */
  clearFailed?: boolean;
  /** Minimal context for a cleared session, delivered with its next wake-up (never wakes by itself). */
  primer?: string;
  /** User task/message (id) this turn works on: if the turn ends without writing to the user, its final text is recorded as the answer. */
  answering?: string;
};

export type Notice = {
  id: string;
  kind: 'hire' | 'question' | 'info' | 'trust' | 'bypass';
  from: string;
  text: string;
  role?: string;
  /** Suggested answers (questions). */
  options?: string[];
  /** Bus message behind the notice (questions and reports). */
  msgId?: string;
};
