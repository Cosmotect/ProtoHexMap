// The HUD: plain HTML elements layered over the 3D canvas.
// (In Godot terms: a CanvasLayer with Labels and Buttons.)
import { describeHex, lerpTable } from './game.js';
import { terrainInfo, terrainName, encounterLabel, encounterInfo, tc } from './text.js';
import { t, tn } from './i18n.js';
import { playFatigueStep, playFatigueClear, clearStaggerMs } from './audio.js';
import { unitAbilityIds, upgradeTree, treeLayout, upgradeRef } from './upgrades.js';
import { ABILITIES } from './config/abilities.js';
import { statusesFor, badgeNumber } from './status.js';
import { biomeColorFor } from './map.js';

// A status badge's hover text, in plain text (the overhead plaque builds the
// same thing as HTML - see statusTipHtml in src/local/localview.js).
function statusTipText(hs) {
  const n = hs.amount == null ? '' : (hs.amount > 0 ? `+${hs.amount}` : String(hs.amount));
  const parts = [t(`status.${hs.id}.name`, { n }), t(`status.${hs.id}.desc`, { n })];
  if (hs.turns > 0) parts.push(t('status.turns', { n: hs.turns }));
  return parts.filter(Boolean).join(' - ');
}

// Display name of an ability (locale key with the config name as fallback).
// An ability's hover text: its name, what it does, and the numbers that matter.
// Same source as the party panel and the roster window (the locale tables), so
// an ability reads the same wherever it is met.
function abilityTip(id, ab) {
  const parts = [abilityName(id)];
  const desc = t(`ability.${id}.desc`);
  if (desc && desc !== `ability.${id}.desc`) parts.push(desc);
  const nums = [];
  if (ab.damage > 0) nums.push(t('battle.ui.dmg', { n: ab.damage }));
  if (ab.heal > 0) nums.push(t('battle.ui.heal', { n: ab.heal }));
  if (ab.buff) nums.push(t(`status.${ab.buff === 'crit' ? 'crit' : ab.buff}.name`, { n: ab.buffX }));
  if (nums.length) parts.push(nums.join(', '));
  return parts.join(' - ');
}

function abilityName(id) {
  const key = `ability.${id}.name`;
  const s = t(key);
  return s === key ? (ABILITIES[id]?.name ?? id) : s;
}

export function createUI(config, handlers) {
  const $ = (id) => document.getElementById(id);

  const els = {
    fatigueBar: $('fatigue-bar'),
    fatigueBoxes: $('fatigue-boxes'),
    party: $('party-units'),
    enter: $('btn-enter'),
    confirm: $('confirm'),
    confirmTitle: $('confirm-title'),
    confirmText: $('confirm-text'),
    tip: $('fatigue-tip'),
    dialog: $('dialog'),
    banner: $('banner'),
    dialogTitle: $('dialog-title'),
    dialogBody: $('dialog-body'),
    dialogActions: $('dialog-actions'),
    supplies: $('stat-supplies'),
    turn: $('stat-turn'),
    seed: $('seed-value'),
    log: $('log'),
    hover: $('hover-info'),
    legend: $('legend'),
    legendItems: $('legend-items'),
    menu: $('menu'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayText: $('overlay-text'),
    scene: $('scene'),
    pathInfo: $('path-info'),
    deployBar: $('deploy-bar'),
    deployStep: $('deploy-step'),
    deployUnit: $('deploy-unit'),
    deployHint: $('deploy-hint'),
    battleBar: $('battle-bar'),
    battleRound: $('battle-round'),
    battleActive: $('battle-active'),
    battleAbilities: $('battle-abilities'),
    enemyRoster: $('enemy-roster'),
    localInfo: $('local-info'),
    liTitle: $('li-title'),
    liDesc: $('li-desc'),
    liEffects: $('li-effects'),
    liSep2: $('li-sep2'),
    partyLines: $('party-lines'),
  };

  // ----- buttons -----------------------------------------------------
  $('btn-new').addEventListener('click', () => handlers.onNewMap());
  $('btn-restart').addEventListener('click', () => handlers.onRestart());
  $('btn-reveal').addEventListener('click', () => handlers.onRevealAll());
  // Debug: ends the current local-map fight as an instant victory.
  $('btn-win-battle').addEventListener('click', () => { closeMenu(); handlers.onWinBattle && handlers.onWinBattle(); });
  // Undoes the fight in progress back to the moment it began (a no-op outside one).
  $('btn-restart-battle').addEventListener('click', () => { closeMenu(); handlers.onRestartBattle && handlers.onRestartBattle(); });
  $('btn-enter').addEventListener('click', () => handlers.onEnter());
  $('btn-menu').addEventListener('click', () => toggleMenu());
  $('btn-settings').addEventListener('click', () => { closeMenu(); handlers.onOpenSettings(); });
  // The tutorial: the first unfinished hand-authored map of the chain.
  $('btn-tutorial').addEventListener('click', () => { closeMenu(); handlers.onStartTutorial && handlers.onStartTutorial(); });
  function toggleMenu() { els.menu.classList.toggle('hidden'); updateBlur(); }
  function closeMenu() { els.menu.classList.add('hidden'); updateBlur(); }
  // The world blurs while the menu or any of its windows (settings) is open.
  function updateBlur() {
    const open = !els.menu.classList.contains('hidden') || (handlers.isSubWindowOpen && handlers.isSubWindowOpen());
    els.scene.classList.toggle('blurred', open);
  }
  // Close the menu when clicking outside it.
  window.addEventListener('pointerdown', (e) => {
    if (!els.menu.classList.contains('hidden') && !document.getElementById('menu-wrap').contains(e.target)) closeMenu();
  });
  $('btn-overlay-restart').addEventListener('click', () => { hideEnd(); handlers.onRestart(); });
  $('btn-overlay-new').addEventListener('click', () => { hideEnd(); handlers.onNewMap(); });
  $('btn-overlay-inspect').addEventListener('click', () => hideEnd());
  $('btn-overlay-next').addEventListener('click', () => { hideEnd(); handlers.onNextScenario && handlers.onNextScenario(); });
  const loadTypedSeed = () => {
    const value = $('seed-input').value.trim();
    if (value) handlers.onLoadSeed(value);
  };
  $('btn-load-seed').addEventListener('click', loadTypedSeed);
  $('seed-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTypedSeed(); });

  $('btn-copy').addEventListener('click', async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(currentSeed));
    try {
      await navigator.clipboard.writeText(url.toString());
      flash($('btn-copy'), t('menu.copied'));
    } catch {
      window.prompt(t('menu.copy.prompt'), url.toString());
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    // The menu is the one thing that always answers; everything else waits while input is blocked.
    if (e.key === 'm' || e.key === 'M') { toggleMenu(); return; }
    if (handlers.isInputBlocked && handlers.isInputBlocked()) return;
    if (e.key === 'n' || e.key === 'N') handlers.onNewMap();
    if (e.key === 'r' || e.key === 'R') handlers.onRestart();
    if (e.key === 'e' || e.key === 'E') {
      // In a fight, E ends the active unit's turn instead of "Enter".
      if (battleRef) { battleRef.endTurn(); return; }
      handlers.onEnter();
    }
    // 1 / 2 / 3 pick an ability of the unit whose turn it is, in the order the
    // ability bar shows them: the unit's own abilities first, then its relic when
    // the relic is an activatable one. (Relics do not exist yet - the slot is
    // reserved, so the third key simply finds nothing until they do.)
    if (battleRef && e.key >= '1' && e.key <= '3') {
      const slots = battleAbilitySlots();
      const id = slots[Number(e.key) - 1];
      if (id) battleRef.selectAbility(id);
      return;
    }
    if (e.key === 'Escape') { closeMenu(); closeRoster(); handlers.onEscape && handlers.onEscape(); }
  });

  // The abilities the hotkeys address, in bar order. Empty unless it is the
  // player's phase, a unit is selected and the engine is not mid-animation - the
  // same conditions under which the on-screen buttons are clickable.
  function battleAbilitySlots() {
    if (!battleRef) return [];
    const sb = battleRef.state;
    if (sb.phase !== 'player' || sb.busy || sb.over) return [];
    const c = battleRef.curPlayer();
    if (!c) return [];
    const slots = [...(c.abilityIds ?? [])];
    const relicAb = c.relic && (c.relic.abilityId ?? c.relic.ability);
    if (relicAb && battleRef.abilityFor(c, relicAb)) slots.push(relicAb);
    return slots;
  }

  let currentSeed = 0;
  let lastGame = null;   // the party panel is redrawn from combat too, not only from update()

  // The fatigue popup follows the mouse.
  let mouse = { x: 0, y: 0 };
  window.addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (!els.tip.classList.contains('hidden')) placeTip();
  });
  function placeTip() {
    // The HUD is zoomed by --ui-scale, so viewport (mouse) coordinates are divided
    // by the scale to land in the HUD's own units.
    const z = uiScale();
    const pad = 16;
    const mx = mouse.x / z, my = mouse.y / z;
    const vw = window.innerWidth / z, vh = window.innerHeight / z;
    let x = mx + pad, y = my + pad;
    const w = els.tip.offsetWidth, h = els.tip.offsetHeight;
    if (x + w > vw - 8) x = mx - w - pad;
    if (y + h > vh - 8) y = my - h - pad;
    els.tip.style.left = `${x}px`;
    els.tip.style.top = `${y}px`;
  }

  // ----- legend ------------------------------------------------------
  // Collapsed by default, expands on hover; each entry expands on click to show its info.
  // Rebuilt whenever a setting changes, since the texts are generated from the config.
  // Which layer's biome palette the legend swatches show. Set from the running
  // game in update(); the config default covers the moments before a run exists.
  let legendLayer = config.layers?.startLayer ?? 4;

  function buildLegend() {
  const legendItems = [];
  for (const [name, tr] of Object.entries(config.tileTypes)) {
    const note = !tr.passable ? t('legend.blocked')
      : tr.supplyCost > 0 ? t('legend.cost', { supplies: tr.supplyCost, hp: tr.hpCost })
      : tr.hpCost > 0 ? t('legend.costHp', { hp: tr.hpCost }) : '';
    legendItems.push({ swatch: `<span class="swatch" style="background:${hex(tr.color)}"></span>`, label: `${terrainName(name)}${note}`, info: terrainInfo(name, tr) });
  }
  // Biomes: mostly colour - the swatch shows the pure biome colour that land tiles
  // are shifted towards. A special biome (wither) may also add an HP cost.
  // A biome wears a different colour on every layer of the worldflake, so the swatch
  // asks map.js for the one THIS run is on (legendLayer, kept current in update()).
  for (const [name, b] of Object.entries(config.biomes)) {
    const note = (b.hpCost ?? 0) > 0 ? t('legend.costHp', { hp: b.hpCost }) : '';
    legendItems.push({ swatch: `<span class="swatch" style="background:${hex(biomeColorFor(b, legendLayer))}"></span>`, label: `${t(`biome.${name}`)}${note}`, info: tc(`biome.${name}.info`, config) });
  }
  for (const [type, v] of Object.entries(config.encounters.visuals)) {
    if (v.hidden) continue;   // scenario-only markers (the tutorial waypoint) stay out of the legend
    legendItems.push({ swatch: `<span class="swatch marker" style="background:${hex(v.color)}"></span>`, label: encounterLabel(type), info: encounterInfo(type, config) });
  }
  legendItems.push({ swatch: `<span class="swatch" style="background:${hex(config.colors.fogTile)}"></span>`, label: t('legend.unexplored'), info: t('legend.unexplored.info') });
  els.legendItems.innerHTML = legendItems.map((it, i) =>
    `<div class="legend-item" data-i="${i}"><div class="legend-head">${it.label}${it.swatch}</div><div class="legend-info">${escapeHtml(it.info)}</div></div>`).join('');
  }
  buildLegend();
  els.legendItems.addEventListener('click', (e) => {
    const item = e.target.closest('.legend-item');
    if (item) item.classList.toggle('open');
  });

  // ----- fatigue bar (top centre) --------------------------------------
  // One box per step of config.fatigue.byStep, showing the fatigue % that step
  // brings. A box is faint until the party has taken that step and solid after.
  // The box that just filled shakes once (with a blip, a semitone higher than
  // the box before it) and then breathes in a slow sine until the next step.
  // A reset empties the row right to left, with the blips walking back down.
  let boxes = [];
  let shownSteps = -1;   // what the bar is currently showing (-1 = nothing yet)
  let barGame = null;    // which run the bar belongs to (a new run never animates)
  let barTimers = [];

  function cancelBarTimers() {
    for (const id of barTimers) clearTimeout(id);
    barTimers = [];
  }

  function buildFatigueBar() {
    const fb = config.fatigueBar;
    const byStep = config.fatigue.byStep || {};
    const keys = Object.keys(byStep).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const maxStep = keys.length ? keys[keys.length - 1] : 0;
    // The percentage each step lands on, steps 1..maxStep (the table interpolates
    // and clamps, so the early steps missing from it come out as the first value).
    const pcts = [];
    for (let step = 1; step <= maxStep; step++) pcts.push(lerpTable(byStep, step));
    // Colour: the 0% boxes are green; the rest spread from yellow to red over the
    // range of non-zero percentages actually present.
    const risky = pcts.filter((p) => p > 0);
    const lo = risky.length ? Math.min(...risky) : 0;
    const hi = risky.length ? Math.max(...risky) : 1;
    const hueFor = (pct) => {
      if (pct <= 0) return fb.hueSafe;
      const k = hi > lo ? (pct - lo) / (hi - lo) : 0;
      return Math.round(fb.hueLow + (fb.hueHigh - fb.hueLow) * k);
    };
    els.fatigueBar.style.setProperty('--empty-opacity', String(fb.emptyOpacity));
    els.fatigueBar.style.setProperty('--filled-opacity', String(fb.filledOpacity));
    els.fatigueBar.style.setProperty('--wiggle-ms', `${fb.wiggleMs}ms`);
    els.fatigueBar.style.setProperty('--pulse-ms', `${fb.pulseMs}ms`);
    els.fatigueBar.style.setProperty('--pulse-scale', String(fb.pulseScale));
    els.fatigueBoxes.innerHTML = pcts.map((pct, i) =>
      `<div class="fbox" style="--hue:${hueFor(pct)};--size:${fb.boxSize}px" title="${escapeAttr(t('fatiguebar.box', { step: i + 1, pct: Math.round(pct) }))}">
         <div class="fbox-face">${Math.round(pct)}%</div>
       </div>`).join('');
    boxes = Array.from(els.fatigueBoxes.querySelectorAll('.fbox'));
    cancelBarTimers();
    shownSteps = -1;   // force the next update to redraw the filled state
  }
  buildFatigueBar();

  function clearBarAnimations() {
    for (const b of boxes) b.classList.remove('pulse', 'wiggle');
  }

  // Fill up to `upTo` boxes. `animate` plays the shake, the sound and the pulse
  // on the last one; without it the bar just snaps to the state (new run, rebuild).
  function fillBar(upTo, animate) {
    cancelBarTimers();
    clearBarAnimations();
    boxes.forEach((b, i) => b.classList.toggle('filled', i < upTo));
    if (!animate || upTo <= 0) return;
    const box = boxes[upTo - 1];
    box.classList.add('wiggle');
    playFatigueStep(upTo - 1, boxes.length);
    barTimers.push(setTimeout(() => {
      box.classList.remove('wiggle');
      box.classList.add('pulse');
    }, config.fatigueBar.wiggleMs));
  }

  // A reset: the boxes go faint again one by one, right to left, the blips
  // walking back down the ladder.
  function clearBar(from) {
    cancelBarTimers();
    clearBarAnimations();
    const stagger = clearStaggerMs;
    for (let i = from - 1; i >= 0; i--) {
      const delayMs = (from - 1 - i) * stagger;
      const box = boxes[i];
      barTimers.push(setTimeout(() => box.classList.remove('filled'), delayMs));
      playFatigueClear(i, boxes.length, delayMs / 1000);
    }
  }

  function syncFatigueBar(game) {
    const steps = game.state.fatigueSteps;
    const fresh = game !== barGame;      // a new run: no sound, no animation
    barGame = game;
    if (!fresh && steps === shownSteps) return;
    const prev = shownSteps;
    shownSteps = steps;
    const upTo = Math.min(steps, boxes.length);
    if (fresh || prev < 0) { fillBar(upTo, false); return; }
    if (steps > prev) fillBar(upTo, true);
    else clearBar(Math.min(prev, boxes.length));
  }

  // ----- public API --------------------------------------------------
  function update(game) {
    const s = game.state;
    currentSeed = game.seed;
    // A new run may sit on a different layer, where every biome wears other colours.
    if (game.map && game.map.layer !== undefined && game.map.layer !== legendLayer) {
      legendLayer = game.map.layer;
      buildLegend();
    }
    syncFatigueBar(game);
    if (startScreenMode) {
      // The start screen: the Enter button's slot holds "Begin journey".
      els.enter.disabled = false;
      els.enter.textContent = t('start.begin');
      els.enter.title = t('start.begin.title');
      els.enter.classList.remove('camp');
      els.enter.classList.add('begin');
    } else {
      els.enter.classList.remove('begin');
      const action = game.enterAction();
      els.enter.disabled = !action.enabled;
      els.enter.textContent = action.label;
      els.enter.title = action.reason || (action.kind === 'camp' ? tc('status.camp.title', config) : t('status.enter.title'));
      els.enter.classList.toggle('camp', action.kind === 'camp');
    }
    lastGame = game;
    renderPartyPanel();
    // Keep an open dialog in sync (e.g. shop prices after a purchase).
    if (dialogRefresh) dialogRefresh(game);
    els.supplies.textContent = `${s.supplies} / ${s.maxSupplies}`;
    els.supplies.classList.toggle('warn', s.supplies <= 3 && s.status === 'playing');
    els.turn.textContent = String(s.turn);
    els.seed.textContent = String(game.seed);
    els.pathInfo.textContent = t('menu.route', { n: s.shortestPathLength });
  }

  function renderLog(game) {
    const last = game.log.slice(-7);
    els.log.innerHTML = last
      .map((entry, i) => `<div class="${i === last.length - 1 ? 'latest' : ''}">${escapeHtml(t(entry.key, resolveParams(entry.params)))}</div>`)
      .join('');
  }

  function setHover(hex, game) {
    if (!hex) {
      els.hover.textContent = '';
      els.hover.classList.add('hidden');
      els.tip.classList.add('hidden');
      return;
    }
    els.hover.classList.remove('hidden');
    updateFatigueTip(hex, game);
    if (!hex.revealed) {
      els.hover.textContent = t('hover.unexplored', { q: hex.q, r: hex.r });
      return;
    }
    const canGo = game.canMoveTo(hex);
    // The actual charge stepping here from the party's CURRENT tile would incur
    // right now (0 for hills/mountains reached from same-or-higher ground).
    const stepCost = game.stepCost(hex);
    let cost = '';
    if (!hex.passable) cost = t('hover.impassable');
    else if (stepCost.supplyCost > 0) cost = t('hover.cost', { supplies: stepCost.supplyCost, hp: stepCost.hpCost, bonus: hex.revealBonus });
    else if (stepCost.hpCost > 0) cost = t('hover.costHp', { hp: stepCost.hpCost });
    const seen = hex.terrainHeight > 0 ? t('hover.seen', { n: hex.terrainHeight }) : '';
    els.hover.textContent = `${describeHex(hex)}${cost}${seen}${canGo ? t('hover.click') : ''}`;
  }

  // Popup near the cursor. On a tile the party can step onto this turn: the number of
  // the step about to be taken (1 = first step since the last fatigue reset), the chance
  // of a forced encounter on arrival, and the fatigue after that step. On any tile: what
  // its encounter does to fatigue, and the stock of a shop already visited.
  function updateFatigueTip(hex, game) {
    const s = game.state;
    if (s.status !== 'playing') { els.tip.classList.add('hidden'); return; }
    const canGo = game.canMoveTo(hex);
    const parts = [];
    // What is on the tile comes first and reads loudest - it is the thing the
    // player is pointing at. The step counter follows underneath.
    if (hex.revealed && hex.encounter) {
      parts.push(`<div class="tip-enc">${escapeHtml(game.labelFor(hex.encounter))}</div>`);
      // A Stasis Seed or an active Colony carries debuffs into its fight: spell
      // each one out, so the cost of walking in is on the tile itself.
      for (const id of game.activeDebuffsFor(hex)) {
        parts.push(`<div class="tip-debuff"><b>${escapeHtml(tc(`debuff.${id}.name`, config))}</b> ${escapeHtml(tc(`debuff.${id}.desc`, config))}</div>`);
      }
    }
    if (canGo) {
      const next = game.fatigueAfterNextStep();
      const forced = game.forcedChanceFor(hex); // null = nothing to force here
      const stepTag = `<span class="tip-step" title="${t('tip.step.title')}">${t('tip.step')} <b>${s.fatigueSteps + 1}</b></span>`;
      if (forced && forced.chance > 0 && !hex.revealed) {
        parts.push(`<div class="tip-big">${stepTag} ${t('tip.forced', { chance: forced.chance })}</div><div class="tip-sub">${t('tip.forced.unexplored')}</div>`);
      } else if (forced && forced.chance > 0) {
        parts.push(`<div class="tip-big">${stepTag} ${t('tip.forced', { chance: forced.chance })}</div>`);
      } else {
        parts.push(`<div class="tip-big">${stepTag}</div>`);
      }
      parts.push(`<div class="tip-small">${t('tip.after', { next, now: s.fatigue })}</div>`);
    }
    // A shop the party has already entered lists what it still sells, from any distance.
    if (hex.revealed && hex.encounter === 'shop' && hex.shop?.seen) {
      const items = hex.shop.options.map((id) => {
        const sold = !!hex.shop.bought[id];
        const text = sold ? t('hover.shop.sold', { label: t(`shop.${id}.name`) }) : t('hover.shop.item', { label: t(`shop.${id}.name`), cost: game.shopCost(id) });
        return `<span class="${sold ? 'shop-sold' : ''}">${escapeHtml(text)}</span>`;
      });
      parts.push(`<div class="tip-small tip-shop">${escapeHtml(t('hover.shop.title'))} ${items.join(escapeHtml(t('hover.shop.sep')))}</div>`);
    }
    if (!parts.length) { els.tip.classList.add('hidden'); return; }
    els.tip.innerHTML = parts.join('');
    els.tip.classList.remove('hidden');
    placeTip();
  }

  function showEnd(game) {
    const s = game.state;
    // After a tutorial-map victory the overlay leads to the next map of the chain.
    const nextLabel = handlers.scenarioNextLabel ? handlers.scenarioNextLabel() : null;
    const nextBtn = $('btn-overlay-next');
    nextBtn.classList.toggle('hidden', !nextLabel);
    if (nextLabel) nextBtn.textContent = nextLabel;
    els.overlayTitle.textContent = t(s.status === 'won' ? 'end.won.title' : 'end.lost.title');
    const reason = Array.isArray(s.endReason) ? t(s.endReason[0], s.endReason[1]) : String(s.endReason || '');
    els.overlayText.textContent = `${reason} ${t('end.inspectNote')}`;
    els.overlay.classList.remove('hidden');
  }

  function hideEnd() {
    els.overlay.classList.add('hidden');
  }

  // ----- generic dialog ------------------------------------------------
  // openDialog({ title, html, actions: [{ label, sub, onClick, disabled }], onRefresh })
  let dialogRefresh = null;
  let dialogOnClose = null;
  function openDialog(spec) {
    els.dialogTitle.textContent = spec.title;
    els.dialogBody.innerHTML = spec.html ?? '';
    els.dialogActions.innerHTML = '';
    for (const a of spec.actions ?? []) {
      const b = document.createElement('button');
      b.innerHTML = `<b>${escapeHtml(a.label)}</b>${a.sub ? `<small>${escapeHtml(a.sub)}</small>` : ''}`;
      b.disabled = !!a.disabled;
      if (a.cls) b.className = a.cls;
      b.addEventListener('click', () => a.onClick());
      els.dialogActions.appendChild(b);
    }
    dialogRefresh = spec.onRefresh ?? null;
    dialogOnClose = spec.onClose ?? null;
    els.dialog.classList.remove('hidden');
  }
  function closeDialog() {
    const wasOpen = dialogOpen();
    dialogRefresh = null;
    const onClose = dialogOnClose;
    dialogOnClose = null;
    els.dialog.classList.add('hidden');
    if (wasOpen && onClose) onClose();
    if (wasOpen && handlers.onDialogClosed) handlers.onDialogClosed();
  }
  function dialogOpen() { return !els.dialog.classList.contains('hidden'); }
  // Draws attention to the open window when the player clicks the world instead.
  function flashDialog() {
    if (!dialogOpen()) return;
    els.dialog.classList.remove('flash');
    void els.dialog.offsetWidth; // restart the animation
    els.dialog.classList.add('flash');
  }

  // "Are you sure?" box. onYes runs if the player confirms.
  $('btn-confirm-no').addEventListener('click', () => els.confirm.classList.add('hidden'));
  let confirmYes = null;
  $('btn-confirm-yes').addEventListener('click', () => { els.confirm.classList.add('hidden'); if (confirmYes) confirmYes(); });
  function confirm({ title, text, onYes }) {
    els.confirmTitle.textContent = title || t('confirm.title');
    els.confirmText.textContent = text;
    confirmYes = onYes;
    els.confirm.classList.remove('hidden');
  }

  // Generic "choose a unit" dialog, reused by the shop and the Acolyte.
  // filter(unit) decides which units are selectable; onPick(index) gets the choice.
  // extraActions: additional buttons after the units (e.g. "Decline").
  // skip: { text, onSkip } adds a Skip button that asks for confirmation first (the same
  // warning as leaving a reward behind). Omit it when a choice is mandatory.
  function chooseUnit({ title, html, filter, onPick, game, extraActions = [], skip }) {
    const build = (g) => ({
      title,
      html,
      actions: [
        ...g.state.party.map((u, i) => ({
          label: `${u.icon} ${tn(u.name)}`,
          sub: u.alive ? t('dialog.unit.sub', { hp: u.hp, max: u.maxHp }) : t('dialog.unit.disabled'),
          disabled: !filter(u),
          onClick: () => onPick(i),
        })),
        ...extraActions,
        ...(skip ? [{
          label: t('dialog.skip'), sub: t('dialog.skip.sub'),
          onClick: () => confirm({ title: t('confirm.skip.title'), text: skip.text, onYes: skip.onSkip }),
        }] : []),
      ],
    });
    openDialog(build(game));
  }

  // The upgrade reward chooser: one offered upgrade per living unit; picking
  // one unlocks it (main.js drives the pick count and what happens after).
  function chooseUpgrade({ game, offers, left, onPick, onSkip }) {
    openDialog({
      title: t('battle.lessons.title'),
      html: `<p>${t('battle.lessons.text')}${left > 1 ? ` ${t('battle.lessons.left', { n: left })}` : ''}</p>`,
      actions: [
        ...offers.map((o) => {
          const u = game.state.party[o.index];
          return {
            label: `${u.icon} ${tn(u.name)}: ${t(`upgrade.${o.abilityId}.${o.nodeId}.name`)}`,
            sub: `${abilityName(o.abilityId)} - ${t(`upgrade.${o.abilityId}.${o.nodeId}.desc`)}`,
            onClick: () => onPick(o),
          };
        }),
        ...(onSkip ? [{
          label: t('dialog.skip'), sub: t('dialog.skip.sub'),
          onClick: () => confirm({ title: t('confirm.skip.title'), text: t('battle.lessons.skip'), onYes: () => { closeDialog(); onSkip(); } }),
        }] : []),
      ],
    });
  }

  // The black market's second step: exactly the unit picked in chooseUnit,
  // two (or one, if that is all it has left) random upgrade suggestions for
  // THAT unit only - unlike chooseUpgrade, which offers one upgrade per
  // living unit across the whole party. Nothing is spent until a suggestion
  // is actually picked; declining here still walks away clean.
  function chooseBlackMarketUpgrade({ game, index, offers, loss, onPick, onDecline }) {
    const u = game.state.party[index];
    openDialog({
      title: t('blackmarket.pick.title'),
      html: `<p>${t('blackmarket.pick.text', { name: tn(u.name), loss })}</p>`,
      actions: [
        ...offers.map((o) => ({
          label: t(`upgrade.${o.abilityId}.${o.nodeId}.name`),
          sub: `${abilityName(o.abilityId)} - ${t(`upgrade.${o.abilityId}.${o.nodeId}.desc`)}`,
          onClick: () => onPick(o),
        })),
        { label: t('dialog.decline'), sub: t('dialog.decline.sub'), onClick: () => confirm({ title: t('confirm.walkAway.title'), text: t('confirm.walkAway.text'), onYes: onDecline }) },
      ],
    });
  }

  // Centre-screen banner (forced encounters). Hides itself after `ms`.
  let bannerTimer = null;
  function showBanner(text, ms) {
    els.banner.textContent = text;
    els.banner.classList.remove('hidden');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => els.banner.classList.add('hidden'), ms);
  }

  // ----- the battle bar (interactive combat on the local map) ---------------
  // Shown instead of the status bar while a fight runs. Everything is read off
  // the combat engine's state on every updateBattle() call; the buttons talk
  // straight back to the engine (selectAbility / endTurn).
  // ----- the party panel's pointer line ------------------------------------
  // Hovering a party card draws a line from it to that unit's body in the arena
  // - the same idea (and the same SVG layer) as the tutorial's green pointer,
  // so the two read as one language. Only on the local map: on the world map the
  // party is one token and the line would point at all three at once.
  // `hovered` is { kind: 'party'|'enemy', id } - the card the cursor is on. Both
  // panels behave identically; the only difference is which lookup finds the
  // body in the arena.
  let hovered = null;
  for (const [root, kind, attr] of [[els.party, 'party', 'data-party'], [els.enemyRoster, 'enemy', 'data-enemy']]) {
    root.addEventListener('pointerover', (e) => {
      const card = e.target.closest(`.unit[${attr}]`);
      setHovered(card ? { kind, id: card.getAttribute(attr) } : null);
    });
    root.addEventListener('pointerleave', () => setHovered(null));
  }
  function setHovered(next) {
    if (next?.kind === hovered?.kind && next?.id === hovered?.id) return;
    hovered = next;
    if (!hovered) els.partyLines.innerHTML = '';
    markHovered();
  }
  // Re-applied after every redraw as well as on hover: a card can be rebuilt
  // under the cursor by any HP change, and would otherwise lose its gold frame
  // mid-hover.
  function markHovered() {
    const attr = hovered?.kind === 'party' ? 'data-party' : 'data-enemy';
    document.querySelectorAll('#party-units .unit, #enemy-roster .unit').forEach((el) => {
      el.classList.toggle('pointed', !!hovered && el.hasAttribute(attr) && el.getAttribute(attr) === hovered.id);
    });
  }
  // Redrawn every frame: the camera moves, the units walk, and a card can be
  // re-rendered under the cursor by any HP change.
  function drawPointerLine() {
    if (!hovered || !document.body.classList.contains('local-mode')) { els.partyLines.innerHTML = ''; return; }
    const view = handlers.getLocalView && handlers.getLocalView();
    const end = hovered.kind === 'party'
      ? view?.partyTokenScreen?.(Number(hovered.id))
      : view?.unitTokenScreen?.(hovered.id);
    const sel = hovered.kind === 'party' ? `#party-units .unit[data-party="${hovered.id}"]` : `#enemy-roster .unit[data-enemy="${hovered.id}"]`;
    const card = document.querySelector(sel);
    if (!end || !card) { els.partyLines.innerHTML = ''; return; }
    const a = card.getBoundingClientRect();
    const start = rectEdgeToward(a, end.x, end.y);
    // The SVG lives inside the zoomed HUD; the projections are in viewport
    // pixels, so both ends are divided by the UI scale.
    const z = uiScale();
    els.partyLines.innerHTML = `<line x1="${start.x / z}" y1="${start.y / z}" x2="${end.x / z}" y2="${end.y / z}"></line><circle cx="${end.x / z}" cy="${end.y / z}" r="4"></circle>`;
  }
  (function pointerLineTick() { drawPointerLine(); requestAnimationFrame(pointerLineTick); })();

  let battleRef = null;
  $('btn-end-turn').addEventListener('click', () => { if (battleRef) battleRef.endTurn(); });
  els.battleAbilities.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ab]');
    if (b && battleRef) battleRef.selectAbility(b.dataset.ab);
  });
  // The local map's COMBAT sub-state. `in-combat` is the name the design uses
  // for it; `battle-mode` is the same flag under the name the older CSS knows.
  // Both are only ever on while `local-mode` is (the arena is on screen).
  // `info` (optional) describes the fight for the Local Map Info panel:
  //   { title, lore, debuffs } - the enemy group's name, a locale key for the
  //   lore line, and the Stasis debuff ids riding on this arena.
  function setBattleMode(battle, info = null) {
    battleRef = battle ?? null;
    document.body.classList.toggle('battle-mode', !!battleRef);
    document.body.classList.toggle('in-combat', !!battleRef);
    els.battleBar.classList.toggle('hidden', !battleRef);
    els.localInfo.classList.toggle('hidden', !battleRef);
    if (!battleRef) { els.enemyRoster.innerHTML = ''; els.liEffects.innerHTML = ''; }
    else { fillLocalInfo(info); updateBattle(); }
  }

  // ----- the deployment bar -------------------------------------------------
  // Before a fight the party walked into: which unit the cursor is carrying and
  // how many are left to place. `state` is { index, total, unit } from the local
  // view; null takes the bar away.
  function setDeployBar(state) {
    const on = !!state && !!state.unit;
    els.deployBar.classList.toggle('hidden', !on);
    document.body.classList.toggle('deploy-mode', on);
    if (!on) return;
    els.deployStep.textContent = t('deploy.step', { n: state.index + 1, total: state.total });
    els.deployUnit.innerHTML = `<b>${escapeHtml(`${state.unit.icon ?? ''} ${tn(state.unit.name)}`.trim())}</b>`;
    els.deployHint.textContent = state.index > 0 ? t('deploy.hint.undo') : t('deploy.hint');
  }

  // Top half of the Local Map Info panel: what this fight is, and the effects
  // hanging over the arena. The enemy roster below it is redrawn every turn by
  // updateBattle(); this part is written once, when the fight opens.
  function fillLocalInfo(info) {
    const i = info ?? {};
    els.liTitle.textContent = i.title ? tn(i.title) : t('localinfo.title');
    els.liDesc.textContent = i.lore ? t(i.lore) : '';
    els.liDesc.classList.toggle('hidden', !i.lore);
    // Debuffs today, buffs later: both render as one block with a name and a
    // line of effect, the buff variant in the party-panel green.
    const effects = (i.debuffs ?? []).map((id) =>
      `<div class="li-effect"><b>${escapeHtml(tc(`debuff.${id}.name`, config))}</b><span>${escapeHtml(tc(`debuff.${id}.desc`, config))}</span></div>`);
    els.liEffects.innerHTML = effects.join('');
    // No effects: the whole block and one of the two separators go away, so the
    // panel does not carry an empty gap.
    els.liEffects.classList.toggle('hidden', !effects.length);
    els.liSep2.classList.toggle('hidden', !effects.length);
  }

  // The enemy roster across the top: one card per enemy, in TURN ORDER - the
  // engine's own enemy queue (initiative high to low, ties by spawn index), so
  // the strip reads left to right in the order they will act.
  function renderEnemyRoster() {
    if (!battleRef) return;
    const sb = battleRef.state;
    const order = sb.units
      .filter((u) => u.isEnemy)
      .sort((a, b) => b.init - a.init || a.idx - b.idx);
    els.enemyRoster.innerHTML = order.map((u, i) => {
      // A unit that ran off the field also sits at 0 HP, but it was never killed:
      // the card says so instead of showing it as a casualty.
      const dead = u.hp <= 0;
      const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
      const segPct = (config.party.hpSegment / u.maxHp) * 100;
      const cls = `${dead ? 'dead' : ''} ${!dead && pct < 50 ? 'hurt' : ''} ${u.uid === sb.activeUid ? 'active' : ''} ${u.uid === sb.inspectUid ? 'inspected' : ''}`;
      // Exactly the party card, minus the relic slot: an enemy carries none, and
      // an empty socket would promise loot that is not there.
      const slots = (u.abilityIds ?? []).map((id) => {
        const ab = battleRef.abilityById(id);
        return ab ? slotBox('ab', ab.icon, abilityTip(id, ab)) : slotBox('ab', null, t('slot.ability.empty'));
      });
      while (slots.length < 2) slots.push(slotBox('ab', null, t('slot.ability.empty')));
      // The initial stands in for a portrait: enemies carry no emoji.
      const initial = (u.name ?? '?').charAt(0);
      return `<div class="unit ${cls.trim()}" data-enemy="${u.uid}">
        ${unitCardBody({
          portrait: escapeHtml(initial),
          name: tn(u.name),
          hpText: u.fled ? t('battle.ui.fled') : u.fleeing ? t('battle.ui.fleeing') : t('party.hp', { hp: Math.max(0, u.hp), max: u.maxHp }),
          pct, segPct, slots: slots.join(''), statuses: statusesFor(u),
        })}
      </div>`;
    }).join('');
    markHovered();
  }
  // The party panel. Its numbers come from the world-map party, but its STATUS
  // sockets come from the combat engine's instances - shields and stuns only
  // exist there - so it is redrawn on every engine change as well as on every
  // world-map update.
  function renderPartyPanel() {
    if (!lastGame) return;
    const live = battleRef ? battleRef.state.units : [];
    els.party.innerHTML = lastGame.state.party
      .map((u, i) => unitCard(u, config, i, live.find((x) => x.partyIndex === i) ?? null))
      .join('');
    markHovered();
  }

  function updateBattle() {
    if (!battleRef) return;
    renderEnemyRoster();
    renderPartyPanel();
    const sb = battleRef.state;
    els.battleRound.textContent = sb.ambush ? t('battle.ui.ambush') : t('battle.ui.round', { n: sb.round });
    const c = battleRef.curPlayer();
    if (sb.phase === 'player' && c) {
      const hint = c.moveLocked ? t('battle.ui.locked') : t('battle.ui.canMove');
      els.battleActive.innerHTML = `<b>${c.icon ?? ''} ${escapeHtml(tn(c.name))}</b> <span class="hp">${t('battle.ui.hp', { hp: c.hp, max: c.maxHp })}</span> <span class="muted">${escapeHtml(hint)}</span>`;
      // The hotkeys (1 / 2 / 3) address this same list, so the tooltip names the key.
      const slots = battleAbilitySlots();
      els.battleAbilities.innerHTML = c.abilityIds.map((id) => {
        const ab = battleRef.abilityFor(c, id);   // the unit's UPGRADED def
        if (!ab) return '';
        const sel = sb.selAb === id ? 'selected' : '';
        const num = ab.damage > 0 ? `⚔${ab.damage}` : ab.heal > 0 ? `+${ab.heal}` : '';
        const slot = slots.indexOf(id);
        const key = slot >= 0 && slot < 3 ? ` [${slot + 1}]` : '';
        const tip = `${ab.name}${key}${ab.damage > 0 ? ` - ${t('battle.ui.dmg', { n: ab.damage })}` : ''}${ab.heal > 0 ? ` - ${t('battle.ui.heal', { n: ab.heal })}` : ''}`;
        return `<button class="ab ${sel}" data-ab="${id}" title="${escapeAttr(tip)}" ${sb.busy ? 'disabled' : ''}>
          <span class="ab-icon">${ab.icon}</span><small>${escapeHtml(ab.name)}</small>${num ? `<span class="ab-num">${num}</span>` : ''}
        </button>`;
      }).join('');
      $('btn-end-turn').disabled = !!sb.busy;
    } else if (sb.phase === 'player' && !sb.over) {
      // The player right-clicked their way out of every selection.
      els.battleActive.innerHTML = `<span class="muted">${escapeHtml(t('battle.ui.nobody'))}</span>`;
      els.battleAbilities.innerHTML = '';
      $('btn-end-turn').disabled = !!sb.busy;
    } else {
      els.battleActive.innerHTML = `<span class="muted">${t(sb.over ? 'battle.ui.over' : 'battle.ui.enemyPhase')}</span>`;
      els.battleAbilities.innerHTML = '';
      $('btn-end-turn').disabled = true;
    }
  }

  // ----- the start screen (party around the campfire) ----------------------
  // While it is on, the Enter button reads "Begin journey" and clicking a unit
  // in the party panel opens the roster grid.
  let startScreenMode = false;
  let onPartyUnitClick = null;
  function setStartScreen(v, opts = {}) {
    startScreenMode = !!v;
    onPartyUnitClick = v ? (opts.onUnitClick ?? null) : null;
    document.body.classList.toggle('start-screen', startScreenMode);
    if (!v) { closeRoster(); setLayerSelector(null); }
  }
  els.party.addEventListener('click', (e) => {
    if (!startScreenMode || !onPartyUnitClick) return;
    const card = e.target.closest('.unit');
    if (!card) return;
    onPartyUnitClick([...els.party.children].indexOf(card));
  });

  // ----- the layer selector (start screen) ---------------------------------
  // A dropdown that expands UPWARDS from just above the Begin journey button,
  // listing the unlocked layers of the worldflake top (8) to bottom (the
  // core), the way the layers physically stack. main.js shows it only once a
  // second layer is unlocked; picking a DIFFERENT layer plays the camera-roll
  // switch (the current one just closes the list).
  const layerSelectEl = $('layer-select');
  const layerBtn = $('btn-layer');
  const layerOptionsEl = $('layer-options');
  let layerOpts = null;
  const layerLabel = (n) => (n === 0 ? t('layer.core') : t('layer.name', { n }));
  layerBtn.addEventListener('click', () => {
    if (!layerOpts) return;
    layerOptionsEl.classList.toggle('hidden');
  });
  layerOptionsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-layer]');
    if (!b || !layerOpts) return;
    layerOptionsEl.classList.add('hidden');
    const layer = Number(b.dataset.layer);
    if (layer !== layerOpts.current && layerOpts.onSelect) layerOpts.onSelect(layer);
  });
  // opts: { layers: [ids], current, onSelect(layer) } or null to hide.
  function setLayerSelector(opts) {
    layerOpts = opts ?? null;
    layerOptionsEl.classList.add('hidden');
    layerSelectEl.classList.toggle('hidden', !layerOpts);
    if (!layerOpts) return;
    layerBtn.textContent = `${layerLabel(layerOpts.current)} ▴`;
    layerBtn.title = t('layer.title');
    const sorted = [...layerOpts.layers].sort((a, b) => b - a);   // 8 on top, the core last
    layerOptionsEl.innerHTML = sorted.map((n) =>
      `<button data-layer="${n}" class="${n === layerOpts.current ? 'current' : ''}">${escapeHtml(layerLabel(n))}</button>`).join('');
  }

  // ----- the roster grid (fighting-game style character select) ------------
  // Picking a card no longer swaps the unit on the spot: it only marks that
  // card as the pending choice (gold outline) and updates the detail window's
  // default. The slot's ORIGINAL unit keeps a green outline throughout, and
  // the actual swap only happens if the player locks it in at the bottom -
  // Cancel (or Escape) leaves the party exactly as it was.
  const rosterEl = $('roster');
  let rosterPick = null;
  $('btn-roster-cancel').addEventListener('click', () => closeRoster());
  $('btn-roster-confirm').addEventListener('click', () => {
    if (!rosterPick) return;
    const { selectedName, confirmedName, roster, onPick } = rosterPick;
    closeRoster();
    // Nothing was actually picked (still the confirmed unit): do NOT call
    // onPick. setPartyUnit() always hands back a fresh unit - full HP, no
    // unlocked upgrades - so firing it here would wipe that unit's progress
    // for no reason, even though the player never asked to change anything.
    if (selectedName === confirmedName) return;
    const def = roster.find((r) => r.name === selectedName);
    if (def && onPick) onPick(def);
  });
  function openRoster({ slotIndex, party, roster, onPick }) {
    const current = party[slotIndex];
    $('roster-sub').textContent = t('roster.replace', { name: tn(current.name) });
    // A unit already serving in a DIFFERENT slot can't be picked here; the
    // slot's own current unit is never "taken" against itself - it starts as
    // the confirmed (green) card instead, same as everyone else's is pickable.
    const takenElsewhere = new Set(party.filter((u, i) => i !== slotIndex).map((u) => u.name));
    $('roster-grid').innerHTML = roster.map((def, i) => {
      const taken = takenElsewhere.has(def.name);
      const abs = unitAbilityIds(def.name).map((id) => ABILITIES[id]?.icon ?? '').join(' ');
      const confirmed = def.name === current.name;
      return `<div class="roster-card ${taken ? 'taken' : ''} ${confirmed ? 'confirmed' : ''}" data-i="${i}" data-name="${escapeAttr(def.name)}">
        <div class="rc-portrait">${def.icon}</div>
        <div class="rc-name">${escapeHtml(tn(def.name))}</div>
        <div class="rc-stats"><span class="rc-hp">${t('roster.hp', { n: def.hp })}</span><span class="rc-abs">${abs}</span></div>
        ${taken ? `<div class="rc-tag">${t('roster.inParty')}</div>` : ''}
      </div>`;
    }).join('');
    rosterPick = { roster, onPick, party, confirmedName: current.name, selectedName: current.name };
    // The detail window below the grid defaults to the confirmed unit;
    // hovering any roster card previews that character instead (see the
    // mouseover/mouseleave handlers below).
    renderUnitDetail(current, party.find((u) => u.name === current.name));
    rosterEl.classList.remove('hidden');
  }
  // Clicking a pickable card only SELECTS it (gold outline, new detail
  // default) - it does not swap anyone in. See btn-roster-confirm for that.
  $('roster-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.roster-card');
    if (!card || card.classList.contains('taken') || !rosterPick) return;
    const def = rosterPick.roster[Number(card.dataset.i)];
    if (!def) return;
    rosterPick.selectedName = def.name;
    for (const el of $('roster-grid').querySelectorAll('.roster-card')) {
      el.classList.toggle('selected', el.dataset.name === def.name && def.name !== rosterPick.confirmedName);
    }
    renderUnitDetail(def, rosterPick.party.find((u) => u.name === def.name));
  });
  // Hovering a roster card previews it in the detail window, overriding
  // whatever is selected/confirmed; leaving the grid entirely (not just
  // moving between cards) reverts the window back to that default.
  $('roster-grid').addEventListener('mouseover', (e) => {
    const card = e.target.closest('.roster-card');
    if (!card || !rosterPick) return;
    const def = rosterPick.roster[Number(card.dataset.i)];
    if (def) renderUnitDetail(def, rosterPick.party.find((u) => u.name === def.name));
  });
  $('roster-grid').addEventListener('mouseleave', () => {
    if (!rosterPick) return;
    const def = rosterPick.roster.find((r) => r.name === rosterPick.selectedName);
    if (def) renderUnitDetail(def, rosterPick.party.find((u) => u.name === def.name));
  });
  function closeRoster() {
    rosterEl.classList.add('hidden');
    rosterPick = null;
  }
  function rosterOpen() { return !rosterEl.classList.contains('hidden'); }

  // ----- the unit detail window (start screen, below the roster grid) -------
  // Portrait + backstory on the left; one section per ability with its name,
  // description and upgrade tree. `unit` (a live party member, when the
  // character is in the party) supplies the unlocked nodes to light up.
  function renderUnitDetail(def, unit = null) {
    const el = $('unit-detail');
    if (!def) { el.innerHTML = ''; return; }
    const unlocked = new Set(unit?.upgrades ?? []);
    const sections = unitAbilityIds(def.name).map((id) => {
      const ab = ABILITIES[id];
      if (!ab) return '';
      return `<div class="ud-ability">
        <div class="ud-ab-head"><span class="ud-ab-icon">${ab.icon}</span><b>${escapeHtml(abilityName(id))}</b></div>
        <div class="ud-ab-desc">${escapeHtml(tc(`ability.${id}.desc`, config))}</div>
        ${abilityTreeSvg(id, unlocked)}
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="ud-left">
        <div class="ud-portrait">${def.icon}</div>
        <div class="ud-name">${escapeHtml(tn(def.name))}</div>
        <div class="ud-hp muted">${t('roster.hp', { n: def.hp })}</div>
        <div class="ud-story">${escapeHtml(t(`unit.${def.name}.story`))}</div>
      </div>
      ${sections}`;
  }

  // The upgrade tree as a small SVG: layered left to right (a node's column is
  // its longest requires-chain), edges behind, node states as classes
  // (owned / open / locked). Hover a node for its name + effect.
  function abilityTreeSvg(abilityId, unlocked) {
    const tree = upgradeTree(abilityId);
    if (!tree) return '';
    const { layers, edges } = treeLayout(abilityId);
    const W = 300, H = 116;
    const colW = layers.length > 1 ? (W - 64) / (layers.length - 1) : 0;
    const pos = {};
    layers.forEach((nodes, d) => nodes.forEach((n, i) => {
      pos[n] = { x: 32 + d * colW, y: Math.round((H - 26) * (i + 1) / (nodes.length + 1)) + 4 };
    }));
    const isOpen = (n) => (tree[n].requires ?? []).every((p) => unlocked.has(upgradeRef(abilityId, p)));
    const lines = edges.map(([a, b]) =>
      `<line x1="${pos[a].x}" y1="${pos[a].y}" x2="${pos[b].x}" y2="${pos[b].y}"></line>`).join('');
    const nodes = Object.keys(tree).map((n) => {
      const p = pos[n];
      const cls = unlocked.has(upgradeRef(abilityId, n)) ? 'owned' : isOpen(n) ? 'open' : 'locked';
      const name = t(`upgrade.${abilityId}.${n}.name`);
      const desc = t(`upgrade.${abilityId}.${n}.desc`);
      return `<g class="ut-node ${cls}">
        <circle cx="${p.x}" cy="${p.y}" r="9"><title>${escapeHtml(`${name} - ${desc}`)}</title></circle>
        <text x="${p.x}" y="${p.y + 21}">${escapeHtml(name)}</text>
      </g>`;
    }).join('');
    return `<svg class="ability-tree" viewBox="0 0 ${W} ${H}">${lines}${nodes}</svg>`;
  }

  return { update, renderLog, setHover, showEnd, hideEnd, openDialog, closeDialog, dialogOpen, flashDialog, confirm, chooseUnit, chooseUpgrade, chooseBlackMarketUpgrade, showBanner, buildLegend, buildFatigueBar, updateBlur, setStartScreen, setLayerSelector, openRoster, closeRoster, rosterOpen, setBattleMode, setDeployBar, updateBattle };
}

// Log parameters are stored language-neutral and resolved at render time:
//   { key, params }  -> a translated string,   { name }  -> a translated unit/enemy name,
//   { names: [...] } -> names joined,          { list: [...] } -> resolved items joined,
//   { hex }          -> a tile description.
function resolveParams(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k] = resolveValue(v);
  return out;
}
function resolveValue(v) {
  if (v && typeof v === 'object') {
    if ('key' in v) return t(v.key, resolveParams(v.params));
    if ('name' in v) return tn(v.name);
    if ('names' in v) return v.names.map(tn).join(', ');
    if ('list' in v) return v.list.map(resolveValue).join(', ');
    if ('hex' in v) return describeHex(v.hex);
  }
  return v;
}

// One row of the party panel. Where the power rating used to sit, the unit's
// two abilities are shown; "+n" counts that ability's unlocked upgrades, and
// the tooltip lists them by name.
// ===================================================================
//  THE UNIT CARD
//  One shape, both sides. The party panel on the left and the enemy roster on
//  the right draw the SAME card so a unit is read the same way whoever it
//  belongs to; only the frame colour and the relic slot differ.
//
//    [portrait]  Name              [ab][ab][relic]
//                24 / 40 HP
//    =========== health bar, full width ===========
//    [st][st][st][st][st][st][st]
//
//  Every slot is drawn even when empty: an empty slot says "something can go
//  here", which is how the player learns a unit HAS a relic slot before ever
//  finding a relic. Statuses are always seven, because seven is what fits.
// ===================================================================
const STATUS_SLOTS = 7;

// One square slot. `filled` is the glyph, or null for a vacant socket.
function slotBox(cls, filled, tip) {
  const title = tip ? ` title="${escapeAttr(tip)}"` : '';
  return filled
    ? `<span class="u-slot ${cls}"${title}>${filled}</span>`
    : `<span class="u-slot ${cls} empty"${title}></span>`;
}

// The row of status sockets under the bar. `list` comes from src/status.js, so
// the card and the plaque over the unit's head always agree.
function statusRow(list) {
  const cells = [];
  for (let i = 0; i < STATUS_SLOTS; i++) {
    const hs = list[i];
    cells.push(hs
      ? `<span class="u-st" title="${escapeAttr(statusTipText(hs))}">${hs.icon}${badgeNumber(hs) ? `<i>${badgeNumber(hs)}</i>` : ''}</span>`
      : '<span class="u-st empty"></span>');
  }
  return `<div class="u-statuses">${cells.join('')}</div>`;
}

// The shared body of a card. `slots` is the right-hand row (abilities, then the
// relic for a party member); `statuses` is what src/status.js reports.
function unitCardBody({ portrait, name, hpText, pct, segPct, slots, statuses }) {
  return `<div class="u-top">
      <div class="icon">${portrait}</div>
      <div class="u-text">
        <div class="u-name">${escapeHtml(name)}</div>
        <span class="u-hp">${escapeHtml(hpText)}</span>
      </div>
      <div class="u-slots">${slots}</div>
    </div>
    <div class="bar"><div class="fill" style="width:${pct}%"></div><div class="segs" style="--seg:${segPct}%"></div></div>
    ${statusRow(statuses)}`;
}

// A party member. `live` is its instance inside the combat engine when a fight
// is running - the only place its shields and stuns exist; out of a fight there
// is none and every status socket is simply empty.
function unitCard(u, config, index, live) {
  const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
  const segPct = (config.party.hpSegment / u.maxHp) * 100;
  const cls = !u.alive ? 'dead' : pct < 50 ? 'hurt' : '';
  const abs = unitAbilityIds(u.name).map((id) => {
    const ab = ABILITIES[id];
    if (!ab) return slotBox('ab', null, t('slot.ability.empty'));
    const owned = (u.upgrades ?? []).filter((r) => r.startsWith(`${id}:`));
    const names = owned.map((r) => t(`upgrade.${r.replace(':', '.')}.name`)).join(', ');
    const tip = `${abilityName(id)}${names ? ` - ${names}` : ''}`;
    return slotBox('ab', `${ab.icon}${owned.length ? `<b>+${owned.length}</b>` : ''}`, tip);
  });
  // Two ability slots even for a unit that somehow has fewer, so every card in
  // the panel lines up.
  while (abs.length < 2) abs.push(slotBox('ab', null, t('slot.ability.empty')));
  // The relic slot. Relics do not exist yet; the socket is here so the space is
  // designed for from the start rather than bolted on later.
  abs.push(slotBox('relic', u.relic?.icon ?? null, u.relic ? tn(u.relic.name) : t('slot.relic.empty')));
  return `<div class="unit ${cls}" data-party="${index}">
    ${unitCardBody({
      portrait: u.icon,
      name: tn(u.name),
      hpText: u.alive ? t('party.hp', { hp: u.hp, max: u.maxHp }) : t('party.disabled'),
      pct, segPct, slots: abs.join(''), statuses: statusesFor(live),
    })}
  </div>`;
}

// ----- small helpers -------------------------------------------------
// Where a line from the rectangle's centre towards (tx, ty) leaves the rectangle.
// (The tutorial's pointer does the same thing for its card - src/tutorial.js.)
function rectEdgeToward(r, tx, ty) {
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? (r.width / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (r.height / 2) / Math.abs(dy) : Infinity;
  const k = Math.min(sx, sy);
  return { x: cx + dx * k, y: cy + dy * k };
}

// Current UI scale (the --ui-scale variable applied to #hud). Shared with the guide.
export function uiScale() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}
function hex(n) {
  return '#' + n.toString(16).padStart(6, '0');
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function flash(button, text) {
  const old = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = old; }, 1200);
}
