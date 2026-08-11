/**
 * MONARCH — hitbox resolution.
 *
 * Turns a skill's declared shape into a list of actors, with a per-actor falloff
 * factor. Every query goes through `physics` — combat owns no spatial index and
 * never will, because two indexes are always eventually two different answers.
 *
 * Shapes:
 *   cone     origin + direction + range + half-angle. The melee shape.
 *   circle   origin + radius. AoE centred on the caster or on the cursor.
 *   line     origin + direction + range + half-width. A capsule, so a target
 *            standing exactly on the axis at max range still counts.
 *   dash     a line whose length is decided at runtime by where the dash
 *            actually ended, which is not the same as where it was aimed.
 *   self     radius about the caster, ignoring direction.
 *   projectile  resolved by `physics.spawnProjectile`, not here.
 *
 * FALLOFF is per-actor and matters more than it looks. An AoE that does full
 * damage at its rim reads as a hard disc; one that does 55% at the rim reads as
 * a detonation with a centre. The curve is smoothstepped rather than linear so
 * the drop is gentle in the middle of the shape and sharp at the edge.
 *
 * TARGET CAP: every query is capped (`def.maxTargets`) and sorted nearest-first,
 * so a nova into a boss room hits the fourteen enemies around the player rather
 * than the forty in the room. Uncapped AoE is a frame-rate cliff that only
 * appears in the one situation where frame rate matters most.
 */

import * as THREE from 'three';
import { clamp, clamp01, smooth } from './tuning.js';

/** Result record. Parallel arrays, fixed capacity, reused for every resolve. */
function makeResult(capacity) {
  return {
    count: 0,
    capacity,
    actors: new Array(capacity).fill(null),
    dist: new Float32Array(capacity),
    dirX: new Float32Array(capacity),
    dirZ: new Float32Array(capacity),
    falloff: new Float32Array(capacity),
    /** World-space impact point per actor — where the number and the flash go. */
    hitX: new Float32Array(capacity),
    hitY: new Float32Array(capacity),
    hitZ: new Float32Array(capacity),
  };
}

export class Resolver {
  constructor(ctx) {
    this.ctx = ctx;
    const cap = Math.max(32, (ctx.config?.q?.maxActors ?? 60) + 8);
    this.result = makeResult(cap);

    /** Our own physics query result, so a nested query somewhere else in the
     *  frame cannot stomp the one we are iterating. */
    this._q = ctx.peek('physics')?.createQueryResult?.(cap) ?? null;

    this._p0 = new THREE.Vector3();
    this._p1 = new THREE.Vector3();
    this._v = new THREE.Vector3();
    /** Reused filter — `notFaction` is set per call. */
    this._filter = {
      notFaction: 'player', includePlayer: false, includeDead: false, exclude: null,
    };
  }

  /**
   * Build the actor filter for a source. Hostiles only, and never the caster.
   * `combat` is faction-agnostic: an enemy skill resolved through here excludes
   * enemies and includes the player automatically.
   */
  _filterFor(source) {
    const f = this._filter;
    const faction = source?.faction ?? 'player';
    if (faction === 'player') {
      // The player and their shadows hit everything that is not on their side.
      f.notFaction = 'player';
      f.includePlayer = false;
    } else {
      f.notFaction = faction;
      f.includePlayer = true;
    }
    f.exclude = source ?? null;
    f.includeDead = false;
    return f;
  }

  /**
   * Resolve a skill's hitbox.
   *
   * @param def     skill definition
   * @param source  the caster
   * @param origin  Vector3 the shape is anchored at
   * @param dir     Vector3 unit XZ direction (unused for circle/self)
   * @param opts    { range, radius, halfAngle, endPoint, scale }
   * @returns the shared result record (do not retain it)
   */
  resolve(def, source, origin, dir, opts = {}) {
    const out = this.result;
    out.count = 0;
    const P = this.ctx.peek('physics');
    if (!P) return out;

    const filter = this._filterFor(source);
    const cap = Math.min(out.capacity, def.maxTargets ?? out.capacity);
    const shape = opts.shape ?? def.shape;

    let q = null;
    let mode = 'radial';
    let extent = 1;

    switch (shape) {
      case 'cone': {
        const range = opts.range ?? def.range ?? 3;
        const half = opts.halfAngle ?? def.halfAngle ?? 0.9;
        // A full-circle "cone" (the finisher's spin) is a radius query: a cone
        // query with halfAngle >= PI still works but wastes the angular test on
        // every actor in the cell.
        q = half >= Math.PI - 1e-3
          ? P.queryRadius(origin, range, filter, this._q, false)
          : P.queryCone(origin, dir, range, half, filter, this._q, false);
        extent = range;
        break;
      }
      case 'circle':
      case 'self': {
        const radius = opts.radius ?? def.radius ?? 4;
        q = P.queryRadius(origin, radius, filter, this._q, false);
        extent = radius;
        break;
      }
      case 'line':
      case 'dash': {
        const range = opts.range ?? def.range ?? 6;
        const halfWidth = opts.radius ?? def.radius ?? 0.9;
        this._p0.copy(origin);
        if (opts.endPoint) this._p1.copy(opts.endPoint);
        else this._p1.copy(origin).addScaledVector(dir, range);
        // Lift both ends to torso height: a capsule laid on the floor misses
        // anything standing on a step, and a dash through a doorway with a lip
        // is exactly where this matters.
        this._p0.y += 0.9;
        this._p1.y += 0.9;
        q = P.queryCapsule(this._p0, this._p1, halfWidth, filter, this._q, false);
        mode = 'axial';
        extent = Math.max(0.001, this._p0.distanceTo(this._p1));
        break;
      }
      default:
        return out;
    }

    if (!q || q.count === 0) return out;
    P.sortByDistance(q);

    const falloffEdge = clamp01(def.falloff ?? 1);
    const n = Math.min(q.count, cap);
    for (let i = 0; i < n; i++) {
      const a = q.actors[i];
      if (!a) continue;
      const d = q.dist[i];

      // Falloff: 1 at the centre/axis, `def.falloff` at the rim, smoothstepped
      // so the mid-shape drop is gentle and the edge is decisive.
      let t;
      if (mode === 'axial') {
        // Along a line the falloff is by DISTANCE FROM THE AXIS, not from the
        // start — a dash-strike should not do less damage to the last thing it
        // passes through than to the first.
        this._v.set(a.position.x - this._p0.x, 0, a.position.z - this._p0.z);
        const along = clamp(this._v.dot(dir), 0, extent);
        const px = this._p0.x + dir.x * along, pz = this._p0.z + dir.z * along;
        const off = Math.hypot(a.position.x - px, a.position.z - pz);
        t = clamp01(off / Math.max(0.001, (opts.radius ?? def.radius ?? 0.9) + (a.radius ?? 0.4)));
      } else {
        t = clamp01(d / extent);
      }
      const f = 1 - (1 - falloffEdge) * smooth(t);

      const j = out.count++;
      out.actors[j] = a;
      out.dist[j] = d;
      out.dirX[j] = q.dirX[i];
      out.dirZ[j] = q.dirZ[i];
      out.falloff[j] = f * (opts.scale ?? 1);

      // Impact point: on the surface of the target's capsule facing the origin,
      // at 55% of its height. Placing it at the centre buries the flash inside
      // the mesh; placing it at the feet is where the corpse will be, not where
      // the blade went in.
      const r = (a.radius ?? 0.4) * 0.8;
      out.hitX[j] = a.position.x - q.dirX[i] * r;
      out.hitY[j] = a.position.y + (a.height ?? 1.8) * 0.55;
      out.hitZ[j] = a.position.z - q.dirZ[i] * r;
    }
    return out;
  }

  /**
   * Where does a dash actually end? A dash-strike aimed at a wall must stop at
   * the wall, and the hitbox must be the corridor it really travelled, not the
   * one it wanted.
   *
   * Returns the clamped distance in metres.
   */
  dashDistance(origin, dir, want, radius) {
    const P = this.ctx.peek('physics');
    if (!P?.sweepCapsule) return want;
    this._p0.set(origin.x, origin.y + radius, origin.z);
    this._p1.set(origin.x, origin.y + Math.max(radius, 1.7 - radius), origin.z);
    const hit = P.sweepCapsule(this._p0, this._p1, radius, dir, want, { mask: P.MASK.CHARACTER });
    if (!hit) return want;
    // Stop a hair short so the character controller does not have to
    // depenetrate on arrival, which reads as a bounce.
    return Math.max(0, hit.distance - 0.08);
  }

  /** A clear line of sight from the caster's chest to the target's chest.
   *  Used to stop a nova detonating through a wall into the next room. */
  visible(source, target) {
    const P = this.ctx.peek('physics');
    if (!P?.actorLineOfSight) return true;
    return P.actorLineOfSight(source, target);
  }

  dispose() {
    this.result.actors.fill(null);
  }
}
