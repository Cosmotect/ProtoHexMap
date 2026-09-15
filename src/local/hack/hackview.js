// =====================================================================
//  HACK ENCOUNTER - the extra presentation.  *** EXPERIMENT (see DESIGN.md) ***
//
//  Everything the hack shows that a fight does not, layered ON TOP of the
//  ordinary arena (LocalMapView) without changing it:
//    * the HACK PROGRESS bar at the top of the screen (-max .. 0 .. +max),
//      a DOM element with its own <style> block - style.css is untouched;
//    * NODE bodies: a short hex column per node with its hp on a label,
//      standing in for the emoji sprite syncBattle() would show (that sprite
//      is hidden for node tiles; mines keep theirs);
//    * LOCK marks: every unit's locked aim painted on the board in that
//      unit's own colour (a fill per covered tile, a ring on the aim tile);
//    * PREVIEW numbers: over every node and mine the total it would take if
//      the turn fired now - the standing locks plus the aim under the cursor.
//  The view reads the hack engine's state and previewTotals(); it owns its
//  own meshes and DOM and removes all of them in dispose().
// =====================================================================
import * as THREE from 'three';

const SQRT3 = Math.sqrt(3);

export function createHackView({ view, hack, H }) {
  const scene = view.scene;
  const cfg = view.config.local;
  const tileRadius = cfg.hexSize - cfg.gap / SQRT3;
  const colors = H.colors;

  // ----- the progress bar (DOM) -------------------------------------------
  const style = document.createElement('style');
  style.id = 'hack-style';
  style.textContent = `
    #hack-bar { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); width: min(560px, 60vw);
      padding: 8px 14px 10px; pointer-events: none; text-align: center; }
    #hack-bar .hack-title { font-family: var(--display); letter-spacing: 0.14em; font-size: 12px; color: var(--muted); text-transform: uppercase; }
    #hack-bar .hack-title b { color: var(--accent); letter-spacing: 0.06em; }
    #hack-bar .hack-track { position: relative; height: 16px; margin-top: 6px; border-radius: 8px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--panel-border); overflow: hidden; }
    #hack-bar .hack-fill { position: absolute; top: 0; bottom: 0; left: 50%; width: 0; transition: width .35s ease, left .35s ease; }
    #hack-bar .hack-fill.pos { background: linear-gradient(90deg, rgba(143,224,184,0.55), var(--good)); }
    #hack-bar .hack-fill.neg { background: linear-gradient(270deg, rgba(255,107,107,0.55), var(--danger)); }
    #hack-bar .hack-mid { position: absolute; top: -2px; bottom: -2px; left: 50%; width: 2px; background: rgba(255,255,255,0.7); }
    #hack-bar .hack-ends { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 3px; }
    #hack-bar .hack-ends span.val { color: var(--text); }
    #hack-bar .hack-turns { font-family: var(--mono); font-size: 12px; color: var(--text); margin-top: 2px; }
    #hack-bar .hack-turns.last { color: var(--danger); }
    #hack-bar .hack-delta { font-family: var(--mono); font-size: 12px; margin-left: 8px; }
    #hack-bar .hack-delta.up { color: var(--good); } #hack-bar .hack-delta.down { color: var(--danger); }
    body.hack-mode #battle-bar .battle-round { color: var(--accent); }
    /* No enemy in a hack: the info panel's roster block and its separator go. */
    body.hack-mode #local-info .li-roster-label, body.hack-mode #local-info #enemy-roster, body.hack-mode #local-info .li-sep { display: none; }
  `;
  document.head.appendChild(style);
  const bar = document.createElement('div');
  bar.id = 'hack-bar';
  bar.className = 'panel';
  bar.innerHTML = `
    <div class="hack-title"><b>HACK PROGRESS</b></div>
    <div class="hack-track"><div class="hack-fill pos"></div><div class="hack-mid"></div></div>
    <div class="hack-ends"><span>-${H.progressMax}</span><span class="val">0</span><span>+${H.progressMax}</span></div>
    <div class="hack-turns"></div>`;
  (document.getElementById('hud') ?? document.body).appendChild(bar);
  document.body.classList.add('hack-mode');
  const fillEl = bar.querySelector('.hack-fill');
  const valEl = bar.querySelector('.hack-ends .val');
  const turnsEl = bar.querySelector('.hack-turns');

  function refreshBar() {
    const sb = hack.state;
    const p = sb.progress, max = H.progressMax;
    const pct = Math.min(100, Math.abs(p) / max * 100) / 2;   // half the track each way
    fillEl.className = 'hack-fill ' + (p >= 0 ? 'pos' : 'neg');
    fillEl.style.width = pct + '%';
    fillEl.style.left = p >= 0 ? '50%' : (50 - pct) + '%';
    valEl.textContent = (p > 0 ? '+' : '') + p;
    const left = H.turns - sb.round + (sb.over ? 0 : 1);
    const delta = sb.lastTurn ? (sb.lastTurn.gained - sb.lastTurn.lost) : null;
    turnsEl.className = 'hack-turns' + (left <= 1 && !sb.over ? ' last' : '');
    turnsEl.innerHTML = sb.over
      ? (sb.over === 'win' ? 'HACK COMPLETE' : 'HACK FAILED')
      : `Turn ${sb.round} / ${H.turns}` + (delta != null ? `<span class="hack-delta ${delta >= 0 ? 'up' : 'down'}">last turn ${delta >= 0 ? '+' : ''}${delta}</span>` : '');
    // The battle bar's round counter reads "Turn n / N" in this mode.
    const roundEl = document.getElementById('battle-round');
    if (roundEl) roundEl.textContent = sb.over ? (sb.over === 'win' ? 'Hack complete' : 'Hack failed') : `Turn ${sb.round} / ${H.turns}`;
    // The fight's movement hint does not apply: nothing locks a unit in place here.
    const hint = document.querySelector('#battle-active .muted');
    if (hint) {
      const c = hack.curPlayer();
      const n = hack.lockedUnits().length, total = sb.units.filter((u) => u.hp > 0).length;
      hint.textContent = c && c.lock ? `Aim locked: ${c.lock.abName} (re-aim or walk to change). ${n}/${total} aimed - End turn fires all.`
        : `Move freely, pick an ability and click a tile to LOCK the aim. ${n}/${total} aimed - End turn fires all.`;
    }
  }

  // ----- label sprites (canvas text) -----------------------------------------
  const texCache = new Map();
  function labelTexture(text, color, sub) {
    const key = text + '|' + color + '|' + (sub ?? '');
    let tex = texCache.get(key);
    if (tex) return tex;
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 128;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 256, 128);
    // A soft dark pill so the number reads on a bright tile.
    g.fillStyle = 'rgba(10, 14, 24, 0.72)';
    const w = sub ? 220 : 150, h = 80, x = (256 - w) / 2, y = (128 - h) / 2;
    g.beginPath();
    g.moveTo(x + 24, y); g.lineTo(x + w - 24, y); g.quadraticCurveTo(x + w, y, x + w, y + 24);
    g.lineTo(x + w, y + h - 24); g.quadraticCurveTo(x + w, y + h, x + w - 24, y + h);
    g.lineTo(x + 24, y + h); g.quadraticCurveTo(x, y + h, x, y + h - 24);
    g.lineTo(x, y + 24); g.quadraticCurveTo(x, y, x + 24, y); g.closePath(); g.fill();
    g.fillStyle = color;
    g.textAlign = sub ? 'left' : 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 54px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
    if (sub) {
      g.fillText(text, x + 16, 64);
      const tw = g.measureText(text).width;
      g.font = 'bold 30px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
      g.fillStyle = '#ffffff';
      g.fillText(sub, x + 16 + tw + 8, 60);
    } else g.fillText(text, 128, 64);
    tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    texCache.set(key, tex);
    return tex;
  }
  function makeLabel(text, color, sub, scale = 0.9) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text, color, sub), transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(scale, scale / 2, 1);
    sprite.renderOrder = 20;
    return sprite;
  }
  const tilePos = (k) => view.map.hexes.get(k);

  // ----- node bodies ---------------------------------------------------------
  const nodeGeo = new THREE.CylinderGeometry(tileRadius * 0.5, tileRadius * 0.58, 0.5, 6, 1);
  nodeGeo.translate(0, 0.25, 0);
  if (view.map?.orientation === 'flat') nodeGeo.rotateY(Math.PI / 6);
  const nodes = new Map();   // key -> { body, label, hp }
  function syncNodes() {
    const sb = hack.state;
    const want = new Set(Object.keys(sb.tags).filter((k) => sb.tags[k].kind === 'node'));
    for (const [k, n] of nodes) {
      if (want.has(k)) continue;
      scene.remove(n.body); n.body.material.dispose();
      scene.remove(n.label); n.label.material.dispose();
      nodes.delete(k);
    }
    for (const k of want) {
      const tag = sb.tags[k];
      const tile = tilePos(k);
      if (!tile) continue;
      let n = nodes.get(k);
      if (!n) {
        const body = new THREE.Mesh(nodeGeo, new THREE.MeshStandardMaterial({ color: colors.node, emissive: colors.node, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.2 }));
        body.position.set(tile.x, tile.top, -tile.y);
        body.castShadow = true;
        scene.add(body);
        const label = makeLabel(String(tag.hp), '#ffffff', null, 0.95);
        label.position.set(tile.x, tile.top + 0.95, -tile.y);
        scene.add(label);
        n = { body, label, hp: tag.hp, text: null };
        nodes.set(k, n);
      }
      const hurt = tag.hp <= tag.maxHp / 2;
      n.body.material.color.set(hurt ? colors.nodeHurt : colors.node);
      n.body.material.emissive.set(hurt ? colors.nodeHurt : colors.node);
      // The emoji sprite the arena drew for this tag is redundant under a body.
      const sprite = view.tagSprites?.get(k);
      if (sprite) sprite.visible = false;
    }
  }

  // ----- lock marks + preview numbers ---------------------------------------
  let marks = [];
  let previewLabels = [];
  let lastSig = null;
  function clearMarks() {
    for (const m of marks) { scene.remove(m); m.material.dispose(); }
    marks = [];
    for (const l of previewLabels) { scene.remove(l); l.material.dispose(); }
    previewLabels = [];
  }
  function fill(k, color, opacity, lift = 0) {
    const tile = tilePos(k); if (!tile) return;
    const m = new THREE.Mesh(view.aimFillGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    m.position.set(tile.x, tile.top + 0.05 + lift, -tile.y);
    m.renderOrder = 4;
    scene.add(m); marks.push(m);
  }
  function ring(k, color) {
    const tile = tilePos(k); if (!tile) return;
    const m = new THREE.Mesh(view.hlRingGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    m.position.set(tile.x, tile.top + 0.06, -tile.y);
    m.renderOrder = 5;
    scene.add(m); marks.push(m);
  }
  function hoverKey() {
    const sb = hack.state;
    if (sb.over || sb.phase !== 'player' || !sb.selAb || !sb.aimMap) return null;
    const k = view.hoverKey;
    return k && sb.aimMap[k] !== undefined ? k : null;
  }
  function signature() {
    const sb = hack.state;
    const locks = sb.units.map((u) => (u.lock ? `${u.uid}:${u.lock.abId}@${u.lock.anchor}` : '')).join(';');
    return `${locks}|${hoverKey() ?? ''}|${sb.selAb ?? ''}|${sb.activeUid ?? ''}|${sb.round}|${sb.over ?? ''}|${Object.keys(sb.tags).length}|${sb.progress}`;
  }
  function syncMarks() {
    const sig = signature();
    if (sig === lastSig) return;
    lastSig = sig;
    clearMarks();
    const sb = hack.state;
    if (sb.over) { syncNodeLabels(new Map()); return; }
    // Standing locks, each in its unit's colour.
    for (const u of sb.units) {
      if (u.hp <= 0 || !u.lock) continue;
      const color = colors.locks[u.idx % colors.locks.length];
      const active = u.uid === sb.activeUid;
      for (const t of u.lock.tiles) fill(t, color, active ? 0.34 : 0.22, 0.01 + u.idx * 0.004);
      ring(u.lock.anchor, color);
    }
    // The numbers: what every covered node / mine would take.
    const totals = hack.previewTotals(hoverKey());
    syncNodeLabels(totals);
    for (const [k, e] of totals) {
      if (e.kind !== 'mine') continue;
      const tile = tilePos(k); if (!tile) continue;
      const l = makeLabel(`-${H.minePenalty * e.n}`, colors.mineText, e.n > 1 ? `x${e.n}` : null, 1.15);
      l.position.set(tile.x, tile.top + 0.9, -tile.y);
      scene.add(l); previewLabels.push(l);
    }
  }
  // A node's label shows its hp - or, while targeted, the damage it would take.
  function syncNodeLabels(totals) {
    for (const [k, n] of nodes) {
      const tag = hack.state.tags[k];
      const e = totals.get(k);
      let text, color, sub = null;
      if (e && e.total > 0) { text = `-${e.total}`; color = colors.previewText; sub = e.mult > 1 ? `x${e.mult}` : null; }
      else { text = String(tag ? tag.hp : n.hp); color = '#ffffff'; }
      const key = text + '|' + color + '|' + (sub ?? '');
      if (n.text === key) continue;
      n.text = key;
      n.label.material.map = labelTexture(text, color, sub);
      n.label.material.needsUpdate = true;
      n.label.scale.set(sub ? 1.4 : 0.95, sub ? 0.7 : 0.475, 1);
    }
  }

  // ----- per-change / per-frame -----------------------------------------------
  function refresh() {
    syncNodes();
    refreshBar();
    lastSig = null;
    syncMarks();
  }
  let raf = 0;
  (function tick() {
    raf = requestAnimationFrame(tick);
    if (!view.scene || view.scene !== scene) return;
    // Hovering changes the preview without any engine change: watch it here.
    syncMarks();
    // A sprite the arena re-created (a tag re-synced) would pop back: keep node
    // tiles' emoji hidden.
    for (const k of nodes.keys()) { const s = view.tagSprites?.get(k); if (s && s.visible) s.visible = false; }
  })();

  function dispose() {
    cancelAnimationFrame(raf);
    clearMarks();
    for (const n of nodes.values()) { scene.remove(n.body); n.body.material.dispose(); scene.remove(n.label); n.label.material.dispose(); }
    nodes.clear();
    nodeGeo.dispose();
    for (const t of texCache.values()) t.dispose();
    texCache.clear();
    bar.remove();
    style.remove();
    document.body.classList.remove('hack-mode');
  }

  refresh();
  return { refresh, dispose };
}
