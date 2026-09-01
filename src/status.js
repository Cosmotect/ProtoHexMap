// The statuses ("buffs") a unit can carry, in the order they are shown.
//
// This lives on its own because TWO places draw the same badges from it: the
// plaque over a unit's head (src/local/localview.js, on a canvas) and the enemy
// card in the Local Map Info panel (src/ui.js, in HTML). One table, so a status
// can never mean one thing in the arena and another in the panel.
//
// `turnsOf` reads a remaining-turns count IF the engine has one for that status
// - none of today's do (a shield is spent by the next hit, a stun by the next
// activation), so no number is drawn. The moment durations exist, put them on
// the unit as `statusTurns[<id>]` and the badge starts counting on its own.
// `amount` is the status's magnitude where it has one (haste is +N / -N speed).
export const STATUSES = [
  { id: 'shield', icon: '🛡', on: (u) => !!u.shield },
  { id: 'crit', icon: '⚡', on: (u) => !!u.critBuff },
  { id: 'stun', icon: '💫', on: (u) => !!u.stunned },
  { id: 'haste', icon: '💨', on: (u) => (u.haste ?? 0) > 0, amount: (u) => u.haste },
  { id: 'slow', icon: '🐌', on: (u) => (u.haste ?? 0) < 0, amount: (u) => u.haste },
];

// What one unit is carrying right now: [{ id, icon, turns, amount }].
export function statusesFor(unit) {
  if (!unit) return [];
  const out = [];
  for (const st of STATUSES) {
    if (!st.on(unit)) continue;
    out.push({
      id: st.id,
      icon: st.icon,
      turns: Number(unit.statusTurns?.[st.id]) || 0,
      amount: st.amount ? st.amount(unit) : null,
    });
  }
  return out;
}

// The number that goes in a badge's corner, as text ('' = draw no number).
// A status without a real duration gets nothing: inventing one would be a lie
// about the rules.
export function badgeNumber(hs) {
  return hs.turns > 0 ? String(hs.turns) : '';
}
