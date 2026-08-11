/**
 * MONARCH — `fx` tuning constants.
 *
 * `config.q` owns BUDGETS (how many particles may exist), `palette.js` owns
 * COLOUR. This file owns the third category: the *timing* of every effect, which
 * is what actually decides whether a hit feels like a hit.
 *
 * ---------------------------------------------------------------------------
 * THE PHASE MODEL, WHICH EVERY NUMBER BELOW SERVES
 *
 * ARCHITECTURE.md is explicit that a linear fade is the clearest tell of a hobby
 * project, and that every significant effect is an explicit timeline:
 *
 *   anticipation  80-220 ms   ease in    energy gathers
 *   strike        16-50 ms    step       white-hot core far above final value
 *   bloom-out     120-350 ms  expo out   shockwave expands and thins
 *   dissipation   400-900 ms  ease out   embers drift, smoke curls, light decays
 *
 * and that within ONE effect the core / ring / embers / smoke / light each run on
 * their own duration, roughly 1x / 2.5x / 6x / 10x / 3x. Every `LIFE` table here
 * is written as that ratio family, and every light envelope peaks about one frame
 * BEFORE its visual so the illumination leads rather than follows.
 *
 * Values were tuned by capturing at 960x540 and reading the frame, not by
 * guessing; where a number is surprising the comment says what it is fixing.
 */

/** Seconds. The reference beat every other duration is expressed against — one
 *  "impact frame" at 60 Hz is 16.7 ms and a strike must last 1-3 of them. */
export const FRAME = 1 / 60;

export const FX = {
  /**
   * Particle pool split. Additive carries embers, sparks, energy and glyphs;
   * alpha carries smoke, dust, blood and chips.
   *
   * 0.58/0.42 rather than 50/50 because the shadow set is almost entirely
   * additive and it is the effect that must never run out of budget.
   */
  pools: { additive: 0.58, alpha: 0.42 },

  /**
   * Hard cap on the number of particles SIMULATED per frame regardless of the
   * quality budget.
   *
   * This container rasterises on the CPU, and a particle is pure fill: a 0.4 m
   * quad at the 21 m camera distance covers ~350 px at 720p, so 4000 live
   * particles is ~1.4 million shaded fragments — two full screens of overdraw on
   * top of everything else. The budget in `config.q` is what a GPU could afford;
   * this is what keeps every other agent's capture loop usable. Raising it is
   * safe on real hardware.
   */
  softwareCap: 2600,

  /**
   * Soft-particle fade distance in metres. A particle within this distance of
   * the opaque surface behind it fades out, which is what stops the hard
   * intersection line where smoke meets the floor.
   *
   * 0.55 m: below ~0.3 m the line is still visible on a 0.5 m puff; above ~0.8 m
   * a puff resting on the floor loses its whole lower half and starts to look
   * like it is hovering.
   */
  softFade: 0.55,

  /** Light pool. Four simultaneous fx lights: a nova, two impacts and an
   *  extraction can all be live at once, which is the realistic worst case in a
   *  fight. Every one is created in `init()` so the slot count freezes with them
   *  counted — see ARCHITECTURE.md on the point-light permutation trap. */
  lights: {
    count: 4,
    /** Multiplier applied to every fx light. `sky` feeds its volumetric march
     *  from the two highest-scoring point lights about the camera focus, and the
     *  focus IS the player — so a permanently bright fx light would evict both
     *  braziers from the fog solution. Effect lights are therefore bright but
     *  SHORT: the fog bloom they cause lasts a few frames and reads as the blast
     *  lighting the air, which is what we want. */
    gain: 1.0,
    /** Seconds by which the light envelope leads the visual. One frame, exactly
     *  as ARCHITECTURE.md specifies. */
    lead: FRAME,
  },

  /**
   * Decals. `q.decalBudget` is the ceiling; we allocate the smaller of that and
   * `cap` because every decal is a lit, shadow-receiving, transparent quad and
   * on a software rasteriser 512 of them is measurable. The pool is a ring with
   * LRU eviction, and the oldest 15% fade out under pressure so a recycled slot
   * never pops.
   */
  decals: {
    cap: 192,
    /** Seconds a decal lives before it begins to fade. Blood in Diablo persists
     *  for the whole fight — that persistence IS the record of the fight. */
    life: 75,
    fade: 12,
    /** Fraction of the pool that must be in use before the oldest decals start
     *  fading early. */
    pressure: 0.82,
    /** Metres above the surface a decal is offset along its normal. Small
     *  enough to stay glued at this camera distance, large enough to beat the
     *  depth precision of a 1..140 m frustum on a 24-bit buffer. */
    lift: 0.012,
    /** A decal is skipped when the surface under it varies by more than this
     *  many metres across its own radius — the test that stops a blood pool
     *  from floating across a step. */
    flatness: 0.22,
  },

  /** Ribbons: weapon swings, projectile trails, dashes, shadow-soldier tails. */
  ribbons: {
    count: 16,
    /** Samples per ribbon. 20 is enough for a 180-degree sword arc to read as a
     *  smooth sheet at this camera distance; 32 costs 60% more vertices for a
     *  difference nobody can see at 120 px of character height. */
    segments: 20,
    /** Metres a ribbon must travel before a new sample is laid down. Without
     *  this a stationary emitter piles every sample on one point and the ribbon
     *  collapses into a bright dot. */
    minStep: 0.045,
  },

  /**
   * Impact timings, shared by every surface. The per-surface recipes vary
   * counts, colours and speeds — never these.
   */
  impact: {
    /** The white-hot core: two frames, stepped, then gone. */
    strike: 2 * FRAME,
    /** Ring / shockwave — 2.5x the core. */
    ring: 0.18,
    /** Sparks and chips — 6x. */
    debris: 0.55,
    /** Smoke and dust — 10x. */
    smoke: 1.1,
    /** Light — 3x, and it leads. */
    light: 0.22,
    /** Minimum seconds between two impacts at the same point being drawn in
     *  full. A six-hit flurry on one target must not spawn six identical
     *  bursts, or the frame turns to soup. */
    coalesce: 0.055,
  },

  /**
   * Blood. Diablo is a blood game; these numbers are deliberately generous.
   */
  blood: {
    /** Arterial spray speed, metres/second, at magnitude 1. Fast enough to arc
     *  clear of the body, slow enough that the arc is legible over ~0.5 s. */
    speed: 7.4,
    /** Half-angle of the spray cone, radians. Blood from a slash is a SHEET, not
     *  a sphere: the cone is wide across the cut and narrow along it, which the
     *  emitter does by scaling the tangent basis anisotropically. */
    cone: 0.62,
    spread: 2.1,
    /** Gravity multiplier on droplets. Above 1 because blood is denser than the
     *  air-drag model assumes and a droplet that floats reads as paint. */
    gravity: 1.35,
    /** Seconds a droplet lives before it either lands or is culled. */
    life: 1.5,
    /** Fraction of droplets that leave a decal when they cross the floor. All
     *  of them would exhaust the decal pool in one fight. */
    decalChance: 0.50,
    /** Seconds for a corpse pool to reach full size. */
    poolGrow: 3.6,
    /** How long weapon blood takes to dry, seconds. */
    weaponDry: 9.0,
  },

  /**
   * THE SHADOW SET. The signature of the game, so its timeline is the most
   * carefully specified thing in this file.
   *
   * Total default duration 1.55 s, split:
   *   0.00-0.30  anticipation  ground rune scribes, motes converge inward
   *   0.30-1.05  dissolve      the body rises as embers into a violet column
   *   1.05-1.09  strike        collapse to a white-violet core, peak light
   *   1.09-1.55  arise         silhouette resolves, shockwave, embers blow out
   */
  extract: {
    duration: 1.55,
    anticipation: 0.30,
    dissolve: 0.75,
    strike: 3 * FRAME,
    arise: 0.46,
    /** Radius the converging motes start from, metres. */
    gather: 2.3,
    /** Height the column reaches, metres. Taller than a person on purpose — the
     *  beat has to read from the top of a 21 m isometric frame — but not much
     *  taller: at the 5.5 m the first draft reached (4.2 scaled by rank) the
     *  column left frame and became a vertical white bar. */
    column: 3.1,
    /**
     * Peak light intensity, candela-ish, at the strike.
     *
     * 34 against a brazier's 26, at a 9.5 m radius rather than a brazier's 11.
     * MEASURED, and this number matters more than it looks: `sky` builds its
     * volumetric fog solution from the two highest-scoring point lights about
     * the CAMERA FOCUS, scored as intensity/(1+d^2) — and an extraction happens
     * at the focus by definition. At the 96 the first draft used, the strike
     * evicted both braziers from the fog solution and lit the fog volume
     * standing between the lens and the subject, turning the whole frame into a
     * violet fog bank. The extraction must be the brightest thing IN the room,
     * not brighter than the room.
     */
    peak: 34,
    /** Embers rise, they never fall. This is the single strongest read in the
     *  anime and it is a NEGATIVE gravity, not a low one. */
    rise: 2.1,
    /** Tangential swirl, radians/second, at 1 m radius. */
    swirl: 3.4,
  },

  /** The monarch aura: a standing column of violet with orbiting glyphs. */
  aura: {
    /** Radius of the light column, metres. 0.52, not the 1.15 the first draft
     *  used: a 2.3 m tube around a 0.72 m character is a fog machine, and it
     *  hid the hero it exists to glorify. */
    radius: 0.52,
    height: 2.9,
    glyphs: 6,
    /** Radians/second the glyph ring orbits. Slow — a fast orbit reads as a
     *  loading spinner. */
    orbit: 0.55,
    /** Seconds for the aura to ramp in and out. */
    ramp: 0.45,
  },

  /** Shadow soldier trails. Every shadow soldier has one; it is most of what
   *  makes a black silhouette read as *shadow* rather than as an unlit mesh. */
  shadowTrail: {
    life: 0.55,
    width: 0.34,
    /** Embers shed per second while moving. */
    emberRate: 9,
  },

  /** Spell VFX. Radii are multipliers on the event's own radius. */
  spell: {
    novaRing: 0.42,      // seconds for the ground ring to reach full radius
    novaLife: 0.72,
    beamLife: 0.30,
    projectileGlow: 0.9,
  },

  /**
   * Screen-space impulse pass. Runs in DISPLAY space after the composite, and
   * is disabled entirely (zero cost) whenever its energy is below `epsilon`.
   */
  screen: {
    epsilon: 0.004,
    /** Maximum radial UV push at full energy. 0.006 of screen height — beyond
     *  ~0.01 it stops reading as impact and starts reading as a broken lens. */
    push: 0.0062,
    /** Chromatic separation at full energy, in UV. */
    chroma: 0.0034,
    /** Seconds an impulse takes to decay. */
    decay: 0.24,
    /** Shockwave ripple travel time across the screen, seconds. */
    waveTime: 0.42,
  },

  /** Hit flash on a struck actor: a brief emissive ramp on their material. */
  flash: {
    /** Seconds. Three frames — long enough to survive a 60 Hz shutter, short
     *  enough that a flurry does not leave enemies permanently glowing. */
    life: 3 * FRAME,
    /** Peak emissive intensity added on top of whatever the material had. */
    peak: 2.4,
    critPeak: 4.2,
  },

  /** Gibs: physics-driven chunks on a killing blow. */
  gibs: {
    count: 5,
    speed: 5.2,
    lift: 0.55,
    lifetime: 6.0,
  },
};

/* ---------------------------------------------------------------------------
 * Easing. Named after the phase they serve so call sites read as the timeline.
 * ------------------------------------------------------------------------- */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Anticipation: slow start, accelerating. */
export const easeIn = (t) => t * t * t;
/** Bloom-out: violent start, long settle. The workhorse for a shockwave. */
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t));
/** Dissipation. */
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeOutQuad = (t) => t * (2 - t);
export const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * The strike curve: a hard step up, then an exponential collapse.
 * `t` is normalised over the whole effect, `k` is where the strike lands.
 */
export function strikeCurve(t, k = 0.0) {
  if (t < k) return 0;
  const u = (t - k) / (1 - k);
  return Math.pow(1 - u, 5);
}

/**
 * The canonical light envelope: fast attack, slower release, peaking `lead`
 * seconds before the visual it belongs to.
 *
 * A spell whose light snaps on and off with its sprite does not illuminate
 * anything and the eye notices — this is the function that stops that.
 */
export function lightEnvelope(age, attack, release) {
  if (age < 0) return 0;
  if (age < attack) return easeOutQuad(age / attack);
  const u = (age - attack) / Math.max(1e-4, release);
  return u >= 1 ? 0 : Math.pow(1 - u, 2.4);
}
