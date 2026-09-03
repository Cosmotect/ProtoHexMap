// =====================================================================
//  VIRTUAL PLAYTESTER - the world bot (phase 3: personas + overworld policy).
//
//  A PERSONA is a parameter set describing a way to play the campaign layer:
//  how much danger it walks into, when it camps, what it buys, whether it
//  gambles at the black market, how strong it wants to be before assaulting
//  the Stasis Seed. The decision logic below is shared; the parameters make
//  three recognisably different players out of it:
//
//    cautious  fights only what looks safe, camps early, hoards supplies,
//              grinds upgrades before daring the Seed
//    bold      the intended baseline: takes calculated risks, shops, deals
//    rusher    beelines for the Seed as soon as it is found - the speedrun
//              lower bound (if THIS wins often, the map is too easy)
//
//  Everything acts through Game's public API (reachable / dangerRank /
//  fatigueAfterNextStep / moveTo / enter / makeCamp / shopBuy / ...), exactly
//  the surface the UI's clicks go through - no reads of hidden map state:
//  the bot only ever looks at REVEALED tiles, like a player squinting at fog.
// =====================================================================
import { neighbors } from '../../src/hex.js';
import { upgradeCount } from '../../src/upgrades.js';

export const PERSONAS = {
  cautious: {
    name: 'cautious',
    courageBase: 1,        // max chevrons it willingly enters at 0 upgrades
    courageGrowth: 4,      // +1 courage per this many total party upgrades (0 = never)
    campHp: 0.65,          // camp when avg living HP fraction drops below this
    supplyReserve: 4,      // never spend below this many supplies on extras
    fatigueCaution: 20,    // above this fatigue %, route around forceable tiles
    campOnOverflowMin: 2,  // camp-first before claiming a find losing >= this
    shopList: ['spareParts', 'rest', 'upgrade', 'relic', 'map'],
    blackMarket: false,
    seedUpgrades: 14,      // total upgrades wanted before heading for the Seed
    detourBattles: true,   // seek out revealed fights within courage
  },
  bold: {
    name: 'bold',
    courageBase: 2,
    courageGrowth: 5,
    campHp: 0.45,
    supplyReserve: 2,
    fatigueCaution: 40,
    campOnOverflowMin: 3,
    shopList: ['spareParts', 'upgrade', 'relic', 'rest', 'rumors'],
    blackMarket: true,
    seedUpgrades: 9,
    detourBattles: true,
  },
  rusher: {
    name: 'rusher',
    courageBase: 8,        // fears nothing
    courageGrowth: 0,
    campHp: 0.3,
    supplyReserve: 0,
    fatigueCaution: 101,   // never routes around anything
    campOnOverflowMin: 99,
    shopList: [],
    blackMarket: false,
    seedUpgrades: 0,       // the moment the Seed shows, go
    detourBattles: false,
  },
};

const COMBAT_ENCOUNTERS = new Set(['battle', 'stasisColony', 'stasisSeed']);

export function totalUpgrades(game) {
  return game.state.party.reduce((a, u) => a + upgradeCount(u), 0);
}

// Courage grows with the party: a late-run cautious player does dare more.
export function courageOf(game, persona) {
  const growth = persona.courageGrowth ? Math.floor(totalUpgrades(game) / persona.courageGrowth) : 0;
  return persona.courageBase + growth;
}

const avgHpFraction = (game) => {
  const living = game.livingUnits();
  if (!living.length) return 0;
  return living.reduce((a, u) => a + u.hp / u.maxHp, 0) / living.length;
};

// Is there anything this persona could and would buy here right now?
function shopWorthEntering(game, persona, hex) {
  if (!hex.shop) return true;   // stock unknown until first entry - go look
  return persona.shopList.some((id) =>
    !game.shopBlocker(hex, id) && game.state.supplies - game.shopCost(id) >= persona.supplyReserve);
}

// Would the persona ENTER the encounter on this tile? (Standing on it or
// weighing a detour towards it - same judgement.)
function wantsEncounter(game, persona, hex, { desperate = false } = {}) {
  const type = hex.encounter;
  if (!type) return false;
  if (COMBAT_ENCOUNTERS.has(type)) {
    return desperate || game.dangerRank(hex) <= courageOf(game, persona);
  }
  if (type === 'shop') return shopWorthEntering(game, persona, hex);
  if (type === 'acolyte') return game.deadUnits().length > 0;
  return true;   // treasure / event / gate - free value, always
}

// ----- pathfinding over the fog -----------------------------------------
// BFS over REVEALED, passable tiles. Intermediate tiles the persona refuses
// to stand on (fights above its courage; forceable encounters while fatigued)
// are walls unless they are the destination itself. The DESTINATION may be an
// unrevealed tile (that is what exploring IS with revealRadius 0: stepping
// into the fog) - whether it is even passable is learned by trying, like a
// player clicking a fogged tile. Returns the path (start excluded) or null.
function pathTo(game, persona, targetKey, avoid) {
  const start = game.state.position;
  if (start.key === targetKey) return [];
  const prev = new Map([[start.key, null]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const [q, r] of neighbors(cur.q, cur.r)) {
      const h = game.hexAt(q, r);
      if (!h || prev.has(h.key)) continue;
      if (h.key !== targetKey && (!h.revealed || !h.passable || avoid(h))) continue;
      prev.set(h.key, cur);
      if (h.key === targetKey) {
        const path = [h];
        let p = cur;
        while (p && p.key !== start.key) { path.unshift(p); p = prev.get(p.key); }
        return path;
      }
      if (h.revealed) queue.push(h);   // fog is only ever a final step
    }
  }
  return null;
}

// What to avoid standing on while merely passing through.
function makeAvoid(game, persona) {
  const courage = courageOf(game, persona);
  const fatigued = game.state.fatigue > persona.fatigueCaution;
  return (h) => {
    if (!h.encounter) return false;
    if (COMBAT_ENCOUNTERS.has(h.encounter) && game.dangerRank(h) > courage) return true;
    if (fatigued && game.isForceable(h.encounter)) return true;
    return false;
  };
}

// Destinations worth walking to, best first: the Seed (when strong enough),
// wanted revealed encounters, then EXPLORATION - with revealRadius 0 that
// means unrevealed tiles next to known ground, stepped into blind. When a
// distant goal is known (the Seed), fog nearest to IT is opened first, so the
// rusher explores towards the Seed instead of snailing outward evenly.
function targetCandidates(game, persona, mem) {
  const out = [];
  const seed = game.map.seed;
  const seedKnown = seed && seed.revealed && seed.encounter === 'stasisSeed';
  const seedReady = seedKnown && totalUpgrades(game) >= persona.seedUpgrades;

  if (seedReady) out.push({ key: seed.key, why: 'seed' });

  // Revealed encounters the persona wants (skip tiles it already stood on and
  // passed over - they would loop it forever).
  const wanted = [];
  for (const h of game.map.hexes.values()) {
    if (!h.revealed || !h.encounter || mem.skip.has(h.key)) continue;
    if (COMBAT_ENCOUNTERS.has(h.encounter) && !persona.detourBattles) continue;
    if (!wantsEncounter(game, persona, h)) continue;
    wanted.push(h);
  }
  wanted.sort((a, b) => game.distanceFrom(a) - game.distanceFrom(b));
  for (const h of wanted.slice(0, 4)) out.push({ key: h.key, why: 'encounter' });

  // Exploration: unrevealed tiles bordering revealed passable ground, minus
  // the ones already tried and found impassable (mem.badFog - the bot LEARNS
  // where the water is by bumping into it, like a player clicking the fog).
  const fog = new Map();
  for (const h of game.map.hexes.values()) {
    if (!h.revealed || !h.passable) continue;
    for (const [q, r] of neighbors(h.q, h.r)) {
      const n = game.hexAt(q, r);
      if (n && !n.revealed && !mem.badFog.has(n.key)) fog.set(n.key, n);
    }
  }
  const goal = seedKnown ? seed : game.state.position;
  const fogList = [...fog.values()]
    .sort((a, b) => (hexDistOf(a, goal) * 4 + game.distanceFrom(a)) - (hexDistOf(b, goal) * 4 + game.distanceFrom(b)));
  for (const h of fogList.slice(0, 6)) out.push({ key: h.key, why: 'explore' });

  // Nothing left to explore or want: the last resort is the Seed itself,
  // ready or not - better a doomed assault than standing still.
  if (seedKnown && !seedReady) out.push({ key: seed.key, why: 'desperate' });
  return out;
}

// One overworld decision. Returns:
//   { type: 'enter' }            enter the encounter under our feet
//   { type: 'camp' }             make camp here
//   { type: 'move', hex, why }   step onto `hex`
//   { type: 'idle', reason }     nothing sensible left - the run stalls
export function decideTurn(game, persona, mem) {
  const s = game.state;
  const pos = s.position;

  // Standing on an encounter we want: take it. (The desperate flag lets the
  // final Seed assault through the courage gate.)
  if (pos.encounter && wantsEncounter(game, persona, pos, { desperate: mem.desperate })) {
    return { type: 'enter' };
  }
  if (pos.encounter) mem.skip.add(pos.key);   // stood here, passed - do not orbit it

  // Camp when hurt (rules: only on empty tiles, and never below the reserve).
  const campCost = game.config.rest.cost;
  if (!pos.encounter && avgHpFraction(game) < persona.campHp
      && s.supplies >= campCost + persona.supplyReserve) {
    return { type: 'camp' };
  }

  // Walk the candidate list until one is actually reachable: a wanted target
  // with no known path yet simply loses to exploring (which will open one).
  const avoid = makeAvoid(game, persona);
  for (const target of targetCandidates(game, persona, mem)) {
    // A caution-refused path falls back to a plain shortest path - moving on
    // regardless beats stalling in place.
    const steps = pathTo(game, persona, target.key, avoid)
      ?? pathTo(game, persona, target.key, () => false);
    if (!steps || !steps.length) continue;
    const first = steps[0];
    if (game.canMoveTo(first)) {
      if (target.why === 'desperate') mem.desperate = true;
      return { type: 'move', hex: first, why: target.why };
    }
    // The first step is unaffordable (a climb with empty pockets): take any
    // legal neighbour that does not move away from the target.
    const targetHex = game.map.hexes.get(target.key);
    const options = game.reachable()
      .filter((h) => !h.revealed ? !mem.badFog.has(h.key) : true)
      .sort((a, b) => hexDistOf(a, targetHex) - hexDistOf(b, targetHex));
    if (options.length && hexDistOf(options[0], targetHex) <= hexDistOf(pos, targetHex)) {
      return { type: 'move', hex: options[0], why: `${target.why}-detour` };
    }
  }
  return { type: 'idle', reason: 'no-path' };
}

const hexDistOf = (a, b) => {
  const dq = a.q - b.q, dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
};

// ----- dialog decisions --------------------------------------------------
// The persona's answers to the windows the game opens. Called by the world
// runner with each queued dialog AFTER the triggering action returned - the
// same "window is open, player clicks" order the UI has.

// Which upgrade offer to take. Deliberately simple for now: a seeded random
// pick, so pick-rate statistics measure what the GAME offers, not a build
// meta the bot invented. (A value-driven chooser is a future persona knob.)
export function pickUpgrade(offers, rng) {
  return rng.pick(offers);
}

// Spend the shop: walk the persona's priority list, buy while it helps and
// the reserve holds. Returns the list of items bought (upgrade purchases are
// finished by the caller - the pick screen follows the purchase).
export function shopSpree(game, persona, rng, onUpgradePick) {
  const bought = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const id of persona.shopList) {
      const hex = game.state.position;
      if (hex.encounter !== 'shop') break;   // sold out mid-spree: tile consumed
      if (game.shopBlocker(hex, id)) continue;
      if (game.state.supplies - game.shopCost(id) < persona.supplyReserve) continue;
      let unitIndex;
      if (id === 'spareParts') {
        unitIndex = game.state.party.findIndex((u) => !u.alive);
        if (unitIndex < 0) continue;
      }
      if (!game.shopBuy(id, unitIndex)) continue;
      bought.push(id);
      if (id === 'upgrade' || id === 'relic') onUpgradePick('shop');
      progress = true;
      break;   // re-walk the priority list from the top
    }
  }
  return bought;
}
