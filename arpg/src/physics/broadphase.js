/**
 * broadphase.js — uniform spatial hash over actors, and the queries combat runs
 * every time a skill lands.
 *
 * An ARPG has 60+ actors on screen. Three things must be true of them:
 *   1. they must not interpenetrate — a pile of overlapping skeletons reads as a
 *      rendering bug, not as a horde;
 *   2. they must be queryable by radius, cone and capsule at *skill-cast rate*,
 *      which during a nova is dozens of queries in one frame;
 *   3. neither of those may allocate.
 *
 * Implementation is a hashed uniform grid over XZ (actors live on the floor, so a
 * 2D grid with an exact 3D distance test is strictly better than a 3D grid whose
 * Y layer is always 1 deep). Each fixed step we counting-sort every proxy into
 * buckets — for 120 actors that is a few microseconds and it removes every
 * incremental-update bug class (stale cells, double insertion, dangling handles).
 *
 * Hash collisions are allowed and harmless: two distant cells sharing a bucket
 * only costs a few extra exact distance tests, which we were going to do anyway.
 */

import { EPS, clamp } from './math.js';
import { LAYER } from './surfaces.js';

/** Default grid cell. ~2x a typical actor diameter, so a radius query for a
 *  melee cleave (2.5 m) touches a 3x3 block and not a 7x7 one. */
export const DEFAULT_CELL = 1.6;

/**
 * A query result. REUSED unless you create your own — call
 * `physics.createQueryResult()` and pass it as `out` for anything you keep past
 * the current statement.
 */
export function makeQueryResult(capacity = 128) {
  return {
    count: 0,
    capacity,
    /** Actor references, valid for indices [0, count). */
    actors: new Array(capacity).fill(null),
    /** Distance from the query origin to the actor's centre, metres. */
    dist: new Float32Array(capacity),
    /** Unit direction from origin to actor, flattened onto XZ. Knockback uses it. */
    dirX: new Float32Array(capacity),
    dirZ: new Float32Array(capacity),
    /** True if the query volume reached the actor's surface, not just its centre. */
    grazed: new Uint8Array(capacity),
  };
}

function pushResult(out, actor, dist, dx, dz, grazed) {
  const i = out.count;
  if (i >= out.capacity) return false;
  out.actors[i] = actor;
  out.dist[i] = dist;
  out.dirX[i] = dx;
  out.dirZ[i] = dz;
  out.grazed[i] = grazed ? 1 : 0;
  out.count = i + 1;
  return true;
}

/** Sort a result in place by ascending distance — insertion sort, N is tiny. */
export function sortByDistance(out) {
  for (let i = 1; i < out.count; i++) {
    const a = out.actors[i], d = out.dist[i], dx = out.dirX[i], dz = out.dirZ[i], g = out.grazed[i];
    let j = i - 1;
    while (j >= 0 && out.dist[j] > d) {
      out.actors[j + 1] = out.actors[j];
      out.dist[j + 1] = out.dist[j];
      out.dirX[j + 1] = out.dirX[j];
      out.dirZ[j + 1] = out.dirZ[j];
      out.grazed[j + 1] = out.grazed[j];
      j--;
    }
    out.actors[j + 1] = a;
    out.dist[j + 1] = d;
    out.dirX[j + 1] = dx;
    out.dirZ[j + 1] = dz;
    out.grazed[j + 1] = g;
  }
  return out;
}

export class ActorHash {
  /**
   * @param {number} capacity  max simultaneous proxies (config.q.maxActors + slack)
   * @param {number} cell      grid cell size in metres
   */
  constructor(capacity = 192, cell = DEFAULT_CELL) {
    this.cell = cell;
    this.invCell = 1 / cell;
    this.capacity = capacity;

    /** Dense proxy arrays. `slot` is a stable index handed back to the caller. */
    this.count = 0;
    this.actors = new Array(capacity).fill(null);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.height = new Float32Array(capacity);
    /** Separation weight. 0 = immovable (a boss anchor), higher = harder to shove. */
    this.weight = new Float32Array(capacity);
    /** LAYER bit — PLAYER or ACTOR. Lets a query cheaply exclude the player. */
    this.layer = new Uint16Array(capacity);
    /** 1 while the actor is alive and should be considered by gameplay queries. */
    this.live = new Uint8Array(capacity);
    /** 1 if this proxy participates in actor-vs-actor separation. */
    this.solid = new Uint8Array(capacity);
    /** Integer cell coordinates, refreshed on rebuild. */
    this.cx = new Int32Array(capacity);
    this.cz = new Int32Array(capacity);

    this._slotOf = new Map(); // actor -> slot
    this._free = [];

    // Hash table: power-of-two bucket count, counting-sorted membership.
    let bits = 1;
    while ((1 << bits) < capacity * 2) bits++;
    this.tableSize = 1 << (bits + 1);
    this.tableMask = this.tableSize - 1;
    this.bucketStart = new Int32Array(this.tableSize + 1);
    this.bucketCount = new Int32Array(this.tableSize);
    this.sorted = new Int32Array(capacity);
    this._cellKey = new Int32Array(capacity);

    /** Visited stamp so a proxy in several scanned cells is only tested once. */
    this._stamp = new Int32Array(capacity);
    this._stampTick = 0;
    /** Largest live actor radius; refreshed by rebuild(). */
    this._maxR = 0;

    this.counters = { queries: 0, cellsScanned: 0, pairTests: 0, separations: 0 };
    this._tmpResult = [
      makeQueryResult(capacity), makeQueryResult(capacity),
      makeQueryResult(capacity), makeQueryResult(capacity),
    ];
    this._tmpIdx = 0;
  }

  /** A rotating scratch result, so a query nested inside iteration of another
   *  query's result does not stomp it. Four deep is more than gameplay needs. */
  scratch() {
    const r = this._tmpResult[this._tmpIdx];
    this._tmpIdx = (this._tmpIdx + 1) & 3;
    r.count = 0;
    return r;
  }

  /* ---------------------------------------------------------------- */
  /* Registration                                                      */
  /* ---------------------------------------------------------------- */

  add(actor, opts = {}) {
    if (this._slotOf.has(actor)) return this._slotOf.get(actor);
    let slot;
    if (this._free.length) slot = this._free.pop();
    else if (this.count < this.capacity) slot = this.count++;
    else return -1; // budget exhausted; caller decides whether that is fatal

    this.actors[slot] = actor;
    this.radius[slot] = opts.radius ?? actor.radius ?? 0.4;
    this.height[slot] = opts.height ?? actor.height ?? 1.8;
    this.weight[slot] = opts.weight ?? (actor.isPlayer ? 3.0 : 1.0);
    this.layer[slot] = opts.layer ?? (actor.isPlayer ? LAYER.PLAYER : LAYER.ACTOR);
    this.live[slot] = actor.alive === false ? 0 : 1;
    this.solid[slot] = opts.solid === false ? 0 : 1;
    const p = actor.position;
    this.px[slot] = p?.x ?? 0; this.py[slot] = p?.y ?? 0; this.pz[slot] = p?.z ?? 0;
    this._slotOf.set(actor, slot);
    return slot;
  }

  remove(actor) {
    const slot = this._slotOf.get(actor);
    if (slot === undefined) return false;
    this.actors[slot] = null;
    this.live[slot] = 0;
    this.solid[slot] = 0;
    this._slotOf.delete(actor);
    this._free.push(slot);
    return true;
  }

  slotOf(actor) {
    const s = this._slotOf.get(actor);
    return s === undefined ? -1 : s;
  }

  has(actor) {
    return this._slotOf.has(actor);
  }

  /** Per-actor tuning after registration (a boss growing, a corpse going soft). */
  configure(actor, opts) {
    const slot = this._slotOf.get(actor);
    if (slot === undefined) return false;
    if (opts.radius !== undefined) this.radius[slot] = opts.radius;
    if (opts.height !== undefined) this.height[slot] = opts.height;
    if (opts.weight !== undefined) this.weight[slot] = opts.weight;
    if (opts.solid !== undefined) this.solid[slot] = opts.solid ? 1 : 0;
    if (opts.layer !== undefined) this.layer[slot] = opts.layer;
    return true;
  }

  get liveCount() {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.actors[i] && this.live[i]) n++;
    return n;
  }

  /* ---------------------------------------------------------------- */
  /* Rebuild                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Pull fresh transforms off the actors and rebuild the buckets.
   * Called once per fixed step, before anything queries.
   */
  rebuild() {
    const n = this.count;
    this.bucketCount.fill(0);
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const a = this.actors[i];
      if (!a) { this._cellKey[i] = -1; continue; }
      const p = a.position;
      if (p) { this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z; }
      // Radius/height are re-read every step so a boss that grows mid-fight, or
      // an actor whose capsule shrinks while crouching, stays correct without an
      // explicit call from ai.
      if (a.radius !== undefined) this.radius[i] = a.radius;
      if (a.height !== undefined) this.height[i] = a.height;
      this.live[i] = a.alive === false ? 0 : 1;
      if (this.radius[i] > maxR) maxR = this.radius[i];

      const cx = Math.floor(this.px[i] * this.invCell);
      const cz = Math.floor(this.pz[i] * this.invCell);
      this.cx[i] = cx; this.cz[i] = cz;
      const key = hashCell(cx, cz) & this.tableMask;
      this._cellKey[i] = key;
      this.bucketCount[key]++;
    }
    this._maxR = maxR;
    // Prefix sum -> bucket starts.
    let acc = 0;
    for (let b = 0; b < this.tableSize; b++) {
      this.bucketStart[b] = acc;
      acc += this.bucketCount[b];
      this.bucketCount[b] = 0; // reused as a write cursor
    }
    this.bucketStart[this.tableSize] = acc;
    for (let i = 0; i < n; i++) {
      const key = this._cellKey[i];
      if (key < 0) continue;
      this.sorted[this.bucketStart[key] + this.bucketCount[key]++] = i;
    }
    return this;
  }

  /* ---------------------------------------------------------------- */
  /* Filtering                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * A filter is either a predicate `(actor) => boolean` or an options object:
   *   { faction, notFaction, exclude, excludeActor, includeDead, includePlayer,
   *     onlyPlayer, isShadow, layer, test }
   *
   * `includePlayer` defaults to TRUE — an enemy AoE must be able to hit you.
   * `includeDead` defaults to false, because 90% of callers are damage queries.
   */
  _accept(slot, filter) {
    const a = this.actors[slot];
    if (!a) return false;
    if (!filter) return this.live[slot] === 1;
    if (typeof filter === 'function') return filter(a);

    if (!filter.includeDead && this.live[slot] !== 1) return false;
    if (filter.onlyPlayer && !a.isPlayer) return false;
    if (filter.includePlayer === false && a.isPlayer) return false;
    if (filter.faction !== undefined && a.faction !== filter.faction) return false;
    if (filter.notFaction !== undefined && a.faction === filter.notFaction) return false;
    if (filter.isShadow !== undefined && !!a.isShadow !== filter.isShadow) return false;
    if (filter.exclude !== undefined && a === filter.exclude) return false;
    if (filter.excludeActor !== undefined && a === filter.excludeActor) return false;
    if (filter.layer !== undefined && (this.layer[slot] & filter.layer) === 0) return false;
    if (filter.test !== undefined && !filter.test(a)) return false;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Everything whose CAPSULE intersects a sphere of `radius` about (x,y,z).
   *
   * Testing against the capsule rather than the centre point is the difference
   * between an AoE that "feels like it should have hit" and one that does: a
   * 0.6 m-wide ogre standing 2.9 m from the centre of a 2.5 m nova is inside it
   * by 20 cm and must take damage.
   *
   * `y` may be NaN/undefined to make the query purely planar (the usual case for
   * a ground-targeted AoE); pass a real y for a spherical blast.
   */
  queryRadius(x, y, z, radius, filter, out = this.scratch(), flat = true) {
    this.counters.queries++;
    out.count = 0;
    const reach = radius + this._maxRadius();
    const cr = Math.ceil(reach * this.invCell);
    const c0x = Math.floor(x * this.invCell), c0z = Math.floor(z * this.invCell);
    const tick = ++this._stampTick;

    for (let gz = c0z - cr; gz <= c0z + cr; gz++) {
      for (let gx = c0x - cr; gx <= c0x + cr; gx++) {
        const key = hashCell(gx, gz) & this.tableMask;
        const s = this.bucketStart[key], e = this.bucketStart[key + 1];
        this.counters.cellsScanned++;
        for (let k = s; k < e; k++) {
          const slot = this.sorted[k];
          if (this._stamp[slot] === tick) continue;      // hash collision or wide actor
          if (this.cx[slot] !== gx || this.cz[slot] !== gz) continue; // bucket collision
          this._stamp[slot] = tick;
          this.counters.pairTests++;
          if (!this._accept(slot, filter)) continue;

          const ar = this.radius[slot];
          let dx = this.px[slot] - x;
          let dz = this.pz[slot] - z;
          let dy = 0;
          if (!flat) {
            // Distance to the actor's capsule axis segment (feet .. head).
            const y0 = this.py[slot] + ar;
            const y1 = this.py[slot] + Math.max(ar, this.height[slot] - ar);
            const cy = clamp(y, y0, y1);
            dy = cy - y;
          }
          const d2 = dx * dx + dy * dy + dz * dz;
          const reach2 = (radius + ar) * (radius + ar);
          if (d2 > reach2) continue;
          const d = Math.sqrt(d2);
          const inv = d > EPS ? 1 / d : 0;
          if (!pushResult(out, this.actors[slot], d, dx * inv, dz * inv, d > radius)) break;
        }
      }
    }
    return out;
  }

  /**
   * Cone query. `dir` need not be normalised. `halfAngle` in radians.
   *
   * The angular test is widened by asin(actorRadius / distance) so a fat target
   * is caught when its *edge* enters the arc. Without that, cleaves feel like
   * they miss at close range, where the target subtends 60 degrees and its centre
   * happens to sit just outside the arc.
   */
  queryCone(x, y, z, dx, dy, dz, range, halfAngle, filter, out = this.scratch(), flat = true) {
    this.counters.queries++;
    // Gather by radius first, then reject by angle — the radius pass is what
    // touches the grid, and it is already the cheap part.
    const pre = this.scratch();
    this.queryRadius(x, y, z, range, filter, pre, flat);

    let ndx = dx, ndy = flat ? 0 : dy, ndz = dz;
    const l = Math.hypot(ndx, ndy, ndz) || 1;
    ndx /= l; ndy /= l; ndz /= l;

    out.count = 0;
    for (let i = 0; i < pre.count; i++) {
      const a = pre.actors[i];
      const slot = this._slotOf.get(a);
      if (slot === undefined) continue;
      let vx = this.px[slot] - x;
      let vy = flat ? 0 : (this.py[slot] + this.height[slot] * 0.5) - y;
      let vz = this.pz[slot] - z;
      const d = Math.hypot(vx, vy, vz);
      if (d < 1e-4) { pushResult(out, a, 0, 0, 0, false); continue; }
      const c = (vx * ndx + vy * ndy + vz * ndz) / d;
      const ar = this.radius[slot];
      // Widen by the angle the target's radius subtends, clamped so a target we
      // are standing inside does not widen the cone to a full circle.
      const slack = Math.asin(Math.min(0.95, ar / Math.max(ar, d)));
      if (c < Math.cos(Math.min(Math.PI, halfAngle + slack))) continue;
      pushResult(out, a, pre.dist[i], pre.dirX[i], pre.dirZ[i], pre.grazed[i] === 1);
    }
    return out;
  }

  /**
   * Capsule query — a swept melee arc, a beam, a charge path, a wall of shadow.
   * Segment p0..p1 inflated by `radius`; an actor is hit when its own capsule
   * comes within (radius + actorRadius) of the segment.
   */
  queryCapsule(p0x, p0y, p0z, p1x, p1y, p1z, radius, filter, out = this.scratch(), flat = true) {
    this.counters.queries++;
    out.count = 0;
    const maxR = this._maxRadius();
    const mnx = Math.min(p0x, p1x) - radius - maxR, mxx = Math.max(p0x, p1x) + radius + maxR;
    const mnz = Math.min(p0z, p1z) - radius - maxR, mxz = Math.max(p0z, p1z) + radius + maxR;
    const g0x = Math.floor(mnx * this.invCell), g1x = Math.floor(mxx * this.invCell);
    const g0z = Math.floor(mnz * this.invCell), g1z = Math.floor(mxz * this.invCell);
    const tick = ++this._stampTick;

    const sx = p1x - p0x, sy = p1y - p0y, sz = p1z - p0z;
    const seg2 = sx * sx + sy * sy + sz * sz;

    for (let gz = g0z; gz <= g1z; gz++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const key = hashCell(gx, gz) & this.tableMask;
        const s = this.bucketStart[key], e = this.bucketStart[key + 1];
        this.counters.cellsScanned++;
        for (let k = s; k < e; k++) {
          const slot = this.sorted[k];
          if (this._stamp[slot] === tick) continue;
          if (this.cx[slot] !== gx || this.cz[slot] !== gz) continue;
          this._stamp[slot] = tick;
          this.counters.pairTests++;
          if (!this._accept(slot, filter)) continue;

          const ar = this.radius[slot];
          const ax = this.px[slot];
          const ay = flat ? p0y : this.py[slot] + this.height[slot] * 0.5;
          const az = this.pz[slot];
          // Closest point on the query segment to the actor centre.
          let t = 0;
          if (seg2 > EPS) {
            t = clamp(((ax - p0x) * sx + (ay - p0y) * sy + (az - p0z) * sz) / seg2, 0, 1);
          }
          const qx = p0x + sx * t, qy = p0y + sy * t, qz = p0z + sz * t;
          const dx = ax - qx, dy = flat ? 0 : ay - qy, dz = az - qz;
          const d2 = dx * dx + dy * dy + dz * dz;
          const reach = radius + ar;
          if (d2 > reach * reach) continue;
          const d = Math.sqrt(d2);
          const inv = d > EPS ? 1 / d : 0;
          // Report distance from the segment START, which is what knockback and
          // damage falloff along a beam want.
          const along = Math.hypot(ax - p0x, flat ? 0 : ay - p0y, az - p0z);
          if (!pushResult(out, this.actors[slot], along, dx * inv, dz * inv, d > radius)) break;
        }
      }
    }
    return out;
  }

  /**
   * Oriented-box query on the XZ plane (yaw only). Rectangular AoEs — a wall of
   * spikes, a shockwave lane, a boss's tail sweep.
   */
  queryBox(cx, cy, cz, hx, hz, yaw, filter, out = this.scratch()) {
    this.counters.queries++;
    out.count = 0;
    const maxR = this._maxRadius();
    const rr = Math.hypot(hx, hz) + maxR;
    const pre = this.scratch();
    this.queryRadius(cx, cy, cz, rr, filter, pre, true);
    const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
    for (let i = 0; i < pre.count; i++) {
      const a = pre.actors[i];
      const slot = this._slotOf.get(a);
      if (slot === undefined) continue;
      const vx = this.px[slot] - cx, vz = this.pz[slot] - cz;
      const lx = vx * cs - vz * sn;
      const lz = vx * sn + vz * cs;
      const ar = this.radius[slot];
      // Closest point on the box to the actor centre, in box space.
      const qx = clamp(lx, -hx, hx), qz = clamp(lz, -hz, hz);
      const ddx = lx - qx, ddz = lz - qz;
      if (ddx * ddx + ddz * ddz > ar * ar) continue;
      pushResult(out, a, pre.dist[i], pre.dirX[i], pre.dirZ[i], pre.grazed[i] === 1);
    }
    return out;
  }

  /** Nearest accepted actor within `radius`, or null. */
  nearest(x, y, z, radius, filter) {
    const r = this.queryRadius(x, y, z, radius, filter, this.scratch(), true);
    let best = null, bestD = Infinity;
    for (let i = 0; i < r.count; i++) {
      if (r.dist[i] < bestD) { bestD = r.dist[i]; best = r.actors[i]; }
    }
    return best;
  }

  /** Largest live actor radius, cached by `rebuild()`. A boss with a 3 m radius
   *  must widen every query's cell footprint or it will be missed from its own
   *  edge, so this participates in the cell range of every query. */
  _maxRadius() {
    return this._maxR;
  }

  /* ---------------------------------------------------------------- */
  /* Separation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Push overlapping actors apart. Runs `iterations` Gauss-Seidel passes over
   * the grid; each pass resolves every overlapping pair by half the penetration,
   * weighted by mass, so a horde relaxes into a ring around the player instead of
   * a single blob at his feet.
   *
   * Only XZ is corrected. Actors are floor-bound and a vertical push would fight
   * the character controller's ground snap every step.
   *
   * `onMoved(actor, dx, dz)` fires once per actor that was actually displaced, so
   * the caller can re-run static depenetration and stop a shoved skeleton ending
   * up inside a wall.
   */
  separate(iterations = 2, strength = 0.5, onMoved = null) {
    const n = this.count;
    if (n < 2) return 0;
    let resolved = 0;

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < n; i++) {
        const a = this.actors[i];
        if (!a || !this.solid[i] || !this.live[i]) continue;
        const ri = this.radius[i];
        const wi = this.weight[i];
        const gx0 = this.cx[i], gz0 = this.cz[i];
        // Cell radius must cover the largest possible pair reach, not just ours.
        const cr = Math.ceil((ri + this._maxR) * this.invCell);
        for (let gz = gz0 - cr; gz <= gz0 + cr; gz++) {
          for (let gx = gx0 - cr; gx <= gx0 + cr; gx++) {
            const key = hashCell(gx, gz) & this.tableMask;
            const s = this.bucketStart[key], e = this.bucketStart[key + 1];
            for (let k = s; k < e; k++) {
              const j = this.sorted[k];
              // Each unordered pair exactly once.
              if (j <= i) continue;
              if (this.cx[j] !== gx || this.cz[j] !== gz) continue;
              const b = this.actors[j];
              if (!b || !this.solid[j] || !this.live[j]) continue;

              const rj = this.radius[j];
              let dx = this.px[j] - this.px[i];
              let dz = this.pz[j] - this.pz[i];
              const sum = ri + rj;
              let d2 = dx * dx + dz * dz;
              if (d2 >= sum * sum) continue;
              this.counters.separations++;

              let d = Math.sqrt(d2);
              if (d < 1e-4) {
                // Perfectly coincident (two spawns on the same tile). Nudge along
                // a deterministic axis derived from the slot indices so the result
                // is reproducible in capture mode — never Math.random().
                const ang = ((i * 73856093) ^ (j * 19349663)) % 628 / 100;
                dx = Math.cos(ang); dz = Math.sin(ang); d = 1e-4;
              } else {
                dx /= d; dz /= d;
              }
              const pen = (sum - d) * strength;
              const wsum = wi + this.weight[j];
              // Weight 0 on both sides would divide by zero; treat as immovable.
              if (wsum <= EPS) continue;
              const fi = this.weight[j] / wsum; // heavier partner moves us less
              const fj = wi / wsum;

              if (fi > 0) {
                this.px[i] -= dx * pen * fi;
                this.pz[i] -= dz * pen * fi;
                const p = a.position;
                if (p) { p.x = this.px[i]; p.z = this.pz[i]; }
                if (onMoved) onMoved(a, -dx * pen * fi, -dz * pen * fi);
              }
              if (fj > 0) {
                this.px[j] += dx * pen * fj;
                this.pz[j] += dz * pen * fj;
                const q = b.position;
                if (q) { q.x = this.px[j]; q.z = this.pz[j]; }
                if (onMoved) onMoved(b, dx * pen * fj, dz * pen * fj);
              }
              resolved++;
            }
          }
        }
      }
    }
    return resolved;
  }

  stats() {
    return {
      actors: this.liveCount,
      slots: this.count,
      capacity: this.capacity,
      cell: this.cell,
      table: this.tableSize,
      queries: this.counters.queries,
      pairTests: this.counters.pairTests,
      separations: this.counters.separations,
    };
  }

  resetCounters() {
    this.counters.queries = 0;
    this.counters.cellsScanned = 0;
    this.counters.pairTests = 0;
    this.counters.separations = 0;
  }

  dispose() {
    this._slotOf.clear();
    this.actors.fill(null);
    this.count = 0;
  }
}

/**
 * Spatial hash for signed integer cell coordinates.
 * The two large primes are the classic Teschner et al. choice; xor-folding them
 * distributes negative coordinates as well as positive ones, which a naive
 * `x * P1 + z * P2` does not.
 */
function hashCell(x, z) {
  return ((Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) >>> 0);
}
