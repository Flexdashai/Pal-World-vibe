import * as THREE from 'three';
import { SkinBuilder, superEllipse, smoothstep, curve } from './geometry.js';

/**
 * MONARCH — the hero, generated.
 *
 * Sung Jinwoo in the Shadow Monarch coat, read through a Diablo IV isometric
 * camera. Every surface here is parametric; there is not a single imported
 * vertex in the project.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SILHOUETTE HAS TO DO
 *
 * At the `hero` boom (24 m, 34° fov) the character is 89 px tall. At that size a
 * face is 6 px and armour panelling is invisible. Three things survive, and the
 * whole design is built around them:
 *
 *   1. **Shoulder span.** The pauldrons carry to ±0.46 m with a horn above each,
 *      giving a 0.95 m span against a 1.82 m height. That silhouette is unlike
 *      any enemy in the game, which is the actual requirement — the player must
 *      never have to hunt for themselves in a fight.
 *   2. **The coat's cone.** The skirt flares from 0.15 m at the belt to 0.30 m
 *      at the hem and the hem is 22 cm lower at the back than at the front. A
 *      running figure therefore has a moving, asymmetric base rather than two
 *      sticks.
 *   3. **Violet emissive.** Eyes, collar rim, coat placket, pauldron underedge,
 *      sternum sigil. Emissive is the only channel that is size-independent —
 *      bloom spreads it over several pixels no matter how far away the camera is.
 *
 * ---------------------------------------------------------------------------
 * BUILD ORDER
 *
 * One SkinBuilder per material; each generator writes into whichever builders it
 * needs. That is why a pauldron can have a plate shell, a dark-iron rim and a
 * violet under-edge without three separate transforms to keep in sync — they are
 * all authored in the same bind-world coordinates and simply land in different
 * vertex streams.
 */

const D = Math.PI / 180;
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _r = new THREE.Vector3();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _sc = new THREE.Vector3();

/**
 * Surface normal of a parametric patch at (u,v), by central difference.
 *
 * Trim ribbons are laid ON a shell's outer face, which means the ribbon's lift
 * direction and its width direction both have to be expressed in the surface's
 * own frame. Passing the "up the surface" tangent instead — the obvious mistake,
 * and the one that was in the first draft — rotates the ribbon 90° so it stands
 * on edge and disappears from every angle but one.
 */
function surfaceNormal(fn, u, v, out) {
  const du = 0.02, dv = 0.02;
  fn(Math.min(1, u + du), v, _sa);
  fn(Math.max(0, u - du), v, _sb);
  _sa.sub(_sb);
  fn(u, Math.min(1, v + dv), _sb);
  fn(u, Math.max(0, v - dv), _sc);
  _sb.sub(_sc);
  return out.crossVectors(_sb, _sa).normalize();
}

/** Material keys, in the order the meshes are added to the group. */
export const PART_KEYS = ['coat', 'lining', 'plate', 'plateDark', 'leather', 'skin', 'hair', 'trim', 'eyes'];

/**
 * @param {import('./rig.js').Rig} rig
 * @returns {{ geometries: Record<string, THREE.BufferGeometry>, stats: object }}
 */
export function buildCharacter(rig) {
  const B = {};
  for (const k of PART_KEYS) B[k] = new SkinBuilder(rig, k);

  buildTorsoCoat(rig, B);
  buildSkirt(rig, B);
  buildCollar(rig, B);
  buildCuirass(rig, B);
  buildBelt(rig, B);
  for (const s of [1, -1]) {
    buildPauldron(rig, B, s);
    buildArm(rig, B, s);
    buildLeg(rig, B, s);
  }
  buildHead(rig, B);
  buildHair(rig, B);

  const geometries = {};
  let tris = 0, verts = 0;
  for (const k of PART_KEYS) {
    const g = B[k].build();
    if (!g) continue;
    geometries[k] = g;
    tris += g.index.count / 3;
    verts += g.attributes.position.count;
  }
  return { geometries, stats: { triangles: tris, vertices: verts, bones: rig.count } };
}

// ===========================================================================
// torso
// ===========================================================================

/** Superellipse exponent for the torso. 2.6 is the value at which the ribcage
 *  stops reading as a cylinder and starts reading as a chest; past ~3.4 it turns
 *  into a slab and the coat looks like cardboard. */
const TORSO_N = 2.6;

const TORSO_Y0 = 0.945;
const TORSO_Y1 = 1.505;
/** Half-widths (x) and half-depths (z) up the torso, belt → shoulder. */
const TORSO_RX = [0.150, 0.144, 0.150, 0.163, 0.177, 0.186, 0.184, 0.176];
const TORSO_RZ = [0.119, 0.112, 0.117, 0.125, 0.133, 0.137, 0.134, 0.127];

function torsoRadius(t, theta, out) {
  const rx = curve(TORSO_RX, t);
  const rz = curve(TORSO_RZ, t);
  const k = superEllipse(theta, TORSO_N);
  const front = Math.max(0, Math.cos(theta));
  // Pectoral swell and a matching shoulder-blade hollow. Both are small (8 mm)
  // but they are what put a highlight break across the chest when a brazier is
  // off to one side, instead of one continuous rolled-off gradient.
  const pec = 0.010 * front * front * smoothstep(0.42, 0.72, t) * (1 - smoothstep(0.86, 1.0, t));
  const blade = -0.007 * Math.max(0, -Math.cos(theta)) * smoothstep(0.5, 0.8, t);
  out.x = Math.sin(theta) * (rx * k);
  out.z = Math.cos(theta) * (rz * k + pec + blade);
  return out;
}

function buildTorsoCoat(rig, B) {
  const coat = B.coat;
  coat.bindTo(['pelvis', 'spine01', 'spine02', 'chest', 'neck', 'clavL', 'clavR'], 2.6);
  coat.uvOrigin(0, 0);

  // Body of the coat. This IS the torso — the coat is closed at the front (a
  // diagonal placket, not an open lapel), so there is no reason to build a
  // separate body underneath it and then z-fight with it.
  coat.patch({
    rows: 9, cols: 22, closeU: true,
    fn: (u, v, out) => {
      const th = u * Math.PI * 2;
      torsoRadius(v, th, out);
      out.y = TORSO_Y0 + (TORSO_Y1 - TORSO_Y0) * v;
    },
  });

  // Yoke: closes the top of the torso in to the neck, so the isometric camera —
  // which looks down at 52° and therefore straight into any open top — sees
  // shoulder fabric rather than the inside of the coat.
  coat.patch({
    rows: 3, cols: 22, closeU: true,
    fn: (u, v, out) => {
      const th = u * Math.PI * 2;
      torsoRadius(1.0, th, out);
      const shrink = 1 - v * v * 0.68;
      out.x *= shrink;
      out.z *= shrink;
      // The trapezius: the yoke rises toward the neck instead of being flat,
      // which is most of what separates a heroic build from a coat hanger.
      out.y = TORSO_Y1 + v * 0.032 + 0.018 * v * Math.max(0, -Math.cos(th));
    },
  });
}

// ===========================================================================
// coat skirt
// ===========================================================================

/** Front opening half-angle. 16° each side gives a 32° gap, which at the belt
 *  is 8 cm — wide enough to show the leg beneath when running, narrow enough
 *  that the hero never looks like they forgot to fasten their coat. */
const SKIRT_GAP = 16 * D;

/** Hem height as a function of angle from front. Front tails are short so the
 *  legs read; the back is long so the coat trails. */
function skirtHem(theta) {
  const a = Math.abs(((theta + Math.PI) % (Math.PI * 2)) - Math.PI); // 0 front, π back
  return 0.46 - 0.28 * smoothstep(0.35, 2.5, a);
}

function skirtPoint(u, v, out) {
  const th = SKIRT_GAP + u * (Math.PI * 2 - SKIRT_GAP * 2);
  const hem = skirtHem(th);
  // v is eased so the rings bunch near the belt, where the fabric gathers, and
  // spread out down the fall, where it is smooth.
  const ve = v * v * 0.35 + v * 0.65;
  const y = 0.955 + (hem - 0.955) * ve;

  // The flare is the hero's whole lower silhouette. 0.152 → 0.375 is a 2.5×
  // taper over 60 cm: wide enough that the figure is an hourglass from above
  // (broad pauldrons, tight waist, broad coat) rather than a column. The first
  // pass used 0.288 and the normal-buffer capture showed a pencil skirt.
  const rTop = 0.152;
  const rHem = 0.375 + 0.045 * Math.max(0, -Math.cos(th));
  let r = rTop + (rHem - rTop) * Math.pow(ve, 1.22);

  // Six vertical folds, phase-locked to the six coat bone chains so the creases
  // sit ON the bones and the cloth solver's motion follows the folds instead of
  // sliding across them. Amplitude grows toward the hem: gathered cloth.
  // 9% of the radius — at 3.4 cm of relief this is the largest feature on the
  // coat and the only one guaranteed to survive to the wide shot.
  const fold = Math.cos((th - SKIRT_GAP) * 6.0);
  r *= 1 + 0.090 * fold * (0.18 + 0.82 * ve);

  const k = superEllipse(th, 2.2);
  out.x = Math.sin(th) * r * k;
  out.z = Math.cos(th) * r * k;
  out.y = y;
  return out;
}

function buildSkirt(rig, B) {
  const names = ['pelvis', 'spine01', 'coat*'];
  // Power 2.2: soft. The skirt must deform like cloth, and a hard falloff makes
  // each chain claim a wedge and shear against its neighbours at the seams.
  B.coat.bindTo(names, 2.2);
  B.lining.bindTo(names, 2.2);
  B.trim.bindTo(names, 2.2);

  B.coat.uvOrigin(0.6, 0);
  B.lining.uvOrigin(0, 0);

  B.coat.shell({
    rows: 11, cols: 26,
    thickness: 0.015,
    inner: B.lining,
    rim: B.coat,
    rimEdges: 'all',
    fn: skirtPoint,
  });

  // Violet placket down both edges of the front opening. This is the piece that
  // makes the hero readable when they are running away from the camera: two
  // vertical glowing lines that separate as the coat opens.
  for (const side of [0, 1]) {
    const pts = [];
    const nrm = [];
    for (let i = 0; i <= 8; i++) {
      const v = i / 8;
      skirtPoint(side, v, _p);
      pts.push([_p.x, _p.y, _p.z]);
      surfaceNormal(skirtPoint, side, v, _r);
      nrm.push([_r.x, _r.y, _r.z]);
    }
    B.trim.ribbon(pts, 0.020, 0.011, nrm);
  }

  // A violet chevron across the hips, where the coat is cinched. It is the one
  // horizontal emissive line on the model, and it is what separates the torso
  // block from the skirt block when the hero is a 40-px-wide smudge in a wide
  // shot — two vertical lines and a hem alone read as a single vertical mass.
  {
    const pts = [], nrm = [];
    for (let i = 0; i <= 14; i++) {
      const u = 0.06 + (i / 14) * 0.88;
      skirtPoint(u, 0.10, _p);
      pts.push([_p.x, _p.y, _p.z]);
      surfaceNormal(skirtPoint, u, 0.10, _r);
      nrm.push([_r.x, _r.y, _r.z]);
    }
    B.trim.ribbon(pts, 0.012, 0.012, nrm);
  }
}

// ===========================================================================
// collar
// ===========================================================================

/**
 * The standing collar. Opens 55° either side of front, rises to 1.755 m at the
 * back — 5 cm above the crown of the head — and cants backward.
 *
 * This is the piece doing the most work in the isometric read. From 52° above,
 * the head is a small ellipse; the collar puts a large, hard, asymmetric shape
 * behind it that no enemy silhouette shares.
 */
function collarPoint(u, v, out) {
  const th = (55 + u * 250) * D;   // 55° → 305°, i.e. around the back
  const backness = Math.max(0, -Math.cos(th));
  const sideness = Math.abs(Math.sin(th));

  const yTop = 1.585 + 0.170 * backness + 0.055 * sideness;
  const y = 1.498 + (yTop - 1.498) * v;

  // Flares outward as it rises, more at the back than at the sides.
  const r = 0.104 + (0.058 + 0.028 * backness) * Math.pow(v, 1.35);
  const lean = -0.055 * v * v * (0.45 + 0.55 * backness);

  out.x = Math.sin(th) * r * 1.12;
  out.z = Math.cos(th) * r + lean;
  out.y = y;
  return out;
}

function buildCollar(rig, B) {
  const names = ['chest', 'neck', 'collarL', 'collarR', 'collarB'];
  B.coat.bindTo(names, 3.4);
  B.lining.bindTo(names, 3.4);
  B.trim.bindTo(names, 3.4);
  B.coat.uvOrigin(1.4, 0);
  B.lining.uvOrigin(0.7, 0);

  B.coat.shell({
    rows: 5, cols: 20,
    thickness: 0.017,
    inner: B.lining,
    rim: B.coat,
    rimEdges: 'all',
    fn: collarPoint,
  });

  // Emissive rim along the collar's top edge — a violet horseshoe behind the
  // head. Sat 8 mm inside the edge so the rim geometry still catches a
  // specular highlight of its own.
  const pts = [], nrm = [];
  for (let i = 0; i <= 20; i++) {
    collarPoint(i / 20, 0.945, _p);
    pts.push([_p.x, _p.y, _p.z]);
    surfaceNormal(collarPoint, i / 20, 0.945, _r);
    nrm.push([_r.x, _r.y, _r.z]);
  }
  B.trim.ribbon(pts, 0.015, 0.013, nrm);
}

// ===========================================================================
// cuirass + belt
// ===========================================================================

function buildCuirass(rig, B) {
  const names = ['spine01', 'spine02', 'chest', 'clavL', 'clavR'];
  B.plate.bindTo(names, 5.0);
  B.plateDark.bindTo(names, 5.0);
  B.trim.bindTo(names, 5.0);
  B.plate.uvOrigin(0, 0);

  // Breastplate: a shell riding 12 mm proud of the coat, from the sternum to
  // just under the collar, wrapping 75° either side of front.
  B.plate.shell({
    rows: 7, cols: 14,
    thickness: 0.014,
    inner: B.plateDark,
    rim: B.plate,
    rimEdges: 'all',
    fn: (u, v, out) => {
      const th = (-78 + u * 156) * D;
      const t = 0.30 + v * 0.63;
      torsoRadius(t, th, out);
      const front = Math.max(0, Math.cos(th));
      // Central keel: 9 mm of ridge down the middle. It is the thing that
      // makes a curved plate read as forged rather than as a bib.
      const keel = 0.009 * Math.exp(-Math.pow(th / 0.30, 2));
      const grow = 0.013 + keel;
      out.x *= 1 + grow / 0.17;
      out.z += grow * front + keel * 0.5;
      out.y = TORSO_Y0 + (TORSO_Y1 - TORSO_Y0) * t;
    },
  });

  // Back plate. Simpler; it exists so the hero is not hollow when the camera
  // looks at their back, which at 45° yaw is half of all play.
  B.plateDark.shell({
    rows: 5, cols: 12,
    thickness: 0.012,
    inner: B.plateDark,
    rim: B.plateDark,
    rimEdges: 'all',
    fn: (u, v, out) => {
      const th = (104 + u * 152) * D;
      const t = 0.34 + v * 0.56;
      torsoRadius(t, th, out);
      out.x *= 1.075;
      out.z *= 1.075;
      out.y = TORSO_Y0 + (TORSO_Y1 - TORSO_Y0) * t;
    },
  });

  // Sternum sigil — a violet diamond, the Monarch's mark. Small (7 cm) but it
  // is dead centre of the chest and it is the first thing bloom finds.
  torsoRadius(0.62, 0, _p);
  _p.y = TORSO_Y0 + (TORSO_Y1 - TORSO_Y0) * 0.62;
  _p.z += 0.030;
  B.trim.fan(
    _p,
    _q.set(1, 0, 0), _r.set(0, 1, -0.22).normalize(),
    [[0, 0.042], [0.020, 0.012], [0.030, 0], [0.020, -0.012], [0, -0.046],
      [-0.020, -0.012], [-0.030, 0], [-0.020, 0.012]],
    1
  );
}

function buildBelt(rig, B) {
  const names = ['pelvis', 'spine01'];
  B.leather.bindTo(names, 4.5);
  B.plate.bindTo(names, 4.5);
  B.trim.bindTo(names, 4.5);
  B.leather.uvOrigin(0, 0);

  B.leather.patch({
    rows: 3, cols: 22, closeU: true,
    fn: (u, v, out) => {
      const th = u * Math.PI * 2;
      torsoRadius(0.02, th, out);
      const bulge = 1 + 0.09 * Math.sin(v * Math.PI);
      out.x *= bulge;
      out.z *= bulge;
      out.y = 0.905 + v * 0.086;
    },
  });

  // Buckle: a plate lozenge with a violet core, at the front of the belt.
  torsoRadius(0.02, 0, _p);
  _p.y = 0.948;
  _p.z += 0.016;
  B.plate.fan(_p, _q.set(1, 0, 0), _r.set(0, 1, 0),
    [[0.062, 0], [0.030, 0.046], [-0.030, 0.046], [-0.062, 0], [-0.030, -0.046], [0.030, -0.046]], 1);
  _p.z += 0.009;
  B.trim.fan(_p, _q.set(1, 0, 0), _r.set(0, 1, 0),
    [[0.026, 0], [0.012, 0.024], [-0.012, 0.024], [-0.026, 0], [-0.012, -0.024], [0.012, -0.024]], 1);
}

// ===========================================================================
// pauldron
// ===========================================================================

/**
 * @param {number} s  +1 left, -1 right
 *
 * Built in a frame attached to the shoulder: `A` is the arm axis, `U` points
 * outboard, `V` forward (V = A × U works out to +Z for the left shoulder).
 * Everything is a function of (distance along the arm, angle around it), which
 * is how a real pauldron is shaped and which means the plate follows the arm no
 * matter what the rig proportions become.
 *
 * ---------------------------------------------------------------------------
 * THREE LAMES, NOT ONE DOME
 *
 * The first version was a single smooth shell, and in the normal-buffer capture
 * it read as a bald hemisphere: no edges, no steps, nothing to catch a rim
 * highlight. Real pauldrons are stacked, overlapping plates, and each overlap is
 * a hard line that the brazier catches. Three lames, each shelled with its own
 * rim and each canted a little further out than the one above, give three of
 * those lines — which is what turns a blob into armour at 89 px.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE VIOLET GOES
 *
 * The camera looks down at −52° from +X+Z, so it sees the TOP and the OUTBOARD
 * and FRONT faces of the left pauldron. The first version put the emissive trim
 * on the plate's UNDER edge, which this camera can never see. It now runs along
 * the two lame overlaps, which are the most visible edges on the whole model.
 */
function buildPauldron(rig, B, s) {
  const L = s > 0 ? 'L' : 'R';
  const S = rig.head(`arm${L}`, new THREE.Vector3());
  const E = rig.tail(`arm${L}`, new THREE.Vector3());
  const A = new THREE.Vector3().subVectors(E, S).normalize();
  const U = new THREE.Vector3(s, 0, 0).projectOnPlane(A).normalize();
  const V = new THREE.Vector3().crossVectors(A, U).normalize();

  // Rigid to the clavicle: a pauldron is a solid object strapped to the
  // shoulder. Weighting it to the upper arm makes it shear when the arm lifts,
  // which is the single most common tell of a procedurally skinned character.
  B.plate.rigidTo(`clav${L}`);
  B.plateDark.rigidTo(`clav${L}`);
  B.trim.rigidTo(`clav${L}`);
  B.plate.uvOrigin(s > 0 ? 0.9 : 1.8, 0);

  /**
   * @param d0,d1   extent along the arm axis
   * @param r0,r1   radius at each end
   * @param half    angular half-width, degrees
   * @param out     outward cant along U
   * @param drop    extra reach at the outboard edge (φ ≈ 0), which is what
   *                gives each lame a point instead of a hem
   */
  const lame = (d0, d1, r0, r1, half, cant, drop) => (u, v, o) => {
    const phi = (-half + u * half * 2) * D;
    const c = Math.cos(phi);
    const d = d0 + (d1 - d0 + drop * c * c) * v;
    const rad = r0 + (r1 - r0) * v;
    // Squared-off, not circular: |cos|^1.35 flattens the top of each lame so
    // there is a broad plane facing the camera rather than a continuously
    // curving surface with a single specular dot on it.
    const shape = Math.pow(Math.abs(c), 0.35) * 0.28 + 0.72;
    o.set(0, 0, 0)
      .addScaledVector(A, d)
      .addScaledVector(U, c * rad * shape + cant)
      .addScaledVector(V, Math.sin(phi) * rad * shape)
      .add(S);
    return o;
  };

  // Top cop, over the shoulder itself. Cants furthest outboard, which is where
  // the silhouette's width comes from.
  const lame0 = lame(-0.072, 0.088, 0.076, 0.152, 112, 0.084, 0.030);
  // Middle band, stepped 12 mm proud of the cop.
  const lame1 = lame(0.062, 0.196, 0.156, 0.154, 102, 0.052, 0.052);
  // Lower band, the one that hangs over the bicep.
  const lame2 = lame(0.172, 0.300, 0.150, 0.118, 88, 0.020, 0.048);

  B.plate.shell({ rows: 4, cols: 14, thickness: 0.022, inner: B.plateDark, rim: B.plateDark, rimEdges: 'all', fn: lame0 });
  B.plate.shell({ rows: 3, cols: 13, thickness: 0.019, inner: B.plateDark, rim: B.plateDark, rimEdges: 'all', fn: lame1 });
  B.plateDark.shell({ rows: 3, cols: 11, thickness: 0.017, inner: B.plateDark, rim: B.plateDark, rimEdges: 'all', fn: lame2 });

  // ---- horns -------------------------------------------------------------
  // A swept, flattened spike rising off the top of the cop and raked backwards,
  // with a shorter second spine behind it. Two of these are most of the reason
  // the hero's outline is unmistakable at 89 px, so they are thick enough to
  // survive at that size rather than being hairline needles.
  // `squash` stays near 1: the first pass flattened the horns to 0.58 and at
  // this camera they presented edge-on and read as two stray hairs. A horn has
  // to have real cross-section to survive at 89 px.
  const horn = (uAt, len, rad, back, lift) => {
    const base = lame0(uAt, 0.10, new THREE.Vector3());
    const path = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      path.push([
        base.x + s * (0.070 * t + 0.045 * t * t) * (len / 0.24),
        base.y + lift * t - 0.045 * t * t,
        base.z - back * t - 0.070 * t * t,
      ]);
    }
    B.plate.tube({
      path,
      radius: (t) => rad * Math.pow(1 - t, 0.55) + 0.0015,
      radial: 8,
      squash: () => 0.82,
      capStart: true,
    });
  };
  horn(0.50, 0.26, 0.060, 0.088, 0.245);
  horn(0.28, 0.19, 0.044, 0.058, 0.165);

  // ---- violet edges ------------------------------------------------------
  // One ribbon per lame overlap, laid on the lame ABOVE the step so it reads as
  // light spilling out from between two plates.
  for (const [fn, v, width] of [[lame0, 0.94, 0.017], [lame1, 0.94, 0.014]]) {
    const pts = [], nrm = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      fn(u, v, _p);
      pts.push([_p.x, _p.y, _p.z]);
      surfaceNormal(fn, u, v, _r);
      nrm.push([_r.x, _r.y, _r.z]);
    }
    B.trim.ribbon(pts, width, 0.014, nrm);
  }
}

// ===========================================================================
// arm
// ===========================================================================

function buildArm(rig, B, s) {
  const L = s > 0 ? 'L' : 'R';
  const sh = rig.head(`arm${L}`, new THREE.Vector3());
  const el = rig.head(`forearm${L}`, new THREE.Vector3());
  const wr = rig.head(`hand${L}`, new THREE.Vector3());
  const ft = rig.tail(`hand${L}`, new THREE.Vector3());

  // ---- sleeve ------------------------------------------------------------
  B.coat.bindTo([`clav${L}`, `arm${L}`, `forearm${L}`, 'chest'], 3.0);
  B.coat.uvOrigin(s > 0 ? 2.2 : 2.9, 0);
  B.coat.tube({
    path: [
      [sh.x, sh.y + 0.030, sh.z],
      [lerp(sh.x, el.x, 0.35), lerp(sh.y, el.y, 0.35), lerp(sh.z, el.z, 0.35)],
      [lerp(sh.x, el.x, 0.72), lerp(sh.y, el.y, 0.72), lerp(sh.z, el.z, 0.72)],
      [el.x, el.y, el.z],
    ],
    radius: (t) => curve([0.079, 0.072, 0.060, 0.053], t),
    radial: 10,
    capStart: true,
  });

  // ---- vambrace ----------------------------------------------------------
  // Power 5: the forearm plate is rigid metal, so the weights must be nearly
  // binary across the wrist or the cuff shears when the hand rotates.
  B.plate.bindTo([`forearm${L}`, `hand${L}`], 5.0);
  B.plate.uvOrigin(s > 0 ? 0.3 : 0.6, 0.4);
  B.plate.tube({
    path: [
      [el.x, el.y + 0.008, el.z],
      [lerp(el.x, wr.x, 0.36), lerp(el.y, wr.y, 0.36), lerp(el.z, wr.z, 0.36)],
      [lerp(el.x, wr.x, 0.78), lerp(el.y, wr.y, 0.78), lerp(el.z, wr.z, 0.78)],
      [wr.x, wr.y + 0.004, wr.z],
      [wr.x, wr.y - 0.020, wr.z + 0.004],
    ],
    // The cuff flares at the wrist — a hard step in the profile, which catches
    // an edge highlight and separates hand from arm at any distance.
    radius: (t) => curve([0.062, 0.055, 0.048, 0.052, 0.066], t),
    radial: 10,
    squash: () => 0.86,
    capStart: true,
  });

  // Elbow cop.
  B.plateDark.bindTo([`forearm${L}`, `arm${L}`], 5.0);
  B.plateDark.tube({
    path: [
      [el.x + s * 0.012, el.y + 0.030, el.z - 0.006],
      [el.x + s * 0.016, el.y - 0.004, el.z - 0.010],
      [el.x + s * 0.012, el.y - 0.036, el.z - 0.006],
    ],
    radius: (t) => 0.030 + 0.034 * Math.sin(t * Math.PI),
    radial: 8,
    capStart: true,
    capEnd: true,
  });

  // ---- gauntlet ----------------------------------------------------------
  B.plate.rigidTo(`hand${L}`);
  B.plate.uvOrigin(s > 0 ? 1.1 : 1.4, 0.9);
  const handDir = new THREE.Vector3().subVectors(ft, wr).normalize();
  B.plate.tube({
    path: [
      [wr.x, wr.y - 0.012, wr.z],
      [wr.x + handDir.x * 0.055, wr.y + handDir.y * 0.055, wr.z + handDir.z * 0.055 + 0.006],
      [wr.x + handDir.x * 0.110, wr.y + handDir.y * 0.110, wr.z + handDir.z * 0.110 + 0.010],
      [wr.x + handDir.x * 0.150, wr.y + handDir.y * 0.150, wr.z + handDir.z * 0.150 + 0.004],
    ],
    // A fist: widest across the knuckles at t≈0.66, then falling away.
    radius: (t) => curve([0.044, 0.052, 0.055, 0.036], t),
    radial: 8,
    squash: (t) => 0.70 + 0.10 * t,
    capStart: true,
    capEnd: true,
  });

  // Knuckle glow — the hands are where every skill originates, so they carry a
  // permanent low ember of the shadow element.
  B.trim.rigidTo(`hand${L}`);
  _p.set(wr.x + handDir.x * 0.108, wr.y + handDir.y * 0.108, wr.z + handDir.z * 0.108 + 0.048);
  B.trim.fan(_p, _q.set(1, 0, 0), _r.copy(handDir).multiplyScalar(-1),
    [[0.030, 0.016], [0.030, -0.016], [-0.030, -0.016], [-0.030, 0.016]], 1);
}

// ===========================================================================
// leg
// ===========================================================================

function buildLeg(rig, B, s) {
  const L = s > 0 ? 'L' : 'R';
  const hip = rig.head(`thigh${L}`, new THREE.Vector3());
  const kn = rig.head(`shin${L}`, new THREE.Vector3());
  const an = rig.head(`foot${L}`, new THREE.Vector3());
  const toe = rig.tail(`toe${L}`, new THREE.Vector3());

  // ---- trouser + shin --------------------------------------------------
  B.leather.bindTo([`thigh${L}`, `shin${L}`, 'pelvis'], 3.0);
  B.leather.uvOrigin(s > 0 ? 0 : 1.3, 0);
  B.leather.tube({
    path: [
      [hip.x, hip.y + 0.040, hip.z],
      [lerp(hip.x, kn.x, 0.45), lerp(hip.y, kn.y, 0.45), lerp(hip.z, kn.z, 0.45)],
      [kn.x, kn.y, kn.z],
      [lerp(kn.x, an.x, 0.42), lerp(kn.y, an.y, 0.42), lerp(kn.z, an.z, 0.42)],
      [an.x, an.y + 0.030, an.z + 0.004],
    ],
    // Thigh 0.098 → calf belly 0.070 → ankle 0.050. The calf bulge matters:
    // a straight taper from hip to ankle is the classic "generated leg".
    radius: (t) => curve([0.100, 0.086, 0.066, 0.070, 0.050], t),
    radial: 10,
    squash: () => 0.90,
    capStart: true,
  });

  // ---- greave ------------------------------------------------------------
  B.plateDark.bindTo([`shin${L}`, `foot${L}`], 5.0);
  B.plateDark.shell({
    rows: 4, cols: 9,
    thickness: 0.012,
    inner: B.plateDark,
    rim: B.plateDark,
    rimEdges: 'all',
    fn: (u, v, out) => {
      const th = (-92 + u * 184) * D;
      const t = v;
      const y = kn.y - 0.030 + (an.y + 0.055 - (kn.y - 0.030)) * t;
      const rr = curve([0.078, 0.076, 0.070, 0.062, 0.058], t);
      const zc = lerp(kn.z, an.z, t);
      out.set(
        lerp(kn.x, an.x, t) + Math.sin(th) * rr * 0.92,
        y,
        zc + Math.cos(th) * rr
      );
      // Knee cop: a bulge at the top of the greave.
      const knee = 0.024 * Math.exp(-Math.pow((t - 0.04) / 0.16, 2)) * Math.max(0, Math.cos(th));
      out.z += knee;
      return out;
    },
  });

  // ---- boot --------------------------------------------------------------
  B.leather.bindTo([`foot${L}`, `toe${L}`, `shin${L}`], 4.0);
  B.leather.uvOrigin(s > 0 ? 2.6 : 3.9, 0);
  B.leather.tube({
    path: [
      [an.x, an.y + 0.070, an.z - 0.012],
      [an.x, an.y + 0.010, an.z - 0.030],
      [an.x, an.y - 0.045, an.z + 0.010],
      [an.x, an.y - 0.062, lerp(an.z, toe.z, 0.45)],
      [an.x, an.y - 0.066, lerp(an.z, toe.z, 0.82)],
      [toe.x, toe.y - 0.008, toe.z],
    ],
    radius: (t) => curve([0.070, 0.078, 0.072, 0.062, 0.054, 0.030], t),
    radial: 9,
    squash: (t) => 0.72 + 0.22 * (1 - t),
    capStart: true,
    capEnd: true,
  });

  // Toe cap.
  B.plate.bindTo([`toe${L}`, `foot${L}`], 5.0);
  B.plate.tube({
    path: [
      [an.x, an.y - 0.050, lerp(an.z, toe.z, 0.55)],
      [an.x, an.y - 0.062, lerp(an.z, toe.z, 0.82)],
      [toe.x, toe.y - 0.006, toe.z + 0.004],
    ],
    radius: (t) => curve([0.058, 0.050, 0.026], t),
    radial: 8,
    squash: () => 0.66,
    capEnd: true,
  });
}

// ===========================================================================
// head
// ===========================================================================

const HEAD_C = [0, 1.6875, 0.004];
const HEAD_R = [0.0895, 0.1125, 0.0985];

/**
 * The skull. A sphere is the starting point and every deformation below is
 * there because the sphere failed a specific way in a capture: no jaw, no brow,
 * no occipital mass, and a nose that read as a smudge.
 */
function headPoint(u, v, out) {
  const th = u * Math.PI * 2;          // 0 = front (+Z)
  const ph = v * Math.PI;              // 0 = crown, π = chin
  const sp = Math.sin(ph), cp = Math.cos(ph);
  const front = Math.max(0, Math.cos(th));
  const back = Math.max(0, -Math.cos(th));

  let rx = HEAD_R[0], ry = HEAD_R[1], rz = HEAD_R[2];

  // Jaw: narrows and shortens below the cheekbone, ending in a chin.
  const low = smoothstep(0.54, 1.0, v);
  rx *= 1 - 0.36 * low * low;
  rz *= 1 - 0.10 * low;

  // Occipital mass: the back of a skull is not hemispherical.
  rz += 0.011 * back * smoothstep(0.10, 0.45, v) * (1 - smoothstep(0.72, 1.0, v));

  // Brow ridge and the eye-socket shelf under it.
  const brow = 0.0075 * front * Math.exp(-Math.pow((v - 0.415) / 0.055, 2));
  const socket = -0.0055 * front * Math.exp(-Math.pow((v - 0.492) / 0.048, 2));

  // Nose: only within 20° of centre, from brow to the base of the septum.
  const centre = Math.exp(-Math.pow(th > Math.PI ? (th - Math.PI * 2) / 0.30 : th / 0.30, 2));
  const nose = 0.020 * centre * smoothstep(0.42, 0.56, v) * (1 - smoothstep(0.60, 0.70, v));

  // Cheekbone.
  const cheek = 0.006 * Math.exp(-Math.pow((v - 0.545) / 0.07, 2)) *
    Math.exp(-Math.pow((Math.abs(Math.sin(th)) - 0.72) / 0.30, 2));

  const rr = sp;
  out.x = Math.sin(th) * rr * (rx + cheek);
  out.y = HEAD_C[1] + cp * ry;
  out.z = HEAD_C[2] + Math.cos(th) * rr * rz + (brow + socket + nose) * sp;
  return out;
}

function buildHead(rig, B) {
  B.skin.bindTo(['head', 'neck'], 4.5);
  B.skin.uvOrigin(0, 0);
  B.skin.patch({ rows: 15, cols: 20, closeU: true, fn: headPoint });

  // Neck. Short and thick — a long neck under a tall collar reads as fragile,
  // and nothing about this character should.
  B.skin.bindTo(['neck', 'chest', 'head'], 4.0);
  B.skin.tube({
    path: [[0, 1.470, 0.004], [0, 1.545, 0.008], [0, 1.618, 0.010]],
    radius: (t) => curve([0.072, 0.058, 0.053], t),
    radial: 9,
    squash: () => 0.88,
    capStart: true,
  });

  // Eyes: two hot violet slits set into the socket shelf. Angled down and in,
  // which is the entire difference between "glowing eyes" and "a scowl".
  B.eyes.bindTo(['head'], 6.0);
  for (const s of [1, -1]) {
    const u = s > 0 ? 0.052 : 1 - 0.052;
    headPoint(u, 0.487, _p);
    _p.z += 0.004;
    _q.set(s * 0.92, 0.14, 0.36).normalize();
    _r.set(-0.10 * s, 0.96, 0.26).normalize();
    B.eyes.fan(_p, _q, _r,
      [[0.030, 0.0], [0.012, 0.0105], [-0.020, 0.008], [-0.030, 0.0], [-0.016, -0.008], [0.014, -0.009]],
      1);
  }
}

// ===========================================================================
// hair
// ===========================================================================

function buildHair(rig, B) {
  B.hair.bindTo(['head', 'neck', 'hair*'], 3.6);
  B.hair.uvOrigin(0, 0);

  // Cap: an offset shell over the skull with a hairline that dips at the
  // temples and rises over the forehead — the widow's peak is what makes the
  // face read as a face and not as a helmet from above.
  B.hair.patch({
    rows: 8, cols: 20, closeU: true,
    fn: (u, v, out) => {
      const th = u * Math.PI * 2;
      const front = Math.max(0, Math.cos(th));
      const peak = Math.exp(-Math.pow((th > Math.PI ? th - Math.PI * 2 : th) / 0.55, 2));
      const hairline = 0.36 + 0.155 * front - 0.085 * peak;
      const vv = v * hairline;
      headPoint(u, vv, out);
      // Lift off the scalp, more at the crown where hair has volume.
      const lift = 0.011 + 0.013 * (1 - v) + 0.006 * Math.max(0, -Math.cos(th));
      _q.set(out.x - HEAD_C[0], out.y - HEAD_C[1], out.z - HEAD_C[2]).normalize();
      out.addScaledVector(_q, lift);
      return out;
    },
  });

  // Locks. Each is a flattened, tapered blade following its bone chain and
  // continuing past the tail, so the cloth solver's rotation of the last bone
  // swings the whole tip.
  // Radius 0.050 and squash 0.62, not the 0.036/0.45 of the first pass: from
  // 52° above, a lock flattened into a blade presents its edge to the camera
  // and disappears. Volume is what makes the crown read as spiked hair rather
  // than as a smooth helmet.
  const locks = [
    ['hairBLa', 'hairBLb', 1.0], ['hairBCa', 'hairBCb', 1.22], ['hairBRa', 'hairBRb', 1.0],
  ];
  for (const [a, b, scale] of locks) {
    const h0 = rig.head(a, new THREE.Vector3());
    const h1 = rig.head(b, new THREE.Vector3());
    const h2 = rig.tail(b, new THREE.Vector3());
    const dir = new THREE.Vector3().subVectors(h2, h1).normalize();
    B.hair.tube({
      path: [
        [h0.x, h0.y - 0.012, h0.z + 0.014],
        [h1.x, h1.y + 0.008, h1.z],
        [h2.x, h2.y + 0.006, h2.z],
        [h2.x + dir.x * 0.070 * scale, h2.y + dir.y * 0.070 * scale - 0.010, h2.z + dir.z * 0.070 * scale],
      ],
      radius: (t) => 0.050 * Math.pow(1 - t, 0.72) + 0.0015,
      radial: 7,
      squash: () => 0.62,
      capStart: true,
    });
  }

  // Fringe: two locks falling across the brow. They break the forehead's
  // silhouette, which is what keeps the head from reading as an egg.
  for (const n of ['hairFL', 'hairFR']) {
    const h0 = rig.head(n, new THREE.Vector3());
    const h1 = rig.tail(n, new THREE.Vector3());
    B.hair.tube({
      path: [
        [h0.x, h0.y + 0.006, h0.z - 0.010],
        [lerp(h0.x, h1.x, 0.5), lerp(h0.y, h1.y, 0.5) + 0.004, lerp(h0.z, h1.z, 0.5)],
        [h1.x, h1.y, h1.z],
        [h1.x * 1.18, h1.y - 0.045, h1.z + 0.012],
      ],
      radius: (t) => 0.030 * Math.pow(1 - t, 0.8) + 0.001,
      radial: 6,
      squash: () => 0.40,
      capStart: true,
    });
  }

  // Two extra static spikes bound straight to the head, filling the gap
  // between the dynamic locks. They do not move, which is correct: the hair
  // closest to the scalp should not.
  for (const s of [1, -1]) {
    for (const [uu, vv, up, out] of [[0.62, 0.20, 0.030, 0.048], [0.70, 0.34, 0.006, 0.062]]) {
      const base = headPoint(s > 0 ? uu : 1 - uu, vv, new THREE.Vector3());
      B.hair.tube({
        path: [
          [base.x, base.y, base.z],
          [base.x + s * out * 0.6, base.y + up, base.z - 0.058],
          [base.x + s * out, base.y + up * 0.5, base.z - 0.122],
        ],
        radius: (t) => 0.038 * Math.pow(1 - t, 0.68) + 0.001,
        radial: 6,
        squash: () => 0.58,
        capStart: true,
      });
    }
  }
}

// ===========================================================================

function lerp(a, b, t) { return a + (b - a) * t; }
