// =====================================================================
//  UNIT CONFIG - the player's party and everything about how units fight.
//  (Part of the config split: world.js / encounters.js / units.js / config.js)
//
//  There is no "power" number any more (removed 2026-09-10): a creature's
//  whole strength is the abilities it carries - each ability has its own flat
//  `damage` (config/abilities.js). The party has no power either; it never
//  did - player units grow through ability upgrade trees instead
//  (config/upgrades.js). Want a tougher enemy? Give it a harder-hitting
//  ability, not a bigger number here.
// =====================================================================

// ----- Intellect classes ------------------------------------------------
//  Not every creature thinks as well as every other one. A unit's INTELLECT CLASS
//  says which facts about the board it is capable of WEIGHING when it decides what
//  to do on its turn. It does not change the rules one bit: a witless brute still
//  gets the high-ground damage bonus if it happens to be standing high, still dies
//  in the void, still burns in a fire. It simply does not think about any of that
//  when choosing where to go and what to cast.
//
//  Nor does it change WHOSE side an effect is aimed at. Every class knows a curse
//  is for the party and a blessing is for its own allies - that is not cleverness,
//  it is knowing friend from foe. What the clever ones have is the ability to pick
//  the BEST target: a C-class creature hands its shield to whichever ally it can
//  reach, an S-class one hands it to the ally that is actually about to be hit.
//
//  ----- what each flag lets a mind weigh -----
//    statuses    the statuses on the board: which of them are worth applying to
//                whom, that a shield can be popped, that a target already carries
//                what it was about to be given, and which ally most needs a buff.
//                Blind minds still apply statuses, at a flat worth, to any legal
//                target of the right side.
//    elevation   the damage a height difference is worth, and the value of
//                claiming high ground while walking towards the party.
//    tags        the tiles that burn: worth avoiding to stand on, worth shoving
//                someone onto.
//    ether       the holes in the arena's edge: worth shoving someone into.
//    injuries    how hurt a target is: worth finishing the wounded rather than
//                spreading damage evenly.
//
//  These are the four classes the design asks for. The table is data like
//  everything else - a class can be re-tuned, and a fifth one invented, in the
//  Settings window without touching the engine. It lives HERE, next to the
//  bestiary, because a class is something a CREATURE has: every bestiary row
//  names one in its `intellect` column. (It was in config/abilities.js until
//  2026-09-10, which is where the status table it reads happens to live.)
const M = (o) => Object.assign({
  statuses: false, elevation: false, tags: false, ether: false, injuries: false,
}, o);

export const INTELLECT = {
  S: M({ statuses: true, elevation: true, tags: true, ether: true, injuries: true }),
  A: M({ elevation: true, ether: true, injuries: true }),
  B: M({ elevation: true }),
  C: M({}),
};

// (What a status is worth to a mind that cannot read them lives in
// `combat.blindStatusValue`, which is the copy the engine actually reads. There
// used to be a second, unread BLIND_STATUS_VALUE export here; two spellings of
// one number is how `enraged` ended up pointing at a field it did not have.)

export const intellectOf = (cls) => INTELLECT[cls] ?? INTELLECT.C;

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
    // character joins. A character is described HERE and nowhere else: body,
    // numbers and combat stats together, exactly like a bestiary row. (Until
    // 2026-09-06 the combat half lived in a UNIT_COMBAT table over in
    // config/abilities.js, so every character was written twice.)
    //   story     the character's few lines in the roster's detail window. It lives
    //             HERE so a character invented in the Settings window can have one,
    //             and so that renaming a character cannot silently lose it - which
    //             is exactly what happened when Vanguard became Gorm and the locale
    //             key `unit.Vanguard.story` stopped matching anybody. A locale may
    //             still override it with a `unit.<Name>.story` key: the same
    //             arrangement tn() uses for names - the config is the source, a
    //             translation wins where one exists.
    //   speed     move points per turn (an uphill step costs 2)
    //   flying    ignores height and glides over anything
    //   abilities ids from config/abilities.js - exactly TWO per character: each
    //             drives its own upgrade tree (config/upgrades.js), and the roster
    //             window and the party panel are laid out for the pair.
    roster: [
      { name: 'Gorm', icon: '🪲', hp: 40, speed: 3, flying: false, abilities: ['clawSwipe', 'chargeHeadbutt'], story: 'Gorm is as tough as he is not patient. His clawed swipes can lethal close up, and he knows how to get close up.' },
      { name: 'Archer', icon: '🏹', hp: 28, speed: 4, flying: false, abilities: ['volley', 'lance'], story: 'Counts distance the way merchants count coin. Keeps one arrow set aside for an old debt and never says whose name is on it.' },
      { name: 'Mystic', icon: '🔮', hp: 22, speed: 3, flying: false, abilities: ['burst', 'mend'], story: 'Talks to the ember at the heart of things. What the fire answers is rarely comforting and has never yet been wrong.' },
      { name: 'Warden', icon: '⚔️', hp: 36, speed: 4, flying: false, abilities: ['strike', 'guard'], story: 'Held a border fort nobody else wanted, alone, for nine years. Still checks the horizon twice before sleeping.' },
      { name: 'Stonestep', icon: '🗿', hp: 52, speed: 3, flying: false, abilities: ['strike', 'shove'], story: 'Slow as a landslide and exactly as arguable. Where Stonestep stands, the line holds; the rest is other people\'s hurry.' },
      { name: 'Emberwright', icon: '🔥', hp: 24, speed: 3, flying: false, abilities: ['burst', 'strike'], story: 'Apprenticed at the Great Forge until an experiment ate the workshop. Insists the fire simply agreed with the design.' },
      { name: 'Lampbearer', icon: '🏮', hp: 30, speed: 4, flying: false, abilities: ['mend', 'bolt'], story: 'Walks ahead in the dark with the lamp held high, humming to it. Whatever waits outside the light has learned to wait longer.' },
      { name: 'Skywatcher', icon: '🪶', hp: 20, speed: 5, flying: true, abilities: ['volley', 'lance'], story: 'Grew up on the rim cliffs reading weather and worse. Sees the whole field the way birds see a harvest.' },
      { name: 'Tinker', icon: '🔧', hp: 28, speed: 4, flying: false, abilities: ['shove', 'bolt'], story: 'Can fix a cart, a lock or a bad plan, in that order of difficulty. The pockets rattle with parts for machines that do not exist yet.' },
      { name: 'Duskblade', icon: '🗡️', hp: 16, speed: 5, flying: false, abilities: ['strike', 'lance'], story: 'Arrives without footsteps and leaves without goodbyes. The blade was always fast; the trust took years longer.' },
    ],
    // The last resort for a unit that is in neither the roster nor the bestiary
    // (a hand-authored scenario def that names something unknown).
    defaultCombat: { speed: 4, flying: false, abilities: ['strike'] },
  },

  // ----- Battle simulation --------------------------------------------
  battle: {
    damageMin: 2,
    damageMax: 8,
    // Bell curve control: the roll is the average of this many uniform rolls.
    // 1 = flat (every value equally likely), 2 = triangle, 3+ = increasingly bell shaped.
    // This is the AUTO-RESOLVE simulation's damage roll only (battle.js damageFor) -
    // it does not read abilities, so every unit rolls the same band regardless of
    // type. The interactive fight always uses the ability's own `damage` instead
    // (config/abilities.js). (There used to be a power-ratio multiplier on top of
    // this roll too - removed 2026-09-10 along with the "power" stat itself.)
    bellDice: 2,
    // Danger preview - the chevrons above a revealed fight. ABSOLUTE, not relative
    // to the party: reading whether a fight is takeable is the player's job. A
    // STRICT rule, no calculation: a regular fight shows 0..2 chevrons purely by
    // which RING BAND its tile sits in - `ringBands` is the ring each threshold is
    // crossed AFTER, so [3, 7] means rings 1-3 show 0, rings 4-7 show 1, rings
    // 8-11 show 2 - a Stasis Colony always shows `colony`, the Stasis Seed always
    // shows `seed`, both deliberately higher than the outer band's 2 so they
    // still read as harder than a normal fight.
    danger: { ringBands: [3, 7], colony: 3, seed: 5, maxChevrons: 8 },
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
    //  A row here is the WHOLE creature - since 2026-09-01 nothing about an
    //  enemy is looked up anywhere else, which is what lets the Units tab in
    //  Settings define a brand new one without touching a file:
    //    name       what it is called
    //    shape      the 3D body it gets in the arena. The full list of shapes
    //               is SHAPES in src/local/localview.js:
    //                 box  sphere  cone  cylinder  capsule  prism  pyramid
    //                 spike  tetrahedron  octahedron  icosahedron
    //                 dodecahedron  torus  torusKnot  diamond  shard  slab star
    //    color      that body's colour
    //    hp         hit points
    //    init       turn order in a fight (higher acts first)
    //    speed      move points per turn (an uphill step costs 2)
    //    flying     ignores height and glides over anything
    //    abilities  ids from config/abilities.js ABILITIES
    //  Leave the last four off and the creature falls back to party.defaultCombat (by
    //  name) and then to its `default` row, so old hand-authored content and
    //  the party keep working unchanged.
    // =================================================================
    enemyTypes: {
      // `intellect` is the creature's INTELLECT CLASS (S / A / B / C): which facts
      // about the arena it is able to weigh on its turn. The classes themselves are
      // spelled out in src/config/abilities.js; it changes no rule, only how well
      // the creature plays. Rough rule of thumb below: mindless swarm C, ordinary
      // soldiery B, elites A, the leaders S.
      // --- the wandering rabble of the world map ---
      frailTick: { name: 'Frail Tick', shape: 'spike', color: '#a1254a', hp: 4, init: 4, speed: 3, flying: false, intellect: 'C', abilities: ['softeningBite'] },
      weakTick: { name: 'Lethargy Tick', shape: 'spike', color: '#a0c437', hp: 4, init: 4, speed: 3, flying: false, intellect: 'C', abilities: ['weakeningBite'] },
      rageTick: { name: 'Rage Tick', shape: 'spike', color: '#c0455f', hp: 4, init: 4, speed: 3, flying: false, intellect: 'C', abilities: ['rageBite'] },
      rushTick: { name: 'Rusher Tick', shape: 'spike', color: '#e2474b', hp: 4, init: 4, speed: 3, flying: false, intellect: 'C', abilities: ['headbutt'] },

      hammerhead: { name: 'Hammerhead', shape: 'box', color: '#b0714a', hp: 12, init: 6, speed: 2, flying: false, intellect: 'B', abilities: ['chargeHeadbutt'] },

      husk: { name: 'Husk', shape: 'dodecahedron', color: '#9c5a4a', hp: 10, init: 4, speed: 3, flying: false, intellect: 'C', abilities: ['strike'] },
      drifter: { name: 'Drifter', shape: 'tetrahedron', color: '#d6803c', hp: 8, init: 5, speed: 4, flying: false, intellect: 'C', abilities: ['volley'] },
      raider: { name: 'Raider', shape: 'octahedron', color: '#e2474b', hp: 9, init: 6, speed: 4, flying: false, intellect: 'B', abilities: ['strike'] },
      stalker: { name: 'Stalker', shape: 'spike', color: '#c0455f', hp: 8, init: 7, speed: 5, flying: false, intellect: 'B', abilities: ['lance'] },
      warden: { name: 'Warden', shape: 'box', color: '#b0714a', hp: 12, init: 6, speed: 4, flying: false, intellect: 'B', abilities: ['strike', 'guard'] },
      brute: { name: 'Brute', shape: 'slab', color: '#8f4436', hp: 17, init: 3, speed: 3, flying: false, intellect: 'B', abilities: ['strike', 'shove'] },
      ravager: { name: 'Ravager', shape: 'star', color: '#d93a55', hp: 15, init: 8, speed: 5, flying: false, intellect: 'A', abilities: ['lance', 'strike'] },

      // --- the Stasis Seed's court (the bosses) ---
      forgeTyrant: { name: 'Forge Tyrant', shape: 'torusKnot', color: '#ff7a3c', hp: 55, init: 6, speed: 4, flying: false, intellect: 'S', abilities: ['strike', 'burst'] },
      tyrantsShadow: { name: "Tyrant's Shadow", shape: 'shard', color: '#6b3fa0', hp: 26, init: 7, speed: 5, flying: false, intellect: 'A', abilities: ['lance'] },
      forgeHound: { name: 'Forge Hound', shape: 'cone', color: '#ff9950', hp: 11, init: 7, speed: 5, flying: false, intellect: 'C', abilities: ['strike'] },
      wardenOfTheRim: { name: 'Warden of the Rim', shape: 'slab', color: '#7f8fa6', hp: 72, init: 5, speed: 4, flying: false, intellect: 'S', abilities: ['strike', 'shove'] },
      rimSentry: { name: 'Rim Sentry', shape: 'prism', color: '#9aa7b8', hp: 13, init: 4, speed: 3, flying: false, intellect: 'B', abilities: ['strike', 'guard'] },
      choirHusk: { name: 'Choir Husk', shape: 'sphere', color: '#8c7a9c', hp: 10, init: 4, speed: 3, flying: false, intellect: 'C', abilities: ['strike'] },
      etherLeviathan: { name: 'Ether Leviathan', shape: 'torus', color: '#5fc7e0', hp: 82, init: 6, speed: 3, flying: true, intellect: 'S', abilities: ['burst', 'bolt'] },
      etherSpawn: { name: 'Ether Spawn', shape: 'diamond', color: '#7fe0f0', hp: 14, init: 6, speed: 4, flying: true, intellect: 'B', abilities: ['bolt'] },
      paleStalker: { name: 'Pale Stalker', shape: 'spike', color: '#e0dcd2', hp: 35, init: 8, speed: 5, flying: false, intellect: 'A', abilities: ['lance'] },
      darkStalker: { name: 'Dark Stalker', shape: 'spike', color: '#4a4358', hp: 35, init: 8, speed: 5, flying: false, intellect: 'A', abilities: ['strike', 'shove'] },
      stalkerShade: { name: 'Stalker Shade', shape: 'pyramid', color: '#5d5570', hp: 9, init: 7, speed: 5, flying: false, intellect: 'C', abilities: ['strike'] },

      // --- the Stasis Colonies' garrisons ---
      colonyWarden: { name: 'Colony Warden', shape: 'icosahedron', color: '#9a5cff', hp: 40, init: 5, speed: 3, flying: false, intellect: 'S', abilities: ['strike', 'guard'] },
      wardenServitor: { name: 'Warden Servitor', shape: 'octahedron', color: '#b28cff', hp: 14, init: 4, speed: 4, flying: false, intellect: 'B', abilities: ['strike'] },
      broodHusk: { name: 'Brood Husk', shape: 'sphere', color: '#7d5ba6', hp: 10, init: 4, speed: 3, flying: false, intellect: 'C', abilities: ['strike'] },
      paleSentinel: { name: 'Pale Sentinel', shape: 'cylinder', color: '#d9cfe8', hp: 27, init: 6, speed: 3, flying: false, intellect: 'A', abilities: ['volley'] },
      darkSentinel: { name: 'Dark Sentinel', shape: 'cylinder', color: '#4b3a66', hp: 27, init: 6, speed: 3, flying: false, intellect: 'A', abilities: ['bolt'] },
      stasisMote: { name: 'Stasis Mote', shape: 'diamond', color: '#c0a0ff', hp: 10, init: 8, speed: 5, flying: true, intellect: 'C', abilities: ['strike'] },
      colonyAnchor: { name: 'Colony Anchor', shape: 'torusKnot', color: '#8a4fd8', hp: 57, init: 3, speed: 2, flying: false, intellect: 'A', abilities: ['burst', 'shove'] },
      anchorTether: { name: 'Anchor Tether', shape: 'capsule', color: '#a87ae8', hp: 17, init: 5, speed: 4, flying: false, intellect: 'B', abilities: ['strike'] },
      rotChorister: { name: 'Rot Chorister', shape: 'tetrahedron', color: '#6f7d4a', hp: 8, init: 5, speed: 4, flying: false, intellect: 'C', abilities: ['strike'] },
    },

    // =================================================================
    //  GROUPS - the line-ups that actually spawn. A group is a title plus
    //  a list of bestiary ids; repeats are fine and get numbered ("Husk 2").
    //  Nothing is rolled inside a group: what is written here is what walks
    //  onto the arena, so a fight can be read straight off this table.
    //  There used to be a "total power" figure noted after each group, back
    //  when power fed the damage multiplier - removed 2026-09-10 along with
    //  the stat itself. A group's toughness is its unit count plus whatever
    //  abilities those bestiary rows carry now.
    // =================================================================
    enemyGroups: {
      // --- regular groups, inner rings ---
      loneRaider: { title: 'Lone raider', units: ['raider'] },
      strays: { title: 'Strays', units: ['husk', 'drifter'] },
      scoutPair: { title: 'Scouting pair', units: ['raider', 'drifter'] },
      huskTrio: { title: 'Shambling trio', units: ['husk', 'husk', 'husk'] },
      tickSwarm: { title: 'Tick piper', units: ['rageTick', 'weakTick', 'frailTick', 'rushTick', 'drifter'] },

      // --- regular groups, middle rings ---
      raidParty: { title: 'Raiding party', units: ['raider', 'raider', 'raider', 'stalker', 'stalker', 'warden'] },
      stalkerPack: { title: 'Stalker pack', units: ['stalker', 'stalker', 'stalker', 'stalker', 'drifter', 'drifter'] },
      wardenGuard: { title: 'Warden guard', units: ['brute', 'warden', 'warden', 'raider', 'husk'] },

      // --- regular groups, outer rings ---
      warband: { title: 'Warband', units: ['ravager', 'ravager', 'brute', 'brute', 'warden', 'warden', 'stalker', 'stalker'] },
      huskTide: { title: 'Husk tide', units: ['ravager', 'brute', 'husk', 'husk', 'husk', 'husk', 'husk', 'husk', 'stalker', 'stalker', 'stalker', 'stalker'] },
      ruinHunt: { title: 'Ruin hunt', units: ['ravager', 'ravager', 'ravager', 'stalker', 'stalker', 'stalker', 'warden', 'raider', 'raider'] },

      // --- the Stasis Seed's court: 80-100 on the difficulty scale ---
      forgeTyrant: { title: 'Forge Tyrant', units: ['forgeTyrant', 'tyrantsShadow', 'forgeHound', 'forgeHound', 'forgeHound'] },
      wardenOfTheRim: { title: 'Warden of the Rim', units: ['wardenOfTheRim', 'rimSentry', 'rimSentry', 'rimSentry', 'rimSentry'] },
      huskChoir: { title: 'Husk Choir', units: ['choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk', 'choirHusk'] },
      etherLeviathan: { title: 'Ether Leviathan', units: ['etherLeviathan', 'etherSpawn', 'etherSpawn', 'etherSpawn'] },
      twinStalkers: { title: 'Twin Stalkers', units: ['paleStalker', 'darkStalker', 'stalkerShade', 'stalkerShade', 'stalkerShade', 'stalkerShade'] },

      // --- Stasis Colony garrisons: 50-70, a step above the outer rings ---
      colonyWarden: { title: 'Colony Warden', units: ['colonyWarden', 'wardenServitor', 'wardenServitor', 'wardenServitor'] },
      stasisBrood: { title: 'Stasis Brood', units: ['broodHusk', 'broodHusk', 'broodHusk', 'broodHusk', 'broodHusk', 'broodHusk'] },
      twinSentinels: { title: 'Twin Sentinels', units: ['paleSentinel', 'darkSentinel', 'stasisMote', 'stasisMote'] },
      colonyAnchor: { title: 'Colony Anchor', units: ['colonyAnchor', 'anchorTether', 'anchorTether'] },
      rotChorus: { title: 'Rot Chorus', units: ['rotChorister', 'rotChorister', 'rotChorister', 'rotChorister', 'rotChorister', 'rotChorister', 'rotChorister'] },
    },

    // How far out each RING band reaches (distance from the map centre). A ring
    // past the last band's maxRing keeps using the last one. WHICH groups each
    // band rolls, per layer, is `battleSpawns` in config/encounters.js (wired
    // in here as CONFIG.battle.spawns by config.js - moved there 2026-09-10 so
    // it sits with the rest of encounter design instead of the party/battle-sim
    // numbers this file holds).
    enemies: {
      bands: {
        inner: { maxRing: 3 },
        middle: { maxRing: 7 },
        outer: { maxRing: 11 },
      },
      // Types the Stasis "extra enemies" debuff conjures, one rolled per extra.
      reinforcements: ['husk', 'raider', 'stalker'],
    },
  },

  // The INTELLECT CLASSES, as part of the config object, so the Settings window
  // can edit them and the engine can read them off the same table (config.intellect).
  intellect: INTELLECT,

};

// Combat stats for a unit by its DISPLAY name ("Husk 2" -> "Husk"): a roster
// character's own row, else the fallback. Enemies do not come through here - a
// bestiary row carries its own stats and hands them straight to the engine.
export function combatStatsFor(name) {
  const base = String(name ?? '').replace(/ \d+$/, '');
  const p = UNITS.party;
  const row = p.roster.find((u) => u.name === base);
  if (!row) return p.defaultCombat;
  // A row can be INCOMPLETE: one invented in the Settings window, or one restored
  // from settings saved by an older build, before the roster carried init / speed /
  // flying / abilities at all. Fill whatever is missing from defaultCombat rather
  // than hand back a character with no abilities - which used to throw on the first
  // draw of the party panel and take the whole page with it.
  const out = { ...p.defaultCombat };
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out;
}
