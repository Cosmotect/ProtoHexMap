// =====================================================================
//  HACK ENCOUNTER - the rules.               *** EXPERIMENT (see DESIGN.md) ***
//
//  A SEPARATE engine for the hack play mode. It deliberately does not
//  import the combat engine (local/battle/engine.js): the two share nothing
//  but the pure hex math (bhex.js) and the ability table, so the experiment
//  can grow, change its rules daily, or be deleted, and the fight engine
//  never notices.
//
//  DUCK-TYPED to the combat engine's public surface on purpose. The arena
//  view (LocalMapView.bindBattle / syncBattle / the aim preview) and the HUD
//  (ui.setBattleMode / updateBattle, the End turn button, the 1/2/3 hotkeys,
//  right-click cancel) only ever read `state` and call the methods listed at
//  the bottom of createHack(). Implementing that same surface is what lets
//  the hack run on the existing arena and battle bar with ZERO changes to
//  either. If the fight engine's surface grows, this file may have to follow.
//
//  The rules (v1):
//    * Player phase only - there is no enemy. Any unit can be selected and
//      repositioned freely within its speed, measured from the tile it
//      started the turn on (click elsewhere to take a move back), exactly as
//      in a fight. Nodes block walking (a flier glides over, never stops).
//    * Picking an ability and clicking a target LOCKS that unit's aim; the
//      cast does not happen yet. Re-aiming replaces the lock; walking takes
//      it back. A locked unit stays selectable.
//    * END TURN fires every lock at once. Per tile: the damage of every
//      ability covering it is summed and multiplied by multipliers[count].
//      Only dmgZone tiles count; heal / status / push / dash / height / tag
//      effects of an ability are ignored in this mode (0-damage abilities
//      cannot be locked at all).
//    * A NODE hit loses hp; the HACK PROGRESS bar rises by the hp actually
//      removed (overkill wasted unless overkillCounts). A node at 0 vanishes.
//    * A MINE hit by n hexes drains the bar by minePenalty x n and costs each
//      aiming unit mineDamage hp per hex (never below 1 hp unless mineLethal).
//      A hit mine detonates (mineDetonates).
//    * Progress starts at 0 and runs -progressMax..+progressMax. +max wins;
//      -max, or the last turn ending without it, loses.
// =====================================================================
import { DIRS, addK, hexDist, rotOff, abRotFor } from '../battle/bhex.js';
import { abilityById } from '../../config/abilities.js';
import { combatStatsFor } from '../../config/entities.js';

export function createHack({ config, hack: H, radius, heights, party, partyKeys, nodeKeys = [], mineKeys = [],
                             onChange, onFloater, onLog, onAnim, onEnd, instant = false }) {
  const CFG = config.combat;
  const R = radius;
  const wait = (fn, ms) => { if (instant) fn(); else setTimeout(fn, ms); };
  const ringOf = (k) => { const [q, r] = k.split(',').map(Number); return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)); };
  const inMap = (k) => ringOf(k) <= R;
  const tilePass = inMap;   // a flat board: no walls, no holes
  const abFor = (u, id) => (u && u.abilityDefs && u.abilityDefs[id]) || abilityById(id);
  const emit = () => onChange && onChange();
  const floater = (k, text, color) => onFloater && onFloater(k, text, color);
  const blog = (t) => onLog && onLog(t);

  // ----- state (the shape the view and the HUD read) --------------------
  const sb = {
    units: [], tags: {}, heights: { ...heights },
    round: 1, turns: H.turns, phase: 'player', activeUid: null,
    enemyQ: [], eqi: 0, selAb: null, aimMap: null, reach: null,
    inspectUid: null, inspectReach: null,
    busy: false, over: null, deathQueue: [], ambush: false, noFlee: true, deaths: [],
    // Hack-only:
    hack: true,
    progress: 0,               // -progressMax .. +progressMax
    lastTurn: null,            // { round, gained, lost } of the turn just fired
    lostBy: null,              // 'mines' | 'turns' when the hack failed
  };

  party.forEach((def, i) => {
    const cs = combatStatsFor(def.name);
    sb.units.push({
      uid: 's' + i, idx: i, name: def.name, icon: def.icon ?? null,
      init: 0, isEnemy: false, partyIndex: def.partyIndex ?? i,
      speed: def.speed ?? cs.speed, flying: !!(def.flying ?? cs.flying),
      maxHp: def.maxHp ?? def.hp, hp: def.hp,
      abilityIds: [...(def.abilityIds?.length ? def.abilityIds : cs.abilities)],
      abilityDefs: def.abilityDefs ?? null,
      status: {},               // the HUD reads a status bag; the hack applies none
      pos: partyKeys[i], startPos: partyKeys[i],
      done: false, moveLocked: false, movePaid: 0,
      // The locked aim: { abId, anchor, rk, tiles, damage } or null.
      lock: null,
    });
  });

  let tidc = 1;
  const makeTag = (kind, k) => {
    const d = H.tags[kind];
    const hp = kind === 'node' ? H.nodeHp : 0;
    return { tid: tidc++, defId: kind, kind, k, name: d.name, icon: d.icon, color: d.color, desc: d.desc,
      hp, maxHp: hp, dmg: 0, heal: 0, life: 0, pushable: false, collectible: false, passPickup: false };
  };
  for (const k of nodeKeys) if (inMap(k)) sb.tags[k] = makeTag('node', k);
  for (const k of mineKeys) if (inMap(k) && !sb.tags[k]) sb.tags[k] = makeTag('mine', k);

  // ----- small queries ---------------------------------------------------
  const sbH = (k) => sb.heights[k] ?? 0;
  const alive = () => sb.units.filter((u) => u.hp > 0);
  const unitAt = (k) => sb.units.find((u) => u.hp > 0 && u.pos === k);
  const curP = () => sb.units.find((u) => u.uid === sb.activeUid && u.hp > 0);
  const moveBudget = (u) => Math.max(0, u.speed);
  const walked = (u) => {
    if (u.pos === u.startPos) return 0;
    const res = reach(u, u.startPos);
    return res.d[u.pos] ?? hexDist(u.startPos, u.pos);
  };
  const moveLeft = (u) => Math.max(0, moveBudget(u) - walked(u));
  const costOf = () => ({ hp: 0, supplies: 0, move: 0 });   // nothing costs anything in a hack
  const shortOf = () => '';
  const lockable = (ab) => !!ab && ab.damage > 0 && Array.isArray(ab.dmgZone) && ab.dmgZone.length > 0;

  // ----- movement (the fight's own rules, minus enemies) -----------------
  function reach(u, fromK = u.pos) {
    const hard = new Set(), soft = new Set();
    for (const o of sb.units) { if (o.hp <= 0 || o === u) continue; soft.add(o.pos); }
    for (const k in sb.tags) { if (sb.tags[k].hp > 0) (u.flying ? soft : hard).add(k); }
    const spd = moveBudget(u);
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
  function pathTo(res, startK, destK) {
    const p = [destK]; let k = destK;
    while (k !== startK) { k = res.prev[k]; if (!k) return null; p.unshift(k); }
    return p;
  }
  function animateMove(u, path, done) {
    if (!path || path.length < 2) { if (path && path.length) u.pos = path[path.length - 1]; done && done(); return; }
    sb.busy = true;
    const anim = { u, path: u.flying ? [path[0], path[path.length - 1]] : path, fly: u.flying, enter: (k) => { u.pos = k; return false; } };
    if (onAnim) onAnim(anim, () => done && done());
    else { u.pos = path[path.length - 1]; done && done(); }
  }

  // ----- aiming ----------------------------------------------------------
  // Where an ability may be aimed from where the unit stands now, plus the
  // dmgZone aliases of a rotatable ability (click the tile you mean to hit and
  // the aim snaps to the castZone tile that covers it) - the fight's own rule.
  function buildAim(c, ab) {
    const targets = new Set(), anchors = new Set();
    if (ab.castAny) for (const t of Object.keys(sb.heights)) { if (!inMap(t)) continue; targets.add(t); anchors.add(t); }
    else for (const off of ab.castZone) {
      const t = addK(c.pos, off);
      if (!inMap(t)) continue;
      anchors.add(t); targets.add(t);
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
          if (cur === undefined || hexDist(dt, t) < hexDist(dt, cur)) map[dt] = t;
        }
      }
    }
    return map;
  }
  // The tiles a cast from `fromK` aimed at `anchor` would cover.
  function zoneTiles(ab, fromK, anchor) {
    const rk = abRotFor(ab, fromK, anchor);
    const out = [];
    for (const off of ab.dmgZone) {
      const dt = addK(anchor, rotOff([off[0], off[1]], rk));
      if (tilePass(dt) && !out.includes(dt)) out.push(dt);
    }
    return { rk, tiles: out };
  }
  // The view's hover preview: what the selected ability would cover if aimed
  // at tile k. Same shape the fight engine returns, so the arena paints it.
  function aimPreview(k) {
    if (!sb.selAb || !sb.aimMap || sb.aimMap[k] === undefined) return null;
    const c = curP(); if (!c) return null;
    const ab = abFor(c, sb.selAb); if (!ab) return null;
    const anchor = sb.aimMap[k];
    const { tiles } = zoneTiles(ab, c.pos, anchor);
    return { anchor, kind: 'damage', hit: tiles, tag: [], push: [], height: [], dash: null, dashShort: false };
  }

  // ----- the stacking preview --------------------------------------------
  // What every tile would take if the turn fired NOW: the locks that stand,
  // plus (optionally) the aim being hovered - which REPLACES the hovering
  // unit's own lock, since that is what clicking would do. The hack view
  // paints these numbers over the nodes and mines.
  //   returns Map<tileKey, { n, mult, raw, total, kind: 'node'|'mine'|'ground', pending }>
  function previewTotals(hoverKey = null) {
    const contrib = new Map();
    const add = (k, dmg, pending) => {
      const e = contrib.get(k) ?? { n: 0, raw: 0, pending: false };
      e.n++; e.raw += dmg; e.pending = e.pending || pending;
      contrib.set(k, e);
    };
    const c = curP();
    const hovering = hoverKey && sb.selAb && sb.aimMap && sb.aimMap[hoverKey] !== undefined && c;
    for (const u of sb.units) {
      if (u.hp <= 0 || !u.lock) continue;
      if (hovering && u.uid === c.uid) continue;   // the hover stands in for this unit's lock
      for (const t of u.lock.tiles) add(t, u.lock.damage, false);
    }
    if (hovering) {
      const ab = abFor(c, sb.selAb);
      if (ab) for (const t of zoneTiles(ab, c.pos, sb.aimMap[hoverKey]).tiles) add(t, ab.damage, true);
    }
    const out = new Map();
    for (const [k, e] of contrib) {
      const mult = multFor(e.n);
      const tag = sb.tags[k];
      out.set(k, { n: e.n, mult, raw: e.raw, total: e.raw * mult, kind: tag ? tag.kind : 'ground', pending: e.pending, tag });
    }
    return out;
  }
  const multFor = (n) => H.multipliers[Math.max(0, Math.min(n, H.multipliers.length) - 1)] ?? 1;

  // ----- turn flow -------------------------------------------------------
  function startPlayerPhase() {
    blog('- TURN ' + sb.round + ' / ' + H.turns + ' -');
    sb.phase = 'player'; sb.selAb = null; sb.aimMap = null; sb.activeUid = null;
    for (const u of sb.units) if (u.hp > 0) { u.done = false; u.moveLocked = false; u.startPos = u.pos; u.movePaid = 0; u.lock = null; }
    const first = sb.units.find((u) => u.hp > 0);
    if (first) select(first); else emit();
  }
  function refreshReach() {
    const c = curP();
    sb.reach = c ? reach(c, c.startPos) : null;
  }
  function select(u) {
    if (sb.over) return;
    sb.activeUid = u.uid; sb.selAb = null; sb.aimMap = null;
    refreshReach();
    emit();
  }
  function cancel() {
    if (sb.over || sb.busy || sb.phase !== 'player') return false;
    if (sb.selAb) { sb.selAb = null; sb.aimMap = null; emit(); return true; }
    if (sb.activeUid != null) { sb.activeUid = null; sb.reach = null; emit(); return true; }
    return false;
  }
  function lockAim(c, ab, anchor) {
    const { rk, tiles } = zoneTiles(ab, c.pos, anchor);
    c.lock = { abId: ab.id ?? sb.selAb, abName: ab.name, icon: ab.icon, anchor, rk, tiles, damage: Math.max(0, ab.damage) };
    sb.selAb = null; sb.aimMap = null;
    floater(anchor, '🔒 ' + ab.name, '#ffd166');
    blog(c.name + ' locks ' + ab.name);
    // Hand selection to the next unit that has not aimed yet; if all have,
    // stay on this one (End turn is the way forward).
    const next = sb.units.find((u) => u.hp > 0 && !u.lock);
    if (next) select(next); else { refreshReach(); emit(); }
  }

  function clickTile(k) {
    if (sb.over || sb.busy || sb.phase !== 'player') return;
    if (!inMap(k)) return;
    const uu = unitAt(k);
    const c = curP();
    if (!c) { if (uu) select(uu); return; }
    if (!sb.selAb && uu && uu.uid !== c.uid) { select(uu); return; }
    if (sb.selAb) {
      const ab = abFor(c, sb.selAb);
      const target = ab && sb.aimMap ? sb.aimMap[k] : null;
      if (target != null) lockAim(c, ab, target);
      else { sb.selAb = null; sb.aimMap = null; emit(); }
      return;
    }
    // Free repositioning from the turn's starting tile. A walk takes the
    // unit's aim back: the pattern was measured from where it stood.
    const res = sb.reach ?? reach(c, c.startPos);
    if (k !== c.pos && canStop(res, k)) {
      const path = pathTo(res, c.startPos, k);
      if (!path) return;
      sb.reach = null;
      if (c.lock) { c.lock = null; blog(c.name + ' takes the aim back'); }
      animateMove(c, path, () => {
        sb.busy = false;
        refreshReach();
        emit();
      });
      emit();
    }
  }
  function selectAbility(abId) {
    if (sb.over || sb.busy || sb.phase !== 'player') return;
    const c = curP(); if (!c) return;
    if (sb.selAb === abId) { sb.selAb = null; sb.aimMap = null; }
    else {
      const ab = abFor(c, abId);
      if (!ab || !c.abilityIds.includes(abId)) return;
      if (!lockable(ab)) { floater(c.pos, 'no damage - cannot hack', '#9aa7bd'); emit(); return; }
      sb.selAb = abId; sb.aimMap = buildAim(c, ab);
    }
    emit();
  }

  // END TURN: every lock fires at once.
  function endTurn() {
    if (sb.phase !== 'player' || sb.busy || sb.over) return;
    sb.busy = true; sb.selAb = null; sb.aimMap = null; sb.reach = null;
    const contrib = new Map();
    for (const u of sb.units) {
      if (u.hp <= 0 || !u.lock) continue;
      for (const t of u.lock.tiles) (contrib.get(t) ?? contrib.set(t, []).get(t)).push({ u, dmg: u.lock.damage });
    }
    let gained = 0, lost = 0;
    const max = H.progressMax;
    for (const [k, list] of contrib) {
      const n = list.length, mult = multFor(n);
      const raw = list.reduce((s, c) => s + c.dmg, 0);
      const total = raw * mult;
      const tag = sb.tags[k];
      if (tag && tag.kind === 'node') {
        const dealt = H.overkillCounts ? total : Math.min(total, tag.hp);
        tag.hp = Math.max(0, tag.hp - total);
        gained += dealt;
        floater(k, `-${total}${mult > 1 ? ` x${mult}` : ''}`, '#ffd75f');
        blog(`${tag.name} ${k}: -${total} (${n} abilit${n === 1 ? 'y' : 'ies'} x${mult})`);
        if (tag.hp <= 0) { delete sb.tags[k]; floater(k, '✸ node down', '#ff9950'); blog('Node ' + k + ' is down'); }
      } else if (tag && tag.kind === 'mine') {
        for (const c of list) {
          lost += H.minePenalty;
          if (H.mineDamage > 0) {
            c.u.hp = Math.max(H.mineLethal ? 0 : 1, c.u.hp - H.mineDamage);
            floater(c.u.pos, `-${H.mineDamage} MINE`, '#ff5d73');
          }
        }
        floater(k, `💥 -${H.minePenalty * n}`, '#ff5d73');
        blog(`Mine ${k} hit by ${n} hex${n === 1 ? '' : 'es'}: -${H.minePenalty * n} progress`);
        if (H.mineDetonates) delete sb.tags[k];
      } else floater(k, '✸', '#9aa7bd');
    }
    sb.progress = Math.max(-max, Math.min(max, sb.progress + gained - lost));
    sb.lastTurn = { round: sb.round, gained, lost };
    for (const u of sb.units) { u.lock = null; u.done = true; }
    sb.activeUid = null;
    emit();
    wait(() => {
      sb.busy = false;
      if (sb.progress >= max) { gameOver(true); return; }
      if (sb.progress <= -max) { sb.lostBy = 'mines'; gameOver(false); return; }
      if (sb.round >= H.turns) { sb.lostBy = 'turns'; gameOver(false); return; }
      sb.round++;
      startPlayerPhase();
    }, 900);
  }
  function gameOver(won) {
    sb.over = won ? 'win' : 'lose';
    sb.selAb = null; sb.aimMap = null; sb.reach = null; sb.activeUid = null;
    for (const u of sb.units) u.lock = null;
    blog(won ? 'HACK COMPLETE' : 'HACK FAILED');
    emit();
    if (onEnd) onEnd(won);
  }
  function debugResolve(won) {
    if (sb.over) return;
    sb.progress = won ? H.progressMax : -H.progressMax;
    if (!won) sb.lostBy = 'mines';
    gameOver(won);
  }

  let opened = false;
  function start() {
    if (opened) return;
    opened = true;
    startPlayerPhase();
  }

  return {
    state: sb,
    start,
    clickTile, selectAbility, endTurn, cancel,
    inspect: () => {},                       // nothing to inspect: there is no enemy
    activate: (uid) => { const u = sb.units.find((x) => x.uid === uid && x.hp > 0); if (u && sb.phase === 'player' && !sb.busy) select(u); },
    abilityById,
    aimPreview,
    abilityFor: abFor,
    costOf, shortOf, moveBudget, moveLeft,
    supplies: () => null,                    // no supply pool in the bar
    curPlayer: curP,
    reachFor: () => sb.reach,
    debugResolve,
    // ----- hack-only ------------------------------------------------
    hackConfig: H,
    previewTotals,
    lockedUnits: () => sb.units.filter((u) => u.hp > 0 && u.lock),
    lockable: (u, id) => lockable(abFor(u, id)),
  };
}
