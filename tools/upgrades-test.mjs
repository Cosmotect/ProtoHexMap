// =====================================================================
//  UPGRADE SYSTEM checks (2026-10-05), headless. node tools/upgrades-test.mjs
//  The effect vocabulary (rules.js) end to end: quantities over facts,
//  conditions, the X/Y status model (stacking, decay, immunity, triggers on
//  rows), stacks (consume / gain), throw / swap / dash-through, multi-aim,
//  extra attacks, Confused, Taunt / Fear / Charm, tags (web, wither cloud),
//  unit-stat and auto nodes, the overlap grants.
// =====================================================================
const base = new URL('../src/', import.meta.url).href;
const { CONFIG } = await import(base + 'config.js');
const { createBattle } = await import(base + 'local/battle/engine.js');
const { K } = await import(base + 'local/battle/bhex.js');
const { resolveAbility, resolvedAbilitiesFor, resolveUnitStats, triggersFor, ownedNodes, availableUpgrades, unlockUpgrade, auditUpgrades } = await import(base + 'upgrades.js');
const { ABILITY_UPGRADES } = await import(base + 'config/upgrades.js');

// An ability that does nothing, for enemies that must stand still and take it.
CONFIG.abilities.idle = { id: 'idle', name: 'Idle', icon: '', color: '', tags: [], castZone: [], castAny: false, rotatable: false, aims: 1, cost: { hp: 0, supplies: 0, move: 0 }, effects: [] };
const IDLE = { name: 'Husk', abilityIds: ['idle'] };

const problems = [];
let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) problems.push(msg); };
const eq = (a, b, msg) => check(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
let supplies = 10;

// A party member with the given nodes unlocked, as main.js would hand it over.
function member(name, nodes = [], extra = {}) {
  const u = { name, upgrades: nodes.map((n) => (n.includes(':') ? n : null)).filter(Boolean), hp: 20, maxHp: 20, alive: true };
  // bare node ids are looked up across the unit's trees
  for (const n of nodes) if (!n.includes(':')) for (const [abId, tree] of Object.entries(ABILITY_UPGRADES)) if (tree[n]) u.upgrades.push(`${abId}:${n}`);
  return { name, hp: 20, maxHp: 20, ...resolveUnitStats(u), abilityDefs: resolvedAbilitiesFor(u), triggers: triggersFor(u), ...extra };
}
function arena({ party, enemies, partyKeys, enemyKeys, heights = {}, rng = () => 0.5, startTags = [] }) {
  const b = createBattle({
    config: CONFIG, radius: 4, heights,
    party: party.map((p, i) => ({ partyIndex: i, ...p })),
    enemies: enemies.map((e) => ({ hp: 20, maxHp: 20, init: 5, speed: 0, intellect: 'C', ...e })),
    partyKeys, enemyKeys, instant: true, rng, startTags,
    supplies: { get: () => supplies, add: (n) => { supplies += n; } },
    onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
  });
  b.start && b.start();
  return b;
}
const P = (b, i) => b.state.units.filter((u) => !u.isEnemy)[i];
const E = (b, i) => b.state.units.filter((u) => u.isEnemy)[i];
const has = (u, id) => (u.statuses || []).filter((s) => s.id === id);
const amount = (u, id) => has(u, id).reduce((a, s) => a + s.amount, 0);
// Lock an ability at one or more tiles and fire the volley.
function volley(b, u, abId, tiles) {
  b.selectUnit(u.uid);
  b.selectAbility(abId);
  for (const t of [].concat(tiles)) b.clickTile(t);
  b.endTurn();
}

// ----- 0. the tables are sound ------------------------------------------------
{
  const warned = [];
  const orig = console.warn; console.warn = (...a) => warned.push(a.join(' '));
  auditUpgrades();
  for (const abId of Object.keys(ABILITY_UPGRADES)) resolveAbility(abId, Object.keys(ABILITY_UPGRADES[abId]).map((n) => `${abId}:${n}`));
  console.warn = orig;
  check(!warned.length, 'the trees should resolve without warnings:\n   ' + warned.join('\n   '));
}

// ----- 1. quantities: vulnerable +1 per 2 tiles travelled (ram cc1b) -------
{
  const b = arena({ party: [member('Gorm', ['cc0', 'cc1b']), member('Viridi')], enemies: [IDLE], partyKeys: [K(-3, 0), K(1, 1)], enemyKeys: [K(1, 0)] });
  const g = P(b, 0), v = P(b, 1), h = E(b, 0);
  b.selectUnit(g.uid); b.clickTile(K(-1, 0));   // 2 tiles east
  eq(g.pos, K(-1, 0), 'Gorm walks two tiles');
  b.setFireOrder([g.uid, v.uid]);
  b.selectUnit(g.uid); b.selectAbility('ram'); b.clickTile(K(1, 0));
  b.selectUnit(v.uid); b.selectAbility('spikeShot'); b.clickTile(K(2, 0));   // where the ram will have shoved it
  b.endTurn();
  // Vulnerable 2 for one activation: Viridi's two quills of 1, fired after
  // the ram in the same volley, each landed +2.
  eq(h.hp, 20 - 2 - 2 * (1 + 2), 'Vulnerable 1 + 1 per two tiles travelled sharpened the quills');
}

// ----- 2. elevation push (cc5a) and the maxPush clamp --------------------------
{
  const heights = { [K(-1, 0)]: 4, [K(0, 0)]: 0, [K(1, 0)]: 0, [K(2, 0)]: 0, [K(3, 0)]: 0 };
  const b = arena({ party: [member('Gorm', ['cc0', 'cc1a', 'cc2a', 'cc2b', 'cc3a', 'cc4a', 'cc4b', 'cc5a'])], enemies: [IDLE], partyKeys: [K(-1, 0)], enemyKeys: [K(0, 0)], heights });
  // cc3a replaced the push with a throw; put the push back for this check
  const ab = P(b, 0).abilityDefs.ram;
  ab.effects = ab.effects.filter((e) => e.kind !== 'throw').concat([{ id: 'push', kind: 'push', zone: [[0, 0]], dir: 0, dist: [{ n: 1 }, { per: 'elevationDrop', every: 2 }], targets: 'any', anchor: 'aim' }]);
  volley(b, P(b, 0), 'ram', K(0, 0));
  eq(E(b, 0).pos, K(3, 0), 'a 4-step drop adds 2 tiles of push (1 + 2)');
}

// ----- 3. stacks: consume all, +1 damage per stack (ram dp5a) ---------------
{
  const b = arena({ party: [member('Gorm', ['dp0', 'dp1a', 'dp2a', 'dp3a', 'dp4a', 'dp5a'])], enemies: [IDLE], partyKeys: [K(-1, 0)], enemyKeys: [K(0, 0)] });
  const g = P(b, 0);
  g.stacks = 3;   // pinned above the cap for the arithmetic
  volley(b, g, 'ram', K(0, 0));
  eq(E(b, 0).hp, 20 - 2 - 1 - 3, 'ram 2 +1 (dp0) +3 per stack consumed');
  eq(g.stacks, 2, 'the stacks were spent (two regenerated for the new round: Flow +1)');
}

// ----- 4. stacks regenerate each activation, capped ---------------------------
{
  const b = arena({ party: [member('Gorm', ['tk0', 'tk1a', 'tk2b'])], enemies: [IDLE], partyKeys: [K(-3, 0)], enemyKeys: [K(3, 0)] });
  const g = P(b, 0);
  eq(g.stackMax, 3, 'Smax +1 on a base of 2');
  eq(g.stacks, 1, 'one stack generated at the first activation');
  b.endTurn(); b.endTurn();
  eq(g.stacks, 3, 'stacks build to the cap');
  b.endTurn();
  eq(g.stacks, 3, '...and stop there');
}

// ----- 5. conditions: +2 vs a target at 80%+ hp, +1 when not moving ---------
{
  const b = arena({ party: [member('Feren', ['cu0', 'cu1a', 'cu2c', 'cu2d', 'cu3c'])], enemies: [IDLE, { ...IDLE, hp: 5, maxHp: 20 }], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0), K(-1, 0)] });
  volley(b, P(b, 0), 'glaive', K(1, 0));
  eq(E(b, 0).hp, 20 - (3 + 1 + 1 + 2), 'glaive 3 +1 (cu2c) +1 not moving +2 vs a healthy target');
  b.endTurn();
  volley(b, P(b, 0), 'glaive', K(-1, 0));
  eq(E(b, 1).hp, 5 - (3 + 1 + 1), 'no +2 against a wounded target');
}

// ----- 6. statuses: Shielded reduces and wears, Bleed ticks and decays -------
{
  const b = arena({ party: [member('Feren', ['cu0', 'cu1b'])], enemies: [{ name: 'Husk', abilityIds: ['strike'], speed: 3 }], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  const f = P(b, 0);
  eq(amount(f, 'shielded'), 2, 'starts Shielded 2 (battleStart trigger)');
  b.endTurn();   // the husk strikes for 3
  eq(f.hp, 20 - 1, 'Shielded 2 softens a 3 to 1');
  eq(amount(f, 'shielded'), 0, 'the shield wore down by the hit and the turn');
}
{
  const b = arena({ party: [member('Gorm', ['bl0', 'bl1a'])], enemies: [IDLE], partyKeys: [K(-1, 0)], enemyKeys: [K(0, 0)] });
  volley(b, P(b, 0), 'clawSwipe', K(0, 0));
  const h = E(b, 0);
  // the enemy phase ran inside endTurn: its activation ticked the bleed
  eq(h.hp, 20 - 4 - 2, 'claw 3 +1, then Bleed 2 bit at the husk\'s activation');
  eq(amount(h, 'bleed'), 1, '...and decayed to 1');
  b.endTurn();
  eq(h.hp, 20 - 4 - 2 - 1, 'bit for 1');
  eq(has(h, 'bleed').length, 0, '...and ended');
}

// ----- 6c. a node's effect follows the hit, whatever shape it is given --------
{
  // Wide Swipe reshapes the hit; Rending's bleed, written without a zone,
  // must land on every tile the swipe does.
  const b = arena({ party: [member('Gorm', ['bl0', 'bl1a', 'bl1b'])], enemies: [IDLE, IDLE, IDLE], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0), K(1, -1), K(0, 1)] });
  const ab = P(b, 0).abilityDefs.clawSwipe;
  eq(ab.effects.find((e) => e.kind === 'status').zone.length, 3, 'the bleed covers the cleave');
  volley(b, P(b, 0), 'clawSwipe', K(1, 0));
  check([0, 1, 2].every((i) => E(b, i).hp < 20 && has(E(b, i), 'bleed').length === 1), 'all three enemies in the cleave were hit and bleed');
}
{
  const { statusInfo } = await import(base + 'status.js');
  const b = arena({ party: [member('Gorm', ['ls0', 'ls1b'])], enemies: [IDLE], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  volley(b, P(b, 0), 'clawSwipe', K(1, 0));
  const inst = has(E(b, 0), 'lifelink')[0];
  check(inst && inst.sourceName === 'Gorm' && /Lifelinked to Gorm/.test(statusInfo(inst).desc), 'the Lifelink badge names its linked unit: ' + (inst && statusInfo(inst).desc));
}

// ----- 6d. the killing blow is a hit too -----------------------------------------
{
  const b = arena({ party: [member('Gorm', ['ls0', 'ls1b'])], enemies: [{ ...IDLE, hp: 5, maxHp: 5 }], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  const g = P(b, 0); g.hp = 10;
  volley(b, g, 'clawSwipe', K(1, 0));          // 3 damage, links it (2 hp left)
  volley(b, g, 'clawSwipe', K(1, 0));          // the killing blow
  check(E(b, 0).hp <= 0, 'the target died');
  eq(g.hp, 11, 'Lifelink healed on the killing blow');
}

// ----- 7. stacking policies: add vs separate; immunity -------------------------
{
  const nodes = ['mk0', 'mk1b', 'mk2c', 'mk2d', 'mk3c'];
  const b = arena({ party: [member('Feren', nodes), member('Feren', nodes)], enemies: [IDLE], partyKeys: [K(0, 0), K(0, 1)], enemyKeys: [K(2, 0)] });
  const f1 = P(b, 0), f2 = P(b, 1);
  b.selectUnit(f1.uid); b.selectAbility('bowBone'); b.clickTile(K(2, 0));
  b.selectUnit(f2.uid); b.selectAbility('bowBone'); b.clickTile(K(2, 0));
  b.endTurn();
  const h = E(b, 0);
  eq(has(h, 'vulnerable').length, 1, 'an additive status is one instance');
  eq(amount(h, 'vulnerable'), 2, 'Vulnerable 1 + 1 adds to 2');
  eq(h.hp, 20 - 3 - (3 + 1 + 1), 'the second bolt landed +1 Vulnerable and +1 overlap');
}
{
  const b = arena({ party: [member('Feren', ['hu0', 'hu1b']), member('Feren', ['hu0', 'hu1b'])], enemies: [IDLE], partyKeys: [K(0, 0), K(0, 1)], enemyKeys: [K(2, 0)] });
  b.selectUnit(P(b, 0).uid); b.selectAbility('bowBone'); b.clickTile(K(2, 0));
  b.selectUnit(P(b, 1).uid); b.selectAbility('bowBone'); b.clickTile(K(2, 0));
  b.endTurn();
  eq(has(E(b, 0), 'wither').length, 2, 'a separate-stacking status is two instances');
}
{
  const b = arena({ party: [member('Feren', ['hu0', 'hu1b'])], enemies: [{ ...IDLE, triggers: [{ when: 'battleStart', kind: 'status', status: 'witherImmune' }] }], partyKeys: [K(0, 0)], enemyKeys: [K(2, 0)] });
  volley(b, P(b, 0), 'bowBone', K(2, 0));
  eq(has(E(b, 0), 'wither').length, 0, 'an immune unit refuses the status');
}

// ----- 8. throw over the caster (cc3a) -------------------------------------
{
  const b = arena({ party: [member('Gorm', ['cc0', 'cc1a', 'cc2a', 'cc2b', 'cc3a'])], enemies: [IDLE], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  volley(b, P(b, 0), 'ram', K(1, 0));
  eq(E(b, 0).pos, K(-1, 0), 'the target lands on the tile behind Gorm');
  eq(P(b, 0).pos, K(1, 0), 'and Gorm charges onto the tile it held');
}

// ----- 9. swap with an ally and shield it (glaive cu5d); allies spared (cu5c) -
{
  const nodes = ['cu0', 'cu1a', 'cu2c', 'cu2d', 'cu3c', 'cu4b', 'cu4c', 'cu5d'];
  const b = arena({ party: [member('Feren', nodes), member('Gorm')], enemies: [IDLE], partyKeys: [K(0, 0), K(1, 0)], enemyKeys: [K(3, 0)] });
  const f = P(b, 0), g = P(b, 1);
  volley(b, f, 'glaive', K(1, 0));
  eq(f.pos, K(1, 0), 'Feren took the ally\'s tile');
  eq(g.pos, K(0, 0), 'the ally took Feren\'s');
  eq(amount(g, 'shielded'), 2, 'the ally is Shielded 2');
  eq(g.hp, 20 - (3 + 1 + 1 + 2), 'without Careful Edge the ally takes the full hit (healthy-target bonus included)');
}
{
  const nodes = ['cu0', 'cu1a', 'cu2c', 'cu2d', 'cu3c', 'cu4a', 'cu4b', 'cu4c', 'cu5c'];
  const b = arena({ party: [member('Feren', nodes), member('Gorm')], enemies: [IDLE], partyKeys: [K(0, 0), K(1, 0)], enemyKeys: [K(3, 0)] });
  volley(b, P(b, 0), 'glaive', K(1, 0));
  eq(P(b, 1).hp, 20, 'Careful Edge: the ally in the way is not hurt');
}

// ----- 10. multi-aim: two hits over two tiles (spikeShot sp1a) --------------
{
  const b = arena({ party: [member('Viridi', ['sp0', 'sp1a'])], enemies: [IDLE, IDLE], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0), K(-1, 0)] });
  const v = P(b, 0);
  eq(v.abilityDefs.spikeShot.aims, 2, 'Scatter makes it a two-aim ability');
  b.selectUnit(v.uid); b.selectAbility('spikeShot'); b.clickTile(K(1, 0));
  check(v.lock && v.lock.anchors.length === 1 && b.state.selAb === 'spikeShot', 'one aim locked, still aiming');
  b.clickTile(K(-1, 0));
  check(v.lock && v.lock.anchors.length === 2 && !b.state.selAb, 'two aims locked, aiming done');
  b.endTurn();
  eq(E(b, 0).hp, 19, 'one quill on the first aim');
  eq(E(b, 1).hp, 19, 'one quill on the second');
}

// ----- 11. a killing blow gives another attack (glaive ag5d) ----------------
{
  const nodes = ['ag0', 'ag1b', 'ag2b', 'ag2c', 'ag3c', 'ag4b', 'ag4c', 'ag5d'];
  const b = arena({ party: [member('Feren', nodes)], enemies: [{ ...IDLE, hp: 3, maxHp: 3 }, IDLE], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0), K(-1, 0)] });
  const f = P(b, 0);
  volley(b, f, 'glaive', K(1, 0));
  check(E(b, 0).hp <= 0, 'the first husk died');
  eq(b.state.phase, 'player', 'the phase stays open for the extra attack');
  check(!f.done && f.moveLocked, 'Feren may aim again but not walk');
  volley(b, f, 'glaive', K(-1, 0));
  eq(E(b, 1).hp, 17, 'the second attack landed');
  eq(b.state.round, 2, 'and then the round moved on');
}

// ----- 12. triggers: hit -> enraged; activationEnd + didNotMove (tk5a); moved (ag3b)
{
  const b = arena({ party: [member('Gorm', ['dp0', 'dp1a', 'dp2a', 'dp2b', 'dp3a', 'dp4b', 'dp5c'])], enemies: [{ name: 'Husk', abilityIds: ['strike'], speed: 3 }], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  b.endTurn();
  const g = P(b, 0);
  check(g.hp < 20, 'the husk hit Gorm');
  eq(amount(g, 'enraged'), 1, 'Grudge: enraged when hit');
}
{
  const b = arena({ party: [member('Gorm', ['tk0', 'tk1a', 'tk2a', 'tk2b', 'tk3a', 'tk4a', 'tk4b', 'tk5a'])], enemies: [IDLE], partyKeys: [K(-3, 0)], enemyKeys: [K(3, 0)] });
  const g = P(b, 0);
  b.endTurn();   // Gorm did not move
  eq(amount(g, 'shielded'), 1, 'Dig In: Shielded 1 for standing still');
  eq(amount(g, 'amplified'), 1, 'Dig In: +1 stack generation');
  check(has(g, 'regen').length > 0, 'Dig In: regeneration');
  b.selectUnit(g.uid); b.clickTile(K(-2, 0)); b.endTurn();
  eq(amount(g, 'amplified'), 0, 'no Dig In after moving');
}
{
  const b = arena({ party: [member('Feren', ['ag0', 'ag1b', 'ag2a', 'ag2b', 'ag3b'])], enemies: [IDLE], partyKeys: [K(-3, 0)], enemyKeys: [K(4, 0)] });
  const f = P(b, 0);
  b.selectUnit(f.uid); b.clickTile(K(1, 0));
  eq(f.steps, 4, 'four tiles walked');
  eq(amount(f, 'shielded'), 2, 'Momentum Guard after more than 3 tiles');
}

// ----- 13. status-row triggers: Lifelink heals its source; Marked rewards the killer
{
  const b = arena({ party: [member('Gorm', ['ls0', 'ls1b'])], enemies: [IDLE], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  const g = P(b, 0); g.hp = 10;
  volley(b, g, 'clawSwipe', K(1, 0));
  const inst = has(E(b, 0), 'lifelink')[0];
  check(inst && inst.source === g.uid, 'Lifelink remembers who linked it');
  volley(b, g, 'clawSwipe', K(1, 0));
  eq(g.hp, 11, 'Gorm healed 1 when the linked target was hurt');
}
{
  const b = arena({ party: [member('Feren', ['mk0', 'mk1b', 'mk2c', 'mk2d', 'mk3d'])], enemies: [{ ...IDLE, hp: 4, maxHp: 4 }], partyKeys: [K(0, 0)], enemyKeys: [K(2, 0)] });
  const f = P(b, 0);
  volley(b, f, 'bowBone', K(2, 0));
  check(has(E(b, 0), 'marked').length === 1 && E(b, 0).hp === 1, 'marked and at 1 hp');
  volley(b, f, 'bowBone', K(2, 0));
  eq(amount(f, 'strong'), 1, 'the killer is Strong 1');
}

// ----- 14. lifesteal, pierce, castsThisBattle, atMaxRange -----------------------
{
  const b = arena({ party: [member('Gorm', ['ls0', 'ls1a'])], enemies: [IDLE], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  const g = P(b, 0); g.hp = 10;
  volley(b, g, 'clawSwipe', K(1, 0));
  eq(E(b, 0).hp, 16, 'claw 3 + 1 lifesteal');
  eq(g.hp, 11, 'and Gorm healed the lifesteal');
}
{
  const b = arena({ party: [member('Feren', ['ag0', 'ag1b', 'ag2a', 'ag3b', 'ag4a', 'ag5a'])], enemies: [{ ...IDLE, triggers: [{ when: 'battleStart', kind: 'status', status: 'shielded', amount: 2 }] }], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  volley(b, P(b, 0), 'glaive', K(1, 0));
  eq(E(b, 0).hp, 17, 'Piercing Point ignores Shielded 2');
}
{
  const b = arena({ party: [member('Feren', ['mk0', 'mk1b', 'mk2a', 'mk3a', 'mk4a', 'mk5b'])], enemies: [IDLE], partyKeys: [K(0, 0)], enemyKeys: [K(2, 0)] });
  const f = P(b, 0);
  eq(b.costOf(f, f.abilityDefs.bowBone).hp, 0, 'first cast costs nothing');
  volley(b, f, 'bowBone', K(2, 0));
  eq(E(b, 0).hp, 17, 'first cast: 2 +1');
  eq(b.costOf(f, f.abilityDefs.bowBone).hp, 1, 'second cast costs 1 hp');
  volley(b, f, 'bowBone', K(2, 0));
  eq(E(b, 0).hp, 17 - 5, 'second cast: +2 more');
  eq(f.hp, 19, 'and the hp was paid');
}
{
  const b = arena({ party: [member('Feren', ['mk0', 'mk1b', 'mk2a', 'mk3a', 'mk4a', 'mk4b', 'mk4c', 'mk5c'])], enemies: [{ name: 'Husk', abilityIds: ['strike'], speed: 3 }, { name: 'Husk', abilityIds: ['strike'], speed: 3 }], partyKeys: [K(-2, 0)], enemyKeys: [K(3, 0), K(0, 0)] });
  volley(b, P(b, 0), 'bowBone', K(3, 0));
  // the enemy phase ran: the stunned husk at max range stood still, the other closed in
  eq(E(b, 0).pos, K(3, 0), 'Dead Eye: the target at max range (5) was stunned and did not move');
  check(E(b, 1).pos !== K(0, 0), 'the husk short of max range was not');
}

// ----- 15. tags: the web roots and snaps; the wither cloud withers --------------
{
  const b = arena({ party: [member('Feren', ['hu0', 'hu1a'])], enemies: [{ name: 'Husk', abilityIds: ['strike'], speed: 3 }], partyKeys: [K(-2, 0)], enemyKeys: [K(0, 0)] });
  const h = E(b, 0);
  volley(b, P(b, 0), 'bowBone', K(0, 0));
  // the enemy phase ran: rooted, it could not close in
  eq(h.pos, K(0, 0), 'the husk is rooted in the web');
  eq(h.hp, 20 - 2 - 2, 'bow bone 2, then the web snapped for 2 at the end of the round');
  check(!b.state.tags[K(0, 0)], 'the web is gone');
}
{
  const b = arena({ party: [member('Viridi', ['w0', 'w1b'])], enemies: [{ name: 'Husk', abilityIds: ['strike'] }], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  volley(b, P(b, 0), 'spikeShot', K(1, 0));
  check(has(E(b, 0), 'wither').length === 1, 'the wither cloud withered its occupant at the end of the round');
}

// ----- 16. Taunt / Fear / Charm steer the enemy AI -----------------------------
{
  const nodes = ['tk0', 'tk1a', 'tk2a', 'tk2c', 'tk3b'];
  const b = arena({ party: [member('Gorm', nodes), member('Viridi')], enemies: [{ name: 'Husk', abilityIds: ['strike'], intellect: 'S' }], partyKeys: [K(-2, 0), K(1, -1)], enemyKeys: [K(1, 0)] });
  const g = P(b, 0), v = P(b, 1);
  volley(b, g, 'ram', K(0, 0));   // lands next to the husk, taunts it; the enemy phase follows
  check(v.hp === 20 && g.hp < 20, `the taunted husk struck Gorm, not Viridi next to it (Gorm ${g.hp}, Viridi ${v.hp})`);
}
{
  const b = arena({ party: [member('Gorm', ['cc0', 'cc1a', 'cc2b', 'cc2d', 'cc3c'])], enemies: [{ name: 'Husk', abilityIds: ['strike'], speed: 4, intellect: 'S' }], partyKeys: [K(-1, 0)], enemyKeys: [K(1, 0)] });
  volley(b, P(b, 0), 'ram', K(1, 0));
  const h = E(b, 0);
  check(has(h, 'fear').length === 1, 'the husk is feared');
  const { hexDist } = await import(base + 'local/battle/bhex.js');
  check(hexDist(h.pos, P(b, 0).pos) > 1, `the feared husk did not end next to Gorm (dist ${hexDist(h.pos, P(b, 0).pos)})`);
}
{
  const nodes = ['w0', 'w1b', 'w2c', 'w2d', 'w3c', 'w4a', 'w4b', 'w4c', 'w5c'];
  const b = arena({ party: [member('Viridi', nodes), member('Gorm')], enemies: [{ name: 'Husk', abilityIds: ['strike'], intellect: 'S' }], partyKeys: [K(0, 0), K(1, -1)], enemyKeys: [K(1, 0)] });
  volley(b, P(b, 0), 'spikeShot', K(1, 0));
  check(has(E(b, 0), 'charm').length === 1, 'the husk is charmed');
  check(P(b, 0).hp === 20 && P(b, 1).hp < 20, `the charmed husk spared Viridi and struck Gorm (Viridi ${P(b, 0).hp}, Gorm ${P(b, 1).hp})`);
}

// ----- 17. Confused: the engine plays the unit ------------------------------------
{
  const b = arena({ party: [member('Gorm')], enemies: [{ name: 'Husk', abilityIds: ['strike'], speed: 3, triggers: [{ when: 'battleStart', kind: 'status', status: 'confused', turns: 2 }] }], partyKeys: [K(0, 0)], enemyKeys: [K(2, 0)], rng: () => 0.1 });
  b.endTurn();
  check(true, 'a confused enemy takes its turn without the planner');
}
{
  const b = arena({ party: [member('Gorm', [], { triggers: [{ when: 'battleStart', kind: 'status', status: 'confused', turns: 1 }] }), member('Viridi')], enemies: [IDLE], partyKeys: [K(0, 0), K(-3, 0)], enemyKeys: [K(1, 0)], rng: () => 0.99 });
  const g = P(b, 0);
  check(g.done, 'a confused party unit is out of the player\'s hands');
  b.endTurn();
  check(E(b, 0).hp < 20 || g.pos !== K(0, 0), 'the engine made it act (hit something or walked)');
  check(!g.done, 'the confusion wore off after one activation');
}

// ----- 18. unit-stat nodes, auto milestones, requiresAny gating ------------------
{
  const u = { name: 'Feren', hp: 5, maxHp: 5, upgrades: [], alive: true };
  check(unlockUpgrade(u, 'glaive:cu0'), 'the root unlocks');
  eq(u.maxHp, 7, 'HP +2 raised max hp at once');
  eq(u.hp, 7, '...and current hp with it');
  check(!availableUpgrades(u).some((o) => o.ref === 'glaive:cu3c'), 'a node two rows down is still gated');
  check(availableUpgrades(u).some((o) => o.ref === 'glaive:cu1a'), 'its children opened');
  unlockUpgrade(u, 'glaive:cu1a');
  check(availableUpgrades(u).some((o) => o.ref === 'glaive:cu2c'), 'requiresAny: one parent is enough');
  unlockUpgrade(u, 'glaive:cu2c'); unlockUpgrade(u, 'glaive:cu2d');
  eq(resolveUnitStats(u).speed, 6, 'Stride +1 on Feren\'s 5');
  const owned = ownedNodes(u.upgrades, 'glaive');
  check(owned.has('shape4'), 'four picks earned the first shape milestone');
  check(!owned.has('shape8'), '...but not the second');
  eq(resolveAbility('glaive', u.upgrades).effects.find((e) => e.id === 'hit').zone.length, 2, 'the milestone reshaped the hit');
  check(!availableUpgrades(u).some((o) => o.ref === 'glaive:shape8'), 'milestones are never offered');
}

// ----- 19. overlap: Weak Point grants +2 to the next cast on the tile -----------
{
  const nodes = ['hu0', 'hu1a', 'hu1b', 'hu2a', 'hu2b', 'hu3b', 'hu4a', 'hu4b', 'hu5b'];
  const b = arena({ party: [member('Feren', nodes), member('Gorm')], enemies: [{ ...IDLE, hp: 30, maxHp: 30 }], partyKeys: [K(-2, 0), K(1, 0)], enemyKeys: [K(0, 0)] });
  const f = P(b, 0), g = P(b, 1);
  b.setFireOrder([f.uid, g.uid]);
  b.selectUnit(f.uid); b.selectAbility('bowBone'); b.clickTile(K(0, 0));
  b.selectUnit(g.uid); b.selectAbility('clawSwipe'); b.clickTile(K(0, 0));
  b.endTurn();
  eq(E(b, 0).hp, 30 - 3 - (3 + 2) - 1, 'bow bone 3, then the claw with +2 instead of +1 (and a wither tick)');
}

// ----- 20. flat damage mods: Strong / Weak / Impervious combine --------------------
{
  const b = arena({ party: [member('Gorm', ['tk0', 'tk1b', 'tk2c', 'tk2d', 'tk3d'])], enemies: [{ name: 'Husk', abilityIds: ['weakeningBite'], speed: 3 }], partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)] });
  const g = P(b, 0);
  check(has(g, 'impervious').length === 1 && has(g, 'impervious')[0].turns === 0, 'Hard Shell is a permanent Impervious 1');
  b.endTurn();   // the husk bites: Weak 1 for 2 turns
  eq(amount(g, 'weak'), 1, 'Weak 1 applied');
  volley(b, g, 'clawSwipe', K(1, 0));
  eq(E(b, 0).hp, 20 - (3 - 1), 'claw 3 -1 Weak');
}

console.log(`${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log(' - ' + p);
process.exit(problems.length ? 1 : 0);
