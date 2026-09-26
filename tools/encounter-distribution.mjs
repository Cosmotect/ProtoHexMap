// Encounter distribution check (npm run test:encounters): generates many seeds
// headlessly (no browser) and checks the ENCOUNTER DISTRIBUTION the placer
// promises (src/map.js placeEncounters, config.encounters):
//   * every ring band holds at least its guaranteed minimum of every type;
//   * unique types appear at most once per map;
//   * no encounter sits on a tile the player cannot walk supply-free, on the
//     start, the Seed or a Colony site;
//   * the same map comes out of the same seed (determinism);
//   * spread: a type's tiles are not bunched - the fullest sextant of the map
//     holds no more than SPREAD_SHARE of that type (for types with at least 6).
// Prints per-band min / mean / max counts over the seeds, then the verdict.
//   node tools/encounter-distribution.mjs [seeds=200]   (npm run test:encounters)
import { CONFIG } from '../src/config.js';
import { generateMap, bandIndexOf } from '../src/map.js';
import { createRng } from '../src/rng.js';

const SEEDS = Number(process.argv[2]) || 200;
const SPREAD_SHARE = 0.5;
const enc = CONFIG.encounters;
const types = Object.keys(enc.types ?? enc.weights ?? {});
const bandIds = Object.keys(CONFIG.battle.enemies.bands);
const perBand = (v, i) => (Array.isArray(v) ? Number(v[Math.min(i, v.length - 1)] ?? 0) : Number(v ?? 0)) || 0;
const problems = [];
const agg = {};
const push = (k, n) => { (agg[k] = agg[k] ?? []).push(n); };

const signature = (map) => [...map.hexes.values()].map((h) => `${h.key}:${h.type}:${h.encounter ?? ''}`).join('|');

for (let seed = 1; seed <= SEEDS; seed++) {
  const map = generateMap(CONFIG, createRng(seed));
  if (signature(generateMap(CONFIG, createRng(seed))) !== signature(map)) problems.push(`seed ${seed}: generation is not deterministic`);
  const hexes = [...map.hexes.values()];
  for (const h of hexes) {
    if (!h.encounter || h.encounter === 'stasisSeed') continue;
    if (!h.passable || h.supplyCost > 0 || h.isStart || h.isSeed || h.isColony) problems.push(`seed ${seed}: ${h.encounter} on an ineligible tile ${h.key} (${h.type})`);
  }
  for (const t of enc.unique ?? []) {
    const n = hexes.filter((h) => h.encounter === t).length;
    if (n > 1) problems.push(`seed ${seed}: unique type ${t} appears ${n} times`);
  }
  for (const t of types) {
    const g = enc.types?.[t]?.guaranteed ?? enc.guaranteed?.[t] ?? 0;
    bandIds.forEach((b, bi) => {
      const tiles = hexes.filter((h) => bandIds[bandIndexOf(CONFIG, h.ring)] === b);
      const n = tiles.filter((h) => h.encounter === t).length;
      push(`${t}/${b}`, n);
      const min = perBand(g, bi);
      const room = tiles.filter((h) => h.passable && h.supplyCost === 0 && !h.isStart && !h.isSeed && !h.isColony).length;
      if (n < min && room >= min) problems.push(`seed ${seed}: band ${b} has ${n} x ${t}, minimum ${min}`);
    });
    const list = hexes.filter((h) => h.encounter === t);
    if (list.length >= 6) {
      const sext = [0, 0, 0, 0, 0, 0];
      for (const h of list) { const a = Math.atan2(h.y, h.x); sext[Math.floor(((a + Math.PI) / (2 * Math.PI)) * 6) % 6]++; }
      const share = Math.max(...sext) / list.length;
      push(`${t}/sextant-share`, share);
      if (share > SPREAD_SHARE) problems.push(`seed ${seed}: ${Math.round(share * 100)}% of the ${list.length} ${t} tiles sit in one sextant`);
    }
  }
  const rep = map.encounterReport;
  for (const [b, r] of Object.entries(rep?.bands ?? {})) for (const [t, n] of Object.entries(r.topped ?? {})) push(`topped ${t}/${b}`, n);
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
for (const [k, v] of Object.entries(agg)) {
  const min = Math.min(...v), max = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length;
  console.log(k.padEnd(24), 'min', fmt(min).padStart(5), 'mean', fmt(mean).padStart(6), 'max', fmt(max).padStart(5), k.startsWith('topped') ? `(${v.length} of ${SEEDS} seeds)` : '');
}
if (problems.length) { console.log(`\n${problems.length} PROBLEMS over ${SEEDS} seeds:`); for (const p of problems.slice(0, 40)) console.log(' - ' + p); process.exit(1); }
console.log(`\nALL GOOD (${SEEDS} seeds)`);
