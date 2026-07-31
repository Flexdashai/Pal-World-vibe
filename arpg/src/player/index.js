import * as THREE from 'three';
import { CAMERA, UNITS } from '../core/config.js';
import { ELEMENTS } from '../core/palette.js';

/**
 * STUB — still owned by the `player` agent. No rig, no animation, no skills, no
 * dodge, no levelling. A capsule with a camera bolted to it.
 *
 * INTEGRATION-GATE NOTE (read this before rewriting the file)
 * ----------------------------------------------------------
 * Three published contracts ran through this file and all three were dead. A
 * rewrite must keep them alive:
 *
 *  1. **`player:state` is emitted every fixed step, from a REUSED payload.**
 *     `render`, `sky`, `ui` and `audio` all subscribe to it. Without it the
 *     occluder fade and the depth-of-field focus fall back to a ground-plane
 *     guess, the ground mist never parts, the HUD never learns where the player
 *     is, and no footstep can ever play — four subsystems' worth of listener
 *     code was unreachable. ARCHITECTURE.md requires the payload be a reused
 *     object rather than a fresh literal, because this fires at frame rate.
 *
 *  2. **The full actor interface.** `id`, `faction`, `isShadow`, `applyDamage`
 *     and `applyStagger` were missing, so anything that resolved the player out
 *     of a spatial query and tried to damage it would have thrown. The player is
 *     also registered with physics (via `createCharacter`) so those queries can
 *     find it at all.
 *
 *  3. **`physics.createCharacter`.** Movement used to be `position += velocity *
 *     dt`, which walked straight through every wall in the level and left the
 *     entire swept-capsule controller unexercised. It now runs in `fixedUpdate`
 *     through the controller, which is also what makes `char.groundSurface` —
 *     and therefore surface-correct footstep audio — available.
 *
 * The camera rig stays here because `player` owns it per the ownership map, and
 * the `controlEnabled` contract is unchanged: when the shot harness disables
 * control, this file must not touch the camera.
 */
export class PlayerSystem {
  static id = 'player';
  static deps = ['render', 'world'];

  async init(ctx) {
    this.ctx = ctx;

    // ---- actor interface (ARCHITECTURE.md "Actor interface") ----------------
    this.id = 'player';
    this.name = 'The Monarch';
    this.isPlayer = true;
    this.isShadow = false;
    this.faction = 'player';
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.radius = UNITS.playerRadius;
    this.height = UNITS.playerHeight;
    this.stats = { hp: 100, hpMax: 100, level: 1, armour: 0, poise: 40 };
    this.alive = true;
    this.controlEnabled = true;

    // ---- placeholder body ---------------------------------------------------
    this.root = new THREE.Group();
    this.root.name = 'mn.player';
    this._geo = new THREE.CapsuleGeometry(this.radius, this.height - this.radius * 2, 6, 12);
    this._mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.022, 0.020, 0.030, THREE.LinearSRGBColorSpace),
      roughness: 0.55,
      metalness: 0.25,
      // A dim violet self-emission so the silhouette separates from a black wall
      // even with every brazier out of range. The colour comes from the palette,
      // never a literal — the shadow element owns every purple in this game.
      emissive: new THREE.Color().setRGB(
        ELEMENTS.shadow.core[0], ELEMENTS.shadow.core[1], ELEMENTS.shadow.core[2],
        THREE.LinearSRGBColorSpace
      ),
      // Very low on purpose. `shadow.core` is nearly pure blue in linear space,
      // so anything above ~0.05 turns the whole capsule lavender and it stops
      // reading as a dark silhouette against the brazier pool.
      emissiveIntensity: 0.045,
    });
    const body = new THREE.Mesh(this._geo, this._mat);
    body.position.y = this.height * 0.5;
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);
    ctx.scene.add(this.root);
    ctx.get('render').registerMaterial(this._mat);

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

    // `world:ready` fires during world.init(), which the registry runs BEFORE
    // ours, so subscribing is not enough — read the spawn point directly as
    // well. The listener stays for the level-transition case.
    this._offReady = ctx.events.on('world:ready', (e) => {
      if (e?.spawn) this.teleport(e.spawn);
    });
    const spawn = ctx.peek('world')?.debugFocus?.('hall')?.pos;
    // Through the controller either way, so the capsule starts depenetrated and
    // ground-probed rather than at a guessed y.
    this.teleport(spawn ? { x: spawn[0], y: 0, z: spawn[2] } : { x: 0, y: 0, z: 0 });

    // ---- preallocated scratch. Nothing below allocates. ----------------------
    this._focus = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    /** THE reused `player:state` payload. Never replaced, never cloned. */
    this._state = {
      position: this.position,
      velocity: this.velocity,
      moving: false,
      dashing: false,
      casting: false,
    };
    this._speed = 6.2;
    this._pose = 'idle';
  }

  // =========================================================================
  // public surface
  // =========================================================================

  setControlEnabled(v) { this.controlEnabled = !!v; }

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
  }

  /** Owner-applied damage, per the actor interface: the target applies it, the
   *  emitter never does. Returns the amount actually taken. */
  applyDamage({ amount = 0, element = 'physical', crit = false, dir = null, source = null } = {}) {
    if (!this.alive || amount <= 0) return 0;
    // Diablo-style flat mitigation curve, placeholder until `player` owns stats.
    const taken = amount * (1 - Math.min(0.75, this.stats.armour / 1000));
    this.stats.hp = Math.max(0, this.stats.hp - taken);
    if (this.stats.hp === 0) this.alive = false;
    void element; void crit; void dir; void source;
    return taken;
  }

  /** Poise-gated stagger. The stub has no animation to interrupt, so this only
   *  keeps the interface honest for `combat`. */
  applyStagger(amount = 0, dir = null) {
    void dir;
    return amount > this.stats.poise;
  }

  /** `idle` | `run` | `cast` | `dash` | `arise` | `ultimate`. The stub has no rig,
   *  so this records intent only — but the shot harness calls it on every shot
   *  and a missing method is a silent no-op forever. */
  debugPose(name) {
    this._pose = name ?? 'idle';
    this._state.casting = name === 'cast' || name === 'ultimate' || name === 'arise';
    this._state.dashing = name === 'dash';
    return this._pose;
  }

  // =========================================================================
  // frame
  // =========================================================================

  /**
   * Movement runs at the fixed rate because collision does. It reads `h` (the
   * fixed step) and the engine only takes fixed steps out of the SCALED clock,
   * so hit-stop freezes the player along with everything else.
   */
  fixedUpdate(h, ctx) {
    if (!this.controlEnabled) {
      // The shot harness owns the transform, but the systems that key off the
      // player's position still need to know where it is to frame the shot.
      this._publish(ctx);
      return;
    }

    const a = ctx.input.moveAxis;
    if (a.lengthSq() > 0) {
      // WASD is camera-relative: screen up is −X−Z, screen right is +X−Z.
      const s = Math.sin(CAMERA.yaw), c = Math.cos(CAMERA.yaw);
      this._wish.set(a.x * c + a.y * s, 0, -a.x * s + a.y * c).normalize().multiplyScalar(this._speed);
    } else {
      this._wish.set(0, 0, 0);
    }

    // Horizontal velocity is authored, vertical belongs to the controller
    // (gravity, step-down, landing). Writing velocity.y here cancels gravity.
    this.velocity.x = this._wish.x;
    this.velocity.z = this._wish.z;

    if (this.char) {
      this.char.move(h);
    } else {
      this.position.addScaledVector(this.velocity, h);
      this.position.y = 0;
    }

    this._publish(ctx);
  }

  /** Publish the canonical player state. One reused object; `position` and
   *  `velocity` are the live references the actor interface promises. */
  _publish(ctx) {
    const st = this._state;
    st.moving = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z > 0.04;
    ctx.events.emit('player:state', st);
  }

  update(dt, ctx) {
    this.root.position.copy(this.position);

    // Face the direction of travel. A capsule has no front, but the shadow it
    // casts does, and `ui` derives facing from velocity.
    if (this._state.moving) {
      this.root.rotation.y = Math.atan2(this.velocity.x, this.velocity.z);
    }

    // CONTRACT: when control is disabled the shot harness owns the camera. A
    // player system that keeps driving it silently overrides every shot's
    // framing — invisible in a screenshot, and therefore lethal.
    if (!this.controlEnabled) return;

    ctx.input.sample(ctx.camera, 0);

    this._focus.copy(this.position);
    this._focus.y += CAMERA.focusLift;
    const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch);
    ctx.camera.position.set(
      this._focus.x + Math.sin(CAMERA.yaw) * CAMERA.boom * cp,
      this._focus.y - sp * CAMERA.boom,
      this._focus.z + Math.cos(CAMERA.yaw) * CAMERA.boom * cp
    );
    ctx.camera.rotation.set(CAMERA.pitch, CAMERA.yaw, 0);
  }

  debugStats() {
    return {
      stub: true,
      pose: this._pose,
      grounded: this.char?.grounded ?? true,
      surface: this.char?.groundSurface ?? 'none',
    };
  }

  dispose() {
    this._offReady?.();
    if (this.char) this.ctx?.peek?.('physics')?.destroyCharacter?.(this.char);
    this.char = null;
    this._geo?.dispose();
    this._mat?.dispose();
    this.root.parent?.remove(this.root);
  }
}
