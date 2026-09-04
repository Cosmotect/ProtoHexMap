// =====================================================================
//  CONFIG - every design knob of the prototype.
//  Change a number, save, and the browser reloads (when running "npm run dev").
//  Think of this file as the "exported variables" panel of a Godot scene,
//  or the "Details" panel defaults of a Blueprint.
//
//  The config is split into four files:
//    config/world.js       map shape, tile types, biomes, generation noise
//    config/encounters.js  encounter placement, the Stasis, rest / shop / treasure / events, fatigue
//    config/units.js       the party and the battle simulation
//    config.js (this one)  run rules, camera, animation, colours, and the glue
//  The rest of the code always reads CONFIG.<section>, so moving a section between
//  files never changes any other code.
// =====================================================================
import { WORLD } from './config/world.js';
import { ENCOUNTERS } from './config/encounters.js';
import { UNITS } from './config/units.js';

export const CONFIG = {
  ...WORLD,
  ...ENCOUNTERS,
  ...UNITS,

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

  // ----- Local map (the encounter arena, see src/local/) ---------------
  // A separate hex grid the camera dives into when a combat encounter starts.
  // It always uses the OPPOSITE hex orientation to the world map, so one world
  // tile visually breaks into a sub-grid of local tiles.
  local: {
    radius: 6,                // rings of local hexes around the arena centre
    hexSize: 1.0,
    gap: 0.03,
    tileHeight: 0.3,          // minimum baseline thickness of an arena tile
    typeHeightScale: 16,      // arena baseline = world tile type's visual height x this
                              // (a hill arena starts taller than a plains one; the
                              // backdrop hexes' tops use the same formula)
    elevationStep: 0.35,      // world units of visual height per combat elevation level
                              // (the LEVELS themselves are combat rules: src/config/abilities.js)
    elevationMid: 2,          // which level is "untouched ground": the one drawn flush with the
                              // surrounding world tiles, with the levels above it raised and the
                              // ones below it sunk. 2 is the middle of 0..4, so the arena has two
                              // steps up and two steps down around an unchanged middle.
                              // Change elevationLevels (src/config/abilities.js) and this should
                              // move to the middle of the new range. A smaller number lifts the
                              // whole arena, a bigger one sinks it.
    // ----- arena tile colouring (LocalMapView.paintTile) ------------------
    // Arena tiles are shades of the entered world tile's colour, with a strong
    // VALUE ramp by elevation so all five height steps read at a glance. The
    // ramp blends each tile TOWARDS BLACK (steps below the neutral middle) or
    // TOWARDS WHITE (steps above it), NOT by multiplying its brightness: a
    // multiply is invisible on a near-black tile (e.g. the start tile), while a
    // blend to black / white separates the levels on ANY base colour.
    tileShade: {
      darkPerLevel: 0.22,     // blend toward black per level BELOW the middle (level 0 ~ 44% black)
      lightPerLevel: 0.20,    // blend toward white per level ABOVE the middle (level 4 ~ 40% white)
      jitter: 0.05,           // +- random per-tile brightness, keeps the ground from looking airbrushed
      neighborBlend: 0.16,    // how hard a neighbouring world tile pulls edge tiles' colour
                              // (was 0.5 before the elevation ramp: the bleed drowned it out)
      neighborBlendMax: 0.25, // hard cap on that pull (was 0.6)
    },
    // ----- authored tile types (handcrafted maps, src/local/mapcode.js) ---
    // wall: a non-interactive rock column - blocks walking, pushes crash on it.
    // ether: a hole in the arena floor - blocks walking, pushes into it kill.
    wallTile: {
      color: 0x57504a,        // the rock's own colour...
      blend: 0.35,            // ...pulled this much towards the arena's shade (sense of place)
      extraHeight: 0.9,       // world units the column rises above its authored elevation
    },
    etherTile: {
      color: 0x102e35,        // the still surface seen down in the hole
      emissive: 0x14454d,     // its faint glow
      height: 0.07,           // sliver of mesh left so the hole has a visible bottom
    },
    // ----- deployment: choosing where the party stands -------------------
    // Walking into a fight on purpose lets the player place each unit by hand
    // before the first round (the cursor carries the unit's icon; left click
    // locks it in, right click takes the last one back). A fight nobody chose -
    // a fatigue ambush - skips this: the party is dropped at random tiles, but
    // as a GROUP, never further than maxSpread apart.
    deploy: {
      enabled: true,          // false = every fight rolls the party's tiles, as before
      maxSpread: 6,           // forced fights: max distance between two party units
      decalScale: 1.15,       // size of the icon plate on the hovered tile, x tile radius
    },
    flyInMs: 1500,            // the dive from the world map into the arena
    flyOutMs: 1300,           // the climb back out
    swapPoint: 0.55,          // where in the flight (0..1) the world swaps for the arena
    shake: 0.4,               // screenshake amplitude at the peak of the flight (world units)
    cloudColor: 0xdfe6f2,     // the clouds punched through during the flight
    // The arena camera: rotation only (no panning, no zooming).
    camera: { fov: 50, tiltDegrees: 55, distance: 22, minTiltDegrees: 25, maxTiltDegrees: 70 },
    // The START SCREEN camera (the party around the campfire) is its own pose:
    // much closer to the fire and locked, because that shot is composed, not
    // explored. It is also the pose the fly-out to the world map starts from.
    startCamera: {
      fov: 60,
      tiltDegrees: 70,        // 0 = straight down; higher = more of a ground-level look
      azimuthDegrees: 30,     // spin around the fire. 30 puts a TILE dead centre behind the
                              // flame instead of the seam between two, which is what lets the
                              // party sit as one row of three rather than two-plus-a-straggler
      distance: 3,             // how far from the fire
      targetHeight: 0.5,      // the camera aims this high above the centre tile (the flame)
      lockControls: true,     // true = the player cannot rotate the start shot
    },
  },

  // ----- Backgrounds ---------------------------------------------------
  // The empty space each map sits in: the colour behind everything, the
  // distance fog that fades far tiles into it, and the void floor far below.
  // The two maps are tuned separately - the world map is a wide vista, the
  // local map is one tile blown up to arena size.
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
  localBackground: {
    color: 0x181539,
    fog: true,
    fogNear: 20,
    fogFar: 60,
    groundColor: 0x2d6673,
    groundDepth: -5,          // same fix as worldBackground.groundDepth, for the arena
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
    volume: 0.35,             // master volume, 0..1 (0 = silent)
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
  // (The background and the void floor moved to worldBackground / localBackground above.)
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
    enemyReachRing: 0xd0455f,  // ...and where a clicked ENEMY could walk (a readout, not a target)
    hoverRing: 0xffffff,
    player: 0xfff1c1,
    playerGlow: 0xffd166,
  },
};
