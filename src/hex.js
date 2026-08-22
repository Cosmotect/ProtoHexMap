// Hex grid maths, based on the classic "Red Blob Games" hexagon guide.
//
// We store every hex with AXIAL coordinates (q, r):
//   q  = column-ish axis, r = row-ish axis. Neighbours are always the same
//   six offsets no matter where you are, which makes distance and
//   neighbour maths trivial (unlike "offset" row/column coordinates).

const SQRT3 = Math.sqrt(3);

// The six neighbour offsets in axial space (same for pointy and flat hexes).
export const DIRECTIONS = [
  [1, 0], [1, -1], [0, -1],
  [-1, 0], [-1, 1], [0, 1],
];

export function hexKey(q, r) {
  return `${q},${r}`;
}

export function neighbors(q, r) {
  return DIRECTIONS.map(([dq, dr]) => [q + dq, r + dr]);
}

// Number of steps between two hexes.
export function hexDistance(aq, ar, bq, br) {
  const dq = aq - bq;
  const dr = ar - br;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

// Every hex within "radius" steps of (q, r), including (q, r) itself.
export function hexesInRange(q, r, radius) {
  const result = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const lo = Math.max(-radius, -dq - radius);
    const hi = Math.min(radius, -dq + radius);
    for (let dr = lo; dr <= hi; dr++) {
      result.push([q + dq, r + dr]);
    }
  }
  return result;
}

// Axial -> 2D plane position (x to the right, y "up the map").
// In the 3D scene we put x on X and y on -Z so that "up the map" is away from the camera.
export function axialToPlane(q, r, size, orientation) {
  if (orientation === 'flat') {
    return {
      x: size * (1.5 * q),
      y: size * ((SQRT3 / 2) * q + SQRT3 * r),
    };
  }
  return {
    x: size * (SQRT3 * q + (SQRT3 / 2) * r),
    y: size * (1.5 * r),
  };
}
