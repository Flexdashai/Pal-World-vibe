import * as THREE from 'three';

/**
 * MONARCH — the procedural sprite atlas.
 *
 * Every particle, decal and glyph in the game samples one 512x512 RGBA texture
 * that is computed here, at load, from a seeded PRNG. There are no image files
 * anywhere in this project and there never will be.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PIXELS ARE COMPUTED RATHER THAN DRAWN WITH CANVAS 2D
 *
 * Canvas 2D would be shorter for the glyphs. It is the wrong tool for everything
 * else, for three concrete reasons:
 *
 *  1. **Soft falloffs.** A particle's alpha ramp is the whole effect. A radial
 *     canvas gradient gives 8-bit banding in exactly the region — the long dim
 *     tail of a smoke puff — where banding is most visible against a black
 *     dungeon. Computing the ramp in float and quantising once at the end does
 *     not band.
 *  2. **Structure inside the sprite.** A smoke puff needs turbulent internal
 *     value variation or it reads as an airbrushed disc; a blood splat needs
 *     lobes and satellite droplets. Both are noise fields, not draw calls.
 *  3. **Determinism.** Canvas rasterisation differs between platforms (and
 *     between headless and headed Chromium). Array maths does not, and the
 *     capture harness compares frames.
 *
 * ---------------------------------------------------------------------------
 * CHANNEL CONVENTION — every consumer depends on it
 *
 *   A    coverage. This is the sprite's shape and the only thing that decides
 *        where it exists.
 *   RGB  a white-ish VALUE field in 0..1, never a colour. Every call site
 *        multiplies by a palette colour, so a sprite can be violet shadow
 *        energy on one draw and orange fire on the next. Internal structure
 *        (the turbulence in smoke, the lobes in a splat, the hot core of an
 *        ember) lives here.
 *
 * Tiles fade to zero coverage inside a 6% border so mip generation cannot bleed
 * one sprite into its neighbour — the classic atlas artefact, which at this
 * camera distance shows up as a faint square halo around every particle.
 */

/** Pixels per tile. 128 gives a 0.5 m particle ~4 texels/cm at the closest shot
 *  the game ever frames (the `detail` shot at a 9.5 m boom) and costs 1 MB. */
export const TILE = 128;
/** 4x4 = 16 sprites. */
export const GRID = 4;
export const ATLAS_SIZE = TILE * GRID;

/**
 * Sprite indices. The order is the atlas layout and is baked into every recipe,
 * so entries are appended, never reordered.
 */
export const SPRITE = {
  smoke: 0,       // billowy puff — the workhorse for dust, smoke, dissipation
  wisp: 1,        // a torn curl of smoke, for edges and trails
  ember: 2,       // hot core, wide dim halo — rising fire/shadow motes
  spark: 3,       // a streak with a bright head, drawn velocity-aligned
  dust: 4,        // grainy low-contrast cloud
  drop: 5,        // a teardrop, for blood and water in flight
  splat: 6,       // irregular blob with satellites — the blood decal
  rune: 7,        // an angular sigil, the Solo Leveling glyph
  ring: 8,        // a thin annulus — shockwaves and ground rings
  energy: 9,      // an elongated fluted wisp with a hot core
  chip: 10,       // hard-edged angular shard — stone and wood debris
  flare: 11,      // 4-point star flare, the impact-frame core
  crack: 12,      // radial fracture lines, a decal
  scorch: 13,     // soft irregular burn, a decal
  glyphRing: 14,  // a band of runes around an annulus — aura and extraction
  frost: 15,      // 6-fold crystalline star
};

/** Sprites that read best drawn flat on the ground as a decal. Kept here so the
 *  decal system does not have to hardcode indices. */
export const DECAL_SPRITE = {
  blood: SPRITE.splat,
  scorch: SPRITE.scorch,
  crack: SPRITE.crack,
  frost: SPRITE.frost,
  rune: SPRITE.glyphRing,
  ring: SPRITE.ring,
};

/* ==========================================================================
 * Deterministic noise
 * ========================================================================== */

/**
 * Value noise from a seeded 256-entry permutation. Not Perlin: the sprites want
 * lumpy blobs, and value noise's characteristic "cellular clumping" is closer to
 * what smoke and splatter actually look like than gradient noise's smooth swells.
 */
class Noise {
  constructor(rng) {
    this.p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    // Fisher-Yates from the seeded stream — no Math.random anywhere.
    for (let i = 255; i > 0; i--) {
      const j = rng.u32() % (i + 1);
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
    this.v = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.v[i] = rng.float();
  }

  at(ix, iy) {
    return this.v[this.p[(this.p[ix & 255] + iy) & 255]];
  }

  /** Smooth-interpolated value noise at (x, y) in noise units. */
  n2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    // Quintic fade: C2 continuous, so a 5-octave sum has no visible grid.
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = this.at(ix, iy), b = this.at(ix + 1, iy);
    const c = this.at(ix, iy + 1), d = this.at(ix + 1, iy + 1);
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
  }

  /** Fractal sum. `gain` below 0.5 keeps the large lobes dominant, which is what
   *  makes smoke read as billows rather than as static. */
  fbm(x, y, oct = 4, lac = 2.03, gain = 0.52) {
    let s = 0, a = 1, n = 0, fx = x, fy = y;
    for (let i = 0; i < oct; i++) {
      s += this.n2(fx, fy) * a;
      n += a;
      a *= gain;
      fx *= lac; fy *= lac;
    }
    return s / n;
  }

  /** Ridged variant — thin bright filaments, used for the energy wisp and the
   *  internal veining of a blood splat. */
  ridge(x, y, oct = 3) {
    let s = 0, a = 1, n = 0, fx = x, fy = y;
    for (let i = 0; i < oct; i++) {
      s += (1 - Math.abs(this.n2(fx, fy) * 2 - 1)) * a;
      n += a;
      a *= 0.5;
      fx *= 2.11; fy *= 2.11;
    }
    return s / n;
  }
}

/* ==========================================================================
 * Small maths helpers, local so nothing here depends on another subsystem
 * ========================================================================== */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** Distance from p to the segment ab. The primitive every glyph is drawn with —
 *  analytically antialiased, unlike a canvas stroke. */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 1e-9 ? (wx * vx + wy * vy) / len2 : 0;
  t = clamp01(t);
  const dx = wx - vx * t, dy = wy - vy * t;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ==========================================================================
 * The atlas
 * ========================================================================== */

/**
 * Build the atlas.
 * @param {import('../core/rng.js').Rng} rng a forked, seeded stream
 * @returns {{ texture: THREE.DataTexture, ms: number }}
 */
export function buildAtlas(rng) {
  const t0 = performance.now();
  const N = ATLAS_SIZE;
  const data = new Uint8Array(N * N * 4);
  const noise = new Noise(rng);

  // Per-sprite seeded parameters, drawn up front so a change to one generator
  // cannot shift the stream for the ones after it.
  const seeds = [];
  for (let i = 0; i < 16; i++) seeds.push({ ox: rng.range(0, 512), oy: rng.range(0, 512), k: rng.float() });

  /**
   * Fill one tile from a callback returning `[value, alpha]` for a point in
   * NORMALISED SPRITE SPACE: x,y in [-1,1], centre at the origin.
   *
   * The border taper is applied here, once, for every sprite — it is not the
   * generators' business and forgetting it in one of them is exactly the kind of
   * bug that shows up two agents later as "why is there a square around the
   * smoke".
   */
  const fill = (index, fn) => {
    const tx = (index % GRID) * TILE;
    const ty = Math.floor(index / GRID) * TILE;
    for (let y = 0; y < TILE; y++) {
      const ny = (y + 0.5) / TILE * 2 - 1;
      for (let x = 0; x < TILE; x++) {
        const nx = (x + 0.5) / TILE * 2 - 1;
        const out = fn(nx, ny);
        // Taper the outer 6% to zero coverage in the CHEBYSHEV metric, so square
        // tiles get a square taper and nothing survives to the mip boundary.
        const edge = Math.max(Math.abs(nx), Math.abs(ny));
        const taper = 1 - smooth(0.88, 1.0, edge);
        const a = clamp01(out[1]) * taper;
        const v = clamp01(out[0]);
        const p = ((ty + y) * N + (tx + x)) * 4;
        // Value is stored non-premultiplied; the shaders multiply by tint * alpha.
        const b = Math.round(v * 255);
        data[p] = b; data[p + 1] = b; data[p + 2] = b; data[p + 3] = Math.round(a * 255);
      }
    }
  };

  const out = [0, 0];   // reused return tuple; `fill` copies out of it immediately

  /* ---------------------------------------------------------------- smoke -- */
  // A billow, not a disc: the radius is modulated by low-frequency turbulence so
  // the silhouette is lumpy, and the interior carries a second, finer noise so
  // that a lit puff has structure to catch the light.
  {
    const s = seeds[SPRITE.smoke];
    fill(SPRITE.smoke, (x, y) => {
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      // Turbulence sampled on a circle so the lobes wrap seamlessly around the
      // silhouette instead of showing a seam at atan2's branch cut.
      const t = noise.fbm(s.ox + Math.cos(ang) * 1.9, s.oy + Math.sin(ang) * 1.9, 4);
      const rr = r * (0.70 + 0.62 * t);
      const a = Math.pow(1 - smooth(0.10, 0.92, rr), 1.45);
      const inner = noise.fbm(s.ox + x * 2.6, s.oy + y * 2.6, 5, 2.07, 0.55);
      // Brighter at the top-left so a puff has an implied light direction even
      // before the scene lights it — the difference between "smoke" and "fog".
      const shade = 0.46 + 0.40 * inner + 0.22 * clamp01(-(x + y) * 0.7 + 0.5);
      out[0] = shade; out[1] = a * (0.55 + 0.55 * inner);
      return out;
    });
  }

  /* ----------------------------------------------------------------- wisp -- */
  // A torn curl. Built from a spiral: distance to an arc whose radius grows with
  // angle, tapered at both ends.
  {
    const s = seeds[SPRITE.wisp];
    fill(SPRITE.wisp, (x, y) => {
      const r = Math.hypot(x, y);
      let ang = Math.atan2(y, x);
      if (ang < 0) ang += Math.PI * 2;
      // Spiral radius at this angle.
      const spiralR = 0.22 + ang * 0.105;
      const d = Math.abs(r - spiralR);
      const along = clamp01(ang / (Math.PI * 1.75));
      const width = 0.20 * (0.35 + 0.75 * Math.sin(along * Math.PI));
      let a = 1 - smooth(0, width, d);
      a *= 1 - smooth(0.75, 1.0, along);
      a *= 1 - smooth(0.86, 1.0, r);
      const t = noise.fbm(s.ox + x * 3.4, s.oy + y * 3.4, 4);
      a *= 0.45 + 0.75 * t;
      out[0] = 0.55 + 0.5 * t; out[1] = a;
      return out;
    });
  }

  /* ---------------------------------------------------------------- ember -- */
  // Two gaussians: a very tight white core and a wide dim halo. The core is what
  // survives the bloom threshold-free pyramid as a point of light; the halo is
  // what gives the tint somewhere to live.
  fill(SPRITE.ember, (x, y) => {
    const r2 = x * x + y * y;
    const core = Math.exp(-r2 * 46);
    const halo = Math.exp(-r2 * 5.0);
    const a = clamp01(core + halo * 0.42);
    // Value falls from 1 in the core to 0.55 in the halo, so the tint reads as
    // saturated at the edge and white-hot at the middle — how a real ember looks.
    out[0] = 0.55 + 0.45 * clamp01(core * 1.6);
    out[1] = a;
    return out;
  });

  /* ---------------------------------------------------------------- spark -- */
  // Drawn velocity-aligned, so the sprite is authored pointing along +Y with the
  // bright head at the top. A hard narrow core plus a soft bloom either side.
  fill(SPRITE.spark, (x, y) => {
    const head = smooth(-1.0, 0.55, y);           // brighter toward the head
    const taper = 0.055 + 0.16 * (1 - head);      // widens toward the tail
    const core = Math.exp(-(x * x) / (taper * taper * 0.5));
    const glow = Math.exp(-(x * x) / 0.10) * 0.30;
    const ends = (1 - smooth(0.72, 1.0, Math.abs(y))) * (0.25 + 0.75 * head);
    const a = clamp01((core + glow) * ends);
    out[0] = 0.45 + 0.55 * clamp01(core * head * 1.4);
    out[1] = a;
    return out;
  });

  /* ----------------------------------------------------------------- dust -- */
  // Low contrast, grainy, wide. Deliberately much fainter than smoke: dust is
  // what fills the space between the impact and the smoke and it must never
  // become the loudest thing in the burst.
  {
    const s = seeds[SPRITE.dust];
    fill(SPRITE.dust, (x, y) => {
      const r = Math.hypot(x, y);
      const t = noise.fbm(s.ox + x * 2.2, s.oy + y * 2.2, 5, 2.11, 0.58);
      const grain = noise.n2(s.ox + x * 26, s.oy + y * 26);
      const a = Math.pow(1 - smooth(0.0, 0.98, r * (0.8 + 0.45 * t)), 1.9) * (0.35 + 0.85 * t);
      out[0] = 0.42 + 0.40 * t + 0.18 * grain;
      out[1] = a * (0.75 + 0.35 * grain);
      return out;
    });
  }

  /* ----------------------------------------------------------------- drop -- */
  // A teardrop pointing along +Y, drawn velocity-aligned like the spark: a disc
  // at the base with a tapering tail, and a specular highlight off-centre so it
  // reads as a wet volume rather than a flat lozenge.
  fill(SPRITE.drop, (x, y) => {
    // Radius of the drop body as a function of height.
    const h = (y + 1) * 0.5;                       // 0 at the tail, 1 at the head
    const rad = 0.40 * Math.pow(h, 0.55) * (1 - smooth(0.72, 1.0, h));
    const d = Math.abs(x) - rad;
    const a = 1 - smooth(-0.03, 0.045, d);
    const hi = Math.exp(-((x + 0.12) ** 2 + (y - 0.30) ** 2) * 34);
    out[0] = clamp01(0.42 + 0.72 * hi + 0.16 * (1 - Math.abs(x) / (rad + 1e-3)));
    out[1] = a;
    return out;
  });

  /* ---------------------------------------------------------------- splat -- */
  // The blood decal. Metaball sum of a seeded cluster of lobes, thresholded with
  // a soft edge, plus satellite droplets thrown clear of the main mass, plus
  // internal ridged veining so a 1 m splat has detail at the `detail` shot's
  // 9.5 m boom.
  {
    const s = seeds[SPRITE.splat];
    const lobes = [];
    for (let i = 0; i < 7; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, 0.34);
      lobes.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: rng.range(0.22, 0.46) });
    }
    const sats = [];
    for (let i = 0; i < 11; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0.48, 0.88);
      sats.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: rng.range(0.035, 0.10) });
    }
    fill(SPRITE.splat, (x, y) => {
      let f = 0;
      for (let i = 0; i < lobes.length; i++) {
        const L = lobes[i];
        const dx = x - L.x, dy = y - L.y;
        const q = 1 - (dx * dx + dy * dy) / (L.r * L.r);
        if (q > 0) f += q * q;
      }
      // Ragged the edge with turbulence before thresholding, or every lobe is a
      // perfect circle and the splat reads as a cartoon.
      f *= 0.72 + 0.62 * noise.fbm(s.ox + x * 3.1, s.oy + y * 3.1, 4);
      let a = smooth(0.30, 0.62, f);
      for (let i = 0; i < sats.length; i++) {
        const S = sats[i];
        const d = Math.hypot(x - S.x, y - S.y);
        a = Math.max(a, 1 - smooth(S.r * 0.6, S.r, d));
      }
      // Veining: darker where the film is thin at the rim, near-black in the
      // pooled centre. Blood is not one colour.
      const vein = noise.ridge(s.ox + x * 4.4, s.oy + y * 4.4, 3);
      const thick = smooth(0.35, 0.9, f);
      out[0] = clamp01(0.30 + 0.55 * (1 - thick) + 0.30 * vein * (1 - thick));
      out[1] = a;
      return out;
    });
  }

  /* ----------------------------------------------------------------- rune -- */
  // A sigil: an outer broken circle, an inner triangle, and a seeded set of
  // chords. Angular and asymmetric — a symmetric glyph reads as a corporate logo
  // and Solo Leveling's marks are deliberately unbalanced.
  {
    const segs = [];
    const ring = 0.62;
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI * 0.5;
      pts.push([Math.cos(a) * ring, Math.sin(a) * ring]);
    }
    // Chords between non-adjacent vertices, chosen by the seeded stream.
    for (let i = 0; i < 5; i++) {
      const a = rng.int(0, 5);
      let b = (a + rng.int(2, 4)) % 6;
      if (b === a) b = (a + 2) % 6;
      segs.push([pts[a][0], pts[a][1], pts[b][0], pts[b][1]]);
    }
    // A short radial tick off three of the vertices.
    for (let i = 0; i < 3; i++) {
      const v = pts[rng.int(0, 5)];
      segs.push([v[0], v[1], v[0] * 1.28, v[1] * 1.28]);
    }
    fill(SPRITE.rune, (x, y) => {
      const r = Math.hypot(x, y);
      let d = 1e9;
      for (let i = 0; i < segs.length; i++) {
        const S = segs[i];
        d = Math.min(d, segDist(x, y, S[0], S[1], S[2], S[3]));
      }
      // Broken outer circle: three gaps at fixed angles.
      const ang = Math.atan2(y, x);
      const gap = Math.abs(Math.sin(ang * 1.5)) > 0.94 ? 1 : 0;
      const circ = gap ? 1e9 : Math.abs(r - 0.82);
      d = Math.min(d, circ);
      const lineW = 0.028;
      let a = 1 - smooth(lineW * 0.55, lineW * 1.5, d);
      // A dim inner wash so the glyph has a body rather than being pure line art.
      a = Math.max(a, (1 - smooth(0.0, 0.80, r)) * 0.13);
      out[0] = clamp01(0.55 + 0.55 * (1 - smooth(0, lineW, d)));
      out[1] = a;
      return out;
    });
  }

  /* ----------------------------------------------------------------- ring -- */
  // A shockwave. Sharp on the OUTSIDE edge and soft on the inside — a real
  // pressure front has a discontinuity leading and a wake trailing, and getting
  // that asymmetry right is most of why an expanding ring reads as a blast
  // rather than as a scaling circle.
  fill(SPRITE.ring, (x, y) => {
    const r = Math.hypot(x, y);
    const outer = 1 - smooth(0.82, 0.90, r);
    const inner = smooth(0.30, 0.80, r);
    const band = outer * inner;
    const hot = Math.exp(-((r - 0.83) ** 2) / 0.0009);
    const a = clamp01(band * 0.55 + hot);
    out[0] = clamp01(0.42 + 0.62 * hot + 0.20 * band);
    out[1] = a;
    return out;
  });

  /* --------------------------------------------------------------- energy -- */
  // The shadow-energy wisp: an elongated flame silhouette with a hot core and
  // ridged fluting, authored pointing along +Y.
  {
    const s = seeds[SPRITE.energy];
    fill(SPRITE.energy, (x, y) => {
      const h = (y + 1) * 0.5;
      // Widest at 28% of the height, pointed at the tip — the same inflection
      // the world's brazier plume uses, for the same reason.
      const rad = 0.42 * Math.pow(1 - h, 0.8) * (0.42 + 0.58 * Math.sin(Math.min(1, h * 3.4) * Math.PI * 0.5));
      const d = Math.abs(x) / (rad + 1e-4);
      let a = 1 - smooth(0.55, 1.05, d);
      const flute = noise.ridge(s.ox + x * 5.0, s.oy + y * 3.0, 3);
      a *= 0.55 + 0.70 * flute;
      a *= 1 - smooth(0.80, 1.0, h);
      const core = Math.exp(-(x * x) / 0.012) * (1 - smooth(0.1, 0.75, h));
      out[0] = clamp01(0.40 + 0.70 * core + 0.30 * flute);
      out[1] = clamp01(a + core * 0.55);
      return out;
    });
  }

  /* ----------------------------------------------------------------- chip -- */
  // A hard-edged shard. Convex polygon from seeded radii, with a facet shade so
  // a tumbling chip catches "light" as it rotates.
  {
    const R = 7;
    const rad = [];
    for (let i = 0; i < R; i++) rad.push(rng.range(0.42, 0.86));
    fill(SPRITE.chip, (x, y) => {
      const r = Math.hypot(x, y);
      let ang = Math.atan2(y, x);
      if (ang < 0) ang += Math.PI * 2;
      const f = (ang / (Math.PI * 2)) * R;
      const i0 = Math.floor(f) % R;
      const i1 = (i0 + 1) % R;
      const t = f - Math.floor(f);
      // Linear (not smooth) interpolation between radii — we WANT the corners.
      const edge = rad[i0] + (rad[i1] - rad[i0]) * t;
      const a = 1 - smooth(edge - 0.03, edge + 0.02, r);
      // Two facets split along a diagonal, so the shard has a light and a dark
      // face. At 120 px of character height this is the only cue that it is a
      // solid and not a hole.
      const facet = (x * 0.7 + y * 0.7) > 0 ? 0.82 : 0.34;
      out[0] = facet * (0.75 + 0.30 * (1 - r / (edge + 1e-3)));
      out[1] = a;
      return out;
    });
  }

  /* ---------------------------------------------------------------- flare -- */
  // The impact-frame core: a tight disc plus four streaks plus four shorter
  // diagonals. This is the sprite that is allowed to clip to white.
  fill(SPRITE.flare, (x, y) => {
    const r2 = x * x + y * y;
    const core = Math.exp(-r2 * 90);
    const glow = Math.exp(-r2 * 6.5) * 0.42;
    const ax = Math.abs(x), ay = Math.abs(y);
    const hStreak = Math.exp(-(y * y) / 0.0016) * (1 - smooth(0.15, 0.98, ax));
    const vStreak = Math.exp(-(x * x) / 0.0016) * (1 - smooth(0.15, 0.98, ay));
    const d1 = (x - y) * 0.7071, d2 = (x + y) * 0.7071;
    const dStreak = (Math.exp(-(d1 * d1) / 0.0009) + Math.exp(-(d2 * d2) / 0.0009)) *
      (1 - smooth(0.10, 0.72, Math.sqrt(r2))) * 0.42;
    const a = clamp01(core + glow + hStreak * 0.85 + vStreak * 0.85 + dStreak);
    out[0] = clamp01(0.55 + 0.60 * core + 0.25 * (hStreak + vStreak));
    out[1] = a;
    return out;
  });

  /* ---------------------------------------------------------------- crack -- */
  // A fracture decal: branching radial lines, thin, with a faint pulverised
  // wash at the origin.
  {
    const s = seeds[SPRITE.crack];
    const lines = [];
    const branches = 7;
    for (let i = 0; i < branches; i++) {
      const a0 = (i / branches) * Math.PI * 2 + rng.range(-0.28, 0.28);
      let x0 = 0, y0 = 0, a = a0;
      const steps = rng.int(2, 4);
      for (let k = 0; k < steps; k++) {
        const len = rng.range(0.18, 0.34);
        const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
        lines.push([x0, y0, x1, y1, 1 - k / steps]);
        // A side branch off the middle joint.
        if (k === 1 && rng.float() > 0.45) {
          const b = a + rng.range(-0.9, 0.9);
          const bl = rng.range(0.10, 0.20);
          lines.push([x0, y0, x0 + Math.cos(b) * bl, y0 + Math.sin(b) * bl, 0.5]);
        }
        x0 = x1; y0 = y1;
        a += rng.range(-0.42, 0.42);
      }
    }
    fill(SPRITE.crack, (x, y) => {
      let a = 0;
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        const d = segDist(x, y, L[0], L[1], L[2], L[3]);
        const w = 0.012 + 0.020 * L[4];
        a = Math.max(a, (1 - smooth(w * 0.4, w * 1.6, d)) * (0.45 + 0.55 * L[4]));
      }
      const r = Math.hypot(x, y);
      const wash = (1 - smooth(0.0, 0.55, r)) * 0.30 *
        (0.4 + 0.9 * noise.fbm(s.ox + x * 5, s.oy + y * 5, 3));
      out[0] = 0.30 + 0.30 * a;
      out[1] = clamp01(Math.max(a, wash) * (1 - smooth(0.80, 1.0, r)));
      return out;
    });
  }

  /* --------------------------------------------------------------- scorch -- */
  // A soot burn. Dark and heavy in the middle, ragged, with a lighter ashy rim —
  // the rim is what makes it read as burned rather than as a stain.
  {
    const s = seeds[SPRITE.scorch];
    fill(SPRITE.scorch, (x, y) => {
      const r = Math.hypot(x, y);
      const t = noise.fbm(s.ox + x * 2.3, s.oy + y * 2.3, 5, 2.05, 0.56);
      const rr = r * (0.72 + 0.58 * t);
      const a = Math.pow(1 - smooth(0.05, 0.95, rr), 1.3);
      const rim = Math.exp(-((rr - 0.62) ** 2) / 0.016);
      out[0] = clamp01(0.10 + 0.16 * t + 0.55 * rim);
      out[1] = a * (0.55 + 0.60 * t);
      return out;
    });
  }

  /* ------------------------------------------------------------ glyphRing -- */
  // The extraction / aura ground mark: two concentric hairlines, a band of tick
  // marks, and eight small angular glyph blocks. This one sprite carries the
  // whole "a magic circle just scribed itself under the corpse" read.
  {
    const blocks = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.19;
      blocks.push({ a, k: rng.int(0, 3), s: rng.range(0.055, 0.085) });
    }
    fill(SPRITE.glyphRing, (x, y) => {
      const r = Math.hypot(x, y);
      let ang = Math.atan2(y, x);
      if (ang < 0) ang += Math.PI * 2;

      let a = 0;
      // Two hairlines.
      a = Math.max(a, 1 - smooth(0.006, 0.019, Math.abs(r - 0.92)));
      a = Math.max(a, (1 - smooth(0.005, 0.016, Math.abs(r - 0.60))) * 0.75);
      // Tick marks between them.
      if (r > 0.62 && r < 0.90) {
        const ticks = 48;
        const f = ang / (Math.PI * 2) * ticks;
        const frac = Math.abs(f - Math.round(f));
        const long = Math.round(f) % 6 === 0;
        const inner = long ? 0.64 : 0.80;
        if (r > inner) a = Math.max(a, (1 - smooth(0.10, 0.30, frac)) * (long ? 0.9 : 0.45));
      }
      // Glyph blocks sitting on the inner line.
      for (let i = 0; i < blocks.length; i++) {
        const B = blocks[i];
        const bx = Math.cos(B.a) * 0.42, by = Math.sin(B.a) * 0.42;
        const dx = x - bx, dy = y - by;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d < B.s * 1.6) {
          // Three tiny motifs: a bar, a cross, a chevron.
          let g = 0;
          if (B.k === 0) g = 1 - smooth(B.s * 0.30, B.s * 0.55, Math.abs(dy));
          else if (B.k === 1) g = Math.max(1 - smooth(B.s * 0.22, B.s * 0.42, Math.abs(dx)),
                                            1 - smooth(B.s * 0.22, B.s * 0.42, Math.abs(dy)));
          else g = 1 - smooth(B.s * 0.24, B.s * 0.48, Math.abs(Math.abs(dx) - Math.abs(dy)));
          g *= 1 - smooth(B.s * 0.9, B.s * 1.25, d);
          a = Math.max(a, g);
        }
      }
      // Faint inner disc so the mark sits on something. 0.03, not 0.09: this
      // is a 2.4 m additive disc on the floor and at 0.09 it contributed more
      // total light to the frame than every line in the glyph put together.
      a = Math.max(a, (1 - smooth(0.0, 0.95, r)) * 0.030);
      out[0] = clamp01(0.50 + 0.55 * a);
      out[1] = a * (1 - smooth(0.93, 1.0, r));
      return out;
    });
  }

  /* ---------------------------------------------------------------- frost -- */
  // Six-fold crystal. Folded polar coordinates give perfect hexagonal symmetry
  // for free, and the sub-branches are drawn as segments off the main spine.
  fill(SPRITE.frost, (x, y) => {
    const r = Math.hypot(x, y);
    let ang = Math.atan2(y, x);
    const sector = Math.PI / 3;
    ang = Math.abs(((ang % sector) + sector) % sector - sector * 0.5);
    const px = Math.cos(ang) * r, py = Math.sin(ang) * r;
    // Main spine along the folded axis.
    let d = segDist(px, py, 0, 0, 0.92, 0);
    // Three pairs of barbs.
    for (let i = 1; i <= 3; i++) {
      const at = i * 0.22;
      const len = 0.24 * (1 - i * 0.22);
      d = Math.min(d, segDist(px, py, at, 0, at + len * 0.72, len));
    }
    const w = 0.020;
    let a = 1 - smooth(w * 0.5, w * 2.2, d);
    a *= 1 - smooth(0.86, 1.0, r);
    const centre = Math.exp(-r * r * 40);
    out[0] = clamp01(0.55 + 0.55 * centre + 0.25 * a);
    out[1] = clamp01(a + centre * 0.85);
    return out;
  });

  /* ------------------------------------------------------------------------ */

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'mn.fx.atlas';
  // The value channel is a linear ramp we authored; decoding it as sRGB would
  // crush every soft falloff. Colour comes from the palette tint, in linear space.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;

  return { texture: tex, ms: performance.now() - t0, size: N };
}

/** UV rectangle of a sprite, inset by half a texel so bilinear filtering at the
 *  tile boundary cannot reach the neighbour. Consumers that build their own
 *  geometry (rings, columns, glyph quads) call this; the particle shader does
 *  the same arithmetic on the GPU from the tile index. */
export function spriteUv(index, out = { x: 0, y: 0, w: 0, h: 0 }) {
  const inset = 0.5 / ATLAS_SIZE;
  out.x = (index % GRID) / GRID + inset;
  out.y = Math.floor(index / GRID) / GRID + inset;
  out.w = 1 / GRID - inset * 2;
  out.h = 1 / GRID - inset * 2;
  return out;
}
