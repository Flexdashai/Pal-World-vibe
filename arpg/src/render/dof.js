import * as THREE from 'three';
import { postMaterial } from './quad.js';
import { DEPTH_LIB } from './glsl.js';
import { colorTarget, disposeTarget } from './targets.js';
import { TUNE } from './tuning.js';

/**
 * Depth of field, half resolution, focused on the player.
 *
 * Deliberately tiny. Real Diablo IV frames are not photographic — they have a
 * gentle softening at the very top and very bottom of frame and nothing else.
 * With a camera locked at -52 degrees that falloff is free: the top of the image
 * IS the far plane and the bottom IS the near plane, so a small symmetric CoC
 * around the player's depth produces exactly the reference look. It reads as
 * production value; anything stronger reads as a bug.
 *
 * The blur is a golden-angle spiral gather with a per-tap CoC test, which is the
 * cheapest gather that does not leak sharp foreground pixels into a blurred
 * background.
 */

const DOF_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec4 uResolution;    // half-res w,h,1/w,1/h
uniform float uFocus;        // metres, view depth of the focus plane
uniform float uNearRange;
uniform float uFarRange;
uniform float uMaxCoC;       // in HALF-res pixels

${DEPTH_LIB}

float cocAt( vec2 uv ) {
	float d = texture2D( tDepth, uv ).r;
	if ( d >= 0.999999 ) return 1.0;               // sky is always at the far limit
	float z = linearDepth( d );
	float delta = z - uFocus;
	return clamp( delta >= 0.0 ? delta / uFarRange : delta / uNearRange, -1.0, 1.0 );
}

void main() {

	float c0 = cocAt( vUv );
	float r0 = abs( c0 ) * uMaxCoC;

	vec3 sum = texture2D( tColor, vUv ).rgb;
	float wsum = 1.0;

	// Golden-angle spiral: the most even coverage available without a
	// precomputed kernel, and it degrades gracefully if the tap count changes.
	//
	// There is deliberately NO per-tap circle-of-confusion test here. The usual
	// reason for one is to stop a sharp foreground object bleeding a halo into
	// the blurred background behind it — but that costs a second depth fetch on
	// every tap, doubling the cost of the whole pass, and with a maximum CoC of
	// six full-resolution pixels the halo it prevents is under half a pixel wide.
	// The composite then blends by the FULL-resolution CoC, so anything actually
	// in focus never sees this buffer at all.
	const float GOLDEN = 2.39996323;

	for ( int i = 0; i < MN_DOF_TAPS; i ++ ) {

		float fi = float( i ) + 1.0;
		float a = fi * GOLDEN;
		float t = fi / float( MN_DOF_TAPS );
		float rad = sqrt( t ) * r0;
		vec2 off = vec2( cos( a ), sin( a ) ) * rad * uResolution.zw;

		// Slight centre weighting so the disc has no hard rim.
		float w = 1.0 - 0.35 * t;
		sum += texture2D( tColor, vUv + off ).rgb * w;
		wsum += w;

	}

	gl_FragColor = vec4( sum / wsum, c0 );

}
`;

export class DofPass {
  constructor(renderer, quad, shared, quality) {
    this.renderer = renderer;
    this.quad = quad;
    this.enabled = !!quality.dof;
    this.rt = null;
    this.width = 1;
    this.height = 1;

    this.uResolution = { value: new THREE.Vector4(1, 1, 1, 1) };

    this.material = postMaterial({
      name: 'mn.dof',
      fragment: DOF_FRAG,
      defines: { MN_DOF_TAPS: TUNE.dof.taps },
      uniforms: {
        tColor: { value: null },
        tDepth: shared.depth,
        uResolution: this.uResolution,
        uProjParams: shared.projParams,
        uFocus: { value: 20 },
        uNearRange: { value: TUNE.dof.nearRange },
        uFarRange: { value: TUNE.dof.farRange },
        uMaxCoC: { value: TUNE.dof.maxCoCPx * 0.5 },
      },
    });

    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
  }

  get texture() { return this.enabled && this.rt ? this.rt.texture : this.black; }

  resize(fullW, fullH) {
    this.width = Math.max(1, fullW >> 1);
    this.height = Math.max(1, fullH >> 1);
    if (!this.enabled) return;
    disposeTarget(this.rt);
    this.rt = colorTarget(this.width, this.height, 'mn.dof');
    this.uResolution.value.set(this.width, this.height, 1 / this.width, 1 / this.height);
    // CoC is expressed in half-res pixels inside the pass.
    this.material.uniforms.uMaxCoC.value = TUNE.dof.maxCoCPx * 0.5 * (fullW / 1280);
  }

  /** @param {number} focusViewDepth positive metres along -Z */
  setFocus(focusViewDepth) {
    this.material.uniforms.uFocus.value = focusViewDepth;
  }

  render(colorTexture) {
    if (!this.enabled) return;
    this.material.uniforms.tColor.value = colorTexture;
    this.quad.render(this.renderer, this.material, this.rt);
  }

  stats() { return this.enabled ? { on: true, res: `${this.width}x${this.height}`, taps: TUNE.dof.taps } : { on: false }; }

  dispose() {
    disposeTarget(this.rt);
    this.material.dispose();
    this.black.dispose();
  }
}
