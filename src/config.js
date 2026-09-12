// =====================================================================
//  CONFIG - every design knob of the prototype.
//  Change a number, save, and the browser reloads (when running "npm run dev").
//
//  The config is split into these files:
//    config/world.js       map shape, tile types, biomes, generation noise
//    config/encounters.js  encounter placement, the Stasis, rest / shop / treasure / events, fatigue
//    config/entities.js    the party, the bestiary, intellect classes, and tile tags
//    config/abilities.js   the ABILITIES / ABILITY_UPGRADES / STATUSES tables
//    config/localmap.js    the arena: combat rules, the local map and its backdrop
//                           (also wires ABILITY_UPGRADES and STATUSES onto COMBAT_CONFIG)
//    config.js (this one)  run rules, world camera, animation, colours, and the glue
//  The rest of the code always reads CONFIG.<section>, so moving a section between
//  files never changes any other code.
// =====================================================================
import { WORLD } from './config/world.js';
import { ENCOUNTERS } from './config/encounters.js';
import { ENTITIES } from './config/entities.js';
import { LOCAL_MAP_CONFIG } from './config/localmap.js';

export const CONFIG = {
  ...WORLD,
  ...ENCOUNTERS,
  ...ENTITIES,
  // The arena's own rules, its status table, its ability-upgrade table, the
  // local map itself and its backdrop (src/config/localmap.js). Folded in here
  // so they sit in the Settings window with everything else - the objects are
  // shared, not copied, so an edit reaches the combat engine straight away.
  ...LOCAL_MAP_CONFIG,

  // ----- Run rules ---------------------------------------------------
  run: {
    // Supplies are the currency: camps (rest.cost), shop options (shop.*Cost); treasure gives treasure.supplies.
    // This is also the maximum: gains never exceed it.
    startSupplies: 60,
    revealRadius: 0,          // how many rings around the player get uncovered (0 = only the tile you stand on)
    seedAlwaysVisible: false, // false = the Stasis Seed hides under the fog like everything else
    revealStartRadius: 1,     // rings uncovered around the start tile at the beginning
    // Win condition: destroy the Stasis Seed (see config/encounters.js, "stasis").
  },

  // ----- Start flow -----------------------------------------------------
  // The game boots straight into the local map of the starting tile (the party
  // around a campfire), masked by a black "Everlands" splash. "Begin journey"
  // then flies the camera out to the world map and the run officially starts.
  start: {
    splashMs: 2000,           // how long the splash covers the screen before fading
    splashFadeMs: 900,        // the fade itself
  },

  // (Local map config - the "local" and "localBackground" sections - moved to
  // src/config/localmap.js on 2026-09-12, next to COMBAT_CONFIG.)

  // ----- Backgrounds ---------------------------------------------------
  // The empty space each map sits in: the colour behind everything, the
  // distance fog that fades far tiles into it, and the void floor far below.
  // The two maps are tuned separately - this is the world map's half; the
  // local map's half (localBackground) is in config/localmap.js.
  worldBackground: {
    color: 0x1c2035,          // behind the map, and the colour distant tiles fade into
    fog: true,                // distance fog on (off = tiles stay sharp to the horizon)
    fogNear: 20,              // world units at which the fade starts
    fogFar: 60,               // ...and at which a tile is fully the background colour
    groundColor: 0x2c6369,    // the void floor far below, seen through the ether holes
    groundDepth: -5,          // how far below y=0 that floor sits (was -30: with the
    // tighter fogNear/fogFar above, -30 fogged out to plain
    // background colour before it read as a floor at all)
  },

  // ----- Camera ------------------------------------------------------
  // The world map camera. Perspective only - the top-down orthographic mode was
  // removed on 2026-08-29.
  camera: {
    fov: 42,                  // field of view, degrees
    tiltDegrees: 52,          // angle between the "look down" direction and straight down (0 = top-down)
    distance: 16,             // how far the camera starts from the player
    minDistance: 6,
    maxDistance: 32,
    minTiltDegrees: 15,       // how far the player may tilt the camera
    maxTiltDegrees: 72,
    followPlayer: false,      // camera glides after the player when they move
    followDurationMs: 650,
  },

  // ----- Animation timings (milliseconds) ----------------------------
  anim: {
    hopMs: 380,               // player hop from tile to tile
    revealMs: 450,            // fog lifting from a tile
    forcedBannerMs: 500,      // "stumbled into..." banner shown before a forced encounter's UI
  },

  // ----- Sound (src/audio.js) ----------------------------------------
  // Every sound is generated in the browser, not loaded from a file. The
  // whole voice of it (pitch, envelope, filter) is a fixed design decision
  // living at the top of src/audio.js; the only setting is how loud it is.
  audio: {
    volume: 0.05,             // master volume, 0..1 (0 = silent)
  },

  // ----- Fatigue bar (the boxes at the top of the screen) -------------
  fatigueBar: {
    wiggleMs: 260,            // the tiny shake a box does the moment it fills
    pulseMs: 1500,            // one full breath of the sine pulse on the newest filled box
    pulseScale: 0.09,         // how far that breath grows the box (0.09 = +-9%)
    emptyOpacity: 0.22,       // how faint an unreached box is
    filledOpacity: 1,         // how solid a reached box is
    boxSize: 30,              // px, before the UI scale
    hueSafe: 135,             // colour of the 0% boxes (135 = green)
    hueLow: 52,               // colour of the smallest non-zero percentage (52 = yellow)
    hueHigh: 2,               // colour of the largest percentage (2 = red)
  },

  // ----- Colours -----------------------------------------------------
  // (The background and the void floor moved to worldBackground above and
  // localBackground in config/localmap.js.)
  colors: {
    fogTile: 0x1f2536,        // colour of tiles still hidden under the fog of war
    fogTileHeight: 1,
    startTile: 0x1f1e28,
    biomeTintAmount: 0.34,    // how far a tile's type colour is shifted towards its biome colour (0..1)
    seedTile: 0x4a1a2a,       // tile under the Stasis Seed
    colonyTile: 0x33204a,     // tile under an active Stasis Colony
    stasisLine: 0x9a5cff,     // the lines growing from the Seed to its Colonies
    visitedTint: 1,           // multiplier applied to the colour of tiles you already stepped on
    reachableRing: 0xffd166,
    abilityAimRing: 0xff4d4d,  // tile highlight while picking a target for a unit's ability
    // ----- the aim PREVIEW: what a cast aimed at the hovered tile would touch.
    // The ring above says where an ability MAY be pointed; these fills say what
    // happens if it is pointed there. One colour per consequence, not per
    // ability, so the reading is the same whichever ability is selected.
    aimHitFill: 0xff4d4d,      // takes the blow
    aimHealFill: 0xa8e05f,     // is healed
    aimBuffFill: 0x5fc7e0,     // receives a status and nothing else
    aimPushFill: 0xffd166,     // is shoved, and the way it is shoved
    aimRaiseFill: 0x9a5cff,    // the ground here changes height
    aimTagFill: 0xff9950,      // a tile tag is left here
    aimDashFill: 0x7fe0f0,     // the caster ends up here
    enemyReachRing: 0xd0455f,  // ...and where a clicked ENEMY could walk (a readout, not a target)
    hoverRing: 0xffffff,
    player: 0xfff1c1,
    playerGlow: 0xffd166,
  },
};

// The "which enemy GROUPS spawn on which world layer" table lives in
// config/encounters.js (ENCOUNTERS.battleSpawns) so it sits next to the rest
// of encounter design, but every existing reader still asks for it at
// CONFIG.battle.spawns (src/battle.js, src/settings.js) - so it is wired in
// here rather than making those files know about two config sections.
CONFIG.battle.spawns = ENCOUNTERS.battleSpawns;
