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
import { generateLocalMap, pickRandomTiles, applyElevationWave } from './localmap.js';
import { COMBAT_CONFIG } from '../config/abilities.js';
import { createRng } from '../rng.js';

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
  build({ worldHex, baseColor, party, enemies, seed, recipe = null, layout = 'battle', neighbors = [] }) {
    this.dispose();
    const cfg = this.config.local;
    const rng = createRng((seed ?? 1) ^ ((worldHex?.q ?? 0) * 73856093) ^ ((worldHex?.r ?? 0) * 19349663));
    this.rng = rng;

    this.layout = layout;
    this.map = generateLocalMap(this.config, recipe);
    // Battle arenas get rolling tile heights (high ground matters in combat);
    // the campfire start screen stays flat and calm.
    if (layout !== 'camp') applyElevationWave(this.map, () => rng.random(), COMBAT_CONFIG.combat.elevationLevels);
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
    floor.position.y = -30;
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
      const h = this.baseTileHeight + (tile.elevation ?? 0) * (cfg.elevationStep ?? 0.35);
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

    if (layout === 'camp') {
      this.buildCampfire();
      this.placeCampParty(party ?? []);
    } else {
      this.placeUnits(party ?? [], enemies ?? [], rng);
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
    // A little portrait floating over the head, so the three identical capsules
    // can be told apart at a glance. A Sprite always faces the camera, so it
    // stays readable however the shot is rotated.
    if (unit?.icon) body.add(this.makePortrait(unit.icon));
    const bar = this.makeHealthBar();
    body.add(bar);
    body.userData.healthBar = bar;
    this.updateHealthBar(bar, unit?.hp, unit?.maxHp);
    this.attachToken(tileKey, body, c.playerGlow, (this.rng?.random() ?? Math.random()) * Math.PI * 2);
  }

  // The unit's glyph drawn onto a canvas and hung above it as a billboard.
  // Textures are cached per glyph: three units sharing an icon share one texture.
  makePortrait(glyph) {
    this.portraitCache = this.portraitCache ?? new Map();
    let tex = this.portraitCache.get(glyph);
    if (!tex) {
      const size = 128;
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const g = cv.getContext('2d');
      // A dark rounded plate behind the glyph: without it a light emoji
      // disappears against a pale tile.
      g.fillStyle = 'rgba(10, 14, 24, 0.72)';
      roundRect(g, 6, 6, size - 12, size - 12, 26);
      g.fill();
      g.strokeStyle = 'rgba(255, 209, 102, 0.75)';
      g.lineWidth = 5;
      roundRect(g, 6, 6, size - 12, size - 12, 26);
      g.stroke();
      g.font = `${Math.round(size * 0.58)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(glyph, size / 2, size / 2 + 2);
      tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.portraitCache.set(glyph, tex);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.setScalar(0.42);
    sprite.position.set(0, 1.0, 0);
    sprite.renderOrder = 10;   // always drawn on top, never buried in a tile
    return sprite;
  }

  // A small health bar hovering just under a unit's portrait, in the same
  // billboard cluster above its token (party AND enemies alike). Unlike the
  // portrait it is NOT shared/cached - every unit has its own HP - but the
  // canvas is only redrawn when the value actually changes, not every frame.
  makeHealthBar() {
    const w = 96, h = 20;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(0.46, 0.46 * (h / w), 1);
    sprite.position.set(0, 0.72, 0);   // just below the portrait plate (at y 1.0)
    sprite.renderOrder = 10;
    sprite.userData.canvas = cv;
    sprite.userData.ctx = cv.getContext('2d');
    sprite.userData.tex = tex;
    sprite.userData.hp = undefined;
    sprite.userData.maxHp = undefined;
    return sprite;
  }

  // Redraws a health bar sprite for the given hp/maxHp - a no-op if neither
  // changed since the last call. Colour steps from green through amber to red
  // as the fraction empties, on a dark track (readable on any tile colour).
  updateHealthBar(bar, hp, maxHp) {
    if (!bar) return;
    const clampedHp = Math.max(0, hp ?? 0);
    const safeMax = Math.max(0, maxHp ?? 0);
    if (bar.userData.hp === clampedHp && bar.userData.maxHp === safeMax) return;
    bar.userData.hp = clampedHp;
    bar.userData.maxHp = safeMax;
    const cv = bar.userData.canvas;
    const g = bar.userData.ctx;
    const w = cv.width, h = cv.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(10, 14, 24, 0.72)';
    roundRect(g, 1, 1, w - 2, h - 2, 6);
    g.fill();
    const pad = 3;
    const innerW = w - pad * 2, innerH = h - pad * 2;
    const frac = safeMax > 0 ? Math.max(0, Math.min(1, clampedHp / safeMax)) : 0;
    g.fillStyle = 'rgba(255, 255, 255, 0.14)';
    roundRect(g, pad, pad, innerW, innerH, 3);
    g.fill();
    if (frac > 0) {
      g.fillStyle = frac > 0.5 ? '#8fe05f' : frac > 0.25 ? '#ffd166' : '#ff4d4d';
      roundRect(g, pad, pad, Math.max(2, innerW * frac), innerH, 3);
      g.fill();
    }
    bar.userData.tex.needsUpdate = true;
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
  placeUnits(party, enemies, rng) {
    const used = new Set();
    const partyKeys = pickRandomTiles(this.map, party.length, () => rng.random(), used);
    partyKeys.forEach((k) => used.add(k));
    const enemyKeys = pickRandomTiles(this.map, enemies.length, () => rng.random(), used);

    party.forEach((u, i) => this.addPartyToken(u, i, partyKeys[i]));
    const enemyColor = this.config.encounters.visuals.battle?.color ?? 0xe2474b;
    enemies.forEach((u, i) => {
      const body = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.28),
        new THREE.MeshStandardMaterial({ color: enemyColor, emissive: 0x330b0b, roughness: 0.45 })
      );
      body.geometry.translate(0, 0.45, 0);
      // Enemies have no emoji; their portrait plate shows the name's initial.
      body.add(this.makePortrait((u.name ?? '?').charAt(0)));
      const bar = this.makeHealthBar();
      body.add(bar);
      body.userData.healthBar = bar;
      this.updateHealthBar(bar, u?.hp, u?.maxHp);
      this.attachToken(enemyKeys[i], body, enemyColor, rng.random() * Math.PI * 2);
    });
    return { partyKeys, enemyKeys };
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

  // Re-places both sides for the actual battle and reports the layout the
  // engine needs: who stands where, and each tile's elevation level.
  beginBattle({ party, enemies }) {
    this.clearUnits();
    const rng = this.rng ?? { random: Math.random };
    const placement = this.placeUnits(party, enemies, rng);
    const heights = {};
    for (const tile of this.map.hexes.values()) heights[tile.key] = tile.elevation ?? 0;
    return { ...placement, heights };
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
    this.enableTilePicking(onTileClick ?? ((k) => battle.clickTile(k)));
    this.syncBattle();
  }

  // Same short-press-counts-as-click pattern as enablePicking, but against the
  // TILES: the engine decides what a click on a tile means.
  enableTilePicking(onTile) {
    this.disableTilePicking();
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
    const cfg = this.config.local;
    for (const tile of this.map.hexes.values()) {
      const lvl = sb.heights[tile.key] ?? 0;
      if (lvl === (tile.elevation ?? 0)) continue;
      tile.elevation = lvl;
      const h = Math.max(0.05, (this.baseTileHeight ?? cfg.tileHeight) + lvl * (cfg.elevationStep ?? 0.35));
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
      if (tok.userData.healthBar) this.updateHealthBar(tok.userData.healthBar, u.hp, u.maxHp);
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

  // Battle over: clean the combat chrome but leave the scene standing (the
  // results window and the fly-out still show it).
  endBattle() {
    this.disableTilePicking();
    for (const m of this.highlights ?? []) this.scene?.remove(m);
    this.highlights = [];
    this.hlTiles = new Map();
    if (this.map) for (const tile of this.map.hexes.values()) { tile.lift = 0; if (tile.mesh) tile.mesh.position.y = 0; }
    for (const s of (this.tagSprites ?? new Map()).values()) this.scene?.remove(s);
    this.tagSprites = new Map();
    if (this.walk) { this.walk.tok.userData.walking = false; this.walk = null; }
    if (this.floaterLayer) { this.floaterLayer.remove(); this.floaterLayer = null; }
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
    const az = isCamp ? deg(cam.azimuthDegrees ?? 0) : 0;
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

  // Called every frame while the local map is on screen.
  update(dt) {
    this.elapsed += dt;
    if (this.controls) this.controls.update();
    if (this.walk) this.stepWalk(performance.now());
    for (const m of this.tokens) {
      if (m.userData.walking || !m.visible) continue;
      m.position.y = m.userData.baseY + Math.sin(this.elapsed / 620 + m.userData.phase) * 0.05;
      m.rotation.y += dt * 0.0006;
    }
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
      // Hover over highlighted tiles: resolve the pick once per frame, then let
      // the hovered tile rise and its ring go solid white (world-map feedback).
      if (this.hoverDirty && this.camera && this.pointer) {
        this.hoverDirty = false;
        this.hoverRay = this.hoverRay ?? new THREE.Raycaster();
        this.hoverRay.setFromCamera(new THREE.Vector2(this.pointer.x, this.pointer.y), this.camera);
        const hit = this.hoverRay.intersectObjects(this.tileMeshes ?? [], false)[0];
        this.hoverKey = hit ? hit.object.userData.key : null;
      }
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
    this.deactivate();
    this.disablePicking();
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
    // portraitCache is deliberately kept: the traverse above disposes the
    // per-sprite materials but never the textures, and one small texture per
    // glyph is worth reusing for the whole session.
  }
}
