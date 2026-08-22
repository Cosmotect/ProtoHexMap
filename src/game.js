// Game rules and state. Pure data + logic, no rendering.
// The renderer and the HUD subscribe to "events" and redraw themselves.
import { createRng } from './rng.js';
import { generateMap } from './map.js';
import { hexKey, neighbors, hexesInRange, hexDistance } from './hex.js';
import { simulateBattle, makeEnemies } from './battle.js';
import { EVENTS, LORE_IDS } from './events.js';
import { t, tn } from './i18n.js';


export class Game {
  constructor(config, seed) {
    this.config = config;
    this.seed = seed;
    this.rng = createRng(seed);
    this.map = generateMap(config, this.rng);
    // Enemy groups are rolled up front for every battle tile, so the danger of a revealed
    // battle can be shown before the party enters it.
    for (const h of this.map.hexes.values()) {
      if (h.encounter === 'battle' || h.encounter === 'boss') {
        h.enemies = makeEnemies(this.rng, config.battle, h.ring, h.isBoss, lerpTable);
      }
    }

    const run = config.run;
    const pathLength = this.map.shortestPath.length - 1; // steps, not tiles
    const supplies = run.startSupplies;

    this.state = {
      status: 'playing',      // 'playing' | 'won' | 'lost'
      // The party: a fresh copy of the config units so HP can change per run.
      party: config.party.units.map((u) => ({ ...u, alive: true, isPlayer: true })),
      gold: run.startGold,
      supplies,
      maxSupplies: supplies,
      turn: 0,
      position: this.map.start,   // the hex the player stands on
      shortestPathLength: pathLength,
      // Fatigue: steps taken since the last encounter, and the resulting chance (%).
      fatigueSteps: 0,
      fatigue: 0,
      encountersCleared: 0,
      lastBattle: null,
      bossesDefeated: 0,
      pendingSupplies: null,   // { amount, source } waiting to be collected (overflow dialog)
      endReason: '',
    };

    this.log = [];
    this.listeners = [];
    this.pendingArrival = null;   // set while the guide holds what happens on the tile just reached

    this.map.start.visited = true;
    this.reveal(this.map.start.q, this.map.start.r, run.revealStartRadius, true);
    if (run.bossAlwaysVisible) for (const b of this.map.bosses) b.revealed = true;

    this.addLog('log.newRun', { seed, n: this.map.bosses.length, steps: pathLength });
  }

  // ----- events -------------------------------------------------------
  on(callback) {
    this.listeners.push(callback);
  }

  emit(type, payload = {}) {
    for (const cb of this.listeners) cb(type, payload, this);
  }

  // Log entries are stored as { key, params } and rendered in the current language.
  addLog(key, params = {}) {
    this.log.push({ turn: this.state.turn, key, params });
    if (this.log.length > 60) this.log.shift();
    this.emit('log', { key, params });
  }

  // ----- queries ------------------------------------------------------
  hexAt(q, r) {
    return this.map.hexes.get(hexKey(q, r));
  }

  // Hexes the player could step to right now.
  reachable() {
    if (this.state.status !== 'playing') return [];
    const { q, r } = this.state.position;
    const out = [];
    for (const [nq, nr] of neighbors(q, r)) {
      const h = this.hexAt(nq, nr);
      if (h && h.passable && h.supplyCost <= this.state.supplies) out.push(h);
    }
    return out;
  }

  canMoveTo(hex) {
    if (!hex || this.state.status !== 'playing') return false;
    const pos = this.state.position;
    if (hexDistance(pos.q, pos.r, hex.q, hex.r) !== 1) return false;
    if (!hex.passable) return false;
    if (hex.supplyCost > this.state.supplies) return false;
    return true;
  }

  // Supplies never exceed the maximum.
  addSupplies(n) {
    const s = this.state;
    const before = s.supplies;
    s.supplies = Math.max(0, Math.min(s.maxSupplies, s.supplies + n));
    return s.supplies - before;
  }

  // Every living unit loses HP (terrain damage). Units at 0 fall.
  damageParty(amount, reason) {
    const fallen = [];
    for (const u of this.livingUnits()) {
      u.hp = Math.max(0, u.hp - amount);
      if (u.hp === 0) { u.alive = false; fallen.push(u.name); }
    }
    if (fallen.length) this.addLog('log.disabledBy', { reason: { key: reason }, names: { names: fallen } });
  }

  // What the Enter button would do right now: { kind: 'encounter'|'camp'|'none', label, enabled, reason }
  enterAction() {
    const s = this.state;
    if (s.status !== 'playing') return { kind: 'none', label: t('status.enter'), enabled: false };
    const hex = s.position;
    if (hex.encounter) {
      return { kind: 'encounter', type: hex.encounter, label: t('status.enter.encounter', { label: this.labelFor(hex.encounter) }), enabled: true };
    }
    const cost = this.config.rest.cost;
    const enabled = s.supplies >= cost;
    return {
      kind: 'camp',
      label: t('status.camp', { cost }),
      enabled,
      reason: enabled ? '' : t('status.camp.short', { have: s.supplies, cost }),
    };
  }

  canEnter() {
    return this.enterAction().enabled;
  }

  // Fatigue % the party will have after one more step (the step raises it AFTER the
  // arrival roll, which uses the current value shown in the HUD).
  fatigueAfterNextStep() {
    return lerpTable(this.config.fatigue.byStep, this.state.fatigueSteps + 1);
  }

  // Fatigue rules from the config.
  isForceable(type) {
    return (this.config.fatigue.forceable ?? []).includes(type);
  }
  fatigueResetRule(type) {
    return this.config.fatigue.resetOn?.[type] ?? 'never';
  }
  fatigueResetNote(type) {
    return this.config.fatigue.resetOn?.[type] === 'optional' ? t(`reset.note.${type}`) : '';
  }

  // Chance (%) of being forced into something if the party steps onto `hex` now:
  // the CURRENT fatigue, and only if the tile holds (or may hide) a forceable encounter.
  // Returns null when the tile is revealed and cannot force anything.
  forcedChanceFor(hex) {
    const f = this.state.fatigue;
    if (!hex.revealed) return { chance: f };
    if (hex.encounter && this.isForceable(hex.encounter)) return { chance: f };
    return null;
  }

  livingUnits() { return this.state.party.filter((u) => u.alive); }

  // Danger rank of a battle tile: floor((enemy power - living party power) / 2), never
  // below 0. Shown as chevrons above the marker.
  dangerRank(hex) {
    if (!hex.enemies) return 0;
    const enemy = hex.enemies.reduce((a, e) => a + e.power, 0);
    const party = this.livingUnits().reduce((a, u) => a + u.power, 0);
    return Math.max(0, Math.floor((enemy - party) / 2));
  }
  deadUnits() { return this.state.party.filter((u) => !u.alive); }

  // ----- actions ------------------------------------------------------
  moveTo(hex) {
    if (!this.canMoveTo(hex)) return false;
    const from = this.state.position;
    const s = this.state;

    s.turn += 1;
    s.position = hex;
    hex.visited = true;

    // The arrival roll uses the fatigue you could see before stepping; then the step
    // raises it (every step, encounter or not).
    const rollChance = s.fatigue;
    s.fatigueSteps += 1;
    s.fatigue = lerpTable(this.config.fatigue.byStep, s.fatigueSteps);

    // Terrain costs (mountains): supplies and HP.
    if (hex.supplyCost > 0) s.supplies -= hex.supplyCost;

    const radius = this.config.run.revealRadius + (hex.revealBonus || 0);
    const newlyRevealed = this.reveal(hex.q, hex.r, radius, false);
    this.emit('move', { from, to: hex, newlyRevealed });

    const costs = [];
    if (hex.supplyCost > 0) costs.push(t('log.cost.supplies', { n: hex.supplyCost }));
    if (hex.hpCost > 0) costs.push(t('log.cost.hp', { n: hex.hpCost }));
    this.addLog('log.moved', { turn: s.turn, where: { hex: { terrain: hex.terrain, q: hex.q, r: hex.r, encounter: hex.encounter } }, fatigue: s.fatigue });
    if (costs.length) this.addLog('log.moved.costs', { costs: costs.join(', ') });
    if (hex.hpCost > 0) this.damageParty(hex.hpCost, 'log.climb');
    if (!this.livingUnits().length) {
      s.status = 'lost';
      s.endReason = ['log.perished', { turn: s.turn }];
      this.emit('end', { status: s.status });
      this.emit('change');
      return true;
    }
    // A listener (the guide) may ask to hold the arrival: what happens on this tile
    // (the fatigue roll, a forced encounter) then waits for resumeArrival().
    const arrival = { hex, rollChance, hold: false };
    this.emit('arrive', arrival);
    if (arrival.hold) {
      this.pendingArrival = arrival;
      this.emit('change');
      return true;
    }
    this.onEnter(hex, rollChance);
    this.checkEndOfRun();
    this.emit('change');
    return true;
  }

  // Continues an arrival that a listener held back (see moveTo).
  resumeArrival() {
    const a = this.pendingArrival;
    if (!a) return;
    this.pendingArrival = null;
    this.onEnter(a.hex, a.rollChance);
    this.checkEndOfRun();
    this.emit('change');
  }

  // What happens when stepping on a hex: the party is NOT pulled into the encounter
  // automatically, unless fatigue rolls against them.
  onEnter(hex, rollChance) {
    if (!hex.encounter) return;
    const label = this.labelFor(hex.encounter);
    if (this.isForceable(hex.encounter) && rollChance > 0 && this.rng.chance(rollChance / 100)) {
      this.addLog('log.forced', { label: { key: `visual.${hex.encounter}.label` }, chance: rollChance });
      this.emit('forced', { hex, type: hex.encounter, label, chance: rollChance });
      this.enter(true);
      return;
    }
    this.addLog('log.encounterHere', { label: { key: `visual.${hex.encounter}.label` } });
  }

  // The Enter button. "forced" = triggered by fatigue (enemies act first in battles).
  enter(forced = false) {
    const action = this.enterAction();
    if (!action.enabled) return false;
    if (action.kind === 'camp') return this.makeCamp();

    const hex = this.state.position;
    const type = hex.encounter;
    const label = this.labelFor(type);
    this.addLog(forced ? 'log.forcedInto' : 'log.entered', { label: { key: `visual.${type}.label` } });

    switch (type) {
      case 'battle':
      case 'boss':
        return this.resolveBattle(hex, forced);
      case 'treasure': {
        this.consume(hex, type, forced);
        this.offerSupplies(this.config.treasure.supplies, 'treasure.title', 'treasure.text');
        return true;
      }
      case 'event': {
        const weights = {};
        EVENTS.forEach((e, i) => { weights[i] = e.weight ?? 1; });
        const ev = EVENTS[Number(this.rng.weighted(weights))];
        this.addLog('log.event', { title: { key: `event.${ev.id}.title` } });
        this.consume(hex, type, forced);
        this.applyEvent(ev, forced);
        return true;
      }
      case 'shop':
        // The shop stays on the tile and can be revisited. Buying happens via shopBuy().
        this.emit('dialog', { kind: 'shop' });
        this.emit('change');
        return true;
      case 'acolyte': {
        if (!this.deadUnits().length) {
          this.addLog('log.acolyteNothing');
          this.emit('change');
          return false;
        }
        this.emit('dialog', { kind: 'acolyte' });
        return true;
      }
      default:
        this.addLog('log.noLogic', { label: { key: `visual.${type}.label` } });
        this.consume(hex, type, forced);
        return true;
    }
  }

  // Removes the encounter from the tile and applies the fatigue rule.
  consume(hex, type, forced) {
    hex.encounter = null;
    this.state.encountersCleared += 1;
    if (this.fatigueResetRule(type) === 'always') this.resetFatigue();
    this.emit('encounter', { hex, type, forced });
    this.emit('change');
  }

  resetFatigue() {
    this.state.fatigueSteps = 0;
    this.state.fatigue = 0;
  }

  // ----- rest site ----------------------------------------------------
  makeCamp() {
    const s = this.state;
    const cost = this.config.rest.cost;
    if (s.position.encounter || s.supplies < cost) return false;
    s.supplies -= cost;
    this.addLog('log.camp', { cost });
    this.applyRest();
    this.resetFatigue();
    this.emit('camp', {});
    this.emit('change');
    return true;
  }

  applyRest() {
    const f = this.config.rest.healFraction;
    const healed = [];
    for (const u of this.livingUnits()) {
      const before = u.hp;
      u.hp = Math.min(u.maxHp, u.hp + Math.round(u.maxHp * f));
      if (u.hp !== before) healed.push({ key: 'log.rest.item', params: { name: { name: u.name }, n: u.hp - before } });
    }
    if (healed.length) this.addLog('log.rest', { list: { list: healed } });
    else this.addLog('log.rest.full');
  }

  // ----- acolyte --------------------------------------------------------
  restoreUnit(index) {
    const u = this.state.party[index];
    const hex = this.state.position;
    if (!u || u.alive || hex.encounter !== 'acolyte') return false;
    u.alive = true;
    u.hp = Math.max(1, Math.round(u.maxHp * this.config.acolyte.reviveFraction));
    this.addLog('log.restored', { name: { name: u.name }, hp: u.hp });
    this.consume(hex, 'acolyte', false);
    return true;
  }

  // ----- shop ---------------------------------------------------------
  shopBuy(item, unitIndex) {
    const s = this.state;
    const shop = this.config.shop;
    if (s.position.encounter !== 'shop' || s.status !== 'playing') return false;
    if (item === 'rest') {
      if (s.supplies < shop.restCost) { this.addLog('log.shop.noRest'); return false; }
      s.supplies -= shop.restCost;
      this.resetFatigue();
      this.addLog('log.shop.rested', { cost: shop.restCost });
    } else if (item === 'map') {
      if (s.supplies < shop.mapCost) { this.addLog('log.shop.noMap'); return false; }
      s.supplies -= shop.mapCost;
      const n = this.revealBlob(this.config.events.blobSize, this.config.events.blobMaxDistance);
      this.addLog('log.shop.map', { cost: shop.mapCost, n });
    } else if (item === 'upgrade') {
      const u = s.party[unitIndex];
      if (!u) return false;
      if (s.supplies < shop.upgradeCost) { this.addLog('log.shop.noUpgrade'); return false; }
      s.supplies -= shop.upgradeCost;
      u.power += shop.upgradeAmount;
      this.addLog('log.shop.upgraded', { name: { name: u.name }, power: u.power, cost: shop.upgradeCost });
    } else {
      return false;
    }
    this.emit('change');
    return true;
  }

  // ----- battle ---------------------------------------------------------
  resolveBattle(hex, forced, opts = {}) {
    const s = this.state;
    const enemies = hex.enemies ?? makeEnemies(this.rng, this.config.battle, hex.ring, hex.isBoss, lerpTable);
    hex.enemies = null;
    const result = simulateBattle(this.rng, this.config.battle, s.party, enemies, !forced);
    result.enemies = enemies;
    result.boss = hex.isBoss;
    result.title = enemies.title || null;
    s.lastBattle = result;

    const who = { list: enemies.map((e) => ({ key: 'log.battle.enemy', params: { name: { name: e.name }, hp: e.maxHp, power: e.power } })) };
    const first = { key: forced ? 'log.battle.enemiesFirst' : 'log.battle.partyFirst' };
    if (enemies.title) this.addLog('log.battle.boss', { title: { name: enemies.title }, who, first });
    else this.addLog('log.battle', { who, first });
    for (const d of result.deaths) {
      if (s.party.includes(d)) this.addLog('log.unitDisabled', { name: { name: d.name } });
    }
    this.addLog(result.won ? 'log.victory' : 'log.defeat', { n: result.rounds });

    if (!opts.alreadyConsumed) this.consume(hex, hex.encounter, forced);
    else this.resetFatigue();
    this.emit('dialog', { kind: 'battle', result, intro: opts.intro });

    if (!result.won) {
      s.status = 'lost';
      s.endReason = ['end.fell', { turn: s.turn }];
      this.emit('end', { status: s.status });
    } else {
      if (hex.isBoss) {
        s.bossesDefeated += 1;
        const total = this.map.bosses.length;
        const done = this.config.run.winCondition === 'any' || s.bossesDefeated >= total;
        if (done) {
          s.status = 'won';
          s.endReason = ['end.bosses', { done: s.bossesDefeated, total, turn: s.turn, enc: s.encountersCleared }];
          this.addLog('log.allBosses');
          this.emit('end', { status: s.status });
        } else {
          this.addLog('log.bossDown', { done: s.bossesDefeated, total });
        }
      }
      // Victory reward: +power to a unit of the player's choice (handled by the dialog).
      if (this.config.battle.victoryPower > 0 && this.livingUnits().length) {
        result.reward = this.config.battle.victoryPower;
      }
    }
    this.emit('change');
    return true;
  }

  // ----- event effects ---------------------------------------------------
  // Applies the effect of an event and opens the dialog (text + effect line).
  applyEvent(ev, forced) {
    const cfg = this.config.events;
    const pos = this.state.position;
    const hexes = [...this.map.hexes.values()];
    // Reveal effects only ever touch tiles the player has not uncovered yet; when nothing
    // hidden is left in range, they look further out, and only then report "nothing".
    const hidden = (pred) => hexes.filter((h) => !h.revealed && pred(h));
    let effect = '';
    let title = t(`event.${ev.id}.title`);
    let text = t(`event.${ev.id}.text`);

    switch (ev.effect) {
      case 'revealShop': {
        const shops = hidden((h) => h.encounter === 'shop');
        if (shops.length) {
          const shop = this.nearest(shops, pos);
          this.revealHexes([shop]);
          effect = t('effect.shopMarked', { n: this.distanceFrom(shop) });
        } else {
          effect = t('effect.shopKnown');
        }
        break;
      }
      case 'revealBlob': {
        const n = this.revealBlob(cfg.blobSize, cfg.blobMaxDistance);
        effect = n ? t('effect.blob', { n }) : t('effect.blob.none');
        break;
      }
      case 'revealBattles': {
        const near = hidden((h) => h.encounter === 'battle' && this.distanceFrom(h) <= cfg.rumorsRadius);
        if (near.length) {
          const picked = this.shuffle(near).slice(0, cfg.rumorsCount);
          this.revealHexes(picked);
          effect = t('effect.battles', { n: picked.length, r: cfg.rumorsRadius });
        } else {
          // Nothing hidden within range: point to the nearest hidden battles anywhere.
          const far = hidden((h) => h.encounter === 'battle').sort((a, b) => this.distanceFrom(a) - this.distanceFrom(b)).slice(0, cfg.rumorsCount);
          this.revealHexes(far);
          effect = far.length ? t('effect.battles.far', { n: far.length }) : t('effect.battles.none');
        }
        break;
      }
      case 'vantage': {
        const list = hidden((h) =>
          this.distanceFrom(h) <= cfg.vantageRadius ||
          (h.terrain === 'mountain' && this.distanceFrom(h) <= cfg.vantageMountainRadius));
        this.revealHexes(list);
        effect = t('effect.vantage', { r: cfg.vantageRadius, m: cfg.vantageMountainRadius, n: list.length });
        break;
      }
      case 'supplies': {
        const n = this.rng.int(cfg.suppliesMin, cfg.suppliesMax);
        this.offerSupplies(n, `event.${ev.id}.title`, `event.${ev.id}.text`);
        return;
      }
      case 'power': {
        const living = this.livingUnits();
        if (living.length) {
          const u = this.rng.pick(living);
          u.power += cfg.scholarPower;
          effect = t('effect.power', { name: tn(u.name), n: cfg.scholarPower, power: u.power });
        } else {
          effect = t('effect.power.none');
        }
        break;
      }
      case 'revealAcolyte': {
        const acs = hidden((h) => h.encounter === 'acolyte');
        if (acs.length) {
          const a = this.nearest(acs, pos);
          this.revealHexes([a]);
          effect = t('effect.acolyteMarked', { n: this.distanceFrom(a) });
        } else {
          effect = t('effect.acolyteKnown');
        }
        break;
      }
      case 'blackMarket': {
        // The choice happens in the UI; game.blackMarketDeal(index) applies it.
        effect = t('effect.blackMarket', { n: cfg.blackMarketPower });
        this.addLog('log.effect', { effect });
        this.emit('dialog', { kind: 'blackmarket', title, text, effect });
        return;
      }
      case 'battle': {
        // Same as a battle encounter on this tile. The dialog shows the story first.
        this.resolveBattle(pos, forced, { alreadyConsumed: true, intro: { title, text } });
        return;
      }
      case 'rest': {
        this.applyRest();
        this.resetFatigue();
        effect = t('effect.rest', { pct: `${Math.round(this.config.rest.healFraction * 100)}%` });
        break;
      }
      case 'lore':
      default: {
        const id = this.rng.pick(LORE_IDS);
        title = t('lore.combined', { event: title, lore: t(`lore.${id}.title`) });
        text = t(`lore.${id}.text`);
        effect = t('effect.lore');
      }
    }
    if (effect) this.addLog('log.effect', { effect });
    this.emit('change');
    this.emit('dialog', { kind: 'event', title, text, effect });
  }

  // Supplies found in the field. If they would overflow the maximum, the dialog offers
  // to make camp first (spending supplies) so more of the find fits.
  // titleKey / textKey are locale keys.
  offerSupplies(amount, titleKey, textKey) {
    const s = this.state;
    const room = s.maxSupplies - s.supplies;
    const overflow = Math.max(0, amount - room);
    s.pendingSupplies = { amount, titleKey };
    const campCost = this.config.rest.cost;
    const canCamp = overflow > 0 && !s.position.encounter && s.supplies >= campCost;
    const effect = overflow > 0
      ? t('effect.supplies.overflow', { n: amount, room, lost: overflow })
      : t('effect.supplies', { n: amount });
    this.addLog('log.find', { title: { key: titleKey }, effect });
    this.emit('change');
    this.emit('dialog', { kind: 'supplies', title: t(titleKey), titleKey, text: t(textKey), effect, amount, overflow, canCamp, campCost });
  }

  // Called by the dialog: optionally make camp, then take the find.
  claimSupplies(campFirst) {
    const s = this.state;
    const p = s.pendingSupplies;
    if (!p) return false;
    if (campFirst) this.makeCamp();
    s.pendingSupplies = null;
    const got = this.addSupplies(p.amount);
    this.addLog(got < p.amount ? 'log.collected.partial' : 'log.collected', { got, amount: p.amount });
    this.emit('change');
    return true;
  }

  // Called by the dialog after a won battle.
  grantVictoryPower(index) {
    const u = this.state.party[index];
    const n = this.config.battle.victoryPower;
    if (!u || !u.alive || !n) return false;
    u.power += n;
    this.addLog('log.learned', { name: { name: u.name }, n, power: u.power });
    this.emit('change');
    return true;
  }

  blackMarketDeal(index) {
    const u = this.state.party[index];
    const cfg = this.config.events;
    if (!u || !u.alive) return false;
    const loss = Math.max(1, Math.round(u.maxHp * cfg.blackMarketHpFraction));
    u.maxHp = Math.max(1, u.maxHp - loss);
    u.hp = Math.min(u.hp, u.maxHp);
    u.power += cfg.blackMarketPower;
    this.addLog('log.blackMarket', { name: { name: u.name }, loss, n: cfg.blackMarketPower, power: u.power });
    this.emit('change');
    return true;
  }

  // ----- reveal helpers ---------------------------------------------------
  distanceFrom(hex) {
    const p = this.state.position;
    return hexDistance(p.q, p.r, hex.q, hex.r);
  }

  nearest(list, from) {
    let best = null, bestD = Infinity;
    for (const h of list) {
      const d = hexDistance(from.q, from.r, h.q, h.r);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  revealHexes(list) {
    const newly = [];
    for (const h of list) {
      if (h && !h.revealed) { h.revealed = true; newly.push(h); }
    }
    if (newly.length) this.emit('reveal', { hexes: newly });
    return newly;
  }

  // Reveals an irregular patch of `size` hidden tiles, grown from a random hidden tile
  // within `maxDistance` of the party. Returns how many tiles were revealed.
  revealBlob(size, maxDistance) {
    const hidden = [...this.map.hexes.values()].filter((h) => !h.revealed && this.distanceFrom(h) <= maxDistance);
    if (!hidden.length) return 0;
    const seed = this.rng.pick(hidden);
    const chosen = new Set([seed.key]);
    let frontier = [seed];
    while (chosen.size < size && frontier.length) {
      // Grow from a random tile on the frontier, so the patch comes out lumpy.
      const cur = frontier[Math.floor(this.rng.random() * frontier.length)];
      const options = neighbors(cur.q, cur.r)
        .map(([q, r]) => this.hexAt(q, r))
        .filter((h) => h && !h.revealed && !chosen.has(h.key));
      if (!options.length) { frontier = frontier.filter((f) => f !== cur); continue; }
      const next = this.rng.pick(options);
      chosen.add(next.key);
      frontier.push(next);
    }
    return this.revealHexes([...chosen].map((k) => this.map.hexes.get(k))).length;
  }

  labelFor(type) {
    return t(`visual.${type}.label`);
  }

  checkEndOfRun() {
    const s = this.state;
    if (s.status !== 'playing') return;
    if (this.reachable().length === 0) {
      s.status = 'lost';
      s.endReason = ['log.stuck', { turn: s.turn }];
      this.addLog('log.stuck', { turn: s.turn });
      this.emit('end', { status: s.status });
    }
  }

  // Uncovers hexes within "radius" of (q, r). Returns the list of hexes that were hidden before.
  // A tile is revealed when its distance <= radius + its terrainHeight (tall terrain is
  // visible from further away).
  reveal(q, r, radius, silent) {
    const newly = [];
    const maxH = Math.max(0, ...Object.values(this.config.terrain).map((t) => t.terrainHeight ?? 0));
    for (const [hq, hr] of hexesInRange(q, r, radius + maxH)) {
      const h = this.hexAt(hq, hr);
      if (!h || h.revealed) continue;
      const d = hexDistance(q, r, hq, hr);
      if (d <= radius + (h.terrainHeight ?? 0)) {
        h.revealed = true;
        newly.push(h);
      }
    }
    if (!silent && newly.length) this.emit('reveal', { hexes: newly });
    return newly;
  }

  // Debug helper for designers: lift the fog everywhere.
  revealAll() {
    const newly = [];
    for (const h of this.map.hexes.values()) {
      if (!h.revealed) { h.revealed = true; newly.push(h); }
    }
    if (newly.length) this.emit('reveal', { hexes: newly });
    this.addLog('log.debugReveal');
    this.emit('change');
  }
}

// Generic "table with interpolation" lookup, used for fatigue and enemy scaling.
// Keys are numbers (e.g. step or ring), values are numbers. Missing keys are
// interpolated linearly between the nearest entries; keys below the first /
// above the last entry are clamped to that entry.
export function lerpTable(byStep, step) {
  const keys = Object.keys(byStep).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (keys.length === 0) return 0;
  if (step <= keys[0]) return round1(byStep[keys[0]]);
  if (step >= keys[keys.length - 1]) return round1(byStep[keys[keys.length - 1]]);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (step >= a && step <= b) {
      const t = (step - a) / (b - a);
      return round1(byStep[a] + (byStep[b] - byStep[a]) * t);
    }
  }
  return 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function describeHex(hex) {
  const enc = hex.encounter ? t('hover.encounterSuffix', { label: t(`visual.${hex.encounter}.label`) }) : '';
  return `${t(`terrain.${hex.terrain}`)} (${hex.q},${hex.r})${enc}`;
}
