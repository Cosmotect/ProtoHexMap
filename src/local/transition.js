// =====================================================================
//  COMBAT CINEMATIC - the flight between the world map and a local map.
//
//  The player presses Enter on a combat tile; the camera dives into that tile
//  through a wall of clouds (fullscreen FX: cloud layers, blur, FOV stretch,
//  screenshake, a white flash) and comes out hundreds of metres lower, above
//  the local arena. Mid-flight - while the screen is fully clouded - the world
//  scene is swapped for the local scene (that is also when a future map recipe
//  will have just finished applying). The way back reverses everything.
//
//  Sandboxing: this module drives the shared WebGLRenderer through ONE hook
//  (worldRenderer.overrideFrame); it never touches game rules. The timeline is
//  wall-clock based, so the flight takes the same real time on any frame rate.
// =====================================================================
import * as THREE from 'three';
import { LocalMapView } from './localview.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeInCubic = (t) => t * t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (t) => t * t * (3 - 2 * t);

export function createCombatCinematic({ renderer, config, container }) {
  const localView = new LocalMapView(renderer.renderer, renderer.renderer.domElement, config);
  const fx = buildFxOverlay(container, config);
  let mode = 'idle';          // 'idle' | 'in' | 'local' | 'out'
  let t0 = 0;
  let flight = null;          // { saved, hexPos, onSwap, onDone, swapped }
  window.__localView = localView;   // for debugging / automated tests

  function isActive() { return mode !== 'idle'; }

  // Saves the world camera so the fly-out can put everything back exactly.
  function saveWorldCamera() {
    return {
      position: renderer.camera.position.clone(),
      target: renderer.controls.target.clone(),
      fov: renderer.camera.fov,
    };
  }
  function restoreWorldCamera(saved) {
    renderer.camera.position.copy(saved.position);
    renderer.controls.target.copy(saved.target);
    if (saved.fov != null) {
      renderer.camera.fov = saved.fov;
      renderer.camera.updateProjectionMatrix();
    }
    renderer.controls.enabled = true;
    renderer.controls.update();
  }

  // ----- fly IN: world -> local ------------------------------------------
  // opts: { worldHex, baseColor, party, enemies, seed, recipe, onArrived }
  function flyIn(opts) {
    if (isActive()) return false;
    const saved = saveWorldCamera();
    renderer.controls.enabled = false;

    // Build the arena now, while we are still above the clouds: this is where a
    // handcrafted recipe is applied, so the swap below reveals a finished map.
    localView.build(opts);

    const rec = renderer.tiles.get(opts.worldHex.key);
    const hexPos = new THREE.Vector3(opts.worldHex.x, (rec ? rec.height : 0.35) + 1.6, -opts.worldHex.y);
    flight = {
      saved,
      hexPos,
      camStart: renderer.camera.position.clone(),
      targetStart: renderer.controls.target.clone(),
      fovStart: renderer.camera.fov,
      onArrived: opts.onArrived,
      swapped: false,
    };
    mode = 'in';
    t0 = performance.now();
    fx.show();
    renderer.overrideFrame = frame;
    return true;
  }

  // ----- the START SCREEN: begin already inside the local map ----------------
  // Used on startup: no fly-in, no clouds - the splash masks the load and the
  // game opens on the arena (the party around a campfire). "Begin journey" then
  // leaves through the ordinary flyOut, which needs the same `flight` bookkeeping
  // a fly-in would have left behind.
  function startScreen(opts) {
    if (isActive()) return false;
    const saved = saveWorldCamera();
    renderer.controls.enabled = false;
    localView.build({ ...opts, enemies: [], layout: 'camp' });
    const rec = renderer.tiles.get(opts.worldHex.key);
    flight = {
      saved,
      hexPos: new THREE.Vector3(opts.worldHex.x, (rec ? rec.height : 0.35) + 1.6, -opts.worldHex.y),
      camStart: null,
      targetStart: null,
      fovStart: saved.fov ?? config.camera.fov,
      swapped: true,
    };
    mode = 'local';
    renderer.overrideFrame = frame;
    localView.activate();
    return true;
  }

  // ----- fly OUT: local -> world -------------------------------------------
  function flyOut({ onDone } = {}) {
    if (mode !== 'local') return false;
    // The climb starts from where the player ACTUALLY left the camera, not from
    // the arena's canonical resting pose: if they rotated the shot before
    // leaving, snapping back first was a visible jolt. Snapshot it before the
    // controls are torn down (they own the look-at target).
    flight.localFrom = {
      position: localView.camera.position.clone(),
      target: (localView.controls ? localView.controls.target : localView.finalCameraPose().target).clone(),
      fov: localView.camera.fov,
    };
    localView.deactivate();
    flight.onDone = onDone;
    flight.swapped = false;
    mode = 'out';
    t0 = performance.now();
    fx.show();
    return true;
  }

  // Instant bail-out (new map / restart while the arena is open).
  function abort() {
    if (!isActive()) return;
    renderer.overrideFrame = null;
    fx.hide();
    renderer.renderer.domElement.style.filter = '';
    restoreWorldCamera(flight.saved);
    localView.dispose();
    flight = null;
    mode = 'idle';
  }

  // ----- the per-frame timeline ---------------------------------------------
  // Installed as renderer.overrideFrame; returning true skips the world frame.
  function frame(dt) {
    if (mode === 'idle') return false;
    const cfg = config.local;

    if (mode === 'local') {
      localView.update(dt);
      localView.render();
      return true;
    }

    const dur = mode === 'in' ? cfg.flyInMs : cfg.flyOutMs;
    const t = clamp01((performance.now() - t0) / dur);
    const swapT = cfg.swapPoint;
    // FX envelope peaks at the swap: 0 -> 1 -> 0.
    const cloud = t < swapT ? smooth(clamp01((t - swapT * 0.35) / (swapT * 0.65)))
                            : 1 - smooth(clamp01((t - swapT) / ((1 - swapT) * 0.7)));
    const shake = cfg.shake * cloud;
    fx.set(cloud, mode, t);
    renderer.renderer.domElement.style.filter = cloud > 0.02
      ? `blur(${(cloud * 5).toFixed(1)}px) brightness(${1 + cloud * 0.5})`
      : '';

    if (mode === 'in') {
      if (t < swapT) {
        // Dive at the world tile: position and aim race towards it, FOV stretches.
        const k = easeInCubic(t / swapT);
        renderer.camera.position.lerpVectors(flight.camStart, flight.hexPos, k);
        addShake(renderer.camera.position, shake);
        const aim = flight.targetStart.clone().lerp(new THREE.Vector3(flight.hexPos.x, 0, flight.hexPos.z), k);
        renderer.camera.lookAt(aim);
        setFov(renderer.camera, flight.fovStart + (80 - flight.fovStart) * k);
        renderer.renderer.render(renderer.scene, renderer.camera);
      } else {
        if (!flight.swapped) { flight.swapped = true; }
        // Falling out of the clouds above the arena, braking into the final pose.
        const k = easeOutCubic((t - swapT) / (1 - swapT));
        const from = localView.overheadCameraPose();
        const to = localView.finalCameraPose();
        localView.camera.position.lerpVectors(from.position, to.position, k);
        addShake(localView.camera.position, shake);
        localView.camera.lookAt(to.target);
        setFov(localView.camera, from.fov + (to.fov - from.fov) * k);
        localView.update(dt);
        localView.render();
      }
      if (t >= 1) {
        mode = 'local';
        fx.hide();
        renderer.renderer.domElement.style.filter = '';
        localView.activate();
        const done = flight.onArrived;
        flight.onArrived = null;
        if (done) done();
      }
      return true;
    }

    // mode === 'out': climb from the arena, punch the clouds, settle on the map.
    if (t < swapT) {
      const k = easeInCubic(t / swapT);
      const from = flight.localFrom ?? localView.finalCameraPose();
      const to = localView.overheadCameraPose();
      localView.camera.position.lerpVectors(from.position, to.position, k);
      addShake(localView.camera.position, shake);
      localView.camera.lookAt(from.target);
      setFov(localView.camera, from.fov + (to.fov - from.fov) * k);
      localView.render();
    } else {
      const k = easeOutCubic((t - swapT) / (1 - swapT));
      renderer.camera.position.lerpVectors(flight.hexPos, flight.saved.position, k);
      addShake(renderer.camera.position, shake);
      const aim = new THREE.Vector3(flight.hexPos.x, 0, flight.hexPos.z).lerp(flight.saved.target, k);
      renderer.camera.lookAt(aim);
      setFov(renderer.camera, 80 + ((flight.saved.fov ?? flight.fovStart) - 80) * k);
      renderer.renderer.render(renderer.scene, renderer.camera);
    }
    if (t >= 1) {
      renderer.overrideFrame = null;
      fx.hide();
      renderer.renderer.domElement.style.filter = '';
      restoreWorldCamera(flight.saved);
      localView.dispose();
      const done = flight.onDone;
      flight = null;
      mode = 'idle';
      if (done) done();
    }
    return true;
  }

  function addShake(pos, amp) {
    if (amp <= 0) return;
    pos.x += (Math.random() - 0.5) * amp;
    pos.y += (Math.random() - 0.5) * amp * 0.6;
    pos.z += (Math.random() - 0.5) * amp;
  }
  function setFov(camera, fov) {
    if (!camera.isPerspectiveCamera) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  window.addEventListener('resize', () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    localView.resize(w / h);
  });

  return { flyIn, flyOut, startScreen, abort, isActive, mode: () => mode, localView };
}

// ----- the fullscreen cloud overlay -------------------------------------------
// Three procedurally drawn cloud layers rushing past, a white flash at the peak
// and a vignette. Pure DOM: cheap, and it sits above the canvas blur.
function buildFxOverlay(container, config) {
  const root = document.createElement('div');
  root.id = 'cloud-fx';
  root.className = 'cloud-fx hidden';
  const layers = [];
  for (let i = 0; i < 3; i++) {
    const layer = document.createElement('div');
    layer.className = 'cloud-layer';
    layer.style.backgroundImage = `url(${cloudTexture(320, 34 + i * 10, config.local.cloudColor)})`;
    root.appendChild(layer);
    layers.push(layer);
  }
  const flash = document.createElement('div');
  flash.className = 'cloud-flash';
  root.appendChild(flash);
  const vignette = document.createElement('div');
  vignette.className = 'cloud-vignette';
  root.appendChild(vignette);
  document.body.appendChild(root);

  return {
    show() { root.classList.remove('hidden'); },
    hide() { root.classList.add('hidden'); },
    // strength 0..1; the layers scale up as if the camera rams through them.
    set(strength, mode, t) {
      const dir = mode === 'in' ? t : 1 - t;   // flying down vs climbing up
      layers.forEach((layer, i) => {
        const s = 1 + dir * (2.2 + i * 1.6);
        layer.style.opacity = String(strength * (0.55 + i * 0.2));
        layer.style.transform = `scale(${s.toFixed(3)}) rotate(${(i - 1) * dir * 14}deg)`;
      });
      flash.style.opacity = String(Math.pow(strength, 3) * 0.85);
      vignette.style.opacity = String(strength * 0.9);
    },
  };
}

// A soft cloud texture drawn on a canvas: many blurred white blobs.
function cloudTexture(size, blobs, colorNum) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const col = `#${(colorNum ?? 0xdfe6f2).toString(16).padStart(6, '0')}`;
  for (let i = 0; i < blobs; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = size * (0.06 + Math.random() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `${col}cc`);
    grad.addColorStop(1, `${col}00`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  return c.toDataURL();
}
