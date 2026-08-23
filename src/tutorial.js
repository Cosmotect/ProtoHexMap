// New player experience (NPE): a guided first run on a fixed map.
// The HUD starts empty and pieces appear as they become relevant; short cards
// explain each mechanic the first time it matters. While a card is open (or a piece is
// still gliding into place) all input is blocked except the menu. Ends when the first
// Stasis Colony falls (or the run ends), after which the run continues as a normal one.
//
// Every word comes from the locale tables (npe.*) and every number from the config (text.js).

import { tc, tallTerrainSentence, firstRiskyStep, encounterLabel, encounterInfo } from './text.js';
import { t, joinList } from './i18n.js';

export const NPE_SEED = 6;   // fixed seed: every new player sees the same map (chosen for a battle, event, treasure and shop close to the start)

const ARRIVE_MS = 1500;      // a revealed HUD piece glides from the screen centre to its place in this time (and shrinks from 2x)

// HUD pieces, in the order they get revealed.
const PIECES = {
  statusbar: '#statusbar',
  party: '#party',
  log: '.bottom-left',
  legend: '.bottom-right',
};
// (The menu is never hidden: it is the one control that always answers, but cards may point at it.)
const TARGETS = { ...PIECES, menu: '#menu-wrap' };

// Card targets: a HUD piece name, { el: cssSelector }, { tile: hexKey } (green ring on the
// tile, line to its top) or { marker: hexKey } (green outline behind the 3D shape).
export function createTutorial({ config, ui, renderer }) {
  const state = { active: false, seen: new Set(), queue: [], showing: false, finishAfter: false, moving: 0, current: null };
  const $ = (sel) => document.querySelector(sel);
  const card = $('#tutorial');
  const titleEl = $('#tutorial-title');
  const bodyEl = $('#tutorial-body');
  const blocker = $('#input-block');
  const lines = $('#tutorial-lines');
  let currentTarget = null;   // what the open card talks about (a green line points at it)
  let onIdle = null;          // main.js hook: called whenever no card is waiting any more

  $('#btn-tutorial-ok').addEventListener('click', next);
  // "Go" is only shown on choice cards (e.g. climbing a mountain): it runs the card's
  // onGo instead of its onDone, then moves on.
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

  function targetElement(t) {
    if (!t) return null;
    const sel = typeof t === 'string' ? TARGETS[t] : t.el;
    return sel ? $(sel) : null;
  }
  // Green outline on the element (or 3D object) the open card points at.
  function setTarget(t) {
    const prev = targetElement(currentTarget);
    if (prev) prev.classList.remove('npe-target', 'npe-target-flash');
    currentTarget = t;
    const el = targetElement(t);
    if (el) el.classList.add('npe-target');
    renderer.setHighlight(t && t.marker ? { hexKey: t.marker } : t && t.tile ? { tile: t.tile } : null);
  }

  function updateBlocker() {
    blocker.classList.toggle('hidden', !isBlocking());
  }

  function hideAll() {
    for (const sel of Object.values(PIECES)) $(sel)?.classList.add('npe-hidden');
  }

  // Shows a piece: it spawns at the screen centre and glides to its real position.
  function reveal(piece) {
    const el = $(PIECES[piece]);
    if (!el || !el.classList.contains('npe-hidden')) return;
    el.classList.remove('npe-hidden');
    const r = el.getBoundingClientRect();
    const dx = window.innerWidth / 2 - (r.left + r.width / 2);
    const dy = window.innerHeight / 2 - (r.top + r.height / 2);
    el.style.translate = `${dx}px ${dy}px`;
    el.style.scale = '2';
    void el.offsetWidth; // commit the start position before the transition begins
    el.classList.add('npe-arrive');
    el.style.translate = '0px 0px';
    el.style.scale = '1';
    state.moving += 1;
    updateBlocker();
    setTimeout(() => {
      el.classList.remove('npe-arrive');
      el.style.translate = '';
      el.style.scale = '';
      state.moving = Math.max(0, state.moving - 1);
      updateBlocker();
    }, ARRIVE_MS);
  }

  // ----- green line from the card to the piece it talks about -------------------
  function drawLine() {
    if (!state.showing || !currentTarget) { lines.innerHTML = ''; return; }
    const a = card.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let end = null;
    const t = currentTarget;
    if (t.tile) end = renderer.tileTopScreen(t.tile);
    else if (t.marker) end = renderer.markerScreen(t.marker);
    else {
      const el = targetElement(t);
      if (el && !el.classList.contains('npe-hidden') && !el.classList.contains('hidden')) {
        const b = el.getBoundingClientRect();
        if (b.width > 0) end = edgePoint(b, ax, ay);
      }
    }
    if (!end) { lines.innerHTML = ''; return; }
    const start = edgePoint(a, end.x, end.y);
    lines.innerHTML = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}"></line><circle cx="${end.x}" cy="${end.y}" r="4"></circle>`;
  }
  // Where a line from the rectangle's centre towards (tx, ty) leaves the rectangle.
  function edgePoint(r, tx, ty) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = dx !== 0 ? (r.width / 2) / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? (r.height / 2) / Math.abs(dy) : Infinity;
    const t = Math.min(sx, sy);
    return { x: cx + dx * t, y: cy + dy * t };
  }
  (function tick() { drawLine(); requestAnimationFrame(tick); })();

  function revealAll() {
    for (const sel of Object.values(PIECES)) {
      const el = $(sel);
      if (el) { el.classList.remove('npe-hidden', 'npe-arrive'); el.style.translate = ''; }
    }
  }

  // Cards are queued so they never stack: the next one waits for "Got it".
  // say(key, localeKey, params, opts): title/text come from <localeKey>.title / .text,
  // filled with the config placeholders plus params. sayRaw takes ready-made strings.
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
      if (state.finishAfter) finish('complete');
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

  function start() {
    state.active = true;
    state.seen.clear();
    state.queue.length = 0;
    state.showing = false;
    state.finishAfter = false;
    state.moving = 0;
    hideAll();
    say('welcome', 'npe.welcome', {}, { target: { tile: '0,0' } });
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
    state.moving = 0;
    setTarget(null);
    card.classList.add('hidden');
    revealAll();
    updateBlocker();
    if (reason === 'skipped') ui.showBanner(t('banner.skipped'), 1400);
    if (onIdle) onIdle();
  }

  // Called for every game event from main.js.
  function onEvent(type, payload, game) {
    if (!state.active) return;
    const s = game.state;

    if (type === 'move') {
      const turn = s.turn;
      if (turn === 1) say('fog', 'npe.fog', { tall: tallTerrainSentence(config) }, { target: { tile: '-1,2' } });
      if (turn === 2) say('party', 'npe.party', {}, { target: 'party', onShow: () => reveal('party') });
      if (turn === 3) {
        const risky = firstRiskyStep(config);
        const forceable = joinList(config.fatigue.forceable.map((k) => `<b>${encounterLabel(k).toLowerCase()}</b>`), 'or');
        say('fatigue', 'npe.fatigue',
          { from: risky ? t('npe.fatigue.fromStep', { n: risky }) : t('npe.fatigue.soon'), forceable },
          { target: { el: '#stat-fatigue' }, onShow: () => reveal('statusbar') });
      }
      if (s.fatigue > 0) {
        // The guide keeps the restoration place vague on purpose, so it is left out of this list.
        const resets = Object.entries(config.fatigue.resetOn)
          .filter(([k, r]) => r === 'always' && k !== 'acolyte')
          .map(([k]) => (k === 'camp' ? t('reset.camp') : encounterLabel(k).toLowerCase()));
        say('tired', 'npe.tired', { fatigue: s.fatigue, resets: joinList(resets) }, { target: { el: '#stat-fatigue' } });
      }
    }

    // Arriving on an encounter tile for the first time: the encounter card comes BEFORE
    // anything the tile does (a fatigue roll, a forced fight), so the game holds the
    // arrival until the card is acknowledged.
    if (type === 'arrive' && payload.hex.encounter && !state.seen.has('encounters')) {
      payload.hold = true;
      say('encounters', 'npe.encounters', {},
        { target: { marker: payload.hex.key }, onShow: () => reveal('statusbar'), onDone: () => game.resumeArrival() });
    }

    if (type === 'change' && s.status === 'playing' && !s.position.encounter && s.turn >= 6) {
      say('camp', 'npe.camp', {}, { target: { el: '#stat-supplies' }, onShow: () => reveal('statusbar') });
    }

    if (type === 'forced') {
      say('forced', 'npe.forced', {}, { target: { el: '#dialog' } });
    }

    if (type === 'dialog') {
      const k = payload.kind;
      const kind =
        k === 'battle' ? (payload.intro ? 'event' : payload.result?.seedFight ? 'stasisSeed' : payload.result?.colonyFight ? 'stasisColony' : 'battle') :
        k === 'shop' ? 'shop' :
        k === 'acolyte' ? 'acolyte' :
        k === 'supplies' ? (payload.titleKey === 'treasure.title' ? 'treasure' : 'event') :
        'event';
      sayRaw(`enc:${kind}`, encounterLabel(kind), `<p>${encounterInfo(kind, config)}</p>`, { target: { el: '#dialog' }, onShow: () => reveal('log') });
      if (k === 'battle') say('battle-report', 'npe.report', {}, { target: { el: '#dialog' }, onShow: () => reveal('legend') });
    }

    if (type === 'camp') {
      say('camped', 'npe.rested', {}, { target: { el: '#stat-fatigue' } });
    }

    if (type === 'encounter' && payload.type === 'stasisColony' && s.lastBattle?.won) {
      say('colonydown', 'npe.stasis', {}, { target: 'legend', onShow: () => { revealAll(); state.finishAfter = true; } });
    }

    if (type === 'end') {
      if (s.status === 'lost') {
        // One last card, then everything comes back and the end screen follows.
        say('dead', 'npe.dead', {}, { target: 'party', onShow: () => { revealAll(); state.finishAfter = true; } });
      } else {
        finish('end');
      }
    }
  }

  function setOnIdle(fn) { onIdle = fn; }

  // Called by main.js before a move. Returns true when the guide takes over the click:
  // the first step onto costly terrain (a mountain) gets a card with "climb" / "stay".
  function interceptMove(hex, game) {
    if (!state.active || state.showing) return false;
    const tr = config.terrain[hex.terrain];
    if (!tr || (!(tr.supplyCost > 0) && !(tr.hpCost > 0))) return false;
    const key = `climb:${hex.terrain}`;
    if (state.seen.has(key)) return false;
    say(key, 'npe.climb', {
      terrain: t(`terrain.${hex.terrain}`).toLowerCase(),
      supplies: tr.supplyCost, hp: tr.hpCost, bonus: tr.revealBonus, height: tr.terrainHeight,
    }, {
      target: { tile: hex.key },
      choice: { go: t('npe.climb.go'), stay: t('npe.climb.stay'), onGo: () => game.moveTo(hex) },
    });
    return true;
  }

  // True while a card waits for "Got it" or a HUD piece is still gliding into place:
  // the world, the Enter button and the keyboard ignore input, the menu does not.
  function isBlocking() { return state.active && (state.showing || state.moving > 0); }

  return { start, finish, onEvent, interceptMove, isActive: () => state.active, isBlocking, setOnIdle };
}
