// =====================================================================
//  ABILITIES, ABILITY UPGRADES AND STATUSES.

import { ringOffsets, lineOffsets, DIRS } from '../local/battle/bhex.js';

// ===================================ABILITIES===================================
//  An ability is DATA. There is no per-ability code anywhere: one executor
//  (`resolveCast` in local/battle/engine.js) reads the fields below and performs
//  them, always in this order, and the enemy AI judges a new ability by playing
//  that same executor out on a copy of the board. So anything expressible here
//  works in the game AND is understood by the AI the moment you write it.
//
//    name       Ability name as it shows up in-game.
//    desc       info about the ability that roster window and the ability
//               tooltips show.
//
//  ----- 1. WHERE IT CAN BE POINTED ------------------------------------
//    castZone   a LIST OF OFFSETS from the caster's tile: [[q, r], ...]. Any
//               shape at all - it is a plain list, not a formula. Two helpers
//               build the common ones (local/battle/bhex.js):
//                 ringOffsets(minD, maxD)  every tile at distance minD..maxD.
//                                          A BLOB: ringOffsets(1, 3) is 36 tiles.
//                 lineOffsets(minD, maxD)  only the six straight spokes out from
//                                          the caster. A STAR: lineOffsets(1, 3)
//                                          is 18 tiles, with nothing in between
//                                          the spokes. For anything that travels
//                                          in a straight line - a charge, a bolt.
//               Neither is special: `castZone: [[2, 0], [0, 2]]` is perfectly
//               legal if that is the shape you want.
//    castAny    true = ignore castZone and aim at any tile on the board.
//
//
//  ----- 2. WHAT IT DOES, in the order it happens ----------------------
//    dmgZone    offsets FROM THE AIM POINT that take the damage / heal / status.
//    damage     flat damage to every unit in dmgZone - a creature's whole
//               strength is this number now (no more enemy-only power bonus,
//               removed 2026-09-10). Height matters: 2+ levels above adds
//               combat.highBonus, 2+ below removes combat.lowPenalty.
//    heal       flat healing to every unit in dmgZone (applied after damage).
//    buff       the id of a status from STATUSES below, applied to every unit in
//               dmgZone; buffX is the list of numbers for that status's knobs
//               (see WHAT buffX MEANS, further down this file).
//    pushZone   [q, r, dirIndex, dist] - shove whoever stands on the offset [q, r]
//               from the aim point.
//                 dirIndex  which way, as an index into DIRS: 0 east, 1 north-east,
//                           2 north-west, 3 west, 4 south-west, 5 south-east. With
//                           `rotatable` these turn with the aim, so 0 reads as
//                           "away from the caster" and 3 as "towards the caster" -
//                           which is how you write a PULL.
//                 dist      1 or 2. ANYTHING ELSE IS CLAMPED TO 2 by the engine.
//               Shoves resolve in waves, so several of them in one cast do not
//               walk through each other. A shove into an occupied tile is a
//               collision (both take damage), into a wall a crash, off a lethal
//               edge or into ether a death.
//    hZone      [q, r, amount] - change the ground height at that offset.
//    hMode      'rel' = add `amount` to the height there, 'abs' = set it to
//               `amount`. Clamped to 0..combat.elevationLevels. Units standing
//               on the tile are not moved.
//    tagId      a tile tag from COMBAT_TAGS (config/entities.js) to leave behind...
//    tagZone    ...on these offsets from the aim point.
//    moveToTarget  the caster charges towards the aim point, LAST of all - after
//               its own damage, shoves and terrain changes have resolved. It
//               walks the straight line and takes the furthest tile it can stand
//               on, stopping in front of the first thing still in the way. So a
//               charge that rams its target out of the way lands on the tile the
//               target used to hold, and one whose shove was blocked pulls up
//               short of it. An occupied tile is a legal thing to aim at.
//    rotatable  true = every zone above (dmgZone, pushZone, hZone, tagZone) turns
//               to face the aim point, snapped to one of six 60-degree sectors.
//               Write the zones facing EAST and they will point wherever you aim.
//
//  ----- 3. WHAT IT COSTS TO CAST. --------------------------------------
//               Every entry is optional and defaults to 0.
//    hp         taken from the CASTER. It can never kill: a unit needs strictly
//               more hp than the cost, so the ability greys out at exactly the
//               cost rather than offering a suicide.
//    supplies   taken from the RUN's supplies, the same pool the world map
//               spends. Only the party has one - an enemy casts a supply-cost
//               ability for free (see canAfford in local/battle/engine.js).
//    move       movement points. The cost is BOTH a gate and a payment: the
//               caster must have that many points left this round, and casting
//               spends them, so a unit that could still walk 4 tiles can only
//               walk 2 after a move-2 cast. (Today a cast ends the unit's turn
//               anyway; the spending is what makes this work unchanged on the
//               day a unit is allowed to move afterwards.)
// ANY of them may be NEGATIVE, which GRANTS the resource instead of taking it,
// capped by whatever room there is: hp never passes maxHp, supplies never pass
// maxSupplies, move never passes the unit's speed for the round. A negative
// cost is never a gate - it is always affordable.
//    No ability can swap places with a unit, summon anything, or push further
//    than two tiles. Each of those needs engine work, not a config line.
//
// ----------------------------------DEFINITION-----------------------------------
const A = (o) => Object.assign({

  name: 'Ability', icon: '💥', color: '#5fc7e0', desc: '',
  damage: 0, heal: 0, buff: '', buffX: null,   // buffX null = "use the status's own values"
  castZone: [], castAny: false, dmgZone: [], tagZone: [], tagId: null,
  hZone: [], hMode: 'rel', pushZone: [], rotatable: false, moveToTarget: false,
  cost: { hp: 0, supplies: 0, move: 0 },
}, o);
// -------------------------------------TABLE-------------------------------------
export const ABILITIES = {
  //Enemy Abilities
  softeningBite: A({ name: 'Softening Bite', icon: '⚔️', color: '#e0b25f', buff: 'vulnerable', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  rageBite: A({ name: 'Enraging Bite', icon: '🤬', color: '#E84A27', buff: 'enraged', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  headbutt: A({ name: 'Headbutt', icon: '🐏', color: '#e0b25f', damage: 0, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  weakeningBite: A({ name: 'Weakening Bite', icon: '🩼', color: '#38D1AC', buff: 'weaken', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  lobbedShrapnelBurst: A({ name: 'Lobbed ShrapnelBurst', icon: '💥', color: '#ff9950', damage: 3, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1) }),
  swipe: A({ name: 'Swipe', icon: '💫', color: '#5fc7e0', damage: 5, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [-1, -1], [0, 1]], rotatable: true }),
  //strike
  //heavy strike
  //thundering strike
  lobbedNagentBurst: A({ name: 'Lobbed Nerve Agent', icon: '💥', color: '#ff9950', damage: 1, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1) }),
  //Razeing Antler Swipe
  chargeHeadbutt: A({ name: 'Charge Headbutt', icon: '🐏💨', color: '#e0b25f', damage: 2, castZone: lineOffsets(1, 3), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true, moveToTarget: true }),
  //Web

  //Player Abilities
  strike: A({ name: 'Strike', icon: '⚔️', color: '#e0b25f', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  shove: A({ name: 'Shove', icon: '🌀', color: '#ffd75f', damage: 1, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  volley: A({ name: 'Volley', icon: '🎯', color: '#a8e05f', damage: 2, castZone: ringOffsets(2, 4), dmgZone: [[0, 0]] }),
  lance: A({ name: 'Lance', icon: '⚡', color: '#5fc7e0', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [1, 0], [2, 0]], rotatable: true }),
  burst: A({ name: 'Ember Burst', icon: '🔥', color: '#ff9950', damage: 2, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1), tagZone: [[0, 0]], tagId: 'fire', cost: { move: 1 } }),
  bolt: A({ name: 'Bolt', icon: '☄️', color: '#c66dff', damage: 4, castZone: ringOffsets(1, 2), dmgZone: [[0, 0]], cost: { hp: 1 } }),
  mend: A({ name: 'Mend', icon: '🏥', color: '#a8e05f', heal: 4, castZone: ringOffsets(0, 1), dmgZone: [[0, 0]], cost: { supplies: 1 } }),
  guard: A({ name: 'Guard', icon: '🛡️', color: '#5fc7e0', buff: 'shield', castZone: ringOffsets(0, 1), dmgZone: [[0, 0]], cost: { hp: -1 } }),
  clawSwipe: A({ name: 'Claw Swipe', icon: '🔪', color: '#5fc7e0', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], rotatable: true })
};







// ==============================STATUSES AND PASSIVES===============================
//  A status is a certain termporary effect that modifies how aspects of combat
//  interact with the unit carrying the status effect.
//  Every status is built from one or more verbs which the engine knows how to
//  perform. New verbs must be added in code, new statuses are config only.
//
//  ----- what each building block does, exactly -----
//  EFFECTS (all optional; a status may combine several):
//    speed        added to the carrier's move points, signed. Negative = a slow.
//                 The floor at combat.minSpeed still applies, so a slow can never
//                 pin a unit in place. Read in effSpeed().
//    damageDealt  MULTIPLIER on damage the carrier deals (1 = no change, 2 =
//                 double, 0.5 = half). Applied where an ability's damage is
//                 computed, after the height bonus.
//    damageTaken  MULTIPLIER on damage the carrier receives. Applied in sHit(),
//                 so it covers ability damage, tile tags and crash damage alike.
//    blocks       true = the carrier ignores an incoming hit ENTIRELY (and a
//                 hostile push). One charge is spent per event blocked; within a
//                 single cast one charge covers the whole cast, so a wide
//                 ability cannot chew through a shield with its second tile.
//    skipsTurn    true = the carrier does not act on its activation. One charge
//                 is spent doing that.
//    tickDamage   damage dealt to the carrier at the start of its activation.
//    tickHeal     healing given to the carrier at the start of its activation.
//                 Both tick at exactly the same moment as a tile tag does.
//    ignoresImpactImpact kinds this row shrugs off:
//                'crash'(shoved into a wall or a body),
//                'fall' (shoved off a ledge),
//                'crush'(squashed between two things).
//                 Empty = takes them all like everyone else
//
//  LIFETIME (how the status ends - a status with neither is a non-expiring passive):
//    turns        How many of the carrier's turns it lasts. Counted down at the
//                 start of the turn, AFTER the tick damage / heal. 0 = no clock.
//    charges      How many times it may be spent before it ends (see spentOn).
//    spentOn      What spends a charge: 
//                 'hit'(something was blocked / taken),
//                 'attack' (the carrier cast a damaging ability),
//                 'activation' (the carrier's turn came up).
//                 '' = Permanent, aka a passive ability.
//
//                 A status with NO clock and an EMPTY spentOn can never be taken
//                 off - that is what makes it a permanent passive (Padded,
//                 Regenerating). A status with no clock and spentOn: 'cleanse'
//                 lasts until something cleanses it - an endless curse. Nothing
//                 else has to be declared: permanence is read off these fields.
//                 (No 'cleanse' event exists in the engine yet; when a cleansing
//                 ability arrives it is one spendStatus(st, u, 'cleanse') call.)
//
//  WHAT buffX MEANS - an ability's buffX is a LIST, one entry per knob:
//    A status's KNOBS are its numeric fields, always in this fixed order:
//        speed, damageDealt, damageTaken, tickDamage, tickHeal, turns, charges
//    ...narrowed to the ones THIS status actually uses - a knob counts as in use
//    when the row moved it off its neutral value (0 for the additive ones and the
//    counters, 1 for the two multipliers). statusKnobs(def) returns exactly that
//    list, and the Settings window prints it beside the row so it is never a guess.
//    An ability's `buffX` lines up with that list, in order:
//        buff: 'poison', buffX: [4]        4 damage a turn, for the table's 3 turns
//        buff: 'poison', buffX: [4, 5]     4 damage a turn, for 5 turns
//        buff: 'poison', buffX: [null, 5]  the table's 2 damage, for 5 turns
//        buff: 'poison'                    exactly what the table says
//    A bare number is shorthand for a one-entry list (buffX: 4 is buffX: [4]), and
//    null / an empty slot means "leave that knob as the table wrote it". Values
//    are used AS WRITTEN, sign and all: `slow` is speed -1 in the table, and an
//    ability that wants a harder slow says buffX: [-2].
//    The numbers an ability actually applied are remembered per unit, so two
//    sources of the same status do not have to agree.
//
//  THE ENEMY AI:
//    aiValue      how BAD carrying this status is, in the AI's own scoring units
//                 (a point of damage is 10, a kill 45). Positive = bad for
//                 whoever carries it, so the AI will try to inflict it on the
//                 party and avoid inflicting it on its own side; negative = a
//                 good thing to carry, so the AI hands it to allies and values
//                 stripping it off a party unit. Nothing else has to be taught:
//                 the AI already plays every candidate cast out on a copy of the
//                 board, so a status added here is scored from the next fight on.
//                 A penalty and a bonus are two ROWS, never one row with a sign,
//                 because a row has one aiValue and cannot be a blessing and a
//                 curse at once. That is why `haste` and `slow` are separate.
//
//  DISPLAY: `name` and `desc` are what the badge over a unit's head, the unit
//  card and the party view show - write them here and English needs no locale
//  entry. {n} in either is filled with the status's amount (its first knob, as
//  a size: a slow of -1 prints 1). A translation may still override them with
//  the locale keys status.<id>.name / status.<id>.desc (see statusInfo in
//  src/status.js). `icon` / `color` are the badge itself.
//
// ----------------------------------DEFINITION-----------------------------------
const S = (o) => Object.assign({
  name: 'Status', desc: '', icon: '⭐', color: '#9aa7bd',
  speed: 0, damageDealt: 1, damageTaken: 1, blocks: false, skipsTurn: false,
  tickDamage: 0, tickHeal: 0,
  ignoresImpact: [],
  turns: 0, charges: 0, spentOn: '',
  aiValue: 0,
}, o);

// Can nothing take this status off its unit? True when it has no clock and
// nothing spends it. `slot` is the unit's own copy ({ turns, charges, over }) when
// there is one - an ability may have given the row a clock through buffX. The
// unit card hides permanent rows from its status slots (the party view will list
// them instead); everything else about a permanent row is ordinary.
export function isPermanent(def, slot) {
  if (!def) return false;
  const turns = slot && slot.turns !== undefined ? slot.turns : def.turns;
  return !(turns > 0) && !def.spentOn;
}


// A status's KNOBS: its numeric fields, in this fixed order. An ability's buffX
// lines up with the ones a given status uses (see WHAT buffX MEANS above).
export const STATUS_KNOBS = ['speed', 'damageDealt', 'damageTaken', 'tickDamage', 'tickHeal', 'turns', 'charges'];
// The value each knob has when a status leaves it alone. The two multipliers rest
// at 1 (x1 changes nothing); everything else rests at 0.
const KNOB_NEUTRAL = { speed: 0, damageDealt: 1, damageTaken: 1, tickDamage: 0, tickHeal: 0, turns: 0, charges: 0 };
// Which knobs THIS status uses, in that order - the list an ability's buffX lines
// up with. Editing a status in the Settings window can change this list: give a
// status a tickDamage and it grows a knob, on the spot.
export function statusKnobs(def) {
  return def ? STATUS_KNOBS.filter((k) => Number(def[k] ?? KNOB_NEUTRAL[k]) !== KNOB_NEUTRAL[k]) : [];
}
// What an ability's buffX changes about a status: { field: value } for the knobs
// it actually named. A bare number counts as a one-entry list; null / '' / a
// non-number in a slot leaves that knob as the table wrote it; anything past the
// end of the knob list is ignored rather than guessed at.
export function statusOverridesFor(def, buffX) {
  const list = buffX === undefined || buffX === null || buffX === '' ? []
    : Array.isArray(buffX) ? buffX : [buffX];
  const knobs = statusKnobs(def);
  const out = {};
  for (let i = 0; i < list.length && i < knobs.length; i++) {
    const n = Number(list[i]);
    if (list[i] === null || list[i] === '' || !Number.isFinite(n)) continue;
    out[knobs[i]] = n;
  }
  return out;
}
// -------------------------------------TABLE-------------------------------------
export const STATUSES = {
  shield: S({
    name: 'Shield', icon: '🛡', color: '#5fc7e0',
    desc: 'Blocks the next hit or push entirely, then breaks.',
    blocks: true, charges: 1, spentOn: 'hit',
    aiValue: -14,
  }),
  crit: S({
    name: 'Charged', icon: '⚡', color: '#ffd75f',
    desc: 'The next damaging ability this unit casts hits every target critically.',
    damageDealt: 2, charges: 1, spentOn: 'attack',
    aiValue: -10,
  }),
  stun: S({
    name: 'Stunned', icon: '💫', color: '#c9a8ff',
    desc: 'Loses its next activation: no move, no ability.',
    skipsTurn: true, charges: 1, spentOn: 'activation',
    aiValue: 12,
  }),
  haste: S({
    name: 'Hastened', icon: '💨', color: '#a8e05f',
    desc: 'Moves {n} tiles further than usual.',
    speed: 1, turns: 2,
    aiValue: -6,
  }),
  slow: S({
    name: 'Slowed', icon: '🐌', color: '#c9a8ff',
    desc: 'Moves {n} tiles less than usual (never below the minimum speed).',
    speed: -1, turns: 2,
    aiValue: 9,
  }),
  poison: S({
    name: 'Poisoned', icon: '🧪', color: '#8fd14f',
    desc: 'Takes {n} damage at the start of each of its turns, then the poison fades.',
    tickDamage: 2, turns: 3,
    aiValue: 20,
  }),
  regen: S({
    name: 'Mending', icon: '🌿', color: '#a8e05f',
    desc: 'Heals {n} at the start of each of its turns.',
    tickHeal: 2, turns: 3,
    aiValue: -18,
  }),
  weaken: S({
    name: 'Weakened', icon: '🩼', color: '#b58fd1',
    desc: 'Deals half damage while it lasts.',
    damageDealt: 0.5, turns: 2,
    aiValue: 16,
  }),
  vulnerable: S({
    name: 'Vulnerable', icon: '🎯', color: '#e2474b',
    desc: 'Takes half again as much damage from everything while it lasts.',
    damageTaken: 1.5, turns: 2,
    aiValue: 18,
  }),
  enraged: S({
    name: 'Enraged', icon: '🤬', color: '#e2474b',
    desc: 'Hits half again as hard and moves 2 tiles further, for one turn.',
    damageDealt: 1.5, speed: 2, turns: 1,
    aiValue: -22,
  }),
};


// ----- PASSIVES ---------------------------------------------------------
//  A passive is a status the unit puts on ITSELF at a moment, without a cast.
//  That is the whole definition. It is not a second system: a passive names a
//  row of the table above, the engine applies that row with the very same
//  applyStatus a cast uses, and from then on it sits in the unit's status bag
//  like anything else. What happens next is the ROW's business:
//    * a row with no clock and an empty spentOn stays for the whole fight
//      (Padded, Regenerating) - the "always on" kind;
//    * a row with a clock wears off (Raging Entry gives `enraged`, one turn);
//    * a row with charges is spent by use ("starts every fight with a Shield"
//      is just `passives: ['shield']`).
//
//  WHERE a passive is written - all with the same list shape:
//    an upgrade node's `passives` (ABILITY_UPGRADES above), a bestiary row's
//    `passives` (config/entities.js), and later a relic's and a world-map aura's.
//    The set a party unit is under is worked out when a FIGHT STARTS (passivesFor
//    in src/upgrades.js) from what the unit IS right now, never stored on it, so
//    walking out of an aura's radius needs nobody to remember to remove anything.
//
//  HOW one is written - three forms, from the usual to the rare:
//    'regeneration'                    the status, at battle start
//    'enraged@hit'                     the status, at the moment after the @
//    { status, when, buffX }           the same with the row's knobs overridden
//                                      (buffX lines up with the row's knobs,
//                                      exactly as an ability's buffX does)
//  The two string forms are what the Settings window's list editor round-trips,
//  so prefer them; the object is for when a node needs its own numbers.
//
//  THE MOMENTS (`when`) the engine knows - each is one line in the engine at the
//  place the thing happens, so a new one is a new moment, not a new system:
//    'battleStart'  (default) once, before either side moves. The status goes on
//                   FRESH: its first tick is free, so a one-turn row is usable for
//                   exactly one turn whether the fight opens normally or with an
//                   ambush (see applyStatus in the engine).
//    'hit'          every time the carrier actually loses hp - an ability, a
//                   crash / fall / crush, a tile tag, a poison tick. A hit that
//                   a shield blocked is not a hit. Re-applying a row the unit
//                   already carries refreshes it rather than stacking.
Object.assign(STATUSES, {
  collisionImmune: S({
    name: 'Padded', icon: '🥊', color: '#b0714a',
    desc: 'Shrugs off crashes, falls and being crushed.',
    // All three kinds: shoved into a wall, shoved off a ledge, squashed between
    // two things. (Being crushed FLAT - shoved into something with nowhere left
    // to go - is still lethal: that is not damage taken, it is no room to exist.)
    ignoresImpact: ['crash', 'fall', 'crush'],
    aiValue: -12,          // good to carry
  }),
  regeneration: S({
    name: 'Regenerating', icon: '♻️', color: '#a8e05f',
    desc: 'Heals {n} at the start of each of its turns, for the whole fight.',
    tickHeal: 2,           // at the start of each of the carrier's own turns
    aiValue: -20,          // good to carry, and it never runs out
  }),
});

// The moments a passive may name. 'battleStart' is what a bare id means.
export const PASSIVE_MOMENTS = ['battleStart', 'hit'];

// One passive entry, whichever of the three forms it was written in, as
// { status, when, buffX }. Returns null (and, unless `quiet`, says why on the
// console) for an entry that names no row or no known moment - a typo in a
// config list should be loud here rather than a silently missing passive in a
// fight. The Settings window passes `quiet` while a cell is being typed in.
export function parsePassive(e, quiet = false) {
  let status, when, buffX = null;
  if (typeof e === 'string') {
    const at = e.indexOf('@');
    status = (at < 0 ? e : e.slice(0, at)).trim();
    when = at < 0 ? 'battleStart' : e.slice(at + 1).trim();
  } else if (e && typeof e === 'object') {
    status = e.status; when = e.when || 'battleStart'; buffX = e.buffX ?? null;
  } else return null;
  if (!STATUSES[status]) { if (!quiet) console.warn('passive: no status row named', status); return null; }
  if (!PASSIVE_MOMENTS.includes(when)) { if (!quiet) console.warn('passive: no moment named', when, '(for', status + ')'); return null; }
  return { status, when, buffX };
}
// The string form of a parsed passive, for the Settings window's list editor
// ('enraged@hit'; a bare id at battle start). buffX has no string form and is
// dropped, which is why the object form is file-only.
export const passiveToString = (p) => (p.when === 'battleStart' ? p.status : `${p.status}@${p.when}`);

export const statusById = (id) => STATUSES[id] ?? null;







// ========================ABILITY UPGRADE TREES=========================
//
//  The party grows through these: every reward pick unlocks one node of one
//  ability's tree, and the ability is re-derived from its base definition
//  above plus every unlocked node, in the fixed order the nodes are listed.
//
//  Node format (all optional except the texts):
//    name         what the node is called        REQUIRED
//    icon         the glyph the roster window shows on its card
//    desc         what it does, in the player's words - the ONE place this is
//                 written. It used to live in the locale tables as
//                 upgrade.<ability>.<node>.desc, which meant a node's effect
//                 and the sentence describing it were edited in two files and
//                 drifted apart. A translation may still override it: if a
//                 locale defines that key, it wins (see upgradeInfo in
//                 src/upgrades.js).
//    requires     [nodeIds]  - ALL of them must be unlocked first (multi-parent
//                              nodes are how two branches meet in a capstone);
//                              [] / absent = a root, available from the start
//    add          { damage, heal, buffX } - numeric bumps, summed onto the base
//    castZoneAdd  [offsets]  - extra tiles the ability may be aimed at
//    dmgZoneAdd   [offsets]  - extra tiles the effect covers (from the aim point)
//    tagZoneAdd   [offsets]  - extra tiles that receive the ability's tile tag
//    pushDistAdd  n          - every pushZone entry shoves n tiles further
//                              (the engine caps a single shove at 2 tiles)
//    costAdd      { hp, supplies, move } - summed onto the ability's cost, so a
//                              node can make it dearer or (negative) cheaper;
//                              two nodes touching one resource stack
//    flags        { bool }   - switches for upgrade-specific ability logic; the
//                              engine reads them off the resolved def
//    passives     Apply a passive status effect to the unit.
//
// ----------------------------------DEFINITION-----------------------------------
const U = (o) => Object.assign({
  name: '', icon: '⭐', desc: '',
  requires: [], add: {}, castZoneAdd: [], dmgZoneAdd: [], tagZoneAdd: [],
  pushDistAdd: 0, flags: {},
  passives: [],
}, o);
// -------------------------------------TABLE-------------------------------------
export const ABILITY_UPGRADES = {

  // clawSwipe: {//A Melee attack that reaches medium range and damage and is capable of being vampiric.
  //   //Ability Range Upgrades
  //   //level 1
  //   cleave: U({
  //     dmgZoneAdd: [[0, -1], [-1, 1]],
  //     name: 'Cleave', icon: '✂️', desc: 'Wider swipe that also reaches the tiles next to target'
  //   }),
  //   //level 2
  //   wideCleave: U({
  //     requires: ['cleave'], dmgZoneAdd: [[-1, -1], [-2, 1]],
  //     name: 'Wide Cleave', icon: '🌊', desc: 'The swipe covers almost all tiles around'
  //   }),
  //   spike: U({
  //     requires: ['cleave'], dmgZoneAdd: [[1, 0]],
  //     name: 'Spike', icon: '⚜️', desc: 'The cleave ends in a lunge that reaches for two tiles'
  //   }),

  //   //Ability Power Upgrades
  //   //level 1
  //   power: U({
  //     add: { damage: 1 },
  //     name: 'Strength', icon: '🦾', desc: 'With strengthened sinews, Gorm hits harder'
  //   }),
  //   //level 2
  //   longclaw: U({
  //     requires: ['power'], add: { damage: 2 },
  //     name: 'Long Claws', icon: '🪓', desc: 'Large claws for big damage',
  //   }),
  //   leechclaw: U({
  //     requires: ['power'], add: { damage: 1 }, costAdd: { hp: -2 },
  //     name: 'Leech Claws', icon: '🖤', desc: 'Special channels in the claws siphon material from the target'
  //   }),
  // },


  chargeHeadbutt: {
    //Ability Utility Upgrades
    //level 1
    collisionImmune: U({
      name: 'Padded', icon: '🥊', desc: 'Becomes immune to collisions',
      passives: ['collisionImmune'],
    }),
    //level 2
    regenerate: U({
      requires: ['collisionImmune'],
      name: 'Regenerating', icon: '♻️', desc: 'Regenerates each turn',
      passives: ['regeneration'],
    }),
    beginEnraged: U({
      requires: ['collisionImmune'],
      name: 'Raging Entry', icon: '😡', desc: 'Starts each combat enraged',
      passives: ['enraged'],
    })
  },


  // Strike: melee jab. Branches: hit harder vs hit wider, meeting in Execute.
  strike: {
    edge: U({ name: 'Edge', icon: '🗡️', desc: '+1 damage', add: { damage: 1 } }),
    weight: U({ name: 'Weight', icon: '🪨', desc: '+1 damage', add: { damage: 1 } }),
    reach: U({ name: 'Reach', icon: '📏', desc: 'can strike from 2 tiles away', requires: ['edge'], castZoneAdd: ringOffsets(2, 2) }),
    sweep: U({ name: 'Sweep', icon: '🌀', desc: 'also hits the tiles around the target', requires: ['weight'], dmgZoneAdd: ringOffsets(1, 1) }),
    execute: U({ name: 'Execute', icon: '💀', desc: '+2 damage', requires: ['reach', 'sweep'], add: { damage: 2 } }),
  },
  // Shove: the positioning tool. Distance and damage feed the capstone.
  shove: {
    jolt: U({ name: 'Jolt', icon: '⚡', desc: '+1 damage', add: { damage: 1 } }),
    momentum: U({ name: 'Momentum', icon: '🏃', desc: 'pushes 1 tile further', pushDistAdd: 1 }),
    longarm: U({ name: 'Long Arm', icon: '📏', desc: 'can shove from 2 tiles away', requires: ['jolt'], castZoneAdd: ringOffsets(2, 2) }),
    impact: U({ name: 'Impact', icon: '💥', desc: '+1 damage', requires: ['momentum'], add: { damage: 1 } }),
    avalanche: U({ name: 'Avalanche', icon: '🏔️', desc: '+2 damage', requires: ['longarm', 'impact'], add: { damage: 2 } }),
  },
  // Volley: ranged single shot. Range out, range in, then a splash and a payoff.
  volley: {
    barbed: U({ name: 'Barbed Arrows', icon: '🪝', desc: '+1 damage', add: { damage: 1 } }),
    farsight: U({ name: 'Farsight', icon: '🔭', desc: 'range grows to 5 tiles', castZoneAdd: ringOffsets(5, 5) }),
    closework: U({ name: 'Close Work', icon: '🎯', desc: 'can fire point blank', requires: ['barbed'], castZoneAdd: ringOffsets(1, 1) }),
    rain: U({ name: 'Arrow Rain', icon: '🌧️', desc: 'also hits the tiles around the target', requires: ['farsight'], dmgZoneAdd: ringOffsets(1, 1) }),
    deadeye: U({ name: 'Deadeye', icon: '👁️', desc: '+2 damage', requires: ['closework', 'rain'], add: { damage: 2 } }),
  },
  // Lance: the rotating 3-tile line. Longer line, longer arm, harder hit.
  lance: {
    hone: U({ name: 'Hone', icon: '🔪', desc: '+1 damage', add: { damage: 1 } }),
    extend: U({ name: 'Extend', icon: '📏', desc: 'the line reaches a 4th tile', dmgZoneAdd: [[3, 0]] }),
    pike: U({ name: 'Pike', icon: '🔱', desc: 'can thrust from 2 tiles away', requires: ['hone'], castZoneAdd: ringOffsets(2, 2) }),
    drive: U({ name: 'Drive', icon: '💥', desc: '+1 damage', requires: ['extend'], add: { damage: 1 } }),
    skewer: U({ name: 'Skewer', icon: '🍢', desc: '+2 damage', requires: ['pike', 'drive'], add: { damage: 2 } }),
  },
  // Ember Burst: the fire AoE. Throw further, blast wider, burn wider.
  burst: {
    kindle: U({ name: 'Kindle', icon: '🔥', desc: '+1 damage', add: { damage: 1 } }),
    lob: U({ name: 'Lob', icon: '🏹', desc: 'can be thrown 4 tiles', castZoneAdd: ringOffsets(4, 4) }),
    spread: U({ name: 'Spread', icon: '🌋', desc: 'the blast covers one more ring', requires: ['kindle'], dmgZoneAdd: ringOffsets(2, 2) }),
    scorch: U({ name: 'Scorch', icon: '♨️', desc: 'fire also covers the ring around the centre', requires: ['lob'], tagZoneAdd: ringOffsets(1, 1) }),
    inferno: U({ name: 'Inferno', icon: '☄️', desc: '+1 damage', requires: ['spread', 'scorch'], add: { damage: 1 } }),
  },
  // Bolt: the heavy single-target hit. Two damage steps, two range steps.
  bolt: {
    charge: U({ name: 'Charge', icon: '🔋', desc: '+1 damage', add: { damage: 1 } }),
    arc: U({ name: 'Arc', icon: '🌩️', desc: 'range grows to 3 tiles', castZoneAdd: ringOffsets(3, 3) }),
    surge: U({ name: 'Surge', icon: '⚡', desc: '+1 damage', requires: ['charge'], add: { damage: 1 } }),
    farcast: U({ name: 'Farcast', icon: '🔭', desc: 'range grows to 4 tiles', requires: ['arc'], castZoneAdd: ringOffsets(4, 4) }),
    thunder: U({ name: 'Thunder', icon: '🌪️', desc: '+2 damage', requires: ['surge', 'farcast'], add: { damage: 2 } }),
  },
  // Mend: the heal. Stronger, further, then a healing splash around the target.
  // (The splash heals every unit standing in it - stand apart from enemies.)
  mend: {
    soothe: U({ name: 'Soothe', icon: '💚', desc: '+1 healing', add: { heal: 1 } }),
    tend: U({ name: 'Tend', icon: '📏', desc: 'can heal from 2 tiles away', castZoneAdd: ringOffsets(2, 2) }),
    bloom: U({ name: 'Bloom', icon: '🌸', desc: 'also heals everyone around the target', requires: ['soothe'], dmgZoneAdd: ringOffsets(1, 1) }),
    mercy: U({ name: 'Mercy', icon: '🙏', desc: '+1 healing', requires: ['tend'], add: { heal: 1 } }),
    renewal: U({ name: 'Renewal', icon: '✨', desc: '+2 healing', requires: ['bloom', 'mercy'], add: { heal: 2 } }),
  },
  // Guard: the shield. Learns to patch wounds and to reach further.
  guard: {
    patch: U({ name: 'Patch', icon: '🩹', desc: 'the shield also heals 1', add: { heal: 1 } }),
    brace: U({ name: 'Brace', icon: '📏', desc: 'can shield from 2 tiles away', castZoneAdd: ringOffsets(2, 2) }),
    surgeon: U({ name: 'Surgeon', icon: '⚕️', desc: 'heals 1 more', requires: ['patch'], add: { heal: 1 } }),
    farward: U({ name: 'Far Ward', icon: '🔭', desc: 'can shield from 3 tiles away', requires: ['brace'], castZoneAdd: ringOffsets(3, 3) }),
    aegis: U({ name: 'Aegis', icon: '🛡️', desc: 'heals 2 more', requires: ['surgeon', 'farward'], add: { heal: 2 } }),
  },
};

export const abilityById = (id) => ABILITIES[id] ?? null;