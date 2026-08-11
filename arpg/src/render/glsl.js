/**
 * Shared GLSL fragments.
 *
 * Every post pass in this directory is a `THREE.ShaderMaterial`, which three
 * compiles as `#version 300 es` with `varying` aliased to in/out and `texture2D`
 * aliased to `texture`. So these snippets are written in ESSL 3 style and may
 * use `texture()` / `textureLod()` directly.
 *
 * Nothing here allocates; everything is a string constant concatenated at
 * material-construction time.
 */

/** Fullscreen-triangle vertex shader. The triangle covers the viewport with a
 *  single primitive, which avoids the diagonal seam a two-triangle quad creates
 *  in derivative-based filters. */
export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

/**
 * Depth utilities.
 *
 * `uProjParams` packs what the passes need to go from a hardware depth sample
 * to a view-space position without shipping a full inverse matrix per pass:
 *   x = near, y = far, z = 1/tan(fovY/2) reciprocal helper, w = aspect
 * Passes that need the exact inverse (SSR, which must project back) get the
 * matrix as well.
 */
export const DEPTH_LIB = /* glsl */ `
uniform vec4 uProjParams;   // near, far, tanHalfFovY, aspect

/** Hardware depth (0..1) -> POSITIVE view-space distance along -Z. */
float linearDepth( float d ) {
  float n = uProjParams.x, f = uProjParams.y;
  float z = d * 2.0 - 1.0;
  return ( 2.0 * n * f ) / ( f + n - z * ( f - n ) );
}

/* View-space position of the fragment at uv, given its hardware depth. Derived
   from the perspective frustum directly - cheaper and more accurate at grazing
   angles than a full mat4 multiply. */
vec3 viewPosFromDepth( vec2 uv, float d ) {
  float vz = linearDepth( d );
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3( ndc.x * uProjParams.w * uProjParams.z * vz,
               ndc.y * uProjParams.z * vz,
               -vz );
}

/** Project a view-space position back to UV + hardware depth. */
vec3 uvFromViewPos( vec3 p ) {
  float vz = max( 1e-5, -p.z );
  vec2 ndc = vec2( p.x / ( uProjParams.w * uProjParams.z * vz ), p.y / ( uProjParams.z * vz ) );
  float n = uProjParams.x, f = uProjParams.y;
  // Inverse of linearDepth().
  float z = ( f + n - ( 2.0 * n * f ) / vz ) / ( f - n );
  return vec3( ndc * 0.5 + 0.5, z * 0.5 + 0.5 );
}
`;

/**
 * Hash / noise. All deterministic functions of screen position and frame index —
 * there is no CPU randomness anywhere in the pipeline, so captures are stable.
 */
export const NOISE_LIB = /* glsl */ `
/** Interleaved gradient noise (Jimenez). The best cheap blue-ish noise for
 *  temporally-accumulated sampling: its spectrum is close to uniform over a 3x3
 *  neighbourhood, which is exactly what the AO/SSR denoisers filter over. */
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

/** IGN advanced by frame index along the golden ratio, so successive frames
 *  sample complementary directions and the temporal filter converges instead of
 *  averaging the same estimate over and over. */
float ignFrame( vec2 p, float frame ) {
  return fract( ign( p ) + frame * 0.6180339887498949 );
}

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 hash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
`;

/** Colour-space helpers used by TAA (YCoCg clipping), grading and the composite. */
export const COLOR_LIB = /* glsl */ `
float mnLuminance( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

/** YCoCg is the right space for TAA neighbourhood clipping: it separates
 *  luminance from two chroma axes with a trivial (add/shift) transform, so the
 *  clip box is tight on the axis the eye actually notices. */
vec3 rgbToYCoCg( vec3 c ) {
  return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
               0.5 * c.r - 0.5 * c.b,
              -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}

vec3 ycoCgToRgb( vec3 c ) {
  float t = c.x - c.z;
  return vec3( t + c.y, c.x + c.z, t - c.y );
}

/** Reinhard-style weighting used to stop HDR fireflies from dominating a
 *  temporal or spatial average, and its exact inverse. */
vec3 tonemapWeight( vec3 c ) { return c / ( 1.0 + mnLuminance( c ) ); }
vec3 tonemapUnweight( vec3 c ) { return c / max( 1e-4, 1.0 - mnLuminance( c ) ); }

vec3 srgbEncode( vec3 c ) {
  c = clamp( c, 0.0, 1.0 );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
}
`;

/** AgX filmic tone map, matching three's own implementation so the look is
 *  identical to `AgXToneMapping` but with exposure applied by our metering pass
 *  instead of `toneMappingExposure`, and with a "look" stage we control. */
export const AGX_LIB = /* glsl */ `
const mat3 AGX_REC2020_TO_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182 ),
  vec3( -0.5876, 1.1329, -0.1006 ),
  vec3( -0.0728, -0.0083, 1.1187 ) );

const mat3 AGX_SRGB_TO_REC2020 = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 ) );

const mat3 AGX_INSET = mat3(
  vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
  vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
  vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );

const mat3 AGX_OUTSET = mat3(
  vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
  vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
  vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );

const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;

vec3 agxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
       + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/**
 * AgX with a punch/desaturate "look" applied in log space, which is where a
 * grade belongs — applying slope/power/offset after the sigmoid crushes the
 * highlight roll-off that the sigmoid exists to produce.
 *   uAgxLook.x = slope    (contrast around mid grey)
 *   uAgxLook.y = power    (gamma, > 1 deepens the toe)
 *   uAgxLook.z = offset   (lift/crush)
 *   uAgxLook.w = saturation
 */
uniform vec4 uAgxLook;

vec3 agx( vec3 color ) {
  color = AGX_SRGB_TO_REC2020 * max( color, 0.0 );
  color = AGX_INSET * color;
  color = max( color, 1e-10 );
  color = log2( color );
  color = ( color - AGX_MIN_EV ) / ( AGX_MAX_EV - AGX_MIN_EV );
  color = clamp( color, 0.0, 1.0 );

  // Look, in normalised log space.
  float lookLuma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = ( color - lookLuma ) * uAgxLook.w + lookLuma;
  color = clamp( pow( max( color * uAgxLook.x + uAgxLook.z, 0.0 ), vec3( uAgxLook.y ) ), 0.0, 1.0 );

  color = agxContrast( color );
  color = AGX_OUTSET * color;
  color = pow( max( color, 0.0 ), vec3( 2.2 ) );
  color = AGX_REC2020_TO_SRGB * color;
  return clamp( color, 0.0, 1.0 );
}
`;

/**
 * The occluder-fade / screen-hole snippet. It is compiled into BOTH the world's
 * lit materials (via patch.js) and the depth/normal prepass, so a wall that
 * dithers away also stops writing depth and normals — otherwise SSR and AO
 * would keep reflecting and occluding against geometry the player cannot see.
 *
 * Requires, in scope:
 *   uniform vec4  mnScreen;      // w, h, 1/w, 1/h  of the internal target
 *   uniform vec4  mnFadeParams;  // player screen uv .xy, player depth .z, radius .w
 *   uniform float mnFade;        // per-material amount, 0 = never fades
 */
export const OCCLUDER_FADE = /* glsl */ `
  if ( mnFade > 0.0 ) {
    vec2 mnSuv = gl_FragCoord.xy * mnScreen.zw;
    vec2 mnD = mnSuv - mnFadeParams.xy;
    mnD.x *= mnScreen.x * mnScreen.w;           // aspect-correct so the hole is round
    float mnR = length( mnD ) / max( mnFadeParams.w, 1e-3 );
    // Strictly in front of the player, with a small epsilon so co-planar
    // geometry at the player's feet does not flicker.
    float mnFront = step( gl_FragCoord.z, mnFadeParams.z - 0.00004 );
    float mnHole = 1.0 - smoothstep( MN_FADE_CORE, 1.0, mnR );
    float mnAlpha = 1.0 - mnFade * mnFront * mnHole * ( 1.0 - MN_FADE_MIN );
    // Interleaved-gradient dither, ADVANCED PER FRAME along the golden ratio.
    // A static pattern is a visible stipple that TAA cannot remove, because
    // every frame agrees on which pixels are missing. Rotating it makes each
    // pixel toggle over the TAA window, and the resolve turns it into genuine
    // smooth translucency — which is what the effect is supposed to look like.
    float mnDither = fract(
      fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) )
      + mnFrame * 0.6180339887498949 );
    if ( mnDither >= mnAlpha ) discard;
  }
`;

/** Uniform block shared by every material that participates in occluder fade. */
export const OCCLUDER_UNIFORMS = /* glsl */ `
uniform vec4 mnScreen;
uniform vec4 mnFadeParams;
uniform float mnFade;
uniform float mnFrame;
`;
