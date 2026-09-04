// =====================================================================
//  ENCOUNTER CONFIG - what sits on the tiles and what engaging it does,
//  plus fatigue (the rule that forces encounters on a tired party).
//  (Part of the config split: world.js / encounters.js / units.js / config.js)
// =====================================================================

export const ENCOUNTERS = {
  // ----- Placement ----------------------------------------------------
  // "density" = chance that a normal passable tile holds an encounter.
  // "weights" decide which type it is.
  encounters: {
    density: 0.5,
    minDistanceFromStart: 0,  // tiles this close to the start (centre) stay empty (0 = only the start tile itself)
    // (rest sites are no longer generated: the player builds them, see "rest" below)
    weights: {
      battle: 5,
      event: 2,
      shop: 0.75,
      treasure: 0.8,
      acolyte: 0.15,   // very rare as a random roll...
      // The layer gate: EXTREMELY rare - most maps have none, and "unique"
      // below caps it at one. Entering it unlocks the next layer of the
      // worldflake (config.layers.unlockOrder; the chain is meta-progression,
      // remembered by the browser across runs).
      gate: 1,
    },
    guaranteed: { acolyte: 1 },   // ...but at least this many per map
    unique: ['gate'],             // types that appear at most ONCE per map
    // Visual placeholders. "shape" is one of: octahedron, icosahedron, box, cone,
    // dodecahedron, pyramid. Labels and descriptions live in the locale tables
    // (visual.<type>.label / .info).
    visuals: {
      battle: { color: 0xe2474b, shape: 'octahedron' },
      event: { color: 0xa56cf5, shape: 'icosahedron' },
      rest: { color: 0xff9f43, shape: 'cone' },
      shop: { color: 0x45c7d1, shape: 'box' },
      treasure: { color: 0xf5c542, shape: 'dodecahedron' },
      stasisSeed: { color: 0x9b1c31, shape: 'cone' },
      stasisColony: { color: 0x6e2c8f, shape: 'cone' },
      acolyte: { color: 0xfff3b0, shape: 'icosahedron' },
      gate: { color: 0x35d17a, shape: 'pyramid' },   // the green pyramid
      // The waypoint that completes a scenario (tutorial) map. Never generated on
      // normal maps, so it is hidden from the legend.
      goal: { color: 0x9fd9ff, shape: 'cone', hidden: true },
    },
  },

  // ----- Handcrafted local maps (map codes) ----------------------------
  // Authored arenas for encounters that open a local map. When such an
  // encounter is placed at world generation it rolls `rate` to use a crafted
  // map instead of the random generator; a crafted battle also brings its own
  // enemies (they REPLACE the rolled group) and may declare its own danger
  // chevrons. Parsed by src/local/mapcode.js; paste any of these codes into
  // Menu -> Preview map code to walk around it.
  //
  // MAP CODE FORMAT - one line per statement, '#' starts a comment:
  //   id: <name>            required, the map's id
  //   radius: <n>           optional, rings of local hexes (default config.local.radius)
  //   danger: <n>           optional, chevrons the world tile shows (battle maps)
  //   q,r: <type> [elevation] [tags...] [!Enemy Name]
  // Tile lines list only the tiles that differ from plain ground at the
  // neutral elevation (2); everything unlisted stays that. Types: ground,
  // wall (blocks walking, pushes crash on it), ether (a hole: pushes into it
  // kill). Elevation is a level 0..4 (walls default to 4, ether needs none).
  // Tags are tile tag ids from src/config/abilities.js (e.g. fire). '!' pins
  // an enemy from the bestiary (config/units.js battle.enemyTypes, by id or
  // display name) to the tile; the rest of the line is its name.
  craftedMaps: {
    combat: {
      rate: 0.25,             // chance a battle encounter uses a crafted map
      maps: [
`# A sunken ether trench splits the arena; the only way across is a walled
# causeway held by raiders, with braziers of fire guarding the mouth.
id: the-causeway
radius: 4
danger: 1
1,-4: ether
1,-3: ether
1,-2: ether
1,1: ether
1,2: ether
1,3: ether
1,-1: ground 2
1,0: ground 2
0,-1: wall 4
0,1: wall 4
2,-2: wall 4
2,0: wall 4
0,0: ground 2 fire
2,-1: ground 2 fire
2,1: ground 3
3,-1: ground 3 !Raider
3,-3: ground 3 !Raider
2,2: ground 3 !Husk
3,0: ground 4 !Drifter`,
`# A ring of high ground around a burning hollow: whoever holds the rim
# rains shots down; whoever falls in fights out of a firepit.
id: ember-hollow
radius: 6
danger: 2
0,0: ground 0 fire
1,0: ground 0
0,1: ground 0 fire
-1,1: ground 0
-1,0: ground 1
0,-1: ground 1 fire
1,-1: ground 1
2,-1: ground 3
2,0: ground 3
1,1: ground 3
0,2: ground 3
-1,2: ground 3
-2,2: ground 3
-2,1: ground 3
-2,0: ground 3
-1,-1: ground 3
0,-2: ground 3
1,-2: ground 3
2,-2: ground 3
3,0: wall 4
0,3: wall 4
-3,3: wall 4
-3,0: wall 4
0,-3: wall 4
3,-3: wall 4
4,-2: ground 2 !Brute
-2,4: ground 2 !Stalker
-2,-2: ground 2 !Husk
4,0: ground 2 !Husk`,
      ],
    },
    shop: {
      rate: 0.25,             // shops do not open a local map yet: the recipe is
                              // stored on the tile now so the flow can use it later
      maps: [
`# A calm terraced hollow for a wayside trader: no enemies, just a bowl of
# steps sheltered by two standing stones.
id: wayside-hollow
radius: 3
0,0: ground 1
1,0: ground 1
0,1: ground 1
1,-1: ground 2
-1,1: ground 2
-1,0: ground 2
0,-1: ground 2
2,0: ground 3
0,2: ground 3
-2,2: ground 3
-2,0: ground 3
0,-2: ground 3
2,-2: ground 3
3,-1: wall 4
-3,2: wall 4`,
      ],
    },
  },

  // ----- The Stasis ----------------------------------------------------
  // A single Stasis Seed spawns with the map; destroying it wins the run.
  // Four future Colony sites are picked at generation. After every player turn a line
  // grows from the Seed towards each site by "lineSpeed" tiles; when it arrives, the
  // Stasis Colony encounter spawns there (never in the same instant the player steps
  // onto the tile - spawning happens after the arrival is fully resolved).
  // Both the Seed and every active Colony wither the land around them: each gains
  // 1 / witherEvery "charge" per turn and spends 1 charge to turn one nearby
  // non-wither tile into wither terrain. There is no range limit: the rot creeps
  // outward until the whole map is withered - confront the Stasis or lose the land.
  // Each Colony carries one random debuff from "debuffs"; while the Colony is active
  // its debuff also applies to the Seed fight (duplicates stack). Clearing a Colony
  // removes its debuff and grants "rewardPicks" ability upgrade picks.
  stasis: {
    seedMinRing: 'half',      // the Seed sits on the outer rings: 'half' = floor(radius / 2)
    colonyCount: 4,
    minSpacing: 5,            // min distance between Colony sites and from the Seed (their only placement rule)
    lineSpeed: 0.5,           // tiles per player turn each line grows
    witherEvery: 2,           // turns per withered tile, per active source
    rewardPicks: 2,           // ability upgrade picks granted for clearing a Colony
    // The debuff pool. Each Colony rolls one id; values are read by the battle code.
    debuffs: {
      maxHp: { fraction: 0.25 },     // party max HP reduced by this fraction (per stack)
      damage: { amount: 2 },         // party ability damage reduced by this much (per stack)
      extraEnemies: { count: 2 },    // extra regular enemies join the fight (per stack)
    },
  },

  // ----- Rest site (built by the player) -----------------------------
  rest: {
    cost: 20,                 // supplies spent to make camp on an empty tile
    healFraction: 0.5,        // each living unit heals this fraction of its max HP
  },

  // ----- Acolyte of the Great Forge -----------------------------------
  acolyte: {
    reviveFraction: 0.5,      // a restored unit comes back with this fraction of max HP
  },

  // ----- Shop ---------------------------------------------------------
  // Every shop stocks the "guaranteed" options plus "randomCount" options drawn (seeded,
  // at map creation) from "pool". Each option can be bought ONCE per shop; sold-out
  // options stay in the window greyed out. Once a shop has been entered, hovering its
  // tile (from anywhere on the map) lists what it still sells.
  // Option ids and what they do:
  //   upgrade    one ability upgrade pick (the same chooser as a battle reward)
  //   map        reveals events.blobSize tiles nearby ("Information")
  //   rest       exactly a player-built camp: heals rest.healFraction and resets fatigue
  //   relic      for now identical to "upgrade": one ability upgrade pick
  //   rumors     reveals events.rumorsCount hidden battles within events.rumorsRadius
  //   spareParts the Acolyte's service: one disabled unit returns at acolyte.reviveFraction HP
  shop: {
    guaranteed: ['upgrade', 'map'],
    pool: ['rest', 'relic', 'rumors', 'spareParts'],
    randomCount: 2,
    upgradeCost: 25,
    mapCost: 15,
    restCost: 15,             // a shop bed is a little cheaper than pitching your own camp (rest.cost)
    relicCost: 25,
    rumorsCost: 15,
    sparePartsCost: 30,
  },

  // ----- Treasure -----------------------------------------------------
  treasure: { supplies: 40 },

  // ----- Event effects (see events.js for the texts) ------------------
  events: {
    blobSize: 8,              // tiles revealed by "Friendly pilgrim" and the shop's map purchase
    blobMaxDistance: 4,       // the blob starts within this distance of the party
    rumorsRadius: 3,
    rumorsCount: 3,
    vantageRadius: 2,
    vantageMountainRadius: 5,
    suppliesMin: 10,
    suppliesMax: 20,
    // "Wandering scholar": ONE random living unit unlocks one random available
    // ability upgrade. "Black market": a chosen unit sacrifices max HP for one.
    blackMarketHpFraction: 1 / 3,  // max HP sacrificed for the black market upgrade
    // "Merchant caravan" acts as a rest site: same healing as a camp (rest.healFraction).
  },

  // ----- Fatigue -----------------------------------------------------
  // Fatigue = chance (in %) that arriving on a tile WITH a forceable encounter forces
  // the party into it. It rises with the number of steps taken since the last reset.
  // The chance rolled on arrival is the fatigue shown in the HUD at the moment you
  // click (the value BEFORE the step); the step then raises it.
  // "byStep" maps a step number -> fatigue %. Steps missing from the table are
  // interpolated linearly between their neighbours; steps outside the table are
  // clamped to the first / last entry.
  fatigue: {
    // What engaging each encounter does to fatigue:
    //   'always'   resets it to 0
    //   'optional' may reset it (see the note), e.g. the shop only if you buy a rest
    //   'never'    leaves it alone
    // "camp" = making camp on an empty tile. Unlisted types count as 'never'.
    resetOn: {
      battle: 'always',
      stasisSeed: 'always',
      stasisColony: 'always',
      acolyte: 'always',
      camp: 'always',
      shop: 'optional',
      event: 'optional',
      treasure: 'never',
      gate: 'never',
    },
    // Notes for the 'optional' ones are in the locale tables (reset.note.<type>).
    // Which encounters fatigue can force the party into on arrival.
    forceable: ['battle', 'stasisSeed', 'stasisColony', 'event'],
    byStep: {
      4: 0,
      5: 5,
      6: 15,
      7: 30,
      8: 50,
      9: 75
    },
  },
};
