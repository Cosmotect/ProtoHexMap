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
  build({ worldHex, baseColor, party, enemies, seed, recipe = null, layout = 'battle' }) {
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
    this.tileMeshes = [];
    for (const tile of this.map.hexes.values()) {
      const mat = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.9 + rng.random() * 0.2), roughness: 0.85 });
      const mesh = new THREE.Mesh(geo, mat);
      const h = cfg.tileHeight + (tile.elevation ?? 0) * (cfg.elevationStep ?? 0.35);
      mesh.scale.y = Math.max(0.05, h);
      mesh.position.set(tile.x, 0, -tile.y);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.key = tile.key;
      this.scene.add(mesh);
      tile.mesh = mesh;
      tile.top = Math.max(0.05, h);
      this.tileMeshes.push(mesh);
    }

    if (layout === 'camp') {
      this.buildCampfire();
      this.placeCampParty(party ?? []);
    } else {
      this.placeUnits(party ?? [], enemies ?? [], rng);
    }
    this.buildCamera();
    return this.map;
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
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    this.tileHandlers = { onDown, onUp };
  }
  disableTilePicking() {
    if (!this.tileHandlers) return;
    this.domElement.removeEventListener('pointerdown', this.tileHandlers.onDown);
    this.domElement.removeEventListener('pointerup', this.tileHandlers.onUp);
    this.tileHandlers = null;
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
      const h = Math.max(0.05, cfg.tileHeight + lvl * (cfg.elevationStep ?? 0.35));
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

  // Reach (walkable tiles) and aim (castable tiles) as translucent hex plates.
  syncHighlights(battle) {
    for (const m of this.highlights) this.scene.remove(m);
    this.highlights = [];
    const sb = battle.state;
    if (sb.over || sb.phase !== 'player') return;
    const add = (k, color, opacity) => {
      const tile = this.map.hexes.get(k);
      if (!tile) return;
      if (!this.hlGeo) {
        this.hlGeo = new THREE.CylinderGeometry(this.config.local.hexSize * 0.86, this.config.local.hexSize * 0.86, 0.04, 6, 1);
        if (this.map.orientation === 'flat') this.hlGeo.rotateY(Math.PI / 6);
      }
      const m = new THREE.Mesh(this.hlGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      m.position.set(tile.x, tile.top + 0.03, -tile.y);
      this.scene.add(m);
      this.highlights.push(m);
    };
    if (sb.selAb && sb.aimMap) {
      const ab = battle.abilityById(sb.selAb);
      const color = new THREE.Color(ab?.color ?? '#ffd166').getHex();
      for (const k of Object.keys(sb.aimMap)) add(k, color, 0.38);
    } else if (sb.reach) {
      const { d, occ } = sb.reach;
      const cur = battle.curPlayer();
      for (const k of Object.keys(d)) {
        if (occ.has(k) || (cur && k === cur.pos)) continue;
        add(k, 0xffd166, 0.25);
      }
    }
  }

  // The engine hands each move here: slide the token tile by tile (or one long
  // glide for flyers), reporting every tile entered; enter() returning true
  // means "stop the walk here" (a trap fired, the unit died or was moved).
  runMoveAnim(anim, done) {
    const tok = this.battleTokens.get(anim.u.uid);
    if (!tok) { for (let i = 1; i < anim.path.length; i++) if (anim.enter(anim.path[i])) break; done(); return; }
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
    const height = isCamp ? (cam.targetHeight ?? 0) : 0;
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
    controls.target.set(0, 0, 0);
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
    if (this.hlGeo) { this.hlGeo.dispose(); this.hlGeo = null; }
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
