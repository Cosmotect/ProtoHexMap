// =====================================================================
//  ABILITY UPGRADES - the rules layer over the trees in config/abilities.js.
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
import { ABILITIES, ABILITY_UPGRADES, STATUSES, grantCheck } from './config/abilities.js';
import { combatStatsFor } from './config/units.js';
import { t, hasKey } from './i18n.js';
import { tc } from './text.js';

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

// What an ability DOES, ready to show: the locale's `ability.<id>.desc` when a
// translation defines one, otherwise the definition's own `desc`, otherwise
// nothing. (Never the raw key - printing "ability.clawSwipe.desc" at the player
// is what happens when a lookup has no fallback.)
export function abilityDesc(abilityId, config = null) {
  const key = `ability.${abilityId}.desc`;
  if (hasKey(key)) return config ? tc(key, config) : t(key);
  return ABILITIES[abilityId]?.desc ?? '';
}

// What a node is CALLED and what it DOES, ready to show.
//
// The node's own definition is the source (config/abilities.js). A locale may
// override it - `upgrade.<ability>.<node>.name` / `.desc` - which is how the
// Russian table still translates them; English simply has no such keys any
// more, so the definition speaks for itself. Before 2026-09-11 the locale was
// the ONLY source, so a node's effect and the sentence describing it lived in
// different files and drifted apart.
export function upgradeInfo(abilityId, nodeId) {
  const node = ABILITY_UPGRADES[abilityId]?.[nodeId];
  const key = `upgrade.${abilityId}.${nodeId}`;
  return {
    name: hasKey(`${key}.name`) ? t(`${key}.name`) : (node?.name || nodeId),
    desc: hasKey(`${key}.desc`) ? t(`${key}.desc`) : (node?.desc || ''),
    icon: node?.icon || '⭐',
  };
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
    // `cost` is an OBJECT, so it needs its own copy for the same reason the
    // zones do - without one, an upgraded ability would write its cost into the
    // config table that every other unit reads.
    cost: { ...(base.cost ?? {}) },
    // buffX is a LIST (one entry per knob of the status this ability applies), so
    // it needs a copy of its own - otherwise an upgraded ability would write into
    // the config table every unit reads.
    buffX: Array.isArray(base.buffX) ? [...base.buffX] : base.buffX,
  };
  // A numeric bump. Plain numbers add; a LIST (buffX, one entry per status knob)
  // adds slot by slot, and a slot the bump does not name is left as it was.
  const addUp = (cur, v) => {
    if (!Array.isArray(cur) && !Array.isArray(v)) return (cur ?? 0) + v;
    const base = Array.isArray(cur) ? cur : [cur];
    const bump = Array.isArray(v) ? v : [v];
    const out = [];
    for (let i = 0; i < Math.max(base.length, bump.length); i++) {
      const b = Number(bump[i]);
      out.push(Number.isFinite(b) ? Number(base[i] ?? 0) + b : (base[i] ?? null));
    }
    return out;
  };
  const addZone = (zone, offs) => {
    const seen = new Set(zone.map((o) => `${o[0]},${o[1]}`));
    for (const o of offs) { const k = `${o[0]},${o[1]}`; if (!seen.has(k)) { seen.add(k); zone.push(o); } }
  };
  for (const [nodeId, node] of Object.entries(tree)) {
    if (!have.has(nodeId)) continue;
    for (const [k, v] of Object.entries(node.add ?? {})) def[k] = addUp(def[k], v);
    // `costAdd: { hp, supplies, move }` - each entry is SUMMED onto the base
    // cost, so a node can make an ability cheaper (negative) or dearer, and two
    // nodes touching the same resource stack. It is its own field rather than
    // part of `add` because `add` works on plain numbers and a cost is a record.
    for (const [k, v] of Object.entries(node.costAdd ?? {})) def.cost[k] = (def.cost[k] ?? 0) + v;
    if (node.castZoneAdd?.length) addZone(def.castZone, node.castZoneAdd);
    if (node.dmgZoneAdd?.length) addZone(def.dmgZone, node.dmgZoneAdd);
    if (node.tagZoneAdd?.length) addZone(def.tagZone, node.tagZoneAdd);
    if (node.pushDistAdd) for (const p of def.pushZone) p[3] = (p[3] ?? 1) + node.pushDistAdd;
    Object.assign(def.flags, node.flags ?? {});
  }
  return def;
}

// ----- a guard against upgrades that silently do nothing --------------------
// `addZone` deduplicates, so an upgrade that adds tiles the ability ALREADY
// covers is a no-op - it unlocks, it shows in the tree, and it changes nothing.
// That is exactly how clawSwipe's Cleave sat broken: it added two tiles to a
// cast zone that was already the whole ring. Nothing in the data says a node is
// meant to matter, so the only way to catch it is to resolve every node and
// compare. This runs once, in dev only, and just complains to the console.
function auditUpgrades() {
  const same = (a, b) => ['damage', 'heal'].every((k) => a[k] === b[k])
    && ['castZone', 'dmgZone', 'tagZone'].every((k) => a[k].length === b[k].length)
    && JSON.stringify(a.pushZone) === JSON.stringify(b.pushZone)
    && JSON.stringify(a.cost) === JSON.stringify(b.cost)
    && JSON.stringify(a.buffX) === JSON.stringify(b.buffX);
  const dead = [];
  for (const [abilityId, tree] of Object.entries(ABILITY_UPGRADES)) {
    if (!ABILITIES[abilityId]) { dead.push(`${abilityId}:* (no such ability)`); continue; }
    for (const nodeId of Object.keys(tree)) {
      // Judge the node on top of the state it actually arrives in: its own
      // prerequisites unlocked, itself not.
      const chain = [];
      const pull = (n) => { for (const r of tree[n]?.requires ?? []) pull(r); if (!chain.includes(n)) chain.push(n); };
      pull(nodeId);
      const refs = chain.map((n) => upgradeRef(abilityId, n));
      if (same(resolveAbility(abilityId, refs.slice(0, -1)), resolveAbility(abilityId, refs))) {
        dead.push(upgradeRef(abilityId, nodeId));
      }
    }
  }
  if (dead.length) console.warn('[upgrades] these nodes change nothing when unlocked:', dead.join(', '));
}
try { if (import.meta.env?.DEV) auditUpgrades(); } catch { /* not a Vite build */ }

// { abilityId: resolved def } for every ability the unit knows - what the
// combat engine fights with.
// The PASSIVES a unit is under. Derived, never stored: recomputed from what the
// unit is right now, so nothing has to remember to take one away. Today that is
// the `grants` of its unlocked upgrade nodes; a relic it carries and a world-map
// aura it stands in are the next two sources and slot in here, with no change to
// anything downstream.
//
// Worked out when a FIGHT STARTS (main.js hands the list to createBattle) and
// fixed for its duration - none of the three sources can change mid-fight, and
// recomputing per fight is exactly what makes walking out of an aura's radius
// drop the passive by itself.
export function passivesFor(unit) {
  const out = [];
  const add = (id) => {
    if (!id || out.includes(id)) return;
    const bad = grantCheck(id);
    // A row that is spent by use cannot be a passive: say so loudly rather than
    // hand the engine something it will try to consume.
    if (bad) { console.warn('passive refused:', bad); return; }
    out.push(id);
  };
  const unlocked = new Set(unit?.upgrades ?? []);
  for (const abilityId of unitAbilityIds(unit?.name)) {
    const tree = ABILITY_UPGRADES[abilityId];
    if (!tree) continue;
    for (const [nodeId, node] of Object.entries(tree)) {
      if (!unlocked.has(upgradeRef(abilityId, nodeId))) continue;
      for (const id of node.grants ?? []) add(id);
    }
  }
  // A carried relic grants its own while it is carried (relics are not items yet;
  // when they are, this is the whole hook).
  for (const id of unit?.relic?.passives ?? []) add(id);
  // Standing inside a world-map aura, decided by the world map before the fight.
  for (const id of unit?.auraPassives ?? []) add(id);
  return out;
}

// Statuses this unit gets AT A MOMENT rather than carries forever - the other
// half of passivesFor, gathered from the same three sources and in the same way.
// Each entry is { status, when, x }; `when` is a plain string, so a new moment is
// a new moment and not a new system.
export function appliesFor(unit) {
  const out = [];
  const add = (e) => {
    if (!e || !e.status || !e.when) return;
    if (!STATUSES[e.status]) { console.warn('applies: no status row named', e.status); return; }
    out.push({ status: e.status, when: e.when, x: e.x ?? null });
  };
  const unlocked = new Set(unit?.upgrades ?? []);
  for (const abilityId of unitAbilityIds(unit?.name)) {
    const tree = ABILITY_UPGRADES[abilityId];
    if (!tree) continue;
    for (const [nodeId, node] of Object.entries(tree)) {
      if (!unlocked.has(upgradeRef(abilityId, nodeId))) continue;
      for (const e of node.applies ?? []) add(e);
    }
  }
  for (const e of unit?.relic?.applies ?? []) add(e);
  for (const e of unit?.auraApplies ?? []) add(e);
  return out;
}

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
