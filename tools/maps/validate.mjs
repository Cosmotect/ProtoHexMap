// =====================================================================
//  MAP CHECK - validates handcrafted map codes with the game's own parser
//  and a walkability pass that mirrors the engine's reach() rule (ground
//  units cannot cross a height gap > 1; walls and ether are impassable).
//  Usage (from the project root):
//    python3 tools/maps/build_maps.py /tmp/maps.json   # author -> JSON
//    node tools/maps/validate.mjs /tmp/maps.json        # check every map
//    node tools/maps/render.mjs /tmp/maps.json [id...]  # ASCII preview
//  The same checks apply to a code pasted straight into
//  config/encounters.js: put it in a JSON list [{ id, band, code }] first.
// =====================================================================
import fs from 'node:fs';
const ROOT = new URL('../../src/', import.meta.url).href;
const { CONFIG } = await import(ROOT + 'config.js');
const { recipeFromCode } = await import(ROOT + 'local/mapcode.js');
const { neutralElevation } = await import(ROOT + 'local/localmap.js');

const maps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
const mid = neutralElevation();
let bad = 0;
const rows = [];

for (const m of maps) {
  const recipe = recipeFromCode(m.code, CONFIG);
  const problems = [];
  if (recipe.errors.length) problems.push(...recipe.errors);
  const R = recipe.radius;
  // Every tile in the radius: type + elevation.
  const tiles = new Map();
  for (let q = -R; q <= R; q++) for (let r = -R; r <= R; r++) {
    if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > R) continue;
    const k = `${q},${r}`;
    const t = recipe.tiles[k];
    tiles.set(k, { type: t?.type ?? 'ground', h: t?.elevation ?? mid });
  }
  const ground = [...tiles.entries()].filter(([, t]) => t.type === 'ground').map(([k]) => k);
  // Components of walkable ground.
  const seen = new Set();
  const comps = [];
  for (const start of ground) {
    if (seen.has(start)) continue;
    const comp = new Set([start]); seen.add(start);
    const queue = [start];
    while (queue.length) {
      const k = queue.pop();
      const [q, r] = k.split(',').map(Number);
      for (const [dq, dr] of DIRS) {
        const nk = `${q + dq},${r + dr}`;
        const nt = tiles.get(nk);
        if (!nt || nt.type !== 'ground' || seen.has(nk)) continue;
        if (Math.abs(nt.h - tiles.get(k).h) > 1) continue;
        seen.add(nk); comp.add(nk); queue.push(nk);
      }
    }
    comps.push(comp);
  }
  comps.sort((a, b) => b.size - a.size);
  const main = comps[0] ?? new Set();
  const enemyKeys = recipe.spawns?.enemies ?? [];
  const types = recipe.enemyTypeIds;
  let stranded = [];
  enemyKeys.forEach((k, i) => {
    const def = CONFIG.battle.enemyTypes[types[i]];
    if (!def.flying && !main.has(k)) stranded.push(`${types[i]}@${k}`);
  });
  if (stranded.length) problems.push(`ground enemies outside the main walkable component: ${stranded.join(', ')}`);
  const strandedTiles = ground.filter((k) => !main.has(k) && !enemyKeys.includes(k));
  if (strandedTiles.length) problems.push(`ground tiles no ground unit can walk to or from (a random spawn there is stuck): ${strandedTiles.join(' ')}`);
  const frac = main.size / ground.length;
  if (frac < 0.7) problems.push(`main walkable component is only ${(frac * 100).toFixed(0)}% of the ground (${main.size}/${ground.length})`);
  if (main.size - enemyKeys.length < 15) problems.push(`too little free ground in the main component: ${main.size - enemyKeys.length}`);
  if (!enemyKeys.length) problems.push('no enemies pinned');
  // Count cliff borders inside the main component for the record.
  const hp = types.reduce((a, id) => a + (CONFIG.battle.enemyTypes[id]?.hp ?? 0), 0);
  rows.push({ id: m.id, band: m.band, R, enemies: enemyKeys.length, hp, ground: ground.length, main: main.size, comps: comps.length, problems });
  if (problems.length) bad += 1;
}

for (const r of rows) {
  const flag = r.problems.length ? 'FAIL' : ' ok ';
  console.log(`${flag} ${r.band.padEnd(8)} ${r.id.padEnd(18)} R${r.R} enemies=${String(r.enemies).padStart(2)} hp=${String(r.hp).padStart(3)} ground=${r.ground} main=${r.main} comps=${r.comps}`);
  for (const p of r.problems) console.log(`       - ${p}`);
}
console.log(`${rows.length} maps, ${bad} with problems`);
process.exitCode = bad ? 1 : 0;
