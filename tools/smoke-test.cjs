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
  // ----- the status table (config.statuses) ---------------------------------
  // Statuses are data now: the engine, the badges and the Settings window all read
  // the same table. Check it arrived, that it still describes the four originals,
  // and that a status put on a unit reaches the panel as a badge.
  const statusWiring = await page.evaluate(() => {
    const table = window.game.config.statuses || {};
    const b = window.__battle;
    const u = b.state.units.find((x) => !x.isEnemy && x.hp > 0);
    // A slot is { turns, charges, over } - `over` holds only what the ability
    // changed through buffX; everything else is read from the table.
    u.status.shield = { turns: 0, charges: 1, over: {} };
    u.status.poison = { turns: 3, charges: 0, over: {} };
    return {
      ids: Object.keys(table),
      shieldBlocks: table.shield && table.shield.blocks === true,
      stunSkips: table.stun && table.stun.skipsTurn === true,
      poisonTicks: table.poison && table.poison.tickDamage > 0,
    };
  });
  for (const id of ['shield', 'crit', 'stun', 'haste']) {
    if (!statusWiring.ids.includes(id)) problems.push(`the status table lost "${id}": ${statusWiring.ids.join(', ')}`);
  }
  if (!statusWiring.shieldBlocks || !statusWiring.stunSkips || !statusWiring.poisonTicks) {
    problems.push('the status table does not describe its own statuses: ' + JSON.stringify(statusWiring));
  }
  // Force the panel to redraw (inspect/cancel both emit) and count the chips.
  await page.evaluate(() => { const b = window.__battle; b.inspect(b.state.units.find((x) => x.isEnemy).uid); b.cancel(); });
  await page.waitForTimeout(250);
  const badges = await page.evaluate(() => {
    const u = window.__battle.state.units.find((x) => !x.isEnemy && x.hp > 0);
    const cards = [...document.querySelectorAll('#party-units .unit')];
    const card = cards[u.partyIndex] || cards[0];
    return card ? card.querySelectorAll(".u-st:not(.empty)").length : -1;
  });
  if (badges !== 2) problems.push(`a unit carrying two statuses shows ${badges} badges in the party panel`);
  await page.evaluate(() => {
    const u = window.__battle.state.units.find((x) => !x.isEnemy && x.hp > 0);
    delete u.status.shield; delete u.status.poison;
  });
  // ----- buffX reaches the engine's own arithmetic ---------------------------
  // An ability's buffX is a LIST lined up with the status's knobs, and what it
  // sets is stored in the slot's `over`. The proof that `over` is really read (and
  // not just displayed) is that a bigger slow shrinks how far the unit can walk:
  // the reachable set is computed from effSpeed, which sums the speed field of
  // every carried status through the same lookup an ability's number lands in.
  const slowReach = await page.evaluate(async () => {
    const b = window.__battle;
    const u = b.state.units.find((x) => !x.isEnemy && x.hp > 0 && !x.done);
    const count = () => { b.cancel(); b.activate(u.uid); const r = b.reachFor(); return r && r.d ? Object.keys(r.d).length : -1; };
    // Speed has to clear combat.minSpeed by enough for two different slows to land
    // on two different numbers - at speed 3 against a floor of 2, -1 and -3 are the
    // same slow, and the check would be measuring the floor instead of the amount.
    const speed0 = u.speed;
    u.speed = Math.max(u.speed, (window.game.config.combat.minSpeed || 2) + 4);
    delete u.status.slow;
    const free = count();
    u.status.slow = { turns: 2, charges: 0, over: {} };          // the table's -1
    const table = count();
    u.status.slow = { turns: 2, charges: 0, over: { speed: -3 } }; // buffX: [-3]
    const harder = count();
    delete u.status.slow;
    const speed = u.speed;
    u.speed = speed0;
    b.cancel();
    return { free, table, harder, speed };
  });
  if (!(slowReach.free > slowReach.table && slowReach.table > slowReach.harder)) {
    problems.push('a status amount set through buffX did not reach the engine: ' + JSON.stringify(slowReach));
  }
  // And the table itself must no longer carry the two fields this replaced.
  const knobShape = await page.evaluate(() => {
    const t = window.game.config.statuses || {};
    return {
      legacy: Object.entries(t).filter(([, d]) => d.amountIs !== undefined || d.amountSign !== undefined).map(([k]) => k),
      slowSpeed: t.slow ? t.slow.speed : null,
      hasteSpeed: t.haste ? t.haste.speed : null,
    };
  });
  if (knobShape.legacy.length) problems.push('statuses still carry amountIs / amountSign: ' + knobShape.legacy.join(', '));
  if (!(knobShape.slowSpeed < 0 && knobShape.hasteSpeed > 0)) problems.push('slow / haste no longer write their own sign: ' + JSON.stringify(knobShape));

  // ----- clicking an enemy CARD inspects it ----------------------------------
  // The card in the strip and the body in the arena are two views of one creature,
  // so they answer the same click: it shows where that enemy could walk.
  const cardClick = await page.evaluate(async () => {
    const bt = window.__battle, sb = bt.state;
    bt.cancel();
    const card = document.querySelector('#enemy-roster .unit[data-enemy]');
    if (!card) return { skipped: 'no enemy card' };
    const want = card.getAttribute('data-enemy');
    card.click();
    await new Promise((r) => setTimeout(r, 150));
    const after = { uid: sb.inspectUid, reach: !!sb.inspectReach, tiles: sb.inspectReach ? Object.keys(sb.inspectReach.d).length : 0 };
    bt.cancel();
    return { want, after };
  });
  if (cardClick.skipped) problems.push('enemy card click check skipped: ' + cardClick.skipped);
  else if (cardClick.after.uid !== cardClick.want || !cardClick.after.reach || cardClick.after.tiles < 1) {
    problems.push('clicking an enemy card did not inspect it: ' + JSON.stringify(cardClick));
  }

  // ----- a character's story comes from its roster row ------------------------
  // It was an English sentence in the locale table, so a character invented in the
  // Settings window could never have one - and renaming Vanguard to Gorm silently
  // orphaned the key, leaving that character with no story at all.
  const stories = await page.evaluate(() => {
    const r = window.game.config.party.roster;
    return { rows: r.length, withStory: r.filter((u) => typeof u.story === 'string' && u.story.length > 20).length };
  });
  if (stories.withStory !== stories.rows) problems.push('roster rows without a story: ' + JSON.stringify(stories));

  // ----- passives show as badges beside the statuses --------------------------
  // A passive is a row of the same table carried a different way, and (the owner's
  // call) it shares the status row on the unit card. It has no clock and no charge
  // count, so its badge is the icon alone.
  const passiveBadges = await page.evaluate(async () => {
    const bt = window.__battle, sb = bt.state;
    const u = sb.units.find((x) => !x.isEnemy && x.hp > 0);
    const card = () => {
      const cards = [...document.querySelectorAll('#party-units .unit')];
      return cards[u.partyIndex] || cards[0];
    };
    const redraw = async () => { bt.inspect(sb.units.find((x) => x.isEnemy).uid); bt.cancel(); await new Promise((r) => setTimeout(r, 200)); };
    await redraw();
    const before = card().querySelectorAll('.u-st:not(.empty)').length;
    u.passives = ['collisionImmune', 'regeneration'];
    await redraw();
    const after = card().querySelectorAll('.u-st:not(.empty)').length;
    u.passives = [];
    await redraw();
    const cleared = card().querySelectorAll('.u-st:not(.empty)').length;
    return { before, after, cleared };
  });
  if (passiveBadges.after !== passiveBadges.before + 2 || passiveBadges.cleared !== passiveBadges.before) {
    problems.push('passives did not show as badges on the unit card: ' + JSON.stringify(passiveBadges));
  }

  // ----- tile tags are config now, and the AI can read what they do ---------
  // Tags were the one piece of arena content that could only be changed by
  // opening a file (2026-09-10). They are part of the config object now, which
  // also means the Settings window lists them beside the statuses.
  const tagWiring = await page.evaluate(() => {
    const t = window.game.config.tags || {};
    return { ids: Object.keys(t), fire: t.fire && { dmg: t.fire.dmg, life: t.fire.life },
             hooks: t.fire ? ['onPeriodic', 'onPickup', 'onExpire', 'onDestroy'].every((h) => h in t.fire) : false };
  });
  if (!tagWiring.ids.includes('fire')) problems.push('the tag table did not reach the config: ' + JSON.stringify(tagWiring));
  if (!tagWiring.hooks) problems.push('a tag row lost its hooks: ' + JSON.stringify(tagWiring));

  // ----- the aim preview -----------------------------------------------------
  // Selecting an ability rings the tiles it may be aimed at; hovering one shows
  // what a cast there would actually touch. The engine works the extent out from
  // the same zones the cast reads, so the two can never disagree.
  const aim = await page.evaluate(() => {
    const bt = window.__battle, sb = bt.state;
    const me = sb.units.find((u) => !u.isEnemy && u.hp > 0 && !u.done);
    if (!me) return { skipped: 'no unit to act with' };
    const out = {};
    for (const abId of ['strike', 'shove', 'burst']) {
      if (!me.abilityIds.includes(abId)) me.abilityIds.push(abId);
      bt.cancel(); bt.activate(me.uid); bt.selectAbility(abId);
      // Aim at the most CENTRAL castable tile: a blast aimed at the rim has part
      // of its zone off the board, which the preview correctly leaves out.
      const ring = (k) => { const [q, r] = k.split(',').map(Number); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)); };
      const keys = Object.keys(sb.aimMap || {}).sort((a, b) => ring(a) - ring(b));
      // A shove only shows a push when something is actually standing there: the
      // preview reports what MOVES, worked out by playing the cast out on a copy
      // of the board, not which tiles the pushZone covers.
      const occupied = keys.find((kk) => sb.units.some((u) => u.hp > 0 && u.pos === kk));
      const at = (abId === 'shove' && occupied) || keys[0];
      const p = at ? bt.aimPreview(at) : null;
      out[abId] = p ? { kind: p.kind, hit: p.hit.length, push: p.push.length, tag: p.tag.length,
                        at, onUnit: !!(at && sb.units.some((u) => u.hp > 0 && u.pos === at)) } : null;
      bt.cancel();
    }
    // A tile nothing may be aimed at has no preview at all.
    bt.activate(me.uid); bt.selectAbility('strike');
    const bogus = bt.aimPreview('99,99');
    bt.cancel();
    return { out, bogus };
  });
  if (aim.skipped) problems.push('aim preview check skipped: ' + aim.skipped);
  else {
    if (aim.bogus !== null) problems.push('aimPreview answered for a tile that cannot be aimed at');
    // Exact counts where the zone is one tile; shape where it is a blast, since
    // how much of a blast lands depends on how close to the rim it was aimed.
    for (const id of ['strike', 'shove']) {
      const got = aim.out[id];
      if (!got) { problems.push(`aimPreview returned nothing for ${id}`); continue; }
      if (got.kind !== 'damage') problems.push(`${id} should preview as damage, got ${got.kind}`);
      if (got.hit !== 1) problems.push(`${id} should hit exactly its aim tile, got ${got.hit} (${JSON.stringify(got)})`);
      if (got.tag !== 0) problems.push(`${id} should leave no tag, got ${got.tag}`);
    }
    // The preview reports what MOVES, not which tiles a pushZone covers, so a
    // shove aimed at bare ground reports nothing - and one aimed at a unit backed
    // against the arena wall reports nothing either, because that unit crashes
    // instead of moving. Only the first of those is safe to assert from a live
    // run, wherever the fight happens to be standing; tools/engine-test.mjs pins
    // the outcomes exactly, on boards it builds itself.
    const sh = aim.out.shove;
    if (sh && !sh.onUnit && sh.push !== 0) problems.push('a shove aimed at empty ground previewed a push: ' + JSON.stringify(sh));
    if (sh && sh.push > 1) problems.push('a one-tile shove previewed several units moving: ' + JSON.stringify(sh));
    if (aim.out.strike && aim.out.strike.push !== 0) problems.push('strike previewed a push it does not have');
    const burst = aim.out.burst;
    if (!burst) problems.push('aimPreview returned nothing for burst');
    else if (!(burst.hit > 1 && burst.hit <= 7 && burst.tag === 1 && burst.kind === 'damage')) {
      problems.push('burst should preview as a blast that leaves one tag: ' + JSON.stringify(burst));
    }
  }
  // And the view paints it: hovering a castable tile makes marks, leaving clears them.
  const aimPaint = await page.evaluate(async () => {
    const bt = window.__battle, sb = bt.state, v = window.__localView;
    const me = sb.units.find((u) => !u.isEnemy && u.hp > 0 && !u.done);
    bt.cancel(); bt.activate(me.uid); bt.selectAbility('burst');
    const k = Object.keys(sb.aimMap || {})[0];
    const p = bt.aimPreview(k);
    // One mark per tile the cast touches: the blast, the tag, and each pushed
    // tile with the trail behind it.
    const want = p ? p.hit.length + p.tag.length + p.push.reduce((n, s) => n + (s.to !== s.from ? 2 : 1), 0) + (p.dash ? 1 : 0) : 0;
    v.syncAimFx(k);
    const on = { key: v.aimFxKey, meshes: v.aimFx.length, want };
    v.syncAimFx(null);
    const off = { key: v.aimFxKey, meshes: v.aimFx.length };
    bt.cancel();
    return { on, off };
  });
  if (aimPaint.on.meshes !== aimPaint.on.want || aimPaint.on.meshes < 2 || aimPaint.off.meshes !== 0) {
    problems.push('the aim preview did not paint / clear: ' + JSON.stringify(aimPaint));
  }

  // ----- the settings defaults asked for on 2026-09-10 -----------------------
  const newDefaults = await page.evaluate(() => {
    const c = window.game.config;
    const sp = c.battle.spawns;
    return {
      volume: c.audio.volume,
      weakTick: c.battle.enemyTypes.weakTick && c.battle.enemyTypes.weakTick.color,
      // Layers 0-2 are empty on purpose; an empty cell plays the nearest filled one.
      emptyLow: Object.keys(sp).every((row) => [0, 1, 2].every((n) => (sp[row][n] || []).length === 0)),
      filledHigh: Object.keys(sp).every((row) => (sp[row][3] || []).length > 0),
    };
  });
  if (newDefaults.volume !== 0.05) problems.push('audio.volume default is ' + newDefaults.volume);
  if (newDefaults.weakTick !== '#a0c437') problems.push('weakTick colour default is ' + newDefaults.weakTick);
  if (!newDefaults.emptyLow || !newDefaults.filledHigh) problems.push('spawn layers 0-2 should be empty and 3+ filled: ' + JSON.stringify(newDefaults));

  // ----- intellect classes (config.intellect) -------------------------------
  // Every creature carries a class saying which facts it can weigh on its turn.
  // Check the table arrived, that no bestiary row was left without one, and that
  // the class reaches the unit the engine is actually running.
  const minds = await page.evaluate(() => {
    const cfg = window.game.config;
    const table = cfg.intellect || {};
    const rows = Object.entries(cfg.battle.enemyTypes || {});
    return {
      classes: Object.keys(table),
      flags: Object.keys(table.S || {}),
      missing: rows.filter(([, t]) => !t.intellect).map(([id]) => id),
      unknown: rows.filter(([, t]) => t.intellect && !table[t.intellect]).map(([id]) => id),
      onUnits: window.__battle.state.units.filter((u) => u.isEnemy).map((u) => u.intellect),
    };
  });
  for (const c of ['S', 'A', 'B', 'C']) if (!minds.classes.includes(c)) problems.push(`intellect class ${c} is missing: ${minds.classes.join(', ')}`);
  for (const f of ['statuses', 'elevation', 'tags', 'ether', 'injuries']) {
    if (!minds.flags.includes(f)) problems.push(`the intellect table lost the "${f}" flag: ${minds.flags.join(', ')}`);
  }
  if (minds.missing.length) problems.push('bestiary rows with no intellect class: ' + minds.missing.join(', '));
  if (minds.unknown.length) problems.push('bestiary rows with an unknown intellect class: ' + minds.unknown.join(', '));
  if (!minds.onUnits.length || minds.onUnits.some((c) => !c)) problems.push('an enemy in the arena carries no intellect class: ' + JSON.stringify(minds.onUnits));
  // ----- the bestiary reaches the arena whole -------------------------------
  // A creature's abilities / init / speed / flying used to be dropped on the way
  // into the fight, so every enemy fell back to the nameless default and swung
  // Strike whatever its bestiary row said. Check a row and its arena unit agree.
  const fromBestiary = await page.evaluate(() => {
    const b = window.__battle.state.units.filter((u) => u.isEnemy);
    const types = window.game.config.battle.enemyTypes;
    const byName = (n) => Object.values(types).find((t) => t.name === String(n).replace(/ \d+$/, ''));
    return b.map((u) => {
      const row = byName(u.name);
      return { name: u.name, known: !!row, abilities: (u.abilityIds || []).join('/'),
        wanted: row ? (row.abilities || []).join('/') : '', init: u.init, wantInit: row ? row.init : null };
    });
  });
  for (const u of fromBestiary) {
    if (!u.known) continue;
    if (u.abilities !== u.wanted) problems.push(`${u.name} fights with ${u.abilities} but its bestiary row says ${u.wanted}`);
    if (u.init !== u.wantInit) problems.push(`${u.name} has init ${u.init}, its bestiary row says ${u.wantInit}`);
  }
  // ----- init is an ENEMY number ---------------------------------------------
  // Turn order inside a fight is decided by the enemy queue alone, so a party
  // row never had a meaningful init. It came off the roster on 2026-09-06; this
  // keeps it off, both in the config and in the Settings table.
  const initScope = await page.evaluate(() => {
    const p = window.game.config.party;
    return {
      rosterWithInit: p.roster.filter((r) => r.init !== undefined).map((r) => r.name),
      defaultHasInit: p.defaultCombat.init !== undefined,
      enemiesWithInit: Object.values(window.game.config.battle.enemyTypes).filter((t) => t.init !== undefined).length,
      enemyRows: Object.keys(window.game.config.battle.enemyTypes).length,
    };
  });
  if (initScope.rosterWithInit.length) problems.push('party roster rows still carry init: ' + initScope.rosterWithInit.join(', '));
  if (initScope.defaultHasInit) problems.push('party.defaultCombat still carries init');
  if (initScope.enemiesWithInit !== initScope.enemyRows) problems.push('a bestiary row lost its init: ' + JSON.stringify(initScope));

  // ----- the spawn table ------------------------------------------------------
  const spawns = await page.evaluate(() => {
    const sp = window.game.config.battle.spawns || {};
    return { rows: Object.keys(sp), layers: Object.keys(sp.inner || {}).length,
      empty: Object.entries(sp).filter(([, row]) => !Object.values(row).some((l) => l && l.length)).map(([k]) => k) };
  });
  for (const row of ['inner', 'middle', 'outer', 'colonies', 'seed']) {
    if (!spawns.rows.includes(row)) problems.push(`the spawn table has no "${row}" row: ${spawns.rows.join(', ')}`);
  }
  if (spawns.layers < 2) problems.push('the spawn table has no layer columns: ' + JSON.stringify(spawns));
  if (spawns.empty.length) problems.push('spawn rows with nothing in them on any layer: ' + spawns.empty.join(', '));
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
    // ability ids and node ids are camelCase (clawSwipe:power), not all-lowercase
    refShape: window.game.state.party.every((u) => (u.upgrades ?? []).every((r) => /^[A-Za-z]+:[A-Za-z]+$/.test(r))),
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
  // Wait for the placement step to actually OPEN rather than sleeping a fixed
  // moment: on a loaded machine it opens late, and everything below then reads a
  // deployment that is not there yet (it used to crash on v.deploy.index).
  await page.waitForFunction(() => !!(window.__localView && window.__localView.deploy) || !!window.__battle, null, { timeout: 30000 }).catch(() => {});
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

  // A FORCED fight places the party itself, as a group. The cohesion guarantee
  // (party within deploy.maxSpread) is about the RANDOM arena - a handcrafted
  // map with walls, ether and a small radius may make it impossible - so this
  // check picks a battle tile WITHOUT a crafted recipe on purpose.
  await page.evaluate(() => {
    const g = window.game;
    const hex = [...g.map.hexes.values()].find((h) => h.encounter === 'battle' && !h.recipe)
      || [...g.map.hexes.values()].find((h) => h.encounter === 'battle')
      || g.state.position;
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
    return { deploying: !!window.__localView.deploy, battle: !!window.__battle, worst,
      spread: window.game.config.local.deploy.maxSpread,
      keys, radius: window.__localView.map?.radius, recipe: !!window.__localView.recipe };
  });
  if (forced.deploying) problems.push('a forced fight asked the player to place the party');
  if (!forced.battle) problems.push('a forced fight did not start');
  // The group-cohesion guarantee (party within deploy.maxSpread) is about the
  // GENERATED arena. A handcrafted map can be deliberately fragmented - e.g.
  // the-causeway is split by an ether trench - so a forced spawn there may
  // straddle it by design; the author owns that arena's spawn layout. Assert
  // cohesion only when the fight landed on a non-crafted arena.
  if (!forced.recipe && forced.worst > forced.spread) problems.push(`a forced party landed ${forced.worst} tiles apart (max ${forced.spread}) - ${JSON.stringify(forced)}`);
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
  // The statuses table on the Units tab: it renders, it no longer has the two
  // columns that were removed, and hovering a row prints that status's buffX order.
  await page.evaluate(() => document.querySelector('[data-tab="units"]').click());
  await page.waitForTimeout(150);
  const statusTable = await page.evaluate(() => {
    const box = [...document.querySelectorAll('.settings-matrix')].find((d) => /statuses/i.test(d.querySelector('.settings-group-title')?.textContent || ''));
    if (!box) return { found: false };
    const heads = [...box.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    const slow = [...box.querySelectorAll('tbody th')].find((th) => th.textContent.trim() === 'slow');
    return { found: true, heads, rows: box.querySelectorAll('tbody tr').length, slowTip: slow ? slow.getAttribute('title') : null };
  });
  if (!statusTable.found || statusTable.rows < 4) problems.push('the statuses table did not render: ' + JSON.stringify(statusTable));
  else {
    for (const gone of ['amountIs', 'amountSign']) {
      if (statusTable.heads.includes(gone)) problems.push(`the statuses table still shows a "${gone}" column`);
    }
    if (!/buffX:.*speed/.test(statusTable.slowTip || '')) problems.push('hovering a status does not name its buffX order: ' + statusTable.slowTip);
  }
  await page.evaluate(() => document.querySelector('[data-tab="general"]').click());
  await page.waitForTimeout(100);
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
  const detail = await page.evaluate(() => {
    // What the trees SHOULD draw is read from the config rather than written down:
    // the trees are content and their node counts change as they are designed, so a
    // hard-coded "2 abilities x 5 nodes" only ever tested how old this test was.
    const g = window.game;
    const ids = (g.config.party.roster.find((r) => r.name === document.querySelector('#unit-detail .ud-name')?.textContent)
      || {}).abilities ?? [];
    let wantNodes = 0, wantEdges = 0;
    for (const id of ids) {
      const tree = (g.config.abilityUpgrades || {})[id] || {};
      wantNodes += Object.keys(tree).length;
      for (const n of Object.values(tree)) wantEdges += (n.requires || []).length;
    }
    return {
    wantNodes, wantEdges,
    sections: document.querySelectorAll('#unit-detail .ud-ability').length,
    // the tree is drawn as CARDS with curved edges now, not an SVG of circles
    nodes: document.querySelectorAll('#unit-detail .ut-card').length,
    edges: document.querySelectorAll('#unit-detail .ability-tree .ut-edge').length,
    story: (document.querySelector('#unit-detail .ud-story')?.textContent ?? '').length > 20,
    name: document.querySelector('#unit-detail .ud-name')?.textContent,
  }; });
  if (detail.sections !== 2 || detail.nodes !== detail.wantNodes || detail.nodes === 0) {
    problems.push('unit detail should draw one card per node of both trees: ' + JSON.stringify(detail));
  }
  if (detail.edges !== detail.wantEdges) problems.push('upgrade trees are missing their edges: ' + JSON.stringify(detail));
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
  if (gateSetup.layer !== 3 || gateSetup.mapLayer !== 3) problems.push('a fresh run should sit on the start layer (3): ' + JSON.stringify(gateSetup));
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
  if (!/Layer 4/.test(gateDlg.body)) problems.push('the gate should unlock Layer 4 first (3 > 4 > 2 > ...): ' + gateDlg.body);
  if (gateDlg.stored !== '2') problems.push('the layer unlock was not stored: ' + JSON.stringify(gateDlg));
  if (!gateDlg.consumed) problems.push('the gate should be consumed on entry');
  await page.screenshot({ path: path.join(OUT, '34-gate-dialog.png') });
  await dismissDialog();

  // ----- The LAYER SELECTOR + the roll cinematic ------------------------------
  // Two layers are unlocked now: a fresh start screen grows the selector above
  // Begin journey; picking Layer 4 barrel-rolls the camera under the ground,
  // restarts the run on the new layer at the underside and surfaces over the
  // recoloured world.
  await page.goto(URL.replace(/\?.*$/, '') + '?seed=555', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  const sel = await page.evaluate(() => ({
    visible: !document.getElementById('layer-select').classList.contains('hidden'),
    label: document.getElementById('btn-layer').textContent,
  }));
  if (!sel.visible || !/Layer 3/.test(sel.label)) problems.push('layer selector wrong with two layers unlocked: ' + JSON.stringify(sel));
  await page.click('#btn-layer');
  await page.waitForTimeout(100);
  const opts = await page.evaluate(() => ({
    open: !document.getElementById('layer-options').classList.contains('hidden'),
    order: [...document.querySelectorAll('#layer-options button')].map((b) => b.dataset.layer).join(','),
  }));
  // The list reads like the worldflake: higher layers on top (4 above 3).
  if (!opts.open || opts.order !== '4,3') problems.push('layer options wrong: ' + JSON.stringify(opts));
  await page.screenshot({ path: path.join(OUT, '35-layer-selector.png') });
  // Same seed = same topology, so one revealed tile can be compared across layers.
  const layerProbe = await page.evaluate(() => {
    const g = window.game;
    const h = [...g.map.hexes.values()].find((x) => x.revealed && !x.isStart && g.config.tileTypes[x.type].biomeTint);
    return h ? { key: h.key, color: window.__renderer.targetColorFor(h).getHex() } : null;
  });
  if (!layerProbe) problems.push('no revealed biome-tinted tile to probe the layer palette with');
  await page.evaluate(() => { [...document.querySelectorAll('#layer-options button')].find((b) => b.dataset.layer === '4').click(); });
  await page.waitForTimeout(CONFIG_ROLL_MS * 0.35);
  await page.screenshot({ path: path.join(OUT, '36-layer-roll.png') });
  await page.waitForFunction(() => window.game && window.game.layer === 4, null, { timeout: 20000 }).catch(() => problems.push('the roll never swapped the run to layer 4'));
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
  if (rolled.layer !== 4 || rolled.mapLayer !== 4) problems.push('layer switch did not land on 4: ' + JSON.stringify(rolled));
  if (layerProbe && rolled.color === layerProbe.color) problems.push('the biome palette did not change with the layer');
  if (!rolled.start || rolled.mode !== 'local' || !/Layer 4/.test(rolled.label)) problems.push('start screen state wrong after the roll: ' + JSON.stringify(rolled));
  await page.screenshot({ path: path.join(OUT, '37-layer4-campfire.png') });
  // Begin journey: the run now walks layer 4.
  await page.click('#btn-enter');
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 25000 }).catch(() => problems.push('Begin journey did not leave the layer-4 start screen'));
  await page.waitForTimeout(400);
  const onLayer4 = await page.evaluate(() => ({ layer: window.game.layer, start: window.__startScreen() }));
  if (onLayer4.layer !== 4 || onLayer4.start) problems.push('the layer-4 journey did not begin: ' + JSON.stringify(onLayer4));
  await page.screenshot({ path: path.join(OUT, '38-layer4-world.png') });

  // ----- THE TUTORIAL MAPS: not covered here (2026-09-12) ---------------------
  // The three scenario walkthroughs used to run end to end from this file. The
  // tutorial itself is out of date with the game and is being reworked; its
  // checks were failing for that reason and not because anything they guarded
  // had broken, so they were removed rather than left red or quietly loosened.
  // The last version of them is in _archive_2026-09-12, and they should come
  // back with the reworked tutorial.

  // ----- HANDCRAFTED MAPS: crafted assignment + the map code preview tool -----
  await page.goto(URL.replace(/\?.*$/, '') + '?seed=777&nostart=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);
  // World generation hands some battle / shop tiles an authored recipe, whose
  // enemies replace the rolled group and whose danger line drives the chevrons.
  const craftedGen = await page.evaluate(() => {
    const hexes = [...window.game.map.hexes.values()];
    const battle = hexes.find((h) => h.encounter === 'battle' && h.recipe);
    const shop = hexes.find((h) => h.encounter === 'shop' && h.recipe);
    return {
      battles: hexes.filter((h) => h.encounter === 'battle' && h.recipe).length,
      shops: hexes.filter((h) => h.encounter === 'shop' && h.recipe).length,
      danger: battle ? window.game.dangerRank(battle) : null,
      declared: battle ? battle.recipe.danger : null,
      enemies: battle ? battle.enemies.length : 0,
      authoredSpawns: battle ? (battle.recipe.spawns?.enemies?.length ?? 0) : 0,
      shopHasRecipe: !!shop,
    };
  });
  if (!craftedGen.battles) problems.push('no battle tile got a crafted map on seed 777: ' + JSON.stringify(craftedGen));
  if (craftedGen.declared != null && craftedGen.danger !== craftedGen.declared) problems.push('crafted danger override ignored: ' + JSON.stringify(craftedGen));
  if (craftedGen.enemies && craftedGen.enemies !== craftedGen.authoredSpawns) problems.push('crafted enemies do not match authored spawns: ' + JSON.stringify(craftedGen));
  // The debug preview: Menu -> Preview map code, paste a code with a wall, an
  // ether hole, fire and one enemy; the camera dives into that arena.
  await page.click('#btn-menu');
  await page.waitForTimeout(150);
  await page.click('#btn-mapcode');
  await page.waitForTimeout(200);
  const dlgOpen = await page.evaluate(() => !document.getElementById('dialog').classList.contains('hidden') && !!document.getElementById('mapcode-input'));
  if (!dlgOpen) problems.push('the map code dialog did not open');
  // No `danger:` header any more - a battle tile's chevrons come from its ring
  // band now (config.battle.danger.ringBands), and the parser rejects the line.
  const TEST_CODE = ['id: smoke-test-arena', 'radius: 3',
    '0,0: ground 4', '1,0: wall', '2,0: ether', '1,-1: ground 2 fire', '0,1: ground 3 !Husk'].join('\n');
  // A broken code must stay in the dialog and list its problems.
  await page.evaluate((code) => { document.getElementById('mapcode-input').value = code + '\n9,9: lava'; }, TEST_CODE);
  await page.click('#dialog-actions button:first-child');
  await page.waitForTimeout(200);
  const errShown = await page.evaluate(() => !!document.querySelector('.mapcode-errors'));
  if (!errShown) problems.push('a broken map code did not show its errors');
  await page.evaluate((code) => { document.getElementById('mapcode-input').value = code; }, TEST_CODE);
  await page.click('#dialog-actions button:first-child');
  await page.waitForTimeout(2200);   // the fly-in
  const preview = await page.evaluate(() => {
    const v = window.__localView;
    if (!v || !v.map) return { loaded: false };   // the code never parsed - say so, do not throw
    const tile = (k) => v.map.hexes.get(k);
    return {
      radius: v.map.radius,
      wall: tile('1,0')?.type, ether: tile('2,0')?.type,
      wallTaller: (tile('1,0')?.top ?? 0) > (tile('0,0')?.top ?? 0),
      fireSprite: v.tagSprites?.has('1,-1') ?? false,
      exitShown: !document.getElementById('preview-exit').classList.contains('hidden'),
      // the elevation value ramp: a level-4 tile paints brighter than a level-2 one
      hi: tile('0,0')?.mesh.material.color.getHSL({}).l,
      mid: tile('-1,0')?.mesh.material.color.getHSL({}).l,
    };
  });
  if (preview.loaded === false) problems.push('the map code never loaded a preview - it did not parse');
  else if (preview.radius !== 3) problems.push('preview arena radius is not the code\'s: ' + JSON.stringify(preview));
  if (preview.wall !== 'wall' || preview.ether !== 'ether') problems.push('preview tile types wrong: ' + JSON.stringify(preview));
  if (!preview.wallTaller) problems.push('a wall column is not taller than ground: ' + JSON.stringify(preview));
  if (!preview.fireSprite) problems.push('an authored fire tag has no sprite in the preview');
  if (!preview.exitShown) problems.push('the preview exit button is hidden during a preview');
  if (!(preview.hi > preview.mid)) problems.push('elevation shading: a level-4 tile is not brighter than level-2: ' + JSON.stringify(preview));
  await page.screenshot({ path: path.join(OUT, '68-mapcode-preview.png') });
  await page.click('#preview-exit');
  await page.waitForTimeout(1800);   // the fly-out
  const backHome = await page.evaluate(() => ({
    exitHidden: document.getElementById('preview-exit').classList.contains('hidden'),
    turn: window.game.state.turn,
  }));
  if (!backHome.exitHidden) problems.push('the preview exit button survived leaving the preview');
  if (backHome.turn !== 0) problems.push('the preview touched game state: ' + JSON.stringify(backHome));
  await page.screenshot({ path: path.join(OUT, '69-mapcode-back.png') });

  // ----- settings saved by an OLDER build -----------------------------------
  // Saved settings are a snapshot of the config as it was that day, so one made
  // before a table grew a column arrives without it. A roster saved before the
  // characters carried their own abilities once took the whole page down on load
  // (ui.js drew a card, asked for the abilities, got undefined). A fresh page with
  // that exact stale save must come up, keep the settings it can, and heal the rest.
  {
    const stale = {
      // rows as they were written before the roster grew its combat fields, plus a
      // character invented in the Settings window - which is how this was found
      'party.roster': [
        { name: 'Vanguard', icon: '🛡️', hp: 40 },
        { name: 'Archer', icon: '🏹', hp: 28 },
        { name: 'Mystic', icon: '🔮', hp: 22 },
        { name: 'New character', icon: '🙂', hp: 24 },
      ],
      'battle.bosses': ['forgeTyrant'],   // a setting whose config no longer exists
      'camera.followPlayer': false,       // an ordinary setting, which must survive
    };
    const fresh = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const stalePains = [];
    fresh.on('pageerror', (e) => stalePains.push('PAGE ERROR: ' + e.message));
    await fresh.addInitScript((v) => { localStorage.setItem('hexmap-settings-v1', JSON.stringify(v)); }, stale);
    await fresh.goto(URL.includes('?') ? `${URL}&nostart=1` : `${URL}?nostart=1`, { waitUntil: 'load', timeout: 60000 });
    await fresh.waitForTimeout(2500);
    const healed = await fresh.evaluate(() => ({
      alive: !!window.game,
      cards: document.querySelectorAll('#party-units .unit').length,
      slots: document.querySelectorAll('#party-units .u-slot.ab:not(.empty)').length,
      vanguardAbilities: (window.game.config.party.roster.find((r) => r.name === 'Vanguard') || {}).abilities,
      deadDropped: window.game.config.battle.bosses === undefined,
      kept: window.game.config.camera.followPlayer,
    }));
    if (stalePains.length) problems.push('stale settings threw on load: ' + stalePains.join(' | '));
    if (!healed.alive || healed.cards !== 3) problems.push('stale settings did not boot a party: ' + JSON.stringify(healed));
    if (healed.slots !== 6) problems.push('stale settings lost the party\'s abilities: ' + JSON.stringify(healed));
    if (!Array.isArray(healed.vanguardAbilities) || healed.vanguardAbilities.length !== 2) {
      problems.push('a roster row saved by an older build was not healed: ' + JSON.stringify(healed));
    }
    if (!healed.deadDropped) problems.push('an override pointing at config that is gone was kept: ' + JSON.stringify(healed));
    if (healed.kept !== false) problems.push('healing a stale save threw away a setting it should have kept: ' + JSON.stringify(healed));
    await fresh.close();
  }

  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'OK: no errors, all checks passed.');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
