// =====================================================================
//  ENGINE TESTS - headless rules checks, in seconds rather than minutes.
//
//    node tools/engine-test.mjs
//
//  The smoke test (tools/smoke-test.cjs) drives the real browser and is the
//  authority on anything the player can see. It is also slow, and some rules
//  are far easier to state as a fight set up by hand than as a click path.
//  This file is for those: build a tiny arena, run a round, assert.
//
//  The engine runs with `instant: true` (the pacing timers collapse, so a whole
//  enemy phase resolves inside endTurn) and with NO onAnim callback, which puts
//  movement on its headless fallback. Passing an onAnim stub that never calls
//  anim.enter() is the classic way to write a test where nothing ever moves.
// =====================================================================
const base = new URL('../src/', import.meta.url).href;
const { CONFIG } = await import(base + 'config.js');
const { COMBAT_TAGS, ABILITIES, STATUSES, statusKnobs, statusOverridesFor } = await import(base + 'config/abilities.js');
const { INTELLECT } = await import(base + 'config/units.js');
const { createBattle } = await import(base + 'local/battle/engine.js');
const { K } = await import(base + 'local/battle/bhex.js');

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

// ----- fixtures ------------------------------------------------------------
// Two tags and one ability, written only for these tests. Nothing here needs an
// engine change: a tag's hook names an ordinary ability, and an ability carries
// a status the same way any other does.
ABILITIES.__testVenom = { ...ABILITIES.guard, name: 'Venom Seep', buff: 'poison', buffX: [5, 6], damage: 0, heal: 0 };
const TAG = (o) => Object.assign({
  name: 'Test', icon: '⭐', color: '#ffffff', desc: '',
  dmg: 0, heal: 0, life: 0, hp: 0, pushable: false, collectible: false, passPickup: false,
  onDestroy: null, onExpire: null, onPickup: null, onPeriodic: null, everyX: 0, everyOff: 0,
}, o);
COMBAT_TAGS.__testWard = TAG({ name: 'Ward Stone', onPeriodic: 'guard', everyX: 1 });
COMBAT_TAGS.__testVenomPool = TAG({ name: 'Venom Pool', onPeriodic: '__testVenom', everyX: 1 });
COMBAT_TAGS.__testEmbers = TAG({ name: 'Embers', dmg: 2 });

function arena({ tags = [], enemyAt = K(3, 0), partyAt = K(0, 0), speed = 2, intellect = 'C' }) {
  const b = createBattle({
    config: CONFIG, radius: 4, heights: {},
    party: [{ name: 'Vanguard', hp: 40, maxHp: 40, abilityIds: ['strike'], partyIndex: 0 }],
    enemies: [{ name: 'Husk', hp: 40, maxHp: 40, power: 0, abilityIds: ['strike'], init: 5, speed, intellect }],
    partyKeys: [partyAt], enemyKeys: [enemyAt],
    startTags: tags,
    instant: true, rng: () => 0.5,
    onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
  });
  b.start && b.start();
  return b;
}
// One full round: the party passes, the enemies act, the round ends (which is
// when a tag's periodic hook fires).
function round(b) {
  const sb = b.state;
  for (const u of sb.units) if (!u.isEnemy && u.hp > 0) u.done = true;
  b.endTurn();
  return sb;
}

// ----- 1. a tag's hook can apply a status ----------------------------------
// A tag's own tick is damage and healing and nothing else. Its four hooks each
// cast a whole ABILITY, which is how a tag reaches everything an ability can do.
{
  const sb = round(arena({ tags: [{ id: '__testWard', k: K(0, 0) }], speed: 0 }));
  const me = sb.units.find((u) => !u.isEnemy);
  check(!!(me.status && me.status.shield), 'a tag whose hook casts Guard did not shield the unit standing on it');

  const sb2 = round(arena({ tags: [{ id: '__testEmbers', k: K(0, 0) }], speed: 0 }));
  const me2 = sb2.units.find((u) => !u.isEnemy);
  // Two ticks of 2: a tag bites at the start of each of the carrier's own
  // activations, and one round() spans two of them (the opening phase and the
  // one that starts after the enemies have acted).
  check(me2.hp === 36, `a plain damage tag should have dealt 2 a turn, unit is on ${me2.hp}/40`);
  check(Object.keys(me2.status || {}).length === 0, 'a plain damage tag applied a status it never names');
}

// ----- 2. buffX carries through a tag --------------------------------------
// The hook's ability is read like any other, so its buffX list lands intact.
{
  const sb = round(arena({ tags: [{ id: '__testVenomPool', k: K(3, 0) }], speed: 0 }));
  const foe = sb.units.find((u) => u.isEnemy);
  const p = foe.status && foe.status.poison;
  check(!!p, 'a venom tag did not poison the unit standing on it');
  if (p) {
    check(p.turns === 6, `buffX asked for 6 turns of poison, got ${p.turns}`);
    check(p.over && p.over.tickDamage === 5, `buffX asked for 5 damage a turn, got ${JSON.stringify(p.over)}`);
  }
  // A tag has no side: it caught an ENEMY here, and the party unit in test 1.
}

// ----- 3. a mind that reads tiles avoids a status-only tag -----------------
// Until 2026-09-10 the AI measured a tile by its `dmg` alone, so a pool that
// only poisons scored zero and every class walked into it. Both (1,0) and (1,-1)
// are one step from the enemy and adjacent to the party unit, so either lets it
// attack this turn - the tag is the only thing that tells them apart.
{
  const landed = {};
  for (const cls of Object.keys(INTELLECT)) {
    const sb = round(arena({ tags: [{ id: '__testVenomPool', k: K(1, -1) }], enemyAt: K(2, -1), intellect: cls }));
    const foe = sb.units.find((u) => u.isEnemy);
    landed[cls] = { pos: foe.pos, poisoned: !!(foe.status && foe.status.poison) };
  }
  check(!landed.S.poisoned, `an S-class mind stood in a venom pool: ${JSON.stringify(landed.S)}`);
  check(landed.C.poisoned, `a C-class mind avoided a pool it cannot see: ${JSON.stringify(landed.C)}`);
  // Avoiding the pool must not cost it the attack - it steps aside, it does not stop.
  check(landed.S.pos === K(1, 0), `the S-class mind should have attacked from the clean tile, it is on ${landed.S.pos}`);
}

// ----- 4. the status knobs ---------------------------------------------------
// buffX lines up with the knobs a status actually uses, in one fixed order.
{
  check(statusKnobs(STATUSES.poison).join(',') === 'tickDamage,turns', 'poison knobs: ' + statusKnobs(STATUSES.poison));
  check(statusKnobs(STATUSES.shield).join(',') === 'charges', 'shield knobs: ' + statusKnobs(STATUSES.shield));
  const o = statusOverridesFor(STATUSES.poison, [null, 5]);
  check(o.turns === 5 && o.tickDamage === undefined, 'an empty buffX slot should leave that knob alone: ' + JSON.stringify(o));
  check(Object.keys(statusOverridesFor(STATUSES.poison, null)).length === 0, 'no buffX should override nothing');
  for (const [id, def] of Object.entries(STATUSES)) {
    check(def.amountIs === undefined && def.amountSign === undefined, `status "${id}" still carries amountIs / amountSign`);
  }
}

// ----- 5. the config moves stayed wired -------------------------------------
{
  check(CONFIG.intellect === INTELLECT, 'config.intellect is not the table in config/units.js');
  check(Object.keys(CONFIG.intellect).join(',') === 'S,A,B,C', 'the intellect classes changed: ' + Object.keys(CONFIG.intellect));
  check(CONFIG.tags === COMBAT_TAGS, 'config.tags is not the table in config/abilities.js');
  check(!!CONFIG.tags.fire, 'the fire tag is missing from the config');
}

console.log(problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'OK: engine tests passed.');
process.exit(problems.length ? 1 : 0);
