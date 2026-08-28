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
import { generateLocalMap, pickRandomTiles } from './localmap.js';
import { createRng } from '../rng.js';

const SQRT3 = Math.sqrt(3);
const deg = (d) => (d * Math.PI) / 180;

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

    this.map = generateLocalMap(this.config, recipe);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.config.colors.background);
    this.scene.fog = new THREE.Fog(this.config.colors.background, 26, 70);

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
      new THREE.MeshStandardMaterial({ color: this.config.colors.ground, roughness: 1 })
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
    for (const tile of this.map.hexes.values()) {
      const mat = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.9 + rng.random() * 0.2), roughness: 0.85 });
      const mesh = new THREE.Mesh(geo, mat);
      const h = cfg.tileHeight + (tile.elevation ?? 0);
      mesh.scale.y = Math.max(0.05, h);
      mesh.position.set(tile.x, 0, -tile.y);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      tile.mesh = mesh;
      tile.top = Math.max(0.05, h);
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

  // Seats the living party on alternating tiles of the first ring, facing the fire.
  placeCampParty(party) {
    const seats = ['1,0', '-1,1', '0,-1', '1,-1', '-1,0', '0,1'];
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
    this.attachToken(tileKey, body, c.playerGlow, (this.rng?.random() ?? Math.random()) * Math.PI * 2);
  }

  attachToken(tileKey, mesh, lightColor, phase) {
    const tile = this.map.hexes.get(tileKey);
    if (!tile) return;
    mesh.position.set(tile.x, tile.top, -tile.y);
    mesh.castShadow = true;
    mesh.userData.baseY = tile.top;
    mesh.userData.phase = phase;
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

  // For now units land on random distinct tiles - the encounter itself is still
  // resolved by the world-side simulation; these tokens are the stage dressing.
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
      this.attachToken(enemyKeys[i], body, enemyColor, rng.random() * Math.PI * 2);
    });
  }

  buildCamera() {
    const cam = this.config.local.camera;
    const w = this.domElement.clientWidth || window.innerWidth;
    const h = this.domElement.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(cam.fov, w / h, 0.1, 300);
    const pose = this.finalCameraPose();
    this.camera.position.copy(pose.position);
    this.camera.lookAt(0, 0, 0);
  }

  // Where the camera settles after the fly-in.
  finalCameraPose() {
    const cam = this.config.local.camera;
    const tilt = deg(cam.tiltDegrees);
    return {
      position: new THREE.Vector3(0, cam.distance * Math.cos(tilt), cam.distance * Math.sin(tilt)),
      target: new THREE.Vector3(0, 0, 0),
      fov: cam.fov,
    };
  }
  // Where the camera is at the moment of the world -> local swap: high above the
  // arena, looking straight down, as if still falling through the clouds.
  overheadCameraPose() {
    return { position: new THREE.Vector3(0, 34, 2.5), target: new THREE.Vector3(0, 0, 0), fov: 78 };
  }

  // Rotation only: no panning, no zooming (the arena is one screen).
  activate() {
    if (this.controls) this.controls.dispose();
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
    for (const m of this.tokens) {
      m.position.y = m.userData.baseY + Math.sin(this.elapsed / 620 + m.userData.phase) * 0.05;
      m.rotation.y += dt * 0.0006;
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
  }
}
