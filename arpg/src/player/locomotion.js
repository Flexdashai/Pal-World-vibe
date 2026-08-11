import * as THREE from 'three';
import { CAMERA } from '../core/config.js';

/**
 * MONARCH — hero movement.
 *
 * Two control schemes at once, because an ARPG needs both and players switch
 * between them mid-fight without thinking about it:
 *
 *   WASD             camera-relative, analogue-feeling, wins whenever it is
 *                    touched (it is the more precise of the two)
 *   RIGHT MOUSE      click/hold to move — the Diablo idiom. Right rather than
 *                    left because LEFT is the primary attack and combat owns
 *                    it; a scheme where the same button both moves and attacks
 *                    needs target arbitration that `combat` has not published.
 *
 * ---------------------------------------------------------------------------
 * PATHING
 *
 * There is no navmesh — `world` publishes geometry, not navigation. Click-to-
 * move therefore uses CONTEXT STEERING: sweep the character capsule along the
 * straight line to the goal, and if it is blocked, fan out and take the
 * best-scoring clear direction. Scoring is `clearance × alignment`, so the hero
 * hugs a wall around a corner rather than grinding into it, and re-evaluates
 * every fixed step so a moving obstacle is handled for free.
 *
 * This is deliberately not A*. A dungeon room with a colonnade needs local
 * avoidance, which steering does well; long-range planning is a `world`
 * responsibility and does not exist yet. When it does, `setMoveTarget()` is the
 * only entry point that has to change.
 *
 * ---------------------------------------------------------------------------
 * ACCELERATION, AND WHY IT IS ASYMMETRIC
 *
 * `ACCEL` is 56 m/s² and `DECEL` is 70. Getting to full speed takes ~113 ms;
 * stopping takes ~90. A hero who accelerates as slowly as they decelerate feels
 * sluggish, and one who does both instantly feels weightless and makes the run
 * animation's foot-plant impossible to sell.
 *
 * `ACCEL_TURN` is the third number and the one that was missing. Straight-line
 * acceleration and CHANGING DIRECTION are different sensations and a single rate
 * cannot serve both: at 46 m/s² a 90° turn at top speed took 200 ms to come back
 * up to full speed in the new direction (measured), which reads as input lag even
 * though the input was sampled on the frame it arrived. Turning is therefore
 * accelerated at up to 150 m/s², interpolated by how far the wish is from the
 * current velocity, which brings a 90° turn to ~100 ms and a full reversal to
 * ~110 while leaving the from-standstill ramp exactly as authored.
 */

const D = Math.PI / 180;

/** Metres per second at rest, before stat scaling. */
export const BASE_SPEED = 6.15;
const ACCEL = 56;
const ACCEL_TURN = 150;
const DECEL = 70;
/** Radians/s. 22 is roughly a 90° turn in 70 ms — the shoulders still visibly
 *  swing round rather than teleporting, but the hero is aiming where the player
 *  asked within four frames. */
const TURN_RATE = 22.0;
const TURN_RATE_STANDING = 13.0;

/**
 * Dash.
 *
 * `moveTime` is SHORTER than the clip: the hero covers ground for 0.30 s and
 * then spends the remaining 0.20 s landing, with movement control already back.
 * Owning those last twelve frames bought nothing — the dash was travelling at
 * 1.8 m/s through them — and cost the player a fifth of a second of being unable
 * to do anything, which is exactly the stickiness this pass exists to remove.
 *
 * The i-frames now open on the FIRST simulated step rather than 45 ms in. There
 * used to be a wind-up to be vulnerable during; there no longer is one, and a
 * dodge that does not dodge for its first three frames is a dodge the player
 * cannot time.
 */
export const DASH = {
  cooldown: 0.85,
  iframeStart: 0,
  iframeEnd: 0.30,
  /** Seconds of travel. The clip runs to 0.50; movement stops here. */
  moveTime: 0.30,
  /** Metres. The clip's root-motion curve is normalised to this. */
  distance: 4.6,
  cost: 0,
};

/** Seconds a refused dash press stays live, waiting for the cooldown to end.
 *  Owned here so `player` and any future gamepad layer share one window. */
export const DASH_BUFFER = 0.22;

/** Distance at which a click-to-move goal counts as reached. Below ~0.2 the
 *  hero oscillates on the spot because one fixed step overshoots it. */
const ARRIVE = 0.26;

export class Locomotion {
  constructor(player) {
    this.player = player;

    this.speedMul = 1;
    this.moveEnabled = true;
    /**
     * 0..1 scale on the player's own movement intent, written every fixed step
     * by the player system.
     *
     * A boolean was not enough. Movement used to be all-or-nothing for the whole
     * length of an action clip — measured at 667 ms of being rooted for one
     * attack and 1167 ms for one cast — because the only thing the gate could
     * say was "no". A scalar lets the tail of an animation hand control back
     * gradually: the strike still commits the hero, the follow-through no longer
     * does.
     */
    this.moveAuthority = 1;

    /** World-space desired velocity, before acceleration. */
    this.wish = new THREE.Vector3();
    /** Facing yaw (radians) and its target. */
    this.yaw = 0;
    this.yawTarget = 0;
    /** Set by combat/skills to face a specific direction for a beat. */
    this.yawLock = 0;

    this.moveTarget = new THREE.Vector3();
    this.hasMoveTarget = false;

    /** Metres of authored root motion to consume on the next step, set by the
     *  player system from the animator. An attack's lunge goes through the
     *  character controller like any other movement, so it stops at a wall. */
    this.rootAdvance = 0;

    this.dashTime = 1e9;
    this.dashCooldown = 0;
    this.dashDir = new THREE.Vector3(0, 0, 1);
    this.dashing = false;
    this.invulnerable = false;
    /** The dash's authored distance curve, taken from the clip at start time.
     *  Sampled on OUR clock rather than read back from the animator: the
     *  animator advances in `update()`, after the fixed step that starts the
     *  dash, so reading `rootMotionOut` meant the first step of every dash moved
     *  the hero exactly zero metres. One frame of nothing at the front of a
     *  dodge is the most expensive frame in the game. */
    this._dashCurve = null;
    this._dashScale = 1;
    this._dashPrev = 0;

    /** Smoothed planar speed, what the animator blends on. */
    this.speed = 0;
    /** Acceleration in the character's own frame, for the animation lean. */
    this.localAccel = new THREE.Vector2();

    // ---- preallocated scratch ---------------------------------------------
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._prevVel = new THREE.Vector3();
    this._p0 = new THREE.Vector3();
    this._p1 = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._best = new THREE.Vector3();
    /** Fan offsets for context steering, in radians, nearest first. */
    this._fan = [0, 22 * D, -22 * D, 45 * D, -45 * D, 68 * D, -68 * D, 92 * D, -92 * D, 120 * D, -120 * D];
  }

  get maxSpeed() { return BASE_SPEED * this.speedMul; }

  // =========================================================================
  // input
  // =========================================================================

  /**
   * Read this frame's intent. Runs once per FIXED step, from the player system,
   * because everything it feeds is simulated at the fixed rate.
   */
  readInput(ctx) {
    const input = ctx.input;
    const a = input.moveAxis;

    if (a.lengthSq() > 1e-5) {
      // WASD wins and cancels any click-to-move goal: a player who grabs the
      // keyboard mid-path is correcting the path.
      this.hasMoveTarget = false;
      /**
       * Camera-relative. Screen right is +X−Z and screen up is −X−Z under the
       * fixed 45° yaw.
       *
       * The sign on the forward axis was wrong and W drove the hero DOWN-RIGHT,
       * directly away from the camera's "into the distance". Measured before
       * the fix, holding W from the spawn moved (+1.46, +1.46) — backwards —
       * and the short distance was the hero walking into the wall behind them.
       * A and D were always correct, which is what made it survive: the bug
       * reads as "the diagonals feel wrong" rather than as "W is inverted".
       *
       *   W  a=(0, 1) -> (−0.707, 0, −0.707)  screen up
       *   D  a=(1, 0) -> (+0.707, 0, −0.707)  screen right
       *   W+D          -> (0, 0, −1.414)      up-and-right, as it must be
       */
      const s = Math.sin(CAMERA.yaw), c = Math.cos(CAMERA.yaw);
      this.wish.set(a.x * c - a.y * s, 0, -a.x * s - a.y * c);
      const l = this.wish.length();
      if (l > 1) this.wish.multiplyScalar(1 / l);
      this.wish.multiplyScalar(this.maxSpeed);
      return;
    }

    // Held OR clicked: the target is only refreshed while the button is down,
    // and releasing leaves it standing, so a single click walks the hero to the
    // point and a held button drags them after the cursor. That is the
    // behaviour every ARPG player already has in their hands.
    if (input.mouse(2) && input.groundValid) this.setMoveTarget(input.ground);

    if (this.hasMoveTarget) {
      this._steerToTarget(ctx);
    } else {
      this.wish.set(0, 0, 0);
    }
  }

  setMoveTarget(p) {
    this.moveTarget.set(p.x, 0, p.z);
    this.hasMoveTarget = true;
  }

  clearMoveTarget() {
    this.hasMoveTarget = false;
    this.wish.set(0, 0, 0);
  }

  /**
   * Context steering toward `moveTarget`.
   *
   * The capsule sweep is done at the player's actual radius and only 1.5 m
   * ahead: further than that and the hero refuses to enter doorways they would
   * fit through, closer and they clip a pillar before reacting.
   */
  _steerToTarget(ctx) {
    const p = this.player.position;
    this._v.set(this.moveTarget.x - p.x, 0, this.moveTarget.z - p.z);
    const dist = this._v.length();
    if (dist < ARRIVE) {
      this.hasMoveTarget = false;
      this.wish.set(0, 0, 0);
      return;
    }
    this._v.multiplyScalar(1 / dist);

    const physics = ctx.peek('physics');
    let dirX = this._v.x, dirZ = this._v.z;

    if (physics) {
      const r = this.player.radius;
      const probe = Math.min(1.5, dist);
      this._p0.set(p.x, p.y + r + 0.02, p.z);
      this._p1.set(p.x, p.y + this.player.height - r, p.z);

      let bestScore = -1;
      let bestX = dirX, bestZ = dirZ;
      for (let i = 0; i < this._fan.length; i++) {
        const ang = this._fan[i];
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const dx = this._v.x * ca - this._v.z * sa;
        const dz = this._v.x * sa + this._v.z * ca;
        this._probe.set(dx, 0, dz);
        const hit = physics.sweepCapsule(this._p0, this._p1, r * 0.96, this._probe, probe);
        const clear = hit ? Math.max(0, hit.t) : probe;
        // Alignment is cubed so a slightly-worse-but-straighter option wins
        // easily; without it the hero wanders sideways down open corridors.
        const align = dx * this._v.x + dz * this._v.z;
        const score = (clear / probe) * Math.pow(Math.max(0.02, align), 3);
        if (score > bestScore) { bestScore = score; bestX = dx; bestZ = dz; }
        // A fully clear straight line is unbeatable — stop looking.
        if (i === 0 && !hit) break;
      }
      dirX = bestX; dirZ = bestZ;

      // Genuinely boxed in: give up on the goal rather than vibrate against a
      // wall forever. The player will click again.
      if (bestScore <= 0.001) {
        this.hasMoveTarget = false;
        this.wish.set(0, 0, 0);
        return;
      }
    }

    // Arrival ramp, so the hero eases into the goal instead of stopping dead.
    const ramp = Math.min(1, dist / 1.1);
    this.wish.set(dirX, 0, dirZ).multiplyScalar(this.maxSpeed * ramp);
  }

  // =========================================================================
  // dash
  // =========================================================================

  canDash() {
    return this.dashCooldown <= 0 && !this.dashing;
  }

  /**
   * Begin a dash. Direction priority: current movement intent, then the
   * cursor, then current facing — in that order because a player holding a
   * direction means it, and a player standing still is aiming with the mouse.
   *
   * MUST be called after `readInput` for the same step. Called before it, `wish`
   * still holds the PREVIOUS step's intent, so pressing a direction and dash on
   * the same frame from a standstill dashed at the cursor instead of at the key
   * the player was holding.
   *
   * @param {object} anim  the animator, for the dash clip's distance curve
   */
  startDash(ctx, anim) {
    if (!this.canDash()) return false;
    if (this.wish.lengthSq() > 0.04) {
      this.dashDir.copy(this.wish).setY(0).normalize();
    } else if (ctx.input.groundValid) {
      this._v.set(ctx.input.ground.x - this.player.position.x, 0, ctx.input.ground.z - this.player.position.z);
      if (this._v.lengthSq() > 0.04) this.dashDir.copy(this._v).normalize();
      else this.dashDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    } else {
      this.dashDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    }
    this.dashTime = 0;
    this.dashCooldown = DASH.cooldown;
    this.dashing = true;
    this.hasMoveTarget = false;

    const clip = anim?.clips?.dash ?? null;
    this._dashCurve = clip?.rootMotion ?? null;
    this._dashScale = clip?.rootDistance > 1e-6 ? DASH.distance / clip.rootDistance : 1;
    this._dashPrev = 0;

    this.yawTarget = Math.atan2(this.dashDir.x, this.dashDir.z);
    // Snap the facing: a dash that starts by pirouetting looks broken, and the
    // hero is already a quarter of a metre down-range on the first step, so
    // there is no time to turn smoothly even if we wanted to.
    this.yaw = this.yawTarget;
    return true;
  }

  // =========================================================================
  // simulation
  // =========================================================================

  /**
   * One fixed step of movement.
   *
   * @param {number} h        fixed step, seconds
   * @param {object} ctx
   * @param {object} anim     the animator, for root motion during a dash
   */
  step(h, ctx, anim) {
    const player = this.player;
    const vel = player.velocity;
    this._prevVel.copy(vel);

    this.dashCooldown = Math.max(0, this.dashCooldown - h);

    if (this.dashing) {
      this.dashTime += h;
      const phase = this.dashTime;
      this.invulnerable = phase >= DASH.iframeStart && phase <= DASH.iframeEnd;

      // The clip's authored distance curve says how far along the move is, and
      // that distance goes through the character controller so a dash into a
      // wall stops at the wall instead of tunnelling through it. Sampled at OUR
      // clock, which is one fixed step ahead of the animator's.
      const t = Math.min(phase, DASH.moveTime);
      const travelled = this._dashCurve
        ? this._dashCurve.sample(t) * this._dashScale
        : DASH.distance * (1 - Math.pow(1 - t / DASH.moveTime, 2.2));
      const advance = Math.max(0, travelled - this._dashPrev);
      this._dashPrev = travelled;
      const speed = h > 1e-6 ? advance / h : 0;
      vel.x = this.dashDir.x * speed;
      vel.z = this.dashDir.z * speed;

      if (this.dashTime >= DASH.moveTime) {
        this.dashing = false;
        this.invulnerable = false;
        // Hand over to normal movement with the dash's exit speed intact, so
        // dash-into-run is continuous instead of a full stop. The curve is shaped
        // to arrive at roughly running pace, so there is nothing to smooth over.
        const exit = Math.min(this.maxSpeed, speed);
        vel.x = this.dashDir.x * exit;
        vel.z = this.dashDir.z * exit;
      }
    } else {
      this.invulnerable = false;
      const auth = this.moveEnabled ? clamp(this.moveAuthority, 0, 1) : 0;
      const wx = this.wish.x * auth;
      const wz = this.wish.z * auth;
      const wanted = Math.hypot(wx, wz);

      const dx = wx - vel.x, dz = wz - vel.z;
      const dl = Math.hypot(dx, dz);
      if (dl > 1e-5) {
        // Turning is not accelerating. `turn` is 0 when the wish points along
        // the current velocity and 1 when it opposes it, scaled by how much
        // speed there actually is to redirect — from a standstill there is no
        // direction to change and the authored ramp is what the player feels.
        let rate = DECEL;
        if (wanted > 0.01) {
          const vl = Math.hypot(vel.x, vel.z);
          let turn = 0;
          if (vl > 0.35) {
            const align = (vel.x * wx + vel.z * wz) / (vl * wanted);
            turn = (1 - align) * 0.5 * Math.min(1, vl / Math.max(1e-3, this.maxSpeed));
          }
          rate = ACCEL + (ACCEL_TURN - ACCEL) * turn;
        }
        const step = Math.min(dl, rate * h);
        vel.x += (dx / dl) * step;
        vel.z += (dz / dl) * step;
      }
      if (wanted > 0.05) this.yawTarget = Math.atan2(wx, wz);

      // Authored root motion OVERRIDES the steering result rather than being
      // added to it. Added-after was the first version and it was wrong twice
      // over: the addition landed after `char.move` had already run, so a
      // lunge took effect a step late, and the deceleration term then ate most
      // of it on the way back. An attack's forward travel is authored in the
      // clip and nothing else should be arguing with it.
      //
      // It is now crossfaded by movement authority instead of switched, because
      // authority is no longer a boolean: while the hero is committed (auth 0)
      // the lunge is absolute, and by the time the tail has handed control back
      // (auth 1) the curve is flat and has nothing left to say anyway.
      if (this.rootAdvance > 1e-6) {
        const speed = this.rootAdvance / h;
        const k = 1 - auth;
        vel.x = Math.sin(this.yaw) * speed * k + vel.x * auth;
        vel.z = Math.cos(this.yaw) * speed * k + vel.z * auth;
      }
    }
    this.rootAdvance = 0;

    // ---- facing ------------------------------------------------------------
    const moving = this.speed > 0.4;
    const rate = (moving ? TURN_RATE : TURN_RATE_STANDING) * h;
    let dy = this.yawTarget - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += Math.abs(dy) < rate ? dy : Math.sign(dy) * rate;

    // ---- collision ---------------------------------------------------------
    // Vertical velocity belongs to the controller (gravity, step-down); writing
    // it here would cancel gravity and leave the hero hovering after a ledge.
    if (player.char) player.char.move(h);
    else {
      player.position.addScaledVector(vel, h);
      player.position.y = 0;
    }

    // ---- derived -----------------------------------------------------------
    const s = Math.hypot(vel.x, vel.z);
    this.speed += (s - this.speed) * Math.min(1, h * 22);

    // Acceleration in the hero's own frame, used for the animation lean. Taken
    // from the velocity the CONTROLLER produced, not the one requested, so
    // scraping along a wall leans into the wall.
    const ax = (vel.x - this._prevVel.x) / Math.max(1e-4, h);
    const az = (vel.z - this._prevVel.z) / Math.max(1e-4, h);
    const cy = Math.cos(-this.yaw), sy = Math.sin(-this.yaw);
    // Rotate world acceleration into the character's frame (yaw about +Y).
    const fx = ax * cy - az * sy;
    const fz = ax * sy + az * cy;
    // 0.22 °/(m/s²), clamped to 11°: a hard stop leans the torso about a
    // tenth of a turn, which reads at 89 px without looking like a stumble.
    this.localAccel.set(
      clamp(fx * 0.22, -11, 11),
      clamp(fz * 0.22, -11, 11)
    );
  }

  stats() {
    return {
      speed: +this.speed.toFixed(2),
      yaw: +(this.yaw * 180 / Math.PI).toFixed(1),
      authority: +this.moveAuthority.toFixed(2),
      dashing: this.dashing,
      iframes: this.invulnerable,
      cooldown: +this.dashCooldown.toFixed(2),
      target: this.hasMoveTarget
        ? [+this.moveTarget.x.toFixed(2), +this.moveTarget.z.toFixed(2)] : null,
    };
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
