// =====================================================================
//  COMBAT HEX HELPERS - ported from hex-box (js/01-hex.js).
//
//  The combat engine keeps hex-box's compact conventions (string keys "q,r",
//  DIRS as index-addressable list, zone offsets rotated in 60-degree sectors)
//  so the ported battle code stays close to the original. Everything here is
//  pure math, shared by the engine, the ability config and the local view.
// =====================================================================

export const SQ3 = Math.sqrt(3);
// CCW-ordered neighbour offsets; push directions are indices into this list.
export const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export const K = (q, r) => q + ',' + r;
export const PK = (k) => k.split(',').map(Number);
export const addK = (k, off) => { const [q, r] = PK(k); return K(q + off[0], r + off[1]); };
export const hexDist = (a, b) => {
  const [q1, r1] = PK(a), [q2, r2] = PK(b);
  const dq = q1 - q2, dr = r1 - r2;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
};

// Every offset whose hex distance from the origin is in [minD, maxD].
export function ringOffsets(minD, maxD) {
  const out = [];
  for (let q = -maxD; q <= maxD; q++)
    for (let r = Math.max(-maxD, -q - maxD); r <= Math.min(maxD, -q + maxD); r++) {
      const d = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
      if (d >= minD && d <= maxD) out.push([q, r]);
    }
  return out;
}

// The SIX SPOKES: every offset that lies straight out from the origin along one
// of the six directions, at distances minD..maxD. The star to ringOffsets' blob -
// `lineOffsets(1, 3)` is 18 tiles (6 directions x 3 steps), where
// `ringOffsets(1, 3)` is 36 (everything within reach). Use it for anything that
// travels in a straight line: a charge, a lance, a bolt down a corridor.
export function lineOffsets(minD, maxD) {
  const out = [];
  for (const d of DIRS) for (let n = minD; n <= maxD; n++) out.push([d[0] * n, d[1] * n]);
  return out;
}

// The tiles a straight walk from `a` to `b` passes through, `a` first and `b`
// last. Cube interpolation with rounding - the standard hex line, so an
// off-axis pair still gets a sensible, connected path rather than a guess.
export function hexLine(a, b) {
  const n = hexDist(a, b);
  if (n === 0) return [a];
  const [q1, r1] = PK(a), [q2, r2] = PK(b);
  const x1 = q1, z1 = r1, y1 = -q1 - r1;
  const x2 = q2, z2 = r2, y2 = -q2 - r2;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let rx = Math.round(x1 + (x2 - x1) * t);
    let ry = Math.round(y1 + (y2 - y1) * t);
    let rz = Math.round(z1 + (z2 - z1) * t);
    const dx = Math.abs(rx - (x1 + (x2 - x1) * t));
    const dy = Math.abs(ry - (y1 + (y2 - y1) * t));
    const dz = Math.abs(rz - (z1 + (z2 - z1) * t));
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    out.push(K(rx, rz));
  }
  return out;
}

// Rotate an axial offset k times by 60 degrees clockwise (screen y-down).
// k = 0 keeps the authored "east" facing.
export function rotOff(o, k) {
  let q = o[0], r = o[1];
  for (let i = 0; i < k; i++) { const nq = -r, nr = q + r; q = nq; r = nr; }
  return [q, r];
}

// Snap the caster -> target direction to one of 6 sectors (rotation count from east).
export function aimRot(fromK, toK) {
  if (fromK === toK) return 0;
  const [q1, r1] = PK(fromK), [q2, r2] = PK(toK);
  const dq = q2 - q1, dr = r2 - r1;
  const x = SQ3 * (dq + dr / 2), y = 1.5 * dr;
  const a = Math.atan2(y, x) * 180 / Math.PI;
  return ((Math.round(a / 60) % 6) + 6) % 6;
}
export function abRotFor(ab, fromK, toK) { return ab.rotatable ? aimRot(fromK, toK) : 0; }

// Rotate a push-direction index by k sectors.
export function rotDir(i, k) {
  const v = rotOff(DIRS[i], k);
  return DIRS.findIndex((d) => d[0] === v[0] && d[1] === v[1]);
}

// Every tile key of a hexagon board with radius R.
export function boardTiles(R) {
  const t = [];
  for (let q = -R; q <= R; q++)
    for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) t.push(K(q, r));
  return t;
}
