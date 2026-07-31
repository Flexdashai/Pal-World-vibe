import * as THREE from 'three';

/**
 * MONARCH — the item construction kit.
 *
 * Everything a dropped item is made of is built here, from four primitives:
 * a swept cross-section, a box, a disc and a torus. That is genuinely enough —
 * a sword is a swept lens plus two boxes plus a torus; a helm is a swept
 * ellipse with a cut face; a bow is a swept rectangle bent along an arc.
 *
 * ---------------------------------------------------------------------------
 * WHY NON-INDEXED WITH FLAT NORMALS
 *
 * These objects are 30-60 px on screen. What survives at that size is the
 * SILHOUETTE and the specular break across a bevel — a smooth-shaded lathe
 * reads as a soft blob, while a faceted one catches the brazier on one facet
 * and goes black on the next, which is what makes metal read as metal. So every
 * triangle gets its own three vertices and its own geometric normal. The cost
 * is 3x the vertices of an indexed mesh, and an entire item is ~400 triangles,
 * so the cost is nothing.
 *
 * ---------------------------------------------------------------------------
 * THE THREE VERTEX ATTRIBUTES
 *
 *   position   metres, authored with +Y along the item's length and the origin
 *              at its balance point, so a drop can be tilted about its centre
 *   color      albedo tint, LINEAR. Multiplied into the material's diffuse.
 *   aSurf      (roughness, metalness, emissiveMask)
 *
 * `aSurf` is what lets one material draw steel, leather, gold, bone and a
 * glowing rune in a single draw call. See `materials.js` for the shader patch
 * that consumes it — three's `<roughnessmap_fragment>` / `<metalnessmap_fragment>`
 * chunks declare the factors as locals, so overriding them per fragment is a
 * two-line injection rather than a custom material.
 */

/* ==========================================================================
 * SURFACES
 * ========================================================================== */

/**
 * The material vocabulary items are built from. Albedo values are LINEAR and
 * physically plausible (ARCHITECTURE.md: albedo in 0.02-0.9, metals are 0 or 1).
 *
 * Roughness is the parameter doing the most work: plate at 0.30, leather at
 * 0.72 and cloth at 0.88 is what makes a hilt read as three materials rather
 * than as one shape. A single roughness across a whole object reads as plastic,
 * which is the note ARCHITECTURE.md makes about characters and is just as true
 * of a 40 px sword.
 */
export const SURF = {
  steel: { col: [0.52, 0.54, 0.58], rough: 0.30, metal: 1, emit: 0 },
  steelDark: { col: [0.30, 0.31, 0.34], rough: 0.44, metal: 1, emit: 0 },
  iron: { col: [0.34, 0.34, 0.35], rough: 0.55, metal: 1, emit: 0 },
  ironDull: { col: [0.22, 0.22, 0.23], rough: 0.71, metal: 1, emit: 0 },
  rust: { col: [0.24, 0.13, 0.075], rough: 0.86, metal: 1, emit: 0 },
  blackSteel: { col: [0.10, 0.10, 0.12], rough: 0.38, metal: 1, emit: 0 },
  gold: { col: [0.72, 0.53, 0.20], rough: 0.28, metal: 1, emit: 0 },
  brass: { col: [0.48, 0.38, 0.18], rough: 0.42, metal: 1, emit: 0 },
  silver: { col: [0.66, 0.68, 0.71], rough: 0.22, metal: 1, emit: 0 },
  leather: { col: [0.075, 0.052, 0.036], rough: 0.72, metal: 0, emit: 0 },
  leatherPale: { col: [0.14, 0.10, 0.072], rough: 0.68, metal: 0, emit: 0 },
  cloth: { col: [0.075, 0.055, 0.048], rough: 0.88, metal: 0, emit: 0 },
  clothDark: { col: [0.038, 0.030, 0.034], rough: 0.90, metal: 0, emit: 0 },
  wood: { col: [0.062, 0.043, 0.028], rough: 0.76, metal: 0, emit: 0 },
  woodPale: { col: [0.13, 0.095, 0.060], rough: 0.70, metal: 0, emit: 0 },
  bone: { col: [0.40, 0.375, 0.31], rough: 0.62, metal: 0, emit: 0 },
  stone: { col: [0.085, 0.085, 0.092], rough: 0.82, metal: 0, emit: 0 },
  /** The rarity accent. `emit` is a MASK, not a colour — the colour comes from
   *  the material, which is per rarity, so one geometry serves all five. */
  rune: { col: [0.20, 0.17, 0.26], rough: 0.42, metal: 0, emit: 1.0 },
  runeSoft: { col: [0.16, 0.14, 0.20], rough: 0.50, metal: 0, emit: 0.55 },
  gem: { col: [0.28, 0.20, 0.46], rough: 0.10, metal: 0, emit: 0.85 },
  gemDeep: { col: [0.14, 0.10, 0.30], rough: 0.08, metal: 0, emit: 0.42 },
};

/** A surface with its albedo pushed toward another colour — used to tint a
 *  base's metal per rarity without needing a second surface table. */
export function tinted(surf, rgb, t, roughDelta = 0) {
  return {
    col: [
      surf.col[0] + (rgb[0] - surf.col[0]) * t,
      surf.col[1] + (rgb[1] - surf.col[1]) * t,
      surf.col[2] + (rgb[2] - surf.col[2]) * t,
    ],
    rough: Math.max(0.045, Math.min(1, surf.rough + roughDelta)),
    metal: surf.metal,
    emit: surf.emit,
  };
}

/* ==========================================================================
 * CROSS-SECTIONS
 * ========================================================================== */

/** Unit cross-sections in (u, v). `u` is the section's width axis (X), `v` its
 *  depth axis (Z). Wound counter-clockwise seen from +Y. */
function ngon(n, phase = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}

export const SECTION = {
  /** A blade: sharp at ±u, thin in v. The 0.42 shoulder is the bevel — without
   *  it the blade is a flat lozenge and takes no specular break. */
  blade: [
    [1, 0], [0.42, 0.60], [0, 0.80], [-0.42, 0.60],
    [-1, 0], [-0.42, -0.60], [0, -0.80], [0.42, -0.60],
  ],
  /** A single-edged blade: flat spine at −u, edge at +u. */
  edged: [
    [1, 0], [0.30, 0.52], [-0.55, 0.66], [-1, 0.52],
    [-1, -0.52], [-0.55, -0.66], [0.30, -0.52],
  ],
  square: [[1, 1], [-1, 1], [-1, -1], [1, -1]],
  hex: ngon(6, Math.PI / 6),
  oct: ngon(8, Math.PI / 8),
  round: ngon(12),
  round16: ngon(16),
  /** A flattened oval — grips, straps, bow limbs. */
  strap: [
    [1, 0.34], [0.5, 0.5], [-0.5, 0.5], [-1, 0.34],
    [-1, -0.34], [-0.5, -0.5], [0.5, -0.5], [1, -0.34],
  ],
  /** A teardrop — helm crowns, shield bosses. */
  tear: [
    [0.95, 0.20], [0.62, 0.72], [0, 1.0], [-0.62, 0.72],
    [-0.95, 0.20], [-0.70, -0.55], [0, -1.0], [0.70, -0.55],
  ],
};

/* ==========================================================================
 * THE BUILDER
 * ========================================================================== */

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

export class Builder {
  constructor() {
    this.pos = [];
    this.col = [];
    this.surf = [];
    this.tris = 0;
    /** Transform stack. Every vertex is transformed on push, so a part can be
     *  authored at the origin and placed afterwards. */
    this._stack = [new THREE.Matrix4()];
    this._top = this._stack[0];
  }

  /* ---- transform ---------------------------------------------------------- */

  push() {
    const m = new THREE.Matrix4().copy(this._top);
    this._stack.push(m);
    this._top = m;
    return this;
  }

  pop() {
    if (this._stack.length > 1) this._stack.pop();
    this._top = this._stack[this._stack.length - 1];
    return this;
  }

  translate(x, y, z) { this._top.multiply(_m.makeTranslation(x, y, z)); return this; }
  rotateX(a) { this._top.multiply(_m.makeRotationX(a)); return this; }
  rotateY(a) { this._top.multiply(_m.makeRotationY(a)); return this; }
  rotateZ(a) { this._top.multiply(_m.makeRotationZ(a)); return this; }
  scale(x, y, z) { this._top.multiply(_m.makeScale(x, y ?? x, z ?? x)); return this; }

  /* ---- raw ---------------------------------------------------------------- */

  vert(x, y, z, s) {
    _v.set(x, y, z).applyMatrix4(this._top);
    this.pos.push(_v.x, _v.y, _v.z);
    this.col.push(s.col[0], s.col[1], s.col[2]);
    this.surf.push(s.rough, s.metal, s.emit);
    return this;
  }

  tri(a, b, c, s) {
    this.vert(a[0], a[1], a[2], s);
    this.vert(b[0], b[1], b[2], s);
    this.vert(c[0], c[1], c[2], s);
    this.tris++;
    return this;
  }

  /** A quad, wound a→b→c→d. Split along the a-c diagonal. */
  quad(a, b, c, d, s) {
    this.tri(a, b, c, s);
    this.tri(a, c, d, s);
    return this;
  }

  /* ---- primitives --------------------------------------------------------- */

  /**
   * Sweep a cross-section along +Y through a list of rings.
   *
   * `rings` is `[{ y, sx, sz, ox, oz, rot }]`, applied in that order: the
   * section is scaled by (sx, sz), rotated by `rot` about Y, offset by
   * (ox, oz), and placed at height `y`. Consecutive rings are bridged with
   * quads; the ends are capped with a fan unless the ring's scale is zero (a
   * point, which needs no cap).
   *
   * This one function builds blades, grips, staff shafts, torsos, boots, bow
   * limbs and gem settings. Its generality is why the kit is short.
   */
  sweep(section, rings, s, opts = {}) {
    const n = section.length;
    const capBottom = opts.capBottom !== false;
    const capTop = opts.capTop !== false;
    const surfaces = opts.surfaces ?? null;   // optional per-ring surface

    const at = (ri, i) => {
      const r = rings[ri];
      const p = section[i];
      const c = Math.cos(r.rot ?? 0), sn = Math.sin(r.rot ?? 0);
      const u = p[0] * (r.sx ?? 1), v = p[1] * (r.sz ?? r.sx ?? 1);
      return [
        (r.ox ?? 0) + u * c - v * sn,
        r.y,
        (r.oz ?? 0) + u * sn + v * c,
      ];
    };

    for (let ri = 0; ri < rings.length - 1; ri++) {
      const sr = surfaces?.[ri] ?? s;
      const degenA = (rings[ri].sx ?? 1) === 0;
      const degenB = (rings[ri + 1].sx ?? 1) === 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = at(ri, i), b = at(ri, j);
        const c = at(ri + 1, j), d = at(ri + 1, i);
        if (degenA) this.tri(a, c, d, sr);
        else if (degenB) this.tri(a, b, c, sr);
        else this.quad(a, b, c, d, sr);
      }
    }

    if (capBottom && (rings[0].sx ?? 1) !== 0) {
      const c0 = [rings[0].ox ?? 0, rings[0].y, rings[0].oz ?? 0];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.tri(c0, at(0, j), at(0, i), s);
      }
    }
    const last = rings.length - 1;
    if (capTop && (rings[last].sx ?? 1) !== 0) {
      const c1 = [rings[last].ox ?? 0, rings[last].y, rings[last].oz ?? 0];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.tri(c1, at(last, i), at(last, j), s);
      }
    }
    return this;
  }

  /** An axis-aligned box, optionally tapered toward +Y and twisted. */
  box(cx, cy, cz, hx, hy, hz, s, taper = 1, twist = 0) {
    this.push().translate(cx, cy, cz);
    this.sweep(SECTION.square, [
      { y: -hy, sx: hx, sz: hz },
      { y: hy, sx: hx * taper, sz: hz * taper, rot: twist },
    ], s);
    this.pop();
    return this;
  }

  /** A flat disc in the XZ plane, facing +Y (or −Y when `up` is false). */
  disc(cx, cy, cz, r, seg, s, up = true) {
    const c = [cx, cy, cz];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r];
      const p1 = [cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r];
      if (up) this.tri(c, p0, p1, s);
      else this.tri(c, p1, p0, s);
    }
    return this;
  }

  /**
   * A torus in the XZ plane. `seg` around the ring, `sides` around the tube.
   * Rings, pommels, guard collars and the amulet's loop are all this.
   */
  torus(cx, cy, cz, R, r, seg, sides, s, squash = 1) {
    const P = (i, j) => {
      const a = (i / seg) * Math.PI * 2;
      const b = (j / sides) * Math.PI * 2;
      const rr = R + Math.cos(b) * r;
      return [cx + Math.cos(a) * rr, cy + Math.sin(b) * r * squash, cz + Math.sin(a) * rr];
    };
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < sides; j++) {
        this.quad(P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j), s);
      }
    }
    return this;
  }

  /**
   * A ribbon swept along a 2D path in the XY plane, with a thickness in Z.
   * Bow staves, shield rims and belt straps.
   */
  ribbon(path, width, thick, s, closed = false) {
    const n = path.length;
    const count = closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const p = path[i], q = path[(i + 1) % n];
      const w0 = (typeof width === 'function' ? width(i / (n - 1)) : width);
      const w1 = (typeof width === 'function' ? width((i + 1) / (n - 1)) : width);
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l, ny = dx / l;
      const a = [p[0] + nx * w0, p[1] + ny * w0, -thick];
      const b = [p[0] - nx * w0, p[1] - ny * w0, -thick];
      const c = [q[0] - nx * w1, q[1] - ny * w1, -thick];
      const d = [q[0] + nx * w1, q[1] + ny * w1, -thick];
      const a2 = [a[0], a[1], thick], b2 = [b[0], b[1], thick];
      const c2 = [c[0], c[1], thick], d2 = [d[0], d[1], thick];
      this.quad(a, b, c, d, s);          // back
      this.quad(d2, c2, b2, a2, s);      // front
      this.quad(a2, a, d, d2, s);        // outer edge
      this.quad(b2, c2, c, b, s);        // inner edge
    }
    return this;
  }

  /* ---- output ------------------------------------------------------------- */

  /**
   * Bake to a BufferGeometry with FLAT normals computed per triangle.
   *
   * Also centres the geometry on its bounding-box centre in X and Z but NOT in
   * Y: items are authored with +Y along their length and the drop code tilts
   * them about the origin, so moving the origin off the length axis would make
   * the tilt swing the item instead of rotating it.
   */
  finish(name) {
    const count = this.pos.length / 3;
    const position = new Float32Array(this.pos);
    const color = new Float32Array(this.col);
    const surf = new Float32Array(this.surf);
    const normal = new Float32Array(count * 3);

    for (let t = 0; t < count; t += 3) {
      const i = t * 3;
      const ax = position[i], ay = position[i + 1], az = position[i + 2];
      const bx = position[i + 3], by = position[i + 4], bz = position[i + 5];
      const cx = position[i + 6], cy = position[i + 7], cz = position[i + 8];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (let k = 0; k < 3; k++) {
        normal[i + k * 3] = nx;
        normal[i + k * 3 + 1] = ny;
        normal[i + k * 3 + 2] = nz;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    g.name = name ?? 'mn.loot.item';
    g.userData.triangles = this.tris;
    return g;
  }
}

/* ==========================================================================
 * SHAPING HELPERS
 * ========================================================================== */

/**
 * Ring list for a tapered blade.
 *
 * `profile(t)` returns the half-width at 0..1 along the blade. Authored as a
 * function rather than a table because every blade in the kit wants a different
 * curve and a table per blade is a table nobody tunes.
 */
export function bladeRings(y0, y1, steps, profile, thickAt) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ y: y0 + (y1 - y0) * t, sx: profile(t), sz: thickAt(t) });
  }
  return out;
}

/** Deterministic hash → 0..1, for per-item shape variation without an Rng. */
export function hash01(seed, salt = 0) {
  let h = (seed ^ (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
