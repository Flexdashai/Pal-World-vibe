import * as THREE from 'three';

/**
 * MONARCH — `world` geometry toolkit.
 *
 * Low-level, allocation-heavy, BUILD-TIME ONLY. Nothing in this file may be
 * called from `update()`; every function here runs once, inside `init()`, and
 * the result is merged into a handful of static buffers.
 *
 * ---------------------------------------------------------------------------
 * THE TWO CONVENTIONS EVERYTHING ELSE DEPENDS ON
 *
 * 1. **UVs are in METRES.** `materials` is calibrated on it: `tile` then means
 *    metres-per-repeat, parallax depth is physically correct, and two adjacent
 *    objects cannot land at different texel densities — which is the single most
 *    visible tiling artefact there is.
 *
 * 2. **UVs are projected from WORLD SPACE, not authored per piece.** A wall
 *    built from 30 blocks whose UVs each start at 0 shows the same 2.4 m of
 *    masonry thirty times in a row; projecting from world space makes the
 *    texture continuous across every piece, so the repeat is only ever visible
 *    at the texture's own 2.4 m period, which the surface's 7 m macro variation
 *    then breaks up. See `projectUvs`.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERYTHING IS NON-INDEXED
 *
 * The world-space UV projection is per TRIANGLE (a vertex on the corner of a
 * block belongs to three faces with three different projections), and merging
 * requires a consistent index state across the whole batch. Converting
 * everything to non-indexed once, up front, makes both trivially correct. It
 * costs ~1.5x the vertex memory on static geometry that is uploaded once and
 * never touched again, which is the cheapest currency available.
 */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// ===========================================================================
// core buffer utilities
// ===========================================================================

/** `toNonIndexed()` on geometry that is already non-indexed logs a warning and
 *  returns a copy; three's polyhedra (Icosahedron, Tetrahedron) arrive that way,
 *  so every call site has to check first or the console fills with noise. */
export function toFlat(geo) {
  return geo.index ? geo.toNonIndexed() : geo;
}

/** Non-indexed clone with exactly {position, normal, uv}. Everything the
 *  builder merges passes through here first. */
export function normalise(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g === geo) g = geo.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  // Drop anything else — mismatched attribute sets are the classic merge bug,
  // and they fail silently by producing garbage rather than by throwing.
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  }
  return g;
}

/**
 * World-space UV projection, per triangle, in metres.
 *
 *   near-horizontal face -> uv = (x, z)          floors, ceilings, table tops
 *   otherwise            -> uv = (p . tangent, y) tangent = up x faceNormal
 *
 * The second case is the important one: `p · tangent` is arc length ALONG the
 * wall, so a run of blocks, a buttress and the reveal of a doorway all sample
 * one continuous strip of masonry. On a faceted column each facet gets its own
 * tangent and therefore its own strip, with the discontinuity landing exactly on
 * the arris — where a real mason's joint would be anyway.
 */
export function projectUvs(geo, offsetU = 0, offsetV = 0) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const n = pos.count;
  for (let i = 0; i < n; i += 3) {
    _v0.fromBufferAttribute(pos, i);
    _v1.fromBufferAttribute(pos, i + 1);
    _v2.fromBufferAttribute(pos, i + 2);
    _n.copy(_v1).sub(_v0).cross(_t.copy(_v2).sub(_v0));
    const len = _n.length();
    if (len < 1e-9) { _n.set(0, 1, 0); } else { _n.multiplyScalar(1 / len); }

    if (Math.abs(_n.y) > 0.82) {
      // Horizontal-ish: plan projection. Flip u on downward faces so a soffit
      // is not mirrored relative to the floor beneath it.
      const s = _n.y >= 0 ? 1 : -1;
      uv.setXY(i, _v0.x * s + offsetU, _v0.z + offsetV);
      uv.setXY(i + 1, _v1.x * s + offsetU, _v1.z + offsetV);
      uv.setXY(i + 2, _v2.x * s + offsetU, _v2.z + offsetV);
    } else {
      _t.crossVectors(_up, _n).normalize();
      uv.setXY(i, _v0.dot(_t) + offsetU, _v0.y + offsetV);
      uv.setXY(i + 1, _v1.dot(_t) + offsetU, _v1.y + offsetV);
      uv.setXY(i + 2, _v2.dot(_t) + offsetU, _v2.y + offsetV);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/** Bake a matrix into positions and normals in place. */
export function applyMatrix(geo, m) {
  geo.applyMatrix4(m);
  return geo;
}

/**
 * Merge a list of non-indexed {position, normal, uv} geometries into one.
 *
 * Hand-rolled rather than pulled from `three/examples`: the batch is guaranteed
 * homogeneous by `normalise()`, so this is a straight typed-array concatenation
 * with none of the general case's checks, and it keeps the subsystem's import
 * surface to `three` alone.
 */
export function mergeAll(geos, disposeSources = true) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  if (total === 0) return null;

  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  let o = 0;
  for (const g of geos) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    nrm.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    o += c;
    if (disposeSources) g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * Accumulates geometry into named buckets and merges each bucket once.
 *
 * One bucket becomes one draw call. The bucket key is `${material}|${group}`,
 * where `group` separates geometry that must be a SEPARATE MESH even though it
 * shares a material — specifically the camera-side walls, which have to be their
 * own mesh so `render.registerOccluderFade` can test a bounding sphere that
 * actually bounds the wall rather than the whole room.
 */
export class GeoBucket {
  constructor() {
    /** key -> { mat, group, geos[] } */
    this.buckets = new Map();
    this._m = new THREE.Matrix4();
    this.pieces = 0;
  }

  /**
   * @param {string} mat    material name for `materials.get()`
   * @param {string} group  mesh group ('far' | 'near' | 'vault' | ...)
   * @param {THREE.BufferGeometry} geo  consumed: cloned then disposed by us
   * @param {THREE.Matrix4|null} matrix world transform
   * @param {'world'|'keep'} uvMode
   */
  /**
   * `uvMode`:
   *   'world' — reproject in world space (see `projectUvs`). Correct for
   *             everything built out of flat masonry.
   *   'keep'  — the geometry authored its own metre UVs (a vault web, a floor
   *             grid, a banner). The matrix's world translation is ADDED to
   *             them, because a piece that keeps local UVs would otherwise show
   *             the identical patch of texture in every bay of an arcade — which
   *             is the exact repetition the whole subsystem is trying to avoid.
   */
  add(mat, group, geo, matrix = null, uvMode = 'world') {
    if (!geo) return this;
    const g = normalise(geo);
    if (matrix) g.applyMatrix4(matrix);
    if (uvMode === 'world') projectUvs(g);
    else if (matrix) {
      const du = matrix.elements[12], dv = matrix.elements[14];
      if (du !== 0 || dv !== 0) {
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
        uv.needsUpdate = true;
      }
    }
    const key = `${mat}|${group}`;
    let b = this.buckets.get(key);
    if (!b) { b = { mat, group, geos: [] }; this.buckets.set(key, b); }
    b.geos.push(g);
    this.pieces++;
    return this;
  }

  /** Convenience: transform from position + euler + scale without the caller
   *  keeping a Matrix4 around. */
  addAt(mat, group, geo, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, uvMode = 'world') {
    this._m.makeRotationY(ry);
    this._m.scale(_v0.set(sx, sy, sz));
    this._m.setPosition(x, y, z);
    return this.add(mat, group, geo, this._m, uvMode);
  }

  /** @returns {Array<{mat, group, geo}>} one merged geometry per bucket. */
  build() {
    const out = [];
    for (const b of this.buckets.values()) {
      const geo = mergeAll(b.geos, true);
      if (geo) out.push({ mat: b.mat, group: b.group, geo });
      b.geos.length = 0;
    }
    this.buckets.clear();
    return out;
  }

  triangles() {
    let n = 0;
    for (const b of this.buckets.values()) for (const g of b.geos) n += g.attributes.position.count / 3;
    return n;
  }
}

// ===========================================================================
// primitives
// ===========================================================================

/**
 * A stone block with broken arrises.
 *
 * A perfect box is the most obvious tell in procedural architecture, and
 * chamfering every edge properly would triple the triangle count. This instead
 * pulls each of the eight corners in by a per-corner random amount, which reads
 * as "quarried, dropped, and set by hand" from any distance the camera ever
 * sees a block at, and costs nothing.
 *
 * The displacement is keyed off the vertex's corner SIGNS rather than its index,
 * so the three duplicated copies of a corner in a non-indexed box all move
 * together and the box stays watertight.
 */
export function blockGeo(w, h, d, rng, chip = 0.05) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (chip > 0 && rng) {
    const pos = g.attributes.position;
    // Eight corner offsets, drawn once for this block.
    const off = new Float32Array(24);
    for (let c = 0; c < 8; c++) {
      off[c * 3 + 0] = rng.range(-chip, chip * 0.35);
      off[c * 3 + 1] = rng.range(-chip, chip * 0.35);
      off[c * 3 + 2] = rng.range(-chip, chip * 0.35);
    }
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const c = (x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0);
      pos.setXYZ(
        i,
        x + off[c * 3 + 0] * Math.sign(x || 1),
        y + off[c * 3 + 1] * Math.sign(y || 1),
        z + off[c * 3 + 2] * Math.sign(z || 1)
      );
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/**
 * Faceted polygonal prism — the shaft of every column, pier and pilaster.
 *
 * Flat-shaded on purpose. A smooth cylinder lit by a brazier gives one soft
 * gradient; ten facets give ten discrete values, which is what makes a column
 * read as carved stone and what gives the rim light something to catch. `twist`
 * is a slow rotation up the shaft — barley-sugar piers exist and even a couple
 * of degrees stops a colonnade looking extruded.
 */
export function prismGeo(rBottom, rTop, height, sides, twist = 0, capTop = true, capBottom = true) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, height, sides, 1, !capTop && !capBottom);
  if (twist !== 0) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const a = ((y + height * 0.5) / height) * twist;
      const c = Math.cos(a), s = Math.sin(a);
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setXYZ(i, x * c - z * s, y, x * s + z * c);
    }
    pos.needsUpdate = true;
  }
  // Flat shading: three's cylinder shares vertices around the ring, so the
  // facets only exist once the geometry is exploded per triangle.
  const flat = toFlat(g);
  if (flat !== g) g.dispose();
  flat.computeVertexNormals();
  return flat;
}

/**
 * Two-centred (pointed) gothic arch as a polyline of the INTRADOS, from the left
 * springer, over the apex, to the right springer.
 *
 * A two-centred arch is two circular arcs whose centres sit on the springing
 * line, offset from the middle. `riseRatio` is apex height over half-span:
 * 1.0 is equilateral, 1.35 is a steep lancet, below 0.75 it stops being gothic.
 */
export function pointedArchPath(span, riseRatio, segments) {
  const half = span * 0.5;
  const rise = half * riseRatio;
  // Radius of each arc, from the constraint that it passes through the springer
  // (±half, 0) and the apex (0, rise), with its centre at (∓c, 0):
  //   R = half + c  and  R² = c² + rise²  =>  c = (rise² − half²) / (2·half)
  const c = (rise * rise - half * half) / (2 * half);
  const R = half + c;
  const pts = [];
  // Sweep the LEFT arc (centre at +c) from its springer up to the apex, then the
  // right arc back down. Doing it as two mirrored halves guarantees a symmetric
  // apex, which a single parametric sweep does not at low segment counts, and it
  // is the only ordering that produces a continuous polyline: sweeping both arcs
  // in the same direction gives apex → left springer → right springer → apex,
  // which is two disjoint pieces with a jump across the opening between them.
  const n = Math.max(1, Math.floor(segments / 2));
  const a0 = 0;                       // springer, on the springing line
  const a1 = Math.atan2(rise, c);     // apex
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    pts.push(new THREE.Vector2(-(Math.cos(a) * R - c), Math.sin(a) * R));
  }
  for (let i = n - 1; i >= 0; i--) {
    const a = a0 + (a1 - a0) * (i / n);
    pts.push(new THREE.Vector2(Math.cos(a) * R - c, Math.sin(a) * R));
  }
  return pts;
}

/**
 * An arch RING: the voussoirs of a pointed arch, as individual blocks with a
 * mortar gap between them, extruded `depth` along Z.
 *
 * Built as blocks rather than as a swept solid because the joints between
 * voussoirs are the whole read of an arch — a smooth extrusion is a rainbow, and
 * the difference is obvious even at the hero boom.
 */
export function archRingGeo(span, riseRatio, ring, depth, rng, segments = 9) {
  const path = pointedArchPath(span, riseRatio, segments);
  const geos = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const ang = Math.atan2(dy, dx);
    // Mortar joint: 1.5–2.5 cm, varied per voussoir.
    const gap = rng ? rng.range(0.012, 0.028) : 0.018;
    const jitter = rng ? rng.range(-0.012, 0.012) : 0;
    const blk = blockGeo(len - gap, ring + jitter, depth, rng, 0.022);
    e.set(0, 0, ang);
    q.setFromEuler(e);
    m.compose(
      _v0.set((a.x + b.x) * 0.5 - Math.sin(ang) * (ring * 0.5), (a.y + b.y) * 0.5 + Math.cos(ang) * (ring * 0.5), 0),
      q,
      _v1.set(1, 1, 1)
    );
    blk.applyMatrix4(m);
    geos.push(normalise(blk));
  }
  const out = mergeAll(geos, true);
  return out;
}

/**
 * A wall panel with a pointed-arch opening cut through it, built as five solid
 * pieces (two jambs, two spandrels, one head) plus the arch ring in the reveal.
 *
 * CSG is not available and is not wanted: assembling the opening from real
 * masonry means the reveal has thickness, the arch has voussoirs, and the
 * spandrel above it is a separate stone — all of which the camera can see at
 * this pitch, and all of which are missing from a quad with a hole in it.
 */
export function archedWallGeo(width, height, thick, span, riseRatio, sillY, rng) {
  const geos = [];
  const m = new THREE.Matrix4();
  const half = span * 0.5;
  const apex = sillY + half * riseRatio;
  const jambW = (width - span) * 0.5;

  const push = (g, x, y, z = 0) => {
    m.makeTranslation(x, y, z);
    g.applyMatrix4(m);
    geos.push(normalise(g));
  };

  if (jambW > 0.02) {
    push(blockGeo(jambW, height, thick, rng, 0.04), -(half + jambW * 0.5), height * 0.5);
    push(blockGeo(jambW, height, thick, rng, 0.04), half + jambW * 0.5, height * 0.5);
  }
  // Sill course under the opening (a threshold), if the opening starts above 0.
  if (sillY > 0.05) push(blockGeo(span, sillY, thick, rng, 0.03), 0, sillY * 0.5);
  // Head: everything above the apex.
  if (height > apex + 0.05) push(blockGeo(span, height - apex, thick, rng, 0.04), 0, (height + apex) * 0.5);

  // Spandrels: the two triangular-ish regions between the arch extrados and the
  // rectangle. Approximated by a stack of thin blocks, which is both cheap and
  // correct-looking because a real spandrel IS coursed masonry.
  const ring = 0.5;
  const path = pointedArchPath(span, riseRatio, 12);
  const rows = 5;
  for (let r = 0; r < rows; r++) {
    const y0 = sillY + ((apex - sillY) * r) / rows;
    const y1 = sillY + ((apex - sillY) * (r + 1)) / rows;
    // Widest x the arch reaches at y1 — the block must stop clear of it.
    let ax = 0;
    for (const p of path) if (p.y <= y1 - sillY + 1e-4) ax = Math.max(ax, Math.abs(p.x));
    const inner = Math.min(half, ax + ring * 0.55);
    const w = half - inner;
    if (w > 0.08) {
      push(blockGeo(w, y1 - y0, thick, rng, 0.03), -(inner + w * 0.5), (y0 + y1) * 0.5);
      push(blockGeo(w, y1 - y0, thick, rng, 0.03), inner + w * 0.5, (y0 + y1) * 0.5);
    }
  }

  // The arch ring itself, sitting in the reveal.
  const ringGeo = archRingGeo(span, riseRatio, ring, thick, rng, 9);
  if (ringGeo) {
    m.makeTranslation(0, sillY, 0);
    ringGeo.applyMatrix4(m);
    geos.push(normalise(ringGeo));
  }

  return mergeAll(geos, true);
}

/**
 * Quadripartite ribbed vault over one bay — four groin webs meeting at a boss.
 *
 * Parametric rather than assembled: a vault web is a doubly-curved surface and
 * there is no way to fake one out of boxes. UVs are authored directly in metres
 * (`uvMode:'keep'`) because the world projection would band a curved surface.
 *
 * `sag` is how far the web dips below the straight line between the ribs — the
 * thing that separates a vault from a hip roof.
 */
export function ribVaultGeo(w, d, rise, seg = 5, sag = 0.34) {
  const g = new THREE.BufferGeometry();
  const nx = seg, nz = seg;
  const verts = (nx + 1) * (nz + 1);
  const pos = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const idx = [];

  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const u = i / nx, v = j / nz;
      const x = (u - 0.5) * w;
      const z = (v - 0.5) * d;
      // Distance from the bay centre along each diagonal, normalised. The web
      // rises toward the boss and is pulled down toward the four springers.
      const su = Math.abs(u - 0.5) * 2;
      const sv = Math.abs(v - 0.5) * 2;
      // Elliptical dome profile with a groin crease along the diagonals.
      const dome = Math.sqrt(Math.max(0, 1 - su * su)) * Math.sqrt(Math.max(0, 1 - sv * sv));
      const groin = 1 - Math.abs(su - sv) * 0.5;
      const y = rise * dome * (0.72 + 0.28 * groin) - sag * (1 - dome) * 0.35;
      const k = (j * (nx + 1) + i) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      const t = (j * (nx + 1) + i) * 2;
      // UVs in metres along the developed surface — close enough on a shallow
      // vault, and the alternative (unrolling the true geodesics) buys nothing
      // at the texel density a ceiling is ever seen at.
      uv[t] = x; uv[t + 1] = z;
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const e = c + 1;
      // Wound so the visible face is the UNDERSIDE — a vault is only ever seen
      // from below, and back-face culling would otherwise remove all of it.
      idx.push(a, b, c, b, e, c);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A rib: a swept square section following the pointed-arch path, used for the
 *  diagonal and transverse ribs of a vault and for arch mouldings. */
export function ribGeo(span, riseRatio, thickness, depth, segments = 14) {
  const path = pointedArchPath(span, riseRatio, segments);
  const geos = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const ang = Math.atan2(dy, dx);
    const seg = new THREE.BoxGeometry(len * 1.04, thickness, depth);
    e.set(0, 0, ang);
    q.setFromEuler(e);
    m.compose(_v0.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, 0), q, _v1.set(1, 1, 1));
    seg.applyMatrix4(m);
    geos.push(normalise(seg));
  }
  return mergeAll(geos, true);
}

/**
 * A run of steps. Rise/run are real: 0.17 m rise on a 0.32 m tread is a
 * comfortable stair and the shadow each nosing casts is what makes a flight read
 * as climbable rather than as a ramp with lines on it.
 */
export function stairsGeo(width, steps, rise, run, rng) {
  const geos = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < steps; i++) {
    // Each tread is a full slab back to the start, so the flight is solid and
    // the collision box per step is trivially correct.
    const depth = run * (steps - i);
    const g = blockGeo(width, rise, depth, rng, 0.018);
    // Step i occupies z from i*run forward to the bottom of the flight, so the
    // whole run is solid and the per-step collider is trivially the same box.
    m.makeTranslation(0, rise * (i + 0.5), i * run + depth * 0.5);
    g.applyMatrix4(m);
    geos.push(normalise(g));
  }
  return mergeAll(geos, true);
}

/**
 * Rose window tracery: an outer ring, an inner oculus and N radiating mullions
 * with a foiled inner circle. Built thin (0.22 m) and set in a wall opening so
 * the sky reads through it.
 */
export function roseWindowGeo(radius, spokes, thick, rng) {
  const geos = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();

  const ringOf = (r, section) => {
    const seg = Math.max(12, Math.round(r * 9));
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const mx = (Math.cos(a0) + Math.cos(a1)) * 0.5 * r;
      const my = (Math.sin(a0) + Math.sin(a1)) * 0.5 * r;
      const len = Math.hypot(Math.cos(a1) - Math.cos(a0), Math.sin(a1) - Math.sin(a0)) * r;
      const g = new THREE.BoxGeometry(len * 1.06, section, thick);
      e.set(0, 0, (a0 + a1) * 0.5 + Math.PI * 0.5);
      q.setFromEuler(e);
      m.compose(_v0.set(mx, my, 0), q, _v1.set(1, 1, 1));
      g.applyMatrix4(m);
      geos.push(normalise(g));
    }
  };

  ringOf(radius, 0.30);
  ringOf(radius * 0.62, 0.19);
  ringOf(radius * 0.20, 0.15);

  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + (rng ? rng.range(-0.02, 0.02) : 0);
    const g = new THREE.BoxGeometry(radius * 0.82, 0.15, thick);
    e.set(0, 0, a);
    q.setFromEuler(e);
    m.compose(_v0.set(Math.cos(a) * radius * 0.59, Math.sin(a) * radius * 0.59, 0), q, _v1.set(1, 1, 1));
    g.applyMatrix4(m);
    geos.push(normalise(g));
    // Foils: small circles between the inner oculus and the mid ring.
    const fa = a + Math.PI / spokes;
    const fr = radius * 0.41;
    const foil = new THREE.TorusGeometry(radius * 0.13, 0.055, 4, 10);
    m.makeTranslation(Math.cos(fa) * fr, Math.sin(fa) * fr, 0);
    foil.applyMatrix4(m);
    geos.push(normalise(foil));
  }
  return mergeAll(geos, true);
}

/**
 * A floor slab with long-wavelength subsidence and, optionally, a collapsed
 * region where the vertices drop away into a pit.
 *
 * The undulation is not decoration. `floor.crypt` is a WET material and a
 * perfectly planar floor gives the entire specular lobe one identical normal, so
 * a brazier reflects as a single symmetric blob. ±4 cm over a ~9 m period pools
 * the highlight into streaks, which is the whole "damp flagstone" read Diablo IV
 * interiors are built on.
 */
export function floorGeo(w, d, resolution, rng, opts = {}) {
  const nx = Math.max(1, Math.round(w / resolution));
  const nz = Math.max(1, Math.round(d / resolution));
  const g = new THREE.PlaneGeometry(w, d, nx, nz);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;

  // Two incommensurate sine pairs with a seeded phase: no visible repeat, no
  // noise texture, and identical on every run with the same seed.
  const p0 = rng ? rng.range(0, 6.283) : 0;
  const p1 = rng ? rng.range(0, 6.283) : 0;
  const amp = opts.amplitude ?? 1;
  const dip = opts.dip ?? null; // { x, z, radius, depth }

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    let y =
      Math.sin(x * 0.34 + p0) * Math.cos(z * 0.29 + p1) * 0.030 * amp +
      Math.sin(x * 0.11 + p1 + 1.7) * Math.sin(z * 0.13 + p0 - 0.6) * 0.048 * amp;
    if (dip) {
      const r = Math.hypot(x - dip.x, z - dip.z) / dip.radius;
      if (r < 1) {
        // Smoothstep-shaped subsidence — the floor sags into the void beneath,
        // it does not have a hole punched in it.
        const t = 1 - r * r;
        y -= dip.depth * t * t;
      }
    }
    pos.setY(i, y);
    uv.setXY(i, x, z);   // metres, per the material library's convention
  }
  g.computeVertexNormals();
  return g;
}

/** A chain: N torus links alternating 90°, hanging straight down from y=0. */
export function chainGeo(links, linkLen, radius) {
  const geos = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < links; i++) {
    const g = new THREE.TorusGeometry(linkLen * 0.34, radius, 4, 8);
    e.set(Math.PI * 0.5, 0, i % 2 ? Math.PI * 0.5 : 0);
    q.setFromEuler(e);
    m.compose(_v0.set(0, -linkLen * (i + 0.5), 0), q, _v1.set(1, 1, 1));
    g.applyMatrix4(m);
    geos.push(normalise(g));
  }
  return mergeAll(geos, true);
}

/** Random unit-ish rock: an icosahedron with per-vertex radial noise, so no two
 *  instances of the same geometry are the same shape when scaled differently. */
export function rockGeo(radius, detail, rng, roughness = 0.34) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    _v0.fromBufferAttribute(pos, i);
    const k = 1 + (rng ? rng.range(-roughness, roughness) : 0);
    pos.setXYZ(i, _v0.x * k, _v0.y * k * 0.72, _v0.z * k);
  }
  pos.needsUpdate = true;
  const flat = toFlat(g);
  if (flat !== g) g.dispose();
  flat.computeVertexNormals();
  return flat;
}

/** A tapered, slightly bent bone shaft with knuckle ends. ~90 triangles. */
export function boneGeo(length, radius, rng) {
  const geos = [];
  const m = new THREE.Matrix4();
  const shaft = new THREE.CylinderGeometry(radius * 0.72, radius * 0.8, length, 6, 1);
  const bend = rng ? rng.range(-0.06, 0.06) : 0;
  const p = shaft.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    p.setX(i, p.getX(i) + bend * (1 - (y / (length * 0.5)) ** 2) * length);
  }
  p.needsUpdate = true;
  shaft.computeVertexNormals();
  geos.push(normalise(shaft));
  for (const s of [-1, 1]) {
    const k = new THREE.IcosahedronGeometry(radius * 1.55, 0);
    m.makeScale(1, 0.8, 1.1);
    k.applyMatrix4(m);
    m.makeTranslation(bend * s * -0.0, (length * 0.5) * s, 0);
    k.applyMatrix4(m);
    geos.push(normalise(k));
  }
  return mergeAll(geos, true);
}

/** A skull: cranium, brow, jaw and two eye sockets pressed in. ~130 triangles. */
export function skullGeo(size) {
  const geos = [];
  const m = new THREE.Matrix4();
  const cran = new THREE.SphereGeometry(size, 8, 6);
  m.makeScale(0.92, 1.0, 1.12);
  cran.applyMatrix4(m);
  geos.push(normalise(cran));

  const face = new THREE.BoxGeometry(size * 1.28, size * 0.86, size * 0.72);
  m.makeTranslation(0, -size * 0.42, size * 0.72);
  face.applyMatrix4(m);
  geos.push(normalise(face));

  const jaw = new THREE.BoxGeometry(size * 1.16, size * 0.36, size * 0.9);
  m.makeTranslation(0, -size * 0.86, size * 0.5);
  jaw.applyMatrix4(m);
  geos.push(normalise(jaw));

  // Sockets: small boxes pushed IN, which at this size read as two dark holes
  // once AO lands in them. Cheaper and more legible than real geometry.
  for (const s of [-1, 1]) {
    const eye = new THREE.BoxGeometry(size * 0.42, size * 0.40, size * 0.42);
    m.makeTranslation(s * size * 0.40, -size * 0.18, size * 0.92);
    eye.applyMatrix4(m);
    geos.push(normalise(eye));
  }
  return mergeAll(geos, true);
}

/** Collision box record — see collision.js. Kept as a plain object so an array
 *  of them can be built without allocation pressure mattering. */
export function obb(x, y, z, hx, hy, hz, yaw, surface) {
  return { x, y, z, hx, hy, hz, yaw, surface };
}
