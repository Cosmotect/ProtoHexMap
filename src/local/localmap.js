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
//
//  There is NO procedural arena any more (2026-09-16). This file builds the
//  bare grid - every tile plain ground at the neutral step - and lays a
//  handcrafted RECIPE over it (src/local/mapcode.js); every fight has one.
//  The old elevation wave (three seeded sine waves that rolled random heights
//  over a battle arena) is gone with the decision to ship only authored maps:
//  a fight without a recipe is simply flat.
// =====================================================================
import { hexKey, hexesInRange, hexDistance, axialToPlane } from '../hex.js';
import { COMBAT_CONFIG } from '../config/localmap.js';

// The local grid uses the opposite orientation to the world grid.
export function localOrientation(worldOrientation) {
  return worldOrientation === 'flat' ? 'pointy' : 'flat';
}

/**
 * THE NEUTRAL STEP. Elevations run 0..levels; the step in the MIDDLE of that
 * range is "ground level" - the height an untouched arena tile has, drawn flush
 * with the surrounding world tiles. Steps above it are raised, steps below it
 * are sunk. With elevationLevels = 4 this is 2, so an arena has two steps up
 * and two steps down around an unchanged middle.
 * Everything that turns a level into a visual height goes through this
 * (see LocalView.tileHeightFor).
 */
export function neutralElevation(levels = COMBAT_CONFIG.combat.elevationLevels) {
  return Math.floor(levels / 2);
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
  // A handcrafted map (src/local/mapcode.js) may come in any size: its radius
  // wins over the default arena size, and everything downstream reads the
  // radius off the returned map rather than the config.
  const radius = recipe?.radius ?? cfg.radius;
  const hexes = new Map();
  for (const [q, r] of hexesInRange(0, 0, radius)) {
    const plane = axialToPlane(q, r, cfg.hexSize, orientation);
    const tile = {
      q, r,
      key: hexKey(q, r),
      ring: hexDistance(q, r, 0, 0),
      x: plane.x,
      y: plane.y,
      elevation: neutralElevation(),  // the middle step = untouched ground level
                                      // (a recipe moves tiles up / down from here)
      type: 'ground',      // 'ground' | 'wall' | 'ether' - recipes set these
      tags: null,          // authored tile tag ids (e.g. ['fire']) - recipes set these
      decor: null,         // future: set dressing (rocks, trees, ruins...)
    };
    hexes.set(tile.key, tile);
  }
  const map = { hexes, radius, orientation, hexSize: cfg.hexSize };
  applyRecipe(map, recipe);
  return map;
}

/**
 * RECIPE HOOK. A recipe is a handcrafted arena description assigned to the
 * encounter when it spawns on the world map (src/local/mapcode.js builds one
 * from a map code; game.js rolls which encounters get one). It is applied
 * HERE, while the camera is still flying in, right before the world/local
 * visibility swap - so the arena is ready the instant it shows.
 *
 * Shape (see mapcode.js buildRecipe):
 *   recipe = {
 *     radius,                                        // handled by generateLocalMap above
 *     tiles: { 'q,r': { type, elevation, tags } },   // per-tile overrides
 *                     // type: 'ground' | 'wall' | 'ether'
 *                     // elevation is a LEVEL, 0..COMBAT_CONFIG.combat.elevationLevels.
 *                     // 2 = untouched ground, 3/4 = one/two steps up, 1/0 = one/two down.
 *     spawns: { enemies: [keys] },                   // read by LocalMapView.placeUnits
 *     startTags: [{ k, id }],                        // pre-lit tile tags (fire...)
 *     lighting: { ... },                             // future: picked up by localview
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

// (applyElevationWave - the random rolling heights - lived here until
// 2026-09-16. Arenas are handcrafted now; see the header.)

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

/**
 * Random tiles that stay TOGETHER: every pair of picked tiles is at most
 * `maxSpread` steps apart. This is how a party dropped into a fight it did not
 * choose (a fatigue ambush) lands - scattered, but still a group that can reach
 * each other, instead of one unit alone in a far corner.
 *
 * How: the first tile (the anchor) is free, and every pick afterwards narrows
 * the pool to the tiles still within range of EVERY tile already taken. A pick
 * near the rim, or a map broken up by walls / ether, can empty that pool before
 * the group is complete; the remaining units then fall back to whichever free
 * tile keeps the group TIGHTEST - the one whose farthest distance to any tile
 * already taken is smallest. That holds the party together even when no tile is
 * within range of everyone (the old fallback rolled a plain random tile and
 * could fling one unit many tiles away).
 */
export function pickClusteredTiles(map, count, random, exclude = new Set(), maxSpread = 6) {
  if (count <= 0) return [];
  const picked = [];
  let pool = [...map.hexes.values()].filter((t) => !exclude.has(t.key));
  while (picked.length < count && pool.length) {
    const t = pool[Math.floor(random() * pool.length)];
    picked.push(t);
    pool = pool.filter((o) => o.key !== t.key && hexDistance(o.q, o.r, t.q, t.r) <= maxSpread);
  }
  if (picked.length < count) {
    const used = new Set([...exclude, ...picked.map((t) => t.key)]);
    let free = [...map.hexes.values()].filter((t) => !used.has(t.key));
    // Greedily add the free tile that grows the group's spread the least: the
    // one whose WORST distance to any already-taken tile is smallest.
    while (picked.length < count && free.length) {
      let best = null, bestWorst = Infinity;
      for (const t of free) {
        let worst = 0;
        for (const p of picked) worst = Math.max(worst, hexDistance(t.q, t.r, p.q, p.r));
        if (worst < bestWorst) { bestWorst = worst; best = t; }
      }
      picked.push(best);
      free = free.filter((t) => t.key !== best.key);
    }
  }
  return picked.map((t) => t.key);
}
