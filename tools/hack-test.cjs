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
      units: sb.units.length, nodes: Object.values(sb.tags).filter((t) => t.defId === 'node').length,
      mines: Object.values(sb.tags).filter((t) => t.defId === 'mine').length,
      flat: new Set(Object.values(sb.heights)).size === 1,
      bar: !!document.getElementById('hack-bar'), battleBar: !document.getElementById('battle-bar').classList.contains('hidden'),
      round: document.getElementById('battle-round').textContent, active: sb.activeUid, abilities: document.querySelectorAll('#battle-abilities button').length,
      cleared: sb.ext.hack.cleared, total: sb.ext.hack.total, badges: document.querySelectorAll('#hack-bar .badge').length, lit: document.querySelectorAll('#hack-bar .badge.lit').length, turns: h.hackConfig.turns, lockedAim: sb.lockedAim,
    };
  });
  check(s0.units === 3, `three party units on the board (${s0.units})`);
  check(s0.nodes > 0 && s0.mines > 0, `nodes and mines placed (${s0.nodes} / ${s0.mines})`);
  check(s0.flat, 'the board is flat');
  check(s0.bar && s0.battleBar, 'hack panel and battle bar are shown');
  check(s0.badges === 3 && s0.lit === 0 && s0.cleared === 0 && s0.total === s0.nodes, `three unlit badges, ${s0.total} nodes to clear`);
  check(s0.turns === 5, `five turns (${s0.turns})`);
  check(/Turn 1 \/ \d+/.test(s0.round), `battle bar reads the turn (${s0.round})`);
  check(!!s0.active && s0.abilities >= 2, `a unit is selected with its ability buttons (${s0.abilities})`);
  check(s0.lockedAim, 'aim locks are on (config.combat.lockedAim)');
  const layoutInfo = await page.evaluate(() => ({ layout: window.__hack.layout, desc: document.getElementById('li-desc').textContent }));
  check(!!layoutInfo.layout?.id && layoutInfo.desc.includes(layoutInfo.layout.name), `a layout was drawn and named (${layoutInfo.layout?.id})`);
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
    const nodes = Object.keys(sb.tags).filter((k) => sb.tags[k].defId === 'node');
    const lockable = (u, id) => { const ab = h.abilityFor(u, id); return !!ab && ab.damage > 0; };
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
    const mults = await page.evaluate(() => window.game.config.combat.stack.multipliers);
    check(turn.preview.n === locked && turn.preview.mult === mults[Math.min(locked, mults.length) - 1], `preview stacks ${turn.preview.n} abilities at x${turn.preview.mult} = ${turn.preview.total}`);
    check(turn.preview.parts && turn.preview.parts.length === locked && turn.preview.raw === turn.preview.parts.reduce((a, p) => a + p.dmg, 0), `preview lists each ability's damage (${(turn.preview.parts || []).map((p) => p.dmg).join('+')})`);
  }
  await page.screenshot({ path: path.join(OUT, 'hack-2-locked.png') });
  const fx = await page.evaluate(() => ({ labels: window.__localView.lockLabels.length, marks: window.__localView.lockFx.length, plaques: window.__localView.tokens.filter((t) => t.userData.plaque && t.userData.plaque.visible).length }));
  check(fx.labels > 0 && fx.marks > 0, `the arena draws lock marks and billboards (${fx.marks} marks, ${fx.labels} billboards)`);
  check(fx.plaques === 0, 'overhead unit cards are off');

  // Fire.
  const fired = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state;
    const node = Object.keys(sb.tags).find((k) => sb.tags[k].defId === 'node' && h.previewTotals(null).has(k));
    const hp0 = node ? sb.tags[node].hp : null;
    const pv = node ? h.previewTotals(null).get(node) : null;
    const r0 = sb.round;
    h.endTurn();
    await new Promise((r) => setTimeout(r, 2400));
    return { node, hp0, expected: pv ? pv.dealt : null, hp1: node ? (sb.tags[node] ? sb.tags[node].hp : 0) : null, r0, r1: sb.round, lastTurn: sb.ext.hack.lastTurn, busy: sb.busy, over: sb.over, locks: h.lockedUnits().length, turnsText: document.querySelector('#hack-bar .hack-turns')?.textContent, round: document.getElementById('battle-round').textContent };
  });
  console.log('  fired:', JSON.stringify(fired));
  check(fired.node && fired.hp0 - fired.hp1 === fired.expected, `the node took what the billboard promised (${fired.hp0} -> ${fired.hp1}, promised ${fired.expected})`);
  check(fired.r1 === fired.r0 + 1 && !fired.busy && !fired.over, 'a new turn started');
  check(fired.locks === 0, 'locks are cleared after firing');
  check(/Turn 2 \/ 5/.test(fired.turnsText ?? ''), `the panel counts the turn (${fired.turnsText})`);
  await page.screenshot({ path: path.join(OUT, 'hack-3-fired.png') });

  // CLEARING a node counts: cut one to 2 hp, hit it with one ability, and the
  // cleared count goes up by one (badges only from H.badges[0] on).
  const over = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state; const H = h.hackConfig;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const PK = (k) => k.split(',').map(Number); const K = (q, r) => q + ',' + r;
    const rot = (o, k) => { let q = o[0], r = o[1]; for (let i = 0; i < k; i++) { const nq = -r, nr = q + r; q = nq; r = nr; } return [q, r]; };
    const aimRot = (a, b) => { if (a === b) return 0; const [q1, r1] = PK(a), [q2, r2] = PK(b); const dq = q2 - q1, dr = r2 - r1; const x = Math.sqrt(3) * (dq + dr / 2), y = 1.5 * dr; const ang = Math.atan2(y, x) * 180 / Math.PI; return ((Math.round(ang / 60) % 6) + 6) % 6; };
    const add = (k, o) => { const [q, r] = PK(k); return K(q + o[0], r + o[1]); };
    const nodes = Object.keys(sb.tags).filter((k) => sb.tags[k].defId === 'node');
    for (const u of sb.units) {
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
          if (tiles.filter((t) => sb.tags[t]).length !== 1) continue;
          if (from !== u.pos) { h.clickTile(from); await wait(1200); }
          h.selectAbility(id); await wait(30);
          if (!sb.aimMap || sb.aimMap[anchor] === undefined) { h.cancel(); continue; }
          sb.tags[node].hp = 2;
          const pv = h.previewTotals(anchor).get(node);
          h.clickTile(anchor); await wait(60);
          const c0 = sb.ext.hack.cleared;
          h.endTurn(); await wait(2400);
          return { found: true, dmg: ab.damage, c0, c1: sb.ext.hack.cleared, pvDealt: pv?.dealt, pvOver: pv?.over, nodeGone: !sb.tags[node], last: sb.ext.hack.lastTurn, badges: sb.ext.hack.badges, lit: document.querySelectorAll('#hack-bar .badge.lit').length };
        }
      }
    }
    return { found: false };
  });
  console.log('  clear:', JSON.stringify(over));
  if (over.found) {
    check(over.c1 === over.c0 + 1 && over.nodeGone, `a node brought down counts as cleared (${over.c0} -> ${over.c1})`);
    check(over.pvDealt === 2 && over.pvOver === over.dmg - 2, `preview split the hit into dealt ${over.pvDealt} + over ${over.pvOver}`);
    check(over.lit === over.badges, `badges lit match badges earned (${over.lit})`);
  } else console.log('  (no clean single-node aim available - skipped)');

  // A mine hit: lock an aim on a mine tile directly and fire.
  const mine = await page.evaluate(async () => {
    const h = window.__hack; const sb = h.state;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const PK = (k) => k.split(',').map(Number);
    const K = (q, r) => q + ',' + r;
    const mines = Object.keys(sb.tags).filter((k) => sb.tags[k].defId === 'mine');
    for (const u of sb.units) {
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
            h.clickTile(anchor); await wait(60);
            const lock = sb.units.find((x) => x.uid === u.uid).lock;
            h.endTurn(); await wait(2400);
            return { found: true, hp0, hp1: sb.units.find((x) => x.uid === u.uid).hp, mineGone: !sb.tags[anchor], lock: !!lock, over: sb.over };
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
    check(mine.mineGone === !!H.mineDetonates, 'the mine detonated');
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
    const ab = me.abilityIds.map((id) => b.abilityFor(me, id)).find((a) => a && a.damage > 0);
    const id = me.abilityIds.find((i) => b.abilityFor(me, i) === ab);
    b.selectAbility(id); await wait(30);
    const keys = Object.keys(sb.aimMap || {});
    const atEnemy = keys.find((k) => k === enemy.pos);
    const target = atEnemy ?? keys[0];
    const pv = target ? b.previewTotals(target) : new Map();
    const enemyEntry = pv.get(enemy.pos) ?? null;
    b.clickTile(target); await wait(60);
    const afterLock = { hp: enemy.hp, locked: !!me.lock, phase: sb.phase, round: sb.round };
    b.endTurn(); await wait(3000);
    return { keys: keys.length, atEnemy: !!atEnemy, enemyEntry: enemyEntry && { kind: enemyEntry.kind, hp: enemyEntry.target?.hp, total: enemyEntry.total, dealt: enemyEntry.dealt }, afterLock, after: { hp: enemy.hp, round: sb.round, phase: sb.phase, over: sb.over } };
  });
  console.log('  fight:', JSON.stringify(fight));
  check(fight.afterLock.locked && fight.afterLock.hp === 9, 'in a regular battle a click locks the aim and nothing fires yet');
  if (fight.atEnemy) {
    check(fight.enemyEntry && fight.enemyEntry.kind === 'enemy' && fight.enemyEntry.hp === 9 && fight.enemyEntry.total > 0, `the billboard reads the enemy (${JSON.stringify(fight.enemyEntry)})`);
    check(fight.after.hp < 9, `End turn fired the lock (enemy 9 -> ${fight.after.hp})`);
  } else console.log('  (enemy out of reach on this layout - only the lock flow was checked)');
  await page.screenshot({ path: path.join(OUT, 'hack-3c-battle.png') });
  await page.evaluate(() => window.__battle && window.__battle.debugResolve(true));
  await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 15000 });
  await dismissDialog(); await page.waitForTimeout(300);
  if (await dialogOpen()) { await page.evaluate(() => { const c = document.querySelector('#dialog-actions button'); if (c) c.click(); }); await page.waitForTimeout(300); if (await dialogOpen()) await dismissDialog(); }
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
  const chooser = await page.evaluate(() => ({ open: !document.getElementById('dialog').classList.contains('hidden'), buttons: [...document.querySelectorAll('#dialog-actions button')].map((b) => b.textContent.trim().slice(0, 30)) }));
  console.log('  chooser:', JSON.stringify(chooser));
  check(chooser.open && chooser.buttons.length === 2, `the chooser offers exactly one upgrade (plus skip): ${chooser.buttons.length} buttons`);
  await page.screenshot({ path: path.join(OUT, 'hack-4b-choice.png') });
  if (chooser.open) {
    await page.evaluate(() => { const c = document.querySelector('#dialog-actions button'); if (c) c.click(); });
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
