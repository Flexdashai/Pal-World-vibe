/**
 * Procedural icon glyphs — skills, buffs and item types.
 *
 * Every icon is a canvas-2D drawing routine that receives a normalised context
 * (origin at the icon centre, unit radius = 1) so the same code produces a 26px
 * buff pip and a 58px skill slot without a second set of numbers.
 *
 * The look, which is uniform across all of them because uniformity IS the
 * design:
 *   1. a low radial bloom of the element colour behind the glyph, so the slot
 *      appears to be lit from inside;
 *   2. the glyph drawn once in near-black, offset down-right, as a cast shadow;
 *   3. the glyph in a vertical gradient from the element's hot colour at the
 *      top to its dark colour at the bottom — a flat fill reads as clip art;
 *   4. a 1px bright rim on the upper-left contour.
 *
 * Silhouette carries the identity. At 34px, a player recognises the SHAPE of
 * their skill, never the detail, so each glyph is designed to be distinct as a
 * black blob first.
 */

import { ELEMENTS } from '../core/palette.js';
import { alpha, mixHex, shade } from './theme.js';

/** Draw `fn` inside a unit-radius coordinate system centred in `size`. */
function unit(c, size, fn, scale = 1) {
  c.save();
  c.translate(size * 0.5, size * 0.5);
  c.scale(size * 0.5 * scale, size * 0.5 * scale);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  fn(c);
  c.restore();
}

/**
 * The full three-pass emblem render. `path(c)` must build a path in unit space;
 * `mode` is 'fill' or 'stroke'.
 */
export function emblem(c, size, element, path, opts = {}) {
  const el = ELEMENTS[element] ?? ELEMENTS.physical;
  const hot = mixHex(el.srgb, '#ffffff', 0.55);
  const mid = el.srgb;
  const dark = shade(el.srgb, 0.30);
  const mode = opts.mode ?? 'fill';
  const lw = opts.lineWidth ?? 0.16;

  // 1. interior bloom
  const g = c.createRadialGradient(size * 0.5, size * 0.52, 0, size * 0.5, size * 0.52, size * 0.55);
  g.addColorStop(0, alpha(mid, opts.bloom ?? 0.30));
  g.addColorStop(0.55, alpha(mid, (opts.bloom ?? 0.30) * 0.28));
  g.addColorStop(1, alpha(mid, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);

  // 2. cast shadow
  unit(c, size, (cc) => {
    cc.translate(0.06, 0.08);
    cc.strokeStyle = 'rgba(0,0,0,0.85)';
    cc.fillStyle = 'rgba(0,0,0,0.85)';
    cc.lineWidth = lw * 1.35;
    path(cc);
    if (mode === 'fill') cc.fill(); else cc.stroke();
  }, opts.scale ?? 1);

  // 3. lit body
  unit(c, size, (cc) => {
    const grad = cc.createLinearGradient(0, -1, 0, 1);
    grad.addColorStop(0, hot);
    grad.addColorStop(0.42, mid);
    grad.addColorStop(1, dark);
    cc.strokeStyle = grad;
    cc.fillStyle = grad;
    cc.lineWidth = lw;
    path(cc);
    if (mode === 'fill') cc.fill(); else cc.stroke();
  }, opts.scale ?? 1);

  // 4. upper-left rim
  unit(c, size, (cc) => {
    cc.translate(-0.028, -0.032);
    cc.strokeStyle = alpha(hot, 0.55);
    cc.lineWidth = mode === 'fill' ? 0.035 : lw * 0.42;
    path(cc);
    cc.stroke();
  }, opts.scale ?? 1);
}

// ---------------------------------------------------------------------------
// skill glyphs
// ---------------------------------------------------------------------------

/** A wide crescent slash — the basic cleave. */
const pCleave = (c) => {
  c.beginPath();
  c.arc(0, 0.18, 0.86, Math.PI * 1.14, Math.PI * 1.86);
  c.arc(0, -0.18, 0.92, Math.PI * 1.83, Math.PI * 1.17, true);
  c.closePath();
};

/** Three stacked chevrons trailing left — a dash / shadow step. */
const pDash = (c) => {
  c.beginPath();
  for (let i = 0; i < 3; i++) {
    const x = -0.62 + i * 0.52;
    const s = 0.62 + i * 0.16;
    c.moveTo(x - 0.20, -s);
    c.lineTo(x + 0.24, 0);
    c.lineTo(x - 0.20, s);
  }
};

/** A crystalline lance: a long faceted spearhead. */
const pLance = (c) => {
  c.beginPath();
  c.moveTo(0, -0.96);
  c.lineTo(0.30, -0.26);
  c.lineTo(0.14, 0.86);
  c.lineTo(-0.14, 0.86);
  c.lineTo(-0.30, -0.26);
  c.closePath();
  c.moveTo(-0.52, -0.16); c.lineTo(-0.20, 0.10); c.lineTo(-0.44, 0.42); c.closePath();
  c.moveTo(0.52, -0.16); c.lineTo(0.20, 0.10); c.lineTo(0.44, 0.42); c.closePath();
};

/** A nova: a ring with eight tapering tongues. */
const pNova = (c) => {
  c.beginPath();
  c.arc(0, 0, 0.34, 0, Math.PI * 2);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const w = 0.155;
    c.moveTo(ca * 0.40 - sa * w, sa * 0.40 + ca * w);
    c.lineTo(ca * 0.98, sa * 0.98);
    c.lineTo(ca * 0.40 + sa * w, sa * 0.40 - ca * w);
    c.closePath();
  }
};

/** The monarch crown — five spires on a band, the signature sigil. */
const pCrown = (c) => {
  c.beginPath();
  c.moveTo(-0.86, 0.16);
  c.lineTo(-0.72, -0.72);
  c.lineTo(-0.36, -0.10);
  c.lineTo(0, -0.94);
  c.lineTo(0.36, -0.10);
  c.lineTo(0.72, -0.72);
  c.lineTo(0.86, 0.16);
  c.lineTo(0.62, 0.46);
  c.lineTo(-0.62, 0.46);
  c.closePath();
  c.moveTo(-0.66, 0.60); c.lineTo(0.66, 0.60); c.lineTo(0.58, 0.86); c.lineTo(-0.58, 0.86); c.closePath();
};

/** A siphon vortex: an inward logarithmic spiral. */
const pSiphon = (c) => {
  c.beginPath();
  for (let i = 0; i <= 84; i++) {
    const t = i / 84;
    const a = t * Math.PI * 4.6;
    const r = 0.96 * Math.exp(-0.34 * a);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
};

/** Monarch's domain: a column of light with an orbit ellipse. */
const pDomain = (c) => {
  c.beginPath();
  c.moveTo(-0.26, -0.98); c.lineTo(0.26, -0.98);
  c.lineTo(0.40, 0.62); c.lineTo(-0.40, 0.62); c.closePath();
  c.moveTo(-0.94, 0.50);
  c.bezierCurveTo(-0.94, 0.94, 0.94, 0.94, 0.94, 0.50);
  c.bezierCurveTo(0.94, 0.14, -0.94, 0.14, -0.94, 0.50);
  c.closePath();
};

/** ARISE: a hand reaching up out of a rune circle. */
const pArise = (c) => {
  c.beginPath();
  // rune circle
  c.moveTo(-0.92, 0.56);
  c.bezierCurveTo(-0.92, 0.96, 0.92, 0.96, 0.92, 0.56);
  c.bezierCurveTo(0.92, 0.24, -0.92, 0.24, -0.92, 0.56);
  c.closePath();
  // fingers
  for (let i = 0; i < 4; i++) {
    const x = -0.36 + i * 0.24;
    const h = 0.98 - Math.abs(i - 1.35) * 0.20;
    c.moveTo(x - 0.075, 0.42);
    c.lineTo(x - 0.075, -h);
    c.lineTo(x + 0.075, -h);
    c.lineTo(x + 0.075, 0.42);
    c.closePath();
  }
  // thumb
  c.moveTo(0.40, 0.36); c.lineTo(0.76, -0.10); c.lineTo(0.88, 0.06); c.lineTo(0.54, 0.48); c.closePath();
};

/** A guard sigil — a kite shield with a chevron. */
const pWard = (c) => {
  c.beginPath();
  c.moveTo(0, -0.94);
  c.lineTo(0.78, -0.56);
  c.lineTo(0.66, 0.32);
  c.lineTo(0, 0.96);
  c.lineTo(-0.66, 0.32);
  c.lineTo(-0.78, -0.56);
  c.closePath();
};

export const SKILL_PATHS = {
  cleave: pCleave, dash: pDash, lance: pLance, nova: pNova,
  crown: pCrown, siphon: pSiphon, domain: pDomain, arise: pArise, ward: pWard,
};

/** Skill icons that read better as a stroke than a fill. */
const STROKE_GLYPHS = new Set(['dash', 'siphon']);

export function drawSkillIcon(c, size, glyph, element) {
  const path = SKILL_PATHS[glyph] ?? pCleave;
  emblem(c, size, element, path, {
    mode: STROKE_GLYPHS.has(glyph) ? 'stroke' : 'fill',
    lineWidth: glyph === 'siphon' ? 0.14 : 0.17,
    scale: 0.74,
    bloom: 0.34,
  });
}

// ---------------------------------------------------------------------------
// item glyphs (inventory + equipment doll)
// ---------------------------------------------------------------------------

const pSword = (c) => {
  c.beginPath();
  c.moveTo(0, -0.98); c.lineTo(0.16, -0.72); c.lineTo(0.16, 0.30);
  c.lineTo(-0.16, 0.30); c.lineTo(-0.16, -0.72); c.closePath();
  c.moveTo(-0.56, 0.30); c.lineTo(0.56, 0.30); c.lineTo(0.56, 0.46); c.lineTo(-0.56, 0.46); c.closePath();
  c.moveTo(-0.10, 0.46); c.lineTo(0.10, 0.46); c.lineTo(0.10, 0.86); c.lineTo(-0.10, 0.86); c.closePath();
  c.moveTo(-0.24, 0.86); c.lineTo(0.24, 0.86); c.lineTo(0.24, 0.99); c.lineTo(-0.24, 0.99); c.closePath();
};

const pDagger = (c) => {
  c.beginPath();
  c.moveTo(0.02, -0.96); c.lineTo(0.22, -0.30); c.lineTo(0.06, 0.22);
  c.lineTo(-0.14, 0.22); c.lineTo(-0.18, -0.34); c.closePath();
  c.moveTo(-0.42, 0.22); c.lineTo(0.40, 0.22); c.lineTo(0.36, 0.38); c.lineTo(-0.38, 0.38); c.closePath();
  c.moveTo(-0.10, 0.38); c.lineTo(0.08, 0.38); c.lineTo(0.08, 0.92); c.lineTo(-0.10, 0.92); c.closePath();
};

const pHelm = (c) => {
  c.beginPath();
  c.moveTo(-0.66, 0.30);
  c.bezierCurveTo(-0.78, -0.72, 0.78, -0.72, 0.66, 0.30);
  c.lineTo(0.44, 0.80); c.lineTo(-0.44, 0.80);
  c.closePath();
  c.moveTo(-0.30, -0.06); c.lineTo(-0.06, -0.06); c.lineTo(-0.06, 0.30); c.lineTo(-0.30, 0.30); c.closePath();
  c.moveTo(0.06, -0.06); c.lineTo(0.30, -0.06); c.lineTo(0.30, 0.30); c.lineTo(0.06, 0.30); c.closePath();
};

const pChest = (c) => {
  c.beginPath();
  c.moveTo(-0.34, -0.86); c.lineTo(0.34, -0.86);
  c.lineTo(0.86, -0.52); c.lineTo(0.68, 0.10); c.lineTo(0.52, 0.02); c.lineTo(0.52, 0.88);
  c.lineTo(-0.52, 0.88); c.lineTo(-0.52, 0.02); c.lineTo(-0.68, 0.10); c.lineTo(-0.86, -0.52);
  c.closePath();
};

const pBoots = (c) => {
  c.beginPath();
  c.moveTo(-0.62, -0.72); c.lineTo(-0.14, -0.72); c.lineTo(-0.14, 0.24);
  c.lineTo(0.72, 0.42); c.lineTo(0.72, 0.80); c.lineTo(-0.62, 0.80);
  c.closePath();
};

const pGloves = (c) => {
  c.beginPath();
  c.moveTo(-0.52, 0.86); c.lineTo(-0.52, -0.18);
  c.bezierCurveTo(-0.52, -0.86, 0.10, -0.90, 0.14, -0.36);
  c.lineTo(0.20, 0.02);
  c.bezierCurveTo(0.62, -0.16, 0.78, 0.22, 0.44, 0.44);
  c.lineTo(0.44, 0.86);
  c.closePath();
};

const pRing = (c) => {
  c.beginPath();
  c.arc(0, 0.20, 0.62, 0, Math.PI * 2);
  c.arc(0, 0.20, 0.38, 0, Math.PI * 2, true);
  c.moveTo(0, -0.94); c.lineTo(0.28, -0.52); c.lineTo(0, -0.24); c.lineTo(-0.28, -0.52); c.closePath();
};

const pAmulet = (c) => {
  c.beginPath();
  c.moveTo(-0.70, -0.70);
  c.bezierCurveTo(-0.30, 0.14, 0.30, 0.14, 0.70, -0.70);
  c.lineTo(0.54, -0.80);
  c.bezierCurveTo(0.24, -0.06, -0.24, -0.06, -0.54, -0.80);
  c.closePath();
  c.moveTo(0, 0.02); c.lineTo(0.40, 0.48); c.lineTo(0, 0.96); c.lineTo(-0.40, 0.48); c.closePath();
};

const pPotion = (c) => {
  c.beginPath();
  c.moveTo(-0.22, -0.92); c.lineTo(0.22, -0.92); c.lineTo(0.22, -0.52);
  c.bezierCurveTo(0.74, -0.28, 0.74, 0.92, 0, 0.92);
  c.bezierCurveTo(-0.74, 0.92, -0.74, -0.28, -0.22, -0.52);
  c.closePath();
};

const pGem = (c) => {
  c.beginPath();
  c.moveTo(0, -0.92); c.lineTo(0.70, -0.30); c.lineTo(0.44, 0.86);
  c.lineTo(-0.44, 0.86); c.lineTo(-0.70, -0.30); c.closePath();
  c.moveTo(0, -0.92); c.lineTo(-0.24, -0.12); c.lineTo(0.24, -0.12); c.closePath();
};

const pScroll = (c) => {
  c.beginPath();
  c.moveTo(-0.66, -0.72); c.lineTo(0.66, -0.72); c.lineTo(0.66, 0.72); c.lineTo(-0.66, 0.72); c.closePath();
  c.moveTo(-0.82, -0.86); c.lineTo(0.82, -0.86); c.lineTo(0.82, -0.62); c.lineTo(-0.82, -0.62); c.closePath();
  c.moveTo(-0.82, 0.62); c.lineTo(0.82, 0.62); c.lineTo(0.82, 0.86); c.lineTo(-0.82, 0.86); c.closePath();
};

const pBelt = (c) => {
  c.beginPath();
  c.moveTo(-0.94, -0.28); c.lineTo(0.94, -0.28); c.lineTo(0.94, 0.28); c.lineTo(-0.94, 0.28); c.closePath();
  c.moveTo(-0.28, -0.52); c.lineTo(0.28, -0.52); c.lineTo(0.28, 0.52); c.lineTo(-0.28, 0.52); c.closePath();
  c.moveTo(-0.12, -0.20); c.lineTo(0.12, -0.20); c.lineTo(0.12, 0.20); c.lineTo(-0.12, 0.20); c.closePath();
};

const pPauldron = (c) => {
  c.beginPath();
  c.moveTo(-0.88, 0.62);
  c.bezierCurveTo(-0.88, -0.72, 0.88, -0.72, 0.88, 0.62);
  c.closePath();
  c.moveTo(-0.62, 0.72); c.lineTo(0.62, 0.72); c.lineTo(0.50, 0.94); c.lineTo(-0.50, 0.94); c.closePath();
};

const pOrb = (c) => {
  c.beginPath();
  c.arc(0, 0, 0.72, 0, Math.PI * 2);
  c.moveTo(0.72, 0); c.bezierCurveTo(0.30, -0.30, -0.30, -0.30, -0.72, 0);
  c.bezierCurveTo(-0.30, 0.10, 0.30, 0.10, 0.72, 0); c.closePath();
};

export const ITEM_PATHS = {
  sword: pSword, dagger: pDagger, helm: pHelm, chest: pChest, boots: pBoots,
  gloves: pGloves, ring: pRing, amulet: pAmulet, potion: pPotion, gem: pGem,
  scroll: pScroll, belt: pBelt, pauldron: pPauldron, orb: pOrb, shield: pWard,
};

export function drawItemIcon(c, size, glyph, tintHex) {
  const path = ITEM_PATHS[glyph] ?? pSword;
  const hot = mixHex(tintHex, '#ffffff', 0.62);
  const dark = shade(tintHex, 0.26);

  const g = c.createRadialGradient(size * 0.5, size * 0.55, 0, size * 0.5, size * 0.55, size * 0.6);
  g.addColorStop(0, alpha(tintHex, 0.18));
  g.addColorStop(1, alpha(tintHex, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);

  unit(c, size, (cc) => {
    cc.translate(0.05, 0.07);
    cc.fillStyle = 'rgba(0,0,0,0.8)';
    path(cc); cc.fill();
  }, 0.70);
  unit(c, size, (cc) => {
    const grad = cc.createLinearGradient(-0.6, -1, 0.5, 1);
    grad.addColorStop(0, hot);
    grad.addColorStop(0.40, tintHex);
    grad.addColorStop(1, dark);
    cc.fillStyle = grad;
    path(cc); cc.fill();
    cc.strokeStyle = 'rgba(0,0,0,0.55)';
    cc.lineWidth = 0.035;
    path(cc); cc.stroke();
  }, 0.70);
  unit(c, size, (cc) => {
    cc.translate(-0.026, -0.030);
    cc.strokeStyle = alpha(hot, 0.5);
    cc.lineWidth = 0.030;
    path(cc); cc.stroke();
  }, 0.70);
}

// ---------------------------------------------------------------------------
// buff glyphs — deliberately simpler; they are read at 26px
// ---------------------------------------------------------------------------

const pAura = (c) => {
  c.beginPath();
  for (let i = 0; i < 3; i++) {
    const r = 0.34 + i * 0.28;
    c.moveTo(r, 0);
    c.arc(0, 0, r, 0, Math.PI * 2);
  }
};
const pHaste = (c) => {
  c.beginPath();
  c.moveTo(0.24, -0.96); c.lineTo(-0.52, 0.10); c.lineTo(-0.06, 0.10);
  c.lineTo(-0.24, 0.96); c.lineTo(0.52, -0.10); c.lineTo(0.06, -0.10); c.closePath();
};
const pBleed = (c) => {
  c.beginPath();
  c.moveTo(0, -0.92);
  c.bezierCurveTo(0.62, -0.10, 0.72, 0.90, 0, 0.90);
  c.bezierCurveTo(-0.72, 0.90, -0.62, -0.10, 0, -0.92);
  c.closePath();
};
const pFocus = (c) => {
  c.beginPath();
  c.arc(0, 0, 0.82, 0, Math.PI * 2);
  c.moveTo(0, -0.46); c.lineTo(0.46, 0); c.lineTo(0, 0.46); c.lineTo(-0.46, 0); c.closePath();
};

export const BUFF_PATHS = { aura: pAura, haste: pHaste, bleed: pBleed, focus: pFocus, crown: pCrown, ward: pWard };

export function drawBuffIcon(c, size, glyph, element) {
  emblem(c, size, element, BUFF_PATHS[glyph] ?? pAura, {
    mode: glyph === 'aura' ? 'stroke' : 'fill',
    lineWidth: 0.16,
    scale: 0.70,
    bloom: 0.42,
  });
}
