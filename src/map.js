// Map generation. Produces plain data (no Three.js here) so the rules can be
// tested and reasoned about without a screen.
import { hexKey, neighbors, hexesInRange, axialToPlane, hexDistance } from './hex.js';

/**
 * Builds a hexagon shaped hex map (a centre tile plus `radius` rings) from the config
 * using the seeded rng. The player starts on the centre tile; bosses sit on random
 * tiles of the outer rings (see config.map.bossCount / bossMinRing).
 * Returns { hexes: Map<key, hex>, start, bosses, boss (nearest), shortestPath, bounds }.
 * Each hex: { q, r, ring, key, terrain, passable, supplyCost, encounter,
 *             revealed, visited, x, y }   (x, y = 2D plane position)
 */
export function generateMap(config, rng) {
  const { radius, orientation, hexSize } = config.map;

  let attempt = 0;
  let result = null;
  // Try a few layouts until every boss is reachable from the start.
  while (attempt < 60) {
    attempt += 1;
    result = buildLayout(config, rng, radius, orientation, hexSize);
    result.paths = result.bosses.map((b) => shortestPath(result.hexes, result.start, b));
    if (result.paths.every(Boolean)) break;
  }
  result.bosses.forEach((b, i) => {
    if (!result.paths[i]) {
      // Extremely unlucky: bulldoze a corridor so every boss is always reachable.
      carveCorridor(result, config, b);
      result.paths[i] = shortestPath(result.hexes, result.start, b);
    }
  });
  // "shortestPath" = route to the nearest boss (used for the HUD hint).
  result.shortestPath = result.paths.filter(Boolean).sort((a, b) => a.length - b.length)[0];
  result.boss = result.shortestPath[result.shortestPath.length - 1];

  placeEncounters(result, config, rng);
  result.attempts = attempt;
  return result;
}

function buildLayout(config, rng, radius, orientation, hexSize) {
  const hexes = new Map();
  // Start = the centre of the hexagon. Bosses = random tiles on the outer rings
  // (ring >= bossMinRing), kept at least bossMinSpacing apart from each other.
  const startQ = 0, startR = 0;
  const m = config.map;
  const minRing = m.bossMinRing === 'half' ? Math.floor(radius / 2) : (m.bossMinRing ?? radius);
  const candidates = hexesInRange(0, 0, radius).filter(([q, r]) => hexDistance(q, r, 0, 0) >= minRing);
  const bossKeys = new Set();
  const bossSpots = [];
  let guard = 0;
  while (bossSpots.length < (m.bossCount ?? 1) && guard++ < 500) {
    const [q, r] = rng.pick(candidates);
    const farEnough = bossSpots.every(([bq, br]) => hexDistance(q, r, bq, br) >= (m.bossMinSpacing ?? 0));
    if (farEnough && !bossKeys.has(hexKey(q, r))) { bossSpots.push([q, r]); bossKeys.add(hexKey(q, r)); }
  }

  for (const [q, r] of hexesInRange(0, 0, radius)) {
    const isStart = q === startQ && r === startR;
    const isBoss = bossKeys.has(hexKey(q, r));

    let terrain = rng.weighted(terrainWeights(config));
    if (isStart || isBoss) terrain = 'grass';

    const t = config.terrain[terrain];
    const plane = axialToPlane(q, r, hexSize, orientation);
    const hex = {
      q, r,
      ring: hexDistance(q, r, 0, 0),   // 0 = centre, radius = outer edge
      key: hexKey(q, r),
      terrain,
      passable: t.passable,
      supplyCost: t.supplyCost,
      hpCost: t.hpCost ?? 0,
      revealBonus: t.revealBonus ?? 0,
      terrainHeight: t.terrainHeight ?? 0,
      encounter: isBoss ? 'boss' : null,
      isStart,
      isBoss,
      revealed: false,
      visited: false,
      x: plane.x,
      y: plane.y,
    };
    hexes.set(hex.key, hex);
  }

  const start = hexes.get(hexKey(startQ, startR));
  const bosses = bossSpots.map(([q, r]) => hexes.get(hexKey(q, r)));

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
    bosses,
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

function setTerrain(hex, terrain, config) {
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

function carveCorridor(result, config, boss) {
  // Walk from the start towards the boss, always stepping to the neighbour that
  // reduces the distance, turning everything on the way into grass.
  let cur = result.start;
  let guard = 0;
  while (cur !== boss && guard++ < 500) {
    let best = null;
    let bestDist = Infinity;
    for (const [nq, nr] of neighbors(cur.q, cur.r)) {
      const n = result.hexes.get(hexKey(nq, nr));
      if (!n) continue;
      const d = hexDistance(n.q, n.r, boss.q, boss.r);
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
    if (!h.passable || h.supplyCost > 0 || h.isStart || h.isBoss) continue;
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
      h.passable && h.supplyCost === 0 && !h.isStart && !h.isBoss && !h.encounter &&
      hexDistance(h.q, h.r, result.start.q, result.start.r) > enc.minDistanceFromStart);
    for (let i = have; i < min && candidates.length; i++) {
      const idx = Math.floor(rng.random() * candidates.length);
      candidates.splice(idx, 1)[0].encounter = type;
    }
  }
}
