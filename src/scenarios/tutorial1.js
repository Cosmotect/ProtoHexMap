// =====================================================================
//  TUTORIAL MAP 1 - "The Road".
//
//  A one-tile-wide corridor: the level itself does the teaching. Walking it
//  covers click-to-move and the fog; a single weak enemy blocks the only
//  bridge (the first fight, unavoidable); right after it a supply cache and a
//  widening in the road invite the wounded party to make camp; the glowing
//  waypoint at the end completes the map. No Stasis, no fatigue pressure, no
//  shops - those belong to the later maps.
//
//  This draft carries the layout and the scripted pieces; the slimmed guide
//  cards for it arrive with the next work request.
// =====================================================================

export const TUTORIAL_1 = {
  id: 'tutorial1',
  start: '0,0',
  // The corridor. Neighbouring steps only - there is never a second way forward
  // until the camp widening near the end.
  tiles: {
    '0,0': { type: 'ground', biome: 'grasslands', revealed: true },
    '1,0': { type: 'ground', biome: 'grasslands' },
    '2,-1': { type: 'ground', biome: 'grasslands' },
    '3,-1': { type: 'ground', biome: 'forest' },
    '4,-2': { type: 'ground', biome: 'forest' },     // the bridge: a fight blocks it
    '5,-2': { type: 'ground', biome: 'forest' },
    '6,-3': { type: 'ground', biome: 'grasslands' }, // the supply cache
    '6,-2': { type: 'ground', biome: 'grasslands' }, // the widening: room to camp
    '7,-3': { type: 'ground', biome: 'grasslands' },
    '7,-4': { type: 'ground', biome: 'grasslands' }, // (second half of the widening)
    '8,-4': { type: 'ground', biome: 'tundra' },
    '9,-4': { type: 'ground', biome: 'tundra' },     // the waypoint
  },
  encounters: {
    // One weak enemy: enough to teach move / aim / cast, never enough to kill.
    '4,-2': { type: 'battle', enemies: [{ name: 'Husk', hp: 14, power: 0 }] },
    // Exactly enough supplies appear for the camp the wounded party now wants.
    '6,-3': { type: 'treasure', supplies: 40 },
    '9,-4': { type: 'goal' },
  },
  // Tight pockets: the treasure exists to afford the camp, and the point is felt.
  supplies: 10,
  maxSupplies: 60,
  goal: { type: 'reach', tile: '9,-4' },
  next: null,   // tutorial2 hooks in here later
};
