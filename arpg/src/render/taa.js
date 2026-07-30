import * as THREE from 'three';
import { postMaterial } from './quad.js';
import { COLOR_LIB } from './glsl.js';
import { colorTarget, PingPong } from './targets.js';
import { TUNE, buildJitterTable } from './tuning.js';

/**
 * Temporal anti-aliasing with YCoCg neighbourhood variance clipping.
 *
 * TAA is doing three jobs here, not one:
 *   - anti-aliasing (no MSAA: it does not exist for a deferred-ish HDR chain and
 *     would cost 2-4x the fill on a software rasteriser);
 *   - resolving the stochastic passes. GTAO traces 2 slices per frame, SSR
 *     traces one ray per pixel, the occluder fade is a dither and the shadow
 *     kernel is rotated per pixel. Every one of those is designed to be noisy on
 *     a single frame and correct over eight. TAA is what makes that trade legal;
 *   - hiding the shadow-map texel grid, which no amount of PCF fully removes.
 *
 * The clip box is built in YCoCg because it separates luminance from two chroma
 * axes with an add/shift transform, so the box is tight on the axis the eye
 * actually notices. Clipping (moving the history toward the box centre along the
 * ray) rather than clamping (per-channel) avoids the hue shifts that make
 * clamped TAA look like it is smearing colour.
 */

const RESOLVE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform vec2 uTexel;
uniform float uFeedback;
uniform float uGamma;
uniform float uSharpen;
uniform float uMotionBoost;
uniform float uReset;

${COLOR_LIB}

vec3 fetch( vec2 uv ) { return tonemapWeight( max( texture2D( tCurrent, uv ).rgb, 0.0 ) ); }

// Move the history sample toward the neighbourhood centre until it lies inside
// the AABB. Clipping along the ray preserves hue; per-channel clamping does not.
vec3 clipToAABB( vec3 hist, vec3 centre, vec3 halfSize ) {
	vec3 d = hist - centre;
	vec3 t = abs( halfSize ) / max( abs( d ), vec3( 1e-5 ) );
	float k = min( 1.0, min( t.x, min( t.y, t.z ) ) );
	return centre + d * k;
}

void main() {

	vec3 c  = fetch( vUv );
	vec3 n0 = fetch( vUv + vec2( -uTexel.x, -uTexel.y ) );
	vec3 n1 = fetch( vUv + vec2(       0.0, -uTexel.y ) );
	vec3 n2 = fetch( vUv + vec2(  uTexel.x, -uTexel.y ) );
	vec3 n3 = fetch( vUv + vec2( -uTexel.x,       0.0 ) );
	vec3 n4 = fetch( vUv + vec2(  uTexel.x,       0.0 ) );
	vec3 n5 = fetch( vUv + vec2( -uTexel.x,  uTexel.y ) );
	vec3 n6 = fetch( vUv + vec2(       0.0,  uTexel.y ) );
	vec3 n7 = fetch( vUv + vec2(  uTexel.x,  uTexel.y ) );

	vec3 y  = rgbToYCoCg( c );
	vec3 y0 = rgbToYCoCg( n0 ); vec3 y1 = rgbToYCoCg( n1 );
	vec3 y2 = rgbToYCoCg( n2 ); vec3 y3 = rgbToYCoCg( n3 );
	vec3 y4 = rgbToYCoCg( n4 ); vec3 y5 = rgbToYCoCg( n5 );
	vec3 y6 = rgbToYCoCg( n6 ); vec3 y7 = rgbToYCoCg( n7 );

	vec3 m1 = y + y0 + y1 + y2 + y3 + y4 + y5 + y6 + y7;
	vec3 m2 = y * y + y0 * y0 + y1 * y1 + y2 * y2 + y3 * y3
	        + y4 * y4 + y5 * y5 + y6 * y6 + y7 * y7;

	const float inv = 1.0 / 9.0;
	vec3 mean = m1 * inv;
	vec3 sigma = sqrt( max( m2 * inv - mean * mean, vec3( 0.0 ) ) );

	vec2 vel = texture2D( tVelocity, vUv ).rg;
	vec2 histUv = vUv - vel;

	vec3 hist = tonemapWeight( max( texture2D( tHistory, histUv ).rgb, 0.0 ) );
	vec3 histY = clipToAABB( rgbToYCoCg( hist ), mean, sigma * uGamma );
	hist = ycoCgToRgb( histY );

	vec2 inside = step( vec2( 0.0 ), histUv ) * step( histUv, vec2( 1.0 ) );

	float blend = uFeedback * inside.x * inside.y;
	// Disocclusion around a running character otherwise smears for ~10 frames;
	// weighting toward the current sample by motion magnitude fixes it without
	// giving up the still-frame convergence that the noisy passes depend on.
	blend /= ( 1.0 + length( vel ) * uMotionBoost );
	blend *= 1.0 - uReset;

	vec3 res = mix( c, hist, blend );

	// Sharpen using the 3x3 we already fetched for the clip box — free, and it
	// exactly cancels the softening from bilinear history resampling.
	vec3 blur = ( n0 + n1 + n2 + n3 + n4 + n5 + n6 + n7 ) * 0.125;
	res += ( res - blur ) * uSharpen;

	gl_FragColor = vec4( tonemapUnweight( max( res, 0.0 ) ), 1.0 );

}
`;

export class TaaPass {
  constructor(renderer, quad, shared, quality) {
    this.renderer = renderer;
    this.quad = quad;
    this.enabled = !!quality.taa;

    this.history = new PingPong((w, h, tag) => colorTarget(w, h, `mn.taa.${tag}`));
    this.jitter = buildJitterTable(TUNE.taa.samples);
    this.jitterIndex = 0;
    /** Current jitter offset in PIXELS, published so the prepass and any
     *  registered pass can stay in phase. */
    this.offset = new THREE.Vector2();

    this.material = postMaterial({
      name: 'mn.taa',
      fragment: RESOLVE_FRAG,
      uniforms: {
        tCurrent: { value: null },
        tHistory: { value: null },
        tVelocity: shared.velocity,
        uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uFeedback: { value: TUNE.taa.feedback },
        uGamma: { value: TUNE.taa.varianceGamma },
        uSharpen: { value: TUNE.taa.sharpen },
        uMotionBoost: { value: TUNE.taa.motionBoost },
        uReset: shared.reset,
      },
    });
  }

  /** The texture the composite should read. */
  get texture() { return this.enabled ? this.history.read.texture : this._passthrough; }

  resize(w, h) {
    this.width = w;
    this.height = h;
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h);
    if (this.enabled) this.history.allocate(w, h);
  }

  /** Advance the Halton sequence and return the sub-pixel offset for this frame. */
  nextJitter() {
    if (!this.enabled) { this.offset.set(0, 0); return this.offset; }
    const i = (this.jitterIndex % TUNE.taa.samples) * 2;
    this.offset.set(this.jitter[i], this.jitter[i + 1]);
    this.jitterIndex++;
    return this.offset;
  }

  reset() { this.jitterIndex = 0; }

  render(currentTexture) {
    if (!this.enabled) { this._passthrough = currentTexture; return; }
    this.material.uniforms.tCurrent.value = currentTexture;
    this.material.uniforms.tHistory.value = this.history.read.texture;
    this.quad.render(this.renderer, this.material, this.history.write);
    this.history.swap();
  }

  stats() { return { on: this.enabled, samples: TUNE.taa.samples, phase: this.jitterIndex % TUNE.taa.samples }; }

  dispose() {
    this.history.dispose();
    this.material.dispose();
  }
}
