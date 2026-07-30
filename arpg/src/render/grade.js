import * as THREE from 'three';
import { LIGHTS, ELEMENTS } from '../core/palette.js';

/**
 * The procedural colour grade, baked into a 33^3 3D LUT.
 *
 * This is where the dark-fantasy read is won or lost. AgX gives a neutral,
 * well-behaved filmic image; a neutral image of a crypt is a grey image of a
 * crypt. The grade is what turns it into MONARCH:
 *
 *   - **Cold, desaturated shadows.** Everything below the mid-tones is pulled
 *     toward the moon's hue from `palette.LIGHTS.moon` and has most of its
 *     saturation removed. Shadow in this world is not "less light", it is a
 *     different colour of light.
 *   - **Warm firelight mid-tones.** The braziers are the key, so the range they
 *     occupy is tinted toward `palette.LIGHTS.brazier`. That single split makes
 *     a frame read as lit by fire rather than as lit by "a light".
 *   - **A crushed toe and a rolled shoulder.** Blacks go genuinely black (p1
 *     under 6/255 in `tools/analyze.mjs` terms) instead of the lifted grey that
 *     is the single most common tell of an amateur renderer; highlights roll off
 *     instead of clipping, so a flame keeps its shape at 200x mid grey.
 *   - **Hue-selective saturation.** The world is desaturated globally, EXCEPT in
 *     a band around the shadow-magic violet from `palette.ELEMENTS.shadow`,
 *     which is boosted. That is the whole Solo Leveling contrast: a near
 *     monochrome world with exactly one saturated colour in it, and it has to
 *     survive the desaturation pass that makes the rest of the frame work.
 *
 * A 3D LUT is used rather than inline shader maths for two reasons: the cost is
 * one hardware-filtered texture fetch no matter how baroque the grade gets, and
 * every one of these operations composes correctly when baked but would need
 * careful ordering (and several extra `pow`s per pixel) if evaluated live.
 *
 * Generated fully in code — no RNG, no external .cube file — so it is identical
 * on every machine and every capture.
 */

export const LUT_SIZE = 33;

/** Grade strength knobs, kept together so the look can be tuned in one place. */
export const GRADE = {
  /** Black point subtracted in display space before renormalising. Crushes the
   *  toe. 0.016 is about 4/255 — enough to kill the lifted-black tell without
   *  losing shadow detail the analyzer flags as CRUSHED. */
  blackPoint: 0.016,
  /** Extra contrast blended in as a smoothstep about 0.5. */
  contrast: 0.36,
  /** Highlight shoulder. Higher = earlier, softer roll. */
  shoulder: 0.17,
  /** Split-tone amounts. */
  shadowTint: 0.22,
  midTint: 0.12,
  highTint: 0.05,
  /** How far each palette-derived tint is pulled back toward neutral before it
   *  is applied. The palette colours are LIGHT colours — the moon at
   *  (0.42,0.52,0.78) is a 2:1 blue-to-red ratio — and using them raw as a
   *  grading tint multiplies an already blue image into a cartoon. The grade
   *  wants the HINT of the hue, not the hue. */
  tintDesaturate: 0.45,
  /** Luma boundaries of the three zones. */
  shadowEnd: 0.34,
  highStart: 0.58,
  /** Saturation multipliers per zone. Shadows lose most of their chroma: "cold
   *  desaturated shadows" means desaturated FIRST and cold second, and a scene
   *  lit entirely by a blue moon will read as a blue cartoon otherwise. */
  satBase: 0.86,
  satShadow: 0.36,
  satHigh: 0.86,
  /**
   * Violet protection. The one saturated colour allowed to dominate is shadow
   * magic, and it has to survive the desaturation above.
   *
   * The band is NARROW and gated on input saturation, and both of those matter:
   * moonlight lands at hue ~221 and the shadow-magic violet at ~256, only 35
   * apart. A wide band (or an ungated one) boosts every moonlit stone in the
   * dungeon and turns the whole frame blue — which is the exact opposite of
   * what the protection exists for.
   */
  violetSat: 1.22,
  violetWidth: 17,
  violetGate: [0.34, 0.58],
  /** Final white balance, applied as a normalised channel gain. Very slightly
   *  cool: a neutral white in a moonlit crypt should not be neutral. */
  whiteBalance: [0.990, 0.997, 1.013],
};

// ---------------------------------------------------------------------------
// colour helpers (build time only — none of this runs per frame)
// ---------------------------------------------------------------------------

function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx > 1e-6 ? d / mx : 0, mx];
}

function hsv2rgb(h, s, v) {
  const c = v * s;
  const hp = (h / 60) % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  return [r + m, g + m, b + m];
}

const LUMA = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Normalise a palette colour so it carries hue only, not brightness, then pull
 *  it partway back toward neutral so it works as a grading tint rather than as
 *  a light colour. */
function unitLuma(rgb, desat = GRADE.tintDesaturate) {
  const l = Math.max(1e-4, LUMA(rgb[0], rgb[1], rgb[2]));
  return [
    1 + (rgb[0] / l - 1) * (1 - desat),
    1 + (rgb[1] / l - 1) * (1 - desat),
    1 + (rgb[2] / l - 1) * (1 - desat),
  ];
}

/** Linear -> sRGB display encoding, matching what the composite applies. */
function encode(c) {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const smoothstep01 = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Build the LUT. Input and output are DISPLAY-ENCODED sRGB values in [0,1] —
 * the grade is applied after the tone map and after the transfer function,
 * which is where a look LUT belongs and where lift/gamma/gain behave the way a
 * colourist expects them to.
 */
export function buildGradeLut(size = LUT_SIZE) {
  const shadowTint = unitLuma(LIGHTS.moon.color);
  const warmTint = unitLuma(LIGHTS.brazier.color);
  // The highlight tint is the brazier's *glow* colour rather than its core, so
  // the hot end of the range stays believably close to white.
  const highTint = unitLuma(ELEMENTS.fire.glow);

  // The one saturated hue in the game, read out of the palette so a change
  // there propagates here instead of drifting.
  const shadowCore = ELEMENTS.shadow.core;
  const violetHue = rgb2hsv(encode(shadowCore[0]), encode(shadowCore[1]), encode(shadowCore[2]))[0];

  const data = new Uint8Array(size * size * size * 4);
  const inv = 1 / (size - 1);
  let p = 0;

  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        let r = ri * inv;
        let g = gi * inv;
        let b = bi * inv;

        // --- 1. tone curve on luminance, applied as a ratio so hue is kept ---
        const l0 = Math.max(1e-5, LUMA(r, g, b));
        let y = clamp01((l0 - GRADE.blackPoint) / (1 - GRADE.blackPoint));
        y = lerp(y, smoothstep01(y), GRADE.contrast);
        y = (y * (1 + GRADE.shoulder)) / (1 + GRADE.shoulder * y);
        const gain = y / l0;
        r *= gain; g *= gain; b *= gain;

        // --- 2. split tone -------------------------------------------------
        const lum = clamp01(LUMA(r, g, b));
        const wShadow = 1 - smoothstep01(clamp01(lum / GRADE.shadowEnd));
        const wHigh = smoothstep01(clamp01((lum - GRADE.highStart) / (1 - GRADE.highStart)));
        const wMid = Math.max(0, 1 - wShadow - wHigh);

        const tint = [
          1 + (shadowTint[0] - 1) * wShadow * GRADE.shadowTint
            + (warmTint[0] - 1) * wMid * GRADE.midTint
            + (highTint[0] - 1) * wHigh * GRADE.highTint,
          1 + (shadowTint[1] - 1) * wShadow * GRADE.shadowTint
            + (warmTint[1] - 1) * wMid * GRADE.midTint
            + (highTint[1] - 1) * wHigh * GRADE.highTint,
          1 + (shadowTint[2] - 1) * wShadow * GRADE.shadowTint
            + (warmTint[2] - 1) * wMid * GRADE.midTint
            + (highTint[2] - 1) * wHigh * GRADE.highTint,
        ];
        r *= tint[0] * GRADE.whiteBalance[0];
        g *= tint[1] * GRADE.whiteBalance[1];
        b *= tint[2] * GRADE.whiteBalance[2];

        // --- 3. hue-selective saturation -----------------------------------
        const [h, s, v] = rgb2hsv(clamp01(r), clamp01(g), clamp01(b));
        let satMul = lerp(GRADE.satBase, GRADE.satShadow, wShadow);
        satMul = lerp(satMul, GRADE.satHigh, wHigh);

        // Angular distance to the shadow-magic hue, wrapped, gated on how
        // saturated the pixel already is. Shadow magic arrives at s > 0.6;
        // moonlit stone sits around 0.4, and without the gate the band lifts
        // the entire dungeon instead of the spell in the middle of it.
        let dh = Math.abs(h - violetHue);
        if (dh > 180) dh = 360 - dh;
        const dhn = dh / GRADE.violetWidth;
        const gate = smoothstep01(clamp01((s - GRADE.violetGate[0]) / (GRADE.violetGate[1] - GRADE.violetGate[0])));
        const violet = Math.exp(-dhn * dhn) * gate;
        satMul = lerp(satMul, GRADE.violetSat, violet);

        const out = hsv2rgb(h, clamp01(s * satMul), v);

        data[p++] = Math.round(clamp01(out[0]) * 255);
        data[p++] = Math.round(clamp01(out[1]) * 255);
        data[p++] = Math.round(clamp01(out[2]) * 255);
        data[p++] = 255;
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;   // already display-encoded; no decode
  tex.needsUpdate = true;
  tex.name = 'mn.gradeLUT';
  return tex;
}
