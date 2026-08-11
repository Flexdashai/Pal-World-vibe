/**
 * MONARCH — `ai` tuning.
 *
 * Every number a designer would want to move, in one file, with the reason it
 * has the value it has. Nothing in this directory hardcodes a duration, a
 * distance or a damage figure; they all come from here so a balance pass is one
 * file and a diff, not an archaeology exercise.
 *
 * The three rules that produced most of these values:
 *
 *  1. **A wind-up must be longer than a human reaction time.** 250 ms is the
 *     floor for "I saw it and chose to dodge"; anything under ~180 ms reads as
 *     unfair even when it is technically dodgeable. Every telegraphed attack in
 *     this file has a wind-up of at least 0.42 s, and the heavy ones run to 1.1.
 *
 *  2. **Recovery is the window the player is being paid with.** An attack whose
 *     recovery is shorter than the player's own swing means there is never a
 *     safe moment, and the fight becomes a stat check. Recovery is therefore
 *     always ≥ 0.55 × wind-up, and the heavy attacks give back a full second.
 *
 *  3. **Distances are read off the isometric frame, not invented.** At the
 *     21 m boom with a 34° vertical FOV, the visible ground runs about 5 m
 *     down-screen of the focus and 12 m up-screen of it. An enemy that starts
 *     its approach at 30 m is off-screen and its approach is invisible; the
 *     aggro radius is therefore 15 m, which is "just inside the frame".
 */

/** Faction names. The shared vocabulary from ARCHITECTURE.md's actor interface;
 *  `combat/resolve.js` derives its hostile filter from exactly these strings. */
export const FACTION = { enemy: 'enemy', player: 'player' };

/* ==========================================================================
 * ARCHETYPES
 * ==========================================================================
 *
 * `silhouette` is not documentation — it is the acceptance criterion. Render the
 * archetype as a solid black shape; if the description does not survive, the
 * body is wrong and gets rebuilt, not retextured.
 */
export const ARCHETYPES = {
  /* ---------------------------------------------------------------------- */
  ghoul: {
    id: 'ghoul', name: 'Risen Ghoul', rank: 'common', plan: 'biped',
    silhouette: 'a forward-leaning hook — head thrust below the shoulder line, ' +
      'arms hanging past the knees, one shoulder collapsed. Narrow and asymmetric.',
    height: 1.78, radius: 0.36, weight: 1.0, mass: 62,
    voice: 'ghoul', surface: 'bone',
    hp: 96, hpPerLevel: 26, armour: 6, armourPerLevel: 1.6, poise: 18,
    damage: 15, damagePerLevel: 3.4,
    speedWalk: 1.30, speedRun: 3.55, accel: 9.0, turnRate: 5.0,
    aggro: 15.0, leash: 34.0, attackRange: 1.85, preferRange: 0.0,
    windup: 0.44, strike: 0.10, recover: 0.46, cooldown: 0.95,
    stagger: 16, knockback: 0.30,
    /** Fraction of the pack allowed to attack at once — the rest circle. This
     *  single number is what stops forty ghouls becoming a damage blender. */
    engageFraction: 0.55,
    ringRadius: 1.55, ringSlots: 9,
    dismemberable: true, gibThreshold: 0.30,
    xpRank: 'common',
  },

  /* ---------------------------------------------------------------------- */
  knight: {
    id: 'knight', name: 'Cathedral Revenant', rank: 'elite', plan: 'biped',
    silhouette: 'a wide upright rectangle — square pauldrons past the elbows, a ' +
      'tower shield filling the left half, a two-hand sword held vertical.',
    height: 1.98, radius: 0.46, weight: 2.4, mass: 140,
    voice: 'knight', surface: 'metal',
    hp: 240, hpPerLevel: 54, armour: 60, armourPerLevel: 11, poise: 62,
    damage: 26, damagePerLevel: 6.0,
    speedWalk: 1.15, speedRun: 2.85, accel: 6.0, turnRate: 2.6,
    aggro: 16.0, leash: 30.0, attackRange: 2.45, preferRange: 0.0,
    windup: 0.78, strike: 0.12, recover: 0.86, cooldown: 1.8,
    stagger: 46, knockback: 0.85,
    engageFraction: 1.0,
    ringRadius: 2.1, ringSlots: 6,
    dismemberable: false, gibThreshold: 0.75,
    xpRank: 'elite',
    /** Blocking. A shield that only reduces damage is invisible; one that also
     *  makes the enemy IGNORE knockback is felt immediately. */
    block: { arc: 1.15, reduction: 0.72, poiseBonus: 55, breakOnHeavy: 90 },
    /** The parry window opens at the very start of the block and rewards the
     *  player for attacking into a raised shield with a counter, not with a
     *  free hit. */
    parry: { window: 0.30, cooldown: 4.0, counterDamage: 1.7, counterStagger: 90 },
    /** The heavy overhead. Long enough to see, punishing enough to matter. */
    heavy: { windup: 1.10, strike: 0.14, recover: 1.05, range: 3.3, halfWidth: 0.95,
      damage: 2.1, stagger: 130, knockback: 1.8, cooldown: 6.5, telegraph: 'line' },
  },

  /* ---------------------------------------------------------------------- */
  beast: {
    id: 'beast', name: 'Crypt Stalker', rank: 'common', plan: 'quadruped',
    silhouette: 'horizontal — a long arched spine on four legs, shoulders higher ' +
      'than the head, a whip tail as long as the body. Nothing else in the game ' +
      'is wider than it is tall.',
    height: 1.05, radius: 0.42, weight: 1.2, mass: 74,
    voice: 'beast', surface: 'flesh',
    hp: 118, hpPerLevel: 27, armour: 10, armourPerLevel: 2.2, poise: 22,
    damage: 17, damagePerLevel: 3.8,
    speedWalk: 2.0, speedRun: 6.4, accel: 16.0, turnRate: 7.5,
    aggro: 18.0, leash: 40.0, attackRange: 1.9, preferRange: 5.5,
    windup: 0.34, strike: 0.08, recover: 0.40, cooldown: 1.1,
    stagger: 14, knockback: 0.35,
    engageFraction: 0.7,
    ringRadius: 4.2, ringSlots: 7,
    dismemberable: true, gibThreshold: 0.35,
    xpRank: 'common',
    /** The leap: a real ballistic arc, not a dash. The apex height is what makes
     *  it read from an isometric camera — a flat lunge is invisible from above. */
    leap: { windup: 0.52, range: 9.0, minRange: 4.0, speed: 12.5, apex: 2.3,
      damage: 1.45, stagger: 42, knockback: 1.1, recover: 0.55, cooldown: 4.2,
      telegraph: 'line' },
  },

  /* ---------------------------------------------------------------------- */
  caster: {
    id: 'caster', name: 'Ash Cantor', rank: 'elite', plan: 'biped',
    silhouette: 'a tall narrow flame — no legs visible under a torn hem, a ' +
      'high pointed hood, both arms raised holding a bent staff across the body.',
    height: 2.02, radius: 0.38, weight: 0.9, mass: 58,
    voice: 'wraith', surface: 'cloth',
    hp: 132, hpPerLevel: 30, armour: 8, armourPerLevel: 1.8, poise: 14,
    damage: 20, damagePerLevel: 4.6,
    speedWalk: 1.15, speedRun: 2.9, accel: 7.0, turnRate: 3.6,
    aggro: 20.0, leash: 34.0, attackRange: 15.0, preferRange: 11.0,
    windup: 0.62, strike: 0.10, recover: 0.70, cooldown: 2.6,
    stagger: 12, knockback: 0.15,
    engageFraction: 1.0,
    ringRadius: 11.0, ringSlots: 6,
    dismemberable: false, gibThreshold: 0.6,
    xpRank: 'elite',
    /** Kiting: back away when the player closes, never turn and run — a caster
     *  that flees is unkillable and infuriating; one that retreats two metres
     *  and keeps casting is a positioning puzzle. */
    kite: { minRange: 6.5, retreatSpeed: 0.72, sidestep: 0.55 },
    /** THE CHANNEL. Six seconds, interruptible by any stagger. The payoff is
     *  large enough that ignoring it is a mistake and the wind-up is long enough
     *  that reaching the caster is always possible. */
    channel: { duration: 3.4, tickInterval: 0.55, tickDamage: 0.42, radius: 5.0,
      cooldown: 11.0, telegraph: 'circle', interruptStagger: 10 },
  },

  /* ---------------------------------------------------------------------- */
  brute: {
    id: 'brute', name: 'Ossuary Brute', rank: 'elite', plan: 'biped',
    silhouette: 'an inverted triangle — shoulders wider than the figure is tall ' +
      'below them, a head sunk between them, one arm twice the mass of the other ' +
      'dragging a maul whose head touches the floor.',
    height: 2.62, radius: 0.62, weight: 4.0, mass: 260,
    voice: 'beast', surface: 'flesh',
    hp: 380, hpPerLevel: 86, armour: 34, armourPerLevel: 7, poise: 96,
    damage: 34, damagePerLevel: 8.0,
    speedWalk: 1.05, speedRun: 2.5, accel: 4.4, turnRate: 1.9,
    aggro: 15.0, leash: 26.0, attackRange: 3.0, preferRange: 0.0,
    windup: 0.92, strike: 0.14, recover: 1.05, cooldown: 2.7,
    stagger: 80, knockback: 1.5,
    engageFraction: 1.0,
    ringRadius: 2.6, ringSlots: 4,
    dismemberable: false, gibThreshold: 0.9,
    xpRank: 'elite',
    /** The slam. Circle telegraph, stuns on hit. The stun is the reason this
     *  archetype exists: it is the only enemy that can take the player's turn
     *  away, so it must be the most clearly signposted thing in the game. */
    slam: { windup: 1.15, strike: 0.12, recover: 1.25, radius: 4.4,
      damage: 1.8, stagger: 200, knockback: 2.2, stun: 1.05, cooldown: 7.5,
      telegraph: 'circle' },
    /** The charge — a straight-line rush that ends in the slam if it connects. */
    charge: { windup: 0.85, range: 12.0, minRange: 5.0, speed: 9.0,
      damage: 1.2, stagger: 120, knockback: 2.6, cooldown: 9.0, telegraph: 'line' },
  },

  /* ---------------------------------------------------------------------- */
  boss: {
    id: 'boss', name: 'The Reliquary Warden', title: 'Keeper of the Ash',
    rank: 'boss', plan: 'biped',
    silhouette: 'a five-metre cathedral figure — a mountain of a torso on ' +
      'buttress legs, FOUR arms (two enormous, two vestigial and folded), a ' +
      'crown of broken arch ribs, and a violet core burning in an open chest ' +
      'cavity. Read from the far side of the arena as a lit hole in a mountain.',
    height: 5.2, radius: 1.55, weight: 12.0, mass: 2400,
    voice: 'boss', surface: 'stone',
    hp: 3200, hpPerLevel: 880, armour: 120, armourPerLevel: 24, poise: 320,
    damage: 46, damagePerLevel: 11,
    speedWalk: 1.5, speedRun: 3.4, accel: 4.0, turnRate: 1.35,
    aggro: 40.0, leash: 90.0, attackRange: 5.2, preferRange: 0.0,
    windup: 0.95, strike: 0.16, recover: 1.05, cooldown: 2.4,
    stagger: 150, knockback: 2.4,
    engageFraction: 1.0,
    ringRadius: 4.2, ringSlots: 1,
    dismemberable: false, gibThreshold: 2.0,
    xpRank: 'boss',
    isBoss: true,
    arms: 4,
  },

  /* ---------------------------------------------------------------------- */
  /** The player's own. Silhouette is inherited from whatever died; every other
   *  number comes from here so a shadow is never simply a re-skinned enemy. */
  shade: {
    id: 'shade', name: 'Shadow Soldier', rank: 'shadow', plan: 'biped',
    silhouette: 'inherited from the corpse it was raised from — that is the ' +
      'point. What changes is the VALUE: near-black with a violet rim.',
    height: 1.80, radius: 0.36, weight: 1.0, mass: 60,
    voice: 'shade', surface: 'ash',
    hp: 150, hpPerLevel: 34, armour: 14, armourPerLevel: 3.2, poise: 26,
    damage: 18, damagePerLevel: 4.4,
    speedWalk: 1.9, speedRun: 5.6, accel: 14.0, turnRate: 7.0,
    aggro: 17.0, leash: 999, attackRange: 2.0, preferRange: 0.0,
    windup: 0.30, strike: 0.08, recover: 0.30, cooldown: 0.78,
    stagger: 22, knockback: 0.35,
    engageFraction: 1.0,
    ringRadius: 1.7, ringSlots: 10,
    dismemberable: false, gibThreshold: 2.0,
    xpRank: 'shadow',
    isShadow: true,
  },
};

/** Iteration order for anything that walks every archetype. Bosses last so a
 *  budget that runs out never runs out on the boss. */
export const ARCHETYPE_ORDER = ['ghoul', 'beast', 'knight', 'caster', 'brute', 'shade', 'boss'];

/* ==========================================================================
 * PERCEPTION
 * ========================================================================== */
export const PERCEPTION = {
  /** Field of view for SIGHT. Behind this, an enemy only notices you if you are
   *  inside `hearRadius` or you hit something. 150° rather than 110° because an
   *  isometric player is constantly circling and a narrow cone reads as blind. */
  fov: 2.62,
  /** Sight ignores the cone entirely inside this radius — something two metres
   *  behind you knows you are there. */
  closeRadius: 3.2,
  /** Combat noise radius. A cleave landing wakes everything within it. */
  hearRadius: 13.0,
  /** How long a lost target stays "remembered" before the actor gives up. */
  memory: 6.5,
  /** Seconds between line-of-sight raycasts per actor. LOS is the single most
   *  expensive thing perception does, so it is amortised: at 5 Hz with 40 actors
   *  that is 200 raycasts/second, which is nothing against the BVH. */
  losInterval: 0.21,
  /** Alert propagation: when one actor aggros it shouts, and everything within
   *  this radius wakes up over `alertDelay` (staggered, so a room does not turn
   *  as one block — that is the single clearest "spawned by a script" tell). */
  shoutRadius: 11.0,
  alertDelay: 0.55,
  alertJitter: 0.45,
};

/* ==========================================================================
 * STEERING / CROWD
 * ========================================================================== */
export const STEER = {
  /** Radius within which other actors push this one sideways. */
  avoidRadius: 1.9,
  /** How hard. Too high and the crowd explodes outward; too low and it is a
   *  single overlapping blob. Tuned by watching forty ghouls converge. */
  avoidStrength: 2.6,
  /** Anticipatory term: weight given to where the neighbour WILL be. This is
   *  what turns mutual jostling into two agents sidestepping past each other. */
  avoidLookahead: 0.42,
  /** Tangential bias, so agents that would deadlock head-on rotate around each
   *  other rather than pressing. Signed by actor id parity so it is stable. */
  avoidTangent: 0.85,
  /** Bias away from walls, sampled from the flow field's clearance channel. */
  wallStrength: 2.2,
  wallRadius: 1.1,
  /** Slow down when the agent directly ahead is closer to the target than we
   *  are. Without it a corridor produces a conga line that never widens. */
  yieldCone: 0.55,
  yieldSlow: 0.42,
  /** Smoothing on the desired direction, in seconds to converge. A steering
   *  vector applied raw makes actors twitch every frame the flow field updates. */
  smoothTime: 0.16,
  /** Maximum steering deflection per second, radians. Big enemies turn slowly
   *  and that difference is most of what makes them feel heavy. */
  maxTurn: 9.0,
  /** Separation from the target so bodies do not stand inside it. */
  personalSpace: 0.25,
};

/* ==========================================================================
 * NAVIGATION
 * ========================================================================== */
export const NAV = {
  /** Grid resolution in metres. 1.0 m is one body width — fine enough to route
   *  through a 3 m doorway, coarse enough that a 90 m level is 8 100 cells. */
  cell: 1.0,
  /** Hard cap on grid dimension so a pathological level cannot allocate a
   *  hundred megabytes. */
  maxDim: 160,
  /** Vertical tolerance when probing the floor: a step of more than this is a
   *  wall as far as navigation is concerned. */
  stepHeight: 0.55,
  /** Head clearance a cell must have to be walkable. */
  clearance: 1.9,
  /** How far a cell is from a wall before it stops being penalised. Cells within
   *  this distance cost more, which pulls paths off the walls and makes a crowd
   *  flow down the middle of a corridor. */
  wallPad: 1.6,
  wallCost: 2.4,
  /** Rebuilds of the distance field per second. The player moves at ~6 m/s and
   *  a cell is 1 m, so 6 Hz keeps the field never more than one cell stale. */
  rebuildHz: 6.0,
  /** Cells visited per rebuild before the flood is abandoned. A full 8 100-cell
   *  flood is ~30 000 visits with 8-connectivity; the cap exists so a broken
   *  level cannot hang the frame. */
  maxVisits: 60000,
  /** Distance beyond which an actor steers straight at its target rather than
   *  reading the field — for a target in the same room the field is a detour. */
  directRange: 9.0,
};

/* ==========================================================================
 * ANIMATION
 * ========================================================================== */
export const ANIM = {
  /** Blend times, seconds. */
  fadeLocomotion: 0.22,
  fadeAction: 0.09,
  fadeOut: 0.16,
  /** Speed at which the walk↔run blend completes, in metres/second, as a
   *  fraction of the archetype's run speed. */
  runBlendStart: 0.35,
  runBlendEnd: 0.92,
  /** Stride frequency scales with speed so feet do not skate. `strideBase` is
   *  cycles per second at `strideSpeed` metres/second. */
  strideBase: 1.55,
  strideSpeed: 3.5,
  /** Idle motion is never static. Breath is a slow sinusoid on the chest; the
   *  phase is per-actor so a row of skeletons does not breathe in unison. */
  breathRate: 0.42,
  breathAmount: 2.4,
  /** Secondary motion (rags, tails, chains) spring constants. */
  springStiff: 34,
  springDamp: 6.2,
  springGravity: 5.5,
  /** LOD distance bands in metres, measured from the camera focus. */
  lodNear: 15.0,
  lodMid: 27.0,
  /** Update strides per band. Band 2 poses once every four frames, which at a
   *  distance where a character is 40 px tall is genuinely invisible. */
  lodStride: [1, 2, 4],
  /** Fade the flinch additive out over this. */
  flinchDecay: 5.5,
};

/* ==========================================================================
 * TELEGRAPHS
 * ========================================================================== */
export const TELEGRAPH = {
  /** Pool sizes. Every ground indicator in the game comes out of these. */
  circles: 10,
  cones: 6,
  lines: 8,
  /** The fill sweeps 0→1 over the wind-up, then the whole thing flashes white
   *  for `flash` seconds on the strike frame and collapses. A telegraph that
   *  just fades out never tells the player the exact moment of impact. */
  flash: 0.09,
  collapse: 0.20,
  /** Height above the floor. Large enough to beat z-fighting on a 1 cm-accurate
   *  floor mesh, small enough that it still reads as painted ON the ground. */
  lift: 0.045,
  /** Edge ring thickness as a fraction of the radius. */
  edge: 0.085,
  /**
   * Base emissive radiance multiplier.
   *
   * MEASURED, not guessed. The first build ran at 2.1 with a bright fill, and
   * the boss shot came back as a blown-out white-pink slab that erased the boss
   * standing inside it — a telegraph is additive over a near-black floor, so
   * anything above ~1.2 linear clips a channel and the AgX shoulder turns the
   * whole shape white. 0.85 puts the outline at a clear ember and the fill below
   * the floor's own lit value.
   */
  intensity: 0.85,
  /**
   * Danger colour. Deliberately NOT the shadow violet: the player's magic owns
   * that hue, a telegraph in the same colour is unreadable during a nova, and
   * the whole art direction depends on violet reading as "the Monarch". Amber
   * also sits next to the braziers, so the eye already knows it means heat.
   */
  colour: [1.0, 0.30, 0.075],
  /** The boss's own telegraph runs hotter — but still amber, for the reason
   *  above, and only 1.4x rather than the 3.5x that produced the white slab. */
  bossIntensity: 1.2,
  bossColour: [1.0, 0.22, 0.10],
};

/* ==========================================================================
 * THE BOSS ENCOUNTER
 * ========================================================================== */
export const BOSS = {
  /** Phase thresholds as fractions of max health. */
  phases: [
    { at: 1.00, name: 'I', title: 'Sealed' },
    { at: 0.66, name: 'II', title: 'Cracked' },
    { at: 0.32, name: 'III', title: 'Unbound' },
  ],
  /** Seconds of invulnerable, unmoving spectacle when a phase turns. Long enough
   *  to be a beat, short enough that it never feels like a cutscene. */
  phaseBreak: 1.55,
  /** THE VULNERABILITY WINDOW. Opened by landing a heavy attack (the boss is
   *  over-committed) or by breaking its poise. The core opens, the light floods,
   *  and `vulnerable` goes true — `combat/damage.js` reads that flag directly. */
  vulnerable: { duration: 3.1, damageMul: 1.65, poiseBreak: 3.6, cooldown: 6.0 },
  /** Attack table per phase. `weight` is the pick weight; the director never
   *  plays the same attack twice running unless it is the only option. */
  attacks: {
    sweep: {
      id: 'sweep', windup: 0.86, strike: 0.18, recover: 1.10, cooldown: 3.2,
      range: 6.6, halfAngle: 0.95, damage: 1.0, stagger: 150, knockback: 2.2,
      telegraph: 'cone', weight: 3, phase: 0, opensWindow: false,
    },
    slam: {
      id: 'slam', windup: 1.20, strike: 0.16, recover: 1.55, cooldown: 6.5,
      radius: 5.6, damage: 1.55, stagger: 240, knockback: 3.0,
      telegraph: 'circle', weight: 2, phase: 0, opensWindow: true,
      shockRings: 2,
    },
    shards: {
      id: 'shards', windup: 1.05, strike: 0.12, recover: 0.95, cooldown: 7.0,
      count: 4, radius: 2.6, spread: 8.5, damage: 0.85, stagger: 60,
      telegraph: 'circle', weight: 2, phase: 1, opensWindow: false,
      /** Delay between the indicator resolving and the next one, so the player
       *  reads them as a sequence to walk out of rather than a wall. */
      stagger_: 0.34,
    },
    fissure: {
      id: 'fissure', windup: 1.15, strike: 0.14, recover: 1.20, cooldown: 8.5,
      range: 17.0, halfWidth: 1.5, damage: 1.25, stagger: 120, knockback: 1.6,
      telegraph: 'line', weight: 2, phase: 1, opensWindow: true,
    },
    summon: {
      id: 'summon', windup: 1.35, strike: 0.20, recover: 1.10, cooldown: 22.0,
      count: 4, radius: 7.0, telegraph: 'circle', weight: 1, phase: 1,
      opensWindow: false, spawn: 'ghoul',
    },
    nova: {
      id: 'nova', windup: 1.45, strike: 0.20, recover: 1.75, cooldown: 11.0,
      radius: 9.5, damage: 1.75, stagger: 260, knockback: 3.4,
      telegraph: 'circle', weight: 3, phase: 2, opensWindow: true,
      rings: 3,
    },
    flail: {
      id: 'flail', windup: 0.95, strike: 0.9, recover: 1.35, cooldown: 9.0,
      radius: 6.2, ticks: 5, damage: 0.62, stagger: 90, knockback: 1.4,
      telegraph: 'circle', weight: 2, phase: 2, opensWindow: false,
    },
  },
  /** Seconds between attacks at rest. Phase III shortens it, which is the whole
   *  reason the last third of the fight feels different. */
  cadence: [2.6, 2.1, 1.5],
  /** Distance the boss will close before attacking. It never chases forever —
   *  outside this it walks, inside it commits. */
  engageRange: 7.5,
  /** Core light. ONE point light, created at init and never removed, driven by
   *  intensity so the visible light count — a shader permutation key — cannot
   *  move. See ARCHITECTURE.md. */
  coreLight: {
    colour: [0.42, 0.19, 1.0],
    // MEASURED. 26 through the arena's height fog produced a violet wash that
    // erased the torso the light is supposed to be inside. 15 still throws a
    // clear violet bounce onto the arena floor — which the frame badly needs,
    // `analyze.mjs` reports 44% of it crushed to black — without the halo.
    base: 3.2, vulnerable: 15.0, distance: 13.0,
  },
};

/* ==========================================================================
 * THE SHADOW ARMY
 * ========================================================================== */
export const SHADOW = {
  /** Materialisation timeline. The soldier is DRAWN before it can act, and the
   *  draw is a dissolve front sweeping up the body, not a fade. */
  materialise: 0.62,
  /** Fraction of `materialise` at which `shadow:arise` fires. Early, so the
   *  event's own VFX overlaps the body resolving rather than following it. */
  ariseAt: 0.42,
  /** Follow formation. Soldiers with nothing to fight fall into an arc BEHIND
   *  the player — behind, because an army that stands in front blocks the shot. */
  formationRadius: 2.6,
  formationSpread: 2.05,
  formationRows: 3,
  /** Beyond this from the player, a soldier disengages and comes back. An army
   *  that scatters across the level stops reading as an army. */
  tether: 17.0,
  /** How far a soldier will look for its own target. */
  engageRadius: 12.0,
  /** Soldiers expire. Without a lifetime the screen fills with an army that has
   *  nothing to fight and the extraction loop loses its rhythm. Long enough to
   *  survive a whole room fight. */
  lifetime: 95.0,
  fadeOut: 1.4,
  /** Rank multipliers on the raised soldier's stats. */
  rankPower: { common: 1.0, elite: 1.65, boss: 3.4 },
  /** Order durations from `combat`'s Sovereign's Command. */
  orderDuration: 8.0,
};

/* ==========================================================================
 * DEATH / CORPSES
 * ========================================================================== */
export const DEATH = {
  /** How long a corpse remains before it fades. Matched to `player`'s own
   *  CORPSE_TTL (22 s) so a body the ARISE prompt says is extractable is still
   *  physically there. */
  corpseTtl: 22.0,
  corpseFade: 1.6,
  /** Killing-blow impulse scale into the ragdoll, in kg·m/s. `physics/ragdoll.js`
   *  documents 60–200 for a melee kill and 600+ for an explosion. */
  impulse: 165,
  impulseCrit: 330,
  impulseExplosion: 620,
  /** Overkill fraction above which limbs come off. */
  dismemberOverkill: 0.28,
  /** Maximum limbs one corpse may shed, so a nova does not produce 200 rigid
   *  bodies in one frame. */
  maxLimbs: 2,
  /** Ragdolls in flight at once. Above this the oldest settled one is recycled
   *  by `physics` itself. */
  maxRagdolls: 14,
};

/* ==========================================================================
 * SPAWN DIRECTOR
 * ========================================================================== */
export const DIRECTOR = {
  /** Seconds between director ticks. Pacing is not a per-frame decision. */
  tick: 0.75,
  /** Wave composition by escalation step. Each entry is a budget in "points",
   *  spent on archetypes at the costs below. The escalation is the Solo Leveling
   *  shape: it does not plateau, it keeps climbing. */
  cost: { ghoul: 1, beast: 1.5, knight: 3, caster: 2.5, brute: 4 },
  waves: [
    { budget: 5, kinds: ['ghoul'] },
    { budget: 8, kinds: ['ghoul', 'beast'] },
    { budget: 12, kinds: ['ghoul', 'beast', 'caster'] },
    { budget: 17, kinds: ['ghoul', 'beast', 'knight', 'caster'] },
    { budget: 23, kinds: ['ghoul', 'beast', 'knight', 'caster', 'brute'] },
    { budget: 30, kinds: ['ghoul', 'ghoul', 'beast', 'knight', 'caster', 'brute'] },
  ],
  /** Distance from the player a spawn is allowed to appear. Never in front and
   *  never close: an enemy that materialises inside the frame is the clearest
   *  possible admission that the world is fake. */
  spawnMin: 13.0,
  spawnMax: 26.0,
  /** Seconds of quiet after a wave is cleared before the next one starts. The
   *  gap is what makes a fight feel like a fight instead of a treadmill. */
  lull: 4.5,
  /** Enemies alive above which the director holds off regardless of budget. */
  softCap: 0.72,
  /** The director will not spawn while the boss is alive. Its adds are its own. */
};

/* ==========================================================================
 * helpers
 * ========================================================================== */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t));
export const easeInQuad = (t) => t * t;
/** Shortest signed angular difference a→b, in (−π, π]. */
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
/** Move `a` toward `b` by at most `max` radians. */
export function approachAngle(a, b, max) {
  const d = angleDelta(a, b);
  return a + clamp(d, -max, max);
}
