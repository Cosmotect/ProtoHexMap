// Game rules and state. Pure data + logic, no rendering.
// The renderer and the HUD subscribe to "events" and redraw themselves.
import { createRng } from './rng.js';
import { generateMap, setType, setBiome } from './map.js';
import { buildScenarioMap, cloneEnemies } from './scenarios/scenario.js';
import { hexKey, neighbors, hexesInRange, hexDistance } from './hex.js';
import { simulateBattle, makeEnemies, makeRegulars, renameDuplicates } from './battle.js';
import { availableUpgrades, unlockUpgrade, upgradeCount } from './upgrades.js';
import { EVENTS } from './events.js';
import { t, tn } from './i18n.js';

// How many flavour (lore) lines each window can draw from. The lines themselves live
// in the locale tables as flavour.<kind>.<n>; one is picked per window, seeded.
const FLAVOUR_POOL = { battle: 4, combatIntro: 6, treasure: 4, shop: 13, acolyte: 3, camp: 3 };


export class Game {
  // `scenario` switches the run into SCENARIO MODE (src/scenarios/): the map is
  // built from the scenario's data instead of the generator, and every roll the
  // script covers (forced fights, event picks, enemy groups) is read from it.
  // `layer` is which layer of the worldflake the run happens on (config.layers;
  // main.js passes the start screen's selection - for now it only recolours the
  // biomes, see map.js biomeColorFor).
  constructor(config, seed, scenario = null, layer = null) {
    this.config = config;
    this.seed = seed;
    this.scenario = scenario;
    this.layer = layer ?? config.layers?.startLayer ?? 4;
    this.scenarioState = { ambushesDone: new Set() };   // runtime; scenario data stays untouched
    this.rng = createRng(seed);
    this.map = scenario ? buildScenarioMap(config, scenario) : generateMap(config, this.rng, this.layer);
    this.map.layer = this.layer;
    // Enemy groups are rolled up front for every battle tile, so the danger of a revealed
    // battle can be shown before the party enters it. (Scenario battles come authored.)
    for (const h of this.map.hexes.values()) {
      if ((h.encounter === 'battle' || h.encounter === 'stasisSeed') && !h.enemies) {
        h.enemies = makeEnemies(this.rng, config.battle, h.ring, h.isSeed ? 'boss' : 'regular');
      }
    }

    // The Stasis: one line per future Colony grows from the Seed every turn; the
    // Colony spawns when its line arrives. Each Colony rolls its debuff up front
    // (seeded), duplicates allowed - they stack on the Seed fight.
    // (A scenario without a scripted Stasis has map.seed = null and no colonies;
    // advanceStasis then does nothing.)
    const debuffIds = Object.keys(config.stasis.debuffs);
    this.stasis = {
      seed: this.map.seed,
      colonies: (this.map.colonies ?? []).map((hex, i) => {
        // A scripted Stasis (scenario.stasis.colonies[i]) fixes the arrival
        // turn (distance walked at lineSpeed 1), the debuff and the garrison.
        const script = scenario?.stasis?.colonies?.[i] ?? null;
        return {
          hex,
          distance: script?.arriveTurn ?? hexDistance(this.map.seed.q, this.map.seed.r, hex.q, hex.r),
          progress: 0,
          active: false,
          cleared: false,
          debuff: script?.debuff ?? this.rng.pick(debuffIds),
          script,
        };
      }),
      witherCharge: new Map(),   // source hex key -> accumulated wither charge
    };

    const run = config.run;
    const pathLength = this.map.shortestPath.length - 1; // steps, not tiles
    const supplies = scenario?.supplies ?? run.startSupplies;

    this.state = {
      status: 'playing',      // 'playing' | 'won' | 'lost'
      // The party: a fresh copy of the config units so HP can change per run.
      // The starting party is the first `party.size` entries of the roster, so a
      // character's stats are defined once (config/units.js, party.roster).
      // A scenario may fix its own party instead.
      // `upgrades` holds the unit's unlocked ability tree nodes ("ability:node"
      // refs); `power` is only the auto-resolve SIMULATION's strength proxy,
      // derived from the upgrade count (refreshSimPower) - nothing displays it.
      party: (scenario?.party ?? (config.party.roster ?? []).slice(0, config.party.size ?? 3))
        .map((u) => ({ name: u.name, icon: u.icon, hp: u.hp, maxHp: u.hp, upgrades: [], power: config.battle.simPower.base, alive: true, isPlayer: true })),
      supplies,
      maxSupplies: scenario?.maxSupplies ?? supplies,
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

    // Shops: each one rolls its stock now (seeded), so a revealed and visited shop can
    // show what it sells before the party walks back to it. Done last, so the rolls do
    // not shift any of the map / enemy / Colony rolls above.
    for (const h of this.map.hexes.values()) {
      if (h.encounter === 'shop' && !h.shop) h.shop = this.rollShopStock();
    }

    this.map.start.visited = true;
    this.reveal(this.map.start.q, this.map.start.r, run.revealStartRadius, true);
    if (run.seedAlwaysVisible && this.map.seed) this.map.seed.revealed = true;

    if (scenario) this.addLog('log.scenarioStart', { name: { key: `scenario.${scenario.id}.name` } });
    else this.addLog('log.newRun', { seed, n: this.map.colonies.length, steps: pathLength });
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

  // The supplies/HP a step onto `hex` would ACTUALLY cost right now, stepping
  // there from the party's current tile. Hills and mountains only charge their
  // terrain cost when climbed from strictly lower ground (by terrainHeight):
  // ridge-walking mountain-to-mountain or hill-to-hill, or coming back down
  // mountain-to-hill, costs nothing. A biome's own flat HP cost (wither) is
  // NOT height-gated - it hurts every step regardless of where you came from.
  stepCost(hex) {
    const from = this.state.position;
    const type = this.config.tileTypes[hex.type] ?? {};
    const biome = this.config.biomes[hex.biome] ?? {};
    const climbing = (hex.terrainHeight ?? 0) > (from?.terrainHeight ?? 0);
    return {
      supplyCost: climbing ? (type.supplyCost ?? 0) : 0,
      hpCost: (climbing ? (type.hpCost ?? 0) : 0) + (biome.hpCost ?? 0),
    };
  }

  // Hexes the player could step to right now.
  reachable() {
    if (this.state.status !== 'playing') return [];
    const { q, r } = this.state.position;
    const out = [];
    for (const [nq, nr] of neighbors(q, r)) {
      const h = this.hexAt(nq, nr);
      if (h && h.passable && this.stepCost(h).supplyCost <= this.state.supplies) out.push(h);
    }
    return out;
  }

  canMoveTo(hex) {
    if (!hex || this.state.status !== 'playing') return false;
    const pos = this.state.position;
    if (hexDistance(pos.q, pos.r, hex.q, hex.r) !== 1) return false;
    if (!hex.passable) return false;
    if (this.stepCost(hex).supplyCost > this.state.supplies) return false;
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

  // Danger rank of a battle tile, shown as chevrons above the marker
  // (config.battle.danger). ABSOLUTE, deliberately not relative to the party:
  // judging whether a fight is takeable is the player's job. Regular fights
  // show 0..2 chevrons by the band their total enemy power falls into; a
  // Stasis Colony always shows danger.colony, the Seed always danger.seed.
  dangerRank(hex) {
    if (!hex.enemies) return 0;
    const d = this.config.battle.danger;
    if (hex.isSeed) return d.seed;
    if (hex.isColony) return d.colony;
    const total = hex.enemies.reduce((a, e) => a + e.power, 0);
    const rank = (d.bands ?? []).filter((threshold) => total >= threshold).length;
    return Math.min(d.maxChevrons ?? 8, rank);
  }
  deadUnits() { return this.state.party.filter((u) => !u.alive); }

  // Start-screen roster swap: replaces a party slot with a roster character.
  // Only possible before the first step of the run.
  setPartyUnit(index, def) {
    const s = this.state;
    if (s.turn !== 0 || s.status !== 'playing' || !s.party[index] || !def) return false;
    s.party[index] = { name: def.name, icon: def.icon, hp: def.hp, maxHp: def.hp, upgrades: [], power: this.config.battle.simPower.base, alive: true, isPlayer: true };
    this.addLog('log.joined', { name: { name: def.name } });
    this.emit('change');
    return true;
  }

  // ----- actions ------------------------------------------------------
  moveTo(hex) {
    if (!this.canMoveTo(hex)) return false;
    const from = this.state.position;
    const s = this.state;
    // Must be read BEFORE s.position moves on to `hex` - stepCost() compares
    // against the party's CURRENT tile.
    const cost = this.stepCost(hex);

    s.turn += 1;
    s.position = hex;
    hex.visited = true;

    // The arrival roll uses the fatigue you could see before stepping; then the step
    // raises it (every step, encounter or not).
    const rollChance = s.fatigue;
    s.fatigueSteps += 1;
    s.fatigue = lerpTable(this.config.fatigue.byStep, s.fatigueSteps);

    // Terrain costs (mountains, hills): supplies and HP, only when climbing
    // (see stepCost above).
    if (cost.supplyCost > 0) s.supplies -= cost.supplyCost;

    const radius = this.config.run.revealRadius + (hex.revealBonus || 0);
    const newlyRevealed = this.reveal(hex.q, hex.r, radius, false);
    this.emit('move', { from, to: hex, newlyRevealed });

    const costs = [];
    if (cost.supplyCost > 0) costs.push(t('log.cost.supplies', { n: cost.supplyCost }));
    if (cost.hpCost > 0) costs.push(t('log.cost.hp', { n: cost.hpCost }));
    this.addLog('log.moved', { turn: s.turn, where: { hex: { type: hex.type, biome: hex.biome, q: hex.q, r: hex.r, encounter: hex.encounter } }, fatigue: s.fatigue });
    if (costs.length) this.addLog('log.moved.costs', { costs: costs.join(', ') });
    if (cost.hpCost > 0) this.damageParty(cost.hpCost, 'log.climb');
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
    // No Stasis on this map (a scenario without a scripted one): nothing to advance.
    if (!this.stasis.seed && !this.stasis.colonies.length) return;
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
    if (this.stasis.seed && this.stasis.seed.encounter === 'stasisSeed') sources.push(this.stasis.seed);
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
    // Scripted Colonies (tutorial) bring an authored garrison; the rest roll one.
    if (c.script?.enemies) {
      c.hex.enemies = cloneEnemies(c.script.enemies, this.config.battle);
      if (c.script.title) c.hex.enemies.title = c.script.title;
    } else {
      c.hex.enemies = makeEnemies(this.rng, this.config.battle, c.hex.ring, 'colony');
    }
    this.addLog('log.colonySpawn', {
      where: { hex: { type: c.hex.type, biome: c.hex.biome, q: c.hex.q, r: c.hex.r } },
      debuff: { key: `debuff.${c.debuff}.name` },
    });
    this.emit('colony', { hex: c.hex });
  }

  // Withers one nearby tile: its BIOME becomes 'wither', its TYPE (shape) stays.
  // There is no range limit: the rot always takes a tile on its current front (the
  // closest untouched land, with one ring of slack for a ragged edge), so left alone
  // it eventually swallows all the land. The Seed and Colony sites are spared - they
  // are the sources. Ether is never withered: the rot has nothing to grip in the
  // void. Withered water dries into walkable ground. A tile that withers loses
  // whatever encounter stood on it.
  witherNear(src) {
    let bestD = Infinity;
    const all = [];
    for (const h of this.map.hexes.values()) {
      if (h.biome === 'wither' || h.type === 'ether' || h.isSeed || h.isColony) continue;
      const d = hexDistance(src.q, src.r, h.q, h.r);
      all.push([h, d]);
      if (d < bestD) bestD = d;
    }
    if (!all.length) return null;
    const front = all.filter(([, d]) => d <= bestD + 1).map(([h]) => h);
    const h = this.rng.pick(front);
    if (h.type === 'water') setType(h, 'ground', this.config); // the Stasis dries it out
    setBiome(h, 'wither', this.config);
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
  // In SCENARIO mode there are no random forces at all: the only forced fights
  // are the scripted ambushes, which fire at their exact step on an empty tile.
  onEnter(hex, rollChance) {
    if (this.scenario) {
      const amb = this.nextScenarioAmbush(hex);
      if (amb) {
        hex.encounter = 'battle';
        hex.enemies = cloneEnemies(amb.enemies, this.config.battle);
        if (amb.title) hex.enemies.title = amb.title;
        const label = this.labelFor('battle');
        this.addLog('log.forced', { label: { key: 'visual.battle.label' }, chance: 100 });
        this.emit('forced', { hex, type: 'battle', label, chance: 100 });
        this.enter(true);
        return;
      }
      if (hex.encounter) this.addLog('log.encounterHere', { label: { key: `visual.${hex.encounter}.label` } });
      return;
    }
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

  // The scripted ambush due right now, if any: the party has taken enough steps
  // since the last fatigue reset and stands on an empty tile.
  nextScenarioAmbush(hex) {
    if (!this.scenario?.ambushes || hex.encounter) return null;
    const i = this.scenario.ambushes.findIndex(
      (a, idx) => !this.scenarioState.ambushesDone.has(idx) && this.state.fatigueSteps >= a.afterSteps);
    if (i < 0) return null;
    this.scenarioState.ambushesDone.add(i);
    return this.scenario.ambushes[i];
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
        return this.startCombat(hex, forced);
      case 'treasure': {
        this.consume(hex, type, forced);
        // A scenario may fix the exact amount a cache holds.
        this.offerSupplies(hex.scenarioSupplies ?? this.config.treasure.supplies, 'treasure.title', 'treasure.text', 'treasure');
        return true;
      }
      case 'event': {
        const weights = {};
        EVENTS.forEach((e, i) => { weights[i] = e.weight ?? 1; });
        // A scenario names the tile's event; everything else rolls by weight.
        const ev = (this.scenario && hex.scenarioEvent && EVENTS.find((e) => e.id === hex.scenarioEvent))
          || EVENTS[Number(this.rng.weighted(weights))];
        this.addLog('log.event', { title: { key: `event.${ev.id}.title` } });
        this.consume(hex, type, forced);
        this.applyEvent(ev, forced);
        return true;
      }
      case 'shop':
        // The shop stays on the tile and can be revisited. Buying happens via shopBuy().
        // From the first visit on, the tile's hover text lists what the shop still sells.
        if (!hex.shop) hex.shop = this.rollShopStock();
        hex.shop.seen = true;
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
      case 'gate': {
        // The layer gate (the green pyramid): the party learns of another layer
        // of the worldflake. WHICH layer it opens is meta-progression - main.js
        // keeps the unlock chain in the browser (like the tutorial progress)
        // and fills the dialog; the rules layer only consumes the tile.
        this.consume(hex, type, forced);
        this.emit('dialog', { kind: 'gate' });
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
  // A shop's stock: the guaranteed options first, then "randomCount" distinct picks
  // from the pool (seeded). "bought" remembers what was sold, "seen" whether the party
  // has entered this shop yet (the hover text lists the options only after that).
  rollShopStock() {
    const shop = this.config.shop;
    const guaranteed = [...(shop.guaranteed ?? [])];
    const pool = this.shuffle((shop.pool ?? []).filter((id) => !guaranteed.includes(id)));
    const options = [...guaranteed, ...pool.slice(0, Math.max(0, shop.randomCount ?? 0))];
    return { options, bought: {}, seen: false };
  }

  // Price of a shop option, read from config (shop.<id>Cost).
  shopCost(id) {
    return this.config.shop[`${id}Cost`] ?? 0;
  }

  // Can this option be bought right now? Returns null when yes, otherwise a reason id:
  // 'sold' (already bought here), 'supplies' (too poor), 'useless' (nothing it can do,
  // e.g. rest at 0 fatigue with a full party, or spare parts with nobody disabled).
  shopBlocker(hex, id) {
    const stock = hex?.shop;
    if (!stock || !stock.options.includes(id)) return 'missing';
    if (stock.bought[id]) return 'sold';
    if (this.state.supplies < this.shopCost(id)) return 'supplies';
    if (id === 'spareParts' && !this.deadUnits().length) return 'useless';
    if (id === 'rest' && this.state.fatigue === 0 && this.livingUnits().every((u) => u.hp >= u.maxHp)) return 'useless';
    if ((id === 'upgrade' || id === 'relic') && !this.hasUpgradeOffers()) return 'useless';
    return null;
  }

  // Buys one option of the shop the party stands in. "unitIndex" is needed by the
  // options that target a unit (spareParts). Each option sells once.
  shopBuy(item, unitIndex) {
    const s = this.state;
    const shop = this.config.shop;
    const hex = s.position;
    if (hex.encounter !== 'shop' || s.status !== 'playing') return false;
    const blocker = this.shopBlocker(hex, item);
    if (blocker) {
      if (blocker === 'sold') this.addLog('log.shop.sold', { label: { key: `shop.${item}.name` } });
      else if (blocker === 'supplies') this.addLog('log.shop.noSupplies', { label: { key: `shop.${item}.name` } });
      return false;
    }
    const cost = this.shopCost(item);
    const cfg = this.config.events;

    if (item === 'rest') {
      s.supplies -= cost;
      this.addLog('log.shop.rested', { cost });
      this.applyRest();
      this.resetFatigue();
    } else if (item === 'map') {
      s.supplies -= cost;
      const n = this.revealBlob(cfg.blobSize, cfg.blobMaxDistance);
      this.addLog('log.shop.map', { cost, n });
    } else if (item === 'upgrade' || item === 'relic') {
      // Pays for ONE ability upgrade pick; the UI opens the same chooser as a
      // battle reward right after this returns true.
      if (!this.hasUpgradeOffers()) return false;
      s.supplies -= cost;
      this.addLog(item === 'relic' ? 'log.shop.relic' : 'log.shop.upgraded', { cost });
    } else if (item === 'rumors') {
      s.supplies -= cost;
      const hidden = [...this.map.hexes.values()].filter((h) => !h.revealed && h.encounter === 'battle');
      const near = hidden.filter((h) => this.distanceFrom(h) <= cfg.rumorsRadius);
      // Same rule as the "Rumors" event: nearby hidden battles first, the nearest anywhere otherwise.
      const picked = near.length
        ? this.shuffle(near).slice(0, cfg.rumorsCount)
        : hidden.sort((a, b) => this.distanceFrom(a) - this.distanceFrom(b)).slice(0, cfg.rumorsCount);
      this.revealHexes(picked);
      this.addLog('log.shop.rumors', { cost, n: picked.length });
    } else if (item === 'spareParts') {
      const u = s.party[unitIndex];
      if (!u || u.alive) return false;
      s.supplies -= cost;
      u.alive = true;
      u.hp = Math.max(1, Math.round(u.maxHp * this.config.acolyte.reviveFraction));
      this.addLog('log.shop.spareParts', { name: { name: u.name }, hp: u.hp, cost });
    } else {
      return false;
    }
    hex.shop.bought[item] = true;
    // Sold out: an empty shop is no longer an encounter. The tile loses its
    // marker (like any consumed encounter), while hex.shop stays behind so the
    // open window - and the tile's hover text - can still list what was here.
    // Fatigue is untouched: shop's reset rule is 'optional', not 'always'.
    if (this.shopSoldOut(hex)) this.consume(hex, 'shop', false);
    this.emit('change');
    return true;
  }

  // True when every option this shop stocks has been bought.
  shopSoldOut(hex) {
    const stock = hex?.shop;
    if (!stock || !stock.options?.length) return false;
    return stock.options.every((id) => !!stock.bought[id]);
  }

  // ----- battle ---------------------------------------------------------
  // A fight happens in three steps, so the INTERACTIVE combat on the local map
  // (src/local/battle/) can slot in between them:
  //   prepareCombat()  rolls the enemies, applies the Stasis debuffs, logs the
  //                    opening - and returns a context describing the fight
  //   ...the fight...  either simulateBattle (the old auto-resolve) or the
  //                    combatDelegate set by main.js (the playable arena)
  //   finishCombat()   lifts the debuffs, applies deaths, rewards, dialogs, end
  prepareCombat(hex, forced, opts = {}) {
    const s = this.state;
    const enemies = hex.enemies ?? makeEnemies(this.rng, this.config.battle, hex.ring, hex.isSeed ? 'boss' : hex.isColony ? 'colony' : 'regular');
    hex.enemies = null;

    // Stasis debuffs: temporarily weaken the party and/or reinforce the enemy for
    // this one fight. Damage taken stays after the fight; max HP comes back.
    // The "damage" debuff travels on the context: the interactive engine takes it
    // as a flat ability-damage penalty (damageMod), while the auto-resolve
    // simulation approximates it by lowering the party's sim power proxy.
    const debuffs = this.activeDebuffsFor(hex);
    const cfgDebuffs = this.config.stasis.debuffs;
    const saved = s.party.map((u) => ({ maxHp: u.maxHp, power: u.power }));
    let damageMod = 0;
    for (const id of debuffs) {
      if (id === 'maxHp') {
        for (const u of s.party) {
          u.maxHp = Math.max(1, Math.round(u.maxHp * (1 - cfgDebuffs.maxHp.fraction)));
          u.hp = Math.min(u.hp, u.maxHp);
        }
      } else if (id === 'damage') {
        damageMod += cfgDebuffs.damage.amount;
        for (const u of s.party) u.power -= cfgDebuffs.damage.amount * (this.config.battle.powerStep ?? 3);
      } else if (id === 'extraEnemies') {
        enemies.push(...makeRegulars(this.rng, this.config.battle, hex.ring, cfgDebuffs.extraEnemies.count));
        renameDuplicates(enemies);
      }
    }
    if (debuffs.length) {
      this.addLog('log.debuffs', { list: { list: debuffs.map((id) => ({ key: `debuff.${id}.name` })) } });
    }

    const who = { list: enemies.map((e) => ({ key: 'log.battle.enemy', params: { name: { name: e.name }, hp: e.maxHp, power: e.power } })) };
    const first = { key: forced ? 'log.battle.enemiesFirst' : 'log.battle.partyFirst' };
    if (enemies.title) this.addLog('log.battle.stasis', { title: { name: enemies.title }, who, first });
    else this.addLog('log.battle', { who, first });

    // `lore` and `title` are for the Local Map Info panel: what this fight IS,
    // shown while it is being played rather than only in the report afterwards.
    return { hex, forced, opts, enemies, debuffs, saved, damageMod,
             title: enemies.title ?? null, lore: this.pickFlavour('combatIntro') };
  }

  finishCombat(ctx, result) {
    const s = this.state;
    const { hex, forced, opts, enemies, debuffs, saved } = ctx;

    // Undo the temporary debuffs (wounds and deaths remain).
    for (let i = 0; i < s.party.length; i++) {
      const u = s.party[i];
      u.maxHp = saved[i].maxHp;
      u.power = saved[i].power;
      u.hp = Math.min(u.hp, u.maxHp);
    }

    // An interactive fight reports only the outcome; deaths are read off the party.
    if (result.interactive) {
      result.lines = result.lines ?? [];
      result.deaths = result.deaths ?? [];
      result.partyFirst = !forced;
      for (const u of s.party) {
        if (u.alive && u.hp <= 0) { u.hp = 0; u.alive = false; result.deaths.push(u); }
      }
    }

    result.enemies = enemies;
    result.stasis = hex.isSeed || hex.isColony;
    result.seedFight = hex.isSeed;
    result.colonyFight = hex.isColony;
    result.debuffs = debuffs;
    result.title = enemies.title || null;
    s.lastBattle = result;

    for (const d of result.deaths) {
      if (s.party.includes(d)) this.addLog('log.unitDisabled', { name: { name: d.name } });
    }
    this.addLog(result.won ? 'log.victory' : 'log.defeat', { n: result.rounds });

    // The victory reward is decided BEFORE the dialog goes out: the window reads it
    // while it is being built (a regression once hid the reward chooser because the
    // reward was only set after the dialog event fired). The reward is ability
    // upgrade PICKS; the offers themselves are drawn fresh at each pick, so a
    // Colony's several picks see the children a previous pick just opened.
    if (result.won && this.hasUpgradeOffers()) {
      result.reward = 'upgrade';
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

  // The auto-resolve fallback: the same three steps with simulateBattle in the
  // middle. Used when no combatDelegate is wired in (headless tests, safety net).
  resolveBattle(hex, forced, opts = {}) {
    const ctx = this.prepareCombat(hex, forced, opts);
    const result = simulateBattle(this.rng, this.config.battle, this.state.party, ctx.enemies, !forced);
    return this.finishCombat(ctx, result);
  }

  // Routes a fight to the interactive arena when main.js has provided one.
  // The delegate receives the prepared context and must later call
  // finishCombat(ctx, { won, rounds, interactive: true }); returning false
  // means "cannot take it now" and the fight auto-resolves instead.
  startCombat(hex, forced, opts = {}) {
    if (this.combatDelegate) {
      const ctx = this.prepareCombat(hex, forced, opts);
      if (this.combatDelegate(ctx)) return true;
      // Delegate refused: fall through to the simulation on the SAME context.
      const result = simulateBattle(this.rng, this.config.battle, this.state.party, ctx.enemies, !forced);
      return this.finishCombat(ctx, result);
    }
    return this.resolveBattle(hex, forced, opts);
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
        // The scholar's lesson: one random living unit unlocks one random
        // available ability upgrade (nothing left to learn = nothing happens).
        const living = this.livingUnits().filter((u) => availableUpgrades(u).length);
        if (living.length) {
          const u = this.rng.pick(living);
          const pick = this.unlockRandomUpgrade(u);
          effect = t('effect.power', { name: tn(u.name), upgrade: t(`upgrade.${pick.abilityId}.${pick.nodeId}.name`) });
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
        effect = t('effect.blackMarket');
        this.addLog('log.effect', { effect });
        this.emit('dialog', { kind: 'blackmarket', title, text, effect });
        return;
      }
      case 'battle': {
        // Same as a battle encounter on this tile. The dialog shows the story first.
        this.startCombat(pos, forced, { alreadyConsumed: true, intro: { title, text } });
        return;
      }
      case 'rest': {
        this.applyRest();
        this.resetFatigue();
        effect = t('effect.rest', { pct: `${Math.round(this.config.rest.healFraction * 100)}%` });
        break;
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

  // ----- ability upgrades (the party's only way to grow) -----------------
  // The reward screen: ONE random upgrade offered per living unit, drawn from
  // everything currently unlockable across the unit's ability trees; the
  // player picks one offer to actually unlock. Newly opened children join the
  // pool on the NEXT reward, because the pool is re-read every time.
  upgradeOffers() {
    const out = [];
    this.state.party.forEach((u, index) => {
      if (!u.alive) return;
      const pool = availableUpgrades(u);
      if (!pool.length) return;
      out.push({ index, ...this.rng.pick(pool) });
    });
    return out;
  }
  hasUpgradeOffers() {
    return this.state.party.some((u) => u.alive && availableUpgrades(u).length > 0);
  }

  // Keeps the auto-resolve simulation's strength proxy in step with the
  // unit's real growth. Nothing displays this number.
  refreshSimPower(u) {
    const sp = this.config.battle.simPower;
    u.power = sp.base + upgradeCount(u) * sp.perUpgrade;
  }

  // Called by the reward dialog with one of upgradeOffers()'s entries.
  applyUpgradePick(offer) {
    const u = this.state.party[offer.index];
    if (!u || !u.alive || !unlockUpgrade(u, offer.ref)) return false;
    this.refreshSimPower(u);
    this.addLog('log.learned', { name: { name: u.name }, upgrade: { key: `upgrade.${offer.abilityId}.${offer.nodeId}.name` } });
    this.emit('change');
    return true;
  }

  // Unlocks a RANDOM available upgrade for the unit (scholar / black market).
  // Returns the unlocked entry, or null when the unit has nothing left.
  unlockRandomUpgrade(u) {
    const pool = availableUpgrades(u);
    if (!pool.length) return null;
    const pick = this.rng.pick(pool);
    unlockUpgrade(u, pick.ref);
    this.refreshSimPower(u);
    return pick;
  }

  // Two random DISTINCT upgrade suggestions for this one unit (fewer if it has
  // only one left to learn) - the player picks between them; nothing is
  // unlocked yet and no HP is spent until blackMarketDeal() is called.
  blackMarketOffers(index) {
    const u = this.state.party[index];
    if (!u || !u.alive) return [];
    return this.shuffle(availableUpgrades(u)).slice(0, 2);
  }

  // The max HP the unit would pay - same number either offer costs, so the
  // dialog can show it before the player has picked one.
  blackMarketHpLoss(index) {
    const u = this.state.party[index];
    if (!u) return 0;
    return Math.max(1, Math.round(u.maxHp * this.config.events.blackMarketHpFraction));
  }

  // Unlocks the CHOSEN ref (one of blackMarketOffers()'s entries) for the unit,
  // at the usual HP price.
  blackMarketDeal(index, ref) {
    const u = this.state.party[index];
    if (!u || !u.alive || !ref) return false;
    const offer = availableUpgrades(u).find((o) => o.ref === ref);
    if (!offer || !unlockUpgrade(u, ref)) return false;
    this.refreshSimPower(u);
    const loss = this.blackMarketHpLoss(index);
    u.maxHp = Math.max(1, u.maxHp - loss);
    u.hp = Math.min(u.hp, u.maxHp);
    this.addLog('log.blackMarket', { name: { name: u.name }, loss, upgrade: { key: `upgrade.${offer.abilityId}.${offer.nodeId}.name` } });
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

  // Marks every not-yet-revealed hex in `list` as revealed, pulls in whole
  // connected ether pockets touched by that (see expandEtherPockets), then
  // emits 'reveal' unless silent. The one place both reveal() and
  // revealHexes() funnel through, so ether behaves the same from either.
  finishReveal(list, { silent = false } = {}) {
    const newly = [];
    for (const h of list) {
      if (h && !h.revealed) { h.revealed = true; newly.push(h); }
    }
    this.expandEtherPockets(newly);
    if (!silent && newly.length) this.emit('reveal', { hexes: newly });
    return newly;
  }

  // Ether tiles sit hidden under the fog like anything else, but they come in
  // connected pockets (a path that never leaves ether). Revealing only part of
  // a pocket would look broken - a hole with a wall of fog cutting through it -
  // so the moment any ether tile in `newly` is revealed, this walks outward
  // through its ether-only neighbours and reveals the rest of the pocket too,
  // appending them to `newly` so the renderer animates them in together.
  expandEtherPockets(newly) {
    const seeds = newly.filter((h) => h.type === 'ether');
    if (!seeds.length) return;
    const visited = new Set(seeds.map((h) => h.key));
    const stack = [...seeds];
    while (stack.length) {
      const cur = stack.pop();
      for (const [nq, nr] of neighbors(cur.q, cur.r)) {
        const nb = this.hexAt(nq, nr);
        if (!nb || nb.type !== 'ether' || visited.has(nb.key)) continue;
        visited.add(nb.key);
        stack.push(nb);
        if (!nb.revealed) { nb.revealed = true; newly.push(nb); }
      }
    }
  }

  revealHexes(list) {
    return this.finishReveal(list);
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
    // Scenario goal: standing on the goal tile completes the map.
    if (this.scenario?.goal?.type === 'reach' && s.position.key === this.scenario.goal.tile) {
      s.status = 'won';
      s.endReason = ['end.scenario', { turn: s.turn }];
      this.addLog('log.scenarioDone');
      this.emit('end', { status: s.status });
      return;
    }
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
    const list = [];
    const maxH = Math.max(0, ...Object.values(this.config.tileTypes).map((t) => t.terrainHeight ?? 0))
      + Math.max(0, ...Object.values(this.config.biomes).map((b) => b.terrainHeight ?? 0));
    for (const [hq, hr] of hexesInRange(q, r, radius + maxH)) {
      const h = this.hexAt(hq, hr);
      if (!h || h.revealed) continue;
      const d = hexDistance(q, r, hq, hr);
      if (d <= radius + (h.terrainHeight ?? 0)) list.push(h);
    }
    return this.finishReveal(list, { silent });
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

// The hue the fatigue bar paints the box for `step` (see config.fatigueBar):
// green while the step costs nothing, then yellow to red across the range of
// non-zero chances the table actually holds. Shared, so the world map can paint
// the ring of a reachable tile the colour of the box that step will fill.
export function fatigueStepHue(config, step) {
  const fb = config.fatigueBar;
  const byStep = config.fatigue.byStep || {};
  const keys = Object.keys(byStep).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const maxStep = keys.length ? keys[keys.length - 1] : 0;
  const pcts = [];
  for (let i = 1; i <= maxStep; i++) pcts.push(lerpTable(byStep, i));
  const pct = lerpTable(byStep, step);
  if (pct <= 0) return fb.hueSafe;
  const risky = pcts.filter((p) => p > 0);
  const lo = risky.length ? Math.min(...risky) : 0;
  const hi = risky.length ? Math.max(...risky) : 1;
  const k = hi > lo ? (pct - lo) / (hi - lo) : 0;
  return fb.hueLow + (fb.hueHigh - fb.hueLow) * k;
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
  // Land types read as "Grasslands Ground" (or "Withered Ground" once the Stasis
  // takes them); water / ether ignore the biome.
  const tinted = hex.type === 'ground' || hex.type === 'hill' || hex.type === 'mountain';
  const name = tinted ? t('hover.tile', { biome: t(`biome.${hex.biome}`), type: t(`terrain.${hex.type}`) }) : t(`terrain.${hex.type}`);
  return `${name} (${hex.q},${hex.r})${enc}`;
}
