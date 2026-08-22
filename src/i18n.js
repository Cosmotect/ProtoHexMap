// Localisation. Every user-facing string lives in src/locales/<code>.js as a flat table
// of key -> text. Code never contains English sentences; it asks t('key', params).
//
// Placeholders: {name} is replaced by params.name.
// Plurals: {n:one|other} (English) or {n:one|few|many} (Russian) picks the form for
// params.n using the locale's plural rule, e.g. "{n} {n:tile|tiles}".
// Missing keys fall back to English, then to the key itself (so gaps are visible).

import { en } from './locales/en.js';
import { ru } from './locales/ru.js';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
];

const TABLES = { en, ru };
const STORAGE_KEY = 'hexmap-lang';

// Plural rules: return the index of the form to use.
const PLURAL_RULES = {
  en: (n) => (n === 1 ? 0 : 1),
  ru: (n) => {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return 2;
    if (b === 1) return 0;
    if (b >= 2 && b <= 4) return 1;
    return 2;
  },
};

let current = 'en';
const listeners = [];

export function getLanguage() { return current; }

export function setLanguage(code) {
  if (!TABLES[code]) code = 'en';
  current = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* private mode etc. */ }
  document.documentElement.lang = code;
  for (const cb of listeners) cb(code);
}

export function onLanguageChange(cb) { listeners.push(cb); }

// Restores the saved language (called once at startup).
export function initLanguage() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  current = TABLES[saved] ? saved : 'en';
  document.documentElement.lang = current;
}

export function hasKey(key) {
  return key in TABLES[current] || key in TABLES.en;
}

// Translate a key with optional parameters.
export function t(key, params = {}) {
  const raw = TABLES[current][key] ?? TABLES.en[key];
  if (raw === undefined) return key;
  return format(raw, params);
}

// Names of units, enemies and bosses: translated when a "name.<Name>" key exists.
export function tn(name) {
  const key = `name.${name}`;
  return hasKey(key) ? t(key) : name;
}

// Joins a list with the locale's "and"/"or".
export function joinList(items, word = 'and') {
  if (items.length <= 1) return items.join('');
  const conj = t(`list.${word}`);
  return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`;
}

function format(raw, params) {
  const rule = PLURAL_RULES[current] || PLURAL_RULES.en;
  return String(raw).replace(/\{(\w+)(?::([^}]*))?\}/g, (m, name, forms) => {
    const value = params[name];
    if (forms !== undefined) {
      const list = forms.split('|');
      const n = Number(value ?? 0);
      return list[Math.min(rule(n), list.length - 1)];
    }
    return value === undefined ? m : String(value);
  });
}

// Fills data-i18n / data-i18n-title / data-i18n-placeholder attributes in the page.
export function applyStaticTexts(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}
