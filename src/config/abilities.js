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
    elevationLevels: 3, // arena heights run 0..this
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
  // party roster
  Vanguard: { init: 5, speed: 4, flying: false, abilities: ['strike', 'shove', 'guard'] },
  Archer: { init: 7, speed: 4, flying: false, abilities: ['volley', 'lance'] },
  Mystic: { init: 4, speed: 3, flying: false, abilities: ['burst', 'mend'] },
  Warden: { init: 6, speed: 4, flying: false, abilities: ['strike', 'guard'] },
  Stonestep: { init: 3, speed: 3, flying: false, abilities: ['strike', 'shove'] },
  Emberwright: { init: 5, speed: 3, flying: false, abilities: ['burst', 'strike'] },
  Lampbearer: { init: 6, speed: 4, flying: false, abilities: ['mend', 'bolt'] },
  Skywatcher: { init: 8, speed: 5, flying: true, abilities: ['volley'] },
  Tinker: { init: 5, speed: 4, flying: false, abilities: ['shove', 'bolt'] },
  Duskblade: { init: 9, speed: 5, flying: false, abilities: ['strike', 'lance'] },
  // regular enemies
  Raider: { init: 6, speed: 4, flying: false, abilities: ['strike'] },
  Drifter: { init: 5, speed: 4, flying: false, abilities: ['volley'] },
  Husk: { init: 4, speed: 3, flying: false, abilities: ['strike'] },
  Stalker: { init: 7, speed: 5, flying: false, abilities: ['lance'] },
  // Stasis pools (colonies + bosses); unknown names use `default`
  'Forge Tyrant': { init: 6, speed: 4, flying: false, abilities: ['strike', 'burst'] },
  "Tyrant's Shadow": { init: 7, speed: 5, flying: false, abilities: ['lance'] },
  'Warden of the Rim': { init: 5, speed: 4, flying: false, abilities: ['strike', 'shove'] },
  'Choir Husk': { init: 4, speed: 3, flying: false, abilities: ['strike'] },
  'Ether Leviathan': { init: 6, speed: 3, flying: true, abilities: ['burst', 'bolt'] },
  'Pale Stalker': { init: 8, speed: 5, flying: false, abilities: ['lance'] },
  'Dark Stalker': { init: 8, speed: 5, flying: false, abilities: ['strike', 'shove'] },
  'Rot Chorus': { init: 5, speed: 4, flying: false, abilities: ['strike'] },
  'Stasis Brood': { init: 5, speed: 4, flying: false, abilities: ['strike'] },
};

// Combat stats for a unit by its display name ("Husk 2" -> "Husk").
export function combatStatsFor(name) {
  const base = String(name ?? '').replace(/ \d+$/, '');
  return UNIT_COMBAT[base] ?? UNIT_COMBAT.default;
}
export const abilityById = (id) => ABILITIES[id] ?? null;
export const tagDefById = (id) => COMBAT_TAGS[id] ?? null;
export { DIRS };
