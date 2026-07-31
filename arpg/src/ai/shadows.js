import * as THREE from 'three';
import { SHADOW, ARCHETYPES, clamp, clamp01, lerp } from './tuning.js';

/**
 * MONARCH — THE SHADOW ARMY.
 *
 * The payoff of the whole game. A corpse dissolves into violet, re-forms as a
 * near-black soldier with glowing eyes, and from then on it fights for you. By
 * the end of a run the screen should be full of them and the player should be
 * doing less than a third of the killing.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP (ARCHITECTURE.md)
 *
 *   player  decides WHETHER a corpse can be extracted, emits `shadow:extract`
 *   fx      plays the vortex on that event
 *   ai      spawns the soldier and emits `shadow:arise`     ← this file
 *   ui      shows the SYSTEM window on both
 *
 * So this file never rolls an extraction chance and never draws the vortex. It
 * receives an event and produces a soldier.
 *
 * ---------------------------------------------------------------------------
 * THE SILHOUETTE IS INHERITED, THE VALUE IS NOT
 *
 * "Same silhouette as the dead enemy" is the requirement, and it is what makes
 * the beat land: the thing you just killed is now yours, and you can see that
 * it is. So the shade pool is split ACROSS THE ARCHETYPES — a shade slot built
 * on the ghoul rig wears ghoul geometry, a shade built on the knight rig wears
 * the knight's. That costs nothing extra in vertex data, because the geometry is
 * already built and shared; a shade slot is one skeleton and three materials.
 *
 * What changes is entirely material: near-black (never black — a flat black
 * shape in a dark room reads as missing geometry), a violet fresnel rim, violet
 * eyes at a higher gain than any enemy's, and `fx`'s shadow trail.
 *
 * ---------------------------------------------------------------------------
 * FORMATION
 *
 * Idle soldiers fall into an arc BEHIND the player — behind, because an army
 * standing in front of the hero blocks the shot, and this game's whole visual
 * identity is the hero standing in front of an army. Rows fan outward as the
 * army grows, so twelve soldiers read as a formation rather than as a queue.
 */
export class ShadowArmy {
  constructor(ai) {
    this.ai = ai;
    /** Live soldiers, densely packed. */
    this.soldiers = [];
    this.totalRaised = 0;
    this.totalLost = 0;
    this.capacity = 12;

    /** Reused payloads — `shadow:arise` fires several times in one frame during
     *  an ARISE, and ARCHITECTURE.md forbids a fresh literal on anything that
     *  frequent. */
    this._arise = { soldier: null, position: new THREE.Vector3(), rank: 'common' };
    this._v = new THREE.Vector3();
    this._escort = new THREE.Vector3();
    this._order = { kind: '', target: null, until: 0, x: 0, z: 0 };
  }

  /* ==================================================================== */
  /* extraction                                                           */
  /* ==================================================================== */

  /**
   * `shadow:extract` arrived. Raise a soldier.
   *
   * @param e { actor, position, rank, duration, power }
   * @returns the soldier, or null when the army is full or no slot is free
   */
  raise(e) {
    const ai = this.ai;
    const rank = e?.rank ?? 'common';
    const source = e?.actor ?? null;
    const kind = source?.kind ?? source?.archetype ?? 'ghoul';

    // Prefer a slot built on the DEAD THING'S rig, so the silhouette carries
    // over. Fall back to any free shade rather than refusing — a run where the
    // eighth extraction silently does nothing is far worse than one where the
    // eighth soldier is the wrong shape.
    let actor = ai.acquireShade(kind);
    if (!actor) actor = ai.acquireShade(null);
    if (!actor) return null;

    const px = e?.position?.x ?? source?.position?.x ?? 0;
    const pz = e?.position?.z ?? source?.position?.z ?? 0;
    const py = e?.position?.y ?? source?.position?.y ?? 0;
    // Face the way the hero is facing, not the way the corpse fell: a soldier
    // that rises facing away from the fight reads as debris.
    const p = ai.player;
    const yaw = p ? Math.atan2(px - p.position.x, pz - p.position.z) : (source?.yaw ?? 0);

    const power = (e?.power ?? 1) * (SHADOW.rankPower[rank] ?? 1);
    actor.spawn({
      x: px, y: py, z: pz, yaw,
      level: ai.levelFor(),
      power,
      form: 0,
      rise: true,
    });
    actor.sourceKind = kind;
    actor.rank = rank === 'boss' ? 'elite' : 'common';
    actor.name = rank === 'boss' ? 'Shadow Warden' : `Shadow ${source?.name ?? 'Soldier'}`;
    actor.formationSlot = this.soldiers.length;
    actor.expiresAt = ai.ctx.time.elapsed + SHADOW.lifetime;
    actor._ariseAt = ai.ctx.time.elapsed + SHADOW.materialise * SHADOW.ariseAt;
    actor._arisen = false;

    this.soldiers.push(actor);
    this.totalRaised++;

    // The trail. `fx` owns the energy; we own the body.
    ai.fx?.attachShadowTrail?.(actor, { width: 0.22 * actor.scale, life: 0.42 });
    return actor;
  }

  /** A soldier died, expired or was recycled. */
  remove(actor) {
    const i = this.soldiers.indexOf(actor);
    if (i >= 0) {
      this.soldiers.splice(i, 1);
      this.totalLost++;
      this.ai.fx?.detachShadowTrail?.(actor);
      // Re-index the formation so the arc closes up rather than leaving a hole.
      for (let k = 0; k < this.soldiers.length; k++) this.soldiers[k].formationSlot = k;
    }
    return i >= 0;
  }

  /* ==================================================================== */
  /* orders                                                               */
  /* ==================================================================== */

  /**
   * Sovereign's Command, from `combat`.
   * @param o { order, target, position, duration, damage, haste, source }
   */
  command(o = {}) {
    const now = this.ai.ctx.time.elapsed;
    const until = now + (o.duration ?? SHADOW.orderDuration);
    this._order.kind = o.order ?? 'attack';
    this._order.target = o.target ?? null;
    this._order.until = until;
    this._order.x = o.position?.x ?? 0;
    this._order.z = o.position?.z ?? 0;

    for (const s of this.soldiers) {
      if (!s.alive) continue;
      s.orderTarget = o.target ?? null;
      s.orderUntil = until;
      s.retargetAt = 0;
      s.buffDamage = 1 + (o.damage ?? 0);
      s.buffHaste = 1 + (o.haste ?? 0);
      s.buffUntil = until;
      // A visible response to the order: the eyes flare and the rim brightens
      // for as long as the buff lasts. An army that does not visibly react to
      // being commanded makes the button feel like it did nothing.
      this.ai.materials.setRimStrength(s.materials, 2.6);
    }
    return this.soldiers.length;
  }

  /** Monarch's Domain, from `combat`. A pure buff with no retarget. */
  buff(o = {}) {
    const now = this.ai.ctx.time.elapsed;
    const until = now + (o.duration ?? 6);
    const r2 = (o.radius ?? 999) * (o.radius ?? 999);
    let n = 0;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      if (o.position) {
        const dx = s.position.x - o.position.x, dz = s.position.z - o.position.z;
        if (dx * dx + dz * dz > r2) continue;
      }
      s.buffDamage = 1 + (o.damage ?? 0);
      s.buffHaste = 1 + (o.haste ?? 0);
      s.buffUntil = until;
      this.ai.materials.setRimStrength(s.materials, 3.2);
      n++;
    }
    return n;
  }

  /* ==================================================================== */
  /* the frame                                                            */
  /* ==================================================================== */

  update(dt, now) {
    const ai = this.ai;
    const p = ai.player;
    this.capacity = p?.army?.capacity ?? 12;

    // Formation geometry, recomputed once per frame rather than per soldier.
    let backX = 0, backZ = 1, px = 0, pz = 0;
    if (p) {
      px = p.position.x; pz = p.position.z;
      // "Behind" is behind the PLAYER'S facing when they are moving, and
      // up-screen when they are not — a stationary hero should have the army
      // arranged where the camera can see it.
      const vx = p.velocity?.x ?? 0, vz = p.velocity?.z ?? 0;
      const l = Math.hypot(vx, vz);
      if (l > 0.6) { backX = -vx / l; backZ = -vz / l; }
      else { backX = Math.SQRT1_2; backZ = Math.SQRT1_2; }
    }
    const rightX = -backZ, rightZ = backX;

    for (let i = this.soldiers.length - 1; i >= 0; i--) {
      const s = this.soldiers[i];
      if (!s.alive || !s.root.visible) {
        if (s.state === undefined || !s.alive) { this.remove(s); continue; }
      }

      // ---- the ARISE event ----------------------------------------------------
      // Fired partway through the materialisation, not at the end, so `fx`'s
      // burst overlaps the body resolving rather than following it.
      if (!s._arisen && now >= s._ariseAt) {
        s._arisen = true;
        const a = this._arise;
        a.soldier = s;
        a.position.copy(s.position);
        a.rank = s.rank;
        ai.ctx.events.emit('shadow:arise', a);
        ai.cue('shadow.arise', s.position, 0.85, s.height * 0.6);
      }

      // ---- the tether ---------------------------------------------------------
      // Beyond it a soldier disengages and comes back. An army that scatters
      // across the level stops reading as an army, which is the entire visual
      // point of having one.
      const d = Math.hypot(s.position.x - px, s.position.z - pz);
      if (d > SHADOW.tether && s.target && !s.orderTarget) {
        s.target = null;
        s.threat.clear();
      }

      // ---- formation ----------------------------------------------------------
      // Rows of increasing width, fanned. A single arc looks like a queue past
      // about six; three rows reads as a formation at any size.
      const slot = s.formationSlot;
      const row = Math.min(SHADOW.formationRows - 1, Math.floor(slot / 4));
      const col = slot - row * 4;
      const spread = (col - 1.5) * SHADOW.formationSpread * (1 + row * 0.35);
      const depth = SHADOW.formationRadius + row * 1.35;
      this._escort.set(
        px + backX * depth + rightX * spread, 0,
        pz + backZ * depth + rightZ * spread
      );
      // Scalars, not the shared vector: `_escort` is reused for every soldier
      // in this loop and the actor reads its escort point in its own fixed step,
      // long after the loop has moved on.
      s.escort = !s.target;
      s.escortX = this._escort.x;
      s.escortZ = this._escort.z;

      // ---- fade out -----------------------------------------------------------
      // A soldier at the end of its life dissolves the way it arrived. A shadow
      // that simply vanishes reads as a bug.
      const left = s.expiresAt - now;
      if (left < SHADOW.fadeOut) {
        const form = clamp01(left / SHADOW.fadeOut);
        ai.materials.setForm(s.materials, form);
        s.form = form;
      }
    }

    // The roster count `ui` shows. Driven from here rather than from `player`'s
    // ledger so it can never disagree with what is actually standing.
    ai.ui?.setShadows?.(this.soldiers.length, this.capacity);
    void dt;
  }

  /** Every live soldier, for the shot harness and `stats()`. */
  get count() { return this.soldiers.length; }

  clear() {
    for (const s of this.soldiers.slice()) {
      this.ai.fx?.detachShadowTrail?.(s);
      this.ai.recycle(s);
    }
    this.soldiers.length = 0;
  }

  stats() {
    const byKind = {};
    for (const s of this.soldiers) {
      const k = s.sourceKind ?? 'shade';
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    return {
      count: this.soldiers.length,
      capacity: this.capacity,
      raised: this.totalRaised,
      lost: this.totalLost,
      byKind,
    };
  }
}

export { clamp, lerp, ARCHETYPES };
