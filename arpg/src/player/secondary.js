import * as THREE from 'three';

/**
 * MONARCH — procedural secondary motion for the coat, collar and hair.
 *
 * 23 of the hero's 46 bones are never keyframed. They are simulated here, as a
 * chain of damped springs on the bone TIPS, and the resulting tip positions are
 * converted back into local rotations that ride on top of whatever the animator
 * produced.
 *
 * ---------------------------------------------------------------------------
 * WHY A SOLVER AND NOT KEYFRAMES
 *
 * A keyframed coat can only react to motion the animator already knows about.
 * The player changes direction on a whim, dashes, gets knocked back and spins;
 * the single most important thing the coat can do is lag behind all of that.
 * A spring solver gets every one of those for free from one input — the world
 * transform of the parent bone — and costs about 40 floating-point operations
 * per bone.
 *
 * ---------------------------------------------------------------------------
 * THE ALGORITHM, PER BONE, PARENT FIRST
 *
 *   1. `rest`     = where the tip would be if the bone kept its animated pose.
 *   2. `sim`      = the simulated tip, integrated semi-implicitly:
 *                     v += (spring·(rest − sim) + gravity + drag·(−v) + wind) dt
 *                     sim += v dt
 *                   plus an INERTIA term: the parent's own displacement this
 *                   step is subtracted from the target, which is what actually
 *                   produces "the coat trails when you run".
 *   3. constrain  `sim` back onto the sphere of radius `length` about the
 *                 bone's head, so the chain never stretches.
 *   4. rotate     the bone by the minimal rotation taking `rest` to `sim`, and
 *                 rebuild its world matrix so the next bone in the chain
 *                 integrates against a solved parent.
 *
 * ---------------------------------------------------------------------------
 * STABILITY ON A 10-SECOND FRAME
 *
 * This container renders one frame in up to ten seconds. The engine clamps dt to
 * 0.1 s, which is still four times the stable step for a spring at k = 52. The
 * solver therefore takes its own fixed 1/120 s substeps, capped at 8 — a
 * pathological frame produces a slightly under-integrated coat rather than one
 * that explodes, and the cost of the cap is bounded.
 */

/** Fixed solver step. 1/120 keeps k = 52 comfortably inside stability. */
const SUB_DT = 1 / 120;
const MAX_SUB = 8;

export class SecondaryMotion {
  /** @param {import('./rig.js').Rig} rig */
  constructor(rig) {
    this.rig = rig;
    this.chains = rig.dynamic;
    const n = this.chains.length;

    /** Simulated tip positions in WORLD space, and their velocities. */
    this.sim = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.seeded = false;

    /** Index in `chains` for a given bone index, so a child can find its
     *  already-solved parent's entry. */
    this.slotOf = new Int32Array(rig.count).fill(-1);
    for (let i = 0; i < n; i++) this.slotOf[this.chains[i].i] = i;

    /** Per-chain classification, so the coat can be pushed outward by the
     *  billow term while hair is not. */
    this.isCoat = new Uint8Array(n);
    this.isHair = new Uint8Array(n);
    this.radial = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const name = rig.names[this.chains[i].i];
      this.isCoat[i] = name.startsWith('coat') ? 1 : 0;
      this.isHair[i] = name.startsWith('hair') ? 1 : 0;
      // Bind-space radial direction, used as the billow push direction. Taken
      // from the bone's HEAD so all segments of one chain push the same way.
      const bi = this.chains[i].i;
      const hx = rig.bindHead[bi * 3], hz = rig.bindHead[bi * 3 + 2];
      const l = Math.hypot(hx, hz) || 1;
      this.radial[i * 3] = hx / l;
      this.radial[i * 3 + 1] = 0;
      this.radial[i * 3 + 2] = hz / l;
    }

    // ---- tuning ------------------------------------------------------------
    /** Metres/s², applied to cloth. Deliberately ~40% of real gravity: at 1 g a
     *  0.3 m coat panel oscillates at ~0.9 Hz and reads as a wet towel. Cloth
     *  in film and games is almost always simulated light. */
    this.gravity = -4.2;
    /** 0..1.6, written by the player system each frame from the animator. */
    this.billow = 0;
    this.billowDir = 'back';
    /** Ambient movement so the coat is never dead still, even in a debug pose.
     *  Amplitude is tiny (2 cm) and the frequency is low. */
    this.windAmount = 0.5;
    this.windTime = 0;

    /** Owner-supplied world-space impulse, e.g. an explosion knocking the coat. */
    this.impulse = new THREE.Vector3();

    // ---- preallocated scratch ---------------------------------------------
    this._head = new THREE.Vector3();
    this._rest = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._d0 = new THREE.Vector3();
    this._d1 = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._wind = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qInv = new THREE.Quaternion();
    this._qOut = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._parentWorldQ = new THREE.Quaternion();
    this._rootQ = new THREE.Quaternion();
    this._prevRoot = new THREE.Vector3();
    this._rootDelta = new THREE.Vector3();
    this._hasPrevRoot = false;
  }

  /** Drop all simulation state — used on teleport, so the coat does not whip
   *  across the level after the shot harness moves the hero. */
  reset() {
    this.seeded = false;
    this.vel.fill(0);
    this._hasPrevRoot = false;
    this.impulse.set(0, 0, 0);
  }

  /**
   * Run the solver. The rig's world matrices must already be current.
   *
   * @param {number} dt        scaled frame delta
   * @param {THREE.Object3D} root  the player group (for the inertia term)
   */
  solve(dt, root) {
    const chains = this.chains;
    if (!chains.length) return;

    // Inertia source: how far the whole character moved this frame. Subtracting
    // it from every tip's target is what makes the coat stream backwards when
    // running and snap outward on a dash.
    root.getWorldPosition(this._tmp);
    if (this._hasPrevRoot) this._rootDelta.subVectors(this._tmp, this._prevRoot);
    else this._rootDelta.set(0, 0, 0);
    this._prevRoot.copy(this._tmp);
    this._hasPrevRoot = true;
    // Facing, resolved ONCE per frame. `getWorldQuaternion` walks the ancestor
    // chain, so calling it per bone per substep would be 23 x 8 walks.
    root.getWorldQuaternion(this._rootQ);

    this.windTime += dt;

    const steps = Math.min(MAX_SUB, Math.max(1, Math.round(dt / SUB_DT)));
    const h = steps > 0 ? Math.min(dt, MAX_SUB * SUB_DT) / steps : 0;
    // The inertia contribution is per substep, so a long frame does not apply
    // the whole frame's displacement eight times over.
    const inertiaScale = steps > 0 ? 1 / steps : 0;

    for (let s = 0; s < steps; s++) {
      this._step(h, inertiaScale);
    }

    // Impulses are one-shot: consumed by the substeps above through `vel`.
    this.impulse.multiplyScalar(Math.exp(-dt * 14));
    if (this.impulse.lengthSq() < 1e-6) this.impulse.set(0, 0, 0);
  }

  _step(h, inertiaScale) {
    const rig = this.rig;
    const chains = this.chains;

    // Wind: two out-of-phase sinusoids, so the coat has a slow lateral drift
    // with a faster shimmer on top. Deterministic — it is a function of the
    // clock only, so a capture at the same frame index always gets the same
    // fold pattern.
    const t = this.windTime;
    this._wind.set(
      Math.sin(t * 0.63) * 0.55 + Math.sin(t * 1.71 + 1.1) * 0.22,
      Math.sin(t * 0.94 + 2.3) * 0.16,
      Math.cos(t * 0.51 + 0.4) * 0.55 + Math.cos(t * 1.43) * 0.20
    ).multiplyScalar(this.windAmount);

    for (let c = 0; c < chains.length; c++) {
      const ch = chains[c];
      const bone = rig.bones[ch.i];
      const parent = bone.parent;

      // Bone head in world space is the translation column of its world matrix.
      const e = bone.matrixWorld.elements;
      this._head.set(e[12], e[13], e[14]);

      // The animated tip: head + (bone's world rotation) * bindDir * length.
      // Read straight off the matrix rather than decomposing, which is a
      // quaternion extraction per bone per substep.
      this._d0.copy(ch.dir);
      this._rest.set(
        e[0] * this._d0.x + e[4] * this._d0.y + e[8] * this._d0.z,
        e[1] * this._d0.x + e[5] * this._d0.y + e[9] * this._d0.z,
        e[2] * this._d0.x + e[6] * this._d0.y + e[10] * this._d0.z
      );
      // The matrix has no scale (bones are translation+rotation only), so the
      // transformed unit direction is already unit length.
      this._rest.multiplyScalar(ch.length).add(this._head);

      const o = c * 3;
      if (!this.seeded) {
        this.sim[o] = this._rest.x;
        this.sim[o + 1] = this._rest.y;
        this.sim[o + 2] = this._rest.z;
        this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
      }

      // ---- forces ---------------------------------------------------------
      let tx = this._rest.x, ty = this._rest.y, tz = this._rest.z;

      // Billow: push the coat's rest target radially outward and (for the ARISE
      // and ultimate poses) upward. This is how a coat is made to look like it
      // is being lifted by the power coming off the character, without any of
      // the cloth bones ever being keyframed.
      if (this.billow > 0.001 && this.isCoat[c]) {
        // Radial direction rotated into world space by the character's facing.
        this._d1.set(this.radial[o], 0, this.radial[o + 2]).applyQuaternion(this._rootQ);
        const up = this.billowDir === 'up' ? 1 : this.billowDir === 'back' ? 0.25 : 0.5;
        const amt = this.billow * ch.length * 0.85;
        tx += this._d1.x * amt;
        ty += amt * up * 1.15;
        tz += this._d1.z * amt;
      }

      const sx = this.sim[o], sy = this.sim[o + 1], sz = this.sim[o + 2];
      const stiff = ch.stiff;
      const drag = ch.drag;
      const grav = this.isHair[c] ? this.gravity * 0.45 : this.gravity;
      const windK = this.isHair[c] ? 0.35 : 1.0;

      let vx = this.vel[o], vy = this.vel[o + 1], vz = this.vel[o + 2];
      vx += ((tx - sx) * stiff - vx * drag + this._wind.x * windK + this.impulse.x) * h;
      vy += ((ty - sy) * stiff - vy * drag + grav + this._wind.y * windK + this.impulse.y) * h;
      vz += ((tz - sz) * stiff - vz * drag + this._wind.z * windK + this.impulse.z) * h;

      let nx = sx + vx * h - this._rootDelta.x * inertiaScale;
      let ny = sy + vy * h - this._rootDelta.y * inertiaScale;
      let nz = sz + vz * h - this._rootDelta.z * inertiaScale;

      // ---- length constraint ----------------------------------------------
      let dx = nx - this._head.x, dy = ny - this._head.y, dz = nz - this._head.z;
      const len = Math.hypot(dx, dy, dz) || 1e-6;
      const k = ch.length / len;
      dx *= k; dy *= k; dz *= k;
      nx = this._head.x + dx;
      ny = this._head.y + dy;
      nz = this._head.z + dz;

      // ---- angle limit ----------------------------------------------------
      // Cloth may swing far; hair may not, or the locks pass through the skull.
      // Both are clamped against the animated direction rather than against a
      // world axis, so the limit follows the character's orientation for free.
      const maxCos = this.isHair[c] ? 0.55 : -0.15;
      const rx = this._rest.x - this._head.x, ry = this._rest.y - this._head.y, rz = this._rest.z - this._head.z;
      const rl = Math.hypot(rx, ry, rz) || 1e-6;
      const dot = (dx * rx + dy * ry + dz * rz) / (ch.length * rl);
      if (dot < maxCos) {
        // Pull the tip back toward the rest direction until it is inside the
        // cone. One slerp-ish step per substep converges fast and never pops.
        const blend = 0.55;
        nx += (this._rest.x - nx) * blend;
        ny += (this._rest.y - ny) * blend;
        nz += (this._rest.z - nz) * blend;
        let ex = nx - this._head.x, ey = ny - this._head.y, ez = nz - this._head.z;
        const el = Math.hypot(ex, ey, ez) || 1e-6;
        const ek = ch.length / el;
        ex *= ek; ey *= ek; ez *= ek;
        nx = this._head.x + ex; ny = this._head.y + ey; nz = this._head.z + ez;
      }

      // Velocity is recovered from the actual displacement, so the constraint's
      // correction is absorbed rather than fought on the next step.
      this.vel[o] = (nx - sx) / h;
      this.vel[o + 1] = (ny - sy) / h;
      this.vel[o + 2] = (nz - sz) / h;
      this.sim[o] = nx;
      this.sim[o + 1] = ny;
      this.sim[o + 2] = nz;

      // ---- write the rotation back ----------------------------------------
      this._d0.set(this._rest.x - this._head.x, this._rest.y - this._head.y, this._rest.z - this._head.z).normalize();
      this._d1.set(nx - this._head.x, ny - this._head.y, nz - this._head.z).normalize();
      this._q.setFromUnitVectors(this._d0, this._d1);
      if (Math.abs(this._q.w) < 0.99999) {
        // A world-space delta becomes a local one by conjugating with the
        // parent's world rotation:
        //   q_local_new = inv(Rp) · q_delta · Rp · q_local_old
        // The parent rotation is read out of its world MATRIX rather than via
        // `getWorldQuaternion`, which internally re-walks the ancestor chain.
        if (parent) {
          this._m.extractRotation(parent.matrixWorld);
          this._parentWorldQ.setFromRotationMatrix(this._m);
        } else {
          this._parentWorldQ.identity();
        }
        this._qInv.copy(this._parentWorldQ).invert();
        this._qOut.copy(this._qInv).multiply(this._q).multiply(this._parentWorldQ)
          .multiply(bone.quaternion);
        bone.quaternion.copy(this._qOut);
        bone.updateMatrix();
        if (parent) bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
        else bone.matrixWorld.copy(bone.matrix);
      }
    }

    this.seeded = true;
  }

  /**
   * Converge the solver immediately. `debugPose()` calls this so a captured
   * frame shows a settled coat rather than one still falling from bind pose —
   * the harness only pumps 14-16 frames and a spring at k = 19 needs ~0.5 s.
   */
  snap(root, iterations = 90) {
    root.getWorldPosition(this._prevRoot);
    root.getWorldQuaternion(this._rootQ);
    this._hasPrevRoot = true;
    this._rootDelta.set(0, 0, 0);
    for (let i = 0; i < iterations; i++) this._step(SUB_DT, 0);
  }

  stats() {
    return { bones: this.chains.length, billow: +this.billow.toFixed(2), seeded: this.seeded };
  }
}
