// =====================================================================
//  THE PARTY VIEW - the window TAB opens, in and out of a fight.
//
//  One column per party member, each read top to bottom:
//    header      portrait glyph, name, the numbers (HP, speed, flying)
//    health bar  the party panel's bar, so it reads the same everywhere
//    portrait    the unit's arena body, live in 3D, turning on a gradient
//    abilities   one section per ability: what it does, its numbers as this
//                unit has them (upgrades folded in), the cost, and every
//                upgrade node unlocked on it with the node's own sentence
//    relic       the relic slot (empty until relics exist)
//    passives    everything the unit carries as a passive, with WHERE it came
//                from (an upgrade node, a relic, an aura) and WHEN it fires
//    effects     in a fight only: every status on the unit right now, the
//                permanent ones included - the unit card hides those
//
//  Reads the same sources as everything else (the config tables, upgrades.js,
//  status.js) and writes nothing. In a fight the HP and the effects come off
//  the live combat unit; outside one, off the run's party.
//
//  THE 3D PORTRAITS: one extra WebGL renderer on a transparent canvas laid over
//  the whole window, drawing each column's portrait box through a scissor
//  rectangle - the three.js "multiple elements" pattern. One canvas, one GL
//  context, three viewports; the gradient behind each is plain CSS on the box.
//  The body is the very mesh the arena builds (makePartyBody in localview.js),
//  so the portrait is the unit, not a picture of it.
// =====================================================================
import * as THREE from 'three';
import { t, tn } from './i18n.js';
import { ABILITIES, ABILITY_UPGRADES, STATUSES, parsePassive } from './config/abilities.js';
import { combatStatsFor } from './config/entities.js';
import { unitAbilityIds, upgradeRef, upgradeInfo, abilityDesc, resolveAbility, passivesFor } from './upgrades.js';
import { statusesFor, statusInfo, badgeNumber } from './status.js';
import { makePartyBody } from './local/localview.js';

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const COST_ICON = { hp: '❤️', supplies: '📦', move: '👣' };

export function createPartyView({ config, getGame, getBattle }) {
  const root = document.getElementById('party-view');
  const membersEl = document.getElementById('pv-members');
  const canvas = document.getElementById('pv-canvas');
  let open = false;
  let raf = 0;
  let signature = '';
  let gl = null;                 // { renderer, scenes: [{ scene, camera, body }] } - built on first open
  let lastT = 0;

  // ----- what to show ---------------------------------------------------------
  // The party as it is right now: the run's members, with the live combat
  // instance beside each when a fight is on.
  function members() {
    const game = getGame();
    const battle = getBattle();
    const party = game?.state?.party ?? [];
    return party.map((u, i) => ({
      unit: u, index: i,
      live: battle ? battle.state.units.find((x) => x.partyIndex === i) ?? null : null,
    }));
  }

  // Every passive this unit is under and where each came from. passivesFor
  // (upgrades.js) is what the fight uses and merges the sources; this walks
  // the same three sources again only to be able to NAME them.
  function passiveRows(unit) {
    const out = [];
    const add = (e, source) => {
      const p = parsePassive(e, true);
      if (!p) return;
      const dup = out.find((q) => q.status === p.status && q.when === p.when);
      if (dup) { if (!dup.sources.includes(source)) dup.sources.push(source); return; }
      out.push({ ...p, sources: [source] });
    };
    const unlocked = new Set(unit?.upgrades ?? []);
    for (const abilityId of unitAbilityIds(unit?.name)) {
      const tree = ABILITY_UPGRADES[abilityId];
      if (!tree) continue;
      for (const [nodeId, node] of Object.entries(tree)) {
        if (!unlocked.has(upgradeRef(abilityId, nodeId))) continue;
        for (const e of node.passives ?? []) add(e, upgradeInfo(abilityId, nodeId).name);
      }
    }
    for (const e of unit?.relic?.passives ?? []) add(e, unit.relic.name ? tn(unit.relic.name) : t('partyview.source.relic'));
    for (const e of unit?.auraPassives ?? []) add(e, t('partyview.source.aura'));
    // Anything passivesFor knows that the walk above did not (a source added
    // later) still shows, unattributed, rather than silently missing.
    for (const p of passivesFor(unit)) if (!out.some((q) => q.status === p.status && q.when === p.when)) out.push({ ...p, sources: [] });
    return out;
  }

  function abilityNumbers(ab) {
    const parts = [];
    if (ab.damage > 0) parts.push(t('battle.ui.dmg', { n: ab.damage }));
    if (ab.heal > 0) parts.push(t('battle.ui.heal', { n: ab.heal }));
    if (ab.buff && STATUSES[ab.buff]) parts.push(statusInfo(ab.buff).name);
    for (const res of ['hp', 'supplies', 'move']) {
      const n = ab.cost?.[res] || 0;
      if (n) parts.push(`${COST_ICON[res]} ${t(n < 0 ? `battle.cost.gain.${res}` : `battle.cost.${res}`, { n: Math.abs(n) })}`);
    }
    return parts.join(' · ');
  }

  function abilitySection(unit, id) {
    const base = ABILITIES[id];
    if (!base) return `<div class="pv-section pv-ability empty">${escapeHtml(t('slot.ability.empty'))}</div>`;
    const ab = resolveAbility(id, unit.upgrades ?? []) ?? base;
    const owned = (unit.upgrades ?? []).filter((r) => r.startsWith(`${id}:`)).map((r) => r.slice(id.length + 1));
    const nodes = owned.map((n) => {
      const info = upgradeInfo(id, n);
      return `<li><span class="pv-up-icon">${info.icon}</span><b>${escapeHtml(info.name)}</b><span class="pv-up-desc">${escapeHtml(info.desc)}</span></li>`;
    }).join('');
    const nums = abilityNumbers(ab);
    return `<div class="pv-section pv-ability">
      <div class="pv-sec-head"><span class="pv-sec-icon">${ab.icon}</span><b>${escapeHtml(ab.name)}</b></div>
      <div class="pv-sec-desc">${escapeHtml(abilityDesc(id, config))}</div>
      ${nums ? `<div class="pv-sec-nums">${escapeHtml(nums)}</div>` : ''}
      <div class="pv-sub">${escapeHtml(t('partyview.upgrades'))}</div>
      ${nodes ? `<ul class="pv-ups">${nodes}</ul>` : `<div class="pv-none">${escapeHtml(t('partyview.upgrades.none'))}</div>`}
    </div>`;
  }

  function relicSection(unit) {
    const r = unit.relic;
    return `<div class="pv-section pv-relic ${r ? '' : 'empty'}">
      <div class="pv-sec-head"><span class="pv-sec-icon">${r?.icon ?? '◇'}</span><b>${escapeHtml(r ? tn(r.name) : t('slot.relic.empty'))}</b></div>
      ${r?.desc ? `<div class="pv-sec-desc">${escapeHtml(r.desc)}</div>` : ''}
    </div>`;
  }

  function passivesSection(unit) {
    const rows = passiveRows(unit).map((p) => {
      const info = statusInfo(p.status);
      const when = t(`partyview.moment.${p.when}`);
      const from = p.sources.length ? t('partyview.source', { list: p.sources.join(', ') }) : '';
      return `<li><span class="pv-st-icon" style="color:${escapeHtml(info.color)}">${info.icon}</span>
        <div><b>${escapeHtml(info.name)}</b> <span class="pv-when">${escapeHtml(when)}</span>
        <div class="pv-up-desc">${escapeHtml(info.desc)}</div>
        ${from ? `<div class="pv-from">${escapeHtml(from)}</div>` : ''}</div></li>`;
    }).join('');
    return `<div class="pv-section pv-passives">
      <div class="pv-sub">${escapeHtml(t('partyview.passives'))}</div>
      ${rows ? `<ul class="pv-ups">${rows}</ul>` : `<div class="pv-none">${escapeHtml(t('partyview.passives.none'))}</div>`}
    </div>`;
  }

  // In a fight: every status on the unit right now, permanent ones included.
  function effectsSection(live) {
    if (!live) return '';
    const rows = statusesFor(live, { permanent: true }).map((hs) => {
      const info = statusInfo(hs);
      const num = badgeNumber(hs);
      const tail = hs.turns > 0 ? t('status.turns', { n: hs.turns }) : hs.charges > 1 ? t('partyview.charges', { n: hs.charges }) : hs.permanent ? t('partyview.permanent') : '';
      return `<li><span class="pv-st-icon" style="color:${escapeHtml(info.color)}">${info.icon}${num ? `<i>${num}</i>` : ''}</span>
        <div><b>${escapeHtml(info.name)}</b> ${tail ? `<span class="pv-when">${escapeHtml(tail)}</span>` : ''}
        <div class="pv-up-desc">${escapeHtml(info.desc)}</div></div></li>`;
    }).join('');
    return `<div class="pv-section pv-effects">
      <div class="pv-sub">${escapeHtml(t('partyview.effects'))}</div>
      ${rows ? `<ul class="pv-ups">${rows}</ul>` : `<div class="pv-none">${escapeHtml(t('partyview.effects.none'))}</div>`}
    </div>`;
  }

  function memberHtml({ unit, index, live }) {
    const hp = live ? live.hp : unit.hp;
    const maxHp = live ? live.maxHp : unit.maxHp;
    const alive = live ? live.hp > 0 : unit.alive;
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    const segPct = (config.party.hpSegment / maxHp) * 100;
    const cs = combatStatsFor(unit.name);
    const stats = [t('party.hp', { hp, max: maxHp }), t('partyview.speed', { n: cs.speed }), cs.flying ? t('partyview.flying') : ''].filter(Boolean).join(' · ');
    const abs = unitAbilityIds(unit.name);
    while (abs.length < 2) abs.push(null);
    return `<div class="pv-member ${!alive ? 'dead' : pct < 50 ? 'hurt' : ''}" data-i="${index}">
      <div class="pv-head">
        <span class="pv-icon">${unit.icon ?? ''}</span>
        <div class="pv-head-text"><div class="pv-name">${escapeHtml(tn(unit.name))}</div><div class="pv-stats">${escapeHtml(alive ? stats : t('party.disabled'))}</div></div>
      </div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div><div class="segs" style="--seg:${segPct}%"></div></div>
      <div class="pv-portrait" data-i="${index}"></div>
      <div class="pv-scroll">
        ${abs.map((id) => abilitySection(unit, id)).join('')}
        ${relicSection(unit)}
        ${passivesSection(unit)}
        ${effectsSection(live)}
      </div>
    </div>`;
  }

  // Rebuilt only when what it shows has changed, so a column the player is
  // scrolling is not yanked back to the top by a redraw that changed nothing.
  function render(force = false) {
    const ms = members();
    const sig = JSON.stringify(ms.map(({ unit, live }) => [unit.name, unit.hp, unit.maxHp, unit.alive, unit.upgrades, unit.relic?.name,
      live ? [live.hp, live.status] : null]));
    if (!force && sig === signature) return;
    signature = sig;
    membersEl.innerHTML = ms.map(memberHtml).join('');
    syncScenes(ms);
  }

  // ----- the 3D portraits -----------------------------------------------------
  function ensureGl() {
    if (gl) return gl;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.setScissorTest(true);
    renderer.shadowMap.enabled = false;
    gl = { renderer, scenes: [] };
    return gl;
  }
  // One little scene per member: the body, two lights, a camera looking at it
  // from slightly above. Rebuilt when the party changes, not on every redraw.
  function syncScenes(ms) {
    const g = ensureGl();
    for (const s of g.scenes) s.body.geometry.dispose?.();
    g.scenes = ms.map(({ unit }) => {
      const scene = new THREE.Scene();
      const body = makePartyBody(config, unit);
      scene.add(body);
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(1.5, 2.5, 2);
      scene.add(key);
      const rim = new THREE.DirectionalLight(config.colors?.playerGlow ?? 0xffd166, 1.2);
      rim.position.set(-2, 1, -2);
      scene.add(rim);
      const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
      camera.position.set(0, 0.85, 2.3);
      camera.lookAt(0, 0.38, 0);
      return { scene, camera, body };
    });
  }
  function frame(now) {
    if (!open) return;
    raf = requestAnimationFrame(frame);
    render();
    const g = ensureGl();
    const r = g.renderer;
    const crect = canvas.getBoundingClientRect();
    if (crect.width === 0 || crect.height === 0) return;
    if (canvas.width !== Math.round(crect.width * r.getPixelRatio()) || canvas.height !== Math.round(crect.height * r.getPixelRatio())) {
      r.setSize(crect.width, crect.height, false);
    }
    const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0;
    lastT = now;
    r.setScissorTest(false);
    r.clear();
    r.setScissorTest(true);
    const boxes = membersEl.querySelectorAll('.pv-portrait');
    boxes.forEach((box, i) => {
      const s = g.scenes[i];
      if (!s) return;
      const b = box.getBoundingClientRect();
      // Off the canvas entirely (a column scrolled away): nothing to draw.
      if (b.bottom < crect.top || b.top > crect.bottom) return;
      const w = b.width, h = b.height;
      if (w <= 0 || h <= 0) return;
      // three's viewport is measured from the canvas's BOTTOM-left, in CSS px.
      const x = b.left - crect.left, y = crect.bottom - b.bottom;
      s.body.rotation.y += dt * 0.7;
      s.camera.aspect = w / h;
      s.camera.updateProjectionMatrix();
      r.setViewport(x, y, w, h);
      r.setScissor(x, y, w, h);
      r.render(s.scene, s.camera);
    });
  }

  // ----- open / close -----------------------------------------------------------
  function show() {
    if (open) return;
    open = true;
    root.classList.remove('hidden');
    signature = '';
    render(true);
    lastT = 0;
    raf = requestAnimationFrame(frame);
  }
  function close() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    root.classList.add('hidden');
  }
  function toggle() { if (open) close(); else show(); }
  // Called by whoever changed the party or the fight; cheap when nothing did.
  function refresh() { if (open) render(); }

  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  document.getElementById('pv-close')?.addEventListener('click', close);

  return { open: show, close, toggle, refresh, isOpen: () => open };
}
