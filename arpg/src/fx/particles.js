import * as THREE from 'three';
import { ATLAS_SIZE, GRID } from './atlas.js';
import { FX } from './tuning.js';

/**
 * MONARCH — the particle engine.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIMULATION IS ON THE CPU AND THE DRAW IS INSTANCED
 *
 * The obvious "GPU particle system" is a ping-pong float texture holding
 * position and velocity, stepped by a fullscreen pass. On a GPU that is free.
 * In THIS container it is the worst possible choice: SwiftShader rasterises on
 * the CPU, so a 128x128 simulation texture is 16384 fragment-shader invocations
 * per step *plus* a render-target bind, and it buys nothing, because the
 * bottleneck is fill rate, not the integration.
 *
 * So: the integration runs over flat typed arrays (one pass, no branches on
 * object shape, no allocation), and the DRAW is a single instanced quad per blend
 * mode. Two draw calls carry every particle in the game. On real hardware this is
 * also the right answer up to ~50k particles, which is well past this game's
 * budget, and it keeps landing/collision logic possible — a GPU sim cannot tell
 * the decal system that a blood droplet just hit the floor.
 *
 * ---------------------------------------------------------------------------
 * SOFT PARTICLES
 *
 * Every particle fades where it approaches the opaque surface behind it, read
 * from `render.depthTexture`. A hard-edged puff intersecting the floor is an
 * instant tell, and it is the single cheapest quality win available here: one
 * texture fetch and three ALU per fragment.
 *
 * The depth texture belongs to the PREPASS target, which is deliberately NOT the
 * lit pass's depth attachment (see render/targets.js) — so sampling it while
 * drawing into the HDR buffer is safe and is not a feedback loop.
 *
 * ---------------------------------------------------------------------------
 * ORDERING
 *
 * The additive pool needs no sorting — addition commutes. The alpha pool
 * (smoke, dust, blood) is drawn unsorted, which is a deliberate trade: sorting
 * ~1500 particles by view depth every frame costs more than the artefact, and
 * the artefact is invisible in practice because alpha particles here are
 * low-contrast, similarly-coloured and heavily overlapped. If it ever becomes
 * visible, sort by `-(x+z)` — the isometric camera's depth axis — not by a full
 * distance computation.
 */

/** Particle draw mode, matching the `mode` branch in the vertex shader. */
export const MODE = {
  BILLBOARD: 0,   // camera-facing, spins about the view axis
  STRETCH: 1,     // camera-facing, long axis along the velocity vector
  GROUND: 2,      // flat on the XZ plane, spins about Y
  FLAT: 3,        // camera-facing, never spins (rings, flares, glyphs)
};

/** Per-particle flags. */
export const PFLAG = {
  LANDS: 1,       // spawns a decal when it crosses `groundY`
  ORBIT: 2,       // position is driven around (cx, cz) instead of by vx/vz
  FADE_SIZE: 4,   // shrink toward zero at the end rather than growing
};

/** Floats per instance in the interleaved-by-attribute buffers. */
const A_POS = 3, A_VEL = 3, A_SR = 3, A_COL = 3, A_PAR = 4;

/**
 * One pool = one blend mode = one draw call.
 *
 * Live particles are kept packed at the front of every array; a death swaps the
 * last live particle into the dead slot. That keeps `mesh.count = live` correct
 * and means the GPU upload is one contiguous range rather than a scatter.
 */
class Pool {
  constructor(capacity, material, name) {
    this.capacity = capacity;
    this.live = 0;

    // ---- simulation state (never uploaded) --------------------------------
    const F = (n = 1) => new Float32Array(capacity * n);
    this.px = F(); this.py = F(); this.pz = F();
    this.vx = F(); this.vy = F(); this.vz = F();
    this.age = F(); this.life = F();
    this.s0 = F(); this.s1 = F();
    this.rot = F(); this.spin = F();
    this.cr = F(); this.cg = F(); this.cb = F();
    this.drag = F(); this.grav = F();
    this.turb = F(); this.seed = F();
    this.alpha = F(); this.fadeIn = F(); this.fadeOut = F();
    this.tile = F(); this.mode = F(); this.soft = F();
    this.stretch = F();
    this.cx = F(); this.cz = F(); this.orbit = F(); this.radial = F();
    this.groundY = F();
    this.flags = new Uint8Array(capacity);
    /** Opaque per-particle payload for the LANDS callback (decal tint index). */
    this.tag = new Uint8Array(capacity);

    // ---- instance attributes (uploaded) ------------------------------------
    this.aPos = new Float32Array(capacity * A_POS);
    this.aVel = new Float32Array(capacity * A_VEL);
    this.aSR = new Float32Array(capacity * A_SR);
    this.aCol = new Float32Array(capacity * A_COL);
    this.aPar = new Float32Array(capacity * A_PAR);

    const geo = new THREE.InstancedBufferGeometry();
    // A unit quad centred on the origin. `position` is expanded in the vertex
    // shader against a billboard basis, so this geometry is never transformed.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const inst = (arr, size) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.attrPos = inst(this.aPos, A_POS);
    this.attrVel = inst(this.aVel, A_VEL);
    this.attrSR = inst(this.aSR, A_SR);
    this.attrCol = inst(this.aCol, A_COL);
    this.attrPar = inst(this.aPar, A_PAR);
    geo.setAttribute('aPos', this.attrPos);
    geo.setAttribute('aVel', this.attrVel);
    geo.setAttribute('aSizeRot', this.attrSR);
    geo.setAttribute('aColor', this.attrCol);
    geo.setAttribute('aParams', this.attrPar);
    geo.instanceCount = 0;
    // The mesh never moves and the particles are in world space, so a bounding
    // sphere would have to be recomputed every frame to be correct. Culling is
    // therefore off and the draw is skipped by `visible` instead.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Redundant with `transparent: true` (which already excludes it) but says
    // out loud that a particle must never occlude, reflect or shade anything.
    this.mesh.userData.mnNoPrepass = true;
    this.mesh.userData.mnNoShadow = true;
    this.mesh.visible = false;
  }

  /** Move slot `src` into slot `dst`. Used by the swap-remove compaction. */
  _move(dst, src) {
    this.px[dst] = this.px[src]; this.py[dst] = this.py[src]; this.pz[dst] = this.pz[src];
    this.vx[dst] = this.vx[src]; this.vy[dst] = this.vy[src]; this.vz[dst] = this.vz[src];
    this.age[dst] = this.age[src]; this.life[dst] = this.life[src];
    this.s0[dst] = this.s0[src]; this.s1[dst] = this.s1[src];
    this.rot[dst] = this.rot[src]; this.spin[dst] = this.spin[src];
    this.cr[dst] = this.cr[src]; this.cg[dst] = this.cg[src]; this.cb[dst] = this.cb[src];
    this.drag[dst] = this.drag[src]; this.grav[dst] = this.grav[src];
    this.turb[dst] = this.turb[src]; this.seed[dst] = this.seed[src];
    this.alpha[dst] = this.alpha[src]; this.fadeIn[dst] = this.fadeIn[src];
    this.fadeOut[dst] = this.fadeOut[src];
    this.tile[dst] = this.tile[src]; this.mode[dst] = this.mode[src];
    this.soft[dst] = this.soft[src]; this.stretch[dst] = this.stretch[src];
    this.cx[dst] = this.cx[src]; this.cz[dst] = this.cz[src];
    this.orbit[dst] = this.orbit[src]; this.radial[dst] = this.radial[src];
    this.groundY[dst] = this.groundY[src];
    this.flags[dst] = this.flags[src];
    this.tag[dst] = this.tag[src];
  }

  dispose() {
    this.geometry.dispose();
  }
}

/* ==========================================================================
 * Shaders
 * ========================================================================== */

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec3 aSizeRot;   // x = width, y = height, z = rotation (radians)
attribute vec3 aColor;
attribute vec4 aParams;    // x = alpha, y = tile index, z = softness, w = mode

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
varying float vViewZ;

uniform float uGrid;
uniform float uInset;

void main() {
  // --- billboard basis ----------------------------------------------------
  // The rows of viewMatrix are the camera's world-space axes, so the basis
  // costs three swizzles rather than an inverse.
  vec3 camRight = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
  vec3 camUp    = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
  vec3 camFwd   = vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );

  float mode = aParams.w;
  vec3 right, up;

  if ( mode < 0.5 ) {
    // Camera-facing, spinning about the view axis.
    float c = cos( aSizeRot.z ), s = sin( aSizeRot.z );
    right =  camRight * c + camUp * s;
    up    = -camRight * s + camUp * c;
  } else if ( mode < 1.5 ) {
    // Velocity-aligned: the long axis follows the world velocity, the short
    // axis is whatever is left perpendicular to the view. This is what makes a
    // spark a streak and a blood droplet point the way it is travelling —
    // ARCHITECTURE.md's "effects are directional", at the sprite level.
    vec3 dir = aVel;
    float l = length( dir );
    up = l > 1e-4 ? dir / l : camUp;
    vec3 r = cross( up, camFwd );
    float rl = length( r );
    // Degenerate when the velocity points straight at the lens; fall back to
    // the camera basis so the quad never collapses to a line.
    right = rl > 1e-4 ? r / rl : camRight;
  } else if ( mode < 2.5 ) {
    // Flat on the ground plane, spinning about Y.
    float c = cos( aSizeRot.z ), s = sin( aSizeRot.z );
    right = vec3( c, 0.0, s );
    up    = vec3( -s, 0.0, c );
  } else {
    right = camRight;
    up = camUp;
  }

  vec3 world = aPos + right * ( position.x * aSizeRot.x ) + up * ( position.y * aSizeRot.y );

  // --- atlas tile ---------------------------------------------------------
  float tile = aParams.y;
  float tx = mod( tile, uGrid );
  float ty = floor( tile / uGrid );
  float inv = 1.0 / uGrid;
  // Inset by half a texel: bilinear filtering at the tile edge must not be able
  // to reach the neighbouring sprite.
  vUv = ( vec2( tx, ty ) + uv * ( 1.0 - uInset * 2.0 * uGrid ) + uInset * uGrid ) * inv;

  vColor = aColor;
  vAlpha = aParams.x;
  vSoft  = aParams.z;

  vec4 mv = viewMatrix * vec4( world, 1.0 );
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D uDepth;
uniform vec4 uProj;       // near, far, unused, unused
uniform vec4 uScreen;     // w, h, 1/w, 1/h
uniform float uSoftFade;
uniform float uHasDepth;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
varying float vViewZ;

float mnLinearDepth( float d ) {
  float n = uProj.x, f = uProj.y;
  float z = d * 2.0 - 1.0;
  return ( 2.0 * n * f ) / ( f + n - z * ( f - n ) );
}

void main() {
  vec4 tex = texture2D( uAtlas, vUv );
  float a = tex.a * vAlpha;
  if ( a < 0.0035 ) discard;

  // --- soft particles ------------------------------------------------------
  // Fade as the quad approaches the opaque surface behind it. vSoft scales the
  // fade distance per particle: a 2 m smoke column wants a much longer fade than
  // a 4 cm spark, which should stay crisp right up to the wall it struck.
  if ( uHasDepth > 0.5 ) {
    float d = texture2D( uDepth, gl_FragCoord.xy * uScreen.zw ).x;
    float sceneZ = mnLinearDepth( d );
    float fade = max( 0.02, uSoftFade * vSoft );
    a *= clamp( ( sceneZ - vViewZ ) / fade, 0.0, 1.0 );
    if ( a < 0.0035 ) discard;
  }

  // Value channel carries internal structure; colour comes from the palette.
  gl_FragColor = vec4( vColor * tex.rgb, a );
}
`;

/* ==========================================================================
 * The system
 * ========================================================================== */

export class ParticleSystem {
  /**
   * @param {THREE.Texture} atlas
   * @param {object} q  the active quality preset
   */
  constructor(atlas, q) {
    // The quality budget is what a GPU could afford; `softwareCap` is what keeps
    // every other agent's capture loop usable in this container. See tuning.js.
    const total = Math.max(256, Math.min(q.particleBudget, FX.softwareCap));
    this.budget = q.particleBudget;
    this.capacity = total;

    const uniforms = {
      uAtlas: { value: atlas },
      uDepth: { value: null },
      uProj: { value: new THREE.Vector4(1, 140, 0, 0) },
      uScreen: { value: new THREE.Vector4(1, 1, 1, 1) },
      uSoftFade: { value: FX.softFade },
      uHasDepth: { value: 0 },
      uGrid: { value: GRID },
      uInset: { value: 0.5 / ATLAS_SIZE },
    };
    /** ONE uniform object shared by both materials, so the per-frame depth /
     *  projection write happens once instead of twice and cannot drift. */
    this.uniforms = uniforms;

    const base = {
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      // The whole pipeline is linear until the composite; tone mapping in a
      // material would apply the film curve twice.
      toneMapped: false,
    };

    this.matAdd = new THREE.ShaderMaterial({ ...base, blending: THREE.AdditiveBlending });
    this.matAdd.name = 'mn.fx.particles.add';
    this.matAlpha = new THREE.ShaderMaterial({ ...base, blending: THREE.NormalBlending });
    this.matAlpha.name = 'mn.fx.particles.alpha';

    const nAdd = Math.max(64, Math.round(total * FX.pools.additive));
    const nAlpha = Math.max(64, total - nAdd);
    this.add = new Pool(nAdd, this.matAdd, 'mn.fx.particles.add');
    this.alpha = new Pool(nAlpha, this.matAlpha, 'mn.fx.particles.alpha');

    // Additive draws last so energy sits on top of its own smoke.
    this.alpha.mesh.renderOrder = 10;
    this.add.mesh.renderOrder = 12;

    /** Called with (x, y, z, tag, vx, vy, vz) when a LANDS particle crosses its
     *  cached ground height. Wired to the decal system by index.js. */
    this.onLand = null;

    this._time = 0;
    this._spawned = 0;
    this._killed = 0;
    this._overflow = 0;
  }

  attach(scene) {
    scene.add(this.alpha.mesh);
    scene.add(this.add.mesh);
  }

  get live() { return this.add.live + this.alpha.live; }

  /**
   * Emit one particle.
   *
   * Every field has a default so a call site only names what it cares about,
   * but the object passed in is EXPECTED to be a reused scratch object owned by
   * the caller — `emitters.js` keeps exactly one. This function reads it and
   * retains nothing.
   */
  emit(p) {
    const pool = p.additive ? this.add : this.alpha;
    const i = pool.live;
    if (i >= pool.capacity) { this._overflow++; return -1; }
    pool.live = i + 1;
    this._spawned++;

    pool.px[i] = p.x; pool.py[i] = p.y; pool.pz[i] = p.z;
    pool.vx[i] = p.vx ?? 0; pool.vy[i] = p.vy ?? 0; pool.vz[i] = p.vz ?? 0;
    pool.age[i] = 0; pool.life[i] = p.life;
    pool.s0[i] = p.size0; pool.s1[i] = p.size1 ?? p.size0;
    pool.rot[i] = p.rot ?? 0; pool.spin[i] = p.spin ?? 0;
    pool.cr[i] = p.r; pool.cg[i] = p.g; pool.cb[i] = p.b;
    pool.drag[i] = p.drag ?? 0; pool.grav[i] = p.gravity ?? 0;
    pool.turb[i] = p.turbulence ?? 0; pool.seed[i] = p.seed ?? 0;
    pool.alpha[i] = p.alpha ?? 1;
    pool.fadeIn[i] = p.fadeIn ?? 0.08;
    pool.fadeOut[i] = p.fadeOut ?? 1.6;
    pool.tile[i] = p.tile;
    pool.mode[i] = p.mode ?? MODE.BILLBOARD;
    pool.soft[i] = p.softness ?? 1;
    pool.stretch[i] = p.stretch ?? 0;
    pool.cx[i] = p.cx ?? p.x; pool.cz[i] = p.cz ?? p.z;
    pool.orbit[i] = p.orbit ?? 0; pool.radial[i] = p.radial ?? 0;
    pool.groundY[i] = p.groundY ?? -1e9;
    pool.flags[i] = p.flags ?? 0;
    pool.tag[i] = p.tag ?? 0;
    return i;
  }

  /**
   * Integrate and rebuild the instance buffers.
   *
   * ONE pass over the live particles does everything: integration, lifetime,
   * landing tests, size/alpha curves and the attribute write. Splitting it into
   * a "simulate" and a "write" pass would double the memory traffic, which on a
   * CPU-bound target is the whole cost.
   */
  update(dt, time) {
    this._time = time;
    this._step(this.add, dt, time);
    this._step(this.alpha, dt, time);
  }

  _step(pool, dt, time) {
    let n = pool.live;
    let i = 0;
    const land = this.onLand;

    while (i < n) {
      const age = pool.age[i] + dt;
      const life = pool.life[i];

      if (age >= life) {
        n--;
        if (i !== n) pool._move(i, n);
        continue;
      }
      pool.age[i] = age;
      const t = age / life;

      const flags = pool.flags[i];

      // ---- integration -------------------------------------------------
      let vx = pool.vx[i], vy = pool.vy[i], vz = pool.vz[i];

      vy += pool.grav[i] * dt;

      const turb = pool.turb[i];
      if (turb !== 0) {
        // Summed sines, never a random walk: a capture must be reproducible
        // frame for frame, and a 1/f-ish sum is what real turbulence looks
        // like anyway. The per-particle seed decorrelates neighbours.
        const ph = pool.seed[i] + time * 1.6;
        vx += Math.sin(ph * 2.13) * turb * dt;
        vz += Math.cos(ph * 1.71 + 1.1) * turb * dt;
        vy += Math.sin(ph * 0.93 + 2.4) * turb * 0.30 * dt;
      }

      const drag = pool.drag[i];
      if (drag !== 0) {
        // Exponential decay, evaluated with a two-term expansion. At the dt and
        // drag values this system uses the error is under 0.2% and it saves a
        // Math.exp per particle per frame.
        const k = Math.max(0, 1 - drag * dt + drag * drag * dt * dt * 0.5);
        vx *= k; vy *= k; vz *= k;
      }

      pool.vx[i] = vx; pool.vy[i] = vy; pool.vz[i] = vz;

      let px = pool.px[i], py = pool.py[i], pz = pool.pz[i];
      py += vy * dt;

      if (flags & PFLAG.ORBIT) {
        // Positional orbit about (cx, cz) with a radial drift. Driving the
        // position rather than integrating a centripetal force is what keeps a
        // vortex stable at any timestep — an integrated orbit spirals outward
        // at 60 Hz and looks like a bug.
        const cx = pool.cx[i], cz = pool.cz[i];
        let dx = px - cx, dz = pz - cz;
        const w = pool.orbit[i] * dt;
        const c = Math.cos(w), s = Math.sin(w);
        const nx = dx * c - dz * s;
        const nz = dx * s + dz * c;
        const r = Math.sqrt(nx * nx + nz * nz);
        const rr = Math.max(0.02, r + pool.radial[i] * dt);
        const inv = r > 1e-5 ? rr / r : 0;
        px = cx + nx * inv;
        pz = cz + nz * inv;
      } else {
        px += vx * dt;
        pz += vz * dt;
      }

      pool.px[i] = px; pool.py[i] = py; pool.pz[i] = pz;
      const rot = pool.rot[i] + pool.spin[i] * dt;
      pool.rot[i] = rot;

      // ---- landing ------------------------------------------------------
      if ((flags & PFLAG.LANDS) !== 0 && py <= pool.groundY[i] && vy < 0) {
        if (land) land(px, pool.groundY[i], pz, pool.tag[i], vx, vy, vz);
        n--;
        if (i !== n) pool._move(i, n);
        continue;
      }

      // ---- curves -------------------------------------------------------
      // Size: cubic ease-out, so a puff expands fast and then hangs — the shape
      // of real expansion against air resistance, and the reason a linearly
      // scaled sprite reads as "an image getting bigger".
      const et = 1 - (1 - t) * (1 - t) * (1 - t);
      const size = pool.s0[i] + (pool.s1[i] - pool.s0[i]) * et;

      const fi = pool.fadeIn[i];
      const rampIn = fi > 1e-4 ? Math.min(1, t / fi) : 1;
      const a = pool.alpha[i] * rampIn * Math.pow(1 - t, pool.fadeOut[i]);

      // ---- write the instance --------------------------------------------
      const o3 = i * 3, o4 = i * 4;
      pool.aPos[o3] = px; pool.aPos[o3 + 1] = py; pool.aPos[o3 + 2] = pz;
      pool.aVel[o3] = vx; pool.aVel[o3 + 1] = vy; pool.aVel[o3 + 2] = vz;

      let w = size, h = size;
      const st = pool.stretch[i];
      if (st !== 0) {
        // Stretch along the direction of travel, proportional to speed. This is
        // what turns an ember into a spark without a second sprite.
        const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        h = size * (1 + sp * st);
      }
      pool.aSR[o3] = w; pool.aSR[o3 + 1] = h; pool.aSR[o3 + 2] = rot;

      pool.aCol[o3] = pool.cr[i]; pool.aCol[o3 + 1] = pool.cg[i]; pool.aCol[o3 + 2] = pool.cb[i];

      pool.aPar[o4] = a;
      pool.aPar[o4 + 1] = pool.tile[i];
      pool.aPar[o4 + 2] = pool.soft[i];
      pool.aPar[o4 + 3] = pool.mode[i];

      i++;
    }

    this._killed += pool.live - n;
    pool.live = n;

    pool.geometry.instanceCount = n;
    pool.mesh.visible = n > 0;
    if (n === 0) return;

    // Upload only the live prefix. Without the update range three re-uploads the
    // whole capacity every frame — 1.6 MB per pool at the ultra budget, for
    // data that is almost entirely dead slots.
    upload(pool.attrPos, n * A_POS);
    upload(pool.attrVel, n * A_VEL);
    upload(pool.attrSR, n * A_SR);
    upload(pool.attrCol, n * A_COL);
    upload(pool.attrPar, n * A_PAR);
  }

  /** Per-frame uniform refresh. Called once; both materials share the object. */
  setCamera(camera, depthTexture, width, height) {
    const u = this.uniforms;
    u.uProj.value.set(camera.near, camera.far, 0, 0);
    u.uScreen.value.set(width, height, 1 / Math.max(1, width), 1 / Math.max(1, height));
    u.uDepth.value = depthTexture ?? null;
    u.uHasDepth.value = depthTexture ? 1 : 0;
  }

  /** Kill everything immediately. Used by `debugBurst('none')` and by shot
   *  setup, which must not inherit the previous shot's transients. */
  clear() {
    this.add.live = 0;
    this.alpha.live = 0;
    this.add.geometry.instanceCount = 0;
    this.alpha.geometry.instanceCount = 0;
    this.add.mesh.visible = false;
    this.alpha.mesh.visible = false;
  }

  stats() {
    return {
      budget: this.budget,
      capacity: this.capacity,
      live: this.live,
      additive: this.add.live,
      alpha: this.alpha.live,
      spawned: this._spawned,
      overflow: this._overflow,
    };
  }

  dispose() {
    this.add.mesh.parent?.remove(this.add.mesh);
    this.alpha.mesh.parent?.remove(this.alpha.mesh);
    this.add.dispose();
    this.alpha.dispose();
    this.matAdd.dispose();
    this.matAlpha.dispose();
  }
}

/** Mark a contiguous prefix of an attribute dirty. Guarded because the update
 *  range API moved in three r155 and a silent no-op here would show up as
 *  particles frozen at their spawn position. */
function upload(attr, count) {
  if (typeof attr.clearUpdateRanges === 'function') {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count);
  }
  attr.needsUpdate = true;
}
