import { SPRITE } from './atlas.js';
import { MODE, PFLAG } from './particles.js';

/**
 * MONARCH — particle recipes and the emission helpers built on them.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT
 *
 *   KINDS      what a particle LOOKS like and how it MOVES — sprite, lifetime,
 *              size curve, drag, gravity, turbulence, alpha curve, draw mode.
 *   the caller where it is, which way it is going, how much energy it has, and
 *              what colour it is (always read from `palette.js`, never here).
 *
 * That split is what lets an impact recipe say "sparks, 14 of them, along the
 * reflected direction, at metal's colour" without restating what a spark is, and
 * it is why adding a new element does not require a new particle type.
 *
 * ---------------------------------------------------------------------------
 * ON ALLOCATION
 *
 * ARCHITECTURE.md rule 5 forbids per-FRAME allocation. The recipe methods below
 * take an options object, which is one small short-lived literal per EFFECT —
 * a few per second, in the young generation, and worth it for call sites that
 * can be read. The two emitters that genuinely run every frame (shadow trails
 * and the monarch aura) own a preallocated options object and mutate it; see
 * `shadowset.js`. Nothing in this file allocates internally: `spawn` is the one
 * reused particle descriptor and it is refilled in place on every emission.
 */

/**
 * The kind table.
 *
 * `size1` is the END size. Where it is smaller than `size0` the particle
 * shrinks, which is right for anything cooling (embers, sparks) and wrong for
 * anything expanding (smoke, dust) — getting that backwards is the single most
 * common reason a burst reads as "a texture scaling up".
 */
export const KINDS = {
  /* ---- alpha-blended: smoke, dust, debris, blood ---------------------- */

  smoke: {
    tile: SPRITE.smoke, additive: false, mode: MODE.BILLBOARD,
    life: [0.95, 1.7], size0: [0.20, 0.36], size1: [1.05, 1.85],
    drag: 2.3, gravity: 0.42, turbulence: 0.55,
    alpha: 0.40, fadeIn: 0.10, fadeOut: 1.35, spin: [-0.8, 0.8], softness: 1.8,
  },
  smokeThin: {
    tile: SPRITE.wisp, additive: false, mode: MODE.BILLBOARD,
    life: [0.7, 1.25], size0: [0.16, 0.30], size1: [0.75, 1.30],
    drag: 2.6, gravity: 0.55, turbulence: 0.85,
    alpha: 0.26, fadeIn: 0.12, fadeOut: 1.5, spin: [-1.5, 1.5], softness: 1.6,
  },
  dust: {
    tile: SPRITE.dust, additive: false, mode: MODE.BILLBOARD,
    life: [0.75, 1.4], size0: [0.18, 0.34], size1: [0.85, 1.55],
    // Slightly negative: pulverised stone settles, it does not rise.
    drag: 3.1, gravity: -0.38, turbulence: 0.35,
    alpha: 0.30, fadeIn: 0.06, fadeOut: 1.6, spin: [-0.6, 0.6], softness: 1.5,
  },
  chip: {
    tile: SPRITE.chip, additive: false, mode: MODE.BILLBOARD,
    life: [0.45, 0.95], size0: [0.035, 0.085], size1: [0.030, 0.070],
    drag: 0.55, gravity: -13.5, turbulence: 0,
    alpha: 1.0, fadeIn: 0.01, fadeOut: 0.9, spin: [-16, 16], softness: 0.35,
  },
  splinter: {
    tile: SPRITE.chip, additive: false, mode: MODE.STRETCH,
    life: [0.5, 1.0], size0: [0.022, 0.048], size1: [0.020, 0.040],
    drag: 0.9, gravity: -12.0, turbulence: 0,
    alpha: 1.0, fadeIn: 0.01, fadeOut: 0.9, stretch: 0.055, softness: 0.35,
  },
  drop: {
    tile: SPRITE.drop, additive: false, mode: MODE.STRETCH,
    // 4.5-9.5 cm. Physically a droplet is a few millimetres, but at the 21 m
    // gameplay camera a physical droplet is a third of a pixel and the arterial
    // arc — the single most important read in the whole blood system — simply
    // is not there. The velocity stretch does the rest.
    life: [0.6, 1.5], size0: [0.045, 0.095], size1: [0.040, 0.080],
    drag: 0.30, gravity: -12.6, turbulence: 0,
    alpha: 1.0, fadeIn: 0.005, fadeOut: 0.45, stretch: 0.030, softness: 0.30,
    flags: PFLAG.LANDS,
  },
  /** Fine aerosol at the wound — this is what sells a cut as wet. */
  mist: {
    tile: SPRITE.smoke, additive: false, mode: MODE.BILLBOARD,
    life: [0.28, 0.55], size0: [0.07, 0.16], size1: [0.34, 0.62],
    drag: 5.0, gravity: -2.0, turbulence: 0.3,
    alpha: 0.62, fadeIn: 0.04, fadeOut: 1.7, spin: [-2, 2], softness: 0.9,
  },
  /** A thick gobbet: slower, bigger, always lands. */
  gobbet: {
    tile: SPRITE.splat, additive: false, mode: MODE.BILLBOARD,
    life: [0.5, 1.2], size0: [0.09, 0.19], size1: [0.08, 0.16],
    drag: 0.5, gravity: -13.0, turbulence: 0,
    alpha: 1.0, fadeIn: 0.01, fadeOut: 0.5, spin: [-9, 9], softness: 0.3,
    flags: PFLAG.LANDS,
  },

  /* ---- additive: fire, energy, sparks --------------------------------- */

  ember: {
    tile: SPRITE.ember, additive: true, mode: MODE.FLAT,
    life: [0.65, 1.5], size0: [0.065, 0.135], size1: [0.024, 0.055],
    drag: 0.65, gravity: -1.1, turbulence: 1.05,
    alpha: 1.0, fadeIn: 0.05, fadeOut: 1.5, softness: 0.55,
  },
  /**
   * The Solo Leveling ember: it RISES. This is not a low gravity, it is a
   * positive one, and it is the single strongest read in the whole shadow set —
   * falling embers say "fire", rising embers say "something is being taken".
   */
  emberRise: {
    tile: SPRITE.ember, additive: true, mode: MODE.FLAT,
    // 7-15 cm. At the 21 m gameplay camera that is 3-7 px, which is the
    // smallest a point of light can be and still survive the TAA resolve as a
    // point of light rather than as noise it averages away.
    life: [0.9, 2.1], size0: [0.070, 0.150], size1: [0.020, 0.050],
    drag: 0.42, gravity: 1.85, turbulence: 1.35,
    alpha: 1.0, fadeIn: 0.08, fadeOut: 1.25, softness: 0.55,
  },
  spark: {
    tile: SPRITE.spark, additive: true, mode: MODE.STRETCH,
    life: [0.22, 0.52], size0: [0.026, 0.050], size1: [0.010, 0.020],
    drag: 3.2, gravity: -15.0, turbulence: 0,
    alpha: 1.0, fadeIn: 0.004, fadeOut: 2.2, stretch: 0.042, softness: 0.28,
  },
  /** Hotter, shorter, straighter — struck metal rather than a glancing scrape. */
  sparkHot: {
    tile: SPRITE.spark, additive: true, mode: MODE.STRETCH,
    life: [0.16, 0.38], size0: [0.032, 0.058], size1: [0.008, 0.016],
    drag: 2.2, gravity: -13.0, turbulence: 0,
    alpha: 1.0, fadeIn: 0.002, fadeOut: 2.8, stretch: 0.052, softness: 0.25,
  },
  wisp: {
    tile: SPRITE.energy, additive: true, mode: MODE.STRETCH,
    life: [0.35, 0.85], size0: [0.10, 0.26], size1: [0.03, 0.09],
    drag: 1.6, gravity: 0.6, turbulence: 1.2,
    alpha: 1.0, fadeIn: 0.09, fadeOut: 1.7, stretch: 0.020, softness: 0.7,
  },
  /** A soft glowing volume — the body of a spell, under the sharper elements. */
  glow: {
    tile: SPRITE.smoke, additive: true, mode: MODE.BILLBOARD,
    life: [0.30, 0.65], size0: [0.35, 0.75], size1: [0.9, 1.7],
    drag: 3.4, gravity: 0.3, turbulence: 0.4,
    alpha: 0.55, fadeIn: 0.06, fadeOut: 2.0, spin: [-1.2, 1.2], softness: 2.2,
  },
  /** The impact frame. Two or three frames of clipped white, then gone. */
  flare: {
    tile: SPRITE.flare, additive: true, mode: MODE.FLAT,
    life: [0.085, 0.13], size0: [0.55, 0.85], size1: [1.1, 1.7],
    drag: 0, gravity: 0, turbulence: 0,
    alpha: 1.0, fadeIn: 0.0, fadeOut: 2.6, softness: 0.6,
  },
  /** An expanding pressure front, drawn flat on the ground. */
  shock: {
    tile: SPRITE.ring, additive: true, mode: MODE.GROUND,
    life: [0.26, 0.34], size0: [0.4, 0.5], size1: [3.0, 3.4],
    drag: 0, gravity: 0, turbulence: 0,
    alpha: 1.0, fadeIn: 0.0, fadeOut: 2.1, softness: 1.2,
  },
  /** A vertical ring — the wavefront seen edge-on, for an airborne blast. */
  shockAir: {
    tile: SPRITE.ring, additive: true, mode: MODE.FLAT,
    life: [0.20, 0.28], size0: [0.35, 0.45], size1: [2.4, 2.9],
    drag: 0, gravity: 0, turbulence: 0,
    alpha: 1.0, fadeIn: 0.0, fadeOut: 2.4, softness: 1.0,
  },
  /** A glyph that scribes itself on the ground and burns away. */
  rune: {
    tile: SPRITE.rune, additive: true, mode: MODE.GROUND,
    life: [0.55, 0.9], size0: [0.55, 0.8], size1: [0.75, 1.05],
    drag: 0, gravity: 0, turbulence: 0,
    alpha: 1.0, fadeIn: 0.16, fadeOut: 1.5, spin: [-0.35, 0.35], softness: 1.0,
  },
  /** The same glyph, hanging in the air and facing the camera. */
  glyph: {
    tile: SPRITE.rune, additive: true, mode: MODE.FLAT,
    life: [0.6, 1.1], size0: [0.22, 0.40], size1: [0.30, 0.52],
    drag: 0.8, gravity: 0.55, turbulence: 0.2,
    alpha: 1.0, fadeIn: 0.14, fadeOut: 1.6, softness: 0.8,
  },
  frost: {
    tile: SPRITE.frost, additive: true, mode: MODE.FLAT,
    life: [0.35, 0.8], size0: [0.10, 0.22], size1: [0.16, 0.34],
    drag: 2.4, gravity: -1.4, turbulence: 0.5,
    alpha: 1.0, fadeIn: 0.04, fadeOut: 1.9, softness: 0.5,
  },
};

/* ==========================================================================
 * The emitter
 * ========================================================================== */

const TMP_BASIS = { ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0 };

/**
 * Build an orthonormal basis around (dx,dy,dz), written into TMP_BASIS.
 * The classic branchless Duff/Frisvad construction — no allocation, no
 * trigonometry, and stable when the direction is near a pole (which the naive
 * cross-with-up version is not, and a spray straight up is a very common case
 * here).
 */
function basis(dx, dy, dz) {
  const sign = dz >= 0 ? 1 : -1;
  const a = -1 / (sign + dz);
  const b = dx * dy * a;
  TMP_BASIS.ax = 1 + sign * dx * dx * a;
  TMP_BASIS.ay = sign * b;
  TMP_BASIS.az = -sign * dx;
  TMP_BASIS.bx = b;
  TMP_BASIS.by = sign + dy * dy * a;
  TMP_BASIS.bz = -dy;
}

export class Emitter {
  constructor(particles, rng) {
    this.P = particles;
    this.rng = rng;
    /** THE reused particle descriptor. Refilled in place on every emission. */
    this.spawn = {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      life: 1, size0: 0.1, size1: 0.1, rot: 0, spin: 0,
      r: 1, g: 1, b: 1, drag: 0, gravity: 0, turbulence: 0, seed: 0,
      alpha: 1, fadeIn: 0.06, fadeOut: 1.5, tile: 0, mode: 0, softness: 1,
      stretch: 0, cx: 0, cz: 0, orbit: 0, radial: 0, groundY: -1e9,
      flags: 0, tag: 0, additive: false,
    };
    /** Scratch used by `ring` and `column` when they call `burst` per particle.
     *  Without it a 34-particle ring would allocate 34 option literals, and the
     *  ring emitters run every frame from the aura and the extraction. */
    this._sub = {
      count: 1, x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0,
      spread: undefined, flatten: undefined, speed: 1, speedVar: undefined,
      radius: undefined, rise: undefined, rot: undefined,
      color: undefined, intensity: undefined, size: undefined, life: undefined,
      alpha: undefined, softness: undefined, drag: undefined, gravity: undefined,
      turbulence: undefined, mode: undefined, fadeIn: undefined, fadeOut: undefined,
      groundY: undefined, tag: undefined, flags: undefined,
      orbit: undefined, radial: undefined, cx: undefined, cz: undefined,
    };
  }

  /** Copy the shading/behaviour fields a wrapper passes straight through. */
  _inherit(dst, o) {
    dst.color = o.color; dst.intensity = o.intensity; dst.size = o.size;
    dst.life = o.life; dst.alpha = o.alpha; dst.softness = o.softness;
    dst.drag = o.drag; dst.gravity = o.gravity; dst.turbulence = o.turbulence;
    dst.mode = o.mode; dst.rot = o.rot; dst.fadeIn = o.fadeIn; dst.fadeOut = o.fadeOut;
    dst.groundY = o.groundY; dst.tag = o.tag; dst.flags = o.flags;
    dst.orbit = o.orbit; dst.radial = o.radial;
    dst.speedVar = o.speedVar; dst.flatten = o.flatten;
    // `radius` is deliberately NOT inherited: in `ring`/`column` it names the
    // shape's radius, while in `burst` it is the per-particle spawn jitter.
    return dst;
  }

  /**
   * The one general emission primitive. Everything else is a thin wrapper.
   *
   * @param {string} kindName  key into KINDS
   * @param {object} o
   *   count       how many
   *   x,y,z       origin
   *   dx,dy,dz    principal direction (need not be normalised); default +Y
   *   spread      cone half-angle in radians, 0 = a beam, PI = a sphere
   *   flatten     0..1, squashes the cone across the `dy` axis into a SHEET.
   *               A slash throws blood in a plane, not a cone — this is the
   *               parameter that makes directional effects read as directional.
   *   speed       metres/second along the sampled direction
   *   speedVar    +-fraction of `speed`
   *   radius      spawn jitter, metres
   *   rise        extra +Y velocity added after the cone sample
   *   color       [r,g,b] linear
   *   intensity   multiplier on colour (additive radiance, or tint for alpha)
   *   size        multiplier on the kind's size curve
   *   life        multiplier on the kind's lifetime
   *   alpha       multiplier on the kind's peak alpha
   *   groundY     floor height for LANDS particles
   *   tag         payload passed to the landing callback
   *   orbit/radial/cx/cz  vortex parameters (see PFLAG.ORBIT)
   *   drag/gravity/turbulence  overrides
   */
  burst(kindName, o) {
    const K = KINDS[kindName];
    if (!K) return 0;
    const P = this.P;
    const rng = this.rng;
    const s = this.spawn;
    const count = o.count | 0;
    if (count <= 0) return 0;

    // ---- direction basis -------------------------------------------------
    let dx = o.dx ?? 0, dy = o.dy ?? 1, dz = o.dz ?? 0;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    basis(dx, dy, dz);

    const spread = o.spread ?? 0.5;
    const flatten = o.flatten ?? 0;
    const speed = o.speed ?? 1;
    const speedVar = o.speedVar ?? 0.35;
    const radius = o.radius ?? 0;
    const rise = o.rise ?? 0;

    const col = o.color ?? WHITE;
    const inten = o.intensity ?? 1;
    const sizeMul = o.size ?? 1;
    const lifeMul = o.life ?? 1;
    const alphaMul = o.alpha ?? 1;

    s.additive = K.additive;
    s.tile = K.tile;
    s.mode = o.mode ?? K.mode;
    s.drag = o.drag ?? K.drag;
    s.gravity = o.gravity ?? K.gravity;
    s.turbulence = o.turbulence ?? K.turbulence;
    s.fadeIn = o.fadeIn ?? K.fadeIn;
    s.fadeOut = o.fadeOut ?? K.fadeOut;
    s.softness = o.softness ?? K.softness;
    s.stretch = K.stretch ?? 0;
    s.flags = (K.flags ?? 0) | (o.flags ?? 0);
    s.groundY = o.groundY ?? -1e9;
    s.tag = o.tag ?? 0;
    s.orbit = o.orbit ?? 0;
    s.radial = o.radial ?? 0;
    if (s.orbit !== 0) s.flags |= PFLAG.ORBIT;

    let emitted = 0;
    for (let i = 0; i < count; i++) {
      // ---- direction inside the cone ------------------------------------
      // Uniform on the spherical cap, then optionally flattened into a sheet.
      const cosMax = Math.cos(spread);
      const ct = 1 - rng.float() * (1 - cosMax);
      const st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const ph = rng.float() * Math.PI * 2;
      let ux = Math.cos(ph) * st;
      let uy = Math.sin(ph) * st * (1 - flatten);
      const uz = ct;

      const vxl = TMP_BASIS.ax * ux + TMP_BASIS.bx * uy + dx * uz;
      const vyl = TMP_BASIS.ay * ux + TMP_BASIS.by * uy + dy * uz;
      const vzl = TMP_BASIS.az * ux + TMP_BASIS.bz * uy + dz * uz;

      const sp = speed * (1 + rng.signed() * speedVar);

      s.x = o.x + (radius ? rng.signed() * radius : 0);
      s.y = o.y + (radius ? rng.signed() * radius : 0);
      s.z = o.z + (radius ? rng.signed() * radius : 0);
      s.vx = vxl * sp;
      s.vy = vyl * sp + rise;
      s.vz = vzl * sp;

      s.life = rng.range(K.life[0], K.life[1]) * lifeMul;
      s.size0 = rng.range(K.size0[0], K.size0[1]) * sizeMul;
      s.size1 = rng.range(K.size1[0], K.size1[1]) * sizeMul;
      s.rot = o.rot ?? rng.range(0, Math.PI * 2);
      s.spin = K.spin ? rng.range(K.spin[0], K.spin[1]) : 0;
      s.seed = rng.range(0, 100);
      s.alpha = K.alpha * alphaMul;

      // Per-particle colour jitter. Without it a burst is a single flat hue and
      // reads as one sprite drawn many times; +-8% of value is enough.
      const j = 1 + rng.signed() * 0.09;
      s.r = col[0] * inten * j;
      s.g = col[1] * inten * j;
      s.b = col[2] * inten * j;

      s.cx = o.cx ?? s.x;
      s.cz = o.cz ?? s.z;

      if (P.emit(s) >= 0) emitted++;
    }
    return emitted;
  }

  /**
   * Emit around a circle in the XZ plane, with velocities pointing outward.
   * Shockwave debris, nova fronts, extraction gathers.
   */
  ring(kindName, o) {
    const K = KINDS[kindName];
    if (!K) return 0;
    const rng = this.rng;
    const count = o.count | 0;
    const radius = o.radius ?? 1;
    const speed = o.speed ?? 2;
    const inward = o.inward ? -1 : 1;
    let emitted = 0;
    // A tiny per-particle angular jitter — a perfectly even ring reads as a
    // procedural artefact, which it is.
    const step = (Math.PI * 2) / Math.max(1, count);
    const sub = this._inherit(this._sub, o);
    sub.count = 1;
    sub.spread = o.spread ?? 0.25;
    sub.speed = speed;
    sub.speedVar = o.speedVar ?? 0.3;
    sub.rise = o.rise ?? 0;
    sub.radius = 0;
    sub.cx = o.cx ?? o.x;
    sub.cz = o.cz ?? o.z;
    for (let i = 0; i < count; i++) {
      const a = i * step + rng.signed() * step * 0.42 + (o.phase ?? 0);
      const ca = Math.cos(a), sa = Math.sin(a);
      const rr = radius * (1 + rng.signed() * (o.radiusVar ?? 0.12));
      sub.x = o.x + ca * rr;
      sub.y = o.y + (o.yVar ? rng.range(0, o.yVar) : 0);
      sub.z = o.z + sa * rr;
      sub.dx = ca * inward; sub.dy = o.dy ?? 0.15; sub.dz = sa * inward;
      emitted += this.burst(kindName, sub);
    }
    return emitted;
  }

  /**
   * Emit up a vertical cylinder — the extraction column, the monarch aura.
   * `t0`/`t1` are normalised heights so a caller can fill only part of it.
   */
  column(kindName, o) {
    const rng = this.rng;
    const count = o.count | 0;
    const height = o.height ?? 2;
    let emitted = 0;
    const sub = this._inherit(this._sub, o);
    sub.count = 1;
    sub.dx = 0; sub.dy = 1; sub.dz = 0;
    sub.spread = o.spread ?? 0.35;
    sub.speed = o.speed ?? 0.6;
    sub.speedVar = o.speedVar ?? 0.5;
    sub.radius = 0;
    sub.cx = o.x; sub.cz = o.z;
    for (let i = 0; i < count; i++) {
      const t = (o.t0 ?? 0) + rng.float() * ((o.t1 ?? 1) - (o.t0 ?? 0));
      const a = rng.range(0, Math.PI * 2);
      const rr = (o.radius ?? 0.5) * Math.sqrt(rng.float()) * (o.taper ? 1 - t * o.taper : 1);
      sub.x = o.x + Math.cos(a) * rr;
      sub.y = o.y + t * height;
      sub.z = o.z + Math.sin(a) * rr;
      emitted += this.burst(kindName, sub);
    }
    return emitted;
  }
}

const WHITE = [1, 1, 1];
