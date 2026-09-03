// =====================================================================
//  VIRTUAL PLAYTESTER - the combat gym (CLI).
//
//  Sweeps the bestiary: every enemy group x several party progression points
//  x N seeds, each fight played headlessly by a bot on a live arena. One JSON
//  line per fight goes to the output file; tools/playtester/report.mjs turns
//  the log into the difficulty-ladder report.
//
//  Usage (from the project root):
//    node tools/playtester/gym.mjs                         # defaults below
//    node tools/playtester/gym.mjs --seeds 50 --bot random
//    node tools/playtester/gym.mjs --groups huskTrio,warband --upgrades 0,8
//    node tools/playtester/gym.mjs --patch balance.json    # config experiment
//
//  Flags:
//    --groups   comma list of enemyGroups ids, or "all" (default all)
//    --seeds    fights per (group x progression) cell         (default 25)
//    --upgrades comma list of party upgrade counts            (default 0,4,8,12)
//    --party    comma list of roster names                    (default first 3)
//    --bot      greedy | random                               (default greedy)
//    --forced   also open every fight with the enemy ambush   (default off)
//    --seed0    first seed; cell seeds run seed0..seed0+N-1   (default 1)
//    --patch    JSON file of { "dotted.config.path": value } overrides -
//               the experiment knob: run once without, once with, same seeds,
//               and diff the two reports
//    --out      output JSONL                                  (default tools/playtester/runs.jsonl)
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../../src/config.js';
import { createRng } from '../../src/rng.js';
import { runFight, buildParty } from './headless.mjs';
import { BOTS } from './bots.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = val;
  }
  return out;
}

// The experiment knob: dotted-path overrides onto CONFIG, like a scenario's
// configPatch. Returns what changed, for the log header.
function applyPatch(config, patchFile) {
  const patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
  const applied = {};
  for (const [p, value] of Object.entries(patch)) {
    const parts = p.split('.');
    let obj = config;
    for (let i = 0; i < parts.length - 1 && obj; i++) obj = obj[parts[i]];
    if (!obj) { console.warn(`patch path not found, skipped: ${p}`); continue; }
    obj[parts[parts.length - 1]] = value;
    applied[p] = value;
  }
  return applied;
}

const args = parseArgs(process.argv);
const seeds = Number(args.seeds ?? 25);
const seed0 = Number(args.seed0 ?? 1);
const upgradePoints = String(args.upgrades ?? '0,4,8,12').split(',').map(Number);
const botName = String(args.bot ?? 'greedy');
const bot = BOTS[botName];
if (!bot) { console.error(`unknown bot "${botName}" (have: ${Object.keys(BOTS).join(', ')})`); process.exit(1); }
const partyNames = args.party
  ? String(args.party).split(',')
  : (CONFIG.party.roster ?? []).slice(0, CONFIG.party.size ?? 3).map((r) => r.name);
const patch = args.patch ? applyPatch(CONFIG, String(args.patch)) : null;
const groupIds = !args.groups || args.groups === 'all'
  ? Object.keys(CONFIG.battle.enemyGroups ?? {})
  : String(args.groups).split(',');
const outFile = String(args.out ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'runs.jsonl'));

// The header line makes every log self-describing and every run replayable.
const header = {
  kind: 'header',
  date: new Date().toISOString(),
  bot: botName,
  party: partyNames,
  seeds: { from: seed0, count: seeds },
  upgradePoints,
  groups: groupIds,
  forced: !!args.forced,
  patch,
};
const lines = [JSON.stringify(header)];

const total = groupIds.length * upgradePoints.length * seeds;
let done = 0, failures = 0;
const t0 = performance.now();
console.log(`gym: ${groupIds.length} groups x ${upgradePoints.length} progression points x ${seeds} seeds = ${total} fights (${botName} bot)`);

for (const groupId of groupIds) {
  for (const upgrades of upgradePoints) {
    for (let s = 0; s < seeds; s++) {
      const seed = seed0 + s;
      try {
        // The party is rebuilt per fight (fresh HP; seeded upgrade spread that
        // varies with the seed, so a cell samples many builds, not one).
        const party = buildParty(CONFIG, partyNames, upgrades, createRng((seed * 31 + upgrades) >>> 0));
        const rec = runFight({ config: CONFIG, groupId, party, seed, bot, forced: !!args.forced });
        rec.kind = 'fight';
        rec.upgrades = upgrades;
        lines.push(JSON.stringify(rec));
      } catch (e) {
        failures += 1;
        lines.push(JSON.stringify({ kind: 'error', groupId, upgrades, seed, error: String(e && e.message || e) }));
      }
      done += 1;
      if (done % 200 === 0) {
        const rate = done / ((performance.now() - t0) / 1000);
        console.log(`  ${done}/${total} (${rate.toFixed(1)} fights/s)`);
      }
    }
  }
}

fs.writeFileSync(outFile, lines.join('\n') + '\n');
const secs = (performance.now() - t0) / 1000;
console.log(`gym: ${done} fights in ${secs.toFixed(1)}s (${(done / secs).toFixed(1)}/s), ${failures} errors -> ${outFile}`);
if (failures) process.exitCode = 1;
