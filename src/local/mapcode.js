// =====================================================================
//  MAP CODES - handcrafted local maps as plain, human-scannable text.
//
//  A map code is a few header lines and one line per authored tile:
//
//    # comments start with a hash, blank lines are ignored
//    id: the-causeway          required - the map's name
//    radius: 4                 optional - rings of local hexes (default: config.local.radius)
//    danger: 1                 optional - chevrons the world tile advertises (battle maps)
//    q,r: <type> [elevation] [tags...] [!Enemy Name]
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
//  src/config/abilities.js COMBAT_TAGS (e.g. `fire`). `!` pins one enemy to
//  the tile - the rest of the line is a bestiary id or display name from
//  config/units.js battle.enemyTypes ("husk" or "Husk", "Forge Tyrant"...).
//
//  parseMapCode() turns the text into plain data (+ a list of readable
//  errors); buildRecipe() validates it against the config and produces the
//  recipe object src/local/localmap.js applyRecipe / LocalMapView.build eat:
//    { id, danger, radius, tiles: { 'q,r': { type, elevation, tags } },
//      spawns: { enemies: [keys] }, enemyTypeIds: [ids], startTags: [{ k, id }] }
// =====================================================================
import { COMBAT_CONFIG, COMBAT_TAGS } from '../config/abilities.js';
import { neutralElevation } from './localmap.js';

const TYPE_ALIASES = { g: 'ground', ground: 'ground', w: 'wall', wall: 'wall', e: 'ether', ether: 'ether' };

// Text -> plain data. Never throws: everything wrong lands in `errors`, one
// human sentence per problem, with the 1-based line number.
export function parseMapCode(text) {
  const out = { id: null, radius: null, danger: null, tiles: [], errors: [] };
  const lines = String(text ?? '').split('\n');
  const seen = new Set();
  const err = (n, msg) => out.errors.push(`line ${n}: ${msg}`);

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;

    const header = line.match(/^(id|radius|danger)\s*:\s*(.+)$/i);
    if (header) {
      const key = header[1].toLowerCase();
      const value = header[2].trim();
      if (key === 'id') out.id = value;
      else {
        const num = Number(value);
        if (!Number.isInteger(num) || num < 0) { err(n, `${key} must be a whole number, got "${value}"`); return; }
        out[key] = num;
      }
      return;
    }

    const tile = line.match(/^(-?\d+)\s*,\s*(-?\d+)\s*:\s*(.+)$/);
    if (!tile) { err(n, `cannot read "${line}" - expected "id:", "radius:", "danger:" or "q,r: type ..."`); return; }
    const q = Number(tile[1]);
    const r = Number(tile[2]);
    const key = `${q},${r}`;
    if (seen.has(key)) { err(n, `tile ${key} is listed twice`); return; }
    seen.add(key);

    // The body: type, then an optional elevation digit, then tag words, then
    // an optional "!Enemy Name" that runs to the end of the line.
    let body = tile[3].trim();
    let enemy = null;
    const bang = body.indexOf('!');
    if (bang >= 0) {
      enemy = body.slice(bang + 1).trim();
      body = body.slice(0, bang).trim();
      if (!enemy) { err(n, `tile ${key}: "!" without an enemy name`); return; }
    }
    const tokens = body.split(/\s+/).filter(Boolean);
    const type = TYPE_ALIASES[(tokens.shift() ?? '').toLowerCase()];
    if (!type) { err(n, `tile ${key}: unknown tile type (use ground, wall or ether)`); return; }
    let elevation = null;
    if (tokens.length && /^\d+$/.test(tokens[0])) elevation = Number(tokens.shift());
    out.tiles.push({ q, r, key, type, elevation, tags: tokens, enemy, line: n });
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
    const bad = t.tags.some((tag) => !COMBAT_TAGS[tag]);
    if (!bad) tiles[t.key] = { type: t.type, elevation, tags: t.tags.length ? [...t.tags] : null };
  }

  return {
    id: parsed.id ?? 'unnamed',
    danger: parsed.danger ?? null,
    radius,
    tiles,
    spawns: enemies.length ? { enemies: enemies.map((e) => e.key) } : null,
    enemyTypeIds: enemies.map((e) => e.typeId),
    startTags,
    errors,
  };
}

// One call from text to recipe - what the game and the preview window use.
export function recipeFromCode(text, config) {
  return buildRecipe(parseMapCode(text), config);
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
