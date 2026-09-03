// =====================================================================
//  VIRTUAL PLAYTESTER - the headless combat harness.
//
//  Runs ONE interactive fight with no browser, no UI and no waiting: the same
//  combat engine the game ships (src/local/battle/engine.js) in its `instant`
//  mode, driven by a BOT that acts only through the public player API
//  (activate / selectAbility / clickTile / endTurn) and sees only what the
//  battle state shows a player. Nothing here reaches into private rules, so
//  the statistics are about the game people actually play.
//
//  Everything is seeded and reproducible: the same (seed, group, party spec,
//  bot) always replays the same fight. The arena mirrors a live one: the same
//  local map generator, the same elevation wave, the same "random distinct
//  tiles" unit placement the arena view uses.
//
//  Two entry points:
//    runFight()  the gym's standalone fight (phase 1): fresh group, record out
//    runArena()  the shared core: play prepared defs on a fresh arena - the
//                world runner (phase 2) feeds it every fight of a full run
// =====================================================================
import { createRng } from '../../src/rng.js';
import { createBattle } from '../../src/local/battle/engine.js';
import { COMBAT_CONFIG } from '../../src/config/abilities.js';
import { generateLocalMap, applyElevationWave, pickRandomTiles } from '../../src/local/localmap.js';
import { makeGroup } from '../../src/battle.js';
import { resolvedAbilitiesFor, availableUpgrades, unlockUpgrade } from '../../src/upgrades.js';

// Builds a live party from the roster: `names` from config.party.roster,
// `upgradeCount` random-but-seeded tree unlocks spread across the party -
// the gym's stand-in for "how far into a run this fight happens".
export function buildParty(config, names, upgradeCount, rng) {
  const roster = config.party.roster ?? [];
  const party = names.map((name) => {
    const def = roster.find((r) => r.name === name);
    if (!def) throw new Error(`unknown roster character: ${name}`);
    return { name: def.name, icon: def.icon, hp: def.hp, maxHp: def.hp, upgrades: [], alive: true };
  });
  // Unlock like a run does: one pick at a time, each from what is CURRENTLY
  // available (so capstones only ever follow their parents), on a random unit.
  for (let i = 0; i < upgradeCount; i++) {
    const candidates = party.filter((u) => availableUpgrades(u).length);
    if (!candidates.length) break;
    const u = rng.pick(candidates);
    unlockUpgrade(u, rng.pick(availableUpgrades(u)).ref);
  }
  return party;
}

// The shared arena core: builds a fresh local map, places the given unit defs
// (party defs must carry partyIndex + abilityDefs, enemy defs come from the
// bestiary), plays the whole fight with `bot` in instant mode and returns what
// happened. Every roll inside the battle comes from a seeded rng, so the same
// arguments always replay the same fight.
export function runArena({ config, partyDefs, enemyDefs, seed, bot, forced = false,
                           partyDamageMod = 0, noFlee = false }) {
  const rng = createRng(seed);
  const botRng = createRng(seed ^ 0x9e3779b9);   // the bot's own dice, replayable separately

  // The arena, exactly as the live game builds one: local grid + elevation
  // wave snapped to levels around the neutral middle step.
  const map = generateLocalMap(config);
  applyElevationWave(map, rng.random, COMBAT_CONFIG.combat.elevationLevels);
  const heights = {};
  for (const tile of map.hexes.values()) heights[tile.key] = tile.elevation;

  // Placement mirrors localview.placeUnits (random distinct tiles), with one
  // guard the live game does NOT have yet: everyone spawns inside the same
  // walkable component of the height graph. Day-one gym finding: the wave can
  // produce 1-tile pillars and sealed plateaus (every step off them is a 2+
  // level cliff no ground unit may take), and a fight with someone spawned
  // there can never end - the engine has no flee and no reachability check.
  // The harness filters those spawns so the statistics measure the fights, not
  // the soft-locks; the game itself needs the same guard in placeUnits.
  const walkable = largestWalkableComponent(map, heights);
  const spots = pickRandomTiles(map, partyDefs.length + enemyDefs.length, rng.random,
    new Set([...map.hexes.keys()].filter((k) => !walkable.has(k))));
  const partyKeys = spots.slice(0, partyDefs.length);
  const enemyKeys = spots.slice(partyDefs.length);

  let outcome = null;
  const t0 = performance.now();
  const battle = createBattle({
    config: COMBAT_CONFIG,
    radius: config.local.radius,
    heights,
    party: partyDefs,
    enemies: enemyDefs,
    partyKeys, enemyKeys,
    forced,
    partyDamageMod,
    noFlee,
    rng: rng.random,             // every combat roll seeded and replayable
    instant: true,               // the whole point of the harness
    onEnd: (won) => { outcome = won ? 'won' : 'lost'; },
  });

  // The play loop: the bot spends the player phase, endTurn() runs the whole
  // enemy phase synchronously (instant mode), repeat. The turn cap only
  // catches a policy that stops making progress - the record says so.
  const MAX_TURNS = 200;
  let turns = 0;
  while (!battle.state.over && turns < MAX_TURNS) {
    turns += 1;
    const roundBefore = battle.state.round;
    const ambushBefore = battle.state.ambush;
    playPlayerPhase(battle, bot, botRng);
    if (battle.state.over) break;
    // When every unit cast, the phase auto-ended and the round ALREADY
    // advanced inside the last click; calling endTurn() then would throw the
    // new round away. Only end it when this round's phase is still open.
    if (battle.state.phase === 'player' && battle.state.round === roundBefore && battle.state.ambush === ambushBefore) {
      battle.endTurn();
    }
  }
  const durMs = performance.now() - t0;

  return {
    battle,
    outcome: outcome ?? 'timeout',
    won: outcome === 'won',
    rounds: battle.state.round,
    enemiesLeft: battle.state.units.filter((u) => u.isEnemy && u.hp > 0).length,
    enemiesFled: battle.state.units.filter((u) => u.isEnemy && u.fled).length,
    durMs: Math.round(durMs * 10) / 10,
  };
}

// One standalone gym fight. Returns a plain record for the JSONL log.
//   config       the game CONFIG (possibly patched by an experiment)
//   groupId      an id from config.battle.enemyGroups
//   party        live units from buildParty (mutated: wounds land on it)
//   seed         drives the arena, the placement and every combat roll
//   bot          { name, actUnit(battle, unit, rng, helpers) } from bots.mjs
//   forced       true = the fight opens with the enemy AMBUSH phase
export function runFight({ config, groupId, party, seed, bot, forced = false }) {
  const enemies = makeGroup(config.battle, groupId);
  if (!enemies.length) throw new Error(`unknown enemy group: ${groupId}`);

  const partyDefs = party.map((u, i) => ({
    name: u.name, icon: u.icon, hp: u.hp, maxHp: u.maxHp,
    partyIndex: i, alive: u.alive, abilityDefs: resolvedAbilitiesFor(u),
  })).filter((u) => u.alive && u.hp > 0);
  const enemyDefs = enemies.map((e) => ({ ...e }));

  const res = runArena({ config, partyDefs, enemyDefs, seed, bot, forced });

  // Wounds carry back like main.js does, so a campaign can chain fights.
  for (const u of res.battle.state.units) {
    if (u.partyIndex == null) continue;
    const p = party[u.partyIndex];
    if (p) { p.hp = u.hp; if (u.hp <= 0) p.alive = false; }
  }

  const partyMax = party.reduce((a, u) => a + u.maxHp, 0);
  const partyLeft = party.reduce((a, u) => a + Math.max(0, u.hp), 0);
  return {
    seed,
    groupId,
    title: enemies.title,
    bot: bot.name,
    forced,
    outcome: res.outcome,
    won: res.won,
    rounds: res.rounds,
    partyDeaths: party.filter((u) => !u.alive).length,
    partyHpLeftPct: Math.round((partyLeft / partyMax) * 100),
    enemiesLeft: res.enemiesLeft,
    enemiesFled: res.enemiesFled,
    enemyPower: enemies.reduce((a, e) => a + (e.power ?? 0), 0),
    durMs: res.durMs,
  };
}

// The largest set of tiles a GROUND unit can walk between (steps of more than
// 1 height level are walls, same rule as the engine's reach()). Spawning
// everyone inside one component keeps every fight finishable.
function largestWalkableComponent(map, heights) {
  const seen = new Set();
  let best = new Set();
  for (const start of map.hexes.keys()) {
    if (seen.has(start)) continue;
    const comp = new Set([start]);
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const k = queue.pop();
      const [q, r] = k.split(',').map(Number);
      for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]) {
        const nk = `${q + dq},${r + dr}`;
        if (seen.has(nk) || !map.hexes.has(nk)) continue;
        if (Math.abs((heights[nk] ?? 0) - (heights[k] ?? 0)) > 1) continue;
        seen.add(nk); comp.add(nk); queue.push(nk);
      }
    }
    if (comp.size > best.size) best = comp;
  }
  return best;
}

// Spends the player phase: gives every living, not-yet-done unit to the bot
// exactly once. A unit the bot cannot use simply stays put; the phase may also
// end by itself when every unit has cast - in instant mode that runs the whole
// enemy phase AND opens the next round inside the last click, so the loop also
// stops the moment the round number moves on.
function playPlayerPhase(battle, bot, botRng) {
  const sb = battle.state;
  const round = sb.round;
  const ambush = sb.ambush;
  const seen = new Set();
  let guard = 0;
  while (sb.phase === 'player' && !sb.over && sb.round === round && sb.ambush === ambush && guard++ < 24) {
    const next = sb.units.find((u) => !u.isEnemy && u.hp > 0 && !u.done && !seen.has(u.uid));
    if (!next) break;
    seen.add(next.uid);
    battle.activate(next.uid);
    const c = battle.curPlayer();
    if (!c || c.uid !== next.uid) continue;   // e.g. stunned out of its turn
    bot.actUnit(battle, c, botRng);
  }
}
