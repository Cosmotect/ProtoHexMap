// =====================================================================
//  COMBAT CONFIG - abilities, tile tags and per-unit combat stats.
//  (Part of the config split; read by src/local/battle/engine.js.)
//
//  This is the hand-authored slice of the hex-box combat prototype: only the
//  DEFINITIONS came over, none of the editors or storage. Ability shapes are
//  hex-box's zone format:
//    castZone  offsets (from the caster) the ability may be aimed at
//    dmgZone   offsets (from the aim point) that take damage / heal / status
//    tagZone   offsets that receive the tile tag `tagId`
//    pushZone  [q, r, dirIndex, dist?] - shove whoever stands there
//    rotatable true = the zones rotate towards the aim point (6 sectors)
//    castAny   true = aim anywhere on the board
//    moveToTarget  the caster dashes to the aim point after the effects
//    buff      the id of a status from STATUSES below; buffX is the list of
//              numbers for that status's knobs (see WHAT buffX MEANS)
// =====================================================================
import { ringOffsets, DIRS } from '../local/battle/bhex.js';

export const COMBAT_CONFIG = {
  // ----- Combat rules (hex-box "settings" block) ----------------------
  combat: {
    minSpeed: 2,        // slowed units keep at least this much speed (climbing costs 2)
    highBonus: 1,       // damage added when attacking from 2+ levels above
    lowPenalty: 1,      // damage removed when attacking from 2+ levels below
    voidEdges: false,   // true = shoves over the map edge kill instead of crashing
    powerPerDamage: 3,  // +1 ability damage per this much of the unit's world-map power
    // (What popping a shield is worth to the enemy AI used to live here as
    // `shieldStripScore`. It moved into the shield's own row in the status table
    // below, as `aiValue`, so every status carries its own worth in one place.)
    // ----- the retreat rule (stops a decided fight from being dragged out) -----
    // A beaten enemy side starts to break. From the round AFTER `afterRound`, on
    // every enemy's turn, while the enemy side's remaining HP is under `hpFraction`
    // of what it had when the fight began, each enemy that has not broken yet rolls
    //   100 / (enemies still standing)  percent
    // to flee - so a crowd goes a few at a time and the last one standing always
    // runs. The roll happens once per enemy: a fleeing enemy is locked in, and
    // walks for the nearest arena edge until it gets there or is killed on the way.
    // It is still a normal target while it runs.
    // The STASIS is exempt: a Stasis Seed or Colony fight never offers the roll at
    // all (createBattle's `noFlee`, set from the encounter in main.js) - that enemy
    // has nowhere to run to and nothing to run for.
    // Escaping is NOT a death: nothing is reported through onUnitDeath, so when
    // LOOT exists this is exactly the branch that must not roll it - a killed enemy
    // pays out, one that got away does not. The fight still counts as won, so the
    // party keeps the encounter's completion reward.
    flee: { afterRound: 7, hpFraction: 0.3 },
    // What a status is worth to a creature that cannot read them (see the intellect
    // classes below): enough to bless allies and curse the party, not enough to
    // choose between two targets.
    blindStatusValue: 8,
    elevationLevels: 4, // arena heights run 0..this (5 steps: 0,1,2,3,4)
    // The MIDDLE step (2) is the arena's neutral ground: it renders
    // flush with the surrounding world tiles, 3 and 4 stand above it,
    // 1 and 0 are sunk below it. Keep this number EVEN so a middle
    // step exists (see config.local.elevationMid).
  },
};

// ----- Abilities -------------------------------------------------------
// A small starter kit; balance numbers are first guesses.
const A = (o) => Object.assign({
  name: 'Ability', icon: '💥', color: '#5fc7e0',
  damage: 0, heal: 0, buff: '', buffX: null,   // buffX null = "use the status's own values"
  castZone: [], castAny: false, dmgZone: [], tagZone: [], tagId: null,
  hZone: [], hMode: 'rel', pushZone: [], rotatable: false, moveToTarget: false,
}, o);

export const ABILITIES = {
  //Enemy Abilities
  softeningBite: A({ name: 'Softening Bite', icon: '⚔️', color: '#e0b25f', buff: 'vulnerable', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  rageBite: A({ name: 'Enraging Bite', icon: '🤬', color: '#E84A27', buff: 'enraged', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  headbutt: A({ name: 'Headbutt', icon: '🐏', color: '#e0b25f', damage: 0, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  weakeningBite: A({ name: 'Weakening Bite', icon: '🩼', color: '#38D1AC', buff: 'weaken', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  lobbedShrapnelBurst: A({ name: 'Lobbed ShrapnelBurst', icon: '💥', color: '#ff9950', damage: 3, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1) }),
  swipe: A({ name: 'Swipe', icon: '💫', color: '#5fc7e0', damage: 5, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [-1, -1], [-1, 1]], rotatable: true }),
  //strike
  //heavy strike
  //thundering strike
  //nerve agent salvo
  //Razeing Antler Swipe
  //Rushing Headbutt
  //Web

  //Player Abilities
  strike: A({ name: 'Strike', icon: '⚔️', color: '#e0b25f', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  shove: A({ name: 'Shove', icon: '🌀', color: '#ffd75f', damage: 1, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  volley: A({ name: 'Volley', icon: '🎯', color: '#a8e05f', damage: 2, castZone: ringOffsets(2, 4), dmgZone: [[0, 0]] }),
  lance: A({ name: 'Lance', icon: '⚡', color: '#5fc7e0', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [1, 0], [2, 0]], rotatable: true }),
  burst: A({ name: 'Ember Burst', icon: '🔥', color: '#ff9950', damage: 2, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1), tagZone: [[0, 0]], tagId: 'fire' }),
  bolt: A({ name: 'Bolt', icon: '☄️', color: '#c66dff', damage: 4, castZone: ringOffsets(1, 2), dmgZone: [[0, 0]] }),
  mend: A({ name: 'Mend', icon: '🏥', color: '#a8e05f', heal: 4, castZone: ringOffsets(0, 1), dmgZone: [[0, 0]] }),
  guard: A({ name: 'Guard', icon: '🛡️', color: '#5fc7e0', buff: 'shield', castZone: ringOffsets(0, 1), dmgZone: [[0, 0]] }),
};

// ----- Statuses ("buffs") ----------------------------------------------
//  THE POINT OF THIS TABLE: a status used to be four hand-written fields on a
//  unit plus a branch of engine code each, which meant every new one - even a
//  plain "2 damage a turn for 3 turns" - was surgery in six places, two of them
//  silent (the AI's scoring and the AI's simulation copy). Everything below is
//  built out of verbs the engine ALREADY performs, so a status made of these is
//  a row here and nothing else: no engine change, and the enemy AI understands
//  it on its own. A status that needs a verb this list does not have still needs
//  engine work - but then the VERB is added once and every later status can use
//  it, instead of each status carrying its own code.
//
//  ----- what each building block does, exactly -----
//  EFFECTS (all optional; a status may combine several):
//    speed        added to the carrier's move points, signed. Negative = a slow.
//                 The floor at combat.minSpeed still applies, so a slow can never
//                 pin a unit in place. Read in effSpeed().
//    damageDealt  MULTIPLIER on damage the carrier deals (1 = no change, 2 =
//                 double, 0.5 = half). Applied where an ability's damage is
//                 computed, after the height bonus and the power bonus.
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
//
//  LIFETIME (how the status ends - a status with neither simply never expires):
//    turns        how many of the carrier's own activations it survives. Counted
//                 down at the start of each of them, AFTER the tick damage /
//                 heal, so "3 turns of poison" deals its damage three times.
//                 0 = no clock.
//    charges      how many times it may be spent before it ends (see spentOn).
//    spentOn      what spends a charge: 'hit' (something was blocked / taken),
//                 'attack' (the carrier cast a damaging ability), 'activation'
//                 (the carrier's turn came up). '' = nothing spends it, only the
//                 turn clock can end it.
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
//  DISPLAY: `name` / `icon` / `color` are the fallback; the badge over a unit's
//  head and the card in the panel look for the locale keys status.<id>.name and
//  status.<id>.desc first ({n} is filled with the amount).
const S = (o) => Object.assign({
  name: 'Status', icon: '⭐', color: '#9aa7bd',
  speed: 0, damageDealt: 1, damageTaken: 1, blocks: false, skipsTurn: false,
  tickDamage: 0, tickHeal: 0,
  turns: 0, charges: 0, spentOn: '',
  aiValue: 0,
}, o);

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

export const STATUSES = {
  // The four that already existed, written out in the vocabulary above. Their
  // behaviour is unchanged - this is the same shield, crit, stun and haste.
  shield: S({
    name: 'Shield', icon: '🛡', color: '#5fc7e0',
    blocks: true, charges: 1, spentOn: 'hit',
    aiValue: -14,          // good to carry: the AI guards its allies and pops the party's
  }),
  crit: S({
    name: 'Charged', icon: '⚡', color: '#ffd75f',
    damageDealt: 2, charges: 1, spentOn: 'attack',
    aiValue: -10,
  }),
  stun: S({
    name: 'Stunned', icon: '💫', color: '#c9a8ff',
    skipsTurn: true, charges: 1, spentOn: 'activation',
    aiValue: 12,           // bad to carry: worth about a point of damage more than one
  }),
  haste: S({
    name: 'Hastened', icon: '💨', color: '#a8e05f',
    speed: 1, turns: 2,
    aiValue: -6,           // good to carry
  }),
  slow: S({
    name: 'Slowed', icon: '🐌', color: '#c9a8ff',
    speed: -1, turns: 2,
    aiValue: 9,            // bad to carry - and worth more than haste is worth giving
  }),
  poison: S({
    name: 'Poisoned', icon: '🧪', color: '#8fd14f',
    tickDamage: 2, turns: 3,
    aiValue: 20,              // three ticks of 2, valued a little under the 60 they cost
  }),
  regen: S({
    name: 'Mending', icon: '🌿', color: '#a8e05f',
    tickHeal: 2, turns: 3,
    aiValue: -18,
  }),
  weaken: S({
    name: 'Weakened', icon: '🩼', color: '#b58fd1',
    damageDealt: 0.5, turns: 2,
    aiValue: 16,
  }),
  vulnerable: S({
    name: 'Vulnerable', icon: '🎯', color: '#e2474b',
    damageTaken: 1.5, turns: 2,
    aiValue: 18,
  }),
  enraged: S({
    name: 'Enraged', icon: '🤬', color: '#e2474b',
    damageDealt: 1.5, speed: 2, turns: 1,
    aiValue: -22,
  }),
};

// The table is part of the combat config as well, so the Settings window can edit
// it at runtime. Same object, not a copy: the engine reads config.statuses and the
// UI imports STATUSES, and both see an edit the moment it is made.
COMBAT_CONFIG.statuses = STATUSES;

export const statusById = (id) => STATUSES[id] ?? null;

// ----- Intellect classes ------------------------------------------------
//  Not every creature thinks as well as every other one. A unit's INTELLECT CLASS
//  says which facts about the board it is capable of WEIGHING when it decides what
//  to do on its turn. It does not change the rules one bit: a witless brute still
//  gets the high-ground damage bonus if it happens to be standing high, still dies
//  in the void, still burns in a fire. It simply does not think about any of that
//  when choosing where to go and what to cast.
//
//  Nor does it change WHOSE side an effect is aimed at. Every class knows a curse
//  is for the party and a blessing is for its own allies - that is not cleverness,
//  it is knowing friend from foe. What the clever ones have is the ability to pick
//  the BEST target: a C-class creature hands its shield to whichever ally it can
//  reach, an S-class one hands it to the ally that is actually about to be hit.
//
//  ----- what each flag lets a mind weigh -----
//    statuses    the statuses on the board: which of them are worth applying to
//                whom, that a shield can be popped, that a target already carries
//                what it was about to be given, and which ally most needs a buff.
//                Blind minds still apply statuses, at a flat worth, to any legal
//                target of the right side.
//    elevation   the damage a height difference is worth, and the value of
//                claiming high ground while walking towards the party.
//    tags        the tiles that burn: worth avoiding to stand on, worth shoving
//                someone onto.
//    ether       the holes in the arena's edge: worth shoving someone into.
//    injuries    how hurt a target is: worth finishing the wounded rather than
//                spreading damage evenly.
//
//  These are the four classes the design asks for. The table is data like
//  everything else - a class can be re-tuned, and a fifth one invented, in the
//  Settings window without touching the engine.
const M = (o) => Object.assign({
  statuses: false, elevation: false, tags: false, ether: false, injuries: false,
}, o);

export const INTELLECT = {
  S: M({ statuses: true, elevation: true, tags: true, ether: true, injuries: true }),
  A: M({ elevation: true, ether: true, injuries: true }),
  B: M({ elevation: true }),
  C: M({}),
};

// What a status is worth to a mind that cannot read them: enough that it still
// blesses its allies and curses the party, not enough to choose well between two
// targets. (A reading mind uses the status table's own aiValue instead.)
export const BLIND_STATUS_VALUE = 8;

// Part of the combat config too, so the classes are editable in Settings and the
// engine can read them off the same object (config.intellect).
COMBAT_CONFIG.intellect = INTELLECT;

export const intellectOf = (cls) => INTELLECT[cls] ?? INTELLECT.C;

// ----- Tile tags -------------------------------------------------------
const T = (o) => Object.assign({
  name: 'Tag', icon: '⭐', color: '#ff9950', desc: '',
  dmg: 0, heal: 0, life: 0, hp: 0,
  pushable: false, collectible: false, passPickup: false,
  onDestroy: null, onExpire: null, onPickup: null, onPeriodic: null,
  everyX: 0, everyOff: 0,
}, o);

export const COMBAT_TAGS = {
  fire: T({ name: 'Fire', icon: '🔥', color: '#ff9950', desc: 'Burns anything standing here.', dmg: 1, life: 2 }),
};

// (The per-unit combat stats used to live here, in a UNIT_COMBAT table. They were
// a UNITS matter, not an abilities one, and they duplicated the roster: since
// 2026-09-06 a character carries init / speed / flying / abilities on its own
// roster row in config/units.js, next to its body, exactly as a bestiary row does
// for a creature. `combatStatsFor` moved there with them.)

export const abilityById = (id) => ABILITIES[id] ?? null;
export const tagDefById = (id) => COMBAT_TAGS[id] ?? null;
export { DIRS };
