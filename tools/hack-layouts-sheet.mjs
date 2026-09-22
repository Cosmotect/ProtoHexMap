// Draws every hack layout (src/local/hack/hacklayouts.js) as a contact sheet
// (SVG) so the shapes can be judged at a glance, two seeds per layout.
//   node tools/hack-layouts-sheet.mjs > tools/shots/hack-layouts.svg
import { buildHackRecipe } from '../src/local/hack/hackmap.js';
import { HACK_CONFIG } from '../src/local/hack/hackconfig.js';
import { HACK_LAYOUTS } from '../src/local/hack/hacklayouts.js';

const SEEDS = [777, 4242];
const R = HACK_CONFIG.radius;
const cell = 9, cw = (R * 2 + 2) * cell * 1.8, ch = (R * 2 + 2) * cell * 1.6 + 26;
const cols = 5, rows = Math.ceil(HACK_LAYOUTS.length * SEEDS.length / cols);
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cw}" height="${rows * ch}" style="background:#0b0e16;font-family:monospace">`];
let i = 0;
for (const layout of HACK_LAYOUTS) {
  for (const seed of SEEDS) {
    const rec = buildHackRecipe({ ...HACK_CONFIG, forceLayout: layout.id }, seed, { q: 3, r: -1 }, 3);
    const ox = (i % cols) * cw + cw / 2, oy = Math.floor(i / cols) * ch + ch / 2 + 8;
    const set = { node: new Set(rec.nodeKeys), mine: new Set(rec.mineKeys), party: new Set(rec.spawns.party) };
    parts.push(`<text x="${ox - cw / 2 + 6}" y="${oy - ch / 2 + 12}" fill="#e8ecf5" font-size="11">${layout.name} (${seed}) n${rec.nodeKeys.length} m${rec.mineKeys.length}</text>`);
    for (let q = -R; q <= R; q++) for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
      const k = `${q},${r}`;
      const x = ox + (q + r / 2) * cell * 1.75, y = oy + r * cell * 1.52;
      const fill = set.node.has(k) ? '#5fc7e0' : set.mine.has(k) ? '#ff5d73' : set.party.has(k) ? '#ffd166' : '#242a3a';
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(cell * 0.78).toFixed(1)}" fill="${fill}"/>`);
    }
    i++;
  }
}
parts.push('</svg>');
process.stdout.write(parts.join('\n'));
