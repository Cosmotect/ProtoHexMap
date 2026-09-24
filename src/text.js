// Text generated from the config at runtime, so that changing a number in config/*.js
// changes the legend and the new player experience automatically. No rule numbers are
// hardcoded here: everything is read from CONFIG, every word comes from the locale tables.
import { t, joinList } from './i18n.js';

const pct = (f) => `${Math.round(f * 100)}%`;

// Placeholders usable inside locale strings (visual.*.info, npe.*).
export function placeholders(config) {
  const c = config;
  return {
    colonyCount: c.stasis.colonyCount,
    rewardPicks: c.stasis.rewardPicks,
    witherHp: c.biomes.wither?.hpCost ?? 0,
    witherEvery: c.stasis.witherEvery,
    debuffMaxHpPct: pct(c.stasis.debuffs.maxHp.fraction),
    debuffDamage: c.stasis.debuffs.damage.amount,
    debuffExtraEnemies: c.stasis.debuffs.extraEnemies.count,
    campCost: c.rest.cost,
    healPct: pct(c.rest.healFraction),
    shopRestCost: c.shop.restCost,
    upgradeCost: c.shop.upgradeCost,
    mapCost: c.shop.mapCost,
    relicCost: c.shop.relicCost,
    rumorsCost: c.shop.rumorsCost,
    sparePartsCost: c.shop.sparePartsCost,
    shopRandomCount: c.shop.randomCount,
    mapTiles: c.events.blobSize,
    treasureSupplies: c.treasure.supplies,
    startSupplies: c.run.startSupplies,
    // The CEILING, its own config knob since 2026-09-22. This used to read
    // run.startSupplies, which was right only while the two were the same number
    // - every "supplies cannot exceed {maxSupplies}" line was quietly wrong the
    // moment they parted.
    maxSupplies: c.run.maxSupplies ?? c.run.startSupplies,
    stepSupplyCost: c.run.stepSupplyCost ?? 0,
    revivePct: pct(c.acolyte.reviveFraction),
    acolyteMin: c.encounters.guaranteed?.acolyte ?? 0,
    // The danger scale (absolute chevron counts, config.battle.danger).
    colonyChevrons: c.battle.danger.colony,
    seedChevrons: c.battle.danger.seed,
    unitCount: c.party.size ?? 3,
    damageMin: c.battle.damageMin,
    damageMax: c.battle.damageMax,
    victorySupplies: c.battle.victorySupplies ?? 0,
    // The Hack terminal (config.hack): its turn budget and badge thresholds.
    turns: c.hack?.turns ?? 5,
    badge1: c.hack?.badges?.[0] ?? '?', badge2: c.hack?.badges?.[1] ?? '?', badge3: c.hack?.badges?.[2] ?? '?',
  };
}

// Translates a key with the config placeholders (plus any extra params).
export function tc(key, config, extra = {}) {
  return t(key, { ...placeholders(config), ...extra });
}

// A handful of lines end with "...and resets fatigue" - true while the mechanic
// is on, a promise about nothing while it is off (DISABLED as an experiment on
// 2026-09-22). Each of those keys has a twin named "<key>.nofatigue" that simply
// stops before the clause; this picks between them off the config, so the wording
// follows the switch instead of having to be remembered.
export function tFatigue(key, config, extra = {}) {
  return tc(config.fatigue?.enabled === false ? `${key}.nofatigue` : key, config, extra);
}

// Encounter label / info from the locale tables.
export function encounterLabel(type) { return t(`visual.${type}.label`); }

// The legend entry for an encounter: its own description, plus ONE generated
// sentence about being dragged into it. That sentence used to be written into
// each visual.*.info string by hand, which made every one of them a lie the
// moment the rule changed; it is now read off the config like everything else
// in this file (2026-09-22).
//   fatigue on:  "Fatigue can force you into it."
//   fatigue off: "Walking onto this tile always drags you in."
//   neither:     nothing - except the handful of types that say outright that
//                they can never be forced (visual.<type>.neverForced: true).
export function encounterInfo(type, config) {
  const base = tc(`visual.${type}.info`, config);
  const forceable = (config.fatigue?.forceable ?? []).includes(type);
  if (!forceable) {
    return config.encounters?.visuals?.[type]?.neverForced ? `${base} ${t('visual.forced.never')}` : base;
  }
  return `${base} ${t(config.fatigue?.enabled === false ? 'visual.forced.always' : 'visual.forced.fatigue')}`;
}
export function terrainName(name) { return t(`terrain.${name}`); }

// One sentence per terrain, built from its numbers. `config` is optional only so
// that an old two-argument call still works; pass it, or the walking cost line
// (run.stepSupplyCost) is left out.
export function terrainInfo(name, tr, config = null) {
  const parts = [t(`terrain.${name}.flavour`)];
  const stepCost = config?.run?.stepSupplyCost ?? 0;
  if (!tr.passable) parts.push(t('terrain.impassable'));
  else if (tr.supplyCost > 0 || tr.hpCost > 0) {
    const costs = [];
    if (tr.supplyCost > 0) costs.push(t('terrain.cost.supplies', { n: tr.supplyCost }));
    if (tr.hpCost > 0) costs.push(t('terrain.cost.hp', { n: tr.hpCost }));
    parts.push(t('terrain.costly', { costs: joinList(costs) }));
    parts.push(t('terrain.costly.climbOnly'));
  } else parts.push(t('terrain.free'));
  // The flat walking cost every step pays on top of the terrain price above
  // (run.stepSupplyCost, added 2026-09-22). "terrain.free" means free of the
  // TERRAIN's own charge, so this line has to follow it, not replace it.
  if (tr.passable && stepCost > 0) parts.push(t('terrain.stepCost', { n: stepCost }));
  if (tr.revealBonus > 0) parts.push(t('terrain.revealBonus', { n: tr.revealBonus }));
  if (tr.terrainHeight > 0) parts.push(t('terrain.height', { n: tr.terrainHeight }));
  return parts.join(' ');
}

// "mountains from 2 tiles, hills from 1 tile": the tile types that can be seen from
// afar, in a fixed reading order (mountain, hill, water, then anything else).
export function tallTerrainSentence(config) {
  const order = ['mountain', 'hill', 'water'];
  const names = Object.keys(config.tileTypes);
  const sorted = [...order.filter((n) => names.includes(n)), ...names.filter((n) => !order.includes(n))];
  const tall = sorted.filter((n) => (config.tileTypes[n].terrainHeight ?? 0) > 0);
  if (!tall.length) return '';
  const bits = tall.map((n) => t('terrain.tall.item', { name: t(`terrain.plural.${n}`), n: config.tileTypes[n].terrainHeight }));
  return t('terrain.tall', { list: bits.join(', ') });
}

// The first step at which fatigue becomes non-zero, from the byStep table.
export function firstRiskyStep(config) {
  const keys = Object.keys(config.fatigue.byStep).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (config.fatigue.byStep[k] > 0) return k;
  return null;
}
