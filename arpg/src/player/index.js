import * as THREE from 'three';
import { UNITS } from '../core/config.js';
import { ELEMENTS } from '../core/palette.js';

import { Rig } from './rig.js';
import { buildCharacter, PART_KEYS } from './character.js';
import { buildAppearance } from './appearance.js';
import { Animator } from './animator.js';
import { SecondaryMotion } from './secondary.js';
import { Locomotion, DASH } from './locomotion.js';
import { CameraRig } from './camera.js';
import { Stats, xpForKill } from './stats.js';
import { ShadowArmy } from './shadowarmy.js';
import { MonarchAura } from './aura.js';
import { DashTrail } from './trail.js';

/**
 * MONARCH — the player subsystem.
 *
 *   id    'player'
 *   deps  ['render', 'physics', 'world']
 *
 * Owns the hero (a procedurally generated skinned character with a 46-bone rig
 * and a code-authored animation set), movement and dodge, the isometric camera
 * rig, stats and levelling, and shadow extraction.
 *
 * ---------------------------------------------------------------------------
 * FILE MAP
 *
 *   rig.js          the skeleton: proportions, bind pose, dynamic-bone table
 *   geometry.js     the mesh kit: patch/tube/shell primitives + auto-skinning
 *   character.js    the hero's actual geometry, part by part
 *   appearance.js   material set (metal / leather / cloth / skin / emissive)
 *   clips.js        the authored animation library, in euler degrees
 *   animator.js     blend tree, action layer, additive layers, root motion
 *   secondary.js    spring solver for the coat, collar and hair
 *   locomotion.js   WASD + click-to-move steering, acceleration, dash i-frames
 *   camera.js       the isometric boom, damping, lead, shake, push-in
 *   stats.js        primaries, derived stats, the XP curve
 *   shadowarmy.js   extraction rolls, the corpse ledger, ARISE
 *   aura.js         the rim light, ground ring, monarch column and glyphs
 *   trail.js        the dash ribbon and ground streak
 *
 * ---------------------------------------------------------------------------
 * THREE PUBLISHED CONTRACTS THIS FILE MUST KEEP ALIVE
 *
 *  1. **`player:state` every fixed step, from a REUSED payload.** `render`
 *     (occluder fade + depth-of-field focus), `sky` (ground mist parting),
 *     `ui` (HUD position/facing) and `audio` (footstep cadence and surface) all
 *     subscribe. A fresh object literal here is forbidden — it fires at 60 Hz.
 *
 *  2. **The full actor interface.** `id`, `faction`, `isShadow`, `applyDamage`,
 *     `applyStagger`, live `position`/`velocity` references. The player is
 *     registered with `physics` through `createCharacter`, so spatial queries
 *     find it and can then damage it.
 *
 *  3. **Release the camera when control is disabled.** The shot harness owns
 *     the camera during a capture. A player system that keeps driving it
 *     silently overrides every shot's framing, and the result still looks like
 *     a plausible frame — which is what makes the bug lethal.
 */
export class PlayerSystem {
  static id = 'player';
  static deps = ['render', 'physics', 'world'];

  async init(ctx) {
    this.ctx = ctx;
    /** A forked stream so extraction rolls never perturb another subsystem's
     *  sequence. ARCHITECTURE.md rule 4 — no Math.random anywhere. */
    this.rng = ctx.rng.fork();

    // ---- actor interface ----------------------------------------------------
    this.id = 'player';
    this.name = 'The Monarch';
    this.isPlayer = true;
    this.isShadow = false;
    this.faction = 'player';
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.radius = UNITS.playerRadius;
    this.height = UNITS.playerHeight;
    this.alive = true;
    this.controlEnabled = true;

    // ---- progression --------------------------------------------------------
    // `stats` IS the actor interface's stats object: hp, hpMax, armour, poise
    // and level all live on it, alongside mana and the derived combat numbers
    // `ui` polls. One object, so nothing can drift out of sync.
    this.stats = new Stats(ctx.events);
    this.army = new ShadowArmy(ctx, this.stats, this.rng.fork());

    // ---- scene graph --------------------------------------------------------
    this.root = new THREE.Group();
    this.root.name = 'mn.player';
    ctx.scene.add(this.root);

    // ---- the character ------------------------------------------------------
    const t0 = performance.now();
    this.rig = new Rig();
    this.root.add(this.rig.rootBone);

    const built = buildCharacter(this.rig);
    this.appearance = buildAppearance(ctx);
    this.meshes = [];
    this._geometries = [];
    const bindMatrix = new THREE.Matrix4();   // identity: geometry is in bind-world space
    for (const key of PART_KEYS) {
      const geo = built.geometries[key];
      if (!geo) continue;
      const mesh = new THREE.SkinnedMesh(geo, this.appearance.byKey[key]);
      mesh.name = `mn.player.${key}`;
      mesh.castShadow = true;
      // The hero receives their own shadow (the pauldrons onto the chest, the
      // coat onto the boots) — it is most of what makes the armour read as
      // layered rather than painted on.
      mesh.receiveShadow = key !== 'eyes' && key !== 'trim';
      // The bind-pose bounding sphere is wrong the moment the coat billows or
      // an arm goes overhead, and the hero is always at the camera focus, so
      // there is nothing to gain from culling them.
      mesh.frustumCulled = false;
      mesh.bindMode = THREE.AttachedBindMode;
      mesh.bind(this.rig.skeleton, bindMatrix);
      if (key === 'trim') mesh.userData.mnGlow = 2.0;
      if (key === 'eyes') mesh.userData.mnGlow = 3.4;
      this.root.add(mesh);
      this.meshes.push(mesh);
      this._geometries.push(geo);
    }
    this.meshStats = built.stats;

    // ---- animation ----------------------------------------------------------
    this.anim = new Animator(this.rig);
    this.anim.onEvent = (e, clip) => this._onAnimEvent(e, clip);
    this.secondary = new SecondaryMotion(this.rig);
    this.locomotion = new Locomotion(this);
    this.locomotion.speedMul = this.stats.moveSpeedMul;
    this.cameraRig = new CameraRig(this);

    // ---- effects ------------------------------------------------------------
    this.aura = new MonarchAura(ctx, this.root, this.rng.fork());
    this.trail = new DashTrail(ctx, ctx.scene);

    // ---- physics ------------------------------------------------------------
    // The controller writes directly into `this.position` / `this.velocity`, so
    // there is exactly one copy of the player's transform in the process.
    const physics = ctx.peek('physics');
    this.char = physics?.createCharacter?.({
      actor: this,
      radius: this.radius,
      height: this.height,
      stepHeight: 0.42,
      weight: 82,
    }) ?? null;

    // ---- spawn --------------------------------------------------------------
    // `world:ready` fires during world.init(), which the registry runs BEFORE
    // ours, so subscribing is not enough — read the spawn point directly too.
    // The listener stays for the level-transition case.
    this._offs = [];
    this._on('world:ready', (e) => { if (e?.spawn) this.teleport(e.spawn); });
    const spawn = ctx.peek('world')?.debugFocus?.('hall')?.pos;
    this.teleport(spawn ? { x: spawn[0], y: 0, z: spawn[2] } : { x: 0, y: 0, z: 0 });

    // ---- events -------------------------------------------------------------
    this._wireEvents();

    // ---- preallocated scratch. Nothing below this line allocates. -----------
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._chest = new THREE.Vector3();
    this._audioCue = { cue: '', position: new THREE.Vector3(), gain: 1 };
    this._toast = { text: '', tone: '' };
    this._sysWindow = { kind: 'system', title: '', lines: [], duration: 4.0 };
    /** THE reused `player:state` payload. Never replaced, never cloned. */
    this._state = {
      position: this.position,
      velocity: this.velocity,
      moving: false,
      dashing: false,
      casting: false,
    };

    // ---- action state -------------------------------------------------------
    this._pose = 'idle';
    this._debugPosed = false;
    this._attackIndex = 0;
    this._lastAttack = -10;
    this._ultimateUntil = 0;
    this._ariseUntil = 0;
    this._pendingArise = false;
    this._staggerUntil = 0;
    this._dmgFrame = -1;
    this._dmgAmount = -1;
    this._dmgSource = null;
    /** Action input is edge-triggered, but `fixedUpdate` can run up to
     *  MAX_SUBSTEPS times per rendered frame while `input.keysPressed` is only
     *  cleared in `endFrame`. Without this guard one keypress fires up to five
     *  attacks — which on a machine where a frame costs seconds is EVERY frame. */
    this._actionFrame = -1;
    this._ultBurst = { position: this.position, radius: 6.5, element: 'shadow', magnitude: 1.4 };

    // Seed the pose so the very first rendered frame shows a posed character
    // rather than the bind pose (which is a T-ish A-pose and looks broken).
    this.anim.update(0);
    this.anim.applyTo(this.rig);
    this.root.updateMatrixWorld(true);
    this.secondary.snap(this.root);

    console.info(
      `[player] rig ${this.rig.count} bones (${this.secondary.chains.length} dynamic) | ` +
      `${built.stats.triangles} tris, ${built.stats.vertices} verts, ${this.meshes.length} parts | ` +
      `${Object.keys(this.anim.clips).length} clips | build ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  _on(type, fn) { this._offs.push(this.ctx.events.on(type, fn)); }

  _wireEvents() {
    // ---- camera ------------------------------------------------------------
    this._on('camera:shake', (e) => {
      this.cameraRig.addShake(e?.amount ?? 0.3, e?.duration ?? 0.3, e?.frequency ?? 26);
    });
    this._on('camera:impulse', (e) => this.cameraRig.addImpulse(e?.dir, e?.amount ?? 0.2));

    // ---- damage ------------------------------------------------------------
    // ARCHITECTURE.md: `combat:hit` means damage dealt TO `target`, and the
    // target's own listener applies it. `applyDamage()` is the other entry
    // point (environment, scripted). Both funnel through `_receiveDamage`,
    // which de-duplicates on (frame, amount) so an emitter that does BOTH —
    // calls applyDamage and emits — cannot double-hit the player.
    this._on('combat:hit', (e) => {
      if (!e || e.target !== this) return;
      this._receiveDamage(e.amount ?? 0, e.element ?? 'physical', !!e.crit, e.dir ?? null, e.source ?? null);
    });

    // ---- kills / xp / extraction -------------------------------------------
    this._on('combat:kill', (e) => this._onKill(e));
    this._on('shadow:arise', () => {
      this.army.onArise();
      this.aura.flash(0.7);
    });

    // ---- casting -----------------------------------------------------------
    // `combat` owns skills and emits `player:cast`; the animation is ours.
    this._on('player:cast', (e) => {
      if (this.anim.frozen) return;
      this.anim.play('cast', { fade: 0.07 });
      this._state.casting = true;
      if (e?.dir) this.locomotion.yawTarget = Math.atan2(e.dir.x, e.dir.z);
    });

    // ---- environment -------------------------------------------------------
    // A nearby explosion punches the coat. Free spectacle: the cloth solver
    // already takes a world-space impulse.
    this._on('fx:explosion', (e) => {
      if (!e?.position) return;
      this._v.subVectors(this.position, e.position);
      const d = this._v.length();
      const r = e.radius ?? 4;
      if (d > r * 1.6 || d < 1e-3) return;
      const k = (1 - d / (r * 1.6)) * (e.magnitude ?? 1) * 26;
      this.secondary.impulse.addScaledVector(this._v.multiplyScalar(1 / d), k);
    });
  }

  // =========================================================================
  // public surface
  // =========================================================================

  /**
   * CONTRACT: when control is disabled the shot harness owns the camera and the
   * transform. We keep animating and keep publishing `player:state` — four other
   * subsystems need to know where the hero is to frame the shot — but we touch
   * neither the camera nor the position.
   */
  setControlEnabled(v) {
    const was = this.controlEnabled;
    this.controlEnabled = !!v;
    if (was !== this.controlEnabled) {
      // Reset the rig either way: releasing means dropping our smoothing state,
      // and re-acquiring means re-seeding it at wherever the harness left the
      // hero, instead of sweeping the camera across the level to catch up.
      this.cameraRig.reset(this.ctx);
      this.locomotion.clearMoveTarget();
      if (this.controlEnabled) {
        this._debugPosed = false;
        this.anim.frozen = false;
        this.aura.setPower(0);
        this.cameraRig.setPushIn(0);
      }
    }
  }

  teleport(p) {
    if (this.char) {
      // Through the controller so the capsule is depenetrated and ground-probed
      // at the destination; assigning `position` alone can leave it in a wall.
      this.char.teleport(p.x, p.y ?? 0, p.z);
    } else {
      this.position.set(p.x, p.y ?? 0, p.z);
      this.velocity.set(0, 0, 0);
    }
    this.root.position.copy(this.position);
    this.root.updateMatrixWorld(true);
    // The cloth must not whip across the level after a teleport, and the camera
    // must not pan there over half a second.
    this.secondary.reset();
    this.secondary.snap(this.root);
    this.cameraRig.seeded = false;
    this.locomotion.clearMoveTarget();
    this.trail.setEmitting(false, this.position);
    return this;
  }

  /**
   * Owner-applied damage, per the actor interface. Returns the amount actually
   * taken after mitigation, or 0 if the hit was dodged.
   */
  applyDamage({ amount = 0, element = 'physical', crit = false, dir = null, source = null } = {}) {
    return this._receiveDamage(amount, element, crit, dir, source);
  }

  _receiveDamage(amount, element, crit, dir, source) {
    if (!this.alive || amount <= 0) return 0;
    // i-frames: the whole point of the dash.
    if (this.locomotion.invulnerable) {
      this._emitToast('DODGE', 'good');
      return 0;
    }
    // De-duplicate: an emitter that both calls applyDamage() and emits
    // `combat:hit` would otherwise hit twice in the same frame. The key
    // includes the source, so two DIFFERENT enemies landing the same number in
    // one frame still both count — only the same blow arriving twice is
    // swallowed.
    const frame = this.ctx.time.frame;
    if (frame === this._dmgFrame && source === this._dmgSource &&
        Math.abs(amount - this._dmgAmount) < 1e-6) return 0;
    this._dmgFrame = frame;
    this._dmgAmount = amount;
    this._dmgSource = source;

    const taken = this.stats.takeDamage(amount);
    this.anim.flinch();

    // Feedback proportional to the bite taken out of the health bar, so a
    // scratch does not shake the screen as hard as a boss slam.
    const severity = Math.min(1, taken / Math.max(1, this.stats.hpMax * 0.22));
    this.cameraRig.addShake(0.16 + severity * 0.38, 0.18 + severity * 0.2, 30);
    if (dir) this.cameraRig.addImpulse(dir, 0.06 + severity * 0.16);
    this.secondary.impulse.set((dir?.x ?? 0) * severity * 9, 2 * severity, (dir?.z ?? 0) * severity * 9);

    if (this.stats.hp <= 0 && this.alive) this._die(source);
    void element; void crit;
    return taken;
  }

  /**
   * Poise-gated stagger. Above poise the hero is knocked out of whatever they
   * were doing; below it they flinch but keep acting.
   *
   * The flinch is an ADDITIVE layer, never an action-layer override: `hurt` is
   * authored as a delta from bind pose, so playing it as a full-body clip would
   * snap the hero to a near-neutral stance mid-run. Being staggered is instead
   * expressed as a short movement lockout plus a stronger additive.
   */
  applyStagger(amount = 0, dir = null) {
    if (!this.alive) return false;
    this.anim.flinch();
    if (amount <= this.stats.poise) return false;
    this._staggerUntil = this.ctx.time.elapsed + 0.34;
    this.anim.stopAction(0.08);
    this.velocity.multiplyScalar(0.25);
    if (dir) this.cameraRig.addImpulse(dir, 0.12);
    return true;
  }

  _die(source) {
    this.alive = false;
    this.velocity.set(0, 0, 0);
    this.anim.play('death', { fade: 0.08 });
    this.aura.setPower(0);
    this.cameraRig.addShake(0.55, 0.7, 18);
    this._sysWindow.title = 'YOU HAVE DIED';
    this._sysWindow.lines = [
      `Level ${this.stats.level} · Rank ${this.stats.rank}`,
      `${this.army.totalExtracted} shadows extracted`,
    ];
    this._sysWindow.duration = 6;
    this.ctx.events.emit('ui:system', this._sysWindow);
    void source;
  }

  /** Bring the hero back at full health. Exposed for `ui`/dev. */
  revive() {
    this.alive = true;
    this.stats.hp = this.stats.hpMax;
    this.stats.mana = this.stats.manaMax;
    this.anim.stopAction(0.25);
    return this;
  }

  /** Play an action clip by name. `combat` uses this to drive skill animations
   *  without having to know anything about the rig. */
  playAction(name, opts) {
    if (this.anim.frozen || !this.alive) return false;
    return this.anim.play(name, opts);
  }

  /** The next attack in the four-hit chain. */
  playAttack() {
    if (this.anim.frozen || !this.alive) return false;
    const t = this.ctx.time.elapsed;
    if (t - this._lastAttack > 1.15) this._attackIndex = 0;
    this._lastAttack = t;
    const name = `attack${(this._attackIndex % 4) + 1}`;
    this._attackIndex++;
    // Later hits in a chain are faster: a combo that does not accelerate feels
    // like four separate attacks rather than one escalating flurry.
    const speed = 1 + Math.min(3, this._attackIndex) * 0.055;
    return this.anim.play(name, { fade: 0.06, speed, restart: true });
  }

  /**
   * `idle` | `run` | `cast` | `dash` | `arise` | `ultimate` (plus `walk`,
   * `hurt`, `death` and `attack1..4`). Used by the shot harness.
   *
   * The pose is FROZEN, not played: the capture pumps 14-16 settle frames with
   * TAA on, and a moving character accumulates history from poses it is no
   * longer in, which ghosts the whole figure. Freezing also makes repeated
   * captures of the same shot pixel-identical, which is the entire point of the
   * harness.
   */
  debugPose(name, opts) {
    const key = name ?? 'idle';
    this._pose = key;
    this._debugPosed = true;
    void opts;

    const ok = this.anim.freezePose(key);
    if (!ok) {
      this.anim.freezePose('idle');
      this._pose = 'idle';
    }

    this._state.casting = key === 'cast' || key === 'ultimate' || key === 'arise';
    this._state.dashing = key === 'dash';

    // The cloth must be settled BEFORE the shutter. The solver runs at 1/120 s
    // and the coat's slowest chain is k = 19, so it needs ~0.5 s of simulated
    // time; the harness only pumps 16 frames, hence the explicit convergence.
    this.secondary.billow = this.anim.billow;
    this.secondary.billowDir = this.anim.billowDir;
    this.anim.applyTo(this.rig);
    this.root.updateMatrixWorld(true);
    this.secondary.snap(this.root, 110);

    // Aura state, snapped rather than ramped for the same reason.
    const power = key === 'ultimate' ? 1.0 : key === 'arise' ? 0.85 : key === 'cast' ? 0.35 : 0;
    this.aura.setPower(power);
    this.aura.power = power;
    this.aura.setArmy(Math.min(1, this.army.count / Math.max(1, this.army.capacity)));
    this.aura.update(0, this.position);

    this.trail.setEmitting(false, this.position);
    return this._pose;
  }

  // =========================================================================
  // fixed step — movement and collision
  // =========================================================================

  fixedUpdate(h, ctx) {
    if (!this.controlEnabled || !this.alive) {
      // The harness owns the transform, but the systems that key off the
      // player's position still need to know where it is to frame the shot.
      if (!this.alive && this.char) this.char.move(h);
      this._publish(ctx);
      return;
    }

    if (this._actionFrame !== ctx.time.frame) {
      this._actionFrame = ctx.time.frame;
      this._readActionInput(ctx);
    }

    // Movement is gated during a committed action (an attack, a cast, ARISE),
    // which is what gives those animations weight. A dash is movement, so it
    // is exempt.
    const committed = (this.anim.actionActive && !this.locomotion.dashing) ||
      ctx.time.elapsed < this._staggerUntil;
    this.locomotion.moveEnabled = !committed;
    this.locomotion.readInput(ctx);
    this.locomotion.speedMul = this.stats.moveSpeedMul;
    this.locomotion.step(h, ctx, this.anim);

    // Root motion from an attack: attacks lunge forward, and moving through the
    // controller is what makes a lunge stop at a wall.
    if (committed && this.anim.rootMotionOut > 0 && !this.locomotion.dashing) {
      const d = this.anim.rootMotionOut;
      this._v.set(Math.sin(this.locomotion.yaw), 0, Math.cos(this.locomotion.yaw));
      this.velocity.x += this._v.x * d / Math.max(1e-4, h);
      this.velocity.z += this._v.z * d / Math.max(1e-4, h);
    }

    this.stats.regen(h);
    this.army.prune(ctx.time.elapsed);
    this._publish(ctx);
  }

  /** Skills, attacks, dash and the two signature buttons. */
  _readActionInput(ctx) {
    const input = ctx.input;

    if (input.pressed('dash') && this.locomotion.canDash() && !this.anim.actionActive) {
      if (this.locomotion.startDash(ctx)) {
        this.anim.play('dash', { fade: 0.05, restart: true });
        this._chestPoint(this._v);
        this.trail.setEmitting(true, this._v);
        this.cameraRig.addImpulse(this.locomotion.dashDir, 0.10);
        this._cue('dash.whoosh', 0.9);
      }
    }
    if (this.locomotion.dashing) {
      this._chestPoint(this._v);
      if (!this.trail.emitting) this.trail.setEmitting(true, this._v);
    } else if (this.trail.emitting) {
      this._chestPoint(this._v);
      this.trail.setEmitting(false, this._v);
    }

    // Primary attack. Auto-chains while held, advancing when the previous swing
    // is 68% done — the window in which a combo feels responsive rather than
    // either sticky or interruptible into nonsense.
    if (input.mouse(0) && !this.locomotion.dashing) {
      const busy = this.anim.actionActive && this.anim.actionPhase < 0.68;
      if (!busy) {
        if (input.groundValid) {
          this._v.set(input.ground.x - this.position.x, 0, input.ground.z - this.position.z);
          if (this._v.lengthSq() > 0.02) {
            this.locomotion.yawTarget = Math.atan2(this._v.x, this._v.z);
            this.locomotion.yaw = this.locomotion.yawTarget;
          }
        }
        this.playAttack();
      }
    }

    // Skill keys. `combat` owns what a skill DOES and emits `player:cast`; if it
    // is not doing anything yet the animation still needs to fire, and
    // `Animator.play` is idempotent for an already-playing clip so the two
    // paths cannot double-trigger.
    for (const k of ['skill1', 'skill2', 'skill3', 'skill4', 'skillQ', 'skillE']) {
      if (input.pressed(k)) {
        this.playAction('cast', { fade: 0.07 });
        this._faceCursor(ctx);
      }
    }

    if (input.pressed('arise')) this.triggerArise();
    if (input.pressed('ultimate')) this.triggerUltimate();
  }

  /**
   * ARISE. The signature beat: raise every eligible corpse in range.
   *
   * `player` emits `shadow:extract`; `ai` spawns the soldier and emits
   * `shadow:arise`. This function never spawns anything itself.
   */
  triggerArise() {
    if (this.anim.frozen || !this.alive) return 0;
    const n = this.army.eligible(this.position, 11);
    this.anim.play('arise', { fade: 0.08, restart: true });
    this.aura.setPower(1);
    this.cameraRig.setPushIn(0.5);
    this._ariseUntil = this.ctx.time.elapsed + 1.9;
    this._pendingArise = true;
    this._cue('arise.summon', 1.0);
    if (n === 0) this._emitToast('No shadows to raise', '');
    return n;
  }

  /** The monarch ultimate: the pose, the aura, the camera push-in. Damage is
   *  `combat`'s; the spectacle is ours. */
  triggerUltimate() {
    if (this.anim.frozen || !this.alive) return false;
    this.anim.play('ultimate', { fade: 0.10, restart: true });
    this.aura.setPower(1);
    this.aura.flash(1);
    this.cameraRig.setPushIn(1);
    this.cameraRig.addShake(0.35, 1.1, 14);
    this._ultimateUntil = this.ctx.time.elapsed + 2.4;
    this._cue('ultimate.cast', 1.0);
    this._sysWindow.title = 'ARISE';
    this._sysWindow.lines = ['The shadows answer their monarch.'];
    this._sysWindow.duration = 3.2;
    this.ctx.events.emit('ui:system', this._sysWindow);
    return true;
  }

  _publish(ctx) {
    const st = this._state;
    const v = this.velocity;
    st.moving = v.x * v.x + v.z * v.z > 0.04;
    st.dashing = this.locomotion.dashing;
    st.casting = this.anim.actionActive &&
      (this.anim.action?.name === 'cast' || this.anim.action?.name === 'arise' ||
       this.anim.action?.name === 'ultimate');
    ctx.events.emit('player:state', st);
  }

  // =========================================================================
  // frame — animation, cloth, camera
  // =========================================================================

  update(dt, ctx) {
    // The cursor's ground point is sampled from LAST frame's camera, before the
    // rig moves it. Sampling after would close a feedback loop: the camera is
    // biased toward the cursor, the cursor's ground point depends on the
    // camera, and the pair drift outward together.
    ctx.input.sample(ctx.camera, 0);

    this._updateActionTimers(ctx);

    // ---- animation ---------------------------------------------------------
    this.anim.speed = this.locomotion.speed;
    if (!this.anim.frozen) {
      this.anim.lean.set(this.locomotion.localAccel.x, this.locomotion.localAccel.y);
      this._updateLookAt(ctx);
    }
    this.anim.update(dt);
    this.anim.applyTo(this.rig);

    // ---- transform ---------------------------------------------------------
    this.root.position.copy(this.position);
    this.root.rotation.y = this.locomotion.yaw;
    this.root.updateMatrixWorld(true);

    // ---- cloth -------------------------------------------------------------
    // Skipped entirely while frozen: `debugPose` has already converged the
    // solver, and letting the wind term keep running during the capture's
    // settle frames would ghost the coat through TAA.
    if (!this.anim.frozen) {
      this.secondary.billow = this.anim.billow;
      this.secondary.billowDir = this.anim.billowDir;
      this.secondary.solve(dt, this.root);
    }

    // ---- effects -----------------------------------------------------------
    this.aura.setArmy(Math.min(1, this.army.count / Math.max(1, this.army.capacity)));
    this.aura.update(this.anim.frozen ? 0 : dt, this.position);

    if (this.anim.frozen) {
      this.trail.update(0, this.position, ctx.camera.position);
    } else {
      this._chestPoint(this._v);
      this.trail.update(dt, this._v, ctx.camera.position);
    }

    // ---- camera ------------------------------------------------------------
    // CONTRACT: the shot harness owns the camera while control is disabled.
    if (!this.controlEnabled) return;
    this.cameraRig.update(dt, ctx);
  }

  /** Time-based release of the held poses, and the ARISE payload. */
  _updateActionTimers(ctx) {
    const t = ctx.time.elapsed;

    if (this._pendingArise && this.anim.action?.name === 'arise' && this.anim.actionTime >= 1.02) {
      this._pendingArise = false;
      const raised = this.army.arise(this.position, 11);
      if (raised > 0) {
        this.aura.flash(1);
        this.cameraRig.addShake(0.30, 0.5, 20);
      }
    }

    if (this._ariseUntil > 0 && t > this._ariseUntil) {
      this._ariseUntil = 0;
      if (this.anim.action?.name === 'arise') this.anim.stopAction(0.30);
      this.aura.setPower(0);
      this.cameraRig.setPushIn(0);
    }
    if (this._ultimateUntil > 0 && t > this._ultimateUntil) {
      this._ultimateUntil = 0;
      if (this.anim.action?.name === 'ultimate') this.anim.stopAction(0.35);
      this.aura.setPower(0);
      this.cameraRig.setPushIn(0);
    }
  }

  /**
   * Head/neck look-at, as an additive layer.
   *
   * The hero looks where the cursor is, clamped to ±58° of yaw so the neck
   * never snaps round. It is a small thing that does a large amount of work:
   * a character whose head tracks the aim reads as *aware*, and at this camera
   * the head is one of only three parts whose orientation is legible at all.
   */
  _updateLookAt(ctx) {
    if (!ctx.input.groundValid || !this.alive) {
      this.anim.lookYaw *= 0.85;
      this.anim.lookPitch *= 0.85;
      return;
    }
    this._v.set(ctx.input.ground.x - this.position.x, 0, ctx.input.ground.z - this.position.z);
    if (this._v.lengthSq() < 0.25) return;
    let d = Math.atan2(this._v.x, this._v.z) - this.locomotion.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const deg = THREE.MathUtils.clamp(d * 180 / Math.PI, -58, 58);
    // Damped, because the cursor can jump the width of the screen in one frame.
    this.anim.lookYaw += (deg - this.anim.lookYaw) * 0.22;
    // Looking slightly down is the resting state — the ground is where the
    // enemies are.
    this.anim.lookPitch += (4 - this.anim.lookPitch) * 0.10;
  }

  // =========================================================================
  // kills, xp, extraction
  // =========================================================================

  _onKill(e) {
    if (!e?.actor || e.actor === this) return;
    // Credit kills by the hero and by their shadows. A missing `killer` is
    // credited to the player: `combat` is entitled not to populate it, and
    // silently dropping all XP is a far worse failure than over-crediting.
    const killer = e.killer;
    if (killer && !killer.isPlayer && !killer.isShadow) return;

    const rank = e.actor.rank ?? (e.actor.isBoss ? 'boss' : e.actor.isElite ? 'elite' : 'common');
    const xp = xpForKill(e.actor.stats?.level ?? this.stats.level, rank);
    const before = this.stats.level;
    this.stats.gainXp(xp);
    if (this.stats.level > before) {
      this.aura.flash(1);
      this.cameraRig.addShake(0.18, 0.5, 16);
      this.stats.hp = this.stats.hpMax;
      this.stats.mana = this.stats.manaMax;
      this.locomotion.speedMul = this.stats.moveSpeedMul;
      this._cue('level.up', 1.0);
    }

    const result = this.army.onKill(e, this.ctx.time.elapsed);
    if (result === 'extracted') this.aura.flash(0.6);
  }

  // =========================================================================
  // animation event sink
  // =========================================================================

  _onAnimEvent(e) {
    switch (e.name) {
      case 'foot':
        // Footstep AUDIO is owned by `audio`, which derives cadence from
        // distance travelled and queries the surface itself — emitting a cue
        // here would double every step. What the event is used for is the
        // physical response: a heavy landing shakes the coat.
        this.secondary.impulse.y -= 1.6;
        break;
      case 'swing':
        this._cue('swing.blade', 0.85);
        break;
      case 'hit':
        // `combat` owns damage. If it is listening it will already have opened
        // its window; this only drives the presentation the player sees.
        this.cameraRig.addShake(0.12, 0.12, 34);
        break;
      case 'shake':
        this.cameraRig.addShake(0.34, 0.45, 20);
        break;
      case 'dashStart':
        this.secondary.impulse.addScaledVector(this.locomotion.dashDir, -34);
        break;
      case 'ariseRelease':
        this.aura.flash(1);
        break;
      case 'ultRelease':
        this.aura.flash(1);
        this.ctx.events.emit('fx:explosion', this._ultBurst);
        break;
      case 'bodyfall':
        this.cameraRig.addShake(0.22, 0.35, 15);
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // helpers
  // =========================================================================

  /** World-space point at the hero's sternum — the origin for the dash trail,
   *  casts and the audio emitter. */
  _chestPoint(out) {
    return out.set(this.position.x, this.position.y + 1.24, this.position.z);
  }

  _faceCursor(ctx) {
    if (!ctx.input.groundValid) return;
    this._v.set(ctx.input.ground.x - this.position.x, 0, ctx.input.ground.z - this.position.z);
    if (this._v.lengthSq() > 0.04) this.locomotion.yawTarget = Math.atan2(this._v.x, this._v.z);
  }

  _cue(name, gain) {
    const c = this._audioCue;
    c.cue = name;
    c.position.copy(this.position);
    c.position.y += 1.2;
    c.gain = gain;
    this.ctx.events.emit('audio:cue', c);
  }

  _emitToast(text, tone) {
    this._toast.text = text;
    this._toast.tone = tone;
    this.ctx.events.emit('ui:toast', this._toast);
  }

  // =========================================================================
  // pre-warm
  // =========================================================================

  /**
   * `render.prewarmMaterials` renders the whole scene once, which compiles every
   * VISIBLE material — including this character's skinned variants, since the
   * hero is in the scene from `init()`. What it cannot reach is the aura column,
   * the glyph ring and the dash trail, all of which start `visible = false`
   * because they are off until a big moment.
   *
   * Those three are additive, blended, glow-tagged materials on a skinned-mesh-
   * adjacent scene graph, and compiling one mid-ultimate is a ~200 ms stall at
   * the single worst moment in the game. So: make them visible, compile against
   * a bound float target (`outputColorSpace` and `toneMapping` are read off the
   * currently bound target and are part of the cache key), and hide them again.
   */
  async prewarmMaterials(ctx) {
    const render = ctx.get('render');
    const r = render.renderer;

    const hidden = [this.aura.column, this.aura.glyphs, this.trail.mesh, this.trail.streak];
    const was = hidden.map((m) => m.visible);
    for (const m of hidden) m.visible = true;
    // A zero-opacity additive material still compiles, but it also still draws;
    // they are restored immediately after and no frame is presented in between.

    const prev = r.getRenderTarget();
    r.setRenderTarget(render.rtHDR ?? prev);
    r.compile(ctx.scene, ctx.camera);
    r.setRenderTarget(prev);

    for (let i = 0; i < hidden.length; i++) hidden[i].visible = was[i];

    console.info('[player] prewarm', {
      parts: this.meshes.length,
      triangles: this.meshStats.triangles,
      bones: this.rig.count,
      clips: Object.keys(this.anim.clips).length,
      programs: r.info.programs?.length ?? 0,
    });
  }

  // =========================================================================
  // introspection
  // =========================================================================

  debugStats() {
    return {
      pose: this._pose,
      posed: this._debugPosed,
      control: this.controlEnabled,
      alive: this.alive,
      position: [+this.position.x.toFixed(2), +this.position.y.toFixed(2), +this.position.z.toFixed(2)],
      grounded: this.char?.grounded ?? true,
      surface: this.char?.groundSurface ?? 'none',
      mesh: this.meshStats,
      anim: this.anim.stats(),
      cloth: this.secondary.stats(),
      locomotion: this.locomotion.stats(),
      camera: this.cameraRig.stats(),
      stats: this.stats.snapshot(),
      army: this.army.stats_(),
      element: ELEMENTS.shadow.srgb,
      dash: { cooldown: DASH.cooldown, distance: DASH.distance },
    };
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;

    if (this.char) this.ctx?.peek?.('physics')?.destroyCharacter?.(this.char);
    this.char = null;

    this.aura?.dispose();
    this.trail?.dispose();

    for (const g of this._geometries) g.dispose();
    this._geometries.length = 0;
    // Library materials belong to `materials` and are disposed there; only the
    // ones this subsystem built itself are ours to free.
    for (const m of this.appearance?.own ?? []) m.dispose();

    this.rig?.dispose();
    this.root?.removeFromParent();
  }
}
