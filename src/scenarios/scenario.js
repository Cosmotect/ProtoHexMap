// =====================================================================
//  SCENARIO ENGINE - hand-authored maps (the tutorial series).
//
//  A scenario is a plain data object (see src/scenarios/tutorial1.js) that
//  replaces everything the world generator would roll: the tile layout, the
//  encounters with their exact enemy groups and shop stock, the scripted
//  ambushes and the goal that completes the map. Game receives it as a third
//  constructor argument and, where it normally consults the rng, consults the
//  script instead. Everything downstream (renderer, HUD, combat) sees a
//  perfectly ordinary map - just a small, authored one.
//
//  Scenario shape:
//    {
//      id: 'tutorial1',
//      name: localeKeyless id (texts live in the locale tables as scenario.<id>.*),
//      orientation?: 'flat' | 'pointy'   (default: config.map.orientation)
//      start: 'q,r',
//      tiles: { 'q,r': { type, biome?, revealed? } },
//      encounters: {
//        'q,r': { type: 'battle', enemies: [{ name, hp, power }], title?, recipe? }
//        'q,r': { type: 'treasure', supplies? }
//        'q,r': { type: 'shop', stock: ['rest', 'upgrade', ...] }
//        'q,r': { type: 'event', event: '<events.js id>' }
//        'q,r': { type: 'goal' }        // reaching this tile completes the map
//      },
//      party?: [{ name, icon, hp, power }],   // default: the roster's first size entries
//      supplies?: number, maxSupplies?: number,
//      ambushes?: [{ afterSteps, enemies: [...], title? }],  // scripted forced fights
//      goal: { type: 'reach', tile: 'q,r' },  // (more goal types come with later maps)
//      configPatch?: { 'fatigue.byStep': {...}, ... }  // applied by main.js for this run
//      next?: 'tutorial2',                    // the map that follows (used by main.js)
//    }
// =====================================================================
import { enemyTypeByName } from '../battle.js';
import { hexKey, hexDistance, axialToPlane } from '../hex.js';
import { setType, shortestPath } from '../map.js';

// Turns a scenario into the same { hexes, start, seed, colonies, shortestPath,
// bounds, radius, orientation } shape generateMap returns, so Game and the
// renderer need no special cases for the map itself.
export function buildScenarioMap(config, scenario) {
  const orientation = scenario.orientation ?? config.map.orientation;
  const hexSize = config.map.hexSize;
  const hexes = new Map();
  let maxRing = 0;

  for (const [key, def] of Object.entries(scenario.tiles)) {
    const [q, r] = key.split(',').map(Number);
    const plane = axialToPlane(q, r, hexSize, orientation);
    const ring = hexDistance(q, r, 0, 0);
    maxRing = Math.max(maxRing, ring);
    const hex = {
      q, r, ring,
      key: hexKey(q, r),
      biome: def.biome ?? 'grasslands',
      encounter: null,
      isStart: key === scenario.start,
      isSeed: false,
      isColony: false,
      revealed: !!def.revealed,
      visited: false,
      x: plane.x,
      y: plane.y,
    };
    setType(hex, def.type ?? 'ground', config);
    hexes.set(hex.key, hex);
  }

  // Encounters: exact compositions, no rolls.
  for (const [key, enc] of Object.entries(scenario.encounters ?? {})) {
    const hex = hexes.get(key);
    if (!hex) continue;
    hex.encounter = enc.type;
    if (enc.type === 'stasisSeed') hex.isSeed = true;
    if (enc.enemies) {
      hex.enemies = cloneEnemies(enc.enemies, config.battle);
      if (enc.title) hex.enemies.title = enc.title;
    }
    if (enc.stock) hex.shop = { options: [...enc.stock], bought: {}, seen: false };
    if (enc.event) hex.scenarioEvent = enc.event;
    if (enc.supplies != null) hex.scenarioSupplies = enc.supplies;
    if (enc.recipe) hex.recipe = enc.recipe;
  }

  // A scripted Stasis: the Seed comes from a stasisSeed encounter above; the
  // future Colony sites are marked here so Game's ordinary Stasis machinery
  // (lines, spawning, withering) picks them up like on a generated map.
  const seed = [...hexes.values()].find((h) => h.isSeed) ?? null;
  const colonies = [];
  for (const col of scenario.stasis?.colonies ?? []) {
    const hex = hexes.get(col.site);
    if (!hex) continue;
    hex.isColony = true;
    colonies.push(hex);
  }

  const start = hexes.get(scenario.start);
  if (!start) throw new Error(`scenario ${scenario.id}: start tile ${scenario.start} is not in tiles`);

  // Centre the layout on the origin, like the generator does.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const h of hexes.values()) {
    minX = Math.min(minX, h.x); maxX = Math.max(maxX, h.x);
    minY = Math.min(minY, h.y); maxY = Math.max(maxY, h.y);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (const h of hexes.values()) { h.x -= cx; h.y -= cy; }

  // The HUD's route hint: steps to the goal tile (or to a scripted Seed).
  let route = null;
  if (scenario.goal?.type === 'reach') {
    const goalHex = hexes.get(scenario.goal.tile);
    if (goalHex) route = shortestPath(hexes, start, goalHex);
  } else if (scenario.goal?.type === 'seed' && seed) {
    route = shortestPath(hexes, start, seed);
  }

  return {
    hexes,
    start,
    seed,
    colonies,
    shortestPath: route ?? [start],
    bounds: { minX: minX - cx, maxX: maxX - cx, minY: minY - cy, maxY: maxY - cy },
    radius: maxRing,
    orientation,
  };
}

// Fresh battle-ready copies of an authored enemy list.
// A scenario's hand-written enemy list. An entry may name a bestiary id
// (`type: 'husk'`) or just a name; either way the creature's SHAPE and COLOUR
// come from the bestiary (config/units.js, battle.enemyTypes), while hp and
// power written here override it - a scripted fight often wants a weaker husk
// than the wild one.
export function cloneEnemies(list, cfg = null) {
  return list.map((e) => {
    const type = cfg
      ? (e.type ? { id: e.type, ...(cfg.enemyTypes?.[e.type] ?? {}) } : enemyTypeByName(cfg, e.name))
      : null;
    return {
      typeId: type?.id ?? null,
      name: e.name ?? type?.name ?? 'Enemy',
      hp: e.hp ?? type?.hp ?? 10,
      maxHp: e.hp ?? type?.hp ?? 10,
      power: e.power ?? type?.power ?? 0,
      shape: e.shape ?? type?.shape ?? 'octahedron',
      color: e.color ?? type?.color ?? 0xe2474b,
      // The bestiary row's combat half travels too, so a scripted creature
      // fights like its wild cousin unless the script says otherwise.
      init: e.init ?? type?.init,
      speed: e.speed ?? type?.speed,
      flying: e.flying ?? type?.flying,
      abilityIds: e.abilities ?? type?.abilities,
      alive: true,
    };
  });
}
