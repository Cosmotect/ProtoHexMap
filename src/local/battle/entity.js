// =====================================================================
//  ENTITY and UNIT - what stands on the board.                (2026-09-24)
//
//  An ENTITY is any potentially interactive object on the arena's board: it
//  has a tile, a name, hit points, and a handful of hooks the combat engine
//  calls without knowing what the thing is - can it be walked through, can it
//  be shoved, what happens when it is hit, when it dies, when a unit tries to
//  use it. The base class answers those in the plainest way (it blocks its
//  tile, it cannot be pushed, damage simply comes off its hp, it does nothing
//  when used), and an object with rules of its own is a SUBCLASS that
//  overrides what it needs: the Hack's node that only ever loses one hp per
//  attack and its mine that costs the caster (the bottom of this file),
//  or - later - a door that opens when used, a barrel that rolls when shoved
//  and leaves fire when it bursts, an emitter that turns when used and lasers
//  the receptacle it faces. None of that touches the engine or the config: an
//  encounter constructs its objects and hands them to createBattle as
//  `entities`, and the engine treats them through this interface alone.
//
//  A UNIT is an entity WITH AGENCY: what the player and the enemy AI control.
//  It carries the fighting stats (speed, flying, abilities, initiative,
//  intellect), the status bag and the triggers, the aim lock, and the
//  per-round bookkeeping of a turn (startPos, movePaid, done...). The rules
//  that read those - statuses, walking, casting, the AI - stay in the engine
//  (local/battle/engine.js), since they lean on the config tables and on the
//  rest of the board; what lives here is what a unit IS: its construction
//  from a def, its copy for a simulation, and its answers to the entity hooks.
//
//  Simulations: the AI and the forecast play casts out on a COPY of the
//  board. `clone()` is how each entity is copied - shallow, with the status
//  bag copied one level deep for a unit - so a subclass with mutable state of
//  its own overrides it.
//
//  The hooks (`ctx` is { st, sim, caster, floater, log }; st is the board the
//  hit happens on - the real one or a simulation's copy, `sim` says which):
//    blocks(mover)             true = a walker cannot enter or pass its tile
//                              (a flier glides over everything but a unit
//                              of the other side - the engine adds that rule).
//    pushable                  true = a shove moves it (crash / fall / crush
//                              and the void apply as to a unit).
//    takeDamage(amt, ctx)      the blow lands: returns what it actually lost.
//                              The base takes it all; `died` is true after.
//    onDeath(ctx)              hp reached 0 through takeDamage or a fall.
//    interact(unit, ctx)       a unit uses it (a door, a lever). false = it
//                              cannot be used; nothing wires this to input
//                              yet - the hook is the promise.
// =====================================================================
import { checkTrigger } from '../../config/abilities.js';
import { combatStatsFor } from '../../config/entities.js';

let nextUid = 0;

export class Entity {
  constructor({ uid = null, name = 'Object', icon = null, color = null, pos = null, hp = 1, maxHp = null } = {}) {
    this.uid = uid ?? 'o' + (nextUid++);
    this.name = name;
    this.icon = icon;
    this.color = color;
    this.pos = pos;
    this.hp = hp;
    this.maxHp = maxHp ?? hp;
  }
  // What it is, for code that must tell the two apart cheaply (the engine's
  // `v.isUnit` reads this rather than instanceof, so a copy stays one).
  get isUnit() { return false; }
  get alive() { return this.hp > 0; }
  // ----- the hooks (see the header) --------------------------------------
  blocks(mover) { return this.alive; }   // eslint-disable-line no-unused-vars
  get pushable() { return false; }
  takeDamage(amt, ctx) {   // eslint-disable-line no-unused-vars
    if (!this.alive || !(amt > 0)) return 0;
    const dealt = Math.min(amt, this.hp);
    this.hp -= dealt;
    return dealt;
  }
  onDeath(ctx) {}   // eslint-disable-line no-unused-vars
  interact(unit, ctx) { return false; }   // eslint-disable-line no-unused-vars
  // A copy for a simulation: same class, same fields, shared nothing that a
  // cast could write (a subclass with a nested object of its own copies it).
  clone() {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
  }
}

// A def is a plain description - a party member from game state, a bestiary
// row through makeEnemyOfType, a hand-authored scenario line - and the
// definition wins where it has an opinion: a bestiary row carries its own
// init / speed / flying / abilities (config/entities.js), so a creature
// invented in the Settings window fights as written instead of falling
// through to party.defaultCombat, the nameless fallback. The party, and any
// older hand-authored def, still reads the table by name.
export class Unit extends Entity {
  constructor(def, { isEnemy = false, pos = null, idx = 0 } = {}) {
    const cs = combatStatsFor(def.name);
    super({ uid: 's' + idx, name: def.name, icon: def.icon ?? null, color: def.color ?? null, pos, hp: def.hp, maxHp: def.maxHp ?? def.hp });
    this.isEnemy = isEnemy;
    this.idx = idx;
    this.partyIndex = def.partyIndex ?? null;
    this.typeId = def.typeId ?? null;   // the bestiary id it was made from (enemies)
    // Enemies only: the enemy queue sorts by it. Party rows carry no init
    // (removed 2026-09-06), so a character lands on 0 and nothing reads it.
    this.init = def.init ?? cs.init ?? 0;
    this.speed = def.speed ?? cs.speed;
    this.flying = !!(def.flying ?? cs.flying);
    this.abilityIds = [...(def.abilityIds?.length ? def.abilityIds : cs.abilities)];
    this.abilityDefs = def.abilityDefs ?? null;
    // TRIGGERS the unit walked in with, as [{ statusEffect, when, statusEffectOverride }]: a party
    // unit's from triggersFor in src/upgrades.js (already parsed), an enemy's
    // straight off its bestiary row (still as written - parsed here, so the
    // two arrive in one shape). Fixed for this fight: none of the sources can
    // change during one, and the set is worked out afresh when the next fight
    // starts. Each fires at its moment (the engine's fireMoment) and from then
    // on the status sits in `status` below like any other - nothing reads this
    // list for a rule, only for the moments.
    this.triggers = (def.triggers ?? []).map((e) => checkTrigger(e)).filter(Boolean);
    // The LOCKED aim (the lockedAim flow): { abId, anchor, rk, tiles } or null.
    this.lock = null;
    // The turn's bookkeeping (see the engine's startPlayerPhase / clickTile).
    this.startPos = pos; this.moveLocked = false; this.done = false; this.tagTicked = false;
    // Movement points already spent on ABILITY COSTS this round. Walking is
    // not counted here: a walk is re-measured from startPos every time and can
    // be taken back, so it has no running total to keep. This is the part that
    // cannot be taken back, and it comes off the budget (see moveBudget).
    this.movePaid = 0;
    this.status = {};
    this.summoned = false;
    this.fled = false;
    // INTELLECT CLASS (config.intellect): which facts this creature can weigh on
    // its turn. Anything hand-authored without one is treated as the dimmest.
    this.intellect = def.intellect ?? 'C';
  }
  get isUnit() { return true; }
  // A unit occupies its tile for everyone who walks; who may pass through whom
  // (a flier over anything, a friend through a friend) is the engine's rule.
  blocks(mover) { return this.alive; }   // eslint-disable-line no-unused-vars
  get pushable() { return true; }
  // A unit's blow is the engine's business (blocks, damageTaken statuses, the
  // 'hit' moment, the death report): it calls this only for the arithmetic.
  takeDamage(amt, ctx) { return super.takeDamage(amt, ctx); }
  // The copy a simulation plays on: the whole status bag, copied one level
  // deep - forgetting this is what used to make the AI simulate a board it
  // could not actually see. The triggers are shared (never written), so a
  // 'hit' moment fires in the simulation exactly as it would on the real board.
  clone() {
    const c = super.clone();
    c.status = Object.fromEntries(Object.entries(this.status || {}).map(([id, v]) => [id, { ...v }]));
    return c;
  }
}

// =====================================================================
//  THE HACK'S PIECES (the Hack terminal, config.hack; since 2026-09-24 part
//  of this file). The NODE and the MINE are the first objects with rules of
//  their own: main.js builds them from the recipe (localmap.js
//  buildHackRecipe) and hands them to createBattle as `entities`. A node
//  variant with rules of its own (one that bursts, one that heals its
//  neighbours, one that must be hit twice in one volley) is another subclass
//  here, overriding what it needs.
// =====================================================================

// A node: `hp` discs tall, and every ATTACK that lands on it takes exactly
// ONE - whatever the attack is worth, however many times it hits. Each blow
// is its own takeDamage call, so the node remembers the cast (ctx.cast, one
// token per resolved ability) its last disc went to and ignores that cast's
// further blows. Brought to 0 it counts as cleared (onCleared -> the rules).
export class HackNode extends Entity {
  constructor({ pos, hp, name = 'Node', icon = '🔷', color = '#5fc7e0', onCleared = null }) {
    super({ name, icon, color, pos, hp });
    this.onCleared = onCleared;
    this.paidFor = null;   // the cast token the last disc went to
  }
  get kind() { return 'hackNode'; }   // a name that survives minification (the tests read it)
  takeDamage(amt, ctx) {
    if (!this.alive || !(amt > 0)) return 0;
    const cast = ctx && ctx.cast ? ctx.cast : null;
    if (cast && this.paidFor === cast) return 0;
    this.paidFor = cast;
    this.hp -= 1;
    return 1;
  }
  onDeath(ctx) { if (this.onCleared) this.onCleared(this, ctx); }
}

// A mine: a blow on it costs the CASTER `damage` hp (never below 1 unless
// `lethal`), and the mine is spent - one blow, gone. In a simulation the
// caster is the simulation's copy, so the forecast on the caster's own card
// shows the cost before the turn is committed.
export class HackMine extends Entity {
  constructor({ pos, damage = 3, lethal = false, name = 'Mine', icon = '💣', color = '#ff5d73' }) {
    super({ name, icon, color, pos, hp: 1 });
    this.damage = damage;
    this.lethal = lethal;
  }
  get kind() { return 'hackMine'; }
  takeDamage(amt, ctx) {
    if (!this.alive || !(amt > 0)) return 0;
    const c = ctx && ctx.caster;
    if (c && c.isUnit && c.hp > 0 && this.damage > 0) {
      c.hp = Math.max(this.lethal ? 0 : 1, c.hp - this.damage);
      ctx.floater(c.pos, `-${this.damage} MINE`, '#ff5d73');
    }
    if (ctx) ctx.floater(this.pos, '💥', '#ff5d73');
    this.hp = 0;
    return 1;
  }
}

// =====================================================================
//  THE SHOP'S KEEPER (config.shop; since 2026-09-24). The first entity with
//  no hit points to speak of and no place in a fight: it stands on the tile
//  a shop's map code pinned with `@shopkeeper` and does one thing - USED
//  (clicked), it opens the shop window. It is an Entity and not a Unit
//  because it never moves and never acts; main.js's shop bridge builds it,
//  createShopView (localview.js) draws it and routes the click to
//  interact(), the first input the hook has had.
// =====================================================================
export class Shopkeeper extends Entity {
  constructor({ pos, name = 'Shopkeeper', icon = '🧔', color = '#45c7d1', onOpen = null }) {
    super({ name, icon, color, pos, hp: 1 });
    this.onOpen = onOpen;
  }
  get kind() { return 'shopkeeper'; }
  takeDamage() { return 0; }   // nothing in a shop hits anything, but the keeper is not for hitting
  interact(unit, ctx) {   // eslint-disable-line no-unused-vars
    if (this.onOpen) this.onOpen(this);
    return true;
  }
}
