// Everything that draws pixels lives here (Three.js scene, camera, input picking).
// The renderer never changes game rules: it listens to Game events and shows them.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { tween, cancelTween, Ease, updateTweens } from './tween.js';
import { hexDistance } from './hex.js';

const SQRT3 = Math.sqrt(3);
const deg = (d) => (d * Math.PI) / 180;

export class MapRenderer {
  constructor(container, config) {
    this.container = container;
    this.config = config;
    this.elapsed = 0;
    this.busy = false;              // true while the player token is hopping
    this.hover = null;              // hex under the mouse
    this.reachable = new Set();     // keys of hexes the player can step to
    this.tiles = new Map();         // hex key -> tile record
    this.tileMeshes = [];
    this.onHexClick = null;         // callbacks set by main.js
    this.onHexHover = null;
    this.followTween = null;

    // --- renderer -----------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';

    // --- scene --------------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(config.colors.background);
    // "Atmosphere" fog: distant tiles fade into the background (not the gameplay fog of war).
    this.atmosphere = new THREE.Fog(config.colors.background, 30, 80);
    this.scene.fog = this.atmosphere;
    this.timer = new THREE.Timer();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-10, -10);
    this.hoverDirty = false;

    this.setupLights();
    this.buildSharedGeometry();
    this.cameraMode = config.camera.mode;
    this.setupCamera(this.cameraMode, new THREE.Vector3(0, 0, 0));

    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ===================================================================
  //  Setup
  // ===================================================================
  setupLights() {
    const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x3b2f2a, 1.1);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
    sun.position.set(12, 22, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: this.config.colors.ground, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  buildSharedGeometry() {
    const { hexSize, gap, orientation } = this.config.map;
    const radius = hexSize - gap / SQRT3; // corner radius that leaves "gap" between tile edges
    this.tileRadius = radius;

    // Height 1 so we can scale Y per tile to get different thicknesses.
    const tileGeo = new THREE.CylinderGeometry(radius, radius, 1, 6, 1);
    tileGeo.translate(0, 0.5, 0); // bottom of the tile sits on y = 0
    if (orientation === 'flat') tileGeo.rotateY(Math.PI / 6);
    this.tileGeo = tileGeo;

    const ringStart = orientation === 'flat' ? 0 : Math.PI / 6;
    const ringGeo = new THREE.RingGeometry(radius * 0.78, radius * 0.93, 6, 1, ringStart);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringGeo = ringGeo;
    // A dark backing ring sits just under the bright one so it reads on every terrain colour.
    const ringBackGeo = new THREE.RingGeometry(radius * 0.72, radius * 0.97, 6, 1, ringStart);
    ringBackGeo.rotateX(-Math.PI / 2);
    this.ringBackGeo = ringBackGeo;
    this.ringBackMat = new THREE.MeshBasicMaterial({
      color: 0x0b0e16, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
    });

    this.markerGeos = {
      octahedron: new THREE.OctahedronGeometry(0.3),
      icosahedron: new THREE.IcosahedronGeometry(0.3),
      box: new THREE.BoxGeometry(0.42, 0.42, 0.42),
      cone: new THREE.ConeGeometry(0.3, 0.62, 14),
      dodecahedron: new THREE.DodecahedronGeometry(0.3),
    };
  }

  setupCamera(mode, target) {
    const cfg = this.config.camera;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const aspect = w / h;

    if (this.controls) this.controls.dispose();

    let camera;
    let tilt;
    let distance;
    if (mode === 'orthographic') {
      const vh = cfg.orthoViewHeight;
      camera = new THREE.OrthographicCamera(-vh * aspect / 2, vh * aspect / 2, vh / 2, -vh / 2, -200, 400);
      tilt = deg(cfg.orthoTiltDegrees);
      distance = 40; // irrelevant for size in orthographic mode, only for depth
    } else {
      camera = new THREE.PerspectiveCamera(cfg.fov, aspect, 0.1, 400);
      tilt = deg(cfg.tiltDegrees);
      distance = cfg.distance;
    }
    camera.position.set(
      target.x,
      target.y + distance * Math.cos(tilt),
      target.z + distance * Math.sin(tilt)
    );
    camera.lookAt(target);

    const controls = new MapControls(camera, this.renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.zoomToCursor = mode !== 'orthographic';
    controls.keyPanSpeed = 24;
    controls.listenToKeyEvents(window);
    if (mode === 'orthographic') {
      controls.minZoom = 0.45;
      controls.maxZoom = 3.5;
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = deg(62);
    } else {
      controls.minDistance = cfg.minDistance;
      controls.maxDistance = cfg.maxDistance;
      controls.minPolarAngle = deg(cfg.minTiltDegrees);
      controls.maxPolarAngle = deg(cfg.maxTiltDegrees);
    }
    controls.update();

    this.camera = camera;
    this.controls = controls;
    this.cameraMode = mode;
    // Distance based fog makes no sense for a camera without perspective.
    this.scene.fog = mode === 'orthographic' ? null : this.atmosphere;
  }

  toggleCameraMode() {
    const next = this.cameraMode === 'perspective' ? 'orthographic' : 'perspective';
    cancelTween(this.followTween);
    this.setupCamera(next, this.controls.target.clone());
    return next;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    const aspect = w / h;
    if (this.camera.isPerspectiveCamera) {
      this.camera.aspect = aspect;
    } else {
      const vh = this.config.camera.orthoViewHeight;
      this.camera.left = -vh * aspect / 2;
      this.camera.right = vh * aspect / 2;
      this.camera.top = vh / 2;
      this.camera.bottom = -vh / 2;
    }
    this.camera.updateProjectionMatrix();
  }

  // ===================================================================
  //  Building the map visuals from game data
  // ===================================================================
  loadGame(game) {
    this.game = game;
    this.clearMap();
    const cfg = this.config;

    for (const hex of game.map.hexes.values()) {
      const mat = new THREE.MeshStandardMaterial({
        color: cfg.colors.fogTile,
        roughness: 0.85,
        metalness: 0.0,
      });
      const mesh = new THREE.Mesh(this.tileGeo, mat);
      mesh.position.set(hex.x, 0, -hex.y);
      mesh.scale.y = cfg.colors.fogTileHeight;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.hex = hex;
      this.scene.add(mesh);
      this.tileMeshes.push(mesh);

      const ring = new THREE.Mesh(
        this.ringGeo,
        new THREE.MeshBasicMaterial({
          color: cfg.colors.reachableRing,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      ring.position.set(hex.x, cfg.colors.fogTileHeight + 0.02, -hex.y);
      ring.visible = false;
      const ringBack = new THREE.Mesh(this.ringBackGeo, this.ringBackMat);
      ringBack.position.y = -0.004;
      ring.add(ringBack);
      this.scene.add(ring);

      const record = {
        hex,
        mesh,
        ring,
        marker: null,
        height: cfg.colors.fogTileHeight,
        lift: 0,
        phase: Math.random() * Math.PI * 2,
        colorTween: null,
      };
      this.tiles.set(hex.key, record);

      if (hex.encounter) record.marker = this.buildMarker(hex, record);
      // Tiles that start revealed (start area, boss) appear without animation.
      if (hex.revealed) this.applyRevealed(record, false);
    }

    this.buildPlayer(game.state.position);
    this.fitLightToMap(game.map.bounds);
    this.syncState();

    const p = this.playerWorld(game.state.position);
    this.setupCamera(this.cameraMode, new THREE.Vector3(p.x, 0, p.z));
  }

  clearMap() {
    // Stop animations that would otherwise touch objects we are about to remove.
    cancelTween(this.hopTween);
    cancelTween(this.followTween);
    this.busy = false;
    for (const rec of this.tiles.values()) {
      cancelTween(rec.colorTween);
      this.scene.remove(rec.mesh, rec.ring);
      rec.mesh.material.dispose();
      rec.ring.material.dispose();
      if (rec.marker) {
        this.scene.remove(rec.marker);
        rec.marker.traverse((o) => o.material && o.material.dispose());
      }
    }
    this.tiles.clear();
    this.tileMeshes = [];
    if (this.player) { this.scene.remove(this.player); this.player = null; }
    this.hover = null;
    this.reachable.clear();
  }

  buildMarker(hex, record) {
    const v = this.config.encounters.visuals[hex.encounter];
    const geo = this.markerGeos[v?.shape] ?? this.markerGeos.octahedron;
    const color = new THREE.Color(v?.color ?? 0xffffff);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.35),
      roughness: 0.45,
      metalness: 0.1,
    });
    const marker = new THREE.Mesh(geo, mat);
    marker.castShadow = true;
    const scale = hex.isBoss ? 1.7 : 1;
    marker.scale.setScalar(scale);
    marker.userData.baseScale = scale;
    marker.position.set(hex.x, 0, -hex.y);
    marker.visible = hex.revealed;
    this.scene.add(marker);
    this.placeMarker(record, marker);
    return marker;
  }

  placeMarker(record, marker) {
    const h = record.height;
    marker.userData.baseY = h + 0.5 * (marker.userData.baseScale || 1);
    marker.position.y = marker.userData.baseY;
  }

  buildPlayer(startHex) {
    const cfg = this.config.colors;
    const group = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.22, 0.34, 6, 14),
      new THREE.MeshStandardMaterial({ color: cfg.player, roughness: 0.4, metalness: 0.05, emissive: 0x332a10 })
    );
    body.position.y = 0.45;
    body.castShadow = true;
    group.add(body);

    const base = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.42, 24),
      new THREE.MeshBasicMaterial({ color: cfg.playerGlow, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = 0.02;
    group.add(base);

    const lantern = new THREE.PointLight(cfg.playerGlow, 10, 7, 2);
    lantern.position.y = 1.1;
    group.add(lantern);

    this.player = group;
    this.playerBody = body;
    const p = this.playerWorld(startHex);
    group.position.copy(p);
    this.scene.add(group);
  }

  fitLightToMap(bounds) {
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = -(bounds.minY + bounds.maxY) / 2;
    const halfW = (bounds.maxX - bounds.minX) / 2 + 3;
    const halfH = (bounds.maxY - bounds.minY) / 2 + 3;
    const extent = Math.max(halfW, halfH);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + 12, 24, cz + 10);
    const cam = this.sun.shadow.camera;
    cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
    cam.updateProjectionMatrix();
  }

  // World position of the top of a hex (where the player stands).
  playerWorld(hex) {
    const rec = this.tiles.get(hex.key);
    const h = rec ? rec.height : this.config.colors.fogTileHeight;
    return new THREE.Vector3(hex.x, h, -hex.y);
  }

  // ===================================================================
  //  State -> visuals
  // ===================================================================
  targetColorFor(hex) {
    const c = this.config.colors;
    if (!hex.revealed) return new THREE.Color(c.fogTile);
    let color;
    if (hex.isStart) color = new THREE.Color(c.startTile);
    else if (hex.isBoss) color = new THREE.Color(c.bossTile);
    else color = new THREE.Color(this.config.terrain[hex.terrain].color);
    if (hex.visited && !hex.isStart && this.game.state.position !== hex) color.multiplyScalar(c.visitedTint);
    return color;
  }

  applyRevealed(record, animate, delayMs = 0) {
    const hex = record.hex;
    const targetH = this.config.terrain[hex.terrain].height;
    const targetColor = this.targetColorFor(hex);
    const mesh = record.mesh;
    const fromH = record.height;
    const fromColor = mesh.material.color.clone();

    const apply = (t) => {
      const h = fromH + (targetH - fromH) * t;
      record.height = h;
      mesh.scale.y = h;
      mesh.material.color.lerpColors(fromColor, targetColor, t);
      record.ring.position.y = h + 0.02;
      if (record.marker) this.placeMarker(record, record.marker);
    };

    if (!animate) {
      apply(1);
      if (record.marker) record.marker.visible = true;
      return;
    }
    cancelTween(record.colorTween);
    record.colorTween = tween({
      duration: this.config.anim.revealMs,
      delay: delayMs,
      ease: Ease.outCubic,
      onUpdate: apply,
      onComplete: () => {
        if (record.marker) {
          record.marker.visible = true;
          const m = record.marker;
          const s = m.userData.baseScale || 1;
          tween({ duration: 350, ease: Ease.outBack, onUpdate: (t) => m.scale.setScalar(s * t) });
        }
      },
    });
  }

  // Re-read colours / reachable tiles from the game state (cheap, call freely).
  syncState() {
    const game = this.game;
    this.reachable = new Set(game.reachable().map((h) => h.key));
    for (const rec of this.tiles.values()) {
      const animating = rec.colorTween && !rec.colorTween.done;
      if (rec.hex.revealed && !animating) {
        rec.mesh.material.color.copy(this.targetColorFor(rec.hex));
      }
      rec.ring.visible = this.reachable.has(rec.hex.key);
    }
  }

  // ===================================================================
  //  Game event handlers (wired from main.js)
  // ===================================================================
  handleReveal(hexes, origin) {
    // Tiles closest to the player lift first, for a ripple feel.
    for (const hex of hexes) {
      const rec = this.tiles.get(hex.key);
      if (!rec) continue;
      const d = origin ? hexDistance(origin.q, origin.r, hex.q, hex.r) : 0;
      this.applyRevealed(rec, true, this.config.anim.hopMs * 0.6 + d * 60);
    }
  }

  // The encounter on this tile was consumed: pop the marker and remove it.
  handleEncounterCleared(hex) {
    const rec = this.tiles.get(hex.key);
    if (!rec || !rec.marker) return;
    const m = rec.marker;
    rec.marker = null;
    const s = m.userData.baseScale || 1;
    tween({
      duration: 320,
      ease: Ease.inOutCubic,
      onUpdate: (t) => { m.scale.setScalar(s * (1 + 0.6 * t) * (1 - t)); m.position.y = m.userData.baseY + t * 1.2; },
      onComplete: () => { this.scene.remove(m); m.material.dispose(); },
    });
  }

  handleMove(from, to) {
    const start = this.playerWorld(from);
    const endRec = this.tiles.get(to.key);
    const endH = endRec ? this.config.terrain[to.terrain].height : 0.35;
    const end = new THREE.Vector3(to.x, endH, -to.y);
    this.busy = true;
    this.setHoverTile(null);

    this.hopTween = tween({
      duration: this.config.anim.hopMs,
      ease: Ease.inOutCubic,
      onUpdate: (t, raw) => {
        this.player.position.lerpVectors(start, end, t);
        this.player.position.y += Math.sin(raw * Math.PI) * 0.7;
        this.playerBody.rotation.y = raw * Math.PI * 2;
      },
      onComplete: () => {
        this.player.position.copy(end);
        this.busy = false;
        this.syncState();
        this.hoverDirty = true;
      },
    });

    if (this.config.camera.followPlayer) this.followTo(end);
  }

  followTo(worldPos) {
    cancelTween(this.followTween);
    const targetStart = this.controls.target.clone();
    const camStart = this.camera.position.clone();
    const delta = new THREE.Vector3(worldPos.x - targetStart.x, 0, worldPos.z - targetStart.z);
    this.followTween = tween({
      duration: this.config.camera.followDurationMs,
      ease: Ease.inOutCubic,
      onUpdate: (t) => {
        this.controls.target.copy(targetStart).addScaledVector(delta, t);
        this.camera.position.copy(camStart).addScaledVector(delta, t);
      },
    });
  }

  // ===================================================================
  //  Input
  // ===================================================================
  bindInput() {
    const el = this.renderer.domElement;
    let down = null;

    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, time: performance.now(), button: e.button };
      cancelTween(this.followTween);
    });

    el.addEventListener('pointermove', (e) => {
      this.updatePointer(e);
    });

    el.addEventListener('pointerleave', () => {
      this.pointer.set(-10, -10);
      this.hoverDirty = true;
    });

    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.time < 600;
      const wasLeft = down.button === 0;
      down = null;
      if (!wasLeft || moved > 6 || !quick) return;
      this.updatePointer(e);
      const hex = this.pickHex();
      if (hex && this.onHexClick) this.onHexClick(hex);
    });

    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  updatePointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.hoverDirty = true;
  }

  pickHex() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.tileMeshes, false);
    return hits.length ? hits[0].object.userData.hex : null;
  }

  setHoverTile(hex) {
    if (this.hover === hex) return;
    this.hover = hex;
    if (this.onHexHover) this.onHexHover(hex);
  }

  // ===================================================================
  //  Frame loop
  // ===================================================================
  frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1) * 1000;
    this.elapsed += dt;
    updateTweens(dt);
    this.controls.update();

    if (this.hoverDirty) {
      this.hoverDirty = false;
      this.setHoverTile(this.busy ? null : this.pickHex());
    }

    const c = this.config.colors;
    const hoverKey = this.hover?.key;
    for (const rec of this.tiles.values()) {
      // Rings on reachable tiles pulse; the hovered one goes solid white.
      if (rec.ring.visible) {
        const isHover = rec.hex.key === hoverKey;
        rec.ring.material.color.set(isHover ? c.hoverRing : c.reachableRing);
        rec.ring.material.opacity = isHover ? 1 : 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(this.elapsed / 260 + rec.phase));
        const targetLift = isHover ? 0.12 : 0;
        rec.lift += (targetLift - rec.lift) * Math.min(1, dt / 60);
      } else if (rec.lift > 0.0005) {
        rec.lift += (0 - rec.lift) * Math.min(1, dt / 60);
      }
      rec.mesh.position.y = rec.lift;
      rec.ring.position.y = rec.height + 0.02 + rec.lift;

      // Encounter markers slowly spin and bob.
      if (rec.marker && rec.marker.visible) {
        rec.marker.rotation.y += dt * 0.0009;
        rec.marker.position.y = rec.marker.userData.baseY + Math.sin(this.elapsed / 650 + rec.phase) * 0.06 + rec.lift;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}
