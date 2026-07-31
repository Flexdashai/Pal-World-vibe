/**
 * MONARCH — the cleave arc, and the dash-strike's cut.
 *
 * A blade at this camera is roughly 40 px long. What sells the swing is not the
 * weapon, it is the arc it leaves behind — so the arc gets the whole budget.
 *
 * ---------------------------------------------------------------------------
 * THE TIMELINE (per the quality bar: four phases, never a linear fade)
 *
 *   anticipation  none. A basic attack has its anticipation in the ANIMATION;
 *                 duplicating it in the VFX makes the swing feel late.
 *   strike        1 frame. The ribbon appears at 55% length, already at full
 *                 brightness, and sweeps to 100% over 110 ms. It is a step, not
 *                 a fade-in: an arc that fades up reads as a ghost.
 *   bloom-out     130 ms. The ribbon widens ~15%, lifts, and the brightness
 *                 collapses on an expo curve.
 *   dissipation   the embers and the ground scorch, 550-900 ms, easing out.
 *
 * Core / ring / embers / light run 1x / 2.5x / 6x / 3x of the core duration —
 * within one effect nothing shares a timeline.
 *
 * The finisher gets a second, counter-rotating ring and a violet outer edge, so
 * the fourth swing of the chain is visibly a different move rather than the same
 * one played louder.
 */

import * as THREE from 'three';
import { VFX, GLOW, clamp01, expoOut, easeOut } from './tuning.js';
import { makeSpellMaterial, tagEffect, buildArcRibbon, buildShockRing, elementRgb } from './fxkit.js';
import { ELEMENTS } from '../core/palette.js';

/** Concurrent arcs. Three is enough for a fast chain overlapping itself plus a
 *  dash-strike cutting through the middle of it. */
const ARC_SLOTS = 3;

export class CleaveArc {
  constructor(ctx, rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.name = 'mn.combat.cleave';
    ctx.scene.add(this.group);

    this._geo = [];
    this._mat = [];
    const render = ctx.peek('render');

    // Three authored arc shapes rather than one scaled three ways: the wide
    // horizontal sweep, the tight overhead chop, and the full spin. Each is a
    // different SILHOUETTE, which is the only thing legible at 21 m.
    this.geoWide = buildArcRibbon(2.05, 2.35, 0.52, 0.36, 30);
    this.geoChop = buildArcRibbon(1.85, 1.15, 0.72, 1.15, 22);
    // The finisher's ring is DELIBERATELY THIN. At 0.46 the ribbon was a 1.3 m
    // band of near-white smoke around the hero; a blade leaves a line, not a
    // cloud, and the thinner ribbon also lets the violet shell behind it read.
    this.geoSpin = buildArcRibbon(2.55, Math.PI * 2 - 0.10, 0.30, 0.10, 64, 2.4);
    this._geo.push(this.geoWide, this.geoChop, this.geoSpin);

    this.ringGeo = buildShockRing(0.55, 1.0, 44, 4);
    this._geo.push(this.ringGeo);

    this.slots = [];
    for (let i = 0; i < ARC_SLOTS; i++) {
      const arcMat = makeSpellMaterial(`cleaveArc${i}`, ELEMENTS.physical.glow, { opacity: 0 });
      const edgeMat = makeSpellMaterial(`cleaveEdge${i}`, ELEMENTS.shadow.core, { opacity: 0 });
      const ringMat = makeSpellMaterial(`cleaveRing${i}`, ELEMENTS.shadow.core, { opacity: 0 });
      this._mat.push(arcMat, edgeMat, ringMat);
      render?.registerMaterial?.(arcMat);
      render?.registerMaterial?.(edgeMat);
      render?.registerMaterial?.(ringMat);

      // The arc is drawn twice: a bright near-white body, and a slightly larger
      // violet shell behind it. Two passes of the same geometry is what gives an
      // additive effect a COLOURED EDGE — a single additive pass saturates to
      // white in the middle and has no rim at all.
      const arc = new THREE.Mesh(this.geoWide, arcMat);
      arc.name = `mn.combat.cleaveArc${i}`;
      tagEffect(arc, GLOW.core, 9);
      const edge = new THREE.Mesh(this.geoWide, edgeMat);
      edge.name = `mn.combat.cleaveEdge${i}`;
      tagEffect(edge, GLOW.ring, 8);
      const ring = new THREE.Mesh(this.ringGeo, ringMat);
      ring.name = `mn.combat.cleaveShock${i}`;
      tagEffect(ring, GLOW.ring, 8);

      this.group.add(edge, arc, ring);
      this.slots.push({
        arc, edge, ring, arcMat, edgeMat, ringMat,
        t: -1, life: VFX.cleave.arcLife, finisher: false,
        x: 0, y: 1.0, z: 0, yaw: 0, spin: 0, scale: 1, tilt: 0,
        element: 'physical',
      });
    }

    this._frozen = false;
    this.lightT = -1;
    this.lightLife = VFX.cleave.lightLife;
    this.lightPeak = 0;
    this.lightX = 0; this.lightY = 1; this.lightZ = 0;
    this.lightColour = ELEMENTS.physical.light;
  }

  /**
   * Fire an arc.
   *
   * @param variant 'wide' | 'chop' | 'spin'
   * @param yaw     world yaw the swing faces (radians, atan2(x, z) convention)
   * @param arc     the chain step's `arc` block: { from, to, tilt, thickness }
   */
  swing(x, y, z, yaw, variant, arc, element, motes, opts = {}) {
    let slot = null, oldestAge = -1, oldest = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.t < 0) { slot = s; break; }
      const age = s.t / s.life;
      if (age > oldestAge) { oldestAge = age; oldest = i; }
    }
    if (!slot) slot = this.slots[oldest];

    const geo = variant === 'spin' ? this.geoSpin : variant === 'chop' ? this.geoChop : this.geoWide;
    slot.arc.geometry = geo;
    slot.edge.geometry = geo;
    slot.t = 0;
    slot.finisher = variant === 'spin';
    slot.life = slot.finisher ? VFX.cleave.finisherLife : VFX.cleave.arcLife;
    slot.x = x; slot.y = y; slot.z = z;
    // The ribbon is authored centred on +Z; rotating the mesh by the swing yaw
    // puts it in front of the hero. The extra `from` term offsets the arc so a
    // right-to-left swing starts on the right.
    slot.yaw = yaw + (arc?.from ?? 0) * 0.35;
    slot.spin = ((arc?.to ?? 1) - (arc?.from ?? -1)) * 0.30;
    slot.scale = opts.scale ?? 1;
    slot.tilt = arc?.tilt ?? 0.3;
    slot.element = element;

    // The blade body IS meant to clip to white — it is a physical edge catching
    // the light — so this one keeps `glow`. The shell behind it is `core`.
    const glow = elementRgb(element, 'glow', 1.25);
    slot.arcMat.color.setRGB(glow[0], glow[1], glow[2], THREE.LinearSRGBColorSpace);
    // The violet shell is ALWAYS shadow, whatever the skill's element: it is the
    // Monarch's signature bleeding through his own weapon, and it is what keeps
    // a plain physical attack inside the game's colour identity.
    const sh = elementRgb('shadow', 'core', 1.0);
    slot.edgeMat.color.setRGB(sh[0], sh[1], sh[2], THREE.LinearSRGBColorSpace);
    slot.ringMat.color.setRGB(sh[0], sh[1], sh[2], THREE.LinearSRGBColorSpace);

    // ---- embers ------------------------------------------------------------
    // Thrown ALONG the arc, not radially: the swing has a direction and the
    // debris it kicks up must agree with it.
    if (motes) {
      const n = slot.finisher ? 26 : 10;
      const rng = this.rng;
      for (let i = 0; i < n; i++) {
        const a = yaw + rng.range(arc?.from ?? -1, arc?.to ?? 1);
        const r = (opts.range ?? 2.4) * rng.range(0.55, 1.05);
        const tangent = a + Math.PI * 0.5 * Math.sign((arc?.to ?? 1) - (arc?.from ?? -1));
        const sp = rng.range(1.6, 5.2);
        motes.spawn(
          x + Math.sin(a) * r, y + rng.range(-0.35, 0.5), z + Math.cos(a) * r,
          Math.sin(tangent) * sp, rng.range(0.5, 2.6), Math.cos(tangent) * sp,
          VFX.cleave.sparkLife * rng.range(0.7, 1.6),
          rng.range(0.022, 0.055), rng.range(0.5, 1.25),
          { gravity: -7.5, drag: rng.range(1.4, 2.8) }
        );
      }
    }

    // ---- light -------------------------------------------------------------
    const peak = slot.finisher ? 22 : 9;
    if (peak >= this.lightPeak || this.lightT < 0) {
      this.lightT = 0;
      this.lightLife = VFX.cleave.lightLife * (slot.finisher ? 2.4 : 1);
      this.lightPeak = peak;
      this.lightX = x; this.lightY = y + 0.2; this.lightZ = z;
      this.lightColour = ELEMENTS.shadow.light;
    }
    return slot;
  }

  update(dt) {
    const step = this._frozen ? 0 : dt;
    for (const s of this.slots) {
      if (s.t < 0) continue;
      s.t += step;
      const t = s.t / s.life;
      if (t >= 1) {
        s.t = -1;
        s.arc.visible = false;
        s.edge.visible = false;
        s.ring.visible = false;
        continue;
      }

      // ---- core: step on, sweep out, expo collapse -------------------------
      const sweep = clamp01(s.t / VFX.cleave.arcSweep);
      // Brightness holds for the first 30% then collapses. Not a fade: the
      // first two frames are at full radiance, which is what a strike phase is.
      const a = t < 0.30 ? 1 : 1 - expoOut((t - 0.30) / 0.70);
      const scale = s.scale * (0.55 + 0.45 * Math.pow(sweep, 0.55)) * (1 + t * 0.14);

      s.arc.visible = a > 0.012;
      s.edge.visible = a > 0.012;
      if (s.arc.visible) {
        s.arcMat.opacity = a * (s.finisher ? 0.78 : 0.95);
        // The violet shell outlives the white core by 60%, so as the arc dies it
        // goes from white-hot to violet rather than simply dimming. That colour
        // shift over 200 ms is most of what makes it read as magic.
        s.edgeMat.opacity = Math.pow(1 - t, 1.6) * (s.finisher ? 0.85 : 0.62);

        s.arc.position.set(s.x, s.y, s.z);
        s.edge.position.copy(s.arc.position);
        // The arc keeps rotating a little after the hit — follow-through.
        const yaw = s.yaw + s.spin * easeOut(t);
        s.arc.rotation.set(0, yaw, 0);
        s.edge.rotation.set(0, yaw, 0);
        // The shell is 12% larger and lifted 4 cm so it is never exactly
        // coincident with the core (which would z-fight in the additive pass).
        s.arc.scale.setScalar(scale);
        s.edge.scale.setScalar(scale * (s.finisher ? 1.09 : 1.14));
        s.edge.position.y += 0.04;
      }

      // ---- the finisher's shock ring, on its own 2.5x timeline -------------
      if (s.finisher) {
        const rt = clamp01(s.t / (s.life * 0.72));
        const ra = Math.pow(1 - rt, 2.4);
        s.ring.visible = ra > 0.015;
        if (s.ring.visible) {
          s.ringMat.opacity = ra * 0.8;
          s.ring.position.set(s.x, 0.05, s.z);
          const rs = (0.9 + expoOut(rt) * 4.4) * s.scale;
          s.ring.scale.set(rs, 1, rs);
          s.ring.rotation.y = -s.t * 1.8;
        }
      } else {
        s.ring.visible = false;
      }
    }

    if (this.lightT >= 0) {
      this.lightT += step;
      if (this.lightT > this.lightLife) { this.lightT = -1; this.lightPeak = 0; }
    }
  }

  /** The arc's light, on an envelope that peaks before the visual and decays
   *  slower — a swing that lights the wall for a moment after it has passed. */
  lightIntensity() {
    if (this.lightT < 0) return 0;
    const t = this.lightT / this.lightLife;
    return this.lightPeak * (t < 0.12 ? t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 1.9));
  }

  setFrozen(v) { this._frozen = !!v; }

  /** Hold a slot at an exact phase for the shot harness. */
  pose(slot, t) {
    if (!slot) return;
    slot.t = t * slot.life;
    this.lightT = Math.min(this.lightLife * 0.35, t * this.lightLife);
    this.update(0);
  }

  clear() {
    for (const s of this.slots) {
      s.t = -1;
      s.arc.visible = false;
      s.edge.visible = false;
      s.ring.visible = false;
    }
    this.lightT = -1;
    this.lightPeak = 0;
  }

  dispose() {
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this.group.removeFromParent();
  }
}
