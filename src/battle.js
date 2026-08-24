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

// Which unit an enemy swings at: weighted towards healthier targets (weight grows
// with the remaining HP fraction, cfg.healthyTargetBias is the exponent; 0 = uniform).
function pickTarget(rng, cfg, targets) {
  const bias = cfg.healthyTargetBias ?? 0;
  if (!bias || targets.length < 2) return rng.pick(targets);
  const weights = targets.map((t) => 0.2 + Math.pow(Math.max(0, t.hp) / t.maxHp, bias));
  let roll = rng.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < targets.length; i++) {
    roll -= weights[i];
    if (roll < 0) return targets[i];
  }
  return targets[targets.length - 1];
}

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

  // Transcript lines are structured ({attacker, defender, dmg, down}) so the UI can
  // render them through the locale tables.
  const turn = (attackers, defenders, sideName) => {
    for (const a of alive(attackers)) {
      const targets = alive(defenders);
      if (!targets.length) return;
      const d = sideName === 'enemy' ? pickTarget(rng, cfg, targets) : rng.pick(targets);
      const dmg = damageFor(rng, cfg, a, d);
      d.hp = Math.max(0, d.hp - dmg);
      let down = false;
      if (d.hp <= 0) {
        d.alive = false;
        deaths.push(d);
        down = true;
      }
      lines.push({ round, side: sideName, attacker: a.name, defender: d.name, dmg, down });
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

// Appends " 2", " 3"... to repeated names so every unit in a group reads uniquely.
// Mutates and returns the list; safe to call again after adding more units.
export function renameDuplicates(units) {
  const seen = new Map();
  for (const u of units) {
    const base = u.baseName ?? u.name;
    u.baseName = base;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    u.name = n > 1 ? `${base} ${n}` : base;
  }
  return units;
}

// `count` regular enemies for a tile on `ring` (used for normal groups and for the
// Stasis "extra enemies" debuff).
export function makeRegulars(rng, cfg, ring, count, lerpTable) {
  const e = cfg.enemies;
  const power = Math.round(lerpTable(e.powerByRing, ring));
  const out = [];
  for (let i = 0; i < count; i++) {
    const hp = rng.int(e.hpMin, e.hpMax);
    out.push({ name: rng.pick(e.names), hp, maxHp: hp, power, alive: true });
  }
  return out;
}

// Builds an enemy group for a tile. "ring" = distance from the map centre.
// "useBossPool" = roll a variant from cfg.bosses (Stasis Seed and Colonies).
export function makeEnemies(rng, cfg, ring, useBossPool, lerpTable) {
  if (useBossPool) {
    const variant = rng.pick(cfg.bosses);
    const out = renameDuplicates(variant.units.map((u) => ({
      name: u.name, hp: u.hp, maxHp: u.hp, power: u.power ?? variant.power, alive: true,
    })));
    out.title = variant.title;
    return out;
  }
  const e = cfg.enemies;
  const count = rng.int(e.countMin, e.countMax);
  return renameDuplicates(makeRegulars(rng, cfg, ring, count, lerpTable));
}
