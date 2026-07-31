/**
 * MONARCH — visual state for status effects.
 *
 * A status the player cannot see on the actor does not exist. `ai` owns enemy
 * materials and can tint them from `actor.statusTint` / `actor.statusPulse`
 * (written by `status.js`), but combat must not DEPEND on that: the effect has
 * to be legible whether or not the actor's owner participates, and it has to be
 * legible at 21 m where an emissive tint on a 120 px figure is nearly nothing.
 *
 * So there are two marks, both drawn here:
 *
 *   a ground ring   under the feet, in the dominant status's element colour,
 *                   pulsing at a rate that depends on the status (a burn
 *                   flickers, a freeze is dead still, the Monarch's mark
 *                   breathes slowly). The ring is the readable-at-distance
 *                   channel — an isometric ARPG reads the floor.
 *   a floating rune above the head, ONLY for the Monarch's mark. That one
 *                   status changes how the player should play (mark → kill →
 *                   raise), so it gets a symbol of its own. Giving every status
 *                   a floating icon is how a screen becomes a spreadsheet.
 *
 * Pooled: a fixed number of slots, assigned to the nearest afflicted actors each
 * frame. Beyond the pool the ground ring is simply not drawn, which is the right
 * thing to drop — the actors furthest from the player.
 */

import * as THREE from 'three';
import { GLOW, STATUS, clamp01 } from './tuning.js';
import { makeSpellMaterial, tagEffect, buildShockRing, elementRgb } from './fxkit.js';
import { ELEMENTS } from '../core/palette.js';

/** Concurrent decorated actors. Twelve is more than are ever legible at once in
 *  one screen of an isometric ARPG. */
const SLOTS = 12;

/** Pulse rate per status, in Hz. A burn flickers fast, a freeze does not move at
 *  all, the mark breathes. This is the cheapest possible way to make two
 *  statuses of similar colour distinguishable in peripheral vision. */
const PULSE_HZ = {
  burn: 7.5, bleed: 2.2, chill: 1.1, freeze: 0, shock: 11.0, mark: 1.35,
};

export class StatusVisuals {
  constructor(ctx, rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.name = 'mn.combat.status';
    ctx.scene.add(this.group);

    this._geo = [];
    this._mat = [];
    const render = ctx.peek('render');

    // A thin annulus: the status ring must NOT be a filled disc or it competes
    // with the hero's own aura ring and with the ground cursor.
    this.ringGeo = buildShockRing(0.74, 1.0, 30, 3);
    this._geo.push(this.ringGeo);
    this.runeGeo = buildMarkRune();
    this._geo.push(this.runeGeo);

    this.slots = [];
    for (let i = 0; i < SLOTS; i++) {
      const ringMat = makeSpellMaterial(`statusRing${i}`, ELEMENTS.shadow.core, { opacity: 0 });
      const runeMat = makeSpellMaterial(`statusRune${i}`, ELEMENTS.shadow.glow, { opacity: 0 });
      this._mat.push(ringMat, runeMat);
      render?.registerMaterial?.(ringMat);
      render?.registerMaterial?.(runeMat);

      const ring = new THREE.Mesh(this.ringGeo, ringMat);
      ring.name = `mn.combat.statusRing${i}`;
      tagEffect(ring, GLOW.ring, 7);
      const rune = new THREE.Mesh(this.runeGeo, runeMat);
      rune.name = `mn.combat.statusRune${i}`;
      tagEffect(rune, GLOW.rune, 12);

      this.group.add(ring, rune);
      this.slots.push({ ring, rune, ringMat, runeMat, actor: null, phase: 0 });
    }

    this._look = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._frozen = false;
    this._t = 0;
  }

  /**
   * Refresh from the live status records. Called once per frame with the status
   * system's dense `live` array, already ordered by insertion; we take the
   * nearest `SLOTS` to the camera focus.
   */
  sync(dt, statusSystem, camera, focus) {
    if (!this._frozen) this._t += dt;
    const live = statusSystem.live;

    // ---- pick the nearest N -------------------------------------------------
    // An insertion pass into the slot array rather than a sort: `live` is
    // typically under 20 entries and a sort would allocate a comparator closure.
    for (const s of this.slots) s.actor = null;
    for (let i = 0; i < live.length; i++) {
      const rec = live[i];
      const a = rec.actor;
      if (!a || a.alive === false || rec.dominant < 0) continue;
      const dx = a.position.x - focus.x, dz = a.position.z - focus.z;
      const d2 = dx * dx + dz * dz;
      // Find the worst occupied slot; replace it if we are closer.
      let worst = -1, worstD = d2;
      for (let k = 0; k < this.slots.length; k++) {
        const s = this.slots[k];
        if (!s.actor) { worst = k; worstD = Infinity; break; }
        const sx = s.actor.position.x - focus.x, sz = s.actor.position.z - focus.z;
        const sd = sx * sx + sz * sz;
        if (sd > worstD) { worstD = sd; worst = k; }
      }
      if (worst >= 0) {
        this.slots[worst].actor = a;
        this.slots[worst].rec = rec;
      }
    }

    // ---- draw ---------------------------------------------------------------
    for (const s of this.slots) {
      const a = s.actor;
      const rec = a ? s.rec : null;
      if (!a || !rec || rec.dominant < 0) {
        s.ring.visible = false;
        s.rune.visible = false;
        continue;
      }
      const name = statusSystem.nameOf(rec);
      const colour = statusSystem.colourOf(rec);
      const hz = PULSE_HZ[name] ?? 2;
      // Per-actor phase offset from the actor's own identity, so a pack of
      // burning skeletons does not flicker in unison.
      const phase = (a.id ? hashPhase(a.id) : 0) * Math.PI * 2;
      const pulse = hz > 0 ? 0.55 + 0.45 * Math.sin(this._t * hz * Math.PI * 2 + phase) : 1;
      const strength = clamp01(rec.intensity) * 0.55 + 0.25;

      // ---- ring -----------------------------------------------------------
      s.ring.visible = true;
      s.ringMat.color.setRGB(colour[0], colour[1], colour[2], THREE.LinearSRGBColorSpace);
      s.ringMat.opacity = strength * pulse * 0.62;
      const r = (a.radius ?? 0.45) * 1.9;
      s.ring.position.set(a.position.x, a.position.y + 0.02, a.position.z);
      s.ring.scale.set(r, 1, r);
      // Frozen targets do not spin. Everything else drifts slowly.
      s.ring.rotation.y = name === 'freeze' ? 0 : this._t * (name === 'mark' ? 0.55 : -0.3);

      // ---- rune (mark only) -------------------------------------------------
      const marked = rec.stacks('mark') > 0;
      s.rune.visible = marked;
      if (marked) {
        const g = elementRgb('shadow', 'glow', 1.25);
        s.runeMat.color.setRGB(g[0], g[1], g[2], THREE.LinearSRGBColorSpace);
        const mp = 0.55 + 0.45 * Math.sin(this._t * PULSE_HZ.mark * Math.PI * 2 + phase);
        s.runeMat.opacity = (0.45 + 0.35 * mp) * clamp01(rec.stacks('mark') / STATUS.mark.maxStacks + 0.4);
        const h = (a.height ?? 1.8) + 0.55 + Math.sin(this._t * 1.7 + phase) * 0.07;
        s.rune.position.set(a.position.x, a.position.y + h, a.position.z);
        this._look.copy(camera.position).sub(s.rune.position).normalize();
        this._quat.setFromUnitVectors(FORWARD, this._look);
        s.rune.quaternion.copy(this._quat);
        const sc = 0.20 + 0.03 * rec.stacks('mark');
        s.rune.scale.setScalar(sc);
      }
    }
  }

  setFrozen(v) { this._frozen = !!v; }

  clear() {
    for (const s of this.slots) {
      s.actor = null;
      s.rec = null;
      s.ring.visible = false;
      s.rune.visible = false;
    }
  }

  dispose() {
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this.group.removeFromParent();
  }
}

const FORWARD = new THREE.Vector3(0, 0, 1);

/** Deterministic 0..1 from an actor id, for a per-actor animation phase. No
 *  RNG: the same actor must get the same phase on every capture. */
function hashPhase(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 8) & 0xffff) / 65536;
}

/**
 * The Monarch's mark: an angular six-point sigil in the XY plane, built from
 * three overlapping elongated diamonds. Deliberately NOT a circle or a skull —
 * it has to read as a rune at 12 px, which means high-contrast straight edges.
 */
function buildMarkRune() {
  const pos = [];
  const col = [];
  const idx = [];
  const spike = (a, len, wid, bright) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    const base = pos.length / 3;
    pos.push(0, 0, 0);
    col.push(bright * 1.8, bright * 1.8, bright * 1.8);
    pos.push(-sa * wid, ca * wid, 0);
    col.push(bright, bright, bright);
    pos.push(ca * len, sa * len, 0);
    col.push(bright * 0.15, bright * 0.15, bright * 0.15);
    pos.push(sa * wid, -ca * wid, 0);
    col.push(bright, bright, bright);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // A tall vertical pair and two shorter diagonals: a crown, abstracted.
  spike(Math.PI * 0.5, 1.0, 0.20, 1.0);
  spike(-Math.PI * 0.5, 0.60, 0.16, 0.8);
  spike(Math.PI * 0.5 + 1.05, 0.72, 0.13, 0.9);
  spike(Math.PI * 0.5 - 1.05, 0.72, 0.13, 0.9);
  spike(0, 0.34, 0.10, 0.6);
  spike(Math.PI, 0.34, 0.10, 0.6);

  const g = new THREE.BufferGeometry();
  g.name = 'mn.combat.markRune';
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
