// =====================================================================
//  WORLD CONFIG - the map, its tile types, biomes and the generation noise.
//  (Part of the config split: world.js / encounters.js / units.js / config.js)
// =====================================================================

export const WORLD = {
  // ----- Map shape ---------------------------------------------------
  map: {
    radius: 11,             // rings of hexes around the centre tile (7 = 169 tiles, 9 = 271, 11 = 397)
    orientation: 'pointy',  // 'pointy' (corner points up the screen) or 'flat' (flat edge up)
    hexSize: 1.0,           // distance from hex centre to a corner, in world units
    gap: 0.08,              // empty space between neighbouring tiles (world units)
    tileHeight: 0.35,       // thickness of a revealed tile
    // (Stasis Seed / Colony placement lives in config/encounters.js under "stasis".)
  },

  // ----- Tile types ----------------------------------------------------
  // A tile = a TYPE (material / height, all the gameplay numbers) + a BIOME (colour).
  // "passable: false" tiles block movement. "supplyCost" = supplies spent to step
  // INTO that tile (0 for ordinary ground), "hpCost" = HP every living unit loses,
  // "revealBonus" = extra reveal radius when standing there.
  // "terrainHeight" = how far away this type can be seen from: a tile is revealed
  // when its distance <= revealRadius + terrainHeight. "height" is the visual thickness.
  // Types are assigned by the elevation noise (see "noise" below). Ether is a HOLE
  // in the world: the renderer draws no mesh there at all - the camera looks straight
  // down into the void - and the wither never spreads into it. It stays in the map
  // data (impassable for now) so later mechanics can make it navigable.
  tileTypes: {
    ether: { passable: false, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 0, color: 0x0d1020, height: 0, biomeTint: false },
    water: { passable: false, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 1, color: 0x3c7dc4, height: 0.18, biomeTint: false },
    ground: { passable: true, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 0, color: 0x4d4f46, height: 0.35, biomeTint: true },
    hill: { passable: true, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 1, color: 0x8f8d74, height: 0.55, biomeTint: true },
    mountain: { passable: true, supplyCost: 10, hpCost: 5, revealBonus: 2, terrainHeight: 2, color: 0xb0bbc8, height: 0.95, biomeTint: true },
  },

  // ----- Biomes ---------------------------------------------------------
  // Mostly colour. The final tile colour = the type colour shifted towards the
  // biome colour (a lerp by colors.biomeTintAmount in config.js - no
  // multiplication, so nothing gets darker). Types with biomeTint: false ignore it.
  // Optional biome fields (all off by default):
  //  * generated: false - worldgen never places it; something in play applies it
  //  * hpCost / terrainHeight - ADDED on top of the tile type's numbers
  //  * tintAmount - overrides colors.biomeTintAmount for this biome (1 = full recolour)
  //  * tintAllTypes: true - recolours even types with biomeTint: false (e.g. water)
  biomes: {
    grasslands: { color: 0x62c454 },
    forest: { color: 0x135b32 },
    mesa: { color: 0xc4622e },
    desert: { color: 0xe0b360 },
    dunes: { color: 0xf0dca2 },
    tundra: { color: 0xd8ecf4 },
    // Wither is not born with the world: the Stasis paints it over tiles during the
    // run (see game.js witherNear). The tile keeps its TYPE - its shape and movement
    // rules - but turns Stasis-purple, hurts to step onto and is seen from 1 further.
    // Withered water dries into walkable ground; ether is never withered.
    wither: { color: 0x3b2a6e, generated: false, hpCost: 1, terrainHeight: 1, tintAmount: 0.5, tintAllTypes: true },
  },

  // ----- Generation noise ------------------------------------------------
  // Three independent multi-octave Perlin fields (all seeded). Each field is
  // rank-normalised across the map (lowest tile -> 0, highest -> 1), so the level
  // knobs below read as approximate SHARES OF THE MAP:
  //  * elevation decides the type: the lowest waterLevel of tiles become water,
  //    tiles above hillLevel become hills, above mountainLevel mountains;
  //  * ether pokes holes: tiles above etherLevel in their own field become ether;
  //  * biome cuts its field into equal bands, one per biome, in the order the
  //    biomes are listed above (so every map gets a bit of everything).
  // "frequency" is the main dial: higher = smaller, busier features.
  noise: {
    elevation: { frequency: 0.15, octaves: 4, persistence: 0.5 },
    waterLevel: 0.12,
    hillLevel: 0.7,
    mountainLevel: 0.9,
    ether: { frequency: 0.05, octaves: 3, persistence: 0.2 },
    etherLevel: 0.8,
    biome: { frequency: 0.05, octaves: 2, persistence: 0.5 },
  },
};
