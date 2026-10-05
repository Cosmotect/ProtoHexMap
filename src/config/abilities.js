// ===================================ABILITIES===================================
//  An ability is DATA: WHERE it can be pointed, WHAT it costs, and a LIST OF
//  EFFECTS. There is no per-ability code anywhere - one executor (resolveCast
//  in local/battle/engine.js) runs the effects, and the enemy AI judges a
//  new ability by playing that same executor out on a copy of the board. So
//  anything expressible here works in the game AND is understood by the AI.
//
//  The vocabulary of effects, quantities and conditions is spelled out once,
//  in src/local/battle/rules.js. In short:
//
//    name / icon / color / desc   what the player sees
//    tags       what kind of ability it is: 'melee' / 'ranged'. A status may
//               forbid a tag (Grounded Aim forbids 'ranged').
//
//  ----- 1. WHERE IT CAN BE POINTED ------------------------------------
//    castZone   offsets from the caster's tile it may be aimed at. Helpers
//               (local/battle/bhex.js): ringOffsets(minD, maxD) is a blob,
//               lineOffsets(minD, maxD) the six straight spokes. A plain list
//               is just as legal.
//    castAny    true = aim at any tile on the board
//    rotatable  true = every zone below turns to face the aim point (write
//               them facing EAST)
//    aims       how many aim points the cast takes (default 1). With more, a
//               damage effect's hits are dealt round-robin over the aims and
//               every other effect lands at each of them.
//
//  ----- 2. WHAT IT COSTS ------------------------------------------------
//    cost       { hp, supplies, move } - each a QUANTITY (a number or terms
//               over facts about the caster), each optional, any of them may
//               be negative to GRANT the resource. hp can never kill: the
//               caster needs strictly more than the cost.
//
//  ----- 3. WHAT IT DOES: effects ----------------------------------------
//    effects    [{ id, kind, zone, anchor, targets, if, ... }] - see rules.js.
//               Give the ones upgrades will touch an `id`: by convention
//               'hit' for the main damage, 'heal', 'status', 'push', 'tag', 'dash'.
//               Order among effects of the same phase is the list order; the
//               phases themselves are fixed by kind (consume -> hits/heals/
//               statuses/gains -> pushes/throws/swaps -> heights -> tags ->
//               dash -> effects anchored on 'landing'), so an upgrade adding
//               an effect never has to think about where it goes.
//    Every zone is anchored on the AIM point unless the effect says
//    anchor: 'caster' or 'landing'. An effect written WITHOUT a zone follows
//    the main hit's (so a swipe that grows wider carries its status along).
//
// ----------------------------------DEFINITION-----------------------------------
import { ringOffsets, lineOffsets } from '../local/battle/bhex.js';

const A = (o) => {
  const out = Object.assign({
    name: 'Ability', icon: '💥', color: '#5fc7e0', desc: '', tags: [],
    castZone: [], castAny: false, rotatable: false, aims: 1,
    cost: {}, effects: [],
  }, o);
  out.cost = { hp: 0, supplies: 0, move: 0, ...out.cost };
  return out;
};
// The three most common effects, so a plain ability reads in one line. They
// produce ordinary effect objects - nothing downstream knows they exist.
const hit = (amount, zone = [[0, 0]], extra = {}) => ({ id: 'hit', kind: 'damage', zone, amount, ...extra });
const heal = (amount, zone = [[0, 0]], extra = {}) => ({ id: 'heal', kind: 'heal', zone, amount, ...extra });
const status = (id, extra = {}) => ({ id: 'status', kind: 'status', status: id, ...extra });
const push = (extra = {}) => ({ id: 'push', kind: 'push', dir: 0, dist: 1, ...extra });
const tag = (id, zone = [[0, 0]], extra = {}) => ({ id: 'tag', kind: 'tag', zone, tag: id, ...extra });
const dash = (extra = {}) => ({ id: 'dash', kind: 'dash', ...extra });
// -------------------------------------TABLE-------------------------------------
export const ABILITIES = {
  // ----- cast by tile tags (COMBAT_TAGS hooks, config/entities.js) ---------
  nerveAgentCloud: A({ name: 'Nerve Agent', icon: '🎆', color: '#ff9950', castZone: [[0, 0]],
    effects: [status('bleed', { amount: 2 })] }),
  witherCloud: A({ name: 'Wither Cloud', icon: '🥀', color: '#6f7d4a', castZone: [[0, 0]],
    effects: [status('wither', { amount: 1, turns: 2 })] }),
  webSnap: A({ name: 'Web Snap', icon: '🕸️', color: '#d9cfe8', castZone: [[0, 0]],
    effects: [hit(2)] }),

  // ----- enemy abilities ---------------------------------------------------
  softeningBite: A({ name: 'Softening Bite', icon: '⚔️', color: '#e0b25f', tags: ['melee'], castZone: ringOffsets(1, 1),
    effects: [status('vulnerable', { amount: 1, turns: 2 })] }),
  rageBite: A({ name: 'Enraging Bite', icon: '🤬', color: '#E84A27', tags: ['melee'], castZone: ringOffsets(1, 1),
    effects: [status('enraged', { amount: 1, turns: 1 })] }),
  headbutt: A({ name: 'Headbutt', icon: '🐏', color: '#e0b25f', tags: ['melee'], castZone: ringOffsets(1, 1), rotatable: true,
    effects: [push()] }),
  weakeningBite: A({ name: 'Weakening Bite', icon: '🩼', color: '#38D1AC', tags: ['melee'], castZone: ringOffsets(1, 1),
    effects: [status('weak', { amount: 1, turns: 2 })] }),
  lobbedShrapnelBurst: A({ name: 'Lobbed Shrapnel Burst', icon: '💥', color: '#ff9950', tags: ['ranged'], castZone: ringOffsets(1, 3),
    effects: [hit(3, ringOffsets(0, 1))] }),
  lobbedNerveAgentBurst: A({ name: 'Lobbed Nerve Agent Burst', icon: '🎆', color: '#ff9950', tags: ['ranged'], castZone: ringOffsets(1, 4),
    effects: [hit(1, ringOffsets(0, 1)), tag('nerveAgentCloud', ringOffsets(0, 1))] }),
  volley: A({ name: 'Volley', icon: '🎯', color: '#a8e05f', desc: 'Ranged projectile', tags: ['ranged'], castZone: ringOffsets(2, 4),
    effects: [hit(2)] }),
  swipe: A({ name: 'Swipe', icon: '💫', color: '#5fc7e0', tags: ['melee'], castZone: ringOffsets(1, 1), rotatable: true,
    effects: [hit(5, [[0, 0], [-1, -1], [0, 1]])] }),

  // ----- the party's abilities (each drives an upgrade tree, config/upgrades.js) -
  clawSwipe: A({ name: 'Claw Swipe', icon: '🔪', color: '#5fc7e0', desc: 'Clawed slashes that tear through.', tags: ['melee'],
    castZone: ringOffsets(1, 1), rotatable: true,
    effects: [hit(3)] }),
  ram: A({ name: 'Ram', icon: '🐏💨', color: '#e0b25f', desc: 'Gorm closes the distance to his target, dealing 2 damage and shoving it a tile.', tags: ['melee'],
    castZone: lineOffsets(1, 2), rotatable: true,
    effects: [hit(2), push(), dash()] }),

  glaive: A({ name: 'Glaive Strike', icon: '⚔️', color: '#e0b25f', desc: 'Downward jab with a sleek glaive.', tags: ['melee'],
    castZone: ringOffsets(1, 1), rotatable: true,
    effects: [hit(3)] }),
  bowBone: A({ name: 'Bow Bone', icon: '🎯', color: '#a8e05f', desc: 'A bone shard fired at a tile within two.', tags: ['ranged'],
    castZone: ringOffsets(1, 2),
    effects: [hit(2)] }),

  spikeShot: A({ name: 'Spike Shot', icon: '🖊', color: '#e0b25f', desc: 'A sparse cloud of quills: two hits of 1.', tags: ['ranged'],
    castZone: ringOffsets(1, 1),
    effects: [hit(1, [[0, 0]], { times: 2 })] }),
  mendingTouch: A({ name: 'Mend', icon: '🏥', color: '#a8e05f', desc: 'Heals a unit standing on or next to the caster for 2.',
    castZone: ringOffsets(0, 1), cost: { supplies: 1 },
    effects: [heal(2)] }),

  strike: A({ name: 'Strike', icon: '⚔️', color: '#e0b25f', desc: 'A close blow against one adjacent enemy.', tags: ['melee'], castZone: ringOffsets(1, 1),
    effects: [hit(3)] }),
  shove: A({ name: 'Shove', icon: '🌀', color: '#ffd75f', desc: 'A light hit that pushes the target away - off a ledge, into a wall, into its friends.', tags: ['melee'],
    castZone: ringOffsets(1, 1), rotatable: true,
    effects: [hit(1), push()] }),
  lance: A({ name: 'Lance', icon: '⚡', color: '#5fc7e0', desc: 'A piercing thrust that strikes three tiles in a row, aimed by direction.', tags: ['melee'],
    castZone: ringOffsets(1, 1), rotatable: true,
    effects: [hit(3, [[0, 0], [1, 0], [2, 0]])] }),
  burst: A({ name: 'Ember Burst', icon: '🔥', color: '#ff9950', desc: 'A thrown blast: damages the target and everything around it, and leaves fire burning where it lands.', tags: ['ranged'],
    castZone: ringOffsets(1, 3), cost: { move: 1 },
    effects: [hit(2, ringOffsets(0, 1)), tag('fire')] }),
  bolt: A({ name: 'Bolt', icon: '☄️', color: '#c66dff', desc: 'A heavy arcane hit on one nearby target.', tags: ['ranged'],
    castZone: ringOffsets(1, 2), cost: { hp: 1 },
    effects: [hit(4)] }),
  guard: A({ name: 'Guard', icon: '🛡️', color: '#5fc7e0', desc: 'Shields a nearby ally: their next hits are softened by 2.',
    castZone: ringOffsets(0, 1), cost: { hp: -1 },
    effects: [status('shielded', { amount: 2 })] }),
  plasmaBolt: A({ name: 'Plasma Bolt', icon: '☄️', color: '#e0b25f', desc: 'A bolt of plasma, eerily calm, searing.', tags: ['ranged'], castZone: ringOffsets(1, 3),
    effects: [hit(2)] }),

  // ----- the Hack's abilities ----------------------------------------------
  hackMelee: A({ name: 'Hack Melee', icon: '⚔️', color: '#e0b25f', desc: 'A close, directional blow.', tags: ['melee'], castZone: ringOffsets(1, 1),
    effects: [hit(3)] }),
  hackflurry: A({ name: 'Hack Flurry', icon: '🇧🇬', castZone: ringOffsets(0, 3),
    effects: [hit(2, [[1, 0], [0, -1], [-1, 1]])] }),
  hackExtendedflurry: A({ name: 'Hack Extended Flurry', icon: '🇦🇲', castZone: [[0, 0]], rotatable: true,
    effects: [hit(2, [[1, 0], [2, 0], [0, -1], [0, -2], [-1, 1], [-2, 2]])] }),
  hackKite: A({ name: 'Hack Kite', icon: '🇩🇰', castZone: ringOffsets(0, 3),
    effects: [hit(4, [[-2, 2], [2, -2], [1, 1], [-1, -1]])] }),
  hackSplayHex: A({ name: 'Hack SplayHex', icon: '🇹🇩', castZone: ringOffsets(0, 3),
    effects: [hit(5, [[-2, 0], [2, 0], [-2, 2], [2, -2], [0, 2], [0, -2]])] }),
};

export const abilityById = (id) => ABILITIES[id] ?? null;

// Every row carries its own id, and its effects are checked once here (a
// missing default filled in, a mistake reported on the console) so the engine
// and the AI read a normalised list - for the party's resolved abilities the
// same check runs again after the upgrades are folded in (src/upgrades.js).
import { checkEffect, resolveZones } from '../local/battle/rules.js';
import { STATUSES } from './statuses.js';
import { COMBAT_TAGS } from './entities.js';
for (const [id, a] of Object.entries(ABILITIES)) {
  a.id = id;
  a.effects = resolveZones(a.effects.map((e, i) => checkEffect(e, `${id}.effects[${i}]`, { statuses: STATUSES, tags: COMBAT_TAGS })).filter(Boolean), id);
}
