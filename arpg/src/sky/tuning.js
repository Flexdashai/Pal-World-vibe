/**
 * MONARCH — `sky` art-direction and physical constants.
 *
 * Same split as `render/tuning.js`: `core/config.js` owns QUALITY budgets,
 * `core/palette.js` owns COLOUR, and this file owns the third category — the
 * physical parameters of the air. Scattering coefficients, scale heights, fog
 * density, march step counts, moon geometry.
 *
 * Two rules for anything added here:
 *   1. If a number came from physics, say which physics and in what unit.
 *      Rayleigh coefficients are quoted per metre in the literature and per
 *      kilometre here, and mixing those up costs an afternoon.
 *   2. If a number was tuned by eye, say what it is compensating for. The moon
 *      is 2.1x its real angular size in this game and that is a decision, not a
 *      bug — at the true 0.52 degrees it is eleven pixels wide at 720p.
 */

/**
 * Atmosphere. Bruneton/Neyret coefficients, converted from m^-1 to km^-1
 * (x1e3), because the whole scattering integral is done in kilometres — the
 * planet radius is 6360 and a float32 loses too much precision at 6.36e6.
 */
export const ATMOS = {
  /** Planet radius, km. */
  Rg: 6360.0,
  /** Top of the modelled atmosphere, km. */
  Rt: 6420.0,

  /** Rayleigh scattering at sea level, km^-1, per RGB channel at 680/550/440 nm.
   *  The 5.7x ratio between blue and red is the entire reason the sky is blue
   *  and the reason a low moon goes amber. */
  betaR: [5.802e-3, 13.558e-3, 33.1e-3],
  /** Rayleigh density scale height, km. */
  HR: 8.0,

  /** Mie scattering / extinction at sea level, km^-1. Mie is spectrally flat,
   *  which is why haze is grey and why the halo around the moon is white. */
  betaM: 3.996e-3,
  betaMExt: 4.40e-3,
  /** Mie density scale height, km. Aerosols hug the ground. */
  HM: 1.2,
  /** Mie asymmetry. 0.76 is the standard continental-haze value; it puts most of
   *  the scattered energy within ~30 degrees of the light, which is exactly the
   *  aureole you see around a moon on a humid night. */
  gMie: 0.76,

  /** Ozone absorption, km^-1. Ozone does not scatter, it only absorbs, and it
   *  absorbs in the middle of the spectrum — which is what turns the twilight
   *  sky from muddy orange into that deep blue nobody can reproduce without it.
   *  Distributed as a tent centred at 25 km, half-width 15 km. */
  betaO: [0.650e-3, 1.881e-3, 0.085e-3],
  ozoneCentre: 25.0,
  ozoneWidth: 15.0,

  /** LUT resolution. (view zenith x light zenith). 64x32 with a sqrt
   *  parameterisation puts ~20 texels in the 10 degrees above the horizon, which
   *  is where all the interesting gradient lives. */
  lutW: 64,
  lutH: 32,
  /** Samples along the view ray and along each shadow ray when baking. The bake
   *  is 64*32*(24 + 24*8) evaluations, ~40 ms on this container, once. */
  lutViewSamples: 24,
  lutLightSamples: 8,
  /** Transmittance LUT width (view zenith only, camera on the ground). Used to
   *  extinct stars and the moon disc near the horizon. */
  transW: 64,
};

/**
 * The Moon.
 *
 * `angularRadiusDeg` is 2.1x the real 0.26 degrees. This is the same cheat every
 * film uses: a true-size moon is 11 px across in a 34 degree vertical FOV at
 * 720p, which reads as a blown-out dot rather than as a body. At 0.55 degrees it
 * is ~24 px and the limb darkening, the maria and the terminator are all legible.
 */
export const MOON = {
  angularRadiusDeg: 0.55,
  /** Limb darkening coefficient in I(mu) = 1 - u(1 - mu). The Moon is a rough
   *  regolith, not a star, so it is much flatter than the solar u=0.6; 0.28 with
   *  a Lommel-Seeliger backscatter term is what gives the disc a body without
   *  making the edge look like a sphere-shaded ball. */
  limbU: 0.28,
  /** Weight of the Lommel-Seeliger (rough surface, strong opposition backscatter)
   *  term against plain Lambert. */
  lommel: 0.65,
  /** Disc radiance, in the same linear units as `palette.LIGHTS`. High enough to
   *  drive the bloom pyramid hard — the moon should smear, it is the brightest
   *  thing in a night sky by four orders of magnitude. */
  radiance: 34.0,
  /** Extra glow disc radius, in multiples of the moon radius, and its strength.
   *  The Mie term in the LUT gives the wide aureole; this is the tight bright
   *  ring immediately around the limb that a real long-lens moon shot has. Kept
   *  small: at 0.16 over 5.5 radii it was a 17-degree halo that swallowed the
   *  disc and, once the bloom pyramid got hold of it, a quarter of the sky. */
  glowRadius: 3.2,
  glowStrength: 0.075,
  /** Maria — the dark basalt plains. `mariaScale` is in noise cycles across the
   *  whole disc, so it has to be well under 1 to produce a few large blotches;
   *  at the 2.6 this started at, the pattern was at the noise texture's own
   *  frequency and read as fine grain rather than as geography. */
  mariaDepth: 0.50,
  mariaScale: 0.55,
};

/**
 * Stars.
 *
 * The count and the magnitude limit go together: real naked-eye skies show ~2500
 * stars above magnitude 6, but at 720p a star fainter than magnitude ~5.4 lands
 * below the dither floor after tone mapping, so rendering them is pure cost.
 */
export const STARS = {
  count: 1500,
  /** Magnitude range sampled. The cumulative count of stars brighter than m goes
   *  as 10^(0.6 m), which is the inverse CDF used in stars.js — that is what
   *  makes the field look real rather than uniformly speckled. */
  magMin: -1.4,
  magMax: 5.9,
  /** Radiance of a magnitude-0 star before atmospheric extinction. */
  mag0Radiance: 9.0,
  /** Point sprite size in pixels for a magnitude-0 star, at 720p. Scaled by the
   *  real viewport height so the sky does not change density with resolution. */
  mag0SizePx: 4.6,
  refHeightPx: 720,
  minSizePx: 1.0,
  /** Fraction of stars pulled into the galactic band. */
  milkyWayFraction: 0.42,
  /** Angular half-width of the band, radians. */
  milkyWaySigma: 0.20,
  /** Scintillation. Amplitude scales with airmass — a star overhead barely
   *  twinkles, one at 10 degrees elevation boils. */
  twinkleAmp: 0.34,
  twinkleHzMin: 1.1,
  twinkleHzMax: 4.3,
  /** Diffraction spike length as a fraction of the sprite, for the brightest
   *  few. Cheap, and it is what makes a bright star read as bright rather than
   *  as a big dot. */
  spike: 0.55,
  spikeMagnitude: 1.6,
};

/** Cloud layers. Two of them: high thin cirrus and a low broken deck. */
export const CLOUDS = {
  /** Altitude of each layer, km. The dome intersects a sphere at Rg+alt, so
   *  clouds compress toward the horizon the way real ones do instead of
   *  stretching to infinity the way a flat plane makes them. */
  highAlt: 7.0,
  lowAlt: 1.9,
  /** Noise scale, cycles per km at the intersection point. */
  highScale: 0.055,
  lowScale: 0.085,
  /** Drift, km/s. Real cloud drift is ~0.01 km/s; this is 6x that because a
   *  ten-minute play session must show movement. */
  highDrift: [0.055, 0.021],
  lowDrift: [0.030, -0.014],
  /** Coverage: the fbm value above which cloud exists. Lower = more cloud. */
  highCoverage: 0.56,
  lowCoverage: 0.62,
  /** Softness of the coverage threshold. */
  highSoft: 0.30,
  lowSoft: 0.24,
  /** Optical depth multiplier once inside a cloud. */
  highDensity: 0.55,
  lowDensity: 1.5,
  /** How much moonlight makes it through the deck and lights the underside. */
  silverLining: 1.9,
};

/**
 * HEIGHT FOG. The highest-value thing this subsystem owns.
 *
 * A dark-fantasy crypt without fog reads as a grey box. With it, the same room
 * reads as Diablo: the far wall desaturates, the near flagstones stay contrasty,
 * and the eye is told how big the room is before it is told anything else.
 */
export const FOG = {
  /** Extinction at the reference height, per metre. Over 25 m of horizontal
   *  sight at chest height this is ~0.9 optical depths — the back wall keeps
   *  about 40% of its contrast, which is the Diablo IV look. */
  density: 0.048,
  /**
   * HEIGHT-INDEPENDENT extinction, per metre. This term is what actually
   * separates depth in an isometric frame, and leaving it out is a subtle,
   * expensive mistake.
   *
   * The reason: through a purely exponential-in-height fog, the optical depth
   * of a ray that ends on the FLOOR is `density * height / |dir.y|` — the
   * camera's own altitude cancels out entirely. At this camera's fixed 52 degree
   * pitch, `|dir.y|` only ranges from 0.93 at the bottom of frame to 0.57 at the
   * top, so pure height fog varies the transmittance across the whole visible
   * floor by about 14%. That is invisible. A uniform term scales with the actual
   * distance travelled and gives the far wall genuinely more haze than the near
   * flagstones, which is the entire point of the effect.
   *
   * Kept well under the height term so the fog still reads as something lying in
   * the room rather than as a global filter.
   */
  densityUniform: 0.0105,
  /** Exponential scale height, metres. Small: this is a fog that sits IN the
   *  room, not an atmosphere. Above ~15 m it is gone, which keeps vault
   *  ceilings crisp and stops the fog from eating the architecture. */
  height: 5.2,
  /** World Y the density is quoted at. */
  baseY: 0.0,
  /** Hard cap on the marched/analytic distance, metres. Beyond the camera far
   *  plane there is nothing to fog. */
  maxDistance: 110.0,
  /**
   * Fraction of extinction that is scattering rather than absorption.
   *
   * Real fog is almost pure scattering (0.98) and looks it: bright, milky, and —
   * in a frame that is 60% floor — a full-screen wash that lifts every black and
   * flattens the image. 0.70 makes the fog absorb as much as it scatters, so the
   * far end of a hall goes DARK and low-contrast rather than pale and
   * low-contrast. That is the difference between a crypt and a morning meadow,
   * and it is the single most important number in this file.
   */
  albedo: 0.74,
  /** Henyey-Greenstein asymmetry for the fog itself. Forward-scattering, so a
   *  brazier between the camera and a wall throws a visible cone. */
  g: 0.58,
  /** Backward lobe weight, for the second HG term. Real fog has a small
   *  retro-reflective lobe and it is what makes fog glow around a light you are
   *  looking straight at. */
  gBack: -0.32,
  backWeight: 0.22,

  /** 3D noise modulation. `floor` is the density that survives where the noise
   *  is zero, so the fog never fully disappears; `gain` is how much the noise
   *  adds on top. floor + gain should stay near 1 so the mean density matches
   *  `density`. */
  noiseFloor: 0.28,
  noiseGain: 1.05,
  /** Cycles per metre for the two octaves the march samples. 0.09 is an 11 m
   *  bank — big enough to span a corridor, small enough that a hall contains
   *  three of them. At the 19 m cycle this started at, a whole room sat inside
   *  one lobe of the noise and the fog read as perfectly uniform. */
  noiseScale: 0.09,
  noiseScale2: 0.40,
  /** Drift in metres/second. Slow — fog that moves at a visible speed reads as
   *  smoke, and smoke reads as a fire that is not there. */
  noiseDrift: [0.055, 0.012, 0.035],
  noiseDrift2: [-0.09, 0.03, 0.06],

  /** Ambient in-scatter multiplier applied to the sky colour. The fog in an
   *  unlit corner is lit only by the sky, and in a sealed crypt not even by
   *  that, so this is deliberately low; the warm glow near a brazier has to come
   *  from the brazier or the whole effect is a grey wash. */
  ambientScale: 0.24,
  /** Extra ambient near the floor, where bounce off the flagstones actually
   *  reaches the fog. */
  groundBounce: 0.34,
};

/**
 * VOLUMETRIC LIGHT SHAFTS.
 *
 * Quarter resolution, blue-noise dithered start offset, temporal accumulation,
 * bilateral upsample. Every one of those four is load-bearing: drop the dither
 * and you get concentric bands, drop the temporal and the dither becomes visible
 * noise, drop the bilateral and the fog haloes around every silhouette.
 */
export const VOLUME = {
  /** Divisor on the internal render resolution. 4 => 320x180 at 720p. Do not
   *  raise this on a software rasteriser: the march is 12 dependent texture
   *  fetches per pixel and going to half res quadruples it. */
  divisor: 4,
  /** March steps by quality tier. These are the most expensive numbers in this
   *  file — each one is (steps x pixels) texture fetches per frame, paid on
   *  every frame of every other agent's capture loop. With a blue-noise start
   *  offset, analytic segment integration and a 0.90 temporal filter behind it,
   *  ten steps is indistinguishable from twenty and costs half as much; the
   *  capture harness runs at `ultra`, so `ultra` is deliberately not extravagant. */
  steps: { low: 0, medium: 7, high: 9, ultra: 10 },
  /** Distribution exponent for the step positions along the ray. 1.0 is uniform;
   *  above 1 clusters samples near the camera, which is where the fog is thick,
   *  where the light sources are, and where the eye is looking. */
  stepPower: 1.55,
  /** Point lights sampled in the march, by tier. Each costs one attenuation
   *  evaluation and — only when it survives the contribution early-out — one
   *  screen-space occlusion probe, per step. Three is the point past which a
   *  fourth brazier's fog glow is below the dither floor in every frame tested. */
  lights: { low: 0, medium: 2, high: 3, ultra: 3 },
  /** Shadow map taps per step for the directional key. One tap plus the blue
   *  noise offset plus temporal accumulation resolves as cleanly as four taps
   *  and costs a quarter as much. */
  shadowTaps: 1,
  /** Half-width of the blue-noise-rotated shadow tap offset, in shadow texels.
   *  Softens the shaft edge so it does not alias into the low-res buffer. */
  shadowJitterTexels: 1.6,

  /** Temporal feedback for the low-res buffer. High, because the march is very
   *  noisy per frame and the camera moves slowly; the depth-rejection below is
   *  what stops it from smearing. */
  feedback: 0.90,
  /** Reject history when the reprojected depth differs by more than this
   *  fraction of the current depth. */
  depthReject: 0.06,
  /** Camera translation, in metres, that forces the whole history to be dropped
   *  — a shot teleport must not smear the previous room across the new one. */
  teleportDistance: 1.5,

  /** Bilateral upsample depth tolerance, in metres of linear depth. */
  upsampleDepthSigma: 0.55,
  /** Strength of the marched in-scatter in the final composite. 1.0 is
   *  physically neutral; the shafts want a little more than neutral to read
   *  through AgX's shoulder. */
  intensity: 1.05,
  /**
   * Multiplier on the DIRECTIONAL (moon) shaft only. The moon shaft through a
   * broken vault is a hero moment and gets to cheat — but only a little. At the
   * 2.6 this started at, moonlit fog was twice as bright as the moonlit stone
   * under it and the whole frame turned into a blue wash; the shaft has to stay
   * near the irradiance that produced it or it reads as a filter over the
   * picture rather than as light in the room.
   */
  moonShaftBoost: 0.85,
  /**
   * Multiplier on the PUNCTUAL (brazier, shrine, spell) in-scatter.
   *
   * Deliberately larger than the moon's, and that asymmetry is the whole art
   * direction in one number. In a crypt the brazier IS the key light: the fog it
   * lights should be the brightest thing in the frame after the flame itself,
   * and the fog ten metres away should be nearly black. Boosting the local
   * sources and cutting the global one converts the fog from a uniform veil —
   * which auto-exposure immediately punishes by stopping the whole frame down —
   * into local contrast, which is what reads as atmosphere.
   */
  localShaftBoost: 1.75,
  /** Screen-space occlusion probe for point lights. There is no shadow map for
   *  a brazier, so the march probes the camera depth buffer at a point biased
   *  toward the light: if that point is behind visible geometry the sample is
   *  very likely occluded from the light too. Wrong at grazing angles, right
   *  often enough that a shaft stops passing through a wall. */
  ssOcclusionBias: 0.62,
  ssOcclusionSoft: 0.45,
};

/** Ground mist: the low card that pools on the floor and is parted by the
 *  player. Separate from the height fog because it is a SURFACE effect — it
 *  needs to react to things standing in it, which a screen-space integral
 *  cannot do. */
export const MIST = {
  /** Card size in metres and its tessellation. 48x48 covers the whole visible
   *  ground at boom 30 with room to spare. */
  size: 52.0,
  segments: 40,
  /** Height of the card above the floor, and the vertical thickness the
   *  fragment shader fakes for the soft-depth fade. */
  y: 0.10,
  thickness: 1.05,
  /** Peak opacity inside a bank. */
  opacity: 0.40,
  /** Noise scale (cycles per metre) and drift (metres/second). */
  scale: 0.055,
  scale2: 0.17,
  drift: [0.030, 0.017],
  drift2: [-0.021, 0.011],
  /** Coverage threshold and softness — this is what makes the mist POOL in
   *  patches instead of covering the floor uniformly. A high threshold with a
   *  narrow ramp gives distinct banks with clear floor between them; a low
   *  threshold with a wide ramp gives a bedsheet. */
  coverage: 0.46,
  soft: 0.26,
  /** Fade with distance from the camera focus, in metres. The card is finite;
   *  without this its edge is a visible straight line across the floor. */
  fadeStart: 14.0,
  fadeEnd: 25.0,
  /** Soft-depth fade distance in metres — how far behind the mist the geometry
   *  has to be before the mist is at full opacity. Kills the hard intersection
   *  line where the card meets a wall. */
  softDepth: 0.85,
  /** Displacement. Up to this many pushers (player + explosions) part the mist;
   *  each one clears a hole of `pushRadius` metres that heals in `pushDecay`
   *  seconds. */
  pushers: 6,
  playerRadius: 1.25,
  explosionRadius: 4.2,
  pushDecay: 1.5,
  /** How far the noise is dragged outward at the rim of a pusher, metres. This
   *  is what turns a hole into a bow wave. */
  swirl: 1.15,
};

/** Sky dome geometry. Radius must be inside `CAMERA.far` (140 m) and outside
 *  anything `world` will ever build. */
export const DOME = {
  radius: 118.0,
  widthSegments: 40,
  heightSegments: 24,
  /** Draw order among opaque objects. Deliberately last, so the depth buffer is
   *  already full of geometry and early-Z rejects every hidden sky pixel — the
   *  dome shader is the most expensive per-pixel shader this subsystem owns and
   *  in a crypt 90% of the frame never runs it. */
  renderOrder: 900,
  starOrder: 901,
};

/** IBL / environment map. */
export const IBL = {
  /** Equirect resolution generated on the CPU before PMREM. PMREM blurs
   *  everything above roughness 0.1 into oblivion anyway, so the only thing a
   *  bigger map buys is a sharper moon in a mirror, and there are no mirrors in
   *  a crypt. */
  width: 128,
  height: 64,
  /** Multiplier into `scene.environmentIntensity`. */
  intensity: 1.0,
  /**
   * Fraction of a local light's irradiance that comes back as BOUNCE, written
   * into the environment map from that light's direction.
   *
   * This is a bounce term, not the light itself: the brazier is already a real
   * point light illuminating every surface directly, and the env map exists to
   * carry the light that has hit a wall and come back. Off crypt stone at
   * albedo 0.055 that is a few percent, and 0.10 is already generous. (The first
   * version of this file used 0.55, which put a blown-out orange sun in the
   * environment and warm-tinted every surface in the level regardless of how far
   * it was from any fire — exactly the cold/warm contrast the art direction is
   * built on, destroyed by one constant.)
   */
  localBounce: 0.10,
  /** Angular radius of the blob each local light writes into the map, radians.
   *  Wide, because a brazier is an area source seen from a few metres — but not
   *  so wide that it stops reading as a direction. */
  localBlobRadius: 0.40,
  /** How much of a local light's irradiance reaches the floor and bounces back
   *  up into the lower hemisphere. Small for the same reason as `localBounce`,
   *  and smaller still because the env map is a GLOBAL term: a value tuned for
   *  the room with the brazier in it is applied to every room without one. */
  localGroundWeight: 0.18,
  /** Minimum seconds between regenerations. PMREM on a software rasteriser is
   *  ~150 ms; doing it per frame would dominate the frame. */
  minInterval: 2.5,
  /** Ground albedo used for the bounce hemisphere. Matches ENV.flagstone. */
  groundAlbedo: [0.055, 0.055, 0.060],
};

/** Resolve the per-tier integer budgets for the active quality preset. */
export function budgetsFor(config) {
  const name = config.quality in VOLUME.steps ? config.quality : 'high';
  const on = config.q.volumetrics !== false;
  return {
    tier: name,
    steps: on ? VOLUME.steps[name] : 0,
    lights: on ? VOLUME.lights[name] : 0,
    divisor: VOLUME.divisor,
    enabled: on && VOLUME.steps[name] > 0,
  };
}
