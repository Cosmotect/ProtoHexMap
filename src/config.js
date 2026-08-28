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

  // ----- Local map (the encounter arena, see src/local/) ---------------
  // A separate hex grid the camera dives into when a combat encounter starts.
  // It always uses the OPPOSITE hex orientation to the world map, so one world
  // tile visually breaks into a sub-grid of local tiles.
  local: {
    radius: 6,                // rings of local hexes around the arena centre
    hexSize: 1.0,
    gap: 0.06,
    tileHeight: 0.3,
    flyInMs: 1500,            // the dive from the world map into the arena
    flyOutMs: 1300,           // the climb back out
    swapPoint: 0.55,          // where in the flight (0..1) the world swaps for the arena
    shake: 0.4,               // screenshake amplitude at the peak of the flight (world units)
    cloudColor: 0xdfe6f2,     // the clouds punched through during the flight
    // The arena camera: rotation only (no panning, no zooming).
    camera: { fov: 46, tiltDegrees: 55, distance: 13, minTiltDegrees: 25, maxTiltDegrees: 70 },
  },

  // ----- Camera ------------------------------------------------------
  camera: {
    mode: 'perspective',      // 'perspective' or 'orthographic' (toggle in the HUD too)
    fov: 42,                  // perspective field of view, degrees
    tiltDegrees: 52,          // angle between the "look down" direction and straight down (0 = top-down)
    distance: 16,             // how far the camera starts from the player
    minDistance: 6,
    maxDistance: 32,
    minTiltDegrees: 15,       // how far the player may tilt the perspective camera
    maxTiltDegrees: 72,
    orthoTiltDegrees: 30,     // starting tilt of the orthographic (isometric style) camera
    orthoViewHeight: 14,      // how many world units tall the orthographic view is
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
  // Every sound is generated in the browser, so these are the knobs of a
  // tiny synthesiser rather than a list of files.
  audio: {
    enabled: true,
    volume: 0.35,             // master volume, 0..1
    wave: 'sine',             // 'sine' (softest), 'triangle', 'square', 'sawtooth'
    baseFreq: 392,            // pitch of the FIRST fatigue box, in Hz (392 = G4)
    stepSemitones: 1.5,       // how much higher each following box sounds (12 = a full octave)
    blipGain: 0.5,            // loudness of one blip before the master volume
    attackMs: 8,              // fade-in: anything above ~4 removes the click at the start
    decayMs: 150,             // fade-out
    glide: 0.94,              // the tone slides to this fraction of its pitch while fading (a soft "tock")
    filterRatio: 3.5,         // low-pass cutoff as a multiple of the pitch: lower = duller, gentler
    pitchJitter: 0.012,       // +-1.2% random pitch per play, so repeats never sound identical
    gainJitter: 0.09,         // +-9% random volume per play
    clearStaggerMs: 55,       // delay between the boxes emptying, right to left
    clearDrop: 3,             // semitones below the filling ladder, for the reset sound
    clearGain: 0.55,          // the reset is quieter than the steps
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
  colors: {
    background: 0x0e1320,
    ground: 0x0b0f19,         // the void floor far below the map, seen through the ether holes
    fogTile: 0x1f2536,        // colour of tiles still hidden under the fog of war
    fogTileHeight: 0.22,
    startTile: 0x9fd9ff,
    biomeTintAmount: 0.34,    // how far a tile's type colour is shifted towards its biome colour (0..1)
    seedTile: 0x4a1a2a,       // tile under the Stasis Seed
    colonyTile: 0x33204a,     // tile under an active Stasis Colony
    stasisLine: 0x9a5cff,     // the lines growing from the Seed to its Colonies
    visitedTint: 0.82,        // multiplier applied to the colour of tiles you already stepped on
    reachableRing: 0xffd166,
    hoverRing: 0xffffff,
    player: 0xfff1c1,
    playerGlow: 0xffd166,
  },
};
