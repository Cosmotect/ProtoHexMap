// The HUD: plain HTML elements layered over the 3D canvas.
// (In Godot terms: a CanvasLayer with Labels and Buttons.)
import { describeHex, lerpTable } from './game.js';
import { terrainInfo, terrainName, encounterLabel, encounterInfo, tc } from './text.js';
import { t, tn } from './i18n.js';
import { playFatigueStep, playFatigueClear } from './audio.js';

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
  };

  // ----- buttons -----------------------------------------------------
  $('btn-new').addEventListener('click', () => handlers.onNewMap());
  $('btn-restart').addEventListener('click', () => handlers.onRestart());
  $('btn-reveal').addEventListener('click', () => handlers.onRevealAll());
  $('btn-enter').addEventListener('click', () => handlers.onEnter());
  $('btn-menu').addEventListener('click', () => toggleMenu());
  $('btn-settings').addEventListener('click', () => { closeMenu(); handlers.onOpenSettings(); });
  $('btn-npe').addEventListener('click', () => { closeMenu(); handlers.onStartNpe(); });
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
    if (e.key === 'c' || e.key === 'C') handlers.onToggleCamera();
    if (e.key === 'n' || e.key === 'N') handlers.onNewMap();
    if (e.key === 'r' || e.key === 'R') handlers.onRestart();
    if (e.key === 'e' || e.key === 'E') handlers.onEnter();
    if (e.key === 'Escape') { closeMenu(); handlers.onEscape && handlers.onEscape(); }
  });

  let currentSeed = 0;

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
  for (const [name, b] of Object.entries(config.biomes)) {
    const note = (b.hpCost ?? 0) > 0 ? t('legend.costHp', { hp: b.hpCost }) : '';
    legendItems.push({ swatch: `<span class="swatch" style="background:${hex(b.color)}"></span>`, label: `${t(`biome.${name}`)}${note}`, info: tc(`biome.${name}.info`, config) });
  }
  for (const [type, v] of Object.entries(config.encounters.visuals)) {
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
    const stagger = config.audio.clearStaggerMs;
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
    syncFatigueBar(game);
    const action = game.enterAction();
    els.enter.disabled = !action.enabled;
    els.enter.textContent = action.label;
    els.enter.title = action.reason || (action.kind === 'camp' ? tc('status.camp.title', config) : t('status.enter.title'));
    els.enter.classList.toggle('camp', action.kind === 'camp');
    els.party.innerHTML = s.party.map((u) => unitCard(u, config)).join('');
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
    let cost = '';
    if (!hex.passable) cost = t('hover.impassable');
    else if (hex.supplyCost > 0) cost = t('hover.cost', { supplies: hex.supplyCost, hp: hex.hpCost, bonus: hex.revealBonus });
    else if (hex.hpCost > 0) cost = t('hover.costHp', { hp: hex.hpCost });
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
    if (hex.revealed && hex.encounter) {
      const rule = game.fatigueResetRule(hex.encounter);
      const note = game.fatigueResetNote(hex.encounter);
      const label = game.labelFor(hex.encounter);
      const ruleText = rule === 'always' ? t('tip.reset.always', { label })
        : rule === 'optional' ? (note ? t('tip.reset.optional.note', { label, note }) : t('tip.reset.optional', { label }))
        : t('tip.reset.never', { label });
      parts.push(`<div class="tip-small">${escapeHtml(ruleText)}</div>`);
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
          sub: u.alive ? t('dialog.unit.sub', { hp: u.hp, max: u.maxHp, power: u.power }) : t('dialog.unit.disabled'),
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

  // Centre-screen banner (forced encounters). Hides itself after `ms`.
  let bannerTimer = null;
  function showBanner(text, ms) {
    els.banner.textContent = text;
    els.banner.classList.remove('hidden');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => els.banner.classList.add('hidden'), ms);
  }

  return { update, renderLog, setHover, showEnd, hideEnd, openDialog, closeDialog, dialogOpen, flashDialog, confirm, chooseUnit, showBanner, buildLegend, buildFatigueBar, updateBlur };
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

// One row of the party panel.
function unitCard(u, config) {
  const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
  const segPct = (config.party.hpSegment / u.maxHp) * 100;
  const cls = !u.alive ? 'dead' : pct < 50 ? 'hurt' : '';
  return `<div class="unit ${cls}">
    <div class="icon">${u.icon}</div>
    <div class="info">
      <div class="name-row"><span class="name">${escapeHtml(tn(u.name))}</span><span class="power">${t('party.power', { n: u.power })}</span></div>
      <span class="hp">${u.alive ? t('party.hp', { hp: u.hp, max: u.maxHp }) : t('party.disabled')}</span>
      <div class="bar"><div class="fill" style="width:${pct}%"></div><div class="segs" style="--seg:${segPct}%"></div></div>
    </div>
  </div>`;
}

// ----- small helpers -------------------------------------------------
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
