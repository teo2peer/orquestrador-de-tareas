import { cycleProvider, listProviders } from '../providers.ts';
import { Box, Text } from 'ink';
import React, { useState } from 'react';
import { deleteFile, importPack, makeId, saveRole } from '../library.ts';
import type { Role, Scope } from '../types.ts';
import { VSep, gridLayout, useApp, useDraft, useFormKeys, useFormState, useSize, useTick, wrap } from './app-context.tsx';
import { moveIndex, useKeyboardCursor, useNav, useShortcuts, useModal } from './keymap.tsx';
import { BigSprite, NewCard, ROLE_H, ROLE_H_COMPACT, ROLE_W, RoleCard, writesLabel } from './cards.tsx';
import { g } from './glyphs.ts';
import { Clickable } from './mouse.tsx';
import { ACCESSORIES, STATE_ORDER, toHex } from './sprites.ts';
import { DANGER, INFO, MUTED, SUCCESS, TEXT, WARN, PROFILES } from './theme.ts';
import { BackButton, Button, buttonWidth, CardGrid, Checkbox, ColorPicker, Divider, LaunchButtons, launchButtonsHeight, ScrollArea, TextField, Toggle, toggleWidth, gridLayout as cardLayout, useFocusState, useLaunchOptions, useScroll } from './widgets.tsx';

const NEW = '__new__';
type Panel = { kind: 'view' } | { kind: 'edit'; draft: Draft; isNew: boolean } | { kind: 'import' };

const ACCESSORY_ES: Record<string, string> = {
  none: 'ninguno',
  tophat: 'chistera',
  tie: 'corbata',
  bowtie: 'pajarita',
  glasses: 'gafas',
  cap: 'gorra',
  crown: 'corona',
  headset: 'cascos',
  helmet: 'casco',
  hood: 'capucha',
  beret: 'boina',
  visor: 'visera',
};

export function Roles({ height }: { height: number }) {
  const { roles, depts, selection, clearSelection, toggleSelection, launch, hq, perm, setPerm, reload, confirmLaunch } = useApp();
  const modal = useModal();
  const { cols, rows } = useSize();
  const { focused, setFocused } = useFocusState();
  const cursor = useKeyboardCursor();
  const [nav, setNav] = useNav('roles');
  const tick = useTick(true);
  const [sel, setSel] = useState<string | undefined>(roles[0]?.id);
  const [panel, setPanel] = useState<Panel>({ kind: 'view' });
  // Without room for a side panel, the panel (detail, form or import) opens full screen.
  const [open, setOpen] = useState(false);
  const [pack, setPack] = useState<string>('all');
  // Kept as a draft: the filter survives tab switches.
  const { value: query, set: setQuery } = useDraft('search:roles');
  const role = roles.find((r) => r.id === sel);

  const packs = [...new Set(roles.map((r) => r.pack).filter(Boolean))] as string[];
  const filters = [
    { value: 'all', label: `Todos ${roles.length}` },
    { value: 'base', label: `Propios ${roles.filter((r) => !r.pack).length}` },
    ...packs.map((p) => ({ value: p, label: `${p} ${roles.filter((r) => r.pack === p).length}` })),
  ];
  const shown = roles.filter(
    (r) =>
      (pack === 'all' || (pack === 'base' ? !r.pack : r.pack === pack)) &&
      (!query || `${r.name} ${r.title} ${r.description}`.toLowerCase().includes(query.toLowerCase())),
  );

  const { side, oneCol, compactCards } = gridLayout(cols, rows);
  const detail = !side && open && (panel.kind !== 'view' || !!role);
  const panelW = side ? Math.min(80, Math.max(56, Math.floor(cols * 0.42))) : cols;
  const gridW = side ? cols - panelW - 1 : cols;
  // The framed toggle is wider: without room for the counts the packs go without them.
  const packRoom = gridW - (side ? 22 : 18) - 8 - 1 - buttonWidth(`${g.import} Importar`, 'sm', false, 'secondary') - 1;
  const packOptions = toggleWidth(filters.map((f) => f.label)) <= packRoom ? filters : filters.map((f) => ({ ...f, label: f.label.replace(/ \d+$/, '') }));
  const selBarH = selection.size && !detail ? 1 : 0;
  const cardH = compactCards ? ROLE_H_COMPACT : ROLE_H;
  const items: (Role | typeof NEW)[] = [...shown, NEW];
  const openPanel = (p: Panel) => (setPanel(p), setOpen(true));
  const back = side ? undefined : () => (setPanel({ kind: 'view' }), setOpen(false));
  // Keyboard: the grid, or the panel (full-screen detail, or the side panel reached with Tab).
  const toolbarH = 1;
  const cardW = oneCol ? gridW - 2 : ROLE_W;
  const gridH = height - selBarH - toolbarH - (shown.length ? 0 : 1);
  const { perRow, visibleRows } = cardLayout(cardW, cardH, gridW, gridH);
  const zone = nav.zone || 'grid';
  const index = Math.min(nav.index, items.length - 1);
  const atCursor = items[index];
  const cur = atCursor !== NEW ? atCursor : undefined;
  const panelKeys = panel.kind === 'view' && (detail || (side && zone === 'panel'));
  const leavePanel = () => (back ? back() : setNav({ zone: 'grid', index }));
  const openRole = (r: Role) => {
    setSel(r.id);
    openPanel({ kind: 'view' });
    if (side) setNav({ zone: 'panel', index });
  };
  // With a side panel, moving the cursor is a single click: the panel follows it (forms stay put).
  const move = (key: string) => {
    const n = moveIndex(index, items.length, perRow, key, visibleRows);
    setNav({ zone: 'grid', index: n });
    const it = items[n];
    if (side && it && it !== NEW && panel.kind === 'view') setSel(it.id);
  };
  const packIds = filters.map((f) => f.value);
  useShortcuts(
    'roles/grid',
    [
      ...['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end'].map((k) => ({ keys: [k], run: () => move(k) })),
      { keys: ['enter'], run: () => (cur ? openRole(cur) : openPanel({ kind: 'edit', draft: blank(), isNew: true })) },
      { keys: ['space'], run: () => cur && toggleSelection(cur.id) },
      { keys: ['x'], run: clearSelection, when: selection.size > 0 },
      { keys: ['l'], run: () => (selection.size ? confirmLaunch([...selection]) : cur && confirmLaunch([cur.id], cur.id)) },
      { keys: ['n'], run: () => openPanel({ kind: 'edit', draft: blank(), isNew: true }) },
      { keys: ['e'], run: () => cur && (setSel(cur.id), openPanel({ kind: 'edit', draft: { ...cur }, isNew: false })) },
      { keys: ['d'], run: () => cur && openPanel({ kind: 'edit', draft: { ...cur, id: '', name: `${cur.name} (copia)`, title: `${cur.title} (copia)`, source: undefined, pack: undefined }, isNew: true }) },
      { keys: ['delete'], run: () => cur && askDelete(cur) },
      { keys: ['i'], run: () => openPanel({ kind: 'import' }) },
      { keys: ['['], run: () => setPack(packIds[(packIds.indexOf(pack) + packIds.length - 1) % packIds.length]!) },
      { keys: [']'], run: () => setPack(packIds[(packIds.indexOf(pack) + 1) % packIds.length]!) },
      { keys: ['/'], run: () => setFocused('role-search') },
      { keys: ['tab', 'shift+tab'], run: () => side && role && setNav({ zone: 'panel', index }) },
      { keys: ['esc'], run: () => setQuery(''), when: !!query },
    ],
    {
      active: !detail && !(side && zone === 'panel' && panel.kind === 'view') && panel.kind !== 'edit',
      footer: query && !shown.length ? 'search.empty' : selection.size ? 'roles.selection' : 'roles.grid',
      vars: { n: selection.size },
    },
  );
  useShortcuts('roles/search', [{ keys: ['enter'], run: () => (setFocused(null), setNav({ zone: 'grid', index: 0 }), cursor.reveal()), modes: ['text'] }], {
    active: focused === 'role-search',
    footer: 'search',
  });
  const panelH = height - selBarH;
  const askDelete = (r: Role) => {
    const n = depts.filter((d) => d.roles.includes(r.id)).length;
    modal.open({
      title: `¿Borrar el rol «${r.name}»? No se puede deshacer.`,
      lines: n ? [`Está en ${n} equipo${n > 1 ? 's' : ''}; ahí aparecerá como no encontrado.`] : undefined,
      actions: [{ label: `[B]orrar «${r.name}»`, variant: 'danger', run: () => (deleteFile(r.file), reload(), setSel(undefined), setOpen(false)) }],
    });
  };

  const sidePanel =
    panel.kind === 'import' ? (
      <ImportPanel width={panelW} height={panelH} onDone={() => (setPanel({ kind: 'view' }), setOpen(false))} />
    ) : panel.kind === 'edit' ? (
      <RoleForm
        key={panel.draft.id || 'new'}
        initial={panel.draft}
        isNew={panel.isNew}
        width={panelW}
        height={panelH}
        onDone={(id) => {
          setPanel({ kind: 'view' });
          if (id) setSel(id);
          else setOpen(false);
        }}
      />
    ) : role ? (
      <RoleDetail
        role={role}
        teams={depts.filter((d) => d.roles.includes(role.id)).map((d) => `${d.icon} ${d.name}`)}
        width={panelW}
        height={panelH}
        tick={tick}
        onBack={back}
        keys={panelKeys}
        onLeave={leavePanel}
        onEdit={() => setPanel({ kind: 'edit', draft: { ...role }, isNew: false })}
        onCopy={() =>
          setPanel({ kind: 'edit', draft: { ...role, id: '', name: `${role.name} (copia)`, title: `${role.title} (copia)`, source: undefined, pack: undefined }, isNew: true })
        }
        onDelete={() => askDelete(role)}
      />
    ) : (
      <Box width={panelW} height={panelH} alignItems="center" justifyContent="center">
        <Text color={MUTED}>Selecciona un rol</Text>
      </Box>
    );
  if (detail) return <Box height={height}>{sidePanel}</Box>;

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="row" height={height - selBarH}>
        <Box flexDirection="column" width={gridW}>
          <Box flexDirection="row" flexShrink={0} alignItems="center" height={toolbarH} overflow="hidden">
            <Box flexShrink={1} overflow="hidden">
              <Toggle label="Pack" value={pack} onChange={setPack} options={packOptions} />
            </Box>
            <Text> </Text>
            <TextField id="role-search" label="Buscar:" value={query} onChange={setQuery} placeholder="nombre o descripción" width={side ? 22 : 18} />
            <Box marginLeft={1} flexShrink={0}>
              <Button variant="secondary" label={`${g.import} Importar`} onClick={() => openPanel({ kind: 'import' })} />
            </Box>
          </Box>
          {shown.length === 0 && (
            <Text color={WARN}>
              Sin resultados {g.sep} borra el texto de «Buscar» o cambia de pack
            </Text>
          )}
          <CardGrid
            items={items}
            cardW={cardW}
            cardH={cardH}
            width={gridW}
            height={gridH}
            cursor={cursor.visible && zone === 'grid' ? index : undefined}
            onCursor={(i) => setNav({ zone: 'grid', index: i })}
            render={(r, w, st) =>
              r === NEW ? (
                <NewCard key={NEW} label="Nuevo rol" width={w} height={cardH} cursor={st.cursor} onClick={() => (setNav({ zone: 'grid', index: st.index }), cursor.hide(), openPanel({ kind: 'edit', draft: blank(), isNew: true }))} />
              ) : (
                <RoleCard
                  key={r.id}
                  width={w}
                  r={r}
                  compact={compactCards}
                  selected={r.id === sel}
                  picked={selection.has(r.id)}
                  cursor={st.cursor}
                  tick={tick}
                  onClick={() => (setNav({ zone: 'grid', index: st.index }), cursor.hide(), openRole(r))}
                />
              )
            }
          />
        </Box>
        {side && (
          <>
            <VSep height={height - selBarH} />
            {sidePanel}
          </>
        )}
      </Box>
      {selBarH > 0 && (
        <Box flexDirection="row" paddingX={1} height={1} flexShrink={0} alignItems="center">
          <Text color={SUCCESS} bold>
            Selección ({selection.size}){' '}
          </Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate">{[...selection].map((id) => roles.find((r) => r.id === id)?.name ?? id).join(', ')}</Text>
          </Box>
          <LaunchButtons mode={perm} onModeChange={setPerm} inline short count={selection.size} running={!!hq} onLaunch={(mode) => (launch([...selection], undefined, mode), clearSelection())} />
          <Button variant="tertiary" label="Limpiar" onClick={clearSelection} />
        </Box>
      )}
    </Box>
  );
}

// ------------------------------------------------------------ role detail

function RoleDetail({
  role,
  teams,
  width,
  height,
  tick,
  onBack,
  keys,
  onLeave,
  onEdit,
  onCopy,
  onDelete,
}: {
  role: Role;
  teams: string[];
  width: number;
  height: number;
  tick: number;
  onBack?: () => void;
  keys: boolean;
  onLeave: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { selection, toggleSelection, launch, hq, perm, setPerm, profile, setProfile, provider, setProvider, confirmLaunch } = useApp();
  const [showPrompt, setShowPrompt] = useState(false);
  useShortcuts(
    'roles/detail',
    [
      { keys: ['l'], run: () => confirmLaunch([role.id], role.id) },
      { keys: ['o'], run: () => !hq && setProfile(PROFILES[(PROFILES.indexOf(profile) + 1) % PROFILES.length]!) },
      { keys: ['v'], run: () => !hq && setProvider(cycleProvider(provider)) },
      { keys: ['space'], run: () => toggleSelection(role.id) },
      { keys: ['p'], run: () => setShowPrompt((v) => !v) },
      { keys: ['e'], run: onEdit },
      { keys: ['d'], run: onCopy },
      { keys: ['delete'], run: onDelete },
      { keys: ['esc', 'tab', 'shift+tab'], run: onLeave },
    ],
    { active: keys },
  );
  const [confirming, setConfirming] = useState(false);
  const [optsOpen, toggleOpts] = useLaunchOptions();
  const color = toHex(role.color);
  const inner = width - 2;
  // Cycles through the sprite states every 2 s; frozen on the first one with reduced motion (tick = 0).
  const state = STATE_ORDER[Math.floor(tick / 20) % STATE_ORDER.length]!;
  // Height budget (rows actually painted, no border): header (XL sprite 14 / sprite 7 /
  // text 3) · ficha (divider + 4, or 1 line) · prompt divider + prompt · launch · actions 1.
  const sprite = height >= 40 ? 'xl' : height >= 20 ? 'normal' : null;
  const topH = sprite === 'xl' ? 14 : sprite ? 7 : 3;
  const fullFicha = height >= 30;
  const fixedH = topH + (fullFicha ? 5 : 1) + 1 + launchButtonsHeight({ running: !!hq, confirming, profile: true, collapsed: !optsOpen }) + 1;
  const fullPromptH = Math.max(1, height - fixedH);
  // Folded: a 4-line preview; the rest of the panel stays calm.
  const promptH = showPrompt ? fullPromptH : Math.min(4, fullPromptH);
  const spriteW = sprite === 'xl' ? 24 : sprite ? 12 : 0;
  const desc = wrap(role.description || '—', inner - spriteW - 3, topH - 2);
  const promptLines = wrap(role.prompt || '(sin prompt)', inner - 1);
  const scroll = useScroll(promptLines.length, promptH);
  const picked = selection.has(role.id);
  const perms = role.writes ? '(puede editar ficheros)' : '(no puede editar ficheros)';

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Box flexDirection="row" height={topH} flexShrink={0}>
        {sprite && <BigSprite role={role} tick={tick} state={state} xl={sprite === 'xl'} />}
        <Box flexDirection="column" marginLeft={sprite ? 2 : 0} flexGrow={1} flexShrink={1}>
          <Box flexDirection="row">
            {onBack && <BackButton onClick={onBack} />}
            <Text bold color={color} wrap="truncate">
              {role.name}
            </Text>
          </Box>
          <Text color={MUTED} wrap="truncate">
            {role.title} {g.sep} <Text color={TEXT}>id {role.id}</Text>
          </Text>
          {desc.map((l, i) => (
            <Text key={i} wrap="truncate">
              {l}
            </Text>
          ))}
        </Box>
      </Box>
      {!fullFicha ? (
        <Text wrap="truncate">
          {writesLabel(role)}
          <Text color={MUTED}> {g.sep} modelo </Text>
          {role.model ?? 'por defecto'}
          <Text color={MUTED}> {g.sep} equipos </Text>
          {teams.length ? teams.join(` ${g.sep} `) : 'ninguno'}
        </Text>
      ) : (
        <>
          <Divider title="Ficha" width={inner} color={color} />
          <Text wrap="truncate">
            <Text color={MUTED}>Equipos   </Text>
            {teams.length ? (
              teams.join(` ${g.sep} `)
            ) : (
              <Text color={MUTED}>
                ninguno {g.sep} puedes lanzarlo solo
              </Text>
            )}
          </Text>
          <Text>
            <Text color={MUTED}>Permisos  </Text>
            {writesLabel(role)}
            <Text color={MUTED}> {perms}</Text>
          </Text>
          <Text>
            <Text color={MUTED}>Modelo    </Text>
            {role.model ?? 'por defecto'}
            <Text color={MUTED}> {g.sep} proveedor </Text>
            {role.provider ?? 'claude'}
          </Text>
          <Text wrap="truncate">
            <Text color={MUTED}>Origen    </Text>
            {role.pack ? `pack ${role.pack} ${g.sep} ${role.source}` : `biblioteca ${role.scope === 'global' ? 'global' : 'del proyecto'}`}
          </Text>
        </>
      )}
      <Clickable onClick={() => setShowPrompt(!showPrompt)} height={1} aria-role="button" aria-label={showPrompt ? 'Plegar prompt' : 'Ver prompt completo'} aria-state={{ expanded: showPrompt }}>
        <Divider title={`Prompt (${promptLines.length} líneas) ${g.sep} ${showPrompt ? '▾ clic para plegar' : '▸ clic para ver todo'}`} width={inner} color={color} />
      </Clickable>
      <ScrollArea scroll={scroll} height={promptH} color={color}>
        {promptLines.slice(scroll.offset, scroll.offset + promptH).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l || ' '}
          </Text>
        ))}
      </ScrollArea>
      {!showPrompt && <Box flexGrow={1} />}
      <LaunchButtons mode={perm} onModeChange={setPerm} profile={profile} onProfileChange={setProfile} provider={provider} onProviderChange={setProvider} onConfirmingChange={setConfirming} collapsed={!optsOpen} onToggleOptions={toggleOpts} short count={1} running={!!hq} onLaunch={(mode) => launch([role.id], role.id, mode)} />
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Button variant="secondary" label={picked ? '− Quitar de la selección' : `${g.add} Añadir a la selección`} onClick={() => toggleSelection(role.id)} />
        <Button variant="secondary" label={`${g.edit} Editar`} onClick={onEdit} />
        <Button variant="secondary" label={`${g.copy} Duplicar`} onClick={onCopy} />
        <Box flexGrow={1} />
        <Button variant="danger" label={`${g.close} Borrar`} onClick={onDelete} />
      </Box>
    </Box>
  );
}

// -------------------------------------------------------------- role form

const MODELS = ['', 'opus', 'sonnet', 'haiku'];
const HAIR = ['#2b1b0e', '#5a3825', '#a0522d', '#d6b370', '#1f1f1f', '#8b8d98', '#b33a3a', '#3e63dd'];
const SKIN = ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a1e'];

type Draft = Omit<Role, 'file' | 'scope'> & { scope: Scope; file?: string };

function blank(): Draft {
  return { id: '', name: '', title: '', accessory: 'none', color: 'cyan', writes: false, description: '', prompt: 'Describe the single responsibility of this role.', scope: 'global' };
}

function Swatches({ colors, value, onChange, label }: { colors: string[]; value?: string; onChange: (c: string) => void; label: string }) {
  return (
    <Box flexDirection="row" aria-role="radiogroup" aria-label={label}>
      {colors.map((h) => (
        <Clickable key={h} onClick={() => onChange(h)} aria-role="radio" aria-label={`${label} ${h}`} aria-state={{ checked: value === h }}>
          <Text color={h}>{value === h ? `[${g.block}${g.block}]` : ` ${g.block}${g.block} `}</Text>
        </Clickable>
      ))}
    </Box>
  );
}

function RoleForm({ initial, isNew, width, height, onDone }: { initial: Draft; isNew: boolean; width: number; height: number; onDone: (id?: string) => void }) {
  const { reload, setToast, openEditor } = useApp();
  const tick = useTick(true);
  const [d, setD] = useState<Draft>(initial);
  const [nameErr, setNameErr] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const color = toHex(d.color);
  const inner = width - 2;
  const state = STATE_ORDER[Math.floor(tick / 20) % STATE_ORDER.length]!;

  const persist = (draft: Draft) => {
    const id = isNew ? makeId(draft.name || draft.title) : draft.id;
    if (!isNew && initial.file && initial.scope !== draft.scope) deleteFile(initial.file);
    const file = saveRole({ ...draft, id, name: draft.name || draft.title, title: draft.title || draft.name });
    reload();
    return { id, file };
  };
  const named = () => {
    if (d.name.trim() || d.title.trim()) return true;
    setNameErr('Escribe un nombre para el rol.');
    return false;
  };
  const save = () => {
    if (!named()) return false;
    const { id } = persist(d);
    setToast(`Rol «${d.name || d.title}» guardado`);
    onDone(id);
  };
  const editPrompt = () => {
    if (!named()) return;
    // Editing a pack role's prompt turns it into an own copy that no longer follows the source.
    const { id, file } = persist(d.source ? { ...d, source: undefined } : d);
    openEditor(file);
    onDone(id);
  };
  useFormState(JSON.stringify(d) !== JSON.stringify(initial), save, d.name.trim() || d.title.trim() || 'Nuevo rol');
  // Claude's aliases only make sense on Claude itself: other providers take a free model id.
  const ownModel = !!d.provider && d.provider !== 'claude';
  useFormKeys(ownModel ? ['rf-name', 'rf-title', 'rf-desc', 'rf-model'] : ['rf-name', 'rf-title', 'rf-desc'], save, () => onDone());
  const preview = { ...d, id: d.id || 'new', file: '', scope: d.scope } as Role;

  // Short panels drop the section dividers and the prompt preview so the buttons stay visible.
  const compact = height < 24;
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Box flexDirection="row" flexShrink={0}>
        <BigSprite role={preview} tick={tick} state={state} />
        <Box flexDirection="column" marginLeft={2} flexGrow={1}>
          <Text bold color={color}>
            {isNew ? 'Nuevo rol' : `Editar ${d.id}`}
          </Text>
          <TextField id="rf-name" label="Nombre     " value={d.name} onChange={(v) => (set('name', v), setNameErr(''))} width={inner - 27} />
          {nameErr ? (
            <Text color={DANGER}>
              {g.warning} {nameErr}
            </Text>
          ) : null}
          <TextField id="rf-title" label="Título     " value={d.title} onChange={(v) => set('title', v)} width={inner - 27} />
          <TextField id="rf-desc" label="Descripción" value={d.description} onChange={(v) => set('description', v)} width={inner - 27} />
          <Box marginTop={compact || nameErr ? 0 : 1}>
            <Checkbox checked={d.writes} onToggle={() => set('writes', !d.writes)} label=" Puede editar ficheros" color={WARN} />
          </Box>
        </Box>
      </Box>
      {!compact && <Divider title="Aspecto" width={inner} color={color} />}
      <Box flexDirection="row" flexShrink={0}>
        <Text color={MUTED}>Camisa    </Text>
        <ColorPicker value={d.color} onChange={(c) => set('color', c)} />
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        <Text color={MUTED}>Pelo      </Text>
        <Swatches label="Pelo" colors={HAIR} value={d.hair} onChange={(h) => set('hair', h)} />
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        <Text color={MUTED}>Piel      </Text>
        <Swatches label="Piel" colors={SKIN} value={d.skin} onChange={(h) => set('skin', h)} />
      </Box>
      <Box flexDirection="row" flexWrap="wrap" flexShrink={0}>
        <Text color={MUTED}>Accesorio </Text>
        {ACCESSORIES.map((a) => (
          <Button key={a} label={ACCESSORY_ES[a] ?? a} color="magenta" active={d.accessory === a} onClick={() => set('accessory', a)} />
        ))}
      </Box>
      {!compact && <Divider title="Comportamiento" width={inner} color={color} />}
      <Box flexDirection="row" flexShrink={0}>
        <Box flexShrink={0}>
          <Text color={MUTED}>Proveedor </Text>
        </Box>
        <Button
          variant="secondary"
          label={`${d.provider ?? 'claude'} ${g.sep} cambiar`}
          onClick={() => {
            const ids = listProviders().map((x) => x.id);
            const next = ids[(ids.indexOf(d.provider ?? 'claude') + 1) % ids.length]!;
            set('provider', next === 'claude' ? undefined : next);
          }}
        />
        <Text color={MUTED}> {listProviders().find((x) => x.id === (d.provider ?? 'claude'))?.name}</Text>
      </Box>
      {ownModel ? (
        <TextField id="rf-model" label="Modelo    " value={d.model ?? ''} onChange={(v) => set('model', v.trim() || undefined)} width={inner - 27} />
      ) : (
        <Box flexDirection="row" flexShrink={0}>
          <Text color={MUTED}>Modelo    </Text>
          <Toggle label="Modelo" value={d.model ?? ''} onChange={(m) => set('model', m || undefined)} options={MODELS.map((m) => ({ value: m, label: m || 'por defecto' }))} />
        </Box>
      )}
      <Box flexDirection="row" flexShrink={0}>
        <Text color={MUTED}>Guardar en </Text>
        <Toggle
          label="Guardar en"
          value={d.scope}
          onChange={(v) => set('scope', v)}
          options={[
            { value: 'global', label: 'Global' },
            { value: 'project', label: 'Solo este proyecto' },
          ]}
        />
      </Box>
      <Text color={MUTED} wrap="truncate">
        Prompt: {d.prompt.split('\n').length} líneas{d.source ? ` (sigue a ${d.source})` : ''}
      </Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {(compact ? [] : wrap(d.prompt, inner, Math.max(1, height - 23))).map((l, i) => (
          <Text key={i} color={MUTED} wrap="truncate">
            {l || ' '}
          </Text>
        ))}
      </Box>
      <Box flexDirection="row" flexShrink={0} height={1}>
        <Button variant="primary" label="Guardar" onClick={save} />
        <Button variant="secondary" label={`${g.edit} Editar prompt`} onClick={editPrompt} />
        <Button variant="secondary" label="Cancelar" onClick={() => onDone()} />
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------- import

function ImportPanel({ width, height, onDone }: { width: number; height: number; onDone: () => void }) {
  const { reload, setToast } = useApp();
  const [src, setSrc] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useShortcuts('roles/import', [{ keys: ['esc'], run: onDone }]);
  const run = async (value = src) => {
    if (!value.trim()) return setResult({ ok: false, text: 'Escribe la ruta de la carpeta que quieres importar.' });
    setBusy(true);
    try {
      const r = await importPack(value.trim(), name.trim() || undefined);
      reload();
      setResult({ ok: true, text: `Pack «${r.pack}»: ${r.imported.length} roles importados.\n${r.imported.join(', ')}` });
      setToast(`Importados ${r.imported.length} roles`);
    } catch (e: any) {
      setResult({ ok: false, text: `No se pudo importar: ${e?.message ?? e}. Revisa la ruta o el acceso SSH.` });
    }
    setBusy(false);
  };
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Text bold color={INFO}>
        {g.import} Importar roles
      </Text>
      <Text color={MUTED} wrap="truncate">
        Carpeta de agentes en markdown (Claude Code / OpenCode), local o por SSH:
      </Text>
      <Text color={MUTED}>
        {'  '}~/agents {g.sep} usuario@host:/ruta/agents
      </Text>
      <Box marginTop={1} flexDirection="column">
        <TextField id="imp-src" label="Origen" value={src} onChange={setSrc} width={Math.max(20, width - 12)} onSubmit={run} />
        <TextField id="imp-name" label="Pack  " value={name} onChange={setName} width={24} placeholder="(opcional)" />
      </Box>
      <Box flexDirection="row" marginTop={1} height={1}>
        <Button variant="primary" label={busy ? 'Importando…' : 'Importar'} disabled={busy} onClick={() => run()} />
        <Button variant="secondary" label="Cerrar" onClick={onDone} />
      </Box>
      {result &&
        wrap(result.text, width - 2).map((l, i) => (
          <Text key={i} color={result.ok ? SUCCESS : DANGER}>
            {i === 0 && !result.ok ? `${g.warning} ` : ''}
            {l}
          </Text>
        ))}
    </Box>
  );
}
