// =====================================================================
//  HACK ENCOUNTER - the extra presentation.  *** EXPERIMENT (see DESIGN.md) ***
//
//  What the hack shows that a fight does not, layered ON TOP of the ordinary
//  arena (LocalMapView) without changing it:
//    * the HACK panel at the top of the screen - the turn counter and the
//      three BADGES that light up as nodes go down - a DOM element with its
//      own <style> block - style.css is untouched;
//    * NODE bodies: a short hex column per node with its hp as a FLAT DECAL on
//      the column's top face (the emoji sprite the arena would draw for the
//      tag is hidden; mines keep theirs). Nothing of the hack's floats: the
//      only floating readings are the arena's own damage billboards.
//    * the battle bar's round counter reads "Turn n / N".
//  Lock marks and the damage pre-calculation used to live here; they are the
//  arena's now (LocalMapView.syncLockFx, since 2026-09-15).
// =====================================================================
import * as THREE from 'three';

const SQRT3 = Math.sqrt(3);

export function createHackView({ view, hack, H }) {
  const scene = view.scene;
  const cfg = view.config.local;
  const tileRadius = cfg.hexSize - cfg.gap / SQRT3;
  const colors = H.colors;
  const hx = () => hack.state.ext.hack;

  // ----- the hack panel (DOM): turn counter + badges -------------------------
  // No progress bar (gone 2026-09-19): the turn counter, and under it the three
  // BADGES with their node thresholds, lighting up one by one as nodes go down
  // - the three stars of a mobile level.
  const style = document.createElement('style');
  style.id = 'hack-style';
  style.textContent = `
    #hack-bar { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); width: min(420px, 60vw);
      padding: 8px 14px 10px; pointer-events: none; text-align: center; }
    #hack-bar .hack-title { font-family: var(--display); letter-spacing: 0.14em; font-size: 12px; color: var(--muted); text-transform: uppercase; }
    #hack-bar .hack-title b { color: var(--accent); letter-spacing: 0.06em; }
    #hack-bar .hack-turns { font-family: var(--mono); font-size: 15px; color: var(--text); margin-top: 4px; }
    #hack-bar .hack-turns.last { color: var(--danger); }
    #hack-bar .hack-turns.over { color: var(--accent); }
    #hack-bar .hack-badges { display: flex; justify-content: center; gap: 14px; margin-top: 8px; }
    #hack-bar .badge { position: relative; width: 58px; height: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      border-radius: 50%; border: 2px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.05); color: var(--muted);
      font-family: var(--mono); font-size: 13px; transition: transform .25s ease, border-color .25s ease, background .25s ease, color .25s ease, box-shadow .25s ease; }
    #hack-bar .badge .star { font-size: 20px; line-height: 1; filter: grayscale(1) opacity(0.35); transition: filter .25s ease; }
    #hack-bar .badge .n { margin-top: 1px; }
    #hack-bar .badge.lit { border-color: var(--accent); background: rgba(255, 209, 102, 0.18); color: var(--accent);
      box-shadow: 0 0 18px rgba(255, 209, 102, 0.45); animation: hack-badge-pop .5s ease; }
    #hack-bar .badge.lit .star { filter: none; }
    @keyframes hack-badge-pop { 0% { transform: scale(0.7); } 55% { transform: scale(1.25); } 100% { transform: scale(1); } }
    #hack-bar .hack-cleared { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 6px; }
    #hack-bar .hack-cleared b { color: var(--text); }
    body.hack-mode #battle-bar .battle-round { color: var(--accent); }
    /* No enemy in a hack: the info panel's roster block and its separator go. */
    body.hack-mode #local-info .li-roster-label, body.hack-mode #local-info #enemy-roster, body.hack-mode #local-info .li-sep { display: none; }
  `;
  document.head.appendChild(style);
  const bar = document.createElement('div');
  bar.id = 'hack-bar';
  bar.className = 'panel';
  bar.innerHTML = `
    <div class="hack-title"><b>HACK</b></div>
    <div class="hack-turns"></div>
    <div class="hack-badges">${H.badges.map((n, i) => `<div class="badge" data-badge="${i + 1}"><span class="star">★</span><span class="n">${n}</span></div>`).join('')}</div>
    <div class="hack-cleared"></div>`;
  (document.getElementById('hud') ?? document.body).appendChild(bar);
  document.body.classList.add('hack-mode');
  const turnsEl = bar.querySelector('.hack-turns');
  const clearedEl = bar.querySelector('.hack-cleared');
  const badgeEls = [...bar.querySelectorAll('.badge')];

  function refreshBar() {
    const sb = hack.state;
    const h = hx();
    if (!h) return;
    const left = H.turns - sb.round + (sb.over ? 0 : 1);
    turnsEl.className = 'hack-turns' + (sb.over ? ' over' : left <= 1 ? ' last' : '');
    turnsEl.textContent = sb.over
      ? (sb.over === 'win' ? `HACK COMPLETE - ${h.badges} BADGE${h.badges === 1 ? '' : 'S'}` : 'HACK FAILED')
      : `Turn ${sb.round} / ${H.turns}`;
    badgeEls.forEach((el, i) => el.classList.toggle('lit', h.badges > i));
    clearedEl.innerHTML = `nodes down <b>${h.cleared}</b> / ${h.total}` + (h.lastTurn ? ` - last volley +${h.lastTurn.cleared}` : '');
    // The battle bar's round counter reads "Turn n / N" in this mode.
    const roundEl = document.getElementById('battle-round');
    if (roundEl) roundEl.textContent = sb.over ? (sb.over === 'win' ? 'Hack complete' : 'Hack failed') : `Turn ${sb.round} / ${H.turns}`;
  }

  // ----- node bodies with a flat hp decal on top -----------------------------
  const nodeGeo = new THREE.CylinderGeometry(tileRadius * 0.5, tileRadius * 0.58, 0.5, 6, 1);
  nodeGeo.translate(0, 0.25, 0);
  if (view.map?.orientation === 'flat') nodeGeo.rotateY(Math.PI / 6);
  const decalGeo = new THREE.PlaneGeometry(tileRadius * 0.86, tileRadius * 0.86);
  decalGeo.rotateX(-Math.PI / 2);
  const decalTex = new Map();   // hp -> texture
  function hpTexture(hp, hurt) {
    const key = hp + (hurt ? 'h' : '');
    let tex = decalTex.get(key);
    if (tex) return tex;
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(8, 12, 22, 0.55)';
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill();
    g.fillStyle = hurt ? '#ffd9b0' : '#ffffff';
    g.font = `bold ${String(hp).length > 2 ? 52 : 64}px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(hp), 64, 68);
    tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    decalTex.set(key, tex);
    return tex;
  }
  const nodes = new Map();   // key -> { body, decal, hp }
  function syncNodes() {
    const sb = hack.state;
    const want = new Set(Object.keys(sb.tags).filter((k) => sb.tags[k].defId === 'node' && sb.tags[k].hp > 0));
    for (const [k, n] of nodes) {
      if (want.has(k)) continue;
      scene.remove(n.body); n.body.material.dispose();
      scene.remove(n.decal); n.decal.material.dispose();
      nodes.delete(k);
    }
    for (const k of want) {
      const tag = sb.tags[k];
      const tile = view.map.hexes.get(k);
      if (!tile) continue;
      let n = nodes.get(k);
      if (!n) {
        const body = new THREE.Mesh(nodeGeo, new THREE.MeshStandardMaterial({ color: colors.node, emissive: colors.node, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.2 }));
        body.position.set(tile.x, tile.top, -tile.y);
        body.castShadow = true;
        scene.add(body);
        const decal = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({ map: hpTexture(tag.hp, false), transparent: true, depthWrite: false }));
        decal.position.set(tile.x, tile.top + 0.505, -tile.y);
        decal.renderOrder = 6;
        scene.add(decal);
        n = { body, decal, hp: null };
        nodes.set(k, n);
      }
      const hurt = tag.hp <= tag.maxHp / 2;
      n.body.material.color.set(hurt ? colors.nodeHurt : colors.node);
      n.body.material.emissive.set(hurt ? colors.nodeHurt : colors.node);
      if (n.hp !== tag.hp) {
        n.hp = tag.hp;
        n.decal.material.map = hpTexture(tag.hp, hurt);
        n.decal.material.needsUpdate = true;
      }
      // The emoji sprite the arena drew for this tag is redundant under a body.
      const sprite = view.tagSprites?.get(k);
      if (sprite) sprite.visible = false;
    }
  }

  // ----- per-change / per-frame -----------------------------------------------
  function refresh() {
    syncNodes();
    refreshBar();
  }
  let raf = 0;
  (function tick() {
    raf = requestAnimationFrame(tick);
    if (!view.scene || view.scene !== scene) return;
    // The hp decals turn to face the camera's bearing, so the number reads
    // upright from wherever the arena has been rotated to.
    if (view.camera) {
      for (const n of nodes.values()) {
        n.decal.rotation.y = Math.atan2(view.camera.position.x - n.decal.position.x, view.camera.position.z - n.decal.position.z);
      }
    }
    // A sprite the arena re-created (a tag re-synced) would pop back: keep node
    // tiles' emoji hidden.
    for (const k of nodes.keys()) { const s = view.tagSprites?.get(k); if (s && s.visible) s.visible = false; }
  })();

  function dispose() {
    cancelAnimationFrame(raf);
    for (const n of nodes.values()) { scene.remove(n.body); n.body.material.dispose(); scene.remove(n.decal); n.decal.material.dispose(); }
    nodes.clear();
    nodeGeo.dispose();
    decalGeo.dispose();
    for (const t of decalTex.values()) t.dispose();
    decalTex.clear();
    bar.remove();
    style.remove();
    document.body.classList.remove('hack-mode');
  }

  refresh();
  return { refresh, dispose };
}
