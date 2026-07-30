/**
 * surfaces.js — the shared surface vocabulary, plus collision layers.
 *
 * The twelve surface names are FIXED by ARCHITECTURE.md. `fx`, `audio` and `loot`
 * all switch on them: an impact on `flagstone` sparks and rings, on `flesh` it
 * sprays and thuds, on `water` it splashes and mutes the tail. Physics stores the
 * *index* per triangle (one byte, so a 200k-triangle level costs 200 kB) and hands
 * the *name* back in every hit record, so nobody outside this directory needs to
 * know about the packing.
 *
 * The numbers are physically motivated and then game-tuned:
 *   friction     dry kinetic coefficient — how fast debris stops sliding.
 *   restitution  measured drop-bounce; stone rings, cloth eats everything.
 *   density      kg/m^3, used when a body's mass is inferred from its volume.
 *   hardness     0..1, drives spark/chip likelihood in fx and the transient in audio.
 *   softness     0..1, how much a landing ragdoll sinks and how muted it lands.
 *   splash       a liquid: no sparks, ripple decal, muffled audio.
 *   shatter      breaks rather than absorbs — crystal.
 */

export const SURFACE_NAMES = [
  'stone',
  'flagstone',
  'dirt',
  'wood',
  'metal',
  'bone',
  'flesh',
  'cloth',
  'water',
  'crystal',
  'ash',
  'blood',
];

/** name -> index. `SURFACE.flagstone === 1`. */
export const SURFACE = /** @type {Record<string, number>} */ ({});
for (let i = 0; i < SURFACE_NAMES.length; i++) SURFACE[SURFACE_NAMES[i]] = i;

export const SURFACE_PROPS = [
  // stone — dressed cathedral masonry: hard, grippy, rings when struck.
  { friction: 0.90, restitution: 0.22, density: 2500, hardness: 0.95, softness: 0.02, splash: false, shatter: false },
  // flagstone — floor slabs, damp, slightly more slippery than dressed stone.
  { friction: 0.78, restitution: 0.26, density: 2400, hardness: 0.92, softness: 0.03, splash: false, shatter: false },
  // dirt — packed grave soil. Absorbs almost everything.
  { friction: 0.98, restitution: 0.06, density: 1500, hardness: 0.18, softness: 0.35, splash: false, shatter: false },
  // wood — rotted beams, coffin lids, doors.
  { friction: 0.72, restitution: 0.28, density: 620, hardness: 0.40, softness: 0.18, splash: false, shatter: false },
  // metal — iron banding, portcullis, brazier bowls. Loud, bouncy, sparks.
  { friction: 0.48, restitution: 0.46, density: 7800, hardness: 1.00, softness: 0.00, splash: false, shatter: false },
  // bone — ossuary walls and skull piles. Brittle, dry clatter.
  { friction: 0.66, restitution: 0.30, density: 1900, hardness: 0.62, softness: 0.08, splash: false, shatter: false },
  // flesh — actors and corpses. Wet, heavy, no bounce.
  { friction: 0.92, restitution: 0.04, density: 1050, hardness: 0.05, softness: 0.70, splash: false, shatter: false },
  // cloth — banners, shrouds, tapestry. Eats impacts entirely.
  { friction: 0.84, restitution: 0.03, density: 380, hardness: 0.02, softness: 0.85, splash: false, shatter: false },
  // water — standing crypt water. Splash decals, muted audio, big drag.
  { friction: 0.30, restitution: 0.00, density: 1000, hardness: 0.00, softness: 1.00, splash: true, shatter: false },
  // crystal — shadow-rift growths. Shatters, high-pitched, throws shards.
  { friction: 0.36, restitution: 0.42, density: 2600, hardness: 0.88, softness: 0.00, splash: false, shatter: true },
  // ash — burnt-out braziers and pyres. Puffs, absorbs, no ring.
  { friction: 1.05, restitution: 0.02, density: 700, hardness: 0.06, softness: 0.55, splash: false, shatter: false },
  // blood — pooled blood on flagstone. Slippery, wet, splashes.
  { friction: 0.42, restitution: 0.02, density: 1060, hardness: 0.02, softness: 0.60, splash: true, shatter: false },
];

/**
 * Best-effort inference from a mesh/material name, so a `world` mesh that forgot
 * to set `userData.mnSurface` still produces the right footsteps instead of
 * defaulting everything to stone. Ordered most-specific first.
 */
const GUESS = [
  [/flagstone|floor|slab|paving|tile|ground_?stone/i, SURFACE.flagstone],
  [/crystal|shard|rift|gem|geode|obsidian/i, SURFACE.crystal],
  [/blood|gore|viscera/i, SURFACE.blood],
  [/ash|cinder|soot|pyre|ember/i, SURFACE.ash],
  [/bone|skull|rib|ossu|skeleton|femur/i, SURFACE.bone],
  [/flesh|body|corpse|torso|limb|actor|enemy|meat/i, SURFACE.flesh],
  [/cloth|banner|drape|tapestry|shroud|flag|cloak|curtain|rug/i, SURFACE.cloth],
  [/water|pool|puddle|liquid|canal|font/i, SURFACE.water],
  [/metal|iron|steel|brass|bronze|chain|grate|portcullis|brazier|sconce|gate|lock/i, SURFACE.metal],
  [/wood|timber|plank|beam|coffin|door|crate|barrel|cart|ladder/i, SURFACE.wood],
  [/dirt|mud|soil|earth|grave|gravel|rubble|terrain/i, SURFACE.dirt],
  [/stone|rock|brick|masonry|marble|granite|wall|pillar|column|arch|vault|statue|rib/i, SURFACE.stone],
];

/** Resolve a surface name, index, or undefined to a valid index. */
export function surfaceIndex(s, fallback = SURFACE.stone) {
  if (typeof s === 'number') return s >= 0 && s < SURFACE_NAMES.length ? s | 0 : fallback;
  if (typeof s === 'string') {
    const i = SURFACE[s];
    if (i !== undefined) return i;
    return guessSurface(s, fallback);
  }
  return fallback;
}

export function guessSurface(name, fallback = SURFACE.stone) {
  if (!name) return fallback;
  for (let i = 0; i < GUESS.length; i++) if (GUESS[i][0].test(name)) return GUESS[i][1];
  return fallback;
}

export function surfaceName(i) {
  return SURFACE_NAMES[i] ?? 'stone';
}

export function surfaceProps(i) {
  return SURFACE_PROPS[i] ?? SURFACE_PROPS[SURFACE.stone];
}

/* ------------------------------------------------------------------ */
/* Collision layers                                                    */
/* ------------------------------------------------------------------ */

/**
 * One bit per category. A query carries a MASK; a collider carries one LAYER bit.
 * They intersect or the collider is invisible to that query.
 *
 * The distinction that matters most for an ARPG read: `LOW` (railings, altar
 * steps, coffin lids) blocks movement and projectiles but must NOT block line of
 * sight, or archers stop firing across a balcony and the fight dies. `DECOR`
 * (banners, hanging chains) blocks nothing but still takes decals and is hit by
 * the mouse-picking ray.
 */
export const LAYER = {
  /** Immovable architecture: floors, walls, vaults. */ STATIC: 1 << 0,
  /** Static props: pillars, statues, sarcophagi. Separate bit so AI nav can ignore. */ PROP: 1 << 1,
  /** Invisible movement blocker. Projectiles, sight and the camera pass through. */ CLIP: 1 << 2,
  /** Low geometry: blocks movement + projectiles, never sight. */ LOW: 1 << 3,
  /** Breakable: crystal growths, urns, barrels. */ BREAKABLE: 1 << 4,
  /** Water volume surface. */ WATER: 1 << 5,
  /** Non-colliding dressing that still receives decals and mouse picks. */ DECOR: 1 << 6,
  /** Simulated rigid debris. */ DEBRIS: 1 << 7,
  /** The player capsule. */ PLAYER: 1 << 8,
  /** Enemy / shadow-soldier capsules. */ ACTOR: 1 << 9,
  /** Ragdoll bone spheres. */ RAGDOLL: 1 << 10,
  /** Overlap-only volume; never blocks anything. */ TRIGGER: 1 << 11,
};

export const MASK = {
  ALL: 0xffff & ~LAYER.TRIGGER,
  /** Everything a character capsule collides with. */
  CHARACTER: LAYER.STATIC | LAYER.PROP | LAYER.CLIP | LAYER.LOW | LAYER.BREAKABLE,
  /** Everything a projectile can strike in the static soup. */
  PROJECTILE: LAYER.STATIC | LAYER.PROP | LAYER.LOW | LAYER.BREAKABLE,
  /** Line of sight for perception — low walls and clip do not block vision. */
  SIGHT: LAYER.STATIC | LAYER.PROP,
  /** Static-only world: camera collision, cover queries, ground probes. */
  WORLD: LAYER.STATIC | LAYER.PROP | LAYER.LOW | LAYER.BREAKABLE,
  /** What rigid debris bounces off. */
  DEBRIS: LAYER.STATIC | LAYER.PROP | LAYER.CLIP | LAYER.LOW | LAYER.BREAKABLE,
  /** Ragdolls ignore CLIP so a corpse can flop through a doorway blocker. */
  RAGDOLL: LAYER.STATIC | LAYER.PROP | LAYER.LOW | LAYER.BREAKABLE,
  /** Decal projection sees dressing too. */
  DECAL: LAYER.STATIC | LAYER.PROP | LAYER.LOW | LAYER.BREAKABLE | LAYER.DECOR,
  /** Mouse picking / ground cursor. */
  PICK: LAYER.STATIC | LAYER.PROP | LAYER.LOW | LAYER.BREAKABLE | LAYER.DECOR,
  /** Explosion occlusion — thin decor should not shield an enemy. */
  EXPLOSION: LAYER.STATIC | LAYER.PROP,
};

/** Layer inference from a mesh name, mirroring `guessSurface`. */
export function guessLayer(name, fallback = LAYER.STATIC) {
  if (!name) return fallback;
  if (/^clip|_clip|blocker|blockvol/i.test(name)) return LAYER.CLIP;
  if (/trigger|volume_?trig/i.test(name)) return LAYER.TRIGGER;
  if (/banner|drape|chain|cobweb|vine|tapestry|decor/i.test(name)) return LAYER.DECOR;
  if (/rail|balustrade|parapet|step|kerb|ledge|lowwall/i.test(name)) return LAYER.LOW;
  if (/urn|vase|barrel|crate|pot|crystal|breakable/i.test(name)) return LAYER.BREAKABLE;
  if (/water|pool|puddle/i.test(name)) return LAYER.WATER;
  if (/pillar|column|statue|sarcoph|prop_|altar|brazier|tomb|throne/i.test(name)) return LAYER.PROP;
  return fallback;
}
