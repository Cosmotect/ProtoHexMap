// Draws a contact sheet (SVG) of generated hack boards - ten seeds of the
// even spread (src/local/localmap.js buildHackRecipe) - so the placement
// can be judged at a glance: nodes blue, mines red, the party gold.
//   node tools/hack-layouts-sheet.mjs > tools/shots/hack-layouts.svg
import { buildHackRecipe } from '../src/local/localmap.js';
import { ENCOUNTERS } from '../src/config/encounters.js';

const H = ENCOUNTERS.hack;
const SEEDS = [1, 7, 42, 77, 123, 777, 2024, 4242, 9001, 31337];
const R = H.radius;
const cell = 9, cw = (R * 2 + 2) * cell * 1.8, ch = (R * 2 + 2) * cell * 1.6 + 26;
const cols = 5, rows = Math.ceil(SEEDS.length / cols);
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cw}" height="${rows * ch}" style="background:#0b0e16;font-family:monospace">`];
SEEDS.forEach((seed, i) => {
  const rec = buildHackRecipe(H, seed, { q: 3, r: -1 }, 3);
  const ox = (i % cols) * cw + cw / 2, oy = Math.floor(i / cols) * ch + ch / 2 + 8;
  const set = { node: new Set(rec.nodeKeys), mine: new Set(rec.mineKeys), party: new Set(rec.spawns.party) };
  parts.push(`<text x="${ox - cw / 2 + 6}" y="${oy - ch / 2 + 12}" fill="#e8ecf5" font-size="11">seed ${seed} n${rec.nodeKeys.length} m${rec.mineKeys.length}</text>`);
  for (let q = -R; q <= R; q++) for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
    const k = `${q},${r}`;
    const x = ox + (q + r / 2) * cell * 1.75, y = oy + r * cell * 1.52;
    const fill = set.node.has(k) ? '#5fc7e0' : set.mine.has(k) ? '#ff5d73' : set.party.has(k) ? '#ffd166' : '#242a3a';
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(cell * 0.78).toFixed(1)}" fill="${fill}"/>`);
  }
});
parts.push('</svg>');
process.stdout.write(parts.join('\n'));
