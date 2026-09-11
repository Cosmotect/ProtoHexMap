// Runtime settings window: every value from the config files, editable in the app.
// Changes are written straight into CONFIG (so the rest of the game reads them as
// usual), saved in the browser (localStorage) and re-applied on the next load, which
// means they take precedence over the config files. Each row has a reset button that
// puts the file value back; each tab has "Reset tab".
//
// Nothing here knows what a setting means: the form is generated from the shape of
// the config objects (numbers, booleans, strings, colours, lists, nested groups).

import { t, LANGUAGES, getLanguage, setLanguage } from './i18n.js';
import { SHAPE_NAMES } from './local/localview.js';
import { ABILITIES, statusKnobs } from './config/abilities.js';
// The intellect classes moved next to the bestiary that hands one to every row
// (config/units.js, 2026-09-10).
import { INTELLECT } from './config/units.js';

const STORAGE_KEY = 'hexmap-settings-v1';

// ----- the Units tab's hand-built editors ------------------------------------
// The generic form generator is fine for a fixed list of numbers, but it cannot
// ADD or REMOVE an entry, and the enemy system is a system of entries: a
// bestiary, groups made of bestiary ids, and pools made of group ids. So the
// Units tab is written out by hand instead, as three editors that can create
// and delete rows. They all save the SAME way: the whole collection is stored
// as one override (`battle.enemyTypes`, not `battle.enemyTypes.husk.hp`),
// because an add or a delete is a change to the collection, not to one value.

// The bestiary table's columns. `kind` picks the control; `options` makes it a
// dropdown. Everything a creature is lives here - body, numbers and the combat
// half - so one row is one whole enemy (see config/units.js).
const BESTIARY_COLS = [
  { key: 'name', kind: 'text', w: 118 },
  { key: 'shape', kind: 'select', options: () => SHAPE_NAMES },
  { key: 'color', kind: 'color' },
  { key: 'hp', kind: 'number', w: 48 },
  { key: 'init', kind: 'number', w: 44 },
  { key: 'speed', kind: 'number', w: 44 },
  { key: 'flying', kind: 'bool' },
  // The creature's INTELLECT CLASS: which facts it can weigh on its turn.
  { key: 'intellect', kind: 'select', w: 56, options: () => Object.keys(INTELLECT) },
  { key: 'abilities', kind: 'idlist', w: 130, valid: () => Object.keys(ABILITIES) },
];
// A brand new creature: deliberately weak and plain, so an unfinished row that
// finds its way into a fight cannot wreck a run.
const NEW_ENEMY = () => ({ name: 'New enemy', shape: 'octahedron', color: 0xe2474b, hp: 10, init: 5, speed: 4, flying: false, intellect: 'C', abilities: ['strike'] });
const NEW_GROUP = () => ({ title: 'New group', units: [] });

// Colours are written two ways in the config: as CSS strings ('#a1254a', what the
// abilities and the bestiary use) and as JS numbers (0xa1254a, what the tile types,
// biomes and the colours block still use). The widgets speak CSS; these two keep
// each value in the shape its config file wrote it in, so editing a colour never
// silently rewrites the file's style.
const cssColor = (v) => (typeof v === 'string' ? v : `#${Number(v ?? 0).toString(16).padStart(6, '0')}`);
// Stamped onto the input and read back on change: "css" hands the '#rrggbb' string
// back, anything else goes back as the 0xrrggbb number that config file had.
const colorShapeAttr = (v) => (typeof v === 'string' ? ' data-cshape="css"' : '');
const readColor = (el) => (el.dataset.cshape === 'css' ? el.value : parseInt(el.value.slice(1), 16));
const NEW_ROSTER = () => ({ name: 'New character', icon: '🙂', hp: 24, speed: 4, flying: false, abilities: ['strike'] });
// No `init` column: turn order inside a fight is an ENEMY-only number (the
// engine's enemy queue sorts by it), so a character never had one that meant
// anything. Removed 2026-09-06.
const ROSTER_COLS = [
  { key: 'name', kind: 'text', w: 118 },
  { key: 'icon', kind: 'text', w: 44 },
  { key: 'hp', kind: 'number', w: 48 },
  { key: 'speed', kind: 'number', w: 44 },
  { key: 'flying', kind: 'bool' },
  { key: 'abilities', kind: 'idlist', w: 130, valid: () => Object.keys(ABILITIES) },
];
// Keys of `battle` the hand-built editors own; the leftovers render as an
// ordinary group of numbers so nothing silently disappears from the tab.
const BATTLE_OWNED = new Set(['enemyTypes', 'enemyGroups', 'spawns']);

// Which config sections live on which tab (mirrors the config files). Labels and
// notes come from the locale tables (settings.tab.<id>, settings.note.<id>).
const TABS = [
  { id: 'world', sections: ['map', 'worldBackground', 'localBackground', 'noise', 'tileTypes', 'biomes'] },
  // `battle` is listed here (not on Units) so that "Reset tab" reaches it; the
  // render loop skips it and renders it explicitly next to the Battles table.
  { id: 'encounters', sections: ['encounters', 'stasis', 'rest', 'acolyte', 'shop', 'treasure', 'events', 'fatigue', 'battle'] },
  { id: 'units', sections: ['party', 'combat', 'statuses', 'tags', 'intellect'] },
  // NOTE: `battle` lives on the ENCOUNTERS tab - see battleScalars() in render().
  { id: 'general', sections: ['run', 'camera', 'local', 'anim', 'fatigueBar', 'colors'] },
  { id: 'audio', sections: ['audio'] },
];

// Keys that are not meant to be edited by hand (visual placeholders, long texts).
const SKIP_KEYS = new Set(['shape', 'info', 'flavour', 'names', 'icon']);

// Sections shown as one table (rows = entries, columns = attributes) instead of
// one group per entry, so an attribute name is written once rather than repeated
// for every tile type or biome. A table is wider than an ordinary group, so a tab
// containing one lays its sections out on a GRID (where a section can be told to
// span several columns) instead of the CSS multi-column flow the other tabs use -
// see `has-matrix` in render() and style.css.
const MATRIX_SECTIONS = new Set(['tileTypes', 'biomes', 'statuses', 'intellect', 'tags']);
// A tile tag's four HOOKS each name an ability, which is how a tag can do
// anything an ability can - damage, healing, pushes, a status. They get a
// dropdown of the ability ids rather than a text box, so a typo cannot quietly
// turn a hook off (config/abilities.js, COMBAT_TAGS).
const TAG_HOOKS = new Set(['onPeriodic', 'onPickup', 'onExpire', 'onDestroy']);

export function createSettings({ config, defaults, onChange, getUiScale, onSetUiScale, getShowLog, onSetShowLog, onClose }) {
  const $ = (id) => document.getElementById(id);
  const win = $('settings');
  const tabsEl = $('settings-tabs');
  const bodyEl = $('settings-body');
  let activeTab = TABS[0].id;
  const store = loadStore();
  let overrides = store.overrides;
  // { '<collection path>': [id, ...] } - records the player deleted from an
  // editable collection. See healOverride: without this the two reasons a record
  // can be missing from a save are indistinguishable.
  const removed = store.removed;

  // ----- apply saved overrides on startup ------------------------------
  // A saved override is a snapshot of the config AS IT WAS WHEN IT WAS SAVED, so
  // one made before a table grew a column arrives without that column. Records are
  // merged over today's defaults instead of replacing them wholesale, and an
  // override pointing at config that no longer exists is dropped.
  // (Written 2026-09-06 after settings saved before the roster carried its own
  // abilities restored a party with no abilities at all and threw on the first
  // draw of the party panel, taking the page with it.)
  //
  // The healed value is written back into `overrides` as well, not only into the
  // config. It used to be healed on the way into the config and left stale in
  // the override, so a save made before the bestiary grew a column disagreed
  // with today's defaults FOREVER - which is what made "Copy changes" dump whole
  // collections that had not actually been touched. And an override that turns
  // out to match the default is dropped outright: there is nothing to override.
  for (const [path, value] of Object.entries(overrides)) {
    const def = getPath(defaults, path);
    if (def === undefined) { delete overrides[path]; continue; }
    const healed = healOverride(def, value, removed[path]);
    if (deepEqual(healed, def)) { delete overrides[path]; continue; }
    overrides[path] = healed;
    setPath(config, path, deepClone(healed));
  }
  saveOverrides();

  $('btn-settings-close').addEventListener('click', close);
  // "Copy changes": every property that differs from the config-file default goes
  // to the clipboard as "path = value (default: ...)" lines - handy for pasting
  // into a chat or a note when a tuning session found keeper values.
  $('btn-settings-copy').addEventListener('click', async () => {
    const btn = $('btn-settings-copy');
    // One line per LEAF that differs, not one per override. An override can be a
    // whole collection (the bestiary is stored as one, because adding or deleting
    // a creature is a change to the collection rather than to one value), and
    // printing the collection meant thirty creatures of JSON because one had its
    // hp nudged. Walking it against the default gives
    // "battle.enemyTypes.husk.hp = 12  (default: 10)" instead.
    const lines = [];
    for (const path of Object.keys(overrides).sort()) {
      for (const [p, value, def] of diffLeaves(path, getPath(config, path), getPath(defaults, path))) {
        if (value === undefined) lines.push(`${p} REMOVED  (was ${fmtValue(p, def)})`);
        else if (def === undefined) lines.push(`${p} ADDED = ${fmtValue(p, value)}`);
        else lines.push(`${p} = ${fmtValue(p, value)}  (default: ${fmtValue(p, def)})`);
      }
    }
    let feedback = 'settings.copy.none';
    if (lines.length) {
      feedback = (await copyToClipboard(lines.join('\n'))) ? 'settings.copied' : 'settings.copy.fail';
    }
    const label = btn.textContent;
    btn.textContent = t(feedback);
    setTimeout(() => { btn.textContent = label; }, 1600);
  });
  function fmtValue(path, value) {
    if (value === undefined) return '(none)';
    if (Array.isArray(value)) return value.join(', ');
    // A whole record only ever shows up as one side of an added or deleted row.
    // Its name says which one; the thirty fields inside it say nothing useful in
    // a line meant to be pasted into a note.
    if (value && typeof value === 'object') {
      const name = value.name ?? value.title;
      return name ? `"${name}"` : JSON.stringify(value);
    }
    const key = path.split('.').pop();
    if (kindOf(key, value, path) === 'color') return cssColor(value);
    return String(value);
  }
  $('btn-settings-reset-tab').addEventListener('click', () => {
    const tab = TABS.find((t) => t.id === activeTab);
    for (const path of Object.keys(overrides)) {
      if (tab.sections.includes(path.split('.')[0])) resetPath(path);
    }
    render();
    onChange('*');
  });

  function open() { render(); win.classList.remove('hidden'); }
  function refresh() { if (isOpen()) render(); }
  function close() { closeGroupPicker(); win.classList.add('hidden'); if (onClose) onClose(); }
  function isOpen() { return !win.classList.contains('hidden'); }

  // ----- rendering ---------------------------------------------------------
  function render() {
    // A picker anchored to a "+" that is about to be replaced would be left
    // floating over the new tab (it is appended to <body>, not to the table).
    closeGroupPicker();
    tabsEl.innerHTML = TABS.map((tab) => `<button class="tab ${tab.id === activeTab ? 'active' : ''}" data-tab="${tab.id}">${t(`settings.tab.${tab.id}`)}</button>`).join('');
    tabsEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { activeTab = b.dataset.tab; render(); }));
    const tab = TABS.find((x) => x.id === activeTab);
    const parts = [`<p class="muted settings-note">${t(`settings.note.${tab.id}`)}</p>`];
    if (tab.id === 'general') {
      const options = LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === getLanguage() ? 'selected' : ''}>${l.label}</option>`).join('');
      parts.push(`<div class="settings-group"><div class="settings-group-title">${t('settings.language.group')}</div>
        <div class="settings-row"><span class="settings-label">${t('settings.language')}</span>
        <select id="settings-language">${options}</select><span class="settings-reset"></span></div></div>`);
      // UI scale: a browser preference (like the language), not part of CONFIG.
      const scales = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
      const current = getUiScale ? getUiScale() : 1;
      const scaleOptions = scales.map((s) => `<option value="${s}" ${Math.abs(s - current) < 0.01 ? 'selected' : ''}>${Math.round(s * 100)}%</option>`).join('');
      parts.push(`<div class="settings-group"><div class="settings-group-title">${t('settings.uiscale.group')}</div>
        <div class="settings-row"><span class="settings-label">${t('settings.uiscale')}</span>
        <select id="settings-uiscale">${scaleOptions}</select><span class="settings-reset"></span></div>
        <div class="settings-row"><span class="settings-label">${t('settings.showlog')}</span>
        <input type="checkbox" id="settings-showlog" ${getShowLog && getShowLog() ? 'checked' : ''}><span class="settings-reset"></span></div></div>`);
    }
    // The tab's content is built in two piles. SMALL groups (a handful of rows
    // each) go into `flow`, which style.css lays out as a multi-column flow: it
    // packs items of wildly different heights with no gaps. WIDE items - the
    // tables - go into `wide` and take the full width, one under another.
    //
    // The previous layout put everything on one grid. A grid row is as tall as
    // its tallest item, so a single long group (encounters > visuals, a colour
    // per encounter kind) stretched the whole first row and left an enormous
    // void beside the short groups. A flow has no rows to stretch.
    const flow = [];
    const wide = [];
    if (tab.id === 'units') renderUnitsTab(flow, wide);
    else {
      for (const section of tab.sections) {
        if (section === 'battle') continue;   // rendered below, with only the keys no editor owns
        if (MATRIX_SECTIONS.has(section)) wide.push(renderMatrix(section, config[section], defaults[section], section));
        else flow.push(...renderSection(section));
      }
      if (tab.id === 'encounters') {
        // The battle numbers used to live on the Units tab, which put the rules
        // of a fight in one place and the fights themselves in another. They
        // belong here, beside the table that says which fight spawns where.
        flow.push(renderGroup('battle', battleScalars(), defaults.battle, 'battle'));
        wide.push(battlesBlock());
      }
    }
    if (flow.length) parts.push(`<div class="settings-flow">${flow.join('')}</div>`);
    parts.push(...wide);
    bodyEl.innerHTML = parts.join('');
    bodyEl.classList.toggle('has-matrix', wide.length > 0);
    if (tab.id === 'units') wireUnitsTab();
    if (tab.id === 'encounters') wireBattlesBlock();
    bodyEl.querySelector('#settings-language')?.addEventListener('change', (e) => { setLanguage(e.target.value); render(); });
    bodyEl.querySelector('#settings-uiscale')?.addEventListener('change', (e) => { if (onSetUiScale) onSetUiScale(Number(e.target.value)); });
    bodyEl.querySelector('#settings-showlog')?.addEventListener('change', (e) => { if (onSetShowLog) onSetShowLog(e.target.checked); });
    bodyEl.querySelectorAll('[data-path]').forEach((input) => {
      input.addEventListener('change', () => {
        const path = input.dataset.path;
        const value = readInput(input);
        setPath(config, path, value);
        setOverride(path, value);
        markRow(input);
        onChange(path);
      });
    });
    bodyEl.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        resetPath(btn.dataset.reset);
        render();
        onChange(btn.dataset.reset);
      });
    });
  }

  // ===================================================================
  //  The Units tab
  // ===================================================================
  // A section as one or more flow items: the plain rows in one box, and each
  // group of look-alike records (encounters > visuals) HOISTED into a box of its
  // own. Left nested, a long table is one unbreakable item that sets the height
  // of its whole column; hoisted, the flow can put it wherever it fits.
  function renderSection(section) {
    const obj = config[section];
    const def = defaults[section];
    const rest = {};
    const tables = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && looksLikeRecords(v)) {
        tables.push(renderMatrix(`${section} - ${k}`, v, def?.[k], `${section}.${k}`));
      } else rest[k] = v;
    }
    return [renderGroup(section, rest, def, section), ...tables];
  }

  // Everything under `battle` that no hand-built editor owns: the damage curve,
  // the danger bands, the simulation numbers. Rendered on the ENCOUNTERS tab,
  // beside the table that decides which fight happens where.
  function battleScalars() {
    const rest = {};
    for (const [k, v] of Object.entries(config.battle)) if (!BATTLE_OWNED.has(k)) rest[k] = v;
    return rest;
  }

  function renderUnitsTab(flow, wide) {
    const b = config.battle;

    // The party: everything except the roster stays an ordinary group, and the
    // roster becomes a table with the same add / delete row as the bestiary.
    const partyScalars = {};
    for (const [k, v] of Object.entries(config.party)) if (k !== 'roster') partyScalars[k] = v;
    flow.push(renderGroup('party', partyScalars, defaults.party, 'party'));
    // The arena rules that are NOT about one fight's numbers stay here with the
    // units they govern.
    for (const section of ['combat', 'statuses', 'intellect']) {
      if (!config[section]) continue;
      if (MATRIX_SECTIONS.has(section)) wide.push(renderMatrix(section, config[section], defaults[section], section));
      else flow.push(renderGroup(section, config[section], defaults[section], section));
    }
    wide.push(recordTable({
      title: t('settings.units.roster'), coll: 'party.roster', obj: config.party.roster,
      cols: ROSTER_COLS, addLabel: t('settings.units.addChar'), rowLabel: t('settings.units.character'),
      note: t('settings.units.roster.note'), list: true,
    }));

    // The bestiary: one row per creature, everything about it on that row.
    wide.push(recordTable({
      title: t('settings.units.bestiary'), coll: 'battle.enemyTypes', obj: b.enemyTypes,
      cols: BESTIARY_COLS, addLabel: t('settings.units.addEnemy'), rowLabel: t('settings.units.id'),
      note: t('settings.units.bestiary.note'), wide: true,
    }));

    // The groups: a title and a line-up of bestiary ids.
    wide.push(groupsTable(b));
    // (Which groups spawn where, and the battle numbers themselves, are on the
    // Encounters tab.)
  }

  // A table of records that can grow and shrink. `coll` is the config path of
  // the WHOLE collection - an object keyed by id, or (with `list: true`) an
  // array, in which case the row header is the index instead of an editable id.
  function recordTable({ title, coll, obj, cols, addLabel, rowLabel, note, wide, list }) {
    const entries = list ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
    const head = `<tr><th>${escapeAttr(rowLabel)}</th>${cols.map((c) => `<th>${c.key}</th>`).join('')}<th></th></tr>`;
    const body = entries.map(([id, rec]) => {
      const cells = cols.map((c) => `<td>${editor(coll, id, c, rec[c.key])}</td>`).join('');
      const header = list
        ? `<th class="rt-index">${Number(id) + 1}</th>`
        : `<th><input type="text" class="rt-id" data-coll="${coll}" data-row="${escapeAttr(id)}" data-field="__id" value="${escapeAttr(id)}"></th>`;
      return `<tr>${header}${cells}<td>${delButton(coll, id, list)}</td></tr>`;
    }).join('');
    return `<div class="settings-group settings-matrix settings-records${wide ? ' wide' : ''}">
      <div class="settings-group-title">${escapeAttr(title)}</div>
      ${note ? `<p class="muted rt-note">${escapeAttr(note)}</p>` : ''}
      <div class="settings-matrix-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
      <button class="small rt-add" data-add="${coll}">${escapeAttr(addLabel)}</button>
      ${resetCollButton(coll)}
    </div>`;
  }

  // One cell's control. `data-coll` / `data-row` / `data-field` say where the
  // value goes; the whole collection is re-saved on every change.
  function editor(coll, row, col, value) {
    const a = `data-coll="${coll}" data-row="${escapeAttr(row)}" data-field="${col.key}" data-kind="${col.kind}"`;
    const w = col.w ? ` style="width:${col.w}px"` : '';
    if (col.kind === 'bool') return `<input type="checkbox" ${a} ${value ? 'checked' : ''}>`;
    if (col.kind === 'color') return `<input type="color" ${a}${colorShapeAttr(value)} value="${cssColor(value)}">`;
    if (col.kind === 'number') return `<input type="number" step="any" ${a} value="${value ?? ''}"${w}>`;
    if (col.kind === 'select') {
      const opts = col.options().map((o) => `<option value="${o}" ${o === value ? 'selected' : ''}>${o}</option>`).join('');
      return `<select ${a}>${opts}</select>`;
    }
    if (col.kind === 'idlist') {
      // A comma-separated list of ids, marked red the moment one of them is not
      // a real id - a typo here would otherwise show up as a silently missing
      // creature much later, in a fight.
      const valid = col.valid ? col.valid() : null;
      const arr = Array.isArray(value) ? value : [];
      const bad = valid ? arr.some((v) => !valid.includes(v)) : false;
      return `<input type="text" class="${bad ? 'rt-bad' : ''}" ${a} value="${escapeAttr(arr.join(', '))}"${w}>`;
    }
    return `<input type="text" ${a} value="${escapeAttr(String(value ?? ''))}"${w}>`;
  }

  function delButton(coll, row, list) {
    return `<button class="small rt-del" data-del="${coll}" data-row="${escapeAttr(row)}" data-list="${list ? 1 : 0}" title="${escapeAttr(t('settings.units.remove'))}">&#215;</button>`;
  }
  // These editors save the collection whole, so a per-row reset makes no sense:
  // the whole table goes back to the config file at once.
  function resetCollButton(coll) {
    if (!isChanged(coll)) return '';
    return `<button class="small rt-reset" data-reset="${coll}">${t('settings.units.resetTable')}</button>`;
  }

  // The group table: a title plus the line-up. `units` accepts repeats - two
  // huskss in a group is two husks on the arena, numbered "Husk 2".
  function groupsTable(b) {
    const typeIds = Object.keys(b.enemyTypes ?? {});
    const cols = [
      { key: 'title', kind: 'text', w: 130 },
      { key: 'units', kind: 'idlist', w: 330, valid: () => typeIds },
    ];
    return recordTable({
      title: t('settings.units.groups'), coll: 'battle.enemyGroups', obj: b.enemyGroups,
      cols, addLabel: t('settings.units.addGroup'), rowLabel: t('settings.units.id'),
      note: t('settings.units.groups.note'), wide: true,
    });
  }

  // ----- Settings > Encounters > Battles ------------------------------------
  // Which groups each kind of fight may roll, as a grid: a ROW per kind (the ring
  // bands, then the Colonies and the Seed) and a COLUMN per layer of the
  // worldflake. A cell holds group buttons - press one to take it out - and a "+"
  // that opens a searchable list of every group there is.
  // (Until 2026-09-06 this was a wall of tick boxes on the Units tab with no layer
  // dimension at all.)
  function battlesBlock() {
    const b = config.battle;
    const spawns = b.spawns ?? {};
    const rows = Object.keys(spawns);
    const layers = [...new Set(rows.flatMap((r) => Object.keys(spawns[r] ?? {}).map(Number)))].sort((x, y) => x - y);
    const title = (gid) => b.enemyGroups?.[gid]?.title ?? gid;
    const head = `<tr><th></th>${layers.map((n) => `<th>${t('settings.battles.layer', { n })}</th>`).join('')}</tr>`;
    const body = rows.map((row) => {
      const cells = layers.map((n) => {
        const chosen = spawns[row]?.[n] ?? [];
        const chips = chosen.map((gid) => `<button class="spawn-chip" data-drop="${row}|${n}|${escapeAttr(gid)}"
          title="${escapeAttr(t('settings.battles.remove', { name: title(gid) }))}">${escapeAttr(title(gid))}</button>`).join('');
        return `<td><div class="spawn-cell">${chips}<button class="spawn-add" data-pick="${row}|${n}">+</button></div></td>`;
      }).join('');
      const label = t(`settings.battles.row.${row}`) === `settings.battles.row.${row}` ? row : t(`settings.battles.row.${row}`);
      return `<tr><th>${escapeAttr(label)}</th>${cells}</tr>`;
    }).join('');
    return `<div class="settings-group settings-matrix settings-battles wide">
      <div class="settings-group-title">${t('settings.battles')}</div>
      <p class="muted rt-note">${escapeAttr(t('settings.battles.note'))}</p>
      <div class="settings-matrix-scroll"><table>
        <colgroup><col class="bt-row">${layers.map(() => '<col>').join('')}</colgroup>
        <thead>${head}</thead><tbody>${body}</tbody></table></div>
    </div>`;
  }

  // The picker: every group, filtered as you type. Opens under the "+" it belongs
  // to, closes on pick, on Escape, or on a click anywhere else.
  function openGroupPicker(anchor, row, layer) {
    closeGroupPicker();
    const b = config.battle;
    const chosen = new Set(config.battle.spawns?.[row]?.[layer] ?? []);
    const all = Object.entries(b.enemyGroups ?? {}).map(([gid, g]) => ({ gid, title: g.title ?? gid }));
    const el = document.createElement('div');
    el.className = 'spawn-picker';
    el.innerHTML = `<input type="text" class="spawn-search" placeholder="${escapeAttr(t('settings.battles.search'))}">
      <div class="spawn-list"></div>`;
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    el.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
    el.style.top = `${r.bottom + 4}px`;
    const list = el.querySelector('.spawn-list');
    const search = el.querySelector('.spawn-search');
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const hits = all.filter((x) => !q || x.gid.toLowerCase().includes(q) || x.title.toLowerCase().includes(q));
      list.innerHTML = hits.length
        ? hits.map((x) => `<button class="spawn-opt ${chosen.has(x.gid) ? 'on' : ''}" data-gid="${escapeAttr(x.gid)}">
            ${escapeAttr(x.title)}<i>${escapeAttr(x.gid)}</i></button>`).join('')
        : `<p class="muted">${escapeAttr(t('settings.battles.none'))}</p>`;
      list.querySelectorAll('.spawn-opt').forEach((btn) => btn.addEventListener('click', () => {
        addToSlot(row, layer, btn.dataset.gid);
        closeGroupPicker();
      }));
    };
    search.addEventListener('input', draw);
    draw();
    search.focus();
    pickerEl = el;
    setTimeout(() => document.addEventListener('mousedown', outsidePicker), 0);
    document.addEventListener('keydown', escPicker);
  }
  let pickerEl = null;
  const outsidePicker = (e) => { if (pickerEl && !pickerEl.contains(e.target)) closeGroupPicker(); };
  const escPicker = (e) => { if (e.key === 'Escape') closeGroupPicker(); };
  function closeGroupPicker() {
    if (!pickerEl) return;
    pickerEl.remove();
    pickerEl = null;
    document.removeEventListener('mousedown', outsidePicker);
    document.removeEventListener('keydown', escPicker);
  }
  // A slot is one cell of the table: battle.spawns.<row>.<layer>, a list of group
  // ids. Repeats are allowed - listing a group twice doubles its odds.
  function slotPath(row, layer) { return `battle.spawns.${row}.${layer}`; }
  function addToSlot(row, layer, gid) {
    const path = slotPath(row, layer);
    setPath(config, path, [...(getPath(config, path) ?? []), gid]);
    commitColl(path);
    render();
  }
  function dropFromSlot(row, layer, gid) {
    const path = slotPath(row, layer);
    const list = getPath(config, path) ?? [];
    const at = list.indexOf(gid);
    setPath(config, path, at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)]);
    commitColl(path);
    render();
  }
  function wireBattlesBlock() {
    bodyEl.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const [row, layer] = btn.dataset.pick.split('|');
      openGroupPicker(btn, row, Number(layer));
    }));
    bodyEl.querySelectorAll('[data-drop]').forEach((btn) => btn.addEventListener('click', () => {
      const [row, layer, gid] = btn.dataset.drop.split('|');
      dropFromSlot(row, Number(layer), gid);
    }));
  }

  // ----- the Units tab's event wiring --------------------------------------
  function wireUnitsTab() {
    bodyEl.querySelectorAll('[data-coll]').forEach((el) => {
      el.addEventListener('change', () => {
        const { coll, row, field, kind } = el.dataset;
        const c = getPath(config, coll);
        if (field === '__id') {
          // Renaming an id: rebuild the object so the row keeps its place in the
          // table instead of jumping to the end.
          const next = String(el.value).trim();
          if (!next || next === row || next in c) { render(); return; }
          const rebuilt = {};
          for (const [k, v] of Object.entries(c)) rebuilt[k === row ? next : k] = v;
          setPath(config, coll, rebuilt);
        } else {
          const rec = Array.isArray(c) ? c[Number(row)] : c[row];
          if (!rec) return;
          rec[field] = readCellValue(el, kind);
        }
        commitColl(coll);
        render();
      });
    });
    bodyEl.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const coll = btn.dataset.del;
        const c = getPath(config, coll);
        if (btn.dataset.list === '1') c.splice(Number(btn.dataset.row), 1);
        else {
          delete c[btn.dataset.row];
          // Remember that this one was deleted ON PURPOSE, so reloading does not
          // bring it back with the rest of today's defaults.
          if (getPath(defaults, `${coll}.${btn.dataset.row}`) !== undefined) {
            removed[coll] = [...new Set([...(removed[coll] ?? []), btn.dataset.row])];
          }
        }
        commitColl(coll);
        render();
      });
    });
    bodyEl.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const coll = btn.dataset.add;
        const c = getPath(config, coll);
        if (Array.isArray(c)) c.push(NEW_ROSTER());
        else {
          const make = coll === 'battle.enemyGroups' ? NEW_GROUP : NEW_ENEMY;
          c[freshId(c, coll === 'battle.enemyGroups' ? 'group' : 'enemy')] = make();
        }
        commitColl(coll);
        render();
      });
    });
    bodyEl.querySelectorAll('[data-pool]').forEach((box) => {
      box.addEventListener('change', () => {
        const path = box.dataset.pool;
        const list = getPath(config, path) ?? [];
        const id = box.dataset.item;
        const next = box.checked ? [...new Set([...list, id])] : list.filter((x) => x !== id);
        setPath(config, path, next);
        commitColl(path);
        render();
      });
    });
  }
  function readCellValue(el, kind) {
    if (kind === 'bool') return el.checked;
    if (kind === 'number') return Number(el.value);
    if (kind === 'color') return readColor(el);
    if (kind === 'idlist') return el.value.split(',').map((s) => s.trim()).filter(Boolean);
    return el.value;
  }
  // "enemy1", "enemy2", ... - the first name not already taken.
  function freshId(obj, stem) {
    let n = 1;
    while (`${stem}${n}` in obj) n += 1;
    return `${stem}${n}`;
  }
  // Whole-collection override: an add or a delete is a change to the collection,
  // not to one value, so the collection is what gets stored.
  function commitColl(path) {
    setOverride(path, deepClone(getPath(config, path)));
    onChange(path);
  }

  // Records an override - or REMOVES it when the value has come back to what the
  // config file says. Without this an edit-and-undo left a dead entry behind
  // that still counted as a change everywhere it was looked at.
  function setOverride(path, value) {
    // A tombstone for an id that is present again is stale.
    if (removed[path]?.length && value && typeof value === 'object') {
      removed[path] = removed[path].filter((id) => !(id in value));
      if (!removed[path].length) delete removed[path];
    }
    if (deepEqual(value, getPath(defaults, path)) && !removed[path]?.length) delete overrides[path];
    else overrides[path] = value;
    saveOverrides();
  }

  function renderGroup(title, obj, def, path) {
    const rows = [];
    for (const [key, value] of Object.entries(obj)) {
      if (SKIP_KEYS.has(key)) continue;
      const p = `${path}.${key}`;
      const d = def?.[key];
      if (Array.isArray(value)) {
        if (value.every((v) => typeof v !== 'object')) rows.push(renderRow(key, p, value, d, 'list'));
        else value.forEach((item, i) => rows.push(renderGroup(`${key} ${i + 1}`, item, d?.[i], `${p}.${i}`)));
      } else if (value && typeof value === 'object') {
        // A NESTED group of look-alike records (encounters > visuals: a colour
        // per encounter kind) becomes a small table rather than a stack of
        // boxes. Eleven boxes holding one row each were the tallest thing on
        // the Encounters tab by a wide margin, and a column of a multi-column
        // flow can never be shorter than its tallest unbreakable item.
        rows.push(looksLikeRecords(value) ? renderMatrix(key, value, d, p) : renderGroup(key, value, d, p));
      } else {
        rows.push(renderRow(key, p, value, d, kindOf(key, value, p)));
      }
    }
    return `<div class="settings-group"><div class="settings-group-title">${title}</div>${rows.join('')}</div>`;
  }

  // Is this object a set of records that would read better as a table? Three or
  // more sub-objects, only scalars inside them, and few enough distinct
  // attributes that the table stays narrow. Arrays disqualify it: a matrix cell
  // has no list editor and would save the array back as a string.
  function looksLikeRecords(obj) {
    const vals = Object.values(obj);
    if (vals.length < 3) return false;
    if (!vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return false;
    const keys = new Set();
    const own = [];
    for (const v of vals) {
      let n = 0;
      for (const [k, x] of Object.entries(v)) {
        if (SKIP_KEYS.has(k)) continue;
        if (x !== null && typeof x === 'object') return false;   // nested deeper, or an array
        keys.add(k);
        n += 1;
      }
      own.push(n);
    }
    if (keys.size === 0 || keys.size > 4) return false;
    // And they must really share those attributes. stasis > debuffs looks like
    // records but each one has a different single key, so the table would be
    // three rows of one value and six dashes - worse than the boxes it replaced.
    return own.every((n) => n >= keys.size / 2);
  }

  // One table for a section of uniform records: rows = entries (tile types /
  // biomes), columns = the union of their attributes, so the attribute names are
  // written once in the header instead of repeating in every group.
  function renderMatrix(title, obj, def, path) {
    const rowNames = Object.keys(obj);
    const cols = [];
    for (const rn of rowNames) {
      for (const k of Object.keys(obj[rn])) if (!SKIP_KEYS.has(k) && !cols.includes(k)) cols.push(k);
    }
    const head = `<tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`;
    // Hovering a status names its KNOBS in order - the list an ability's buffX
    // lines up with (config/abilities.js). Editing the row can change that list,
    // so it is worked out here rather than written down anywhere.
    const rowTip = (rn) => (path === 'statuses'
      ? `${path}.${rn}  |  buffX: [${statusKnobs(obj[rn]).join(', ') || 'nothing to set'}]`
      : `${path}.${rn}`);
    const body = rowNames.map((rn) => {
      const cells = cols.map((c) => {
        const value = obj[rn][c];
        const d = def?.[rn]?.[c];
        // An attribute this entry does not have (e.g. hpCost on a plain biome)
        // stays an empty cell rather than inventing a value.
        if (value === undefined && d === undefined) return '<td class="settings-empty">-</td>';
        return `<td>${renderCell(`${path}.${rn}.${c}`, c, value, d)}</td>`;
      }).join('');
      return `<tr><th title="${escapeAttr(rowTip(rn))}">${rn}</th>${cells}</tr>`;
    }).join('');
    // A table with many attributes needs one more grid track than a narrow one,
    // so it does not end up scrolling sideways inside its own box (style.css).
    const wide = cols.length >= 7 ? ' wide' : '';
    return `<div class="settings-group settings-matrix${wide}"><div class="settings-group-title">${title}</div>
      <div class="settings-matrix-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
  }

  // A compact table cell: the control plus a reset button that CSS shows only
  // while the value differs from the config file.
  function renderCell(path, key, value, def) {
    const kind = kindOf(key, value ?? def, path);
    let control;
    if (path.startsWith('tags.') && TAG_HOOKS.has(key)) {
      const opts = ['', ...Object.keys(ABILITIES)];
      control = `<select data-path="${path}" data-kind="text">${opts.map((o) => `<option value="${escapeAttr(o)}"${String(value ?? '') === o ? ' selected' : ''}>${o || '-'}</option>`).join('')}</select>`;
    }
    else if (kind === 'bool') control = `<input type="checkbox" data-path="${path}" data-kind="bool" ${value ? 'checked' : ''}>`;
    else if (kind === 'color') control = `<input type="color" data-path="${path}" data-kind="color"${colorShapeAttr(value)} value="${cssColor(value)}">`;
    else if (kind === 'number') control = `<input type="number" step="any" data-path="${path}" data-kind="number" value="${value ?? ''}">`;
    else control = `<input type="text" data-path="${path}" data-kind="text" value="${escapeAttr(String(value ?? ''))}">`;
    const changed = isChanged(path);
    const defText = def === undefined ? '' : kind === 'color' ? cssColor(def) : String(def);
    return `<span class="settings-cell ${changed ? 'changed' : ''}" title="${path}">
      ${control}<button class="small cell-reset" data-reset="${path}" title="${escapeAttr(t('settings.reset.title', { value: defText }))}">&#8634;</button></span>`;
  }

  // Is this path actually different from the config FILE? `path in overrides`
  // is not enough: an override is also written when a value is typed back to
  // its default, and the reset button is only meaningful when there is
  // something to undo. (2026-09-06: every row was showing "reset" and pressing
  // it did nothing, because the button was drawn unconditionally.)
  function isChanged(path) {
    if (!(path in overrides)) return false;
    // Deep and order-insensitive: JSON.stringify called two identical objects
    // different whenever a saved collection listed its keys in another order.
    return !deepEqual(getPath(config, path), getPath(defaults, path));
  }

  function kindOf(key, value, path) {
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return 'color';
    if (typeof value === 'number') {
      // "color", the per-layer biome palette ("color0".."color6"), anything
      // ending in "Color" (groundColor, cloudColor...), and the whole colors
      // section get a colour picker instead of a raw number.
      const isColor = key === 'color' || /^color\d+$/.test(key) || /Color$/.test(key) || (path.startsWith('colors.') && !/tint|height/i.test(key));
      return isColor ? 'color' : 'number';
    }
    return 'text';
  }

  function renderRow(label, path, value, def, kind) {
    const changed = isChanged(path);
    let control;
    if (kind === 'bool') control = `<input type="checkbox" data-path="${path}" data-kind="bool" ${value ? 'checked' : ''}>`;
    else if (kind === 'color') control = `<input type="color" data-path="${path}" data-kind="color"${colorShapeAttr(value)} value="${cssColor(value)}">`;
    else if (kind === 'number') control = `<input type="number" step="any" data-path="${path}" data-kind="number" value="${value}">`;
    else if (kind === 'list') control = `<input type="text" data-path="${path}" data-kind="list" value="${escapeAttr(value.join(', '))}" title="${t('settings.list.title')}">`;
    else control = `<input type="text" data-path="${path}" data-kind="text" value="${escapeAttr(String(value))}">`;
    const defText = def === undefined ? '' : Array.isArray(def) ? def.join(', ') : kind === 'color' ? `#${Number(def).toString(16).padStart(6, '0')}` : String(def);
    return `<div class="settings-row ${changed ? 'changed' : ''}">
      <span class="settings-label" title="${path}">${label}</span>
      ${control}
      <button class="small settings-reset" data-reset="${path}" title="${escapeAttr(t('settings.reset.title', { value: defText }))}">${t('settings.reset')}</button>
    </div>`;
  }

  function readInput(input) {
    const k = input.dataset.kind;
    if (k === 'bool') return input.checked;
    if (k === 'number') return Number(input.value);
    if (k === 'color') return readColor(input);
    if (k === 'list') return input.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s));
    return input.value;
  }

  // Reflect, do not assume: typing a value back to the config file's own leaves
  // nothing to reset, so the row must lose the mark rather than keep it.
  function markRow(input) {
    const on = isChanged(input.dataset.path);
    input.closest('.settings-row')?.classList.toggle('changed', on);
    input.closest('.settings-cell')?.classList.toggle('changed', on);
  }

  // ----- overrides ---------------------------------------------------------
  function resetPath(path) {
    delete removed[path];
    delete overrides[path];
    setPath(config, path, deepClone(getPath(defaults, path)));
    saveOverrides();
  }
  // The store holds two things: the overridden VALUES, and, per editable
  // collection, the ids the player explicitly DELETED. Older saves are a flat
  // map of values, which loads as v2 with no deletions.
  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw && raw.v === 2) return { overrides: raw.overrides ?? {}, removed: raw.removed ?? {} };
      return { overrides: raw ?? {}, removed: {} };
    } catch { return { overrides: {}, removed: {} }; }
  }
  function saveOverrides() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, overrides, removed })); } catch { /* private mode etc. */ }
  }

  return { open, close, isOpen, refresh, hasOverrides: () => Object.keys(overrides).length > 0 };
}

// Merges a SAVED value over today's default so a snapshot taken against an older
// config shape still arrives complete. Lists of records match up by `name` (the
// roster), then by position; tables of records match by key (the bestiary, the
// groups). Anything the save does not contain keeps the default's value; anything
// it does contain wins, and a record the save dropped stays dropped.
function healOverride(def, saved, removedIds) {
  const isRecord = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(saved)) {
    if (!Array.isArray(def)) return saved;
    return saved.map((row, i) => {
      if (!isRecord(row)) return row;
      const from = def.find((d) => isRecord(d) && d.name !== undefined && d.name === row.name) ?? def[i];
      return isRecord(from) ? { ...from, ...row } : row;
    });
  }
  if (isRecord(saved) && isRecord(def)) {
    // Start from TODAY's defaults, so a creature the config file gained since
    // the save appears instead of silently staying deleted. Until 2026-09-08
    // the merge started from the save, which meant "absent from the save" was
    // read as "deleted" - so one visit to the bestiary froze it forever, and
    // every creature added afterwards was reported by Copy changes as a
    // deletion the player never made.
    const gone = new Set(removedIds ?? []);
    const out = {};
    for (const [k, v] of Object.entries(def)) if (!gone.has(k)) out[k] = v;
    for (const [k, v] of Object.entries(saved)) {
      out[k] = isRecord(v) && isRecord(def[k]) ? { ...def[k], ...v } : v;
    }
    return out;
  }
  return saved;
}

// ----- comparing a saved value with the config file --------------------------
// Order-insensitive on purpose. A stored collection lists its keys in whatever
// order it was written in, and JSON.stringify compares key ORDER as well as
// content, so two identical bestiaries could read as different.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// Every LEAF under `path` whose live value differs from the config file, as
// [path, value, def]. Objects are walked; an array is walked element by element
// only when both sides are the same length - once an entry has been added or
// removed the indices no longer line up, and reporting the list as one value is
// the honest answer.
function diffLeaves(path, value, def, out = []) {
  const bothPlain = value && def && typeof value === 'object' && typeof def === 'object'
    && !Array.isArray(value) && !Array.isArray(def);
  const bothSameLenArray = Array.isArray(value) && Array.isArray(def) && value.length === def.length;
  if (bothPlain) {
    for (const k of new Set([...Object.keys(def), ...Object.keys(value)])) {
      diffLeaves(`${path}.${k}`, value[k], def[k], out);
    }
  } else if (bothSameLenArray) {
    value.forEach((v, i) => diffLeaves(`${path}.${i}`, v, def[i], out));
  } else if (!deepEqual(value, def)) {
    out.push([path, value, def]);
  }
  return out;
}

// ----- path helpers ---------------------------------------------------------
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}
export function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Clipboard write with a fallback for contexts without the async clipboard API
// (e.g. plain-http hosts).
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
