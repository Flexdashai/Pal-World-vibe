/**
 * The tabbed overlay: INVENTORY, CHARACTER, SKILLS.
 *
 * One window, three pages, because three separately-styled full-screen panels
 * is how a HUD stops looking like one product. The frame, the tab strip, the
 * corner filigree and the type ramp are shared; only the contents differ.
 *
 * Everything is built once at init and then only its TEXT changes, so opening a
 * panel costs a class toggle. The item grid is 60 cells with a canvas icon
 * each; those canvases are drawn once when the item in the cell changes, never
 * per frame.
 *
 * The tooltip is the piece most worth getting right: rarity-coloured border and
 * name, the headline stat at display size, affixes as a value/label pair with
 * the value bolded and left-aligned so the eye can scan the column, and italic
 * flavour text on uniques only. That layout is doing the same job in Diablo,
 * Path of Exile and Last Epoch because it works.
 */

import { RARITY, ELEMENTS } from '../core/palette.js';
import { BRASS, alpha, shade } from './theme.js';
import { el, canvas as mkCanvas, setText, setClass, setShown, setStyle, clearNode, groupNum } from './dom.js';
import { drawItemIcon, drawSkillIcon } from './icons.js';
import { offscreen, toUrl, scroll, rivet, tarnish } from './ornament.js';
import { DOLL_SLOTS, makeSkillTree } from './fakedata.js';

const GRID_COLS = 10;
const GRID_ROWS = 6;

// ---------------------------------------------------------------------------
// shared art
// ---------------------------------------------------------------------------

/**
 * The armoured silhouette used by the equipment doll and the character
 * portrait. Drawn as filled paths with a violet rim light from behind, which is
 * the Solo Leveling read: the hero is a black shape with purple edges.
 */
export function drawHeroSilhouette(c, w, h) {
  c.clearRect(0, 0, w, h);
  const cx = w * 0.5;
  const S = Math.min(w / 210, h / 300);
  const violet = ELEMENTS.shadow.srgb;
  const violetHot = '#c9a8ff';

  // Backlight, kept tight. The first version used a radius of h*0.52 and washed
  // the entire panel violet, which made the whole inventory look tinted.
  const g = c.createRadialGradient(cx, h * 0.52, 0, cx, h * 0.52, h * 0.34);
  g.addColorStop(0, alpha(violet, 0.24));
  g.addColorStop(0.5, alpha(violet, 0.07));
  g.addColorStop(1, alpha(violet, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);

  c.save();
  c.translate(cx, h * 0.045);
  c.scale(S, S);

  // ---- shape definitions --------------------------------------------------
  // Every part is its own path so they can be filled at DIFFERENT VALUES. The
  // previous version unioned everything into one path and filled it flat, which
  // is why it read as an egg: a silhouette needs internal edges to be a figure
  // rather than a blob.
  // PROPORTION. Head 40 units against a 262-unit figure is 1:6.5 — heroic but
  // not chibi. The first attempt put a 60-unit head on the same body and the
  // result read as a toy; nothing else about a silhouette matters as much.
  const cape = (cc) => {
    cc.beginPath();
    cc.moveTo(-46, 48);
    cc.bezierCurveTo(-64, 110, -74, 196, -76, 262);
    cc.lineTo(-52, 246); cc.lineTo(-30, 266); cc.lineTo(-10, 244);
    cc.lineTo(10, 266); cc.lineTo(30, 244); cc.lineTo(52, 264); cc.lineTo(76, 262);
    cc.bezierCurveTo(74, 196, 64, 110, 46, 48);
    cc.closePath();
  };
  const legs = (cc) => {
    cc.beginPath();
    cc.moveTo(-25, 124); cc.lineTo(-7, 124); cc.lineTo(-9, 234); cc.lineTo(-24, 234); cc.closePath();
    cc.moveTo(25, 124); cc.lineTo(7, 124); cc.lineTo(9, 234); cc.lineTo(24, 234); cc.closePath();
  };
  const boots = (cc) => {
    cc.beginPath();
    cc.moveTo(-27, 232); cc.lineTo(-6, 232); cc.lineTo(-6, 254); cc.lineTo(-33, 254); cc.lineTo(-30, 240); cc.closePath();
    cc.moveTo(27, 232); cc.lineTo(6, 232); cc.lineTo(6, 254); cc.lineTo(33, 254); cc.lineTo(30, 240); cc.closePath();
  };
  const torso = (cc) => {
    cc.beginPath();
    cc.moveTo(-32, 46);
    cc.lineTo(32, 46);
    cc.lineTo(24, 92);
    cc.lineTo(21, 108);
    cc.lineTo(-21, 108);
    cc.lineTo(-24, 92);
    cc.closePath();
  };
  const belt = (cc) => {
    cc.beginPath();
    cc.moveTo(-25, 106); cc.lineTo(25, 106); cc.lineTo(27, 124); cc.lineTo(-27, 124); cc.closePath();
  };
  const arms = (cc) => {
    cc.beginPath();
    cc.moveTo(-47, 56); cc.lineTo(-34, 54); cc.lineTo(-29, 112); cc.lineTo(-41, 116); cc.closePath();
    cc.moveTo(47, 56); cc.lineTo(34, 54); cc.lineTo(29, 112); cc.lineTo(41, 116); cc.closePath();
  };
  // Angular, downswept pauldrons — a rounded cap reads as a shoulder pad, a
  // faceted wedge reads as plate armour.
  const pauldrons = (cc) => {
    cc.beginPath();
    cc.moveTo(-24, 42); cc.lineTo(-48, 40); cc.lineTo(-58, 58); cc.lineTo(-50, 70); cc.lineTo(-28, 62); cc.closePath();
    cc.moveTo(24, 42); cc.lineTo(48, 40); cc.lineTo(58, 58); cc.lineTo(50, 70); cc.lineTo(28, 62); cc.closePath();
  };
  const helm = (cc) => {
    cc.beginPath();
    cc.moveTo(-15, 8);
    cc.bezierCurveTo(-17, -12, 17, -12, 15, 8);
    cc.lineTo(13, 26); cc.lineTo(0, 36); cc.lineTo(-13, 26);
    cc.closePath();
    // crest
    cc.moveTo(-3, -8); cc.lineTo(3, -8); cc.lineTo(2, -26); cc.lineTo(-2, -26); cc.closePath();
  };
  const blade = (cc) => {
    cc.beginPath();
    // a long straight sword held point-down beside the right leg
    cc.moveTo(55, 78); cc.lineTo(63, 78); cc.lineTo(66, 232); cc.lineTo(59, 246); cc.lineTo(53, 232); cc.closePath();
    cc.moveTo(47, 70); cc.lineTo(72, 70); cc.lineTo(72, 78); cc.lineTo(47, 78); cc.closePath();
  };

  /**
   * VALUE SEPARATION IS THE WHOLE TRICK. The first version filled every part
   * from nearly the same near-black ramp and the figure read as one violet-
   * outlined egg. Armour has to be perceptibly lighter than the cape behind it,
   * and each plate needs its own value, or a silhouette is just a blob.
   *
   * Ordered back to front. `rim` marks the parts that get the violet contour
   * glow — only the outermost ones, because rimming interior plates as well is
   * what merged them into a single halo.
   */
  const parts = [
    { p: cape, top: '#110d1e', bot: '#050409', rim: true },
    { p: legs, top: '#332c48', bot: '#171327' },
    { p: boots, top: '#3d3453', bot: '#191423' },
    { p: arms, top: '#372f4e', bot: '#171326' },
    { p: torso, top: '#443b60', bot: '#221d36' },
    { p: belt, top: '#6d5729', bot: '#2c2210' },
    { p: pauldrons, top: '#4c4269', bot: '#241f3a', rim: true },
    { p: helm, top: '#473d63', bot: '#1d182c', rim: true },
    { p: blade, top: '#6c6684', bot: '#201d2c', rim: true },
  ];

  // ---- violet contour glow on the outer plates only ----------------------
  c.save();
  c.shadowColor = violet;
  c.shadowBlur = 15;
  c.lineJoin = 'round';
  c.lineWidth = 3.2;
  c.strokeStyle = alpha(violet, 0.85);
  for (const part of parts) if (part.rim) { part.p(c); c.stroke(); }
  c.restore();

  // ---- filled parts, back to front ---------------------------------------
  for (const part of parts) {
    const g2 = c.createLinearGradient(-40, -20, 40, 270);
    g2.addColorStop(0, part.top);
    g2.addColorStop(1, part.bot);
    c.fillStyle = g2;
    part.p(c);
    c.fill();
    // A hairline light edge, which is what separates one dark plate from the
    // next once they are stacked.
    c.strokeStyle = 'rgba(196,184,232,0.30)';
    c.lineWidth = 1.2;
    part.p(c);
    c.stroke();
  }

  // ---- chest sigil: a violet diamond, the Monarch's mark ------------------
  c.save();
  c.shadowColor = violetHot;
  c.shadowBlur = 12;
  c.fillStyle = alpha(violetHot, 0.9);
  c.beginPath();
  c.moveTo(0, 58); c.lineTo(10, 72); c.lineTo(0, 86); c.lineTo(-10, 72);
  c.closePath();
  c.fill();
  c.restore();

  // ---- the eyes: the single most recognisable Solo Leveling cue -----------
  c.save();
  c.fillStyle = '#f0e6ff';
  c.shadowColor = violetHot;
  c.shadowBlur = 14;
  c.beginPath(); c.moveTo(-12, 12); c.lineTo(-3, 10); c.lineTo(-3, 14); c.lineTo(-12, 16); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(12, 12); c.lineTo(3, 10); c.lineTo(3, 14); c.lineTo(12, 16); c.closePath(); c.fill();
  c.restore();

  // ---- ground pool --------------------------------------------------------
  c.save();
  const gp = c.createRadialGradient(0, 262, 0, 0, 262, 76);
  gp.addColorStop(0, alpha(violet, 0.42));
  gp.addColorStop(1, alpha(violet, 0));
  c.fillStyle = gp;
  c.beginPath(); c.ellipse(0, 262, 76, 15, 0, 0, Math.PI * 2); c.fill();
  c.restore();

  c.restore();
}

/** Corner filigree for the panel frame, baked once and mirrored by CSS. */
function bakePanelCorner(size, rng, noise) {
  const { cv, c } = offscreen(size, size);
  c.clearRect(0, 0, size, size);
  // an L of brass along the two edges
  c.fillStyle = alpha(BRASS.dark, 0.95);
  c.fillRect(0, 0, size, 3);
  c.fillRect(0, 0, 3, size);
  const g = c.createLinearGradient(0, 0, size * 0.5, size * 0.5);
  g.addColorStop(0, BRASS.hot);
  g.addColorStop(0.5, BRASS.mid);
  g.addColorStop(1, alpha(BRASS.dark, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, size, 2);
  c.fillRect(0, 0, 2, size);
  scroll(c, size * 0.30, size * 0.30, size * 0.24, Math.PI * 0.25, 1.5, { weight: 0.15 });
  scroll(c, size * 0.62, size * 0.16, size * 0.13, Math.PI * 0.1, 1.2, { weight: 0.18 });
  scroll(c, size * 0.16, size * 0.62, size * 0.13, Math.PI * 0.6, 1.2, { weight: 0.18, flip: true });
  rivet(c, size * 0.12, size * 0.12, size * 0.045);
  tarnish(c, 0, 0, size, size, rng, noise, 0.9);
  return toUrl(cv);
}

// ---------------------------------------------------------------------------
// item cell
// ---------------------------------------------------------------------------

class Cell {
  constructor(parent, size, onHover) {
    this.root = el('div', 'mn-cell', parent);
    this.cv = mkCanvas(size, size, '', this.root);
    this.c = this.cv.getContext('2d');
    this.q = el('div', 'q', this.root);
    this.item = null;
    this._baked = 0;
    this.root.addEventListener('pointerenter', () => onHover(this));
    this.root.addEventListener('pointerleave', () => onHover(null));
  }

  set(item, px) {
    const changed = item !== this.item || px !== this._baked;
    this.item = item;
    this._baked = px;
    if (!changed) return;
    this.cv.width = px; this.cv.height = px;
    this.c.clearRect(0, 0, px, px);
    if (!item) {
      setClass(this.root, 'f', false);
      setStyle(this.root, 'color', '');
      setText(this.q, '');
      return;
    }
    const col = RARITY[item.rarity]?.srgb ?? RARITY.common.srgb;
    drawItemIcon(this.c, px, item.glyph, col);
    setClass(this.root, 'f', item.rarity !== 'common');
    setStyle(this.root, 'color', col);
    setText(this.q, item.stack > 1 ? String(item.stack) : '');
  }
}

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

export class Panels {
  constructor(parent, rng) {
    this.rng = rng;
    this.root = el('div', 'mn-panel', parent);
    el('div', 'scrim', this.root);
    this.win = el('div', 'win', this.root);
    for (const k of ['tl', 'tr', 'bl', 'br']) el('div', `cnr ${k}`, this.win);
    this.title = el('div', 'ptitle', this.win);

    // --- tabs ---------------------------------------------------------------
    const tabs = el('div', 'tabs', this.win);
    this.tabs = {};
    for (const [k, label] of [['inventory', 'Inventory'], ['character', 'Character'], ['skills', 'Skills']]) {
      const t = el('div', 'tab', tabs);
      setText(t, label);
      t.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.open(k); });
      this.tabs[k] = t;
    }

    // --- inventory page -----------------------------------------------------
    this.pgInv = el('div', 'pg inv', this.win);
    const inv = el('div', 'mn-inv', this.pgInv);
    inv.style.display = 'flex';

    this.doll = el('div', 'mn-doll', inv);
    this.dollCv = mkCanvas(220, 320, 'fig', this.doll);
    this.dollC = this.dollCv.getContext('2d');
    this.eqCells = {};
    for (const s of DOLL_SLOTS) {
      const holder = el('div', 'mn-eq', this.doll);
      holder.style.left = `calc(${(s.x * 100).toFixed(1)}% - 23 * var(--u))`;
      holder.style.top = `calc(${(s.y * 100).toFixed(1)}% )`;
      const cell = new Cell(holder, 44, (c) => this._hover(c));
      cell.slotKey = s.key;
      this.eqCells[s.key] = cell;
    }

    const right = el('div', '', inv);
    right.style.flex = '1';
    right.style.display = 'flex';
    right.style.flexDirection = 'column';
    const hdr = el('div', 'mn-invhdr', right);
    const h1 = el('div', 'lbl', hdr);
    setText(h1, 'Satchel');
    this.elGold = el('div', 'lbl', hdr);
    this.grid = el('div', 'mn-grid', right);
    this.cells = [];
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      this.cells.push(new Cell(this.grid, 44, (c) => this._hover(c)));
    }

    // --- character page -----------------------------------------------------
    this.pgChar = el('div', 'pg char', this.win);
    const ch = el('div', 'mn-char', this.pgChar);
    ch.style.display = 'flex';
    this.portrait = el('div', 'mn-portrait', ch);
    this.portCv = mkCanvas(200, 240, '', this.portrait);
    this.portC = this.portCv.getContext('2d');
    this.elClass = el('div', 'cls', this.portrait);
    this.elCharLevel = el('div', 'lvl', this.portrait);

    this.colA = el('div', 'mn-statcol', ch);
    this.colB = el('div', 'mn-statcol', ch);

    // --- skills page --------------------------------------------------------
    this.pgSkills = el('div', 'pg tree', this.win);
    this.treeCv = mkCanvas(900, 520, '', this.pgSkills);
    this.treeC = this.treeCv.getContext('2d');
    this.elPoints = el('div', 'pts', this.pgSkills);
    this.tree = makeSkillTree();

    // --- tooltip ------------------------------------------------------------
    this.tip = el('div', 'mn-tip', this.root);
    setShown(this.tip, false);
    this.tipName = el('div', 'nm', this.tip);
    this.tipType = el('div', 'ty', this.tip);
    this.tipHeadV = el('div', 'big', this.tip);
    this.tipHeadL = el('div', 'ty', this.tip);
    el('div', 'dv', this.tip);
    this.tipAff = el('div', 'af', this.tip);
    this.tipFlv = el('div', 'flv', this.tip);

    this.page = null;
    this.visible = false;
    this._baked = 0;
    this._treeDirty = true;
    this.items = [];
    this.equipment = {};
    this.gold = 0;
    this.points = 0;
  }

  bake(u, rng, noise) {
    const key = Math.round(u * 100);
    if (key !== this._baked) {
      this._baked = key;
      const url = bakePanelCorner(Math.round(96 * u), rng, noise);
      for (const k of ['tl', 'tr', 'bl', 'br']) {
        const n = this.win.querySelector(`.cnr.${k}`);
        if (n) setStyle(n, 'backgroundImage', url);
      }
      const dw = Math.round(220 * u), dh = Math.round(320 * u);
      this.dollCv.width = dw; this.dollCv.height = dh;
      drawHeroSilhouette(this.dollC, dw, dh);
      const pw = Math.round(200 * u), ph = Math.round(240 * u);
      this.portCv.width = pw; this.portCv.height = ph;
      drawHeroSilhouette(this.portC, pw, ph);
      const tw = Math.round(900 * u), th = Math.round(520 * u);
      this.treeCv.width = tw; this.treeCv.height = th;
      this._treeDirty = true;
    }
    this._u = u;
    this._cellPx = Math.max(20, Math.round(40 * u));
    this._refreshCells();
    if (this._treeDirty) this._drawTree();
  }

  // -------------------------------------------------------------------------
  // data
  // -------------------------------------------------------------------------

  setInventory(items, equipment, gold) {
    this.items = items ?? [];
    this.equipment = equipment ?? {};
    this.gold = gold ?? 0;
    setText(this.elGold, `${groupNum(this.gold)} gold`);
    this._refreshCells();
  }

  setCharacter(ch) {
    this.character = ch;
    setText(this.elClass, ch.className);
    setText(this.elCharLevel, `Level ${ch.level} — ${ch.name}`);

    clearNode(this.colA);
    clearNode(this.colB);
    this._section(this.colA, 'Attributes', ch.core.map((s) => [s.k, String(s.v)]));
    this._section(this.colA, 'Offence', ch.offence.map((s) => [s.k, s.v, s.note]));
    this._section(this.colB, 'Defence', ch.defence.map((s) => [s.k, s.v, s.note]));
    this._section(this.colB, 'Resistances', ch.resist.map((s) => [s.k, `${s.v}%`]));
  }

  setPoints(n) {
    this.points = n;
    setText(this.elPoints, n > 0 ? `${n} skill points unspent` : 'No unspent points');
    this._treeDirty = true;
  }

  _section(col, title, rows) {
    const h = el('div', 'mn-secthd', col);
    setText(h, title);
    for (const [k, v, note] of rows) {
      const r = el('div', 'mn-stat', col);
      const kk = el('span', 'k', r);
      setText(kk, k);
      const vv = el('span', 'v', r);
      setText(vv, v);
      if (note) {
        const n = el('em', '', vv);
        setText(n, ` ${note}`);
      }
    }
  }

  _refreshCells() {
    const px = this._cellPx ?? 40;
    for (let i = 0; i < this.cells.length; i++) this.cells[i].set(this.items[i] ?? null, px);
    for (const s of DOLL_SLOTS) this.eqCells[s.key]?.set(this.equipment[s.key] ?? null, px);
  }

  // -------------------------------------------------------------------------
  // tooltip
  // -------------------------------------------------------------------------

  _hover(cell) {
    if (!cell || !cell.item) { if (!this._pinned) setShown(this.tip, false); return; }
    this.showTip(cell.item, cell.root);
  }

  showTip(item, anchor) {
    const col = RARITY[item.rarity]?.srgb ?? RARITY.common.srgb;
    setStyle(this.tip, 'color', col);
    setText(this.tipName, item.name);
    setText(this.tipType, `${RARITY[item.rarity]?.name ?? ''} ${item.type} — Item Level ${item.ilvl}`);
    setText(this.tipHeadV, item.headline.value);
    setText(this.tipHeadL, item.headline.label);
    clearNode(this.tipAff);
    for (const a of item.affixes) {
      const line = el('div', '', this.tipAff);
      const b = el('b', '', line);
      setText(b, `${a.value} `);
      const t = el('span', '', line);
      setText(t, a.text);
    }
    setText(this.tipFlv, item.flavour ?? '');
    setShown(this.tipFlv, !!item.flavour);
    setShown(this.tip, true);

    if (anchor) {
      const pr = this.root.getBoundingClientRect();
      const ar = anchor.getBoundingClientRect();
      const x = ar.right - pr.left + 10;
      const y = ar.top - pr.top;
      setStyle(this.tip, 'left', `${Math.round(x)}px`);
      setStyle(this.tip, 'top', `${Math.round(Math.max(4, y))}px`);
    }
  }

  /** Pin a tooltip open — used by debugState so the shot always shows one. */
  pinTip(index) {
    const cell = this.cells[index];
    if (!cell?.item) return;
    this._pinned = true;
    this.showTip(cell.item, cell.root);
  }

  unpinTip() { this._pinned = false; setShown(this.tip, false); }

  // -------------------------------------------------------------------------
  // skill tree
  // -------------------------------------------------------------------------

  _drawTree() {
    const c = this.treeC;
    const W = this.treeCv.width, H = this.treeCv.height;
    if (!W || !H) return;
    this._treeDirty = false;
    c.clearRect(0, 0, W, H);

    const px = (n) => n.x * W;
    const py = (n) => n.y * H;
    const nodes = this.tree.nodes;
    const R = Math.min(W, H) * 0.042;

    // --- links --------------------------------------------------------------
    for (const [a, b] of this.tree.links) {
      const A = nodes[a], B = nodes[b];
      const on = A.rank > 0 && B.rank > 0;
      c.strokeStyle = on ? alpha(ELEMENTS.shadow.srgb, 0.75) : 'rgba(90,86,104,0.35)';
      c.lineWidth = on ? 2.4 : 1.6;
      if (on) { c.shadowColor = ELEMENTS.shadow.srgb; c.shadowBlur = 7; }
      c.beginPath();
      c.moveTo(px(A), py(A));
      const mx = (px(A) + px(B)) * 0.5, my = (py(A) + py(B)) * 0.5;
      c.quadraticCurveTo(mx + (px(B) - px(A)) * 0.12, my, px(B), py(B));
      c.stroke();
      c.shadowBlur = 0;
    }

    // --- nodes --------------------------------------------------------------
    for (const n of nodes) {
      const x = px(n), y = py(n);
      const r = n.capstone ? R * 1.35 : R;
      const on = n.rank > 0;
      const full = n.rank >= n.maxRank;

      // hex plate
      c.save();
      c.translate(x, y);
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        c[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      c.closePath();
      const g = c.createLinearGradient(0, -r, 0, r);
      if (on) {
        // Dark fill, bright BORDER. Filling an allocated node with saturated
        // violet turns a 15-node tree into the most colourful thing in the
        // game; the glow on the rim carries the "allocated" read on its own.
        g.addColorStop(0, shade(ELEMENTS.shadow.srgb, 0.44));
        g.addColorStop(1, '#0c0718');
      } else {
        g.addColorStop(0, '#1a1720');
        g.addColorStop(1, '#08070c');
      }
      c.fillStyle = g;
      c.fill();
      c.lineWidth = full ? 3 : 1.6;
      c.strokeStyle = full ? '#c9a8ff' : on ? alpha(ELEMENTS.shadow.srgb, 0.9) : alpha(BRASS.base, 0.7);
      if (on) { c.shadowColor = ELEMENTS.shadow.srgb; c.shadowBlur = full ? 18 : 9; }
      c.stroke();
      c.shadowBlur = 0;
      c.restore();

      // icon
      const s = r * 1.5;
      c.save();
      c.globalAlpha = on ? 1 : 0.42;
      c.translate(x - s * 0.5, y - s * 0.5);
      drawSkillIcon(c, s, n.glyph, n.element);
      c.restore();

      // rank chip
      c.font = `700 ${Math.round(R * 0.46)}px "DejaVu Sans", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = 'rgba(0,0,0,0.85)';
      c.fillRect(x - r * 0.55, y + r * 0.72, r * 1.1, R * 0.62);
      c.fillStyle = full ? '#ffe9a8' : on ? '#e8e2d4' : '#6d6878';
      c.fillText(`${n.rank}/${n.maxRank}`, x, y + r * 0.72 + R * 0.31);

      // name
      c.font = `${Math.round(R * 0.40)}px "DejaVu Sans", sans-serif`;
      c.fillStyle = on ? 'rgba(232,226,212,0.92)' : 'rgba(154,148,134,0.6)';
      c.fillText(n.name.toUpperCase(), x, y - r - R * 0.42);
    }

    // --- branch headers -----------------------------------------------------
    c.textAlign = 'center';
    c.font = `700 ${Math.round(R * 0.68)}px "Bitstream Charter", serif`;
    for (const b of this.tree.branches) {
      c.fillStyle = 'rgba(224,181,69,0.9)';
      c.fillText(b.name.toUpperCase(), b.x * W, H * 0.05);
    }
  }

  // -------------------------------------------------------------------------
  // visibility
  // -------------------------------------------------------------------------

  open(page) {
    this.page = page;
    this.visible = true;
    setClass(this.root, 'on', true);
    for (const k of Object.keys(this.tabs)) setClass(this.tabs[k], 'on', k === page);
    setClass(this.pgInv, 'on', page === 'inventory');
    setClass(this.pgChar, 'on', page === 'character');
    setClass(this.pgSkills, 'on', page === 'skills');
    setText(this.title, page === 'inventory' ? 'Inventory' : page === 'character' ? 'Character' : 'Skills');
    if (page === 'skills' && this._treeDirty) this._drawTree();
  }

  close() {
    this.visible = false;
    this.page = null;
    setClass(this.root, 'on', false);
    this.unpinTip();
  }

  toggle(page) {
    if (this.visible && this.page === page) this.close();
    else this.open(page);
  }

  dispose() { this.root.remove(); }
}
