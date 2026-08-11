/**
 * projectile.js — swept projectile integration.
 *
 * Every arrow, bone shard, thrown axe, shadow bolt and boss fireball goes through
 * here. `combat` spawns them and supplies an `onHit` callback; physics owns the
 * motion, the sweep, and the exact hit point / normal / surface that `fx` needs
 * to place an impact.
 *
 * The contract that makes this useful to other agents:
 *   - Motion is a proper ballistic integration (gravity, drag), not a straight
 *     line, so an arc reads as an arc.
 *   - Collision is a SWEPT sphere against the static BVH AND a swept capsule test
 *     against every actor, so nothing tunnels at any speed. A 60 m/s bolt covers
 *     1 m per fixed step; a raycast-per-step would already miss a 0.7 m enemy at
 *     an angle.
 *   - The hit record is complete: point, normal, surface name, actor (if any),
 *     distance travelled, and the incoming direction. Impact FX, decals, audio
 *     and damage falloff all read from one object.
 *   - Behaviour on impact is data, not code: `pierce`, `bounces`, and the return
 *     value of `onHit` ('stop' | 'pierce' | 'bounce') decide what happens next.
 */

import * as THREE from 'three';
import { makeHit, syncHit, rayCapsule, clamp } from './math.js';
import { MASK, surfaceProps, SURFACE } from './surfaces.js';

export class Projectile {
  constructor(id) {
    this.id = id;
    this.active = false;

    this.position = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    /** Spawn point, so `distance` and falloff are exact. */
    this.origin = new THREE.Vector3();

    this.radius = 0.06;
    this.gravityScale = 0;
    this.drag = 0;
    this.speedLimit = 200;

    this.age = 0;
    this.lifetime = 6;
    this.distance = 0;
    this.maxDistance = Infinity;

    this.mask = MASK.PROJECTILE;
    this.hitActors = true;
    /** Actors already struck — pierce must not damage the same target twice. */
    this.hitList = [];
    this.pierce = 0;
    this.bounces = 0;
    this.restitution = 0.45;

    this.owner = null;
    this.faction = null;
    this.element = 'physical';
    this.data = null;
    this.mesh = null;
    /** `combat` sets this; physics calls it with the shared hit record. */
    this.onHit = null;
    this.onExpire = null;

    /** Orientation, maintained along the velocity so `fx` can render a bolt. */
    this.quaternion = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._dir = new THREE.Vector3(0, 0, 1);
  }
}

export class ProjectileWorld {
  /**
   * @param {StaticWorld} staticWorld
   * @param {ActorHash} actors
   */
  constructor(staticWorld, actors, opts = {}) {
    this.world = staticWorld;
    this.actors = actors;
    this.gravity = opts.gravity ?? -18.6;
    this.capacity = opts.capacity ?? 192;
    this.events = opts.events ?? null;

    this.list = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.list[i] = new Projectile(i);
    this._free = [];
    for (let i = this.capacity - 1; i >= 0; i--) this._free.push(i);
    this.activeCount = 0;

    this._hit = makeHit();
    this._actorHit = makeHit();
    this._step = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._impactPayload = {
      position: new THREE.Vector3(), normal: new THREE.Vector3(),
      surface: 'stone', element: 'physical', magnitude: 1,
    };
    this.counters = { spawned: 0, staticHits: 0, actorHits: 0, expired: 0, steps: 0 };
  }

  /**
   * @param opts
   *   origin        Vector3
   *   direction     Vector3 (normalised internally) — OR pass `velocity` directly
   *   speed         m/s, used with `direction`
   *   velocity      Vector3, overrides direction/speed
   *   radius        collision radius, metres (0.06 default: an arrow shaft)
   *   gravityScale  0 = laser-straight bolt, 1 = thrown axe
   *   drag          per-second velocity loss fraction
   *   lifetime      seconds
   *   maxDistance   metres
   *   mask          static collision mask
   *   hitActors     default true
   *   ignore        actor to never hit (the caster)
   *   faction       actors of this faction are ignored (friendly fire off)
   *   pierce        how many actors it may pass through
   *   bounces       how many times it may ricochet off the world
   *   element       for the fx:impact payload
   *   mesh          Object3D driven by physics (position + orientation)
   *   onHit(hit, projectile) -> 'stop' | 'pierce' | 'bounce' | undefined
   *   onExpire(projectile)
   */
  spawn(opts = {}) {
    if (this._free.length === 0) {
      // Recycle the oldest — a horde of archers must never run out of arrows.
      let victim = -1, bestAge = -1;
      for (let i = 0; i < this.capacity; i++) {
        const p = this.list[i];
        if (p.active && p.age > bestAge) { bestAge = p.age; victim = i; }
      }
      if (victim < 0) return null;
      this._retire(this.list[victim], false);
    }
    const id = this._free.pop();
    const p = this.list[id];

    p.active = true;
    p.age = 0;
    p.distance = 0;
    p.hitList.length = 0;

    p.position.copy(opts.origin ?? this._tmp.set(0, 0, 0));
    p.prevPos.copy(p.position);
    p.origin.copy(p.position);

    if (opts.velocity) {
      p.velocity.copy(opts.velocity);
    } else {
      const d = opts.direction ?? this._tmp.set(0, 0, 1);
      p.velocity.copy(d).normalize().multiplyScalar(opts.speed ?? 30);
    }

    p.radius = opts.radius ?? 0.06;
    p.gravityScale = opts.gravityScale ?? 0;
    p.drag = opts.drag ?? 0;
    p.lifetime = opts.lifetime ?? 6;
    p.maxDistance = opts.maxDistance ?? Infinity;
    p.mask = opts.mask ?? MASK.PROJECTILE;
    p.hitActors = opts.hitActors !== false;
    p.pierce = opts.pierce ?? 0;
    p.bounces = opts.bounces ?? 0;
    p.restitution = opts.restitution ?? 0.45;
    p.owner = opts.owner ?? null;
    p.faction = opts.faction ?? null;
    p.element = opts.element ?? 'physical';
    p.data = opts.data ?? null;
    p.mesh = opts.mesh ?? null;
    p.onHit = opts.onHit ?? null;
    p.onExpire = opts.onExpire ?? null;
    if (opts.ignore) p.hitList.push(opts.ignore);

    this._orient(p);
    this.activeCount++;
    this.counters.spawned++;
    return p;
  }

  despawn(projectile) {
    return this._retire(projectile, false);
  }

  _retire(p, expired) {
    if (!p || !p.active) return false;
    if (expired && p.onExpire) p.onExpire(p);
    p.active = false;
    p.onHit = null;
    p.onExpire = null;
    p.mesh = null;
    p.data = null;
    p.owner = null;
    p.hitList.length = 0;
    this._free.push(p.id);
    this.activeCount--;
    return true;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) if (this.list[i].active) this._retire(this.list[i], false);
  }

  /* ---------------------------------------------------------------- */

  step(dt) {
    this.counters.steps++;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.list[i];
      if (!p.active) continue;

      p.age += dt;
      if (p.age >= p.lifetime) { this.counters.expired++; this._retire(p, true); continue; }

      // ---- integrate ----
      if (p.gravityScale !== 0) p.velocity.y += this.gravity * p.gravityScale * dt;
      if (p.drag > 0) p.velocity.multiplyScalar(Math.max(0, 1 - p.drag * dt));

      let speed = p.velocity.length();
      if (speed > p.speedLimit) { p.velocity.multiplyScalar(p.speedLimit / speed); speed = p.speedLimit; }
      if (speed < 1e-5) { this._retire(p, true); continue; }

      p.prevPos.copy(p.position);
      let remaining = speed * dt;

      // A bounce inside one step must continue with the reflected velocity, so
      // the whole step is a loop rather than a single sweep.
      let guard = 0;
      while (remaining > 1e-6 && guard++ < 4 && p.active) {
        const inv = 1 / (p.velocity.length() || 1);
        const dx = p.velocity.x * inv, dy = p.velocity.y * inv, dz = p.velocity.z * inv;

        // --- actors first: a bolt that grazes a wall behind an enemy must still
        //     credit the enemy, and the actor test is far cheaper than the BVH.
        let actorT = Infinity, actorHit = null;
        if (p.hitActors) actorT = this._sweepActors(p, dx, dy, dz, remaining);
        if (actorT !== Infinity) actorHit = this._lastActor;

        // --- static world ---
        let staticT = Infinity;
        if (this.world && this.world.triCount > 0 &&
            this.world.sweepSphere(p.position.x, p.position.y, p.position.z, p.radius,
              dx, dy, dz, remaining, p.mask, this._hit)) {
          staticT = this._hit.t;
        }

        if (actorT === Infinity && staticT === Infinity) {
          p.position.x += dx * remaining;
          p.position.y += dy * remaining;
          p.position.z += dz * remaining;
          p.distance += remaining;
          remaining = 0;
          break;
        }

        if (actorT <= staticT) {
          // ---- actor impact ----
          p.position.x += dx * actorT;
          p.position.y += dy * actorT;
          p.position.z += dz * actorT;
          p.distance += actorT;
          remaining -= actorT;
          this.counters.actorHits++;

          const h = this._actorHit;
          h.hit = true;
          h.t = p.distance;
          h.px = p.position.x; h.py = p.position.y; h.pz = p.position.z;
          // Normal points back along the flight path, offset by the actor's
          // surface direction so blood sprays outward from the wound.
          const ax = p.position.x - actorHit.position.x;
          const az = p.position.z - actorHit.position.z;
          const al = Math.hypot(ax, az) || 1;
          h.nx = (ax / al) * 0.7 - dx * 0.3;
          h.ny = -dy * 0.3 + 0.2;
          h.nz = (az / al) * 0.7 - dz * 0.3;
          const nl = Math.hypot(h.nx, h.ny, h.nz) || 1;
          h.nx /= nl; h.ny /= nl; h.nz /= nl;
          h.surfaceId = SURFACE.flesh;
          h.surface = 'flesh';
          h.kind = 'actor';
          h.actor = actorHit;
          h.layer = 0;
          h.object = -1;
          h.mesh = actorHit.root ?? null;
          syncHit(h);

          p.hitList.push(actorHit);
          const verdict = p.onHit ? p.onHit(h, p) : undefined;
          this._emitImpact(h, p);

          if (verdict === 'pierce' || (verdict === undefined && p.pierce > 0)) {
            if (p.pierce > 0) p.pierce--;
            // Nudge past the target so the next sweep does not immediately
            // re-enter it.
            const skip = actorHit.radius * 2 + p.radius;
            const adv = Math.min(skip, remaining);
            p.position.x += dx * adv; p.position.y += dy * adv; p.position.z += dz * adv;
            p.distance += adv;
            remaining -= adv;
            continue;
          }
          this._retire(p, false);
          break;
        }

        // ---- static impact ----
        const advance = Math.max(0, staticT - 0.002);
        p.position.x += dx * advance;
        p.position.y += dy * advance;
        p.position.z += dz * advance;
        p.distance += advance;
        remaining -= advance;
        this.counters.staticHits++;

        const h = this._hit;
        h.t = p.distance;
        h.px = p.position.x + dx * 0.002;
        h.py = p.position.y + dy * 0.002;
        h.pz = p.position.z + dz * 0.002;
        h.actor = null;
        syncHit(h);

        const verdict = p.onHit ? p.onHit(h, p) : undefined;
        this._emitImpact(h, p);

        if (verdict === 'bounce' || (verdict === undefined && p.bounces > 0)) {
          if (p.bounces > 0) p.bounces--;
          const sp = surfaceProps(h.surfaceId);
          const rest = p.restitution * (0.4 + sp.restitution);
          // Reflect and lose energy; tangential friction keeps a ricochet from
          // looking like a mirror bounce.
          const vn = p.velocity.x * h.nx + p.velocity.y * h.ny + p.velocity.z * h.nz;
          p.velocity.x -= h.nx * vn * (1 + rest);
          p.velocity.y -= h.ny * vn * (1 + rest);
          p.velocity.z -= h.nz * vn * (1 + rest);
          p.velocity.multiplyScalar(0.82);
          remaining *= 0.6;
          if (p.velocity.lengthSq() < 1) { this._retire(p, true); break; }
          continue;
        }
        this._retire(p, false);
        break;
      }

      if (!p.active) continue;
      if (p.distance >= p.maxDistance) { this.counters.expired++; this._retire(p, true); continue; }
      this._orient(p);
      if (p.mesh) {
        p.mesh.position.copy(p.position);
        p.mesh.quaternion.copy(p.quaternion);
      }
    }
  }

  /**
   * Swept sphere-vs-actor-capsules along the step. Returns the distance to the
   * first actor hit or Infinity; the actor lands in `this._lastActor`.
   *
   * Implemented as a ray against each actor capsule inflated by the projectile
   * radius — the exact Minkowski reduction, and it costs one `rayCapsule` per
   * candidate rather than a full capsule/capsule sweep.
   */
  _sweepActors(p, dx, dy, dz, dist) {
    const hash = this.actors;
    if (!hash) return Infinity;
    // Query a capsule covering the whole step, then do the exact ray test on the
    // handful of candidates that returns.
    const res = hash.queryCapsule(
      p.position.x, p.position.y, p.position.z,
      p.position.x + dx * dist, p.position.y + dy * dist, p.position.z + dz * dist,
      p.radius, null, hash.scratch(), false
    );
    let best = Infinity;
    let bestActor = null;
    for (let i = 0; i < res.count; i++) {
      const a = res.actors[i];
      if (a === p.owner) continue;
      if (p.faction && a.faction === p.faction) continue;
      if (a.alive === false) continue;
      let already = false;
      for (let k = 0; k < p.hitList.length; k++) if (p.hitList[k] === a) { already = true; break; }
      if (already) continue;

      const ar = a.radius ?? 0.4;
      const ah = a.height ?? 1.8;
      const y0 = a.position.y + ar;
      const y1 = a.position.y + Math.max(ar, ah - ar);
      const t = rayCapsule(
        p.position.x, p.position.y, p.position.z, dx, dy, dz,
        a.position.x, y0, a.position.z,
        a.position.x, y1, a.position.z,
        ar + p.radius, dist
      );
      if (t >= 0 && t < best) { best = t; bestActor = a; }
    }
    this._lastActor = bestActor;
    return bestActor ? best : Infinity;
  }

  _emitImpact(h, p) {
    if (!this.events) return;
    const pay = this._impactPayload;
    pay.position.copy(h.point);
    pay.normal.copy(h.normal);
    pay.surface = h.surface;
    pay.element = p.element;
    // Magnitude scales with kinetic energy, normalised so a standard arrow reads
    // as ~1 and a boss's boulder reads as ~3.
    const sp = p.velocity.length();
    pay.magnitude = clamp((sp * sp * p.radius) / 12, 0.25, 4);
    this.events.emit('fx:impact', pay);
  }

  /** Keep the projectile's mesh pointed along its flight. */
  _orient(p) {
    const v = p.velocity;
    const l = v.length();
    if (l < 1e-5) return;
    // Both scratch vectors belong to the projectile itself, so a burst of 40
    // arrows in one frame still allocates nothing.
    p._dir.set(v.x / l, v.y / l, v.z / l);
    // setFromUnitVectors handles the antiparallel case; local +Z is the nose.
    p.quaternion.setFromUnitVectors(p._up.set(0, 0, 1), p._dir);
  }

  stats() {
    return {
      active: this.activeCount,
      capacity: this.capacity,
      spawned: this.counters.spawned,
      staticHits: this.counters.staticHits,
      actorHits: this.counters.actorHits,
      expired: this.counters.expired,
    };
  }

  dispose() {
    this.clear();
    this.world = null;
    this.actors = null;
    this.events = null;
  }
}
