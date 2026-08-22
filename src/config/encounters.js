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
    density: 0.33,
    minDistanceFromStart: 1,  // tiles this close to the start (centre) stay empty
    // (rest sites are no longer generated: the player builds them, see "rest" below)
    weights: {
      battle: 5,
      event: 2,
      shop: 1,
      treasure: 0.8,
      acolyte: 0.15,   // very rare as a random roll...
    },
    guaranteed: { acolyte: 1 },   // ...but at least this many per map
    // Visual placeholders. "shape" is one of: octahedron, icosahedron, box, cone, dodecahedron
    visuals: {
      battle: { color: 0xe2474b, shape: 'octahedron', label: 'Battle' },
      event: { color: 0xa56cf5, shape: 'icosahedron', label: 'Event' },
      rest: { color: 0xff9f43, shape: 'cone', label: 'Rest site' },
      shop: { color: 0x45c7d1, shape: 'box', label: 'Shop' },
      treasure: { color: 0xf5c542, shape: 'dodecahedron', label: 'Treasure' },
      boss: { color: 0x9b1c31, shape: 'cone', label: 'Boss' },
      acolyte: { color: 0xfff3b0, shape: 'icosahedron', label: 'Acolyte of the Great Forge' },
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
  shop: {
    restCost: 35,             // resets fatigue
    upgradeCost: 25,          // +1 power on a chosen unit
    upgradeAmount: 1,
    mapCost: 15,              // reveals a small section of the map (events.blobSize tiles)
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
    scholarPower: 1,          // +power for ONE random living unit
    blackMarketHpFraction: 1 / 3,  // max HP sacrificed...
    blackMarketPower: 1,           // ...for this much power
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
      boss: 'always',
      acolyte: 'always',
      camp: 'always',
      shop: 'optional',
      event: 'optional',
      treasure: 'never',
    },
    resetNotes: {
      shop: 'only if you buy a rest there',
      event: 'only after specific events',
    },
    // Which encounters fatigue can force the party into on arrival.
    forceable: ['battle', 'boss', 'event'],
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
