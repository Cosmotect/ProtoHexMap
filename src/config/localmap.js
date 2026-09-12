// =====================================================================
//  LOCAL MAP CONFIG - the encounter arena: combat rules, the status table,
//  the ability upgrade table, camera, colours and backdrop.
//  (Part of the config split: world.js / encounters.js / entities.js /
//  abilities.js / localmap.js (this one) / config.js. NOT to be confused
//  with src/local/localmap.js - that one is the local-map GENERATOR code,
//  this one is only data.)
//
//  COMBAT_CONFIG moved here from config/abilities.js on 2026-09-12, along
//  with the two lines that glue ABILITY_UPGRADES and STATUSES onto it: the
//  arena's rules and those two tables are all read by the same combat
//  engine that plays out on this map, so they now sit next to the rest of
//  the local map's config instead of in the file that defines the
//  ABILITIES / ABILITY_UPGRADES / STATUSES tables themselves. abilities.js
//  still owns those three tables and is where a new ability, upgrade or
//  status gets written - this file only wires two of them onto
//  COMBAT_CONFIG, exactly as abilities.js used to.
// =====================================================================
import { ABILITIES, ABILITY_UPGRADES, STATUSES } from './abilities.js';

export const COMBAT_CONFIG = {
  // ----- Combat rules (hex-box "settings" block) ----------------------
  combat: {
    minSpeed: 2,        // slowed units keep at least this much speed (climbing costs 2)
    highBonus: 1,       // damage added when attacking from 2+ levels above
    lowPenalty: 1,      // damage removed when attacking from 2+ levels below
    voidEdges: false,   // true = shoves over the map edge kill instead of crashing
    // (What popping a shield is worth to the enemy AI used to live here as
    // `shieldStripScore`. It moved into the shield's own row in the status table
    // below, as `aiValue`, so every status carries its own worth in one place.)
    // ----- the retreat rule (stops a decided fight from being dragged out) -----
    // A beaten enemy side starts to break. From the round AFTER `afterRound`, on
    // every enemy's turn, while the enemy side's remaining HP is under `hpFraction`
    // of what it had when the fight began, each enemy that has not broken yet rolls
    //   100 / (enemies still standing)  percent
    // to flee - so a crowd goes a few at a time and the last one standing always
    // runs. The roll happens once per enemy: a fleeing enemy is locked in, and
    // walks for the nearest arena edge until it gets there or is killed on the way.
    // It is still a normal target while it runs.
    // The STASIS is exempt: a Stasis Seed or Colony fight never offers the roll at
    // all (createBattle's `noFlee`, set from the encounter in main.js) - that enemy
    // has nowhere to run to and nothing to run for.
    // Escaping is NOT a death: nothing is reported through onUnitDeath, so when
    // LOOT exists this is exactly the branch that must not roll it - a killed enemy
    // pays out, one that got away does not. The fight still counts as won, so the
    // party keeps the encounter's completion reward.
    flee: { afterRound: 7, hpFraction: 0.3 },
    // What a status is worth to a creature that cannot read them (see the intellect
    // classes below): enough to bless allies and curse the party, not enough to
    // choose between two targets.
    blindStatusValue: 8,
    elevationLevels: 4, // arena heights run 0..this (5 steps: 0,1,2,3,4)
    // The MIDDLE step (2) is the arena's neutral ground: it renders
    // flush with the surrounding world tiles, 3 and 4 stand above it,
    // 1 and 0 are sunk below it. Keep this number EVEN so a middle
    // step exists (see config.local.elevationMid below).
  },
};
COMBAT_CONFIG.abilities = ABILITIES;
COMBAT_CONFIG.abilityUpgrades = ABILITY_UPGRADES;
COMBAT_CONFIG.statuses = STATUSES;

export const LOCAL_MAP_CONFIG = {
  // COMBAT_CONFIG's own keys (combat, abilityUpgrades, statuses) become
  // sections of this local map config, the same way they used to become
  // sections of the top-level CONFIG directly.
  ...COMBAT_CONFIG,

  // ----- Local map (the encounter arena, see src/local/) ---------------
  // A separate hex grid the camera dives into when a combat encounter starts.
  // It always uses the OPPOSITE hex orientation to the world map, so one world
  // tile visually breaks into a sub-grid of local tiles.
  local: {
    aimFxOpacity: 0.5,        // how bright the aim-preview fills are (0..1, see colors.aim*Fill)
    radius: 6,                // rings of local hexes around the arena centre
    hexSize: 1.0,
    gap: 0.03,
    tileHeight: 0.3,          // minimum baseline thickness of an arena tile
    typeHeightScale: 16,      // arena baseline = world tile type's visual height x this
    // (a hill arena starts taller than a plains one; the
    // backdrop hexes' tops use the same formula)
    elevationStep: 0.35,      // world units of visual height per combat elevation level
    // (the LEVELS themselves are combat rules, see COMBAT_CONFIG.combat above)
    elevationMid: 2,          // which level is "untouched ground": the one drawn flush with the
    // surrounding world tiles, with the levels above it raised and the
    // ones below it sunk. 2 is the middle of 0..4, so the arena has two
    // steps up and two steps down around an unchanged middle.
    // Change elevationLevels (COMBAT_CONFIG.combat above) and this should
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

  // ----- Local background ------------------------------------------------
  // The empty space the arena sits in: the colour behind everything, the
  // distance fog that fades far tiles into it, and the void floor far below.
  // Its world-map counterpart, worldBackground, is tuned separately in
  // config.js - the world map is a wide vista, the local map is one tile
  // blown up to arena size.
  localBackground: {
    color: 0x181539,
    fog: true,
    fogNear: 20,
    fogFar: 60,
    groundColor: 0x2d6673,
    groundDepth: -5,          // same fix as config.js's worldBackground.groundDepth, for the arena
  },
};
