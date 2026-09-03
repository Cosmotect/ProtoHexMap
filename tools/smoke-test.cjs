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
// How long the layer-switch camera roll takes (config.layers.rollMs).
const CONFIG_ROLL_MS = 2600;
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
    // Sandboxed test machines cannot reach Google Fonts; those failures are
    // expected noise (a tunnel error, or the proxy answering with a 404).
    const src = (m.location() && m.location().url) || '';
    if (m.text().includes('ERR_TUNNEL_CONNECTION_FAILED')) return;
    if (src.includes('fonts.googleapis.com') || src.includes('fonts.gstatic.com')) return;
    problems.push(m.type() + ': ' + m.text() + (src ? ` [${src}]` : ''));
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
  // DEPLOYMENT: a fight the party walks into now waits for the player to place
  // each unit before the first round (config.local.deploy). Any test that opens
  // a fight has to get through that step first. This drops the waiting units on
  // the first free tiles it finds and returns how many it placed (0 = nothing
  // was waiting, e.g. a forced fight, which places the party itself).
  const placeParty = async () => {
    await page.waitForFunction(
      () => !!window.__battle || !!(window.__localView && window.__localView.deploy) || window.__cinematic.mode() === 'idle',
      null, { timeout: 30000 }).catch(() => {});
    return page.evaluate(() => {
      const v = window.__localView;
      if (!v || !v.deploy) return 0;
      const taken = new Set((v.placement && v.placement.enemyKeys) || []);
      let n = 0;
      for (const tile of v.map.hexes.values()) {
        if (!v.deploy) break;                 // the last unit closed the step
        if (taken.has(tile.key)) continue;
        const before = v.deploy.index;
        v.placeDeployUnit(tile.key);
        if (!v.deploy || v.deploy.index > before) { taken.add(tile.key); n++; }
      }
      return n;
    });
  };

  // Combat is interactive now: a fight dives into the arena and waits for the
  // player. If one started (e.g. a fatigue-forced battle mid-walk), win it from
  // the console, close the report + reward windows and fly back out.
  const settleBattleIfAny = async () => {
    await placeParty();
    await page.waitForFunction(() => !!window.__battle || window.__cinematic.mode() === 'idle', null, { timeout: 30000 }).catch(() => {});
    if (!(await page.evaluate(() => !!window.__battle))) return;
    await page.evaluate(() => window.__battle.debugResolve(true));
    await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 25000 }).catch(() => {});
    await dismissDialog();
    await dismissDialog();
    await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => {});
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

  // A won battle offers the +power chooser (regression: the reward is decided
  // before the dialog is built). Fights are interactive now: enter() dives into
  // the arena and starts the engine; the test wins instantly via debugResolve.
  await page.evaluate(() => { const g = window.game; const hex = g.state.position; hex.encounter = 'battle'; hex.enemies = [{ name: 'Dummy', hp: 1, maxHp: 1, power: 0, alive: true }]; g.enter(false); });
  // The engine is built at the SWAP point, while the camera is still landing:
  // wait for the flight to finish before reading the on-screen state.
  await placeParty();
  await page.waitForFunction(() => !!window.__battle && window.__cinematic.mode() === 'local', null, { timeout: 30000 });
  const engineState = await page.evaluate(() => ({
    mode: window.__cinematic.mode(),
    bar: !document.getElementById('battle-bar').classList.contains('hidden'),
    units: window.__battle.state.units.length,
    // Heights sit around the neutral middle step now: a wave means variety.
    wave: new Set(Object.values(window.__battle.state.heights)).size > 1,
    abilities: window.__battle.state.units.every((u) => u.abilityIds.length > 0),
  }));
  if (engineState.mode !== 'local') problems.push('battle engine started outside the local map: ' + JSON.stringify(engineState));
  if (!engineState.bar) problems.push('battle bar is not shown during a fight');
  if (engineState.units !== 4) problems.push(`expected 3 party + 1 enemy in the engine, got ${engineState.units}`);
  if (!engineState.wave) problems.push('battle arena has no elevation wave (all tiles flat)');
  if (!engineState.abilities) problems.push('some combat units have no abilities');
  await page.screenshot({ path: path.join(OUT, '01e-battle-engine.png') });
  await page.evaluate(() => window.__battle.debugResolve(true));
  await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 25000 });
  const rewardBtn = await page.evaluate(() => [...document.querySelectorAll('#dialog-actions button')].map((b) => b.textContent).join('|'));
  if (!/unlock/i.test(rewardBtn)) problems.push('battle report lacks the upgrade reward button: ' + rewardBtn);
  const transcript = await page.evaluate(() => document.getElementById('dialog-body').textContent);
  if (/\{(attacker|defender|dmg)\}/.test(transcript)) problems.push('battle transcript shows raw placeholders');
  await page.evaluate(() => { document.querySelector('#dialog-actions button').click(); });
  await page.waitForTimeout(150);
  // The upgrade chooser: one offered tree node per living unit, plus Skip.
  const chooser = await page.evaluate(() => ({
    title: document.getElementById('dialog-title').textContent,
    buttons: document.querySelectorAll('#dialog-actions button').length,
    living: window.game.livingUnits().length,
  }));
  if (!/Lessons/.test(chooser.title)) problems.push('upgrade chooser did not open after the battle: ' + JSON.stringify(chooser));
  if (chooser.buttons !== chooser.living + 1) problems.push(`upgrade chooser should offer ${chooser.living} upgrades + Skip, got ${chooser.buttons}`);
  await page.screenshot({ path: path.join(OUT, '01e-reward-chooser.png') });
  // Picking the first offer unlocks a real tree node on a party unit.
  await page.evaluate(() => { document.querySelector('#dialog-actions button').click(); });
  await page.waitForTimeout(200);
  const unlocked = await page.evaluate(() => ({
    total: window.game.state.party.reduce((a, u) => a + (u.upgrades?.length ?? 0), 0),
    refShape: window.game.state.party.every((u) => (u.upgrades ?? []).every((r) => /^[a-z]+:[a-z]+$/.test(r))),
    chips: document.querySelectorAll('#party-units .u-slot.ab:not(.empty)').length,
    marked: document.querySelectorAll('#party-units .u-slot.ab b').length,
  }));
  if (unlocked.total !== 1 || !unlocked.refShape) problems.push('the reward pick did not unlock exactly one tree node: ' + JSON.stringify(unlocked));
  if (unlocked.chips !== 6) problems.push(`party panel should show 2 filled ability sockets per unit (6), got ${unlocked.chips}`);
  if (unlocked.marked !== 1) problems.push('the unlocked upgrade is not counted on its ability socket: ' + JSON.stringify(unlocked));
  // Closing the last window flies the camera back out to the world map.
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => problems.push('did not fly back out after the reward chooser'));

  // ----- the retreat rule (config.combat.flee) -----------------------------
  // A fight the party has clearly won must not need mopping up: past
  // flee.afterRound, with the enemy side under flee.hpFraction of its opening HP,
  // the survivors break and run for the edge. Escaping is NOT a death (no loot
  // when loot exists) but the fight still counts as a WIN.
  await page.evaluate(() => {
    const g = window.game; const hex = g.state.position;
    hex.encounter = 'battle';
    hex.enemies = [0, 1, 2].map((i) => ({ name: 'Husk ' + i, hp: 20, maxHp: 20, power: 6, alive: true }));
    g.enter(false);
  });
  await placeParty();
  await page.waitForFunction(() => !!window.__battle && window.__cinematic.mode() === 'local', null, { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const sb = window.__battle.state;
    sb.round = 9;                                     // past flee.afterRound
    for (const u of sb.units) if (u.isEnemy) u.hp = 3;  // 9 of 60 = 15% of the pool
  });
  // Pass every player turn; the enemy phase is where the rolls happen. Each enemy
  // rolls once per turn, so give the fight enough ROUNDS (not seconds) for the dice
  // to speak: with three enemies at a third each, ten rounds without a single break
  // is a one-in-a-million event, i.e. a real regression.
  for (let round = 0; round < 10; round++) {
    // Wait out the enemy phase rather than sleeping a fixed time: the AI's own
    // timers are far slower than any wait worth hardcoding.
    await page.waitForFunction(
      () => { const b = window.__battle; return !b || b.state.over || (b.state.phase === 'player' && !b.state.busy); },
      null, { timeout: 30000 }).catch(() => {});
    if (await page.evaluate(() => !window.__battle || !!window.__battle.state.over)) break;
    await page.evaluate(() => { const b = window.__battle; if (b && b.state.phase === 'player' && !b.state.busy && !b.state.over) b.endTurn(); });
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
  const fled = await page.evaluate(() => {
    const b = window.__battle;
    if (!b) return { gone: true };
    const sb = b.state;
    if (sb.noFlee) return { gone: false, armed: false, over: sb.over, deaths: 0, fledCount: 0, total: 0, tokens: 0 };
    const es = sb.units.filter((u) => u.isEnemy);
    return {
      over: sb.over, round: sb.round, deaths: sb.deaths.length,
      fledCount: es.filter((u) => u.fled).length, total: es.length,
      tokens: [...(window.__localView.battleTokens || new Map())].filter(([uid, t]) => t.visible && es.some((e) => e.uid === uid && e.fled)).length,
    };
  });
  if (!fled.gone) {
    if (fled.armed === false) problems.push('an ordinary fight came up exempt from the retreat rule: ' + JSON.stringify(fled));
    if (fled.fledCount === 0) problems.push('nobody fled a hopeless fight past the retreat round: ' + JSON.stringify(fled));
    if (fled.deaths > 0 && fled.fledCount === fled.total) problems.push('fleeing enemies were reported as deaths: ' + JSON.stringify(fled));
    if (fled.tokens > 0) problems.push('an escaped enemy left its token on the board: ' + JSON.stringify(fled));
    if (fled.fledCount === fled.total && fled.over !== 'win') problems.push('the fight did not end in a win once every enemy ran: ' + JSON.stringify(fled));
    await page.screenshot({ path: path.join(OUT, '01f-retreat.png') });
  }
  // Whatever is left, finish and get back out to the world map.
  await page.evaluate(() => { if (window.__battle && !window.__battle.state.over) window.__battle.debugResolve(true); });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 6; i++) { await dismissDialog(); await page.waitForTimeout(200); }
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => problems.push('did not fly back out after the retreat check'));
  await waitIdle();

  // The combat cinematic + the playable fight: Enter on a battle dives into the
  // local map (clouds, scene swap), the engine takes over, the results window
  // opens when it ends, closing everything flies back.
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
  await placeParty();
  await page.waitForFunction(() => !!window.__battle && window.__cinematic.mode() === 'local', null, { timeout: 30000 }).catch(() => {});
  const landed = await page.evaluate(() => ({
    mode: window.__cinematic.mode(),
    battle: !!window.__battle,
    bar: !document.getElementById('battle-bar').classList.contains('hidden'),
    tiles: window.__localView.map ? window.__localView.map.hexes.size : 0,
    tokens: window.__localView.tokens.length,
    orientation: window.__localView.map ? window.__localView.map.orientation : '?',
    pan: window.__localView.controls ? window.__localView.controls.enablePan : null,
    zoom: window.__localView.controls ? window.__localView.controls.enableZoom : null,
  }));
  if (landed.mode !== 'local' || !landed.battle || !landed.bar) problems.push('did not land in the local map with the fight running: ' + JSON.stringify(landed));
  if (landed.tiles !== 127) problems.push(`local map should have 127 tiles (radius 6), got ${landed.tiles}`);
  if (landed.tokens !== 5) problems.push(`expected 3 party + 2 enemy tokens, got ${landed.tokens}`);
  if (landed.orientation === (await page.evaluate(() => window.game.config.map.orientation))) problems.push('local map orientation should be opposite to the world map');
  if (landed.pan !== false || landed.zoom !== false) problems.push('local camera must not pan or zoom: ' + JSON.stringify(landed));
  await page.screenshot({ path: path.join(OUT, '21-local-map.png') });
  // Arena baseline heights: tiles start at the world tile TYPE's height; the
  // backdrop hexes' bottoms sit on the arena floor and their tops use the same
  // type formula; three rings of them stand around the arena.
  const baseline = await page.evaluate(() => {
    const lv = window.__localView; const g = window.game;
    const cfgL = g.config.local;
    const typeH = g.config.tileTypes[g.state.position.type]?.height ?? 0.3;
    const expected = Math.max(cfgL.tileHeight, typeH * (cfgL.typeHeightScale ?? 2));
    const t0 = lv.map.hexes.get('0,0');
    const backs = lv.scene.children.filter((c) => c.isMesh && c.userData.key === undefined
      && c.geometry.type === 'CylinderGeometry' && c.geometry.parameters.radiusTop > cfgL.hexSize * 3);
    // Levels are centred on the neutral MIDDLE step (elevationLevels 4 -> 2):
    // that step renders at the type baseline, others offset by elevationStep.
    const mid = cfgL.elevationMid ?? 2;
    return {
      expected, base: lv.baseTileHeight, backs: backs.length,
      tileOk: Math.abs((t0.top - ((t0.elevation ?? mid) - mid) * (cfgL.elevationStep ?? 0.35)) - expected) < 1e-6,
      backBottomsOk: backs.every((b) => Math.abs(b.position.y) < 1e-6),
    };
  });
  if (Math.abs(baseline.base - baseline.expected) > 1e-6 || !baseline.tileOk) problems.push('arena baseline height wrong: ' + JSON.stringify(baseline));
  if (baseline.backs <= 6) problems.push(`expected up to 3 rings of backdrop hexes, got ${baseline.backs}`);
  if (!baseline.backBottomsOk) problems.push('backdrop hex bottoms are not on the arena floor');
  // The menu's "Win battle" button ends the fight as an instant victory.
  await page.click('#btn-menu');
  await page.waitForTimeout(200);
  await page.click('#btn-win-battle');
  await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 25000 });
  const wonBtn = await page.evaluate(() => ({
    won: !!(window.game.state.lastBattle && window.game.state.lastBattle.won),
    engineGone: !window.__battle,
    menuClosed: document.getElementById('menu').classList.contains('hidden'),
  }));
  if (!wonBtn.won || !wonBtn.engineGone || !wonBtn.menuClosed) problems.push('Win battle button did not win the fight: ' + JSON.stringify(wonBtn));
  await dismissDialog();
  await dismissDialog();
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => {});
  const backOut = await page.evaluate(() => ({ mode: window.__cinematic.mode(), filter: window.__renderer.renderer.domElement.style.filter, bar: document.getElementById('battle-bar').classList.contains('hidden') }));
  if (backOut.mode !== 'idle' || backOut.filter) problems.push('did not return cleanly to the world map: ' + JSON.stringify(backOut));
  if (!backOut.bar) problems.push('battle bar stayed visible after the fight');

  // ----- DEPLOYMENT, the void edge, death spots, a sold-out shop --------------
  // A fight the party WALKS INTO waits for the player to place each unit; a
  // FORCED one drops them as a group instead. Shoves over an arena side that
  // faces a hole in the world kill; every death reports the tile it happened on.
  await page.evaluate(() => {
    const g = window.game;
    const hex = [...g.map.hexes.values()].find((h) => h.encounter === 'battle');
    g.startCombat(hex, false);
  });
  await page.waitForFunction(() => window.__cinematic.mode() === 'local', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const deployOpen = await page.evaluate(() => {
    const v = window.__localView;
    v.hoverKey = '0,0';                 // the icon decal follows the cursor
    v.stepDeployDecal();
    const free = { visible: v.deployDecal.visible, color: v.deployDecal.material.color.getHex(), icon: !!v.deployDecal.material.map };
    v.hoverKey = (v.placement.enemyKeys || [])[0];
    v.stepDeployDecal();
    return {
      deploying: !!v.deploy, battle: !!window.__battle,
      bar: !document.getElementById('deploy-bar').classList.contains('hidden'),
      step: document.getElementById('deploy-step').textContent,
      partyTokens: v.tokens.filter((t) => t.userData.partyIndex != null).length,
      free, takenColor: v.deployDecal.material.color.getHex(),
    };
  });
  if (!deployOpen.deploying || !deployOpen.bar) problems.push('walking into a fight did not open the placement step: ' + JSON.stringify(deployOpen));
  if (deployOpen.battle) problems.push('the fight started before the party was placed');
  if (deployOpen.partyTokens !== 0) problems.push('party tokens are on the board during placement');
  if (!deployOpen.free.visible || !deployOpen.free.icon) problems.push('no icon decal on the hovered tile');
  if (deployOpen.free.color === deployOpen.takenColor) problems.push('an occupied tile is not marked on the decal');
  await page.screenshot({ path: path.join(OUT, '22-deploy.png') });
  // Place them, taking one back on the way (the right-click undo).
  const placed = await page.evaluate(() => {
    const v = window.__localView;
    const want = [...v.map.hexes.keys()].filter((k) => !(v.placement.enemyKeys || []).includes(k)).slice(0, 4);
    v.placeDeployUnit(want[0]);
    v.placeDeployUnit(want[1]);
    v.undeployLast();
    const undo = { index: v.deploy.index, tokens: v.tokens.filter((t) => t.userData.partyIndex != null).length };
    const keys = [want[0]];
    while (v.deploy) { const k = want[keys.length]; keys.push(k); v.placeDeployUnit(k); }
    return { undo, keys };
  });
  if (placed.undo.index !== 1 || placed.undo.tokens !== 1) problems.push('the placement undo did not take the last unit back: ' + JSON.stringify(placed.undo));
  await page.waitForTimeout(400);
  const deployed = await page.evaluate(() => ({
    battle: !!window.__battle,
    bar: !document.getElementById('deploy-bar').classList.contains('hidden'),
    battleBar: !document.getElementById('battle-bar').classList.contains('hidden'),
    party: window.__battle ? window.__battle.state.units.filter((u) => !u.isEnemy).map((u) => u.pos) : [],
  }));
  if (!deployed.battle || deployed.bar || !deployed.battleBar) problems.push('the fight did not open after the last unit was placed: ' + JSON.stringify(deployed));
  if (JSON.stringify(deployed.party) !== JSON.stringify(placed.keys)) problems.push('the party is not on the chosen tiles: ' + JSON.stringify(deployed.party) + ' vs ' + JSON.stringify(placed.keys));
  // Only the sides facing a hole are lethal: a synthetic set of neighbours with
  // one void side must produce keys on that side alone (within its 60-degree
  // sector, so at most 30 degrees off its centre).
  const voidGeom = await page.evaluate(() => {
    const v = window.__localView;
    const edges = [0, 60, 120, 180, 240, 300].map((d, i) => ({ dx: Math.cos(d * Math.PI / 180), dy: Math.sin(d * Math.PI / 180), isVoid: i === 0 }));
    const keys = [...v.computeVoidEdges(edges)];
    const size = v.config.local.hexSize;
    const worst = keys.reduce((m, k) => {
      const [q, r] = k.split(',').map(Number);
      const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r); const y = size * 1.5 * r;
      return Math.max(m, Math.abs(Math.atan2(y, x) * 180 / Math.PI));
    }, 0);
    return { count: keys.length, worst: Math.round(worst), noneWhenSolid: [...v.computeVoidEdges(edges.map((e) => ({ ...e, isVoid: false })))].length };
  });
  if (!voidGeom.count || voidGeom.worst > 31) problems.push('void edge keys are not on the void side: ' + JSON.stringify(voidGeom));
  if (voidGeom.noneWhenSolid !== 0) problems.push('void edge keys with no void side: ' + JSON.stringify(voidGeom));
  // Winning the fight reports every death on the tile the unit stood on.
  const deathSpots = await page.evaluate(() => {
    const before = window.__battle.state.units.filter((u) => u.isEnemy && u.hp > 0).map((u) => u.uid + '@' + u.pos);
    window.__battle.debugResolve(true);
    return { before, after: window.__battle.state.deaths.map((d) => d.uid + '@' + d.key) };
  });
  if (deathSpots.after.length !== deathSpots.before.length || deathSpots.after.some((x) => !deathSpots.before.includes(x))) {
    problems.push('death spots do not match where the units stood: ' + JSON.stringify(deathSpots));
  }
  await dismissDialog();
  await dismissDialog();
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => {});

  // A FORCED fight places the party itself, as a group.
  await page.evaluate(() => {
    const g = window.game;
    const hex = [...g.map.hexes.values()].find((h) => h.encounter === 'battle') || g.state.position;
    hex.encounter = 'battle';
    g.startCombat(hex, true);
  });
  await page.waitForFunction(() => !!window.__battle, null, { timeout: 30000 }).catch(() => {});
  const forced = await page.evaluate(() => {
    const d = (a, b) => { const [q1, r1] = a.split(',').map(Number); const [q2, r2] = b.split(',').map(Number);
      return (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(q1 + r1 - q2 - r2)) / 2; };
    const keys = window.__battle ? window.__battle.state.units.filter((u) => !u.isEnemy).map((u) => u.pos) : [];
    let worst = 0;
    for (const a of keys) for (const b of keys) worst = Math.max(worst, d(a, b));
    return { deploying: !!window.__localView.deploy, battle: !!window.__battle, worst, spread: window.game.config.local.deploy.maxSpread };
  });
  if (forced.deploying) problems.push('a forced fight asked the player to place the party');
  if (!forced.battle) problems.push('a forced fight did not start');
  if (forced.worst > forced.spread) problems.push(`a forced party landed ${forced.worst} tiles apart (max ${forced.spread})`);
  await page.evaluate(() => window.__battle && window.__battle.debugResolve(true));
  await dismissDialog();
  await dismissDialog();
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => {});

  // A shop with nothing left to sell leaves the map.
  const soldOut = await page.evaluate(() => {
    const g = window.game;
    const hex = [...g.map.hexes.values()].find((h) => h.encounter === 'shop');
    if (!hex) return { skipped: true };
    if (!hex.shop) hex.shop = g.rollShopStock();
    const here = g.state.position;
    g.state.position = hex; g.state.supplies = 999;
    const last = hex.shop.options.includes('map') ? 'map' : hex.shop.options[0];
    for (const id of hex.shop.options) if (id !== last) hex.shop.bought[id] = true;
    const bought = g.shopBuy(last);
    const after = hex.encounter;
    g.state.position = here;
    return { skipped: false, bought, after };
  });
  if (!soldOut.skipped && (!soldOut.bought || soldOut.after !== null)) problems.push('a sold-out shop stayed on the map: ' + JSON.stringify(soldOut));

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
    // Ether tiles wear a fog plate while hidden; once REVEALED (and the reveal
    // animation has finished) the plate hides and the void shows through.
    const ether = [...g.map.hexes.values()].filter((h) => h.type === 'ether');
    if (ether.some((h) => {
      const rec = window.__renderer.tiles.get(h.key);
      const animating = rec && rec.colorTween && !rec.colorTween.done;
      return h.revealed && rec && !animating && rec.mesh.visible;
    })) out.push('a revealed ether tile still shows a mesh - it should be a hole');
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
    await settleBattleIfAny();   // a fatigue-forced fight would open the arena
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

  // Menu, blur and the settings window (on a plain run).
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  // Legend texts are generated from the config (no stale numbers).
  const legendOk = await page.evaluate(() => document.getElementById('legend-items').textContent.includes('20 supplies'));
  if (!legendOk) problems.push('legend text does not reflect the config camp cost');
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
  // part of the check adapts to wherever the run happens to stand.
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

  // A fatigue-forced fight on a plain run: the dive starts by itself and the
  // battle opens with the AMBUSH enemy phase.
  await page.evaluate(() => { const g = window.game; g.state.fatigueSteps = 9; g.state.fatigue = 100; g.emit('change'); });
  {
    const n = await page.evaluate(() => { const g = window.game; const h = g.reachable().find((x) => !x.encounter) ?? g.reachable()[0]; h.encounter = 'battle'; h.enemies = [{ name: 'Test', hp: 10, maxHp: 10, power: 9, alive: true }]; window.__renderer.loadGame(g); return [h.q, h.r]; });
    await page.waitForTimeout(400);
    const p = await screenPos(n[0], n[1]);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up();
    await placeParty();
    await page.waitForFunction(() => !!window.__battle, null, { timeout: 30000 }).catch(() => {});
    if (!(await page.evaluate(() => !!window.__battle))) problems.push('forced encounter did not start an interactive battle');
    await page.evaluate(() => window.__battle && window.__battle.debugResolve(true));
    await page.waitForFunction(() => !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 25000 }).catch(() => {});
    const after = await page.evaluate(() => ({ dialog: !document.getElementById('dialog').classList.contains('hidden'), lastBattle: !!window.game.state.lastBattle }));
    if (!after.dialog || !after.lastBattle) problems.push('forced battle did not produce a report: ' + JSON.stringify(after));
    await dismissDialog();
    await dismissDialog();
    await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => {});
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
  // With only the starting layer unlocked there is no layer selector.
  const layerHidden = await page.evaluate(() => document.getElementById('layer-select').classList.contains('hidden'));
  if (!layerHidden) problems.push('layer selector should be hidden with a single unlocked layer');
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
  // The slot's own unit is the confirmed (green) card, not "taken"; only the
  // OTHER two party members are locked out of this slot.
  if (!roster.open || roster.cards !== 10 || roster.taken !== 2) problems.push('roster grid wrong: ' + JSON.stringify(roster));
  // The unit detail window below the grid: portrait + story on the left, TWO
  // ability sections with their 5-node upgrade trees drawn as SVG.
  const detail = await page.evaluate(() => ({
    sections: document.querySelectorAll('#unit-detail .ud-ability').length,
    nodes: document.querySelectorAll('#unit-detail .ut-node').length,
    edges: document.querySelectorAll('#unit-detail .ability-tree line').length,
    story: (document.querySelector('#unit-detail .ud-story')?.textContent ?? '').length > 20,
    name: document.querySelector('#unit-detail .ud-name')?.textContent,
  }));
  if (detail.sections !== 2 || detail.nodes !== 10) problems.push('unit detail should show 2 abilities x 5 tree nodes: ' + JSON.stringify(detail));
  if (detail.edges < 8) problems.push('upgrade trees are missing their edges: ' + JSON.stringify(detail));
  if (!detail.story) problems.push('unit detail lacks a backstory: ' + JSON.stringify(detail));
  // Hovering another roster card previews that character in the detail window.
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.roster-card')].find((x) => x.textContent.includes('Duskblade'));
    c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const hoverName = await page.evaluate(() => document.querySelector('#unit-detail .ud-name')?.textContent);
  if (hoverName !== 'Duskblade') problems.push('hovering a roster card did not preview it: ' + hoverName);
  await page.screenshot({ path: path.join(OUT, '32-roster.png') });
  // Clicking a card only SELECTS it; the swap happens on the confirm button.
  await page.evaluate(() => { [...document.querySelectorAll('.roster-card')].find((c) => c.textContent.includes('Stonestep')).click(); });
  await page.waitForTimeout(200);
  const pending = await page.evaluate(() => ({
    selected: !!document.querySelector('.roster-card.selected'),
    stillOld: window.game.state.party[0].name,
  }));
  if (!pending.selected || pending.stillOld === 'Stonestep') problems.push('clicking a roster card should only select it: ' + JSON.stringify(pending));
  await page.evaluate(() => document.getElementById('btn-roster-confirm').click());
  await page.waitForTimeout(300);
  const swapped = await page.evaluate(() => ({ name: window.game.state.party[0].name, tokens: window.__localView.tokens.length, closed: document.getElementById('roster').classList.contains('hidden') }));
  if (swapped.name !== 'Stonestep' || swapped.tokens !== 3 || !swapped.closed) problems.push('roster swap failed: ' + JSON.stringify(swapped));
  // Begin journey: the same zoom-out as leaving a fight, ending on the world map.
  await page.click('#btn-enter');
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => problems.push('Begin journey did not reach the world map'));
  const onWorld = await page.evaluate(() => ({ start: window.__startScreen(), btn: document.getElementById('btn-enter').textContent }));
  if (onWorld.start || /Begin journey/.test(onWorld.btn)) problems.push('world state after Begin journey wrong: ' + JSON.stringify(onWorld));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '33-after-journey.png') });

  // ----- The LAYER GATE: the green pyramid unlocks the next worldflake layer ---
  // Generated gates are extremely rare and capped at one per map; the test
  // plants one on the current tile instead and walks the unlock.
  const gateSetup = await page.evaluate(() => {
    const g = window.game;
    const generated = [...g.map.hexes.values()].filter((h) => h.encounter === 'gate').length;
    const hex = g.state.position;
    hex.encounter = 'gate';
    window.__renderer.loadGame(g);
    const rec = window.__renderer.tiles.get(hex.key);
    return {
      generated,
      layer: g.layer,
      mapLayer: g.map.layer,
      pyramid: rec?.marker?.geometry === window.__renderer.markerGeos.pyramid,
      green: rec?.marker?.material?.color?.getHex() === g.config.encounters.visuals.gate.color,
      legend: document.getElementById('legend-items').textContent.includes('Layer gate'),
    };
  });
  if (gateSetup.generated > 1) problems.push(`gates must be unique per map, found ${gateSetup.generated}`);
  if (gateSetup.layer !== 4 || gateSetup.mapLayer !== 4) problems.push('a fresh run should sit on the start layer (4): ' + JSON.stringify(gateSetup));
  if (!gateSetup.pyramid || !gateSetup.green) problems.push('the gate marker is not a green pyramid: ' + JSON.stringify(gateSetup));
  if (!gateSetup.legend) problems.push('the layer gate is missing from the legend');
  await page.evaluate(() => window.game.enter(false));
  await page.waitForTimeout(300);
  const gateDlg = await page.evaluate(() => ({
    open: !document.getElementById('dialog').classList.contains('hidden'),
    title: document.getElementById('dialog-title').textContent,
    body: document.getElementById('dialog-body').textContent,
    stored: (() => { try { return localStorage.getItem('hexmap-layers-progress'); } catch { return null; } })(),
    consumed: window.game.state.position.encounter === null,
  }));
  if (!gateDlg.open || !/Gate/i.test(gateDlg.title)) problems.push('entering the gate did not open its dialog: ' + JSON.stringify(gateDlg));
  if (!/Layer 5/.test(gateDlg.body)) problems.push('the gate should unlock Layer 5 first (4 > 5 > 3 > ...): ' + gateDlg.body);
  if (gateDlg.stored !== '2') problems.push('the layer unlock was not stored: ' + JSON.stringify(gateDlg));
  if (!gateDlg.consumed) problems.push('the gate should be consumed on entry');
  await page.screenshot({ path: path.join(OUT, '34-gate-dialog.png') });
  await dismissDialog();

  // ----- The LAYER SELECTOR + the roll cinematic ------------------------------
  // Two layers are unlocked now: a fresh start screen grows the selector above
  // Begin journey; picking Layer 5 barrel-rolls the camera under the ground,
  // restarts the run on the new layer at the underside and surfaces over the
  // recoloured world.
  await page.goto(URL.replace(/\?.*$/, '') + '?seed=555', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  const sel = await page.evaluate(() => ({
    visible: !document.getElementById('layer-select').classList.contains('hidden'),
    label: document.getElementById('btn-layer').textContent,
  }));
  if (!sel.visible || !/Layer 4/.test(sel.label)) problems.push('layer selector wrong with two layers unlocked: ' + JSON.stringify(sel));
  await page.click('#btn-layer');
  await page.waitForTimeout(100);
  const opts = await page.evaluate(() => ({
    open: !document.getElementById('layer-options').classList.contains('hidden'),
    order: [...document.querySelectorAll('#layer-options button')].map((b) => b.dataset.layer).join(','),
  }));
  // The list reads like the worldflake: higher layers on top (5 above 4).
  if (!opts.open || opts.order !== '5,4') problems.push('layer options wrong: ' + JSON.stringify(opts));
  await page.screenshot({ path: path.join(OUT, '35-layer-selector.png') });
  // Same seed = same topology, so one revealed tile can be compared across layers.
  const layerProbe = await page.evaluate(() => {
    const g = window.game;
    const h = [...g.map.hexes.values()].find((x) => x.revealed && !x.isStart && g.config.tileTypes[x.type].biomeTint);
    return h ? { key: h.key, color: window.__renderer.targetColorFor(h).getHex() } : null;
  });
  if (!layerProbe) problems.push('no revealed biome-tinted tile to probe the layer palette with');
  await page.evaluate(() => { [...document.querySelectorAll('#layer-options button')].find((b) => b.dataset.layer === '5').click(); });
  await page.waitForTimeout(CONFIG_ROLL_MS * 0.35);
  await page.screenshot({ path: path.join(OUT, '36-layer-roll.png') });
  await page.waitForFunction(() => window.game && window.game.layer === 5, null, { timeout: 20000 }).catch(() => problems.push('the roll never swapped the run to layer 5'));
  await page.waitForFunction(() => !window.__localView.layerRoll, null, { timeout: 20000 }).catch(() => problems.push('the layer roll never finished'));
  await page.waitForTimeout(300);
  const rolled = await page.evaluate(([key]) => {
    const g = window.game;
    const h = g.map.hexes.get(key);
    return {
      layer: g.layer, mapLayer: g.map.layer,
      color: h ? window.__renderer.targetColorFor(h).getHex() : null,
      start: window.__startScreen(), mode: window.__cinematic.mode(),
      label: document.getElementById('btn-layer').textContent,
      party: g.state.party.length,
    };
  }, [layerProbe?.key ?? '0,0']);
  if (rolled.layer !== 5 || rolled.mapLayer !== 5) problems.push('layer switch did not land on 5: ' + JSON.stringify(rolled));
  if (layerProbe && rolled.color === layerProbe.color) problems.push('the biome palette did not change with the layer');
  if (!rolled.start || rolled.mode !== 'local' || !/Layer 5/.test(rolled.label)) problems.push('start screen state wrong after the roll: ' + JSON.stringify(rolled));
  await page.screenshot({ path: path.join(OUT, '37-layer5-campfire.png') });
  // Begin journey: the run now walks layer 5.
  await page.click('#btn-enter');
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => problems.push('Begin journey did not leave the layer-5 start screen'));
  await page.waitForTimeout(400);
  const onLayer5 = await page.evaluate(() => ({ layer: window.game.layer, start: window.__startScreen() }));
  if (onLayer5.layer !== 5 || onLayer5.start) problems.push('the layer-5 journey did not begin: ' + JSON.stringify(onLayer5));
  await page.screenshot({ path: path.join(OUT, '38-layer5-world.png') });

  // ----- SCENARIO ENGINE: the hand-authored tutorial map, walked end to end ----
  // Everything on it is scripted, so the whole walkthrough is deterministic:
  // follow the corridor, win the bridge fight, collect the cache, camp, reach
  // the waypoint - the run must end in a scenario victory.
  await page.goto(URL.replace(/\?.*$/, '') + '?scenario=tutorial1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  const scn = await page.evaluate(() => ({
    id: window.game.scenario?.id,
    tiles: window.game.map.hexes.size,
    start: window.game.state.position.key,
    startScreen: window.__startScreen(),
    splash: !!document.getElementById('splash'),
    bridge: (window.game.map.hexes.get('4,-2')?.enemies ?? []).map((e) => e.name).join(','),
    cache: window.game.map.hexes.get('6,-3')?.encounter,
    goal: window.game.map.hexes.get('9,-4')?.encounter,
    supplies: window.game.state.supplies,
    max: window.game.state.maxSupplies,
    stasisLines: !!window.__renderer.stasisGroup,
    legendHasGoal: document.getElementById('legend-items').textContent.includes('Waypoint'),
    card: !document.getElementById('tutorial').classList.contains('hidden'),
    cardTitle: document.getElementById('tutorial-title').textContent,
    hudVisible: !document.getElementById('party').classList.contains('hidden'),
  }));
  if (scn.id !== 'tutorial1' || scn.tiles !== 12 || scn.start !== '0,0') problems.push('scenario map wrong: ' + JSON.stringify(scn));
  if (scn.startScreen || scn.splash) problems.push('scenario boot should skip the splash and campfire: ' + JSON.stringify(scn));
  if (scn.bridge !== 'Husk' || scn.cache !== 'treasure' || scn.goal !== 'goal') problems.push('scenario encounters wrong: ' + JSON.stringify(scn));
  if (scn.supplies !== 10 || scn.max !== 60) problems.push('scenario supplies wrong: ' + JSON.stringify(scn));
  if (scn.stasisLines) problems.push('a scenario without a Stasis still drew stasis lines');
  if (scn.legendHasGoal) problems.push('the hidden waypoint marker leaked into the legend');
  if (!scn.card || !/road/i.test(scn.cardTitle)) problems.push('the opening tutorial card did not show: ' + JSON.stringify(scn));
  if (!scn.hudVisible) problems.push('scenario mode should keep the whole HUD visible');
  await page.screenshot({ path: path.join(OUT, '60-scenario-start.png') });
  await page.click('#btn-tutorial-ok');
  await page.waitForTimeout(150);
  let camped = false;
  let cardsSeen = 0;
  for (let i = 0; i < 24; i++) {
    // Dismiss whichever hint card popped (the bridge, the fight, the cache...).
    const dismissed = await page.evaluate(() => {
      const open = !document.getElementById('tutorial').classList.contains('hidden');
      if (open) document.getElementById('btn-tutorial-ok').click();
      return open;
    });
    if (dismissed) { cardsSeen += 1; await page.waitForTimeout(120); continue; }
    const st = await page.evaluate(() => {
      const g = window.game;
      if (g.state.status !== 'playing') return { done: g.state.status };
      const pos = g.state.position;
      if (pos.encounter && pos.encounter !== 'goal') return { enter: pos.encounter };
      const [gq, gr] = g.scenario.goal.tile.split(',').map(Number);
      const d = (h) => (Math.abs(h.q - gq) + Math.abs(h.r - gr) + Math.abs(h.q + h.r - gq - gr)) / 2;
      // Visit encounters on the way (the cache), otherwise walk towards the goal.
      const enc = (h) => (h.encounter && h.encounter !== 'goal' ? 1 : 0);
      const r = g.reachable().slice().sort((a, b) => enc(b) - enc(a) || d(a) - d(b));
      if (!r.length) return { stuck: true };
      g.moveTo(r[0]);
      return { moved: r[0].key };
    });
    if (st.done || st.stuck) break;
    if (st.enter === 'battle') {
      // The bridge fight: enter, then win it from the console like the other blocks.
      await page.evaluate(() => window.game.enter(false));
      await settleBattleIfAny();
    } else if (st.enter === 'treasure') {
      await page.evaluate(() => window.game.enter(false));
      await page.waitForTimeout(250);
      await dismissDialog();
      // The cache exists to afford a camp: make one on the widening right here.
      const campOk = await page.evaluate(() => {
        const g = window.game;
        if (g.state.supplies < g.config.rest.cost) return { fail: 'cannot afford camp', s: g.state.supplies };
        return { camped: g.makeCamp ? g.makeCamp() : g.enter(false), s: g.state.supplies };
      });
      if (campOk.fail) problems.push('scenario cache did not pay for the camp: ' + JSON.stringify(campOk));
      camped = true;
      await page.waitForTimeout(250);
      await dismissDialog();
    }
    await page.waitForTimeout(200);
  }
  const scnEnd = await page.evaluate(() => ({
    status: window.game.state.status,
    reason: String(window.game.state.endReason),
    hurt: window.game.state.party.some((u) => u.hp < u.maxHp),
  }));
  if (scnEnd.status !== 'won' || !/end.scenario/.test(scnEnd.reason)) problems.push('scenario walkthrough did not end in a victory: ' + JSON.stringify(scnEnd));
  if (!camped) problems.push('scenario walkthrough never reached the treasure/camp beat');
  if (cardsSeen < 3) problems.push(`expected at least 3 more hint cards along the road, saw ${cardsSeen}`);
  // Any card still open holds the end overlay back: dismiss, then the overlay follows.
  await page.evaluate(() => { const b = document.getElementById('btn-tutorial-ok'); if (!document.getElementById('tutorial').classList.contains('hidden')) b.click(); });
  await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => problems.push('end overlay did not appear after the scenario win'));
  const prog = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('hexmap-tutorial-progress') ?? '{}'); } catch { return {}; } });
  if (!prog.tutorial1) problems.push('tutorial completion was not stored: ' + JSON.stringify(prog));
  await page.screenshot({ path: path.join(OUT, '61-scenario-won.png') });

  // ----- Map 2 "The Fork": the Next map button chains straight into it --------
  const nextVisible = await page.evaluate(() => !document.getElementById('btn-overlay-next').classList.contains('hidden'));
  if (!nextVisible) problems.push('the end overlay did not offer Next map after tutorial 1');
  await page.click('#btn-overlay-next');
  await page.waitForFunction(() => window.game && window.game.scenario && window.game.scenario.id === 'tutorial2', null, { timeout: 15000 }).catch(() => problems.push('Next map did not open tutorial2'));
  await page.waitForTimeout(600);
  const scn2 = await page.evaluate(() => ({
    tiles: window.game.map.hexes.size,
    byStep5: window.game.config.fatigue.byStep[5],
    boxes: document.querySelectorAll('#fatigue-boxes .fbox').length,
    card: !document.getElementById('tutorial').classList.contains('hidden'),
  }));
  if (scn2.tiles !== 12 || scn2.byStep5 !== 100) problems.push('tutorial2 map or configPatch wrong: ' + JSON.stringify(scn2));
  if (scn2.boxes !== 5) problems.push(`fatigue bar did not rebuild for the patched table (boxes: ${scn2.boxes})`);
  if (!scn2.card) problems.push('tutorial2 did not open with its fatigue card');
  // Walk the LEFT road: the hill and the mountain charge for passage, the
  // scripted ambush lands on the mountain (the 4th step), and the plateau
  // guards get fought on the AUTHORED arena (recipe heights + fixed spawns).
  let sawAmbush = false;
  for (const [q, r] of [[1, 0], [2, -1], [3, -2], [4, -3], [5, -3], [6, -3], [7, -4]]) {
    for (let i = 0; i < 4; i++) {
      const open = await page.evaluate(() => {
        const el = document.getElementById('tutorial');
        const o = !el.classList.contains('hidden');
        if (o) document.getElementById('btn-tutorial-ok').click();
        return o;
      });
      if (!open) break;
      await page.waitForTimeout(120);
    }
    const moved = await page.evaluate(([mq, mr]) => window.game.moveTo(window.game.hexAt(mq, mr)), [q, r]);
    if (!moved) { problems.push(`tutorial2 walkthrough could not step to ${q},${r}`); break; }
    await page.waitForTimeout(250);
    if (await page.evaluate(() => window.__cinematic.isActive() || !!window.__battle)) {
      if (await page.evaluate(() => window.game.state.position.key === '4,-3')) sawAmbush = true;
    }
    await settleBattleIfAny();
    const pos = await page.evaluate(() => ({ enc: window.game.state.position.encounter, status: window.game.state.status }));
    if (pos.status !== 'playing') break;
    if (pos.enc === 'battle') {
      await page.evaluate(() => { const el = document.getElementById('tutorial'); if (!el.classList.contains('hidden')) document.getElementById('btn-tutorial-ok').click(); });
      await page.evaluate(() => window.game.enter(false));
      await placeParty();
      await page.waitForFunction(() => !!window.__battle, null, { timeout: 30000 });
      const arena = await page.evaluate(() => {
        const b = window.__battle;
        return {
          h00: b.state.heights['0,0'],
          hRamp: b.state.heights['0,1'],
          enemies: b.state.units.filter((u) => u.isEnemy).map((u) => u.pos).sort().join('|'),
          // Untouched tiles sit on the neutral middle step (2); the recipe's
          // plateau (4) and ramp (3) are the only tiles ABOVE it.
          raised: Object.values(b.state.heights).filter((h) => h > 2).length,
        };
      });
      if (arena.h00 !== 4 || arena.hRamp !== 3) problems.push('guard arena recipe heights not applied: ' + JSON.stringify(arena));
      if (arena.enemies !== '0,0|1,-1|2,-1') problems.push('guard arena fixed spawns not applied: ' + JSON.stringify(arena));
      if (arena.raised !== 7) problems.push('recipe arena should have exactly the 7 authored raised tiles: ' + JSON.stringify(arena));
      await page.screenshot({ path: path.join(OUT, '64-guard-arena.png') });
      await settleBattleIfAny();
    }
  }
  if (!sawAmbush) problems.push('the scripted ambush did not fire on the left road');
  const scn2End = await page.evaluate(() => ({ status: window.game.state.status }));
  if (scn2End.status !== 'won') problems.push('tutorial2 walkthrough did not win: ' + JSON.stringify(scn2End));
  await page.evaluate(() => { const el = document.getElementById('tutorial'); if (!el.classList.contains('hidden')) document.getElementById('btn-tutorial-ok').click(); });
  await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => problems.push('no end overlay after tutorial2'));
  // Leaving the tutorial must undo the configPatch (the fatigue table returns).
  await page.click('#btn-overlay-new');
  await page.waitForTimeout(900);
  const restored = await page.evaluate(() => ({ byStep9: window.game.config.fatigue.byStep[9], byStep5: window.game.config.fatigue.byStep[5], scenario: !!window.game.scenario }));
  // The default table has byStep[9] = 75 and byStep[5] = 5; the patch had set [5] = 100.
  if (restored.scenario || restored.byStep9 !== 75 || restored.byStep5 !== 5) problems.push('configPatch was not undone after the tutorial: ' + JSON.stringify(restored));

  // ----- Map 3 "The Withering": the scripted Stasis in miniature --------------
  await page.goto(URL.replace(/\?.*$/, '') + '?scenario=tutorial3', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  const scn3 = await page.evaluate(() => {
    const g = window.game;
    return {
      id: g.scenario?.id,
      seedTitle: g.map.seed?.enemies?.title,
      seedRevealed: !!g.map.seed?.revealed,
      colonies: g.stasis.colonies.length,
      colonyDist: g.stasis.colonies[0]?.distance,
      weakRank: g.dangerRank(g.hexAt(-2, 0)),
      strongRank: g.dangerRank(g.hexAt(-1, 3)),
      seedRank: g.dangerRank(g.map.seed),
      lineSpeed: g.config.stasis.lineSpeed,
      witherEvery: g.config.stasis.witherEvery,
    };
  });
  if (scn3.id !== 'tutorial3' || scn3.seedTitle !== 'Stasis Sprout' || !scn3.seedRevealed) problems.push('tutorial3 seed wrong: ' + JSON.stringify(scn3));
  if (scn3.colonies !== 1 || scn3.colonyDist !== 6) problems.push('tutorial3 scripted colony wrong: ' + JSON.stringify(scn3));
  // Absolute chevrons: the skirmish sits below the first band (0), the wall in
  // the second (2); the Seed always wears the fixed seed count.
  if (scn3.weakRank !== 0 || scn3.strongRank !== 2) problems.push('tutorial3 danger ranks wrong: ' + JSON.stringify(scn3));
  if (scn3.seedRank !== 5) problems.push('the Seed should always wear 5 chevrons: ' + JSON.stringify(scn3));
  if (scn3.lineSpeed !== 1 || scn3.witherEvery !== 1) problems.push('tutorial3 configPatch not applied: ' + JSON.stringify(scn3));
  await page.screenshot({ path: path.join(OUT, '65-withering-start.png') });
  // Dismiss whatever hint cards are open (start shows two).
  const okCards = async () => {
    for (let i = 0; i < 4; i++) {
      const open = await page.evaluate(() => {
        const el = document.getElementById('tutorial');
        const o = !el.classList.contains('hidden');
        if (o) document.getElementById('btn-tutorial-ok').click();
        return o;
      });
      if (!open) break;
      await page.waitForTimeout(120);
    }
  };
  await okCards();
  // Wander in place to burn turns: the scripted colony must land exactly on its
  // authored arriveTurn (6), whatever the geometry says.
  for (const [q, r] of [[1, 0], [0, 0], [1, 0], [0, 0], [1, 0], [0, 0]]) {
    await page.evaluate(([mq, mr]) => window.game.moveTo(window.game.hexAt(mq, mr)), [q, r]);
    await page.waitForTimeout(200);
    await okCards();
  }
  const clock = await page.evaluate(() => {
    const g = window.game;
    return {
      turn: g.state.turn,
      colonyActive: g.stasis.colonies[0].active,
      colonyTitle: g.hexAt(-2, 2)?.enemies?.title,
      withered: [...g.map.hexes.values()].filter((h) => h.biome === 'wither').length,
    };
  });
  if (clock.turn !== 6) problems.push('tutorial3 wander loop miscounted turns: ' + JSON.stringify(clock));
  if (!clock.colonyActive || clock.colonyTitle !== 'Rot Chorus') problems.push('scripted colony did not arrive on turn 6: ' + JSON.stringify(clock));
  if (clock.withered < 5) problems.push('the accelerated wither is not spreading: ' + JSON.stringify(clock));
  await page.screenshot({ path: path.join(OUT, '66-withering-colony.png') });
  // Clear the colony: its curse (scripted maxHp debuff) must be on while it
  // stands and gone from the seed fight after.
  for (const [q, r] of [[-1, 1], [-2, 2]]) {
    await page.evaluate(([mq, mr]) => window.game.moveTo(window.game.hexAt(mq, mr)), [q, r]);
    await page.waitForTimeout(200);
    await okCards();
  }
  // Remember the healthy max HP: the debuff shrinks it only for the fight.
  const preMax = await page.evaluate(() => window.game.state.party[0].maxHp);
  await page.evaluate(() => window.game.enter(false));
  await placeParty();
  await page.waitForFunction(() => !!window.__battle, null, { timeout: 30000 });
  const curse = await page.evaluate(([pre]) => {
    const b = window.__battle;
    const u = b.state.units.find((x) => !x.isEnemy && x.partyIndex === 0);
    const frac = window.game.config.stasis.debuffs.maxHp.fraction;
    return { cursedMax: u.maxHp, expected: Math.round(pre * (1 - frac)) };
  }, [preMax]);
  if (curse.cursedMax !== curse.expected) problems.push('colony curse (maxHp debuff) not applied in its fight: ' + JSON.stringify(curse));
  // The Stasis never breaks and runs, however badly the fight is going for it.
  if (!(await page.evaluate(() => window.__battle.state.noFlee))) problems.push('a Stasis Colony fight is not exempt from the retreat rule');
  await settleBattleIfAny();
  const cleared = await page.evaluate(() => ({
    cleared: window.game.stasis.colonies.filter((c) => c.cleared).length,
    status: window.game.state.status,
  }));
  if (cleared.cleared !== 1 || cleared.status !== 'playing') problems.push('colony did not clear: ' + JSON.stringify(cleared));
  // March on the seed and win: a seed-goal scenario ends there.
  for (const [q, r] of [[-1, 1], [0, 0], [1, -1], [2, -2], [3, -3]]) {
    await page.evaluate(([mq, mr]) => window.game.moveTo(window.game.hexAt(mq, mr)), [q, r]);
    await page.waitForTimeout(200);
    await okCards();
  }
  await page.evaluate(() => window.game.enter(false));
  await placeParty();
  await page.waitForFunction(() => !!window.__battle, null, { timeout: 30000 });
  await settleBattleIfAny();
  const scn3End = await page.evaluate(() => ({
    status: window.game.state.status,
    reason: String(window.game.state.endReason),
    prog: (() => { try { return JSON.parse(localStorage.getItem('hexmap-tutorial-progress') ?? '{}'); } catch { return {}; } })(),
  }));
  if (scn3End.status !== 'won' || !/end.seed/.test(scn3End.reason)) problems.push('tutorial3 did not end in a seed victory: ' + JSON.stringify(scn3End));
  if (!scn3End.prog.tutorial3) problems.push('tutorial3 completion was not stored: ' + JSON.stringify(scn3End.prog));
  await okCards();
  await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => problems.push('no end overlay after tutorial3'));
  // The last map of the chain: no Next map button.
  const lastNext = await page.evaluate(() => document.getElementById('btn-overlay-next').classList.contains('hidden'));
  if (!lastNext) problems.push('tutorial3 (the last map) still offers Next map');
  await page.screenshot({ path: path.join(OUT, '67-withering-won.png') });

  // The menu's Tutorial button starts the (first unfinished) tutorial map.
  await page.goto(URL.replace(/\?.*$/, '') + '?seed=777&nostart=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.click('#btn-menu');
  await page.waitForTimeout(150);
  await page.click('#btn-tutorial');
  // All three maps are complete by now, so the chain settles on its last map.
  await page.waitForFunction(() => window.game && window.game.scenario && window.game.scenario.id === 'tutorial3', null, { timeout: 15000 }).catch(() => problems.push('the menu Tutorial button did not start the tutorial map'));
  const menuBoot = await page.evaluate(() => ({
    url: window.location.search,
    card: !document.getElementById('tutorial').classList.contains('hidden'),
  }));
  if (!/scenario=tutorial3/.test(menuBoot.url)) problems.push('the tutorial did not land in the address bar: ' + menuBoot.url);
  if (!menuBoot.card) problems.push('starting the tutorial from the menu did not show the opening card');

  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'OK: no errors, all checks passed.');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
