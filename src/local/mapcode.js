// =====================================================================
//  MAP CODES - handcrafted local maps as plain, human-scannable text.
//
//  A map code is a few header lines and one line per authored tile:
//
//    # comments start with a hash, blank lines are ignored
//    id: the-causeway          required - the map's id (what the spawn table lists)
//    title: The Causeway       optional - the fight's display name (the battle
//                              log, the Local Map Info panel, the report). It
//                              used to come from the enemy group; since
//                              2026-09-16 a fight IS its map, so the map
//                              carries it. Default: the id, dashes to spaces,
//                              words capitalised.
//    radius: 4                 optional - rings of local hexes (default: config.local.radius)
//    q,r: <type> [elevation] [tags...] [!Enemy Name | @npc]
//
//  Tile lines list ONLY the tiles that differ from plain ground at the
//  neutral elevation; every unlisted tile inside the radius stays that, so a
//  code shows exactly what the author changed. Types:
//    ground   walkable land (default everywhere)
//    wall     a rock column: nobody walks or flies through it, and a unit
//             shoved against it crashes as into the arena rim
//    ether    a hole in the world: nobody walks in, and a unit shoved over
//             it falls out of the world and dies
//  Elevation is a whole level 0..elevationLevels (walls default to the top
//  level, ether has no meaningful height). Tags are tile tag ids from
//  src/config/entities.js COMBAT_TAGS (e.g. `fire`). `!` pins one enemy to
//  the tile - the rest of the line is a bestiary id or display name from
//  config/entities.js battle.enemyTypes ("husk" or "Husk", "Forge Tyrant"...).
//  `@` pins an NPC instead: a non-fighting entity the ENCOUNTER builds
//  (`@shopkeeper` on a shop map is where the keeper stands, see
//  src/local/battle/entity.js Shopkeeper). One occupant per tile.
//
//  parseMapCode() turns the text into plain data (+ a list of readable
//  errors); buildRecipe() validates it against the config and produces the
//  recipe object src/local/localmap.js applyRecipe / LocalMapView.build eat:
//    { id, title, radius, tiles: { 'q,r': { type, elevation, tags } },
//      spawns: { enemies: [keys], npcs: [{ id, key }] }, enemyTypeIds: [ids],
//      startTags: [{ k, id }] }
//  Since 2026-09-16 EVERY fight plays on one of these (there is no random
//  arena generator any more): the map's pinned enemies are the fight's
//  enemies, and config/encounters.js `battleMaps` says which map ids each
//  kind of fight may roll on each layer.
// =====================================================================
import { COMBAT_CONFIG } from '../config/localmap.js';
import { COMBAT_TAGS } from '../config/entities.js';
import { neutralElevation } from './localmap.js';

const TYPE_ALIASES = { g: 'ground', ground: 'ground', w: 'wall', wall: 'wall', e: 'ether', ether: 'ether' };

// Text -> plain data. Never throws: everything wrong lands in `errors`, one
// human sentence per problem, with the 1-based line number.
export function parseMapCode(text) {
  const out = { id: null, title: null, radius: null, tiles: [], errors: [] };
  const lines = String(text ?? '').split('\n');
  const seen = new Set();
  const err = (n, msg) => out.errors.push(`line ${n}: ${msg}`);

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;

    const header = line.match(/^(id|title|radius)\s*:\s*(.+)$/i);
    if (header) {
      const key = header[1].toLowerCase();
      const value = header[2].trim();
      if (key === 'id') out.id = value;
      else if (key === 'title') out.title = value;
      else {
        const num = Number(value);
        if (!Number.isInteger(num) || num < 0) { err(n, `${key} must be a whole number, got "${value}"`); return; }
        out[key] = num;
      }
      return;
    }

    const tile = line.match(/^(-?\d+)\s*,\s*(-?\d+)\s*:\s*(.+)$/);
    if (!tile) { err(n, `cannot read "${line}" - expected "id:", "radius:" or "q,r: type ..."`); return; }
    const q = Number(tile[1]);
    const r = Number(tile[2]);
    const key = `${q},${r}`;
    if (seen.has(key)) { err(n, `tile ${key} is listed twice`); return; }
    seen.add(key);

    // The body: type, then an optional elevation digit, then tag words, then
    // an optional "!Enemy Name" or "@npc" that runs to the end of the line.
    let body = tile[3].trim();
    let enemy = null;
    let npc = null;
    const bang = body.indexOf('!');
    const at = body.indexOf('@');
    if (bang >= 0 && at >= 0) { err(n, `tile ${key}: one occupant per tile (an enemy or an NPC, not both)`); return; }
    if (bang >= 0) {
      enemy = body.slice(bang + 1).trim();
      body = body.slice(0, bang).trim();
      if (!enemy) { err(n, `tile ${key}: "!" without an enemy name`); return; }
    } else if (at >= 0) {
      npc = body.slice(at + 1).trim();
      body = body.slice(0, at).trim();
      if (!/^[a-zA-Z][\w-]*$/.test(npc)) { err(n, `tile ${key}: "@" needs an NPC id (letters, digits, dashes)`); return; }
    }
    const tokens = body.split(/\s+/).filter(Boolean);
    const type = TYPE_ALIASES[(tokens.shift() ?? '').toLowerCase()];
    if (!type) { err(n, `tile ${key}: unknown tile type (use ground, wall or ether)`); return; }
    let elevation = null;
    if (tokens.length && /^\d+$/.test(tokens[0])) elevation = Number(tokens.shift());
    out.tiles.push({ q, r, key, type, elevation, tags: tokens, enemy, npc, line: n });
  });

  if (!out.id) out.errors.push('the code has no "id:" line');
  return out;
}

// Plain data -> the validated recipe the local map builder consumes.
// `config` is the game CONFIG (bestiary + local settings). Any problem is a
// readable sentence in recipe.errors; a recipe with errors must not be used.
export function buildRecipe(parsed, config) {
  const errors = [...parsed.errors];
  const levels = COMBAT_CONFIG.combat.elevationLevels;
  const mid = neutralElevation(levels);
  const radius = parsed.radius ?? config.local.radius;
  if (radius < 1 || radius > 12) errors.push(`radius ${radius} is out of range (1..12)`);

  const tiles = {};
  const enemies = [];
  const npcs = [];
  const startTags = [];

  for (const t of parsed.tiles) {
    if (Math.max(Math.abs(t.q), Math.abs(t.r), Math.abs(t.q + t.r)) > radius) {
      errors.push(`line ${t.line}: tile ${t.key} is outside radius ${radius}`);
      continue;
    }
    let elevation = t.elevation;
    if (elevation == null) elevation = t.type === 'wall' ? levels : mid;
    if (elevation < 0 || elevation > levels) {
      errors.push(`line ${t.line}: tile ${t.key} elevation ${elevation} is out of range (0..${levels})`);
      continue;
    }
    for (const tag of t.tags) {
      if (!COMBAT_TAGS[tag]) { errors.push(`line ${t.line}: tile ${t.key} has unknown tag "${tag}"`); continue; }
      startTags.push({ k: t.key, id: tag });
    }
    if (t.enemy) {
      const typeId = resolveEnemyType(config.battle, t.enemy);
      if (!typeId) errors.push(`line ${t.line}: tile ${t.key} names unknown enemy "${t.enemy}"`);
      else if (t.type !== 'ground') errors.push(`line ${t.line}: enemy "${t.enemy}" cannot stand on a ${t.type} tile`);
      else enemies.push({ typeId, key: t.key });
    }
    if (t.npc) {
      if (t.type !== 'ground') errors.push(`line ${t.line}: NPC "${t.npc}" cannot stand on a ${t.type} tile`);
      else npcs.push({ id: t.npc, key: t.key });
    }
    const bad = t.tags.some((tag) => !COMBAT_TAGS[tag]);
    if (!bad) tiles[t.key] = { type: t.type, elevation, tags: t.tags.length ? [...t.tags] : null };
  }

  const id = parsed.id ?? 'unnamed';
  return {
    id,
    title: parsed.title ?? titleFromId(id),
    radius,
    tiles,
    spawns: enemies.length || npcs.length ? { enemies: enemies.map((e) => e.key), npcs } : null,
    enemyTypeIds: enemies.map((e) => e.typeId),
    startTags,
    errors,
  };
}

// One call from text to recipe - what the game and the preview window use.
export function recipeFromCode(text, config) {
  return buildRecipe(parseMapCode(text), config);
}

// "ember-hollow" -> "Ember Hollow": the display name of a map whose code has
// no `title:` line.
export function titleFromId(id) {
  return String(id ?? '').split(/[-_\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The id a code declares, without building the whole recipe - what indexes
// the crafted map list by id (src/battle.js craftedMapIndex).
export function mapCodeId(text) {
  return headerLine(text, 'id');
}
// The display name a code declares (`title:`), or the one derived from its id.
export function mapCodeTitle(text) {
  return headerLine(text, 'title') ?? titleFromId(mapCodeId(text));
}
function headerLine(text, key) {
  const m = String(text ?? '').match(new RegExp(`^\\s*${key}\\s*:\\s*([^#\\n]+)`, 'im'));
  return m ? m[1].trim() : null;
}

// A bestiary reference by id ("husk") or display name ("Husk", "Forge Tyrant").
function resolveEnemyType(battleCfg, ref) {
  const types = battleCfg?.enemyTypes ?? {};
  if (types[ref]) return ref;
  const lower = String(ref).toLowerCase();
  for (const [id, t] of Object.entries(types)) {
    if (id.toLowerCase() === lower || String(t.name).toLowerCase() === lower) return id;
  }
  return null;
}
