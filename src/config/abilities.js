// =====================================================================
//  COMBAT CONFIG - abilities, tile tags and per-unit combat stats.
//  (Part of the config split; read by src/local/battle/engine.js.)
//
//  This is the hand-authored slice of the hex-box combat prototype: only the
//  DEFINITIONS came over, none of the editors or storage.
//
// =====================================================================
//  EVERY KNOB AN ABILITY HAS
//  ---------------------------------------------------------------------
//  An ability is DATA. There is no per-ability code anywhere: one executor
//  (`resolveCast` in local/battle/engine.js) reads the fields below and performs
//  them, always in this order, and the enemy AI judges a new ability by playing
//  that same executor out on a copy of the board. So anything expressible here
//  works in the game AND is understood by the AI the moment you write it.
//
//  ----- 1. WHERE IT CAN BE POINTED ------------------------------------
//    castZone   a LIST OF OFFSETS from the caster's tile: [[q, r], ...]. Any
//               shape at all - it is a plain list, not a formula. Two helpers
//               build the common ones (local/battle/bhex.js):
//                 ringOffsets(minD, maxD)  every tile at distance minD..maxD.
//                                          A BLOB: ringOffsets(1, 3) is 36 tiles.
//                 lineOffsets(minD, maxD)  only the six straight spokes out from
//                                          the caster. A STAR: lineOffsets(1, 3)
//                                          is 18 tiles, with nothing in between
//                                          the spokes. For anything that travels
//                                          in a straight line - a charge, a bolt.
//               Neither is special: `castZone: [[2, 0], [0, 2]]` is perfectly
//               legal if that is the shape you want.
//    castAny    true = ignore castZone and aim at any tile on the board.
//
//    ----- WHY MORE TILES LIGHT UP THAN castZone LISTS -----
//    With `rotatable: true` the game also lets you click any tile the dmgZone
//    would COVER, and treats it as a click on the castZone tile that covers it.
//    Lance has a castZone of one ring but lights up 18 tiles, because you aim it
//    by clicking the enemy you mean to skewer rather than the empty tile in front
//    of you. It does NOT extend the ability's reach: clicking the far tile casts
//    from the near one and hits exactly the same three tiles. If you want real
//    reach, put the tiles in castZone.
//
//  ----- 2. WHAT IT DOES, in the order it happens ----------------------
//    dmgZone    offsets FROM THE AIM POINT that take the damage / heal / status.
//    damage     flat damage to every unit in dmgZone - a creature's whole
//               strength is this number now (no more enemy-only power bonus,
//               removed 2026-09-10). Height matters: 2+ levels above adds
//               combat.highBonus, 2+ below removes combat.lowPenalty.
//    heal       flat healing to every unit in dmgZone (applied after damage).
//    buff       the id of a status from STATUSES below, applied to every unit in
//               dmgZone; buffX is the list of numbers for that status's knobs
//               (see WHAT buffX MEANS, further down this file).
//    pushZone   [q, r, dirIndex, dist] - shove whoever stands on the offset [q, r]
//               from the aim point.
//                 dirIndex  which way, as an index into DIRS: 0 east, 1 north-east,
//                           2 north-west, 3 west, 4 south-west, 5 south-east. With
//                           `rotatable` these turn with the aim, so 0 reads as
//                           "away from the caster" and 3 as "towards the caster" -
//                           which is how you write a PULL.
//                 dist      1 or 2. ANYTHING ELSE IS CLAMPED TO 2 by the engine.
//               Shoves resolve in waves, so several of them in one cast do not
//               walk through each other. A shove into an occupied tile is a
//               collision (both take damage), into a wall a crash, off a lethal
//               edge or into ether a death.
//    hZone      [q, r, amount] - change the ground height at that offset.
//    hMode      'rel' = add `amount` to the height there, 'abs' = set it to
//               `amount`. Clamped to 0..combat.elevationLevels. Units standing
//               on the tile are not moved.
//    tagId      a tile tag from COMBAT_TAGS to leave behind...
//    tagZone    ...on these offsets from the aim point.
//    moveToTarget  the caster charges towards the aim point, LAST of all - after
//               its own damage, shoves and terrain changes have resolved. It
//               walks the straight line and takes the furthest tile it can stand
//               on, stopping in front of the first thing still in the way. So a
//               charge that rams its target out of the way lands on the tile the
//               target used to hold, and one whose shove was blocked pulls up
//               short of it. An occupied tile is a legal thing to aim at.
//    rotatable  true = every zone above (dmgZone, pushZone, hZone, tagZone) turns
//               to face the aim point, snapped to one of six 60-degree sectors.
//               Write the zones facing EAST and they will point wherever you aim.
//
//  ----- 3. WHAT IS NOT THERE YET --------------------------------------
//    No ability can swap places with a unit, summon anything, or push further
//    than two tiles. Each of those needs engine work, not a config line.
// =====================================================================
import { ringOffsets, lineOffsets, DIRS } from '../local/battle/bhex.js';

export const COMBAT_CONFIG = {
  // ----- Combat rules (hex-box "settings" block) ----------------------
  combat: {
    minSpeed: 2,        // slowed units keep at least this much speed (climbing costs 2)
    highBonus: 1,       // damage added when attacking from 2+ levels above
    lowPenalty: 1,      // damage removed when attacking from 2+ levels below
    voidEdges: false,   // true = shoves over the map edge kill instead of crashing
    // (What popping a shield is worth to the enemy AI used to live here as
    // `shieldStripScore`. It moved into the shield's own row in the status table
    // below, as `aiValue`, so every status carries its own worth in one place.)
    // ----- the retreat rule (stops a decided fight from being dragged out) -----
    // A beaten enemy side starts to break. From the round AFTER `afterRound`, on
    // every enemy's turn, while the enemy side's remaining HP is under `hpFraction`
    // of what it had when the fight began, each enemy that has not broken yet rolls
    //   100 / (enemies still standing)  percent
    // to flee - so a crowd goes a few at a time and the last one standing always
    // runs. The roll happens once per enemy: a fleeing enemy is locked in, and
    // walks for the nearest arena edge until it gets there or is killed on the way.
    // It is still a normal target while it runs.
    // The STASIS is exempt: a Stasis Seed or Colony fight never offers the roll at
    // all (createBattle's `noFlee`, set from the encounter in main.js) - that enemy
    // has nowhere to run to and nothing to run for.
    // Escaping is NOT a death: nothing is reported through onUnitDeath, so when
    // LOOT exists this is exactly the branch that must not roll it - a killed enemy
    // pays out, one that got away does not. The fight still counts as won, so the
    // party keeps the encounter's completion reward.
    flee: { afterRound: 7, hpFraction: 0.3 },
    // What a status is worth to a creature that cannot read them (see the intellect
    // classes below): enough to bless allies and curse the party, not enough to
    // choose between two targets.
    blindStatusValue: 8,
    elevationLevels: 4, // arena heights run 0..this (5 steps: 0,1,2,3,4)
    // The MIDDLE step (2) is the arena's neutral ground: it renders
    // flush with the surrounding world tiles, 3 and 4 stand above it,
    // 1 and 0 are sunk below it. Keep this number EVEN so a middle
    // step exists (see config.local.elevationMid).
  },
};

// ===================================ABILITIES===================================
// A small starter kit; balance numbers are first guesses.
const A = (o) => Object.assign({
  // `desc` is what the roster window and the ability tooltips show. Like an
  // upgrade node's (see ABILITY_UPGRADES below), it belongs on the definition:
  // write it here and English needs no locale entry at all. A translation still
  // overrides it with `ability.<id>.desc`. Left empty, nothing is shown - which
  // is why an ability with neither used to print the raw key on screen.
  name: 'Ability', icon: '💥', color: '#5fc7e0', desc: '',
  damage: 0, heal: 0, buff: '', buffX: null,   // buffX null = "use the status's own values"
  castZone: [], castAny: false, dmgZone: [], tagZone: [], tagId: null,
  hZone: [], hMode: 'rel', pushZone: [], rotatable: false, moveToTarget: false,
  // WHAT IT COSTS TO CAST. Every entry is optional and defaults to 0.
  //   hp        taken from the CASTER. It can never kill: a unit needs strictly
  //             more hp than the cost, so the ability greys out at exactly the
  //             cost rather than offering a suicide.
  //   supplies  taken from the RUN's supplies, the same pool the world map
  //             spends. Only the party has one - an enemy casts a supply-cost
  //             ability for free (see canAfford in local/battle/engine.js).
  //   move      movement points. The cost is BOTH a gate and a payment: the
  //             caster must have that many points left this round, and casting
  //             spends them, so a unit that could still walk 4 tiles can only
  //             walk 2 after a move-2 cast. (Today a cast ends the unit's turn
  //             anyway; the spending is what makes this work unchanged on the
  //             day a unit is allowed to move afterwards.)
  // ANY of them may be NEGATIVE, which GRANTS the resource instead of taking it,
  // capped by whatever room there is: hp never passes maxHp, supplies never pass
  // maxSupplies, move never passes the unit's speed for the round. A negative
  // cost is never a gate - it is always affordable.
  cost: { hp: 0, supplies: 0, move: 0 },
}, o);

export const ABILITIES = {
  //Enemy Abilities
  softeningBite: A({ name: 'Softening Bite', icon: '⚔️', color: '#e0b25f', buff: 'vulnerable', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  rageBite: A({ name: 'Enraging Bite', icon: '🤬', color: '#E84A27', buff: 'enraged', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  headbutt: A({ name: 'Headbutt', icon: '🐏', color: '#e0b25f', damage: 0, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  weakeningBite: A({ name: 'Weakening Bite', icon: '🩼', color: '#38D1AC', buff: 'weaken', castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  lobbedShrapnelBurst: A({ name: 'Lobbed ShrapnelBurst', icon: '💥', color: '#ff9950', damage: 3, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1) }),
  swipe: A({ name: 'Swipe', icon: '💫', color: '#5fc7e0', damage: 5, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [-1, -1], [0, 1]], rotatable: true }),
  //strike
  //heavy strike
  //thundering strike
  lobbedNagentBurst: A({ name: 'Lobbed Nerve Agent', icon: '💥', color: '#ff9950', damage: 1, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1) }),
  //Razeing Antler Swipe
  // A charging shove, written entirely in the fields above: it runs up to three
  // tiles down one spoke (lineOffsets), gores the line it arrives on, shoves the
  // unit it rammed, and takes that unit's tile - or stops just short of it when
  // the shove had nowhere to go. Aiming a dash AT a unit became legal 2026-09-11.
  chargeHeadbutt: A({ name: 'Charge Headbutt', icon: '🐏💨', color: '#e0b25f', damage: 2, castZone: lineOffsets(1, 3), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true, moveToTarget: true }),
  //Web

  //Player Abilities
  strike: A({ name: 'Strike', icon: '⚔️', color: '#e0b25f', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]] }),
  shove: A({ name: 'Shove', icon: '🌀', color: '#ffd75f', damage: 1, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], pushZone: [[0, 0, 0]], rotatable: true }),
  volley: A({ name: 'Volley', icon: '🎯', color: '#a8e05f', damage: 2, castZone: ringOffsets(2, 4), dmgZone: [[0, 0]] }),
  lance: A({ name: 'Lance', icon: '⚡', color: '#5fc7e0', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0], [1, 0], [2, 0]], rotatable: true }),
  // The four `cost` lines below are SAMPLE VALUES, put here so the cost system is
  // visible in play and testable. They are not a balance decision - delete or
  // change any of them freely.
  burst: A({ name: 'Ember Burst', icon: '🔥', color: '#ff9950', damage: 2, castZone: ringOffsets(1, 3), dmgZone: ringOffsets(0, 1), tagZone: [[0, 0]], tagId: 'fire', cost: { move: 1 } }),
  bolt: A({ name: 'Bolt', icon: '☄️', color: '#c66dff', damage: 4, castZone: ringOffsets(1, 2), dmgZone: [[0, 0]], cost: { hp: 1 } }),
  mend: A({ name: 'Mend', icon: '🏥', color: '#a8e05f', heal: 4, castZone: ringOffsets(0, 1), dmgZone: [[0, 0]], cost: { supplies: 1 } }),
  guard: A({ name: 'Guard', icon: '🛡️', color: '#5fc7e0', buff: 'shield', castZone: ringOffsets(0, 1), dmgZone: [[0, 0]], cost: { hp: -1 } }),
  clawSwipe: A({ name: 'Claw Swipe', icon: '🔪', color: '#5fc7e0', damage: 3, castZone: ringOffsets(1, 1), dmgZone: [[0, 0]], rotatable: true })
};


// ========================ABILITY UPGRADE TREES=========================
//
//  The party grows through these: every reward pick unlocks one node of one
//  ability's tree, and the ability is re-derived from its base definition
//  above plus every unlocked node, in the fixed order the nodes are listed.
//
//  Node format (all optional except the texts):
//    name         what the node is called        REQUIRED
//    icon         the glyph the roster window shows on its card
//    desc         what it does, in the player's words - the ONE place this is
//                 written. It used to live in the locale tables as
//                 upgrade.<ability>.<node>.desc, which meant a node's effect
//                 and the sentence describing it were edited in two files and
//                 drifted apart. A translation may still override it: if a
//                 locale defines that key, it wins (see upgradeInfo in
//                 src/upgrades.js).
//    requires     [nodeIds]  - ALL of them must be unlocked first (multi-parent
//                              nodes are how two branches meet in a capstone);
//                              [] / absent = a root, available from the start
//    add          { damage, heal, buffX } - numeric bumps, summed onto the base
//    castZoneAdd  [offsets]  - extra tiles the ability may be aimed at
//    dmgZoneAdd   [offsets]  - extra tiles the effect covers (from the aim point)
//    tagZoneAdd   [offsets]  - extra tiles that receive the ability's tile tag
//    pushDistAdd  n          - every pushZone entry shoves n tiles further
//                              (the engine caps a single shove at 2 tiles)
//    costAdd      { hp, supplies, move } - summed onto the ability's cost, so a
//                              node can make it dearer or (negative) cheaper;
//                              two nodes touching one resource stack
//    flags        { bool }   - switches for upgrade-specific ability logic; the
//                              engine reads them off the resolved def
//
//  The final game plans at least 16 characters / 32 trees; a tree is looked up
//  purely by ability id, so adding one is one entry here and nothing else.
// =====================================================================
const U = (o) => Object.assign({
  name: '', icon: '⭐', desc: '',
  requires: [], add: {}, castZoneAdd: [], dmgZoneAdd: [], tagZoneAdd: [],
  pushDistAdd: 0, flags: {},
  // PASSIVES this node gives the UNIT (status ids from the table below). Note it
  // is the unit that gets them, not the ability: a node can change the ability it
  // hangs off AND make its owner tougher, and the two are unrelated.
  grants: [],
  // Statuses APPLIED TO THE UNIT at a moment, rather than carried forever:
  //     applies: [{ status: 'enraged', when: 'battleStart', x: [null, 3] }]
  // `grants` and `applies` are the two halves of the same idea and differ in
  // exactly one way - a granted row is always on and cannot be removed, an applied
  // one is a real status that ticks down and can be stripped. Use `grants` for
  // "is tougher", `applies` for "starts each fight angry".
  //   status  a row of the STATUSES table
  //   when    the moment. 'battleStart' is the only one the engine knows today;
  //           it is a plain string so 'roundStart', 'onKill' and the rest are new
  //           moments rather than a new system.
  //   x       optional, the status's buffX list, so a node can say how long or
  //           how hard without needing a status row of its own.
  applies: [],
}, o);


export const ABILITY_UPGRADES = {

  clawSwipe: {//A Melee attack that reaches medium range and damage and is capable of being vampiric.
    //Ability Range Upgrades
    //level 1
    cleave: U({
      dmgZoneAdd: [[0, -1], [-1, 1]],
      name: 'Cleave', icon: '✂️', desc: 'Wider swipe that also reaches the tiles next to target'
    }),
    //level 2
    wideCleave: U({
      requires: ['cleave'], dmgZoneAdd: [[-1, -1], [-2, 1]],
      name: 'Wide Cleave', icon: '🌊', desc: 'The swipe covers almost all tiles around'
    }),
    spike: U({
      requires: ['cleave'], dmgZoneAdd: [[1, 0]],
      name: 'Spike', icon: '⚜️', desc: 'The cleave ends in a lunge that reaches for two tiles'
    }),

    //Ability Power Upgrades
    //level 1
    power: U({
      add: { damage: 1 },
      name: 'Strength', icon: '🦾', desc: 'With strengthened sinews, Gorm hits harder'
    }),
    //level 2
    longclaw: U({
      requires: ['power'], add: { damage: 2 },
      name: 'Long Claws', icon: '🪓', desc: 'Large claws for big damage',
    }),
    leechclaw: U({
      requires: ['power'], add: { damage: 1 }, costAdd: { hp: -2 },
      name: 'Leech Claws', icon: '🖤', desc: 'Special channels in the claws siphon material from the target'
    }),
  },


  chargeHeadbutt: {
    //Ability Utility Upgrades
    //level 1
    collisionImmune: U({
      name: 'Padded', icon: '🥊', desc: 'Becomes immune to collisions',
      grants: ['collisionImmune'],
    }),
    //level 2
    regenerate: U({
      requires: ['collisionImmune'],
      name: 'Regenerating', icon: '♻️', desc: 'Regenerates each turn',
      grants: ['regeneration'],
    }),
    beginEnraged: U({
      requires: ['collisionImmune'],
      name: 'Raging Entry', icon: '😡', desc: 'Starts each combat enraged',
      applies: [{ status: 'enraged', when: 'battleStart' }],
    })
  },


  // Strike: melee jab. Branches: hit harder vs hit wider, meeting in Execute.
  strike: {
    edge: U({ name: 'Edge', icon: '🗡️', desc: '+1 damage', add: { damage: 1 } }),
    weight: U({ name: 'Weight', icon: '🪨', desc: '+1 damage', add: { damage: 1 } }),
    reach: U({ name: 'Reach', icon: '📏', desc: 'can strike from 2 tiles away', requires: ['edge'], castZoneAdd: ringOffsets(2, 2) }),
    sweep: U({ name: 'Sweep', icon: '🌀', desc: 'also hits the tiles around the target', requires: ['weight'], dmgZoneAdd: ringOffsets(1, 1) }),
    execute: U({ name: 'Execute', icon: '💀', desc: '+2 damage', requires: ['reach', 'sweep'], add: { damage: 2 } }),
  },
  // Shove: the positioning tool. Distance and damage feed the capstone.
  shove: {
    jolt: U({ name: 'Jolt', icon: '⚡', desc: '+1 damage', add: { damage: 1 } }),
    momentum: U({ name: 'Momentum', icon: '🏃', desc: 'pushes 1 tile further', pushDistAdd: 1 }),
    longarm: U({ name: 'Long Arm', icon: '📏', desc: 'can shove from 2 tiles away', requires: ['jolt'], castZoneAdd: ringOffsets(2, 2) }),
    impact: U({ name: 'Impact', icon: '💥', desc: '+1 damage', requires: ['momentum'], add: { damage: 1 } }),
    avalanche: U({ name: 'Avalanche', icon: '🏔️', desc: '+2 damage', requires: ['longarm', 'impact'], add: { damage: 2 } }),
  },
  // Volley: ranged single shot. Range out, range in, then a splash and a payoff.
  volley: {
    barbed: U({ name: 'Barbed Arrows', icon: '🪝', desc: '+1 damage', add: { damage: 1 } }),
    farsight: U({ name: 'Farsight', icon: '🔭', desc: 'range grows to 5 tiles', castZoneAdd: ringOffsets(5, 5) }),
    closework: U({ name: 'Close Work', icon: '🎯', desc: 'can fire point blank', requires: ['barbed'], castZoneAdd: ringOffsets(1, 1) }),
    rain: U({ name: 'Arrow Rain', icon: '🌧️', desc: 'also hits the tiles around the target', requires: ['farsight'], dmgZoneAdd: ringOffsets(1, 1) }),
    deadeye: U({ name: 'Deadeye', icon: '👁️', desc: '+2 damage', requires: ['closework', 'rain'], add: { damage: 2 } }),
  },
  // Lance: the rotating 3-tile line. Longer line, longer arm, harder hit.
  lance: {
    hone: U({ name: 'Hone', icon: '🔪', desc: '+1 damage', add: { damage: 1 } }),
    extend: U({ name: 'Extend', icon: '📏', desc: 'the line reaches a 4th tile', dmgZoneAdd: [[3, 0]] }),
    pike: U({ name: 'Pike', icon: '🔱', desc: 'can thrust from 2 tiles away', requires: ['hone'], castZoneAdd: ringOffsets(2, 2) }),
    drive: U({ name: 'Drive', icon: '💥', desc: '+1 damage', requires: ['extend'], add: { damage: 1 } }),
    skewer: U({ name: 'Skewer', icon: '🍢', desc: '+2 damage', requires: ['pike', 'drive'], add: { damage: 2 } }),
  },
  // Ember Burst: the fire AoE. Throw further, blast wider, burn wider.
  burst: {
    kindle: U({ name: 'Kindle', icon: '🔥', desc: '+1 damage', add: { damage: 1 } }),
    lob: U({ name: 'Lob', icon: '🏹', desc: 'can be thrown 4 tiles', castZoneAdd: ringOffsets(4, 4) }),
    spread: U({ name: 'Spread', icon: '🌋', desc: 'the blast covers one more ring', requires: ['kindle'], dmgZoneAdd: ringOffsets(2, 2) }),
    scorch: U({ name: 'Scorch', icon: '♨️', desc: 'fire also covers the ring around the centre', requires: ['lob'], tagZoneAdd: ringOffsets(1, 1) }),
    inferno: U({ name: 'Inferno', icon: '☄️', desc: '+1 damage', requires: ['spread', 'scorch'], add: { damage: 1 } }),
  },
  // Bolt: the heavy single-target hit. Two damage steps, two range steps.
  bolt: {
    charge: U({ name: 'Charge', icon: '🔋', desc: '+1 damage', add: { damage: 1 } }),
    arc: U({ name: 'Arc', icon: '🌩️', desc: 'range grows to 3 tiles', castZoneAdd: ringOffsets(3, 3) }),
    surge: U({ name: 'Surge', icon: '⚡', desc: '+1 damage', requires: ['charge'], add: { damage: 1 } }),
    farcast: U({ name: 'Farcast', icon: '🔭', desc: 'range grows to 4 tiles', requires: ['arc'], castZoneAdd: ringOffsets(4, 4) }),
    thunder: U({ name: 'Thunder', icon: '🌪️', desc: '+2 damage', requires: ['surge', 'farcast'], add: { damage: 2 } }),
  },
  // Mend: the heal. Stronger, further, then a healing splash around the target.
  // (The splash heals every unit standing in it - stand apart from enemies.)
  mend: {
    soothe: U({ name: 'Soothe', icon: '💚', desc: '+1 healing', add: { heal: 1 } }),
    tend: U({ name: 'Tend', icon: '📏', desc: 'can heal from 2 tiles away', castZoneAdd: ringOffsets(2, 2) }),
    bloom: U({ name: 'Bloom', icon: '🌸', desc: 'also heals everyone around the target', requires: ['soothe'], dmgZoneAdd: ringOffsets(1, 1) }),
    mercy: U({ name: 'Mercy', icon: '🙏', desc: '+1 healing', requires: ['tend'], add: { heal: 1 } }),
    renewal: U({ name: 'Renewal', icon: '✨', desc: '+2 healing', requires: ['bloom', 'mercy'], add: { heal: 2 } }),
  },
  // Guard: the shield. Learns to patch wounds and to reach further.
  guard: {
    patch: U({ name: 'Patch', icon: '🩹', desc: 'the shield also heals 1', add: { heal: 1 } }),
    brace: U({ name: 'Brace', icon: '📏', desc: 'can shield from 2 tiles away', castZoneAdd: ringOffsets(2, 2) }),
    surgeon: U({ name: 'Surgeon', icon: '⚕️', desc: 'heals 1 more', requires: ['patch'], add: { heal: 1 } }),
    farward: U({ name: 'Far Ward', icon: '🔭', desc: 'can shield from 3 tiles away', requires: ['brace'], castZoneAdd: ringOffsets(3, 3) }),
    aegis: U({ name: 'Aegis', icon: '🛡️', desc: 'heals 2 more', requires: ['surgeon', 'farward'], add: { heal: 2 } }),
  },
};

// Part of the combat config too, so the Settings window can reach the trees the
// way it reaches abilities and statuses. Same object, not a copy.
COMBAT_CONFIG.abilityUpgrades = ABILITY_UPGRADES;

export const abilityById = (id) => ABILITIES[id] ?? null;
export const tagDefById = (id) => COMBAT_TAGS[id] ?? null;
export { DIRS };





// ----- Statuses ("buffs") ----------------------------------------------
//  THE POINT OF THIS TABLE: a status used to be four hand-written fields on a
//  unit plus a branch of engine code each, which meant every new one - even a
//  plain "2 damage a turn for 3 turns" - was surgery in six places, two of them
//  silent (the AI's scoring and the AI's simulation copy). Everything below is
//  built out of verbs the engine ALREADY performs, so a status made of these is
//  a row here and nothing else: no engine change, and the enemy AI understands
//  it on its own. A status that needs a verb this list does not have still needs
//  engine work - but then the VERB is added once and every later status can use
//  it, instead of each status carrying its own code.
//
//  ----- what each building block does, exactly -----
//  EFFECTS (all optional; a status may combine several):
//    speed        added to the carrier's move points, signed. Negative = a slow.
//                 The floor at combat.minSpeed still applies, so a slow can never
//                 pin a unit in place. Read in effSpeed().
//    damageDealt  MULTIPLIER on damage the carrier deals (1 = no change, 2 =
//                 double, 0.5 = half). Applied where an ability's damage is
//                 computed, after the height bonus.
//    damageTaken  MULTIPLIER on damage the carrier receives. Applied in sHit(),
//                 so it covers ability damage, tile tags and crash damage alike.
//    blocks       true = the carrier ignores an incoming hit ENTIRELY (and a
//                 hostile push). One charge is spent per event blocked; within a
//                 single cast one charge covers the whole cast, so a wide
//                 ability cannot chew through a shield with its second tile.
//    skipsTurn    true = the carrier does not act on its activation. One charge
//                 is spent doing that.
//    tickDamage   damage dealt to the carrier at the start of its activation.
//    tickHeal     healing given to the carrier at the start of its activation.
//                 Both tick at exactly the same moment as a tile tag does.
//
//  LIFETIME (how the status ends - a status with neither simply never expires):
//    turns        how many of the carrier's own activations it survives. Counted
//                 down at the start of each of them, AFTER the tick damage /
//                 heal, so "3 turns of poison" deals its damage three times.
//                 0 = no clock.
//    charges      how many times it may be spent before it ends (see spentOn).
//    spentOn      what spends a charge: 'hit' (something was blocked / taken),
//                 'attack' (the carrier cast a damaging ability), 'activation'
//                 (the carrier's turn came up). '' = nothing spends it, only the
//                 turn clock can end it.
//
//  WHAT buffX MEANS - an ability's buffX is a LIST, one entry per knob:
//    A status's KNOBS are its numeric fields, always in this fixed order:
//        speed, damageDealt, damageTaken, tickDamage, tickHeal, turns, charges
//    ...narrowed to the ones THIS status actually uses - a knob counts as in use
//    when the row moved it off its neutral value (0 for the additive ones and the
//    counters, 1 for the two multipliers). statusKnobs(def) returns exactly that
//    list, and the Settings window prints it beside the row so it is never a guess.
//    An ability's `buffX` lines up with that list, in order:
//        buff: 'poison', buffX: [4]        4 damage a turn, for the table's 3 turns
//        buff: 'poison', buffX: [4, 5]     4 damage a turn, for 5 turns
//        buff: 'poison', buffX: [null, 5]  the table's 2 damage, for 5 turns
//        buff: 'poison'                    exactly what the table says
//    A bare number is shorthand for a one-entry list (buffX: 4 is buffX: [4]), and
//    null / an empty slot means "leave that knob as the table wrote it". Values
//    are used AS WRITTEN, sign and all: `slow` is speed -1 in the table, and an
//    ability that wants a harder slow says buffX: [-2].
//    The numbers an ability actually applied are remembered per unit, so two
//    sources of the same status do not have to agree.
//
//  THE ENEMY AI:
//    aiValue      how BAD carrying this status is, in the AI's own scoring units
//                 (a point of damage is 10, a kill 45). Positive = bad for
//                 whoever carries it, so the AI will try to inflict it on the
//                 party and avoid inflicting it on its own side; negative = a
//                 good thing to carry, so the AI hands it to allies and values
//                 stripping it off a party unit. Nothing else has to be taught:
//                 the AI already plays every candidate cast out on a copy of the
//                 board, so a status added here is scored from the next fight on.
//                 A penalty and a bonus are two ROWS, never one row with a sign,
//                 because a row has one aiValue and cannot be a blessing and a
//                 curse at once. That is why `haste` and `slow` are separate.
//
//  DISPLAY: `name` / `icon` / `color` are the fallback; the badge over a unit's
//  head and the card in the panel look for the locale keys status.<id>.name and
//  status.<id>.desc first ({n} is filled with the amount).
const S = (o) => Object.assign({
  name: 'Status', icon: '⭐', color: '#9aa7bd',
  speed: 0, damageDealt: 1, damageTaken: 1, blocks: false, skipsTurn: false,
  tickDamage: 0, tickHeal: 0,
  // Impact kinds this row shrugs off: 'crash' (shoved into a wall or a body),
  // 'fall' (shoved off a ledge) and 'crush' (squashed between two things). Empty
  // = takes them all like everyone else. A LIST rather than a flag so a narrower
  // version ("ignores the wall, not the drop") is a config edit, not a code one.
  ignoresImpact: [],
  turns: 0, charges: 0, spentOn: '',
  // PASSIVE rows are the same rows, carried a different way: a unit is GRANTED
  // them (by an ability upgrade, a relic, or one day a world-map aura) instead of
  // having them applied by a cast, and nothing takes them off. Mechanically that
  // means `turns: 0, charges: 0, spentOn: ''` - which is what "never expires"
  // already meant - and this flag only says so out loud, for the table's reader
  // and for the check at grant time. See PASSIVES below.
  passive: false,
  aiValue: 0,
}, o);


// A status's KNOBS: its numeric fields, in this fixed order. An ability's buffX
// lines up with the ones a given status uses (see WHAT buffX MEANS above).
export const STATUS_KNOBS = ['speed', 'damageDealt', 'damageTaken', 'tickDamage', 'tickHeal', 'turns', 'charges'];
// The value each knob has when a status leaves it alone. The two multipliers rest
// at 1 (x1 changes nothing); everything else rests at 0.
const KNOB_NEUTRAL = { speed: 0, damageDealt: 1, damageTaken: 1, tickDamage: 0, tickHeal: 0, turns: 0, charges: 0 };
// Which knobs THIS status uses, in that order - the list an ability's buffX lines
// up with. Editing a status in the Settings window can change this list: give a
// status a tickDamage and it grows a knob, on the spot.
export function statusKnobs(def) {
  return def ? STATUS_KNOBS.filter((k) => Number(def[k] ?? KNOB_NEUTRAL[k]) !== KNOB_NEUTRAL[k]) : [];
}
// What an ability's buffX changes about a status: { field: value } for the knobs
// it actually named. A bare number counts as a one-entry list; null / '' / a
// non-number in a slot leaves that knob as the table wrote it; anything past the
// end of the knob list is ignored rather than guessed at.
export function statusOverridesFor(def, buffX) {
  const list = buffX === undefined || buffX === null || buffX === '' ? []
    : Array.isArray(buffX) ? buffX : [buffX];
  const knobs = statusKnobs(def);
  const out = {};
  for (let i = 0; i < list.length && i < knobs.length; i++) {
    const n = Number(list[i]);
    if (list[i] === null || list[i] === '' || !Number.isFinite(n)) continue;
    out[knobs[i]] = n;
  }
  return out;
}

export const STATUSES = {
  // The four that already existed, written out in the vocabulary above. Their
  // behaviour is unchanged - this is the same shield, crit, stun and haste.
  shield: S({
    name: 'Shield', icon: '🛡', color: '#5fc7e0',
    blocks: true, charges: 1, spentOn: 'hit',
    aiValue: -14,          // good to carry: the AI guards its allies and pops the party's
  }),
  crit: S({
    name: 'Charged', icon: '⚡', color: '#ffd75f',
    damageDealt: 2, charges: 1, spentOn: 'attack',
    aiValue: -10,
  }),
  stun: S({
    name: 'Stunned', icon: '💫', color: '#c9a8ff',
    skipsTurn: true, charges: 1, spentOn: 'activation',
    aiValue: 12,           // bad to carry: worth about a point of damage more than one
  }),
  haste: S({
    name: 'Hastened', icon: '💨', color: '#a8e05f',
    speed: 1, turns: 2,
    aiValue: -6,           // good to carry
  }),
  slow: S({
    name: 'Slowed', icon: '🐌', color: '#c9a8ff',
    speed: -1, turns: 2,
    aiValue: 9,            // bad to carry - and worth more than haste is worth giving
  }),
  poison: S({
    name: 'Poisoned', icon: '🧪', color: '#8fd14f',
    tickDamage: 2, turns: 3,
    aiValue: 20,              // three ticks of 2, valued a little under the 60 they cost
  }),
  regen: S({
    name: 'Mending', icon: '🌿', color: '#a8e05f',
    tickHeal: 2, turns: 3,
    aiValue: -18,
  }),
  weaken: S({
    name: 'Weakened', icon: '🩼', color: '#b58fd1',
    damageDealt: 0.5, turns: 2,
    aiValue: 16,
  }),
  vulnerable: S({
    name: 'Vulnerable', icon: '🎯', color: '#e2474b',
    damageTaken: 1.5, turns: 2,
    aiValue: 18,
  }),
  enraged: S({
    name: 'Enraged', icon: '🤬', color: '#e2474b',
    damageDealt: 1.5, speed: 2, turns: 1,
    aiValue: -22,
  }),
};

// The table is part of the combat config as well, so the Settings window can edit
// it at runtime. Same object, not a copy: the engine reads config.statuses and the
// UI imports STATUSES, and both see an edit the moment it is made.
// ----- PASSIVES ---------------------------------------------------------
//  A passive is not a second system. It is a row in the table above, carried a
//  different way: something GRANTS it (an ability upgrade's `grants`, a relic,
//  later a world-map aura) and nothing takes it off, where an ordinary status is
//  applied by a cast and ends on a clock or a charge. Every rule the engine reads
//  off a status - speed, the damage multipliers, the ticks, the switches - reads
//  off a passive identically, because it is the same lookup.
//
//  Two consequences worth writing down:
//    * a passive must never be SPENT. `charges` and `spentOn` stay empty, or
//      spendStatus would try to consume something the unit does not really hold.
//      grantCheck() below refuses a row that breaks this.
//    * the set is worked out when a FIGHT STARTS (passivesFor in src/upgrades.js)
//      and fixed for its duration. None of the three sources can change mid-fight,
//      and recomputing per fight is what makes leaving an aura's radius drop the
//      passive by itself, with nobody having to remember to remove it.
Object.assign(STATUSES, {
  collisionImmune: S({
    name: 'Padded', icon: '🥊', color: '#b0714a',
    passive: true,
    // All three kinds: shoved into a wall, shoved off a ledge, squashed between
    // two things. (Being crushed FLAT - shoved into something with nowhere left
    // to go - is still lethal: that is not damage taken, it is no room to exist.)
    ignoresImpact: ['crash', 'fall', 'crush'],
    aiValue: -12,          // good to carry
  }),
  regeneration: S({
    name: 'Regenerating', icon: '♻️', color: '#a8e05f',
    passive: true,
    tickHeal: 2,           // at the start of each of the carrier's own turns
    aiValue: -20,          // good to carry, and it never runs out
  }),
});

// Is this row fit to be granted as a passive? A passive is never spent, so a row
// with charges or a spendOn would quietly misbehave the first time something tried
// to consume it. Returns an error string, or null when the row is fine.
export function grantCheck(id) {
  const def = STATUSES[id];
  if (!def) return `no status row named "${id}"`;
  if (def.charges > 0 || def.spentOn) return `"${id}" is spent by use (charges/spentOn) and cannot be a passive`;
  return null;
}

COMBAT_CONFIG.statuses = STATUSES;

export const statusById = (id) => STATUSES[id] ?? null;

// (The INTELLECT CLASSES moved to config/units.js on 2026-09-10. A class is a
//  property of a CREATURE - which facts it can weigh on its turn - so it belongs
//  beside the bestiary that hands one to every row, not in the abilities table.
//  The engine still reads it as `config.intellect`; only the file changed.)

// ----- Tile tags -------------------------------------------------------
const T = (o) => Object.assign({
  name: 'Tag', icon: '⭐', color: '#ff9950', desc: '',
  dmg: 0, heal: 0, life: 0, hp: 0,
  pushable: false, collectible: false, passPickup: false,
  onDestroy: null, onExpire: null, onPickup: null, onPeriodic: null,
  everyX: 0, everyOff: 0,
}, o);

export const COMBAT_TAGS = {
  fire: T({ name: 'Fire', icon: '🔥', color: '#ff9950', desc: 'Burns anything standing here.', dmg: 1, life: 2 }),
};

// Tags are part of the combat config too, so they can be edited in Settings the
// way statuses can (2026-09-10 - until then they were the one piece of arena
// content you had to open a file to change). Same object, not a copy: tagDefById
// and the Settings window see the same table.
COMBAT_CONFIG.tags = COMBAT_TAGS;

// (The per-unit combat stats used to live here, in a UNIT_COMBAT table. They were
// a UNITS matter, not an abilities one, and they duplicated the roster: since
// 2026-09-06 a character carries init / speed / flying / abilities on its own
// roster row in config/units.js, next to its body, exactly as a bestiary row does
// for a creature. `combatStatsFor` moved there with them.)


