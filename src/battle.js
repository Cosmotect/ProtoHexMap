// Fight building: pure logic, no rendering. Which handcrafted map (and so which
// enemies) a tile gets - see makeArena at the bottom - plus the helpers that turn
// a bestiary row into a live unit. The fight itself is played out by the arena
// (src/local/battle/engine.js); there is no auto-resolve any more.
import { recipeFromCode, mapCodeId } from './local/mapcode.js';

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
// The band a ring falls into (config.map.bands, in listed order). Rings past the
// last band's maxRing keep using the last band. `ringBandId` gives its name, which
// is also the row it uses in the map table. Takes the bands TABLE itself (not the
// whole config) - world.js owns it, next to the world map's own radius.
export function ringBandId(bands, ring) {
  const ids = Object.keys(bands);
  for (const id of ids) if (ring <= bands[id].maxRing) return id;
  return ids[ids.length - 1];
}
export function ringBand(bands, ring) {
  return bands[ringBandId(bands, ring)];
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
  const pool = cfg.reinforcements?.length
    ? cfg.reinforcements
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
// `pool` may also NAME a band directly ('inner' / 'middle' / 'outer', any key of
// config.map.bands). The ring is then ignored, which is what lets a
// fight be pitched at a difficulty the party's location did not choose - the
// starvation ambushes walk that ladder deliberately (game.js).
export function makeArena(rng, config, ring, pool = 'regular', layer = 0) {
  const cfg = config.battle;
  const bands = config.map?.bands ?? {};
  const kind = pool === true || pool === 'boss' ? 'seed'
    : pool === 'colony' ? 'colonies'
    : (typeof pool === 'string' && bands[pool]) ? pool
    : ringBandId(bands, ring);
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
