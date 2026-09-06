// The statuses ("buffs") a unit can carry, as the interface sees them.
//
// This file no longer decides anything: the statuses themselves live in the
// combat config (`STATUSES` in src/config/abilities.js), which is also what the
// battle engine reads. TWO places draw the same badges from here - the plaque
// over a unit's head (src/local/localview.js, on a canvas) and the unit card in
// the panel (src/ui.js, in HTML) - so a status can never mean one thing in the
// arena and another in the panel.
//
// A unit carries `unit.status = { <id>: { turns, charges, amount } }`. `amount`
// is what the ability that applied it handed over (the table's `amountIs` names
// which of the status's own fields it replaces); the badge shows it where the
// locale text asks for {n}.
import { STATUSES } from './config/abilities.js';

// What one unit is carrying right now: [{ id, icon, color, turns, amount }], in
// the order the table lists them so the badges never jump around.
export function statusesFor(unit) {
  if (!unit || !unit.status) return [];
  const out = [];
  for (const [id, def] of Object.entries(STATUSES)) {
    const slot = unit.status[id];
    if (!slot) continue;
    // Back to the magnitude the designer wrote: a `slow` stores speed -2 but was
    // authored, and reads, as "2" (config/abilities.js, amountSign).
    const stored = slot.amount !== undefined ? slot.amount : (def.amountIs ? def[def.amountIs] : null);
    const amount = typeof stored === 'number' ? stored * (def.amountSign || 1) : stored;
    out.push({
      id,
      icon: def.icon,
      color: def.color,
      turns: Number(slot.turns) || 0,
      charges: Number(slot.charges) || 0,
      amount: def.amountIs ? amount : null,
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
