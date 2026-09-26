// =====================================================================
//  EVEN SPREAD - blue-noise placement shared by the world map (encounters,
//  map.js placeEncounters) and the local map (the Hack's nodes and mines,
//  local/localmap.js buildHackRecipe).
//
//  `count` items are picked out of `pool` at random, but at the WIDEST
//  spacing the pool can fit that many at: the pool is shuffled once and
//  walked in that order, an item taken when nothing already taken (nor
//  anything in `existing`) is nearer than the spacing; if fewer than `count`
//  fit, the spacing steps down by one and the walk is repeated, down to
//  `floor` (never below 1). The widest spacing that fits is what keeps the
//  picks apart from each other at a steady density over the whole pool -
//  the walk itself is uniform, so no part of the pool is favoured - and
//  because the order is random, no two boards come out alike. Deterministic
//  for a given rng.
//
//  dist(a, b) is the caller's distance between two pool items (hex distance
//  in whatever key form the caller uses). `existing` is a list of items
//  already down that the new ones must also keep the spacing from.
// =====================================================================
export function evenSpread({ pool, count, floor = 1, rng, dist, existing = [], maxSpacing = null }) {
  const want = Math.max(0, Math.round(count));
  if (!want || !pool.length) return [];
  const order = pool.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const top = Math.max(1, Math.round(maxSpacing ?? Math.ceil(Math.sqrt(order.length))));
  let out = [];
  for (let spacing = top; spacing >= Math.max(1, floor); spacing--) {
    out = [];
    for (const k of order) {
      if (out.length >= want) break;
      if (existing.every((o) => dist(k, o) >= spacing) && out.every((o) => dist(k, o) >= spacing)) out.push(k);
    }
    if (out.length >= want) break;
  }
  return out;
}
