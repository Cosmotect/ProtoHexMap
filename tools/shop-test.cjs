// Headless playtest of the SHOP encounter (config.shop, config.craftedMaps.shop
// - see DESIGN.md "The shop") and of the menu's generic Win / Restart
// encounter buttons. Opens the built game, plants a shop on the party's tile,
// presses E and checks the party dives into the shop's arena with the keeper
// standing on the pinned tile and no battle bar; clicks the keeper and checks
// the card window; buys Information (a plain purchase), Training (the upgrade
// chooser replaces the shop window and the shop window comes back after the
// pick) and leaves; then plants a hack and checks Restart encounter / Win
// encounter act on it.
//
//   npm run build && npx vite preview --port 4173     (one terminal)
//   node tools/shop-test.cjs                          (another)
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

  const dialogOpen = () => page.evaluate(() => !document.getElementById('dialog').classList.contains('hidden'));
  const dialogTitle = () => page.evaluate(() => document.getElementById('dialog-title').textContent);

  // ----- 1. every shop tile carries a shop map ------------------------------
  const maps = await page.evaluate(() => {
    const shops = [...window.game.map.hexes.values()].filter((h) => h.encounter === 'shop');
    return { shops: shops.length, withRecipe: shops.filter((h) => h.recipe).length, keeperPinned: shops.filter((h) => (h.recipe?.spawns?.npcs ?? []).some((n) => n.id === 'shopkeeper')).length };
  });
  check(maps.shops > 0 && maps.withRecipe === maps.shops, `every shop tile has a shop map (${maps.withRecipe}/${maps.shops}; no rate)`);
  check(maps.keeperPinned === maps.shops, 'every shop map pins the keeper (@shopkeeper)');

  // ----- 2. enter a shop -----------------------------------------------------
  await page.evaluate(() => {
    const g = window.game; const h = g.state.position;
    h.encounter = 'shop'; h.shop = g.rollShopStock();
    // Force a stock that exercises every path: Training (a chooser), Information (plain), Spare Parts (a unit pick).
    h.shop.options = ['upgrade', 'map', 'spareParts', 'rest'];
    h.recipe = [...g.map.hexes.values()].find((x) => x.encounter === 'shop' && x.recipe)?.recipe ?? null;
    g.emit('change');
  });
  await page.waitForTimeout(200);
  await page.keyboard.press('e');
  await page.waitForFunction(() => !!window.__shop && window.__cinematic.mode() === 'local', null, { timeout: 30000 });
  await page.waitForTimeout(500);
  const s0 = await page.evaluate(() => {
    const v = window.__localView; const sh = window.__shop;
    const keeperKey = sh.keeper.pos;
    const pinned = (window.game.state.position.recipe?.spawns?.npcs ?? []).find((n) => n.id === 'shopkeeper')?.key;
    return {
      party: v.tokens.filter((m) => m.userData.partyIndex != null).length,
      partyOnKeeper: v.tokens.some((m) => m.userData.tileKey === keeperKey),
      keeperKey, pinned,
      battleBar: !document.getElementById('battle-bar').classList.contains('hidden'),
      battleMode: document.body.classList.contains('battle-mode'),
      hackBar: !!document.getElementById('hack-bar'),
      localMode: document.body.classList.contains('local-mode'),
      exitBtn: !document.getElementById('shop-exit').classList.contains('hidden'),
      dialog: !document.getElementById('dialog').classList.contains('hidden'),
      pickables: (v.pickables ?? []).length,
      radius: v.map.radius, mapId: window.game.state.position.recipe?.id,
      keeperKind: sh.keeper.kind, isUnit: sh.keeper.isUnit,
    };
  });
  check(s0.party === 3, `three party units stand in the shop (${s0.party})`);
  check(s0.keeperKey === s0.pinned, `the keeper stands on the pinned tile (${s0.keeperKey})`);
  check(!s0.partyOnKeeper, 'nobody was placed on the keeper\'s tile');
  check(!s0.battleBar && !s0.battleMode && !s0.hackBar, 'no battle bar, no combat mode, no hack panel in the shop');
  check(s0.localMode && s0.exitBtn, 'the arena is on screen with the floating Leave button');
  check(!s0.dialog, 'the shop window is NOT open yet (it waits for a click on the keeper)');
  check(s0.pickables === 1 && s0.keeperKind === 'shopkeeper' && s0.isUnit === false, 'the keeper is a clickable Entity, not a unit');
  check(s0.mapId === 'wayside-hollow' && s0.radius === 3, `the arena is the shop's crafted map (${s0.mapId}, radius ${s0.radius})`);
  await page.screenshot({ path: path.join(OUT, 'shop-1-arena.png') });

  // ----- 3. click the keeper --------------------------------------------------
  // Project the keeper's body to the screen and click it.
  const pt = await page.evaluate(() => {
    const v = window.__localView; const body = v.pickables[0];
    const THREE_V = body.position.clone(); THREE_V.y += 0.5;
    THREE_V.project(v.camera);
    const r = v.domElement.getBoundingClientRect();
    return { x: r.left + (THREE_V.x + 1) / 2 * r.width, y: r.top + (1 - THREE_V.y) / 2 * r.height };
  });
  await page.mouse.move(pt.x, pt.y);
  await page.waitForTimeout(400);   // the hover resolves once per frame
  let hover = null;
  for (let i = 0; i < 10; i++) { hover = await page.evaluate(() => ({ hoverKey: window.__localView.hoverKey, cursor: window.__localView.domElement.style.cursor })); if (hover.cursor) break; await page.waitForTimeout(100); }
  check(hover.hoverKey === s0.keeperKey && hover.cursor === 'pointer', `hovering the keeper's body resolves to its tile with a hand cursor (${JSON.stringify(hover)})`);
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
  await page.waitForTimeout(300);
  check(await dialogOpen(), 'clicking the keeper opens the shop window');
  const win = await page.evaluate(() => ({
    title: document.getElementById('dialog-title').textContent,
    cards: [...document.querySelectorAll('#dialog .shop-card')].map((c) => ({ name: c.querySelector('.upg-name').textContent, icon: c.querySelector('.upg-icon').textContent, price: c.querySelector('.upg-unit').textContent, desc: c.querySelector('.upg-desc').textContent, disabled: c.classList.contains('disabled'), sold: c.classList.contains('sold') })),
    buttons: [...document.querySelectorAll('#dialog-actions button')].map((b) => b.textContent),
    wide: document.getElementById('dialog').classList.contains('dialog-wide'),
  }));
  console.log('  window:', JSON.stringify(win));
  check(win.title === 'Shop' && win.wide, 'the shop window is the wide card window');
  check(win.cards.length === 4 && win.cards.every((c) => c.icon && c.name && c.price && (c.desc || c.disabled)), 'one big card per option with icon, name, price and description');
  check(win.cards.find((c) => c.name === 'Spare Parts')?.disabled, 'Spare Parts is dimmed with nobody disabled');
  check(win.buttons.length === 1 && /Leave/.test(win.buttons[0]), 'one Leave button under the cards');
  await page.waitForTimeout(700);   // let the cards finish fading in
  await page.screenshot({ path: path.join(OUT, 'shop-2-window.png') });

  // ----- 4. a plain purchase: Information ------------------------------------
  const before = await page.evaluate(() => window.game.state.supplies);
  await page.evaluate(() => [...document.querySelectorAll('#dialog .shop-card')].find((c) => c.querySelector('.upg-name').textContent === 'Information').click());
  await page.waitForTimeout(300);
  const afterMap = await page.evaluate(() => ({
    supplies: window.game.state.supplies, open: !document.getElementById('dialog').classList.contains('hidden'),
    sold: [...document.querySelectorAll('#dialog .shop-card.sold .upg-name')].map((c) => c.textContent),
    inArena: window.__cinematic.mode() === 'local', shop: !!window.__shop,
  }));
  check(afterMap.supplies === before - 15, `Information bought (-15 supplies: ${before} -> ${afterMap.supplies})`);
  check(afterMap.open && afterMap.sold.includes('Information'), 'the window stays up and the card reads sold out');
  check(afterMap.inArena && afterMap.shop, 'still in the shop\'s arena');

  // ----- 5. Training: the chooser replaces the shop window and returns ------
  await page.evaluate(() => [...document.querySelectorAll('#dialog .shop-card')].find((c) => c.querySelector('.upg-name').textContent === 'Training').click());
  await page.waitForTimeout(300);
  const chooser = await page.evaluate(() => ({
    title: document.getElementById('dialog-title').textContent, cards: document.querySelectorAll('#dialog .upg-card:not(.shop-card)').length,
    shopCards: document.querySelectorAll('#dialog .shop-card').length, inArena: window.__cinematic.mode() === 'local',
  }));
  check(chooser.title !== 'Shop' && chooser.cards > 0 && chooser.shopCards === 0, `Training opened the upgrade chooser in place of the shop window (${chooser.title}, ${chooser.cards} offers)`);
  check(chooser.inArena, 'the chooser did not fly the party out');
  const upgBefore = await page.evaluate(() => window.game.state.party.reduce((n, u) => n + u.upgrades.length, 0));
  await page.evaluate(() => document.querySelector('#dialog .upg-card').click());
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({
    title: document.getElementById('dialog-title').textContent, shopCards: document.querySelectorAll('#dialog .shop-card').length,
    upgrades: window.game.state.party.reduce((n, u) => n + u.upgrades.length, 0), inArena: window.__cinematic.mode() === 'local',
    sold: [...document.querySelectorAll('#dialog .shop-card.sold .upg-name')].map((c) => c.textContent),
  }));
  check(back.upgrades === upgBefore + 1, 'the pick unlocked an upgrade');
  check(back.title === 'Shop' && back.shopCards === 4 && back.sold.includes('Training'), 'the shop window is back after the pick, Training sold');
  check(back.inArena, 'still in the arena');

  // ----- 6. Esc closes the window, the keeper reopens it, Leave flies out ----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(!(await dialogOpen()) && await page.evaluate(() => window.__cinematic.mode() === 'local'), 'Esc closes the window without leaving the arena');
  await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
  await page.waitForTimeout(300);
  check(await dialogOpen() && (await dialogTitle()) === 'Shop', 'the keeper reopens the window');
  await page.evaluate(() => [...document.querySelectorAll('#dialog-actions button')].find((b) => /Leave/.test(b.textContent)).click());
  await page.waitForFunction(() => window.__cinematic.mode() === 'idle', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const left = await page.evaluate(() => ({
    shop: !!window.__shop, enc: window.game.state.position.encounter, exitBtn: !document.getElementById('shop-exit').classList.contains('hidden'),
    dialog: !document.getElementById('dialog').classList.contains('hidden'), pickables: (window.__localView.pickables ?? []).length,
  }));
  check(!left.shop && !left.exitBtn && !left.dialog && left.pickables === 0, 'Leave tears the shop down and flies out');
  check(left.enc === 'shop', 'the shop stays on its tile (not sold out)');
  await page.screenshot({ path: path.join(OUT, 'shop-3-left.png') });

  // ----- 7. the menu's generic buttons on a hack -----------------------------
  await page.evaluate(() => { const g = window.game; g.state.position.encounter = 'hack'; g.emit('change'); });
  await page.waitForTimeout(200);
  await page.keyboard.press('e');
  await page.waitForFunction(() => !!window.__hack && window.__cinematic.mode() === 'local', null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const labels = await page.evaluate(() => ({ win: document.getElementById('btn-win-encounter')?.textContent, restart: document.getElementById('btn-restart-encounter')?.textContent, old: !!document.getElementById('btn-win-battle') }));
  check(labels.win === 'Win encounter' && labels.restart === 'Restart encounter' && !labels.old, `menu buttons read "encounter" (${labels.win} / ${labels.restart})`);
  // Wound a unit and advance a turn, then Restart encounter: same board, HP back, turn 1.
  const h0 = await page.evaluate(() => {
    const h = window.__hack; const u = h.state.units[0]; u.hp = 1; window.game.state.party[u.partyIndex].hp = 1;
    return { nodes: h.state.objects.filter((o) => o.kind === 'hackNode').map((o) => o.pos + ':' + o.hp).join('|'), hpFull: window.game.state.party[u.partyIndex].maxHp, idx: u.partyIndex };
  });
  await page.evaluate(() => window.__hack.endTurn());
  await page.waitForFunction(() => window.__hack.state.round === 2 && !window.__hack.state.busy, null, { timeout: 15000 });
  await page.evaluate(() => document.getElementById('btn-restart-encounter').click());
  await page.waitForTimeout(500);
  const h1 = await page.evaluate(() => {
    const h = window.__hack;
    return { round: h.state.round, nodes: h.state.objects.filter((o) => o.kind === 'hackNode').map((o) => o.pos + ':' + o.hp).join('|'), hp: window.game.state.party.map((u) => u.hp), bar: !!document.getElementById('hack-bar'), enc: window.game.state.position.encounter };
  });
  check(h1.round === 1 && h1.nodes === h0.nodes, 'Restart encounter rebuilt the same hack board at turn 1');
  check(h1.hp.every((hp) => hp > 1) && h1.bar && h1.enc === 'hack', `the wound was undone and the hack is still on (${JSON.stringify(h1.hp)})`);
  await page.evaluate(() => document.getElementById('btn-win-encounter').click());
  await page.waitForFunction(() => !window.__hack && !document.getElementById('dialog').classList.contains('hidden'), null, { timeout: 15000 });
  const won = await page.evaluate(() => ({ title: document.getElementById('dialog-title').textContent, enc: window.game.state.position.encounter }));
  check(/Hack complete/.test(won.title) && won.enc === null, `Win encounter won the hack (${won.title})`);
  await page.screenshot({ path: path.join(OUT, 'shop-4-hack-won.png') });

  await browser.close();
  if (problems.length) { console.log('\nPROBLEMS:'); for (const p of problems) console.log(' - ' + p); process.exit(1); }
  console.log('\nALL GOOD');
})();
