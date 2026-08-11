/**
 * rigidbody.js — impulse-based rigid bodies with continuous collision detection.
 *
 * What this is for, concretely: the chunks of a shattered urn, the shards of a
 * crystal growth, a dropped sword skittering across flagstone, the brazier bowl
 * that gets knocked off its stand, and — via `constraints.js` — swinging chains.
 * It is a *debris* solver, not a stacking solver. Debris in an ARPG needs to be
 * fast, plentiful, believable for two seconds, and then asleep forever.
 *
 * Design decisions and why:
 *
 *  - COLLISION AS PROBE POINTS. Every shape reduces to a small set of local-space
 *    spheres: 1 for a sphere, 2 for a capsule, 8 corners (+centre) for a box.
 *    Resolving each probe against the static BVH gives a box that tumbles, catches
 *    a corner, and settles flat — visually indistinguishable from a real SAT
 *    solver at debris scale, and roughly 10x cheaper than one.
 *
 *  - CCD BY SWEPT PROBES. Before integrating we sphere-cast every probe along the
 *    step and clamp to the earliest impact. Sweeping one sphere for the whole
 *    body is tempting and wrong in both directions — see the comment at the CCD
 *    block. A shard flying at 25 m/s covers 0.4 m per step; without this it goes
 *    through a 20 cm wall.
 *
 *  - SLEEPING IS MANDATORY. `q.particleBudget`-scale debris counts only work
 *    because a body that has been slow for 0.35 s stops costing anything. Any
 *    nearby explosion wakes it again.
 *
 *  - INTERPOLATED RENDERING. Bodies keep previous and current transforms; the
 *    mesh is written in `update()` using `ctx.time.alpha`, so debris is smooth
 *    even though the simulation is a hard 60 Hz.
 */

import * as THREE from 'three';
import { makeHit, quatIntegrate, quatRotate, clamp, EPS } from './math.js';
import { makeContacts } from './bvh.js';
import { MASK, surfaceProps, surfaceName, SURFACE } from './surfaces.js';

const SLEEP_LINEAR = 0.14;      // m/s
const SLEEP_ANGULAR = 0.6;      // rad/s
const SLEEP_TIME = 0.35;        // s below both thresholds before sleeping
/**
 * Extra damping applied while a body is resting on something and already slow.
 *
 * Sequential impulses over nine probe points converge on the linear solution in
 * one pass, but each corner impulse induces a little spin that the next corner
 * has to undo, so a settled box keeps a few tenths of a rad/s of residual
 * tumble — above the sleep threshold, forever. Bleeding that off explicitly is
 * what lets a hundred shards actually go to sleep instead of costing a contact
 * solve every frame for the rest of the level. Gated on low speed so a shard
 * skittering across flagstone at 3 m/s is untouched.
 */
const REST_SPEED = 1.0;         // m/s, below which resting damping applies
const REST_SPIN = 6.0;          // rad/s
const REST_DAMP_LINEAR = 0.82;
const REST_DAMP_ANGULAR = 0.72;
/**
 * Contact spin friction, per contacting probe per step.
 *
 * A point contact has zero lever arm about its own normal, so Coulomb friction
 * at a point CANNOT slow a body spinning about that normal — the impulse solver
 * is behaving correctly and a settled shard spins forever anyway. Real contacts
 * are patches, not points, and a chunk of stone dropped on flagstone stops
 * spinning almost immediately. This is the standard spin/rolling-friction term
 * that stands in for the patch, and without it debris never reaches the sleep
 * threshold and never stops costing a contact solve.
 */
const SPIN_FRICTION = 0.06;
const SPIN_FRICTION_MAX = 0.35;
const MAX_ANGULAR = 26;         // rad/s — beyond this the integration visibly jitters
const CONTACT_SLOP = 0.004;     // allowed interpenetration before we correct
const BAUMGARTE = 0.28;         // positional correction fraction per step
/**
 * Overlap queries are inflated by this much before testing.
 *
 * Without it the solver has a silent, total failure mode: CCD parks the body at
 * EXACTLY the tangent point, the strict `d2 < r2` overlap test reports nothing
 * there, no impulse is applied, and gravity accumulates into the velocity every
 * step while CCD keeps re-pinning the position. The body looks perfectly at rest
 * and is secretly carrying 40 m/s — until it clips a corner and rockets away.
 * A contact skin makes "resting" and "touching" the same thing.
 */
const CONTACT_SKIN = 0.005;
/** Ceilings that make the solver unable to explode, whatever a caller does or
 *  however badly a body is buried. A shard past 40 m/s is a bug, not a shard. */
const MAX_SPEED = 40;
const MAX_CORRECTION = 0.06;    // metres of positional correction per contact per pass

const _v = { x: 0, y: 0, z: 0 };
const _v2 = { x: 0, y: 0, z: 0 };

/**
 * Local-space probe layouts, built once per shape kind and shared by every body.
 *
 * The LAST probe of each layout is the CENTRE probe, and it carries the body's
 * inscribed radius rather than the corner bevel. That one probe is what makes the
 * model safe: the union of eight small corner spheres leaves the middle of every
 * face uncovered, so a box lands "bounding-sphere first", never registers a
 * corner contact, and sinks through the floor a few millimetres per step until it
 * is gone. The centre probe bounds penetration to the inscribed radius, and the
 * corner probes then only ever supply the tumble.
 */
const PROBES = {
  sphere: new Float32Array([0, 0, 0]),
  capsule: new Float32Array([0, -1, 0, 0, 1, 0, 0, 0, 0]),  // scaled by halfHeight
  box: new Float32Array([                                    // scaled by half-extents
    -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1,
    -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1,
    0, 0, 0,
  ]),
};

export class RigidBody {
  constructor() {
    this.id = -1;
    this.active = false;
    this.shape = 'box';
    this.half = new THREE.Vector3(0.1, 0.1, 0.1);
    this.radius = 0.1;
    this.probeRadius = 0.02;
    /** Radius of the largest sphere that fits inside the shape. Drives CCD and
     *  the centre probe; bounds how far the body can sink into a surface. */
    this.inscribed = 0.1;
    this.boundRadius = 0.2;

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angular = new THREE.Vector3();

    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();

    this.mass = 1;
    this.invMass = 1;
    /** Diagonal inertia in LOCAL space; boxes and capsules are close enough to
     *  their principal axes that a full tensor buys nothing at debris scale. */
    this.invInertia = new THREE.Vector3(1, 1, 1);

    this.restitution = 0.25;
    this.friction = 0.7;
    /**
     * Damping defaults are DEBRIS defaults, not vacuum defaults.
     *
     * A stone chunk knocked off a wall in a damp crypt travels a metre and stops.
     * With near-zero damping a sphere that starts rolling never stops — rolling
     * contact generates no relative tangential velocity, so Coulomb friction has
     * nothing to bite on and the ball is still crossing the room a minute later,
     * awake, costing a contact solve every frame. These values stand in for the
     * rolling resistance and air drag we do not model.
     */
    this.linearDamping = 0.35;
    this.angularDamping = 0.6;
    this.gravityScale = 1;
    this.surfaceId = SURFACE.stone;
    this.mask = MASK.DEBRIS;
    this.ccd = true;

    this.sleeping = false;
    this.sleepTimer = 0;
    this.lifetime = Infinity;
    this.age = 0;
    /** Fade-out window at end of life; `fx`/`world` can read `fade` to dissolve. */
    this.fadeTime = 0.6;
    this.fade = 1;

    this.mesh = null;
    /** For an InstancedMesh-backed debris pool: which instance we drive. */
    this.instance = -1;
    this.userData = null;
    /** Emitted impact bookkeeping — one event per landing, not per contact. */
    this.impactCooldown = 0;
    this.lastImpactSpeed = 0;
    this.onImpact = null;
    this.probeCount = 1;
    this.probes = PROBES.sphere;
    /** Probes that reported a contact on the last step. Drives resting damping
     *  and is what `debug` colours a settled body by. */
    this.contactCount = 0;
  }

  get awake() { return this.active && !this.sleeping; }

  wake() {
    if (!this.active) return;
    this.sleeping = false;
    this.sleepTimer = 0;
  }

  /**
   * Apply an impulse (kg·m/s) at a world point and WAKE the body.
   * This is the gameplay-facing entry point: an explosion, a sword hit, a shove.
   */
  applyImpulse(ix, iy, iz, px, py, pz) {
    if (!this.active || this.invMass === 0) return;
    this.wake();
    this._impulse(ix, iy, iz, px, py, pz);
  }

  /**
   * The same maths WITHOUT waking. The contact solver must use this: a resting
   * body receives a small impulse every step just to cancel gravity, and if that
   * woke it the sleep timer would reset forever and nothing would ever sleep.
   */
  _impulse(ix, iy, iz, px, py, pz) {
    if (!this.active || this.invMass === 0) return;
    this.velocity.x += ix * this.invMass;
    this.velocity.y += iy * this.invMass;
    this.velocity.z += iz * this.invMass;
    if (px === undefined) return;
    const rx = px - this.position.x, ry = py - this.position.y, rz = pz - this.position.z;
    // torque = r x impulse, transformed into local space for the diagonal inertia
    const tx = ry * iz - rz * iy;
    const ty = rz * ix - rx * iz;
    const tz = rx * iy - ry * ix;
    const q = this.quaternion;
    quatRotate(-q.x, -q.y, -q.z, q.w, tx, ty, tz, _v);
    _v.x *= this.invInertia.x; _v.y *= this.invInertia.y; _v.z *= this.invInertia.z;
    quatRotate(q.x, q.y, q.z, q.w, _v.x, _v.y, _v.z, _v2);
    this.angular.x += _v2.x;
    this.angular.y += _v2.y;
    this.angular.z += _v2.z;
  }

  /** Velocity of the material point at world position p. */
  pointVelocity(px, py, pz, out) {
    const rx = px - this.position.x, ry = py - this.position.y, rz = pz - this.position.z;
    out.x = this.velocity.x + (this.angular.y * rz - this.angular.z * ry);
    out.y = this.velocity.y + (this.angular.z * rx - this.angular.x * rz);
    out.z = this.velocity.z + (this.angular.x * ry - this.angular.y * rx);
    return out;
  }
}

export class RigidBodyWorld {
  /**
   * @param {StaticWorld} world
   * @param {object} opts { capacity, gravity, events, rng }
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.gravity = opts.gravity ?? -18.6;
    this.capacity = opts.capacity ?? 256;
    this.events = opts.events ?? null;
    this.rng = opts.rng ?? null;

    /** @type {RigidBody[]} dense pool; `active` marks liveness. */
    this.bodies = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.bodies[i] = new RigidBody();
      this.bodies[i].id = i;
    }
    this._free = [];
    for (let i = this.capacity - 1; i >= 0; i--) this._free.push(i);
    this.activeCount = 0;
    this.awakeCount = 0;

    // scratch
    this._hit = makeHit();
    this._contacts = makeContacts(32);
    this._probe = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._impactPayload = {
      position: new THREE.Vector3(), normal: new THREE.Vector3(),
      surface: 'stone', element: 'physical', magnitude: 0,
    };
    this._cuePayload = { cue: 'debris', position: new THREE.Vector3(), gain: 1 };
    this.counters = { steps: 0, contacts: 0, ccdClamps: 0, impacts: 0 };
  }

  /* ---------------------------------------------------------------- */
  /* Spawning                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * @param opts
   *   shape       'box' | 'sphere' | 'capsule'
   *   size        Vector3-ish half extents (box), or { radius, halfHeight }
   *   position, quaternion, velocity, angular
   *   mass        kg; omit to derive from volume x surface density
   *   restitution, friction, linearDamping, angularDamping, gravityScale
   *   surface     surface name; drives friction/restitution/audio when not given
   *   mesh        THREE.Object3D driven by this body (optional)
   *   lifetime    seconds before automatic despawn
   *   ccd         default true
   *   onImpact    (body, hit, speed) => void
   */
  spawn(opts = {}) {
    if (this._free.length === 0) {
      // Budget exhausted: steal the oldest sleeping body, then the oldest awake
      // one. Debris must never refuse to spawn — a fight that stops producing
      // shards mid-combo reads as a bug.
      const victim = this._oldest(true) ?? this._oldest(false);
      if (victim === null) return null;
      this.despawn(this.bodies[victim]);
    }
    const idx = this._free.pop();
    const b = this.bodies[idx];

    b.active = true;
    b.sleeping = false;
    b.sleepTimer = 0;
    b.age = 0;
    b.fade = 1;
    b.impactCooldown = 0;
    b.lastImpactSpeed = 0;

    b.shape = opts.shape ?? 'box';
    const surf = opts.surface ?? 'stone';
    b.surfaceId = typeof surf === 'number' ? surf : (SURFACE[surf] ?? SURFACE.stone);
    const sp = surfaceProps(b.surfaceId);

    if (b.shape === 'sphere') {
      b.radius = opts.radius ?? 0.1;
      b.half.set(b.radius, b.radius, b.radius);
      b.probes = PROBES.sphere;
      b.probeCount = 1;
      b.probeRadius = b.radius;
      b.inscribed = b.radius;
      b.boundRadius = b.radius;
    } else if (b.shape === 'capsule') {
      b.radius = opts.radius ?? 0.08;
      const hh = opts.halfHeight ?? 0.16;
      b.half.set(b.radius, hh, b.radius);
      b.probes = PROBES.capsule;
      b.probeCount = 3;
      b.probeRadius = b.radius;
      b.inscribed = b.radius;
      b.boundRadius = hh + b.radius;
    } else {
      const s = opts.size;
      if (s) b.half.set(s.x ?? s[0] ?? 0.1, s.y ?? s[1] ?? 0.1, s.z ?? s[2] ?? 0.1);
      else b.half.set(0.1, 0.1, 0.1);
      b.probes = PROBES.box;
      b.probeCount = 9;
      b.inscribed = Math.min(b.half.x, b.half.y, b.half.z);
      // Bevel the corners so a box lands on a rounded corner and rocks instead of
      // catching on a mathematically sharp point and sticking. Half the inscribed
      // radius keeps the eight corner spheres overlapping the centre probe, so
      // the union has no gap a thin wall could slip through.
      b.probeRadius = b.inscribed * 0.5;
      b.radius = b.probeRadius;
      b.boundRadius = b.half.length();
    }

    let mass = opts.mass;
    if (mass === undefined) {
      const vol = b.shape === 'sphere'
        ? (4 / 3) * Math.PI * b.radius ** 3
        : b.shape === 'capsule'
          ? Math.PI * b.radius ** 2 * (b.half.y * 2) + (4 / 3) * Math.PI * b.radius ** 3
          : 8 * b.half.x * b.half.y * b.half.z;
      mass = Math.max(0.05, vol * sp.density);
    }
    b.mass = mass;
    b.invMass = mass > 0 ? 1 / mass : 0;

    // Diagonal inertia. Solid box / sphere / capsule-as-cylinder formulas.
    if (b.shape === 'sphere') {
      const I = 0.4 * mass * b.radius * b.radius;
      b.invInertia.set(1 / I, 1 / I, 1 / I);
    } else if (b.shape === 'capsule') {
      const Ix = mass * (3 * b.radius * b.radius + (b.half.y * 2) ** 2) / 12;
      const Iy = 0.5 * mass * b.radius * b.radius;
      b.invInertia.set(1 / Ix, 1 / Iy, 1 / Ix);
    } else {
      const x2 = (b.half.x * 2) ** 2, y2 = (b.half.y * 2) ** 2, z2 = (b.half.z * 2) ** 2;
      b.invInertia.set(
        12 / (mass * (y2 + z2)),
        12 / (mass * (x2 + z2)),
        12 / (mass * (x2 + y2))
      );
    }
    if (b.invMass === 0) b.invInertia.set(0, 0, 0);

    b.restitution = opts.restitution ?? sp.restitution;
    b.friction = opts.friction ?? sp.friction;
    b.linearDamping = opts.linearDamping ?? 0.35;
    b.angularDamping = opts.angularDamping ?? 0.6;
    b.gravityScale = opts.gravityScale ?? 1;
    b.mask = opts.mask ?? MASK.DEBRIS;
    b.ccd = opts.ccd !== false;
    b.lifetime = opts.lifetime ?? Infinity;
    b.fadeTime = opts.fadeTime ?? 0.6;
    b.mesh = opts.mesh ?? null;
    b.instance = opts.instance ?? -1;
    b.userData = opts.userData ?? null;
    b.onImpact = opts.onImpact ?? null;

    if (opts.position) b.position.copy(opts.position);
    else b.position.set(0, 0, 0);
    if (opts.quaternion) b.quaternion.copy(opts.quaternion);
    else b.quaternion.identity();
    if (opts.velocity) b.velocity.copy(opts.velocity);
    else b.velocity.set(0, 0, 0);
    if (opts.angular) b.angular.copy(opts.angular);
    else b.angular.set(0, 0, 0);

    b.prevPos.copy(b.position);
    b.prevQuat.copy(b.quaternion);

    this.activeCount++;
    return b;
  }

  _oldest(sleepingOnly) {
    let best = null, bestAge = -1;
    for (let i = 0; i < this.capacity; i++) {
      const b = this.bodies[i];
      if (!b.active) continue;
      if (sleepingOnly && !b.sleeping) continue;
      if (b.age > bestAge) { bestAge = b.age; best = i; }
    }
    return best;
  }

  despawn(body) {
    if (!body || !body.active) return false;
    body.active = false;
    body.mesh = null;
    body.onImpact = null;
    body.userData = null;
    this._free.push(body.id);
    this.activeCount--;
    return true;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) if (this.bodies[i].active) this.despawn(this.bodies[i]);
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  step(dt) {
    this.counters.steps++;
    let awake = 0;
    for (let i = 0; i < this.capacity; i++) {
      const b = this.bodies[i];
      if (!b.active) continue;

      b.age += dt;
      if (b.age >= b.lifetime) { this.despawn(b); continue; }
      const remaining = b.lifetime - b.age;
      b.fade = remaining < b.fadeTime ? clamp(remaining / b.fadeTime, 0, 1) : 1;
      if (b.impactCooldown > 0) b.impactCooldown -= dt;

      if (b.sleeping) continue;
      awake++;

      b.prevPos.copy(b.position);
      b.prevQuat.copy(b.quaternion);

      // ---- integrate ----
      b.velocity.y += this.gravity * b.gravityScale * dt;
      const ld = Math.max(0, 1 - b.linearDamping * dt);
      const ad = Math.max(0, 1 - b.angularDamping * dt);
      b.velocity.multiplyScalar(ld);
      b.angular.multiplyScalar(ad);

      const aLen = b.angular.length();
      if (aLen > MAX_ANGULAR) b.angular.multiplyScalar(MAX_ANGULAR / aLen);
      const vLen = b.velocity.length();
      if (vLen > MAX_SPEED) b.velocity.multiplyScalar(MAX_SPEED / vLen);

      let stepDt = dt;
      // ---- CCD: clamp the step to the first time any PROBE hits ----
      //
      // Sweeping one sphere for the whole body does not work, and both obvious
      // choices fail in opposite directions:
      //   - bounding radius: the body stops a corner's length short of the
      //     surface, no probe reaches it, and it creeps through the floor;
      //   - inscribed radius: an elongated box stops with its centre a bevel
      //     above the floor and its long axis already buried, which the discrete
      //     pass then resolves as a huge penetration and launches it at 80 m/s.
      // Sweeping the actual probe spheres is exact for the model we resolve with,
      // so neither gap exists. It only runs when the step is long enough for a
      // probe to skip its own radius — i.e. never for settled or slow debris,
      // which is almost all of it.
      if (b.ccd && this.world && this.world.triCount > 0) {
        const speed = b.velocity.length();
        const travel = speed * dt;
        if (travel > b.probeRadius) {
          const inv = 1 / speed;
          const ux = b.velocity.x * inv, uy = b.velocity.y * inv, uz = b.velocity.z * inv;
          let minT = travel;
          const lastProbe = b.probeCount - 1;
          for (let p = 0; p < b.probeCount; p++) {
            const isCentre = p === lastProbe && b.shape !== 'sphere';
            const pr = isCentre ? b.inscribed : b.probeRadius;
            let lx = b.probes[p * 3], ly = b.probes[p * 3 + 1], lz = b.probes[p * 3 + 2];
            if (b.shape === 'box') { lx *= b.half.x - pr; ly *= b.half.y - pr; lz *= b.half.z - pr; }
            else if (b.shape === 'capsule') { ly *= b.half.y; lx = 0; lz = 0; }
            quatRotate(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w, lx, ly, lz, _v);
            if (this.world.sweepSphere(
              b.position.x + _v.x, b.position.y + _v.y, b.position.z + _v.z, pr,
              ux, uy, uz, minT, b.mask, this._hit
            )) {
              if (this._hit.t < minT) minT = this._hit.t;
            }
          }
          /*
           * `minT > 1e-4` is load-bearing. A body resting on the floor has
           * gravity re-added to its velocity at the top of every step, so the
           * sweep always reports a probe touching and moving inward at t = 0.
           * Clamping to that would set stepDt = 0 — the body stops translating
           * AND stops rotating, forever, while its velocity sits at whatever the
           * impulses leave. It looks like a body frozen mid-air with 4.7 m/s and
           * 26 rad/s stored in it, and it never sleeps.
           *
           * An existing contact is the DISCRETE resolver's job, not CCD's. CCD
           * exists only to stop a body crossing a surface it was not already
           * touching, so t = 0 hits are ignored here by design.
           */
          if (minT < travel && minT > 1e-4) {
            stepDt = minT / speed;
            this.counters.ccdClamps++;
          }
        }
      }

      b.position.addScaledVector(b.velocity, stepDt);
      quatIntegrate(b.quaternion, b.angular.x, b.angular.y, b.angular.z, stepDt);

      // ---- resolve against the static world ----
      b.contactCount = 0;
      this._resolve(b, dt);

      // ---- contact + resting damping (see the constants above) ----
      if (b.contactCount > 0) {
        b.angular.multiplyScalar(
          1 - Math.min(SPIN_FRICTION_MAX, SPIN_FRICTION * b.contactCount)
        );
        if (b.velocity.lengthSq() < REST_SPEED * REST_SPEED &&
            b.angular.lengthSq() < REST_SPIN * REST_SPIN) {
          b.velocity.multiplyScalar(REST_DAMP_LINEAR);
          b.angular.multiplyScalar(REST_DAMP_ANGULAR);
        }
      }

      // ---- sleep ----
      if (b.velocity.lengthSq() < SLEEP_LINEAR * SLEEP_LINEAR &&
          b.angular.lengthSq() < SLEEP_ANGULAR * SLEEP_ANGULAR) {
        b.sleepTimer += dt;
        if (b.sleepTimer >= SLEEP_TIME) {
          b.sleeping = true;
          b.velocity.set(0, 0, 0);
          b.angular.set(0, 0, 0);
        }
      } else {
        b.sleepTimer = 0;
      }
    }
    this.awakeCount = awake;
  }

  /**
   * Resolve every probe sphere against the static world.
   *
   * Sequential impulses: for each penetrating probe we compute the relative
   * velocity at the contact, apply a normal impulse with restitution, then a
   * Coulomb-clamped friction impulse in the tangent plane, then a Baumgarte
   * position correction. Two passes are enough for debris; a third is
   * imperceptible and costs 50% more.
   */
  _resolve(b, dt) {
    const w = this.world;
    if (!w || w.triCount === 0) {
      // Fall back to a ground plane at y=0 so debris still behaves before the
      // level registers colliders.
      const low = b.position.y - b.boundRadius;
      if (low < 0) {
        b.position.y -= low;
        if (b.velocity.y < 0) {
          this._emitImpact(b, b.position.x, 0, b.position.z, 0, 1, 0, -b.velocity.y, SURFACE.stone);
          b.velocity.y = -b.velocity.y * b.restitution;
          b.velocity.x *= 0.7; b.velocity.z *= 0.7;
          b.angular.multiplyScalar(0.7);
        }
      }
      return;
    }

    const q = b.quaternion;
    for (let pass = 0; pass < 2; pass++) {
      const lastProbe = b.probeCount - 1;
      for (let p = 0; p < b.probeCount; p++) {
        // Probe position in world space. The final probe of every layout is the
        // centre one and carries the inscribed radius (see PROBES).
        const isCentre = p === lastProbe && b.shape !== 'sphere';
        const pr = isCentre ? b.inscribed : b.probeRadius;
        let lx = b.probes[p * 3], ly = b.probes[p * 3 + 1], lz = b.probes[p * 3 + 2];
        if (b.shape === 'box') { lx *= b.half.x - pr; ly *= b.half.y - pr; lz *= b.half.z - pr; }
        else if (b.shape === 'capsule') { ly *= b.half.y; lx = 0; lz = 0; }
        quatRotate(q.x, q.y, q.z, q.w, lx, ly, lz, _v);
        const wx = b.position.x + _v.x;
        const wy = b.position.y + _v.y;
        const wz = b.position.z + _v.z;

        const c = w.overlapSphere(wx, wy, wz, pr + CONTACT_SKIN, b.mask, this._contacts);
        if (c.count === 0) continue;

        // Merge contacts into the single deepest plane per probe: multiple
        // triangles of the same flat floor otherwise apply the impulse N times
        // and debris rockets off it.
        let bi = 0;
        for (let i = 1; i < c.count; i++) if (c.depth[i] > c.depth[bi]) bi = i;
        const nx = c.nx[bi], ny = c.ny[bi], nz = c.nz[bi];
        // The query was inflated by the skin, so back it out: `depth` is true
        // penetration and goes negative inside the skin, where we still want the
        // velocity response but no positional correction.
        const depth = c.depth[bi] - CONTACT_SKIN;
        const cxp = c.px[bi], cyp = c.py[bi], czp = c.pz[bi];
        const surfId = c.surface[bi];
        this.counters.contacts++;
        if (pass === 0) b.contactCount++;

        // Relative velocity at the contact point.
        b.pointVelocity(cxp, cyp, czp, this._probe);
        const vn = this._probe.x * nx + this._probe.y * ny + this._probe.z * nz;

        if (vn < 0) {
          const sp = surfaceProps(surfId);
          const rest = vn < -1.2 ? Math.min(b.restitution, sp.restitution) : 0;
          const j = this._normalImpulse(b, cxp, cyp, czp, nx, ny, nz, -(1 + rest) * vn);

          if (pass === 0 && -vn > 1.1 && b.impactCooldown <= 0) {
            this._emitImpact(b, cxp, cyp, czp, nx, ny, nz, -vn, surfId);
          }

          // Friction: tangential velocity after the normal impulse.
          b.pointVelocity(cxp, cyp, czp, this._probe);
          const vn2 = this._probe.x * nx + this._probe.y * ny + this._probe.z * nz;
          let tx = this._probe.x - nx * vn2;
          let ty = this._probe.y - ny * vn2;
          let tz = this._probe.z - nz * vn2;
          const tl = Math.hypot(tx, ty, tz);
          if (tl > 1e-4) {
            tx /= tl; ty /= tl; tz /= tl;
            const mu = Math.sqrt(b.friction * sp.friction);
            const jt = clamp(this._tangentMagnitude(b, cxp, cyp, czp, tx, ty, tz, -tl), -mu * j, mu * j);
            b._impulse(tx * jt, ty * jt, tz * jt, cxp, cyp, czp);
          }
        }

        // Positional correction with slop, so resting bodies do not jitter.
        // Capped: a body that somehow ends up deeply buried eases out over
        // several frames instead of teleporting and dragging its velocity with it.
        if (depth > CONTACT_SLOP) {
          const corr = Math.min((depth - CONTACT_SLOP) * BAUMGARTE, MAX_CORRECTION);
          b.position.x += nx * corr;
          b.position.y += ny * corr;
          b.position.z += nz * corr;
        }
      }
    }
  }

  /** Apply a normal impulse solving for a target normal velocity change. */
  _normalImpulse(b, px, py, pz, nx, ny, nz, dvn) {
    const rx = px - b.position.x, ry = py - b.position.y, rz = pz - b.position.z;
    const k = this._effectiveMass(b, rx, ry, rz, nx, ny, nz);
    if (k <= EPS) return 0;
    const j = dvn / k;
    if (j <= 0) return 0;
    b._impulse(nx * j, ny * j, nz * j, px, py, pz);
    return j;
  }

  _tangentMagnitude(b, px, py, pz, tx, ty, tz, dvt) {
    const rx = px - b.position.x, ry = py - b.position.y, rz = pz - b.position.z;
    const k = this._effectiveMass(b, rx, ry, rz, tx, ty, tz);
    return k > EPS ? dvt / k : 0;
  }

  /** 1/m + n · ((I^-1 (r x n)) x r) — the standard contact effective mass. */
  _effectiveMass(b, rx, ry, rz, nx, ny, nz) {
    const cx = ry * nz - rz * ny;
    const cy = rz * nx - rx * nz;
    const cz = rx * ny - ry * nx;
    const q = b.quaternion;
    quatRotate(-q.x, -q.y, -q.z, q.w, cx, cy, cz, _v);
    _v.x *= b.invInertia.x; _v.y *= b.invInertia.y; _v.z *= b.invInertia.z;
    quatRotate(q.x, q.y, q.z, q.w, _v.x, _v.y, _v.z, _v2);
    const dx = _v2.y * rz - _v2.z * ry;
    const dy = _v2.z * rx - _v2.x * rz;
    const dz = _v2.x * ry - _v2.y * rx;
    return b.invMass + (dx * nx + dy * ny + dz * nz);
  }

  _emitImpact(b, px, py, pz, nx, ny, nz, speed, surfId) {
    b.impactCooldown = 0.08;
    b.lastImpactSpeed = speed;
    this.counters.impacts++;
    if (b.onImpact) b.onImpact(b, px, py, pz, nx, ny, nz, speed, surfaceName(surfId));
    if (!this.events) return;
    // Reused payloads — ARCHITECTURE.md forbids fresh literals on hot events, and
    // a shattered urn produces a dozen of these in one frame.
    const p = this._impactPayload;
    p.position.set(px, py, pz);
    p.normal.set(nx, ny, nz);
    p.surface = surfaceName(surfId);
    p.element = 'physical';
    // Magnitude is normalised so fx can drive particle count directly: 1.0 is a
    // solid landing, 3+ is a shard flung by an explosion.
    p.magnitude = clamp(speed / 5, 0.1, 4) * clamp(b.mass / 4, 0.25, 2.5);
    this.events.emit('fx:impact', p);
  }

  /**
   * Radial impulse — an explosion, a shockwave, a corpse hitting a debris pile.
   * Wakes and pushes every body whose centre is inside `radius`, with a smooth
   * falloff and a lift bias so debris arcs upward rather than skating outward.
   */
  applyRadialImpulse(cx, cy, cz, radius, strength, lift = 0.45) {
    let n = 0;
    const r2 = radius * radius;
    for (let i = 0; i < this.capacity; i++) {
      const b = this.bodies[i];
      if (!b.active || b.invMass === 0) continue;
      const dx = b.position.x - cx, dy = b.position.y - cy, dz = b.position.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const falloff = 1 - d / radius;
      const s = strength * falloff * falloff;
      b.wake();
      const ux = dx / d, uy = dy / d + lift, uz = dz / d;
      const ul = Math.hypot(ux, uy, uz) || 1;
      // Off-centre so the impulse also spins the body — debris that translates
      // without tumbling looks like a sprite.
      b.applyImpulse(
        (ux / ul) * s, (uy / ul) * s, (uz / ul) * s,
        b.position.x + b.half.x * 0.5, b.position.y, b.position.z + b.half.z * 0.5
      );
      n++;
    }
    return n;
  }

  /**
   * Write interpolated transforms into the bodies' meshes.
   * Called from `update()` with `ctx.time.alpha`, never from `fixedUpdate`.
   */
  syncMeshes(alpha) {
    for (let i = 0; i < this.capacity; i++) {
      const b = this.bodies[i];
      if (!b.active || !b.mesh) continue;
      if (b.sleeping) {
        b.mesh.position.copy(b.position);
        b.mesh.quaternion.copy(b.quaternion);
      } else {
        b.mesh.position.lerpVectors(b.prevPos, b.position, alpha);
        this._tmpQ.copy(b.prevQuat).slerp(b.quaternion, alpha);
        b.mesh.quaternion.copy(this._tmpQ);
      }
      if (b.mesh.visible === false) b.mesh.visible = true;
    }
  }

  /** Raycast against the active bodies. Returns the body or null; fills `out`. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, out) {
    let best = maxDist, bestBody = null;
    for (let i = 0; i < this.capacity; i++) {
      const b = this.bodies[i];
      if (!b.active) continue;
      // Bounding-sphere test only: debris is small and transient, and a precise
      // OBB test would cost more than the visual difference is worth.
      const mx = ox - b.position.x, my = oy - b.position.y, mz = oz - b.position.z;
      const bb = mx * dx + my * dy + mz * dz;
      const cc = mx * mx + my * my + mz * mz - b.boundRadius * b.boundRadius;
      if (cc > 0 && bb > 0) continue;
      const disc = bb * bb - cc;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = -bb - sq;
      if (t < 0) t = -bb + sq;
      if (t < 0 || t >= best) continue;
      best = t;
      bestBody = b;
    }
    if (!bestBody) return null;
    out.hit = true;
    out.t = best;
    out.px = ox + dx * best; out.py = oy + dy * best; out.pz = oz + dz * best;
    const nx = out.px - bestBody.position.x, ny = out.py - bestBody.position.y, nz = out.pz - bestBody.position.z;
    const l = Math.hypot(nx, ny, nz) || 1;
    out.nx = nx / l; out.ny = ny / l; out.nz = nz / l;
    out.surfaceId = bestBody.surfaceId;
    out.surface = surfaceName(bestBody.surfaceId);
    out.kind = 'body';
    out.body = bestBody;
    out.mesh = bestBody.mesh;
    return bestBody;
  }

  stats() {
    return {
      active: this.activeCount,
      awake: this.awakeCount,
      capacity: this.capacity,
      contacts: this.counters.contacts,
      ccdClamps: this.counters.ccdClamps,
      impacts: this.counters.impacts,
    };
  }

  dispose() {
    this.clear();
    this.world = null;
    this.events = null;
  }
}
