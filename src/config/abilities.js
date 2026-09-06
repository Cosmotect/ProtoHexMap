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
//    buff      '' | 'shield' | 'crit' | 'stun' | 'haste' (buffX = amount, <0 = slow)
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
  damage: 0, heal: 0, buff: '', buffX: null,   // buffX null = "use the status's own value"
  castZone: [], castAny: false, dmgZone: [], tagZone: [], tagId: null,
  hZone: [], hMode: 'rel', pushZone: [], rotatable: false, moveToTarget: false,
  spawnId: null, spawnZone: [],
}, o);

export const ABILITIES = {
  //Enemy Abilities
  softeningBite: A({ name: 'Softening Bite', icon: '⚔️', color: '#e0b25f', buff: 'vulnerable', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  rageBite: A({ name: 'Enraging Bite', icon: '🤬', color: '#E84A27', buff: 'enraged', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  headbutt: A({ name: 'Headbutt', icon: '🐏', color: '#e0b25f', damage: 0, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  weakeningBite: A({ name: 'Weakening Bite', icon: '🩼', color: '#38D1AC', buff: 'weaken', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
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
  mend: A({ name: 'Mend', icon: '💫', color: '#a8e05f', heal: 4, castZone: ringOffsets(0, 1), dmgZone: [[0, 0]] }),
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
//  WHAT buffX MEANS (this was impossible to tell from the ability table before):
//    amountIs     names the ONE field of this status that an ability's `buffX`
//                 overwrites when it applies the status. '' = buffX is ignored
//                 for this status, whatever the ability says.
//                 So with the table below: on `guard` (buff: 'shield') buffX is
//                 the number of hits absorbed; on a 'crit' ability buffX is the
//                 damage multiplier; on a 'haste' ability buffX is the speed
//                 change (negative slows); on a 'stun' ability buffX does
//                 nothing at all. The number an ability actually applied is
//                 remembered per unit, so two sources of the same status do not
//                 have to agree.
//                 An ability that leaves buffX alone (null) hands over the value
//                 written HERE - which is what you almost always want, and what
//                 keeps a multiplier status like `vulnerable` from being applied
//                 as a meaningless x1.
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
//                 A status whose amount comes out negative (a slow) has its
//                 value flipped automatically - the same field covers both ends.
//
//  DISPLAY: `name` / `icon` / `color` are the fallback; the badge over a unit's
//  head and the card in the panel look for the locale keys status.<id>.name and
//  status.<id>.desc first ({n} is filled with the amount). `negative` gives a
//  signed status its own id, icon and texts for the negative end (haste -> slow).
const S = (o) => Object.assign({
  name: 'Status', icon: '⭐', color: '#9aa7bd',
  speed: 0, damageDealt: 1, damageTaken: 1, blocks: false, skipsTurn: false,
  tickDamage: 0, tickHeal: 0,
  turns: 0, charges: 0, spentOn: '',
  amountIs: '', aiValue: 0, negative: null,
}, o);

export const STATUSES = {
  // The four that already existed, written out in the vocabulary above. Their
  // behaviour is unchanged - this is the same shield, crit, stun and haste.
  shield: S({
    name: 'Shield', icon: '🛡', color: '#5fc7e0',
    blocks: true, charges: 1, spentOn: 'hit',
    amountIs: 'charges',   // buffX = how many hits it absorbs
    aiValue: -14,          // good to carry: the AI guards its allies and pops the party's
  }),
  crit: S({
    name: 'Charged', icon: '⚡', color: '#ffd75f',
    damageDealt: 2, charges: 1, spentOn: 'attack',
    amountIs: 'damageDealt',   // buffX = the multiplier (3 = triple)
    aiValue: -10,
  }),
  stun: S({
    name: 'Stunned', icon: '💫', color: '#c9a8ff',
    skipsTurn: true, charges: 1, spentOn: 'activation',
    amountIs: '',          // buffX does nothing here
    aiValue: 12,           // bad to carry: worth about a point of damage more than one
  }),
  haste: S({
    name: 'Hastened', icon: '💨', color: '#a8e05f',
    speed: 1, turns: 2,
    amountIs: 'speed',     // buffX = the speed change; negative is a slow
    aiValue: -6,
    negative: { id: 'slow', icon: '🐌', color: '#c9a8ff' },
  }),
  // Nothing below is applied by any ability yet - they are here as worked
  // examples of what the vocabulary buys, and as content to switch on when a
  // fight needs more to think about. Give an ability `buff: 'poison'` and it
  // works; no engine change is involved.
  poison: S({
    name: 'Poisoned', icon: '🧪', color: '#8fd14f',
    tickDamage: 2, turns: 3,
    amountIs: 'tickDamage',   // buffX = damage per turn
    aiValue: 20,              // three ticks of 2, valued a little under the 60 they cost
  }),
  regen: S({
    name: 'Mending', icon: '🌿', color: '#a8e05f',
    tickHeal: 2, turns: 3,
    amountIs: 'tickHeal',
    aiValue: -18,
  }),
  weaken: S({
    name: 'Weakened', icon: '🩼', color: '#b58fd1',
    damageDealt: 0.5, turns: 2,
    amountIs: 'damageDealt',
    aiValue: 16,
  }),
  vulnerable: S({
    name: 'Vulnerable', icon: '🎯', color: '#e2474b',
    damageTaken: 1.5, turns: 2,
    amountIs: 'damageTaken',
    aiValue: 18,
  }),
  enraged: S({
    name: 'Enraged', icon: '🤬', color: '#e2474b',
    damageTaken: 1.5, turns: 2,
    amountIs: 'speed',
    aiValue: 18,
  }),
};

// The table is part of the combat config as well, so the Settings window can edit
// it at runtime. Same object, not a copy: the engine reads config.statuses and the
// UI imports STATUSES, and both see an edit the moment it is made.
COMBAT_CONFIG.statuses = STATUSES;

export const statusById = (id) => STATUSES[id] ?? null;
// The amount an ability hands a status: its buffX where the status takes one,
// otherwise the status's own default for that field.
export function statusAmount(id, buffX) {
  const def = STATUSES[id];
  if (!def) return 0;
  if (!def.amountIs) return 0;
  const n = Number(buffX);
  return Number.isFinite(n) && buffX !== undefined && buffX !== null ? n : def[def.amountIs];
}

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

// ----- Per-unit combat stats -------------------------------------------
// Looked up by unit NAME (party and enemies share the table); numbered clones
// ("Husk 2") fall back to their base name, anything unknown to `default`.
// init = enemy turn order (higher acts first), speed = move points per turn
// (uphill steps cost 2), flying ignores height and glides over anything.
export const UNIT_COMBAT = {
  default: { init: 5, speed: 4, flying: false, abilities: ['strike'] },
  // party roster - exactly TWO abilities per character: each drives its own
  // upgrade tree (config/upgrades.js), and the roster's detail window and the
  // party panel are laid out for the pair.
  Vanguard: { init: 5, speed: 4, flying: false, abilities: ['strike', 'shove'] },
  Archer: { init: 7, speed: 4, flying: false, abilities: ['volley', 'lance'] },
  Mystic: { init: 4, speed: 3, flying: false, abilities: ['burst', 'mend'] },
  Warden: { init: 6, speed: 4, flying: false, abilities: ['strike', 'guard'] },
  Stonestep: { init: 3, speed: 3, flying: false, abilities: ['strike', 'shove'] },
  Emberwright: { init: 5, speed: 3, flying: false, abilities: ['burst', 'strike'] },
  Lampbearer: { init: 6, speed: 4, flying: false, abilities: ['mend', 'bolt'] },
  Skywatcher: { init: 8, speed: 5, flying: true, abilities: ['volley', 'lance'] },
  Tinker: { init: 5, speed: 4, flying: false, abilities: ['shove', 'bolt'] },
  Duskblade: { init: 9, speed: 5, flying: false, abilities: ['strike', 'lance'] },
  // NOTE: enemies are NOT listed here any more. Since 2026-09-01 a bestiary row
  // in config/units.js (battle.enemyTypes) carries a creature's init, speed,
  // flying and abilities alongside its body and numbers, so an enemy is defined
  // in exactly ONE place and the Settings window can invent a new one. This
  // table is now the PARTY's, plus `default` as the last-resort fallback for a
  // hand-authored def that names neither.
};

// Combat stats for a unit by its display name ("Husk 2" -> "Husk").
export function combatStatsFor(name) {
  const base = String(name ?? '').replace(/ \d+$/, '');
  return UNIT_COMBAT[base] ?? UNIT_COMBAT.default;
}
export const abilityById = (id) => ABILITIES[id] ?? null;
export const tagDefById = (id) => COMBAT_TAGS[id] ?? null;
export { DIRS };
