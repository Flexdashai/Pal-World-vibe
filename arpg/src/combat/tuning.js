/**
 * MONARCH — combat tuning constants.
 *
 * Everything a designer would want to move lives here rather than being buried
 * in the systems that consume it. Every value carries the reason it is what it
 * is, because "0.062" with no note is a number nobody dares change later.
 *
 * Units: seconds, metres, metres/second. Damage is in the same scale as
 * `player/stats.js` (`stats.damage` ≈ 32 at level 1, `stats.shadowPower` ≈ 43),
 * so a 1.0 scaling multiplier on a skill means "one autoattack's worth".
 */

/* ==================================================================== */
/* IMPACT — the part that matters most                                  */
/* ==================================================================== */

/**
 * A landed hit must produce, within ~120 ms: hit-stop, camera shake + a
 * directional impulse, a hit flash on the target, a particle burst and decal
 * from `fx`, a stagger or knockback with real recovery, a damage number, and an
 * audio transient. Miss one and the hit reads as weightless.
 *
 * The hard part is not producing them — it is producing them ONCE. A nova that
 * strikes twelve targets on one frame must not fire twelve hit-stops, twelve
 * shakes and twelve rumbles; that reads as a stutter and a mush, not as power.
 * `impact.js` aggregates per frame and rate-limits per event; these are the
 * knobs it uses.
 */
export const IMPACT = {
  /**
   * Hit-stop duration = base + severity·span, where severity is the fraction of
   * the target's max health removed by the blow, clamped.
   *
   * 26 ms is the floor because below ~1.5 frames at 60 Hz the freeze is not
   * perceptible, it only makes the frame timing irregular. The cap is
   * `config.hitstopMax` (140 ms) and the engine clamps to it independently —
   * this span is chosen so only a genuinely huge blow (a finisher crit, the
   * domain's opening pulse) ever reaches it.
   */
  hitstopBase: 0.026,
  hitstopSpan: 0.085,
  /** Time scale during a hit-stop. Not 0: a dead-frozen frame loses the
   *  particle motion that tells you the freeze is deliberate. 0.045 still reads
   *  as a stop while letting the FX crawl. */
  hitstopScale: 0.045,
  /**
   * Minimum wall-clock gap between hit-stops. THE anti-mush number.
   *
   * The primary combo lands at ~0.20 s intervals; at 0.16 s a flurry gets one
   * stop per swing, which is right. Anything faster (a nova's twelve
   * simultaneous hits, a domain pulse) collapses into a single stop whose
   * duration is taken from the BIGGEST hit in the group, so a group of small
   * hits does not out-freeze one large one.
   */
  hitstopRefractory: 0.16,
  /** A crit is worth 40% more freeze — the single clearest "that one mattered"
   *  signal available, and it costs nothing. */
  hitstopCrit: 1.4,

  /** Camera shake amplitude = base + severity·span, summed across the frame and
   *  then clamped. `config.shakeMax` is 1.0 and a 1.0 shake is violent, so a
   *  normal hit sits around 0.10-0.22. */
  shakeBase: 0.075,
  shakeSpan: 0.34,
  /** Shake never exceeds this in one frame no matter how many hits landed —
   *  otherwise an AoE into a horde makes the frame unreadable. */
  shakeFrameMax: 0.62,
  /** Duration and frequency. Short and fast for a blade, long and slow for an
   *  explosion; `impact.js` lerps between these two by the hit's "weight". */
  shakeFastDuration: 0.13, shakeFastFreq: 34,
  shakeHeavyDuration: 0.46, shakeHeavyFreq: 15,

  /** Camera impulse — a translational punch along the hit direction. Kept far
   *  smaller than the shake: it is a nudge that sells the direction, and past
   *  ~0.3 it becomes motion sickness. */
  impulseBase: 0.045,
  impulseSpan: 0.16,
  impulseFrameMax: 0.30,

  /** How long the white hit-flash on a struck actor lasts. Two frames at 60 Hz.
   *  Longer and the enemy looks like it is glowing rather than being hit. */
  flashLife: 0.09,
  /** Sparks per hit and the per-frame cap. The cap exists because a nova into a
   *  horde would otherwise blow the particle budget on one frame. */
  sparksPerHit: 7,
  sparkFrameCap: 64,

  /** Knockback impulse (m/s added to the target's velocity) per unit of the
   *  skill's `knockback` field, and the ceiling. 9 m/s is already a stumble
   *  backwards of nearly a metre; past ~14 enemies fly like ragdolls, which is
   *  a different (funnier) game. */
  knockbackScale: 9.0,
  knockbackMax: 14.0,

  /** Stagger recovery. A staggered actor cannot act for this long — the "real
   *  recovery" the brief asks for. Scaled by how far the blow exceeded poise. */
  staggerMin: 0.22,
  staggerMax: 0.85,

  /** Hits per frame that get the full treatment (flash + fx:impact + audio).
   *  Beyond this the damage still lands and the number still spawns, but the
   *  presentation is dropped — twenty simultaneous impact bursts are visually
   *  indistinguishable from eight and cost 2.5x. */
  fullFxPerFrame: 8,
};

/* ==================================================================== */
/* TARGETING                                                            */
/* ==================================================================== */

/**
 * Cursor-aimed with a soft snap. The design rule: the snap may CORRECT an
 * imprecise aim, never OVERRIDE a deliberate one.
 *
 * Concretely — the snap only engages inside a narrow cone, its strength falls
 * off as the square of how far off-axis the candidate is, and the total angular
 * correction is hard-capped. At the cap (7°) an enemy 6 m away is pulled 0.73 m,
 * which is about the width of one enemy: enough that a hurried click connects,
 * too little to feel like the game is playing itself.
 */
export const SNAP = {
  /** Candidates outside this half-angle from the cursor direction are ignored. */
  cone: 0.42,          // ~24°
  /** Maximum angular correction applied, radians. */
  maxAngle: 0.122,     // 7°
  /** Overall strength multiplier of the (falloff-shaped) correction. */
  strength: 0.85,
  /** Candidates further than this are never snapped to, whatever the skill's
   *  range: snapping to something off-screen is how aim-assist gets noticed. */
  maxRange: 14.0,
  /**
   * If the cursor is closer to bare ground than this (metres) from the
   * candidate's centre, no snap at all. The player is pointing AT the ground —
   * placing a nova on an empty flagstone is a legitimate, common intent.
   */
  deadZone: 0.55,
  /** Prefer a target the player already hit recently, so a combo does not walk
   *  off its victim mid-chain. Multiplier on the candidate score. */
  stickiness: 1.45,
  /** How long a target stays "sticky" after being hit. */
  stickyTime: 1.1,
};

/* ==================================================================== */
/* DAMAGE MODEL                                                         */
/* ==================================================================== */

export const DAMAGE = {
  /** ±variance on every roll. Enough that two identical hits show different
   *  numbers (which is what makes numbers worth reading) without ever making a
   *  skill feel unreliable. */
  variance: 0.085,

  /**
   * Armour mitigation follows Diablo's diminishing form:
   *   reduction = armour / (armour + k·level)
   * so armour never reaches 100% and stays meaningful at every level. k matches
   * `player/stats.js`'s own curve (52) so the player's self-mitigation and the
   * mitigation combat computes for enemies agree.
   */
  armourK: 52,
  /** Mitigation ceiling. Even a wall of plate takes 15% of the hit. */
  armourMax: 0.85,

  /** Elemental resistance is read from `target.resist[element]` (0..1) if the
   *  actor publishes one. Capped so nothing is ever fully immune. */
  resistMax: 0.80,
  /** Shadow damage against something that is itself a shadow: the Monarch's
   *  power does not turn on his own soldiers. */
  shadowFriendly: 0.0,

  /** Base crit multiplier when the source publishes no `critDamage`. */
  critDamage: 1.75,
  /** Base crit chance when the source publishes no `critChance`. */
  critChance: 0.12,

  /** Vulnerability: how much extra damage a target takes while a vulnerability
   *  window is open. Windows come from being staggered, frozen, or shadow-marked
   *  and they DO stack multiplicatively, which is the whole reason to apply a
   *  status before committing an ultimate. */
  vulnStagger: 1.25,
  vulnFrozen: 1.45,
  vulnMarked: 1.22,
  /** Ceiling on the combined vulnerability multiplier. */
  vulnMax: 2.4,

  /** Damage over time ticks at 2 Hz. Faster produces a stream of illegible
   *  small numbers; slower and a 4 s burn only shows twice. */
  dotTick: 0.5,

  /** Overkill is reported on `combat:kill` and drives the gib/explosion
   *  threshold in `fx`: overkill beyond this fraction of the victim's max
   *  health is "obliterated". */
  gibFraction: 0.55,
};

/* ==================================================================== */
/* STATUS EFFECTS                                                       */
/* ==================================================================== */

/**
 * Five statuses, each with a distinct STACKING RULE, because "everything stacks
 * to 5 and refreshes" is the tell of a status system nobody thought about:
 *
 *   burn    intensity-stacking  — stacks raise the tick damage, duration refreshes
 *   bleed   independent stacks  — each application is its own timer, they overlap
 *   chill   intensity-stacking  — at max stacks it CONVERTS into `freeze`
 *   shock   duration-stacking   — re-application extends, capped; one intensity
 *   mark    replace-if-stronger — the Monarch's mark, never diluted by re-casting
 */
export const STATUS = {
  burn: {
    element: 'fire', duration: 4.0, maxStacks: 5,
    /** Tick damage per stack, as a fraction of the applying hit's damage. */
    tickFraction: 0.085, stacking: 'intensity',
  },
  bleed: {
    element: 'physical', duration: 5.0, maxStacks: 8,
    tickFraction: 0.06, stacking: 'independent',
    /** Bleeding while moving hurts more — it rewards kiting and it is the only
     *  status whose damage depends on what the victim is doing. */
    movingMultiplier: 1.9,
  },
  chill: {
    element: 'frost', duration: 3.5, maxStacks: 4,
    tickFraction: 0, stacking: 'intensity',
    /** Movement multiplier at 1 stack; scales down linearly to maxStacks. */
    slowPerStack: 0.12,
    /** Reaching maxStacks converts the whole thing into `freeze`. */
    convertsTo: 'freeze', convertDuration: 1.5,
  },
  freeze: {
    element: 'frost', duration: 1.5, maxStacks: 1,
    tickFraction: 0, stacking: 'replace',
    /** Rooted, and takes DAMAGE.vulnFrozen extra. Shattering a frozen target
     *  (killing it while frozen) is worth a bigger fx burst. */
    root: true,
  },
  shock: {
    element: 'lightning', duration: 3.0, maxStacks: 3,
    tickFraction: 0.03, stacking: 'duration',
    /** Extra damage taken per stack. */
    amplifyPerStack: 0.09,
  },
  mark: {
    element: 'shadow', duration: 8.0, maxStacks: 3,
    tickFraction: 0, stacking: 'replace',
    /** The Monarch's mark. Amplifies damage, and guarantees the corpse can be
     *  extracted — the mechanical spine of the power fantasy: mark, kill, raise. */
    amplifyPerStack: 0.07,
    guaranteeExtract: true,
  },
};

/** Which status a given element applies by default when a skill does not name
 *  one explicitly. `physical` deliberately applies nothing — a plain sword swing
 *  covered in status icons is Diablo's mistake, not its lesson. */
export const ELEMENT_STATUS = {
  fire: 'burn', frost: 'chill', lightning: 'shock', shadow: 'mark',
  physical: null, holy: null,
};

/* ==================================================================== */
/* VFX                                                                  */
/* ==================================================================== */

/**
 * Effect timings. Every effect is an explicit phase timeline —
 * anticipation (ease in) → strike (step) → bloom-out (expo out) →
 * dissipation (ease out) — and WITHIN one effect the core, ring, embers, smoke
 * and light each run their own duration, roughly 1x / 2.5x / 6x / 10x / 3x.
 * Sharing one timeline is what makes an effect read as a single sprite scaling
 * up, which is the single clearest tell of a hobby project.
 */
export const VFX = {
  /** Global multiplier on every additive emissive in this subsystem. Exists so
   *  the whole combat layer can be dimmed in one place if the frame's
   *  luminance-weighted saturation drifts above the 0.30 target. */
  gain: 1.0,

  cleave: {
    /** Arc ribbon: sweeps, then thins and lifts. */
    arcLife: 0.34, arcSweep: 0.11,
    sparkLife: 0.55, smokeLife: 0.9,
    lightLife: 0.22, lightPeak: 1.0,
    /** The finisher's extra ring + ground crack. */
    finisherLife: 0.72,
  },

  nova: {
    anticipation: 0.20, strike: 0.045, bloom: 0.34, dissipate: 0.95,
    /** Total life is the sum; the light and the scar outlive the core. */
    ringLife: 0.62, scarLife: 1.5, spireLife: 0.85, emberLife: 1.5,
    lightLife: 0.55,
    /** Peak radiance multiplier at the strike frame. Deliberately far above the
     *  final brightness — the "white-hot core" of the strike phase. */
    strikeGain: 5.2,
  },

  spear: {
    speed: 34.0, life: 2.0, trailLife: 0.30, impactLife: 0.55,
  },

  domain: {
    /** The ultimate's timeline, in seconds from the cast. It is long on purpose:
     *  this is the game's showpiece and it must be legible, not a flash. */
    scribe: 0.55,      // the rune plate draws itself outward
    erupt: 0.22,       // the dome and pillars shoot up
    hold: 5.0,         // the domain stands
    collapse: 1.2,     // it folds back into the Monarch
    /** Damage pulses while it stands. */
    pulseInterval: 0.75,
    radius: 13.5,
  },
};

/** Emissive gain fed to `render`'s bloom-only buffer (`mesh.userData.mnGlow`).
 *  Tuned by capture: at 3.0 the nova core bloomed into a disc wide enough to
 *  erase the hero standing in the middle of it. */
export const GLOW = {
  core: 2.1,
  ring: 1.7,
  scar: 1.15,
  spark: 2.4,
  trail: 1.6,
  dome: 1.35,
  rune: 2.2,
  column: 2.0,
};

/** Clamp helper used everywhere in this subsystem. Local so nothing here has to
 *  import THREE just for MathUtils. */
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
/** Smoothstep, the workhorse easing. */
export function smooth(t) { const x = clamp01(t); return x * x * (3 - 2 * x); }
/** Expo out — the bloom-out phase's curve. */
export function expoOut(t) { const x = clamp01(t); return 1 - Math.pow(2, -9 * x); }
/** Ease in (quadratic) — the anticipation phase's curve. */
export function easeIn(t) { const x = clamp01(t); return x * x; }
/** Ease out (cubic) — dissipation. */
export function easeOut(t) { const x = clamp01(t); const i = 1 - x; return 1 - i * i * i; }
