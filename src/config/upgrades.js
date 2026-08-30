// =====================================================================
//  ABILITY UPGRADE TREES - one directed graph per ability.
//  (Part of the config split; resolved by src/upgrades.js.)
//
//  The party grows through these instead of a unit "power" number: every
//  reward pick unlocks one node of one ability's tree, and the ability is
//  re-derived from its base definition (config/abilities.js) plus every
//  unlocked node, in the fixed order the nodes are listed here.
//
//  Node format (all fields optional except where noted):
//    requires     [nodeIds]  - ALL of them must be unlocked first (multi-parent
//                              nodes are how two branches meet in a capstone);
//                              [] / absent = a root, available from the start
//    add          { damage, heal, buffX } - numeric bumps, summed onto the base
//    castZoneAdd  [offsets]  - extra tiles the ability may be aimed at
//    dmgZoneAdd   [offsets]  - extra tiles the effect covers (from the aim point)
//    tagZoneAdd   [offsets]  - extra tiles that receive the ability's tile tag
//    pushDistAdd  n          - every pushZone entry shoves n tiles further
//                              (the engine caps a single shove at 2 tiles)
//    flags        { bool }   - switches for upgrade-specific ability logic; the
//                              engine reads them off the resolved def (none are
//                              read yet - they arrive with the unique upgrades)
//
//  Display texts live in the locales as upgrade.<ability>.<node>.name / .desc.
//  The final game plans at least 16 characters / 32 trees; a tree is looked up
//  purely by ability id, so adding one is one entry here + its locale strings.
// =====================================================================
import { ringOffsets } from '../local/battle/bhex.js';

const U = (o) => Object.assign({
  requires: [], add: {}, castZoneAdd: [], dmgZoneAdd: [], tagZoneAdd: [],
  pushDistAdd: 0, flags: {},
}, o);

export const ABILITY_UPGRADES = {
  // Strike: melee jab. Branches: hit harder vs hit wider, meeting in Execute.
  strike: {
    edge: U({ add: { damage: 1 } }),
    weight: U({ add: { damage: 1 } }),
    reach: U({ requires: ['edge'], castZoneAdd: ringOffsets(2, 2) }),
    sweep: U({ requires: ['weight'], dmgZoneAdd: ringOffsets(1, 1) }),
    execute: U({ requires: ['reach', 'sweep'], add: { damage: 2 } }),
  },
  // Shove: the positioning tool. Distance and damage feed the capstone.
  shove: {
    jolt: U({ add: { damage: 1 } }),
    momentum: U({ pushDistAdd: 1 }),
    longarm: U({ requires: ['jolt'], castZoneAdd: ringOffsets(2, 2) }),
    impact: U({ requires: ['momentum'], add: { damage: 1 } }),
    avalanche: U({ requires: ['longarm', 'impact'], add: { damage: 2 } }),
  },
  // Volley: ranged single shot. Range out, range in, then a splash and a payoff.
  volley: {
    barbed: U({ add: { damage: 1 } }),
    farsight: U({ castZoneAdd: ringOffsets(5, 5) }),
    closework: U({ requires: ['barbed'], castZoneAdd: ringOffsets(1, 1) }),
    rain: U({ requires: ['farsight'], dmgZoneAdd: ringOffsets(1, 1) }),
    deadeye: U({ requires: ['closework', 'rain'], add: { damage: 2 } }),
  },
  // Lance: the rotating 3-tile line. Longer line, longer arm, harder hit.
  lance: {
    hone: U({ add: { damage: 1 } }),
    extend: U({ dmgZoneAdd: [[3, 0]] }),
    pike: U({ requires: ['hone'], castZoneAdd: ringOffsets(2, 2) }),
    drive: U({ requires: ['extend'], add: { damage: 1 } }),
    skewer: U({ requires: ['pike', 'drive'], add: { damage: 2 } }),
  },
  // Ember Burst: the fire AoE. Throw further, blast wider, burn wider.
  burst: {
    kindle: U({ add: { damage: 1 } }),
    lob: U({ castZoneAdd: ringOffsets(4, 4) }),
    spread: U({ requires: ['kindle'], dmgZoneAdd: ringOffsets(2, 2) }),
    scorch: U({ requires: ['lob'], tagZoneAdd: ringOffsets(1, 1) }),
    inferno: U({ requires: ['spread', 'scorch'], add: { damage: 1 } }),
  },
  // Bolt: the heavy single-target hit. Two damage steps, two range steps.
  bolt: {
    charge: U({ add: { damage: 1 } }),
    arc: U({ castZoneAdd: ringOffsets(3, 3) }),
    surge: U({ requires: ['charge'], add: { damage: 1 } }),
    farcast: U({ requires: ['arc'], castZoneAdd: ringOffsets(4, 4) }),
    thunder: U({ requires: ['surge', 'farcast'], add: { damage: 2 } }),
  },
  // Mend: the heal. Stronger, further, then a healing splash around the target.
  // (The splash heals every unit standing in it - stand apart from enemies.)
  mend: {
    soothe: U({ add: { heal: 1 } }),
    tend: U({ castZoneAdd: ringOffsets(2, 2) }),
    bloom: U({ requires: ['soothe'], dmgZoneAdd: ringOffsets(1, 1) }),
    mercy: U({ requires: ['tend'], add: { heal: 1 } }),
    renewal: U({ requires: ['bloom', 'mercy'], add: { heal: 2 } }),
  },
  // Guard: the shield. Learns to patch wounds and to reach further.
  guard: {
    patch: U({ add: { heal: 1 } }),
    brace: U({ castZoneAdd: ringOffsets(2, 2) }),
    surgeon: U({ requires: ['patch'], add: { heal: 1 } }),
    farward: U({ requires: ['brace'], castZoneAdd: ringOffsets(3, 3) }),
    aegis: U({ requires: ['surgeon', 'farward'], add: { heal: 2 } }),
  },
};
