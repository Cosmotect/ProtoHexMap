// Battle simulation: pure logic, no rendering. Both sides are arrays of units
// { name, hp, maxHp, alive }. Returns a transcript + the outcome.
// Units are mutated in place (the party keeps its wounds).
// The second half of the file builds fights: which handcrafted map (and so
// which enemies) a tile gets - see makeArena at the bottom.
import { recipeFromCode, mapCodeId } from './local/mapcode.js';

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
// row gives it - see config/entities.js battle.enemyTypes).
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

// ----- building fights from the bestiary and the handcrafted maps ----------
// Since 2026-09-16 a fight IS its map: config/encounters.js holds the MAP
// CODES (craftedMaps.combat.maps, src/local/mapcode.js) and a table of which
// map ids each kind of fight may roll on each layer (battleMaps, wired in as
// battle.maps). A map pins its own enemies to its own tiles, so what is
// written in the code is exactly what walks onto the arena - there is no
// separate enemy GROUP any more (battle.enemyGroups went with the random
// arena generator), and no arena is rolled at all: makeArena() below picks
// one authored map and returns its recipe together with its enemies.
// The band a ring falls into (cfg.enemies.bands, in listed order). Rings past the
// last band's maxRing keep using the last band. `ringBandId` gives its name, which
// is also the row it uses in the map table.
export function ringBandId(cfg, ring) {
  const ids = Object.keys(cfg.enemies.bands);
  for (const id of ids) if (ring <= cfg.enemies.bands[id].maxRing) return id;
  return ids[ids.length - 1];
}
export function ringBand(cfg, ring) {
  return cfg.enemies.bands[ringBandId(cfg, ring)];
}

// The map ids one kind of fight may roll on one layer (cfg.maps, a row per kind
// of fight and a column per layer). An empty cell falls through to the nearest
// FILLED layer of the same row, so a half-finished table still plays.
export function arenaPool(cfg, kind, layer) {
  const row = cfg.maps?.[kind] ?? {};
  const filled = (n) => (Array.isArray(row[n]) && row[n].length ? row[n] : null);
  const exact = filled(layer);
  if (exact) return exact;
  const near = Object.keys(row).map(Number).filter((n) => filled(n))
    .sort((a, b) => Math.abs(a - layer) - Math.abs(b - layer) || a - b)[0];
  return near === undefined ? [] : row[near];
}

// The crafted combat maps by id: { id: code }. Read off the code's own `id:`
// line, so the list in config stays a plain list of pasteable codes. Cached
// per list instance - the Settings window replaces the whole list when it
// edits it, which invalidates the cache by itself.
const indexCache = new WeakMap();
export function craftedMapIndex(config) {
  const list = config.craftedMaps?.combat?.maps;
  if (!Array.isArray(list)) return {};
  let idx = indexCache.get(list);
  if (!idx) {
    idx = {};
    for (const code of list) {
      const id = mapCodeId(code);
      if (!id) { console.warn('crafted map without an "id:" line skipped'); continue; }
      if (idx[id]) console.warn(`crafted map id "${id}" is listed twice; the later code wins`);
      idx[id] = code;
    }
    indexCache.set(list, idx);
  }
  return idx;
}

// The recipe for one map id, or null (with a console warning) when the id is
// unknown or its code does not parse - a typo in a config map must never
// take the run down with it.
export function craftedMapById(config, id) {
  const code = craftedMapIndex(config)[id];
  if (!code) { console.warn(`crafted map "${id}" is not in config.craftedMaps.combat.maps`); return null; }
  const recipe = recipeFromCode(code, config);
  if (recipe.errors.length) { console.warn(`crafted map "${id}" skipped:`, recipe.errors.join('; ')); return null; }
  return recipe;
}

// The enemies a recipe pins, as live units (numbered "Husk 2"...), carrying the
// map's title and id for the battle log / report.
export function enemiesOfRecipe(cfg, recipe) {
  const out = renameDuplicates((recipe?.enemyTypeIds ?? []).map((id) => makeEnemyOfType(cfg, id)).filter(Boolean));
  out.title = recipe?.title ?? null;
  out.mapId = recipe?.id ?? null;
  return out;
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
    // A creature may carry triggers the same way an upgrade node does (see
    // TRIGGERS in config/abilities.js); absent on a row that names none.
    triggers: Array.isArray(t.triggers) ? [...t.triggers] : undefined,
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

// Picks the arena (and so the enemies) for a tile. "ring" = distance from the
// map centre, "layer" = which layer of the worldflake this run walks. "pool"
// picks the ROW of the map table the arena comes from:
//   'regular' (default) - the ring band the tile falls into (inner / middle / outer)
//   'boss'              - the Stasis Seed
//   'colony'            - a Stasis Colony
// (true is still accepted for 'boss', so older call sites keep working.)
// Returns { recipe, enemies }. A row with nothing in it anywhere, or whose
// every map is broken, falls back to the whole crafted list rather than walk
// into an empty arena; with no usable map at all the fight is a flat arena
// with no enemies - and a console warning says so.
export function makeArena(rng, config, ring, pool = 'regular', layer = 0) {
  const cfg = config.battle;
  const kind = pool === true || pool === 'boss' ? 'seed'
    : pool === 'colony' ? 'colonies'
    : ringBandId(cfg, ring);
  const ids = arenaPool(cfg, kind, layer);
  const pick = ids.length ? ids : Object.keys(craftedMapIndex(config));
  // Roll once; only if that map is broken walk the rest of the cell in order,
  // so a bad code costs one warning and not a different roll for every tile.
  let recipe = null;
  if (pick.length) {
    const at = Math.floor(rng.random() * pick.length);
    for (let i = 0; i < pick.length && !recipe; i++) recipe = craftedMapById(config, pick[(at + i) % pick.length]);
  }
  if (!recipe) console.warn(`no usable crafted map for a "${kind}" fight on layer ${layer}`);
  return { recipe, enemies: enemiesOfRecipe(cfg, recipe) };
}
