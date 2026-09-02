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
import { ABILITIES } from './config/abilities.js';

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
  { key: 'power', kind: 'number', w: 48 },
  { key: 'init', kind: 'number', w: 44 },
  { key: 'speed', kind: 'number', w: 44 },
  { key: 'flying', kind: 'bool' },
  { key: 'abilities', kind: 'idlist', w: 130, valid: () => Object.keys(ABILITIES) },
];
// A brand new creature: deliberately weak and plain, so an unfinished row that
// finds its way into a fight cannot wreck a run.
const NEW_ENEMY = () => ({ name: 'New enemy', shape: 'octahedron', color: 0xe2474b, hp: 10, power: 2, init: 5, speed: 4, flying: false, abilities: ['strike'] });
const NEW_GROUP = () => ({ title: 'New group', units: [] });
const NEW_ROSTER = () => ({ name: 'New character', icon: '🙂', hp: 24 });
const ROSTER_COLS = [
  { key: 'name', kind: 'text', w: 118 },
  { key: 'icon', kind: 'text', w: 44 },
  { key: 'hp', kind: 'number', w: 48 },
];
// Keys of `battle` the hand-built editors own; the leftovers render as an
// ordinary group of numbers so nothing silently disappears from the tab.
const BATTLE_OWNED = new Set(['enemyTypes', 'enemyGroups', 'enemies', 'bosses', 'colonies']);

// Which config sections live on which tab (mirrors the config files). Labels and
// notes come from the locale tables (settings.tab.<id>, settings.note.<id>).
const TABS = [
  { id: 'world', sections: ['map', 'worldBackground', 'localBackground', 'noise', 'tileTypes', 'biomes'] },
  { id: 'encounters', sections: ['encounters', 'stasis', 'rest', 'acolyte', 'shop', 'treasure', 'events', 'fatigue'] },
  { id: 'units', sections: ['party', 'battle'] },
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
const MATRIX_SECTIONS = new Set(['tileTypes', 'biomes']);

export function createSettings({ config, defaults, onChange, getUiScale, onSetUiScale, getShowLog, onSetShowLog, onClose }) {
  const $ = (id) => document.getElementById(id);
  const win = $('settings');
  const tabsEl = $('settings-tabs');
  const bodyEl = $('settings-body');
  let activeTab = TABS[0].id;
  let overrides = loadOverrides();

  // ----- apply saved overrides on startup ------------------------------
  for (const [path, value] of Object.entries(overrides)) setPath(config, path, value);

  $('btn-settings-close').addEventListener('click', close);
  // "Copy changes": every property that differs from the config-file default goes
  // to the clipboard as "path = value (default: ...)" lines - handy for pasting
  // into a chat or a note when a tuning session found keeper values.
  $('btn-settings-copy').addEventListener('click', async () => {
    const btn = $('btn-settings-copy');
    const lines = [];
    for (const path of Object.keys(overrides).sort()) {
      const value = overrides[path];
      const def = getPath(defaults, path);
      if (JSON.stringify(value) === JSON.stringify(def)) continue; // typed back to the default
      lines.push(`${path} = ${fmtValue(path, value)}  (default: ${fmtValue(path, def)})`);
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
    // The Units tab stores whole collections (the bestiary, the groups), so a
    // value can be an object; print it as JSON rather than "[object Object]".
    if (value && typeof value === 'object') return JSON.stringify(value);
    const key = path.split('.').pop();
    if (kindOf(key, value, path) === 'color') return `#${Number(value).toString(16).padStart(6, '0')}`;
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
  function close() { win.classList.add('hidden'); if (onClose) onClose(); }
  function isOpen() { return !win.classList.contains('hidden'); }

  // ----- rendering ---------------------------------------------------------
  function render() {
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
    if (tab.id === 'units') parts.push(...renderUnitsTab());
    else for (const section of tab.sections) {
      parts.push(MATRIX_SECTIONS.has(section)
        ? renderMatrix(section, config[section], defaults[section], section)
        : renderGroup(section, config[section], defaults[section], section));
    }
    bodyEl.innerHTML = parts.join('');
    // Tabs with a table switch from the multi-column flow to a grid, where the
    // table can be told to occupy several columns and still sit beside the
    // ordinary groups instead of below them (style.css).
    bodyEl.classList.toggle('has-matrix', tab.id === 'units' || tab.sections.some((s) => MATRIX_SECTIONS.has(s)));
    if (tab.id === 'units') wireUnitsTab();
    bodyEl.querySelector('#settings-language')?.addEventListener('change', (e) => { setLanguage(e.target.value); render(); });
    bodyEl.querySelector('#settings-uiscale')?.addEventListener('change', (e) => { if (onSetUiScale) onSetUiScale(Number(e.target.value)); });
    bodyEl.querySelector('#settings-showlog')?.addEventListener('change', (e) => { if (onSetShowLog) onSetShowLog(e.target.checked); });
    bodyEl.querySelectorAll('[data-path]').forEach((input) => {
      input.addEventListener('change', () => {
        const path = input.dataset.path;
        const value = readInput(input);
        setPath(config, path, value);
        overrides[path] = value;
        saveOverrides();
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
  function renderUnitsTab() {
    const b = config.battle;
    const groupIds = Object.keys(b.enemyGroups ?? {});
    const out = [];

    // The party: everything except the roster stays an ordinary group, and the
    // roster becomes a table with the same add / delete row as the bestiary.
    const partyScalars = {};
    for (const [k, v] of Object.entries(config.party)) if (k !== 'roster') partyScalars[k] = v;
    out.push(renderGroup('party', partyScalars, defaults.party, 'party'));
    out.push(recordTable({
      title: t('settings.units.roster'), coll: 'party.roster', obj: config.party.roster,
      cols: ROSTER_COLS, addLabel: t('settings.units.addChar'), rowLabel: t('settings.units.character'),
      note: t('settings.units.roster.note'), list: true,
    }));

    // The bestiary: one row per creature, everything about it on that row.
    out.push(recordTable({
      title: t('settings.units.bestiary'), coll: 'battle.enemyTypes', obj: b.enemyTypes,
      cols: BESTIARY_COLS, addLabel: t('settings.units.addEnemy'), rowLabel: t('settings.units.id'),
      note: t('settings.units.bestiary.note'), wide: true,
    }));

    // The groups: a title and a line-up of bestiary ids.
    out.push(groupsTable(b));

    // The pools: which groups a regular fight (by ring band), a Colony or the
    // Seed may roll.
    out.push(poolsBlock(b, groupIds));

    // Whatever else lives under `battle` (the damage curve, the danger bands,
    // the simulation numbers) keeps the plain generated form.
    const rest = {};
    for (const [k, v] of Object.entries(b)) if (!BATTLE_OWNED.has(k)) rest[k] = v;
    out.push(renderGroup('battle', rest, defaults.battle, 'battle'));
    return out;
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
    if (col.kind === 'color') return `<input type="color" ${a} value="#${Number(value ?? 0).toString(16).padStart(6, '0')}">`;
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
    if (!(coll in overrides)) return '';
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

  // Which groups each pool may roll: one checkbox per group, per pool. A band
  // also carries the ring it reaches out to.
  function poolsBlock(b, groupIds) {
    const rows = [];
    for (const [bandId, band] of Object.entries(b.enemies.bands ?? {})) {
      rows.push(poolRow(t('settings.units.band', { name: bandId }), `battle.enemies.bands.${bandId}.groups`, band.groups ?? [], groupIds,
        `<span class="pool-ring">maxRing ${renderCell(`battle.enemies.bands.${bandId}.maxRing`, 'maxRing', band.maxRing, defaults.battle?.enemies?.bands?.[bandId]?.maxRing)}</span>`));
    }
    rows.push(poolRow(t('settings.units.seedPool'), 'battle.bosses', b.bosses ?? [], groupIds, ''));
    rows.push(poolRow(t('settings.units.colonyPool'), 'battle.colonies', b.colonies ?? [], groupIds, ''));
    return `<div class="settings-group settings-pools wide">
      <div class="settings-group-title">${t('settings.units.pools')}</div>
      <p class="muted rt-note">${escapeAttr(t('settings.units.pools.note'))}</p>
      ${rows.join('')}
    </div>`;
  }
  function poolRow(label, path, chosen, groupIds, extra) {
    const boxes = groupIds.map((gid) => `<label class="pool-chip ${chosen.includes(gid) ? 'on' : ''}">
      <input type="checkbox" data-pool="${path}" data-item="${gid}" ${chosen.includes(gid) ? 'checked' : ''}>${gid}</label>`).join('');
    return `<div class="pool-row"><div class="pool-head">${escapeAttr(label)}${extra}</div><div class="pool-chips">${boxes}</div></div>`;
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
        else delete c[btn.dataset.row];
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
    if (kind === 'color') return parseInt(el.value.slice(1), 16);
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
    overrides[path] = deepClone(getPath(config, path));
    saveOverrides();
    onChange(path);
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
        rows.push(renderGroup(key, value, d, p));
      } else {
        rows.push(renderRow(key, p, value, d, kindOf(key, value, p)));
      }
    }
    return `<div class="settings-group"><div class="settings-group-title">${title}</div>${rows.join('')}</div>`;
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
    const body = rowNames.map((rn) => {
      const cells = cols.map((c) => {
        const value = obj[rn][c];
        const d = def?.[rn]?.[c];
        // An attribute this entry does not have (e.g. hpCost on a plain biome)
        // stays an empty cell rather than inventing a value.
        if (value === undefined && d === undefined) return '<td class="settings-empty">-</td>';
        return `<td>${renderCell(`${path}.${rn}.${c}`, c, value, d)}</td>`;
      }).join('');
      return `<tr><th title="${path}.${rn}">${rn}</th>${cells}</tr>`;
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
    if (kind === 'bool') control = `<input type="checkbox" data-path="${path}" data-kind="bool" ${value ? 'checked' : ''}>`;
    else if (kind === 'color') control = `<input type="color" data-path="${path}" data-kind="color" value="#${Number(value ?? 0).toString(16).padStart(6, '0')}">`;
    else if (kind === 'number') control = `<input type="number" step="any" data-path="${path}" data-kind="number" value="${value ?? ''}">`;
    else control = `<input type="text" data-path="${path}" data-kind="text" value="${escapeAttr(String(value ?? ''))}">`;
    const changed = path in overrides;
    const defText = def === undefined ? '' : kind === 'color' ? `#${Number(def).toString(16).padStart(6, '0')}` : String(def);
    return `<span class="settings-cell ${changed ? 'changed' : ''}" title="${path}">
      ${control}<button class="small cell-reset" data-reset="${path}" title="${escapeAttr(t('settings.reset.title', { value: defText }))}">&#8634;</button></span>`;
  }

  function kindOf(key, value, path) {
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'number') {
      // "color", the per-layer biome palette ("color0".."color8"), anything
      // ending in "Color" (groundColor, cloudColor...), and the whole colors
      // section get a colour picker instead of a raw number.
      const isColor = key === 'color' || /^color\d+$/.test(key) || /Color$/.test(key) || (path.startsWith('colors.') && !/tint|height/i.test(key));
      return isColor ? 'color' : 'number';
    }
    return 'text';
  }

  function renderRow(label, path, value, def, kind) {
    const changed = path in overrides;
    let control;
    if (kind === 'bool') control = `<input type="checkbox" data-path="${path}" data-kind="bool" ${value ? 'checked' : ''}>`;
    else if (kind === 'color') control = `<input type="color" data-path="${path}" data-kind="color" value="#${Number(value).toString(16).padStart(6, '0')}">`;
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
    if (k === 'color') return parseInt(input.value.slice(1), 16);
    if (k === 'list') return input.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s));
    return input.value;
  }

  function markRow(input) {
    input.closest('.settings-row')?.classList.add('changed');
    input.closest('.settings-cell')?.classList.add('changed');
  }

  // ----- overrides ---------------------------------------------------------
  function resetPath(path) {
    delete overrides[path];
    setPath(config, path, deepClone(getPath(defaults, path)));
    saveOverrides();
  }
  function loadOverrides() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
  }
  function saveOverrides() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch { /* private mode etc. */ }
  }

  return { open, close, isOpen, refresh, hasOverrides: () => Object.keys(overrides).length > 0 };
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
