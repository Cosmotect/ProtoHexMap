// ===================ABILITIES, ABILITY UPGRADES AND STATUSES====================

import { ringOffsets, lineOffsets, DIRS } from '../local/battle/bhex.js';

// ===================================ABILITIES===================================
//  An ability is DATA. There is no per-ability code anywhere: one executor
//  (`resolveCast` in local/battle/engine.js) reads the fields below and performs
//  them, always in this order, and the enemy AI judges a new ability by playing
//  that same executor out on a copy of the board. So anything expressible here
//  works in the game AND is understood by the AIs.
//
//    name       Ability name as it shows up in-game.
//    desc       what it does, in the player's words - the roster window, the
//               ability tooltips and the party window show it. Written HERE,
//               the one place; a translation may override it with the locale
//               key ability.<id>.desc (English has no such keys any more).
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
//    damage     flat damage to every unit in dmgZone. Height matters: 2+ levels
//               above adds combat.highBonus, 2+ below removes combat.lowPenalty.
//    heal       flat healing to every unit in dmgZone (applied after damage).
//    statusEffect  the id of a status from STATUSES below, applied to every unit
//               in dmgZone. As the table wrote it, unless...
//    statusEffectOverride  { field: number } - the numbers of that status THIS
//               ability wants different from the table. Only the fields you
//               name change:
//                 statusEffect: 'nerveAgent'                                       the table's nerveAgent
//                 statusEffect: 'nerveAgent', statusEffectOverride: { turns: 5 }  same bite, 5 turns
//                 statusEffect: 'nerveAgent', statusEffectOverride: { tickHP: -4, turns: 5 }
//               Fields you may name: speed, damageDealt, damageTaken, tickHP,
//               turns, charges (the status's numeric fields). Written AS THE
//               TABLE WRITES THEM, sign and all: `slow` is speed -1, so a harder
//               slow is statusEffectOverride: { speed: -2 }.
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
//    tagId      a tile tag from COMBAT_TAGS (config/entities.js) to spawn...
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
  damage: 0, heal: 0, statusEffect: '', statusEffectOverride: null,   // null = the status exactly as the table wrote it
  castZone: [], castAny: false, dmgZone: [], tagZone: [], tagId: null,
  hZone: [], hMode: 'rel', pushZone: [], rotatable: false, moveToTarget: false,
  cost: { hp: 0, supplies: 0, move: 0 },
}, o);
// -------------------------------------TABLE-------------------------------------
export const ABILITIES = {
  //Tag Abilities
  nerveAgentCloud: A({ name: "Nerve Agent", icon: '🎆', color: '#ff9950', statusEffect: 'nerveAgent', castZone: [[0, 0]], dmgZone: [[0, 0]], }),

  //Enemy Abilities
  softeningBite: A({ name: 'Softening Bite', icon: '⚔️', color: '#e0b25f', statusEffect: 'vulnerable', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  rageBite: A({ name: 'Enraging Bite', icon: '🤬', color: '#E84A27', statusEffect: 'enraged', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  headbutt: A({ name: 'Headbutt', icon: '🐏', color: '#e0b25f', damage: 0, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  weakeningBite: A({ name: 'Weakening Bite', icon: '🩼', color: '#38D1AC', statusEffect: 'weaken', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),

  lobbedShrapnelBurst: A({ name: 'Lobbed ShrapnelBurst', icon: '💥', color: '#ff9950', damage: 3, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1) }),
  lobbedNerveAgentBurst: A({ name: 'Lobbed Nerve Agent Burst', icon: '🎆', color: '#ff9950', damage: 1, castZone: ringOffsets(1, 4), dmgZone: ringOffsets(0, 1), tagId: 'nerveAgentCloud', tagZone: ringOffsets(0, 1) }),

  swipe: A({ name: 'Swipe', icon: '💫', color: '#5fc7e0', damage: 5, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [-1, -1], [0, 1]], rotatable: true }),
  //strike
  //heavy strike
  //thundering strike
  //Razeing Antler Swipe
  chargeHeadbutt: A({ name: 'Charge Headbutt', icon: '🐏💨', color: '#e0b25f', damage: 2, castZone: lineOffsets(1, 3), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true, moveToTarget: true }),
  //Web


  //Player Abilities
  strike: A({ name: 'Strike', icon: '⚔️', color: '#e0b25f', desc: 'A close blow against one adjacent enemy.', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  shove: A({ name: 'Shove', icon: '🌀', color: '#ffd75f', desc: 'A light hit that pushes the target away - off a ledge, into a wall, into its friends.', damage: 1, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  volley: A({ name: 'Volley', icon: '🎯', color: '#a8e05f', desc: 'An arrow into a single target at medium range; too close and there is no shot.', damage: 2, castZone: ringOffsets(2, 4), dmgZone: [[0, 0]] }),
  lance: A({ name: 'Lance', icon: '⚡', color: '#5fc7e0', desc: 'A piercing thrust that strikes three tiles in a row, aimed by direction.', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [1, 0], [2, 0]], rotatable: true }),
  burst: A({ name: 'Ember Burst', icon: '🔥', color: '#ff9950', desc: 'A thrown blast: damages the target and everything around it, and leaves fire burning where it lands.', damage: 2, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1), tagZone: [[0, 0]], tagId: 'fire', cost: { move: 1 } }),
  bolt: A({ name: 'Bolt', icon: '☄️', color: '#c66dff', desc: 'A heavy arcane hit on one nearby target.', damage: 4, castZone: ringOffsets(1, 2), dmgZone: [[0, 0]], cost: { hp: 1 } }),
  mend: A({ name: 'Mend', icon: '🏥', color: '#a8e05f', desc: 'Heals one ally standing on or next to the caster.', heal: 4, castZone: ringOffsets(0, 1), dmgZone: [[0, 0]], cost: { supplies: 1 } }),
  guard: A({ name: 'Guard', icon: '🛡️', color: '#5fc7e0', desc: 'Shields a nearby ally: the next hit or shove against them is blocked outright.', statusEffect: 'shield', castZone: ringOffsets(0, 1), dmgZone: [[0, 0]], cost: { hp: -1 } }),
  clawSwipe: A({ name: 'Claw Swipe', icon: '🔪', color: '#5fc7e0', desc: 'Clawed slashes that tear through.', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], rotatable: true }),
  glaive: A({ name: 'Glaive Strike', icon: '⚔️', color: '#e0b25f', desc: 'Downward jab with a sleek glaive.', damage: 4, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], rotatable: true }),
  plasmaBolt: A({ name: 'Plasma Bolt', icon: '☄️', color: '#e0b25f', desc: 'A bolt of plasma, eerily calm, searing.', damage: 2, castZone: ringOffsets(1, 3), dmgZone: [[0, 0]] }),
};







// ==============================STATUSES AND TRIGGERS===============================
//  A status is a certain termporary effect that modifies how aspects of combat
//  interact with the unit carrying the status effect.
//  Every status is built from one or more verbs which the engine knows how to
//  perform. New verbs must be added in code, new statuses are config only.
//
//  A "passive" (what the party window calls them) is a status a unit puts on
//  ITSELF through a TRIGGER - an upgrade node, a relic or an aura saying "at this
//  moment, this status". It is gone when the source is no longer affecting the
//  unit. See TRIGGERS below the table.
//
//  ----- what each building block does, exactly -----
//  EFFECTS (all optional; a status may combine several):
//    tickHP       hp the carrier gains (positive) or loses (negative) at the
//                 start of its activation - the same moment a tile tag bites.
//                 A nerveAgent is tickHP: -2, a regeneration tickHP: 2.
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
//    agency       what the carrier LOSES the right to do, a list of:
//                 'stunned'   does not act on its activation at all - no move,
//                             no ability (the activation is skipped)
//                 'disarmed'  may still move, but cannot use any ability
//                 Empty = acts freely. A row may name both.
//    ignoresImpactImpact kinds this row shrugs off:
//                'crash'(shoved into a wall or a body),
//                'fall' (shoved off a ledge),
//                'crush'(squashed between two things).
//                 Empty = takes them all like everyone else
//
//  LIFETIME (how the status ends - a status with neither never expires):
//    turns        How many of the carrier's turns it lasts. Counted down at the
//                 start of the turn, AFTER the tick damage / heal. 0 = no clock.
//    charges      How many times it may be spent before it ends (see spentOn).
//    spentOn      What spends a charge: 
//                 'hit'(something was blocked / taken),
//                 'attack' (the carrier cast a damaging ability),
//                 'activation' (the carrier's turn came up).
//                 '' = nothing spends it.
//
//                 A status with NO clock and an EMPTY spentOn can never be taken
//                 off - that is what makes it permanent (Padded). A trigger may
//                 make ANY row permanent with statusEffectOverride: { turns: 0 }:
//                 Regenerating is `regen` with its clock switched off, not a
//                 second row. A status with no clock and spentOn: 'cleanse'
//                 lasts until something cleanses it - an endless curse. Nothing
//                 else has to be declared: permanence is read off these fields.
//                 (No 'cleanse' event exists in the engine yet; when a cleansing
//                 ability arrives it is one spendStatus(st, u, 'cleanse') call.)
//
//  OVERRIDING A STATUS'S NUMBERS - `statusEffectOverride` on an ability or a trigger:
//    A status row's NUMBERS (speed, damageDealt, damageTaken, tickHP, turns,
//    charges) are what the table says. Whoever puts the status on may hand over
//    `statusEffectOverride: { field: number }` naming the ones it wants different;
//    everything it does not name stays as the table wrote it. The numbers that
//    were actually applied are remembered on the unit, so two sources of the
//    same status do not have to agree.
//
//  THE ENEMY AI:
//    aiValue      how GOOD carrying this status is, in the AI's own scoring units
//                 (a point of damage is 10, a kill 45). Positive = good for
//                 whoever carries it, so the AI hands it to allies and values
//                 stripping it off a party unit; negative = bad to carry, so
//                 the AI tries to inflict it on the party and keeps it off its
//                 own side. Nothing else has to be taught:
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
  tickHP: 0, speed: 0, damageDealt: 1, damageTaken: 1, blocks: false, agency: [], ignoresImpact: [],
  turns: 0, charges: 0, spentOn: '',
  aiValue: 0,
}, o);
// -------------------------------------TABLE-------------------------------------
export const STATUSES = {
  shield: S({
    name: 'Shield', icon: '🛡', color: '#5fc7e0',
    desc: 'Blocks the next hit or push entirely, then breaks.',
    blocks: true, charges: 1, spentOn: 'hit',
    aiValue: 14,
  }),
  crit: S({
    name: 'Charged', icon: '⚡', color: '#ffd75f',
    desc: 'The next damaging ability this unit casts hits every target critically.',
    damageDealt: 2, charges: 1, spentOn: 'attack',
    aiValue: 10,
  }),
  stun: S({
    name: 'Stunned', icon: '💫', color: '#c9a8ff',
    desc: 'Loses its next activation: no move, no ability.',
    agency: ['stunned'], charges: 1, spentOn: 'activation',
    aiValue: -12,
  }),
  disarm: S({
    name: 'Disarmed', icon: '🚫', color: '#c9a8ff',
    desc: 'Can move, but cannot use any ability on its next activation.',
    agency: ['disarmed'], charges: 1, spentOn: 'activation',
    aiValue: -10,
  }),
  haste: S({
    name: 'Hastened', icon: '💨', color: '#a8e05f',
    desc: 'Moves {n} tiles further than usual.',
    speed: 1, turns: 2,
    aiValue: 6,
  }),
  slow: S({
    name: 'Slowed', icon: '🐌', color: '#c9a8ff',
    desc: 'Moves {n} tiles less than usual (never below the minimum speed).',
    speed: -1, turns: 2,
    aiValue: -9,
  }),
  nerveAgent: S({
    name: 'Poisoned', icon: '🧪', color: '#8fd14f',
    desc: 'Takes {n} damage at the start of each of its turns, then the nerveAgent fades.',
    tickHP: -2, turns: 3,
    aiValue: -20,
  }),
  regen: S({
    name: 'Mending', icon: '🌿', color: '#a8e05f',
    desc: 'Heals {n} at the start of each of its turns.',
    tickHP: 2, turns: 3,
    aiValue: 18,
  }),
  weaken: S({
    name: 'Weakened', icon: '🩼', color: '#b58fd1',
    desc: 'Deals half damage while it lasts.',
    damageDealt: 0.5, turns: 2,
    aiValue: -16,
  }),
  vulnerable: S({
    name: 'Vulnerable', icon: '🎯', color: '#e2474b',
    desc: 'Takes half again as much damage from everything while it lasts.',
    damageTaken: 1.5, turns: 2,
    aiValue: -18,
  }),
  enraged: S({
    name: 'Enraged', icon: '🤬', color: '#e2474b',
    desc: 'Hits half again as hard and moves 2 tiles further, for one turn.',
    damageDealt: 1.5, speed: 2, turns: 1,
    aiValue: 22,
  }),
  // A row with no clock and nothing to spend it stays for the whole fight once
  // put on. Nothing else is special about it - a trigger may name ANY row (see
  // TRIGGERS below), and switch a clock off with statusEffectOverride: { turns: 0 }.
  collisionImmune: S({
    name: 'Padded', icon: '🥊', color: '#b0714a', desc: 'Shrugs off crashes, falls and being crushed.',
    ignoresImpact: ['crash', 'fall', 'crush'],
    aiValue: 12,
  }),
};
export const statusById = (id) => STATUSES[id] ?? null;

// A status's numeric fields - the ones a statusEffectOverride may name - in the order
// the badge and the Settings window list them.
export const STATUS_KNOBS = ['speed', 'damageDealt', 'damageTaken', 'tickHP', 'turns', 'charges'];
// The value each knob has when a status leaves it alone. The two multipliers rest
// at 1 (x1 changes nothing); everything else rests at 0.
const KNOB_NEUTRAL = { speed: 0, damageDealt: 1, damageTaken: 1, tickHP: 0, turns: 0, charges: 0 };
// Which of those THIS status actually uses (moved off its neutral value), in
// that order. The FIRST one is the status's "amount" - the {n} of its text and
// the number on its badge (src/status.js). Editing a status in the Settings
// window can change this list: give a status a tickHP and it grows one.
export function statusKnobs(def) {
  return def ? STATUS_KNOBS.filter((k) => Number(def[k] ?? KNOB_NEUTRAL[k]) !== KNOB_NEUTRAL[k]) : [];
}
// What a statusEffectOverride changes about a status: { field: number } for the numeric
// fields it names with a real number. Anything else in it is ignored (and, for
// a stray list left over from the old positional `buffX`, complained about).
export function statusOverridesFor(def, override) {
  const out = {};
  if (!override || typeof override !== 'object') return out;
  if (Array.isArray(override)) { console.warn('statusEffectOverride must be an object like { turns: 3 }, not a list:', override); return out; }
  for (const k of STATUS_KNOBS) {
    const n = Number(override[k]);
    if (override[k] !== undefined && override[k] !== null && Number.isFinite(n)) out[k] = n;
  }
  return out;
}


// ----- TRIGGERS ---------------------------------------------------------
//  A trigger is a status the unit puts on ITSELF at a moment, without a cast.
//  That is the whole definition. There is no separate table for them and no
//  such thing as a "passive row": a trigger names ANY row of the table above
//  (Angry Beetle names `haste`, Padded names `collisionImmune`), the engine
//  applies it with the very same applyStatus a cast uses, and from then on it
//  sits in the unit's status bag like anything else. What happens next is the
//  ROW's business:
//    * a row with no clock and an empty spentOn stays for the whole fight
//      (Padded) - what the party window lists as a PASSIVE;
//    * a row with a clock wears off (Angry Beetle's `haste`, one activation);
//    * a row with charges is spent by use ("starts every fight with a Shield"
//      is just a trigger naming `shield`);
//    * and a trigger may change the row's numbers on the way in, so
//      `regen` with statusEffectOverride: { turns: 0 } is a permanent
//      regeneration - no second row needed.
//
//  WHERE a trigger is written - all with the same list shape:
//    an upgrade node's `triggers` (ABILITY_UPGRADES below), a bestiary row's
//    `triggers` (config/entities.js), and later a relic's and a world-map aura's.
//    The set a party unit is under is worked out when a FIGHT STARTS (triggersFor
//    in src/upgrades.js) from what the unit IS right now, never stored on it, so
//    walking out of an aura's radius needs nobody to remember to remove anything.
//
//  HOW one is written - ONE form, always an object with these two fields:
//    { statusEffect: 'collisionImmune', when: 'battleStart' }
//      statusEffect  a row of the STATUSES table (required)
//      when          one of the moments below (required)
//    ...and optionally the row's numbers changed, exactly as an ability does it:
//    { statusEffect: 'regen', when: 'battleStart', statusEffectOverride: { turns: 0 } }
//  Nothing else is accepted - a bare string, a missing `when`, a status or a
//  moment the engine does not know - and a rejected entry says why on the
//  console (checkTrigger below) rather than fighting silently without it.
//  A worked example, an upgrade node that starts every fight three turns angry:
//    angryBeetle: U({
//      name: 'Angry Beetle', icon: '🐞', desc: 'Starts each fight enraged for 3 turns',
//      triggers: [{ statusEffect: 'enraged', when: 'battleStart', statusEffectOverride: { turns: 3 } }],
//    }),
//
//  THE MOMENTS (`when`) the engine knows - each is one line in the engine at the
//  place the thing happens, so a new one is a new moment, not a new system:
//    'battleStart'  once, before either side moves.
//    'hit'          every time the carrier actually loses hp - an ability, a
//                   crash / fall / crush, a tile tag, a nerveAgent tick. A hit that
//                   a shield blocked is not a hit. Re-applying a row the unit
//                   already carries refreshes it rather than stacking.
//
//  HOW LONG `turns` LASTS, whenever the status went on: a status bites at the
//  START of its carrier's activation and its clock counts down at the END of
//  it, and only an activation it was present at the start of counts. So
//  `turns: 1` is one full activation with it - put on at battle start, during
//  the enemy's turn, or by a hit taken mid-walk, all the same. A self-cast
//  during the carrier's own activation is not charged for that activation.

// Can nothing take this status off its unit? True when it has no clock and
// nothing spends it. `slot` is the unit's own copy ({ turns, charges, over }) when
// there is one - an ability may have given the row a clock through statusEffectOverride. The
// unit card hides permanent rows from its status slots (the party view will list
// them instead); everything else about a permanent row is ordinary.
export function isPermanent(def, slot) {
  if (!def) return false;
  const turns = slot && slot.turns !== undefined ? slot.turns : def.turns;
  return !(turns > 0) && !def.spentOn;
}

// The moments a trigger may name.
export const TRIGGER_MOMENTS = ['battleStart', 'hit'];

// Checks one written trigger and returns it in the shape the engine carries -
// { statusEffect, when, statusEffectOverride } - or null, saying why on the
// console (unless `quiet`). This is the ONE reader of the trigger form: the
// fight (engine.js), the party's trigger list (upgrades.js) and the party view
// all go through it, so a mistake in a config list is caught in one place and
// reads the same everywhere.
export function checkTrigger(e, quiet = false) {
  const bad = (why) => { if (!quiet) console.warn('trigger rejected:', why, e); return null; };
  if (!e || typeof e !== 'object' || Array.isArray(e)) return bad('a trigger is written as { statusEffect, when }');
  if (!e.statusEffect || !STATUSES[e.statusEffect]) return bad(`no status row named "${e.statusEffect}"`);
  if (!e.when || !TRIGGER_MOMENTS.includes(e.when)) return bad(`"when" must be one of ${TRIGGER_MOMENTS.join(' / ')}`);
  return { statusEffect: e.statusEffect, when: e.when, statusEffectOverride: e.statusEffectOverride ?? null };
}








// ========================ABILITY UPGRADE TREES=========================
//
//  The party grows through these: every reward pick unlocks one node of one
//  ability's tree, and the ability is re-derived from its base definition
//  above plus every unlocked node, in the fixed order the nodes are listed.
//
//  Node format (all optional except the texts):
//    name         What the node is called in-game.
//    icon         The glyph the roster window shows on its card.
//    desc         What it does, in more detail. 
//    short        (optional) is the short version of the desciption the party
//                 window's tree cards show under the name ("+1 damage",
//                 "wider swipe"); without one the card shows `desc`.
//  ----- 1. PRE-REQUISITES ---------------------------------------------
//    requires     [nodeIds]  - ALL of them must be unlocked first (multi-parent
//                              nodes are how two branches meet in a capstone);
//                              [] / absent = a root, available from the start
//  ----- 2. WHAT THE NODE CHANGES --------------------------------------
//    add          { damage, heal } - numbers SUMMED onto the ability's own:
//                   add: { damage: 1 }         hits 1 harder
//                   add: { heal: 2 }           heals 2 more
//                   add: { damage: -1 }        hits 1 softer (a trade-off node)
//                 Two nodes touching one number stack. Nothing else belongs in
//                 `add`: zones have their own *Add fields below, the cost has
//                 costAdd, and the numbers of the status an ability applies
//                 have statusEffectAdd.
//    statusEffectAdd  { field: number } - summed onto the numbers of the status
//                 the ability applies (its `statusEffect`), field by field, on
//                 top of the table's value or the ability's own override:
//                   statusEffectAdd: { turns: 1 }     the nerveAgent lasts a turn longer
//                   statusEffectAdd: { tickHP: -2 }   ...and bites 2 harder
//                 Fields: speed, damageDealt, damageTaken, tickHP, turns,
//                 charges. Does nothing on an ability with no `statusEffect`.
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
//    triggers     [{ statusEffect, when, statusEffectOverride? }] - triggers the node gives
//                 the UNIT (not the ability). See TRIGGERS above for the form
//                 and the moments.
//
// ----------------------------------DEFINITION-----------------------------------
const U = (o) => Object.assign({
  name: '', icon: '⭐', desc: '', short: '',
  requires: [], add: {}, statusEffectAdd: {}, castZoneAdd: [], dmgZoneAdd: [], tagZoneAdd: [],
  pushDistAdd: 0, flags: {},
  triggers: [],
}, o);
// -------------------------------------TABLE-------------------------------------
export const ABILITY_UPGRADES = {

  clawSwipe: {//A Melee attack that reaches medium range and damage and is capable of being vampiric.
    //Ability Range Upgrades
    //level 1
    cleave: U({
      dmgZoneAdd: [[0, -1], [-1, 1]],
      name: 'Cleave', icon: '✂️', desc: 'Wider swipe that also reaches the tiles next to target'
    }),
    //level 2
    wideCleave: U({
      requires: ['cleave'], dmgZoneAdd: [[-1, -1], [-2, 1]],
      name: 'Wide Cleave', icon: '🌊', desc: 'The swipe covers almost all tiles around'
    }),
    spike: U({
      requires: ['cleave'], dmgZoneAdd: [[1, 0]],
      name: 'Spike', icon: '⚜️', desc: 'The cleave ends in a lunge that reaches for two tiles'
    }),

    //Ability Power Upgrades
    //level 1
    power: U({
      add: { damage: 1 },
      name: 'Strength', icon: '🦾', desc: 'With strengthened sinews, Gorm hits harder'
    }),
    //level 2
    longclaw: U({
      requires: ['power'], add: { damage: 2 },
      name: 'Long Claws', icon: '🪓', desc: 'Large claws for big damage',
    }),
    leechclaw: U({
      requires: ['power'], add: { damage: 1 }, costAdd: { hp: -2 },
      name: 'Leech Claws', icon: '🖤', desc: 'Special channels in the claws siphon material from the target'
    }),
  },

  chargeHeadbutt: {
    //Ability Utility Upgrades
    //level 1
    collisionImmune: U({
      name: 'Padded', icon: '🥊', desc: 'Becomes immune to collisions', short: 'immune to collisions',
      triggers: [{ statusEffect: 'collisionImmune', when: 'battleStart' }],
    }),
    //level 2
    regenerate: U({
      requires: ['collisionImmune'],
      name: 'Regenerating', icon: '♻️', desc: 'Regenerates each turn', short: 'heals 2 every turn',
      // `turns: 0` switches the clock off (0 is the table's own "no clock"; null
      // would mean "leave it as the table wrote it", i.e. 3 turns).
      triggers: [{ statusEffect: 'regen', when: 'battleStart', statusEffectOverride: { turns: 0 } }],
    }),
    beginEnraged: U({
      requires: ['collisionImmune'],
      name: 'Raging Entry', icon: '😡', desc: 'Starts each combat enraged', short: 'enraged on turn one',
      triggers: [{ statusEffect: 'enraged', when: 'battleStart' }],
    }),
    //Ability Power upgrades
    //level 1
    heavyImpact: U({
      name: 'Heavy Impact', icon: '🥊', desc: 'Gorm learns to put his full weight into the tackle.',
      add: { damage: 1 },
    }),
    angryBeetle: U({
      requires: ['heavyImpact'],
      name: 'Angry Beetle', icon: '💢', desc: 'Gorm is driven into a frenzy when hit, picking up speed to reach his offenders.',
      // Hastened (speed +1) for one activation, every time he loses hp.
      triggers: [{ statusEffect: 'haste', when: 'hit', statusEffectOverride: { turns: 1 } }],
    })
  },

  glaive: {// A longer range melee attack
    lunge: U({
      dmgZoneAdd: [[1, 0]],
      name: "Glaive Lunge", icon: '➡️➡️', desc: 'Can reach a tile further than directly in front.', short: '+1 range'
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