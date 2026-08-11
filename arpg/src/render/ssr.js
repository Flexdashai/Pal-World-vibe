import * as THREE from 'three';
import { postMaterial } from './quad.js';
import { DEPTH_LIB, NOISE_LIB, COLOR_LIB } from './glsl.js';
import { colorTarget, PingPong } from './targets.js';
import { TUNE } from './tuning.js';

/**
 * Screen-space reflections, half resolution, roughness-aware.
 *
 * This is one of the two or three things that most separates a Diablo IV frame
 * from an amateur Three.js scene. Their floors read WET: every brazier, every
 * spell, every rim of light on a pillar appears again, stretched, in the stone
 * underfoot. Without it, a physically-lit dungeon still reads as dry matte
 * cardboard no matter how good the albedo and normal maps are.
 *
 * Design notes:
 *
 *  - **One stochastic ray per pixel**, importance-sampled against the GGX lobe
 *    of the surface, with the sample advanced by frame index. A rough surface
 *    therefore produces a noisy reflection which the temporal filter and TAA
 *    resolve into a correctly-blurred one. This is strictly better than tracing
 *    the mirror direction and blurring afterwards: the blur then respects the
 *    actual surface, so a wet patch next to a dry patch has a hard boundary,
 *    which is exactly what puddled stone looks like.
 *  - **Early-out above `maxRoughness`.** Most of a crypt is rough stone whose
 *    reflection is indistinguishable from the env map. Skipping those pixels is
 *    the single biggest saving in the pass and costs nothing visually.
 *  - Fresnel is applied HERE and the result stored pre-weighted, so the resolve
 *    is a plain add and TAA can treat reflections as part of the scene colour.
 */

const SSR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tColor;      // HDR scene, full res
uniform sampler2D tDepth;
uniform sampler2D tNormal;     // rgb = view normal, a = roughness
uniform sampler2D tVelMetal;   // rg = motion, b = metalness
uniform sampler2D tHistory;

uniform vec4 uResolution;      // half-res w, h, 1/w, 1/h
uniform float uFrame;
uniform float uReset;
uniform float uMaxDistance;
uniform float uStep0;
uniform float uThickness;
uniform float uMaxRoughness;
uniform float uIntensity;
uniform float uEdgeFade;
uniform float uFeedback;

${DEPTH_LIB}
${NOISE_LIB}
${COLOR_LIB}

void main() {

	vec4 nr = texture2D( tNormal, vUv );
	float rough = nr.a;
	float d = texture2D( tDepth, vUv ).r;

	// Sky, or a surface too rough for a coherent reflection.
	if ( d >= 0.999999 || rough > uMaxRoughness ) { gl_FragColor = vec4( 0.0 ); return; }

	vec3 P = viewPosFromDepth( vUv, d );
	vec3 N = normalize( nr.xyz );
	vec3 V = normalize( -P );

	float NdotV = clamp( dot( N, V ), 1e-4, 1.0 );
	float metal = texture2D( tVelMetal, vUv ).b;

	// --- importance-sample the GGX lobe --------------------------------------
	vec2 xi = hash22( gl_FragCoord.xy + uFrame * 37.13 );
	xi.x = fract( xi.x + uFrame * 0.6180339887 );

	vec3 up = abs( N.z ) < 0.9 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 T = normalize( cross( up, N ) );
	vec3 B = cross( N, T );

	float a = rough * rough;
	float phi = 6.28318530718 * xi.x;
	float cosT = sqrt( ( 1.0 - xi.y ) / max( 1e-5, 1.0 + ( a * a - 1.0 ) * xi.y ) );
	float sinT = sqrt( max( 0.0, 1.0 - cosT * cosT ) );
	vec3 H = normalize( T * ( sinT * cos( phi ) ) + B * ( sinT * sin( phi ) ) + N * cosT );

	vec3 R = reflect( -V, H );

	// A ray that points back toward the camera can only ever hit geometry
	// behind the camera; bail rather than marching it.
	if ( dot( R, N ) <= 0.0 ) { gl_FragColor = vec4( 0.0 ); return; }

	// --- march ----------------------------------------------------------------
	// Steps grow geometrically and the first step is sized so the sum of all of
	// them is exactly maxDistance: dense where the contact reflection that
	// sells wetness lives, still reaching a brazier across the hall. A uniform
	// step distribution wastes most of its samples in the far field where the
	// reflection is a smear anyway.
	float jitter = ignFrame( gl_FragCoord.xy, uFrame );
	float stepLen = uStep0;
	// Start just off the surface, biased along the normal so the very first
	// sample cannot self-intersect at grazing angles.
	vec3 rayPos = P + N * ( 0.015 + 0.004 * -P.z ) + R * ( stepLen * ( 0.35 + 0.65 * jitter ) );
	vec3 prevPos = rayPos;

	float hit = 0.0;
	vec2 hitUv = vec2( 0.0 );
	float travelled = stepLen;

	for ( int i = 0; i < MN_SSR_STEPS; i ++ ) {

		vec3 uvd = uvFromViewPos( rayPos );

		if ( uvd.x < 0.0 || uvd.x > 1.0 || uvd.y < 0.0 || uvd.y > 1.0 || rayPos.z > -uProjParams.x ) break;

		float sceneD = texture2D( tDepth, uvd.xy ).r;
		float sceneZ = linearDepth( sceneD );
		float rayZ = -rayPos.z;
		float diff = rayZ - sceneZ;

		if ( diff > 0.0 && diff < uThickness + travelled * 0.06 && sceneD < 0.999999 ) {

			// --- binary refinement ------------------------------------------
			vec3 lo = prevPos, hi = rayPos;
			for ( int k = 0; k < MN_SSR_REFINE; k ++ ) {
				vec3 mid = ( lo + hi ) * 0.5;
				vec3 mu = uvFromViewPos( mid );
				float md = linearDepth( texture2D( tDepth, mu.xy ).r );
				if ( -mid.z > md ) hi = mid; else lo = mid;
			}
			vec3 fu = uvFromViewPos( hi );
			hitUv = fu.xy;
			hit = 1.0;
			break;

		}

		prevPos = rayPos;
		rayPos += R * stepLen;
		travelled += stepLen;
		stepLen *= MN_SSR_GROWTH;
		if ( travelled > uMaxDistance ) break;

	}

	vec3 reflected = vec3( 0.0 );
	float confidence = 0.0;

	if ( hit > 0.5 ) {

		// The hit surface must face the incoming ray; otherwise we have marched
		// through the back of an object and are reflecting its interior.
		vec3 hitN = normalize( texture2D( tNormal, hitUv ).xyz );
		float facing = clamp( -dot( hitN, R ), 0.0, 1.0 );

		// Screen-edge fade. A reflection that is cut off at the frame boundary
		// draws a bright hard border, which reads as a bug instantly.
		vec2 e = min( hitUv, 1.0 - hitUv ) / uEdgeFade;
		float edge = clamp( min( e.x, e.y ), 0.0, 1.0 );
		edge *= edge;

		// Rays that run almost parallel to the screen accumulate error; fade.
		float dist = clamp( 1.0 - travelled / uMaxDistance, 0.0, 1.0 );

		reflected = texture2D( tColor, hitUv ).rgb;
		confidence = facing * edge * ( 0.35 + 0.65 * dist );

	}

	// --- weight by Fresnel and roughness -------------------------------------
	// F0 for a dielectric is 0.04; metals in this world are dark iron and old
	// bronze, so a neutral 0.62 stands in for their albedo. Nothing here reads
	// as a chrome ball, which is where the approximation would show.
	vec3 F0 = mix( vec3( 0.04 ), vec3( 0.62, 0.60, 0.56 ), metal );
	vec3 F = F0 + ( max( vec3( 1.0 - rough ), F0 ) - F0 ) * pow( 1.0 - NdotV, 5.0 );

	float roughFade = 1.0 - smoothstep( uMaxRoughness * 0.55, uMaxRoughness, rough );
	vec3 outColor = reflected * F * ( confidence * uIntensity * roughFade );

	// Clamp fireflies: a single 200-nit spark reflected by one stochastic ray
	// becomes a permanent bright dot once the temporal filter latches onto it.
	float l = mnLuminance( outColor );
	if ( l > 8.0 ) outColor *= 8.0 / l;

	// --- temporal accumulation ------------------------------------------------
	vec2 vel = texture2D( tVelMetal, vUv ).rg;
	vec2 histUv = vUv - vel;
	vec2 inside = step( vec2( 0.0 ), histUv ) * step( histUv, vec2( 1.0 ) );

	vec4 hist = texture2D( tHistory, histUv );
	// Soft clamp against the new estimate keeps a disoccluded reflection from
	// trailing behind a moving enemy for half a second.
	float histL = mnLuminance( hist.rgb );
	float curL = mnLuminance( outColor );
	float clampW = clamp( ( curL * 6.0 + 0.35 ) / max( histL, 1e-4 ), 0.0, 1.0 );
	hist.rgb *= clampW;

	float w = inside.x * inside.y * uFeedback * ( 1.0 - uReset );

	gl_FragColor = vec4( mix( outColor, hist.rgb, w ), mix( confidence, hist.a, w ) );

}
`;

export class SsrPass {
  constructor(renderer, quad, shared, quality) {
    this.renderer = renderer;
    this.quad = quad;
    this.enabled = !!quality.ssr;
    this.steps = quality.renderScale >= 1.0 ? TUNE.ssr.steps : Math.round(TUNE.ssr.steps * 0.7);
    this.refine = TUNE.ssr.refine;
    // Geometric series: s0 * (g^N - 1) / (g - 1) == maxDistance.
    this.growth = 1.28;
    this.step0 = TUNE.ssr.maxDistance * (this.growth - 1) / (Math.pow(this.growth, this.steps) - 1);

    this.history = new PingPong((w, h, tag) => colorTarget(w, h, `mn.ssr.${tag}`));
    this.width = 1;
    this.height = 1;

    this.uResolution = { value: new THREE.Vector4(1, 1, 1, 1) };

    this.material = postMaterial({
      name: 'mn.ssr',
      fragment: SSR_FRAG,
      defines: {
        MN_SSR_STEPS: this.steps,
        MN_SSR_REFINE: this.refine,
        MN_SSR_GROWTH: this.growth.toFixed(4),
      },
      uniforms: {
        tColor: { value: null },
        tDepth: shared.depth,
        tNormal: shared.normal,
        tVelMetal: shared.velocity,
        tHistory: { value: null },
        uResolution: this.uResolution,
        uProjParams: shared.projParams,
        uFrame: shared.frame,
        uReset: shared.reset,
        uMaxDistance: { value: TUNE.ssr.maxDistance },
        uStep0: { value: this.step0 },
        uThickness: { value: TUNE.ssr.thickness },
        uMaxRoughness: { value: TUNE.ssr.maxRoughness },
        uIntensity: { value: TUNE.ssr.intensity },
        uEdgeFade: { value: TUNE.ssr.edgeFade },
        uFeedback: { value: TUNE.ssr.feedback },
      },
    });

    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.black.needsUpdate = true;
  }

  get texture() {
    return this.enabled ? this.history.read.texture : this.black;
  }

  resize(fullW, fullH) {
    this.width = Math.max(1, fullW >> 1);
    this.height = Math.max(1, fullH >> 1);
    if (!this.enabled) return;
    this.history.allocate(this.width, this.height);
    this.uResolution.value.set(this.width, this.height, 1 / this.width, 1 / this.height);
  }

  render(hdrTexture) {
    if (!this.enabled) return;
    this.material.uniforms.tColor.value = hdrTexture;
    this.material.uniforms.tHistory.value = this.history.read.texture;
    this.quad.render(this.renderer, this.material, this.history.write);
    this.history.swap();
  }

  stats() {
    return this.enabled
      ? { on: true, res: `${this.width}x${this.height}`, steps: this.steps, refine: this.refine }
      : { on: false };
  }

  dispose() {
    this.history.dispose();
    this.material.dispose();
    this.black.dispose();
  }
}
