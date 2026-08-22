// Entry point: glues together the rules (Game), the picture (MapRenderer) and the HUD (ui).
import './style.css';
import { CONFIG } from './config.js';
import { Game } from './game.js';
import { MapRenderer } from './render.js';
import { createUI } from './ui.js';
import { resolveSeed } from './rng.js';

const container = document.getElementById('scene');

// URL switches, handy for comparing variants without editing config.js:
//   ?seed=1234        same map every time
//   ?orient=flat      flat-top hexes instead of pointy-top
//   ?camera=ortho     start in the top-down camera
const params = new URLSearchParams(window.location.search);
if (params.get('orient') === 'flat') CONFIG.map.orientation = 'flat';

const renderer = new MapRenderer(container, CONFIG);
window.__renderer = renderer; // for debugging / automated tests
let game = null;
let pendingEnd = false;
let holdDialogsUntil = 0;

const ui = createUI(CONFIG, {
  onDialogClosed: () => { if (pendingEnd && game.state.status !== 'playing') { pendingEnd = false; ui.showEnd(game); } },
  onNewMap: () => startRun(resolveSeed()),
  onRestart: () => startRun(game.seed),
  onToggleCamera: () => ui.setCameraMode(renderer.toggleCameraMode()),
  onRevealAll: () => game.revealAll(),
  onEngage: () => { if (!renderer.busy && !ui.dialogOpen()) game.engage(false); },
  onLoadSeed: (value) => startRun(resolveSeed(value)),
});

function startRun(seed) {
  pendingEnd = false;
  ui.closeDialog();
  game = new Game(CONFIG, seed);
  window.game = game; // handy for poking at the state in the browser console

  // Keep the seed in the address bar so the link can be shared.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(seed));
    window.history.replaceState(null, '', url.toString());
  } catch {
    // Some embedded viewers do not allow changing the address bar. Not a problem.
  }

  game.on((type, payload) => {
    if (type === 'reveal') renderer.handleReveal(payload.hexes, game.state.position);
    if (type === 'move') renderer.handleMove(payload.from, payload.to);
    if (type === 'encounter') renderer.handleEncounterCleared(payload.hex);
    if (type === 'forced') {
      // Banner first; any dialog that follows waits forcedBannerMs.
      ui.showBanner(`Exhausted! Stumbled into ${payload.label}`, CONFIG.anim.forcedBannerMs + 900);
      holdDialogsUntil = performance.now() + CONFIG.anim.forcedBannerMs;
    }
    if (type === 'dialog') showDialog(payload);
    if (type === 'change') { renderer.syncState(); ui.update(game); }
    if (type === 'log') ui.renderLog(game);
    if (type === 'end') {
      const thisGame = game;
      // Let the hop finish before the overlay appears (and ignore it if a new run started meanwhile).
      // If a battle report / event is open, the end screen waits until it is closed.
      setTimeout(() => {
        if (thisGame !== game || game.state.status === 'playing') return;
        if (ui.dialogOpen()) pendingEnd = true; else ui.showEnd(game);
      }, CONFIG.anim.hopMs + 250);
    }
  });

  renderer.loadGame(game);
  ui.hideEnd();
  ui.update(game);
  ui.renderLog(game);
  ui.setCameraMode(renderer.cameraMode);
}

// ----- encounter dialogs (top centre) -----------------------------------
function showDialog(d) {
  const wait = holdDialogsUntil - performance.now();
  if (wait > 0) { setTimeout(() => showDialog(d), wait); return; }
  if (d.kind === 'event') {
    ui.openDialog({
      title: d.title,
      html: `<p>${escapeHtml(d.text)}</p><div class="effect">${escapeHtml(d.effect || '')}</div>`,
      actions: [{ label: 'Continue', onClick: () => ui.closeDialog() }],
    });
  } else if (d.kind === 'supplies') {
    // Supplies found. If they overflow, offer to make camp first (QoL).
    const actions = [];
    if (d.canCamp) {
      actions.push({
        label: `Make camp first (${d.campCost} supplies), then collect`,
        sub: `Heals the party, resets fatigue; ${Math.min(d.amount, d.amount - d.overflow + d.campCost)} of ${d.amount} will fit instead of ${d.amount - d.overflow}`,
        onClick: () => { game.claimSupplies(true); ui.closeDialog(); },
      });
    }
    actions.push({ label: `Collect ${d.overflow > 0 ? `${d.amount - d.overflow} of ${d.amount}` : d.amount} supplies`, onClick: () => { game.claimSupplies(false); ui.closeDialog(); } });
    ui.openDialog({
      title: d.title,
      html: `<p>${escapeHtml(d.text)}</p><div class="effect">${escapeHtml(d.effect)}</div>`,
      actions,
      onClose: () => { if (game.state.pendingSupplies) game.claimSupplies(false); },
    });
  } else if (d.kind === 'blackmarket') {
    ui.chooseUnit({
      title: d.title,
      html: `<p>${escapeHtml(d.text)}</p><div class="effect">${escapeHtml(d.effect)}</div>`,
      filter: (u) => u.alive,
      game,
      onPick: (i) => { game.blackMarketDeal(i); ui.closeDialog(); },
      extraActions: [{ label: 'Decline', sub: 'Walk away', onClick: () => ui.closeDialog() }],
    });
  } else if (d.kind === 'battle') {
    const r = d.result;
    const lines = [];
    let lastRound = 0;
    for (const l of r.lines) {
      if (l.round !== lastRound) { lines.push(`<div class="round">Round ${l.round}</div>`); lastRound = l.round; }
      lines.push(`<div class="${l.side}">${escapeHtml(l.text)}</div>`);
    }
    const enemies = r.enemies.map((e) => `${e.name} (${e.maxHp} HP, power ${e.power})`).join(', ');
    const intro = d.intro ? `<p>${escapeHtml(d.intro.text)}</p>` : '';
    ui.openDialog({
      title: d.intro ? d.intro.title : r.boss ? 'Boss battle' : 'Battle',
      html: `${intro}<div class="battle-sum ${r.won ? 'won' : 'lost'}">${r.won ? 'Victory' : 'Defeat'} after ${r.rounds} round${r.rounds === 1 ? '' : 's'}. ${r.partyFirst ? 'The party struck first.' : 'The enemies struck first (forced by fatigue).'}</div>
             <p class="muted">Enemies: ${escapeHtml(enemies)}</p><div class="battle-lines">${lines.join('')}</div>`,
      actions: [{
        label: r.reward ? `Continue: choose who gains +${r.reward} power` : 'Continue',
        onClick: () => {
          if (!r.reward) { ui.closeDialog(); return; }
          ui.chooseUnit({
            title: 'Lessons of battle',
            html: `<p>One unit gains +${r.reward} power.</p>`,
            filter: (u) => u.alive,
            game,
            onPick: (i) => { game.grantVictoryPower(i); ui.closeDialog(); },
          });
        },
      }],
    });
  } else if (d.kind === 'shop') {
    const build = (g) => ({
      title: 'Shop',
      html: `<p>Supplies: <b>${g.state.supplies}</b>. Fatigue: <b>${g.state.fatigue}%</b>.</p><span class="muted">The shop stays on this tile. Engaging it does not reset fatigue.</span>`,
      actions: [
        {
          label: `Rest (${CONFIG.shop.restCost} supplies)`, sub: 'Resets fatigue to 0%',
          disabled: g.state.supplies < CONFIG.shop.restCost || g.state.fatigue === 0,
          onClick: () => game.shopBuy('rest'),
        },
        {
          label: `Upgrade a unit (${CONFIG.shop.upgradeCost} supplies)`, sub: `+${CONFIG.shop.upgradeAmount} power on the unit you choose`,
          disabled: g.state.supplies < CONFIG.shop.upgradeCost,
          onClick: () => ui.chooseUnit({
            title: 'Upgrade which unit?',
            html: `<p>+${CONFIG.shop.upgradeAmount} power for ${CONFIG.shop.upgradeCost} supplies.</p>`,
            filter: (u) => u.alive,
            game,
            onPick: (i) => { game.shopBuy('upgrade', i); showDialog({ kind: 'shop' }); },
          }),
        },
        {
          label: `Local map (${CONFIG.shop.mapCost} supplies)`, sub: `Reveals about ${CONFIG.events.blobSize} nearby tiles`,
          disabled: g.state.supplies < CONFIG.shop.mapCost,
          onClick: () => game.shopBuy('map'),
        },
        { label: 'Leave', onClick: () => ui.closeDialog() },
      ],
      onRefresh: (g2) => ui.openDialog(build(g2)),
    });
    ui.openDialog(build(game));
  } else if (d.kind === 'acolyte') {
    ui.chooseUnit({
      title: 'Acolyte of the Great Forge',
      html: `<p>The forge can return one fallen companion, at ${Math.round(CONFIG.acolyte.reviveFraction * 100)}% of their health. Choose who.</p>`,
      filter: (u) => !u.alive,
      game,
      onPick: (i) => { game.restoreUnit(i); ui.closeDialog(); },
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

renderer.onHexClick = (hex) => {
  if (ui.dialogOpen()) return;
  if (renderer.busy) return;
  if (!game.moveTo(hex)) {
    if (game.state.status === 'playing' && hex !== game.state.position) {
      game.addLog(hex.passable ? 'Too far: you can only step to a neighbouring tile.' : 'That tile is impassable.');
    }
  }
};

renderer.onHexHover = (hex) => ui.setHover(hex, game);

if (params.get('camera') === 'ortho') renderer.toggleCameraMode();
startRun(resolveSeed(params.get('seed')));
