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
import { STATUSES, statusKnobs } from './config/abilities.js';

// What one unit is carrying right now: [{ id, icon, color, turns, amount }], in
// the order the table lists them so the badges never jump around.
export function statusesFor(unit) {
  if (!unit) return [];
  // PASSIVES sit in this row alongside the applied statuses, on purpose: they are
  // rows of the same table and they read the same way. They carry no slot, so no
  // clock and no charge count - the badge is just the icon.
  const passives = new Set(unit.passives ?? []);
  if (!unit.status && !passives.size) return [];
  const out = [];
  for (const [id, def] of Object.entries(STATUSES)) {
    const slot = (unit.status || {})[id];
    if (!slot && !passives.has(id)) continue;
    const knob = statusKnobs(def)[0];
    const over = (slot && slot.over) || {};
    const stored = knob === undefined ? null : (over[knob] !== undefined ? over[knob] : def[knob]);
    const amount = typeof stored === 'number' ? Math.abs(stored) : null;
    out.push({
      id,
      icon: def.icon,
      color: def.color,
      turns: Number(slot && slot.turns) || 0,
      charges: Number(slot && slot.charges) || 0,
      passive: !slot,
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
