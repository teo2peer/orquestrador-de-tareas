import { cycleProvider } from '../providers.ts';
import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { deleteDepartment, makeId, saveDepartment } from '../library.ts';
import { PROJECT_DIR } from '../paths.ts';
import type { Department, Role, Scope } from '../types.ts';
import { COMPOSE_MODES, type ComposeMode } from './area-plan.ts';
import { AutoTeam } from './AutoTeam.tsx';
import { VSep, gridLayout, useApp, useDraft, useFormKeys, useFormState, useSize, useTick, wrap } from './app-context.tsx';
import { moveIndex, useKeyboardCursor, useNav, useShortcuts, useModal } from './keymap.tsx';
import { BigSprite, MiniSprite, NewCard, TEAM_H, TEAM_H_COMPACT, TEAM_W, TeamCard, writesLabel } from './cards.tsx';
import { g, safeText } from './glyphs.ts';
import { Clickable } from './mouse.tsx';
import { toHex } from './sprites.ts';
import { DANGER, INFO, MUTED, SUCCESS, TEXT, WARN, PROFILES } from './theme.ts';
import {
  BackButton,
  Button,
  CardGrid,
  ChromeTabs,
  ColorPicker,
  Divider,
  LaunchButtons,
  launchButtonsHeight,
  ScrollArea,
  TextArea,
  TextField,
  Toggle,
  gridLayout as cardLayout,
  useFocusState,
  useLaunchOptions,
  useScroll,
} from './widgets.tsx';

const NEW = '__new__';

export function Teams({ height: fullH }: { height: number }) {
  const { depts, roles, reload, confirmLaunch, composeMode, setComposeMode, profile, setProfile, provider, setProvider, hq } = useApp();
  // One row on top picks how the team is composed; the rest is the role grid or the area plan.
  const height = fullH - 1;
  const auto = composeMode !== 'dept';
  const modal = useModal();
  const { cols, rows } = useSize();
  const { focused, setFocused } = useFocusState();
  const cursor = useKeyboardCursor();
  const [nav, setNav] = useNav('teams');
  const tick = useTick(true);
  const [sel, setSel] = useState<string | undefined>(depts[0]?.id);
  // Without room for a side panel the detail opens full screen over the grid.
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ dept?: Department; copy?: boolean } | null>(null);
  const [category, setCategory] = useState('__all__');
  // Kept as a draft: the filter survives tab switches.
  const { value: query, set: setQuery } = useDraft('search:teams');
  const roleMap = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const dept = depts.find((d) => d.id === sel);
  const { side, oneCol, compactCards, compactTabs } = gridLayout(cols, rows);
  const detail = !side && open && !!dept && !editing;

  const panelW = side ? Math.min(80, Math.max(56, Math.floor(cols * 0.42))) : 0;
  const gridW = side ? cols - panelW - 1 : cols;
  // Many categories do not fit as tabs (labels shrink to 2 letters): one row that steps through them.
  const manyCats = new Set(depts.map((d) => d.category)).size > 4;
  const tabsH = compactTabs || manyCats ? 1 : 3;
  const cardH = compactCards ? TEAM_H_COMPACT : TEAM_H;
  const cardW = oneCol ? gridW - 2 : TEAM_W;
  const categories = [...new Set(depts.map((d) => d.category))];
  const cats = ['__all__', ...categories];
  const cat = category === '__all__' || categories.includes(category) ? category : '__all__';
  const stepCat = (d: number) => setCategory(cats[(cats.indexOf(cat) + d + cats.length) % cats.length]!);
  const q = query.trim().toLowerCase();
  const shown = depts.filter((d) => (cat === '__all__' || d.category === cat) && (!q || `${d.name} ${d.description} ${d.category}`.toLowerCase().includes(q)));
  const items: (Department | typeof NEW)[] = [...shown, NEW];
  const { perRow, visibleRows } = cardLayout(cardW, cardH, gridW, height - tabsH);
  const zone = nav.zone || 'grid';
  const index = Math.min(nav.index, items.length - 1);
  const atCursor = items[index];
  const panelZone = side && zone === 'panel';

  // Click only selects (and opens the detail when there is no side panel); launching always asks.
  const openTeam = (d: Department) => {
    setSel(d.id);
    setOpen(true);
    if (side) setNav({ zone: 'panel', index });
  };
  const askDelete = (d: Department) =>
    modal.open({
      title: `¿Borrar el equipo «${d.name}»? Sus roles no se borran.`,
      actions: [{ label: `[B]orrar «${d.name}»`, variant: 'danger', run: () => (deleteDepartment(d.file), reload(), setOpen(false), setSel(depts.find((x) => x.id !== d.id)?.id)) }],
    });
  const launchDept = (d: Department) => confirmLaunch(d.roles.filter((id) => roleMap.has(id)), d.lead);
  // With a side panel, moving the cursor is a single click: the panel follows it.
  const move = (key: string) => {
    const n = moveIndex(index, items.length, perRow, key, visibleRows);
    setNav({ zone: 'grid', index: n });
    const it = items[n];
    if (side && it && it !== NEW) setSel(it.id);
  };
  const team = atCursor !== NEW ? atCursor : undefined;

  useShortcuts(
    'teams/grid',
    [
      ...['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end'].map((k) => ({ keys: [k], run: () => move(k) })),
      { keys: ['enter'], run: () => (team ? openTeam(team) : setEditing({})) },
      { keys: ['l'], run: () => team && launchDept(team) },
      { keys: ['n'], run: () => setEditing({}) },
      { keys: ['e'], run: () => team && setEditing({ dept: team }) },
      { keys: ['d'], run: () => team && setEditing({ dept: team, copy: true }) },
      { keys: ['delete'], run: () => team && askDelete(team) },
      { keys: ['['], run: () => setCategory(cats[(cats.indexOf(cat) + cats.length - 1) % cats.length]!) },
      { keys: [']'], run: () => setCategory(cats[(cats.indexOf(cat) + 1) % cats.length]!) },
      { keys: ['/'], run: () => setFocused('team-search') },
      { keys: ['tab', 'shift+tab'], run: () => side && dept && setNav({ zone: 'panel', index }) },
      { keys: ['esc'], run: () => query && setQuery(''), when: !!query },
    ],
    { active: !auto && !editing && !detail && !panelZone, footer: q && !shown.length ? 'search.empty' : 'teams.grid' },
  );
  useShortcuts('teams/search', [{ keys: ['enter'], run: () => (setFocused(null), setNav({ zone: 'grid', index: 0 }), cursor.reveal()), modes: ['text'] }], {
    active: focused === 'team-search',
    footer: 'search',
  });

  const nextMode = () => setComposeMode(COMPOSE_MODES[(COMPOSE_MODES.indexOf(composeMode) + 1) % COMPOSE_MODES.length]!);
  useShortcuts('teams/mode', [{ keys: ['p'], run: nextMode }], { active: auto || (!editing && !detail) });
  // Cost profile of the next launch (o; k is vi navigation): only meaningful without a session.
  useShortcuts('teams/provider', [{ keys: ['v'], run: () => setProvider(cycleProvider(provider)) }], { active: !editing && !hq });
  useShortcuts('teams/profile', [{ keys: ['o'], run: () => setProfile(PROFILES[(PROFILES.indexOf(profile) + 1) % PROFILES.length]!) }], { active: !editing && !hq });

  // With an Auto mode there is no department grid: the panel takes the whole width.
  if (auto)
    return (
      <Box flexDirection="column" height={fullH}>
        <ModeBar value={composeMode} onChange={setComposeMode} />
        <AutoTeam key={composeMode} kind={composeMode === 'auto-area' ? 'area' : 'role'} width={cols} height={height} onUseDept={() => setComposeMode('dept')} />
      </Box>
    );

  if (editing)
    return (
      <TeamEditor
        dept={editing.dept}
        copy={editing.copy}
        height={fullH}
        defaultCategory={category === '__all__' ? undefined : category}
        categories={categories}
        onDone={(id) => {
          setEditing(null);
          if (id) setSel(id);
        }}
      />
    );

  const summary = (width: number, onBack: () => void, h = height) =>
    dept ? (
      <TeamSummary
        key={dept.id}
        dept={dept}
        roleMap={roleMap}
        width={width}
        height={h}
        tick={tick}
        keys={detail || panelZone}
        showBack={!side}
        onBack={onBack}
        onEdit={() => setEditing({ dept })}
        onCopy={() => setEditing({ dept, copy: true })}
        onDelete={() => askDelete(dept)}
      />
    ) : null;
  if (detail) return summary(cols, () => setOpen(false), fullH);

  const searchW = Math.min(30, Math.floor(gridW / 3));
  return (
    <Box flexDirection="column" height={fullH}>
      <ModeBar value={composeMode} onChange={setComposeMode} />
      <Box flexDirection="row" height={height}>
        <Box flexDirection="column" width={gridW}>
          <Box flexDirection="row" height={tabsH} flexShrink={0}>
            {manyCats ? (
              <Box width={gridW - searchW} flexDirection="row" alignItems="flex-end">
                <Text color={MUTED}> Categoría: </Text>
                <Button label={g.prev} onClick={() => stepCat(-1)} />
                <Text bold> {cat === '__all__' ? 'Todas' : cat} </Text>
                <Text color={MUTED}>({cat === '__all__' ? depts.length : depts.filter((d) => d.category === cat).length}) </Text>
                <Button label={g.next} onClick={() => stepCat(1)} />
                <Text color={MUTED}> (teclas [ y ])</Text>
              </Box>
            ) : (
              <ChromeTabs
                width={gridW - searchW}
                compact={compactTabs}
                tabs={[
                  { id: '__all__', label: 'Todos', badge: String(depts.length), badgeColor: MUTED },
                  ...categories.map((c) => ({ id: c, label: c, badge: String(depts.filter((d) => d.category === c).length), badgeColor: MUTED })),
                ]}
                active={cat}
                onSelect={setCategory}
              />
            )}
            <Box width={searchW} flexDirection="column" justifyContent="flex-end">
              <TextField id="team-search" label="Buscar:" value={query} onChange={(v) => (setQuery(v), setNav({ zone: 'grid', index: 0 }))} placeholder="nombre o categoría" width={searchW - 8} />
            </Box>
          </Box>
          <CardGrid
            items={items}
            cardW={cardW}
            cardH={cardH}
            width={gridW}
            height={height - tabsH}
            cursor={cursor.visible && zone === 'grid' ? index : undefined}
            onCursor={(i) => setNav({ zone: 'grid', index: i })}
            render={(d, w, st) =>
              d === NEW ? (
                <NewCard key={NEW} label="Nuevo equipo" width={w} height={cardH} cursor={st.cursor} onClick={() => (setNav({ zone: 'grid', index: st.index }), cursor.hide(), setEditing({}))} />
              ) : (
                <TeamCard
                  key={d.id}
                  d={d}
                  roles={roleMap}
                  selected={d.id === sel}
                  cursor={st.cursor}
                  tick={tick}
                  width={w}
                  compact={compactCards}
                  onClick={() => (setNav({ zone: 'grid', index: st.index }), cursor.hide(), openTeam(d))}
                />
              )
            }
          />
        </Box>
        {side && (
          <>
            <VSep height={height} />
            {summary(panelW, () => setNav({ zone: 'grid', index })) ?? (
              <Box width={panelW} height={height} alignItems="center" justifyContent="center">
                <Text color={MUTED}>Selecciona un equipo</Text>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

/** "Componer: ● Departamento │ ○ Auto por rol │ ○ Auto por partes del código" (p cycles). */
function ModeBar({ value, onChange }: { value: ComposeMode; onChange: (m: ComposeMode) => void }) {
  const { hq } = useApp();
  return (
    <Box flexDirection="row" flexShrink={0} height={1}>
      <Box flexShrink={0}>
        <Text color={MUTED}>Componer: </Text>
      </Box>
      <Toggle
        label="Componer"
        value={value}
        onChange={onChange}
        hint="p"
        options={[
          { value: 'dept', label: 'Departamento' },
          { value: 'auto-role', label: 'Auto por rol' },
          { value: 'auto-area', label: 'Auto por partes del código', color: hq ? MUTED : undefined },
        ]}
      />
    </Box>
  );
}

// --------------------------------------------------------- launch summary

function TeamSummary({
  dept,
  roleMap,
  width,
  height,
  tick,
  keys,
  showBack,
  onBack,
  onEdit,
  onCopy,
  onDelete,
}: {
  dept: Department;
  roleMap: Map<string, Role>;
  width: number;
  height: number;
  tick: number;
  /** This panel owns the keyboard (full-screen detail, or side panel focused with Tab). */
  keys: boolean;
  showBack: boolean;
  onBack: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { launch, hq, perm, setPerm, confirmLaunch, profile, setProfile, provider, setProvider } = useApp();
  const cursor = useKeyboardCursor();
  const [mc, setMc] = useState(0); // member under the keyboard cursor
  const members = dept.roles.map((id) => roleMap.get(id)).filter(Boolean) as Role[];
  const missing = dept.roles.filter((id) => !roleMap.has(id));
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [lead, setLead] = useState<string | undefined>(dept.lead);
  const [confirming, setConfirming] = useState(false);
  const [optsOpen, toggleOpts] = useLaunchOptions();
  const team = members.filter((m) => !excluded.has(m.id));
  const effLead = lead && !excluded.has(lead) && roleMap.has(lead) ? lead : team[0]?.id;
  const leadRole = effLead ? roleMap.get(effLead) : undefined;
  const writers = team.filter((m) => m.writes).length;
  const models = Object.entries(
    team.reduce<Record<string, number>>((acc, m) => ((acc[m.model ?? 'por defecto'] = (acc[m.model ?? 'por defecto'] ?? 0) + 1), acc), {}),
  )
    .map(([m, n]) => `${m} ×${n}`)
    .join(', ');
  const color = toHex(dept.color);
  const inner = width - 2;
  // Height budget (rows actually painted, no border): header 1 · description · coordinator
  // (divider + 7-row sprite, or one line when short) · members divider · member list ·
  // summary divider + 1 · directory · launch buttons.
  const roomy = height >= 46;
  const descLines = wrap(dept.description || 'Sin descripción', inner, roomy ? 3 : height >= 24 ? 2 : 1);
  const showDir = height >= 26;
  const fixed = 1 + descLines.length + (roomy ? 1 + 7 : 1) + 1 + 2 + (showDir ? 1 : 0) + launchButtonsHeight({ running: !!hq, confirming, profile: true, collapsed: !optsOpen });
  const listH = Math.max(2, height - fixed);
  // One line per member: the list stays readable with 15 roles.
  const scroll = useScroll(members.length, listH);
  const toggle = (id: string) => {
    const next = new Set(excluded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExcluded(next);
  };
  const moveMember = (key: string) => {
    const n = moveIndex(mc, members.length, 1, key, Math.max(1, listH));
    setMc(n);
    if (n < scroll.offset) scroll.scrollTo(n);
    else if (n + 1 > scroll.offset + listH) scroll.scrollTo(n + 1 - listH);
  };
  const current = members[mc];
  useShortcuts(
    'teams/detail',
    [
      ...['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end'].map((k) => ({ keys: [k], run: () => moveMember(k) })),
      { keys: ['space'], run: () => current && toggle(current.id) },
      { keys: ['c'], run: () => current && !excluded.has(current.id) && setLead(current.id) },
      { keys: ['l'], run: () => confirmLaunch(team.map((m) => m.id), effLead) },
      { keys: ['e'], run: onEdit },
      { keys: ['d'], run: onCopy },
      { keys: ['delete'], run: onDelete },
      { keys: ['esc', 'tab', 'shift+tab'], run: onBack },
    ],
    { active: keys, footer: 'teams.detail' },
  );
  const showCursor = keys && cursor.visible;

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0}>
        <Box flexDirection="row" flexShrink={1} alignItems="center">
          {showBack && <BackButton onClick={onBack} />}
          <Text bold color={color} wrap="truncate">
            {safeText(dept.icon)} {dept.name}
            {dept.scope === 'project' ? <Text color={INFO}> (proyecto)</Text> : null}
          </Text>
        </Box>
        <Box flexDirection="row" flexShrink={0} marginLeft={1}>
          <Button variant="secondary" label={`${g.edit} Editar`} onClick={onEdit} />
          <Button variant="secondary" label={`${g.copy} Duplicar`} onClick={onCopy} />
          <Button variant="danger" label={`${g.close} Borrar`} onClick={onDelete} />
        </Box>
      </Box>
      {descLines.map((l, i) => (
        <Text key={i} color={MUTED} wrap="truncate">
          {l}
        </Text>
      ))}
      {!roomy ? (
        <Text wrap="truncate">
          <Text color={MUTED}>Coordinador </Text>
          {leadRole ? (
            <Text bold color={toHex(leadRole.color)}>
              {g.star} {leadRole.name}{' '}
              <Text color={MUTED}>
                {g.sep} {leadRole.title}
              </Text>
            </Text>
          ) : (
            <Text color={MUTED}>nadie: el equipo no tiene miembros</Text>
          )}
        </Text>
      ) : (
        <Divider title="Coordinador" width={inner} color={color} />
      )}
      {roomy && (
        <Box flexDirection="row" height={7} flexShrink={0}>
          {leadRole ? (
            <>
              <BigSprite role={leadRole} tick={tick} state="talking" />
              <Box flexDirection="column" marginLeft={2} flexGrow={1}>
                <Text bold color={toHex(leadRole.color)}>
                  {g.star} {leadRole.name}
                </Text>
                <Text color={MUTED}>{leadRole.title}</Text>
                {wrap(leadRole.description, inner - 16, 3).map((l, i) => (
                  <Text key={i} wrap="truncate">
                    {l}
                  </Text>
                ))}
                <Text>{writesLabel(leadRole)}</Text>
              </Box>
            </>
          ) : (
            <Text color={MUTED}>El equipo no tiene miembros.</Text>
          )}
        </Box>
      )}
      <Divider title={`Miembros ${g.sep} clic: incluir ${g.sep} ${g.star} coordinador`} width={inner} color={color} />
      <ScrollArea scroll={scroll} height={listH} color={color} onWheel={(d: number) => scroll.onWheel(Math.sign(d) * 2)}>
        {members.length === 0 && <Text color={MUTED}>El equipo no tiene miembros.</Text>}
        {members.slice(scroll.offset, scroll.offset + listH).map((m, i) => {
          const idx = scroll.offset + i;
          const on = !excluded.has(m.id);
          const here = showCursor && idx === mc;
          return (
            <Box key={m.id} height={1} flexDirection="row">
              <Clickable onClick={() => (setMc(idx), cursor.hide(), toggle(m.id))} flexDirection="row" flexGrow={1} flexShrink={1} aria-role="checkbox" aria-label={m.name} aria-state={{ checked: on }}>
                <Box width={Math.min(22, Math.floor(inner / 2))} flexShrink={0}>
                  <Text bold={on || here} inverse={here} color={on ? toHex(m.color) : MUTED} wrap="truncate">
                    {here ? `${g.cursor} ` : ''}
                    {on ? g.checked : g.unchecked} {m.name}
                  </Text>
                </Box>
                <Box flexShrink={1}>
                  <Text color={MUTED} wrap="truncate">
                    {m.title}
                  </Text>
                </Box>
              </Clickable>
              <Box flexShrink={0} marginLeft={1}>
                {m.writes ? <Text color={WARN}>{g.edit}</Text> : <Text color={MUTED}>{g.readOnly}</Text>}
              </Box>
              <Clickable onClick={() => on && setLead(m.id)} width={3} aria-role="radio" aria-label={`Coordinador: ${m.name}`} aria-state={{ checked: effLead === m.id }}>
                <Text color={effLead === m.id ? WARN : MUTED}> {effLead === m.id ? g.star : g.starOff}</Text>
              </Clickable>
            </Box>
          );
        })}
        {missing.length > 0 && <Text color={DANGER}>Faltan en la biblioteca: {missing.join(', ')}</Text>}
      </ScrollArea>
      <Divider title="Resumen del lanzamiento" width={inner} color={color} />
      <Text wrap="truncate">
        <Text color={WARN}>{writers} escriben</Text> {g.sep} <Text color={MUTED}>{team.length - writers} solo lectura</Text> {g.sep} {models || '—'}
      </Text>
      {showDir && (
        <Text color={MUTED} wrap="truncate">
          Directorio: {PROJECT_DIR}
        </Text>
      )}
      <LaunchButtons
        mode={perm}
        onModeChange={setPerm}
        profile={profile}
        onProfileChange={setProfile}
        provider={provider}
        onProviderChange={setProvider}
        onConfirmingChange={setConfirming}
        collapsed={!optsOpen}
        onToggleOptions={toggleOpts}
        count={team.length}
        running={!!hq}
        onLaunch={(mode) => launch(team.map((m) => m.id), effLead, mode)}
      />
    </Box>
  );
}

// ------------------------------------------------------------ team editor

// Single-width symbols only (safeText swaps the ones some terminals draw wide).
const ICONS = [...new Set(['■', '✚', '▣', '◆', '▲', '◈', '✦', '✎', '★', '●', '◉', '☰', '♛', '♜', '⚑', '☂', '⚡', '⚙'].map((i) => safeText(i)))];

function TeamEditor({
  dept,
  copy,
  height,
  onDone,
  categories,
  defaultCategory,
}: {
  dept?: Department;
  copy?: boolean;
  height: number;
  onDone: (id?: string) => void;
  categories: string[];
  defaultCategory?: string;
}) {
  const { roles, reload, setToast } = useApp();
  const { cols, rows } = useSize();
  const tick = useTick(true);
  const initial = {
    name: dept ? (copy ? `${dept.name} (copia)` : dept.name) : '',
    icon: safeText(dept?.icon ?? '■'),
    color: dept?.color ?? 'cyan',
    description: dept?.description ?? '',
    category: dept?.category ?? defaultCategory ?? 'General',
    members: dept?.roles ?? [],
    lead: dept?.lead,
    scope: dept?.scope ?? ('global' as Scope),
    rules: dept?.rules ?? '',
  };
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon);
  const [color, setColor] = useState(initial.color);
  const [description, setDescription] = useState(initial.description);
  const [category, setCategory] = useState(initial.category);
  const [members, setMembers] = useState<string[]>(initial.members);
  const [lead, setLead] = useState<string | undefined>(initial.lead);
  const [scope, setScope] = useState<Scope>(initial.scope);
  const [rules, setRules] = useState(initial.rules);
  const [showRules, setShowRules] = useState(false);
  const [filter, setFilter] = useState('');
  const [pane, setPane] = useState<'form' | 'roles'>('form');
  const [nameErr, setNameErr] = useState('');
  const isEdit = !!dept && !copy;

  useEffect(() => {
    if (lead && !members.includes(lead)) setLead(members[0]);
    if (!lead && members.length) setLead(members[0]);
  }, [members]);

  const toggle = (id: string) => setMembers(members.includes(id) ? members.filter((m) => m !== id) : [...members, id]);
  const save = () => {
    if (!name.trim()) {
      setPane('form');
      setNameErr('Escribe un nombre para el equipo.');
      return false;
    }
    const id = isEdit ? dept!.id : makeId(name);
    if (isEdit && dept!.scope !== scope) deleteDepartment(dept!.file);
    saveDepartment({ id, name: name.trim(), icon, color, category: category.trim() || 'General', description: description.trim(), roles: members, lead, scope, dirs: dept?.dirs, rules });
    reload();
    setToast(`Equipo «${name.trim()}» guardado`);
    onDone(id);
  };
  const current = { name, icon, color, description, category, members, lead, scope, rules };
  useFormState(JSON.stringify(current) !== JSON.stringify(initial), save, name.trim() || 'Nuevo equipo');
  useFormKeys(showRules ? ['team-rules'] : ['team-name', 'team-desc', 'team-cat', 'team-filter'], save, () => (showRules ? setShowRules(false) : onDone()));

  // Narrow: form and role picker become two tabs sharing the full width.
  const { side, compactTabs } = gridLayout(cols, rows);
  const bodyH = side ? height : height - 1;
  const formW = side ? 52 : cols;
  const gridW = side ? cols - formW - 1 : cols;
  const shown = roles.filter((r) => !filter || `${r.name} ${r.title} ${r.pack ?? ''} ${r.description}`.toLowerCase().includes(filter.toLowerCase()));
  const chipW = 32;
  const chipH = compactTabs ? 4 : 6;
  const perRow = Math.max(1, Math.floor((gridW - 1) / (chipW + 1)));
  const listH = bodyH - 2;
  const visibleRows = Math.max(1, Math.floor(listH / chipH));
  const scroll = useScroll(Math.ceil(shown.length / perRow), visibleRows);
  const c = toHex(color);

  const showForm = !showRules && (side || pane === 'form');
  const showRoles = !showRules && (side || pane === 'roles');
  const ruleLines = rules.trim() ? rules.trim().split('\n').length : 0;
  return (
    <Box flexDirection="column" height={height}>
      {!side && (
        <Box flexDirection="row" flexShrink={0} height={1}>
          <Toggle
            label="Sección"
            value={pane}
            onChange={setPane}
            options={[
              { value: 'form', label: 'Formulario' },
              { value: 'roles', label: `Añadir roles (${members.length})` },
            ]}
          />
          <Box flexGrow={1} />
          <Button variant="primary" label="Guardar" onClick={save} />
          <Button variant="secondary" label="Cancelar" onClick={() => onDone()} />
        </Box>
      )}
      <Box flexDirection="row" height={bodyH}>
        {showRules && (
          <Box flexDirection="column" width={cols} height={bodyH} paddingX={1}>
            <Box flexDirection="row" flexShrink={0} height={1}>
              <BackButton label="Volver al equipo" onClick={() => setShowRules(false)} />
              <Text bold color={c} wrap="truncate">
                Reglas del equipo {g.sep} <Text color={MUTED}>se añaden al prompt de cada rol de «{name.trim() || 'este equipo'}»</Text>
              </Text>
            </Box>
            <Text color={MUTED} wrap="truncate">
              Markdown, como un AGENTS.md / CLAUDE.md del equipo: contexto, carpetas, normas obligatorias. Ctrl+S guarda.
            </Text>
            <TextArea id="team-rules" value={rules} onChange={setRules} width={cols - 2} rows={Math.max(3, bodyH - 4)} placeholder="## Contexto del equipo…" />
          </Box>
        )}
        {showForm && (
          <Box flexDirection="column" width={formW} height={bodyH} paddingX={1} overflow="hidden">
            <Text bold color={c}>
              {isEdit ? 'Editar equipo' : 'Nuevo equipo'}
            </Text>
            <Box marginTop={1} flexShrink={0}>
              <TextField id="team-name" label="Nombre     " value={name} onChange={(v) => (setName(v), setNameErr(''))} width={36} />
            </Box>
            {nameErr && (
              <Text color={DANGER}>
                {'            '}
                {g.warning} {nameErr}
              </Text>
            )}
            <TextField id="team-desc" label="Descripción" value={description} onChange={setDescription} width={36} />
            <TextField id="team-cat" label="Categoría  " value={category} onChange={setCategory} width={36} />
            <Box flexDirection="row" flexWrap="wrap" flexShrink={0}>
              <Text color={MUTED}>{'            '}</Text>
              {categories.map((x) => (
                <Button key={x} label={x} color="magenta" active={category === x} onClick={() => setCategory(x)} />
              ))}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" flexShrink={0}>
              <Text color={MUTED}>Icono       </Text>
              {ICONS.map((i) => (
                <Clickable key={i} onClick={() => setIcon(i)} aria-role="radio" aria-label={`Icono ${i}`} aria-state={{ checked: icon === i }}>
                  <Text color={icon === i ? 'black' : c} backgroundColor={icon === i ? c : undefined}>
                    {` ${i} `}
                  </Text>
                </Clickable>
              ))}
            </Box>
            <Box flexDirection="row" flexShrink={0}>
              <Text color={MUTED}>Color       </Text>
              <ColorPicker value={color} onChange={setColor} />
            </Box>
            <Box flexDirection="row" flexShrink={0}>
              <Text color={MUTED}>Guardar en  </Text>
              <Toggle
                label="Guardar en"
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'global', label: 'Global' },
                  { value: 'project', label: 'Solo este proyecto' },
                ]}
              />
            </Box>
            <Box flexDirection="row" flexShrink={0}>
              <Text color={MUTED}>Reglas      </Text>
              <Button variant="secondary" label={`${g.write} ${ruleLines ? `Reglas del equipo (${ruleLines} líneas)` : 'Añadir reglas del equipo'}`} onClick={() => setShowRules(true)} />
            </Box>
            <Divider title={`Miembros (${members.length})`} width={formW - 2} color={c} />
            <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
              {members.length === 0 && <Text color={MUTED}>{side ? 'Haz clic en los roles de la derecha para añadirlos.' : 'Añade roles en «Añadir roles».'}</Text>}
              {members.map((id) => {
                const r = roles.find((x) => x.id === id);
                return (
                  <Box key={id} flexDirection="row" flexShrink={0}>
                    <Clickable onClick={() => setLead(id)} width={2} aria-role="radio" aria-label={`Coordinador: ${r?.name ?? id}`} aria-state={{ checked: lead === id }}>
                      <Text color={lead === id ? WARN : MUTED}>{lead === id ? g.star : g.starOff}</Text>
                    </Clickable>
                    <Text color={r ? toHex(r.color) : DANGER} wrap="truncate">
                      {r?.name ?? `${id} (no encontrado)`}
                    </Text>
                    <Box flexGrow={1} />
                    <Button variant="danger" label={`${g.close} Quitar`} onClick={() => toggle(id)} />
                  </Box>
                );
              })}
            </Box>
            {side && (
              <Box flexDirection="row" flexShrink={0}>
                <Button variant="primary" label="Guardar equipo" onClick={save} />
                <Button variant="secondary" label="Cancelar" onClick={() => onDone()} />
              </Box>
            )}
          </Box>
        )}
        {side && <VSep height={bodyH} />}
        {showRoles && (
          <Box flexDirection="column" width={side ? gridW - 1 : gridW} paddingLeft={side ? 1 : 0}>
            <Box flexDirection="row" flexShrink={0}>
              <Text bold> Roles disponibles </Text>
              <Text color={MUTED}>
                {g.sep} clic para añadir/quitar {g.sep}{' '}
              </Text>
              <TextField id="team-filter" label="Filtrar:" value={filter} onChange={setFilter} placeholder="nombre, título o pack" width={24} />
            </Box>
            <ScrollArea scroll={scroll} height={listH} color={c} onWheel={(d: number) => scroll.onWheel(Math.sign(d))} flexDirection="row" flexWrap="wrap">
              {shown.slice(scroll.offset * perRow, (scroll.offset + visibleRows) * perRow).map((r, i) => {
                const on = members.includes(r.id);
                return (
                  <Clickable
                    key={r.id}
                    onClick={() => toggle(r.id)}
                    width={chipW}
                    height={chipH}
                    flexDirection="row"
                    borderStyle={on ? 'double' : 'round'}
                    borderColor={on ? toHex(r.color) : MUTED}
                    paddingX={1}
                    marginRight={1}
                    aria-role="checkbox"
                    aria-label={r.name}
                    aria-state={{ checked: on }}
                  >
                    {chipH > 4 && <MiniSprite role={r} tick={on ? tick + i : 0} dim={!on} />}
                    <Box flexDirection="column" marginLeft={chipH > 4 ? 1 : 0} width={chipW - (chipH > 4 ? 11 : 4)}>
                      <Text bold={on} color={on ? toHex(r.color) : TEXT} wrap="truncate">
                        {on ? g.checked : g.unchecked} {r.name}
                      </Text>
                      <Text color={MUTED} wrap="truncate">
                        {r.title}
                      </Text>
                      {chipH > 4 && (
                        <Text wrap="truncate">
                          {writesLabel(r)}
                          {r.pack ? <Text color="magenta"> {r.pack}</Text> : null}
                        </Text>
                      )}
                    </Box>
                  </Clickable>
                );
              })}
            </ScrollArea>
            <Text color={shown.length ? MUTED : WARN}>
              {shown.length ? `${shown.length} roles` : 'Sin resultados'}
              {scroll.offset > 0 || shown.length > visibleRows * perRow ? ` ${g.sep} rueda para ver más` : ''}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
