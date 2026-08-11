/**
 * Renderer art-direction constants.
 *
 * `config.q` owns the QUALITY budgets (how many samples, how big a shadow map).
 * `palette.js` owns COLOUR. This file owns the third category: the photographic
 * and physical parameters of the camera/film that neither of those describes —
 * exposure metering, bloom energy, AO radius in metres, SSR march length.
 *
 * Every number here has been tuned against the two references. Where a value is
 * not obvious the comment says what it is compensating for, because "0.75" with
 * no reason attached is exactly how a renderer rots.
 */

export const TUNE = {
  /**
   * Auto-exposure. The scene is lit with candela-scale intensities from
   * palette.LIGHTS, so the correct exposure is a real photographic one:
   * EV100 = log2(avgLum * 100 / K) with the standard reflected-light constant.
   */
  exposure: {
    /** Reflected-light meter calibration. 12.5 is the ISO/Sekonic standard. */
    K: 12.5,
    /**
     * Extra stops on top of the metered value.
     *
     * An uncompensated reflected-light meter renders the scene average as 18%
     * grey, which is exactly the "flat grey dungeon" failure — it is the meter
     * doing its job and the job being the wrong one. -2.35 EV puts the average
     * near 4%, so the unlit two thirds of a crypt stay unlit and the brazier
     * owns the whole top of the range.
     *
     * This number has to be big enough that COMPENSATION, not the clamp below,
     * is what determines the exposure for a normal frame. If the clamp is doing
     * the work then the exposure has quietly stopped being metered and has
     * become the magic multiplier this system exists to avoid.
     */
    compensationEV: -2.35,
    /**
     * Adaptation range. Deliberately narrow, and that is the point: a fully
     * unconstrained auto-exposure normalises every room to the same brightness,
     * which destroys the difference between a lit hall and a black corridor —
     * the difference the whole art direction is built on. +-2 stops of travel
     * lets the eye adapt without letting it erase the level design.
     */
    minEV: -2.0,
    maxEV: 12.0,
    /** Adaptation time constants, seconds. Human iris adapts to bright much
     *  faster than to dark; matching that is most of why exposure changes read
     *  as natural instead of as a fade. */
    tauUp: 0.55,   // scene got brighter -> stop down quickly
    tauDown: 1.9,  // scene got darker  -> open up slowly
    /** Centre-weighted metering: the player is at the lower third, and the top
     *  of frame is usually distant fog. Weight the centre so a bright wall at
     *  the frame edge does not stop the hero down. */
    centreWeight: 0.62,
  },

  /**
   * Bloom. Energy-conserving: the final image is a LERP toward the blurred
   * pyramid, not an additive halo, so total energy is preserved and there is no
   * threshold to tune (and therefore no "everything above 1.0 pops" artefact).
   */
  bloom: {
    /** Fraction of the final image taken from the pyramid. 0.055 is the
     *  Call-of-Duty-style value; above ~0.09 the whole frame goes milky. */
    strength: 0.062,
    /** Radius multiplier on the tent filter during upsampling, in texels. */
    filterRadius: 0.85,
    /** The pyramid starts at quarter resolution. On a software rasteriser a
     *  half-res base costs 4x the fill for a difference nobody can see: bloom
     *  is by definition low frequency. */
    baseDivisor: 4,
    /** Karis average weight on the first downsample only — kills fireflies from
     *  single very bright pixels (sparks) without dulling large emitters. */
    karis: true,
  },

  /**
   * Ground-truth ambient occlusion. Radius is in METRES because the scene is in
   * metres; a screen-space radius would make AO change as the camera zooms.
   */
  gtao: {
    radius: 1.5,
    /** Samples never travel further than this many HALF-RES pixels. This is a
     *  contact-occlusion pass, not a global-illumination one: past ~50 half-res
     *  pixels the samples are so far apart that they add noise rather than
     *  occlusion, and every one of them is a dependent texture fetch. */
    maxRadiusPx: 56,
    /** Thickness heuristic: how deep behind the depth buffer a sample is still
     *  considered a real occluder rather than a floating sliver. */
    thickness: 0.35,
    /** Final AO is pow(ao, power) * intensity. The crevices ARE the art
     *  direction here, so this is deliberately stronger than physically exact. */
    power: 1.7,
    intensity: 1.0,
    /** Temporal accumulation feedback. High, because GTAO with 2 slices is very
     *  noisy on a single frame and the camera moves slowly. */
    feedback: 0.92,
    /** Depth difference (metres) beyond which a neighbour is rejected by the
     *  bilateral blur. Small, or AO bleeds across silhouettes. */
    depthSigma: 0.12,
  },

  /**
   * Screen-space reflections. This is what makes stone read WET.
   */
  ssr: {
    /** Ray length in metres. Long enough to reach a brazier across a hall. */
    maxDistance: 16.0,
    /** Coarse march steps, then binary refinement iterations. The steps grow
     *  geometrically so the near field — where the contact reflection that sells
     *  wetness lives — is sampled densely while the ray still crosses the whole
     *  room. Fourteen steps at that growth rate places the first sample ~9 cm
     *  from the surface and the last at `maxDistance`. */
    steps: 14,
    refine: 4,
    /** Depth thickness for a hit, in metres. Too small and the ray tunnels
     *  through thin geometry; too large and everything reflects the wall
     *  behind it. */
    thickness: 0.55,
    /** Above this roughness the pass early-outs entirely. Most of a crypt is
     *  rough stone; skipping it is the single biggest SSR saving and costs
     *  nothing visually because a rough reflection at 0.6+ is indistinguishable
     *  from the env map it is being composited on top of. */
    maxRoughness: 0.62,
    /** Reflection strength multiplier. SSR is composited additively on top of
     *  the env-map specular, so it must stay under 1 or wet floors blow out. */
    intensity: 0.85,
    /** Screen-edge fade width in UV. Reflections that walk off screen must
     *  vanish smoothly or the frame gets a hard bright border. */
    edgeFade: 0.14,
    /** Temporal feedback for the half-res reflection buffer. */
    feedback: 0.86,
  },

  /**
   * TAA. The jitter pattern is Halton(2,3); 8 samples converge fast enough that
   * a 14-frame capture settle is fully resolved.
   */
  taa: {
    samples: 8,
    /** History weight. 0.92 is aggressive but the camera is slow and the
     *  variance clip is doing the heavy lifting. */
    feedback: 0.9,
    /** Neighbourhood clip box widening, in standard deviations. Below ~0.8 the
     *  image visibly buzzes; above ~1.5 fast enemies ghost. */
    varianceGamma: 1.15,
    /** Sharpen applied during resolve using the 3x3 neighbourhood we already
     *  fetched for the clip box. Counteracts the bilinear history softening. */
    sharpen: 0.34,
    /** Extra current-frame weight per UV/frame of motion — disocclusion around
     *  a running character otherwise smears for ~10 frames. */
    motionBoost: 22.0,
  },

  /**
   * Depth of field. Deliberately tiny: the goal is the gentle top/bottom
   * falloff a real Diablo IV frame has, not a photographic bokeh effect.
   */
  dof: {
    /** Max circle of confusion in FULL-res pixels. Above ~7 it stops reading as
     *  production value and starts reading as a bug. */
    maxCoCPx: 6.0,
    /** Metres in front of / behind the focus plane before blur starts. The
     *  fixed 52-degree pitch means "behind the focus plane" is the top of the
     *  frame and "in front" is the bottom, which is exactly what we want. */
    nearRange: 5.5,
    farRange: 13.0,
    /** Focus is pulled to the player, lifted slightly so their head and the
     *  ground at their feet are both inside the sharp zone. */
    focusLift: 0.6,
    /** Bokeh taps on the golden-angle spiral, at half resolution. With a max CoC
     *  of six full-resolution pixels, six taps already over-sample the disc. */
    taps: 6,
  },

  /** Final-image film treatment. All three are "you notice when they are gone,
   *  never when they are there". */
  film: {
    /** Vignette: (start, end) in normalised radius from centre, and strength. */
    vignetteStart: 0.38,
    vignetteEnd: 1.28,
    vignetteStrength: 0.62,
    /** Lateral chromatic aberration in pixels at the frame corner. */
    chromaPx: 1.35,
    /** Grain is applied in perceptual space and scaled DOWN in highlights, the
     *  way real film grain behaves (shadow grain is coarse, highlight grain is
     *  fine). */
    grainStrength: 0.032,
    grainSize: 1.35,
  },

  /**
   * Occluder fade. The hole punched in geometry standing between the camera and
   * the player, in normalised screen units (aspect-corrected on X).
   */
  occluder: {
    radius: 0.155,
    /** Fraction of the radius that is fully transparent before the dither ramp
     *  starts. */
    core: 0.5,
    /** Seconds to fade in / out. Snapping reads as a pop; 0.12 s reads as a
     *  camera choice. */
    fadeTime: 0.11,
    /** How opaque a faded occluder is allowed to stay. Never 0 — a completely
     *  invisible wall destroys the reading of the space. */
    minAlpha: 0.12,
  },

  /**
   * Shadows. The camera yaw and pitch are FIXED, so the visible ground region is
   * a fixed-shape parallelogram that only translates. That means one tight
   * shadow map is strictly better than cascades: no cascade seams, no blend
   * band, and every texel is spent on ground the player can actually see.
   */
  shadow: {
    /** Metres of ground the map covers, measured along the view direction. The
     *  visible ground at boom 24 / fov 34 is roughly 26 x 30 m; padding to 40
     *  covers the boom range in config.CAMERA plus casters just off-screen. */
    extent: 40.0,
    /** Extra metres pushed toward the light so tall geometry outside the
     *  parallelogram still casts into it. */
    depthPad: 42.0,
    /** Constant depth bias in shadow-map NDC. Kept small because normal-offset
     *  does the real work; constant bias is what causes peter-panning. */
    bias: -0.00028,
    /** Normal offset in world units at the map's texel scale. Scaled by the
     *  texel size so it stays correct if the map size changes. */
    normalBiasTexels: 1.35,
    /** PCSS blocker search radius, in texels. */
    blockerRadius: 7.0,
    /** Tap counts. These are multiplied by every lit pixel in the frame, so they
     *  are the most expensive numbers in this file. Six + eight with a per-pixel
     *  rotated kernel and TAA behind it is visually indistinguishable from
     *  sixteen + thirty-two and costs a third as much. */
    blockerSamples: 5,
    /** Penumbra clamp, in texels. The lower bound keeps a 6-tap kernel from
     *  aliasing at a contact point; the upper bound is what stops a distant arch
     *  from turning into a grey smear. */
    minPenumbra: 1.2,
    maxPenumbra: 12.0,
    /**
     * Softening rate: TEXELS of penumbra per METRE of gap between the occluder
     * and the surface receiving its shadow.
     *
     * Expressing it this way rather than as an opaque "light size" constant is
     * what makes the term survive a change to the shadow map size or the fitted
     * ortho depth range — both of which change what a unit of shadow-map depth
     * means, and either of which silently turns a hardcoded constant into the
     * wrong number. `ShadowFitter` converts this to `light.shadow.radius` every
     * frame from the camera it actually fitted.
     *
     * At 26 mm/texel, 3 texels per metre means: a chain hanging 5 cm off a wall
     * gets a ~3 cm penumbra (visually sharp), and an arch 4 m above the floor
     * gets ~31 cm (visibly soft). That contrast is the whole point of PCSS.
     */
    penumbraTexelsPerMetre: 3.0,
    pcfSamples: 6,
  },

  /** How many punctual light slots the forward shader is compiled for. See
   *  ARCHITECTURE.md "The visible point-light count is a shader permutation
   *  key" — this number must NEVER change after the first compile. */
  lights: {
    /** Fraction of config.q.maxLights actually given a shader slot. The rest of
     *  the budget is spent on lights that exist and are culled to zero
     *  intensity, which costs nothing in the shader. Forward-shading a crypt
     *  with more than 8 per-pixel point lights is pure waste: past the 6th
     *  nearest brazier the contribution is below the dither floor. */
    slotFraction: 0.5,
    minSlots: 4,
    maxSlots: 8,
    /** Spot lights are expensive and rare here. Slots are only allocated if
     *  something actually registers one, and then the count is frozen. */
    spotSlots: 2,
    /** Directional slots: moon key + moon bounce. Frozen at 2. */
    dirSlots: 2,
  },

  /** Indirect/ambient floor. `sky` provides the env map; until it does, a tiny
   *  hemispheric term keeps unlit geometry from being pure void, which reads as
   *  a hole in the frame rather than as darkness. */
  ambient: {
    /** Multiplier applied to whatever env map `sky` hands us. */
    envIntensity: 1.0,
  },
};

/** Halton radical inverse — deterministic, no RNG, used for the TAA jitter. */
export function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** The TAA jitter sequence, precomputed at module load so `update()` allocates
 *  nothing. Centred on 0 so the mean projection is the unjittered one. */
export function buildJitterTable(count) {
  const t = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    t[i * 2 + 0] = halton(i + 1, 2) - 0.5;
    t[i * 2 + 1] = halton(i + 1, 3) - 0.5;
  }
  return t;
}
