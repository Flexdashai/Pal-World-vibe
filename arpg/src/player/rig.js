import * as THREE from 'three';

/**
 * MONARCH — the hero's skeleton.
 *
 * Everything about the character (mesh, animation, cloth) is authored against
 * this one table, so proportions live in exactly one place. Bones are declared
 * in **bind-world space** as a head→tail segment rather than as a local offset,
 * because that is the form three different consumers actually want:
 *
 *   - the hierarchy needs `head - parent.head` (computed here),
 *   - the auto-skinner needs the segment to measure vertex distance against,
 *   - the mesh generators need absolute positions to place a pauldron on.
 *
 * Declaring local offsets and deriving world positions is the other way round
 * and makes every proportion edit a chain of arithmetic.
 *
 * ---------------------------------------------------------------------------
 * PROPORTIONS
 *
 * 1.82 m tall (UNITS.playerHeight), feet at y = 0, facing **+Z**. The facing
 * convention is not free: the stub established `rotation.y = atan2(vx, vz)`,
 * `ui` derives the cursor/facing arrow from the same expression, and yaw 0 under
 * that formula points along +Z. Building the character facing anywhere else
 * silently rotates the hero 90° away from their own movement vector.
 *
 * The figure is deliberately NOT realistic: shoulders sit at 0.52 of height
 * (a real human is ~0.82 of *shoulder* width to height), the pauldrons push the
 * silhouette out to ~0.95 m across, and the legs are slightly long. At the
 * isometric camera the hero is 89 px tall in the `hero` shot and 220 px in
 * `character` — nothing below ~2 cm survives, so the read has to come from the
 * outline. Heroic proportion is a readability decision, not a style one.
 *
 * ---------------------------------------------------------------------------
 * BONE COUNT
 *
 * 46 bones. three uploads the palette as a float bone TEXTURE (there is no
 * uniform-array path any more), so the count is not a shader limit — but every
 * bone costs a matrix compose + a texture row per frame, and the cloth solver
 * runs over 23 of them, so the budget is spent where it shows: 12 in the coat
 * skirt, 8 in the hair, 3 in the collar.
 */

const D = Math.PI / 180;

/** Coat skirt chains: angle around +Z, and the y its hem reaches.
 *  The hem is lowest at the back — a coat that ends at one height all the way
 *  round reads as a bell, not as a garment. */
const COAT_CHAINS = [
  { key: 'FL', deg: 38, hem: 0.40 },
  { key: 'FR', deg: -38, hem: 0.40 },
  { key: 'SL', deg: 95, hem: 0.32 },
  { key: 'SR', deg: -95, hem: 0.32 },
  { key: 'BL', deg: 152, hem: 0.24 },
  { key: 'BR', deg: -152, hem: 0.24 },
];

/** Radii of the coat cone at the belt, the mid ring, and the hem. */
const COAT_R = [0.150, 0.208, 0.285];

/**
 * Build the raw bone table.
 *
 * @returns {Array<{name,parent,head,tail,radius,dynamic,stiff,drag}>}
 *   `radius`  is the auto-skinner's influence scale, not a visual thickness.
 *   `dynamic` marks a bone the secondary-motion solver owns.
 *   `stiff`/`drag` are that solver's per-bone tuning (see secondary.js).
 */
function buildBoneDefs() {
  const b = [];
  const add = (name, parent, head, tail, radius, extra) =>
    b.push({ name, parent, head, tail, radius, dynamic: false, stiff: 0, drag: 0, ...extra });

  // ---- spine -------------------------------------------------------------
  // `root` sits at the actor's feet, at the origin, so root motion is a plain
  // translation of one bone and `position` and the rig agree with no offset.
  add('root', null, [0, 0, 0], [0, 0.22, 0], 0.30);
  add('pelvis', 'root', [0, 0.960, 0], [0, 1.100, 0], 0.20);
  add('spine01', 'pelvis', [0, 1.100, 0], [0, 1.240, 0], 0.18);
  add('spine02', 'spine01', [0, 1.240, 0], [0, 1.380, 0], 0.19);
  add('chest', 'spine02', [0, 1.380, 0], [0, 1.505, 0], 0.21);
  add('neck', 'chest', [0, 1.505, 0.006], [0, 1.615, 0.012], 0.075);
  add('head', 'neck', [0, 1.615, 0.012], [0, 1.800, 0.004], 0.125);

  // ---- arms --------------------------------------------------------------
  // Bind pose is a relaxed A-pose (~4° of splay). A T-pose bind gives cleaner
  // weights but the shoulder deltoid then has to travel 90° to reach any real
  // animation, and linear blend skinning collapses the armpit on the way.
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    add(`clav${L}`, 'chest', [s * 0.038, 1.478, 0.014], [s * 0.175, 1.500, 0.006], 0.10);
    add(`arm${L}`, `clav${L}`, [s * 0.175, 1.500, 0.006], [s * 0.196, 1.202, 0.012], 0.085);
    add(`forearm${L}`, `arm${L}`, [s * 0.196, 1.202, 0.012], [s * 0.212, 0.935, 0.022], 0.070);
    add(`hand${L}`, `forearm${L}`, [s * 0.212, 0.935, 0.022], [s * 0.222, 0.770, 0.030], 0.070);
  }

  // ---- legs --------------------------------------------------------------
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    add(`thigh${L}`, 'pelvis', [s * 0.098, 0.930, 0.005], [s * 0.104, 0.500, 0.010], 0.125);
    add(`shin${L}`, `thigh${L}`, [s * 0.104, 0.500, 0.010], [s * 0.108, 0.098, -0.012], 0.095);
    add(`foot${L}`, `shin${L}`, [s * 0.108, 0.098, -0.012], [s * 0.110, 0.028, 0.092], 0.085);
    add(`toe${L}`, `foot${L}`, [s * 0.110, 0.028, 0.092], [s * 0.110, 0.020, 0.168], 0.060);
  }

  // ---- collar ------------------------------------------------------------
  // The tall standing collar is the single most recognisable piece of the
  // monarch coat and the thing that gives the head a distinctive shape from
  // above, which is the only angle this camera ever offers. Dynamic, so it
  // swings a little when the hero turns hard.
  const collarDyn = { dynamic: true, stiff: 26, drag: 5.5 };
  add('collarL', 'chest', [0.085, 1.505, -0.042], [0.150, 1.700, -0.120], 0.10, collarDyn);
  add('collarR', 'chest', [-0.085, 1.505, -0.042], [-0.150, 1.700, -0.120], 0.10, collarDyn);
  add('collarB', 'chest', [0, 1.500, -0.078], [0, 1.735, -0.150], 0.12, collarDyn);

  // ---- hair --------------------------------------------------------------
  // Three swept back spikes (two segments each) plus two fringe locks. Hair is
  // stiffer and lighter than cloth: high spring, low drag, so it flicks on a
  // direction change and settles inside a third of a second.
  const hairA = { dynamic: true, stiff: 52, drag: 4.0 };
  const hairB = { dynamic: true, stiff: 40, drag: 3.6 };
  const spikes = [
    ['BL', 0.056, 0.0, 1.0],
    ['BC', 0.000, 0.020, 1.10],
    ['BR', -0.056, 0.0, 1.0],
  ];
  for (const [key, x, lift, len] of spikes) {
    add(`hair${key}a`, 'head', [x, 1.775 + lift, -0.045], [x * 1.5, 1.815 + lift, -0.045 - 0.09 * len], 0.055, hairA);
    add(`hair${key}b`, `hair${key}a`, [x * 1.5, 1.815 + lift, -0.045 - 0.09 * len],
      [x * 1.8, 1.822 + lift, -0.045 - 0.175 * len], 0.045, hairB);
  }
  add('hairFL', 'head', [0.046, 1.782, 0.052], [0.074, 1.730, 0.112], 0.050, hairA);
  add('hairFR', 'head', [-0.046, 1.782, 0.052], [-0.074, 1.730, 0.112], 0.050, hairA);

  // ---- coat skirt --------------------------------------------------------
  // Two segments per chain. The upper segment is stiff (it is still fabric
  // gathered at a belt); the lower one is loose and heavy so the hem trails.
  for (const c of COAT_CHAINS) {
    const s = Math.sin(c.deg * D), z = Math.cos(c.deg * D);
    const yMid = 0.955 - (0.955 - c.hem) * 0.52;
    add(`coat${c.key}a`, 'pelvis',
      [s * COAT_R[0], 0.955, z * COAT_R[0]],
      [s * COAT_R[1], yMid, z * COAT_R[1]],
      0.16, { dynamic: true, stiff: 30, drag: 5.0 });
    add(`coat${c.key}b`, `coat${c.key}a`,
      [s * COAT_R[1], yMid, z * COAT_R[1]],
      [s * COAT_R[2], c.hem, z * COAT_R[2]],
      0.17, { dynamic: true, stiff: 19, drag: 4.2 });
  }

  return b;
}

/**
 * The runtime rig: bones, bind data, and the fast lookups everything else needs.
 *
 * `bindHead` / `bindTail` are kept as flat Float32Arrays because the auto-skinner
 * walks them once per vertex across ~10 000 vertices and 46 bones — an array of
 * Vector3 objects there is 460 000 property lookups through a pointer chase.
 */
export class Rig {
  constructor() {
    this.defs = buildBoneDefs();
    this.count = this.defs.length;

    this.names = this.defs.map((d) => d.name);
    this.index = new Map();
    for (let i = 0; i < this.count; i++) this.index.set(this.names[i], i);

    this.parent = new Int32Array(this.count);
    this.bindHead = new Float32Array(this.count * 3);
    this.bindTail = new Float32Array(this.count * 3);
    this.bindRadius = new Float32Array(this.count);
    /** Bone-local rest length, used by the cloth solver to keep chains rigid. */
    this.restLength = new Float32Array(this.count);

    this.bones = [];
    /** Local bind transform of each bone, kept so a pose can always be reset. */
    this.bindLocalPos = new Float32Array(this.count * 3);

    for (let i = 0; i < this.count; i++) {
      const d = this.defs[i];
      this.parent[i] = d.parent === null ? -1 : this.index.get(d.parent);
      if (d.parent !== null && this.parent[i] === undefined) {
        throw new Error(`[player.rig] bone "${d.name}" names unknown parent "${d.parent}"`);
      }
      this.bindHead[i * 3] = d.head[0];
      this.bindHead[i * 3 + 1] = d.head[1];
      this.bindHead[i * 3 + 2] = d.head[2];
      this.bindTail[i * 3] = d.tail[0];
      this.bindTail[i * 3 + 1] = d.tail[1];
      this.bindTail[i * 3 + 2] = d.tail[2];
      this.bindRadius[i] = d.radius;
      this.restLength[i] = Math.hypot(
        d.tail[0] - d.head[0], d.tail[1] - d.head[1], d.tail[2] - d.head[2]
      );
    }

    // ---- three hierarchy --------------------------------------------------
    // Bones carry ONLY a translation in bind pose. Every authored rotation is
    // therefore a rotation about the joint in the character's own axes, which is
    // what makes hand-written euler keyframes legible ("rotate the elbow 40° on
    // X") instead of relative to some baked orientation.
    for (let i = 0; i < this.count; i++) {
      const bone = new THREE.Bone();
      bone.name = this.names[i];
      const p = this.parent[i];
      const px = p >= 0 ? this.bindHead[p * 3] : 0;
      const py = p >= 0 ? this.bindHead[p * 3 + 1] : 0;
      const pz = p >= 0 ? this.bindHead[p * 3 + 2] : 0;
      const lx = this.bindHead[i * 3] - px;
      const ly = this.bindHead[i * 3 + 1] - py;
      const lz = this.bindHead[i * 3 + 2] - pz;
      bone.position.set(lx, ly, lz);
      this.bindLocalPos[i * 3] = lx;
      this.bindLocalPos[i * 3 + 1] = ly;
      this.bindLocalPos[i * 3 + 2] = lz;
      if (p >= 0) this.bones[p].add(bone);
      this.bones.push(bone);
    }

    this.rootBone = this.bones[0];
    this.rootBone.updateMatrixWorld(true);

    // Bind inverses are computed explicitly rather than let three derive them
    // from `bone.matrixWorld`. Deriving works only if the rig is still at the
    // origin at Skeleton construction time, which is an invisible ordering
    // dependency; computing them here means the skeleton is correct no matter
    // where the player group has already been moved to.
    this.boneInverses = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.count; i++) {
      m.identity().setPosition(
        this.bindHead[i * 3], this.bindHead[i * 3 + 1], this.bindHead[i * 3 + 2]
      );
      this.boneInverses.push(m.clone().invert());
    }

    this.skeleton = new THREE.Skeleton(this.bones, this.boneInverses);

    /** Chains the cloth solver owns, ordered parent-first so a child always
     *  integrates against an already-solved parent. */
    this.dynamic = [];
    for (let i = 0; i < this.count; i++) {
      if (!this.defs[i].dynamic) continue;
      this.dynamic.push({
        i,
        parent: this.parent[i],
        stiff: this.defs[i].stiff,
        drag: this.defs[i].drag,
        length: this.restLength[i],
        /** Bind-space direction head→tail, in the PARENT's frame. */
        dir: new THREE.Vector3(
          this.bindTail[i * 3] - this.bindHead[i * 3],
          this.bindTail[i * 3 + 1] - this.bindHead[i * 3 + 1],
          this.bindTail[i * 3 + 2] - this.bindHead[i * 3 + 2]
        ).normalize(),
      });
    }
  }

  id(name) {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`[player.rig] no bone "${name}"`);
    return i;
  }

  /** Bone indices for every name matching a prefix — 'coat' gets all 12. */
  ids(...names) {
    const out = [];
    for (const n of names) {
      if (n.endsWith('*')) {
        const p = n.slice(0, -1);
        for (let i = 0; i < this.count; i++) if (this.names[i].startsWith(p)) out.push(i);
      } else {
        out.push(this.id(n));
      }
    }
    return out;
  }

  /** Bind-space head of a bone, written into `out`. */
  head(name, out) {
    const i = this.id(name);
    return out.set(this.bindHead[i * 3], this.bindHead[i * 3 + 1], this.bindHead[i * 3 + 2]);
  }

  tail(name, out) {
    const i = this.id(name);
    return out.set(this.bindTail[i * 3], this.bindTail[i * 3 + 1], this.bindTail[i * 3 + 2]);
  }

  dispose() {
    this.skeleton.dispose();
    this.rootBone.removeFromParent();
  }
}

export { COAT_CHAINS, COAT_R };
