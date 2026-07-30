import * as THREE from 'three';
import { postMaterial } from './quad.js';
import { COLOR_LIB } from './glsl.js';
import { colorTarget, PingPong } from './targets.js';
import { TUNE } from './tuning.js';

/**
 * GPU auto-exposure.
 *
 * The whole lighting model in this game is exposure-driven, not multiplier-
 * driven: `palette.LIGHTS` holds candela-scale intensities (a brazier is 26,
 * a candle 3.2), materials hold physically plausible albedos, and the image is
 * made viewable by choosing a shutter, not by scaling anything. That is the only
 * way a scene stays coherent when `world` adds a second brazier or `fx` fires a
 * 200-unit nova: with a magic multiplier every one of those events would need
 * hand-balancing against the display, and the first one to be wrong makes the
 * whole frame wrong.
 *
 * Three passes, all trivially cheap:
 *   1. full-res HDR -> 96x54 log-luminance, centre-weighted, 4-tap box
 *   2. 96x54 -> 1x1, a single fragment looping over a 16x9 grid
 *   3. 1x1 adaptation, ping-ponged against the previous frame's value
 *
 * Nothing is ever read back to the CPU. `readPixels` on a software rasteriser
 * would stall the pipeline for the whole frame, and on real hardware it costs a
 * sync; the exposure value is consumed as a 1x1 texture by the composite.
 */

const REDUCE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uCentreWeight;

${COLOR_LIB}

void main() {

	// 4-tap box so the sparse reduction (5k of 920k pixels) is an unbiased
	// estimate rather than a point sample of whatever landed on the grid.
	vec3 c = texture2D( tSrc, vUv + vec2( -0.5, -0.5 ) * uTexel ).rgb;
	c += texture2D( tSrc, vUv + vec2(  0.5, -0.5 ) * uTexel ).rgb;
	c += texture2D( tSrc, vUv + vec2( -0.5,  0.5 ) * uTexel ).rgb;
	c += texture2D( tSrc, vUv + vec2(  0.5,  0.5 ) * uTexel ).rgb;
	// Floor the per-pixel luminance before the log. A frame that is 30% pure
	// black would otherwise contribute log2(1e-5) = -16.6 from every one of
	// those pixels and drag the log-average two or three stops below anything
	// the viewer can see, which opens the iris until the lit part of the frame
	// blows out. The floor is the darkest value worth metering: roughly one
	// thousandth of middle grey.
	float lum = max( mnLuminance( c * 0.25 ), 2.0e-4 );

	// Centre-weighted metering. The player sits at the lower third and the top
	// of frame is usually fog or a far wall; without the weight, a bright
	// torch-lit wall at the frame edge stops the hero down into silhouette.
	vec2 d = ( vUv - vec2( 0.5, 0.42 ) ) * vec2( 1.0, 1.25 );
	float w = mix( 1.0, exp( -dot( d, d ) * 3.2 ), uCentreWeight );

	gl_FragColor = vec4( log2( lum ) * w, w, 0.0, 1.0 );

}
`;

const COLLAPSE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uSrcSize;

void main() {

	float sum = 0.0;
	float wsum = 0.0;

	// One fragment, a fixed 16x9 grid over the reduced buffer. 144 taps on a
	// single pixel is free at any resolution.
	for ( int y = 0; y < 9; y ++ ) {
		for ( int x = 0; x < 16; x ++ ) {
			vec2 uv = ( vec2( float( x ), float( y ) ) + 0.5 ) / vec2( 16.0, 9.0 );
			vec2 s = texture2D( tSrc, uv ).rg;
			sum += s.r;
			wsum += s.g;
		}
	}

	gl_FragColor = vec4( sum / max( wsum, 1e-4 ), 0.0, 0.0, 1.0 );

}
`;

const ADAPT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tLogLum;
uniform sampler2D tPrev;
uniform float uDt;
uniform float uTauUp;
uniform float uTauDown;
uniform float uMinEV;
uniform float uMaxEV;
uniform float uCompensation;
uniform float uK;
uniform float uReset;

void main() {

	float logLum = texture2D( tLogLum, vec2( 0.5 ) ).r;
	float avgLum = max( exp2( logLum ), 1e-5 );

	// Standard reflected-light meter: EV100 = log2( L * 100 / K ).
	float ev = log2( avgLum * 100.0 / uK );
	ev = clamp( ev - uCompensation, uMinEV, uMaxEV );

	float prev = texture2D( tPrev, vec2( 0.5 ) ).r;
	if ( prev <= 0.0 || uReset > 0.5 ) prev = ev;

	// Separate time constants: the iris closes far faster than it opens, and
	// matching that is most of why an exposure change reads as natural rather
	// than as a cross-fade.
	float tau = ev > prev ? uTauUp : uTauDown;
	float k = 1.0 - exp( -uDt / max( tau, 1e-3 ) );
	float outEv = mix( prev, ev, uReset > 0.5 ? 1.0 : k );

	// Stored as EV in .r; the linear multiplier the composite wants in .g, so
	// the composite does not have to exp2 per pixel.
	// Saturation-based exposure: H = q * L / S with q = 0.65, S = 100.
	float exposure = 1.0 / ( 1.2 * exp2( outEv ) );

	gl_FragColor = vec4( outEv, exposure, avgLum, 1.0 );

}
`;

export class ExposurePass {
  constructor(renderer, quad, shared, config) {
    this.renderer = renderer;
    this.quad = quad;
    this.config = config;

    this.rtReduce = colorTarget(96, 54, 'mn.exposure.reduce');
    // The two 1x1 targets are full FLOAT rather than half float purely so the
    // value can be read back into a Float32Array from `stats()`. Exposure is the
    // one number in the pipeline whose wrongness is invisible in a screenshot
    // (everything just looks a bit off) and impossible to reason about without
    // seeing it, so it is worth two float texels to be able to print it.
    this.rtLum = colorTarget(1, 1, 'mn.exposure.lum', { type: THREE.FloatType });
    this.adapt = new PingPong((w, h, tag) =>
      colorTarget(w, h, `mn.exposure.${tag}`, { type: THREE.FloatType }));
    this.adapt.allocate(1, 1);
    this._readback = new Float32Array(4);

    this.matReduce = postMaterial({
      name: 'mn.exposure.reduce',
      fragment: REDUCE_FRAG,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uCentreWeight: { value: TUNE.exposure.centreWeight },
      },
    });

    this.matCollapse = postMaterial({
      name: 'mn.exposure.collapse',
      fragment: COLLAPSE_FRAG,
      uniforms: {
        tSrc: { value: this.rtReduce.texture },
        uSrcSize: { value: new THREE.Vector2(96, 54) },
      },
    });

    this.matAdapt = postMaterial({
      name: 'mn.exposure.adapt',
      fragment: ADAPT_FRAG,
      uniforms: {
        tLogLum: { value: this.rtLum.texture },
        tPrev: { value: null },
        uDt: { value: 1 / 60 },
        uTauUp: { value: TUNE.exposure.tauUp },
        uTauDown: { value: TUNE.exposure.tauDown },
        uMinEV: { value: TUNE.exposure.minEV },
        uMaxEV: { value: TUNE.exposure.maxEV },
        // config.exposure is the player-facing brightness slider: one stop per
        // unit, centred on 1.0.
        uCompensation: { value: TUNE.exposure.compensationEV },
        uK: { value: TUNE.exposure.K },
        uReset: shared.reset,
      },
    });
  }

  /** 1x1 texture: r = EV100, g = linear exposure multiplier, b = measured luma. */
  get texture() { return this.adapt.read.texture; }

  resize(fullW, fullH) {
    this.matReduce.uniforms.uTexel.value.set(1 / fullW, 1 / fullH);
  }

  render(hdrTexture, dt) {
    const r = this.renderer;
    this.matReduce.uniforms.tSrc.value = hdrTexture;
    this.quad.render(r, this.matReduce, this.rtReduce);
    this.quad.render(r, this.matCollapse, this.rtLum);

    this.matAdapt.uniforms.uDt.value = Math.min(0.25, Math.max(1e-4, dt));
    // The player-facing exposure slider from config: >1 brightens, so it
    // subtracts EV.
    this.matAdapt.uniforms.uCompensation.value =
      TUNE.exposure.compensationEV + Math.log2(Math.max(0.05, this.config.exposure));
    this.matAdapt.uniforms.tPrev.value = this.adapt.read.texture;
    this.quad.render(r, this.matAdapt, this.adapt.write);
    this.adapt.swap();
  }

  /**
   * Read the current metering state back to the CPU. DIAGNOSTIC ONLY — this is a
   * pipeline stall and must never be called from `render()`. `stats()` calls it,
   * which is once per probe invocation.
   */
  readState() {
    try {
      this.renderer.readRenderTargetPixels(this.adapt.read, 0, 0, 1, 1, this._readback);
      return {
        ev100: +this._readback[0].toFixed(3),
        exposure: +this._readback[1].toFixed(5),
        sceneLuminance: +this._readback[2].toFixed(6),
      };
    } catch (err) {
      return { error: String(err?.message ?? err) };
    }
  }

  dispose() {
    this.rtReduce.dispose();
    this.rtLum.dispose();
    this.adapt.dispose();
    this.matReduce.dispose();
    this.matCollapse.dispose();
    this.matAdapt.dispose();
  }
}
