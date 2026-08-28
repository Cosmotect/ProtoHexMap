// Text generated from the config at runtime, so that changing a number in config/*.js
// changes the legend and the new player experience automatically. No rule numbers are
// hardcoded here: everything is read from CONFIG, every word comes from the locale tables.
import { t, joinList } from './i18n.js';

const pct = (f) => `${Math.round(f * 100)}%`;

// Placeholders usable inside locale strings (visual.*.info, npe.*).
export function placeholders(config) {
  const c = config;
  const bands = Object.values(c.battle.enemies.bands);
  const enemyPowerMax = Math.max(...bands.map((b) => b.powerMax));
  const bossPowers = c.battle.bosses.map((b) => b.power);
  const colonyPowers = (c.battle.colonies ?? c.battle.bosses).map((b) => b.power);
  return {
    colonyCount: c.stasis.colonyCount,
    rewardPicks: c.stasis.rewardPicks,
    witherHp: c.biomes.wither?.hpCost ?? 0,
    witherEvery: c.stasis.witherEvery,
    debuffMaxHpPct: pct(c.stasis.debuffs.maxHp.fraction),
    debuffPower: c.stasis.debuffs.power.amount,
    debuffExtraEnemies: c.stasis.debuffs.extraEnemies.count,
    victoryPower: c.battle.victoryPower,
    campCost: c.rest.cost,
    healPct: pct(c.rest.healFraction),
    shopRestCost: c.shop.restCost,
    upgradeCost: c.shop.upgradeCost,
    upgradeAmount: c.shop.upgradeAmount,
    mapCost: c.shop.mapCost,
    relicCost: c.shop.relicCost,
    rumorsCost: c.shop.rumorsCost,
    sparePartsCost: c.shop.sparePartsCost,
    shopRandomCount: c.shop.randomCount,
    mapTiles: c.events.blobSize,
    treasureSupplies: c.treasure.supplies,
    maxSupplies: c.run.startSupplies,
    revivePct: pct(c.acolyte.reviveFraction),
    acolyteMin: c.encounters.guaranteed?.acolyte ?? 0,
    bossPowerMin: Math.min(...bossPowers),
    bossPowerMax: Math.max(...bossPowers),
    colonyPowerMin: Math.min(...colonyPowers),
    colonyPowerMax: Math.max(...colonyPowers),
    enemyPowerMax,
    unitCount: c.party.size ?? 3,
    damageMin: c.battle.damageMin,
    damageMax: c.battle.damageMax,
  };
}

// Translates a key with the config placeholders (plus any extra params).
export function tc(key, config, extra = {}) {
  return t(key, { ...placeholders(config), ...extra });
}

// Encounter label / info from the locale tables.
export function encounterLabel(type) { return t(`visual.${type}.label`); }
export function encounterInfo(type, config) { return tc(`visual.${type}.info`, config); }
export function terrainName(name) { return t(`terrain.${name}`); }

// One sentence per terrain, built from its numbers.
export function terrainInfo(name, tr) {
  const parts = [t(`terrain.${name}.flavour`)];
  if (!tr.passable) parts.push(t('terrain.impassable'));
  else if (tr.supplyCost > 0 || tr.hpCost > 0) {
    const costs = [];
    if (tr.supplyCost > 0) costs.push(t('terrain.cost.supplies', { n: tr.supplyCost }));
    if (tr.hpCost > 0) costs.push(t('terrain.cost.hp', { n: tr.hpCost }));
    parts.push(t('terrain.costly', { costs: joinList(costs) }));
  } else parts.push(t('terrain.free'));
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
