// =====================================================================
//  CONFIG - every design knob of the prototype.
//  Change a number, save, and the browser reloads (when running "npm run dev").
//  Think of this file as the "exported variables" panel of a Godot scene,
//  or the "Details" panel defaults of a Blueprint.
//
//  The config is split into four files:
//    config/world.js       map shape, bosses, terrain
//    config/encounters.js  encounter placement, rest / shop / treasure / events, fatigue
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
    startGold: 50,
    // Supplies are the currency: camps (20), shop rest (35), shop upgrades (25); treasure gives 40.
    // Either a fixed number, or 'auto' = (shortest path length + supplySlack) from the old rules.
    startSupplies: 60,
    supplySlack: 12,
    revealRadius: 0,          // how many rings around the player get uncovered (0 = only the tile you stand on)
    bossAlwaysVisible: false, // false = the bosses hide under the fog like everything else
    revealStartRadius: 1,     // rings uncovered around the start tile at the beginning
    winCondition: 'all',      // 'all' = defeat every boss, 'any' = defeating one boss wins
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
    followPlayer: true,       // camera glides after the player when they move
    followDurationMs: 650,
  },

  // ----- Animation timings (milliseconds) ----------------------------
  anim: {
    hopMs: 380,               // player hop from tile to tile
    revealMs: 450,            // fog lifting from a tile
    forcedBannerMs: 500,      // "stumbled into..." banner shown before a forced encounter's UI
  },

  // ----- Colours -----------------------------------------------------
  colors: {
    background: 0x0e1320,
    ground: 0x0b0f19,
    fogTile: 0x1f2536,        // colour of tiles still hidden under the fog of war
    fogTileHeight: 0.22,
    startTile: 0x9fd9ff,
    bossTile: 0x4a1a2a,
    visitedTint: 0.82,        // multiplier applied to the colour of tiles you already stepped on
    reachableRing: 0xffd166,
    hoverRing: 0xffffff,
    player: 0xfff1c1,
    playerGlow: 0xffd166,
  },
};
