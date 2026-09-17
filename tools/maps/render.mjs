// ASCII preview of authored map codes (see validate.mjs for usage).
// Legend: . neutral ground, 0/1/3/4 elevation, # wall, ~ ether, f fire,
// a capital letter = the pinned enemy's initial.
import fs from 'node:fs';
const ROOT = new URL('../../src/', import.meta.url).href;
const { CONFIG } = await import(ROOT + 'config.js');
const { recipeFromCode } = await import(ROOT + 'local/mapcode.js');
const maps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const want = process.argv.slice(3);
for (const m of maps) {
  if (want.length && !want.includes(m.id)) continue;
  const rc = recipeFromCode(m.code, CONFIG);
  const R = rc.radius;
  const en = {}; (rc.spawns?.enemies ?? []).forEach((k, i) => { en[k] = rc.enemyTypeIds[i]; });
  console.log(`\n== ${m.id} (${m.band}, R${R}) ${Object.values(en).join(', ')}`);
  for (let r = -R; r <= R; r++) {
    let row = ' '.repeat(r + R);
    for (let q = -R; q <= R; q++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > R) { row += '  '; continue; }
      const k = `${q},${r}`; const t = rc.tiles[k];
      let c = t ? (t.type === 'wall' ? '#' : t.type === 'ether' ? '~' : (t.tags ? 'f' : String(t.elevation))) : '.';
      if (c === '2') c = '.';
      if (en[k]) c = en[k][0].toUpperCase();
      row += c + ' ';
    }
    console.log(row);
  }
}
