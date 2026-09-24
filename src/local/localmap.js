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
import { createRng } from '../rng.js';
import { DIRS, PK, addK, hexDist, boardTiles } from './battle/bhex.js';

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

// =====================================================================
//  THE HACK BOARD (the Hack terminal, config.hack - since 2026-09-24 part of
//  this file; it grew up as an experiment in src/local/hack/).
//
//  A hack is played on a completely FLAT board (every tile pinned to the
//  neutral elevation, which is exactly what switches the random wave off in
//  build), with the party seated here and NODES and MINES strewn EVENLY
//  over the rest. buildHackRecipe returns an ordinary recipe (the
//  handcrafted-map path above builds it with no special case) plus the node
//  / mine keys and each node's seeded hp roll; main.js builds the pieces
//  (HackNode / HackMine, local/battle/entity.js) from those and hands them
//  to the engine as `entities`.
//
//  THE SPREAD. Until 2026-09-24 the pieces went down by one of twenty
//  probabilistic LAYOUTS (clusters, rings, noise fields...), which read on
//  the board as splotches: heaps of nodes here, bare ground there. Now there
//  is one placer and it is a blue-noise spread: the pieces are thrown down
//  at random, but at the WIDEST spacing the board can fit that many pieces
//  at (found by stepping the spacing down until they all fit), so they end
//  up spaced out across the whole board at a steady density - never in
//  heaps, never leaving a quarter of it empty - while no two boards are
//  alike. `nodeSpacing` is the floor under that spacing: two nodes are never
//  nearer than it (2 = never adjacent). The first ring around the party is
//  always kept free of nodes and mines.
//
//  There are no handcrafted hack boards today; if some are wanted, they are
//  map codes and belong in config/encounters.js `craftedMaps`, next to the
//  combat and shop maps - not here.
// =====================================================================

const ringOf = (k) => { const [q, r] = PK(k); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)); };
const SQ3 = Math.sqrt(3);
// Plane coordinates with adjacent tiles one unit apart.
const xyOf = (k) => { const [q, r] = PK(k); return { x: q + r / 2, y: r * SQ3 / 2 }; };

/**
 * @param H          config.hack
 * @param seed       run seed (mixed with the world tile so every terminal differs)
 * @param hex        the world tile being entered ({ q, r })
 * @param partySize  living party members to seat
 * Returns { radius, tiles, spawns: { party, enemies }, nodeKeys, mineKeys, nodeHp, hack: true }.
 */
export function buildHackRecipe(H, seed, hex, partySize) {
  const R = H.radius;
  const rng = createRng(((seed ?? 1) ^ ((hex?.q ?? 0) * 83492791) ^ ((hex?.r ?? 0) * 29438141) ^ 0x4ac4) >>> 0);
  const all = boardTiles(R);
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

  // Flat: every tile at the neutral step. (A recipe that authors an elevation
  // is taken as the arena's whole height map, so no wave is added on top.)
  const neutral = neutralElevation();
  const tiles = {};
  for (const k of all) tiles[k] = { elevation: neutral };

  // ----- the party ------------------------------------------------------
  // 'centre': seated within partyRingMax of the middle. 'edge': a cluster on
  // one random side of the rim - the rim tile nearest a random bearing, then
  // its neighbours, working inwards as little as possible.
  const used = new Set();
  const party = [];
  if (H.partyStart === 'edge') {
    const partyAngle = rng.random() * Math.PI * 2;
    const rim = all.filter((k) => ringOf(k) >= R - 1);
    const angOf = (k) => { const p = xyOf(k); return Math.atan2(p.y, p.x); };
    const dA = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };
    rim.sort((a, b) => dA(angOf(a), partyAngle) - dA(angOf(b), partyAngle));
    const first = rim[0];
    party.push(first); used.add(first);
    const pool = all.filter((k) => ringOf(k) >= R - 2 && !used.has(k))
      .sort((a, b) => (hexDist(a, first) - hexDist(b, first)) || (dA(angOf(a), partyAngle) - dA(angOf(b), partyAngle)));
    for (const k of pool) { if (party.length >= partySize) break; party.push(k); used.add(k); }
  } else {
    const centreish = shuffle(all.filter((k) => ringOf(k) <= (H.partyRingMax ?? 1)));
    for (let i = 0; i < partySize && i < centreish.length; i++) { party.push(centreish[i]); used.add(centreish[i]); }
  }
  // The first ring around the party stays free of nodes and mines: the
  // opening turn should be a walk-and-choose, not a point-blank gift.
  const reserved = new Set(used);
  for (const k of used) for (const d of DIRS) reserved.add(addK(k, d));

  // ----- the even spread --------------------------------------------------
  // Dart throwing at the widest spacing that fits: the free tiles are
  // shuffled and walked in that order, a tile taken when nothing already
  // placed (of the same kind) is nearer than the spacing; if fewer than
  // `count` fit, the spacing steps down one and the throw is repeated. The
  // spacing the board settles on is what keeps the pieces apart from each
  // other at a steady density everywhere (the throw itself is uniform, so
  // no part of the board is favoured), and `floor` is the spacing it never
  // goes below (H.nodeSpacing for nodes).
  const spread = (count, floor) => {
    const pool = shuffle(all.filter((k) => !used.has(k) && !reserved.has(k)));
    let out = [];
    for (let spacing = R; spacing >= Math.max(1, floor); spacing--) {
      out = [];
      for (const k of pool) {
        if (out.length >= count) break;
        if (out.every((o) => hexDist(k, o) >= spacing)) out.push(k);
      }
      if (out.length >= count) break;
    }
    for (const k of out) used.add(k);
    return out;
  };
  const nodeKeys = spread(Math.max(0, Math.round(H.nodes ?? 16)), H.nodeSpacing ?? 2);
  const mineKeys = spread(Math.max(0, Math.round(H.mines ?? 8)), H.mineSpacing ?? 1);

  // Each node's hp is its own seeded roll in H.nodeHp ([min, max]), drawn
  // here so it stays part of the same seeded stream as the rest of the board
  // - same seed, same hp per node.
  const [hpMin, hpMax] = Array.isArray(H.nodeHp) ? H.nodeHp : [1, 3];
  const nodeHp = {};
  for (const k of nodeKeys) nodeHp[k] = rng.int(Math.min(hpMin, hpMax), Math.max(hpMin, hpMax));

  return {
    radius: R,
    tiles,
    spawns: { party, enemies: [] },
    nodeKeys,
    mineKeys,
    nodeHp,
    hack: true,
  };
}
