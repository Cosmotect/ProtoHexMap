// The statuses ("buffs") a unit can carry, as the interface sees them.
//
// This file no longer decides anything: the statuses themselves live in the
// combat config (`STATUSES` in src/config/abilities.js), which is also what the
// battle engine reads. TWO places draw the same badges from here - the plaque
// over a unit's head (src/local/localview.js, on a canvas) and the unit card in
// the panel (src/ui.js, in HTML) - so a status can never mean one thing in the
// arena and another in the panel.
//
// A unit carries `unit.status = { <id>: { turns, charges, over } }`, where `over`
// holds whatever the ability that applied it changed through buffX. The badge
// needs ONE number for the {n} of the locale text, and that is the status's first
// knob - its leading verb (config/abilities.js: statusKnobs). Shown as a SIZE, not
// as the stored number: the table writes `slow` as speed -1, but every locale
// string is phrased "moves {n} tiles less", so the sign lives in the status's
// name and the badge shows 1.
import { STATUSES, statusKnobs, isPermanent } from './config/abilities.js';
import { t, hasKey } from './i18n.js';

// What a status is CALLED and what it DOES, ready to show, with {n} filled in.
// The row's own `name` / `desc` (config/abilities.js) are the source; a locale
// may override either with status.<id>.name / .desc, which is how the Russian
// table translates them. Never the raw key: printing "status.enraged.name" at
// the player is what happened when the lookup had no fallback (fixed 2026-09-12).
// `hs` is a row from statusesFor (it carries the amount) or a bare status id.
export function statusInfo(hs) {
  const id = typeof hs === 'string' ? hs : hs.id;
  const def = STATUSES[id] || {};
  // A bare id reads the amount off the table (the row's first knob, as a size),
  // exactly as statusesFor does for a carried one without overrides.
  let amount = typeof hs === 'string' ? null : hs.amount;
  if (typeof hs === 'string') {
    const knob = statusKnobs(def)[0];
    amount = knob !== undefined && typeof def[knob] === 'number' ? Math.abs(def[knob]) : null;
  }
  const n = amount == null ? '' : String(amount);
  const pick = (field) => {
    const key = `status.${id}.${field}`;
    if (hasKey(key)) return t(key, { n });
    return String(def[field] ?? '').replace(/\{n\}/g, n);
  };
  return { name: pick('name') || id, desc: pick('desc'), icon: def.icon ?? '', color: def.color ?? '' };
}

// What one unit is carrying right now: [{ id, icon, color, turns, charges,
// amount, permanent }], in the order the table lists them so the badges never
// jump around. A PASSIVE that was put on at battle start is in the bag like any
// other status and comes out of here the same way; what sets it apart, if
// anything, is the row itself.
//
// `permanent` marks a status nothing can end (no clock, nothing spends it - the
// always-on kind of passive: Padded, Regenerating). The badge rows leave those
// OUT by default: a slot on the unit card is for something the player has to
// keep an eye on, and a thing that can never change is not that. The party view
// will list them in full. Pass { permanent: true } to get everything.
export function statusesFor(unit, opts) {
  if (!unit || !unit.status) return [];
  const withPermanent = !!(opts && opts.permanent);
  const out = [];
  for (const [id, def] of Object.entries(STATUSES)) {
    const slot = unit.status[id];
    if (!slot) continue;
    const permanent = isPermanent(def, slot);
    if (permanent && !withPermanent) continue;
    const knob = statusKnobs(def)[0];
    const over = slot.over || {};
    const stored = knob === undefined ? null : (over[knob] !== undefined ? over[knob] : def[knob]);
    const amount = typeof stored === 'number' ? Math.abs(stored) : null;
    out.push({
      id,
      icon: def.icon,
      color: def.color,
      turns: Number(slot.turns) || 0,
      charges: Number(slot.charges) || 0,
      permanent,
      amount,
    });
  }
  return out;
}

// The number in a badge's corner, as text ('' = draw no number). A status with a
// clock shows the turns it has left; one that is spent by use shows how many uses
// are left, but only when there is more than one (a plain shield stays a plain
// shield). Nothing is invented: a status with neither shows nothing.
export function badgeNumber(hs) {
  if (hs.turns > 0) return String(hs.turns);
  if (hs.charges > 1) return String(hs.charges);
  return '';
}
