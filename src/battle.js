// Battle simulation: pure logic, no rendering. Both sides are arrays of units
// { name, hp, maxHp, power, alive }. Returns a transcript + the outcome.
// Units are mutated in place (the party keeps its wounds).

// Random damage in [min, max], shaped like a bell: average of `dice` uniform rolls.
export function rollDamage(rng, cfg) {
  const dice = Math.max(1, cfg.bellDice | 0);
  let sum = 0;
  for (let i = 0; i < dice; i++) sum += rng.random();
  const t = sum / dice; // 0..1, bell shaped for dice >= 2
  return cfg.damageMin + t * (cfg.damageMax - cfg.damageMin);
}

export function damageFor(rng, cfg, attacker, defender) {
  const base = rollDamage(rng, cfg);
  let mult = Math.pow(cfg.powerBase, attacker.power - defender.power);
  // Player units fight harder the closer they are to death.
  if (attacker.isPlayer && cfg.desperation) {
    const missing = 1 - Math.max(0, attacker.hp) / attacker.maxHp;
    mult *= 1 + cfg.desperation * missing;
  }
  return Math.max(1, Math.round(base * mult));
}

const alive = (units) => units.filter((u) => u.alive !== false && u.hp > 0);

/**
 * @param rng       seeded rng
 * @param cfg       config.battle
 * @param party     player units
 * @param enemies   enemy units
 * @param partyFirst true if the player initiated the battle
 */
export function simulateBattle(rng, cfg, party, enemies, partyFirst) {
  const lines = [];
  const deaths = [];
  let round = 0;

  const turn = (attackers, defenders, sideName) => {
    for (const a of alive(attackers)) {
      const targets = alive(defenders);
      if (!targets.length) return;
      const d = rng.pick(targets);
      const dmg = damageFor(rng, cfg, a, d);
      d.hp = Math.max(0, d.hp - dmg);
      let line = `${a.name} hits ${d.name} for ${dmg}`;
      if (d.hp <= 0) {
        d.alive = false;
        deaths.push(d);
        line += ` - ${d.name} is down`;
      }
      lines.push({ round, side: sideName, text: line });
    }
  };

  while (alive(party).length && alive(enemies).length && round < cfg.maxRounds) {
    round += 1;
    if (partyFirst) {
      turn(party, enemies, 'party');
      turn(enemies, party, 'enemy');
    } else {
      turn(enemies, party, 'enemy');
      turn(party, enemies, 'party');
    }
  }

  const won = alive(enemies).length === 0 && alive(party).length > 0;
  return { won, rounds: round, lines, deaths, partyFirst };
}

// Builds an enemy group for a tile. "ring" = distance from the map centre.
export function makeEnemies(rng, cfg, ring, isBoss, lerpTable) {
  const out = [];
  if (isBoss) {
    const variant = rng.pick(cfg.bosses);
    const seen = new Map();
    for (const u of variant.units) {
      const n = (seen.get(u.name) ?? 0) + 1;
      seen.set(u.name, n);
      out.push({ name: n > 1 ? `${u.name} ${n}` : u.name, hp: u.hp, maxHp: u.hp, power: u.power ?? variant.power, alive: true });
    }
    out.title = variant.title;
    return out;
  }
  const e = cfg.enemies;
  const count = rng.int(e.countMin, e.countMax);
  const power = Math.round(lerpTable(e.powerByRing, ring));
  const used = new Map();
  for (let i = 0; i < count; i++) {
    const base = rng.pick(e.names);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const hp = rng.int(e.hpMin, e.hpMax);
    out.push({ name: n > 1 ? `${base} ${n}` : base, hp, maxHp: hp, power, alive: true });
  }
  return out;
}
