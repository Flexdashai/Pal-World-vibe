import * as THREE from 'three';
import { SKY_LUT_GLSL, SKY_UNIFORMS_GLSL } from './atmosphere.js';
import { DOME, MOON, CLOUDS, ATMOS } from './tuning.js';

/**
 * The sky dome.
 *
 * DRAW ORDER IS THE DESIGN. The dome is an OPAQUE mesh with `depthWrite: false`
 * and `renderOrder` 900, so three draws it after every other opaque object in
 * the scene. That is not a stylistic choice, it is a performance one: this is by
 * a wide margin the most expensive per-pixel shader `sky` owns (a LUT fetch, two
 * cloud layers, a moon, a galaxy), and in a crypt 85-95% of the frame is wall.
 * Drawing it last lets the depth buffer reject every hidden sky pixel before the
 * fragment shader runs. Drawing it first — the usual "background sphere" recipe
 * — costs the full shader on every pixel of the frame and buys nothing.
 *
 * The dome is re-centred on the camera every frame, so its radius only has to
 * clear the world geometry, not the world. 118 m sits inside `CAMERA.far` (140)
 * with room for the near-plane at the far side.
 */

/**
 * Cloud evaluation, shared with `stars.js` — the star field has to know how much
 * cloud is in front of each star, and the only way to make two shaders agree
 * about that is to give them the same function.
 *
 * The layers are sampled on a SPHERICAL SHELL, not a flat plane. A flat plane
 * sends the intersection distance to infinity at the horizon, so the clouds
 * stretch into infinitely long streaks; a shell at Rg+alt makes them converge
 * and pile up the way real clouds do. The stable form of the quadratic
 * (multiply through by the conjugate) is used because the naive
 * `-b + sqrt(b*b + c)` cancels catastrophically at the zenith, where b is 6360
 * and the answer is 7.
 */
export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D uCloudNoise;
uniform vec4 uCloudHigh;   // scale, coverage, softness, density
uniform vec4 uCloudLow;    // scale, coverage, softness, density
uniform vec4 uCloudDrift;  // high.xy, low.xy  (km/s)
uniform vec3 uCloudTint;
uniform float uCloudTime;

/** Horizontal position, in km, where a view ray pierces a shell at altitude
 *  'alt' km. Returns -1 in .z when the ray never reaches it. */
vec3 mnShellHit( vec3 dir, float alt ) {
  float mu = dir.y;
  if ( mu <= 0.002 ) return vec3( 0.0, 0.0, -1.0 );
  float Rg = ${ATMOS.Rg.toFixed(1)};
  float b = Rg * mu;
  float c = 2.0 * Rg * alt + alt * alt;
  float t = c / ( b + sqrt( b * b + c ) );
  return vec3( dir.x * t, dir.z * t, t );
}

/**
 * Coverage of one layer at a view direction. Returns
 *   .x  optical depth of the cloud (0 = clear)
 *   .y  a 0..1 "how deep inside the cloud" factor used for shading
 */
vec2 mnCloudLayer( vec3 dir, float alt, vec4 P, vec2 drift ) {
  vec3 hit = mnShellHit( dir, alt );
  if ( hit.z < 0.0 ) return vec2( 0.0 );

  vec2 uv = hit.xy * P.x + drift * uCloudTime;

  // Domain warp from the decorrelated channel, so the fbm stops reading as an
  // fbm. Two fetches total per layer, which is the whole budget.
  vec4 w = textureLod( uCloudNoise, uv * 0.22, 0.0 );
  vec4 n = textureLod( uCloudNoise, uv + ( w.a - 0.5 ) * 0.35, 0.0 );

  float shape = n.r * 0.66 + n.g * 0.22 + n.b * 0.12;
  float cover = smoothstep( P.y, P.y + P.z, shape );

  // Fade the layer out at the horizon: the shell intersection becomes a hundreds
  // of kilometres away and every texel of the noise is a hundred metres wide, so
  // without this the horizon turns into aliased confetti.
  float horizonFade = smoothstep( 0.0, 0.10, dir.y );
  return vec2( cover * P.w * horizonFade, cover );
}

/** Combined transmittance through both layers along a direction. */
float mnCloudTransmittance( vec3 dir ) {
  vec2 hi = mnCloudLayer( dir, ${CLOUDS.highAlt.toFixed(2)}, uCloudHigh, uCloudDrift.xy );
  vec2 lo = mnCloudLayer( dir, ${CLOUDS.lowAlt.toFixed(2)}, uCloudLow, uCloudDrift.zw );
  return exp( -( hi.x + lo.x ) );
}
`;

/**
 * Lat-long projection, shared by the dome's and the star field's panorama debug
 * variants.
 *
 * This exists because of a fact about this game that is easy to miss: the camera
 * pitch is FIXED at -52 degrees, so the entire frame is below the horizon and
 * the sky is never visible in any shot. "Is the sky any good" is therefore
 * unanswerable from a normal capture — and a sky nobody can look at is a sky
 * nobody can fix. The panorama variant re-projects the same shader onto the
 * whole screen as an equirectangular map, so one capture shows the moon, the
 * clouds, the galaxy and the horizon gradient at once.
 */
export const PANORAMA_GLSL = /* glsl */ `
vec3 mnPanoramaDir( vec2 uv ) {
  float lon = ( uv.x * 2.0 - 1.0 ) * 3.14159265;
  float lat = ( uv.y - 0.5 ) * 3.14159265;
  float cl = cos( lat );
  return vec3( cl * sin( lon ), sin( lat ), -cl * cos( lon ) );
}
`;

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
varying vec2 vPano;
void main() {
  #ifdef MN_SKY_PANORAMA
    vPano = uv;
    vDir = vec3( 0.0, 1.0, 0.0 );
    gl_Position = vec4( position.xy, 1.0, 1.0 );
  #else
    // The dome is a unit-scaled sphere re-centred on the camera every frame, so
    // the normalised object-space position IS the world view direction. Deriving
    // it here rather than from the fragment's world position keeps the fragment
    // shader free of a matrix multiply per pixel.
    vPano = vec2( 0.0 );
    vDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  #endif
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
varying vec2 vPano;

${SKY_UNIFORMS_GLSL}
${SKY_LUT_GLSL}
${CLOUD_GLSL}
${PANORAMA_GLSL}

uniform vec3 uMoonDir;        // unit, toward the moon
uniform vec3 uMoonColor;      // linear, already includes the mood tint
uniform vec3 uMoonSun;        // unit, direction the moon is lit FROM
uniform vec3 uLightColor;     // colour driving the scattering integral
uniform vec4 uMoonDisc;       // cos(angular radius), sin(angular radius), radiance, glowK
uniform vec3 uMwPole;         // galactic pole
uniform vec2 uMwParams;       // strength, band sigma
uniform float uExposureFloor;

/* Cheap value noise for the moon's maria, sampled from the shared cloud texture
   in a fixed frame so the pattern does not swim as the moon moves. */
float mnMaria( vec2 p ) {
  vec4 n = textureLod( uCloudNoise, p, 0.0 );
  return n.r * 0.6 + n.b * 0.4;
}

#ifdef MN_SKY_PANORAMA
uniform float uPanoExposure;
uniform vec2 uPanoZoom;     // x = zoom (1 = full lat-long), y = aspect
vec3 mnSrgb( vec3 c ) {
  c = clamp( c, 0.0, 1.0 );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
}
#endif

void main() {
  #ifdef MN_SKY_PANORAMA
    vec3 dir;
    if ( uPanoZoom.x > 1.5 ) {
      // Gnomonic projection centred on the moon, for reviewing the disc itself.
      // At the true 0.55 degree angular radius the moon is four pixels across in
      // a full lat-long panorama, so the limb darkening, the maria and the
      // terminator — the whole reason the disc is not a white circle — cannot be
      // judged without one.
      vec2 c = ( vPano - 0.5 ) * ( 3.14159265 / uPanoZoom.x ) * vec2( uPanoZoom.y, 1.0 );
      vec3 up = abs( uMoonDir.y ) < 0.985 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
      vec3 tx = normalize( cross( up, uMoonDir ) );
      vec3 ty = cross( uMoonDir, tx );
      dir = normalize( uMoonDir + tx * tan( c.x ) + ty * tan( c.y ) );
    } else {
      dir = mnPanoramaDir( vPano );
    }
  #else
    vec3 dir = normalize( vDir );
  #endif

  // ---- 1. atmospheric scattering ------------------------------------------
  vec3 col = mnSkyRadiance( dir, uMoonDir, uLightColor );

  // ---- 2. the galaxy -------------------------------------------------------
  // A band around a great circle, with structure from the ridged channel and a
  // dust lane cut out of the middle. Faint on purpose: the Milky Way is a
  // texture you notice on the second look, not a feature.
  float bandT = dot( dir, uMwPole );
  float band = exp( -( bandT * bandT ) / ( 2.0 * uMwParams.y * uMwParams.y ) );
  if ( band > 0.002 ) {
    // Project onto a stable 2D frame perpendicular to the pole.
    vec3 e1 = normalize( cross( uMwPole, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4, 0.0, 0.0 ) );
    vec3 e2 = cross( uMwPole, e1 );
    vec2 muv = vec2( dot( dir, e1 ), dot( dir, e2 ) ) * 0.55;
    vec4 mw4 = textureLod( uCloudNoise, muv, 0.0 );
    float glow = mw4.r * 0.55 + mw4.b * 0.45;
    float dust = smoothstep( 0.35, 0.75, mw4.g );
    float mw = band * uMwParams.x * ( 0.35 + 0.65 * glow ) * ( 1.0 - 0.7 * dust );
    // The band is a great circle, so half of it is under the horizon where there
    // is no sky to put it on. Fade it with the same ramp the airglow uses.
    mw *= dir.y < 0.0 ? max( 0.0, 1.0 + dir.y * 6.0 ) : 1.0;
    // Slightly warm: the integrated light of a galaxy is dominated by K giants.
    col += mw * vec3( 0.0042, 0.0038, 0.0044 );
  }

  // ---- 3. the moon ---------------------------------------------------------
  float cosA = dot( dir, uMoonDir );
  vec3 moonExt = mnTransmittance( max( uMoonDir.y, -0.05 ) );

  if ( cosA > uMoonDisc.x ) {
    // Disc-local coordinates. r = 0 at the centre, 1 at the limb.
    vec3 up = abs( uMoonDir.y ) < 0.985 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
    vec3 tx = normalize( cross( up, uMoonDir ) );
    vec3 ty = cross( uMoonDir, tx );
    vec2 duv = vec2( dot( dir, tx ), dot( dir, ty ) ) / uMoonDisc.y;
    float r = length( duv );

    if ( r < 1.05 ) {
      float mu = sqrt( max( 0.0, 1.0 - min( 1.0, r * r ) ) );
      // Outward surface normal of the point on the lunar sphere we are seeing.
      vec3 n = -uMoonDir * mu + tx * duv.x + ty * duv.y;
      float mu0 = clamp( dot( n, uMoonSun ), 0.0, 1.0 );

      // Lambert vs Lommel-Seeliger. A regolith is much closer to LS, which is
      // why a full moon looks like a flat disc rather than a shaded ball; the
      // 1.6 renormalises LS's 0.5-at-opposition back to unity.
      float lambert = mu0;
      float ls = 1.6 * mu0 / max( 0.06, mu0 + mu );
      float shade = mix( lambert, ls, ${MOON.lommel.toFixed(3)} );
      // Classical limb darkening on top, which is what gives the edge a body.
      shade *= 1.0 - ${MOON.limbU.toFixed(3)} * ( 1.0 - mu );

      // Maria: the dark basalt plains. Sampled in the disc frame, so they stay
      // locked to the moon rather than crawling across it.
      float maria = mnMaria( duv * ${MOON.mariaScale.toFixed(2)} + 0.37 );
      shade *= 1.0 - ${MOON.mariaDepth.toFixed(3)} * smoothstep( 0.42, 0.70, maria );

      // Antialias the limb over one pixel of screen-space derivative.
      float aa = max( fwidth( r ), 1e-4 );
      float edge = 1.0 - smoothstep( 1.0 - aa * 1.5, 1.0, r );

      col += uMoonColor * moonExt * ( uMoonDisc.z * shade * edge );
    }
  }

  // ---- 4. the tight aureole ------------------------------------------------
  // The LUT's Mie term gives the wide halo. This is the bright ring immediately
  // around the limb that a long lens picks up; without it the disc has a hard
  // edge against the sky no matter how good the antialiasing is.
  float glow = pow( max( 0.0, cosA ), uMoonDisc.w );
  col += uMoonColor * moonExt * glow * ${MOON.glowStrength.toFixed(4)} * uMoonDisc.z;

  // ---- 5. clouds -----------------------------------------------------------
  vec2 hi = mnCloudLayer( dir, ${CLOUDS.highAlt.toFixed(2)}, uCloudHigh, uCloudDrift.xy );
  vec2 lo = mnCloudLayer( dir, ${CLOUDS.lowAlt.toFixed(2)}, uCloudLow, uCloudDrift.zw );
  float tau = hi.x + lo.x;
  if ( tau > 0.001 ) {
    float T = exp( -tau );
    // What the cloud itself emits toward us: moonlight scattered forward through
    // it (the silver lining, strongly peaked toward the moon) plus the ambient
    // sky it is sitting in.
    float forward = pow( max( 0.0, cosA ), 6.0 );
    vec3 lit = uMoonColor * moonExt * ( 0.012 + ${CLOUDS.silverLining.toFixed(3)} * 0.02 * forward );
    vec3 ambient = mnSkyRadiance( vec3( dir.x, max( dir.y, 0.25 ), dir.z ), uMoonDir, uLightColor ) * 0.85;
    vec3 cloudCol = ( lit + ambient ) * uCloudTint;
    col = col * T + cloudCol * ( 1.0 - T );
  }

  // A floor so the sky is never mathematically zero: a pure black sky through a
  // gate reads as a hole in the geometry, not as night.
  col = max( col, vec3( uExposureFloor ) );

  #ifdef MN_SKY_PANORAMA
    // The debug pass draws to the canvas AFTER the composite, i.e. in display
    // space, so it applies its own exposure and transfer curve rather than
    // borrowing the frame's — which would be metered for a crypt interior and
    // would show the night sky as black.
    //
    // Reinhard rather than a plain gain: the moon disc is four orders of
    // magnitude above the sky, so any linear exposure that makes the sky
    // reviewable turns the moon into a white blob and the limb darkening, the
    // maria and the terminator — the three things worth looking at — become
    // unreviewable. The roll-off keeps both ends on screen.
    vec3 pc = col * uPanoExposure;
    gl_FragColor = vec4( mnSrgb( pc / ( 1.0 + pc ) ), 1.0 );
  #else
    gl_FragColor = vec4( col, 1.0 );
  #endif
}
`;

export class SkyDome {
  constructor(cloudNoise, scatterLut) {
    const geo = new THREE.SphereGeometry(DOME.radius, DOME.widthSegments, DOME.heightSegments);
    this.geometry = geo;

    this.uniforms = {
      // --- atmosphere ---
      uScatterLut: { value: scatterLut.texture },
      uTransLut: { value: scatterLut.transmittance },
      uSkyIrradiance: { value: 0.0135 },
      uRayleighTint: { value: new THREE.Vector3(1, 1, 1) },
      uMieTint: { value: new THREE.Vector3(1, 1, 1) },
      uNightFloor: { value: new THREE.Vector3(0.001, 0.0015, 0.0025) },
      uNightHorizon: { value: 2.1 },
      uLightColor: { value: new THREE.Vector3(1, 1, 1) },

      // --- moon ---
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonColor: { value: new THREE.Vector3(1, 1, 1) },
      uMoonSun: { value: new THREE.Vector3(0, 0, -1) },
      uMoonDisc: { value: new THREE.Vector4(0.9999, 0.01, MOON.radiance, 4000) },

      // --- galaxy ---
      uMwPole: { value: new THREE.Vector3(0.42, 0.79, -0.44).normalize() },
      uMwParams: { value: new THREE.Vector2(0.75, 0.20) },

      // --- clouds ---
      uCloudNoise: { value: cloudNoise },
      uCloudHigh: { value: new THREE.Vector4(CLOUDS.highScale, CLOUDS.highCoverage, CLOUDS.highSoft, CLOUDS.highDensity) },
      uCloudLow: { value: new THREE.Vector4(CLOUDS.lowScale, CLOUDS.lowCoverage, CLOUDS.lowSoft, CLOUDS.lowDensity) },
      uCloudDrift: { value: new THREE.Vector4(...CLOUDS.highDrift, ...CLOUDS.lowDrift) },
      uCloudTint: { value: new THREE.Vector3(0.62, 0.70, 0.92) },
      uCloudTime: { value: 0 },

      uExposureFloor: { value: 0.0006 },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'mn.sky.dome',
      uniforms: this.uniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      // Opaque, but writes no depth: it must not occlude anything and it must
      // not appear in the transparent sort. See the class docblock on why it is
      // drawn LAST among the opaque objects instead of first.
      transparent: false,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'mn.sky.dome';
    this.mesh.renderOrder = DOME.renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Out of the depth/normal/velocity prepass: the sky has no surface, and a
    // dome writing view normals would make SSR reflect it and GTAO occlude
    // against it. Out of the shadow pass for the same reason.
    this.mesh.userData.mnNoPrepass = true;
    this.mesh.userData.mnNoShadow = true;
    this.mesh.matrixAutoUpdate = true;
  }

  /** Keep the dome centred on the camera so its radius only has to clear the
   *  level, and advance the cloud clock. */
  update(camera, time) {
    this.mesh.position.copy(camera.position);
    this.uniforms.uCloudTime.value = time;
  }

  /**
   * A fullscreen equirectangular variant of the SAME shader, for the debug view.
   * The uniforms are shared by reference, so the panorama shows exactly what the
   * dome shows — a separate "preview" shader would be a second implementation to
   * keep in sync, and it would drift.
   */
  panoramaMaterial(exposure = 42, zoom = 1, aspect = 16 / 9) {
    if (this._pano) {
      this._pano.uniforms.uPanoExposure.value = exposure;
      this._pano.uniforms.uPanoZoom.value.set(zoom, aspect);
      return this._pano;
    }
    this._pano = new THREE.ShaderMaterial({
      name: 'mn.sky.dome.panorama',
      defines: { MN_SKY_PANORAMA: '1' },
      uniforms: {
        ...this.uniforms,
        uPanoExposure: { value: exposure },
        uPanoZoom: { value: new THREE.Vector2(zoom, aspect) },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    return this._pano;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this._pano?.dispose();
    this._pano = null;
  }
}
