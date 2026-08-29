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
    },
    guaranteed: { acolyte: 1 },   // ...but at least this many per map
    // Visual placeholders. "shape" is one of: octahedron, icosahedron, box, cone, dodecahedron
    // Labels and descriptions live in the locale tables (visual.<type>.label / .info).
    visuals: {
      battle: { color: 0xe2474b, shape: 'octahedron' },
      event: { color: 0xa56cf5, shape: 'icosahedron' },
      rest: { color: 0xff9f43, shape: 'cone' },
      shop: { color: 0x45c7d1, shape: 'box' },
      treasure: { color: 0xf5c542, shape: 'dodecahedron' },
      stasisSeed: { color: 0x9b1c31, shape: 'cone' },
      stasisColony: { color: 0x6e2c8f, shape: 'cone' },
      acolyte: { color: 0xfff3b0, shape: 'icosahedron' },
      // The waypoint that completes a scenario (tutorial) map. Never generated on
      // normal maps, so it is hidden from the legend.
      goal: { color: 0x9fd9ff, shape: 'cone', hidden: true },
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
  // removes its debuff and lets the player raise a chosen unit's power "rewardPicks" times.
  stasis: {
    seedMinRing: 'half',      // the Seed sits on the outer rings: 'half' = floor(radius / 2)
    colonyCount: 4,
    minSpacing: 5,            // min distance between Colony sites and from the Seed (their only placement rule)
    lineSpeed: 0.5,           // tiles per player turn each line grows
    witherEvery: 2,           // turns per withered tile, per active source
    rewardPicks: 2,           // power raises granted for clearing a Colony
    // The debuff pool. Each Colony rolls one id; values are read by the battle code.
    debuffs: {
      maxHp: { fraction: 0.25 },     // party max HP reduced by this fraction (per stack)
      power: { amount: 6 },          // party power reduced by this much (per stack)
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
  //   upgrade    +upgradeAmount power on a chosen unit ("Power")
  //   map        reveals events.blobSize tiles nearby ("Information")
  //   rest       exactly a player-built camp: heals rest.healFraction and resets fatigue
  //   relic      for now identical to "upgrade": +upgradeAmount power on a chosen unit
  //   rumors     reveals events.rumorsCount hidden battles within events.rumorsRadius
  //   spareParts the Acolyte's service: one disabled unit returns at acolyte.reviveFraction HP
  shop: {
    guaranteed: ['upgrade', 'map'],
    pool: ['rest', 'relic', 'rumors', 'spareParts'],
    randomCount: 2,
    upgradeCost: 25,
    upgradeAmount: 3,         // shared by "upgrade" and "relic"
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
    scholarPower: 3,          // +power for ONE random living unit
    blackMarketHpFraction: 1 / 3,  // max HP sacrificed...
    blackMarketPower: 6,           // ...for this much power
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
