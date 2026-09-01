// Everything that draws pixels lives here (Three.js scene, camera, input picking).
const HIGHLIGHT_COLOR = 0x8fe0b8;   // same green as the guide card's outline
// The renderer never changes game rules: it listens to Game events and shows them.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { tween, cancelTween, Ease, updateTweens } from './tween.js';
import { hexDistance } from './hex.js';
import { fatigueStepHue } from './game.js';

const SQRT3 = Math.sqrt(3);
const deg = (d) => (d * Math.PI) / 180;

// ----- cost decals ---------------------------------------------------------
// The "-2 HP" / "-3 SP" text painted flat on a reachable tile. Tuned here on
// purpose rather than in Settings: these are drawing details, not game rules.
const DECAL = {
  canvasW: 256,          // texture size; the plane below decides the world size
  canvasH: 150,
  fontSize: 64,          // px inside that canvas
  lineGap: 10,            // px between the HP and SP lines
  widthFactor: 1,     // plane width as a multiple of the tile radius
  lift: 0.035,           // how far above the tile top it floats (z-fighting)
  sat: 78,               // HSL saturation/lightness of the text
  light: 58,
  stroke: 'rgba(6, 8, 14, 0.55)',
  strokeWidth: 2,
  // Green until the step costs a tenth of the pool, red once it costs it all.
  hueSafe: 135,
  hueMid: 52,
  hueHigh: 2,
};

// Green -> yellow -> red by how much of the pool this step eats. `frac` is
// cost / pool, so 1 means "this single step takes everything you have".
function decalHue(frac) {
  const f = Math.max(0, Math.min(1, frac));
  return f <= 0.5
    ? DECAL.hueSafe + (DECAL.hueMid - DECAL.hueSafe) * (f / 0.5)
    : DECAL.hueMid + (DECAL.hueHigh - DECAL.hueMid) * ((f - 0.5) / 0.5);
}

// One canvas per (text, colour) pair, drawn on demand. Lines are
// [{ text, hue }] - HP and SP each carry their own colour, because the party
// can be flush with supplies and one hit from losing somebody.
function makeDecalTexture(lines) {
  const c = document.createElement('canvas');
  c.width = DECAL.canvasW;
  c.height = DECAL.canvasH;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 ${DECAL.fontSize}px "IBM Plex Mono", ui-monospace, monospace`;
  g.lineJoin = 'round';
  const lh = DECAL.fontSize + DECAL.lineGap;
  const top = DECAL.canvasH / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => {
    const y = top + i * lh;
    // A dark outline first, so the text survives sand, grass and snow alike.
    g.lineWidth = DECAL.strokeWidth;
    g.strokeStyle = DECAL.stroke;
    g.strokeText(ln.text, DECAL.canvasW / 2, y);
    g.fillStyle = `hsl(${ln.hue} ${DECAL.sat}% ${DECAL.light}%)`;
    g.fillText(ln.text, DECAL.canvasW / 2, y);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

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
    // A cinematic (src/local/transition.js) may install this hook to take over
    // rendering completely (camera flights, the local map). It gets dt in ms and
    // returns true while it owns the frame.
    this.overrideFrame = null;

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
    // The world map's own background settings (the local map has its own set).
    const bg = config.worldBackground;
    this.scene.background = new THREE.Color(bg.color);
    // "Atmosphere" fog: distant tiles fade into the background (not the gameplay fog of war).
    this.atmosphere = new THREE.Fog(bg.color, bg.fogNear, bg.fogFar);
    this.scene.fog = bg.fog === false ? null : this.atmosphere;
    this.groundMaterial = null;   // set by buildGround; kept so the colour can be re-applied live
    this.timer = new THREE.Timer();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-10, -10);
    this.hoverDirty = false;

    this.setupLights();
    this.buildSharedGeometry();
    this.setupCamera(new THREE.Vector3(0, 0, 0));

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

    // The "floor" far below the map: seen through the ether holes, it sits deep in
    // the atmosphere fog and reads as a bottomless void under the landmass.
    this.groundMaterial = new THREE.MeshStandardMaterial({ color: this.config.worldBackground.groundColor, roughness: 1, metalness: 0 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = this.config.worldBackground.groundDepth ?? -30;
    this.scene.add(ground);
    this.groundMesh = ground;
  }

  // Re-reads config.worldBackground onto the live scene, so tweaking the colour
  // or the fog distances in Settings shows up immediately instead of on the next
  // map. (The local map reads its own settings every time it is built.)
  applyBackground() {
    const bg = this.config.worldBackground;
    const col = new THREE.Color(bg.color);
    this.scene.background = col;
    this.atmosphere.color.copy(col);
    this.atmosphere.near = bg.fogNear;
    this.atmosphere.far = bg.fogFar;
    this.scene.fog = bg.fog === false ? null : this.atmosphere;
    if (this.groundMaterial) this.groundMaterial.color.set(bg.groundColor);
    if (this.groundMesh) this.groundMesh.position.y = bg.groundDepth ?? -30;
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

    // The plate the cost text is painted on: flat, inside the ring, and yawed
    // to the camera every frame so the writing is never upside down.
    const dw = radius * DECAL.widthFactor;
    const decalGeo = new THREE.PlaneGeometry(dw, (dw * DECAL.canvasH) / DECAL.canvasW);
    decalGeo.rotateX(-Math.PI / 2);
    this.decalGeo = decalGeo;

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

    // Guide highlight: a flat green duplicate drawn behind a marker (slightly larger, so it
    // reads as an outline), and a green hex ring for tiles.
    this.highlightMat = new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR, side: THREE.BackSide, transparent: true, opacity: 0.95 });
    this.highlightRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    this.highlightRing.visible = false;
    this.scene.add(this.highlightRing);
    this.highlightFlashUntil = 0;

    // Danger chevrons (military style ranks) drawn above battle markers.
    this.chevronTexture = makeChevronTexture();

    this.markerGeos = {
      octahedron: new THREE.OctahedronGeometry(0.3),
      icosahedron: new THREE.IcosahedronGeometry(0.3),
      box: new THREE.BoxGeometry(0.42, 0.42, 0.42),
      cone: new THREE.ConeGeometry(0.3, 0.62, 14),
      dodecahedron: new THREE.DodecahedronGeometry(0.3),
    };

    // Stasis lines: short shared-geometry segments laid over the tiles (rebuilt per
    // turn in rebuildStasisLines). One shared pulsing material for all of them.
    this.lineSegGeo = new THREE.BoxGeometry(1, 1, 1);
    this.stasisLineMat = new THREE.MeshBasicMaterial({
      color: this.config.colors.stasisLine, transparent: true, opacity: 0.8, depthWrite: false,
    });
    this.stasisGroup = null;
  }

  // The world camera. Perspective only: the top-down orthographic mode was
  // removed on 2026-08-29 (the prototype is designed around the perspective
  // shot, and a second projection meant a second set of every camera rule).
  setupCamera(target) {
    const cfg = this.config.camera;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const aspect = w / h;

    if (this.controls) this.controls.dispose();

    const camera = new THREE.PerspectiveCamera(cfg.fov, aspect, 0.1, 400);
    const tilt = deg(cfg.tiltDegrees);
    const distance = cfg.distance;
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
    controls.zoomToCursor = true;
    controls.keyPanSpeed = 24;
    controls.listenToKeyEvents(window);
    controls.minDistance = cfg.minDistance;
    controls.maxDistance = cfg.maxDistance;
    controls.minPolarAngle = deg(cfg.minTiltDegrees);
    controls.maxPolarAngle = deg(cfg.maxTiltDegrees);
    controls.update();

    this.camera = camera;
    this.controls = controls;
    this.scene.fog = this.config.worldBackground.fog === false ? null : this.atmosphere;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
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
      // Ether hides under the fog like any other tile, and gets the same fog
      // plate while unrevealed. Once revealed it is a hole in the world - no
      // tile really there, the camera looks straight down into the void - so
      // applyRevealed() hides its plate instead of settling it into a colour
      // (see the isEther branch there). Either way it stays in the game data
      // (it may become navigable later).
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
        markerLift: 0,
        markerLiftTarget: 0,
        phase: Math.random() * Math.PI * 2,
        colorTween: null,
      };
      this.tiles.set(hex.key, record);

      if (hex.encounter) record.marker = this.buildMarker(hex, record);
      // Tiles that start revealed (start area, the Seed) appear without animation.
      if (hex.revealed) this.applyRevealed(record, false);
    }

    this.buildPlayer(game.state.position);
    this.fitLightToMap(game.map.bounds);
    this.syncState();
    this.rebuildStasisLines(game);

    const p = this.playerWorld(game.state.position);
    this.setupCamera(new THREE.Vector3(p.x, 0, p.z));
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
      if (rec.decal) {
        this.scene.remove(rec.decal);
        if (rec.decal.material.map) rec.decal.material.map.dispose();
        rec.decal.material.dispose();
        rec.decal = null;
      }
      if (rec.marker) {
        this.setChevrons(rec, 0);
        this.scene.remove(rec.marker);
        rec.marker.traverse((o) => o.material && o.material.dispose());
      }
    }
    this.setHighlight(null);
    if (this.stasisGroup) { this.scene.remove(this.stasisGroup); this.stasisGroup = null; }
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
    // The Seed's cone is the landmark; a Colony's cone is half its diameter.
    const scale = hex.isSeed ? 1.7 : hex.encounter === 'stasisColony' ? 0.85 : 1;
    marker.scale.setScalar(scale);
    marker.userData.baseScale = scale;
    marker.position.set(hex.x, 0, -hex.y);
    marker.visible = hex.revealed;
    this.scene.add(marker);
    this.placeMarker(record, marker);
    marker.userData.chevrons = [];
    return marker;
  }

  // Shows `count` chevrons stacked above a marker (0 removes them).
  setChevrons(record, count) {
    const m = record.marker;
    if (!m) return;
    const list = m.userData.chevrons;
    while (list.length > count) { const sp = list.pop(); this.scene.remove(sp); sp.material.dispose(); }
    while (list.length < count) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.chevronTexture, transparent: true, depthWrite: false }));
      sp.scale.set(0.34, 0.22, 1);
      this.scene.add(sp);
      list.push(sp);
    }
    m.userData.chevronCount = count;
  }

  // ----- guide highlights (green outline + green tile ring) --------------------
  // target: { hexKey } for a marker, { tile: hexKey } for a tile top, or null.
  setHighlight(target) {
    // Remove the previous outline duplicate.
    if (this.highlightMarker) {
      this.scene.remove(this.highlightMarker.outline);
      this.highlightMarker.outline.geometry = null;
      this.highlightMarker = null;
    }
    this.highlightRing.visible = false;
    if (!target) return;
    if (target.hexKey) {
      const rec = this.tiles.get(target.hexKey);
      if (rec?.marker) {
        const outline = new THREE.Mesh(rec.marker.geometry, this.highlightMat);
        this.scene.add(outline);
        this.highlightMarker = { marker: rec.marker, outline };
      }
    } else if (target.tile) {
      const rec = this.tiles.get(target.tile);
      if (rec) {
        this.highlightRing.visible = true;
        this.highlightRing.position.set(rec.hex.x, rec.height + 0.03, -rec.hex.y);
        this.highlightRing.userData.rec = rec;
      }
    }
  }
  flashHighlight() { this.highlightFlashUntil = this.elapsed + 450; }

  // Screen position (CSS pixels) of a world point, or null when behind the camera.
  projectToScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
  }
  // Screen position of the top of a tile.
  tileTopScreen(hexKey) {
    const rec = this.tiles.get(hexKey);
    if (!rec) return null;
    return this.projectToScreen(rec.hex.x, rec.height + rec.lift, -rec.hex.y);
  }
  // Screen position of an encounter marker.
  markerScreen(hexKey) {
    const rec = this.tiles.get(hexKey);
    if (!rec?.marker) return null;
    const p = rec.marker.position;
    return this.projectToScreen(p.x, p.y, p.z);
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
    else if (hex.isSeed) color = new THREE.Color(c.seedTile);
    else if (hex.encounter === 'stasisColony') color = new THREE.Color(c.colonyTile);
    else {
      // Tile colour = type colour shifted towards the biome colour (a lerp, never a
      // multiplication, so biomes brighten as easily as they darken). A biome may
      // override the amount (tintAmount) and reach types that normally ignore
      // biomes (tintAllTypes) - the wither uses both to repaint tiles completely.
      const type = this.config.tileTypes[hex.type];
      color = new THREE.Color(type.color);
      const biome = this.config.biomes[hex.biome];
      if (biome && (type.biomeTint || biome.tintAllTypes)) {
        color.lerp(new THREE.Color(biome.color), biome.tintAmount ?? c.biomeTintAmount ?? 0.45);
      }
    }
    if (hex.visited && !hex.isStart && this.game.state.position !== hex) color.multiplyScalar(c.visitedTint);
    return color;
  }

  applyRevealed(record, animate, delayMs = 0) {
    const hex = record.hex;
    const isEther = hex.type === 'ether';
    const targetH = this.config.tileTypes[hex.type].height;
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
    // Ether has no real tile once revealed - the fog plate that stood in for
    // it sinks and darkens like any other reveal, then disappears outright so
    // the void floor shows through, instead of settling into a flat dark disc.
    const finish = () => {
      if (isEther) mesh.visible = false;
      if (record.marker) record.marker.visible = true;
    };

    if (!animate) {
      apply(1);
      finish();
      return;
    }
    cancelTween(record.colorTween);
    record.colorTween = tween({
      duration: this.config.anim.revealMs,
      delay: delayMs,
      ease: Ease.outCubic,
      onUpdate: apply,
      onComplete: () => {
        finish();
        if (record.marker) {
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
    // Every reachable tile is the SAME next step, so they all share the colour
    // of the box that step will fill in the fatigue bar: green while the walk
    // is free, then yellow and on into red.
    const hue = fatigueStepHue(this.config, game.state.fatigueSteps + 1);
    this.reachHue = hue;
    if (!this.reachColor) this.reachColor = new THREE.Color();
    this.reachColor.setHSL(hue / 360, 0.72, 0.55);   // matches the fbox border
    // Pools the step costs are measured against: the supplies on hand, and the
    // unit closest to dying (climb damage hits everybody, so that unit decides
    // whether the climb is survivable).
    const living = game.livingUnits();
    const lowHp = living.length ? Math.min(...living.map((u) => u.hp)) : 0;
    for (const rec of this.tiles.values()) {
      const animating = rec.colorTween && !rec.colorTween.done;
      if (rec.hex.revealed && !animating) {
        rec.mesh.material.color.copy(this.targetColorFor(rec.hex));
      }
      rec.ring.visible = this.reachable.has(rec.hex.key);
      this.syncCostDecal(rec, game.state.supplies, lowHp);
      // The marker on the party's own tile floats up so the token does not cut through it.
      rec.markerLiftTarget = rec.hex === game.state.position ? 1.1 : 0;
      // Danger chevrons above revealed battles: how much stronger the enemies are.
      if (rec.marker) this.setChevrons(rec, rec.hex.revealed ? game.dangerRank(rec.hex) : 0);
    }
  }

  // "-2 HP" / "-3 SP" flat on a tile the party can step onto, when stepping
  // there actually costs that. The texture is rebuilt only when the words or
  // the colours change, so this is cheap to call from syncState().
  syncCostDecal(rec, supplies, lowHp) {
    const hex = rec.hex;
    const hp = hex.hpCost ?? 0;
    const sp = hex.supplyCost ?? 0;
    const show = rec.ring.visible && hex.revealed && (hp > 0 || sp > 0);
    if (!show) {
      if (rec.decal) rec.decal.visible = false;
      return;
    }
    const lines = [];
    if (hp > 0) lines.push({ text: `-${hp} HP`, hue: Math.round(decalHue(lowHp > 0 ? hp / lowHp : 1)) });
    if (sp > 0) lines.push({ text: `-${sp} SP`, hue: Math.round(decalHue(supplies > 0 ? sp / supplies : 1)) });
    const key = lines.map((l) => `${l.text}@${l.hue}`).join('|');
    if (!rec.decal) {
      rec.decal = new THREE.Mesh(this.decalGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, toneMapped: false,
      }));
      rec.decal.renderOrder = 3;   // above the tile and its ring
      rec.decal.position.set(hex.x, 0, -hex.y);
      this.scene.add(rec.decal);
    }
    if (rec.decalKey !== key) {
      rec.decalKey = key;
      const old = rec.decal.material.map;
      rec.decal.material.map = makeDecalTexture(lines);
      rec.decal.material.needsUpdate = true;
      if (old) old.dispose();
    }
    rec.decal.visible = true;
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

  // ----- the Stasis --------------------------------------------------------
  // A Colony just spawned: give its tile a marker (with a pop if it is visible).
  handleColonySpawn(hex) {
    const rec = this.tiles.get(hex.key);
    if (!rec || rec.marker) return;
    rec.marker = this.buildMarker(hex, rec);
    if (hex.revealed) {
      rec.mesh.material.color.copy(this.targetColorFor(hex));
      const m = rec.marker;
      m.visible = true;
      const s = m.userData.baseScale || 1;
      tween({ duration: 450, ease: Ease.outBack, onUpdate: (t) => m.scale.setScalar(s * t) });
    }
  }

  // Tiles the Stasis withered (biome -> 'wither', dried water -> ground): re-run
  // the reveal animation on the visible ones so colour and height catch up.
  handleWither(hexes) {
    for (const hex of hexes) {
      const rec = this.tiles.get(hex.key);
      if (rec && hex.revealed) this.applyRevealed(rec, true);
    }
  }

  // Rebuilds the growing Seed -> Colony lines. Called once per turn and after
  // reveals, so it can afford to be simple: throw the old segments away and lay
  // new ones. Each line is one straight 3D segment chain from the halfway point of
  // the Seed's cone to the Colony site - it does NOT follow the terrain. Segments
  // are only drawn over tiles the player has already revealed.
  rebuildStasisLines(game) {
    if (this.stasisGroup) { this.scene.remove(this.stasisGroup); this.stasisGroup = null; }
    if (!game || !game.stasis || !game.stasis.seed) return;   // scenario maps may have no Stasis
    this.stasisGroup = new THREE.Group();
    this.stasisLineMat.color.set(this.config.colors.stasisLine);
    const seed = game.stasis.seed;
    const seedRec = this.tiles.get(seed.key);
    const seedH = seedRec ? seedRec.height : this.config.colors.fogTileHeight;
    // Seed cone: base scale 1.7, so its centre (= half its height) sits 0.85 above the tile.
    const start = new THREE.Vector3(seed.x, seedH + 0.85, -seed.y);
    const step = 0.3;
    const Z = new THREE.Vector3(0, 0, 1);
    for (const c of game.stasis.colonies) {
      if (c.cleared) continue;
      const frac = c.distance > 0 ? Math.min(1, c.progress / c.distance) : 1;
      if (frac <= 0) continue;
      const endRec = this.tiles.get(c.hex.key);
      const endH = endRec ? endRec.height : this.config.colors.fogTileHeight;
      const end = new THREE.Vector3(c.hex.x, endH + 0.1, -c.hex.y);
      const dir = end.clone().sub(start);
      const total = dir.length() || 1;
      dir.normalize();
      const grown = total * frac;
      const quat = new THREE.Quaternion().setFromUnitVectors(Z, dir);
      for (let d = step / 2; d < grown; d += step) {
        const pos = start.clone().addScaledVector(dir, d);
        const rec = this.tileAt(pos.x, pos.z);
        if (!rec || !rec.hex.revealed) continue;
        const seg = new THREE.Mesh(this.lineSegGeo, this.stasisLineMat);
        seg.scale.set(0.09, 0.09, Math.min(step, grown - (d - step / 2)) * 1.1);
        seg.quaternion.copy(quat);
        seg.position.copy(pos);
        this.stasisGroup.add(seg);
      }
    }
    this.scene.add(this.stasisGroup);
  }

  // The tile record whose centre is closest to the world point (x, z). Hex grids are
  // the Voronoi cells of their centres, so "nearest centre" = "containing tile".
  tileAt(x, z) {
    let best = null, bestD = Infinity;
    for (const rec of this.tiles.values()) {
      const dx = rec.hex.x - x, dz = -rec.hex.y - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = rec; }
    }
    return best;
  }

  // The encounter on this tile was consumed: pop the marker and remove it.
  handleEncounterCleared(hex) {
    const rec = this.tiles.get(hex.key);
    if (!rec || !rec.marker) return;
    const m = rec.marker;
    this.setChevrons(rec, 0);
    if (this.highlightMarker?.marker === m) this.setHighlight(null);
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
    const endH = endRec ? this.config.tileTypes[to.type].height : 0.35;
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
    // Raycaster does not itself skip invisible objects: filter those out, or a
    // revealed ether tile (its plate hidden in applyRevealed - see the isEther
    // branch there) would still catch clicks meant for the void hole it left.
    const hits = this.raycaster.intersectObjects(this.tileMeshes.filter((m) => m.visible), false);
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
    if (this.overrideFrame && this.overrideFrame(dt)) return;
    this.controls.update();

    if (this.hoverDirty) {
      this.hoverDirty = false;
      this.setHoverTile(this.busy ? null : this.pickHex());
    }

    const c = this.config.colors;
    const hoverKey = this.hover?.key;
    // Which way the camera looks, flattened onto the ground - the yaw every
    // flat decal copies so its text faces the viewer.
    const camYaw = Math.atan2(
      this.camera.position.x - this.controls.target.x,
      this.camera.position.z - this.controls.target.z
    );
    for (const rec of this.tiles.values()) {
      // Rings on reachable tiles pulse; the hovered one goes solid white.
      if (rec.ring.visible) {
        const isHover = rec.hex.key === hoverKey;
        // Not the flat `reachableRing` any more: the ring wears the colour of
        // the fatigue box this step will fill (syncState works it out).
        if (isHover) rec.ring.material.color.set(c.hoverRing);
        else rec.ring.material.color.copy(this.reachColor ?? new THREE.Color(c.reachableRing));
        rec.ring.material.opacity = isHover ? 1 : 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(this.elapsed / 260 + rec.phase));
        const targetLift = isHover ? 0.12 : 0;
        rec.lift += (targetLift - rec.lift) * Math.min(1, dt / 60);
      } else if (rec.lift > 0.0005) {
        rec.lift += (0 - rec.lift) * Math.min(1, dt / 60);
      }
      rec.mesh.position.y = rec.lift;
      rec.ring.position.y = rec.height + 0.02 + rec.lift;
      // The cost text rides the tile and turns with the camera, so it always
      // reads left to right however the map is spun.
      if (rec.decal && rec.decal.visible) {
        rec.decal.position.y = rec.height + DECAL.lift + rec.lift;
        rec.decal.rotation.y = camYaw;
      }

      // Encounter markers slowly spin and bob; chevrons stack above them.
      if (rec.marker && rec.marker.visible) {
        rec.marker.rotation.y += dt * 0.0009;
        rec.markerLift += (rec.markerLiftTarget - rec.markerLift) * Math.min(1, dt / 140);
        rec.marker.position.y = rec.marker.userData.baseY + Math.sin(this.elapsed / 650 + rec.phase) * 0.06 + rec.lift + rec.markerLift;
        const list = rec.marker.userData.chevrons || [];
        const top = rec.marker.position.y + 0.45 * (rec.marker.userData.baseScale || 1);
        list.forEach((sp, i) => { sp.position.set(rec.marker.position.x, top + 0.16 + i * 0.2, rec.marker.position.z); sp.visible = true; });
      }
    }

    // Stasis lines pulse gently.
    this.stasisLineMat.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(this.elapsed / 320));

    // Guide highlight: the outline copies its marker; flashes pulse the size/opacity.
    const flashing = this.elapsed < this.highlightFlashUntil;
    const pulse = flashing ? 1 + 0.35 * Math.sin(((this.highlightFlashUntil - this.elapsed) / 450) * Math.PI) : 1;
    if (this.highlightMarker) {
      const { marker, outline } = this.highlightMarker;
      outline.position.copy(marker.position);
      outline.rotation.copy(marker.rotation);
      outline.scale.copy(marker.scale).multiplyScalar(1.18 * pulse);
      outline.visible = marker.visible;
    }
    if (this.highlightRing.visible) {
      const rec = this.highlightRing.userData.rec;
      if (rec) this.highlightRing.position.y = rec.height + 0.03 + rec.lift;
      this.highlightRing.scale.setScalar(pulse);
      this.highlightRing.material.opacity = flashing ? 1 : 0.8 + 0.15 * Math.sin(this.elapsed / 300);
    }

    this.renderer.render(this.scene, this.camera);
  }
}

// A tailless up arrow (military rank chevron) drawn on a small canvas, used as a sprite.
function makeChevronTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 40;
  const g = c.getContext('2d');
  g.lineWidth = 9;
  g.lineJoin = 'miter';
  g.strokeStyle = '#0b0e16';
  g.beginPath(); g.moveTo(8, 34); g.lineTo(32, 8); g.lineTo(56, 34); g.stroke();
  g.lineWidth = 5;
  g.strokeStyle = '#ff6b6b';
  g.beginPath(); g.moveTo(8, 34); g.lineTo(32, 8); g.lineTo(56, 34); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
