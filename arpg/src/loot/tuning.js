/**
 * MONARCH — `loot` tuning.
 *
 * Every number the reward loop turns on, in one place, each with the reason it
 * has that value. A magic constant buried in a generator is a number nobody
 * dares move six months later, and the reward loop is the one system that gets
 * retuned constantly.
 *
 * THE SHAPE OF THE LOOP THIS FILE ENCODES
 *
 * Diablo's drop curve and Solo Leveling's escalation want opposite things. A
 * Diablo curve is stingy (a legendary is a session event); Solo Leveling wants
 * the player to feel the power move INSIDE one run. The compromise here:
 *
 *   - common trash drops rarely, and almost always drops junk
 *   - elites drop reliably and roll on a shifted table
 *   - a boss ALWAYS drops, and always drops at least a rare
 *   - `pity` guarantees a legendary if the player has gone long enough without
 *     one, so a run cannot end without the moment happening at least once
 *
 * That last one is the important one. The legendary beam is the single best
 * frame this subsystem can produce, and leaving whether it happens to chance is
 * how a demo build ends up never showing its best feature.
 */

/** Ordered worst → best. Index is used for comparisons and for tier gating. */
export const RARITY_ORDER = ['common', 'magic', 'rare', 'legendary', 'mythic'];

export const RARITY_INDEX = Object.freeze(
  RARITY_ORDER.reduce((m, k, i) => { m[k] = i; return m; }, {})
);

/* ==========================================================================
 * DROP RATES
 * ========================================================================== */

/**
 * Per enemy rank: the chance anything drops at all, how many rolls it gets, and
 * the rarity weight vector for each roll.
 *
 * Weights, not probabilities — they are normalised at roll time so magic find
 * can scale the tail without anyone having to keep the vector summing to one.
 *
 * `floor` is a rarity the roll is lifted to if it came out worse. It is what
 * makes a boss kill feel like a boss kill regardless of the dice.
 */
export const DROP_TABLE = {
  common: {
    chance: 0.34, rolls: 1, floor: null,
    weights: { common: 62, magic: 30, rare: 7.0, legendary: 0.9, mythic: 0.10 },
  },
  elite: {
    chance: 0.92, rolls: 2, floor: null,
    weights: { common: 30, magic: 42, rare: 23, legendary: 4.2, mythic: 0.55 },
  },
  champion: {
    chance: 1.0, rolls: 3, floor: 'magic',
    weights: { common: 16, magic: 44, rare: 32, legendary: 7.0, mythic: 1.1 },
  },
  boss: {
    chance: 1.0, rolls: 5, floor: 'rare',
    weights: { common: 0, magic: 24, rare: 52, legendary: 20, mythic: 4.0 },
  },
  /** A shadow soldier's kill still credits the player, but the soldier itself
   *  dying must not drop anything — it was never carrying loot. */
  shadow: { chance: 0, rolls: 0, floor: null, weights: { common: 1 } },
  /** Breakables, urns, reliquaries. `world` does not call this yet; the entry
   *  exists so it can, without touching this file. */
  container: {
    chance: 1.0, rolls: 1, floor: null,
    weights: { common: 52, magic: 34, rare: 12, legendary: 1.8, mythic: 0.2 },
  },
};

/**
 * Magic find shifts weight from the bottom of the table to the top. Applied as
 * `weight *= (1 + mf * pull[rarity])`, so 100% magic find roughly triples the
 * legendary weight while barely touching commons — the classic ARPG shape,
 * where MF is felt as "better things", not as "more things".
 */
export const MF_PULL = { common: -0.55, magic: -0.10, rare: 0.55, legendary: 1.9, mythic: 2.6 };

/**
 * Pity. Counts DROPS, not kills, because a player who is killing nothing is not
 * owed anything. 46 is roughly ten minutes of clearing at the pace this build
 * runs at, which is the longest a run should ever go without the beam.
 */
export const PITY = {
  legendary: 46,
  /** Mythic pity is deliberately far out — it should feel like an accident that
   *  happened to you, not like a schedule. */
  mythic: 240,
};

/* ==========================================================================
 * ITEM LEVEL
 * ========================================================================== */

export const ILVL = {
  /** Monster level → item level, before the rank bonus. Loot slightly above the
   *  monster that dropped it is what makes clearing upward feel worthwhile. */
  offset: 1,
  rankBonus: { common: 0, elite: 2, champion: 3, boss: 6, container: 0, shadow: 0 },
  /** Random spread, integer, inclusive. Small: a wide spread makes item level
   *  meaningless as a signal. */
  jitter: [-1, 2],
  min: 1,
  max: 100,
};

/* ==========================================================================
 * AFFIX COUNTS
 * ========================================================================== */

/**
 * How many affixes a rarity gets. Legendary and mythic get one FEWER rolled
 * affix than their rarity would suggest, because they also carry a unique
 * power, and a legendary that is strictly a rare with extra lines is a design
 * failure — the power is supposed to be the reason you equip it.
 */
export const AFFIX_COUNT = {
  common: { min: 0, max: 0 },
  magic: { min: 1, max: 2 },
  rare: { min: 3, max: 4 },
  legendary: { min: 3, max: 4 },
  mythic: { min: 4, max: 5 },
};

/**
 * Affix tiers. A tier is unlocked by item level; the roll picks the highest
 * unlocked tier most of the time and steps down occasionally, which is what
 * makes a high-ilvl item *usually* good rather than uniformly random.
 */
export const TIERS = [
  { name: 'I', ilvl: 1, lo: 0.10, hi: 0.30 },
  { name: 'II', ilvl: 8, lo: 0.22, hi: 0.44 },
  { name: 'III', ilvl: 18, lo: 0.36, hi: 0.58 },
  { name: 'IV', ilvl: 30, lo: 0.50, hi: 0.74 },
  { name: 'V', ilvl: 46, lo: 0.66, hi: 0.90 },
  { name: 'VI', ilvl: 64, lo: 0.82, hi: 1.00 },
];

/** Probability of stepping down one tier from the highest unlocked. Applied
 *  repeatedly, so tier−2 happens at 0.10, tier−3 at 0.03. */
export const TIER_STEPDOWN = 0.32;

/**
 * Smart loot. The fraction of affix picks drawn from the pool weighted by the
 * player's own build rather than uniformly.
 *
 * NOT 1.0 on purpose. An item generator that only ever rolls what you already
 * scale with produces a bag where every item is the same item; the 30% of
 * uniform rolls is where the surprises live, and surprises are the point.
 */
export const SMART_BIAS = 0.70;

/* ==========================================================================
 * THE GROUND DROP
 * ========================================================================== */

export const DROP = {
  /** Concurrent ground drops. Above this the oldest common/magic item is
   *  despawned to make room — an ARPG floor that never clears turns into a
   *  wall of beams and the good one stops reading. */
  maxActive: 20,
  /** Seconds a common item lies on the floor before it fades out. Higher
   *  rarities never expire: losing a legendary to a timer is unforgivable. */
  ttl: { common: 95, magic: 150, rare: 260, legendary: 0, mythic: 0 },

  /** How far from the corpse a drop is thrown, metres. */
  scatter: [0.55, 1.9],
  /** The arc: seconds to land, and peak height. Short — the eye should follow
   *  it, not wait for it. */
  tossTime: 0.42,
  tossHeight: 1.05,

  /** Resting height above the floor and the bob envelope, metres. */
  hover: 0.34,
  bobAmp: 0.055,
  bobHz: 0.42,
  /** Radians per second. Slow: a fast spin at 21 m reads as a flicker, and
   *  under TAA it smears. */
  spin: 0.55,
  /** Tilt off vertical, radians. The silhouette of a sword seen exactly
   *  end-on is a dot; 22° off axis is what makes the base type readable. */
  tilt: 0.38,

  /** Metres. Walk inside this and the item is picked up. */
  pickupRadius: 1.35,
  /** Seconds after landing before pickup can trigger, so a drop that lands on
   *  the player's feet is not consumed before they have seen it. */
  pickupDelay: 0.55,

  /** World scale of the item mesh. Items are authored ~1 m long and shown at
   *  0.62 of that: real scale is unreadable at the gameplay camera, and full
   *  scale looks like a prop lying in the room rather than a pickup. */
  meshScale: 0.62,
};

/**
 * The beam. Height, radius and radiance per rarity.
 *
 * `beam` in palette.RARITY is the authored relative brightness; these are the
 * physical dimensions. A legendary must be identifiable from across the room
 * BEFORE the item is resolvable, which means the beam is doing the work — hence
 * the height jump at legendary rather than a smooth ramp.
 */
export const BEAM = {
  height: { common: 1.5, magic: 2.3, rare: 3.1, legendary: 5.4, mythic: 6.6 },
  radius: { common: 0.10, magic: 0.13, rare: 0.16, legendary: 0.235, mythic: 0.27 },
  /** Radiance multiplier into the additive beam shader. */
  gain: { common: 0.55, magic: 1.25, rare: 1.85, legendary: 3.3, mythic: 4.2 },
  /** Ground pool radius, metres. */
  glow: { common: 0.42, magic: 0.58, rare: 0.72, legendary: 1.16, mythic: 1.34 },
  /** Which rarities get the rotating rune ring on the floor. */
  runesFrom: 'legendary',
  /** Flicker: amplitude and rate. Deliberately slow and shallow — a beam that
   *  strobes reads as a broken shader, not as magic. */
  flickerAmp: 0.14,
  flickerHz: 0.85,
  /** Seconds for a new beam to punch in. Phased against the item's landing so
   *  the beam arrives with the item rather than before it. */
  riseTime: 0.30,
};

/**
 * Punctual lights. TWO, allocated in `init()` and never added or removed —
 * ARCHITECTURE.md: the visible point-light count is a shader program cache key.
 * They are assigned to the two highest-rarity drops nearest the camera focus
 * and driven purely by intensity, exactly like `ai`'s boss core light.
 */
export const LIGHT = {
  count: 2,
  /** Only legendary and mythic earn a real light; everything else is emissive
   *  geometry and the ground glow, which cost nothing. */
  minRarity: 'legendary',
  intensity: { legendary: 9.5, mythic: 13.0 },
  distance: 7.0,
  /** Metres above the floor. Low, so it pools on the flagstones and rakes
   *  across their normal map instead of flatly lighting the room. */
  height: 0.55,
};

/* ==========================================================================
 * THE LEGENDARY MOMENT
 * ========================================================================== */

export const MOMENT = {
  /** Full-screen flash: peak alpha and the four phases (ARCHITECTURE.md — every
   *  significant effect is an explicit timeline, never a linear fade). */
  flashPeak: { legendary: 0.34, mythic: 0.46 },
  flashIn: 0.055,      // anticipation → strike
  flashHold: 0.045,    // the step
  flashOut: 0.62,      // expo out
  /** Camera shake on the landing. Small — this is a reward, not an impact. */
  shake: { legendary: 0.16, mythic: 0.26 },
  /** Ember count emitted on the landing frame, and the continuous rate after. */
  burst: { legendary: 26, mythic: 40 },
  emberRate: { legendary: 5.0, mythic: 8.0 },   // particles per second
  /** Seconds the SYSTEM window stays up. */
  systemDuration: 4.2,
};

/* ==========================================================================
 * LABELS AND TOOLTIP
 * ========================================================================== */

export const LABEL = {
  /** Labels always shown at or above this rarity, even without Alt. That is the
   *  ARPG convention and it is what stops a legendary going unnoticed. */
  alwaysFrom: 'rare',
  /** Screen-space pixels of vertical separation enforced between labels. */
  stackGap: 19,
  /** Metres. Beyond this the label is hidden even with Alt held — labels are a
   *  reading aid for the room you are in, not a map. */
  maxDistance: 22,
  /** Metres above the item's resting point the label anchor sits. */
  lift: 0.62,
  /** Radius in CSS pixels around the cursor that counts as hovering a drop. */
  hoverPx: 46,
};

/* ==========================================================================
 * EQUIPMENT
 * ========================================================================== */

/** Doll slots, in the order `ui`'s paper doll expects them. */
export const SLOTS = [
  'head', 'shoulder', 'neck', 'chest', 'hands', 'waist',
  'legs', 'feet', 'ring', 'ring2', 'weapon', 'offhand',
];

/** Inventory capacity. 10 columns × 6 rows is `ui`'s grid. */
export const BAG_SIZE = 60;

/**
 * Auto-equip. This build has no drag-and-drop, so a picked-up upgrade equips
 * itself when it scores better than what is in the slot. Without this, every
 * stat this subsystem generates would be invisible, which is the same as not
 * having generated it.
 */
export const AUTO_EQUIP = {
  enabled: true,
  /** Score must beat the incumbent by this fraction before swapping, so the bag
   *  does not thrash between two items that are within noise of each other. */
  margin: 0.02,
};

/* ==========================================================================
 * helpers
 * ========================================================================== */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Smoothstep, used everywhere a phase envelope needs an ease. */
export const smooth = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
/** Exponential-out, the bloom phase's curve. */
export const expoOut = (t) => 1 - Math.pow(2, -9 * clamp01(t));

/** Is `a` at least as rare as `b`? */
export function atLeast(a, b) {
  return (RARITY_INDEX[a] ?? 0) >= (RARITY_INDEX[b] ?? 0);
}
