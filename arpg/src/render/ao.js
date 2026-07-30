import * as THREE from 'three';
import { postMaterial } from './quad.js';
import { DEPTH_LIB, NOISE_LIB } from './glsl.js';
import { colorTarget, PingPong, disposeTarget } from './targets.js';
import { TUNE } from './tuning.js';

/**
 * Ground-truth ambient occlusion, at half resolution, with a temporal +
 * spatial denoise.
 *
 * In a crypt the AO IS the art direction. Diablo IV's interiors are legible
 * almost entirely because every joint between two stones, every ledge, every
 * place a pillar meets the floor, is darker than its surroundings — that is
 * what makes a room read as built out of heavy objects rather than painted onto
 * a plane. Ordinary SSAO gives you a grey halo; GTAO gives you the correct
 * cosine-weighted visibility integral, which is why crevices go genuinely dark
 * while open floor stays clean.
 *
 * Structure:
 *   pass 1  GTAO with 2 slices x 5 steps + temporal reprojection  (half res)
 *   pass 2  depth-aware 9-tap bilateral blur                      (half res)
 *
 * The slice angle is advanced by the golden ratio every frame, so what looks
 * like 2 slices on a still frame is effectively 20+ slices after the temporal
 * filter converges — this is the standard trade and it is why the pass can be
 * this cheap and still be ground-truth-shaped.
 */

const GTAO_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tVelocity;
uniform sampler2D tHistory;

uniform vec4 uResolution;     // w, h, 1/w, 1/h  of THIS (half-res) buffer
uniform float uProjScale;     // half-res pixels per world metre at 1 m depth
uniform float uRadius;        // metres
uniform float uMaxRadiusPx;
uniform float uThickness;
uniform float uFrame;
uniform float uFeedback;
uniform float uReset;

${DEPTH_LIB}
${NOISE_LIB}

const float MN_PI = 3.14159265359;
const float MN_HALF_PI = 1.57079632679;

void main() {

	float d = texture2D( tDepth, vUv ).r;

	// Sky / cleared depth: fully unoccluded, and store a far depth so the
	// bilateral blur rejects it rather than bleeding sky into a silhouette.
	if ( d >= 0.999999 ) { gl_FragColor = vec4( 1.0, uProjParams.y, 0.0, 1.0 ); return; }

	vec3 P = viewPosFromDepth( vUv, d );
	vec3 N = normalize( texture2D( tNormal, vUv ).xyz );
	vec3 V = normalize( -P );
	float viewDepth = -P.z;

	// World radius -> screen radius. Doing it this way (rather than a constant
	// pixel radius) is what keeps AO stable when a shot pushes the boom in: the
	// occlusion belongs to the geometry, not to the framing.
	float radiusPx = min( uRadius * uProjScale / max( viewDepth, 0.05 ), uMaxRadiusPx );

	if ( radiusPx < 1.5 ) { gl_FragColor = vec4( 1.0, viewDepth, 0.0, 1.0 ); return; }

	float noise = ignFrame( gl_FragCoord.xy, uFrame );
	float noiseOffset = fract( noise * 7.0 );
	float stepPx = radiusPx / float( MN_AO_STEPS );

	float visibility = 0.0;

	for ( int s = 0; s < MN_AO_SLICES; s ++ ) {

		float phi = ( float( s ) + noise ) * ( MN_PI / float( MN_AO_SLICES ) );
		vec2 dir = vec2( cos( phi ), sin( phi ) );

		// --- project the normal into the slice plane ---------------------------
		vec3 sliceDir = vec3( dir, 0.0 );
		vec3 axis = cross( sliceDir, V );
		vec3 projN = N - axis * dot( N, axis );
		float projLen = length( projN );

		if ( projLen < 1e-4 ) continue;

		vec3 projNn = projN / projLen;
		vec3 tangentDir = normalize( sliceDir - dot( sliceDir, V ) * V );
		float sgn = sign( dot( tangentDir, projNn ) );
		float nAngle = sgn * acos( clamp( dot( projNn, V ), -1.0, 1.0 ) );

		// --- horizon search, both directions ----------------------------------
		// 'cosPos' is the horizon toward +tangentDir (the direction 'nAngle' was
		// signed against) and 'cosNeg' the horizon behind it. Getting these two
		// the wrong way round is equivalent to negating 'nAngle', which leaves
		// the integral looking plausible on a surface facing the camera and
		// silently wrong on every tilted one — i.e. on the floor, which is most
		// of an isometric frame.
		float cosPos = -1.0;
		float cosNeg = -1.0;

		for ( int j = 0; j < MN_AO_STEPS; j ++ ) {

			float t = ( float( j ) + noiseOffset ) * stepPx + 1.0;
			vec2 off = dir * t * uResolution.zw;

			// +dir
			vec2 uv1 = vUv + off;
			float d1 = texture2D( tDepth, uv1 ).r;
			vec3 S1 = viewPosFromDepth( uv1, d1 ) - P;
			float len1 = length( S1 );
			float c1 = dot( S1, V ) / max( len1, 1e-5 );
			// Falloff: past the radius a sample stops being an occluder and
			// relaxes back to the current horizon. Without this, a distant wall
			// darkens the whole floor in front of it.
			float w1 = clamp( 1.0 - ( len1 - uRadius ) / uThickness, 0.0, 1.0 );
			w1 *= step( d1, 0.999999 );
			cosPos = max( cosPos, mix( cosPos, c1, w1 ) );

			// -dir
			vec2 uv2 = vUv - off;
			float d2 = texture2D( tDepth, uv2 ).r;
			vec3 S2 = viewPosFromDepth( uv2, d2 ) - P;
			float len2 = length( S2 );
			float c2 = dot( S2, V ) / max( len2, 1e-5 );
			float w2 = clamp( 1.0 - ( len2 - uRadius ) / uThickness, 0.0, 1.0 );
			w2 *= step( d2, 0.999999 );
			cosNeg = max( cosNeg, mix( cosNeg, c2, w2 ) );

		}

		// --- the GTAO arc integral --------------------------------------------
		float h0 = nAngle + max( -acos( clamp( cosNeg, -1.0, 1.0 ) ) - nAngle, -MN_HALF_PI );
		float h1 = nAngle + min(  acos( clamp( cosPos, -1.0, 1.0 ) ) - nAngle,  MN_HALF_PI );

		float sinN = sin( nAngle );
		float cosN = cos( nAngle );

		float arc = 0.25 * (
			( -cos( 2.0 * h0 - nAngle ) + cosN + 2.0 * h0 * sinN ) +
			( -cos( 2.0 * h1 - nAngle ) + cosN + 2.0 * h1 * sinN ) );

		visibility += projLen * arc;

	}

	float ao = clamp( visibility / float( MN_AO_SLICES ), 0.0, 1.0 );

	// --- temporal accumulation ------------------------------------------------
	vec2 vel = texture2D( tVelocity, vUv ).rg;
	vec2 histUv = vUv - vel;
	vec2 inside = step( vec2( 0.0 ), histUv ) * step( histUv, vec2( 1.0 ) );

	vec2 hist = texture2D( tHistory, histUv ).rg;
	// Reject history across a depth discontinuity: the alternative is a dark
	// smear trailing behind every moving enemy.
	float depthReject = exp( -abs( hist.y - viewDepth ) / max( 0.06 * viewDepth, 0.02 ) );
	float w = inside.x * inside.y * depthReject * uFeedback * ( 1.0 - uReset );

	ao = mix( ao, hist.x, w );

	gl_FragColor = vec4( ao, viewDepth, 0.0, 1.0 );

}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tAo;
uniform vec4 uResolution;
uniform vec2 uDirection;
uniform float uDepthSigma;
uniform float uPower;
uniform float uIntensity;
uniform float uFinal;      // 1 on the last pass: apply the response curve

void main() {

	vec2 texel = uResolution.zw * uDirection;
	vec2 c = texture2D( tAo, vUv ).rg;
	float centreDepth = c.y;

	float sum = c.x;
	float wsum = 1.0;

	// Separable 9-tap. Bilateral weights use the RELATIVE depth difference so
	// the same sigma works at 3 m and at 30 m.
	for ( int i = 1; i <= 4; i ++ ) {

		float fi = float( i );
		float gw = exp( -0.5 * ( fi * fi ) / 4.0 );

		vec2 s0 = texture2D( tAo, vUv + texel * fi ).rg;
		float w0 = gw * exp( -abs( s0.y - centreDepth ) / ( uDepthSigma * max( centreDepth, 1.0 ) ) );
		sum += s0.x * w0; wsum += w0;

		vec2 s1 = texture2D( tAo, vUv - texel * fi ).rg;
		float w1 = gw * exp( -abs( s1.y - centreDepth ) / ( uDepthSigma * max( centreDepth, 1.0 ) ) );
		sum += s1.x * w1; wsum += w1;

	}

	float ao = sum / wsum;

	if ( uFinal > 0.5 ) {
		// Response curve. Physically the integral is already correct; this is a
		// deliberate art choice to push the crevices, which is the whole reason
		// the pass exists.
		ao = pow( clamp( ao, 0.0, 1.0 ), uPower );
		ao = mix( 1.0, ao, uIntensity );
	}

	gl_FragColor = vec4( ao, centreDepth, 0.0, 1.0 );

}
`;

export class AoPass {
  constructor(renderer, quad, shared, quality) {
    this.renderer = renderer;
    this.quad = quad;
    this.shared = shared;
    this.enabled = !!quality.gtao;

    // 2 slices x 5 steps at high/ultra; the temporal filter turns that into
    // dozens of effective slices. 1 x 4 on medium keeps the shape without the
    // fill cost.
    const heavy = quality.renderScale >= 0.9 && quality.ssr;
    this.slices = heavy ? 2 : 1;
    this.steps = heavy ? 4 : 3;

    this.history = new PingPong((w, h, tag) => colorTarget(w, h, `mn.ao.${tag}`));
    this.rtBlur = null;
    this.rtFinal = null;
    this.width = 1;
    this.height = 1;

    this.uResolution = { value: new THREE.Vector4(1, 1, 1, 1) };
    this.uProjParams = shared.projParams;

    this.matGtao = postMaterial({
      name: 'mn.gtao',
      fragment: GTAO_FRAG,
      defines: { MN_AO_SLICES: this.slices, MN_AO_STEPS: this.steps },
      uniforms: {
        tDepth: shared.depth,
        tNormal: shared.normal,
        tVelocity: shared.velocity,
        tHistory: { value: null },
        uResolution: this.uResolution,
        uProjParams: shared.projParams,
        uProjScale: { value: 500 },
        uRadius: { value: TUNE.gtao.radius },
        uMaxRadiusPx: { value: TUNE.gtao.maxRadiusPx },
        uThickness: { value: TUNE.gtao.thickness },
        uFrame: shared.frame,
        uFeedback: { value: TUNE.gtao.feedback },
        uReset: shared.reset,
      },
    });

    this.matBlur = postMaterial({
      name: 'mn.ao.blur',
      fragment: BLUR_FRAG,
      uniforms: {
        tAo: { value: null },
        uResolution: this.uResolution,
        uDirection: { value: new THREE.Vector2(1, 0) },
        uDepthSigma: { value: TUNE.gtao.depthSigma },
        uPower: { value: TUNE.gtao.power },
        uIntensity: { value: TUNE.gtao.intensity },
        uFinal: { value: 0 },
      },
    });

    /** A 1x1 white texture stands in for AO when the pass is disabled, so the
     *  material patch never needs a variant for "no AO". */
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.white.needsUpdate = true;
  }

  get texture() {
    // `rtFinal` does not exist until the first resize; the 1x1 white texture is
    // the identity for the multiply in the material patch, so a pipeline that
    // reads AO before it has been allocated simply gets "no occlusion".
    if (!this.enabled || !this.rtFinal) return this.white;
    return this.rtFinal.texture;
  }

  resize(fullW, fullH) {
    this.width = Math.max(1, fullW >> 1);
    this.height = Math.max(1, fullH >> 1);
    if (!this.enabled) return;

    this.history.allocate(this.width, this.height);
    disposeTarget(this.rtBlur);
    disposeTarget(this.rtFinal);
    this.rtBlur = colorTarget(this.width, this.height, 'mn.ao.blur');
    this.rtFinal = colorTarget(this.width, this.height, 'mn.ao.final');
    this.uResolution.value.set(this.width, this.height, 1 / this.width, 1 / this.height);
  }

  /** Called when the camera projection changes. */
  setProjection(fovYRad) {
    // Half-res pixels per metre at 1 m of view depth.
    this.matGtao.uniforms.uProjScale.value = 0.5 * this.height / Math.tan(fovYRad * 0.5);
  }

  render() {
    if (!this.enabled) return;
    const r = this.renderer;

    this.matGtao.uniforms.tHistory.value = this.history.read.texture;
    this.quad.render(r, this.matGtao, this.history.write);

    // Separable bilateral. Horizontal into rtBlur, vertical into rtFinal with
    // the response curve folded into the last pass.
    this.matBlur.uniforms.tAo.value = this.history.write.texture;
    this.matBlur.uniforms.uDirection.value.set(1, 0);
    this.matBlur.uniforms.uFinal.value = 0;
    this.quad.render(r, this.matBlur, this.rtBlur);

    this.matBlur.uniforms.tAo.value = this.rtBlur.texture;
    this.matBlur.uniforms.uDirection.value.set(0, 1);
    this.matBlur.uniforms.uFinal.value = 1;
    this.quad.render(r, this.matBlur, this.rtFinal);

    this.history.swap();
  }

  stats() {
    return this.enabled
      ? { on: true, res: `${this.width}x${this.height}`, slices: this.slices, steps: this.steps }
      : { on: false };
  }

  dispose() {
    this.history.dispose();
    disposeTarget(this.rtBlur);
    disposeTarget(this.rtFinal);
    this.matGtao.dispose();
    this.matBlur.dispose();
    this.white.dispose();
  }
}
