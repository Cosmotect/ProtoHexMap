// =====================================================================
//  COMBAT ENGINE - the hex-box battle core, transplanted.
//
//  Ported from hex-box js/09..12 (battle state, effect resolver, turn flow,
//  movement + enemy AI) with the editors, storage, undo, prediction UI and the
//  2D isometric renderer left behind. The engine is pure state + rules: it
//  never touches the DOM or Three.js. Everything visual goes out through the
//  callbacks given to createBattle():
//    onChange()                 state changed - re-read and redraw
//    onFloater(k, text, color)  a floating combat text over tile k
//    onLog(text)                one battle-log line (plain text)
//    onAnim(anim, done)         animate a move; call done() per tile entered
//                               via anim.enter(k) -> true means "stop here",
//                               then done() when the walk is over
//    onEnd(won)                 the battle is decided
//
//  Original behaviours kept: free player activation order, enemy phase by
//  initiative, one move + one cast per activation (the cast ends it), terrain
//  tag ticks, statuses (shield / crit / stun / speed change), pushes with
//  collisions, falls, crush chains and void edges, height changes, tag
//  placement with on-destroy / on-expire / periodic casts, high/low ground
//  damage modifiers, and the outcome-scoring enemy AI.
//  Added for Everlands: an ENEMY's world-map power gives bonus ability damage
//  (config.combat.powerPerDamage); PARTY units instead fight with their
//  UPGRADED ability defs (def.abilityDefs, resolved by src/upgrades.js from
//  the unit's unlocked tree nodes); partyDamageMod is a flat penalty to the
//  party's ability damage (the Stasis "damage" debuff); and a fatigue-forced
//  fight opens with an ambush enemy phase before round 1.
// =====================================================================
import { DIRS, K, PK, addK, hexDist, rotOff, aimRot, abRotFor, rotDir, boardTiles } from './bhex.js';
import { abilityById, tagDefById, combatStatsFor } from '../../config/abilities.js';

export function createBattle({ config, radius, heights, party, enemies, partyKeys, enemyKeys, forced,
                               partyDamageMod = 0, deferOpening = false,
                               onChange, onFloater, onLog, onAnim, onEnd }) {
  const CFG = config.combat;
  const R = radius;
  const tiles = boardTiles(R);
  const inMap = (k) => { const [q, r] = PK(k); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= R; };
  const tilePass = (k) => inMap(k);          // the arena has no blocked tiles (yet)
  const isVoid = (k) => CFG.voidEdges && !tilePass(k);
  const activeTiles = () => tiles;
  const abById = abilityById;
  // A unit's view of an ability: its own resolved (upgraded) def when it has
  // one, the base table otherwise (enemies, tag-triggered casts).
  const abFor = (u, id) => (u && u.abilityDefs && u.abilityDefs[id]) || abilityById(id);

  let idc = 1;
  const nid = () => idc++;

  // ----- battle state (hex-box `sb`) -----------------------------------
  const sb = {
    units: [], uidc: 0, tags: {}, heights: { ...heights },
    round: 1, phase: 'player', activeUid: null,
    enemyQ: [], eqi: 0, selAb: null, aimMap: null, reach: null,
    busy: false, over: null, deathQueue: [], ambush: !!forced,
  };

  const emit = () => onChange && onChange();
  const floater = (k, text, color) => onFloater && onFloater(k, text, color);
  const blog = (t) => onLog && onLog(t);

  function makeInstance(def, isEnemy, pos, i) {
    const cs = combatStatsFor(def.name);
    return {
      uid: 's' + i, name: def.name, icon: def.icon ?? null, power: def.power ?? 0,
      init: cs.init, speed: cs.speed, flying: !!cs.flying,
      maxHp: def.maxHp ?? def.hp, hp: def.hp,
      abilityIds: [...cs.abilities],
      abilityDefs: def.abilityDefs ?? null,
      pos, isEnemy, idx: i, partyIndex: def.partyIndex ?? null,
      startPos: pos, moveLocked: false, done: false, tagTicked: false,
      stunned: false, shield: false, critBuff: false, haste: 0, summoned: false,
    };
  }
  let i = 0;
  party.forEach((def, pi) => { if (partyKeys[pi]) sb.units.push(makeInstance({ ...def, partyIndex: def.partyIndex ?? pi }, false, partyKeys[pi], i++)); });
  enemies.forEach((def, ei) => { if (enemyKeys[ei]) sb.units.push(makeInstance(def, true, enemyKeys[ei], i++)); });
  sb.uidc = i;

  function tagInst(d, id, k) {
    return { tid: nid(), defId: id, k, name: d.name, icon: d.icon, color: d.color, desc: d.desc,
      dmg: d.dmg, heal: d.heal, life: d.life, hp: d.hp, maxHp: d.hp,
      pushable: d.pushable, collectible: d.collectible, passPickup: d.passPickup,
      onDestroy: d.onDestroy, onExpire: d.onExpire, onPickup: d.onPickup, onPeriodic: d.onPeriodic,
      everyX: d.everyX || 0, everyOff: d.everyOff || 0,
      everyCd: (d.everyOff > 0 ? d.everyOff : d.everyX) || 0 };
  }

  // ----- small queries --------------------------------------------------
  const sbH = (k) => sb.heights[k] ?? 0;
  const alive = (f) => sb.units.filter((u) => u.hp > 0 && (f === undefined || u.isEnemy === f));
  const unitAt = (k) => sb.units.find((u) => u.hp > 0 && u.pos === k);
  const curP = () => sb.units.find((u) => u.uid === sb.activeUid && !u.isEnemy && u.hp > 0);
  const speedFloor = (u) => Math.min(u.speed, CFG.minSpeed);
  const effSpeed = (u) => Math.max(speedFloor(u), u.speed + (u.haste || 0), 0);
  // Bonus ability damage from the unit's world-map power (enemies only in
  // practice: party defs carry no power). partyDamageMod hits party casts.
  const powBonus = (c) => (c && c.power ? Math.round(c.power / (CFG.powerPerDamage || 3)) : 0);
  const dmgMod = (c) => (c && c.isEnemy === false ? -partyDamageMod : 0);

  // ----- live / simulated effect state (hex-box 10-battle-effects) -------
  function liveSt() { return { sim: false, units: sb.units, tags: sb.tags, heights: sb.heights, deathQueue: sb.deathQueue, rec: null }; }
  function simSt() {
    return { sim: true,
      units: sb.units.map((u) => ({ uid: u.uid, isEnemy: u.isEnemy, flying: u.flying, hp: u.hp, maxHp: u.maxHp, pos: u.pos, shield: u.shield, critBuff: u.critBuff, haste: u.haste, stunned: u.stunned, power: u.power })),
      tags: Object.fromEntries(Object.entries(sb.tags).map(([k, t]) => [k, { ...t }])),
      heights: { ...sb.heights }, deathQueue: [],
      rec: { dmg: {}, moved: {}, killed: {}, stun: {}, tmoved: {}, tkilled: {} } };
  }
  const stH = (st, k) => st.heights[k] ?? 0;
  const sUnitAt = (st, k) => st.units.find((u) => u.hp > 0 && u.pos === k);
  const sBarrier = (st, k) => { const t = st.tags[k]; return t && t.hp > 0 ? t : null; };

  function sHit(st, v, amt, label, pre) {
    if (amt <= 0 || !v) return;
    pre = pre || '';
    const atk = st.atk ? st.atk + ' -> ' : '';
    if (v.uid !== undefined) {
      if (v.hp <= 0) return;
      if (v.shield || (st.shieldUsed && st.shieldUsed.has(v.uid))) {
        if (v.shield) { v.shield = false; if (st.shieldUsed) st.shieldUsed.add(v.uid); }
        if (!st.sim) { floater(v.pos, pre + 'SHIELD', '#5fc7e0'); blog(atk + v.name + ': blocked by shield'); }
        return;
      }
      v.hp = Math.max(0, v.hp - amt);
      if (st.sim) { st.rec.dmg[v.uid] = (st.rec.dmg[v.uid] || 0) + amt; if (v.hp <= 0) st.rec.killed[v.uid] = 1; }
      else {
        floater(v.pos, pre + '-' + amt + (label ? ' ' + label : ''), '#ff5d73');
        blog(atk + v.name + ': -' + amt + (label ? ' ' + label : ''));
        if (v.hp <= 0) blog(v.name + ' is down');
      }
    } else {
      if (v.hp <= 0) return;
      v.hp = Math.max(0, v.hp - amt);
      if (!st.sim) { floater(v.k, pre + '-' + amt, '#ffd75f'); blog(atk + v.name + ': -' + amt); }
      if (v.hp <= 0) {
        if (st.tags[v.k] === v) delete st.tags[v.k];
        if (st.sim) st.rec.tkilled[v.tid] = 1;
        else { floater(v.k, '✸ ' + v.name, '#ff9950'); blog(v.name + ' is destroyed'); }
        if (v.onDestroy) st.deathQueue.push({ abId: v.onDestroy, k: v.k, name: v.name });
      }
    }
  }
  function sHeal(st, v, amt) {
    if (amt <= 0 || !v || v.uid === undefined || v.hp <= 0) return;
    const g = Math.min(amt, v.maxHp - v.hp);
    v.hp += g;
    if (st.sim) st.rec.dmg[v.uid] = (st.rec.dmg[v.uid] || 0) - g;
    else if (g > 0) { floater(v.pos, '+' + g, '#a8e05f'); blog((st.atk ? st.atk + ' -> ' : '') + v.name + ': +' + g); }
  }
  function sStun(st, v) {
    if (!v || v.uid === undefined || v.hp <= 0) return;
    v.stunned = true;
    if (st.sim) { st.rec.stun[v.uid] = 1; return; }
    floater(v.pos, 'STUN', '#c9a8ff'); blog(v.name + ' is stunned');
    // A player unit that still has its turn this round loses THAT turn on the spot.
    if (sb.phase === 'player' && sb.activeUid && !v.isEnemy && !v.done && v.uid !== sb.activeUid) {
      v.done = true; v.stunned = false;
      blog(v.name + ' loses this turn');
    }
  }
  function sVoid(st, ent) {
    if (!ent || ent.hp <= 0) return;
    if (ent.uid !== undefined) {
      if (st.sim) { st.rec.dmg[ent.uid] = (st.rec.dmg[ent.uid] || 0) + ent.hp; st.rec.killed[ent.uid] = 1; }
      else { floater(ent.pos, '🕳 VOID', '#c66dff'); blog(ent.name + ' is shoved into the void'); }
      ent.hp = 0;
    } else {
      ent.hp = 0;
      if (st.tags[ent.k] === ent) delete st.tags[ent.k];
      if (st.sim) st.rec.tkilled[ent.tid] = 1;
      else { floater(ent.k, '🕳 ' + ent.name, '#c66dff'); blog(ent.name + ' falls into the void'); }
    }
  }
  function sMoveTo(st, ent, k) {
    if (ent.uid !== undefined) { ent.pos = k; if (st.sim) st.rec.moved[ent.uid] = k; }
    else { if (st.tags[ent.k] === ent) delete st.tags[ent.k]; ent.k = k; st.tags[k] = ent; if (st.sim) st.rec.tmoved[ent.tid] = k; }
  }
  function sArrive(st, u, depth = 0) {
    if (!u || u.uid === undefined || u.hp <= 0) return;
    const t = st.tags[u.pos];
    if (t && t.collectible && t.hp <= 0) {
      delete st.tags[u.pos];
      if (!st.sim) floater(u.pos, t.icon + ' ' + t.name, '#a8e05f');
      if (t.onPickup) { if (!st.sim) blog(u.name + ' picks up ' + t.name); const ab = abById(t.onPickup); if (ab) resolveCast(st, { pos: u.pos, name: t.name }, ab, u.pos, depth + 1); }
    }
  }
  function sPush(st, ent, dir, depth = 0) {
    if (depth > 8) return;
    const isU = ent.uid !== undefined;
    if (isU && ent.hp > 0) {
      const c = st.csr;
      const hostile = !c || c.isEnemy === undefined || c.isEnemy !== ent.isEnemy;
      if (hostile && (ent.shield || (st.shieldUsed && st.shieldUsed.has(ent.uid)))) {
        if (ent.shield) { ent.shield = false; if (st.shieldUsed) st.shieldUsed.add(ent.uid); }
        if (!st.sim) { floater(ent.pos, 'SHIELD', '#5fc7e0'); blog((st.atk ? st.atk + ' -> ' : '') + ent.name + ': push blocked by shield'); }
        return;
      }
    }
    const k = isU ? ent.pos : ent.k;
    const nk = addK(k, DIRS[dir]);
    if (isVoid(nk)) { sVoid(st, ent); return; }
    const wall = !tilePass(nk) || (stH(st, nk) - stH(st, k) >= 2);
    if (wall) { sHit(st, ent, 2, 'crash'); return; }
    const occ = sUnitAt(st, nk) || sBarrier(st, nk);
    const drop = stH(st, k) - stH(st, nk);
    if (occ) {
      if (drop >= 2) {
        sHit(st, occ, 2, 'crush'); sStun(st, occ);
        const saved = occ.uid !== undefined && st.shieldUsed && st.shieldUsed.has(occ.uid);
        if (occ.hp > 0 && !saved) {
          const nk2 = addK(nk, DIRS[dir]);
          const room = isVoid(nk2) || (tilePass(nk2) && (stH(st, nk2) - stH(st, nk) < 2) && !sUnitAt(st, nk2) && !sBarrier(st, nk2));
          if (room) sPush(st, occ, dir, depth + 1);
          else if (occ.uid !== undefined) {
            if (st.sim) { st.rec.dmg[occ.uid] = (st.rec.dmg[occ.uid] || 0) + occ.hp; st.rec.killed[occ.uid] = 1; }
            else { floater(nk, 'CRUSHED', '#ff5d73'); blog(occ.name + ' is crushed flat'); }
            occ.hp = 0;
          } else sHit(st, occ, 999, '');
        }
        const blocked = sUnitAt(st, nk) || sBarrier(st, nk);
        if (blocked) {
          sHit(st, ent, 2, 'crash');
        } else if (ent.hp > 0) {
          sMoveTo(st, ent, nk);
          sHit(st, ent, 2, 'fall'); sStun(st, ent);
          if (isU) sArrive(st, ent, depth);
        }
      } else {
        sHit(st, ent, 2, 'crash'); sHit(st, occ, 2, 'crash');
      }
    } else {
      sMoveTo(st, ent, nk);
      if (drop >= 2) { sHit(st, ent, 2, 'fall'); sStun(st, ent); }
      if (isU && ent.hp > 0) sArrive(st, ent, depth);
    }
  }
  function sPushCorpse(st, ent, dir) {
    const k = ent.pos, nk = addK(k, DIRS[dir]);
    if (!tilePass(nk) || (stH(st, nk) - stH(st, k) >= 2)) return;
    const occ = sUnitAt(st, nk) || sBarrier(st, nk);
    if (occ) sHit(st, occ, 2, 'crash');
  }
  function flushDeaths(st, depth = 0) {
    let guard = 0;
    while (st.deathQueue.length && guard++ < 24) {
      const d = st.deathQueue.shift();
      const ab = abById(d.abId);
      if (ab) resolveCast(st, { pos: d.k, name: d.name }, ab, d.k, depth + 1);
    }
  }

  // The cast pipeline: damage/heal/status -> pushes -> heights -> tags -> spawns -> dash.
  function resolveCast(st, caster, ab, targetK, depth = 0) {
    if (!ab || depth > 6) return;
    const prevAtk = st.atk, prevCsr = st.csr, prevSU = st.shieldUsed;
    st.csr = caster; st.shieldUsed = new Set();
    if (caster.name) st.atk = caster.name;
    if (!st.sim && caster.name) blog(caster.name + ' casts ' + ab.name);
    const rk = abRotFor(ab, caster.pos, targetK);
    const preAlive = new Set();
    for (const u of st.units) if (u.hp > 0) preAlive.add(u.uid);
    // 1 - damage / heal / statuses
    const critAll = caster.critBuff && ab.damage > 0;
    if (critAll) caster.critBuff = false;
    for (const off of ab.dmgZone) {
      const dt = addK(targetK, rotOff(off, rk)); if (!tilePass(dt)) continue;
      const u = sUnitAt(st, dt), bt = sBarrier(st, dt);
      const tgt = u || bt;
      if (!tgt) { if (!st.sim) floater(dt, '✸', ab.color); continue; }
      if (ab.damage > 0) {
        let dmg = Math.max(0, ab.damage + powBonus(caster) + dmgMod(caster)), lbl = '';
        if (u) {
          const hd = stH(st, caster.pos) - stH(st, dt);
          if (hd >= 2 && CFG.highBonus > 0) { dmg += CFG.highBonus; lbl = 'HIGH'; }
          else if (hd <= -2 && CFG.lowPenalty > 0) { dmg = Math.max(0, dmg - CFG.lowPenalty); lbl = 'LOW'; }
          if (critAll) { dmg *= 2; lbl = (lbl ? lbl + ' ' : '') + 'CRIT'; }
        }
        if (dmg > 0) sHit(st, tgt, dmg, lbl, '✸ ');
        else if (!st.sim) floater(dt, '✸ 0 ' + lbl, '#9aa7bd');
      } else if (!st.sim) floater(dt, '✸', ab.color);
      if (u && u.hp > 0) {
        if (ab.heal > 0) sHeal(st, u, ab.heal);
        if (ab.buff === 'shield') { u.shield = true; if (!st.sim) floater(dt, '🛡', '#5fc7e0'); }
        if (ab.buff === 'crit') { u.critBuff = true; if (!st.sim) floater(dt, '⚡', '#ffd75f'); }
        if (ab.buff === 'stun') sStun(st, u);
        if (ab.buff === 'haste') {
          const dx = Math.max(-99, Math.min(99, Math.round(+ab.buffX || 0)));
          if (dx) { u.haste = dx; if (!st.sim) floater(dt, (dx > 0 ? '💨 +' : '🐌 ') + dx, dx > 0 ? '#a8e05f' : '#c9a8ff'); }
        }
      }
    }
    flushDeaths(st, depth);
    // 2 - pushes, in waves (see hex-box for the full commentary)
    const shoves = [];
    for (const o of ab.pushZone) {
      const dt = addK(targetK, rotOff([o[0], o[1]], rk)); if (!tilePass(dt)) continue;
      const rd = rotDir(o[2], rk);
      const dist = (o[3] || 1) >= 2 ? 2 : 1;
      const u = sUnitAt(st, dt);
      if (u) { shoves.push({ ent: u, dir: rd, dist }); continue; }
      const corpse = st.units.find((x) => x.hp <= 0 && x.pos === dt && preAlive.has(x.uid));
      if (corpse) { sPushCorpse(st, corpse, rd); continue; }
      const t = st.tags[dt]; if (t && t.hp > 0 && t.pushable) shoves.push({ ent: t, dir: rd, dist });
    }
    const maxDist = shoves.reduce((m, s) => Math.max(m, s.dist), 0);
    const posOf = (e) => (e.uid !== undefined ? e.pos : e.k);
    const stepOne = (s) => {
      s.pending = false;
      if (s.ent.hp <= 0) { s.stopped = true; return; }
      const from = posOf(s.ent);
      sPush(st, s.ent, s.dir, depth);
      if (posOf(s.ent) === from) s.stopped = true;
    };
    for (let step = 0; step < maxDist; step++) {
      const wave = shoves.filter((s) => !s.stopped && s.dist > step);
      for (const s of wave) s.pending = true;
      let guard = 0;
      while (wave.some((s) => s.pending)) {
        let moved = false;
        for (const s of wave) {
          if (!s.pending) continue;
          const nk = addK(posOf(s.ent), DIRS[s.dir]);
          if (wave.some((o) => o !== s && o.pending && o.ent.hp > 0 && posOf(o.ent) === nk)) continue;
          stepOne(s); moved = true;
        }
        if (!moved || guard++ > wave.length + 2) for (const s of wave) if (s.pending) stepOne(s);
      }
    }
    flushDeaths(st, depth);
    // 3 - height changes (units on the tile are unaffected)
    for (const o of ab.hZone) {
      const dt = addK(targetK, rotOff([o[0], o[1]], rk)); if (!tilePass(dt)) continue;
      const h0 = st.heights[dt] ?? 0;
      st.heights[dt] = Math.max(0, Math.min(CFG.elevationLevels, ab.hMode === 'abs' ? o[2] : h0 + o[2]));
    }
    // 4 - tag placement
    if (ab.tagId) {
      const d = tagDefById(ab.tagId);
      if (d) for (const off of ab.tagZone) {
        const dt = addK(targetK, rotOff(off, rk)); if (!tilePass(dt)) continue;
        if (d.hp > 0 && (sUnitAt(st, dt) || sBarrier(st, dt))) continue;
        st.tags[dt] = tagInst(d, ab.tagId, dt);
        if (d.collectible && d.hp <= 0) { const u = sUnitAt(st, dt); if (u) sArrive(st, u, depth); }
      }
    }
    flushDeaths(st, depth);
    // 5 - spawns: none in the starter content (spawnId is unused); the hook stays
    //     for when summoning abilities come over from hex-box.
    // 6 - caster dash / teleport to the aimed tile
    if (ab.moveToTarget && caster.uid !== undefined && caster.hp > 0 && caster.pos !== targetK
        && tilePass(targetK) && !sUnitAt(st, targetK) && !sBarrier(st, targetK)) {
      sMoveTo(st, caster, targetK);
      if (!st.sim) { floater(targetK, '⤳', '#5fc7e0'); blog(caster.name + ' moves to the target'); }
      sArrive(st, caster, depth);
      flushDeaths(st, depth);
    }
    st.atk = prevAtk; st.csr = prevCsr; st.shieldUsed = prevSU;
  }

  // ----- per-activation terrain tag tick ---------------------------------
  function tagTick(u) {
    const t = sb.tags[u.pos];
    if (!t || t.hp > 0) return;
    const st = liveSt();
    if (t.dmg > 0) sHit(st, u, t.dmg, t.name);
    if (t.heal > 0 && u.hp > 0) { st.atk = t.name; sHeal(st, u, t.heal); st.atk = null; }
    flushDeaths(st);
  }

  // ----- movement (hex-box 12) -------------------------------------------
  // `fromK` lets the player phase measure range from the tile a unit STARTED
  // the round on (free repositioning); enemies always measure from where they are.
  function reach(u, fromK = u.pos) {
    const hard = new Set(), soft = new Set();
    for (const o of sb.units) { if (o.hp <= 0 || o === u) continue; ((!u.flying && o.isEnemy !== u.isEnemy) ? hard : soft).add(o.pos); }
    for (const k in sb.tags) { if (sb.tags[k].hp > 0) (u.flying ? soft : hard).add(k); }
    const spd = effSpeed(u);
    const d = { [fromK]: 0 }, prev = {};
    const pq = [[0, fromK]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]); const [dd, k] = pq.shift();
      if (dd > d[k]) continue;
      for (const dir of DIRS) {
        const nk = addK(k, dir);
        if (!tilePass(nk) || hard.has(nk)) continue;
        const dh = sbH(nk) - sbH(k);
        if (!u.flying && Math.abs(dh) > 1) continue;
        const nd = dd + (u.flying ? 1 : (dh > 0 ? 2 : 1));
        if (nd > spd) continue;
        if (nd < (d[nk] ?? 1e9)) { d[nk] = nd; prev[nk] = k; pq.push([nd, nk]); }
      }
    }
    return { d, prev, occ: soft };
  }
  const canStop = (res, k) => res.d[k] !== undefined && !res.occ.has(k);
  function approachField(u) {
    const hard = new Set();
    if (!u.flying) for (const k in sb.tags) if (sb.tags[k].hp > 0) hard.add(k);
    const d = {}, pq = [];
    for (const p of alive(false)) { d[p.pos] = 0; pq.push([0, p.pos]); }
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]); const [dd, k] = pq.shift();
      if (dd > d[k]) continue;
      for (const dir of DIRS) {
        const nk = addK(k, dir);
        if (!tilePass(nk) || hard.has(nk)) continue;
        const dh = sbH(k) - sbH(nk);
        if (!u.flying && Math.abs(dh) > 1) continue;
        const nd = dd + (u.flying ? 1 : (dh > 0 ? 2 : 1));
        if (nd < (d[nk] ?? 1e9)) { d[nk] = nd; pq.push([nd, nk]); }
      }
    }
    return d;
  }
  function pathTo(res, startK, destK) {
    const p = [destK]; let k = destK;
    while (k !== startK) { k = res.prev[k]; if (!k) return null; p.unshift(k); }
    return p;
  }
  // A collectible flagged "trigger on pass" fires the instant a walking unit enters.
  function passTrap(u, k) {
    if (!u || u.hp <= 0) return true;
    if (u.flying) return false;
    const t = sb.tags[k];
    if (!t || !t.collectible || !t.passPickup || t.hp > 0) return false;
    const st = liveSt(); sArrive(st, u); flushDeaths(st);
    emit();
    return u.hp <= 0 || u.stunned || u.pos !== k;
  }
  // Hands the walk to the view: it animates and reports each tile entered.
  function animateMove(u, path, done) {
    if (!path || path.length < 2) { if (path && path.length) u.pos = path[path.length - 1]; done && done(); return; }
    // Haste burns on a real move - but only for enemies: the player repositions
    // freely, so their haste holds until the phase ends.
    if (u.isEnemy && u.haste) u.haste = 0;
    sb.busy = true;
    const anim = {
      u, path: u.flying ? [path[0], path[path.length - 1]] : path, fly: u.flying,
      enter: (k) => { u.pos = k; return passTrap(u, k); },   // true = stop the walk here
    };
    if (onAnim) onAnim(anim, () => done && done());
    else { u.pos = path[path.length - 1]; done && done(); }   // headless fallback (tests)
  }

  // ----- aiming ----------------------------------------------------------
  function dashOk(u, k) {
    if (!tilePass(k)) return false;
    const o = unitAt(k);
    if (o && o.uid !== u.uid) return false;
    const t = sb.tags[k];
    return !(t && t.hp > 0);
  }
  function buildAim(c, ab) {
    const targets = new Set();
    const anchors = new Set();
    const ok = (k) => !ab.moveToTarget || dashOk(c, k);
    if (ab.castAny) for (const t of activeTiles()) { if (!ok(t)) continue; targets.add(t); anchors.add(t); }
    else for (const off of ab.castZone) {
      const t = addK(c.pos, off);
      if (!inMap(t) || !ok(t)) continue;
      anchors.add(t);
      if (tilePass(t)) targets.add(t);
    }
    const map = {};
    for (const t of targets) map[t] = t;
    if (ab.rotatable) {
      for (const t of anchors) {
        const rk = abRotFor(ab, c.pos, t);
        for (const off of ab.dmgZone) {
          const dt = addK(t, rotOff(off, rk));
          if (!tilePass(dt) || targets.has(dt)) continue;
          const cur = map[dt];
          if (cur === undefined) map[dt] = t;
          else if (hexDist(dt, t) < hexDist(dt, cur)) map[dt] = t;
        }
      }
    }
    return map;
  }

  // ----- turn flow (hex-box 11, reworked player phase) ---------------------
  // The player phase is ONE simultaneous turn: any unit can be selected and
  // repositioned FREELY within its range (always measured from the tile it
  // started the round on, so a move can be taken back) until an ability is
  // cast. A cast commits the turn so far: the caster is finished, and every
  // unit standing away from its starting tile is locked in place. The phase
  // ends when every living unit has cast - or on End turn, which ends it for
  // the whole party at once.
  function startPlayerPhase() {
    blog('- ROUND ' + sb.round + ' -');
    sb.phase = 'player'; sb.selAb = null; sb.aimMap = null; sb.activeUid = null;
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) {
      u.done = false; u.moveLocked = false; u.startPos = u.pos; u.tagTicked = false;
    }
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) { u.tagTicked = true; tagTick(u); }
    if (checkEnd()) return;
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0 && u.stunned) {
      u.stunned = false; u.done = true; floater(u.pos, 'STUNNED', '#c9a8ff');
    }
    const first = sb.units.find((u) => !u.isEnemy && u.hp > 0 && !u.done);
    if (first) select(first); else { emit(); startEnemyPhase(); }
  }
  function refreshReach() {
    const c = curP();
    sb.reach = (c && !c.done && !c.moveLocked) ? reach(c, c.startPos) : null;
  }
  function select(u) {
    if (sb.over) return;
    sb.activeUid = u.uid; sb.selAb = null; sb.aimMap = null;
    refreshReach();
    emit();
  }
  // Runs after a unit's cast resolves: lock strayed units, finish the caster,
  // hand selection over - or end the phase if everyone has now acted.
  function afterCast(c) {
    c.done = true;
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0 && u.pos !== u.startPos) u.moveLocked = true;
    sb.selAb = null; sb.aimMap = null; sb.reach = null;
    if (sb.over) return;
    const next = sb.units.find((x) => !x.isEnemy && x.hp > 0 && !x.done);
    if (next) select(next);
    else { sb.activeUid = null; emit(); startEnemyPhase(); }
  }
  // A unit that can no longer act (killed or stunned by a trap mid-walk).
  function retireUnit(u) {
    if (u.stunned) u.stunned = false;
    u.done = true;
    if (sb.over) return;
    const next = sb.units.find((x) => !x.isEnemy && x.hp > 0 && !x.done);
    if (next) select(next);
    else { sb.activeUid = null; emit(); startEnemyPhase(); }
  }
  function startEnemyPhase() {
    sb.phase = 'enemy'; sb.activeUid = null; sb.selAb = null; sb.aimMap = null; sb.reach = null;
    sb.enemyQ = sb.units.filter((u) => u.isEnemy && u.hp > 0).sort((a, b) => b.init - a.init || a.idx - b.idx);
    sb.eqi = -1; emit();
    stepEnemy();
  }
  function stepEnemy() {
    if (sb.over) return;
    sb.eqi++;
    if (sb.eqi >= sb.enemyQ.length) { endRound(); return; }
    const e = sb.enemyQ[sb.eqi];
    if (e.hp <= 0) { stepEnemy(); return; }
    sb.activeUid = e.uid; emit();
    if (e.stunned) {
      e.stunned = false; floater(e.pos, 'STUNNED', '#c9a8ff');
      sb.busy = true; setTimeout(() => { sb.busy = false; stepEnemy(); }, 650); return;
    }
    tagTick(e);
    if (checkEnd()) return;
    if (e.hp <= 0) { emit(); setTimeout(stepEnemy, 500); return; }
    sb.busy = true; setTimeout(() => aiTurn(e), 550);
  }
  function endRound() {
    sb.activeUid = null;
    // A fatigue ambush is an extra opening enemy phase: the round itself has not
    // happened yet, so no tag ticking, no expiry, no round counter.
    if (sb.ambush) { sb.ambush = false; startPlayerPhase(); return; }
    const due = [];
    for (const k of Object.keys(sb.tags)) {
      const t = sb.tags[k];
      if (!t.onPeriodic || !(t.everyX > 0)) continue;
      t.everyCd = (t.everyCd > 0 ? t.everyCd : t.everyX) - 1;
      if (t.everyCd <= 0) { t.everyCd = t.everyX; due.push({ k, tid: t.tid }); }
    }
    for (const d of due) {
      const t = sb.tags[d.k];
      if (!t || t.tid !== d.tid) continue;
      const ab = abById(t.onPeriodic);
      if (!ab) continue;
      floater(d.k, '⟳ ' + t.name, t.color);
      resolveCast(liveSt(), { pos: d.k, name: t.name }, ab, d.k, 0);
      flushDeaths(liveSt());
    }
    if (checkEnd()) return;
    const expired = [];
    for (const k of Object.keys(sb.tags)) { const t = sb.tags[k]; if (t.life > 0) { t.life--; if (t.life <= 0) expired.push(k); } }
    for (const k of expired) {
      const t = sb.tags[k]; if (!t) continue;
      delete sb.tags[k];
      floater(k, t.name + ' fades', '#7c8aa5');
      if (t.onExpire) { const ab = abById(t.onExpire); if (ab) resolveCast(liveSt(), { pos: k, name: t.name }, ab, k, 0); }
    }
    if (checkEnd()) return;
    sb.round++;
    startPlayerPhase();
  }
  function checkEnd() {
    if (sb.over) return true;
    if (!alive(true).length) { gameOver(true); return true; }
    if (!alive(false).length) { gameOver(false); return true; }
    return false;
  }
  function gameOver(won) {
    sb.over = won ? 'win' : 'lose';
    sb.selAb = null; sb.aimMap = null; sb.reach = null; sb.activeUid = null;
    emit();
    if (onEnd) onEnd(won);
  }

  // ----- enemy AI (scores full simulated outcomes) ------------------------
  function aiTurn(e) {
    if (sb.over || e.hp <= 0) { sb.busy = false; if (!sb.over) stepEnemy(); return; }
    const res = reach(e);
    let best = null;
    for (const abId of e.abilityIds) {
      const ab = abFor(e, abId); if (!ab) continue;
      if (!(ab.damage > 0 || ab.heal > 0 || ab.pushZone.length || ab.tagId || ab.hZone.length)) continue;
      for (const startK of Object.keys(res.d)) {
        if (startK !== e.pos && !canStop(res, startK)) continue;
        if (ab.castAny && startK !== e.pos) continue;
        const tlist = ab.castAny ? activeTiles() : ab.castZone.map((off) => addK(startK, off));
        for (const t of tlist) {
          if (!inMap(t)) continue;
          if (ab.moveToTarget && t !== startK && !dashOk(e, t)) continue;
          const st = simSt();
          const se = st.units.find((u) => u.uid === e.uid);
          se.pos = startK;
          resolveCast(st, se, ab, t);
          let score = 0;
          for (const u of st.units) {
            const d = st.rec.dmg[u.uid] || 0;
            if (!u.isEnemy) score += d * 10 + (st.rec.killed[u.uid] ? 45 : 0) + (st.rec.stun[u.uid] ? 12 : 0);
            else score -= d * 9 + (st.rec.killed[u.uid] ? 40 : 0) + (st.rec.stun[u.uid] ? 10 : 0);
          }
          if (score > 0 && (!best || score > best.score || (score === best.score && res.d[startK] < best.cost)))
            best = { ab, startK, t, score, cost: res.d[startK] };
        }
      }
    }
    if (best) {
      const path = pathTo(res, e.pos, best.startK) || [e.pos];
      animateMove(e, path, () => {
        sArrive(liveSt(), e); flushDeaths(liveSt());
        emit();
        setTimeout(() => {
          if (sb.over) { sb.busy = false; return; }
          if (e.hp <= 0 || e.stunned || e.pos !== best.startK) {
            if (e.hp > 0 && e.stunned) floater(e.pos, 'STUNNED', '#c9a8ff');
            emit();
            setTimeout(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 450);
            return;
          }
          resolveCast(liveSt(), e, best.ab, best.t);
          emit();
          setTimeout(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 550);
        }, 300);
      });
      return;
    }
    const players = alive(false);
    if (players.length) {
      const fld = approachField(e);
      let bestK = e.pos, bs = 1e9;
      for (const k of Object.keys(res.d)) {
        if (k !== e.pos && !canStop(res, k)) continue;
        const td = fld[k] !== undefined ? fld[k] : 1000 + Math.min(...players.map((p) => hexDist(k, p.pos)));
        const sc = td * 100 + res.d[k];
        if (sc < bs) { bs = sc; bestK = k; }
      }
      const path = pathTo(res, e.pos, bestK) || [e.pos];
      animateMove(e, path, () => {
        sArrive(liveSt(), e); flushDeaths(liveSt());
        emit();
        setTimeout(() => { sb.busy = false; if (!checkEnd()) stepEnemy(); }, 400);
      });
      return;
    }
    setTimeout(() => { sb.busy = false; stepEnemy(); }, 400);
  }

  // ----- player input (called by the view / the HUD) -----------------------
  function clickTile(k) {
    if (sb.over || sb.busy) return;
    if (sb.phase !== 'player') return;
    const c = curP(); if (!c) return;
    if (!inMap(k)) return;
    const uu = unitAt(k);
    if (!sb.selAb && uu && !uu.isEnemy && uu.uid !== c.uid && !uu.done) { select(uu); return; }
    if (sb.selAb) {
      const ab = abFor(c, sb.selAb);
      const target = ab && sb.aimMap ? sb.aimMap[k] : null;
      if (target != null) {
        sb.busy = true;
        sb.selAb = null; sb.aimMap = null;
        resolveCast(liveSt(), c, ab, target);
        emit();
        setTimeout(() => {
          sb.busy = false;
          if (checkEnd()) return;
          afterCast(c);   // casting finishes the unit and locks strayed positions
        }, 480);
      } else { sb.selAb = null; sb.aimMap = null; emit(); }
      return;
    }
    // Free repositioning: range is measured from the round's starting tile, so
    // clicking again simply picks a different spot (the old move is taken back).
    if (!c.done && !c.moveLocked) {
      const res = sb.reach ?? reach(c, c.startPos);
      if (k !== c.pos && canStop(res, k)) {
        const path = pathTo(res, c.startPos, k);
        if (!path) return;
        sb.reach = null;
        animateMove(c, path, () => {
          sb.busy = false;
          sArrive(liveSt(), c); flushDeaths(liveSt());
          if (checkEnd()) return;
          if (c.hp <= 0 || c.stunned) { retireUnit(c); return; }
          refreshReach();
          emit();
        });
        emit();
      }
    }
  }
  function selectAbility(abId) {
    if (sb.over || sb.busy || sb.phase !== 'player') return;
    const c = curP(); if (!c) return;
    if (sb.selAb === abId) { sb.selAb = null; sb.aimMap = null; }
    else {
      const ab = abFor(c, abId);
      if (!ab || !c.abilityIds.includes(abId)) return;
      sb.selAb = abId; sb.aimMap = buildAim(c, ab);
    }
    emit();
  }
  // Ends the WHOLE party's turn at once.
  function endTurn() {
    if (sb.phase !== 'player' || sb.busy || sb.over) return;
    for (const u of sb.units) if (!u.isEnemy && u.hp > 0) u.done = true;
    sb.activeUid = null; sb.selAb = null; sb.aimMap = null; sb.reach = null;
    emit();
    startEnemyPhase();
  }

  // Test / debug helper: decide the battle instantly.
  function debugResolve(won) {
    if (sb.over) return;
    for (const u of sb.units) if (u.isEnemy === !!won) u.hp = 0;
    checkEnd();
  }

  // ----- go ---------------------------------------------------------------
  {
    // Units standing on collectibles grab them at battle start (hex-box parity).
    const st = liveSt();
    for (const u of sb.units) if (u.hp > 0) sArrive(st, u);
    flushDeaths(st);
  }
  // The fight is BUILT above and OPENED here. The two are separable because the
  // caller may want to build it behind a transition (so the HUD is already the
  // battle's when the clouds part) but not let a fatigue ambush swing at the
  // party while the screen is still covered: `deferOpening` holds the opening
  // enemy phase back until start() is called. A normal fight opens with
  // startPlayerPhase(), which animates nothing, so it never needs deferring.
  let opened = false;
  function start() {
    if (opened) return;
    opened = true;
    if (sb.ambush) { blog('AMBUSH - the enemy strikes first'); startEnemyPhase(); }
    else startPlayerPhase();
  }
  if (deferOpening && sb.ambush) emit();   // the bar reads "enemy phase" while it waits
  else start();

  return {
    state: sb,
    start,
    clickTile, selectAbility, endTurn, activate: (uid) => { const u = sb.units.find((x) => x.uid === uid && !x.isEnemy && x.hp > 0 && !x.done); if (u && sb.phase === 'player' && !sb.busy) select(u); },
    abilityById: abById,
    abilityFor: abFor,   // (unit, id) - the unit's UPGRADED def where it has one
    curPlayer: curP,
    reachFor: () => sb.reach,
    debugResolve,
  };
}
