// =====================================================================
//  HACK ENCOUNTER - the flat board.          *** EXPERIMENT (see DESIGN.md) ***
//
//  Builds the arena RECIPE for a hack: a completely flat hex board (every
//  tile pinned to the neutral elevation, which is exactly what switches the
//  local map's random elevation wave off - see LocalMapView.build), the
//  party's spawn tiles clustered around the centre, and the node / mine tiles
//  strewn about by a seeded rng. The recipe goes through the ordinary
//  handcrafted-map path (localmap.js applyRecipe), so the view builds it
//  with no special case; the node / mine keys ride along on the recipe for
//  the hack engine, which places them as tags itself.
// =====================================================================
import { createRng } from '../../rng.js';
import { DIRS, PK, addK, boardTiles } from '../battle/bhex.js';
import { neutralElevation } from '../localmap.js';

const ringOf = (k) => { const [q, r] = PK(k); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)); };

/**
 * @param H          HACK_CONFIG (or a patched copy)
 * @param seed       run seed (mixed with the world tile so every terminal differs)
 * @param hex        the world tile being entered ({ q, r })
 * @param partySize  living party members to seat
 * Returns { radius, tiles, spawns: { party, enemies }, nodeKeys, mineKeys }.
 */
export function buildHackRecipe(H, seed, hex, partySize) {
  const R = H.radius;
  const rng = createRng(((seed ?? 1) ^ ((hex?.q ?? 0) * 83492791) ^ ((hex?.r ?? 0) * 29438141) ^ 0x4ac4) >>> 0);
  const all = boardTiles(R);
  const inMap = (k) => ringOf(k) <= R;
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

  // Flat: every tile at the neutral step. (A recipe that authors an elevation
  // is taken as the arena's whole height map, so no wave is added on top.)
  const neutral = neutralElevation();
  const tiles = {};
  for (const k of all) tiles[k] = { elevation: neutral };

  // The party sits around the centre, so every direction is equally far.
  const used = new Set();
  const centreish = shuffle(all.filter((k) => ringOf(k) <= H.partyRingMax));
  const party = [];
  for (let i = 0; i < partySize && i < centreish.length; i++) { party.push(centreish[i]); used.add(centreish[i]); }
  // Keep the first ring around the party free of nodes and mines: the opening
  // turn should be a walk-and-choose, not a point-blank gift.
  const reserved = new Set(used);
  for (const k of used) for (const d of DIRS) reserved.add(addK(k, d));

  // Nodes: some in adjacent pairs (a 3-hex pattern can cover two at once), the
  // rest alone. Never on the rim ring, so every node can be approached from
  // every side.
  const free = (k) => inMap(k) && !used.has(k) && !reserved.has(k) && ringOf(k) < R;
  const nodeKeys = [];
  const placeNode = (k) => { nodeKeys.push(k); used.add(k); };
  const candidates = shuffle(all.filter(free));
  let pairsLeft = H.nodePairs;
  for (const k of candidates) {
    if (nodeKeys.length >= H.nodes) break;
    if (!free(k)) continue;
    // A lone node keeps one tile of air around it, so the board reads as
    // scattered objects rather than a wall. A pair is placed together.
    if (DIRS.some((d) => nodeKeys.includes(addK(k, d))) && pairsLeft <= 0) continue;
    placeNode(k);
    if (pairsLeft > 0 && nodeKeys.length < H.nodes) {
      const nbs = shuffle(DIRS.map((d) => addK(k, d)).filter(free));
      if (nbs.length) { placeNode(nbs[0]); pairsLeft--; }
    }
  }

  // Mines: each guards a node (a random free neighbour of a random node), or
  // lands anywhere when minesNearNodes is off. Never on a node or the party.
  const mineKeys = [];
  const mineFree = (k) => inMap(k) && !used.has(k) && !reserved.has(k);
  let guard = 0;
  while (mineKeys.length < H.mines && guard++ < 400) {
    let k = null;
    if (H.minesNearNodes && nodeKeys.length) {
      const n = nodeKeys[Math.floor(rng.random() * nodeKeys.length)];
      const nbs = DIRS.map((d) => addK(n, d)).filter(mineFree);
      if (nbs.length) k = nbs[Math.floor(rng.random() * nbs.length)];
    } else {
      const pool = all.filter(mineFree);
      if (pool.length) k = pool[Math.floor(rng.random() * pool.length)];
    }
    if (!k) continue;
    mineKeys.push(k); used.add(k);
  }

  return {
    radius: R,
    tiles,
    spawns: { party, enemies: [] },
    nodeKeys,
    mineKeys,
    hack: true,
  };
}
