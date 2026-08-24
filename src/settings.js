// Runtime settings window: every value from the config files, editable in the app.
// Changes are written straight into CONFIG (so the rest of the game reads them as
// usual), saved in the browser (localStorage) and re-applied on the next load, which
// means they take precedence over the config files. Each row has a reset button that
// puts the file value back; each tab has "Reset tab".
//
// Nothing here knows what a setting means: the form is generated from the shape of
// the config objects (numbers, booleans, strings, colours, lists, nested groups).

import { t, LANGUAGES, getLanguage, setLanguage } from './i18n.js';

const STORAGE_KEY = 'hexmap-settings-v1';

// Which config sections live on which tab (mirrors the config files). Labels and
// notes come from the locale tables (settings.tab.<id>, settings.note.<id>).
const TABS = [
  { id: 'world', sections: ['map', 'noise', 'tileTypes', 'biomes'] },
  { id: 'encounters', sections: ['encounters', 'stasis', 'rest', 'acolyte', 'shop', 'treasure', 'events', 'fatigue'] },
  { id: 'units', sections: ['party', 'battle'] },
  { id: 'general', sections: ['run', 'camera', 'anim', 'colors'] },
];

// Keys that are not meant to be edited by hand (visual placeholders, long texts).
const SKIP_KEYS = new Set(['shape', 'info', 'flavour', 'names', 'icon']);

export function createSettings({ config, defaults, onChange, onToggleCamera, getCameraMode, getUiScale, onSetUiScale, onClose }) {
  const $ = (id) => document.getElementById(id);
  const win = $('settings');
  const tabsEl = $('settings-tabs');
  const bodyEl = $('settings-body');
  let activeTab = TABS[0].id;
  let overrides = loadOverrides();

  // ----- apply saved overrides on startup ------------------------------
  for (const [path, value] of Object.entries(overrides)) setPath(config, path, value);

  $('btn-settings-close').addEventListener('click', close);
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
      parts.push(`<div class="settings-group"><div class="settings-group-title">${t('settings.camera.group')}</div>
        <div class="settings-row"><span class="settings-label">${t('settings.camera.current')}</span>
        <button id="btn-settings-camera">${t(getCameraMode() === 'perspective' ? 'settings.camera.perspective' : 'settings.camera.topdown')}</button>
        <span class="settings-reset"></span></div></div>`);
      // UI scale: a browser preference (like the language), not part of CONFIG.
      const scales = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
      const current = getUiScale ? getUiScale() : 1;
      const scaleOptions = scales.map((s) => `<option value="${s}" ${Math.abs(s - current) < 0.01 ? 'selected' : ''}>${Math.round(s * 100)}%</option>`).join('');
      parts.push(`<div class="settings-group"><div class="settings-group-title">${t('settings.uiscale.group')}</div>
        <div class="settings-row"><span class="settings-label">${t('settings.uiscale')}</span>
        <select id="settings-uiscale">${scaleOptions}</select><span class="settings-reset"></span></div></div>`);
    }
    for (const section of tab.sections) {
      parts.push(renderGroup(section, config[section], defaults[section], section));
    }
    bodyEl.innerHTML = parts.join('');
    bodyEl.querySelector('#btn-settings-camera')?.addEventListener('click', () => { onToggleCamera(); render(); });
    bodyEl.querySelector('#settings-language')?.addEventListener('change', (e) => { setLanguage(e.target.value); render(); });
    bodyEl.querySelector('#settings-uiscale')?.addEventListener('change', (e) => { if (onSetUiScale) onSetUiScale(Number(e.target.value)); });
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

  function kindOf(key, value, path) {
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'number') {
      const isColor = key === 'color' || (path.startsWith('colors.') && !/tint|height/i.test(key));
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
