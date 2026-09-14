// =====================================================================
//  THE ABILITY UPGRADE TREE, drawn - shared by the roster window (src/ui.js)
//  and the party view (src/partyview.js).
//
//  A real card per node - icon, name and what it does - laid out in columns by
//  depth, with the requires-edges drawn behind them, so the shape of the tree
//  and what any node actually DOES are both visible at once. The cards are
//  absolutely positioned from coordinates computed here, and the edge SVG uses
//  the SAME coordinates, so the lines meet the cards exactly without measuring
//  the DOM after layout.
//
//  Two sizes: the roster window's full cards (icon + name + description) and
//  the party view's MINI cards (name on top, the node's `short` line below;
//  see U() in config/abilities.js). Same layout, same three states:
//    owned   unlocked on this unit
//    open    takeable next - every prerequisite is unlocked
//    locked  still gated behind something else
//
//  Every card is a BUTTON carrying data-ref="<abilityId>:<nodeId>", and only an
//  `open` one is enabled. Clicking it takes the upgrade - the windows that own
//  a real unit (the roster's detail pane, the party view) listen for that and
//  call unlockUpgrade; a window with nobody to grant it to just does not listen.
// =====================================================================
import { upgradeTree, treeLayout, upgradeRef, upgradeInfo } from './upgrades.js';

const SIZES = {
  full: { cardW: 152, cardH: 62, colGap: 34, rowGap: 10, padY: 4 },
  mini: { cardW: 104, cardH: 40, colGap: 12, rowGap: 6, padY: 2 },
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const escapeAttr = escapeHtml;

// `unlocked` is a Set of node refs ("<abilityId>:<nodeId>"). Returns '' for an
// ability with no tree.
export function abilityTreeHtml(abilityId, unlocked, size = 'full') {
  const tree = upgradeTree(abilityId);
  if (!tree) return '';
  const T = SIZES[size] ?? SIZES.full;
  const { layers, edges } = treeLayout(abilityId);
  const rows = Math.max(1, ...layers.map((l) => l.length));
  const W = layers.length * T.cardW + (layers.length - 1) * T.colGap;
  const H = rows * T.cardH + (rows - 1) * T.rowGap + T.padY * 2;
  // Each column is centred vertically against the tallest one, so a branch of
  // two sits level with the middle of a branch of three.
  const pos = {};
  layers.forEach((nodes, d) => {
    const colH = nodes.length * T.cardH + (nodes.length - 1) * T.rowGap;
    const top = T.padY + (H - T.padY * 2 - colH) / 2;
    nodes.forEach((n, i) => {
      pos[n] = { x: d * (T.cardW + T.colGap), y: top + i * (T.cardH + T.rowGap) };
    });
  });
  const isOpen = (n) => (tree[n].requires ?? []).every((p) => unlocked.has(upgradeRef(abilityId, p)));
  // Edges leave a parent's right edge and arrive at a child's left edge; the
  // cubic keeps them clear of the cards they pass.
  const lines = edges.map(([a, b]) => {
    const p = pos[a], c = pos[b];
    const x1 = p.x + T.cardW, y1 = p.y + T.cardH / 2;
    const x2 = c.x, y2 = c.y + T.cardH / 2;
    const mid = x1 + (x2 - x1) / 2;
    const on = unlocked.has(upgradeRef(abilityId, a)) ? ' on' : '';
    return `<path class="ut-edge${on}" d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}"></path>`;
  }).join('');
  // Every card is a BUTTON, carrying its own node reference. Only an `open`
  // one is enabled, so the browser itself refuses a click on an owned or a
  // still-gated node and whoever wired the window only has to listen for
  // `.ut-card` clicks and read data-ref. A window that grants nothing (a
  // preview of a character who is not in the party) simply does not listen.
  const cards = Object.keys(tree).map((n) => {
    const p = pos[n];
    const ref = upgradeRef(abilityId, n);
    const cls = unlocked.has(ref) ? 'owned' : isOpen(n) ? 'open' : 'locked';
    const { name, desc, short, icon } = upgradeInfo(abilityId, n);
    const style = `left:${p.x}px;top:${p.y}px;width:${T.cardW}px;height:${T.cardH}px`;
    const attrs = `type="button" class="ut-card ${size === 'mini' ? 'mini ' : ''}${cls}" style="${style}"`
      + ` data-ref="${escapeAttr(ref)}" title="${escapeAttr(`${name} - ${desc}`)}"${cls === 'open' ? '' : ' disabled'}`;
    if (size === 'mini') {
      return `<button ${attrs}>
        <span class="ut-text"><b>${escapeHtml(name)}</b><i>${escapeHtml(short || desc)}</i></span>
      </button>`;
    }
    return `<button ${attrs}>
      <span class="ut-icon">${icon}</span>
      <span class="ut-text"><b>${escapeHtml(name)}</b><i>${escapeHtml(desc)}</i></span>
    </button>`;
  }).join('');
  return `<div class="ability-tree ${size}" style="width:${W}px;height:${H}px">
    <svg class="ut-edges" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${lines}</svg>
    ${cards}
  </div>`;
}
