// Entry point: glues together the rules (Game), the picture (MapRenderer) and the HUD (ui).
import './style.css';
import { CONFIG } from './config.js';
import { Game } from './game.js';
import { MapRenderer } from './render.js';
import { createUI } from './ui.js';
import { resolveSeed } from './rng.js';
import { createTutorial, NPE_SEED } from './tutorial.js';
import { createSettings, deepClone } from './settings.js';
import { createCombatCinematic } from './local/transition.js';
import { t, tn, initLanguage, applyStaticTexts, onLanguageChange } from './i18n.js';
import { tc } from './text.js';

initLanguage();
applyStaticTexts();

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

const container = document.getElementById('scene');

// URL switches, handy for comparing variants without editing config.js:
//   ?seed=1234        same map every time
//   ?orient=pointy    pointy-top world hexes instead of the default flat-top
//   ?camera=ortho     start in the top-down camera
//   ?npe=1            start the guided new player experience
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
  onToggleCamera: () => { if (!cinematic.isActive()) renderer.toggleCameraMode(); },
  getCameraMode: () => renderer.cameraMode,
  getUiScale: loadUiScale,
  onSetUiScale: (v) => applyUiScale(v),
  onChange: () => { ui.buildLegend(); if (game) ui.update(game); },
  onClose: () => ui.updateBlur(),
});
// A language change re-renders everything that shows text.
onLanguageChange(() => { applyStaticTexts(); ui.buildLegend(); if (game) { ui.update(game); ui.renderLog(game); } });

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
const cinematic = createCombatCinematic({ renderer, config: CONFIG, container });
window.__cinematic = cinematic; // for debugging / automated tests
const COMBAT_TYPES = new Set(['battle', 'stasisSeed', 'stasisColony']);

// Starts the dive; `resume` runs the actual encounter once the camera lands.
function startCombatDive(hex, resume) {
  const enemies = (hex.enemies ?? []).map((e) => ({ ...e }));
  return cinematic.flyIn({
    worldHex: hex,
    baseColor: renderer.targetColorFor(hex).getHex(),
    party: game.livingUnits(),
    enemies,
    seed: game.seed,
    recipe: hex.recipe ?? null,   // future: handcrafted arena recipes live on the hex
    onArrived: () => {
      // The wither may have eaten the encounter while we were in the air.
      if (COMBAT_TYPES.has(hex.encounter)) resume();
      else cinematic.flyOut({});
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
    if (cinematic.isActive() && !ui.dialogOpen()) { cinematic.flyOut({ onDone: finishEnd }); return; }
    finishEnd();
  },
  onNewMap: () => startRun(resolveSeed()),
  onRestart: () => startRun(game.seed),
  onToggleCamera: () => { if (!cinematic.isActive()) renderer.toggleCameraMode(); },
  onRevealAll: () => game.revealAll(),
  onEnter: () => {
    if (renderer.busy || ui.dialogOpen() || tutorial.isBlocking() || cinematic.isActive()) return;
    const action = game.enterAction();
    if (action.kind === 'encounter' && COMBAT_TYPES.has(action.type)) {
      startCombatDive(game.state.position, () => game.enter(false));
      return;
    }
    game.enter(false);
  },
  onLoadSeed: (value) => startRun(resolveSeed(value)),
  onStartNpe: () => startRun(resolveSeed(NPE_SEED), { npe: true }),
});
const tutorial = createTutorial({ config: CONFIG, ui, renderer });
// The end screen waits for the guide's last card.
tutorial.setOnIdle(() => { if (pendingEnd && game && game.state.status !== 'playing' && !ui.dialogOpen()) { pendingEnd = false; ui.showEnd(game); } });

function startRun(seed, opts = {}) {
  pendingEnd = false;
  cinematic.abort();
  ui.closeDialog();
  tutorial.finish('restart');
  game = new Game(CONFIG, seed);
  window.game = game; // handy for poking at the state in the browser console
  // Forced fights (fatigue) take the same dive as the Enter button.
  game.combatIntro = (hex, resume) => (cinematic.isActive() ? false : startCombatDive(hex, resume));

  // Keep the seed in the address bar so the link can be shared.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(seed));
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
  if (opts.npe) tutorial.start();
}

// ----- encounter dialogs (top centre) -----------------------------------
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
      filter: (u) => u.alive,
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
    // Victory reward: one power pick after a normal battle, several after a Colony.
    // Read at click time as well, so the chooser can never be lost to event ordering.
    const picksNow = () => (r.reward ? (r.rewardPicks ?? 1) : 0);
    const picks = picksNow();
    const askPick = (left) => {
      ui.chooseUnit({
        title: t('battle.lessons.title'),
        html: `<p>${t('battle.lessons.text', { n: r.reward })}${left > 1 ? ` ${t('battle.lessons.left', { n: left })}` : ''}</p>`,
        filter: (u) => u.alive,
        game,
        onPick: (i) => { game.grantVictoryPower(i); if (left > 1) askPick(left - 1); else ui.closeDialog(); },
        skip: { text: t('battle.lessons.skip', { n: r.reward * left }), onSkip: () => ui.closeDialog() },
      });
    };
    const flavour = r.won && r.lore ? `<p class="flavour">${escapeHtml(t(r.lore))}</p>` : '';
    const salvage = r.won && r.supplies
      ? `<div class="effect">${escapeHtml(r.supplies < r.suppliesFull ? t('battle.supplies.partial', { got: r.supplies, n: r.suppliesFull }) : t('battle.supplies', { n: r.supplies }))}</div>`
      : '';
    ui.openDialog({
      title: d.intro ? d.intro.title : r.stasis ? (r.title ? t('battle.stasis.title', { title: tn(r.title) }) : t('battle.stasis.untitled')) : t('battle.title'),
      html: `${intro}<div class="battle-sum ${r.won ? 'won' : 'lost'}">${t(r.won ? 'battle.victory' : 'battle.defeat', { n: r.rounds })} ${t(r.partyFirst ? 'battle.partyFirst' : 'battle.enemiesFirst')}</div>
             ${debuffs}${flavour}${salvage}<p class="muted">${escapeHtml(t('battle.enemies', { list: enemies }))}</p><div class="battle-lines">${lines.join('')}</div>`,
      actions: [{
        label: picks ? t('dialog.continueReward', { n: r.reward * picks }) : t('dialog.continue'),
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
      html: `<p>${t(`shop.${id}.text`, { n: CONFIG.shop.upgradeAmount, cost: game.shopCost(id), pct: `${Math.round(CONFIG.acolyte.reviveFraction * 100)}%` })}</p>`,
      filter,
      game,
      onPick: (i) => { game.shopBuy(id, i); showDialog({ kind: 'shop' }); },
      skip: { text: t('shop.pick.skip'), onSkip: () => showDialog({ kind: 'shop' }) },
    });
    const clickFor = {
      upgrade: unitOption('upgrade', (u) => u.alive),
      relic: unitOption('relic', (u) => u.alive),
      spareParts: unitOption('spareParts', (u) => !u.alive),
      rest: () => game.shopBuy('rest'),
      map: () => game.shopBuy('map'),
      rumors: () => game.shopBuy('rumors'),
    };
    const subParams = {
      n: CONFIG.shop.upgradeAmount, tiles: CONFIG.events.blobSize,
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
  if (game.canMoveTo(hex) && tutorial.interceptMove(hex, game)) return;
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

if (params.get('camera') === 'ortho') renderer.toggleCameraMode();
if (params.get('npe')) startRun(resolveSeed(NPE_SEED), { npe: true });
else startRun(resolveSeed(params.get('seed')));
