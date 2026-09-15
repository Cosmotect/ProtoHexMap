// Headless playtest of the HACK encounter (src/local/hack/ - an EXPERIMENT,
// see DESIGN.md). Opens the built game, plants a hack on the party's tile,
// presses E, and plays a turn by hand through the engine's public surface:
// walks a unit, locks three aims on one node, checks the stacked preview,
// fires, checks the progress bar - then wins via debugResolve and checks the
// reward window, and in a second run loses and checks the tile is consumed.
//
//   npm run build && npx vite preview --port 4173     (one terminal)
//   node tools/hack-test.cjs                          (another)
// Environment: URL, CHROMIUM (browser binary), OUT (screenshot folder).
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const URL = process.env.URL || 'http://localhost:4173/?seed=777&nostart=1';
const OUT = process.env.OUT || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  const check = (ok, msg) => { if (!ok) problems.push(msg); console.log((ok ? '  ok   ' : '  FAIL ') + msg); };
  page.on('pageerror', (e) => problems.push('PAGE ERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const src = (m.location() && m.location().url) || '';
    if (m.text().includes('ERR_TUNNEL_CONNECTION_FAILED') || src.includes('fonts.g')) return;
    problems.push(m.type() + ': ' + m.text());
  });
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);

  const dismissDialog = async () => {
    await page.evaluate(() => { const b = document.querySelectorAll('#dialog-actions button'); if (b.length) b[b.length - 1].click(); });
    await page.waitForTimeout(120);
  };
  const dialogOpen = () => page.evaluate(() => !document.getElementById('dialog').classList.contains('hidden'));
  const dialogTitle = () => page.evaluate(() => document.querySelector('#dialog .title, #dialog h2, #dialog-title')?.textContent ?? document.getElementById('dialog').textContent.slice(0, 80));

  // ----- 1. the world map knows the type ------------------------------------
  const legend = await page.evaluate(() => document.getElementById('legend-items')?.textContent ?? '');
  check(legend.includes('Hack'), 'legend lists the Hack encounter');
  const hacksOnMap = await page.evaluate(() => [...window.game.map.hexes.values()].filter((h) => h.encounter === 'hack').length);
  check(hacksOnMap > 0, `generated map holds hack tiles (${hacksOnMap})`);

  // ----- 2. enter a hack ------------------------------------------------------
  const startEnter = async () => {
    await page.evaluate(() => { const g = window.game; g.state.position.encounter = 'hack'; g.emit('change'); });
    await page.waitForTimeout(200);
    await page.keyboard.press('e');
    await page.waitForFunction(() => !!window.__hack && window.__cinematic.mode() === 'local', null, { timeout: 30000 });
    await page.waitForTimeout(400);
  };
  await startEnter();
  const s0 = await page.evaluate(() => {
    const h = window.__hack; const sb = h.state;
    return {
      units: sb.units.length, nodes: Object.values(sb.tags).filter((t) => t.kind === 'node').length,
      mines: Object.values(sb.tags).filter((t) => t.kind === 'mine').length,
      flat: new Set(Object.values(sb.heights)).size === 1,
      bar: !!document.getElementById('hack-bar'), battleBar: !document.getElementById('battle-bar').classList.contains('hidden'),
      round: document.getElementById('battle-round').textContent, active: sb.activeUid, abilities: document.querySelectorAll('#battle-abilities button').length,
      progress: sb.progress, turns: h.hackConfig.turns,
    };
  });
  check(s0.units === 3, `three party units on the board (${s0.units})`);
  check(s0.nodes > 0 && s0.mines > 0, `nodes and mines placed (${s0.nodes} / ${s0.mines})`);
  check(s0.flat, 'the board is flat');
  check(s0.bar && s0.battleBar, 'hack progress bar and battle bar are shown');
  check(/Turn 1 \/ \d+/.test(s0.round), `battle bar reads the turn (${s0.round})`);
  check(!!s0.active && s0.abilities === 2, 'a unit is selected with two ability buttons');
  await page.screenshot({ path: path.join(OUT, 'hack-1-open.png') });

  // ----- 3. play a turn: three aims on one node -----------------------------
  // For each unit: find a (walkable tile, ability, aim anchor) that covers the
  // chosen node, walk there, lock. First unit picks the node.
  const turn = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    const K = (q, r) => q + ',' + r; const PK = (k) => k.split(',').map(Number);
    const add = (k, o) => { const [q, r] = PK(k); return K(q + o[0], r + o[1]); };
    const rot = (o, k) => { let q = o[0], r = o[1]; for (let i = 0; i < k; i++) { const nq = -r, nr = q + r; q = nq; r = nr; } return [q, r]; };
    const aimRot = (a, b) => { if (a === b) return 0; const [q1, r1] = PK(a), [q2, r2] = PK(b); const dq = q2 - q1, dr = r2 - r1; const x = Math.sqrt(3) * (dq + dr / 2), y = 1.5 * dr; const ang = Math.atan2(y, x) * 180 / Math.PI; return ((Math.round(ang / 60) % 6) + 6) % 6; };
    const covers = (ab, from, anchor, node) => ab.dmgZone.some((o) => add(anchor, rot(o, ab.rotatable ? aimRot(from, anchor) : 0)) === node);
    const out = { locks: [], node: null, preview: null };
    const nodes = Object.keys(sb.tags).filter((k) => sb.tags[k].kind === 'node');
    // Pick the node closest to the party.
    const dist = (a, b) => { const [q1, r1] = PK(a), [q2, r2] = PK(b); return (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(q1 + r1 - q2 - r2)) / 2; };
    const node = nodes.sort((a, b) => Math.min(...sb.units.map((u) => dist(u.pos, a))) - Math.min(...sb.units.map((u) => dist(u.pos, b))))[0];
    out.node = node;
    for (const u of sb.units) {
      h.activate(u.uid);
      await wait(50);
      const reach = h.reachFor();
      const stands = [u.pos, ...Object.keys(reach.d).filter((k) => !reach.occ.has(k) && !sb.tags[k])];
      let plan = null;
      for (const from of stands) {
        for (const id of u.abilityIds) {
          const ab = h.abilityFor(u, id);
          if (!h.lockable(u, id)) continue;
          for (const off of ab.castZone) {
            const anchor = add(from, off);
            if (covers(ab, from, anchor, node)) { plan = { from, id, anchor }; break; }
          }
          if (plan) break;
        }
        if (plan) break;
      }
      if (!plan) { out.locks.push({ uid: u.uid, skipped: true }); continue; }
      if (plan.from !== u.pos) { h.clickTile(plan.from); await wait(1200); }
      h.selectAbility(plan.id);
      await wait(50);
      // The preview under the cursor: the engine's own query.
      const before = h.previewTotals(null).get(node);
      const anchorClick = Object.keys(sb.aimMap).find((k) => sb.aimMap[k] === plan.anchor) ?? plan.anchor;
      const pv = h.previewTotals(anchorClick).get(node);
      h.clickTile(anchorClick);
      await wait(100);
      const lu = sb.units.find((x) => x.uid === u.uid);
      out.locks.push({ uid: u.uid, pos: lu.pos, id: plan.id, locked: !!lu.lock, coversNode: !!lu.lock && lu.lock.tiles.includes(node), pvN: pv?.n, pvMult: pv?.mult, pvTotal: pv?.total, beforeN: before?.n ?? 0 });
    }
    out.preview = h.previewTotals(null).get(node) ?? null;
    out.nodeHpBefore = sb.tags[node].hp;
    out.lockedCount = h.lockedUnits().length;
    return out;
  });
  console.log('  turn plan:', JSON.stringify(turn));
  const locked = turn.locks.filter((l) => l.locked && l.coversNode).length;
  check(locked >= 2, `at least two units locked an aim on the same node (${locked})`);
  if (turn.preview) {
    const H = await page.evaluate(() => window.__hack.hackConfig);
    check(turn.preview.n === locked && turn.preview.mult === H.multipliers[Math.min(locked, H.multipliers.length) - 1], `preview stacks ${turn.preview.n} abilities at x${turn.preview.mult} = ${turn.preview.total}`);
  }
  await page.screenshot({ path: path.join(OUT, 'hack-2-locked.png') });
  const labelsShown = await page.evaluate(() => window.__localView.scene.children.filter((o) => o.isSprite).length);
  check(labelsShown > 0, `label sprites on the board (${labelsShown})`);

  // Fire.
  const fired = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state; const node = Object.keys(sb.tags).find(() => true);
    const p0 = sb.progress; const r0 = sb.round;
    h.endTurn();
    await new Promise((r) => setTimeout(r, 1400));
    return { p0, p1: sb.progress, r0, r1: sb.round, lastTurn: sb.lastTurn, busy: sb.busy, over: sb.over, locks: h.lockedUnits().length, bar: document.querySelector('#hack-bar .hack-ends .val')?.textContent, round: document.getElementById('battle-round').textContent };
  });
  console.log('  fired:', JSON.stringify(fired));
  const expectedGain = Math.min(turn.preview?.total ?? 0, turn.nodeHpBefore);
  check(fired.p1 - fired.p0 === expectedGain - (fired.lastTurn?.lost ?? 0), `progress moved by the dealt damage minus mine losses (${fired.p0} -> ${fired.p1}, expected +${expectedGain} -${fired.lastTurn?.lost ?? 0})`);
  check(fired.r1 === fired.r0 + 1 && !fired.busy && !fired.over, 'a new turn started');
  check(fired.locks === 0, 'locks are cleared after firing');
  check(fired.bar === (fired.p1 > 0 ? '+' : '') + String(fired.p1), `the bar shows the progress (${fired.bar})`);
  await page.screenshot({ path: path.join(OUT, 'hack-3-fired.png') });

  // A mine hit: lock an aim on a mine tile directly and fire.
  const mine = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const PK = (k) => k.split(',').map(Number);
    const K = (q, r) => q + ',' + r;
    const mines = Object.keys(sb.tags).filter((k) => sb.tags[k].kind === 'mine');
    for (const u of sb.units) {
      h.activate(u.uid); await wait(30);
      const reach = h.reachFor();
      const stands = [u.pos, ...Object.keys(reach.d).filter((k) => !reach.occ.has(k) && !sb.tags[k])];
      for (const from of stands) {
        for (const id of u.abilityIds) {
          if (!h.lockable(u, id)) continue;
          const ab = h.abilityFor(u, id);
          if (ab.rotatable) continue;   // keep it simple: a single-tile, non-rotating aim
          for (const off of ab.castZone) {
            const [q, r] = PK(from); const anchor = K(q + off[0], r + off[1]);
            if (!mines.includes(anchor)) continue;
            if (from !== u.pos) { h.clickTile(from); await wait(1200); }
            h.selectAbility(id); await wait(30);
            if (!sb.aimMap || sb.aimMap[anchor] === undefined) { h.cancel(); continue; }
            const hp0 = u.hp, p0 = sb.progress;
            h.clickTile(anchor); await wait(60);
            const lock = sb.units.find((x) => x.uid === u.uid).lock;
            h.endTurn(); await wait(1400);
            return { found: true, hp0, hp1: sb.units.find((x) => x.uid === u.uid).hp, p0, p1: sb.progress, mineGone: !sb.tags[anchor], lock: !!lock, over: sb.over };
          }
        }
      }
    }
    return { found: false };
  });
  console.log('  mine:', JSON.stringify(mine));
  if (mine.found) {
    const H = await page.evaluate(() => window.__hack.hackConfig);
    check(mine.hp1 === Math.max(1, mine.hp0 - H.mineDamage), `the aiming unit took mine damage (${mine.hp0} -> ${mine.hp1})`);
    check(mine.p1 <= mine.p0 - H.minePenalty || mine.over, `the bar dropped by the mine penalty (${mine.p0} -> ${mine.p1})`);
    check(mine.mineGone === !!H.mineDetonates, 'the mine detonated');
  } else console.log('  (no reachable mine for a plain aim this layout - skipped)');

  // ----- 4. win -> the regular reward window ---------------------------------
  await page.evaluate(() => window.__hack.debugResolve(true));
  await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 15000 });
  const winTitle = await dialogTitle();
  const winHtml = await page.evaluate(() => document.getElementById('dialog').textContent);
  check(/Hack complete/i.test(winHtml), `victory window opened (${winTitle.trim().slice(0, 40)})`);
  check(/upgrade|reward|Continue/i.test(winHtml), 'victory window offers the reward continue');
  const hackGoneAfterWin = await page.evaluate(() => !window.__hack && !document.getElementById('hack-bar'));
  check(hackGoneAfterWin, 'the hack engine and bar are torn down on the win');
  await page.screenshot({ path: path.join(OUT, 'hack-4-won.png') });
  await dismissDialog();
  // The upgrade chooser (if offered) - take the first.
  await page.waitForTimeout(300);
  if (await dialogOpen()) {
    await page.evaluate(() => { const c = document.querySelector('#dialog .upgrade-card, #dialog .offer, #dialog-actions button'); if (c) c.click(); });
    await page.waitForTimeout(300);
    if (await dialogOpen()) await dismissDialog();
  }
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 30000 }).catch(() => problems.push('did not fly back out after the win'));
  const tileAfterWin = await page.evaluate(() => window.game.state.position.encounter);
  check(tileAfterWin === null, `the tile is consumed after the win (${tileAfterWin})`);
  const partyOk = await page.evaluate(() => window.game.state.party.every((u) => u.hp >= 1));
  check(partyOk, 'party hp carried back (nobody below 1)');
  await page.waitForTimeout(800);

  // ----- 5. lose -> consumed, run continues ----------------------------------
  await startEnter();
  await page.evaluate(() => window.__hack.debugResolve(false));
  await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 15000 });
  const loseHtml = await page.evaluate(() => document.getElementById('dialog').textContent);
  check(/Hack failed/i.test(loseHtml), 'failure window opened');
  await page.screenshot({ path: path.join(OUT, 'hack-5-lost.png') });
  await dismissDialog();
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 30000 }).catch(() => problems.push('did not fly back out after the loss'));
  const after = await page.evaluate(() => ({ enc: window.game.state.position.encounter, status: window.game.state.status, hack: !!window.__hack, battleMode: document.body.classList.contains('battle-mode') }));
  check(after.enc === null && after.status === 'playing' && !after.hack && !after.battleMode, `loss consumed the tile and the run continues (${JSON.stringify(after)})`);
  await page.screenshot({ path: path.join(OUT, 'hack-6-back.png') });

  await browser.close();
  console.log(problems.length ? `\n${problems.length} PROBLEM(S):\n - ${problems.join('\n - ')}` : '\nALL GOOD');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
