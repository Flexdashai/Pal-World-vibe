import * as THREE from 'three';
import { IBL } from './tuning.js';
import { evalSkyCpu } from './atmosphere.js';
import { STARLIGHT_IRRADIANCE } from './stars.js';

/**
 * Image-based lighting.
 *
 * WHAT GOES IN THE MAP, and just as importantly what does not:
 *
 *   IN   the scattered sky, evaluated on the CPU from the same LUT the dome
 *        shader samples, so the ambient light in the room is the light of the
 *        sky you can see through the gate
 *   IN   a ground-bounce hemisphere, tinted by the flagstone albedo and driven
 *        by the total irradiance actually arriving at the floor. Without it the
 *        underside of every arch is the same colour as the sky, which is the
 *        instant giveaway of a hemisphere-light-only rig
 *   IN   a soft blob per dominant local light, at `IBL.localBounce` strength.
 *        This is the BOUNCE off the walls around a brazier, not the brazier
 *        itself — it is what puts a warm reflection in wet stone and what makes
 *        the shadowed side of a pillar near a fire read as warm-dark rather than
 *        blue-dark
 *   OUT  the moon disc. The moon is already a directional light; putting its
 *        disc in the environment as well would count its direct illumination
 *        twice. The Mie aureole around it IS in the map, because that is
 *        scattered light and the directional light does not carry it
 *
 * WHY THE CPU. The alternative is rendering the dome shader into a cube camera,
 * which on this container costs six full passes of the most expensive shader in
 * the subsystem. Evaluating 128x64 = 8192 directions in JavaScript costs about a
 * millisecond and gives exactly the same answer, because the model is the same
 * model. PMREM is the expensive part either way and there is no avoiding it.
 *
 * REGENERATION IS LAZY. PMREM on a software rasteriser is ~150 ms; running it
 * per frame would dominate the frame. It runs on: init, a time-of-day change, a
 * world change, and an explicit request — rate-limited to one per
 * `IBL.minInterval` seconds. It deliberately does NOT run when a brazier
 * flickers: that is a 20 Hz intensity change and the indirect term does not need
 * to follow it.
 */
export class IblGenerator {
  constructor(renderer, lut) {
    this.renderer = renderer;
    this.lut = lut;

    this.width = IBL.width;
    this.height = IBL.height;
    this.data = new Float32Array(this.width * this.height * 4);

    this.equirect = new THREE.DataTexture(
      this.data, this.width, this.height, THREE.RGBAFormat, THREE.FloatType
    );
    this.equirect.name = 'mn.sky.equirect';
    this.equirect.mapping = THREE.EquirectangularReflectionMapping;
    this.equirect.minFilter = THREE.LinearFilter;
    this.equirect.magFilter = THREE.LinearFilter;
    this.equirect.wrapS = THREE.RepeatWrapping;
    this.equirect.wrapT = THREE.ClampToEdgeWrapping;
    this.equirect.colorSpace = THREE.NoColorSpace;
    this.equirect.generateMipmaps = false;
    this.equirect.needsUpdate = true;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.target = null;
    this.texture = null;

    this.generations = 0;
    this.lastMs = 0;
    this.lastAt = -1e9;

    // Preallocated scratch — this runs while the game is live.
    this._dir = [0, 0, 0];
    this._light = [0, 0, 0];
    this._rgb = [0, 0, 0];
    this._skyIrradiance = new THREE.Vector3();
    this._lightDirs = [];
    this._lightRgb = [];
    for (let i = 0; i < 4; i++) {
      this._lightDirs.push(new THREE.Vector3());
      this._lightRgb.push(new THREE.Vector3());
    }
  }

  /** Compile PMREM's own shaders ahead of the first frame. Called from
   *  `prewarmMaterials`; without it the first `generate()` costs an extra
   *  ~300 ms of shader compilation on top of the render. */
  compile() {
    this.pmrem.compileEquirectangularShader();
  }

  /**
   * Rebuild the equirect and re-run PMREM.
   *
   * @param {object} p       the active preset parameters plus `moonDir`,
   *                         `moonColor`, `lightColor`
   * @param {Array}  lights  up to four `{ dir: Vector3, rgb: Vector3 }` local
   *                         bounce sources, already sorted by contribution
   */
  generate(p, lights) {
    const t0 = performance.now();
    const W = this.width, H = this.height, data = this.data;
    const dir = this._dir, rgb = this._rgb;
    const light = this._light;
    light[0] = p.moonDir.x; light[1] = p.moonDir.y; light[2] = p.moonDir.z;

    // --- pass 1: the sky, upper hemisphere, accumulating its irradiance ------
    // The irradiance is needed for the ground bounce, and computing it here from
    // the same samples costs nothing: E = sum L * cos(theta) * dOmega.
    let eR = 0, eG = 0, eB = 0;
    const dPhi = (Math.PI * 2) / W;

    for (let j = 0; j < H; j++) {
      // Equirect convention matching three's `equirectUv`: v = asin(y)/PI + 0.5,
      // and DataTexture has flipY = false, so row 0 is v = 0, i.e. the nadir.
      const v = (j + 0.5) / H;
      const lat = (v - 0.5) * Math.PI;
      const y = Math.sin(lat);
      const cosLat = Math.cos(lat);
      // Solid angle of one texel in this row.
      const dOmega = dPhi * (Math.PI / H) * cosLat;

      for (let i = 0; i < W; i++) {
        const u = (i + 0.5) / W;
        const phi = (u - 0.5) * Math.PI * 2;
        dir[0] = Math.cos(phi) * cosLat;
        dir[1] = y;
        dir[2] = Math.sin(phi) * cosLat;

        evalSkyCpu(this.lut, dir, light, p, rgb);

        // Unresolved starlight: not zero, and it is the only thing keeping a
        // sealed room from being mathematically black.
        rgb[0] += STARLIGHT_IRRADIANCE * p.starBrightness;
        rgb[1] += STARLIGHT_IRRADIANCE * p.starBrightness * 1.02;
        rgb[2] += STARLIGHT_IRRADIANCE * p.starBrightness * 1.12;

        const o = (j * W + i) * 4;
        data[o + 0] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 1;

        if (y > 0) {
          const w = y * dOmega;
          eR += rgb[0] * w; eG += rgb[1] * w; eB += rgb[2] * w;
        }
      }
    }

    // --- pass 2: local bounce blobs ------------------------------------------
    // Each light writes a cone of constant radiance whose integral equals the
    // bounce fraction of the irradiance it delivers to the focus point.
    const nL = Math.min(lights.length, 4);
    const cosR = Math.cos(IBL.localBlobRadius);
    const omegaBlob = 2 * Math.PI * (1 - cosR);
    let bR = 0, bG = 0, bB = 0;

    for (let k = 0; k < nL; k++) {
      const ld = lights[k].dir;
      const lc = lights[k].rgb;
      // Radiance such that integral(L dOmega) == irradiance * bounce fraction.
      const sR = (lc.x * IBL.localBounce) / omegaBlob;
      const sG = (lc.y * IBL.localBounce) / omegaBlob;
      const sB = (lc.z * IBL.localBounce) / omegaBlob;
      bR += lc.x; bG += lc.y; bB += lc.z;

      for (let j = 0; j < H; j++) {
        const v = (j + 0.5) / H;
        const lat = (v - 0.5) * Math.PI;
        const y = Math.sin(lat);
        const cosLat = Math.cos(lat);
        for (let i = 0; i < W; i++) {
          const u = (i + 0.5) / W;
          const phi = (u - 0.5) * Math.PI * 2;
          const dx = Math.cos(phi) * cosLat;
          const dz = Math.sin(phi) * cosLat;
          const c = dx * ld.x + y * ld.y + dz * ld.z;
          if (c <= cosR) continue;
          // Smooth edge, or the blob is a hard-edged disc in every reflection.
          const w = (c - cosR) / (1 - cosR);
          const f = w * w * (3 - 2 * w);
          const o = (j * W + i) * 4;
          data[o + 0] += sR * f;
          data[o + 1] += sG * f;
          data[o + 2] += sB * f;
        }
      }
    }

    // --- pass 3: ground bounce ------------------------------------------------
    // Everything arriving at the floor — sky plus the local lights — comes back
    // up multiplied by the flagstone albedo and divided by pi (Lambertian).
    const ga = IBL.groundAlbedo;
    const gw = IBL.localGroundWeight;
    const gR = ((eR + bR * gw) * ga[0]) / Math.PI;
    const gG = ((eG + bG * gw) * ga[1]) / Math.PI;
    const gB = ((eB + bB * gw) * ga[2]) / Math.PI;

    for (let j = 0; j < H; j++) {
      const v = (j + 0.5) / H;
      const lat = (v - 0.5) * Math.PI;
      const y = Math.sin(lat);
      if (y >= 0.02) continue;
      // Ramp in over the last few degrees above the horizon so there is no seam
      // exactly at y = 0, which is where the eye is most likely to be looking.
      const w = Math.min(1, (0.02 - y) / 0.25);
      for (let i = 0; i < W; i++) {
        const o = (j * W + i) * 4;
        data[o + 0] = data[o + 0] * (1 - w) + gR * w;
        data[o + 1] = data[o + 1] * (1 - w) + gG * w;
        data[o + 2] = data[o + 2] * (1 - w) + gB * w;
      }
    }

    this._skyIrradiance.set(eR, eG, eB);
    this.equirect.needsUpdate = true;

    // --- PMREM ----------------------------------------------------------------
    // The generator changes the bound render target and the clear colour, so the
    // caller's state is saved and restored around it. Everything in this project
    // assumes `render` owns renderer state; this is the one place `sky` touches
    // it, and it does so between frames.
    const prevTarget = this.renderer.getRenderTarget();
    this.target = this.pmrem.fromEquirectangular(this.equirect, this.target);
    this.renderer.setRenderTarget(prevTarget);
    this.texture = this.target.texture;

    this.generations++;
    this.lastMs = performance.now() - t0;
    return this.texture;
  }

  /** Hemispheric sky irradiance from the last generation — the fog's ambient
   *  in-scatter colour is derived from this so fog and ambient agree. */
  get skyIrradiance() { return this._skyIrradiance; }

  dispose() {
    this.pmrem.dispose();
    this.target?.dispose();
    this.equirect.dispose();
    this.target = null;
    this.texture = null;
  }
}
