import * as THREE from 'three';
import { FX, lightEnvelope } from './tuning.js';

/**
 * MONARCH — the effect light pool.
 *
 * ARCHITECTURE.md: *"A fireball that does not illuminate the wall beside it is a
 * sprite, not a spell."* Every significant effect this subsystem produces takes
 * one of these lights for the length of its envelope.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT MAKES THIS SAFE
 *
 * The number of VISIBLE point lights is a shader program cache key. A system
 * that created a light per explosion would recompile every lit material in the
 * scene on every explosion — measured on the sibling project at 640-900 ms.
 *
 * So the pool is:
 *   - allocated ONCE, in `init()`, which is before `render.prewarmMaterials`
 *     freezes the slot count, so these lights are counted in that freeze;
 *   - never added to or removed from the scene afterwards;
 *   - driven only through `intensity`, including to exactly zero.
 *
 * `render`'s LightBudget hides a zero-intensity light and tops the visible count
 * back up with a ballast light of intensity 0, so the count the shader sees is
 * constant and an idle fx light costs nothing but a `+= 0.0` in the irradiance
 * accumulator.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ENVELOPE LEADS THE VISUAL
 *
 * A light that snaps on and off with its sprite reads as the sprite being
 * emissive, not as the world being lit. `lightEnvelope` gives a fast attack and
 * a slow release, and callers start it `FX.lights.lead` seconds — one frame —
 * before the visual peak. The eye reads the pre-flash as anticipation and the
 * long tail as heat, and neither is available from a linear fade.
 */
export class FxLights {
  constructor(scene, render, count = FX.lights.count) {
    this.count = count;
    this.lights = [];
    this.group = new THREE.Group();
    this.group.name = 'mn.fx.lights';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    // Per-slot envelope state.
    this.age = new Float32Array(count);
    this.attack = new Float32Array(count);
    this.sustain = new Float32Array(count);
    this.release = new Float32Array(count);
    this.peak = new Float32Array(count);
    this.busy = new Uint8Array(count);
    /** Monotonic ticket so a caller can tell whether the slot it was given has
     *  since been recycled out from under it. */
    this.ticket = new Int32Array(count);
    this._nextTicket = 1;

    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2);
      l.name = `mn.fx.light.${i}`;
      l.castShadow = false;
      // No shadow map, deliberately: an effect light lasts 200 ms and a shadow
      // map render for it would cost more than every particle it illuminates.
      l.visible = true;
      l.position.set(0, -500, 0);
      this.group.add(l);
      render.addLight(l);
      this.lights.push(l);
    }
  }

  /**
   * Take a light. Returns a handle `{ slot, ticket }`-style integer pair packed
   * as a single number is tempting but unreadable; instead the slot index is
   * returned and `valid(slot, ticket)` checks ownership.
   *
   * When every slot is busy the one with the LEAST remaining energy is stolen,
   * so what gets cut is always the light already contributing least — the same
   * policy render's own budget uses, for the same reason.
   */
  acquire(o) {
    let slot = -1;
    let worst = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (!this.busy[i]) { slot = i; break; }
      const remaining = this.peak[i] * (1 - this.age[i] / Math.max(1e-3, this.attack[i] + this.sustain[i] + this.release[i]));
      if (remaining < worst) { worst = remaining; slot = i; }
    }
    if (slot < 0) return -1;

    const l = this.lights[slot];
    l.position.set(o.x ?? 0, o.y ?? 1, o.z ?? 0);
    const c = o.color ?? WHITE;
    l.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
    l.distance = o.distance ?? 9;
    l.decay = o.decay ?? 2;

    // The envelope starts ALREADY ADVANCED by `lead`. That is what "the light
    // peaks one frame before the visual" means when both are spawned on the same
    // frame — and getting the sign wrong here (starting at -lead) makes the light
    // contribute exactly zero on the frame the effect appears, which on a
    // 16-frame capture settle is very likely to be the shutter frame.
    this.age[slot] = o.lead ?? FX.lights.lead;
    this.attack[slot] = Math.max(1e-3, o.attack ?? 0.035);
    this.sustain[slot] = o.sustain ?? 0;
    this.release[slot] = Math.max(1e-3, o.release ?? 0.22);
    this.peak[slot] = (o.intensity ?? 20) * FX.lights.gain;
    this.busy[slot] = 1;
    this.ticket[slot] = this._nextTicket++;
    // Write the first sample now rather than waiting for update(): an effect
    // triggered by the shot harness on the shutter frame must already be lit.
    l.intensity = this.peak[slot] * this._envelope(slot, this.age[slot]);
    return slot;
  }

  valid(slot, ticket) {
    return slot >= 0 && slot < this.count && this.busy[slot] === 1 && this.ticket[slot] === ticket;
  }

  ticketOf(slot) { return slot >= 0 ? this.ticket[slot] : 0; }

  /** Move a light that an effect is driving (a projectile, a rising vortex). */
  move(slot, ticket, x, y, z) {
    if (!this.valid(slot, ticket)) return false;
    this.lights[slot].position.set(x, y, z);
    return true;
  }

  /** Retune a live light — used by the extraction, whose colour shifts from
   *  deep indigo to white-violet across the strike. */
  retune(slot, ticket, color, intensity, distance) {
    if (!this.valid(slot, ticket)) return false;
    const l = this.lights[slot];
    if (color) l.color.setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace);
    if (intensity !== undefined) this.peak[slot] = intensity * FX.lights.gain;
    if (distance !== undefined) l.distance = distance;
    return true;
  }

  release_(slot, ticket) {
    if (!this.valid(slot, ticket)) return false;
    // Jump straight to the release phase rather than cutting: a light that stops
    // instantly is exactly the artefact this class exists to avoid.
    this.age[slot] = Math.max(this.age[slot], this.attack[slot] + this.sustain[slot]);
    return true;
  }

  /** Attack / sustain / release, evaluated at `age`. */
  _envelope(i, age) {
    if (age < 0) return 0;
    if (age < this.attack[i]) return lightEnvelope(age, this.attack[i], this.release[i]);
    if (age < this.attack[i] + this.sustain[i]) return 1;
    // Shift the sustain out of the argument so the release curve starts from
    // its peak whatever the sustain length was.
    return lightEnvelope(age - this.sustain[i], this.attack[i], this.release[i]);
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      // `?fxlights=0` — see the isolation switches in index.js.
      if (this.disabled) { this.lights[i].intensity = 0; this.busy[i] = 0; continue; }
      if (!this.busy[i]) continue;
      const age = this.age[i] + dt;
      this.age[i] = age;
      const total = this.attack[i] + this.sustain[i] + this.release[i];
      if (age >= total) {
        this.busy[i] = 0;
        this.lights[i].intensity = 0;
        // Park it far below the level so a stale position can never contribute
        // to `sky`'s fog light election, which scores by distance to the focus.
        this.lights[i].position.set(0, -500, 0);
        continue;
      }
      this.lights[i].intensity = this.peak[i] * this._envelope(i, age);
    }
  }

  clear() {
    for (let i = 0; i < this.count; i++) {
      this.busy[i] = 0;
      this.lights[i].intensity = 0;
      this.lights[i].position.set(0, -500, 0);
    }
  }

  stats() {
    let busy = 0, lit = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.busy[i]) busy++;
      if (this.lights[i].intensity > 0.01) lit++;
    }
    return { pool: this.count, busy, lit };
  }

  dispose(render) {
    for (const l of this.lights) {
      render?.removeLight?.(l);
      this.group.remove(l);
      l.dispose?.();
    }
    this.lights.length = 0;
    this.group.parent?.remove(this.group);
  }
}

const WHITE = [1, 1, 1];
