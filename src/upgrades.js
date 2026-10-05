// =====================================================================
//  ABILITY UPGRADES - the rules layer over the trees in config/upgrades.js.
//
//  A party unit carries `upgrades`: an array of unlocked node refs, each the
//  string "<abilityId>:<nodeId>". Everything else is derived on demand:
//    ownedNodes(unit, abilityId)   picked nodes + the auto milestones they earned
//    resolveAbility(id, unlocked)  base def + every owned node, folded in
//    resolvedAbilitiesFor(unit)    { abilityId: resolved def } for the fight
//    resolveUnitStats(unit)        speed / flying / stacks with node deltas folded in
//    triggersFor(unit)             the triggers (passives) the unit is under
//    availableUpgrades(unit)       the unlockable pool (prerequisites met)
//    unlockUpgrade(unit, ref)      adds the node (validated); maxHp applies at once
//
//  No game state lives here - pure functions over the config tables, so the
//  same code serves the world map, the combat engine and the UI.
// =====================================================================
import { ABILITIES } from './config/abilities.js';
import { ABILITY_UPGRADES } from './config/upgrades.js';
import { STATUSES } from './config/statuses.js';
import { COMBAT_TAGS, combatStatsFor } from './config/entities.js';
import { checkEffect, checkTrigger, resolveZones, qtyStatic } from './local/battle/rules.js';
import { t, hasKey } from './i18n.js';
import { tc } from './text.js';

export const upgradeRef = (abilityId, nodeId) => `${abilityId}:${nodeId}`;
export const parseRef = (ref) => {
  const i = ref.indexOf(':');
  return { abilityId: ref.slice(0, i), nodeId: ref.slice(i + 1) };
};
const KNOWN = { statuses: STATUSES, tags: COMBAT_TAGS };

// The ability ids a unit fights with (by unit name; enemies resolve too).
export function unitAbilityIds(name) {
  return combatStatsFor(name).abilities;
}

export function upgradeTree(abilityId) {
  return ABILITY_UPGRADES[abilityId] ?? null;
}

// What an ability DOES, ready to show: the locale's `ability.<id>.desc` when a
// translation defines one, otherwise the definition's own `desc`.
export function abilityDesc(abilityId, config = null) {
  const key = `ability.${abilityId}.desc`;
  if (hasKey(key)) return config ? tc(key, config) : t(key);
  return ABILITIES[abilityId]?.desc ?? '';
}

// What a node is CALLED and what it DOES, ready to show. The node's own
// definition is the source; a locale may override it (upgrade.<ability>.<node>.*).
export function upgradeInfo(abilityId, nodeId) {
  const node = ABILITY_UPGRADES[abilityId]?.[nodeId];
  const key = `upgrade.${abilityId}.${nodeId}`;
  return {
    name: hasKey(`${key}.name`) ? t(`${key}.name`) : (node?.name || nodeId),
    desc: hasKey(`${key}.desc`) ? t(`${key}.desc`) : (node?.desc || ''),
    lore: hasKey(`${key}.lore`) ? t(`${key}.lore`) : (node?.lore || ''),
    icon: node?.icon || '⭐',
    auto: !!node?.auto,
  };
}

// ----- which nodes a unit owns ----------------------------------------------
// The picked nodes of one tree, from the unit's refs.
function pickedNodes(unlocked, abilityId) {
  const have = new Set();
  for (const r of unlocked ?? []) {
    const p = r.includes(':') ? parseRef(r) : { abilityId, nodeId: r };
    if (p.abilityId === abilityId) have.add(p.nodeId);
  }
  return have;
}
// Picked nodes plus the AUTO milestones they have earned: a node with
// `auto: { count: n }` is owned once n picked nodes of the tree are.
export function ownedNodes(unlocked, abilityId) {
  const tree = ABILITY_UPGRADES[abilityId];
  const have = pickedNodes(unlocked, abilityId);
  if (!tree) return have;
  const picked = [...have].filter((n) => tree[n] && !tree[n].auto).length;
  for (const [nodeId, node] of Object.entries(tree)) {
    if (node.auto && picked >= (node.auto.count ?? Infinity)) have.add(nodeId);
  }
  return have;
}

// ----- folding nodes over an ability ----------------------------------------
const isOffsetList = (v) => Array.isArray(v) && v.every((o) => Array.isArray(o) && o.length >= 2 && typeof o[0] === 'number');
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function unionOffsets(zone, offs) {
  const out = zone.map((o) => [...o]);
  const seen = new Set(out.map((o) => `${o[0]},${o[1]}`));
  for (const o of offs) { const k = `${o[0]},${o[1]}`; if (!seen.has(k)) { seen.add(k); out.push([...o]); } }
  return out;
}
// A quantity plus a delta: constants stay a plain number, anything else
// becomes a list of terms (local/battle/rules.js).
export function addQty(q, delta) {
  if (typeof q === 'number' && typeof delta === 'number') return q + delta;
  const terms = (v) => (v === undefined || v === null ? [] : typeof v === 'number' ? [{ n: v }] : Array.isArray(v) ? v.map(clone) : [clone(v)]);
  return [...terms(q), ...terms(delta)];
}
function tuneFields(target, fields, where) {
  for (const [f, v] of Object.entries(fields ?? {})) {
    if (isOffsetList(v) && (target[f] === undefined || isOffsetList(target[f]))) target[f] = unionOffsets(target[f] ?? [], v);
    else if (Array.isArray(v) && Array.isArray(target[f]) && !isOffsetList(target[f])) { for (const x of v) if (!target[f].includes(x)) target[f].push(x); }   // tags
    else if (v && typeof v === 'object' && !Array.isArray(v) && v.n === undefined && v.per === undefined) { target[f] = target[f] ?? {}; tuneFields(target[f], v, where); }   // cost: { hp: 1 }
    else target[f] = addQty(target[f], v);
  }
}
function setFields(target, fields) {
  for (const [f, v] of Object.entries(fields ?? {})) target[f] = clone(v);
}

// Base def + every owned node of this ability, applied in the order the tree
// lists them (so the result never depends on unlock order).
export function resolveAbility(abilityId, unlocked = []) {
  const base = ABILITIES[abilityId];
  if (!base) return null;
  const tree = ABILITY_UPGRADES[abilityId];
  const have = ownedNodes(unlocked, abilityId);
  const def = clone(base);
  def.effects = def.effects.map((e, i) => checkEffect(e, `${abilityId}.effects[${i}]`, KNOWN)).filter(Boolean);
  if (!tree || !have.size) return def;
  const byId = (id) => def.effects.find((e) => e.id === id);
  // The auto milestones fold FIRST, whatever their place in the file: they
  // are the baseline a picked shape node is allowed to overrule.
  const order = Object.entries(tree).sort((a, b) => (b[1].auto ? 1 : 0) - (a[1].auto ? 1 : 0));
  for (const [nodeId, node] of order) {
    if (!have.has(nodeId)) continue;
    const where = `${abilityId}:${nodeId}`;
    // 1. set - replacements
    for (const [id, fields] of Object.entries(node.set ?? {})) {
      if (id === 'cast') { setFields(def, fields); continue; }
      const i = def.effects.findIndex((e) => e.id === id);
      if (fields === null) { if (i >= 0) def.effects.splice(i, 1); continue; }
      if (fields && fields.kind) {
        const e = checkEffect({ id, ...fields }, `${where}.set.${id}`, KNOWN);
        if (!e) continue;
        if (i >= 0) def.effects[i] = e; else def.effects.push(e);
        continue;
      }
      if (i < 0) { console.warn(`[upgrades] ${where} sets fields of an effect "${id}" the ability does not have`); continue; }
      setFields(def.effects[i], fields);
    }
    // 2. tune - additions
    for (const [id, fields] of Object.entries(node.tune ?? {})) {
      if (id === 'cast') { tuneFields(def, fields, where); continue; }
      const e = byId(id);
      if (!e) { console.warn(`[upgrades] ${where} tunes an effect "${id}" the ability does not have`); continue; }
      tuneFields(e, fields, where);
    }
    // 3. new effects
    (node.effects ?? []).forEach((e, i) => {
      const ok = checkEffect(e, `${where}.effects[${i}]`, KNOWN);
      if (ok) def.effects.push(ok);
    });
  }
  // Every effect re-checked after the folding (a set may have changed a kind's
  // fields), then the zones that follow the main hit are read off it as it
  // stands now - after every shape node.
  def.effects = resolveZones(def.effects.map((e, i) => checkEffect(e, `${abilityId}.effects[${i}] (resolved)`, KNOWN)).filter(Boolean), abilityId);
  return def;
}

export function resolvedAbilitiesFor(unit) {
  const out = {};
  for (const id of unitAbilityIds(unit.name)) out[id] = resolveAbility(id, unit.upgrades ?? []);
  return out;
}

// The unit's own numbers with every owned node's `unit` deltas folded in.
// maxHp is NOT here: it is applied to the unit the moment the node is unlocked
// (it is part of the run's state, with the unit's wounds).
export function resolveUnitStats(unit) {
  const cs = combatStatsFor(unit?.name);
  const out = { speed: cs.speed, flying: !!cs.flying, stackMax: cs.stackMax ?? 0, stackGen: cs.stackGen ?? 0 };
  for (const abilityId of unitAbilityIds(unit?.name)) {
    const tree = ABILITY_UPGRADES[abilityId];
    if (!tree) continue;
    const have = ownedNodes(unit?.upgrades ?? [], abilityId);
    for (const nodeId of have) {
      const u = tree[nodeId]?.unit ?? {};
      for (const k of ['speed', 'stackMax', 'stackGen']) if (typeof u[k] === 'number') out[k] += u[k];
    }
  }
  return out;
}

// The TRIGGERS a unit is under (see rules.js). Derived, never stored:
// recomputed from what the unit is right now, so nothing has to remember to
// take one away. Sources: owned upgrade nodes, a carried relic, a world-map
// aura. (An ENEMY's come straight off its bestiary row - see makeEnemyOfType
// in src/battle.js - and the engine parses them the same way.)
export function triggersFor(unit) {
  const out = [];
  const add = (e, where) => { const p = checkTrigger(e, where, KNOWN); if (p) out.push(p); };
  for (const abilityId of unitAbilityIds(unit?.name)) {
    const tree = ABILITY_UPGRADES[abilityId];
    if (!tree) continue;
    const have = ownedNodes(unit?.upgrades ?? [], abilityId);
    for (const [nodeId, node] of Object.entries(tree)) {
      if (!have.has(nodeId)) continue;
      (node.triggers ?? []).forEach((e, i) => add(e, `${abilityId}:${nodeId}.triggers[${i}]`));
    }
  }
  (unit?.relic?.triggers ?? []).forEach((e, i) => add(e, `relic.triggers[${i}]`));
  (unit?.auraTriggers ?? []).forEach((e, i) => add(e, `aura.triggers[${i}]`));
  return out;
}

// The unlockable pool: every node whose prerequisites are met and which is
// not owned and not automatic.
export function availableUpgrades(unit) {
  const out = [];
  for (const abilityId of unitAbilityIds(unit.name)) {
    const tree = ABILITY_UPGRADES[abilityId];
    if (!tree) continue;
    const have = ownedNodes(unit.upgrades ?? [], abilityId);
    for (const [nodeId, node] of Object.entries(tree)) {
      if (have.has(nodeId) || node.auto) continue;
      if (!(node.requires ?? []).every((p) => have.has(p))) continue;
      if ((node.requiresAny ?? []).length && !node.requiresAny.some((p) => have.has(p))) continue;
      out.push({ ref: upgradeRef(abilityId, nodeId), abilityId, nodeId });
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
  const { abilityId, nodeId } = parseRef(ref);
  const hp = ABILITY_UPGRADES[abilityId]?.[nodeId]?.unit?.maxHp;
  if (typeof hp === 'number' && hp) {
    unit.maxHp = Math.max(1, (unit.maxHp ?? unit.hp ?? 1) + hp);
    if (unit.alive !== false) unit.hp = Math.max(0, Math.min(unit.maxHp, (unit.hp ?? 0) + hp));
  }
  return true;
}

export function upgradeCount(unit) {
  return (unit.upgrades ?? []).length;
}

// ----- what an ability amounts to, for a button or a card --------------------
// The headline numbers of a resolved ability: { damage: { amount, times } | null,
// heal, statuses: [ids], tags: [ids], push, dash, cost: { hp, supplies, move } }.
// `evalQ` turns a quantity into a number - qtyStatic (constants only) outside
// a fight, the engine's live evaluation inside one.
export function abilitySummary(ab, evalQ = qtyStatic) {
  const out = { damage: null, heal: 0, statuses: [], tags: [], push: 0, dash: false, throw: false, swap: false, cost: { hp: 0, supplies: 0, move: 0 } };
  if (!ab) return out;
  for (const e of ab.effects ?? []) {
    if (e.kind === 'damage') {
      const amount = evalQ(e.amount), times = Math.max(1, evalQ(e.times));
      if (!out.damage) out.damage = { amount, times, pierce: !!e.pierce };
      else { out.damage.amount += amount; }
    } else if (e.kind === 'heal') out.heal += evalQ(e.amount);
    else if (e.kind === 'status') { if (!out.statuses.includes(e.status)) out.statuses.push(e.status); }
    else if (e.kind === 'tag') { if (!out.tags.includes(e.tag)) out.tags.push(e.tag); }
    else if (e.kind === 'push') out.push = Math.max(out.push, evalQ(e.dist));
    else if (e.kind === 'dash') out.dash = true;
    else if (e.kind === 'throw') out.throw = true;
    else if (e.kind === 'swap') out.swap = true;
  }
  for (const r of ['hp', 'supplies', 'move']) out.cost[r] = evalQ(ab.cost?.[r]);
  return out;
}

// ----- a guard against upgrades that silently do nothing --------------------
// Resolve every node on top of its prerequisites and compare: a node that
// changes neither the ability, nor the unit, nor its triggers is dead. Runs
// once, in dev only, and just complains to the console.
function auditUpgrades() {
  const dead = [];
  for (const [abilityId, tree] of Object.entries(ABILITY_UPGRADES)) {
    if (!ABILITIES[abilityId]) { dead.push(`${abilityId}:* (no such ability)`); continue; }
    for (const [nodeId, node] of Object.entries(tree)) {
      if (node.auto) continue;
      const chain = [];
      const pull = (n) => {
        for (const r of tree[n]?.requires ?? []) pull(r);
        const any = tree[n]?.requiresAny ?? [];
        if (any.length) pull(any[0]);
        if (!chain.includes(n)) chain.push(n);
      };
      pull(nodeId);
      for (const r of [...(node.requires ?? []), ...(node.requiresAny ?? [])]) if (!tree[r]) dead.push(`${upgradeRef(abilityId, nodeId)} requires unknown node "${r}"`);
      const refs = chain.map((n) => upgradeRef(abilityId, n));
      const before = JSON.stringify(resolveAbility(abilityId, refs.slice(0, -1)));
      const after = JSON.stringify(resolveAbility(abilityId, refs));
      const unitDelta = Object.values(node.unit ?? {}).some((v) => v);
      if (before === after && !unitDelta && !(node.triggers ?? []).length) dead.push(upgradeRef(abilityId, nodeId));
    }
  }
  if (dead.length) console.warn('[upgrades] these nodes change nothing when unlocked:', dead.join(', '));
}
try { if (import.meta.env?.DEV) auditUpgrades(); } catch { /* not a Vite build */ }
export { auditUpgrades };

// Layered layout for drawing a tree: nodes grouped by depth (the longest
// prerequisite chain below them), edges as [parentId, childId, kind] where
// kind is 'all' (requires) or 'any' (requiresAny). Auto milestones sit at
// depth 0 with no edges - the drawing marks them.
const warnedRequires = new Set();
function warnUnknownRequire(abilityId, nodeId, req) {
  const key = `${abilityId}:${nodeId}:${req}`;
  if (warnedRequires.has(key)) return;
  warnedRequires.add(key);
  console.warn(`Upgrade tree "${abilityId}": node "${nodeId}" requires "${req}", which is not a node id of that tree.`);
}
export function treeLayout(abilityId) {
  const tree = ABILITY_UPGRADES[abilityId] ?? {};
  const parents = (n) => [...(tree[n]?.requires ?? []), ...(tree[n]?.requiresAny ?? [])].filter((r) => tree[r]);
  const depth = (nodeId, guard = 0) => {
    if (guard > 16) return 0;
    const ps = parents(nodeId);
    return ps.length ? 1 + Math.max(...ps.map((r) => depth(r, guard + 1))) : 0;
  };
  const layers = [];
  const edges = [];
  for (const [nodeId, node] of Object.entries(tree)) {
    const d = depth(nodeId);
    (layers[d] ??= []).push(nodeId);
    for (const r of node.requires ?? []) {
      if (!tree[r]) { warnUnknownRequire(abilityId, nodeId, r); continue; }
      edges.push([r, nodeId, 'all']);
    }
    for (const r of node.requiresAny ?? []) {
      if (!tree[r]) { warnUnknownRequire(abilityId, nodeId, r); continue; }
      edges.push([r, nodeId, 'any']);
    }
  }
  return { layers, edges };
}
