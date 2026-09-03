// =====================================================================
//  VIRTUAL PLAYTESTER - the campaign runner (CLI).
//
//  Plays full headless runs: N seeds per persona, each a complete campaign
//  (exploration, camps, shops, forced fights, Colonies, the Seed assault)
//  through worldrun.mjs. One JSON line per run plus one per upgrade-pick
//  decision goes to the log; tools/playtester/report.mjs renders it.
//
//  Usage (from the project root):
//    node tools/playtester/campaign.mjs                      # defaults below
//    node tools/playtester/campaign.mjs --runs 50 --personas bold
//    node tools/playtester/campaign.mjs --patch balance.json # config experiment
//
//  Flags:
//    --runs      runs per persona                          (default 10)
//    --personas  comma list from worldbot.mjs PERSONAS,
//                or "all"                                  (default all)
//    --bot       combat policy: greedy | random            (default greedy)
//    --seed0     first world seed; runs use seed0..+N-1    (default 1)
//    --maxTurns  give up a run after this many map steps   (default 500)
//    --patch     JSON of { "dotted.config.path": value } overrides
//    --out       output JSONL          (default tools/playtester/worldruns.jsonl)
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../../src/config.js';
import { runWorld } from './worldrun.mjs';
import { PERSONAS } from './worldbot.mjs';
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
const runs = Number(args.runs ?? 10);
const seed0 = Number(args.seed0 ?? 1);
const maxTurns = Number(args.maxTurns ?? 500);
const botName = String(args.bot ?? 'greedy');
const bot = BOTS[botName];
if (!bot) { console.error(`unknown bot "${botName}" (have: ${Object.keys(BOTS).join(', ')})`); process.exit(1); }
const personaNames = !args.personas || args.personas === 'all'
  ? Object.keys(PERSONAS)
  : String(args.personas).split(',');
for (const p of personaNames) {
  if (!PERSONAS[p]) { console.error(`unknown persona "${p}" (have: ${Object.keys(PERSONAS).join(', ')})`); process.exit(1); }
}
const patch = args.patch ? applyPatch(CONFIG, String(args.patch)) : null;
const outFile = String(args.out ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'worldruns.jsonl'));

const header = {
  kind: 'header',
  mode: 'campaign',
  date: new Date().toISOString(),
  bot: botName,
  personas: personaNames,
  runs: { from: seed0, count: runs },
  maxTurns,
  patch,
};
const lines = [JSON.stringify(header)];

const total = personaNames.length * runs;
let done = 0, failures = 0;
const t0 = performance.now();
console.log(`campaign: ${personaNames.length} personas x ${runs} runs = ${total} campaigns (${botName} combat bot)`);

for (const personaName of personaNames) {
  const persona = PERSONAS[personaName];
  for (let i = 0; i < runs; i++) {
    const seed = seed0 + i;
    try {
      const { record, picks } = runWorld({ config: CONFIG, seed, persona, bot, maxTurns });
      lines.push(JSON.stringify(record));
      for (const p of picks) lines.push(JSON.stringify({ ...p, persona: personaName, seed }));
    } catch (e) {
      failures += 1;
      lines.push(JSON.stringify({ kind: 'error', persona: personaName, seed, error: String(e && e.stack || e) }));
    }
    done += 1;
    if (done % 10 === 0) {
      const rate = done / ((performance.now() - t0) / 1000);
      console.log(`  ${done}/${total} (${rate.toFixed(1)} runs/s)`);
    }
  }
}

fs.writeFileSync(outFile, lines.join('\n') + '\n');
const secs = (performance.now() - t0) / 1000;
console.log(`campaign: ${done} runs in ${secs.toFixed(1)}s (${(done / secs).toFixed(1)}/s), ${failures} errors -> ${outFile}`);
if (failures) process.exitCode = 1;
