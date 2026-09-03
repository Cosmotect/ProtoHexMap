// =====================================================================
//  VIRTUAL PLAYTESTER - the world runner (phase 2: full headless runs).
//
//  Plays ONE complete campaign in Node: a real Game (src/game.js) on a real
//  generated worldflake, every fight fought on a real arena by a combat bot
//  (phase 1's runArena), every window the game opens answered by a persona
//  (phase 3's worldbot). No UI, no waiting, fully seeded.
//
//  The wiring mirrors src/main.js:
//    - game.combatDelegate plays the prepared fight on a local map in the
//      engine's instant mode, writes the wounds back onto the party by
//      partyIndex and calls finishCombat({ won, rounds, interactive: true })
//    - 'dialog' events are QUEUED during an action and answered after it
//      returns - the same "window opens, then the player clicks" order the
//      UI has, through the same public calls the buttons make
//      (claimSupplies / upgradeOffers + applyUpgradePick / shopBuy /
//      restoreUnit / blackMarketOffers + blackMarketDeal)
//
//  Two deliberate divergences from the live game, both cosmetic to the rules:
//    - no deployment step: units spawn on random tiles (walkable-component
//      guarded) instead of being placed by hand
//    - voidEdgeKeys is empty: the arena has no story-scripted void edges
// =====================================================================
import { Game } from '../../src/game.js';
import { createRng } from '../../src/rng.js';
import { resolvedAbilitiesFor } from '../../src/upgrades.js';
import { runArena } from './headless.mjs';
import { decideTurn, pickUpgrade, shopSpree, totalUpgrades } from './worldbot.mjs';

// One full run. Returns { record, picks }:
//   record  one 'run' JSONL line: outcome, turns, fights, deaths, end reason
//   picks   'pick' decision lines: what was offered vs what was taken - the
//           Slay-the-Spire lesson: per-decision records, not just outcomes
export function runWorld({ config, seed, persona, bot, maxTurns = 500 }) {
  const game = new Game(config, seed);
  const personaRng = createRng(seed ^ 0x51f15eed);
  const picks = [];
  const fights = [];
  const dialogQueue = [];
  let gates = 0;

  game.on((type, payload) => {
    if (type === 'dialog') dialogQueue.push(payload);
  });

  // ---- the combat delegate: main.js's beginInteractiveBattle, headless ----
  let fightNo = 0;
  game.combatDelegate = (ctx) => {
    fightNo += 1;
    const arenaSeed = (seed ^ Math.imul(fightNo, 0x9e3779b9)) >>> 0;
    const partyDefs = game.state.party.map((u, i) => ({
      name: u.name, icon: u.icon, hp: u.hp, maxHp: u.maxHp,
      partyIndex: i, alive: u.alive, abilityDefs: resolvedAbilitiesFor(u),
    })).filter((u) => u.alive && u.hp > 0);
    const enemyDefs = ctx.enemies.map((e) => ({ ...e }));

    const res = runArena({
      config, partyDefs, enemyDefs, seed: arenaSeed, bot,
      forced: !!ctx.forced,
      partyDamageMod: ctx.damageMod ?? 0,
      noFlee: !!ctx.stasis,        // Seed / Colony garrisons never break and run
    });

    // Wounds land on the real party (finishCombat reads deaths off it).
    for (const u of res.battle.state.units) {
      if (u.partyIndex == null) continue;
      const p = game.state.party[u.partyIndex];
      if (p) p.hp = u.hp;
    }

    fights.push({
      turn: game.state.turn,
      title: ctx.title ?? null,
      stasis: !!ctx.stasis,
      forced: !!ctx.forced,
      enemies: enemyDefs.length,
      outcome: res.outcome,        // 'timeout' shows up here, counts as a loss
      rounds: res.rounds,
      enemiesFled: res.enemiesFled,
    });
    game.finishCombat(ctx, { won: res.won, rounds: res.rounds, interactive: true });
    return true;
  };

  // ---- dialog answers (the persona's clicks) ----------------------------
  const takeUpgradePicks = (count, source) => {
    for (let i = 0; i < count; i++) {
      const offers = game.upgradeOffers();
      if (!offers.length) break;
      const offer = pickUpgrade(offers, personaRng);
      if (!game.applyUpgradePick(offer)) break;
      picks.push({
        kind: 'pick', source, turn: game.state.turn,
        offered: offers.map((o) => o.ref), picked: offer.ref, unit: game.state.party[offer.index]?.name,
      });
    }
  };

  const handleDialog = (d) => {
    switch (d.kind) {
      case 'battle': {
        const r = d.result;
        if (r?.won && r.reward === 'upgrade') takeUpgradePicks(r.rewardPicks ?? 1, 'battle');
        break;
      }
      case 'supplies': {
        const campFirst = !!d.canCamp && d.overflow >= persona.campOnOverflowMin;
        game.claimSupplies(campFirst);
        break;
      }
      case 'shop':
        shopSpree(game, persona, personaRng, (source) => takeUpgradePicks(1, source));
        break;
      case 'acolyte': {
        const idx = game.state.party.findIndex((u) => !u.alive);
        if (idx >= 0) game.restoreUnit(idx);
        break;
      }
      case 'blackmarket': {
        if (!persona.blackMarket) break;
        // Deal on the healthiest unit that still has something to learn.
        const cands = game.state.party
          .map((u, index) => ({ u, index }))
          .filter((e) => e.u.alive && e.u.hp / e.u.maxHp > 0.6);
        cands.sort((a, b) => b.u.hp / b.u.maxHp - a.u.hp / a.u.maxHp);
        for (const c of cands) {
          const offers = game.blackMarketOffers(c.index);
          if (!offers.length) continue;
          const chosen = personaRng.pick(offers);
          if (game.blackMarketDeal(c.index, chosen.ref)) {
            picks.push({
              kind: 'pick', source: 'blackmarket', turn: game.state.turn,
              offered: offers.map((o) => o.ref), picked: chosen.ref, unit: game.state.party[c.index]?.name,
            });
          }
          break;
        }
        break;
      }
      case 'gate': gates += 1; break;    // layer unlocks are meta-progression, nothing to answer
      default: break;                    // 'event' etc.: already applied by the rules
    }
  };
  const processDialogs = () => {
    while (dialogQueue.length) handleDialog(dialogQueue.shift());
  };

  // ---- the run loop ------------------------------------------------------
  const t0 = performance.now();
  const mem = { skip: new Set(), badFog: new Set(), desperate: false };
  let stallReason = null;
  let refusals = 0;
  let iterations = 0;
  const maxIterations = maxTurns * 6;   // enter/camp/fog-bumps do not advance the turn counter

  processDialogs();   // a scenario could greet the start; harmless when empty
  while (game.state.status === 'playing'
         && game.state.turn < maxTurns
         && iterations++ < maxIterations) {
    const action = decideTurn(game, persona, mem);
    if (action.type === 'idle') {
      // Nothing sensible left to do: the run is stalled. That is a FINDING
      // about the policy or the map, not an error.
      stallReason = action.reason;
      break;
    }
    let acted = false;
    if (action.type === 'enter') acted = game.enter(false);
    else if (action.type === 'camp') acted = game.makeCamp();
    else if (action.type === 'move') acted = game.moveTo(action.hex);
    processDialogs();
    if (!acted) {
      // A step into the fog the rules refused = an impassable tile found the
      // way a player finds one (by clicking it). Remember and route around.
      if (action.type === 'move' && !action.hex.revealed) {
        mem.badFog.add(action.hex.key);
        continue;
      }
      mem.skip.add(game.state.position.key);
      if (++refusals > 8) { stallReason = `refused-${action.type}`; break; }
    } else {
      refusals = 0;
    }
  }
  const durMs = performance.now() - t0;

  const s = game.state;
  const outcome = s.status === 'won' ? 'won'
    : s.status === 'lost' ? 'lost'
    : stallReason ? 'stalled'
    : 'maxTurns';

  const record = {
    kind: 'run',
    seed,
    persona: persona.name,
    bot: bot.name,
    outcome,
    endReason: Array.isArray(s.endReason) ? s.endReason[0] : (stallReason ?? null),
    turns: s.turn,
    fights: fights.length,
    fightsWon: fights.filter((f) => f.outcome === 'won').length,
    fightTimeouts: fights.filter((f) => f.outcome === 'timeout').length,
    forcedFights: fights.filter((f) => f.forced).length,
    encountersCleared: s.encountersCleared,
    coloniesCleared: s.coloniesCleared,
    gatesFound: gates,
    deaths: game.deadUnits().length,
    upgradesTotal: totalUpgrades(game),
    suppliesLeft: s.supplies,
    upgradePicks: picks.length,
    durMs: Math.round(durMs),
    fightLog: fights,
  };
  return { record, picks };
}
