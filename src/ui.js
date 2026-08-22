// The HUD: plain HTML elements layered over the 3D canvas.
// (In Godot terms: a CanvasLayer with Labels and Buttons.)
import { describeHex } from './game.js';

export function createUI(config, handlers) {
  const $ = (id) => document.getElementById(id);

  const els = {
    fatigue: $('stat-fatigue'),
    party: $('party-units'),
    engage: $('btn-engage'),
    tip: $('fatigue-tip'),
    dialog: $('dialog'),
    banner: $('banner'),
    dialogTitle: $('dialog-title'),
    dialogBody: $('dialog-body'),
    dialogActions: $('dialog-actions'),
    gold: $('stat-gold'),
    supplies: $('stat-supplies'),
    turn: $('stat-turn'),
    seed: $('seed-value'),
    log: $('log'),
    hover: $('hover-info'),
    legend: $('legend'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayText: $('overlay-text'),
    help: $('help'),
    btnCamera: $('btn-camera'),
    pathInfo: $('path-info'),
  };

  // ----- buttons -----------------------------------------------------
  $('btn-new').addEventListener('click', () => handlers.onNewMap());
  $('btn-restart').addEventListener('click', () => handlers.onRestart());
  $('btn-camera').addEventListener('click', () => handlers.onToggleCamera());
  $('btn-reveal').addEventListener('click', () => handlers.onRevealAll());
  $('btn-engage').addEventListener('click', () => handlers.onEngage());
  $('btn-help').addEventListener('click', () => els.help.classList.toggle('hidden'));
  $('btn-help-close').addEventListener('click', () => els.help.classList.add('hidden'));
  $('dialog-close').addEventListener('click', () => closeDialog());
  $('btn-overlay-restart').addEventListener('click', () => { hideEnd(); handlers.onRestart(); });
  $('btn-overlay-new').addEventListener('click', () => { hideEnd(); handlers.onNewMap(); });
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
      flash($('btn-copy'), 'Copied');
    } catch {
      window.prompt('Copy this link:', url.toString());
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'c' || e.key === 'C') handlers.onToggleCamera();
    if (e.key === 'h' || e.key === 'H' || e.key === '?') els.help.classList.toggle('hidden');
    if (e.key === 'n' || e.key === 'N') handlers.onNewMap();
    if (e.key === 'r' || e.key === 'R') handlers.onRestart();
    if (e.key === 'e' || e.key === 'E') handlers.onEngage();
    if (e.key === 'Escape') { els.help.classList.add('hidden'); closeDialog(); }
  });

  let currentSeed = 0;

  // The fatigue popup follows the mouse.
  let mouse = { x: 0, y: 0 };
  window.addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (!els.tip.classList.contains('hidden')) placeTip();
  });
  function placeTip() {
    const pad = 16;
    let x = mouse.x + pad, y = mouse.y + pad;
    const w = els.tip.offsetWidth, h = els.tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = mouse.x - w - pad;
    if (y + h > window.innerHeight - 8) y = mouse.y - h - pad;
    els.tip.style.left = `${x}px`;
    els.tip.style.top = `${y}px`;
  }

  // ----- legend ------------------------------------------------------
  const legendItems = [];
  for (const [name, t] of Object.entries(config.terrain)) {
    const note = !t.passable ? ' (blocked)' : t.supplyCost > 0 ? ` (${t.supplyCost} supplies, ${t.hpCost} HP)` : '';
    legendItems.push(`<span class="swatch" style="background:${hex(t.color)}"></span>${cap(name)}${note}`);
  }
  for (const [name, v] of Object.entries(config.encounters.visuals)) {
    legendItems.push(`<span class="swatch marker" style="background:${hex(v.color)}"></span>${v.label}`);
  }
  legendItems.push(`<span class="swatch" style="background:${hex(config.colors.fogTile)}"></span>Unexplored`);
  els.legend.innerHTML = legendItems.map((s) => `<div>${s}</div>`).join('');

  // ----- public API --------------------------------------------------
  function update(game) {
    const s = game.state;
    currentSeed = game.seed;
    // Current fatigue = the chance rolled when you arrive on your next tile.
    els.fatigue.textContent = `${s.fatigue}%`;
    els.fatigue.classList.toggle('warn', s.fatigue >= 25);
    const action = game.engageAction();
    els.engage.disabled = !action.enabled;
    els.engage.textContent = action.label;
    els.engage.title = action.reason || (action.kind === 'camp'
      ? 'Spend supplies to make camp here: heals every living unit by half its max HP and resets fatigue (E)'
      : 'Enter the encounter on the tile you stand on (E)');
    els.engage.classList.toggle('camp', action.kind === 'camp');
    els.party.innerHTML = s.party.map((u) => unitCard(u, config)).join('');
    // Keep an open dialog in sync (e.g. shop prices after a purchase).
    if (dialogRefresh) dialogRefresh(game);
    els.gold.textContent = String(s.gold);
    els.supplies.textContent = `${s.supplies} / ${s.maxSupplies}`;
    els.supplies.classList.toggle('warn', s.supplies <= 3 && s.status === 'playing');
    els.turn.textContent = String(s.turn);
    els.seed.textContent = String(game.seed);
    els.pathInfo.textContent = `shortest route ${s.shortestPathLength} steps`;
  }

  function renderLog(game) {
    const last = game.log.slice(-7);
    els.log.innerHTML = last
      .map((entry, i) => `<div class="${i === last.length - 1 ? 'latest' : ''}">${escapeHtml(entry.text)}</div>`)
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
      els.hover.textContent = `Unexplored (${hex.q},${hex.r})`;
      return;
    }
    const canGo = game.canMoveTo(hex);
    let cost = '';
    if (!hex.passable) cost = ', impassable';
    else if (hex.supplyCost > 0) cost = `, costs ${hex.supplyCost} supplies and ${hex.hpCost} HP per unit, reveals +${hex.revealBonus}`;
    const seen = hex.terrainHeight > 0 ? `, visible from ${hex.terrainHeight} tile${hex.terrainHeight === 1 ? '' : 's'} further` : '';
    els.hover.textContent = `${describeHex(hex, config)}${cost}${seen}${canGo ? ' - click to move' : ''}`;
  }

  // Small popup near the cursor: chance of a forced encounter if the party walks there
  // (current fatigue, the HUD number), fatigue after that step, and what the tile's
  // encounter does to fatigue.
  function updateFatigueTip(hex, game) {
    const s = game.state;
    const next = game.fatigueAfterNextStep();
    const show = s.status === 'playing' && (s.fatigue > 0 || next > 0) && game.canMoveTo(hex);
    if (!show) { els.tip.classList.add('hidden'); return; }
    const forced = game.forcedChanceFor(hex); // null = revealed tile that cannot force anything
    const parts = [];
    if (forced && !hex.revealed) {
      parts.push(`<div class="tip-big"><b>${forced.chance}%</b> forced encounter</div><div class="tip-sub">if a battle or event hides on this unexplored tile</div>`);
    } else if (forced) {
      parts.push(`<div class="tip-big"><b>${forced.chance}%</b> forced encounter</div>`);
    }
    parts.push(`<div class="tip-small">Fatigue after this step: <b>${next}%</b> (now ${s.fatigue}%)</div>`);
    if (hex.revealed && hex.encounter) {
      const rule = game.fatigueResetRule(hex.encounter);
      const note = game.fatigueResetNote(hex.encounter);
      const ruleText = rule === 'always' ? 'resets fatigue'
        : rule === 'optional' ? `may reset fatigue${note ? ` (${note})` : ''}`
        : 'does not reset fatigue';
      parts.push(`<div class="tip-small">${escapeHtml(game.labelFor(hex.encounter))}: ${ruleText}</div>`);
    }
    els.tip.innerHTML = parts.join('');
    els.tip.classList.remove('hidden');
    placeTip();
  }

  function showEnd(game) {
    const s = game.state;
    els.overlayTitle.textContent = s.status === 'won' ? 'Run complete' : 'Run over';
    els.overlayText.textContent = s.endReason;
    els.overlay.classList.remove('hidden');
  }

  function hideEnd() {
    els.overlay.classList.add('hidden');
  }

  function setCameraMode(mode) {
    els.btnCamera.textContent = mode === 'perspective' ? 'Camera: perspective' : 'Camera: top-down';
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

  // Generic "choose a unit" dialog, reused by the shop and the Acolyte.
  // filter(unit) decides which units are selectable; onPick(index) gets the choice.
  // extraActions: additional buttons after the units (e.g. "Decline").
  function chooseUnit({ title, html, filter, onPick, game, extraActions = [] }) {
    const build = (g) => ({
      title,
      html,
      actions: [
        ...g.state.party.map((u, i) => ({
          label: `${u.icon} ${u.name}`,
          sub: u.alive ? `${u.hp}/${u.maxHp} HP, power ${u.power}` : 'fallen',
          disabled: !filter(u),
          onClick: () => onPick(i),
        })),
        ...extraActions,
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

  return { update, renderLog, setHover, showEnd, hideEnd, setCameraMode, openDialog, closeDialog, dialogOpen, chooseUnit, showBanner };
}

// One row of the party panel.
function unitCard(u, config) {
  const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
  const segPct = (config.party.hpSegment / u.maxHp) * 100;
  const cls = !u.alive ? 'dead' : pct < 50 ? 'hurt' : '';
  return `<div class="unit ${cls}">
    <div class="icon">${u.icon}</div>
    <div class="info">
      <div class="name-row"><span class="name">${escapeHtml(u.name)}</span><span class="power">power ${u.power}</span></div>
      <span class="hp">${u.alive ? `${u.hp} / ${u.maxHp} HP` : 'FALLEN'}</span>
      <div class="bar"><div class="fill" style="width:${pct}%"></div><div class="segs" style="--seg:${segPct}%"></div></div>
    </div>
  </div>`;
}

// ----- small helpers -------------------------------------------------
function hex(n) {
  return '#' + n.toString(16).padStart(6, '0');
}
function cap(s) {
  return s[0].toUpperCase() + s.slice(1);
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
function flash(button, text) {
  const old = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = old; }, 1200);
}
