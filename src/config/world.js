// =====================================================================
//  WORLD CONFIG - the map and its terrain.
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
    // Bosses: how many, and the rings they may sit on. "bossMinRing: 'half'" means
    // floor(radius / 2); a number is used as-is. Bosses are kept at least
    // bossMinSpacing tiles apart from each other.
    bossCount: 3,
    bossMinRing: 'half',
    bossMinSpacing: 4,
  },

  // ----- Terrain -----------------------------------------------------
  // Chances are relative weights, they do not need to add up to 1.
  // "passable: false" tiles block movement. "supplyCost" = supplies spent to step
  // INTO that tile (0 for ordinary ground), "hpCost" = HP every living unit loses,
  // "revealBonus" = extra reveal radius when standing there.
  // "terrainHeight" = how far away this terrain can be seen from: a tile is revealed
  // when its distance <= revealRadius + terrainHeight (so mountains with 2 show up from
  // 2 tiles away even with revealRadius 0). "height" is only the visual thickness.
  // Legend descriptions are generated from these numbers (text.js) and the locale
  // tables (terrain.<name>.flavour), so they never go out of date.
  terrain: {
    grass: { weight: 0.46, passable: true, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 0, color: 0x7fb85f, height: 0.35 },
    forest: { weight: 0.22, passable: true, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 0, color: 0x3e7d45, height: 0.42 },
    hills: { weight: 0.14, passable: true, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 1, color: 0xb79a63, height: 0.55 },
    water: { weight: 0.10, passable: false, supplyCost: 0, hpCost: 0, revealBonus: 0, terrainHeight: 0, color: 0x3c7dc4, height: 0.18 },
    mountain: { weight: 0.08, passable: true, supplyCost: 10, hpCost: 5, revealBonus: 2, terrainHeight: 2, color: 0x8e929c, height: 0.95 },
  },
};
