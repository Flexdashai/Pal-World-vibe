/**
 * The full-screen map (M).
 *
 * A 158 px dial is a steering aid: it tells you which way the corridor bends.
 * It is not a navigation aid — at the default zoom it shows 62 m of a level
 * that is already 137 x 147 m and is being enlarged 2.5-4x in this same pass,
 * so a player who wants to know where the unexplored half of the floor is has
 * no way to find out. This is that way.
 *
 * DESIGN NOTES
 *
 * - IT SHARES THE MINIMAP'S STATE. `attach(minimap)` hands it the same fog
 *   raster, the same room list and the same player position. Two maps that
 *   maintain separate exploration state is two maps that disagree, and the one
 *   the player is not looking at is always the wrong one.
 *
 * - IT USES THE SAME ROTATION AS THE DIAL AND THE SCREEN (`mapproj.js`). A
 *   full map drawn axis-aligned while the minimap is rotated forces the player
 *   to hold two mental models of the same level. Room NAMES are counter-rotated
 *   so they still read horizontally, which is what every isometric game with a
 *   rotated map does.
 *
 * - IT DOES NOT PAUSE OR CAPTURE INPUT. `pointer-events: none`, and the game
 *   keeps running underneath at 55% brightness. Opening the map to check where
 *   you are and being killed by something you could no longer see is a worse
 *   feeling than any amount of map detail is worth.
 *
 * - ROOM NAMES APPEAR WHEN THE ROOM IS ENTERED, not when the level loads.
 *   `MiniMap.markExplored` sets `room.seen`; an unvisited room is drawn as a
 *   faint unlabelled outline so the shape of what is left reads at a glance.
 */

import { UI } from '../core/palette.js';
import { BRASS, TEXT, FONT, alpha } from './theme.js';
import { el, canvas as mkCanvas, setText, setClass } from './dom.js';
import { MAP_ROT, MAP_COS, MAP_SIN, markerRotation } from './mapproj.js';
import { BLIP } from './minimap.js';

/** Zoom steps as a multiplier on "the whole level fits". */
const ZOOMS = [1, 1.9, 3.4];

/** Resolved once — see the note in minimap.js on why nothing calls `alpha()`
 *  inside a draw loop. */
const COL = {
  link: 'rgba(120,140,175,0.26)',
  seenFill: 'rgba(56,68,94,0.26)',
  seenFillCleared: 'rgba(74,96,126,0.34)',
  seenEdge: 'rgba(150,168,200,0.40)',
  seenEdgeCleared: alpha(BRASS.mid, 0.62),
  // Unexplored rooms have to be legible against the game frame showing through
  // the scrim, or the shape of what is LEFT — the whole reason to open a map —
  // disappears into the background. Measured against the scrim's own value
  // rather than guessed: 0.20 was invisible at 960x540.
  hiddenFill: 'rgba(26,31,46,0.52)',
  hiddenEdge: 'rgba(126,138,166,0.36)',
  labelShadow: 'rgba(0,0,0,0.85)',
  labelCleared: alpha(BRASS.hot, 0.95),
  label: alpha(TEXT.primary, 0.86),
  labelKind: alpha(TEXT.dim, 0.62),
  halo: alpha(UI.systemBlue, 0.13),
  marker: '#ffffff',
  markerEdge: 'rgba(0,0,0,0.9)',
  brass: alpha(BRASS.mid, 0.7),
  brassBar: alpha(BRASS.mid, 0.8),
  brassHot: alpha(BRASS.hot, 0.92),
  tick: alpha(TEXT.dim, 0.9),
  tickDim: alpha(TEXT.dim, 0.85),
};

export class WorldMap {
  constructor(parent) {
    this.root = el('div', 'mn-wmap', parent);
    el('div', 'scrim', this.root);
    this.cv = mkCanvas(64, 64, 'plate', this.root);
    this.c = this.cv.getContext('2d');

    const hd = el('div', 'hd', this.root);
    this.elFloor = el('b', '', hd);
    this.elName = el('span', '', hd);
    this.elHint = el('div', 'hint', this.root);
    setText(this.elHint, 'M  CLOSE      SHIFT+M  ZOOM');

    this.src = null;
    this.visible = false;
    this.zoomIndex = 0;
    this.zoom = ZOOMS[0];
    this._u = 1;
    this._W = 64; this._H = 64;
    this._dirty = true;
    this._accum = 0;
    this._lastX = 1e9; this._lastZ = 1e9;
    this._draws = 0;
    this._fontName = '12px sans-serif';
    this._fontKind = '9px sans-serif';
    this._fontMark = '11px sans-serif';
    this._scaleStep = -1;
    this._scaleLabel = '';
    /** Preallocated fallback for a level with no room graph at all. */
    this._noFit = { spanU: 190, spanV: 190, cx: 0, cz: 0 };
    this.setLabel('B1', 'The Sunken Cathedral');
  }

  /** Single source of truth: the dial owns the data, this draws it bigger. */
  attach(minimap) { this.src = minimap; this._dirty = true; }

  setLabel(floor, name) {
    setText(this.elFloor, floor);
    setText(this.elName, `  ${name}`);
  }

  setLinks(links) {
    this.links = Array.isArray(links) ? links : null;
    this._dirty = true;
  }

  // -------------------------------------------------------------------------
  // layout
  // -------------------------------------------------------------------------

  /**
   * The canvas is sized to the VIEWPORT, not to a design constant: this is the
   * one widget whose whole purpose is to use all of the screen.
   */
  bake(u, w, h) {
    this._u = u;
    const W = Math.max(64, Math.round(w));
    const H = Math.max(64, Math.round(h));
    if (W === this._W && H === this._H) return;
    this._W = W; this._H = H;
    this.cv.width = W; this.cv.height = H;
    this._fontName = `${Math.round(12 * u)}px ${FONT.display}`;
    this._fontKind = `${Math.round(9 * u)}px ${FONT.sans}`;
    this._fontMark = `${Math.round(10 * u)}px ${FONT.sans}`;
    this._dirty = true;
  }

  // -------------------------------------------------------------------------
  // visibility
  // -------------------------------------------------------------------------

  open() { if (!this.visible) { this.visible = true; setClass(this.root, 'on', true); this._dirty = true; } }
  close() { if (this.visible) { this.visible = false; setClass(this.root, 'on', false); } }
  toggle() { if (this.visible) this.close(); else this.open(); return this.visible; }

  cycleZoom() {
    this.zoomIndex = (this.zoomIndex + 1) % ZOOMS.length;
    this.zoom = ZOOMS[this.zoomIndex];
    this._dirty = true;
    return this.zoom;
  }

  // -------------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------------

  update(dt) {
    if (!this.visible || !this.src) return;
    this._accum += dt;
    const s = this.src;
    // Same pixel-denominated gate as the dial, at this map's own scale. Looser
    // in time than the dial (5 Hz idle rather than 6) because this canvas is the
    // size of the viewport and a full-screen 2D redraw is not free.
    const ppm = this._ppm();
    const moved = Math.hypot(s.px - this._lastX, s.pz - this._lastZ) * ppm;
    if (!this._dirty && moved < 0.25 && this._accum < 0.20) return;
    this._accum = 0;
    this._lastX = s.px; this._lastZ = s.pz;
    this._dirty = false;
    this._draws++;
    this._draw();
  }

  /**
   * The level's footprint IN MAP SPACE — what the canvas has to fit. Falls back
   * to the fog raster's own square when there is no room graph at all.
   */
  _fit() {
    const s = this.src;
    if (s.screenBounds) return s.screenBounds;
    const f = this._noFit;
    f.spanU = s.extent; f.spanV = s.extent; f.cx = s.originX; f.cz = s.originZ;
    return f;
  }

  /** Pixels per metre for the current fit + zoom step. */
  _ppm() {
    const b = this._fit();
    const u = this._u;
    // Margins: the title plate needs ~50u at the top and the hint line ~38u at
    // the bottom; 150u of vertical margin was leaving 7% of the height unused.
    const availW = this._W - 72 * u;
    const availH = this._H - 118 * u;
    return Math.min(availW / Math.max(1, b.spanU), availH / Math.max(1, b.spanV)) * this.zoom;
  }

  _draw() {
    const s = this.src;
    const c = this.c;
    const W = this._W, H = this._H, u = this._u;
    c.clearRect(0, 0, W, H);
    if (!s) return;

    const b = this._fit();
    const ppm = this._ppm();
    const cx = W * 0.5;
    const cy = H * 0.5 + 6 * u;
    // Fitted: centre the level. Zoomed in: centre the player, because at 1.9x
    // the level no longer fits and "where am I" is the only question left.
    const focusX = this.zoom > 1.05 ? s.px : b.cx;
    const focusZ = this.zoom > 1.05 ? s.pz : b.cz;

    c.save();
    c.translate(cx, cy);
    c.rotate(MAP_ROT);
    c.scale(ppm, ppm);
    c.translate(-focusX, -focusZ);

    // --- explored floor -----------------------------------------------------
    c.save();
    c.imageSmoothingEnabled = true;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.92;
    const h = s.extent * 0.5;
    c.drawImage(s.fogCv, s.originX - h, s.originZ - h, s.extent, s.extent);
    c.restore();

    // --- corridors between rooms -------------------------------------------
    if (this.links && this.links.length) {
      c.lineWidth = Math.max(0.16, 1.4 / ppm);
      c.strokeStyle = COL.link;
      c.beginPath();
      for (const L of this.links) {
        const a = this._roomById(L.a), d = this._roomById(L.b);
        if (!a || !d) continue;
        c.moveTo(a.x, a.z);
        c.lineTo(d.x, d.z);
      }
      c.stroke();
    }

    // --- rooms --------------------------------------------------------------
    c.lineWidth = Math.max(0.08, 1.2 / ppm);
    for (const r of s.rooms) {
      c.save();
      c.translate(r.x, r.z);
      if (r.rot) c.rotate(r.rot);
      if (r.seen) {
        c.fillStyle = r.cleared ? COL.seenFillCleared : COL.seenFill;
        c.fillRect(-r.hw, -r.hh, r.hw * 2, r.hh * 2);
        c.strokeStyle = r.cleared ? COL.seenEdgeCleared : COL.seenEdge;
      } else {
        c.fillStyle = COL.hiddenFill;
        c.fillRect(-r.hw, -r.hh, r.hw * 2, r.hh * 2);
        c.strokeStyle = COL.hiddenEdge;
      }
      c.strokeRect(-r.hw, -r.hh, r.hw * 2, r.hh * 2);
      c.restore();
    }
    c.restore();

    // --- room labels, in SCREEN space so the type stays horizontal ----------
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const r of s.rooms) {
      if (!r.seen || !r.name) continue;
      const dx = (r.x - focusX) * ppm, dz = (r.z - focusZ) * ppm;
      const sx = cx + dx * MAP_COS - dz * MAP_SIN;
      const sy = cy + dx * MAP_SIN + dz * MAP_COS;
      if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
      c.font = this._fontName;
      c.fillStyle = COL.labelShadow;
      c.fillText(r.name, sx + 1, sy - 9 * u + 1);
      c.fillStyle = r.cleared ? COL.labelCleared : COL.label;
      // Lifted off the room's centre so it does not sit under the player marker
      // when the player is standing in the room being named.
      c.fillText(r.name, sx, sy - 9 * u);
      if (r.kind) {
        c.font = this._fontKind;
        c.fillStyle = COL.labelKind;
        c.fillText(r.kind.toUpperCase(), sx, sy + 4 * u);
      }
    }

    // --- blips --------------------------------------------------------------
    for (const bl of s.blips) {
      const dx = (bl.x - focusX) * ppm, dz = (bl.z - focusZ) * ppm;
      const sx = cx + dx * MAP_COS - dz * MAP_SIN;
      const sy = cy + dx * MAP_SIN + dz * MAP_COS;
      if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
      const k = BLIP[bl.type] ?? BLIP.enemy;
      c.fillStyle = k.c;
      c.shadowColor = k.c;
      c.shadowBlur = 6 * u;
      c.beginPath();
      c.arc(sx, sy, k.r * u * 1.15, 0, Math.PI * 2);
      c.fill();
    }
    c.shadowBlur = 0;

    // --- the player ---------------------------------------------------------
    const pdx = (s.px - focusX) * ppm, pdz = (s.pz - focusZ) * ppm;
    const psx = cx + pdx * MAP_COS - pdz * MAP_SIN;
    const psy = cy + pdx * MAP_SIN + pdz * MAP_COS;
    c.save();
    c.translate(psx, psy);
    // A halo, so the marker is findable on a screen-sized map without hunting.
    c.beginPath();
    c.arc(0, 0, 15 * u, 0, Math.PI * 2);
    c.fillStyle = COL.halo;
    c.fill();
    c.rotate(markerRotation(s.pface));
    c.beginPath();
    c.moveTo(0, -10 * u);
    c.lineTo(6.6 * u, 8 * u);
    c.lineTo(0, 4 * u);
    c.lineTo(-6.6 * u, 8 * u);
    c.closePath();
    c.fillStyle = COL.marker;
    c.shadowColor = COL.markerEdge;
    c.shadowBlur = 5 * u;
    c.fill();
    c.strokeStyle = COL.markerEdge;
    c.lineWidth = 1.2 * u;
    c.stroke();
    c.restore();
    c.shadowBlur = 0;

    // --- compass ------------------------------------------------------------
    // Map-up is screen-up by construction, so the rose is a fixed ornament that
    // tells the player the map is oriented rather than north-locked.
    const rx = W - 54 * u, ry = 78 * u;
    c.save();
    c.translate(rx, ry);
    c.strokeStyle = COL.brass;
    c.lineWidth = 1 * u;
    c.beginPath();
    c.arc(0, 0, 20 * u, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(0, -20 * u); c.lineTo(0, 20 * u);
    c.moveTo(-20 * u, 0); c.lineTo(20 * u, 0);
    c.stroke();
    c.beginPath();
    c.moveTo(0, -19 * u); c.lineTo(4.5 * u, -6 * u); c.lineTo(-4.5 * u, -6 * u);
    c.closePath();
    c.fillStyle = COL.brassHot;
    c.fill();
    c.font = this._fontMark;
    c.fillStyle = COL.tick;
    c.fillText('N', 0, -27 * u);
    c.restore();

    // --- scale bar ----------------------------------------------------------
    // 10 m if that is a sane width at this zoom, otherwise the next decade up.
    let step = 10;
    while (step * ppm < 40 * u) step *= 2;
    while (step * ppm > 190 * u) step *= 0.5;
    const bx = 48 * u, by = H - 54 * u, bw = step * ppm;
    c.strokeStyle = COL.brassBar;
    c.lineWidth = 1.2 * u;
    c.beginPath();
    c.moveTo(bx, by - 4 * u); c.lineTo(bx, by); c.lineTo(bx + bw, by); c.lineTo(bx + bw, by - 4 * u);
    c.stroke();
    c.textAlign = 'left';
    c.font = this._fontMark;
    c.fillStyle = COL.tickDim;
    // The label string is cached: it changes only when the zoom step changes.
    if (step !== this._scaleStep) { this._scaleStep = step; this._scaleLabel = `${step} m`; }
    c.fillText(this._scaleLabel, bx + bw + 6 * u, by - 1 * u);
  }

  _roomById(id) {
    const rooms = this.src?.rooms;
    if (!rooms) return null;
    for (const r of rooms) if (r.id === id) return r;
    return null;
  }

  stats() {
    return {
      open: this.visible,
      zoom: this.zoom,
      pxPerMetre: +this._ppm().toFixed(3),
      draws: this._draws,
      size: `${this._W}x${this._H}`,
      named: this.src ? this.src.rooms.filter((r) => r.seen && r.name).length : 0,
    };
  }

  dispose() { this.root.remove(); }
}
