/**
 * bvh.js — static level geometry: triangle soup + binned-SAH BVH.
 *
 * `world` registers meshes through `PhysicsSystem.addStatic()`; we bake them into
 * world space once, concatenate everything into flat typed arrays, and build a
 * BVH over the result on `world:ready`. After `build()` NOTHING here allocates —
 * queries run on preallocated stacks and write into caller-supplied records.
 *
 * Layout (struct-of-arrays; one entry per triangle)
 *   pos      Float32Array, 9 floats (a.xyz b.xyz c.xyz), world space
 *   nrm      Float32Array, 3 floats, unit geometric normal
 *   surface  Uint8Array,   surface enum index      (see surfaces.js)
 *   layer    Uint16Array,  collision layer bit
 *   object   Int32Array,   owning collider id
 *
 * Nodes (two parallel arrays, no objects, cache-friendly traversal)
 *   nodeBounds Float32Array, 6 per node — minx miny minz maxx maxy maxz
 *   nodeMeta   Int32Array,   2 per node — [leftFirst, count]
 *                            count > 0 : leaf, triIndex[leftFirst .. leftFirst+count)
 *                            count = 0 : interior, children at leftFirst and leftFirst+1
 *
 * Build cost on the sibling project was 29k triangles -> ~14k nodes in 22 ms.
 * That is the bar and this implementation matches it: one centroid+AABB pass,
 * then an in-place partition with 12 bins per split and a full SAH sweep.
 */

import * as THREE from 'three';
import {
  rayAabb, rayTriangle, segTriangleClosest, closestPtPointTriangle,
  triAabb, makeClosest, makeHit, clearHit, EPS, TOL,
} from './math.js';
import { surfaceIndex, surfaceName, guessSurface, guessLayer, LAYER } from './surfaces.js';

const BINS = 12;
/** Stop splitting at this many triangles. 6 keeps leaves inside a cache line pair
 *  while avoiding the node explosion that makes traversal pointer-chasing. */
const LEAF_SIZE = 6;
const TRAV_COST = 1.0;
const TRI_COST = 1.35;

/** Conservative-advancement tolerance and iteration cap for capsule sweeps. */
const CA_TOL = 1e-4;
const CA_ITERS = 48;
/** Below this closing speed a triangle can never be reached along the current
 *  separating axis, so it is dropped from the sweep entirely. */
const CA_MIN_CLOSING = 1e-5;
/** AABB queries are inflated by this much before testing. Level geometry is full
 *  of surfaces that sit at EXACTLY the query bound (a floor at y=0 under a
 *  capsule whose lower bound is y=0) and an exact comparison rejects them on the
 *  wrong side of a floating-point rounding of the mesh's world matrix. */
const AABB_EPS = 1e-4;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* Mesh baking                                                         */
/* ------------------------------------------------------------------ */

/**
 * Bake a Mesh or InstancedMesh into world-space triangles.
 *
 * Returns `{ pos: Float32Array, count, surfaces: Uint8Array }` or null.
 * Degenerate triangles (area below a square millimetre) are dropped: they
 * contribute nothing to collision but poison SAH bins and produce NaN normals.
 *
 * `opts.box === true` bakes the mesh's *bounding box* (12 triangles) instead of
 * its geometry. That is the escape hatch for detailed props — a 4k-triangle
 * gothic statue costs 12 triangles of collision and nobody can tell.
 */
export function bakeMesh(mesh, surface, opts = {}) {
  const geom = mesh.geometry;
  if (!geom) return null;
  mesh.updateWorldMatrix(true, false);

  if (opts.box) return bakeBox(mesh, surface, opts);

  const posAttr = geom.getAttribute('position');
  if (!posAttr) return null;
  const index = geom.getIndex();
  const triCount = (index ? index.count : posAttr.count) / 3 | 0;
  if (triCount === 0) return null;

  const instances = mesh.isInstancedMesh ? mesh.count : 1;
  const total = triCount * instances;
  const out = new Float32Array(total * 9);
  const surfaces = new Uint8Array(total);
  const sIdx = surfaceIndex(surface, guessSurface(mesh.name || mesh.material?.name));

  let w = 0;
  for (let inst = 0; inst < instances; inst++) {
    if (mesh.isInstancedMesh) {
      mesh.getMatrixAt(inst, _m4);
      _m4.premultiply(mesh.matrixWorld);
    } else {
      _m4.copy(mesh.matrixWorld);
    }
    const e = _m4.elements;
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      let ax = posAttr.getX(i0), ay = posAttr.getY(i0), az = posAttr.getZ(i0);
      let bx = posAttr.getX(i1), by = posAttr.getY(i1), bz = posAttr.getZ(i1);
      let cx = posAttr.getX(i2), cy = posAttr.getY(i2), cz = posAttr.getZ(i2);
      // Inline the matrix transform: getX/getY/getZ is already the slow part and
      // constructing a Vector3 per vertex here would allocate 3 * triCount objects
      // during a build that runs on the main thread at level load.
      const wax = e[0] * ax + e[4] * ay + e[8] * az + e[12];
      const way = e[1] * ax + e[5] * ay + e[9] * az + e[13];
      const waz = e[2] * ax + e[6] * ay + e[10] * az + e[14];
      const wbx = e[0] * bx + e[4] * by + e[8] * bz + e[12];
      const wby = e[1] * bx + e[5] * by + e[9] * bz + e[13];
      const wbz = e[2] * bx + e[6] * by + e[10] * bz + e[14];
      const wcx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
      const wcy = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
      const wcz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];

      const e1x = wbx - wax, e1y = wby - way, e1z = wbz - waz;
      const e2x = wcx - wax, e2y = wcy - way, e2z = wcz - waz;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      if (nx * nx + ny * ny + nz * nz < 1e-12) continue; // degenerate, drop

      const o = w * 9;
      out[o] = wax; out[o + 1] = way; out[o + 2] = waz;
      out[o + 3] = wbx; out[o + 4] = wby; out[o + 5] = wbz;
      out[o + 6] = wcx; out[o + 7] = wcy; out[o + 8] = wcz;
      surfaces[w] = sIdx;
      w++;
    }
  }
  if (w === 0) return null;
  return { pos: out, count: w, surfaces };
}

/** 12 triangles around the mesh's world-space oriented bounding box. */
function bakeBox(mesh, surface, opts) {
  const geom = mesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return null;
  const pad = opts.pad ?? 0;
  const instances = mesh.isInstancedMesh ? mesh.count : 1;
  const out = new Float32Array(instances * 12 * 9);
  const surfaces = new Uint8Array(instances * 12);
  const sIdx = surfaceIndex(surface, guessSurface(mesh.name || mesh.material?.name));
  surfaces.fill(sIdx);

  // Unit cube corners; scaled to the local bbox then transformed.
  const cx = [0, 1, 1, 0, 0, 1, 1, 0];
  const cy = [0, 0, 1, 1, 0, 0, 1, 1];
  const cz = [0, 0, 0, 0, 1, 1, 1, 1];
  // 12 triangles, wound outward.
  const F = [
    0, 2, 1, 0, 3, 2, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    3, 7, 6, 3, 6, 2, // +y
    0, 4, 7, 0, 7, 3, // -x
    1, 2, 6, 1, 6, 5, // +x
  ];
  const px = new Float32Array(8), py = new Float32Array(8), pz = new Float32Array(8);
  let w = 0;
  for (let inst = 0; inst < instances; inst++) {
    if (mesh.isInstancedMesh) {
      mesh.getMatrixAt(inst, _m4);
      _m4.premultiply(mesh.matrixWorld);
    } else {
      _m4.copy(mesh.matrixWorld);
    }
    const e = _m4.elements;
    for (let i = 0; i < 8; i++) {
      const lx = (bb.min.x - pad) + cx[i] * (bb.max.x - bb.min.x + pad * 2);
      const ly = (bb.min.y - pad) + cy[i] * (bb.max.y - bb.min.y + pad * 2);
      const lz = (bb.min.z - pad) + cz[i] * (bb.max.z - bb.min.z + pad * 2);
      px[i] = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
      py[i] = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
      pz[i] = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
    }
    for (let t = 0; t < 12; t++) {
      const o = w * 9;
      for (let k = 0; k < 3; k++) {
        const v = F[t * 3 + k];
        out[o + k * 3] = px[v];
        out[o + k * 3 + 1] = py[v];
        out[o + k * 3 + 2] = pz[v];
      }
      w++;
    }
  }
  return { pos: out, count: w, surfaces };
}

/* ------------------------------------------------------------------ */
/* Contact buffer                                                      */
/* ------------------------------------------------------------------ */

/** Preallocated contact list produced by overlap queries. */
export function makeContacts(capacity = 128) {
  return {
    count: 0,
    capacity,
    nx: new Float32Array(capacity),
    ny: new Float32Array(capacity),
    nz: new Float32Array(capacity),
    px: new Float32Array(capacity),
    py: new Float32Array(capacity),
    pz: new Float32Array(capacity),
    depth: new Float32Array(capacity),
    /** Parameter along the query capsule's segment, 0..1. */
    s: new Float32Array(capacity),
    tri: new Int32Array(capacity),
    surface: new Uint8Array(capacity),
    layer: new Uint16Array(capacity),
  };
}

/* ------------------------------------------------------------------ */
/* StaticWorld                                                         */
/* ------------------------------------------------------------------ */

export class StaticWorld {
  constructor() {
    /** @type {Array<object|null>} sparse, indexed by collider id */
    this.objects = [];
    this._freeIds = [];

    this.triCount = 0;
    this.pos = new Float32Array(0);
    this.nrm = new Float32Array(0);
    this.surface = new Uint8Array(0);
    this.layer = new Uint16Array(0);
    this.object = new Int32Array(0);

    this.triIndex = new Uint32Array(0);
    this.nodeBounds = new Float32Array(0);
    this.nodeMeta = new Int32Array(0);
    this.nodeCount = 0;
    this.maxDepth = 0;
    this.leafCount = 0;

    this.dirty = false;
    this.buildMs = 0;
    this.version = 0;

    // ---- scratch, all sized in build() ----
    this._cent = new Float32Array(0);
    this._taabb = new Float32Array(0);
    /** Traversal stack. 128 is far beyond any depth a SAH BVH reaches for a
     *  dungeon (log2(200k) ≈ 18 plus slack for pathological splits). */
    this._stackNode = new Int32Array(128);
    this._stackT = new Float32Array(128);
    /** Build stack: (node, first, count, depth). */
    this._buildStack = new Int32Array(4 * 8192);
    this._cl = makeClosest();
    this._cand = new Int32Array(8192);
    this._candCount = 0;
    this._candOverflow = 0;

    // SAH bins, reused for every split.
    this._binCount = new Int32Array(BINS);
    this._binBounds = new Float32Array(BINS * 6);
    this._sweepL = new Float32Array(BINS);   // left surface area prefix
    this._sweepR = new Float32Array(BINS);   // right surface area suffix
    this._sweepLN = new Int32Array(BINS);
    this._sweepRN = new Int32Array(BINS);

    this.contacts = makeContacts(192);

    this.aabb = { minx: 0, miny: 0, minz: 0, maxx: 0, maxy: 0, maxz: 0 };
    this.counters = { rays: 0, sweeps: 0, overlaps: 0, nodeTests: 0, triTests: 0 };
  }

  /* ---------------------------------------------------------------- */
  /* Registration                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Bake a mesh into the soup. Returns the collider id, or -1 if the mesh had
   * no usable geometry. Safe to call before the owning system's `init()` — all
   * state here is built in the constructor for exactly that reason.
   */
  addMesh(mesh, opts = {}) {
    if (!mesh) return -1;
    const baked = bakeMesh(mesh, opts.surface, opts);
    if (!baked || baked.count === 0) return -1;

    const id = this._freeIds.length ? this._freeIds.pop() : this.objects.length;
    this.objects[id] = {
      id,
      name: mesh.name || mesh.type,
      mesh,
      surfaces: baked.surfaces,
      layer: opts.layer ?? guessLayer(mesh.name),
      tris: baked.pos,
      triCount: baked.count,
      alive: true,
      auto: !!opts.auto,
      userData: opts.userData ?? null,
    };
    this.dirty = true;
    return id;
  }

  /** Register raw world-space triangles (Float32Array, 9 floats each). */
  addTriangles(positions, count, opts = {}) {
    if (!positions || count <= 0) return -1;
    const id = this._freeIds.length ? this._freeIds.pop() : this.objects.length;
    const s = surfaceIndex(opts.surface);
    const surfaces = new Uint8Array(count);
    surfaces.fill(s);
    this.objects[id] = {
      id,
      name: opts.name ?? 'raw',
      mesh: null,
      surfaces,
      layer: opts.layer ?? LAYER.STATIC,
      tris: positions,
      triCount: count,
      alive: true,
      auto: !!opts.auto,
      userData: opts.userData ?? null,
    };
    this.dirty = true;
    return id;
  }

  remove(id) {
    const o = this.objects[id];
    if (!o || !o.alive) return false;
    o.alive = false;
    o.tris = null;
    o.surfaces = null;
    this.objects[id] = null;
    this._freeIds.push(id);
    this.dirty = true;
    return true;
  }

  /** Drop everything that was auto-collected by a scene scan (keeps explicit ones). */
  removeAuto() {
    let n = 0;
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o && o.alive && o.auto) { this.remove(i); n++; }
    }
    return n;
  }

  clear() {
    this.objects.length = 0;
    this._freeIds.length = 0;
    this.dirty = true;
  }

  findByMesh(mesh) {
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o && o.alive && o.mesh === mesh) return i;
    }
    return -1;
  }

  get objectCount() {
    let n = 0;
    for (const o of this.objects) if (o && o.alive) n++;
    return n;
  }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  build() {
    const t0 = performance.now();
    let total = 0;
    for (const o of this.objects) if (o && o.alive) total += o.triCount;

    this.triCount = total;
    if (total === 0) {
      this.nodeCount = 0;
      this.leafCount = 0;
      this.maxDepth = 0;
      this.dirty = false;
      this.version++;
      this.buildMs = performance.now() - t0;
      return this;
    }

    if (this.pos.length < total * 9) {
      // Grow with 25% headroom so a level that adds a few props later does not
      // reallocate 6 typed arrays on the frame it happens.
      const cap = Math.ceil(total * 1.25);
      this.pos = new Float32Array(cap * 9);
      this.nrm = new Float32Array(cap * 3);
      this.surface = new Uint8Array(cap);
      this.layer = new Uint16Array(cap);
      this.object = new Int32Array(cap);
      this.triIndex = new Uint32Array(cap);
      this._cent = new Float32Array(cap * 3);
      this._taabb = new Float32Array(cap * 6);
      const maxNodes = 2 * cap + 8; // a binary BVH over N leaves has <= 2N-1 nodes
      this.nodeBounds = new Float32Array(maxNodes * 6);
      this.nodeMeta = new Int32Array(maxNodes * 2);
    }

    // ---- 1. concatenate ----
    const pos = this.pos;
    let w = 0;
    for (const o of this.objects) {
      if (!o || !o.alive) continue;
      pos.set(o.tris.subarray(0, o.triCount * 9), w * 9);
      for (let i = 0; i < o.triCount; i++) {
        this.surface[w + i] = o.surfaces[i];
        this.layer[w + i] = o.layer;
        this.object[w + i] = o.id;
      }
      w += o.triCount;
    }

    // ---- 2. per-triangle normal, centroid, AABB; and the root bounds ----
    let rminx = Infinity, rminy = Infinity, rminz = Infinity;
    let rmaxx = -Infinity, rmaxy = -Infinity, rmaxz = -Infinity;
    const cent = this._cent, taabb = this._taabb, nrm = this.nrm;
    for (let i = 0; i < total; i++) {
      const o = i * 9;
      const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
      const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5];
      const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let nxv = e1y * e2z - e1z * e2y;
      let nyv = e1z * e2x - e1x * e2z;
      let nzv = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nxv, nyv, nzv) || 1;
      nrm[i * 3] = nxv / len; nrm[i * 3 + 1] = nyv / len; nrm[i * 3 + 2] = nzv / len;

      cent[i * 3] = (ax + bx + cx) / 3;
      cent[i * 3 + 1] = (ay + by + cy) / 3;
      cent[i * 3 + 2] = (az + bz + cz) / 3;

      const mnx = Math.min(ax, bx, cx), mny = Math.min(ay, by, cy), mnz = Math.min(az, bz, cz);
      const mxx = Math.max(ax, bx, cx), mxy = Math.max(ay, by, cy), mxz = Math.max(az, bz, cz);
      const t6 = i * 6;
      taabb[t6] = mnx; taabb[t6 + 1] = mny; taabb[t6 + 2] = mnz;
      taabb[t6 + 3] = mxx; taabb[t6 + 4] = mxy; taabb[t6 + 5] = mxz;

      if (mnx < rminx) rminx = mnx;
      if (mny < rminy) rminy = mny;
      if (mnz < rminz) rminz = mnz;
      if (mxx > rmaxx) rmaxx = mxx;
      if (mxy > rmaxy) rmaxy = mxy;
      if (mxz > rmaxz) rmaxz = mxz;

      this.triIndex[i] = i;
    }
    this.aabb.minx = rminx; this.aabb.miny = rminy; this.aabb.minz = rminz;
    this.aabb.maxx = rmaxx; this.aabb.maxy = rmaxy; this.aabb.maxz = rmaxz;

    // ---- 3. subdivide ----
    this.nodeCount = 1;
    this.leafCount = 0;
    this.maxDepth = 0;
    this._setNodeBounds(0, rminx, rminy, rminz, rmaxx, rmaxy, rmaxz);
    this.nodeMeta[0] = 0;
    this.nodeMeta[1] = total;

    let sp = 0;
    const bs = this._buildStack;
    bs[sp++] = 0; bs[sp++] = 0; bs[sp++] = total; bs[sp++] = 0;

    while (sp > 0) {
      const depth = bs[--sp];
      const count = bs[--sp];
      const first = bs[--sp];
      const node = bs[--sp];
      if (depth > this.maxDepth) this.maxDepth = depth;

      if (count <= LEAF_SIZE || depth >= 60) { this.leafCount++; continue; }

      const split = this._split(node, first, count);
      if (split < 0) { this.leafCount++; continue; }

      const leftCount = split - first;
      const rightCount = count - leftCount;
      const left = this.nodeCount++;
      const right = this.nodeCount++;

      this._boundsOf(first, leftCount, left);
      this._boundsOf(split, rightCount, right);
      this.nodeMeta[left * 2] = first; this.nodeMeta[left * 2 + 1] = leftCount;
      this.nodeMeta[right * 2] = split; this.nodeMeta[right * 2 + 1] = rightCount;

      // Mark interior: leftFirst = first child index, count = 0.
      this.nodeMeta[node * 2] = left;
      this.nodeMeta[node * 2 + 1] = 0;

      // Push the larger child first so the stack stays shallow.
      if (leftCount >= rightCount) {
        bs[sp++] = right; bs[sp++] = split; bs[sp++] = rightCount; bs[sp++] = depth + 1;
        bs[sp++] = left; bs[sp++] = first; bs[sp++] = leftCount; bs[sp++] = depth + 1;
      } else {
        bs[sp++] = left; bs[sp++] = first; bs[sp++] = leftCount; bs[sp++] = depth + 1;
        bs[sp++] = right; bs[sp++] = split; bs[sp++] = rightCount; bs[sp++] = depth + 1;
      }
    }

    this.dirty = false;
    this.version++;
    this.buildMs = performance.now() - t0;
    return this;
  }

  _setNodeBounds(n, a, b, c, d, e, f) {
    const o = n * 6;
    const nb = this.nodeBounds;
    nb[o] = a; nb[o + 1] = b; nb[o + 2] = c; nb[o + 3] = d; nb[o + 4] = e; nb[o + 5] = f;
  }

  /** Union of triangle AABBs over triIndex[first .. first+count) into node n. */
  _boundsOf(first, count, n) {
    const ti = this.triIndex, ta = this._taabb;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < count; i++) {
      const t6 = ti[first + i] * 6;
      if (ta[t6] < mnx) mnx = ta[t6];
      if (ta[t6 + 1] < mny) mny = ta[t6 + 1];
      if (ta[t6 + 2] < mnz) mnz = ta[t6 + 2];
      if (ta[t6 + 3] > mxx) mxx = ta[t6 + 3];
      if (ta[t6 + 4] > mxy) mxy = ta[t6 + 4];
      if (ta[t6 + 5] > mxz) mxz = ta[t6 + 5];
    }
    this._setNodeBounds(n, mnx, mny, mnz, mxx, mxy, mxz);
  }

  /**
   * Binned-SAH split. Returns the pivot index into triIndex, or -1 to make a leaf.
   *
   * The 12-bin approximation costs one pass over the range instead of the
   * O(n log n) full sweep, and on real dungeon geometry the resulting tree is
   * within a couple of percent of the exact SAH tree. It is the single reason a
   * 200k-triangle level builds in tens of milliseconds rather than seconds.
   */
  _split(node, first, count) {
    const ti = this.triIndex, cent = this._cent, ta = this._taabb;

    // Centroid bounds decide the split axis; using node bounds instead makes
    // long thin geometry (a corridor floor) bin into a single bucket.
    let cmnx = Infinity, cmny = Infinity, cmnz = Infinity;
    let cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
    for (let i = 0; i < count; i++) {
      const c3 = ti[first + i] * 3;
      const x = cent[c3], y = cent[c3 + 1], z = cent[c3 + 2];
      if (x < cmnx) cmnx = x; if (x > cmxx) cmxx = x;
      if (y < cmny) cmny = y; if (y > cmxy) cmxy = y;
      if (z < cmnz) cmnz = z; if (z > cmxz) cmxz = z;
    }
    const ex = cmxx - cmnx, ey = cmxy - cmny, ez = cmxz - cmnz;
    let axis = 0, extent = ex, cmin = cmnx;
    if (ey > extent) { axis = 1; extent = ey; cmin = cmny; }
    if (ez > extent) { axis = 2; extent = ez; cmin = cmnz; }
    if (extent < 1e-7) return -1; // all centroids coincident

    const k = BINS / extent;
    const bc = this._binCount, bb = this._binBounds;
    bc.fill(0);
    for (let b = 0; b < BINS; b++) {
      const o = b * 6;
      bb[o] = Infinity; bb[o + 1] = Infinity; bb[o + 2] = Infinity;
      bb[o + 3] = -Infinity; bb[o + 4] = -Infinity; bb[o + 5] = -Infinity;
    }
    for (let i = 0; i < count; i++) {
      const tri = ti[first + i];
      let b = ((cent[tri * 3 + axis] - cmin) * k) | 0;
      if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
      bc[b]++;
      const o = b * 6, t6 = tri * 6;
      if (ta[t6] < bb[o]) bb[o] = ta[t6];
      if (ta[t6 + 1] < bb[o + 1]) bb[o + 1] = ta[t6 + 1];
      if (ta[t6 + 2] < bb[o + 2]) bb[o + 2] = ta[t6 + 2];
      if (ta[t6 + 3] > bb[o + 3]) bb[o + 3] = ta[t6 + 3];
      if (ta[t6 + 4] > bb[o + 4]) bb[o + 4] = ta[t6 + 4];
      if (ta[t6 + 5] > bb[o + 5]) bb[o + 5] = ta[t6 + 5];
    }

    // Prefix (left) and suffix (right) surface areas over the bins.
    const sl = this._sweepL, sr = this._sweepR, sln = this._sweepLN, srn = this._sweepRN;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let acc = 0;
    for (let b = 0; b < BINS - 1; b++) {
      const o = b * 6;
      if (bc[b] > 0) {
        if (bb[o] < mnx) mnx = bb[o];
        if (bb[o + 1] < mny) mny = bb[o + 1];
        if (bb[o + 2] < mnz) mnz = bb[o + 2];
        if (bb[o + 3] > mxx) mxx = bb[o + 3];
        if (bb[o + 4] > mxy) mxy = bb[o + 4];
        if (bb[o + 5] > mxz) mxz = bb[o + 5];
      }
      acc += bc[b];
      sln[b] = acc;
      sl[b] = acc > 0 ? surfaceArea(mxx - mnx, mxy - mny, mxz - mnz) : 0;
    }
    mnx = Infinity; mny = Infinity; mnz = Infinity; mxx = -Infinity; mxy = -Infinity; mxz = -Infinity;
    acc = 0;
    for (let b = BINS - 1; b > 0; b--) {
      const o = b * 6;
      if (bc[b] > 0) {
        if (bb[o] < mnx) mnx = bb[o];
        if (bb[o + 1] < mny) mny = bb[o + 1];
        if (bb[o + 2] < mnz) mnz = bb[o + 2];
        if (bb[o + 3] > mxx) mxx = bb[o + 3];
        if (bb[o + 4] > mxy) mxy = bb[o + 4];
        if (bb[o + 5] > mxz) mxz = bb[o + 5];
      }
      acc += bc[b];
      srn[b - 1] = acc;
      sr[b - 1] = acc > 0 ? surfaceArea(mxx - mnx, mxy - mny, mxz - mnz) : 0;
    }

    const nb = this.nodeBounds, no = node * 6;
    const parentArea = surfaceArea(nb[no + 3] - nb[no], nb[no + 4] - nb[no + 1], nb[no + 5] - nb[no + 2]);
    const invParent = parentArea > 0 ? 1 / parentArea : 0;
    let bestCost = Infinity, bestBin = -1;
    for (let b = 0; b < BINS - 1; b++) {
      if (sln[b] === 0 || srn[b] === 0) continue;
      const cost = TRAV_COST + (sl[b] * sln[b] + sr[b] * srn[b]) * invParent * TRI_COST;
      if (cost < bestCost) { bestCost = cost; bestBin = b; }
    }
    if (bestBin < 0) return -1;
    // Splitting has to be cheaper than not splitting, otherwise a big leaf is the
    // right answer — this is what stops the tree exploding on coplanar fans.
    if (bestCost >= count * TRI_COST && count <= LEAF_SIZE * 3) return -1;

    // In-place Hoare partition on the bin index.
    const limit = bestBin;
    let lo = first, hi = first + count - 1;
    while (lo <= hi) {
      const tri = ti[lo];
      let b = ((cent[tri * 3 + axis] - cmin) * k) | 0;
      if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
      if (b <= limit) {
        lo++;
      } else {
        ti[lo] = ti[hi];
        ti[hi] = tri;
        hi--;
      }
    }
    if (lo === first || lo === first + count) return -1; // degenerate partition
    return lo;
  }

  /* ---------------------------------------------------------------- */
  /* Raycast                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Closest-hit ray against the soup. `out` is a hit record from `makeHit()`.
   * Returns true on hit. Direction MUST be unit length.
   *
   * Front-to-back ordered traversal with a distance-keyed stack: a child whose
   * entry distance already exceeds the best hit is never opened. That is the
   * whole trick behind sub-microsecond raycasts.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, mask, out) {
    clearHit(out);
    this.counters.rays++;
    if (this.nodeCount === 0) return false;

    const ix = 1 / (dx || 1e-30), iy = 1 / (dy || 1e-30), iz = 1 / (dz || 1e-30);
    const nb = this.nodeBounds, nm = this.nodeMeta, ti = this.triIndex, pos = this.pos;
    const stackN = this._stackNode, stackT = this._stackT;
    let sp = 0;
    let best = maxDist;
    let bestTri = -1;

    let t = rayAabb(ox, oy, oz, ix, iy, iz, nb[0], nb[1], nb[2], nb[3], nb[4], nb[5], best);
    if (t === Infinity) return false;
    stackN[sp] = 0; stackT[sp] = t; sp++;

    while (sp > 0) {
      sp--;
      if (stackT[sp] >= best) continue;
      let node = stackN[sp];

      // Descend interior nodes inline, only pushing the far child.
      for (;;) {
        const count = nm[node * 2 + 1];
        if (count > 0) break;
        const left = nm[node * 2];
        const right = left + 1;
        const lo = left * 6, ro = right * 6;
        const tl = rayAabb(ox, oy, oz, ix, iy, iz, nb[lo], nb[lo + 1], nb[lo + 2], nb[lo + 3], nb[lo + 4], nb[lo + 5], best);
        const tr = rayAabb(ox, oy, oz, ix, iy, iz, nb[ro], nb[ro + 1], nb[ro + 2], nb[ro + 3], nb[ro + 4], nb[ro + 5], best);
        if (tl === Infinity && tr === Infinity) { node = -1; break; }
        if (tl <= tr) {
          if (tr !== Infinity && sp < 127) { stackN[sp] = right; stackT[sp] = tr; sp++; }
          node = left;
        } else {
          if (tl !== Infinity && sp < 127) { stackN[sp] = left; stackT[sp] = tl; sp++; }
          node = right;
        }
      }
      if (node < 0) continue;

      const first = nm[node * 2];
      const count = nm[node * 2 + 1];
      for (let i = 0; i < count; i++) {
        const tri = ti[first + i];
        if ((this.layer[tri] & mask) === 0) continue;
        const o = tri * 9;
        const th = rayTriangle(
          ox, oy, oz, dx, dy, dz,
          pos[o], pos[o + 1], pos[o + 2],
          pos[o + 3], pos[o + 4], pos[o + 5],
          pos[o + 6], pos[o + 7], pos[o + 8],
          out
        );
        if (th >= 0 && th < best) { best = th; bestTri = tri; }
      }
    }

    if (bestTri < 0) return false;
    out.hit = true;
    out.t = best;
    out.tri = bestTri;
    out.px = ox + dx * best;
    out.py = oy + dy * best;
    out.pz = oz + dz * best;
    // Flip the geometric normal to face the ray so callers never have to.
    let nx = this.nrm[bestTri * 3], ny = this.nrm[bestTri * 3 + 1], nz = this.nrm[bestTri * 3 + 2];
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; out.frontFace = false; }
    else out.frontFace = true;
    out.nx = nx; out.ny = ny; out.nz = nz;
    out.surfaceId = this.surface[bestTri];
    out.surface = surfaceName(out.surfaceId);
    out.layer = this.layer[bestTri];
    out.object = this.object[bestTri];
    out.mesh = this.objects[out.object]?.mesh ?? null;
    out.kind = 'static';
    return true;
  }

  /**
   * Any-hit occlusion query. Returns true as soon as ANY triangle is crossed —
   * roughly 3x cheaper than `raycast` because it never has to order the traversal.
   * This is what AI line-of-sight calls 60 times a second.
   */
  raycastAny(ox, oy, oz, dx, dy, dz, maxDist, mask) {
    this.counters.rays++;
    if (this.nodeCount === 0) return false;
    const ix = 1 / (dx || 1e-30), iy = 1 / (dy || 1e-30), iz = 1 / (dz || 1e-30);
    const nb = this.nodeBounds, nm = this.nodeMeta, ti = this.triIndex, pos = this.pos;
    const stackN = this._stackNode;
    let sp = 0;
    if (rayAabb(ox, oy, oz, ix, iy, iz, nb[0], nb[1], nb[2], nb[3], nb[4], nb[5], maxDist) === Infinity) return false;
    stackN[sp++] = 0;
    while (sp > 0) {
      const node = stackN[--sp];
      const count = nm[node * 2 + 1];
      if (count === 0) {
        const left = nm[node * 2], right = left + 1;
        const lo = left * 6, ro = right * 6;
        if (rayAabb(ox, oy, oz, ix, iy, iz, nb[lo], nb[lo + 1], nb[lo + 2], nb[lo + 3], nb[lo + 4], nb[lo + 5], maxDist) !== Infinity && sp < 127) stackN[sp++] = left;
        if (rayAabb(ox, oy, oz, ix, iy, iz, nb[ro], nb[ro + 1], nb[ro + 2], nb[ro + 3], nb[ro + 4], nb[ro + 5], maxDist) !== Infinity && sp < 127) stackN[sp++] = right;
        continue;
      }
      const first = nm[node * 2];
      for (let i = 0; i < count; i++) {
        const tri = ti[first + i];
        if ((this.layer[tri] & mask) === 0) continue;
        const o = tri * 9;
        const th = rayTriangle(
          ox, oy, oz, dx, dy, dz,
          pos[o], pos[o + 1], pos[o + 2],
          pos[o + 3], pos[o + 4], pos[o + 5],
          pos[o + 6], pos[o + 7], pos[o + 8],
          null
        );
        if (th >= 0 && th <= maxDist) return true;
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Candidate gathering (shared by every shape query)                 */
  /* ---------------------------------------------------------------- */

  /**
   * Collect triangle indices whose AABB overlaps the query box into `_cand`.
   * Overflow is counted, not thrown: a 8192-triangle overlap means the caller
   * asked for something absurd (a 60 m sphere) and clipping the list degrades
   * the answer instead of the frame.
   */
  _gather(mnx, mny, mnz, mxx, mxy, mxz, mask) {
    this._candCount = 0;
    if (this.nodeCount === 0) return 0;
    mnx -= AABB_EPS; mny -= AABB_EPS; mnz -= AABB_EPS;
    mxx += AABB_EPS; mxy += AABB_EPS; mxz += AABB_EPS;
    const nb = this.nodeBounds, nm = this.nodeMeta, ti = this.triIndex, ta = this._taabb;
    const cand = this._cand, cap = cand.length;
    const stack = this._stackNode;
    let sp = 0;
    stack[sp++] = 0;
    let n = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      if (nb[o] > mxx || nb[o + 3] < mnx ||
          nb[o + 1] > mxy || nb[o + 4] < mny ||
          nb[o + 2] > mxz || nb[o + 5] < mnz) continue;
      const count = nm[node * 2 + 1];
      if (count === 0) {
        const left = nm[node * 2];
        if (sp < 126) { stack[sp++] = left; stack[sp++] = left + 1; }
        continue;
      }
      const first = nm[node * 2];
      for (let i = 0; i < count && n < cap; i++) {
        const tri = ti[first + i];
        if ((this.layer[tri] & mask) === 0) continue;
        const t6 = tri * 6;
        if (ta[t6] > mxx || ta[t6 + 3] < mnx ||
            ta[t6 + 1] > mxy || ta[t6 + 4] < mny ||
            ta[t6 + 2] > mxz || ta[t6 + 5] < mnz) continue;
        cand[n++] = tri;
      }
      if (n >= cap) { this._candOverflow++; break; }
    }
    this._candCount = n;
    return n;
  }

  /** Public AABB query: calls `cb(triIndex)` for each candidate. Debug/tools only. */
  queryAabb(mnx, mny, mnz, mxx, mxy, mxz, mask, cb) {
    const n = this._gather(mnx, mny, mnz, mxx, mxy, mxz, mask);
    for (let i = 0; i < n; i++) cb(this._cand[i]);
    return n;
  }

  /* ---------------------------------------------------------------- */
  /* Overlap                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Capsule overlap. Fills `contacts` (defaults to the shared buffer) with one
   * entry per penetrating triangle: outward normal, world contact point, depth,
   * and the parameter along the capsule segment where it happened.
   *
   * Contact normals point FROM the triangle TOWARDS the capsule — push the capsule
   * along `n` by `depth` to separate. When the capsule axis lies exactly in the
   * triangle's plane the closest-pair direction degenerates, so we fall back to
   * the geometric normal; without that fallback a character standing dead flat on
   * a floor gets a zero-length normal and falls through.
   */
  overlapCapsule(p0x, p0y, p0z, p1x, p1y, p1z, radius, mask, contacts = this.contacts) {
    this.counters.overlaps++;
    contacts.count = 0;
    const mnx = Math.min(p0x, p1x) - radius, mny = Math.min(p0y, p1y) - radius, mnz = Math.min(p0z, p1z) - radius;
    const mxx = Math.max(p0x, p1x) + radius, mxy = Math.max(p0y, p1y) + radius, mxz = Math.max(p0z, p1z) + radius;
    const n = this._gather(mnx, mny, mnz, mxx, mxy, mxz, mask);
    if (n === 0) return contacts;

    const pos = this.pos, cl = this._cl, r2 = radius * radius;
    for (let i = 0; i < n; i++) {
      const tri = this._cand[i];
      const o = tri * 9;
      const d2 = segTriangleClosest(
        p0x, p0y, p0z, p1x, p1y, p1z,
        pos[o], pos[o + 1], pos[o + 2],
        pos[o + 3], pos[o + 4], pos[o + 5],
        pos[o + 6], pos[o + 7], pos[o + 8],
        cl
      );
      if (d2 >= r2) continue;

      let nx = cl.ax - cl.bx, ny = cl.ay - cl.by, nz = cl.az - cl.bz;
      const len = Math.sqrt(d2);
      const gnx = this.nrm[tri * 3], gny = this.nrm[tri * 3 + 1], gnz = this.nrm[tri * 3 + 2];
      let depth;

      if (len < 1e-5) {
        // The axis lies exactly in the triangle's plane. There is no closest-pair
        // direction; the face normal is the only meaningful answer.
        nx = gnx; ny = gny; nz = gnz;
        depth = radius;
      } else {
        nx /= len; ny /= len; nz /= len;
        if (nx * gnx + ny * gny + nz * gnz < -1e-3) {
          /*
           * BEHIND THE FACE. The closest-pair direction points INTO the solid,
           * which happens whenever a query sphere ends up on the back side of a
           * one-sided surface — and every dungeon floor is a one-sided surface.
           *
           * Returning that direction is not a small error, it inverts the
           * contact: the solver then pushes the body DOWN through the floor and
           * the impulse ACCELERATES it downwards, feeding energy in every step.
           * Measured symptom before this fix: a tumbling debris box locked into a
           * limit cycle at exactly the angular clamp (26 rad/s) and 4.7 m/s,
           * skating across the room forever and never sleeping.
           *
           * Trust the winding instead: push back out through the front face. The
           * -1e-3 threshold keeps legitimate edge and vertex contacts — where the
           * closest-pair direction is properly up to 90 degrees off the face
           * normal — from being misclassified by float noise.
           */
          nx = gnx; ny = gny; nz = gnz;
          depth = radius + len;
        } else {
          depth = radius - len;
        }
      }

      const c = contacts.count;
      if (c >= contacts.capacity) break;
      contacts.nx[c] = nx; contacts.ny[c] = ny; contacts.nz[c] = nz;
      contacts.px[c] = cl.bx; contacts.py[c] = cl.by; contacts.pz[c] = cl.bz;
      contacts.depth[c] = depth;
      contacts.s[c] = cl.s;
      contacts.tri[c] = tri;
      contacts.surface[c] = this.surface[tri];
      contacts.layer[c] = this.layer[tri];
      contacts.count = c + 1;
    }
    return contacts;
  }

  /** Sphere overlap — a degenerate capsule, but common enough to name. */
  overlapSphere(cx, cy, cz, radius, mask, contacts = this.contacts) {
    return this.overlapCapsule(cx, cy, cz, cx, cy, cz, radius, mask, contacts);
  }

  /**
   * Closest point on the static soup to a query point within `maxDist`.
   * Used by ragdoll bones (cheap per-particle resolve) and by the debug probe.
   * Writes out.b* / out.d2 and returns the triangle index or -1.
   */
  closestPoint(px, py, pz, maxDist, mask, out) {
    const n = this._gather(px - maxDist, py - maxDist, pz - maxDist,
                           px + maxDist, py + maxDist, pz + maxDist, mask);
    let best = maxDist * maxDist, bestTri = -1;
    const pos = this.pos, cl = this._cl;
    for (let i = 0; i < n; i++) {
      const tri = this._cand[i];
      const o = tri * 9;
      closestPtPointTriangle(
        px, py, pz,
        pos[o], pos[o + 1], pos[o + 2],
        pos[o + 3], pos[o + 4], pos[o + 5],
        pos[o + 6], pos[o + 7], pos[o + 8],
        cl
      );
      const ex = px - cl.bx, ey = py - cl.by, ez = pz - cl.bz;
      const d2 = ex * ex + ey * ey + ez * ez;
      if (d2 < best) {
        best = d2;
        bestTri = tri;
        out.bx = cl.bx; out.by = cl.by; out.bz = cl.bz;
      }
    }
    out.d2 = bestTri >= 0 ? best : Infinity;
    return bestTri;
  }

  /**
   * Box overlap, for AoE volumes and world-edit tools. Returns the number of
   * intersecting triangles and calls `cb(tri)` for each. `h*` are half-extents.
   */
  overlapBox(cx, cy, cz, hx, hy, hz, mask, cb) {
    const n = this._gather(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz, mask);
    const pos = this.pos;
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const tri = this._cand[i];
      const o = tri * 9;
      if (triAabb(
        cx, cy, cz, hx, hy, hz,
        pos[o], pos[o + 1], pos[o + 2],
        pos[o + 3], pos[o + 4], pos[o + 5],
        pos[o + 6], pos[o + 7], pos[o + 8]
      )) {
        hits++;
        if (cb) cb(tri);
      }
    }
    return hits;
  }

  /* ---------------------------------------------------------------- */
  /* Sweeps                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Swept capsule via conservative advancement.
   *
   * The naive formulation — "advance by the clearance to the nearest triangle" —
   * is what most tutorials show and it is BROKEN for a character controller. A
   * capsule standing on a floor has ~zero clearance to that floor at every
   * instant, so the advance is ~zero, the iteration cap is hit, and the sweep
   * returns "no hit" after travelling 3 cm. The character cannot walk.
   *
   * The fix is the real Mirtich bound. For two convex shapes under pure
   * translation, the closest-pair direction `n` is a separating axis; the
   * separation along it is the closest distance and it changes at exactly
   * `-(d · n)` per metre travelled. So:
   *
   *   - `d · n >= 0`  the shapes separate along a valid separating axis and can
   *                   NEVER intersect. Drop that triangle from the sweep. This is
   *                   exactly the floor-underfoot case, and dropping it is not an
   *                   approximation — it is provably correct.
   *   - `d · n <  0`  the earliest possible contact is `clearance / -(d · n)`.
   *                   Take the MINIMUM over all candidates and jump straight
   *                   there. Convergence is then quadratic-ish rather than a
   *                   crawl, and 48 iterations is generous.
   *
   * A capsule already touching something only reports a hit when it is moving
   * INTO it, which also makes the sweep safe to call while resting on geometry —
   * the controller depenetrates separately.
   *
   * Returns true on impact, writing t / point / normal / surface into `out`.
   */
  sweepCapsule(p0x, p0y, p0z, p1x, p1y, p1z, radius, dx, dy, dz, maxDist, mask, out) {
    clearHit(out);
    this.counters.sweeps++;
    if (this.nodeCount === 0 || maxDist <= 0) return false;

    // Swept AABB of the capsule over the whole motion, inflated by the radius.
    const ex = dx * maxDist, ey = dy * maxDist, ez = dz * maxDist;
    const mnx = Math.min(p0x, p1x, p0x + ex, p1x + ex) - radius;
    const mny = Math.min(p0y, p1y, p0y + ey, p1y + ey) - radius;
    const mnz = Math.min(p0z, p1z, p0z + ez, p1z + ez) - radius;
    const mxx = Math.max(p0x, p1x, p0x + ex, p1x + ex) + radius;
    const mxy = Math.max(p0y, p1y, p0y + ey, p1y + ey) + radius;
    const mxz = Math.max(p0z, p1z, p0z + ez, p1z + ez) + radius;
    const n = this._gather(mnx, mny, mnz, mxx, mxy, mxz, mask);
    if (n === 0) return false;

    const pos = this.pos, cand = this._cand, cl = this._cl;
    let t = 0;
    for (let iter = 0; iter < CA_ITERS; iter++) {
      const ax = p0x + dx * t, ay = p0y + dy * t, az = p0z + dz * t;
      const bx = p1x + dx * t, by = p1y + dy * t, bz = p1z + dz * t;

      let advance = Infinity;
      let hitTri = -1;
      let hnx = 0, hny = 0, hnz = 0, hpx = 0, hpy = 0, hpz = 0, hs = 0;

      for (let i = 0; i < n; i++) {
        const tri = cand[i];
        const o = tri * 9;
        const d2 = segTriangleClosest(
          ax, ay, az, bx, by, bz,
          pos[o], pos[o + 1], pos[o + 2],
          pos[o + 3], pos[o + 4], pos[o + 5],
          pos[o + 6], pos[o + 7], pos[o + 8],
          cl
        );

        // Contact normal: from the triangle point towards the capsule axis.
        let nx = cl.ax - cl.bx, ny = cl.ay - cl.by, nz = cl.az - cl.bz;
        const len = Math.sqrt(d2);
        if (len < 1e-6) {
          // Axis is in the triangle's plane (deep penetration): use the face
          // normal, oriented against the direction of travel.
          nx = this.nrm[tri * 3]; ny = this.nrm[tri * 3 + 1]; nz = this.nrm[tri * 3 + 2];
          if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
        } else {
          nx /= len; ny /= len; nz /= len;
        }

        const closing = -(dx * nx + dy * ny + dz * nz);
        const clearance = len - radius;

        if (clearance <= CA_TOL) {
          // Already touching. Only a blocking contact if we are moving into it;
          // otherwise this triangle is a floor we are sliding along, or a wall we
          // are peeling off, and it must not stop the sweep.
          if (closing > CA_MIN_CLOSING) {
            hitTri = tri;
            hnx = nx; hny = ny; hnz = nz;
            hpx = cl.bx; hpy = cl.by; hpz = cl.bz;
            hs = cl.s;
            advance = 0;
            break;
          }
          continue;
        }
        if (closing <= CA_MIN_CLOSING) continue; // provably unreachable

        const toi = clearance / closing;
        if (toi < advance) advance = toi;
      }

      if (hitTri >= 0) {
        out.hit = true;
        out.t = t;
        out.tri = hitTri;
        out.px = hpx; out.py = hpy; out.pz = hpz;
        out.nx = hnx; out.ny = hny; out.nz = hnz;
        out.surfaceId = this.surface[hitTri];
        out.surface = surfaceName(out.surfaceId);
        out.layer = this.layer[hitTri];
        out.object = this.object[hitTri];
        out.mesh = this.objects[out.object]?.mesh ?? null;
        out.kind = 'static';
        out.frontFace = true;
        // `contactS` is where along the capsule the contact sits — the character
        // controller uses it to tell a foot scrape from a head bump.
        out.contactS = hs;
        return true;
      }
      if (advance === Infinity) return false; // nothing on this path can be hit
      // Always make progress: a numerically stubborn grazing contact must not
      // spin the loop even though the bound above says it cannot.
      t += Math.max(advance, CA_TOL);
      if (t >= maxDist) return false;
    }
    return false;
  }

  /** Swept sphere — a capsule with a zero-length axis. */
  sweepSphere(cx, cy, cz, radius, dx, dy, dz, maxDist, mask, out) {
    return this.sweepCapsule(cx, cy, cz, cx, cy, cz, radius, dx, dy, dz, maxDist, mask, out);
  }

  /* ---------------------------------------------------------------- */

  stats() {
    return {
      tris: this.triCount,
      nodes: this.nodeCount,
      leaves: this.leafCount,
      maxDepth: this.maxDepth,
      objects: this.objectCount,
      buildMs: +this.buildMs.toFixed(2),
      version: this.version,
      candOverflow: this._candOverflow,
      bounds: [
        +this.aabb.minx.toFixed(1), +this.aabb.miny.toFixed(1), +this.aabb.minz.toFixed(1),
        +this.aabb.maxx.toFixed(1), +this.aabb.maxy.toFixed(1), +this.aabb.maxz.toFixed(1),
      ],
    };
  }

  dispose() {
    this.clear();
    this.pos = new Float32Array(0);
    this.nrm = new Float32Array(0);
    this.surface = new Uint8Array(0);
    this.layer = new Uint16Array(0);
    this.object = new Int32Array(0);
    this.triIndex = new Uint32Array(0);
    this.nodeBounds = new Float32Array(0);
    this.nodeMeta = new Int32Array(0);
    this._cent = new Float32Array(0);
    this._taabb = new Float32Array(0);
    this.nodeCount = 0;
    this.triCount = 0;
  }
}

function surfaceArea(dx, dy, dz) {
  if (dx < 0 || dy < 0 || dz < 0) return 0;
  return 2 * (dx * dy + dy * dz + dz * dx);
}
