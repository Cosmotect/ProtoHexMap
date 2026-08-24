// Seeded 2D Perlin noise with multi-octave ("fractal") sampling.
// Classic gradient noise: a shuffled permutation table picks a pseudo-random
// gradient at every integer grid corner; values between corners are smoothly
// interpolated. Same seed -> same permutation -> same map.

// Builds a noise sampler from the game rng. fbm(x, y, opts) returns a value in
// roughly [0, 1] (normalised from the raw [-1, 1] range).
export function createNoise(rng) {
  // Shuffled 0..255, doubled so we never need to wrap indices.
  const p = new Uint8Array(512);
  const base = [...Array(256).keys()];
  for (let i = base.length - 1; i > 0; i--) {
    const j = Math.floor(rng.random() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  // 8 unit-ish gradients are plenty for terrain.
  const grad = (hash, x, y) => {
    switch (hash & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  };

  // Raw Perlin in [-1, 1].
  function perlin(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    return lerp(
      lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
      lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
      v
    );
  }

  // Multi-octave sample, normalised to [0, 1].
  // opts: { frequency, octaves, persistence, offsetX, offsetY }
  // Each field gets its own offset so elevation / ether / biome do not correlate.
  function fbm(x, y, opts = {}) {
    const octaves = Math.max(1, Math.round(opts.octaves ?? 4));
    const persistence = opts.persistence ?? 0.5;
    let freq = opts.frequency ?? 0.1;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    const ox = opts.offsetX ?? 0;
    const oy = opts.offsetY ?? 0;
    for (let i = 0; i < octaves; i++) {
      sum += perlin((x + ox) * freq, (y + oy) * freq) * amp;
      norm += amp;
      amp *= persistence;
      freq *= 2;
    }
    return sum / norm / 2 + 0.5;
  }

  return { perlin, fbm };
}
