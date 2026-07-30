/**
 * The game's colour identity, in ONE place.
 *
 * MONARCH is a near-monochrome dark-fantasy world — cold desaturated stone, warm
 * dirty firelight — with exactly one saturated colour allowed to dominate: the
 * violet of shadow magic. That contrast is the entire Solo Leveling read. If spell
 * colours get hardcoded across subsystems it erodes within three agents, so every
 * subsystem imports from here.
 *
 * Values are LINEAR-space RGB triples unless the name says `srgb`. Three's
 * `Color.setRGB(r,g,b, THREE.LinearSRGBColorSpace)` takes them directly; anything
 * going into CSS wants `.srgb`.
 */

/** Element identity. `core` is the hot centre, `glow` the bloom/light colour,
 *  `dark` the deep edge used for smoke and trails. */
export const ELEMENTS = {
  physical: {
    core: [0.85, 0.83, 0.78], glow: [1.0, 0.94, 0.82], dark: [0.18, 0.17, 0.16],
    srgb: '#d9d4c8', light: [1.0, 0.93, 0.80],
  },
  shadow: {
    // The signature. #7B4BFF core / #C9A8FF hot.
    core: [0.19, 0.075, 1.0], glow: [0.60, 0.40, 1.0], dark: [0.045, 0.02, 0.14],
    srgb: '#7b4bff', light: [0.52, 0.30, 1.0],
  },
  fire: {
    core: [1.0, 0.36, 0.06], glow: [1.0, 0.62, 0.22], dark: [0.16, 0.045, 0.012],
    srgb: '#ff8a3c', light: [1.0, 0.55, 0.20],
  },
  frost: {
    core: [0.34, 0.72, 1.0], glow: [0.70, 0.92, 1.0], dark: [0.04, 0.10, 0.17],
    srgb: '#6fc7ff', light: [0.48, 0.78, 1.0],
  },
  lightning: {
    core: [0.62, 0.80, 1.0], glow: [0.92, 0.96, 1.0], dark: [0.08, 0.11, 0.18],
    srgb: '#b6d8ff', light: [0.70, 0.85, 1.0],
  },
  holy: {
    core: [1.0, 0.88, 0.55], glow: [1.0, 0.96, 0.80], dark: [0.18, 0.14, 0.07],
    srgb: '#ffe08c', light: [1.0, 0.90, 0.65],
  },
  blood: {
    core: [0.42, 0.028, 0.022], glow: [0.62, 0.06, 0.05], dark: [0.055, 0.006, 0.005],
    srgb: '#8e1410', light: [0.5, 0.05, 0.04],
  },
};

/** Item rarity — beam colour, ground label, and the border of the tooltip. */
export const RARITY = {
  common:    { srgb: '#b9b3a6', linear: [0.48, 0.44, 0.38], beam: 0.25, name: 'Common' },
  magic:     { srgb: '#5c8cff', linear: [0.10, 0.26, 1.0],  beam: 0.7,  name: 'Magic' },
  rare:      { srgb: '#ffd34d', linear: [1.0, 0.62, 0.06],  beam: 1.0,  name: 'Rare' },
  legendary: { srgb: '#ff8a2b', linear: [1.0, 0.24, 0.02],  beam: 1.6,  name: 'Legendary' },
  mythic:    { srgb: '#c9a8ff', linear: [0.58, 0.38, 1.0],  beam: 2.4,  name: 'Mythic' },
};

/** Environment / architecture base colours. Deliberately narrow and desaturated —
 *  everything interesting comes from light, wear and grime, not from hue. */
export const ENV = {
  stoneCold:   [0.062, 0.064, 0.072],
  stoneWarm:   [0.085, 0.078, 0.068],
  flagstone:   [0.055, 0.055, 0.060],
  mortar:      [0.098, 0.094, 0.086],
  dirt:        [0.048, 0.040, 0.031],
  ash:         [0.070, 0.068, 0.066],
  bone:        [0.42, 0.395, 0.33],
  ironDark:    [0.045, 0.046, 0.050],
  gold:        [0.72, 0.53, 0.20],
  moss:        [0.038, 0.055, 0.028],
  wood:        [0.058, 0.040, 0.026],
  cloth:       [0.075, 0.055, 0.048],
  crystal:     [0.30, 0.20, 0.62],
};

/** Light rig. Intensities are physical-ish (candela-scale) and are consumed by
 *  render's exposure system, not multiplied ad hoc. */
export const LIGHTS = {
  moon:        { color: [0.42, 0.52, 0.78], intensity: 0.55 },
  moonBounce:  { color: [0.14, 0.18, 0.30], intensity: 0.22 },
  brazier:     { color: [1.0, 0.42, 0.13], intensity: 26.0, radius: 11.0 },
  candle:      { color: [1.0, 0.52, 0.20], intensity: 3.2,  radius: 4.0 },
  shadowRift:  { color: [0.35, 0.16, 1.0], intensity: 18.0, radius: 9.0 },
  playerRim:   { color: [0.45, 0.30, 0.95], intensity: 2.4 },
};

/** UI chrome — the Diablo bottom bar and the Solo Leveling SYSTEM window. */
export const UI = {
  systemBlue:   '#6fd4ff',
  systemFill:   'rgba(14, 34, 54, 0.72)',
  systemEdge:   'rgba(140, 220, 255, 0.85)',
  hpRed:        '#c0261f',
  hpRedDark:    '#4a0d0a',
  manaViolet:   '#6b3ee0',
  manaDark:     '#221046',
  frameBrass:   '#7a6742',
  frameDark:    '#171412',
  textPrimary:  '#e8e2d4',
  textDim:      '#9a9486',
  xpGold:       '#e0b545',
  critYellow:   '#ffd76b',
  critWhite:    '#fff4d0',
};

/** `#rrggbb` for an element, for DOM/UI use. */
export function elementCss(el) {
  return (ELEMENTS[el] ?? ELEMENTS.physical).srgb;
}

/** Linear RGB triple for an element channel, with a safe fallback. */
export function elementRgb(el, channel = 'core') {
  return (ELEMENTS[el] ?? ELEMENTS.physical)[channel] ?? ELEMENTS.physical.core;
}
