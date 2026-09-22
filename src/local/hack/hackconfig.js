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
//  abilities takes double damage, by three triple. The party has `turns`
//  volleys; the encounter ends by itself after the last. The REWARD is graded
//  by how many nodes went down: three BADGES (thresholds in `badges`) light up
//  like the stars of a mobile level, and the reward window offers as many
//  upgrade options as badges earned (one badge = take what was rolled, two =
//  choose between two, three = between three; none = no reward at all).
//  A hex landing on a mine hurts the caster.
//  The aim-lock volley and the stacking are the COMBAT ENGINE's
//  (config.combat.lockedAim / combat.stack, since 2026-09-15); what stays
//  here is the board, the nodes, the mines and the grading.
//  (Until 2026-09-19 the goal was a HACK PROGRESS bar filled by node damage
//  and drained by mines and overkill; it is gone.)
// =====================================================================

export const HACK_CONFIG = {
  // ----- the board ---------------------------------------------------
  radius: 5,          // rings of local hexes (the arena is completely flat)
  nodeHpMin: 15,       // every node's hp is drawn (seeded, per node) from this range
  nodeHpMax: 30,
  // WHERE nodes and mines go is a LAYOUT (hacklayouts.js): twenty of them,
  // each with its own counts, spacing and party start. A terminal draws one
  // by seed. forceLayout pins one by id for playtesting ('citadel', 'veins',
  // ...); layoutPool (a list of ids) narrows the draw; null = all twenty.
  forceLayout: null,
  layoutPool: null,
  partyRingMax: 1,    // a 'centre' start seats the party at most this far from the middle

  // ----- the rules ---------------------------------------------------
  turns: 5,           // End-turn volleys the player gets; the encounter ends after the last
  // The BADGES: nodes that must be down to earn each one, lowest first. The
  // count earned is the number of upgrade OPTIONS the reward window offers.
  // (Later: better upgrades should also turn up more often with more badges.)
  badges: [4, 5, 6],
  // (The stacking multipliers live in config.combat.stack.multipliers - they
  // are every fight's now, not the hack's.)
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
    node: { name: 'Node', icon: '🔷', color: '#5fc7e0', desc: 'A hack target. Bring it down; every node down counts towards the badges.' },
    mine: { name: 'Mine', icon: '💣', color: '#ff5d73', desc: 'Every ability hex that lands here hurts the caster.' },
  },
  // The Enter-key window texts (English only - an experiment carries no locale rows
  // beyond the two the world map needs to draw and name the marker).
  text: {
    title: 'Hack',
    lore: 'A dormant terminal. Its nodes answer to force - hit them in patterns, together, and stay clear of the mines. Five volleys; every node down counts.',
    wonTitle: 'Hack complete',
    wonText: '{cleared} node{s} down - {badges} badge{bs} earned. The terminal yields what the badges unlock.',
    lostTitle: 'Hack failed',
    lostText: 'Only {cleared} node{s} down - not enough for a single badge. The terminal goes dark, and the party walks away with nothing.',
  },
};
