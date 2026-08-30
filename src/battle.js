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

// Power multiplier: powerBase ^ ((attacker power - defender power) / powerStep).
// The exponent is continuous - only the final damage is rounded (see damageFor) - so
// every single point of power moves the number a little.
export function powerMultiplier(cfg, attacker, defender) {
  const step = cfg.powerStep || 1;
  return Math.pow(cfg.powerBase, (attacker.power - defender.power) / step);
}

export function damageFor(rng, cfg, attacker, defender) {
  const base = rollDamage(rng, cfg);
  let mult = powerMultiplier(cfg, attacker, defender);
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

// ----- building enemy groups from the bestiary --------------------------------
// Since 2026-08-31 nothing about a fight is rolled unit by unit: config/units.js
// holds a BESTIARY (battle.enemyTypes: name, shape, colour, hp, power) and a
// table of GROUPS (battle.enemyGroups: a title plus a list of bestiary ids).
// A fight picks one whole GROUP, so what is written in the config is exactly
// what walks onto the arena.

// The band a ring falls into (cfg.enemies.bands, in listed order). Rings past the
// last band's maxRing keep using the last band.
export function ringBand(cfg, ring) {
  const bands = Object.values(cfg.enemies.bands);
  for (const b of bands) if (ring <= b.maxRing) return b;
  return bands[bands.length - 1];
}

// One live enemy from a bestiary id. `shape` and `color` ride along on the unit
// so the arena can build its body without looking the type up again.
export function makeEnemyOfType(cfg, typeId) {
  const t = cfg.enemyTypes?.[typeId];
  if (!t) return null;
  return {
    typeId,
    name: t.name,
    hp: t.hp, maxHp: t.hp,
    power: t.power,
    shape: t.shape ?? 'octahedron',
    color: t.color ?? 0xe2474b,
    alive: true,
  };
}

// Finds a bestiary entry by its DISPLAY name ("Husk 2" -> the husk type), so
// hand-authored lists (scenarios) can name a creature and still get its body.
export function enemyTypeByName(cfg, name) {
  const base = String(name ?? '').replace(/ \d+$/, '');
  for (const [id, t] of Object.entries(cfg.enemyTypes ?? {})) if (t.name === base) return { id, ...t };
  return null;
}

// A whole group by its id. Repeats are numbered ("Husk 2"), and the group's
// title travels with the list for the battle report.
export function makeGroup(cfg, groupId) {
  const g = cfg.enemyGroups?.[groupId];
  if (!g) return [];
  const out = renameDuplicates(g.units.map((id) => makeEnemyOfType(cfg, id)).filter(Boolean));
  out.title = g.title ?? groupId;
  out.groupId = groupId;
  return out;
}

// The power of ONE average enemy on this ring: the mean unit power across every
// group the band can roll. Used where enemies appear outside a group (the Stasis
// "extra enemies" debuff).
export function regularUnitPower(cfg, ring) {
  const b = ringBand(cfg, ring);
  let total = 0, count = 0;
  for (const gid of b.groups ?? []) {
    for (const id of cfg.enemyGroups?.[gid]?.units ?? []) {
      total += cfg.enemyTypes?.[id]?.power ?? 0;
      count += 1;
    }
  }
  return count ? Math.max(1, Math.round(total / count)) : 1;
}

// `count` loose enemies for a tile on `ring`, rolled from the band's
// reinforcement types. (The Stasis "extra enemies" debuff, where there is no
// group to draw.)
export function makeRegulars(rng, cfg, ring, count) {
  const pool = cfg.enemies.reinforcements?.length
    ? cfg.enemies.reinforcements
    : Object.keys(cfg.enemyTypes ?? {});
  const out = [];
  for (let i = 0; i < count; i++) {
    const u = makeEnemyOfType(cfg, rng.pick(pool));
    if (u) out.push(u);
  }
  return out;
}

// Builds an enemy group for a tile. "ring" = distance from the map centre.
// "pool" picks which table the group comes from:
//   'regular' (default) - one of the ring band's groups
//   'boss'              - the Stasis Seed: one of cfg.bosses
//   'colony'            - a Stasis Colony: one of cfg.colonies
// (true is still accepted for 'boss', so older call sites keep working.)
export function makeEnemies(rng, cfg, ring, pool = 'regular') {
  if (pool === true || pool === 'boss') return makeGroup(cfg, rng.pick(cfg.bosses));
  if (pool === 'colony') return makeGroup(cfg, rng.pick(cfg.colonies ?? cfg.bosses));
  const band = ringBand(cfg, ring);
  return makeGroup(cfg, rng.pick(band.groups));
}
