/**
 * UI design tokens + timing curves.
 *
 * Everything visual in this subsystem resolves through here so the two visual
 * languages stay internally consistent:
 *
 *   A. THE DIABLO HUD — tarnished brass, engraved slate, warm dirty gold. It
 *      hugs the bottom of the frame and never uses a pure hue: every "brass" is
 *      a ramp from umber through gold to a bleached highlight, because a single
 *      flat gold is the fastest way to make a HUD look like a hobby project.
 *   B. THE SYSTEM WINDOW — hard cyan on translucent navy, monospaced, uppercase.
 *      Deliberately the only element in the game with a 1px hairline border and
 *      zero texture: it is a notification from outside the world, so it must not
 *      share a single material cue with the rest of the HUD.
 *
 * COLOURS come from `core/palette.js` (UI / ELEMENTS / RARITY). Nothing here
 * invents a hue; it only derives tints/shades of what palette declares, which is
 * why every function below takes a base and returns a variant.
 *
 * SIZES are authored for a 1280x720 frame and expressed in CSS as
 * `calc(N * var(--u))`. `--u` is set once per resize (see `metricsFor`), so the
 * whole HUD scales as one piece instead of drifting apart at other resolutions.
 */

import { UI, ELEMENTS, RARITY } from '../core/palette.js';

// ---------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------

/** `#rrggbb` -> [r,g,b] 0..255. Accepts `#rgb` too. */
export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Multiply toward black (`k<1`) or toward white (`k>1`, clamped). */
export function shade(hex, k) {
  const [r, g, b] = hexToRgb(hex);
  if (k <= 1) return rgbToHex(r * k, g * k, b * k);
  const t = Math.min(1, k - 1);
  return rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

/** `rgba()` string from a hex + alpha. Built at module load, never per frame. */
export function alpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Linear mix of two hex colours. */
export function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

// ---------------------------------------------------------------------------
// palette derivations
// ---------------------------------------------------------------------------

/**
 * The brass ramp. Tarnished metal is not one colour — it is a dark oxidised
 * base, a warm mid where the surface has been rubbed, a near-white specular
 * catch on the top bevel, and a green-black in the crevices. Five stops is the
 * minimum that reads as metal instead of as a beige rectangle.
 */
export const BRASS = {
  crevice: '#0a0907',
  dark: shade(UI.frameBrass, 0.24),
  base: shade(UI.frameBrass, 0.46),
  mid: shade(UI.frameBrass, 0.74),
  warm: shade(UI.frameBrass, 1.0),
  // The specular catch. Deliberately NOT near-white: the world is graded
  // near-monochrome and the only thing allowed to be bright and saturated is
  // shadow magic. A HUD whose brass highlight is #f4e2b0 pulls the eye off the
  // game and reads as polished stage-prop gold rather than crypt hardware.
  hot: mixHex(UI.frameBrass, '#d8c191', 0.42),
  verdigris: '#232b22',               // the green of oxidised copper in the pits
};

/** The slate the HUD sits on: near-black, faintly warm, never pure #000. */
export const SLATE = {
  deep: '#08070a',
  base: '#100e12',
  raised: '#191519',
  edge: '#241f22',
};

export const TEXT = {
  primary: UI.textPrimary,
  dim: UI.textDim,
  faint: shade(UI.textDim, 0.62),
  gold: UI.xpGold,
  crit: UI.critYellow,
  danger: UI.hpRed,
  system: UI.systemBlue,
};

/** Font stacks. The container ships DejaVu / Liberation / Bitstream Charter and
 *  nothing else, so these are the real, verified choices — not an aspirational
 *  stack that silently falls back to Times. */
export const FONT = {
  /** Engraved plate labels, item names, boss names. Charter is a sturdy
   *  transitional serif whose heavy stems survive being letterspaced at 10px. */
  display: '"Bitstream Charter", "DejaVu Serif", Georgia, serif',
  /** Everything numeric and every small label. DejaVu Sans has a large x-height
   *  and unambiguous digits, which is what a HUD needs at 11px. */
  sans: '"DejaVu Sans", "Liberation Sans", Arial, sans-serif',
  /** The SYSTEM window, exclusively. */
  mono: '"DejaVu Sans Mono", "Liberation Mono", ui-monospace, monospace',
};

/** Element colours, pre-resolved to CSS so no widget touches ELEMENTS directly. */
export const ELEMENT_CSS = Object.fromEntries(
  Object.entries(ELEMENTS).map(([k, v]) => [k, v.srgb])
);

export const RARITY_CSS = Object.fromEntries(
  Object.entries(RARITY).map(([k, v]) => [k, v.srgb])
);

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/**
 * The HUD is authored at 1280x720. `u` is the scalar every dimension multiplies
 * by. It is clamped: below 0.78 the 9px micro-labels stop being legible, and
 * above 1.7 the HUD starts eating a 4K frame.
 *
 * Note this deliberately uses `min(w/1280, h/720)` rather than height alone —
 * an ultrawide frame must not get a HUD wider than its own globes.
 */
export function metricsFor(w, h) {
  const u = Math.max(0.78, Math.min(1.7, Math.min(w / 1280, h / 720)));
  return { u, w, h };
}

/** Design-space sizes, in "u" units (multiply by `u` for device pixels). */
export const M = {
  globe: 148,          // outer diameter of the orb socket
  globeGlass: 112,     // the liquid-bearing glass sphere inside it
  globeInset: 18,      // distance from the screen corner
  slot: 58,            // skill slot side
  slotGap: 7,
  slotRound: 46,       // the two flanking round sockets (ultimate / arise)
  barLift: 20,         // skill bar's distance above the xp bar
  xpBar: 9,
  plinth: 118,         // height of the bottom ornament strip
  bossBar: 620,
  targetBar: 330,
  minimap: 158,
  systemWin: 430,
  panel: 940,
};

// ---------------------------------------------------------------------------
// timing + easing
// ---------------------------------------------------------------------------

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential approach. `rate` is per second. */
export const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

/** Overshoot for punch-in. `s=1.9` gives ~13% overshoot, which is the amount a
 *  damage number needs to read as an impact rather than as a fade-in. */
export function easeOutBack(t, s = 1.9) {
  const c = s + 1;
  const p = t - 1;
  return 1 + c * p * p * p + s * p * p;
}

/** Decaying sine — the slosh response of the liquid in the globes, and the
 *  ring-out on a level-up plate. */
export function ringDown(t, freq, decay) {
  return Math.sin(t * Math.PI * 2 * freq) * Math.exp(-t * decay);
}

/**
 * The SYSTEM window's timing contract, in seconds. Solo Leveling windows SNAP
 * in (a hard cut with a one-frame flash), HOLD long enough to read twice, and
 * FADE slowly. Getting this wrong — a symmetric 0.3s in/out tween — is what
 * makes a system window read as a game tooltip instead of an interruption.
 */
export const SYSTEM_TIMING = {
  snap: 0.115,     // scale/opacity in
  flash: 0.075,    // the white blowout on the first frames
  borderDraw: 0.16, // the edges extending from centre
  typeCps: 68,     // characters per second of the type-on reveal
  holdMin: 2.6,    // never dismiss before this even if the caller asked for less
  fade: 0.62,      // slow, with an upward drift
};
