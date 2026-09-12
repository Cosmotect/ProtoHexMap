// Battle simulation: pure logic, no rendering. Both sides are arrays of units
// { name, hp, maxHp, alive }. Returns a transcript + the outcome.
// Units are mutated in place (the party keeps its wounds).

// Random damage in [min, max], shaped like a bell: average of `dice` uniform rolls.
export function rollDamage(rng, cfg) {
  const dice = Math.max(1, cfg.bellDice | 0);
  let sum = 0;
  for (let i = 0; i < dice; i++) sum += rng.random();
  const t = sum / dice; // 0..1, bell shaped for dice >= 2
  return cfg.damageMin + t * (cfg.damageMax - cfg.damageMin);
}

// `damageMod` is the flat Stasis "damage" debuff (config.stasis.debuffs.damage.amount),
// subtracted from a PLAYER attacker's roll before the desperation bonus - the exact
// same flat penalty the interactive engine applies to a party cast (see dmgMod() in
// local/battle/engine.js). There used to also be a power-ratio multiplier here
// (removed 2026-09-10, enemy strength now comes purely from the abilities a bestiary
// row gives it - see config/units.js battle.enemyTypes).
export function damageFor(rng, cfg, attacker, defender, damageMod = 0) {
  let base = rollDamage(rng, cfg);
  if (attacker.isPlayer && damageMod) base = Math.max(0, base - damageMod);
  // Player units fight harder the closer they are to death.
  if (attacker.isPlayer && cfg.desperation) {
    const missing = 1 - Math.max(0, attacker.hp) / attacker.maxHp;
    base *= 1 + cfg.desperation * missing;
  }
  return Math.max(1, Math.round(base));
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
 * @param damageMod flat Stasis "damage" debuff to apply to party hits (see damageFor)
 */
export function simulateBattle(rng, cfg, party, enemies, partyFirst, damageMod = 0) {
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
      const dmg = damageFor(rng, cfg, a, d, damageMod);
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
// holds a BESTIARY (battle.enemyTypes: name, shape, colour, hp, abilities) and a
// table of GROUPS (battle.enemyGroups: a title plus a list of bestiary ids).
// A fight picks one whole GROUP, so what is written in the config is exactly
// what walks onto the arena.

// The band a ring falls into (cfg.enemies.bands, in listed order). Rings past the
// last band's maxRing keep using the last band. `ringBandId` gives its name, which
// is also the row it uses in the spawn table.
export function ringBandId(cfg, ring) {
  const ids = Object.keys(cfg.enemies.bands);
  for (const id of ids) if (ring <= cfg.enemies.bands[id].maxRing) return id;
  return ids[ids.length - 1];
}
export function ringBand(cfg, ring) {
  return cfg.enemies.bands[ringBandId(cfg, ring)];
}

// The groups one kind of fight may roll on one layer (cfg.spawns, a row per kind
// of fight and a column per layer). An empty cell falls through to the nearest
// FILLED layer of the same row, so a half-finished table still plays.
export function spawnPool(cfg, kind, layer) {
  const row = cfg.spawns?.[kind] ?? {};
  const filled = (n) => (Array.isArray(row[n]) && row[n].length ? row[n] : null);
  const exact = filled(layer);
  if (exact) return exact;
  const near = Object.keys(row).map(Number).filter((n) => filled(n))
    .sort((a, b) => Math.abs(a - layer) - Math.abs(b - layer) || a - b)[0];
  return near === undefined ? [] : row[near];
}

// One live enemy from a bestiary id. `shape` and `color` ride along so the arena
// can build its body without looking the type up again, and so do the COMBAT
// stats (init / speed / flying / abilities) where the row has them - that is
// what makes a creature invented in the Settings window a complete creature and
// not a nameless `default`. A row without them leaves the fields undefined, and
// the engine falls back to party.defaultCombat by name exactly as before.
export function makeEnemyOfType(cfg, typeId) {
  const t = cfg.enemyTypes?.[typeId];
  if (!t) return null;
  return {
    typeId,
    name: t.name,
    hp: t.hp, maxHp: t.hp,
    shape: t.shape ?? 'octahedron',
    color: t.color ?? 0xe2474b,
    init: t.init, speed: t.speed, flying: t.flying, intellect: t.intellect,
    // A creature may carry passives and battle-start statuses the same way a
    // character does; absent on a row that names neither.
    passives: t.passives, applies: t.applies,
    abilityIds: Array.isArray(t.abilities) && t.abilities.length ? [...t.abilities] : undefined,
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

// Builds an enemy group for a tile. "ring" = distance from the map centre,
// "layer" = which layer of the worldflake this run walks. "pool" picks the ROW of
// the spawn table the group comes from:
//   'regular' (default) - the ring band the tile falls into (inner / middle / outer)
//   'boss'              - the Stasis Seed
//   'colony'            - a Stasis Colony
// (true is still accepted for 'boss', so older call sites keep working.)
export function makeEnemies(rng, cfg, ring, pool = 'regular', layer = 0) {
  const kind = pool === true || pool === 'boss' ? 'seed'
    : pool === 'colony' ? 'colonies'
    : ringBandId(cfg, ring);
  const groups = spawnPool(cfg, kind, layer);
  // A row with nothing in it anywhere would leave a fight with no enemies at all;
  // fall back to the whole group table rather than walk into an empty arena.
  const pick = groups.length ? groups : Object.keys(cfg.enemyGroups ?? {});
  return makeGroup(cfg, rng.pick(pick));
}
