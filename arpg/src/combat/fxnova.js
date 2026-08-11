/**
 * MONARCH — SHADOW NOVA.
 *
 * The violet AoE that erupts from the player, and the single clearest statement
 * of the game's colour identity: a near-monochrome crypt with one saturated
 * thing in it.
 *
 * ---------------------------------------------------------------------------
 * THE TIMELINE
 *
 *   anticipation  200 ms, ease IN. Motes converge on the caster from a 7 m
 *                 radius, ACCELERATING as they arrive; a gather ring contracts
 *                 from 3.2 m to 0.5 m; the light builds from nothing. This is
 *                 the phase most projects skip and it is the one that makes the
 *                 detonation land.
 *   strike        45 ms, STEP. The core disc snaps to full size at 5.2x its
 *                 final brightness — far above anything else in the frame — the
 *                 light peaks, and this is the frame the hit-stop lands on.
 *   bloom-out     340 ms, expo out. The shock ring expands past the damage
 *                 radius and thins to nothing; a second slower ring follows it;
 *                 eight spires erupt out of the floor and fall back.
 *   dissipation   950 ms, ease out. Embers drift up, the ground scar fades over
 *                 1.5 s, the light decays to zero over 550 ms.
 *
 * Core / ring / spires / embers / scar / light all run their own durations —
 * 0.29 / 0.62 / 0.85 / 1.5 / 1.5 / 0.55 s. Nothing shares a curve.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SPIRES
 *
 * A ring on the floor plus a flash reads as a decal. The whole effect lives in
 * one plane and the isometric camera flattens it further. Eight violet spikes
 * erupting to 2.6 m give the nova VERTICAL EXTENT, which is the only way an AoE
 * reads as an explosion rather than as a texture at this camera angle.
 */

import * as THREE from 'three';
import { VFX, GLOW, clamp01, expoOut, easeIn, easeOut, smooth } from './tuning.js';
import {
  makeSpellMaterial, tagEffect, buildShockRing, buildGroundDisc,
  buildSpireRing, buildDomeShell, elementRgb,
} from './fxkit.js';
import { ELEMENTS } from '../core/palette.js';

export class NovaBurst {
  constructor(ctx, rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.name = 'mn.combat.nova';
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

    const SH = ELEMENTS.shadow;

    // ---- the gather ring (anticipation) ------------------------------------
    // A thin ring that contracts onto the caster. Counter-rotating against the
    // spire ring so the two layers shear during the wind-up.
    this.gatherGeo = buildShockRing(0.80, 1.0, 52, 3);
    this._geo.push(this.gatherGeo);
    this.gatherMat = mk('novaGather', SH.core, {});
    this.gather = new THREE.Mesh(this.gatherGeo, this.gatherMat);
    this.gather.name = 'mn.combat.novaGather';
    tagEffect(this.gather, GLOW.ring, 9);
    this.group.add(this.gather);

    // ---- the core (strike) --------------------------------------------------
    // A hemispherical shell, back faces only, so the hero standing inside it is
    // silhouetted against the far wall of the flash rather than buried in it.
    // The nova core is small enough that the camera really is outside it, so it
    // keeps an apex and a near-uniform brightness: it is a hot ball, not a rim.
    this.coreGeo = buildDomeShell(1.0, 9, 30, { apex: 0.9, base: 0.7, stripeGain: 0.3, floor: 0.55 });
    this._geo.push(this.coreGeo);
    this.coreMat = mk('novaCore', SH.glow, { side: THREE.BackSide });
    this.core = new THREE.Mesh(this.coreGeo, this.coreMat);
    this.core.name = 'mn.combat.novaCore';
    tagEffect(this.core, GLOW.core, 10);
    this.group.add(this.core);

    // ---- the shock rings (bloom-out) ---------------------------------------
    this.ringGeo = buildShockRing(0.80, 1.0, 72, 5);
    this._geo.push(this.ringGeo);
    this.ringMat = mk('novaRing', SH.core, {});
    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.ring.name = 'mn.combat.novaRing';
    tagEffect(this.ring, GLOW.ring, 9);
    this.group.add(this.ring);

    this.ring2Mat = mk('novaRing2', SH.core, {});
    this.ring2 = new THREE.Mesh(this.ringGeo, this.ring2Mat);
    this.ring2.name = 'mn.combat.novaRing2';
    tagEffect(this.ring2, GLOW.ring, 9);
    this.group.add(this.ring2);

    // ---- the spires --------------------------------------------------------
    // Normalised to the ring radius (see buildSpireRing): the mesh is scaled
    // uniformly by the ring radius, so 0.62 of a 3.97 m ring is a 2.5 m spike
    // and 0.085 of it is a 0.34 m base. At 21 m and 34 deg that is ~100 px tall
    // and ~14 px wide, which is a spike; the first pass baked metres here and
    // produced 1.7 m wide slabs that filled the frame.
    this.spireGeo = buildSpireRing(9, 1.0, 0.62, 0.085, rng.fork());
    this._geo.push(this.spireGeo);
    this.spireMat = mk('novaSpires', SH.core, {});
    this.spires = new THREE.Mesh(this.spireGeo, this.spireMat);
    this.spires.name = 'mn.combat.novaSpires';
    tagEffect(this.spires, GLOW.core, 9);
    this.group.add(this.spires);

    // A second, inner ring of shorter spikes on its own phase offset. Two rings
    // of different heights is the difference between "an eruption" and "a fence".
    this.spireGeo2 = buildSpireRing(13, 1.0, 0.55, 0.072, rng.fork());
    this._geo.push(this.spireGeo2);
    this.spireMat2 = mk('novaSpires2', SH.core, {});
    this.spires2 = new THREE.Mesh(this.spireGeo2, this.spireMat2);
    this.spires2.name = 'mn.combat.novaSpires2';
    tagEffect(this.spires2, GLOW.ring, 9);
    this.group.add(this.spires2);

    // ---- the ground scar (dissipation) -------------------------------------
    // Not a decal — `fx` owns decals. This is the spell's own scorch, which
    // fades completely in 1.5 s and leaves the persistent mark to `fx`.
    this.scarGeo = buildGroundDisc(1.0, 56, 5, 1.7);
    this._geo.push(this.scarGeo);
    this.scarMat = mk('novaScar', SH.dark, {});
    this.scar = new THREE.Mesh(this.scarGeo, this.scarMat);
    this.scar.name = 'mn.combat.novaScar';
    tagEffect(this.scar, GLOW.scar, 7);
    this.group.add(this.scar);

    // ---- state -------------------------------------------------------------
    this.t = -1;
    this.radius = 6.4;
    this.x = 0; this.y = 0; this.z = 0;
    this.element = 'shadow';
    this.strength = 1;
    this._frozen = false;
    this._spin = 0;

    /** Absolute phase boundaries, cached so `update` does no arithmetic on
     *  constants sixty times a second. */
    const n = VFX.nova;
    this.tAnticipate = n.anticipation;
    this.tStrike = this.tAnticipate + n.strike;
    this.tBloom = this.tStrike + n.bloom;
    this.tEnd = this.tBloom + n.dissipate;
  }

  /**
   * Begin a nova. `t` runs from 0, so the anticipation phase plays before the
   * damage window opens — `executor.js` fires this at the start of the skill's
   * wind-up and resolves damage when `t` crosses `tAnticipate`.
   */
  fire(x, y, z, radius, element, strength, motes) {
    this.t = 0;
    this.x = x; this.y = y; this.z = z;
    this.radius = radius;
    this.element = element;
    this.strength = strength;
    this.group.visible = true;
    this._spin = this.rng.range(0, Math.PI * 2);

    const core = elementRgb(element, 'glow', 1.0);
    this.coreMat.color.setRGB(core[0], core[1], core[2], THREE.LinearSRGBColorSpace);
    const c = elementRgb(element, 'core', 1.0);
    for (const m of [this.gatherMat, this.ringMat, this.spireMat]) {
      m.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
    }
    // `core`, not `glow`: see the note in fxdomain.js — additive `glow` washes
    // to white and the violet signature is the whole point of the effect.
    const g = elementRgb(element, 'core', 1.1);
    for (const m of [this.ring2Mat, this.spireMat2]) {
      m.color.setRGB(g[0], g[1], g[2], THREE.LinearSRGBColorSpace);
    }
    const d = elementRgb(element, 'dark', 1.7);
    this.scarMat.color.setRGB(d[0], d[1], d[2], THREE.LinearSRGBColorSpace);

    // ---- the gather: motes converging on the caster -------------------------
    // Spawned ONCE, at the start of the anticipation, with a converge target at
    // the caster's chest. They accelerate in (see MoteField's converge mode),
    // which is the read that something is being gathered rather than emitted.
    if (motes) {
      const rng = this.rng;
      const n = Math.round(56 * clamp01(strength) + 24);
      for (let i = 0; i < n; i++) {
        const a = rng.float() * Math.PI * 2;
        const r = radius * rng.range(0.35, 1.15);
        const h = rng.range(0.05, 2.6);
        motes.spawn(
          x + Math.sin(a) * r, y + h, z + Math.cos(a) * r,
          0, 0, 0,
          VFX.nova.anticipation * rng.range(0.85, 1.15),
          rng.range(0.030, 0.075), rng.range(0.8, 1.9),
          { converge: true, tx: x, ty: y + 1.15, tz: z, drag: 0.6 }
        );
      }
    }
    return this;
  }

  /** The instant the damage lands — call from the executor's strike window so
   *  the ember spray and the scar are seeded exactly on the impact frame. */
  detonate(motes) {
    if (!motes) return;
    const rng = this.rng;
    const n = Math.round(90 * clamp01(this.strength) + 34);
    for (let i = 0; i < n; i++) {
      const a = rng.float() * Math.PI * 2;
      // Emission is biased to the ground plane — an explosion on a floor throws
      // material outward and up, not spherically.
      const r = rng.range(0.2, 1.0);
      const sp = this.radius * rng.range(1.1, 3.0);
      motes.spawn(
        this.x + Math.sin(a) * r, this.y + rng.range(0.03, 0.55), this.z + Math.cos(a) * r,
        Math.sin(a) * sp, rng.range(1.2, 9.5), Math.cos(a) * sp,
        VFX.nova.emberLife * rng.range(0.45, 1.2),
        rng.range(0.025, 0.085), rng.range(0.7, 2.0),
        { gravity: -6.2, drag: rng.range(1.3, 3.2) }
      );
    }
  }

  update(dt) {
    if (this.t < 0) return;
    if (!this._frozen) this.t += dt;
    const t = this.t;
    if (t > this.tEnd + VFX.nova.scarLife) {
      this.t = -1;
      this.group.visible = false;
      return;
    }
    const R = this.radius;
    const S = clamp01(this.strength);

    // ---- gather ring: contracts, spins up, snaps out at the strike ---------
    if (t < this.tStrike) {
      const a = clamp01(t / VFX.nova.anticipation);
      this.gather.visible = true;
      // Contracts from 55% of the radius onto the caster, easing IN so it
      // accelerates inward.
      const gr = R * (0.55 - 0.47 * easeIn(a));
      this.gather.position.set(this.x, this.y + 0.06 + a * 0.5, this.z);
      this.gather.scale.set(gr, 1, gr);
      this.gather.rotation.y = this._spin + a * a * 9.0;
      this.gatherMat.opacity = 0.12 + a * a * 0.85;
    } else {
      this.gather.visible = false;
    }

    // ---- core: STEP to full size, then collapse ---------------------------
    // The strike phase is a step function, not a ramp. On its first frame the
    // core is already at `strikeGain` times the brightness anything else in the
    // frame reaches, which is what "white-hot core far above final brightness"
    // means in practice.
    if (t >= this.tAnticipate && t < this.tBloom) {
      const ct = clamp01((t - this.tAnticipate) / (VFX.nova.strike + VFX.nova.bloom * 0.75));
      this.core.visible = true;
      // The core is a HOT CENTRE, not a dome the size of the AoE: at R*0.85 it
      // was a 5.4 m shell that swallowed the hero standing inside it. 0.12..0.38
      // of the radius reads as a detonation the shock ring then runs away from.
      const cs = R * (0.12 + 0.26 * expoOut(ct));
      this.core.position.set(this.x, this.y + 0.02, this.z);
      this.core.scale.set(cs, cs * 0.85, cs);
      this.core.rotation.y = this._spin;
      const gain = ct < 0.10 ? VFX.nova.strikeGain : 1.0;
      this.coreMat.opacity = Math.pow(1 - ct, 2.2) * 0.9 * gain * (0.5 + S * 0.5);
    } else {
      this.core.visible = false;
    }

    // ---- shock rings: 0.62 s and 0.86 s, expanding past the damage radius ---
    this._ring(this.ring, this.ringMat, t - this.tAnticipate, VFX.nova.ringLife,
      R * 1.05, 1.25 * S + 0.30, 0.06, 1);
    this._ring(this.ring2, this.ring2Mat, t - this.tAnticipate - 0.11, VFX.nova.ringLife * 1.4,
      R * 0.70, 0.80 * S + 0.20, 0.22, -1);

    // ---- spires: erupt on the strike, fall back over 0.85 s ----------------
    this._spire(this.spires, this.spireMat, t - this.tAnticipate, VFX.nova.spireLife,
      R * 0.62, 0.95 * S + 0.2, 1);
    this._spire(this.spires2, this.spireMat2, t - this.tAnticipate - 0.07, VFX.nova.spireLife * 0.8,
      R * 0.33, 0.7 * S + 0.15, -1);

    // ---- scar: the slowest layer, 1.5 s -----------------------------------
    const st = clamp01((t - this.tAnticipate) / VFX.nova.scarLife);
    if (t >= this.tAnticipate && st < 1) {
      this.scar.visible = true;
      this.scar.position.set(this.x, this.y + 0.018, this.z);
      // Grows fast then holds — a scorch mark does not keep expanding.
      const ss = R * (0.35 + 0.72 * expoOut(st * 4.5));
      this.scar.scale.set(ss, 1, ss);
      this.scar.rotation.y = this._spin * 0.5;
      // Deliberately faint. The scar's job is to darken and tint the floor the
      // blast happened on, not to be a purple disc — at 0.55 it was the largest
      // and flattest shape in the frame.
      this.scarMat.opacity = Math.pow(1 - st, 1.5) * 0.26 * (0.4 + S * 0.6);
    } else {
      this.scar.visible = false;
    }
  }

  _ring(mesh, mat, t, life, maxRadius, gain, delay, dir) {
    if (t < delay || t > life) { mesh.visible = false; return; }
    const a = clamp01((t - delay) / (life - delay));
    mesh.visible = true;
    mesh.position.set(this.x, this.y + 0.05 + a * 0.35, this.z);
    // Decelerating expansion. NOT `expoOut`: at -9x it reaches 70% of its final
    // radius in the first 19% of its life, so there is no frame on which the
    // ring is both readable and bright — the first capture showed a faint band
    // already at the edge of the screen and nothing at the centre. pow(a, 0.42)
    // still decelerates (a shock front does) but spends most of the life in the
    // 2-5 m range where it is legible.
    const r = maxRadius * (0.14 + 0.90 * Math.pow(a, 0.42));
    mesh.scale.set(r, 1, r);
    mesh.rotation.y = this._spin + dir * a * 0.9;
    // Thins as it expands. Squared falloff, so most of its life is spent faint —
    // a ring at constant brightness reads as a hoop being scaled.
    mat.opacity = Math.pow(1 - a, 1.7) * gain;
  }

  _spire(mesh, mat, t, life, radius, gain, dir) {
    if (t < 0 || t > life) { mesh.visible = false; return; }
    const a = clamp01(t / life);
    mesh.visible = true;
    mesh.position.set(this.x, this.y, this.z);
    // Erupt: 0 → full height over the first 18% of the life (a step, near
    // enough), then sink back over the rest on an ease out.
    const rise = a < 0.18 ? smooth(a / 0.18) : 1 - easeOut((a - 0.18) / 0.82) * 0.92;
    // Uniform: `buildSpireRing`'s dimensions are fractions of the ring radius.
    mesh.scale.set(radius, radius * Math.max(0.02, rise), radius);
    mesh.rotation.y = this._spin * dir + a * 0.35 * dir;
    mat.opacity = Math.pow(1 - a, 1.7) * gain * (a < 0.10 ? 1.8 : 1.0);
  }

  /** The nova's light: peaks one frame before the visual strike and decays over
   *  550 ms, much slower than the core. */
  lightIntensity() {
    if (this.t < 0) return 0;
    const t = this.t - this.tAnticipate + 0.016;
    if (t < -VFX.nova.anticipation || t > VFX.nova.lightLife) return 0;
    if (t < 0) {
      // The build during the wind-up: a low glow that grows, so the caster is
      // visibly charging something.
      return 3.0 * this.strength * easeIn(1 + t / VFX.nova.anticipation);
    }
    // Deliberately modest. `sky` feeds its volumetric march from the two
    // highest-scoring point lights around the CAMERA FOCUS — which is the
    // player, which is exactly where this light sits — so it wins the fog
    // solution outright. At a peak of 60 the first capture had the entire
    // frame, walls included, washed violet and every trace of the brazier key
    // light gone. 22-36 lights the blast without taking the room over.
    const a = t / VFX.nova.lightLife;
    return (22 + 14 * this.strength) * Math.pow(1 - a, 2.4);
  }

  get active() { return this.t >= 0; }

  setFrozen(v) { this._frozen = !!v; }

  clear() {
    this.t = -1;
    this.group.visible = false;
  }

  dispose() {
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this.group.removeFromParent();
  }
}
