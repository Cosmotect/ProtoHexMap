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
// =====================================================================

export const HACK_CONFIG = {
  // ----- the board ---------------------------------------------------
  radius: 5,          // rings of local hexes (the arena is completely flat)
  nodes: 9,           // how many nodes are strewn about
  nodePairs: 3,       // of those, how many are placed ADJACENT to another node
                      // (so a 3-hex pattern can cover two nodes at once)
  nodeHp: 20,         // hp of every node
  mines: 6,           // how many mines
  minesNearNodes: true, // true = every mine is dropped next to a node (it guards it);
                        // false = anywhere on the board
  partyRingMax: 1,    // the party starts clustered around the centre, at most this far from it

  // ----- the rules ---------------------------------------------------
  turns: 7,           // End-turn presses the player gets to fill the bar
  multipliers: [1, 2, 3],   // damage multiplier by how many abilities cover a tile
                            // (1 ability x1, 2 abilities x2, 3+ x3 - the last entry repeats)
  progressMax: 100,   // the bar runs -progressMax .. +progressMax, starting at 0
  overkillCounts: false,    // false = damage past a node's remaining hp is wasted
                            // (finishing a node with the exact stack is a real decision)
  minePenalty: 15,    // hack progress lost per ability hex that lands on a mine
  mineDamage: 3,      // hp the aiming unit loses per hex that lands on a mine
  mineLethal: false,  // false = mine damage never takes a unit below 1 hp
  mineDetonates: true, // true = a mine is gone once it has been hit

  // ----- presentation ------------------------------------------------
  colors: {
    node: 0x5fc7e0,          // the node column
    nodeHurt: 0xff9950,      // a node below half hp
    // One colour per party slot: each unit's locked aim is painted in its own colour.
    locks: [0xffd166, 0x8fe0b8, 0xc66dff, 0xff9f43, 0x5fc7e0],
    previewText: '#ffd75f',  // the damage number over a targeted node
    mineText: '#ff5d73',     // the penalty number over a targeted mine
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
