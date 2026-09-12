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
const { ABILITIES, STATUSES, statusKnobs, statusOverridesFor, parsePassive, passiveToString, isPermanent } = await import(base + 'config/abilities.js');
const { passivesFor } = await import(base + 'upgrades.js');
const { INTELLECT, COMBAT_TAGS } = await import(base + 'config/entities.js');
const { statusesFor } = await import(base + 'status.js');
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
  check(CONFIG.intellect === INTELLECT, 'config.intellect is not the table in config/entities.js');
  check(Object.keys(CONFIG.intellect).join(',') === 'S,A,B,C', 'the intellect classes changed: ' + Object.keys(CONFIG.intellect));
  check(CONFIG.tags === COMBAT_TAGS, 'config.tags is not the table in config/entities.js');
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

// ----- 9. passives ----------------------------------------------------------
// A passive is a status the unit puts on ITSELF at a moment, without a cast. It
// names a row of the SAME table a cast would, goes on through the same
// applyStatus, and sits in the same status bag; whether it stays for the fight
// or wears off is the ROW's business (its clock / charges), never the passive's.
{
  ABILITIES.__testRamPush = { ...ABILITIES.shove, name: 'Ram', damage: 0, heal: 0, buff: '', buffX: null,
    pushZone: [[0, 0, 0]], rotatable: true, tagId: null, tagZone: [], hZone: [] };

  const fight = ({ passives = [], foes, wall = [], heights = {}, foePassives = passives }) => {
    const b = createBattle({
      config: CONFIG, radius: 4, heights,
      party: [{ name: 'Gorm', hp: 40, maxHp: 40, abilityIds: ['__testRamPush', 'strike'], partyIndex: 0, passives }],
      enemies: foes.map((k, i) => ({ name: 'H' + i, hp: 40, maxHp: 40, power: 0, abilityIds: ['__none'], init: 1, speed: 0, intellect: 'C', passives: foePassives })),
      partyKeys: [K(0, 0)], enemyKeys: foes, wallKeys: wall,
      instant: true, rng: () => 0.5,
      onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
    });
    b.start && b.start();
    return b;
  };
  const shoveAt = (b, k) => {
    const sb = b.state, me = sb.units.find((u) => !u.isEnemy);
    b.activate(me.uid); b.selectAbility('__testRamPush'); b.clickTile(k);
    return sb.units.filter((u) => u.isEnemy).map((u) => u.hp);
  };

  // Collision immunity covers all three impact kinds (the owner's choice).
  const wallHp = [[], ['collisionImmune']].map((p) => shoveAt(fight({ passives: p, foes: [K(1, 0)], wall: [K(2, 0)] }), K(1, 0))[0]);
  check(wallHp[0] === 38 && wallHp[1] === 40, `crash into a wall: plain ${wallHp[0]}, padded ${wallHp[1]} (want 38 / 40)`);
  const pileHp = [[], ['collisionImmune']].map((p) => shoveAt(fight({ passives: p, foes: [K(1, 0), K(2, 0)] }), K(1, 0)));
  check(pileHp[0].every((h) => h === 38) && pileHp[1].every((h) => h === 40), `shoved into a body: plain ${pileHp[0]}, padded ${pileHp[1]}`);
  const ledge = { [K(0, 0)]: 3, [K(1, 0)]: 3, [K(2, 0)]: 0 };
  const fallHp = [[], ['collisionImmune']].map((p) => shoveAt(fight({ passives: p, foes: [K(1, 0)], heights: ledge }), K(1, 0))[0]);
  check(fallHp[0] === 38 && fallHp[1] === 40, `shoved off a ledge: plain ${fallHp[0]}, padded ${fallHp[1]} (want 38 / 40)`);

  // Regeneration heals at the start of the carrier's own turn - the very line a
  // timed regen status uses, because it is the same field on the same table.
  const healed = [[], ['regeneration']].map((p) => {
    const b = fight({ passives: p, foes: [K(3, 0)] });
    const sb = b.state, me = sb.units.find((u) => !u.isEnemy);
    me.hp = 20;
    for (const u of sb.units) if (!u.isEnemy) u.done = true;
    b.endTurn();
    return me.hp;
  });
  check(healed[0] === 20 && healed[1] === 22, `regeneration: plain ${healed[0]}, regenerating ${healed[1]} (want 20 / 22)`);

  // A row with no clock and nothing to spend it is still there after the turn
  // that ticked it - that is all "permanent" means.
  {
    const b = fight({ passives: ['regeneration'], foes: [K(3, 0)] });
    const sb = b.state, me = sb.units.find((u) => !u.isEnemy);
    for (const u of sb.units) if (!u.isEnemy) u.done = true;
    b.endTurn();
    check(!!me.status.regeneration, 'a permanent passive was lost when its turn ticked');
    check(isPermanent(STATUSES.regeneration, me.status.regeneration) && !isPermanent(STATUSES.enraged) && !isPermanent(STATUSES.shield),
      'isPermanent: regeneration should be, enraged (clock) and shield (spent) should not');
    // The unit card leaves permanent rows out of its slots; the party view asks for them.
    check(!statusesFor(me).some((s) => s.id === 'regeneration'), 'a permanent passive took a status slot on the card');
    check(statusesFor(me, { permanent: true }).some((s) => s.id === 'regeneration' && s.permanent), 'the full status list left a permanent passive out');
  }

  // A row that is SPENT is a fine passive too: "starts every fight with a
  // Shield" blocks the first hit and is then gone, like any shield.
  {
    const b = fight({ passives: [], foes: [K(1, 0)], foePassives: ['shield'] });
    const sb = b.state, me = sb.units.find((u) => !u.isEnemy), foe = sb.units.find((u) => u.isEnemy);
    check(!!foe.status.shield, 'a shield passive was not put on at battle start');
    b.activate(me.uid); b.selectAbility('strike'); b.clickTile(K(1, 0));
    check(foe.hp === 40 && !foe.status.shield, `a shield passive did not block the first hit and go: hp ${foe.hp}, shield ${!!foe.status.shield}`);
  }

  // The AI's board copy carries the passives too, so a moment fires in its
  // simulations. Checked the cheap way: the arena units have them.
  {
    const b = fight({ passives: ['collisionImmune'], foes: [K(2, 0)] });
    const sb = b.state;
    check(sb.units.every((u) => Array.isArray(u.passives) && u.passives.some((p) => p.status === 'collisionImmune' && p.when === 'battleStart')),
      'passives did not reach the arena units parsed');
    check(sb.units.every((u) => !!u.status.collisionImmune), 'a battle-start passive is not in the status bag');
  }

  // The three written forms, and what is refused.
  const P = (e) => parsePassive(e, true);
  check(P('regeneration')?.when === 'battleStart', "a bare id does not mean 'at battle start'");
  check(P('enraged@hit')?.when === 'hit' && P('enraged@hit').status === 'enraged', "'id@moment' did not parse");
  check(P({ status: 'enraged', when: 'hit', buffX: [null, 3] })?.buffX?.[1] === 3, 'the object form lost its buffX');
  check(P('nosuchrow') === null && P('enraged@nosuchmoment') === null && P(null) === null, 'a bad passive was accepted');
  check(passiveToString(P('enraged@hit')) === 'enraged@hit' && passiveToString(P('regeneration')) === 'regeneration', 'passiveToString does not round-trip');

  // Derivation from what a character IS: node, relic, aura - one list.
  check(passivesFor({ name: 'Gorm', upgrades: [] }).length === 0, 'a character with no upgrades has passives');
  const has = (list, id, when = 'battleStart') => list.some((p) => p.status === id && p.when === when);
  check(has(passivesFor({ name: 'Gorm', upgrades: ['chargeHeadbutt:collisionImmune'] }), 'collisionImmune'),
    'an unlocked node did not give its passive');
  check(has(passivesFor({ name: 'Gorm', upgrades: ['chargeHeadbutt:beginEnraged'] }), 'enraged'),
    'the Raging Entry node did not give its passive');
  check(has(passivesFor({ name: 'Gorm', upgrades: [], relic: { passives: ['regeneration'] } }), 'regeneration'),
    'a relic did not give its passive');
  check(has(passivesFor({ name: 'Gorm', upgrades: [], auraPassives: ['collisionImmune'] }), 'collisionImmune'),
    'a world-map aura did not give its passive');
  check(has(passivesFor({ name: 'Gorm', upgrades: [], relic: { passives: ['enraged@hit'] } }), 'enraged', 'hit'),
    "a relic's 'id@moment' passive was lost");
  check(passivesFor({ name: 'Gorm', upgrades: [], relic: { passives: ['nosuchrow'] } }).length === 0,
    'a status row that does not exist was accepted');
  check(passivesFor({ name: 'Gorm', upgrades: [], relic: { passives: ['regeneration', 'regeneration'] } }).length === 1,
    'the same passive twice was not folded into one');
}

// ----- 10. moments ----------------------------------------------------------
// 'battleStart' fires before either side moves, and the status goes on FRESH -
// it skips its carrier's next tick instead of counting down - because
// startPlayerPhase ticks every party unit at the top of the first round too, and
// a one-turn buff put on at setup would otherwise be gone before it was ever
// usable. The rule holds whether the fight opens normally or with an ambush.
// 'hit' fires every time the carrier actually loses hp.
{
  const run = ({ ambush = false, onParty = true, passive = 'enraged' }) => {
    const b = createBattle({
      config: CONFIG, radius: 4, heights: {},
      party: [{ name: 'Gorm', hp: 40, maxHp: 40, abilityIds: ['strike'], partyIndex: 0, passives: onParty ? [passive] : [] }],
      enemies: [{ name: 'H', hp: 40, maxHp: 40, power: 0, abilityIds: ['strike'], init: 1, speed: 0, intellect: 'C', passives: onParty ? [] : [passive] }],
      partyKeys: [K(0, 0)], enemyKeys: [K(3, 0)], forced: ambush,
      instant: true, rng: () => 0.5,
      onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
    });
    b.start && b.start();
    const sb = b.state;
    const who = () => sb.units.find((u) => u.isEnemy !== onParty);
    const pass = () => { for (const u of sb.units) if (!u.isEnemy) u.done = true; b.endTurn(); };
    return { b, sb, who, on1: !!who().status.enraged, pass, after: () => { pass(); return !!who().status.enraged; } };
  };
  for (const ambush of [false, true]) {
    const r = run({ ambush });
    check(r.on1, `a battle-start status was missing on the player's first turn (ambush: ${ambush})`);
    check(!r.after(), `a one-turn battle-start status outlived the player's first turn (ambush: ${ambush})`);
  }
  // An ambushing ENEMY must hold it while it strikes, not lose it to its own tick.
  {
    const r = run({ ambush: true, onParty: false });
    check(r.on1, 'an ambushing enemy lost its battle-start status before it acted');
  }
  // 'hit': not there at the start, there the moment hp is lost, not for a
  // blocked hit. (A three-turn row, so the tick that follows the cast - the
  // player's cast ends the phase, and the enemy's activation ticks it - does not
  // take it off again before the check; a one-turn row would be gone by then,
  // exactly as a one-turn status from a cast is.)
  {
    const b = createBattle({
      config: CONFIG, radius: 4, heights: {},
      party: [{ name: 'Gorm', hp: 40, maxHp: 40, abilityIds: ['strike', 'guard'], partyIndex: 0 }],
      enemies: [{ name: 'H', hp: 40, maxHp: 40, power: 0, abilityIds: ['__none'], init: 1, speed: 0, intellect: 'C', passives: ['poison@hit'] }],
      partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)],
      instant: true, rng: () => 0.5,
      onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
    });
    b.start && b.start();
    const sb = b.state, me = sb.units.find((u) => !u.isEnemy), foe = sb.units.find((u) => u.isEnemy);
    check(!foe.status.poison, "a 'poison@hit' passive was on before any hit");
    // A blocked hit is not a hit.
    foe.status.shield = { turns: 0, charges: 1, over: {} };
    b.activate(me.uid); b.selectAbility('strike'); b.clickTile(K(1, 0));
    check(foe.hp === 40 && !foe.status.poison, `a blocked hit fired the 'hit' moment (hp ${foe.hp}, poison ${!!foe.status.poison})`);
    // A real one is.
    me.done = false; sb.phase = 'player';
    b.activate(me.uid); b.selectAbility('strike'); b.clickTile(K(1, 0));
    check(foe.hp < 40 && !!foe.status.poison, `losing hp did not fire the 'hit' moment (hp ${foe.hp}, poison ${!!foe.status.poison})`);
    // ...and it is a status like any other from here: the poison it put on bit
    // at the enemy's own activation and its clock ran.
    check(foe.status.poison && foe.status.poison.turns === 2 && foe.hp === 40 - 3 - 2,
      `the passive's status did not tick like a cast one: ${JSON.stringify(foe.status.poison)} hp ${foe.hp}`);
  }
}

// ----- 11. ability costs ------------------------------------------------------
// A move cost is paid out of the same points the walk uses. Until 2026-09-12 the
// gate ignored the walk (moveBudget is measured from startPos so a walk can be
// taken back), and a unit that had walked its whole speed could still cast a
// move-cost ability. A supply cost comes off the run's supplies handle.
{
  let sup = 10;
  const mk = (enemyAt) => createBattle({
    config: CONFIG, radius: 4, heights: {},
    party: [{ name: 'Mystic', hp: 22, maxHp: 22, abilityIds: ['burst', 'mend'], partyIndex: 0 }],
    enemies: [{ name: 'H', hp: 40, maxHp: 40, power: 0, abilityIds: ['__none'], init: 1, speed: 0, intellect: 'C' }],
    partyKeys: [K(0, 0)], enemyKeys: [enemyAt],
    supplies: { get: () => sup, add: (n) => { const b = sup; sup = Math.max(0, Math.min(60, sup + n)); return sup - b; } },
    instant: true, rng: () => 0.5, onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
  });
  const b = mk(K(-3, 0));
  b.start && b.start();
  const sb = b.state, me = sb.units.find((u) => !u.isEnemy);
  const burst = b.abilityFor(me, 'burst');
  check(burst.cost.move === 1 && b.abilityFor(me, 'mend').cost.supplies === 1, 'the sample costs on Ember Burst / Mend changed - this test assumes move 1 / supplies 1');
  check(b.moveLeft(me) === me.speed && b.shortOf(me, burst) === '', 'a unit that has not walked cannot afford a move-1 ability');
  b.activate(me.uid); b.clickTile(K(me.speed, 0));
  check(me.pos === K(me.speed, 0), 'the walk did not happen');
  check(b.moveLeft(me) === 0 && b.shortOf(me, burst) === 'move', `a unit that walked every point still had movement for a cast: left ${b.moveLeft(me)}, short "${b.shortOf(me, burst)}"`);
  // Taking the walk back (clicking a nearer tile) gives the points back.
  b.clickTile(K(1, 0));
  check(me.pos === K(1, 0) && b.moveLeft(me) === me.speed - 1 && b.shortOf(me, burst) === '', `a shorter walk did not free movement: left ${b.moveLeft(me)}`);
  // Supplies: paid once, at the cast.
  const b2 = mk(K(3, 0));
  b2.start && b2.start();
  const me2 = b2.state.units.find((u) => !u.isEnemy);
  me2.hp = 10;
  b2.activate(me2.uid); b2.selectAbility('mend'); b2.clickTile(K(0, 0));
  check(me2.hp === 14 && sup === 9, `Mend should have cost exactly one supply: hp ${me2.hp}, supplies ${sup}`);
}

console.log(problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'OK: engine tests passed.');
process.exit(problems.length ? 1 : 0);
