/**
 * character.js — swept capsule character controller.
 *
 * ONE controller serves the player and all 60+ AI actors: the same doorway that
 * traps the hero traps the horde, so there is no reason for two implementations
 * and every reason for one that is right.
 *
 * The move is a Quake-lineage slide solver hardened for a physics-driven dungeon:
 *
 *   1. DEPENETRATE.  Gauss-Seidel over the *set* of contact planes, not just the
 *      deepest one. A doorway corner is two planes at 90 degrees; correcting only
 *      the deepest pushes you into the other, and the classic failure is an actor
 *      vibrating in a doorway forever. Solving them together converges in 2-3
 *      iterations onto the corner's crease.
 *   2. SUBSTEP.  Split the frame's displacement so no substep exceeds half the
 *      capsule radius. Conservative advancement already cannot tunnel, but bounded
 *      substeps keep the plane set meaningful when a dash crosses three walls.
 *   3. SLIDE.  Up to 5 sweep/clip passes per substep. On the second plane, move
 *      along the crease (cross of the two normals) instead of clipping twice,
 *      which is what actually lets you walk *through* a doorway rather than
 *      grinding to a halt on its jamb.
 *   4. STEP.  If a blocking plane is near-vertical and we are grounded, retry the
 *      whole substep lifted by `stepHeight`, then drop back down. Threshold stones,
 *      altar steps and rubble stop being walls.
 *   5. GROUND.  Sweep down to find the floor, with a snap distance that keeps the
 *      actor glued to descending stairs instead of launching off every lip.
 *
 * `position` is at the FEET (y = ground), matching ARCHITECTURE.md's "the player
 * stands at world origin height 0". The capsule segment therefore runs from
 * y+radius to y+height-radius.
 */

import * as THREE from 'three';
import { clamp, makeHit, EPS, clipVelocity } from './math.js';
import { makeContacts } from './bvh.js';
import { MASK, surfaceName, surfaceProps, SURFACE } from './surfaces.js';

/** Keep this much air between the capsule and any surface. Below ~2 mm the sweep
 *  and the overlap test disagree about whether we are touching, and the actor
 *  jitters; above ~1 cm you can see the float. */
const SKIN = 0.004;
const MAX_SLIDE_PASSES = 5;
const MAX_DEPEN_ITERS = 4;
/** Cap a single depenetration so a bad spawn inside a wall eases out over a few
 *  frames rather than teleporting across the level. */
const MAX_DEPEN_DIST = 0.6;
const OVERBOUNCE = 1.001;

const _clip = { x: 0, y: 0, z: 0 };

export class CharacterController {
  /**
   * @param {StaticWorld} world
   * @param {object} opts
   *   actor        the owning actor (its `position` Vector3 IS our position)
   *   radius       capsule radius, metres
   *   height       total capsule height, metres
   *   stepHeight   max ledge we walk up without jumping
   *   slopeLimit   radians; steeper than this is a wall
   *   snapDistance how far below the feet we still consider "on the ground"
   *   mask         collision mask (defaults MASK.CHARACTER)
   *   gravity      m/s^2, negative
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.actor = opts.actor ?? null;
    this.radius = opts.radius ?? 0.36;
    this.height = Math.max(opts.height ?? 1.82, this.radius * 2 + 0.01);
    this.stepHeight = opts.stepHeight ?? 0.42;
    this.slopeLimit = opts.slopeLimit ?? 0.86; // ~49 degrees
    this.slopeCos = Math.cos(this.slopeLimit);
    this.snapDistance = opts.snapDistance ?? 0.32;
    this.mask = opts.mask ?? MASK.CHARACTER;
    this.gravity = opts.gravity ?? -18.6;
    this.mass = opts.mass ?? 78;
    this.enabled = true;

    /** Live reference into the actor when one was supplied — never copy-assigned,
     *  per the actor interface in ARCHITECTURE.md. */
    this.position = opts.actor?.position ?? new THREE.Vector3();
    this.velocity = opts.actor?.velocity ?? new THREE.Vector3();

    // ---- output state, read by player/ai every frame ----
    this.grounded = false;
    this.wasGrounded = false;
    /** Frames since we last touched the floor — coyote time lives off this. */
    this.airFrames = 0;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundY = 0;
    this.groundSurface = 'stone';
    this.groundSurfaceId = SURFACE.stone;
    this.groundSlope = 0;
    /** Set when the last move was stopped by a wall; ai uses it to re-path. */
    this.blocked = false;
    this.blockedNormal = new THREE.Vector3();
    /** Metres actually travelled last move vs metres requested — < 1 means we
     *  are grinding on something, which is the cheapest "I am stuck" signal. */
    this.moveEfficiency = 1;
    this.steppedUp = 0;
    /** Vertical speed at the moment of landing, for landing FX / audio. */
    this.landImpact = 0;

    // ---- preallocated scratch ----
    this._hit = makeHit();
    this._hit2 = makeHit();
    this._contacts = makeContacts(64);
    this._corr = new THREE.Vector3();
    this._planeN = new Float32Array(MAX_SLIDE_PASSES * 3);
    this._planeCount = 0;
    this._vel = new THREE.Vector3();
    this._start = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._savePos = new THREE.Vector3();
    this._saveVel = new THREE.Vector3();
  }

  /** Segment endpoints of the capsule for a given feet position. */
  get p0y() { return this.position.y + this.radius; }
  get p1y() { return this.position.y + this.height - this.radius; }

  setSize(radius, height) {
    this.radius = radius;
    this.height = Math.max(height, radius * 2 + 0.01);
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.airFrames = 0;
    this.depenetrate();
    this.probeGround(this.snapDistance * 2, true);
  }

  /* ---------------------------------------------------------------- */
  /* Depenetration                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Push the capsule out of anything it is inside.
   *
   * The Gauss-Seidel loop is the important part. For each contact we compute how
   * much penetration REMAINS after the corrections accumulated so far
   * (`pen = depth - dot(corr, n)`) and only add the shortfall. Two walls meeting
   * at a corner therefore produce a single diagonal correction instead of two
   * full-depth pushes that overshoot and bounce the actor back and forth.
   *
   * Returns the distance moved.
   */
  depenetrate(maxIters = MAX_DEPEN_ITERS) {
    const w = this.world;
    if (!w || w.triCount === 0) return 0;
    let moved = 0;
    const corr = this._corr;

    for (let iter = 0; iter < maxIters; iter++) {
      const c = w.overlapCapsule(
        this.position.x, this.p0y, this.position.z,
        this.position.x, this.p1y, this.position.z,
        this.radius + SKIN, this.mask, this._contacts
      );
      if (c.count === 0) break;

      corr.set(0, 0, 0);
      // Two sweeps: forward then backward. A single ordered pass biases the
      // solution towards the last contact; sweeping both ways symmetrises it and
      // roughly halves the iterations needed on a 3-plane corner.
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < c.count; k++) {
          const i = pass === 0 ? k : c.count - 1 - k;
          const nx = c.nx[i], ny = c.ny[i], nz = c.nz[i];
          const remaining = c.depth[i] - (corr.x * nx + corr.y * ny + corr.z * nz);
          if (remaining <= 0) continue;
          corr.x += nx * remaining;
          corr.y += ny * remaining;
          corr.z += nz * remaining;
        }
      }

      const len = corr.length();
      if (len < 1e-5) break;
      if (len > MAX_DEPEN_DIST) corr.multiplyScalar(MAX_DEPEN_DIST / len);
      this.position.add(corr);
      moved += Math.min(len, MAX_DEPEN_DIST);

      // Kill the velocity component that pushed us in, or we simply re-penetrate
      // next step and the actor buzzes against the wall.
      const cl = corr.length();
      if (cl > EPS) {
        const nx = corr.x / cl, ny = corr.y / cl, nz = corr.z / cl;
        const vn = this.velocity.x * nx + this.velocity.y * ny + this.velocity.z * nz;
        if (vn < 0) {
          this.velocity.x -= nx * vn;
          this.velocity.y -= ny * vn;
          this.velocity.z -= nz * vn;
        }
      }
    }
    return moved;
  }

  /* ---------------------------------------------------------------- */
  /* Sweeping                                                          */
  /* ---------------------------------------------------------------- */

  /** Swept capsule from the current position along (dx,dy,dz)*dist. */
  _sweep(dx, dy, dz, dist, out) {
    return this.world.sweepCapsule(
      this.position.x, this.p0y, this.position.z,
      this.position.x, this.p1y, this.position.z,
      this.radius, dx, dy, dz, dist, this.mask, out
    );
  }

  /** Sweep from an explicit feet position (used by the step-up trial move). */
  _sweepFrom(px, py, pz, dx, dy, dz, dist, out) {
    return this.world.sweepCapsule(
      px, py + this.radius, pz,
      px, py + this.height - this.radius, pz,
      this.radius, dx, dy, dz, dist, this.mask, out
    );
  }

  /**
   * Clip `v` against every plane collected this substep.
   *
   * Single plane: standard slide. Two planes: if the naive clip still drives into
   * the *other* plane, project onto their crease — this is exactly the doorway
   * case, and it is the difference between sliding through a door and sticking to
   * its frame. Three planes with no consistent direction: stop dead, which is
   * physically correct (you are in a wedge).
   */
  _clipToPlanes(v) {
    const pn = this._planeN;
    const n = this._planeCount;
    for (let i = 0; i < n; i++) {
      const nx = pn[i * 3], ny = pn[i * 3 + 1], nz = pn[i * 3 + 2];
      if (v.x * nx + v.y * ny + v.z * nz >= 0) continue; // already moving away
      clipVelocity(v.x, v.y, v.z, nx, ny, nz, OVERBOUNCE, _clip);
      v.set(_clip.x, _clip.y, _clip.z);

      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const mx = pn[j * 3], my = pn[j * 3 + 1], mz = pn[j * 3 + 2];
        if (v.x * mx + v.y * my + v.z * mz >= 0) continue;
        // Slide along the crease of planes i and j.
        let cx = ny * mz - nz * my;
        let cy = nz * mx - nx * mz;
        let cz = nx * my - ny * mx;
        const cl = Math.hypot(cx, cy, cz);
        if (cl < 1e-5) { v.set(0, 0, 0); return v; } // parallel opposing planes
        cx /= cl; cy /= cl; cz /= cl;
        const d = v.x * cx + v.y * cy + v.z * cz;
        v.set(cx * d, cy * d, cz * d);

        // A third plane that the crease also violates means a corner pocket.
        for (let k = 0; k < n; k++) {
          if (k === i || k === j) continue;
          const ox = pn[k * 3], oy = pn[k * 3 + 1], oz = pn[k * 3 + 2];
          if (v.x * ox + v.y * oy + v.z * oz < 0) { v.set(0, 0, 0); return v; }
        }
        break;
      }
    }
    return v;
  }

  _addPlane(nx, ny, nz) {
    const pn = this._planeN;
    for (let i = 0; i < this._planeCount; i++) {
      // Merge near-duplicates (a wall tessellated into two triangles gives two
      // identical normals and would otherwise eat two of our five plane slots).
      if (pn[i * 3] * nx + pn[i * 3 + 1] * ny + pn[i * 3 + 2] * nz > 0.999) return;
    }
    if (this._planeCount >= MAX_SLIDE_PASSES) return;
    const i = this._planeCount++;
    pn[i * 3] = nx; pn[i * 3 + 1] = ny; pn[i * 3 + 2] = nz;
  }

  /* ---------------------------------------------------------------- */
  /* The move                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Advance the character by `velocity * dt` with collision.
   *
   * @param dt      fixed step, seconds
   * @param opts    { gravity: bool, snap: bool, stepUp: bool }
   * @returns this
   *
   * The caller owns `velocity`: player/ai write their desired velocity, we
   * consume it and write back whatever survived the collision so their next
   * acceleration integrates from reality rather than from intent.
   */
  move(dt, opts = {}) {
    if (!this.enabled || dt <= 0) return this;
    const w = this.world;
    this.blocked = false;
    this.steppedUp = 0;
    this.wasGrounded = this.grounded;
    this.landImpact = 0;

    const useGravity = opts.gravity !== false;
    const allowStep = opts.stepUp !== false;
    const allowSnap = opts.snap !== false;

    if (useGravity) this.velocity.y += this.gravity * dt;
    // Remember the descent speed BEFORE collision eats it — this is the number
    // `player` and `fx` want for a landing thud, and by the time the move ends
    // the floor plane has already clipped it to zero.
    this._saveVel.copy(this.velocity);
    // Grounded actors keep a small downward bias so they hug the floor across
    // seams between two flagstone meshes without the snap having to catch them.
    if (this.grounded && this.velocity.y < 0 && this.velocity.y > -1) this.velocity.y = -1;

    if (!w || w.triCount === 0) {
      // No level yet (boot, or a world that never registered colliders): behave
      // as a flat plane at y=0 so nothing falls out of the universe.
      this.position.addScaledVector(this.velocity, dt);
      if (this.position.y <= 0) {
        this.position.y = 0;
        if (this.velocity.y < 0) { this.landImpact = -this.velocity.y; this.velocity.y = 0; }
        this.grounded = true;
        this.airFrames = 0;
        this.groundNormal.set(0, 1, 0);
        this.groundY = 0;
      } else {
        this.grounded = false;
        this.airFrames++;
      }
      this.moveEfficiency = 1;
      return this;
    }

    this.depenetrate();

    this._vel.copy(this.velocity);
    const requested = this._vel.length() * dt;
    if (requested < 1e-6) {
      if (allowSnap) this.probeGround(this.snapDistance, true);
      this.moveEfficiency = 1;
      return this;
    }

    this._start.copy(this.position);

    // Substep so no single sweep moves further than half a radius. CA cannot
    // tunnel, but a 0.9 m dash step resolved as one sweep collapses three
    // separate walls into one plane set and the slide picks a wrong crease.
    const maxStep = Math.max(this.radius * 0.5, 0.05);
    const total = requested;
    const substeps = Math.min(8, Math.max(1, Math.ceil(total / maxStep)));
    const sdt = dt / substeps;

    for (let s = 0; s < substeps; s++) {
      this._planeCount = 0;
      let remaining = this._vel.length() * sdt;
      if (remaining < 1e-7) break;

      for (let pass = 0; pass < MAX_SLIDE_PASSES && remaining > 1e-7; pass++) {
        const speed = this._vel.length();
        if (speed < 1e-7) break;
        const dx = this._vel.x / speed, dy = this._vel.y / speed, dz = this._vel.z / speed;

        if (!this._sweep(dx, dy, dz, remaining + SKIN, this._hit)) {
          this.position.x += dx * remaining;
          this.position.y += dy * remaining;
          this.position.z += dz * remaining;
          remaining = 0;
          break;
        }

        const advance = Math.max(0, this._hit.t - SKIN);
        this.position.x += dx * advance;
        this.position.y += dy * advance;
        this.position.z += dz * advance;
        remaining -= advance;

        const nx = this._hit.nx, ny = this._hit.ny, nz = this._hit.nz;
        const walkable = ny >= this.slopeCos;

        // Try to step over a low blocker before treating it as a wall.
        if (!walkable && allowStep && (this.grounded || this.wasGrounded) && remaining > 1e-4) {
          if (this._tryStep(dx, dy, dz, remaining)) {
            // The trial move consumed the rest of this substep.
            remaining = 0;
            break;
          }
        }

        if (!walkable) {
          this.blocked = true;
          this.blockedNormal.set(nx, ny, nz);
        }

        this._addPlane(nx, ny, nz);
        this._clipToPlanes(this._vel);

        if (this._vel.lengthSq() < 1e-10) { remaining = 0; break; }
      }
    }

    // Landing / ground state.
    if (allowSnap) this.probeGround(this.snapDistance, true);
    else this.probeGround(0.02, false);

    if (this.grounded && !this.wasGrounded) {
      this.landImpact = Math.max(0, -this._saveVel.y);
    }
    if (this.grounded) {
      this.airFrames = 0;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this.airFrames++;
    }

    const travelled = this.position.distanceTo(this._start);
    this.moveEfficiency = total > 1e-6 ? clamp(travelled / total, 0, 1) : 1;

    // Write the surviving velocity back so the caller's next acceleration starts
    // from what actually happened, not from what it wished for.
    this.velocity.x = this._vel.x;
    this.velocity.z = this._vel.z;
    if (!this.grounded) this.velocity.y = this._vel.y;
    return this;
  }

  /**
   * Step-up trial: lift by stepHeight, advance, drop back down.
   * Accepts only if the landing is walkable and we genuinely ended up further
   * along than the blocked position — otherwise a wall would let us "step" onto
   * nothing and hover.
   */
  _tryStep(dx, dy, dz, remaining) {
    this._savePos.copy(this.position);

    // 1. lift
    let lift = this.stepHeight;
    if (this._sweep(0, 1, 0, lift + SKIN, this._hit2)) {
      lift = Math.max(0, this._hit2.t - SKIN);
      if (lift < 0.02) return false; // ceiling right above us
    }
    const py = this.position.y + lift;

    // 2. forward, horizontally only — stepping should not carry vertical motion
    const hl = Math.hypot(dx, dz);
    if (hl < 1e-5) return false;
    const fx = dx / hl, fz = dz / hl;
    let forward = remaining;
    if (this._sweepFrom(this.position.x, py, this.position.z, fx, 0, fz, forward + SKIN, this._hit2)) {
      forward = Math.max(0, this._hit2.t - SKIN);
      if (forward < 0.01) return false; // still blocked up here: a real wall
    }
    const nx2 = this.position.x + fx * forward;
    const nz2 = this.position.z + fz * forward;

    // 3. drop
    let drop = lift + 0.02;
    let landedY = py;
    let landedNormal = 1;
    let landedSurface = this.groundSurfaceId;
    if (this._sweepFrom(nx2, py, nz2, 0, -1, 0, drop + SKIN, this._hit2)) {
      const d = Math.max(0, this._hit2.t - SKIN);
      landedY = py - d;
      landedNormal = this._hit2.ny;
      landedSurface = this._hit2.surfaceId;
    } else {
      return false; // nothing to stand on — this was a ledge, not a step
    }
    if (landedNormal < this.slopeCos) return false;
    if (landedY < this._savePos.y - 0.02) return false;    // fell below where we started
    if (landedY > this._savePos.y + this.stepHeight + 0.01) return false;

    this.position.set(nx2, landedY, nz2);
    // A step must not be a free ride out of a wall: verify the destination.
    const c = this.world.overlapCapsule(
      this.position.x, this.p0y, this.position.z,
      this.position.x, this.p1y, this.position.z,
      this.radius, this.mask, this._contacts
    );
    if (c.count > 0) {
      let deepest = 0;
      for (let i = 0; i < c.count; i++) if (c.depth[i] > deepest) deepest = c.depth[i];
      if (deepest > SKIN * 3) { this.position.copy(this._savePos); return false; }
    }

    this.steppedUp = landedY - this._savePos.y;
    this.grounded = true;
    this.groundNormal.set(0, landedNormal, 0);
    this.groundY = landedY;
    this.groundSurfaceId = landedSurface;
    this.groundSurface = surfaceName(landedSurface);
    if (this.velocity.y < 0) this.velocity.y = 0;
    if (this._vel.y < 0) this._vel.y = 0;
    return true;
  }

  /**
   * Find the floor beneath the capsule.
   *
   * `snap` pulls the feet onto it when it is within `dist`, which is what keeps a
   * running actor glued to a descending stair instead of ballistically arcing off
   * every tread. We only snap while moving downward or already grounded — snapping
   * during a jump would cancel it.
   */
  probeGround(dist, snap) {
    const w = this.world;
    if (!w || w.triCount === 0) {
      this.grounded = this.position.y <= 1e-3;
      this.groundY = 0;
      this.groundNormal.set(0, 1, 0);
      return this.grounded;
    }
    const probe = Math.max(dist, 0.02) + SKIN;
    if (!this._sweep(0, -1, 0, probe, this._hit)) {
      this.grounded = false;
      this.groundSlope = 0;
      return false;
    }
    const walkable = this._hit.ny >= this.slopeCos;
    const d = Math.max(0, this._hit.t - SKIN);

    if (!walkable) {
      // Standing on something too steep to stand on: we are sliding, not grounded.
      this.grounded = false;
      this.groundNormal.set(this._hit.nx, this._hit.ny, this._hit.nz);
      this.groundSlope = Math.acos(clamp(this._hit.ny, -1, 1));
      return false;
    }

    this.groundNormal.set(this._hit.nx, this._hit.ny, this._hit.nz);
    this.groundY = this._hit.py;
    this.groundSurfaceId = this._hit.surfaceId;
    this.groundSurface = surfaceName(this._hit.surfaceId);
    this.groundSlope = Math.acos(clamp(this._hit.ny, -1, 1));

    const rising = this.velocity.y > 0.05;
    if (d <= SKIN * 2) {
      this.grounded = true;
    } else if (snap && !rising && d <= dist) {
      this.position.y -= d;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    return this.grounded;
  }

  /**
   * Kinematic displacement with collision but no gravity or ground logic —
   * knockback, a dash's teleport tail, a boss's shove. Returns the distance the
   * character actually covered, so combat can decide whether a slam "connected"
   * with a wall (and should therefore deal wall-impact damage).
   */
  pushBy(dx, dy, dz) {
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return 0;
    const ux = dx / dist, uy = dy / dist, uz = dz / dist;
    this._planeCount = 0;
    let remaining = dist;
    let travelled = 0;
    const v = this._probe.set(ux, uy, uz);
    for (let pass = 0; pass < MAX_SLIDE_PASSES && remaining > 1e-6; pass++) {
      const sp = v.length();
      if (sp < 1e-6) break;
      const nx = v.x / sp, ny = v.y / sp, nz = v.z / sp;
      if (!this._sweep(nx, ny, nz, remaining + SKIN, this._hit)) {
        this.position.x += nx * remaining;
        this.position.y += ny * remaining;
        this.position.z += nz * remaining;
        travelled += remaining;
        remaining = 0;
        break;
      }
      const advance = Math.max(0, this._hit.t - SKIN);
      this.position.x += nx * advance;
      this.position.y += ny * advance;
      this.position.z += nz * advance;
      travelled += advance;
      remaining -= advance;
      this._addPlane(this._hit.nx, this._hit.ny, this._hit.nz);
      this._clipToPlanes(v);
      this.blocked = true;
      this.blockedNormal.set(this._hit.nx, this._hit.ny, this._hit.nz);
    }
    this.depenetrate(2);
    return travelled;
  }

  /** Friction coefficient of whatever we are standing on — blood is slippery,
   *  ash is not, and `player` reads this to modulate acceleration. */
  get groundFriction() {
    return surfaceProps(this.groundSurfaceId).friction;
  }

  /** Is there room to stand at (x, y, z)? Used by ai spawn placement. */
  fits(x, y, z) {
    const c = this.world.overlapCapsule(
      x, y + this.radius, z, x, y + this.height - this.radius, z,
      this.radius, this.mask, this._contacts
    );
    return c.count === 0;
  }

  dispose() {
    this.actor = null;
    this.world = null;
  }
}
