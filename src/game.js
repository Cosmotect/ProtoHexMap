// Game rules and state. Pure data + logic, no rendering.
// The renderer and the HUD subscribe to "events" and redraw themselves.
import { createRng } from './rng.js';
import { generateMap, setType } from './map.js';
import { hexKey, neighbors, hexesInRange, hexDistance } from './hex.js';
import { simulateBattle, makeEnemies, makeRegulars, renameDuplicates } from './battle.js';
import { EVENTS, LORE_IDS } from './events.js';
import { t, tn } from './i18n.js';

// How many flavour (lore) lines each window can draw from. The lines themselves live
// in the locale tables as flavour.<kind>.<n>; one is picked per window, seeded.
const FLAVOUR_POOL = { battle: 4, treasure: 4, shop: 3, acolyte: 3, camp: 3 };


export class Game {
  constructor(config, seed) {
    this.config = config;
    this.seed = seed;
    this.rng = createRng(seed);
    this.map = generateMap(config, this.rng);
    // Enemy groups are rolled up front for every battle tile, so the danger of a revealed
    // battle can be shown before the party enters it.
    for (const h of this.map.hexes.values()) {
      if (h.encounter === 'battle' || h.encounter === 'stasisSeed') {
        h.enemies = makeEnemies(this.rng, config.battle, h.ring, h.isSeed, lerpTable);
      }
    }

    // The Stasis: one line per future Colony grows from the Seed every turn; the
    // Colony spawns when its line arrives. Each Colony rolls its debuff up front
    // (seeded), duplicates allowed - they stack on the Seed fight.
    const debuffIds = Object.keys(config.stasis.debuffs);
    this.stasis = {
      seed: this.map.seed,
      colonies: this.map.colonies.map((hex) => ({
        hex,
        distance: hexDistance(this.map.seed.q, this.map.seed.r, hex.q, hex.r),
        progress: 0,
        active: false,
        cleared: false,
        debuff: this.rng.pick(debuffIds),
      })),
      witherCharge: new Map(),   // source hex key -> accumulated wither charge
    };

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
      coloniesCleared: 0,
      pendingSupplies: null,   // { amount, source } waiting to be collected (overflow dialog)
      endReason: '',
    };

    this.log = [];
    this.listeners = [];
    this.pendingArrival = null;   // set while the guide holds what happens on the tile just reached

    this.map.start.visited = true;
    this.reveal(this.map.start.q, this.map.start.r, run.revealStartRadius, true);
    if (run.seedAlwaysVisible) this.map.seed.revealed = true;

    this.addLog('log.newRun', { seed, n: this.map.colonies.length, steps: pathLength });
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
  // below 0. Shown as chevrons above the marker. On Stasis tiles the active debuffs
  // are counted in when they change either side's total power (party power loss,
  // extra enemies); the max-HP debuff does not move power, so it is not shown here.
  dangerRank(hex) {
    if (!hex.enemies) return 0;
    const living = this.livingUnits();
    let enemy = hex.enemies.reduce((a, e) => a + e.power, 0);
    let party = living.reduce((a, u) => a + u.power, 0);
    const cfgDebuffs = this.config.stasis.debuffs;
    for (const id of this.activeDebuffsFor(hex)) {
      if (id === 'power') party -= cfgDebuffs.power.amount * living.length;
      else if (id === 'extraEnemies') {
        const extraPower = Math.round(lerpTable(this.config.battle.enemies.powerByRing, hex.ring));
        enemy += cfgDebuffs.extraEnemies.count * extraPower;
      }
    }
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
    this.addLog('log.moved', { turn: s.turn, where: { hex: { type: hex.type, biome: hex.biome, q: hex.q, r: hex.r, encounter: hex.encounter } }, fatigue: s.fatigue });
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
    // The Stasis acts only AFTER the arrival is fully resolved, so a Colony can
    // never spawn under the player's feet in the same instant they step on it.
    this.advanceStasis();
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
    this.advanceStasis();
    this.checkEndOfRun();
    this.emit('change');
  }

  // ----- the Stasis -----------------------------------------------------
  // Runs once per player turn, after the arrival: lines grow, Colonies spawn,
  // the land withers around the Seed and every active Colony.
  advanceStasis() {
    if (this.state.status !== 'playing') return;
    const st = this.config.stasis;

    // 1. Lines grow towards the future Colonies.
    for (const c of this.stasis.colonies) {
      if (c.active || c.cleared) continue;
      c.progress = Math.min(c.distance, c.progress + st.lineSpeed);
      if (c.progress >= c.distance) this.spawnColony(c);
    }

    // 2. Withering: every source gains 1/witherEvery charge per turn and spends
    //    whole charges on turning nearby tiles into wither.
    const sources = [];
    if (this.stasis.seed.encounter === 'stasisSeed') sources.push(this.stasis.seed);
    for (const c of this.stasis.colonies) if (c.active && !c.cleared) sources.push(c.hex);
    const withered = [];
    for (const src of sources) {
      let charge = (this.stasis.witherCharge.get(src.key) ?? 0) + 1 / st.witherEvery;
      while (charge >= 1) {
        charge -= 1;
        const h = this.witherNear(src);
        if (h) withered.push(h);
      }
      this.stasis.witherCharge.set(src.key, charge);
    }
    if (withered.length) this.emit('wither', { hexes: withered });
    this.emit('stasis', {});
  }

  spawnColony(c) {
    c.active = true;
    c.hex.encounter = 'stasisColony';
    c.hex.enemies = makeEnemies(this.rng, this.config.battle, c.hex.ring, true, lerpTable);
    this.addLog('log.colonySpawn', {
      where: { hex: { type: c.hex.type, biome: c.hex.biome, q: c.hex.q, r: c.hex.r } },
      debuff: { key: `debuff.${c.debuff}.name` },
    });
    this.emit('colony', { hex: c.hex });
  }

  // Turns one nearby non-wither tile into wither terrain. There is no range limit:
  // the rot always takes a tile on its current front (the closest untouched land,
  // with one ring of slack for a ragged edge), so left alone it eventually swallows
  // the whole map. Only the Seed and Colony sites are spared - they are the sources.
  // A tile that withers loses whatever encounter stood on it.
  witherNear(src) {
    let bestD = Infinity;
    const all = [];
    for (const h of this.map.hexes.values()) {
      if (h.type === 'wither' || h.isSeed || h.isColony) continue;
      const d = hexDistance(src.q, src.r, h.q, h.r);
      all.push([h, d]);
      if (d < bestD) bestD = d;
    }
    if (!all.length) return null;
    const front = all.filter(([, d]) => d <= bestD + 1).map(([h]) => h);
    const h = this.rng.pick(front);
    setType(h, 'wither', this.config);
    if (h.encounter) {
      const type = h.encounter;
      h.encounter = null;
      h.enemies = null;
      if (h.revealed) this.addLog('log.witherConsumed', { label: { key: `visual.${type}.label` } });
      this.emit('encounter', { hex: h, type, forced: false, withered: true });
    }
    return h;
  }

  // Debuffs that would apply to a fight on `hex` right now.
  // The Seed carries the debuff of every active Colony (stacking); a Colony
  // carries only its own.
  activeDebuffsFor(hex) {
    if (hex.isSeed) {
      return this.stasis.colonies.filter((c) => c.active && !c.cleared).map((c) => c.debuff);
    }
    if (hex.isColony) {
      const c = this.stasis.colonies.find((c2) => c2.hex === hex);
      return c && c.active && !c.cleared ? [c.debuff] : [];
    }
    return [];
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
      case 'stasisSeed':
      case 'stasisColony':
        return this.resolveBattle(hex, forced);
      case 'treasure': {
        this.consume(hex, type, forced);
        this.offerSupplies(this.config.treasure.supplies, 'treasure.title', 'treasure.text', 'treasure');
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
        this.emit('dialog', { kind: 'shop', lore: this.pickFlavour('shop') });
        this.emit('change');
        return true;
      case 'acolyte': {
        if (!this.deadUnits().length) {
          this.addLog('log.acolyteNothing');
          this.emit('change');
          return false;
        }
        this.emit('dialog', { kind: 'acolyte', lore: this.pickFlavour('acolyte') });
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
    this.addLog(this.pickFlavour('camp'));
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
    const isStasis = hex.isSeed || hex.isColony;
    const enemies = hex.enemies ?? makeEnemies(this.rng, this.config.battle, hex.ring, isStasis, lerpTable);
    hex.enemies = null;

    // Stasis debuffs: temporarily weaken the party and/or reinforce the enemy for
    // this one fight. Damage taken stays after the fight; max HP and power come back.
    const debuffs = this.activeDebuffsFor(hex);
    const cfgDebuffs = this.config.stasis.debuffs;
    const saved = s.party.map((u) => ({ maxHp: u.maxHp, power: u.power }));
    for (const id of debuffs) {
      if (id === 'maxHp') {
        for (const u of s.party) {
          u.maxHp = Math.max(1, Math.round(u.maxHp * (1 - cfgDebuffs.maxHp.fraction)));
          u.hp = Math.min(u.hp, u.maxHp);
        }
      } else if (id === 'power') {
        for (const u of s.party) u.power -= cfgDebuffs.power.amount;
      } else if (id === 'extraEnemies') {
        enemies.push(...makeRegulars(this.rng, this.config.battle, hex.ring, cfgDebuffs.extraEnemies.count, lerpTable));
        renameDuplicates(enemies);
      }
    }
    if (debuffs.length) {
      this.addLog('log.debuffs', { list: { list: debuffs.map((id) => ({ key: `debuff.${id}.name` })) } });
    }

    const result = simulateBattle(this.rng, this.config.battle, s.party, enemies, !forced);

    // Undo the temporary debuffs (wounds and deaths remain).
    for (let i = 0; i < s.party.length; i++) {
      const u = s.party[i];
      u.maxHp = saved[i].maxHp;
      u.power = saved[i].power;
      u.hp = Math.min(u.hp, u.maxHp);
    }

    result.enemies = enemies;
    result.stasis = isStasis;
    result.seedFight = hex.isSeed;
    result.colonyFight = hex.isColony;
    result.debuffs = debuffs;
    result.title = enemies.title || null;
    s.lastBattle = result;

    const who = { list: enemies.map((e) => ({ key: 'log.battle.enemy', params: { name: { name: e.name }, hp: e.maxHp, power: e.power } })) };
    const first = { key: forced ? 'log.battle.enemiesFirst' : 'log.battle.partyFirst' };
    if (enemies.title) this.addLog('log.battle.stasis', { title: { name: enemies.title }, who, first });
    else this.addLog('log.battle', { who, first });
    for (const d of result.deaths) {
      if (s.party.includes(d)) this.addLog('log.unitDisabled', { name: { name: d.name } });
    }
    this.addLog(result.won ? 'log.victory' : 'log.defeat', { n: result.rounds });

    // The victory reward is decided BEFORE the dialog goes out: the window reads it
    // while it is being built (a regression once hid the power-up chooser because the
    // reward was only set after the dialog event fired).
    if (result.won && this.config.battle.victoryPower > 0 && this.livingUnits().length) {
      result.reward = this.config.battle.victoryPower;
      // Clearing a Colony grants several picks (config.stasis.rewardPicks).
      result.rewardPicks = hex.isColony ? this.config.stasis.rewardPicks : 1;
    }
    if (result.won) result.lore = this.pickFlavour('battle');
    // Winners salvage supplies from the field (battle and Stasis fights alike).
    if (result.won && (this.config.battle.victorySupplies ?? 0) > 0) {
      const n = this.config.battle.victorySupplies;
      result.supplies = this.addSupplies(n);
      result.suppliesFull = n;
      this.addLog('log.victorySupplies', { got: result.supplies, n });
    }

    if (!opts.alreadyConsumed) this.consume(hex, hex.encounter, forced);
    else this.resetFatigue();
    this.emit('dialog', { kind: 'battle', result, intro: opts.intro });

    if (!result.won) {
      s.status = 'lost';
      s.endReason = ['end.fell', { turn: s.turn }];
      this.emit('end', { status: s.status });
    } else {
      if (hex.isSeed) {
        // Win condition: the Stasis Seed is destroyed.
        s.status = 'won';
        s.endReason = ['end.seed', { turn: s.turn, enc: s.encountersCleared, colonies: s.coloniesCleared }];
        this.addLog('log.seedDown');
        this.emit('end', { status: s.status });
      } else if (hex.isColony) {
        const c = this.stasis.colonies.find((c2) => c2.hex === hex);
        if (c) { c.cleared = true; c.active = false; }
        s.coloniesCleared += 1;
        this.addLog('log.colonyDown', {
          done: s.coloniesCleared,
          total: this.stasis.colonies.length,
          debuff: { key: `debuff.${c?.debuff}.name` },
        });
        this.emit('stasis', {});
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
          (h.type === 'mountain' && this.distanceFrom(h) <= cfg.vantageMountainRadius));
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
  // titleKey / textKey are locale keys; flavourKind adds a lore line (see FLAVOUR_POOL).
  offerSupplies(amount, titleKey, textKey, flavourKind) {
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
    this.emit('dialog', {
      kind: 'supplies', title: t(titleKey), titleKey, text: t(textKey), effect,
      amount, overflow, canCamp, campCost,
      lore: flavourKind ? this.pickFlavour(flavourKind) : null,
    });
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

  // A locale key for one flavour line of the given kind (see FLAVOUR_POOL).
  pickFlavour(kind) {
    return `flavour.${kind}.${this.rng.int(1, FLAVOUR_POOL[kind] ?? 1)}`;
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
    const maxH = Math.max(0, ...Object.values(this.config.tileTypes).map((t) => t.terrainHeight ?? 0));
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
  // Land types read as "Grasslands Ground"; water / ether / wither ignore the biome.
  const tinted = hex.type === 'ground' || hex.type === 'hill' || hex.type === 'mountain';
  const name = tinted ? t('hover.tile', { biome: t(`biome.${hex.biome}`), type: t(`terrain.${hex.type}`) }) : t(`terrain.${hex.type}`);
  return `${name} (${hex.q},${hex.r})${enc}`;
}
