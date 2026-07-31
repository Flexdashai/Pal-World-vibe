import * as THREE from 'three';
import { FX } from './tuning.js';

/**
 * MONARCH — ribbons: weapon-swing sheets, projectile trails, dash streaks and
 * the tail on every shadow soldier.
 *
 * ---------------------------------------------------------------------------
 * ONE GEOMETRY, ONE DRAW CALL, N RIBBONS
 *
 * Every ribbon in the game shares a single BufferGeometry and a single additive
 * material. Each owns a fixed slice of the vertex buffer, so a ribbon appearing
 * or disappearing writes vertices — it never touches the index buffer, never
 * allocates, and never adds a draw call. Unused segments are written with alpha
 * zero and are discarded in the fragment shader before they cost any fill.
 *
 * ---------------------------------------------------------------------------
 * TWO EXPANSION MODES, BECAUSE A SWORD TRAIL IS NOT A PROJECTILE TRAIL
 *
 * A projectile trail is a camera-facing tube: the sheet must always present its
 * width to the lens, or it disappears when the projectile flies toward the
 * camera. A sword trail is NOT camera-facing — it is the surface the blade swept
 * through, bounded by the hilt and the tip, and forcing it to face the camera
 * destroys the one thing it is communicating.
 *
 * So each sample carries an explicit expansion axis. Zero length means
 * "camera-facing, use the width"; non-zero means "this is the half-vector from
 * the centre of the sheet to its edge, use it exactly". One shader, one buffer,
 * both behaviours.
 *
 * ---------------------------------------------------------------------------
 * SAMPLES ARE LAID DOWN BY DISTANCE, NOT BY TIME
 *
 * A stationary emitter that appends a sample every frame piles every sample on
 * one point; the ribbon collapses to a bright dot and the fade looks like a
 * flickering light. `FX.ribbons.minStep` is the minimum travel before a new
 * sample is recorded — below it the newest sample is UPDATED in place instead,
 * which also keeps the head of the ribbon welded to a moving weapon.
 */

const VERT = /* glsl */ `
attribute vec3 aAxis;      // half-vector to the ribbon edge; zero = camera-facing
attribute vec3 aParams;    // x = side (-1/+1), y = width, z = alpha
attribute vec3 aColor;
attribute vec3 aTangent;   // direction along the ribbon

varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;
varying float vViewZ;

void main() {
  vec3 centre = position;
  vec3 offset;

  float axisLen = length( aAxis );
  if ( axisLen > 1e-5 ) {
    offset = aAxis * aParams.x;
  } else {
    // Camera-facing expansion, exactly as the particle billboard does it: the
    // rows of viewMatrix are the camera's world axes.
    vec3 camFwd = vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );
    vec3 t = aTangent;
    float tl = length( t );
    t = tl > 1e-5 ? t / tl : vec3( 1.0, 0.0, 0.0 );
    vec3 r = cross( t, camFwd );
    float rl = length( r );
    vec3 camRight = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
    r = rl > 1e-5 ? r / rl : camRight;
    offset = r * ( aParams.y * aParams.x );
  }

  vec3 world = centre + offset;
  vUv = vec2( aParams.x * 0.5 + 0.5, 0.0 );
  vColor = aColor;
  vAlpha = aParams.z;

  vec4 mv = viewMatrix * vec4( world, 1.0 );
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uDepth;
uniform vec4 uProj;
uniform vec4 uScreen;
uniform float uHasDepth;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;
varying float vViewZ;

float mnLinearDepth( float d ) {
  float n = uProj.x, f = uProj.y;
  float z = d * 2.0 - 1.0;
  return ( 2.0 * n * f ) / ( f + n - z * ( f - n ) );
}

void main() {
  if ( vAlpha < 0.004 ) discard;
  // Across the ribbon: a hot core with a soft edge. The profile is the whole
  // look — a flat sheet reads as a strip of paper, a cored one reads as energy.
  float x = vUv.x * 2.0 - 1.0;
  float edge = 1.0 - x * x;
  float core = pow( edge, 6.0 );
  float body = pow( max( edge, 0.0 ), 1.4 );
  float a = ( body * 0.55 + core * 0.85 ) * vAlpha;
  if ( a < 0.004 ) discard;

  if ( uHasDepth > 0.5 ) {
    float d = texture2D( uDepth, gl_FragCoord.xy * uScreen.zw ).x;
    a *= clamp( ( mnLinearDepth( d ) - vViewZ ) / 0.35, 0.0, 1.0 );
  }

  gl_FragColor = vec4( vColor * ( 0.55 + 0.85 * core ), a );
}
`;

/** Floats per stored sample: position(3), axis(3), width, age. */
const SAMPLE = 8;

export class RibbonPool {
  /**
   * @param {object} sharedUniforms uDepth/uProj/uScreen/uHasDepth from the
   *        particle system, so the per-frame write happens exactly once.
   */
  constructor(sharedUniforms, count = FX.ribbons.count, segments = FX.ribbons.segments) {
    this.count = count;
    this.S = segments + 1;                    // samples per ribbon
    const verts = count * this.S * 2;

    this.pos = new Float32Array(verts * 3);
    this.axis = new Float32Array(verts * 3);
    this.par = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 3);
    this.tan = new Float32Array(verts * 3);

    const geo = new THREE.BufferGeometry();
    const attr = (a, n) => {
      const b = new THREE.BufferAttribute(a, n);
      b.setUsage(THREE.DynamicDrawUsage);
      return b;
    };
    this.aPos = attr(this.pos, 3);
    this.aAxis = attr(this.axis, 3);
    this.aPar = attr(this.par, 3);
    this.aCol = attr(this.col, 3);
    this.aTan = attr(this.tan, 3);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aAxis', this.aAxis);
    geo.setAttribute('aParams', this.aPar);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aTangent', this.aTan);

    // Static index: (S-1) quads per ribbon, built once and never touched.
    const quads = (this.S - 1) * count;
    const idx = new Uint16Array(quads * 6);
    let w = 0;
    for (let r = 0; r < count; r++) {
      const base = r * this.S * 2;
      for (let s = 0; s < this.S - 1; s++) {
        const a = base + s * 2, b = a + 1, c = a + 2, d = a + 3;
        idx[w++] = a; idx[w++] = b; idx[w++] = c;
        idx[w++] = b; idx[w++] = d; idx[w++] = c;
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDepth: sharedUniforms.uDepth,
        uProj: sharedUniforms.uProj,
        uScreen: sharedUniforms.uScreen,
        uHasDepth: sharedUniforms.uHasDepth,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.material.name = 'mn.fx.ribbons';

    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'mn.fx.ribbons';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.mnNoPrepass = true;
    this.mesh.userData.mnNoShadow = true;
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;

    // ---- per-ribbon state --------------------------------------------------
    this.samples = new Float32Array(count * this.S * SAMPLE);
    this.n = new Int32Array(count);           // live samples
    this.busy = new Uint8Array(count);
    this.emitting = new Uint8Array(count);
    this.ticket = new Int32Array(count);
    this.life = new Float32Array(count);
    this.width = new Float32Array(count);
    this.intensity = new Float32Array(count);
    this.taper = new Float32Array(count);
    this.cr = new Float32Array(count);
    this.cg = new Float32Array(count);
    this.cb = new Float32Array(count);
    this._nextTicket = 1;
    this._live = 0;
  }

  attach(scene) { scene.add(this.mesh); }

  /**
   * Take a ribbon.
   * @param {object} o color[3], width, life, intensity, taper
   */
  acquire(o = {}) {
    let slot = -1;
    for (let i = 0; i < this.count; i++) if (!this.busy[i]) { slot = i; break; }
    if (slot < 0) {
      // Steal the ribbon with the fewest samples — the one that has said the
      // least so far, so cutting it costs the least information.
      let fewest = Infinity;
      for (let i = 0; i < this.count; i++) if (this.n[i] < fewest) { fewest = this.n[i]; slot = i; }
    }
    this.busy[slot] = 1;
    this.emitting[slot] = 1;
    this.n[slot] = 0;
    this.ticket[slot] = this._nextTicket++;
    this.life[slot] = o.life ?? 0.4;
    this.width[slot] = o.width ?? 0.12;
    this.intensity[slot] = o.intensity ?? 1;
    this.taper[slot] = o.taper ?? 1;
    const c = o.color ?? WHITE;
    this.cr[slot] = c[0]; this.cg[slot] = c[1]; this.cb[slot] = c[2];
    return slot;
  }

  valid(slot, ticket) {
    return slot >= 0 && slot < this.count && this.busy[slot] === 1 && this.ticket[slot] === ticket;
  }

  ticketOf(slot) { return slot >= 0 ? this.ticket[slot] : 0; }

  /**
   * Add (or refresh) the head sample.
   * `ax/ay/az` is the half-vector to the ribbon edge; pass zeros for a
   * camera-facing tube of the ribbon's own width.
   */
  push(slot, ticket, x, y, z, ax = 0, ay = 0, az = 0, width = -1) {
    if (!this.valid(slot, ticket)) return false;
    const S = this.S;
    const base = slot * S * SAMPLE;
    const n = this.n[slot];
    const w = width >= 0 ? width : this.width[slot];

    if (n > 0) {
      const h = base + (n - 1) * SAMPLE;
      const dx = x - this.samples[h], dy = y - this.samples[h + 1], dz = z - this.samples[h + 2];
      if (dx * dx + dy * dy + dz * dz < FX.ribbons.minStep * FX.ribbons.minStep) {
        // Too close to the head: move the head instead of laying a new sample,
        // so the ribbon stays welded to the emitter without piling up.
        this.samples[h] = x; this.samples[h + 1] = y; this.samples[h + 2] = z;
        this.samples[h + 3] = ax; this.samples[h + 4] = ay; this.samples[h + 5] = az;
        this.samples[h + 6] = w;
        return true;
      }
    }

    let slotIdx = n;
    if (n >= S) {
      // Full: shift everything down one and drop the oldest. 21 samples of 8
      // floats is 168 words — cheaper than the modular indexing it replaces and
      // it keeps the buffer in draw order, which the vertex writer relies on.
      this.samples.copyWithin(base, base + SAMPLE, base + S * SAMPLE);
      slotIdx = S - 1;
    } else {
      this.n[slot] = n + 1;
    }
    const p = base + slotIdx * SAMPLE;
    this.samples[p] = x; this.samples[p + 1] = y; this.samples[p + 2] = z;
    this.samples[p + 3] = ax; this.samples[p + 4] = ay; this.samples[p + 5] = az;
    this.samples[p + 6] = w;
    this.samples[p + 7] = 0;
    return true;
  }

  /** Stop laying samples; the tail fades out and the slot frees itself. */
  stop(slot, ticket) {
    if (!this.valid(slot, ticket)) return false;
    this.emitting[slot] = 0;
    return true;
  }

  /** Drop it immediately. */
  kill(slot, ticket) {
    if (!this.valid(slot, ticket)) return false;
    this.busy[slot] = 0;
    this.emitting[slot] = 0;
    this.n[slot] = 0;
    return true;
  }

  /**
   * Age every sample and rebuild the vertex buffers.
   *
   * One pass writes positions, axes, tangents, colours and alphas for every
   * ribbon including the empty ones — writing zero alpha for an unused slot is
   * cheaper than tracking which ranges are dirty, and the whole buffer is 672
   * vertices.
   */
  update(dt) {
    const S = this.S;
    let anyLive = 0;

    for (let r = 0; r < this.count; r++) {
      const vbase = r * S * 2;
      if (!this.busy[r]) {
        // Zero the alpha of this ribbon's whole slice.
        for (let s = 0; s < S * 2; s++) this.par[(vbase + s) * 3 + 2] = 0;
        continue;
      }

      const base = r * S * SAMPLE;
      let n = this.n[r];
      const life = this.life[r];

      // Age, and retire samples from the TAIL, which is where they were laid
      // first. Ageing the whole ribbon uniformly would make it vanish at once.
      let firstLive = 0;
      for (let s = 0; s < n; s++) {
        const p = base + s * SAMPLE;
        this.samples[p + 7] += dt;
        if (this.samples[p + 7] >= life) firstLive = s + 1;
      }
      if (firstLive > 0) {
        if (firstLive >= n) {
          n = 0;
        } else {
          this.samples.copyWithin(base, base + firstLive * SAMPLE, base + n * SAMPLE);
          n -= firstLive;
        }
        this.n[r] = n;
      }

      if (n === 0 && !this.emitting[r]) {
        this.busy[r] = 0;
        for (let s = 0; s < S * 2; s++) this.par[(vbase + s) * 3 + 2] = 0;
        continue;
      }
      anyLive++;

      const cr = this.cr[r] * this.intensity[r];
      const cg = this.cg[r] * this.intensity[r];
      const cb = this.cb[r] * this.intensity[r];
      const taper = this.taper[r];

      for (let s = 0; s < S; s++) {
        const v0 = (vbase + s * 2) * 3;
        const v1 = v0 + 3;
        if (s >= n) {
          this.par[v0 + 2] = 0; this.par[v1 + 2] = 0;
          // Collapse unused vertices onto the last live sample so the degenerate
          // triangles have zero area and cannot rasterise a single pixel even
          // if a driver ignores the discard.
          const src = n > 0 ? base + (n - 1) * SAMPLE : base;
          for (let k = 0; k < 3; k++) { this.pos[v0 + k] = this.samples[src + k]; this.pos[v1 + k] = this.samples[src + k]; }
          continue;
        }
        const p = base + s * SAMPLE;
        const x = this.samples[p], y = this.samples[p + 1], z = this.samples[p + 2];
        const ax = this.samples[p + 3], ay = this.samples[p + 4], az = this.samples[p + 5];
        const w = this.samples[p + 6];
        const age = this.samples[p + 7];

        // Tangent from the neighbouring samples; used only by the camera-facing
        // branch, but computed unconditionally because the branch is per vertex
        // in the shader and a stale tangent would show up as a twisted ribbon.
        const pa = base + Math.max(0, s - 1) * SAMPLE;
        const pb = base + Math.min(n - 1, s + 1) * SAMPLE;
        const tx = this.samples[pb] - this.samples[pa];
        const ty = this.samples[pb + 1] - this.samples[pa + 1];
        const tz = this.samples[pb + 2] - this.samples[pa + 2];

        // Two fades multiply: age (the tail dissolves) and position along the
        // ribbon (the tail is also thinner). Sharing one would make the ribbon
        // read as a uniformly fading strip.
        const ageF = 1 - age / life;
        const alongF = n > 1 ? Math.pow(s / (n - 1), taper) : 1;
        const a = ageF * ageF * (0.25 + 0.75 * alongF);
        const ww = w * (0.35 + 0.65 * alongF) * ageF;

        for (let side = 0; side < 2; side++) {
          const v = side === 0 ? v0 : v1;
          this.pos[v] = x; this.pos[v + 1] = y; this.pos[v + 2] = z;
          this.axis[v] = ax * (0.35 + 0.65 * alongF);
          this.axis[v + 1] = ay * (0.35 + 0.65 * alongF);
          this.axis[v + 2] = az * (0.35 + 0.65 * alongF);
          this.tan[v] = tx; this.tan[v + 1] = ty; this.tan[v + 2] = tz;
          this.par[v] = side === 0 ? -1 : 1;
          this.par[v + 1] = ww;
          this.par[v + 2] = a;
          this.col[v] = cr; this.col[v + 1] = cg; this.col[v + 2] = cb;
        }
      }
    }

    this._live = anyLive;
    this.mesh.visible = anyLive > 0;
    if (!anyLive) return;
    this.aPos.needsUpdate = true;
    this.aAxis.needsUpdate = true;
    this.aPar.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aTan.needsUpdate = true;
  }

  clear() {
    for (let r = 0; r < this.count; r++) { this.busy[r] = 0; this.emitting[r] = 0; this.n[r] = 0; }
    this.par.fill(0);
    this.aPar.needsUpdate = true;
    this.mesh.visible = false;
  }

  stats() { return { pool: this.count, live: this._live, segments: this.S - 1 }; }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

const WHITE = [1, 1, 1];
