// =====================================================================
//  WORLD MAP RULES TEST - the 2026-09-22 rework, checked headlessly.
//
//    node tools/worldmap-test.mjs
//
//  Covers the three rules the rework introduced:
//    1. fatigue disabled -> walking onto a forceable encounter ALWAYS forces it
//    2. supplies reaching 0 ends the run...
//    3. ...unless the step landed on a forced encounter that can still pay, in
//       which case the verdict waits for that encounter's result
//  plus maxSupplies being its own config knob.
// =====================================================================
const base = new URL('../src/', import.meta.url).href;
const { CONFIG } = await import(base + 'config.js');
const { Game } = await import(base + 'game.js');

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); else console.log(`  ok  ${msg}`); };

// A fresh run on a known seed, with the map bent to whatever the test needs.
function newGame(seed = 1) {
  return new Game(CONFIG, seed);
}

// Clear the tile the party stands on and its neighbours, so a test can place
// exactly what it wants next to them without the generator's opinions.
function clearAround(game) {
  const p = game.state.position;
  for (const h of game.map.hexes.values()) {
    if (Math.max(Math.abs(h.q - p.q), Math.abs(h.r - p.r), Math.abs((h.q + h.r) - (p.q + p.r))) <= 1) {
      h.encounter = null;
      h.enemies = null;
      h.type = 'ground';
      h.passable = true;
      h.terrainHeight = 0;
      h.revealed = true;
    }
  }
}

function neighborOf(game, hex) {
  return game.reachable().find((h) => h !== hex);
}

console.log('config');
check(CONFIG.fatigue.enabled === false, 'fatigue is disabled');
check(CONFIG.run.maxSupplies !== undefined, 'run.maxSupplies exists as its own entry');
check(CONFIG.run.maxSupplies !== CONFIG.run.startSupplies,
  `maxSupplies (${CONFIG.run.maxSupplies}) is independent of startSupplies (${CONFIG.run.startSupplies})`);
check((CONFIG.run.stepSupplyCost ?? 0) > 0, 'every step costs supplies');

console.log('\nstate');
{
  const g = newGame();
  check(g.state.maxSupplies === CONFIG.run.maxSupplies, 'the run starts with maxSupplies from the config, not from startSupplies');
  check(g.state.supplies === CONFIG.run.startSupplies, 'the run starts with startSupplies');
  check(g.fatigueEnabled() === false, 'game.fatigueEnabled() reports the experiment');
  const n = g.reachable()[0];
  check(g.stepCost(n).supplyCost >= CONFIG.run.stepSupplyCost, 'a flat step charges the walking cost');
}

console.log('\nrule 1: a forceable encounter always fires');
{
  const g = newGame();
  clearAround(g);
  let forcedEvents = 0;
  g.on((type) => { if (type === 'forced') forcedEvents += 1; });
  const target = g.reachable()[0];
  target.encounter = 'battle';
  target.enemies = [{ name: 'Husk', hp: 1, power: 0, maxHp: 1 }];
  g.state.fatigue = 0;            // nothing to roll on - the old rule would never force
  g.state.fatigueSteps = 0;
  g.moveTo(target);
  check(forcedEvents === 1, 'stepping onto a battle emits "forced" with fatigue at 0');
  check(target.encounter === null, 'the fight actually happened (the tile is consumed)');
}
{
  const g = newGame();
  clearAround(g);
  let forcedEvents = 0;
  g.on((type) => { if (type === 'forced') forcedEvents += 1; });
  const target = g.reachable()[0];
  target.encounter = 'shop';
  target.shop = g.rollShopStock();
  g.moveTo(target);
  check(forcedEvents === 0, 'a shop is NOT forceable - it is still entered by choice');
  check(target.encounter === 'shop', 'the shop is still on its tile');
}
{
  const g = newGame();
  check(g.forcedChanceFor({ revealed: true, encounter: 'battle' })?.chance === 100,
    'the HUD is told a revealed battle is a certainty, not a percentage');
  check(g.forcedChanceFor({ revealed: false }) === null,
    'an unexplored tile promises nothing (it may hold nothing forceable at all)');
}

console.log('\nrule 2: an empty pack ends the run');
{
  const g = newGame();
  clearAround(g);
  const target = g.reachable()[0];
  g.state.supplies = CONFIG.run.stepSupplyCost;   // exactly enough for this one step
  g.moveTo(target);
  check(g.state.status === 'lost', 'the step that empties the pack ends the run');
  check(g.state.endReason[0] === 'end.supplies', `the end reason is out-of-supplies (got ${g.state.endReason[0]})`);
  check(g.state.supplies === 0, 'supplies floor at 0 rather than going negative');
}
{
  const g = newGame();
  clearAround(g);
  const target = g.reachable()[0];
  g.state.supplies = CONFIG.run.stepSupplyCost + 1;
  g.moveTo(target);
  check(g.state.status === 'playing', 'one supply left is still a run');
}
{
  // The step is LEGAL even when it cannot be paid for - that is the whole point.
  const g = newGame();
  clearAround(g);
  const target = g.reachable()[0];
  target.type = 'mountain';
  target.terrainHeight = 2;
  g.state.supplies = 1;
  check(g.canMoveTo(target), 'an unaffordable step is allowed (it is the last one)');
  check(g.stepEndsRun(target), 'and the HUD is told it ends the run');
}

console.log('\nrule 3: the verdict waits for a forced encounter that can still pay');
{
  // The party walks its last ration onto a forced fight - and wins. The salvage
  // (battle.victorySupplies) refills the pack, so the run goes on.
  const g = newGame();
  clearAround(g);
  const target = g.reachable()[0];
  target.encounter = 'battle';
  target.enemies = [{ name: 'Husk', hp: 1, power: 0, maxHp: 1 }];
  // An interactive delegate: the fight leaves for the arena and reports back
  // later, exactly as main.js does it.
  let pending = null;
  g.combatDelegate = (ctx) => { pending = ctx; return true; };
  g.state.supplies = CONFIG.run.stepSupplyCost;
  g.moveTo(target);
  check(g.state.status === 'playing', 'the run is NOT over while the fight is still on the arena');
  check(g.state.supplies === 0, 'the pack is empty in the meantime');
  g.finishCombat(pending, { won: true, rounds: 3, interactive: true });
  check(g.state.status === 'playing', 'winning the fight saves the run');
  check(g.state.supplies === (CONFIG.battle.victorySupplies ?? 0), 'the salvage is what saved it');
}
{
  // Same last step, same forced fight - lost. The party is wiped, so the run
  // ends on the defeat rather than on the supplies.
  const g = newGame();
  clearAround(g);
  const target = g.reachable()[0];
  target.encounter = 'battle';
  target.enemies = [{ name: 'Husk', hp: 1, power: 0, maxHp: 1 }];
  let pending = null;
  g.combatDelegate = (ctx) => { pending = ctx; return true; };
  g.state.supplies = CONFIG.run.stepSupplyCost;
  g.moveTo(target);
  check(g.state.status === 'playing', 'still playing while the fight runs');
  g.finishCombat(pending, { won: false, rounds: 3, interactive: true });
  check(g.state.status === 'lost', 'losing the fight ends the run');
}
{
  // A fight won that pays nothing: the verdict that was held back is given.
  const g = newGame();
  clearAround(g);
  const saved = CONFIG.battle.victorySupplies;
  CONFIG.battle.victorySupplies = 0;
  try {
    const target = g.reachable()[0];
    target.encounter = 'battle';
    target.enemies = [{ name: 'Husk', hp: 1, power: 0, maxHp: 1 }];
    let pending = null;
    g.combatDelegate = (ctx) => { pending = ctx; return true; };
    g.state.supplies = CONFIG.run.stepSupplyCost;
    g.moveTo(target);
    check(g.state.status === 'playing', 'held while the fight runs');
    g.finishCombat(pending, { won: true, rounds: 3, interactive: true });
    check(g.state.status === 'lost', 'a win that pays nothing still ends the run');
    check(g.state.endReason[0] === 'end.supplies', 'and it ends on the supplies, not the fight');
  } finally {
    CONFIG.battle.victorySupplies = saved;
  }
}
{
  // A cache is NOT forceable, so it grants no reprieve: the party arrives on the
  // tile with an empty pack and the run is over before they can open it. This is
  // the rule as asked for - only a FORCED encounter holds the verdict - and it is
  // asserted here so that changing one's mind about it is a deliberate act.
  const g = newGame();
  clearAround(g);
  const target = g.reachable()[0];
  target.encounter = 'treasure';
  g.state.supplies = CONFIG.run.stepSupplyCost;
  g.moveTo(target);
  check(g.state.status === 'lost', 'a cache the party never entered does not save them');
  check(g.state.endReason[0] === 'end.supplies', 'they run out of supplies standing on it');
}
{
  // A supplies OFFER that is already open does hold the verdict - that is the
  // shape a forced event takes when it pays in supplies (game.js offerSupplies).
  const g = newGame();
  clearAround(g);
  g.state.supplies = 0;
  g.offerSupplies(30, 'treasure.title', 'treasure.text', 'treasure');
  check(!!g.state.pendingSupplies, 'the find is offered');
  g.checkEndOfRun();
  check(g.state.status === 'playing', 'the run waits while the offer is open');
  g.claimSupplies(false);
  check(g.state.status === 'playing', 'taking the find saves the run');
  check(g.state.supplies === 30, 'the pack holds the find');
}
{
  // ...and an offer declined down to nothing gives the verdict on the way out.
  const g = newGame();
  clearAround(g);
  g.state.supplies = 0;
  g.offerSupplies(0, 'treasure.title', 'treasure.text', 'treasure');
  g.claimSupplies(false);
  check(g.state.status === 'lost', 'an offer worth nothing ends the run when it closes');
}

console.log('\nmaxSupplies is the ceiling');
{
  const g = newGame();
  g.state.supplies = g.state.maxSupplies - 1;
  const got = g.addSupplies(1000);
  check(got === 1, 'a gain is clipped to the ceiling');
  check(g.state.supplies === CONFIG.run.maxSupplies, `the ceiling is run.maxSupplies (${CONFIG.run.maxSupplies})`);
}

console.log('');
if (problems.length) {
  console.log(`FAILED (${problems.length}):`);
  for (const p of problems) console.log('  x ' + p);
  process.exit(1);
}
console.log('all world map rules pass');
