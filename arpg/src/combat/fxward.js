/**
 * MONARCH — Aegis of Ash, the ward shell.
 *
 * The one persistent effect in the subsystem: everything else is a transient
 * measured in fractions of a second, but a ward stands for seven seconds while
 * the player keeps fighting. That changes what it has to be.
 *
 *  - It must not obscure the hero. Back faces only (the same rule as the domain
 *    dome and the monarch column), and low opacity: the shell is a suggestion of
 *    a boundary, not a bubble.
 *  - It must READ ITS OWN HEALTH. The shell brightens and tightens as it is
 *    eaten, and the last 25% flickers, so the player knows it is about to break
 *    without looking at the buff row.
 *  - It must break LOUDLY. The detonation is the payoff for having been hit, so
 *    the shell snaps out to 1.6x and vanishes in 180 ms.
 */

import * as THREE from 'three';
import { GLOW, clamp01, expoOut } from './tuning.js';
import { makeSpellMaterial, tagEffect, buildDomeShell, buildShockRing, elementRgb } from './fxkit.js';
import { ELEMENTS } from '../core/palette.js';

export class WardShell {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'mn.combat.ward';
    this.group.visible = false;
    ctx.scene.add(this.group);

    this._geo = [];
    this._mat = [];
    const render = ctx.peek('render');

    this.shellGeo = buildDomeShell(1.0, 12, 34, { apex: 0.22, base: 0.9, stripeGain: 0.9, floor: 0.06 });
    this.ringGeo = buildShockRing(0.86, 1.0, 44, 3);
    this._geo.push(this.shellGeo, this.ringGeo);

    this.shellMat = makeSpellMaterial('wardShell', ELEMENTS.holy.core, { side: THREE.BackSide });
    this.ringMat = makeSpellMaterial('wardRing', ELEMENTS.holy.glow, {});
    this._mat.push(this.shellMat, this.ringMat);
    render?.registerMaterial?.(this.shellMat);
    render?.registerMaterial?.(this.ringMat);

    this.shell = new THREE.Mesh(this.shellGeo, this.shellMat);
    this.shell.name = 'mn.combat.wardShell';
    tagEffect(this.shell, GLOW.dome, 8);
    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.ring.name = 'mn.combat.wardRing';
    tagEffect(this.ring, GLOW.ring, 8);
    this.group.add(this.shell, this.ring);

    this.active = false;
    this.frac = 1;           // remaining absorption, 0..1
    this.radius = 1.35;
    this.x = 0; this.y = 0; this.z = 0;
    this._t = 0;
    this._break = -1;        // >=0 while detonating
    this._frozen = false;
  }

  raise(x, y, z, radius) {
    this.active = true;
    this.frac = 1;
    this.radius = radius ?? 1.35;
    this.x = x; this.y = y; this.z = z;
    this._t = 0;
    this._break = -1;
    this.group.visible = true;
    const c = elementRgb('holy', 'core', 1.0);
    this.shellMat.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
    const g = elementRgb('holy', 'glow', 1.0);
    this.ringMat.color.setRGB(g[0], g[1], g[2], THREE.LinearSRGBColorSpace);
  }

  follow(x, y, z) { this.x = x; this.y = y; this.z = z; }

  /** Start the break animation. The shell snaps outward and dies in 180 ms. */
  shatter() {
    if (!this.active) return;
    this.active = false;
    this._break = 0;
  }

  update(dt) {
    if (!this.group.visible) return;
    const step = this._frozen ? 0 : dt;
    this._t += step;

    if (this._break >= 0) {
      this._break += step;
      const a = clamp01(this._break / 0.18);
      if (a >= 1) { this.group.visible = false; this._break = -1; return; }
      const s = this.radius * (1 + expoOut(a) * 0.6);
      this.shell.visible = true;
      this.shell.position.set(this.x, this.y + 0.05, this.z);
      this.shell.scale.set(s, s * 0.95, s);
      this.shellMat.opacity = (1 - a) * 0.85;
      this.ring.visible = true;
      this.ring.position.set(this.x, this.y + 0.06, this.z);
      const rs = this.radius * (1 + expoOut(a) * 2.4);
      this.ring.scale.set(rs, 1, rs);
      this.ringMat.opacity = (1 - a) * 0.9;
      return;
    }

    if (!this.active) { this.group.visible = false; return; }

    // Tightens and brightens as it is eaten; the last quarter flickers.
    const health = clamp01(this.frac);
    const flicker = health < 0.25
      ? 0.55 + 0.45 * Math.sin(this._t * 26)
      : 1;
    const breathe = 1 + Math.sin(this._t * 2.1) * 0.035;
    const s = this.radius * (0.86 + 0.14 * health) * breathe;

    this.shell.visible = true;
    this.shell.position.set(this.x, this.y + 0.05, this.z);
    this.shell.scale.set(s, s * 0.92, s);
    this.shellMat.opacity = (0.10 + (1 - health) * 0.22) * flicker;

    this.ring.visible = true;
    this.ring.position.set(this.x, this.y + 0.035, this.z);
    this.ring.scale.set(s * 1.02, 1, s * 1.02);
    this.ring.rotation.y = this._t * 0.6;
    this.ringMat.opacity = (0.28 + (1 - health) * 0.35) * flicker;
  }

  setFrozen(v) { this._frozen = !!v; }

  clear() {
    this.active = false;
    this._break = -1;
    this.group.visible = false;
  }

  dispose() {
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this.group.removeFromParent();
  }
}
