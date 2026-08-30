// =====================================================================
//  ABILITY UPGRADES - the rules layer over config/upgrades.js.
//
//  A party unit carries `upgrades`: an array of unlocked node refs, each the
//  string "<abilityId>:<nodeId>". Everything else is derived on demand:
//    resolveAbility(id, unlocked)  base def + every unlocked node, folded in
//    resolvedAbilitiesFor(unit)    { abilityId: resolved def } for the fight
//    availableUpgrades(unit)       the unlockable pool (all parents unlocked)
//    unlockUpgrade(unit, ref)      adds the node (validated)
//
//  No game state lives here - pure functions over the config tables, so the
//  same code serves the world map, the combat engine and the UI.
// =====================================================================
import { ABILITIES, combatStatsFor } from './config/abilities.js';
import { ABILITY_UPGRADES } from './config/upgrades.js';

export const upgradeRef = (abilityId, nodeId) => `${abilityId}:${nodeId}`;
export const parseRef = (ref) => {
  const i = ref.indexOf(':');
  return { abilityId: ref.slice(0, i), nodeId: ref.slice(i + 1) };
};

// The ability ids a unit fights with (by unit name; enemies resolve too).
export function unitAbilityIds(name) {
  return combatStatsFor(name).abilities;
}

export function upgradeTree(abilityId) {
  return ABILITY_UPGRADES[abilityId] ?? null;
}

// Base def + every unlocked node of this ability, applied in the order the
// tree lists them (so the result never depends on unlock order). Zone offsets
// are deduplicated; flags merge (any node can flip one on).
export function resolveAbility(abilityId, unlocked = []) {
  const base = ABILITIES[abilityId];
  if (!base) return null;
  const tree = ABILITY_UPGRADES[abilityId];
  const have = new Set(unlocked.map((r) => (r.includes(':') ? parseRef(r) : { abilityId, nodeId: r }))
    .filter((p) => p.abilityId === abilityId).map((p) => p.nodeId));
  if (!tree || !have.size) return base;

  const def = { ...base,
    castZone: [...base.castZone], dmgZone: [...base.dmgZone], tagZone: [...base.tagZone],
    pushZone: base.pushZone.map((p) => [...p]), flags: { ...(base.flags ?? {}) },
  };
  const addZone = (zone, offs) => {
    const seen = new Set(zone.map((o) => `${o[0]},${o[1]}`));
    for (const o of offs) { const k = `${o[0]},${o[1]}`; if (!seen.has(k)) { seen.add(k); zone.push(o); } }
  };
  for (const [nodeId, node] of Object.entries(tree)) {
    if (!have.has(nodeId)) continue;
    for (const [k, v] of Object.entries(node.add ?? {})) def[k] = (def[k] ?? 0) + v;
    if (node.castZoneAdd?.length) addZone(def.castZone, node.castZoneAdd);
    if (node.dmgZoneAdd?.length) addZone(def.dmgZone, node.dmgZoneAdd);
    if (node.tagZoneAdd?.length) addZone(def.tagZone, node.tagZoneAdd);
    if (node.pushDistAdd) for (const p of def.pushZone) p[3] = (p[3] ?? 1) + node.pushDistAdd;
    Object.assign(def.flags, node.flags ?? {});
  }
  return def;
}

// { abilityId: resolved def } for every ability the unit knows - what the
// combat engine fights with.
export function resolvedAbilitiesFor(unit) {
  const out = {};
  for (const id of unitAbilityIds(unit.name)) out[id] = resolveAbility(id, unit.upgrades ?? []);
  return out;
}

// The unlockable pool: every node (across all the unit's ability trees) whose
// parents are ALL unlocked and which is not unlocked itself.
export function availableUpgrades(unit) {
  const unlocked = new Set(unit.upgrades ?? []);
  const out = [];
  for (const abilityId of unitAbilityIds(unit.name)) {
    const tree = ABILITY_UPGRADES[abilityId];
    if (!tree) continue;
    for (const [nodeId, node] of Object.entries(tree)) {
      const ref = upgradeRef(abilityId, nodeId);
      if (unlocked.has(ref)) continue;
      if ((node.requires ?? []).every((p) => unlocked.has(upgradeRef(abilityId, p)))) {
        out.push({ ref, abilityId, nodeId });
      }
    }
  }
  return out;
}

// Adds the node to the unit; false if it is unknown, taken or still gated.
export function unlockUpgrade(unit, ref) {
  if (!unit.upgrades) unit.upgrades = [];
  if (unit.upgrades.includes(ref)) return false;
  if (!availableUpgrades(unit).some((u) => u.ref === ref)) return false;
  unit.upgrades.push(ref);
  return true;
}

export function upgradeCount(unit) {
  return (unit.upgrades ?? []).length;
}

// Layered layout for drawing a tree: nodes grouped by depth (the longest
// requires-chain below them), edges as [parentId, childId]. Small trees only -
// this walks the whole graph per node.
export function treeLayout(abilityId) {
  const tree = ABILITY_UPGRADES[abilityId] ?? {};
  const depth = (nodeId, guard = 0) => {
    if (guard > 12) return 0;
    const reqs = tree[nodeId]?.requires ?? [];
    return reqs.length ? 1 + Math.max(...reqs.map((r) => depth(r, guard + 1))) : 0;
  };
  const layers = [];
  const edges = [];
  for (const [nodeId, node] of Object.entries(tree)) {
    const d = depth(nodeId);
    (layers[d] ??= []).push(nodeId);
    for (const r of node.requires ?? []) edges.push([r, nodeId]);
  }
  return { layers, edges };
}
