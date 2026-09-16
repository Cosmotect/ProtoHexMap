// =====================================================================
//  HACK ENCOUNTER - the rules.               *** EXPERIMENT (see DESIGN.md) ***
//
//  What is left of the hack once aim locks, simultaneous firing, stacking and
//  the damage pre-calculation moved into the combat engine (2026-09-15): the
//  NODES, the MINES, the PROGRESS BAR and the turn budget. They plug into the
//  engine as a `rules` object (createBattle's option of that name) - a handful
//  of hooks the engine calls without knowing what they are for:
//    onBarrierHit(st, tag, dealt, over, caster, k)  a barrier lost hp
//    onHazardHit(st, tag, caster, k, ab)             a hazard tag was under a hex
//    onTurnFired(sb, summary)                         the party's locks all fired
//    checkEnd(sb) -> 'win' | 'lose' | null            replaces last-side-standing
//    decoratePreview(entry, sb)                       a note on a billboard
//    debugResolve(sb, won)                            the menu's instant win
//  Nodes are ordinary BARRIER tags (hp > 0: they block walking, ordinary
//  damage wears them down); mines are ordinary HAZARD tags (hp 0, walkable,
//  ticking nothing). Both are injected into the engine's tag table by the
//  bridge, so the engine needs no node or mine of its own.
//
//    * A node hit fills the bar by the hp actually removed; OVERKILL (the part
//      past its hp) follows H.overkill: 'hurts' drains the bar, 'wasted' does
//      nothing, 'counts' fills it.
//    * A mine under any hex of any fired ability drains the bar by minePenalty
//      and costs the caster mineDamage hp (never below 1 unless mineLethal);
//      with mineDetonates the mine is gone once the volley has landed.
//    * +progressMax wins, -progressMax loses, and so does the turn budget
//      running out (the last turn's volley fired without reaching the top).
// =====================================================================

export function createHackRules(H, { onFloater } = {}) {
  let sb = null;
  const floater = (k, text, color) => onFloater && onFloater(k, text, color);
  const x = () => sb.ext.hack;
  const clamp = (v) => Math.max(-H.progressMax, Math.min(H.progressMax, v));

  const rules = {
    // Called by the bridge once the engine exists: the rules' own state lives
    // on the engine's state (sb.ext.hack), where the view can read it.
    attach(state) {
      sb = state;
      sb.ext.hack = {
        progress: 0, turns: H.turns,
        lastTurn: null,          // { round, gained, lost, overkill } of the volley just fired
        lostBy: null,            // 'mines' | 'turns' once the hack failed
        firedRound: 0,           // the round whose volley fired last
        turnGained: 0, turnLost: 0, turnOverkill: 0,
      };
    },
    onBarrierHit(st, tag, dealt, over, caster, k) {
      if (tag.defId !== 'node' || !sb) return;
      const h = x();
      h.turnGained += H.overkill === 'counts' ? dealt + over : dealt;
      if (over > 0) {
        if (H.overkill === 'hurts') { h.turnLost += over; h.turnOverkill += over; floater(k, `⚠ overkill -${over}`, '#ff5d73'); }
        else if (H.overkill === 'wasted') floater(k, `overkill ${over}`, '#9aa7bd');
      }
      h.progress = clamp(h.progress + (H.overkill === 'counts' ? dealt + over : dealt) - (H.overkill === 'hurts' ? over : 0));
    },
    onHazardHit(st, tag, caster, k, ab) {
      if (tag.defId !== 'mine' || !sb) return;
      const h = x();
      h.turnLost += H.minePenalty;
      h.progress = clamp(h.progress - H.minePenalty);
      floater(k, `💥 -${H.minePenalty}`, '#ff5d73');
      if (H.mineDamage > 0 && caster && caster.uid !== undefined && caster.hp > 0) {
        caster.hp = Math.max(H.mineLethal ? 0 : 1, caster.hp - H.mineDamage);
        floater(caster.pos, `-${H.mineDamage} MINE`, '#ff5d73');
      }
      // Gone once the whole volley has landed (onTurnFired), so a second
      // ability's hex on the same mine still pays for it this turn.
      if (H.mineDetonates) tag.detonated = true;
    },
    onTurnFired(state) {
      const h = x();
      h.firedRound = state.round;
      h.lastTurn = { round: state.round, gained: h.turnGained, lost: h.turnLost, overkill: h.turnOverkill };
      h.turnGained = 0; h.turnLost = 0; h.turnOverkill = 0;
      for (const k of Object.keys(state.tags)) if (state.tags[k].detonated) delete state.tags[k];
    },
    checkEnd(state) {
      const h = state.ext.hack;
      if (!h) return null;
      if (h.progress >= H.progressMax) return 'win';
      if (h.progress <= -H.progressMax) { h.lostBy = 'mines'; return 'lose'; }
      if (h.firedRound >= H.turns) { h.lostBy = 'turns'; return 'lose'; }
      return null;
    },
    // The billboard's extra segment: what the overkill does to the bar, or
    // what a mine costs.
    decoratePreview(entry) {
      const t = entry.target;
      if (!t) return;
      if (t.kind === 'barrier' && t.tagKind === 'node' && entry.over > 0) {
        entry.note = H.overkill === 'hurts' ? { text: `-${entry.over}!`, color: '#ff5d73' }
          : H.overkill === 'counts' ? { text: `+${entry.over}`, color: '#8fe0b8' }
          : { text: `(${entry.over})`, color: '#9aa7bd' };
      } else if (t.kind === 'hazard' && t.tagKind === 'mine') {
        entry.note = { text: `-${H.minePenalty * Math.max(1, entry.covers ?? 1)}`, color: '#ff5d73' };
      }
    },
    debugResolve(state, won) {
      const h = state.ext.hack;
      h.progress = won ? H.progressMax : -H.progressMax;
    },
  };
  return rules;
}

// The node / mine tag instances the bridge drops into the engine's tag table.
// Same shape the engine's own tagInst builds, so every rule that reads a tag
// (walking, sHit, the round's expiry pass) treats them as ordinary tags.
export function makeHackTags(H, nodeKeys, mineKeys) {
  const tags = {};
  let n = 1;
  const inst = (kind, k) => {
    const d = H.tags[kind];
    const hp = kind === 'node' ? H.nodeHp : 0;
    return { tid: 'h' + (n++), defId: kind, kind, k, name: d.name, icon: d.icon, color: d.color, desc: d.desc,
      dmg: 0, heal: 0, life: 0, hp, maxHp: hp,
      pushable: false, collectible: false, passPickup: false,
      onDestroy: null, onExpire: null, onPickup: null, onPeriodic: null,
      everyX: 0, everyOff: 0, everyCd: 0 };
  };
  for (const k of nodeKeys) tags[k] = inst('node', k);
  for (const k of mineKeys) if (!tags[k]) tags[k] = inst('mine', k);
  return tags;
}
