// =====================================================================
//  LOCAL MAP - data only, no Three.js here.
//
//  The world map connects encounters; the LOCAL map is where an encounter
//  actually plays out. It is a hex grid like the world, but rotated: its hexes
//  use the OPPOSITE orientation, so one world tile visually breaks into a
//  sub-grid of local tiles (world flat-top -> local pointy-top).
//
//  This module is deliberately sandboxed from the world-map system: it knows
//  nothing about Game, fog, fatigue or encounters. It produces plain tile data;
//  src/local/localview.js draws it; src/local/transition.js flies the camera.
//  Local tiles have NO gameplay logic yet.
// =====================================================================
import { hexKey, hexesInRange, hexDistance, axialToPlane } from '../hex.js';

// The local grid uses the opposite orientation to the world grid.
export function localOrientation(worldOrientation) {
  return worldOrientation === 'flat' ? 'pointy' : 'flat';
}

/**
 * Builds the local map data.
 *   config  = CONFIG (reads config.local and config.map.orientation)
 *   recipe  = optional handcrafted map description (see applyRecipe below)
 * Returns { hexes: Map<key, tile>, radius, orientation, hexSize }
 * tile = { q, r, key, ring, x, y, elevation, type, decor }
 */
export function generateLocalMap(config, recipe = null) {
  const cfg = config.local;
  const orientation = localOrientation(config.map.orientation);
  const hexes = new Map();
  for (const [q, r] of hexesInRange(0, 0, cfg.radius)) {
    const plane = axialToPlane(q, r, cfg.hexSize, orientation);
    const tile = {
      q, r,
      key: hexKey(q, r),
      ring: hexDistance(q, r, 0, 0),
      x: plane.x,
      y: plane.y,
      elevation: 0,        // future: recipes raise / lower tiles
      type: 'ground',      // future: recipes set local tile types
      decor: null,         // future: set dressing (rocks, trees, ruins...)
    };
    hexes.set(tile.key, tile);
  }
  const map = { hexes, radius: cfg.radius, orientation, hexSize: cfg.hexSize };
  applyRecipe(map, recipe);
  return map;
}

/**
 * RECIPE HOOK (intentionally almost empty for now).
 *
 * The plan: every encounter gets a handcrafted "recipe" assigned when it spawns
 * on the world map - a coded description of the arena rather than a saved mesh:
 * per-tile types and elevations, set dressing, lighting conditions and so on.
 * The recipe is applied HERE, while the camera is still flying in, right before
 * the world/local visibility swap - so the arena is ready the instant it shows.
 *
 * Expected shape (subject to change when the first real recipes land):
 *   recipe = {
 *     tiles:   { 'q,r': { type, elevation, decor } },   // per-tile overrides
 *     lighting: { ... },                                // picked up by localview
 *   }
 */
export function applyRecipe(map, recipe) {
  if (!recipe) return map;
  for (const [key, patch] of Object.entries(recipe.tiles ?? {})) {
    const tile = map.hexes.get(key);
    if (tile) Object.assign(tile, patch);
  }
  map.lighting = recipe.lighting ?? null;
  return map;
}

/**
 * ELEVATION WAVE - gentle rolling heights for battle arenas.
 * Three overlapping sine waves with seeded phase offsets, snapped to whole
 * levels 0..levels (the combat rules read these as high/low ground). The camp
 * layout skips this: the start screen wants a flat, calm stage.
 */
export function applyElevationWave(map, random, levels) {
  const ph = [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2];
  for (const tile of map.hexes.values()) {
    const v = Math.sin(tile.q * 0.9 + ph[0])
            + Math.cos(tile.r * 0.8 + ph[1])
            + Math.sin((tile.q + tile.r) * 0.6 + ph[2]);
    // v runs -3..3; squash it onto 0..levels.
    tile.elevation = Math.max(0, Math.min(levels, Math.round(((v + 3) / 6) * levels)));
  }
  return map;
}

/**
 * Picks `count` distinct random tile keys, using the caller's rng function
 * (a () => number in [0,1)). `exclude` is a Set of keys to avoid.
 */
export function pickRandomTiles(map, count, random, exclude = new Set()) {
  const pool = [...map.hexes.keys()].filter((k) => !exclude.has(k));
  const picked = [];
  while (picked.length < count && pool.length) {
    const i = Math.floor(random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}
