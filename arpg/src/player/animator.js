import * as THREE from 'three';
import { CLIP_DEFS, POSE_FREEZE } from './clips.js';

/**
 * MONARCH — the hero's animation runtime.
 *
 * A three-layer evaluator with a locomotion blend tree, an action layer with
 * cross-fades and per-bone masking, and additive layers on top.
 *
 *      LOCOMOTION   idle ↔ walk ↔ run, blended by speed, driven by a SHARED
 *                   normalised phase so footfalls stay aligned across the blend
 *           ↓
 *      ACTION       attack / cast / dash / arise / death — a full-body override
 *                   that fades in and out; may be masked to the upper body
 *           ↓
 *      ADDITIVE     hurt flinch (a clip), plus procedural lean and look-at
 *
 * ---------------------------------------------------------------------------
 * THE PHASE DECISION
 *
 * The obvious way to blend walk and run is to give each its own clock scaled by
 * speed. It is also wrong: the two clocks drift apart, and in the middle of the
 * blend the character plants a walk foot and a run foot at different instants,
 * so the legs scissor. Instead there is ONE cycle phase, advanced by a cadence
 * derived from speed and the blended stride length, and both clips are sampled
 * at it. Footfalls then coincide by construction at every blend weight.
 *
 * ---------------------------------------------------------------------------
 * NO PER-FRAME ALLOCATION
 *
 * Poses are flat Float32Arrays (quaternion xyzw + local position xyz per bone),
 * and every quaternion operation here works on array slices. That is not
 * premature: a pose is 46 bones, there are five live poses, and the naive
 * version allocates ~700 THREE.Quaternion objects a frame.
 */

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// raw quaternion maths on Float32Array slices
// ---------------------------------------------------------------------------

/** XYZ-order euler (radians) → quaternion, written at `out[o..o+3]`. */
function quatFromEuler(out, o, x, y, z) {
  const c1 = Math.cos(x * 0.5), c2 = Math.cos(y * 0.5), c3 = Math.cos(z * 0.5);
  const s1 = Math.sin(x * 0.5), s2 = Math.sin(y * 0.5), s3 = Math.sin(z * 0.5);
  out[o] = s1 * c2 * c3 + c1 * s2 * s3;
  out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

/** Shortest-arc slerp between two array slices. */
function slerp(out, o, a, ai, b, bi, t) {
  let ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; ax = -ax; ay = -ay; az = -az; aw = -aw; }
  // Below ~0.9995 the arc is short enough that nlerp is visually identical and
  // ~4x cheaper; above it, acos loses precision anyway.
  if (cos > 0.9995) {
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
    const z = az + (bz - az) * t, w = aw + (bw - aw) * t;
    const l = 1 / (Math.hypot(x, y, z, w) || 1);
    out[o] = x * l; out[o + 1] = y * l; out[o + 2] = z * l; out[o + 3] = w * l;
    return;
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  out[o] = ax * wa + bx * wb;
  out[o + 1] = ay * wa + by * wb;
  out[o + 2] = az * wa + bz * wb;
  out[o + 3] = aw * wa + bw * wb;
}

/** out = a * b (Hamilton product), all array slices. */
function quatMul(out, o, a, ai, b, bi) {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

const IDENT = new Float32Array([0, 0, 0, 1]);

// ---------------------------------------------------------------------------
// tracks
// ---------------------------------------------------------------------------

/**
 * A 3-channel keyframed curve with Catmull-Rom interpolation.
 *
 * A monotonic cursor is cached because clips are almost always sampled forward
 * in time; the binary search fallback only runs on a seek (debug poses, a clip
 * restart, a loop wrap).
 */
class Track {
  constructor(keys) {
    const n = keys.length;
    this.n = n;
    this.times = new Float32Array(n);
    this.vals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.times[i] = keys[i][0];
      this.vals[i * 3] = keys[i][1];
      this.vals[i * 3 + 1] = keys[i][2];
      this.vals[i * 3 + 2] = keys[i][3];
    }
    this._cursor = 0;
  }

  _find(t) {
    const times = this.times, n = this.n;
    let i = this._cursor;
    if (i >= n - 1 || times[i] > t) i = 0;
    while (i < n - 2 && times[i + 1] <= t) i++;
    this._cursor = i;
    return i;
  }

  /** Sample into `out[o], out[o+1], out[o+2]`. */
  sample(t, out, o) {
    const n = this.n, times = this.times, v = this.vals;
    if (n === 1 || t <= times[0]) {
      out[o] = v[0]; out[o + 1] = v[1]; out[o + 2] = v[2];
      return;
    }
    if (t >= times[n - 1]) {
      const k = (n - 1) * 3;
      out[o] = v[k]; out[o + 1] = v[k + 1]; out[o + 2] = v[k + 2];
      return;
    }
    const i = this._find(t);
    const t0 = times[i], t1 = times[i + 1];
    const f = (t - t0) / Math.max(1e-6, t1 - t0);
    const i0 = Math.max(0, i - 1) * 3, i1 = i * 3, i2 = (i + 1) * 3, i3 = Math.min(n - 1, i + 2) * 3;
    const f2 = f * f, f3 = f2 * f;
    for (let c = 0; c < 3; c++) {
      const p0 = v[i0 + c], p1 = v[i1 + c], p2 = v[i2 + c], p3 = v[i3 + c];
      out[o + c] = 0.5 * ((2 * p1) + (-p0 + p2) * f +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
    }
  }
}

/** A 1-channel curve, used only for root-motion distance. */
class ScalarTrack {
  constructor(keys) {
    this.times = new Float32Array(keys.map((k) => k[0]));
    this.vals = new Float32Array(keys.map((k) => k[1]));
    this.n = keys.length;
  }

  sample(t) {
    const { times, vals, n } = this;
    if (t <= times[0]) return vals[0];
    if (t >= times[n - 1]) return vals[n - 1];
    let i = 0;
    while (i < n - 2 && times[i + 1] <= t) i++;
    const f = (t - times[i]) / Math.max(1e-6, times[i + 1] - times[i]);
    return vals[i] + (vals[i + 1] - vals[i]) * f;
  }
}

/** A compiled clip: tracks resolved to bone indices once, at load. */
class Clip {
  constructor(def, rig) {
    this.name = def.name;
    this.duration = def.duration;
    this.loop = !!def.loop;
    this.hold = !!def.hold;
    this.additive = !!def.additive;
    this.billow = def.billow ?? 0;
    this.billowDir = def.billowDir ?? 'back';
    this.events = (def.events ?? []).slice().sort((a, b) => a.t - b.t);
    this.rootMotion = def.rootMotion ? new ScalarTrack(def.rootMotion) : null;
    this.rootDistance = def.rootMotion ? def.rootMotion[def.rootMotion.length - 1][1] : 0;

    this.rotBones = [];
    this.rotTracks = [];
    this.posBones = [];
    this.posTracks = [];
    for (const [boneName, track] of Object.entries(def.tracks)) {
      const bi = rig.index.get(boneName);
      if (bi === undefined) throw new Error(`[player.clips] "${def.name}" targets unknown bone "${boneName}"`);
      if (track.r) { this.rotBones.push(bi); this.rotTracks.push(new Track(track.r)); }
      if (track.p) { this.posBones.push(bi); this.posTracks.push(new Track(track.p)); }
    }
  }
}

// ---------------------------------------------------------------------------
// pose
// ---------------------------------------------------------------------------

class Pose {
  constructor(n) {
    this.n = n;
    this.rot = new Float32Array(n * 4);
    this.pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) this.rot[i * 4 + 3] = 1;
  }
}

// ---------------------------------------------------------------------------
// animator
// ---------------------------------------------------------------------------

export class Animator {
  /** @param {import('./rig.js').Rig} rig */
  constructor(rig) {
    this.rig = rig;
    const n = rig.count;

    this.clips = {};
    for (const def of Object.values(CLIP_DEFS)) this.clips[def.name] = new Clip(def, rig);

    // ---- poses -------------------------------------------------------------
    this._loco = new Pose(n);
    this._tmpA = new Pose(n);
    this._tmpB = new Pose(n);
    this._action = new Pose(n);
    this._add = new Pose(n);
    this.pose = new Pose(n);

    /** Bind local positions, the reset target for every pose. */
    this._bindPos = new Float32Array(rig.bindLocalPos);

    /** Scratch for one track's sampled euler triple. */
    this._e = new Float32Array(3);
    this._q = new Float32Array(4);
    this._q2 = new Float32Array(4);

    // ---- masks -------------------------------------------------------------
    // Upper body: everything from spine01 up, the pelvis at 40%, legs at 0.
    // Used so a flinch or an upper-body cast can ride a run without stopping it.
    this.maskUpper = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const name = rig.names[i];
      if (name === 'pelvis' || name === 'root') this.maskUpper[i] = 0.35;
      else if (name.startsWith('thigh') || name.startsWith('shin') ||
        name.startsWith('foot') || name.startsWith('toe')) this.maskUpper[i] = 0;
      else this.maskUpper[i] = 1;
    }

    // ---- locomotion state --------------------------------------------------
    this.speed = 0;
    this.phase = 0;
    this.idleTime = 0;
    this.runWeight = 0;
    this.moveWeight = 0;

    // ---- action state ------------------------------------------------------
    this.action = null;
    this.actionTime = 0;
    this.actionWeight = 0;
    this.actionTarget = 0;
    this.actionFade = 0.1;
    this.actionSpeed = 1;
    this.actionMask = null;
    this._eventCursor = 0;
    this._rootPrev = 0;
    this.rootMotionOut = 0;

    // ---- additive ----------------------------------------------------------
    this.hurtTime = 1e9;
    this.hurtWeight = 0;

    /** Procedural additive inputs, written by the player system each frame. */
    this.lean = new THREE.Vector2(0, 0);     // x = sideways, y = forward
    this.lookYaw = 0;
    this.lookPitch = 0;

    /** Cloth drive, read by secondary.js. */
    this.billow = 0;
    this.billowDir = 'back';

    /** Set true by debugPose(): the clock stops and the pose is held exactly. */
    this.frozen = false;

    this.onEvent = null;
    this._locoEventPhase = 0;
  }

  // =======================================================================
  // public
  // =======================================================================

  /**
   * Start an action-layer clip.
   * @param {string} name
   * @param {object} o
   *   fade    seconds to blend in (0.06-0.14 is the useful range; longer and
   *           an attack loses its snap, shorter and it pops)
   *   speed   playback multiplier
   *   mask    'upper' to leave the legs on locomotion
   *   restart force a restart even if the same clip is already playing
   */
  play(name, o = {}) {
    const clip = this.clips[name];
    if (!clip) return false;
    if (this.action === clip && !o.restart && !clip.loop) {
      // Re-triggering the same clip mid-play restarts it — that is what a
      // combo re-press should do — but only when explicitly asked, so a held
      // key does not stutter the animation into a single frame of itself.
      return false;
    }
    this.action = clip;
    this.actionTime = 0;
    this.actionSpeed = o.speed ?? 1;
    this.actionFade = o.fade ?? 0.09;
    this.actionTarget = 1;
    this.actionMask = o.mask === 'upper' ? this.maskUpper : null;
    this._eventCursor = 0;
    this._rootPrev = 0;
    this.rootMotionOut = 0;
    this.frozen = false;
    return true;
  }

  /** Release a held action (arise, ultimate) back to locomotion. */
  stopAction(fade = 0.22) {
    if (!this.action) return;
    this.actionTarget = 0;
    this.actionFade = fade;
  }

  /** True while an action clip owns the body (used to gate movement input). */
  get actionActive() {
    return !!this.action && this.actionWeight > 0.02;
  }

  /** Normalised progress through the current action clip, 0..1. */
  get actionPhase() {
    return this.action ? Math.min(1, this.actionTime / this.action.duration) : 1;
  }

  /** Trigger the additive hurt flinch. Does not interrupt anything. */
  flinch() {
    this.hurtTime = 0;
    this.hurtWeight = 1;
  }

  /**
   * Freeze on a named pose. Used by the shot harness.
   *
   * Frozen rather than left running because the capture pumps 14-16 settle
   * frames with TAA on: a moving character accumulates history from poses it is
   * no longer in and the whole figure ghosts. It also makes every capture of the
   * same shot pixel-identical, which is the point of the harness.
   */
  freezePose(name) {
    const clip = this.clips[name];
    if (!clip) return false;
    const t = POSE_FREEZE[name] ?? clip.duration * 0.5;
    if (name === 'idle' || name === 'walk' || name === 'run') {
      // Locomotion poses live on the loco layer, not the action layer, so that
      // the blend weights (and therefore the coat's billow) are consistent with
      // what actually running would produce.
      this.action = null;
      this.actionWeight = 0;
      this.actionTarget = 0;
      this.speed = name === 'run' ? 6.2 : name === 'walk' ? 1.7 : 0;
      this._updateLocoWeights(0);
      this.phase = t / clip.duration;
      this.idleTime = t;
    } else {
      this.action = clip;
      this.actionTime = t;
      this.actionWeight = 1;
      this.actionTarget = 1;
      this.actionMask = null;
      this.actionSpeed = 0;
      this._eventCursor = clip.events.length;
      this.speed = 0;
      this._updateLocoWeights(0);
    }
    this.hurtWeight = 0;
    this.frozen = true;
    this.lean.set(0, 0);
    this.lookYaw = 0;
    this.lookPitch = 0;
    this._evaluate(0);
    return true;
  }

  // =======================================================================
  // frame
  // =======================================================================

  update(dt) {
    if (this.frozen) {
      // Still evaluate: the pose has to exist, and the cloth solver needs the
      // billow target. Nothing advances.
      this._evaluate(0);
      return;
    }
    this._advance(dt);
    this._evaluate(dt);
  }

  _advance(dt) {
    // ---- locomotion clock --------------------------------------------------
    this._updateLocoWeights(dt);
    this.idleTime += dt;

    // Cadence from speed and the BLENDED stride length. Below the walk
    // threshold the cycle keeps ticking at a floor rate so a hero shuffling
    // half a metre still takes a visible step instead of sliding.
    const stride = 1.02 + (1.88 - 1.02) * this.runWeight;
    const cadence = Math.max(0.55, this.speed / stride);
    const prevPhase = this.phase;
    this.phase = (this.phase + cadence * dt) % 1;
    this._fireLocoEvents(prevPhase, this.phase);

    // ---- action clock ------------------------------------------------------
    if (this.action) {
      const prev = this.actionTime;
      this.actionTime += dt * this.actionSpeed;
      this._fireActionEvents(prev, this.actionTime);

      const end = this.action.duration;
      if (this.actionTime >= end) {
        if (this.action.loop) this.actionTime %= end;
        else if (!this.action.hold) this.actionTarget = 0;
        else this.actionTime = end;
      }

      // Root motion: report the DELTA travelled this step, so movement code can
      // apply it through the character controller and get collision for free.
      if (this.action.rootMotion) {
        const d = this.action.rootMotion.sample(Math.min(this.actionTime, end));
        this.rootMotionOut = Math.max(0, d - this._rootPrev);
        this._rootPrev = d;
      } else {
        this.rootMotionOut = 0;
      }

      const k = this.actionFade > 1e-4 ? dt / this.actionFade : 1;
      this.actionWeight += (this.actionTarget - this.actionWeight) * Math.min(1, k);
      if (this.actionTarget === 0 && this.actionWeight < 0.01) {
        this.actionWeight = 0;
        this.action = null;
      }
    } else {
      this.rootMotionOut = 0;
    }

    // ---- additive ----------------------------------------------------------
    this.hurtTime += dt;
    const hurtClip = this.clips.hurt;
    this.hurtWeight = this.hurtTime < hurtClip.duration
      ? 1 - this.hurtTime / hurtClip.duration
      : 0;
  }

  /**
   * Locomotion blend weights.
   *
   * Two crossfades rather than one three-way blend: idle→walk from 0.15 to
   * 2.2 m/s, walk→run from 2.2 to 5.4. The upper knee sits below the 6.2 m/s
   * top speed on purpose — the run should be fully committed before the hero is
   * at full pelt, or the last third of the speed range has no visual change.
   */
  _updateLocoWeights(dt) {
    const s = this.speed;
    const targetMove = smoothstep(0.15, 2.2, s);
    const targetRun = smoothstep(2.2, 5.4, s);
    if (dt <= 0) {
      this.moveWeight = targetMove;
      this.runWeight = targetRun;
      return;
    }
    // Weights are themselves damped: a hero clipping a wall loses 4 m/s in one
    // fixed step, and an undamped blend snaps from run to idle in that frame.
    const k = 1 - Math.exp(-dt / 0.09);
    this.moveWeight += (targetMove - this.moveWeight) * k;
    this.runWeight += (targetRun - this.runWeight) * k;
  }

  // =======================================================================
  // evaluation
  // =======================================================================

  _evaluate() {
    // 1. locomotion layer: idle ↔ walk ↔ run at the shared phase.
    // `_loco` doubles as scratch for the run sample before it becomes the
    // layer's output; `_blend` is safe with dst === a (every read precedes
    // every write), which is what makes the extra pose unnecessary.
    const walk = this.clips.walk, run = this.clips.run, idle = this.clips.idle;
    if (this.moveWeight < 0.999) {
      this._sample(idle, this.idleTime % idle.duration, this._tmpA);
    }
    if (this.moveWeight > 0.001) {
      this._sample(walk, this.phase * walk.duration, this._tmpB);
      if (this.runWeight > 0.001) {
        this._sample(run, this.phase * run.duration, this._loco);
        this._blend(this._tmpB, this._tmpB, this._loco, this.runWeight, null);
      }
    }
    if (this.moveWeight <= 0.001) this._copy(this._loco, this._tmpA);
    else if (this.moveWeight >= 0.999) this._copy(this._loco, this._tmpB);
    else this._blend(this._loco, this._tmpA, this._tmpB, this.moveWeight, null);

    // 2. action layer.
    if (this.action && this.actionWeight > 0.001) {
      this._sample(this.action, Math.min(this.actionTime, this.action.duration), this._action);
      this._blend(this.pose, this._loco, this._action, this.actionWeight, this.actionMask);
    } else {
      this._copy(this.pose, this._loco);
    }

    // 3. additive: the hurt flinch, then procedural lean and look-at.
    if (this.hurtWeight > 0.001) {
      this._sample(this.clips.hurt, this.hurtTime, this._add, true);
      this._applyAdditive(this.pose, this._add, this.hurtWeight, this.maskUpper);
    }
    this._proceduralAdditive();

    // 4. cloth drive: the billow the coat should be pushed to, taken from
    //    whichever layer currently dominates.
    const locoBillow = idle.billow + (walk.billow - idle.billow) * this.moveWeight
      + (run.billow - walk.billow) * this.moveWeight * this.runWeight;
    if (this.action && this.actionWeight > 0.001) {
      this.billow = locoBillow + (this.action.billow - locoBillow) * this.actionWeight;
      this.billowDir = this.actionWeight > 0.5 ? this.action.billowDir : 'back';
    } else {
      this.billow = locoBillow;
      this.billowDir = 'back';
    }
  }

  /**
   * Sample a clip into a pose. Non-authored bones reset to bind (or to identity
   * for an additive clip, where the pose IS the delta), which is what makes
   * blending between clips that key different bone sets well defined.
   */
  _sample(clip, time, out, additive = false) {
    const n = this.rig.count;
    const rot = out.rot, pos = out.pos;
    for (let i = 0; i < n; i++) {
      rot[i * 4] = 0; rot[i * 4 + 1] = 0; rot[i * 4 + 2] = 0; rot[i * 4 + 3] = 1;
    }
    if (additive) pos.fill(0);
    else pos.set(this._bindPos);

    const e = this._e;
    for (let k = 0; k < clip.rotBones.length; k++) {
      const bi = clip.rotBones[k];
      clip.rotTracks[k].sample(time, e, 0);
      quatFromEuler(rot, bi * 4, e[0] * DEG, e[1] * DEG, e[2] * DEG);
    }
    for (let k = 0; k < clip.posBones.length; k++) {
      const bi = clip.posBones[k];
      clip.posTracks[k].sample(time, e, 0);
      pos[bi * 3] += e[0];
      pos[bi * 3 + 1] += e[1];
      pos[bi * 3 + 2] += e[2];
    }
  }

  _copy(dst, src) {
    dst.rot.set(src.rot);
    dst.pos.set(src.pos);
  }

  /** dst = lerp(a, b, t * mask[i]) */
  _blend(dst, a, b, t, mask) {
    const n = this.rig.count;
    for (let i = 0; i < n; i++) {
      const w = mask ? t * mask[i] : t;
      const o4 = i * 4, o3 = i * 3;
      if (w <= 0.0005) {
        if (dst !== a) {
          dst.rot[o4] = a.rot[o4]; dst.rot[o4 + 1] = a.rot[o4 + 1];
          dst.rot[o4 + 2] = a.rot[o4 + 2]; dst.rot[o4 + 3] = a.rot[o4 + 3];
          dst.pos[o3] = a.pos[o3]; dst.pos[o3 + 1] = a.pos[o3 + 1]; dst.pos[o3 + 2] = a.pos[o3 + 2];
        }
        continue;
      }
      slerp(dst.rot, o4, a.rot, o4, b.rot, o4, w);
      dst.pos[o3] = a.pos[o3] + (b.pos[o3] - a.pos[o3]) * w;
      dst.pos[o3 + 1] = a.pos[o3 + 1] + (b.pos[o3 + 1] - a.pos[o3 + 1]) * w;
      dst.pos[o3 + 2] = a.pos[o3 + 2] + (b.pos[o3 + 2] - a.pos[o3 + 2]) * w;
    }
  }

  /** dst.rot = dst.rot * slerp(identity, add.rot, w) */
  _applyAdditive(dst, add, weight, mask) {
    const n = this.rig.count;
    const q = this._q, q2 = this._q2;
    for (let i = 0; i < n; i++) {
      const w = (mask ? mask[i] : 1) * weight;
      if (w <= 0.0005) continue;
      const o4 = i * 4, o3 = i * 3;
      slerp(q, 0, IDENT, 0, add.rot, o4, w);
      q2[0] = dst.rot[o4]; q2[1] = dst.rot[o4 + 1]; q2[2] = dst.rot[o4 + 2]; q2[3] = dst.rot[o4 + 3];
      quatMul(dst.rot, o4, q2, 0, q, 0);
      dst.pos[o3] += add.pos[o3] * w;
      dst.pos[o3 + 1] += add.pos[o3 + 1] * w;
      dst.pos[o3 + 2] += add.pos[o3 + 2] * w;
    }
  }

  /**
   * Procedural additives: acceleration lean and cursor look-at.
   *
   * These are additive rather than baked into the clips because they are
   * CONTINUOUS functions of the player's input, and no keyframe can be. A hero
   * who leans into a turn and whose head tracks the cursor feels controlled;
   * one who does not feels like a sprite being dragged, and that difference
   * survives even at 89 px because the shoulder line tilts.
   */
  _proceduralAdditive() {
    const rig = this.rig;
    const rot = this.pose.rot;
    const q = this._q, q2 = this._q2;

    const lx = this.lean.x, ly = this.lean.y;
    if (Math.abs(lx) > 1e-4 || Math.abs(ly) > 1e-4) {
      // Split across three spine joints so the bend is a curve, not a hinge.
      const share = [['pelvis', 0.22], ['spine01', 0.30], ['spine02', 0.28], ['chest', 0.20]];
      for (const [name, f] of share) {
        const bi = rig.index.get(name);
        const o4 = bi * 4;
        quatFromEuler(q, 0, ly * f * DEG, 0, -lx * f * DEG);
        q2[0] = rot[o4]; q2[1] = rot[o4 + 1]; q2[2] = rot[o4 + 2]; q2[3] = rot[o4 + 3];
        quatMul(rot, o4, q2, 0, q, 0);
      }
    }

    if (Math.abs(this.lookYaw) > 1e-4 || Math.abs(this.lookPitch) > 1e-4) {
      const neck = rig.index.get('neck'), head = rig.index.get('head');
      for (const [bi, f] of [[neck, 0.42], [head, 0.58]]) {
        const o4 = bi * 4;
        quatFromEuler(q, 0, this.lookPitch * f * DEG, this.lookYaw * f * DEG, 0);
        q2[0] = rot[o4]; q2[1] = rot[o4 + 1]; q2[2] = rot[o4 + 2]; q2[3] = rot[o4 + 3];
        quatMul(rot, o4, q2, 0, q, 0);
      }
    }
  }

  // =======================================================================
  // output
  // =======================================================================

  /** Write the evaluated pose onto the rig's bones. */
  applyTo(rig) {
    const rot = this.pose.rot, pos = this.pose.pos;
    const bones = rig.bones;
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      b.quaternion.set(rot[i * 4], rot[i * 4 + 1], rot[i * 4 + 2], rot[i * 4 + 3]);
      b.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
  }

  // =======================================================================
  // events
  // =======================================================================

  _fireActionEvents(from, to) {
    if (!this.onEvent || !this.action) return;
    const ev = this.action.events;
    while (this._eventCursor < ev.length && ev[this._eventCursor].t <= to) {
      const e = ev[this._eventCursor++];
      if (e.t >= from - 1e-6) this.onEvent(e, this.action);
    }
  }

  /** Footsteps come off the locomotion cycle's phase, not off a clip clock, so
   *  they stay in step through a walk↔run blend. */
  _fireLocoEvents(prev, now) {
    if (!this.onEvent || this.moveWeight < 0.35) return;
    const clip = this.runWeight > 0.5 ? this.clips.run : this.clips.walk;
    const wrapped = now < prev;
    for (const e of clip.events) {
      const p = e.t / clip.duration;
      const crossed = wrapped ? (p > prev || p <= now) : (p > prev && p <= now);
      if (crossed) this.onEvent(e, clip);
    }
  }

  stats() {
    return {
      speed: +this.speed.toFixed(2),
      move: +this.moveWeight.toFixed(2),
      run: +this.runWeight.toFixed(2),
      action: this.action?.name ?? null,
      actionWeight: +this.actionWeight.toFixed(2),
      billow: +this.billow.toFixed(2),
      frozen: this.frozen,
    };
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}
