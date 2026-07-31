import * as THREE from 'three';

/**
 * CPU noise generation for `sky`.
 *
 * Everything here runs exactly once, in `init()`, from a `ctx.rng.fork()` — no
 * `Math.random`, no per-frame work, and no external image. Three products:
 *
 *   `buildCloudNoise2D`  a 256px RGBA texture whose four channels are four
 *                        octaves of the SAME tiling field, so the cloud shader
 *                        gets a 4-octave fbm out of one texture fetch instead
 *                        of four. On a software rasteriser that is the whole
 *                        difference between clouds and no clouds.
 *   `buildFogNoise3D`    a 32^3 RGBA volume: two octaves of tiling value noise,
 *                        a decorrelated field used to warp the lookup, and a
 *                        sharper ridged field for wisps.
 *   `buildBlueNoise`     a 32x32 void-and-cluster blue-noise mask for the
 *                        ray-march start offset.
 *
 * TILING IS NOT OPTIONAL. The fog volume is sampled over hundreds of metres and
 * the cloud field wraps the whole sky; a non-periodic hash produces a seam you
 * cannot unsee. Every lattice index below is taken modulo the grid size, which
 * is what makes the result periodic by construction rather than by luck.
 */

/** Deterministic 3D integer hash -> [0,1). Periodic because the caller wraps the
 *  coordinates before calling; the mixing here only has to be well distributed. */
function makeHash(seed) {
  const s = seed >>> 0;
  return (x, y, z) => {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  };
}

/** Quintic smoothstep — C2 continuous, so the gradient of the noise is smooth
 *  and the fog does not show faceting where the lattice cells meet. */
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Periodic 3D value noise on an integer lattice of size `period`. */
function valueNoise3(hash, x, y, z, period) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);

  const wrap = (n) => ((n % period) + period) % period;
  const x0 = wrap(xi), x1 = wrap(xi + 1);
  const y0 = wrap(yi), y1 = wrap(yi + 1);
  const z0 = wrap(zi), z1 = wrap(zi + 1);

  const c000 = hash(x0, y0, z0), c100 = hash(x1, y0, z0);
  const c010 = hash(x0, y1, z0), c110 = hash(x1, y1, z0);
  const c001 = hash(x0, y0, z1), c101 = hash(x1, y0, z1);
  const c011 = hash(x0, y1, z1), c111 = hash(x1, y1, z1);

  const a = c000 + (c100 - c000) * u;
  const b = c010 + (c110 - c010) * u;
  const c = c001 + (c101 - c001) * u;
  const d = c011 + (c111 - c011) * u;
  const e = a + (b - a) * v;
  const f = c + (d - c) * v;
  return e + (f - e) * w;
}

/** Periodic 2D value noise. Implemented as the 3D one at z = 0.5 so both share
 *  the same hash and therefore the same visual character. */
function valueNoise2(hash, x, y, period) {
  return valueNoise3(hash, x, y, 0.5, period);
}

/**
 * Fractal sum of `octaves` periodic 2D octaves. The base period doubles with
 * each octave so every octave is periodic over the SAME domain — which is what
 * keeps the sum periodic. Getting this wrong is the classic "my tiling noise
 * does not tile" bug.
 */
function fbm2(hash, x, y, basePeriod, octaves, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(hash, x * freq, y * freq, Math.round(basePeriod * freq));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function fbm3(hash, x, y, z, basePeriod, octaves, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(hash, x * freq, y * freq, z * freq, Math.round(basePeriod * freq));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * The cloud/detail texture: 256x256 RGBA, tiling, four different frequency
 * bands packed into the four channels.
 *
 *   r  4-octave fbm, base period 4    — the cloud SHAPE
 *   g  4-octave fbm, base period 12   — the detail that breaks up the edges
 *   b  ridged noise, base period 8    — filament structure for cirrus and for
 *                                       the moon's maria
 *   a  a decorrelated low-frequency field, base period 3, used to warp the
 *      lookup of the other three so the fbm stops looking like an fbm
 *
 * One fetch gives the shader a full cloud evaluation. That matters: the dome
 * shader runs on every sky pixel and each dependent fetch on SwiftShader costs
 * more than a dozen ALU ops.
 */
export function buildCloudNoise2D(rng, size = 256) {
  const hashA = makeHash(rng.u32());
  const hashB = makeHash(rng.u32());
  const hashC = makeHash(rng.u32());
  const hashD = makeHash(rng.u32());

  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      const i = (y * size + x) * 4;

      const shape = fbm2(hashA, u * 4, v * 4, 4, 4);
      const detail = fbm2(hashB, u * 12, v * 12, 12, 4);
      // Ridged: fold the noise around 0.5 and invert, then sharpen. Produces the
      // filament structure that reads as cirrus rather than as cotton wool.
      const rr = 1 - Math.abs(fbm2(hashC, u * 8, v * 8, 8, 3) * 2 - 1);
      const ridged = rr * rr;
      const warp = fbm2(hashD, u * 3, v * 3, 3, 2);

      data[i + 0] = Math.max(0, Math.min(255, Math.round(shape * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(detail * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(ridged * 255)));
      data[i + 3] = Math.max(0, Math.min(255, Math.round(warp * 255)));
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'mn.sky.cloudNoise';
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The fog volume: 32^3 RGBA, tiling in all three axes.
 *
 *   r  3-octave fbm            — the main density modulation, the "banks"
 *   g  higher-frequency fbm    — the detail that appears when a shaft lights it
 *   b  decorrelated field      — used to advect the lookup so the fog churns
 *                                instead of sliding rigidly
 *   a  ridged                  — wisps, used at low weight
 *
 * 32^3 is 32768 texels = 128 KB. It looks small, and it is: the shader samples
 * it at ~20 m per cycle, so one cycle is much larger than a room and the
 * repetition is never visible from inside. A 64^3 volume is 8x the memory and
 * 8x the bake time for a difference that does not survive the quarter-res march.
 */
export function buildFogNoise3D(rng, size = 32) {
  const hashA = makeHash(rng.u32());
  const hashB = makeHash(rng.u32());
  const hashC = makeHash(rng.u32());
  const hashD = makeHash(rng.u32());

  const data = new Uint8Array(size * size * size * 4);
  const inv = 1 / size;

  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x * inv, v = y * inv, w = z * inv;
        const i = ((z * size + y) * size + x) * 4;

        const base = fbm3(hashA, u * 4, v * 4, w * 4, 4, 3);
        const detail = fbm3(hashB, u * 8, v * 8, w * 8, 8, 3);
        const warp = fbm3(hashC, u * 2, v * 2, w * 2, 2, 2);
        const rr = 1 - Math.abs(fbm3(hashD, u * 6, v * 6, w * 6, 6, 2) * 2 - 1);

        data[i + 0] = Math.round(Math.max(0, Math.min(1, base)) * 255);
        data[i + 1] = Math.round(Math.max(0, Math.min(1, detail)) * 255);
        data[i + 2] = Math.round(Math.max(0, Math.min(1, warp)) * 255);
        data[i + 3] = Math.round(Math.max(0, Math.min(1, rr * rr)) * 255);
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.name = 'mn.sky.fogNoise';
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Void-and-cluster blue noise, 32x32, R8.
 *
 * Why blue noise and not the interleaved-gradient noise the renderer uses
 * elsewhere: IGN is optimised for a 3x3 neighbourhood, which is right for a
 * denoiser that filters over 3x3. The volumetric march has no spatial denoiser —
 * it has a bilateral UPSAMPLE, which is a 2x2 tent, and a temporal filter. Over
 * a 2x2 window IGN is barely better than white noise, whereas a void-and-cluster
 * mask is optimal by construction: every 2x2 neighbourhood contains four values
 * that are as far apart in the sequence as the mask can make them, so four
 * adjacent rays start at four well-spread offsets and the bilateral tent
 * integrates them into a clean average.
 *
 * The algorithm is Ulichney's, wrapped toroidally so the mask tiles:
 *   1. scatter a random binary pattern, then relax it by repeatedly moving the
 *      pixel in the tightest cluster into the largest void;
 *   2. rank the relaxed pattern's ones downward, then fill the zeros upward.
 * 32x32 is 1024 pixels, so the O(n^2) energy scans are ~1M operations — a couple
 * of milliseconds, once.
 */
export function buildBlueNoise(rng, size = 32) {
  const n = size * size;
  const binary = new Uint8Array(n);
  const energy = new Float32Array(n);
  const rank = new Int32Array(n).fill(-1);

  // Gaussian energy kernel. sigma = 1.5 is Ulichney's recommendation; the kernel
  // is truncated at 3 sigma and wrapped, which is what makes the result tile.
  const sigma = 1.5;
  const R = 5;
  const kernel = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      kernel.push([dx, dy, Math.exp(-d2 / (2 * sigma * sigma))]);
    }
  }

  const splat = (idx, sign) => {
    const px = idx % size, py = (idx / size) | 0;
    for (let k = 0; k < kernel.length; k++) {
      const [dx, dy, w] = kernel[k];
      const x = (px + dx + size) % size;
      const y = (py + dy + size) % size;
      energy[y * size + x] += sign * w;
    }
  };

  // Seed with 1/10 of the pixels set, which is the density void-and-cluster
  // relaxes fastest from.
  const seeds = Math.max(1, Math.round(n * 0.1));
  let placed = 0;
  while (placed < seeds) {
    const idx = rng.u32() % n;
    if (binary[idx]) continue;
    binary[idx] = 1;
    splat(idx, 1);
    placed++;
  }

  const tightestCluster = () => {
    let best = -1, bestE = -Infinity;
    for (let i = 0; i < n; i++) if (binary[i] && energy[i] > bestE) { bestE = energy[i]; best = i; }
    return best;
  };
  const largestVoid = () => {
    let best = -1, bestE = Infinity;
    for (let i = 0; i < n; i++) if (!binary[i] && energy[i] < bestE) { bestE = energy[i]; best = i; }
    return best;
  };

  // Phase 1: relax. Terminates when removing the tightest cluster would create
  // the largest void in the same place, i.e. the pattern is stationary.
  for (let iter = 0; iter < n * 4; iter++) {
    const c = tightestCluster();
    binary[c] = 0; splat(c, -1);
    const v = largestVoid();
    if (v === c) { binary[c] = 1; splat(c, 1); break; }
    binary[v] = 1; splat(v, 1);
  }

  const proto = binary.slice();

  // Phase 2a: rank the ones downward — repeatedly remove the tightest cluster.
  let count = 0;
  for (let i = 0; i < n; i++) if (proto[i]) count++;
  let remaining = count;
  binary.set(proto);
  energy.fill(0);
  for (let i = 0; i < n; i++) if (binary[i]) splat(i, 1);
  while (remaining > 0) {
    const c = tightestCluster();
    binary[c] = 0; splat(c, -1);
    remaining--;
    rank[c] = remaining;
  }

  // Phase 2b: fill the zeros upward — repeatedly fill the largest void.
  binary.set(proto);
  energy.fill(0);
  for (let i = 0; i < n; i++) if (binary[i]) splat(i, 1);
  let r = count;
  while (r < n) {
    const v = largestVoid();
    binary[v] = 1; splat(v, 1);
    rank[v] = r;
    r++;
  }

  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.min(255, Math.round((rank[i] + 0.5) * (255 / n)));

  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = 'mn.sky.blueNoise';
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
