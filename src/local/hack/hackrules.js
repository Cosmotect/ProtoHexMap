// =====================================================================
//  HACK ENCOUNTER - the rules.               *** EXPERIMENT (see DESIGN.md) ***
//
//  What is left of the hack once aim locks, simultaneous firing, stacking and
//  the damage pre-calculation moved into the combat engine (2026-09-15): the
//  NODES, the MINES, the TURN BUDGET and the BADGE GRADING (2026-09-19). They
//  plug into the engine as a `rules` object (createBattle's option of that
//  name) - a handful of hooks the engine calls without knowing what they mean:
//    attach(sb)                                       the state, before play
//    onBarrierHit(st, tag, dealt, over, caster, k)    a barrier lost hp
//    onHazardHit(st, tag, caster, k, ab)              a hazard tag was under a hex
//    onTurnFired(sb, summary)                         the party's locks all fired
//    checkEnd(sb) -> 'win' | 'lose' | null            replaces last-side-standing
//    decoratePreview(entry, sb)                       a note on a billboard
//    debugResolve(sb, won)                            the menu's instant win
//  Nodes are ordinary BARRIER tags (hp > 0: they block walking, ordinary
//  damage wears them down); mines are ordinary HAZARD tags (hp 0, walkable,
//  ticking nothing). Both are injected into the engine's tag table by the
//  bridge, so the engine needs no node or mine of its own.
//
//    * Every node brought to 0 hp counts as CLEARED. The badges (H.badges,
//      e.g. [4, 5, 6]) light up as the cleared count reaches each threshold.
//    * A mine under any hex of any fired ability costs the caster mineDamage
//      hp (never below 1 unless mineLethal); with mineDetonates the mine is
//      gone once the volley has landed.
//    * The encounter ends by itself after the H.turns-th volley: a WIN with
//      as many reward options as badges earned, a LOSS (no reward) with none.
//      Clearing every node on the board ends it early, as a win.
// =====================================================================

export function createHackRules(H, { onFloater } = {}) {
  let sb = null;
  const floater = (k, text, color) => onFloater && onFloater(k, text, color);
  const x = () => sb.ext.hack;
  const badgesFor = (cleared) => H.badges.filter((t) => cleared >= t).length;

  const rules = {
    // The rules' own state lives on the engine's state (sb.ext.hack), where
    // the view can read it.
    attach(state) {
      sb = state;
      sb.ext.hack = {
        turns: H.turns,
        cleared: 0,              // nodes brought down
        badges: 0,               // badges earned so far (thresholds in H.badges)
        total: 0,                // nodes the board started with (filled below)
        lastTurn: null,          // { round, cleared } of the volley just fired
        firedRound: 0,           // the round whose volley fired last
        turnCleared: 0,
      };
      sb.ext.hack.total = Object.values(sb.tags).filter((t) => t.defId === 'node').length;
    },
    onBarrierHit(st, tag, dealt, over, caster, k) {
      if (tag.defId !== 'node' || !sb || tag.hp > 0 || tag.counted) return;
      tag.counted = true;
      const h = x();
      h.cleared++; h.turnCleared++;
      const before = h.badges;
      h.badges = badgesFor(h.cleared);
      floater(k, `node ${h.cleared}${h.badges > before ? ` - badge ${h.badges}!` : ''}`, h.badges > before ? '#ffd166' : '#8fe0b8');
    },
    onHazardHit(st, tag, caster, k, ab) {
      if (tag.defId !== 'mine' || !sb) return;
      if (H.mineDamage > 0 && caster && caster.uid !== undefined && caster.hp > 0) {
        caster.hp = Math.max(H.mineLethal ? 0 : 1, caster.hp - H.mineDamage);
        floater(caster.pos, `-${H.mineDamage} MINE`, '#ff5d73');
      }
      floater(k, '💥', '#ff5d73');
      // Gone once the whole volley has landed (onTurnFired), so a second
      // ability's hex on the same mine still pays for it this turn.
      if (H.mineDetonates) tag.detonated = true;
    },
    onTurnFired(state) {
      const h = x();
      h.firedRound = state.round;
      h.lastTurn = { round: state.round, cleared: h.turnCleared };
      h.turnCleared = 0;
      for (const k of Object.keys(state.tags)) if (state.tags[k].detonated) delete state.tags[k];
    },
    checkEnd(state) {
      const h = state.ext.hack;
      if (!h) return null;
      const nodesLeft = Object.values(state.tags).some((t) => t.defId === 'node' && t.hp > 0);
      if (h.firedRound >= H.turns || (!nodesLeft && h.firedRound > 0)) return h.badges > 0 ? 'win' : 'lose';
      return null;
    },
    // The billboard's extra segment over a mine: what it costs the caster.
    decoratePreview(entry) {
      const t = entry.target;
      if (t && t.kind === 'hazard' && t.tagKind === 'mine') {
        entry.note = { text: `-${H.mineDamage * Math.max(1, entry.covers ?? 1)} hp`, color: '#ff5d73' };
      }
    },
    debugResolve(state, won) {
      const h = state.ext.hack;
      h.cleared = won ? Math.max(...H.badges) : 0;
      h.badges = badgesFor(h.cleared);
      h.firedRound = H.turns;
    },
  };
  return rules;
}

// The node / mine tag instances the bridge drops into the engine's tag table.
// Same shape the engine's own tagInst builds, so every rule that reads a tag
// (walking, sHit, the round's expiry pass) treats them as ordinary tags.
// `nodeHp` is the { key -> hp } map buildHackRecipe rolled (one seeded draw
// per node, in [nodeHpMin, nodeHpMax]); a node missing from it falls back to
// the middle of that range.
export function makeHackTags(H, nodeKeys, mineKeys, nodeHp = {}) {
  const tags = {};
  let n = 1;
  const fallbackHp = Math.round(((H.nodeHpMin ?? 20) + (H.nodeHpMax ?? 20)) / 2);
  const inst = (kind, k) => {
    const d = H.tags[kind];
    const hp = kind === 'node' ? (nodeHp[k] ?? fallbackHp) : 0;
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
