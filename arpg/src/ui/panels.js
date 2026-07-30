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

import { RARITY, ELEMENTS, UI } from '../core/palette.js';
import { M, BRASS, TEXT, alpha, mixHex, shade } from './theme.js';
import { el, canvas as mkCanvas, setText, setClass, setShown, setStyle, clearNode, groupNum } from './dom.js';
import { drawItemIcon, drawSkillIcon } from './icons.js';
import { offscreen, toUrl, scroll, engravedPlate, roundRect, rivet, tarnish, bevelRing } from './ornament.js';
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
  const S = Math.min(w / 220, h / 300);
  const violet = ELEMENTS.shadow.srgb;

  // backlight
  const g = c.createRadialGradient(cx, h * 0.46, 0, cx, h * 0.46, h * 0.52);
  g.addColorStop(0, alpha(violet, 0.34));
  g.addColorStop(0.55, alpha(violet, 0.10));
  g.addColorStop(1, alpha(violet, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);

  c.save();
  c.translate(cx, h * 0.06);
  c.scale(S, S);

  const body = (cc) => {
    cc.beginPath();
    // cape
    cc.moveTo(-52, 44); cc.bezierCurveTo(-96, 130, -78, 250, -44, 268);
    cc.lineTo(44, 268); cc.bezierCurveTo(78, 250, 96, 130, 52, 44);
    cc.closePath();
    // helm
    cc.moveTo(-20, 6);
    cc.bezierCurveTo(-24, -26, 24, -26, 20, 6);
    cc.lineTo(16, 34); cc.lineTo(-16, 34); cc.closePath();
    // pauldrons
    cc.moveTo(-62, 46); cc.bezierCurveTo(-70, 16, -30, 8, -26, 40); cc.closePath();
    cc.moveTo(62, 46); cc.bezierCurveTo(70, 16, 30, 8, 26, 40); cc.closePath();
    // torso
    cc.moveTo(-34, 40); cc.lineTo(34, 40); cc.lineTo(28, 132);
    cc.lineTo(0, 148); cc.lineTo(-28, 132); cc.closePath();
    // arms
    cc.moveTo(-52, 48); cc.lineTo(-36, 48); cc.lineTo(-30, 132); cc.lineTo(-46, 134); cc.closePath();
    cc.moveTo(52, 48); cc.lineTo(36, 48); cc.lineTo(30, 132); cc.lineTo(46, 134); cc.closePath();
    // legs
    cc.moveTo(-26, 140); cc.lineTo(-4, 140); cc.lineTo(-6, 250); cc.lineTo(-28, 250); cc.closePath();
    cc.moveTo(26, 140); cc.lineTo(4, 140); cc.lineTo(6, 250); cc.lineTo(28, 250); cc.closePath();
    // blade held low on the right
    cc.moveTo(56, 60); cc.lineTo(64, 60); cc.lineTo(68, 250); cc.lineTo(58, 250); cc.closePath();
  };

  // rim first, offset outward, then the black body over it
  c.save();
  c.translate(0, -2);
  c.scale(1.05, 1.03);
  c.fillStyle = alpha(violet, 0.85);
  c.shadowColor = violet;
  c.shadowBlur = 22;
  body(c);
  c.fill();
  c.restore();

  const bg = c.createLinearGradient(0, 0, 0, 280);
  bg.addColorStop(0, '#14111c');
  bg.addColorStop(0.6, '#0a0810');
  bg.addColorStop(1, '#050408');
  c.fillStyle = bg;
  body(c);
  c.fill();

  // eyes: two violet slits, the single most recognisable cue
  c.fillStyle = '#e7d6ff';
  c.shadowColor = violet;
  c.shadowBlur = 12;
  c.fillRect(-13, 12, 9, 3.4);
  c.fillRect(4, 12, 9, 3.4);
  c.shadowBlur = 0;
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
    setText(this.elPoints, n > 0 ? `${n} points unspent` : 'No points unspent');
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
      c.strokeStyle = on ? alpha(ELEMENTS.shadow.srgb, 0.85) : 'rgba(90,86,104,0.35)';
      c.lineWidth = on ? 3.2 : 1.6;
      if (on) { c.shadowColor = ELEMENTS.shadow.srgb; c.shadowBlur = 10; }
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
        g.addColorStop(0, shade(ELEMENTS.shadow.srgb, 0.9));
        g.addColorStop(1, '#100a20');
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
