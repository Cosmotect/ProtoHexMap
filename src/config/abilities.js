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
    // What the enemy AI thinks POPPING A SHIELD is worth, in its own scoring units
    // (a point of damage is worth 10, a kill 45, a stun 12). Without this the AI
    // scored a blocked hit as zero, refused to swing at a shielded unit at all, and
    // the shield - which only ever expires by blocking something - stayed up forever.
    shieldStripScore: 14,
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
  damage: 0, heal: 0, buff: '', buffX: 1,
  castZone: [], castAny: false, dmgZone: [], tagZone: [], tagId: null,
  hZone: [], hMode: 'rel', pushZone: [], rotatable: false, moveToTarget: false,
  spawnId: null, spawnZone: [],
}, o);

export const ABILITIES = {
  strike: A({ name: 'Strike', icon: '⚔️', color: '#e0b25f', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  shove: A({ name: 'Shove', icon: '🌀', color: '#ffd75f', damage: 1, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  volley: A({ name: 'Volley', icon: '🎯', color: '#a8e05f', damage: 2, castZone: ringOffsets(2, 4), dmgZone: [[0, 0]] }),
  lance: A({ name: 'Lance', icon: '⚡', color: '#5fc7e0', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [1, 0], [2, 0]], rotatable: true }),
  burst: A({ name: 'Ember Burst', icon: '🔥', color: '#ff9950', damage: 2, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1), tagZone: [[0, 0]], tagId: 'fire' }),
  bolt: A({ name: 'Bolt', icon: '☄️', color: '#c66dff', damage: 4, castZone: ringOffsets(1, 2), dmgZone: [[0, 0]] }),
  mend: A({ name: 'Mend', icon: '💫', color: '#a8e05f', heal: 4, castZone: ringOffsets(0, 1), dmgZone: [[0, 0]] }),
  guard: A({ name: 'Guard', icon: '🛡️', color: '#5fc7e0', buff: 'shield', castZone: ringOffsets(0, 1), dmgZone: [[0, 0]] }),
};

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
