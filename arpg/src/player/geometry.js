import * as THREE from 'three';

/**
 * MONARCH — procedural skinned-mesh construction kit.
 *
 * There are no model files in this project, so the hero is generated from
 * parametric surfaces. This module is the vocabulary that makes that tractable:
 * four primitives (`patch`, `tube`, `shell`, `fan`) plus an automatic skinner,
 * and every piece of armour in character.js is one of those four.
 *
 * ---------------------------------------------------------------------------
 * THE TWO CONVENTIONS THAT MATTER
 *
 * 1. **Everything is authored in bind-world space** — the same space the rig
 *    declares its bones in. A pauldron is placed at the shoulder's actual
 *    coordinates, not at a local origin plus a transform. Combined with
 *    auto-skinning this means a proportion change in rig.js moves the armour
 *    with it instead of desynchronising from it.
 *
 * 2. **UVs are in metres.** `materials` calibrates every surface's texel density
 *    on that assumption (see its UV convention note), so a 0.3 m pauldron gets
 *    0.3 UV units and lands at the same texel density as a 4 m wall. Every
 *    primitive here computes UVs by accumulating real arc length; none of them
 *    normalise to 0..1.
 *
 * ---------------------------------------------------------------------------
 * AUTOMATIC SKINNING
 *
 * Hand-authoring 4 weights for ~9 000 vertices is not possible, and per-part
 * rigid binding gives a marionette. Instead each vertex is weighted by its
 * distance to the *segment* of each candidate bone, normalised by that bone's
 * influence radius:
 *
 *     w_i = ( max(eps, d_i / r_i) ) ^ -power
 *
 * then the best four are kept and normalised. Restricting the candidate set per
 * body part is what makes this work at all: without it the coat's front panel
 * picks up the thigh bones (they are 6 cm away) and the hem scissors open when
 * the hero runs. With it, the coat is weighted only to the coat chains and the
 * pelvis, and behaves like cloth hung from a belt.
 *
 * `power` is the hardness dial. 2.0 gives a soft, rubbery blend suited to cloth;
 * 5.0 is nearly rigid and is what plate armour wants.
 */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();

/** Squared distance from point p to the segment a→b, plus the closest param. */
function distToSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom > 1e-9 ? (apx * abx + apy * aby + apz * abz) / denom : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class SkinBuilder {
  /**
   * @param {import('./rig.js').Rig} rig
   * @param {string} name  used for the geometry name, which shows up in
   *                       renderer.info and in a devtools scene dump
   */
  constructor(rig, name) {
    this.rig = rig;
    this.name = name;

    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
    /** Parallel to the vertex list: which candidate set that vertex used. */
    this.bindGroup = [];

    /** Candidate sets, interned so the skinner solves each vertex against a
     *  small Int32Array rather than re-resolving names. */
    this._groups = [];
    this._group = -1;

    this._uOffset = 0;
    this._vOffset = 0;
  }

  // =========================================================================
  // binding
  // =========================================================================

  /**
   * Select the candidate bones for everything submitted from now on.
   * @param {string[]} names   bone names; a trailing `*` matches a prefix
   * @param {number} power     falloff hardness, see the module docblock
   */
  bindTo(names, power = 3.0) {
    const ids = this.rig.ids(...names);
    this._group = this._groups.length;
    this._groups.push({ ids: Int32Array.from(ids), power, rigid: -1 });
    return this;
  }

  /** Hard-bind everything from now on to a single bone. Plate does not bend. */
  rigidTo(name) {
    this._group = this._groups.length;
    this._groups.push({ ids: null, power: 1, rigid: this.rig.id(name) });
    return this;
  }

  /** Shift subsequent UVs, so two parts sharing a material do not overlap in
   *  the (unused, but debuggable) UV atlas and so overlays vary between them. */
  uvOrigin(u, v) {
    this._uOffset = u;
    this._vOffset = v;
    return this;
  }

  // =========================================================================
  // raw submission
  // =========================================================================

  vertex(px, py, pz, nx, ny, nz, u, v) {
    const i = this.pos.length / 3;
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u + this._uOffset, v + this._vOffset);
    this.bindGroup.push(this._group);
    return i;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }

  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  get vertexCount() { return this.pos.length / 3; }

  // =========================================================================
  // primitives
  // =========================================================================

  /**
   * A parametric surface sampled on a (rows+1) x (cols+1) grid.
   *
   * `fn(u, v, out)` receives u,v in 0..1 and writes a position into `out`.
   * Normals come from central differences on the generated grid rather than
   * from an analytic derivative: it costs nothing extra, it is exact for the
   * shapes here, and it means a generator function can be edited without also
   * having to differentiate it by hand.
   *
   * @param {object} o
   *   rows, cols     grid resolution
   *   fn             (u, v, out) => void
   *   closeU         wrap the u direction (a tube of revolution)
   *   flip           reverse winding + normals (inner surfaces of a shell)
   *   skipStartRow / skipEndRow  do not emit the degenerate row at a pole
   * @returns {{ first:number, cols:number, rows:number, at:(iu,iv)=>number }}
   *   Index accessor, so a caller can stitch a rim onto the boundary.
   */
  patch(o) {
    const rows = o.rows, cols = o.cols;
    const closeU = !!o.closeU;
    const flip = !!o.flip;
    const nu = closeU ? cols : cols + 1;
    const nv = rows + 1;

    // 1. positions
    const P = new Float64Array(nu * nv * 3);
    for (let iv = 0; iv < nv; iv++) {
      const v = iv / rows;
      for (let iu = 0; iu < nu; iu++) {
        const u = iu / cols;
        o.fn(u, v, _v0);
        const k = (iv * nu + iu) * 3;
        P[k] = _v0.x; P[k + 1] = _v0.y; P[k + 2] = _v0.z;
      }
    }

    // 2. UVs by accumulated arc length, in metres.
    const U = new Float64Array(nu * nv);
    const V = new Float64Array(nu * nv);
    for (let iv = 0; iv < nv; iv++) {
      let acc = 0;
      for (let iu = 0; iu < nu; iu++) {
        if (iu > 0) {
          const a = (iv * nu + iu - 1) * 3, b = (iv * nu + iu) * 3;
          acc += Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
        }
        U[iv * nu + iu] = acc;
      }
    }
    for (let iu = 0; iu < nu; iu++) {
      let acc = 0;
      for (let iv = 0; iv < nv; iv++) {
        if (iv > 0) {
          const a = ((iv - 1) * nu + iu) * 3, b = (iv * nu + iu) * 3;
          acc += Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
        }
        V[iv * nu + iu] = acc;
      }
    }

    // 3. normals by central difference, with a fallback at degenerate poles.
    const base = this.vertexCount;
    const sgn = flip ? -1 : 1;
    for (let iv = 0; iv < nv; iv++) {
      for (let iu = 0; iu < nu; iu++) {
        const k = (iv * nu + iu) * 3;
        const iuA = closeU ? (iu + nu - 1) % nu : Math.max(0, iu - 1);
        const iuB = closeU ? (iu + 1) % nu : Math.min(nu - 1, iu + 1);
        const ivA = Math.max(0, iv - 1);
        const ivB = Math.min(nv - 1, iv + 1);
        const ka = (iv * nu + iuA) * 3, kb = (iv * nu + iuB) * 3;
        const kc = (ivA * nu + iu) * 3, kd = (ivB * nu + iu) * 3;
        _n0.set(P[kb] - P[ka], P[kb + 1] - P[ka + 1], P[kb + 2] - P[ka + 2]);
        _n1.set(P[kd] - P[kc], P[kd + 1] - P[kc + 1], P[kd + 2] - P[kc + 2]);
        _v1.crossVectors(_n1, _n0);
        if (_v1.lengthSq() < 1e-14) {
          // Degenerate: a pole row, or a zero-radius ring. Borrow the normal
          // from the neighbouring row, which is always well defined.
          const iv2 = iv === 0 ? 1 : iv - 1;
          const k2 = (iv2 * nu + iu) * 3;
          _v1.set(P[k] - P[k2], P[k + 1] - P[k2 + 1], P[k + 2] - P[k2 + 2]);
          if (_v1.lengthSq() < 1e-14) _v1.set(0, 1, 0);
        }
        _v1.normalize().multiplyScalar(sgn);
        this.vertex(P[k], P[k + 1], P[k + 2], _v1.x, _v1.y, _v1.z,
          U[iv * nu + iu], V[iv * nu + iu]);
      }
    }

    // 4. faces
    const at = (iu, iv) => base + iv * nu + (closeU ? ((iu % nu) + nu) % nu : iu);
    const iuMax = closeU ? nu : nu - 1;
    for (let iv = 0; iv < nv - 1; iv++) {
      if (o.skipStartRow && iv === 0) continue;
      if (o.skipEndRow && iv === nv - 2) continue;
      for (let iu = 0; iu < iuMax; iu++) {
        const a = at(iu, iv), b = at(iu + 1, iv), c = at(iu + 1, iv + 1), d = at(iu, iv + 1);
        if (flip) this.quad(a, d, c, b);
        else this.quad(a, b, c, d);
      }
    }

    return { first: base, nu, nv, at };
  }

  /**
   * A swept tube along a polyline, with a parallel-transport frame.
   *
   * Parallel transport rather than a Frenet frame: a Frenet frame flips through
   * 180° at an inflection point (every hair spike has one) and the UV seam
   * visibly twists. Parallel transport carries the previous ring's frame
   * forward through the minimal rotation, so a tube never twists unless asked.
   *
   * @param {object} o
   *   path     [[x,y,z], ...]        at least 2 points
   *   radius   number | (t, i) => number | [number, ...]
   *   radial   segments around
   *   squash   (t) => number         multiplies the frame's binormal axis, for
   *                                  elliptical cross-sections (a torso)
   *   roll     (t) => radians
   *   capStart / capEnd
   */
  tube(o) {
    const path = o.path;
    const n = path.length;
    const radial = o.radial ?? 10;
    const radiusOf = typeof o.radius === 'function'
      ? o.radius
      : Array.isArray(o.radius) ? (t, i) => o.radius[i] : () => o.radius;

    // Tangents, one per ring, averaged at interior points so the tube does not
    // pinch at a kink.
    const T = [];
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      T.push(new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize());
    }

    // Seed the frame with whichever world axis is least parallel to T0.
    const t0 = T[0];
    const seed = Math.abs(t0.y) < 0.9 ? _v2.set(0, 1, 0) : _v2.set(0, 0, 1);
    const N = [new THREE.Vector3().crossVectors(seed, t0).normalize()];
    const B = [new THREE.Vector3().crossVectors(t0, N[0]).normalize()];
    const q = new THREE.Quaternion();
    for (let i = 1; i < n; i++) {
      q.setFromUnitVectors(T[i - 1], T[i]);
      N.push(N[i - 1].clone().applyQuaternion(q).normalize());
      B.push(new THREE.Vector3().crossVectors(T[i], N[i]).normalize());
    }

    const base = this.vertexCount;
    const nu = radial;
    const vAcc = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      vAcc[i] = vAcc[i - 1] + Math.hypot(
        path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]
      );
    }

    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      const r = radiusOf(t, i);
      const sq = o.squash ? o.squash(t) : 1;
      const roll = o.roll ? o.roll(t) : 0;
      let uAcc = 0;
      for (let j = 0; j < nu; j++) {
        const a = (j / nu) * Math.PI * 2 + roll;
        const ca = Math.cos(a), sa = Math.sin(a);
        // Ellipse in the (N, B) plane. The normal of an ellipse is not the
        // radial direction, so it is built from the same parameterisation
        // scaled by the RECIPROCAL semi-axes — the standard implicit normal.
        _v0.set(0, 0, 0)
          .addScaledVector(N[i], ca * r)
          .addScaledVector(B[i], sa * r * sq);
        _v1.set(0, 0, 0)
          .addScaledVector(N[i], ca / Math.max(1e-4, r))
          .addScaledVector(B[i], sa / Math.max(1e-4, r * sq))
          .normalize();
        const px = path[i][0] + _v0.x, py = path[i][1] + _v0.y, pz = path[i][2] + _v0.z;
        if (j > 0) uAcc += (Math.PI * 2 / nu) * r * (0.5 + 0.5 * sq);
        this.vertex(px, py, pz, _v1.x, _v1.y, _v1.z, uAcc, vAcc[i]);
      }
    }

    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < nu; j++) {
        const j2 = (j + 1) % nu;
        this.quad(base + i * nu + j, base + i * nu + j2,
          base + (i + 1) * nu + j2, base + (i + 1) * nu + j);
      }
    }

    if (o.capStart) this._cap(path[0], T[0], base, nu, true);
    if (o.capEnd) this._cap(path[n - 1], T[n - 1], base + (n - 1) * nu, nu, false);

    return { first: base, nu, rings: n };
  }

  /** Triangle fan closing one end of a tube. */
  _cap(centre, tangent, ringFirst, nu, isStart) {
    const s = isStart ? -1 : 1;
    const c = this.vertex(centre[0], centre[1], centre[2],
      tangent.x * s, tangent.y * s, tangent.z * s, 0, 0);
    for (let j = 0; j < nu; j++) {
      const j2 = (j + 1) % nu;
      if (isStart) this.tri(c, ringFirst + j, ringFirst + j2);
      else this.tri(c, ringFirst + j2, ringFirst + j);
    }
  }

  /**
   * A solid plate: an outer surface, an inner surface offset along -normal, and
   * a rim stitching their boundaries. This is how every piece of plate armour on
   * the hero is made — a pauldron is a curved shell, not a box, and the rim is
   * what catches the brazier light and gives it an edge.
   *
   * `inner` may be a different SkinBuilder (different material) — the coat uses
   * that to put violet lining on the inside of black cloth.
   *
   * @param {object} o   as `patch`, plus:
   *   thickness   metres between the two surfaces
   *   inner       SkinBuilder for the back face (defaults to this)
   *   rim         SkinBuilder for the edge strip (defaults to this)
   *   rimEdges    which boundaries to close: 'all' | 'uv' | 'v' | 'none'
   */
  shell(o) {
    const inner = o.inner ?? this;
    const rim = o.rim ?? this;
    const th = o.thickness ?? 0.02;
    const rows = o.rows, cols = o.cols, closeU = !!o.closeU;
    const nu = closeU ? cols : cols + 1;
    const nv = rows + 1;

    // Sample once, keep both offsets, so the two surfaces are guaranteed to be
    // exactly parallel (re-evaluating fn twice with a normal estimate each time
    // leaves a visible sliver at the rim).
    const P = new Float64Array(nu * nv * 3);
    const Nrm = new Float64Array(nu * nv * 3);
    for (let iv = 0; iv < nv; iv++) {
      for (let iu = 0; iu < nu; iu++) {
        o.fn(iu / cols, iv / rows, _v0);
        const k = (iv * nu + iu) * 3;
        P[k] = _v0.x; P[k + 1] = _v0.y; P[k + 2] = _v0.z;
      }
    }
    for (let iv = 0; iv < nv; iv++) {
      for (let iu = 0; iu < nu; iu++) {
        const iuA = closeU ? (iu + nu - 1) % nu : Math.max(0, iu - 1);
        const iuB = closeU ? (iu + 1) % nu : Math.min(nu - 1, iu + 1);
        const ivA = Math.max(0, iv - 1), ivB = Math.min(nv - 1, iv + 1);
        const ka = (iv * nu + iuA) * 3, kb = (iv * nu + iuB) * 3;
        const kc = (ivA * nu + iu) * 3, kd = (ivB * nu + iu) * 3;
        _n0.set(P[kb] - P[ka], P[kb + 1] - P[ka + 1], P[kb + 2] - P[ka + 2]);
        _n1.set(P[kd] - P[kc], P[kd + 1] - P[kc + 1], P[kd + 2] - P[kc + 2]);
        _v1.crossVectors(_n1, _n0);
        if (_v1.lengthSq() < 1e-14) _v1.set(0, 1, 0);
        _v1.normalize();
        const k = (iv * nu + iu) * 3;
        Nrm[k] = _v1.x; Nrm[k + 1] = _v1.y; Nrm[k + 2] = _v1.z;
      }
    }

    const half = th * 0.5;
    const sample = (sign) => (u, v, out) => {
      const iu = Math.round(u * cols) % (closeU ? nu : nu + 1);
      const iv = Math.round(v * rows);
      const k = (Math.min(nv - 1, iv) * nu + Math.min(nu - 1, iu)) * 3;
      out.set(P[k] + Nrm[k] * half * sign, P[k + 1] + Nrm[k + 1] * half * sign,
        P[k + 2] + Nrm[k + 2] * half * sign);
    };

    const outRef = this.patch({ rows, cols, closeU, fn: sample(1) });
    const inRef = inner.patch({ rows, cols, closeU, fn: sample(-1), flip: true });

    // Rim. `uv` closes only the two v-boundaries (the top and bottom edge of a
    // band); `all` also closes the u-boundaries of an open patch.
    const mode = o.rimEdges ?? (closeU ? 'v' : 'all');
    if (mode !== 'none') {
      const outFirst = outRef.first, inFirst = inRef.first;
      const edge = (iu0, iv0, iu1, iv1) => {
        const oA = outFirst + iv0 * nu + iu0, oB = outFirst + iv1 * nu + iu1;
        const iA = inFirst + iv0 * nu + iu0, iB = inFirst + iv1 * nu + iu1;
        rim._rimQuad(this, inner, oA, oB, iB, iA);
      };
      const uEnd = closeU ? nu : nu - 1;
      if (mode === 'v' || mode === 'uv' || mode === 'all') {
        for (let iu = 0; iu < uEnd; iu++) {
          const iu2 = (iu + 1) % nu;
          edge(iu2, 0, iu, 0);
          edge(iu, nv - 1, iu2, nv - 1);
        }
      }
      if (mode === 'all' && !closeU) {
        for (let iv = 0; iv < nv - 1; iv++) {
          edge(0, iv, 0, iv + 1);
          edge(nu - 1, iv + 1, nu - 1, iv);
        }
      }
    }

    return { outer: outRef, inner: inRef };
  }

  /**
   * Emit one rim quad by copying four vertices out of the (possibly different)
   * builders that own the outer and inner surfaces. Copied rather than indexed
   * because the rim needs its OWN normal — sharing the surface vertices would
   * smooth the edge away, and a plate armour edge that is not sharp reads as
   * plastic.
   */
  _rimQuad(outerB, innerB, oA, oB, iB, iA) {
    const g = (b, i, o) => o.set(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]);
    g(outerB, oA, _v0); g(outerB, oB, _v1); g(innerB, iB, _v2); g(innerB, iA, _v3);
    _n0.subVectors(_v1, _v0);
    _n1.subVectors(_v3, _v0);
    const nx = _n0.y * _n1.z - _n0.z * _n1.y;
    const ny = _n0.z * _n1.x - _n0.x * _n1.z;
    const nz = _n0.x * _n1.y - _n0.y * _n1.x;
    const l = Math.hypot(nx, ny, nz) || 1;
    const w = _v0.distanceTo(_v1), h = _v0.distanceTo(_v3);
    const a = this.vertex(_v0.x, _v0.y, _v0.z, nx / l, ny / l, nz / l, 0, 0);
    const b = this.vertex(_v1.x, _v1.y, _v1.z, nx / l, ny / l, nz / l, w, 0);
    const c = this.vertex(_v2.x, _v2.y, _v2.z, nx / l, ny / l, nz / l, w, h);
    const d = this.vertex(_v3.x, _v3.y, _v3.z, nx / l, ny / l, nz / l, 0, h);
    this.quad(a, b, c, d);
  }

  /**
   * A flat, hard-edged polygon fan — belt buckles, sigil plates, the emissive
   * trim strips. `points` is a closed 2D loop in the plane spanned by `ex`/`ey`
   * about `origin`.
   */
  fan(origin, ex, ey, points, normalSign = 1) {
    _v1.crossVectors(ex, ey).normalize().multiplyScalar(normalSign);
    const idx = [];
    for (const [a, bb] of points) {
      _v0.copy(origin).addScaledVector(ex, a).addScaledVector(ey, bb);
      idx.push(this.vertex(_v0.x, _v0.y, _v0.z, _v1.x, _v1.y, _v1.z, a, bb));
    }
    for (let i = 1; i < idx.length - 1; i++) {
      if (normalSign > 0) this.tri(idx[0], idx[i], idx[i + 1]);
      else this.tri(idx[0], idx[i + 1], idx[i]);
    }
    return idx;
  }

  /**
   * A thin extruded ribbon following a 3D polyline, used for the emissive trim
   * that runs along the pauldron rims and down the coat. Two quads wide so the
   * strip has a lit face and a rolled edge, which is what makes a 6 mm line
   * still read at 89 px tall — a flat quad at that size vanishes into the
   * silhouette.
   */
  ribbon(pathPts, width, lift, normalHint) {
    const n = pathPts.length;
    const base = this.vertexCount;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const a = pathPts[Math.max(0, i - 1)], b = pathPts[Math.min(n - 1, i + 1)];
      _v0.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      _v1.copy(normalHint[i] ? _v3.fromArray(normalHint[i]) : _v3.set(0, 1, 0)).normalize();
      _v2.crossVectors(_v0, _v1).normalize().multiplyScalar(width * 0.5);
      if (i > 0) {
        acc += Math.hypot(pathPts[i][0] - pathPts[i - 1][0],
          pathPts[i][1] - pathPts[i - 1][1], pathPts[i][2] - pathPts[i - 1][2]);
      }
      const cx = pathPts[i][0] + _v1.x * lift;
      const cy = pathPts[i][1] + _v1.y * lift;
      const cz = pathPts[i][2] + _v1.z * lift;
      this.vertex(cx - _v2.x, cy - _v2.y, cz - _v2.z, _v1.x, _v1.y, _v1.z, 0, acc);
      this.vertex(cx + _v2.x, cy + _v2.y, cz + _v2.z, _v1.x, _v1.y, _v1.z, width, acc);
    }
    for (let i = 0; i < n - 1; i++) {
      this.quad(base + i * 2, base + i * 2 + 1, base + (i + 1) * 2 + 1, base + (i + 1) * 2);
    }
    return base;
  }

  // =========================================================================
  // finish
  // =========================================================================

  /**
   * Solve skin weights and produce the BufferGeometry.
   *
   * Weight solving happens once, at load, over every vertex. It is O(V * B) with
   * B the candidate count (never more than 14), so ~120 000 distance tests for
   * the whole hero — a couple of milliseconds.
   */
  build() {
    const V = this.vertexCount;
    if (V === 0) return null;

    const rig = this.rig;
    const si = new Uint16Array(V * 4);
    const sw = new Float32Array(V * 4);

    // Scratch for the top-4 selection. Reused across vertices.
    const bestI = new Int32Array(4);
    const bestW = new Float64Array(4);

    for (let v = 0; v < V; v++) {
      const g = this._groups[this.bindGroup[v]];
      if (!g) { si[v * 4] = 0; sw[v * 4] = 1; continue; }

      if (g.rigid >= 0) {
        si[v * 4] = g.rigid;
        sw[v * 4] = 1;
        continue;
      }

      const px = this.pos[v * 3], py = this.pos[v * 3 + 1], pz = this.pos[v * 3 + 2];
      bestI[0] = bestI[1] = bestI[2] = bestI[3] = 0;
      bestW[0] = bestW[1] = bestW[2] = bestW[3] = 0;

      for (let k = 0; k < g.ids.length; k++) {
        const bi = g.ids[k];
        const d = distToSegment(px, py, pz,
          rig.bindHead[bi * 3], rig.bindHead[bi * 3 + 1], rig.bindHead[bi * 3 + 2],
          rig.bindTail[bi * 3], rig.bindTail[bi * 3 + 1], rig.bindTail[bi * 3 + 2]);
        const nd = Math.max(0.02, d / rig.bindRadius[bi]);
        const w = Math.pow(nd, -g.power);
        // Insertion into a 4-slot descending list.
        if (w <= bestW[3]) continue;
        let s = 3;
        while (s > 0 && bestW[s - 1] < w) { bestW[s] = bestW[s - 1]; bestI[s] = bestI[s - 1]; s--; }
        bestW[s] = w; bestI[s] = bi;
      }

      const sum = bestW[0] + bestW[1] + bestW[2] + bestW[3];
      if (sum <= 0) { si[v * 4] = g.ids[0] ?? 0; sw[v * 4] = 1; continue; }
      for (let s = 0; s < 4; s++) {
        si[v * 4 + s] = bestI[s];
        sw[v * 4 + s] = bestW[s] / sum;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.name = `mn.player.${this.name}`;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    geo.setIndex(V > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    geo.computeBoundingSphere();
    // The bind-pose bounds are wrong the moment the coat billows. A generous
    // manual sphere keeps `frustumCulled` honest without a per-frame recompute.
    geo.boundingSphere.center.set(0, 1.0, 0);
    geo.boundingSphere.radius = 1.9;
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1.1, -0.4, -1.1), new THREE.Vector3(1.1, 2.4, 1.1)
    );
    return geo;
  }
}

/**
 * Superellipse radius: |cos|^(2/n) style rounding that turns a circle into a
 * rounded rectangle as `n` grows. Torsos, vambraces and greaves are all closer
 * to a rounded box than to a cylinder, and a plain cylinder is the single
 * clearest tell that a character was generated rather than modelled.
 */
export function superEllipse(angle, n) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = Math.pow(Math.pow(Math.abs(c), n) + Math.pow(Math.abs(s), n), -1 / n);
  return k;
}

/** Smoothstep, used everywhere a profile has to ease rather than kink. */
export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}

/** Catmull-Rom through a list of scalars — profile curves for limbs. */
export function curve(values, t) {
  const n = values.length - 1;
  const x = Math.min(0.9999, Math.max(0, t)) * n;
  const i = Math.floor(x);
  const f = x - i;
  const p0 = values[Math.max(0, i - 1)];
  const p1 = values[i];
  const p2 = values[Math.min(n, i + 1)];
  const p3 = values[Math.min(n, i + 2)];
  return 0.5 * ((2 * p1) + (-p0 + p2) * f +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
    (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}
