import * as THREE from 'three';
import { STARS, DOME, ATMOS } from './tuning.js';
import { CLOUD_GLSL, PANORAMA_GLSL } from './dome.js';
import { muToU } from './atmosphere.js';

/**
 * The star field.
 *
 * Procedural "hash the direction into cells and find the nearest star" star
 * fields are cheap and always look wrong, for one reason: they produce a uniform
 * density of identical dots. A real sky is dominated by the MAGNITUDE
 * DISTRIBUTION — the cumulative count of stars brighter than magnitude m goes as
 * 10^(0.6 m), so each magnitude step down multiplies the count by four while
 * dividing the brightness by 2.5. That is what makes a night sky read as depth
 * rather than as noise: a handful of bright anchors, a scatter of middling ones,
 * and a wash of barely-there ones underneath.
 *
 * So the catalogue is generated on the CPU, once, from `ctx.rng.fork()`:
 *
 *   magnitude   inverse-CDF sampled from 10^(0.6 m), clipped at m = 5.9 because
 *               anything fainter lands below the dither floor at 720p and is
 *               pure cost
 *   colour      B-V sampled from a realistic mixture, converted to a temperature
 *               by Ballesteros' formula and then to linear RGB through the
 *               Planckian locus. Most naked-eye stars are yellow-white; the few
 *               blue ones are what make the field look observed rather than
 *               invented
 *   position    uniform on the sphere, with 42% of the population pulled into a
 *               galactic band
 *   twinkle     scintillation amplitude scaled by AIRMASS, so a star overhead is
 *               steady and one near the horizon boils. That correlation is the
 *               thing the eye actually reads as "atmosphere"
 *
 * Rendered as one `THREE.Points` draw. The vertex shader applies atmospheric
 * extinction from the same transmittance LUT the dome uses and the same cloud
 * field the dome uses, so stars redden near the horizon and go out behind cloud
 * — which is the only reason the star layer and the dome layer look like one
 * sky rather than two.
 */

/** B-V colour index -> effective temperature, Ballesteros 2012. Good to a few
 *  percent across the whole main sequence, which is far better than this needs. */
function bvToTemp(bv) {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/** Planckian locus in CIE xy (Kim et al. 2002), then xy -> linear sRGB.
 *  Normalised to unit luminance so the magnitude alone controls brightness. */
function tempToLinearRgb(T, out) {
  const t = Math.max(1667, Math.min(25000, T));
  const t2 = t * t, t3 = t2 * t;
  let x;
  if (t < 4000) x = -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.179910;
  else x = -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.240390;

  const x2 = x * x, x3 = x2 * x;
  let y;
  if (t < 2222) y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
  else if (t < 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;

  const Y = 1.0;
  const X = (x / Math.max(1e-4, y)) * Y;
  const Z = ((1 - x - y) / Math.max(1e-4, y)) * Y;

  // CIE XYZ -> linear sRGB.
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);

  // Renormalise to unit luminance, so a magnitude-2 red giant and a magnitude-2
  // blue supergiant carry the same energy and differ only in hue.
  const lum = Math.max(1e-4, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  out[0] = r / lum; out[1] = g / lum; out[2] = b / lum;
  return out;
}

const STAR_VERT = /* glsl */ `
precision highp float;

attribute float aMag;
attribute vec3 aColor;
attribute vec2 aTwinkle;    // phase, rate (Hz)

uniform sampler2D uTransLut;
uniform float uTime;
uniform float uBrightness;
uniform float uSizeScale;
uniform float uPixelHeight;

${CLOUD_GLSL}
${PANORAMA_GLSL}

#ifdef MN_SKY_PANORAMA
uniform float uPanoExposure;
#endif

varying vec3 vColor;
varying float vSpike;

float mnMuToU( float mu ) {
  return 0.5 + 0.5 * sign( mu ) * sqrt( abs( mu ) );
}

void main() {
  vec3 dir = normalize( position );

  // Airmass, Kasten-Young. Drives BOTH the extinction and the twinkle, which is
  // why they stay correlated: a star that has reddened has also started to boil.
  float alt = asin( clamp( dir.y, -1.0, 1.0 ) );
  float altDeg = degrees( alt );
  float airmass = 1.0 / max( 0.02, sin( alt ) + 0.15 * pow( max( 0.1, altDeg + 3.885 ), -1.253 ) );

  vec3 ext = texture( uTransLut, vec2( mnMuToU( max( dir.y, 0.0 ) ), 0.5 ) ).rgb;
  float cloud = mnCloudTransmittance( dir );

  // Scintillation. Two incommensurate sinusoids so it never reads as a loop.
  float tw = sin( uTime * aTwinkle.y + aTwinkle.x )
           + 0.55 * sin( uTime * aTwinkle.y * 1.71 + aTwinkle.x * 2.3 );
  float amp = ${STARS.twinkleAmp.toFixed(3)} * clamp( ( airmass - 1.0 ) * 0.5, 0.0, 1.4 );
  float flicker = clamp( 1.0 + amp * tw * 0.5, 0.25, 1.9 );

  // Pogson: each magnitude is a factor of 10^0.4.
  float flux = pow( 10.0, -0.4 * aMag );
  vColor = aColor * ( ${STARS.mag0Radiance.toFixed(3)} * flux * uBrightness ) * ext * cloud * flicker;

  // A star below the horizon is not visible; fade rather than clip so a moving
  // camera does not pop them.
  vColor *= smoothstep( -0.03, 0.05, dir.y );

  // Sprite size grows only mildly with brightness — a real PSF saturates, it
  // does not scale with flux. The bright ones get their apparent size from the
  // bloom pyramid instead, which is exactly how a camera does it.
  float size = uSizeScale * pow( 2.512, -aMag * 0.25 ) * ( uPixelHeight / ${STARS.refHeightPx.toFixed(1)} );
  gl_PointSize = max( ${STARS.minSizePx.toFixed(2)}, size * flicker );

  vSpike = smoothstep( ${STARS.spikeMagnitude.toFixed(2)}, -0.5, aMag );

  #ifdef MN_SKY_PANORAMA
    // Same lat-long mapping the dome's panorama variant uses, inverted. Point
    // sprites project fine through an arbitrary vertex transform, which is why
    // the star layer can join the panorama at all.
    float lon = atan( dir.x, -dir.z );
    float lat = asin( clamp( dir.y, -1.0, 1.0 ) );
    vec2 puv = vec2( lon / 6.2831853 + 0.5, lat / 3.14159265 + 0.5 );
    gl_Position = vec4( puv * 2.0 - 1.0, 0.0, 1.0 );
    // The panorama covers 180 degrees vertically where the game camera covers
    // 34, so a sprite sized for the game frame would be five times too big here.
    gl_PointSize = max( 1.0, gl_PointSize * 0.34 );
    vColor *= uPanoExposure;
  #else
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  #endif
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vSpike;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot( p, p );
  if ( r2 > 1.0 ) discard;

  // Gaussian core. Sharper than a linear falloff so a 2 px sprite still has a
  // definite centre after the TAA resolve softens it.
  float core = exp( -r2 * 5.5 );

  // Diffraction cross, only for the brightest few. It costs four ALU and it is
  // the single cheapest thing that makes a bright star read as BRIGHT rather
  // than as a large dot.
  float spike = 0.0;
  if ( vSpike > 0.01 ) {
    float sx = max( 0.0, 1.0 - abs( p.x ) * 1.15 ) * max( 0.0, 1.0 - abs( p.y ) * 7.0 );
    float sy = max( 0.0, 1.0 - abs( p.y ) * 1.15 ) * max( 0.0, 1.0 - abs( p.x ) * 7.0 );
    spike = ( sx + sy ) * ${STARS.spike.toFixed(3)} * vSpike;
  }

  gl_FragColor = vec4( vColor * ( core + spike ), 1.0 );
}
`;

export class StarField {
  constructor(rng, cloudUniforms, transLut) {
    const n = STARS.count;
    const pos = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const twk = new Float32Array(n * 2);
    const rgb = [0, 0, 0];

    // Galactic pole. Fixed rather than random so the band always crosses the
    // frame in a composed direction rather than sometimes sitting on the
    // horizon where nothing can see it.
    const pole = new THREE.Vector3(0.42, 0.79, -0.44).normalize();
    const e1 = new THREE.Vector3().crossVectors(pole, new THREE.Vector3(0, 1, 0));
    if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0);
    e1.normalize();
    const e2 = new THREE.Vector3().crossVectors(pole, e1).normalize();
    const dir = new THREE.Vector3();

    // Inverse CDF of N(<m) proportional to 10^(0.6 m).
    const a = Math.pow(10, 0.6 * STARS.magMin);
    const b = Math.pow(10, 0.6 * STARS.magMax);

    let bright = 0;
    for (let i = 0; i < n; i++) {
      const u = rng.float();
      const m = Math.log10(a + u * (b - a)) / 0.6;
      mag[i] = m;
      if (m < 2.0) bright++;

      // --- direction ---
      if (rng.float() < STARS.milkyWayFraction) {
        // In the band: uniform azimuth around the great circle, gaussian offset
        // along the pole.
        const az = rng.float() * Math.PI * 2;
        const off = rng.gauss() * STARS.milkyWaySigma;
        dir.copy(e1).multiplyScalar(Math.cos(az)).addScaledVector(e2, Math.sin(az));
        dir.addScaledVector(pole, off).normalize();
      } else {
        // Uniform on the sphere: z uniform in [-1,1], azimuth uniform. Sampling
        // the polar ANGLE uniformly instead is the classic mistake and produces
        // visible clumps at the poles.
        const z = rng.range(-1, 1);
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const az = rng.float() * Math.PI * 2;
        dir.set(r * Math.cos(az), z, r * Math.sin(az));
      }

      const R = DOME.radius - 2.0;
      pos[i * 3 + 0] = dir.x * R;
      pos[i * 3 + 1] = dir.y * R;
      pos[i * 3 + 2] = dir.z * R;

      // --- colour ---
      // B-V mixture: a broad yellow-white main-sequence population, a blue tail
      // for the hot stars and a red tail for the giants. The proportions are
      // roughly those of the naked-eye sky.
      const p = rng.float();
      let bv;
      if (p < 0.16) bv = rng.range(-0.32, 0.15);        // O/B/A — blue-white
      else if (p < 0.72) bv = rng.range(0.15, 0.85);    // F/G — white to yellow
      else if (p < 0.93) bv = rng.range(0.85, 1.45);    // K — orange
      else bv = rng.range(1.45, 2.05);                  // M — red giants
      tempToLinearRgb(bvToTemp(bv), rgb);
      col[i * 3 + 0] = rgb[0];
      col[i * 3 + 1] = rgb[1];
      col[i * 3 + 2] = rgb[2];

      twk[i * 2 + 0] = rng.float() * Math.PI * 2;
      twk[i * 2 + 1] = rng.range(STARS.twinkleHzMin, STARS.twinkleHzMax) * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aTwinkle', new THREE.BufferAttribute(twk, 2));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DOME.radius);
    this.geometry = geo;
    this.brightCount = bright;

    this.uniforms = {
      uTransLut: { value: transLut },
      uTime: { value: 0 },
      uBrightness: { value: 1 },
      uSizeScale: { value: STARS.mag0SizePx },
      uPixelHeight: { value: STARS.refHeightPx },
      // Shared BY REFERENCE with the dome so the two cannot disagree about
      // where the cloud is; the dome owns these uniform objects.
      uCloudNoise: cloudUniforms.uCloudNoise,
      uCloudHigh: cloudUniforms.uCloudHigh,
      uCloudLow: cloudUniforms.uCloudLow,
      uCloudDrift: cloudUniforms.uCloudDrift,
      uCloudTint: cloudUniforms.uCloudTint,
      uCloudTime: cloudUniforms.uCloudTime,
    };

    this.material = new THREE.ShaderMaterial({
      name: 'mn.sky.stars',
      uniforms: this.uniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      // Additive: stars ADD light to the sky behind them. Alpha blending would
      // let a faint star DARKEN a bright patch of Milky Way, which is exactly
      // backwards.
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'mn.sky.stars';
    this.points.renderOrder = DOME.starOrder;
    this.points.frustumCulled = false;
    this.points.userData.mnNoPrepass = true;
    this.points.userData.mnNoShadow = true;
    // Stars are the definition of a bloom source: a handful of pixels four
    // stops above everything around them.
    this.points.userData.mnGlow = 1.0;
  }

  update(camera, time, screenHeight) {
    this.points.position.copy(camera.position);
    this.uniforms.uTime.value = time;
    this.uniforms.uPixelHeight.value = screenHeight;
  }

  setBrightness(v) { this.uniforms.uBrightness.value = v; }

  /** Equirectangular variant of the same shader, sharing the same uniforms and
   *  the same geometry, for the panorama debug view. See `SkyDome.panoramaMaterial`. */
  panoramaObject(exposure = 42) {
    if (this._panoPoints) {
      this._panoPoints.material.uniforms.uPanoExposure.value = exposure;
      return this._panoPoints;
    }
    const mat = new THREE.ShaderMaterial({
      name: 'mn.sky.stars.panorama',
      defines: { MN_SKY_PANORAMA: '1' },
      uniforms: { ...this.uniforms, uPanoExposure: { value: exposure } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this._panoPoints = new THREE.Points(this.geometry, mat);
    this._panoPoints.frustumCulled = false;
    return this._panoPoints;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this._panoPoints?.material.dispose();
    this._panoPoints = null;
  }
}

/** Exported for the IBL: the integrated starlight contribution is a constant
 *  fraction of a percent of the sky's irradiance, but it is not zero and
 *  leaving it out makes a sealed room with no moon read as absolute black. */
export const STARLIGHT_IRRADIANCE = 0.00035;

/** Re-exported so `ibl.js` can share the LUT parameterisation without importing
 *  the atmosphere module twice. */
export { muToU as starMuToU };
export const ATMOSPHERE_TOP = ATMOS.Rt;
