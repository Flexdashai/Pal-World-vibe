import * as THREE from 'three';
import { CAMERA } from '../core/config.js';

/**
 * MONARCH — the isometric camera rig.
 *
 * Yaw, pitch and FOV are FIXED by `config.CAMERA` and this file never changes
 * them: the entire art direction, from how tall a wall may be to how the
 * occluder fade is computed, is derived from those three numbers. What this rig
 * owns is where the boom is pointing, how long it is, and how it shakes.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THAT MATTERS MOST
 *
 * When `setControlEnabled(false)` is called, the shot harness owns the camera
 * and this rig must not touch it. A player system that keeps writing
 * `camera.position` silently overrides every shot's framing — and because the
 * override still produces a plausible-looking frame, it is invisible in a
 * screenshot and can survive for weeks. `PlayerSystem.update` returns before
 * calling into here; `release()` additionally drops the rig's internal state so
 * that handing control BACK does not whip the camera across the level.
 *
 * ---------------------------------------------------------------------------
 * FOLLOW MODEL
 *
 * A critically damped spring (not a lerp) on the focus point. A lerp's response
 * depends on frame rate; a critically damped spring converges in a fixed time
 * regardless of dt, which on a machine that renders one frame in ten seconds is
 * the difference between "smooth" and "the camera arrives next Tuesday".
 *
 * The focus point is not the player. It is:
 *
 *     player + velocity·LEAD + (cursor − player)·CURSOR_BIAS
 *
 * LEAD puts the space the player is running into on screen. CURSOR_BIAS pushes
 * the frame toward what the player is aiming at, which is how every ARPG since
 * Diablo II has kept the mouse-side of the screen useful. Both are clamped, or
 * a fast run plus a far cursor walks the hero off the bottom of the frame.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LEAD HAS ITS OWN, ASYMMETRIC SMOOTHING
 *
 * The follow spring is critically damped and does not overshoot — measured, no
 * sign change in the spring's error and the focus never falls behind the hero.
 * The camera still visibly recoiled on every stop, and the spring was innocent:
 * the TARGET was moving. Velocity collapses from 6.3 m/s to zero in ~90 ms, so
 * the lead term collapsed with it and yanked the focus 1.64 m backwards at a
 * measured 9 m/s — faster than the hero can run, in the opposite direction, for
 * the crime of letting go of a key.
 *
 * So the lead is smoothed on its own clock, fast in and slow out. Fast in
 * (0.10 s) because revealing the space ahead is the whole point and it must not
 * lag the start of a run; slow out (0.42 s) because nothing about stopping is
 * urgent. The follow spring is untouched at 0.09 s, so the camera still starts
 * moving on the frame the key is pressed — which is what the player actually
 * judges responsiveness by.
 *
 * Measured after: peak reverse 2.82 m/s instead of 9.59, camera still moving on
 * the first fixed step (16.7 ms), focus still never behind the hero.
 */

/** Seconds of velocity to lead by, and the metres that lead may reach. */
const LEAD_TIME = 0.28;
const LEAD_MAX = 2.4;
/** Seconds for the lead to build, and to release. */
const LEAD_IN = 0.10;
const LEAD_OUT = 0.42;
/** Fraction of the player→cursor vector folded into the focus, and its cap. */
const CURSOR_BIAS = 0.17;
const CURSOR_MAX = 2.3;
/** Wheel notch, in metres of boom. */
const ZOOM_STEP = 1.6;

export class CameraRig {
  constructor(player) {
    this.player = player;

    /** Where the boom is actually pointing. Smoothed. */
    this.focus = new THREE.Vector3();
    this.focusVel = new THREE.Vector3();
    this.seeded = false;
    /** The velocity lead, smoothed on its own asymmetric clock. */
    this.lead = new THREE.Vector3();

    this.boom = CAMERA.boom;
    this.boomTarget = CAMERA.boom;
    /** Additive push-in requested by an ultimate / a big cast. */
    this.pushIn = 0;
    this.pushInTarget = 0;

    // ---- shake -------------------------------------------------------------
    /** Trauma model: shake amplitude is trauma², so a small hit is barely felt
     *  and a big one is violent, and the decay is perceptually linear. */
    this.trauma = 0;
    this.traumaFreq = 26;
    this.shakeTime = 0;
    this.shakeOffset = new THREE.Vector3();

    /** Directional impulse — a spring that kicks and returns, used for the
     *  "the world just shoved you" read on a heavy hit. */
    this.impulse = new THREE.Vector3();
    this.impulseVel = new THREE.Vector3();

    // ---- preallocated ------------------------------------------------------
    this._desired = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._noiseSeed = 0;
  }

  /** Drop all smoothing state. Called on teleport and when control is taken
   *  away, so re-acquiring control does not sweep the camera across the level. */
  reset(ctx) {
    this.seeded = false;
    this.focusVel.set(0, 0, 0);
    this.lead.set(0, 0, 0);
    this.trauma = 0;
    this.shakeOffset.set(0, 0, 0);
    this.impulse.set(0, 0, 0);
    this.impulseVel.set(0, 0, 0);
    this.boom = this.boomTarget;
    this.pushIn = this.pushInTarget;
    void ctx;
  }

  /** `camera:shake` handler. Amounts compose by taking the strongest request:
   *  six overlapping hits should not add up to a seizure. */
  addShake(amount = 0.3, duration = 0.3, frequency = 26) {
    this.trauma = Math.min(1, Math.max(this.trauma, amount));
    this.traumaFreq = frequency;
    // `duration` sets the decay rate rather than a timer, so a long shake is a
    // slow fade and a short one snaps back.
    this._traumaDecay = 1 / Math.max(0.05, duration);
  }

  /** `camera:impulse` handler — a directional kick in world space. */
  addImpulse(dir, amount = 0.2) {
    if (!dir) return;
    this._tmp.set(dir.x ?? 0, dir.y ?? 0, dir.z ?? 0);
    if (this._tmp.lengthSq() < 1e-8) return;
    this._tmp.normalize().multiplyScalar(amount);
    this.impulseVel.add(this._tmp);
  }

  /** Wheel zoom, clamped to the boom limits from config. */
  handleWheel(wheel) {
    if (!wheel) return;
    this.boomTarget = THREE.MathUtils.clamp(
      this.boomTarget + wheel * ZOOM_STEP, CAMERA.boomMin, CAMERA.boomMax
    );
  }

  /** 0..1. Drives an additive push-in; the ultimate uses it. */
  setPushIn(v) { this.pushInTarget = THREE.MathUtils.clamp(v, 0, 1); }

  /**
   * Drive the camera. Only ever called when the player has control.
   *
   * @param {number} dt   frame delta (scaled — hit-stop should freeze the
   *                      camera along with everything else, or a hit-stopped
   *                      frame has a drifting background)
   */
  update(dt, ctx) {
    const cam = ctx.camera;
    const p = this.player.position;
    const v = this.player.velocity;

    // ---- desired focus -----------------------------------------------------
    this._desired.copy(p);
    this._desired.y += CAMERA.focusLift;

    this._tmp.set(v.x, 0, v.z).multiplyScalar(LEAD_TIME);
    if (this._tmp.lengthSq() > LEAD_MAX * LEAD_MAX) this._tmp.setLength(LEAD_MAX);
    // Exponential, not a lerp: the rate must not depend on frame time, and dt
    // here reaches the engine's 0.1 s clamp routinely on this machine.
    const growing = this._tmp.lengthSq() > this.lead.lengthSq();
    const k = 1 - Math.exp(-dt / (growing ? LEAD_IN : LEAD_OUT));
    this.lead.lerp(this._tmp, k);
    this._desired.add(this.lead);

    if (ctx.input.groundValid) {
      this._tmp.set(ctx.input.ground.x - p.x, 0, ctx.input.ground.z - p.z)
        .multiplyScalar(CURSOR_BIAS);
      if (this._tmp.lengthSq() > CURSOR_MAX * CURSOR_MAX) this._tmp.setLength(CURSOR_MAX);
      this._desired.add(this._tmp);
    }

    // ---- critically damped spring -----------------------------------------
    if (!this.seeded) {
      this.focus.copy(this._desired);
      this.focusVel.set(0, 0, 0);
      this.seeded = true;
    } else {
      // Critically damped implicit integrator (the SmoothDamp form): the cubic
      // is a Padé approximation of exp(-x) that stays stable at ANY dt, which
      // matters because dt here reaches the engine's 0.1 s clamp routinely.
      //   change = current - target
      //   temp   = (v + ω·change)·dt
      //   v'     = (v - ω·temp)·exp
      //   x'     = target + (change + temp)·exp
      const omega = 2 / Math.max(1e-3, CAMERA.followTime);
      const x = omega * dt;
      const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      this._tmp.subVectors(this.focus, this._desired);
      this._tmp2.copy(this.focusVel).addScaledVector(this._tmp, omega).multiplyScalar(dt);
      this.focusVel.addScaledVector(this._tmp2, -omega).multiplyScalar(exp);
      this._tmp.add(this._tmp2).multiplyScalar(exp);
      this.focus.copy(this._desired).add(this._tmp);
    }

    // ---- boom --------------------------------------------------------------
    this.handleWheel(ctx.input.wheel);
    this.pushIn += (this.pushInTarget - this.pushIn) * Math.min(1, dt * 3.4);
    const boomWanted = THREE.MathUtils.clamp(
      this.boomTarget - this.pushIn * (this.boomTarget - CAMERA.boomMin) * 0.42,
      CAMERA.boomMin, CAMERA.boomMax
    );
    this.boom += (boomWanted - this.boom) * Math.min(1, dt * 7.0);

    // ---- shake -------------------------------------------------------------
    this._updateShake(dt);

    // ---- pose --------------------------------------------------------------
    this.apply(cam);
  }

  /**
   * Shake and impulse, resolved in SCREEN space.
   *
   * A world-space shake on a 45° camera moves the frame diagonally, which reads
   * as the camera being dragged rather than as a jolt. Building the offset from
   * the camera's own right/up axes makes it read the same at every yaw, and
   * makes an impulse from the +X direction actually push the frame right.
   */
  _updateShake(dt) {
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - (this._traumaDecay ?? 3.2) * dt);
      this.shakeTime += dt;
      const amp = this.trauma * this.trauma;
      const f = this.traumaFreq;
      const t = this.shakeTime;
      // Three incommensurate sinusoids per axis: cheap, deterministic (no RNG,
      // so captures are reproducible) and does not read as a sine wave.
      const sx = Math.sin(t * f) * 0.6 + Math.sin(t * f * 2.31 + 1.7) * 0.3 + Math.sin(t * f * 4.13 + 0.4) * 0.1;
      const sy = Math.sin(t * f * 1.17 + 2.2) * 0.6 + Math.sin(t * f * 2.71 + 0.9) * 0.3 + Math.sin(t * f * 5.03) * 0.1;
      this.shakeOffset.set(sx * amp * 0.42, sy * amp * 0.34, 0);
    } else if (this.shakeOffset.lengthSq() > 1e-8) {
      this.shakeOffset.multiplyScalar(Math.exp(-dt * 12));
    }

    // Impulse: a spring back to zero. Stiff and heavily damped — the kick must
    // be over inside ~0.25 s or it turns into a wobble.
    if (this.impulse.lengthSq() > 1e-8 || this.impulseVel.lengthSq() > 1e-8) {
      this._tmp.copy(this.impulse).multiplyScalar(-58);
      this.impulseVel.addScaledVector(this._tmp, dt);
      this.impulseVel.multiplyScalar(Math.exp(-dt * 11));
      this.impulse.addScaledVector(this.impulseVel, dt);
      if (this.impulse.lengthSq() < 1e-9 && this.impulseVel.lengthSq() < 1e-9) {
        this.impulse.set(0, 0, 0);
        this.impulseVel.set(0, 0, 0);
      }
    }
  }

  /** Place the camera on the fixed boom about the (already smoothed) focus. */
  apply(cam) {
    const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch);
    const boom = this.boom;

    this._eye.set(
      this.focus.x + Math.sin(CAMERA.yaw) * boom * cp,
      this.focus.y - sp * boom,
      this.focus.z + Math.cos(CAMERA.yaw) * boom * cp
    );

    // Screen basis at the fixed yaw/pitch. Right is the yaw-rotated +X; up is
    // the camera's own up, which at a −52° pitch is mostly world +Y tilted back.
    this._right.set(Math.cos(CAMERA.yaw), 0, -Math.sin(CAMERA.yaw));
    this._up.set(
      -Math.sin(CAMERA.yaw) * sp,
      cp,
      -Math.cos(CAMERA.yaw) * sp
    );

    this._eye.addScaledVector(this._right, this.shakeOffset.x + this.impulse.x);
    this._eye.addScaledVector(this._up, this.shakeOffset.y + this.impulse.y);

    cam.position.copy(this._eye);
    cam.rotation.set(CAMERA.pitch, CAMERA.yaw, 0);
    if (cam.fov !== CAMERA.fov) {
      // The shot harness changes fov; restore it the moment gameplay resumes,
      // or the game runs for the rest of the session at the last shot's lens.
      cam.fov = CAMERA.fov;
      cam.updateProjectionMatrix();
    }
  }

  stats() {
    return {
      boom: +this.boom.toFixed(2),
      lead: +this.lead.length().toFixed(2),
      focus: [+this.focus.x.toFixed(2), +this.focus.y.toFixed(2), +this.focus.z.toFixed(2)],
      trauma: +this.trauma.toFixed(3),
      pushIn: +this.pushIn.toFixed(2),
    };
  }
}
