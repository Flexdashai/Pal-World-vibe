/**
 * The resource orbs — a red life globe and a violet shadow globe.
 *
 * These are the single most-looked-at element of an ARPG HUD, so they are the
 * one place in this subsystem that redraws every frame. What makes an orb read
 * as a glass sphere full of liquid rather than as a circular progress bar:
 *
 *   - the surface is a real travelling wave, not a straight line, and it SLOSHES
 *     when the value changes (a damped oscillator excited by the delta);
 *   - the liquid is lit from inside — a radial core glow under the surface — and
 *     darkens toward the bottom of the sphere;
 *   - a bright meniscus line on the surface with a soft glow above it;
 *   - bubbles rise and pop at the surface;
 *   - caustic bands drift through the body;
 *   - the glass specular and the rim refraction darkening live in the FRAME
 *     canvas, which is composited above this one (see ornament.bakeGlobeFrame).
 *
 * ALLOCATION NOTE: canvas gradients are created once, in a local coordinate
 * frame whose origin is the liquid surface, and re-used every frame by
 * translating the context before filling. Creating a gradient per frame is the
 * obvious implementation and it allocates ~4 objects per orb per frame.
 */

import { UI } from '../core/palette.js';
import { M, alpha, mixHex, shade, clamp01, damp } from './theme.js';
import { el, canvas as mkCanvas, setText, setOpacity } from './dom.js';
import { bakeGlobeFrame, offscreen } from './ornament.js';

const BUBBLES = 13;

export class Globe {
  /**
   * @param {HTMLElement} parent
   * @param {'l'|'r'} side
   * @param {object} tint  { base, dark, hot, foam }
   * @param {string} label micro-label under the number
   */
  constructor(parent, side, tint, label, rng) {
    this.side = side;
    this.tint = tint;
    this.rng = rng;

    this.root = el('div', `mn-globe ${side}`, parent);
    this.cvLiquid = mkCanvas(M.globe, M.globe, 'liq', this.root);
    this.cvFrame = mkCanvas(M.globe, M.globe, 'frm', this.root);
    this.halo = el('div', 'halo', this.root);
    const txt = el('div', 'txt', this.root);
    this.elValue = el('span', 'v', txt);
    this.elMax = el('span', 'm', txt);
    this.elLabel = el('span', 'k', txt);
    setText(this.elLabel, label);

    this.cLiquid = this.cvLiquid.getContext('2d');
    this.cFrame = this.cvFrame.getContext('2d');

    // --- simulation state -------------------------------------------------
    this.value = 1;      // authoritative 0..1
    this.max = 100;
    this.raw = 100;
    this.level = 1;      // rendered level, lags `value`
    this.slosh = 0;      // oscillator displacement
    this.sloshV = 0;     // oscillator velocity
    this.haloA = 0;
    this.danger = 0;     // 0..1 low-resource emphasis
    this._flashT = -1;

    // Bubbles: fixed pool, deterministic, respawned in place.
    this.bub = new Float32Array(BUBBLES * 5); // x, y, r, speed, wobblePhase
    for (let i = 0; i < BUBBLES; i++) this._respawn(i, rng.float());

    this._baked = 0;
    this._lastTxt = -1;
  }

  _respawn(i, y01) {
    const o = i * 5;
    const r = this.rng;
    this.bub[o + 0] = r.range(-0.78, 0.78);
    this.bub[o + 1] = y01;                       // 0 = bottom, 1 = top of glass
    this.bub[o + 2] = r.range(0.012, 0.042);
    this.bub[o + 3] = r.range(0.10, 0.30);
    this.bub[o + 4] = r.range(0, Math.PI * 2);
  }

  /** (Re)build the static socket art and resize the backing stores. */
  bake(u, rng, noise) {
    const px = Math.max(48, Math.round(M.globe * u));
    if (px === this._baked) return;
    this._baked = px;

    for (const cv of [this.cvLiquid, this.cvFrame]) {
      cv.width = px; cv.height = px;
      cv.style.width = '100%'; cv.style.height = '100%';
    }
    this.S = px;
    this.cx = px * 0.5;
    this.cy = px * 0.5;
    this.rGlass = (M.globeGlass * 0.5) * u;

    bakeGlobeFrame(this.cFrame, px, M.globeGlass * u, rng, noise, {
      rivets: 10,
      wings: this.side === 'l'
        ? [Math.PI * 0.78, Math.PI * 1.22, Math.PI * 1.62]
        : [Math.PI * 0.22, Math.PI * 1.78, Math.PI * 1.38],
    });

    this._buildGradients();
  }

  /**
   * Gradients live in "surface space": origin at the centre of the liquid
   * surface, +y downward into the liquid. Every frame we translate into that
   * space instead of rebuilding them.
   */
  _buildGradients() {
    const c = this.cLiquid;
    const R = this.rGlass;
    const t = this.tint;

    // Body: bright only in the top ~15% of the column, where light entering
    // through the meniscus actually reaches, then falling away fast. The first
    // version of this ramp stayed near `base` for half the sphere and the orb
    // read as a flat plastic button — the depth cue is the FALLOFF, not the hue.
    const body = c.createLinearGradient(0, -R * 0.06, 0, R * 2.1);
    body.addColorStop(0.00, mixHex(t.base, t.foam, 0.34));
    body.addColorStop(0.07, shade(t.base, 0.92));
    body.addColorStop(0.30, shade(t.base, 0.50));
    body.addColorStop(0.62, shade(t.base, 0.26));
    body.addColorStop(1.00, t.dark);
    this.gBody = body;

    // Core glow: the light the liquid emits from within, sitting just under the
    // surface rather than at the middle of the sphere. Weak — this is a lamp
    // seen through a centimetre of blood, not a neon sign.
    const core = c.createRadialGradient(0, R * 0.30, 0, 0, R * 0.30, R * 1.05);
    core.addColorStop(0.0, alpha(t.hot, 0.24));
    core.addColorStop(0.42, alpha(t.hot, 0.07));
    core.addColorStop(1.0, alpha(t.hot, 0));
    this.gCore = core;

    // Sphere shading: the liquid is inside a ball, so the side away from the
    // key light is in shadow. Without this the orb is a lit disc.
    const sph = c.createRadialGradient(
      -R * 0.42, -R * 0.34, R * 0.06, -R * 0.10, R * 0.05, R * 1.45
    );
    sph.addColorStop(0.0, 'rgba(0,0,0,0)');
    sph.addColorStop(0.46, 'rgba(0,0,0,0.20)');
    sph.addColorStop(0.78, 'rgba(0,0,0,0.58)');
    sph.addColorStop(1.0, 'rgba(0,0,0,0.86)');
    this.gSphere = sph;

    // glow above the surface, into the empty part of the glass
    const above = c.createLinearGradient(0, -R * 0.55, 0, 0);
    above.addColorStop(0, alpha(t.foam, 0));
    above.addColorStop(1, alpha(t.foam, 0.30));
    this.gAbove = above;

    // the empty glass: cold, slightly reflective, in absolute canvas space
    const empty = c.createLinearGradient(0, this.cy - R, 0, this.cy + R);
    empty.addColorStop(0, '#050409');
    empty.addColorStop(0.55, '#0a0810');
    empty.addColorStop(1, alpha(t.dark, 0.85));
    this.gEmpty = empty;

    // Density wisps. Three gradients centred on the ORIGIN, filled after a
    // translate — the alternative is `createRadialGradient` three times per orb
    // per frame, which is 360 allocations a second for two orbs.
    this.gWisp = [];
    for (let i = 0; i < 3; i++) {
      const wr = R * (0.55 + i * 0.12);
      const w = c.createRadialGradient(0, 0, 0, 0, 0, wr);
      w.addColorStop(0, 'rgba(26,11,15,1)');
      w.addColorStop(1, 'rgba(255,255,255,1)');
      this.gWisp.push({ g: w, r: wr });
    }

    this._sBubble = alpha(t.foam, 0.42);
    this._sBubbleHi = alpha('#ffffff', 0.30);
    this._sMeniscus = mixHex(t.foam, '#ffffff', 0.45);
    this._sCaustic = alpha(t.foam, 0.16);
    this._sDanger = alpha('#ff5a3c', 0.55);
  }

  /** Push a new value. `impulse` true when it changed because of a game event. */
  set(v, max, impulse = true) {
    const nv = clamp01(max > 0 ? v / max : 0);
    const d = nv - this.value;
    this.raw = v;
    this.max = max;
    if (impulse && Math.abs(d) > 0.002) {
      // A big loss sloshes hard; a small regen tick barely ripples. Signed so
      // the wave starts moving in the direction the level moved.
      this.sloshV += Math.max(-1.8, Math.min(1.8, d * 9.0));
      this.haloA = Math.min(1, this.haloA + Math.min(0.9, Math.abs(d) * 3.4));
      if (d < -0.04) this._flashT = 0;
    }
    this.value = nv;
  }

  update(dt, t) {
    // Rendered level chases the true value. Fast on gain, slower on loss, so a
    // burst of damage reads as a drop you can watch rather than a jump cut.
    const rate = this.level < this.value ? 9.0 : 5.5;
    this.level = damp(this.level, this.value, rate, dt);

    // Damped harmonic oscillator for the slosh: k tuned so the surface rings at
    // ~1.9 Hz, which is what a heavy liquid in a 15 cm sphere would do.
    const k = 142, cDamp = 5.6;
    this.sloshV += (-k * this.slosh - cDamp * this.sloshV) * dt;
    this.slosh += this.sloshV * dt;

    this.haloA = damp(this.haloA, 0, 3.4, dt);
    this.danger = damp(this.danger, this.value < 0.28 ? 1 : 0, 4, dt);
    if (this._flashT >= 0) this._flashT += dt;

    // Halo brightness also breathes when the resource is critically low.
    const pulse = this.danger * (0.35 + 0.35 * Math.sin(t * 6.6));
    setOpacity(this.halo, Math.min(1, this.haloA * 0.85 + pulse));

    this._drawLiquid(t);
    this._drawText();
  }

  _drawText() {
    // Only rewrite when the integer actually changes — a 60 Hz textContent write
    // is a layout invalidation for the whole HUD column.
    const v = Math.round(this.raw);
    if (v !== this._lastTxt) {
      this._lastTxt = v;
      setText(this.elValue, String(v));
      setText(this.elMax, `/ ${Math.round(this.max)}`);
    }
  }

  _drawLiquid(t) {
    const c = this.cLiquid;
    const S = this.S, R = this.rGlass, cx = this.cx, cy = this.cy;
    if (!S) return;

    c.clearRect(0, 0, S, S);
    c.save();
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.clip();

    // --- the empty part of the glass ---------------------------------------
    c.fillStyle = this.gEmpty;
    c.fillRect(cx - R, cy - R, R * 2, R * 2);

    // --- surface position ---------------------------------------------------
    // The liquid surface at level L sits at y = cy + R - 2R*L. The slosh adds a
    // whole-body tilt/bob; the travelling waves add the shape.
    const lvl = clamp01(this.level);
    const surfaceY = cy + R - 2 * R * lvl + this.slosh * R * 0.16;
    const amp = R * (0.018 + Math.min(0.075, Math.abs(this.slosh) * 0.55) + this.danger * 0.012);
    const tilt = this.sloshV * R * 0.055;

    c.save();
    c.translate(cx, surfaceY);

    // --- liquid body --------------------------------------------------------
    const steps = 22;
    c.beginPath();
    c.moveTo(-R - 2, R * 2 + 4);
    for (let i = 0; i <= steps; i++) {
      const fx = -R + (2 * R * i) / steps;
      const u = fx / R;
      const y =
        Math.sin(u * 3.05 + t * 2.25) * amp +
        Math.sin(u * 5.9 - t * 3.15) * amp * 0.45 +
        Math.sin(u * 1.4 + t * 1.05) * amp * 0.62 +
        u * tilt;
      if (i === 0) c.lineTo(fx, y); else c.lineTo(fx, y);
    }
    c.lineTo(R + 2, R * 2 + 4);
    c.closePath();

    c.fillStyle = this.gBody;
    c.fill();

    // core glow, clipped to the liquid we just filled
    c.save();
    c.clip();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = this.gCore;
    c.fillRect(-R, -R * 0.4, R * 2, R * 2.6);

    // --- caustic bands ------------------------------------------------------
    c.strokeStyle = this._sCaustic;
    c.lineWidth = Math.max(1, R * 0.055);
    for (let b = 0; b < 3; b++) {
      const yb = R * (0.30 + b * 0.46) + Math.sin(t * (0.7 + b * 0.31)) * R * 0.05;
      c.beginPath();
      for (let i = 0; i <= 12; i++) {
        const fx = -R + (2 * R * i) / 12;
        const y = yb + Math.sin(fx / R * 2.6 + t * (1.1 + b * 0.4) + b) * R * 0.045;
        if (i === 0) c.moveTo(fx, y); else c.lineTo(fx, y);
      }
      c.stroke();
    }

    // --- density wisps ------------------------------------------------------
    // Slow dark swirls through the body. Without them the liquid is a smooth
    // vertical ramp, which is the exact look the quality bar calls a flat
    // surface — real blood and real aether are not homogeneous.
    c.globalCompositeOperation = 'multiply';
    c.globalAlpha = 0.34;
    for (let i = 0; i < 3; i++) {
      const ph = i * 2.1;
      const wx = Math.sin(t * 0.31 + ph) * R * 0.42;
      const wy = R * (0.45 + i * 0.55) + Math.cos(t * 0.24 + ph * 1.7) * R * 0.22;
      const { g: wg, r: wr } = this.gWisp[i];
      c.save();
      c.translate(wx, wy);
      c.fillStyle = wg;
      c.fillRect(-wr, -wr, wr * 2, wr * 2);
      c.restore();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'lighter';

    // --- bubbles ------------------------------------------------------------
    const depth = 2 * R * lvl;
    c.lineWidth = Math.max(1, R * 0.022);
    for (let i = 0; i < BUBBLES; i++) {
      const o = i * 5;
      // y01 = 0 at the bottom of the liquid column, 1 at the surface
      this.bub[o + 1] += this.bub[o + 3] * (1 / 60) * (0.6 + lvl * 0.8);
      if (this.bub[o + 1] > 1) this._respawn(i, 0);
      const by = depth * (1 - this.bub[o + 1]);
      if (by > depth || depth < R * 0.15) continue;
      const wob = Math.sin(t * 2.1 + this.bub[o + 4]) * R * 0.035;
      const bx = this.bub[o + 0] * R * 0.82 + wob;
      if (bx * bx + (by - R) * (by - R) > R * R * 1.4) continue;
      const br = this.bub[o + 2] * R;
      // fade in from the bottom and out as it nears the meniscus
      const a = Math.min(1, this.bub[o + 1] * 4) * (1 - Math.pow(this.bub[o + 1], 6));
      c.globalAlpha = a;
      c.strokeStyle = this._sBubble;
      c.beginPath(); c.arc(bx, by, br, 0, Math.PI * 2); c.stroke();
      c.fillStyle = this._sBubbleHi;
      c.beginPath(); c.arc(bx - br * 0.35, by - br * 0.35, br * 0.34, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1;
    c.restore();

    // --- the meniscus + the glow above it -----------------------------------
    if (lvl > 0.004 && lvl < 0.998) {
      c.beginPath();
      for (let i = 0; i <= steps; i++) {
        const fx = -R + (2 * R * i) / steps;
        const u = fx / R;
        const y =
          Math.sin(u * 3.05 + t * 2.25) * amp +
          Math.sin(u * 5.9 - t * 3.15) * amp * 0.45 +
          Math.sin(u * 1.4 + t * 1.05) * amp * 0.62 +
          u * tilt;
        if (i === 0) c.moveTo(fx, y); else c.lineTo(fx, y);
      }
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.strokeStyle = this._sMeniscus;
      c.lineWidth = Math.max(1.1, R * 0.030);
      c.stroke();
      // soft bloom above the surface, into the empty glass
      c.fillStyle = this.gAbove;
      c.fillRect(-R, -R * 0.55, R * 2, R * 0.55);
      c.restore();
    }

    c.restore(); // out of surface space

    // --- sphere shading, over everything inside the glass -------------------
    // Applied AFTER the liquid and the empty volume so it shades both: the
    // glass is one ball, not two stacked layers.
    c.save();
    c.translate(cx, cy);
    c.fillStyle = this.gSphere;
    c.fillRect(-R, -R, R * 2, R * 2);
    c.restore();

    // --- danger rim ---------------------------------------------------------
    if (this.danger > 0.01) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = this.danger * (0.32 + 0.24 * Math.sin(t * 6.6));
      c.strokeStyle = this._sDanger;
      c.lineWidth = R * 0.14;
      c.beginPath(); c.arc(cx, cy, R * 0.94, 0, Math.PI * 2); c.stroke();
      c.restore();
    }

    // --- impact flash: a white wash across the whole orb for ~90 ms ---------
    if (this._flashT >= 0 && this._flashT < 0.10) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = (1 - this._flashT / 0.10) * 0.42;
      c.fillStyle = '#ffffff';
      c.fillRect(cx - R, cy - R, R * 2, R * 2);
      c.restore();
    }

    c.restore();
  }

  dispose() {
    this.root.remove();
  }
}

/** Tints, resolved from palette so no orb hardcodes a hue. */
export const LIFE_TINT = {
  base: shade(UI.hpRed, 0.86),
  dark: shade(UI.hpRedDark, 0.55),
  hot: mixHex(UI.hpRed, '#ff7a48', 0.40),
  foam: mixHex(UI.hpRed, '#ffc0a4', 0.58),
};

export const SHADOW_TINT = {
  base: shade(UI.manaViolet, 0.82),
  dark: shade(UI.manaDark, 0.60),
  hot: mixHex(UI.manaViolet, '#c9a8ff', 0.50),
  foam: mixHex(UI.manaViolet, '#ddccff', 0.62),
};

/** Build both orbs. Kept here so the two are guaranteed to stay symmetric. */
export function createGlobes(parent, rng) {
  return {
    life: new Globe(parent, 'l', LIFE_TINT, 'Life', rng.fork()),
    shadow: new Globe(parent, 'r', SHADOW_TINT, 'Shadow', rng.fork()),
  };
}

/** Shared with the panels so a resource swatch elsewhere matches the orb. */
export function globeSwatch(kind) {
  const t = kind === 'life' ? LIFE_TINT : SHADOW_TINT;
  const { cv, c } = offscreen(8, 8);
  c.fillStyle = t.base;
  c.fillRect(0, 0, 8, 8);
  return cv;
}
