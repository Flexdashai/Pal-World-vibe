import * as THREE from 'three';

/**
 * MONARCH — `ai` skeletons.
 *
 * Split in two on purpose:
 *
 *   RigDef       the bone TABLE for one archetype. Built once, at load. Holds
 *                bind positions, influence radii, the parent array, the bind
 *                inverses and the ragdoll mapping. Shared by every actor of
 *                that archetype and by the (single) shared geometry.
 *   RigDef.make()  one live `THREE.Skeleton` + `THREE.Bone` hierarchy. Cheap.
 *                Every actor needs its own, because a skeleton IS the pose.
 *
 * That split is what makes forty actors affordable: forty skeletons of ~28
 * bones is 40 × 28 matrix composes per frame, while the vertex data — the
 * expensive part — exists once per archetype.
 *
 * ---------------------------------------------------------------------------
 * CONVENTIONS
 *
 * Bones are declared in **bind-world space** as a head→tail segment, feet at
 * y = 0, facing **+Z**. The facing is not free: everything in this project
 * derives yaw as `atan2(dir.x, dir.z)`, and yaw 0 under that formula points
 * along +Z. A body built facing anywhere else is silently rotated 90° away from
 * its own movement vector.
 *
 * Bones carry ONLY a translation in bind pose, so every authored rotation is a
 * rotation about the joint in the character's own axes. That is what makes
 * hand-written euler keyframes legible ("rotate the elbow 40° on X") instead of
 * relative to some baked orientation.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NAMES ARE FIXED
 *
 * `clips.js` addresses bones by name and one clip is shared across every biped
 * archetype (a ghoul and a knight walk with the same *structure* and different
 * *proportions*). So the biped plan always produces exactly these names:
 *
 *   root pelvis spine chest neck head
 *   clavL armL forearmL handL      (and R)
 *   thighL shinL footL             (and R)
 *
 * plus, optionally, `clav2L/arm2L/forearm2L/hand2L` for a four-armed body and
 * `rag0..N` / `tail0..N` / `chain0..N` for dynamic chains. A clip that names a
 * bone the plan did not build is skipped, not an error — that is what lets one
 * `walk` clip drive a two-armed ghoul and a four-armed boss.
 */

const D = Math.PI / 180;

/* ==========================================================================
 * plan builders
 * ========================================================================== */

/**
 * The humanoid plan.
 *
 * @param o
 *   height        total, metres
 *   hunch         forward lean of the whole spine, radians. The ghoul's read.
 *   headDrop      how far the head sits BELOW where the neck would put it —
 *                 the single strongest silhouette lever on an undead.
 *   shoulder      half-width of the shoulder line as a fraction of height
 *   armReach      arm length as a fraction of height (0.42 is human; 0.55 is
 *                 a ghoul whose knuckles pass its knees)
 *   legFrac       hip height as a fraction of height
 *   arms          2 or 4
 *   rags          [{ key, from:[x,y,z], dir:[x,y,z], length, links, stiff, drag }]
 *   crouch        lowers the pelvis and bends the legs in bind pose
 */
export function bipedPlan(o = {}) {
  const H = o.height ?? 1.8;
  const b = [];
  const add = (name, parent, head, tail, radius, extra) =>
    b.push({ name, parent, head, tail, radius, dynamic: false, stiff: 0, drag: 0, ...extra });

  const hipY = H * (o.legFrac ?? 0.52);
  const crouch = o.crouch ?? 0;
  const pelvisY = hipY * (1 - crouch * 0.16);
  const hunch = o.hunch ?? 0;
  const shoulderY = H * (o.shoulderFrac ?? 0.83);
  const halfShoulder = H * (o.shoulder ?? 0.115);
  const reach = H * (o.armReach ?? 0.44);
  const headDrop = (o.headDrop ?? 0) * H;
  const scale = H / 1.8;

  // ---- spine ---------------------------------------------------------------
  // The hunch is applied as a per-segment +Z offset that accumulates upward, so
  // the whole column curves rather than tilting rigidly — a rigid tilt reads as
  // a figure leaning, a curve reads as a spine.
  const spineZ = (t) => Math.sin(hunch) * t * t * H * 0.30;
  const chestY = shoulderY - H * 0.035;
  add('root', null, [0, 0, 0], [0, H * 0.12, 0], 0.30 * scale);
  add('pelvis', 'root', [0, pelvisY, 0], [0, pelvisY + H * 0.09, spineZ(0.2)], 0.20 * scale);
  add('spine', 'pelvis', [0, pelvisY + H * 0.09, spineZ(0.2)],
    [0, (pelvisY + chestY) * 0.5, spineZ(0.55)], 0.19 * scale);
  add('chest', 'spine', [0, (pelvisY + chestY) * 0.5, spineZ(0.55)],
    [0, chestY, spineZ(0.85)], 0.22 * scale);
  add('neck', 'chest', [0, chestY, spineZ(0.85)],
    [0, chestY + H * 0.055 - headDrop * 0.4, spineZ(1.0) + headDrop * 0.5], 0.085 * scale);
  add('head', 'neck', [0, chestY + H * 0.055 - headDrop * 0.4, spineZ(1.0) + headDrop * 0.5],
    [0, chestY + H * 0.145 - headDrop, spineZ(1.05) + headDrop * 1.1], 0.135 * scale);

  // ---- arms ----------------------------------------------------------------
  // A relaxed A-pose bind (~6° of splay). A T-pose bind gives cleaner weights,
  // but the deltoid then has to travel 90° to reach any real animation and
  // linear blend skinning collapses the armpit on the way.
  const armPairs = [{ suffix: '', y: shoulderY, len: reach, splay: 0.10 }];
  if ((o.arms ?? 2) >= 4) {
    // The second pair sits LOWER and shorter — vestigial. Two identical pairs
    // read as a symmetry error; one dominant pair and one folded pair reads as
    // a designed creature.
    armPairs.push({ suffix: '2', y: shoulderY - H * 0.135, len: reach * 0.58, splay: 0.30 });
  }
  for (const pair of armPairs) {
    for (const s of [1, -1]) {
      const L = s > 0 ? 'L' : 'R';
      const k = pair.suffix;
      const sx = s * halfShoulder * (k ? 0.82 : 1);
      const upper = pair.len * 0.44, lower = pair.len * 0.40, hand = pair.len * 0.16;
      const z0 = spineZ(0.85);
      const splay = pair.splay;
      add(`clav${k}${L}`, 'chest', [s * halfShoulder * 0.22, pair.y, z0],
        [sx, pair.y + H * 0.008, z0], 0.11 * scale);
      add(`arm${k}${L}`, `clav${k}${L}`, [sx, pair.y + H * 0.008, z0],
        [sx + s * splay * upper, pair.y - upper, z0 + upper * 0.10], 0.095 * scale);
      add(`forearm${k}${L}`, `arm${k}${L}`,
        [sx + s * splay * upper, pair.y - upper, z0 + upper * 0.10],
        [sx + s * splay * (upper + lower * 0.6), pair.y - upper - lower, z0 + (upper + lower) * 0.12],
        0.075 * scale);
      add(`hand${k}${L}`, `forearm${k}${L}`,
        [sx + s * splay * (upper + lower * 0.6), pair.y - upper - lower, z0 + (upper + lower) * 0.12],
        [sx + s * splay * (upper + lower * 0.7), pair.y - upper - lower - hand,
          z0 + (upper + lower) * 0.13 + hand * 0.35],
        0.075 * scale);
    }
  }

  // ---- legs ----------------------------------------------------------------
  const kneeY = hipY * (0.50 - crouch * 0.06);
  const ankleY = H * 0.055;
  const legSplay = H * (o.legSplay ?? 0.058);
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    add(`thigh${L}`, 'pelvis', [s * legSplay, pelvisY - H * 0.015, 0],
      [s * legSplay * 1.05, kneeY, crouch * H * 0.06], 0.135 * scale);
    add(`shin${L}`, `thigh${L}`, [s * legSplay * 1.05, kneeY, crouch * H * 0.06],
      [s * legSplay * 1.08, ankleY, -crouch * H * 0.03], 0.10 * scale);
    add(`foot${L}`, `shin${L}`, [s * legSplay * 1.08, ankleY, -crouch * H * 0.03],
      [s * legSplay * 1.08, H * 0.012, H * 0.062], 0.09 * scale);
  }

  addChains(b, o.rags, scale);
  return b;
}

/**
 * The quadruped plan. Different bone NAMES from the biped on purpose: nothing
 * about a four-legged walk cycle transfers, so sharing names would only invite
 * a clip to be applied to the wrong body.
 *
 *   root pelvis spineA spineB chest neck head
 *   fLegAL fLegBL fFootL  (front left)   + R
 *   hLegAL hLegBL hFootL  (hind left)    + R
 *   tail0..N
 */
export function quadrupedPlan(o = {}) {
  const H = o.height ?? 1.05;          // shoulder height
  const L = o.length ?? H * 2.1;       // nose to tail-base
  const b = [];
  const add = (name, parent, head, tail, radius, extra) =>
    b.push({ name, parent, head, tail, radius, dynamic: false, stiff: 0, drag: 0, ...extra });

  const scale = H / 1.05;
  const hipZ = -L * 0.34;
  const shZ = L * 0.24;
  const arch = o.arch ?? 0.14;         // how much higher the shoulders sit
  const hipY = H * (1 - arch * 0.55);
  const shY = H;

  add('root', null, [0, 0, 0], [0, H * 0.2, 0], 0.42 * scale);
  add('pelvis', 'root', [0, hipY, hipZ], [0, hipY + H * 0.05, hipZ + L * 0.14], 0.24 * scale);
  add('spineA', 'pelvis', [0, hipY + H * 0.05, hipZ + L * 0.14],
    [0, hipY + H * 0.10 + arch * H * 0.5, hipZ + L * 0.32], 0.24 * scale);
  add('spineB', 'spineA', [0, hipY + H * 0.10 + arch * H * 0.5, hipZ + L * 0.32],
    [0, shY * 0.98, shZ - L * 0.06], 0.24 * scale);
  add('chest', 'spineB', [0, shY * 0.98, shZ - L * 0.06], [0, shY * 0.94, shZ + L * 0.06], 0.27 * scale);
  // The head hangs BELOW the shoulder line. A quadruped with its head up reads
  // as a horse; a predator's head is level with or under its shoulders.
  add('neck', 'chest', [0, shY * 0.94, shZ + L * 0.06],
    [0, shY * (0.80 - arch), shZ + L * 0.20], 0.13 * scale);
  add('head', 'neck', [0, shY * (0.80 - arch), shZ + L * 0.20],
    [0, shY * (0.74 - arch), shZ + L * 0.36], 0.15 * scale);

  const legs = [
    { p: 'chest', k: 'f', z: shZ - L * 0.02, top: shY * 0.90, splay: 0.155, knee: 0.46, foreZ: 0.05 },
    { p: 'pelvis', k: 'h', z: hipZ + L * 0.02, top: hipY * 0.94, splay: 0.150, knee: 0.44, foreZ: -0.07 },
  ];
  for (const leg of legs) {
    for (const s of [1, -1]) {
      const S = s > 0 ? 'L' : 'R';
      const x = s * H * leg.splay;
      add(`${leg.k}LegA${S}`, leg.p, [x, leg.top, leg.z],
        [x * 1.06, H * leg.knee, leg.z + L * leg.foreZ], 0.11 * scale);
      add(`${leg.k}LegB${S}`, `${leg.k}LegA${S}`, [x * 1.06, H * leg.knee, leg.z + L * leg.foreZ],
        [x * 1.08, H * 0.10, leg.z + L * leg.foreZ * 0.2], 0.09 * scale);
      add(`${leg.k}Foot${S}`, `${leg.k}LegB${S}`, [x * 1.08, H * 0.10, leg.z + L * leg.foreZ * 0.2],
        [x * 1.08, H * 0.015, leg.z + L * leg.foreZ * 0.2 + H * 0.10], 0.075 * scale);
    }
  }

  // ---- tail ----------------------------------------------------------------
  // Fully dynamic. A tail is the cheapest secondary motion in the game and the
  // single most effective at making a creature read as alive at 120 px.
  const links = o.tailLinks ?? 5;
  const tailLen = o.tailLength ?? L * 0.85;
  for (let i = 0; i < links; i++) {
    const t0 = i / links, t1 = (i + 1) / links;
    const y0 = hipY + H * 0.05 - t0 * t0 * H * 0.35;
    const y1 = hipY + H * 0.05 - t1 * t1 * H * 0.35;
    add(`tail${i}`, i === 0 ? 'pelvis' : `tail${i - 1}`,
      [0, y0, hipZ - tailLen * t0], [0, y1, hipZ - tailLen * t1],
      0.09 * scale * (1 - t0 * 0.55),
      { dynamic: true, stiff: 26 - i * 2.4, drag: 5.0 });
  }

  addChains(b, o.rags, scale);
  return b;
}

/** Append dynamic hanging chains (rags, chains, hair, hanging flesh). */
function addChains(b, specs, scale) {
  if (!specs) return;
  for (const spec of specs) {
    const links = spec.links ?? 2;
    const dir = spec.dir ?? [0, -1, 0];
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const dx = dir[0] / l, dy = dir[1] / l, dz = dir[2] / l;
    for (let i = 0; i < links; i++) {
      const t0 = (i / links) * spec.length, t1 = ((i + 1) / links) * spec.length;
      b.push({
        name: `${spec.key}${i}`,
        parent: i === 0 ? (spec.parent ?? 'pelvis') : `${spec.key}${i - 1}`,
        head: [spec.from[0] + dx * t0, spec.from[1] + dy * t0, spec.from[2] + dz * t0],
        tail: [spec.from[0] + dx * t1, spec.from[1] + dy * t1, spec.from[2] + dz * t1],
        radius: (spec.radius ?? 0.14) * scale,
        dynamic: true,
        // Lower links are looser, so the end of a rag trails behind its root
        // instead of the whole chain swinging as one rigid stick.
        stiff: (spec.stiff ?? 30) * (1 - i * 0.22),
        drag: spec.drag ?? 5.0,
      });
    }
  }
}

/* ==========================================================================
 * RigDef
 * ========================================================================== */

/** Ragdoll bone name → rig bone name, for driving a dead body from `physics`. */
const RAGDOLL_MAP_BIPED = {
  pelvis: 'pelvis', spine: 'chest', head: 'head',
  upperArmL: 'armL', lowerArmL: 'forearmL',
  upperArmR: 'armR', lowerArmR: 'forearmR',
  thighL: 'thighL', shinL: 'shinL',
  thighR: 'thighR', shinR: 'shinR',
};
const RAGDOLL_MAP_QUAD = {
  pelvis: 'pelvis', spine: 'chest', head: 'head',
  upperArmL: 'fLegAL', lowerArmL: 'fLegBL',
  upperArmR: 'fLegAR', lowerArmR: 'fLegBR',
  thighL: 'hLegAL', shinL: 'hLegBL',
  thighR: 'hLegAR', shinR: 'hLegBR',
};

export class RigDef {
  /**
   * @param {Array} defs   from `bipedPlan` / `quadrupedPlan`
   * @param {string} plan  'biped' | 'quadruped'
   */
  constructor(defs, plan = 'biped') {
    this.defs = defs;
    this.plan = plan;
    this.count = defs.length;
    this.names = defs.map((d) => d.name);
    this.index = new Map();
    for (let i = 0; i < this.count; i++) this.index.set(this.names[i], i);

    this.parent = new Int32Array(this.count);
    this.bindHead = new Float32Array(this.count * 3);
    this.bindTail = new Float32Array(this.count * 3);
    this.bindRadius = new Float32Array(this.count);
    this.restLength = new Float32Array(this.count);
    this.bindLocal = new Float32Array(this.count * 3);
    /** Quaternion taking +Y onto the bone's bind axis. The ragdoll's bone
     *  quaternions use +Y-down-the-bone, so the world rotation a dead body's
     *  rig bone needs is `qRagdoll * inverse(axisQuat)`. */
    this.axisQuat = new Float32Array(this.count * 4);

    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();

    for (let i = 0; i < this.count; i++) {
      const d = defs[i];
      const p = d.parent === null || d.parent === undefined ? -1 : this.index.get(d.parent);
      if (d.parent && p === undefined) {
        throw new Error(`[ai.rig] bone "${d.name}" names unknown parent "${d.parent}"`);
      }
      this.parent[i] = p ?? -1;
      for (let k = 0; k < 3; k++) {
        this.bindHead[i * 3 + k] = d.head[k];
        this.bindTail[i * 3 + k] = d.tail[k];
      }
      this.bindRadius[i] = d.radius;
      dir.set(d.tail[0] - d.head[0], d.tail[1] - d.head[1], d.tail[2] - d.head[2]);
      this.restLength[i] = dir.length();
      if (this.restLength[i] > 1e-6) {
        q.setFromUnitVectors(up, dir.divideScalar(this.restLength[i]));
      } else {
        q.identity();
      }
      this.axisQuat[i * 4] = q.x; this.axisQuat[i * 4 + 1] = q.y;
      this.axisQuat[i * 4 + 2] = q.z; this.axisQuat[i * 4 + 3] = q.w;

      const pi = this.parent[i];
      const px = pi >= 0 ? this.bindHead[pi * 3] : 0;
      const py = pi >= 0 ? this.bindHead[pi * 3 + 1] : 0;
      const pz = pi >= 0 ? this.bindHead[pi * 3 + 2] : 0;
      this.bindLocal[i * 3] = d.head[0] - px;
      this.bindLocal[i * 3 + 1] = d.head[1] - py;
      this.bindLocal[i * 3 + 2] = d.head[2] - pz;
    }

    // Bind inverses computed explicitly rather than let three derive them from
    // `bone.matrixWorld`: deriving works only if the rig is still at the origin
    // when the Skeleton is constructed, which is an invisible ordering
    // dependency. These are shared by every instance of this archetype.
    this.boneInverses = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.count; i++) {
      m.identity().setPosition(
        this.bindHead[i * 3], this.bindHead[i * 3 + 1], this.bindHead[i * 3 + 2]
      );
      this.boneInverses.push(m.clone().invert());
    }

    /** Dynamic chains, ordered parent-first so a child always integrates
     *  against an already-solved parent. */
    this.dynamic = [];
    for (let i = 0; i < this.count; i++) {
      if (!defs[i].dynamic) continue;
      this.dynamic.push({
        i, parent: this.parent[i],
        stiff: defs[i].stiff, drag: defs[i].drag,
        length: this.restLength[i],
      });
    }

    /** Bone indices the animator may drive procedurally, resolved once. */
    this.key = {};
    for (const n of ['root', 'pelvis', 'spine', 'chest', 'neck', 'head',
      'spineA', 'spineB']) {
      if (this.index.has(n)) this.key[n] = this.index.get(n);
    }

    this.ragdollMap = plan === 'quadruped' ? RAGDOLL_MAP_QUAD : RAGDOLL_MAP_BIPED;
    /** Precomputed [ragdollBoneName, rigBoneIndex] pairs, so the death handler
     *  does no string work per frame. */
    this.ragdollPairs = [];
    for (const [rag, rigName] of Object.entries(this.ragdollMap)) {
      const i = this.index.get(rigName);
      if (i !== undefined) this.ragdollPairs.push([rag, i]);
    }
  }

  id(name) {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`[ai.rig] no bone "${name}"`);
    return i;
  }

  has(name) { return this.index.has(name); }

  /** Bone indices for every name matching a list; a trailing `*` is a prefix. */
  ids(...names) {
    const out = [];
    for (const n of names) {
      if (n.endsWith('*')) {
        const p = n.slice(0, -1);
        for (let i = 0; i < this.count; i++) if (this.names[i].startsWith(p)) out.push(i);
      } else if (this.index.has(n)) {
        out.push(this.index.get(n));
      }
    }
    return out.length ? out : [0];
  }

  /** Bind-space head/tail as a plain array — the mesh builders want absolute
   *  positions to place armour on. */
  headOf(name) {
    const i = this.id(name);
    return [this.bindHead[i * 3], this.bindHead[i * 3 + 1], this.bindHead[i * 3 + 2]];
  }

  tailOf(name) {
    const i = this.id(name);
    return [this.bindTail[i * 3], this.bindTail[i * 3 + 1], this.bindTail[i * 3 + 2]];
  }

  /** Midpoint of a bone, the natural anchor for a plate. */
  midOf(name, t = 0.5) {
    const a = this.headOf(name), b = this.tailOf(name);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /**
   * One live skeleton. Bones carry only a translation in bind pose.
   * @returns {{ bones: THREE.Bone[], skeleton: THREE.Skeleton, root: THREE.Bone }}
   */
  make() {
    const bones = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const bone = new THREE.Bone();
      bone.name = this.names[i];
      bone.position.set(this.bindLocal[i * 3], this.bindLocal[i * 3 + 1], this.bindLocal[i * 3 + 2]);
      // Bones are posed by hand every frame from the animator, so three's own
      // auto-update would recompose matrices we are about to overwrite.
      bone.matrixAutoUpdate = false;
      bones[i] = bone;
      const p = this.parent[i];
      if (p >= 0) bones[p].add(bone);
    }
    const root = bones[0];
    root.updateMatrix();
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones, this.boneInverses);
    return { bones, skeleton, root };
  }
}

/* ==========================================================================
 * archetype rig factory
 * ========================================================================== */

/**
 * Build the RigDef for an archetype. Proportions come from the archetype table
 * plus the per-archetype detail below, which is the ONLY place a body plan's
 * numbers live.
 */
export function rigFor(id, arch) {
  switch (id) {
    case 'ghoul':
      return new RigDef(bipedPlan({
        height: arch.height,
        // The read: a hook. A deep hunch, a head dropped below the shoulder
        // line, and arms long enough that the knuckles hang past the knees.
        hunch: 0.62, headDrop: 0.055, shoulder: 0.108, armReach: 0.545,
        legFrac: 0.50, shoulderFrac: 0.80, crouch: 0.55, legSplay: 0.055,
        rags: [
          { key: 'rag', parent: 'pelvis', from: [0.14, 0.86, 0.02], dir: [0.18, -1, 0.1],
            length: 0.52, links: 2, stiff: 24, drag: 5.4, radius: 0.15 },
          { key: 'ragB', parent: 'pelvis', from: [-0.16, 0.84, -0.06], dir: [-0.14, -1, -0.05],
            length: 0.46, links: 2, stiff: 22, drag: 5.6, radius: 0.14 },
          // Hanging flesh off the ribcage. Slow and heavy — this is the piece
          // that makes a ghoul read as decayed rather than as a thin man.
          { key: 'flesh', parent: 'chest', from: [0.02, 1.16, 0.14], dir: [0.05, -1, 0.35],
            length: 0.30, links: 2, stiff: 17, drag: 6.4, radius: 0.10 },
        ],
      }), 'biped');

    case 'knight':
      return new RigDef(bipedPlan({
        height: arch.height,
        hunch: 0.06, headDrop: 0.012, shoulder: 0.152, armReach: 0.425,
        legFrac: 0.505, shoulderFrac: 0.845, crouch: 0.12, legSplay: 0.070,
        rags: [
          // The tabard. One wide panel, three links, so it lifts on a stride.
          { key: 'tabard', parent: 'pelvis', from: [0, 1.02, 0.16], dir: [0, -1, 0.12],
            length: 0.66, links: 3, stiff: 34, drag: 5.0, radius: 0.22 },
          { key: 'cape', parent: 'chest', from: [0, 1.60, -0.14], dir: [0, -1, -0.20],
            length: 1.02, links: 3, stiff: 27, drag: 4.6, radius: 0.26 },
        ],
      }), 'biped');

    case 'caster':
      return new RigDef(bipedPlan({
        height: arch.height,
        // No crouch, no hunch, arms held high: the silhouette is a candle flame
        // and the legs are never seen.
        hunch: 0.12, headDrop: 0.0, shoulder: 0.098, armReach: 0.50,
        legFrac: 0.50, shoulderFrac: 0.845, crouch: 0.0, legSplay: 0.040,
        rags: [
          { key: 'robeF', parent: 'pelvis', from: [0, 1.05, 0.14], dir: [0.05, -1, 0.14],
            length: 1.02, links: 3, stiff: 22, drag: 5.6, radius: 0.28 },
          { key: 'robeB', parent: 'pelvis', from: [0, 1.05, -0.16], dir: [-0.05, -1, -0.16],
            length: 1.10, links: 3, stiff: 19, drag: 5.9, radius: 0.30 },
          { key: 'sleeveL', parent: 'forearmL', from: [0.26, 0.98, 0.06], dir: [0.05, -1, 0.02],
            length: 0.44, links: 2, stiff: 21, drag: 6.0, radius: 0.13 },
          { key: 'sleeveR', parent: 'forearmR', from: [-0.26, 0.98, 0.06], dir: [-0.05, -1, 0.02],
            length: 0.44, links: 2, stiff: 21, drag: 6.0, radius: 0.13 },
        ],
      }), 'biped');

    case 'brute':
      return new RigDef(bipedPlan({
        height: arch.height,
        // Shoulders wider than the figure is tall below them. Head sunk. Legs
        // short. The inverted triangle is the whole design.
        hunch: 0.34, headDrop: 0.048, shoulder: 0.205, armReach: 0.47,
        legFrac: 0.42, shoulderFrac: 0.80, crouch: 0.40, legSplay: 0.10,
        rags: [
          { key: 'chain', parent: 'chest', from: [0.30, 1.90, 0.10], dir: [0.1, -1, 0.15],
            length: 0.72, links: 3, stiff: 40, drag: 4.2, radius: 0.08 },
          { key: 'hide', parent: 'pelvis', from: [0, 1.02, 0.18], dir: [0, -1, 0.1],
            length: 0.60, links: 2, stiff: 26, drag: 5.6, radius: 0.28 },
        ],
      }), 'biped');

    case 'boss':
      return new RigDef(bipedPlan({
        height: arch.height,
        // Wide shoulders, SHORT arms and short legs. The first build ran
        // armReach 0.50 with a narrow torso and the boss photographed as a
        // spider: at five metres a limb that reaches 2.6 m out from a 1.9 m
        // wide body is a leg, not an arm. Mass at the top, reach kept in.
        hunch: 0.20, headDrop: 0.02, shoulder: 0.205, armReach: 0.415,
        legFrac: 0.415, shoulderFrac: 0.80, crouch: 0.26, legSplay: 0.125,
        arms: 4,
        rags: [
          // The hanging chain-flail off the left great arm. Long, heavy, and
          // the one asymmetric element of the silhouette.
          { key: 'flail', parent: 'handL', from: [1.15, 1.55, 0.30], dir: [0.15, -1, 0.10],
            length: 1.85, links: 4, stiff: 46, drag: 3.6, radius: 0.13 },
          { key: 'shroud', parent: 'pelvis', from: [0, 2.55, -0.30], dir: [0, -1, -0.22],
            length: 1.60, links: 3, stiff: 30, drag: 5.0, radius: 0.55 },
        ],
      }), 'biped');

    case 'beast':
      return new RigDef(quadrupedPlan({
        height: arch.height, length: arch.height * 2.05, arch: 0.20,
        tailLinks: 5, tailLength: arch.height * 1.15,
      }), 'quadruped');

    case 'shade':
    default:
      // The shadow soldier's DEFAULT body, used when nothing was extracted (the
      // shot harness, a debug spawn). A raised soldier normally borrows the rig
      // of whatever it was raised from — that is the whole point of the beat.
      return new RigDef(bipedPlan({
        height: arch.height,
        hunch: 0.16, headDrop: 0.012, shoulder: 0.125, armReach: 0.455,
        legFrac: 0.52, shoulderFrac: 0.83, crouch: 0.14, legSplay: 0.060,
        rags: [
          { key: 'wisp', parent: 'chest', from: [0, 1.42, -0.12], dir: [0, -1, -0.4],
            length: 0.85, links: 3, stiff: 18, drag: 6.4, radius: 0.20 },
          { key: 'tatterL', parent: 'pelvis', from: [0.15, 0.92, 0.02], dir: [0.2, -1, 0.05],
            length: 0.50, links: 2, stiff: 20, drag: 6.0, radius: 0.13 },
          { key: 'tatterR', parent: 'pelvis', from: [-0.15, 0.92, 0.02], dir: [-0.2, -1, 0.05],
            length: 0.50, links: 2, stiff: 20, drag: 6.0, radius: 0.13 },
        ],
      }), 'biped');
  }
}

export { D as DEG };
