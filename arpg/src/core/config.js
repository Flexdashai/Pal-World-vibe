/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the quality
 * scaler and the capture harness can drive everything from one place.
 */

export const SIM_HZ = 60;
export const FIXED_DT = 1 / SIM_HZ;
/** Never simulate more than this many fixed steps in one frame (spiral-of-death
 *  guard). Critical in this container: a 1.2 s software-rendered frame would
 *  otherwise try to catch up 72 steps. */
export const MAX_SUBSTEPS = 5;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 1.9,
  playerHeight: 1.82,
  playerRadius: 0.36,
  /** Grid cell of the dungeon generator. Rooms are integer multiples of this. */
  cell: 2.0,
};

/**
 * The isometric camera. Fixed yaw/pitch — the whole art direction, from occluder
 * fading to how tall a wall may be, is derived from these three numbers, so they
 * live here and nothing else may redefine them.
 */
export const CAMERA = {
  yaw: Math.PI * 0.25,        // 45°, classic isometric
  pitch: -0.9076,             // -52°
  fov: 34,                    // vertical, degrees — long lens, low distortion
  boom: 21.0,                 // metres from focus to eye
  boomMin: 14.0,
  boomMax: 30.0,
  /** Focus point sits below the player so they land at the lower third. */
  focusLift: 0.9,
  /** Seconds for the boom to catch up to the player (critically damped).
   *  Kept short on purpose: the player judges responsiveness by when the CAMERA
   *  starts moving, not by when the character does, so a long follow reads as
   *  input lag even when input is being sampled the same frame it arrives. */
  followTime: 0.09,
  near: 1.0,
  far: 140.0,
};

export const QUALITY_PRESETS = {
  low: {
    renderScale: 0.7,
    shadowMapSize: 1024, cascades: 2, shadowDistance: 34,
    taa: false, gtao: false, ssr: false, volumetrics: false,
    bloom: true, bloomLevels: 4, dof: false, grain: true,
    anisotropy: 4, textureSize: 256,
    particleBudget: 3000, decalBudget: 64, maxActors: 40, maxLights: 8,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048, cascades: 3, shadowDistance: 46,
    taa: true, gtao: true, ssr: false, volumetrics: true,
    bloom: true, bloomLevels: 5, dof: false, grain: true,
    anisotropy: 8, textureSize: 512,
    particleBudget: 8000, decalBudget: 128, maxActors: 60, maxLights: 12,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048, cascades: 3, shadowDistance: 56,
    taa: true, gtao: true, ssr: true, volumetrics: true,
    bloom: true, bloomLevels: 6, dof: true, grain: true,
    anisotropy: 16, textureSize: 1024,
    particleBudget: 16000, decalBudget: 256, maxActors: 90, maxLights: 16,
  },
  ultra: {
    renderScale: 1.0,
    shadowMapSize: 4096, cascades: 4, shadowDistance: 70,
    taa: true, gtao: true, ssr: true, volumetrics: true,
    bloom: true, bloomLevels: 6, dof: true, grain: true,
    anisotropy: 16, textureSize: 1024,
    particleBudget: 28000, decalBudget: 512, maxActors: 120, maxLights: 20,
  },
};

export const DEFAULTS = {
  quality: 'high',
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
  /** Dungeon seed. Capture uses a fixed one so critics review the same level. */
  seed: 0x4d4f4e41, // 'MONA'
  /** Master gameplay tuning knobs other systems agree on. */
  hitstopMax: 0.14,
  shakeMax: 1.0,
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}
