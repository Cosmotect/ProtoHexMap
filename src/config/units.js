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
    // =================================================================
    //  THE BESTIARY - every enemy that exists, by id.
    //  A definition is deliberately just five things:
    //    name    what it is called (and the key its combat stats are looked up
    //            under in config/abilities.js UNIT_COMBAT - initiative, speed
    //            and abilities live there, because those are combat RULES)
    //    shape   the 3D body it gets in the arena. The full list of shapes is
    //            SHAPES in src/local/localview.js:
    //              box  sphere  cone  cylinder  capsule  prism  pyramid  spike
    //              tetrahedron  octahedron  icosahedron  dodecahedron
    //              torus  torusKnot  diamond  shard  slab  star
    //    color   that body's colour
    //    hp      hit points
    //    power   its strength: feeds the damage multiplier, the danger
    //            chevrons on the world map, and the auto-resolve simulation
    // =================================================================
    enemyTypes: {
      // --- the wandering rabble of the world map ---
      husk:      { name: 'Husk',      shape: 'dodecahedron', color: 0x9c5a4a, hp: 20, power: 2 },
      drifter:   { name: 'Drifter',   shape: 'tetrahedron',  color: 0xd6803c, hp: 16, power: 2 },
      raider:    { name: 'Raider',    shape: 'octahedron',   color: 0xe2474b, hp: 18, power: 3 },
      stalker:   { name: 'Stalker',   shape: 'spike',        color: 0xc0455f, hp: 16, power: 5 },
      warden:    { name: 'Warden',    shape: 'box',          color: 0xb0714a, hp: 24, power: 5 },
      brute:     { name: 'Brute',     shape: 'slab',         color: 0x8f4436, hp: 34, power: 8 },
      ravager:   { name: 'Ravager',   shape: 'star',         color: 0xd93a55, hp: 30, power: 10 },

      // --- the Stasis Seed's court (the bosses) ---
      forgeTyrant:     { name: 'Forge Tyrant',      shape: 'torusKnot',    color: 0xff7a3c, hp: 110, power: 26 },
      tyrantsShadow:   { name: "Tyrant's Shadow",   shape: 'shard',        color: 0x6b3fa0, hp: 55,  power: 17 },
      forgeHound:      { name: 'Forge Hound',       shape: 'cone',         color: 0xff9950, hp: 22,  power: 11 },
      wardenOfTheRim:  { name: 'Warden of the Rim', shape: 'slab',         color: 0x7f8fa6, hp: 135, power: 29 },
      rimSentry:       { name: 'Rim Sentry',        shape: 'prism',        color: 0x9aa7b8, hp: 26,  power: 12 },
      choirHusk:       { name: 'Choir Husk',        shape: 'sphere',       color: 0x8c7a9c, hp: 20,  power: 12 },
      etherLeviathan:  { name: 'Ether Leviathan',   shape: 'torus',        color: 0x5fc7e0, hp: 165, power: 32 },
      etherSpawn:      { name: 'Ether Spawn',       shape: 'diamond',      color: 0x7fe0f0, hp: 28,  power: 11 },
      paleStalker:     { name: 'Pale Stalker',      shape: 'spike',        color: 0xe0dcd2, hp: 70,  power: 23 },
      darkStalker:     { name: 'Dark Stalker',      shape: 'spike',        color: 0x4a4358, hp: 70,  power: 23 },
      stalkerShade:    { name: 'Stalker Shade',     shape: 'pyramid',      color: 0x5d5570, hp: 18,  power: 10 },

      // --- the Stasis Colonies' garrisons ---
      colonyWarden:    { name: 'Colony Warden',     shape: 'icosahedron',  color: 0x9a5cff, hp: 80,  power: 18 },
      wardenServitor:  { name: 'Warden Servitor',   shape: 'octahedron',   color: 0xb28cff, hp: 28,  power: 8 },
      broodHusk:       { name: 'Brood Husk',        shape: 'sphere',       color: 0x7d5ba6, hp: 20,  power: 10 },
      paleSentinel:    { name: 'Pale Sentinel',     shape: 'cylinder',     color: 0xd9cfe8, hp: 54,  power: 15 },
      darkSentinel:    { name: 'Dark Sentinel',     shape: 'cylinder',     color: 0x4b3a66, hp: 54,  power: 15 },
      stasisMote:      { name: 'Stasis Mote',       shape: 'diamond',      color: 0xc0a0ff, hp: 20,  power: 7 },
      colonyAnchor:    { name: 'Colony Anchor',     shape: 'torusKnot',    color: 0x8a4fd8, hp: 115, power: 22 },
      anchorTether:    { name: 'Anchor Tether',     shape: 'capsule',      color: 0xa87ae8, hp: 34,  power: 9 },
      rotChorister:    { name: 'Rot Chorister',     shape: 'tetrahedron',  color: 0x6f7d4a, hp: 16,  power: 9 },
    },

    // =================================================================
    //  GROUPS - the line-ups that actually spawn. A group is a title plus
    //  a list of bestiary ids; repeats are fine and get numbered ("Husk 2").
    //  Nothing is rolled inside a group: what is written here is what walks
    //  onto the arena, so a fight can be read straight off this table.
    //  `power` in the comments is the group's total, the number the danger
    //  chevrons on the world map are graded against (battle.danger.bands).
    // =================================================================
    enemyGroups: {
      // --- regular groups, inner rings (total power 3-6) ---
      loneRaider:  { title: 'Lone raider',     units: ['raider'] },                                  // 3
      strays:      { title: 'Strays',          units: ['husk', 'drifter'] },                          // 4
      scoutPair:   { title: 'Scouting pair',   units: ['raider', 'drifter'] },                        // 5
      huskTrio:    { title: 'Shambling trio',  units: ['husk', 'husk', 'husk'] },                     // 6

      // --- regular groups, middle rings (total power 23-25) ---
      raidParty:   { title: 'Raiding party',   units: ['raider', 'raider', 'raider', 'stalker', 'stalker', 'warden'] },   // 24
      stalkerPack: { title: 'Stalker pack',    units: ['stalker', 'stalker', 'stalker', 'stalker', 'drifter', 'drifter'] }, // 24
      wardenGuard: { title: 'Warden guard',    units: ['brute', 'warden', 'warden', 'raider', 'husk'] },                  // 23

      // --- regular groups, outer rings (total power 50-56) ---
      warband:     { title: 'Warband',         units: ['ravager', 'ravager', 'brute', 'brute', 'warden', 'warden', 'stalker', 'stalker'] }, // 56
      huskTide:    { title: 'Husk tide',       units: ['ravager', 'brute', 'husk', 'husk', 'husk', 'husk', 'husk', 'husk', 'stalker', 'stalker', 'stalker', 'stalker'] }, // 50
      ruinHunt:    { title: 'Ruin hunt',       units: ['ravager', 'ravager', 'ravager', 'stalker', 'stalker', 'stalker', 'warden', 'raider', 'raider'] }, // 54

      // --- the Stasis Seed's court: 80-100 on the difficulty scale ---
      forgeTyrant:    { title: 'Forge Tyrant',      units: ['forgeTyrant', 'tyrantsShadow', 'forgeHound', 'forgeHound', 'forgeHound'] },
      wardenOfTheRim: { title: 'Warden of the Rim', units: ['wardenOfTheRim', 'rimSentry', 'rimSentry', 'rimSentry', 'rimSentry'] },
      huskChoir:      { title: 'Husk Choir',        units: ['choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk'] },
      etherLeviathan: { title: 'Ether Leviathan',   units: ['etherLeviathan', 'etherSpawn', 'etherSpawn', 'etherSpawn'] },
      twinStalkers:   { title: 'Twin Stalkers',     units: ['paleStalker', 'darkStalker', 'stalkerShade', 'stalkerShade', 'stalkerShade', 'stalkerShade'] },

      // --- Stasis Colony garrisons: 50-70, a step above the outer rings ---
      colonyWarden:   { title: 'Colony Warden',   units: ['colonyWarden', 'wardenServitor', 'wardenServitor', 'wardenServitor'] },
      stasisBrood:    { title: 'Stasis Brood',    units: ['broodHusk', 'broodHusk', 'broodHusk', 'broodHusk', 'broodHusk', 'broodHusk'] },
      twinSentinels:  { title: 'Twin Sentinels',  units: ['paleSentinel', 'darkSentinel', 'stasisMote', 'stasisMote'] },
      colonyAnchor:   { title: 'Colony Anchor',   units: ['colonyAnchor', 'anchorTether', 'anchorTether'] },
      rotChorus:      { title: 'Rot Chorus',      units: ['rotChorister', 'rotChorister', 'rotChorister', 'rotChorister', 'rotChorister', 'rotChorister', 'rotChorister'] },
    },

    // Which groups a regular fight may roll, by RING band (distance from the
    // map centre). A ring past the last band's maxRing keeps using the last one.
    enemies: {
      bands: {
        inner:  { maxRing: 3,  groups: ['loneRaider', 'strays', 'scoutPair', 'huskTrio'] },
        middle: { maxRing: 7,  groups: ['raidParty', 'stalkerPack', 'wardenGuard'] },
        outer:  { maxRing: 11, groups: ['warband', 'huskTide', 'ruinHunt'] },
      },
      // Types the Stasis "extra enemies" debuff conjures, one rolled per extra.
      reinforcements: ['husk', 'raider', 'stalker'],
    },

    // The Stasis Seed rolls one of these groups (seeded); every Colony rolls one
    // of the colony groups. Both are just ids from enemyGroups above.
    bosses: ['forgeTyrant', 'wardenOfTheRim', 'huskChoir', 'etherLeviathan', 'twinStalkers'],
    colonies: ['colonyWarden', 'stasisBrood', 'twinSentinels', 'colonyAnchor', 'rotChorus'],
  },
};
