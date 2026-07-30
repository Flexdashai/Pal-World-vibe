import * as THREE from 'three';
import { postMaterial } from './quad.js';
import { DEPTH_LIB, NOISE_LIB, COLOR_LIB, AGX_LIB } from './glsl.js';
import { TUNE } from './tuning.js';
import { buildGradeLut, LUT_SIZE } from './grade.js';

/**
 * The final composite: the one pass that turns an HDR buffer into a frame.
 *
 * Order matters and is not arbitrary:
 *
 *   1. chromatic aberration      — optical, so it happens on scene radiance
 *   2. depth of field blend      — optical
 *   3. bloom                     — optical (lens scatter), energy-conserving LERP
 *   4. vignette                  — optical (lens falloff), so it must be applied
 *                                  as an EXPOSURE change before the tone curve,
 *                                  not as a darkening of the final image. That
 *                                  is the difference between a lens and a black
 *                                  circle drawn on top of the picture.
 *   5. auto exposure             — the shutter
 *   6. AgX tone map + look       — film response
 *   7. sRGB transfer             — display encoding
 *   8. 3D grade LUT              — the colourist's pass, in display space
 *   9. film grain                — added last, in display space, so it is not
 *                                  amplified by the tone curve
 *
 * Everything before step 5 lives in scene-referred linear HDR; everything after
 * step 7 lives in display-referred sRGB. Mixing those two up is the single most
 * common reason a Three.js scene looks "off" in a way nobody can name.
 */

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
varying vec2 vUv;

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tDof;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tVelocity;
uniform sampler2D tAo;
uniform sampler2D tSsr;
uniform sampler2D tExposure;
uniform sampler3D tLut;
uniform int uDebugView;

uniform vec4 uResolution;
uniform float uAspect;
uniform float uBloomStrength;
uniform float uBloomNorm;
uniform vec2 uVignette;        // start, end
uniform float uVignetteStrength;
uniform float uChroma;
uniform vec2 uGrain;           // strength, size
uniform float uFrame;
uniform float uLutSize;
uniform float uFocus;
uniform float uNearRange;
uniform float uFarRange;
uniform float uDofEnabled;

${DEPTH_LIB}
${NOISE_LIB}
${COLOR_LIB}
${AGX_LIB}

void main() {

	// ---- debug views (?renderview=…) ----------------------------------------
	// One uniform branch that every pixel takes identically, so the cost when it
	// is off is a scalar compare. Worth it: "is AO actually doing anything" is
	// otherwise unanswerable from a screenshot, and fx, world and sky all
	// need to be able to look at the depth and normal buffers they consume.
	if ( uDebugView != 0 ) {
		vec3 dbg = vec3( 0.0 );
		if ( uDebugView == 1 ) {                                  // ambient occlusion
			dbg = vec3( texture2D( tAo, vUv ).r );
		} else if ( uDebugView == 2 ) {                           // view normals
			dbg = texture2D( tNormal, vUv ).xyz * 0.5 + 0.5;
		} else if ( uDebugView == 3 ) {                           // linear depth
			float dd = texture2D( tDepth, vUv ).r;
			dbg = vec3( dd >= 0.999999 ? 0.0 : fract( linearDepth( dd ) * 0.2 ) );
		} else if ( uDebugView == 4 ) {                           // reflections only
			dbg = texture2D( tSsr, vUv ).rgb * 4.0;
		} else if ( uDebugView == 5 ) {                           // motion vectors
			dbg = vec3( abs( texture2D( tVelocity, vUv ).rg ) * 40.0, 0.0 );
		} else if ( uDebugView == 6 ) {                           // bloom pyramid
			dbg = texture2D( tBloom, vUv ).rgb * uBloomNorm;
		} else if ( uDebugView == 7 ) {                           // roughness
			dbg = vec3( texture2D( tNormal, vUv ).a );
		}
		gl_FragColor = vec4( srgbEncode( dbg ), 1.0 );
		return;
	}

	vec2 fromCentre = vUv - 0.5;

	// --- 1. chromatic aberration ---------------------------------------------
	// Lateral, quadratic with radius, which is how a real lens behaves: zero in
	// the middle, a pixel and a bit at the corner. Any more and it stops
	// reading as a lens and starts reading as a broken shader.
	vec2 caOffset = fromCentre * dot( fromCentre, fromCentre ) * uChroma;
	vec3 color;
	color.r = texture2D( tColor, vUv + caOffset ).r;
	color.g = texture2D( tColor, vUv ).g;
	color.b = texture2D( tColor, vUv - caOffset ).b;

	// --- 2. depth of field ----------------------------------------------------
	if ( uDofEnabled > 0.5 ) {
		float d = texture2D( tDepth, vUv ).r;
		float z = d >= 0.999999 ? uProjParams.y : linearDepth( d );
		float delta = z - uFocus;
		float coc = clamp( delta >= 0.0 ? delta / uFarRange : delta / uNearRange, -1.0, 1.0 );
		float blend = smoothstep( 0.10, 0.62, abs( coc ) );
		color = mix( color, texture2D( tDof, vUv ).rgb, blend );
	}

	// --- 3. bloom -------------------------------------------------------------
	vec3 bloom = texture2D( tBloom, vUv ).rgb * uBloomNorm;
	color = mix( color, bloom, uBloomStrength );

	// --- 4. vignette, as an optical exposure falloff --------------------------
	float rad = length( fromCentre * vec2( uAspect, 1.0 ) ) / 0.5;
	float vig = 1.0 - uVignetteStrength * smoothstep( uVignette.x, uVignette.y, rad );
	color *= vig;

	// --- 5. exposure ----------------------------------------------------------
	color *= texture2D( tExposure, vec2( 0.5 ) ).g;

	// --- 6. film response -----------------------------------------------------
	color = agx( color );

	// --- 7. display encoding --------------------------------------------------
	color = srgbEncode( color );

	// --- 8. grade LUT ---------------------------------------------------------
	// Remap to texel centres, or the ends of the cube get half a texel of the
	// wrong slice and pure black picks up a tint.
	vec3 lutUv = ( color * ( uLutSize - 1.0 ) + 0.5 ) / uLutSize;
	color = texture( tLut, lutUv ).rgb;

	// --- 9. grain -------------------------------------------------------------
	// Scaled down in highlights the way real film grain behaves: coarse in the
	// shadows, fine in the light. Applied after the LUT so the grade cannot
	// amplify it into visible noise.
	float g = hash12( floor( gl_FragCoord.xy / uGrain.y ) + uFrame * 13.137 ) - 0.5;
	float lum = mnLuminance( color );
	color += g * uGrain.x * ( 1.0 - lum * lum ) * ( 0.35 + 0.65 * ( 1.0 - lum ) );

	gl_FragColor = vec4( clamp( color, 0.0, 1.0 ), 1.0 );

}
`;

/** Additive resolve of the half-resolution SSR buffer into the HDR target.
 *  One tap, one add — cheaper than folding it into the TAA resolve, which would
 *  need the reflection sampled at all nine neighbourhood taps to keep the
 *  variance clip consistent. */
const SSR_ADD_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSsr;
void main() {
	gl_FragColor = vec4( max( texture2D( tSsr, vUv ).rgb, 0.0 ), 1.0 );
}
`;

export class CompositePass {
  constructor(renderer, quad, shared, quality) {
    this.renderer = renderer;
    this.quad = quad;

    this.lut = buildGradeLut(LUT_SIZE);

    this.material = postMaterial({
      name: 'mn.composite',
      fragment: COMPOSITE_FRAG,
      uniforms: {
        tColor: { value: null },
        tBloom: { value: null },
        tDof: { value: null },
        tDepth: shared.depth,
        tNormal: shared.normal,
        tVelocity: shared.velocity,
        tAo: shared.aoTex,
        tSsr: { value: null },
        tExposure: { value: null },
        tLut: { value: this.lut },
        uDebugView: { value: 0 },
        uResolution: { value: new THREE.Vector4(1, 1, 1, 1) },
        uProjParams: shared.projParams,
        uAspect: { value: 16 / 9 },
        uBloomStrength: { value: quality.bloom ? TUNE.bloom.strength : 0 },
        uBloomNorm: { value: 1 },
        uVignette: { value: new THREE.Vector2(TUNE.film.vignetteStart, TUNE.film.vignetteEnd) },
        uVignetteStrength: { value: TUNE.film.vignetteStrength },
        uChroma: { value: 0 },
        uGrain: { value: new THREE.Vector2(quality.grain ? TUNE.film.grainStrength : 0, TUNE.film.grainSize) },
        uFrame: shared.frame,
        uLutSize: { value: LUT_SIZE },
        uFocus: { value: 20 },
        uNearRange: { value: TUNE.dof.nearRange },
        uFarRange: { value: TUNE.dof.farRange },
        uDofEnabled: { value: quality.dof ? 1 : 0 },
        // The AgX "look", applied in log space: slight contrast lift, a touch
        // more toe, and a global desaturation that the grade LUT then selectively
        // undoes for the shadow-magic violet.
        uAgxLook: { value: new THREE.Vector4(1.04, 1.06, -0.004, 0.90) },
      },
    });

    this.ssrAdd = postMaterial({
      name: 'mn.ssr.add',
      fragment: SSR_ADD_FRAG,
      blending: THREE.AdditiveBlending,
      uniforms: { tSsr: { value: null } },
    });
  }

  resize(w, h) {
    const u = this.material.uniforms;
    u.uResolution.value.set(w, h, 1 / w, 1 / h);
    u.uAspect.value = w / h;
    // Chromatic aberration is specified in pixels at the corner; convert to the
    // UV offset the quadratic falloff needs so it is resolution independent.
    u.uChroma.value = (TUNE.film.chromaPx / w) / 0.25;
  }

  setFocus(z) {
    this.material.uniforms.uFocus.value = z;
  }

  /** @param {THREE.WebGLRenderTarget} hdr target to add the reflection into */
  addSsr(hdrTarget, ssrTexture) {
    this.ssrAdd.uniforms.tSsr.value = ssrTexture;
    this.quad.render(this.renderer, this.ssrAdd, hdrTarget);
  }

  render({ color, bloom, bloomNorm, dof, exposure, ssr, target = null }) {
    const u = this.material.uniforms;
    u.tColor.value = color;
    u.tBloom.value = bloom;
    u.uBloomNorm.value = bloomNorm;
    u.tDof.value = dof;
    u.tExposure.value = exposure;
    u.tSsr.value = ssr;
    this.quad.render(this.renderer, this.material, target);
  }

  /** Debug view index; see the switch at the top of the composite shader. */
  setDebugView(v) { this.material.uniforms.uDebugView.value = v | 0; }

  dispose() {
    this.material.dispose();
    this.ssrAdd.dispose();
    this.lut.dispose();
  }
}
