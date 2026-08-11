import * as THREE from 'three';
import { FX } from './tuning.js';

/**
 * MONARCH — screen-space impulses.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * The textbook screen impulse is a UV distortion: sample the composited frame
 * with a radial offset and a chromatic split. It cannot be done here, and the
 * reason is structural rather than a matter of effort:
 *
 *   - `registerPass({ stage: 'final' })` runs AFTER the composite has already
 *     drawn to the canvas, and there is no texture handle for the default
 *     framebuffer. A final pass can add to the frame; it cannot resample it.
 *   - `stage: 'hdr'` renders INTO `rtHDR`, so distorting it would mean reading
 *     and writing one target — a feedback loop — unless a second full-resolution
 *     float target is allocated and two extra fullscreen passes are paid for on
 *     every frame the effect is live. On a CPU rasteriser that is ~2 million
 *     shaded fragments for a 200 ms flourish, which would slow every other
 *     agent's capture loop.
 *
 * So the impulse is delivered by two mechanisms that together read as the same
 * thing and cost almost nothing:
 *
 *   1. **The camera actually moves.** `camera:shake` and `camera:impulse` are
 *      already implemented by `player`'s camera rig, and a real camera
 *      displacement is a *better* impact cue than a UV warp because the parallax
 *      is correct. `fx` emits them with magnitudes tuned per effect.
 *   2. **One additive display-space overlay**, synthesised procedurally with no
 *      source texture: a rim flash, a violet wash for the shadow beats, and up
 *      to two world-anchored shockwave rings that expand from the blast's
 *      projected screen position. One fullscreen draw of pure ALU, and the pass
 *      is `enabled = false` — genuinely skipped — whenever its total energy is
 *      below `FX.screen.epsilon`, which is almost always.
 *
 * The rings being world-anchored is what makes this complementary to `ui`'s DOM
 * vignettes rather than a duplicate of them: `ui` reacts to what happened to the
 * PLAYER, this reacts to what happened at a POINT IN THE WORLD.
 *
 * ---------------------------------------------------------------------------
 * COLOUR SPACE
 *
 * This draws over the canvas, which is the only display-referred surface in the
 * pipeline. The values below are therefore authored in DISPLAY space (roughly
 * sRGB 0..1), not in the linear working space everything upstream uses, and the
 * material must not tone map. Getting this backwards makes the overlay either
 * invisible or a solid white sheet.
 */

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform vec2 uAspect;      // (aspect, 1) so distances are circular
uniform vec4 uImpulse;     // x = impulse energy, y = violet wash, z = time, w = flash
uniform vec3 uTint;
uniform vec4 uWave0;       // xy = screen uv centre, z = radius (uv), w = strength
uniform vec4 uWave1;

vec3 ringTerm( vec4 w, vec2 p ) {
  if ( w.w <= 0.0 ) return vec3( 0.0 );
  vec2 c = ( w.xy - 0.5 ) * uAspect;
  float d = length( p - c );
  // A thin front that widens and dims as it travels — the same energy argument
  // as the world-space ring: a wave that keeps its brightness while growing is
  // gaining energy, and the eye reads that as a light turning up.
  float width = 0.018 + w.z * 0.16;
  float band = exp( -pow( ( d - w.z ) / width, 2.0 ) );
  return uTint * band * w.w;
}

void main() {
  vec2 p = ( vUv - 0.5 ) * uAspect;
  float r = length( p );
  vec3 c = vec3( 0.0 );

  // --- radial impulse -----------------------------------------------------
  // Energy at the EDGE of frame, not the centre: the centre is where the player
  // is looking and a flash there hides the thing that caused it.
  //
  // The coefficients below are a THIRD of the first draft's, and the reason is
  // measured rather than aesthetic. tools/analyze.mjs reports the fraction of
  // the frame crushed below 8/255 and the violet pixel share; a control capture
  // of the hall with no fx sits at dark=48.7%, violet=0.02%. With the first
  // draft's overlay the same framing measured dark=3.1%, violet=37.8% — the
  // overlay alone was lifting every corner of the frame off black and painting
  // the whole image violet. An impulse must be felt at the edge of vision, not
  // seen.
  float e = uImpulse.x;
  if ( e > 0.0 ) {
    float rim = smoothstep( 0.22, 0.78, r );
    c += uTint * rim * rim * e * 0.055;
    // A second, tighter rim in the signature violet, so even a physical impulse
    // carries a little of the game's colour identity out to the corners.
    c += vec3( 0.20, 0.11, 0.44 ) * pow( smoothstep( 0.52, 0.95, r ), 2.0 ) * e * 0.05;
  }

  // --- violet wash (the shadow beats) --------------------------------------
  float v = uImpulse.y;
  if ( v > 0.0 ) {
    c += vec3( 0.030, 0.014, 0.085 ) * v * ( 0.06 + 0.94 * smoothstep( 0.05, 0.95, r ) );
  }

  // --- full-frame flash (the strike) ---------------------------------------
  float f = uImpulse.w;
  if ( f > 0.0 ) c += vec3( 0.16, 0.13, 0.26 ) * f;

  // --- world-anchored shockwave rings --------------------------------------
  c += ringTerm( uWave0, p );
  c += ringTerm( uWave1, p );

  gl_FragColor = vec4( c, 1.0 );
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

export class ScreenImpulse {
  constructor(render) {
    this.render = render;

    this.uniforms = {
      uAspect: { value: new THREE.Vector2(1.777, 1) },
      uImpulse: { value: new THREE.Vector4(0, 0, 0, 0) },
      uTint: { value: new THREE.Vector3(0.85, 0.80, 1.0) },
      uWave0: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
      uWave1: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'mn.fx.screen',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      transparent: true,
      toneMapped: false,
    });

    // `order: 20` so this lands after anything else a subsystem registers at the
    // final stage — an impulse is the last thing that should touch the frame.
    this.pass = render.registerPass({ stage: 'final', order: 20, material: this.material });
    // Left ENABLED here on purpose. `render.prewarmMaterials` runs every final
    // pass once with the canvas bound, and a disabled pass is skipped — so
    // disabling it now would mean this material compiles on the first explosion
    // instead, which on this renderer is a multi-hundred-millisecond stall in
    // the middle of a fight. The first `update()` turns it off, and `update()`
    // always runs before the first real frame.
    this.pass.enabled = true;

    // ---- state -------------------------------------------------------------
    this.energy = 0;
    this.violetAmt = 0;
    this.flashAmt = 0;
    /** Two world-anchored waves: { x, y, z, r, rMax, age, life, strength } */
    this.waves = [
      { active: false, x: 0, y: 0, z: 0, rMax: 1, age: 0, life: 0.4, strength: 0 },
      { active: false, x: 0, y: 0, z: 0, rMax: 1, age: 0, life: 0.4, strength: 0 },
    ];
    this._next = 0;
    this._v = new THREE.Vector3();
  }

  /** A blow landed. `amount` is roughly 0..1 for a normal hit, up to ~1.5. */
  impulse(amount, dirX = 0, dirY = 0) {
    this.energy = Math.min(1.0, this.energy + amount);
    return this;
  }

  /** The shadow beats tint the whole frame. */
  violet(amount) {
    // Capped hard and low. An additive full-frame wash is the fastest way to
    // destroy a near-monochrome art direction: at the previous 1.2 ceiling this
    // single term added ~0.7 of violet to every pixel in the frame and turned a
    // crypt into a lava lamp. It is a TINT, not a light.
    this.violetAmt = Math.min(0.40, this.violetAmt + amount);
    return this;
  }

  /** A single-frame white-violet flash — the STRIKE phase, and nothing else. */
  flash(amount) {
    this.flashAmt = Math.min(1.0, this.flashAmt + amount);
    return this;
  }

  /** A shockwave that expands from a world position, projected to the screen. */
  wave(x, y, z, radius) {
    const w = this.waves[this._next];
    this._next = (this._next + 1) % this.waves.length;
    w.active = true;
    w.x = x; w.y = y; w.z = z;
    w.rMax = Math.max(0.15, radius * 0.09);   // metres -> a fraction of frame
    w.age = 0;
    w.life = FX.screen.waveTime;
    w.strength = Math.min(0.9, 0.18 + radius * 0.06);
    return this;
  }

  /**
   * @param {number} dt   UNSCALED time. The screen impulse is a camera/lens
   *   effect, not a world event: freezing it during hit-stop would make the
   *   flash sit still on the frame, which reads as a stuck overlay.
   */
  update(dt, camera) {
    const decay = Math.exp(-dt / FX.screen.decay);
    this.energy *= decay;
    this.violetAmt *= Math.exp(-dt / (FX.screen.decay * 2.4));
    // The flash is a STEP, so it dies in three frames rather than decaying.
    this.flashAmt = Math.max(0, this.flashAmt - dt * 12);

    const u = this.uniforms;
    u.uImpulse.value.set(this.energy, this.violetAmt, 0, this.flashAmt);

    let any = this.energy > FX.screen.epsilon || this.violetAmt > FX.screen.epsilon || this.flashAmt > 0;

    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const target = i === 0 ? u.uWave0.value : u.uWave1.value;
      if (!w.active) { target.w = 0; continue; }
      w.age += dt;
      const t = w.age / w.life;
      if (t >= 1) { w.active = false; target.w = 0; continue; }

      // Project the world centre. Behind the camera or off frame by more than a
      // screen width, the ring cannot be seen and is skipped entirely.
      this._v.set(w.x, w.y, w.z).project(camera);
      if (this._v.z > 1 || Math.abs(this._v.x) > 2.6 || Math.abs(this._v.y) > 2.6) {
        target.w = 0;
        continue;
      }
      const e = 1 - Math.pow(2, -7 * t);          // expo out, same as the world ring
      target.x = this._v.x * 0.5 + 0.5;
      target.y = this._v.y * 0.5 + 0.5;
      target.z = w.rMax * e;
      target.w = w.strength * Math.pow(1 - t, 2.0);
      any = true;
    }

    // Genuinely skipped when there is nothing to draw. A fullscreen pass that
    // adds zero still costs a full screen of fill on a software rasteriser.
    this.pass.enabled = any;
  }

  resize(w, h) {
    this.uniforms.uAspect.value.set(Math.max(1e-3, w / Math.max(1, h)), 1);
  }

  setTint(r, g, b) { this.uniforms.uTint.value.set(r, g, b); }

  clear() {
    this.energy = 0;
    this.violetAmt = 0;
    this.flashAmt = 0;
    for (const w of this.waves) w.active = false;
    this.uniforms.uWave0.value.w = 0;
    this.uniforms.uWave1.value.w = 0;
    this.uniforms.uImpulse.value.set(0, 0, 0, 0);
    this.pass.enabled = false;
  }

  stats() {
    return {
      energy: +this.energy.toFixed(3),
      violet: +this.violetAmt.toFixed(3),
      waves: this.waves.reduce((n, w) => n + (w.active ? 1 : 0), 0),
      enabled: !!this.pass.enabled,
    };
  }

  dispose() {
    this.render.removePass(this.pass);
    this.material.dispose();
  }
}
