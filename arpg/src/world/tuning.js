/**
 * MONARCH — `world` art-direction constants.
 *
 * `core/config.js` owns simulation and quality budgets, `core/palette.js` owns
 * colour, `render/tuning.js` owns the camera/film. This file owns the third
 * thing: the DIMENSIONS AND PROPORTIONS OF THE ARCHITECTURE, and the rules that
 * keep the level readable at the fixed isometric camera.
 *
 * Every number here was either derived from the camera (see CAMERA_FACTS) or
 * measured off a gothic building. Where a value was tuned by capture the comment
 * says what it was tuned against, because a bare number rots.
 */

import { UNITS, CAMERA } from '../core/config.js';

/**
 * Facts about the fixed camera that the whole level design is derived from.
 * NOTHING here is a preference — change `CAMERA` in config.js and these move.
 *
 *   yaw 45°, pitch −52°. The eye sits at focus + (+X, +Y, +Z).
 *   => +X and +Z are the CAMERA SIDE of any room: geometry there stands between
 *      the lens and the player and must be low, open, or occluder-faded.
 *   => −X and −Z are the BACKDROP: this is where the height, the vaults, the
 *      rose windows and the silhouette go, because it is the only part of a room
 *      the camera can see a wall's full elevation of.
 */
export const CAM = {
  /** Unit world vector that points "up the screen". */
  screenUp: [-Math.SQRT1_2, 0, -Math.SQRT1_2],
  /** Unit world vector that points "right across the screen". */
  screenRight: [Math.SQRT1_2, 0, -Math.SQRT1_2],
  /**
   * Metres of ground visible at the hero boom, measured across the frame and
   * along the view direction. Derived: 2·boom·tan(fov/2) vertically on the
   * image plane, divided by sin(|pitch|) to project onto the ground.
   */
  groundAcross: 2 * CAMERA.boom * Math.tan((CAMERA.fov * Math.PI) / 360) * (16 / 9),
  groundDeep: (2 * CAMERA.boom * Math.tan((CAMERA.fov * Math.PI) / 360)) / Math.sin(-CAMERA.pitch),
};

/** The generator's grid. Everything snaps to this so rooms and corridors meet. */
export const CELL = UNITS.cell; // 2.0 m

export const ARCH = {
  /**
   * Wall thickness. Real cathedral walls are 0.9–1.4 m and the thickness is
   * VISIBLE at every opening — a 10 cm wall with a hole in it reads as cardboard
   * the instant the camera can see into the reveal, which at this pitch it
   * always can.
   */
  wallThick: 0.95,
  /** Thin partition walls inside crypts. */
  partitionThick: 0.55,

  /**
   * Heights, in metres.
   *
   * `backdrop` is the tall side (−X/−Z) and is allowed to break the 4 m occluder
   * rule because it is never between the camera and the player.
   * `camSide` is the +X/+Z side and is deliberately BELOW eye height so a room
   * reads as an open stage rather than a box the camera peers into.
   */
  hallBackdrop: 11.5,
  hallCamSide: 2.15,
  cryptBackdrop: 4.6,
  cryptCamSide: 1.45,
  arenaBackdrop: 13.0,
  arenaCamSide: 2.6,

  /** Plinth / string course heights. A wall with no horizontal break in it is
   *  the flattest thing a level can contain. */
  plinth: 0.55,
  stringCourse: 3.4,

  /**
   * Gothic arch proportion: rise over half-span for a two-centred arch. 1.35
   * gives the steep lancet of an English crypt; 1.0 is a plain equilateral arch
   * and reads Romanesque. Bays are jittered around this per instance.
   */
  archRise: 1.32,
  /** Radial depth of an arch ring (the voussoirs) in metres. */
  archRing: 0.62,
  /** Voussoirs per arch. Nine is the smallest count where the joints read as
   *  masonry rather than as a polygon approximation at the hero boom. */
  voussoirs: 9,

  /** Column proportions. Shaft is a faceted polygon, not a smooth cylinder:
   *  facets catch the brazier as a sequence of discrete highlights, which is
   *  most of what makes stone read as carved rather than extruded. */
  columnSides: 10,
  // 0.46 m core radius, so a pier with its attached shafts measures ~1.1 m
  // across and its capital ~1.35 m. Tuned by capture: at 0.66 the abacus was
  // 2.3 m wide, which at the hero boom is a fifth of the frame per column and
  // reads as a grain silo. A real gothic nave pier is 0.9-1.3 m across, and the
  // slenderness is the whole point of the style.
  columnRadius: 0.46,
  columnTaper: 0.88,
  capitalFlare: 1.45,
  baseFlare: 1.50,

  /** Ribbed vault: springing height above the capital, and the rise of the
   *  groin above the springing. */
  vaultRise: 0.42,
  vaultSeg: 5,
};

/**
 * Per-room material dressing, keyed by `room.kind` exactly as layout.js spells
 * it. This is where "how filthy and how wet is this room" lives, and it is the
 * single biggest lever on whether two rooms feel like different places.
 *
 * Getting a key wrong is SILENT — `materialsFor` falls back to `chamber` — and
 * it cost a full capture cycle: the cathedral was keyed 'hall' while its kind is
 * 'cathedral', so the hall spent three iterations wearing a sealed crypt's
 * dressing. The nine kinds are listed below and there are no others.
 *
 * ---------------------------------------------------------------------------
 * `env` AND WHY IT IS NOT THE FILL LEVER, MEASURED
 *
 * `env` multiplies `envMapIntensity`, i.e. how much of `sky`'s PMREM a surface
 * picks up. It was the obvious answer to the measured "44% of the frame is
 * information-free black" defect, and it does not work here. Sweeping the
 * cathedral from 1.6 to 7 to **300** produced three captures that
 * `tools/analyze.mjs` scored IDENTICALLY to three decimal places (dark 39.2%,
 * rms 38.5, sat 0.365). The diffuse IBL term is contributing exactly zero to
 * these materials, whatever the multiplier — the fault is upstream of `world`
 * and is `sky`'s or `render`'s to find.
 *
 * So the values here are kept modest and physically sane, so that they are
 * correct the day the indirect path starts working, and the actual fill comes
 * from `AMBIENT` below — a hemisphere light, which lands in the SAME shader term
 * (`reflectedLight.indirectDiffuse`) and is therefore multiplied by render's
 * GTAO exactly as the env would have been. That is the "ambient occlusion-aware
 * fill" the brief asks for, reached by the one route that is measurably live.
 */
export const DRESS = {
  cathedral: { env: 2.2, wet: 0.30, moss: 0.09, grime: 0.50, soot: 0.20, dust: 0.05 },
  processional: { env: 2.4, wet: 0.26, moss: 0.07, grime: 0.46, soot: 0.16, dust: 0.06 },
  arena: { env: 2.1, wet: 0.24, moss: 0.05, grime: 0.55, soot: 0.34, dust: 0.08 },
  corridor: { env: 1.2, wet: 0.44, moss: 0.16, grime: 0.60, soot: 0.26, dust: 0.03 },
  chamber: { env: 1.1, wet: 0.34, moss: 0.13, grime: 0.58, soot: 0.20, dust: 0.09 },
  ossuary: { env: 1.1, wet: 0.28, moss: 0.10, grime: 0.55, soot: 0.14, dust: 0.14 },
  undercroft: { env: 1.5, wet: 0.86, moss: 0.30, grime: 0.62, soot: 0.06, dust: 0.02 },
  shrine: { env: 1.6, wet: 0.40, moss: 0.11, grime: 0.42, soot: 0.10, dust: 0.05 },
  passage: { env: 1.0, wet: 0.45, moss: 0.18, grime: 0.62, soot: 0.20, dust: 0.05 },
};

/**
 * BOUNCE FILL — one hemisphere light, retuned as the player changes room.
 *
 * ---------------------------------------------------------------------------
 * WHY A HEMISPHERE LIGHT, AND WHY EXACTLY ONE
 *
 * The frame's defect is that the two thirds of it a brazier does not reach are
 * pure black rather than dark. Four candidate fixes, and only one survives:
 *
 *   raise exposure       lifts the LIT half too, and auto-exposure immediately
 *                        stops back down. This is the failure the whole
 *                        exposure system exists to avoid.
 *   more braziers        measured WORSE on the previous build (crushed went
 *                        49% -> 51%): the meter stops down and the eye loses
 *                        its focal point among a field of identical dots.
 *   `envMapIntensity`    inert here. See the DRESS note above: 1.6 -> 300
 *                        changed nothing measurable.
 *   a hemisphere light   lands in `reflectedLight.indirectDiffuse`, which is
 *                        exactly where the env term would have gone, so
 *                        render's GTAO patch multiplies it and every crevice,
 *                        column base and arch soffit STAYS dark. Occlusion-aware
 *                        fill, which is what the brief asks for.
 *
 * ONE light, not one per room, for a hard reason: three bakes the visible light
 * count of each type into every material's program cache key, and `render`'s
 * `LightBudget` freezes that count before the first compile with exactly ONE
 * hemisphere slot (`slots.hemi = max(1, count)`), filled by ballast when nobody
 * provides a real one. Supplying exactly one real hemisphere light replaces the
 * ballast and changes no count, so it costs zero recompiles. Two would cost one
 * full material recompile at load, and a light created per room would cost one
 * every time the player walked through a door.
 *
 * `sky` still owns the KEY: nothing here creates a directional light, and
 * `sky._electKeyLight` only ever adopts directionals, so the moon's ephemeris,
 * the volumetric shafts and the shadow map are untouched.
 *
 * `sky` is the cold half (moonlight through the holes in the roof) and `ground`
 * the warm half (firelight bouncing off flagstone). Splitting them that way is
 * what stops the fill reading as a grey wash: a surface facing up gets colder,
 * one facing down gets warmer, and the vertical gradient on a column reads as
 * real bounce.
 */
export const AMBIENT = {
  /** Base irradiance of the hemisphere light. Against the moon key's ~0.29
   *  this is roughly half, i.e. one stop down. That sounds high for ambient and
   *  it is not: auto-exposure meters the frame and stops down by most of
   *  whatever is added, so the fill has to be large in scene units to move the
   *  DARK pixels at all. Measured: 0.16 moved `analyze.mjs`'s crushed fraction
   *  by under one point. Above ~0.45 the crypt stops being frightening. */
  base: 0.30,
  /** How much of `base` each room kind gets. A sealed crypt has no sky and only
   *  its own firelight to bounce; a hall with half its vault gone has both. */
  perKind: {
    cathedral: 1.15,
    processional: 1.25,
    arena: 1.10,
    corridor: 0.42,
    chamber: 0.40,
    ossuary: 0.45,
    undercroft: 0.62,
    shrine: 0.66,
    passage: 0.34,
  },
  /** Seconds for the fill to cross-fade when the player changes room. Slow, on
   *  purpose: it is standing in for an eye adapting, and a step change reads as
   *  a light switch. */
  blend: 1.1,
  /** How much of the brazier hue to mix into the ground half. The floor bounce
   *  in a firelit crypt is warm, but at full saturation it turns every soffit
   *  orange and pushes the frame's luminance-weighted saturation up, which is
   *  the exact metric the art direction is trying to hold DOWN. */
  groundWarmth: 0.42,
};


/**
 * Practical lighting.
 *
 * The rule the brief states and this file obeys: NEVER lay down uniform
 * coverage. Braziers are placed in a deliberate rhythm with 9–16 m between them
 * so the floor between two pools genuinely falls away, and every pool is aimed
 * at something worth lighting — a column base, a statue, the lip of a stair.
 *
 * Intensity and colour come from `palette.LIGHTS`; these are the multipliers and
 * the placement rules, which are level design rather than colour identity.
 */
export const LIGHTING = {
  /** Height of a floor-standing brazier's flame above its base. */
  brazierFlameY: 1.62,
  /** Height of a wall sconce flame. */
  sconceY: 2.45,
  /** Gain applied to `LIGHTS.brazier.intensity` for the three brazier classes.
   *  A great hall brazier is a bonfire; a corridor sconce is a candle stub. */
  gainGreat: 1.35,
  gainStandard: 1.0,
  gainSconce: 0.30,
  gainCandle: 1.0,

  /**
   * Cold "moon pool" fill under a broken vault.
   *
   * This is a POINT light standing in for the bounce off a lit patch of floor,
   * not the moon itself — `sky` owns the key light and the volumetric shaft. It
   * sits low and wide so it lifts the floor plane and the lower metre of the
   * walls without ever reading as a source. Intensity is low enough that it
   * never wins a shadow-casting argument with a brazier, and the colour is
   * `LIGHTS.moon`, which keeps the luminance-weighted saturation DOWN — the
   * measured 0.34-against-0.30 defect is helped by adding cold light, not by
   * removing warm.
   */
  moonPool: { intensity: 3.2, radius: 22.0, height: 3.0 },

  /**
   * Minimum metres between two practicals of the same class. Enforced by the
   * placer; a level whose braziers drifted together would read as one big
   * uniform wash, which is the failure mode this whole section exists to avoid.
   */
  minSpacing: 7.5,
  /** Never put a practical closer than this to a debug landmark: the shot
   *  harness teleports the player onto the landmark, and a blown-out emissive
   *  dome on top of the subject ruins every review frame. */
  landmarkClear: 3.4,

  /** Flicker. Three incommensurate sines summed — a real flame's spectrum is
   *  ~1/f, and three octaves is enough to read as one. Never per-frame random:
   *  that strobes, and it is not reproducible in a capture. */
  flicker: { a: 0.055, b: 0.080, c: 0.050, rate: [0.70, 1.20] },
};

/**
 * Streaming. Rooms outside `drawRadius` of the camera focus are `visible=false`,
 * which removes them from `traverseVisible` entirely — no draw, no shadow, no
 * prepass, no bounding-sphere work.
 *
 * The radius is measured from the room's AABB, not its centre, so a long
 * processional way stays lit while the player is at either end of it.
 */
export const STREAM = {
  drawRadius: 34.0,
  /** Hysteresis: a room already drawn stays drawn until this much further out.
   *  Without it a player pacing on the boundary toggles a room's visibility
   *  every frame, and every toggle is a shadow-map invalidation. */
  hysteresis: 7.0,
  /** Rooms are never streamed out while the shot harness is posing the camera —
   *  a debug focus may legitimately sit outside every room. */
  alwaysDraw: 1,
};

/**
 * Instance counts for set dressing, scaled by the quality preset's particle
 * budget as a proxy for "how much machine is there". These are triangle budgets
 * in disguise: a rubble instance is ~40 triangles and a skull ~60, so the totals
 * below land around 25–40k triangles of debris for a whole level.
 */
export const DEBRIS = {
  rubblePerRoom: [10, 26],
  bonesPerRoom: [0, 18],
  skullsPerRoom: [0, 10],
  shardsPerRoom: [6, 20],
  rootsPerRoom: [0, 7],
  /** Fraction of wall niches that actually contain something. A niche grid where
   *  every cell is full reads as a vending machine. */
  nicheFill: 0.55,
};

/** Surface tags handed to physics. Kept here so the whole subsystem agrees. */
export const SURFACE = {
  floor: 'flagstone',
  wall: 'stone',
  vault: 'stone',
  metal: 'metal',
  wood: 'wood',
  bone: 'bone',
  water: 'water',
  crystal: 'crystal',
  dirt: 'dirt',
};

/** Clamp helper used all over the generator. */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Snap to the dungeon grid. */
export const snap = (v, cell = CELL) => Math.round(v / cell) * cell;
