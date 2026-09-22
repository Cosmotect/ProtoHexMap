// =====================================================================
//  DAMAGE NOTATION - "X damage Y times" (since 2026-09-22, Slay the Spire's
//  page). An ability's `damage` is written in the config as
//    5       five damage, once
//    "5x4"   five damage, four times (four separate hits per covered tile)
//  and an upgrade's `add.damage` as
//    4       or "4x"   +4 base damage
//    "x4"              +4 to the times
//    "4x4"             +4 base AND +4 times
//  Everything that changes the damage - statuses, height, the Stasis debuff,
//  the overlap bonus - changes the BASE, i.e. every hit. The helpers here are
//  the one place the notation is read or written; nothing else parses "x".
// =====================================================================

// An authored damage value -> { base, times }. Anything unreadable is 0x1.
export function parseDamage(v) {
  if (v == null || v === '') return { base: 0, times: 1 };
  if (typeof v === 'number') return { base: Number.isFinite(v) ? v : 0, times: 1 };
  if (typeof v === 'object' && v && 'base' in v) return { base: Number(v.base) || 0, times: Math.max(1, Number(v.times) || 1) };
  const m = String(v).trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:x\s*(\d+))?$/i);
  if (!m) return { base: 0, times: 1 };
  return { base: Number(m[1]), times: Math.max(1, Number(m[2] ?? 1)) };
}

// An upgrade's damage change -> { base, times } as DELTAS ("x4" = +4 times).
export function parseDamageDelta(v) {
  if (v == null || v === '') return { base: 0, times: 0 };
  if (typeof v === 'number') return { base: Number.isFinite(v) ? v : 0, times: 0 };
  const m = String(v).trim().match(/^(-?\d+)?\s*(?:x\s*(-?\d+)?)?$/i);
  if (!m || (m[1] === undefined && m[2] === undefined)) return { base: 0, times: 0 };
  return { base: Number(m[1] ?? 0), times: Number(m[2] ?? 0) };
}

// Writes { base, times } back in the notation: a plain number when it hits
// once, "BxT" otherwise - so a resolved (upgraded) ability reads like an
// authored one.
export function formatDamage(d) {
  const base = Number(d.base) || 0, times = Math.max(1, Number(d.times) || 1);
  return times === 1 ? base : `${base}x${times}`;
}

// Fold an upgrade's delta onto an ability's damage (both in the notation).
export function addDamage(v, delta) {
  const d = parseDamage(v), a = parseDamageDelta(delta);
  return formatDamage({ base: d.base + a.base, times: Math.max(1, d.times + a.times) });
}

export const hasDamage = (v) => parseDamage(v).base > 0;
export const damageTotal = (v) => { const d = parseDamage(v); return d.base * d.times; };
// The short form for buttons and tooltips: "5" or "5x4".
export const damageLabel = (v) => String(formatDamage(parseDamage(v)));
