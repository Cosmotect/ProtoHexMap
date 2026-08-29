// =====================================================================
//  TUTORIAL MAP 2 - "The Fork".
//
//  A Y-shaped island: two roads to the same waypoint. The LEFT one is short
//  but climbs - a hill (supplies) and a mountain (supplies + blood) teach that
//  terrain has a price. The RIGHT one is long but flat, with a shop and a
//  cache that pays for its stock. Fatigue is compressed (configPatch) and a
//  scripted ambush fires a few steps in, whichever road was taken - the bar
//  fills, then the road strikes first. The waypoint is guarded by a fight on
//  an AUTHORED arena: the enemies start on a high plateau (recipe heights +
//  fixed spawns), so high ground - and shoving people off it - teaches itself.
// =====================================================================

// The guard fight's arena: a plateau in the middle, enemies on top of it, the
// party approaching from the low south side. One plateau edge drops straight
// to the floor - standing next to it invites a shove.
const GUARD_ARENA = {
  tiles: {
    '0,0': { elevation: 2 }, '1,-1': { elevation: 2 }, '1,0': { elevation: 2 },
    '0,-1': { elevation: 2 }, '2,-1': { elevation: 2 },
    // A ramp on the south-west side: the honest way up costs movement.
    '-1,1': { elevation: 1 }, '0,1': { elevation: 1 },
  },
  spawns: {
    enemies: ['0,0', '1,-1', '2,-1'],
    party: ['-1,3', '0,3', '1,2'],
  },
};

export const TUTORIAL_2 = {
  id: 'tutorial2',
  start: '0,0',
  tiles: {
    // The stem.
    '0,0': { type: 'ground', biome: 'grasslands', revealed: true },
    '1,0': { type: 'ground', biome: 'grasslands' },
    '2,-1': { type: 'ground', biome: 'grasslands' },   // the fork
    // LEFT road: short and steep.
    '3,-2': { type: 'hill', biome: 'mesa' },
    '4,-3': { type: 'mountain', biome: 'mesa' },
    '5,-3': { type: 'ground', biome: 'mesa' },
    // RIGHT road: long and flat, with things to buy and find. The 4th tile of
    // either road is EMPTY on purpose: the scripted ambush needs a clear tile,
    // so it lands at the same beat whichever way the player went.
    '3,-1': { type: 'ground', biome: 'forest' },
    '4,-1': { type: 'ground', biome: 'forest' },       // (the ambush lands here)
    '5,-2': { type: 'ground', biome: 'forest' },       // the shop
    '6,-2': { type: 'ground', biome: 'forest' },       // the cache
    // The roads meet before the waypoint.
    '6,-3': { type: 'ground', biome: 'tundra' },       // the guard fight
    '7,-4': { type: 'ground', biome: 'tundra' },       // the waypoint
  },
  encounters: {
    '5,-2': { type: 'shop', stock: ['rest', 'upgrade'] },
    '6,-2': { type: 'treasure', supplies: 40 },
    '6,-3': {
      type: 'battle',
      enemies: [
        { name: 'Raider', hp: 18, power: 3 },
        { name: 'Stalker', hp: 16, power: 3 },
        { name: 'Husk', hp: 14, power: 0 },
      ],
      recipe: GUARD_ARENA,
    },
    '7,-4': { type: 'goal' },
  },
  supplies: 25,
  maxSupplies: 60,
  // Fatigue, compressed so its lesson fits a ten-tile island: the bar fills
  // fast and the scripted ambush lands right where the bar says it should.
  configPatch: {
    'fatigue.byStep': { 2: 0, 3: 30, 4: 70, 5: 100 },
  },
  ambushes: [
    { afterSteps: 4, enemies: [{ name: 'Husk', hp: 12, power: 0 }, { name: 'Husk', hp: 12, power: 0 }] },
  ],
  goal: { type: 'reach', tile: '7,-4' },
  next: 'tutorial3',
  cards: [
    { id: 'fatigue', at: 'start', target: { el: '#fatigue-bar' } },
    { id: 'fork', at: 'arrive', tile: '2,-1', target: { tile: '3,-2' } },
    { id: 'ambush', at: 'forced', target: { el: '#fatigue-bar' } },
    { id: 'shop', at: 'arrive', tile: '5,-2', target: { el: '#btn-enter' } },
    { id: 'highground', at: 'arrive', tile: '6,-3', target: { marker: '6,-3' } },
  ],
};
