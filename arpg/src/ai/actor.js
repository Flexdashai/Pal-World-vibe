import * as THREE from 'three';
import { Animator } from './animator.js';
import {
  PERCEPTION, STEER, NAV, ANIM, SHADOW, DEATH, TELEGRAPH,
  clamp, clamp01, lerp, angleDelta, approachAngle, smoothstep,
} from './tuning.js';

/**
 * MONARCH — one non-player character.
 *
 * Pooled. An actor is built once, at load, with its own skeleton, its own three
 * SkinnedMeshes (sharing the archetype's geometry) and its own three materials
 * (sharing the forge's textures), and is then recycled forever. Nothing here
 * allocates after `init`.
 *
 * ---------------------------------------------------------------------------
 * THE BEHAVIOUR MODEL
 *
 * A flat state machine, because a behaviour tree for six archetypes is a
 * framework nobody can read and this fits on two screens:
 *
 *   idle        no target. Breathing, occasional look-around.
 *   alert       target acquired; a beat of reaction before moving. The beat is
 *               not decoration — an enemy that starts sprinting on the exact
 *               frame it sees you reads as a trigger volume.
 *   chase       drive toward the claimed ring slot through the flow field
 *   circle      in position but not permitted to attack (see engageFraction);
 *               strafe around the target at the ring radius
 *   windup      committed. The telegraph is up, movement is mostly locked.
 *   strike      the damage frame
 *   recover     the window the player is paid with
 *   special     an archetype ability with its own script (leap, charge, channel)
 *   stagger     hit reaction; movement locked, actions cancelled
 *   dead        the ragdoll owns the body
 *
 * ---------------------------------------------------------------------------
 * WHY A CROWD DOES NOT BECOME A CONGA LINE OR A BLOB
 *
 * Four mechanisms, in order of how much work each does:
 *
 *  1. RING SLOTS. Every attacker has a DIFFERENT destination — an angular slot
 *     around the target — so the crowd encircles instead of converging.
 *  2. ENGAGE FRACTION. Only a fraction of a pack may be in an attack state at
 *     once; the rest circle at the ring radius. Twenty ghouls all swinging is
 *     unsurvivable and, worse, unreadable.
 *  3. ANTICIPATORY AVOIDANCE. Neighbours are avoided at where they WILL be, not
 *     where they are, and the avoidance has a tangential component signed by
 *     actor id so two agents meeting head-on rotate past each other instead of
 *     pressing.
 *  4. YIELDING. An agent whose path is blocked by a neighbour that is closer to
 *     the target slows down instead of pushing. That is what widens a corridor
 *     queue into a mass.
 */

const S = {
  IDLE: 0, ALERT: 1, CHASE: 2, CIRCLE: 3, WINDUP: 4, STRIKE: 5,
  RECOVER: 6, SPECIAL: 7, STAGGER: 8, DEAD: 9, MATERIALISE: 10,
};
const S_NAME = ['idle', 'alert', 'chase', 'circle', 'windup', 'strike',
  'recover', 'special', 'stagger', 'dead', 'materialise'];

let _uid = 0;

export class EnemyActor {
  /**
   * @param ai      the AiSystem
   * @param asset   the archetype asset bundle from `index.js`
   * @param index   pool index within the archetype, used for deterministic
   *                per-instance variation — never Math.random
   */
  constructor(ai, asset, index) {
    this.ai = ai;
    this.ctx = ai.ctx;
    this.asset = asset;
    this.kind = asset.id;
    this.poolIndex = index;

    const arch = asset.arch;
    this.arch = arch;

    // ---- actor interface (ARCHITECTURE.md) ---------------------------------
    this.id = `ai.${asset.id}.${index}.${_uid++}`;
    this.name = arch.name;
    this.title = arch.title ?? null;
    this.isPlayer = false;
    this.isShadow = !!arch.isShadow;
    this.isBoss = !!arch.isBoss;
    this.isElite = arch.rank === 'elite';
    this.rank = arch.rank;
    this.faction = this.isShadow ? 'player' : 'enemy';
    this.surface = arch.surface;
    this.archetype = asset.id;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.radius = arch.radius;
    this.height = arch.height;
    this.weight = arch.weight;
    this.alive = false;
    this.stats = {
      hp: 1, hpMax: 1, armour: 0, poise: arch.poise, level: 1,
      damage: arch.damage, shadowPower: arch.damage,
      critChance: 0.05, critDamage: 1.6,
    };
    this.staggerUntil = 0;
    this.staggered = false;
    this.vulnerable = false;
    this.hitFlash = 0;

    // ---- scene graph --------------------------------------------------------
    this.root = new THREE.Group();
    this.root.name = `mn.ai.${this.id}`;
    this.root.visible = false;
    this.root.matrixAutoUpdate = false;

    const made = asset.rig.make();
    this.bones = made.bones;
    this.skeleton = made.skeleton;
    this.root.add(made.root);

    this.materials = {
      body: ai.materials.clone(asset.skin.body),
      gear: ai.materials.clone(asset.skin.gear),
      glow: ai.materials.clone('glow'),
    };
    this.meshes = [];
    const identity = new THREE.Matrix4();
    for (const slot of ['body', 'gear', 'glow']) {
      const geo = asset.geometries[slot];
      if (!geo) continue;
      const mesh = new THREE.SkinnedMesh(geo, this.materials[slot]);
      mesh.name = `${this.root.name}.${slot}`;
      mesh.castShadow = true;
      mesh.receiveShadow = slot !== 'glow';
      // The bind-pose bounding sphere is wrong the moment an arm goes overhead,
      // and `build()` already set a generous manual one, so culling is honest.
      mesh.frustumCulled = true;
      mesh.bindMode = THREE.AttachedBindMode;
      mesh.bind(this.skeleton, identity);
      mesh.matrixAutoUpdate = false;
      if (slot === 'glow') {
        // Into render's bloom-only emissive buffer. 1.6 rather than 3: the eyes
        // are a few hundred square pixels of near-clipping emissive and a wider
        // halo erases the head they are supposed to be in. The boss gets 0.9,
        // because its `glow` part is not a pair of eyes — it is a 0.6 m sphere
        // and a set of seams, and at 1.6 the bloom from it swallowed the whole
        // torso the cavity is cut into.
        mesh.userData.mnGlow = this.isBoss ? 0.9 : 1.6;
        mesh.castShadow = false;
      }
      this.root.add(mesh);
      this.meshes.push(mesh);
    }

    // ---- animation ----------------------------------------------------------
    this.anim = new Animator(asset.rig, asset.clips);
    this.anim.runSpeed = arch.speedRun;
    this.anim.onEvent = (name) => this._onAnimEvent(name);
    // Deterministic per-instance phase offset. Without it a row of skeletons
    // breathes and walks in perfect unison, which is the single clearest tell
    // that they are one mesh drawn twenty times.
    this.anim.stridePhase = ((index * 2654435761) >>> 0) / 4294967296;

    // ---- physics ------------------------------------------------------------
    this.char = null;

    // ---- state --------------------------------------------------------------
    this.state = S.IDLE;
    this.stateT = 0;
    this.target = null;
    this.targetSeenAt = -1e9;
    this.lastLosAt = -1e9;
    this.hasLos = false;
    this.yaw = 0;
    this.yawTarget = 0;
    this.attackCd = 0;
    this.specialCd = 0;
    this.retargetAt = 0;
    this.threat = new Map();
    this.slot = -1;
    this.engaged = false;
    this.blocking = false;
    this.parryUntil = 0;
    this.lodBand = 0;
    this.spawnedAt = 0;
    this.expiresAt = Infinity;
    this.buffDamage = 1;
    this.buffHaste = 1;
    this.buffUntil = 0;
    this.orderTarget = null;
    this.orderUntil = 0;
    this.formationSlot = 0;
    this.form = 1;                 // materialisation, 0..1
    this.ragdoll = null;
    this.corpseUntil = 0;
    this.extracted = false;
    this.limbsLost = 0;
    this._mnKilled = false;
    this._mnSelfApplies = false;

    /** The current attack in flight. Reused; never a fresh literal. */
    this.act = {
      spec: null, kind: '', t: 0, duration: 1, resolved: false,
      telegraph: null, tick: 0, ticks: 0,
    };
    /** Ballistic state for a leap or a charge. */
    this.launch = { active: false, t: 0, duration: 0, x0: 0, z0: 0, x1: 0, z1: 0, apex: 0 };

    // ---- preallocated scratch ----------------------------------------------
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._flow = new THREE.Vector3();
    this._slotPos = new THREE.Vector3();
    this._smoothX = 0;
    this._smoothZ = 0;
    this._prevVX = 0;
    this._prevVZ = 0;
    this._accelLocalX = 0;
    this._accelLocalZ = 0;
    this._cue = { cue: '', position: new THREE.Vector3(), gain: 1 };
    this._atk = {
      source: this, target: null, amount: 0, element: 'physical', skill: '',
      stagger: 0, knockback: 0, shakeWeight: 0.3, status: '', statusChance: 0,
    };
    this._area = {
      source: this, position: new THREE.Vector3(), radius: 3, amount: 0,
      element: 'physical', stagger: 0, knockback: 0, maxTargets: 8,
      magnitude: 1, explode: true, skill: '',
    };
  }

  /* ==================================================================== */
  /* lifecycle                                                            */
  /* ==================================================================== */

  /**
   * Activate a pooled actor.
   * @param o { x, y, z, yaw, level, scale, power, sourceKind, silent, form }
   */
  spawn(o) {
    const ai = this.ai;
    const arch = this.arch;
    const level = o.level ?? 1;

    this.alive = true;
    this._mnKilled = false;
    this._mnSelfApplies = false;
    this.extracted = false;
    this.limbsLost = 0;
    this.ragdoll = null;
    this.corpseUntil = 0;
    this.threat.clear();
    this.target = null;
    this.slot = -1;
    this.engaged = false;
    this.blocking = false;
    this.vulnerable = false;
    this.staggerUntil = 0;
    this.staggered = false;
    this.hitFlash = 0;
    this.buffDamage = 1;
    this.buffHaste = 1;
    this.buffUntil = 0;
    this.orderTarget = null;
    this.orderUntil = 0;
    this.launch.active = false;
    this.act.spec = null;
    this.act.telegraph = null;

    // ---- stats --------------------------------------------------------------
    const power = o.power ?? 1;
    this.stats.level = level;
    this.stats.hpMax = Math.round((arch.hp + arch.hpPerLevel * (level - 1)) * power);
    this.stats.hp = this.stats.hpMax;
    this.stats.armour = Math.round(arch.armour + arch.armourPerLevel * (level - 1));
    this.stats.poise = arch.poise * (this.isBoss ? 1 : 1);
    this.stats.damage = (arch.damage + arch.damagePerLevel * (level - 1)) * power;
    this.stats.shadowPower = this.stats.damage;

    // ---- transform ----------------------------------------------------------
    // Deterministic per-instance scale. ±8% is enough to break the "twenty
    // identical" read and small enough that the hitbox stays honest.
    const jitter = (((this.poolIndex * 40503 + 17) >>> 0) / 4294967296) - 0.5;
    this.scale = o.scale ?? (1 + jitter * 0.16);
    this.height = arch.height * this.scale;
    this.radius = arch.radius * this.scale;
    this.root.scale.setScalar(this.scale);
    this.position.set(o.x, o.y ?? 0, o.z);
    this.velocity.set(0, 0, 0);
    this.yaw = o.yaw ?? 0;
    this.yawTarget = this.yaw;
    this._smoothX = 0; this._smoothZ = 0;
    this._prevVX = 0; this._prevVZ = 0;

    // ---- physics ------------------------------------------------------------
    const P = this.ctx.peek('physics');
    if (P?.createCharacter && !this.char) {
      this.char = P.createCharacter({
        actor: this,
        radius: this.radius,
        height: this.height,
        stepHeight: Math.min(0.5, this.height * 0.26),
        weight: this.weight,
        mass: arch.mass,
      });
    } else if (this.char) {
      this.char.setSize?.(this.radius, this.height);
      P?.registerActor?.(this, { radius: this.radius, height: this.height, weight: this.weight });
    }
    // `_die` disables the controller and makes the proxy non-solid so the crowd
    // stops steering around a corpse. A pooled actor is reused, so both have to
    // be put back or a recycled slot spawns paralysed — which is invisible until
    // half a wave stands still.
    if (this.char) this.char.enabled = true;
    P?.configureActor?.(this, { solid: true });
    this.char?.teleport?.(this.position.x, this.position.y, this.position.z);

    // ---- appearance ---------------------------------------------------------
    // Per-instance tint: a cool/warm value spread across the pack so a horde has
    // internal variation without a second texture.
    const t = ((this.poolIndex * 2246822519) >>> 0) / 4294967296;
    const tint = this.asset.skin.tint;
    const warm = 0.90 + t * 0.20;
    ai.materials.configure(this.materials, this.asset.skin, {
      height: arch.height,
      tint: [tint[0] * warm, tint[1] * (0.94 + t * 0.12), tint[2] * (1.06 - t * 0.16)],
      shadow: this.isShadow ? 1 : 0,
      form: o.form ?? 1,
      wear: 0.10 + t * 0.22,
      variation: 0.06 + t * 0.10,
      eyeGain: this.asset.skin.eyeGain * (0.82 + t * 0.36),
      // The Warden gets a VIOLET rim at double an ordinary enemy's strength.
      // Two reasons, both measured off the arena shot: at a 25 m boom through
      // the arena's height fog a five-metre grey figure has almost no value
      // separation from the wall behind it, and a rim in the same hue as the
      // core ties the silhouette to the light burning inside it — which is the
      // whole read of the creature.
      //
      // 0.9, not 1.9. A five-metre body presents far more grazing-angle area
      // than a 1.8 m one, so the same rim strength that edge-lights a ghoul
      // floods the Warden — at 1.9 it photographed as a pale ghost instead of a
      // stone construct with a light inside it.
      rim: this.isBoss ? [0.36, 0.26, 0.72] : undefined,
      rimStrength: this.isBoss ? 0.9 : undefined,
    });
    this.form = o.form ?? 1;

    // ---- animation ----------------------------------------------------------
    this.anim.reset();
    this.anim.runSpeed = arch.speedRun;
    for (const b of this.bones) b.scale.setScalar(1);
    if (o.rise !== false) {
      this.anim.play('rise', this.isShadow ? SHADOW.materialise : 0.85);
    }
    this.anim.apply(this.bones, 0);
    this.root.position.copy(this.position);
    this.root.rotation.y = this.yaw;
    this.root.updateMatrix();
    this.root.updateMatrixWorld(true);
    this.anim.settle(this.bones, 30);

    for (const m of this.meshes) m.castShadow = true;
    this.root.visible = true;
    this.state = this.form < 1 ? S.MATERIALISE : S.IDLE;
    this.stateT = 0;
    this.spawnedAt = this.ctx.time.elapsed;
    this.expiresAt = this.isShadow ? this.spawnedAt + SHADOW.lifetime : Infinity;
    this.attackCd = 0.4;
    this.specialCd = 2.0 + t * 2.0;
    this.retargetAt = 0;
    this.lodBand = 0;
    this.anim.stride = 1;
    return this;
  }

  despawn() {
    this.alive = false;
    this.root.visible = false;
    this.state = S.IDLE;
    this.target = null;
    this.threat.clear();
    if (this.slot >= 0) { this.ai.releaseSlot(this); this.slot = -1; }
    const P = this.ctx.peek('physics');
    if (this.ragdoll) { P?.despawnRagdoll?.(this.ragdoll); this.ragdoll = null; }
    if (this.char) P?.unregisterActor?.(this);
    this.ai.fx?.detachShadowTrail?.(this);
  }

  /* ==================================================================== */
  /* damage                                                               */
  /* ==================================================================== */

  /**
   * Owner-applied damage, per the actor interface. `combat` emits `combat:hit`
   * with the FINAL post-mitigation figure for a non-player target, so this
   * subtracts it directly rather than mitigating a second time.
   */
  applyDamage(o = {}) {
    if (!this.alive) return 0;
    let amount = o.amount ?? 0;
    if (amount <= 0) return 0;

    // The knight's shield. Reduction applies only inside its facing arc, which
    // is what makes flanking a real tactic rather than a suggestion.
    if (this.blocking && o.dir) {
      const a = Math.atan2(-o.dir.x, -o.dir.z);
      if (Math.abs(angleDelta(this.yaw, a)) < (this.arch.block?.arc ?? 1.0)) {
        amount *= 1 - (this.arch.block?.reduction ?? 0.6);
        this._cueVox('hurt', 0.5);
        // A parry: struck inside the window that opens with the block. The
        // counter is immediate and heavy, and it is the reason attacking into a
        // raised shield is a decision rather than a reflex.
        const now = this.ctx.time.elapsed;
        if (now < this.parryUntil && o.source && this.specialCd <= 0) {
          this.parryUntil = 0;
          this.specialCd = this.arch.parry.cooldown;
          this._counter(o.source);
        }
      }
    }

    if (this.vulnerable) amount *= 1.0;   // the multiplier is applied by combat
    this.stats.hp -= amount;
    this.hitFlash = 1;

    // Being hit wakes an idle actor and hands the attacker threat, whether or
    // not it was ever seen. An enemy that can be shot from stealth forever is
    // not a stealth mechanic, it is a bug.
    if (o.source) {
      this.addThreat(o.source, amount);
      if (!this.target) this._acquire(o.source);
      this.ai.shout(this, PERCEPTION.shoutRadius);
    }
    if (this.stats.hp <= 0) {
      this.stats.hp = 0;
      this._die(o);
    } else if (this.state !== S.MATERIALISE) {
      this._cueVox('hurt', 0.55);
    }
    return amount;
  }

  /**
   * Poise-gated stagger. Below poise the actor flinches and keeps acting; above
   * it, whatever it was doing is cancelled. `combat/impact.js` also writes
   * `staggerUntil`; we return true so it knows the actor handled it.
   */
  applyStagger(amount = 0, dir = null) {
    if (!this.alive) return false;
    const dx = dir?.x ?? 0, dz = dir?.z ?? -1;
    // Into the actor's own frame, so a blow from behind throws the head forward.
    const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
    this.anim.flinch(clamp(amount / Math.max(20, this.stats.poise), 0.15, 1.4),
      dx * c - dz * s, dx * s + dz * c);

    const poise = this.stats.poise * (this.blocking ? 1 + (this.arch.block?.poiseBonus ?? 0) / 100 : 1);
    if (amount <= poise) return false;

    // A channel is interrupted by ANY stagger that gets through, which is the
    // whole design of the caster: the bar is the puzzle and the interrupt is
    // the answer.
    const wasChannelling = this.act.kind === 'channel';
    this._cancelAttack(true);
    this._enter(S.STAGGER);
    this.anim.play('stagger', 0.55, { restart: true, fade: 0.05 });
    this.velocity.x *= 0.3;
    this.velocity.z *= 0.3;
    if (wasChannelling) this.ai.toast('Channel interrupted', 'good');
    return true;
  }

  addThreat(source, amount) {
    if (!source || source === this) return;
    if (source.faction === this.faction) return;
    const prev = this.threat.get(source) ?? 0;
    this.threat.set(source, prev + amount);
    // Bounded: a fight can run for minutes and an unbounded map is a leak.
    if (this.threat.size > 8) {
      let worstK = null, worstV = Infinity;
      for (const [k, v] of this.threat) if (v < worstV) { worstV = v; worstK = k; }
      if (worstK) this.threat.delete(worstK);
    }
  }

  /* ==================================================================== */
  /* death                                                                */
  /* ==================================================================== */

  _die(o) {
    if (this.state === S.DEAD) return;
    this._enter(S.DEAD);
    this.alive = false;
    this.blocking = false;
    this.vulnerable = false;
    this._cancelAttack(true);
    this._cueVox('death', 1.0);
    if (this.slot >= 0) { this.ai.releaseSlot(this); this.slot = -1; }

    const now = this.ctx.time.elapsed;
    this.corpseUntil = now + DEATH.corpseTtl;

    // The death clip plays for a fraction of a second and is then taken over by
    // the ragdoll. It matters anyway: the first 200 ms of a death is what sells
    // the hit that caused it, and a body that goes limp instantly reads as a
    // physics toy rather than as something dying.
    this.anim.play('death', 0.9, { restart: true, fade: 0.04 });

    const P = this.ctx.peek('physics');
    const dirX = o?.dir?.x ?? 0, dirZ = o?.dir?.z ?? 0;
    const crit = !!o?.crit;
    const impulse = (crit ? DEATH.impulseCrit : DEATH.impulse) * Math.min(3, this.weight);

    if (P?.spawnRagdoll && this.ai.ragdollBudget() > 0) {
      this.ragdoll = P.spawnRagdoll({
        position: this.position,
        yaw: this.yaw,
        height: this.height,
        massScale: this.arch.mass / 78,
        velocity: this.velocity,
        impulse: { x: dirX * impulse, y: impulse * 0.30, z: dirZ * impulse },
        hitPoint: this._v.set(this.position.x, this.position.y + this.height * 0.6, this.position.z),
        lifetime: DEATH.corpseTtl,
        actor: this,
        surface: this.surface === 'metal' ? 'metal' : this.surface === 'bone' ? 'bone' : 'flesh',
      });
    }
    // Stop colliding as a living actor immediately, or the crowd steers around a
    // corpse that is no longer there.
    P?.configureActor?.(this, { solid: false });
    if (this.char) this.char.enabled = false;

    // ---- dismemberment ------------------------------------------------------
    const overkill = o?.overkill ?? 0;
    if (this.arch.dismemberable &&
        overkill > this.stats.hpMax * DEATH.dismemberOverkill) {
      this._dismember(dirX, dirZ, crit);
    }
    this.ai.onActorDied(this, o);
  }

  /**
   * Take a limb off.
   *
   * The severed bone is SCALED to a stub rather than hidden, which works because
   * every actor owns its own skeleton even though the geometry is shared: the
   * vertices weighted to that bone collapse to the joint and read as a stump.
   * The limb itself becomes a rigid body with the archetype's own material, so
   * the piece on the floor matches the body it came off.
   */
  _dismember(dirX, dirZ, crit) {
    const rig = this.asset.rig;
    const candidates = this.asset.limbBones;
    if (!candidates || candidates.length === 0) return;
    const n = Math.min(DEATH.maxLimbs, crit ? 2 : 1);
    const P = this.ctx.peek('physics');
    const fx = this.ai.fx;

    for (let k = 0; k < n; k++) {
      const pick = candidates[(this.ai.rng.u32() + k) % candidates.length];
      const bi = rig.id(pick);
      if (this.bones[bi].scale.x < 0.5) continue;
      this.bones[bi].scale.setScalar(0.03);
      this.limbsLost++;

      // Where the limb was, in world space.
      this.bones[bi].updateMatrix();
      this.root.updateMatrixWorld(true);
      this._v.setFromMatrixPosition(this.bones[bi].matrixWorld);
      const len = rig.restLength[bi] * this.scale;

      // The archetype TEMPLATE material, not this actor's clone: `fx.hitFlash`
      // claims a material for one root and refuses to flash any material it has
      // seen on two, so lending a limb this actor's own material would silently
      // cost it its hit flash for the rest of the run.
      const mesh = this.ai.acquireLimbMesh(this.asset.skin.body, len,
        rig.bindRadius[bi] * this.scale);
      if (mesh && P?.spawnBody) {
        const body = P.spawnBody({
          shape: 'capsule',
          radius: Math.max(0.06, rig.bindRadius[bi] * this.scale * 0.6),
          halfHeight: Math.max(0.05, len * 0.4),
          position: this._v,
          velocity: this._v2.set(
            dirX * 3.2 + this.ai.rng.range(-1.6, 1.6),
            3.4 + this.ai.rng.range(0, 2.0),
            dirZ * 3.2 + this.ai.rng.range(-1.6, 1.6)
          ),
          angular: this._flow.set(this.ai.rng.range(-9, 9), this.ai.rng.range(-9, 9), this.ai.rng.range(-9, 9)),
          mass: 6,
          surface: this.surface === 'metal' ? 'metal' : 'flesh',
          restitution: 0.12,
          friction: 0.9,
          mesh,
          lifetime: DEATH.corpseTtl * 0.7,
        });
        this.ai.trackLimb(mesh, body);
      }
      fx?.bloodSpray?.({
        x: this._v.x, y: this._v.y, z: this._v.z,
        dx: dirX, dy: 0.5, dz: dirZ, amount: 1.4, crit: true,
      });
    }
  }

  /**
   * Drive the rig from the ragdoll.
   *
   * `physics` gives each bone a world position (the MIDPOINT) and a quaternion
   * whose local +Y runs down the bone. Our bones are bind-oriented, so the world
   * rotation each rig bone needs is `qRagdoll * inverse(bindAxisQuat)`, and its
   * world position is the midpoint stepped back half a length along the bone.
   * Both are then expressed in the parent's frame.
   */
  _poseFromRagdoll() {
    const rag = this.ragdoll;
    if (!rag) return;
    const rig = this.asset.rig;
    const pairs = rig.ragdollPairs;
    const A = this.ai;

    // The actor's root follows the pelvis so the group's transform stays near
    // the body — a group left behind makes every child's world matrix a long
    // way from its bounding sphere and breaks culling.
    const pelvis = rag.boneByName.get('pelvis');
    if (pelvis) {
      this.position.set(pelvis.position.x, rag.lowestY, pelvis.position.z);
      this.root.position.copy(this.position);
      this.root.rotation.y = 0;
      this.root.updateMatrix();
      this.root.updateMatrixWorld(true);
    }

    for (let i = 0; i < pairs.length; i++) {
      const [ragName, bi] = pairs[i];
      const rb = rag.boneByName.get(ragName);
      if (!rb) continue;
      const bone = this.bones[bi];
      A._q.set(
        rig.axisQuat[bi * 4], rig.axisQuat[bi * 4 + 1],
        rig.axisQuat[bi * 4 + 2], rig.axisQuat[bi * 4 + 3]
      ).invert().premultiply(rb.quaternion);
      // Head of the bone = midpoint − half length along the bone's own axis.
      A._v.set(0, -rb.length * 0.5, 0).applyQuaternion(rb.quaternion).add(rb.position);

      const parent = bone.parent;
      if (parent) {
        A._m.copy(parent.matrixWorld).invert();
        A._v.applyMatrix4(A._m);
        A._q2.setFromRotationMatrix(A._m);
        A._q.premultiply(A._q2);
      }
      bone.position.copy(A._v);
      bone.quaternion.copy(A._q);
      bone.updateMatrix();
      // Children are composed in the same pass because `pairs` is ordered
      // parent-first by construction (bones are declared parent-first).
      bone.updateMatrixWorld(true);
    }
  }

  /* ==================================================================== */
  /* the fixed step                                                       */
  /* ==================================================================== */

  fixedUpdate(h, now) {
    if (!this.root.visible) return;

    if (this.state === S.DEAD) {
      // The corpse fades out and then releases the slot. `player`'s ARISE
      // ledger remembers it for the same window, so a body the prompt says is
      // extractable is always still physically there.
      if (now > this.corpseUntil) this.ai.recycle(this);
      return;
    }

    this.stateT += h;
    if (this.attackCd > 0) this.attackCd -= h;
    if (this.specialCd > 0) this.specialCd -= h;
    if (this.buffUntil > 0 && now > this.buffUntil) {
      this.buffDamage = 1; this.buffHaste = 1; this.buffUntil = 0;
    }
    if (this.isShadow && now > this.expiresAt) { this.ai.retireShadow(this); return; }

    // ---- materialisation ----------------------------------------------------
    if (this.state === S.MATERIALISE) {
      this.form = clamp01(this.form + h / SHADOW.materialise);
      this.ai.materials.setForm(this.materials, this.form);
      if (this.form >= 1) this._enter(S.IDLE);
      this._integrate(h, 0, 0);
      return;
    }

    // ---- stagger ------------------------------------------------------------
    if (this.state === S.STAGGER) {
      if (!this.anim.active || now > this.staggerUntil) this._enter(S.CHASE);
      this._integrate(h, 0, 0);
      return;
    }

    // ---- launch (leap / charge) --------------------------------------------
    if (this.launch.active) { this._stepLaunch(h); return; }

    this._perceive(now, h);
    this._think(h, now);
    this._steer(h, now);
  }

  /* ==================================================================== */
  /* perception                                                           */
  /* ==================================================================== */

  _perceive(now, h) {
    // Retarget on an interval rather than every step, staggered per actor so a
    // pack does not all re-evaluate on the same frame.
    if (now >= this.retargetAt) {
      this.retargetAt = now + 0.42 + (this.poolIndex % 7) * 0.035;
      this._selectTarget(now);
    }
    const t = this.target;
    if (!t) { this.hasLos = false; return; }
    if (t.alive === false) { this.target = null; return; }

    this._v.subVectors(t.position, this.position);
    const dist = Math.hypot(this._v.x, this._v.z);

    // Line of sight, amortised. `PERCEPTION.losInterval` at 40 actors is 200
    // raycasts a second, which is nothing against the BVH — but doing it every
    // step for every actor would be 2 400.
    if (now - this.lastLosAt > PERCEPTION.losInterval) {
      this.lastLosAt = now;
      const P = this.ctx.peek('physics');
      this.hasLos = P?.actorLineOfSight ? P.actorLineOfSight(this, t) : true;
    }

    const facing = Math.abs(angleDelta(this.yaw, Math.atan2(this._v.x, this._v.z)));
    const sees = this.hasLos &&
      (dist < PERCEPTION.closeRadius || facing < PERCEPTION.fov * 0.5) &&
      dist < this.arch.aggro * (this.state === S.IDLE ? 1 : 1.6);
    if (sees) this.targetSeenAt = now;

    // Forget a target that has been out of sight for too long. Shadows never
    // forget the enemy they were ordered onto — an army that loses interest is
    // not an army.
    if (!this.isShadow && now - this.targetSeenAt > PERCEPTION.memory) {
      this.target = null;
      this.hasLos = false;
    }
    void h;
  }

  _selectTarget(now) {
    const ai = this.ai;
    // 1. Threat first. Whatever has hit this actor hardest, if it is in range.
    let best = null, bestScore = -Infinity;
    for (const [src, amount] of this.threat) {
      if (!src || src.alive === false) continue;
      const d = distXZ(this.position, src.position);
      if (d > this.arch.leash) continue;
      const score = amount / Math.max(2, d);
      if (score > bestScore) { bestScore = score; best = src; }
    }
    // 2. Otherwise the nearest hostile inside the aggro radius.
    const near = ai.nearestHostile(this, this.arch.aggro * (this.target ? 1.7 : 1));
    if (!best && near) best = near;
    // 3. A shadow soldier under orders goes where it was sent.
    if (this.isShadow && this.orderTarget && this.orderTarget.alive !== false &&
        now < this.orderUntil) {
      best = this.orderTarget;
    }

    if (best !== this.target) {
      if (this.slot >= 0) { ai.releaseSlot(this); this.slot = -1; }
      this.target = best;
      if (best) {
        this.targetSeenAt = now;
        if (this.state === S.IDLE) {
          this._enter(S.ALERT);
          this._cueVox('alert', 0.8);
          ai.shout(this, PERCEPTION.shoutRadius);
        }
      }
    }
  }

  /** Woken by a neighbour's shout. */
  alertTo(actor, delay) {
    if (!this.alive || this.target || this.state === S.DEAD) return;
    this._acquire(actor);
    this.retargetAt = this.ctx.time.elapsed + delay;
    this._enter(S.ALERT);
    this.stateT = -delay;
  }

  _acquire(actor) {
    if (!actor || actor.faction === this.faction) return;
    this.target = actor;
    this.targetSeenAt = this.ctx.time.elapsed;
    if (this.state === S.IDLE) this._enter(S.ALERT);
  }

  /* ==================================================================== */
  /* behaviour                                                            */
  /* ==================================================================== */

  _enter(state) {
    this.state = state;
    this.stateT = 0;
    if (state !== S.WINDUP && state !== S.STRIKE) this.blocking = false;
  }

  _think(h, now) {
    const arch = this.arch;
    const t = this.target;

    if (!t) {
      if (this.state !== S.IDLE) this._enter(S.IDLE);
      this.anim.alert = lerp(this.anim.alert, 0, h * 3);
      return;
    }
    this.anim.alert = lerp(this.anim.alert, 1, h * 4);

    const dist = distXZ(this.position, t.position) - (t.radius ?? 0.4) - this.radius;

    switch (this.state) {
      case S.IDLE:
        this._enter(S.ALERT);
        break;

      case S.ALERT:
        // The reaction beat. An enemy that starts moving on the frame it sees
        // you reads as a trigger volume rather than as a creature.
        if (this.stateT > 0.28) this._enter(S.CHASE);
        break;

      case S.CHASE:
      case S.CIRCLE: {
        // Specials first: they have priority over the basic attack and their own
        // range bands, which is what gives each archetype a rhythm.
        if (this._trySpecial(dist, now)) break;
        const inRange = dist <= arch.attackRange * 0.92;
        const permitted = this.ai.mayEngage(this);
        if (inRange && permitted && this.attackCd <= 0 && this.hasLos) {
          // A basic attack past ~6 m is a BOLT, not a swing. Without this the
          // caster's "ranged attack" is a 17 m melee cone that connects with
          // nothing visible in between, which reads as the player taking damage
          // from thin air.
          const ranged = arch.attackRange > 6;
          this._beginAttack(ranged ? 'bolt' : 'attack', {
            windup: arch.windup, strike: arch.strike, recover: arch.recover,
            damage: 1.0, stagger: arch.stagger, knockback: arch.knockback,
            range: arch.attackRange * 1.15, halfAngle: 1.0,
            element: ranged ? 'shadow' : 'physical',
          });
        } else if (inRange && !permitted) {
          this._enter(S.CIRCLE);
        } else if (this.state === S.CIRCLE && (!inRange || permitted)) {
          this._enter(S.CHASE);
        }
        // The knight raises its shield whenever it is close and not swinging.
        if (arch.block && dist < arch.attackRange * 2.2 && this.attackCd > 0.25) {
          if (!this.blocking) {
            this.blocking = true;
            this.parryUntil = now + arch.parry.window;
            this.anim.play('block', 1.0, { loop: true, fade: 0.16 });
          }
        } else if (this.blocking) {
          this.blocking = false;
          this.anim.stop(0.18);
        }
        break;
      }

      case S.WINDUP:
      case S.STRIKE:
      case S.SPECIAL:
        this._stepAttack(h, now);
        break;

      case S.RECOVER:
        if (!this.anim.active || this.stateT > this.act.duration) this._enter(S.CHASE);
        break;

      default:
        break;
    }
  }

  /**
   * Archetype specials. Each is a range band plus a cooldown; the ordering
   * inside the switch IS the priority.
   */
  _trySpecial(dist, now) {
    if (this.specialCd > 0 || !this.hasLos || this.form < 1) return false;
    const arch = this.arch;

    if (arch.leap && dist > arch.leap.minRange && dist < arch.leap.range) {
      this._beginAttack('leap', arch.leap);
      return true;
    }
    if (arch.charge && dist > arch.charge.minRange && dist < arch.charge.range) {
      this._beginAttack('charge', arch.charge);
      return true;
    }
    if (arch.slam && dist < arch.slam.radius * 0.8) {
      this._beginAttack('slam', arch.slam);
      return true;
    }
    if (arch.heavy && dist < arch.heavy.range * 0.85) {
      this._beginAttack('heavy', arch.heavy);
      return true;
    }
    if (arch.channel && dist > 3.0 && dist < arch.channel.radius * 2.6) {
      this._beginAttack('channel', arch.channel);
      return true;
    }
    void now;
    return false;
  }

  /* ==================================================================== */
  /* attacks                                                              */
  /* ==================================================================== */

  _beginAttack(kind, spec) {
    const a = this.act;
    a.kind = kind;
    a.spec = spec;
    a.t = 0;
    a.resolved = false;
    a.tick = 0;
    a.ticks = spec.ticks ?? 0;
    a.telegraph = null;

    const haste = this.buffHaste;
    const windup = (spec.windup ?? this.arch.windup) / haste;
    const strike = spec.strike ?? this.arch.strike;
    const recover = (spec.recover ?? this.arch.recover) / haste;
    a.windup = windup;
    a.duration = windup + strike + recover;

    // Face the target and commit. Turning during a wind-up is allowed but
    // heavily damped in `_steer`, so a player who circles a committed brute can
    // make it miss — which is the entire point of a wind-up.
    const t = this.target;
    if (t) this.yawTarget = Math.atan2(t.position.x - this.position.x, t.position.z - this.position.z);

    // ---- the animation ------------------------------------------------------
    const clipName = kind === 'leap' ? 'leap'
      : kind === 'charge' ? 'charge'
        : kind === 'channel' ? 'channel'
          : kind === 'heavy' || kind === 'slam' ? 'heavy'
            : (kind === 'cast' || kind === 'bolt') ? 'cast' : 'attack';
    this.anim.play(clipName, kind === 'channel' ? 1.0 : a.duration,
      { restart: true, fade: 0.06, loop: kind === 'channel' });

    // ---- the telegraph ------------------------------------------------------
    if (spec.telegraph) a.telegraph = this._raiseTelegraph(spec, windup);
    this._cueVox('attack', 0.85);
    this.ai.counters.attacks++;
    this._enter(kind === 'attack' || kind === 'heavy' || kind === 'slam' || kind === 'bolt'
      ? S.WINDUP : S.SPECIAL);
    this.attackCd = (spec.cooldown ?? this.arch.cooldown) / haste;
    if (kind !== 'attack') this.specialCd = (spec.cooldown ?? 6) / haste;
  }

  _raiseTelegraph(spec, windup) {
    const T = this.ai.telegraphs;
    const y = this.position.y;
    const colour = this.isBoss ? TELEGRAPH.bossColour : TELEGRAPH.colour;
    const intensity = this.isBoss ? TELEGRAPH.bossIntensity : TELEGRAPH.intensity;
    switch (spec.telegraph) {
      case 'circle':
        return T.circle({
          x: this.position.x, y, z: this.position.z,
          radius: (spec.radius ?? 3) * this.scale, windup, colour, intensity,
        });
      case 'cone':
        return T.cone({
          x: this.position.x, y, z: this.position.z, yaw: this.yaw,
          range: (spec.range ?? 5) * this.scale, halfAngle: spec.halfAngle ?? 0.9,
          windup, colour, intensity,
        });
      case 'line':
        return T.line({
          x: this.position.x, y, z: this.position.z, yaw: this.yaw,
          length: (spec.range ?? 8), halfWidth: (spec.halfWidth ?? 0.9) * this.scale,
          windup, colour, intensity,
        });
      default:
        return null;
    }
  }

  _stepAttack(h, now) {
    const a = this.act;
    if (!a.spec) { this._enter(S.CHASE); return; }
    a.t += h;

    // Keep a cone or a line pointed at the target during the wind-up, but only
    // while the actor is still able to turn — otherwise the telegraph lies.
    if (a.telegraph && a.t < a.windup) {
      this.ai.telegraphs.aim(a.telegraph, this.position.x, this.position.z, this.yaw);
    }

    // ---- the channel is its own thing ---------------------------------------
    if (a.kind === 'channel') {
      const spec = a.spec;
      if (a.t >= spec.duration) { this._endAttack(); return; }
      a.tick += h;
      if (a.tick >= spec.tickInterval) {
        a.tick -= spec.tickInterval;
        this._areaHit(this.target?.position ?? this.position, spec.radius,
          spec.tickDamage, 'shadow', 8, 0, false);
      }
      // The glow builds through the channel, so an un-interrupted caster gets
      // visibly more dangerous rather than merely staying dangerous.
      const k = clamp01(a.t / spec.duration);
      this.ai.materials.setGlowGain(this.materials, 1 + k * 3.4);
      this.materials.glow.emissiveIntensity = this.asset.skin.eyeGain * (1 + k * 2.4);
      return;
    }

    if (!a.resolved && a.t >= a.windup) {
      a.resolved = true;
      this._resolve(a.kind, a.spec);
      if (a.telegraph) this.ai.telegraphs.strike(a.telegraph);
      if (this.state === S.WINDUP) this._enter(S.STRIKE);
    }
    if (a.t >= a.duration) this._endAttack();
    void now;
  }

  _endAttack() {
    const a = this.act;
    if (a.kind === 'channel') {
      this.ai.materials.setGlowGain(this.materials, 1);
      this.materials.glow.emissiveIntensity = this.asset.skin.eyeGain;
      this.anim.stop(0.2);
    }
    a.spec = null;
    a.telegraph = null;
    a.kind = '';
    this._enter(S.RECOVER);
  }

  _cancelAttack(interrupted) {
    const a = this.act;
    if (a.telegraph) {
      // Cancelling WITHOUT a flash is itself feedback: a telegraph that vanishes
      // tells the player their interrupt worked.
      this.ai.telegraphs.cancel(a.telegraph);
      a.telegraph = null;
    }
    if (a.kind === 'channel') {
      this.ai.materials.setGlowGain(this.materials, 1);
      this.materials.glow.emissiveIntensity = this.asset.skin.eyeGain;
    }
    a.spec = null;
    a.kind = '';
    this.launch.active = false;
    void interrupted;
  }

  /** Turn a resolved attack into damage, through `combat` so an enemy hit gets
   *  the same hit-stop, shake, flash and number the player's does. */
  _resolve(kind, spec) {
    const combat = this.ai.combat;
    const damage = this.stats.damage * (spec.damage ?? 1) * this.buffDamage;

    switch (kind) {
      case 'leap':
      case 'charge':
        this._beginLaunch(spec);
        return;

      case 'bolt': {
        // A single-target ranged strike with a visible flight. `fx` draws the
        // beam and the impact; `combat` owns the damage, exactly as it does for
        // a melee swing, so an enemy bolt gets the same hit-stop, number and
        // audio transient the player's spear does.
        const target = this.target;
        if (!target || target.alive === false) return;
        const fx = this.ai.fx;
        const ex = this.position.x + Math.sin(this.yaw) * this.radius * 1.4;
        const ez = this.position.z + Math.cos(this.yaw) * this.radius * 1.4;
        const ey = this.position.y + this.height * 0.78;
        const ty = target.position.y + (target.height ?? 1.8) * 0.55;
        fx?.beam?.({
          x0: ex, y0: ey, z0: ez,
          x1: target.position.x, y1: ty, z1: target.position.z,
          element: spec.element ?? 'shadow', radius: 0.10, life: 0.20,
        });
        const atk = this._atk;
        atk.source = this;
        atk.target = target;
        atk.amount = damage;
        atk.element = spec.element ?? 'shadow';
        atk.skill = `${this.kind}.bolt`;
        atk.stagger = spec.stagger ?? this.arch.stagger;
        atk.knockback = spec.knockback ?? 0;
        atk.shakeWeight = 0.25;
        combat?.attack?.(atk);
        this.ai.cue('magic.cast.shadow', this.position, 0.7, this.height * 0.75);
        return;
      }

      case 'slam':
      case 'nova':
        this._areaHit(this.position, (spec.radius ?? 4) * this.scale, spec.damage ?? 1,
          'physical', spec.maxTargets ?? 10, spec.knockback ?? 1.5, true);
        this.ai.shake(0.34, 0.8);
        if (spec.stun) this._stunTargets(this.position, (spec.radius ?? 4) * this.scale, spec.stun);
        return;

      case 'heavy':
      case 'attack':
      default: {
        // A cone in front, resolved by `combat`'s own hitbox machinery through a
        // radius query — `ai` owns no spatial index, and two indexes are always
        // eventually two different answers.
        const range = (spec.range ?? this.arch.attackRange) * this.scale;
        const half = spec.halfAngle ?? 0.95;
        const hits = this.ai.queryCone(this, range + this.radius, half);
        let n = 0;
        for (let i = 0; i < hits.count && n < 4; i++) {
          const target = hits.actors[i];
          if (!target || target.alive === false) continue;
          const atk = this._atk;
          atk.source = this;
          atk.target = target;
          atk.amount = damage;
          atk.element = 'physical';
          atk.skill = `${this.kind}.${kind}`;
          atk.stagger = spec.stagger ?? this.arch.stagger;
          atk.knockback = spec.knockback ?? this.arch.knockback;
          atk.shakeWeight = kind === 'heavy' ? 0.7 : 0.3;
          combat?.attack?.(atk);
          n++;
        }
        if (n === 0) this.ai.cue('swing.blade', this.position, 0.5);
        return;
      }
    }
  }

  _areaHit(centre, radius, damageMul, element, maxTargets, knockback, explode) {
    const a = this._area;
    a.source = this;
    a.position.copy(centre);
    a.position.y += 0.35;
    a.radius = radius;
    a.amount = this.stats.damage * damageMul * this.buffDamage;
    a.element = element;
    a.stagger = this.act.spec?.stagger ?? this.arch.stagger;
    a.knockback = knockback;
    a.maxTargets = maxTargets;
    a.magnitude = clamp(radius / 4, 0.6, 2.0);
    a.explode = explode;
    a.skill = `${this.kind}.${this.act.kind}`;
    this.ai.combat?.areaAttack?.(a);
  }

  _stunTargets(centre, radius, seconds) {
    const hits = this.ai.queryRadius(this, centre, radius);
    for (let i = 0; i < hits.count; i++) {
      const t = hits.actors[i];
      if (!t || t.alive === false) continue;
      // `staggerUntil` is the shared vocabulary `combat.canAct` and
      // `damage.js`'s vulnerability window both read, so a stun does not need
      // a bespoke channel.
      t.staggerUntil = Math.max(t.staggerUntil ?? 0, this.ctx.time.elapsed + seconds);
      t.staggered = true;
    }
  }

  /** The knight's counter after a parry. */
  _counter(source) {
    const combat = this.ai.combat;
    const atk = this._atk;
    atk.source = this;
    atk.target = source;
    atk.amount = this.stats.damage * this.arch.parry.counterDamage;
    atk.element = 'physical';
    atk.skill = 'knight.parry';
    atk.stagger = this.arch.parry.counterStagger;
    atk.knockback = 1.2;
    atk.shakeWeight = 0.8;
    combat?.attack?.(atk);
    this.anim.play('attack', 0.5, { restart: true, fade: 0.03 });
    this.ai.toast('Parried', 'bad');
  }

  /* ==================================================================== */
  /* leaps and charges                                                    */
  /* ==================================================================== */

  _beginLaunch(spec) {
    const t = this.target;
    if (!t) { this._endAttack(); return; }
    const L = this.launch;
    L.active = true;
    L.t = 0;
    L.x0 = this.position.x; L.z0 = this.position.z;
    L.spec = spec;

    // Land slightly SHORT of the target, not on it. Landing on the player's
    // exact position means the leap is a teleport-onto-you; landing 0.8 m short
    // gives the strike a direction and lets a dodge actually work.
    this._v.set(t.position.x - L.x0, 0, t.position.z - L.z0);
    const d = Math.max(0.5, this._v.length());
    const travel = Math.min(spec.range, d - 0.8);
    this._v.multiplyScalar(travel / d);
    L.x1 = L.x0 + this._v.x;
    L.z1 = L.z0 + this._v.z;
    L.apex = spec.apex ?? 0;
    L.duration = Math.max(0.18, travel / Math.max(2, spec.speed));
    this.yawTarget = Math.atan2(this._v.x, this._v.z);
    this.yaw = this.yawTarget;
    this._cueVox('attack', 1.0);
  }

  _stepLaunch(h) {
    const L = this.launch;
    L.t += h;
    const k = clamp01(L.t / L.duration);
    const x = lerp(L.x0, L.x1, k);
    const z = lerp(L.z0, L.z1, k);
    const lift = L.apex * 4 * k * (1 - k);

    // Move through the character controller so a leap into a wall stops at the
    // wall instead of putting the body inside it.
    if (this.char?.pushBy) {
      this.char.pushBy(x - this.position.x, 0, z - this.position.z);
    } else {
      this.position.x = x; this.position.z = z;
    }
    this.root.position.set(this.position.x, this.position.y + lift, this.position.z);
    this.root.rotation.y = this.yaw;
    this.root.updateMatrix();

    if (k >= 1) {
      L.active = false;
      const spec = L.spec;
      this._areaHit(this.position, (spec.radius ?? 2.2) * this.scale, spec.damage ?? 1,
        'physical', 4, spec.knockback ?? 1, true);
      this.ai.shake(0.22, 0.6);
      this.anim.impulseZ -= 8;
      this._endAttack();
    }
  }

  /* ==================================================================== */
  /* steering                                                             */
  /* ==================================================================== */

  _steer(h, now) {
    const arch = this.arch;
    const t = this.target;
    let wantX = 0, wantZ = 0, speed = 0;

    const committed = this.state === S.WINDUP || this.state === S.STRIKE ||
      this.state === S.SPECIAL || this.state === S.RECOVER;

    if (t && !committed) {
      const dist = distXZ(this.position, t.position);
      // ---- the ring slot ----------------------------------------------------
      // A destination per agent, not one destination for the crowd.
      const ring = this.ai.ringFor(t, arch.ringSlots, arch.ringRadius * this.scale +
        (t.radius ?? 0.4));
      if (this.slot < 0 && ring) this.slot = ring.claim(this, this.position.x, this.position.z);
      let gx = t.position.x, gz = t.position.z;
      if (ring && this.slot >= 0) {
        ring.position(this.slot, this._slotPos);
        gx = this._slotPos.x; gz = this._slotPos.z;
      }

      // ---- kiting -----------------------------------------------------------
      // A caster that flees is unkillable and infuriating. One that retreats two
      // metres and keeps casting is a positioning puzzle.
      if (arch.kite && dist < arch.kite.minRange) {
        const away = 1 / Math.max(0.01, dist);
        wantX = (this.position.x - t.position.x) * away;
        wantZ = (this.position.z - t.position.z) * away;
        // A sidestep folded in, so a retreat is a diagonal rather than a
        // straight line the player can simply out-walk.
        const s = this.poolIndex % 2 ? 1 : -1;
        wantX += -wantZ * arch.kite.sidestep * s;
        wantZ += wantX * arch.kite.sidestep * s;
        speed = arch.speedRun * arch.kite.retreatSpeed;
      } else if (this.state === S.CIRCLE) {
        // Strafe around the target at the ring radius. This is what the surplus
        // of a pack does while it waits for a turn.
        const dx = this.position.x - t.position.x, dz = this.position.z - t.position.z;
        const l = Math.max(0.01, Math.hypot(dx, dz));
        const s = this.poolIndex % 2 ? 1 : -1;
        const radial = (arch.ringRadius * this.scale - l) * 0.9;
        wantX = (-dz / l) * s + (dx / l) * radial;
        wantZ = (dx / l) * s + (dz / l) * radial;
        speed = arch.speedWalk * 1.35;
      } else {
        // ---- the flow field --------------------------------------------------
        // Inside `directRange` with line of sight, steer straight at the slot:
        // the field is a grid and it detours around cells the actor could walk
        // through, which reads as hesitation at close quarters.
        const dgx = gx - this.position.x, dgz = gz - this.position.z;
        const dg = Math.hypot(dgx, dgz);
        if (dg < NAV.directRange && this.hasLos) {
          wantX = dgx / Math.max(0.01, dg);
          wantZ = dgz / Math.max(0.01, dg);
        } else if (this.ai.flow.sample(this.position.x, this.position.z, this._flow)) {
          wantX = this._flow.x; wantZ = this._flow.z;
        } else {
          wantX = dgx / Math.max(0.01, dg);
          wantZ = dgz / Math.max(0.01, dg);
        }
        // Stop pressing once the slot is reached, or the whole ring grinds
        // inward into the target.
        const arrive = smoothstep(clamp01((dg - STEER.personalSpace) / 1.4));
        speed = lerp(arch.speedWalk, arch.speedRun, clamp01(dist / 9)) * arrive;
      }
      speed *= this.buffHaste;
    } else if (!t && this.escort) {
      // A shadow soldier with nothing to fight falls into formation behind the
      // hero. `shadows.js` writes the point; the arrive term stops the whole
      // army pressing into the player's back when it gets there.
      const dx = this.escortX - this.position.x, dz = this.escortZ - this.position.z;
      const l = Math.hypot(dx, dz);
      if (l > 0.45) {
        wantX = dx / l; wantZ = dz / l;
        speed = lerp(arch.speedWalk, arch.speedRun, clamp01((l - 1.2) / 6)) *
          smoothstep(clamp01((l - 0.45) / 1.1));
      }
    } else if (!t && this.state === S.IDLE) {
      // Idle drift: a slow wander so a room of enemies is not a diorama.
      const p = (now * 0.22 + this.poolIndex * 1.7);
      wantX = Math.sin(p) * 0.4;
      wantZ = Math.cos(p * 0.83) * 0.4;
      speed = arch.speedWalk * 0.30 * (this.isBoss ? 0 : 1);
    }

    // ---- crowd ---------------------------------------------------------------
    if (speed > 0.01 || committed) {
      const push = this.ai.avoidance(this, this._v2, t);
      wantX += push.x;
      wantZ += push.z;
      speed *= this.ai.yieldFactor(this, t);
    }

    // ---- wall bias -----------------------------------------------------------
    // The flow field already prefers the middle of a corridor, but an actor
    // pushed by the crowd can still end up scraping. One clearance sample steers
    // it back off the wall.
    if (this.ai.flow.ready && speed > 0.01) {
      const c = this.ai.flow.clearanceAt(this.position.x, this.position.z);
      if (c < STEER.wallRadius) {
        this.ai.flow.sample(this.position.x, this.position.z, this._flow);
        const k = (1 - c / STEER.wallRadius) * STEER.wallStrength;
        wantX += this._flow.x * k;
        wantZ += this._flow.z * k;
      }
    }

    // ---- smoothing -----------------------------------------------------------
    const l = Math.hypot(wantX, wantZ);
    if (l > 1e-4) { wantX /= l; wantZ /= l; }
    const k = 1 - Math.exp(-h / STEER.smoothTime);
    this._smoothX += (wantX - this._smoothX) * k;
    this._smoothZ += (wantZ - this._smoothZ) * k;

    // ---- statuses ------------------------------------------------------------
    const slow = this.ai.combat?.slowOf?.(this) ?? this.statusSlow ?? 1;
    if (this.ai.combat?.isRooted?.(this)) speed = 0;
    speed *= clamp(slow, 0, 1.5);

    this._integrate(h, this._smoothX * speed, this._smoothZ * speed);

    // ---- facing --------------------------------------------------------------
    // A committed actor turns much more slowly, which is what lets a player
    // circle out of a telegraphed swing.
    let turn = arch.turnRate * (committed ? 0.22 : 1);
    if (t && (committed || speed < 0.05)) {
      this.yawTarget = Math.atan2(t.position.x - this.position.x, t.position.z - this.position.z);
    } else if (speed > 0.05) {
      this.yawTarget = Math.atan2(this._smoothX, this._smoothZ);
    }
    this.yaw = approachAngle(this.yaw, this.yawTarget, turn * h);
  }

  /** Write the desired horizontal velocity and let the controller collide. */
  _integrate(h, vx, vz) {
    // Acceleration toward the desired velocity rather than a direct assignment:
    // a heavy brute must not change direction in one frame, and the difference
    // in `accel` between the archetypes is most of what makes them feel
    // different to fight.
    const a = this.arch.accel * h;
    const dx = vx - this.velocity.x, dz = vz - this.velocity.z;
    const dl = Math.hypot(dx, dz);
    if (dl > a) {
      this.velocity.x += (dx / dl) * a;
      this.velocity.z += (dz / dl) * a;
    } else {
      this.velocity.x = vx;
      this.velocity.z = vz;
    }
    if (this.char?.enabled) this.char.move(h);
    else {
      this.position.x += this.velocity.x * h;
      this.position.z += this.velocity.z * h;
    }

    // Acceleration in the actor's own frame, for the cloth solver and the lean.
    const ax = (this.velocity.x - this._prevVX) / Math.max(1e-4, h);
    const az = (this.velocity.z - this._prevVZ) / Math.max(1e-4, h);
    this._prevVX = this.velocity.x;
    this._prevVZ = this.velocity.z;
    const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
    this._accelLocalX = ax * c - az * s;
    this._accelLocalZ = ax * s + az * c;
  }

  /* ==================================================================== */
  /* the frame                                                            */
  /* ==================================================================== */

  update(dt, camFocus) {
    if (!this.root.visible) return;

    // ---- LOD ----------------------------------------------------------------
    const d = distXZ(this.position, camFocus);
    const band = d < ANIM.lodNear ? 0 : d < ANIM.lodMid ? 1 : 2;
    if (band !== this.lodBand) {
      this.lodBand = band;
      this.anim.stride = ANIM.lodStride[band];
      // A shadow at 27 m contributes a shadow map texel or two and costs a full
      // skinned draw in the shadow pass. Bosses always cast — theirs is most of
      // how the arena reads.
      const cast = band < 2 || this.isBoss;
      for (const m of this.meshes) if (m.name.endsWith('.glow') === false) m.castShadow = cast;
    }

    if (this.state === S.DEAD) {
      if (this.ragdoll) {
        this._poseFromRagdoll();
        // Corpses dim as they cool, which is also how the eyes go out.
        const fade = clamp01((this.corpseUntil - this.ctx.time.elapsed) / DEATH.corpseFade);
        this.materials.glow.emissiveIntensity = this.asset.skin.eyeGain * fade * 0.5;
      }
      return;
    }

    // ---- head tracking ------------------------------------------------------
    const t = this.target;
    if (t) {
      this._v.subVectors(t.position, this.position);
      let dy = Math.atan2(this._v.x, this._v.z) - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.anim.lookTargetYaw = clamp(dy * 180 / Math.PI, -62, 62);
      this.anim.lookTargetPitch = clamp(
        -Math.atan2(this._v.y + (t.height ?? 1.8) * 0.7 - this.height * 0.85,
          Math.max(0.5, Math.hypot(this._v.x, this._v.z))) * 180 / Math.PI, -22, 26);
    } else {
      this.anim.lookTargetYaw *= 0.9;
      this.anim.lookTargetPitch *= 0.9;
    }

    // ---- animation ----------------------------------------------------------
    this.anim.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.anim.lean = clamp(this._accelLocalZ * 0.018, -0.30, 0.30);
    this.anim.leanSide = clamp(-this._accelLocalX * 0.016, -0.26, 0.26);
    this.anim.wind = this.lodBand === 0 ? 0.09 : 0;
    const posed = this.anim.update(dt);

    // ---- transform ----------------------------------------------------------
    if (!this.launch.active) {
      this.root.position.copy(this.position);
      this.root.rotation.y = this.yaw;
      this.root.updateMatrix();
    }
    this.root.updateMatrixWorld(true);
    if (posed) {
      // Secondary motion only in the near band: at 27 m a two-pixel hem lag is
      // invisible and it is the most expensive part of the pose.
      this.anim.apply(this.bones, this.lodBand === 0 ? dt : 0,
        this._accelLocalX, this._accelLocalZ);
      this.root.updateMatrixWorld(true);
    }

    // ---- the eyes -----------------------------------------------------------
    // Brighter during a wind-up. It is a tiny piece of geometry and it is the
    // only part of an enemy that is legible at 40 px, so it carries the "I am
    // about to hit you" signal further than the pose does.
    if (this.state === S.WINDUP || this.state === S.SPECIAL) {
      const k = clamp01(this.act.t / Math.max(0.05, this.act.windup ?? 0.5));
      this.materials.glow.emissiveIntensity =
        this.asset.skin.eyeGain * (1 + k * 2.2);
    } else if (this.act.kind !== 'channel') {
      this.materials.glow.emissiveIntensity = lerp(
        this.materials.glow.emissiveIntensity, this.asset.skin.eyeGain, dt * 5);
    }
  }

  /* ==================================================================== */
  /* animation events                                                     */
  /* ==================================================================== */

  _onAnimEvent(name) {
    switch (name) {
      case 'foot':
        if (this.lodBand === 0) {
          this.anim.impulseZ -= 1.2;
          this.ai.footstep(this);
        }
        break;
      case 'swing':
        this.ai.cue(this.weight > 2 ? 'swing.blunt' : 'swing.blade', this.position, 0.7);
        break;
      case 'roar':
        this._cueVox('growl', 1.0);
        break;
      case 'bodyfall':
        this.ai.shake(this.weight > 3 ? 0.20 : 0.06, 0.4);
        break;
      default:
        break;
    }
  }

  _cueVox(kind, gain) {
    if (this.lodBand > 1) return;
    this.ai.cue(`vox.${this.arch.voice}.${kind}`, this.position, gain, this.height * 0.75);
  }

  /* ==================================================================== */
  /* introspection                                                        */
  /* ==================================================================== */

  get stateName() { return S_NAME[this.state]; }

  debug() {
    return {
      id: this.id, kind: this.kind, state: this.stateName,
      hp: `${Math.round(this.stats.hp)}/${this.stats.hpMax}`,
      target: this.target?.id ?? this.target?.name ?? null,
      slot: this.slot, lod: this.lodBand,
      pos: [+this.position.x.toFixed(1), +this.position.y.toFixed(1), +this.position.z.toFixed(1)],
    };
  }

  dispose() {
    const P = this.ctx?.peek?.('physics');
    if (this.char) P?.destroyCharacter?.(this.char);
    this.char = null;
    if (this.ragdoll) P?.despawnRagdoll?.(this.ragdoll);
    this.ragdoll = null;
    for (const key of ['body', 'gear', 'glow']) this.materials[key]?.dispose?.();
    this.skeleton?.dispose?.();
    this.root.removeFromParent();
  }
}

export function distXZ(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export { S as ACTOR_STATE, S_NAME as ACTOR_STATE_NAMES };
