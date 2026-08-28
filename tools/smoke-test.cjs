// Automated smoke test: opens the built game in a headless Chromium, checks the console
// for errors, exercises the dialogs, the Stasis rules, a short walk and the NPE,
// and saves screenshots into tools/shots/.
//
// One-time setup (optional, only if you want to run this yourself):
//   npm install --save-dev playwright
//   npx playwright install chromium
// Then:
//   npm run build
//   npx vite preview --port 4173        (in one terminal)
//   node tools/smoke-test.cjs           (in another)
//
// Environment variables: URL (default http://localhost:4173/?seed=777), OUT (screenshot folder).
const path = require('node:path');
const fs = require('node:fs');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm install --save-dev playwright && npx playwright install chromium');
  process.exit(1);
}

// nostart=1 skips the start screen (splash + campfire): these sections test the world flow.
const URL = process.env.URL || 'http://localhost:4173/?seed=777&nostart=1';
const OUT = process.env.OUT || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    // CHROMIUM lets CI / sandboxes point at a preinstalled browser instead of
    // downloading one with "npx playwright install".
    executablePath: process.env.CHROMIUM || undefined,
    // Software WebGL so the test also works on machines / servers without a GPU.
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push('PAGE ERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    // Sandboxed test machines cannot reach Google Fonts; that failure is expected noise.
    if (m.text().includes('ERR_TUNNEL_CONNECTION_FAILED')) return;
    problems.push(m.type() + ': ' + m.text());
  });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);

  const screenPos = (q, r) => page.evaluate(([q, r]) => {
    const R = window.__renderer; const g = window.game;
    const hex = g.hexAt(q, r); const rec = R.tiles.get(hex.key);
    const V = R.camera.position.constructor;
    const v = new V(hex.x, rec.height + 0.05, -hex.y); v.project(R.camera);
    const rect = R.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
  }, [q, r]);
  // Windows have no close button: press their last option, and confirm if asked.
  const dismissDialog = async () => {
    await page.evaluate(() => { const b = document.querySelectorAll('#dialog-actions button'); if (b.length) b[b.length - 1].click(); });
    await page.waitForTimeout(80);
    await page.evaluate(() => { const c = document.getElementById('confirm'); if (!c.classList.contains('hidden')) document.getElementById('btn-confirm-yes').click(); });
    await page.waitForTimeout(80);
  };
  const waitIdle = async () => {
    await page.waitForFunction(() => !window.__renderer.busy, null, { timeout: 20000 });
    await page.waitForTimeout(900); // let the camera glide settle
  };

  const start = await page.evaluate(() => ({ seed: window.game.seed, supplies: window.game.state.supplies, path: window.game.state.shortestPathLength }));
  console.log('start:', JSON.stringify(start));
  await page.screenshot({ path: path.join(OUT, '01-start.png') });

  // Make camp on the start tile (empty): spends supplies, should not throw.
  await page.click('#btn-enter');
  await page.waitForTimeout(200);
  const afterCamp = await page.evaluate(() => window.game.state.supplies);
  if (afterCamp !== start.supplies - 20) problems.push(`make camp did not spend 20 supplies (${start.supplies} -> ${afterCamp})`);
  // Simulated shop + unit chooser + acolyte flows, straight through the rules layer.
  const rulesOk = await page.evaluate(() => {
    const g = window.game; const u = g.state.party[1];
    u.alive = false; u.hp = 0; g.emit('change');
    const hadDead = g.deadUnits().length === 1;
    return hadDead;
  });
  if (!rulesOk) problems.push('could not mark a unit dead for the chooser test');
  await page.evaluate(() => { window.game.emit('dialog', { kind: 'acolyte' }); });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '01b-choose-unit.png') });
  await dismissDialog();
  await page.evaluate(() => { const u = window.game.state.party[1]; u.alive = true; u.hp = u.maxHp; window.game.emit('change'); });

  // Event dialogs: a reveal event and the black market chooser.
  await page.evaluate(() => { window.game.applyEvent({ id: 'vantage', title: 'Vantage point', effect: 'vantage', text: 'Test vantage text.' }, false); });
  await page.waitForTimeout(300);
  const evShown = await page.evaluate(() => document.getElementById('dialog-body').textContent.includes('revealed'));
  if (!evShown) problems.push('event dialog did not show an effect line');
  await page.screenshot({ path: path.join(OUT, '01c-event.png') });
  await dismissDialog();
  await page.evaluate(() => { window.game.applyEvent({ id: 'bm', title: 'Black market', effect: 'blackMarket', text: 'Test black market text.' }, false); });
  await page.waitForTimeout(200);
  const bmButtons = await page.evaluate(() => document.querySelectorAll('#dialog-actions button').length);
  if (bmButtons !== 4) problems.push(`black market dialog should have 3 units + Decline, got ${bmButtons}`);
  // Decline asks for confirmation.
  await page.evaluate(() => { const b = document.querySelectorAll('#dialog-actions button'); b[b.length - 1].click(); });
  await page.waitForTimeout(100);
  const confirmShown = await page.evaluate(() => !document.getElementById('confirm').classList.contains('hidden'));
  if (!confirmShown) problems.push('declining the black market did not ask for confirmation');
  await page.evaluate(() => document.getElementById('btn-confirm-yes').click());
  await page.waitForTimeout(100);
  // No close button on windows; clicking the world flashes the open one.
  const hasClose = await page.evaluate(() => !!document.getElementById('dialog-close'));
  if (hasClose) problems.push('dialog still has a close button');
  // Supplies cap.
  const capOk = await page.evaluate(() => { const g = window.game; g.addSupplies(999); return g.state.supplies === g.state.maxSupplies; });
  if (!capOk) problems.push('supplies exceeded the maximum');

  // A won battle offers the +power chooser and a placeholder-free transcript
  // (regression checks: the reward is decided before the dialog is built, and the
  // transcript lines are structured, not preformatted text).
  await page.evaluate(() => { const g = window.game; const hex = g.state.position; hex.encounter = 'battle'; hex.enemies = [{ name: 'Dummy', hp: 1, maxHp: 1, power: 0, alive: true }]; g.enter(false); });
  await page.waitForTimeout(250);
  const rewardBtn = await page.evaluate(() => [...document.querySelectorAll('#dialog-actions button')].map((b) => b.textContent).join('|'));
  // The reward text is built from config (battle.victoryPower), so read it rather than
  // hardcoding a number that a balance pass will change.
  const victoryPower = await page.evaluate(() => window.game.config.battle.victoryPower);
  if (!rewardBtn.includes(`+${victoryPower} power`)) problems.push('battle report lacks the reward button: ' + rewardBtn);
  const transcript = await page.evaluate(() => document.getElementById('dialog-body').textContent);
  if (/\{(attacker|defender|dmg)\}/.test(transcript)) problems.push('battle transcript shows raw placeholders');
  await page.evaluate(() => { document.querySelector('#dialog-actions button').click(); });
  await page.waitForTimeout(150);
  const chooser = await page.evaluate(() => document.getElementById('dialog-title').textContent);
  if (!/Lessons/.test(chooser)) problems.push('power-up chooser did not open after the battle: ' + chooser);
  await page.screenshot({ path: path.join(OUT, '01e-reward-chooser.png') });
  await dismissDialog();

  // The combat cinematic: Enter on a battle dives into the local map (clouds,
  // scene swap), the results window opens over the arena, closing it flies back.
  await page.evaluate(() => {
    const g = window.game; const hex = g.state.position;
    hex.encounter = 'battle';
    hex.enemies = [{ name: 'Raider', hp: 14, maxHp: 14, power: 3, alive: true }, { name: 'Husk', hp: 12, maxHp: 12, power: 3, alive: true }];
    g.emit('change');
  });
  await page.waitForTimeout(200);
  await page.click('#btn-enter');
  await page.waitForTimeout(700);
  const midFlight = await page.evaluate(() => ({
    mode: window.__cinematic.mode(),
    clouds: !document.getElementById('cloud-fx').classList.contains('hidden'),
    dialog: !document.getElementById('dialog').classList.contains('hidden'),
  }));
  if (midFlight.mode !== 'in' || !midFlight.clouds || midFlight.dialog) problems.push('fly-in state wrong at 700ms: ' + JSON.stringify(midFlight));
  await page.screenshot({ path: path.join(OUT, '20-dive-mid.png') });
  await page.waitForTimeout(1400);
  const landed = await page.evaluate(() => ({
    mode: window.__cinematic.mode(),
    dialog: !document.getElementById('dialog').classList.contains('hidden'),
    tiles: window.__localView.map ? window.__localView.map.hexes.size : 0,
    tokens: window.__localView.tokens.length,
    orientation: window.__localView.map ? window.__localView.map.orientation : '?',
    pan: window.__localView.controls ? window.__localView.controls.enablePan : null,
    zoom: window.__localView.controls ? window.__localView.controls.enableZoom : null,
  }));
  if (landed.mode !== 'local' || !landed.dialog) problems.push('did not land in the local map with the results open: ' + JSON.stringify(landed));
  if (landed.tiles !== 127) problems.push(`local map should have 127 tiles (radius 6), got ${landed.tiles}`);
  if (landed.tokens !== 5) problems.push(`expected 3 party + 2 enemy tokens, got ${landed.tokens}`);
  if (landed.orientation === (await page.evaluate(() => window.game.config.map.orientation))) problems.push('local map orientation should be opposite to the world map');
  if (landed.pan !== false || landed.zoom !== false) problems.push('local camera must not pan or zoom: ' + JSON.stringify(landed));
  await page.screenshot({ path: path.join(OUT, '21-local-map.png') });
  await dismissDialog();
  await dismissDialog();
  await page.waitForTimeout(1800);
  const backOut = await page.evaluate(() => ({ mode: window.__cinematic.mode(), filter: window.__renderer.renderer.domElement.style.filter }));
  if (backOut.mode !== 'idle' || backOut.filter) problems.push('did not return cleanly to the world map: ' + JSON.stringify(backOut));

  // The Stasis, straight through the rules layer: placement, line growth, colony
  // spawn, withering and debuffs.
  const stasisProblems = await page.evaluate(() => {
    const g = window.game; const st = g.stasis; const cfg = g.config.stasis;
    const out = [];
    const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
    if (!g.map.seed || g.map.seed.encounter !== 'stasisSeed') out.push('no Stasis Seed on the map');
    if (st.colonies.length !== cfg.colonyCount) out.push(`expected ${cfg.colonyCount} colonies, got ${st.colonies.length}`);
    for (const c of st.colonies) {
      if (dist(c.hex, g.map.seed) < cfg.minSpacing) out.push('colony too close to the seed');
      for (const o of st.colonies) if (o !== c && dist(c.hex, o.hex) < cfg.minSpacing) out.push('colonies too close to each other');
      if (c.hex.encounter) out.push('colony encounter present before its line arrived');
    }
    // March time forward: the nearest colony must spawn after distance / lineSpeed turns.
    const first = [...st.colonies].sort((a, b) => a.distance - b.distance)[0];
    const need = Math.ceil(first.distance / cfg.lineSpeed);
    for (let i = 0; i < need; i++) g.advanceStasis();
    if (!first.active || first.hex.encounter !== 'stasisColony') out.push(`colony did not spawn after ${need} turns`);
    if (!first.hex.enemies || !first.hex.enemies.length) out.push('spawned colony has no enemies');
    const withered = [...g.map.hexes.values()].filter((h) => h.biome === 'wither');
    if (!withered.length) out.push(`no withered tiles after ${need} turns`);
    const cfgW = g.config.biomes.wither;
    if (withered.some((h) => h.type === 'ether')) out.push('the wither spread into the ether');
    if (withered.some((h) => h.type === 'water')) out.push('withered water did not dry into ground');
    if (withered.some((h) => h.hpCost !== (g.config.tileTypes[h.type].hpCost ?? 0) + cfgW.hpCost)) out.push('withered tiles did not take the biome hpCost');
    // Ether tiles must be holes: present in the game data, absent from the renderer.
    const ether = [...g.map.hexes.values()].filter((h) => h.type === 'ether');
    if (ether.some((h) => window.__renderer.tiles.has(h.key))) out.push('ether tiles have meshes - they should be holes');
    // Active colonies push their debuff onto the seed fight.
    const debuffs = g.activeDebuffsFor(g.map.seed);
    const active = st.colonies.filter((c) => c.active && !c.cleared).length;
    if (debuffs.length !== active) out.push(`seed debuffs (${debuffs.length}) != active colonies (${active})`);
    if (first.debuff && g.activeDebuffsFor(first.hex)[0] !== first.debuff) out.push('colony does not report its own debuff');
    return out;
  });
  problems.push(...stasisProblems);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '01d-stasis-sim.png') });
  // Fresh page so the timeline tests below start from turn 0 again.
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);

  // The camera only glides after the party when camera.followPlayer is on. With it off
  // the party walks out of view and projected tile positions stop being usable, so the
  // test recentres by hand between steps.
  const recenter = async () => {
    const moved = await page.evaluate(() => {
      const r = window.__renderer, g = window.game;
      if (!r || !g || r.config.camera.followPlayer) return false;
      const rec = r.tiles.get(g.state.position.key);
      if (!rec) return false;
      r.followTo(rec.mesh.position);
      return true;
    });
    if (moved) await page.waitForTimeout(800);
  };

  // Walk a couple of steps so fatigue rises, then check the hover popup.
  for (let i = 0; i < 6; i++) {
    await waitIdle();
    const n = await page.evaluate(() => { const r = window.game.reachable(); const h = r[0]; return h ? [h.q, h.r] : null; });
    if (!n) break;
    const p = await screenPos(n[0], n[1]);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(60);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(150);
    await dismissDialog();
    await recenter();
  }
  await waitIdle();
  await recenter();
  const probe = await page.evaluate(() => { const g = window.game; const n = g.reachable()[0]; return n ? [n.q, n.r, g.fatigueAfterNextStep()] : null; });
  if (probe && probe[2] > 0) {
    const p = await screenPos(probe[0], probe[1]);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(250);
    const tip = await page.evaluate(() => { const t = document.getElementById('fatigue-tip'); return t.classList.contains('hidden') ? null : t.textContent; });
    // (The single HUD fatigue number is gone - the fatigue bar replaced it - so the
    // popup is checked on its own.)
    if (!tip) problems.push('fatigue popup did not appear on hover');
    const nextOk = await page.evaluate(() => { const t = document.getElementById('fatigue-tip').textContent; return t.includes(`after this step: ${window.game.fatigueAfterNextStep()}%`); });
    if (!nextOk) problems.push('popup does not show the next-step fatigue value');
    await page.screenshot({ path: path.join(OUT, '02b-fatigue-tip.png') });
  }
  // Forced encounter: banner first, dialog later.
  await page.evaluate(() => { const g = window.game; g.emit('forced', { label: 'Battle', chance: 50 }); g.emit('dialog', { kind: 'event', title: 'Forced test', text: 't', effect: 'e' }); });
  await page.waitForTimeout(150);
  const bannerEarly = await page.evaluate(() => ({ banner: !document.getElementById('banner').classList.contains('hidden'), dialog: !document.getElementById('dialog').classList.contains('hidden') }));
  if (!bannerEarly.banner || bannerEarly.dialog) problems.push('forced banner/dialog timing wrong at 150ms: ' + JSON.stringify(bannerEarly));
  await page.waitForTimeout(700);
  const dialogLate = await page.evaluate(() => !document.getElementById('dialog').classList.contains('hidden'));
  if (!dialogLate) problems.push('dialog did not open after the forced banner');
  await page.screenshot({ path: path.join(OUT, '02d-forced-banner.png') });
  await dismissDialog();
  // Supplies overflow dialog with the camp-first option. The walk above may have
  // ended on an encounter tile (camping there is impossible), so clear it first.
  await page.evaluate(() => { const g = window.game; g.state.position.encounter = null; g.state.supplies = g.state.maxSupplies - 5; g.offerSupplies(20, 'Test find', 'Test text.'); });
  await page.waitForTimeout(200);
  const supButtons = await page.evaluate(() => [...document.querySelectorAll('#dialog-actions button')].map((b) => b.textContent));
  if (!supButtons.some((t) => t.includes('Make camp first'))) problems.push('overflow dialog lacks the make-camp-first button: ' + JSON.stringify(supButtons));
  await page.screenshot({ path: path.join(OUT, '02c-supplies-overflow.png') });
  await page.evaluate(() => document.querySelectorAll('#dialog-actions button')[0].click());
  await page.waitForTimeout(200);
  const end = { status: 'n/a', overlay: false };
  console.log('end:', JSON.stringify(await page.evaluate(() => ({ turn: window.game.state.turn, fatigue: window.game.state.fatigue, supplies: window.game.state.supplies }))));
  await page.screenshot({ path: path.join(OUT, '03-end.png') });
  void end;

  // New player experience: HUD hidden, first card visible, party revealed after step 2.
  await page.goto(URL.replace(/\?.*$/, '') + '?npe=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);
  const npe0 = await page.evaluate(() => ({
    card: !document.getElementById('tutorial').classList.contains('hidden'),
    party: document.getElementById('party').classList.contains('npe-hidden'),
    stats: document.getElementById('statusbar').classList.contains('npe-hidden'),
    menuVisible: !document.getElementById('menu-wrap').classList.contains('npe-hidden'),
    blocker: !document.getElementById('input-block').classList.contains('hidden'),
  }));
  if (!npe0.card || !npe0.party || !npe0.stats || !npe0.menuVisible || !npe0.blocker) problems.push('NPE start state wrong: ' + JSON.stringify(npe0));
  await page.waitForTimeout(300);
  const lineToTile = await page.evaluate(() => { const l = document.querySelector('#tutorial-lines line'); if (!l) return null; const p = window.__renderer.tileTopScreen('0,0'); return { x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2'), tx: p.x, ty: p.y, ring: window.__renderer.highlightRing.visible }; });
  if (!lineToTile || Math.abs(lineToTile.x2 - lineToTile.tx) > 2 || Math.abs(lineToTile.y2 - lineToTile.ty) > 2 || !lineToTile.ring) problems.push('welcome card line does not end on the centre tile: ' + JSON.stringify(lineToTile));
  // The menu still opens while a card is showing.
  await page.click('#btn-menu'); await page.waitForTimeout(100);
  const menuWhileCard = await page.evaluate(() => !document.getElementById('menu').classList.contains('hidden'));
  if (!menuWhileCard) problems.push('menu did not open while an NPE card was showing');
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, '05-npe-start.png') });
  // Input is blocked while the card is open.
  {
    const n = await page.evaluate(() => { const h = window.game.reachable()[0]; return [h.q, h.r]; });
    const p = await screenPos(n[0], n[1]);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(200);
    const turn = await page.evaluate(() => window.game.state.turn);
    if (turn !== 0) problems.push('NPE let the player move while a card was open');
  }
  await page.click('#btn-tutorial-ok');
  for (let i = 0; i < 2; i++) {
    await waitIdle();
    const n = await page.evaluate(() => { const h = window.game.reachable()[0]; return [h.q, h.r]; });
    const p = await screenPos(n[0], n[1]);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300);
    await page.click('#btn-tutorial-ok').catch(() => {});
    await page.waitForTimeout(100);
  }
  await waitIdle();
  const npe2 = await page.evaluate(() => ({ turn: window.game.state.turn, party: document.getElementById('party').classList.contains('npe-hidden') }));
  if (npe2.turn !== 2 || npe2.party) problems.push('NPE did not reveal the party after step 2: ' + JSON.stringify(npe2));
  await page.screenshot({ path: path.join(OUT, '06-npe-step2.png') });
  // Legend texts are generated from the config (no stale numbers).
  const legendOk = await page.evaluate(() => document.getElementById('legend-items').textContent.includes('20 supplies'));
  if (!legendOk) problems.push('legend text does not reflect the config camp cost');
  // Skip the guide (everything comes back).
  await page.evaluate(() => document.getElementById('btn-tutorial-skip').click());
  await page.waitForTimeout(200);
  const blockerGone = await page.evaluate(() => document.getElementById('input-block').classList.contains('hidden'));
  if (!blockerGone) problems.push('input blocker stayed after skipping the guide');
  await page.click('#btn-menu'); await page.waitForTimeout(150);
  const blurred = await page.evaluate(() => document.getElementById('scene').classList.contains('blurred'));
  if (!blurred) problems.push('world did not blur with the menu open');
  await page.screenshot({ path: path.join(OUT, '07-menu.png') });
  // Settings: opens, keeps the blur, a change takes effect and persists; reset restores it.
  await page.click('#btn-settings'); await page.waitForTimeout(200);
  const settingsState = await page.evaluate(() => ({ open: !document.getElementById('settings').classList.contains('hidden'), blurred: document.getElementById('scene').classList.contains('blurred'), rows: document.querySelectorAll('#settings-body .settings-row').length }));
  if (!settingsState.open || !settingsState.blurred || settingsState.rows < 5) problems.push('settings window state wrong: ' + JSON.stringify(settingsState));
  await page.evaluate(() => document.querySelector('[data-tab="encounters"]').click());
  await page.waitForTimeout(100);
  await page.evaluate(() => { const i = document.querySelector('[data-path="rest.cost"]'); i.value = '33'; i.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(100);
  // The Enter button shows the camp cost only on tiles without an encounter, so that
  // part of the check adapts to wherever the walk above happened to end.
  const applied = await page.evaluate(() => ({ cost: window.game.config.rest.cost, label: document.getElementById('btn-enter').textContent, onEncounter: !!window.game.state.position.encounter, legend: document.getElementById('legend-items').textContent.includes('33 supplies'), stored: localStorage.getItem('hexmap-settings-v1') }));
  if (applied.cost !== 33 || (!applied.onEncounter && !applied.label.includes('33')) || !applied.legend || !applied.stored.includes('rest.cost')) problems.push('setting change did not apply everywhere: ' + JSON.stringify(applied));
  await page.screenshot({ path: path.join(OUT, '08-settings.png') });
  await page.evaluate(() => document.querySelector('[data-reset="rest.cost"]').click());
  await page.waitForTimeout(100);
  const resetOk = await page.evaluate(() => window.game.config.rest.cost === 20);
  if (!resetOk) problems.push('reset did not restore the config value');
  // Language scaffolding: the selector exists and currently offers English only.
  await page.evaluate(() => document.querySelector('[data-tab="general"]').click());
  await page.waitForTimeout(100);
  const langs = await page.evaluate(() => [...document.querySelectorAll('#settings-language option')].map((o) => o.value));
  if (langs.join(',') !== 'en') problems.push('language selector should offer exactly [en], got ' + JSON.stringify(langs));
  await page.click('#btn-settings-close'); await page.waitForTimeout(100);
  const unblurred = await page.evaluate(() => !document.getElementById('scene').classList.contains('blurred'));
  if (!unblurred) problems.push('blur stayed after closing settings');
  // Climb card: first step onto a mountain asks first; "Stay" cancels, "Climb" moves.
  await page.goto(URL.replace(/\?.*$/, '') + '?npe=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.click('#btn-tutorial-ok'); await page.waitForTimeout(100);
  {
    const n = await page.evaluate(() => { const g = window.game; const h = g.reachable()[0]; const tr = g.config.tileTypes.mountain; Object.assign(h, { type: 'mountain', supplyCost: tr.supplyCost, hpCost: tr.hpCost, revealBonus: tr.revealBonus, terrainHeight: tr.terrainHeight }); window.__renderer.loadGame(g); return [h.q, h.r]; });
    await page.waitForTimeout(400);
    const p = await screenPos(n[0], n[1]);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300);
    const climb = await page.evaluate(() => ({ title: document.getElementById('tutorial-title').textContent, turn: window.game.state.turn, go: !document.getElementById('btn-tutorial-go').classList.contains('hidden'), ok: document.getElementById('btn-tutorial-ok').textContent, ring: window.__renderer.highlightRing.visible }));
    if (!/Crossing/.test(climb.title) || climb.turn !== 0 || !climb.go || climb.ok !== 'Stay here' || !climb.ring) problems.push('climb card wrong: ' + JSON.stringify(climb));
    await page.screenshot({ path: path.join(OUT, '11-climb-card.png') });
    await page.click('#btn-tutorial-ok'); await page.waitForTimeout(200);
    const stayed = await page.evaluate(() => window.game.state.turn);
    if (stayed !== 0) problems.push('"Stay here" still moved the party');
    // The card shows once: the next click moves without asking.
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(600);
    const moved = await page.evaluate(() => ({ turn: window.game.state.turn, supplies: window.game.state.supplies }));
    if (moved.turn !== 1 || moved.supplies !== 50) problems.push('second click did not climb: ' + JSON.stringify(moved));
    await dismissDialog();
  }
  // Encounter card precedes a forced encounter: arriving on an encounter tile with the guide active holds the arrival.
  await page.goto(URL.replace(/\?.*$/, '') + '?npe=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.click('#btn-tutorial-ok'); await page.waitForTimeout(100);
  await page.evaluate(() => { const g = window.game; g.state.fatigueSteps = 9; g.state.fatigue = 100; g.emit('change'); });
  {
    // Plant a battle on a neighbouring tile (ring 1 is kept empty by the generator) and rebuild the scene.
    const n = await page.evaluate(() => { const g = window.game; const h = g.reachable()[0]; h.encounter = 'battle'; h.enemies = [{ name: 'Test', hp: 10, maxHp: 10, power: 9, alive: true }]; window.__renderer.loadGame(g); return [h.q, h.r]; });
    await page.waitForTimeout(400);
    const p = await screenPos(n[0], n[1]);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(700);
    // step 1 also queues the "fog" card first; dismiss until the encounters card shows, without ever seeing a battle dialog first
    let sawBattleEarly = false, title = '';
    for (let i = 0; i < 4; i++) {
      title = await page.evaluate(() => document.getElementById('tutorial-title').textContent);
      const dlg = await page.evaluate(() => !document.getElementById('dialog').classList.contains('hidden'));
      if (dlg) { sawBattleEarly = true; break; }
      if (title === 'Encounters') break;
      await page.click('#btn-tutorial-ok'); await page.waitForTimeout(150);
    }
    if (sawBattleEarly || title !== 'Encounters') problems.push(`encounter card did not precede the forced encounter (title: ${title}, dialog early: ${sawBattleEarly})`);
    const markerHl = await page.evaluate(() => !!window.__renderer.highlightMarker);
    if (!markerHl) problems.push('encounter card did not outline the 3D marker');
    const chev = await page.evaluate(() => { const g = window.game; const rec = window.__renderer.tiles.get(g.state.position.key); return rec?.marker?.userData.chevrons.length; });
    console.log('chevrons on this battle:', chev);
    await page.screenshot({ path: path.join(OUT, '09-npe-encounter-card.png') });
    await page.click('#btn-tutorial-ok');
    // The dive is wall-clock 1.5s, but the software renderer here can run below
    // 1 fps late in the test, so poll for the report instead of a fixed wait.
    await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 25000 }).catch(() => {});
    const after = await page.evaluate(() => ({ dialog: !document.getElementById('dialog').classList.contains('hidden'), title: document.getElementById('tutorial-title').textContent, mode: window.__cinematic.mode(), lastBattle: !!window.game.state.lastBattle, posEnc: window.game.state.position.encounter, turn: window.game.state.turn }));
    if (!after.dialog) problems.push('forced encounter did not run after the encounter card: ' + JSON.stringify(after));
  }

  // The start flow: splash, the campfire start screen, the roster, Begin journey.
  await page.goto(URL.replace(/\?.*$/, '') + '?seed=555', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(400);
  const boot = await page.evaluate(() => ({
    splash: !!document.getElementById('splash'),
    start: window.__startScreen(),
    btn: document.getElementById('btn-enter').textContent,
    campfire: !!window.__localView.campfire,
    tokens: window.__localView.tokens.length,
  }));
  if (!boot.splash || !boot.start || !/Begin journey/.test(boot.btn) || !boot.campfire || boot.tokens !== 3) problems.push('start screen boot state wrong: ' + JSON.stringify(boot));
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15000 }).catch(() => problems.push('splash did not fade away'));
  await page.screenshot({ path: path.join(OUT, '31-campfire.png') });
  // Roster: click a party-panel unit, swap in a new companion.
  await page.evaluate(() => document.querySelectorAll('#party-units .unit')[0].click());
  await page.waitForTimeout(250);
  const roster = await page.evaluate(() => ({
    open: !document.getElementById('roster').classList.contains('hidden'),
    cards: document.querySelectorAll('.roster-card').length,
    taken: document.querySelectorAll('.roster-card.taken').length,
  }));
  if (!roster.open || roster.cards !== 10 || roster.taken !== 3) problems.push('roster grid wrong: ' + JSON.stringify(roster));
  await page.screenshot({ path: path.join(OUT, '32-roster.png') });
  await page.evaluate(() => { [...document.querySelectorAll('.roster-card')].find((c) => c.textContent.includes('Stonestep')).click(); });
  await page.waitForTimeout(300);
  const swapped = await page.evaluate(() => ({ name: window.game.state.party[0].name, tokens: window.__localView.tokens.length }));
  if (swapped.name !== 'Stonestep' || swapped.tokens !== 3) problems.push('roster swap failed: ' + JSON.stringify(swapped));
  // Begin journey: the same zoom-out as leaving a fight, ending on the world map.
  await page.click('#btn-enter');
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => problems.push('Begin journey did not reach the world map'));
  const onWorld = await page.evaluate(() => ({ start: window.__startScreen(), btn: document.getElementById('btn-enter').textContent }));
  if (onWorld.start || /Begin journey/.test(onWorld.btn)) problems.push('world state after Begin journey wrong: ' + JSON.stringify(onWorld));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '33-after-journey.png') });

  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'OK: no errors, all checks passed.');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
