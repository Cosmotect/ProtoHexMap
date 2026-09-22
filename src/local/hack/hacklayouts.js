// =====================================================================
//  HACK ENCOUNTER - board layouts.           *** EXPERIMENT (see DESIGN.md) ***
//
//  Twenty ways to strew nodes and mines over the flat board. Every layout is
//  DATA: how many nodes and mines, where the party starts, how close two
//  nodes may sit, and two WEIGHT functions - one saying how attractive each
//  free tile is for a node, one (given the placed nodes) for a mine. The
//  placer (hackmap.js) samples tiles without replacement in proportion to
//  those weights, so a layout is a shape of probability, not a fixed picture:
//  the same layout on two terminals gives two related boards.
//
//  The weight functions get a context:
//    ctx.R          board radius
//    ctx.ring(k)    ring of a tile (0 = centre)
//    ctx.dist(a,b)  hex distance
//    ctx.xy(k)      plane coordinates { x, y } (for angles, lines, arcs)
//    ctx.angle(k)   bearing of a tile from the centre, radians
//    ctx.noise(k, opts)  seeded Perlin fbm in [0,1] at the tile (src/noise.js)
//    ctx.rng        seeded rng (random(), int(a,b))
//    ctx.party      the party's spawn keys
//    ctx.pick       per-board random numbers the layout may bake at setup
//                   (see `setup`): a layout that wants "3 random cluster
//                   centres" draws them once in setup() and reads them here.
//  A layout may also carry setup(ctx) -> object, run once per board; its
//  result is ctx.pick inside the weight functions.
//
//  Party starts: 'centre' (around the middle) or 'edge' (a cluster on one
//  random side of the rim). The first ring around the party is always kept
//  free of nodes and mines.
// =====================================================================

const gauss = (d, s) => Math.exp(-(d * d) / (2 * s * s));
const angDiff = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };
const nearest = (ctx, k, keys) => keys.reduce((m, n) => Math.min(m, ctx.dist(k, n)), 99);
const adjCount = (ctx, k, keys) => keys.filter((n) => ctx.dist(k, n) === 1).length;

// Mine weight recipes used by several layouts.
const MINE = {
  uniform: () => 1,
  // Next to a node: the mine guards it.
  guard: (ctx, k, nodes) => (nearest(ctx, k, nodes) === 1 ? 1 : 0.05),
  // The more nodes a tile touches, the likelier a mine: pockets between nodes.
  pocket: (ctx, k, nodes) => Math.pow(adjCount(ctx, k, nodes), 2) + 0.03,
  // A moat: one ring out from the nodes, not touching them.
  moat: (ctx, k, nodes) => { const d = nearest(ctx, k, nodes); return d === 2 ? 1 : d === 1 ? 0.15 : 0.02; },
  // Away from the nodes: mines fill the empty stretches the party walks through.
  inverse: (ctx, k, nodes) => { const d = nearest(ctx, k, nodes); return d >= 2 ? 1 : 0.05; },
};

export const HACK_LAYOUTS = [
  {
    id: 'scatter', name: 'Scatter', desc: 'Even spread, nothing touching.',
    nodes: 14, mines: 7, spacing: 2, party: 'centre',
    nodeW: () => 1, mineW: MINE.uniform,
  },
  {
    id: 'dense', name: 'Dense scatter', desc: 'Even spread, nodes may touch.',
    nodes: 16, mines: 9, spacing: 1, party: 'centre',
    nodeW: () => 1, mineW: MINE.guard,
  },
  {
    id: 'bluenoise', name: 'Blue noise', desc: 'Evenly spaced by rejection, mines in the pockets.',
    nodes: 18, mines: 8, spacing: 2, party: 'centre',
    nodeW: () => 1, mineW: MINE.pocket,
  },
  {
    id: 'core', name: 'Core', desc: 'Everything congregates in the middle; the party comes from the edge.',
    nodes: 15, mines: 8, spacing: 1, party: 'edge',
    nodeW: (ctx, k) => gauss(ctx.ring(k), 1.7), mineW: MINE.moat,
  },
  {
    id: 'citadel', name: 'Citadel', desc: 'A solid block of nodes in the centre behind a ring of mines.',
    nodes: 16, mines: 10, spacing: 1, party: 'edge',
    nodeW: (ctx, k) => (ctx.ring(k) <= 2 ? 1 : 0.02),
    mineW: (ctx, k) => (ctx.ring(k) === 3 ? 1 : ctx.ring(k) === 4 ? 0.2 : 0.02),
  },
  {
    id: 'halo', name: 'Halo', desc: 'A ring of nodes around the party, mines sprinkled inside and out.',
    nodes: 16, mines: 8, spacing: 1, party: 'centre',
    nodeW: (ctx, k) => gauss(Math.abs(ctx.ring(k) - 3), 0.55),
    mineW: (ctx, k, nodes) => (nearest(ctx, k, nodes) === 1 ? 0.8 : 0.3),
  },
  {
    id: 'clusters3', name: 'Three clusters', desc: 'Three loose heaps of nodes, mines guarding them.',
    nodes: 15, mines: 8, spacing: 1, party: 'centre',
    setup: (ctx) => ({ c: ctx.spread(3, 2, 4) }),
    nodeW: (ctx, k) => ctx.pick.c.reduce((s, c) => s + gauss(ctx.dist(k, c), 1.25), 0),
    mineW: MINE.guard,
  },
  {
    id: 'clusters5', name: 'Five knots', desc: 'Five tight knots of nodes with mines in the gaps between them.',
    nodes: 16, mines: 9, spacing: 1, party: 'centre',
    setup: (ctx) => ({ c: ctx.spread(5, 2, 4) }),
    nodeW: (ctx, k) => ctx.pick.c.reduce((s, c) => s + gauss(ctx.dist(k, c), 0.8), 0),
    mineW: (ctx, k, nodes) => { const d = nearest(ctx, k, nodes); return d === 2 ? 1 : d === 1 ? 0.3 : 0.05; },
  },
  {
    id: 'archipelago', name: 'Archipelago', desc: 'Islands of nodes, each ringed with mines.',
    nodes: 15, mines: 12, spacing: 1, party: 'edge',
    setup: (ctx) => ({ c: ctx.spread(4, 1, 4) }),
    nodeW: (ctx, k) => ctx.pick.c.reduce((s, c) => s + gauss(ctx.dist(k, c), 0.9), 0),
    mineW: MINE.pocket,
  },
  {
    id: 'corners', name: 'Six corners', desc: 'Nodes piled in the six corners of the board.',
    nodes: 18, mines: 8, spacing: 1, party: 'centre',
    setup: (ctx) => ({ c: ctx.corners(ctx.R - 1) }),
    nodeW: (ctx, k) => ctx.pick.c.reduce((s, c) => s + gauss(ctx.dist(k, c), 1.1), 0),
    mineW: MINE.guard,
  },
  {
    id: 'crescent', name: 'Crescent', desc: 'Nodes along one arc of the board, mines on its inner edge.',
    nodes: 16, mines: 8, spacing: 1, party: 'centre',
    setup: (ctx) => ({ a: ctx.rng.random() * Math.PI * 2 }),
    nodeW: (ctx, k) => {
      const r = ctx.ring(k); if (r < 2) return 0;
      return gauss(angDiff(ctx.angle(k), ctx.pick.a), 1.1) * gauss(r - 3.3, 0.8);
    },
    mineW: (ctx, k, nodes) => (nearest(ctx, k, nodes) === 1 && ctx.ring(k) <= 2 ? 1 : 0.08),
  },
  {
    id: 'gradient', name: 'Gradient', desc: 'Sparse near the party, thickening towards the far side.',
    nodes: 17, mines: 9, spacing: 1, party: 'edge',
    nodeW: (ctx, k) => Math.pow((ctx.away(k) + ctx.R) / (2 * ctx.R), 3),
    mineW: (ctx, k) => Math.pow((ctx.away(k) + ctx.R) / (2 * ctx.R), 2),
  },
  {
    id: 'lanes', name: 'Lanes', desc: 'Three parallel lanes of nodes, mines in the alleys between.',
    nodes: 18, mines: 8, spacing: 1, party: 'edge',
    setup: (ctx) => ({ a: ctx.rng.random() * Math.PI }),
    nodeW: (ctx, k) => { const t = ctx.along(k, ctx.pick.a); return gauss(((t % 3.2) + 3.2) % 3.2 - 1.6, 0.55) + 0.02; },
    mineW: (ctx, k) => { const t = ctx.along(k, ctx.pick.a); return gauss(((t % 3.2) + 3.2) % 3.2, 0.45) + 0.02; },
  },
  {
    id: 'spiral', name: 'Spiral', desc: 'Nodes wound in a spiral out from the middle.',
    nodes: 16, mines: 7, spacing: 1, party: 'edge',
    setup: (ctx) => ({ a: ctx.rng.random() * Math.PI * 2 }),
    nodeW: (ctx, k) => {
      const r = ctx.ring(k); if (r === 0) return 1;
      // Archimedean spiral: radius grows 1 ring per 100 degrees.
      const want = ((ctx.angle(k) - ctx.pick.a + Math.PI * 4) % (Math.PI * 2)) / (Math.PI * 2) * 3.6;
      let d = Math.abs(r - want); d = Math.min(d, Math.abs(r - want - 3.6));
      return gauss(d, 0.5) + 0.02;
    },
    mineW: MINE.inverse,
  },
  {
    id: 'hills', name: 'Perlin hills', desc: 'Nodes on the high ground of a noise field, mines on its slopes.',
    nodes: 16, mines: 10, spacing: 1, party: 'centre',
    nodeW: (ctx, k) => { const n = ctx.noise(k, { frequency: 0.32, octaves: 3 }); return n > 0.56 ? Math.pow(n, 4) : 0.01; },
    mineW: (ctx, k) => { const n = ctx.noise(k, { frequency: 0.32, octaves: 3 }); return gauss(n - 0.5, 0.05) + 0.02; },
  },
  {
    id: 'veins', name: 'Perlin veins', desc: 'Nodes along the ridgelines of a noise field.',
    nodes: 18, mines: 9, spacing: 1, party: 'edge',
    nodeW: (ctx, k) => gauss(Math.abs(ctx.noise(k, { frequency: 0.28, octaves: 2 }) - 0.5), 0.05) + 0.01,
    mineW: (ctx, k) => { const d = Math.abs(ctx.noise(k, { frequency: 0.28, octaves: 2 }) - 0.5); return d > 0.08 && d < 0.16 ? 1 : 0.05; },
  },
  {
    id: 'islands', name: 'Perlin islands', desc: 'Choppy noise: small islands of nodes, mines in the low pools.',
    nodes: 17, mines: 10, spacing: 1, party: 'centre',
    nodeW: (ctx, k) => { const n = ctx.noise(k, { frequency: 0.6, octaves: 2 }); return n > 0.58 ? 1 : 0.02; },
    mineW: (ctx, k) => { const n = ctx.noise(k, { frequency: 0.6, octaves: 2 }); return n < 0.4 ? 1 : 0.05; },
  },
  {
    id: 'minefield', name: 'Minefield', desc: 'Mines everywhere; the nodes are worth the walk.',
    nodes: 14, mines: 15, spacing: 1, party: 'edge',
    nodeW: () => 1, mineW: MINE.uniform,
  },
  {
    id: 'outposts', name: 'Core and outposts', desc: 'A core of nodes in the middle, outposts at the rim, mines in the ring between.',
    nodes: 17, mines: 10, spacing: 1, party: 'edge',
    nodeW: (ctx, k) => { const r = ctx.ring(k); return r <= 1 ? 1 : r === ctx.R - 1 ? 0.6 : 0.02; },
    mineW: (ctx, k) => { const r = ctx.ring(k); return r === 2 || r === 3 ? 1 : 0.05; },
  },
  {
    id: 'honeycomb', name: 'Honeycomb', desc: 'A regular lattice of nodes with mines on the off-cells.',
    nodes: 18, mines: 8, spacing: 1, party: 'centre',
    nodeW: (ctx, k) => (ctx.lattice(k) === 0 ? 1 : 0),
    mineW: (ctx, k) => (ctx.lattice(k) === 1 ? 1 : 0.02),
  },
];

export const layoutById = (id) => HACK_LAYOUTS.find((l) => l.id === id) ?? null;
