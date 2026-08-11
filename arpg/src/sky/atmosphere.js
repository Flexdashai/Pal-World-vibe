import * as THREE from 'three';
import { ATMOS } from './tuning.js';

/**
 * Precomputed single-scattering atmosphere.
 *
 * WHY A LUT AT ALL, for a game that is mostly indoors: because the sky is the
 * only physically-derived light source in the frame, and everything downstream
 * of it — the fog colour, the ambient term in the IBL, the tint of the moon's
 * limb, how blue a distant wall goes — inherits its plausibility. A hand-painted
 * gradient looks fine as a backdrop and then produces a fog colour that fights
 * the moon, because nothing forces the two to agree. Deriving both from one
 * scattering integral makes them agree by construction.
 *
 * THE MODEL
 *
 * Single scattering, spherical shell, Rayleigh + Mie + ozone absorption:
 *
 *   L(v, l) = E * integral_0^tmax  T(cam -> p) * T(p -> space along l)
 *                                  * ( betaR * rhoR(p) * PhaseR(v.l)
 *                                    + betaM * rhoM(p) * PhaseM(v.l) ) dt
 *
 * The phase functions depend only on the angle between the view and the light,
 * so they are factored OUT of the integral and applied at sample time. What is
 * left depends on the view zenith angle and the light zenith angle and nothing
 * else — under the plane-parallel approximation for the light path, which is
 * exact enough for a body at infinity and a 60 km atmosphere. That reduction
 * from three parameters to two is what makes a 64x32 table sufficient.
 *
 * THE PARAMETERISATION
 *
 *   u = 0.5 + 0.5 * sign(mu) * sqrt(|mu|)      mu = cos(view zenith)
 *   v = 0.5 + 0.5 * sign(ml) * sqrt(|ml|)      ml = cos(light zenith)
 *
 * The square root puts ~40% of the texels within 15 degrees of the horizon,
 * where the whole gradient lives. A linear mapping wastes most of the table on
 * the top of the dome, where the sky is nearly constant. `SKY_LUT_GLSL` below
 * emits the exact same mapping as GLSL so the shader and the CPU evaluator
 * cannot drift apart — which they will, silently, if the mapping is typed twice.
 */

/** Ozone density at altitude h (km): a tent, matching Bruneton's profile. */
function ozoneDensity(h) {
  const t = 1 - Math.abs(h - ATMOS.ozoneCentre) / ATMOS.ozoneWidth;
  return Math.max(0, t);
}

/** Distance from a point at radius r with cos(zenith) mu to a shell of radius R.
 *  Returns -1 if the ray never reaches it. */
function shellDistance(r, mu, R) {
  const disc = r * r * (mu * mu - 1) + R * R;
  if (disc < 0) return -1;
  return -r * mu + Math.sqrt(disc);
}

/** Does a ray from radius r with cos(zenith) mu hit the ground? */
function hitsGround(r, mu) {
  return mu < 0 && r * r * (mu * mu - 1) + ATMOS.Rg * ATMOS.Rg >= 0;
}

/** Optical depth from a point to the top of the atmosphere along cos(zenith) mu.
 *  Returns [tauR, tauM, tauO] as scalar densities-times-length in km; the caller
 *  multiplies by the scattering coefficients. */
function opticalDepthToSpace(r, mu, samples, out) {
  out[0] = out[1] = out[2] = 0;
  if (hitsGround(r, mu)) { out[0] = out[1] = out[2] = 1e9; return out; }

  const tmax = shellDistance(r, mu, ATMOS.Rt);
  if (tmax <= 0) return out;

  const dt = tmax / samples;
  for (let i = 0; i < samples; i++) {
    // Midpoint rule: for an exponential profile it is dramatically more accurate
    // than the trapezoid at the same cost, because the error terms of the two
    // halves of each interval cancel to first order.
    const t = (i + 0.5) * dt;
    const rr = Math.sqrt(r * r + t * t + 2 * r * t * mu);
    const h = Math.max(0, rr - ATMOS.Rg);
    out[0] += Math.exp(-h / ATMOS.HR) * dt;
    out[1] += Math.exp(-h / ATMOS.HM) * dt;
    out[2] += ozoneDensity(h) * dt;
  }
  return out;
}

/** Transmittance (per RGB) for the optical depths returned above. */
function transmittanceFrom(tau, out) {
  const { betaR, betaM, betaO } = ATMOS;
  const ext = ATMOS.betaMExt / ATMOS.betaM;
  for (let c = 0; c < 3; c++) {
    const t = betaR[c] * tau[0] + betaM * ext * tau[1] + betaO[c] * tau[2];
    out[c] = Math.exp(-t);
  }
  return out;
}

/** LUT parameterisation, CPU side. Kept adjacent to `SKY_LUT_GLSL` so a change
 *  to one is impossible to make without seeing the other. */
export function muToU(mu) {
  const s = mu < 0 ? -1 : 1;
  return 0.5 + 0.5 * s * Math.sqrt(Math.abs(mu));
}
export function uToMu(u) {
  const d = u - 0.5;
  const s = d < 0 ? -1 : 1;
  const a = Math.abs(d) * 2;
  return s * a * a;
}

/**
 * Bake the in-scatter LUT and the transmittance LUT.
 *
 * Cost on this container is ~40 ms: lutW*lutH*(viewSamples*(1 + lightSamples))
 * exponentials. Done once at init; the tables are independent of time of day
 * because the light zenith angle is an AXIS of the table, not a constant baked
 * into it. `setTimeOfDay` therefore costs a uniform write, not a rebake.
 */
export function buildAtmosphereLuts() {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
  const W = ATMOS.lutW, H = ATMOS.lutH;
  const N = ATMOS.lutViewSamples, M = ATMOS.lutLightSamples;
  const data = new Float32Array(W * H * 4);

  const tauView = [0, 0, 0];
  const tauSeg = [0, 0, 0];
  const tauLight = [0, 0, 0];
  const tView = [0, 0, 0];
  const tLight = [0, 0, 0];

  const rCam = ATMOS.Rg + 0.001;  // 1 m above the ground

  for (let j = 0; j < H; j++) {
    const ml = uToMu((j + 0.5) / H);

    for (let i = 0; i < W; i++) {
      const mu = uToMu((i + 0.5) / W);

      // View ray length: to the atmosphere top, or to the ground if it dips.
      let tmax = shellDistance(rCam, mu, ATMOS.Rt);
      if (hitsGround(rCam, mu)) {
        const g = -rCam * mu - Math.sqrt(Math.max(0, rCam * rCam * (mu * mu - 1) + ATMOS.Rg * ATMOS.Rg));
        if (g > 0) tmax = g;
      }
      if (!(tmax > 0)) tmax = 0;

      let sumR = 0, sumG = 0, sumB = 0, sumM = 0;
      tauView[0] = tauView[1] = tauView[2] = 0;

      const sinThetaV = Math.sqrt(Math.max(0, 1 - mu * mu));
      const dt = tmax / N;
      for (let s = 0; s < N; s++) {
        const t = (s + 0.5) * dt;
        const rr = Math.sqrt(rCam * rCam + t * t + 2 * rCam * t * mu);
        const h = Math.max(0, rr - ATMOS.Rg);

        const dR = Math.exp(-h / ATMOS.HR);
        const dM = Math.exp(-h / ATMOS.HM);
        const dO = ozoneDensity(h);

        // Optical depth from the camera to the MIDDLE of this segment: half of
        // this segment plus everything before it. Accumulating the full segment
        // first and then halving it is the classic off-by-half that makes the
        // horizon a stop too dark.
        tauSeg[0] = tauView[0] + 0.5 * dR * dt;
        tauSeg[1] = tauView[1] + 0.5 * dM * dt;
        tauSeg[2] = tauView[2] + 0.5 * dO * dt;
        transmittanceFrom(tauSeg, tView);

        tauView[0] += dR * dt;
        tauView[1] += dM * dt;
        tauView[2] += dO * dt;

        // Light zenith cosine AT THE SAMPLE. The body is at infinity so its
        // world-space direction is constant, but the local vertical rotates as
        // the sample climbs and travels along the ray, so the cosine against it
        // changes — by tens of degrees over an 800 km grazing path. Reusing the
        // camera's cosine is what makes a naive implementation light the wrong
        // side of the horizon at twilight.
        //
        // Working in the 2D plane that contains the camera's up and the view
        // ray: the camera sits at (0, rCam), the ray direction is
        // (sinThetaV, mu), so the sample is at (t*sinThetaV, rCam + t*mu). The
        // light is placed IN that plane (azimuth 0) — the azimuth is the third
        // parameter this table deliberately drops, and dropping it is exact for
        // the two directions that matter visually, straight toward the light and
        // straight away from it.
        const mlLocal = Math.max(-1, Math.min(1,
          (sinThetaV * t * Math.sqrt(Math.max(0, 1 - ml * ml)) + ml * (rCam + t * mu)) / Math.max(1e-6, rr)
        ));

        opticalDepthToSpace(rr, mlLocal, M, tauLight);
        transmittanceFrom(tauLight, tLight);

        const wR = dR * dt;
        const wM = dM * dt;
        sumR += tView[0] * tLight[0] * wR;
        sumG += tView[1] * tLight[1] * wR;
        sumB += tView[2] * tLight[2] * wR;
        // Mie is spectrally flat; average the transmittance so the halo picks up
        // the reddening of a low moon without needing three channels of storage.
        sumM += ((tView[0] * tLight[0] + tView[1] * tLight[1] + tView[2] * tLight[2]) / 3) * wM;
      }

      const o = (j * W + i) * 4;
      data[o + 0] = sumR * ATMOS.betaR[0];
      data[o + 1] = sumG * ATMOS.betaR[1];
      data[o + 2] = sumB * ATMOS.betaR[2];
      data[o + 3] = sumM * ATMOS.betaM;
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.name = 'mn.sky.scatterLut';
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;

  // ---- transmittance to space, view zenith only ----------------------------
  const TW = ATMOS.transW;
  const tdata = new Float32Array(TW * 4);
  for (let i = 0; i < TW; i++) {
    const mu = uToMu((i + 0.5) / TW);
    opticalDepthToSpace(rCam, mu, 16, tauLight);
    transmittanceFrom(tauLight, tLight);
    tdata[i * 4 + 0] = tLight[0];
    tdata[i * 4 + 1] = tLight[1];
    tdata[i * 4 + 2] = tLight[2];
    tdata[i * 4 + 3] = 1;
  }
  const ttex = new THREE.DataTexture(tdata, TW, 1, THREE.RGBAFormat, THREE.FloatType);
  ttex.name = 'mn.sky.transmittanceLut';
  ttex.wrapS = ttex.wrapT = THREE.ClampToEdgeWrapping;
  ttex.minFilter = ttex.magFilter = THREE.LinearFilter;
  ttex.generateMipmaps = false;
  ttex.colorSpace = THREE.NoColorSpace;
  ttex.needsUpdate = true;

  const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return { texture: tex, data, width: W, height: H, transmittance: ttex, transData: tdata, transWidth: TW, bakeMs: ms };
}

/** Rayleigh phase. Normalised so that integrating over the sphere gives 1. */
export function phaseRayleigh(c) {
  return (3 / (16 * Math.PI)) * (1 + c * c);
}

/** Cornette-Shanks Mie phase — the physically-corrected Henyey-Greenstein.
 *  Matters here because the moon halo is a large, smooth, low-contrast feature
 *  and plain HG puts a visible kink in it at ~40 degrees. */
export function phaseMie(c, g) {
  const g2 = g * g;
  const num = 3 * (1 - g2) * (1 + c * c);
  const den = 8 * Math.PI * (2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5);
  return num / den;
}

/** Henyey-Greenstein, for the fog. */
export function phaseHG(c, g) {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(1 + g2 - 2 * g * c, 1.5));
}

/**
 * CPU evaluation of the same model the dome shader runs, used to generate the
 * IBL equirect. Deliberately does NOT include clouds or stars: they contribute
 * a fraction of a percent of the hemispheric irradiance and PMREM would blur
 * them away regardless, so paying for them would be paying for nothing.
 *
 * @param {object} lut       result of buildAtmosphereLuts()
 * @param {number[]} dir     unit view direction [x,y,z], Y up
 * @param {number[]} lightDir unit direction TOWARD the light
 * @param {object} p         { skyIrradiance, rayleighTint, mieTint, nightFloor,
 *                             nightHorizon, lightColor }
 * @param {number[]} out     RGB destination
 */
export function evalSkyCpu(lut, dir, lightDir, p, out) {
  const mu = Math.max(-1, Math.min(1, dir[1]));
  const ml = Math.max(-1, Math.min(1, lightDir[1]));
  const cosTheta = Math.max(-1, Math.min(1, dir[0] * lightDir[0] + dir[1] * lightDir[1] + dir[2] * lightDir[2]));

  // Bilinear fetch from the LUT, matching the shader's LinearFilter exactly.
  const W = lut.width, H = lut.height;
  const fx = muToU(mu) * W - 0.5;
  const fy = muToU(ml) * H - 0.5;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));

  const fetch = (x, y, c) => lut.data[(y * W + x) * 4 + c];
  const bi = (c) => {
    const a = fetch(x0, y0, c) * (1 - tx) + fetch(x1, y0, c) * tx;
    const b = fetch(x0, y1, c) * (1 - tx) + fetch(x1, y1, c) * tx;
    return a * (1 - ty) + b * ty;
  };

  const pr = phaseRayleigh(cosTheta);
  const pm = phaseMie(cosTheta, ATMOS.gMie);
  const E = p.skyIrradiance;
  const lc = p.lightColor;

  for (let c = 0; c < 3; c++) {
    const ray = bi(c) * pr * p.rayleighTint[c];
    const mie = bi(3) * pm * p.mieTint[c];
    out[c] = E * lc[c] * (ray + mie);
  }

  // Airglow / unresolved starlight floor, brightened toward the horizon the way
  // a real emitting shell is (van Rhijn): the line of sight through the layer is
  // longer at grazing angles.
  const horizon = 1 + (p.nightHorizon - 1) * Math.pow(1 - Math.min(1, Math.abs(mu)), 3.0);
  const below = mu < 0 ? Math.max(0, 1 + mu * 6) : 1;  // fade out under the horizon
  for (let c = 0; c < 3; c++) out[c] += p.nightFloor[c] * horizon * below;

  return out;
}

/**
 * The GLSL half of the model. Emitted from the same constants as the CPU half,
 * so the sky you see and the sky that lights the scene are the same sky.
 *
 * Requires in scope: `uniform sampler2D uScatterLut; uniform sampler2D uTransLut;`
 */
export const SKY_LUT_GLSL = /* glsl */ `
const float MN_G_MIE = ${ATMOS.gMie.toFixed(4)};

float mnMuToU( float mu ) {
  return 0.5 + 0.5 * sign( mu ) * sqrt( abs( mu ) );
}

float mnPhaseRayleigh( float c ) {
  return 0.05968310365 * ( 1.0 + c * c );          // 3/(16 pi)
}

/* Cornette-Shanks. The +c*c numerator is what removes the kink plain
   Henyey-Greenstein leaves in a wide, low-contrast halo. */
float mnPhaseMie( float c, float g ) {
  float g2 = g * g;
  float num = 3.0 * ( 1.0 - g2 ) * ( 1.0 + c * c );
  float den = 8.0 * 3.14159265 * ( 2.0 + g2 ) * pow( max( 1e-4, 1.0 + g2 - 2.0 * g * c ), 1.5 );
  return num / den;
}

/* Henyey-Greenstein, used by the fog march where the asymmetry is a tuning
   parameter rather than a measurement. */
float mnPhaseHG( float c, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / ( 12.5663706 * pow( max( 1e-4, 1.0 + g2 - 2.0 * g * c ), 1.5 ) );
}

/** Raw LUT fetch: rgb = Rayleigh in-scatter, a = Mie in-scatter, both without
 *  the phase function. */
vec4 mnScatterLut( float muView, float muLight ) {
  return texture2D( uScatterLut, vec2( mnMuToU( muView ), mnMuToU( muLight ) ) );
}

/** Transmittance from the ground to space along a view zenith cosine. */
vec3 mnTransmittance( float muView ) {
  return texture2D( uTransLut, vec2( mnMuToU( muView ), 0.5 ) ).rgb;
}

/**
 * Sky radiance for a view direction. The mood uniforms are:
 *   uSkyIrradiance          scalar energy of the light
 *   uRayleighTint / uMieTint  per-channel mood multipliers
 *   uNightFloor.rgb + uNightHorizon  the airglow floor
 */
vec3 mnSkyRadiance( vec3 dir, vec3 lightDir, vec3 lightColor ) {
  float mu = clamp( dir.y, -1.0, 1.0 );
  float ml = clamp( lightDir.y, -1.0, 1.0 );
  float cosTheta = clamp( dot( dir, lightDir ), -1.0, 1.0 );

  vec4 lut = mnScatterLut( mu, ml );
  vec3 ray = lut.rgb * mnPhaseRayleigh( cosTheta ) * uRayleighTint;
  vec3 mie = vec3( lut.a ) * mnPhaseMie( cosTheta, MN_G_MIE ) * uMieTint;

  vec3 col = uSkyIrradiance * lightColor * ( ray + mie );

  float horizon = 1.0 + ( uNightHorizon - 1.0 ) * pow( 1.0 - min( 1.0, abs( mu ) ), 3.0 );
  float below = mu < 0.0 ? max( 0.0, 1.0 + mu * 6.0 ) : 1.0;
  col += uNightFloor * horizon * below;

  return col;
}
`;

/** Uniform declarations that `SKY_LUT_GLSL` depends on. Kept separate so a pass
 *  that only wants the phase functions does not have to declare the samplers. */
export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform sampler2D uScatterLut;
uniform sampler2D uTransLut;
uniform float uSkyIrradiance;
uniform vec3 uRayleighTint;
uniform vec3 uMieTint;
uniform vec3 uNightFloor;
uniform float uNightHorizon;
`;
