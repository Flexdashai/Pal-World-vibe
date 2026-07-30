/**
 * Minimap.
 *
 * Two things make a minimap useful rather than decorative, and both are here:
 *
 *  1. IT IS ROTATED TO MATCH THE CAMERA. The world camera is locked at 45
 *     degrees of yaw, so an axis-aligned map requires the player to mentally
 *     rotate it every time they read it. Rotating the map by -45 degrees means
 *     "up on the map" is "up on the screen", always.
 *
 *  2. FOG OF WAR IS PAINTED BY THE PLAYER, not queried from the level. `world`
 *     is not required to expose anything: the map maintains its own coarse
 *     occupancy grid and reveals cells as the player walks. If `world:ready`
 *     does supply rooms, they are drawn as outlines on top, and `world:room`
 *     marks them cleared — but the map is complete and correct without either.
 *
 * The revealed grid is kept as a GRID x GRID pixel canvas and blitted with
 * bilinear smoothing, which is both far cheaper than drawing a rect per cell
 * and gives the soft-edged reveal a hand-authored fog mask would.
 */

import { ELEMENTS, UI, RARITY } from '../core/palette.js';
import { M, BRASS, SLATE, alpha, mixHex } from './theme.js';
import { el, canvas as mkCanvas, setText } from './dom.js';
import { bevelRing, rivet, tarnish, scroll, offscreen } from './ornament.js';

const GRID = 128;
/** Metres covered by the whole grid. Bigger than any single dungeon floor so
 *  the player never walks off the edge of their own map. */
const EXTENT = 190;
const CELL = EXTENT / GRID;

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

    // fog-of-war raster
    const f = offscreen(GRID, GRID);
    this.fogCv = f.cv;
    this.fog = f.c;
    this.fog.clearRect(0, 0, GRID, GRID);

    this.rooms = [];
    this.blips = [];
    this.px = 0; this.pz = 0; this.pface = 0;
    this.zoom = 2.55;              // pixels per metre at u = 1
    this._baked = 0;
    this._dirty = true;
    this._lastDrawX = 1e9;
    this._lastDrawZ = 1e9;
    this._accum = 0;
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

  /** Reveal a disc of the grid. Called from the player's position each frame;
   *  cheap because it only touches the cells inside the radius. */
  markExplored(x, z, radius = 9) {
    const gx = Math.round((x + EXTENT * 0.5) / CELL);
    const gz = Math.round((z + EXTENT * 0.5) / CELL);
    const r = Math.ceil(radius / CELL);
    if (gx < -r || gz < -r || gx > GRID + r || gz > GRID + r) return;
    const c = this.fog;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        const ax = gx + dx, az = gz + dz;
        if (ax < 0 || az < 0 || ax >= GRID || az >= GRID) continue;
        // Falloff so the reveal edge is soft rather than a hard disc. The fog
        // raster is drawn in COLD STONE, not white, because it is composited
        // with `lighter` over the void — a white raster would produce a grey
        // map and lose the "damp cold masonry" read the rest of the game has.
        const t = 1 - Math.sqrt(dx * dx + dz * dz) / (r + 0.001);
        c.fillStyle = `rgba(118,142,176,${(0.10 + t * 0.24).toFixed(3)})`;
        c.fillRect(ax, az, 1, 1);
      }
    }
    this._dirty = true;
  }

  /** Accept whatever shape `world:ready` supplies. Rooms are optional. */
  setRooms(rooms) {
    this.rooms.length = 0;
    if (!Array.isArray(rooms)) return;
    for (const r of rooms) {
      const box = normaliseRoom(r);
      if (box) this.rooms.push(box);
    }
    this._dirty = true;
  }

  markRoomCleared(room) {
    const box = normaliseRoom(room);
    if (!box) return;
    for (const r of this.rooms) {
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

  /** Wipe the fog and the layout — used when a new level loads. */
  reset() {
    this.fog.clearRect(0, 0, GRID, GRID);
    this.rooms.length = 0;
    this.blips.length = 0;
    this._dirty = true;
  }

  /** Paint a whole layout at once (the synthetic map used by debugState). */
  paintCells(fn) {
    this.fog.clearRect(0, 0, GRID, GRID);
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        const v = fn(x * CELL - EXTENT * 0.5, z * CELL - EXTENT * 0.5);
        if (v > 0) {
          this.fog.fillStyle = `rgba(118,142,176,${Math.min(1, v).toFixed(3)})`;
          this.fog.fillRect(x, z, 1, 1);
        }
      }
    }
    this._dirty = true;
  }

  update(dt, u) {
    this._accum += dt;
    // Redraw when the player has moved meaningfully or 6 Hz, whichever first.
    const moved = Math.abs(this.px - this._lastDrawX) + Math.abs(this.pz - this._lastDrawZ);
    if (!this._dirty && moved < 0.25 && this._accum < 0.16) return;
    this._accum = 0;
    this._lastDrawX = this.px;
    this._lastDrawZ = this.pz;
    this._dirty = false;
    this._draw(u);
  }

  _draw(u) {
    const c = this.cMap;
    const S = this.S;
    if (!S) return;
    const cx = S * 0.5, cy = S * 0.5;
    const R = this.R;
    const ppm = this.zoom * u;

    c.clearRect(0, 0, S, S);
    c.save();                                          // A: the circular clip
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();

    // base: unexplored void
    c.fillStyle = '#05050a';
    c.fillRect(0, 0, S, S);

    c.save();                                          // B: world space
    c.translate(cx, cy);
    // -45 degrees aligns map-up with screen-up under the fixed camera yaw.
    c.rotate(-Math.PI * 0.25);
    c.scale(ppm, ppm);
    c.translate(-this.px, -this.pz);

    // --- revealed floor -----------------------------------------------------
    c.save();
    c.imageSmoothingEnabled = true;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.95;
    // The fog raster covers [-EXTENT/2, +EXTENT/2] in both axes.
    c.drawImage(this.fogCv, -EXTENT * 0.5, -EXTENT * 0.5, EXTENT, EXTENT);
    c.restore();

    // --- rooms --------------------------------------------------------------
    c.lineWidth = 0.42;
    for (const r of this.rooms) {
      if (Math.abs(r.x - this.px) > 60 || Math.abs(r.z - this.pz) > 60) continue;
      c.fillStyle = r.cleared ? 'rgba(70,92,120,0.30)' : 'rgba(52,62,86,0.22)';
      c.fillRect(r.x - r.hw, r.z - r.hh, r.hw * 2, r.hh * 2);
      c.strokeStyle = r.cleared ? alpha(BRASS.mid, 0.55) : 'rgba(140,158,190,0.32)';
      c.strokeRect(r.x - r.hw, r.z - r.hh, r.hw * 2, r.hh * 2);
    }
    c.restore();                                       // B: back to screen space

    // --- blips (screen space, so the dots stay round and crisp) --------------
    const cos = Math.cos(-Math.PI * 0.25), sin = Math.sin(-Math.PI * 0.25);
    for (const b of this.blips) {
      const dx = (b.x - this.px) * ppm, dz = (b.z - this.pz) * ppm;
      const sx = cx + dx * cos - dz * sin;
      const sy = cy + dx * sin + dz * cos;
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
    c.rotate(this.pface - Math.PI * 0.25);
    c.beginPath();
    c.moveTo(0, -6.4 * u);
    c.lineTo(4.4 * u, 5.2 * u);
    c.lineTo(0, 2.6 * u);
    c.lineTo(-4.4 * u, 5.2 * u);
    c.closePath();
    c.fillStyle = '#ffffff';
    c.shadowColor = 'rgba(0,0,0,0.9)';
    c.shadowBlur = 4 * u;
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.lineWidth = 1 * u;
    c.stroke();
    c.restore();

    // --- edge falloff -------------------------------------------------------
    const g = c.createRadialGradient(cx, cy, R * 0.62, cx, cy, R);
    g.addColorStop(0, 'rgba(5,5,10,0)');
    g.addColorStop(1, 'rgba(5,5,10,0.92)');
    c.fillStyle = g;
    c.fillRect(cx - R, cy - R, R * 2, R * 2);

    c.restore();                                       // A
  }

  dispose() { this.root.remove(); }
}

/** Duck-type whatever `world` puts in `world:ready`. Returns {x,z,hw,hh}. */
function normaliseRoom(r) {
  if (!r) return null;
  if (typeof r.x === 'number' && typeof r.z === 'number') {
    if (typeof r.w === 'number' && typeof r.h === 'number') {
      return { x: r.x, z: r.z, hw: Math.abs(r.w) * 0.5, hh: Math.abs(r.h) * 0.5, cleared: !!r.cleared };
    }
    if (typeof r.hw === 'number') return { x: r.x, z: r.z, hw: r.hw, hh: r.hh ?? r.hw, cleared: !!r.cleared };
  }
  if (r.min && r.max) {
    return {
      x: (r.min.x + r.max.x) * 0.5, z: (r.min.z + r.max.z) * 0.5,
      hw: Math.abs(r.max.x - r.min.x) * 0.5, hh: Math.abs(r.max.z - r.min.z) * 0.5,
      cleared: !!r.cleared,
    };
  }
  if (r.center && r.size) {
    return {
      x: r.center.x, z: r.center.z,
      hw: Math.abs(r.size.x) * 0.5, hh: Math.abs(r.size.z) * 0.5, cleared: !!r.cleared,
    };
  }
  if (r.position && typeof r.radius === 'number') {
    return { x: r.position.x, z: r.position.z, hw: r.radius, hh: r.radius, cleared: !!r.cleared };
  }
  return null;
}

export { GRID as MAP_GRID, EXTENT as MAP_EXTENT, CELL as MAP_CELL };
