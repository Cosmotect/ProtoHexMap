// =====================================================================
//  UNIT CONFIG - the player's party and everything about how units fight.
//  (Part of the config split: world.js / encounters.js / units.js / config.js)
//
//  POWER is an ENEMY-ONLY number now (on the x3 scale since 2026-08-27; the
//  damage multiplier divides differences by battle.powerStep (3)). The party
//  has no power: player units grow through ability upgrade trees instead
//  (config/upgrades.js). The auto-resolve simulation still needs a party
//  number to compare against enemy power, so it derives a proxy from the
//  upgrade count - battle.simPower below.
// =====================================================================

export const UNITS = {
  // ----- Party -------------------------------------------------------
  // The three units the player controls inside encounters. On the world map they
  // move as one token. "icon" is a placeholder glyph shown in the party panel.
  party: {
    // How many characters the player starts with. There is no separate list of
    // starting units any more: the run opens with the FIRST `size` entries of the
    // roster below, so a character's numbers live in exactly one place. Reorder
    // the roster to change who the default party is.
    size: 3,
    hpSegment: 10,            // one bar segment per this many HP
    // Everyone the player can take along, shown in the start-screen roster grid
    // (the first `size` are the default party). hp doubles as maxHp when a
    // character joins; a character's ABILITIES live in config/abilities.js
    // (UNIT_COMBAT) and their upgrade trees in config/upgrades.js.
    roster: [
      { name: 'Vanguard', icon: '🛡️', hp: 40 },
      { name: 'Archer', icon: '🏹', hp: 28 },
      { name: 'Mystic', icon: '🔮', hp: 22 },
      { name: 'Warden', icon: '⚔️', hp: 36 },
      { name: 'Stonestep', icon: '🗿', hp: 52 },
      { name: 'Emberwright', icon: '🔥', hp: 24 },
      { name: 'Lampbearer', icon: '🏮', hp: 30 },
      { name: 'Skywatcher', icon: '🪶', hp: 20 },
      { name: 'Tinker', icon: '🔧', hp: 28 },
      { name: 'Duskblade', icon: '🗡️', hp: 16 },
    ],
  },

  // ----- Battle simulation --------------------------------------------
  battle: {
    damageMin: 2,
    damageMax: 8,
    // Bell curve control: the roll is the average of this many uniform rolls.
    // 1 = flat (every value equally likely), 2 = triangle, 3+ = increasingly bell shaped.
    bellDice: 2,
    // Damage multiplier: powerBase ^ ((attacker power - defender power) / powerStep).
    // Continuous: 3 points of difference are worth one full 1.15x, and every single
    // point in between moves the number a little. Only the final damage is rounded.
    powerBase: 1.15,
    powerStep: 3,
    // The AUTO-RESOLVE simulation's stand-in for party strength (the party has no
    // power of its own any more): a unit simulates at base + perUpgrade * its
    // unlocked upgrade count. Only the fallback simulation reads this; the
    // interactive combat fights with the upgraded abilities themselves.
    simPower: { base: 3, perUpgrade: 2 },
    // Danger preview - the chevrons above a revealed fight. ABSOLUTE, not relative
    // to the party: reading whether a fight is takeable is the player's job.
    // Regular fights show 0..2 chevrons by the band their TOTAL enemy power falls
    // into (0 below bands[0], 1 from bands[0], 2 from bands[1]); a Stasis Colony
    // always shows `colony`, the Stasis Seed always shows `seed`.
    danger: { bands: [12, 36], colony: 3, seed: 5, maxChevrons: 8 },
    // Player units hit harder the closer they are to death ("playing carefully"):
    // damage *= 1 + desperation * (1 - hp / maxHp). 0 = off, 0.5 = up to +50% at 1 HP.
    desperation: 0.5,
    // Enemy target choice: weight grows with the target's remaining HP fraction,
    // raised to this exponent (0 = pick uniformly at random).
    healthyTargetBias: 2,
    victorySupplies: 5,       // supplies salvaged after winning any battle (incl. Stasis)
    maxRounds: 100,           // safety cap for the simulation loop
    // Regular enemy groups. Difficulty is a function of the RING (distance from the
    // map centre), described as bands: how many enemies the group holds and how much
    // power the whole group is worth. The group's total power is rolled inside
    // [powerMin, powerMax] and then split as evenly as possible between its units
    // (the remainder goes to random members, so a group is not always uniform).
    // A ring above the last band's maxRing uses the last band.
    enemies: {
      hpMin: 14,
      hpMax: 22,
      bands: {
        inner: { maxRing: 3, countMin: 1, countMax: 3, powerMin: 3, powerMax: 6 },
        middle: { maxRing: 7, countMin: 2, countMax: 5, powerMin: 24, powerMax: 30 },
        outer: { maxRing: 11, countMin: 4, countMax: 8, powerMin: 50, powerMax: 60 },
      },
      names: ['Raider', 'Drifter', 'Husk', 'Warden', 'Stalker'],
    },
    // The boss pool: ONLY the Stasis Seed rolls one of these (seeded). 80-100 on the
    // 0-100 difficulty scale of the design guideline (see README): the run's final wall,
    // and considerably harder than anything the outer rings hold.
    // Shape: every variant mixes a few heavy hitters with a screen of chaff, or is a
    // large equal-power choir. A unit's own "power" overrides the variant's "power",
    // which is the value the unlisted (chaff) units use.
    // Measured (600 simulated fights per point): a full-HP party beats these when each
    // of its units is around 28 power - about twice what an outer-ring group asks for.
    bosses: [
      { title: 'Forge Tyrant', power: 11, units: [
        { name: 'Forge Tyrant', hp: 110, power: 26 }, { name: 'Tyrant\'s Shadow', hp: 55, power: 17 },
        { name: 'Forge Hound', hp: 22 }, { name: 'Forge Hound', hp: 22 }, { name: 'Forge Hound', hp: 22 }] },
      { title: 'Warden of the Rim', power: 12, units: [
        { name: 'Warden of the Rim', hp: 135, power: 29 },
        { name: 'Rim Sentry', hp: 26 }, { name: 'Rim Sentry', hp: 26 }, { name: 'Rim Sentry', hp: 26 }, { name: 'Rim Sentry', hp: 26 }] },
      { title: 'Husk Choir', power: 12, units: [
        { name: 'Choir Husk', hp: 20 }, { name: 'Choir Husk', hp: 20 }, { name: 'Choir Husk', hp: 20 },
        { name: 'Choir Husk', hp: 20 }, { name: 'Choir Husk', hp: 20 }, { name: 'Choir Husk', hp: 20 },
        { name: 'Choir Husk', hp: 20 }, { name: 'Choir Husk', hp: 20 }, { name: 'Choir Husk', hp: 20 }] },
      { title: 'Ether Leviathan', power: 11, units: [
        { name: 'Ether Leviathan', hp: 165, power: 32 },
        { name: 'Ether Spawn', hp: 28 }, { name: 'Ether Spawn', hp: 28 }, { name: 'Ether Spawn', hp: 28 }] },
      { title: 'Twin Stalkers', power: 10, units: [
        { name: 'Pale Stalker', hp: 70, power: 23 }, { name: 'Dark Stalker', hp: 70, power: 23 },
        { name: 'Stalker Shade', hp: 18 }, { name: 'Stalker Shade', hp: 18 },
        { name: 'Stalker Shade', hp: 18 }, { name: 'Stalker Shade', hp: 18 }] },
    ],
    // The Colony pool: every Stasis Colony rolls one of these (seeded). 50-70 on the
    // same scale - a step ABOVE the toughest regular groups of the outer rings, and far
    // below a boss. Same shapes as the bosses (leaders + chaff, or an equal-power swarm)
    // at smaller numbers, so a Colony reads as a set piece rather than a bigger patrol.
    // Measured: a full-HP party beats these at around 16 power per unit, against 14 for
    // an outer-ring group and 28 for a boss.
    colonies: [
      { title: 'Colony Warden', power: 8, units: [
        { name: 'Colony Warden', hp: 80, power: 18 },
        { name: 'Warden Servitor', hp: 28 }, { name: 'Warden Servitor', hp: 28 }, { name: 'Warden Servitor', hp: 28 }] },
      { title: 'Stasis Brood', power: 10, units: [
        { name: 'Brood Husk', hp: 20 }, { name: 'Brood Husk', hp: 20 }, { name: 'Brood Husk', hp: 20 },
        { name: 'Brood Husk', hp: 20 }, { name: 'Brood Husk', hp: 20 }, { name: 'Brood Husk', hp: 20 }] },
      { title: 'Twin Sentinels', power: 7, units: [
        { name: 'Pale Sentinel', hp: 54, power: 15 }, { name: 'Dark Sentinel', hp: 54, power: 15 },
        { name: 'Stasis Mote', hp: 20 }, { name: 'Stasis Mote', hp: 20 }] },
      { title: 'Colony Anchor', power: 9, units: [
        { name: 'Colony Anchor', hp: 115, power: 22 },
        { name: 'Anchor Tether', hp: 34 }, { name: 'Anchor Tether', hp: 34 }] },
      { title: 'Rot Chorus', power: 9, units: [
        { name: 'Rot Chorister', hp: 16 }, { name: 'Rot Chorister', hp: 16 }, { name: 'Rot Chorister', hp: 16 },
        { name: 'Rot Chorister', hp: 16 }, { name: 'Rot Chorister', hp: 16 }, { name: 'Rot Chorister', hp: 16 },
        { name: 'Rot Chorister', hp: 16 }] },
    ],
  },
};
