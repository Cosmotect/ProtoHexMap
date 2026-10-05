// ===================================STATUSES===================================
//  A status is a temporary condition a unit carries. Every row is read as
//  "<Name> X for Y turns": X is its AMOUNT, Y its CLOCK. The row says what one
//  point of X does (its VERBS, coefficients per X), how a second application
//  combines with the first (STACKING), and how X wears down (DECAY). New verbs
//  are code (local/battle/engine.js reads them by name); new rows are config.
//
//  A unit carries a list of INSTANCES: { id, amount, turns, source, seen }.
//  `source` is the uid of whoever put it on - what Lifelink, Taunt, Fear and
//  Charm point back to. A verb's value on a unit is the sum over its instances
//  of amount * coefficient (speed, say), so Haste 2 and Haste 1 together move
//  the unit 3 further.
//
//  ----- the fields -----
//    amount     default X, when whoever applies it does not say
//    turns      default Y. 0 = no clock: the status stays until something else
//               ends it (decay reaching 0, or nothing at all - permanent)
//    stacking   'refresh'  a second application resets X and Y to the new values
//               'add'      a second application ADDS its X and Y to the instance
//               'separate' every application is its own instance, each with its
//                          own clock (Wither 2 for 2 beside Wither 1 for 3)
//    decay      X is reduced by this at the start of each of the carrier's
//               activations (after the tick); the instance ends when X reaches 0
//    decayOnHit X is reduced by this every time the carrier takes damage
//
//  ----- VERBS (per point of X) -----
//    tickHP         hp gained (+) or lost (-) at the start of the carrier's activation
//    speed          movement points, signed
//    damageDealt    flat damage added to every hit the carrier lands (signed)
//    damageTaken    flat damage added to every hit the carrier takes (signed;
//                   Shielded and Impervious are negative). A hit never drops below 0.
//    maxStacks      added to the carrier's maximum stacks
//    stackGen       added to the stacks the carrier generates each activation
//    maxHp          added to the carrier's maximum hp while it lasts
//    lifesteal      extra damage on every hit the carrier lands, and it heals the same
//    overlapGrant   extra overlap bonus LATER casts of the volley get on tiles the carrier hits
//    healOnOverlap  hp the carrier heals per tile its cast hits that an earlier cast already hit
//    extraTicks     how many extra times the carrier's healing ticks run each activation
//    flight         +1 the carrier flies, -1 it is grounded (whatever its row says)
//  ----- SWITCHES (any X) -----
//    impactTaken    MULTIPLIER on crash / fall / crush damage the carrier takes (1 = as is)
//    impactDealt    MULTIPLIER on crash damage dealt to whatever the carrier is shoved into
//    agency         rights the carrier loses: 'stunned' (skips its activation),
//                   'disarmed' (no abilities), 'rooted' (no walking),
//                   'confused' (walks and casts at random - the engine plays it)
//    forbids        ability TAGS the carrier may not cast ('ranged', 'melee')
//    immune         status ids that cannot be put on the carrier while this lasts
//    ignoresImpact  'crash' / 'fall' / 'crush' kinds the carrier shrugs off
//    ai             how the enemy AI's mind changes while carrying it:
//                   { mustTarget: 'source' }      it only casts at whoever applied it (Taunt)
//                   { avoidAdjacentTo: 'source' } it will not end next to them (Fear)
//                   { friend: 'source' }          it counts them as an ally (Charm)
//    triggers       effects that fire for the carrier at a moment (see
//                   local/battle/rules.js): Lifelink heals its source when the
//                   carrier is hit; Marked rewards whoever kills the carrier.
//  ----- DISPLAY and AI -----
//    name / desc    what the badge and the party view show. {x} is the amount,
//                   {y} the turns left, {source} who put it on (Lifelink). A
//                   locale may override with status.<id>.name / .desc.
//    aiValue        how GOOD carrying it is, in the AI's units (a point of
//                   damage is 10, a kill 45). Positive = a boon, negative = a bane.
// ----------------------------------DEFINITION-----------------------------------
const S = (o) => Object.assign({
  name: 'Status', desc: '', icon: '⭐', color: '#9aa7bd',
  amount: 1, turns: 0, stacking: 'refresh', decay: 0, decayOnHit: 0,
  tickHP: 0, speed: 0, damageDealt: 0, damageTaken: 0, maxStacks: 0, stackGen: 0, maxHp: 0,
  lifesteal: 0, overlapGrant: 0, healOnOverlap: 0, extraTicks: 0, flight: 0,
  impactTaken: 1, impactDealt: 1,
  agency: [], forbids: [], immune: [], ignoresImpact: [], ai: null, triggers: [],
  aiValue: 0,
}, o);
// -------------------------------------TABLE-------------------------------------
export const STATUSES = {
  // ----- ADDITIVE statuses: a second application adds its X and Y -----------
  // HEALTH
  impervious: S({ name: 'Impervious', icon: '🪨', color: '#5fc7e0', desc: 'Takes {x} less damage from every hit for {y} turns.',
    damageTaken: -1, turns: 1, stacking: 'add', aiValue: 12 }),
  vulnerable: S({ name: 'Vulnerable', icon: '🎯', color: '#e2474b', desc: 'Takes {x} more damage from every hit for {y} turns.',
    damageTaken: 1, turns: 1, stacking: 'add', aiValue: -14 }),
  weak: S({ name: 'Weak', icon: '🩼', color: '#b58fd1', desc: 'Deals {x} less damage with every hit for {y} turns.',
    damageDealt: -1, turns: 1, stacking: 'add', aiValue: -12 }),
  strong: S({ name: 'Strong', icon: '🦾', color: '#ffd75f', desc: 'Deals {x} more damage with every hit for {y} turns.',
    damageDealt: 1, turns: 1, stacking: 'add', aiValue: 12 }),
  // MOVEMENT
  haste: S({ name: 'Haste', icon: '💨', color: '#a8e05f', desc: 'Moves {x} tiles further for {y} turns.',
    speed: 1, turns: 1, stacking: 'add', aiValue: 6 }),
  slug: S({ name: 'Slug', icon: '🐌', color: '#c9a8ff', desc: 'Moves {x} tiles less for {y} turns (never below the minimum speed).',
    speed: -1, turns: 1, stacking: 'add', aiValue: -8 }),
  flight: S({ name: 'Flight', icon: '🕊️', color: '#a8e05f', desc: 'Flies for {y} turns.',
    flight: 1, turns: 1, stacking: 'add', aiValue: 6 }),
  slither: S({ name: 'Slither', icon: '🐍', color: '#c9a8ff', desc: 'Grounded for {y} turns.',
    flight: -1, turns: 1, stacking: 'add', aiValue: -6 }),
  // STACKS
  enriched: S({ name: 'Enriched', icon: '🔶', color: '#ffd75f', desc: 'Holds {x} extra stacks for {y} turns.',
    maxStacks: 1, turns: 1, stacking: 'add', aiValue: 4 }),
  depleted: S({ name: 'Depleted', icon: '🔸', color: '#c9a8ff', desc: 'Holds {x} fewer stacks for {y} turns.',
    maxStacks: -1, turns: 1, stacking: 'add', aiValue: -4 }),
  amplified: S({ name: 'Amplified', icon: '📈', color: '#ffd75f', desc: 'Generates {x} extra stacks each turn for {y} turns.',
    stackGen: 1, turns: 1, stacking: 'add', aiValue: 4 }),
  dampened: S({ name: 'Dampened', icon: '📉', color: '#c9a8ff', desc: 'Generates {x} fewer stacks each turn for {y} turns.',
    stackGen: -1, turns: 1, stacking: 'add', aiValue: -4 }),

  // ----- SPECIAL statuses: X wears down instead of a clock ------------------
  regen: S({ name: 'Regeneration', icon: '🌿', color: '#a8e05f', desc: 'Heals {x} at the start of its turn, then the amount drops by 1.',
    tickHP: 1, decay: 1, stacking: 'add', aiValue: 14 }),
  bleed: S({ name: 'Bleed', icon: '🩸', color: '#e2474b', desc: 'Loses {x} hp at the start of its turn, then the amount drops by 1.',
    tickHP: -1, decay: 1, stacking: 'add', aiValue: -16 }),
  shielded: S({ name: 'Shielded', icon: '🛡', color: '#5fc7e0', desc: 'Every hit taken is reduced by {x}; the shield wears down by 1 each turn and each hit.',
    damageTaken: -1, decay: 1, decayOnHit: 1, stacking: 'add', aiValue: 14 }),
  confused: S({ name: 'Confused', icon: '❓', color: '#c9a8ff', desc: 'For {y} turns walks at random and casts a random ability at a random unit, friend or foe.',
    agency: ['confused'], turns: 1, stacking: 'add', aiValue: -14 }),
  stun: S({ name: 'Stunned', icon: '💫', color: '#c9a8ff', desc: 'Loses its next {y} activation(s): no move, no ability.',
    agency: ['stunned'], turns: 1, stacking: 'add', aiValue: -12 }),
  rooted: S({ name: 'Rooted', icon: '🌱', color: '#8fd14f', desc: 'Cannot walk for {y} turns. Abilities still work.',
    agency: ['rooted'], turns: 1, stacking: 'add', aiValue: -9 }),
  disarmed: S({ name: 'Disarmed', icon: '🚫', color: '#c9a8ff', desc: 'Can move, but cannot use any ability for {y} turns.',
    agency: ['disarmed'], turns: 1, stacking: 'add', aiValue: -10 }),
  noRanged: S({ name: 'Grounded Aim', icon: '🙈', color: '#c9a8ff', desc: 'Cannot use ranged abilities for {y} turns.',
    forbids: ['ranged'], turns: 1, stacking: 'add', aiValue: -7 }),

  // ----- STACKING statuses: every application is its own instance ----------
  wither: S({ name: 'Wither', icon: '🥀', color: '#6f7d4a', desc: 'Loses {x} hp at the start of each of its turns for {y} turns.',
    tickHP: -1, turns: 2, stacking: 'separate', aiValue: -18 }),
  lifelink: S({ name: 'Lifelink', icon: '🔗', color: '#ff8fa3', desc: 'Lifelinked to {source}: whenever damage is taken, the linked unit heals 1 hp. {y} turns left.',
    turns: 2, stacking: 'separate', aiValue: -8,
    triggers: [{ when: 'hit', kind: 'heal', targets: 'source', amount: 1 }] }),

  // ----- NAMED COMPOSITES ---------------------------------------------------
  enraged: S({ name: 'Enraged', icon: '🤬', color: '#e2474b', desc: 'Hits {x} harder and moves {x} further for {y} turns.',
    speed: 1, damageDealt: 1, turns: 1, stacking: 'add', aiValue: 16 }),
  lifesteal: S({ name: 'Lifesteal', icon: '🖤', color: '#ff8fa3', desc: 'Every hit deals {x} extra and heals the attacker by the same.',
    lifesteal: 1, turns: 1, stacking: 'add', aiValue: 10 }),

  // ----- the mind of the enemy (Taunt / Fear / Charm point back at `source`) -
  taunt: S({ name: 'Taunted', icon: '📣', color: '#ffd75f', desc: 'For {y} turns it only has eyes for whoever taunted it.',
    turns: 1, stacking: 'refresh', ai: { mustTarget: 'source' }, aiValue: -8 }),
  fear: S({ name: 'Feared', icon: '😨', color: '#c9a8ff', desc: 'For {y} turns it will not end its move next to whoever scared it.',
    turns: 1, stacking: 'refresh', ai: { avoidAdjacentTo: 'source' }, aiValue: -6 }),
  charm: S({ name: 'Charmed', icon: '💞', color: '#ff8fa3', desc: 'For {y} turns it counts whoever charmed it as a friend.',
    turns: 1, stacking: 'refresh', ai: { friend: 'source' }, aiValue: -10 }),
  marked: S({ name: 'Marked', icon: '🔻', color: '#e2474b', desc: 'For {y} turns: whoever lands the killing blow on it is Strong 1 next turn.',
    turns: 2, stacking: 'refresh', aiValue: -6,
    triggers: [{ when: 'death', kind: 'status', targets: 'killer', status: 'strong', amount: 1, turns: 1 }] }),

  // ----- PASSIVES - rows with no clock that triggers put on at battle start -
  padded: S({ name: 'Padded', icon: '🥊', color: '#b0714a', desc: 'Shrugs off crashes, falls and being crushed.',
    ignoresImpact: ['crash', 'fall', 'crush'], aiValue: 12 }),
  heavyCollision: S({ name: 'Battering', icon: '💥', color: '#b0714a', desc: 'Collisions hurt it, and whatever it collides into, twice as much.',
    impactTaken: 2, impactDealt: 2, aiValue: 0 }),
  witherImmune: S({ name: 'Wither-proof', icon: '🌼', color: '#a8e05f', desc: 'Wither cannot take hold.',
    immune: ['wither'], aiValue: 6 }),
  synergy: S({ name: 'Synergy', icon: '🔀', color: '#ffd75f', desc: 'Tiles its abilities hit give later casts {x} more bonus damage.',
    overlapGrant: 1, turns: 1, stacking: 'add', aiValue: 6 }),
  resonance: S({ name: 'Resonance', icon: '🎵', color: '#a8e05f', desc: 'Heals {x} for every tile its cast hits that another cast already hit.',
    healOnOverlap: 1, turns: 1, stacking: 'add', aiValue: 6 }),
  fortified: S({ name: 'Fortified', icon: '❤️‍🔥', color: '#a8e05f', desc: '{x} extra maximum hp for {y} turns.',
    maxHp: 1, turns: 1, stacking: 'add', aiValue: 8 }),
  doubleRegen: S({ name: 'Flourishing', icon: '🌿🌿', color: '#a8e05f', desc: 'Its healing ticks run twice each turn.',
    extraTicks: 1, aiValue: 6 }),
};
export const statusById = (id) => STATUSES[id] ?? null;

// A row's triggers are checked once here (defaults filled in, a mistake said
// on the console) so the engine runs them exactly as it runs a node's.
import { checkTrigger } from '../local/battle/rules.js';
for (const [id, row] of Object.entries(STATUSES)) {
  row.triggers = (row.triggers ?? []).map((e, i) => checkTrigger(e, `statuses.${id}.triggers[${i}]`, { statuses: STATUSES })).filter(Boolean);
}

// True when nothing can end this row by itself: no clock and no decay. The
// unit card hides such rows from its status slots; the party view lists them
// as passives.
export function isPermanent(def, inst) {
  if (!def) return false;
  const turns = inst && inst.turns !== undefined ? inst.turns : def.turns;
  return !(turns > 0) && !(def.decay > 0) && !(def.decayOnHit > 0);
}

// The numeric verbs, for the Settings window and the audit.
export const STATUS_VERBS = ['tickHP', 'speed', 'damageDealt', 'damageTaken', 'maxStacks', 'stackGen', 'maxHp', 'lifesteal', 'overlapGrant', 'healOnOverlap', 'extraTicks', 'flight'];
