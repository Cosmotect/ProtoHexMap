// Map generation. Produces plain data (no Three.js here) so the rules can be
// tested and reasoned about without a screen.
import { hexKey, neighbors, hexesInRange, axialToPlane, hexDistance } from './hex.js';

/**
 * Builds a hexagon shaped hex map (a centre tile plus `radius` rings) from the config
 * using the seeded rng. The player starts on the centre tile. One outer-ring tile
 * holds the Stasis Seed; four more tiles (config.stasis) are marked as future
 * Stasis Colony sites - the Colonies themselves spawn during play, when the
 * stasis lines reach them (see game.js).
 * Returns { hexes: Map<key, hex>, start, seed, colonies, shortestPath, bounds }.
 * Each hex: { q, r, ring, key, terrain, passable, supplyCost, encounter,
 *             revealed, visited, x, y }   (x, y = 2D plane position)
 */
export function generateMap(config, rng) {
  const { radius, orientation, hexSize } = config.map;

  let attempt = 0;
  let result = null;
  // Try a few layouts until the Seed and every Colony site are reachable from the start.
  while (attempt < 60) {
    attempt += 1;
    result = buildLayout(config, rng, radius, orientation, hexSize);
    result.paths = [result.seed, ...result.colonies].map((b) => shortestPath(result.hexes, result.start, b));
    if (result.paths.every(Boolean)) break;
  }
  [result.seed, ...result.colonies].forEach((b, i) => {
    if (!result.paths[i]) {
      // Extremely unlucky: bulldoze a corridor so every goal is always reachable.
      carveCorridor(result, config, b);
      result.paths[i] = shortestPath(result.hexes, result.start, b);
    }
  });
  // "shortestPath" = the route to the Stasis Seed (used for the HUD hint).
  result.shortestPath = result.paths[0];

  placeEncounters(result, config, rng);
  result.attempts = attempt;
  return result;
}

function buildLayout(config, rng, radius, orientation, hexSize) {
  const hexes = new Map();
  // Start = the centre of the hexagon. The Seed = a random tile on the outer rings
  // (ring >= seedMinRing). Colony sites = random tiles kept at least minSpacing
  // apart from each other and from the Seed, and away from the start.
  const startQ = 0, startR = 0;
  const st = config.stasis;
  const minRing = st.seedMinRing === 'half' ? Math.floor(radius / 2) : (st.seedMinRing ?? radius);
  const seedCandidates = hexesInRange(0, 0, radius).filter(([q, r]) => hexDistance(q, r, 0, 0) >= minRing);
  const seedSpot = rng.pick(seedCandidates);

  // Colony sites may sit anywhere (even next to the start) - their only placement
  // rule is minSpacing from each other and from the Seed. The start tile itself is
  // excluded because the player stands there.
  const specialKeys = new Set([hexKey(seedSpot[0], seedSpot[1]), hexKey(startQ, startR)]);
  const colonySpots = [];
  const colonyCandidates = hexesInRange(0, 0, radius);
  let guard = 0;
  while (colonySpots.length < (st.colonyCount ?? 0) && guard++ < 800) {
    const [q, r] = rng.pick(colonyCandidates);
    if (specialKeys.has(hexKey(q, r))) continue;
    const farFromSeed = hexDistance(q, r, seedSpot[0], seedSpot[1]) >= (st.minSpacing ?? 0);
    const farFromOthers = colonySpots.every(([cq, cr]) => hexDistance(q, r, cq, cr) >= (st.minSpacing ?? 0));
    if (farFromSeed && farFromOthers) { colonySpots.push([q, r]); specialKeys.add(hexKey(q, r)); }
  }

  const seedKey = hexKey(seedSpot[0], seedSpot[1]);
  const colonyKeys = new Set(colonySpots.map(([q, r]) => hexKey(q, r)));

  for (const [q, r] of hexesInRange(0, 0, radius)) {
    const isStart = q === startQ && r === startR;
    const key = hexKey(q, r);
    const isSeed = key === seedKey;
    const isColony = colonyKeys.has(key);

    let terrain = rng.weighted(terrainWeights(config));
    if (isStart || isSeed || isColony) terrain = 'grass';

    const t = config.terrain[terrain];
    const plane = axialToPlane(q, r, hexSize, orientation);
    const hex = {
      q, r,
      ring: hexDistance(q, r, 0, 0),   // 0 = centre, radius = outer edge
      key,
      terrain,
      passable: t.passable,
      supplyCost: t.supplyCost,
      hpCost: t.hpCost ?? 0,
      revealBonus: t.revealBonus ?? 0,
      terrainHeight: t.terrainHeight ?? 0,
      encounter: isSeed ? 'stasisSeed' : null,   // Colonies spawn later, during play
      isStart,
      isSeed,
      isColony,
      revealed: false,
      visited: false,
      x: plane.x,
      y: plane.y,
    };
    hexes.set(hex.key, hex);
  }

  const start = hexes.get(hexKey(startQ, startR));
  const seed = hexes.get(seedKey);
  const colonies = colonySpots.map(([q, r]) => hexes.get(hexKey(q, r)));

  // Keep the first ring around the start walkable so the run never starts boxed in.
  for (const [nq, nr] of neighbors(start.q, start.r)) {
    const n = hexes.get(hexKey(nq, nr));
    if (n && (!n.passable || n.supplyCost > 0)) setTerrain(n, 'grass', config);
  }

  // Centre the map on the origin.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const h of hexes.values()) {
    minX = Math.min(minX, h.x); maxX = Math.max(maxX, h.x);
    minY = Math.min(minY, h.y); maxY = Math.max(maxY, h.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const h of hexes.values()) {
    h.x -= cx;
    h.y -= cy;
  }

  return {
    hexes,
    start,
    seed,
    colonies,
    bounds: { minX: minX - cx, maxX: maxX - cx, minY: minY - cy, maxY: maxY - cy },
    radius,
    orientation,
  };
}

function terrainWeights(config) {
  const weights = {};
  for (const [name, t] of Object.entries(config.terrain)) weights[name] = t.weight;
  return weights;
}

// Rewrites a hex's terrain fields from the config (also used by game.js when the
// Stasis withers a tile).
export function setTerrain(hex, terrain, config) {
  const t = config.terrain[terrain];
  hex.terrain = terrain;
  hex.passable = t.passable;
  hex.supplyCost = t.supplyCost;
  hex.hpCost = t.hpCost ?? 0;
  hex.revealBonus = t.revealBonus ?? 0;
  hex.terrainHeight = t.terrainHeight ?? 0;
}

// Breadth-first search over passable tiles that cost no supplies (mountains are
// walkable but expensive, so the "guaranteed route" ignores them).
// Returns an array of hexes from start to goal (inclusive), or null if unreachable.
export function shortestPath(hexes, start, goal) {
  const cameFrom = new Map([[start.key, null]]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    if (current === goal) break;
    for (const [nq, nr] of neighbors(current.q, current.r)) {
      const n = hexes.get(hexKey(nq, nr));
      if (!n || !n.passable || n.supplyCost > 0 || cameFrom.has(n.key)) continue;
      cameFrom.set(n.key, current);
      queue.push(n);
    }
  }
  if (!cameFrom.has(goal.key)) return null;
  const path = [];
  let cur = goal;
  while (cur) {
    path.push(cur);
    cur = cameFrom.get(cur.key);
  }
  return path.reverse();
}

function carveCorridor(result, config, goal) {
  // Walk from the start towards the goal, always stepping to the neighbour that
  // reduces the distance, turning everything on the way into grass.
  let cur = result.start;
  let guard = 0;
  while (cur !== goal && guard++ < 500) {
    let best = null;
    let bestDist = Infinity;
    for (const [nq, nr] of neighbors(cur.q, cur.r)) {
      const n = result.hexes.get(hexKey(nq, nr));
      if (!n) continue;
      const d = hexDistance(n.q, n.r, goal.q, goal.r);
      if (d < bestDist) { bestDist = d; best = n; }
    }
    if (!best) break;
    if (!best.passable || best.supplyCost > 0) setTerrain(best, 'grass', config);
    cur = best;
  }
}

function placeEncounters(result, config, rng) {
  const enc = config.encounters;
  for (const h of result.hexes.values()) {
    if (!h.passable || h.supplyCost > 0 || h.isStart || h.isSeed || h.isColony) continue;
    const distFromStart = hexDistance(h.q, h.r, result.start.q, result.start.r);
    if (distFromStart <= enc.minDistanceFromStart) continue;
    if (rng.chance(enc.density)) {
      h.encounter = rng.weighted(enc.weights);
    }
  }

  // Guaranteed minimums (e.g. at least one Acolyte per map): top up on random empty tiles.
  for (const [type, min] of Object.entries(enc.guaranteed ?? {})) {
    const have = [...result.hexes.values()].filter((h) => h.encounter === type).length;
    const candidates = [...result.hexes.values()].filter((h) =>
      h.passable && h.supplyCost === 0 && !h.isStart && !h.isSeed && !h.isColony && !h.encounter &&
      hexDistance(h.q, h.r, result.start.q, result.start.r) > enc.minDistanceFromStart);
    for (let i = have; i < min && candidates.length; i++) {
      const idx = Math.floor(rng.random() * candidates.length);
      candidates.splice(idx, 1)[0].encounter = type;
    }
  }
}
