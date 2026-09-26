// Map generation. Produces plain data (no Three.js here) so the rules can be
// tested and reasoned about without a screen.
//
// Terrain model: every tile has a TYPE (ether / water / ground / hill / mountain,
// all the gameplay numbers, from config.tileTypes) and a BIOME (mostly colour, from
// config.biomes; special biomes like wither may add hpCost / terrainHeight on top).
// Types come from a multi-octave Perlin elevation field, then a second noise field
// pokes ether holes, then a third distributes the biomes. Biomes marked
// "generated: false" (wither) are never placed here - they are applied during play.
import { hexKey, neighbors, hexesInRange, axialToPlane, hexDistance } from './hex.js';
import { createNoise } from './noise.js';
import { evenSpread } from './spread.js';

/**
 * Builds a hexagon shaped hex map (a centre tile plus `radius` rings) from the config
 * using the seeded rng. The player starts on the centre tile. One outer-ring tile
 * holds the Stasis Seed; more tiles (config.stasis) are marked as future
 * Stasis Colony sites - the Colonies themselves spawn during play, when the
 * stasis lines reach them (see game.js).
 * Returns { hexes: Map<key, hex>, start, seed, colonies, shortestPath, bounds }.
 * Each hex: { q, r, ring, key, type, biome, passable, supplyCost, encounter,
 *             revealed, visited, x, y }   (x, y = 2D plane position)
 *
 * `layer` is WHICH LAYER of the worldflake this map belongs to (config.layers;
 * 0 = the core, the run starts on startLayer). For now a layer only changes the
 * biome palette at render time (biomeColorFor below) - this is the hook where a
 * layer will later pick its own biomes, spawns, encounter types and rules.
 */
export function generateMap(config, rng, layer = null) {
  const { radius, orientation, hexSize } = config.map;
  const mapLayer = layer ?? config.layers?.startLayer ?? 3;

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
  result.layer = mapLayer;
  return result;
}

// The colour a biome wears on a given layer of the worldflake: its color<N>
// entry, falling back to the plain `color` (config/world.js documents the
// scheme). Read by the renderer, so recolouring a run is just redrawing.
export function biomeColorFor(biomeDef, layer) {
  if (!biomeDef) return 0xffffff;
  return biomeDef[`color${layer}`] ?? biomeDef.color;
}

function buildLayout(config, rng, radius, orientation, hexSize) {
  const hexes = new Map();
  const startQ = 0, startR = 0;

  // ----- Stasis placement (see config.stasis) -------------------------------
  // The Seed sits on the outer rings; Colony sites may sit anywhere - their only
  // placement rule is minSpacing from each other and from the Seed. The start tile
  // itself is excluded because the player stands there.
  const st = config.stasis;
  const minRing = st.seedMinRing === 'half' ? Math.floor(radius / 2) : (st.seedMinRing ?? radius);
  const seedCandidates = hexesInRange(0, 0, radius).filter(([q, r]) => hexDistance(q, r, 0, 0) >= minRing);
  const seedSpot = rng.pick(seedCandidates);

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

  // ----- Noise fields ---------------------------------------------------------
  // One sampler, three independent fields (each gets a random offset so they do
  // not correlate). Sampled in plane coordinates so frequency is per world unit.
  // Raw multi-octave noise bunches up around the middle, so each field is
  // rank-normalised across the map: the config levels then read as shares of the
  // map instead of raw noise values that the field may never reach.
  const noise = createNoise(rng);
  const n = config.noise;
  const off = () => rng.random() * 4096;
  const fields = {
    elevation: { ...n.elevation, offsetX: off(), offsetY: off() },
    ether: { ...n.ether, offsetX: off(), offsetY: off() },
    biome: { ...n.biome, offsetX: off(), offsetY: off() },
  };
  const biomeNames = Object.keys(config.biomes).filter((b) => config.biomes[b].generated !== false);

  const coords = hexesInRange(0, 0, radius).map(([q, r]) => ({ q, r, plane: axialToPlane(q, r, hexSize, orientation) }));
  const ranked = (field) => {
    const raw = coords.map((c) => noise.fbm(c.plane.x, c.plane.y, field));
    const order = raw.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(raw.length);
    order.forEach(([, i], rank) => { out[i] = order.length > 1 ? rank / (order.length - 1) : 0.5; });
    return out;
  };
  const elevation = ranked(fields.elevation);
  const etherField = ranked(fields.ether);
  const biomeField = ranked(fields.biome);

  coords.forEach((c, i) => {
    const { q, r, plane } = c;
    const isStart = q === startQ && r === startR;
    const key = hexKey(q, r);
    const isSeed = key === seedKey;
    const isColony = colonyKeys.has(key);

    // Holes first: the top slice of the ether field wins over elevation.
    let type;
    if (etherField[i] > n.etherLevel) type = 'ether';
    else if (elevation[i] < n.waterLevel) type = 'water';
    else if (elevation[i] >= n.mountainLevel) type = 'mountain';
    else if (elevation[i] >= n.hillLevel) type = 'hill';
    else type = 'ground';
    if (isStart || isSeed || isColony) type = 'ground';

    const biomeIdx = Math.min(biomeNames.length - 1, Math.floor(biomeField[i] * biomeNames.length));
    const hex = {
      q, r,
      ring: hexDistance(q, r, 0, 0),   // 0 = centre, radius = outer edge
      key,
      biome: biomeNames[biomeIdx],
      encounter: isSeed ? 'stasisSeed' : null,   // Colonies spawn later, during play
      isStart,
      isSeed,
      isColony,
      revealed: false,
      visited: false,
      x: plane.x,
      y: plane.y,
    };
    setType(hex, type, config);
    hexes.set(hex.key, hex);
  });

  const start = hexes.get(hexKey(startQ, startR));
  const seed = hexes.get(seedKey);
  const colonies = colonySpots.map(([q, r]) => hexes.get(hexKey(q, r)));

  // Keep the first ring around the start walkable so the run never starts boxed in.
  for (const [nq, nr] of neighbors(start.q, start.r)) {
    const nb = hexes.get(hexKey(nq, nr));
    if (nb && (!nb.passable || nb.supplyCost > 0)) setType(nb, 'ground', config);
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

// Recomputes a hex's gameplay numbers from its type + biome. Biomes are mostly
// colour, but a special biome (wither) may add hpCost / terrainHeight on top.
function applyStats(hex, config) {
  const t = config.tileTypes[hex.type];
  const b = config.biomes[hex.biome] ?? {};
  hex.passable = t.passable;
  hex.supplyCost = t.supplyCost;
  hex.hpCost = (t.hpCost ?? 0) + (b.hpCost ?? 0);
  hex.revealBonus = t.revealBonus ?? 0;
  hex.terrainHeight = (t.terrainHeight ?? 0) + (b.terrainHeight ?? 0);
}

// Rewrites a hex's tile type (the biome stays). Also used by game.js when the
// Stasis dries withered water into ground.
export function setType(hex, type, config) {
  hex.type = type;
  applyStats(hex, config);
}

// Rewrites a hex's biome (the type stays). Used by game.js when the Stasis
// withers a tile.
export function setBiome(hex, biome, config) {
  hex.biome = biome;
  applyStats(hex, config);
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
  // reduces the distance, turning everything on the way into plain ground.
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
    if (!best.passable || best.supplyCost > 0) setType(best, 'ground', config);
    cur = best;
  }
}

// =====================================================================
//  ENCOUNTER PLACEMENT - the LAST step of generateMap, once every retry,
//  corridor and start-ring fix is done, so it works on the final, truthful
//  list of tiles the player can walk. Deterministic per seed. The design is
//  documented on config.encounters (config/encounters.js); in short:
//    1. the eligible tiles (walkable, supply-free, not the start / Seed /
//       Colony sites, past minDistanceFromStart) are split into the RING
//       BANDS of config.battle.enemies.bands;
//    2. each band gets about density x its tiles worth of encounters, each
//       type its weight's share of those (seeded-randomly rounded, so a rare
//       type still turns up), lifted to the type's guaranteed minimum for
//       that band;
//    3. within the band each type is spread EVENLY over the free tiles
//       (src/spread.js evenSpread - the Hack board's placer), rarest type
//       first, so the picks of one type are never bunched in one corner;
//    4. `unique` types are capped at one per map;
//    5. the VALIDATOR counts every band again and places more of any type
//       still short of its minimum - on a free tile, or over the band's most
//       plentiful type when nothing is free - and reports what it had to do.
//  result.encounterReport = { bands: { <band>: { tiles, want, placed, topped } } }.
// =====================================================================
export function bandIds(config) {
  return Object.keys(config.battle?.enemies?.bands ?? { all: { maxRing: Infinity } });
}
export function bandIndexOf(config, ring) {
  const bands = config.battle?.enemies?.bands;
  if (!bands) return 0;
  const ids = Object.keys(bands);
  for (let i = 0; i < ids.length; i++) if (ring <= bands[ids[i]].maxRing) return i;
  return ids.length - 1;
}
// A per-band number: a plain number applies to every band, a list is read in
// band order (a short list repeats its last entry).
function perBand(value, bandIndex, fallback = 0) {
  if (Array.isArray(value)) return value.length ? Number(value[Math.min(bandIndex, value.length - 1)]) || 0 : fallback;
  return value == null ? fallback : Number(value) || 0;
}
// The placement table in the shape the placer wants, whatever the config's
// age: `types: { id: { weight, guaranteed } }` (2026-09-26) or the older
// `weights: { id: n }` + `guaranteed: { id: n }`.
function encounterTypes(enc) {
  if (enc.types) return Object.entries(enc.types).map(([id, t]) => ({ id, weight: t?.weight ?? 0, guaranteed: t?.guaranteed ?? 0 }));
  return Object.entries(enc.weights ?? {}).map(([id, w]) => ({ id, weight: w, guaranteed: enc.guaranteed?.[id] ?? 0 }));
}

function placeEncounters(result, config, rng) {
  const enc = config.encounters;
  const types = encounterTypes(enc);
  const unique = new Set(enc.unique ?? []);
  const ids = bandIds(config);
  const dist = (a, b) => hexDistance(a.q, a.r, b.q, b.r);
  const eligible = (h) => h.passable && h.supplyCost === 0 && !h.isStart && !h.isSeed && !h.isColony
    && hexDistance(h.q, h.r, result.start.q, result.start.r) > (enc.minDistanceFromStart ?? 0);

  // 1. the bands
  const bands = ids.map((id) => ({ id, tiles: [] }));
  for (const h of result.hexes.values()) {
    if (h.encounter && h.encounter !== 'stasisSeed') h.encounter = null;   // a retry never leaves stale marks
    if (eligible(h)) bands[bandIndexOf(config, h.ring)].tiles.push(h);
  }
  const report = { bands: {} };
  const uniqueUsed = new Set();
  const stochasticRound = (x) => Math.floor(x) + (rng.random() < x - Math.floor(x) ? 1 : 0);
  const totalWeight = (bi) => types.reduce((sum, t) => sum + Math.max(0, perBand(t.weight, bi)), 0);

  bands.forEach((band, bi) => {
    const total = Math.round((enc.density ?? 0) * band.tiles.length);
    const wsum = totalWeight(bi);
    // 2. the quotas
    const want = {};
    for (const t of types) {
      const share = wsum > 0 ? total * Math.max(0, perBand(t.weight, bi)) / wsum : 0;
      let n = Math.max(stochasticRound(share), Math.max(0, Math.round(perBand(t.guaranteed, bi))));
      if (unique.has(t.id)) n = Math.min(n, uniqueUsed.has(t.id) ? 0 : 1);
      want[t.id] = n;
    }
    // 3. the spread: rarest type first, each over what is still free
    const placed = {};
    const order = types.slice().sort((a, b) => (want[a.id] - want[b.id]) || (types.indexOf(a) - types.indexOf(b)));
    for (const t of order) {
      const free = band.tiles.filter((h) => !h.encounter);
      // The same type already down in the bands before this one counts as
      // "existing": the spread keeps its distance from those too, so a type
      // is even across the whole map, not only within each band.
      const existing = [...result.hexes.values()].filter((h) => h.encounter === t.id);
      const picks = evenSpread({ pool: free, count: want[t.id], floor: 1, rng, dist, existing });
      for (const h of picks) h.encounter = t.id;
      placed[t.id] = picks.length;
      if (unique.has(t.id) && picks.length) uniqueUsed.add(t.id);
    }
    report.bands[band.id] = { tiles: band.tiles.length, want, placed, topped: {} };
  });

  // 4. unique types: at most one per map (a belt to the braces above)
  for (const type of unique) {
    const spots = [...result.hexes.values()].filter((h) => h.encounter === type);
    if (spots.length <= 1) continue;
    const keep = spots[Math.floor(rng.random() * spots.length)];
    for (const h of spots) if (h !== keep) h.encounter = null;
  }

  // 5. the validator: every band, every type, at least its minimum
  bands.forEach((band, bi) => {
    const rep = report.bands[band.id];
    for (const t of types) {
      const min = unique.has(t.id) ? Math.min(1, Math.round(perBand(t.guaranteed, bi))) : Math.round(perBand(t.guaranteed, bi));
      if (min <= 0) continue;
      let have = band.tiles.filter((h) => h.encounter === t.id);
      let added = 0;
      while (have.length < min) {
        let free = band.tiles.filter((h) => !h.encounter);
        if (!free.length) {
          // Nothing free: take a tile from the type the band has the most of
          // beyond its own minimum (never the one being topped up).
          const counts = {};
          for (const h of band.tiles) if (h.encounter && h.encounter !== t.id) counts[h.encounter] = (counts[h.encounter] ?? 0) + 1;
          const surplus = (id) => (counts[id] ?? 0) - Math.round(perBand(types.find((x) => x.id === id)?.guaranteed ?? 0, bi));
          const victim = Object.keys(counts).sort((a, b) => surplus(b) - surplus(a))[0];
          if (!victim || surplus(victim) <= 0) break;   // the band is too small for its minima
          free = band.tiles.filter((h) => h.encounter === victim);
        }
        const [pick] = evenSpread({ pool: free, count: 1, floor: 1, rng, dist, existing: have });
        if (!pick) break;
        pick.encounter = t.id;
        have.push(pick);
        added++;
      }
      if (added) rep.topped[t.id] = added;
      if (have.length < min) console.warn(`encounters: band "${band.id}" cannot hold ${min} x ${t.id} (${have.length} placed, ${band.tiles.length} tiles)`);
    }
    // The final count of every type in the band (a top-up may have taken
    // tiles from another type).
    for (const t of types) rep.placed[t.id] = band.tiles.filter((h) => h.encounter === t.id).length;
  });
  result.encounterReport = report;
}
