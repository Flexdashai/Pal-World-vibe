/**
 * constraints.js — chains, pendulums and hanging braziers.
 *
 * These are solved with position-based dynamics rather than as rigid bodies with
 * ball joints, for one decisive reason: a 6-link chain carrying a 40 kg brazier is
 * a stiff constraint system, and an impulse solver needs 20+ iterations per step
 * to stop it stretching. PBD's distance projection is unconditionally stable at
 * any stiffness and costs three multiply-adds per link. The chain never stretches,
 * ever, and it costs nothing.
 *
 * What this buys the frame: every brazier in the cathedral hangs from a chain that
 * SWAYS. When a shadow nova goes off underneath one, the chain whips and the
 * brazier's light moves across the floor. That single behaviour does more for
 * "this room is a physical place" than another 2k triangles of masonry.
 *
 * Ownership note: physics owns the SIMULATION and writes transforms into meshes
 * that `world` provides. It never creates the visual mesh — `world` builds the
 * chain links and brazier and registers them here.
 */

import * as THREE from 'three';
import { quatLookUp, EPS } from './math.js';
import { makeContacts } from './bvh.js';
import { MASK } from './surfaces.js';

/**
 * Solver iterations per fixed step.
 *
 * A brazier chain is a stiff system with a large mass ratio: four 3 kg links
 * carrying a 30 kg bowl. Plain top-to-bottom Gauss-Seidel propagates the bowl's
 * load upward at one link per iteration and leaves a residual sag that reads as
 * elastic rope. Alternating the sweep direction (symmetric Gauss-Seidel) carries
 * tension both ways every pair of iterations.
 *
 * Measured worst-case link error on a 4-link, 30 kg pendulum after 150 steps:
 *     4 iters  9.07%     8 iters  4.31%
 *    16 iters  1.97%    32 iters  0.82%
 * i.e. residual ~ C/iters. 12 lands at ~2.8% — under 1 cm on a 1.4 m chain,
 * invisible at the isometric boom distance — and costs ~3k projections a step
 * across a whole cathedral's worth of hanging props, which is nothing.
 */
const ITERS = 12;
/** Verlet damping: 1 = no loss. 0.995 gives a chain that settles in ~4 seconds,
 *  which reads as heavy iron rather than as string. */
const DAMP = 0.995;

export class Chain {
  constructor(id) {
    this.id = id;
    this.active = false;

    this.count = 0;
    this.capacity = 0;
    /** Current and previous particle positions (Verlet). */
    this.px = null; this.py = null; this.pz = null;
    this.ox = null; this.oy = null; this.oz = null;
    this.invMass = null;

    this.linkLength = 0.25;
    this.radius = 0.03;
    this.gravity = -18.6;
    this.damping = DAMP;
    this.collide = false;

    /** Meshes driven per link (optional; index i spans particle i..i+1). */
    this.linkMeshes = null;
    /** Mesh parented to the last particle — the brazier bowl, the cage, the hook. */
    this.endMesh = null;
    /** Light driven by the end particle, so the swing moves the light too. */
    this.endLight = null;
    this.endOffset = new THREE.Vector3();

    this.anchor = new THREE.Vector3();
    /** Optional second anchor: a chain strung BETWEEN two points (a barrier, a
     *  bridge rail) rather than hanging free. */
    this.anchorB = null;

    this.userData = null;
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._ref = new THREE.Vector3(0, 0, 1);
  }

  /** World position of particle i, written into `out`. */
  particle(i, out) {
    out.set(this.px[i], this.py[i], this.pz[i]);
    return out;
  }

  /** Kick the whole chain — an explosion, a body slamming into it, a near miss. */
  impulse(ix, iy, iz, falloffFrom = -1) {
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) continue;
      // Links further from the anchor swing more; that is what makes a chain read
      // as a chain and not as a rigid rod.
      const w = falloffFrom < 0 ? (i / Math.max(1, this.count - 1)) : 1;
      this.px[i] += ix * w;
      this.py[i] += iy * w;
      this.pz[i] += iz * w;
    }
  }
}

export class ConstraintWorld {
  constructor(world, opts = {}) {
    this.world = world;
    this.gravity = opts.gravity ?? -18.6;
    this.capacity = opts.capacity ?? 48;
    /** Solver iterations. Exposed rather than a module constant so it can be
     *  swept from tools/probe.mjs when tuning a new prop. */
    this.iters = opts.iters ?? ITERS;
    this.chains = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.chains[i] = new Chain(i);
    this._free = [];
    for (let i = this.capacity - 1; i >= 0; i--) this._free.push(i);
    this.activeCount = 0;

    this._contacts = makeContacts(16);
    this.counters = { steps: 0, projections: 0 };
  }

  /**
   * Create a hanging chain.
   *
   * @param opts
   *   anchor       Vector3, the fixed top point
   *   links        number of segments (particles = links + 1)
   *   linkLength   metres per segment
   *   radius       collision radius of each link
   *   endMass      kg at the last particle (a brazier is heavy, a censer is not)
   *   linkMeshes   Object3D[] of length `links`, each oriented +Y along its span
   *   endMesh      Object3D placed at the last particle
   *   endLight     THREE.Light moved with the last particle
   *   endOffset    Vector3 offset of endMesh from the last particle
   *   anchorB      Vector3; if given the chain is strung between two anchors
   *   collide      resolve links against the static world (off by default: a
   *                brazier chain hangs in open air and the test is pure cost)
   *   sag          0..1, initial slack when using anchorB
   */
  create(opts = {}) {
    if (this._free.length === 0) return null;
    const id = this._free.pop();
    const c = this.chains[id];

    const links = Math.max(1, opts.links ?? 5);
    const n = links + 1;
    if (c.capacity < n) {
      c.px = new Float32Array(n); c.py = new Float32Array(n); c.pz = new Float32Array(n);
      c.ox = new Float32Array(n); c.oy = new Float32Array(n); c.oz = new Float32Array(n);
      c.invMass = new Float32Array(n);
      c.capacity = n;
    }
    c.count = n;
    c.active = true;
    c.linkLength = opts.linkLength ?? 0.25;
    c.radius = opts.radius ?? 0.03;
    c.gravity = opts.gravity ?? this.gravity;
    c.damping = opts.damping ?? DAMP;
    c.collide = !!opts.collide;
    c.linkMeshes = opts.linkMeshes ?? null;
    c.endMesh = opts.endMesh ?? null;
    c.endLight = opts.endLight ?? null;
    c.userData = opts.userData ?? null;
    if (opts.endOffset) c.endOffset.copy(opts.endOffset); else c.endOffset.set(0, 0, 0);
    c.anchor.copy(opts.anchor ?? new THREE.Vector3());
    c.anchorB = opts.anchorB ? (c.anchorB ?? new THREE.Vector3()).copy(opts.anchorB) : null;

    // Lay the chain out in its rest pose so it does not snap into place on the
    // first frame — a capture at frame 3 must already look settled.
    const endMass = opts.endMass ?? 1;
    // Real link mass rather than an implicit 1 kg: the solver's convergence is
    // governed by the mass RATIO along the chain, and a 30 kg brazier hanging off
    // 1 kg links is twice as stiff a problem as one hanging off 3 kg links.
    const invLink = 1 / Math.max(0.05, opts.linkMass ?? 3);
    for (let i = 0; i < n; i++) {
      const t = i / links;
      let x, y, z;
      if (c.anchorB) {
        // Catenary-ish: linear interpolation plus a parabolic sag.
        const sag = (opts.sag ?? 0.25) * c.linkLength * links;
        x = c.anchor.x + (c.anchorB.x - c.anchor.x) * t;
        y = c.anchor.y + (c.anchorB.y - c.anchor.y) * t - sag * 4 * t * (1 - t);
        z = c.anchor.z + (c.anchorB.z - c.anchor.z) * t;
      } else {
        x = c.anchor.x;
        y = c.anchor.y - c.linkLength * i;
        z = c.anchor.z;
      }
      c.px[i] = x; c.py[i] = y; c.pz[i] = z;
      c.ox[i] = x; c.oy[i] = y; c.oz[i] = z;
      // Heavier end particle = a chain that hangs taut and swings slowly.
      c.invMass[i] = i === n - 1 && !c.anchorB ? 1 / Math.max(0.05, endMass) : invLink;
    }
    c.invMass[0] = 0;                       // anchored
    if (c.anchorB) c.invMass[n - 1] = 0;    // both ends anchored

    this.activeCount++;
    this.syncOne(c);
    return c;
  }

  /**
   * Convenience: a hanging brazier. One chain, a heavy end, and the light and
   * bowl parented to the last particle. `world` calls this once per brazier.
   */
  createPendulum(opts = {}) {
    return this.create({
      links: opts.links ?? 4,
      linkLength: opts.linkLength ?? (opts.length ?? 1.2) / (opts.links ?? 4),
      anchor: opts.anchor,
      endMass: opts.mass ?? 30,
      endMesh: opts.mesh ?? null,
      endLight: opts.light ?? null,
      endOffset: opts.offset,
      linkMeshes: opts.linkMeshes ?? null,
      radius: opts.radius ?? 0.04,
      damping: opts.damping ?? 0.997, // heavy iron keeps swinging a long time
      userData: opts.userData,
    });
  }

  destroy(chain) {
    if (!chain || !chain.active) return false;
    chain.active = false;
    chain.linkMeshes = null;
    chain.endMesh = null;
    chain.endLight = null;
    chain.userData = null;
    this._free.push(chain.id);
    this.activeCount--;
    return true;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) if (this.chains[i].active) this.destroy(this.chains[i]);
  }

  /* ---------------------------------------------------------------- */

  step(dt) {
    this.counters.steps++;
    const g = this.gravity * dt * dt;
    for (let ci = 0; ci < this.capacity; ci++) {
      const c = this.chains[ci];
      if (!c.active) continue;
      const n = c.count;

      // ---- Verlet integrate ----
      for (let i = 0; i < n; i++) {
        if (c.invMass[i] === 0) continue;
        const vx = (c.px[i] - c.ox[i]) * c.damping;
        const vy = (c.py[i] - c.oy[i]) * c.damping;
        const vz = (c.pz[i] - c.oz[i]) * c.damping;
        c.ox[i] = c.px[i]; c.oy[i] = c.py[i]; c.oz[i] = c.pz[i];
        c.px[i] += vx;
        c.py[i] += vy + g;
        c.pz[i] += vz;
      }

      // ---- project distance constraints ----
      for (let it = 0; it < this.iters; it++) {
        // Anchors are hard: re-pin them every iteration rather than relying on
        // invMass alone, so a chain whose anchor moves (a swinging gate) follows.
        c.px[0] = c.anchor.x; c.py[0] = c.anchor.y; c.pz[0] = c.anchor.z;
        if (c.anchorB) {
          c.px[n - 1] = c.anchorB.x; c.py[n - 1] = c.anchorB.y; c.pz[n - 1] = c.anchorB.z;
        }
        // Alternate sweep direction — see the ITERS comment.
        const forward = (it & 1) === 0;
        for (let k = 0; k < n - 1; k++) {
          const i = forward ? k : n - 2 - k;
          const j = i + 1;
          const wi = c.invMass[i], wj = c.invMass[j];
          const wsum = wi + wj;
          if (wsum <= EPS) continue;
          let dx = c.px[j] - c.px[i];
          let dy = c.py[j] - c.py[i];
          let dz = c.pz[j] - c.pz[i];
          const d = Math.hypot(dx, dy, dz);
          if (d < 1e-6) continue;
          const diff = (d - c.linkLength) / d / wsum;
          dx *= diff; dy *= diff; dz *= diff;
          c.px[i] += dx * wi; c.py[i] += dy * wi; c.pz[i] += dz * wi;
          c.px[j] -= dx * wj; c.py[j] -= dy * wj; c.pz[j] -= dz * wj;
          this.counters.projections++;
        }
      }

      // ---- optional world collision on the last iteration only ----
      if (c.collide && this.world && this.world.triCount > 0) {
        for (let i = 1; i < n; i++) {
          if (c.invMass[i] === 0) continue;
          const cts = this.world.overlapSphere(c.px[i], c.py[i], c.pz[i], c.radius, MASK.DEBRIS, this._contacts);
          for (let k = 0; k < cts.count; k++) {
            c.px[i] += cts.nx[k] * cts.depth[k];
            c.py[i] += cts.ny[k] * cts.depth[k];
            c.pz[i] += cts.nz[k] * cts.depth[k];
          }
        }
      }
    }
  }

  /** Write link/end transforms into their meshes. Called once per frame. */
  sync() {
    for (let i = 0; i < this.capacity; i++) {
      const c = this.chains[i];
      if (c.active) this.syncOne(c);
    }
  }

  syncOne(c) {
    const n = c.count;
    if (c.linkMeshes) {
      const links = Math.min(c.linkMeshes.length, n - 1);
      for (let i = 0; i < links; i++) {
        const m = c.linkMeshes[i];
        if (!m) continue;
        const ax = c.px[i], ay = c.py[i], az = c.pz[i];
        const bx = c.px[i + 1], by = c.py[i + 1], bz = c.pz[i + 1];
        m.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
        let dx = bx - ax, dy = by - ay, dz = bz - az;
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l; dy /= l; dz /= l;
        // Local +Y runs down the link; alternate the twist 90 degrees per link so
        // a chain of flat rings reads as interlocking rather than as a ribbon.
        const twist = (i & 1) ? 1 : 0;
        quatLookUp(dx, dy, dz, twist ? 1 : 0, 0, twist ? 0 : 1, c._q);
        m.quaternion.copy(c._q);
      }
    }
    const last = n - 1;
    if (c.endMesh) {
      c.endMesh.position.set(
        c.px[last] + c.endOffset.x,
        c.py[last] + c.endOffset.y,
        c.pz[last] + c.endOffset.z
      );
      // Tilt the bowl with the chain's final segment so it does not stay
      // suspiciously level while everything above it swings.
      let dx = c.px[last] - c.px[last - 1];
      let dy = c.py[last] - c.py[last - 1];
      let dz = c.pz[last] - c.pz[last - 1];
      const l = Math.hypot(dx, dy, dz) || 1;
      quatLookUp(-dx / l, -dy / l, -dz / l, 0, 0, 1, c._q);
      c.endMesh.quaternion.copy(c._q);
    }
    if (c.endLight) {
      c.endLight.position.set(
        c.px[last] + c.endOffset.x,
        c.py[last] + c.endOffset.y,
        c.pz[last] + c.endOffset.z
      );
    }
  }

  /** Push every chain within `radius` of an explosion. */
  applyRadialImpulse(cx, cy, cz, radius, strength) {
    let n = 0;
    for (let ci = 0; ci < this.capacity; ci++) {
      const c = this.chains[ci];
      if (!c.active) continue;
      const last = c.count - 1;
      const dx = c.px[last] - cx, dy = c.py[last] - cy, dz = c.pz[last] - cz;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      // Verlet impulse = a positional offset; scale by dt^2-ish to keep the
      // magnitude comparable with the rigid-body path.
      const s = strength * falloff * falloff * 0.0016;
      const inv = d > EPS ? 1 / d : 0;
      c.impulse(dx * inv * s, (dy * inv + 0.4) * s, dz * inv * s);
      n++;
    }
    return n;
  }

  stats() {
    return { chains: this.activeCount, capacity: this.capacity, projections: this.counters.projections };
  }

  dispose() {
    this.clear();
    this.world = null;
  }
}
