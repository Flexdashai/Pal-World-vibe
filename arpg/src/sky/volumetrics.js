import * as THREE from 'three';
import { FOG, VOLUME } from './tuning.js';
import {
  DEPTH_GLSL, HASH_GLSL, HEIGHT_FOG_GLSL, LIGHT_ATTEN_GLSL,
  SHADOW_GLSL, SS_OCCLUSION_GLSL, FOG_NOISE_GLSL,
} from './glsl.js';

/**
 * HEIGHT FOG + VOLUMETRIC LIGHT SHAFTS.
 *
 * Registered with `render.registerPass({ stage: 'hdr' })`, so it runs on the
 * linear HDR buffer after the lit pass and before SSR/TAA/grade — which is the
 * only correct place for it: fog is scene radiance, it must be anti-aliased with
 * the world, tone mapped with the world and bloomed with the world.
 *
 * ---------------------------------------------------------------------------
 * THE PIPELINE, and why each stage exists
 *
 *   1. MARCH, quarter resolution.
 *      Ray march from the camera to the geometry, accumulating extinction and
 *      in-scattering. Density is exponential in height times a drifting 3D noise
 *      field; in-scattering is the ambient sky term plus the moon (sampled
 *      against the real shadow map) plus up to four point lights (probed against
 *      the camera depth buffer). Segment integration is analytic within each
 *      step — `T * S/sigma * (1 - exp(-sigma*dt))` rather than `T * S * dt` —
 *      which is what lets ten steps look like forty.
 *
 *      Quarter resolution is not a compromise, it is the design. This container
 *      has no GPU. At 320x180 the march is ~2 M dependent texture fetches per
 *      frame; at half resolution it is 8 M and every other agent's capture loop
 *      slows down with it.
 *
 *   2. BLUE-NOISE START OFFSET.
 *      Each ray starts at a different fraction of the first step. Without it the
 *      ten sample planes are visible as ten concentric bands. The mask is
 *      void-and-cluster (see noise.js), advanced per frame along the golden
 *      ratio so successive frames sample complementary offsets.
 *
 *   3. TEMPORAL ACCUMULATION.
 *      Blends against a reprojected history at 0.90 feedback, which turns the
 *      per-frame dither into a converged estimate. Rejected on reprojection
 *      failure, on a depth discontinuity, and on a camera teleport — a shot
 *      change must not smear the previous room across the new one.
 *
 *   4. BILATERAL UPSAMPLE + ANALYTIC DEPTH CORRECTION.
 *      Four taps weighted by depth agreement, so the fog does not halo around
 *      every silhouette. Then the residual depth error between the quarter-res
 *      sample and the full-res pixel is corrected ANALYTICALLY: the closed-form
 *      exponential-height optical depth is evaluated at both distances and the
 *      difference is applied exactly. That correction is what makes a
 *      quarter-resolution effect land on a full-resolution silhouette.
 *
 *   5. COMPOSITE.
 *      One fullscreen draw with `src * 1 + dst * srcAlpha` — the fog blend
 *      written as a blend function rather than as a texture read, so the HDR
 *      buffer is never round-tripped.
 *
 * When `config.q.volumetrics` is false the march and the temporal pass are
 * skipped entirely and stage 5 runs a purely analytic height fog. That path
 * still gives the frame its depth separation; it just loses the shafts.
 */

/** Minimal fullscreen-triangle plumbing. Deliberately not shared with the
 *  renderer's `ScreenQuad`: importing it would be importing another subsystem's
 *  module, and this is fifteen lines. */
class Quad {
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.geometry = g;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(g, null);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }
  render(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target ?? null);
    renderer.render(this.mesh, this.camera);
  }
  dispose() { this.geometry.dispose(); this.mesh.material = null; }
}

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

const PHASE_GLSL = /* glsl */ `
float mnPhaseHG( float c, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / ( 12.5663706 * pow( max( 1e-4, 1.0 + g2 - 2.0 * g * c ), 1.5 ) );
}

/* Two-lobe phase. Real fog droplets scatter strongly forward AND have a small
   retro-reflective lobe; the back lobe is what makes fog glow around a light you
   are looking straight at, which is half of why a brazier in fog reads as a
   brazier in fog. */
float mnPhaseFog( float c ) {
  return mix( mnPhaseHG( c, MN_FOG_G ), mnPhaseHG( c, MN_FOG_G_BACK ), MN_FOG_BACK_W );
}
`;

function marchFragment(steps, lights) {
  return /* glsl */ `
precision highp float;
precision highp sampler3D;
varying vec2 vUv;

uniform sampler2D tDepth;
uniform sampler2D tHistory;
uniform sampler2D uBlueNoise;

uniform mat4 uCamMatrix;      // camera.matrixWorld
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec4 uLowRes;         // w, h, 1/w, 1/h
uniform float uFrame;
uniform float uHistoryValid;

uniform vec3 uAmbient;        // sky in-scatter radiance, already tinted
uniform float uAmbientGround; // extra bounce near the floor
uniform vec3 uMoonDir;
uniform vec3 uMoonIrradiance; // colour * intensity * shaft boost

${DEPTH_GLSL}
${HASH_GLSL}
${PHASE_GLSL}
${HEIGHT_FOG_GLSL}
${FOG_NOISE_GLSL}
${LIGHT_ATTEN_GLSL}
${SHADOW_GLSL}
${SS_OCCLUSION_GLSL}

#if MN_FOG_LIGHTS > 0
uniform vec4 uLightPos[ MN_FOG_LIGHTS ];    // xyz = world position, w = cutoff distance
uniform vec4 uLightColor[ MN_FOG_LIGHTS ];  // rgb = colour * intensity, a = active
// xyz = spot axis (light -> target), w = cos(outer angle), or -2 for a point
// light, which the cone test then passes unconditionally. A spot light is the
// most likely way 'world' will build a shaft through a window, and a spot whose
// fog glows as a SPHERE is worse than no volumetric at all — it puts light
// visibly outside the cone the surfaces below are lit by.
uniform vec4 uLightAxis[ MN_FOG_LIGHTS ];
#endif

void main() {

  // ---- ray setup -----------------------------------------------------------
  float d = texture2D( tDepth, vUv ).r;
  bool isSky = d >= 0.999999;
  float viewZ = isSky ? uProj.y : mnLinearDepth( d );

  vec3 vray = mnViewRay( vUv );
  float invCos = length( vray );                 // view-Z distance -> ray distance
  vec3 dirW = normalize( mat3( uCamMatrix ) * vray );

  float tScene = viewZ * invCos;
  float tEnd = min( tScene, uFogParams.w );

  // ---- blue-noise start offset --------------------------------------------
  // Sampled with NearestFilter on a 32x32 tile, so this is an exact texel fetch
  // and the mask keeps its spectrum. Advanced per frame along the golden ratio
  // so the temporal filter converges rather than averaging one estimate.
  float blue = texture2D( uBlueNoise, gl_FragCoord.xy * ( 1.0 / 32.0 ) ).r;
  float jitter = fract( blue + uFrame * 0.6180339887498949 );
  float ang = blue * 6.2831853;
  vec2 rot = vec2( cos( ang ), sin( ang ) );

  // ---- the march -----------------------------------------------------------
  float cosMoon = dot( dirW, uMoonDir );
  float phaseMoon = mnPhaseFog( cosMoon );

  vec3 acc = vec3( 0.0 );
  float T = 1.0;
  float tPrev = 0.0;
  float invSteps = 1.0 / float( ${steps} );

  for ( int i = 0; i < ${steps}; i ++ ) {

    // Warped sample positions: dense near the camera, where the fog is thick,
    // where the lights are, and where the eye is looking.
    float s = ( float( i ) + jitter ) * invSteps;
    float t = tEnd * pow( s, ${VOLUME.stepPower.toFixed(3)} );
    float dt = t - tPrev;
    tPrev = t;
    if ( dt <= 1e-4 ) continue;

    vec3 p = uCamPos + dirW * t;
    float sigmaT = mnFogDensity( p );
    if ( sigmaT < 1e-5 ) continue;

    // --- in-scattered radiance at this sample ------------------------------
    // Ambient is already an integrated (over the sphere) term, so it takes NO
    // phase factor. Directional and punctual sources deliver an IRRADIANCE and
    // do take one. Getting that distinction wrong is what makes fog either
    // uniformly milky or invisible.
    vec3 inScatter = uAmbient * ( 1.0 + uAmbientGround * exp( -max( 0.0, p.y - uFogParams.z ) * 0.55 ) );

    float sh = mnShadowAt( p, rot );
    inScatter += uMoonIrradiance * ( sh * phaseMoon );

    #if MN_FOG_LIGHTS > 0
    for ( int L = 0; L < MN_FOG_LIGHTS; L ++ ) {
      vec4 lp = uLightPos[ L ];
      vec4 lc = uLightColor[ L ];
      if ( lc.a < 0.5 ) continue;
      vec3 toL = lp.xyz - p;
      float dist = length( toL );
      if ( lp.w > 0.0 && dist > lp.w ) continue;
      float atten = mnDistanceAttenuation( dist, lp.w );
      // Early-out BEFORE the occlusion probe. That probe is a dependent texture
      // fetch and it is by far the most expensive thing in the inner loop —
      // four lights times twelve steps is 48 of them per pixel if every one is
      // taken. Most samples along a 30 m ray are nowhere near most braziers, so
      // this one compare removes the large majority of them. The threshold is
      // three orders of magnitude below the dither floor of the final image.
      if ( max( lc.r, max( lc.g, lc.b ) ) * atten < 2e-4 ) continue;
      vec3 Ldir = toL / max( 1e-4, dist );

      vec4 ax = uLightAxis[ L ];
      float cone = 1.0;
      if ( ax.w > -1.5 ) {
        // Cone falloff, matching three's getSpotAttenuation shape: smoothstep
        // from the outer cosine to a penumbra fraction of the way in. Exactness
        // matters less here than agreement — a shaft whose edge does not line up
        // with the lit ellipse on the floor reads as two effects, not one.
        float c = dot( -Ldir, ax.xyz );
        cone = smoothstep( ax.w, mix( ax.w, 1.0, 0.30 ), c );
        if ( cone <= 0.0 ) continue;
      }

      float occ = mnScreenOcclusion( p, lp.xyz, tDepth );
      inScatter += lc.rgb * ( atten * occ * cone * MN_LOCAL_BOOST * mnPhaseFog( dot( dirW, Ldir ) ) );
    }
    #endif

    // --- analytic integration over the segment -----------------------------
    // Treating the segment as homogeneous and integrating exactly is what makes
    // a ten-step march smooth. The naive 'acc += T * S * dt' is a left Riemann
    // sum and shows every step as a band once the fog is thick enough to matter.
    float sigmaS = sigmaT * MN_FOG_ALBEDO;
    float Ti = exp( -sigmaT * dt );
    acc += T * ( inScatter * sigmaS / sigmaT ) * ( 1.0 - Ti );
    T *= Ti;

    if ( T < 0.004 ) break;
  }

  vec4 current = vec4( acc, T );

  // ---- temporal accumulation ----------------------------------------------
  if ( uHistoryValid > 0.5 ) {
    // Reproject through the geometry the ray hit. Volumetrics live between the
    // camera and that surface, so this is an approximation — but it is the same
    // approximation every shipped volumetric pass makes, and it is exact for the
    // dominant case where the fog is optically thin and the surface behind it is
    // what the eye is tracking.
    vec3 world = uCamPos + dirW * min( tScene, uProj.y * 0.98 );
    vec4 prev = uPrevViewProj * vec4( world, 1.0 );
    vec2 prevUv = ( prev.xy / max( 1e-5, prev.w ) ) * 0.5 + 0.5;

    if ( all( greaterThanEqual( prevUv, vec2( 0.0 ) ) ) && all( lessThanEqual( prevUv, vec2( 1.0 ) ) ) ) {
      // Disocclusion test. There is no previous depth buffer to compare against,
      // so compare the CURRENT depth at the reprojected UV: if a silhouette
      // moved across this pixel the two disagree, which is exactly the case the
      // history must be dropped for.
      float dPrev = texture2D( tDepth, prevUv ).r;
      float zPrev = dPrev >= 0.999999 ? uProj.y : mnLinearDepth( dPrev );
      float rel = abs( zPrev - viewZ ) / max( 1.0, viewZ );
      if ( rel < ${VOLUME.depthReject.toFixed(3)} ) {
        vec4 hist = texture2D( tHistory, prevUv );
        current = mix( current, hist, ${VOLUME.feedback.toFixed(3)} );
      }
    }
  }

  gl_FragColor = current;
}
`;
}

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDepth;
uniform sampler2D tVolume;

uniform mat4 uCamMatrix;
uniform vec3 uCamPos;
uniform vec4 uLowRes;        // w, h, 1/w, 1/h of the marched buffer
uniform float uIntensity;
uniform vec3 uAmbient;
uniform vec3 uMoonDir;
uniform vec3 uMoonIrradiance;
uniform float uSkyFogScale;

${DEPTH_GLSL}
${PHASE_GLSL}
${HEIGHT_FOG_GLSL}

void main() {

  float d = texture2D( tDepth, vUv ).r;
  bool isSky = d >= 0.999999;
  float viewZ = isSky ? uProj.y : mnLinearDepth( d );

  vec3 vray = mnViewRay( vUv );
  float invCos = length( vray );
  vec3 dirW = normalize( mat3( uCamMatrix ) * vray );

  float tScene = viewZ * invCos;
  float tEnd = min( tScene, uFogParams.w );
  // Looking through a gate at the night sky, the ray leaves the fog layer of its
  // own accord because the density is exponential in height — but a ray that
  // exits horizontally would otherwise accumulate the full 110 m and erase the
  // sky. 'uSkyFogScale' trims the sky's fog distance so a visible sky stays
  // visible; at 1.0 it does nothing.
  if ( isSky ) tEnd *= uSkyFogScale;

#ifdef MN_FOG_MARCHED

  // ---- bilateral upsample --------------------------------------------------
  // Four taps at the low-resolution texel centres, weighted by bilinear position
  // AND by how well each tap's scene depth agrees with this pixel's. Without the
  // depth term the fog haloes around every silhouette, which is the single most
  // recognisable artefact of a low-resolution volumetric pass.
  vec2 f = vUv * uLowRes.xy - 0.5;
  vec2 base = floor( f );
  vec2 frac = f - base;

  vec4 sum = vec4( 0.0 );
  float wsum = 0.0;
  float zsum = 0.0;

  for ( int k = 0; k < 4; k ++ ) {
    vec2 off = vec2( float( k & 1 ), float( k >> 1 ) );
    vec2 tuv = ( base + off + 0.5 ) * uLowRes.zw;
    float bw = ( off.x > 0.5 ? frac.x : 1.0 - frac.x ) * ( off.y > 0.5 ? frac.y : 1.0 - frac.y );

    float dk = texture2D( tDepth, tuv ).r;
    float zk = dk >= 0.999999 ? uProj.y : mnLinearDepth( dk );
    float w = bw * exp( -abs( zk - viewZ ) * ${(1 / VOLUME.upsampleDepthSigma).toFixed(4)} );

    sum += texture2D( tVolume, tuv ) * w;
    zsum += zk * w;
    wsum += w;
  }

  vec4 vol;
  float zLow;
  if ( wsum > 1e-4 ) {
    vol = sum / wsum;
    zLow = zsum / wsum;
  } else {
    // Every tap disagreed — a thin silhouette, one pixel wide. Fall back to the
    // plain bilinear sample rather than to nothing.
    vol = texture2D( tVolume, vUv );
    zLow = viewZ;
  }

  // ---- analytic depth correction -------------------------------------------
  // The march integrated to 'zLow'; this pixel's geometry is at 'viewZ'. The
  // difference of the two CLOSED-FORM optical depths is exact, so applying it
  // fixes the quarter-resolution mismatch without another march. This is what
  // puts a low-resolution effect precisely on a full-resolution edge.
  float tLow = min( zLow * invCos, uFogParams.w );
  if ( isSky ) tLow *= uSkyFogScale;
  float dTau = mnFogOpticalDepth( uCamPos, dirW, tEnd ) - mnFogOpticalDepth( uCamPos, dirW, tLow );
  float T = clamp( vol.a * exp( -dTau ), 0.0, 1.0 );

  vec3 inscatter = max( vol.rgb, 0.0 ) * uIntensity;
  // The in-scatter was integrated over the low-resolution ray length too; scale
  // it by the same correction so a foreground silhouette does not keep the fog
  // that belonged to the wall behind it.
  inscatter *= mix( 1.0, exp( -dTau ), 0.5 );

#else

  // ---- analytic-only path (q.volumetrics == false) ------------------------
  // No shafts, but the frame still gets its depth separation. '1 - T' is the
  // exact integrated scattering for a uniform source, which the ambient term is;
  // the moon term borrows the same factor, which over-brightens fog in shadow
  // and is the price of not marching.
  float tau = mnFogOpticalDepth( uCamPos, dirW, tEnd );
  float T = exp( -tau );
  float phase = mnPhaseFog( dot( dirW, uMoonDir ) );
  vec3 inscatter = ( uAmbient + uMoonIrradiance * phase * 0.55 ) * ( 1.0 - T ) * uIntensity;

#endif

  // src * 1 + dst * src.a  ==  inscatter + sceneColour * transmittance
  gl_FragColor = vec4( inscatter, T );
}
`;

export class VolumetricFog {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} config  the engine config (for `q`)
   * @param {object} res     { fogNoise, blueNoise }
   * @param {object} budgets result of `budgetsFor(config)`
   */
  constructor(renderer, config, res, budgets) {
    this.renderer = renderer;
    this.config = config;
    this.budgets = budgets;
    this.enabled = budgets.enabled;

    this.quad = new Quad();

    this.width = 1;
    this.height = 1;
    this.lowWidth = 1;
    this.lowHeight = 1;

    this.rtA = null;
    this.rtB = null;
    this._writeA = true;

    // ---- shared uniform objects ---------------------------------------------
    // Shared BY REFERENCE between the march and the composite so a single
    // assignment updates both. Getting these out of sync — the composite fogging
    // to one density while the march integrated another — produces a frame that
    // is subtly, unfixably wrong.
    this.shared = {
      uProj: { value: new THREE.Vector4(1, 140, 0.3, 1.777) },
      uCamMatrix: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uFogParams: { value: new THREE.Vector4(FOG.density, 1 / FOG.height, FOG.baseY, FOG.maxDistance) },
      uFogExtra: { value: new THREE.Vector4(FOG.densityUniform, 0, 0, 0) },
      uAmbient: { value: new THREE.Vector3(0.004, 0.005, 0.008) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonIrradiance: { value: new THREE.Vector3() },
      uLowRes: { value: new THREE.Vector4(1, 1, 1, 1) },
      uTime: { value: 0 },
      uFogNoise: { value: res.fogNoise },
      uFogNoiseA: { value: new THREE.Vector4(FOG.noiseScale, ...FOG.noiseDrift) },
      uFogNoiseB: { value: new THREE.Vector4(FOG.noiseScale2, ...FOG.noiseDrift2) },
      uFogNoiseMix: { value: new THREE.Vector2(FOG.noiseFloor, FOG.noiseGain) },
    };

    const defines = {
      MN_FOG_ALBEDO: FOG.albedo.toFixed(4),
      MN_FOG_G: FOG.g.toFixed(4),
      MN_FOG_G_BACK: FOG.gBack.toFixed(4),
      MN_FOG_BACK_W: FOG.backWeight.toFixed(4),
      MN_FOG_LIGHTS: budgets.lights,
      MN_LOCAL_BOOST: VOLUME.localShaftBoost.toFixed(4),
    };

    // ---- march material ------------------------------------------------------
    this.lightPos = [];
    this.lightColor = [];
    this.lightAxis = [];
    for (let i = 0; i < Math.max(1, budgets.lights); i++) {
      this.lightPos.push(new THREE.Vector4(0, 0, 0, 0));
      this.lightColor.push(new THREE.Vector4(0, 0, 0, 0));
      this.lightAxis.push(new THREE.Vector4(0, -1, 0, -2));
    }

    if (this.enabled) {
      this.marchMaterial = new THREE.ShaderMaterial({
        name: 'mn.sky.fogMarch',
        defines,
        uniforms: {
          tDepth: { value: null },
          tHistory: { value: null },
          uBlueNoise: { value: res.blueNoise },
          uPrevViewProj: { value: new THREE.Matrix4() },
          uViewMatrix: { value: new THREE.Matrix4() },
          uFrame: { value: 0 },
          uHistoryValid: { value: 0 },
          uAmbientGround: { value: FOG.groundBounce },
          uShadowMap: { value: null },
          uShadowMatrix: { value: new THREE.Matrix4() },
          uShadowParams: { value: new THREE.Vector4(1 / 1536, 0, VOLUME.shadowJitterTexels, 0) },
          ...(budgets.lights > 0
            ? {
              uLightPos: { value: this.lightPos },
              uLightColor: { value: this.lightColor },
              uLightAxis: { value: this.lightAxis },
            }
            : {}),
          ...this.shared,
        },
        vertexShader: QUAD_VERT,
        fragmentShader: marchFragment(budgets.steps, budgets.lights),
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        toneMapped: false,
      });
    } else {
      this.marchMaterial = null;
    }

    // ---- composite material --------------------------------------------------
    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'mn.sky.fogComposite',
      defines: this.enabled ? { ...defines, MN_FOG_MARCHED: '1' } : defines,
      uniforms: {
        tDepth: { value: null },
        tVolume: { value: null },
        uIntensity: { value: VOLUME.intensity },
        uSkyFogScale: { value: 1.0 },
        ...this.shared,
      },
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    // `src * ONE + dst * SRC_ALPHA` is the fog equation written as a blend
    // function: inscatter + sceneColour * transmittance. Doing it this way means
    // the HDR buffer is never read back and never round-tripped through a
    // temporary, which on a software rasteriser is a full-resolution copy saved.
    const m = this.compositeMaterial;
    m.transparent = true;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.SrcAlphaFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;

    // ---- scratch, preallocated ----------------------------------------------
    this._prevViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._proj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._historyValid = false;
    this._frame = 0;
    this._ms = 0;
    this._resetPending = true;
    this._muted = false;
  }

  /** Allocate at the internal render resolution. `w`/`h` are the RENDERER's
   *  internal size, not the canvas size. */
  resize(w, h) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    const div = this.budgets.divisor;
    const lw = Math.max(1, Math.ceil(w / div));
    const lh = Math.max(1, Math.ceil(h / div));
    if (lw === this.lowWidth && lh === this.lowHeight && this.rtA) return;

    this.lowWidth = lw;
    this.lowHeight = lh;
    this.shared.uLowRes.value.set(lw, lh, 1 / lw, 1 / lh);

    this.rtA?.dispose();
    this.rtB?.dispose();

    if (this.enabled) {
      const opts = {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        // Linear, because the bilateral upsample takes four taps at texel
        // centres and relies on the hardware NOT interpolating between them.
        // (The weights are computed by hand; nearest would be equivalent here,
        // but linear keeps the fallback path smooth.)
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      };
      this.rtA = new THREE.WebGLRenderTarget(lw, lh, opts);
      this.rtB = new THREE.WebGLRenderTarget(lw, lh, opts);
      this.rtA.texture.name = 'mn.sky.fog.a';
      this.rtB.texture.name = 'mn.sky.fog.b';
      this.rtA.texture.colorSpace = THREE.NoColorSpace;
      this.rtB.texture.colorSpace = THREE.NoColorSpace;
    } else {
      this.rtA = this.rtB = null;
    }
    this._resetPending = true;
  }

  /** Drop the temporal history. Called on a camera teleport and by
   *  `sky.resetTemporal()`. */
  reset() { this._resetPending = true; }

  /** Suppress the composite while still paying for the march — the A/B control
   *  behind `?skyview=nofog`. See the note in debug.js. */
  setMuted(on) { this._muted = !!on; }

  /** Fog density/height/colour, from the active time-of-day preset. */
  setFogParams({ density, uniform, height, baseY, maxDistance, ambient, moonDir, moonIrradiance }) {
    const p = this.shared.uFogParams.value;
    if (density !== undefined) p.x = density;
    if (uniform !== undefined) this.shared.uFogExtra.value.x = uniform;
    if (height !== undefined) p.y = 1 / Math.max(0.25, height);
    if (baseY !== undefined) p.z = baseY;
    if (maxDistance !== undefined) p.w = maxDistance;
    if (ambient) this.shared.uAmbient.value.copy(ambient);
    if (moonDir) this.shared.uMoonDir.value.copy(moonDir);
    if (moonIrradiance) this.shared.uMoonIrradiance.value.copy(moonIrradiance);
  }

  /** Point the march at the key light's shadow map. `light` may be null. */
  setShadowLight(light) {
    if (!this.marchMaterial) return;
    const u = this.marchMaterial.uniforms;
    const map = light?.shadow?.map?.texture ?? null;
    u.uShadowMap.value = map;
    if (map && light.shadow) {
      u.uShadowMatrix.value.copy(light.shadow.matrix);
      u.uShadowParams.value.x = 1 / Math.max(1, light.shadow.mapSize.x);
      u.uShadowParams.value.y = 1;
    } else {
      u.uShadowParams.value.y = 0;
    }
  }

  /**
   * Feed the punctual lights the march scatters from.
   * @param {Array} lights [{ pos: Vector3, rgb: Vector3, cutoff: number,
   *                          axis?: Vector3, cosOuter?: number }]
   *   `axis` + `cosOuter` present => spot light; absent => point light.
   */
  setLights(lights) {
    const n = this.budgets.lights;
    if (!n || !this.marchMaterial) return;
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      if (l) {
        this.lightPos[i].set(l.pos.x, l.pos.y, l.pos.z, l.cutoff);
        this.lightColor[i].set(l.rgb.x, l.rgb.y, l.rgb.z, 1);
        if (l.axis) this.lightAxis[i].set(l.axis.x, l.axis.y, l.axis.z, l.cosOuter);
        else this.lightAxis[i].set(0, -1, 0, -2);
      } else {
        this.lightColor[i].w = 0;
      }
    }
  }

  /**
   * Run the pass. Called by `render` through `registerPass({ stage: 'hdr' })`.
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} api  the renderer's pass API: { target, depth, size, ctx }
   */
  render(renderer, api) {
    const t0 = performance.now();
    const ctx = api.ctx;
    const cam = ctx.camera;
    const depth = api.depth;
    if (!depth) return;

    // Internal resolution can change without a `resize` reaching us first (the
    // renderer resizes its own targets in its own resize handler), so track it.
    if (api.size.width !== this.width || api.size.height !== this.height) {
      this.resize(api.size.width, api.size.height);
    }

    // ---- camera-derived uniforms -------------------------------------------
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    this.shared.uProj.value.set(cam.near, cam.far, tanHalf, cam.aspect);
    this.shared.uCamMatrix.value.copy(cam.matrixWorld);
    this.shared.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    this.shared.uTime.value = ctx.time.elapsed;

    // Build an UNJITTERED projection by hand. `cam.projectionMatrix` currently
    // carries the renderer's TAA jitter (this pass runs mid-frame, before it is
    // restored), and a jittered reprojection matrix makes the temporal filter
    // chase its own tail.
    const top = cam.near * tanHalf;
    const height = 2 * top;
    const width = cam.aspect * height;
    this._proj.makePerspective(-0.5 * width, 0.5 * width, top, top - height, cam.near, cam.far);
    this._viewProj.multiplyMatrices(this._proj, cam.matrixWorldInverse);

    const camPos = this.shared.uCamPos.value;
    const teleported =
      this._resetPending ||
      camPos.distanceTo(this._prevCamPos) > VOLUME.teleportDistance;

    if (this.enabled) {
      const u = this.marchMaterial.uniforms;
      u.tDepth.value = depth;
      u.uViewMatrix.value.copy(cam.matrixWorldInverse);
      u.uPrevViewProj.value.copy(this._prevViewProj);
      u.uFrame.value = this._frame;
      u.uHistoryValid.value = (this._historyValid && !teleported) ? 1 : 0;

      const write = this._writeA ? this.rtA : this.rtB;
      const read = this._writeA ? this.rtB : this.rtA;
      u.tHistory.value = read.texture;

      this.quad.render(renderer, this.marchMaterial, write);

      this.compositeMaterial.uniforms.tVolume.value = write.texture;
      this._writeA = !this._writeA;
      this._historyValid = true;
    }

    // ---- composite into the HDR buffer --------------------------------------
    if (!this._muted) {
      this.compositeMaterial.uniforms.tDepth.value = depth;
      this.quad.render(renderer, this.compositeMaterial, api.target);
    }

    this._prevViewProj.copy(this._viewProj);
    this._prevCamPos.copy(camPos);
    this._resetPending = false;
    this._frame++;
    this._ms = this._ms * 0.9 + (performance.now() - t0) * 0.1;
  }

  stats() {
    return {
      enabled: this.enabled,
      steps: this.budgets.steps,
      lights: this.budgets.lights,
      res: `${this.lowWidth}x${this.lowHeight}`,
      full: `${this.width}x${this.height}`,
      density: +this.shared.uFogParams.value.x.toFixed(4),
      uniform: +this.shared.uFogExtra.value.x.toFixed(4),
      height: +(1 / this.shared.uFogParams.value.y).toFixed(2),
      shadowed: this.marchMaterial ? this.marchMaterial.uniforms.uShadowParams.value.y > 0.5 : false,
      ms: +this._ms.toFixed(2),
    };
  }

  dispose() {
    this.marchMaterial?.dispose();
    this.compositeMaterial.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.quad.dispose();
    this.rtA = this.rtB = null;
  }
}
