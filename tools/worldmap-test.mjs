// =====================================================================
//  WORLD MAP RULES TEST - headless rules checks for src/game.js and the
//  encounter placer, in seconds rather than minutes.
//
//    node tools/worldmap-test.mjs        (npm run test:worldmap)
//
//  The world-map twin of tools/engine-test.mjs: the smoke test drives the real
//  browser and stays the authority on anything the player can SEE, but a rule is
//  far easier to state as a hand-built tile than as a click path.
//
//  What is pinned here:
//    * the 2026-09-22 rework - fatigue disabled means forceable encounters
//      always fire; maxSupplies is its own knob; every step costs supplies
//    * the 2026-09-27 rework - encounters may sit on costly terrain; a step the
//      pack cannot cover is paid in the tile's own HP; an empty pack no longer
//      ends the run; and below the starvation line every step rolls for an
//      ambush whose band escalates with each one that has fired
//
//  Each case builds the tiles it needs by hand (clearAround / makeTile), so
//  nothing depends on what the generator happened to roll for a seed.
// =====================================================================
const base = new URL('../src/', import.meta.url).href;
const { CONFIG } = await import(base + 'config.js');
const { Game } = await import(base + 'game.js');
const { generateMap } = await import(base + 'map.js');
const { createRng } = await import(base + 'rng.js');

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); else console.log(`  ok  ${msg}`); };
const section = (name) => console.log(`\n${name}`);

function newGame(seed = 1) {
  return new Game(CONFIG, seed);
}

// Flatten the party's tile and its six neighbours to plain empty ground, so a
// test can put exactly what it means to test next to them.
function clearAround(game) {
  const p = game.state.position;
  for (const h of game.map.hexes.values()) {
    if (Math.max(Math.abs(h.q - p.q), Math.abs(h.r - p.r), Math.abs((h.q + h.r) - (p.q + p.r))) <= 1) {
      h.encounter = null;
      h.enemies = null;
      h.recipe = null;
      h.type = 'ground';
      h.passable = true;
      h.terrainHeight = 0;
      h.supplyCost = 0;
      h.revealed = true;
    }
  }
}

// Turn one neighbour into a tile of the given type, the way the generator would.
function makeTile(game, hex, type) {
  const t = CONFIG.tileTypes[type];
  hex.type = type;
  hex.passable = t.passable;
  hex.supplyCost = t.supplyCost ?? 0;
  hex.terrainHeight = t.terrainHeight ?? 0;
  hex.revealed = true;
  return hex;
}

// A fight that always ends the way the test wants, without an arena.
function withDelegate(game, won) {
  game.combatDelegate = (ctx) => {
    game.finishCombat(ctx, { won, rounds: 1, interactive: true });
    return true;
  };
}

section('config');
check(CONFIG.fatigue.enabled === false, 'fatigue is disabled');
check(CONFIG.run.maxSupplies !== CONFIG.run.startSupplies,
  `maxSupplies (${CONFIG.run.maxSupplies}) is its own knob, not startSupplies (${CONFIG.run.startSupplies})`);
check((CONFIG.run.stepSupplyCost ?? 0) > 0, 'every step costs supplies');
check((CONFIG.run.starvationThreshold ?? 0) > 0, 'there is a starvation threshold');
check((CONFIG.run.starvationAmbushChance ?? 0) > 0, 'a starving step can be ambushed');

section('encounters may sit on costly terrain (2026-09-27)');
{
  // The placer used to skip every tile with a supply cost, which left hills and
  // mountains permanently empty. Checked over enough seeds that a map simply
  // rolling few mountains cannot pass it by accident.
  let costly = 0;
  let mountains = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const map = generateMap(CONFIG, createRng(seed), CONFIG.layers.startLayer);
    for (const h of map.hexes.values()) {
      if (!h.encounter || h.isSeed) continue;
      if ((h.supplyCost ?? 0) > 0) costly += 1;
      if (h.type === 'mountain') mountains += 1;
    }
  }
  check(costly > 0, `encounters land on hills and mountains (${costly} over 25 maps)`);
  check(mountains > 0, `mountains specifically get them too (${mountains})`);
}
{
  // ...but the three reserved tiles are still off limits.
  let bad = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const map = generateMap(CONFIG, createRng(seed), CONFIG.layers.startLayer);
    for (const h of map.hexes.values()) {
      if (h.encounter && (!h.passable || h.isStart)) bad += 1;
    }
  }
  check(bad === 0, 'nothing is placed on the start tile or on impassable ground');
}

section('a forceable encounter always fires');
{
  const g = newGame();
  clearAround(g);
  let forced = 0;
  g.on((type) => { if (type === 'forced') forced += 1; });
  withDelegate(g, true);
  const target = g.reachable()[0];
  target.encounter = 'battle';
  target.enemies = [{ name: 'Husk', hp: 1, maxHp: 1, power: 0 }];
  g.moveTo(target);
  check(forced === 1, 'stepping onto a battle forces it, with fatigue at 0');
  check(target.encounter === null, 'and the tile is consumed by the fight');
}
{
  const g = newGame();
  clearAround(g);
  let forced = 0;
  g.on((type) => { if (type === 'forced') forced += 1; });
  const target = g.reachable()[0];
  target.encounter = 'shop';
  target.shop = g.rollShopStock();
  g.moveTo(target);
  check(forced === 0, 'a shop is not forceable - it is still entered by choice');
  check(target.encounter === 'shop', 'and it stays on its tile');
}

section('paying a step in blood (2026-09-27)');
{
  const g = newGame();
  clearAround(g);
  const flat = g.reachable()[0];
  g.state.supplies = 0;
  const cost = g.stepCost(flat);
  check(cost.unpaid === true, 'a step the pack cannot cover is marked unpaid');
  check(cost.supplySpent === 0, 'nothing is taken from an empty pack');
  check(cost.hpCost === 0, 'flat ground asks for no blood either - walking home broke is free');
  check(g.canMoveTo(flat), 'and the step is still legal');
}
// NOTE (2026-09-27): every tile type currently carries hpCost: 0, so this rule
// costs nothing in today's config - it is armed, not firing. These cases charge
// the mountain a real HP price for their duration so the LOGIC is tested rather
// than trivially passing; the moment someone puts blood back on high ground, the
// rule is already wired and these tests already cover it.
const MTN_HP = 5;
function withMountainBlood(fn) {
  const saved = CONFIG.tileTypes.mountain.hpCost;
  CONFIG.tileTypes.mountain.hpCost = MTN_HP;
  try { fn(); } finally { CONFIG.tileTypes.mountain.hpCost = saved; }
}
check(CONFIG.tileTypes.mountain.hpCost === 0,
  'FYI: no tile type charges HP today, so the rule below is armed but never fires in play');
withMountainBlood(() => {
  const g = newGame();
  clearAround(g);
  const mtn = makeTile(g, g.reachable()[0], 'mountain');
  g.state.supplies = 0;
  const hpBefore = g.state.party[0].hp;
  const cost = g.stepCost(mtn);
  check(cost.unpaid === true, 'an unaffordable mountain is unpaid');
  check(cost.hpCost === MTN_HP, `it costs the mountain's own ${MTN_HP} HP instead`);
  g.moveTo(mtn);
  check(g.state.party[0].hp === hpBefore - MTN_HP, 'and that blood is actually taken');
  check(g.state.supplies === 0, 'supplies floor at 0 rather than going negative');
});
withMountainBlood(() => {
  // The climb gate is a discount for a party that can pay. A solvent party
  // crossing between two mountains pays nothing; a broke one pays anyway.
  const g = newGame();
  clearAround(g);
  makeTile(g, g.state.position, 'mountain');
  const ridge = makeTile(g, g.reachable()[0], 'mountain');
  g.state.supplies = 50;
  check(g.stepCost(ridge).hpCost === 0, 'ridge-walking costs a solvent party nothing');
  g.state.supplies = 0;
  check(g.stepCost(ridge).hpCost === MTN_HP, 'but a broke party pays the mountain even walking across the top');
});

section('an empty pack no longer ends the run (2026-09-27)');
{
  const g = newGame();
  clearAround(g);
  // Nothing on the tiles and no ambushes, so only the supply rule could end it.
  const saved = CONFIG.run.starvationAmbushChance;
  CONFIG.run.starvationAmbushChance = 0;
  try {
    g.state.supplies = 1;
    for (let i = 0; i < 6 && g.state.status === 'playing'; i++) {
      clearAround(g);
      g.moveTo(g.reachable()[0]);
    }
    check(g.state.status === 'playing', 'the party walks on with an empty pack');
    check(g.state.supplies === 0, 'the pack is empty');
    check(!String(g.state.endReason).includes('supplies'), 'and nothing ended on supplies');
  } finally {
    CONFIG.run.starvationAmbushChance = saved;
  }
}

section('starving on the road: the ambush');
{
  const g = newGame();
  clearAround(g);
  const saved = CONFIG.run.starvationAmbushChance;
  CONFIG.run.starvationAmbushChance = 1;     // certain, so the test is not a coin flip
  try {
    let dialogs = [];
    g.on((type, p) => { if (type === 'dialog') dialogs.push(p); });
    g.state.supplies = 1;
    g.moveTo(g.reachable()[0]);
    check(dialogs.some((d) => d.kind === 'starvation'), 'a starving step opens the ambush window');
    check(!!g.state.pendingAmbush, 'and the fight waits for the player to close it');
    check(g.state.starvationAmbushes === 1, 'the run counts it');
  } finally {
    CONFIG.run.starvationAmbushChance = saved;
  }
}
{
  // Above the threshold: never.
  const g = newGame();
  clearAround(g);
  const saved = CONFIG.run.starvationAmbushChance;
  CONFIG.run.starvationAmbushChance = 1;
  try {
    g.state.supplies = CONFIG.run.starvationThreshold + 5;
    let fired = false;
    g.on((type, p) => { if (type === 'dialog' && p.kind === 'starvation') fired = true; });
    g.moveTo(g.reachable()[0]);
    check(!fired, 'a well-stocked party is never ambushed for starving');
  } finally {
    CONFIG.run.starvationAmbushChance = saved;
  }
}
{
  // A tile that forces its own encounter takes the step: no ambush on top.
  const g = newGame();
  clearAround(g);
  const saved = CONFIG.run.starvationAmbushChance;
  CONFIG.run.starvationAmbushChance = 1;
  try {
    withDelegate(g, true);
    const target = g.reachable()[0];
    target.encounter = 'battle';
    target.enemies = [{ name: 'Husk', hp: 1, maxHp: 1, power: 0 }];
    g.state.supplies = 1;
    let fired = false;
    g.on((type, p) => { if (type === 'dialog' && p.kind === 'starvation') fired = true; });
    g.moveTo(target);
    check(!fired, 'a tile that already dragged them in is not also an ambush');
    check(g.state.starvationAmbushes === 0, 'and the ladder does not advance');
  } finally {
    CONFIG.run.starvationAmbushChance = saved;
  }
}

section('the ambush ladder climbs and then holds');
{
  const bands = Object.keys(CONFIG.battle.enemies.bands);
  const g = newGame();
  check(g.starvationBandFor(1) === bands[0], `the first ambush comes from "${bands[0]}"`);
  check(g.starvationBandFor(2) === bands[1], `the second from "${bands[1]}"`);
  check(g.starvationBandFor(3) === bands[2], `the third from "${bands[2]}"`);
  check(g.starvationBandFor(4) === bands[bands.length - 1], 'the fourth stays on the last band');
  check(g.starvationBandFor(99) === bands[bands.length - 1], 'and so does the ninety-ninth');
}
{
  // End to end: three ambushes in one run, each a real fight, each escalating.
  const g = newGame();
  const saved = CONFIG.run.starvationAmbushChance;
  CONFIG.run.starvationAmbushChance = 1;
  try {
    const seen = [];
    g.on((type, p) => { if (type === 'dialog' && p.kind === 'starvation') seen.push(p.band); });
    withDelegate(g, true);
    for (let i = 0; i < 3; i++) {
      clearAround(g);
      g.state.supplies = 1;
      g.moveTo(g.reachable().find((h) => !h.encounter));
      check(!!g.state.pendingAmbush, `ambush ${i + 1} is announced`);
      g.resolveStarvationAmbush();
      check(!g.state.pendingAmbush, `ambush ${i + 1} resolved into a fight`);
    }
    const bands = Object.keys(CONFIG.battle.enemies.bands);
    check(JSON.stringify(seen) === JSON.stringify(bands.slice(0, 3)),
      `the three fights walked the ladder: ${seen.join(' -> ')}`);
    check(g.state.supplies > 0, 'and winning them put supplies back in the pack');
  } finally {
    CONFIG.run.starvationAmbushChance = saved;
  }
}
{
  // The ambush borrows the tile; it must hand it back.
  const g = newGame();
  clearAround(g);
  const saved = CONFIG.run.starvationAmbushChance;
  CONFIG.run.starvationAmbushChance = 1;
  try {
    withDelegate(g, true);
    const target = g.reachable()[0];
    target.encounter = 'shop';
    target.shop = g.rollShopStock();
    target.recipe = null;
    g.state.supplies = 1;
    g.moveTo(target);
    g.resolveStarvationAmbush();
    check(target.encounter === 'shop', 'the shop the party was jumped outside is still there');
    check(!target.enemies, 'no enemies are left standing on it');
    check(target.recipe === null, "and it got its own map back, not the ambush's");
  } finally {
    CONFIG.run.starvationAmbushChance = saved;
  }
}

section('maxSupplies is the ceiling');
{
  const g = newGame();
  check(g.state.maxSupplies === CONFIG.run.maxSupplies, 'a run starts with the configured ceiling');
  g.state.supplies = g.state.maxSupplies - 1;
  check(g.addSupplies(1000) === 1, 'a gain is clipped to it');
  check(g.state.supplies === CONFIG.run.maxSupplies, 'and stops exactly there');
}

console.log('');
if (problems.length) {
  console.log(`FAILED (${problems.length}):`);
  for (const p of problems) console.log('  x ' + p);
  process.exit(1);
}
console.log('all world map rules pass');
