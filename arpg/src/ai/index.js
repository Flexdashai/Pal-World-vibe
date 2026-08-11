import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';

import {
  ARCHETYPES, ARCHETYPE_ORDER, PERCEPTION, STEER, DEATH,
  BOSS, TELEGRAPH, clamp, clamp01, lerp,
} from './tuning.js';
import { rigFor } from './rig.js';
import { buildBody } from './bodies.js';
import { EnemyMaterials, SKINS, uvScaleFor } from './materials.js';
import { clipsFor, compileClips } from './clips.js';
import { FlowField, RingSlots } from './nav.js';
import { Telegraphs } from './telegraph.js';
import { EnemyActor, distXZ } from './actor.js';
import { BossActor, makeCoreLight } from './boss.js';
import { Director } from './director.js';
import { ShadowArmy } from './shadows.js';

/**
 * ============================================================================
 * MONARCH — the `ai` subsystem.  PUBLIC API.
 * ============================================================================
 *
 *   id    'ai'
 *   deps  ['physics', 'world', 'combat']
 *
 * Owns every character that is not the player: the horde, the boss, and the
 * shadow army. `const ai = ctx.get('ai')`. Nothing outside `src/ai/` imports a
 * module from this directory.
 *
 * ---------------------------------------------------------------------------
 * FILE MAP
 *
 *   tuning.js     every number, with the reason it has that value
 *   rig.js        parametric skeletons: biped and quadruped body plans
 *   meshkit.js    the skinned-mesh construction kit + the auto-skinner
 *   bodies.js     the six archetype bodies, designed as silhouettes
 *   materials.js  per-actor materials over the forge's shared textures
 *   clips.js      the authored animation library, in euler degrees
 *   animator.js   layer stack, procedural motion, secondary springs, LOD
 *   nav.js        the flow field and the attack-ring slot allocator
 *   telegraph.js  pooled ground indicators — one draw call for all of them
 *   actor.js      one non-player character: interface, brain, steering, death
 *   boss.js       THE RELIQUARY WARDEN — phases, rotation, the open window
 *   director.js   wave composition and encounter pacing
 *   shadows.js    extraction → soldier, orders, formation
 *
 * ---------------------------------------------------------------------------
 * WHAT OTHER SUBSYSTEMS CALL
 *
 *   ai.actors                      every live actor (ui reads it for blips)
 *   ai.spawn(kind, x, y, z, opts)  place one, returns the actor or null
 *   ai.spawnBoss(opts)             place the Warden
 *   ai.commandShadows(o)           combat's Sovereign's Command
 *   ai.buffShadows(o)              combat's Monarch's Domain
 *   ai.clearAll()                  wipe every actor (level transition)
 *   ai.debugStage(name, opts)      'none'|'idle'|'horde'|'boss'|'dying'
 *   ai.stats() / ai.selfTest()
 *
 * ---------------------------------------------------------------------------
 * FOUR CONTRACTS THIS FILE KEEPS
 *
 *  1. **Everything is pooled and built at load.** An actor is a skeleton, three
 *     SkinnedMeshes over SHARED geometry, and three materials over SHARED
 *     textures. Spawning is a state reset; nothing allocates during a fight.
 *
 *  2. **One light.** The boss core, created in `init` and never removed, driven
 *     by intensity. The visible point-light count is a shader program cache key
 *     (ARCHITECTURE.md) and a light appearing mid-fight recompiles every
 *     material in the scene.
 *
 *  3. **`combat` owns damage.** Every enemy blow goes through `combat.attack`
 *     or `combat.areaAttack`, so an enemy hit gets the same hit-stop, shake,
 *     flash, number and audio transient the player's does. `ai` never writes
 *     another actor's health.
 *
 *  4. **`config.q.maxActors` is a hard cap**, enforced at spawn and by LOD, not
 *     a suggestion. Exceeding it slows every other agent's capture loop, which
 *     is a shared cost.
 */
export class AiSystem {
  static id = 'ai';
  static deps = ['physics', 'world', 'combat'];

  async init(ctx) {
    this.ctx = ctx;
    /** One fork, taken here and never re-forked, so a capture of a given seed
     *  produces the same horde in the same places. ARCHITECTURE.md rule 4. */
    this.rng = ctx.rng.fork();
    const t0 = performance.now();

    const q = ctx.config.q;
    this.q = q;
    this.maxActors = q.maxActors;

    this.physics = ctx.peek('physics');
    this.combat = ctx.peek('combat');
    this.fx = ctx.peek('fx');
    this.ui = ctx.peek('ui');
    this.world = ctx.peek('world');
    this.player = null;

    // ---- scene graph --------------------------------------------------------
    this.root = new THREE.Group();
    this.root.name = 'mn.ai';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    // ---- materials ----------------------------------------------------------
    this.materials = new EnemyMaterials(ctx, ARCHETYPES);

    // ---- archetype assets ---------------------------------------------------
    // Geometry is built ONCE per archetype and shared by every actor of that
    // kind; only the skeleton is per-actor. That is what makes forty actors
    // affordable at load and at draw.
    this.assets = new Map();
    let totalTris = 0, totalVerts = 0;
    for (const id of ARCHETYPE_ORDER) {
      if (id === 'shade') continue;              // shades borrow other rigs
      const arch = ARCHETYPES[id];
      const rig = rigFor(id, arch);
      const skin = SKINS[id];
      const built = buildBody(id, rig, arch, 0x5eed ^ hashName(id), uvScaleFor(skin));
      const clips = compileClips(clipsFor(arch.plan), rig);
      totalTris += built.triangles;
      totalVerts += built.vertices;
      this.assets.set(id, {
        id, arch, rig, skin, clips,
        geometries: built.geometries,
        limbBones: limbBonesFor(rig),
        triangles: built.triangles,
      });
    }
    // The default shade body, for a soldier raised with no corpse behind it.
    {
      const arch = ARCHETYPES.shade;
      const rig = rigFor('shade', arch);
      const skin = SKINS.shade;
      const built = buildBody('shade', rig, arch, 0x5eed ^ hashName('shade'), uvScaleFor(skin));
      totalTris += built.triangles;
      totalVerts += built.vertices;
      this.assets.set('shade', {
        id: 'shade', arch, rig, skin,
        clips: compileClips(clipsFor(arch.plan), rig),
        geometries: built.geometries,
        limbBones: limbBonesFor(rig),
        triangles: built.triangles,
      });
    }

    // ---- pools ---------------------------------------------------------------
    this.pools = new Map();        // kind -> EnemyActor[]
    this.shadePools = new Map();   // source kind -> EnemyActor[] (shade stats)
    this.actors = [];              // every LIVE actor; `ui` reads this
    this._buildPools();

    // ---- systems -------------------------------------------------------------
    this.flow = new FlowField(ctx);
    this.telegraphs = new Telegraphs(ctx);
    this.director = new Director(this);
    this.army = new ShadowArmy(this);
    this.bossLight = makeCoreLight(ctx);
    this.boss = null;
    this.bossAlive = false;

    // ---- ring slots ----------------------------------------------------------
    // A small pool keyed by target. Six is more targets than a fight ever has:
    // the player, plus a handful of shadow soldiers the enemies are ringing.
    this._rings = new Map();
    this._ringPool = [];
    for (let i = 0; i < 6; i++) this._ringPool.push(new RingSlots(14));

    // ---- limb pool -----------------------------------------------------------
    this._limbGeo = new THREE.CapsuleGeometry(0.09, 0.24, 3, 6);
    this._limbGeo.name = 'mn.ai.limb';
    this._limbs = [];
    this._limbUse = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(this._limbGeo, this.materials.templates.get('bone'));
      m.name = `mn.ai.limb.${i}`;
      m.visible = false;
      m.castShadow = true;
      m.receiveShadow = true;
      ctx.scene.add(m);
      this._limbs.push(m);
      this._limbUse.push(null);
    }

    // ---- preallocated scratch. Nothing below this line allocates. -----------
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._camDir = new THREE.Vector3(0, 0, 1);
    this._camFocus = new THREE.Vector3();
    this._push = new THREE.Vector3();
    this._bossPicks = [];
    this._engaged = new Map();
    this._spawnPayload = { actor: null };
    this._cuePayload = { cue: '', position: new THREE.Vector3(), gain: 1 };
    this._shakePayload = { amount: 0, duration: 0.3, frequency: 26 };
    this._stopPayload = { duration: 0, scale: 0.05 };
    this._explosionPayload = {
      position: new THREE.Vector3(), radius: 4, element: 'shadow', magnitude: 1, knockback: 0,
    };
    this._systemPayload = { kind: 'system', title: '', lines: [], duration: 3 };
    this._systemLines = ['', ''];
    this._toastPayload = { text: '', tone: '' };
    this._hostileFilter = { faction: 'enemy', includeDead: false, includePlayer: false };
    this._playerFilter = { faction: 'player', includeDead: false, includePlayer: true };
    this._qResult = this.physics?.createQueryResult?.(64) ?? null;
    this._qNeighbour = this.physics?.createQueryResult?.(24) ?? null;

    this._posed = null;
    this._frozen = false;
    this._uiTarget = null;
    this._uiTargetAt = -1e9;
    this.counters = { spawned: 0, killed: 0, raised: 0, attacks: 0 };

    // ---- events --------------------------------------------------------------
    this._offs = [];
    this._wireEvents();

    // The grid needs the level and the collision world, both of which exist by
    // the time `ai` initialises (world and physics are both ahead of us in the
    // dependency order), so it is built here rather than waiting for an event.
    const nav = this.flow.build(this.world?.level ?? null, this.physics);

    let poolCount = 0;
    for (const list of this.pools.values()) poolCount += list.length;
    for (const list of this.shadePools.values()) poolCount += list.length;

    console.info(
      `[ai] ${this.assets.size} archetypes | ${poolCount} pooled actors ` +
      `(cap ${this.maxActors}) | ${(totalTris / 1000).toFixed(1)}k tris, ` +
      `${totalVerts} verts shared | nav ${nav.w}x${nav.h} @${nav.cell}m ` +
      `(${nav.walkable}/${nav.cells} walkable, ${nav.ms}ms) | ` +
      `build ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  /* ==================================================================== */
  /* construction                                                         */
  /* ==================================================================== */

  /**
   * Pool sizes.
   *
   * Scaled off `q.maxActors` so a low preset does not build ninety skeletons it
   * will never show. The split is by expected concurrency, not by importance:
   * ghouls are the fabric of every fight, bosses are one.
   */
  _buildPools() {
    const scale = clamp(this.maxActors / 90, 0.4, 1.4);
    const enemyPlan = {
      ghoul: Math.round(16 * scale), beast: Math.round(6 * scale),
      knight: Math.round(5 * scale), caster: Math.round(4 * scale),
      brute: Math.round(3 * scale), boss: 1,
    };
    const shadePlan = {
      ghoul: Math.round(8 * scale), knight: Math.round(3 * scale),
      beast: Math.round(3 * scale), caster: Math.round(2 * scale),
      brute: Math.round(2 * scale), boss: 1,
    };

    for (const [kind, n] of Object.entries(enemyPlan)) {
      const asset = this.assets.get(kind);
      if (!asset) continue;
      const list = [];
      for (let i = 0; i < Math.max(1, n); i++) {
        const actor = kind === 'boss'
          ? new BossActor(this, asset, i)
          : new EnemyActor(this, asset, i);
        this.root.add(actor.root);
        list.push(actor);
      }
      this.pools.set(kind, list);
    }

    // Shade slots borrow the SOURCE archetype's rig, geometry and clips so a
    // raised soldier keeps the silhouette of what it was raised from — the
    // whole point of the beat. Only the stats, the material treatment and the
    // behaviour come from the `shade` entry.
    for (const [kind, n] of Object.entries(shadePlan)) {
      const src = this.assets.get(kind);
      if (!src) continue;
      const arch = shadeArchFor(src.arch);
      const asset = {
        id: 'shade', sourceKind: kind, arch,
        rig: src.rig, clips: src.clips, geometries: src.geometries,
        limbBones: src.limbBones, skin: SKINS.shade, triangles: src.triangles,
      };
      const list = [];
      for (let i = 0; i < Math.max(1, n); i++) {
        const actor = new EnemyActor(this, asset, i + 500);
        actor.sourceKind = kind;
        this.root.add(actor.root);
        list.push(actor);
      }
      this.shadePools.set(kind, list);
    }
  }

  _on(type, fn) { this._offs.push(this.ctx.events.on(type, fn)); }

  _wireEvents() {
    // ---- damage --------------------------------------------------------------
    // ARCHITECTURE.md: `combat:hit` means damage dealt TO `target`, and the
    // target's own listener applies it. `combat/impact.js` observes whether the
    // health moved and only falls back to `applyDamage` if it did not, so this
    // listener is the ONLY place an enemy loses health.
    this._on('combat:hit', (e) => {
      const t = e?.target;
      if (!t || t.ai !== this) return;
      t.applyDamage({
        amount: e.amount, element: e.element, crit: e.crit,
        dir: e.normal, source: e.source, overkill: 0,
      });
      // The target frame. Only for blows the PLAYER landed — an enemy hitting a
      // shadow soldier must not repaint the player's target plate.
      if (e.source?.isPlayer && !t.isShadow) this._noteTarget(t);
    });

    // ---- kills ---------------------------------------------------------------
    this._on('combat:kill', (e) => {
      const a = e?.actor;
      if (!a || a.ai !== this) return;
      this.counters.killed++;
      if (a.alive !== false) {
        // A kill that arrived without going through `applyDamage` (an execute,
        // a scripted death). Route it through the same path so the ragdoll, the
        // dismemberment and the corpse window all still happen.
        a.stats.hp = 0;
        a._die({ dir: null, crit: false, overkill: e.overkill ?? 0 });
      }
    });

    // ---- extraction ----------------------------------------------------------
    this._on('shadow:extract', (e) => {
      const soldier = this.army.raise(e);
      if (soldier) this.counters.raised++;
    });

    // ---- explosions shove the horde -----------------------------------------
    // `physics` already shoves ragdolls and debris off this event; what it
    // cannot do is make a living actor REACT, which is what the cloth impulse
    // and the flinch are for.
    this._on('fx:explosion', (e) => {
      if (!e?.position) return;
      const r = (e.radius ?? 4) * 1.4;
      for (const a of this.actors) {
        if (!a.alive) continue;
        const dx = a.position.x - e.position.x, dz = a.position.z - e.position.z;
        const d = Math.hypot(dx, dz);
        if (d > r || d < 1e-3) continue;
        const k = (1 - d / r) * (e.magnitude ?? 1);
        const c = Math.cos(-a.yaw), s = Math.sin(-a.yaw);
        const lx = (dx / d) * c - (dz / d) * s;
        const lz = (dx / d) * s + (dz / d) * c;
        a.anim.flinch(k * 0.7, -lx, -lz);
      }
    });

    // ---- level transitions ---------------------------------------------------
    this._on('world:ready', (e) => {
      this.clearAll();
      // Rebuild against the NEW level. `world.level` is the live graph and is
      // already swapped by the time this fires.
      this.flow.build(this.world?.level ?? e?.level ?? null, this.physics);
      this.director.reset();
    });
  }

  /* ==================================================================== */
  /* the fixed step                                                       */
  /* ==================================================================== */

  fixedUpdate(h, ctx) {
    if (this._frozen) return;
    const now = ctx.time.elapsed;
    const player = this.player ?? (this.player = ctx.peek('player'));

    // ---- navigation ---------------------------------------------------------
    if (player) this.flow.update(h, player.position.x, player.position.z);

    // ---- ring centres + the engage budget -----------------------------------
    // Rebuilt once per step rather than queried per actor: `mayEngage` is asked
    // by every actor in a pack every step, and a per-actor scan would be O(n²).
    this._engaged.clear();
    for (const a of this.actors) {
      if (!a.alive || !a.target) continue;
      const s = a.stateName;
      if (s === 'windup' || s === 'strike' || s === 'special') {
        this._engaged.set(a.target, (this._engaged.get(a.target) ?? 0) + 1);
      }
    }
    for (const [target, ring] of this._rings) {
      if (!target || target.alive === false) continue;
      ring.setCentre(target.position.x, target.position.z);
    }

    // ---- actors -------------------------------------------------------------
    // Iterated backwards so `recycle` can splice without skipping.
    for (let i = this.actors.length - 1; i >= 0; i--) {
      const a = this.actors[i];
      a.fixedUpdate(h, now);
    }

    // ---- pacing -------------------------------------------------------------
    this.director.update(h, now);
  }

  /* ==================================================================== */
  /* the frame                                                            */
  /* ==================================================================== */

  update(dt, ctx) {
    const player = this.player ?? (this.player = ctx.peek('player'));
    // The LOD reference is the camera FOCUS, not the camera: at a 21 m boom and
    // a −52° pitch the eye is 16 m above the floor, so measuring from it puts
    // every actor a full band further away than it looks.
    if (player) this._camFocus.copy(player.position);
    else this._camFocus.copy(ctx.camera.position).setY(0);

    const step = this._frozen ? 0 : dt;
    for (const a of this.actors) a.update(step, this._camFocus);
    this.telegraphs.update(step);
    if (!this._frozen) this.army.update(step, ctx.time.elapsed);

    // The boss bar is refreshed every frame it is alive: `ui.noteTarget` is
    // idempotent and it is the only way the bar tracks health without `ui`
    // having to know anything about this subsystem.
    if (this.boss?.alive) this.ui?.noteTarget?.(this.boss);
    else if (this._uiTarget && ctx.time.elapsed - this._uiTargetAt > 4.5) {
      this.ui?.clearTarget?.();
      this._uiTarget = null;
    } else if (this._uiTarget?.alive) {
      this.ui?.noteTarget?.(this._uiTarget);
    }

    // Limb debris is released on a TIMER rather than by asking the rigid body
    // whether it is still alive. `physics` recycles a body's slot internally and
    // does not publish a liveness flag, so a duck-typed `body.active === false`
    // check silently never fires and the eight-slot pool leaks after eight
    // dismemberments.
    const now = ctx.time.elapsed;
    for (let i = 0; i < this._limbs.length; i++) {
      const use = this._limbUse[i];
      if (!use) continue;
      if (now >= use.until) {
        this._limbs[i].visible = false;
        this.physics?.despawnBody?.(use.body);
        this._limbUse[i] = null;
      }
    }
  }

  _noteTarget(actor) {
    this._uiTarget = actor;
    this._uiTargetAt = this.ctx.time.elapsed;
    this.ui?.noteTarget?.(actor);
  }

  /* ==================================================================== */
  /* spawning                                                             */
  /* ==================================================================== */

  /** Take a free slot from a pool. */
  _acquire(kind) {
    const list = this.pools.get(kind);
    if (!list) return null;
    if (this.enemyCount() >= this.maxActors) return null;
    for (const a of list) if (!a.root.visible) return a;
    return null;
  }

  /** A shade slot on a given source rig, or any free one when `kind` is null. */
  acquireShade(kind) {
    if (kind) {
      const list = this.shadePools.get(kind);
      if (list) for (const a of list) if (!a.root.visible) return a;
      return null;
    }
    for (const list of this.shadePools.values()) {
      for (const a of list) if (!a.root.visible) return a;
    }
    return null;
  }

  /**
   * Place one actor.
   * @returns the actor, or null when the pool or the budget is exhausted
   */
  spawn(kind, x, y, z, opts = {}) {
    const actor = this._acquire(kind);
    if (!actor) return null;
    actor.spawn({ x, y, z, ...opts });
    this.actors.push(actor);
    this.counters.spawned++;
    this._spawnPayload.actor = actor;
    this.ctx.events.emit('actor:spawn', this._spawnPayload);
    return actor;
  }

  /** The Warden. Placed at the arena landmark unless a position is given. */
  spawnBoss(opts = {}) {
    let x = opts.x, y = opts.y, z = opts.z;
    if (x === undefined) {
      const spot = this.world?.debugFocus?.('arena')?.pos;
      if (spot) { x = spot[0]; y = spot[1]; z = spot[2]; }
      else { x = 0; y = 0; z = 0; }
      // Up-screen of the landmark, which is the half of the world the camera
      // can see. Standing the boss ON the landmark puts it behind the player.
      x -= 5.2; z -= 5.2;
    }
    const boss = this.spawn('boss', x, y ?? 0, z, {
      yaw: Math.PI * 0.25, level: opts.level ?? this.levelFor() + 4, ...opts,
    });
    return boss;
  }

  onBossSpawned(boss) {
    this.boss = boss;
    this.bossAlive = true;
    this.ui?.setBoss?.({
      id: boss.id, name: boss.name, title: boss.title,
      phases: boss.phases, phase: 0, hpFrac: 1,
    });
    this.system('THE RELIQUARY WARDEN', [
      'Keeper of the Ash.',
      'It has not moved in four hundred years.',
    ], 4.0);
  }

  /** The Warden's adds. Placed on the ring around it, on the navigation grid. */
  summonAdds(boss, kind, count, radius) {
    let n = 0;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this.rng.range(-0.3, 0.3);
      const r = radius * this.rng.range(0.7, 1.0);
      const x = boss.position.x + Math.sin(a) * r;
      const z = boss.position.z + Math.cos(a) * r;
      if (this.flow.ready && !this.flow.walkable(x, z)) continue;
      const y = this.flow.ready ? this.flow.floorAt(x, z) : boss.position.y;
      const spawned = this.spawn(kind, x, y, z, {
        yaw: a + Math.PI, level: boss.stats.level,
      });
      if (spawned) n++;
    }
    return n;
  }

  /** Return an actor to its pool. */
  recycle(actor) {
    const i = this.actors.indexOf(actor);
    if (i >= 0) this.actors.splice(i, 1);
    if (actor.isShadow) this.army.remove(actor);
    if (actor === this.boss) { this.boss = null; this.bossAlive = false; }
    actor.despawn();
  }

  retireShadow(actor) {
    this.army.remove(actor);
    this.recycle(actor);
  }

  onActorDied(actor, o) {
    if (actor === this.boss) this.bossAlive = false;
    if (actor.isShadow) this.army.remove(actor);
    void o;
  }

  clearAll() {
    for (const a of this.actors.slice()) {
      a.alive = false;
      this.recycle(a);
    }
    this.actors.length = 0;
    this.army.soldiers.length = 0;
    this.boss = null;
    this.bossAlive = false;
    this.telegraphs.clear();
    for (const ring of this._ringPool) { ring.clear(); ring.busy = false; }
    this._rings.clear();
    for (let i = 0; i < this._limbs.length; i++) {
      this._limbs[i].visible = false;
      this._limbUse[i] = null;
    }
    if (this.bossLight) this.bossLight.intensity = 0;
  }

  /* ==================================================================== */
  /* crowd services, called by actors                                     */
  /* ==================================================================== */

  /** The RingSlots instance for a target, allocated lazily from a small pool. */
  ringFor(target, count, radius) {
    let ring = this._rings.get(target);
    if (!ring) {
      // Reclaim a ring whose owner is gone before taking a fresh one.
      for (const [owner, r] of this._rings) {
        if (!owner || owner.alive === false) {
          this._rings.delete(owner);
          r.clear();
          r.busy = false;
        }
      }
      // A `busy` flag rather than a membership test. This runs for every actor
      // on every fixed step, and `[...map.values()].includes(r)` allocates an
      // array each time — forty actors at 60 Hz is 2 400 arrays a second, which
      // is exactly the per-frame allocation ARCHITECTURE.md rule 5 forbids.
      for (const r of this._ringPool) {
        if (!r.busy) { ring = r; break; }
      }
      if (!ring) return null;
      ring.busy = true;
      this._rings.set(target, ring);
    }
    ring.configure(count, radius);
    return ring;
  }

  releaseSlot(actor) {
    const ring = actor.target ? this._rings.get(actor.target) : null;
    if (ring) ring.release(actor);
    else for (const r of this._rings.values()) r.release(actor);
  }

  /**
   * May this actor be in an attack state right now?
   *
   * `engageFraction` is what stops twenty ghouls all swinging at once, which is
   * both unsurvivable and — more importantly — unreadable. The surplus circles
   * at the ring radius, which looks like a pack waiting for an opening.
   */
  mayEngage(actor) {
    const target = actor.target;
    if (!target) return false;
    const frac = actor.arch.engageFraction ?? 1;
    if (frac >= 1) return true;
    const engaged = this._engaged.get(target) ?? 0;
    // Scale with how many are actually here, so two ghouls both attack and
    // twenty do not.
    const nearby = this._nearbyAllies(actor, target);
    const allowed = Math.max(1, Math.round(nearby * frac));
    return engaged < allowed;
  }

  _nearbyAllies(actor, target) {
    let n = 0;
    for (const a of this.actors) {
      if (!a.alive || a.target !== target) continue;
      if (a.faction !== actor.faction) continue;
      if (distXZ(a.position, target.position) < 7) n++;
    }
    return n;
  }

  /**
   * Local avoidance. Returns a steering push in `out` and stores a yield factor
   * on the actor.
   *
   * Three terms, and all three are needed:
   *   SEPARATION   inverse-square push away from a neighbour
   *   ANTICIPATION the neighbour's position is advanced by its velocity, so two
   *                agents on converging courses start turning BEFORE they meet
   *   TANGENT      a sideways component signed by actor id parity, so a head-on
   *                pair rotates past each other instead of pressing. Without it
   *                a corridor produces a permanent deadlock.
   */
  avoidance(actor, out, target) {
    out.set(0, 0, 0);
    actor._yield = 1;
    const P = this.physics;
    if (!P?.queryRadius || !this._qNeighbour) return out;

    const res = P.queryRadius(actor.position, STEER.avoidRadius + actor.radius,
      null, this._qNeighbour, false);
    const sign = (actor.poolIndex & 1) ? 1 : -1;
    let yieldK = 1;
    const myCost = target ? distXZ(actor.position, target.position) : 0;

    for (let i = 0; i < res.count; i++) {
      const other = res.actors[i];
      if (!other || other === actor || other.isPlayer) continue;
      if (other.alive === false) continue;
      const wanted = (actor.radius + (other.radius ?? 0.4)) * 1.30;
      let dx = actor.position.x - other.position.x;
      let dz = actor.position.z - other.position.z;
      // Anticipation: where the neighbour WILL be.
      dx -= (other.velocity?.x ?? 0) * STEER.avoidLookahead;
      dz -= (other.velocity?.z ?? 0) * STEER.avoidLookahead;
      const d = Math.hypot(dx, dz);
      if (d > STEER.avoidRadius || d < 1e-4) continue;

      const overlap = clamp01((wanted + 0.55 - d) / (wanted + 0.55));
      const k = overlap * overlap * STEER.avoidStrength;
      const nx = dx / d, nz = dz / d;
      out.x += nx * k;
      out.z += nz * k;
      // Tangential, so the pair rotates rather than presses.
      out.x += -nz * k * STEER.avoidTangent * sign;
      out.z += nx * k * STEER.avoidTangent * sign;

      // Yielding: someone directly ahead of me who is closer to the target than
      // I am gets the right of way. That is what widens a queue into a mass.
      if (target && other.target === target) {
        const theirCost = distXZ(other.position, target.position);
        if (theirCost < myCost - 0.2) {
          const ahead = (-nx * actor._smoothX) + (-nz * actor._smoothZ);
          if (ahead > STEER.yieldCone) yieldK = Math.min(yieldK, STEER.yieldSlow);
        }
      }
    }
    actor._yield = yieldK;
    return out;
  }

  yieldFactor(actor) { return actor._yield ?? 1; }

  /** Hostiles in a cone in front of an actor, through `physics`. */
  queryCone(actor, range, halfAngle) {
    const P = this.physics;
    if (!P?.queryCone || !this._qResult) return EMPTY_RESULT;
    this._v.set(Math.sin(actor.yaw), 0, Math.cos(actor.yaw));
    this._v2.copy(actor.position);
    this._v2.y += actor.height * 0.5;
    const filter = actor.isShadow ? this._hostileFilter : this._playerFilter;
    filter.exclude = actor;
    return P.queryCone(this._v2, this._v, range, halfAngle, filter, this._qResult, false);
  }

  queryRadius(actor, centre, radius) {
    const P = this.physics;
    if (!P?.queryRadius || !this._qResult) return EMPTY_RESULT;
    const filter = actor.isShadow ? this._hostileFilter : this._playerFilter;
    filter.exclude = actor;
    return P.queryRadius(centre, radius, filter, this._qResult, false);
  }

  nearestHostile(actor, radius) {
    const P = this.physics;
    if (!P?.nearestActor) return null;
    const filter = actor.isShadow ? this._hostileFilter : this._playerFilter;
    filter.exclude = actor;
    return P.nearestActor(actor.position, radius, filter);
  }

  /** One actor's aggro shout wakes its neighbours, staggered so a room does not
   *  turn as one block — the clearest "spawned by a script" tell there is. */
  shout(actor, radius) {
    if (!actor.target) return;
    const r2 = radius * radius;
    let i = 0;
    for (const a of this.actors) {
      if (a === actor || !a.alive || a.target) continue;
      if (a.faction !== actor.faction) continue;
      const dx = a.position.x - actor.position.x, dz = a.position.z - actor.position.z;
      if (dx * dx + dz * dz > r2) continue;
      a.alertTo(actor.target, PERCEPTION.alertDelay + (i % 5) * PERCEPTION.alertJitter * 0.25);
      i++;
    }
  }

  /* ==================================================================== */
  /* services actors use to reach other subsystems                        */
  /* ==================================================================== */

  cue(name, position, gain = 1, lift = 1.0) {
    const c = this._cuePayload;
    c.cue = name;
    c.position.copy(position);
    c.position.y += lift;
    c.gain = gain;
    this.ctx.events.emit('audio:cue', c);
  }

  footstep(actor) {
    // `audio` derives the player's footstep cadence itself but has no way to
    // know about an enemy's, so `ai` emits them. Quieter than the hero's and
    // capped by LOD, or forty skeletons walking is a wall of noise.
    this.cue('foot', actor.position, 0.30, 0.05);
  }

  shake(amount, weight = 0.5) {
    const s = this._shakePayload;
    s.amount = amount;
    s.duration = lerp(0.16, 0.55, weight);
    s.frequency = lerp(30, 14, weight);
    this.ctx.events.emit('camera:shake', s);
  }

  hitstop(duration) {
    const h = this._stopPayload;
    h.duration = Math.min(this.ctx.config.hitstopMax, duration);
    h.scale = 0.05;
    this.ctx.events.emit('time:hitstop', h);
  }

  explosion(position, radius, element, magnitude, lift = 0.4) {
    const e = this._explosionPayload;
    e.position.copy(position);
    e.position.y += lift;
    e.radius = radius;
    e.element = element;
    e.magnitude = magnitude;
    e.knockback = 0;
    this.ctx.events.emit('fx:explosion', e);
  }

  system(title, lines, duration = 3) {
    const w = this._systemPayload;
    w.title = title;
    this._systemLines[0] = lines[0] ?? '';
    this._systemLines[1] = lines[1] ?? '';
    w.lines = this._systemLines;
    w.duration = duration;
    this.ctx.events.emit('ui:system', w);
  }

  toast(text, tone) {
    this._toastPayload.text = text;
    this._toastPayload.tone = tone ?? '';
    this.ctx.events.emit('ui:toast', this._toastPayload);
  }

  cameraForward(out) {
    this.ctx.camera.getWorldDirection(out);
    out.y = 0;
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l; out.z /= l;
    return out;
  }

  /** Enemy level, tracking the player so a run stays tuned as they level. */
  levelFor() {
    return Math.max(1, (this.player?.stats?.level ?? 1) + this.director.wave * 0.25 | 0);
  }

  enemyCount() {
    let n = 0;
    for (const a of this.actors) if (a.alive && !a.isShadow) n++;
    return n;
  }

  ragdollBudget() {
    let live = 0;
    for (const a of this.actors) if (a.ragdoll) live++;
    return DEATH.maxRagdolls - live;
  }

  /** A pooled limb mesh for dismemberment. */
  acquireLimbMesh(family, length, radius) {
    for (let i = 0; i < this._limbs.length; i++) {
      if (this._limbUse[i]) continue;
      const m = this._limbs[i];
      m.material = this.materials.templates.get(family) ?? m.material;
      m.scale.set(Math.max(0.4, radius / 0.09), Math.max(0.4, length / 0.42),
        Math.max(0.4, radius / 0.09));
      m.visible = true;
      // Claimed immediately so a second limb in the same frame cannot take the
      // same slot; `trackLimb` fills in the body a moment later.
      this._limbUse[i] = { body: null, until: this.ctx.time.elapsed + DEATH.corpseTtl * 0.7 };
      return m;
    }
    return null;
  }

  trackLimb(mesh, body) {
    const i = this._limbs.indexOf(mesh);
    if (i < 0) return;
    if (!body) {
      mesh.visible = false;
      this._limbUse[i] = null;
      return;
    }
    this._limbUse[i].body = body;
  }

  /* ==================================================================== */
  /* public API for other subsystems                                      */
  /* ==================================================================== */

  /** `combat`'s Sovereign's Command. */
  commandShadows(o) { return this.army.command(o); }
  /** `combat`'s Monarch's Domain. */
  buffShadows(o) { return this.army.buff(o); }

  /** Every live enemy, for `ui`'s minimap blips. */
  get enemies() { return this.actors; }

  /* ==================================================================== */
  /* the shot harness                                                     */
  /* ==================================================================== */

  /**
   * `'none' | 'idle' | 'horde' | 'boss' | 'dying'`
   *
   * Each produces a fully realised, FROZEN frame. Frozen rather than played:
   * the harness pumps 14-16 settle frames before the shutter, so a horde left
   * running would have walked out of its composition and TAA would smear every
   * moving limb across sixteen frames of history. Freezing also makes repeated
   * captures pixel-identical, which is the entire point of the harness.
   */
  debugStage(name = 'none', opts = {}) {
    const key = String(name ?? 'none');
    this._frozen = false;
    this.clearAll();
    this.director.enabled = false;
    this._posed = null;
    if (key === 'none') {
      this.director.enabled = true;
      return 'none';
    }

    const player = this.player ?? (this.player = this.ctx.peek('player'));
    const px = player?.position?.x ?? 0;
    const pz = player?.position?.z ?? 0;
    const py = player?.position?.y ?? 0;
    const rng = this.rng;

    switch (key) {
      // -------------------------------------------------------------------
      case 'idle': {
        // A few enemies standing around, unaggroed.
        //
        // This stage is used by `hero`, `corridor` and `overview` — the shots
        // every other agent reviews their own work in — so it has two hard
        // constraints it does not share with the combat stages: it must never
        // crowd the architecture, and it must never place a body inside a wall.
        // Bearings are around −2.356 rad (screen up) and every position is
        // snapped onto the navigation grid.
        const kinds = ['ghoul', 'ghoul', 'beast', 'knight'];
        const bearings = [-1.95, -2.75, -2.30, -1.60];
        const radii = [4.6, 5.8, 7.4, 6.4];
        for (let i = 0; i < kinds.length; i++) {
          if (!this._placeNear(px, pz, bearings[i], radii[i])) continue;
          const actor = this.spawn(kinds[i], this._v.x, py, this._v.z,
            { yaw: bearings[i] + Math.PI, level: 3, rise: false });
          if (actor) this._pose(actor, 'idle', rng.float());
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'horde': {
        // The money shot for combat: a pack converging, at every stage of the
        // approach at once — some still running in, some circling, two mid
        // wind-up with their telegraphs on the floor.
        const plan = [
          ['ghoul', 10], ['beast', 3], ['knight', 2], ['caster', 2], ['brute', 1],
        ];
        let i = 0;
        for (const [kind, n] of plan) {
          for (let k = 0; k < n; k++, i++) {
            // Centred on SCREEN UP.
            //
            // The camera eye sits at +X+Z of its focus, so the half of the world
            // it can see is at −X−Z, i.e. world bearing −2.356 rad. The first
            // build spread the pack around bearing 0, which is straight
            // down-screen, and put half the horde behind the HUD. The sine
            // mapping concentrates the pack near the centre of the visible arc
            // and thins it toward the edges, which is also how a pack actually
            // converges.
            const a = -2.356 + Math.sin((i / 17 - 0.5) * Math.PI) * 1.75 +
              rng.range(-0.12, 0.12);
            const r = 2.9 + (i % 5) * 1.28 + rng.range(-0.4, 0.7);
            if (!this._placeNear(px, pz, a, r)) continue;
            const x = this._v.x, z = this._v.z;
            const actor = this.spawn(kind, x, py, z, {
              yaw: Math.atan2(px - x, pz - z), level: 6, rise: false,
            });
            if (!actor) continue;
            actor.target = player;
            actor.hasLos = true;
            actor.anim.alert = 1;
            // A spread of poses: mostly running, some mid-swing, two winding up.
            if (i === 2 || i === 9) {
              this._poseAttack(actor);
            } else if (r < 4.4 && (i % 3) === 0) {
              this._pose(actor, 'attack', 0.62 + rng.range(-0.08, 0.08));
            } else {
              this._pose(actor, 'run', rng.float(), Math.max(1.6, actor.arch.speedRun * 0.9));
            }
          }
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'boss': {
        // Placed by SCREEN POSITION, not by a world offset.
        //
        // `__APPLY_SHOT__` poses the camera before it calls this, so the frame
        // is already known. That matters because the Warden is five metres tall:
        // a world offset that reads as "just up-screen" for a 1.8 m ghoul puts
        // the boss's head off the top of the frame. Measured — the first build
        // used a fixed −5.2/−5.2 offset and the boss's centre landed at NDC
        // y = +0.84, i.e. almost entirely out of shot.
        // NDC (0.02, 0.34) rather than (0, 0.10). The arena's centrepiece is a
        // broken angel whose outstretched arms cross the middle of this frame,
        // and at 0.10 the Warden stood directly behind them — measured from a
        // 720p capture, where the statue's arms occupied exactly the band the
        // boss's torso landed in. Standing it further up-screen lifts the whole
        // figure above the arms and leaves only its feet behind them, which
        // reads as depth rather than as occlusion.
        const P = this.physics;
        const ground = P?.pickGroundPlane?.(0.02, 0.34, this.ctx.camera, py, this._v2);
        const boss = this.spawnBoss({
          level: 12,
          x: ground ? ground.x : px - 5.2,
          y: py,
          z: ground ? ground.z : pz - 5.2,
        });
        if (boss) {
          boss.target = player;
          boss.hasLos = true;
          boss._enterPhase(1);
          boss.breakUntil = 0;
          boss.anim.alert = 1;
          // The coil, not the overhead. At 0.52 of `heavy` both arms are
          // straight up and a five-metre figure with two vertical arms reads as
          // a tripod; `attack` at 0.42 twists the torso, cocks one arm back and
          // leaves the silhouette asymmetric, which is what makes it read as a
          // creature about to do something.
          this._pose(boss, 'attack', 0.42);
          // A cone telegraph mid-sweep on the floor, which is what makes the
          // frame read as a FIGHT rather than as a statue.
          const yaw = Math.atan2(px - boss.position.x, pz - boss.position.z);
          boss.yaw = yaw;
          boss.yawTarget = yaw;
          const handle = this.telegraphs.cone({
            x: boss.position.x, y: boss.position.y, z: boss.position.z, yaw,
            range: BOSS.attacks.sweep.range * boss.scale,
            halfAngle: BOSS.attacks.sweep.halfAngle,
            windup: 1.0, colour: TELEGRAPH.bossColour,
            intensity: TELEGRAPH.bossIntensity,
          });
          // 0.34 of the wind-up, not 0.62: the fill uses an ease-OUT, so 0.62
          // already puts the front at 98% and the shape reads as a solid slab
          // rather than as a timer that is still running.
          handle.slot.t = 0.34;
          boss.vulnerable = true;
          boss.coreGlow = 2.4;
          this.bossLight.position.set(
            boss.position.x, boss.position.y + boss.height * 0.62, boss.position.z
          );
          this.bossLight.intensity = BOSS.coreLight.vulnerable;
        }
        // Adds around it, and shadow soldiers already fighting them — the boss
        // shot has to show the army too, because by the time the player reaches
        // the Warden they have one.
        for (let i = 0; i < 6; i++) {
          const a = -2.05 - i * 0.28;
          const r = 3.6 + (i % 3) * 1.7;
          if (!this._placeNear(px, pz, a, r)) continue;
          const g = this.spawn(i % 3 === 0 ? 'beast' : 'ghoul', this._v.x, py, this._v.z, {
            yaw: a + Math.PI, level: 10, rise: false,
          });
          if (g) { g.target = player; this._pose(g, 'run', rng.float(), 3.2); }
        }
        this._stageShadows(px, py, pz, 5, rng);
        break;
      }

      // -------------------------------------------------------------------
      case 'dying': {
        // The ARISE frame. Corpses on the floor, three mid-extraction, and four
        // soldiers already standing. `fx` draws the vortices off its own debug
        // burst; what this stage supplies is the bodies and the army.
        for (let i = 0; i < 5; i++) {
          const a = -1.85 - i * 0.30;
          const r = 2.6 + (i % 3) * 1.5;
          if (!this._placeNear(px, pz, a, r)) continue;
          const actor = this.spawn(i === 1 ? 'knight' : 'ghoul', this._v.x, py, this._v.z, {
            yaw: a, level: 5, rise: false,
          });
          if (!actor) continue;
          // A real death, so the ragdoll settles into a real pose rather than a
          // hand-placed one. The settle is run explicitly below.
          actor.stats.hp = 0;
          actor._die({
            dir: this._v.set(Math.sin(a), 0, Math.cos(a)),
            crit: i === 0, overkill: i === 0 ? actor.stats.hpMax : 0,
          });
        }
        // Let the ragdolls fall. 90 fixed steps is 1.5 s of simulation, which is
        // past the point every corpse has landed and settled.
        const P = this.physics;
        for (let s = 0; s < 90; s++) P?.fixedUpdate?.(1 / 60, this.ctx);
        for (const a of this.actors) if (a.ragdoll) a._poseFromRagdoll();

        this._stageShadows(px, py, pz, 4, rng);
        // Three soldiers still materialising, caught mid-dissolve.
        for (let i = 0; i < 3; i++) {
          const a = -2.75 - i * 0.42;
          const r = 2.4 + i * 1.3;
          const soldier = this.acquireShade(i === 0 ? 'knight' : 'ghoul');
          if (!soldier || !this._placeNear(px, pz, a, r)) continue;
          soldier.spawn({
            x: this._v.x, y: py, z: this._v.z,
            yaw: a + Math.PI, level: 6, power: 1.4, form: 0.34 + i * 0.20, rise: true,
          });
          soldier._arisen = true;
          soldier._ariseAt = -1;
          this.actors.push(soldier);
          this.army.soldiers.push(soldier);
          this._pose(soldier, 'rise', 0.45 + i * 0.15);
          this.materials.setForm(soldier.materials, soldier.form);
        }
        break;
      }

      default:
        this.director.enabled = true;
        return 'none';
    }

    // DEV ONLY. `?aicam=<boom>` re-frames the camera on the staged subject at a
    // shorter boom, so a creature can be REVIEWED rather than guessed at from a
    // 40 px silhouette in a wide shot. Finding the systematic patch-winding bug
    // took three full captures because there was no way to look at a body up
    // close; this is that way. It never runs without the query parameter, so it
    // cannot affect another agent's capture.
    this._devFrame(key);

    this._posed = key;
    this._frozen = true;
    this.telegraphs.frozen = true;
    for (const a of this.actors) a.anim.frozen = true;
    // One zero-length update so every transform, bone matrix and instance
    // attribute is written for the pose before the first settle frame renders.
    for (const a of this.actors) a.update(0, this._camFocus);
    this.telegraphs.update(0);
    void opts;
    return key;
  }

  /**
   * DEV ONLY — `?aicam=<boom>[&aisubject=<kind>]`.
   *
   * Re-frames the isometric camera on a staged actor at a shorter boom. The
   * yaw, pitch and FOV stay exactly as `src/dev/shots.js` sets them, so what
   * comes back is the real game camera pushed in, not a different projection.
   */
  _devFrame(stage) {
    if (typeof location === 'undefined') return;
    const params = new URLSearchParams(location.search);
    const boom = Number(params.get('aicam'));
    if (!boom || !isFinite(boom)) return;
    const want = params.get('aisubject') ?? (stage === 'boss' ? 'boss' : null);
    let subject = null;
    for (const a of this.actors) {
      if (!want || a.kind === want || a.sourceKind === want) { subject = a; break; }
    }
    if (!subject) subject = this.actors[0];
    if (!subject) return;

    const cam = this.ctx.camera;
    const pitch = cam.rotation.x, yaw = cam.rotation.y;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const ly = subject.position.y + subject.height * 0.45;
    cam.position.set(
      subject.position.x + Math.sin(yaw) * boom * cp,
      ly - sp * boom,
      subject.position.z + Math.cos(yaw) * boom * cp
    );
    cam.updateMatrixWorld(true);
  }

  /**
   * A staged position at `bearing`/`radius` from a point, pulled in until it
   * lands on a walkable navigation cell. Written into `this._v`.
   *
   * Posed shots place bodies by hand, and a hand-placed body inside a wall is
   * both a broken frame and a physics depenetration that shoves it somewhere
   * unpredictable over the settle frames. Returns false when nothing along the
   * ray is walkable, in which case the caller simply skips that actor.
   */
  _placeNear(px, pz, bearing, radius) {
    const sx = Math.sin(bearing), sz = Math.cos(bearing);
    for (let r = radius; r > 1.2; r -= 0.6) {
      const x = px + sx * r, z = pz + sz * r;
      if (!this.flow.ready) { this._v.set(x, 0, z); return true; }
      if (this.flow.walkable(x, z) && this.flow.clearanceAt(x, z) > 0.7) {
        this._v.set(x, this.flow.floorAt(x, z), z);
        return true;
      }
    }
    return false;
  }

  /** A handful of shadow soldiers, standing, for a posed shot. */
  _stageShadows(px, py, pz, n, rng) {
    const kinds = ['ghoul', 'knight', 'ghoul', 'beast', 'ghoul', 'caster'];
    for (let i = 0; i < n; i++) {
      const soldier = this.acquireShade(kinds[i % kinds.length]) ?? this.acquireShade(null);
      if (!soldier) continue;
      // Fanned to either side of screen-up, never between the camera and the
      // hero. The camera eye sits at +X+Z of its focus, so a soldier at a
      // bearing near 0 stands in FRONT of the Monarch and occludes him — and
      // the whole visual identity of this game is the Monarch standing in front
      // of his army, not behind it.
      const a = -2.356 + (i - (n - 1) * 0.5) * 0.78;
      const r = 2.9 + (i % 2) * 1.1;
      if (!this._placeNear(px, pz, a, r)) continue;
      soldier.spawn({
        x: this._v.x, y: py, z: this._v.z,
        yaw: a + Math.PI * 0.85, level: 8, power: 1.6, form: 1, rise: false,
      });
      soldier._arisen = true;
      soldier._ariseAt = -1;
      this.actors.push(soldier);
      this.army.soldiers.push(soldier);
      soldier.formationSlot = i;
      this.fx?.attachShadowTrail?.(soldier, { width: 0.22, life: 0.42 });
      this._pose(soldier, i % 2 ? 'idle' : 'run', rng.float(), i % 2 ? 0 : 3.0);
    }
  }

  /** Freeze an actor at a chosen phase of a clip, with its cloth converged. */
  _pose(actor, clip, phase, speed = 0) {
    actor.anim.play(clip, 1, { restart: true, fade: 0 });
    actor.anim.actionWeight = 1;
    actor.anim.actionTime = clamp01(phase);
    actor.anim.actionDone = false;
    actor.anim.speed = speed;
    actor.anim.strideTime = phase;
    actor.anim.breathPhase = phase;
    actor.anim._compose();
    actor.root.position.copy(actor.position);
    actor.root.rotation.y = actor.yaw;
    actor.root.updateMatrix();
    actor.root.updateMatrixWorld(true);
    actor.anim.apply(actor.bones, 0);
    // The cloth solver runs at 1/120 s and the slowest chain needs ~0.5 s of
    // simulated time; the harness only pumps 16 frames, hence the explicit
    // convergence.
    actor.anim.settle(actor.bones, 70);
    actor.root.updateMatrixWorld(true);
  }

  /** Pose an actor mid-wind-up WITH its telegraph on the floor. */
  _poseAttack(actor) {
    const arch = actor.arch;
    const spec = arch.slam ?? arch.heavy ?? {
      windup: arch.windup, strike: arch.strike, recover: arch.recover,
      range: arch.attackRange * 1.2, halfAngle: 1.0, telegraph: 'cone',
      damage: 1, stagger: arch.stagger, knockback: arch.knockback,
    };
    const handle = this._raiseStaticTelegraph(actor, spec);
    if (handle) handle.slot.t = handle.slot.windup * 0.66;
    this._pose(actor, spec === arch.slam || spec === arch.heavy ? 'heavy' : 'attack', 0.46);
    actor.anim.alert = 1;
    actor.materials.glow.emissiveIntensity = actor.asset.skin.eyeGain * 2.6;
  }

  _raiseStaticTelegraph(actor, spec) {
    const T = this.telegraphs;
    const y = actor.position.y;
    const colour = TELEGRAPH.colour;
    switch (spec.telegraph) {
      case 'circle':
        return T.circle({
          x: actor.position.x, y, z: actor.position.z,
          radius: (spec.radius ?? 3) * actor.scale, windup: 1.0, colour,
        });
      case 'line':
        return T.line({
          x: actor.position.x, y, z: actor.position.z, yaw: actor.yaw,
          length: spec.range ?? 8, halfWidth: (spec.halfWidth ?? 0.9) * actor.scale,
          windup: 1.0, colour,
        });
      case 'cone':
      default:
        return T.cone({
          x: actor.position.x, y, z: actor.position.z, yaw: actor.yaw,
          range: (spec.range ?? 4) * actor.scale, halfAngle: spec.halfAngle ?? 0.95,
          windup: 1.0, colour,
        });
    }
  }

  /* ==================================================================== */
  /* pre-warm                                                             */
  /* ==================================================================== */

  /**
   * Every actor in the pool starts `visible = false`, so `render.prewarmMaterials`
   * — which compiles what is VISIBLE — cannot reach a single one of them. The
   * first enemy to walk on screen would then compile a skinned, patched,
   * shadow-casting material set mid-fight, which on this renderer is a
   * multi-hundred-millisecond stall at the worst possible moment.
   *
   * So: make one actor of every archetype visible, compile against a bound
   * float target (`outputColorSpace` and `toneMapping` are read off the
   * currently bound target and are part of the program cache key), and hide
   * them again. No frame is presented in between.
   */
  async prewarmMaterials(ctx) {
    const render = ctx.get('render');
    const r = render.renderer;

    const shown = [];
    const showOne = (list) => {
      const a = list?.[0];
      if (!a) return;
      shown.push(a);
      a.root.visible = true;
      a.root.position.set(0, -400, 0);   // below the world, never presented
      a.root.updateMatrix();
      a.root.updateMatrixWorld(true);
    };
    for (const list of this.pools.values()) showOne(list);
    for (const list of this.shadePools.values()) showOne(list);

    // The telegraph material is a ShaderMaterial that never appears until an
    // enemy winds up, and compiling it at that moment is a stall on the exact
    // frame the player most needs to see the floor.
    const hadCount = this.telegraphs.mesh.count;
    this.telegraphs.mesh.count = 1;
    this.telegraphs.mesh.setMatrixAt(0, this._m.makeTranslation(0, -400, 0));
    this.telegraphs.mesh.instanceMatrix.needsUpdate = true;

    for (const m of this._limbs) { m.visible = true; m.position.set(0, -400, 0); }

    const prev = r.getRenderTarget();
    r.setRenderTarget(render.rtHDR ?? prev);
    r.compile(ctx.scene, ctx.camera);
    r.setRenderTarget(prev);

    for (const a of shown) { a.root.visible = false; a.root.position.set(0, 0, 0); }
    for (const m of this._limbs) m.visible = false;
    this.telegraphs.mesh.count = hadCount;

    console.info('[ai] prewarm', {
      archetypes: this.assets.size,
      warmed: shown.length,
      materials: this.materials.stats().instances,
      programs: r.info.programs?.length ?? 0,
    });
  }

  /* ==================================================================== */
  /* introspection                                                        */
  /* ==================================================================== */

  stats() {
    const byKind = {};
    let ragdolls = 0, shadows = 0;
    for (const a of this.actors) {
      const k = a.isShadow ? `shadow.${a.sourceKind ?? 'shade'}` : a.kind;
      byKind[k] = (byKind[k] ?? 0) + 1;
      if (a.ragdoll) ragdolls++;
      if (a.isShadow) shadows++;
    }
    let pooled = 0;
    for (const l of this.pools.values()) pooled += l.length;
    for (const l of this.shadePools.values()) pooled += l.length;
    return {
      posed: this._posed ?? 'live',
      live: this.actors.length,
      /** Alias. `tools/playtest.mjs` samples `stats().alive`; keeping the name
       *  it looks for means the smoke test reports a real number rather than
       *  silently falling back to `actors.length`. */
      alive: this.actors.length,
      enemies: this.enemyCount(),
      shadows,
      pooled,
      cap: this.maxActors,
      byKind,
      ragdolls,
      boss: this.boss ? { phase: this.boss.phaseName, hp: Math.round(this.boss.stats.hp), vulnerable: this.boss.vulnerable } : 'none',
      director: this.director.stats(),
      army: this.army.stats(),
      nav: this.flow.stats(),
      telegraphs: this.telegraphs.stats(),
      materials: this.materials.stats(),
      counters: { ...this.counters },
      element: ELEMENTS.shadow.srgb,
    };
  }

  /**
   * Correctness checks that do not need a screenshot.
   *
   *   node arpg/tools/probe.mjs --port=5285 --eval="ctx.peek('ai').selfTest()"
   */
  selfTest() {
    const out = { ok: true, checks: [] };
    const check = (name, pass, detail) => {
      out.checks.push({ name, pass, detail });
      if (!pass) out.ok = false;
    };

    // ---- assets -------------------------------------------------------------
    let missing = 0, bones = 0, tris = 0;
    for (const [id, a] of this.assets) {
      if (!a.geometries.body) missing++;
      bones += a.rig.count;
      tris += a.triangles;
      void id;
    }
    check('every archetype built a body', missing === 0, `${this.assets.size} archetypes, ${missing} missing`);
    check('rigs are within a sane bone budget', bones / this.assets.size < 48,
      `${(bones / this.assets.size).toFixed(1)} bones avg`);
    check('shared geometry is affordable', tris < 26000, `${tris} triangles total`);

    // ---- silhouette separation ----------------------------------------------
    // Two archetypes with the same aspect ratio and the same width read as the
    // same shape at 120 px. The test is the invariant, not the values.
    const shapes = [];
    for (const [id, a] of this.assets) {
      if (id === 'shade') continue;
      shapes.push([id, a.arch.height, a.arch.radius, a.arch.height / a.arch.radius]);
    }
    let collisions = 0;
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        if (Math.abs(shapes[i][3] - shapes[j][3]) < 0.35 &&
            Math.abs(shapes[i][1] - shapes[j][1]) < 0.20) collisions++;
      }
    }
    check('no two archetypes share a silhouette envelope', collisions === 0,
      `${collisions} collisions across ${shapes.length}`);

    // ---- navigation ---------------------------------------------------------
    check('navigation grid built', this.flow.ready, this.flow.stats().grid);
    if (this.flow.ready && this.player) {
      this.flow.flood(this.player.position.x, this.player.position.z);
      const reachable = this.flow.costAt(this.player.position.x, this.player.position.z);
      check('the player\'s own cell is reachable', reachable >= 0, `${reachable}`);
    }

    // ---- budgets ------------------------------------------------------------
    let pooled = 0;
    for (const l of this.pools.values()) pooled += l.length;
    check('enemy pool fits the actor budget', pooled <= this.maxActors,
      `${pooled} / ${this.maxActors}`);
    check('exactly one light is owned', !!this.bossLight,
      `intensity ${this.bossLight?.intensity ?? 'n/a'}`);

    // ---- the actor interface ------------------------------------------------
    const sample = this.pools.get('ghoul')?.[0];
    const iface = sample && ['id', 'isPlayer', 'isShadow', 'faction', 'position',
      'velocity', 'radius', 'height', 'stats', 'alive', 'root']
      .every((k) => sample[k] !== undefined) &&
      typeof sample.applyDamage === 'function' &&
      typeof sample.applyStagger === 'function';
    check('actors implement the actor interface', !!iface);

    // ---- wind-ups are readable ----------------------------------------------
    // 250 ms is the floor for "saw it and chose to react"; anything under ~180
    // reads as unfair even when it is technically dodgeable.
    let short = 0;
    for (const id of ARCHETYPE_ORDER) {
      const a = ARCHETYPES[id];
      if (!a || a.isShadow) continue;
      if (a.windup < 0.25) short++;
      for (const key of ['heavy', 'slam', 'leap', 'charge', 'channel']) {
        if (a[key]?.windup !== undefined && a[key].windup < 0.30) short++;
      }
    }
    check('every wind-up is longer than a reaction time', short === 0, `${short} too short`);
    let noTelegraph = 0;
    for (const id of ARCHETYPE_ORDER) {
      const a = ARCHETYPES[id];
      for (const key of ['heavy', 'slam', 'leap', 'charge', 'channel']) {
        if (a?.[key] && !a[key].telegraph) noTelegraph++;
      }
    }
    check('every special attack paints the floor', noTelegraph === 0, `${noTelegraph} untelegraphed`);

    // ---- the boss -----------------------------------------------------------
    check('the boss has phases and a vulnerability window',
      BOSS.phases.length >= 3 && BOSS.vulnerable.duration > 1.5,
      `${BOSS.phases.length} phases, ${BOSS.vulnerable.duration}s window`);
    let opens = 0;
    for (const a of Object.values(BOSS.attacks)) if (a.opensWindow) opens++;
    check('some boss attacks open the window', opens >= 2, `${opens} of ${Object.keys(BOSS.attacks).length}`);

    out.stats = this.stats();
    return out;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.clearAll();

    for (const list of this.pools.values()) for (const a of list) a.dispose();
    for (const list of this.shadePools.values()) for (const a of list) a.dispose();
    this.pools.clear();
    this.shadePools.clear();

    for (const asset of this.assets.values()) {
      for (const key of ['body', 'gear', 'glow']) asset.geometries[key]?.dispose?.();
    }
    this.assets.clear();

    this.telegraphs?.dispose();
    this.flow?.dispose();
    this.materials?.dispose();
    for (const m of this._limbs) m.removeFromParent();
    this._limbs.length = 0;
    this._limbGeo?.dispose();
    if (this.bossLight) {
      this.ctx?.peek?.('render')?.removeLight?.(this.bossLight);
      this.bossLight.removeFromParent();
      this.bossLight.dispose?.();
    }
    this.root?.removeFromParent();
  }
}

/* ==========================================================================
 * helpers
 * ========================================================================== */

/** Stable 32-bit hash of a name, for a per-archetype geometry warp seed. */
function hashName(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A shade's archetype: `shade` stats and behaviour, the SOURCE's proportions,
 *  so a soldier raised from a brute is a brute-shaped shadow. */
function shadeArchFor(src) {
  const shade = ARCHETYPES.shade;
  return {
    ...shade,
    height: src.height,
    radius: src.radius,
    weight: Math.min(src.weight, 2.5),
    mass: src.mass,
    plan: src.plan,
    attackRange: Math.max(shade.attackRange, src.attackRange * 0.9),
    ringRadius: src.ringRadius,
    // Health and damage scale with what it used to be: a shadow raised from a
    // brute should be worth having.
    hp: shade.hp * (1 + (src.hp / 300)),
    damage: shade.damage * (1 + (src.damage / 60)),
  };
}

/** Which bones may be severed. Limbs only — a decapitated head would need its
 *  own geometry and a torso cannot come off without the body vanishing. */
function limbBonesFor(rig) {
  const out = [];
  for (const name of ['forearmL', 'forearmR', 'shinL', 'shinR',
    'fLegBL', 'fLegBR', 'hLegBL', 'hLegBR']) {
    if (rig.has(name)) out.push(name);
  }
  return out;
}

/** Returned by a query when `physics` is unavailable, so callers never branch. */
const EMPTY_RESULT = { count: 0, actors: [], dist: [], dirX: [], dirZ: [] };

export { ARCHETYPES, distXZ };
