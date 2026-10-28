import { providerOf } from '../providers.ts';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import React, { useEffect, useState } from 'react';
import { AUTO_COMPACT_AT, COMPACT_AT, USER } from '../hq.ts';
import * as tmux from '../tmux.ts';
import type { Agent, Role, TimelineEvent, TimelineKind } from '../types.ts';
import { type Alert, DRAFT_NOTE, VSep, WIDE_COLS, ago, alertsOf, nAgents, useApp, useCopy, useDraft, useSize, useTick, wrap } from './app-context.tsx';
import { MODAL_GUARD_MS, Modal, modalContentWidth, moveIndex, usePasteSink, useKeyboardCursor, useNav, useShortcuts, useModal } from './keymap.tsx';
import { g } from './glyphs.ts';
import { Clickable, MouseLayer } from './mouse.tsx';
import { defaultLook, lastOutAt, miniRows, spriteRows, stateFor, toHex } from './sprites.ts';
import { DormantPane, EXIT_LABEL, LivePane } from './Terminals.tsx';
import { BORDER, DANGER, DONE, FOCUS, INFO, KIND, MUTED, PRIMARY, SELECTED_BG, PERM_COLOR, PERM_SHORT, PROFILE_SHORT, RECEIVED, SENT, STATUS, statusAria, SUCCESS, TEXT, WARN } from './theme.ts';
import { type CtxLevel, ctxLabel, kTok } from './cost.ts';
import { picks } from './pick.ts';
import { barFit, barStart, filterChunk, filterRoles, freeRoles, groupedRows, moreLabel } from './hire-list.ts';
import { TITLE_MAX, cleanTitle } from './Sessions.tsx';
import { BackButton, Button, CardGrid, Divider, TextArea, TextField, Toggle, buttonWidth, toggleWidth, gridLayout as cardLayout, useFocusState, useScroll, ScrollArea, Scrollbar } from './widgets.tsx';

export { STATUS };

// Compact cards (5 inner rows): mini sprite beside name · state + ctx · model + subagents ·
// task (or the alert), then the latest message (or the task when an alert took its row).
// 7 rows high so two rows of cards fit the 80×24 office floor (15 rows).
export const CARD_W = 28;
export const CARD_H = 7;
const cut = (s: string | undefined, n: number) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);
const strip = (s?: string) => s?.replace(/^[←→] /, '');

export const lookOf = (a: Agent) => defaultLook(a.role.id, a.role.color, a.role.accessory, a.role.hair, a.role.skin);
const talkingNow = (a: Agent) => !!a.lastInAt && Date.now() - a.lastInAt < 3000;
/** Sprite state: walks for a moment after sending a message (see sprites.ts WALK_MS). */
const spriteState = (a: Agent) => stateFor(a.status, talkingNow(a), lastOutAt(a), Date.now());
const lastActivity = (a: Agent) => Math.max(a.timeline.at(-1)?.ts ?? 0, a.lastInAt ?? 0) || undefined;
/** Effective model of an agent, also before it starts (dormant agents have no `model` yet). */
function useModel(a: Agent): string | undefined {
  const { hq } = useApp();
  return a.model ?? hq?.effectiveModel?.(a.role);
}

/** What a dormant agent (lazy start) is waiting for, or the FYIs already waiting for it. */
export const dormantNote = (a: Pick<Agent, 'inbox'>) => {
  const n = a.inbox?.length ?? 0;
  return n ? `${n} aviso${n === 1 ? '' : 's'} pendiente${n === 1 ? '' : 's'}` : 'arranca con su primera tarea';
};
const CTX_COLOR: Record<CtxLevel, string> = { normal: MUTED, high: WARN, over: DANGER };
/** Lowest compaction threshold of the session: hq's between-task one (profile) or claude's own auto-compact. */
const ctxLimit = (profile: keyof typeof COMPACT_AT) => Math.min(COMPACT_AT[profile] ?? AUTO_COMPACT_AT, AUTO_COMPACT_AT);

/** «ctx 84k» coloured by level; nothing without data. */
function Ctx({ a, lead = ' ' }: { a: Agent; lead?: string }) {
  const { hq } = useApp();
  const c = ctxLabel(a.ctxTokens, ctxLimit(hq?.profile ?? 'max'));
  if (!c.text) return null;
  return (
    <Text color={CTX_COLOR[c.level]} aria-label={c.aria}>
      {lead}
      {g.sep} {c.text}
    </Text>
  );
}

const permText = (m: keyof typeof PERM_SHORT) => `${m === 'auto' ? '' : `${g.warning} `}${PERM_SHORT[m]}`;

function Minis({ a, tick, max = 3 }: { a: Agent; tick: number; max?: number }) {
  const look = lookOf(a);
  return (
    <Box flexDirection="row">
      {a.children.slice(0, max).map((c, i) => (
        <Box key={c.id} flexDirection="column" marginRight={1}>
          {miniRows(look, tick + i * 2).map((r, j) => (
            <Text key={j}>{r}</Text>
          ))}
        </Box>
      ))}
      {a.children.length > max && <Text color={MUTED}>+{a.children.length - max}</Text>}
    </Box>
  );
}

function Bubble({ a }: { a: Agent }) {
  const b = a.status === 'waiting' ? '?' : a.status === 'stopped' ? 'z' : talkingNow(a) ? g.mail : a.status === 'working' ? g.ellipsis : ' ';
  return (
    <Text color={talkingNow(a) ? RECEIVED : WARN} bold>
      {b}
    </Text>
  );
}

// --------------------------------------------------------------- card view

/** The most recent of the last message sent (→) or received (←). */
function lastMessage(a: Agent): { dir: 'out' | 'in'; text: string } | undefined {
  const outAt = lastOutAt(a) ?? 0;
  const inAt = a.lastInAt ?? 0;
  const out = strip(a.lastOut);
  const inn = strip(a.lastIn);
  if (out && (!inn || outAt >= inAt)) return { dir: 'out', text: out };
  if (inn) return { dir: 'in', text: inn };
  return undefined;
}

/** Card mark for what needs the user: a pending question or a blocked agent (border turns WARN). */
function cardAlert(a: Agent): string | undefined {
  if (a.notice) return `${g.warning} ${a.notice}`;
  if (a.status === 'waiting') return `${g.warning} pregunta ${g.sep} ↵`;
  return undefined;
}

/** Columns of the card's right column: border 2 + padding 2 + sprite 6 + bubble 1. */
const RIGHT_W = CARD_W - 11;
/** Short model name: opus / sonnet / haiku / fable; «def.» without one. */
// Nothing for the default model: a name only when one is explicit or the profile changes it.
export const shortModel = (m?: string) => (m ? (/(opus|sonnet|haiku|fable)/i.exec(m)?.[1]?.toLowerCase() ?? m) : '');

/** « · Proveedor: x» when the session forces one, or the non-Claude ones its roles use; '' for plain Claude. */
export function providerStat(hq: { provider?: string; agents: Map<string, Agent> }) {
  if (hq.provider) return ` ${g.sep} Proveedor: ${hq.provider}`;
  const ids = [...new Set([...hq.agents.values()].map((a) => providerOf({ provider: a.role.provider }).id))].filter((id) => id !== 'claude');
  return ids.length ? ` ${g.sep} Proveedor: ${ids.join('+')}` : '';
}

function AgentCard({ a, lead, selected, cursor, tick, onClick, width = CARD_W }: { a: Agent; lead: boolean; selected: boolean; cursor?: boolean; tick: number; onClick: () => void; width?: number }) {
  const model = useModel(a);
  const st = STATUS[a.status];
  const color = toHex(a.role.color);
  const sprite = miniRows(lookOf(a), tick, a.status === 'dormant' || a.status === 'stopped' ? 'gray' : 'normal', spriteState(a));
  const alert = cardAlert(a);
  const msg = lastMessage(a);
  const subs = a.children.length;
  const { hq } = useApp();
  const ctx = ctxLabel(a.ctxTokens, ctxLimit(hq?.profile ?? 'max'));
  // Dormant in the narrow column: «N avisos» or that it starts with its first task.
  const dormantShort = a.inbox.length ? `${a.inbox.length} aviso${a.inbox.length === 1 ? '' : 's'}` : 'arranca al recibir tarea';
  const taskText = a.status === 'dormant' ? dormantShort : a.task || (a.status === 'working' && a.lastTool ? a.lastTool : undefined);
  const task = (
    <Text wrap="truncate">{taskText ? <Text color={a.status === 'dormant' ? MUTED : TEXT}>{g.bullet} {taskText}</Text> : <Text color={MUTED}>{g.bullet} sin tarea</Text>}</Text>
  );
  const last = msg ? (
    <Text wrap="truncate" color={msg.dir === 'out' ? SENT : RECEIVED}>
      {msg.dir === 'out' ? g.out : g.in} {msg.text}
    </Text>
  ) : a.lastDone ? (
    <Text wrap="truncate" color={DONE}>
      {g.tick} {a.lastDone}
    </Text>
  ) : (
    <Text color={MUTED} wrap="truncate">
      {g.out} sin mensajes
    </Text>
  );
  const aria = [a.role.name, lead ? 'coordinador' : '', statusAria(a.status), a.ctxTokens ? `contexto ${Math.round(a.ctxTokens / 1000)} mil` : '', taskText ? `tarea: ${taskText}` : '', alert ?? ''].filter(Boolean).join(', ');
  return (
    <Clickable
      onClick={onClick}
      width={width}
      height={CARD_H}
      flexDirection="column"
      borderStyle={cursor ? 'bold' : selected ? 'double' : 'round'}
      borderColor={cursor ? FOCUS : alert ? WARN : selected ? FOCUS : color}
      paddingX={1}
      marginRight={1}
      flexShrink={0}
      aria-role="button"
      aria-label={aria}
      aria-state={{ selected }}
    >
      <Box flexDirection="row" height={4}>
        <Box flexDirection="column" width={6} flexShrink={0}>
          {sprite.map((r, i) => (
            <Text key={i}>{r}</Text>
          ))}
        </Box>
        <Box width={1} flexShrink={0}>
          <Bubble a={a} />
        </Box>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <Text bold color={color} wrap="truncate">
            {cursor ? `${g.cursor} ` : selected ? `${g.focus} ` : ''}
            {lead ? `${g.star} ` : ''}
            {a.role.name}
            {a.role.area ? ` ${g.area}` : ''}
          </Text>
          {/* The state gives way before the context size. */}
          <Text wrap="truncate">
            <Text color={st.color}>
              {st.glyph} {ctx.text ? cut(st.label, Math.max(3, RIGHT_W - 2 - stringWidth(ctx.text) - 3)) : st.label}
            </Text>
            {ctx.text ? <Text color={CTX_COLOR[ctx.level]}>{` ${g.sep} ${ctx.text}`}</Text> : null}
          </Text>
          <Text color={MUTED} wrap="truncate">
            {[shortModel(model), subs ? `${g.subagent} +${subs} sub` : ''].filter(Boolean).join(` ${g.sep} `)}
          </Text>
          {alert ? (
            <Text color={WARN} bold wrap="truncate">
              {alert}
            </Text>
          ) : (
            task
          )}
        </Box>
      </Box>
      {/* An alert takes the task's row; the task then takes the message's. */}
      {alert ? task : last}
    </Clickable>
  );
}

// --------------------------------------------------------------- list view

const LIST_ROW_H = 4;

function ListHeader({ widths }: { widths: number[] }) {
  const [w0, w1, w2, w3, w4] = widths as [number, number, number, number, number];
  const col = (t: string, w: number) => (t.length >= w ? t.slice(0, w - 2) + '… ' : t.padEnd(w));
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text bold color={MUTED}>
        {col(' Personaje', w4 + 1)}
        {col('Agente', w0 - 1)}
        {col('Tarea en curso / última hecha', w1)}
      </Text>
      <Text bold color={SENT}>
        {col(`${g.out} Último enviado`, w2)}
      </Text>
      <Text bold color={RECEIVED}>
        {col(`${g.in} Último recibido`, w3)}
      </Text>
    </Box>
  );
}

function AgentRow({ a, lead, selected, cursor, tick, widths, onClick }: { a: Agent; lead: boolean; selected: boolean; cursor?: boolean; tick: number; widths: number[]; onClick: () => void }) {
  const [w0, w1, w2, w3, w4] = widths as [number, number, number, number, number];
  const model = useModel(a);
  const st = STATUS[a.status];
  // The keyboard cursor row is drawn inverse, without cell colours.
  const tone = (c: string) => (cursor ? undefined : c);
  const color = toHex(a.role.color);
  const cell = (text: string | undefined, w: number, n = 3) => wrap(text || '—', w - 4, n);
  return (
    <Clickable onClick={onClick} flexDirection="row" height={LIST_ROW_H} flexShrink={0} aria-role="button" aria-label={`${a.role.name}, ${st.label}`} aria-state={{ selected }}>
      <Box width={1} flexDirection="column">
        {[0, 1, 2, 3].map((i) => (
          <Text key={i} color={selected ? FOCUS : color}>
            {selected ? g.vThumb : g.vLine}
          </Text>
        ))}
      </Box>
      <Box flexDirection="row" width={w4}>
        <Box flexDirection="column" width={7}>
          {miniRows(lookOf(a), tick, a.status === 'dormant' ? 'gray' : 'normal', spriteState(a)).map((r, i) => (
            <Text key={i}>{r}</Text>
          ))}
        </Box>
        <Box width={2}>
          <Bubble a={a} />
        </Box>
        <Minis a={a} tick={tick} max={2} />
      </Box>
      <Box flexDirection="column" width={w0 - 1}>
        <Text bold color={tone(color)} inverse={cursor} wrap="truncate">
          {cursor ? `${g.cursor} ` : selected ? `${g.focus} ` : ''}
          {lead ? `${g.star} ` : ''}
          {a.role.area ? `${g.area} ` : ''}
          {a.role.name}
        </Text>
        <Text color={tone(st.color)} wrap="truncate">
          {st.glyph} {st.label}
          <Ctx a={a} />
        </Text>
        <Text color={MUTED} wrap="truncate">
          {/* The model first: the narrow column truncates the note, not the model. */}
          {a.status === 'dormant' ? `${model ? `${model} ${g.sep} ` : ''}${dormantNote(a)}` : a.status === 'working' ? cut(a.lastTool, w0 - 2) : ago(lastActivity(a))}
          {model && a.status !== 'dormant' ? ` ${g.sep} ${model}` : ''}
        </Text>
      </Box>
      <Box flexDirection="column" width={w1}>
        {a.task ? (
          cell(a.task, w1, 2).map((l, i) => (
            <Text key={i} wrap="truncate">
              {i === 0 ? `${g.bullet} ` : '  '}
              {l}
            </Text>
          ))
        ) : (
          <Text color={MUTED}>{g.bullet} sin tarea</Text>
        )}
        <Text color={DONE} wrap="truncate">
          {g.tick} {a.lastDone ?? '—'}
        </Text>
      </Box>
      {/* Arrow prefixes keep sent/received distinguishable without colour. */}
      <Box flexDirection="column" width={w2}>
        {cell(strip(a.lastOut), w2).map((l, i) => (
          <Text key={i} color={tone(SENT)} wrap="truncate">
            {i === 0 ? `${g.out} ` : '  '}
            {l}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" width={w3}>
        {cell(strip(a.lastIn), w3).map((l, i) => (
          <Text key={i} color={tone(RECEIVED)} wrap="truncate">
            {i === 0 ? `${g.in} ` : '  '}
            {l}
          </Text>
        ))}
      </Box>
    </Clickable>
  );
}

// ------------------------------------------------------------ agent panel

type PanelTab = 'history' | 'claude' | 'shell';

const EVENT_TITLE: Record<TimelineKind, string> = {
  prompt: 'Prompt',
  assistant: 'Respuesta',
  tool: 'Herramienta',
  msg_in: 'Mensaje recibido',
  msg_out: 'Mensaje enviado',
  status: 'Estado',
  report: 'Informe',
  subagent: 'Subagente',
  system: 'Sistema',
};

function AgentPanel({
  a,
  width,
  height,
  onClose,
  onBack,
  initialTab = 'history',
}: {
  a: Agent;
  width: number;
  height: number;
  onClose: () => void;
  onBack?: () => void;
  initialTab?: PanelTab;
}) {
  const { hq } = useApp();
  const modal = useModal();
  const [tab, setTab] = useState<PanelTab>(initialTab);
  const [interact, setInteract] = useState(false);
  const color = toHex(a.role.color);
  const st = STATUS[a.status];
  const inner = width - 2;
  const textW = inner - 11;
  const lines = a.timeline.flatMap((e) => {
    const isCmd = e.kind === 'tool' && e.text.startsWith('Bash ');
    const k = isCmd ? { icon: '$', color: WARN } : KIND[e.kind];
    const t = new Date(e.ts).toLocaleTimeString('es-ES', { hour12: false });
    const text = isCmd ? e.text.slice(5) : e.text;
    return wrap(text, textW, e.kind === 'tool' ? 1 : 8).map((l, i) => ({ key: `${e.ts}-${e.kind}-${i}`, t: i ? '' : t, icon: i ? ' ' : k.icon, color: k.color, l, e }));
  });
  const copy = useCopy();
  // Clicking an event opens its full text (long events are cut to a few rows here).
  const showEvent = (e: TimelineEvent) =>
    modal.open({
      title: `${EVENT_TITLE[e.kind]} ${g.sep} ${name} ${g.sep} ${new Date(e.ts).toLocaleTimeString('es-ES', { hour12: false })}`,
      lines: e.text.split('\n'),
      maxWidth: 100,
      actions: [{ label: `${g.copy} [C]opiar`, variant: 'secondary', run: () => copy(e.text) }],
      cancelLabel: 'Cerrar (Esc)',
    });
  // name · status · task · panel tabs · actions · divider (no border, one-row buttons)
  // name · status · task · context · panel tabs · actions · divider (no border, one-row buttons)
  // name · status · last done · task · context (+ «no surtió efecto») · tabs · actions · divider
  const viewH = Math.max(3, height - 8 - (a.compactFailed ? 1 : 0));
  const scroll = useScroll(lines.length, viewH, true);
  const { offset } = scroll;
  const select = (t: PanelTab) => {
    setInteract(false);
    setTab(t);
  };
  const name = a.role.name;
  const askFire = () =>
    modal.open({
      title: `¿Despedir a ${name}? Se cerrarán sus terminales.`,
      lines: ['Su historial se conserva y puedes volver a contratarlo.'],
      actions: [{ label: `[D]espedir «${name}»`, variant: 'danger', run: () => (hq?.fire(a.id), onClose()) }],
    });
  const askRestart = () =>
    modal.open({
      title: `¿Reiniciar a ${name}? Se corta lo que esté haciendo.`,
      actions: [{ label: `[R]einiciar «${name}»`, variant: 'danger', run: () => hq?.restart(a.id) }],
    });
  const model = useModel(a);
  // Built-in tools this agent may use (saving profiles); undefined = all.
  const tools = hq?.effectiveTools?.(a.role);
  const TABS: PanelTab[] = ['history', 'claude', 'shell'];
  // History: the timeline as text; Claude/Comandos: the last 300 lines of the terminal.
  const copyOutput = () =>
    copy(
      tab === 'history'
        ? a.timeline.map((e) => `${new Date(e.ts).toLocaleTimeString('es-ES', { hour12: false })} ${e.text}`).join('\n')
        : tmux.captureText(tmux.win(a.tmux, tab)).trimEnd(),
    );
  useShortcuts(
    'office/panel',
    [
      { keys: ['['], run: () => select(TABS[(TABS.indexOf(tab) + 2) % 3]!) },
      { keys: [']'], run: () => select(TABS[(TABS.indexOf(tab) + 1) % 3]!) },
      { keys: ['w'], run: () => tab !== 'history' && a.status !== 'dormant' && setInteract(true) },
      { keys: ['r'], run: askRestart },
      { keys: ['y'], run: copyOutput },
      { keys: ['delete'], run: askFire },
      { keys: ['esc'], run: onBack ?? onClose },
    ],
    { footer: 'office.panel' },
  );

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Box flexDirection="row" justifyContent="space-between" flexShrink={0} height={1}>
        <Box flexDirection="row" flexShrink={1}>
          {onBack && <BackButton onClick={onBack} />}
          <Text bold color={color} wrap="truncate">
            {name}{' '}
            <Text color={MUTED}>
              {g.sep} {a.role.title}
            </Text>
          </Text>
        </Box>
        {!onBack && <Button variant="tertiary" label={`${g.close} Cerrar`} onClick={onClose} />}
      </Box>
      <Text wrap="truncate">
        <Text color={st.color}>
          {st.glyph} {st.label}
          {a.status === 'dormant' ? ` ${g.sep} ${dormantNote(a)}` : ''}
        </Text>
        <Text color={MUTED}>
          {' '}
          {g.sep} {a.role.writes ? 'escribe' : 'solo lectura'}
          {` ${g.sep} ${model ? `modelo ${model}` : 'modelo por defecto'}`}
          {tools ? ` ${g.sep} herramientas: ${tools.join(', ')}` : ''}
          {a.role.area ? ` ${g.sep} Rutas: ${a.role.area.paths.slice(0, 2).join(', ') || 'ninguna'}${a.role.area.paths.length > 2 ? ` (+${a.role.area.paths.length - 2})` : ''}` : ''} {g.sep} id{' '}
          {a.sessionId.slice(0, 8)}
        </Text>
      </Text>
      {/* What left the compact card lives here: the last thing done and the subagents. */}
      <Text wrap="truncate">
        <Text color={DONE}>
          {g.tick} {a.lastDone ?? '—'}
        </Text>
        {a.children.length ? <Text color={MUTED}>{` ${g.sep} ${a.children.length} subagente${a.children.length === 1 ? '' : 's'}: ${a.children.map((c) => c.desc).join(', ')}`}</Text> : null}
      </Text>
      {a.notice ? (
        <Text color={WARN} wrap="truncate">
          {g.warning} {a.notice}
        </Text>
      ) : (
        <Text wrap="truncate">
          {a.task ? (
            `${g.bullet} ${a.task}`
          ) : (
            <Text color={MUTED}>
              {g.bullet} sin tarea
            </Text>
          )}
        </Text>
      )}
      <ContextLine a={a} />
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Toggle
          label="Vista del agente"
          value={tab}
          onChange={select}
          options={[
            { value: 'history', label: `Historial ${g.sep} ${a.timeline.length} eventos` },
            { value: 'claude', label: 'Claude' },
            { value: 'shell', label: 'Comandos' },
          ]}
        />
      </Box>
      <Box flexDirection="row" flexShrink={0} height={1}>
        {tab !== 'history' && a.status !== 'dormant' && (
          <Button
            variant={interact ? 'secondary' : 'primary'}
            label={interact ? `${g.write} Escribiendo ${g.sep} ${EXIT_LABEL} sale` : `${g.write} Escribir (sales con ${EXIT_LABEL})`}
            onClick={() => setInteract(!interact)}
          />
        )}
        <Button variant="secondary" label="Reiniciar" onClick={askRestart} />
        <Button variant="secondary" label={`${g.copy} Copiar`} onClick={copyOutput} />
        <Box flexGrow={1} />
        <Button variant="danger" label="Despedir" onClick={askFire} />
      </Box>
      <Divider width={inner} color={color} title={tab === 'history' ? `Historial ${g.sep} rueda ${g.sep} clic: ver completo` : tmux.attachCommand(tmux.win(a.tmux, tab))} />
      {tab === 'history' ? (
        <ScrollArea scroll={scroll} height={viewH} color={color}>
          {lines.slice(offset, offset + viewH).map((l) => (
            <Clickable key={l.key} onClick={() => showEvent(l.e)} height={1} aria-role="button" aria-label="Ver evento completo">
              <Text wrap="truncate">
                <Text color={MUTED}>{l.t.padEnd(9)}</Text>
                <Text color={l.color}>{l.icon} </Text>
                <Text color={l.color === TEXT ? undefined : l.color}>{l.l}</Text>
              </Text>
            </Clickable>
          ))}
        </ScrollArea>
      ) : (
        a.status === 'dormant' ? (
          <DormantPane width={inner} height={viewH} />
        ) : (
          <LivePane key={tab} target={tmux.win(a.tmux, tab)} width={inner} height={viewH} fit keyboard interact={interact} onExitInteract={() => setInteract(false)} color={BORDER} />
        )
      )}
    </Box>
  );
}

// ----------------------------------------------------------------- bottom

const NOTICE_TAG: Record<Alert['kind'], string> = { trust: 'Permiso', bypass: 'Permiso', question: 'Pregunta', hire: 'Contratar', blocked: 'Bloqueado', info: 'Info' };
const MAX_NOTICES = 3;
const EXPANDED_ROWS = 8;
/** Rows taken by <Notices>: border + visible alerts + the "+N más" / header line. */
const noticesH = (n: number, expanded: boolean) =>
  !n ? 0 : expanded && n > MAX_NOTICES ? 2 + 1 + Math.min(EXPANDED_ROWS, n) : 2 + Math.min(MAX_NOTICES, n) + (n > MAX_NOTICES ? 1 : 0);

function NoticeRow({ n, onOpenAgent }: { n: Alert; onOpenAgent: (id: string) => void }) {
  const { hq, roles, openReply } = useApp();
  if (!hq) return null;
  const done = n.kind === 'info' && /^\[done\]/.test(n.text);
  return (
    <Box flexDirection="row" flexShrink={0} height={1}>
      {/* Clicking the text opens the full message with its reply options. */}
      <Clickable onClick={() => openReply({ alert: n })} flexGrow={1} flexShrink={1} aria-role="button" aria-label={`${NOTICE_TAG[n.kind]}: ${n.from}`}>
        <Text wrap="truncate" color={n.kind === 'info' ? (done ? DONE : RECEIVED) : undefined}>
          <Text color={WARN} bold>
            {NOTICE_TAG[n.kind].padEnd(10)}
          </Text>
          {done ? `${g.tick} ` : ''}
          <Text bold>{n.from}</Text>
          {n.kind === 'hire' ? ` quiere contratar a ${n.role}: ` : ': '}
          {n.text.replace(/\s+/g, ' ')}
        </Text>
      </Clickable>
      {n.kind === 'hire' || n.kind === 'trust' || n.kind === 'bypass' ? (
        <>
          {/* Both open the decision preselected: it still needs an explicit confirmation. */}
          <Button variant="primary" label="Aceptar…" onClick={() => (picks.set(n.id, 'accept'), openReply({ alert: n }))} />
          <Button variant="danger" label="Rechazar…" onClick={() => (picks.set(n.id, 'reject'), openReply({ alert: n }))} />
        </>
      ) : n.kind === 'blocked' ? (
        <Button variant="primary" label="Abrir terminal" onClick={() => onOpenAgent(n.from)} />
      ) : (
        <>
          {/* "Ver" opens the reply popup; the notice stays until it is answered or closed. */}
          <Button variant="secondary" label="Ver" onClick={() => openReply({ alert: n })} />
          <Button variant="tertiary" label="Cerrar" onClick={() => hq.answerNotice(n.id, false, roles)} />
        </>
      )}
    </Box>
  );
}

function Notices({
  alerts,
  expanded,
  setExpanded,
  onOpenAgent,
  line,
}: {
  alerts: Alert[];
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  onOpenAgent: (id: string) => void;
  /** No room: a single summary line that opens the oldest alert. */
  line?: boolean;
}) {
  const { openReply } = useApp();
  const n = alerts.length;
  const listH = Math.min(EXPANDED_ROWS, n);
  const scroll = useScroll(n, listH);
  if (!n) return null;
  if (line)
    return (
      <Clickable onClick={() => openReply({ alert: alerts[0]! })} height={1} flexShrink={0} paddingX={1} aria-role="button" aria-label={`${n} avisos`}>
        <Text color={WARN} bold wrap="truncate">
          {g.warning} {n} aviso{n === 1 ? '' : 's'} {g.sep} ! o clic para ver el más antiguo
        </Text>
      </Clickable>
    );
  if (expanded && n > MAX_NOTICES)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={WARN} paddingX={1} flexShrink={0}>
        <Box flexDirection="row" height={1}>
          <Text color={WARN} bold>
            {g.warning} {n} avisos pendientes{' '}
          </Text>
          <Button variant="tertiary" label="Contraer" onClick={() => setExpanded(false)} />
        </Box>
        <ScrollArea scroll={scroll} height={listH} color={WARN}>
          {alerts.slice(scroll.offset, scroll.offset + listH).map((a) => (
            <NoticeRow key={a.id} n={a} onOpenAgent={onOpenAgent} />
          ))}
        </ScrollArea>
      </Box>
    );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={WARN} paddingX={1} flexShrink={0}>
      {alerts.slice(0, MAX_NOTICES).map((a) => (
        <NoticeRow key={a.id} n={a} onOpenAgent={onOpenAgent} />
      ))}
      {n > MAX_NOTICES && (
        <Clickable onClick={() => setExpanded(true)} height={1}>
          <Text color={WARN} bold>
            +{n - MAX_NOTICES} más {g.sep} clic para ver todos
          </Text>
        </Clickable>
      )}
    </Box>
  );
}

/** Rows taken by <Composer>: border + title/recipient row + text area (rows + 2). */
const composerH = (rows: number) => 2 + 1 + rows + 2;

/** Floor rows below which the floor stops being useful: list header + one agent row. */
const MIN_FLOOR = 1 + 4;

export type OfficeBudget = { headH: number; floorH: number; hireH: number; noticesH: number; noticesLine: boolean; noticesExpanded: boolean; composerRows: number; composerH: number };

/**
 * Splits the office height so that it always adds up exactly. The composer comes first
 * (never squeezed), then the floor's minimum, the hire picker, and the alerts, which
 * shrink from the expanded list to the 3 latest to a single "⚠ N avisos" line.
 */
export function officeBudget(height: number, alerts: number, expanded: boolean, hiring: boolean): OfficeBudget {
  const headH = 1;
  const composerRows = height >= 28 ? 3 : 1;
  const cH = composerH(composerRows);
  let rest = height - headH - cH;
  let nH = alerts ? 1 : 0;
  let noticesLine = alerts > 0;
  let noticesExpanded = false;
  rest -= nH;
  // The picker was asked for explicitly: it may leave the floor with just its header.
  const hireH = hiring && rest - HIRE_H >= 1 ? HIRE_H : 0;
  rest -= hireH;
  if (alerts) {
    for (const exp of expanded ? [true, false] : [false]) {
      const full = noticesH(alerts, exp);
      if (rest - (full - nH) >= MIN_FLOOR) {
        rest -= full - nH;
        nH = full;
        noticesLine = false;
        noticesExpanded = exp && alerts > MAX_NOTICES;
        break;
      }
    }
  }
  return { headH, floorH: Math.max(0, rest), hireH, noticesH: nH, noticesLine, noticesExpanded, composerRows, composerH: cH };
}

function Composer({ target, setTarget, width, rows }: { target: string; setTarget: (id: string) => void; width: number; rows: number }) {
  const { hq } = useApp();
  const { focused } = useFocusState();
  // One draft per recipient: switching the target shows that agent's unsent text.
  const draft = useDraft(`composer:${target}`);
  const text = draft.value;
  const setText = draft.set;
  // Highlight the recipient for a moment whenever it changes, so a switch never goes unnoticed.
  const [flash, setFlash] = useState(false);
  const first = React.useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [target]);
  const active = focused === 'composer';
  const copy = useCopy();
  // Alt+C copies the draft; Alt+D discards it whole (Ctrl+U only clears the current line).
  useShortcuts(
    'office/composer',
    [
      { keys: ['alt+c'], run: () => copy(text), modes: ['text'] },
      { keys: ['alt+d'], run: () => setText(''), modes: ['text'] },
    ],
    { active },
  );
  if (!hq) return null;
  const chosen = hq.agents.get(target);
  const send = (value = text) => {
    if (!value.trim() || !hq.agents.has(target)) return;
    hq.post(USER, target, value.trim(), 'task');
    setText('');
  };
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={active ? FOCUS : BORDER} paddingX={1} flexShrink={0}>
      {/* Title + recipient on one row: the current target first, then the rest (clipped); agent cards also set it. */}
      <Box flexDirection="row" height={1} overflow="hidden">
        {/* Nothing in this row shrinks: what does not fit is clipped at the right. */}
        <Box flexShrink={0}>
          <Text>
            <Text color={SENT} bold>
              {g.out}{' '}
            </Text>
            <Text bold color={TEXT}>
              Mensaje{' '}
            </Text>
            <Text color={flash ? 'black' : MUTED} backgroundColor={flash ? WARN : undefined} bold={flash}>
              {g.sep} Para:{' '}
            </Text>
          </Text>
        </Box>
        {chosen ? (
          <Box flexShrink={0}>
          <Text backgroundColor={toHex(chosen.role.color)} color="black" bold>
            {` ${chosen.id === hq.lead ? `${g.star} ` : ''}${chosen.role.name} `}
          </Text>
          </Box>
        ) : (
          <Text color={DANGER}>nadie</Text>
        )}
        <Box flexShrink={0}>
          <Text color={BORDER}> {g.vLine} </Text>
        </Box>
        {[...hq.agents.values()]
          .filter((a) => a.id !== target)
          .map((a) => (
            <Clickable key={a.id} onClick={() => setTarget(a.id)} marginRight={1} flexShrink={0} aria-role="button" aria-label={`Destinatario: ${a.role.name}`}>
              <Text color={toHex(a.role.color)}>{` ${a.role.name} `}</Text>
            </Clickable>
          ))}
      </Box>
      <Box flexDirection="row" alignItems="center">
        <TextArea
          id="composer"
          value={text}
          onChange={setText}
          onSubmit={send}
          width={Math.max(20, width - 4 - 14)}
          rows={rows}
          color={FOCUS}
          note={draft.recovered ? DRAFT_NOTE : undefined}
          placeholder="Escribe una tarea · Enter envía · Alt+Enter: nueva línea"
        />
        <Box marginLeft={1} flexDirection="column">
          <Button variant="primary" label="Enviar ↵" onClick={() => send()} />
          <Button variant="secondary" label={`${g.copy} Copiar`} onClick={() => copy(text)} />
        </Box>
      </Box>
    </Box>
  );
}

/** Rows taken by <HirePicker>: border + header + role rows. */
const HIRE_ROWS = 2;
const HIRE_H = 2 + 1 + HIRE_ROWS;

function HirePicker({ onClose, onMore, width, paused }: { onClose: () => void; /** Opens «Más…», optionally with a role preselected. */ onMore: (id?: string) => void; width: number; paused: boolean }) {
  const { hq, roles, setToast } = useApp();
  const [at, setAt] = useState(0);
  const [start, setStart] = useState(0);
  const free = hq ? freeRoles(roles, hq.agents.keys()) : [];
  const i = Math.min(at, Math.max(0, free.length - 1));
  const pick = free[i];
  // Chips that fit (border + padding take 4 columns); the rest go behind «Más… (+N)».
  const fit = barFit(free, Math.max(10, width - 4), HIRE_ROWS, barStart(i, start, barFit(free, Math.max(10, width - 4), HIRE_ROWS, start).count));
  useEffect(() => setStart(fit.start), [fit.start]);
  useShortcuts(
    'office/hire',
    [
      { keys: ['left', 'up'], run: () => setAt(Math.max(0, i - 1)) },
      { keys: ['right', 'down'], run: () => setAt(Math.min(free.length - 1, i + 1)) },
      // Hiring takes quota: a chip only opens the popup with it chosen; ↵ there confirms.
      { keys: ['enter'], run: () => pick && onMore(pick.id) },
      { keys: ['tab'], run: () => free.length && onMore() },
      { keys: ['esc'], run: onClose },
    ],
    { footer: 'hire', active: !paused },
  );
  if (!hq) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={SUCCESS} paddingX={1} flexShrink={0}>
      <Box flexDirection="row" justifyContent="space-between" height={1}>
        <Text bold color={SUCCESS} wrap="truncate">
          Contratar: elige un rol para añadirlo a la sesión
        </Text>
        <Button variant="tertiary" label={`${g.close} Cerrar`} onClick={onClose} />
      </Box>
      <Box flexDirection="row" flexWrap="wrap" height={HIRE_ROWS} overflow="hidden">
        {free.length === 0 && <Text color={MUTED}>Ya están todos los roles de la biblioteca en la sesión.</Text>}
        {free.slice(fit.start, fit.start + fit.count).map((r) => (
          <Clickable key={r.id} onClick={() => onMore(r.id)} marginRight={1} aria-role="button" aria-label={`Elegir ${r.name} para contratar`}>
            <Text color={toHex(r.color)} inverse={r === pick}>
              {r === pick ? `${g.focus}${r.name}◂` : `[${r.name}]`}
            </Text>
          </Clickable>
        ))}
        {fit.more > 0 && <Button variant="secondary" label={moreLabel(fit.more)} onClick={() => onMore()} />}
      </Box>
    </Box>
  );
}

/**
 * «Más…» of Contratar: every free role (filter by typing), grouped by pack, with
 * writer/reader and a one-line description. Clic, ↑↓ and Space only select; ↵ or
 * «Contratar» hire, and the popup stays open for the next one. Esc closes.
 */
export function HireModal({
  width,
  height,
  onClose,
  initial,
  library,
}: {
  width: number;
  height: number;
  onClose: () => void;
  /** Role preselected (a chip of the bar). */
  initial?: string;
  /** Test seam: the role library (default: the app's). */
  library?: Role[];
}) {
  const app = useApp();
  const { hq, setToast } = app;
  const roles = library ?? app.roles;
  const [query, setQuery] = useState('');
  const [cur, setCur] = useState(-1); // -1: the preselected role, or the first one
  const [picked, setPicked] = useState<string | undefined>(initial);
  const lastPick = React.useRef(0);
  const [top, setTop] = useState(0);
  const free = hq ? freeRoles(roles, hq.agents.keys()) : [];
  const shown = filterRoles(free, query);
  const { rows, order } = groupedRows(shown);
  const c = cur < 0 ? Math.max(0, order.findIndex((r) => r.id === picked)) : Math.min(cur, Math.max(0, order.length - 1));
  const role = order.find((r) => r.id === picked);
  const listH = Math.max(3, Math.min(rows.length || 1, height - 12));
  const rowOfCur = rows.findIndex((r) => r.kind === 'role' && r.index === c);
  const first = Math.max(0, Math.min(rows.length - listH, rowOfCur < top ? rowOfCur : rowOfCur >= top + listH ? rowOfCur - listH + 1 : top));
  const move = (n: number) => setCur(Math.max(0, Math.min(order.length - 1, n)));
  // Only a keyboard pick arms the ↵ guard (a click then a click on «Contratar» is deliberate).
  const choose = (id: string, byKey = false) => {
    if (byKey) lastPick.current = Date.now();
    setPicked(id);
  };
  // ↵: picks the row under the cursor; with a role picked, hires it (not right after picking).
  const confirm = () => {
    if (!role) return order[c] && choose(order[c]!.id, true);
    if (Date.now() - lastPick.current < MODAL_GUARD_MS) return;
    hire();
  };
  const hire = () => {
    if (!hq || !role) return;
    hq.hire(role);
    setToast(`${role.name} contratado`);
    setPicked(undefined);
  };
  const onKeys = (names: string[]) => {
    const has = (n: string) => names.includes(n);
    const ch = names.find((n) => n.length === 1);
    // With a filter typed, Space is text too.
    if (query && has('space')) return setQuery(query + ' '), setCur(0), true;
    if (!query && has('space')) return order[c] ? (choose(order[c]!.id, true), true) : true;
    if (has('pageup')) return move(c - listH), true;
    if (has('pagedown')) return move(c + listH), true;
    if (has('home')) return move(0), true;
    if (has('end')) return move(order.length - 1), true;
    if (has('backspace')) return setQuery(query.slice(0, -1)), setCur(0), true;
    if (has('ctrl+u')) return setQuery(''), setCur(0), true;
    // Typing filters (letters, digits, punctuation; j/k too, or «k8s» could not be typed): arrows move.
    if (ch) return setQuery(query + ch), setCur(0), true;
    return false;
  };
  // A chunk of several characters (fast typing, a paste the terminal did not bracket) has no
  // key name, so the modal never sees it: it goes to the filter whole (line breaks → spaces).
  useInput((input, key) => {
    if (input.length < 2 || key.ctrl || key.meta || input.startsWith('\x1b')) return;
    const text = filterChunk(input);
    if (text) setQuery((q) => q + text), setCur(0);
  });
  // A bracketed paste goes to the filter as well (instead of «Pegado ignorado»).
  usePasteSink((t) => {
    const text = filterChunk(t);
    if (text) setQuery((q) => q + text), setCur(0);
  });
  const contentW = modalContentWidth(width, 76);
  const nameW = Math.min(22, Math.floor(contentW / 3));
  return (
    <Modal
      title={`Contratar ${g.sep} ${free.length} roles libres`}
      width={width}
      height={height}
      maxWidth={76}
      contentRows={listH + 2}
      onClose={onClose}
      onKeys={onKeys}
      onUpDown={(d) => move(c + d)}
      initialFocus={0}
      color={SUCCESS}
      footer="hire.more"
      actions={[
        role
          ? { label: `${g.add} Contratar ${role.name} (↵)`, run: confirm, variant: 'primary' }
          : order[c]
            ? { label: `Elegir ${order[c]!.name} (↵)`, run: confirm, variant: 'secondary' }
            : { label: 'Elige un rol', run: () => {}, variant: 'primary', disabled: true },
        { label: 'Cerrar (Esc)', run: onClose, variant: 'secondary' },
      ]}
    >
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={MUTED}>Filtro: </Text>
          {query ? <Text bold>{query}</Text> : null}
          <Text color={PRIMARY}>{g.block}</Text>
          <Text color={MUTED}> escribe para filtrar {g.sep} ⌫ borra {g.sep} ↵ elige</Text>
        </Text>
        <Divider width={contentW} />
        <Clickable onWheel={(d) => move(c + Math.sign(d))} flexDirection="column" height={listH} overflow="hidden">
          {rows.length === 0 && <Text color={MUTED}>{free.length ? 'Ningún rol coincide' : 'Ya están todos los roles de la biblioteca en la sesión.'}</Text>}
          {rows.slice(first, first + listH).map((r, k) =>
            r.kind === 'group' ? (
              <Text key={`g${k}`} color={INFO} bold wrap="truncate">
                {r.label}
              </Text>
            ) : (
              <Clickable
                key={r.role.id}
                onClick={() => (setCur(r.index), choose(r.role.id))}
                flexDirection="row"
                height={1}
                aria-role="radio"
                aria-label={`${r.role.name}, ${r.role.writes ? 'escribe' : 'solo lectura'}${picked === r.role.id ? ', seleccionado' : ''}`}
                aria-state={{ checked: picked === r.role.id, selected: r.index === c }}
              >
                <Text wrap="truncate" backgroundColor={picked === r.role.id ? SELECTED_BG : undefined} bold={r.index === c}>
                  {r.index === c ? g.focus : ' '} {picked === r.role.id ? g.radioOn : g.radioOff}{' '}
                  <Text color={toHex(r.role.color)}>{r.role.name.slice(0, nameW).padEnd(nameW)}</Text>{' '}
                  {r.role.writes ? <Text color={WARN}>{g.edit}</Text> : <Text color={MUTED}>{g.readOnly}</Text>}{' '}
                  <Text color={MUTED}>{r.role.description.replace(/\s+/g, ' ')}</Text>
                </Text>
              </Clickable>
            ),
          )}
        </Clickable>
      </Box>
    </Modal>
  );
}

// ----------------------------------------------------------------- office

export function Office({ height }: { height: number }) {
  const { hq, setTab, setToast, openAgent, clearOpenAgent } = useApp();
  const { cols } = useSize();
  const { focused, setFocused } = useFocusState();
  const cursor = useKeyboardCursor();
  const [nav, setNav] = useNav('office');
  const tick = useTick(true);
  const [selected, setSelected] = useState<string | null>(null);
  // Bumped on every external "open this agent" request so the panel remounts on the right tab.
  const [panelReq, setPanelReq] = useState<{ tab: PanelTab; n: number }>({ tab: 'history', n: 0 });
  const [target, setTarget] = useState<string>(hq?.lead ?? '');
  const [hiring, setHiring] = useState(false);
  // «Más…» of Contratar: closed, open, or open with a role preselected (its id).
  const [hireMore, setHireMore] = useState<false | true | string>(false);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [mode, setMode] = useState<'cards' | 'list'>(() => (cols >= WIDE_COLS ? 'cards' : 'list'));
  const [listOff, setListOff] = useState(0);
  const sel = selected && hq ? hq.agents.get(selected) : undefined;
  const wide = cols >= WIDE_COLS;
  const openPanel = (id: string, tab: PanelTab) => {
    setSelected(id);
    setPanelReq((p) => ({ tab, n: p.n + 1 }));
  };
  useEffect(() => {
    if (!openAgent) return;
    openPanel(openAgent.id, openAgent.tab);
    clearOpenAgent();
  }, [openAgent]);

  const agents = hq ? [...hq.agents.values()].sort((a, b) => (a.id === hq.lead ? -1 : b.id === hq.lead ? 1 : 0)) : [];
  const alerts = alertsOf(hq);

  const panelW = sel ? Math.min(84, Math.max(56, Math.floor(cols * 0.45))) : 0;
  const floorW = cols - panelW - (sel ? 1 : 0);
  const budget = officeBudget(height, alerts.length, noticesOpen, hiring);
  const { composerRows, headH, floorH } = budget;
  // Cards need CARD_H rows; when the floor is shorter, fall back to the list.
  const view = floorH < CARD_H ? 'list' : mode;
  const target_ = hq?.agents.has(target) ? target : hq?.lead ?? agents[0]?.id ?? '';
  const listVisible = Math.max(1, Math.floor((floorH - 1) / LIST_ROW_H));
  const { perRow, visibleRows } = view === 'cards' ? cardLayout(CARD_W, CARD_H, floorW, floorH) : { perRow: 1, visibleRows: listVisible };
  const index = Math.min(nav.index, Math.max(0, agents.length - 1));
  const pick = (id: string) => {
    setSelected(id === selected ? null : id);
    if (id !== target_) setToast(`Destinatario: ${hq?.agents.get(id)?.role.name ?? id}`);
    setTarget(id);
  };
  // Moving with the panel open makes the panel follow the cursor; the recipient stays.
  const move = (key: string) => {
    const n = moveIndex(index, agents.length, perRow, key, visibleRows);
    setNav({ zone: 'grid', index: n });
    if (view === 'list') setListOff((o) => (n < o ? n : n >= o + listVisible ? n - listVisible + 1 : o));
    if (selected && agents[n]) setSelected(agents[n]!.id);
  };
  useShortcuts(
    'office/grid',
    [
      ...['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end'].map((k) => ({ keys: [k], run: () => move(k) })),
      { keys: ['enter'], run: () => agents[index] && (openPanel(agents[index]!.id, 'history'), setTarget(agents[index]!.id)) },
      { keys: ['i', 'tab'], run: () => setFocused('composer') },
      { keys: ['v'], run: () => setMode(view === 'cards' ? 'list' : 'cards') },
      { keys: ['c'], run: () => setHiring(true) },
    ],
    // Off while the hire bar is open, so a re-registration (a new alert) never takes its keys back.
    { active: !!hq && !(sel && !wide) && !hiring, footer: alerts.length ? 'office.grid.alerts' : 'office.grid', vars: { n: alerts.length } },
  );
  useShortcuts('office/composer', [], { active: focused === 'composer', footer: 'composer' });
  useShortcuts('office/empty', [{ keys: ['enter'], run: () => setTab('teams') }], { active: !hq, footer: 'office.empty' });

  if (!hq) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text bold>No hay ninguna sesión abierta.</Text>
        <Text color={MUTED}>Lanza un equipo o reanuda una sesión anterior.</Text>
        <Box marginTop={1} flexDirection="row">
          <Button variant="primary" label="Ver equipos" onClick={() => setTab('teams')} />
          <Button variant="secondary" label="Ver sesiones" onClick={() => setTab('sessions')} />
        </Box>
      </Box>
    );
  }
  // Narrow: the agent panel opens full screen instead of beside the floor.
  const panelKey = `${sel?.id}-${panelReq.n}`;
  if (sel && !wide)
    return <AgentPanel key={panelKey} a={sel} width={cols} height={height} initialTab={panelReq.tab} onClose={() => setSelected(null)} onBack={() => setSelected(null)} />;
  const working = agents.filter((a) => a.status === 'working').length;
  const head = officeHeader(floorW, {
    title: hq?.title,
    provisional: hq?.titleProvisional,
    stats: hq ? `${nAgents(agents.length)} ${g.sep} ${working} trabajando ${g.sep} ${permText(hq.permMode)} ${g.sep} Consumo: ${PROFILE_SHORT[hq.profile]}${providerStat(hq)}` : '',
  });
  const showCursor = cursor.visible && !focused;

  // list layout: name | task | sent | received | character
  const spriteW = 18;
  const nameW = 22;
  const rest = Math.max(30, floorW - nameW - spriteW - 3);
  const widths = [nameW, Math.floor(rest * 0.36), Math.floor(rest * 0.32), Math.floor(rest * 0.32), spriteW];
  const listMax = Math.max(0, agents.length - listVisible);
  const lo = Math.min(listOff, listMax);

  return (
    <Box flexDirection="row" height={height}>
      <Box flexDirection="column" width={floorW}>
        <Box flexDirection="row" flexShrink={0} alignItems="center" height={headH} overflow="hidden" width={floorW}>
          <Box flexDirection="row" width={head.leftW} flexShrink={0} overflow="hidden" alignItems="center">
          <Toggle
            label="Vista"
            value={view}
            onChange={setMode}
            hint="v"
            options={[
              { value: 'cards', label: 'Tarjetas' },
              { value: 'list', label: 'Lista' },
            ]}
          />
          <SessionTitle max={head.titleMax} short={head.renameShort} />
          <Box width={head.statsW} flexShrink={0} overflow="hidden">
            <Text color={MUTED} wrap="truncate">
              {' '}
              {nAgents(agents.length)} {g.sep} {working} trabajando {g.sep} <Text color={PERM_COLOR[hq.permMode]}>{permText(hq.permMode)}</Text> {g.sep} Consumo:{' '}
              {PROFILE_SHORT[hq.profile]}
              {providerStat(hq)}
            </Text>
          </Box>
          {head.legend && (
            <Text>
              <Text color={MUTED}> {g.sep} </Text>
              <Text color={SENT}>{g.out} enviado </Text>
              <Text color={RECEIVED}>{g.in} recibido </Text>
              <Text color={DONE}>{g.tick} hecho </Text>
            </Text>
          )}
          </Box>
          <Text> </Text>
          <Button variant="secondary" label={`${g.add} Contratar`} onClick={() => setHiring(!hiring)} />
        </Box>
        {view === 'cards' ? (
          <CardGrid
            items={agents}
            cardW={CARD_W}
            cardH={CARD_H}
            width={floorW}
            height={floorH}
            cursor={showCursor ? index : undefined}
            onCursor={(i) => setNav({ zone: 'grid', index: i })}
            render={(a, w, st) => (
              <AgentCard
                key={a.id}
                width={w}
                a={a}
                lead={a.id === hq.lead}
                selected={a.id === selected}
                cursor={st.cursor}
                tick={tick}
                onClick={() => (setNav({ zone: 'grid', index: st.index }), cursor.hide(), pick(a.id))}
              />
            )}
          />
        ) : (
          <Box flexDirection="row" height={floorH} flexShrink={0}>
            <Clickable onWheel={(d) => setListOff(Math.max(0, Math.min(listMax, lo + Math.sign(d))))} flexDirection="column" flexGrow={1} height={floorH} overflow="hidden">
              <ListHeader widths={widths} />
              {agents.slice(lo, lo + listVisible).map((a, i) => (
                <AgentRow
                  key={a.id}
                  a={a}
                  lead={a.id === hq.lead}
                  selected={a.id === selected}
                  cursor={showCursor && lo + i === index}
                  tick={tick}
                  widths={widths}
                  onClick={() => (setNav({ zone: 'grid', index: lo + i }), cursor.hide(), pick(a.id))}
                />
              ))}
            </Clickable>
            <Scrollbar total={agents.length} visible={listVisible} offset={lo} onScroll={(n) => setListOff(Math.round(n))} height={floorH} />
          </Box>
        )}
        {budget.hireH > 0 && <HirePicker width={floorW} paused={hireMore !== false} onMore={(id) => setHireMore(id ?? true)} onClose={() => setHiring(false)} />}
        <Notices alerts={alerts} expanded={budget.noticesExpanded} line={budget.noticesLine} setExpanded={setNoticesOpen} onOpenAgent={(id) => openPanel(id, 'claude')} />
        <Composer target={target_} setTarget={setTarget} width={floorW} rows={composerRows} />
      </Box>
      {sel && (
        <>
          <VSep height={height} />
          <AgentPanel key={panelKey} a={sel} width={panelW} height={height} initialTab={panelReq.tab} onClose={() => setSelected(null)} />
        </>
      )}
      {hireMore && (
        <MouseLayer>
          <HireModal width={cols} height={height} initial={typeof hireMore === 'string' ? hireMore : undefined} onClose={() => setHireMore(false)} />
        </MouseLayer>
      )}
    </Box>
  );
}

/**
 * Panel line: context size and what the profile does with it, plus [⇣ Compactar] and
 * [↺ Empezar limpio] (asks first). Both wait for an idle agent.
 */
function ContextLine({ a }: { a: Agent }) {
  const { hq, setToast, setError } = useApp();
  const modal = useModal();
  if (!hq) return null;
  const limit = ctxLimit(hq.profile);
  const c = ctxLabel(a.ctxTokens, limit);
  const size = a.ctxTokens ? `${kTok(a.ctxTokens)} tokens (${Math.round((a.ctxTokens / AUTO_COMPACT_AT) * 100)} %)` : 'sin datos';
  const auto = `compacta solo a ${kTok(AUTO_COMPACT_AT)}`;
  const what = `${g.sep} ${COMPACT_AT[hq.profile] ? `${auto} (y a ${kTok(COMPACT_AT[hq.profile]!)} entre tareas)` : auto}`;
  const busy = a.status !== 'idle';
  const wait = a.status === 'dormant' ? ' (en espera)' : busy ? ' (espera a que termine)' : '';
  const name = a.role.name;
  const compact = () => (hq.compact(a.id) ? setToast(`Compactando ${name}…`) : setError(`${name} no está libre: espera a que termine`));
  const askClear = () =>
    modal.open({
      title: `¿Empezar limpio con ${name}?`,
      lines: ['Perderá su conversación; conserva su tarea y sus mensajes pendientes.'],
      actions: [{ label: `[E]mpezar limpio`, variant: 'danger', run: () => (hq.clear(a.id) ? setToast(`${name} empieza limpio`) : setError(`${name} no está libre: espera a que termine`)) }],
    });
  return (
    <>
    <Box flexDirection="row" flexShrink={0} height={1}>
      <Text wrap="truncate" aria-label={c.aria || 'Contexto sin datos'}>
        <Text color={MUTED}>Contexto: </Text>
        <Text color={CTX_COLOR[c.level]}>
          {c.level === 'over' ? `${g.warning} ` : ''}
          {size}
        </Text>
        <Text color={MUTED}> {what}</Text>
      </Text>
      <Box flexGrow={1} />
      <Text> </Text>
      {/* /compact had no effect once: hq stops compacting automatically, the button can still retry. */}
      <Button variant="secondary" label={`${g.import} ${a.compactFailed ? 'Reintentar compactar' : 'Compactar'}${wait}`} disabled={busy} onClick={compact} />
      <Button variant="danger" label={`${g.sessions} Empezar limpio${wait}`} disabled={busy} onClick={askClear} />
    </Box>
    {a.compactFailed && (
      <Text color={WARN} wrap="truncate">
        {g.warning} la última compactación no surtió efecto
      </Text>
    )}
    </>
  );
}

/** Fewer visible characters than this and the session title is left out of the header. */
const TITLE_MIN = 6;
const LEGEND = ` ${g.sep} ${g.out} enviado ${g.in} recibido ${g.tick} hecho `;
const STATS_MIN = 18;

/**
 * Widths of the office header (view toggle · title + rename · stats · legend · Contratar)
 * for a floor `width` columns wide: the legend goes first, then the rename label shrinks
 * to «✎», then the title is middle-truncated; the stats get the rest and never overlap.
 */
export function officeHeader(width: number, o: { title?: string; provisional?: boolean; stats: string }) {
  // [ + Contratar ] (and the space before it) is always reserved: everything else gives way first.
  const hireW = buttonWidth(`${g.add} Contratar`, 'sm', false, 'secondary') + 1;
  const fixed = toggleWidth(['Tarjetas', 'Lista'], 'v') + hireW;
  let rest = Math.max(0, width - fixed);
  const statsLen = stringWidth(o.stats) + 1;
  const titleLen = (o.title ?? 'Sin título').length;
  const renameLong = buttonWidth(`${g.edit} Renombrar`, 'sm', false, 'tertiary');
  const renameShort = buttonWidth(g.edit, 'sm', false, 'tertiary');
  const suffix = (short: boolean) => (o.title && o.provisional ? (short ? ' (prov.)' : ' (provisional)').length : 0);
  const titleBlock = (max: number, short: boolean) => 1 + Math.min(titleLen, max) + suffix(short) + 1 + (short ? renameShort : renameLong);
  const legendW = stringWidth(LEGEND);
  const legend = rest - titleBlock(40, false) - statsLen >= legendW;
  if (legend) rest -= legendW;
  const short = rest - titleBlock(40, false) < Math.min(statsLen, STATS_MIN);
  const room = rest - titleBlock(0, short) - Math.min(statsLen, STATS_MIN);
  // The title never takes more than ~40 % of the row (the stats come first) and never
  // pushes the row past its width.
  const titleMax = Math.max(1, Math.min(40, room, Math.floor(rest * 0.4), rest - titleBlock(0, short)));
  const statsW = Math.max(0, rest - titleBlock(titleMax, short));
  return { titleMax, renameShort: short, statsW, legend, hireW, leftW: width - hireW, used: fixed + titleBlock(titleMax, short) + statsW + (legend ? legendW : 0) };
}

/** Middle-truncated: "Refactor del…por partes". */
const middle = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, Math.ceil((max - 1) / 2))}${g.ellipsis}${t.slice(t.length - Math.floor((max - 1) / 2))}`);

/** Session title in the office header plus [✎ Renombrar] (inline field: ↵ saves, Esc cancels). */
function SessionTitle({ max, short }: { max: number; short: boolean }) {
  const { hq, setToast, setError } = useApp();
  const { focused, setFocused } = useFocusState();
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    if (value !== null && focused !== 'office-title') setValue(null);
  }, [focused]);
  if (!hq) return null;
  const save = (v: string) => {
    const t = cleanTitle(v);
    if (!t) return setError('Escribe un título.');
    hq.setTitle(t);
    setFocused(null);
    setValue(null);
    setToast('Sesión renombrada');
  };
  if (value !== null)
    return (
      <Box flexShrink={0} marginLeft={1}>
        <TextField id="office-title" label="Título:" value={value} onChange={(v) => setValue(v.slice(0, TITLE_MAX))} onSubmit={save} placeholder="↵ guarda · Esc cancela" width={Math.min(TITLE_MAX + 2, max + 10)} />
      </Box>
    );
  const start = () => (setValue(hq.title && !hq.titleProvisional ? hq.title : ''), setFocused('office-title'));
  return (
    <Box flexShrink={0} flexDirection="row" marginLeft={1}>
      {/* Under ~6 visible characters a title only reads as «R……»: leave just (prov.) and ✎. */}
      {max < TITLE_MIN ? null : hq.title ? <Text bold>{middle(hq.title, max)}</Text> : <Text color={MUTED}>Sin título</Text>}
      {hq.title && hq.titleProvisional ? <Text color={MUTED}>{short ? `${max < TITLE_MIN ? '' : ' '}(prov.)` : ' (provisional)'}</Text> : null}
      <Text> </Text>
      <Button variant="tertiary" label={short ? g.edit : `${g.edit} Renombrar`} onClick={start} />
    </Box>
  );
}
