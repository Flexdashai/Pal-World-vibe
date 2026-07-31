/**
 * MONARCH — targeting.
 *
 * The cursor is the aim. Everything a skill needs to know about direction comes
 * from one call: `aim(origin, range, out)`, which returns a unit XZ direction
 * and, if there is one, the actor the player almost certainly meant.
 *
 * ---------------------------------------------------------------------------
 * SOFT SNAP — the rule
 *
 * A snap may CORRECT an imprecise aim; it may never OVERRIDE a deliberate one.
 * Three mechanisms enforce that, and all three are needed:
 *
 *   1. A hard angular cap (SNAP.maxAngle, 7°). Whatever the maths says, the
 *      correction never exceeds it. At 6 m that is a 0.73 m pull — about the
 *      width of one enemy, so a hurried click connects and a deliberate one is
 *      untouched.
 *   2. A quadratic falloff on the off-axis angle, so a candidate at the edge of
 *      the cone gets almost nothing and one nearly under the cursor gets almost
 *      all of it. Linear falloff is what makes assist feel magnetic.
 *   3. A dead zone: if the cursor is sitting on bare ground more than
 *      SNAP.deadZone from the candidate's centre, no snap at all. Dropping a
 *      nova on an empty flagstone is a legitimate and common intent, and a snap
 *      that steals it is worse than no snap.
 *
 * Plus stickiness: a target hit inside the last second is preferred, so a combo
 * does not walk off its victim halfway through the chain.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CURSOR IS
 *
 * `physics.pickGroundPlane` rather than `pickRay`: it still answers when the
 * cursor is over fog, a gap or the sky, which `pickRay` cannot, and the
 * isometric camera means the ground plane IS the play space. `core/input.js`
 * also samples a ground point each frame from the player subsystem; we prefer
 * physics' answer because it can be asked at an arbitrary height (a spear aimed
 * at chest height leaves from 1.2 m, not from the floor).
 */

import * as THREE from 'three';
import { SNAP, clamp, clamp01 } from './tuning.js';

export class Targeting {
  constructor(ctx) {
    this.ctx = ctx;

    /** Preallocated. Nothing in this file allocates after construction. */
    this.dir = new THREE.Vector3(0, 0, 1);
    this.point = new THREE.Vector3();
    this.target = null;

    this._raw = new THREE.Vector3(0, 0, 1);
    this._v = new THREE.Vector3();
    this._ground = new THREE.Vector3();
    this._toActor = new THREE.Vector3();

    /** Stickiness ledger: the last actor damaged and when. */
    this._sticky = null;
    this._stickyAt = -1e9;

    /** Filter object reused for every actor query — a fresh literal here would
     *  allocate once per skill cast, which is per-frame under held fire. */
    this._filter = { notFaction: 'player', includePlayer: false, includeDead: false };
  }

  /** Remember who was hit, so the next swing in a chain prefers them. */
  noteHit(actor, now) {
    if (!actor || actor.isPlayer) return;
    this._sticky = actor;
    this._stickyAt = now;
  }

  /**
   * Where is the cursor on the ground?
   *
   * @param y     the height of the plane to intersect. A ground-targeted skill
   *              uses 0; a chest-height projectile uses ~1.1 so the aim does not
   *              tilt down as the cursor moves away.
   * @returns the shared `_ground` vector, or null if the ray is parallel/behind.
   */
  cursorGround(y = 0) {
    const ctx = this.ctx;
    const P = ctx.peek('physics');
    if (P?.pickGroundPlane) {
      const p = P.pickGroundPlane(ctx.input.ndc.x, ctx.input.ndc.y, ctx.camera, y, this._ground);
      if (p) return p;
    }
    // Fallback: the player subsystem samples this every frame from the same
    // camera, so it is at worst one frame stale.
    if (ctx.input.groundValid) {
      this._ground.copy(ctx.input.ground);
      this._ground.y = y;
      return this._ground;
    }
    return null;
  }

  /**
   * Resolve an aim direction from `origin`.
   *
   * @param origin   world position the skill leaves from
   * @param range    how far the skill reaches; candidates beyond it are ignored
   * @param opts     { snap: boolean, height: number, facing: Vector3 }
   * @returns `this` — read `.dir` (unit, XZ), `.point`, `.target`.
   */
  aim(origin, range, opts = {}) {
    const snapEnabled = opts.snap !== false;
    const height = opts.height ?? 0;

    // ---- 1. raw direction from the cursor ---------------------------------
    const g = this.cursorGround(height);
    if (g) {
      this._raw.set(g.x - origin.x, 0, g.z - origin.z);
      this.point.copy(g);
    } else if (opts.facing) {
      this._raw.copy(opts.facing);
      this._raw.y = 0;
      this.point.copy(origin).addScaledVector(this._raw, Math.max(1, range));
    } else {
      this._raw.set(0, 0, 1);
      this.point.copy(origin).add(this._raw);
    }
    if (this._raw.lengthSq() < 1e-6) {
      // Cursor exactly on the player. Fall back to the facing they already have
      // rather than snapping the character to +Z, which reads as a twitch.
      if (opts.facing) this._raw.copy(opts.facing).setY(0);
      else this._raw.set(0, 0, 1);
    }
    this._raw.normalize();
    this.dir.copy(this._raw);
    this.target = null;

    if (!snapEnabled) return this;

    // ---- 2. candidates -----------------------------------------------------
    const P = this.ctx.peek('physics');
    if (!P?.queryCone) return this;
    const reach = Math.min(SNAP.maxRange, Math.max(2.5, range));
    const res = P.queryCone(origin, this._raw, reach, SNAP.cone, this._filter, undefined, false);
    if (!res || res.count === 0) return this;

    const now = this.ctx.time.elapsed;
    const sticky = (now - this._stickyAt) < SNAP.stickyTime ? this._sticky : null;

    let best = null, bestScore = -1, bestAngle = 0;
    const cursorX = this.point.x, cursorZ = this.point.z;

    for (let i = 0; i < res.count; i++) {
      const a = res.actors[i];
      if (!a || a === opts.exclude || a.alive === false) continue;

      this._toActor.set(a.position.x - origin.x, 0, a.position.z - origin.z);
      const d = this._toActor.length();
      if (d < 1e-4) continue;
      this._toActor.multiplyScalar(1 / d);

      // Angle between the cursor direction and this candidate.
      const dot = clamp(this._toActor.dot(this._raw), -1, 1);
      const angle = Math.acos(dot);
      if (angle > SNAP.cone) continue;

      // Dead zone: how far is the CURSOR from the candidate, on the ground?
      // If the player is pointing at open floor, leave them alone.
      const gx = cursorX - a.position.x, gz = cursorZ - a.position.z;
      const cursorMiss = Math.hypot(gx, gz) - (a.radius ?? 0.4);
      if (cursorMiss > SNAP.deadZone + d * 0.06) continue;

      // Score: mostly "how nearly is the cursor on it", then a preference for
      // near over far, then stickiness. Squared angle term so the falloff is
      // quadratic, which is what stops it feeling magnetic.
      const axial = 1 - (angle / SNAP.cone);
      let score = axial * axial * (1 - clamp01(d / reach) * 0.45);
      if (a === sticky) score *= SNAP.stickiness;
      // Something already marked by the Monarch is what the player is working
      // on; prefer it. This makes the mark feel like a soft lock-on without
      // ever being one.
      if (a.guaranteedExtract) score *= 1.12;

      if (score > bestScore) { bestScore = score; best = a; bestAngle = angle; }
    }

    if (!best) return this;
    this.target = best;

    // ---- 3. the correction -------------------------------------------------
    const axial = 1 - clamp01(bestAngle / SNAP.cone);
    const pull = axial * axial * SNAP.strength;
    const correction = Math.min(bestAngle, SNAP.maxAngle * pull);
    if (correction <= 1e-4) return this;

    this._toActor.set(best.position.x - origin.x, 0, best.position.z - origin.z).normalize();
    // Rotate `dir` toward the target by exactly `correction` radians, in the XZ
    // plane. Cross product's Y sign gives the direction of rotation.
    const cross = this._raw.x * this._toActor.z - this._raw.z * this._toActor.x;
    const sign = cross >= 0 ? 1 : -1;
    const c = Math.cos(correction * sign), s = Math.sin(correction * sign);
    // Rotating (x,z) by -theta about +Y: x' = x·c + z·s, z' = -x·s + z·c. The
    // sign convention here is checked against `queryCone` in `selfTest`.
    this.dir.set(this._raw.x * c + this._raw.z * s, 0, -this._raw.x * s + this._raw.z * c).normalize();
    return this;
  }

  /**
   * The nearest hostile to a point — used for the dash-strike's destination and
   * for the command skill's focus order. Not a snap: this is an explicit
   * "who should this go at" question with no cursor involved.
   */
  nearestHostile(position, radius, exclude = null) {
    const P = this.ctx.peek('physics');
    if (!P?.nearestActor) return null;
    const f = this._filter;
    const prev = f.exclude;
    f.exclude = exclude;
    const a = P.nearestActor(position, radius, f);
    f.exclude = prev;
    return a;
  }

  /** How many hostiles are inside `radius`. `ai` may not exist; this must still
   *  answer 0 rather than throw. */
  countHostiles(position, radius) {
    const P = this.ctx.peek('physics');
    if (!P?.queryRadius) return 0;
    const res = P.queryRadius(position, radius, this._filter, undefined, false);
    return res?.count ?? 0;
  }

  stats() {
    return {
      target: this.target?.id ?? null,
      sticky: this._sticky?.id ?? null,
      dir: [+this.dir.x.toFixed(3), +this.dir.z.toFixed(3)],
      point: [+this.point.x.toFixed(2), +this.point.z.toFixed(2)],
    };
  }
}
