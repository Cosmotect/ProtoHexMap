// =====================================================================
//  WORLD CONFIG - the map, its tile types, biomes and the generation noise.
//  (Part of the config split: world.js / encounters.js / units.js / config.js)
// =====================================================================

export const WORLD = {
  // ----- Map shape ---------------------------------------------------
  map: {
    radius: 11,             // rings of hexes around the centre tile (7 = 169 tiles, 9 = 271, 11 = 397)
    orientation: 'flat',    // 'flat' (flat edge up, default) or 'pointy' - the LOCAL map always uses the opposite
    hexSize: 1.0,           // distance from hex centre to a corner, in world units
    gap: 0.08,              // empty space between neighbouring tiles (world units)
    tileHeight: 0.35,       // thickness of a revealed tile
    // (Stasis Seed / Colony placement lives in config/encounters.js under "stasis".)
  },

  // ----- The worldflake's layers ---------------------------------------
  // The world is a stack of 8 layers around a core (0). A run happens on ONE
  // layer: it is an argument to the world generator, and for now it only swaps
  // the biome palette (each biome's color<N> below) - distinct enemies,
  // encounters and rules per layer come later. The rare "gate" encounter
  // unlocks the layers one by one in `unlockOrder` (meta-progression, stored in
  // the browser like the tutorial); once two are unlocked, the start screen
  // grows a layer selector whose switch plays the camera-roll cinematic.
  layers: {
    startLayer: 4,                              // where every new player begins
    unlockOrder: [4, 5, 3, 6, 2, 7, 1, 8, 0],   // gate unlocks walk this list; 0 = the core
    rollMs: 2600,                               // the layer-switch camera roll (start screen)
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
    water: { passable: false, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 1, color: 0x3c7dc4, height: 0.1, biomeTint: false },
    ground: { passable: true, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 0, color: 0x4d4f46, height: 0.25, biomeTint: true },
    hill: { passable: true, supplyCost: 3, hpCost: 0, revealBonus: 1, terrainHeight: 1, color: 0x8f8d74, height: 0.55, biomeTint: true },
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
  //  * color<N> - the colour this biome wears on LAYER N of the worldflake
  //    (0 = the core, 8 = the highest layer; the run starts on layers.startLayer).
  //    A layer without its own entry falls back to `color`. `color` doubles as
  //    the start layer's palette and the legend swatch.
  biomes: {
    grasslands: { color: 0x62c454, color0: 0x4a2550, color1: 0x9d2c31, color2: 0xb84396, color3: 0xc08049, color4: 0x62c454, color5: 0x8bd256, color6: 0x7e56c1, color7: 0x5bcaa0, color8: 0xa1b79e },
    forest: { color: 0x135b32, color0: 0x220b18, color1: 0x452809, color2: 0x50121c, color3: 0x555612, color4: 0x135b32, color5: 0x0c6818, color6: 0x541459, color7: 0x125361, color8: 0x355041 },
    mesa: { color: 0xc4622e, color0: 0x1b3a4a, color1: 0x4e1995, color2: 0x2c4bad, color3: 0xb02bba, color4: 0xc4622e, color5: 0xde2a21, color6: 0x31c0aa, color7: 0xc1d12c, color8: 0xa78d7f },
    desert: { color: 0xe0b360, color0: 0x213965, color1: 0x9c19cc, color2: 0x5248d7, color3: 0xdd52bd, color4: 0xe0b360, color5: 0xee9464, color6: 0x63cadc, color7: 0xb4e56a, color8: 0xcfc6b7 },
    dunes: { color: 0xf0dca2, color0: 0x263e82, color1: 0xcc35ec, color2: 0x9282e7, color3: 0xed90ce, color4: 0xf0dca2, color5: 0xf9d0b0, color6: 0xa3dbee, color7: 0xd3f4b1, color8: 0xf7f6f3 },
    tundra: { color: 0xd8ecf4, color0: 0x894f38, color1: 0xb4df6c, color2: 0xe8d9b5, color3: 0xcbeec6, color4: 0xd8ecf4, color5: 0xecfbfb, color6: 0xf3d8de, color7: 0xeae9f9, color8: 0xffffff },
    // Wither is not born with the world: the Stasis paints it over tiles during the
    // run (see game.js witherNear). The tile keeps its TYPE - its shape and movement
    // rules - but turns Stasis-purple, hurts to step onto and is seen from 1 further.
    // Withered water dries into walkable ground; ether is never withered.
    // Deliberately the SAME on every layer, so the rot always reads as the rot.
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
