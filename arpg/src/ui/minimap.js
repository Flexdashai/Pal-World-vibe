/**
 * Minimap.
 *
 * Four things make a minimap useful rather than decorative, and all four were
 * measured rather than assumed:
 *
 *  1. IT IS ROTATED TO MATCH THE CAMERA. See `mapproj.js` — the rotation was a
 *     quarter turn wrong and every direction on the dial disagreed with the
 *     screen by ~88.6 degrees. The basis now lives in exactly one place.
 *
 *  2. IT REDRAWS WHEN THE PLAYER MOVES A PIXEL, not when they move a quarter of
 *     a metre. The old gate was `moved < 0.25 m || accum < 0.16 s`, which
 *     measured out at a 15 Hz redraw against a 60 Hz world: the dial stepped
 *     rather than slid, and the terrain under the fixed centre arrow was up to
 *     0.23 m (5.2 frames) stale. The gate is now expressed in DRAWN PIXELS, so
 *     it is correct at every zoom and every UI scale, and it costs nothing when
 *     the player is standing still.
 *
 *  3. FOG OF WAR IS PAINTED BY THE PLAYER, and it is SIZED FROM THE LEVEL. The
 *     raster used to be a fixed 190 m square at the world origin, which fits
 *     this level with 0 m to spare on a 137x147 m footprint — and another agent
 *     is enlarging the world 2.5-4x in this same pass. `setRooms` now takes the
 *     room graph from `world:ready`, bounds it, and rebuilds the raster around
 *     that bound at a roughly constant metres-per-cell. `world` is still not
 *     required to supply anything: with no rooms the map keeps its default
 *     extent and is complete and correct.
 *
 *  4. THE ZOOM IS EXPRESSED IN METRES ACROSS THE DIAL, not in pixels per metre,
 *     so it survives a resolution change, and the widest step is fitted to the
 *     level so a player can always see the whole floor. `M` opens the
 *     full-screen map; `Shift+M` cycles the dial's zoom.
 *
 * The revealed grid is kept as a GRID x GRID pixel canvas and blitted with
 * bilinear smoothing, which is both far cheaper than drawing a rect per cell
 * and gives the soft-edged reveal a hand-authored fog mask would.
 */

import { ELEMENTS, UI, RARITY } from '../core/palette.js';
import { M, BRASS, alpha } from './theme.js';
import { el, canvas as mkCanvas, setText } from './dom.js';
import { bevelRing, rivet, tarnish, scroll, offscreen } from './ornament.js';
import { MAP_COS, MAP_SIN, MAP_ROT, markerRotation, normaliseRoom, roomsBounds, roomsScreenBounds } from './mapproj.js';

/** Fallback raster footprint before any level publishes its bounds. */
const DEFAULT_EXTENT = 190;
/** Metres per fog cell we aim for. The raster resolution follows the level so a
 *  3x bigger dungeon does not get 3x coarser fog. */
const TARGET_CELL = 1.3;
const MIN_GRID = 96;
/** 320^2 = 102k cells. A reveal touches only the disc, and the blit is a
 *  downscale into a ~120 px circle, so this is bounded work either way. */
const MAX_GRID = 320;

/** Zoom steps, in METRES VISIBLE ACROSS THE DIAL. The last is fitted to the
 *  level at `setRooms` time. 62 m is the default: about a room and its
 *  neighbours, which is what a player steers by. */
const VIEWS = [36, 62, 120];

/**
 * Every colour the live draw uses, resolved ONCE.
 *
 * `alpha()` parses a hex string and builds an `rgba(...)` literal, and the dial
 * now redraws 60 times a second instead of 15 — a per-room `alpha(BRASS.mid,
 * 0.55)` inside the draw loop is a string allocation per room per frame, which
 * the contract forbids and a GC pause during a fight is exactly the kind of
 * thing that reads as input lag.
 */
const COL = {
  void: '#05050a',
  roomFill: 'rgba(52,62,86,0.22)',
  roomFillCleared: 'rgba(70,92,120,0.30)',
  roomEdge: 'rgba(140,158,190,0.32)',
  roomEdgeCleared: alpha(BRASS.mid, 0.55),
  arrow: '#ffffff',
  arrowEdge: 'rgba(0,0,0,0.85)',
  arrowShadow: 'rgba(0,0,0,0.9)',
};

/** Reveal alphas, quantised to 24 steps and pre-stringified for the same
 *  reason: `markExplored` writes a couple of hundred cells per call. */
const FOG_STEPS = 24;
const FOG_COL = Array.from({ length: FOG_STEPS + 1 }, (_, i) =>
  `rgba(118,142,176,${(0.10 + (i / FOG_STEPS) * 0.24).toFixed(3)})`);

export const BLIP = {
  enemy: { c: '#ff4a33', r: 2.1 },
  elite: { c: UI.critYellow, r: 2.7 },
  boss: { c: '#ff2a18', r: 3.6 },
  shadow: { c: '#c9a8ff', r: 2.2 },
  loot: { c: RARITY.rare.srgb, r: 2.0 },
  legendary: { c: RARITY.legendary.srgb, r: 2.6 },
  shrine: { c: ELEMENTS.shadow.srgb, r: 3.0 },
  exit: { c: UI.systemBlue, r: 3.0 },
};

export class MiniMap {
  constructor(parent, rng) {
    this.root = el('div', 'mn-map', parent);
    this.cvMap = mkCanvas(M.minimap, M.minimap, '', this.root);
    this.cvRing = mkCanvas(M.minimap, M.minimap, '', this.root);
    this.cMap = this.cvMap.getContext('2d');
    this.cRing = this.cvRing.getContext('2d');

    const cmp = el('div', 'cmp', this.root);
    for (const [cls, ch] of [['n', 'N'], ['s', 'S'], ['w', 'W'], ['e', 'E']]) {
      setText(el('span', cls, cmp), ch);
    }
    this.cap = el('div', 'cap', this.root);
    this.elFloor = el('b', '', this.cap);
    this.elName = el('span', '', this.cap);

    // ---- fog-of-war raster --------------------------------------------------
    // Geometry is mutable: `setRooms` re-sizes and re-centres it on the level.
    this.grid = Math.round(DEFAULT_EXTENT / TARGET_CELL);
    this.extent = DEFAULT_EXTENT;
    this.cell = this.extent / this.grid;
    this.originX = 0;
    this.originZ = 0;
    const f = offscreen(this.grid, this.grid);
    this.fogCv = f.cv;
    this.fog = f.c;
    this.fog.clearRect(0, 0, this.grid, this.grid);

    this.rooms = [];
    this.blips = [];
    this.bounds = null;
    this.screenBounds = null;
    this.px = 0; this.pz = 0; this.pface = 0;
    this.views = VIEWS.slice();
    this.viewIndex = 1;
    this.viewM = this.views[this.viewIndex];
    /** Pixels per metre at u = 1. Derived from `viewM` every draw; kept as a
     *  field because the probe harness and the full map both read it. */
    this.zoom = 2.55;
    this._baked = 0;
    this._dirty = true;
    this._lastDrawX = 1e9;
    this._lastDrawZ = 1e9;
    this._accum = 0;
    this._draws = 0;
    this._d = [0, 0];               // preallocated projection scratch
    this.rng = rng;
    setText(this.elFloor, 'B3');
    setText(this.elName, '  The Sunken Nave');
  }

  bake(u, rng, noise) {
    const px = Math.max(64, Math.round(M.minimap * u));
    if (px === this._baked) return;
    this._baked = px;
    for (const cv of [this.cvMap, this.cvRing]) {
      cv.width = px; cv.height = px;
      cv.style.width = '100%'; cv.style.height = '100%';
    }
    this.S = px;
    this.R = px * 0.5 - 10 * u;

    // --- the brass surround, baked once ------------------------------------
    const c = this.cRing;
    const cx = px * 0.5, cy = px * 0.5;
    c.clearRect(0, 0, px, px);
    // four scrolls at the diagonals, behind the ring
    for (const a of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
      scroll(c, cx + Math.cos(a) * (px * 0.47), cy + Math.sin(a) * (px * 0.47),
        px * 0.10, a + Math.PI * 0.5, 1.2, { flip: Math.sin(a) < 0, weight: 0.16 });
    }
    bevelRing(c, cx, cy, px * 0.5 - 1, this.R, { segs: 120 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI * 0.125;
      rivet(c, cx + Math.cos(a) * (this.R + 5 * u), cy + Math.sin(a) * (this.R + 5 * u), 2.6 * u);
    }
    tarnish(c, 0, 0, px, px, rng, noise, 0.9);

    // The edge falloff for the live map, built once here rather than on every
    // redraw: it depends only on the baked size.
    this.gEdge = this.cMap.createRadialGradient(cx, cy, this.R * 0.62, cx, cy, this.R);
    this.gEdge.addColorStop(0, 'rgba(5,5,10,0)');
    this.gEdge.addColorStop(1, 'rgba(5,5,10,0.92)');

    // inner shadow so the map appears recessed under glass
    c.save();
    c.beginPath(); c.arc(cx, cy, this.R + 1, 0, Math.PI * 2); c.clip();
    const g = c.createRadialGradient(cx, cy, this.R * 0.6, cx, cy, this.R + 1);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.85)');
    c.fillStyle = g;
    c.fillRect(cx - this.R, cy - this.R, this.R * 2, this.R * 2);
    // a glass catch in the upper left
    const s = c.createRadialGradient(cx - this.R * 0.4, cy - this.R * 0.45, 0, cx - this.R * 0.4, cy - this.R * 0.45, this.R * 0.85);
    s.addColorStop(0, 'rgba(255,255,255,0.09)');
    s.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = s;
    c.fillRect(cx - this.R, cy - this.R, this.R * 2, this.R * 2);
    c.restore();

    this._dirty = true;
  }

  // =========================================================================
  // fog raster geometry
  // =========================================================================

  /**
   * Re-shape the raster around `bounds`, keeping metres-per-cell near
   * TARGET_CELL. Returns true when the geometry actually changed (the caller
   * must then repaint, because the old reveal does not survive a re-projection
   * and pretending it does is worse than an honest wipe).
   */
  _sizeRaster(bounds) {
    const span = Math.max(bounds.spanX, bounds.spanZ);
    // 12% of headroom so a player who steps outside the room AABBs — a corridor
    // stub, a knockback, a dash through a doorway — still paints fog.
    const extent = Math.max(60, span * 1.12);
    const grid = Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(extent / TARGET_CELL)));
    const same = grid === this.grid
      && Math.abs(extent - this.extent) < 0.5
      && Math.abs(bounds.cx - this.originX) < 0.05
      && Math.abs(bounds.cz - this.originZ) < 0.05;
    if (same) return false;

    this.extent = extent;
    this.originX = bounds.cx;
    this.originZ = bounds.cz;
    this.cell = extent / grid;
    if (grid !== this.grid) {
      this.grid = grid;
      this.fogCv.width = grid;
      this.fogCv.height = grid;
    }
    this.fog.clearRect(0, 0, this.grid, this.grid);
    this._dirty = true;
    return true;
  }

  /** World AABB the raster can record, for introspection and the full map. */
  fogBounds() {
    const h = this.extent * 0.5;
    return {
      minX: this.originX - h, maxX: this.originX + h,
      minZ: this.originZ - h, maxZ: this.originZ + h,
      extent: this.extent, grid: this.grid, cell: this.cell,
    };
  }

  /** Reveal a disc of the grid. Called from the player's position each frame;
   *  cheap because it only touches the cells inside the radius. */
  markExplored(x, z, radius = 9) {
    const G = this.grid, CELL = this.cell;
    const gx = Math.round((x - this.originX + this.extent * 0.5) / CELL);
    const gz = Math.round((z - this.originZ + this.extent * 0.5) / CELL);
    const r = Math.ceil(radius / CELL);
    if (gx < -r || gz < -r || gx > G + r || gz > G + r) return;
    const c = this.fog;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        const ax = gx + dx, az = gz + dz;
        if (ax < 0 || az < 0 || ax >= G || az >= G) continue;
        // Falloff so the reveal edge is soft rather than a hard disc. The fog
        // raster is drawn in COLD STONE, not white, because it is composited
        // with `lighter` over the void — a white raster would produce a grey
        // map and lose the "damp cold masonry" read the rest of the game has.
        const t = 1 - Math.sqrt(dx * dx + dz * dz) / (r + 0.001);
        c.fillStyle = FOG_COL[(t * FOG_STEPS) | 0];
        c.fillRect(ax, az, 1, 1);
      }
    }
    this._markSeen(x, z);
    this._dirty = true;
  }

  /**
   * Flag the room the player is standing in as visited, which is what lets the
   * full-screen map name it. Point-in-ROTATED-rect, because five of this
   * level's rooms are at 45 degrees and an axis-aligned test names the wrong
   * one when two of them are adjacent.
   */
  _markSeen(x, z) {
    for (const r of this.rooms) {
      if (r.seen) continue;
      let dx = x - r.x, dz = z - r.z;
      if (r.rot) {
        const cs = Math.cos(-r.rot), sn = Math.sin(-r.rot);
        const rx = dx * cs - dz * sn;
        dz = dx * sn + dz * cs;
        dx = rx;
      }
      if (Math.abs(dx) <= r.hw + 1.5 && Math.abs(dz) <= r.hh + 1.5) { r.seen = true; this._dirty = true; }
    }
  }

  /** Alpha 0..1 already revealed at a world point. Introspection only — this
   *  allocates an ImageData and must never be called from a frame. */
  exploredAt(x, z) {
    const gx = Math.round((x - this.originX + this.extent * 0.5) / this.cell);
    const gz = Math.round((z - this.originZ + this.extent * 0.5) / this.cell);
    if (gx < 0 || gz < 0 || gx >= this.grid || gz >= this.grid) return -1;
    return this.fog.getImageData(gx, gz, 1, 1).data[3] / 255;
  }

  // =========================================================================
  // level data
  // =========================================================================

  /**
   * Accept whatever shape `world:ready` supplies. Rooms are optional — but when
   * they are present they define how big the map has to be, which is the only
   * way this widget survives the level growing under it.
   */
  setRooms(rooms) {
    this.rooms.length = 0;
    if (Array.isArray(rooms)) {
      for (const r of rooms) {
        const box = normaliseRoom(r);
        if (box) this.rooms.push(box);
      }
    }
    this.bounds = roomsBounds(this.rooms, 6);
    // The map-space footprint too: it is what the full-screen map fits to.
    this.screenBounds = roomsScreenBounds(this.rooms, 6);
    if (this.bounds) {
      this._sizeRaster(this.bounds);
      // Widest zoom step fits the whole floor on the dial, whatever size it is.
      this.views[2] = Math.max(this.views[1] + 20, Math.min(320, Math.max(this.bounds.spanX, this.bounds.spanZ) * 1.08));
      this.viewM = this.views[this.viewIndex];
    }
    this._dirty = true;
  }

  markRoomCleared(room) {
    const box = normaliseRoom(room);
    if (!box) return;
    for (const r of this.rooms) {
      if (box.id !== undefined && r.id === box.id) { r.cleared = true; this._dirty = true; return; }
      if (Math.abs(r.x - box.x) < 0.6 && Math.abs(r.z - box.z) < 0.6) { r.cleared = true; this._dirty = true; return; }
    }
    box.cleared = true;
    this.rooms.push(box);
    this._dirty = true;
  }

  /** `list` is reused by the caller; the map copies what it needs. */
  setBlips(list) {
    this.blips.length = 0;
    for (const b of list) this.blips.push(b);
    this._dirty = true;
  }

  setPlayer(x, z, facing) {
    this.px = x; this.pz = z; this.pface = facing;
  }

  setLabel(floor, name) {
    setText(this.elFloor, floor);
    setText(this.elName, `  ${name}`);
  }

  // =========================================================================
  // zoom
  // =========================================================================

  /** Metres visible across the dial. */
  setView(metres) {
    this.viewM = Math.max(12, metres);
    this._dirty = true;
  }

  cycleZoom() {
    this.viewIndex = (this.viewIndex + 1) % this.views.length;
    this.setView(this.views[this.viewIndex]);
    return Math.round(this.viewM);
  }

  /** Wipe the fog and the layout — used when a new level loads. */
  reset() {
    this.fog.clearRect(0, 0, this.grid, this.grid);
    this.rooms.length = 0;
    this.blips.length = 0;
    this._lastDrawX = 1e9;
    this._lastDrawZ = 1e9;
    this._dirty = true;
  }

  /** Paint a whole layout at once (the synthetic map used by debugState). */
  paintCells(fn) {
    const G = this.grid, CELL = this.cell;
    const x0 = this.originX - this.extent * 0.5, z0 = this.originZ - this.extent * 0.5;
    this.fog.clearRect(0, 0, G, G);
    for (let z = 0; z < G; z++) {
      for (let x = 0; x < G; x++) {
        const v = fn(x0 + x * CELL, z0 + z * CELL);
        if (v > 0) {
          this.fog.fillStyle = `rgba(118,142,176,${Math.min(1, v).toFixed(3)})`;
          this.fog.fillRect(x, z, 1, 1);
        }
      }
    }
    this._dirty = true;
  }

  // =========================================================================
  // frame
  // =========================================================================

  update(dt, u) {
    this._accum += dt;
    // THE REDRAW GATE, IN DRAWN PIXELS.
    //
    // The old gate was 0.25 m of Manhattan movement or 6 Hz. Measured at a 2.66
    // m/s walk that produced a 15 Hz redraw and left the terrain under the fixed
    // centre arrow up to 0.229 m (5.2 frames) behind the hero. Expressed in
    // metres the threshold is also wrong at every zoom but one.
    //
    // The threshold is 0.05 px, which in practice means "redraw on every frame
    // the hero is moving at all and on none of the frames they are not". A
    // redraw was measured at 0.045 ms — 0.27% of a 16.7 ms frame — so there is
    // nothing to buy by being clever, and a gate loose enough to be worth the
    // saving is loose enough to see.
    const ppm = this.R ? (this.R * 2) / this.viewM : this.zoom * u;
    const movedPx = Math.hypot(this.px - this._lastDrawX, this.pz - this._lastDrawZ) * ppm;
    if (!this._dirty && movedPx < 0.05 && this._accum < 0.16) return;
    this._accum = 0;
    this._lastDrawX = this.px;
    this._lastDrawZ = this.pz;
    this._dirty = false;
    this._draws++;
    this._draw(u);
  }

  _draw(u) {
    const c = this.cMap;
    const S = this.S;
    if (!S) return;
    const cx = S * 0.5, cy = S * 0.5;
    const R = this.R;
    // Pixels per metre from the zoom expressed in metres-across, so the dial
    // shows the same slice of world at every resolution and every UI scale.
    const ppm = (R * 2) / this.viewM;
    this.zoom = ppm / Math.max(1e-3, u);

    c.clearRect(0, 0, S, S);
    c.save();                                          // A: the circular clip
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();

    // base: unexplored void
    c.fillStyle = COL.void;
    c.fillRect(0, 0, S, S);

    c.save();                                          // B: world space
    c.translate(cx, cy);
    // +45 degrees: see mapproj.js. This was -45 and the whole dial was a
    // quarter turn out of register with the screen.
    c.rotate(MAP_ROT);
    c.scale(ppm, ppm);
    c.translate(-this.px, -this.pz);

    // --- revealed floor -----------------------------------------------------
    c.save();
    c.imageSmoothingEnabled = true;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.95;
    const h = this.extent * 0.5;
    c.drawImage(this.fogCv, this.originX - h, this.originZ - h, this.extent, this.extent);
    c.restore();

    // --- rooms --------------------------------------------------------------
    // Cull against what the dial can actually show, not a constant: at the
    // fitted zoom the visible radius is the whole level.
    const viewR = this.viewM * 0.78;
    c.lineWidth = Math.max(0.06, 0.9 / ppm);
    for (const r of this.rooms) {
      if (Math.abs(r.x - this.px) > viewR + r.hw || Math.abs(r.z - this.pz) > viewR + r.hh) continue;
      c.save();
      c.translate(r.x, r.z);
      if (r.rot) c.rotate(r.rot);
      c.fillStyle = r.cleared ? COL.roomFillCleared : COL.roomFill;
      c.fillRect(-r.hw, -r.hh, r.hw * 2, r.hh * 2);
      c.strokeStyle = r.cleared ? COL.roomEdgeCleared : COL.roomEdge;
      c.strokeRect(-r.hw, -r.hh, r.hw * 2, r.hh * 2);
      c.restore();
    }
    c.restore();                                       // B: back to screen space

    // --- blips (screen space, so the dots stay round and crisp) --------------
    for (const b of this.blips) {
      const dx = (b.x - this.px) * ppm, dz = (b.z - this.pz) * ppm;
      const sx = cx + dx * MAP_COS - dz * MAP_SIN;
      const sy = cy + dx * MAP_SIN + dz * MAP_COS;
      if ((sx - cx) ** 2 + (sy - cy) ** 2 > (R - 3) ** 2) continue;
      const k = BLIP[b.type] ?? BLIP.enemy;
      c.fillStyle = k.c;
      c.shadowColor = k.c;
      c.shadowBlur = 5 * u;
      c.beginPath();
      c.arc(sx, sy, k.r * u, 0, Math.PI * 2);
      c.fill();
    }
    c.shadowBlur = 0;

    // --- the player: an arrow, always pointing where they face --------------
    c.save();
    c.translate(cx, cy);
    c.rotate(markerRotation(this.pface));
    c.beginPath();
    c.moveTo(0, -6.4 * u);
    c.lineTo(4.4 * u, 5.2 * u);
    c.lineTo(0, 2.6 * u);
    c.lineTo(-4.4 * u, 5.2 * u);
    c.closePath();
    c.fillStyle = COL.arrow;
    c.shadowColor = COL.arrowShadow;
    c.shadowBlur = 4 * u;
    c.fill();
    c.strokeStyle = COL.arrowEdge;
    c.lineWidth = 1 * u;
    c.stroke();
    c.restore();

    // --- edge falloff -------------------------------------------------------
    c.fillStyle = this.gEdge;
    c.fillRect(cx - R, cy - R, R * 2, R * 2);

    c.restore();                                       // A
  }

  stats() {
    return {
      viewMetres: +this.viewM.toFixed(1),
      pxPerMetre: +this.zoom.toFixed(3),
      draws: this._draws,
      fog: this.fogBounds(),
      rooms: this.rooms.length,
    };
  }

  dispose() { this.root.remove(); }
}

export { normaliseRoom };
