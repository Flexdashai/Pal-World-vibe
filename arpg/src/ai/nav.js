import * as THREE from 'three';
import { NAV, clamp } from './tuning.js';

/**
 * MONARCH — navigation.
 *
 * A FLOW FIELD, not a navmesh and not per-agent A*.
 *
 * The reason is the shape of the problem: forty actors all want to reach ONE
 * point. Per-agent A* solves that same query forty times a second and then
 * throws away thirty-nine identical answers. A single Dijkstra flood from the
 * player produces a distance field every agent can read in O(1), so the cost is
 * independent of how many enemies there are — which is exactly the property a
 * horde game needs.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN THE GRID
 *
 *   solid[]      1 where an actor cannot stand
 *   floor[]      floor height, metres, for cheap ground snapping
 *   clear[]      chamfer distance to the nearest solid cell, in cells. Drives
 *                both the path cost (paths pull off the walls) and the wall
 *                avoidance term in `steer.js`.
 *   dist[]       the live distance field, in cost units, flooded from the goal
 *
 * The wall cost is what turns a flow field from "technically correct" into
 * "looks authored". Without it every agent hugs the inside of every corner,
 * because the shortest path does, and forty agents hugging one corner is a
 * conga line. With `wallCost` the field's cheapest route runs down the middle
 * of a corridor and the crowd spreads across its width.
 *
 * ---------------------------------------------------------------------------
 * COST
 *
 * Build: two raycasts per candidate cell, once, at `world:ready`. A 60 × 60 m
 * level with 1 m cells and roughly half of it inside a room is ~1 800 cells,
 * so ~3 600 BVH raycasts — a few milliseconds.
 *
 * Rebuild: one Dijkstra flood at `NAV.rebuildHz`. Bounded by `NAV.maxVisits` so
 * a pathological level cannot hang a frame.
 */

/** Integer edge costs. Diagonals are 14/10 ≈ √2, the standard octile pair. */
const COST_ORTH = 10;
const COST_DIAG = 14;
const UNREACHED = 0x7fffffff;

export class FlowField {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = false;
    this.cell = NAV.cell;
    this.invCell = 1 / NAV.cell;
    this.w = 0; this.h = 0;
    this.minX = 0; this.minZ = 0;

    this.solid = null;
    this.floor = null;
    this.clear = null;
    this.dist = null;

    // ---- heap, preallocated. Nothing in this file allocates per frame. ------
    this._heapIdx = null;
    this._heapKey = null;
    this._heapCount = 0;

    this._goalX = 0; this._goalZ = 0;
    this._accum = 0;
    this._floods = 0;
    this._lastVisits = 0;
    this._buildMs = 0;

    this._v = new THREE.Vector3();
    this._probeDir = new THREE.Vector3(0, 1, 0);
    this._down = new THREE.Vector3(0, -1, 0);
  }

  /* ==================================================================== */
  /* build                                                                */
  /* ==================================================================== */

  /**
   * Build the grid from the level's room bounds, probing the real collision
   * world for floors and clearance.
   *
   * @param level   `world.level` — the room graph. Optional: with no world the
   *                grid falls back to a fixed box around the origin so the
   *                subsystem still works in a bare scene.
   * @param physics `ctx.peek('physics')`
   */
  build(level, physics) {
    const t0 = performance.now();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const rooms = level?.rooms ?? null;
    if (rooms && rooms.length) {
      for (const r of rooms) {
        const a = r.aabb;
        if (!a) continue;
        minX = Math.min(minX, a.minX); maxX = Math.max(maxX, a.maxX);
        minZ = Math.min(minZ, a.minZ); maxZ = Math.max(maxZ, a.maxZ);
      }
    }
    if (!isFinite(minX)) { minX = -40; maxX = 40; minZ = -40; maxZ = 40; }

    // One cell of margin so an actor standing exactly on a room's edge still
    // has a neighbour to flow toward.
    minX -= this.cell; minZ -= this.cell;
    maxX += this.cell; maxZ += this.cell;

    let w = Math.ceil((maxX - minX) * this.invCell);
    let h = Math.ceil((maxZ - minZ) * this.invCell);
    // A level larger than the cap gets a coarser cell rather than a truncated
    // grid — a truncated grid silently makes half the level unreachable.
    if (w > NAV.maxDim || h > NAV.maxDim) {
      const scale = Math.max(w / NAV.maxDim, h / NAV.maxDim);
      this.cell *= scale;
      this.invCell = 1 / this.cell;
      w = Math.ceil((maxX - minX) * this.invCell);
      h = Math.ceil((maxZ - minZ) * this.invCell);
    }
    this.w = w; this.h = h;
    this.minX = minX; this.minZ = minZ;

    const n = w * h;
    this.solid = new Uint8Array(n);
    this.floor = new Float32Array(n);
    this.clear = new Float32Array(n);
    this.dist = new Int32Array(n);
    this._heapIdx = new Int32Array(n + 1);
    this._heapKey = new Int32Array(n + 1);

    // ---- probe --------------------------------------------------------------
    // `rooms` gives a cheap early-out: a cell outside every room AABB cannot be
    // walkable, and skipping it saves the two raycasts.
    let probed = 0, walkable = 0;
    for (let iz = 0; iz < h; iz++) {
      for (let ix = 0; ix < w; ix++) {
        const i = iz * w + ix;
        const x = minX + (ix + 0.5) * this.cell;
        const z = minZ + (iz + 0.5) * this.cell;
        if (rooms && !insideAnyRoom(rooms, x, z)) { this.solid[i] = 1; continue; }
        probed++;
        const g = physics?.groundAt?.(x, z, 12);
        if (!g) { this.solid[i] = 1; continue; }
        this.floor[i] = g.y;
        // Head clearance: anything within `NAV.clearance` above the floor makes
        // the cell unusable. Without this the grid routes actors under a tomb
        // slab they cannot fit through.
        const up = physics?.raycastFrom?.(x, g.y + 0.25, z, 0, 1, 0, NAV.clearance) ?? null;
        if (up?.hit) { this.solid[i] = 1; continue; }
        walkable++;
      }
    }

    // ---- chamfer clearance --------------------------------------------------
    this._chamfer();

    this.dist.fill(UNREACHED);
    this.ready = walkable > 0;
    this._buildMs = performance.now() - t0;
    return {
      w, h, cell: +this.cell.toFixed(2), cells: n, probed, walkable,
      ms: +this._buildMs.toFixed(1),
    };
  }

  /**
   * Two-pass chamfer distance transform. `clear[i]` ends up as the approximate
   * distance in CELLS from cell i to the nearest solid cell, which is accurate
   * to a few percent and costs two linear sweeps instead of a full BFS.
   */
  _chamfer() {
    const { w, h, solid, clear } = this;
    const BIG = 1e6;
    for (let i = 0; i < clear.length; i++) clear[i] = solid[i] ? 0 : BIG;
    const d1 = 1, d2 = 1.41421356;
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        if (clear[i] === 0) continue;
        let m = clear[i];
        if (x > 0) m = Math.min(m, clear[i - 1] + d1);
        if (z > 0) m = Math.min(m, clear[i - w] + d1);
        if (x > 0 && z > 0) m = Math.min(m, clear[i - w - 1] + d2);
        if (x < w - 1 && z > 0) m = Math.min(m, clear[i - w + 1] + d2);
        clear[i] = m;
      }
    }
    for (let z = h - 1; z >= 0; z--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = z * w + x;
        if (clear[i] === 0) continue;
        let m = clear[i];
        if (x < w - 1) m = Math.min(m, clear[i + 1] + d1);
        if (z < h - 1) m = Math.min(m, clear[i + w] + d1);
        if (x < w - 1 && z < h - 1) m = Math.min(m, clear[i + w + 1] + d2);
        if (x > 0 && z < h - 1) m = Math.min(m, clear[i + w - 1] + d2);
        clear[i] = Math.min(m, 64);
      }
    }
  }

  /* ==================================================================== */
  /* queries                                                              */
  /* ==================================================================== */

  index(x, z) {
    const ix = Math.floor((x - this.minX) * this.invCell);
    const iz = Math.floor((z - this.minZ) * this.invCell);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return -1;
    return iz * this.w + ix;
  }

  walkable(x, z) {
    const i = this.index(x, z);
    return i >= 0 && this.solid[i] === 0;
  }

  floorAt(x, z) {
    const i = this.index(x, z);
    return i >= 0 ? this.floor[i] : 0;
  }

  /** Clearance in METRES from the nearest wall. */
  clearanceAt(x, z) {
    const i = this.index(x, z);
    return i >= 0 ? this.clear[i] * this.cell : 8;
  }

  /** The nearest walkable cell to a point, searched outward in rings. Used to
   *  seed the flood when the player is standing somewhere the grid thinks is
   *  solid (on a step, inside a prop's bounds, mid-dash). */
  nearestWalkable(x, z, maxRings = 4) {
    let i = this.index(x, z);
    if (i >= 0 && !this.solid[i]) return i;
    const ix0 = Math.floor((x - this.minX) * this.invCell);
    const iz0 = Math.floor((z - this.minZ) * this.invCell);
    for (let r = 1; r <= maxRings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = ix0 + dx, iz = iz0 + dz;
          if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) continue;
          i = iz * this.w + ix;
          if (!this.solid[i]) return i;
        }
      }
    }
    return -1;
  }

  /* ==================================================================== */
  /* the flood                                                            */
  /* ==================================================================== */

  /** Rate-limited rebuild. Call every fixed step; it decides when to work. */
  update(dt, goalX, goalZ) {
    if (!this.ready) return false;
    this._accum += dt;
    const period = 1 / NAV.rebuildHz;
    // A goal that has jumped (a teleport, a level change) rebuilds immediately:
    // a stale field pointing at where the player used to be sends the whole
    // horde the wrong way, which is far more visible than a frame of cost.
    const jumped = Math.hypot(goalX - this._goalX, goalZ - this._goalZ) > this.cell * 6;
    if (this._accum < period && !jumped) return false;
    this._accum = 0;
    this.flood(goalX, goalZ);
    return true;
  }

  /**
   * Dijkstra from one goal cell over the 8-neighbourhood.
   *
   * The queue is a binary heap over typed arrays with a fixed capacity, so this
   * allocates nothing. `maxVisits` caps the flood: far cells simply keep
   * `UNREACHED` and the agents standing on them fall back to direct steering,
   * which is the correct degradation — an agent 60 m away is off-screen.
   */
  flood(goalX, goalZ) {
    this._goalX = goalX; this._goalZ = goalZ;
    const start = this.nearestWalkable(goalX, goalZ, 6);
    this.dist.fill(UNREACHED);
    this._heapCount = 0;
    this._floods++;
    this._lastVisits = 0;
    if (start < 0) return 0;

    const { w, h, solid, clear, dist } = this;
    dist[start] = 0;
    this._push(start, 0);

    let visits = 0;
    while (this._heapCount > 0 && visits < NAV.maxVisits) {
      const cur = this._pop();
      const d = dist[cur];
      // Stale heap entry (a cell relaxed twice) — the key check is cheaper than
      // a decrease-key implementation and the duplicate count is small.
      if (this._popKey > d) continue;
      visits++;
      const cx = cur % w, cz = (cur / w) | 0;

      for (let k = 0; k < 8; k++) {
        const dx = NB[k * 2], dz = NB[k * 2 + 1];
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if (solid[ni]) continue;
        // No corner cutting: a diagonal step is only legal when both of its
        // orthogonal components are open. Without this actors clip the corners
        // of doorways and walk through the jamb.
        if (dx && dz) {
          if (solid[cz * w + nx] || solid[nz * w + cx]) continue;
        }
        // Wall penalty. Quadratic in how close the cell is to a wall, so the
        // very edge is expensive and the middle of a corridor is free.
        const clearance = clear[ni] * this.cell;
        let step = (dx && dz) ? COST_DIAG : COST_ORTH;
        if (clearance < NAV.wallPad) {
          const t = 1 - clearance / NAV.wallPad;
          step += Math.round(step * NAV.wallCost * t * t);
        }
        const nd = d + step;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          this._push(ni, nd);
        }
      }
    }
    this._lastVisits = visits;
    return visits;
  }

  _push(idx, key) {
    let i = ++this._heapCount;
    const H = this._heapIdx, K = this._heapKey;
    // Capacity is the cell count; a duplicate-heavy flood could in principle
    // exceed it, so the push is a no-op rather than a corruption when it does.
    if (i >= H.length) { this._heapCount--; return; }
    while (i > 1) {
      const p = i >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; H[i] = H[p];
      i = p;
    }
    K[i] = key; H[i] = idx;
  }

  _pop() {
    const H = this._heapIdx, K = this._heapKey;
    const top = H[1];
    this._popKey = K[1];
    const lastK = K[this._heapCount], lastI = H[this._heapCount];
    this._heapCount--;
    let i = 1;
    const n = this._heapCount;
    while (true) {
      let c = i << 1;
      if (c > n) break;
      if (c + 1 <= n && K[c + 1] < K[c]) c++;
      if (K[c] >= lastK) break;
      K[i] = K[c]; H[i] = H[c];
      i = c;
    }
    if (n > 0) { K[i] = lastK; H[i] = lastI; }
    return top;
  }

  /* ==================================================================== */
  /* reading the field                                                    */
  /* ==================================================================== */

  /**
   * Descent direction of the distance field at a world point, written into
   * `out` (a Vector3, y untouched). Returns false when the cell is unreachable
   * and the caller should steer directly.
   *
   * The gradient is taken over the 8-neighbourhood by picking the cheapest
   * neighbour and then BLENDING it with the second cheapest, weighted by the
   * cost difference. Picking the single cheapest gives eight possible headings
   * and the whole crowd snaps between them; blending two gives a continuous
   * field with no measurable extra cost.
   */
  sample(x, z, out) {
    if (!this.ready) return false;
    const i = this.index(x, z);
    if (i < 0 || this.solid[i]) {
      const j = this.nearestWalkable(x, z, 2);
      if (j < 0) return false;
      return this._gradient(j, out);
    }
    if (this.dist[i] === UNREACHED) return false;
    return this._gradient(i, out);
  }

  _gradient(i, out) {
    const { w, h, solid, dist } = this;
    const cx = i % w, cz = (i / w) | 0;
    const here = dist[i];
    let bestK = -1, bestD = here, secondK = -1, secondD = here;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NB[k * 2], nz = cz + NB[k * 2 + 1];
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const ni = nz * w + nx;
      if (solid[ni] || dist[ni] === UNREACHED) continue;
      const d = dist[ni];
      if (d < bestD) { secondK = bestK; secondD = bestD; bestK = k; bestD = d; }
      else if (d < secondD) { secondK = k; secondD = d; }
    }
    if (bestK < 0) return false;
    let dx = NB[bestK * 2], dz = NB[bestK * 2 + 1];
    if (secondK >= 0) {
      // Weight by how much better the best is than the second: when they are
      // equal the heading is the bisector, which is what removes the snapping.
      const wgt = 1 / (1 + (secondD - bestD) * 0.20);
      dx += NB[secondK * 2] * wgt;
      dz += NB[secondK * 2 + 1] * wgt;
    }
    const l = Math.hypot(dx, dz) || 1;
    out.x = dx / l; out.y = 0; out.z = dz / l;
    return true;
  }

  /** Cost-to-goal at a point, in metres (approximate). −1 when unreachable. */
  costAt(x, z) {
    const i = this.index(x, z);
    if (i < 0 || this.dist[i] === UNREACHED) return -1;
    return (this.dist[i] / COST_ORTH) * this.cell;
  }

  /**
   * A spawn point: a walkable cell between `min` and `max` metres from the
   * player, reachable, and out of the camera's view. Deterministic — it walks
   * the grid from a seeded start index rather than rejection-sampling.
   */
  findSpawn(rng, px, pz, min, max, camDirX, camDirZ) {
    if (!this.ready) return null;
    const n = this.w * this.h;
    const start = rng.u32() % n;
    const min2 = min * min, max2 = max * max;
    let fallback = -1;
    for (let s = 0; s < n; s++) {
      const i = (start + s * 7919) % n;    // a coprime stride: a cheap shuffle
      if (this.solid[i]) continue;
      if (this.dist[i] === UNREACHED) continue;
      const x = this.minX + ((i % this.w) + 0.5) * this.cell;
      const z = this.minZ + (((i / this.w) | 0) + 0.5) * this.cell;
      const dx = x - px, dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < min2 || d2 > max2) continue;
      // Prefer somewhere with room to stand — a spawn wedged against a wall
      // makes the first second of an enemy's life a collision resolve.
      if (this.clear[i] * this.cell < 0.9) continue;
      if (fallback < 0) fallback = i;
      // Behind the camera: the camera looks along +(camDir), so a spawn the
      // player cannot see has a NEGATIVE dot with it.
      const dot = (dx * camDirX + dz * camDirZ) / Math.sqrt(d2);
      if (dot > -0.15) continue;
      this._v.set(x, this.floor[i], z);
      return this._v;
    }
    if (fallback >= 0) {
      const x = this.minX + ((fallback % this.w) + 0.5) * this.cell;
      const z = this.minZ + (((fallback / this.w) | 0) + 0.5) * this.cell;
      this._v.set(x, this.floor[fallback], z);
      return this._v;
    }
    return null;
  }

  stats() {
    let walkable = 0;
    if (this.solid) for (let i = 0; i < this.solid.length; i++) if (!this.solid[i]) walkable++;
    return {
      ready: this.ready,
      grid: `${this.w}x${this.h}`,
      cell: +this.cell.toFixed(2),
      walkable,
      floods: this._floods,
      lastVisits: this._lastVisits,
      buildMs: +this._buildMs.toFixed(1),
    };
  }

  dispose() {
    this.solid = this.floor = this.clear = this.dist = null;
    this._heapIdx = this._heapKey = null;
    this.ready = false;
  }
}

/** 8-neighbourhood offsets, orthogonals first so the diagonal test is cheap. */
const NB = Int8Array.from([
  1, 0, -1, 0, 0, 1, 0, -1,
  1, 1, 1, -1, -1, 1, -1, -1,
]);

/** Is a world point inside any room's AABB? */
function insideAnyRoom(rooms, x, z) {
  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i].aabb;
    if (!a) continue;
    if (x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ) return true;
  }
  return false;
}

/* ==========================================================================
 * ring slots — the anti-blob
 * ========================================================================== */

/**
 * ATTACK SLOTS.
 *
 * A flow field alone produces a crowd that converges on one point and then
 * stacks. The fix is not more avoidance force — that makes a jittering ball —
 * it is to give each agent a DIFFERENT destination.
 *
 * So the target is ringed with N angular slots at a radius, agents claim the
 * slot nearest their current bearing, and they steer to the slot rather than to
 * the target. The result is an encirclement that fills in from wherever the
 * agents happened to arrive, which is exactly how a pack behaves.
 *
 * Slots are claimed by actor id and released on death, retarget or timeout, and
 * an agent that cannot get a slot on the inner ring is pushed to the outer one
 * — which is `engageFraction` made geometric: the surplus circles at range.
 */
export class RingSlots {
  constructor(capacity = 20) {
    this.capacity = capacity;
    /** slot -> actor, or null. */
    this.owner = new Array(capacity).fill(null);
    this.count = capacity;
    this.radius = 2.0;
    this.centreX = 0;
    this.centreZ = 0;
    this._claims = new Map();
  }

  configure(count, radius) {
    this.count = Math.min(this.capacity, Math.max(1, count));
    this.radius = radius;
    return this;
  }

  setCentre(x, z) { this.centreX = x; this.centreZ = z; }

  /**
   * Claim the free slot closest to the bearing an actor is already approaching
   * from. Returns the slot index, or −1 when the ring is full.
   */
  claim(actor, fromX, fromZ) {
    const held = this._claims.get(actor);
    if (held !== undefined && this.owner[held] === actor) return held;

    const bearing = Math.atan2(fromX - this.centreX, fromZ - this.centreZ);
    let want = Math.round((bearing / (Math.PI * 2)) * this.count);
    want = ((want % this.count) + this.count) % this.count;
    for (let d = 0; d < this.count; d++) {
      // Alternate outward from the preferred slot, so two agents arriving from
      // the same side do not both fall back to slot 0.
      const off = (d % 2 === 0) ? (d >> 1) : -((d + 1) >> 1);
      const s = ((want + off) % this.count + this.count) % this.count;
      if (this.owner[s] === null) {
        this.owner[s] = actor;
        this._claims.set(actor, s);
        return s;
      }
    }
    return -1;
  }

  release(actor) {
    const s = this._claims.get(actor);
    if (s !== undefined) {
      if (this.owner[s] === actor) this.owner[s] = null;
      this._claims.delete(actor);
    }
  }

  /** World position of a slot, written into `out`. */
  position(slot, out) {
    const a = (slot / this.count) * Math.PI * 2;
    out.x = this.centreX + Math.sin(a) * this.radius;
    out.z = this.centreZ + Math.cos(a) * this.radius;
    return out;
  }

  clear() {
    this.owner.fill(null);
    this._claims.clear();
  }

  get used() {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.owner[i]) n++;
    return n;
  }
}

export { COST_ORTH, COST_DIAG, clamp };
