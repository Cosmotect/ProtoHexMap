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
//  tag ticks, pushes with collisions, falls, crush chains and void edges,
//  height changes, tag placement with on-destroy / on-expire / periodic casts,
//  high/low ground damage modifiers, and the outcome-scoring enemy AI.
//  SINCE 2026-10-05 an ability is a LIST OF EFFECTS in the vocabulary of
//  local/battle/rules.js (quantities over facts, conditions, triggers), run by
//  one executor per kind (runEffect) in a fixed phase order (resolveCast);
//  statuses are "<Name> X for Y turns" instances (src/config/statuses.js);
//  units have STACKS; Taunt / Fear / Charm / Confused steer the AI; an ability
//  may take several AIMS; a killing blow may earn an extra attack.
//  Added for Everlands: every ability carries its own flat `damage` (no more
//  ENEMY-only power bonus - removed 2026-09-10, a bestiary row's abilities are
//  its whole strength now); PARTY units instead fight with their UPGRADED
//  ability defs (def.abilityDefs, resolved by src/upgrades.js from the unit's
//  unlocked tree nodes); partyDamageMod is a flat penalty to the party's
//  ability damage (the Stasis "damage" debuff); and a fatigue-forced fight
//  still opens with the party's own phase, same as any other fight (sb.ambush
//  only labels round 1 "Ambush!" in the battle bar - since 2026-09-22 it no
//  longer buys the enemy an extra opening phase before the player can act).
//  AIM LOCKS (since 2026-09-15, grown out of the Hack experiment): with
//  config.combat.lockedAim the party does not cast one by one - picking an
//  ability and clicking a target LOCKS the unit's aim (u.lock), and End turn
//  fires the locks. Since 2026-09-22 the volley is SEQUENCED: the locks fire
//  one after another with combat.volleyStepMs between them, in sb.fireOrder -
//  the order of the party panel's cards, which the player can drag around -
//  so an earlier shove sets up a later blow; and a damaging ability gets
//  +combat.stack.bonusPerOverlap base damage on a hex per EARLIER ability of
//  the volley that hit it (the x2 / x3 multipliers of 09-15 are gone). The
//  player sees the whole planned turn before committing it: previewState()
//  is the board as the selected unit will find it (after the casts before it
//  in the order) and as the volley leaves it, for the arena's overhead cards;
//  previewMoves() lists everything that ends up somewhere else, for the ghost
//  previews; previewTotals() is the per-tile arithmetic (tests, rules). All
//  three read one play-out of the locks (plus the aim under the cursor) on a
//  copy of the board in that same order. A `rules` object
//  (optional) lets an encounter type plug its own end condition and tile
//  hooks in without the engine knowing about it (the Hack does), and
//  `entities` (optional) puts an encounter's own OBJECTS on the board -
//  Entity subclasses (local/battle/entity.js, since 2026-09-24) the engine
//  handles through their hooks alone: they block tiles, take blows, may be
//  shoved, die, and get used, each its own way (the Hack's nodes and mines).
//  Every unit is a Unit, the Entity with agency.
// =====================================================================
import { DIRS, K, PK, addK, hexDist, hexLine, rotOff, aimRot, abRotFor, rotDir, boardTiles } from './bhex.js';
import { abilityById } from '../../config/abilities.js';
import { tagDefById } from '../../config/entities.js';
import { qty, cond, zoneMaxRange } from './rules.js';
import { Entity, Unit, HackNode, HackMine } from './entity.js';

export function createBattle({ config, radius, heights, party, enemies, partyKeys, enemyKeys, forced,
                               partyDamageMod = 0, deferOpening = false, voidEdgeKeys = [],
                               wallKeys = [], etherKeys = [], startTags = [],
                               rng = Math.random, noFlee = false, instant = false,
                               entities = [],
                               supplies = null, rules = null, tags = null,
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
    // The board's ENTITIES (local/battle/entity.js): `units` are the Units -
    // the party and the enemies, what the player and the AI control - and
    // `objects` everything else an encounter puts on the board (the Hack's
    // nodes and mines), handled through the Entity hooks alone.
    units: [], objects: [], uidc: 0, tags: {}, heights: { ...heights },
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
    // Aim locks are on (config.combat.lockedAim) - the HUD reads it for its hints.
    lockedAim: !!CFG.lockedAim,
    // The order the party's locks FIRE in (party uids, first fires first). The
    // party panel's cards can be dragged into a new order (setFireOrder).
    fireOrder: [],
    // An encounter's RULES keep their own state here (the Hack's progress bar).
    ext: {},
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
    if (!st || st.sim || !u || !u.isUnit || deathReported.has(u.uid)) return;
    deathReported.add(u.uid);
    const spot = {
      uid: u.uid, name: u.name, icon: u.icon ?? null,
      isEnemy: !!u.isEnemy, partyIndex: u.partyIndex ?? null,
      key: tileK ?? u.pos, cause: cause ?? 'damage', round: sb.round,
    };
    sb.deaths.push(spot);
    if (onUnitDeath) onUnitDeath(spot);
  }

  // The units: Unit instances (local/battle/entity.js) built from the defs.
  const makeInstance = (def, isEnemy, pos, idx) => new Unit(def, { isEnemy, pos, idx });
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
      pushable: d.pushable, collectible: d.collectible, passPickup: d.passPickup, roots: !!d.roots,
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
  // Pre-built tag INSTANCES from the caller (an encounter's own kinds of tag,
  // outside COMBAT_TAGS - the Hack's nodes and mines), keyed by tile.
  if (tags) for (const [k, inst] of Object.entries(tags)) if (tilePass(k) && !sb.tags[k]) sb.tags[k] = inst;
  // The encounter's OBJECTS: pre-built Entity instances (never Units - those
  // come in as party / enemies), each on its own free tile.
  for (const e of entities ?? []) {
    if (!(e instanceof Entity) || e.isUnit || !e.pos || !tilePass(e.pos)) continue;
    if (sb.units.some((u) => u.pos === e.pos) || sb.objects.some((o) => o.pos === e.pos)) continue;
    sb.objects.push(e);
  }
  // An encounter's rules get the state before anything happens on it.
  if (rules && rules.attach) rules.attach(sb);

  // ----- small queries --------------------------------------------------
  const sbH = (k) => sb.heights[k] ?? 0;
  const alive = (f) => sb.units.filter((u) => u.hp > 0 && (f === undefined || u.isEnemy === f));   // fled units carry hp 0, so they drop out here too
  const unitAt = (k) => sb.units.find((u) => u.hp > 0 && u.pos === k);
  // A DOWNED unit's body on this tile (entity.js Unit.downed): not a unit that
  // acts or can be hit, but an obstacle all the same.
  const bodyAt = (k) => sb.units.find((u) => u.downed && u.pos === k);
  const objectAt = (k) => sb.objects.find((o) => o.alive && o.pos === k);
  const curP = () => sb.units.find((u) => u.uid === sb.activeUid && !u.isEnemy && u.hp > 0);
  const speedFloor = (u) => Math.min(u.speed, CFG.minSpeed);
  const effSpeed = (u) => Math.max(speedFloor(u), u.speed + statusSum(u, 'speed'), 0);
  // How far this unit may walk this round: its speed, less whatever ability
  // costs have already eaten. The walk itself is NOT taken off here - a walk is
  // re-measured from startPos every time and can be taken back (see clickTile).
  const moveBudget = (u) => Math.max(0, effSpeed(u) - (u.movePaid || 0));
  // What the walk so far HAS cost: the path price from the tile the unit started
  // its activation on to where it stands now. Measured with no budget cap, so a
  // unit that walked its whole speed and then paid a move cost still reads right.
  // (Until 2026-09-12 a move cost only looked at moveBudget, which ignores the
  // walk - so a unit that had walked every point it had could still cast a
  // move-cost ability. That was the bug.)
  const walked = (u) => {
    if (!u || !u.startPos || u.pos === u.startPos) return 0;
    const d = reach(u, u.startPos, Infinity).d[u.pos];
    return d === undefined ? effSpeed(u) : d;
  };
  // Movement points actually left right now: the budget, less the walk.
  const moveLeft = (u) => Math.max(0, moveBudget(u) - walked(u));

  // ----- what an ability costs to cast ------------------------------------
  // `ab.cost` is { hp, supplies, move }, each a QUANTITY (rules.js) read
  // against the caster's own facts - "+1 hp per use this battle" is a cost
  // term, not a rule. Any of them may be NEGATIVE: a negative cost GRANTS the
  // resource instead of taking it, and is never a reason to block a cast.
  const costOf = (u, ab) => {
    const ctx = castCtx(liveSt(), u, ab, null);
    return { hp: qty(ab?.cost?.hp, ctx) || 0, supplies: qty(ab?.cost?.supplies, ctx) || 0, move: qty(ab?.cost?.move, ctx) || 0 };
  };

  // Can `u` pay for `ab` right now? Returns '' when it can, or the id of the
  // resource that is short - which is what the HUD shows on the greyed button.
  function shortOf(u, ab) {
    const c = costOf(u, ab);
    // A DISARMED unit can pay for nothing: every ability greys out, and the enemy
    // AI (which asks the same question) walks instead of casting. A status that
    // FORBIDS a kind of ability (Grounded Aim: 'ranged') greys those out.
    if (agencyLost(u, 'disarmed')) return 'disarmed';
    if ((ab?.tags ?? []).some((tg) => statusListed(u, 'forbids', tg))) return 'forbidden';
    // hp can never be spent down to death: strictly MORE than the cost is
    // needed, so the ability greys out at exactly the cost.
    if (c.hp > 0 && u.hp <= c.hp) return 'hp';
    if (c.move > 0 && moveLeft(u) < c.move) return 'move';
    // Supplies are the RUN's, and only the party has them. An enemy written
    // with a supply cost casts it for free rather than standing mute.
    if (c.supplies > 0 && !u.isEnemy) {
      if (!supplies || supplies.get() < c.supplies) return 'supplies';
    }
    return '';
  }
  const canAfford = (u, ab) => !shortOf(u, ab);

  // Pays the cost. Called ONCE, at the moment a cast is committed - never from
  // resolveCast, which the enemy AI replays on a copy of the board to score its
  // options and would otherwise spend the resource dozens of times per turn.
  function payCost(u, ab) {
    const c = costOf(u, ab);
    if (c.hp) {
      // A negative hp cost heals, and healing stops at maxHp - "if there is room".
      const before = u.hp;
      u.hp = Math.max(0, Math.min(maxHpOf(u), u.hp - c.hp));
      const delta = u.hp - before;
      if (delta) floater(u.pos, delta > 0 ? `+${delta}` : String(delta), delta > 0 ? '#8fd47a' : '#ff6b6b');
    }
    if (c.move) {
      // Spending caps at the whole budget; granting caps at the round's speed,
      // so a refund can never carry a unit past what it could walk anyway.
      u.movePaid = Math.max(0, Math.min(effSpeed(u), (u.movePaid || 0) + c.move));
    }
    // addSupplies clamps to [0, maxSupplies], so a negative cost grants only
    // what the packs have room for.
    if (c.supplies && !u.isEnemy && supplies) supplies.add(-c.supplies);
  }
  // A cast is COMMITTED: counted for the `castsThisBattle` fact (read by the
  // next cast's numbers, never by this one's). Called at the three places a
  // cast really happens, after it resolved - never from resolveCast, which the
  // AI replays on copies.
  function commitCast(u, ab) {
    if (!u || !ab || !ab.id) return;
    u.casts = u.casts || {};
    u.casts[ab.id] = (u.casts[ab.id] || 0) + 1;
  }

  // ----- statuses --------------------------------------------------------
  // Everything about a status lives in the table (config.statuses, written in
  // src/config/statuses.js); the code below only knows the SHAPE of a row,
  // never a particular status. A unit carries a LIST OF INSTANCES:
  //     u.statuses = [{ id: 'regen', amount: 2, turns: 0, source: 's3', seen: true }]
  // `amount` is the row's X, `turns` its Y, `source` who put it on. A verb's
  // value on a unit is the sum over its instances of amount * the row's
  // coefficient, so two Hastes stack and Haste 2 counts double.
  const statusDef = (id) => (config.statuses ?? {})[id] ?? null;
  const carried = (u) => (u && u.statuses) || [];
  function statusSum(u, verb) {
    let n = 0;
    for (const inst of carried(u)) { const d = statusDef(inst.id); if (d && typeof d[verb] === 'number' && d[verb]) n += d[verb] * (inst.amount || 0); }
    return n;
  }
  // Multiplicative switches (impactTaken / impactDealt): multiplied over everything held.
  function statusMul(u, verb) {
    let n = 1;
    for (const inst of carried(u)) { const d = statusDef(inst.id); if (d && typeof d[verb] === 'number' && d[verb] !== 1) n *= d[verb]; }
    return n;
  }
  const statusHas = (u, id) => carried(u).some((i) => i.id === id);
  // The first instance whose row LISTS `value` under `field` (agency, forbids,
  // immune, ignoresImpact), or null.
  function statusListed(u, field, value) {
    for (const inst of carried(u)) { const d = statusDef(inst.id); if (d && Array.isArray(d[field]) && d[field].includes(value)) return inst; }
    return null;
  }
  // AGENCY: the id of the first held row that takes this right away from the
  // carrier ('stunned' = the whole activation, 'disarmed' = abilities only,
  // 'rooted' = walking, 'confused' = the engine plays it), or null.
  const agencyLost = (u, kind) => { const inst = statusListed(u, 'agency', kind); return inst ? inst.id : null; };
  // An AI DIRECTIVE the carrier is under: the unit its row points at
  // ({ mustTarget / avoidAdjacentTo / friend: 'source' }), or null.
  function directive(st, u, key) {
    for (const inst of carried(u)) {
      const d = statusDef(inst.id);
      if (!d || !d.ai || !d.ai[key]) continue;
      const src = st.units.find((x) => x.uid === inst.source && x.hp > 0);
      if (src) return src;
    }
    return null;
  }
  // The unit's numbers with its statuses folded in.
  const maxHpOf = (u) => Math.max(1, (u.maxHp || 0) + statusSum(u, 'maxHp'));
  const flies = (u) => { const f = statusSum(u, 'flight'); return f > 0 || (!!u.flying && f >= 0); };
  const stackMaxOf = (u) => Math.max(0, (u.stackMax || 0) + statusSum(u, 'maxStacks'));
  const stackGenOf = (u) => Math.max(0, (u.stackGen || 0) + statusSum(u, 'stackGen'));
  function addStacks(st, u, n) {
    if (!u || !u.isUnit || !(n > 0)) return 0;
    const before = u.stacks || 0;
    u.stacks = Math.min(stackMaxOf(u), before + n);
    const got = u.stacks - before;
    if (got > 0 && !st.sim) floater(u.pos, `🔶 +${got}`, '#ffd75f');
    return got;
  }
  // IMPACT damage - a crash into a wall or a body, a fall off a ledge, being
  // crushed between two things. One row may wave a kind of it away
  // (ignoresImpact), another make it bite harder (impactTaken); `dealer`
  // is whoever was shoved into the victim, whose impactDealt counts too.
  function sImpact(st, ent, amt, label, dealer = null) {
    if (ent && ent.isUnit && ent.hp > 0) {
      const inst = statusListed(ent, 'ignoresImpact', label);
      if (inst) {
        if (!st.sim) { const v = statusView(ent, inst.id); floater(ent.pos, v.icon, v.color); blog(ent.name + ' shrugs off the ' + label); }
        return;
      }
      amt = Math.round(amt * statusMul(ent, 'impactTaken') * (dealer && dealer.isUnit ? statusMul(dealer, 'impactDealt') : 1));
    }
    sHit(st, ent, amt, label);
  }
  // Icon and colour to show.
  function statusView(u, id) {
    const def = statusDef(id) || {};
    return { icon: def.icon, color: def.color };
  }
  // Puts a status on a unit. `opts` = { amount, turns, source, sourceName }: X
  // and Y when whoever applies it has an opinion (otherwise the row's), and
  // who did it (the uid the row's triggers and AI directives point back at;
  // the name is for the badge's text).
  // How a second application combines is the ROW's business (stacking). A
  // status the unit is IMMUNE to bounces. WHEN it went on does not matter:
  // its clock only starts counting from the first activation it is present at
  // the start of (tickStatuses / endActivation).
  function applyStatus(st, u, id, opts = {}) {
    const def = statusDef(id);
    if (!def || !u || !u.isUnit || u.hp <= 0) return null;
    const imm = statusListed(u, 'immune', id);
    if (imm) { if (!st.sim) floater(u.pos, statusView(u, imm.id).icon + ' immune', '#9aa7bd'); return null; }
    const amount = opts.amount !== undefined && opts.amount !== null ? opts.amount : def.amount;
    const turns = opts.turns !== undefined && opts.turns !== null ? opts.turns : def.turns;
    if (!(amount > 0)) return null;   // "Weak 0" is nothing to apply
    if (!u.statuses) u.statuses = [];
    let inst = null;
    if (def.stacking !== 'separate') {
      // 'add' merges only with an instance of the same permanence: a Shielded
      // with no clock and one with a clock stay two things.
      inst = u.statuses.find((i) => i.id === id && (def.stacking === 'refresh' || (i.turns > 0) === (turns > 0))) || null;
    }
    const hpBefore = u.hp;
    if (!inst) {
      inst = { id, amount, turns, source: opts.source ?? null, sourceName: opts.sourceName ?? null, seen: false };
      u.statuses.push(inst);
    } else if (def.stacking === 'add') {
      inst.amount += amount;
      if (inst.turns > 0 && turns > 0) inst.turns += turns;
      if (opts.source) { inst.source = opts.source; inst.sourceName = opts.sourceName ?? null; }
    } else {   // refresh
      inst.amount = amount; inst.turns = turns; inst.seen = false;
      if (opts.source) { inst.source = opts.source; inst.sourceName = opts.sourceName ?? null; }
    }
    // A row that raises max hp raises hp with it (Fortified).
    if (def.maxHp) u.hp = Math.min(maxHpOf(u), hpBefore + def.maxHp * amount);
    if (st.sim) (st.rec.applied[u.uid] ??= {})[id] = 1;
    else { const v = statusView(u, id); floater(u.pos, v.icon + (amount > 1 ? ' ' + amount : ''), v.color); }
    // A STUN lands on a player unit that still has its turn this round: it
    // loses THAT turn on the spot rather than the next one.
    if (!st.sim && def.agency.includes('stunned') && sb.phase === 'player' && sb.activeUid && !u.isEnemy && !u.done && u.uid !== sb.activeUid) {
      u.done = true;
      dropStatus(st, u, inst, false);
      blog(u.name + ' loses this turn');
    }
    return inst;
  }
  function dropStatus(st, u, inst, stripped) {
    if (!u || !u.statuses) return;
    const i = u.statuses.indexOf(inst);
    if (i < 0) return;
    u.statuses.splice(i, 1);
    const def = statusDef(inst.id);
    if (def && def.maxHp) u.hp = Math.min(u.hp, maxHpOf(u));
    // A status TAKEN OFF a unit matters to the AI as much as one put on.
    if (st && st.sim && stripped) (st.rec.stripped[u.uid] ??= {})[inst.id] = 1;
  }
  // Every instance of a row the unit carries, gone (a cleanse, a revive).
  function dropAll(st, u, id) { for (const inst of carried(u).filter((i) => i.id === id)) dropStatus(st, u, inst, false); }
  // Wears a status down: by its decay at the start of the carrier's turn, by
  // decayOnHit when it takes damage. An instance at 0 is gone. The per-turn
  // decay follows the clocks' rule - only an instance that was already there
  // at an earlier activation start wears (a Shielded put on at battle start
  // is still whole through the enemy's first phase) - except that a row that
  // TICKS wears right after its tick, so Bleed 2 bites 2, then 1, then ends.
  function decayStatuses(st, u, field) {
    for (const inst of [...carried(u)]) {
      const def = statusDef(inst.id);
      if (!def || !(def[field] > 0)) continue;
      if (field === 'decay' && !inst.aged && !def.tickHP) continue;
      inst.amount -= def[field];
      if (inst.amount <= 0) { dropStatus(st, u, inst, false); if (!st.sim) floater(u.pos, statusView(u, inst.id).icon + ' ends', '#7c8aa5'); }
    }
  }
  // A MOMENT for one unit: every trigger it is under (its own, from its
  // upgrade nodes / bestiary row / relic / aura; and its STATUS ROWS', for
  // whoever carries them) that names `when` runs now - through the very same
  // effect executors a cast uses. `extra` carries who else was involved:
  // { killer, victim, source }. The moments that exist are the places this is
  // called from (see TRIGGER_MOMENTS in rules.js). Runs in the AI's
  // simulations too, so a creature weighs the Enraged its hit would trigger.
  function fireMoment(st, u, when, extra = {}) {
    if (!u || !u.isUnit) return;
    // A dead unit still has its last 'hit' and its 'death' to report; every
    // other moment is for the living.
    if (u.hp <= 0 && when !== 'death' && when !== 'hit') return;
    const list = [];
    for (const p of u.triggers ?? []) if (p.when === when) list.push({ eff: p, source: null });
    for (const inst of [...carried(u)]) {
      const def = statusDef(inst.id);
      for (const p of def?.triggers ?? []) if (p.when === when) list.push({ eff: p, source: inst.source, def });
    }
    if (!list.length) return;
    const ctx = castCtx(st, u, null, null);
    ctx.killer = extra.killer ?? null; ctx.victim = extra.victim ?? null;
    const prevAtk = st.atk, prevSign = st.sign;
    for (const { eff, source, def } of list) {
      ctx.source = source ?? extra.source ?? null;
      if (eff.if && !cond(eff.if, ctx)) continue;
      // What a trigger does is signed by what fired it, so a heal from a
      // Lifelink reads "+1 🔗" and not like a blow the player just landed.
      st.atk = def ? def.name : u.name + "'s " + when;
      st.sign = def ? def.icon : '✨';
      runEffect(st, u, eff, ctx, [u.pos], 0);
    }
    st.atk = prevAtk; st.sign = prevSign;
  }
  // The START of a unit's own activation: stacks come in, 'activationStart'
  // triggers fire, statuses bite (tickHP), then wear down (decay). This
  // happens even on a turn the unit is about to lose to a stun. The clocks
  // do NOT run down here - that is endActivation's job - but every status
  // present now is marked, so that only those count down when the
  // activation ends.
  function tickStatuses(u) {
    if (u.hp <= 0) return;
    const st = liveSt();
    u.steps = 0;
    addStacks(st, u, stackGenOf(u));
    fireMoment(st, u, 'activationStart');
    if (u.hp <= 0) return;
    const bite = statusSum(u, 'tickHP');
    if (bite < 0) { st.atk = null; sHit(st, u, -bite, 'tick'); }
    if (bite > 0 && u.hp > 0) for (let i = 0; i <= statusSum(u, 'extraTicks'); i++) sHeal(st, u, bite);
    flushDeaths(st);
    if (u.hp <= 0) return;
    decayStatuses(st, u, 'decay');
    // `seen`: present at the start of THIS activation (cleared at its end -
    // the clocks' rule); `aged`: has been through one, ever (the decay's).
    for (const inst of carried(u)) { inst.seen = true; inst.aged = true; }
  }
  // The END of a unit's own activation: 'activationEnd' triggers fire, and
  // every clock that was running at the activation's start counts down one.
  // A status put on DURING the activation is not charged for it. A row with
  // no clock (turns 0) is simply skipped, which is all "permanent" means here.
  function endActivation(u) {
    if (!u || u.hp <= 0) return;
    const st = liveSt();
    fireMoment(st, u, 'activationEnd');
    for (const inst of [...carried(u)]) {
      if (!inst.seen) continue;
      inst.seen = false;
      if (!(inst.turns > 0)) continue;
      inst.turns -= 1;
      if (inst.turns <= 0) {
        const v = statusView(u, inst.id);
        dropStatus(st, u, inst, false);
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

  // How much carrying a status HURTS, in the AI's units - the table's aiValue
  // with the sign turned round (the table says how GOOD a status is to carry,
  // positive = a blessing; the scoring below counts harm, positive = worse off).
  // One sign flip, here, and nothing else in the planner had to change.
  function statusHarm(id) {
    const def = statusDef(id);
    return def ? -(def.aiValue || 0) : 0;
  }
  // partyDamageMod is a flat penalty applied to party casts only (the Stasis
  // "damage" debuff) - there is no equivalent enemy-side bonus any more
  // (removed 2026-09-10, an ability's own `damage` field is a bestiary row's
  // whole strength now).
  const dmgMod = (c) => (c && c.isEnemy === false ? -partyDamageMod : 0);

  // ----- live / simulated effect state (hex-box 10-battle-effects) -------
  function liveSt() { return { sim: false, units: sb.units, objects: sb.objects, tags: sb.tags, heights: sb.heights, deathQueue: sb.deathQueue, rec: null }; }
  function simSt(blind) {
    return { sim: true, blind: blind || null,
      // Every entity copied by its own clone() (a unit's status list one level
      // deep - forgetting that is what used to make the AI simulate a board it
      // could not actually see; an object's own state as its class sees fit).
      units: sb.units.map((u) => u.clone()),
      objects: sb.objects.map((o) => o.clone()),
      tags: Object.fromEntries(Object.entries(sb.tags).map(([k, t]) => [k, { ...t }])),
      heights: { ...sb.heights }, deathQueue: [],
      rec: { dmg: {}, moved: {}, killed: {}, revived: {}, applied: {}, stripped: {}, voided: {}, tmoved: {}, tkilled: {} } };
  }
  const stH = (st, k) => st.heights[k] ?? 0;
  const sUnitAt = (st, k) => st.units.find((u) => u.hp > 0 && u.pos === k);
  const sBodyAt = (st, k) => st.units.find((u) => u.downed && u.pos === k);
  const sObjectAt = (st, k) => st.objects.find((o) => o.alive && o.pos === k);
  const sBarrier = (st, k) => { const t = st.tags[k]; return t && t.hp > 0 ? t : null; };
  const sHazard = (st, k) => { const t = st.tags[k]; return t && !(t.hp > 0) ? t : null; };
  // What an Entity hook is handed (see entity.js): the board the blow lands
  // on, whether it is a simulation, who struck, and ways to say so.
  const hookCtx = (st, label = '') => ({ st, sim: !!st.sim, caster: st.csr ?? null, cast: st.cast ?? null, label,
    floater: st.sim ? () => {} : floater, log: st.sim ? () => {} : blog });

  // A unit that just died, and who did it: the 'death' moment on the victim
  // (Marked rewards its killer) and the 'kill' moment on the killer.
  function noteKill(st, v, killer) {
    fireMoment(st, v, 'death', { killer: killer && killer.isUnit ? killer : null });
    if (killer && killer.isUnit && killer.hp > 0 && killer !== v) fireMoment(st, killer, 'kill', { victim: v });
  }

  // `quiet` skips the floater and the log line (a multi-hit ability reports its
  // hits as one). `opts` = { pierce, lifesteal }: pierce ignores the target's
  // damage REDUCTION (its negative damageTaken), lifesteal heals the attacker
  // by that much when the blow lands. Returns { dealt, blocked }.
  function sHit(st, v, amt, label, pre, quiet = false, opts = null) {
    if (amt <= 0 || !v) return { dealt: 0, blocked: false };
    pre = pre || '';
    const atk = st.atk ? st.atk + ' -> ' : '';
    if (v.isUnit) {
      if (v.hp <= 0) return { dealt: 0, blocked: false };
      // Statuses that change how much damage this unit TAKES: Shielded and
      // Impervious soften it, Vulnerable sharpens it. A hit never goes below 0 -
      // and a hit softened to nothing is still a hit on the shield (it wears).
      let taken = statusSum(v, 'damageTaken');
      if (opts && opts.pierce && taken < 0) taken = 0;
      amt = Math.max(0, Math.round(amt + taken));
      const dealt = amt > 0 ? v.takeDamage(amt, hookCtx(st, label)) : 0;
      decayStatuses(st, v, 'decayOnHit');
      if (st.sim) { st.rec.dmg[v.uid] = (st.rec.dmg[v.uid] || 0) + amt; if (v.hp <= 0) st.rec.killed[v.uid] = 1; }
      else {
        if (!quiet) {
          if (amt > 0) { floater(v.pos, pre + '-' + amt + (label ? ' ' + label : ''), '#ff5d73'); blog(atk + v.name + ': -' + amt + (label ? ' ' + label : '')); }
          else { floater(v.pos, pre + '0 ' + (label || ''), '#9aa7bd'); blog(atk + v.name + ': absorbed'); }
        }
        if (v.hp <= 0) { v.lock = null; blog(v.name + ' is down'); noteDeath(st, v, v.pos, label || 'damage'); }
      }
      if (dealt > 0 && opts && opts.lifesteal > 0 && st.csr && st.csr.isUnit && st.csr.hp > 0) sHeal(st, st.csr, opts.lifesteal);
      // The 'hit' moment: hp was actually lost - the killing blow included
      // (a Lifelink heals on it like on any other; a status the victim would
      // have put on itself simply finds nobody to carry it). A unit that died
      // then gets 'death', and its killer 'kill'.
      if (dealt > 0) {
        fireMoment(st, v, 'hit', { source: st.csr ?? null });
        if (v.hp <= 0) noteKill(st, v, st.csr ?? null);
      }
      return { dealt, blocked: amt <= 0 };
    } else if (v instanceof Entity) {
      // An OBJECT: its class decides what a blow does to it (entity.js). In a
      // simulation too - it acts on the copy, so the forecast reads it right.
      if (!v.alive) return { dealt: 0, blocked: false };
      const dealt = v.takeDamage(amt, hookCtx(st, label));
      if (st.sim) { st.rec.dmg[v.uid] = (st.rec.dmg[v.uid] || 0) + dealt; if (!v.alive) st.rec.killed[v.uid] = 1; }
      else if (!quiet) { floater(v.pos, pre + '-' + dealt + (label ? ' ' + label : ''), '#ffd75f'); blog(atk + v.name + ': -' + dealt + (label ? ' ' + label : '')); }
      if (!v.alive) { if (!st.sim) blog(v.name + ' is destroyed'); v.onDeath(hookCtx(st, label)); }
      return { dealt, blocked: false };
    } else {
      if (v.hp <= 0) return { dealt: 0, blocked: false };
      const before = v.hp;
      v.hp = Math.max(0, v.hp - amt);
      const dealt = before - v.hp, over = amt - dealt;
      if (!st.sim && !quiet) { floater(v.k, pre + '-' + dealt, '#ffd75f'); blog(atk + v.name + ': -' + dealt + (over ? ' (' + over + ' over)' : '')); }
      if (v.hp <= 0) {
        if (st.tags[v.k] === v) delete st.tags[v.k];
        if (st.sim) st.rec.tkilled[v.tid] = 1;
        else { floater(v.k, '✸ ' + v.name, '#ff9950'); blog(v.name + ' is destroyed'); }
        if (v.onDestroy) st.deathQueue.push({ abId: v.onDestroy, k: v.k, name: v.name });
      }
      // An encounter's rules may care what a barrier took (the Hack's nodes).
      if (!st.sim && rules && rules.onBarrierHit) rules.onBarrierHit(st, v, dealt, over, st.csr, v.k);
      return { dealt, blocked: false };
    }
  }
  // The HITS of an ability on one target: `times` separate blows of `base`
  // each. Every blow is its own hit - its own floater, its own 'hit' moment
  // (a Lifelink heals per quill), its own wear on a shield - and a blow that
  // lands on a target already down is simply not thrown.
  function sHits(st, tgt, base, times, label, pre, opts) {
    let dealt = 0;
    const tag = times > 1 ? (i) => `${pre || ''}${i + 1}/${times} ` : () => (pre || '');
    for (let i = 0; i < times; i++) {
      if (!tgt || tgt.hp <= 0) break;
      const r = sHit(st, tgt, base, label, tag(i), false, opts);
      dealt += r.dealt;
    }
    return { dealt, blocked: false };
  }
  function sHeal(st, v, amt) {
    if (amt <= 0 || !v || !v.isUnit || v.hp <= 0) return;
    const g = Math.min(amt, maxHpOf(v) - v.hp);
    // A heal with no room to land still says so: "+0 full" tells the player
    // the heal happened and why nothing changed.
    if (g <= 0) { if (!st.sim) { floater(v.pos, '+0 full' + (st.sign ? ' ' + st.sign : ''), '#7c8aa5'); blog((st.atk ? st.atk + ' -> ' : '') + v.name + ': already at full hp'); } return; }
    v.hp += g;
    if (st.sim) st.rec.dmg[v.uid] = (st.rec.dmg[v.uid] || 0) - g;
    else { floater(v.pos, '+' + g + (st.sign ? ' ' + st.sign : ''), '#a8e05f'); blog((st.atk ? st.atk + ' -> ' : '') + v.name + ': +' + g); }
  }
  // DOWN BUT NOT OUT: a heal landing on a downed body brings it back, with the
  // heal as its hp. It gets up fresh - the statuses it went down with are gone,
  // and it acts from the next round on (its side's next phase), never in the
  // middle of the one it was revived in.
  function sRevive(st, v, amt) {
    if (amt <= 0 || !v || !v.isUnit || !v.downed) return;
    v.hp = Math.min(v.maxHp, amt);
    v.statuses = [];
    v.lock = null;
    v.done = true;
    if (st.sim) { st.rec.dmg[v.uid] = (st.rec.dmg[v.uid] || 0) - v.hp; st.rec.revived[v.uid] = 1; }
    else { floater(v.pos, 'REVIVED +' + v.hp, '#a8e05f'); blog((st.atk ? st.atk + ' -> ' : '') + v.name + ' is back up (+' + v.hp + ')'); }
  }
  // Falls and crushes always stun; a crash stuns when the push behind it says
  // so (onCrash). What "stunned" DOES is the table's business.
  function sStun(st, v) {
    if (!v || !v.isUnit || v.hp <= 0) return;
    applyStatus(st, v, 'stun', { turns: 1 });
    if (!st.sim) blog(v.name + ' is stunned');
  }
  function sVoid(st, ent) {
    // A downed body shoved over the edge goes too: out of the world, gone.
    if (ent && ent.isUnit && ent.downed) {
      ent.gone = true; ent.lock = null;
      if (st.sim) st.rec.voided[ent.uid] = 1;
      else { floater(ent.pos, '🕳 VOID', '#c66dff'); blog(ent.name + ' is shoved into the void'); }
      return;
    }
    if (!ent || ent.hp <= 0) return;
    if (ent instanceof Entity && !ent.isUnit) {
      // An object over the edge: gone, its class told.
      ent.hp = 0;
      if (st.sim) st.rec.killed[ent.uid] = 1;
      else { floater(ent.pos, '🕳 ' + ent.name, '#c66dff'); blog(ent.name + ' falls into the void'); }
      ent.onDeath(hookCtx(st, 'void'));
      return;
    }
    if (ent.isUnit) {
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
      ent.gone = true;   // no body: it fell out of the world (not downed)
      ent.lock = null;
      noteKill(st, ent, st.csr ?? null);
    } else {
      ent.hp = 0;
      if (st.tags[ent.k] === ent) delete st.tags[ent.k];
      if (st.sim) st.rec.tkilled[ent.tid] = 1;
      else { floater(ent.k, '🕳 ' + ent.name, '#c66dff'); blog(ent.name + ' falls into the void'); }
    }
  }
  function sMoveTo(st, ent, k) {
    if (ent instanceof Entity) { ent.pos = k; if (st.sim) st.rec.moved[ent.uid] = k; }
    else { if (st.tags[ent.k] === ent) delete st.tags[ent.k]; ent.k = k; st.tags[k] = ent; if (st.sim) st.rec.tmoved[ent.tid] = k; }
  }
  function sArrive(st, u, depth = 0) {
    if (!u || !u.isUnit || u.hp <= 0) return;
    const t = st.tags[u.pos];
    if (t && t.collectible && t.hp <= 0) {
      delete st.tags[u.pos];
      if (!st.sim) floater(u.pos, t.icon + ' ' + t.name, '#a8e05f');
      if (t.onPickup) { if (!st.sim) blog(u.name + ' picks up ' + t.name); const ab = abById(t.onPickup); if (ab) resolveCast(st, { pos: u.pos, name: t.name }, ab, u.pos, depth + 1); }
    }
  }
  // A crash: flat impact damage, plus whatever the push behind it says happens
  // to whoever crashes (onCrash: a status - Concussive Charge's stun). Reads
  // `st.cast.onCrash` (set by the push effect mid-resolution), so it only
  // ever affects the unit THIS push belongs to, never a bystander.
  function sCrash(st, ent) {
    sImpact(st, ent, 2, 'crash');
    const oc = st.cast && st.cast.onCrash;
    if (oc && ent && ent.isUnit && ent.hp > 0) applyStatus(st, ent, oc.status, { amount: oc.amount, turns: oc.turns, source: st.csr?.uid ?? null, sourceName: st.csr?.name ?? null });
  }
  function sPush(st, ent, dir, depth = 0) {
    if (depth > 8) return;
    const isU = !!ent.isUnit;
    const k = ent instanceof Entity ? ent.pos : ent.k;
    const nk = addK(k, DIRS[dir]);
    if (isVoid(nk)) { sVoid(st, ent); return; }
    const wall = !tilePass(nk) || (stH(st, nk) - stH(st, k) >= 2);
    if (wall) { sCrash(st, ent); return; }
    // A downed body in the way is an occupant like any other: a collision (it
    // takes nothing from it - sHit passes a body by), or a crush from above.
    const occ = sUnitAt(st, nk) || sObjectAt(st, nk) || sBarrier(st, nk) || sBodyAt(st, nk);
    const drop = stH(st, k) - stH(st, nk);
    if (occ) {
      if (drop >= 2) {
        sImpact(st, occ, 2, 'crush', ent); sStun(st, occ);
        if (occ.hp > 0) {
          const nk2 = addK(nk, DIRS[dir]);
          const room = isVoid(nk2) || (tilePass(nk2) && (stH(st, nk2) - stH(st, nk) < 2) && !sUnitAt(st, nk2) && !sObjectAt(st, nk2) && !sBarrier(st, nk2) && !sBodyAt(st, nk2));
          // (An object that cannot be pushed is crushed where it stands, like a barrier.)
          if (room && !(occ instanceof Entity && !occ.pushable)) sPush(st, occ, dir, depth + 1);
          else if (occ.isUnit) {
            if (st.sim) { st.rec.dmg[occ.uid] = (st.rec.dmg[occ.uid] || 0) + occ.hp; st.rec.killed[occ.uid] = 1; }
            else { floater(nk, 'CRUSHED', '#ff5d73'); blog(occ.name + ' is crushed flat'); }
            noteDeath(st, occ, nk, 'crush');
            occ.hp = 0;
            noteKill(st, occ, st.csr ?? null);
          } else sHit(st, occ, 999, '');
        }
        // (A unit crushed flat above is now a downed body on nk: still in the way.
        // A body under the drop is not shoved on down the line - its hp is 0.)
        const blocked = sUnitAt(st, nk) || sObjectAt(st, nk) || sBarrier(st, nk) || sBodyAt(st, nk);
        if (blocked) {
          sCrash(st, ent);
        } else if (ent.hp > 0 || (isU && ent.downed)) {
          sMoveTo(st, ent, nk);
          sImpact(st, ent, 2, 'fall'); sStun(st, ent);
          if (isU) sArrive(st, ent, depth);
        }
      } else {
        sCrash(st, ent); sImpact(st, occ, 2, 'crash', ent);
      }
    } else {
      sMoveTo(st, ent, nk);
      if (drop >= 2) { sImpact(st, ent, 2, 'fall'); sStun(st, ent); }
      if (isU && ent.hp > 0) sArrive(st, ent, depth);
    }
  }
  function flushDeaths(st, depth = 0) {
    let guard = 0;
    while (st.deathQueue.length && guard++ < 24) {
      const d = st.deathQueue.shift();
      const ab = abById(d.abId);
      if (ab) resolveCast(st, { pos: d.k, name: d.name }, ab, d.k, depth + 1);
    }
  }

  // ----- the cast context: the FACTS a quantity or a condition may read -----
  // Built once per cast (or per moment) for its caster; `withTarget` gives a
  // view of the same context for the unit an effect is landing on. The names
  // are listed in rules.js; the engine is the only place they are worked out.
  function castCtx(st, caster, ab, anchors) {
    const aim = anchors && anchors.length ? anchors[0] : null;
    const ctx = { st, caster, ab, anchors, aim, consumed: 0, amounts: {}, target: null, killer: null, victim: null, source: null };
    const alive = (x) => x && x.isUnit && x.hp > 0;
    const side = (a, b) => a.isEnemy === b.isEnemy;
    const adjacent = (u, same) => st.units.filter((o) => alive(o) && o !== u && hexDist(o.pos, u.pos) === 1 && side(o, u) === same).length;
    const onTag = (u, id) => { const tg = u && st.tags[u.pos]; return tg && tg.defId === id && !(tg.hp > 0) ? 1 : 0; };
    // A method, not an arrow: a withTarget VIEW of this context must answer
    // for its own target, and `this` is what makes it do so.
    ctx.fact = function fact(name) {
      const c = this.caster, tg = this.target;
      const i = name.indexOf(':');
      const head = i > 0 ? name.slice(0, i) : name, arg = i > 0 ? name.slice(i + 1) : '';
      switch (head) {
        case 'tilesTravelled': return c && c.isUnit ? (c.steps || 0) : 0;
        case 'moveSpent': return c && c.isUnit ? walked(c) : 0;
        case 'moveLeft': return c && c.isUnit ? moveLeft(c) : 0;
        case 'didNotMove': return c && c.isUnit ? (c.pos === c.startPos ? 1 : 0) : 0;
        case 'hp': return c ? c.hp || 0 : 0;
        case 'maxHp': return c && c.isUnit ? maxHpOf(c) : 0;
        case 'hpFrac': return c && c.isUnit && maxHpOf(c) > 0 ? c.hp / maxHpOf(c) : 0;
        case 'stacks': return c && c.isUnit ? (c.stacks || 0) : 0;
        case 'consumed': return this.consumed;
        case 'castsThisBattle': return c && c.casts && this.ab && this.ab.id ? (c.casts[this.ab.id] || 0) : 0;
        case 'adjacentAllies': return c && c.isUnit ? adjacent(c, true) : 0;
        case 'adjacentEnemies': return c && c.isUnit ? adjacent(c, false) : 0;
        case 'onTag': return onTag(c, arg);
        case 'distance': return c && this.aim ? hexDist(c.pos, this.aim) : 0;
        case 'maxRange': return this.ab ? (this.ab.castAny ? 99 : zoneMaxRange(this.ab.castZone)) : 0;
        case 'atMaxRange': return c && this.aim && this.ab && !this.ab.castAny && hexDist(c.pos, this.aim) === zoneMaxRange(this.ab.castZone) ? 1 : 0;
        case 'elevationDiff': return c && this.aim ? stH(st, this.aim) - stH(st, c.pos) : 0;
        case 'elevationClimb': return c && this.aim ? Math.max(0, stH(st, this.aim) - stH(st, c.pos)) : 0;
        case 'elevationDrop': return c && this.aim ? Math.max(0, stH(st, c.pos) - stH(st, this.aim)) : 0;
        case 'targetHp': return tg ? tg.hp || 0 : 0;
        case 'targetMaxHp': return tg && tg.isUnit ? maxHpOf(tg) : (tg ? tg.maxHp || 0 : 0);
        case 'targetHpFrac': return tg && tg.isUnit && maxHpOf(tg) > 0 ? tg.hp / maxHpOf(tg) : 0;
        case 'targetHas': return tg && tg.isUnit && statusHas(tg, arg) ? 1 : 0;
        case 'targetOnTag': return onTag(tg, arg);
        case 'targetAdjacentAllies': return tg && tg.isUnit ? adjacent(tg, true) : 0;
        case 'unitsWith': return st.units.filter((o) => alive(o) && statusHas(o, arg)).length;
        case 'amount': return this.amounts[arg] || 0;
        case 'round': return sb.round;
        default: return 0;
      }
    };
    ctx.withTarget = (u) => { const v = Object.create(ctx); v.target = u; return v; };
    return ctx;
  }

  // ----- the effect executors -----------------------------------------------
  // The tiles one effect covers around one anchor, rotated with the aim.
  function effectTiles(st, caster, ab, e, anchor, rk) {
    const out = [];
    // (A zone that still names another effect - an ability handed in without
    // going through resolveZones - falls back to the anchor tile.)
    for (const off of Array.isArray(e.zone) ? e.zone : [[0, 0]]) {
      const dt = addK(anchor, rotOff([off[0], off[1]], rk));
      if (tilePass(dt) && !out.includes(dt)) out.push(dt);
    }
    return out;
  }
  // Does `u` fit what the effect is for? (`sel` is the effect's `targets`.)
  function targetFits(ctx, u, sel) {
    const c = ctx.caster;
    if (!u) return false;
    if (sel === 'any' || sel === 'units') return true;
    if (sel === 'self') return u === c;
    if (!c || c.isEnemy === undefined) return sel === 'enemies' ? !!u.isEnemy : true;
    if (sel === 'enemies') return u.isEnemy !== c.isEnemy;
    if (sel === 'allies') return u.isEnemy === c.isEnemy && u !== c;
    if (sel === 'party') return u.isEnemy === c.isEnemy;
    if (sel === 'source') return !!ctx.source && u.uid === ctx.source;
    if (sel === 'killer') return !!ctx.killer && u === ctx.killer;
    return false;
  }
  // The UNITS an effect lands on. With a zone: the living units standing on
  // it that fit `targets`. Without one (a trigger, or targets 'self' /
  // 'source' / 'killer'): every living unit on the board that fits.
  function effectUnits(st, ctx, e, tiles) {
    const sel = e.targets || 'any';
    if (sel === 'self') return ctx.caster && ctx.caster.isUnit && ctx.caster.hp > 0 ? [ctx.caster] : [];
    if (sel === 'source') { const u = st.units.find((x) => x.uid === ctx.source && x.hp > 0); return u ? [u] : []; }
    if (sel === 'killer') return ctx.killer && ctx.killer.hp > 0 ? [ctx.killer] : [];
    if (!e.zone) return st.units.filter((u) => u.hp > 0 && targetFits(ctx, u, sel));
    const out = [];
    for (const dt of tiles) { const u = sUnitAt(st, dt); if (u && targetFits(ctx, u, sel) && !out.includes(u)) out.push(u); }
    return out;
  }
  // One effect of a cast, around `anchors`, with `hits` (per anchor) saying how
  // many of a damage effect's blows land there. Everything a cast or a moment
  // can do goes through here, one branch per kind.
  function runEffect(st, caster, e, ctx, anchors, depth, hits = null) {
    const ab = ctx.ab;
    const rkFor = (a) => (ab ? abRotFor(ab, caster.pos, a) : 0);
    switch (e.kind) {
      case 'consume': {
        if (e.if && !cond(e.if, ctx)) return;
        if (!caster.isUnit) return;
        const cap = e.max !== undefined && e.max !== null ? qty(e.max, ctx) : Infinity;
        const n = Math.max(0, Math.min(caster.stacks || 0, cap));
        if (n <= 0) return;
        caster.stacks -= n;
        ctx.consumed += n;
        if (!st.sim) { floater(caster.pos, `🔶 -${n}`, '#ffd75f'); blog(`${caster.name} spends ${n} stack${n === 1 ? '' : 's'}`); }
        return;
      }
      case 'damage': {
        anchors.forEach((anchor, ai) => {
          const times = hits ? hits[ai] : Math.max(1, Math.round(qty(e.times, ctx)));
          if (times <= 0) return;
          const rk = rkFor(anchor);
          for (const dt of effectTiles(st, caster, ab, e, anchor, rk)) {
            const u = sUnitAt(st, dt), ob = sObjectAt(st, dt), bt = sBarrier(st, dt);
            // A HAZARD tag under a hex of the pattern (the Hack's mines): the
            // rules hear about it whether or not anything stands there. Real casts only.
            const hz = sHazard(st, dt);
            if (hz && !st.sim && rules && rules.onHazardHit) rules.onHazardHit(st, hz, caster, dt, ab);
            const sel = e.targets || 'any';
            const tgt = (u && targetFits(ctx, u, sel)) ? u : (!u && (sel === 'any') ? (ob || bt) : null);
            if (!tgt) { if (!st.sim && !u) floater(dt, '✸', ab ? ab.color : '#5fc7e0'); continue; }
            const tctx = ctx.withTarget(tgt);
            if (e.if && !cond(e.if, tctx)) continue;
            // Everything below changes the BASE - every one of the hits. The
            // caster's own Strong / Weak, its lifesteal, the height, then the
            // multiplier, then the volley's overlap bonus.
            const ls = qty(e.lifesteal, tctx) + (caster.isUnit ? statusSum(caster, 'lifesteal') : 0);
            let dmg = qty(e.amount, tctx) + dmgMod(caster) + (caster.isUnit ? statusSum(caster, 'damageDealt') : 0) + ls;
            let lbl = '';
            // A mind blind to elevation judges the blow as if the ground were flat.
            if (u && !(st.blind && st.blind.elevation)) {
              const hd = stH(st, caster.pos) - stH(st, dt);
              if (hd >= 2 && CFG.highBonus > 0) { dmg += CFG.highBonus; lbl = 'HIGH'; }
              else if (hd <= -2 && CFG.lowPenalty > 0) { dmg = Math.max(0, dmg - CFG.lowPenalty); lbl = 'LOW'; }
            }
            const mul = qty(e.multiplier, tctx);
            if (mul !== 1) { dmg = Math.round(dmg * mul); lbl = (lbl ? lbl + ' ' : '') + 'x' + mul; }
            dmg = Math.max(0, dmg);
            // AIM LOCKS firing one after another: +bonusPerOverlap base damage on
            // this hex for every damaging ability that hit it EARLIER in the volley.
            if (st.overlap) { const b = overlapBonus(st.overlap[dt] || 0); if (b > 0) { dmg += b; lbl = (lbl ? lbl + ' ' : '') + '+' + b; } }
            if (dmg > 0) sHits(st, tgt, dmg, times, lbl, '✸ ', { pierce: !!e.pierce, lifesteal: ls > 0 ? ls : 0 });
            else if (!st.sim) floater(dt, '✸ 0 ' + lbl, '#9aa7bd');
            ctx.hitTiles.add(dt);
          }
        });
        // The volley's overlap ledger: this ability now counts as having hit
        // every hex of its pattern, for whoever fires after it. Only the
        // party's own casts (depth 0). Resonance heals the caster per tile
        // someone already hit; Synergy and overlapGrant raise what later
        // casts get.
        if (st.overlap && depth === 0 && caster.isUnit) {
          const grant = qty(e.overlapGrant, ctx) + statusSum(caster, 'overlapGrant');
          const res = statusSum(caster, 'healOnOverlap');
          let already = 0;
          for (const dt of ctx.hitTiles) { if (ctx.ledgered.has(dt)) continue; ctx.ledgered.add(dt); if (st.overlap[dt] > 0) already++; st.overlap[dt] = (st.overlap[dt] || 0) + grant; }
          if (res > 0 && already > 0) sHeal(st, caster, res * already);
        }
        return;
      }
      case 'heal': {
        for (const anchor of anchors) {
          const rk = rkFor(anchor);
          const tiles = e.zone ? effectTiles(st, caster, ab, e, anchor, rk) : [];
          const sel = e.targets || 'any';
          // A downed body takes only a heal, which revives it (and gets up
          // with that hp - it is not healed a second time below).
          const revived = new Set();
          if (e.zone) for (const dt of tiles) {
            if (sUnitAt(st, dt)) continue;
            const body = sBodyAt(st, dt);
            if (body && targetFits(ctx, body, sel)) { const n = qty(e.amount, ctx.withTarget(body)); if (n > 0) { sRevive(st, body, n); revived.add(body); } }
            else if (!body && !st.sim) floater(dt, '✸', ab ? ab.color : '#a8e05f');
          }
          for (const u of effectUnits(st, ctx, e, tiles)) {
            if (revived.has(u)) continue;
            const tctx = ctx.withTarget(u);
            if (e.if && !cond(e.if, tctx)) continue;
            const n = qty(e.amount, tctx);
            if (e.id) ctx.amounts[e.id] = n;
            if (n > 0) sHeal(st, u, n);
          }
          if (!e.zone) break;
        }
        return;
      }
      case 'status': {
        for (const anchor of anchors) {
          const rk = rkFor(anchor);
          const tiles = e.zone ? effectTiles(st, caster, ab, e, anchor, rk) : [];
          for (const u of effectUnits(st, ctx, e, tiles)) {
            const tctx = ctx.withTarget(u);
            if (e.if && !cond(e.if, tctx)) continue;
            const amount = e.amount !== undefined && e.amount !== null ? qty(e.amount, tctx) : undefined;
            const turns = e.turns !== undefined && e.turns !== null ? qty(e.turns, tctx) : undefined;
            const repeat = Math.max(0, Math.round(qty(e.repeat, tctx)));
            for (let r = 0; r < repeat; r++) applyStatus(st, u, e.status, { amount, turns, source: caster.uid ?? null, sourceName: caster.name ?? null });
          }
          if (!e.zone) break;
        }
        return;
      }
      case 'gain': {
        for (const anchor of anchors) {
          const rk = rkFor(anchor);
          const tiles = e.zone ? effectTiles(st, caster, ab, e, anchor, rk) : [];
          for (const u of effectUnits(st, ctx, e, tiles)) {
            const tctx = ctx.withTarget(u);
            if (e.if && !cond(e.if, tctx)) continue;
            addStacks(st, u, qty(e.amount, tctx));
          }
          if (!e.zone) break;
        }
        return;
      }
      case 'extraAttack': {
        for (const u of effectUnits(st, ctx, e, [])) {
          if (e.if && !cond(e.if, ctx.withTarget(u))) continue;
          u.extraAttacks = (u.extraAttacks || 0) + 1;
          if (!st.sim) { floater(u.pos, '🔁 again', '#ffd166'); blog(u.name + ' may attack again'); }
        }
        return;
      }
      case 'push': {
        // Collected into the cast's shove list; resolveCast runs the waves.
        for (const anchor of anchors) {
          const rk = rkFor(anchor);
          for (const dt of effectTiles(st, caster, ab, e, anchor, rk)) {
            const rd = rotDir(e.dir, rk);
            const u = sUnitAt(st, dt) || sBodyAt(st, dt);
            let ent = null;
            if (u) { if (targetFits(ctx, u, e.targets || 'any')) ent = u; }
            else { const ob = sObjectAt(st, dt); if (ob) { if (ob.pushable) ent = ob; } else { const t = st.tags[dt]; if (t && t.hp > 0 && t.pushable) ent = t; } }
            if (!ent) continue;
            const tctx = ent.isUnit ? ctx.withTarget(ent) : ctx;
            if (e.if && !cond(e.if, tctx)) continue;
            const dist = Math.max(0, Math.min(CFG.maxPush ?? 2, Math.round(qty(e.dist, tctx))));
            if (dist > 0) ctx.shoves.push({ ent, dir: rd, dist, onCrash: e.onCrash ?? null });
          }
        }
        return;
      }
      case 'throw': {
        // Over the caster, onto the tile behind it: the step from the thrown
        // unit's tile towards the caster, carried on one more.
        for (const anchor of anchors) {
          const rk = rkFor(anchor);
          for (const dt of effectTiles(st, caster, ab, e, anchor, rk)) {
            const u = sUnitAt(st, dt) || sBodyAt(st, dt);
            if (!u || !targetFits(ctx, u, e.targets || 'any') || u === caster) continue;
            if (e.if && !cond(e.if, ctx.withTarget(u))) continue;
            const line = hexLine(u.pos, caster.pos);
            if (line.length < 2) continue;
            const stepK = line[1];
            const [q0, r0] = PK(u.pos), [q1, r1] = PK(stepK);
            const dir = DIRS.findIndex((d) => d[0] === q1 - q0 && d[1] === r1 - r0);
            if (dir < 0) continue;
            const dest = addK(caster.pos, DIRS[dir]);
            if (isVoid(dest)) { sVoid(st, u); continue; }
            const blocked = !tilePass(dest) || sUnitAt(st, dest) || sObjectAt(st, dest) || sBarrier(st, dest) || sBodyAt(st, dest);
            if (blocked) { sCrash(st, u); continue; }
            const from = u.pos;
            sMoveTo(st, u, dest);
            if (!st.sim) { floater(dest, '🔃 ' + u.name, '#ffd166'); blog(caster.name + ' throws ' + u.name + ' over'); }
            if (stH(st, from) - stH(st, dest) >= 2) { sImpact(st, u, 2, 'fall'); sStun(st, u); }
            if (u.hp > 0) sArrive(st, u, depth);
          }
        }
        return;
      }
      case 'swap': {
        for (const anchor of anchors) {
          const rk = rkFor(anchor);
          for (const dt of effectTiles(st, caster, ab, e, anchor, rk)) {
            const u = sUnitAt(st, dt);
            if (!u || u === caster || !targetFits(ctx, u, e.targets || 'allies')) continue;
            if (e.if && !cond(e.if, ctx.withTarget(u))) continue;
            if (!caster.isUnit) continue;
            const a = caster.pos, b = u.pos;
            sMoveTo(st, u, a); sMoveTo(st, caster, b);
            if (!st.sim) { floater(b, '🔃 swap', '#ffd166'); blog(caster.name + ' changes places with ' + u.name); }
            sArrive(st, u, depth); sArrive(st, caster, depth);
            return;   // one swap per cast
          }
        }
        return;
      }
      case 'height': {
        if (e.if && !cond(e.if, ctx)) return;
        const n = qty(e.amount, ctx);
        for (const anchor of anchors) {
          const rk = rkFor(anchor);
          for (const dt of effectTiles(st, caster, ab, e, anchor, rk)) {
            const h0 = st.heights[dt] ?? 0;
            st.heights[dt] = Math.max(0, Math.min(CFG.elevationLevels, e.mode === 'abs' ? n : h0 + n));
          }
        }
        return;
      }
      case 'tag': {
        if (e.if && !cond(e.if, ctx)) return;
        const d = tagDefById(e.tag);
        if (!d) return;
        for (const anchor of anchors) {
          const rk = rkFor(anchor);
          for (const dt of effectTiles(st, caster, ab, e, anchor, rk)) {
            if (d.hp > 0 && (sUnitAt(st, dt) || sObjectAt(st, dt) || sBarrier(st, dt) || sBodyAt(st, dt))) continue;
            const inst = tagInst(d, e.tag, dt);
            if (e.life !== undefined && e.life !== null) inst.life = Math.max(0, Math.round(qty(e.life, ctx)));
            st.tags[dt] = inst;
            if (d.collectible && d.hp <= 0) { const u = sUnitAt(st, dt); if (u) sArrive(st, u, depth); }
          }
        }
        return;
      }
      case 'dash': {
        if (e.if && !cond(e.if, ctx)) return;
        const aim = anchors[0];
        if (!aim || !caster.isUnit || caster.hp <= 0 || caster.pos === aim) return;
        const land = dashLanding(st, caster, aim, e.through === 'allies');
        if (land !== caster.pos) {
          sMoveTo(st, caster, land);
          if (!st.sim) {
            floater(land, '⤳', '#5fc7e0');
            blog(caster.name + (land === aim ? ' moves to the target' : ' charges in as far as it can'));
          }
          sArrive(st, caster, depth);
          flushDeaths(st, depth);
        }
        return;
      }
      default: return;
    }
  }
  // The phase an effect runs in. Fixed by kind (and by the 'landing' anchor),
  // so folding upgrades over an ability never has to order anything.
  const PHASE = { consume: 0, damage: 1, heal: 1, status: 1, gain: 1, extraAttack: 1, push: 2, throw: 2, swap: 2, height: 3, tag: 4, dash: 6 };
  const phaseOf = (e) => (e.anchor === 'landing' ? 7 : (PHASE[e.kind] ?? 5));

  // THE CAST. `anchors` is one aim tile or a list of them (an ability with
  // aims > 1). Effects run by phase; a damage effect's hits are dealt
  // round-robin over the anchors; the shoves of every push effect resolve
  // together in waves after the hits; the dash runs last but for the effects
  // anchored on where the caster lands.
  function resolveCast(st, caster, ab, anchors, depth = 0) {
    if (!ab || depth > 6) return;
    const list = Array.isArray(anchors) ? anchors.filter(Boolean) : [anchors];
    if (!list.length) return;
    const prevAtk = st.atk, prevCsr = st.csr, prevCast = st.cast;
    st.csr = caster;
    st.cast = { caster, ab, onCrash: null };   // this cast's token, for an Entity that counts attacks (hookCtx)
    if (caster.name) st.atk = caster.name;
    if (!st.sim && caster.name) blog(caster.name + ' casts ' + ab.name);
    const ctx = castCtx(st, caster, ab, list);
    ctx.shoves = []; ctx.hitTiles = new Set(); ctx.ledgered = new Set();
    const casterStart = caster.pos;
    const effects = (ab.effects ?? []).map((e, i) => ({ e, i })).sort((a, b) => phaseOf(a.e) - phaseOf(b.e) || a.i - b.i);
    let phase = -1;
    const anchorsFor = (e) => (e.anchor === 'caster' ? [casterStart] : e.anchor === 'landing' ? [caster.pos] : list);
    for (const { e } of effects) {
      const ph = phaseOf(e);
      if (ph !== phase) {
        // Leaving the push phase: the shoves resolve in waves (see hex-box).
        if (phase === 2) runShoves(st, ctx, depth);
        if (phase >= 1) flushDeaths(st, depth);
        phase = ph;
      }
      if (caster.isUnit && caster.hp <= 0) break;
      let hits = null;
      if (e.kind === 'damage' && e.anchor !== 'caster' && e.anchor !== 'landing') {
        // Hits split over the aims: the first aims get the extra one.
        const times = Math.max(0, Math.round(qty(e.times, ctx)));
        hits = list.map((_, i) => Math.floor(times / list.length) + (i < times % list.length ? 1 : 0));
      }
      runEffect(st, caster, e, ctx, anchorsFor(e), depth, hits);
    }
    if (phase === 2) runShoves(st, ctx, depth);
    flushDeaths(st, depth);
    st.atk = prevAtk; st.csr = prevCsr; st.cast = prevCast;
  }
  // The push phase: every shove the cast's push effects collected, resolved in
  // waves so several of them in one cast do not walk through each other.
  function runShoves(st, ctx, depth) {
    const shoves = ctx.shoves;
    ctx.shoves = [];
    if (!shoves.length) return;
    const maxDist = shoves.reduce((m, s) => Math.max(m, s.dist), 0);
    const posOf = (e) => (e instanceof Entity ? e.pos : e.k);
    const shovable = (e) => e.hp > 0 || (e.isUnit && e.downed);
    const stepOne = (s) => {
      s.pending = false;
      if (!shovable(s.ent)) { s.stopped = true; return; }
      const from = posOf(s.ent);
      st.cast.onCrash = s.onCrash;
      sPush(st, s.ent, s.dir, depth);
      st.cast.onCrash = null;
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
          if (wave.some((o) => o !== s && o.pending && shovable(o.ent) && posOf(o.ent) === nk)) continue;
          stepOne(s); moved = true;
        }
        if (!moved || guard++ > wave.length + 2) for (const s of wave) if (s.pending) stepOne(s);
      }
    }
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
  // `cap` overrides the budget (Infinity = every reachable tile, used by walked()).
  // ROOTED: a status with agency 'rooted', or a rooting tile tag under the
  // unit (a web). No walking at all this activation.
  // `B` is the board to read (default the real one): the enemy threat preview
  // (enemyThreat) measures on a simulated board, the one the selected unit
  // will find once the locks before it in the order have fired.
  const rooted = (u, B = sb) => !!agencyLost(u, 'rooted') || !!(B.tags[u.pos] && B.tags[u.pos].roots && !(B.tags[u.pos].hp > 0));
  function reach(u, fromK = u.pos, cap, B = sb) {
    const fly = flies(u);
    const hard = new Set(), soft = new Set();
    if (cap === undefined && rooted(u, B) && fromK === u.pos) return { d: { [fromK]: 0 }, prev: {}, occ: soft };
    for (const o of B.units) {
      if (o === u || o.uid === u.uid) continue;
      // A downed body can be walked THROUGH by anyone, either side's body,
      // but not stopped on (since 2026-10-07; until then it was a wall to a walker).
      if (o.downed) { soft.add(o.pos); continue; }
      if (o.hp <= 0) continue;
      ((!fly && o.isEnemy !== u.isEnemy) ? hard : soft).add(o.pos);
    }
    for (const k in B.tags) { if (B.tags[k].hp > 0) (fly ? soft : hard).add(k); }
    // An object that blocks stands like a barrier: a wall to a walker, a
    // no-stopping tile to a flier.
    for (const o of B.objects) { if (o.blocks(u)) (fly ? soft : hard).add(o.pos); }
    const sbH = (k) => B.heights[k] ?? 0;
    const spd = cap !== undefined ? cap : moveBudget(u);
    const d = { [fromK]: 0 }, prev = {};
    const pq = [[0, fromK]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]); const [dd, k] = pq.shift();
      if (dd > d[k]) continue;
      for (const dir of DIRS) {
        const nk = addK(k, dir);
        if (!tilePass(nk) || hard.has(nk)) continue;
        const dh = sbH(nk) - sbH(k);
        if (!fly && Math.abs(dh) > 1) continue;
        const nd = dd + (fly ? 1 : (dh > 0 ? 2 : 1));
        if (nd > spd) continue;
        if (nd < (d[nk] ?? 1e9)) { d[nk] = nd; prev[nk] = k; pq.push([nd, nk]); }
      }
    }
    return { d, prev, occ: soft };
  }
  const canStop = (res, k) => res.d[k] !== undefined && !res.occ.has(k);
  function approachField(u, from = null) {
    const hard = new Set();
    const fly = flies(u);
    if (!fly) {
      for (const k in sb.tags) if (sb.tags[k].hp > 0) hard.add(k);
      for (const o of sb.objects) if (o.blocks(u)) hard.add(o.pos);
      // (Downed bodies are walked through, so they are no wall here either.)
    }
    const d = {}, pq = [];
    // Towards the party - or, under a Taunt, towards whoever taunted it.
    for (const p of (from ?? alive(!u.isEnemy))) { d[p.pos] = 0; pq.push([0, p.pos]); }
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]); const [dd, k] = pq.shift();
      if (dd > d[k]) continue;
      for (const dir of DIRS) {
        const nk = addK(k, dir);
        if (!tilePass(nk) || hard.has(nk)) continue;
        const dh = sbH(k) - sbH(nk);
        if (!fly && Math.abs(dh) > 1) continue;
        const nd = dd + (fly ? 1 : (dh > 0 ? 2 : 1));
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
    if (flies(u)) return false;
    const t = sb.tags[k];
    if (!t || !t.collectible || !t.passPickup || t.hp > 0) return false;
    const st = liveSt(); sArrive(st, u); flushDeaths(st);
    emit();
    return u.hp <= 0 || !!agencyLost(u, 'stunned') || u.pos !== k;
  }
  // Hands the walk to the view: it animates and reports each tile entered.
  // Tiles between where the unit started its activation and where it stands,
  // along the cheapest route (a walk the player re-aims is measured from the
  // start, like its price). The `tilesTravelled` fact.
  function stepsFrom(u) {
    if (!u || !u.startPos || u.pos === u.startPos) return 0;
    const p = pathTo(reach(u, u.startPos, Infinity), u.startPos, u.pos);
    return p ? p.length - 1 : hexDist(u.startPos, u.pos);
  }
  // The walk's tile count is the `tilesTravelled` fact and fires the 'moved'
  // moment when the walk is over (a trap that stopped it short counts what
  // was walked).
  function animateMove(u, path, done) {
    if (!path || path.length < 2) { if (path && path.length) u.pos = path[path.length - 1]; done && done(); return; }
    sb.busy = true;
    const fly = flies(u);
    const finish = () => {
      if (u.isUnit) { u.steps = stepsFrom(u); fireMoment(liveSt(), u, 'moved'); }
      done && done();
    };
    const anim = {
      u, path: fly ? [path[0], path[path.length - 1]] : path, fly,
      enter: (k) => { u.pos = k; return passTrap(u, k); },   // true = stop the walk here
    };
    if (onAnim) onAnim(anim, finish);
    else { u.pos = path[path.length - 1]; finish(); }   // headless fallback (tests)
  }

  // ----- aiming ----------------------------------------------------------
  // What an ability's effects say about aiming: its dash (if any), the tiles
  // its hits / heals / statuses cover (for the aim aliases and the preview).
  const dashOf = (ab) => (ab && ab.effects ? ab.effects.find((e) => e.kind === 'dash') : null);
  const hitEffects = (ab) => (ab && ab.effects ? ab.effects.filter((e) => ['damage', 'heal', 'status', 'push', 'throw', 'swap'].includes(e.kind) && e.anchor === 'aim' && e.targets !== 'self' && e.zone) : []);
  const damageEffects = (ab) => (ab && ab.effects ? ab.effects.filter((e) => e.kind === 'damage') : []);
  // Is this tile something a dash can STAND on? Terrain only - a unit does not
  // disqualify it, because the whole point of a charging shove is to aim AT the
  // target and ram it out of the way. Whether that works is settled at
  // resolution (dashLanding), by which time the shove has happened.
  const dashTileOk = (k) => { if (!tilePass(k)) return false; const t = sb.tags[k]; return !(t && t.hp > 0); };
  // Can a dash be AIMED here? The destination must be stand-on-able AND the way
  // to it must be CLEAR: a charge is a run across the floor, not a teleport.
  // Everything strictly between the caster and the aim point has to be empty
  // ground; only the aim point itself may be occupied. A dash `through`
  // allies lets friends stand in the way.
  function dashAimOk(c, k, through = false) {
    if (!dashTileOk(k)) return false;
    const line = hexLine(c.pos, k);
    for (let i = 1; i < line.length - 1; i++) {
      const mid = line[i];
      if (!dashTileOk(mid)) return false;
      const o = unitAt(mid) || bodyAt(mid);
      if (o && o.uid !== c.uid && !(through && o.hp > 0 && o.isEnemy === c.isEnemy)) return false;
    }
    return true;
  }
  // Where a dash actually ENDS, given the board as it stands after the rest of
  // the cast. The caster walks the line towards the aim point and takes the
  // furthest tile it can stand on, stopping in front of the first thing in the
  // way (passing allies when `through`). Its own tile means it never left.
  function dashLanding(st, caster, targetK, through = false) {
    const line = hexLine(caster.pos, targetK);
    let last = caster.pos;
    for (let i = 1; i < line.length; i++) {
      const k = line[i];
      if (!tilePass(k)) break;
      const t = st.tags[k];
      if (t && t.hp > 0) break;                       // a solid tag blocks like a wall
      if (sObjectAt(st, k)) break;                    // so does an object
      if (sBodyAt(st, k)) break;                      // and a downed body
      const o = sUnitAt(st, k);
      if (o && o.uid !== caster.uid) {
        if (through && o.isEnemy === caster.isEnemy) continue;   // an ally is run past, never landed on
        break;                                                   // someone is still standing there
      }
      last = k;
    }
    return last;
  }
  function buildAim(c, ab) {
    const targets = new Set();
    const anchors = new Set();
    const dsh = dashOf(ab);
    const ok = (k) => !dsh || dashAimOk(c, k, dsh.through === 'allies');
    if (ab.castAny) for (const t of activeTiles()) { if (!ok(t)) continue; targets.add(t); anchors.add(t); }
    else for (const off of ab.castZone) {
      const t = addK(c.pos, off);
      if (!inMap(t) || !ok(t)) continue;
      anchors.add(t);
      if (tilePass(t)) targets.add(t);
    }
    const map = {};
    for (const t of targets) map[t] = t;
    // The zone ALIASES below let you click any tile a rotatable ability would
    // cover and have it aim at the castZone tile that covers it - you point at the
    // enemy you mean to skewer, not at the empty tile in front of you.
    // A DASH is excluded: for a charge the aim point is also where the caster ends
    // up, so an alias would light up a tile the unit is not going to.
    if (ab.rotatable && !dsh) {
      for (const t of anchors) {
        const rk = abRotFor(ab, c.pos, t);
        for (const e of hitEffects(ab)) for (const off of e.zone) {
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
  //  * WHERE the zones fall is read straight off the effects, with the same
  //    anchor, rotation and tilePass filter resolveCast uses.
  //  * WHAT MOVES (shoves, throws, swaps, where a charge ends up) is read back
  //    from playing the cast out on a COPY of the board - the same machinery
  //    the enemy AI uses. Nothing here touches the real board.
  function aimPreview(k) {
    if (!sb.selAb || !sb.aimMap || sb.aimMap[k] === undefined) return null;
    const c = curP(); if (!c) return null;
    const ab = abFor(c, sb.selAb); if (!ab) return null;
    const anchor = sb.aimMap[k];
    const rk = abRotFor(ab, c.pos, anchor);
    const zone = (effs) => {
      const out = [];
      for (const e of effs) for (const off of e.zone ?? []) {
        const dt = addK(anchor, rotOff([off[0], off[1]], rk));
        if (tilePass(dt) && !out.includes(dt)) out.push(dt);
      }
      return out;
    };
    const height = [];
    for (const e of ab.effects.filter((x) => x.kind === 'height' && x.anchor === 'aim')) {
      const n = qty(e.amount, castCtx(liveSt(), c, ab, [anchor]));
      for (const off of e.zone ?? [[0, 0]]) {
        const dt = addK(anchor, rotOff([off[0], off[1]], rk));
        if (!tilePass(dt)) continue;
        const h0 = sb.heights[dt] ?? 0;
        const to = Math.max(0, Math.min(CFG.elevationLevels, e.mode === 'abs' ? n : h0 + n));
        height.push({ k: dt, from: h0, to });
      }
    }
    // Play it out on a copy. `blind: null` - the preview is for the PLAYER.
    const st = simSt(null);
    const se = st.units.find((u) => u.uid === c.uid);
    let push = [];
    let dash = null;
    if (se) {
      const before = new Map(st.units.map((u) => [u.uid, u.pos]));
      resolveCast(st, se, ab, [anchor]);
      for (const u of st.units) {
        if (u.uid === c.uid) continue;
        const from = before.get(u.uid);
        if (from !== undefined && u.pos !== from) push.push({ uid: u.uid, from, to: u.pos });
      }
      if (se.pos !== c.pos) dash = se.pos;
    }
    // What the hit tiles MEAN, so the view can colour them by consequence.
    const kinds = ab.effects.map((e) => e.kind);
    const kind = kinds.includes('damage') ? 'damage' : kinds.includes('heal') ? 'heal' : kinds.includes('status') ? 'buff' : 'none';
    const dsh = dashOf(ab);
    return {
      anchor, kind,
      hit: zone(hitEffects(ab)),
      tag: zone(ab.effects.filter((e) => e.kind === 'tag' && e.anchor === 'aim' && tagDefById(e.tag))),
      push, height, dash,
      // True when the charge stops short of what it was aimed at.
      dashShort: !!(dsh && dash && dash !== anchor),
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
    clearInspect();   // a new round, a fresh board
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) {
      u.done = false; u.moveLocked = false; u.startPos = u.pos; u.tagTicked = false; u.movePaid = 0; u.lock = null; u.steps = 0; u.extraAttacks = 0;
    }
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) { u.tagTicked = true; tickStatuses(u); tagTick(u); }
    if (checkEnd()) return;
    // A STUNNED unit sits its turn out (its clock runs down at the end of the
    // phase like any other). A CONFUSED one is out of the player's hands: the
    // engine walks it and fires it at random when the volley goes (fireLocks).
    for (const u of sb.units) {
      if (u.isEnemy || u.hp <= 0) continue;
      const id = agencyLost(u, 'stunned') || agencyLost(u, 'confused');
      if (!id) continue;
      const view = statusView(u, id);
      u.done = true;
      floater(u.pos, view.icon, view.color);
    }
    const first = sb.units.find((u) => !u.isEnemy && u.hp > 0 && !u.done);
    if (first) select(first);
    // Nobody left to play but a confused unit or two: the volley still goes,
    // so the engine gets to play them (fireLocks) before the enemy moves.
    else if (sb.units.some((u) => !u.isEnemy && u.hp > 0 && agencyLost(u, 'confused') && !agencyLost(u, 'stunned'))) { emit(); endTurn(); }
    else { emit(); startEnemyPhase(); }
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

  // ----- the ENEMY THREAT preview (hovering the enemy roster) -------------
  // Enemies are not selectable (since 2026-10-07). Hovering an enemy's card
  // shows where it could walk on its turn; hovering one of its abilities shows
  // every tile that ability could hit from anywhere it could walk to. Both are
  // measured on the board AS THE SELECTED UNIT WILL FIND IT - the standing
  // locks of the units before it in the firing order played out on a copy, as
  // the overhead cards are (simulateVolley's `before`) - so a Slug, a stun or a
  // shove an earlier unit lands is already in it. Nobody selected: after the
  // whole volley. A readout only: no rule reads it, the selection is untouched.
  //   sb.inspectUid    the enemy previewed
  //   sb.inspectReach  { d, occ } on that board (null when its ability is hovered)
  //   sb.inspectFrom   the tile it stands on there
  //   sb.inspectHits   [tiles] the hovered ability could hit (null for the card)
  function boardBeforeSelected() {
    const st = simSt(null);
    if (!CFG.lockedAim) return st;
    st.overlap = {};
    const c = curP();
    for (const u of orderedParty()) {
      if (c && u.uid === c.uid) break;
      if (u.hp <= 0 || !u.lock) continue;
      const ab = abFor(u, u.lock.abId);
      const se = st.units.find((x) => x.uid === u.uid);
      if (!ab || !se || se.hp <= 0) continue;
      resolveCast(st, se, ab, u.lock.anchors);
      flushDeaths(st);
    }
    return st;
  }
  // { from, reach: { d, occ }, stops: [tiles], hits: [tiles] | null } or null
  // when the enemy is not standing on that board (down, gone, fled).
  function enemyThreat(uid, abId = null) {
    const st = boardBeforeSelected();
    const se = st.units.find((u) => u.uid === uid && u.isEnemy);
    if (!se || se.hp <= 0) return null;
    // Its own fresh activation: the whole speed (statuses included), nothing
    // paid yet. A stun or a root keeps it where it is; a stun or a disarm
    // means it casts nothing.
    const stunned = !!agencyLost(se, 'stunned');
    const cap = stunned || rooted(se, st) ? 0 : effSpeed(se);
    const res = reach(se, se.pos, cap, st);
    const stops = Object.keys(res.d).filter((k) => k === se.pos || !res.occ.has(k));
    let hits = null;
    if (abId) {
      hits = [];
      const ab = abFor(se, abId);
      const silenced = stunned || !!agencyLost(se, 'disarmed') || (ab?.tags ?? []).some((tg) => statusListed(se, 'forbids', tg));
      if (ab && !silenced) {
        const moveCost = costOf(se, ab).move || 0;
        const seen = new Set();
        for (const startK of stops) {
          if (moveCost > 0 && (res.d[startK] || 0) + moveCost > cap) continue;
          if (ab.castAny && startK !== se.pos) continue;
          const anchors = ab.castAny ? activeTiles() : ab.castZone.map((off) => addK(startK, off));
          for (const t of anchors) {
            if (!inMap(t)) continue;
            for (const k of zoneTiles(ab, startK, [t]).tiles) seen.add(k);
          }
        }
        hits = [...seen];
      }
    }
    return { from: se.pos, reach: res, stops, hits };
  }
  // The roster's hover lands here. `abId` null = the card itself (movement).
  function previewEnemy(uid, abId = null) {
    if (sb.over || sb.phase !== 'player') return false;
    const th = enemyThreat(uid, abId);
    if (!th) { if (clearInspect()) emit(); return false; }
    sb.inspectUid = uid;
    sb.inspectFrom = th.from;
    sb.inspectReach = abId ? null : th.reach;
    sb.inspectHits = abId ? th.hits : null;
    sb.inspectAb = abId;
    emit();
    return true;
  }
  function clearEnemyPreview() { if (clearInspect()) emit(); }
  function clearInspect() {
    if (sb.inspectUid == null) return false;
    sb.inspectUid = null; sb.inspectReach = null; sb.inspectHits = null; sb.inspectFrom = null; sb.inspectAb = null;
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
    clearInspect();   // the board moved; the readout is stale
    if (sb.over) return;
    const next = sb.units.find((x) => !x.isEnemy && x.hp > 0 && !x.done);
    if (next) select(next);
    else { sb.activeUid = null; emit(); startEnemyPhase(); }
  }
  // A unit that can no longer act (killed or stunned by a trap mid-walk).
  function retireUnit(u) {
    const skip = statusListed(u, 'agency', 'stunned');
    if (skip) dropStatus(liveSt(), u, skip, false);
    u.done = true;
    if (sb.over) return;
    const next = sb.units.find((x) => !x.isEnemy && x.hp > 0 && !x.done);
    if (next) select(next);
    else { sb.activeUid = null; emit(); startEnemyPhase(); }
  }
  function startEnemyPhase() {
    // The party's activations are over: clocks count down, activation-spent
    // statuses go (see endActivation).
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) endActivation(u);
    sb.phase = 'enemy'; sb.activeUid = null; sb.selAb = null; sb.aimMap = null; sb.reach = null;
    clearInspect();
    sb.enemyQ = sb.units.filter((u) => u.isEnemy && u.hp > 0).sort((a, b) => b.init - a.init || a.idx - b.idx);
    // An enemy's movement budget is its own each activation, exactly as a party
    // member's is each round (startPlayerPhase). `startPos` is where the walk is
    // measured from (walked / moveLeft), so it is reset here too - the enemy AI
    // walks and casts within one activation, and an ability's move cost has to
    // see the walk that just happened.
    for (const u of sb.enemyQ) { u.movePaid = 0; u.startPos = u.pos; u.steps = 0; u.extraAttacks = 0; }
    sb.eqi = -1; emit();
    stepEnemy();
  }
  function stepEnemy() {
    if (sb.over) return;
    // The enemy before this one has finished its activation (see endActivation).
    if (sb.eqi >= 0 && sb.enemyQ[sb.eqi]) endActivation(sb.enemyQ[sb.eqi]);
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
    const skipId = agencyLost(e, 'stunned');
    if (skipId) {
      const view = statusView(e, skipId);
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
    // sb.ambush only ever labels round 1 (the battle bar reads "Ambush!" there
    // instead of "Round 1" - see ui.js): the player still opens even a forced
    // fight, so there is no separate opening phase to end it after any more.
    if (sb.ambush) sb.ambush = false;
    startPlayerPhase();
  }
  function checkEnd() {
    if (sb.over) return true;
    // An encounter's own end condition (the Hack: its progress bar, its turn
    // budget) replaces the last-side-standing rule entirely.
    if (rules && rules.checkEnd) {
      const r = rules.checkEnd(sb);
      if (r) { gameOver(r === 'win'); return true; }
      return false;
    }
    if (!alive(true).length) { gameOver(true); return true; }
    if (!alive(false).length) { gameOver(false); return true; }
    return false;
  }
  function gameOver(won) {
    sb.over = won ? 'win' : 'lose';
    sb.selAb = null; sb.aimMap = null; sb.reach = null; sb.activeUid = null;
    for (const u of sb.units) u.lock = null;
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
  // What an ability on a tile tag would do to whoever stands there, in damage
  // units: its hits less its heals, plus the harm of the statuses it applies.
  function abilityHarm(ab) {
    let n = 0;
    const ctx = { fact: () => 0 };
    for (const e of ab.effects ?? []) {
      if (e.kind === 'damage') n += qty(e.amount, ctx) * Math.max(1, qty(e.times, ctx));
      else if (e.kind === 'heal') n -= qty(e.amount, ctx);
      else if (e.kind === 'status') n += statusHarm(e.status) / 10;
    }
    return n;
  }
  // A random pick, through the fight's own rng so a seeded fight replays.
  const pick = (list) => (list.length ? list[Math.min(list.length - 1, Math.floor(rng() * list.length))] : null);
  // A CONFUSED unit's turn: any reachable tile, any affordable ability, any
  // legal aim - friend or foe. Returns { tile, ab, anchor } (ab null = only walks).
  function confusedPlan(u, res) {
    const tiles = Object.keys(res.d).filter((k) => k === u.pos || canStop(res, k));
    const tile = pick(tiles) || u.pos;
    const options = [];
    for (const abId of u.abilityIds) {
      const ab = abFor(u, abId);
      if (!ab || !canAfford(u, ab)) continue;
      const from = { pos: tile, uid: u.uid, isEnemy: u.isEnemy };
      const dsh = dashOf(ab);
      const tl = ab.castAny ? activeTiles() : ab.castZone.map((off) => addK(tile, off));
      for (const t of tl) {
        if (!inMap(t) || !tilePass(t)) continue;
        if (dsh && t !== tile && !dashAimOk(from, t, dsh.through === 'allies')) continue;
        // Something to cast AT: a unit on the aim tile or on a hit tile.
        const rk = abRotFor(ab, tile, t);
        const covers = hitEffects(ab).some((e) => effectTiles(liveSt(), u, ab, e, t, rk).some((dt) => unitAt(dt) && unitAt(dt).uid !== u.uid));
        if (covers) options.push({ ab, anchor: t });
      }
    }
    const o = pick(options);
    return { tile, ab: o ? o.ab : null, anchor: o ? o.anchor : null };
  }
  // `stay` = the unit has already walked this activation (an extra attack): it
  // casts from where it stands.
  function aiTurn(e, stay = false) {
    if (sb.over || e.hp <= 0) { sb.busy = false; if (!sb.over) stepEnemy(); return; }
    // Breaking off comes before any thought of attacking.
    if (!stay && rollFlee(e)) { fleeTurn(e); return; }
    const res = stay ? { d: { [e.pos]: 0 }, prev: {}, occ: new Set() } : reach(e);
    const mind = mindOf(e);              // what this creature is able to weigh
    const blind = blindfold(mind);
    const live = new Map(sb.units.map((u) => [u.uid, u]));
    const flat = CFG.blindStatusValue ?? 8;
    // The DIRECTIVES its statuses put on its mind (config/statuses.js `ai`).
    const must = directive(liveSt(), e, 'mustTarget');         // Taunt: only casts that reach this unit
    const avoid = directive(liveSt(), e, 'avoidAdjacentTo');   // Fear: never ends next to this unit
    const friend = directive(liveSt(), e, 'friend');           // Charm: this unit counts as an ally
    const confused = !!agencyLost(e, 'confused');
    const castDone = (ab) => {
      commitCast(e, ab);
      emit();
      // An attack it is owed (a killing blow with Follow-through): once more,
      // from where it stands.
      if (e.extraAttacks > 0 && e.hp > 0 && !sb.over) { e.extraAttacks = 0; wait(() => aiTurn(e, true), 550); return; }
      wait(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 550);
    };
    if (confused) {
      const plan = confusedPlan(e, res);
      const path = pathTo(res, e.pos, plan.tile) || [e.pos];
      animateMove(e, path, () => {
        sArrive(liveSt(), e); flushDeaths(liveSt());
        emit();
        wait(() => {
          if (sb.over) { sb.busy = false; return; }
          if (e.hp <= 0 || !plan.ab || e.pos !== plan.tile || !canAfford(e, plan.ab)) { wait(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 300); return; }
          payCost(e, plan.ab);
          resolveCast(liveSt(), e, plan.ab, [plan.anchor]);
          castDone(plan.ab);
        }, 300);
      });
      return;
    }
    // What standing on this tile is worth, in DAMAGE units (the callers scale it).
    // Only a mind that weighs tags ever asks: the tick it does while you stand
    // on it (`dmg` / `heal`), and whatever its hooks CAST on whoever is there.
    const tagHarm = (k) => {
      const t = sb.tags[k];
      if (!t || t.hp > 0) return 0;
      let n = (t.dmg || 0) - (t.heal || 0);
      for (const hook of ['onPeriodic', 'onPickup', 'onExpire', 'onDestroy']) {
        const ab = t[hook] ? abById(t[hook]) : null;
        if (ab) n += abilityHarm(ab);
      }
      return n;
    };
    // Whose side a unit is on, in this creature's eyes.
    const allyLike = (u) => u.isEnemy || (friend && u.uid === friend.uid);
    let best = null;
    for (const abId of e.abilityIds) {
      const ab = abFor(e, abId); if (!ab) continue;
      // Nothing to think about without an effect; nor one it cannot pay for -
      // otherwise the enemy picks it and the cast is refused at the last moment.
      if (!(ab.effects && ab.effects.length)) continue;
      if (!canAfford(e, ab)) continue;
      // A move cost is paid out of the same points the walk uses.
      const moveCost = costOf(e, ab).move;
      const dsh = dashOf(ab);
      for (const startK of Object.keys(res.d)) {
        if (startK !== e.pos && !canStop(res, startK)) continue;
        if (moveCost > 0 && (res.d[startK] || 0) + moveCost > moveBudget(e)) continue;
        if (ab.castAny && startK !== e.pos) continue;
        const tlist = ab.castAny ? activeTiles() : ab.castZone.map((off) => addK(startK, off));
        const walk = pathTo(res, e.pos, startK);
        const steps = walk ? walk.length - 1 : 0;
        for (const t of tlist) {
          if (!inMap(t)) continue;
          if (dsh && t !== startK && !dashAimOk({ pos: startK, uid: e.uid, isEnemy: true }, t, dsh.through === 'allies')) continue;
          const st = simSt(blind);
          const se = st.units.find((u) => u.uid === e.uid);
          se.pos = startK; se.steps = steps;
          resolveCast(st, se, ab, [t]);
          let score = 0;
          let touchedMust = false;
          for (const u of st.units) {
            const d = st.rec.dmg[u.uid] || 0;
            const was = live.get(u.uid);
            if (must && u.uid === must.uid && (d || st.rec.applied[u.uid] || st.rec.moved[u.uid])) touchedMust = true;
            // ----- statuses: a mind that READS them uses the table's aiValue (as
            // harm) and weighs the target; one that cannot still knows friend
            // from foe and applies them at a flat worth.
            let sv = 0;
            for (const id of Object.keys(st.rec.applied[u.uid] || {})) {
              const v = statusHarm(id);           // <0 = a good thing to carry
              if (!mind.statuses) { sv += (v < 0 ? -1 : 1) * flat; continue; }
              const already = was && statusHas(was, id) ? 0.15 : 1;
              sv += v * already * statusNeed(u, was, v);
            }
            for (const id of Object.keys(st.rec.stripped[u.uid] || {})) {
              const v = statusHarm(id);
              sv += mind.statuses ? -v : (v < 0 ? 1 : -1) * flat;
            }
            // ----- injuries: finishing the wounded rather than spreading damage --
            const killBonus = mind.injuries ? (allyLike(u) ? 40 : 45) : 0;
            const focus = mind.injuries && was && was.maxHp
              ? d * 5 * Math.max(0, 1 - Math.max(0, was.hp) / was.maxHp) : 0;
            // ----- tile tags: a fire is a place to shove someone into, and a place
            // not to stand. One rule covers both ends of it.
            const harm = mind.tags ? tagHarm(u.pos) * 8 : 0;
            // ----- DOWN BUT NOT OUT: getting a downed body back up is worth what
            // putting it down was (the heal it took already counts through d).
            const revive = st.rec.revived[u.uid] ? (killBonus || 20) : 0;
            if (!allyLike(u)) score += d * 10 + (st.rec.killed[u.uid] ? killBonus : 0) + sv + focus + harm - revive;
            else score -= d * 9 + (st.rec.killed[u.uid] ? killBonus : 0) + sv + harm - revive;
          }
          // The directives: a Taunt makes any cast that misses its source
          // worthless; a Fear makes standing next to its source a bad idea.
          if (must && !touchedMust) score -= 1000;
          if (avoid && hexDist(startK, avoid.pos) <= 1) score -= 60;
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
          const hitId = agencyLost(e, 'stunned');
          if (e.hp <= 0 || hitId || e.pos !== best.startK) {
            if (e.hp > 0 && hitId) { const v = statusView(e, hitId); floater(e.pos, v.icon, v.color); }
            emit();
            wait(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 450);
            return;
          }
          // The walk to startK may have cost it the price (a trap took the hp);
          // an enemy that can no longer pay simply does not cast.
          if (!canAfford(e, best.ab)) {
            emit();
            wait(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 300);
            return;
          }
          payCost(e, best.ab);
          resolveCast(liveSt(), e, best.ab, [best.t]);
          castDone(best.ab);
        }, 300);
      });
      return;
    }
    if (stay) { wait(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 300); return; }
    const players = alive(false).filter((p) => !(friend && p.uid === friend.uid));
    if (players.length) {
      const fld = approachField(e, must ? [must] : players);
      let bestK = e.pos, bs = 1e9;
      for (const k of Object.keys(res.d)) {
        if (k !== e.pos && !canStop(res, k)) continue;
        const td = fld[k] !== undefined ? fld[k] : 1000 + Math.min(...players.map((p) => hexDist(k, p.pos)));
        // Nothing worth casting, so it walks. Closing the distance comes first;
        // what it does with the tiles that are equally close is where the mind
        // shows (height, tags). A feared unit counts a tile next to its
        // tormentor as three tiles further.
        const burn = mind.tags ? tagHarm(k) : 0;
        const climb = mind.elevation ? -sbH(k) : 0;
        const dread = avoid && hexDist(k, avoid.pos) <= 1 ? 3 : 0;
        const sc = (td + burn + dread) * 100 + climb * 10 + res.d[k];
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
    // unit back up. Enemies are not selectable (since 2026-10-07): the roster's
    // hover previews them instead (previewEnemy).
    if (!c) {
      if (uu && !uu.isEnemy && !uu.done) { clearInspect(); select(uu); }
      return;
    }
    // An enemy is never a move target - unless an ability is aimed at it,
    // which the aim map below handles. Without one, a click on it does nothing.
    if (!sb.selAb && uu && uu.isEnemy) return;
    if (!sb.selAb && uu && !uu.isEnemy && uu.uid !== c.uid && !uu.done) { clearInspect(); select(uu); return; }
    if (sb.selAb) {
      const ab = abFor(c, sb.selAb);
      const target = ab && sb.aimMap ? sb.aimMap[k] : null;
      if (target != null) {
        // Re-checked here and not only at selection: the board can move between
        // picking an ability and clicking a tile (a trap, a status ticking).
        if (!canAfford(c, ab)) { sb.selAb = null; sb.aimMap = null; emit(); return; }
        // AIM LOCK: nothing fires yet - End turn does (fireLocks).
        if (CFG.lockedAim) { lockAim(c, ab, target); return; }
        sb.busy = true;
        sb.selAb = null; sb.aimMap = null;
        payCost(c, ab);
        resolveCast(liveSt(), c, ab, [target]);
        commitCast(c, ab);
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
        // RANGE is measured from the round's starting tile (res), but the walk
        // itself goes from where the unit stands NOW: the shortest route from
        // here, falling back to the start's route only if nothing connects.
        if (!pathTo(res, c.startPos, k)) return;
        const here = reach(c, c.pos, Infinity);
        const path = pathTo(here, c.pos, k) || pathTo(res, c.startPos, k);
        if (!path) return;
        sb.reach = null;
        // A walk takes the unit's locked aim back: the pattern was measured
        // from where it stood.
        if (c.lock) { c.lock = null; blog(c.name + ' takes the aim back'); }
        animateMove(c, path, () => {
          sb.busy = false;
          sArrive(liveSt(), c); flushDeaths(liveSt());
          if (checkEnd()) return;
          if (c.hp <= 0 || agencyLost(c, 'stunned')) { retireUnit(c); return; }
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
      if (!canAfford(c, ab)) return;   // the HUD greys it out too; this is the rule
      sb.selAb = abId; sb.aimMap = buildAim(c, ab);
    }
    emit();
  }
  // Ends the WHOLE party's turn at once. With aim locks on, this is also the
  // moment every locked ability fires - and, when a killing blow earned
  // someone another attack, the moment the phase re-opens for them alone.
  function endTurn() {
    if (sb.phase !== 'player' || sb.busy || sb.over) return;
    sb.activeUid = null; sb.selAb = null; sb.aimMap = null; sb.reach = null;
    if (CFG.lockedAim) {
      sb.busy = true;
      // sb.firing: the volley is on its way - the arena's forecast (locks, ghosts,
      // the cards) stands down for it, but NOT for a mere walk (also `busy`).
      sb.firing = true;
      emit();
      fireLocks((fired) => {
        for (const u of sb.units) if (!u.isEnemy && u.hp > 0) u.done = true;
        // EXTRA ATTACKS: the units owed one get their turn back - no walking,
        // just an aim - and the phase waits for the next End turn.
        const owed = sb.units.filter((u) => !u.isEnemy && u.hp > 0 && u.extraAttacks > 0 && !agencyLost(u, 'stunned') && !agencyLost(u, 'confused'));
        if (owed.length && !sb.over) {
          for (const u of owed) { u.extraAttacks = 0; u.done = false; u.moveLocked = true; u.lock = null; }
          sb.busy = false; sb.firing = false;
          blog(owed.map((u) => u.name).join(', ') + ' may attack again');
          select(owed[0]);
          return;
        }
        emit();
        // A beat so the last blow is seen landing before the enemy moves.
        wait(() => { sb.busy = false; sb.firing = false; if (checkEnd()) return; startEnemyPhase(); }, fired ? 500 : 0);
      });
      return;
    }
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) u.done = true;
    emit();
    startEnemyPhase();
  }

  // ----- AIM LOCKS (config.combat.lockedAim) ---------------------------------
  // OVERLAP BONUS (config.combat.stack.bonusPerOverlap): an ability adds
  // bonus x (what the damaging abilities that hit the hex BEFORE it in the
  // volley granted - 1 each, more with Synergy / overlapGrant) to its BASE
  // damage there. The volley's `st.overlap` ledger ({ tile -> grants so far })
  // is what the damage effect reads and writes.
  const overlapBonus = (prior) => Math.max(0, prior) * (CFG.stack?.bonusPerOverlap ?? 1);
  // The tiles a cast from `fromK` aimed at `anchors` would cover with its hits.
  function zoneTiles(ab, fromK, anchors) {
    const list = Array.isArray(anchors) ? anchors : [anchors];
    const out = [];
    let rk = 0;
    for (const anchor of list) {
      rk = abRotFor(ab, fromK, anchor);
      for (const e of hitEffects(ab)) for (const off of e.zone) {
        const dt = addK(anchor, rotOff([off[0], off[1]], rk));
        if (tilePass(dt) && !out.includes(dt)) out.push(dt);
      }
    }
    return { rk, tiles: out };
  }
  // Lock a unit's aim. An ability with several AIMS collects one anchor per
  // click until it has them all (clicking a tile twice takes it back out);
  // re-aiming a complete lock starts a fresh one. The unit STAYS selected.
  function lockAim(c, ab, anchor) {
    const aims = Math.max(1, ab.aims || 1);
    let anchors;
    if (c.lock && c.lock.abId === sb.selAb && c.lock.anchors.length < aims) {
      anchors = c.lock.anchors.includes(anchor) ? c.lock.anchors.filter((a) => a !== anchor) : [...c.lock.anchors, anchor];
      if (!anchors.length) { c.lock = null; refreshReach(); emit(); return; }
    } else anchors = [anchor];
    const { rk, tiles } = zoneTiles(ab, c.pos, anchors);
    c.lock = { abId: sb.selAb, abName: ab.name, icon: ab.icon, anchors, anchor: anchors[0], rk, tiles, aims };
    const complete = anchors.length >= aims;
    if (complete) { sb.selAb = null; sb.aimMap = null; }
    floater(anchor, '🔒 ' + ab.name + (aims > 1 ? ` ${anchors.length}/${aims}` : ''), '#ffd166');
    blog(c.name + ' locks ' + ab.name + (aims > 1 ? ` (${anchors.length} of ${aims} aims)` : ''));
    refreshReach(); emit();
  }
  // RESET PARTY (the party panel's button): every aim lock taken back and every
  // unit put back on the tile it started the round on - the whole player phase
  // laid out so far, undone in one go. Nothing has fired and nothing has been
  // paid yet, so a reset is exact.
  function resetParty() {
    if (sb.over || sb.busy || sb.phase !== 'player') return false;
    sb.selAb = null; sb.aimMap = null;
    for (const u of sb.units) {
      if (u.isEnemy || u.hp <= 0) continue;
      u.lock = null;
      if (!u.done && !u.moveLocked && u.startPos && u.pos !== u.startPos) { u.pos = u.startPos; u.steps = 0; }
    }
    blog('The party resets its turn');
    refreshReach();
    emit();
    return true;
  }
  // The party panel's card pressed: select that unit, as a click on its body
  // in the arena would. Any ability being aimed is put down first.
  function selectUnit(uid) {
    if (sb.over || sb.busy || sb.phase !== 'player') return false;
    const u = sb.units.find((x) => x.uid === uid && !x.isEnemy && x.hp > 0 && !x.done);
    if (!u) return false;
    if (u.uid === sb.activeUid && !sb.selAb) return true;
    clearInspect();
    select(u);
    return true;
  }
  // The party in FIRING order: sb.fireOrder first (the panel's card order),
  // then anyone the order does not name, by spawn index.
  function orderedParty() {
    const party = sb.units.filter((u) => !u.isEnemy);
    const byUid = new Map(party.map((u) => [u.uid, u]));
    const out = [];
    for (const uid of sb.fireOrder) { const u = byUid.get(uid); if (u && !out.includes(u)) out.push(u); }
    for (const u of party.sort((a, b) => a.idx - b.idx)) if (!out.includes(u)) out.push(u);
    return out;
  }
  // The panel's drag-and-drop lands here: a new firing order (party uids).
  function setFireOrder(uids) {
    if (sb.over || sb.phase !== 'player' || sb.busy) return false;
    const valid = new Set(sb.units.filter((u) => !u.isEnemy).map((u) => u.uid));
    const next = [];
    for (const uid of uids ?? []) if (valid.has(uid) && !next.includes(uid)) next.push(uid);
    for (const u of orderedParty()) if (!next.includes(u.uid)) next.push(u.uid);
    sb.fireOrder = next;
    emit();
    return true;
  }
  sb.fireOrder = orderedParty().map((u) => u.uid);
  // A CONFUSED party unit is played by the engine the moment the volley goes:
  // it walks somewhere at random and locks a random ability at a random unit,
  // and then fires in its place in the order like everyone else.
  function confuseParty() {
    for (const u of sb.units) {
      if (u.isEnemy || u.hp <= 0 || !agencyLost(u, 'confused') || agencyLost(u, 'stunned')) continue;
      const plan = confusedPlan(u, reach(u, u.startPos));
      if (plan.tile !== u.pos) { u.pos = plan.tile; u.steps = stepsFrom(u); sArrive(liveSt(), u); flushDeaths(liveSt()); fireMoment(liveSt(), u, 'moved'); }
      u.lock = null;
      if (plan.ab && u.hp > 0) {
        const { rk, tiles } = zoneTiles(plan.ab, u.pos, [plan.anchor]);
        u.lock = { abId: plan.ab.id, abName: plan.ab.name, icon: plan.ab.icon, anchors: [plan.anchor], anchor: plan.anchor, rk, tiles, aims: 1 };
        floater(u.pos, '❓ ' + plan.ab.name, '#c9a8ff');
        blog(u.name + ' is confused and lashes out at random');
      }
    }
  }
  // End turn: every lock fires, one after another in sb.fireOrder with
  // combat.volleyStepMs between them; a later blow on a hex an earlier one hit
  // gets the overlap bonus (st.overlap). `done(fired)` runs after the last one.
  function fireLocks(done) {
    confuseParty();
    const locks = orderedParty().filter((u) => u.hp > 0 && u.lock);
    const st = liveSt();
    st.overlap = {};
    let fired = 0, i = 0;
    const finish = () => {
      st.overlap = null;
      for (const u of locks) u.lock = null;
      if (rules && rules.onTurnFired) rules.onTurnFired(sb, { fired });
      done && done(fired);
    };
    const step = () => {
      // Only an OUTSIDE event ends a fight mid-volley (a debug win/loss, say):
      // this volley's own kills never do - every unit that locked an ability
      // this turn still gets to fire, in fireOrder, before checkEnd() is asked.
      if (sb.over) { finish(); return; }
      let cast = false;
      while (i < locks.length && !cast) {
        const u = locks[i++];
        const lock = u.lock; u.lock = null;
        if (u.hp <= 0 || !lock) continue;
        const ab = abFor(u, lock.abId); if (!ab) continue;
        if (!canAfford(u, ab)) { floater(u.pos, '✕ ' + ab.name, '#9aa7bd'); blog(u.name + ' cannot pay for ' + ab.name); continue; }
        sb.activeUid = u.uid;   // the HUD and the arena show whose blow this is
        payCost(u, ab);
        resolveCast(st, u, ab, lock.anchors);
        commitCast(u, ab);
        flushDeaths(st);
        fired++; cast = true;
      }
      if (!cast) { sb.activeUid = null; finish(); return; }
      emit();
      wait(step, i < locks.length ? (CFG.volleyStepMs ?? 450) : 0);
    };
    step();
  }
  // How hard `u`'s main hit would land on tile `dt` right now, before
  // stacking: the same base + height + Strong/Weak arithmetic the damage
  // effect applies. For the preview. (Per HIT - `times` and the overlap bonus
  // come on top.) Returns { dmg, times }.
  function nominalDamage(u, ab, dt, anchor = dt) {
    const e = damageEffects(ab)[0];
    if (!e) return { dmg: 0, times: 0 };
    const ctx = castCtx(liveSt(), u, ab, [anchor]);
    const v = unitAt(dt);
    const tctx = v ? ctx.withTarget(v) : ctx;
    let dmg = qty(e.amount, tctx) + dmgMod(u) + statusSum(u, 'damageDealt') + qty(e.lifesteal, tctx) + statusSum(u, 'lifesteal');
    if (v) {
      const hd = sbH(u.pos) - sbH(dt);
      if (hd >= 2 && CFG.highBonus > 0) dmg += CFG.highBonus;
      else if (hd <= -2 && CFG.lowPenalty > 0) dmg = Math.max(0, dmg - CFG.lowPenalty);
    }
    const mul = qty(e.multiplier, tctx);
    if (mul !== 1) dmg = Math.round(dmg * mul);
    return { dmg: Math.max(0, dmg), times: Math.max(1, Math.round(qty(e.times, tctx))) };
  }
  // The volley as it would go NOW - the standing locks plus the aim under the
  // cursor (which stands in for the hovering unit's own lock) - played out on
  // a copy of the board in firing order. Shared by previewTotals / previewMoves
  // / previewState. `before` is the board as the SELECTED unit finds it.
  function simulateVolley(hoverKey = null) {
    if (!CFG.lockedAim) return null;
    const c = curP();
    const hovering = !!(hoverKey && sb.selAb && sb.aimMap && sb.aimMap[hoverKey] !== undefined && c);
    const casts = [];
    const order = orderedParty();
    const cIdx = c ? order.indexOf(c) : -1;
    for (const u of order) {
      if (u.hp <= 0) continue;
      if (hovering && u.uid === c.uid) {
        const ab = abFor(c, sb.selAb);
        // A partial multi-aim lock plus the hovered tile.
        const prior = c.lock && c.lock.abId === sb.selAb && c.lock.anchors.length < (ab?.aims || 1) ? c.lock.anchors : [];
        if (ab) casts.push({ u: c, ab, anchors: [...prior.filter((a) => a !== sb.aimMap[hoverKey]), sb.aimMap[hoverKey]], pending: true });
        continue;
      }
      if (!u.lock) continue;
      const ab = abFor(u, u.lock.abId);
      if (ab) casts.push({ u, ab, anchors: u.lock.anchors, pending: false });
    }
    if (!casts.length) return null;
    const per = CFG.stack?.bonusPerOverlap ?? 1;
    const tiles = new Map();
    for (const cst of casts) {
      const { tiles: zone } = zoneTiles(cst.ab, cst.u.pos, cst.anchors);
      const damaging = damageEffects(cst.ab).length > 0;
      for (const dt of zone) {
        const e = tiles.get(dt) ?? { parts: [], n: 0, covers: 0, pending: false };
        e.covers++;   // every ability covering the tile, damaging or not
        if (damaging) {
          // In cast order, so e.n is how many damaging abilities hit the hex before this one.
          const nd = nominalDamage(cst.u, cst.ab, dt, cst.anchors[0]);
          e.parts.push({ uid: cst.u.uid, name: cst.u.name, abName: cst.ab.name, dmg: nd.dmg, times: nd.times, bonus: e.n * per });
          e.n++;
        }
        e.pending = e.pending || cst.pending;
        tiles.set(dt, e);
      }
    }
    // Play the volley out on a copy for the actual result.
    const st = simSt(null);
    st.overlap = {};
    const snapshot = () => Object.fromEntries([...st.units, ...st.objects].map((x) => [x.uid, { pos: x.pos, hp: x.hp }]));
    let before = null;
    for (const cst of casts) {
      if (!before && cIdx >= 0 && order.indexOf(cst.u) >= cIdx) before = snapshot();
      const se = st.units.find((x) => x.uid === cst.u.uid);
      if (!se || se.hp <= 0) continue;
      resolveCast(st, se, cst.ab, cst.anchors);
      flushDeaths(st);
    }
    if (!before) before = snapshot();   // the selected unit fires last, or nobody is selected
    return { casts, tiles, st, before };
  }
  // THE BOARD AS THE SELECTED UNIT SEES IT, and as the volley leaves it - what
  // the overhead cards show while the player aims:
  //   { before: { uid -> { pos, hp } }, after: { uid -> { pos, hp, dead } } }
  function previewState(hoverKey = null) {
    const sim = simulateVolley(hoverKey);
    if (!sim) return null;
    const after = {};
    for (const x of [...sim.st.units, ...sim.st.objects]) after[x.uid] = { pos: x.pos, hp: x.hp, dead: x.hp <= 0 };
    return { before: sim.before, after };
  }
  // THE DAMAGE PRE-CALCULATION, per tile the standing locks cover (plus the
  // aim under the cursor): { n, covers, bonus, parts, raw, total, dealt,
  // over, target, kind, pending, note? }. The tests and the rules read it.
  function previewTotals(hoverKey = null) {
    const out = new Map();
    const sim = simulateVolley(hoverKey);
    if (!sim) return out;
    const { tiles, st } = sim;
    for (const [k, e] of tiles) {
      for (const p of e.parts) p.total = (p.dmg + p.bonus) * p.times;
      const bonus = e.parts.reduce((s, p) => s + p.bonus * p.times, 0);
      const raw = e.parts.reduce((s, p) => s + p.dmg * p.times, 0);
      const total = e.parts.reduce((s, p) => s + p.total, 0);
      const unit = unitAt(k);
      const obj = objectAt(k);
      const tag = sb.tags[k];
      let target = null, dealt = 0, over = 0;
      if (unit) {
        const su = st.units.find((x) => x.uid === unit.uid);
        dealt = Math.max(0, unit.hp - (su ? su.hp : 0));
        over = Math.max(0, total - unit.hp);
        target = { kind: unit.isEnemy ? 'enemy' : 'party', name: unit.name, uid: unit.uid, hp: unit.hp, maxHp: unit.maxHp, blocked: statusSum(unit, 'damageTaken') < 0 };
      } else if (obj) {
        const so = st.objects.find((x) => x.uid === obj.uid);
        dealt = Math.max(0, obj.hp - (so ? so.hp : 0));
        over = Math.max(0, total - obj.hp);
        target = { kind: 'object', name: obj.name, uid: obj.uid, hp: obj.hp, maxHp: obj.maxHp, ent: obj };
      } else if (tag && tag.hp > 0) {
        const stt = st.tags[k];
        dealt = tag.hp - (stt && stt.tid === tag.tid ? stt.hp : 0);
        over = Math.max(0, total - tag.hp);
        target = { kind: 'barrier', name: tag.name, tid: tag.tid, hp: tag.hp, maxHp: tag.maxHp, tagKind: tag.kind ?? tag.defId };
      } else if (tag) target = { kind: 'hazard', name: tag.name, tid: tag.tid, tagKind: tag.kind ?? tag.defId };
      const entry = { k, n: e.n, covers: e.covers, bonus, parts: e.parts, raw, total, dealt, over, target, kind: target ? target.kind : 'ground', pending: e.pending };
      if (rules && rules.decoratePreview) rules.decoratePreview(entry, sb);
      out.set(k, entry);
    }
    return out;
  }
  // EVERYTHING THAT ENDS UP SOMEWHERE ELSE when the volley fires: every unit
  // and every barrier whose tile changes, or that dies, in the play-out.
  function previewMoves(hoverKey = null) {
    const sim = simulateVolley(hoverKey);
    if (!sim) return [];
    const { st } = sim;
    const out = [];
    for (const u of sb.units) {
      if (u.hp <= 0 && !u.downed) continue;   // a downed body can be shoved too
      const su = st.units.find((x) => x.uid === u.uid);
      if (!su) continue;
      const dead = su.hp <= 0;
      if (su.pos === u.pos && !dead) continue;
      out.push({ kind: 'unit', uid: u.uid, name: u.name, icon: u.icon ?? null, isEnemy: !!u.isEnemy, from: u.pos, to: su.pos, dead, voided: !!(st.rec && st.rec.voided[u.uid]) });
    }
    for (const o of sb.objects) {
      if (!o.alive) continue;
      const so = st.objects.find((x) => x.uid === o.uid);
      if (!so || so.pos === o.pos) continue;
      out.push({ kind: 'object', uid: o.uid, name: o.name, icon: o.icon ?? null, from: o.pos, to: so.pos, dead: !so.alive, destroyed: !so.alive, voided: false });
    }
    const after = new Map();
    for (const k of Object.keys(st.tags)) after.set(st.tags[k].tid, k);
    for (const k of Object.keys(sb.tags)) {
      const t = sb.tags[k];
      if (!(t.hp > 0)) continue;   // hazards never move; a barrier can be shoved or broken
      const to = after.get(t.tid);
      const destroyed = to === undefined;
      if (!destroyed && to === k) continue;
      out.push({ kind: 'barrier', tid: t.tid, name: t.name, icon: t.icon ?? null, from: k, to: destroyed ? k : to, destroyed });
    }
    return out;
  }

  // Test / debug helper: decide the battle instantly.
  function debugResolve(won) {
    if (sb.over) return;
    if (rules && rules.debugResolve) { rules.debugResolve(sb, won); checkEnd(); return; }
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
  // The 'battleStart' moment fires once, here, before either side has moved, so
  // it lands the same way whether the fight opens normally or with an ambush.
  // A forced fight used to open with an extra enemy phase before round 1 (the
  // enemy struck before the party could act at all); the player now always
  // opens the fight, forced or not - only the "Ambush!" round-1 label (sb.ambush)
  // still marks that this one was forced.
  function start() {
    if (opened) return;
    opened = true;
    { const st = liveSt(); for (const u of sb.units) fireMoment(st, u, 'battleStart'); }
    startPlayerPhase();
  }
  if (deferOpening && sb.ambush) emit();   // the bar reads "Ambush!" while it waits
  else start();

  return {
    state: sb,
    start,
    clickTile, selectAbility, endTurn, cancel, resetParty,
    // The enemy threat preview (the roster's hover): previewEnemy(uid, abId?)
    // draws it, clearEnemyPreview() takes it down, enemyThreat() just reports.
    // `inspect` is the old name, kept for the tools.
    previewEnemy, clearEnemyPreview, enemyThreat, inspect: (uid) => previewEnemy(uid),
    selectUnit, activate: selectUnit,
    abilityById: abById,
    aimPreview,
    abilityFor: abFor,   // (unit, id) - the unit's UPGRADED def where it has one
    // What an ability costs THIS unit right now (its cost quantities read
    // against the unit), and whether it can pay. The HUD uses both: the cost
    // badge on the button, and '' / 'hp' / 'move' / 'supplies' / 'disarmed' /
    // 'forbidden' to grey it out and say why.
    costOf,
    shortOf,
    // A quantity of this unit's ability, as it stands right now (the HUD's
    // numbers move with the facts: stacks, tiles walked, the target hovered).
    evalFor: (u, ab, q, anchor = null) => qty(q, castCtx(liveSt(), u, ab, anchor ? [anchor] : null)),
    stacksOf: (u) => ({ stacks: u.stacks || 0, max: stackMaxOf(u), gen: stackGenOf(u) }),
    moveBudget,
    moveLeft,            // movement points still unspent this activation (walk included)
    supplies: () => (supplies ? supplies.get() : null),   // the run's supplies, for the battle bar
    curPlayer: curP,
    reachFor: () => sb.reach,
    debugResolve,
    // AIM LOCKS: the damage pre-calculation and who has aimed (config.combat.lockedAim).
    previewTotals,
    previewMoves,
    previewState,
    lockedUnits: () => sb.units.filter((u) => !u.isEnemy && u.hp > 0 && u.lock),
    overlapBonus,        // (priorHits) -> the extra base damage on a hex hit that many times already
    // The firing order (party uids) and the party in that order.
    setFireOrder,
    fireOrder: () => sb.fireOrder.slice(),
    orderedParty,
  };
}

// =====================================================================
//  THE HACK'S RULES (the Hack terminal, config.hack; since 2026-09-24 part
//  of this file). A `rules` object for createBattle - it reads the public
//  state and nothing of the engine's insides, exactly as any encounter's
//  rules would: the TURN BUDGET, the BADGE GRADING and the count of nodes.
//    attach(sb)                                       the state, before play
//    onTurnFired(sb, summary)                         the party's locks all fired
//    checkEnd(sb) -> 'win' | 'lose' | null            replaces last-side-standing
//    decoratePreview(entry, sb)                       a note on a previewTotals entry
//    debugResolve(sb, won)                            the menu's instant win
//  The NODES and MINES themselves are Entity classes (entity.js): what a
//  blow does to a node, what a mine costs the caster, is theirs. A node tells
//  these rules when it goes down (its onCleared callback, wired by main.js
//  to nodeCleared), and the badges follow.
//    * Every node brought to 0 hp counts as CLEARED. The badges (H.badges)
//      light up as the cleared count reaches each threshold.
//    * The encounter ends by itself after the H.turns-th volley: a WIN with
//      as many reward options as badges earned, a LOSS (no reward) with none.
//      Clearing every node on the board ends it early, as a win.
// =====================================================================
export function createHackRules(H, { onFloater } = {}) {
  let sb = null;
  const floater = (k, text, color) => onFloater && onFloater(k, text, color);
  const x = () => sb.ext.hack;
  const badgesFor = (cleared) => H.badges.filter((t) => cleared >= t).length;
  const nodesOf = (state) => state.objects.filter((o) => o instanceof HackNode);

  const rules = {
    // The rules' own state lives on the engine's state (sb.ext.hack), where
    // the view can read it.
    attach(state) {
      sb = state;
      sb.ext.hack = {
        turns: H.turns,
        cleared: 0,              // nodes brought down
        badges: 0,               // badges earned so far (thresholds in H.badges)
        total: nodesOf(state).length,   // nodes the board started with
        lastTurn: null,          // { round, cleared } of the volley just fired
        firedRound: 0,           // the round whose volley fired last
        turnCleared: 0,
      };
    },
    // A node went down (HackNode.onDeath -> its onCleared; the bridge wires
    // it to this). Real deaths only: a simulation's copy dies quietly.
    nodeCleared(node, ctx) {
      if (!sb || (ctx && ctx.sim) || node.counted) return;
      node.counted = true;
      const h = x();
      h.cleared++; h.turnCleared++;
      const before = h.badges;
      h.badges = badgesFor(h.cleared);
      floater(node.pos, `node ${h.cleared}${h.badges > before ? ` - badge ${h.badges}!` : ''}`, h.badges > before ? '#ffd166' : '#8fe0b8');
    },
    onTurnFired(state) {
      const h = x();
      h.firedRound = state.round;
      h.lastTurn = { round: state.round, cleared: h.turnCleared };
      h.turnCleared = 0;
    },
    checkEnd(state) {
      const h = state.ext.hack;
      if (!h) return null;
      const nodesLeft = nodesOf(state).some((n) => n.alive);
      if (h.firedRound >= H.turns || (!nodesLeft && h.firedRound > 0)) return h.badges > 0 ? 'win' : 'lose';
      return null;
    },
    // A previewTotals entry over a mine: what it costs the caster. (Nothing
    // draws it since the damage billboards went on 2026-09-22; the tests read it.)
    decoratePreview(entry) {
      const t = entry.target;
      if (t && t.kind === 'object' && t.ent instanceof HackMine) entry.note = { text: `-${t.ent.damage} hp`, color: '#ff5d73' };
    },
    debugResolve(state, won) {
      const h = state.ext.hack;
      h.cleared = won ? Math.max(...H.badges) : 0;
      h.badges = badgesFor(h.cleared);
      h.firedRound = H.turns;
    },
  };
  return rules;
}
