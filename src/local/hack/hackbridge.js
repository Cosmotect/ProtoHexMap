// =====================================================================
//  HACK ENCOUNTER - the bridge.              *** EXPERIMENT (see DESIGN.md) ***
//
//  The hack's equivalent of main.js's combat bridge (startCombatDive /
//  beginInteractiveBattle / finishInteractiveBattle), kept out of main.js so
//  the experiment stays in one folder. main.js only:
//    * creates this bridge once (createHackBridge),
//    * routes the Enter key to bridge.enter() when the tile holds a hack,
//    * sets game.hackDelegate = bridge.delegate,
//    * calls bridge.abort() where it aborts a fight (restart / new map).
//  The hack runs on the ORDINARY combat engine (createBattle) since
//  2026-09-15: no enemies, the node / mine tags dropped into its tag table,
//  and a `rules` object (hackrules.js) supplying the progress bar, the mine
//  and overkill effects and the end condition. Aim locks, the volley and the
//  damage billboards are the engine's and the arena's own.
// =====================================================================
import { HACK_CONFIG } from './hackconfig.js';
import { buildHackRecipe } from './hackmap.js';
import { createHackRules, makeHackTags } from './hackrules.js';
import { createHackView } from './hackview.js';
import { createBattle } from '../battle/engine.js';
import { resolvedAbilitiesFor, triggersFor } from '../../upgrades.js';

export const HACK_TYPE = 'hack';

export function createHackBridge({ config, getGame, getUi, cinematic, renderer, worldNeighborsFor, worldEdgesFor, escapeHtml }) {
  let hack = null;        // the running engine (createBattle with the hack rules)
  let hackCtx = null;     // the context game.startHack handed over
  let hackView = null;    // the extra presentation
  let pending = null;     // { hex, recipe } between the dive and the engine

  const H = HACK_CONFIG;
  const esc = escapeHtml ?? ((s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  // The Enter key on a hack tile: dive into the arena built from the hack
  // recipe, and let the game start the encounter at the peak of the clouds.
  function enter(hex, resume) {
    const game = getGame();
    if (!game || cinematic.isActive()) return false;
    const recipe = buildHackRecipe(H, game.seed, hex, game.livingUnits().length);
    pending = { hex, recipe };
    let turnBack = false;
    return cinematic.flyIn({
      worldHex: hex,
      baseColor: renderer.targetColorFor(hex).getHex(),
      party: game.livingUnits(),
      enemies: [],
      seed: game.seed,
      recipe,
      neighbors: worldNeighborsFor(hex),
      edges: worldEdgesFor(hex),
      deployParty: false,       // the recipe seats the party itself
      partySpread: 0,
      onSwap: () => {
        // The wither may have eaten the encounter while we were in the air.
        if (hex.encounter === HACK_TYPE) resume();
        else turnBack = true;
      },
      onArrived: () => {
        if (turnBack) { pending = null; cinematic.flyOut({}); }
        else if (hack) hack.start();
      },
    });
  }

  // game.hackDelegate: the game has prepared the encounter (ctx) and asks for
  // it to be played. Only possible with the arena on screen (or committed to).
  function delegate(ctx) {
    if (hack || !cinematic.inArena()) return false;
    const game = getGame();
    const ui = getUi();
    const view = cinematic.localView;
    const recipe = (pending && pending.hex === ctx.hex) ? pending.recipe
      : buildHackRecipe(H, game.seed, ctx.hex, game.livingUnits().length);
    pending = null;
    const partyDefs = game.state.party
      .map((u, i) => ({ name: u.name, icon: u.icon, hp: u.hp, maxHp: u.maxHp, partyIndex: i, alive: u.alive, abilityDefs: resolvedAbilitiesFor(u), triggers: triggersFor(u) }))
      .filter((u) => u.alive && u.hp > 0);
    const placement = view.beginBattle({ party: partyDefs, enemies: [] });
    hackCtx = ctx;
    const rules = createHackRules(H, { onFloater: (k, text, color) => view.addFloater(k, text, color) });
    hack = createBattle({
      config,
      radius: view.map?.radius ?? H.radius,
      heights: placement.heights,
      party: partyDefs,
      enemies: [],
      partyKeys: placement.partyKeys,
      enemyKeys: [],
      forced: false,
      deferOpening: true,
      noFlee: true,
      rules,
      // The board: nodes (barriers) and mines (hazards) as ordinary tags.
      tags: makeHackTags(H, recipe.nodeKeys, recipe.mineKeys),
      onChange: () => {
        view.syncBattle();
        ui.updateBattle();
        syncPartyPanel();
        if (hackView) hackView.refresh();
      },
      onFloater: (k, text, color) => view.addFloater(k, text, color),
      onLog: () => {},
      onAnim: (anim, done) => view.runMoveAnim(anim, done),
      onEnd: (won) => setTimeout(() => finish(won), 900),
    });
    hack.hackConfig = H;
    hack.layout = recipe.layout ?? null;
    window.__hack = hack;   // for debugging / automated tests
    view.bindBattle(hack);
    ui.setBattleMode(hack, { title: H.text.title, lore: null, debuffs: [] });
    hackView = createHackView({ view, hack, H });
    // The Local Map Info panel: its lore line is a locale KEY in a fight; the
    // hack's is plain text, so it is written straight into the element.
    const desc = document.getElementById('li-desc');
    if (desc) {
      desc.textContent = `${H.text.lore} Layout: ${recipe.layout?.name ?? '?'} - ${recipe.layout?.desc ?? ''}`;
      desc.classList.remove('hidden');
    }
    // The camera is already down (the encounter was started from inside the
    // arena): open at once. Mid-dive, onArrived does it on landing.
    if (cinematic.mode() === 'local') hack.start();
    return true;
  }

  // Wounds from mines show in the party panel as they happen.
  function syncPartyPanel() {
    if (!hack) return;
    const game = getGame();
    let changed = false;
    for (const u of hack.state.units) {
      if (u.partyIndex == null) continue;
      const p = game.state.party[u.partyIndex];
      if (p && p.hp !== u.hp) { p.hp = u.hp; changed = true; }
    }
    if (changed) getUi().update(game);
  }

  function finish(won) {
    if (!hack || !hackCtx) return;
    const game = getGame();
    const ui = getUi();
    const ctx = hackCtx;
    const h = hack;
    hack = null; hackCtx = null; window.__hack = null;
    for (const u of h.state.units) {
      if (u.partyIndex == null) continue;
      const p = game.state.party[u.partyIndex];
      if (p) p.hp = u.hp;
    }
    if (hackView) { hackView.dispose(); hackView = null; }
    ui.setBattleMode(null);
    cinematic.localView.endBattle();
    const rounds = h.state.round;
    const hx = h.state.ext.hack ?? { progress: 0, lostBy: null };
    if (won) {
      // The regular reward path: the battle dialog with an upgrade pick.
      ctx.opts.intro = { title: H.text.wonTitle, text: H.text.wonText };
      game.finishHack(ctx, { won: true, rounds });
    } else {
      game.finishHack(ctx, { won: false, rounds });
      // Our own small window; closing it flies the party back out (main.js
      // onDialogClosed does that for any dialog closed inside the arena).
      const text = hx.lostBy === 'mines' ? H.text.lostTextMines : H.text.lostTextTurns;
      ui.openDialog({
        title: H.text.lostTitle,
        html: `<p>${esc(text)}</p><div class="effect">${esc(`Hack progress ended at ${hx.progress > 0 ? '+' : ''}${hx.progress} after ${rounds} turn${rounds === 1 ? '' : 's'}.`)}</div>`,
        actions: [{ label: 'Continue', onClick: () => ui.closeDialog() }],
      });
    }
  }

  // Restart / new map while a hack is open: drop it, nothing is reported.
  function abort() {
    if (hackView) { hackView.dispose(); hackView = null; }
    if (hack) getUi()?.setBattleMode(null);
    hack = null; hackCtx = null; pending = null; window.__hack = null;
  }

  return { enter, delegate, abort, active: () => !!hack, TYPE: HACK_TYPE };
}
