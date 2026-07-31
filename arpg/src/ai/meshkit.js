import * as THREE from 'three';

/**
 * MONARCH — `ai`'s procedural skinned-mesh kit.
 *
 * There are no model files in this project, so every enemy is generated from
 * parametric surfaces at load. This module is the vocabulary that makes that
 * tractable: five primitives (`patch`, `tube`, `shell`, `plate`, `spike`) plus
 * an automatic skinner.
 *
 * `player` has its own copy of a kit like this one. That duplication is
 * deliberate and required: ARCHITECTURE.md forbids importing another
 * subsystem's module, and the two kits have genuinely diverged — this one has
 * no cloth-lining support and does have the spike/claw primitives and the
 * per-part `damage()` deformation that enemy bodies need.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CONVENTIONS THAT MATTER
 *
 * 1. **Everything is authored in bind-world space**, the same space the rig
 *    declares its bones in. A pauldron is placed at the shoulder's actual
 *    coordinates. A proportion change in the rig therefore moves the armour
 *    with it instead of desynchronising from it.
 *
 * 2. **UVs are in metres.** `materials` calibrates every surface's texel
 *    density on that assumption, so a 0.3 m pauldron gets 0.3 UV units and
 *    lands at the same texel density as a 4 m wall. Every primitive here
 *    accumulates real arc length; none of them normalise to 0..1.
 *
 * 3. **Geometry is shared between actors, skeletons are not.** A `SkinnedMesh`
 *    binds a skeleton to a geometry at draw time, so twenty ghouls are twenty
 *    skeletons and ONE geometry. That is what makes forty actors affordable:
 *    the vertex data is built once per archetype, at load.
 *
 * ---------------------------------------------------------------------------
 * AUTOMATIC SKINNING
 *
 * Each vertex is weighted by its distance to the *segment* of each candidate
 * bone, normalised by that bone's influence radius:
 *
 *     w_i = ( max(eps, d_i / r_i) ) ^ -power
 *
 * then the best four are kept and normalised. Restricting the candidate set per
 * body part is what makes this work at all: without it a ghoul's dangling rags
 * pick up the thigh bones (they are 5 cm away) and the hem scissors open when
 * it walks. `power` is the hardness dial — 2.0 is rubbery cloth, 5.0 is plate.
 */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();

/** Distance from point p to the segment a→b. */
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
   * @param {string} name  shows up in renderer.info and a devtools scene dump
   */
  constructor(rig, name) {
    this.rig = rig;
    this.name = name;

    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
    this.bindGroup = [];

    this._groups = [];
    this._group = -1;
    this._uOffset = 0;
    this._vOffset = 0;

    /**
     * A deterministic per-builder noise source for surface irregularity.
     * ARCHITECTURE.md rule 4: no Math.random. This is a hash of the vertex
     * position, so the same body always warps the same way, and two ghouls
     * built with different `warpSeed` values warp differently.
     */
    this.warpSeed = 0;
    this.warp = 0;

    /**
     * Multiplier applied to every UV in `build()`.
     *
     * `materials` calibrates texel density on the assumption that UVs are in
     * METRES, and its own materials carry that scale in a uniform. This
     * subsystem builds its own MeshStandardMaterials from the raw baked maps
     * instead (see `materials.js` here for why), so the scale has to live in
     * the mesh — setting `.repeat` on the shared textures would re-scale every
     * wall in the level. Set to `1 / tileMetres` per material family.
     */
    this.uvScale = 1;
  }

  // =========================================================================
  // binding
  // =========================================================================

  /**
   * Select the candidate bones for everything submitted from now on.
   * @param {string[]} names   bone names; a trailing `*` matches a prefix
   * @param {number} power     falloff hardness
   */
  bindTo(names, power = 3.0) {
    const ids = this.rig.ids(...names);
    this._group = this._groups.length;
    this._groups.push({ ids: Int32Array.from(ids), power, rigid: -1 });
    return this;
  }

  /** Hard-bind everything from now on to one bone. Plate does not bend. */
  rigidTo(name) {
    this._group = this._groups.length;
    this._groups.push({ ids: null, power: 1, rigid: this.rig.id(name) });
    return this;
  }

  uvOrigin(u, v) { this._uOffset = u; this._vOffset = v; return this; }

  /** Turn on positional noise for everything submitted from now on. Amount is
   *  in metres. This is the "nothing perfectly straight" rule made mechanical:
   *  a limb built from a clean tube reads as a machine part. */
  setWarp(amount, seed = 0) {
    this.warp = amount;
    this.warpSeed = seed;
    return this;
  }

  /** Hash-noise in [-1,1] from a world position. Cheap, stable, seedable. */
  _noise(x, y, z, channel) {
    let h = (this.warpSeed * 374761393 + channel * 668265263) >>> 0;
    h = (h + Math.imul(Math.round(x * 97), 2246822519)) >>> 0;
    h = (h + Math.imul(Math.round(y * 97), 3266489917)) >>> 0;
    h = (h + Math.imul(Math.round(z * 97), 668265263)) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
    return (h >>> 0) / 2147483648 - 1;
  }

  // =========================================================================
  // raw submission
  // =========================================================================

  vertex(px, py, pz, nx, ny, nz, u, v) {
    const i = this.pos.length / 3;
    if (this.warp > 0) {
      px += this._noise(px, py, pz, 1) * this.warp;
      py += this._noise(px, py, pz, 2) * this.warp * 0.7;
      pz += this._noise(px, py, pz, 3) * this.warp;
    }
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
   * A parametric surface on a (rows+1) × (cols+1) grid.
   *
   * Normals come from central differences on the generated grid rather than
   * from an analytic derivative: it is exact for the shapes here and means a
   * generator function can be edited without differentiating it by hand.
   */
  patch(o) {
    const rows = o.rows, cols = o.cols;
    const closeU = !!o.closeU;
    const flip = !!o.flip;
    const nu = closeU ? cols : cols + 1;
    const nv = rows + 1;

    const P = new Float64Array(nu * nv * 3);
    for (let iv = 0; iv < nv; iv++) {
      const v = iv / rows;
      for (let iu = 0; iu < nu; iu++) {
        o.fn(iu / cols, v, _v0);
        const k = (iv * nu + iu) * 3;
        P[k] = _v0.x; P[k + 1] = _v0.y; P[k + 2] = _v0.z;
      }
    }

    // UVs by accumulated arc length, in metres.
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

    const at = (iu, iv) => base + iv * nu + (closeU ? ((iu % nu) + nu) % nu : iu);
    const iuMax = closeU ? nu : nu - 1;
    for (let iv = 0; iv < nv - 1; iv++) {
      if (o.skipStartRow && iv === 0) continue;
      if (o.skipEndRow && iv === nv - 2) continue;
      for (let iu = 0; iu < iuMax; iu++) {
        const a = at(iu, iv), b = at(iu + 1, iv), c = at(iu + 1, iv + 1), d = at(iu, iv + 1);
        // WINDING. Three renders the face whose projected winding is
        // counter-clockwise, i.e. the side that (b−a)×(c−a) points toward. For
        // the quad above that expression is dU × dV, while the shading normal
        // computed thirty lines up is dV × dU — the OPPOSITE side. Emitting
        // (a,b,c,d) therefore back-face-culls every surface from the side its
        // own normals face.
        //
        // This is not a hypothetical: it cost a full capture cycle. Every
        // torso, skull, helm and robe in `bodies.js` is a `patch`, every limb
        // is a `tube` (whose analytic normals happen to agree with its
        // winding), and the boss shot came back as a set of disembodied arms
        // and legs standing in an empty telegraph.
        if (flip) this.quad(a, b, c, d);
        else this.quad(a, d, c, b);
      }
    }
    return { first: base, nu, nv, at };
  }

  /**
   * A swept tube along a polyline, with a parallel-transport frame.
   *
   * Parallel transport rather than Frenet: a Frenet frame flips through 180° at
   * an inflection point (every arched spine has one) and the UV seam visibly
   * twists. Parallel transport carries the previous ring's frame forward through
   * the minimal rotation, so a tube never twists unless asked.
   *
   * @param o  path, radius (number|array|fn), radial, squash(t), roll(t),
   *           capStart, capEnd, profile(t) → per-ring scale in the frame's
   *           binormal only (a limb is an ellipse, not a cylinder)
   */
  tube(o) {
    const path = o.path;
    const n = path.length;
    const radial = o.radial ?? 8;
    const radiusOf = typeof o.radius === 'function'
      ? o.radius
      : Array.isArray(o.radius) ? (t, i) => o.radius[i] : () => o.radius;

    const T = [];
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      const t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (t.lengthSq() < 1e-12) t.set(0, -1, 0);
      T.push(t.normalize());
    }

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
        _v0.set(0, 0, 0)
          .addScaledVector(N[i], ca * r)
          .addScaledVector(B[i], sa * r * sq);
        // The normal of an ellipse is not the radial direction; it is built from
        // the same parameterisation scaled by the RECIPROCAL semi-axes.
        _v1.set(0, 0, 0)
          .addScaledVector(N[i], ca / Math.max(1e-4, r))
          .addScaledVector(B[i], sa / Math.max(1e-4, r * sq))
          .normalize();
        if (j > 0) uAcc += (Math.PI * 2 / nu) * r * (0.5 + 0.5 * sq);
        this.vertex(path[i][0] + _v0.x, path[i][1] + _v0.y, path[i][2] + _v0.z,
          _v1.x, _v1.y, _v1.z, uAcc, vAcc[i]);
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

  _cap(centre, tangent, ringFirst, nu, isStart) {
    const s = isStart ? -1 : 1;
    const c = this.vertex(centre[0], centre[1], centre[2],
      tangent.x * s, tangent.y * s, tangent.z * s, 0, 0);
    for (let j = 0; j < nu; j++) {
      const j2 = (j + 1) % nu;
      // Going around a ring in increasing angle gives a geometric normal along
      // +T (radial × tangential = N × B = T), so the START cap — whose normal is
      // −T — has to wind the other way. Same winding bug as `patch`, same fix.
      if (isStart) this.tri(c, ringFirst + j2, ringFirst + j);
      else this.tri(c, ringFirst + j, ringFirst + j2);
    }
  }

  /**
   * A solid plate: an outer surface, an inner surface offset along −normal, and
   * a rim stitching their boundaries. Every piece of armour in this directory is
   * one of these — a pauldron is a curved shell, not a box, and the rim is what
   * catches the brazier light and gives it a hard edge at 120 px.
   */
  shell(o) {
    const th = o.thickness ?? 0.024;
    const rows = o.rows, cols = o.cols, closeU = !!o.closeU;
    const nu = closeU ? cols : cols + 1;
    const nv = rows + 1;

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
      const iu = Math.min(nu - 1, Math.round(u * cols) % (closeU ? nu : nu + 1));
      const iv = Math.min(nv - 1, Math.round(v * rows));
      const k = (iv * nu + iu) * 3;
      out.set(P[k] + Nrm[k] * half * sign, P[k + 1] + Nrm[k + 1] * half * sign,
        P[k + 2] + Nrm[k + 2] * half * sign);
    };

    const outRef = this.patch({ rows, cols, closeU, fn: sample(1) });
    const inRef = this.patch({ rows, cols, closeU, fn: sample(-1), flip: true });

    const mode = o.rimEdges ?? (closeU ? 'v' : 'all');
    if (mode !== 'none') {
      const oF = outRef.first, iF = inRef.first;
      const edge = (iu0, iv0, iu1, iv1) =>
        this._rimQuad(oF + iv0 * nu + iu0, oF + iv1 * nu + iu1,
          iF + iv1 * nu + iu1, iF + iv0 * nu + iu0);
      const uEnd = closeU ? nu : nu - 1;
      for (let iu = 0; iu < uEnd; iu++) {
        const iu2 = (iu + 1) % nu;
        edge(iu2, 0, iu, 0);
        edge(iu, nv - 1, iu2, nv - 1);
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
   * One rim quad, copying four vertices rather than indexing them, because the
   * rim needs its OWN normal — sharing the surface vertices smooths the edge
   * away, and a plate edge that is not sharp reads as plastic.
   */
  _rimQuad(oA, oB, iB, iA) {
    const g = (i, out) => out.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
    g(oA, _v0); g(oB, _v1); g(iB, _v2); g(iA, _v3);
    _n0.subVectors(_v1, _v0);
    _n1.subVectors(_v3, _v0);
    const nx = _n0.y * _n1.z - _n0.z * _n1.y;
    const ny = _n0.z * _n1.x - _n0.x * _n1.z;
    const nz = _n0.x * _n1.y - _n0.y * _n1.x;
    const l = Math.hypot(nx, ny, nz) || 1;
    const w = _v0.distanceTo(_v1), h = _v0.distanceTo(_v3);
    const saveWarp = this.warp;
    this.warp = 0;    // a warped rim opens a visible gap against its own surface
    // NEGATED, and the winding reversed to match.
    //
    // Worked out once for all four boundaries: at the v = 0 edge the assigned
    // normal comes out as +dV and the outward direction is −dV; at v = max it is
    // −dV against +dV; at u = 0 it is +dU against −dU; at u = max, −dU against
    // +dU. Every rim is inverted by exactly one sign, so one global flip fixes
    // the set. Left unflipped, every plate edge in the game is back-face culled
    // and armour reads as paper.
    const ux = -nx / l, uy = -ny / l, uz = -nz / l;
    const a = this.vertex(_v0.x, _v0.y, _v0.z, ux, uy, uz, 0, 0);
    const b = this.vertex(_v1.x, _v1.y, _v1.z, ux, uy, uz, w, 0);
    const c = this.vertex(_v2.x, _v2.y, _v2.z, ux, uy, uz, w, h);
    const d = this.vertex(_v3.x, _v3.y, _v3.z, ux, uy, uz, 0, h);
    this.warp = saveWarp;
    this.quad(a, d, c, b);
  }

  /**
   * A curved armour plate over a body region — the workhorse for pauldrons,
   * greaves, breastplates and the boss's buttresses. Defined by a centre, two
   * span axes and a bulge, so it can be placed at a joint's real coordinates.
   */
  plate(o) {
    const c = o.centre, ex = o.ex, ey = o.ey;
    const hx = o.halfX, hy = o.halfY;
    const bulge = o.bulge ?? 0.35;
    const taper = o.taper ?? 0;
    // Locals, not the module scratch: `patch` hands its own `_v0` to `fn` as the
    // output vector, so a generator closing over `_v0`/`_n0` would read the
    // value it had just written. Build-time allocation is fine — this runs once
    // per archetype at load, never per frame.
    const nrm = new THREE.Vector3().copy(ex).cross(ey).normalize();
    const exL = new THREE.Vector3().copy(ex);
    const eyL = new THREE.Vector3().copy(ey);
    return this.shell({
      rows: o.rows ?? 4, cols: o.cols ?? 6, thickness: o.thickness ?? 0.028,
      rimEdges: o.rimEdges ?? 'all',
      fn: (u, v, out) => {
        const su = (u - 0.5) * 2;
        const sv = (v - 0.5) * 2;
        const shrink = 1 - taper * v;
        const dome = bulge * (1 - su * su) * (1 - sv * sv * 0.55);
        out.set(c[0], c[1], c[2])
          .addScaledVector(exL, su * hx * shrink)
          .addScaledVector(eyL, sv * hy)
          .addScaledVector(nrm, dome);
      },
    });
  }

  /**
   * A tapering horn / claw / spike. Slight curve, square-ish cross section that
   * rounds toward the tip, which is what separates a bone spur from a cone.
   */
  spike(o) {
    const from = o.from;
    const dir = new THREE.Vector3().fromArray(o.dir).normalize();
    const len = o.length, r0 = o.radius, curve = o.curve ?? 0;
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(dir.y) > 0.9) up.set(0, 0, 1);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const bend = new THREE.Vector3().crossVectors(side, dir).normalize();
    const path = [];
    const segs = o.segments ?? 5;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      path.push([
        from[0] + dir.x * len * t + bend.x * curve * t * t * len,
        from[1] + dir.y * len * t + bend.y * curve * t * t * len,
        from[2] + dir.z * len * t + bend.z * curve * t * t * len,
      ]);
    }
    return this.tube({
      path, radial: o.radial ?? 5, capStart: true, capEnd: false,
      radius: (t) => r0 * Math.pow(1 - t, o.sharpness ?? 0.8) + 0.002,
    });
  }

  /**
   * A ragged cloth panel hanging from a line of anchor points. Used for every
   * torn robe, tabard and banner on an enemy. The hem is jagged by construction
   * — a straight hem is the single clearest "generated" tell on cloth.
   */
  rag(o) {
    const top = o.top, span = o.span, drop = o.drop;
    const jag = o.jag ?? 0.12;
    const sway = o.sway ?? 0.0;
    const seed = o.seed ?? 3;
    const rows = o.rows ?? 4, cols = o.cols ?? 4;
    // Locals rather than the module scratch — see the note in `plate`.
    const ex = new THREE.Vector3().fromArray(o.ex).normalize();
    const dn = new THREE.Vector3().fromArray(o.down ?? [0, -1, 0]).normalize();
    const fwd = new THREE.Vector3().crossVectors(ex, dn).normalize();
    const noise = (i) => {
      let h = (seed * 2654435761 + i * 40503) >>> 0;
      h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16;
      return (h >>> 0) / 2147483648 - 1;
    };
    return this.patch({
      rows, cols,
      fn: (u, v, out) => {
        const iu = Math.round(u * cols);
        const hem = 1 + noise(iu) * jag;
        const d = drop * v * hem;
        out.set(top[0], top[1], top[2])
          .addScaledVector(ex, (u - 0.5) * span)
          .addScaledVector(dn, d)
          .addScaledVector(fwd, Math.sin(v * 2.4) * sway + noise(iu * 7 + 1) * 0.02);
      },
    });
  }

  // =========================================================================
  // finish
  // =========================================================================

  /**
   * Solve skin weights and produce the BufferGeometry.
   *
   * O(V · B) with B the candidate count (never more than 12), so a 3 000-vertex
   * ghoul is ~36 000 distance tests: under a millisecond, once, at load.
   */
  build(bounds) {
    const V = this.vertexCount;
    if (V === 0) return null;

    const rig = this.rig;
    const si = new Uint16Array(V * 4);
    const sw = new Float32Array(V * 4);
    const bestI = new Int32Array(4);
    const bestW = new Float64Array(4);

    for (let v = 0; v < V; v++) {
      const g = this._groups[this.bindGroup[v]];
      if (!g) { si[v * 4] = 0; sw[v * 4] = 1; continue; }
      if (g.rigid >= 0) { si[v * 4] = g.rigid; sw[v * 4] = 1; continue; }

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

    const uv = this.uv;
    if (this.uvScale !== 1) {
      for (let i = 0; i < uv.length; i++) uv[i] *= this.uvScale;
    }

    const geo = new THREE.BufferGeometry();
    geo.name = `mn.ai.${this.name}`;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    geo.setIndex(V > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));

    // Bind-pose bounds are wrong the moment an arm goes overhead, so the sphere
    // is set generously by hand from the archetype's height instead of computed.
    const h = bounds?.height ?? 2.0;
    const r = bounds?.radius ?? h * 0.7;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, h * 0.5, 0), r + h * 0.35);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-r - 0.6, -0.4, -r - 0.6),
      new THREE.Vector3(r + 0.6, h + 0.8, r + 0.6)
    );
    return geo;
  }
}

/* ==========================================================================
 * shared profile helpers
 * ========================================================================== */

/** Superellipse radius: turns a circle into a rounded rectangle as `n` grows.
 *  Torsos, vambraces and greaves are all closer to a rounded box than to a
 *  cylinder, and a plain cylinder is the clearest tell that a character was
 *  generated rather than modelled. */
export function superEllipse(angle, n) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return Math.pow(Math.pow(Math.abs(c), n) + Math.pow(Math.abs(s), n), -1 / n);
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}

/** Catmull-Rom through a list of scalars — limb profile curves. */
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

/**
 * A limb: a tube from a bone's head to its tail with a profile curve, bound to
 * that bone and its parent. Every arm, leg and neck in this directory goes
 * through here so they all share the same construction and the same UV density.
 */
export function limb(B, rig, boneA, boneB, o = {}) {
  const a = rig.headOf(boneA);
  const b = rig.tailOf(boneB ?? boneA);
  const segs = o.segments ?? 4;
  const path = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const bow = o.bow ? o.bow * Math.sin(Math.PI * t) : 0;
    path.push([
      a[0] + (b[0] - a[0]) * t + (o.bowDir?.[0] ?? 0) * bow,
      a[1] + (b[1] - a[1]) * t + (o.bowDir?.[1] ?? 0) * bow,
      a[2] + (b[2] - a[2]) * t + (o.bowDir?.[2] ?? 1) * bow,
    ]);
  }
  const prof = o.profile ?? [1, 0.92, 0.86, 0.9, 0.8];
  return B.tube({
    path, radial: o.radial ?? 7,
    capStart: o.capStart ?? false, capEnd: o.capEnd ?? false,
    squash: o.squash ?? ((t) => 0.82 + 0.18 * Math.sin(t * Math.PI)),
    radius: (t) => o.radius * curve(prof, t),
  });
}
