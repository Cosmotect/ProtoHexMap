// The tutorial guide: short hint cards over the hand-authored scenario maps
// (src/scenarios/). The maps themselves do the teaching - a card only points.
//
// Each scenario lists its cards as { id, at, ... } triggers; onEvent matches
// them against the game events main.js forwards here (plus 'combatStart',
// which main.js sends when the battle engine takes over). Texts live in the
// locale tables as scenario.<mapId>.card.<cardId>.title / .text, filled with
// the config placeholders (text.js). While a card is open all input is
// blocked except the menu; Skip hides the rest of the map's cards.
//
// (The old seeded "new player experience" that guided a full random run lived
// here until the scenario maps replaced it.)

import { tc } from './text.js';
import { t } from './i18n.js';
import { uiScale } from './ui.js';

// Card targets: { el: cssSelector } (green outline on a HUD piece),
// { tile: hexKey } (green ring on a world tile) or { marker: hexKey } (green
// outline behind an encounter's 3D shape). A green dashed line runs from the
// card to whichever it is.
export function createTutorial({ config, ui, renderer }) {
  const state = { active: false, scenario: null, seen: new Set(), queue: [], showing: false, current: null };
  const $ = (sel) => document.querySelector(sel);
  const card = $('#tutorial');
  const titleEl = $('#tutorial-title');
  const bodyEl = $('#tutorial-body');
  const blocker = $('#input-block');
  const lines = $('#tutorial-lines');
  let currentTarget = null;   // what the open card talks about (a green line points at it)
  let onIdle = null;          // main.js hook: called whenever no card is waiting any more

  $('#btn-tutorial-ok').addEventListener('click', next);
  // "Go" is only shown on choice cards: it runs the card's onGo instead of its
  // onDone, then moves on. (No scenario card uses it yet; the mechanism stays.)
  $('#btn-tutorial-go').addEventListener('click', () => {
    const go = state.current?.onGo;
    if (state.current) state.current.onDone = null;
    next();
    if (go) go();
  });
  $('#btn-tutorial-skip').addEventListener('click', () => finish('skipped'));
  // Clicking the world while a card waits flashes the card (same as encounter windows).
  blocker.addEventListener('pointerdown', () => { if (state.showing) flash(); });

  function flash() {
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
    const el = targetElement(currentTarget);
    if (el) { el.classList.remove('npe-target-flash'); void el.offsetWidth; el.classList.add('npe-target-flash'); }
    if (currentTarget && (currentTarget.tile || currentTarget.marker)) renderer.flashHighlight();
  }

  function targetElement(t2) {
    return t2 && t2.el ? $(t2.el) : null;
  }
  // Green outline on the element (or 3D object) the open card points at.
  function setTarget(t2) {
    const prev = targetElement(currentTarget);
    if (prev) prev.classList.remove('npe-target', 'npe-target-flash');
    currentTarget = t2;
    const el = targetElement(t2);
    if (el) el.classList.add('npe-target');
    renderer.setHighlight(t2 && t2.marker ? { hexKey: t2.marker } : t2 && t2.tile ? { tile: t2.tile } : null);
  }

  function updateBlocker() {
    blocker.classList.toggle('hidden', !isBlocking());
  }

  // ----- green line from the card to the piece it talks about -------------------
  function drawLine() {
    if (!state.showing || !currentTarget) { lines.innerHTML = ''; return; }
    const a = card.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let end = null;
    const t2 = currentTarget;
    if (t2.tile) end = renderer.tileTopScreen(t2.tile);
    else if (t2.marker) end = renderer.markerScreen(t2.marker);
    else {
      const el = targetElement(t2);
      if (el && !el.classList.contains('hidden')) {
        const b = el.getBoundingClientRect();
        if (b.width > 0) end = edgePoint(b, ax, ay);
      }
    }
    if (!end) { lines.innerHTML = ''; return; }
    const start = edgePoint(a, end.x, end.y);
    // getBoundingClientRect and the 3D projections give viewport coordinates; the
    // svg lives inside the zoomed HUD, so divide by the UI scale.
    const z = uiScale();
    lines.innerHTML = `<line x1="${start.x / z}" y1="${start.y / z}" x2="${end.x / z}" y2="${end.y / z}"></line><circle cx="${end.x / z}" cy="${end.y / z}" r="4"></circle>`;
  }
  // Where a line from the rectangle's centre towards (tx, ty) leaves the rectangle.
  function edgePoint(r, tx, ty) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = dx !== 0 ? (r.width / 2) / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? (r.height / 2) / Math.abs(dy) : Infinity;
    const t2 = Math.min(sx, sy);
    return { x: cx + dx * t2, y: cy + dy * t2 };
  }
  (function tick() { drawLine(); requestAnimationFrame(tick); })();

  // Cards are queued so they never stack: the next one waits for "Got it".
  // say(key, localeKey, params, opts): title/text come from <localeKey>.title / .text,
  // filled with the config placeholders plus params.
  // opts.target: what the card refers to (green line); opts.onDone runs after "Got it".
  function say(key, localeKey, params, opts) {
    sayRaw(key, tc(`${localeKey}.title`, config, params), tc(`${localeKey}.text`, config, params), opts);
  }
  // choice: { go: label, stay: label, onGo } turns the card into a two-way question.
  function sayRaw(key, title, html, { target = null, onShow = null, onDone = null, choice = null } = {}) {
    if (!state.active || state.seen.has(key)) return;
    state.seen.add(key);
    state.queue.push({ title, html, target, onShow, onDone, onGo: choice?.onGo ?? null, choice });
    if (!state.showing) next();
  }
  function next() {
    const done = state.current?.onDone;
    state.current = null;
    if (done) done();
    const item = state.queue.shift();
    if (!item) {
      state.showing = false;
      setTarget(null);
      card.classList.add('hidden');
      if (onIdle) onIdle();
      updateBlocker();
      return;
    }
    state.showing = true;
    state.current = item;
    if (item.onShow) item.onShow();
    setTarget(typeof item.target === 'function' ? item.target() : item.target);
    titleEl.textContent = item.title;
    bodyEl.innerHTML = item.html;
    const goBtn = $('#btn-tutorial-go'), okBtn = $('#btn-tutorial-ok');
    goBtn.classList.toggle('hidden', !item.choice);
    goBtn.textContent = item.choice?.go ?? '';
    okBtn.textContent = item.choice?.stay ?? t('npe.ok');
    card.classList.remove('hidden');
    updateBlocker();
  }

  // ----- scenario cards ------------------------------------------------------
  function startScenario(scenario) {
    state.active = true;
    state.scenario = scenario;
    // The card header names the map.
    const kicker = $('#tutorial .tutorial-kicker');
    if (kicker) kicker.textContent = t(`scenario.${scenario.id}.name`);
    state.seen.clear();
    state.queue.length = 0;
    state.showing = false;
    for (const c of scenario.cards ?? []) if (c.at === 'start') showScenarioCard(c);
  }

  function showScenarioCard(c, opts = {}) {
    say(`sc:${c.id}`, `scenario.${state.scenario.id}.card.${c.id}`, {}, { target: c.target ?? null, ...opts });
  }

  function finish(reason) {
    if (!state.active) return;
    // Never leave the game waiting on a card that will not be answered.
    const done = state.current?.onDone;
    state.current = null;
    if (done) done();
    state.active = false;
    state.queue.length = 0;
    state.showing = false;
    setTarget(null);
    card.classList.add('hidden');
    updateBlocker();
    if (reason === 'skipped') ui.showBanner(t('banner.skipped'), 1400);
    if (onIdle) onIdle();
  }

  // Called for every game event from main.js (plus 'combatStart' from the
  // combat bridge): matches the scenario's card triggers.
  function onEvent(type, payload, game) {
    if (!state.active) return;
    for (const c of state.scenario?.cards ?? []) {
      if (state.seen.has(`sc:${c.id}`)) continue;
      if (c.at === 'arrive') {
        if (type !== 'arrive' || payload.hex?.key !== c.tile) continue;
        // A holding card pauses everything the tile would do until "Got it".
        if (c.hold) { payload.hold = true; showScenarioCard(c, { onDone: () => game.resumeArrival() }); continue; }
      } else if (c.at === 'encounter') {
        if (type !== 'encounter' || payload.type !== c.encounterType) continue;
      } else if (c.at !== type) continue;
      showScenarioCard(c);
    }
    if (type === 'end') finish('end');
  }

  function setOnIdle(fn) { onIdle = fn; }

  // True while a card waits for "Got it": the world, the Enter button and the
  // keyboard ignore input, the menu does not.
  function isBlocking() { return state.active && state.showing; }

  return { startScenario, finish, onEvent, isActive: () => state.active, isBlocking, setOnIdle };
}
