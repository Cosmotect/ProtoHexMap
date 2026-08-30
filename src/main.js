// Entry point: glues together the rules (Game), the picture (MapRenderer) and the HUD (ui).
import './style.css';
import { CONFIG } from './config.js';
import { Game } from './game.js';
import { MapRenderer } from './render.js';
import { createUI } from './ui.js';
import { resolveSeed } from './rng.js';
import { createTutorial } from './tutorial.js';
import { scenarioById } from './scenarios/index.js';
import { createSettings, deepClone } from './settings.js';
import { createCombatCinematic } from './local/transition.js';
import { createBattle } from './local/battle/engine.js';
import { COMBAT_CONFIG } from './config/abilities.js';
import { resolvedAbilitiesFor, availableUpgrades } from './upgrades.js';
import { t, tn, initLanguage, applyStaticTexts, onLanguageChange } from './i18n.js';
import { tc } from './text.js';
import { initAudio } from './audio.js';

initLanguage();
applyStaticTexts();
// Sound (the fatigue bar's blips). Stays silent until the player's first click:
// browsers do not let a page make noise before that.
initAudio(CONFIG);

// ----- UI scale (Settings > General) --------------------------------------
// A browser preference like the language: stored in localStorage, applied as a
// CSS variable that zooms the HUD (#hud in style.css). The inverse variable lets
// the near-fullscreen settings window opt out.
const UI_SCALE_KEY = 'hexmap-ui-scale';
function applyUiScale(v) {
  const scale = Math.min(2, Math.max(0.5, Number(v) || 1));
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  document.documentElement.style.setProperty('--ui-scale-inv', String(1 / scale));
  try { localStorage.setItem(UI_SCALE_KEY, String(scale)); } catch { /* private mode etc. */ }
  return scale;
}
function loadUiScale() {
  try { return Number(localStorage.getItem(UI_SCALE_KEY)) || 1; } catch { return 1; }
}
applyUiScale(loadUiScale());

// ----- the event log (Settings > General) ---------------------------------
// The log is a debugging / design aid rather than something the player needs,
// so it is OFF by default. Like the UI scale it is a browser preference, not a
// config value: it changes nothing about the game, only what is on screen.
const SHOW_LOG_KEY = 'hexmap-show-log';
function applyShowLog(v) {
  const on = !!v;
  document.getElementById('log-panel')?.classList.toggle('hidden', !on);
  try { localStorage.setItem(SHOW_LOG_KEY, on ? '1' : '0'); } catch { /* private mode etc. */ }
  return on;
}
function loadShowLog() {
  try { return localStorage.getItem(SHOW_LOG_KEY) === '1'; } catch { return false; }
}
applyShowLog(loadShowLog());

const container = document.getElementById('scene');

// URL switches, handy for comparing variants without editing config.js:
//   ?seed=1234        same map every time
//   ?orient=pointy    pointy-top world hexes instead of the default flat-top
const params = new URLSearchParams(window.location.search);
if (params.get('orient') === 'flat' || params.get('orient') === 'pointy') CONFIG.map.orientation = params.get('orient');

// The config files are the defaults; settings saved in the browser are applied on top
// (createSettings does that immediately), so they take precedence.
const DEFAULTS = deepClone(CONFIG);
let renderer = null;
let ui = null;
const settings = createSettings({
  config: CONFIG,
  defaults: DEFAULTS,
  getUiScale: loadUiScale,
  onSetUiScale: (v) => applyUiScale(v),
  getShowLog: loadShowLog,
  onSetShowLog: (v) => applyShowLog(v),
  onChange: (path) => {
    ui.buildLegend();
    // The bar's shape comes from the fatigue table and its look from fatigueBar,
    // so both need a rebuild rather than a refresh.
    if (typeof path !== 'string' || path === '*' || path.startsWith('fatigue.') || path.startsWith('fatigueBar.')) ui.buildFatigueBar();
    // The sky, the fog and the void floor can change without rebuilding the map.
    if (typeof path !== 'string' || path === '*' || path.startsWith('worldBackground.')) renderer.applyBackground();
    if (game) ui.update(game);
  },
  onClose: () => ui.updateBlur(),
});
// A language change re-renders everything that shows text.
onLanguageChange(() => { applyStaticTexts(); ui.buildLegend(); ui.buildFatigueBar(); if (game) { ui.update(game); ui.renderLog(game); } });

renderer = new MapRenderer(container, CONFIG);
window.__renderer = renderer; // for debugging / automated tests
let game = null;
let pendingEnd = false;
let holdDialogsUntil = 0;

// ----- the local map + the dive into it (src/local/) -----------------------
// Combat encounters (battle, Stasis Seed, Stasis Colony) play out on a LOCAL
// map: pressing Enter dives the camera into the tile through the clouds, the
// world scene swaps for the arena mid-flight, the fight resolves there, and
// closing the results window flies the camera back out.
const cinematic = createCombatCinematic({
  renderer, config: CONFIG, container,
  // body.local-mode is "we're showing the arena, not the world map" - true for
  // the campfire start screen and for every kind of local-map encounter, not
  // just interactive battles (those layer body.battle-mode on top of this).
  // The world-map-only HUD (fatigue bar, party panel) hides on it; see style.css.
  onModeChange: (isLocal) => document.body.classList.toggle('local-mode', isLocal),
});
window.__cinematic = cinematic; // for debugging / automated tests
const COMBAT_TYPES = new Set(['battle', 'stasisSeed', 'stasisColony']);

// ----- the start flow -------------------------------------------------------
// The game boots straight into the local map of the starting tile: the party
// sits around a campfire (the "start screen"), masked by the black Everlands
// splash while everything loads. The player can swap party members through the
// roster grid; "Begin journey" (in the Enter button's slot) flies the camera out
// to the world map and the run officially begins.
let startScreen = false;

function initSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  // Test / guide / scenario entrances skip the ceremony.
  if (params.get('nostart') || params.get('scenario')) { el.remove(); return; }
  setTimeout(() => {
    el.style.transitionDuration = `${CONFIG.start.splashFadeMs}ms`;
    el.classList.add('fade');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), CONFIG.start.splashFadeMs + 500); // fallback
  }, CONFIG.start.splashMs);
}

function enterStartScreen() {
  startScreen = true;
  cinematic.startScreen({
    worldHex: game.map.start,
    baseColor: renderer.targetColorFor(game.map.start).getHex(),
    party: game.state.party,
    seed: game.seed,
    neighbors: worldNeighborsFor(game.map.start),
  });
  const open = (i) => openRosterFor(i);
  cinematic.localView.enablePicking(open);
  ui.setStartScreen(true, { onUnitClick: open });
  ui.update(game);
}

function openRosterFor(slotIndex) {
  if (!startScreen || ui.rosterOpen()) return;
  ui.openRoster({
    slotIndex,
    party: game.state.party,
    roster: CONFIG.party.roster ?? [],
    onPick: (def) => {
      game.setPartyUnit(slotIndex, def);
      cinematic.localView.refreshParty(game.state.party);
    },
  });
}

function beginJourney() {
  if (!startScreen) return;
  startScreen = false;
  cinematic.localView.disablePicking();   // no more roster clicks while we climb
  // The roster panel and the "Begin journey" button turn back into the world
  // map's HUD at the peak of the clouds, not the moment the button is pressed.
  cinematic.flyOut({ onDone: () => { ui.setStartScreen(false); ui.update(game); } });
}

// ----- interactive combat (src/local/battle/) --------------------------------
// game.startCombat prepares the fight (enemies, Stasis debuffs) and hands the
// context here; the engine plays it out on the arena and reports the outcome
// back through game.finishCombat. The world map never sees the middle part.
let battle = null;      // the running combat engine, if any
let battleCtx = null;   // the context game.prepareCombat handed over

// The world tiles around `hex` (three rings of them), for the arena's backdrop
// and edge-colour pull: world-plane offset, ring, final rendered colour and the
// TYPE's visual height. Hidden tiles report the fog height and fog colour, so
// the backdrop never leaks unexplored terrain. Ether neighbours and the map
// edge stay holes - the void shows through.
const BACKDROP_RINGS = 3;
function worldNeighborsFor(hex) {
  const out = [];
  const R = BACKDROP_RINGS;
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) {
      const ring = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
      if (ring < 1) continue;
      const nb = game.map.hexes.get(`${hex.q + dq},${hex.r + dr}`);
      if (!nb || nb.type === 'ether') continue;
      out.push({
        dx: nb.x - hex.x,
        dy: nb.y - hex.y,
        ring,
        color: renderer.targetColorFor(nb).getHex(),
        height: nb.revealed ? (CONFIG.tileTypes[nb.type]?.height ?? 0.3) : CONFIG.colors.fogTileHeight,
      });
    }
  }
  return out;
}

// Wounds appear in the party panel AS they happen, not only after the fight.
// (Deaths are only made official in finishCombat; here it is just the HP.)
function syncPartyPanel() {
  if (!battle) return;
  let changed = false;
  for (const u of battle.state.units) {
    if (u.partyIndex == null) continue;
    const p = game.state.party[u.partyIndex];
    if (p && p.hp !== u.hp) { p.hp = u.hp; changed = true; }
  }
  if (changed) ui.update(game);
}

function beginInteractiveBattle(ctx) {
  const view = cinematic.localView;
  // Plain copies: the engine keeps its own instances; wounds are written back at
  // the end. A party unit fights with its RESOLVED abilities - the base defs
  // plus every upgrade tree node it has unlocked (src/upgrades.js).
  const partyDefs = game.state.party
    .map((u, i) => ({ name: u.name, icon: u.icon, hp: u.hp, maxHp: u.maxHp, partyIndex: i, alive: u.alive, abilityDefs: resolvedAbilitiesFor(u) }))
    .filter((u) => u.alive && u.hp > 0);
  // shape and colour ride along from the bestiary entry (src/battle.js) so the
  // arena can build the right body for each enemy.
  const enemyDefs = ctx.enemies.map((e) => ({
    name: e.name, hp: e.hp, maxHp: e.maxHp, power: e.power,
    shape: e.shape, color: e.color, typeId: e.typeId,
  }));
  const placement = view.beginBattle({ party: partyDefs, enemies: enemyDefs });
  battleCtx = ctx;
  battle = createBattle({
    config: COMBAT_CONFIG,
    radius: CONFIG.local.radius,
    heights: placement.heights,
    party: partyDefs,
    enemies: enemyDefs,
    partyKeys: placement.partyKeys,
    enemyKeys: placement.enemyKeys,
    forced: ctx.forced,
    partyDamageMod: ctx.damageMod ?? 0,   // the Stasis "damage" debuff
    // Built now (at the peak of the transition, so the HUD is already the
    // battle's when the clouds part) but a fatigue ambush does not swing until
    // battle.start() - otherwise its opening blow lands behind the clouds.
    deferOpening: true,
    onChange: () => { view.syncBattle(); ui.updateBattle(); syncPartyPanel(); },
    onFloater: (k, text, color) => view.addFloater(k, text, color),
    onLog: () => {},   // the floaters carry the story; a combat log can come later
    onAnim: (anim, done) => view.runMoveAnim(anim, done),
    // A beat after the last hit, so the killing blow is seen before the report.
    onEnd: (won) => setTimeout(() => finishInteractiveBattle(won), 900),
  });
  window.__battle = battle;   // for debugging / automated tests
  view.bindBattle(battle);
  ui.setBattleMode(battle);
  // The guide may have a card for the first fight (scenario maps).
  tutorial.onEvent('combatStart', {}, game);
}

function finishInteractiveBattle(won) {
  if (!battle || !battleCtx) return;
  const ctx = battleCtx;
  const b = battle;
  battle = null; battleCtx = null; window.__battle = null;
  // Wounds (and deaths) carry back to the world-map party.
  for (const u of b.state.units) {
    if (u.partyIndex == null) continue;
    const p = game.state.party[u.partyIndex];
    if (p) p.hp = u.hp;
  }
  ui.setBattleMode(null);
  cinematic.localView.endBattle();
  game.finishCombat(ctx, { won, rounds: b.state.round, interactive: true });
}

// Restart / new map while a fight is open: drop the engine, the new Game
// object discards the battle state anyway.
function abortBattle() {
  battle = null; battleCtx = null; window.__battle = null;
  ui.setBattleMode(null);
}

// Starts the dive. The work is split across the two moments the cinematic
// offers: `onSwap` at the peak of the clouds (everything that changes state or
// the HUD, so nothing is seen switching) and `onArrived` when the camera lands
// (handing control to the player).
function startCombatDive(hex, resume) {
  const enemies = (hex.enemies ?? []).map((e) => ({ ...e }));
  let turnBack = false;
  return cinematic.flyIn({
    worldHex: hex,
    baseColor: renderer.targetColorFor(hex).getHex(),
    party: game.livingUnits(),
    enemies,
    seed: game.seed,
    recipe: hex.recipe ?? null,   // future: handcrafted arena recipes live on the hex
    neighbors: worldNeighborsFor(hex),
    onSwap: () => {
      // The wither may have eaten the encounter while we were in the air.
      if (COMBAT_TYPES.has(hex.encounter)) resume();
      else turnBack = true;
    },
    onArrived: () => {
      if (turnBack) cinematic.flyOut({});
      else if (battle) battle.start();
    },
  });
}

ui = createUI(CONFIG, {
  isInputBlocked: () => tutorial.isBlocking(),
  isSubWindowOpen: () => settings.isOpen(),
  onOpenSettings: () => { settings.open(); ui.updateBlur(); },
  onEscape: () => { if (settings.isOpen()) { settings.close(); ui.updateBlur(); } },
  onDialogClosed: () => {
    const finishEnd = () => { if (pendingEnd && game.state.status !== 'playing' && !tutorial.isBlocking()) { pendingEnd = false; ui.showEnd(game); } };
    // The results window just closed inside the arena: fly back out first.
    // (Not on the start screen - there the arena stays until Begin journey.)
    if (cinematic.isActive() && !startScreen && !ui.dialogOpen()) { cinematic.flyOut({ onDone: finishEnd }); return; }
    finishEnd();
  },
  onNewMap: () => startRun(resolveSeed()),   // "New map" always leaves scenario mode
  onRestart: () => startRun(game.seed, { scenario: activeScenario }),
  // The menu's Tutorial button: the first unfinished map of the chain.
  onStartTutorial: () => startRun(1, { scenario: firstUnfinishedTutorial() }),
  // The end overlay's "Next map" button (only offered after a scenario win).
  onNextScenario: () => {
    const nx = activeScenario?.next ? scenarioById(activeScenario.next) : null;
    if (nx) startRun(1, { scenario: nx });
  },
  scenarioNextLabel: () => (
    game && game.state.status === 'won' && activeScenario?.next && scenarioById(activeScenario.next)
      ? t('end.nextMap') : null),
  onRevealAll: () => game.revealAll(),
  // Debug: instantly win the fight running on the local map (does nothing outside one).
  onWinBattle: () => { if (battle) battle.debugResolve(true); },
  onEnter: () => {
    if (startScreen) {
      if (!ui.rosterOpen() && !settings.isOpen()) beginJourney();
      return;
    }
    if (renderer.busy || ui.dialogOpen() || tutorial.isBlocking() || cinematic.isActive()) return;
    const action = game.enterAction();
    if (action.kind === 'encounter' && COMBAT_TYPES.has(action.type)) {
      startCombatDive(game.state.position, () => game.enter(false));
      return;
    }
    game.enter(false);
  },
  onLoadSeed: (value) => startRun(resolveSeed(value)),
});
const tutorial = createTutorial({ config: CONFIG, ui, renderer });
// The end screen waits for the guide's last card.
tutorial.setOnIdle(() => { if (pendingEnd && game && game.state.status !== 'playing' && !ui.dialogOpen()) { pendingEnd = false; ui.showEnd(game); } });

// ----- tutorial progression --------------------------------------------------
// Which tutorial maps this browser has completed (a preference, like the UI
// scale - not part of any run's state). The menu's Tutorial button opens the
// first unfinished map of the chain; finishing a map stores it here.
const TUTORIAL_KEY = 'hexmap-tutorial-progress';
function tutorialProgress() {
  try { return JSON.parse(localStorage.getItem(TUTORIAL_KEY)) ?? {}; } catch { return {}; }
}
function markTutorialDone(id) {
  try { localStorage.setItem(TUTORIAL_KEY, JSON.stringify({ ...tutorialProgress(), [id]: true })); } catch { /* private mode etc. */ }
}
// Walks the chain from the first map; a fully completed chain starts over.
function firstUnfinishedTutorial() {
  const done = tutorialProgress();
  let s = scenarioById('tutorial1');
  const visited = new Set();
  while (s && done[s.id] && s.next && !visited.has(s.id)) {
    visited.add(s.id);
    s = scenarioById(s.next);
  }
  return s ?? scenarioById('tutorial1');
}

// ----- scenario mode (src/scenarios/): hand-authored maps, the tutorial -----
// A scenario's configPatch temporarily rewrites CONFIG values for its run (a
// tighter fatigue table, say). The old values come back when a run without
// that patch starts, and the config-driven HUD pieces rebuild both ways.
let activeScenario = null;
let scenarioPatched = null;   // [{ obj, key, old }] to undo
function applyScenarioPatch(scenario) {
  if (scenarioPatched) { for (const p of scenarioPatched) p.obj[p.key] = p.old; scenarioPatched = null; }
  if (scenario?.configPatch) {
    scenarioPatched = [];
    for (const [path, value] of Object.entries(scenario.configPatch)) {
      const parts = path.split('.');
      let obj = CONFIG;
      for (let i = 0; i < parts.length - 1 && obj; i++) obj = obj[parts[i]];
      if (!obj) continue;
      const key = parts[parts.length - 1];
      scenarioPatched.push({ obj, key, old: obj[key] });
      obj[key] = value;
    }
  }
  ui.buildFatigueBar();
  ui.buildLegend();
}

function startRun(seed, opts = {}) {
  pendingEnd = false;
  startScreen = false;
  ui.setStartScreen(false);
  abortBattle();
  cinematic.abort();
  ui.closeDialog();
  tutorial.finish('restart');
  activeScenario = opts.scenario ?? null;
  applyScenarioPatch(activeScenario);
  game = new Game(CONFIG, seed, activeScenario);
  window.game = game; // handy for poking at the state in the browser console
  // Forced fights (fatigue) take the same dive as the Enter button.
  game.combatIntro = (hex, resume) => (cinematic.isActive() ? false : startCombatDive(hex, resume));
  // Fights are played out on the local map. Camera already down in the arena:
  // start straight away. Not there yet (the Nomads event): dive first. Anything
  // in between should not happen; refusing makes the fight auto-resolve safely.
  game.combatDelegate = (ctx) => {
    if (battle) return false;
    // The arena is on screen, or the dive has passed its swap point and is
    // committed to it: build the fight now. If the camera has already landed
    // there is nothing left to wait for, so it opens immediately; mid-flight it
    // waits for onArrived (see startCombatDive).
    if (cinematic.inArena()) {
      beginInteractiveBattle(ctx);
      if (cinematic.mode() === 'local') battle?.start();
      return true;
    }
    if (cinematic.isActive()) return false;
    return cinematic.flyIn({
      worldHex: ctx.hex,
      baseColor: renderer.targetColorFor(ctx.hex).getHex(),
      party: game.livingUnits(),
      enemies: ctx.enemies.map((e) => ({ ...e })),
      seed: game.seed,
      recipe: ctx.hex.recipe ?? null,
      neighbors: worldNeighborsFor(ctx.hex),
      // Same split: the fight is built under the clouds, and swings on landing.
      onSwap: () => beginInteractiveBattle(ctx),
      onArrived: () => { if (battle) battle.start(); },
    });
  };

  // Keep the seed (and the scenario, when one is running) in the address bar
  // so the link can be shared.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(seed));
    if (activeScenario) url.searchParams.set('scenario', activeScenario.id);
    else url.searchParams.delete('scenario');
    window.history.replaceState(null, '', url.toString());
  } catch {
    // Some embedded viewers do not allow changing the address bar. Not a problem.
  }

  game.on((type, payload) => {
    if (type === 'reveal') { renderer.handleReveal(payload.hexes, game.state.position); renderer.rebuildStasisLines(game); }
    if (type === 'move') renderer.handleMove(payload.from, payload.to);
    if (type === 'encounter') renderer.handleEncounterCleared(payload.hex);
    if (type === 'colony') renderer.handleColonySpawn(payload.hex);
    if (type === 'wither') renderer.handleWither(payload.hexes);
    if (type === 'stasis') renderer.rebuildStasisLines(game);
    if (type === 'forced') {
      // Banner first; any dialog that follows waits forcedBannerMs.
      ui.showBanner(t('banner.forced', { label: payload.label }), CONFIG.anim.forcedBannerMs + 900);
      holdDialogsUntil = performance.now() + CONFIG.anim.forcedBannerMs;
    }
    if (type === 'dialog') showDialog(payload);
    if (type === 'change') { renderer.syncState(); ui.update(game); }
    tutorial.onEvent(type, payload, game);
    if (type === 'log') ui.renderLog(game);
    if (type === 'end') {
      // Winning a tutorial map is remembered (the menu's Tutorial button then
      // opens the next unfinished one).
      if (activeScenario && game.state.status === 'won') markTutorialDone(activeScenario.id);
      const thisGame = game;
      // Let the hop finish before the overlay appears (and ignore it if a new run started meanwhile).
      // If a battle report / event is open, the end screen waits until it is closed.
      setTimeout(() => {
        if (thisGame !== game || game.state.status === 'playing') return;
        if (ui.dialogOpen() || tutorial.isBlocking() || cinematic.isActive()) pendingEnd = true; else ui.showEnd(game);
      }, CONFIG.anim.hopMs + 250);
    }
  });

  renderer.loadGame(game);
  ui.hideEnd();
  ui.update(game);
  ui.renderLog(game);
  // A scenario drops straight onto its map (no campfire, no roster - the real
  // run teaches those) and brings its own short hint cards.
  if (activeScenario) { if (activeScenario.cards?.length) tutorial.startScenario(activeScenario); }
  else if (!params.get('nostart')) enterStartScreen();
}

// ----- encounter dialogs (top centre) -----------------------------------
// The upgrade reward chooser: one RANDOM available upgrade per living unit is
// offered (game.upgradeOffers()); the player unlocks exactly one of them.
// `left` picks run back to back; onDone runs after the last (or a skip).
function askUpgradePick(left, onDone) {
  const offers = game.upgradeOffers();
  if (!offers.length) { onDone(); return; }
  ui.chooseUpgrade({
    game,
    offers,
    left,
    onPick: (offer) => {
      game.applyUpgradePick(offer);
      if (left > 1) askUpgradePick(left - 1, onDone); else onDone();
    },
    onSkip: onDone,
  });
}

function showDialog(d) {
  const wait = holdDialogsUntil - performance.now();
  if (wait > 0) { setTimeout(() => showDialog(d), wait); return; }
  if (d.kind === 'event') {
    ui.openDialog({
      title: d.title,
      html: `<p>${escapeHtml(d.text)}</p><div class="effect">${escapeHtml(d.effect || '')}</div>`,
      actions: [{ label: t('dialog.continue'), onClick: () => ui.closeDialog() }],
    });
  } else if (d.kind === 'supplies') {
    // Supplies found. If they overflow, offer to make camp first (QoL).
    const actions = [];
    if (d.canCamp) {
      actions.push({
        label: t('dialog.campFirst', { cost: d.campCost }),
        sub: t('dialog.campFirst.sub', { fit: Math.min(d.amount, d.amount - d.overflow + d.campCost), amount: d.amount, partial: d.amount - d.overflow }),
        onClick: () => { game.claimSupplies(true); ui.closeDialog(); },
      });
    }
    const partial = d.overflow > 0;
    const collect = () => { game.claimSupplies(false); ui.closeDialog(); };
    actions.push({
      label: partial ? t('dialog.collect.partial', { got: d.amount - d.overflow, amount: d.amount }) : t('dialog.collect', { n: d.amount }),
      sub: partial ? t('dialog.collect.lost', { n: d.overflow }) : '',
      onClick: () => {
        // Leaving supplies behind while a camp could save them: double check.
        if (partial && d.canCamp) ui.confirm({ title: t('confirm.leaveSupplies.title'), text: t('confirm.leaveSupplies.text', { lost: d.overflow, amount: d.amount }), onYes: collect });
        else collect();
      },
    });
    ui.openDialog({
      title: d.title,
      html: `<p>${escapeHtml(d.text)}</p>${d.lore ? `<p class="flavour">${escapeHtml(t(d.lore))}</p>` : ''}<div class="effect">${escapeHtml(d.effect)}</div>`,
      actions,
    });
  } else if (d.kind === 'blackmarket') {
    ui.chooseUnit({
      title: d.title,
      html: `<p>${escapeHtml(d.text)}</p><div class="effect">${escapeHtml(d.effect)}</div>`,
      filter: (u) => u.alive && availableUpgrades(u).length > 0,
      game,
      onPick: (i) => { game.blackMarketDeal(i); ui.closeDialog(); },
      extraActions: [{ label: t('dialog.decline'), sub: t('dialog.decline.sub'), onClick: () => ui.confirm({ title: t('confirm.walkAway.title'), text: t('confirm.walkAway.text'), onYes: () => ui.closeDialog() }) }],
    });
  } else if (d.kind === 'battle') {
    const r = d.result;
    const lines = [];
    let lastRound = 0;
    for (const l of r.lines) {
      if (l.round !== lastRound) { lines.push(`<div class="round">${t('battle.round', { n: l.round })}</div>`); lastRound = l.round; }
      const text = t(l.down ? 'battle.hitDown' : 'battle.hit', { attacker: tn(l.attacker), defender: tn(l.defender), dmg: l.dmg });
      lines.push(`<div class="${l.side}">${escapeHtml(text)}</div>`);
    }
    const enemies = r.enemies.map((e) => t('log.battle.enemy', { name: tn(e.name), hp: e.maxHp, power: e.power })).join(', ');
    const intro = d.intro ? `<p>${escapeHtml(d.intro.text)}</p>` : '';
    // Stasis debuffs that shaped this fight, listed under the summary.
    const debuffs = (r.debuffs ?? []).length
      ? `<div class="debuffs">${t('battle.debuffs')} ${r.debuffs.map((id) =>
          escapeHtml(`${tc(`debuff.${id}.name`, CONFIG)} (${tc(`debuff.${id}.desc`, CONFIG)})`)).join(', ')}</div>`
      : '';
    // Victory reward: one ability upgrade pick after a normal battle, several
    // after a Colony. The offers are drawn FRESH before every pick (one random
    // available upgrade per living unit), so a Colony's second pick already
    // sees the children the first pick opened.
    const picksNow = () => (r.reward ? (r.rewardPicks ?? 1) : 0);
    const picks = picksNow();
    const askPick = (left, onDone = () => ui.closeDialog()) => askUpgradePick(left, onDone);
    const flavour = r.won && r.lore ? `<p class="flavour">${escapeHtml(t(r.lore))}</p>` : '';
    const salvage = r.won && r.supplies
      ? `<div class="effect">${escapeHtml(r.supplies < r.suppliesFull ? t('battle.supplies.partial', { got: r.supplies, n: r.suppliesFull }) : t('battle.supplies', { n: r.supplies }))}</div>`
      : '';
    ui.openDialog({
      title: d.intro ? d.intro.title : r.stasis ? (r.title ? t('battle.stasis.title', { title: tn(r.title) }) : t('battle.stasis.untitled')) : t('battle.title'),
      html: `${intro}<div class="battle-sum ${r.won ? 'won' : 'lost'}">${t(r.won ? 'battle.victory' : 'battle.defeat', { n: r.rounds })} ${t(r.partyFirst ? 'battle.partyFirst' : 'battle.enemiesFirst')}</div>
             ${debuffs}${flavour}${salvage}<p class="muted">${escapeHtml(t('battle.enemies', { list: enemies }))}</p><div class="battle-lines">${lines.join('')}</div>`,
      actions: [{
        label: picks ? t('dialog.continueReward', { n: picks }) : t('dialog.continue'),
        onClick: () => {
          const p = picksNow();
          if (!p) { ui.closeDialog(); return; }
          askPick(p);
        },
      }],
    });
  } else if (d.kind === 'shop') {
    // The window is built from the shop's own stock (2 guaranteed + random picks).
    // Sold-out options stay in the list, greyed out, so the player sees what was here.
    const hex = game.state.position;
    const stock = hex.shop ?? { options: [], bought: {} };
    const unitOption = (id, filter) => () => ui.chooseUnit({
      title: t(`shop.${id}.title`),
      html: `<p>${t(`shop.${id}.text`, { cost: game.shopCost(id), pct: `${Math.round(CONFIG.acolyte.reviveFraction * 100)}%` })}</p>`,
      filter,
      game,
      onPick: (i) => { game.shopBuy(id, i); showDialog({ kind: 'shop' }); },
      skip: { text: t('shop.pick.skip'), onSkip: () => showDialog({ kind: 'shop' }) },
    });
    // Buying an upgrade / the relic pays first, then opens the same upgrade
    // chooser as a battle reward (one pick), and returns to the shop window.
    const upgradeOption = (id) => () => {
      if (game.shopBuy(id)) askUpgradePick(1, () => showDialog({ kind: 'shop' }));
    };
    const clickFor = {
      upgrade: upgradeOption('upgrade'),
      relic: upgradeOption('relic'),
      spareParts: unitOption('spareParts', (u) => !u.alive),
      rest: () => game.shopBuy('rest'),
      map: () => game.shopBuy('map'),
      rumors: () => game.shopBuy('rumors'),
    };
    const subParams = {
      tiles: CONFIG.events.blobSize,
      pct: `${Math.round(CONFIG.rest.healFraction * 100)}%`, revivePct: `${Math.round(CONFIG.acolyte.reviveFraction * 100)}%`,
      count: CONFIG.events.rumorsCount, r: CONFIG.events.rumorsRadius,
    };
    const build = (g) => ({
      title: t('shop.title'),
      html: `${d.lore ? `<p class="flavour">${escapeHtml(t(d.lore))}</p>` : ''}<p>${t('shop.text', { supplies: g.state.supplies, fatigue: g.state.fatigue })}</p><span class="muted">${t('shop.note')}</span>`,
      actions: [
        ...stock.options.map((id) => {
          const blocker = g.shopBlocker(hex, id);
          const sold = blocker === 'sold';
          return {
            label: sold ? t('shop.option.sold', { label: t(`shop.${id}.name`) }) : t('shop.option', { label: t(`shop.${id}.name`), cost: g.shopCost(id) }),
            sub: sold ? t('shop.sold.sub') : blocker === 'useless' ? t(`shop.${id}.useless`) : t(`shop.${id}.sub`, subParams),
            disabled: !!blocker,
            cls: sold ? 'sold' : '',
            onClick: clickFor[id] ?? (() => {}),
          };
        }),
        { label: t('shop.leave'), onClick: () => ui.closeDialog() },
      ],
      onRefresh: (g2) => ui.openDialog(build(g2)),
    });
    ui.openDialog(build(game));
  } else if (d.kind === 'acolyte') {
    ui.chooseUnit({
      title: t('acolyte.title'),
      html: `${d.lore ? `<p class="flavour">${escapeHtml(t(d.lore))}</p>` : ''}<p>${t('acolyte.text', { pct: `${Math.round(CONFIG.acolyte.reviveFraction * 100)}%` })}</p>`,
      filter: (u) => !u.alive,
      game,
      onPick: (i) => { game.restoreUnit(i); ui.closeDialog(); },
      skip: { text: t('acolyte.skip'), onSkip: () => ui.closeDialog() },
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

renderer.onHexClick = (hex) => {
  if (cinematic.isActive()) return;   // the world is not on screen
  if (ui.dialogOpen()) { ui.flashDialog(); return; }
  if (tutorial.isBlocking()) return;
  if (renderer.busy) return;
  // A step whose terrain damage would disable someone asks for confirmation first.
  if (game.canMoveTo(hex) && hex.hpCost > 0) {
    const doomed = game.livingUnits().filter((u) => u.hp <= hex.hpCost);
    if (doomed.length) {
      ui.confirm({
        title: t('confirm.climb.title'),
        text: t('confirm.climb.text', { names: doomed.map((u) => tn(u.name)).join(', '), hp: hex.hpCost }),
        onYes: () => game.moveTo(hex),
      });
      return;
    }
  }
  if (!game.moveTo(hex)) {
    if (game.state.status === 'playing' && hex !== game.state.position) {
      game.addLog(hex.passable ? 'log.tooFar' : 'log.impassable');
    }
  }
};

renderer.onHexHover = (hex) => ui.setHover(hex, game);
// Clicking anywhere on the world (not just a tile) while a window is open flashes the window.
container.addEventListener('pointerdown', () => { if (ui.dialogOpen()) ui.flashDialog(); });

// ?scenario=<id> boots straight into a hand-authored map (the tutorial series).
const bootScenario = params.get('scenario') ? scenarioById(params.get('scenario')) : null;
if (bootScenario) startRun(1, { scenario: bootScenario });   // fixed seed: scenarios are deterministic
else startRun(resolveSeed(params.get('seed')));
initSplash();
window.__startScreen = () => startScreen; // for debugging / automated tests
