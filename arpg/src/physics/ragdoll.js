/**
 * ragdoll.js — position-based-dynamics ragdolls for enemy deaths.
 *
 * "Explosive combat" is 60% impact frames and 40% what happens *after* the kill.
 * A corpse that folds, tumbles, catches its shoulder on a step and slaps flat onto
 * flagstone sells the hit harder than any particle. This is that system.
 *
 * WHY PBD AND NOT ARTICULATED RIGID BODIES
 * A humanoid is 16 bodies and ~30 joints. An impulse solver needs many iterations
 * before the joints stop stretching, and a stretched ragdoll is instantly, badly
 * wrong to look at. PBD projects positions directly: the constraint is satisfied
 * exactly at the end of every iteration, at any stiffness, with no tuning. Joint
 * *limits* fall out of the same machinery as min/max distance constraints between
 * grandparent and grandchild particles — an elbow that cannot hyperextend is just
 * `|shoulder - hand| <= 0.98 * armLength`.
 *
 * The particle graph (16 particles, 11 rendered bones):
 *
 *            3 head
 *            |
 *   4--5--6  2 chest  7--8--9        (L arm: 4 shoulder, 5 elbow, 6 hand)
 *            |                        (R arm: 7,8,9)
 *            1 spine
 *            |
 *            0 pelvis
 *           / \
 *         10   13   hips
 *         |     |
 *         11   14   knees
 *         |     |
 *         12   15   feet
 *
 * OUTPUT CONTRACT for `ai`: after `fixedUpdate`, `ragdoll.bones` holds one entry
 * per bone with a world `position` (the bone's MIDPOINT), a `quaternion` whose
 * local +Y runs down the bone, and a `length`. Attach a mesh with
 * `ragdoll.attach(boneName, object3d)` and physics drives it every frame with
 * interpolation. Nothing in `ai` needs to know PBD exists.
 */

import * as THREE from 'three';
import { clamp, quatLookUp, EPS } from './math.js';
import { makeContacts } from './bvh.js';
import { MASK, surfaceName, surfaceProps, SURFACE } from './surfaces.js';

/* ------------------------------------------------------------------ */
/* Skeleton template — a 1.8 m humanoid facing +Z, feet at y = 0        */
/* ------------------------------------------------------------------ */

const P = {
  PELVIS: 0, SPINE: 1, CHEST: 2, HEAD: 3,
  SHOULDER_L: 4, ELBOW_L: 5, HAND_L: 6,
  SHOULDER_R: 7, ELBOW_R: 8, HAND_R: 9,
  HIP_L: 10, KNEE_L: 11, FOOT_L: 12,
  HIP_R: 13, KNEE_R: 14, FOOT_R: 15,
};
const NP = 16;

/** x, y, z, mass(kg), collisionRadius(m) for a 1.8 m, 78 kg humanoid. */
const TEMPLATE = new Float32Array([
  0.00, 0.95, 0.00, 12.0, 0.135,   // pelvis
  0.00, 1.18, 0.00, 10.0, 0.130,   // spine
  0.00, 1.38, 0.00, 12.0, 0.140,   // chest
  0.00, 1.63, 0.00, 5.0, 0.115,    // head
  -0.19, 1.42, 0.00, 3.0, 0.085,   // shoulder L
  -0.42, 1.18, 0.02, 2.2, 0.070,   // elbow L
  -0.50, 0.92, 0.05, 1.2, 0.055,   // hand L
  0.19, 1.42, 0.00, 3.0, 0.085,    // shoulder R
  0.42, 1.18, 0.02, 2.2, 0.070,    // elbow R
  0.50, 0.92, 0.05, 1.2, 0.055,    // hand R
  -0.11, 0.92, 0.00, 3.0, 0.095,   // hip L
  -0.13, 0.52, 0.02, 4.2, 0.085,   // knee L
  -0.13, 0.09, 0.06, 2.0, 0.075,   // foot L
  0.11, 0.92, 0.00, 3.0, 0.095,    // hip R
  0.13, 0.52, 0.02, 4.2, 0.085,    // knee R
  0.13, 0.09, 0.06, 2.0, 0.075,    // foot R
]);

/** Rendered bones: [name, fromParticle, toParticle, visualRadius]. */
const BONES = [
  ['pelvis', P.PELVIS, P.SPINE, 0.16],
  ['spine', P.SPINE, P.CHEST, 0.17],
  ['head', P.CHEST, P.HEAD, 0.13],
  ['upperArmL', P.SHOULDER_L, P.ELBOW_L, 0.075],
  ['lowerArmL', P.ELBOW_L, P.HAND_L, 0.06],
  ['upperArmR', P.SHOULDER_R, P.ELBOW_R, 0.075],
  ['lowerArmR', P.ELBOW_R, P.HAND_R, 0.06],
  ['thighL', P.HIP_L, P.KNEE_L, 0.095],
  ['shinL', P.KNEE_L, P.FOOT_L, 0.08],
  ['thighR', P.HIP_R, P.KNEE_R, 0.095],
  ['shinR', P.KNEE_R, P.FOOT_R, 0.08],
];
const NB = BONES.length;

/**
 * Constraint table: [a, b, kind, param].
 *   kind 0 = rigid distance (rest length from the template)
 *   kind 1 = maximum distance (param = fraction of the template distance)
 *   kind 2 = minimum distance (param = fraction of the template distance)
 *
 * The rigid set is the skeleton. The min/max set is what makes it read as a BODY
 * rather than a bag: elbows and knees that cannot invert, a neck that cannot fold
 * into the chest, arms that cannot pass through the ribcage.
 */
const CONSTRAINTS = [
  // ---- skeleton (rigid) ----
  [P.PELVIS, P.SPINE, 0, 1], [P.SPINE, P.CHEST, 0, 1], [P.CHEST, P.HEAD, 0, 1],
  [P.CHEST, P.SHOULDER_L, 0, 1], [P.SHOULDER_L, P.ELBOW_L, 0, 1], [P.ELBOW_L, P.HAND_L, 0, 1],
  [P.CHEST, P.SHOULDER_R, 0, 1], [P.SHOULDER_R, P.ELBOW_R, 0, 1], [P.ELBOW_R, P.HAND_R, 0, 1],
  [P.PELVIS, P.HIP_L, 0, 1], [P.HIP_L, P.KNEE_L, 0, 1], [P.KNEE_L, P.FOOT_L, 0, 1],
  [P.PELVIS, P.HIP_R, 0, 1], [P.HIP_R, P.KNEE_R, 0, 1], [P.KNEE_R, P.FOOT_R, 0, 1],

  // ---- shape preservation: the torso must stay a torso ----
  [P.PELVIS, P.CHEST, 0, 1],
  [P.SHOULDER_L, P.SHOULDER_R, 0, 1],
  [P.HIP_L, P.HIP_R, 0, 1],
  [P.SPINE, P.SHOULDER_L, 0, 1], [P.SPINE, P.SHOULDER_R, 0, 1],
  [P.SPINE, P.HIP_L, 0, 1], [P.SPINE, P.HIP_R, 0, 1],
  [P.CHEST, P.HIP_L, 1, 1.02], [P.CHEST, P.HIP_R, 1, 1.02],

  // ---- joint limits ----
  [P.SHOULDER_L, P.HAND_L, 1, 0.99], [P.SHOULDER_L, P.HAND_L, 2, 0.30],
  [P.SHOULDER_R, P.HAND_R, 1, 0.99], [P.SHOULDER_R, P.HAND_R, 2, 0.30],
  [P.HIP_L, P.FOOT_L, 1, 0.99], [P.HIP_L, P.FOOT_L, 2, 0.34],
  [P.HIP_R, P.FOOT_R, 1, 0.99], [P.HIP_R, P.FOOT_R, 2, 0.34],
  [P.SPINE, P.HEAD, 2, 0.80], [P.SPINE, P.HEAD, 1, 1.10],
  // arms may not pass through the ribcage
  [P.CHEST, P.ELBOW_L, 2, 0.70], [P.CHEST, P.ELBOW_R, 2, 0.70],
  [P.PELVIS, P.HAND_L, 2, 0.45], [P.PELVIS, P.HAND_R, 2, 0.45],
  // legs may not scissor through each other
  [P.KNEE_L, P.KNEE_R, 2, 0.55], [P.FOOT_L, P.FOOT_R, 2, 0.40],
];
const NC = CONSTRAINTS.length;

/** Solver iterations. 7 is where a 16-particle body stops visibly stretching on
 *  a hard landing; 10 is imperceptibly better and 40% dearer. */
const ITERS = 7;
/** Verlet velocity retention per step. Flesh is not a bouncy castle. */
const DAMP = 0.965;
/** Kinetic-energy threshold and dwell time before a corpse freezes for good. */
const SETTLE_SPEED = 0.075;
const SETTLE_TIME = 0.55;
/** Hard per-particle speed cap, m/s. A corpse launched by a critical hit should
 *  fly; it should not leave the room. This also makes the system immune to a
 *  caller passing a nonsensical impulse — the frame stays stable no matter what
 *  `combat` hands us. 22 m/s is roughly "thrown across the hall". */
const MAX_PARTICLE_SPEED = 22;
/** Contact planes cached per particle per step. Three covers a corner. */
const MAX_PLANES = 3;

export class Ragdoll {
  constructor(id) {
    this.id = id;
    this.active = false;
    this.settled = false;
    this.settleTimer = 0;
    this.age = 0;
    this.lifetime = Infinity;
    this.fade = 1;
    this.fadeTime = 1.2;

    this.px = new Float32Array(NP);
    this.py = new Float32Array(NP);
    this.pz = new Float32Array(NP);
    this.ox = new Float32Array(NP);
    this.oy = new Float32Array(NP);
    this.oz = new Float32Array(NP);
    this.invMass = new Float32Array(NP);
    this.pradius = new Float32Array(NP);
    /** Rest lengths, baked at spawn from the scaled template. */
    this.rest = new Float32Array(NC);

    /**
     * Cached contact planes, up to MAX_PLANES per particle: nx, ny, nz, d where
     * the particle must satisfy `dot(n, p) >= d`. Gathered ONCE per step and then
     * re-projected inside every solver iteration.
     *
     * This is the difference between a corpse that settles and one that shivers
     * forever. Solving the skeleton and then pushing particles out of the floor
     * afterwards means the next step's skeleton solve pulls them straight back
     * in — a limit cycle that never falls below the sleep threshold. Treating
     * collision as just another positional constraint inside the same loop makes
     * the two converge together, and re-using cached planes keeps the cost at one
     * BVH query per particle per step instead of one per iteration.
     */
    this.planeN = new Float32Array(NP * MAX_PLANES * 4);
    this.planeCount = new Uint8Array(NP);
    this.planeSurface = new Uint8Array(NP);

    /** Per-bone output. `position` is the bone MIDPOINT. */
    this.bones = new Array(NB);
    for (let i = 0; i < NB; i++) {
      this.bones[i] = {
        name: BONES[i][0],
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        length: 0,
        radius: 0,
        mesh: null,
        /** Offset applied to the attached mesh, in bone space. */
        offset: new THREE.Vector3(),
        scaleMesh: true,
      };
    }
    this.boneByName = new Map();
    for (const b of this.bones) this.boneByName.set(b.name, b);

    /** Root object3d the owner (ai) may parent things to; physics moves it to
     *  the pelvis so a corpse-marker or extraction VFX has an anchor. */
    this.root = null;
    this.actor = null;
    this.scale = 1;
    this.surfaceId = SURFACE.flesh;
    this.mask = MASK.RAGDOLL;
    this.userData = null;

    /** Set once, the frame the corpse first lands hard. `fx` can key a dust puff
     *  and `audio` a body-fall off this. */
    this.landed = false;
    this.landSpeed = 0;

    this.centre = new THREE.Vector3();
    this.lowestY = 0;
    this._q = new THREE.Quaternion();
    this._impactCooldown = 0;
  }

  particle(i, out) {
    out.set(this.px[i], this.py[i], this.pz[i]);
    return out;
  }

  /** Attach a mesh to a bone. Physics writes its transform every frame. */
  attach(boneName, object3d, opts = {}) {
    const b = this.boneByName.get(boneName);
    if (!b) return null;
    b.mesh = object3d;
    if (opts.offset) b.offset.copy(opts.offset);
    b.scaleMesh = opts.scale !== false;
    return b;
  }

  /**
   * Apply an impulse (kg·m/s) to the particles within `radius` of a world point.
   *
   * Scale reference for `combat`: particle masses are 1–12 kg, so a solid melee
   * killing blow is 60–200, a critical greatsword slam 300–500, and an explosion
   * 600+. Anything is safe — the integrator clamps particle speed — but values
   * over ~800 stop reading as a body and start reading as a glitch.
   */
  impulseAt(px, py, pz, ix, iy, iz, radius = 0.55) {
    const r2 = radius * radius;
    for (let i = 0; i < NP; i++) {
      if (this.invMass[i] === 0) continue;
      const dx = this.px[i] - px, dy = this.py[i] - py, dz = this.pz[i] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const w = 1 - Math.sqrt(d2) / radius;
      // In Verlet, velocity IS (p - o), so an impulse is a backward offset of the
      // previous position. Scaling by invMass keeps a hand from flying off while
      // the torso barely moves.
      const k = w * this.invMass[i] * 0.02;
      this.ox[i] -= ix * k;
      this.oy[i] -= iy * k;
      this.oz[i] -= iz * k;
    }
    this.settled = false;
    this.settleTimer = 0;
  }

  /** Uniform velocity impulse over the whole body (a launch, a knockback). */
  impulseAll(ix, iy, iz) {
    for (let i = 0; i < NP; i++) {
      if (this.invMass[i] === 0) continue;
      this.ox[i] -= ix;
      this.oy[i] -= iy;
      this.oz[i] -= iz;
    }
    this.settled = false;
    this.settleTimer = 0;
  }
}

export class RagdollWorld {
  constructor(world, opts = {}) {
    this.world = world;
    this.gravity = opts.gravity ?? -18.6;
    this.capacity = opts.capacity ?? 16;
    this.events = opts.events ?? null;

    this.dolls = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.dolls[i] = new Ragdoll(i);
    this._free = [];
    for (let i = this.capacity - 1; i >= 0; i--) this._free.push(i);
    this.activeCount = 0;
    this.simulatingCount = 0;

    this._contacts = makeContacts(24);
    this._impactPayload = {
      position: new THREE.Vector3(), normal: new THREE.Vector3(),
      surface: 'flesh', element: 'physical', magnitude: 1,
    };
    this._shakePayload = { amount: 0, duration: 0.18, frequency: 22 };
    this._cuePayload = { cue: 'body_fall', position: new THREE.Vector3(), gain: 1 };
    this.counters = { steps: 0, projections: 0, contacts: 0, landings: 0 };
    this._tmpQ = new THREE.Quaternion();
  }

  /* ---------------------------------------------------------------- */
  /* Spawning                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * @param opts
   *   position   Vector3, feet position
   *   yaw        radians, facing
   *   height     total height in metres (scales the whole template)
   *   massScale  multiplies every particle mass (a boss corpse is heavy)
   *   velocity   Vector3, inherited motion
   *   impulse    { x, y, z } killing-blow impulse
   *   hitPoint   Vector3 where the killing blow landed (impulse is focused there)
   *   lifetime   seconds before the corpse fades and is recycled
   *   actor      the actor that died, kept for the owner's bookkeeping
   *   root       Object3D moved to the pelvis every frame
   */
  spawn(opts = {}) {
    if (this._free.length === 0) {
      // Recycle the oldest settled corpse. A fight must never stop producing
      // ragdolls — an enemy that pops out of existence is the single worst
      // "cheap game" tell there is.
      let victim = -1, bestAge = -1;
      for (let i = 0; i < this.capacity; i++) {
        const d = this.dolls[i];
        if (!d.active) continue;
        if (d.settled && d.age > bestAge) { bestAge = d.age; victim = i; }
      }
      if (victim < 0) {
        for (let i = 0; i < this.capacity; i++) {
          const d = this.dolls[i];
          if (d.active && d.age > bestAge) { bestAge = d.age; victim = i; }
        }
      }
      if (victim < 0) return null;
      this.despawn(this.dolls[victim]);
    }
    const id = this._free.pop();
    const d = this.dolls[id];

    d.active = true;
    d.settled = false;
    d.settleTimer = 0;
    d.age = 0;
    d.fade = 1;
    d.landed = false;
    d.landSpeed = 0;
    d._impactCooldown = 0;
    d.lifetime = opts.lifetime ?? Infinity;
    d.fadeTime = opts.fadeTime ?? 1.2;
    d.actor = opts.actor ?? null;
    d.root = opts.root ?? null;
    d.userData = opts.userData ?? null;
    d.mask = opts.mask ?? MASK.RAGDOLL;
    d.surfaceId = typeof opts.surface === 'number'
      ? opts.surface
      : (SURFACE[opts.surface] ?? SURFACE.flesh);

    const height = opts.height ?? 1.8;
    const s = height / 1.8;
    d.scale = s;
    const yaw = opts.yaw ?? 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const ox = opts.position?.x ?? 0;
    const oy = opts.position?.y ?? 0;
    const oz = opts.position?.z ?? 0;
    const massScale = opts.massScale ?? (s * s * s);

    // Small deterministic asymmetry so two skeletons killed by the same cleave do
    // not fall in perfect unison. Derived from the slot id, never Math.random().
    const wob = ((id * 2654435761) >>> 0) / 4294967296 - 0.5;

    for (let i = 0; i < NP; i++) {
      const t = i * 5;
      const lx = TEMPLATE[t] * s;
      const ly = TEMPLATE[t + 1] * s;
      const lz = TEMPLATE[t + 2] * s * (1 + wob * 0.08);
      // Rotate about Y by yaw, then translate to the death position.
      const wx = ox + lx * cy + lz * sy;
      const wy = oy + ly;
      const wz = oz - lx * sy + lz * cy;
      d.px[i] = wx; d.py[i] = wy; d.pz[i] = wz;
      d.ox[i] = wx; d.oy[i] = wy; d.oz[i] = wz;
      d.invMass[i] = 1 / (TEMPLATE[t + 3] * massScale);
      d.pradius[i] = TEMPLATE[t + 4] * s;
    }

    // Bake rest lengths from the posed skeleton.
    for (let c = 0; c < NC; c++) {
      const a = CONSTRAINTS[c][0], b = CONSTRAINTS[c][1];
      d.rest[c] = Math.hypot(d.px[a] - d.px[b], d.py[a] - d.py[b], d.pz[a] - d.pz[b]);
    }

    // Inherited velocity: shift the previous positions backwards by v*dt.
    if (opts.velocity) {
      const k = 1 / 60;
      for (let i = 0; i < NP; i++) {
        d.ox[i] -= opts.velocity.x * k;
        d.oy[i] -= opts.velocity.y * k;
        d.oz[i] -= opts.velocity.z * k;
      }
    }

    // Killing blow. Focused at the hit point when we have one, otherwise applied
    // to the chest — which produces the classic backwards-off-the-feet fall.
    if (opts.impulse) {
      const hp = opts.hitPoint;
      if (hp) {
        d.impulseAt(hp.x, hp.y, hp.z, opts.impulse.x, opts.impulse.y, opts.impulse.z, opts.impulseRadius ?? 0.7 * s);
      } else {
        d.impulseAt(d.px[P.CHEST], d.py[P.CHEST], d.pz[P.CHEST],
          opts.impulse.x, opts.impulse.y, opts.impulse.z, 1.2 * s);
      }
    }
    // A dying body always has *some* spin, or the fall looks like a felled plank.
    const spin = (opts.spin ?? 1) * (0.5 + wob);
    d.ox[P.SHOULDER_L] -= 0.004 * spin;
    d.ox[P.SHOULDER_R] += 0.004 * spin;
    d.oz[P.HAND_L] += 0.006 * spin;
    d.oz[P.HAND_R] -= 0.006 * spin;

    this.activeCount++;
    this.updateBones(d);
    return d;
  }

  despawn(doll) {
    if (!doll || !doll.active) return false;
    doll.active = false;
    doll.actor = null;
    doll.root = null;
    doll.userData = null;
    for (const b of doll.bones) b.mesh = null;
    this._free.push(doll.id);
    this.activeCount--;
    return true;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) if (this.dolls[i].active) this.despawn(this.dolls[i]);
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  step(dt) {
    this.counters.steps++;
    const g = this.gravity * dt * dt;
    let simulating = 0;

    for (let di = 0; di < this.capacity; di++) {
      const d = this.dolls[di];
      if (!d.active) continue;

      d.age += dt;
      if (d.age >= d.lifetime) { this.despawn(d); continue; }
      const remaining = d.lifetime - d.age;
      d.fade = remaining < d.fadeTime ? clamp(remaining / d.fadeTime, 0, 1) : 1;
      if (d._impactCooldown > 0) d._impactCooldown -= dt;

      // A settled corpse costs exactly nothing until something wakes it.
      if (d.settled) continue;
      simulating++;

      // ---- integrate ----
      const maxStep = MAX_PARTICLE_SPEED * dt;
      for (let i = 0; i < NP; i++) {
        if (d.invMass[i] === 0) continue;
        let vx = (d.px[i] - d.ox[i]) * DAMP;
        let vy = (d.py[i] - d.oy[i]) * DAMP;
        let vz = (d.pz[i] - d.oz[i]) * DAMP;
        // Clamp the per-step displacement, not the impulse: an over-enthusiastic
        // caller then produces a hard fling rather than a corpse in orbit, and
        // the constraint solver never sees a step it cannot satisfy.
        const step = Math.hypot(vx, vy, vz);
        if (step > maxStep) {
          const k = maxStep / step;
          vx *= k; vy *= k; vz *= k;
        }
        d.ox[i] = d.px[i]; d.oy[i] = d.py[i]; d.oz[i] = d.pz[i];
        d.px[i] += vx;
        d.py[i] += vy + g;
        d.pz[i] += vz;
      }

      // ---- gather contact planes once, then solve skeleton + contacts together ----
      this._gatherContacts(d);
      for (let it = 0; it < ITERS; it++) {
        this._project(d);
        this._projectContacts(d);
      }

      // ---- velocity response: friction, landing events ----
      this._resolveContacts(d, dt);

      // ---- settle test ----
      let moving = 0;
      for (let i = 0; i < NP; i++) {
        const vx = d.px[i] - d.ox[i], vy = d.py[i] - d.oy[i], vz = d.pz[i] - d.oz[i];
        const sp = Math.hypot(vx, vy, vz) / dt;
        if (sp > moving) moving = sp;
      }
      if (moving < SETTLE_SPEED) {
        d.settleTimer += dt;
        if (d.settleTimer >= SETTLE_TIME) {
          d.settled = true;
          // Freeze exactly, so a settled corpse never creeps.
          for (let i = 0; i < NP; i++) { d.ox[i] = d.px[i]; d.oy[i] = d.py[i]; d.oz[i] = d.pz[i]; }
        }
      } else {
        d.settleTimer = 0;
      }

      this.updateBones(d);
    }
    this.simulatingCount = simulating;
  }

  /** One Gauss-Seidel pass over the constraint table. */
  _project(d) {
    for (let c = 0; c < NC; c++) {
      const con = CONSTRAINTS[c];
      const a = con[0], b = con[1], kind = con[2];
      const wa = d.invMass[a], wb = d.invMass[b];
      const wsum = wa + wb;
      if (wsum <= EPS) continue;

      let dx = d.px[b] - d.px[a];
      let dy = d.py[b] - d.py[a];
      let dz = d.pz[b] - d.pz[a];
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1e-7) continue;

      let target;
      if (kind === 0) {
        target = d.rest[c];
      } else if (kind === 1) {
        target = d.rest[c] * con[3];
        if (dist <= target) continue;              // max: only pull in
      } else {
        target = d.rest[c] * con[3];
        if (dist >= target) continue;              // min: only push out
      }

      const diff = (dist - target) / dist / wsum;
      dx *= diff; dy *= diff; dz *= diff;
      d.px[a] += dx * wa; d.py[a] += dy * wa; d.pz[a] += dz * wa;
      d.px[b] -= dx * wb; d.py[b] -= dy * wb; d.pz[b] -= dz * wb;
      this.counters.projections++;
    }
  }

  /**
   * ONE collision query per particle per step. Distinct contact planes are
   * cached (deduplicated by normal, because a flat floor tessellated into two
   * triangles produces two identical planes and would otherwise burn both of the
   * remaining slots) for the solver loop to re-project against.
   */
  _gatherContacts(d) {
    const w = this.world;
    for (let i = 0; i < NP; i++) {
      d.planeCount[i] = 0;
      if (d.invMass[i] === 0) continue;
      const r = d.pradius[i];
      const base = i * MAX_PLANES * 4;

      if (!w || w.triCount === 0) {
        // Flat ground fallback so corpses still land before the level exists.
        if (d.py[i] - r < 0.02) {
          d.planeN[base] = 0; d.planeN[base + 1] = 1; d.planeN[base + 2] = 0;
          d.planeN[base + 3] = r;                       // dot(n,p) >= r  =>  y >= r
          d.planeCount[i] = 1;
          d.planeSurface[i] = SURFACE.stone;
        }
        continue;
      }

      // Query slightly wider than the particle so a resting corpse keeps its
      // plane from step to step instead of losing and regaining it (which reads
      // as a shiver).
      const c = w.overlapSphere(d.px[i], d.py[i], d.pz[i], r + 0.01, d.mask, this._contacts);
      if (c.count === 0) continue;
      this.counters.contacts++;

      let n = 0;
      for (let k = 0; k < c.count && n < MAX_PLANES; k++) {
        const nx = c.nx[k], ny = c.ny[k], nz = c.nz[k];
        let dup = false;
        for (let q = 0; q < n; q++) {
          const o = base + q * 4;
          if (d.planeN[o] * nx + d.planeN[o + 1] * ny + d.planeN[o + 2] * nz > 0.985) { dup = true; break; }
        }
        if (dup) continue;
        const o = base + n * 4;
        d.planeN[o] = nx; d.planeN[o + 1] = ny; d.planeN[o + 2] = nz;
        // Plane constant through the contact point, offset by the radius.
        d.planeN[o + 3] = nx * c.px[k] + ny * c.py[k] + nz * c.pz[k] + r;
        n++;
      }
      d.planeCount[i] = n;
      d.planeSurface[i] = c.surface[0];
    }
  }

  /** Project every particle out of its cached planes. Runs inside the solver. */
  _projectContacts(d) {
    for (let i = 0; i < NP; i++) {
      const n = d.planeCount[i];
      if (n === 0) continue;
      const base = i * MAX_PLANES * 4;
      for (let k = 0; k < n; k++) {
        const o = base + k * 4;
        const nx = d.planeN[o], ny = d.planeN[o + 1], nz = d.planeN[o + 2];
        const pen = d.planeN[o + 3] - (nx * d.px[i] + ny * d.py[i] + nz * d.pz[i]);
        if (pen <= 0) continue;
        d.px[i] += nx * pen;
        d.py[i] += ny * pen;
        d.pz[i] += nz * pen;
      }
    }
  }

  /**
   * Velocity response after the solver has converged: kill the inward component,
   * apply Coulomb-ish friction, and raise the landing event.
   *
   * Friction in PBD is applied by dragging the PREVIOUS position toward the
   * current one along the contact tangent — that removes tangential velocity
   * without any impulse bookkeeping. On stone a corpse slides a little then
   * stops; on blood it keeps going, which is a detail nobody will consciously
   * notice and everybody will feel.
   */
  _resolveContacts(d, dt) {
    let lowest = Infinity;
    let hardest = 0, hx = 0, hy = 0, hz = 0, hnx = 0, hny = 1, hnz = 0, hsurf = d.surfaceId;

    for (let i = 0; i < NP; i++) {
      if (d.py[i] < lowest) lowest = d.py[i];
      const n = d.planeCount[i];
      if (n === 0 || d.invMass[i] === 0) continue;
      const base = i * MAX_PLANES * 4;

      // Use the deepest-facing plane for the velocity response; the rest have
      // already been satisfied positionally.
      const nx = d.planeN[base], ny = d.planeN[base + 1], nz = d.planeN[base + 2];
      const vx = (d.px[i] - d.ox[i]) / dt;
      const vy = (d.py[i] - d.oy[i]) / dt;
      const vz = (d.pz[i] - d.oz[i]) / dt;
      const vn = vx * nx + vy * ny + vz * nz;
      if (vn >= 0) continue; // already separating

      if (-vn > hardest) {
        hardest = -vn;
        hx = d.px[i]; hy = d.py[i]; hz = d.pz[i];
        hnx = nx; hny = ny; hnz = nz;
        hsurf = d.planeSurface[i];
      }

      const sp = surfaceProps(d.planeSurface[i]);
      const mu = clamp(sp.friction * 0.65 + 0.25, 0, 1);
      const tvx = vx - nx * vn, tvy = vy - ny * vn, tvz = vz - nz * vn;
      d.ox[i] = d.px[i] - tvx * dt * (1 - mu);
      d.oy[i] = d.py[i] - tvy * dt * (1 - mu);
      d.oz[i] = d.pz[i] - tvz * dt * (1 - mu);
    }
    d.lowestY = lowest === Infinity ? 0 : lowest;

    // One impact event per landing, gated by a cooldown, scaled by how hard the
    // body hit. This is the "death has weight" beat: a corpse slamming into
    // flagstone at 8 m/s should shake the camera and thump.
    if (hardest > 1.4 && d._impactCooldown <= 0) {
      d._impactCooldown = 0.12;
      this.counters.landings++;
      const mag = clamp(hardest / 6, 0.2, 3);
      if (this.events) {
        const p = this._impactPayload;
        p.position.set(hx, hy, hz);
        p.normal.set(hnx, hny, hnz);
        // The SURFACE the corpse hit drives the FX; the corpse itself is flesh,
        // but a body landing on stone must throw stone dust, not blood mist —
        // fx gets both, via `surface` and the always-flesh `element`.
        p.surface = surfaceName(hsurf);
        p.element = 'physical';
        p.magnitude = mag;
        this.events.emit('fx:impact', p);

        const q = this._cuePayload;
        q.cue = 'body_fall';
        q.position.set(hx, hy, hz);
        q.gain = clamp(mag * 0.6, 0.15, 1.2);
        this.events.emit('audio:cue', q);

        if (hardest > 5.5) {
          const sh = this._shakePayload;
          // Deliberately small: a corpse landing is a texture beat, not a boss
          // slam, and stacking six of them during a nova must not nauseate.
          sh.amount = clamp(hardest / 60, 0.02, 0.12);
          sh.duration = 0.16;
          sh.frequency = 24;
          this.events.emit('camera:shake', sh);
        }
      }
      if (!d.landed) { d.landed = true; d.landSpeed = hardest; }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Output                                                            */
  /* ---------------------------------------------------------------- */

  /** Recompute bone transforms and the body's centre from the particles. */
  updateBones(d) {
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < NP; i++) { sx += d.px[i]; sy += d.py[i]; sz += d.pz[i]; }
    d.centre.set(sx / NP, sy / NP, sz / NP);

    for (let i = 0; i < NB; i++) {
      const spec = BONES[i];
      const a = spec[1], b = spec[2];
      const bone = d.bones[i];
      const ax = d.px[a], ay = d.py[a], az = d.pz[a];
      const bx = d.px[b], by = d.py[b], bz = d.pz[b];
      bone.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
      let dx = bx - ax, dy = by - ay, dz = bz - az;
      const len = Math.hypot(dx, dy, dz) || 1e-5;
      bone.length = len;
      bone.radius = spec[3] * d.scale;
      dx /= len; dy /= len; dz /= len;
      // Reference twist: the pelvis→chest axis, so limbs keep a consistent roll
      // relative to the torso instead of spinning about their own axis.
      let rx = d.px[P.CHEST] - d.px[P.PELVIS];
      let ry = d.py[P.CHEST] - d.py[P.PELVIS];
      let rz = d.pz[P.CHEST] - d.pz[P.PELVIS];
      const rl = Math.hypot(rx, ry, rz) || 1;
      quatLookUp(dx, dy, dz, rx / rl, ry / rl, rz / rl, bone.quaternion);
    }

    if (d.root) d.root.position.set(d.px[P.PELVIS], d.py[P.PELVIS], d.pz[P.PELVIS]);
  }

  /**
   * Write bone transforms into attached meshes, interpolated between the last two
   * fixed steps. Called from `update()`.
   *
   * A bone mesh is expected to be a unit-height cylinder/capsule along +Y with its
   * origin at the CENTRE. `scaleMesh` stretches it to the bone length, which is
   * how `ai` can build one geometry and reuse it for every limb.
   */
  syncMeshes(alpha) {
    for (let di = 0; di < this.capacity; di++) {
      const d = this.dolls[di];
      if (!d.active) continue;
      for (let i = 0; i < NB; i++) {
        const bone = d.bones[i];
        const m = bone.mesh;
        if (!m) continue;
        const spec = BONES[i];
        const a = spec[1], b = spec[2];
        // Interpolate the particle endpoints, not the bone transform: slerping a
        // quaternion built from stale endpoints drifts off the actual geometry.
        const t = d.settled ? 1 : alpha;
        const ax = d.ox[a] + (d.px[a] - d.ox[a]) * t;
        const ay = d.oy[a] + (d.py[a] - d.oy[a]) * t;
        const az = d.oz[a] + (d.pz[a] - d.oz[a]) * t;
        const bx = d.ox[b] + (d.px[b] - d.ox[b]) * t;
        const by = d.oy[b] + (d.py[b] - d.oy[b]) * t;
        const bz = d.oz[b] + (d.pz[b] - d.oz[b]) * t;

        m.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
        if (bone.offset.lengthSq() > 0) m.position.add(bone.offset);
        let dx = bx - ax, dy = by - ay, dz = bz - az;
        const len = Math.hypot(dx, dy, dz) || 1e-5;
        dx /= len; dy /= len; dz /= len;
        let rx = d.px[P.CHEST] - d.px[P.PELVIS];
        let ry = d.py[P.CHEST] - d.py[P.PELVIS];
        let rz = d.pz[P.CHEST] - d.pz[P.PELVIS];
        const rl = Math.hypot(rx, ry, rz) || 1;
        quatLookUp(dx, dy, dz, rx / rl, ry / rl, rz / rl, this._tmpQ);
        m.quaternion.copy(this._tmpQ);
        if (bone.scaleMesh) m.scale.set(1, len, 1);
      }
      if (d.root) d.root.position.set(d.px[P.PELVIS], d.py[P.PELVIS], d.pz[P.PELVIS]);
    }
  }

  /** Explosion coupling: corpses must be thrown by AoE like everything else. */
  applyRadialImpulse(cx, cy, cz, radius, strength, lift = 0.5) {
    let n = 0;
    for (let di = 0; di < this.capacity; di++) {
      const d = this.dolls[di];
      if (!d.active) continue;
      const dx = d.centre.x - cx, dy = d.centre.y - cy, dz = d.centre.z - cz;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      const s = strength * falloff * falloff;
      const inv = dist > EPS ? 1 / dist : 0;
      // Verlet impulse scale: `strength` is in impulse units (kg·m/s), and the
      // 0.0009 converts it to the positional offset a 78 kg body would take.
      // `impulseAll` subtracts from the PREVIOUS position, so positive arguments
      // push the body along +axis — i.e. away from the blast, as intended.
      const k = 0.0009;
      d.impulseAll(dx * inv * s * k, (dy * inv + lift) * s * k, dz * inv * s * k);
      n++;
    }
    return n;
  }

  /** Nearest active ragdoll to a point — `player` uses this to pick an extraction
   *  target for ARISE, and `loot` to place a drop on the corpse. */
  nearest(x, y, z, radius) {
    let best = null, bestD = radius * radius;
    for (let di = 0; di < this.capacity; di++) {
      const d = this.dolls[di];
      if (!d.active) continue;
      const dx = d.centre.x - x, dy = d.centre.y - y, dz = d.centre.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) { bestD = d2; best = d; }
    }
    return best;
  }

  stats() {
    return {
      active: this.activeCount,
      simulating: this.simulatingCount,
      capacity: this.capacity,
      particles: this.activeCount * NP,
      projections: this.counters.projections,
      landings: this.counters.landings,
    };
  }

  dispose() {
    this.clear();
    this.world = null;
    this.events = null;
  }
}

export { P as RAGDOLL_PARTICLES, BONES as RAGDOLL_BONES };
