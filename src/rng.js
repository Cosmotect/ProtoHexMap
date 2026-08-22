// Seeded random number generator.
// Same seed -> same sequence of numbers -> same map. That is what makes
// "?seed=1234" links shareable between colleagues.
// Algorithm: mulberry32 (small, fast, good enough for game prototypes).

export function createRng(seed) {
  let a = seed >>> 0; // force into an unsigned 32-bit integer

  const rng = {
    seed,

    // Float in [0, 1), like Math.random()
    random() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },

    // Integer in [min, max] inclusive
    int(min, max) {
      return min + Math.floor(rng.random() * (max - min + 1));
    },

    // true with probability p
    chance(p) {
      return rng.random() < p;
    },

    // random element of an array
    pick(array) {
      return array[Math.floor(rng.random() * array.length)];
    },

    // weighted choice: pass { grass: 5, forest: 2 } -> returns 'grass' or 'forest'
    weighted(weightsByKey) {
      const entries = Object.entries(weightsByKey);
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let roll = rng.random() * total;
      for (const [key, weight] of entries) {
        roll -= weight;
        if (roll < 0) return key;
      }
      return entries[entries.length - 1][0];
    },
  };

  return rng;
}

// Picks the seed: from the URL (?seed=1234) if present, otherwise random.
export function resolveSeed(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Number(explicit);
    if (Number.isFinite(n)) return Math.abs(Math.floor(n)) >>> 0;
    // Non numeric seeds (words) are hashed into a number.
    let h = 2166136261;
    for (const ch of String(explicit)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  return Math.floor(Math.random() * 1_000_000);
}
