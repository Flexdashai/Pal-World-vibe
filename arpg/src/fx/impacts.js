import { ELEMENTS } from '../core/palette.js';
import { DECAL_SPRITE } from './atlas.js';
import { FX } from './tuning.js';

/**
 * MONARCH — impact effects, switched on the surface `physics` reports.
 *
 * ARCHITECTURE.md: *"Every hit produces impact frames, a decal, a particle
 * burst, a light flash and a damage number."* This file owns the first four for
 * everything that is not flesh; `blood.js` owns flesh.
 *
 * ---------------------------------------------------------------------------
 * AN IMPACT IS THREE LAYERS, COMPOSED
 *
 *   1. THE CORE      identical for every surface: a two-frame white flare, a
 *                    micro shockwave and, above a magnitude threshold, a light.
 *                    This is the "impact frame" and it is what makes a hit read
 *                    as a hit before the eye has resolved anything else.
 *   2. THE SURFACE   what the material does: stone chips and dust, metal sparks,
 *                    wood splinters, crystal shards, water droplets. Read from
 *                    `SURFACE_FX` below.
 *   3. THE ELEMENT   what the damage type does on top: fire embers and a scorch
 *                    mark, frost crystals, lightning arcs, violet shadow motes.
 *
 * Composing them means an ice spell hitting stone looks like an ice spell
 * hitting STONE, which is the whole reason `physics` tags surfaces at all.
 *
 * ---------------------------------------------------------------------------
 * ON PARTICLE COLOUR, WHICH IS NOT ALBEDO
 *
 * Particles are unlit — one texture fetch, no light loop, which is the only way
 * a thousand of them are affordable on a CPU rasteriser. So the tints below are
 * NOT the surface albedo from `palette.ENV` (stone is 0.06 linear; tinting dust
 * with it would make it invisible against a dark floor). They are approximately
 * `albedo x typical irradiance` — what that dust looks like standing in the
 * light of a brazier, which is where a fight happens. Auto-exposure then does
 * the rest.
 */

/** Reflected direction, written into the shared scratch. */
const R = { x: 0, y: 1, z: 0 };
function reflect(dx, dy, dz, nx, ny, nz, bias = 0.55) {
  const d = dx * nx + dy * ny + dz * nz;
  let rx = dx - 2 * d * nx;
  let ry = dy - 2 * d * ny;
  let rz = dz - 2 * d * nz;
  // Blend toward the surface normal. A pure mirror reflection sprays debris
  // along the floor when a blow comes in flat, which looks like a ricochet
  // rather than an impact; real debris leaves along the normal.
  rx += nx * bias; ry += ny * bias; rz += nz * bias;
  const l = Math.hypot(rx, ry, rz) || 1;
  R.x = rx / l; R.y = ry / l; R.z = rz / l;
  return R;
}

/**
 * Per-surface recipe.
 *
 *   dust/chip/spark  counts at magnitude 1
 *   dustColor        the unlit tint (see the note above)
 *   hardness         0..1, scales spark production and the core flare
 *   decal            atlas sprite index, or null
 */
const SURFACE_FX = {
  stone: {
    dust: 6, chip: 5, spark: 1, splinter: 0,
    dustColor: [0.30, 0.295, 0.285], chipColor: [0.24, 0.235, 0.23],
    hardness: 0.85, decal: DECAL_SPRITE.crack, decalColor: [0.10, 0.10, 0.11],
    decalSize: 0.42, decalRough: 1.9,
  },
  flagstone: {
    dust: 7, chip: 4, spark: 1, splinter: 0,
    dustColor: [0.28, 0.28, 0.30], chipColor: [0.22, 0.22, 0.24],
    hardness: 0.8, decal: DECAL_SPRITE.crack, decalColor: [0.09, 0.09, 0.10],
    decalSize: 0.46, decalRough: 1.8,
  },
  dirt: {
    dust: 11, chip: 2, spark: 0, splinter: 0,
    dustColor: [0.24, 0.195, 0.150], chipColor: [0.18, 0.14, 0.10],
    hardness: 0.15, decal: null, decalColor: [0.08, 0.06, 0.04],
    decalSize: 0.5, decalRough: 2.4,
  },
  ash: {
    dust: 13, chip: 1, spark: 0, splinter: 0,
    dustColor: [0.26, 0.255, 0.25], chipColor: [0.18, 0.18, 0.18],
    hardness: 0.1, decal: DECAL_SPRITE.scorch, decalColor: [0.055, 0.052, 0.050],
    decalSize: 0.55, decalRough: 2.6,
  },
  wood: {
    dust: 4, chip: 2, spark: 0, splinter: 7,
    dustColor: [0.22, 0.16, 0.10], chipColor: [0.26, 0.18, 0.11],
    hardness: 0.4, decal: DECAL_SPRITE.crack, decalColor: [0.06, 0.042, 0.026],
    decalSize: 0.34, decalRough: 2.2,
  },
  metal: {
    dust: 2, chip: 1, spark: 15, splinter: 0,
    dustColor: [0.20, 0.20, 0.22], chipColor: [0.32, 0.31, 0.30],
    hardness: 1.0, decal: DECAL_SPRITE.scorch, decalColor: [0.07, 0.065, 0.062],
    decalSize: 0.24, decalRough: 1.5,
  },
  bone: {
    dust: 6, chip: 7, spark: 0, splinter: 3,
    dustColor: [0.42, 0.40, 0.34], chipColor: [0.46, 0.43, 0.36],
    hardness: 0.55, decal: DECAL_SPRITE.crack, decalColor: [0.16, 0.15, 0.12],
    decalSize: 0.32, decalRough: 2.0,
  },
  cloth: {
    dust: 7, chip: 0, spark: 0, splinter: 2,
    dustColor: [0.24, 0.19, 0.16], chipColor: [0.22, 0.17, 0.15],
    hardness: 0.05, decal: null, decalColor: [0.08, 0.06, 0.05],
    decalSize: 0.3, decalRough: 2.4,
  },
  water: {
    dust: 5, chip: 0, spark: 0, splinter: 0,
    dustColor: [0.30, 0.36, 0.40], chipColor: [0.34, 0.40, 0.46],
    hardness: 0.0, decal: DECAL_SPRITE.ring, decalColor: [0.24, 0.30, 0.36],
    decalSize: 0.75, decalRough: 0.35,
  },
  crystal: {
    dust: 3, chip: 9, spark: 6, splinter: 0,
    dustColor: [0.34, 0.28, 0.52], chipColor: [0.42, 0.34, 0.72],
    hardness: 0.95, decal: DECAL_SPRITE.crack, decalColor: [0.16, 0.12, 0.30],
    decalSize: 0.36, decalRough: 0.5,
  },
  blood: {
    dust: 3, chip: 0, spark: 0, splinter: 0,
    dustColor: [0.22, 0.06, 0.05], chipColor: [0.20, 0.05, 0.04],
    hardness: 0.0, decal: DECAL_SPRITE.blood, decalColor: ELEMENTS.blood.core,
    decalSize: 0.4, decalRough: 0.7,
  },
};
/** `flesh` is handled by blood.js, but a fallback keeps a mis-tagged collider
 *  from producing no effect at all — silence is worse than the wrong effect. */
SURFACE_FX.flesh = SURFACE_FX.blood;

/** Elemental overlay, applied on top of whatever the surface did. */
const ELEMENT_FX = {
  physical: null,
  fire: {
    kind: 'ember', count: 9, speed: 2.4, intensity: 3.4, life: 1.25,
    light: { intensity: 15, distance: 5.0, release: 0.4 },
    decal: DECAL_SPRITE.scorch, decalColor: [0.045, 0.030, 0.022], decalSize: 0.55, decalRough: 2.6,
    smoke: 4,
  },
  frost: {
    kind: 'frost', count: 8, speed: 2.8, intensity: 2.6, life: 0.9,
    light: { intensity: 9, distance: 4.6, release: 0.30 },
    decal: DECAL_SPRITE.frost, decalColor: [0.20, 0.38, 0.55], decalSize: 0.6, decalRough: 0.3,
    smoke: 2, emissive: 0.35,
  },
  lightning: {
    kind: 'sparkHot', count: 16, speed: 8.5, intensity: 8.0, life: 0.55,
    light: { intensity: 22, distance: 5.6, release: 0.16 },
    decal: DECAL_SPRITE.scorch, decalColor: [0.06, 0.065, 0.08], decalSize: 0.35, decalRough: 2.2,
    smoke: 1,
  },
  shadow: {
    // Rising, not falling. See tuning.js — this is the signature.
    kind: 'emberRise', count: 12, speed: 2.0, intensity: 3.0, life: 1.5,
    light: { intensity: 13, distance: 5.4, release: 0.42 },
    decal: DECAL_SPRITE.rune, decalColor: [0.22, 0.12, 0.55], decalSize: 0.7, decalRough: 1.4,
    smoke: 3, emissive: 0.9,
  },
  holy: {
    kind: 'ember', count: 10, speed: 2.6, intensity: 3.2, life: 1.0,
    light: { intensity: 15, distance: 5.4, release: 0.35 },
    decal: null, smoke: 2, emissive: 0.5,
  },
};

export class Impacts {
  /** @param {import('./index.js').FxSystem} fx */
  constructor(fx) {
    this.fx = fx;
    /** Coalescing ledger: the last few impact positions and times, so a six-hit
     *  flurry on one target does not spawn six identical bursts and turn the
     *  frame to soup. A tiny ring, checked linearly — four entries. */
    this._lx = new Float32Array(4);
    this._ly = new Float32Array(4);
    this._lz = new Float32Array(4);
    this._lt = new Float32Array(4).fill(-1e9);
    this._li = 0;
    this._suppressed = 0;
  }

  /**
   * @param {object} o
   *   x,y,z        contact point
   *   nx,ny,nz     surface normal (defaults to +Y)
   *   dx,dy,dz     incident direction (defaults to -normal)
   *   surface      one of the twelve names in ARCHITECTURE.md
   *   element      physical | shadow | fire | frost | lightning | holy
   *   magnitude    ~1 for a normal hit, 2-4 for a heavy one
   *   crit         boolean
   *   decal        false to suppress the decal (a hit on an actor, say)
   */
  spawn(o) {
    const fx = this.fx;
    const em = fx.emitter;
    const time = fx.time;
    const mag = Math.max(0.15, o.magnitude ?? 1);

    // ---- coalesce ---------------------------------------------------------
    if (o.coalesce !== false) {
      for (let i = 0; i < 4; i++) {
        if (time - this._lt[i] > FX.impact.coalesce) continue;
        const dx = o.x - this._lx[i], dy = o.y - this._ly[i], dz = o.z - this._lz[i];
        if (dx * dx + dy * dy + dz * dz < 0.30 * 0.30) { this._suppressed++; return false; }
      }
      const s = this._li = (this._li + 1) & 3;
      this._lx[s] = o.x; this._ly[s] = o.y; this._lz[s] = o.z; this._lt[s] = time;
    }

    let nx = o.nx ?? 0, ny = o.ny ?? 1, nz = o.nz ?? 0;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const dx = o.dx ?? -nx, dy = o.dy ?? -ny, dz = o.dz ?? -nz;
    const r = reflect(dx, dy, dz, nx, ny, nz);

    const S = SURFACE_FX[o.surface] ?? SURFACE_FX.stone;
    const E = ELEMENT_FX[o.element] ?? null;
    const el = ELEMENTS[o.element] ?? ELEMENTS.physical;

    // Lift the origin off the surface. Emitting exactly on it puts half of every
    // sprite behind the floor, where the soft-particle fade dutifully erases it.
    const ox = o.x + nx * 0.05, oy = o.y + ny * 0.05, oz = o.z + nz * 0.05;

    // ================= 1. the core ==========================================
    // Two frames of white-hot, well above the final brightness, exactly as the
    // phase table specifies. It is allowed — required — to clip.
    // Metres. A 0.30 m core at the 21 m gameplay camera is ~13 px — a genuine
    // impact FRAME. The first draft used 0.30 + 0.34*mag, which at magnitude 3
    // put a 1.3 m clipping white disc on screen for every heavy hit.
    const coreScale = (0.24 + 0.17 * mag) * (o.crit ? 1.35 : 1);
    em.burst('flare', {
      count: 1, x: ox, y: oy, z: oz,
      dx: r.x, dy: r.y, dz: r.z, spread: 0, speed: 0, speedVar: 0,
      color: el.glow, intensity: (o.crit ? 9.0 : 5.5) * (0.6 + 0.5 * S.hardness),
      size: coreScale, life: o.crit ? 1.25 : 1,
      softness: 0.6,
    });

    // A micro shockwave on the surface plane, only for a real blow — on a light
    // hit it reads as a second flare and muddies the core.
    if (mag > 0.8) {
      em.burst('shockAir', {
        count: 1, x: ox, y: oy, z: oz, spread: 0, speed: 0, speedVar: 0,
        color: el.glow, intensity: 1.5 * (o.crit ? 1.6 : 1),
        size: 0.20 + 0.13 * mag, life: 1.0, softness: 1.0,
      });
    }

    // ================= 2. the surface =======================================
    const k = Math.min(2.6, 0.55 + 0.62 * mag);

    if (S.dust > 0) {
      em.burst('dust', {
        count: Math.round(S.dust * k), x: ox, y: oy, z: oz,
        dx: r.x, dy: r.y, dz: r.z, spread: 0.95, speed: 1.5 + 1.1 * mag, speedVar: 0.55,
        radius: 0.045, color: S.dustColor, intensity: 1, size: 0.75 + 0.35 * mag,
        life: 0.9, alpha: 0.9,
      });
    }
    if (S.chip > 0) {
      em.burst('chip', {
        count: Math.round(S.chip * k), x: ox, y: oy, z: oz,
        dx: r.x, dy: r.y, dz: r.z, spread: 0.72, speed: 3.4 + 2.6 * mag, speedVar: 0.6,
        radius: 0.04, color: S.chipColor, intensity: 1, size: 0.8 + 0.4 * mag,
      });
    }
    if (S.splinter > 0) {
      em.burst('splinter', {
        count: Math.round(S.splinter * k), x: ox, y: oy, z: oz,
        dx: r.x, dy: r.y, dz: r.z, spread: 0.55, speed: 4.2 + 3.0 * mag, speedVar: 0.7,
        radius: 0.05, color: S.chipColor, intensity: 1.1, size: 0.9,
      });
    }
    if (S.spark > 0) {
      em.burst('spark', {
        count: Math.round(S.spark * k), x: ox, y: oy, z: oz,
        dx: r.x, dy: r.y, dz: r.z, spread: 0.62, speed: 5.5 + 4.5 * mag, speedVar: 0.85,
        radius: 0.03,
        // Struck metal is white-hot at the source and cools to orange in flight;
        // the fixed tint here is the average, and the size curve does the rest.
        color: ELEMENTS.fire.glow, intensity: 6.5 * (0.5 + 0.6 * S.hardness),
        size: 0.9 + 0.3 * mag,
      });
    }

    // ================= 3. the element =======================================
    if (E) {
      em.burst(E.kind, {
        count: Math.round(E.count * Math.min(2, k)), x: ox, y: oy, z: oz,
        dx: r.x, dy: r.y, dz: r.z, spread: 1.05, speed: E.speed * (0.7 + 0.4 * mag), speedVar: 0.7,
        radius: 0.07, color: el.core, intensity: E.intensity, life: E.life,
        size: 0.85 + 0.3 * mag,
      });
      if (E.smoke) {
        em.burst('smokeThin', {
          count: Math.round(E.smoke * k), x: ox, y: oy, z: oz,
          dx: nx, dy: ny, dz: nz, spread: 1.1, speed: 0.8, speedVar: 0.6,
          radius: 0.07, color: el.dark, intensity: 4.5, size: 0.9 + 0.4 * mag, alpha: 0.8,
        });
      }
      if (E.light && mag > 0.45) {
        fx.lights.acquire({
          x: ox, y: oy + 0.15, z: oz, color: el.light,
          intensity: E.light.intensity * Math.min(2.2, 0.55 + 0.6 * mag),
          distance: E.light.distance, attack: 0.02, release: E.light.release,
        });
      }
    } else if (mag > 1.4 || o.crit) {
      // Even a purely physical blow lights the wall for a frame or two. Without
      // it a heavy hit in a dark corridor produces no illumination at all and
      // the eye reads the flare as a decal.
      fx.lights.acquire({
        x: ox, y: oy + 0.12, z: oz, color: ELEMENTS.physical.light,
        intensity: 5.5 * mag * (o.crit ? 1.8 : 1), distance: 4.0,
        attack: 0.016, release: 0.13,
      });
    }

    // ================= 4. the decal =========================================
    if (o.decal !== false && mag > 0.55) {
      const sprite = E?.decal ?? S.decal;
      if (sprite !== null && sprite !== undefined) {
        const col = E?.decalColor ?? S.decalColor;
        const size = (E?.decalSize ?? S.decalSize) * (0.7 + 0.45 * mag);
        fx.decals.place({
          x: o.x, y: o.y, z: o.z, nx, ny, nz,
          sprite, size, color: col,
          alpha: Math.min(1, 0.45 + 0.35 * mag),
          rough: E?.decalRough ?? S.decalRough,
          emissive: E?.emissive ?? 0,
          rotation: fx.rng.range(0, Math.PI * 2),
          life: E ? 22 : FX.decals.life,
          fade: E ? 5 : FX.decals.fade,
          conform: ny > 0.6,
        });
      }
    }

    return true;
  }

  stats() { return { suppressed: this._suppressed }; }
}

/** Exposed so `index.js` can answer "does this surface bleed?" without
 *  duplicating the table. */
export function surfaceBleeds(surface) {
  return surface === 'flesh' || surface === 'blood';
}

export { SURFACE_FX, ELEMENT_FX };
