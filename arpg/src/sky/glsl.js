import { FOG, VOLUME } from './tuning.js';

/**
 * GLSL shared between the volumetric march, the fog composite and the ground
 * mist.
 *
 * These are re-derived here rather than imported from `render/glsl.js` on
 * purpose: ARCHITECTURE.md forbids importing another subsystem's module, and the
 * dependency would be a real one — a change to the renderer's depth encoding
 * would silently change the meaning of this subsystem's fog. Duplicating twenty
 * lines is the cheap side of that trade. The ONE thing that must stay in sync is
 * the depth linearisation, which is fixed by the hardware depth buffer and the
 * camera's near/far, both of which are passed in as uniforms.
 *
 * Everything is ESSL 3 (three compiles ShaderMaterial as `#version 300 es` with
 * `texture2D` aliased to `texture`).
 */

/** Depth reconstruction from the renderer's hardware depth texture.
 *  `uProj` packs (near, far, tanHalfFovY, aspect). */
export const DEPTH_GLSL = /* glsl */ `
uniform vec4 uProj;      // near, far, tanHalfFovY, aspect

/** Hardware depth (0..1, non-reversed) -> positive view-space distance along -Z. */
float mnLinearDepth( float d ) {
  float n = uProj.x, f = uProj.y;
  float z = d * 2.0 - 1.0;
  return ( 2.0 * n * f ) / ( f + n - z * ( f - n ) );
}

/**
 * View ray for a screen UV, in VIEW space and unnormalised, with z = -1.
 * Its length is exactly 1/cos(angle to the optical axis), which is the factor
 * that converts "view-space Z distance" into "distance along the ray" — so the
 * caller gets both facts out of one calculation.
 */
vec3 mnViewRay( vec2 uv ) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3( ndc.x * uProj.w * uProj.z, ndc.y * uProj.z, -1.0 );
}
`;

/** Cheap deterministic hashes. No CPU randomness reaches a shader in this
 *  project; everything is a function of screen position and frame index so a
 *  capture is byte-stable. */
export const HASH_GLSL = /* glsl */ `
float mnHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

/** Interleaved gradient noise, used only where a blue-noise fetch would be an
 *  extra dependent texture read for no benefit (the mist card). */
float mnIgn( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

/**
 * Exponential height fog, analytic.
 *
 * With density rho(y) = D * exp( -(y - y0) / H ), the optical depth along a ray
 * from `origin` in direction `dir` (unit) over length `len` is a closed form:
 *
 *   tau = D * exp( -(oy - y0)/H ) * H / dy * ( 1 - exp( -dy * len / H ) )
 *
 * and degenerates to `D * exp(...) * len` as dy -> 0. Having this in closed form
 * matters twice over: it is what the low-quality path uses INSTEAD of marching,
 * and it is what corrects the quarter-resolution march's depth mismatch at
 * silhouettes in `fogComposite` — the difference of two analytic optical depths
 * is exact, whatever the march did.
 *
 * The `dy` branch threshold is 1e-3 rather than 0: at dy = 1e-4 the exponential
 * form loses catastrophically to cancellation and returns noise.
 */
export const HEIGHT_FOG_GLSL = /* glsl */ `
uniform vec4 uFogParams;    // density, 1/height, baseY, maxDistance
uniform vec4 uFogExtra;     // uniformDensity, unused, unused, unused

float mnFogOpticalDepth( vec3 origin, vec3 dir, float len ) {
  float invH = uFogParams.y;
  float d0 = uFogParams.x * exp( -( origin.y - uFogParams.z ) * invH );
  float dy = dir.y;
  // The height-independent term is trivially linear in the path length, and it
  // is the term that actually varies with DISTANCE — see the note on
  // FOG.densityUniform in tuning.js for why the exponential term alone barely
  // moves across an isometric frame.
  // ('flat' is a reserved interpolation qualifier in ESSL 3 — hence the name.)
  float slab = uFogExtra.x * len;
  // Guard the exponent: a ray heading steeply down through 100 m at invH = 0.19
  // reaches exp(19), which overflows a mediump float and saturates a highp one
  // into the fog looking like a wall. Clamping the optical depth at 40 (T < 1e-17)
  // costs nothing visually and keeps the maths finite.
  if ( abs( dy ) < 1e-3 ) return min( 40.0, d0 * len + slab );
  float k = dy * invH;
  return min( 40.0, d0 * ( 1.0 - exp( -k * len ) ) / k + slab );
}

float mnFogTransmittance( vec3 origin, vec3 dir, float len ) {
  return exp( -mnFogOpticalDepth( origin, dir, len ) );
}
`;

/**
 * Point-light attenuation, byte-identical to three's `getDistanceAttenuation`
 * with decay = 2.
 *
 * This has to match exactly, not approximately: the fog around a brazier and the
 * floor under the same brazier are lit by two different shaders, and if their
 * falloffs disagree the fog visibly detaches from its light source — the glow
 * ends before the lit floor does, or continues past it.
 */
export const LIGHT_ATTEN_GLSL = /* glsl */ `
float mnDistanceAttenuation( float dist, float cutoff ) {
  float falloff = 1.0 / max( dist * dist, 0.01 );
  if ( cutoff > 0.0 ) {
    float t = clamp( 1.0 - pow( dist / cutoff, 4.0 ), 0.0, 1.0 );
    falloff *= t * t;
  }
  return falloff;
}
`;

/**
 * Directional shadow lookup against three's own shadow map.
 *
 * three renders shadow maps as RGBA8 with the depth packed across the four
 * bytes (see `WebGLShadowMap`: a plain `WebGLRenderTarget` with
 * `MeshDepthMaterial` + `RGBADepthPacking`), so the unpack constant below is
 * three's `UnpackFactors`. `uShadowMatrix` is `light.shadow.matrix`, which
 * already carries the 0.5 scale-bias, so it maps world space straight to
 * (uv, depth).
 *
 * An unoccluded god ray looks like a mistake — light that passes through a wall
 * is the single fastest way to make volumetrics read as a filter rather than as
 * light. This is the function that stops that happening.
 */
export const SHADOW_GLSL = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform vec4 uShadowParams;   // 1/mapSize, enabled, jitterTexels, unused

const vec4 MN_UNPACK = vec4( 1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0 );

float mnUnpackDepth( vec4 v ) { return dot( v, MN_UNPACK ); }

/** 1 = lit, 0 = in shadow. 'rot' is a per-pixel rotation vector (cos, sin) from
 *  the blue-noise mask, so the tap offset decorrelates between neighbouring
 *  rays and the temporal filter can average the shaft edge into a soft one. */
float mnShadowAt( vec3 worldPos, vec2 rot ) {
  if ( uShadowParams.y < 0.5 ) return 1.0;
  vec4 sc = uShadowMatrix * vec4( worldPos, 1.0 );
  vec3 c = sc.xyz / max( 1e-6, sc.w );
  // Outside the fitted map there is no information. Returning 1 (lit) rather
  // than 0 is deliberate: the map covers the visible ground, and a shaft that
  // goes black the moment it leaves that region draws a hard line across the
  // floor, which is far more obvious than a missing occlusion.
  if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;

  vec2 o = vec2( rot.x, rot.y ) * uShadowParams.z * uShadowParams.x;
  float d = mnUnpackDepth( texture2D( uShadowMap, c.xy + o ) );
  // Bias in shadow-map depth units. The receiver here is a point in mid-air
  // rather than a surface, so there is no normal to offset along and no acne to
  // avoid; the bias only has to cover the map's own quantisation.
  return step( c.z - 0.0016, d );
}
`;

/**
 * Screen-space occlusion probe for a point light.
 *
 * There is no shadow map for a brazier — three would need a cube map per light
 * and six extra scene renders, which this container cannot afford. The
 * approximation: take a point on the segment from the fog sample toward the
 * light, project it into the camera's depth buffer, and ask whether it is behind
 * visible geometry. If it is, the straight line from the light to the sample
 * most likely passes through that geometry too.
 *
 * It is wrong when the occluder is only visible from the camera and not from the
 * light, and it is wrong at grazing angles. It is right for the case that
 * matters, which is a brazier in the next room glowing through a wall — and
 * being right about that is the difference between fog and a lens flare.
 */
export const SS_OCCLUSION_GLSL = /* glsl */ `
uniform mat4 uViewMatrix;

float mnScreenOcclusion( vec3 worldPos, vec3 lightPos, sampler2D depthTex ) {
  vec3 probe = mix( worldPos, lightPos, ${VOLUME.ssOcclusionBias.toFixed(3)} );
  vec4 v = uViewMatrix * vec4( probe, 1.0 );
  if ( v.z > -uProj.x ) return 1.0;                  // behind the near plane
  float pz = -v.z;
  vec2 ndc = vec2( v.x / ( uProj.z * uProj.w * pz ), v.y / ( uProj.z * pz ) );
  if ( abs( ndc.x ) > 1.0 || abs( ndc.y ) > 1.0 ) return 1.0;  // off screen: unknowable
  float scene = mnLinearDepth( texture2D( depthTex, ndc * 0.5 + 0.5 ).r );
  // Soft rather than binary, so a shaft crossing a silhouette fades instead of
  // stepping — a hard edge here survives the bilateral upsample as a staircase.
  return 1.0 - smoothstep( 0.0, ${VOLUME.ssOcclusionSoft.toFixed(3)}, pz - scene );
}
`;

/** Fog density field: exponential height falloff times drifting 3D noise.
 *  Shared by the march and by the ground mist so the two agree about where the
 *  fog is thick — a mist card that pools where the volumetric fog is thin reads
 *  as two unrelated effects. */
export const FOG_NOISE_GLSL = /* glsl */ `
uniform sampler3D uFogNoise;
uniform vec4 uFogNoiseA;   // scale, drift.x, drift.y, drift.z
uniform vec4 uFogNoiseB;   // scale2, drift2.x, drift2.y, drift2.z
uniform vec2 uFogNoiseMix; // floor, gain
uniform float uTime;

float mnFogNoise( vec3 p ) {
  // Advect the second octave's lookup by the first octave's decorrelated
  // channel. That is what makes the field churn rather than slide: a rigidly
  // translating fbm reads as a texture on a conveyor belt.
  vec3 q = p * uFogNoiseA.x + uFogNoiseA.yzw * uTime;
  vec4 a = texture( uFogNoise, q );
  vec3 r = p * uFogNoiseB.x + uFogNoiseB.yzw * uTime + ( a.b - 0.5 ) * 0.35;
  vec4 b = texture( uFogNoise, r );
  // Bank structure from the low octave, wisps from the ridged channel of the
  // high one. Weights sum to 1 so the mean stays at the LUT's mean.
  // Weighted hard toward the LOW octave: an even blend of three fields is a
  // central-limit machine and collapses to a near-constant 0.5, which is a fog
  // with no banks in it at all. The high octaves are here to give the edge of a
  // bank structure once a brazier lights it, not to define where the bank is.
  float n = a.r * 0.70 + b.g * 0.20 + b.a * 0.10;
  return uFogNoiseMix.x + uFogNoiseMix.y * n;
}

/** Full extinction at a world point: (height falloff + uniform floor) x noise.
 *  The noise modulates BOTH terms so a bank of mist is a bank all the way up,
 *  rather than a modulated layer sitting inside an unmodulated haze. */
float mnFogDensity( vec3 p ) {
  float h = exp( -( p.y - uFogParams.z ) * uFogParams.y );
  return ( uFogParams.x * h + uFogExtra.x ) * mnFogNoise( p );
}
`;

/** Constants the march and the composite both need as compile-time defines. */
export function fogDefines(extra = {}) {
  return {
    MN_FOG_ALBEDO: FOG.albedo.toFixed(4),
    MN_FOG_G: FOG.g.toFixed(4),
    MN_FOG_G_BACK: FOG.gBack.toFixed(4),
    MN_FOG_BACK_W: FOG.backWeight.toFixed(4),
    ...extra,
  };
}
