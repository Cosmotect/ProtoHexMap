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
const { K, hexDist, lineOffsets, hexLine } = await import(base + 'local/battle/bhex.js');

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

// ----- 6. the hex helpers ---------------------------------------------------
{
  const spokes = lineOffsets(1, 3);
  check(spokes.length === 18, `lineOffsets(1,3) should be 6 directions x 3 steps, got ${spokes.length}`);
  check(lineOffsets(3, 3).length === 6, 'lineOffsets(3,3) should be the six tiles exactly three out');
  // Every offset must sit straight out from the origin, or it is not a spoke.
  for (const [q, r] of spokes) {
    const d = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    check(hexDist('0,0', K(q, r)) === d && [q, r, q + r].filter((n) => n === 0).length >= 1,
      `lineOffsets produced an off-axis tile: ${q},${r}`);
  }
  const line = hexLine('0,0', '2,-3');
  check(line[0] === '0,0' && line[line.length - 1] === '2,-3', 'hexLine must start at a and end at b: ' + line.join(' '));
  check(line.every((k, i) => i === 0 || hexDist(line[i - 1], k) === 1), 'hexLine left a gap: ' + line.join(' '));
}

// ----- 7. the charging shove -------------------------------------------------
// `moveToTarget` may be aimed AT an occupied tile (2026-09-11). Where the caster
// stops is decided when the cast resolves, after its own shoves: it takes the
// furthest tile on the line it can stand on. So a ram that clears the tile lands
// on it, and one whose shove was blocked pulls up short. The aim preview plays
// the same cast out on a copy of the board, so what it draws is what happens.
{
  ABILITIES.__testRam = { ...ABILITIES.strike, name: 'Charging Shove', damage: 3,
    castZone: lineOffsets(1, 3), dmgZone: [[0, 0]], tagZone: [], tagId: null, hZone: [],
    pushZone: [[0, 0, 0, 1]], rotatable: true, moveToTarget: true, buff: '', buffX: null };

  const ram = ({ foes, aimAt, wall = [] }) => {
    const b = createBattle({
      config: CONFIG, radius: 4, heights: {},
      party: [{ name: 'Vanguard', hp: 40, maxHp: 40, abilityIds: ['__testRam'], partyIndex: 0 }],
      enemies: foes.map((k, i) => ({ name: 'Husk' + i, hp: 40, maxHp: 40, power: 0, abilityIds: ['__none'], init: 1, speed: 0, intellect: 'C' })),
      partyKeys: [K(0, 0)], enemyKeys: foes, wallKeys: wall,
      instant: true, rng: () => 0.5,
      onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
    });
    b.start && b.start();
    const sb = b.state, me = sb.units.find((u) => !u.isEnemy);
    b.activate(me.uid); b.selectAbility('__testRam');
    const canAim = Object.keys(sb.aimMap || {}).includes(aimAt);
    const pv = canAim ? b.aimPreview(aimAt) : null;
    if (canAim) b.clickTile(aimAt);
    return { canAim, pv, caster: me.pos, foes: sb.units.filter((u) => u.isEnemy).map((u) => u.pos) };
  };

  // Room behind the target: it is rammed clear and the caster takes its tile.
  const clear = ram({ foes: [K(3, 0)], aimAt: K(3, 0) });
  check(clear.canAim, 'a dash could not be aimed at an occupied tile');
  check(clear.caster === K(3, 0), `the ram should have taken the target's tile, caster is on ${clear.caster}`);
  check(clear.foes[0] === K(4, 0), `the target should have been shoved back, it is on ${clear.foes[0]}`);

  // Another enemy right behind it: the shove is a collision, so the tile stays
  // taken and the charge stops in front of it.
  const jam = ram({ foes: [K(2, 0), K(3, 0)], aimAt: K(2, 0) });
  check(jam.caster === K(1, 0), `a blocked ram should stop in front of the target, caster is on ${jam.caster}`);
  check(jam.foes[0] === K(2, 0), 'the target moved even though the shove was blocked');

  // A wall behind it: same story, by a different obstacle.
  const wall = ram({ foes: [K(2, 0)], aimAt: K(2, 0), wall: [K(3, 0)] });
  check(wall.caster === K(1, 0), `a ram into a wall should stop short, caster is on ${wall.caster}`);

  // And the preview told the truth every time.
  for (const [name, r] of [['clear', clear], ['jammed', jam], ['walled', wall]]) {
    check(r.pv && r.pv.dash === r.caster, `the ${name} ram previewed a dash to ${r.pv && r.pv.dash} but landed on ${r.caster}`);
  }
  check(clear.pv.dashShort === false && jam.pv.dashShort === true, 'dashShort did not flag the ram that stopped short');
  check(clear.pv.push.length === 1 && clear.pv.push[0].to === K(4, 0), 'the preview did not report where the shove lands: ' + JSON.stringify(clear.pv.push));
  check(jam.pv.push.length === 0, 'the preview promised a shove that could not happen: ' + JSON.stringify(jam.pv.push));
}

// ----- 8. a charge needs a clear run ----------------------------------------
// Reported 2026-09-11: standing in front of enemy A with enemy B behind it, a
// charge could be aimed at B. It then half-happened - B took the hit and the
// shove, while the caster, blocked by A, never moved. A charge is a run across
// the floor: everything strictly between it and the aim point must be empty
// ground, and only the aim point itself may be occupied.
{
  const line = ({ foes, aimAt }) => {
    const b = createBattle({
      config: CONFIG, radius: 4, heights: {},
      party: [{ name: 'Vanguard', hp: 40, maxHp: 40, abilityIds: ['__testRam'], partyIndex: 0 }],
      enemies: foes.map((k, i) => ({ name: 'H' + i, hp: 40, maxHp: 40, power: 0, abilityIds: ['__none'], init: 1, speed: 0, intellect: 'C' })),
      partyKeys: [K(0, 0)], enemyKeys: foes,
      instant: true, rng: () => 0.5,
      onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
    });
    b.start && b.start();
    const sb = b.state, me = sb.units.find((u) => !u.isEnemy);
    b.activate(me.uid); b.selectAbility('__testRam');
    const offered = Object.keys(sb.aimMap || {}).includes(aimAt);
    b.clickTile(aimAt);   // must be a no-op when it is not offered
    return { offered, caster: me.pos, hp: sb.units.filter((u) => u.isEnemy).map((u) => u.hp) };
  };
  // A body in the way: the tile behind it is not a target at all.
  const through = line({ foes: [K(1, 0), K(2, 0)], aimAt: K(2, 0) });
  check(!through.offered, 'a charge was offered a tile behind another unit');
  check(through.caster === K(0, 0) && through.hp.every((h) => h === 40),
    'a charge that was not offered still went off: ' + JSON.stringify(through));
  // Nobody in the way: the same tile IS a target.
  const clearRun = line({ foes: [K(2, 0)], aimAt: K(2, 0) });
  check(clearRun.offered, 'a charge down an empty line was not offered');
  check(clearRun.caster === K(2, 0), `the clear charge should have landed on the target's tile, it is on ${clearRun.caster}`);
  // The aim point itself being occupied is the whole point, and stays legal.
  check(line({ foes: [K(1, 0)], aimAt: K(1, 0) }).offered, 'a charge could not be aimed at an adjacent unit');
  // A dash never shows dmgZone aliases: for a charge the aim point is also the
  // destination, so a tile you cannot go to must not light up.
  const aliasFree = (() => {
    const b = createBattle({
      config: CONFIG, radius: 4, heights: {},
      party: [{ name: 'Vanguard', hp: 40, maxHp: 40, abilityIds: ['__testRam'], partyIndex: 0 }],
      enemies: [{ name: 'H', hp: 40, maxHp: 40, power: 0, abilityIds: ['__none'], init: 1, speed: 0, intellect: 'C' }],
      partyKeys: [K(0, 0)], enemyKeys: [K(0, 3)],
      instant: true, rng: () => 0.5,
      onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
    });
    b.start && b.start();
    const sb = b.state, me = sb.units.find((u) => !u.isEnemy);
    b.activate(me.uid); b.selectAbility('__testRam');
    return Object.entries(sb.aimMap || {});
  })();
  check(aliasFree.every(([k, anchor]) => k === anchor),
    'a dash offered alias tiles that are not where it goes: ' + JSON.stringify(aliasFree.filter(([k, a]) => k !== a)));
}

console.log(problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'OK: engine tests passed.');
process.exit(problems.length ? 1 : 0);
