// Headless playtest of the HACK terminal (config.hack - see DESIGN.md "The
// Hack terminal"). Opens the built game, plants a hack on the party's tile,
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
      units: sb.units.filter((u) => !u.isEnemy).length, nodes: sb.objects.filter((u) => u.kind === 'hackNode').length,
      mines: sb.objects.filter((u) => u.kind === 'hackMine').length,
      tags: Object.keys(sb.tags).length, enemies: sb.units.filter((u) => u.isEnemy).length, radius: h.hackConfig.radius,
      farNodes: sb.objects.filter((u) => u.kind === 'hackNode' && (() => { const [q, r] = u.pos.split(',').map(Number); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > 5; })()).length,
      flat: new Set(Object.values(sb.heights)).size === 1,
      bar: !!document.getElementById('hack-bar'), battleBar: !document.getElementById('battle-bar').classList.contains('hidden'),
      round: document.getElementById('battle-round').textContent, active: sb.activeUid, abilities: document.querySelectorAll('#battle-abilities button').length,
      cleared: sb.ext.hack.cleared, total: sb.ext.hack.total, badges: document.querySelectorAll('#hack-bar .badge').length, lit: document.querySelectorAll('#hack-bar .badge.lit').length, turns: h.hackConfig.turns, lockedAim: sb.lockedAim,
    };
  });
  check(s0.units === 3, `three party units on the board (${s0.units})`);
  check(s0.tags === 0 && s0.enemies === 0, 'nodes and mines are the engine\'s OBJECTS: no tags, no enemy units on the board');
  if (s0.radius > 5) check(s0.farNodes > 0, `nodes reach the rings a radius-5 board did not have (${s0.farNodes} past ring 5 on radius ${s0.radius})`);
  // Nodes are HackNode objects with hp rolled in H.nodeHp: every node's hp is
  // inside the range, they are not all the same, and the arena shows each
  // node as exactly hp discs.
  const rolls = await page.evaluate(() => {
    const sb = window.__hack.state; const H = window.__hack.hackConfig;
    const nodes = sb.objects.filter((u) => u.kind === 'hackNode');
    const hps = nodes.map((u) => u.hp);
    const range = Array.isArray(H.nodeHp) ? [Math.min(...H.nodeHp), Math.max(...H.nodeHp)] : null;
    const row = range ? range.join('-') : null;
    const hv = window.__hackView;
    const discs = hv ? nodes.map((u) => ({ hp: u.hp, discs: hv.discCount(u.uid) })) : null;
    return { row, range, hps, distinct: new Set(hps).size, discs, mines: hv ? hv.mineCount() : null, mineUnits: sb.objects.filter((u) => u.kind === 'hackMine').length };
  });
  console.log('  node hp rolls:', JSON.stringify(rolls));
  check(rolls.range && rolls.hps.length && rolls.hps.every((h) => h >= rolls.range[0] && h <= rolls.range[1]), `every node's hp is rolled inside H.nodeHp ${rolls.row}`);
  check(rolls.distinct > 1, `the rolls differ between nodes (${rolls.distinct} distinct values)`);
  check(rolls.discs && rolls.discs.every((d) => d.discs === d.hp), 'every node stands as exactly hp discs');
  check(rolls.mines === rolls.mineUnits && rolls.mines > 0, `every mine has its icon on the tile (${rolls.mines})`);
  check(s0.nodes > 0 && s0.mines > 0, `nodes and mines placed (${s0.nodes} / ${s0.mines})`);
  check(s0.flat, 'the board is flat');
  check(s0.bar && s0.battleBar, 'hack panel and battle bar are shown');
  check(s0.badges === 3 && s0.lit === 0 && s0.cleared === 0 && s0.total === s0.nodes, `three unlit badges, ${s0.total} nodes to clear`);
  check(s0.turns === 5, `five turns (${s0.turns})`);
  check(/Turn 1 \/ \d+/.test(s0.round), `battle bar reads the turn (${s0.round})`);
  check(!!s0.active && s0.abilities >= 2, `a unit is selected with its ability buttons (${s0.abilities})`);
  check(s0.lockedAim, 'aim locks are on (config.combat.lockedAim)');
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
    const nodeAt = (k) => sb.objects.find((u) => u.kind === 'hackNode' && u.hp > 0 && u.pos === k);
    const nodes = sb.objects.filter((u) => u.kind === 'hackNode' && u.hp > 0).map((u) => u.pos);
    const lockable = (u, id) => { const ab = h.abilityFor(u, id); return !!ab && h.damageOf(ab).base > 0; };
    // Pick the node closest to the party.
    const dist = (a, b) => { const [q1, r1] = PK(a), [q2, r2] = PK(b); return (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(q1 + r1 - q2 - r2)) / 2; };
    const party = sb.units.filter((u) => !u.isEnemy && u.hp > 0);
    const node = nodes.sort((a, b) => Math.min(...party.map((u) => dist(u.pos, a))) - Math.min(...party.map((u) => dist(u.pos, b))))[0];
    out.node = node;
    out.nodeUid = nodeAt(node).uid;
    for (const u of party) {
      h.activate(u.uid);
      await wait(50);
      const reach = h.reachFor();
      const stands = [u.pos, ...Object.keys(reach.d).filter((k) => !reach.occ.has(k) && !sb.tags[k])];
      let plan = null;
      for (const from of stands) {
        for (const id of u.abilityIds) {
          const ab = h.abilityFor(u, id);
          if (!lockable(u, id)) continue;
          for (const off of ab.castZone) {
            const anchor = add(from, off);
            if (covers(ab, from, anchor, node)) { plan = { from, id, anchor }; break; }
          }
          if (plan) break;
        }
        if (plan) break;
      }
      if (!plan) { out.locks.push({ uid: u.uid, skipped: true }); continue; }
      if (plan.from !== u.pos) { h.clickTile(plan.from); for (let g = 0; g < 60 && sb.busy; g++) await wait(100); }
      h.activate(u.uid); await wait(30);
      h.selectAbility(plan.id);
      await wait(50);
      if (!sb.aimMap) { out.locks.push({ uid: u.uid, skipped: 'ability refused', id: plan.id, busy: sb.busy, cur: h.curPlayer()?.uid }); continue; }
      // The preview under the cursor: the engine's own query.
      const before = h.previewTotals(null).get(node);
      const anchorClick = Object.keys(sb.aimMap).find((k) => sb.aimMap[k] === plan.anchor) ?? plan.anchor;
      const pv = h.previewTotals(anchorClick).get(node);
      h.clickTile(anchorClick);
      await wait(100);
      const lu = sb.units.find((x) => x.uid === u.uid);
      out.locks.push({ uid: u.uid, pos: lu.pos, id: plan.id, locked: !!lu.lock, coversNode: !!lu.lock && lu.lock.tiles.includes(node), pvN: pv?.n, pvBonus: pv?.bonus, pvTotal: pv?.total, beforeN: before?.n ?? 0 });
    }
    out.preview = h.previewTotals(null).get(node) ?? null;
    out.nodeHpBefore = nodeAt(node).hp;
    out.lockedCount = h.lockedUnits().length;
    return out;
  });
  console.log('  turn plan:', JSON.stringify(turn));
  const locked = turn.locks.filter((l) => l.locked && l.coversNode).length;
  check(locked >= 2, `at least two units locked an aim on the same node (${locked})`);
  if (turn.preview) {
    const per = await page.evaluate(() => window.game.config.combat.stack.bonusPerOverlap);
    const parts = turn.preview.parts || [];
    // ORDERED overlap: the i-th damaging ability on the hex gets +i x per base.
    const ordered = parts.every((p, i) => p.bonus === i * per);
    const expectTotal = parts.reduce((a, p, i) => a + (p.dmg + i * per) * p.times, 0);
    const expectBonus = parts.reduce((a, p, i) => a + i * per * p.times, 0);
    check(turn.preview.n === locked && ordered && turn.preview.bonus === expectBonus && turn.preview.total === expectTotal, `ordered overlap: ${locked} abilities, the first +0, then +${per} per earlier hit -> ${turn.preview.total} (${parts.map((p) => `(${p.dmg}+${p.bonus})x${p.times}`).join('+')})`);
  }
  await page.screenshot({ path: path.join(OUT, 'hack-2-locked.png') });
  const fx = await page.evaluate(() => ({ labels: window.__localView.lockLabels.length, marks: window.__localView.lockFx.length, plaques: window.__localView.tokens.filter((t) => t.userData.plaque && t.userData.plaque.visible).length }));
  check(fx.marks > 0, `the arena draws lock marks (${fx.marks} marks)`);
  check(fx.labels === 0, 'no damage billboards over the covered tiles');
  check(fx.plaques > 0, `overhead unit cards are on (${fx.plaques})`);
  // A card whose unit the volley would kill reads "hp -> 0" and stays as solid
  // as any other (forced here for the screenshot; the real thing is read off
  // the engine's previewState).
  const deadCard = await page.evaluate(async () => {
    const v = window.__localView; const h = window.__hack;
    const u = h.state.units.find((x) => !x.isEnemy && x.hp > 0);
    const tok = v.battleTokens.get(u.uid); const pl = tok && tok.userData.plaque;
    if (!pl) return null;
    v.setPlaqueForecast(pl, { hp: 0, dead: true }, u);
    await new Promise((r) => setTimeout(r, 400));
    return { fcKey: pl.userData.fcKey, opacity: pl.material.opacity };
  });
  await page.screenshot({ path: path.join(OUT, 'hack-2b-dead-card.png') });
  await page.evaluate(() => { const v = window.__localView; v.applyPlaqueForecast(null); v.lockSig = null; });
  check(deadCard && deadCard.fcKey === '0:1' && deadCard.opacity === 1, `a card forecasting death reads "-> 0" and is not faded (${JSON.stringify(deadCard)})`);
  // A WALK by another unit must not take the standing locks' fx down: the lock
  // outlines stay in the scene throughout the walk.
  const walk = await page.evaluate(async () => {
    const v = window.__localView; const h = window.__hack; const sb = h.state;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const walker = sb.units.find((u) => !u.isEnemy && u.hp > 0 && !u.lock) || sb.units.find((u) => !u.isEnemy && u.hp > 0);
    h.activate(walker.uid); await wait(50);
    const reach = h.reachFor();
    const to = Object.keys(reach.d).filter((k) => !reach.occ.has(k) && !sb.tags[k] && k !== walker.pos).sort((a, b) => reach.d[b] - reach.d[a])[0];
    if (!to) return { skipped: 'nowhere to walk' };
    const marksBefore = v.lockFx.filter((o) => o.userData.tile).length;
    // A walk takes the walker's OWN lock back (if it had one); the others stay.
    const own = walker.lock ? walker.lock.tiles.length : 0;
    h.clickTile(to);
    let minMarks = Infinity, samples = 0, sawBusy = false;
    for (let g = 0; g < 60 && (sb.busy || g < 3); g++) {
      await wait(50);
      if (sb.busy) sawBusy = true;
      minMarks = Math.min(minMarks, v.lockFx.filter((o) => o.userData.tile).length); samples++;
    }
    // A long walk under headless software rendering can outlast the sampling.
    for (let g = 0; g < 200 && sb.busy; g++) await wait(100);
    return { from: walker.pos, to, marksBefore, own, minMarks, samples, sawBusy, done: !sb.busy, locks: h.lockedUnits().length };
  });
  console.log('  walk:', JSON.stringify(walk));
  if (!walk.skipped) check(walk.marksBefore > 0 && walk.minMarks >= walk.marksBefore - walk.own, `a walk leaves the other units' lock marks standing (${walk.minMarks} of ${walk.marksBefore} throughout, ${walk.own} of them the walker's own)`);

  // The panel: cards in firing order (placement only - no number badges since
  // 2026-09-26) and reorderable (held, then dragged); reordering through the
  // engine re-lists them.
  const panel = await page.evaluate(() => {
    const h = window.__hack;
    const before = [...document.querySelectorAll('#party-units .unit')].map((c) => ({ i: c.getAttribute('data-party'), badge: !!c.querySelector('.fire-order'), drag: c.getAttribute('data-reorder') }));
    const order = h.fireOrder();
    h.setFireOrder(order.slice().reverse());
    const after = [...document.querySelectorAll('#party-units .unit')].map((c) => ({ i: c.getAttribute('data-party') }));
    h.setFireOrder(order);   // back to how it was
    return { before, after, order };
  });
  console.log('  panel:', JSON.stringify(panel));
  const liveIdx = await page.evaluate(() => { const u = window.__hack.state.units; return window.__hack.fireOrder().map((uid) => String(u.find((x) => x.uid === uid).partyIndex)).join(''); });
  check(panel.before.every((c) => c.drag === '1' && !c.badge) && panel.before.map((c) => c.i).join('') === liveIdx, 'party cards stand in firing order, unnumbered, and can be reordered');
  check(panel.after.map((c) => c.i).join('') === panel.before.map((c) => c.i).join('').split('').reverse().join(''), 'reordering the firing order re-lists the cards');
  // Fire - and catch the volley mid-way: the locks go one at a time.
  const midway = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state;
    const n0 = h.lockedUnits().length;
    h.endTurn();
    await new Promise((r) => setTimeout(r, 120));
    const n1 = h.lockedUnits().length;
    return { n0, n1, busy: sb.busy };
  });
  console.log('  midway:', JSON.stringify(midway));
  check(midway.n0 >= 2 && midway.n1 > 0 && midway.n1 < midway.n0, `the volley is sequenced: ${midway.n0} locks, ${midway.n1} still waiting 120ms in`);
  const fired = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state;
    // (endTurn was pressed above; wait for the volley to land.)
    await new Promise((r) => setTimeout(r, 2600));
    return { r1: sb.round, lastTurn: sb.ext.hack.lastTurn, busy: sb.busy, over: sb.over, locks: h.lockedUnits().length, turnsText: document.querySelector('#hack-bar .hack-turns')?.textContent, round: document.getElementById('battle-round').textContent };
  });
  console.log('  fired:', JSON.stringify(fired));
  // A node takes ONE damage per attack, whatever the attack is worth: the two
  // locked abilities take 2 (or all it had).
  const expDmg = Math.min(turn.preview?.parts?.length ?? 0, turn.nodeHpBefore);
  check(turn.node && await page.evaluate(({ uid, exp, hp0 }) => { const u = window.__hack.state.objects.find((x) => x.uid === uid); return hp0 - u.hp === exp; }, { uid: turn.nodeUid, hp0: turn.nodeHpBefore, exp: expDmg }), `the node took one damage per attack (${expDmg} of ${turn.nodeHpBefore} hp, the arithmetic said ${turn.preview?.total})`);
  const stack = await page.evaluate(async (uid) => {
    const hv = window.__hackView;
    for (let g = 0; g < 60 && !hv.settled(uid); g++) await new Promise((r) => setTimeout(r, 100));   // the survivors settle (slow frames headless)
    const u = window.__hack.state.objects.find((x) => x.uid === uid);
    return { hp: u ? u.hp : 0, discs: hv.discCount(uid), settled: hv.settled(uid), iconAbove: hv.iconAboveStack(uid) };
  }, turn.nodeUid);
  check(stack.discs === stack.hp && stack.settled && (stack.hp === 0 || stack.iconAbove), `the hit node lost that many discs from the bottom and the rest settled on the tile, icon on top (${JSON.stringify(stack)})`);
  check(fired.r1 === 2 && !fired.busy && !fired.over, 'a new turn started');
  check(fired.locks === 0, 'locks are cleared after firing');
  check(/Turn 2 \/ 5/.test(fired.turnsText ?? ''), `the panel counts the turn (${fired.turnsText})`);
  await page.screenshot({ path: path.join(OUT, 'hack-3-fired.png') });

  // CLEARING a node counts: cut one to 1 hp, hit it with one ability, and the
  // cleared count goes up by one (badges only from H.badges[0] on).
  const over = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state; const H = h.hackConfig;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const PK = (k) => k.split(',').map(Number); const K = (q, r) => q + ',' + r;
    const rot = (o, k) => { let q = o[0], r = o[1]; for (let i = 0; i < k; i++) { const nq = -r, nr = q + r; q = nq; r = nr; } return [q, r]; };
    const aimRot = (a, b) => { if (a === b) return 0; const [q1, r1] = PK(a), [q2, r2] = PK(b); const dq = q2 - q1, dr = r2 - r1; const x = Math.sqrt(3) * (dq + dr / 2), y = 1.5 * dr; const ang = Math.atan2(y, x) * 180 / Math.PI; return ((Math.round(ang / 60) % 6) + 6) % 6; };
    const add = (k, o) => { const [q, r] = PK(k); return K(q + o[0], r + o[1]); };
    const nodeAt = (k) => sb.objects.find((v) => v.kind === 'hackNode' && v.hp > 0 && v.pos === k);
    const isPiece = (k) => sb.objects.some((v) => v.hp > 0 && v.pos === k);
    const nodes = sb.objects.filter((v) => v.kind === 'hackNode' && v.hp > 0).map((v) => v.pos);
    for (const u of sb.units.filter((v) => !v.isEnemy && v.hp > 0)) {
      h.activate(u.uid); await wait(30);
      const reach = h.reachFor();
      const stands = [u.pos, ...Object.keys(reach.d).filter((k) => !reach.occ.has(k) && !sb.tags[k])];
      for (const from of stands) for (const id of u.abilityIds) {
        const ab = h.abilityFor(u, id);
        if (!ab || ab.damage <= 2) continue;
        for (const off of ab.castZone) {
          const anchor = add(from, off);
          const rk = ab.rotatable ? aimRot(from, anchor) : 0;
          const tiles = ab.dmgZone.map((o) => add(anchor, rot(o, rk)));
          const node = tiles.find((t) => nodes.includes(t));
          if (!node) continue;
          if (tiles.filter(isPiece).length !== 1) continue;
          if (from !== u.pos) { h.clickTile(from); for (let g = 0; g < 60 && sb.busy; g++) await wait(100); }
          h.activate(u.uid); await wait(30);
          // "X damage Y times": make this one a 2x3 for the test.
          const saved = ab.damage;
          if (u.abilityDefs && u.abilityDefs[id]) u.abilityDefs[id].damage = '2x3';
          h.selectAbility(id); await wait(30);
          if (!sb.aimMap || sb.aimMap[anchor] === undefined) { h.cancel(); if (u.abilityDefs && u.abilityDefs[id]) u.abilityDefs[id].damage = saved; continue; }
          const nu = nodeAt(node);
          nu.hp = 1;
          const pv = h.previewTotals(anchor).get(node);
          // Hover the aim (as the mouse would): the disc the aim would take goes dark.
          let dark = null;
          if (window.__hackView) {
            const v = window.__localView; v.hoverKey = anchor; v.lockSig = null;
            for (let g = 0; g < 50 && window.__hackView.darkDiscs(nu.uid) === 0; g++) await wait(100);
            dark = window.__hackView.darkDiscs(nu.uid);
            v.hoverKey = null;
          }
          h.clickTile(anchor); await wait(60);
          const c0 = sb.ext.hack.cleared;
          h.endTurn(); await wait(2400);
          return { found: true, dmg: '2x3', c0, c1: sb.ext.hack.cleared, pvParts: pv?.parts?.map((p) => `${p.dmg}x${p.times}`), pvTotal: pv?.total, pvDealt: pv?.dealt, pvOver: pv?.over, dark, nodeGone: nu.hp <= 0, last: sb.ext.hack.lastTurn, badges: sb.ext.hack.badges, lit: document.querySelectorAll('#hack-bar .badge.lit').length };
        }
      }
    }
    return { found: false };
  });
  console.log('  clear:', JSON.stringify(over));
  if (over.found) {
    check(over.c1 === over.c0 + 1 && over.nodeGone, `a node brought down counts as cleared (${over.c0} -> ${over.c1})`);
    check(over.pvTotal === 6 && over.pvDealt === 1 && over.pvOver === 5 && (over.pvParts || []).join() === '2x3', `a 2x3 ability on a 1-hp node: the arithmetic says 6, the node loses 1 (${over.pvParts}, total ${over.pvTotal}, dealt ${over.pvDealt}, over ${over.pvOver})`);
    if (over.dark !== null) check(over.dark === 1, `the disc the aim would take is drawn dark while aiming (${over.dark})`);
    check(over.lit === over.badges, `badges lit match badges earned (${over.lit})`);
  } else console.log('  (no clean single-node aim available - skipped)');

  // A mine hit: lock an aim on a mine tile directly and fire.
  const mine = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const PK = (k) => k.split(',').map(Number);
    const K = (q, r) => q + ',' + r;
    const mineAt = (k) => sb.objects.find((v) => v.kind === 'hackMine' && v.hp > 0 && v.pos === k);
    const mines = sb.objects.filter((v) => v.kind === 'hackMine' && v.hp > 0).map((v) => v.pos);
    for (const u of sb.units.filter((v) => !v.isEnemy && v.hp > 0)) {
      h.activate(u.uid); await wait(30);
      const reach = h.reachFor();
      const stands = [u.pos, ...Object.keys(reach.d).filter((k) => !reach.occ.has(k) && !sb.tags[k])];
      for (const from of stands) {
        for (const id of u.abilityIds) {
          const ab = h.abilityFor(u, id);
          if (!ab || !(ab.damage > 0)) continue;
          if (ab.rotatable) continue;   // keep it simple: a single-tile, non-rotating aim
          for (const off of ab.castZone) {
            const [q, r] = PK(from); const anchor = K(q + off[0], r + off[1]);
            if (!mines.includes(anchor)) continue;
            if (from !== u.pos) { h.clickTile(from); await wait(1200); }
            h.selectAbility(id); await wait(30);
            if (!sb.aimMap || sb.aimMap[anchor] === undefined) { h.cancel(); continue; }
            const hp0 = u.hp;
            const mu = mineAt(anchor);
            // The forecast on the caster's own card shows the mine's cost.
            const ps = h.previewState(anchor);
            const fc = ps && ps.after[u.uid] ? ps.after[u.uid].hp : null;
            h.clickTile(anchor); await wait(60);
            const lock = sb.units.find((x) => x.uid === u.uid).lock;
            h.endTurn(); await wait(2400);
            return { found: true, hp0, fc, hp1: sb.units.find((x) => x.uid === u.uid).hp, mineGone: mu.hp <= 0, lock: !!lock, over: sb.over };
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
    check(mine.fc === mine.hp1, `the forecast on its card said so beforehand (${mine.hp0} -> ${mine.fc})`);
    check(mine.mineGone, 'the mine detonated (spent by the blow)');
  } else console.log('  (no reachable mine for a plain aim this layout - skipped)');

  // ----- 3c. a REGULAR battle uses the same volley --------------------------
  // Lose this hack quickly, then open a fight against a dummy and check that a
  // lock does not fire until End turn, and that the billboard reads the enemy.
  await page.evaluate(() => window.__hack.debugResolve(false));
  await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 15000 });
  await dismissDialog();
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => { const g = window.game; const hex = g.state.position; hex.encounter = 'battle'; hex.enemies = [{ name: 'Dummy', hp: 9, maxHp: 9, power: 0, alive: true }]; g.emit('change'); });
  await page.waitForTimeout(200);
  await page.keyboard.press('e');
  // Deployment: drop the party on the first free tiles.
  await page.waitForFunction(() => !!window.__battle || !!(window.__localView && window.__localView.deploy), null, { timeout: 30000 });
  await page.evaluate(() => {
    const v = window.__localView; if (!v.deploy) return;
    const taken = new Set(v.placement?.enemyKeys || []);
    const ek = (v.placement?.enemyKeys || [])[0];
    const PK = (k) => k.split(',').map(Number);
    const dist = (a, b) => { const [q1, r1] = PK(a), [q2, r2] = PK(b); return (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(q1 + r1 - q2 - r2)) / 2; };
    // Nearest free tiles to the enemy, so a melee lock can reach it.
    const tiles = [...v.map.hexes.values()].sort((a, b) => (ek ? dist(a.key, ek) - dist(b.key, ek) : 0));
    for (const tile of tiles) { if (!v.deploy) break; if (taken.has(tile.key)) continue; const before = v.deploy.index; v.placeDeployUnit(tile.key); if (!v.deploy || v.deploy.index > before) taken.add(tile.key); }
  });
  await page.waitForFunction(() => !!window.__battle && window.__cinematic.mode() === 'local' && window.__battle.state.phase === 'player', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const fight = await page.evaluate(async () => {
    const b = window.__battle; const sb = b.state;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const enemy = sb.units.find((u) => u.isEnemy);
    // Walk the first unit next to the enemy if it can, then lock a strike-like
    // ability on it. If nobody can reach, lock anywhere and just check the flow.
    const me = sb.units.find((u) => !u.isEnemy && u.hp > 0);
    b.activate(me.uid); await wait(30);
    const ab = me.abilityIds.map((id) => b.abilityFor(me, id)).find((a) => a && b.damageOf(a).base > 0);
    const id = me.abilityIds.find((i) => b.abilityFor(me, i) === ab);
    b.selectAbility(id); await wait(30);
    const keys = Object.keys(sb.aimMap || {});
    const atEnemy = keys.find((k) => k === enemy.pos);
    const target = atEnemy ?? keys[0];
    const pv = target ? b.previewTotals(target) : new Map();
    const enemyEntry = pv.get(enemy.pos) ?? null;
    b.clickTile(target); await wait(60);
    const afterLock = { hp: enemy.hp, locked: !!me.lock, phase: sb.phase, round: sb.round };
    // A CHARGE at the enemy (Gorm's headbutt shoves it and dashes after it):
    // the play-out must report the movement, and the arena draw ghosts for it.
    let ghosts = null;
    const gorm = sb.units.find((u) => !u.isEnemy && u.hp > 0 && u.abilityIds.includes('chargeHeadbutt'));
    if (gorm) {
      b.activate(gorm.uid); await wait(30);
      b.selectAbility('chargeHeadbutt'); await wait(30);
      const at = sb.aimMap && sb.aimMap[enemy.pos] !== undefined ? enemy.pos : null;
      if (at) {
        const moves = b.previewMoves(at);
        b.clickTile(at);
        // Locking keeps Gorm selected (since 2026-09-26): pick a unit that fires
        // AFTER him, so the cards show the board as that unit will find it.
        const ord = b.fireOrder();
        const later = sb.units.find((u) => !u.isEnemy && u.hp > 0 && ord.indexOf(u.uid) > ord.indexOf(gorm.uid));
        if (later) { b.selectUnit(later.uid); await wait(30); }
        // The arena rebuilds its lock fx on its next rendered frame - headless
        // software rendering can take a while per frame, so wait for it.
        const v = window.__localView;
        for (let g = 0; g < 80 && !(v.lockSig || '').includes(`${gorm.uid}:chargeHeadbutt`); g++) await wait(100);
        await wait(100);
        ghosts = { moves, fx: v.lockFx.length, sig: v.lockSig, bound: v.battle === b, busy: sb.busy, ghostMeshes: v.lockFx.filter((o) => o.isMesh && o.geometry === (v.battleTokens.get(gorm.uid) || {}).geometry).length };
        // THE FORECAST ON THE CARDS: the enemy's card reads hp -> after the
        // volley, and - with a unit later in the order than Gorm selected -
        // hangs over the tile the headbutt shoves the enemy to.
        const ps = b.previewState(null);
        const etok = v.battleTokens.get(enemy.uid);
        const pl = etok && etok.userData.plaque;
        const order = b.fireOrder();
        const cur = b.curPlayer();
        const enemyMove = moves.find((m) => m.kind === 'unit' && m.uid === enemy.uid) || null;
        let plaqueWorld = null;
        if (pl) { const p = new (pl.position.constructor)(); pl.getWorldPosition(p); plaqueWorld = { x: p.x, z: p.z }; }
        const hangTile = pl && pl.userData.hangAt ? v.map.hexes.get(pl.userData.hangAt) : null;
        ghosts.forecast = {
          state: ps && ps.after[enemy.uid], before: ps && ps.before[enemy.uid],
          card: pl ? { visible: pl.visible, forecast: pl.userData.forecast, hangAt: pl.userData.hangAt, fcKey: pl.userData.fcKey } : null,
          curAfterGorm: !!cur && order.indexOf(cur.uid) > order.indexOf(gorm.uid),
          enemyTo: enemyMove ? enemyMove.to : null, enemyHp: enemy.hp,
          hangs: !!hangTile && !!plaqueWorld && Math.abs(hangTile.x - plaqueWorld.x) < 0.05 && Math.abs(-hangTile.y - plaqueWorld.z) < 0.05,
        };
        // STACKING: Gorm's charge lands on the tile the enemy stands on right
        // now, so his ghost and his card ride a storey above the enemy's.
        const gtok = v.battleTokens.get(gorm.uid);
        const gpl = gtok && gtok.userData.plaque;
        const gmove = moves.find((m) => m.kind === 'unit' && m.uid === gorm.uid) || null;
        const gghost = gtok && v.lockFx.find((o) => o.isMesh && o.geometry === gtok.geometry) || null;
        const gtile = gmove ? v.map.hexes.get(gmove.to) : null;
        let gcard = null;
        if (gpl) { const p = new (gpl.position.constructor)(); gpl.getWorldPosition(p); gcard = { x: p.x, y: p.y, z: p.z }; }
        ghosts.stack = gmove && gtile ? {
          to: gmove.to, onEnemy: gmove.to === enemy.pos,
          ghostLift: gghost ? gghost.position.y - gtile.top : null,
          card: gpl ? { hangAt: gpl.userData.hangAt, hangLift: gpl.userData.hangLift, lift: gcard.y - gtile.top } : null,
        } : null;
      } else { b.cancel(); ghosts = { skipped: 'enemy not in charge range' }; }
    }
    return { keys: keys.length, atEnemy: !!atEnemy, enemyEntry: enemyEntry && { kind: enemyEntry.kind, hp: enemyEntry.target?.hp, total: enemyEntry.total, dealt: enemyEntry.dealt }, afterLock, ghosts };
  });
  await page.screenshot({ path: path.join(OUT, 'hack-3b-forecast.png') });
  const volley = await page.evaluate(async () => {
    const b = window.__battle; const sb = b.state;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const enemy = sb.units.find((u) => u.isEnemy);
    b.endTurn(); await wait(4500);
    const v2 = window.__localView;
    const cleared = [...v2.battleTokens.values()].every((t) => !t.userData.plaque || (!t.userData.plaque.userData.forecast && !t.userData.plaque.userData.hangAt));
    return { cleared, after: { hp: enemy.hp, round: sb.round, phase: sb.phase, over: sb.over } };
  });
  Object.assign(fight, volley);
  console.log('  fight:', JSON.stringify(fight));
  check(fight.afterLock.locked && fight.afterLock.hp === 9, 'in a regular battle a click locks the aim and nothing fires yet');
  if (fight.atEnemy) {
    check(fight.enemyEntry && fight.enemyEntry.kind === 'enemy' && fight.enemyEntry.hp === 9 && fight.enemyEntry.total > 0, `the pre-calculation reads the enemy (${JSON.stringify(fight.enemyEntry)})`);
    check(fight.after.hp < 9, `End turn fired the lock (enemy 9 -> ${fight.after.hp})`);
  } else console.log('  (enemy out of reach on this layout - only the lock flow was checked)');
  if (fight.ghosts && !fight.ghosts.skipped) {
    const mv = fight.ghosts.moves || [];
    check(mv.length > 0 && mv.some((m) => m.kind === 'unit'), `the play-out reports what a charge moves (${mv.map((m) => `${m.name ?? m.kind}:${m.from}->${m.to}${m.dead ? ' dead' : ''}`).join(', ')})`);
    check(fight.ghosts.ghostMeshes > 0, `the arena drew a ghost for the charging unit (${fight.ghosts.ghostMeshes})`);
    const f = fight.ghosts.forecast || {};
    console.log('  forecast:', JSON.stringify(f));
    check(f.state && f.state.hp < f.enemyHp && f.card && f.card.visible && f.card.forecast && f.card.forecast.hp === f.state.hp && f.card.forecast.dead === f.state.dead, `the enemy's card forecasts the volley (${f.enemyHp} -> ${f.state && f.state.hp}${f.state && f.state.dead ? ', dead' : ''})`);
    if (f.curAfterGorm && f.enemyTo) check(f.before && f.before.pos === f.enemyTo && f.card.hangAt === f.enemyTo && f.hangs, `with a later unit selected the enemy's card hangs where the headbutt leaves it (${f.enemyTo})`);
    else console.log('  (card placement after a shove not checked: ' + (f.enemyTo ? 'the selected unit fires before Gorm' : 'the headbutt moved nothing') + ')');
    const st = fight.ghosts.stack;
    if (st && st.onEnemy) check(st.ghostLift > 1 && st.card && st.card.hangLift && st.card.lift > 2, `Gorm's ghost and card ride a storey above the enemy he charges onto (ghost +${st.ghostLift && st.ghostLift.toFixed(2)}, card +${st.card && st.card.lift.toFixed(2)})`);
    else console.log('  (stacking not checked: ' + JSON.stringify(st) + ')');
  } else console.log('  (charge preview skipped: ' + (fight.ghosts?.skipped ?? 'no charger') + ')');
  check(fight.cleared, 'after the volley every card is back over its unit with no forecast on it');
  await page.screenshot({ path: path.join(OUT, 'hack-3c-battle.png') });
  await page.evaluate(() => window.__battle && window.__battle.debugResolve(true));
  await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 15000 });
  // Click through whatever windows the win opens (report, chooser, anything new).
  for (let i = 0; i < 8 && await dialogOpen(); i++) {
    await page.evaluate(() => { const c = document.querySelector('#dialog .upg-card') || document.querySelector('#dialog-actions button'); if (c) c.click(); });
    await page.waitForTimeout(350);
    await page.evaluate(() => { const c = document.getElementById('confirm'); if (c && !c.classList.contains('hidden')) document.getElementById('btn-confirm-yes')?.click(); });
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 30000 });
  await page.waitForTimeout(600);
  await startEnter();

  // ----- 4. the graded reward: ONE badge -> one option -----------------------
  // Fake a run that cleared exactly H.badges[0] nodes, then let the last
  // volley end the encounter.
  const oneBadge = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state; const H = h.hackConfig;
    const x = sb.ext.hack;
    x.cleared = H.badges[0]; x.badges = 1; x.firedRound = H.turns - 1; sb.round = H.turns;
    sb.units.forEach((u) => { u.lock = null; });
    await new Promise((r) => setTimeout(r, 50));
    h.endTurn();
    await new Promise((r) => setTimeout(r, 1500));
    return { over: sb.over, badges: x.badges };
  });
  check(oneBadge.over === 'win' && oneBadge.badges === 1, `the last volley ends the hack as a win with one badge (${JSON.stringify(oneBadge)})`);
  await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 15000 });
  const winTitle = await dialogTitle();
  const winHtml = await page.evaluate(() => document.getElementById('dialog').textContent);
  check(/Hack complete/i.test(winHtml) && /1 badge/.test(winHtml), `victory window opened (${winTitle.trim().slice(0, 40)})`);
  const hackGoneAfterWin = await page.evaluate(() => !window.__hack && !document.getElementById('hack-bar'));
  check(hackGoneAfterWin, 'the hack engine and panel are torn down on the win');
  await page.screenshot({ path: path.join(OUT, 'hack-4-won.png') });
  await dismissDialog();
  await page.waitForTimeout(300);
  const chooser = await page.evaluate(() => ({ open: !document.getElementById('dialog').classList.contains('hidden'), cards: document.querySelectorAll('#dialog .upg-card').length, buttons: [...document.querySelectorAll('#dialog-actions button')].map((b) => b.textContent.trim().slice(0, 30)) }));
  console.log('  chooser:', JSON.stringify(chooser));
  check(chooser.open && chooser.cards === 1, `the chooser offers exactly one upgrade card: ${chooser.cards}`);
  await page.screenshot({ path: path.join(OUT, 'hack-4b-choice.png') });
  for (let i = 0; i < 8 && await dialogOpen(); i++) {
    await page.evaluate(() => { const c = document.querySelector('#dialog .upg-card') || document.querySelector('#dialog-actions button'); if (c) c.click(); });
    await page.waitForTimeout(350);
    await page.evaluate(() => { const c = document.getElementById('confirm'); if (c && !c.classList.contains('hidden')) document.getElementById('btn-confirm-yes')?.click(); });
    await page.waitForTimeout(150);
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
  check(/Hack failed/i.test(loseHtml) && /not enough/i.test(loseHtml), 'failure window opened (no badge, no reward)');
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
