// Game rules and state. Pure data + logic, no rendering.
// The renderer and the HUD subscribe to "events" and redraw themselves.
import { createRng } from './rng.js';
import { generateMap } from './map.js';
import { hexKey, neighbors, hexesInRange, hexDistance } from './hex.js';
import { simulateBattle, makeEnemies } from './battle.js';
import { EVENTS, LORE_TEXTS } from './events.js';


export class Game {
  constructor(config, seed) {
    this.config = config;
    this.seed = seed;
    this.rng = createRng(seed);
    this.map = generateMap(config, this.rng);

    const run = config.run;
    const pathLength = this.map.shortestPath.length - 1; // steps, not tiles
    const supplies = run.startSupplies === 'auto'
      ? pathLength + run.supplySlack
      : run.startSupplies;

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

    this.map.start.visited = true;
    this.reveal(this.map.start.q, this.map.start.r, run.revealStartRadius, true);
    if (run.bossAlwaysVisible) for (const b of this.map.bosses) b.revealed = true;

    const nb = this.map.bosses.length;
    this.addLog(`New run. Seed ${seed}. ${nb} boss${nb === 1 ? '' : 'es'} hide in the outer rings. Nearest is ${pathLength} steps away.`);
  }

  // ----- events -------------------------------------------------------
  on(callback) {
    this.listeners.push(callback);
  }

  emit(type, payload = {}) {
    for (const cb of this.listeners) cb(type, payload, this);
  }

  addLog(text) {
    this.log.push({ turn: this.state.turn, text });
    if (this.log.length > 60) this.log.shift();
    this.emit('log', { text });
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
    if (fallen.length) this.addLog(`${reason}: ${fallen.join(', ')} fell.`);
  }

  // What the Engage button would do right now: { kind: 'encounter'|'camp'|'none', label, enabled, reason }
  engageAction() {
    const s = this.state;
    if (s.status !== 'playing') return { kind: 'none', label: 'Engage', enabled: false };
    const hex = s.position;
    if (hex.encounter) {
      return { kind: 'encounter', type: hex.encounter, label: `Engage: ${this.labelFor(hex.encounter)}`, enabled: true };
    }
    const cost = this.config.rest.cost;
    const enabled = s.supplies >= cost;
    return {
      kind: 'camp',
      label: `Make camp (${cost} supplies)`,
      enabled,
      reason: enabled ? '' : `Not enough supplies (${s.supplies}/${cost}).`,
    };
  }

  canEngage() {
    return this.engageAction().enabled;
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
    return this.config.fatigue.resetNotes?.[type] ?? '';
  }

  // Chance (%) of being forced into something if the party steps onto `hex` now:
  // the CURRENT fatigue, and only if the tile holds (or may hide) a forceable encounter.
  // Returns null when the tile is revealed and cannot force anything.
  forcedChanceFor(hex) {
    const f = this.state.fatigue;
    if (!hex.revealed) return { chance: f, certain: false };
    if (hex.encounter && this.isForceable(hex.encounter)) return { chance: f, certain: true };
    return null;
  }

  livingUnits() { return this.state.party.filter((u) => u.alive); }
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
    if (hex.supplyCost > 0) costs.push(`-${hex.supplyCost} supplies`);
    if (hex.hpCost > 0) costs.push(`-${hex.hpCost} HP each`);
    this.addLog(`Turn ${s.turn}: moved to ${describeHex(hex, this.config)}. Fatigue ${s.fatigue}%.${costs.length ? ' ' + costs.join(', ') + '.' : ''}`);
    if (hex.hpCost > 0) this.damageParty(hex.hpCost, 'The climb');
    if (!this.livingUnits().length) {
      s.status = 'lost';
      s.endReason = `The whole party perished on the mountain after ${s.turn} moves.`;
      this.emit('end', { status: s.status });
      this.emit('change');
      return true;
    }
    this.onEnter(hex, rollChance);
    this.checkEndOfRun();
    this.emit('change');
    return true;
  }

  // What happens when stepping on a hex: the party is NOT pulled into the encounter
  // automatically, unless fatigue rolls against them.
  onEnter(hex, rollChance) {
    if (!hex.encounter) return;
    const label = this.labelFor(hex.encounter);
    if (this.isForceable(hex.encounter) && rollChance > 0 && this.rng.chance(rollChance / 100)) {
      this.addLog(`Exhausted! The party stumbles straight into the ${label} encounter (${rollChance}% roll failed).`);
      this.emit('forced', { hex, type: hex.encounter, label, chance: rollChance });
      this.engage(true);
      return;
    }
    this.addLog(`${label} encounter here. Press "Engage" to enter it, or keep walking.`);
  }

  // The Engage button. "forced" = triggered by fatigue (enemies act first in battles).
  engage(forced = false) {
    const action = this.engageAction();
    if (!action.enabled) return false;
    if (action.kind === 'camp') return this.makeCamp();

    const hex = this.state.position;
    const type = hex.encounter;
    const label = this.labelFor(type);
    this.addLog(`${forced ? 'Forced into' : 'Entered'} ${label}.`);

    switch (type) {
      case 'battle':
      case 'boss':
        return this.resolveBattle(hex, forced);
      case 'treasure': {
        this.consume(hex, type, forced);
        this.offerSupplies(this.config.treasure.supplies, 'Treasure', 'A sealed cache, heavy with rations and line.');
        return true;
      }
      case 'event': {
        const weights = {};
        EVENTS.forEach((e, i) => { weights[i] = e.weight ?? 1; });
        const ev = EVENTS[Number(this.rng.weighted(weights))];
        this.addLog(`Event: ${ev.title}.`);
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
          this.addLog('The Acolyte has nothing to restore: nobody in the party has fallen. The forge waits.');
          this.emit('change');
          return false;
        }
        this.emit('dialog', { kind: 'acolyte' });
        return true;
      }
      case 'rest':
        this.applyRest();
        this.consume(hex, type, forced);
        return true;
      default:
        this.addLog(`${label}: no logic yet.`);
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
    this.addLog(`The party makes camp (-${cost} supplies).`);
    this.applyRest();
    this.resetFatigue();
    this.emit('change');
    return true;
  }

  applyRest() {
    const f = this.config.rest.healFraction;
    const healed = [];
    for (const u of this.livingUnits()) {
      const before = u.hp;
      u.hp = Math.min(u.maxHp, u.hp + Math.round(u.maxHp * f));
      if (u.hp !== before) healed.push(`${u.name} +${u.hp - before}`);
    }
    this.addLog(healed.length ? `Rest: ${healed.join(', ')}.` : 'Rest: everyone was already at full health.');
  }

  // ----- acolyte --------------------------------------------------------
  restoreUnit(index) {
    const u = this.state.party[index];
    const hex = this.state.position;
    if (!u || u.alive || hex.encounter !== 'acolyte') return false;
    u.alive = true;
    u.hp = Math.max(1, Math.round(u.maxHp * this.config.acolyte.reviveFraction));
    this.addLog(`The Acolyte of the Great Forge restores ${u.name} (${u.hp} HP).`);
    this.consume(hex, 'acolyte', false);
    return true;
  }

  // ----- shop ---------------------------------------------------------
  shopBuy(item, unitIndex) {
    const s = this.state;
    const shop = this.config.shop;
    if (s.position.encounter !== 'shop' || s.status !== 'playing') return false;
    if (item === 'rest') {
      if (s.supplies < shop.restCost) { this.addLog('Shop: not enough supplies for a rest.'); return false; }
      s.supplies -= shop.restCost;
      this.resetFatigue();
      this.addLog(`Shop: rested (-${shop.restCost} supplies). Fatigue reset.`);
    } else if (item === 'map') {
      if (s.supplies < shop.mapCost) { this.addLog('Shop: not enough supplies for a map.'); return false; }
      s.supplies -= shop.mapCost;
      const n = this.revealBlob(this.config.events.blobSize, this.config.events.blobMaxDistance);
      this.addLog(`Shop: bought a local map (-${shop.mapCost} supplies). ${n} tiles revealed.`);
    } else if (item === 'upgrade') {
      const u = s.party[unitIndex];
      if (!u) return false;
      if (s.supplies < shop.upgradeCost) { this.addLog('Shop: not enough supplies for an upgrade.'); return false; }
      s.supplies -= shop.upgradeCost;
      u.power += shop.upgradeAmount;
      this.addLog(`Shop: ${u.name} upgraded to power ${u.power} (-${shop.upgradeCost} supplies).`);
    } else {
      return false;
    }
    this.emit('change');
    return true;
  }

  // ----- battle ---------------------------------------------------------
  resolveBattle(hex, forced, opts = {}) {
    const s = this.state;
    const enemies = makeEnemies(this.rng, this.config.battle, hex.ring, hex.isBoss, lerpTable);
    const result = simulateBattle(this.rng, this.config.battle, s.party, enemies, !forced);
    result.enemies = enemies;
    result.boss = hex.isBoss;
    s.lastBattle = result;

    const who = enemies.map((e) => `${e.name} (${e.maxHp} HP, power ${e.power})`).join(', ');
    this.addLog(`Battle vs ${who}. ${forced ? 'Enemies strike first.' : 'The party strikes first.'}`);
    for (const d of result.deaths) {
      if (s.party.includes(d)) this.addLog(`${d.name} has fallen.`);
    }
    this.addLog(result.won
      ? `Victory after ${result.rounds} round${result.rounds === 1 ? '' : 's'}.`
      : `Defeat after ${result.rounds} round${result.rounds === 1 ? '' : 's'}.`);

    if (!opts.alreadyConsumed) this.consume(hex, hex.encounter, forced);
    else this.resetFatigue();
    this.emit('dialog', { kind: 'battle', result, intro: opts.intro });

    if (!result.won) {
      s.status = 'lost';
      s.endReason = `The whole party fell in battle after ${s.turn} moves.`;
      this.emit('end', { status: s.status });
    } else {
      if (hex.isBoss) {
        s.bossesDefeated += 1;
        const total = this.map.bosses.length;
        const done = this.config.run.winCondition === 'any' || s.bossesDefeated >= total;
        if (done) {
          s.status = 'won';
          s.endReason = `You defeated ${s.bossesDefeated} of ${total} bosses after ${s.turn} moves and ${s.encountersCleared} encounters.`;
          this.addLog('All bosses defeated. Run finished.');
          this.emit('end', { status: s.status });
        } else {
          this.addLog(`Boss defeated (${s.bossesDefeated} of ${total}).`);
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
    const unrevealed = (pred) => hexes.filter((h) => !h.revealed && pred(h));
    let effect = '';
    let title = ev.title;
    let text = ev.text;

    switch (ev.effect) {
      case 'revealShop': {
        const shops = unrevealed((h) => h.encounter === 'shop');
        if (shops.length) {
          const shop = this.nearest(shops, pos);
          this.revealHexes([shop]);
          effect = `A shop has been marked on the map (${this.distanceFrom(shop)} tiles away).`;
        } else {
          effect = 'The signpost points to a shop you already know about.';
        }
        break;
      }
      case 'revealBlob': {
        const n = this.revealBlob(cfg.blobSize, cfg.blobMaxDistance);
        effect = `${n} nearby tiles revealed.`;
        break;
      }
      case 'revealBattles': {
        const near = unrevealed((h) => h.encounter === 'battle' && this.distanceFrom(h) <= cfg.rumorsRadius);
        const picked = this.shuffle(near).slice(0, cfg.rumorsCount);
        this.revealHexes(picked);
        effect = picked.length
          ? `${picked.length} battle${picked.length === 1 ? '' : 's'} within ${cfg.rumorsRadius} tiles revealed.`
          : 'No hidden battles nearby: the raiders have moved on.';
        break;
      }
      case 'vantage': {
        const list = hexes.filter((h) => !h.revealed && (
          this.distanceFrom(h) <= cfg.vantageRadius ||
          (h.terrain === 'mountain' && this.distanceFrom(h) <= cfg.vantageMountainRadius)));
        this.revealHexes(list);
        effect = `Everything within ${cfg.vantageRadius} tiles and every mountain within ${cfg.vantageMountainRadius} revealed (${list.length} tiles).`;
        break;
      }
      case 'supplies': {
        const n = this.rng.int(cfg.suppliesMin, cfg.suppliesMax);
        this.offerSupplies(n, title, text);
        return;
      }
      case 'power': {
        const living = this.livingUnits();
        if (living.length) {
          const u = this.rng.pick(living);
          u.power += cfg.scholarPower;
          effect = `${u.name} gains +${cfg.scholarPower} power (now ${u.power}).`;
        } else {
          effect = 'Nobody left to teach.';
        }
        break;
      }
      case 'revealAcolyte': {
        const acs = unrevealed((h) => h.encounter === 'acolyte');
        if (acs.length) {
          const a = this.nearest(acs, pos);
          this.revealHexes([a]);
          effect = `An Acolyte of the Great Forge has been marked on the map (${this.distanceFrom(a)} tiles away).`;
        } else {
          effect = 'They point to a forge you have already found.';
        }
        break;
      }
      case 'blackMarket': {
        // The choice happens in the UI; game.blackMarketDeal(index) applies it.
        effect = `Choose a unit to lose a third of its max HP for +${cfg.blackMarketPower} power, or decline.`;
        this.addLog(effect);
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
        effect = `The party rests: every living unit heals ${Math.round(this.config.rest.healFraction * 100)}% of its max HP. Fatigue reset.`;
        break;
      }
      case 'lore':
      default: {
        const l = this.rng.pick(LORE_TEXTS);
        title = `${ev.title}: ${l.title}`;
        text = l.text;
        effect = 'No effect. Just the world.';
      }
    }
    if (effect) this.addLog(`Effect: ${effect}`);
    this.emit('change');
    this.emit('dialog', { kind: 'event', title, text, effect });
  }

  // Supplies found in the field. If they would overflow the maximum, the dialog offers
  // to make camp first (spending supplies) so more of the find fits.
  offerSupplies(amount, title, text) {
    const s = this.state;
    const room = s.maxSupplies - s.supplies;
    const overflow = Math.max(0, amount - room);
    s.pendingSupplies = { amount, title };
    const campCost = this.config.rest.cost;
    const canCamp = overflow > 0 && !s.position.encounter && s.supplies >= campCost;
    const effect = overflow > 0
      ? `+${amount} supplies, but only ${room} fit (${overflow} would be lost).`
      : `+${amount} supplies.`;
    this.addLog(`${title}: ${effect}`);
    this.emit('change');
    this.emit('dialog', { kind: 'supplies', title, text, effect, amount, overflow, canCamp, campCost });
  }

  // Called by the dialog: optionally make camp, then take the find.
  claimSupplies(campFirst) {
    const s = this.state;
    const p = s.pendingSupplies;
    if (!p) return false;
    if (campFirst) this.makeCamp();
    s.pendingSupplies = null;
    const got = this.addSupplies(p.amount);
    this.addLog(`Collected ${got} of ${p.amount} supplies${got < p.amount ? ' (the rest would not fit)' : ''}.`);
    this.emit('change');
    return true;
  }

  // Called by the dialog after a won battle.
  grantVictoryPower(index) {
    const u = this.state.party[index];
    const n = this.config.battle.victoryPower;
    if (!u || !u.alive || !n) return false;
    u.power += n;
    this.addLog(`${u.name} learns from the fight: +${n} power (now ${u.power}).`);
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
    this.addLog(`Black market: ${u.name} loses ${loss} max HP and gains +${cfg.blackMarketPower} power (now ${u.power}).`);
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
    return this.config.encounters.visuals[type]?.label ?? type;
  }

  checkEndOfRun() {
    const s = this.state;
    if (s.status !== 'playing') return;
    if (this.reachable().length === 0) {
      s.status = 'lost';
      s.endReason = `Stuck: no affordable neighbour after ${s.turn} moves.`;
      this.addLog(s.endReason);
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
    this.addLog('Debug: whole map revealed.');
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

export function describeHex(hex, config) {
  const terrainName = hex.terrain[0].toUpperCase() + hex.terrain.slice(1);
  const enc = hex.encounter ? ` + ${config.encounters.visuals[hex.encounter]?.label ?? hex.encounter}` : '';
  return `${terrainName} (${hex.q},${hex.r})${enc}`;
}
