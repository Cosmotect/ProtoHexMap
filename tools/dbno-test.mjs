// =====================================================================
//  DBNO + turn-flow checks (2026-09-26), headless. node tools/dbno-test.mjs
//  Down but not out, revive by heal, bodies as obstacles, the win check,
//  aim lock keeps the selection, Reset party, walking from the current tile.
// =====================================================================
const base = new URL('../src/', import.meta.url).href;
const { CONFIG } = await import(base + 'config.js');
const { createBattle } = await import(base + 'local/battle/engine.js');
const { K } = await import(base + 'local/battle/bhex.js');

const problems = [];
let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) problems.push(msg); };
let supplies = 10;
function arena({ party, enemies, partyKeys, enemyKeys, onAnim = null, onEnd = () => {} }) {
  const b = createBattle({
    config: CONFIG, radius: 4, heights: {},
    party: party.map((p, i) => ({ hp: 20, maxHp: 20, partyIndex: i, ...p })),
    enemies: enemies.map((e) => ({ hp: 20, maxHp: 20, power: 0, init: 5, speed: 0, intellect: 'C', ...e })),
    partyKeys, enemyKeys, instant: true, rng: () => 0.5,
    supplies: { get: () => supplies, add: (n) => { supplies += n; } },
    onChange() {}, onFloater() {}, onLog() {}, onEnd, onAnim,
  });
  b.start && b.start();
  return b;
}
const P = (b, i) => b.state.units.filter((u) => !u.isEnemy)[i];
const E = (b, i) => b.state.units.filter((u) => u.isEnemy)[i];

// 1. A party unit at 0 hp is downed, stays on its tile, blocks it.
{
  const b = arena({
    party: [{ name: 'Vanguard', abilityIds: ['strike'] }, { name: 'Medic', abilityIds: ['mendingTouch'], speed: 3 }],
    enemies: [{ name: 'Husk', abilityIds: ['strike'] }],
    partyKeys: [K(0, 0), K(-2, 0)], enemyKeys: [K(3, 0)],
  });
  const v = P(b, 0), m = P(b, 1);
  v.hp = 0;
  check(v.downed === true, 'a unit at 0 hp should be downed');
  check(!b.state.over, 'one downed party member of two should not end the fight');
  // The medic cannot walk onto the body's tile.
  b.selectUnit(m.uid);
  const reach = b.reachFor();
  check(reach && reach.d[K(0, 0)] === undefined, 'a downed body should block walking onto its tile');
  // Mend it back up: medic walks next to it, aims Mend at it, ends the turn.
  b.clickTile(K(-1, 0));
  check(m.pos === K(-1, 0), 'medic should have walked next to the body, is on ' + m.pos);
  b.selectAbility('mendingTouch');
  check(b.state.aimMap && b.state.aimMap[K(0, 0)] !== undefined, 'Mend should be aimable at the downed body');
  b.clickTile(K(0, 0));
  check(!!m.lock, 'the medic should hold a lock');
  check(b.state.activeUid === m.uid, 'locking an aim should keep the same unit selected');
  b.endTurn();
  check(v.hp === 2 && !v.downed, `Mend should revive the body with 2 hp, it has ${v.hp} (downed ${v.downed})`);
  check(Object.keys(v.status || {}).length === 0, 'a revived unit gets up with no statuses');
}

// 2. All enemies downed = win; downed enemies stay on the board.
{
  let result = null;
  const b = arena({
    party: [{ name: 'Vanguard', abilityIds: ['strike'] }],
    enemies: [{ name: 'Husk', abilityIds: ['strike'], hp: 3, maxHp: 3 }],
    partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)], onEnd: (won) => { result = won; },
  });
  b.selectAbility('strike'); b.clickTile(K(1, 0)); b.endTurn();
  const e = E(b, 0);
  check(e.downed && e.pos === K(1, 0), 'a struck-down enemy should lie downed on its tile');
  check(result === true && b.state.over === 'win', 'downing the last enemy should win the fight');
}

// 3. All party downed = loss.
{
  let result = null;
  const b = arena({
    party: [{ name: 'Vanguard', abilityIds: ['strike'], hp: 2, maxHp: 20 }],
    enemies: [{ name: 'Husk', abilityIds: ['strike'] }],
    partyKeys: [K(0, 0)], enemyKeys: [K(1, 0)], onEnd: (won) => { result = won; },
  });
  b.endTurn();
  check(P(b, 0).downed && result === false, 'the whole party downed should lose the fight');
}

// 4. A shove into a downed body is a collision: the shoved unit crashes, the body takes nothing and stays.
{
  const b = arena({
    party: [{ name: 'Vanguard', abilityIds: ['shove'] }, { name: 'Medic', abilityIds: ['strike'] }],
    enemies: [{ name: 'Husk', abilityIds: ['strike'] }, { name: 'Husk', abilityIds: ['strike'] }],
    partyKeys: [K(0, 0), K(-3, 0)], enemyKeys: [K(1, 0), K(2, 0)],
  });
  const e0 = E(b, 0), e1 = E(b, 1);
  e1.hp = 0;   // downed behind e0
  b.selectUnit(P(b, 0).uid);
  b.selectAbility('shove'); b.clickTile(K(1, 0)); b.endTurn();
  check(e0.pos === K(1, 0), 'a unit shoved into a downed body should not move, is on ' + e0.pos);
  check(e0.hp === 20 - 1 - 2, `shove 1 + crash 2 expected on the shoved unit, it has ${e0.hp}`);
  check(e1.pos === K(2, 0) && e1.hp === 0 && e1.downed, 'the body should stay put, at 0, still downed');
}

// 4b. A downed body is shoved (no damage), and a body over the edge is gone.
{
  const b = arena({
    party: [{ name: 'Vanguard', abilityIds: ['shove'] }],
    enemies: [{ name: 'Husk', abilityIds: ['strike'] }, { name: 'Husk', abilityIds: ['strike'] }],
    partyKeys: [K(0, 0)], enemyKeys: [K(1, 0), K(-3, 0)],
  });
  const body = E(b, 0);
  body.hp = 0;
  b.selectAbility('shove');
  check(b.state.aimMap && b.state.aimMap[K(1, 0)] !== undefined, 'shove should be aimable at a body');
  b.clickTile(K(1, 0)); b.endTurn();
  check(body.pos === K(2, 0) && body.hp === 0 && body.downed, `a shoved body should slide to 2,0 still downed (on ${body.pos}, hp ${body.hp})`);
  const b2 = createBattle({
    config: CONFIG, radius: 1, heights: {}, voidEdgeKeys: [K(2, 0)],
    party: [{ name: 'Vanguard', hp: 20, maxHp: 20, abilityIds: ['shove'], partyIndex: 0 }],
    enemies: [{ name: 'Husk', hp: 20, maxHp: 20, abilityIds: ['strike'], init: 5, speed: 0 }, { name: 'Husk', hp: 20, maxHp: 20, abilityIds: ['strike'], init: 5, speed: 0 }],
    partyKeys: [K(0, 0)], enemyKeys: [K(1, 0), K(-1, 1)], instant: true, rng: () => 0.5,
    onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
  });
  b2.start();
  const bd = b2.state.units.find((u) => u.isEnemy && u.pos === K(1, 0)); bd.hp = 0;
  b2.selectAbility('shove'); b2.clickTile(K(1, 0)); b2.endTurn();
  check(bd.gone && !bd.downed, 'a body shoved into the void is gone');
}

// 5. Void kills for good (gone, not downed).
{
  const b = createBattle({
    config: CONFIG, radius: 1, heights: {}, voidEdgeKeys: [K(2, 0)],
    party: [{ name: 'Vanguard', hp: 20, maxHp: 20, abilityIds: ['shove'], partyIndex: 0 }],
    enemies: [{ name: 'Husk', hp: 20, maxHp: 20, abilityIds: ['strike'], init: 5, speed: 0 }, { name: 'Husk', hp: 20, maxHp: 20, abilityIds: ['strike'], init: 5, speed: 0 }],
    partyKeys: [K(0, 0)], enemyKeys: [K(1, 0), K(-1, 1)], instant: true, rng: () => 0.5,
    onChange() {}, onFloater() {}, onLog() {}, onEnd() {},
  });
  b.start();
  b.selectAbility('shove'); b.clickTile(K(1, 0)); b.endTurn();
  const e = b.state.units.find((u) => u.isEnemy && u.pos === K(1, 0) || u.gone);
  check(e && e.gone && !e.downed, 'a unit shoved into the void is gone, not downed');
}

// 6. Reset party: locks off, everyone back on the start tile, selection kept.
{
  const b = arena({
    party: [{ name: 'Vanguard', abilityIds: ['strike'], speed: 3 }, { name: 'Medic', abilityIds: ['strike'], speed: 3 }],
    enemies: [{ name: 'Husk', abilityIds: ['strike'] }],
    partyKeys: [K(0, 0), K(-2, 0)], enemyKeys: [K(3, 0)],
  });
  const a = P(b, 0), m = P(b, 1);
  b.selectUnit(a.uid); b.clickTile(K(1, 0));
  b.selectAbility('strike'); b.clickTile(K(2, 0));
  b.selectUnit(m.uid); b.clickTile(K(-1, 1));
  check(a.pos === K(1, 0) && !!a.lock && m.pos === K(-1, 1), 'setup for the reset test failed');
  b.resetParty();
  check(a.pos === K(0, 0) && m.pos === K(-2, 0), `reset should put both back (${a.pos}, ${m.pos})`);
  check(!a.lock && !m.lock, 'reset should take every lock back');
}

// 7. A second walk starts from where the unit stands, not from its start tile.
{
  const paths = [];
  const b = arena({
    party: [{ name: 'Vanguard', abilityIds: ['strike'], speed: 3 }],
    enemies: [{ name: 'Husk', abilityIds: ['strike'] }],
    partyKeys: [K(0, 0)], enemyKeys: [K(4, 0)],
    onAnim: (anim, done) => { paths.push(anim.path.slice()); for (const k of anim.path.slice(1)) anim.enter(k); done(); },
  });
  b.clickTile(K(0, 2));
  b.clickTile(K(1, 1));
  const p2 = paths[1] || [];
  check(p2[0] === K(0, 2), `the second walk should start at the unit's tile 0,2, starts at ${p2[0]}`);
  check(P(b, 0).pos === K(1, 1), 'the unit should end on 1,1');
  check(b.moveLeft(P(b, 0)) === 1, `move left should be measured from the start tile (3 - 2 = 1), is ${b.moveLeft(P(b, 0))}`);
}

// 8. Selecting through the panel (selectUnit) puts an aimed ability down.
{
  const b = arena({
    party: [{ name: 'Vanguard', abilityIds: ['strike'] }, { name: 'Medic', abilityIds: ['strike'] }],
    enemies: [{ name: 'Husk', abilityIds: ['strike'] }],
    partyKeys: [K(0, 0), K(-2, 0)], enemyKeys: [K(3, 0)],
  });
  b.selectAbility('strike');
  b.selectUnit(P(b, 1).uid);
  check(b.state.activeUid === P(b, 1).uid && !b.state.selAb, 'selectUnit should switch the unit and drop the aimed ability');
  P(b, 0).hp = 0;
  check(!b.selectUnit(P(b, 0).uid), 'a downed unit cannot be selected');
}

console.log(`${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log(' - ' + p);
process.exit(problems.length ? 1 : 0);
