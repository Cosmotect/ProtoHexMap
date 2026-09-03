// =====================================================================
//  VIRTUAL PLAYTESTER - the bots (combat policies).
//
//  A bot is a POLICY, not a player model: actUnit(battle, unit, rng) gets one
//  party unit's activation and may reposition it and cast one ability, using
//  ONLY the public engine API (selectAbility / clickTile / state reads) - the
//  same surface the human's clicks go through. It must never mutate battle
//  state directly, and it sees no hidden information (the arena has none yet).
//
//  greedy  - simple human-ish heuristics: heal the badly hurt, shield the
//            exposed, hit whatever is in range, otherwise walk towards the
//            nearest enemy. Reads as a competent first-time player.
//  random  - stumbles around and presses buttons. The lower bound: if a fight
//            is winnable by THIS bot, it is trivial; also a cheap crash-finder.
//
//  Results are comparative, not absolute: a bot's win rate moves when the
//  numbers move, and that difference is the signal.
// =====================================================================
import { hexDist, addK, rotOff, abRotFor } from '../../src/local/battle/bhex.js';

const aliveEnemies = (sb) => sb.units.filter((u) => u.isEnemy && u.hp > 0);
const aliveAllies = (sb) => sb.units.filter((u) => !u.isEnemy && u.hp > 0);
const unitAt = (sb, k) => sb.units.find((u) => u.hp > 0 && u.pos === k);

// Aim keys (clickable tiles) of the currently selected ability.
const aimKeys = (sb) => (sb.aimMap ? Object.keys(sb.aimMap) : []);

// The exact tiles an ability would touch when aimed at `anchor` from
// `casterPos` - dmgZone offsets in the real rotated frame, the same maths the
// engine resolves the cast with. This is what lets the bot see who a swing or
// a blast actually clips: itself, an ally behind the target, an enemy inside
// a healing bloom.
function footprint(ab, casterPos, anchor) {
  const rk = abRotFor(ab, casterPos, anchor);
  return ab.dmgZone.map((off) => addK(anchor, rotOff(off, rk)));
}

// Casts `abId` at the best target the aim map offers, by simple value rules.
// Returns true when a cast actually happened.
function tryCast(battle, unit, abId) {
  const sb = battle.state;
  const ab = battle.abilityFor(unit, abId);
  if (!ab) return false;
  battle.selectAbility(abId);
  if (sb.selAb !== abId || !sb.aimMap) return false;

  let targetKey = null;
  if (ab.damage > 0) {
    // Score every distinct aim: total enemy damage (kills weigh extra), and a
    // hard NO to any aim whose real footprint clips an ally or the caster -
    // clean hands over extra damage; another ability can pick up the slack.
    let best = null;
    for (const k of aimKeys(sb)) {
      const anchor = sb.aimMap[k];
      const tiles = footprint(ab, unit.pos, anchor);
      let score = 0, allies = 0;
      for (const t of tiles) {
        const u = unitAt(sb, t);
        if (!u) continue;
        if (u.isEnemy) score += Math.min(u.hp, ab.damage) + (u.hp <= ab.damage ? 20 : 0);
        else allies += 1;
      }
      if (!score || allies) continue;
      if (!best || score > best.score) best = { k, score };
    }
    targetKey = best?.k ?? null;
  } else if (ab.heal > 0) {
    // Heal where the wounds are - and NEVER where the bloom would also patch
    // an enemy up (a live playtester finding: an upgraded Mend that splashes
    // the ring around its target can out-heal the party's own damage).
    let best = null;
    for (const k of aimKeys(sb)) {
      const anchor = sb.aimMap[k];
      const tiles = footprint(ab, unit.pos, anchor);
      let value = 0, enemies = 0;
      for (const t of tiles) {
        const u = unitAt(sb, t);
        if (!u) continue;
        if (u.isEnemy) enemies += 1;
        else value += Math.min(u.maxHp - u.hp, ab.heal);
      }
      if (enemies || value < ab.heal * 0.75) continue;
      if (!best || value > best.value) best = { k, value };
    }
    targetKey = best?.k ?? null;
  } else if (ab.buff === 'shield') {
    // Shield the most endangered unshielded ally: closest to the enemy line.
    const enemies = aliveEnemies(sb);
    const cands = aimKeys(sb)
      .map((k) => ({ k, u: unitAt(sb, k) }))
      .filter((e) => e.u && !e.u.isEnemy && !e.u.shield);
    cands.sort((a, b) => nearestDist(a.u.pos, enemies) - nearestDist(b.u.pos, enemies));
    targetKey = cands[0]?.k ?? null;
  }

  if (targetKey == null) { battle.selectAbility(abId); return false; }   // toggle off
  battle.clickTile(targetKey);
  return true;
}

function nearestDist(pos, units) {
  let best = Infinity;
  for (const u of units) best = Math.min(best, hexDist(pos, u.pos));
  return best;
}

// One activation of the greedy policy: cast if anything worthwhile is in
// range; otherwise step towards the nearest enemy and try again; a healer
// with nothing to do holds its ground.
function greedyAct(battle, unit) {
  const sb = battle.state;
  const castNow = () => unit.abilityIds.some((abId) => tryCast(battle, unit, abId));
  if (castNow()) return;
  if (sb.over || sb.phase !== 'player') return;

  // Nothing in range: close the distance (free repositioning, so the range is
  // measured from the round's starting tile - the engine handles that).
  if (!unit.moveLocked && !unit.done) {
    const res = battle.reachFor();
    const enemies = aliveEnemies(sb);
    if (res && enemies.length) {
      // Close the distance FIRST (the bot is the attacker: camping a plateau
      // the enemy AI refuses to climb stalls the fight forever - a real
      // standoff the gym found on day one); height only breaks ties, so at
      // EQUAL distance the bot takes the high ground and dodges LOW swings.
      let bestK = null, bestScore = Infinity;
      for (const k of Object.keys(res.d)) {
        if (k !== unit.pos && (res.occ.has(k) || unitAt(sb, k))) continue;
        let nearest = null, nd = Infinity;
        for (const e of enemies) { const d = hexDist(k, e.pos); if (d < nd) { nd = d; nearest = e; } }
        const hDiff = (sb.heights[k] ?? 0) - (sb.heights[nearest.pos] ?? 0);   // >0 = we stand higher
        const score = nd * 100 + res.d[k] - Math.max(-2, Math.min(2, hDiff)) * 6;
        if (score < bestScore) { bestScore = score; bestK = k; }
      }
      if (bestK && bestK !== unit.pos) {
        battle.clickTile(bestK);
        castNow();   // maybe the step brought something into range
      }
    }
  }
}

// One activation of the random policy: sometimes wander, then cast at any
// legal target if a die roll feels like it.
function randomAct(battle, unit, rng) {
  const sb = battle.state;
  if (!unit.moveLocked && !unit.done && rng.chance(0.7)) {
    const res = battle.reachFor();
    if (res) {
      const stops = Object.keys(res.d).filter((k) => k === unit.pos || (!res.occ.has(k) && !unitAt(sb, k)));
      if (stops.length) battle.clickTile(rng.pick(stops));
    }
  }
  if (sb.over || sb.phase !== 'player') return;
  for (const abId of shuffled(unit.abilityIds, rng)) {
    battle.selectAbility(abId);
    if (sb.selAb !== abId || !sb.aimMap) continue;
    const keys = aimKeys(sb);
    if (keys.length && rng.chance(0.9)) { battle.clickTile(rng.pick(keys)); return; }
    battle.selectAbility(abId);   // toggle off
  }
}

function shuffled(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const BOTS = {
  greedy: { name: 'greedy', actUnit: (battle, unit) => greedyAct(battle, unit) },
  random: { name: 'random', actUnit: (battle, unit, rng) => randomAct(battle, unit, rng) },
};
