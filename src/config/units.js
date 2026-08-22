// =====================================================================
//  UNIT CONFIG - the player's party and everything about how units fight.
//  (Part of the config split: world.js / encounters.js / units.js / config.js)
// =====================================================================

export const UNITS = {
  // ----- Party -------------------------------------------------------
  // The three units the player controls inside encounters. On the world map they
  // move as one token. "icon" is a placeholder glyph shown in the party panel.
  party: {
    units: [
      { name: 'Vanguard', icon: '🛡️', hp: 40, maxHp: 40, power: 1 },
      { name: 'Archer', icon: '🏹', hp: 28, maxHp: 28, power: 1 },
      { name: 'Mystic', icon: '🔮', hp: 22, maxHp: 22, power: 1 },
    ],
    hpSegment: 10,            // one bar segment per this many HP
  },

  // ----- Battle simulation --------------------------------------------
  battle: {
    damageMin: 2,
    damageMax: 10,
    // Bell curve control: the roll is the average of this many uniform rolls.
    // 1 = flat (every value equally likely), 2 = triangle, 3+ = increasingly bell shaped.
    bellDice: 4,
    powerBase: 1.2,           // damage *= powerBase ^ (attacker power - defender power)
    // Player units hit harder the closer they are to death ("playing carefully"):
    // damage *= 1 + desperation * (1 - hp / maxHp). 0 = off, 0.5 = up to +50% at 1 HP.
    desperation: 0.5,
    victoryPower: 1,          // power awarded to a chosen unit after winning a battle
    maxRounds: 100,           // safety cap for the simulation loop
    // Regular enemy groups. Power scales with the ring (distance from the centre),
    // using the same "table with interpolation" rule as fatigue.
    enemies: {
      countMin: 2,
      countMax: 3,
      hpMin: 14,
      hpMax: 22,
      powerByRing: { 0: 0, 9: 5 },
      names: ['Raider', 'Drifter', 'Husk', 'Warden', 'Stalker'],
    },
    // Boss variants: each boss tile rolls one of these (seeded). Power sits in the
    // 4-7 range by design, so the party is expected to arrive upgraded.
    bosses: [
      { title: 'Forge Tyrant', power: 4, units: [{ name: 'Forge Tyrant', hp: 60 }, { name: 'Tyrant\'s Shadow', hp: 40 }] },
      { title: 'Warden of the Rim', power: 6, units: [{ name: 'Warden of the Rim', hp: 120 }] },
      { title: 'Husk Choir', power: 4, units: [{ name: 'Choir Husk', hp: 24 }, { name: 'Choir Husk', hp: 24 }, { name: 'Choir Husk', hp: 24 }, { name: 'Choir Husk', hp: 24 }] },
      { title: 'Ether Leviathan', power: 7, units: [{ name: 'Ether Leviathan', hp: 150 }] },
      { title: 'Twin Stalkers', power: 5, units: [{ name: 'Pale Stalker', hp: 55 }, { name: 'Dark Stalker', hp: 55 }] },
    ],
  },
};
