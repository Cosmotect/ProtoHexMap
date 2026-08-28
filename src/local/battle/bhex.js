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
