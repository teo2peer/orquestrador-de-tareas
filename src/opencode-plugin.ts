// opencode plugin loaded by orq agents of provider kind "opencode": forwards the session's events to HQ
// as the same hooks Claude Code sends, so status, timeline and message delivery work unchanged.
// Only the plugin function may be exported here (opencode treats every export as a plugin).
import { interpretReply, notification, postTool, preTool, sessionStart, stop, userPrompt, type OpencodeHook } from './opencode-map.ts';

const SOCKET = process.env.ORQ_SOCKET;
const AGENT = process.env.ORQ_AGENT_ID;

async function send(payload: OpencodeHook): Promise<Record<string, any>> {
  if (!SOCKET || !AGENT) return {};
  try {
    const res = await fetch('http://hq/hook', {
      unix: SOCKET,
      method: 'POST',
      body: JSON.stringify({ agent: AGENT, payload }),
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    return (await res.json()) as Record<string, any>;
  } catch {
    return {}; // HQ down: never block the agent.
  }
}

export const OrqPlugin = async ({ client }: { client: any }) => {
  const roles = new Map<string, string>(); // messageID → role
  const texts = new Map<string, string>(); // sessionID → last assistant text
  const started = new Set<string>();
  const args = new Map<string, Record<string, any>>(); // callID → tool args

  const begin = async (sessionId: string) => {
    if (started.has(sessionId)) return;
    started.add(sessionId);
    await send(sessionStart(sessionId));
  };

  return {
    'chat.message': async (input: any, output: any) => {
      const sessionId = String(input?.sessionID ?? output?.message?.sessionID ?? '');
      if (!sessionId) return;
      await begin(sessionId);
      const prompt = (output?.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
      await send(userPrompt(sessionId, prompt));
    },
    'tool.execute.before': async (input: any, output: any) => {
      args.set(input.callID, output.args ?? {});
      const { deny } = interpretReply(await send(preTool(input.sessionID, input.tool, output.args ?? {})));
      if (deny) throw new Error(deny);
    },
    'tool.execute.after': async (input: any) => {
      const a = args.get(input.callID) ?? {};
      args.delete(input.callID);
      await send(postTool(input.sessionID, input.tool, a));
    },
    event: async ({ event }: { event: any }) => {
      const p = event?.properties ?? {};
      if (event.type === 'session.created' && p.info?.id) return begin(p.info.id);
      if (event.type === 'message.updated' && p.info?.id) roles.set(p.info.id, p.info.role);
      if (event.type === 'message.part.updated' && p.part?.type === 'text' && roles.get(p.part.messageID) === 'assistant') texts.set(p.part.sessionID, String(p.part.text ?? ''));
      if (event.type === 'permission.asked' || event.type === 'permission.updated') {
        const sid = String(p.sessionID ?? '');
        return void (await send(notification(sid, `opencode needs permission: ${p.title ?? p.permission ?? 'tool call'}`)));
      }
      if (event.type === 'session.idle' && p.sessionID) {
        const sid = String(p.sessionID);
        const { inject } = interpretReply(await send(stop(sid, texts.get(sid) ?? '')));
        texts.delete(sid);
        if (inject) {
          try {
            await client.session.prompt({ path: { id: sid }, body: { parts: [{ type: 'text', text: inject }] } });
          } catch {
            // The message stays in HQ's inbox and is delivered by the tmux paste fallback.
          }
        }
      }
    },
  };
};
