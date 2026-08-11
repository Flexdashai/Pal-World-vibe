import { LIGHTS, ELEMENTS } from '../core/palette.js';

/**
 * Time of day, and the three night moods the game ships with.
 *
 * `setTimeOfDay(hours)` is the only entry point the shot harness knows about, so
 * the hour has to carry the whole look. The model is:
 *
 *   HOUR   drives GEOMETRY — where the moon and the sun are in the sky. This is
 *          a real ephemeris (a tilted circular arc, opposed bodies), not a
 *          lookup, so the scattering LUT gets a physically meaningful zenith
 *          angle and the shadows fall in a direction that matches the disc you
 *          can see through the gate.
 *   VARIANT drives MOOD — moon colour and size, how much of the sky is dust,
 *          how many stars survive, what colour the fog picks up.
 *
 * MONARCH is a night game. The default variant is `moonlit`; `bloodmoon` is the
 * Red Gate state and `predawn` is the cold end of a long run. A caller that
 * passes an hour without a variant keeps whatever variant is active, EXCEPT that
 * hours in the pre-dawn window auto-select `predawn` when the caller has not
 * asked for anything else — which is what makes `setTimeOfDay(4.6)` do the
 * obvious thing.
 */

/** Earth's axial tilt as it applies here: how far off vertical the arc the moon
 *  travels is. 0 would put the moon straight overhead at its peak, which throws
 *  no interesting shadows at all — the whole point of a low moon is long shadows
 *  and shafts that rake across a floor rather than pooling under things. */
const ARC_TILT = 0.62;          // radians from vertical
const ARC_AZIMUTH = -0.78;      // radians, which compass bearing the arc leans to

/**
 * Position of the moon (and the opposed sun) for an hour of the day.
 *
 * The moon is treated as full-opposition for lighting purposes: it peaks at
 * 01:00 and sets around 06:00, which is the window the game is set in. The sun
 * is the antipode plus a small offset so that pre-dawn actually has a sun a few
 * degrees below the horizon lighting the bottom of the atmosphere — that band is
 * the entire pre-dawn look and it cannot be faked with a gradient.
 *
 * Returns unit vectors in world space, Y up. `+X` is screen right-and-down and
 * `+Z` is screen left-and-down (see ARCHITECTURE.md), so a moon at `-X-Z` is
 * high in frame, which is where a key light wants to be for an isometric camera.
 */
export function bodyDirections(hours, out) {
  // Hour angle: 0 at the moon's culmination (01:00), 2*pi over a full day.
  const t = ((hours - 1.0) / 24.0) * Math.PI * 2.0;

  // A circle inclined by ARC_TILT from the vertical plane, rotated to
  // ARC_AZIMUTH. Written out rather than composed from matrices because it is
  // evaluated once per time change and the algebra is clearer than the code
  // that would build the three rotations.
  const ct = Math.cos(t), st = Math.sin(t);
  const ca = Math.cos(ARC_TILT), sa = Math.sin(ARC_TILT);
  const cz = Math.cos(ARC_AZIMUTH), sz = Math.sin(ARC_AZIMUTH);

  // Before azimuth rotation: the body rises in +X, peaks at +Y, sets in -X, and
  // the tilt leans the whole arc toward -Z.
  const x0 = st;
  const y0 = ct * ca;
  const z0 = -ct * sa;

  out.moon.set(x0 * cz - z0 * sz, y0, x0 * sz + z0 * cz).normalize();

  // The sun is the antipode, dragged 0.28 rad along the arc so that at 04:30 —
  // deep pre-dawn — it sits ~8 degrees below the horizon rather than exactly
  // opposite the moon. That offset is what produces the cold band on the horizon
  // instead of a symmetric glow.
  const ts = t + Math.PI + 0.28;
  const cts = Math.cos(ts), sts = Math.sin(ts);
  const xs = sts;
  const ys = cts * ca;
  const zs = -cts * sa;
  out.sun.set(xs * cz - zs * sz, ys, xs * sz + zs * cz).normalize();

  return out;
}

/**
 * The three moods.
 *
 * Every colour here is LINEAR RGB and every one that has a canonical home is
 * read from `palette.js` rather than typed again: the moon key is
 * `LIGHTS.moon`, the blood moon borrows the blood element, the shadow shrine
 * tint borrows `ELEMENTS.shadow`. What is local to this file is only the
 * ATMOSPHERIC parameters, which palette has no opinion about.
 */
export const VARIANTS = {
  /**
   * The default. A high waning-gibbous moon, a deep indigo sky, a dense star
   * field and thin cirrus. Cold enough that a single brazier owns every warm
   * pixel in the frame, which is the contrast the whole art direction runs on.
   */
  moonlit: {
    name: 'moonlit',
    /** Multiplier on the scattering LUT. This is the "how much light is in the
     *  sky at all" knob and it is the single most sensitive number in the
     *  subsystem: at 2x the frame reads as dusk, at 0.3x the sky is black. */
    skyIrradiance: 0.0135,
    /** Tint applied to the Rayleigh term. Slightly pushed to blue-violet, which
     *  is the one place the game's signature colour is allowed to touch the
     *  environment. */
    rayleighTint: [0.86, 0.94, 1.18],
    mieTint: [1.0, 1.0, 1.04],
    /** Airglow + unresolved starlight floor, so the sky away from the moon is
     *  never pure black. Real airglow is a faint green from atomic oxygen. */
    nightFloor: [0.0011, 0.0016, 0.0026],
    /** Van Rhijn horizon brightening of that floor. */
    nightHorizon: 2.1,

    moonColor: LIGHTS.moon.color,
    moonIntensity: LIGHTS.moon.intensity,
    moonRadiance: 1.0,
    moonSize: 1.0,
    /** Illuminated fraction and terminator direction, radians. A gibbous moon
     *  reads as a moon; a full disc reads as a light bulb. */
    moonPhase: 0.82,
    moonPhaseAngle: 0.55,

    starBrightness: 1.0,
    milkyWay: 0.75,

    cloudCoverage: 0.0,        // offset added to CLOUDS.*Coverage; + = fewer
    cloudTint: [0.62, 0.70, 0.92],
    cloudDensity: 0.85,

    /** Fog. `tint` multiplies the ambient in-scatter colour; `densityScale`
     *  multiplies FOG.density. */
    fogTint: [0.66, 0.76, 1.0],
    fogDensityScale: 1.0,
    /** Hemisphere fill: what the sky contributes to the fog and to the ground
     *  bounce even when the moon is occluded. */
    bounceColor: LIGHTS.moonBounce.color,
    bounceIntensity: LIGHTS.moonBounce.intensity,
  },

  /**
   * BLOOD MOON — the Red Gate. Solo Leveling's dungeon-break state.
   *
   * Physically motivated rather than a red filter: the moon is low and huge, so
   * its light crosses a long slant path and loses its blue to Rayleigh, and the
   * air is loaded with dust (Mie up, Rayleigh down) which is what actually turns
   * a lunar eclipse copper. The result tints the FOG, which is what sells it —
   * a red sky over a blue-grey room fools nobody.
   */
  bloodmoon: {
    name: 'bloodmoon',
    skyIrradiance: 0.030,
    rayleighTint: [1.55, 0.52, 0.34],
    mieTint: [1.5, 0.62, 0.44],
    nightFloor: [0.0042, 0.0012, 0.0011],
    nightHorizon: 2.6,

    moonColor: [1.0, 0.24, 0.10],
    moonIntensity: LIGHTS.moon.intensity * 1.5,
    moonRadiance: 0.55,        // a dim disc; the SKY is what is bright
    moonSize: 1.75,
    moonPhase: 1.0,
    moonPhaseAngle: 0.0,

    starBrightness: 0.28,      // washed out by the glow
    milkyWay: 0.2,

    cloudCoverage: -0.10,      // heavier deck
    cloudTint: [1.15, 0.38, 0.24],
    cloudDensity: 1.35,

    fogTint: [1.25, 0.44, 0.34],
    fogDensityScale: 1.22,
    bounceColor: [0.28, 0.07, 0.05],
    bounceIntensity: 0.30,
  },

  /**
   * PRE-DAWN. The sun is 8 degrees below the horizon, the moon is setting, and
   * ozone absorption has taken the middle out of the spectrum. The coldest,
   * emptiest look the game has — the end of a long run.
   */
  predawn: {
    name: 'predawn',
    skyIrradiance: 0.052,
    rayleighTint: [0.62, 0.92, 1.32],
    mieTint: [0.95, 1.0, 1.10],
    nightFloor: [0.0018, 0.0030, 0.0052],
    nightHorizon: 3.0,

    moonColor: [0.68, 0.72, 0.86],
    moonIntensity: LIGHTS.moon.intensity * 0.55,
    moonRadiance: 0.75,
    moonSize: 1.0,
    moonPhase: 0.55,
    moonPhaseAngle: 2.1,

    starBrightness: 0.45,
    milkyWay: 0.3,

    cloudCoverage: 0.06,
    cloudTint: [0.52, 0.66, 0.90],
    cloudDensity: 0.7,

    fogTint: [0.56, 0.74, 1.05],
    fogDensityScale: 1.10,
    bounceColor: [0.10, 0.16, 0.28],
    bounceIntensity: 0.26,
  },
};

/** Named shorthands, so `setTimeOfDay('bloodmoon')` works as well as
 *  `setTimeOfDay(1.2, 'bloodmoon')`. The hours are the ones each mood looks
 *  best at, which is not a coincidence — the variant and the geometry were
 *  tuned together. */
export const NAMED_TIMES = {
  night: { hours: 1.2, variant: 'moonlit' },
  moonlit: { hours: 1.2, variant: 'moonlit' },
  midnight: { hours: 0.4, variant: 'moonlit' },
  bloodmoon: { hours: 22.6, variant: 'bloodmoon' },
  blood: { hours: 22.6, variant: 'bloodmoon' },
  predawn: { hours: 4.7, variant: 'predawn' },
  dawn: { hours: 4.7, variant: 'predawn' },
};

/**
 * Resolve whatever the caller passed into `{ hours, variant }`.
 *
 * Deliberately permissive: this is called from the shot harness, from the URL,
 * and from other agents, and the failure mode of a strict parser here is a black
 * frame in somebody else's screenshot.
 */
export function resolveTime(value, variant, current) {
  let hours = current?.hours ?? 1.2;
  let name = variant ?? current?.variant ?? 'moonlit';

  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (NAMED_TIMES[key]) {
      hours = NAMED_TIMES[key].hours;
      // An explicit variant argument still wins over the shorthand's default.
      name = variant ?? NAMED_TIMES[key].variant;
    } else if (VARIANTS[key]) {
      name = key;
    } else {
      const n = Number(key);
      if (Number.isFinite(n)) hours = n;
    }
  } else if (Number.isFinite(value)) {
    hours = value;
    // Auto-select pre-dawn in its window, but only if the caller did not ask for
    // a variant and is not already in a deliberate one (a blood moon does not
    // stop being a blood moon at 04:30).
    if (!variant && (current?.explicitVariant !== true)) {
      name = (hours >= 3.4 && hours < 6.2) ? 'predawn' : 'moonlit';
    }
  }

  hours = ((hours % 24) + 24) % 24;
  if (!VARIANTS[name]) name = 'moonlit';
  return { hours, variant: name, explicitVariant: variant != null };
}

/** Element tint used by the shadow-shrine fog accent, read from palette so the
 *  signature violet is defined in exactly one place. */
export const SHADOW_TINT = ELEMENTS.shadow.glow;
