// =====================================================================
//  VIRTUAL PLAYTESTER - the report.
//
//  Renders whichever log it is given:
//    - a GYM log (gym.mjs, 'fight' lines) becomes the bestiary difficulty
//      ladder: per enemy group x party progression point - win rate (with a
//      rough 95% margin), average rounds and average party HP left
//    - a CAMPAIGN log (campaign.mjs, 'run' + 'pick' lines) becomes the run
//      report: per persona - win/loss/stall rates, how runs end, pace and
//      economy averages, and the upgrade pick-rate table (offered vs taken)
//  Prints the markdown and writes it next to the log.
//
//  Usage:
//    node tools/playtester/report.mjs                       # tools/playtester/runs.jsonl
//    node tools/playtester/report.mjs path/to/log.jsonl
//    node tools/playtester/report.mjs base.jsonl new.jsonl  # experiment diff
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../../src/config.js';

function loadLog(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    header: lines.find((l) => l.kind === 'header') ?? null,
    fights: lines.filter((l) => l.kind === 'fight'),
    runs: lines.filter((l) => l.kind === 'run'),
    picks: lines.filter((l) => l.kind === 'pick'),
    errors: lines.filter((l) => l.kind === 'error'),
  };
}

// Which shelf of the design ladder a group sits on (config-driven).
function bandOf(groupId) {
  const b = CONFIG.battle;
  for (const [name, band] of Object.entries(b.enemies.bands ?? {})) {
    if ((band.groups ?? []).includes(groupId)) return name;
  }
  if ((b.colonies ?? []).includes(groupId)) return 'colony';
  if ((b.bosses ?? []).includes(groupId)) return 'boss';
  return 'other';
}
const BAND_ORDER = ['inner', 'middle', 'outer', 'colony', 'boss', 'other'];

// group x upgrades -> { n, wins, rounds, hpLeft }
function aggregate(fights) {
  const cells = new Map();
  for (const f of fights) {
    const key = `${f.groupId}|${f.upgrades}`;
    const c = cells.get(key) ?? { groupId: f.groupId, upgrades: f.upgrades, n: 0, wins: 0, rounds: 0, hpLeft: 0, timeouts: 0 };
    c.n += 1;
    if (f.won) { c.wins += 1; c.rounds += f.rounds; c.hpLeft += f.partyHpLeftPct; }
    if (f.outcome === 'timeout') c.timeouts += 1;
    cells.set(key, c);
  }
  return cells;
}

const pct = (x) => `${Math.round(x * 100)}%`;
// Rough 95% margin on a proportion; enough to tell signal from noise.
const margin = (p, n) => (n ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 0);

function renderLadder(log, file) {
  const cells = aggregate(log.fights);
  const upgradePoints = [...new Set(log.fights.map((f) => f.upgrades))].sort((a, b) => a - b);
  const groups = [...new Set(log.fights.map((f) => f.groupId))];
  groups.sort((a, b) => BAND_ORDER.indexOf(bandOf(a)) - BAND_ORDER.indexOf(bandOf(b))
    || (log.fights.find((f) => f.groupId === a)?.enemyPower ?? 0) - (log.fights.find((f) => f.groupId === b)?.enemyPower ?? 0));

  const out = [];
  out.push(`# Virtual Playtester - bestiary difficulty ladder`);
  out.push('');
  if (log.header) {
    out.push(`Log: ${path.basename(file)} | ${log.header.date} | bot: ${log.header.bot} | party: ${log.header.party.join(', ')} | seeds ${log.header.seeds.count} per cell${log.header.forced ? ' | AMBUSH openings' : ''}`);
    if (log.header.patch) out.push(`Config patch: \`${JSON.stringify(log.header.patch)}\``);
    out.push('');
  }
  out.push(`Cells read "win rate (avg rounds / avg party HP left when winning)". The party column header is the number of unlocked ability upgrades - the gym's stand-in for run progression.`);
  out.push('');
  out.push(`| band | group | power | ${upgradePoints.map((u) => `${u} upg`).join(' | ')} |`);
  out.push(`| --- | --- | --- | ${upgradePoints.map(() => '---').join(' | ')} |`);
  for (const g of groups) {
    const power = log.fights.find((f) => f.groupId === g)?.enemyPower ?? '?';
    const title = log.fights.find((f) => f.groupId === g)?.title ?? g;
    const cols = upgradePoints.map((u) => {
      const c = cells.get(`${g}|${u}`);
      if (!c || !c.n) return '-';
      const p = c.wins / c.n;
      const wr = `${pct(p)} ±${pct(margin(p, c.n))}`;
      const extra = c.wins ? ` (${(c.rounds / c.wins).toFixed(1)}r / ${(c.hpLeft / c.wins).toFixed(0)}%hp)` : '';
      const to = c.timeouts ? ` [${c.timeouts} timeouts]` : '';
      return `${wr}${extra}${to}`;
    });
    out.push(`| ${bandOf(g)} | ${title} | ${power} | ${cols.join(' | ')} |`);
  }
  if (log.errors.length) {
    out.push('');
    out.push(`**${log.errors.length} errored fights** (first: \`${JSON.stringify(log.errors[0])}\`)`);
  }
  return out.join('\n');
}

// ----- campaign report ---------------------------------------------------
function renderCampaign(log, file) {
  const out = [];
  out.push(`# Virtual Playtester - campaign report`);
  out.push('');
  if (log.header) {
    out.push(`Log: ${path.basename(file)} | ${log.header.date} | combat bot: ${log.header.bot} | ${log.header.runs.count} runs per persona (seeds from ${log.header.runs.from})`);
    if (log.header.patch) out.push(`Config patch: \`${JSON.stringify(log.header.patch)}\``);
    out.push('');
  }

  const personas = [...new Set(log.runs.map((r) => r.persona))];
  const avg = (list, f) => (list.length ? list.reduce((a, x) => a + f(x), 0) / list.length : 0);

  out.push('## How the runs went');
  out.push('');
  out.push('| persona | runs | won | lost | stalled | avg turns | avg fights | fights won | forced | colonies | deaths/run | upgrades | supplies left |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of personas) {
    const rs = log.runs.filter((r) => r.persona === p);
    const won = rs.filter((r) => r.outcome === 'won').length;
    const lost = rs.filter((r) => r.outcome === 'lost').length;
    const other = rs.length - won - lost;
    const fw = avg(rs, (r) => r.fightsWon);
    const ft = avg(rs, (r) => r.fights);
    out.push(`| ${p} | ${rs.length} | ${pct(won / rs.length)} ±${pct(margin(won / rs.length, rs.length))} | ${pct(lost / rs.length)} | ${pct(other / rs.length)} | ${avg(rs, (r) => r.turns).toFixed(0)} | ${ft.toFixed(1)} | ${ft ? pct(fw / ft) : '-'} | ${avg(rs, (r) => r.forcedFights).toFixed(1)} | ${avg(rs, (r) => r.coloniesCleared).toFixed(1)} | ${avg(rs, (r) => r.deaths).toFixed(1)} | ${avg(rs, (r) => r.upgradesTotal).toFixed(1)} | ${avg(rs, (r) => r.suppliesLeft).toFixed(1)} |`);
  }

  out.push('');
  out.push('## How the runs ENDED (loss anatomy)');
  out.push('');
  out.push('| persona | end | count | share |');
  out.push('| --- | --- | --- | --- |');
  for (const p of personas) {
    const rs = log.runs.filter((r) => r.persona === p);
    const ends = new Map();
    for (const r of rs) {
      const key = `${r.outcome}:${r.endReason ?? '-'}`;
      ends.set(key, (ends.get(key) ?? 0) + 1);
    }
    for (const [key, n] of [...ends].sort((a, b) => b[1] - a[1])) {
      out.push(`| ${p} | ${key} | ${n} | ${pct(n / rs.length)} |`);
    }
  }

  if (log.picks.length) {
    out.push('');
    out.push('## Upgrade pick rates (offered vs taken, all personas pooled)');
    out.push('');
    out.push('The chooser is a seeded RANDOM pick on purpose - the rates below measure what the GAME offers, not a bot-invented meta. "offered" counts every screen the ref appeared on.');
    out.push('');
    const stats = new Map();
    for (const pk of log.picks) {
      for (const ref of pk.offered ?? []) {
        const s = stats.get(ref) ?? { offered: 0, taken: 0 };
        s.offered += 1;
        if (ref === pk.picked) s.taken += 1;
        stats.set(ref, s);
      }
    }
    const rows = [...stats].sort((a, b) => b[1].offered - a[1].offered);
    out.push('| upgrade ref | offered | taken | take rate |');
    out.push('| --- | --- | --- | --- |');
    for (const [ref, s] of rows.slice(0, 40)) {
      out.push(`| ${ref} | ${s.offered} | ${s.taken} | ${pct(s.taken / s.offered)} |`);
    }
    if (rows.length > 40) out.push(`| ... ${rows.length - 40} more refs | | | |`);
  }

  if (log.errors.length) {
    out.push('');
    out.push(`**${log.errors.length} errored runs** (first: \`${JSON.stringify(log.errors[0]).slice(0, 400)}\`)`);
  }
  return out.join('\n');
}

// Campaign experiment diff: per-persona win-rate deltas, candidate minus baseline.
function renderCampaignDiff(base, next) {
  const out = [];
  out.push(`# Virtual Playtester - campaign diff (win rate, candidate minus baseline)`);
  if (next.header?.patch) out.push(`\nCandidate patch: \`${JSON.stringify(next.header.patch)}\``);
  out.push('');
  out.push('| persona | baseline | candidate | delta |');
  out.push('| --- | --- | --- | --- |');
  const personas = [...new Set([...base.runs, ...next.runs].map((r) => r.persona))];
  for (const p of personas) {
    const a = base.runs.filter((r) => r.persona === p);
    const b = next.runs.filter((r) => r.persona === p);
    if (!a.length || !b.length) continue;
    const pa = a.filter((r) => r.outcome === 'won').length / a.length;
    const pb = b.filter((r) => r.outcome === 'won').length / b.length;
    const delta = pb - pa;
    const mark = Math.abs(delta) > margin(pa, a.length) + margin(pb, b.length) ? ' **' : '';
    out.push(`| ${p} | ${pct(pa)} | ${pct(pb)} | ${delta >= 0 ? '+' : ''}${pct(delta)}${mark} |`);
  }
  out.push('');
  out.push('`**` marks a delta larger than both margins combined - likely real, not noise.');
  return out.join('\n');
}

// Experiment diff: win-rate deltas, new minus base, same cells.
function renderDiff(base, next) {
  const a = aggregate(base.fights);
  const b = aggregate(next.fights);
  const out = [];
  out.push(`# Virtual Playtester - experiment diff (win rate, candidate minus baseline)`);
  if (next.header?.patch) out.push(`\nCandidate patch: \`${JSON.stringify(next.header.patch)}\``);
  out.push('');
  out.push('| group | upgrades | baseline | candidate | delta |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const [key, cb] of b) {
    const ca = a.get(key);
    if (!ca) continue;
    const pa = ca.wins / ca.n, pb = cb.wins / cb.n;
    const delta = pb - pa;
    const mark = Math.abs(delta) > margin(pa, ca.n) + margin(pb, cb.n) ? ' **' : '';
    out.push(`| ${cb.groupId} | ${cb.upgrades} | ${pct(pa)} | ${pct(pb)} | ${delta >= 0 ? '+' : ''}${pct(delta)}${mark} |`);
  }
  out.push('');
  out.push('`**` marks a delta larger than both margins combined - likely real, not noise.');
  return out.join('\n');
}

const argFiles = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const here = path.dirname(new URL(import.meta.url).pathname);
const mainFile = argFiles[0] ?? path.join(here, 'runs.jsonl');

let text;
let outName;
if (argFiles.length >= 2) {
  const a = loadLog(argFiles[0]);
  const b = loadLog(argFiles[1]);
  text = a.runs.length || b.runs.length ? renderCampaignDiff(a, b) : renderDiff(a, b);
  outName = 'diff.md';
} else {
  const log = loadLog(mainFile);
  text = log.runs.length ? renderCampaign(log, mainFile) : renderLadder(log, mainFile);
  outName = log.runs.length ? 'campaign-report.md' : 'report.md';
}
const outFile = path.join(path.dirname(mainFile), outName);
fs.writeFileSync(outFile, text + '\n');
console.log(text);
console.log(`\n-> ${outFile}`);
