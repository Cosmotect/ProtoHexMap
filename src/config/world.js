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
  // Types are assigned by the elevation noise (see "noise" below); wither is special:
  // never generated, the Stasis turns tiles into it during the run.
  tileTypes: {
    ether: { passable: false, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 0, color: 0x0d1020, height: 0.04, biomeTint: false },
    water: { passable: false, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 1, color: 0x3c7dc4, height: 0.18, biomeTint: false },
    ground: { passable: true, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 0, color: 0x93a56b, height: 0.35, biomeTint: true },
    hill: { passable: true, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 1, color: 0xa89a70, height: 0.55, biomeTint: true },
    mountain: { passable: true, supplyCost: 10, hpCost: 5, revealBonus: 2, terrainHeight: 2, color: 0x8e929c, height: 0.95, biomeTint: true },
    wither: { passable: true, supplyCost: 0, hpCost: 1, revealBonus: 0, terrainHeight: 1, color: 0x3b2a6e, height: 0.3, biomeTint: false },
  },

  // ----- Biomes ---------------------------------------------------------
  // Colour only, for now. The final tile colour = the type colour shifted towards
  // the biome colour (a lerp by colors.biomeInfluence in config.js - no
  // multiplication, so nothing gets darker). Types with biomeTint: false ignore it.
  biomes: {
    grasslands: { color: 0x62c454 },
    forest: { color: 0x1f6b38 },
    mesa: { color: 0xc4622e },
    desert: { color: 0xe0b360 },
    dunes: { color: 0xf0dca2 },
    tundra: { color: 0xd8ecf4 },
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
    elevation: { frequency: 0.14, octaves: 4, persistence: 0.5 },
    waterLevel: 0.12,
    hillLevel: 0.75,
    mountainLevel: 0.9,
    ether: { frequency: 0.11, octaves: 3, persistence: 0.5 },
    etherLevel: 0.88,
    biome: { frequency: 0.06, octaves: 2, persistence: 0.5 },
  },
};
