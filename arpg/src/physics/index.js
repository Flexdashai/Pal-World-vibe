/**
 * ============================================================================
 * MONARCH — `physics` subsystem.  PUBLIC API.
 * ============================================================================
 *
 * `const P = ctx.get('physics')`. Nothing outside `src/physics/` imports a module
 * from this directory; everything below is reachable through that one handle.
 *
 * All positions are metres, Y up, ground = XZ plane. Actor `position` is at the
 * FEET (y = ground), matching ARCHITECTURE.md.
 *
 * ---------------------------------------------------------------------------
 * 1. STATIC WORLD  (owner: `world`)
 * ---------------------------------------------------------------------------
 *   P.addStatic(mesh, opts) -> id
 *       opts: { surface, layer, box, pad, userData }
 *       `surface` is one of the twelve names in ARCHITECTURE.md; omitted, it is
 *       inferred from the mesh/material name. `box:true` bakes the mesh's
 *       bounding box instead of its triangles — use it for every detailed prop.
 *       Works for Mesh and InstancedMesh. Safe to call before physics.init().
 *   P.addStaticTriangles(float32Array, count, opts) -> id
 *   P.removeStatic(id)
 *   P.setAutoScan(false)      disable the scene fallback scan (see below)
 *       The scan also disables ITSELF the moment `world` registers its first
 *       explicit collider — register one and physics stops guessing entirely.
 *   P.rebuild()               force a BVH rebuild now
 *   P.ready                   true once a BVH exists
 *
 *   If `world` registers nothing, physics scans `ctx.scene` on `world:ready` and
 *   collides against every visible mesh it finds. Per-mesh opt-outs in userData:
 *       mesh.userData.mnNoCollide  = true      skip entirely
 *       mesh.userData.mnCollideBox = true      bake the bounding box only
 *       mesh.userData.mnSurface    = 'stone'   surface tag
 *       mesh.userData.mnLayer      = P.LAYER.PROP
 *
 * ---------------------------------------------------------------------------
 * 2. RAYCASTS & SHAPE QUERIES vs the static world
 * ---------------------------------------------------------------------------
 *   P.raycast(origin, dir, maxDist, opts) -> hit | null
 *       opts: { mask, includeActors, includeBodies, ignore }
 *       `hit` is a REUSED record: { hit, point:Vector3, normal:Vector3, distance,
 *       surface:'flagstone', layer, object, mesh, actor, body, kind }.
 *       Copy what you keep.
 *   P.raycastFrom(ox,oy,oz, dx,dy,dz, maxDist, opts) -> hit | null   (no Vector3s)
 *   P.lineOfSight(a, b, mask?) -> boolean          nothing blocks a..b
 *   P.groundAt(x, z, fromY?, mask?) -> { y, normal, surface } | null
 *   P.dropToGround(vec3)                           snaps vec3.y onto the floor
 *   P.sweepSphere(origin, radius, dir, maxDist, opts) -> hit | null
 *   P.sweepCapsule(p0, p1, radius, dir, maxDist, opts) -> hit | null
 *   P.overlapSphere(centre, radius, mask?) -> contacts   (typed-array struct)
 *   P.closestSurface(point, maxDist, mask?) -> hit | null
 *   P.pickRay(ndcX, ndcY, camera, opts)  -> hit | null   mouse picking helper
 *   P.pickGroundPlane(ndcX, ndcY, camera, y?, out?) -> Vector3 | null
 *       Where the cursor ray meets the ground plane. This — not `pickRay` — is
 *       the default aim target for a skill: it still answers when the cursor is
 *       over fog, a gap, or the sky, which `pickRay` cannot.
 *
 * ---------------------------------------------------------------------------
 * 3. CHARACTER CONTROLLERS  (owners: `player`, `ai`)
 * ---------------------------------------------------------------------------
 *   const ch = P.createCharacter({ actor, radius, height, stepHeight,
 *                                  slopeLimit, snapDistance, mass, weight })
 *       The controller writes directly into `actor.position` / `actor.velocity`.
 *   ch.move(dt, { gravity, snap, stepUp })   integrate + collide, call in fixedUpdate
 *   ch.pushBy(dx,dy,dz) -> distance          knockback / dash displacement
 *   ch.teleport(x,y,z)
 *   ch.grounded, ch.groundNormal, ch.groundSurface, ch.groundFriction,
 *   ch.blocked, ch.blockedNormal, ch.moveEfficiency, ch.steppedUp,
 *   ch.landImpact, ch.airFrames
 *   ch.fits(x, y, z) -> boolean              is there room to stand there?
 *   ch.setSize(radius, height)
 *   P.destroyCharacter(ch)
 *
 * ---------------------------------------------------------------------------
 * 4. ACTORS & COMBAT QUERIES  (owners: `ai`, `combat`)
 * ---------------------------------------------------------------------------
 *   P.registerActor(actor, { radius, height, weight, solid, layer })
 *   P.unregisterActor(actor)
 *   P.configureActor(actor, opts)
 *
 *   Every query returns a REUSED result: { count, actors[], dist[], dirX[],
 *   dirZ[], grazed[] }. Pass your own via `P.createQueryResult()` for anything
 *   you keep. `filter` is a predicate, or
 *       { faction, notFaction, exclude, includeDead, includePlayer, onlyPlayer,
 *         isShadow, layer, test }
 *
 *   P.queryRadius(position, radius, filter?, out?, spherical?)
 *   P.queryCone(origin, dir, range, halfAngleRad, filter?, out?, spherical?)
 *   P.queryCapsule(p0, p1, radius, filter?, out?, spherical?)
 *   P.queryBox(centre, halfX, halfZ, yaw, filter?, out?)
 *   P.nearestActor(position, radius, filter?) -> actor | null
 *   P.actorLineOfSight(a, b) -> boolean       eye-height to eye-height
 *   P.sortByDistance(result)                  in place, nearest first
 *
 * ---------------------------------------------------------------------------
 * 5. RIGID BODIES & DEBRIS  (owners: `fx`, `world`, `loot`)
 * ---------------------------------------------------------------------------
 *   P.spawnBody({ shape:'box'|'sphere'|'capsule', size|radius|halfHeight,
 *                 position, quaternion, velocity, angular, mass, surface,
 *                 restitution, friction, mesh, lifetime, ccd, onImpact }) -> body
 *   P.despawnBody(body)
 *   P.applyImpulse(body, ix,iy,iz, px?,py?,pz?)
 *   P.explode({ position, radius, strength, lift, bodies, ragdolls, chains,
 *               actors, knockback }) -> counts
 *
 * ---------------------------------------------------------------------------
 * 6. CHAINS & HANGING PROPS  (owner: `world`)
 * ---------------------------------------------------------------------------
 *   P.createChain({ anchor, links, linkLength, endMass, linkMeshes, endMesh,
 *                   endLight, anchorB, collide }) -> chain
 *   P.createPendulum({ anchor, length, mass, mesh, light, linkMeshes }) -> chain
 *   P.destroyChain(chain)
 *
 * ---------------------------------------------------------------------------
 * 7. RAGDOLLS  (owner: `ai`)
 * ---------------------------------------------------------------------------
 *   const rag = P.spawnRagdoll({ position, yaw, height, massScale, velocity,
 *                                impulse, hitPoint, lifetime, actor, root })
 *   rag.attach('thighL', mesh)     drive a mesh with a bone (unit +Y, centred)
 *   rag.bones[i] -> { name, position, quaternion, length, radius }
 *   rag.settled, rag.landed, rag.centre, rag.fade
 *   P.despawnRagdoll(rag)
 *   P.nearestRagdoll(position, radius) -> rag | null      (ARISE target picking)
 *
 * ---------------------------------------------------------------------------
 * 8. PROJECTILES  (owner: `combat`)
 * ---------------------------------------------------------------------------
 *   P.spawnProjectile({ origin, direction, speed | velocity, radius,
 *                       gravityScale, drag, lifetime, maxDistance, pierce,
 *                       bounces, owner, faction, element, mesh, data,
 *                       onHit(hit, proj), onExpire(proj) }) -> projectile
 *       `onHit` returns 'stop' | 'pierce' | 'bounce' (default: use the counters).
 *       `hit.actor` is set on an actor hit, `hit.surface` on a world hit.
 *   P.despawnProjectile(p)
 *
 * ---------------------------------------------------------------------------
 * 9. DEBUG & STATS
 * ---------------------------------------------------------------------------
 *   P.setDebug({ bvh:3, characters:true, actors:true, bodies:true, ragdolls:true,
 *                chains:true, projectiles:true, rays:true, tris:false, xray:false })
 *   P.stats()          BVH nodes / build ms / query counts / active bodies
 *   P.selfTest()       correctness + raycast timing + doorway/dash regressions
 *   P.stressTest(opts) spawns debris/ragdolls/chains/projectiles and reports cost
 *   P.SURFACES, P.LAYER, P.MASK      the shared vocabularies
 *   P.surfaceProps(name) -> { friction, restitution, density, hardness, ... }
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * All simulation happens in `fixedUpdate` at 60 Hz. There is no `Math.random()`
 * anywhere in this directory: the only stochastic-looking values (ragdoll
 * asymmetry, coincident-actor separation) are derived from integer slot indices,
 * so two runs with the same seed produce byte-identical motion.
 */

import * as THREE from 'three';
import { StaticWorld, makeContacts } from './bvh.js';
import { ActorHash, makeQueryResult, sortByDistance, DEFAULT_CELL } from './broadphase.js';
import { CharacterController } from './character.js';
import { RigidBodyWorld } from './rigidbody.js';
import { ConstraintWorld } from './constraints.js';
import { RagdollWorld } from './ragdoll.js';
import { ProjectileWorld } from './projectile.js';
import { PhysicsDebug } from './debug.js';
import { makeHit, syncHit, clearHit, makeClosest, clamp, rayCapsule } from './math.js';
import {
  SURFACE, SURFACE_NAMES, SURFACE_PROPS, LAYER, MASK,
  surfaceName, surfaceIndex, surfaceProps, guessSurface, guessLayer,
} from './surfaces.js';
import { UNITS } from '../core/config.js';

export class PhysicsSystem {
  static id = 'physics';
  static deps = [];

  constructor() {
    // EVERYTHING is built in the constructor, not in init(). `world` runs before
    // us in the topological order and legitimately calls `ctx.get('physics')`
    // during its own init(); the registry hands out the instance immediately, so
    // addStatic() has to work before init() has ever been called.
    this.staticWorld = new StaticWorld();
    this.actors = new ActorHash(192, DEFAULT_CELL);

    this.gravity = UNITS.gravity;
    this.characters = [];
    /** actor -> CharacterController, so `explode` and the separation re-seat pass
     *  are O(1) instead of a linear scan per shoved actor. */
    this._charByActor = new Map();
    this.bodies = null;      // built in init(), once we know the quality budget
    this.constraints = null;
    this.ragdolls = null;
    this.projectiles = null;

    this.debug = new PhysicsDebug();
    this.autoScan = true;
    this.ready = false;

    // ---- preallocated scratch. Nothing below allocates per frame. ----
    this._hit = makeHit();
    this._hit2 = makeHit();
    this._closest = makeClosest();
    this._contacts = makeContacts(96);
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._userResults = [];
    this._groundResult = { y: 0, normal: new THREE.Vector3(0, 1, 0), surface: 'stone', surfaceId: 0 };

    this._simMs = 0;
    this._simMsAvg = 0;
    this._frames = 0;
    this._rebuildsPending = false;

    this._onWorldReady = null;
    this._onExplosion = null;
    this.ctx = null;
    this.rng = null;
  }

  /* ================================================================ */
  /* Lifecycle                                                        */
  /* ================================================================ */

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    const q = ctx.config.q;

    this.gravity = UNITS.gravity;

    // Budgets are derived from the active quality preset so a low-end machine
    // (and this container) never pays for debris it cannot draw.
    const debrisCap = Math.round(clamp(q.particleBudget / 64, 48, 320));
    const ragdollCap = Math.round(clamp(q.maxActors / 5, 6, 24));
    const projCap = Math.round(clamp(q.maxActors * 2.5, 64, 256));

    this.bodies = new RigidBodyWorld(this.staticWorld, {
      capacity: debrisCap, gravity: this.gravity, events: ctx.events, rng: this.rng,
    });
    this.constraints = new ConstraintWorld(this.staticWorld, {
      capacity: 64, gravity: this.gravity,
    });
    this.ragdolls = new RagdollWorld(this.staticWorld, {
      capacity: ragdollCap, gravity: this.gravity, events: ctx.events,
    });
    this.projectiles = new ProjectileWorld(this.staticWorld, this.actors, {
      capacity: projCap, gravity: this.gravity, events: ctx.events,
    });

    // Actor capacity tracks the preset, with headroom for shadow soldiers, which
    // are spawned on top of the enemy budget rather than inside it.
    if (q.maxActors + 64 > this.actors.capacity) {
      const bigger = new ActorHash(q.maxActors + 64, DEFAULT_CELL);
      this.actors = bigger;
      this.projectiles.actors = bigger;
    }

    this.debug.attach(ctx.scene);

    // `world:ready` may have been emitted during world.init(), which runs BEFORE
    // ours — so we both subscribe AND do one build at the end of init().
    this._onWorldReady = () => { this._rebuildsPending = true; this.rebuild(); };
    ctx.events.on('world:ready', this._onWorldReady);

    // Explosions are a shared vocabulary event; anything can emit one and every
    // simulated thing should react. This is the single coupling point.
    // `knockback` defaults to 0 here on purpose. Combat applies its OWN actor
    // displacement as part of the damage model, and an explosion that both
    // emitted the event and let physics shove actors would move everyone twice.
    // A subsystem that wants physics to do the shoving passes `knockback` on the
    // payload, or calls `P.explode({ knockback })` directly.
    this._onExplosion = (e) => {
      if (!e?.position) return;
      this.explode({
        position: e.position,
        radius: e.radius ?? 3,
        strength: (e.magnitude ?? 1) * 34,
        knockback: e.knockback ?? 0,
        filter: e.filter ?? null,
      });
    };
    ctx.events.on('fx:explosion', this._onExplosion);

    this.rebuild();
    return this;
  }

  dispose() {
    if (this.ctx) {
      this.ctx.events.off('world:ready', this._onWorldReady);
      this.ctx.events.off('fx:explosion', this._onExplosion);
    }
    for (const ch of this.characters) ch.dispose();
    this.characters.length = 0;
    this.projectiles?.dispose();
    this.ragdolls?.dispose();
    this.constraints?.dispose();
    this.bodies?.dispose();
    this.actors.dispose();
    this.staticWorld.dispose();
    this.debug.dispose();
    this.ctx = null;
  }

  /* ================================================================ */
  /* 1. Static world                                                  */
  /* ================================================================ */

  /**
   * Register a mesh as static collision.
   * @returns collider id, or -1 when the mesh had nothing usable.
   */
  addStatic(mesh, opts = {}) {
    const ud = mesh?.userData ?? {};
    const id = this.staticWorld.addMesh(mesh, {
      surface: opts.surface ?? ud.mnSurface,
      layer: opts.layer ?? ud.mnLayer ?? guessLayer(mesh?.name),
      box: opts.box ?? ud.mnCollideBox ?? false,
      pad: opts.pad ?? 0,
      userData: opts.userData ?? null,
      auto: opts.auto ?? false,
    });
    return id;
  }

  addStaticTriangles(positions, count, opts = {}) {
    return this.staticWorld.addTriangles(positions, count, opts);
  }

  removeStatic(id) {
    return this.staticWorld.remove(id);
  }

  setAutoScan(v) {
    this.autoScan = !!v;
    return this;
  }

  /**
   * Rebuild the BVH. Called automatically on `world:ready`; safe to call again
   * whenever `world` adds or removes colliders (a collapsed floor, an opened gate).
   */
  rebuild() {
    // Once `world` has registered even one collider explicitly it owns collision
    // completely, and the fallback scan retires itself. Anything else means an
    // author who deliberately left a decorative arch non-colliding gets it baked
    // in anyway — silently, and only noticeable as a player snagging on nothing.
    if (this.autoScan && this._hasExplicitColliders()) {
      this.autoScan = false;
      console.info('[physics] explicit colliders registered; scene auto-scan disabled');
    }
    if (this.autoScan && this.ctx) this._scanScene();
    this.staticWorld.build();
    this.ready = this.staticWorld.triCount > 0;
    this._rebuildsPending = false;
    if (this.ctx && this.staticWorld.triCount > 0) {
      const s = this.staticWorld;
      console.info(
        `[physics] BVH ${s.triCount} tris -> ${s.nodeCount} nodes ` +
        `(${s.leafCount} leaves, depth ${s.maxDepth}) in ${s.buildMs.toFixed(1)}ms`
      );
    }
    return this;
  }

  _hasExplicitColliders() {
    for (const o of this.staticWorld.objects) if (o && o.alive && !o.auto) return true;
    return false;
  }

  /**
   * Fallback collector, so physics is USEFUL from the first boot before `world`
   * has been written to register colliders explicitly — and so a world agent who
   * adds a prop and forgets to register it still gets collision rather than a
   * hole in the floor.
   *
   * SCOPE IS THE WHOLE POINT. We scan `world.root` when world exposes one, and
   * fall back to `ctx.scene` minus every other subsystem's root. Baking the
   * player capsule or an enemy mesh into the *static* BVH would weld actors to
   * the level and is the single worst failure mode this file could have, so the
   * exclusion list is belt AND braces: subtree scoping, per-subsystem root
   * exclusion, and a `mnDynamic`/`mnNoCollide` userData opt-out.
   *
   * Explicitly registered colliders are left alone; only `auto` ones are dropped
   * and recollected.
   */
  _scanScene() {
    const ctx = this.ctx;
    if (!ctx) return 0;
    this.staticWorld.removeAuto();

    // Anything owned by a gameplay subsystem is dynamic by definition.
    const excluded = new Set();
    for (const id of ['player', 'ai', 'fx', 'loot', 'ui', 'combat', 'sky']) {
      const sys = ctx.peek(id);
      if (sys?.root) excluded.add(sys.root);
      if (sys?.group) excluded.add(sys.group);
    }
    excluded.add(this.debug.object);

    const worldSys = ctx.peek('world');
    const scanRoot = worldSys?.collisionRoot ?? worldSys?.root ?? ctx.scene;

    const explicit = new Set();
    for (const o of this.staticWorld.objects) {
      if (o && o.alive && !o.auto && o.mesh) explicit.add(o.mesh);
    }

    let added = 0;
    const visit = (obj) => {
      if (excluded.has(obj)) return;
      const ud = obj.userData;
      if (ud?.mnNoCollide || ud?.mnDynamic) return;
      if (obj.visible === false) return;

      if ((obj.isMesh || obj.isInstancedMesh) && !explicit.has(obj)) {
        const geom = obj.geometry;
        const posAttr = geom?.getAttribute?.('position');
        if (posAttr) {
          // Very dense meshes become bounding boxes automatically. A 30k-triangle
          // decorative statue would otherwise dominate the whole level's build
          // time for collision nobody can feel.
          const triCount = (geom.getIndex() ? geom.getIndex().count : posAttr.count) / 3;
          const instances = obj.isInstancedMesh ? obj.count : 1;
          const box = ud?.mnCollideBox === true || triCount * instances > 20000;
          const id = this.staticWorld.addMesh(obj, {
            surface: ud?.mnSurface,
            layer: ud?.mnLayer ?? guessLayer(obj.name || obj.material?.name),
            box,
            auto: true,
          });
          if (id >= 0) added++;
        }
      }
      const kids = obj.children;
      for (let i = 0; i < kids.length; i++) visit(kids[i]);
    };
    visit(scanRoot);
    return added;
  }

  /* ================================================================ */
  /* 2. Raycasts and shape queries                                    */
  /* ================================================================ */

  /**
   * Closest hit along a ray. Returns the shared hit record or null.
   * `dir` is normalised internally, so callers may pass an unnormalised vector.
   */
  raycast(origin, dir, maxDist = 100, opts = null) {
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    return this.raycastFrom(origin.x, origin.y, origin.z, dir.x / l, dir.y / l, dir.z / l, maxDist, opts);
  }

  /** Scalar-argument raycast — no Vector3 required at the call site. */
  raycastFrom(ox, oy, oz, dx, dy, dz, maxDist = 100, opts = null) {
    const mask = opts?.mask ?? MASK.WORLD;
    const out = this._hit;
    const hitStatic = this.staticWorld.raycast(ox, oy, oz, dx, dy, dz, maxDist, mask, out);
    let best = hitStatic ? out.t : maxDist;

    if (opts?.includeBodies && this.bodies) {
      const b = this.bodies.raycast(ox, oy, oz, dx, dy, dz, best, this._hit2);
      if (b) {
        this._copyHit(this._hit2, out);
        best = out.t;
      }
    }

    if (opts?.includeActors) {
      const a = this._raycastActors(ox, oy, oz, dx, dy, dz, best, opts.ignore ?? null, this._hit2);
      if (a) {
        this._copyHit(this._hit2, out);
        best = out.t;
      }
    }

    if (!out.hit) {
      this.debug.logRay(ox, oy, oz, ox + dx * maxDist, oy + dy * maxDist, oz + dz * maxDist, false);
      return null;
    }
    syncHit(out);
    this.debug.logRay(ox, oy, oz, out.px, out.py, out.pz, true);
    return out;
  }

  _raycastActors(ox, oy, oz, dx, dy, dz, maxDist, ignore, out) {
    const hash = this.actors;
    const res = hash.queryCapsule(ox, oy, oz, ox + dx * maxDist, oy + dy * maxDist, oz + dz * maxDist,
      0.01, null, hash.scratch(), false);
    let best = maxDist, bestActor = null;
    for (let i = 0; i < res.count; i++) {
      const a = res.actors[i];
      if (a === ignore) continue;
      const ar = a.radius ?? 0.4;
      const ah = a.height ?? 1.8;
      const y0 = a.position.y + ar;
      const y1 = a.position.y + Math.max(ar, ah - ar);
      const t = rayCapsule(ox, oy, oz, dx, dy, dz, a.position.x, y0, a.position.z,
        a.position.x, y1, a.position.z, ar, best);
      if (t >= 0 && t < best) { best = t; bestActor = a; }
    }
    if (!bestActor) return null;
    clearHit(out);
    out.hit = true;
    out.t = best;
    out.px = ox + dx * best; out.py = oy + dy * best; out.pz = oz + dz * best;
    let nx = out.px - bestActor.position.x;
    let nz = out.pz - bestActor.position.z;
    const nl = Math.hypot(nx, nz) || 1;
    out.nx = nx / nl; out.ny = 0.15; out.nz = nz / nl;
    out.surfaceId = SURFACE.flesh;
    out.surface = 'flesh';
    out.kind = 'actor';
    out.actor = bestActor;
    out.mesh = bestActor.root ?? null;
    return bestActor;
  }

  _copyHit(src, dst) {
    dst.hit = src.hit; dst.t = src.t; dst.distance = src.t;
    dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
    dst.nx = src.nx; dst.ny = src.ny; dst.nz = src.nz;
    dst.tri = src.tri; dst.surfaceId = src.surfaceId; dst.surface = src.surface;
    dst.object = src.object; dst.layer = src.layer; dst.frontFace = src.frontFace;
    dst.kind = src.kind; dst.actor = src.actor; dst.body = src.body; dst.mesh = src.mesh;
    dst.contactS = src.contactS;
  }

  /** True when nothing blocks the segment a..b. `ai` perception's hot path. */
  lineOfSight(a, b, mask = MASK.SIGHT) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-5) return true;
    return !this.staticWorld.raycastAny(a.x, a.y, a.z, dx / d, dy / d, dz / d, d, mask);
  }

  /** Eye-height line of sight between two actors, allowing for their heights. */
  actorLineOfSight(a, b, mask = MASK.SIGHT) {
    const ay = a.position.y + (a.height ?? 1.8) * 0.8;
    const by = b.position.y + (b.height ?? 1.8) * 0.8;
    const dx = b.position.x - a.position.x;
    const dy = by - ay;
    const dz = b.position.z - a.position.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-5) return true;
    return !this.staticWorld.raycastAny(a.position.x, ay, a.position.z, dx / d, dy / d, dz / d, d, mask);
  }

  /**
   * Floor height and surface under (x, z). Returns null if there is no floor
   * within 60 m. `fromY` defaults to 20 m up, which clears every ceiling in a
   * dungeon whose tallest room is 12 m.
   */
  groundAt(x, z, fromY = 20, mask = MASK.WORLD) {
    if (!this.staticWorld.raycast(x, fromY, z, 0, -1, 0, 80, mask, this._hit2)) return null;
    this._groundResult.y = this._hit2.py;
    this._groundResult.normal.set(this._hit2.nx, this._hit2.ny, this._hit2.nz);
    this._groundResult.surface = this._hit2.surface;
    this._groundResult.surfaceId = this._hit2.surfaceId;
    return this._groundResult;
  }

  /** Snap a position onto the floor beneath it. Returns true if it found one. */
  dropToGround(vec3, fromY = 20, mask = MASK.WORLD) {
    const g = this.groundAt(vec3.x, vec3.z, fromY, mask);
    if (!g) return false;
    vec3.y = g.y;
    return true;
  }

  sweepSphere(origin, radius, dir, maxDist, opts = null) {
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const ok = this.staticWorld.sweepSphere(
      origin.x, origin.y, origin.z, radius,
      dir.x / l, dir.y / l, dir.z / l, maxDist,
      opts?.mask ?? MASK.WORLD, this._hit
    );
    return ok ? syncHit(this._hit) : null;
  }

  sweepCapsule(p0, p1, radius, dir, maxDist, opts = null) {
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const ok = this.staticWorld.sweepCapsule(
      p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, radius,
      dir.x / l, dir.y / l, dir.z / l, maxDist,
      opts?.mask ?? MASK.WORLD, this._hit
    );
    return ok ? syncHit(this._hit) : null;
  }

  /** Static overlap contacts. The returned struct is REUSED. */
  overlapSphere(centre, radius, mask = MASK.WORLD) {
    return this.staticWorld.overlapSphere(centre.x, centre.y, centre.z, radius, mask, this._contacts);
  }

  /** Nearest point on the level to `point`, as a hit record, or null. */
  closestSurface(point, maxDist = 3, mask = MASK.WORLD) {
    const tri = this.staticWorld.closestPoint(point.x, point.y, point.z, maxDist, mask, this._closest);
    if (tri < 0) return null;
    const out = clearHit(this._hit);
    out.hit = true;
    out.px = this._closest.bx; out.py = this._closest.by; out.pz = this._closest.bz;
    out.t = Math.sqrt(this._closest.d2);
    let nx = point.x - out.px, ny = point.y - out.py, nz = point.z - out.pz;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-5) { out.nx = nx / l; out.ny = ny / l; out.nz = nz / l; }
    else {
      out.nx = this.staticWorld.nrm[tri * 3];
      out.ny = this.staticWorld.nrm[tri * 3 + 1];
      out.nz = this.staticWorld.nrm[tri * 3 + 2];
    }
    out.tri = tri;
    out.surfaceId = this.staticWorld.surface[tri];
    out.surface = surfaceName(out.surfaceId);
    out.layer = this.staticWorld.layer[tri];
    out.object = this.staticWorld.object[tri];
    out.kind = 'static';
    return syncHit(out);
  }

  /**
   * Mouse picking. `ndc` in [-1,1]; returns the world hit under the cursor.
   * `ui` and `player` both need this and neither should own a Raycaster.
   */
  pickRay(ndcX, ndcY, camera, opts = null) {
    this._v0.set(ndcX, ndcY, 0.5).unproject(camera);
    this._v1.copy(this._v0).sub(camera.position).normalize();
    return this.raycastFrom(
      camera.position.x, camera.position.y, camera.position.z,
      this._v1.x, this._v1.y, this._v1.z,
      opts?.maxDist ?? 200,
      { mask: opts?.mask ?? MASK.PICK, includeActors: opts?.includeActors ?? false, ignore: opts?.ignore }
    );
  }

  /**
   * Where does the cursor ray meet the ground plane at height `y`?
   * The isometric camera makes this the default aim target for every skill, and
   * it must work even when the ray misses all geometry (aiming into fog).
   */
  pickGroundPlane(ndcX, ndcY, camera, y = 0, out = null) {
    this._v0.set(ndcX, ndcY, 0.5).unproject(camera);
    this._v1.copy(this._v0).sub(camera.position).normalize();
    const dst = out ?? this._v2;
    if (Math.abs(this._v1.y) < 1e-5) return null;
    const t = (y - camera.position.y) / this._v1.y;
    if (t < 0) return null;
    dst.copy(camera.position).addScaledVector(this._v1, t);
    return dst;
  }

  /* ================================================================ */
  /* 3. Character controllers                                         */
  /* ================================================================ */

  createCharacter(opts = {}) {
    const ch = new CharacterController(this.staticWorld, {
      gravity: this.gravity,
      radius: UNITS.playerRadius,
      height: UNITS.playerHeight,
      ...opts,
    });
    this.characters.push(ch);
    if (opts.actor) {
      this._charByActor.set(opts.actor, ch);
      if (opts.registerActor !== false) {
        this.registerActor(opts.actor, {
          radius: ch.radius, height: ch.height, weight: opts.weight,
        });
      }
    }
    return ch;
  }

  destroyCharacter(ch) {
    const i = this.characters.indexOf(ch);
    if (i >= 0) this.characters.splice(i, 1);
    if (ch?.actor) {
      this._charByActor.delete(ch.actor);
      this.unregisterActor(ch.actor);
    }
    ch?.dispose();
    return i >= 0;
  }

  /* ================================================================ */
  /* 4. Actors                                                        */
  /* ================================================================ */

  registerActor(actor, opts = {}) {
    return this.actors.add(actor, opts);
  }

  unregisterActor(actor) {
    return this.actors.remove(actor);
  }

  configureActor(actor, opts) {
    return this.actors.configure(actor, opts);
  }

  /** Allocate a query result you own. Use for anything kept past one statement. */
  createQueryResult(capacity) {
    const r = makeQueryResult(capacity ?? this.actors.capacity);
    this._userResults.push(r);
    return r;
  }

  queryRadius(position, radius, filter = null, out = undefined, spherical = false) {
    return this.actors.queryRadius(position.x, position.y, position.z, radius, filter, out, !spherical);
  }

  queryCone(origin, dir, range, halfAngle, filter = null, out = undefined, spherical = false) {
    return this.actors.queryCone(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      range, halfAngle, filter, out, !spherical);
  }

  queryCapsule(p0, p1, radius, filter = null, out = undefined, spherical = false) {
    return this.actors.queryCapsule(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, radius, filter, out, !spherical);
  }

  queryBox(centre, halfX, halfZ, yaw, filter = null, out = undefined) {
    return this.actors.queryBox(centre.x, centre.y, centre.z, halfX, halfZ, yaw, filter, out);
  }

  nearestActor(position, radius, filter = null) {
    return this.actors.nearest(position.x, position.y, position.z, radius, filter);
  }

  /** Sort a query result by ascending distance, in place. */
  sortByDistance(result) {
    return sortByDistance(result);
  }

  /* ================================================================ */
  /* 5. Rigid bodies                                                  */
  /* ================================================================ */

  spawnBody(opts) { return this.bodies.spawn(opts); }
  despawnBody(body) { return this.bodies.despawn(body); }

  applyImpulse(body, ix, iy, iz, px, py, pz) {
    body?.applyImpulse(ix, iy, iz, px, py, pz);
    return body;
  }

  /**
   * Radial impulse across every simulated thing. `combat` and `fx` call this for
   * explosions; it is also wired to the `fx:explosion` event so any subsystem can
   * trigger it without a direct dependency.
   *
   * `knockback` > 0 also shoves actors via their character controllers, which is
   * what turns a nova from a light show into a physical event.
   */
  explode(opts = {}) {
    const p = opts.position;
    if (!p) return null;
    const radius = opts.radius ?? 3;
    const strength = opts.strength ?? 30;
    const lift = opts.lift ?? 0.45;
    const res = { bodies: 0, ragdolls: 0, chains: 0, actors: 0 };

    if (opts.bodies !== false) res.bodies = this.bodies.applyRadialImpulse(p.x, p.y, p.z, radius, strength, lift);
    if (opts.ragdolls !== false) res.ragdolls = this.ragdolls.applyRadialImpulse(p.x, p.y, p.z, radius, strength, lift);
    if (opts.chains !== false) res.chains = this.constraints.applyRadialImpulse(p.x, p.y, p.z, radius * 1.6, strength);

    const kb = opts.knockback ?? 0;
    if (kb > 0 && opts.actors !== false) {
      const hit = this.actors.queryRadius(p.x, p.y, p.z, radius, opts.filter ?? null, this.actors.scratch(), true);
      for (let i = 0; i < hit.count; i++) {
        const a = hit.actors[i];
        const ch = this._characterOf(a);
        const falloff = 1 - clamp(hit.dist[i] / radius, 0, 1);
        const d = kb * falloff * falloff;
        if (ch) ch.pushBy(hit.dirX[i] * d, 0, hit.dirZ[i] * d);
        else if (a.position) { a.position.x += hit.dirX[i] * d; a.position.z += hit.dirZ[i] * d; }
        res.actors++;
      }
    }
    return res;
  }

  _characterOf(actor) {
    return this._charByActor.get(actor) ?? null;
  }

  /* ================================================================ */
  /* 6. Chains                                                        */
  /* ================================================================ */

  createChain(opts) { return this.constraints.create(opts); }
  createPendulum(opts) { return this.constraints.createPendulum(opts); }
  destroyChain(chain) { return this.constraints.destroy(chain); }

  /* ================================================================ */
  /* 7. Ragdolls                                                      */
  /* ================================================================ */

  spawnRagdoll(opts) { return this.ragdolls.spawn(opts); }
  despawnRagdoll(rag) { return this.ragdolls.despawn(rag); }
  nearestRagdoll(position, radius = 4) {
    return this.ragdolls.nearest(position.x, position.y, position.z, radius);
  }

  /* ================================================================ */
  /* 8. Projectiles                                                   */
  /* ================================================================ */

  spawnProjectile(opts) { return this.projectiles.spawn(opts); }
  despawnProjectile(p) { return this.projectiles.despawn(p); }

  /* ================================================================ */
  /* Simulation                                                       */
  /* ================================================================ */

  /**
   * All gameplay simulation, 60 Hz, deterministic.
   *
   * Order matters and is chosen so that everything a later subsystem queries this
   * step is already current:
   *   1. rebuild the actor hash from last step's final positions
   *   2. separate overlapping actors, then re-seat them against the level
   *   3. rigid bodies, chains, ragdolls, projectiles
   *
   * `player` and `ai` run their own fixedUpdate AFTER ours (registry order), so
   * they see a fresh hash and move into it.
   */
  fixedUpdate(h, ctx) {
    const t0 = performance.now();

    if (this._rebuildsPending) this.rebuild();

    this.actors.rebuild();
    // Separation writes straight into actor.position, so anything shoved has to
    // be re-checked against the walls or a crowded doorway pushes actors into
    // the masonry. The callback fires only for actors that actually moved.
    this.actors.separate(2, 0.5, this._reseat);

    this.bodies.step(h);
    this.constraints.step(h);
    this.ragdolls.step(h);
    this.projectiles.step(h);

    this._simMs = performance.now() - t0;
    // 0.1 IIR: enough smoothing to read in a probe, fast enough to show a spike.
    this._simMsAvg += (this._simMs - this._simMsAvg) * 0.1;
    this._frames++;
  }

  /** Bound in the constructor path so `separate` can call it without allocating. */
  _reseat = (actor) => {
    const ch = this._characterOf(actor);
    if (ch) ch.depenetrate(2);
  };

  /**
   * Per-frame, non-simulating work: interpolate rendered transforms between the
   * last two fixed steps and, when enabled, rebuild the debug lines.
   */
  update(dt, ctx) {
    const alpha = ctx.time.alpha;
    this.bodies.syncMeshes(alpha);
    this.ragdolls.syncMeshes(alpha);
    this.constraints.sync();

    if (this.debug.enabled) this._drawDebug();
  }

  _drawDebug() {
    const f = this.debug.flags;
    this.debug.begin();
    if (f.bvh || f.bvhLeaves) this.debug.drawBvh(this.staticWorld);
    if (f.tris) this.debug.drawTris(this.staticWorld);
    if (f.characters) this.debug.drawCharacters(this.characters);
    if (f.actors) this.debug.drawActors(this.actors);
    if (f.bodies) this.debug.drawBodies(this.bodies);
    if (f.ragdolls) this.debug.drawRagdolls(this.ragdolls);
    if (f.chains) this.debug.drawChains(this.constraints);
    if (f.projectiles) this.debug.drawProjectiles(this.projectiles);
    if (f.rays) this.debug.drawRays();
    this.debug.end();
  }

  /* ================================================================ */
  /* 9. Debug & stats                                                 */
  /* ================================================================ */

  setDebug(flags) {
    return this.debug.set(flags);
  }

  stats() {
    const s = this.staticWorld.stats();
    return {
      ready: this.ready,
      bvh: {
        tris: s.tris, nodes: s.nodes, leaves: s.leaves, depth: s.maxDepth,
        objects: s.objects, buildMs: s.buildMs, version: s.version,
      },
      queries: {
        rays: this.staticWorld.counters.rays,
        sweeps: this.staticWorld.counters.sweeps,
        overlaps: this.staticWorld.counters.overlaps,
        actor: this.actors.counters.queries,
        pairTests: this.actors.counters.pairTests,
      },
      actors: this.actors.stats(),
      characters: this.characters.length,
      bodies: this.bodies?.stats() ?? null,
      ragdolls: this.ragdolls?.stats() ?? null,
      projectiles: this.projectiles?.stats() ?? null,
      chains: this.constraints?.stats() ?? null,
      simMs: +this._simMsAvg.toFixed(3),
      frames: this._frames,
    };
  }

  /**
   * Self-test: builds a synthetic level, hammers every query path and reports
   * timings and correctness. Run it from the probe:
   *   node arpg/tools/probe.mjs --port=5284 --eval="ctx.peek('physics').selfTest()"
   *
   * This is the only place a raycast is timed. It exists because "did I break the
   * BVH" is a question that must be answerable in 15 seconds, not by looking at
   * a screenshot.
   */
  selfTest() {
    const out = { ok: true, checks: [] };
    const check = (name, pass, detail) => {
      out.checks.push({ name, pass, detail });
      if (!pass) out.ok = false;
    };

    const s = this.staticWorld;
    check('bvh built', s.nodeCount > 0, `${s.triCount} tris, ${s.nodeCount} nodes`);
    check('build time', s.buildMs < 400, `${s.buildMs.toFixed(1)}ms`);

    // --- raycast down onto the floor from above the origin ---
    const hit = this.raycastFrom(0, 12, 0, 0, -1, 0, 40, { mask: MASK.WORLD });
    check('downward ray hits floor', !!hit, hit ? `y=${hit.py.toFixed(3)} surface=${hit.surface}` : 'miss');

    // --- ray timing: 20k rays in a deterministic fan ---
    const N = 20000;
    let hits = 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = ((i * 7919) % 1000) / 1000 * Math.PI - Math.PI / 2;
      const dx = Math.cos(a) * Math.cos(b), dy = Math.sin(b), dz = Math.sin(a) * Math.cos(b);
      if (s.raycast(0, 1.4, 0, dx, dy, dz, 60, MASK.WORLD, this._hit2)) hits++;
    }
    const us = ((performance.now() - t0) * 1000) / N;
    check('raycast throughput', us < 12, `${us.toFixed(3)} us/ray, ${hits}/${N} hit`);

    // --- capsule sweep must not tunnel ---
    let tunnels = 0;
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2;
      const ox = Math.cos(a) * 25, oz = Math.sin(a) * 25;
      const dx = -Math.cos(a), dz = -Math.sin(a);
      // Sweep a player-sized capsule 50 m across the level at once; if any
      // geometry lies on the path it MUST report a hit.
      const blocked = s.raycastAny(ox, 1.0, oz, dx, 0, dz, 50, MASK.CHARACTER);
      const swept = s.sweepCapsule(ox, 0.36, oz, ox, 1.46, oz, 0.36, dx, 0, dz, 50, MASK.CHARACTER, this._hit2);
      if (blocked && !swept) tunnels++;
    }
    check('capsule sweep never tunnels', tunnels === 0, `${tunnels}/400 tunnelled`);

    // --- overlap symmetry: a point on a surface must report a contact ---
    let overlapOk = true;
    if (hit) {
      const c = s.overlapSphere(hit.px, hit.py + 0.05, hit.pz, 0.2, MASK.WORLD, this._contacts);
      overlapOk = c.count > 0;
    }
    check('overlap finds the floor', overlapOk);

    // --- a capsule standing on the floor must be able to WALK ---
    // This is the regression test for the classic conservative-advancement stall:
    // zero clearance to the floor underfoot makes a naive sweep refuse to advance.
    const walker = {
      id: '__walk', isPlayer: false, faction: 'enemy', alive: true,
      position: new THREE.Vector3(0, 0.05, 0), velocity: new THREE.Vector3(),
      radius: 0.36, height: 1.82,
    };
    const wch = new CharacterController(this.staticWorld, {
      actor: walker, radius: 0.36, height: 1.82, gravity: this.gravity,
    });
    wch.teleport(0, 0.2, 0);
    for (let i = 0; i < 40; i++) {
      walker.velocity.x = 6;
      walker.velocity.z = 0;
      wch.move(1 / 60);
    }
    check('character walks over open floor', walker.position.x > 3.2,
      `x=${walker.position.x.toFixed(2)} grounded=${wch.grounded} y=${walker.position.y.toFixed(3)}`);
    check('character stays on the floor', Math.abs(walker.position.y) < 0.05,
      `y=${walker.position.y.toFixed(4)}`);

    // --- doorway: a capsule aimed at a jamb must slide through, not stick ---
    // Two 3 m walls at z = 0 with a 1.0 m gap; the capsule is 0.72 m across and
    // starts offset so it strikes the corner rather than the opening.
    const doorTris = new Float32Array(4 * 9);
    let w = 0;
    const quad = (x0, x1) => {
      const y0 = 0, y1 = 3;
      doorTris.set([x0, y0, 0, x1, y0, 0, x1, y1, 0], w); w += 9;
      doorTris.set([x0, y0, 0, x1, y1, 0, x0, y1, 0], w); w += 9;
    };
    quad(-6, -0.5);
    quad(0.5, 6);
    const doorId = this.staticWorld.addTriangles(doorTris, 4, { surface: 'stone', name: '__door' });
    this.staticWorld.build();

    let through = 0, stuck = 0;
    for (let trial = 0; trial < 5; trial++) {
      // Approach angles that all clip the jamb: dead-on the corner, and either
      // side of it.
      const startX = -0.62 + trial * 0.31;
      walker.position.set(startX, 0, -2.2);
      walker.velocity.set(0, 0, 0);
      wch.teleport(startX, 0, -2.2);
      for (let i = 0; i < 120; i++) {
        walker.velocity.x = (0 - walker.position.x) * 1.2;
        walker.velocity.z = 6;
        wch.move(1 / 60);
      }
      if (walker.position.z > 0.6) through++; else stuck++;
    }
    check('capsule clears a doorway corner', stuck === 0, `${through}/5 through`);

    // --- dash speed must not tunnel the doorway wall ---
    walker.position.set(-3, 0, -2.5);
    wch.teleport(-3, 0, -2.5);
    let tunnelled = false;
    for (let i = 0; i < 30; i++) {
      walker.velocity.set(0, 0, 34); // 0.57 m per fixed step, vs a 0-thickness wall
      wch.move(1 / 60);
      if (walker.position.z > 0.2) { tunnelled = true; break; }
    }
    check('dash does not tunnel a wall', !tunnelled, `z=${walker.position.z.toFixed(3)}`);

    this.staticWorld.remove(doorId);
    this.staticWorld.build();
    wch.dispose();

    // --- actor hash round trip ---
    const probe = {
      id: '__selftest', position: new THREE.Vector3(0, 0, 0), velocity: new THREE.Vector3(),
      radius: 0.4, height: 1.8, alive: true, faction: 'enemy', isPlayer: false,
    };
    this.registerActor(probe);
    this.actors.rebuild();
    const r = this.actors.queryRadius(0, 0, 0, 2, null, this.actors.scratch(), true);
    let found = false;
    for (let i = 0; i < r.count; i++) if (r.actors[i] === probe) found = true;
    check('actor hash round trip', found, `${r.count} in radius`);
    const cone = this.actors.queryCone(-3, 0, 0, 1, 0, 0, 6, 0.6, null, this.actors.scratch(), true);
    let inCone = false;
    for (let i = 0; i < cone.count; i++) if (cone.actors[i] === probe) inCone = true;
    check('cone query', inCone, `${cone.count} in cone`);
    this.unregisterActor(probe);
    this.actors.rebuild();

    out.stats = this.stats();
    return out;
  }

  /**
   * Dynamic-path stress test: spawn debris, ragdolls, chains and projectiles,
   * simulate, and report cost plus sanity. DEV ONLY — it advances the RNG stream
   * and mutates world state, so it must never be called from gameplay.
   *
   *   node arpg/tools/probe.mjs --port=5284 \
   *     --eval="ctx.peek('physics').stressTest({ steps: 180 })"
   */
  stressTest(opts = {}) {
    const steps = opts.steps ?? 120;
    const debris = opts.debris ?? 64;
    const dolls = opts.ragdolls ?? 8;
    const shots = opts.projectiles ?? 40;
    const rng = this.rng ?? { range: (a, b) => (a + b) * 0.5, float: () => 0.5 };
    const out = { ok: true, checks: [] };
    const check = (name, pass, detail) => {
      out.checks.push({ name, pass, detail });
      if (!pass) out.ok = false;
    };

    this.bodies.clear();
    this.ragdolls.clear();
    this.projectiles.clear();
    this.constraints.clear();

    // ---- debris ----
    for (let i = 0; i < debris; i++) {
      const a = (i / debris) * Math.PI * 2;
      this.spawnBody({
        shape: i % 3 === 0 ? 'sphere' : 'box',
        size: { x: rng.range(0.06, 0.2), y: rng.range(0.06, 0.2), z: rng.range(0.06, 0.2) },
        radius: rng.range(0.06, 0.16),
        position: new THREE.Vector3(Math.cos(a) * 2, 2.5 + rng.range(0, 2), Math.sin(a) * 2),
        velocity: new THREE.Vector3(Math.cos(a) * 5, rng.range(1, 5), Math.sin(a) * 5),
        angular: new THREE.Vector3(rng.range(-9, 9), rng.range(-9, 9), rng.range(-9, 9)),
        surface: i % 4 === 0 ? 'metal' : 'stone',
        lifetime: 20,
      });
    }
    check('debris spawned', this.bodies.activeCount === Math.min(debris, this.bodies.capacity),
      `${this.bodies.activeCount}/${debris}`);
    const spawnedBodies = this.bodies.activeCount;

    // ---- ragdolls ----
    for (let i = 0; i < dolls; i++) {
      const a = (i / dolls) * Math.PI * 2;
      this.spawnRagdoll({
        position: new THREE.Vector3(Math.cos(a) * 4, 0.9, Math.sin(a) * 4),
        yaw: a,
        height: 1.8,
        velocity: new THREE.Vector3(Math.cos(a) * 3, 1, Math.sin(a) * 3),
        // A hard but plausible killing blow — see Ragdoll.impulseAt for the scale.
        impulse: { x: Math.cos(a) * 180, y: 90, z: Math.sin(a) * 180 },
        lifetime: 30,
      });
    }
    check('ragdolls spawned', this.ragdolls.activeCount === Math.min(dolls, this.ragdolls.capacity),
      `${this.ragdolls.activeCount}/${dolls}`);

    // ---- chains: a ring of hanging braziers ----
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.createPendulum({
        anchor: new THREE.Vector3(Math.cos(a) * 6, 5.2, Math.sin(a) * 6),
        length: 1.4, links: 4, mass: 32,
      });
    }
    check('chains created', this.constraints.activeCount === 6, `${this.constraints.activeCount}/6`);

    // ---- projectiles fired outward at the walls ----
    let hitCallbacks = 0;
    let hitSurfaces = 0;
    for (let i = 0; i < shots; i++) {
      const a = (i / shots) * Math.PI * 2;
      this.spawnProjectile({
        origin: new THREE.Vector3(0, 1.2, 0),
        direction: new THREE.Vector3(Math.cos(a), 0.05, Math.sin(a)),
        speed: 42,
        radius: 0.07,
        gravityScale: i % 2 === 0 ? 0 : 0.6,
        // Shorter than the simulated window, so a shot that flies out of the
        // level still has to have expired by the time we check.
        lifetime: 2,
        onHit: (h) => {
          hitCallbacks++;
          if (h.surface && typeof h.surface === 'string') hitSurfaces++;
          return 'stop';
        },
      });
    }

    // ---- simulate ----
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) this.fixedUpdate(1 / 60, this.ctx);
    const ms = performance.now() - t0;
    const perStep = ms / steps;

    // ---- sanity ----
    let nan = 0, below = 0, maxV = 0, maxW = 0;
    for (let i = 0; i < this.bodies.capacity; i++) {
      const b = this.bodies.bodies[i];
      if (!b.active) continue;
      if (!Number.isFinite(b.position.x + b.position.y + b.position.z)) nan++;
      if (b.position.y < -2) below++;
      maxV = Math.max(maxV, b.velocity.length());
      maxW = Math.max(maxW, b.angular.length());
    }
    let dollNan = 0, dollBelow = 0, settled = 0;
    for (let i = 0; i < this.ragdolls.capacity; i++) {
      const d = this.ragdolls.dolls[i];
      if (!d.active) continue;
      if (d.settled) settled++;
      for (let p = 0; p < d.px.length; p++) {
        if (!Number.isFinite(d.px[p] + d.py[p] + d.pz[p])) { dollNan++; break; }
        if (d.py[p] < -2) { dollBelow++; break; }
      }
    }
    let chainNan = 0, stretch = 0, worstStretch = 0;
    for (let i = 0; i < this.constraints.capacity; i++) {
      const c = this.constraints.chains[i];
      if (!c.active) continue;
      for (let p = 0; p < c.count - 1; p++) {
        const d = Math.hypot(c.px[p + 1] - c.px[p], c.py[p + 1] - c.py[p], c.pz[p + 1] - c.pz[p]);
        if (!Number.isFinite(d)) { chainNan++; break; }
        const err = Math.abs(d - c.linkLength) / c.linkLength;
        if (err > worstStretch) worstStretch = err;
        // Regression guard, not a physics ideal: the solver converges to ~2.8%
        // on the stiffest prop we ship (see constraints.js ITERS), so anything
        // past 4% means a constraint stopped being solved.
        if (err > 0.04) stretch++;
      }
    }

    check('no NaN in bodies', nan === 0, `${nan}`);
    check('bodies stay above the floor', below === 0, `${below} below y=-2`);
    // Debris that never sleeps costs a contact solve every frame for the rest of
    // the level; at ARPG debris counts that is the whole budget.
    check('debris goes to sleep', spawnedBodies === 0 || this.bodies.awakeCount <= spawnedBodies * 0.15,
      `${this.bodies.awakeCount}/${spawnedBodies} awake, maxV=${maxV.toFixed(3)} maxW=${maxW.toFixed(3)}`);
    check('no NaN in ragdolls', dollNan === 0, `${dollNan}`);
    check('ragdolls stay above the floor', dollBelow === 0, `${dollBelow} below y=-2`);
    check('ragdolls settle', settled > 0, `${settled}/${this.ragdolls.activeCount} settled`);
    check('no NaN in chains', chainNan === 0, `${chainNan}`);
    check('chains do not stretch', stretch === 0,
      `${stretch} bad links, worst ${(worstStretch * 100).toFixed(2)}%`);
    check('projectiles resolved', this.projectiles.activeCount === 0,
      `${this.projectiles.activeCount} still flying, ${hitCallbacks} onHit calls`);
    check('hits carry a surface', hitSurfaces === hitCallbacks, `${hitSurfaces}/${hitCallbacks}`);
    // The whole simulation layer must stay well under a millisecond per step on a
    // real machine; this container is ~5-10x slower than that, hence the ceiling.
    check('sim cost', perStep < 8, `${perStep.toFixed(3)} ms/step over ${steps} steps`);

    out.perStepMs = +perStep.toFixed(3);
    out.awakeBodies = this.bodies.awakeCount;
    out.stats = this.stats();

    this.bodies.clear();
    this.ragdolls.clear();
    this.projectiles.clear();
    this.constraints.clear();
    return out;
  }

  /* Shared vocabularies, re-exported so nobody has to import from this dir. */
  get SURFACES() { return SURFACE_NAMES; }
  get SURFACE() { return SURFACE; }
  get SURFACE_PROPS() { return SURFACE_PROPS; }
  get LAYER() { return LAYER; }
  get MASK() { return MASK; }
  surfaceName(i) { return surfaceName(i); }
  surfaceIndex(s) { return surfaceIndex(s); }
  surfaceProps(s) { return surfaceProps(surfaceIndex(s)); }
  guessSurface(name) { return surfaceName(guessSurface(name)); }
}

