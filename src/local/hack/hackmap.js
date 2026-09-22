// =====================================================================
//  HACK ENCOUNTER - the flat board.          *** EXPERIMENT (see DESIGN.md) ***
//
//  Builds the arena RECIPE for a hack: a completely flat hex board (every
//  tile pinned to the neutral elevation, which is exactly what switches the
//  local map's random elevation wave off - see LocalMapView.build), the
//  party's spawn tiles, and the node / mine tiles placed by one of the
//  LAYOUTS in hacklayouts.js. The recipe goes through the ordinary
//  handcrafted-map path (localmap.js applyRecipe), so the view builds it
//  with no special case; the node / mine keys ride along on the recipe for
//  the hack engine, which places them as tags itself.
//
//  The placer: every free tile gets a weight from the layout, and tiles are
//  drawn without replacement in proportion to it (a weight of 0 is never
//  drawn). `spacing` is the minimum hex distance between two nodes - 1 lets
//  them touch, 2 keeps one tile of air. Mines are drawn the same way once the
//  nodes stand, from weights that may look at where the nodes are.
// =====================================================================
import { createRng } from '../../rng.js';
import { createNoise } from '../../noise.js';
import { DIRS, PK, addK, hexDist, boardTiles } from '../battle/bhex.js';
import { neutralElevation } from '../localmap.js';
import { HACK_LAYOUTS, layoutById } from './hacklayouts.js';

const ringOf = (k) => { const [q, r] = PK(k); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)); };
const SQ3 = Math.sqrt(3);
// Plane coordinates with adjacent tiles one unit apart.
const xyOf = (k) => { const [q, r] = PK(k); return { x: q + r / 2, y: r * SQ3 / 2 }; };

// Which layout a terminal gets: forced by config, or a seeded draw from the pool.
export function pickLayout(H, rng) {
  if (H.forceLayout) { const l = layoutById(H.forceLayout); if (l) return l; }
  const pool = Array.isArray(H.layoutPool) && H.layoutPool.length
    ? H.layoutPool.map(layoutById).filter(Boolean) : HACK_LAYOUTS;
  return pool[Math.floor(rng.random() * pool.length)];
}

/**
 * @param H          HACK_CONFIG (or a patched copy)
 * @param seed       run seed (mixed with the world tile so every terminal differs)
 * @param hex        the world tile being entered ({ q, r })
 * @param partySize  living party members to seat
 * Returns { radius, tiles, spawns: { party, enemies }, nodeKeys, mineKeys, nodeHp, layout }.
 */
export function buildHackRecipe(H, seed, hex, partySize) {
  const R = H.radius;
  const rng = createRng(((seed ?? 1) ^ ((hex?.q ?? 0) * 83492791) ^ ((hex?.r ?? 0) * 29438141) ^ 0x4ac4) >>> 0);
  const layout = pickLayout(H, rng);
  const all = boardTiles(R);
  const inMap = (k) => ringOf(k) <= R;
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

  // Flat: every tile at the neutral step. (A recipe that authors an elevation
  // is taken as the arena's whole height map, so no wave is added on top.)
  const neutral = neutralElevation();
  const tiles = {};
  for (const k of all) tiles[k] = { elevation: neutral };

  // ----- the party ------------------------------------------------------
  const used = new Set();
  const party = [];
  let partyAngle = rng.random() * Math.PI * 2;   // which side an 'edge' start sits on
  if (layout.party === 'edge') {
    // A cluster on one side of the rim: the rim tile nearest the chosen
    // bearing, then its neighbours, working inwards as little as possible.
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
    partyAngle = rng.random() * Math.PI * 2;
  }
  // The first ring around the party stays free of nodes and mines: the
  // opening turn should be a walk-and-choose, not a point-blank gift.
  const reserved = new Set(used);
  for (const k of used) for (const d of DIRS) reserved.add(addK(k, d));

  // ----- the layout's context ---------------------------------------------
  const noise = createNoise(rng);
  const noiseOff = { x: rng.random() * 100, y: rng.random() * 100 };
  // The axis "away from the party": +R at the far side, -R on the party's side.
  const ax = Math.cos(partyAngle + Math.PI), ay = Math.sin(partyAngle + Math.PI);
  const ctx = {
    R, rng, party,
    ring: ringOf,
    dist: hexDist,
    xy: xyOf,
    angle: (k) => { const p = xyOf(k); return Math.atan2(p.y, p.x); },
    noise: (k, opts = {}) => { const p = xyOf(k); return noise.fbm(p.x + noiseOff.x, p.y + noiseOff.y, opts); },
    away: (k) => { const p = xyOf(k); return p.x * ax + p.y * ay; },
    along: (k, a) => { const p = xyOf(k); return p.x * Math.cos(a) + p.y * Math.sin(a); },
    lattice: (k) => { const [q, r] = PK(k); return (((q - r) % 3) + 3) % 3; },
    // n tiles spread over rings rmin..rmax, kept at least 2 apart from each other.
    spread: (n, rmin, rmax) => {
      const out = [];
      const pool = shuffle(all.filter((k) => ringOf(k) >= rmin && ringOf(k) <= rmax && !reserved.has(k)));
      for (const k of pool) { if (out.length >= n) break; if (out.every((o) => hexDist(o, k) >= 3)) out.push(k); }
      for (const k of pool) { if (out.length >= n) break; if (!out.includes(k)) out.push(k); }
      return out;
    },
    // The six corner tiles of ring r.
    corners: (r) => DIRS.map((d) => `${d[0] * r},${d[1] * r}`),
    pick: null,
  };
  if (layout.setup) ctx.pick = layout.setup(ctx);

  // ----- weighted draws ---------------------------------------------------
  // Draw `count` tiles from `pool` in proportion to weight(k); every draw
  // removes the tile and, with spacing > 1, everything nearer than spacing.
  const draw = (count, pool, weight, spacing = 1) => {
    const out = [];
    let cand = pool.map((k) => ({ k, w: Math.max(0, weight(k) || 0) })).filter((c) => c.w > 0);
    while (out.length < count && cand.length) {
      const total = cand.reduce((s, c) => s + c.w, 0);
      let x = rng.random() * total;
      let i = 0;
      for (; i < cand.length - 1; i++) { x -= cand[i].w; if (x <= 0) break; }
      const k = cand[i].k;
      out.push(k);
      cand = cand.filter((c) => hexDist(c.k, k) >= spacing);
    }
    return out;
  };
  const free = (k) => inMap(k) && !used.has(k) && !reserved.has(k);
  const nodeKeys = draw(layout.nodes, all.filter(free), (k) => layout.nodeW(ctx, k), layout.spacing ?? 1);
  for (const k of nodeKeys) used.add(k);
  const mineKeys = draw(layout.mines, all.filter(free), (k) => layout.mineW(ctx, k, nodeKeys), 1);
  for (const k of mineKeys) used.add(k);

  // Each node's hp is its own seeded roll in [nodeHpMin, nodeHpMax], drawn
  // here (not by the rules/tags code) so it stays part of the same seeded
  // stream as the rest of the board - same seed, same hp per node.
  const nodeHp = {};
  for (const k of nodeKeys) nodeHp[k] = rng.int(H.nodeHpMin, H.nodeHpMax);

  return {
    radius: R,
    tiles,
    spawns: { party, enemies: [] },
    nodeKeys,
    mineKeys,
    nodeHp,
    layout: { id: layout.id, name: layout.name, desc: layout.desc },
    hack: true,
  };
}
