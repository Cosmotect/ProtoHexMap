// The statuses a unit can carry, as the interface sees them.
//
// This file decides nothing: the statuses live in the combat config
// (src/config/statuses.js), which is also what the battle engine reads. TWO
// places draw the same badges from here - the plaque over a unit's head
// (src/local/localview.js, on a canvas) and the unit card in the panel
// (src/ui.js, in HTML) - so a status can never mean one thing in the arena
// and another in the panel.
//
// A unit carries `unit.statuses = [{ id, amount, turns, source, sourceName, seen }]` - one
// entry per INSTANCE (a 'separate'-stacking row may be carried several times).
// The badge shows the row's X ({x}) and its clock ({y}).
import { STATUSES, isPermanent } from './config/statuses.js';
import { t, tn, hasKey } from './i18n.js';

// What a status is CALLED and what it DOES, ready to show, with {x} / {y}
// filled in. The row's own `name` / `desc` are the source; a locale may
// override either with status.<id>.name / .desc. `hs` is a row from
// statusesFor (it carries amount and turns) or a bare status id.
export function statusInfo(hs) {
  const id = typeof hs === 'string' ? hs : hs.id;
  const def = STATUSES[id] || {};
  const amount = typeof hs === 'string' ? def.amount : hs.amount;
  const turns = typeof hs === 'string' ? def.turns : hs.turns;
  const x = amount == null ? '' : String(amount);
  const y = !(turns > 0) ? '' : String(turns);
  // {source}: who put it on, for the rows that point back at someone (Lifelink).
  const source = typeof hs === 'string' ? '' : (hs.sourceName ? tn(hs.sourceName) : '');
  const fill = (s) => String(s ?? '').replace(/\{x\}/g, x).replace(/\{y\}/g, y).replace(/\{n\}/g, x).replace(/\{source\}/g, source || '?');
  const pick = (field) => {
    const key = `status.${id}.${field}`;
    if (hasKey(key)) return fill(t(key, { x, y, n: x, source }));
    return fill(def[field]);
  };
  return { name: pick('name') || id, desc: pick('desc'), icon: def.icon ?? '', color: def.color ?? '' };
}

// What one unit is carrying right now: [{ id, icon, color, amount, turns,
// permanent, source }], in the order the table lists the rows (instances of
// one row in the order they were applied) so the badges never jump around.
//
// `permanent` marks a status nothing ends by itself (no clock, no decay) - the
// always-on kind of passive: Padded, Hard Shell. The badge rows leave those
// OUT by default; the party view lists them in full. Pass { permanent: true }
// to get everything.
export function statusesFor(unit, opts) {
  if (!unit || !unit.statuses || !unit.statuses.length) return [];
  const withPermanent = !!(opts && opts.permanent);
  const out = [];
  for (const [id, def] of Object.entries(STATUSES)) {
    for (const inst of unit.statuses) {
      if (inst.id !== id) continue;
      const permanent = isPermanent(def, inst);
      if (permanent && !withPermanent) continue;
      out.push({ id, icon: def.icon, color: def.color, amount: inst.amount, turns: Number(inst.turns) || 0, permanent, source: inst.source ?? null, sourceName: inst.sourceName ?? null });
    }
  }
  return out;
}

// The number in a badge's corner, as text ('' = draw no number). A status with
// a clock shows the turns it has left; one that wears down shows what is left
// of it; anything else shows its amount only when it is more than one.
export function badgeNumber(hs) {
  if (hs.turns > 0) return String(hs.turns);
  const def = STATUSES[hs.id] || {};
  if (def.decay > 0 || def.decayOnHit > 0) return String(hs.amount);
  if (hs.amount > 1) return String(hs.amount);
  return '';
}
