// =====================================================================
//  LOCAL MAP VIEW - the Three.js side of the local map.
//
//  A completely separate THREE.Scene with its own lights, camera and controls,
//  sharing only the WebGLRenderer (the canvas) with the world renderer. Nothing
//  here touches world meshes or game state; build() receives plain data.
//
//  Camera rules on the local map: NO panning, NO zooming, rotation only.
// =====================================================================
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { generateLocalMap, pickRandomTiles, pickClusteredTiles, applyElevationWave, neutralElevation } from './localmap.js';
import { hexKey, hexesInRange, hexDistance, axialToPlane } from '../hex.js';
import { COMBAT_CONFIG } from '../config/abilities.js';
import { createRng } from '../rng.js';
import { t, hasKey } from '../i18n.js';
import { statusesFor, badgeNumber } from '../status.js';

const SQRT3 = Math.sqrt(3);
const deg = (d) => (d * Math.PI) / 180;

// Canvas rounded-rectangle path (roundRect is not in every browser yet).
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ----- enemy bodies ----------------------------------------------------
// Every shape a bestiary entry (config/units.js, battle.enemyTypes) may ask for.
// Each factory returns a geometry roughly 0.55 world units tall, sitting on the
// origin, so any of them can stand on a tile without further fiddling.
// Add a name here and it is instantly available to the config.
const SHAPES = {
  box:          () => new THREE.BoxGeometry(0.42, 0.42, 0.42),
  sphere:       () => new THREE.SphereGeometry(0.27, 16, 12),
  cone:         () => new THREE.ConeGeometry(0.28, 0.56, 16),
  cylinder:     () => new THREE.CylinderGeometry(0.24, 0.24, 0.5, 16),
  capsule:      () => new THREE.CapsuleGeometry(0.2, 0.26, 6, 12),
  prism:        () => new THREE.CylinderGeometry(0.28, 0.28, 0.5, 6),
  pyramid:      () => new THREE.ConeGeometry(0.32, 0.52, 4),
  spike:        () => new THREE.ConeGeometry(0.19, 0.72, 10),
  tetrahedron:  () => new THREE.TetrahedronGeometry(0.34),
  octahedron:   () => new THREE.OctahedronGeometry(0.3),
  icosahedron:  () => new THREE.IcosahedronGeometry(0.3),
  dodecahedron: () => new THREE.DodecahedronGeometry(0.29),
  torus:        () => new THREE.TorusGeometry(0.22, 0.09, 10, 20),
  torusKnot:    () => new THREE.TorusKnotGeometry(0.19, 0.06, 64, 8),
  // Stretched variants of the platonics, for silhouettes the basics cannot make.
  diamond:      () => new THREE.OctahedronGeometry(0.3).scale(0.75, 1.5, 0.75),
  shard:        () => new THREE.TetrahedronGeometry(0.34).scale(0.6, 1.7, 0.6),
  slab:         () => new THREE.BoxGeometry(0.5, 0.34, 0.28),
  star:         () => new THREE.OctahedronGeometry(0.34, 1).scale(1, 1.2, 1),
};
export const SHAPE_NAMES = Object.keys(SHAPES);
function enemyGeometry(shape) {
  const make = SHAPES[shape] ?? SHAPES.octahedron;
  return make();
}

// The plaque hanging over every unit's head: the portrait, the HP numbers and
// the health bar as ONE billboard. Sizes are design units on the canvas; only
// worldWidth / worldY are in world space. The layout deliberately mirrors a row
// of the party panel (src/style.css `.unit`), and the colours are that panel's.
const PLAQUE = {
  icon: 40,                 // the square portrait box
  bar: 160,                 // the health bar - four times the icon's width
  barH: 12,                 // ...at the party panel's bar height
  gap: 7,                   // between the icon box and the right column
  pad: 7,                   // plate padding
  textSize: 21,              // the "24 / 40" numbers (was 15; +40% so they read from the map)
  plateRadius: 10,
  dpr: 3,                   // canvas oversampling, so the text stays crisp when scaled up
  worldWidth: 1.9,          // how wide the whole plaque is in world units
  worldY: 1.05,             // how high above the token's base it floats (clears the head)
  plateFill: 'rgba(10, 14, 24, 0.78)',
  plateStroke: 'rgba(255, 209, 102, 0.75)',      // the party's gold frame
  plateStrokeEnemy: 'rgba(226, 71, 75, 0.9)',    // enemies get a red one, readable at a glance
  badge: 20,                // a status icon's box on the numbers row
  badgeGap: 3,
  badgeFill: 'rgba(255, 255, 255, 0.10)',
  badgeTextSize: 9,         // the turns-remaining number in its corner
  badgeTextBg: 'rgba(8, 11, 18, 0.9)',
  iconFill: 'rgba(255, 255, 255, 0.08)',
  glyphColor: '#f2f5fb',    // the portrait glyph itself - NEVER the box's wash
  iconStroke: 'rgba(255, 255, 255, 0.16)',
  textColor: '#94a0b8',     // --muted
  trackFill: 'rgba(255, 255, 255, 0.10)',
  trackStroke: 'rgba(255, 255, 255, 0.12)',
  fillOk: '#7fb85f',
  fillHurt: '#ff6b6b',      // --danger, as `.unit.hurt` uses below half HP
  segColor: 'rgba(0, 0, 0, 0.55)',
  monoFont: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
  emojiFont: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
};
// Overall canvas size follows from the layout above. There are TWO layouts:
// the full one (in combat: portrait, numbers, bar, statuses) and an icon-only
// square for everywhere else - the campfire start screen and any future local
// encounter that is not a fight, where HP and statuses mean nothing.
PLAQUE.w = PLAQUE.pad * 2 + PLAQUE.icon + PLAQUE.gap + PLAQUE.bar;
PLAQUE.h = PLAQUE.pad * 2 + PLAQUE.icon;
PLAQUE.iconOnlyW = PLAQUE.pad * 2 + PLAQUE.icon;
PLAQUE.iconOnlyH = PLAQUE.h;

// HUD sprites must not be dimmed by the world: the scene's distance fog and the
// renderer's ACES tone mapping are for the 3D set, and both were washing the
// portraits out to a flat grey. Opting a sprite out of the two makes it read
// exactly as its canvas was drawn.
const SPRITE_MAT = (tex) => ({ map: tex, transparent: true, depthTest: false, fog: false, toneMapped: false });


// A status tooltip: its name, then what it does. Both come from the locale
// tables (status.<id>.name / .desc); `amount` fills the {n} of the ones that
// have a magnitude, and a real duration adds a line of its own.
function statusTipHtml(hs) {
  const n = hs.amount == null ? '' : (hs.amount > 0 ? `+${hs.amount}` : String(hs.amount));
  const name = t(`status.${hs.id}.name`, { n });
  const desc = t(`status.${hs.id}.desc`, { n });
  const turns = hs.turns > 0 && hasKey('status.turns') ? `<div class="st-turns">${t('status.turns', { n: hs.turns })}</div>` : '';
  return `<div class="st-name">${name}</div><div class="st-desc">${desc}</div>${turns}`;
}

export class LocalMapView {
  constructor(webglRenderer, domElement, config) {
    this.renderer = webglRenderer;
    this.domElement = domElement;
    this.config = config;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.map = null;
    this.elapsed = 0;
    this.tokens = [];       // unit meshes, for the idle bob
    this.inCombat = false;  // the local map's combat sub-state (setCombat)
  }

  // ----- build ---------------------------------------------------------
  // Creates the whole local scene from scratch.
  //   worldHex  = the world tile being entered (used for the base colour + seeding)
  //   baseColor = final world-tile colour (number); local tiles are shades of it
  //   party     = living player units [{ name, hp, power }]
  //   enemies   = enemy units [{ name, hp, power }]
  //   seed      = number, so the same fight always lays out the same arena
  //   recipe    = future handcrafted arena description (see localmap.js)
  // layout: 'battle' (default) scatters both sides on random tiles;
  //         'camp' seats the party around a campfire (the start screen).
  // neighbors: the 6 surrounding WORLD tiles as [{ dx, dy, color, dh }] - world-plane
  // offset from the entered tile, final colour, and height difference. They become
  // huge uninteractive backdrop hexes around the arena, and pull the colour of
  // edge-facing arena tiles towards themselves (the sense of place).
  // deployParty: true = the party is NOT put on the board here. The fly-in shows
  //   an arena holding only the enemy, and the player picks the tiles themselves
  //   once the camera lands (startDeployment below).
  // partySpread: when the party IS scattered here, how many tiles apart its
  //   members may end up (0 = anywhere in the arena). A fight nobody chose still
  //   drops the party as a group, not one unit alone in a far corner.
  // edges: the SIX world tiles sharing a side with this one, as
  //   [{ dx, dy, isVoid }] - world-plane offset and whether that side is a hole
  //   (an ether tile, or off the world map). They decide which arena edges kill
  //   what is shoved over them; see computeVoidEdges.
  build({ worldHex, baseColor, party, enemies, seed, recipe = null, layout = 'battle', neighbors = [],
          edges = [], worldAzimuth = 0, deployParty = false, partySpread = 0 }) {
    this.dispose();
    const cfg = this.config.local;
    const rng = createRng((seed ?? 1) ^ ((worldHex?.q ?? 0) * 73856093) ^ ((worldHex?.r ?? 0) * 19349663));
    this.rng = rng;

    this.layout = layout;
    // The bearing the world camera was facing the instant the dive started
    // (see transition.js flyIn) - finalCameraPose() lands a battle arena's
    // camera facing the same way, instead of always the same fixed side.
    // Unused for 'camp' (the campfire keeps its own composed azimuth).
    this.worldAzimuth = worldAzimuth;
    this.map = generateLocalMap(this.config, recipe);
    this.recipe = recipe ?? null;
    // Battle arenas get rolling tile heights (high ground matters in combat);
    // the campfire start screen stays flat and calm.
    // A recipe that authors its own elevations IS the arena's height map: the
    // random wave stays off so the designed terrain comes through untouched.
    const recipeHasHeights = !!recipe?.tiles && Object.values(recipe.tiles).some((t) => t.elevation != null);
    if (layout !== 'camp' && !recipeHasHeights) applyElevationWave(this.map, () => rng.random(), COMBAT_CONFIG.combat.elevationLevels);
    this.scene = new THREE.Scene();
    // The local map's own background settings, separate from the world map's.
    const bg = this.config.localBackground;
    this.scene.background = new THREE.Color(bg.color);
    this.scene.fog = bg.fog === false ? null : new THREE.Fog(bg.color, bg.fogNear, bg.fogFar);

    // Lights (recipes will drive these later via map.lighting).
    const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x3b2f2a, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
    sun.position.set(9, 16, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    const ext = cfg.radius * cfg.hexSize * 2;
    sun.shadow.camera.left = -ext; sun.shadow.camera.right = ext;
    sun.shadow.camera.top = ext; sun.shadow.camera.bottom = -ext;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // The void floor far below, like on the world map.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshStandardMaterial({ color: bg.groundColor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = bg.groundDepth ?? -30;
    this.scene.add(floor);

    // Tiles: shades of the world tile's colour, so the arena clearly IS that tile.
    const tileRadius = cfg.hexSize - cfg.gap / SQRT3;
    const geo = new THREE.CylinderGeometry(tileRadius, tileRadius, 1, 6, 1);
    geo.translate(0, 0.5, 0);
    if (this.map.orientation === 'flat') geo.rotateY(Math.PI / 6);
    const base = new THREE.Color(baseColor ?? 0x7a8a6a);
    // The BASELINE tile height comes from the entered world tile's TYPE: an arena
    // on a hill starts taller than one on plain ground, before the elevation wave
    // is added on top. The same formula sets the backdrop hexes' tops, so a
    // same-type neighbour sits flush with the arena's wave-less level.
    this.baseTileHeight = this.baselineFor(this.config.tileTypes?.[worldHex?.type]?.height);
    // Neighbouring world tiles, prepared once: unit direction + colour object.
    const nbs = (neighbors ?? []).map((nb) => {
      const len = Math.hypot(nb.dx, nb.dy) || 1;
      return { ...nb, ux: nb.dx / len, uy: nb.dy / len, color3: new THREE.Color(nb.color) };
    });
    // How far out a tile sits towards a given edge, 0 at the centre, ~1 at the rim.
    const rim = 1.5 * cfg.radius * cfg.hexSize;
    // Only the IMMEDIATE neighbours pull the arena's edge colours; the outer
    // backdrop rings are scenery too far away to bleed in.
    const edgeNbs = nbs.filter((nb) => (nb.ring ?? 1) === 1);

    this.tileMeshes = [];
    for (const tile of this.map.hexes.values()) {
      // Base shade of the entered world tile, pulled towards each neighbouring
      // world tile the closer this arena tile gets to the edge facing it. The
      // jitter keeps the gradient ragged instead of a clean airbrushed fade.
      const col = base.clone().multiplyScalar(0.9 + rng.random() * 0.2);
      for (const nb of edgeNbs) {
        const proj = (tile.x * nb.ux + tile.y * nb.uy) / rim;
        if (proj <= 0.15) continue;
        const t01 = Math.min(1, (proj - 0.15) / 0.85);
        const jitter = 0.65 + rng.random() * 0.7;
        col.lerp(nb.color3, Math.min(0.6, t01 * t01 * 0.5 * jitter));
      }
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 });
      const mesh = new THREE.Mesh(geo, mat);
      const h = this.tileHeightFor(tile.elevation);
      mesh.scale.y = Math.max(0.05, h);
      mesh.position.set(tile.x, 0, -tile.y);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.key = tile.key;
      this.scene.add(mesh);
      tile.mesh = mesh;
      tile.top = Math.max(0.05, h);
      tile.lift = 0;
      this.tileMeshes.push(mesh);
    }
    this.buildNeighborBackdrop(nbs);

    // Highlight rings (movement / cast ranges): the same hex-outline approach as
    // the world map - a bright ring over a dark backing ring, pulsing, going
    // solid white on the hovered tile while that tile rises slightly.
    const ringStart = this.map.orientation === 'flat' ? 0 : Math.PI / 6;
    this.hlRingGeo = new THREE.RingGeometry(tileRadius * 0.78, tileRadius * 0.93, 6, 1, ringStart);
    this.hlRingGeo.rotateX(-Math.PI / 2);
    this.hlRingBackGeo = new THREE.RingGeometry(tileRadius * 0.72, tileRadius * 0.97, 6, 1, ringStart);
    this.hlRingBackGeo.rotateX(-Math.PI / 2);

    // Which arena edges are a hole rather than a wall (see computeVoidEdges).
    this.voidEdges = this.computeVoidEdges(edges);

    if (layout === 'camp') {
      this.buildCampfire();
      this.placeCampParty(party ?? []);
    } else if (deployParty) {
      // The player will place the party by hand once the camera lands, so only
      // the enemy is on the board while the arena is still falling out of the
      // clouds. awaitingDeployment() is how the caller knows to run that step.
      this.deployPending = party ?? [];
      this.placement = this.placeUnits([], enemies ?? [], rng, { enemies: recipe?.spawns?.enemies });
      this.placement.partyKeys = [];
      this.placedCounts = { party: 0, enemies: (enemies ?? []).length };
    } else {
      // These are the REAL starting positions, not stage dressing: beginBattle()
      // reuses them rather than rolling again, so the units the player sees as
      // the clouds part are the ones the fight starts with. (Rolling twice was
      // why everybody jumped a moment after landing.)
      this.placement = this.placeUnits(party ?? [], enemies ?? [], rng, recipe?.spawns ?? null, { partySpread });
      this.placedCounts = { party: (party ?? []).length, enemies: (enemies ?? []).length };
    }
    // Right click is the arena's cancel button, so the browser's own menu must
    // never appear over the local map. Removed again in dispose().
    if (!this.noContextMenu) {
      this.noContextMenu = (e) => e.preventDefault();
      this.domElement.addEventListener('contextmenu', this.noContextMenu);
    }
    this.buildCamera();
    return this.map;
  }

  // The world-map TYPE height turned into a local baseline tile height: the
  // shared formula for the arena's own tiles AND the backdrop hexes' tops.
  baselineFor(typeHeight) {
    const cfg = this.config.local;
    const h = typeHeight ?? this.config.tileTypes?.ground?.height ?? 0.3;
    return Math.max(cfg.tileHeight, h * (cfg.typeHeightScale ?? 2));
  }

  // THE ONE PLACE a height LEVEL becomes a visual thickness.
  // The levels are centred on the middle step: that step is the baseline the
  // world tile's type gives us (flush with the backdrop neighbours), the steps
  // above it stick up by elevationStep each, the steps below sink by the same.
  // Used both when the arena is built and when an ability reshapes the ground.
  tileHeightFor(level) {
    const cfg = this.config.local;
    const mid = cfg.elevationMid ?? neutralElevation(COMBAT_CONFIG.combat.elevationLevels);
    const base = this.baseTileHeight ?? cfg.tileHeight;
    return Math.max(0.05, base + ((level ?? mid) - mid) * (cfg.elevationStep ?? 0.35));
  }

  // The surrounding world tiles (three rings of them) as giant background hexes
  // past the arena rim. Purely scenery: not pickable, not in tileMeshes, no
  // gameplay. Their bottoms sit on the arena's floor level (y = 0) and their
  // tops use the same type-baseline formula as the arena tiles, so a mountain
  // neighbour towers over a plains arena and water reads as a drop.
  buildNeighborBackdrop(nbs) {
    if (!nbs || !nbs.length) return;
    const cfg = this.config.local;
    const aR = SQRT3 * (cfg.radius + 0.5) * cfg.hexSize;      // circumradius of the arena outline
    const centerDist = 3 * (cfg.radius + 0.5) * cfg.hexSize;  // one world-tile step at arena scale
    // World-plane offsets are scaled uniformly, so all rings land where the world
    // map would put them (world neighbour spacing -> centerDist).
    const spacing = SQRT3 * (this.config.map?.hexSize ?? 1);
    const F = centerDist / spacing;
    const geo = new THREE.CylinderGeometry(aR * 0.97, aR * 0.97, 1, 6, 1);
    geo.translate(0, 0.5, 0);
    // Neighbour hexes carry the WORLD orientation - the opposite of the arena tiles.
    if (this.map.orientation !== 'flat') geo.rotateY(Math.PI / 6);
    for (const nb of nbs) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: nb.color3.clone(), roughness: 1 }));
      mesh.scale.y = Math.max(0.05, this.baselineFor(nb.height));
      mesh.position.set(nb.dx * F, 0, -nb.dy * F);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  // ----- the campfire (start screen) ------------------------------------
  // A few logs, a flickering flame and a warm light on the centre tile.
  buildCampfire() {
    const centre = this.map.hexes.get('0,0');
    const g = new THREE.Group();
    const logMat = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), logMat);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = (i / 3) * Math.PI;
      log.position.y = 0.05;
      log.castShadow = true;
      g.add(log);
    }
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.42, 8),
      new THREE.MeshStandardMaterial({ color: 0xff8c33, emissive: 0xff6a00, emissiveIntensity: 1.6, roughness: 0.4 })
    );
    flame.position.y = 0.3;
    g.add(flame);
    const core = new THREE.Mesh(
      new THREE.ConeGeometry(0.07, 0.24, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd97a })
    );
    core.position.y = 0.26;
    g.add(core);
    const light = new THREE.PointLight(0xffa04d, 14, 9, 2);
    light.position.y = 0.8;
    g.add(light);
    g.position.set(centre.x, centre.top, -centre.y);
    this.scene.add(g);
    this.campfire = { group: g, flame, core, light };
  }

  // Seats the party on the first ring, on the tiles FURTHEST from the camera, so
  // the shot reads as "looking across the fire at the party". The ring is sorted
  // by depth (the far side first) and the seats are taken in order, which keeps
  // the group together on neighbouring tiles instead of scattering it around the
  // fire. Sorting rather than hard-coding keys means a change of hex orientation
  // or radius cannot silently put someone behind the lens.
  placeCampParty(party) {
    const ring = [];
    for (const tile of this.map.hexes.values()) {
      if (Math.max(Math.abs(tile.q), Math.abs(tile.r), Math.abs(tile.q + tile.r)) === 1) ring.push(tile);
    }
    // Sort by how far each tile sits from "straight back", measured as the angle
    // between it and the away-from-camera direction. Taking seats in that order
    // fills the back-centre tile first and then its two neighbours, which is a
    // contiguous row across the far side of the fire.
    const az = deg(this.config.local.startCamera?.azimuthDegrees ?? 0);
    const away = { x: -Math.sin(az), z: -Math.cos(az) };
    const bearing = (tile) => {
      const x = tile.x, z = -tile.y;          // world position of the tile
      const dot = x * away.x + z * away.z;
      const cross = x * away.z - z * away.x;
      return Math.abs(Math.atan2(cross, dot));
    };
    ring.sort((a, b) => bearing(a) - bearing(b) || a.x - b.x);
    const seats = ring.map((tile) => `${tile.q},${tile.r}`);
    this.campSeats = seats;
    party.forEach((u, i) => this.addPartyToken(u, i, seats[i % seats.length]));
  }

  // Removes and re-creates the party tokens (after a roster swap).
  refreshParty(party) {
    for (const m of [...this.tokens]) {
      if (m.userData.partyIndex == null) continue;
      this.scene.remove(m);
      if (m.userData.ring) this.scene.remove(m.userData.ring);
      this.tokens.splice(this.tokens.indexOf(m), 1);
    }
    const seats = this.campSeats ?? [];
    party.forEach((u, i) => this.addPartyToken(u, i, seats[i % seats.length]));
  }

  addPartyToken(unit, index, tileKey) {
    const c = this.config.colors;
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.2, 0.3, 6, 12),
      new THREE.MeshStandardMaterial({ color: c.player, roughness: 0.4, emissive: 0x332a10 })
    );
    body.geometry.translate(0, 0.4, 0);
    body.userData.partyIndex = index;
    // The plaque over the head - portrait, HP numbers and health bar in one
    // billboard - so three identical capsules can be told apart at a glance and
    // read at a glance. A Sprite always faces the camera, so it stays legible
    // however the shot is rotated.
    const plaque = this.makeUnitPlaque(unit?.icon ?? '');
    body.add(plaque);
    body.userData.plaque = plaque;
    this.updateUnitPlaque(plaque, unit?.hp, unit?.maxHp);
    this.attachToken(tileKey, body, c.playerGlow, (this.rng?.random() ?? Math.random()) * Math.PI * 2);
  }

  // The unit's glyph drawn onto a canvas and hung above it as a billboard.
  // Textures are cached per glyph: three units sharing an icon share one texture.
  // Used for terrain TAGS; a unit gets the fuller plaque below instead.
  makePortrait(glyph) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial(SPRITE_MAT(this.makePortraitTexture(glyph))));
    sprite.scale.setScalar(0.42);
    sprite.position.set(0, 1.0, 0);
    sprite.renderOrder = 10;   // always drawn on top, never buried in a tile
    return sprite;
  }

  // The glyph plate on its own, cached per glyph.
  makePortraitTexture(glyph) {
    this.portraitCache = this.portraitCache ?? new Map();
    let tex = this.portraitCache.get(glyph);
    if (!tex) {
      tex = new THREE.CanvasTexture(this.drawGlyphPlate(glyph));
      tex.colorSpace = THREE.SRGBColorSpace;
      this.portraitCache.set(glyph, tex);
    }
    return tex;
  }

  // The plate itself: a dark rounded square with the glyph on it. Without the
  // plate a light emoji disappears against a pale tile.
  // A cached TEXTURE belongs to one material - the deployment decal draws its
  // own from this canvas rather than borrowing the sprite's (sharing one
  // canvas texture between a sprite and a mesh upsets the GL texture upload).
  drawGlyphPlate(glyph, size = 128, canvas = null) {
    const cv = canvas ?? document.createElement('canvas');
    cv.width = size; cv.height = size;   // (re)setting the size also clears it
    const g = cv.getContext('2d');
    g.fillStyle = PLAQUE.plateFill;
    roundRect(g, 6, 6, size - 12, size - 12, 26);
    g.fill();
    g.strokeStyle = PLAQUE.plateStroke;
    g.lineWidth = 5;
    roundRect(g, 6, 6, size - 12, size - 12, 26);
    g.stroke();
    g.fillStyle = PLAQUE.glyphColor;   // not the plate's dark wash (see updateUnitPlaque)
    g.font = `${Math.round(size * 0.58)}px ${PLAQUE.emojiFont}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(glyph, size / 2, size / 2 + 2);
    return cv;
  }

  // ----- the unit plaque -------------------------------------------------
  // ONE billboard per unit carrying the portrait, the HP numbers and the health
  // bar together: icon on the left, "24 / 24" above a segmented bar on the
  // right, exactly the arrangement of a row in the party panel. Being a single
  // sprite is what guarantees the whole thing is centred over the unit - two
  // sprites of different widths stacked on top of each other never quite were.
  //
  // The bar is a faithful copy of the party panel's (src/style.css, `.unit .bar`):
  // same track, same green, the same switch to the danger red below half HP, and
  // the same dark segment line every `party.hpSegment` HP, so one bar is read the
  // same way in both places.
  makeUnitPlaque(glyph, { enemy = false } = {}) {
    const cv = document.createElement('canvas');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial(SPRITE_MAT(tex)));
    sprite.position.set(0, PLAQUE.worldY, 0);   // straight up from the token's axis
    sprite.renderOrder = 10;                    // always on top, never buried in a tile
    sprite.userData.canvas = cv;
    sprite.userData.tex = tex;
    sprite.userData.glyph = glyph ?? '';
    sprite.userData.enemy = !!enemy;
    sprite.userData.mode = null;     // 'full' | 'icon', decided on the first redraw
    sprite.userData.hp = undefined;
    sprite.userData.maxHp = undefined;
    sprite.userData.statusKey = undefined;
    sprite.userData.hotspots = [];   // status boxes, in canvas design units (hover -> tooltip)
    this.updateUnitPlaque(sprite, 0, 0, null);
    return sprite;
  }

  // The local map's COMBAT sub-state. The arena is shown for fights and for
  // quiet scenes alike (the campfire start screen); this is the switch that
  // says which. It only changes what is drawn - the engine owns the rules.
  setCombat(on) {
    const next = !!on;
    if (this.inCombat === next) return;
    this.inCombat = next;
    // Every plaque redraws itself into the other layout.
    for (const tok of this.tokens) {
      const pl = tok.userData.plaque;
      if (!pl) continue;
      const u = tok.userData.uid != null ? this.battle?.state.units.find((x) => x.uid === tok.userData.uid) : null;
      this.updateUnitPlaque(pl, u?.hp ?? pl.userData.hp, u?.maxHp ?? pl.userData.maxHp, u);
    }
  }

  // Sizes the plaque's canvas and sprite for the layout it is about to draw.
  sizePlaque(plaque, mode) {
    const P = PLAQUE;
    const w = mode === 'icon' ? P.iconOnlyW : P.w;
    const h = mode === 'icon' ? P.iconOnlyH : P.h;
    const cv = plaque.userData.canvas;
    const resized = cv.width !== w * P.dpr || cv.height !== h * P.dpr;
    cv.width = w * P.dpr;
    cv.height = h * P.dpr;
    const g = cv.getContext('2d');
    g.setTransform(P.dpr, 0, 0, P.dpr, 0, 0);   // draw in design units, render crisply
    plaque.userData.ctx = g;
    // The icon-only plaque keeps the FULL plaque's height, so a unit's badge does
    // not change size when a fight starts - only the strip beside it disappears.
    const worldH = P.worldWidth * (P.h / P.w);
    plaque.scale.set(worldH * (w / h), worldH, 1);
    // A canvas that CHANGED SIZE cannot be re-uploaded into the texture it has
    // already filled once - the graphics driver refuses the copy ("offset
    // overflows texture dimensions") and the plaque would keep the old picture.
    // So a resize gets a brand new texture; a redraw at the same size is just an
    // update. (Visible when a plaque switches between the icon-only and the full
    // layout after it has been on screen - a fight opening on units the player
    // placed, or the roster swapping somebody at the campfire.)
    if (resized) {
      const old = plaque.userData.tex;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      plaque.material.map = tex;
      plaque.material.needsUpdate = true;
      plaque.userData.tex = tex;
      if (old) old.dispose();
    } else {
      plaque.userData.tex.needsUpdate = true;
    }
    return { w, h };
  }

  // Redraws a plaque for the given hp/maxHp - a no-op if neither changed since
  // the last call, so this is safe to call from every syncBattle().
  updateUnitPlaque(plaque, hp, maxHp, unit = null) {
    if (!plaque) return;
    const clampedHp = Math.max(0, hp ?? 0);
    const safeMax = Math.max(0, maxHp ?? 0);
    const statuses = statusesFor(unit);
    // One string standing for the whole status row: cheap to compare, so the
    // canvas is only redrawn when something the player can see actually changed.
    const statusKey = statuses.map((s2) => `${s2.id}:${s2.turns}:${s2.amount ?? ''}`).join(',');
    // Out of combat a unit's plaque is just its portrait: HP and statuses are
    // combat readings, and the campfire is not a fight. `inCombat` is the local
    // map's sub-state (see setCombat / body.in-combat).
    const mode = this.inCombat ? 'full' : 'icon';
    if (plaque.userData.hp === clampedHp && plaque.userData.maxHp === safeMax
        && plaque.userData.statusKey === statusKey && plaque.userData.mode === mode) return;
    plaque.userData.hp = clampedHp;
    plaque.userData.maxHp = safeMax;
    plaque.userData.statusKey = statusKey;

    const P = PLAQUE;
    if (plaque.userData.mode !== mode) { this.sizePlaque(plaque, mode); plaque.userData.mode = mode; }
    const pw = mode === 'icon' ? P.iconOnlyW : P.w;
    const ph = mode === 'icon' ? P.iconOnlyH : P.h;
    const g = plaque.userData.ctx;
    g.clearRect(0, 0, pw, ph);
    plaque.userData.hotspots = [];

    // The plate everything sits on.
    g.fillStyle = P.plateFill;
    roundRect(g, 1, 1, pw - 2, ph - 2, P.plateRadius);
    g.fill();
    g.strokeStyle = plaque.userData.enemy ? P.plateStrokeEnemy : P.plateStroke;
    g.lineWidth = plaque.userData.enemy ? 2.5 : 2;
    roundRect(g, 1, 1, pw - 2, ph - 2, P.plateRadius);
    g.stroke();

    // Icon, in its own inset box on the left (the party panel's `.unit .icon`).
    const ix = P.pad, iy = P.pad, iw = P.icon;
    g.fillStyle = P.iconFill;
    roundRect(g, ix, iy, iw, iw, 7);
    g.fill();
    g.strokeStyle = P.iconStroke;
    g.lineWidth = 1.5;
    roundRect(g, ix, iy, iw, iw, 7);
    g.stroke();
    if (plaque.userData.glyph) {
      // fillStyle is still the icon box's 8%-alpha wash at this point. A colour
      // emoji ignores it, but anything that falls back to a monochrome face -
      // an enemy's plain initial, or an emoji without a colour glyph - would be
      // drawn at 8% opacity and all but vanish. Set it explicitly.
      g.fillStyle = P.glyphColor;
      g.font = `${Math.round(iw * 0.62)}px ${P.emojiFont}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(plaque.userData.glyph, ix + iw / 2, iy + iw / 2 + 1);
    }
    if (mode === 'icon') { plaque.userData.tex.needsUpdate = true; return; }

    // Right column: the numbers, then the bar under them.
    const cx = ix + iw + P.gap;
    const cw = P.bar;
    g.fillStyle = P.textColor;
    g.font = `600 ${P.textSize}px ${P.monoFont}`;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillText(`${clampedHp} / ${safeMax}`, cx, iy + P.textSize);

    // Status icons, right-aligned on the same row as the numbers. Each one
    // records its box so a hover can find it (see statusAt / the tooltip).
    plaque.userData.hotspots = [];
    if (statuses.length) {
      const bh = P.badge;
      const by0 = iy + 1;
      let x = cx + cw - bh;                      // laid out right to left
      for (let i = statuses.length - 1; i >= 0; i--) {
        const st = statuses[i];
        g.fillStyle = P.badgeFill;
        roundRect(g, x, by0, bh, bh, 5);
        g.fill();
        // Same trap as the portrait glyph: fillStyle is still the badge box's
        // 10%-alpha wash here, and a status icon that falls back to a monochrome
        // face would be drawn at 10% opacity. Set the glyph colour explicitly.
        g.fillStyle = P.glyphColor;
        g.font = `${Math.round(bh * 0.68)}px ${P.emojiFont}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(st.icon, x + bh / 2, by0 + bh / 2 + 1);
        // The corner number is ONLY drawn for a status that really has a
        // duration - inventing one would be a lie about the rules.
        const num = badgeNumber(st);
        if (num) {
          const r = P.badgeTextSize * 0.75;
          g.fillStyle = P.badgeTextBg;
          g.beginPath();
          g.arc(x + bh - r * 0.7, by0 + bh - r * 0.7, r, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#ffffff';
          g.font = `700 ${P.badgeTextSize}px ${P.monoFont}`;
          g.fillText(num, x + bh - r * 0.7, by0 + bh - r * 0.7 + 0.5);
        }
        plaque.userData.hotspots.push({ id: st.id, turns: st.turns, amount: st.amount, x0: x, y0: by0, x1: x + bh, y1: by0 + bh });
        x -= bh + P.badgeGap;
      }
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
    }

    const by = iy + iw - P.barH;            // bar bottom-aligned with the icon box
    const frac = safeMax > 0 ? Math.max(0, Math.min(1, clampedHp / safeMax)) : 0;
    // Track.
    g.fillStyle = P.trackFill;
    roundRect(g, cx, by, cw, P.barH, 3);
    g.fill();
    // Fill - the party panel turns it red below half HP (`.unit.hurt`).
    if (frac > 0) {
      g.save();
      roundRect(g, cx, by, cw, P.barH, 3);
      g.clip();
      g.fillStyle = frac < 0.5 ? P.fillHurt : P.fillOk;
      g.fillRect(cx, by, Math.max(2, cw * frac), P.barH);
      g.restore();
    }
    // Segment lines: one every hpSegment HP, drawn over the fill.
    const seg = this.config.party?.hpSegment ?? 0;
    if (seg > 0 && safeMax > seg) {
      g.fillStyle = P.segColor;
      const step = (seg / safeMax) * cw;
      for (let x = step; x < cw - 0.5; x += step) g.fillRect(cx + x - 1, by, 2, P.barH);
    }
    // Track border last, so nothing paints over it.
    g.strokeStyle = P.trackStroke;
    g.lineWidth = 1;
    roundRect(g, cx + 0.5, by + 0.5, cw - 1, P.barH - 1, 3);
    g.stroke();

    plaque.userData.tex.needsUpdate = true;
  }

  attachToken(tileKey, mesh, lightColor, phase) {
    const tile = this.map.hexes.get(tileKey);
    if (!tile) return;
    mesh.position.set(tile.x, tile.top, -tile.y);
    mesh.castShadow = true;
    mesh.userData.baseY = tile.top;
    mesh.userData.phase = phase;
    mesh.userData.tileKey = tileKey;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.38, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: lightColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    ring.position.set(tile.x, tile.top + 0.02, -tile.y);
    mesh.userData.ring = ring;
    this.scene.add(mesh, ring);
    this.tokens.push(mesh);
  }

  // ----- clicking unit tokens (the start screen roster) -------------------
  // Rotation stays on drag; a short, still press on a party token counts as a click.
  enablePicking(onPick) {
    this.disablePicking();
    const ray = new THREE.Raycaster();
    const el = this.domElement;
    let down = null;
    const onDown = (e) => { down = { x: e.clientX, y: e.clientY, time: performance.now() }; };
    const onUp = (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.time < 600;
      down = null;
      if (moved > 6 || !quick || !this.camera) return;
      const rect = el.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(p, this.camera);
      const targets = this.tokens.filter((m) => m.userData.partyIndex != null);
      const hit = ray.intersectObjects(targets, false)[0];
      if (hit) onPick(hit.object.userData.partyIndex);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    this.pickingHandlers = { onDown, onUp };
  }
  disablePicking() {
    if (!this.pickingHandlers) return;
    this.domElement.removeEventListener('pointerdown', this.pickingHandlers.onDown);
    this.domElement.removeEventListener('pointerup', this.pickingHandlers.onUp);
    this.pickingHandlers = null;
  }

  // Units land on random distinct tiles. Used both for the fly-in stage dressing
  // and (via beginBattle) for the real fight; returns where everyone stood.
  // `fixed` (from an arena recipe's `spawns`) pins units to authored tiles,
  // positionally; anyone beyond the authored list still lands on a random tile.
  // `partySpread` keeps the party's rolled tiles within that many steps of each
  // other - a group that landed together instead of a scatter across the arena.
  placeUnits(party, enemies, rng, fixed = null, { partySpread = 0 } = {}) {
    const used = new Set();
    const resolve = (defs, authored, spread = 0) => {
      const keys = [];
      for (let i = 0; i < defs.length; i++) {
        const k = authored?.[i];
        if (k && this.map.hexes.has(k) && !used.has(k)) { keys.push(k); used.add(k); }
        else keys.push(null);
      }
      const need = keys.filter((k) => !k).length;
      const fillers = spread > 0
        ? pickClusteredTiles(this.map, need, () => rng.random(), used, spread)
        : pickRandomTiles(this.map, need, () => rng.random(), used);
      let f = 0;
      return keys.map((k) => k ?? (used.add(fillers[f]), fillers[f++]));
    };
    const partyKeys = resolve(party, fixed?.party, partySpread);
    const enemyKeys = resolve(enemies, fixed?.enemies);

    party.forEach((u, i) => this.addPartyToken(u, i, partyKeys[i]));
    const fallback = this.config.encounters.visuals.battle?.color ?? 0xe2474b;
    enemies.forEach((u, i) => {
      // Body and colour come from the bestiary entry the unit was made from
      // (src/battle.js makeEnemyOfType carries them along on the unit).
      const enemyColor = u?.color ?? fallback;
      const body = new THREE.Mesh(
        enemyGeometry(u?.shape),
        new THREE.MeshStandardMaterial({ color: enemyColor, emissive: 0x330b0b, roughness: 0.45 })
      );
      body.geometry.translate(0, 0.45, 0);
      // Enemies have no emoji; their plaque's icon box shows the name's initial.
      const plaque = this.makeUnitPlaque((u.name ?? '?').charAt(0), { enemy: true });
      body.add(plaque);
      body.userData.plaque = plaque;
      this.updateUnitPlaque(plaque, u?.hp, u?.maxHp);
      this.attachToken(enemyKeys[i], body, enemyColor, rng.random() * Math.PI * 2);
    });
    return { partyKeys, enemyKeys };
  }

  // ----- the void edge ----------------------------------------------------
  // Which tiles JUST OUTSIDE the arena are a hole rather than a wall.
  //
  // The arena is one world tile blown up, so its six sides face the six world
  // tiles around it. Where that neighbour is an ether tile (a hole in the world)
  // or the world simply ends, there is nothing out there to crash into: anything
  // shoved over that side falls out of the world. The engine only ever asks
  // about tiles one or two rings past the rim, so that is all we work out.
  //
  // Sides are matched by ANGLE, not by direction index: the arena's tiles use
  // the opposite hex orientation to the world, so a local push direction points
  // at a CORNER between two world neighbours. Taking the angle of the tile being
  // pushed into and picking the world neighbour closest to it gets the side
  // right whichever way the shove came from.
  computeVoidEdges(edges) {
    const out = new Set();
    if (!this.map || !edges?.length || !edges.some((e) => e.isVoid)) return out;
    const dirs = edges.map((e) => ({ a: Math.atan2(e.dy, e.dx), isVoid: !!e.isVoid }));
    const size = this.config.local.hexSize;
    const R = this.map.radius;
    for (const [q, r] of hexesInRange(0, 0, R + 2)) {
      if (hexDistance(q, r, 0, 0) <= R) continue;
      const p = axialToPlane(q, r, size, this.map.orientation);
      const a = Math.atan2(p.y, p.x);
      let best = null;
      let bestD = Infinity;
      for (const d of dirs) {
        // Shortest angular distance, so the wrap at +-180 degrees is not a cliff.
        const diff = Math.abs(Math.atan2(Math.sin(a - d.a), Math.cos(a - d.a)));
        if (diff < bestD) { bestD = diff; best = d; }
      }
      if (best?.isVoid) out.add(hexKey(q, r));
    }
    return out;
  }
  // Handed to the combat engine as `voidEdgeKeys`.
  voidEdgeKeys() { return [...(this.voidEdges ?? [])]; }

  // ===== DEPLOYMENT =======================================================
  // Before a fight the party WALKED INTO, the player says where each unit
  // stands. The cursor carries the next unit's icon on a flat tile decal (the
  // world map's cost-decal idea, an icon instead of numbers); left click locks
  // that unit onto the tile and the decal becomes the next unit's; right click
  // takes the last one back. When the last unit is down, onDone hands the tile
  // keys back and the fight is built on them.
  // A fight nobody chose (a fatigue ambush) never gets here: build() scattered
  // the party itself, as a group (partySpread).

  awaitingDeployment() { return !!this.deployPending?.length; }

  // `party` is the units to place, in the order the fight will use them - the
  // caller passes its own list so tile i always belongs to unit i. Without one
  // we fall back to the list build() was given.
  startDeployment({ party = null, onPlaced, onDone } = {}) {
    const list = party ?? this.deployPending ?? [];
    if (!list.length) { this.deployPending = null; onDone?.([]); return false; }
    this.deploy = {
      party: list,
      index: 0,
      keys: [],
      taken: new Set(this.placement?.enemyKeys ?? []),
      onPlaced, onDone,
    };
    this.buildDeployDecal();
    this.enableTilePicking((k) => this.placeDeployUnit(k), () => this.undeployLast());
    this.refreshDeployDecal();
    onPlaced?.(this.deployState());
    return true;
  }

  // What the HUD shows: whose turn it is to be placed, and how far along we are.
  deployState() {
    const d = this.deploy;
    if (!d) return null;
    return { index: d.index, total: d.party.length, unit: d.party[d.index] ?? null, placed: [...d.keys] };
  }

  deployTileFree(k) {
    const d = this.deploy;
    return !!(d && this.map?.hexes.has(k) && !d.taken.has(k));
  }

  placeDeployUnit(k) {
    const d = this.deploy;
    if (!d || !this.deployTileFree(k)) return;
    const unit = d.party[d.index];
    this.addPartyToken(unit, d.index, k);
    d.keys.push(k);
    d.taken.add(k);
    d.index += 1;
    if (d.index >= d.party.length) { this.finishDeployment(); return; }
    this.refreshDeployDecal();
    d.onPlaced?.(this.deployState());
  }

  // Right click: the last unit placed steps back off the board.
  undeployLast() {
    const d = this.deploy;
    if (!d || !d.keys.length) return;
    const k = d.keys.pop();
    d.taken.delete(k);
    d.index -= 1;
    const tok = this.tokens.find((m) => m.userData.partyIndex === d.index);
    if (tok) {
      this.scene.remove(tok);
      if (tok.userData.ring) this.scene.remove(tok.userData.ring);
      this.tokens.splice(this.tokens.indexOf(tok), 1);
    }
    this.refreshDeployDecal();
    d.onPlaced?.(this.deployState());
  }

  finishDeployment() {
    const d = this.deploy;
    if (!d) return;
    this.deploy = null;
    this.deployPending = null;
    this.clearDeployDecal();
    this.disableTilePicking();
    // The board IS the placement now: beginBattle() finds it matching and keeps
    // every token exactly where the player put it.
    this.placement = { partyKeys: d.keys, enemyKeys: this.placement?.enemyKeys ?? [] };
    this.placedCounts = { party: d.keys.length, enemies: this.placement.enemyKeys.length };
    d.onDone?.([...d.keys]);
  }

  // Called when a fight is abandoned mid-placement (new map, restart).
  cancelDeployment() {
    if (!this.deploy) return;
    this.clearDeployDecal();
    this.disableTilePicking();
    this.deploy = null;
  }

  // The flat icon plate that follows the cursor across the tiles.
  buildDeployDecal() {
    this.clearDeployDecal();
    const cfg = this.config.local;
    const r = (cfg.hexSize - cfg.gap / SQRT3) * (cfg.deploy?.decalScale ?? 1.15);
    const geo = new THREE.PlaneGeometry(r, r);
    geo.rotateX(-Math.PI / 2);
    // ONE canvas and ONE texture for the whole step: each unit's icon is
    // repainted onto it (see refreshDeployDecal). Swapping in a fresh texture
    // per unit instead upsets the GL texture upload on software renderers.
    this.deployCanvas = this.drawGlyphPlate('', 128);
    const tex = new THREE.CanvasTexture(this.deployCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.renderOrder = 6;      // over the tile and over any ring on it
    mesh.visible = false;
    this.scene.add(mesh);
    this.deployDecal = mesh;
  }

  // Repaints the decal's own canvas with the CURRENT unit's icon.
  refreshDeployDecal() {
    const d = this.deploy;
    if (!d || !this.deployDecal || !this.deployCanvas) return;
    const unit = d.party[d.index];
    this.drawGlyphPlate(unit?.icon || (unit?.name ?? '?').charAt(0), 128, this.deployCanvas);
    if (this.deployDecal.material.map) this.deployDecal.material.map.needsUpdate = true;
  }

  clearDeployDecal() {
    if (!this.deployDecal) return;
    this.scene?.remove(this.deployDecal);
    this.deployDecal.geometry.dispose();
    if (this.deployDecal.material.map) this.deployDecal.material.map.dispose();
    this.deployDecal.material.dispose();
    this.deployDecal = null;
    this.deployCanvas = null;
  }

  // Per-frame: sit the decal on the hovered tile, tinted red where a unit
  // cannot go, and keep it turned towards the camera so the icon reads upright.
  stepDeployDecal() {
    const d = this.deploy;
    const decal = this.deployDecal;
    if (!d || !decal) return;
    // The tile under the cursor rises a little, exactly as it does in a fight.
    for (const t2 of this.map.hexes.values()) {
      const target = t2.key === this.hoverKey ? 0.12 : 0;
      t2.lift = (t2.lift ?? 0) + (target - (t2.lift ?? 0)) * 0.25;
      if (t2.mesh) t2.mesh.position.y = t2.lift < 0.0005 ? 0 : t2.lift;
    }
    const tile = this.hoverKey ? this.map.hexes.get(this.hoverKey) : null;
    decal.visible = !!tile;
    if (!tile) return;
    const free = this.deployTileFree(tile.key);
    decal.position.set(tile.x, tile.top + 0.045 + (tile.lift ?? 0), -tile.y);
    decal.material.color.set(free ? 0xffffff : 0xff6b6b);
    decal.material.opacity = free ? 1 : 0.6;
    if (this.camera) decal.rotation.y = Math.atan2(
      this.camera.position.x - tile.x, this.camera.position.z + tile.y);
  }

  // ===== BATTLE MODE ======================================================
  // The view stays dumb: the combat engine (src/local/battle/engine.js) owns
  // every rule; this block only draws its state and reports tile clicks.

  // Removes every unit token (the fly-in dressing) so the real fight can place
  // its own. Tiles, campfire and lights stay.
  clearUnits() {
    for (const m of this.tokens) {
      this.scene.remove(m);
      if (m.userData.ring) this.scene.remove(m.userData.ring);
    }
    this.tokens = [];
  }

  // Reports the layout the engine needs: who stands where, and each tile's
  // elevation level.
  //
  // The tokens are normally ALREADY on the board - build() put them there while
  // the camera was still diving, and they are what the player sees the moment
  // the clouds part. So the default path re-uses that placement and touches
  // nothing. Only when the board does not match the fight being started (the
  // campfire layout, or a battle begun without a fly-in, e.g. the Nomads event)
  // are the tokens cleared and placed afresh.
  beginBattle({ party, enemies }) {
    const matches = this.placement
      && this.placedCounts?.party === party.length
      && this.placedCounts?.enemies === enemies.length;
    let placement = this.placement;
    if (!matches) {
      this.clearUnits();
      const rng = this.rng ?? { random: Math.random };
      placement = this.placeUnits(party, enemies, rng, this.recipe?.spawns ?? null);
      this.placement = placement;
      this.placedCounts = { party: party.length, enemies: enemies.length };
    }
    return { ...placement, heights: this.tileHeights() };
  }

  // "Restart battle": rebuilds every token at an EXACT, previously-recorded
  // layout (both key arrays fully populated, one per unit). Unlike beginBattle()
  // - which only re-places tokens when the roster size changed, and otherwise
  // either reuses whatever is on the board or rolls fresh random tiles for a
  // recipe-less fight - this always clears and always lands everyone back on
  // the tile they started this attempt on, with no die roll involved.
  placeUnitsAt(party, enemies, partyKeys, enemyKeys) {
    this.clearUnits();
    const noRng = { random: () => 0 };   // every key is already fixed; nothing is rolled
    const placement = this.placeUnits(party, enemies, noRng, { party: partyKeys, enemies: enemyKeys });
    this.placement = placement;
    this.placedCounts = { party: party.length, enemies: enemies.length };
    return { ...placement, heights: this.tileHeights() };
  }

  // Per-tile elevation level, keyed the way the battle engine wants it.
  tileHeights() {
    const heights = {};
    for (const tile of this.map.hexes.values()) heights[tile.key] = tile.elevation ?? 0;
    return heights;
  }

  // Wires a created battle to the scene: tokens get their engine uids (matched
  // by starting tile), tile clicks go to the engine, floaters get a DOM layer.
  bindBattle(battle, { onTileClick } = {}) {
    this.battle = battle;
    this.battleTokens = new Map();
    for (const u of battle.state.units) {
      const tok = this.tokens.find((m) => m.userData.tileKey === u.pos && m.userData.uid == null);
      if (tok) { tok.userData.uid = u.uid; this.battleTokens.set(u.uid, tok); }
    }
    this.highlights = [];
    this.tagSprites = new Map();
    this.walk = null;
    // Floating combat text lives in the DOM, projected from tile positions.
    const layer = document.createElement('div');
    layer.className = 'battle-floaters';
    document.body.appendChild(layer);
    this.floaterLayer = layer;
    // The status tooltip lives in the DOM too, positioned from the plaque's
    // projected screen box (see resolvePlaqueHover).
    const tip = document.createElement('div');
    tip.className = 'status-tip hidden';
    document.body.appendChild(tip);
    this.statusTip = tip;
    this.hoverStatus = null;
    this.setCombat(true);   // the arena is now a FIGHT: plaques show HP and statuses
    this.enableTilePicking(onTileClick ?? ((k) => battle.clickTile(k)), () => battle.cancel());
    this.syncBattle();
  }

  // Same short-press-counts-as-click pattern as enablePicking, but against the
  // TILES: the engine decides what a click on a tile means.
  //
  // The RIGHT button is the universal cancel. It has to share the button with
  // camera rotation, so the same short-press test applies: a right DRAG turns
  // the arena, a right CLICK cancels one step (an aimed ability, then an
  // inspected enemy, then the selection itself).
  enableTilePicking(onTile, onCancel) {
    this.disableTilePicking();
    const ray = new THREE.Raycaster();
    const el = this.domElement;
    let down = null;
    let rdown = null;
    const onDown = (e) => {
      if (e.button === 2) { rdown = { x: e.clientX, y: e.clientY }; return; }
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, time: performance.now() };
    };
    const onUp = (e) => {
      if (e.button === 2) {
        if (!rdown) return;
        const moved = Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y);
        rdown = null;
        // Distance alone decides, with no time limit: a right DRAG turned the
        // camera, anything else was a cancel. (The left button keeps its
        // press-duration test, but a cancel must never be swallowed because a
        // slow frame made the click "too long".)
        if (moved <= 6 && onCancel) onCancel();
        return;
      }
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.time < 600;
      down = null;
      if (moved > 6 || !quick || !this.camera) return;
      const rect = el.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(p, this.camera);
      const hit = ray.intersectObjects(this.tileMeshes ?? [], false)[0];
      if (hit) onTile(hit.object.userData.key);
    };
    // Hover: remembered here, resolved once per frame in update() (raycasts on
    // every mousemove would hammer slow machines).
    const onMove = (e) => {
      const rect = el.getBoundingClientRect();
      this.pointer = { x: ((e.clientX - rect.left) / rect.width) * 2 - 1, y: -((e.clientY - rect.top) / rect.height) * 2 + 1 };
      this.hoverDirty = true;
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    this.tileHandlers = { onDown, onUp, onMove };
  }
  disableTilePicking() {
    if (!this.tileHandlers) return;
    this.domElement.removeEventListener('pointerdown', this.tileHandlers.onDown);
    this.domElement.removeEventListener('pointerup', this.tileHandlers.onUp);
    this.domElement.removeEventListener('pointermove', this.tileHandlers.onMove);
    this.tileHandlers = null;
    this.hoverKey = null;
  }

  // Redraws everything the engine may have changed: token positions, deaths,
  // tile heights, terrain tags, and the reach / aim highlights.
  syncBattle() {
    const battle = this.battle;
    if (!battle || !this.map) return;
    const sb = battle.state;

    // Tile heights (abilities can raise / lower ground).
    for (const tile of this.map.hexes.values()) {
      const lvl = sb.heights[tile.key] ?? neutralElevation(COMBAT_CONFIG.combat.elevationLevels);
      if (lvl === (tile.elevation ?? 0)) continue;
      tile.elevation = lvl;
      const h = this.tileHeightFor(lvl);
      tile.mesh.scale.y = h;
      tile.top = h;
    }

    // Tokens: dead ones vanish, live ones stand on their engine tile.
    for (const u of sb.units) {
      const tok = this.battleTokens.get(u.uid);
      if (!tok) continue;
      const dead = u.hp <= 0;
      tok.visible = !dead;
      if (tok.userData.ring) tok.userData.ring.visible = !dead;
      if (tok.userData.plaque) this.updateUnitPlaque(tok.userData.plaque, u.hp, u.maxHp, u);
      if (dead) continue;
      if (!tok.userData.walking && tok.userData.tileKey !== u.pos) this.teleportToken(tok, u.pos);
      else {
        // Height may have changed under a standing unit.
        const tile = this.map.hexes.get(u.pos);
        if (tile && !tok.userData.walking) tok.userData.baseY = tile.top;
      }
    }

    // Terrain tags: one emoji sprite per tagged tile.
    const want = new Set(Object.keys(sb.tags));
    for (const [k, sprite] of this.tagSprites) {
      if (!want.has(k)) { this.scene.remove(sprite); this.tagSprites.delete(k); }
    }
    for (const k of want) {
      if (this.tagSprites.has(k)) continue;
      const tile = this.map.hexes.get(k);
      if (!tile) continue;
      const sprite = this.makePortrait(sb.tags[k].icon ?? '⭐');
      sprite.scale.setScalar(0.5);
      sprite.position.set(tile.x, tile.top + 0.35, -tile.y);
      this.scene.add(sprite);
      this.tagSprites.set(k, sprite);
    }

    this.syncHighlights(battle);
  }

  teleportToken(tok, key) {
    const tile = this.map.hexes.get(key);
    if (!tile) return;
    tok.userData.tileKey = key;
    tok.userData.baseY = tile.top;
    tok.position.set(tile.x, tile.top, -tile.y);
    if (tok.userData.ring) tok.userData.ring.position.set(tile.x, tile.top + 0.02, -tile.y);
  }

  // Reach (walkable tiles) and aim (castable tiles) as hex OUTLINE rings, the
  // world map's language: bright ring + dark backing so it reads on any colour,
  // pulsing; the hovered one goes solid white and its tile rises (see update()).
  syncHighlights(battle) {
    for (const m of this.highlights) this.scene.remove(m);
    this.highlights = [];
    this.hlTiles = new Map();   // key -> { ring, color, phase, tile }
    const sb = battle.state;
    if (sb.over || sb.phase !== 'player') return;
    const add = (k, color) => {
      const tile = this.map.hexes.get(k);
      if (!tile) return;
      const ring = new THREE.Mesh(
        this.hlRingGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide })
      );
      const back = new THREE.Mesh(
        this.hlRingBackGeo,
        new THREE.MeshBasicMaterial({ color: 0x0b0e16, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })
      );
      back.position.y = -0.004;
      ring.add(back);
      ring.position.set(tile.x, tile.top + 0.02, -tile.y);
      this.scene.add(ring);
      this.highlights.push(ring);
      this.hlTiles.set(k, { ring, color: new THREE.Color(color), phase: Math.random() * Math.PI * 2, tile });
    };
    if (sb.selAb && sb.aimMap) {
      // Ability targeting always highlights red, regardless of the ability's
      // own theme colour (used elsewhere for its icon) - gold stays reserved
      // for plain movement below.
      for (const k of Object.keys(sb.aimMap)) add(k, this.config.colors.abilityAimRing);
    } else if (sb.inspectReach) {
      // A clicked ENEMY: where it could walk, in its own red. Gold is the
      // party's colour, so the two readings can never be confused.
      const { d, occ } = sb.inspectReach;
      const e = sb.units.find((u) => u.uid === sb.inspectUid);
      for (const k of Object.keys(d)) {
        if (occ.has(k) || (e && k === e.pos)) continue;
        add(k, this.config.colors.enemyReachRing);
      }
    } else if (sb.reach) {
      const { d, occ } = sb.reach;
      const cur = battle.curPlayer();
      for (const k of Object.keys(d)) {
        if (occ.has(k) || (cur && k === cur.pos)) continue;
        add(k, this.config.colors.reachableRing);
      }
    }
  }

  // The engine hands each move here: slide the token tile by tile (or one long
  // glide for flyers), reporting every tile entered; enter() returning true
  // means "stop the walk here" (a trap fired, the unit died or was moved).
  runMoveAnim(anim, done) {
    const tok = this.battleTokens.get(anim.u.uid);
    if (!tok) { for (let i = 1; i < anim.path.length; i++) if (anim.enter(anim.path[i])) break; done(); return; }
    // A re-position (free player movement) walks from the round's STARTING tile:
    // snap the token back there first, reading as "the old move is taken back".
    if (tok.userData.tileKey !== anim.path[0]) this.teleportToken(tok, anim.path[0]);
    tok.userData.walking = true;
    this.walk = {
      tok, anim, done,
      i: 0,                     // segment index (path[i] -> path[i+1])
      t0: performance.now(),
      segMs: anim.fly ? 520 : 170,
    };
  }

  // Advances the walk; called from update(). Handles segment ends + early stops.
  stepWalk(now) {
    const w = this.walk;
    if (!w) return;
    const { path } = w.anim;
    const from = this.map.hexes.get(path[w.i]);
    const to = this.map.hexes.get(path[w.i + 1]);
    if (!from || !to) { this.finishWalk(); return; }
    const t = Math.min(1, (now - w.t0) / w.segMs);
    const hop = Math.sin(t * Math.PI) * (w.anim.fly ? 0.9 : 0.18);
    const x = from.x + (to.x - from.x) * t;
    const z = -from.y + (-to.y - -from.y) * t;
    const y = from.top + (to.top - from.top) * t + hop;
    w.tok.position.set(x, y, z);
    if (w.tok.userData.ring) w.tok.userData.ring.position.set(x, (from.top + (to.top - from.top) * t) + 0.02, z);
    if (t >= 1) {
      const key = path[w.i + 1];
      w.tok.userData.tileKey = key;
      w.tok.userData.baseY = to.top;
      const stop = w.anim.enter(key);
      if (stop || w.i + 2 >= path.length) { this.finishWalk(); return; }
      w.i++;
      w.t0 = performance.now();
    }
  }
  finishWalk() {
    const w = this.walk;
    this.walk = null;
    if (!w) return;
    w.tok.userData.walking = false;
    this.teleportToken(w.tok, w.anim.u.pos);   // snap exactly onto the engine's tile
    w.done();
  }

  // Where a unit is on screen, in viewport pixels - the anchor a card in the
  // party panel or the enemy roster draws its pointer line to (src/ui.js).
  // Returns null while the arena is not up, or when the body is behind the
  // camera. A party member is found by its index in game.state.party (what the
  // panel knows it by); an enemy by the engine's uid.
  partyTokenScreen(partyIndex) {
    return this.tokenScreen(this.tokens.find((m) => m.userData.partyIndex === partyIndex));
  }

  // The same, for any unit in a running fight, by the engine's uid - what an
  // enemy card in the Local Map Info panel knows its creature by.
  unitTokenScreen(uid) {
    return this.tokenScreen(this.battleTokens?.get(uid));
  }

  tokenScreen(tok) {
    if (!tok || !this.camera || !this.renderer) return null;
    const v = new THREE.Vector3(tok.position.x, tok.position.y + 0.35, tok.position.z).project(this.camera);
    if (v.z > 1) return null;   // behind the camera
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  // Floating combat text over a tile (damage, heals, statuses). Pure DOM: a span
  // that rises and fades, positioned by projecting the tile into the viewport.
  addFloater(k, text, color) {
    if (!this.floaterLayer || !this.camera) return;
    const tile = this.map.hexes.get(k);
    if (!tile) return;
    const v = new THREE.Vector3(tile.x, tile.top + 0.9, -tile.y).project(this.camera);
    if (v.z > 1) return;   // behind the camera
    const el = document.createElement('span');
    el.className = 'battle-floater';
    el.textContent = text;
    el.style.color = color ?? '#fff';
    // Stack repeats on the same tile so numbers do not print over each other.
    const n = (this.floaterStack = this.floaterStack ?? new Map());
    const cnt = (n.get(k) ?? 0) + 1;
    n.set(k, cnt);
    setTimeout(() => n.set(k, Math.max(0, (n.get(k) ?? 1) - 1)), 700);
    el.style.left = `${((v.x + 1) / 2) * window.innerWidth}px`;
    el.style.top = `${((-v.y + 1) / 2) * window.innerHeight - (cnt - 1) * 20}px`;
    this.floaterLayer.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
    setTimeout(() => el.remove(), 2400);   // fallback
  }

  // A unit leaves the board ALIVE: an enemy that broke off the fight and reached
  // the edge (engine.js escapeUnit). It gets the very same pop a consumed
  // encounter marker gets on the world map (render.js handleEncounterCleared), so
  // "gone" reads the same in both maps. `done` fires when the pop finishes.
  vanishToken(uid, done) {
    const tok = this.battleTokens?.get(uid);
    if (!tok) { done && done(); return; }
    if (tok.userData.ring) tok.userData.ring.visible = false;
    if (tok.userData.plaque) tok.userData.plaque.visible = false;
    tok.userData.walking = true;   // stop the idle bob fighting the pop
    this.vanishing = this.vanishing ?? [];
    this.vanishing.push({ tok, t: 0, ms: 320, baseY: tok.position.y, scale: tok.scale.x || 1, done });
  }

  stepVanishes(dt) {
    for (let i = this.vanishing.length - 1; i >= 0; i--) {
      const v = this.vanishing[i];
      v.t = Math.min(1, v.t + dt / v.ms);
      const x = v.t;
      const e = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;   // inOutCubic
      v.tok.scale.setScalar(v.scale * (1 + 0.6 * e) * (1 - e));
      v.tok.position.y = v.baseY + e * 1.2;
      if (v.t < 1) continue;
      v.tok.visible = false;
      v.tok.scale.setScalar(v.scale);
      this.vanishing.splice(i, 1);
      v.done && v.done();
    }
  }

  // Battle over: clean the combat chrome but leave the scene standing (the
  // results window and the fly-out still show it).
  endBattle() {
    this.setCombat(false);   // back to a quiet arena: plaques go icon-only
    this.disableTilePicking();
    for (const m of this.highlights ?? []) this.scene?.remove(m);
    this.highlights = [];
    this.hlTiles = new Map();
    if (this.map) for (const tile of this.map.hexes.values()) { tile.lift = 0; if (tile.mesh) tile.mesh.position.y = 0; }
    for (const s of (this.tagSprites ?? new Map()).values()) this.scene?.remove(s);
    this.tagSprites = new Map();
    if (this.walk) { this.walk.tok.userData.walking = false; this.walk = null; }
    if (this.floaterLayer) { this.floaterLayer.remove(); this.floaterLayer = null; }
    if (this.statusTip) { this.statusTip.remove(); this.statusTip = null; }
    this.hoverStatus = null;
    for (const v of this.vanishing ?? []) { v.tok.visible = false; v.done && v.done(); }
    this.vanishing = [];
    this.battle = null;
    this.battleTokens = new Map();
  }

  buildCamera() {
    const pose = this.finalCameraPose();
    const w = this.domElement.clientWidth || window.innerWidth;
    const h = this.domElement.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(pose.fov, w / h, 0.1, 300);
    this.camera.position.copy(pose.position);
    this.camera.lookAt(pose.target);
  }

  // Where the camera settles - the arena's resting pose. The start screen (the
  // campfire) has its own, closer, composed shot; this is also the pose the
  // fly-out to the world map starts from, so the two always agree.
  finalCameraPose() {
    const isCamp = this.layout === 'camp';
    const cam = isCamp
      ? { ...this.config.local.camera, ...(this.config.local.startCamera ?? {}) }
      : this.config.local.camera;
    const tilt = deg(cam.tiltDegrees);
    const az = isCamp ? deg(cam.azimuthDegrees ?? 0) : (this.worldAzimuth ?? 0);
    // Aim at the tiles' baseline top (the arena floor now rises with the world
    // tile's type), plus the composed offset on the start screen.
    const height = (this.baseTileHeight ?? 0) + (isCamp ? (cam.targetHeight ?? 0) : 0);
    const ground = cam.distance * Math.sin(tilt);   // how far out in the XZ plane
    return {
      position: new THREE.Vector3(ground * Math.sin(az), height + cam.distance * Math.cos(tilt), ground * Math.cos(az)),
      target: new THREE.Vector3(0, height, 0),
      fov: cam.fov,
    };
  }
  // True while the current shot is a locked one (the start screen).
  controlsLocked() {
    return this.layout === 'camp' && (this.config.local.startCamera?.lockControls ?? false);
  }
  // Where the camera is at the moment of the world -> local swap: high above the
  // arena, looking straight down, as if still falling through the clouds.
  overheadCameraPose() {
    return { position: new THREE.Vector3(0, 34, 2.5), target: new THREE.Vector3(0, 0, 0), fov: 78 };
  }

  // Rotation only: no panning, no zooming (the arena is one screen).
  // A locked shot (the start screen) gets no controls at all.
  activate() {
    if (this.controls) this.controls.dispose();
    this.controls = null;
    if (this.controlsLocked()) return;
    const cam = this.config.local.camera;
    const controls = new MapControls(this.camera, this.domElement);
    controls.target.set(0, this.baseTileHeight ?? 0, 0);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minPolarAngle = deg(cam.minTiltDegrees);
    controls.maxPolarAngle = deg(cam.maxTiltDegrees);
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE };
    controls.update();
    this.controls = controls;
  }
  deactivate() {
    if (this.controls) { this.controls.dispose(); this.controls = null; }
  }

  resize(aspect) {
    if (!this.camera) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  // ----- the layer-switch camera roll (start screen) -------------------------
  // The camera rotates a full 360 degrees around its own FORWARD axis - the
  // line from the camera through the campfire, laid flat at ground level.
  // Rolling around that line sweeps the camera sideways, down UNDER the arena
  // floor and back up the other side, while the shot stays aimed at the fire:
  // on screen the whole world rotates, the ground swallows the camera, and it
  // surfaces again into the same composed pose. At the halfway point (fully
  // underground, nothing recognisable on screen) onHalf fires - that is where
  // main.js swaps the worldflake layer, so the camera comes up over the new
  // palette. The base pose is captured ONCE and re-applied at the end, so the
  // roll survives the mid-roll scene rebuild (the rebuilt campfire composes
  // the same shot; only the camera object is new, and stepLayerRoll always
  // drives whichever camera is current).
  //
  // Two purely-DOM effects ride along with the roll, both driven every frame
  // from the same progress values as the camera (see stepLayerRoll below), so
  // they always land on the exact moment they were asked for, whatever the
  // easing curve does to time:
  //   - a pure-black wipe with a soft edge (#layer-wipe in index.html) sweeps
  //     the screen right-to-left, solid by 90 degrees ("under the ground"),
  //     and uncovers the same right-to-left way starting at 270 degrees
  //     ("emerging");
  //   - the HUD (#hud) fades out across the first slice of the roll and back
  //     in across the last slice, so no button is visible (or clickable)
  //     while the world is spinning.
  startLayerRoll({ durationMs = 5200, onHalf = null, onDone = null } = {}) {
    if (this.layerRoll || !this.camera) return false;
    const pose = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), up: this.camera.up.clone() };
    const axis = new THREE.Vector3();
    this.camera.getWorldDirection(axis);
    axis.y = 0;
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, -1);
    axis.normalize();
    // The fire sits at the arena's centre; ground level = the tiles' baseline top.
    const pivot = new THREE.Vector3(0, this.baseTileHeight ?? 0, 0);
    this.layerRoll = { t0: performance.now(), dur: durationMs, pose, axis, pivot, halfFired: false, onHalf, onDone };
    return true;
  }
  stepLayerRoll() {
    const r = this.layerRoll;
    if (!r || !this.camera) return;
    const t = Math.min(1, (performance.now() - r.t0) / r.dur);
    const e = t * t * (3 - 2 * t);              // smoothstep: eases in, fast underground, eases out
    const angle = e * Math.PI * 2;
    this.updateLayerRollWipe(angle);
    this.updateLayerRollFade(t);
    if (!r.halfFired && angle >= Math.PI) {
      r.halfFired = true;
      // The swap rebuilds the scene (and the camera object) under us; the roll
      // state survives on the instance and keeps driving the new camera.
      if (r.onHalf) r.onHalf();
    }
    if (t >= 1) {
      this.camera.position.copy(r.pose.pos);
      this.camera.quaternion.copy(r.pose.quat);
      this.camera.up.copy(r.pose.up);
      this.layerRoll = null;
      this.clearLayerRollDom();
      if (r.onDone) r.onDone();
      return;
    }
    const q = new THREE.Quaternion().setFromAxisAngle(r.axis, angle);
    this.camera.position.copy(r.pose.pos).sub(r.pivot).applyQuaternion(q).add(r.pivot);
    this.camera.quaternion.copy(q).multiply(r.pose.quat);
    this.camera.up.copy(r.pose.up).applyQuaternion(q);
  }

  // Grabs (once) the static DOM pieces the roll's side effects touch. Lazy,
  // because a LocalMapView can exist before index.html's body has settled.
  ensureLayerRollDom() {
    if (this._wipeInited) return;
    this._wipeInited = true;
    this._wipeRoot = document.getElementById('layer-wipe');
    this._wipeFill = document.getElementById('layer-wipe-fill');
    this._wipeEdge = document.getElementById('layer-wipe-edge');
    this._hud = document.getElementById('hud');
  }

  // angle: the roll's current angle in radians, 0 at the start of the roll to
  // 2*PI at the end (see stepLayerRoll). Positions the solid fill and its
  // soft feather edge so the black wipe is exactly solid at PI/2 (90 degrees)
  // and exactly gone again at 2*PI, starting its uncover at 3*PI/2 (270
  // degrees) - both sweeps moving the same way, right to left, only which
  // side of the moving edge is "already black" flips between them.
  updateLayerRollWipe(angle) {
    this.ensureLayerRollDom();
    if (!this._wipeRoot || !this._wipeFill || !this._wipeEdge) return;
    this._wipeRoot.classList.remove('hidden');
    const QUARTER = Math.PI / 2;
    const vw = window.innerWidth;
    const feather = Math.min(140, vw * 0.1);
    const place = (fillLeft, fillRight, edgeLeft, edgeGrad) => {
      this._wipeFill.style.left = `${fillLeft}px`;
      this._wipeFill.style.right = `${fillRight}px`;
      this._wipeEdge.style.left = `${edgeLeft}px`;
      this._wipeEdge.style.width = `${feather}px`;
      this._wipeEdge.style.background = edgeGrad;
    };
    if (angle <= QUARTER) {
      // Covering: a soft-edged black block enters from the right and grows
      // leftward, its leading (left) edge sweeping right -> left, landing
      // solid across the whole screen exactly when angle hits 90 degrees.
      const p = angle / QUARTER;
      const boundary = vw + feather - p * (vw + 2 * feather);
      place(boundary, 0, boundary - feather, 'linear-gradient(to right, transparent, #000)');
    } else if (angle < 3 * QUARTER) {
      // Fully underground: solid black, nothing left to animate.
      place(0, 0, -feather, 'linear-gradient(to right, transparent, #000)');
    } else {
      // Uncovering: the exact same right -> left sweep, but now the CLEAR
      // area (already swept, to the right of the moving edge) is the one
      // eating into the black, so the right side of the screen clears first.
      const p2 = Math.min(1, (angle - 3 * QUARTER) / QUARTER);
      const boundary = vw + feather - p2 * (vw + 2 * feather);
      place(0, Math.max(0, vw - boundary), boundary, 'linear-gradient(to right, #000, transparent)');
    }
  }

  // t: raw 0..1 progress through the whole roll, NOT eased - the HUD
  // cross-fade is plain and linear, independent of the camera's easing curve.
  updateLayerRollFade(t) {
    this.ensureLayerRollDom();
    if (!this._hud) return;
    const FADE = 0.12;   // fraction of the roll spent fading each way
    let a = 0;
    if (t < FADE) a = 1 - t / FADE;
    else if (t > 1 - FADE) a = (t - (1 - FADE)) / FADE;
    this._hud.style.opacity = String(a);
    this._hud.style.pointerEvents = a > 0.98 ? '' : 'none';
  }

  // Called once the roll finishes: hides the wipe and hands the HUD back.
  clearLayerRollDom() {
    this.ensureLayerRollDom();
    if (this._wipeRoot) this._wipeRoot.classList.add('hidden');
    if (this._hud) { this._hud.style.opacity = ''; this._hud.style.pointerEvents = ''; }
  }

  // Called every frame while the local map is on screen.
  // Which status badge (if any) the cursor is over, and the tooltip for it.
  //
  // Sprites always face the camera and are never rolled, so their screen shape
  // is an axis-aligned rectangle: project the centre, then project a point one
  // half-width along the camera's right vector and one half-height along its up
  // vector, and the box follows. That is cheaper and steadier than raycasting
  // sprites, and it gives the exact pixel box each badge occupies inside the
  // plaque's canvas. Returns true when the cursor is on a badge.
  resolvePlaqueHover() {
    const tip = this.statusTip;
    if (!tip || !this.camera || !this.pointer) return false;
    const rect = this.domElement.getBoundingClientRect();
    const px = ((this.pointer.x + 1) / 2) * rect.width + rect.left;
    const py = ((-this.pointer.y + 1) / 2) * rect.height + rect.top;

    const centre = new THREE.Vector3();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const toScreen = (v) => {
      const p = v.clone().project(this.camera);
      return { x: ((p.x + 1) / 2) * rect.width + rect.left, y: ((-p.y + 1) / 2) * rect.height + rect.top, z: p.z };
    };

    for (const tok of this.tokens) {
      const plaque = tok.userData.plaque;
      if (!plaque || !tok.visible || !plaque.userData.hotspots?.length) continue;
      plaque.getWorldPosition(centre);
      const c = toScreen(centre);
      if (c.z > 1) continue;                               // behind the camera
      const e = toScreen(centre.clone().addScaledVector(right, plaque.scale.x / 2));
      const n = toScreen(centre.clone().addScaledVector(up, plaque.scale.y / 2));
      const halfW = Math.abs(e.x - c.x), halfH = Math.abs(n.y - c.y);
      if (halfW < 1 || halfH < 1) continue;
      if (px < c.x - halfW || px > c.x + halfW || py < c.y - halfH || py > c.y + halfH) continue;
      // Inside the plaque: turn the cursor into canvas design units.
      const u = ((px - (c.x - halfW)) / (halfW * 2)) * PLAQUE.w;
      const v = ((py - (c.y - halfH)) / (halfH * 2)) * PLAQUE.h;
      const hs = plaque.userData.hotspots.find((h) => u >= h.x0 && u <= h.x1 && v >= h.y0 && v <= h.y1);
      if (!hs) continue;
      tip.innerHTML = statusTipHtml(hs);
      tip.classList.remove('hidden');
      // Above the badge, clamped into the viewport.
      const bx = c.x - halfW + ((hs.x0 + hs.x1) / 2 / PLAQUE.w) * halfW * 2;
      const byTop = c.y - halfH + (hs.y0 / PLAQUE.h) * halfH * 2;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = `${Math.max(6, Math.min(window.innerWidth - tw - 6, bx - tw / 2))}px`;
      tip.style.top = `${Math.max(6, byTop - th - 8)}px`;
      this.hoverStatus = hs.id;
      return true;
    }
    tip.classList.add('hidden');
    this.hoverStatus = null;
    return false;
  }

  update(dt) {
    this.elapsed += dt;
    this.stepLayerRoll();
    if (this.controls) this.controls.update();
    if (this.walk) this.stepWalk(performance.now());
    if (this.vanishing && this.vanishing.length) this.stepVanishes(dt);
    for (const m of this.tokens) {
      if (m.userData.walking || !m.visible) continue;
      m.position.y = m.userData.baseY + Math.sin(this.elapsed / 620 + m.userData.phase) * 0.05;
      m.rotation.y += dt * 0.0006;
    }
    // Which tile the cursor is over, resolved once per frame (raycasting on
    // every mousemove would hammer slow machines). Needed by the fight AND by
    // the deployment step before it.
    if ((this.battle || this.deploy) && this.hoverDirty && this.camera && this.pointer) {
      this.hoverDirty = false;
      // A status badge under the cursor wins over the tile behind it.
      const onBadge = this.battle ? this.resolvePlaqueHover() : false;
      this.hoverRay = this.hoverRay ?? new THREE.Raycaster();
      this.hoverRay.setFromCamera(new THREE.Vector2(this.pointer.x, this.pointer.y), this.camera);
      const hit = onBadge ? null : this.hoverRay.intersectObjects(this.tileMeshes ?? [], false)[0];
      this.hoverKey = hit ? hit.object.userData.key : null;
    }
    if (this.deploy) this.stepDeployDecal();
    // The active combatant's ground ring breathes so the player sees whose turn it is.
    if (this.battle) {
      const activeUid = this.battle.state.activeUid;
      for (const [uid, tok] of this.battleTokens) {
        const ring = tok.userData.ring;
        if (!ring) continue;
        const active = uid === activeUid;
        const s = active ? 1 + Math.sin(this.elapsed / 240) * 0.25 : 1;
        ring.scale.setScalar(s);
        ring.material.opacity = active ? 0.95 : 0.5;
      }
      // The hovered tile rises and its ring goes solid white (world-map feedback).
      const c = this.config.colors;
      for (const tile of this.map.hexes.values()) {
        const hl = this.hlTiles ? this.hlTiles.get(tile.key) : null;
        const isHover = !!hl && tile.key === this.hoverKey;
        const target = isHover ? 0.12 : 0;
        tile.lift = (tile.lift ?? 0) + (target - (tile.lift ?? 0)) * Math.min(1, dt / 60);
        if (tile.lift < 0.0005 && !hl) {
          if (tile.mesh.position.y !== 0) tile.mesh.position.y = 0;
          continue;
        }
        tile.mesh.position.y = tile.lift;
        if (hl) {
          hl.ring.position.y = tile.top + 0.02 + tile.lift;
          hl.ring.material.color.set(isHover ? c.hoverRing : hl.color);
          hl.ring.material.opacity = isHover ? 1 : 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(this.elapsed / 260 + hl.phase));
        }
      }
    }
    if (this.campfire) {
      // The flame breathes and the light jitters like a real fire.
      const f = 1 + Math.sin(this.elapsed / 130) * 0.12 + Math.sin(this.elapsed / 47) * 0.07;
      this.campfire.flame.scale.set(f, 1.6 - f * 0.5, f);
      this.campfire.core.scale.setScalar(0.8 + f * 0.25);
      this.campfire.light.intensity = 11 + Math.random() * 5;
    }
  }

  render() {
    if (this.scene && this.camera) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.noContextMenu) {
      this.domElement.removeEventListener('contextmenu', this.noContextMenu);
      this.noContextMenu = null;
    }
    this.deactivate();
    this.disablePicking();
    this.cancelDeployment();
    this.deployPending = null;
    this.voidEdges = null;
    this.endBattle();
    this.tileMeshes = [];
    if (this.hlRingGeo) { this.hlRingGeo.dispose(); this.hlRingGeo = null; }
    if (this.hlRingBackGeo) { this.hlRingBackGeo.dispose(); this.hlRingBackGeo = null; }
    if (this.scene) {
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this.scene = null;
    this.map = null;
    this.tokens = [];
    this.campfire = null;
    this.campSeats = null;
    this.layout = null;
    this.placement = null;      // the next arena rolls its own starting positions
    this.placedCounts = null;
    this.inCombat = false;
    // portraitCache is deliberately kept: the traverse above disposes the
    // per-sprite materials but never the textures, and one small texture per
    // glyph is worth reusing for the whole session.
  }
}
