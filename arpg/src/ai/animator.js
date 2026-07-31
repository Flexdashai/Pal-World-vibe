import * as THREE from 'three';
import { ANIM, clamp, clamp01, lerp } from './tuning.js';

/**
 * MONARCH — the per-actor animator.
 *
 * One of these per living enemy, so it has to be small and allocate nothing.
 * The whole pose is three Float32Arrays of euler angles and a handful of
 * scalars; there is no AnimationMixer, no Track objects and no per-frame
 * Quaternion garbage.
 *
 * ---------------------------------------------------------------------------
 * THE LAYER STACK, BOTTOM TO TOP
 *
 *   1. LOCOMOTION   idle / walk / run, cross-faded by speed. Always evaluated.
 *   2. ACTION       one clip at a time (attack, block, stagger, death, cast…),
 *                   faded in and out, and it OVERRIDES locomotion only on the
 *                   bones it actually addresses. That is what lets a caster
 *                   walk backwards while channelling with its arms.
 *   3. ADDITIVE     the flinch, added on top of everything and decayed. A hit
 *                   reaction has to survive being played during a wind-up, and
 *                   an override layer cannot do that without cancelling the
 *                   wind-up — which would make every enemy uninterruptible-
 *                   looking or unattackable-looking depending on which won.
 *   4. PROCEDURAL   breath, head tracking, spine lean from acceleration. Never
 *                   authored, always on, and the reason an idle enemy is not a
 *                   statue.
 *   5. SECONDARY    spring chains on rags, tails, capes and hanging chains.
 *                   ARCHITECTURE.md calls this the strongest "animated by a
 *                   professional" signal at this distance, and it is: two
 *                   pixels of lag on a hem is worth more than a hundred
 *                   triangles anywhere else.
 *
 * ---------------------------------------------------------------------------
 * LOD
 *
 * `stride` skips whole pose evaluations for distant actors. Because bones keep
 * their last matrices, a skipped frame is a held pose and costs nothing — no
 * interpolation, no branch inside the sampler. At band 2 (>27 m, ~40 px tall) a
 * quarter-rate pose is genuinely invisible, and it is a 4× saving on the single
 * most expensive per-actor cost in the subsystem.
 */

const _euler = new THREE.Euler(0, 0, 0, 'XYZ');
const _q = new THREE.Quaternion();

export class Animator {
  /**
   * @param {import('./rig.js').RigDef} rig
   * @param {object} clips  compiled clip table from `clips.js`
   */
  constructor(rig, clips) {
    this.rig = rig;
    this.clips = clips;
    const n = rig.count;

    /** The composed pose, euler XYZ in radians, one triple per bone. */
    this.pose = new Float32Array(n * 3);
    /** Scratch for the locomotion blend and the action layer. */
    this._a = new Float32Array(n * 3);
    this._b = new Float32Array(n * 3);
    /** Additive flinch, decayed every frame. */
    this._add = new Float32Array(n * 3);
    /** Which bones the action layer wrote this frame, so it can override
     *  locomotion selectively without a second full-pose blend. */
    this._mask = new Uint8Array(n);

    // ---- locomotion ---------------------------------------------------------
    this.speed = 0;              // metres/second, set by the actor
    this.runSpeed = 4.0;         // the archetype's top speed
    this.strideTime = 0;         // 0..1 cycle position
    this.stridePhase = 0;        // per-actor offset so a pack is not in unison
    this.strideRate = 1;

    // ---- action -------------------------------------------------------------
    this.action = null;          // compiled clip
    this.actionName = '';
    this.actionTime = 0;         // 0..1 normalised
    this.actionRate = 1;         // 1 / duration
    this.actionWeight = 0;
    this.actionFade = ANIM.fadeAction;
    this.actionDone = true;
    this.actionLoop = false;
    this._eventCursor = 0;
    /** Called with (eventName) — the actor turns these into damage windows,
     *  audio cues, footstep dust and camera shake. */
    this.onEvent = null;

    // ---- procedural ---------------------------------------------------------
    this.breathPhase = 0;
    this.lookYaw = 0;            // degrees, damped toward the target
    this.lookPitch = 0;
    this.lookTargetYaw = 0;
    this.lookTargetPitch = 0;
    this.lean = 0;               // forward lean from acceleration, radians
    this.leanSide = 0;
    this.alert = 0;              // 0..1, raises the head and squares the chest

    // ---- secondary ----------------------------------------------------------
    const dyn = rig.dynamic.length;
    this._sx = new Float32Array(dyn);   // spring position
    this._sz = new Float32Array(dyn);
    this._vx = new Float32Array(dyn);   // spring velocity
    this._vz = new Float32Array(dyn);
    /** Impulse in ACTOR-LOCAL space, set by the actor on a hit or a landing. */
    this.impulseX = 0;
    this.impulseZ = 0;
    this.wind = 0;

    // ---- LOD ----------------------------------------------------------------
    this.stride = 1;
    this._strideCounter = 0;
    this.frozen = false;

    this.reset();
  }

  reset() {
    this.pose.fill(0);
    this._add.fill(0);
    this._sx.fill(0); this._sz.fill(0);
    this._vx.fill(0); this._vz.fill(0);
    this.action = null;
    this.actionName = '';
    this.actionWeight = 0;
    this.actionDone = true;
    this.speed = 0;
    this.strideTime = 0;
    this.lookYaw = 0; this.lookPitch = 0;
    this.lean = 0; this.leanSide = 0;
    this.impulseX = 0; this.impulseZ = 0;
    this.alert = 0;
    return this;
  }

  /* ==================================================================== */
  /* actions                                                              */
  /* ==================================================================== */

  /**
   * Play a clip on the action layer.
   * @param name      key into the compiled clip table
   * @param duration  real seconds the clip should take; the normalised clip is
   *                  played at 1/duration
   * @param opts      { fade, restart, loop }
   */
  play(name, duration = 1, opts = {}) {
    const clip = this.clips[name];
    if (!clip) return false;
    if (this.action === clip && !opts.restart && !this.actionDone) return true;
    this.action = clip;
    this.actionName = name;
    this.actionTime = 0;
    this.actionRate = 1 / Math.max(0.05, duration);
    this.actionFade = opts.fade ?? ANIM.fadeAction;
    this.actionLoop = opts.loop ?? clip.loop;
    this.actionDone = false;
    this._eventCursor = 0;
    return true;
  }

  /** Release the action layer back to locomotion over `fade` seconds. */
  stop(fade = ANIM.fadeOut) {
    if (!this.action) return;
    this.actionDone = true;
    this.actionFade = fade;
  }

  /** Where in its timeline the current action is, 0..1. Brains read this to
   *  decide when a damage window opens rather than keeping a second clock. */
  get phase() { return this.action ? this.actionTime : 0; }
  get active() { return !!this.action && !this.actionDone; }

  /** An additive jolt, in the direction the blow came from (actor-local). */
  flinch(amount = 1, dirX = 0, dirZ = -1) {
    const k = clamp(amount, 0, 1.6);
    const rig = this.rig;
    const bones = ['spine', 'chest', 'neck', 'head', 'spineA', 'spineB'];
    const w = [0.55, 0.85, 0.7, 1.0, 0.6, 0.8];
    for (let i = 0; i < bones.length; i++) {
      if (!rig.has(bones[i])) continue;
      const b = rig.id(bones[i]) * 3;
      this._add[b] += -dirZ * k * w[i] * 0.32;
      this._add[b + 2] += -dirX * k * w[i] * 0.26;
    }
    this.impulseX += dirX * k * 5.5;
    this.impulseZ += dirZ * k * 5.5;
  }

  /* ==================================================================== */
  /* the frame                                                            */
  /* ==================================================================== */

  /**
   * Advance and compose the pose.
   * @returns true if the pose changed (false when LOD skipped this frame)
   */
  update(dt) {
    if (this.frozen) return false;

    // Timers always advance, even on a skipped frame: an action whose damage
    // window is read from `phase` must not run at a quarter speed just because
    // the actor is far away.
    this._advance(dt);

    if (this.stride > 1) {
      if (++this._strideCounter < this.stride) return false;
      this._strideCounter = 0;
    }
    this._compose();
    return true;
  }

  _advance(dt) {
    // ---- locomotion cycle ---------------------------------------------------
    // Stride frequency scales with speed so the feet do not skate. The exponent
    // is deliberately below 1: real gait frequency grows slower than speed, and
    // a linear mapping makes a sprint look like a cartoon.
    const s = Math.abs(this.speed);
    const rate = ANIM.strideBase * Math.pow(Math.max(0.15, s) / ANIM.strideSpeed, 0.72);
    this.strideRate = rate;
    this.strideTime = (this.strideTime + dt * rate) % 1;
    this.breathPhase = (this.breathPhase + dt * ANIM.breathRate) % 1;

    // ---- action -------------------------------------------------------------
    if (this.action) {
      const prev = this.actionTime;
      this.actionTime += dt * this.actionRate * this.action.speed;
      if (this.action.events && this.onEvent) this._fireEvents(prev, this.actionTime);
      if (this.actionTime >= 1) {
        if (this.actionLoop) {
          this.actionTime %= 1;
          this._eventCursor = 0;
        } else {
          this.actionTime = 1;
          this.actionDone = true;
        }
      }
      const target = this.actionDone ? 0 : 1;
      const k = Math.min(1, dt / Math.max(0.016, this.actionFade));
      this.actionWeight += (target - this.actionWeight) * k;
      if (this.actionDone && this.actionWeight < 0.01) {
        this.action = null;
        this.actionName = '';
        this.actionWeight = 0;
      }
    }

    // ---- additive decay -----------------------------------------------------
    const decay = Math.exp(-ANIM.flinchDecay * dt);
    for (let i = 0; i < this._add.length; i++) this._add[i] *= decay;

    // ---- look ---------------------------------------------------------------
    this.lookYaw = lerp(this.lookYaw, this.lookTargetYaw, Math.min(1, dt * 7));
    this.lookPitch = lerp(this.lookPitch, this.lookTargetPitch, Math.min(1, dt * 6));
  }

  _fireEvents(prev, now) {
    const ev = this.action.events;
    // Looping clips wrap; fire everything remaining, then restart the cursor.
    const wrapped = now < prev;
    while (this._eventCursor < ev.length) {
      const e = ev[this._eventCursor];
      if (e[0] > now && !wrapped) break;
      if (e[0] > prev || wrapped) this.onEvent(e[1], this);
      this._eventCursor++;
    }
  }

  /* ==================================================================== */
  /* pose composition                                                     */
  /* ==================================================================== */

  _compose() {
    const pose = this.pose;
    pose.fill(0);

    // ---- 1. locomotion ------------------------------------------------------
    const s = Math.abs(this.speed);
    const runT = clamp01((s / Math.max(0.5, this.runSpeed) - ANIM.runBlendStart) /
      (ANIM.runBlendEnd - ANIM.runBlendStart));
    const moveT = clamp01(s / Math.max(0.2, this.runSpeed * 0.35));
    const t = (this.strideTime + this.stridePhase) % 1;

    this._sample(this.clips.idle, (this.breathPhase + this.stridePhase) % 1, this._a);
    if (moveT > 0.001) {
      this._sample(this.clips.walk, t, this._b);
      blend(this._a, this._b, moveT * (1 - runT), pose.length);
      if (runT > 0.001) {
        this._sample(this.clips.run, t, this._b);
        blend(this._a, this._b, moveT * runT, pose.length);
      }
    }
    pose.set(this._a);

    // ---- 2. action, masked --------------------------------------------------
    if (this.action && this.actionWeight > 0.001) {
      this._mask.fill(0);
      this._sample(this.action, this.actionTime, this._b, this._mask);
      const w = this.actionWeight;
      const bones = this.action.bones;
      for (let i = 0; i < bones.length; i++) {
        const b = bones[i] * 3;
        pose[b] = lerp(pose[b], this._b[b], w);
        pose[b + 1] = lerp(pose[b + 1], this._b[b + 1], w);
        pose[b + 2] = lerp(pose[b + 2], this._b[b + 2], w);
      }
    }

    // ---- 3. additive --------------------------------------------------------
    for (let i = 0; i < pose.length; i++) pose[i] += this._add[i];

    // ---- 4. procedural ------------------------------------------------------
    this._procedural(pose);
  }

  /**
   * Sample a compiled clip into `out` at normalised time `t`.
   *
   * Interpolation is smoothstepped rather than linear. Linear interpolation
   * between sparse hand-authored keys produces visible velocity discontinuities
   * at every key — the classic "robot" read — and a real spline would need
   * tangents nobody is going to author by hand. Smoothstep costs two multiplies
   * and removes the corner.
   */
  _sample(clip, t, out, mask) {
    if (!clip) { out.fill(0); return; }
    out.fill(0);
    const bones = clip.bones;
    for (let i = 0; i < bones.length; i++) {
      const times = clip.times[i];
      const vals = clip.values[i];
      const n = times.length;
      let k = 0;
      // Linear scan: authored tracks have 3-6 keys, so a binary search would be
      // slower than the scan and would allocate a comparison closure.
      while (k < n - 1 && times[k + 1] < t) k++;
      const k1 = Math.min(n - 1, k + 1);
      const t0 = times[k], t1 = times[k1];
      let f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      f = f * f * (3 - 2 * f);
      const a = k * 3, b = k1 * 3;
      const o = bones[i] * 3;
      out[o] = vals[a] + (vals[b] - vals[a]) * f;
      out[o + 1] = vals[a + 1] + (vals[b + 1] - vals[a + 1]) * f;
      out[o + 2] = vals[a + 2] + (vals[b + 2] - vals[a + 2]) * f;
      if (mask) mask[bones[i]] = 1;
    }
  }

  /**
   * Breath, head tracking and body lean.
   *
   * All three are small — a couple of degrees — and all three are the reason a
   * horde standing still does not read as a row of props. The lean in
   * particular does a disproportionate amount of work: an enemy that tips into
   * its turns is legible as *steering* from directly above, where its actual
   * heading change is almost invisible.
   */
  _procedural(pose) {
    const rig = this.rig;
    const k = rig.key;
    const D = Math.PI / 180;

    const breath = Math.sin((this.breathPhase + this.stridePhase) * Math.PI * 2) * ANIM.breathAmount * D;
    if (k.chest !== undefined) {
      pose[k.chest * 3] += breath * 0.5 + this.lean * 0.45 + this.alert * -0.06;
      pose[k.chest * 3 + 2] += this.leanSide * 0.45;
    }
    if (k.spine !== undefined) {
      pose[k.spine * 3] += breath * 0.3 + this.lean * 0.35;
      pose[k.spine * 3 + 2] += this.leanSide * 0.35;
    }
    if (k.spineA !== undefined) {
      pose[k.spineA * 3] += breath * 0.4 + this.lean * 0.5;
      pose[k.spineA * 3 + 2] += this.leanSide * 0.5;
    }
    if (k.spineB !== undefined) {
      pose[k.spineB * 3] += breath * 0.3 + this.lean * 0.35;
      pose[k.spineB * 3 + 2] += this.leanSide * 0.35;
    }
    if (k.pelvis !== undefined) {
      pose[k.pelvis * 3] += this.lean * -0.22;
      pose[k.pelvis * 3 + 2] += this.leanSide * -0.2;
    }
    // Head tracking, split between neck and head so the neck does not snap.
    if (k.neck !== undefined) {
      pose[k.neck * 3] += this.lookPitch * D * 0.4 - this.lean * 0.6 - this.alert * 0.10;
      pose[k.neck * 3 + 1] += this.lookYaw * D * 0.38;
    }
    if (k.head !== undefined) {
      pose[k.head * 3] += this.lookPitch * D * 0.6 - this.lean * 0.4 - this.alert * 0.06;
      pose[k.head * 3 + 1] += this.lookYaw * D * 0.62;
    }
  }

  /* ==================================================================== */
  /* application                                                          */
  /* ==================================================================== */

  /**
   * Write the pose into a live bone array and solve the secondary chains.
   *
   * `dt` is used only by the springs. `localAccel` is the actor's acceleration
   * expressed in its own frame — that is what makes a cape trail behind a turn
   * instead of behind a world axis.
   */
  apply(bones, dt, localAccelX = 0, localAccelZ = 0) {
    const pose = this.pose;
    const n = this.rig.count;
    for (let i = 0; i < n; i++) {
      const b = i * 3;
      _euler.set(pose[b], pose[b + 1], pose[b + 2], 'XYZ');
      bones[i].quaternion.setFromEuler(_euler);
      bones[i].updateMatrix();
    }
    if (dt > 0) this._secondary(bones, dt, localAccelX, localAccelZ);
  }

  /**
   * Spring chains.
   *
   * Solved in the ACTOR's local frame rather than in world space, which is a
   * large simplification: a cloth panel hanging from a bone only ever needs two
   * degrees of freedom at this distance (swing fore-aft and side-to-side), and
   * two critically-damped scalars per bone is a hundredth of the cost of a
   * verlet chain with constraint projection — with, at 120 px, an identical
   * read.
   *
   * The chain LAGS: each link is driven by a fraction of its parent's swing
   * plus its own inertia, so the hem trails the shoulder rather than the whole
   * panel swinging as one rigid board. That lag is the entire effect.
   */
  _secondary(bones, dt, ax, az) {
    const dyn = this.rig.dynamic;
    if (dyn.length === 0) return;
    const pose = this.pose;
    const h = Math.min(dt, 1 / 30);

    // Drive: acceleration opposes the cloth, plus any impulse the actor injected
    // (a hit, a landing, an explosion), plus a slow wind sway so nothing ever
    // comes fully to rest.
    const wind = this.wind * Math.sin(this.breathPhase * Math.PI * 2 * 0.7);
    const driveX = -ax * 0.055 - this.impulseX * 0.05 + wind * 0.4;
    const driveZ = -az * 0.055 - this.impulseZ * 0.05;

    let idx = 0;
    let lastChainRoot = -1;
    let parentX = 0, parentZ = 0;
    for (let i = 0; i < dyn.length; i++) {
      const d = dyn[i];
      // A chain root is a dynamic bone whose parent is not itself dynamic.
      const isRoot = d.parent !== lastChainRoot;
      lastChainRoot = d.i;
      if (isRoot) { parentX = 0; parentZ = 0; }

      // Critically damped spring toward the drive, with the parent's swing
      // handed down at 62% — the lag.
      const targetX = driveZ + parentX * 0.62;
      const targetZ = driveX + parentZ * 0.62;
      const stiff = d.stiff;
      const damp = ANIM.springDamp * Math.sqrt(Math.max(1, stiff) / 24);
      this._vx[idx] += (targetX - this._sx[idx]) * stiff * h - this._vx[idx] * damp * h;
      this._vz[idx] += (targetZ - this._sz[idx]) * stiff * h - this._vz[idx] * damp * h;
      this._sx[idx] += this._vx[idx] * h;
      this._sz[idx] += this._vz[idx] * h;
      const sx = clamp(this._sx[idx], -0.9, 0.9);
      const sz = clamp(this._sz[idx], -0.9, 0.9);

      const b = d.i * 3;
      _euler.set(pose[b] + sx, pose[b + 1], pose[b + 2] - sz, 'XYZ');
      bones[d.i].quaternion.setFromEuler(_euler);
      bones[d.i].updateMatrix();

      parentX = sx; parentZ = sz;
      idx++;
    }

    // Impulses are one-shot: they are consumed by the frame that applies them.
    this.impulseX *= Math.exp(-9 * h);
    this.impulseZ *= Math.exp(-9 * h);
  }

  /**
   * Snap the springs to rest and pose once. The capture harness pumps 14-16
   * frames before the shutter and the slowest chain needs ~0.5 s of simulated
   * time to settle, so a posed shot converges the solver explicitly instead of
   * photographing cloth mid-swing.
   */
  settle(bones, iterations = 40) {
    this.impulseX = 0;
    this.impulseZ = 0;
    for (let i = 0; i < iterations; i++) this._secondary(bones, 1 / 120, 0, 0);
  }

  stats() {
    return {
      action: this.actionName || 'none',
      phase: +this.actionTime.toFixed(2),
      weight: +this.actionWeight.toFixed(2),
      speed: +this.speed.toFixed(2),
      stride: this.stride,
      chains: this.rig.dynamic.length,
    };
  }
}

/** `a += (b - a) * w`, over a flat euler array. */
function blend(a, b, w, n) {
  for (let i = 0; i < n; i++) a[i] += (b[i] - a[i]) * w;
}

export { _q as ANIM_SCRATCH_Q };
