import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';
import { FX } from './tuning.js';

/**
 * MONARCH — the hit flash on a struck actor.
 *
 * Three frames of emissive ramp on the material of whatever was hit. It is the
 * cheapest and most legible damage feedback in the genre: at 21 m and 120 px of
 * character height the player cannot read a hit reaction pose, but they can
 * always read "that one went white for a moment".
 *
 * ---------------------------------------------------------------------------
 * THE SHARED-MATERIAL PROBLEM, AND HOW IT IS HANDLED WITHOUT CLONING
 *
 * `ai` will render a horde from a small number of shared materials — that is
 * what makes twenty skeletons affordable. Writing `emissive` on a shared
 * material therefore flashes the WHOLE HORDE, which is worse than no flash at
 * all because it destroys the read it exists to provide.
 *
 * The obvious fix is to clone the material per actor. That is rejected: a clone
 * is a new material, a new uniform set and — the first time it is drawn — a
 * program cache lookup that can miss, which on this renderer is a multi-hundred
 * millisecond stall in the middle of a fight. Exactly what pre-warm exists to
 * prevent.
 *
 * Instead, ownership is TRACKED. The first time an actor is flashed its meshes
 * are walked and every material is claimed for that actor's root. A material
 * claimed by two different roots is marked shared and is never written to; the
 * hit is then communicated by the impact burst and the light, which is a
 * complete effect on its own. Actors with their own materials — bosses, the
 * player, shadow soldiers, anything unique — get the flash.
 *
 * `ai` can opt any actor in explicitly by giving it materials nothing else uses.
 * There is no API to learn: the tracking does it automatically.
 */
export class HitFlash {
  /** @param {import('./index.js').FxSystem} fx */
  constructor(fx) {
    this.fx = fx;
    /** actor -> { mats[], baseE[], baseI[], shared[] } */
    this.registry = new WeakMap();
    /** material -> the single root Object3D allowed to flash it, or null when
     *  it turned out to be shared. A Map so it does not retain materials past a
     *  level transition any longer than the scene does. */
    this.owner = new Map();
    /** Active flashes: a small dense array, walked every frame. */
    this.active = [];
    this._color = new THREE.Color();
    this._flashed = 0;
    this._skipped = 0;
  }

  _entry(actor) {
    let e = this.registry.get(actor);
    if (e) return e;
    const root = actor?.root;
    if (!root) return null;

    e = { mats: [], baseE: [], baseI: [], shared: [], root };
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const m = o.material;
      // Arrays and materials with no emissive channel (our own additive
      // shaders, for instance) are not flashable and are skipped silently.
      if (!m || Array.isArray(m) || !m.emissive || !m.isMaterial) return;
      if (e.mats.indexOf(m) >= 0) return;

      const prev = this.owner.get(m);
      if (prev === undefined) this.owner.set(m, root);
      else if (prev !== root) this.owner.set(m, null);   // now known shared

      e.mats.push(m);
      e.baseE.push(m.emissive.clone());
      e.baseI.push(m.emissiveIntensity ?? 1);
      e.shared.push(false);
    });
    this.registry.set(actor, e);
    return e;
  }

  /**
   * Flash an actor.
   * @param {object} actor  must expose `root`
   * @param {object} o      amount (0..1+), element, crit
   */
  flash(actor, o = {}) {
    const e = this._entry(actor);
    if (!e || e.mats.length === 0) { this._skipped++; return false; }

    // Re-resolve sharing every time: a material that was unique when the first
    // enemy of a pack spawned may be shared by the time the third one does.
    let anyFlashable = false;
    for (let i = 0; i < e.mats.length; i++) {
      const shared = this.owner.get(e.mats[i]) !== e.root;
      e.shared[i] = shared;
      if (!shared) anyFlashable = true;
    }
    if (!anyFlashable) { this._skipped++; return false; }

    // Already flashing? Refresh rather than stack, or a flurry saturates.
    for (const f of this.active) {
      if (f.actor === actor) {
        f.age = 0;
        f.peak = Math.max(f.peak, this._peakFor(o));
        return true;
      }
    }

    // Capture the CURRENT emissive as the base, not the value recorded at
    // registration: another subsystem (a status effect, a charge-up) may
    // legitimately have changed it since, and restoring the stale value would
    // silently cancel their work.
    for (let i = 0; i < e.mats.length; i++) {
      if (e.shared[i]) continue;
      e.baseE[i].copy(e.mats[i].emissive);
      e.baseI[i] = e.mats[i].emissiveIntensity ?? 1;
    }

    const el = ELEMENTS[o.element] ?? ELEMENTS.physical;
    this.active.push({
      actor, entry: e, age: 0,
      life: FX.flash.life * (o.crit ? 1.5 : 1),
      peak: this._peakFor(o),
      r: el.glow[0], g: el.glow[1], b: el.glow[2],
    });
    this._flashed++;
    return true;
  }

  _peakFor(o) {
    const base = o.crit ? FX.flash.critPeak : FX.flash.peak;
    return base * Math.min(2.0, 0.6 + 0.7 * (o.amount ?? 1));
  }

  update(dt) {
    for (let k = this.active.length - 1; k >= 0; k--) {
      const f = this.active[k];
      f.age += dt;
      const t = f.age / f.life;
      const e = f.entry;

      if (t >= 1 || f.actor.alive === false) {
        for (let i = 0; i < e.mats.length; i++) {
          if (e.shared[i]) continue;
          e.mats[i].emissive.copy(e.baseE[i]);
          e.mats[i].emissiveIntensity = e.baseI[i];
        }
        this.active.splice(k, 1);
        continue;
      }

      // A STEP up and an exponential collapse, not a triangle: the first frame
      // must be at full brightness or a 3-frame flash never reaches its peak on
      // any frame the player actually sees.
      const v = Math.pow(1 - t, 2.2);
      const amt = f.peak * v;
      for (let i = 0; i < e.mats.length; i++) {
        if (e.shared[i]) continue;
        const m = e.mats[i];
        // Lerp the emissive COLOUR toward the element's glow as well as raising
        // the intensity. Raising intensity alone just makes whatever the
        // material already emitted brighter, which for a dark enemy is nothing.
        m.emissive.setRGB(
          e.baseE[i].r + (f.r - e.baseE[i].r) * Math.min(1, v * 1.5),
          e.baseE[i].g + (f.g - e.baseE[i].g) * Math.min(1, v * 1.5),
          e.baseE[i].b + (f.b - e.baseE[i].b) * Math.min(1, v * 1.5),
          THREE.LinearSRGBColorSpace
        );
        m.emissiveIntensity = e.baseI[i] + amt;
      }
    }
  }

  /** Restore everything immediately — shot setup, level transition. */
  clear() {
    for (const f of this.active) {
      const e = f.entry;
      for (let i = 0; i < e.mats.length; i++) {
        if (e.shared[i]) continue;
        e.mats[i].emissive.copy(e.baseE[i]);
        e.mats[i].emissiveIntensity = e.baseI[i];
      }
    }
    this.active.length = 0;
  }

  stats() {
    return { active: this.active.length, flashed: this._flashed, skippedShared: this._skipped };
  }

  dispose() {
    this.clear();
    this.owner.clear();
  }
}
