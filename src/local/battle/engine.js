// =====================================================================
//  COMBAT ENGINE - the hex-box battle core, transplanted.
//
//  Ported from hex-box js/09..12 (battle state, effect resolver, turn flow,
//  movement + enemy AI) with the editors, storage, undo, prediction UI and the
//  2D isometric renderer left behind. The engine is pure state + rules: it
//  never touches the DOM or Three.js. Everything visual goes out through the
//  callbacks given to createBattle():
//    onChange()                 state changed - re-read and redraw
//    onFloater(k, text, color)  a floating combat text over tile k
//    onLog(text)                one battle-log line (plain text)
//    onAnim(anim, done)         animate a move; call done() per tile entered
//                               via anim.enter(k) -> true means "stop here",
//                               then done() when the walk is over
//    onEnd(won)                 the battle is decided
//
//  Original behaviours kept: free player activation order, enemy phase by
//  initiative, one move + one cast per activation (the cast ends it), terrain
//  tag ticks, statuses (shield / crit / stun / speed change), pushes with
//  collisions, falls, crush chains and void edges, height changes, tag
//  placement with on-destroy / on-expire / periodic casts, high/low ground
//  damage modifiers, and the outcome-scoring enemy AI.
//  Added for Everlands: every ability carries its own flat `damage` (no more
//  ENEMY-only power bonus - removed 2026-09-10, a bestiary row's abilities are
//  its whole strength now); PARTY units instead fight with their UPGRADED
//  ability defs (def.abilityDefs, resolved by src/upgrades.js from the unit's
//  unlocked tree nodes); partyDamageMod is a flat penalty to the party's
//  ability damage (the Stasis "damage" debuff); and a fatigue-forced fight
//  opens with an ambush enemy phase before round 1.
// =====================================================================
import { DIRS, K, PK, addK, hexDist, hexLine, rotOff, aimRot, abRotFor, rotDir, boardTiles } from './bhex.js';
import { abilityById, tagDefById, statusOverridesFor } from '../../config/abilities.js';
import { combatStatsFor } from '../../config/units.js';

export function createBattle({ config, radius, heights, party, enemies, partyKeys, enemyKeys, forced,
                               partyDamageMod = 0, deferOpening = false, voidEdgeKeys = [],
                               wallKeys = [], etherKeys = [], startTags = [],
                               rng = Math.random, noFlee = false, instant = false,
                               onChange, onFloater, onLog, onAnim, onEnd, onUnitDeath, onUnitFlee }) {
  const CFG = config.combat;
  // INSTANT MODE (the Virtual Playtester, tools/playtester): every pacing delay
  // in this file goes through `wait`, and with instant: true it collapses into
  // a synchronous call - a whole enemy phase resolves before endTurn() returns.
  // The RULES are untouched: the timeouts only ever existed so a human could
  // watch the fight happen. The game itself never passes the flag.
  const wait = (fn, ms) => { if (instant) fn(); else setTimeout(fn, ms); };
  const R = radius;
  const tiles = boardTiles(R);
  const inMap = (k) => { const [q, r] = PK(k); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= R; };
  // AUTHORED TILES (handcrafted maps, src/local/mapcode.js). Walls and ether
  // holes are tiles inside the board that nobody may stand on - walking and
  // flying alike route around them. What tells them apart is what a SHOVE
  // into one does: a wall crashes the victim like the arena rim, an ether
  // hole swallows it like the void past a lethal edge (see isVoid below).
  const wallSet = new Set(wallKeys ?? []);
  const etherSet = new Set(etherKeys ?? []);
  const tilePass = (k) => inMap(k) && !wallSet.has(k) && !etherSet.has(k);
  // How far out a tile sits: 0 at the centre, R on the rim. The retreat rule reads
  // it to point a fleeing enemy at the nearest way off the board.
  const ringOf = (k) => { const [q, r] = PK(k); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)); };
  // THE VOID EDGE. Off-board tiles are normally a wall to be crashed into. The
  // ones listed in voidEdgeKeys are a hole instead: the arena side facing them
  // borders an ether world tile (or the world's own rim), so there is nothing
  // out there to hit - whatever is shoved that way falls out of the world and
  // dies on the spot. The list is computed by the view, which is the only place
  // that knows how the arena sits inside the world map (LocalMapView.voidEdgeKeys).
  // config.combat.voidEdges = true still makes EVERY edge lethal, as before.
  const voidSet = new Set(voidEdgeKeys ?? []);
  const isVoid = (k) => etherSet.has(k)
    || (!inMap(k) && (CFG.voidEdges || voidSet.has(k)));
  const activeTiles = () => tiles;
  const abById = abilityById;
  // A unit's view of an ability: its own resolved (upgraded) def when it has
  // one, the base table otherwise (enemies, tag-triggered casts).
  const abFor = (u, id) => (u && u.abilityDefs && u.abilityDefs[id]) || abilityById(id);

  let idc = 1;
  const nid = () => idc++;

  // ----- battle state (hex-box `sb`) -----------------------------------
  const sb = {
    units: [], uidc: 0, tags: {}, heights: { ...heights },
    round: 1, phase: 'player', activeUid: null,
    enemyQ: [], eqi: 0, selAb: null, aimMap: null, reach: null,
    // Inspecting an ENEMY: purely a readout, it changes nothing about the turn.
    // The party's own selection is untouched, so the player can look at what a
    // creature can reach and then carry on with the unit they had picked.
    inspectUid: null, inspectReach: null,
    busy: false, over: null, deathQueue: [], ambush: !!forced,
    // True for a Stasis Seed / Colony fight: this enemy never breaks and runs.
    noFlee: !!noFlee,
    // Where every unit that died fell - see noteDeath below.
    deaths: [],
  };

  const emit = () => onChange && onChange();
  const floater = (k, text, color) => onFloater && onFloater(k, text, color);
  const blog = (t) => onLog && onLog(t);

  // ----- death spots ------------------------------------------------------
  // Every unit death is reported ON A TILE: the tile it was standing on when it
  // died. For a unit shoved into the void that is its LAST tile INSIDE the
  // arena, not the hole it fell into - loot dropped by a kill has to land
  // somewhere the party can still walk to.
  // Recorded in sb.deaths and handed to onUnitDeath(spot); the loot system will
  // hang off this hook. Real deaths only - the enemy AI's simulation of a cast
  // never reports - and once per unit.
  const deathReported = new Set();
  function noteDeath(st, u, tileK, cause) {
    if (!st || st.sim || !u || u.uid === undefined || deathReported.has(u.uid)) return;
    deathReported.add(u.uid);
    const spot = {
      uid: u.uid, name: u.name, icon: u.icon ?? null,
      isEnemy: !!u.isEnemy, partyIndex: u.partyIndex ?? null,
      key: tileK ?? u.pos, cause: cause ?? 'damage', round: sb.round,
    };
    sb.deaths.push(spot);
    if (onUnitDeath) onUnitDeath(spot);
  }

  function makeInstance(def, isEnemy, pos, i) {
    // The definition wins where it has an opinion: a bestiary row carries its
    // own init / speed / flying / abilities (config/units.js), so a creature
    // invented in the Settings window fights as written instead of falling
    // through to party.defaultCombat, the nameless fallback. The party, and any older
    // hand-authored def, still reads the table by name.
    const cs = combatStatsFor(def.name);
    return {
      uid: 's' + i, name: def.name, icon: def.icon ?? null,
      // Enemies only: the enemy queue sorts by it. Party rows carry no init
      // (removed 2026-09-06), so a character lands on 0 and nothing reads it.
      init: def.init ?? cs.init ?? 0,
      speed: def.speed ?? cs.speed,
      flying: !!(def.flying ?? cs.flying),
      maxHp: def.maxHp ?? def.hp, hp: def.hp,
      abilityIds: [...(def.abilityIds?.length ? def.abilityIds : cs.abilities)],
      abilityDefs: def.abilityDefs ?? null,
      pos, isEnemy, idx: i, partyIndex: def.partyIndex ?? null,
      startPos: pos, moveLocked: false, done: false, tagTicked: false,
      status: {}, summoned: false,
      // INTELLECT CLASS (config.intellect): which facts this creature can weigh on
      // its turn. Anything hand-authored without one is treated as the dimmest.
      intellect: def.intellect ?? 'C',
    };
  }
  let i = 0;
  party.forEach((def, pi) => { if (partyKeys[pi]) sb.units.push(makeInstance({ ...def, partyIndex: def.partyIndex ?? pi }, false, partyKeys[pi], i++)); });
  enemies.forEach((def, ei) => { if (enemyKeys[ei]) sb.units.push(makeInstance(def, true, enemyKeys[ei], i++)); });
  // What the enemy side was worth at the bell - the baseline the retreat rule
  // measures "beaten" against (CFG.flee).
  sb.enemyHp0 = sb.units.reduce((a2, u) => a2 + (u.isEnemy ? u.hp : 0), 0);
  sb.uidc = i;

  function tagInst(d, id, k) {
    return { tid: nid(), defId: id, k, name: d.name, icon: d.icon, color: d.color, desc: d.desc,
      dmg: d.dmg, heal: d.heal, life: d.life, hp: d.hp, maxHp: d.hp,
      pushable: d.pushable, collectible: d.collectible, passPickup: d.passPickup,
      onDestroy: d.onDestroy, onExpire: d.onExpire, onPickup: d.onPickup, onPeriodic: d.onPeriodic,
      everyX: d.everyX || 0, everyOff: d.everyOff || 0,
      everyCd: (d.everyOff > 0 ? d.everyOff : d.everyX) || 0 };
  }

  // Pre-lit tile tags from a handcrafted map (braziers of fire and the like):
  // the same instances an ability's tagZone would create, burning from round
  // one - except PERMANENT (life 0): authored hazards are part of the arena,
  // they do not gutter out after a couple of rounds the way a cast does.
  for (const s of startTags ?? []) {
    const d = tagDefById(s.id);
    if (d && tilePass(s.k) && !sb.tags[s.k]) {
      const inst = tagInst(d, s.id, s.k);
      inst.life = 0;
      sb.tags[s.k] = inst;
    }
  }

  // ----- small queries --------------------------------------------------
  const sbH = (k) => sb.heights[k] ?? 0;
  const alive = (f) => sb.units.filter((u) => u.hp > 0 && (f === undefined || u.isEnemy === f));   // fled units carry hp 0, so they drop out here too
  const unitAt = (k) => sb.units.find((u) => u.hp > 0 && u.pos === k);
  const curP = () => sb.units.find((u) => u.uid === sb.activeUid && !u.isEnemy && u.hp > 0);
  const speedFloor = (u) => Math.min(u.speed, CFG.minSpeed);
  const effSpeed = (u) => Math.max(speedFloor(u), u.speed + statusSum(u, 'speed'), 0);

  // ----- statuses --------------------------------------------------------
  // Everything about a status lives in the table (config.statuses, written out in
  // src/config/abilities.js); the code below only knows the SHAPE of a row, never
  // a particular status. A unit carries a bag:
  //     u.status = { poison: { turns: 3, charges: 0, over: { tickDamage: 4 } } }
  // `over` is what the ability changed about this status through buffX - only the
  // knobs it actually named. Every other field is read from the table.
  const statusDef = (id) => (config.statuses ?? {})[id] ?? null;
  const carried = (u) => (u && u.status) || null;
  // One field of one status this unit is carrying, with the ability's own
  // overrides folded in.
  function statusField(u, id, field) {
    const def = statusDef(id);
    if (!def || !carried(u) || !u.status[id]) return undefined;
    const over = u.status[id].over;
    return over && over[field] !== undefined ? over[field] : def[field];
  }
  // Additive fields (speed), multiplicative ones (damageDealt / damageTaken) and
  // plain switches (blocks, skipsTurn), summed / multiplied over the whole bag.
  function statusSum(u, field) {
    let n = 0;
    for (const id in (carried(u) || {})) { const v = statusField(u, id, field); if (typeof v === 'number') n += v; }
    return n;
  }
  function statusMul(u, field) {
    let n = 1;
    for (const id in (carried(u) || {})) { const v = statusField(u, id, field); if (typeof v === 'number') n *= v; }
    return n;
  }
  // The id of the first carried status with this switch on (null = none).
  function statusWith(u, field) {
    for (const id in (carried(u) || {})) { if (statusField(u, id, field)) return id; }
    return null;
  }
  // Icon and colour to show. Every status is its own row, so there is nothing to
  // work out here - a slow is not a haste wearing a different face.
  function statusView(u, id) {
    const def = statusDef(id) || {};
    return { icon: def.icon, color: def.color };
  }
  // Puts a status on a unit (re-applying refreshes it rather than stacking).
  // buffX is the ability's number; what it MEANS is the table's business.
  function applyStatus(st, u, id, buffX) {
    const def = statusDef(id);
    if (!def || !u || u.uid === undefined || u.hp <= 0) return;
    // buffX lines up, in order, with the knobs this status uses (config/abilities.js).
    // Whatever it does not name keeps the number the table wrote - which is what
    // you almost always want, and what keeps a multiplier status applied by an
    // ability that never thought about buffX from landing as a meaningless x1.
    const over = statusOverridesFor(def, buffX);
    // The two counters are knobs like any other, so an ability can say how long
    // its poison lasts; they just also happen to be what ticks down from here.
    if (!u.status) u.status = {};
    u.status[id] = {
      turns: over.turns !== undefined ? over.turns : (def.turns || 0),
      charges: over.charges !== undefined ? over.charges : (def.charges || 0),
      over,
    };
    if (st.sim) (st.rec.applied[u.uid] ??= {})[id] = 1;
    else { const v = statusView(u, id); floater(u.pos, v.icon, v.color); }
  }
  function dropStatus(st, u, id, stripped) {
    if (!carried(u) || !u.status[id]) return;
    delete u.status[id];
    // A status TAKEN OFF a unit matters to the AI as much as one put on: popping a
    // shield is the whole reason an enemy swings at a shielded target.
    if (st && st.sim && stripped) (st.rec.stripped[u.uid] ??= {})[id] = 1;
  }
  // Spends one charge of the statuses this event uses up. `only` limits it to the
  // one status that actually did the work (the shield that blocked THIS hit).
  function spendStatus(st, u, event, only) {
    for (const id of Object.keys(carried(u) || {})) {
      if (only && id !== only) continue;
      const def = statusDef(id);
      if (!def || def.spentOn !== event) continue;
      const slot = u.status[id];
      slot.charges = (slot.charges || 1) - 1;
      if (slot.charges <= 0) dropStatus(st, u, id, true);
    }
  }
  // The start of a unit's own activation: statuses bite, then their clock runs
  // down. Damage first, so "3 turns of poison" really deals its damage 3 times.
  // This happens even on a turn the unit is about to lose to a stun.
  function tickStatuses(u) {
    if (!carried(u) || u.hp <= 0) return;
    const st = liveSt();
    for (const id of Object.keys(u.status)) {
      const dmg = statusField(u, id, 'tickDamage') || 0;
      const heal = statusField(u, id, 'tickHeal') || 0;
      if (dmg > 0) { st.atk = null; sHit(st, u, dmg, statusDef(id).name); }
      if (heal > 0 && u.hp > 0) sHeal(st, u, heal);
    }
    flushDeaths(st);
    if (u.hp <= 0) return;
    for (const id of Object.keys(u.status)) {
      const slot = u.status[id];
      if (!(slot.turns > 0)) continue;
      slot.turns -= 1;
      if (slot.turns <= 0) {
        const v = statusView(u, id);
        dropStatus(st, u, id, false);
        floater(u.pos, v.icon + ' ends', '#7c8aa5');
      }
    }
  }
  // ----- intellect classes (config.intellect) ------------------------------
  // What a creature is able to WEIGH when it plans its turn. It changes no rule:
  // a witless brute still takes the high-ground bonus if it happens to stand high
  // and still dies in the void, it just never thinks about either. See the table
  // in src/config/abilities.js for what each flag covers.
  const DIM = { statuses: false, elevation: false, tags: false, ether: false, injuries: false };
  const mindOf = (u) => (config.intellect ?? {})[u && u.intellect] ?? (config.intellect ?? {}).C ?? DIM;
  // The blindfold a simulation wears while this creature imagines a move. The
  // resolution reads it too, so a mind that cannot weigh height simply never sees
  // the height bonus in the outcome it is judging.
  const blindfold = (mind) => ({ elevation: !mind.elevation, ether: !mind.ether });

  // How much THIS target wants (or dreads) a status, for a mind clever enough to
  // ask. `v` is the status's worth: negative means it is a good thing to carry.
  //  * a blessing counts for more on an ally that is hurt or already in reach of
  //    the party - that is the difference between handing a shield to whoever is
  //    nearest and handing it to whoever is about to be hit;
  //  * a curse counts for less on someone who will not live long enough to suffer it.
  // Always at least a little, so a clever mind never refuses a target outright.
  function statusNeed(u, was, v) {
    if (!was || !was.maxHp) return 1;
    const hpFrac = Math.max(0, Math.min(1, was.hp / was.maxHp));
    if (v < 0) {
      const exposed = alive(false).some((p) => hexDist(p.pos, u.pos) <= 1) ? 0.5 : 0;
      return 0.5 + (1 - hpFrac) + exposed;
    }
    return 0.5 + hpFrac;
  }

  // What the AI thinks a status is worth on a unit. Straight from the table: each
  // status states its own worth, so nothing has to be guessed from a sign.
  function statusValue(id) {
    const def = statusDef(id);
    return def ? (def.aiValue || 0) : 0;
  }
  // partyDamageMod is a flat penalty applied to party casts only (the Stasis
  // "damage" debuff) - there is no equivalent enemy-side bonus any more
  // (removed 2026-09-10, an ability's own `damage` field is a bestiary row's
  // whole strength now).
  const dmgMod = (c) => (c && c.isEnemy === false ? -partyDamageMod : 0);

  // ----- live / simulated effect state (hex-box 10-battle-effects) -------
  function liveSt() { return { sim: false, units: sb.units, tags: sb.tags, heights: sb.heights, deathQueue: sb.deathQueue, rec: null }; }
  function simSt(blind) {
    return { sim: true, blind: blind || null,
      units: sb.units.map((u) => ({ uid: u.uid, isEnemy: u.isEnemy, flying: u.flying, hp: u.hp, maxHp: u.maxHp, pos: u.pos,
        // the whole status bag, copied one level deep - forgetting this is what used
        // to make the AI simulate a board it could not actually see
        status: Object.fromEntries(Object.entries(u.status || {}).map(([id, v]) => [id, { ...v }])) })),
      tags: Object.fromEntries(Object.entries(sb.tags).map(([k, t]) => [k, { ...t }])),
      heights: { ...sb.heights }, deathQueue: [],
      rec: { dmg: {}, moved: {}, killed: {}, applied: {}, stripped: {}, voided: {}, tmoved: {}, tkilled: {} } };
  }
  const stH = (st, k) => st.heights[k] ?? 0;
  const sUnitAt = (st, k) => st.units.find((u) => u.hp > 0 && u.pos === k);
  const sBarrier = (st, k) => { const t = st.tags[k]; return t && t.hp > 0 ? t : null; };

  function sHit(st, v, amt, label, pre) {
    if (amt <= 0 || !v) return;
    pre = pre || '';
    const atk = st.atk ? st.atk + ' -> ' : '';
    if (v.uid !== undefined) {
      if (v.hp <= 0) return;
      // A status that BLOCKS eats the whole hit. That is not a wasted swing: it
      // spends the status, and the sim records the strip (st.rec.stripped) so the AI
      // values it - recording nothing at all is what used to make enemies ignore a
      // shielded unit for the rest of the fight, and a shield nobody attacks never
      // expires. One charge covers a whole cast (st.shieldUsed), so a wide ability
      // cannot chew through it with its second tile.
      const blockId = statusWith(v, 'blocks');
      if (blockId || (st.shieldUsed && st.shieldUsed.has(v.uid))) {
        if (blockId) {
          if (st.shieldUsed) st.shieldUsed.add(v.uid);
          const view = statusView(v, blockId);
          spendStatus(st, v, 'hit', blockId);
          if (!st.sim) { floater(v.pos, pre + view.icon, view.color); blog(atk + v.name + ': blocked'); }
        } else if (!st.sim) { floater(v.pos, pre + 'BLOCKED', '#5fc7e0'); blog(atk + v.name + ': blocked'); }
        return;
      }
      // Statuses that change how much damage this unit TAKES (vulnerable, fortified).
      amt = Math.max(1, Math.round(amt * statusMul(v, 'damageTaken')));
      v.hp = Math.max(0, v.hp - amt);
      if (st.sim) { st.rec.dmg[v.uid] = (st.rec.dmg[v.uid] || 0) + amt; if (v.hp <= 0) st.rec.killed[v.uid] = 1; }
      else {
        floater(v.pos, pre + '-' + amt + (label ? ' ' + label : ''), '#ff5d73');
        blog(atk + v.name + ': -' + amt + (label ? ' ' + label : ''));
        if (v.hp <= 0) { blog(v.name + ' is down'); noteDeath(st, v, v.pos, label || 'damage'); }
      }
    } else {
      if (v.hp <= 0) return;
      v.hp = Math.max(0, v.hp - amt);
      if (!st.sim) { floater(v.k, pre + '-' + amt, '#ffd75f'); blog(atk + v.name + ': -' + amt); }
      if (v.hp <= 0) {
        if (st.tags[v.k] === v) delete st.tags[v.k];
        if (st.sim) st.rec.tkilled[v.tid] = 1;
        else { floater(v.k, '✸ ' + v.name, '#ff9950'); blog(v.name + ' is destroyed'); }
        if (v.onDestroy) st.deathQueue.push({ abId: v.onDestroy, k: v.k, name: v.name });
      }
    }
  }
  function sHeal(st, v, amt) {
    if (amt <= 0 || !v || v.uid === undefined || v.hp <= 0) return;
    const g = Math.min(amt, v.maxHp - v.hp);
    v.hp += g;
    if (st.sim) st.rec.dmg[v.uid] = (st.rec.dmg[v.uid] || 0) - g;
    else if (g > 0) { floater(v.pos, '+' + g, '#a8e05f'); blog((st.atk ? st.atk + ' -> ' : '') + v.name + ': +' + g); }
  }
  // Crashes and falls stun; so does any ability with buff: 'stun'. All of them come
  // through here, and what "stunned" DOES is the table's business, not this line's.
  function sStun(st, v) {
    if (!v || v.uid === undefined || v.hp <= 0) return;
    applyStatus(st, v, 'stun');
    if (st.sim) return;
    blog(v.name + ' is stunned');
    // A player unit that still has its turn this round loses THAT turn on the spot.
    if (sb.phase === 'player' && sb.activeUid && !v.isEnemy && !v.done && v.uid !== sb.activeUid) {
      v.done = true;
      dropStatus(st, v, 'stun', false);
      blog(v.name + ' loses this turn');
    }
  }
  function sVoid(st, ent) {
    if (!ent || ent.hp <= 0) return;
    if (ent.uid !== undefined) {
      if (st.sim) {
        // The hole is always lethal; it is only an OPPORTUNITY to a mind that can
        // weigh it. A blind one records the shove and none of its worth.
        st.rec.voided[ent.uid] = 1;
        if (!(st.blind && st.blind.ether)) { st.rec.dmg[ent.uid] = (st.rec.dmg[ent.uid] || 0) + ent.hp; st.rec.killed[ent.uid] = 1; }
      }
      else { floater(ent.pos, '🕳 VOID', '#c66dff'); blog(ent.name + ' is shoved into the void'); }
      // Reported BEFORE hp drops, while ent.pos is still the tile it stood on:
      // that tile, not the hole, is where anything it was carrying stays.
      noteDeath(st, ent, ent.pos, 'void');
      ent.hp = 0;
    } else {
      ent.hp = 0;
      if (st.tags[ent.k] === ent) delete st.tags[ent.k];
      if (st.sim) st.rec.tkilled[ent.tid] = 1;
      else { floater(ent.k, '🕳 ' + ent.name, '#c66dff'); blog(ent.name + ' falls into the void'); }
    }
  }
  function sMoveTo(st, ent, k) {
    if (ent.uid !== undefined) { ent.pos = k; if (st.sim) st.rec.moved[ent.uid] = k; }
    else { if (st.tags[ent.k] === ent) delete st.tags[ent.k]; ent.k = k; st.tags[k] = ent; if (st.sim) st.rec.tmoved[ent.tid] = k; }
  }
  function sArrive(st, u, depth = 0) {
    if (!u || u.uid === undefined || u.hp <= 0) return;
    const t = st.tags[u.pos];
    if (t && t.collectible && t.hp <= 0) {
      delete st.tags[u.pos];
      if (!st.sim) floater(u.pos, t.icon + ' ' + t.name, '#a8e05f');
      if (t.onPickup) { if (!st.sim) blog(u.name + ' picks up ' + t.name); const ab = abById(t.onPickup); if (ab) resolveCast(st, { pos: u.pos, name: t.name }, ab, u.pos, depth + 1); }
    }
  }
  function sPush(st, ent, dir, depth = 0) {
    if (depth > 8) return;
    const isU = ent.uid !== undefined;
    if (isU && ent.hp > 0) {
      const c = st.csr;
      const hostile = !c || c.isEnemy === undefined || c.isEnemy !== ent.isEnemy;
      const pushBlockId = hostile ? statusWith(ent, 'blocks') : null;
      if (hostile && (pushBlockId || (st.shieldUsed && st.shieldUsed.has(ent.uid)))) {
        const view = pushBlockId ? statusView(ent, pushBlockId) : { icon: 'BLOCKED', color: '#5fc7e0' };
        if (pushBlockId) { if (st.shieldUsed) st.shieldUsed.add(ent.uid); spendStatus(st, ent, 'hit', pushBlockId); }
        if (!st.sim) { floater(ent.pos, view.icon, view.color); blog((st.atk ? st.atk + ' -> ' : '') + ent.name + ': push blocked'); }
        return;
      }
    }
    const k = isU ? ent.pos : ent.k;
    const nk = addK(k, DIRS[dir]);
    if (isVoid(nk)) { sVoid(st, ent); return; }
    const wall = !tilePass(nk) || (stH(st, nk) - stH(st, k) >= 2);
    if (wall) { sHit(st, ent, 2, 'crash'); return; }
    const occ = sUnitAt(st, nk) || sBarrier(st, nk);
    const drop = stH(st, k) - stH(st, nk);
    if (occ) {
      if (drop >= 2) {
        sHit(st, occ, 2, 'crush'); sStun(st, occ);
        const saved = occ.uid !== undefined && st.shieldUsed && st.shieldUsed.has(occ.uid);
        if (occ.hp > 0 && !saved) {
          const nk2 = addK(nk, DIRS[dir]);
          const room = isVoid(nk2) || (tilePass(nk2) && (stH(st, nk2) - stH(st, nk) < 2) && !sUnitAt(st, nk2) && !sBarrier(st, nk2));
          if (room) sPush(st, occ, dir, depth + 1);
          else if (occ.uid !== undefined) {
            if (st.sim) { st.rec.dmg[occ.uid] = (st.rec.dmg[occ.uid] || 0) + occ.hp; st.rec.killed[occ.uid] = 1; }
            else { floater(nk, 'CRUSHED', '#ff5d73'); blog(occ.name + ' is crushed flat'); }
            noteDeath(st, occ, nk, 'crush');
            occ.hp = 0;
          } else sHit(st, occ, 999, '');
        }
        const blocked = sUnitAt(st, nk) || sBarrier(st, nk);
        if (blocked) {
          sHit(st, ent, 2, 'crash');
        } else if (ent.hp > 0) {
          sMoveTo(st, ent, nk);
          sHit(st, ent, 2, 'fall'); sStun(st, ent);
          if (isU) sArrive(st, ent, depth);
        }
      } else {
        sHit(st, ent, 2, 'crash'); sHit(st, occ, 2, 'crash');
      }
    } else {
      sMoveTo(st, ent, nk);
      if (drop >= 2) { sHit(st, ent, 2, 'fall'); sStun(st, ent); }
      if (isU && ent.hp > 0) sArrive(st, ent, depth);
    }
  }
  function sPushCorpse(st, ent, dir) {
    const k = ent.pos, nk = addK(k, DIRS[dir]);
    if (!tilePass(nk) || (stH(st, nk) - stH(st, k) >= 2)) return;
    const occ = sUnitAt(st, nk) || sBarrier(st, nk);
    if (occ) sHit(st, occ, 2, 'crash');
  }
  function flushDeaths(st, depth = 0) {
    let guard = 0;
    while (st.deathQueue.length && guard++ < 24) {
      const d = st.deathQueue.shift();
      const ab = abById(d.abId);
      if (ab) resolveCast(st, { pos: d.k, name: d.name }, ab, d.k, depth + 1);
    }
  }

  // The cast pipeline: damage/heal/status -> pushes -> heights -> tags -> spawns -> dash.
  function resolveCast(st, caster, ab, targetK, depth = 0) {
    if (!ab || depth > 6) return;
    const prevAtk = st.atk, prevCsr = st.csr, prevSU = st.shieldUsed;
    st.csr = caster; st.shieldUsed = new Set();
    if (caster.name) st.atk = caster.name;
    if (!st.sim && caster.name) blog(caster.name + ' casts ' + ab.name);
    const rk = abRotFor(ab, caster.pos, targetK);
    const preAlive = new Set();
    for (const u of st.units) if (u.hp > 0) preAlive.add(u.uid);
    // 1 - damage / heal / statuses
    // How hard this caster hits right now: every status it carries with a
    // damageDealt multiplier, folded together. Read BEFORE the cast spends any of
    // them, so a one-shot buff applies to the whole cast and not just its first tile.
    const dealtMul = ab.damage > 0 ? statusMul(caster, 'damageDealt') : 1;
    const dealtLabel = dealtMul > 1 ? 'CRIT' : dealtMul < 1 ? 'WEAK' : '';
    if (ab.damage > 0) spendStatus(st, caster, 'attack');
    for (const off of ab.dmgZone) {
      const dt = addK(targetK, rotOff(off, rk)); if (!tilePass(dt)) continue;
      const u = sUnitAt(st, dt), bt = sBarrier(st, dt);
      const tgt = u || bt;
      if (!tgt) { if (!st.sim) floater(dt, '✸', ab.color); continue; }
      if (ab.damage > 0) {
        let dmg = Math.max(0, ab.damage + dmgMod(caster)), lbl = '';
        // A mind blind to elevation judges the blow as if the ground were flat. The
        // REAL cast (st.sim false) always counts the height - the rule is the rule.
        if (u && !(st.blind && st.blind.elevation)) {
          const hd = stH(st, caster.pos) - stH(st, dt);
          if (hd >= 2 && CFG.highBonus > 0) { dmg += CFG.highBonus; lbl = 'HIGH'; }
          else if (hd <= -2 && CFG.lowPenalty > 0) { dmg = Math.max(0, dmg - CFG.lowPenalty); lbl = 'LOW'; }
        }
        if (u && dealtMul !== 1) { dmg = Math.max(0, Math.round(dmg * dealtMul)); lbl = (lbl ? lbl + ' ' : '') + dealtLabel; }
        if (dmg > 0) sHit(st, tgt, dmg, lbl, '✸ ');
        else if (!st.sim) floater(dt, '✸ 0 ' + lbl, '#9aa7bd');
      } else if (!st.sim) floater(dt, '✸', ab.color);
      if (u && u.hp > 0) {
        if (ab.heal > 0) sHeal(st, u, ab.heal);
        // ONE line for every status there is or ever will be: the ability names one
        // (buff) and hands over a number (buffX), and the table decides the rest.
        if (ab.buff === 'stun') sStun(st, u);
        else if (ab.buff && statusDef(ab.buff)) applyStatus(st, u, ab.buff, ab.buffX);
      }
    }
    flushDeaths(st, depth);
    // 2 - pushes, in waves (see hex-box for the full commentary)
    const shoves = [];
    for (const o of ab.pushZone) {
      const dt = addK(targetK, rotOff([o[0], o[1]], rk)); if (!tilePass(dt)) continue;
      const rd = rotDir(o[2], rk);
      const dist = (o[3] || 1) >= 2 ? 2 : 1;
      const u = sUnitAt(st, dt);
      if (u) { shoves.push({ ent: u, dir: rd, dist }); continue; }
      const corpse = st.units.find((x) => x.hp <= 0 && !x.fled && x.pos === dt && preAlive.has(x.uid));
      if (corpse) { sPushCorpse(st, corpse, rd); continue; }
      const t = st.tags[dt]; if (t && t.hp > 0 && t.pushable) shoves.push({ ent: t, dir: rd, dist });
    }
    const maxDist = shoves.reduce((m, s) => Math.max(m, s.dist), 0);
    const posOf = (e) => (e.uid !== undefined ? e.pos : e.k);
    const stepOne = (s) => {
      s.pending = false;
      if (s.ent.hp <= 0) { s.stopped = true; return; }
      const from = posOf(s.ent);
      sPush(st, s.ent, s.dir, depth);
      if (posOf(s.ent) === from) s.stopped = true;
    };
    for (let step = 0; step < maxDist; step++) {
      const wave = shoves.filter((s) => !s.stopped && s.dist > step);
      for (const s of wave) s.pending = true;
      let guard = 0;
      while (wave.some((s) => s.pending)) {
        let moved = false;
        for (const s of wave) {
          if (!s.pending) continue;
          const nk = addK(posOf(s.ent), DIRS[s.dir]);
          if (wave.some((o) => o !== s && o.pending && o.ent.hp > 0 && posOf(o.ent) === nk)) continue;
          stepOne(s); moved = true;
        }
        if (!moved || guard++ > wave.length + 2) for (const s of wave) if (s.pending) stepOne(s);
      }
    }
    flushDeaths(st, depth);
    // 3 - height changes (units on the tile are unaffected)
    for (const o of ab.hZone) {
      const dt = addK(targetK, rotOff([o[0], o[1]], rk)); if (!tilePass(dt)) continue;
      const h0 = st.heights[dt] ?? 0;
      st.heights[dt] = Math.max(0, Math.min(CFG.elevationLevels, ab.hMode === 'abs' ? o[2] : h0 + o[2]));
    }
    // 4 - tag placement
    if (ab.tagId) {
      const d = tagDefById(ab.tagId);
      if (d) for (const off of ab.tagZone) {
        const dt = addK(targetK, rotOff(off, rk)); if (!tilePass(dt)) continue;
        if (d.hp > 0 && (sUnitAt(st, dt) || sBarrier(st, dt))) continue;
        st.tags[dt] = tagInst(d, ab.tagId, dt);
        if (d.collectible && d.hp <= 0) { const u = sUnitAt(st, dt); if (u) sArrive(st, u, depth); }
      }
    }
    flushDeaths(st, depth);
    // 5 - spawns: none in the starter content (spawnId is unused); the hook stays
    //     for when summoning abilities come over from hex-box.
    // 6 - caster dash: as far along the line to the aim point as it can get.
    // This runs LAST on purpose. The shoves in step 2 have already resolved, so a
    // charge aimed at an enemy lands on the enemy's tile when the ram cleared it,
    // and pulls up short of it when it did not.
    if (ab.moveToTarget && caster.uid !== undefined && caster.hp > 0 && caster.pos !== targetK) {
      const land = dashLanding(st, caster, targetK);
      if (land !== caster.pos) {
        sMoveTo(st, caster, land);
        if (!st.sim) {
          floater(land, '⤳', '#5fc7e0');
          blog(caster.name + (land === targetK ? ' moves to the target' : ' charges in as far as it can'));
        }
        sArrive(st, caster, depth);
        flushDeaths(st, depth);
      }
    }
    st.atk = prevAtk; st.csr = prevCsr; st.shieldUsed = prevSU;
  }

  // ----- per-activation terrain tag tick ---------------------------------
  function tagTick(u) {
    const t = sb.tags[u.pos];
    if (!t || t.hp > 0) return;
    const st = liveSt();
    if (t.dmg > 0) sHit(st, u, t.dmg, t.name);
    if (t.heal > 0 && u.hp > 0) { st.atk = t.name; sHeal(st, u, t.heal); st.atk = null; }
    flushDeaths(st);
  }

  // ----- movement (hex-box 12) -------------------------------------------
  // `fromK` lets the player phase measure range from the tile a unit STARTED
  // the round on (free repositioning); enemies always measure from where they are.
  function reach(u, fromK = u.pos) {
    const hard = new Set(), soft = new Set();
    for (const o of sb.units) { if (o.hp <= 0 || o === u) continue; ((!u.flying && o.isEnemy !== u.isEnemy) ? hard : soft).add(o.pos); }
    for (const k in sb.tags) { if (sb.tags[k].hp > 0) (u.flying ? soft : hard).add(k); }
    const spd = effSpeed(u);
    const d = { [fromK]: 0 }, prev = {};
    const pq = [[0, fromK]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]); const [dd, k] = pq.shift();
      if (dd > d[k]) continue;
      for (const dir of DIRS) {
        const nk = addK(k, dir);
        if (!tilePass(nk) || hard.has(nk)) continue;
        const dh = sbH(nk) - sbH(k);
        if (!u.flying && Math.abs(dh) > 1) continue;
        const nd = dd + (u.flying ? 1 : (dh > 0 ? 2 : 1));
        if (nd > spd) continue;
        if (nd < (d[nk] ?? 1e9)) { d[nk] = nd; prev[nk] = k; pq.push([nd, nk]); }
      }
    }
    return { d, prev, occ: soft };
  }
  const canStop = (res, k) => res.d[k] !== undefined && !res.occ.has(k);
  function approachField(u) {
    const hard = new Set();
    if (!u.flying) for (const k in sb.tags) if (sb.tags[k].hp > 0) hard.add(k);
    const d = {}, pq = [];
    for (const p of alive(false)) { d[p.pos] = 0; pq.push([0, p.pos]); }
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]); const [dd, k] = pq.shift();
      if (dd > d[k]) continue;
      for (const dir of DIRS) {
        const nk = addK(k, dir);
        if (!tilePass(nk) || hard.has(nk)) continue;
        const dh = sbH(k) - sbH(nk);
        if (!u.flying && Math.abs(dh) > 1) continue;
        const nd = dd + (u.flying ? 1 : (dh > 0 ? 2 : 1));
        if (nd < (d[nk] ?? 1e9)) { d[nk] = nd; pq.push([nd, nk]); }
      }
    }
    return d;
  }
  function pathTo(res, startK, destK) {
    const p = [destK]; let k = destK;
    while (k !== startK) { k = res.prev[k]; if (!k) return null; p.unshift(k); }
    return p;
  }
  // A collectible flagged "trigger on pass" fires the instant a walking unit enters.
  function passTrap(u, k) {
    if (!u || u.hp <= 0) return true;
    if (u.flying) return false;
    const t = sb.tags[k];
    if (!t || !t.collectible || !t.passPickup || t.hp > 0) return false;
    const st = liveSt(); sArrive(st, u); flushDeaths(st);
    emit();
    return u.hp <= 0 || !!statusWith(u, 'skipsTurn') || u.pos !== k;
  }
  // Hands the walk to the view: it animates and reports each tile entered.
  function animateMove(u, path, done) {
    if (!path || path.length < 2) { if (path && path.length) u.pos = path[path.length - 1]; done && done(); return; }
    sb.busy = true;
    const anim = {
      u, path: u.flying ? [path[0], path[path.length - 1]] : path, fly: u.flying,
      enter: (k) => { u.pos = k; return passTrap(u, k); },   // true = stop the walk here
    };
    if (onAnim) onAnim(anim, () => done && done());
    else { u.pos = path[path.length - 1]; done && done(); }   // headless fallback (tests)
  }

  // ----- aiming ----------------------------------------------------------
  // Is this tile something a dash can STAND on? Terrain only - a unit does not
  // disqualify it, because the whole point of a charging shove is to aim AT the
  // target and ram it out of the way. Whether that works is settled at
  // resolution (dashLanding), by which time the shove has happened.
  const dashTileOk = (k) => { if (!tilePass(k)) return false; const t = sb.tags[k]; return !(t && t.hp > 0); };
  // Can a dash be AIMED here? The destination must be stand-on-able AND the way
  // to it must be CLEAR: a charge is a run across the floor, not a teleport.
  // Everything strictly between the caster and the aim point has to be empty
  // ground; only the aim point itself may be occupied.
  // Without this the ability was offered through a body and then half-happened -
  // the far enemy took the hit and the shove while the caster, blocked by the one
  // in front, never moved (reported 2026-09-11).
  function dashAimOk(c, k) {
    if (!dashTileOk(k)) return false;
    const line = hexLine(c.pos, k);
    for (let i = 1; i < line.length - 1; i++) {
      const mid = line[i];
      if (!dashTileOk(mid)) return false;
      const o = unitAt(mid);
      if (o && o.uid !== c.uid) return false;
    }
    return true;
  }
  // Where a dash actually ENDS, given the board as it stands after the rest of
  // the cast. The caster walks the line towards the aim point and takes the
  // furthest tile it can stand on, stopping in front of the first thing in the
  // way. Its own tile means it never left.
  function dashLanding(st, caster, targetK) {
    const line = hexLine(caster.pos, targetK);
    let last = caster.pos;
    for (let i = 1; i < line.length; i++) {
      const k = line[i];
      if (!tilePass(k)) break;
      const t = st.tags[k];
      if (t && t.hp > 0) break;                       // a solid tag blocks like a wall
      const o = sUnitAt(st, k);
      if (o && o.uid !== caster.uid) break;           // someone is still standing there
      last = k;
    }
    return last;
  }
  // Can this ability be aimed at `t` from `fromK` at all?
  //
  // A ROTATABLE ability cannot be aimed at the caster's OWN tile. Every zone it
  // owns turns to face the aim point, and there is no direction from a tile to
  // itself: aimRot returns 0 for that, so the whole shape would be drawn due
  // EAST, in a direction nobody chose. Both the player's aim map and the enemy
  // AI's search go through here, so neither can pick it.
  //
  // (Found 2026-09-11. clawSwipe casts at ringOffsets(0, 1), which includes
  // [0, 0], so its own tile was a legal anchor. Harmless while its dmgZone was
  // the single aim tile - but once Cleave and Wide Cleave gave it a fan two
  // tiles deep, the alias pass lit up two stray tiles two hexes away, and a cast
  // on self would have swiped eastwards for no reason. An effect meant to
  // surround the caster is written the other way round: rotatable: false with a
  // ring dmgZone.)
  const canAimAt = (ab, fromK, t) => !(ab.rotatable && t === fromK);

  function buildAim(c, ab) {
    const targets = new Set();
    const anchors = new Set();
    const ok = (k) => (!ab.moveToTarget || dashAimOk(c, k)) && canAimAt(ab, c.pos, k);
    if (ab.castAny) for (const t of activeTiles()) { if (!ok(t)) continue; targets.add(t); anchors.add(t); }
    else for (const off of ab.castZone) {
      const t = addK(c.pos, off);
      if (!inMap(t) || !ok(t)) continue;
      anchors.add(t);
      if (tilePass(t)) targets.add(t);
    }
    const map = {};
    for (const t of targets) map[t] = t;
    // The dmgZone ALIASES below let you click any tile a rotatable ability would
    // cover and have it aim at the castZone tile that covers it - you point at the
    // enemy you mean to skewer, not at the empty tile in front of you.
    // A DASH is excluded: for a charge the aim point is also where the caster ends
    // up, so an alias would light up a tile the unit is not going to, which is
    // exactly the confusion this pass is fixing.
    if (ab.rotatable && !ab.moveToTarget) {
      for (const t of anchors) {
        const rk = abRotFor(ab, c.pos, t);
        for (const off of ab.dmgZone) {
          const dt = addK(t, rotOff(off, rk));
          if (!tilePass(dt) || targets.has(dt)) continue;
          const cur = map[dt];
          if (cur === undefined) map[dt] = t;
          else if (hexDist(dt, t) < hexDist(dt, cur)) map[dt] = t;
        }
      }
    }
    return map;
  }

  // WHAT A CAST WOULD TOUCH, for the tile under the cursor. `sb.aimMap` says
  // where an ability MAY be aimed; this says what happens if it is aimed there,
  // so the player can see the extent of a blast before committing to it.
  //
  // Two halves, for two kinds of question:
  //  * WHERE the zones fall (hit / tag / height) is read straight off the
  //    ability, with the same anchor, rotation and tilePass filter resolveCast
  //    uses. Exact by construction.
  //  * WHAT MOVES (shoves, and where a charge ends up) cannot be read off a zone
  //    at all: shoves resolve in waves against everything else the same cast
  //    moves, and a charge only reaches the target's tile if the ram cleared it.
  //    So the cast is played out on a COPY of the board - the same machinery the
  //    enemy AI uses to judge its own moves - and the result read back. Nothing
  //    here touches the real board.
  function aimPreview(k) {
    if (!sb.selAb || !sb.aimMap || sb.aimMap[k] === undefined) return null;
    const c = curP(); if (!c) return null;
    const ab = abFor(c, sb.selAb); if (!ab) return null;
    const anchor = sb.aimMap[k];
    const rk = abRotFor(ab, c.pos, anchor);
    const zone = (offs) => {
      const out = [];
      for (const off of offs) {
        const dt = addK(anchor, rotOff([off[0], off[1]], rk));
        if (tilePass(dt) && !out.includes(dt)) out.push(dt);
      }
      return out;
    };
    const height = [];
    for (const o of ab.hZone) {
      const dt = addK(anchor, rotOff([o[0], o[1]], rk));
      if (!tilePass(dt)) continue;
      const h0 = sb.heights[dt] ?? 0;
      const to = Math.max(0, Math.min(CFG.elevationLevels, ab.hMode === 'abs' ? o[2] : h0 + o[2]));
      height.push({ k: dt, from: h0, to });
    }
    // Play it out on a copy. `blind: null` - the preview is for the PLAYER, who
    // sees the whole board, not for a creature with an intellect class.
    const st = simSt(null);
    const se = st.units.find((u) => u.uid === c.uid);
    let push = [];
    let dash = null;
    if (se) {
      const before = new Map(st.units.map((u) => [u.uid, u.pos]));
      resolveCast(st, se, ab, anchor);
      for (const u of st.units) {
        if (u.uid === c.uid) continue;
        const from = before.get(u.uid);
        if (from !== undefined && u.pos !== from) push.push({ uid: u.uid, from, to: u.pos });
      }
      if (se.pos !== c.pos) dash = se.pos;
    }
    // What the hit tiles MEAN, so the view can colour them by consequence rather
    // than by which ability happens to be selected.
    const kind = ab.damage > 0 ? 'damage' : ab.heal > 0 ? 'heal' : ab.buff ? 'buff' : 'none';
    return {
      anchor, kind,
      hit: zone(ab.dmgZone),
      tag: ab.tagId && tagDefById(ab.tagId) ? zone(ab.tagZone) : [],
      push, height, dash,
      // True when the charge stops short of what it was aimed at, because the
      // ram did not clear the tile. Worth saying out loud in a hint.
      dashShort: !!(dash && dash !== anchor),
    };
  }

  // ----- turn flow (hex-box 11, reworked player phase) ---------------------
  // The player phase is ONE simultaneous turn: any unit can be selected and
  // repositioned FREELY within its range (always measured from the tile it
  // started the round on, so a move can be taken back) until an ability is
  // cast. A cast commits the turn so far: the caster is finished, and every
  // unit standing away from its starting tile is locked in place. The phase
  // ends when every living unit has cast - or on End turn, which ends it for
  // the whole party at once.
  function startPlayerPhase() {
    blog('- ROUND ' + sb.round + ' -');
    sb.phase = 'player'; sb.selAb = null; sb.aimMap = null; sb.activeUid = null;
    sb.inspectUid = null; sb.inspectReach = null;   // a new round, a fresh board
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) {
      u.done = false; u.moveLocked = false; u.startPos = u.pos; u.tagTicked = false;
    }
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) { u.tagTicked = true; tickStatuses(u); tagTick(u); }
    if (checkEnd()) return;
    // Anything that makes a unit skip its turn spends itself doing exactly that.
    for (const u of sb.units) {
      if (u.isEnemy || u.hp <= 0) continue;
      const id = statusWith(u, 'skipsTurn');
      if (!id) continue;
      const view = statusView(u, id);
      spendStatus(liveSt(), u, 'activation', id);
      u.done = true;
      floater(u.pos, view.icon, view.color);
    }
    const first = sb.units.find((u) => !u.isEnemy && u.hp > 0 && !u.done);
    if (first) select(first); else { emit(); startEnemyPhase(); }
  }
  function refreshReach() {
    const c = curP();
    sb.reach = (c && !c.done && !c.moveLocked) ? reach(c, c.startPos) : null;
  }
  function select(u) {
    if (sb.over) return;
    sb.activeUid = u.uid; sb.selAb = null; sb.aimMap = null;
    refreshReach();
    emit();
  }

  // ----- inspecting an enemy ---------------------------------------------
  // Shows where a creature could walk. It is a readout only: no rule reads
  // inspectUid, and the party's own selection is left exactly as it was.
  function inspect(uid) {
    const e = sb.units.find((u) => u.uid === uid && u.isEnemy && u.hp > 0);
    if (!e) return;
    sb.inspectUid = e.uid;
    sb.inspectReach = reach(e, e.pos);
    emit();
  }
  function clearInspect() {
    if (sb.inspectUid == null) return false;
    sb.inspectUid = null; sb.inspectReach = null;
    return true;
  }

  // The universal cancel (right click on the arena), one step at a time:
  //   aiming an ability  -> put the ability down
  //   inspecting an enemy -> stop inspecting
  //   a unit selected     -> deselect it, leaving nothing selected
  // Returns true when it actually cancelled something.
  function cancel() {
    if (sb.over || sb.busy || sb.phase !== 'player') return false;
    if (sb.selAb) { sb.selAb = null; sb.aimMap = null; emit(); return true; }
    if (clearInspect()) { emit(); return true; }
    if (sb.activeUid != null) {
      sb.activeUid = null; sb.reach = null;
      emit();
      return true;
    }
    return false;
  }
  // Runs after a unit's cast resolves: lock strayed units, finish the caster,
  // hand selection over - or end the phase if everyone has now acted.
  function afterCast(c) {
    c.done = true;
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0 && u.pos !== u.startPos) u.moveLocked = true;
    sb.selAb = null; sb.aimMap = null; sb.reach = null;
    sb.inspectUid = null; sb.inspectReach = null;   // the board moved; the readout is stale
    if (sb.over) return;
    const next = sb.units.find((x) => !x.isEnemy && x.hp > 0 && !x.done);
    if (next) select(next);
    else { sb.activeUid = null; emit(); startEnemyPhase(); }
  }
  // A unit that can no longer act (killed or stunned by a trap mid-walk).
  function retireUnit(u) {
    const skipId = statusWith(u, 'skipsTurn');
    if (skipId) dropStatus(liveSt(), u, skipId, false);
    u.done = true;
    if (sb.over) return;
    const next = sb.units.find((x) => !x.isEnemy && x.hp > 0 && !x.done);
    if (next) select(next);
    else { sb.activeUid = null; emit(); startEnemyPhase(); }
  }
  function startEnemyPhase() {
    sb.phase = 'enemy'; sb.activeUid = null; sb.selAb = null; sb.aimMap = null; sb.reach = null;
    sb.inspectUid = null; sb.inspectReach = null;
    sb.enemyQ = sb.units.filter((u) => u.isEnemy && u.hp > 0).sort((a, b) => b.init - a.init || a.idx - b.idx);
    sb.eqi = -1; emit();
    stepEnemy();
  }
  function stepEnemy() {
    if (sb.over) return;
    sb.eqi++;
    if (sb.eqi >= sb.enemyQ.length) { endRound(); return; }
    const e = sb.enemyQ[sb.eqi];
    if (e.hp <= 0) { stepEnemy(); return; }
    sb.activeUid = e.uid; emit();
    // Statuses bite and count down at the start of the activation, whether or not
    // the unit gets to act; then anything that skips the turn spends itself.
    tickStatuses(e);
    if (checkEnd()) return;
    if (e.hp <= 0) { emit(); wait(stepEnemy, 500); return; }
    const skipId = statusWith(e, 'skipsTurn');
    if (skipId) {
      const view = statusView(e, skipId);
      spendStatus(liveSt(), e, 'activation', skipId);
      floater(e.pos, view.icon, view.color);
      sb.busy = true; wait(() => { sb.busy = false; stepEnemy(); }, 650); return;
    }
    tagTick(e);
    if (checkEnd()) return;
    if (e.hp <= 0) { emit(); wait(stepEnemy, 500); return; }
    sb.busy = true; wait(() => aiTurn(e), 550);
  }
  function endRound() {
    sb.activeUid = null;
    // A fatigue ambush is an extra opening enemy phase: the round itself has not
    // happened yet, so no tag ticking, no expiry, no round counter.
    if (sb.ambush) { sb.ambush = false; startPlayerPhase(); return; }
    const due = [];
    for (const k of Object.keys(sb.tags)) {
      const t = sb.tags[k];
      if (!t.onPeriodic || !(t.everyX > 0)) continue;
      t.everyCd = (t.everyCd > 0 ? t.everyCd : t.everyX) - 1;
      if (t.everyCd <= 0) { t.everyCd = t.everyX; due.push({ k, tid: t.tid }); }
    }
    for (const d of due) {
      const t = sb.tags[d.k];
      if (!t || t.tid !== d.tid) continue;
      const ab = abById(t.onPeriodic);
      if (!ab) continue;
      floater(d.k, '⟳ ' + t.name, t.color);
      resolveCast(liveSt(), { pos: d.k, name: t.name }, ab, d.k, 0);
      flushDeaths(liveSt());
    }
    if (checkEnd()) return;
    const expired = [];
    for (const k of Object.keys(sb.tags)) { const t = sb.tags[k]; if (t.life > 0) { t.life--; if (t.life <= 0) expired.push(k); } }
    for (const k of expired) {
      const t = sb.tags[k]; if (!t) continue;
      delete sb.tags[k];
      floater(k, t.name + ' fades', '#7c8aa5');
      if (t.onExpire) { const ab = abById(t.onExpire); if (ab) resolveCast(liveSt(), { pos: k, name: t.name }, ab, k, 0); }
    }
    if (checkEnd()) return;
    sb.round++;
    startPlayerPhase();
  }
  function checkEnd() {
    if (sb.over) return true;
    if (!alive(true).length) { gameOver(true); return true; }
    if (!alive(false).length) { gameOver(false); return true; }
    return false;
  }
  function gameOver(won) {
    sb.over = won ? 'win' : 'lose';
    sb.selAb = null; sb.aimMap = null; sb.reach = null; sb.activeUid = null;
    emit();
    if (onEnd) onEnd(won);
  }

  // ----- the retreat rule (CFG.flee) --------------------------------------
  // True while the enemy side is beaten badly enough, late enough in the fight,
  // for its survivors to start breaking. Both numbers are config (abilities.js).
  function fleeAllowed() {
    // The Stasis never breaks: a Seed or Colony fight is to the last body, whatever
    // is left of it. main.js sets this from the encounter (game.js ctx.stasis).
    if (noFlee) return false;
    const f = CFG.flee;
    if (!f || !(f.hpFraction > 0) || !(sb.enemyHp0 > 0)) return false;
    if (sb.round <= (f.afterRound ?? 7)) return false;
    const left = alive(true).reduce((a, u) => a + u.hp, 0);
    return left < sb.enemyHp0 * f.hpFraction;
  }
  // One roll, once, per enemy: 100 / (enemies still standing) percent. With four
  // left that is a quarter each per turn; with one left it is a certainty. An
  // enemy that has already broken never reconsiders - it just keeps running.
  function rollFlee(e) {
    if (e.fleeing) return true;
    if (!fleeAllowed()) return false;
    const n = alive(true).length;
    if (n <= 0) return false;
    if (rng() * 100 >= 100 / n) return false;
    e.fleeing = true;
    floater(e.pos, 'FLEEING', '#ffd166');
    blog(e.name + ' breaks and runs');
    return true;
  }
  // A broken enemy spends its turn walking for the nearest edge - the highest ring
  // it can stop on - and is off the board the moment it stands on the rim. It does
  // not fight on the way and is still a perfectly ordinary target while it runs.
  function fleeTurn(e) {
    const res = reach(e);
    let bestK = e.pos, bestRing = ringOf(e.pos), bestCost = 0;
    for (const k of Object.keys(res.d)) {
      if (k !== e.pos && !canStop(res, k)) continue;
      const ring = ringOf(k);
      if (ring > bestRing || (ring === bestRing && res.d[k] < bestCost)) { bestK = k; bestRing = ring; bestCost = res.d[k]; }
    }
    const path = pathTo(res, e.pos, bestK) || [e.pos];
    animateMove(e, path, () => {
      sArrive(liveSt(), e); flushDeaths(liveSt());
      emit();
      wait(() => {
        if (sb.over) { sb.busy = false; return; }
        if (e.hp > 0 && ringOf(e.pos) >= R) { escapeUnit(e); return; }
        sb.busy = false;
        if (!checkEnd()) stepEnemy();
      }, 300);
    });
  }
  // It made it out. The view plays the same pop a consumed world-map encounter
  // gets, and then the unit is simply off the board: hp 0 so alive() and unitAt()
  // stop seeing it, `fled` so nothing mistakes it for a corpse. noteDeath is NOT
  // called - no death is reported, and (LOOT) nothing should ever drop here.
  function escapeUnit(e) {
    floater(e.pos, 'ESCAPED', '#ffd166');
    blog(e.name + ' escapes the field');
    const finish = () => {
      e.fled = true;
      e.hp = 0;
      emit();
      sb.busy = false;
      if (!checkEnd()) stepEnemy();
    };
    if (onUnitFlee) onUnitFlee(e.uid, finish);
    else finish();
  }

  // ----- enemy AI (scores full simulated outcomes) ------------------------
  function aiTurn(e) {
    if (sb.over || e.hp <= 0) { sb.busy = false; if (!sb.over) stepEnemy(); return; }
    // Breaking off comes before any thought of attacking.
    if (rollFlee(e)) { fleeTurn(e); return; }
    const res = reach(e);
    const mind = mindOf(e);              // what this creature is able to weigh
    const blind = blindfold(mind);
    const live = new Map(sb.units.map((u) => [u.uid, u]));
    const flat = CFG.blindStatusValue ?? 8;
    // What standing on this tile is worth, in DAMAGE units (the callers scale it).
    // Only a mind that weighs tags ever asks.
    // A tag hurts - or helps - in two ways, and until 2026-09-10 only the first
    // was counted: the tick it does while you stand on it (`dmg` / `heal`), and
    // whatever its four hooks CAST on whoever is there. A hook names an ordinary
    // ability, so it can carry a status; a venom pool that only poisons scored a
    // flat zero and every mind walked straight into it.
    // A status's aiValue is in the AI's own units, where a point of damage is 10,
    // so it is divided back into damage units to sit beside the tick.
    const tagHarm = (k) => {
      const t = sb.tags[k];
      if (!t || t.hp > 0) return 0;
      let n = (t.dmg || 0) - (t.heal || 0);
      for (const hook of ['onPeriodic', 'onPickup', 'onExpire', 'onDestroy']) {
        const ab = t[hook] ? abById(t[hook]) : null;
        if (!ab) continue;
        n += (ab.damage || 0) - (ab.heal || 0);
        // Positive aiValue = bad to carry = one more reason to keep off this tile,
        // which is the same sign the tick damage already has. A boon tile comes out
        // negative and the minds that can read tiles will step onto it.
        if (ab.buff) n += statusValue(ab.buff) / 10;
      }
      return n;
    };
    let best = null;
    for (const abId of e.abilityIds) {
      const ab = abFor(e, abId); if (!ab) continue;
      // What counts as an ability worth thinking about. `ab.buff` is on this list
      // since 2026-09-05: without it a pure status ability (Guard, or anything a
      // designer invents in the status table) was thrown away before it was ever
      // scored, so enemies carrying Guard never once used it.
      if (!(ab.damage > 0 || ab.heal > 0 || ab.buff || ab.pushZone.length || ab.tagId || ab.hZone.length)) continue;
      for (const startK of Object.keys(res.d)) {
        if (startK !== e.pos && !canStop(res, startK)) continue;
        if (ab.castAny && startK !== e.pos) continue;
        const tlist = ab.castAny ? activeTiles() : ab.castZone.map((off) => addK(startK, off));
        for (const t of tlist) {
          if (!inMap(t)) continue;
          if (!canAimAt(ab, startK, t)) continue;   // same rule the player's aim map uses
          if (ab.moveToTarget && t !== startK && !dashAimOk({ pos: startK, uid: e.uid }, t)) continue;
          const st = simSt(blind);
          const se = st.units.find((u) => u.uid === e.uid);
          se.pos = startK;
          resolveCast(st, se, ab, t);
          // (The tile the caster CHOOSES TO STAND on is weighed too, but not here:
          // the loop below walks every unit, the caster among them, and an enemy
          // standing on harmful ground has that ground subtracted from the score
          // like any other. Adding it here as well double-counted it.)
          let score = 0;
          for (const u of st.units) {
            const d = st.rec.dmg[u.uid] || 0;
            const was = live.get(u.uid);
            // ----- statuses -------------------------------------------------
            // A mind that READS statuses uses the table's own aiValue and weighs
            // the target: a blessing is worth most on the ally that is about to
            // need it, a curse is wasted on someone already carrying it or already
            // nearly dead. A mind that cannot read them still knows friend from
            // foe - it applies them at a flat worth, to whoever it can reach.
            // `sv` ends up POSITIVE when the cast made this unit worse off. The
            // score below then adds it for a party unit and subtracts it for an ally,
            // so one number covers curses, blessings, friend and foe.
            let sv = 0;
            for (const [id, amt] of Object.entries(st.rec.applied[u.uid] || {})) {
              const v = statusValue(id);          // <0 = a good thing to carry
              if (!mind.statuses) { sv += (v < 0 ? -1 : 1) * flat; continue; }
              const already = was && was.status && was.status[id] ? 0.15 : 1;
              sv += v * already * statusNeed(u, was, v);
            }
            // A blow that only pops a shield is still a blow worth landing, whether
            // or not the creature understands what it broke. Without this, anything
            // dimmer than S would refuse to attack a shielded unit at all - the very
            // deadlock this AI was fixed for.
            for (const [id, amt] of Object.entries(st.rec.stripped[u.uid] || {})) {
              const v = statusValue(id);
              sv += mind.statuses ? -v : (v < 0 ? 1 : -1) * flat;
            }
            // ----- injuries: finishing the wounded rather than spreading damage --
            const killBonus = mind.injuries ? (u.isEnemy ? 40 : 45) : 0;
            const focus = mind.injuries && was && was.maxHp
              ? d * 5 * Math.max(0, 1 - Math.max(0, was.hp) / was.maxHp) : 0;
            // ----- tile tags: a fire is a place to shove someone into, and a place
            // not to stand. One rule covers both ends of it.
            const harm = mind.tags ? tagHarm(u.pos) * 8 : 0;
            if (!u.isEnemy) score += d * 10 + (st.rec.killed[u.uid] ? killBonus : 0) + sv + focus + harm;
            else score -= d * 9 + (st.rec.killed[u.uid] ? killBonus : 0) + sv + harm;
          }
          if (score > 0 && (!best || score > best.score || (score === best.score && res.d[startK] < best.cost)))
            best = { ab, startK, t, score, cost: res.d[startK] };
        }
      }
    }
    if (best) {
      const path = pathTo(res, e.pos, best.startK) || [e.pos];
      animateMove(e, path, () => {
        sArrive(liveSt(), e); flushDeaths(liveSt());
        emit();
        wait(() => {
          if (sb.over) { sb.busy = false; return; }
          // A trap on the way may have killed it, stopped it short or stunned it.
          const hitId = statusWith(e, 'skipsTurn');
          if (e.hp <= 0 || hitId || e.pos !== best.startK) {
            if (e.hp > 0 && hitId) { const v = statusView(e, hitId); floater(e.pos, v.icon, v.color); }
            emit();
            wait(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 450);
            return;
          }
          resolveCast(liveSt(), e, best.ab, best.t);
          emit();
          wait(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 550);
        }, 300);
      });
      return;
    }
    const players = alive(false);
    if (players.length) {
      const fld = approachField(e);
      let bestK = e.pos, bs = 1e9;
      for (const k of Object.keys(res.d)) {
        if (k !== e.pos && !canStop(res, k)) continue;
        const td = fld[k] !== undefined ? fld[k] : 1000 + Math.min(...players.map((p) => hexDist(k, p.pos)));
        // Nothing worth casting, so it walks. Closing the distance comes first for
        // every creature; what it does with the tiles that are equally close is
        // where the mind shows. One that weighs HEIGHT takes the higher of them, so
        // it arrives with the high ground already won; one that weighs TAGS will not
        // stop in a fire to save a step. A dim one takes the first tile it finds.
        // Fire is counted as EXTRA DISTANCE - a tile that burns for 2 is worth
        // walking two tiles further to avoid - while height only breaks ties
        // between tiles that are equally close, so nobody climbs away from the fight.
        const burn = mind.tags ? tagHarm(k) : 0;
        const climb = mind.elevation ? -sbH(k) : 0;
        const sc = (td + burn) * 100 + climb * 10 + res.d[k];
        if (sc < bs) { bs = sc; bestK = k; }
      }
      const path = pathTo(res, e.pos, bestK) || [e.pos];
      animateMove(e, path, () => {
        sArrive(liveSt(), e); flushDeaths(liveSt());
        emit();
        wait(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 400);
      });
      return;
    }
    wait(() => { sb.busy = false; stepEnemy(); }, 400);
  }

  // ----- player input (called by the view / the HUD) -----------------------
  function clickTile(k) {
    if (sb.over || sb.busy) return;
    if (sb.phase !== 'player') return;
    if (!inMap(k)) return;
    const uu = unitAt(k);
    const c = curP();
    // Nothing selected (the player cancelled their way out): a click picks a
    // unit back up, or inspects an enemy.
    if (!c) {
      if (uu && !uu.isEnemy && !uu.done) { clearInspect(); select(uu); }
      else if (uu && uu.isEnemy) inspect(uu.uid);
      return;
    }
    // An enemy is a readout, never a move target - unless an ability is aimed
    // at it, which the aim map below handles.
    if (!sb.selAb && uu && uu.isEnemy) { inspect(uu.uid); return; }
    if (!sb.selAb && uu && !uu.isEnemy && uu.uid !== c.uid && !uu.done) { clearInspect(); select(uu); return; }
    if (sb.selAb) {
      const ab = abFor(c, sb.selAb);
      const target = ab && sb.aimMap ? sb.aimMap[k] : null;
      if (target != null) {
        sb.busy = true;
        sb.selAb = null; sb.aimMap = null;
        resolveCast(liveSt(), c, ab, target);
        emit();
        wait(() => {
          sb.busy = false;
          if (checkEnd()) return;
          afterCast(c);   // casting finishes the unit and locks strayed positions
        }, 480);
      } else { sb.selAb = null; sb.aimMap = null; emit(); }
      return;
    }
    // Free repositioning: range is measured from the round's starting tile, so
    // clicking again simply picks a different spot (the old move is taken back).
    if (!c.done && !c.moveLocked) {
      const res = sb.reach ?? reach(c, c.startPos);
      if (k !== c.pos && canStop(res, k)) {
        const path = pathTo(res, c.startPos, k);
        if (!path) return;
        sb.reach = null;
        animateMove(c, path, () => {
          sb.busy = false;
          sArrive(liveSt(), c); flushDeaths(liveSt());
          if (checkEnd()) return;
          if (c.hp <= 0 || statusWith(c, 'skipsTurn')) { retireUnit(c); return; }
          refreshReach();
          emit();
        });
        emit();
      }
    }
  }
  function selectAbility(abId) {
    if (sb.over || sb.busy || sb.phase !== 'player') return;
    const c = curP(); if (!c) return;
    if (sb.selAb === abId) { sb.selAb = null; sb.aimMap = null; }
    else {
      const ab = abFor(c, abId);
      if (!ab || !c.abilityIds.includes(abId)) return;
      sb.selAb = abId; sb.aimMap = buildAim(c, ab);
    }
    emit();
  }
  // Ends the WHOLE party's turn at once.
  function endTurn() {
    if (sb.phase !== 'player' || sb.busy || sb.over) return;
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) u.done = true;
    sb.activeUid = null; sb.selAb = null; sb.aimMap = null; sb.reach = null;
    emit();
    startEnemyPhase();
  }

  // Test / debug helper: decide the battle instantly.
  function debugResolve(won) {
    if (sb.over) return;
    const live = liveSt();
    for (const u of sb.units) if (u.isEnemy === !!won && u.hp > 0) { noteDeath(live, u, u.pos, 'debug'); u.hp = 0; }
    checkEnd();
  }

  // ----- go ---------------------------------------------------------------
  {
    // Units standing on collectibles grab them at battle start (hex-box parity).
    const st = liveSt();
    for (const u of sb.units) if (u.hp > 0) sArrive(st, u);
    flushDeaths(st);
  }
  // The fight is BUILT above and OPENED here. The two are separable because the
  // caller may want to build it behind a transition (so the HUD is already the
  // battle's when the clouds part) but not let a fatigue ambush swing at the
  // party while the screen is still covered: `deferOpening` holds the opening
  // enemy phase back until start() is called. A normal fight opens with
  // startPlayerPhase(), which animates nothing, so it never needs deferring.
  let opened = false;
  function start() {
    if (opened) return;
    opened = true;
    if (sb.ambush) { blog('AMBUSH - the enemy strikes first'); startEnemyPhase(); }
    else startPlayerPhase();
  }
  if (deferOpening && sb.ambush) emit();   // the bar reads "enemy phase" while it waits
  else start();

  return {
    state: sb,
    start,
    clickTile, selectAbility, endTurn, inspect, cancel, activate: (uid) => { const u = sb.units.find((x) => x.uid === uid && !x.isEnemy && x.hp > 0 && !x.done); if (u && sb.phase === 'player' && !sb.busy) select(u); },
    abilityById: abById,
    aimPreview,
    abilityFor: abFor,   // (unit, id) - the unit's UPGRADED def where it has one
    curPlayer: curP,
    reachFor: () => sb.reach,
    debugResolve,
  };
}
