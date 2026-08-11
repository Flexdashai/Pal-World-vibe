import * as THREE from 'three';
import { GRID, ATLAS_SIZE } from './atlas.js';
import { FX } from './tuning.js';

/**
 * MONARCH — decals.
 *
 * Blood, scorch, ice, cracks and violet runes, projected onto the level and lit
 * by the same lights as everything else.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE LIT QUADS AND NOT SCREEN-SPACE DEFERRED DECALS
 *
 * The textbook answer is a deferred decal: render a box, read the depth buffer,
 * reconstruct the world position, and blend into the G-buffer. It is the right
 * answer for a deferred renderer with a GPU. Here it is wrong twice over — this
 * is a FORWARD pipeline (there is no albedo G-buffer to blend into), and a
 * fullscreen-ish box per decal is pure fill on a CPU rasteriser.
 *
 * So a decal is an oriented quad with `MeshStandardMaterial`, which buys three
 * things that matter more than projection accuracy at a 21 m isometric camera:
 *
 *  1. **It is lit.** Blood in shadow is nearly black; blood beside a brazier
 *     glistens. That difference is most of what makes it read as a fluid on the
 *     floor rather than a texture pasted on it — and it is exactly what a decal
 *     drawn as an unlit sprite can never do.
 *  2. **It is wet.** Per-decal roughness, modulated by the sprite's own value
 *     channel, so the thick middle of a splat is glossy and the thin rim is not.
 *     Combined with render's SSR, a blood pool reflects the fire.
 *  3. **It is one draw call.** Every decal in the level is one InstancedMesh;
 *     the per-instance sprite, tint, alpha, roughness and emissive ride in an
 *     instanced attribute plus `instanceColor`.
 *
 * Conformance to non-flat geometry is bought instead with a cheap physics test:
 * before a decal is placed, the surface is probed at four points around its
 * perimeter, and a decal that would span a step or a wall base is shrunk or
 * rejected. That covers every case this camera can actually see.
 *
 * ---------------------------------------------------------------------------
 * THE POOL IS A RING, WHICH IS THE LRU
 *
 * Slots are handed out round-robin. The oldest decal is therefore always the
 * next one to be recycled, which is exactly LRU for a write-once resource, with
 * no bookkeeping at all. A retired slot has its instance matrix scaled to zero,
 * so it costs four vertex-shader invocations and no fill — cheaper than
 * compacting the buffer, and it keeps every slot's identity stable so a growing
 * blood pool can be found again by its handle.
 */

const VERT_HEAD = /* glsl */ `
attribute vec4 aDecal;      // x = sprite index, y = alpha, z = roughness mul, w = emissive
attribute vec3 aTint;       // linear albedo tint
varying vec4 vDecal;
varying vec3 vTint;
varying vec2 vDecalUv;
varying vec2 vDecalW;       // world XZ, for the shared detail field
`;

const VERT_BODY = /* glsl */ `
  vDecal = aDecal;
  vTint = aTint;
  vDecalUv = uv;
  #ifdef USE_INSTANCING
    vec4 mnDecalWp = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
  #else
    vec4 mnDecalWp = modelMatrix * vec4( transformed, 1.0 );
  #endif
  vDecalW = mnDecalWp.xz;
`;

const FRAG_HEAD = /* glsl */ `
uniform sampler2D uDecalAtlas;
uniform sampler2D uDecalDetail;
uniform vec2 uDecalGrid;    // x = grid size, y = half-texel inset
varying vec4 vDecal;
varying vec3 vTint;
varying vec2 vDecalUv;
varying vec2 vDecalW;
`;

/**
 * Sampling + albedo. Injected after `<color_fragment>`, which is the last point
 * at which `diffuseColor` is still the material's own colour and before any
 * alpha test runs.
 */
const FRAG_COLOR = /* glsl */ `
  float mnTx = mod( vDecal.x, uDecalGrid.x );
  float mnTy = floor( vDecal.x / uDecalGrid.x );
  float mnInv = 1.0 / uDecalGrid.x;
  vec2 mnUv = ( vec2( mnTx, mnTy )
              + vDecalUv * ( 1.0 - uDecalGrid.y * 2.0 * uDecalGrid.x )
              + uDecalGrid.y * uDecalGrid.x ) * mnInv;
  vec4 mnDecal = texture2D( uDecalAtlas, mnUv );

  // The shared 256px detail field, sampled in WORLD space at ~0.6 m. Two decals
  // of the same sprite laid next to each other must not look like two copies of
  // one stamp, and world-space sampling is what guarantees that whatever their
  // own orientation.
  float mnGrain = texture2D( uDecalDetail, vDecalW * 1.7 ).b;

  // The sprite's value channel is film THICKNESS: dark where the fluid pools,
  // pale where it is a smear. Modulating albedo by it is what gives a splat a
  // readable interior instead of one flat colour.
  diffuseColor.rgb *= vTint * ( 0.42 + 0.78 * mnDecal.r ) * ( 0.84 + 0.32 * mnGrain );
  diffuseColor.a *= mnDecal.a * vDecal.y;
  if ( diffuseColor.a < 0.0035 ) discard;
`;

/** Roughness. Injected after `<roughnessmap_fragment>`. */
const FRAG_ROUGH = /* glsl */ `
  // Thick (dark) => wet and glossy; thin (pale) => matte. vDecal.z scales the
  // whole range per decal: 1.0 blood, ~2.2 scorch, ~0.4 ice.
  roughnessFactor = clamp( mix( 0.13, 0.66, mnDecal.r ) * vDecal.z * ( 0.9 + 0.2 * mnGrain ), 0.035, 1.0 );
`;

/** Emissive. Injected after `<emissivemap_fragment>`. */
const FRAG_EMISSIVE = /* glsl */ `
  totalEmissiveRadiance += diffuseColor.rgb * vDecal.w;
`;

export class DecalSystem {
  /**
   * @param {THREE.Texture} atlas       the fx sprite atlas
   * @param {THREE.Texture} detail      materials.detailTexture
   * @param {object} render             the render subsystem
   * @param {object|null} physics       may be null; conformance is then skipped
   * @param {object} q                  quality preset
   */
  constructor(atlas, detail, render, physics, q) {
    this.physics = physics;
    this.budget = q.decalBudget;
    // Respect the budget as a CEILING but stay under `cap`: every decal is a
    // lit, shadow-receiving transparent fragment and this container rasterises
    // on the CPU. See tuning.js.
    this.capacity = Math.max(16, Math.min(q.decalBudget, FX.decals.cap));

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      // Coplanar with the floor it sits on. The normal offset alone is not
      // enough at grazing angles across a 140 m frustum, and z-fighting on a
      // blood pool is the most obvious artefact this system could produce.
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
    });
    mat.name = 'mn.fx.decals';
    // Part of the program cache key (three hashes `defines`), so this material
    // can never be handed a program compiled for someone else's instanced,
    // transparent standard material.
    mat.defines = { MN_DECAL: '1' };

    const uniforms = {
      uDecalAtlas: { value: atlas },
      uDecalDetail: { value: detail },
      uDecalGrid: { value: new THREE.Vector2(GRID, 0.5 / ATLAS_SIZE) },
    };
    this.uniforms = uniforms;

    // Set BEFORE render.registerMaterial: the patcher chains onto whatever
    // onBeforeCompile it finds, so ours must already be installed or it is lost.
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);
    };
    this.material = mat;
    render.registerMaterial(mat);

    // A unit quad in the XY plane facing +Z; the instance matrix orients it.
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.geometry = geo;

    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.name = 'mn.fx.decals';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.userData.mnNoShadow = true;
    this.mesh.userData.mnNoPrepass = true;
    // Decals lie on the floor under everything else; drawing them before the
    // particle sheets keeps the transparent order sane.
    this.mesh.renderOrder = 4;
    this.mesh.count = 0;

    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDecal', this.attr);

    // Our own tint attribute rather than `InstancedMesh.instanceColor`: three
    // only routes `instanceColor` to the fragment stage when `vertexColors` is
    // also on, which then demands a per-vertex `color` attribute the geometry
    // does not have and silently shades everything black. One instanced vec3 of
    // our own has none of that coupling.
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTint', this.tint);

    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // ---- per-slot state ----------------------------------------------------
    this.age = new Float32Array(this.capacity);
    this.life = new Float32Array(this.capacity);
    this.fade = new Float32Array(this.capacity);
    this.peak = new Float32Array(this.capacity);
    this.growEnd = new Float32Array(this.capacity);
    this.growFrom = new Float32Array(this.capacity);
    this.sizeTo = new Float32Array(this.capacity);
    this.alive = new Uint8Array(this.capacity);
    /** Cached placement, so a growing decal can rewrite its matrix. */
    this.px = new Float32Array(this.capacity);
    this.py = new Float32Array(this.capacity);
    this.pz = new Float32Array(this.capacity);
    this.qx = new Float32Array(this.capacity);
    this.qy = new Float32Array(this.capacity);
    this.qz = new Float32Array(this.capacity);
    this.qw = new Float32Array(this.capacity);

    this.head = 0;
    this.used = 0;
    this.live = 0;
    this._placed = 0;
    this._rejected = 0;

    // ---- preallocated scratch ---------------------------------------------
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._n = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._ref = new THREE.Vector3();
    this._growing = [];
  }

  attach(scene) { scene.add(this.mesh); }

  /**
   * Place a decal.
   *
   * @param {object} o
   *   x,y,z        contact point
   *   nx,ny,nz     surface normal (default +Y)
   *   size         diameter in metres
   *   sprite       atlas index
   *   color        [r,g,b] linear tint
   *   alpha        peak opacity
   *   rough        roughness multiplier (1 = wet blood, 2.2 = dry soot)
   *   emissive     emissive multiplier (violet runes glow, blood does not)
   *   life/fade    seconds
   *   rotation     radians about the surface normal; random when omitted
   *   grow         seconds to expand from `growFrom` to full size (pools)
   *   conform      false to skip the flatness probe (tiny decals, walls)
   * @returns {number} slot index, or -1 if the placement was rejected
   */
  place(o) {
    let size = o.size ?? 0.5;
    let x = o.x, y = o.y, z = o.z;
    let nx = o.nx ?? 0, ny = o.ny ?? 1, nz = o.nz ?? 0;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    // ---- conformance probe ------------------------------------------------
    // Only for reasonably flat, reasonably large decals: a 10 cm droplet cannot
    // span a step, and a decal on a wall is being placed by an impact that
    // already knows the surface it hit.
    if (o.conform !== false && this.physics && size > 0.26 && ny > 0.65) {
      const half = size * 0.42;
      let lo = Infinity, hi = -Infinity, hits = 0;
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI * 0.5 + Math.PI * 0.25;
        const hx = x + Math.cos(a) * half;
        const hz = z + Math.sin(a) * half;
        const h = this.physics.raycastFrom(hx, y + 0.45, hz, 0, -1, 0, 1.1);
        if (h) { hits++; if (h.py < lo) lo = h.py; if (h.py > hi) hi = h.py; }
      }
      if (hits < 3) {
        // Most of the footprint is over a hole or a ledge.
        this._rejected++;
        return -1;
      }
      const spanned = hi - lo;
      if (spanned > FX.decals.flatness) {
        // Halve it once and accept — a small decal on a step reads fine, a
        // large one visibly floats.
        size *= 0.5;
        if (spanned > FX.decals.flatness * 2.4) { this._rejected++; return -1; }
      }
      // Sit on the highest probe, not the requested y: a droplet reported at the
      // moment it crossed the plane is a few centimetres below the floor.
      y = Math.max(y, hi - 0.02);
    }

    // ---- claim the slot (ring = LRU) --------------------------------------
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    if (!this.alive[i]) this.live++;
    this.alive[i] = 1;
    this._placed++;

    this.age[i] = 0;
    this.life[i] = o.life ?? FX.decals.life;
    this.fade[i] = o.fade ?? FX.decals.fade;
    this.peak[i] = o.alpha ?? 1;
    this.sizeTo[i] = size;
    this.growFrom[i] = o.grow ? (o.growFrom ?? 0.30) : 1;
    this.growEnd[i] = o.grow ?? 0;

    // ---- orientation -------------------------------------------------------
    // The quad's +Z is the surface normal. A reference axis perpendicular to
    // the normal picks the in-plane rotation; +X works for a floor and would be
    // degenerate only for a wall whose normal is exactly +X, which the fallback
    // covers.
    this._n.set(nx, ny, nz);
    this._ref.set(1, 0, 0);
    if (Math.abs(nx) > 0.9) this._ref.set(0, 0, 1);
    this._t.copy(this._ref).cross(this._n).normalize();
    this._b.copy(this._n).cross(this._t).normalize();
    this._m.makeBasis(this._t, this._b, this._n);
    this._q.setFromRotationMatrix(this._m);
    // Spin about the normal so repeated decals of the same sprite do not read
    // as a repeated stamp. Pre-multiplying by an axis-angle about the normal
    // rotates in the decal's own plane, which is what "rotation" has to mean
    // here — post-multiplying would rotate about the quad's local Z before the
    // basis is applied and would tilt it off the surface.
    const rot = o.rotation ?? 0;
    if (rot !== 0) {
      this._q2.setFromAxisAngle(this._n, rot);
      this._q.premultiply(this._q2);
    }

    this.px[i] = x + nx * FX.decals.lift;
    this.py[i] = y + ny * FX.decals.lift;
    this.pz[i] = z + nz * FX.decals.lift;
    this.qx[i] = this._q.x; this.qy[i] = this._q.y; this.qz[i] = this._q.z; this.qw[i] = this._q.w;

    this._writeMatrix(i, size * this.growFrom[i]);

    // ---- per-instance shading data ----------------------------------------
    const c = o.color ?? WHITE;
    this.tint.array[i * 3] = c[0];
    this.tint.array[i * 3 + 1] = c[1];
    this.tint.array[i * 3 + 2] = c[2];
    this.tint.needsUpdate = true;

    const a = this.attr.array;
    a[i * 4] = o.sprite ?? 0;
    a[i * 4 + 1] = this.peak[i];
    a[i * 4 + 2] = o.rough ?? 1;
    a[i * 4 + 3] = o.emissive ?? 0;
    this.attr.needsUpdate = true;

    if (this.growEnd[i] > 0 && this._growing.indexOf(i) < 0) this._growing.push(i);
    if (this.mesh.count < this.used) this.mesh.count = this.used;
    return i;
  }

  _writeMatrix(i, scale) {
    this._pos.set(this.px[i], this.py[i], this.pz[i]);
    this._q.set(this.qx[i], this.qy[i], this.qz[i], this.qw[i]);
    this._scale.set(scale, scale, scale);
    this._m.compose(this._pos, this._q, this._scale);
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Retire a slot: zero scale means zero fill and four wasted vertices. */
  _retire(i) {
    this.alive[i] = 0;
    this.live--;
    this._pos.set(this.px[i], this.py[i], this.pz[i]);
    this._q.set(0, 0, 0, 1);
    this._scale.set(0, 0, 0);
    this._m.compose(this._pos, this._q, this._scale);
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Age every decal.
   *
   * Under pressure — more than `FX.decals.pressure` of the pool in use — every
   * decal ages faster, so the oldest reach zero and free their slots before the
   * ring wraps onto something the player is still looking at. Ageing everything
   * uniformly avoids a sort, and because alpha is what changes, nothing pops.
   */
  update(dt) {
    if (this.used === 0) return;
    const occupancy = this.live / this.capacity;
    const rush = occupancy > FX.decals.pressure
      ? 1 + (occupancy - FX.decals.pressure) / (1 - FX.decals.pressure) * 7
      : 1;
    const d = dt * rush;

    const a = this.attr.array;
    let dirty = false;
    for (let i = 0; i < this.used; i++) {
      if (!this.alive[i]) continue;
      const age = this.age[i] + d;
      this.age[i] = age;
      const life = this.life[i], fade = this.fade[i];
      if (age >= life + fade) { this._retire(i); dirty = true; continue; }
      const alpha = age <= life ? this.peak[i] : this.peak[i] * (1 - (age - life) / fade);
      if (a[i * 4 + 1] !== alpha) { a[i * 4 + 1] = alpha; dirty = true; }
    }
    if (dirty) this.attr.needsUpdate = true;

    // Growing decals (blood pooling under a corpse) rewrite their matrix.
    for (let k = this._growing.length - 1; k >= 0; k--) {
      const i = this._growing[k];
      if (!this.alive[i] || this.growEnd[i] <= 0) { this._growing.splice(k, 1); continue; }
      const t = Math.min(1, this.age[i] / this.growEnd[i]);
      // Ease-out: a pool spreads fast at first and then creeps, because the
      // spreading rate falls with the film thickness.
      const e = 1 - (1 - t) * (1 - t) * (1 - t);
      this._writeMatrix(i, this.sizeTo[i] * (this.growFrom[i] + (1 - this.growFrom[i]) * e));
      if (t >= 1) this._growing.splice(k, 1);
    }
  }

  /** Reduce a decal's remaining life — used when a corpse is extracted and its
   *  pool should evaporate with it. */
  expire(i, over = 0.6) {
    if (i < 0 || i >= this.capacity || !this.alive[i]) return;
    this.age[i] = Math.max(this.age[i], this.life[i]);
    this.fade[i] = over;
  }

  clear() {
    for (let i = 0; i < this.used; i++) if (this.alive[i]) this._retire(i);
    this._growing.length = 0;
    this.head = 0;
    this.live = 0;
  }

  stats() {
    return {
      budget: this.budget, capacity: this.capacity,
      live: this.live, used: this.used,
      placed: this._placed, rejected: this._rejected,
      growing: this._growing.length,
    };
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

const WHITE = [1, 1, 1];
