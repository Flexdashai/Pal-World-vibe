/**
 * MONARCH — MONARCH'S DOMAIN.
 *
 * The ultimate, and the single most spectacular thing in the game. It has to
 * carry the whole Solo Leveling power fantasy in one frame: the Monarch claims
 * the ground, the ground answers, and everything inside it belongs to him.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ON SCREEN, AND WHY EACH PIECE EXISTS
 *
 *   ground plate   a 13.5 m disc of deep violet. Establishes the AREA — without
 *                  it the effect is a dome floating over a floor it does not own.
 *   rune rings     two counter-rotating rings of ground-inscribed glyphs. The
 *                  counter-rotation is what stops a big circular effect reading
 *                  as a loading spinner.
 *   boundary       a hot ring at the perimeter, the edge of the Monarch's ground.
 *   dome           a back-face-only hemisphere with eight bright meridians.
 *                  BACK FACES ONLY: a double-sided additive dome puts two layers
 *                  of violet between the camera and the fight inside it, and the
 *                  boss disappears. Drawing only the far wall means the dome
 *                  stands behind the fight and every silhouette cuts into it.
 *   pillars        six columns at the perimeter. They give the dome VERTICAL
 *                  STRUCTURE — a smooth dome at this camera reads as fog.
 *   column         a 9 m shaft of light at the Monarch. The anchor: the effect
 *                  must obviously come FROM him.
 *   motes          ash rising inside the volume, so the domain has interior life
 *                  rather than being a shell around empty air.
 *   pulse rings    one per damage pulse, sweeping out from the centre. The
 *                  gameplay is legible from the visuals alone.
 *
 * ---------------------------------------------------------------------------
 * THE TIMELINE
 *
 *   scribe    0.55 s  ease in. The plate and the runes draw themselves outward
 *                     from the Monarch; nothing is above the floor yet.
 *   erupt     0.22 s  step. The dome and the pillars shoot up, the column snaps
 *                     on, the light peaks far above its hold value, the hit-stop
 *                     lands, the first damage pulse fires.
 *   hold      6.2 s   the domain stands. Everything breathes on slightly
 *                     different periods (1.9 s / 2.7 s / 3.4 s) so nothing is
 *                     ever exactly in phase, which is what makes it feel alive
 *                     rather than looped.
 *   collapse  1.2 s   ease out. The dome contracts and brightens as it folds
 *                     back into the Monarch — energy is conserved, so it gets
 *                     brighter as it gets smaller.
 */

import * as THREE from 'three';
import { VFX, GLOW, clamp01, easeIn, easeOut, expoOut, smooth } from './tuning.js';
import {
  makeSpellMaterial, tagEffect, buildDomeShell, buildGroundDisc, buildShockRing,
  buildGroundRunes, buildSpireRing,
} from './fxkit.js';
import { ELEMENTS } from '../core/palette.js';

/** Concurrent pulse rings. Six covers the 6.2 s domain at one pulse per 0.75 s
 *  with the oldest still fading. */
const PULSE_SLOTS = 6;

export class MonarchDomain {
  constructor(ctx, rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.name = 'mn.combat.domain';
    this.group.visible = false;
    ctx.scene.add(this.group);

    this._geo = [];
    this._mat = [];
    const render = ctx.peek('render');
    const mk = (name, colour, opts) => {
      const m = makeSpellMaterial(name, colour, opts);
      this._mat.push(m);
      render?.registerMaterial?.(m);
      return m;
    };

    // EVERY bright element of the domain uses `core` (#7B4BFF, near-pure blue)
    // and not `glow` (the pastel #C9A8FF). Additive blending saturates the blue
    // channel first, so `core` stays violet as it stacks and blooms while
    // `glow` washes to white — the second ultimate capture had a violet room
    // full of pale grey shards for exactly this reason. `glow` is reserved for
    // small hot centres that are SUPPOSED to clip to white.
    const SH = ELEMENTS.shadow;
    const R = VFX.domain.radius;

    // ---- ground plate -------------------------------------------------------
    // Deep violet, low opacity, wide falloff. It is the FLOOR of the domain and
    // it must not compete with anything standing on it, so it uses `dark` (the
    // deep edge colour) scaled up rather than the hot core.
    this.plateGeo = buildGroundDisc(1.0, 64, 6, 1.25);
    this._geo.push(this.plateGeo);
    this.plateMat = mk('domainPlate', SH.dark, {});
    this.plate = new THREE.Mesh(this.plateGeo, this.plateMat);
    this.plate.name = 'mn.combat.domainPlate';
    tagEffect(this.plate, GLOW.scar, 6);
    this.group.add(this.plate);

    // ---- rune rings ---------------------------------------------------------
    // 0.14 / 0.10 of the domain radius: at 13.5 m that is a rune roughly 0.8 m
    // and 0.55 m tall — 34 px and 23 px at this camera, which is the size a
    // glyph has to be to read as a glyph rather than as a slab.
    this.runeGeoA = buildGroundRunes(rng.fork(), 18, 0.62, 0.14);
    this.runeGeoB = buildGroundRunes(rng.fork(), 28, 0.90, 0.10);
    this._geo.push(this.runeGeoA, this.runeGeoB);
    this.runeMatA = mk('domainRunesA', SH.core, {});
    this.runeMatB = mk('domainRunesB', SH.core, {});
    this.runesA = new THREE.Mesh(this.runeGeoA, this.runeMatA);
    this.runesB = new THREE.Mesh(this.runeGeoB, this.runeMatB);
    this.runesA.name = 'mn.combat.domainRunesA';
    this.runesB.name = 'mn.combat.domainRunesB';
    tagEffect(this.runesA, GLOW.rune, 7);
    tagEffect(this.runesB, GLOW.rune, 7);
    this.group.add(this.runesA, this.runesB);

    // ---- boundary ring ------------------------------------------------------
    this.boundGeo = buildShockRing(0.955, 1.0, 96, 4);
    this._geo.push(this.boundGeo);
    this.boundMat = mk('domainBound', SH.core, {});
    this.bound = new THREE.Mesh(this.boundGeo, this.boundMat);
    this.bound.name = 'mn.combat.domainBound';
    tagEffect(this.bound, GLOW.ring, 8);
    this.group.add(this.bound);

    // ---- dome ---------------------------------------------------------------
    // No apex lift and almost no ambient floor: from a camera 16 m up looking
    // down, everything except the rim of a 13.5 m dome is ceiling, and a
    // ceiling covers the fight. What survives is the horizon band and the
    // eight meridians, which is exactly the boundary read we want.
    this.domeGeo = buildDomeShell(1.0, 18, 56, { apex: 0, base: 1.0, stripeGain: 1.7, floor: 0.012 });
    this._geo.push(this.domeGeo);
    this.domeMat = mk('domainDome', SH.core, { side: THREE.BackSide });
    this.dome = new THREE.Mesh(this.domeGeo, this.domeMat);
    this.dome.name = 'mn.combat.domainDome';
    tagEffect(this.dome, GLOW.dome, 8);
    this.group.add(this.dome);

    // ---- pillars ------------------------------------------------------------
    // Normalised to the pillar ring radius (R*0.92 = 12.4 m): 0.68 of it is an
    // 8.4 m pillar and 0.05 is a 0.62 m base. See buildSpireRing.
    this.pillarGeo = buildSpireRing(6, 1.0, 0.68, 0.050, rng.fork());
    this._geo.push(this.pillarGeo);
    this.pillarMat = mk('domainPillars', SH.core, {});
    this.pillars = new THREE.Mesh(this.pillarGeo, this.pillarMat);
    this.pillars.name = 'mn.combat.domainPillars';
    tagEffect(this.pillars, GLOW.column, 9);
    this.group.add(this.pillars);

    // Inner ring of shorter spikes, counter-rotating, at 45% of the radius.
    this.innerGeo = buildSpireRing(14, 1.0, 0.62, 0.048, rng.fork());
    this._geo.push(this.innerGeo);
    this.innerMat = mk('domainInner', SH.core, {});
    this.inner = new THREE.Mesh(this.innerGeo, this.innerMat);
    this.inner.name = 'mn.combat.domainInner';
    tagEffect(this.inner, GLOW.ring, 9);
    this.group.add(this.inner);

    // ---- central column -----------------------------------------------------
    // Back faces only, same reasoning as the dome and as `player/aura.js`'s
    // monarch column. This one is much bigger — 2.1 m across and 9 m tall — and
    // is the visual anchor tying the whole effect to the Monarch's body.
    this.columnGeo = buildColumn(1.05, 9.0, 30, 11);
    this._geo.push(this.columnGeo);
    this.columnMat = mk('domainColumn', SH.core, { side: THREE.BackSide });
    this.column = new THREE.Mesh(this.columnGeo, this.columnMat);
    this.column.name = 'mn.combat.domainColumn';
    tagEffect(this.column, GLOW.column, 9);
    this.group.add(this.column);

    // ---- pulse rings --------------------------------------------------------
    this.pulseGeo = buildShockRing(0.70, 1.0, 72, 4);
    this._geo.push(this.pulseGeo);
    this.pulses = [];
    for (let i = 0; i < PULSE_SLOTS; i++) {
      const m = mk(`domainPulse${i}`, SH.core, {});
      const mesh = new THREE.Mesh(this.pulseGeo, m);
      mesh.name = `mn.combat.domainPulse${i}`;
      tagEffect(mesh, GLOW.ring, 8);
      this.group.add(mesh);
      this.pulses.push({ mesh, mat: m, t: -1, life: 0.85 });
    }

    // ---- state --------------------------------------------------------------
    this.t = -1;
    this.x = 0; this.y = 0; this.z = 0;
    this.radius = R;
    this.holdTime = VFX.domain.hold;
    this._frozen = false;
    this._spin = 0;

    const d = VFX.domain;
    this.tScribe = d.scribe;
    this.tErupt = this.tScribe + d.erupt;
    this._collapseAt = 0;
    this._end = 0;
  }

  /** Begin. `hold` overrides the default standing time (the skill's own
   *  `domain.duration`). */
  fire(x, y, z, radius, hold, motes) {
    this.t = 0;
    this.x = x; this.y = y; this.z = z;
    this.radius = radius ?? VFX.domain.radius;
    this.holdTime = hold ?? VFX.domain.hold;
    this._collapseAt = this.tErupt + this.holdTime;
    this._end = this._collapseAt + VFX.domain.collapse;
    this._spin = this.rng.range(0, Math.PI * 2);
    this.group.visible = true;
    for (const p of this.pulses) { p.t = -1; p.mesh.visible = false; }
    this._seedMotes(motes, 40, true);
    return this;
  }

  /** A damage pulse: a ring sweeps out from the centre, and a handful of motes
   *  are thrown up along the front so the pulse has material as well as light. */
  pulse(motes, strength = 1) {
    let slot = null, oldest = -1, oldestAge = -1;
    for (let i = 0; i < this.pulses.length; i++) {
      const p = this.pulses[i];
      if (p.t < 0) { slot = p; break; }
      const age = p.t / p.life;
      if (age > oldestAge) { oldestAge = age; oldest = i; }
    }
    if (!slot) slot = this.pulses[oldest];
    slot.t = 0;
    slot.life = 0.75 + strength * 0.25;
    this._seedMotes(motes, 22, false);
  }

  _seedMotes(motes, n, initial) {
    if (!motes) return;
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng.float() * Math.PI * 2;
      // sqrt for a uniform area distribution — a linear radius bunches
      // everything at the centre, which looks like a fountain, not a volume.
      const r = this.radius * Math.sqrt(rng.float()) * (initial ? 1.0 : 0.85);
      motes.spawn(
        this.x + Math.sin(a) * r,
        this.y + (initial ? rng.range(0.02, 0.6) : rng.range(0.02, 1.4)),
        this.z + Math.cos(a) * r,
        rng.range(-0.35, 0.35), rng.range(0.9, 3.4), rng.range(-0.35, 0.35),
        rng.range(1.6, 3.6), rng.range(0.024, 0.070), rng.range(0.4, 1.15),
        { gravity: 1.1, drag: 0.55 }
      );
    }
  }

  update(dt) {
    if (this.t < 0) return;
    if (!this._frozen) this.t += dt;
    const t = this.t;
    if (t > this._end) { this.clear(); return; }

    const R = this.radius;
    const spin = this._spin;
    // Three breathing periods that never line up. A single sine on everything
    // is what makes a big standing effect read as a screensaver.
    const b1 = Math.sin(t * 3.3) * 0.5 + 0.5;
    const b2 = Math.sin(t * 2.33 + 1.9) * 0.5 + 0.5;
    const b3 = Math.sin(t * 1.85 + 3.7) * 0.5 + 0.5;

    // ---- master envelopes ---------------------------------------------------
    // `scribe` 0..1 across the ground phase; `rise` 0..1 across the eruption;
    // `fold` 1..0 across the collapse.
    const scribe = clamp01(t / this.tScribe);
    const rise = clamp01((t - this.tScribe) / VFX.domain.erupt);
    const fold = t < this._collapseAt ? 1
      : 1 - clamp01((t - this._collapseAt) / VFX.domain.collapse);
    // Energy is conserved: as the domain folds it gets SMALLER and BRIGHTER.
    const foldGain = t < this._collapseAt ? 1 : 1 + (1 - fold) * 2.6;
    const strikeGain = rise > 0 && rise < 0.16 ? 3.4 : 1.0;

    // ---- ground plate -------------------------------------------------------
    this.plate.visible = true;
    this.plate.position.set(this.x, this.y + 0.012, this.z);
    const plateR = R * easeIn(scribe) * (0.35 + 0.65 * fold);
    this.plate.scale.set(plateR, 1, plateR);
    this.plate.rotation.y = spin;
    this.plateMat.opacity = (0.26 + b3 * 0.07) * scribe * fold;

    // ---- runes --------------------------------------------------------------
    // The two rings counter-rotate at different speeds and sit at different
    // radii, so the ground never reads as one spinning disc.
    this.runesA.visible = scribe > 0.02;
    this.runesA.position.set(this.x, this.y + 0.026, this.z);
    const rA = R * smooth(clamp01(scribe * 1.25)) * fold;
    this.runesA.scale.set(rA, 1, rA);
    this.runesA.rotation.y = spin + t * 0.24;
    this.runeMatA.opacity = (0.85 + b1 * 0.45) * scribe * fold * foldGain;

    this.runesB.visible = scribe > 0.12;
    this.runesB.position.set(this.x, this.y + 0.034, this.z);
    const rB = R * smooth(clamp01((scribe - 0.12) * 1.5)) * fold;
    this.runesB.scale.set(rB, 1, rB);
    this.runesB.rotation.y = spin - t * 0.41;
    this.runeMatB.opacity = (0.62 + b2 * 0.38) * clamp01((scribe - 0.12) * 1.5) * fold * foldGain;

    // ---- boundary -----------------------------------------------------------
    this.bound.visible = scribe > 0.05;
    this.bound.position.set(this.x, this.y + 0.05 + b2 * 0.04, this.z);
    const bR = R * easeOut(scribe) * fold;
    this.bound.scale.set(bR, 1, bR);
    this.bound.rotation.y = spin * 0.5 + t * 0.09;
    this.boundMat.opacity = (1.05 + b1 * 0.45) * scribe * fold * foldGain;

    // ---- dome ---------------------------------------------------------------
    if (rise > 0) {
      this.dome.visible = true;
      this.dome.position.set(this.x, this.y + 0.02, this.z);
      const dR = R * fold;
      // Overshoot on the way up — the dome punches past its resting size by 8%
      // and settles back. Nothing in nature arrives at its final size exactly.
      const over = 1 + Math.sin(clamp01(rise) * Math.PI) * 0.08;
      this.dome.scale.set(dR * expoOut(rise) * over, dR * 0.40 * expoOut(rise) * over, dR * expoOut(rise) * over);
      this.dome.rotation.y = spin - t * 0.055;
      this.domeMat.opacity = (0.115 + b3 * 0.045) * fold * foldGain * strikeGain;
    } else {
      this.dome.visible = false;
    }

    // ---- pillars ------------------------------------------------------------
    if (rise > 0) {
      this.pillars.visible = true;
      this.pillars.position.set(this.x, this.y, this.z);
      const pr = R * 0.92 * fold;
      this.pillars.scale.set(pr, pr * expoOut(rise) * fold * (0.9 + b1 * 0.14), pr);
      this.pillars.rotation.y = spin + t * 0.06;
      this.pillarMat.opacity = (0.70 + b2 * 0.26) * fold * foldGain * strikeGain;

      this.inner.visible = true;
      this.inner.position.set(this.x, this.y, this.z);
      const ir = R * 0.45 * fold;
      this.inner.scale.set(ir, ir * expoOut(clamp01(rise * 1.4)) * fold * (0.85 + b3 * 0.22), ir);
      this.inner.rotation.y = spin - t * 0.19;
      this.innerMat.opacity = (0.44 + b1 * 0.24) * fold * foldGain;
    } else {
      this.pillars.visible = false;
      this.inner.visible = false;
    }

    // ---- central column -----------------------------------------------------
    if (rise > 0) {
      this.column.visible = true;
      this.column.position.set(this.x, this.y, this.z);
      const cs = (0.85 + b2 * 0.13) * (0.4 + 0.6 * fold);
      this.column.scale.set(cs, expoOut(rise) * (0.8 + 0.35 * fold), cs);
      this.column.rotation.y = -t * 0.42;
      this.columnMat.opacity = (0.50 + b1 * 0.22) * fold * foldGain * strikeGain;
    } else {
      this.column.visible = false;
    }

    // ---- pulse rings --------------------------------------------------------
    for (const p of this.pulses) {
      if (p.t < 0) { p.mesh.visible = false; continue; }
      if (!this._frozen) p.t += dt;
      const a = p.t / p.life;
      if (a >= 1) { p.t = -1; p.mesh.visible = false; continue; }
      p.mesh.visible = true;
      p.mesh.position.set(this.x, this.y + 0.09 + a * 0.55, this.z);
      const pr = R * (0.10 + 0.95 * expoOut(a));
      p.mesh.scale.set(pr, 1, pr);
      p.mesh.rotation.y = spin + a * 0.6;
      p.mat.opacity = Math.pow(1 - a, 1.8) * 0.85 * fold;
    }
  }

  /**
   * The domain's light. Three regimes:
   *   during the scribe   a low violet wash off the floor
   *   at the eruption     an enormous peak, one frame before the visual
   *   while it stands     a breathing hold, so the room stays violet the whole
   *                       time the domain is up — this is the single biggest
   *                       lever the ultimate has on the frame's overall look
   */
  lightIntensity() {
    if (this.t < 0) return 0;
    const t = this.t;
    if (t < this.tScribe) return 6 * easeIn(t / this.tScribe);
    if (t < this.tErupt) {
      const a = (t - this.tScribe) / VFX.domain.erupt;
      return 6 + 44 * (a < 0.25 ? a / 0.25 : Math.pow(1 - (a - 0.25) / 0.75, 1.4));
    }
    if (t < this._collapseAt) {
      // Held low on purpose. `sky` picks its two volumetric sources by
      // intensity/(1+d2) about the camera focus, and this light sits ON the
      // focus, so anything large here erases both braziers and floods the room
      // with a flat violet haze — measured on the first ultimate capture.
      return 19 + 5 * (Math.sin(t * 2.33 + 1.9) * 0.5 + 0.5);
    }
    const a = clamp01((t - this._collapseAt) / VFX.domain.collapse);
    // Brightens as it folds, then snaps off.
    return 15 + 22 * a * a - 37 * Math.pow(a, 6);
  }

  /** Secondary lights at the perimeter, so the domain lifts the walls of the
   *  room and not only the floor around the player. Returns the world position
   *  of light `i` in `out`. */
  perimeterLight(i, out) {
    const a = this._spin + (i / 2) * Math.PI + this.t * 0.15;
    const r = this.radius * 0.66;
    out.set(this.x + Math.sin(a) * r, this.y + 1.6, this.z + Math.cos(a) * r);
    return out;
  }

  get active() { return this.t >= 0; }
  /** True once the domain has erupted and before it starts folding — the window
   *  in which it deals damage and buffs the army. */
  get standing() { return this.t >= this.tErupt && this.t < this._collapseAt; }

  setFrozen(v) { this._frozen = !!v; }

  clear() {
    this.t = -1;
    this.group.visible = false;
    for (const p of this.pulses) { p.t = -1; p.mesh.visible = false; }
  }

  dispose() {
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this.group.removeFromParent();
  }
}

/**
 * A double-walled cylinder with a vertical brightness gradient baked into the
 * vertex colours. Both shells are wound outward and the material culls front
 * faces, so what reaches the screen is the FAR wall of each — a column standing
 * behind the Monarch rather than a haze draped over him.
 *
 * (The same construction as `player/aura.js`'s column, at four times the scale.
 * It is duplicated rather than shared because ARCHITECTURE.md forbids importing
 * another subsystem's module, and the geometry is nine lines.)
 */
function buildColumn(radius, height, segments, rings) {
  const pos = [];
  const col = [];
  const idx = [];
  for (let shell = 0; shell < 2; shell++) {
    const r = radius * (shell === 0 ? 1 : 0.58);
    const base = pos.length / 3;
    for (let iy = 0; iy <= rings; iy++) {
      const t = iy / rings;
      const bright = (Math.pow(1 - t, 2.2) * 0.85 + Math.exp(-t * 16) * 0.75) *
        (shell === 0 ? 1 : 0.6);
      for (let ia = 0; ia < segments; ia++) {
        const a = (ia / segments) * Math.PI * 2;
        // Fluted: eight brighter staves so the column has structure at 21 m.
        const flute = 1 + Math.pow(Math.abs(Math.sin(a * 4)), 6) * 0.9;
        pos.push(Math.sin(a) * r, t * height, Math.cos(a) * r);
        const b = bright * flute;
        col.push(b, b, b);
      }
    }
    for (let iy = 0; iy < rings; iy++) {
      for (let ia = 0; ia < segments; ia++) {
        const a = base + iy * segments + ia;
        const b = base + iy * segments + ((ia + 1) % segments);
        const c = base + (iy + 1) * segments + ((ia + 1) % segments);
        const d = base + (iy + 1) * segments + ia;
        idx.push(a, b, c, a, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.name = 'mn.combat.domainColumn';
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
