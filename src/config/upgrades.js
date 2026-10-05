// ============================ABILITY UPGRADE TREES==============================
//  The party grows through these: a reward pick unlocks one node of one
//  ability's tree. A node changes the UNIT (its stats), the ABILITY (its
//  effects, zones, cost) or gives the unit TRIGGERS - and nothing else, so
//  the whole of what a node can do is the four fields below.
//
//  Node format:
//    name / icon / desc / lore   what the reward card shows (desc = the
//                 mechanical one-liner; lore = optional flavour)
//  ----- prerequisites -----
//    requires     [nodeIds] ALL of them must be unlocked first
//    requiresAny  [nodeIds] at least ONE of them must be unlocked first
//                 (both empty = a root, open from the start)
//    auto         { count: n } - not picked: owned by itself once the unit has
//                 n picked nodes in this tree (the shape milestones)
//  ----- what it changes -----
//    unit         { maxHp, speed, stackMax, stackGen } summed onto the unit's
//                 own stats (maxHp also raises its current hp when unlocked)
//    tune         { <effectId>: { <field>: delta } } - ADDS to an effect's
//                 field: a number or terms onto a quantity (see rules.js),
//                 offsets onto a zone. The id 'cast' is the ability itself:
//                 tune: { cast: { castZone: [...], cost: { hp: 1 }, aims: 1 } }
//    set          { <effectId>: { <field>: value } } - REPLACES a field;
//                 a value with a `kind` replaces the whole effect, null removes it
//    effects      [effect, ...] appended to the ability (rules.js). An effect
//                 with no zone of its own covers every tile the main hit does,
//                 whatever shape the hit has been given.
//    triggers     [trigger, ...] the UNIT gets (rules.js) - a passive
//  Upgrades fold in the order the tree lists them, so the result never depends
//  on the order they were unlocked in.
//
//  Reading the trees: the names in the comments are the stickers on the
//  design board; the green stat nodes are written with the `unit` field only.
// ----------------------------------DEFINITION-----------------------------------
import { ringOffsets, lineOffsets } from '../local/battle/bhex.js';

const U = (o) => Object.assign({
  name: '', icon: '⭐', desc: '', lore: '',
  requires: [], requiresAny: [], auto: null,
  unit: {}, tune: {}, set: {}, effects: [], triggers: [],
}, o);
// The green stat stickers, one helper each (they are nodes like any other).
const HP = (n, pre = {}) => U({ name: `Vitality +${n}`, icon: '❤️', desc: `+${n} max hp`, unit: { maxHp: n }, ...pre });
const MV = (n, pre = {}) => U({ name: `Stride +${n}`, icon: '👣', desc: `+${n} movement`, unit: { speed: n }, ...pre });
const SMAX = (n, pre = {}) => U({ name: `Capacity +${n}`, icon: '🔶', desc: `+${n} max stacks`, unit: { stackMax: n }, ...pre });
const SGEN = (n, pre = {}) => U({ name: `Flow +${n}`, icon: '📈', desc: `+${n} stacks per turn`, unit: { stackGen: n }, ...pre });
const DMG = (n, pre = {}) => U({ name: `Damage +${n}`, icon: '🗡️', desc: `+${n} damage`, tune: { hit: { amount: n } }, ...pre });
const HEAL = (n, pre = {}) => U({ name: `Healing +${n}`, icon: '💚', desc: `+${n} healing`, tune: { heal: { amount: n } }, ...pre });
// A shape is the main hit's zone replaced (the purple stickers).
const SHAPE = (zone, pre = {}) => U({ name: 'Shape', icon: '⬡', desc: 'the attack takes a new shape', set: { hit: { zone } }, ...pre });
const CLEAVE = [[0, 0], [0, -1], [-1, 1]];          // the target and the two tiles beside it
const CONSUME = { kind: 'consume', resource: 'stacks' };
const self = (status, extra = {}) => ({ kind: 'status', targets: 'self', status, ...extra });
// -------------------------------------TABLE-------------------------------------
export const ABILITY_UPGRADES = {

  // =========================== RAM (Gorm) ===================================
  ram: {
    // ----- CC path -----
    cc0: MV(1),
    cc1a: U({
      name: 'Winding Blow', icon: '🐌', desc: '-2 movement on the target next turn', requires: ['cc0'],
      effects: [{ kind: 'status', status: 'slug', amount: 2, turns: 1 }]
    }),
    cc1b: U({
      name: 'Momentum Bruise', icon: '🎯', desc: 'Vulnerable 1, +1 per two tiles travelled before the attack', requires: ['cc0'],
      effects: [{ kind: 'status', status: 'vulnerable', amount: [{ n: 1 }, { per: 'tilesTravelled', every: 2 }], turns: 1 }]
    }),
    cc2a: HP(2, { requiresAny: ['cc1a', 'cc1b'] }),
    cc2b: U({ name: 'Longer Run', icon: '📏', desc: '+1 range', requiresAny: ['cc1a', 'cc1b'], tune: { cast: { castZone: lineOffsets(3, 3) } } }),
    cc2c: MV(1, { requiresAny: ['cc1a', 'cc1b'] }),
    cc2d: SGEN(1, { requiresAny: ['cc1a', 'cc1b'] }),
    cc3a: U({
      name: 'Over the Horns', icon: '🔃', desc: 'the target is thrown over Gorm into the tile behind him', requires: ['cc2a', 'cc2b'],
      set: { push: { kind: 'throw', to: 'behindCaster' } }
    }),
    cc3b: U({
      name: 'Pinned', icon: '🌱', desc: 'the target is rooted for two turns', requires: ['cc2a', 'cc2c'],
      effects: [{ kind: 'status', status: 'rooted', turns: 2 }]
    }),
    cc3c: U({
      name: 'Dread', icon: '😨', desc: 'the target fears staying next to Gorm', requires: ['cc2b', 'cc2d'],
      effects: [{ kind: 'status', status: 'fear', turns: 2 }]
    }),
    cc3d: U({
      name: 'Rattled', icon: '🙈', desc: 'the target cannot use ranged abilities for a turn', requires: ['cc2c', 'cc2d'],
      effects: [{ kind: 'status', status: 'noRanged', turns: 1 }]
    }),
    cc4a: MV(2, { requiresAny: ['cc3a', 'cc3b', 'cc3c', 'cc3d'] }),
    cc4b: U({ name: 'Longest Run', icon: '📏', desc: '+1 range', requiresAny: ['cc3a', 'cc3b', 'cc3c', 'cc3d'], tune: { cast: { castZone: lineOffsets(4, 4) } } }),
    cc4c: DMG(1, { requiresAny: ['cc3a', 'cc3b', 'cc3c', 'cc3d'] }),
    cc5a: U({
      name: 'Downhill', icon: '⛰️', desc: 'every 2 elevation steps down to the target add a tile of push', requires: ['cc4a', 'cc4b'],
      tune: { push: { dist: { per: 'elevationDrop', every: 2 } } }
    }),
    cc5b: U({
      name: 'Stampede', icon: '🐃', desc: 'consume all stacks: push 1 tile further per 2 consumed', requires: ['cc4a', 'cc4c'],
      effects: [CONSUME], tune: { push: { dist: { per: 'consumed', every: 2 } } }
    }),
    cc5c: SHAPE(CLEAVE, { name: 'Sweeping Horns', desc: 'the ram becomes a cleave', requires: ['cc4a', 'cc4b', 'cc4c'] }),
    cc5d: U({
      name: 'Concussion', icon: '💫', desc: 'the target is stunned', requires: ['cc4b', 'cc4c'],
      effects: [{ kind: 'status', status: 'stun', turns: 1 }]
    }),
    cc5e: U({
      name: 'Rattle the Skull', icon: '❓', desc: 'consume all stacks: Confused 1 per stack consumed', requires: ['cc4c'],
      effects: [CONSUME, { kind: 'status', status: 'confused', turns: { per: 'consumed' } }]
    }),
    cc6a: HP(3, { requiresAny: ['cc5a', 'cc5b', 'cc5c', 'cc5d', 'cc5e'] }),
    cc6b: SMAX(2, { requiresAny: ['cc5a', 'cc5b', 'cc5c', 'cc5d', 'cc5e'] }),
    cc6c: MV(1, { requiresAny: ['cc5a', 'cc5b', 'cc5c', 'cc5d', 'cc5e'] }),
    cc6d: DMG(2, { requiresAny: ['cc5a', 'cc5b', 'cc5c', 'cc5d', 'cc5e'] }),

    // // ----- Damage path -----
    // dp0: DMG(1),
    // dp1a: U({ name: 'Bruising', icon: '🩼', desc: 'the target deals 1 less damage next turn', requires: ['dp0'],
    //   effects: [{ kind: 'status', status: 'weak', amount: 1, turns: 1 }] }),
    // dp1b: U({ name: 'Raging Entry', icon: '😡', desc: 'starts each battle enraged', requires: ['dp0'],
    //   triggers: [{ when: 'battleStart', kind: 'status', status: 'enraged', amount: 1, turns: 1 }] }),
    // dp2a: HP(2, { requiresAny: ['dp1a', 'dp1b'] }),
    // dp2b: SMAX(1, { requiresAny: ['dp1a', 'dp1b'] }),
    // dp2c: SGEN(1, { requiresAny: ['dp1a', 'dp1b'] }),
    // dp2d: DMG(1, { requiresAny: ['dp1a', 'dp1b'] }),
    // dp3a: U({ name: 'Finisher', icon: '💀', desc: 'double damage against a stunned target', requires: ['dp2a', 'dp2b'],
    //   tune: { hit: { multiplier: { n: 1, if: { 'targetHas:stun': true } } } } }),
    // dp3b: U({ name: 'Exposed', icon: '🎯', desc: 'the target is Vulnerable 1 for a turn', requires: ['dp2c', 'dp2d'],
    //   effects: [{ kind: 'status', status: 'vulnerable', amount: 1, turns: 1 }] }),
    // dp4a: SGEN(1, { requiresAny: ['dp3a', 'dp3b'] }),
    // dp4b: MV(1, { requiresAny: ['dp3a', 'dp3b'] }),
    // dp4c: DMG(2, { requiresAny: ['dp3a', 'dp3b'] }),
    // dp5a: U({ name: 'Unleash', icon: '🔶', desc: 'consume all stacks: +1 damage per stack consumed', requires: ['dp4a'],
    //   effects: [CONSUME], tune: { hit: { amount: { per: 'consumed' } } } }),
    // dp5b: U({ name: 'Shield Breaker', icon: '🛡️', desc: 'ignores shields', requires: ['dp4a', 'dp4b'], set: { hit: { pierce: true } } }),
    // dp5c: U({ name: 'Grudge', icon: '🤬', desc: 'when hit, enraged next turn', requires: ['dp4b'],
    //   triggers: [{ when: 'hit', kind: 'status', status: 'enraged', amount: 1, turns: 1 }] }),
    // dp5d: U({ name: 'Run-up', icon: '👣', desc: '+1 damage for every movement point spent', requires: ['dp4b', 'dp4c'],
    //   tune: { hit: { amount: { per: 'moveSpent' } } } }),
    // dp6a: HP(3, { requiresAny: ['dp5a', 'dp5b', 'dp5c', 'dp5d'] }),
    // dp6b: SGEN(1, { requiresAny: ['dp5a', 'dp5b', 'dp5c', 'dp5d'] }),
    // dp6c: DMG(2, { requiresAny: ['dp5a', 'dp5b', 'dp5c', 'dp5d'] }),

    // ----- Tank path -----
    tk0: HP(2),
    tk1a: U({
      name: 'Padded', icon: '🥊', desc: 'immune to collisions', requires: ['tk0'],
      triggers: [{ when: 'battleStart', kind: 'status', status: 'padded' }]
    }),
    tk1b: U({
      name: 'Battering Ram', icon: '💥', desc: 'collisions hurt Gorm and whatever he hits twice as much', requires: ['tk0'],
      triggers: [{ when: 'battleStart', kind: 'status', status: 'heavyCollision' }]
    }),
    tk2a: HP(3, { requiresAny: ['tk1a', 'tk1b'] }),
    tk2b: SMAX(1, { requiresAny: ['tk1a', 'tk1b'] }),
    tk2c: DMG(1, { requiresAny: ['tk1a', 'tk1b'] }),
    tk2d: MV(1, { requiresAny: ['tk1a', 'tk1b'] }),
    tk3a: U({
      name: 'Regrowth', icon: '🌿', desc: 'Regeneration 1 every turn', requires: ['tk2a', 'tk2b'],
      triggers: [{ when: 'activationStart', kind: 'status', status: 'regen', amount: 1 }]
    }),
    tk3b: U({
      name: 'Bellow', icon: '📣', desc: 'taunts every enemy within a tile of where Gorm lands', requires: ['tk2a', 'tk2c'],
      effects: [{ kind: 'status', anchor: 'landing', zone: ringOffsets(1, 1), targets: 'enemies', status: 'taunt', turns: 1 }]
    }),
    tk3c: U({
      name: 'Through the Line', icon: '🤝', desc: 'the charge passes through allies', requires: ['tk2b', 'tk2d'],
      set: { dash: { through: 'allies' } }
    }),
    tk3d: U({
      name: 'Hard Shell', icon: '🪨', desc: '-1 incoming damage', requires: ['tk2c', 'tk2d'],
      triggers: [{ when: 'battleStart', kind: 'status', status: 'impervious', amount: 1, turns: 0 }]
    }),
    tk4a: HP(3, { requiresAny: ['tk3a', 'tk3b', 'tk3c', 'tk3d'] }),
    tk4b: SMAX(1, { requiresAny: ['tk3a', 'tk3b', 'tk3c', 'tk3d'] }),
    tk4c: MV(1, { requiresAny: ['tk3a', 'tk3b', 'tk3c', 'tk3d'] }),
    tk5a: U({
      name: 'Dig In', icon: '⚓', desc: 'not moving: +1 stack generation, Shielded 1 and Regeneration 1', requires: ['tk4a', 'tk4b'],
      triggers: [
        { when: 'activationEnd', if: { didNotMove: true }, kind: 'status', status: 'amplified', amount: 1, turns: 1 },
        { when: 'activationEnd', if: { didNotMove: true }, kind: 'status', status: 'shielded', amount: 1 },
        { when: 'activationEnd', if: { didNotMove: true }, kind: 'status', status: 'regen', amount: 1 },
      ]
    }),
    tk5b: U({
      name: 'Second Wind', icon: '🌿', desc: 'consume all stacks: Regeneration 1 per stack consumed', requires: ['tk4a', 'tk4c'],
      effects: [CONSUME, self('regen', { amount: { per: 'consumed' } })]
    }),
    tk5c: U({
      name: 'Carapace', icon: '🛡', desc: 'consume all stacks: Shielded 1 per stack consumed', requires: ['tk4a', 'tk4b', 'tk4c'],
      effects: [CONSUME, self('shielded', { amount: { per: 'consumed' } })]
    }),
    tk5d: U({
      name: 'Full Tilt', icon: '🏃', desc: 'after 4 or more tiles: +1 damage and push 1 tile further', requires: ['tk4b', 'tk4c'],
      tune: { hit: { amount: { n: 1, if: { tilesTravelled: { min: 4 } } } }, push: { dist: { n: 1, if: { tilesTravelled: { min: 4 } } } } }
    }),
    tk5e: U({
      name: 'Mountain Goat', icon: '🏔️', desc: 'ramming uphill: Shielded by the climb; downhill: +1 damage', requires: ['tk4c'],
      effects: [self('shielded', { amount: { per: 'elevationClimb' }, if: { elevationClimb: { min: 1 } } })],
      tune: { hit: { amount: { n: 1, if: { elevationDrop: { min: 1 } } } } }
    }),
    tk6a: HP(4, { requiresAny: ['tk5a', 'tk5b', 'tk5c', 'tk5d', 'tk5e'] }),
    tk6b: SGEN(1, { requiresAny: ['tk5a', 'tk5b', 'tk5c', 'tk5d', 'tk5e'] }),
    tk6c: MV(1, { requiresAny: ['tk5a', 'tk5b', 'tk5c', 'tk5d', 'tk5e'] }),
    tk6d: DMG(2, { requiresAny: ['tk5a', 'tk5b', 'tk5c', 'tk5d', 'tk5e'] }),
  },

  // =========================== CLAW SWIPE (Gorm) ============================
  clawSwipe: {
    // ----- Bleed path -----
    bl0: DMG(1),
    bl1a: U({
      name: 'Rending', icon: '🩸', desc: 'applies Bleed 2', requires: ['bl0'],
      effects: [{ kind: 'status', status: 'bleed', amount: 2 }]
    }),
    bl1b: SHAPE(CLEAVE, { name: 'Wide Swipe', desc: 'the swipe also reaches the tiles beside the target', requires: ['bl0'] }),
    bl2a: HP(3, { requiresAny: ['bl1a', 'bl1b'] }),
    bl2b: SMAX(1, { requiresAny: ['bl1a', 'bl1b'] }),
    bl2c: DMG(1, { requiresAny: ['bl1a', 'bl1b'] }),
    bl2d: MV(1, { requiresAny: ['bl1a', 'bl1b'] }),
    bl3a: U({
      name: 'War Cry', icon: '📣', desc: 'allies start each battle Enraged 1', requires: ['bl2a', 'bl2b'],
      triggers: [{ when: 'battleStart', kind: 'status', targets: 'allies', status: 'enraged', amount: 1, turns: 1 }]
    }),
    bl3c: U({
      name: 'Raging Entry', icon: '😡', desc: 'starts each battle enraged', requires: ['bl2c', 'bl2d'],
      triggers: [{ when: 'battleStart', kind: 'status', status: 'enraged', amount: 1, turns: 1 }]
    }),
    bl3d: U({
      name: 'Flurry', icon: '🌀', desc: '-2 damage, one more hit', requires: ['bl2c', 'bl2d'],
      tune: { hit: { amount: -2, times: 1 } }
    }),
    bl4a: HP(3, { requiresAny: ['bl3a', 'bl3c', 'bl3d'] }),
    bl4b: SMAX(1, { requiresAny: ['bl3a', 'bl3c', 'bl3d'] }),
    bl4c: MV(1, { requiresAny: ['bl3a', 'bl3c', 'bl3d'] }),
    bl6a: HP(4, { requiresAny: ['bl4a', 'bl4b', 'bl4c'] }),
    bl6b: SGEN(1, { requiresAny: ['bl4a', 'bl4b', 'bl4c'] }),
    bl6c: MV(1, { requiresAny: ['bl4a', 'bl4b', 'bl4c'] }),
    bl6d: DMG(2, { requiresAny: ['bl4a', 'bl4b', 'bl4c'] }),

    // // ----- Damage path -----
    // dmg1: U({ name: 'Coiled', icon: '🔶', desc: 'unspent movement becomes stacks next turn',
    //   triggers: [{ when: 'activationEnd', kind: 'gain', resource: 'stacks', amount: { per: 'moveLeft' } }] }),

    // ----- Lifesteal path -----
    ls0: HP(2),
    ls1a: U({ name: 'Leech Claws', icon: '🖤', desc: '+1 lifesteal', requires: ['ls0'], tune: { hit: { lifesteal: 1 } } }),
    ls1b: U({
      name: 'Blood Bond', icon: '🔗', desc: 'the target gets Lifelink: Gorm heals 1 whenever it is damaged', requires: ['ls0'],
      effects: [{ kind: 'status', status: 'lifelink', turns: 2 }]
    }),
    ls2a: HP(3, { requiresAny: ['ls1a', 'ls1b'] }),
    ls2b: SMAX(1, { requiresAny: ['ls1a', 'ls1b'] }),
    ls2c: DMG(1, { requiresAny: ['ls1a', 'ls1b'] }),
    ls2d: MV(1, { requiresAny: ['ls1a', 'ls1b'] }),
    ls3a: U({
      name: 'Spite', icon: '🖤', desc: 'when hit: +1 lifesteal until the end of the turn', requires: ['ls2a', 'ls2b'],
      triggers: [{ when: 'hit', kind: 'status', status: 'lifesteal', amount: 1, turns: 1 }]
    }),
    ls3c: U({
      name: 'Hunger', icon: '🔶', desc: 'consume all stacks: +1 lifesteal per 2 consumed until the end of the turn', requires: ['ls2c', 'ls2d'],
      effects: [CONSUME, self('lifesteal', { amount: { per: 'consumed', every: 2 }, turns: 1 })]
    }),
    ls4a: HP(3, { requiresAny: ['ls3a', 'ls3c'] }),
    ls4b: SMAX(1, { requiresAny: ['ls3a', 'ls3c'] }),
    ls4c: MV(1, { requiresAny: ['ls3a', 'ls3c'] }),
    ls6a: HP(4, { requiresAny: ['ls4a', 'ls4b', 'ls4c'] }),
    ls6b: SGEN(1, { requiresAny: ['ls4a', 'ls4b', 'ls4c'] }),
    ls6c: MV(1, { requiresAny: ['ls4a', 'ls4b', 'ls4c'] }),
    ls6d: DMG(2, { requiresAny: ['ls4a', 'ls4b', 'ls4c'] }),
  },

  // =========================== SPIKE SHOT (Viridi) ==========================
  spikeShot: {
    // ----- Spread path -----
    sp0: MV(1),
    sp1a: U({ name: 'Scatter', icon: '🎯', desc: 'each hit can be aimed at its own tile', requires: ['sp0'], tune: { cast: { aims: 1 } } }),
    sp1b: SHAPE([[0, 0], [1, 0]], { name: 'Long Volley', desc: 'the quills reach a tile further', requires: ['sp0'] }),
    sp2a: DMG(1, { requiresAny: ['sp1a', 'sp1b'] }),
    sp2b: SMAX(1, { requiresAny: ['sp1a', 'sp1b'] }),
    sp2c: MV(1, { requiresAny: ['sp1a', 'sp1b'] }),
    sp2d: HP(2, { requiresAny: ['sp1a', 'sp1b'] }),
    sp3b: U({
      name: 'Weak Toxin', icon: '🧪', desc: 'the quills are tipped with a weak toxin: Weak 1', requires: ['sp2a', 'sp2b'],
      effects: [{ kind: 'status', status: 'weak', amount: 1, turns: 1 }]
    }),
    sp4a: HP(3, { requiresAny: ['sp3b'] }),
    sp4b: SMAX(1, { requiresAny: ['sp3b'] }),
    sp4c: MV(1, { requiresAny: ['sp3b'] }),
    sp6a: HP(4, { requiresAny: ['sp4a', 'sp4b', 'sp4c'] }),
    sp6b: SGEN(1, { requiresAny: ['sp4a', 'sp4b', 'sp4c'] }),
    sp6c: MV(1, { requiresAny: ['sp4a', 'sp4b', 'sp4c'] }),
    sp6d: DMG(2, { requiresAny: ['sp4a', 'sp4b', 'sp4c'] }),

    // ----- Wither path -----
    w0: HP(2),
    w1a: U({
      name: 'Sapping Quills', icon: '🩼', desc: 'Weak 1: -1 damage dealt by the target next turn', requires: ['w0'],
      effects: [{ kind: 'status', status: 'weak', amount: 1, turns: 1 }]
    }),
    w1b: U({
      name: 'Wither Cloud', icon: '🥀', desc: 'leaves a wither cloud on the tile', requires: ['w0'],
      effects: [{ id: 'cloud', kind: 'tag', tag: 'witherCloud' }]
    }),
    w2a: SGEN(1, { requiresAny: ['w1a', 'w1b'] }),
    w2b: SMAX(1, { requiresAny: ['w1a', 'w1b'] }),
    w2c: DMG(1, { requiresAny: ['w1a', 'w1b'] }),
    w2d: MV(1, { requiresAny: ['w1a', 'w1b'] }),
    w3a: U({
      name: 'Enfeeble', icon: '🔶', desc: 'consume all stacks: Weak 1, +1 per 2 consumed', requires: ['w2a', 'w2b'],
      effects: [CONSUME, { kind: 'status', status: 'weak', amount: [{ n: 1 }, { per: 'consumed', every: 2 }], turns: 1 }]
    }),
    w3c: U({
      name: 'Wither-proof', icon: '🌼', desc: 'immune to Wither', requires: ['w2c', 'w2d'],
      triggers: [{ when: 'battleStart', kind: 'status', status: 'witherImmune' }]
    }),
    w3d: SHAPE([[0, 0], [0, -1], [-1, 1]], { name: 'Fan of Quills', desc: 'the quills fan out over three tiles', requires: ['w2c', 'w2d'] }),
    w4a: SMAX(1, { requiresAny: ['w3a', 'w3c', 'w3d'] }),
    w4b: HP(3, { requiresAny: ['w3a', 'w3c', 'w3d'] }),
    w4c: MV(1, { requiresAny: ['w3a', 'w3c', 'w3d'] }),
    w5a: U({
      name: 'Shared Immunity', icon: '🌼', desc: 'allies are immune to Wither', requires: ['w4a'],
      triggers: [{ when: 'battleStart', kind: 'status', targets: 'allies', status: 'witherImmune' }]
    }),
    w5b: U({
      name: 'Blight', icon: '🥀', desc: 'consume all stacks: one Wither per stack consumed', requires: ['w4a', 'w4b'],
      effects: [CONSUME, { kind: 'status', status: 'wither', amount: 1, turns: 2, repeat: { per: 'consumed' } }]
    }),
    w5c: U({
      name: 'Kindred Spores', icon: '💞', desc: 'the target counts Viridi as an ally for 2 turns', requires: ['w4a', 'w4b', 'w4c'],
      effects: [{ kind: 'status', status: 'charm', turns: 2 }]
    }),
    w5d: U({
      name: 'Cloud Dweller', icon: '❤️‍🔥', desc: 'standing in a wither cloud: +4 max hp this turn', requires: ['w4b', 'w4c'],
      triggers: [{ when: 'activationStart', if: { 'onTag:witherCloud': true }, kind: 'status', status: 'fortified', amount: 4, turns: 1 }]
    }),
    w5e: U({
      name: 'Cloud Hunter', icon: '🗡️', desc: 'standing in a wither cloud: +2 damage', requires: ['w4c'],
      tune: { hit: { amount: { n: 2, if: { 'onTag:witherCloud': true } } } }
    }),
    w6a: HP(4, { requiresAny: ['w5a', 'w5b', 'w5c', 'w5d', 'w5e'] }),
    w6b: SGEN(1, { requiresAny: ['w5a', 'w5b', 'w5c', 'w5d', 'w5e'] }),
    w6c: MV(1, { requiresAny: ['w5a', 'w5b', 'w5c', 'w5d', 'w5e'] }),
    w6d: DMG(2, { requiresAny: ['w5a', 'w5b', 'w5c', 'w5d', 'w5e'] }),
  },

  // =========================== GLAIVE (Feren) ===============================
  glaive: {
    // ----- Agility path -----
    ag0: MV(1),
    ag1b: SHAPE([[0, 0], [1, 0]], { name: 'Lunge', desc: 'the jab reaches a tile further', requires: ['ag0'] }),
    ag2a: MV(1, { requiresAny: ['ag1b'] }),
    ag2b: SMAX(1, { requiresAny: ['ag1b'] }),
    ag2c: HP(2, { requiresAny: ['ag1b'] }),
    ag2d: SGEN(1, { requiresAny: ['ag1b'] }),
    ag3b: U({
      name: 'Momentum Guard', icon: '🛡', desc: 'moving more than 3 tiles gives Shielded 2', requires: ['ag2a', 'ag2b'],
      triggers: [{ when: 'moved', if: { tilesTravelled: { min: 4 } }, kind: 'status', status: 'shielded', amount: 2 }]
    }),
    ag3c: U({
      name: 'Release', icon: '🔶', desc: 'consume all stacks: +1 damage per 2 consumed', requires: ['ag2c'],
      effects: [CONSUME], tune: { hit: { amount: { per: 'consumed', every: 2 } } }
    }),
    ag3d: U({
      name: 'Carry-over', icon: '👣', desc: 'up to 1 unspent movement carries over into the next turn', requires: ['ag2c', 'ag2d'],
      triggers: [{ when: 'activationEnd', kind: 'status', status: 'haste', amount: { per: 'moveLeft', max: 1 }, turns: 1 }]
    }),
    ag4a: HP(3, { requiresAny: ['ag3b', 'ag3c', 'ag3d'] }),
    ag4b: SMAX(1, { requiresAny: ['ag3b', 'ag3c', 'ag3d'] }),
    ag4c: MV(1, { requiresAny: ['ag3b', 'ag3c', 'ag3d'] }),
    ag5a: U({ name: 'Piercing Point', icon: '🛡️', desc: 'ignores shields', requires: ['ag4a'], set: { hit: { pierce: true } } }),
    ag5b: U({
      name: 'Stung', icon: '🤬', desc: 'when hit: enraged next turn', requires: ['ag4a', 'ag4b'],
      triggers: [{ when: 'hit', kind: 'status', status: 'enraged', amount: 1, turns: 1 }]
    }),
    ag5c: SHAPE([[0, 0], [1, 0], [2, 0]], { name: 'Long Lunge', desc: 'the jab runs three tiles', requires: ['ag4a', 'ag4b', 'ag4c'] }),
    ag5d: U({
      name: 'Follow-through', icon: '🔁', desc: 'a killing blow gives another attack', requires: ['ag4b', 'ag4c'],
      triggers: [{ when: 'kill', kind: 'extraAttack' }]
    }),
    ag6a: HP(4, { requiresAny: ['ag5a', 'ag5b', 'ag5c', 'ag5d'] }),
    ag6b: SGEN(1, { requiresAny: ['ag5a', 'ag5b', 'ag5c', 'ag5d'] }),
    ag6c: MV(1, { requiresAny: ['ag5a', 'ag5b', 'ag5c', 'ag5d'] }),
    ag6d: DMG(2, { requiresAny: ['ag5a', 'ag5b', 'ag5c', 'ag5d'] }),

    // ----- the shape milestones: owned by themselves at 4 / 8 / 12 picks -----
    shape4: SHAPE([[0, 0], [0, -1]], { name: 'Honed Edge', desc: 'after 4 upgrades: the blade reaches a second tile', auto: { count: 4 } }),
    shape8: SHAPE([[0, 0], [0, -1], [-1, 1]], { name: 'Broad Edge', desc: 'after 8 upgrades: the blade sweeps three tiles', auto: { count: 8 } }),
    shape12: SHAPE([[0, 0], [0, -1], [-1, 1], [1, 0]], { name: 'Great Edge', desc: 'after 12 upgrades: the blade sweeps four tiles', auto: { count: 12 } }),

    // ----- Custodian path -----
    cu0: HP(2),
    cu1a: U({
      name: 'Planted Feet', icon: '⚓', desc: 'not moving: +1 damage', requires: ['cu0'],
      tune: { hit: { amount: { n: 1, if: { didNotMove: true } } } }
    }),
    cu1b: U({
      name: 'Ward', icon: '🛡', desc: 'starts each battle Shielded 2', requires: ['cu0'],
      triggers: [{ when: 'battleStart', kind: 'status', status: 'shielded', amount: 2 }]
    }),
    cu2a: SGEN(1, { requiresAny: ['cu1a', 'cu1b'] }),
    cu2b: SMAX(1, { requiresAny: ['cu1a', 'cu1b'] }),
    cu2c: DMG(1, { requiresAny: ['cu1a', 'cu1b'] }),
    cu2d: MV(1, { requiresAny: ['cu1a', 'cu1b'] }),
    cu3a: U({
      name: 'Stored Force', icon: '🔶', desc: 'not moving: consume all stacks, +1 damage per 2 consumed', requires: ['cu2a', 'cu2b'],
      effects: [{ ...CONSUME, if: { didNotMove: true } }], tune: { hit: { amount: { per: 'consumed', every: 2 } } }
    }),
    cu3b: U({
      name: 'Bulwark', icon: '🛡', desc: 'not moving: consume all stacks, every other party member gets Shielded 1', requires: ['cu2a', 'cu2b'],
      effects: [{ ...CONSUME, if: { didNotMove: true } }, { kind: 'status', targets: 'allies', status: 'shielded', amount: 1, if: { didNotMove: true } }]
    }),
    cu3c: U({
      name: 'First Blood', icon: '🗡️', desc: '+2 damage against a target at 80% hp or more', requires: ['cu2c', 'cu2d'],
      tune: { hit: { amount: { n: 2, if: { targetHpFrac: { min: 0.8 } } } } }
    }),
    cu3d: U({
      name: 'Numbing Edge', icon: '🩼', desc: 'Weak 2: -2 damage dealt by the target next turn', requires: ['cu2c', 'cu2d'],
      effects: [{ kind: 'status', status: 'weak', amount: 2, turns: 1 }]
    }),
    cu4a: MV(1, { requiresAny: ['cu3a', 'cu3b', 'cu3c', 'cu3d'] }),
    cu4b: HP(3, { requiresAny: ['cu3a', 'cu3b', 'cu3c', 'cu3d'] }),
    cu4c: SMAX(1, { requiresAny: ['cu3a', 'cu3b', 'cu3c', 'cu3d'] }),
    cu5c: U({
      name: 'Careful Edge', icon: '🤝', desc: 'allies in the way are not hurt', requires: ['cu4a', 'cu4b', 'cu4c'],
      set: { hit: { targets: 'enemies' } }
    }),
    cu5d: U({
      name: 'Relief', icon: '🔃', desc: 'hitting an ally gives them Shielded 2 and swaps places with them', requires: ['cu4b', 'cu4c'],
      effects: [
        { kind: 'status', targets: 'allies', status: 'shielded', amount: 2 },
        { kind: 'swap', targets: 'allies' },
      ]
    }),
    cu6a: HP(4, { requiresAny: ['cu5c', 'cu5d'] }),
    cu6b: SGEN(1, { requiresAny: ['cu5c', 'cu5d'] }),
    cu6c: MV(1, { requiresAny: ['cu5c', 'cu5d'] }),
    cu6d: DMG(2, { requiresAny: ['cu5c', 'cu5d'] }),
  },

  // =========================== MEND (Viridi) ================================
  mendingTouch: {
    // ----- Buffer path -----
    bf0: MV(1),
    bf2a: HEAL(1, { requiresAny: ['bf0'] }),
    bf2b: SMAX(1, { requiresAny: ['bf0'] }),
    bf2c: MV(1, { requiresAny: ['bf0'] }),
    bf2d: HP(2, { requiresAny: ['bf0'] }),
    bf3a: U({
      name: 'Invigorate', icon: '🦾', desc: 'the target is Strong 2 for a turn', requires: ['bf2a', 'bf2b'],
      effects: [{ kind: 'status', status: 'strong', amount: 2, turns: 1 }]
    }),
    bf3b: U({
      name: 'Synergy', icon: '🔀', desc: 'tiles the target hits give later casts 3 bonus damage instead of 1', requires: ['bf2a', 'bf2b'],
      effects: [{ kind: 'status', status: 'synergy', amount: 2, turns: 1 }]
    }),
    bf3c: U({
      name: 'Desperation', icon: '🔶', desc: 'below 50% hp: generates two extra stacks', requires: ['bf2c', 'bf2d'],
      triggers: [{ when: 'activationStart', if: { hpFrac: { max: 0.5 } }, kind: 'gain', resource: 'stacks', amount: 2 }]
    }),
    bf3d: U({
      name: 'Flourish', icon: '🌿🌿', desc: 'regeneration ticks twice per turn', requires: ['bf2c', 'bf2d'],
      triggers: [{ when: 'battleStart', kind: 'status', status: 'doubleRegen' }]
    }),
    bf4a: HP(3, { requiresAny: ['bf3a', 'bf3b', 'bf3c', 'bf3d'] }),
    bf4b: SMAX(1, { requiresAny: ['bf3a', 'bf3b', 'bf3c', 'bf3d'] }),
    bf4c: MV(1, { requiresAny: ['bf3a', 'bf3b', 'bf3c', 'bf3d'] }),
    bf6a: HP(4, { requiresAny: ['bf4a', 'bf4b', 'bf4c'] }),
    bf6b: SGEN(1, { requiresAny: ['bf4a', 'bf4b', 'bf4c'] }),
    bf6c: MV(1, { requiresAny: ['bf4a', 'bf4b', 'bf4c'] }),
    bf6d: HEAL(2, { requiresAny: ['bf4a', 'bf4b', 'bf4c'] }),

    // ----- Healer path -----
    hl0: HP(2),
    hl1b: U({
      name: 'Company', icon: '🌿', desc: 'Regeneration 1 per friendly unit next to the target', requires: ['hl0'],
      effects: [{ kind: 'status', status: 'regen', amount: { per: 'targetAdjacentAllies' } }]
    }),
    hl2a: SGEN(1, { requiresAny: ['hl1b'] }),
    hl2b: SMAX(1, { requiresAny: ['hl1b'] }),
    hl2c: HEAL(1, { requiresAny: ['hl1b'] }),
    hl2d: MV(1, { requiresAny: ['hl1b'] }),
    hl3b: U({
      name: 'Resonance', icon: '🎵', desc: 'the target heals 1 for each tile its cast hits that another cast already hit', requires: ['hl2a', 'hl2b'],
      effects: [{ kind: 'status', status: 'resonance', amount: 1, turns: 1 }]
    }),
    hl3c: U({
      name: 'Lasting Mend', icon: '🌿', desc: 'Mend also applies Regeneration equal to its healing minus 1', requires: ['hl2c'],
      effects: [{ kind: 'status', status: 'regen', amount: [{ per: 'amount:heal' }, { n: -1 }] }]
    }),
    hl3d: U({ name: 'Reach', icon: '📏', desc: 'can mend one tile further', requires: ['hl2c', 'hl2d'], tune: { cast: { castZone: ringOffsets(2, 2) } } }),
    hl4a: SMAX(1, { requiresAny: ['hl3b', 'hl3c', 'hl3d'] }),
    hl4b: HP(3, { requiresAny: ['hl3b', 'hl3c', 'hl3d'] }),
    hl4c: MV(1, { requiresAny: ['hl3b', 'hl3c', 'hl3d'] }),
    hl5d: U({
      name: 'Garden Wall', icon: '🛡', desc: 'Shielded by the number of regenerating units on the field', requires: ['hl4b', 'hl4c'],
      effects: [self('shielded', { amount: { per: 'unitsWith:regen' } })]
    }),
    hl5e: U({
      name: 'Bloom', icon: '🌸', desc: 'also mends everyone around the target', requires: ['hl4a', 'hl4b', 'hl4c'],
      set: { heal: { zone: ringOffsets(0, 1) } }
    }),
    hl6a: HP(4, { requiresAny: ['hl5d', 'hl5e'] }),
    hl6b: SGEN(1, { requiresAny: ['hl5d', 'hl5e'] }),
    hl6c: MV(1, { requiresAny: ['hl5d', 'hl5e'] }),
    hl6d: HEAL(2, { requiresAny: ['hl5d', 'hl5e'] }),
  },

  // =========================== BOW BONE (Feren) =============================
  bowBone: {
    // ----- Hunter path -----
    hu0: HP(1),
    hu1a: U({
      name: 'Web', icon: '🕸️', desc: 'leaves a web on the tile: whoever stands in it is rooted while it lasts, and takes 2 when it snaps', requires: ['hu0'],
      effects: [{ id: 'web', kind: 'tag', tag: 'web', life: 1 }]
    }),
    hu1b: U({
      name: 'Rot', icon: '🥀', desc: 'applies Wither 1 for 2 turns', requires: ['hu0'],
      effects: [{ kind: 'status', status: 'wither', amount: 1, turns: 2 }]
    }),
    hu2a: DMG(1, { requiresAny: ['hu1a', 'hu1b'] }),
    hu2b: SMAX(1, { requiresAny: ['hu1a', 'hu1b'] }),
    hu2c: MV(1, { requiresAny: ['hu1a', 'hu1b'] }),
    hu2d: HP(2, { requiresAny: ['hu1a', 'hu1b'] }),
    hu3b: U({ name: 'Thicker Web', icon: '🕸️', desc: 'the web lasts a turn longer', requires: ['hu1a', 'hu2a', 'hu2b'], tune: { web: { life: 1 } } }),
    hu3c: U({
      name: 'Snare', icon: '🌱', desc: 'consume up to 2 stacks: the target is rooted for that many turns', requires: ['hu2c'],
      effects: [{ ...CONSUME, max: 2 }, { kind: 'status', status: 'rooted', turns: { per: 'consumed' } }]
    }),
    hu3d: U({ name: 'Splinter', icon: '⬡', desc: 'hits an additional tile', requires: ['hu2c', 'hu2d'], tune: { hit: { zone: [[1, 0]] } } }),
    hu4a: HP(3, { requiresAny: ['hu3b', 'hu3c', 'hu3d'] }),
    hu4b: SMAX(1, { requiresAny: ['hu3b', 'hu3c', 'hu3d'] }),
    hu4c: U({ name: 'Range +1', icon: '📏', desc: '+1 range', requiresAny: ['hu3b', 'hu3c', 'hu3d'], tune: { cast: { castZone: ringOffsets(3, 3) } } }),
    hu5a: U({ name: 'Thickest Web', icon: '🕸️', desc: 'the web lasts another turn', requires: ['hu3b', 'hu4a'], tune: { web: { life: 1 } } }),
    hu5b: U({
      name: 'Weak Point', icon: '🔀', desc: 'later casts on a tile Bow Bone hit get +2 bonus damage instead of +1', requires: ['hu4a', 'hu4b'],
      tune: { hit: { overlapGrant: 1 } }
    }),
    hu5e: U({ name: 'Shatter', icon: '⬡', desc: 'hits another additional tile', requires: ['hu4b', 'hu4c'], tune: { hit: { zone: [[0, -1]] } } }),
    hu6a: HP(4, { requiresAny: ['hu5a', 'hu5b', 'hu5e'] }),
    hu6b: SGEN(1, { requiresAny: ['hu5a', 'hu5b', 'hu5e'] }),
    hu6c: MV(1, { requiresAny: ['hu5a', 'hu5b', 'hu5e'] }),
    hu6d: DMG(2, { requiresAny: ['hu5a', 'hu5b', 'hu5e'] }),

    // ----- Marksman path -----
    mk0: DMG(1),
    mk1b: U({ name: 'Far Sight', icon: '📏', desc: '+1 range', requires: ['mk0'], tune: { cast: { castZone: ringOffsets(3, 3) } } }),
    mk2a: SGEN(1, { requiresAny: ['mk1b'] }),
    mk2b: DMG(1, { requiresAny: ['mk1b'] }),
    mk2c: HP(2, { requiresAny: ['mk1b'] }),
    mk2d: U({ name: 'Farther Sight', icon: '📏', desc: '+1 range', requiresAny: ['mk1b'], tune: { cast: { castZone: ringOffsets(4, 4) } } }),
    mk3a: U({
      name: 'Trophy', icon: '🌿', desc: 'a killing blow gives Regeneration 1', requires: ['mk2a', 'mk2b'],
      triggers: [{ when: 'kill', kind: 'status', status: 'regen', amount: 1 }]
    }),
    mk3b: U({
      name: 'Bloodlust', icon: '🤬', desc: 'a killing blow gives Enraged', requires: ['mk2a', 'mk2b'],
      triggers: [{ when: 'kill', kind: 'status', status: 'enraged', amount: 1, turns: 1 }]
    }),
    mk3c: U({
      name: 'Barbed', icon: '🎯', desc: 'the target is Vulnerable 1 for a turn', requires: ['mk2c', 'mk2d'],
      effects: [{ kind: 'status', status: 'vulnerable', amount: 1, turns: 1 }]
    }),
    mk3d: U({
      name: 'Marked', icon: '🔻', desc: 'marks the target for 2 turns: whoever kills it is Strong 1 next turn', requires: ['mk2c', 'mk2d'],
      effects: [{ kind: 'status', status: 'marked', turns: 2 }]
    }),
    mk4a: SMAX(1, { requiresAny: ['mk3a', 'mk3b', 'mk3c', 'mk3d'] }),
    mk4b: U({ name: 'Farthest Sight', icon: '📏', desc: '+1 range', requiresAny: ['mk3a', 'mk3b', 'mk3c', 'mk3d'], tune: { cast: { castZone: ringOffsets(5, 5) } } }),
    mk4c: MV(1, { requiresAny: ['mk3a', 'mk3b', 'mk3c', 'mk3d'] }),
    mk5b: U({
      name: 'Escalation', icon: '📈', desc: 'each use this battle: +2 damage and +1 hp cost', requires: ['mk4a'],
      tune: { hit: { amount: { per: 'castsThisBattle', mul: 2 } }, cast: { cost: { hp: { per: 'castsThisBattle' } } } }
    }),
    mk5c: U({
      name: 'Dead Eye', icon: '💫', desc: 'a target at maximum range is stunned', requires: ['mk4a', 'mk4b', 'mk4c'],
      effects: [{ kind: 'status', status: 'stun', turns: 1, if: { atMaxRange: true } }]
    }),
    mk5d: U({
      name: 'Open Wound', icon: '🩸', desc: 'a target at 80% hp or more bleeds 2', requires: ['mk4b', 'mk4c'],
      effects: [{ kind: 'status', status: 'bleed', amount: 2, if: { targetHpFrac: { min: 0.8 } } }]
    }),
    mk5e: U({
      name: 'Mercy Shot', icon: '🌿', desc: 'a target at 50% hp or less gets Regeneration 2', requires: ['mk4c'],
      effects: [{ kind: 'status', status: 'regen', amount: 2, if: { targetHpFrac: { max: 0.5 } } }]
    }),
    mk6a: HP(3, { requiresAny: ['mk5b', 'mk5c', 'mk5d', 'mk5e'] }),
    mk6b: SGEN(1, { requiresAny: ['mk5b', 'mk5c', 'mk5d', 'mk5e'] }),
    mk6c: MV(1, { requiresAny: ['mk5b', 'mk5c', 'mk5d', 'mk5e'] }),
    mk6d: DMG(2, { requiresAny: ['mk5b', 'mk5c', 'mk5d', 'mk5e'] }),
  },

  // ----- the older kits (the Warden, the Archer, ...) - small linear trees ---
  strike: {
    edge: DMG(1, { name: 'Edge' }),
    weight: DMG(1, { name: 'Weight' }),
    reach: U({ name: 'Reach', icon: '📏', desc: 'can strike from 2 tiles away', requires: ['edge'], tune: { cast: { castZone: ringOffsets(2, 2) } } }),
    sweep: U({ name: 'Sweep', icon: '🌀', desc: 'also hits the tiles around the target', requires: ['weight'], tune: { hit: { zone: ringOffsets(1, 1) } } }),
    execute: DMG(2, { name: 'Execute', icon: '💀', requires: ['reach', 'sweep'] }),
  },
  shove: {
    jolt: DMG(1, { name: 'Jolt' }),
    momentum: U({ name: 'Momentum', icon: '🏃', desc: 'pushes 1 tile further', tune: { push: { dist: 1 } } }),
    longarm: U({ name: 'Long Arm', icon: '📏', desc: 'can shove from 2 tiles away', requires: ['jolt'], tune: { cast: { castZone: ringOffsets(2, 2) } } }),
    impact: DMG(1, { name: 'Impact', requires: ['momentum'] }),
    avalanche: DMG(2, { name: 'Avalanche', icon: '🏔️', requires: ['longarm', 'impact'] }),
  },
  lance: {
    hone: DMG(1, { name: 'Hone' }),
    extend: U({ name: 'Extend', icon: '📏', desc: 'the line reaches a 4th tile', tune: { hit: { zone: [[3, 0]] } } }),
    pike: U({ name: 'Pike', icon: '🔱', desc: 'can thrust from 2 tiles away', requires: ['hone'], tune: { cast: { castZone: ringOffsets(2, 2) } } }),
    drive: DMG(1, { name: 'Drive', requires: ['extend'] }),
    skewer: DMG(2, { name: 'Skewer', icon: '🍢', requires: ['pike', 'drive'] }),
  },
  burst: {
    kindle: DMG(1, { name: 'Kindle' }),
    lob: U({ name: 'Lob', icon: '🏹', desc: 'can be thrown 4 tiles', tune: { cast: { castZone: ringOffsets(4, 4) } } }),
    spread: U({ name: 'Spread', icon: '🌋', desc: 'the blast covers one more ring', requires: ['kindle'], tune: { hit: { zone: ringOffsets(2, 2) } } }),
    scorch: U({ name: 'Scorch', icon: '♨️', desc: 'fire also covers the ring around the centre', requires: ['lob'], tune: { tag: { zone: ringOffsets(1, 1) } } }),
    inferno: DMG(1, { name: 'Inferno', icon: '☄️', requires: ['spread', 'scorch'] }),
  },
  bolt: {
    charge: DMG(1, { name: 'Charge' }),
    arc: U({ name: 'Arc', icon: '🌩️', desc: 'range grows to 3 tiles', tune: { cast: { castZone: ringOffsets(3, 3) } } }),
    surge: DMG(1, { name: 'Surge', requires: ['charge'] }),
    farcast: U({ name: 'Farcast', icon: '🔭', desc: 'range grows to 4 tiles', requires: ['arc'], tune: { cast: { castZone: ringOffsets(4, 4) } } }),
    thunder: DMG(2, { name: 'Thunder', icon: '🌪️', requires: ['surge', 'farcast'] }),
  },
  guard: {
    patch: U({ name: 'Patch', icon: '🩹', desc: 'the shield also heals 1', effects: [{ id: 'heal', kind: 'heal', zone: [[0, 0]], amount: 1 }] }),
    brace: U({ name: 'Brace', icon: '📏', desc: 'can shield from 2 tiles away', tune: { cast: { castZone: ringOffsets(2, 2) } } }),
    surgeon: HEAL(1, { name: 'Surgeon', icon: '⚕️', requires: ['patch'] }),
    farward: U({ name: 'Far Ward', icon: '🔭', desc: 'can shield from 3 tiles away', requires: ['brace'], tune: { cast: { castZone: ringOffsets(3, 3) } } }),
    aegis: HEAL(2, { name: 'Aegis', icon: '🛡️', requires: ['surgeon', 'farward'] }),
  },
};
