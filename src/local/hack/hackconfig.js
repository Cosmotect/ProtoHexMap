// =====================================================================
//  HACK ENCOUNTER - config knobs.            *** EXPERIMENT (see DESIGN.md) ***
//
//  Every number the hack encounter reads lives HERE, not in src/config*.js,
//  so the experiment can be tuned - or ripped out - without touching the
//  shared config. Nothing outside src/local/hack/ imports this file.
//
//  The idea in one line: the party's abilities are hex PATTERNS; the board is
//  a flat grid of NODES (static targets with hp) and MINES; every unit aims
//  its ability, and on End turn all aims fire at once - a tile covered by two
//  abilities takes double damage, by three triple. Damage dealt to nodes fills
//  the HACK PROGRESS bar; a hex landing on a mine drains it (and hurts the
//  unit). Fill the bar within the turn budget to win.
//  The aim-lock volley and the stacking are the COMBAT ENGINE's now
//  (config.combat.lockedAim / combat.stack, since 2026-09-15); what stays
//  here is the board, the nodes, the mines and the bar.
// =====================================================================

export const HACK_CONFIG = {
  // ----- the board ---------------------------------------------------
  radius: 5,          // rings of local hexes (the arena is completely flat)
  nodeHp: 20,         // hp of every node
  // WHERE nodes and mines go is a LAYOUT (hacklayouts.js): twenty of them,
  // each with its own counts, spacing and party start. A terminal draws one
  // by seed. forceLayout pins one by id for playtesting ('citadel', 'veins',
  // ...); layoutPool (a list of ids) narrows the draw; null = all twenty.
  forceLayout: null,
  layoutPool: null,
  partyRingMax: 1,    // a 'centre' start seats the party at most this far from the middle

  // ----- the rules ---------------------------------------------------
  turns: 7,           // End-turn presses the player gets to fill the bar
  // (The stacking multipliers moved to config.combat.stack.multipliers - they
  // are every fight's now, not the hack's.)
  progressMax: 100,   // the bar runs -progressMax .. +progressMax, starting at 0
  // OVERKILL - damage past a node's remaining hp:
  //   'hurts'   the excess DRAINS the hack progress bar (a sloppy stack costs you)
  //   'wasted'  the excess simply does nothing
  //   'counts'  the excess fills the bar like any other damage
  overkill: 'hurts',
  minePenalty: 15,    // hack progress lost per ability hex that lands on a mine
  mineDamage: 3,      // hp the aiming unit loses per hex that lands on a mine
  mineLethal: false,  // false = mine damage never takes a unit below 1 hp
  mineDetonates: true, // true = a mine is gone once it has been hit

  // ----- presentation ------------------------------------------------
  colors: {
    node: 0x5fc7e0,          // the node column
    nodeHurt: 0xff9950,      // a node below half hp
  },
  // The two tile tags of this mode. They are NOT in COMBAT_TAGS on purpose:
  // the shared tag table stays untouched, and the hack engine resolves these
  // itself. Promote them there only if they should become usable in map codes.
  tags: {
    node: { name: 'Node', icon: '🔷', color: '#5fc7e0', desc: 'A hack target. Damage it to fill the hack progress bar.' },
    mine: { name: 'Mine', icon: '💣', color: '#ff5d73', desc: 'Every ability hex that lands here drains hack progress and hurts the caster.' },
  },
  // The Enter-key window texts (English only - an experiment carries no locale rows
  // beyond the two the world map needs to draw and name the marker).
  text: {
    title: 'Hack',
    lore: 'A dormant terminal. Its nodes answer to force - hit them in patterns, together, and stay clear of the mines.',
    wonTitle: 'Hack complete',
    wonText: 'The terminal yields. The party pulls what it can from the open nodes.',
    lostTitle: 'Hack failed',
    lostTextTurns: 'The terminal locks up before the hack completes. The party walks away with nothing.',
    lostTextMines: 'The mines tear the hack apart. The terminal goes dark for good.',
  },
};
