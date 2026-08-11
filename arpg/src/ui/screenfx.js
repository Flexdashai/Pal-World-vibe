/**
 * Full-screen feedback: damage vignette, directional hit wedges, low-health
 * pulse, the level-up blowout, and the ARISE banner.
 *
 * These are DOM overlays rather than post passes on purpose. The render chain
 * already runs GTAO, SSR, volumetrics, TAA, bloom and DoF on a CPU rasteriser;
 * adding a full-resolution float pass so a red edge can fade in would be the
 * single most expensive thing this subsystem could do, and a compositor-only
 * opacity change on four gradient divs is visually identical.
 *
 * Everything is driven from `ctx.time.raw` (not CSS transitions) so the capture
 * harness lands on a deterministic phase. Only the low-health breathing uses a
 * continuous sine, which looks correct at any phase.
 */

import * as THREE from 'three';
import { clamp01, damp, easeOutExpo, easeOutCubic, lerp } from './theme.js';
import { el, setOpacity, setTransform, setText, setStyle, setShown, setClass } from './dom.js';

/**
 * Set a full-screen layer's opacity AND take it out of the compositor entirely
 * when it reaches zero.
 *
 * This is not a micro-optimisation. Measured in this container: five invisible
 * full-screen divs sitting in the layer tree add ~1.1 s to every `page.screenshot`
 * and to every real composited frame, because a CPU compositor still has to
 * blend a 1280x720 buffer per layer. `display:none` removes them from layout and
 * from the layer tree; `opacity:0` does not.
 */
function layer(node, v) {
  const on = v > 0.004;
  setShown(node, on);
  if (on) setOpacity(node, v);
}

export class ScreenFx {
  constructor(parent) {
    this.root = el('div', 'mn-fx', parent);
    this.vigDmg = el('div', 'mn-vig-dmg', this.root);
    this.vigLow = el('div', 'mn-vig-low', this.root);
    this.vigArise = el('div', 'mn-vig-arise', this.root);
    this.flash = el('div', 'mn-flash', this.root);
    this.ring = el('div', 'mn-ring', this.root);

    const d = el('div', 'mn-dir', this.root);
    this.dir = d;
    this.dirN = el('i', 'n', d);
    this.dirS = el('i', 's', d);
    this.dirW = el('i', 'w', d);
    this.dirE = el('i', 'e', d);

    // Banner lives outside .mn-fx so it can sit above the HUD.
    this.banner = el('div', 'mn-banner', parent);
    el('div', 'rulel', this.banner);
    el('div', 'ruler', this.banner);
    this.bannerBig = el('div', 'big', this.banner);
    this.bannerSm = el('div', 'sm', this.banner);

    // --- state ------------------------------------------------------------
    this.dmg = 0;
    this.dirX = 0;
    this.dirY = 0;
    this.dirA = 0;
    this.low = 0;
    this.lowTarget = 0;
    this.ariseA = 0;
    this.flashT = -1;
    this.ringT = -1;
    this.bannerT = -1;
    this.bannerDur = 2.6;

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  /**
   * The player took a hit. `worldDir` is the direction FROM the player TO the
   * source; it is projected to screen space so the wedge lights on the side the
   * damage came from, which is the only way an isometric player can tell where
   * they are being attacked from off-screen.
   */
  hit(amount01, worldDir, camera) {
    this.dmg = Math.min(1, this.dmg + 0.35 + amount01 * 0.85);
    if (worldDir && camera) {
      this._v.copy(worldDir).setY(0);
      if (this._v.lengthSq() > 1e-6) {
        this._v.normalize();
        // Project the direction into screen space by transforming a point one
        // metre along it and taking the delta in NDC.
        this._v2.set(0, 0, 0).project(camera);
        const ax = this._v2.x, ay = this._v2.y;
        this._v.multiplyScalar(3).project(camera);
        let dx = this._v.x - ax, dy = this._v.y - ay;
        const l = Math.hypot(dx, dy) || 1;
        this.dirX = dx / l;
        this.dirY = dy / l;
        this.dirA = Math.min(1, 0.55 + amount01);
      }
    }
  }

  /** 0..1 remaining health; drives the breathing red rim. */
  setHealth(frac) {
    this.lowTarget = frac < 0.35 ? clamp01((0.35 - frac) / 0.28) : 0;
  }

  levelUp() {
    this.flashT = 0;
    this.ringT = 0;
    this.showBanner('Level Up', 'Power surges through you', 'gold', 2.4);
  }

  arise(name) {
    this.ariseA = 1;
    this.showBanner('Arise', name ? `${name} answers` : 'The shadow answers', 'violet', 2.8);
  }

  showBanner(big, small, tone, dur) {
    setText(this.bannerBig, big);
    setText(this.bannerSm, small);
    this.bannerBig.classList.toggle('gold', tone === 'gold');
    this.bannerT = 0;
    this.bannerDur = dur ?? 2.6;
  }

  /** Park the banner at its peak, for the screenshot harness. */
  poseBanner(big, small, tone) {
    this.showBanner(big, small, tone, 6.0);
    this.bannerT = 0.34;   // just past the snap, deep inside the hold
  }

  hideBanner() { this.bannerT = -1; setClass(this.banner, 'on', false); setOpacity(this.banner, 0); }

  update(dt, t) {
    // --- damage vignette ---------------------------------------------------
    this.dmg = damp(this.dmg, 0, 2.6, dt);
    layer(this.vigDmg, this.dmg * 0.92);

    this.dirA = damp(this.dirA, 0, 4.2, dt);
    const a = this.dirA;
    layer(this.dir, a);
    if (a > 0.004) {
      setOpacity(this.dirN, Math.max(0, this.dirY));
      setOpacity(this.dirS, Math.max(0, -this.dirY));
      setOpacity(this.dirE, Math.max(0, this.dirX));
      setOpacity(this.dirW, Math.max(0, -this.dirX));
    }

    // --- low health --------------------------------------------------------
    this.low = damp(this.low, this.lowTarget, 3.0, dt);
    // 1.15 Hz: fast enough to feel urgent, slow enough not to be a strobe.
    const beat = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 1.15);
    layer(this.vigLow, this.low * beat * 0.85);

    // --- arise wash --------------------------------------------------------
    this.ariseA = damp(this.ariseA, 0, 0.85, dt);
    layer(this.vigArise, this.ariseA * 0.9);

    // --- level-up blowout --------------------------------------------------
    if (this.flashT >= 0) {
      this.flashT += dt;
      const f = this.flashT;
      // 60 ms of near-full white, then a 0.55 s decay. A symmetric fade reads
      // as a screen wipe; the asymmetry is what makes it read as a burst.
      const v = f < 0.06 ? 1 : Math.max(0, 1 - (f - 0.06) / 0.55);
      layer(this.flash, v * v * 0.95);
      if (f > 0.75) { this.flashT = -1; layer(this.flash, 0); }
    }

    if (this.ringT >= 0) {
      this.ringT += dt;
      const f = clamp01(this.ringT / 0.9);
      const e = easeOutExpo(f);
      layer(this.ring, (1 - f) * (1 - f) * 0.95);
      setTransform(this.ring, `scale(${(1 + e * 17).toFixed(3)})`);
      if (f >= 1) { this.ringT = -1; layer(this.ring, 0); }
    }

    // --- banner ------------------------------------------------------------
    if (this.bannerT >= 0) {
      this.bannerT += dt;
      const f = this.bannerT;
      const inT = clamp01(f / 0.13);
      const outStart = 0.13 + this.bannerDur;
      const out = f > outStart ? clamp01((f - outStart) / 0.85) : 0;
      const e = easeOutCubic(inT);
      // Letter-spacing collapses inward as it lands — a pressurised arrival.
      const ls = lerp(0.95, 0.40, e);
      setStyle(this.bannerBig, 'letterSpacing', `${ls.toFixed(3)}em`);
      setStyle(this.bannerBig, 'textIndent', `${ls.toFixed(3)}em`);
      setTransform(this.banner, `scale(${(1.05 - 0.05 * e + out * 0.05).toFixed(4)})`);
      const o = e * (1 - out * out);
      setClass(this.banner, 'on', o > 0.004);
      setOpacity(this.banner, o);
      if (out >= 1) { this.bannerT = -1; setClass(this.banner, 'on', false); }
    }
  }

  reset() {
    this.dmg = 0; this.dirA = 0; this.low = 0; this.lowTarget = 0;
    this.ariseA = 0; this.flashT = -1; this.ringT = -1; this.bannerT = -1;
    for (const n of [this.vigDmg, this.vigLow, this.vigArise, this.flash, this.ring, this.dir]) {
      setOpacity(n, 0); setShown(n, false);
    }
    for (const n of [this.dirN, this.dirS, this.dirE, this.dirW]) setOpacity(n, 0);
    setClass(this.banner, 'on', false);
    setOpacity(this.banner, 0);
  }

  dispose() {
    this.root.remove();
    this.banner.remove();
  }
}
