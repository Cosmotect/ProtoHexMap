// =====================================================================
//  TUTORIAL MAP 3 - "The Withering".
//
//  The Stasis, compressed onto a small open island where all of it is visible
//  at once: a mini-Seed in plain sight, ONE Colony line crawling towards its
//  site on a fixed schedule, and land that rots a tile per source per turn -
//  the pressure lesson happens in front of the player's eyes, no text needed.
//  Two ordinary fights sit side by side on the absolute danger scale - a
//  no-chevron skirmish and a 2-chevron wall guarding a cache - the
//  risk-reading lesson, strictly optional (the Colony always wears 3
//  chevrons and the Seed 5, per config.battle.danger).
//  Clearing the Colony lifts its max-health curse; destroying the Seed wins
//  the map and completes the tutorial.
//
//  Everything is revealed from the start: the fog had its lesson on map 1;
//  this map is about watching the clock tick.
// =====================================================================
import { hexesInRange, hexKey } from '../hex.js';

// A full radius-3 island, all revealed; special tiles are patched below.
function buildTiles() {
  const tiles = {};
  for (const [q, r] of hexesInRange(0, 0, 3)) {
    tiles[hexKey(q, r)] = { type: 'ground', biome: 'grasslands', revealed: true };
  }
  // A little relief so the island does not read as a disc.
  tiles['0,-3'] = { type: 'hill', biome: 'grasslands', revealed: true };
  tiles['-3,1'] = { type: 'hill', biome: 'forest', revealed: true };
  tiles['2,1'] = { type: 'water', biome: 'grasslands', revealed: true };
  return tiles;
}

export const TUTORIAL_3 = {
  id: 'tutorial3',
  start: '0,0',
  tiles: buildTiles(),
  encounters: {
    // The mini-Seed: the win condition, visible from the first second.
    '3,-3': {
      type: 'stasisSeed',
      title: 'Stasis Sprout',
      enemies: [
        { name: 'Stasis Sprout', hp: 60, power: 9 },
        { name: 'Stasis Mote', hp: 20, power: 3 },
        { name: 'Stasis Mote', hp: 20, power: 3 },
      ],
    },
    // The chevron contrast: a bare skirmish (0 chevrons) and a 2-chevron wall,
    // side by side; the wall guards a cache. Optional - a lesson in reading.
    '-2,0': { type: 'battle', enemies: [{ name: 'Husk', hp: 14, power: 3 }, { name: 'Husk', hp: 14, power: 3 }] },
    '-1,3': {
      type: 'battle',
      enemies: [
        { name: 'Raider', hp: 18, power: 10 }, { name: 'Stalker', hp: 16, power: 10 },
        { name: 'Husk', hp: 14, power: 6 }, { name: 'Husk', hp: 14, power: 6 }, { name: 'Husk', hp: 14, power: 6 },
      ],
    },
    '-2,3': { type: 'treasure', supplies: 40 },
  },
  // One scripted Colony: its line arrives on turn 6, its garrison is authored,
  // its curse is the most VISIBLE one - the party's health bars shrink.
  stasis: {
    colonies: [
      {
        site: '-2,2',
        arriveTurn: 6,
        debuff: 'maxHp',
        title: 'Rot Chorus',
        enemies: [
          { name: 'Rot Chorister', hp: 16, power: 6 }, { name: 'Rot Chorister', hp: 16, power: 6 },
          { name: 'Rot Chorister', hp: 16, power: 6 }, { name: 'Rot Chorister', hp: 16, power: 6 },
        ],
      },
    ],
  },
  supplies: 40,
  maxSupplies: 60,
  // The clock, compressed: the line walks one tile of its length per turn and
  // every active source rots one tile per turn.
  configPatch: {
    'stasis.lineSpeed': 1,
    'stasis.witherEvery': 1,
  },
  goal: { type: 'seed' },
  next: null,   // the chain ends here - the next stop is a real run
  cards: [
    { id: 'seed', at: 'start', target: { marker: '3,-3' } },
    { id: 'danger', at: 'start', target: { marker: '-1,3' } },
    { id: 'wither', at: 'wither' },
    { id: 'colony', at: 'colony', target: { marker: '-2,2' } },
  ],
};
