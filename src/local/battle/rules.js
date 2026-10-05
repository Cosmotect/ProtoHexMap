// =====================================================================
//  RULES VOCABULARY - quantities, conditions, effects and triggers.
//
//  Everything an ability, an upgrade node, a status row, a bestiary row or a
//  tile tag can SAY is written in the small language below, and this file is
//  its one reader: it evaluates quantities and conditions against a cast's
//  context, and it checks that an effect or a trigger is well formed before
//  the engine ever sees it. Nothing in here knows a particular ability or
//  status - only the SHAPE of what can be written.
//
//  ----- 1. QUANTITIES -------------------------------------------------
//  Anywhere a number is wanted (damage, heal, a status's X or Y, a push
//  distance, a cost, stacks gained...) a QUANTITY may be written instead:
//
//    2                                 a plain number
//    [{ n: 2 }, { per: 'tilesTravelled', every: 2 }]
//                                      a list of TERMS, summed
//    { per: 'consumed', mul: 1 }       one term on its own
//
//  A term is one of:
//    { n: 2 }                          the constant 2
//    { per: 'fact', every: 1, mul: 1, min: 0, max: 99 }
//                                      floor(fact / every) * mul, clamped to
//                                      [min, max] when given. `every` 2 is
//                                      "+1 per two tiles"; `mul` -1 is "-1 per".
//  Either kind may carry `if: <condition>` - the term counts only when it holds.
//  An upgrade that "adds 1" to a quantity simply appends { n: 1 } to its
//  terms; one that "adds 1 per 2 stacks" appends { per: 'consumed', every: 2 }.
//  That is why folding upgrades over an ability never depends on their order.
//
//  ----- 2. CONDITIONS -------------------------------------------------
//  An `if` is an object of fact -> test, all of which must hold:
//    { didNotMove: true }              fact is non-zero
//    { 'targetHas:stun': true }
//    { tilesTravelled: { min: 4 } }    a range (min / max, inclusive)
//    { elevationDiff: { max: -1 } }
//    { distance: 3 }                   exactly
//    { any: [ {..}, {..} ] }           at least one of the listed conditions
//    { not: {..} }                     the listed condition fails
//
//  ----- 3. FACTS - what a quantity or a condition may read --------------
//  Worked out by the engine for the cast (or the moment) being resolved:
//    ABOUT THE CASTER, this activation
//    tilesTravelled   tiles walked since the activation started
//    moveSpent        movement points the walk has cost
//    moveLeft         movement points still unspent
//    didNotMove       1 if the unit stands where it started the activation
//    hp, maxHp, hpFrac   the caster's health (hpFrac in 0..1)
//    stacks           the caster's stacks right now
//    consumed         stacks this cast's `consume` effect took (0 before it)
//    castsThisBattle  how many times the caster has cast THIS ability already
//    adjacentAllies / adjacentEnemies   living units of that side next to the caster
//    onTag:<tagId>    1 if the caster stands on that tile tag
//    ABOUT THE AIM
//    distance         tiles from the caster to the aim point
//    maxRange         the ability's furthest castZone tile
//    atMaxRange       1 if distance === maxRange
//    elevationDiff    height of the aim tile minus the caster's tile
//    elevationClimb / elevationDrop   the positive part of each direction
//    ABOUT THE TARGET (the unit an effect is landing on right now)
//    targetHp, targetMaxHp, targetHpFrac
//    targetHas:<statusId>   1 if the target carries that status
//    targetOnTag:<tagId>
//    targetAdjacentAllies   living units of the TARGET's side next to it
//    ABOUT THE BOARD
//    unitsWith:<statusId>   living units carrying that status
//    amount:<effectId>      what an earlier effect of this cast evaluated to
//                           (the heal of 'heal', say), for "regenerate X-1"
//    round
//
//  ----- 4. EFFECTS ----------------------------------------------------
//  An ability is a list of effects; an upgrade node may add to it; a trigger
//  is an effect with a `when`. Every effect:
//    kind       what it does (the list below)
//    id         a name upgrades can refer to (tune / set); optional
//    zone       offsets around the anchor it covers: [[q, r], ...]. LEFT OUT on
//               an ability's effect, it follows the ability's main hit (the
//               effect with id 'hit'): an upgrade that "also applies Bleed"
//               bleeds every tile the swipe hits, however the swipe is later
//               reshaped. A string names another effect's id to follow
//               instead. (A trigger with no zone means the whole board, see 5.)
//    anchor     'aim' (default for an ability's effects), 'caster' (where the
//               caster stood when the cast began), 'landing' (where it stands
//               after its dash - these run last)
//    targets    who in the zone it touches: 'any' (default), 'enemies',
//               'allies' (not the caster), 'party' (allies and the caster),
//               'self', 'units' (both sides). A trigger may also say 'source'
//               (who put the status on) or 'killer' (who just killed the carrier).
//               A trigger with no zone means "every such unit on the board".
//    if         a condition (section 2)
//  By kind:
//    damage     amount, times (default 1), multiplier (default 1: the whole
//               hit is multiplied, so { n: 1, if: {...} } added to it doubles
//               the hit when the condition holds), pierce (ignores the
//               target's damage reduction), lifesteal (extra damage, and the
//               caster heals the same), overlapGrant (default 1: how much
//               overlap bonus LATER casts of the volley get on tiles this one hit)
//    heal       amount
//    status     status (a STATUSES id), amount (its X; default the row's),
//               turns (its Y; default the row's), repeat (default 1: how many
//               separate applications - "one Wither per stack consumed")
//    push       dir (0..5, 0 = away from the caster when rotatable), dist
//               (default 1), onCrash: { status, amount, turns } (optional)
//    throw      to: 'behindCaster' - whoever stands in the zone is thrown over
//               the caster onto the tile behind it
//    swap       the caster changes places with the unit in the zone
//    height     amount, mode 'rel' | 'abs'
//    tag        tag (a COMBAT_TAGS id), life (overrides the row's)
//    dash       through: 'allies' (the charge passes allies) or absent
//    consume    resource (only 'stacks' today), max (default: all)
//    gain       resource, amount - targets default 'self'
//    extraAttack  the unit gets to aim and fire once more this turn
//
//  ----- 5. TRIGGERS ---------------------------------------------------
//  An effect with `when`, carried by a unit (an upgrade node, a bestiary row,
//  a relic, an aura) or by a STATUS ROW (fires for whoever carries the status):
//    when       'battleStart', 'activationStart', 'activationEnd', 'hit'
//               (the carrier lost hp), 'kill' (the carrier killed a unit),
//               'death' (the carrier died), 'moved' (the carrier finished a walk)
//  Its `targets` defaults to 'self'. Facts about the aim are 0 in a trigger.
// =====================================================================

export const EFFECT_KINDS = ['damage', 'heal', 'status', 'push', 'throw', 'swap', 'height', 'tag', 'dash', 'consume', 'gain', 'extraAttack'];
export const ANCHORS = ['aim', 'caster', 'landing'];
export const TARGETS = ['any', 'enemies', 'allies', 'party', 'self', 'units', 'source', 'killer'];
export const TRIGGER_MOMENTS = ['battleStart', 'activationStart', 'activationEnd', 'hit', 'kill', 'death', 'moved'];
export const RESOURCES = ['stacks'];

const PLAIN_FACTS = new Set([
  'tilesTravelled', 'moveSpent', 'moveLeft', 'didNotMove', 'hp', 'maxHp', 'hpFrac', 'stacks', 'consumed',
  'castsThisBattle', 'adjacentAllies', 'adjacentEnemies',
  'distance', 'maxRange', 'atMaxRange', 'elevationDiff', 'elevationClimb', 'elevationDrop',
  'targetHp', 'targetMaxHp', 'targetHpFrac', 'targetAdjacentAllies', 'round',
]);
const PREFIX_FACTS = ['onTag', 'targetHas', 'targetOnTag', 'unitsWith', 'amount'];
export function isFact(name) {
  if (PLAIN_FACTS.has(name)) return true;
  const i = String(name).indexOf(':');
  return i > 0 && PREFIX_FACTS.includes(name.slice(0, i));
}

// ----- evaluation ---------------------------------------------------------
// `ctx.fact(name)` answers a fact (0 when it does not apply). The engine builds
// the context; everything here only reads it.
export function qty(q, ctx) {
  if (q === undefined || q === null) return 0;
  if (typeof q === 'number') return q;
  if (Array.isArray(q)) { let s = 0; for (const t of q) s += term(t, ctx); return s; }
  if (typeof q === 'object') return term(q, ctx);
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}
function term(t, ctx) {
  if (typeof t === 'number') return t;
  if (!t || typeof t !== 'object') return 0;
  if (t.if && !cond(t.if, ctx)) return 0;
  let v;
  if (t.per !== undefined) {
    const f = ctx && ctx.fact ? Number(ctx.fact(t.per)) || 0 : 0;
    const every = t.every > 0 ? t.every : 1;
    v = Math.floor(f / every) * (t.mul !== undefined ? t.mul : 1);
  } else v = Number(t.n) || 0;
  if (t.min !== undefined) v = Math.max(t.min, v);
  if (t.max !== undefined) v = Math.min(t.max, v);
  return v;
}
// The constant part of a quantity alone - what a button can print before the
// fight knows anything (every `per` term reads as 0, every `if` as false).
export const qtyStatic = (q) => qty(q, { fact: () => 0 });
// Does the quantity depend on anything but constants?
export function qtyIsDynamic(q) {
  if (q === null || q === undefined || typeof q === 'number') return false;
  const terms = Array.isArray(q) ? q : [q];
  return terms.some((t) => t && typeof t === 'object' && (t.per !== undefined || t.if));
}

export function cond(c, ctx) {
  if (c === undefined || c === null || c === true) return true;
  if (c === false) return false;
  if (typeof c !== 'object') return !!c;
  for (const [k, spec] of Object.entries(c)) {
    if (k === 'any') { if (!(Array.isArray(spec) && spec.some((s) => cond(s, ctx)))) return false; continue; }
    if (k === 'not') { if (cond(spec, ctx)) return false; continue; }
    const f = ctx && ctx.fact ? Number(ctx.fact(k)) || 0 : 0;
    if (spec === true) { if (!f) return false; }
    else if (spec === false) { if (f) return false; }
    else if (typeof spec === 'number') { if (f !== spec) return false; }
    else if (spec && typeof spec === 'object') {
      if (spec.min !== undefined && f < spec.min) return false;
      if (spec.max !== undefined && f > spec.max) return false;
    }
  }
  return true;
}

// ----- checking what was written --------------------------------------------
// Each returns the normalised form (defaults filled in) or null, saying why on
// the console unless `quiet`. `where` names the writer for the message.
function warn(quiet, where, why, obj) { if (!quiet) console.warn(`[rules] ${where}: ${why}`, obj); return null; }

function checkQty(q, where, field, quiet) {
  if (q === undefined || q === null) return true;
  if (typeof q === 'number') return true;
  const terms = Array.isArray(q) ? q : [q];
  for (const t of terms) {
    if (typeof t === 'number') continue;
    if (!t || typeof t !== 'object') { warn(quiet, where, `${field}: a term is a number or { n } / { per }`, t); return false; }
    if (t.per !== undefined && !isFact(t.per)) { warn(quiet, where, `${field}: unknown fact "${t.per}"`, t); return false; }
    if (t.per === undefined && t.n === undefined) { warn(quiet, where, `${field}: a term needs n or per`, t); return false; }
    if (t.if && !checkCond(t.if, where, quiet)) return false;
  }
  return true;
}
function checkCond(c, where, quiet) {
  if (c === undefined || c === null || typeof c === 'boolean') return true;
  if (typeof c !== 'object') { warn(quiet, where, 'a condition is an object of fact -> test', c); return false; }
  for (const [k, spec] of Object.entries(c)) {
    if (k === 'any') { if (!Array.isArray(spec) || !spec.every((s) => checkCond(s, where, quiet))) return false; continue; }
    if (k === 'not') { if (!checkCond(spec, where, quiet)) return false; continue; }
    if (!isFact(k)) { warn(quiet, where, `condition reads unknown fact "${k}"`, c); return false; }
    if (!(spec === true || spec === false || typeof spec === 'number' || (spec && typeof spec === 'object'))) { warn(quiet, where, `condition "${k}": true / false / a number / { min, max }`, c); return false; }
  }
  return true;
}
function checkZone(z, where, quiet) {
  if (z === undefined || z === null) return true;
  if (typeof z === 'string') return true;   // follows the named effect's zone
  if (!Array.isArray(z) || !z.every((o) => Array.isArray(o) && o.length >= 2 && Number.isFinite(o[0]) && Number.isFinite(o[1]))) { warn(quiet, where, 'zone is a list of [q, r] offsets', z); return false; }
  return true;
}

// `known` = { statuses, tags } - the tables, so an effect naming a row that is
// not there is caught here and not in the middle of a fight.
export function checkEffect(e, where = 'effect', known = {}, quiet = false) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return warn(quiet, where, 'an effect is an object with a kind', e);
  if (!EFFECT_KINDS.includes(e.kind)) return warn(quiet, where, `kind must be one of ${EFFECT_KINDS.join(' / ')}`, e);
  const out = { ...e };
  if (out.anchor !== undefined && !ANCHORS.includes(out.anchor)) return warn(quiet, where, `anchor must be one of ${ANCHORS.join(' / ')}`, e);
  if (out.targets !== undefined && !TARGETS.includes(out.targets)) return warn(quiet, where, `targets must be one of ${TARGETS.join(' / ')}`, e);
  if (!checkZone(out.zone, where, quiet)) return null;
  if (!checkCond(out.if, where, quiet)) return null;
  for (const f of ['amount', 'times', 'multiplier', 'dist', 'lifesteal', 'overlapGrant', 'turns', 'life', 'max', 'repeat']) if (!checkQty(out[f], where, f, quiet)) return null;
  switch (out.kind) {
    case 'damage':
      if (out.amount === undefined) return warn(quiet, where, 'damage needs an amount', e);
      if (out.times === undefined) out.times = 1;
      if (out.multiplier === undefined) out.multiplier = 1;
      if (out.overlapGrant === undefined) out.overlapGrant = 1;
      break;
    case 'heal':
      if (out.amount === undefined) return warn(quiet, where, 'heal needs an amount', e);
      break;
    case 'status':
      if (!out.status) return warn(quiet, where, 'status needs a status id', e);
      if (known.statuses && !known.statuses[out.status]) return warn(quiet, where, `no status row named "${out.status}"`, e);
      if (out.repeat === undefined) out.repeat = 1;
      break;
    case 'push':
      if (out.dir === undefined) out.dir = 0;
      if (out.dist === undefined) out.dist = 1;
      if (out.onCrash) {
        if (!out.onCrash.status) return warn(quiet, where, 'onCrash names a status', e);
        if (known.statuses && !known.statuses[out.onCrash.status]) return warn(quiet, where, `onCrash: no status row named "${out.onCrash.status}"`, e);
      }
      break;
    case 'throw':
      if (out.to !== 'behindCaster') return warn(quiet, where, "throw: `to` must be 'behindCaster'", e);
      break;
    case 'swap':
      if (out.targets === undefined) out.targets = 'allies';
      break;
    case 'height':
      if (out.amount === undefined) return warn(quiet, where, 'height needs an amount', e);
      if (out.mode === undefined) out.mode = 'rel';
      if (!['rel', 'abs'].includes(out.mode)) return warn(quiet, where, "height mode is 'rel' or 'abs'", e);
      break;
    case 'tag':
      if (!out.tag) return warn(quiet, where, 'tag needs a tag id', e);
      if (known.tags && !known.tags[out.tag]) return warn(quiet, where, `no tile tag named "${out.tag}"`, e);
      break;
    case 'dash':
      if (out.through !== undefined && out.through !== 'allies') return warn(quiet, where, "dash: `through` is 'allies' or absent", e);
      break;
    case 'consume':
      if (out.resource === undefined) out.resource = 'stacks';
      if (!RESOURCES.includes(out.resource)) return warn(quiet, where, `resource must be one of ${RESOURCES.join(' / ')}`, e);
      break;
    case 'gain':
      if (out.resource === undefined) out.resource = 'stacks';
      if (!RESOURCES.includes(out.resource)) return warn(quiet, where, `resource must be one of ${RESOURCES.join(' / ')}`, e);
      if (out.amount === undefined) return warn(quiet, where, 'gain needs an amount', e);
      if (out.targets === undefined) out.targets = 'self';
      break;
    case 'extraAttack':
      if (out.targets === undefined) out.targets = 'self';
      break;
    default: break;
  }
  if (out.targets === undefined) out.targets = 'any';
  if (out.anchor === undefined) out.anchor = 'aim';
  // An ability's effect with no zone of its own follows the main hit. A
  // trigger (has a `when`) and an effect aimed at one unit (self / source /
  // killer) have no tiles to follow.
  if (out.zone === undefined && !out.when && ZONED.includes(out.kind) && !['self', 'source', 'killer'].includes(out.targets)) out.zone = 'hit';
  return out;
}
const ZONED = ['damage', 'heal', 'status', 'push', 'throw', 'swap', 'height', 'tag', 'gain'];

// Turns every `zone: '<effectId>'` of a resolved ability into that effect's
// offsets (the main hit's by default). Without a hit to follow, the aim tile.
export function resolveZones(effects, where = 'ability') {
  const byId = (id) => effects.find((e) => e.id === id && Array.isArray(e.zone));
  for (const e of effects) {
    if (typeof e.zone !== 'string') continue;
    const src = byId(e.zone);
    if (!src && e.zone !== 'hit') console.warn(`[rules] ${where}: an effect follows the zone of "${e.zone}", which the ability does not have - aiming at the target tile instead`);
    e.zone = src ? src.zone.map((o) => [...o]) : [[0, 0]];
  }
  return effects;
}

// A trigger is an effect with a moment. Its default target is the carrier.
export function checkTrigger(e, where = 'trigger', known = {}, quiet = false) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return warn(quiet, where, 'a trigger is an effect with a `when`', e);
  if (!TRIGGER_MOMENTS.includes(e.when)) return warn(quiet, where, `when must be one of ${TRIGGER_MOMENTS.join(' / ')}`, e);
  const out = checkEffect({ targets: 'self', ...e }, where, known, quiet);
  if (!out) return null;
  if (out.anchor === 'aim') out.anchor = 'caster';
  return out;
}

// The furthest tile of a cast zone - the `maxRange` fact and what the
// "at max range" test reads.
export function zoneMaxRange(zone) {
  let m = 0;
  for (const o of zone ?? []) m = Math.max(m, Math.max(Math.abs(o[0]), Math.abs(o[1]), Math.abs(o[0] + o[1])));
  return m;
}
