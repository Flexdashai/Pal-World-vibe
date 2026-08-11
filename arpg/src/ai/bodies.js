import * as THREE from 'three';
import { SkinBuilder, superEllipse, curve, limb } from './meshkit.js';

/**
 * MONARCH — the enemy bodies.
 *
 * ONE RULE GOVERNS THIS FILE. The camera is 21 m away at −52°, which is about
 * 120 px of character height at 720p. The viewer reads SHAPE, not detail. So
 * every archetype here is designed as a solid black outline first, and the
 * acceptance test is the `silhouette` string in `tuning.js`: render the body as
 * a black shape and check the description survives. If two archetypes share an
 * outline, one of them is wrong.
 *
 * The six outlines, and the single lever that produces each:
 *
 *   ghoul    deep hunch + arms 0.55 of height    → a forward hook
 *   knight   shoulder half-width 0.152 of height → a wide upright rectangle
 *   beast    quadruped, wider than tall          → a horizontal arch
 *   caster   no legs under a floor-length hem    → a tall narrow flame
 *   brute    shoulder half-width 0.205 + short legs → an inverted triangle
 *   boss     5.2 m, four arms, a crown of ribs   → a mountain with a lit hole
 *
 * ---------------------------------------------------------------------------
 * THREE PARTS PER BODY, NEVER MORE
 *
 * `body`  the primary material (bone / plate / flesh / cloth / stone)
 * `gear`  the secondary material — the material separation ARCHITECTURE.md
 *         demands, because one roughness across a whole character reads as
 *         plastic
 * `glow`  eyes and rune seams. Tiny (under 200 triangles) and emissive, and it
 *         is the part that survives at 40 px when nothing else does.
 *
 * Three parts × forty actors is 120 draws, which is what the budget allows on
 * this rasteriser. A fourth part per archetype would be another forty.
 *
 * ---------------------------------------------------------------------------
 * PER-INSTANCE VARIATION
 *
 * Geometry is SHARED between every actor of an archetype, so variation cannot
 * come from the mesh. It comes from three places instead, all applied at spawn:
 * a per-actor uniform scale (±8%), a per-actor tint, and a per-actor animation
 * phase offset. Twenty identical skeletons is a tell; twenty skeletons at
 * different heights, values and stride phases is a horde.
 */

/** Material slot names. `materials.js` in this directory owns what they map to. */
export const SLOTS = ['body', 'gear', 'glow'];

/* ==========================================================================
 * shared construction helpers
 * ========================================================================== */

/**
 * A torso swept along the spine chain with a superelliptic cross-section.
 *
 * `ribs` modulates the radius with a sawtooth so a ribcage reads as separate
 * bones. `squash` flattens it front-to-back — a cylindrical torso is the single
 * most obvious generated-character tell there is.
 */
function torso(B, rig, bones, o = {}) {
  const path = [];
  for (let i = 0; i < bones.length; i++) {
    if (!rig.has(bones[i])) continue;
    path.push(rig.headOf(bones[i]));
  }
  const last = bones[bones.length - 1];
  if (rig.has(last)) path.push(rig.tailOf(last));
  if (path.length < 2) return null;

  const prof = o.profile ?? [0.72, 0.95, 1.0, 0.92, 0.78];
  const ribs = o.ribs ?? 0;
  return B.tube({
    path, radial: o.radial ?? 10, capStart: true, capEnd: true,
    squash: o.squash ?? ((t) => 0.62 + 0.10 * Math.sin(t * Math.PI)),
    radius: (t) => {
      let r = o.radius * curve(prof, t);
      if (ribs > 0) {
        // Six ribs over the chest region only, never over the pelvis.
        const band = Math.max(0, Math.sin(t * Math.PI * 6.5));
        const region = Math.max(0, Math.min(1, (t - 0.25) * 2.4));
        r *= 1 + ribs * band * region;
      }
      return r;
    },
    roll: o.roll,
  });
}

/**
 * A skull. Cranium + brow ridge + a receding jaw, built as one revolved patch
 * with a profile that pinches at the muzzle. Two hollows are cut for the eyes by
 * the `glow` part, which sits INSIDE the skull — an emissive quad recessed 2 cm
 * behind the socket rim reads as a light in a hole rather than as a sticker.
 */
function skull(B, rig, o = {}) {
  const c = rig.midOf('head', o.at ?? 0.42);
  const R = o.radius;
  const jut = o.jut ?? 1.25;      // muzzle projection, multiples of R
  const flat = o.flat ?? 0.86;    // cranium width/height
  return B.patch({
    rows: 9, cols: 12, closeU: true,
    fn: (u, v, out) => {
      const a = u * Math.PI * 2;
      const th = v * Math.PI;
      const sy = Math.cos(th);
      const sr = Math.sin(th);
      // Superellipse in the horizontal plane: a skull is a rounded box, not a
      // ball. n rises toward the crown so the top is boxier than the jaw.
      const n = 2.2 + (1 - v) * 1.6;
      const k = superEllipse(a, n);
      // Forward projection: a snout grows toward +Z on the lower half only.
      const fwd = Math.max(0, Math.cos(a)) * Math.max(0, (v - 0.34)) * jut;
      // Brow ridge: a hard step at the eye line, the feature the eye reads.
      const brow = v > 0.30 && v < 0.42 ? 0.10 : 0;
      out.set(
        c[0] + Math.sin(a) * sr * R * k * flat,
        c[1] + sy * R * (1 + brow),
        c[2] + Math.cos(a) * sr * R * k * (1 + fwd) + (o.push ?? 0)
      );
    },
  });
}

/** Two emissive eye discs, recessed into the socket so they read as lit holes. */
function eyes(G, rig, o = {}) {
  const c = rig.midOf('head', o.at ?? 0.46);
  const R = o.radius ?? 0.05;
  const sep = o.sep ?? 0.058;
  const fwd = o.fwd ?? 0.075;
  const lift = o.lift ?? 0.012;
  for (const s of [1, -1]) {
    const cx = c[0] + s * sep, cy = c[1] + lift, cz = c[2] + fwd;
    G.patch({
      rows: 1, cols: 7, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const r = R * (v * 0.55 + 0.45) * (v < 0.5 ? 0 : 1);
        // A cone, not a disc: the apex sits 2 cm behind the face plane so the
        // eye still catches light when the head turns away from the camera.
        out.set(cx + Math.cos(a) * r * 1.25, cy + Math.sin(a) * r,
          cz - (1 - v) * R * 1.6);
      },
    });
  }
}

/** A clawed hand: a small palm plate plus three tapered claws. */
function claws(B, rig, boneName, o = {}) {
  const a = rig.headOf(boneName);
  const b = rig.tailOf(boneName);
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / l, uy = dy / l, uz = dz / l;
  B.tube({
    path: [a, [a[0] + ux * l * 0.6, a[1] + uy * l * 0.6, a[2] + uz * l * 0.6]],
    radial: 6, radius: (t) => o.palm * (1 - t * 0.22), capStart: true, capEnd: true,
    squash: () => 0.58,
  });
  const n = o.count ?? 3;
  for (let i = 0; i < n; i++) {
    const spread = (i / (n - 1) - 0.5) * (o.spread ?? 0.10);
    B.spike({
      from: [a[0] + ux * l * 0.55 + spread, a[1] + uy * l * 0.55, a[2] + uz * l * 0.55 + spread * 0.4],
      dir: [ux + spread * 2.2, uy, uz + 0.22],
      length: o.claw, radius: o.clawR ?? 0.022, curve: o.curl ?? 0.35,
      segments: 4, radial: 4, sharpness: 1.1,
    });
  }
}

/** A limb pair, mirrored. `fn(side, L)` is called with +1/'L' and −1/'R'. */
function pair(fn) { fn(1, 'L'); fn(-1, 'R'); }

/* ==========================================================================
 * GHOUL — a forward hook
 * ========================================================================== */
function buildGhoul(rig, arch, seed) {
  const B = new SkinBuilder(rig, 'ghoul.body');
  const G = new SkinBuilder(rig, 'ghoul.gear');
  const E = new SkinBuilder(rig, 'ghoul.glow');
  const H = arch.height;

  // ---- torso: emaciated, ribs showing, shoulders collapsed forward ---------
  B.bindTo(['pelvis', 'spine', 'chest', 'neck'], 2.6).setWarp(0.006, seed + 1);
  torso(B, rig, ['pelvis', 'spine', 'chest'], {
    // Thicker than the first build. At 46 px of screen height a 0.38 m torso on
    // 0.06 m limbs read as an insect rather than as a body; the mass has to be
    // visible in the middle of the silhouette or the outline is all limb.
    radius: H * 0.132, ribs: 0.16, radial: 10,
    profile: [0.80, 0.90, 1.0, 0.88, 0.64],
    squash: (t) => 0.60 + 0.14 * Math.sin(t * Math.PI),
  });
  // A collapsed shoulder — the asymmetry that stops a row of ghouls reading as
  // one mesh repeated. The right side keeps a stub of clavicle bone, the left
  // has lost it, so one shoulder hangs 4 cm lower in every pose.
  B.bindTo(['chest', 'clavR', 'armR'], 3.2);
  B.plate({
    centre: rig.midOf('clavR', 0.7), halfX: H * 0.05, halfY: H * 0.036,
    ex: new THREE.Vector3(0, 0, 1), ey: new THREE.Vector3(-0.4, 1, 0).normalize(),
    bulge: 0.03, thickness: 0.016, rows: 3, cols: 4,
  });

  // ---- head ---------------------------------------------------------------
  B.bindTo(['head', 'neck'], 4.0).setWarp(0.004, seed + 2);
  skull(B, rig, { radius: H * 0.086, jut: 1.35, flat: 0.80, at: 0.44 });
  // Two horns swept back off the temples: they widen the head's read from above,
  // which is the only angle this camera gives.
  B.rigidTo('head');
  pair((s) => {
    const c = rig.midOf('head', 0.55);
    B.spike({
      from: [c[0] + s * H * 0.042, c[1] + H * 0.026, c[2] - H * 0.012],
      dir: [s * 0.55, 0.42, -0.72], length: H * 0.14, radius: H * 0.013,
      curve: 0.30, segments: 4, radial: 4,
    });
  });

  // ---- limbs: long arms, crouched legs -------------------------------------
  B.setWarp(0.005, seed + 3);
  pair((s, L) => {
    B.bindTo([`clav${L}`, `arm${L}`, 'chest'], 3.0);
    limb(B, rig, `clav${L}`, `clav${L}`, { radius: H * 0.036, radial: 6, capStart: true });
    B.bindTo([`arm${L}`, `forearm${L}`, `clav${L}`], 3.0);
    limb(B, rig, `arm${L}`, `arm${L}`, {
      radius: H * 0.040, radial: 7, profile: [1.05, 0.95, 0.82, 0.78, 0.86],
      bow: H * 0.018, bowDir: [s * 0.4, 0, 0.9],
    });
    B.bindTo([`forearm${L}`, `hand${L}`, `arm${L}`], 3.2);
    limb(B, rig, `forearm${L}`, `forearm${L}`, {
      radius: H * 0.034, radial: 6, profile: [0.92, 0.78, 0.7, 0.72, 0.86],
    });
    B.bindTo([`hand${L}`, `forearm${L}`], 4.0);
    claws(B, rig, `hand${L}`, { palm: H * 0.026, claw: H * 0.062, curl: 0.45, clawR: H * 0.008 });
  });
  pair((s, L) => {
    B.bindTo([`thigh${L}`, 'pelvis', `shin${L}`], 3.0);
    limb(B, rig, `thigh${L}`, `thigh${L}`, {
      radius: H * 0.050, radial: 7, profile: [1.05, 1.0, 0.82, 0.72, 0.74],
      bow: H * 0.02, bowDir: [0, 0, 1],
    });
    B.bindTo([`shin${L}`, `thigh${L}`, `foot${L}`], 3.2);
    limb(B, rig, `shin${L}`, `shin${L}`, {
      radius: H * 0.038, radial: 6, profile: [0.92, 0.78, 0.66, 0.64, 0.72],
      bow: H * 0.016, bowDir: [0, 0, -1],
    });
    B.bindTo([`foot${L}`, `shin${L}`], 4.2);
    claws(B, rig, `foot${L}`, {
      palm: H * 0.028, claw: H * 0.05, curl: 0.2, count: 3, spread: 0.09, clawR: H * 0.008,
    });
  });

  // ---- rags ----------------------------------------------------------------
  G.setWarp(0.004, seed + 7);
  const ragSpecs = [
    { key: 'rag', ex: [1, 0, 0.2], span: H * 0.20, drop: H * 0.30, jag: 0.30 },
    { key: 'ragB', ex: [1, 0, -0.3], span: H * 0.18, drop: H * 0.26, jag: 0.35 },
    { key: 'flesh', ex: [1, 0, 0], span: H * 0.13, drop: H * 0.17, jag: 0.45 },
  ];
  for (const spec of ragSpecs) {
    if (!rig.has(`${spec.key}0`)) continue;
    G.bindTo([`${spec.key}*`], 2.0);
    G.rag({
      top: rig.headOf(`${spec.key}0`), ex: spec.ex, span: spec.span, drop: spec.drop,
      jag: spec.jag, sway: 0.03, seed: seed + spec.span * 100, rows: 3, cols: 4,
    });
  }
  // A loincloth across the hips, so the rag chains have something to hang from.
  G.bindTo(['pelvis', 'rag*', 'ragB*'], 2.2);
  G.rag({
    top: [0, rig.headOf('pelvis')[1] - H * 0.02, 0.02], ex: [1, 0, 0],
    span: H * 0.26, drop: H * 0.16, jag: 0.22, sway: 0.02, seed: seed + 11, rows: 2, cols: 5,
  });

  E.bindTo(['head'], 5.0);
  eyes(E, rig, { radius: H * 0.017, sep: H * 0.030, fwd: H * 0.062, at: 0.42, lift: H * 0.004 });

  return { body: B, gear: G, glow: E };
}

/* ==========================================================================
 * KNIGHT — a wide upright rectangle
 * ========================================================================== */
function buildKnight(rig, arch, seed) {
  const B = new SkinBuilder(rig, 'knight.body');
  const G = new SkinBuilder(rig, 'knight.gear');
  const E = new SkinBuilder(rig, 'knight.glow');
  const H = arch.height;

  // ---- cuirass -------------------------------------------------------------
  B.bindTo(['pelvis', 'spine', 'chest'], 4.2).setWarp(0.004, seed + 1);
  torso(B, rig, ['pelvis', 'spine', 'chest'], {
    radius: H * 0.132, radial: 12,
    profile: [0.80, 1.02, 1.05, 0.94, 0.86],
    // Plate is a rounded box in section, and the keel (a raised centre ridge) is
    // what makes a breastplate read as armour instead of as a barrel.
    squash: (t) => 0.70 + 0.06 * Math.sin(t * Math.PI),
  });
  // Fauld: overlapping skirt plates around the hips. Four bands, each a shell,
  // so the edge highlight repeats down the figure — the strongest cue that this
  // is plate and not cloth.
  B.bindTo(['pelvis', 'spine'], 4.5);
  for (let i = 0; i < 3; i++) {
    const y = rig.headOf('pelvis')[1] - H * (0.01 + i * 0.032);
    const r = H * 0.130 + i * H * 0.006;
    B.shell({
      rows: 1, cols: 14, closeU: true, thickness: 0.016, rimEdges: 'v',
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const k = superEllipse(a, 2.6);
        out.set(Math.sin(a) * r * k, y - v * H * 0.036, Math.cos(a) * r * k * 0.76);
      },
    });
  }

  // ---- great helm ----------------------------------------------------------
  // A flat-topped cylinder with a chamfered crown and a vision slit. The slit is
  // the read: a helm with no dark horizontal line is a bucket.
  B.rigidTo('head').setWarp(0.003, seed + 2);
  {
    const c = rig.midOf('head', 0.45);
    const R = H * 0.070;
    B.patch({
      rows: 8, cols: 12, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const k = superEllipse(a, 3.0);
        // Profile: straight sides, chamfered top, a slight taper to the chin.
        const t = v;
        const prof = t < 0.16 ? 0.45 + t * 3.2
          : t < 0.78 ? 1.0
            : 1.0 - (t - 0.78) * 1.5;
        const y = c[1] + R * 1.28 - t * R * 2.5;
        // Face plane pushed forward into a blunt point, so the helm has a nose.
        const fwd = Math.max(0, Math.cos(a)) * 0.20 * Math.max(0, 1 - Math.abs(t - 0.5) * 2.2);
        out.set(
          Math.sin(a) * R * k * prof * 0.94,
          y,
          c[2] + Math.cos(a) * R * k * prof * (1 + fwd)
        );
      },
    });
    // Crest: a low blade down the centre of the crown, running front to back.
    B.plate({
      centre: [c[0], c[1] + R * 1.24, c[2] - R * 0.05], halfX: R * 0.10, halfY: R * 1.05,
      ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0.15, 1).normalize(),
      bulge: R * 0.30, thickness: 0.014, rows: 3, cols: 4,
    });
  }

  // ---- pauldrons: the silhouette -------------------------------------------
  // Square, layered, and pushed OUTBOARD past the elbow line. Two lames each, so
  // there are three edge highlights per shoulder.
  pair((s, L) => {
    B.bindTo([`clav${L}`, 'chest'], 4.6);
    const sh = rig.tailOf(`clav${L}`);
    for (let i = 0; i < 2; i++) {
      B.plate({
        centre: [sh[0] + s * H * (0.012 + i * 0.020), sh[1] - H * (0.005 + i * 0.048), sh[2]],
        halfX: H * (0.070 - i * 0.006), halfY: H * (0.052 - i * 0.008),
        ex: new THREE.Vector3(0, 0, 1), ey: new THREE.Vector3(s * 0.72, -0.69, 0).normalize(),
        bulge: H * 0.030, thickness: 0.020, rows: 3, cols: 6, taper: 0.16,
      });
    }
    // A spike off the outer corner. Small, but it breaks the rectangle's top
    // edge and is what stops the shoulder reading as a cardboard box.
    B.spike({
      from: [sh[0] + s * H * 0.075, sh[1] + H * 0.004, sh[2] - H * 0.010],
      dir: [s * 0.55, 0.62, -0.55], length: H * 0.085, radius: H * 0.014,
      curve: 0.18, segments: 3, radial: 4,
    });
  });

  // ---- arms and legs -------------------------------------------------------
  B.setWarp(0.0035, seed + 3);
  pair((s, L) => {
    B.bindTo([`arm${L}`, `forearm${L}`, `clav${L}`], 4.2);
    limb(B, rig, `arm${L}`, `arm${L}`, { radius: H * 0.046, radial: 8, profile: [1, 0.94, 0.84, 0.86, 0.9] });
    B.bindTo([`forearm${L}`, `hand${L}`, `arm${L}`], 4.4);
    limb(B, rig, `forearm${L}`, `forearm${L}`, {
      radius: H * 0.042, radial: 8, profile: [0.92, 1.0, 0.86, 0.8, 0.84],
    });
    // Couter: a disc over the elbow.
    B.bindTo([`forearm${L}`, `arm${L}`], 4.8);
    B.plate({
      centre: rig.headOf(`forearm${L}`), halfX: H * 0.034, halfY: H * 0.030,
      ex: new THREE.Vector3(0, 0, 1), ey: new THREE.Vector3(s, 0, 0),
      bulge: H * 0.020, thickness: 0.014, rows: 2, cols: 5,
    });
    B.bindTo([`hand${L}`, `forearm${L}`], 5.0);
    limb(B, rig, `hand${L}`, `hand${L}`, {
      radius: H * 0.034, radial: 6, capStart: true, capEnd: true, profile: [1, 0.95, 0.8, 0.7, 0.6],
    });
  });
  pair((s, L) => {
    B.bindTo([`thigh${L}`, 'pelvis', `shin${L}`], 4.0);
    limb(B, rig, `thigh${L}`, `thigh${L}`, { radius: H * 0.058, radial: 8, profile: [1.05, 1.0, 0.88, 0.78, 0.76] });
    B.bindTo([`shin${L}`, `thigh${L}`, `foot${L}`], 4.2);
    limb(B, rig, `shin${L}`, `shin${L}`, { radius: H * 0.046, radial: 8, profile: [0.9, 0.92, 0.74, 0.66, 0.7] });
    B.bindTo([`shin${L}`, `thigh${L}`], 4.8);
    B.plate({
      centre: rig.headOf(`shin${L}`), halfX: H * 0.036, halfY: H * 0.030,
      ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0.3, 1).normalize(),
      bulge: H * 0.018, thickness: 0.013, rows: 2, cols: 5,
    });
    B.bindTo([`foot${L}`, `shin${L}`], 5.0);
    // Sabaton: a wedge, pointed. A rounded foot reads as a slipper.
    const f0 = rig.headOf(`foot${L}`), f1 = rig.tailOf(`foot${L}`);
    B.tube({
      path: [f0, [(f0[0] + f1[0]) * 0.5, f1[1] + H * 0.008, (f0[2] + f1[2]) * 0.5], f1],
      radial: 6, capStart: true, capEnd: true, squash: () => 0.62,
      radius: (t) => H * 0.040 * (1 - t * 0.62),
    });
  });

  // ---- the sword and the tower shield --------------------------------------
  // Both go in `body` because both are steel; the material separation the eye
  // needs is against the tabard, which is cloth and lives in `gear`.
  B.rigidTo('handR').setWarp(0, 0);
  {
    const h = rig.tailOf('handR');
    const bladeLen = H * 0.62, guard = H * 0.115;
    // Grip + pommel, running back up the forearm.
    B.tube({
      path: [[h[0], h[1] + H * 0.10, h[2] + H * 0.02], [h[0], h[1] - H * 0.02, h[2] + H * 0.02]],
      radial: 5, radius: () => H * 0.011, capStart: true, capEnd: true,
    });
    B.plate({
      centre: [h[0], h[1] + H * 0.005, h[2] + H * 0.02], halfX: guard * 0.5, halfY: H * 0.012,
      ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0, 1),
      bulge: H * 0.006, thickness: 0.018, rows: 1, cols: 4,
    });
    // The blade: a long shallow diamond. Held VERTICAL in bind pose so the
    // silhouette gets its one strong vertical line.
    B.patch({
      rows: 6, cols: 4, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const t = v;
        const w = H * 0.030 * (1 - Math.pow(t, 2.6)) + 0.002;
        const th = H * 0.007 * (1 - t * 0.5);
        out.set(h[0] + Math.sin(a) * w, h[1] - H * 0.02 - t * bladeLen, h[2] + H * 0.02 + Math.cos(a) * th);
      },
    });
  }
  B.rigidTo('handL');
  {
    const h = rig.tailOf('handL');
    // A kite-topped tower shield: flat top, tapering to a point, curved in
    // section. It fills the left half of the silhouette, which is the read.
    B.shell({
      rows: 6, cols: 5, thickness: 0.030, rimEdges: 'all',
      fn: (u, v, out) => {
        const sx = (u - 0.5) * 2;
        const taper = 1 - Math.pow(v, 2.2) * 0.86;
        const bow = (1 - sx * sx) * H * 0.045;
        out.set(
          h[0] - H * 0.05 + sx * H * 0.155 * taper,
          h[1] + H * 0.30 - v * H * 0.62,
          h[2] + H * 0.11 + bow
        );
      },
    });
  }

  // ---- tabard and cape (cloth) --------------------------------------------
  G.setWarp(0.004, seed + 8);
  if (rig.has('tabard0')) {
    G.bindTo(['tabard*', 'pelvis'], 2.1);
    G.rag({
      top: rig.headOf('tabard0'), ex: [1, 0, 0], span: H * 0.20, drop: H * 0.36,
      jag: 0.16, sway: 0.02, seed: seed + 4, rows: 4, cols: 4,
    });
  }
  if (rig.has('cape0')) {
    G.bindTo(['cape*', 'chest'], 1.9);
    G.rag({
      top: rig.headOf('cape0'), ex: [1, 0, 0], span: H * 0.30, drop: H * 0.62,
      jag: 0.26, sway: 0.05, seed: seed + 5, rows: 5, cols: 5,
    });
  }

  // ---- glow: the vision slit and a shield rune ----------------------------
  E.rigidTo('head');
  {
    const c = rig.midOf('head', 0.45);
    const R = H * 0.070;
    E.patch({
      rows: 1, cols: 6,
      fn: (u, v, out) => {
        out.set(
          c[0] + (u - 0.5) * R * 1.30,
          c[1] + R * 0.30 - v * R * 0.16,
          c[2] + R * 1.02 - Math.abs(u - 0.5) * R * 0.55
        );
      },
    });
  }
  E.rigidTo('handL');
  {
    const h = rig.tailOf('handL');
    // A ring sigil on the shield boss. Kept small: the shield is a big flat
    // plane and a large glowing shape on it out-reads the whole character.
    E.patch({
      rows: 1, cols: 12, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const r = H * (0.030 + v * 0.014);
        out.set(h[0] - H * 0.05 + Math.cos(a) * r, h[1] + H * 0.09 + Math.sin(a) * r, h[2] + H * 0.157);
      },
    });
  }
  return { body: B, gear: G, glow: E };
}

/* ==========================================================================
 * BEAST — a horizontal arch
 * ========================================================================== */
function buildBeast(rig, arch, seed) {
  const B = new SkinBuilder(rig, 'beast.body');
  const G = new SkinBuilder(rig, 'beast.gear');
  const E = new SkinBuilder(rig, 'beast.glow');
  const H = arch.height;

  B.bindTo(['pelvis', 'spineA', 'spineB', 'chest', 'neck'], 2.8).setWarp(0.006, seed + 1);
  torso(B, rig, ['pelvis', 'spineA', 'spineB', 'chest'], {
    // 0.26, not 0.20. At 2.35 m long and 0.42 m thick the Stalker photographed
    // as a lizard; a predator's chest is deep, and the depth is what carries
    // the "this thing has mass" read at 40 px.
    radius: H * 0.26, radial: 10,
    // Narrow hips, deep chest: a predator's mass is at the front.
    profile: [0.72, 0.80, 0.94, 1.10, 0.96],
    squash: () => 0.86,
  });
  B.bindTo(['neck', 'chest', 'head'], 3.0);
  limb(B, rig, 'neck', 'neck', { radius: H * 0.140, radial: 8, profile: [1.0, 0.94, 0.86, 0.82, 0.9] });

  // ---- head: long, low, jawed ---------------------------------------------
  B.bindTo(['head', 'neck'], 4.0).setWarp(0.004, seed + 2);
  skull(B, rig, { radius: H * 0.125, jut: 1.9, flat: 0.72, at: 0.40 });
  // The lower jaw, hinged open a few degrees in bind pose so there is always a
  // dark line under the muzzle.
  B.rigidTo('head');
  {
    const c = rig.midOf('head', 0.42);
    const R = H * 0.125;
    B.tube({
      path: [
        [c[0], c[1] - R * 0.42, c[2] + R * 0.10],
        [c[0], c[1] - R * 0.56, c[2] + R * 1.55],
        [c[0], c[1] - R * 0.60, c[2] + R * 2.15],
      ],
      radial: 6, capStart: true, capEnd: true, squash: () => 0.55,
      radius: (t) => R * (0.36 - t * 0.20),
    });
  }

  // ---- legs: digitigrade, four of them -------------------------------------
  B.setWarp(0.005, seed + 3);
  for (const k of ['f', 'h']) {
    pair((s, L) => {
      const thick = k === 'f' ? 0.062 : 0.076;
      B.bindTo([`${k}LegA${L}`, k === 'f' ? 'chest' : 'pelvis', `${k}LegB${L}`], 3.0);
      limb(B, rig, `${k}LegA${L}`, `${k}LegA${L}`, {
        radius: H * thick, radial: 7, profile: [1.1, 1.0, 0.82, 0.68, 0.66],
      });
      B.bindTo([`${k}LegB${L}`, `${k}LegA${L}`, `${k}Foot${L}`], 3.2);
      limb(B, rig, `${k}LegB${L}`, `${k}LegB${L}`, {
        radius: H * thick * 0.72, radial: 6, profile: [0.9, 0.72, 0.6, 0.58, 0.66],
      });
      B.bindTo([`${k}Foot${L}`, `${k}LegB${L}`], 4.2);
      claws(B, rig, `${k}Foot${L}`, {
        palm: H * 0.052, claw: H * 0.075, curl: 0.5, count: 3, spread: 0.10, clawR: H * 0.013,
      });
    });
  }

  // ---- tail ----------------------------------------------------------------
  B.bindTo(['tail*', 'pelvis'], 2.4);
  {
    const path = [];
    for (let i = 0; rig.has(`tail${i}`); i++) path.push(rig.headOf(`tail${i}`));
    const last = path.length - 1;
    if (last >= 0) path.push(rig.tailOf(`tail${last}`));
    if (path.length > 1) {
      B.tube({
        path, radial: 6, capStart: true, capEnd: true, squash: () => 0.85,
        radius: (t) => H * 0.075 * Math.pow(1 - t, 1.35) + 0.006,
      });
    }
  }

  // ---- gear: the exposed spine plates and shoulder blades (bone) -----------
  G.setWarp(0.004, seed + 6);
  {
    // Nine dorsal plates rising along the arch, tallest over the shoulders.
    // This is the feature that makes the arch read from a top-down camera.
    const spineBones = ['pelvis', 'spineA', 'spineB', 'chest'];
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const bi = Math.min(spineBones.length - 1, Math.floor(t * spineBones.length));
      const bone = spineBones[bi];
      const local = (t * spineBones.length) - bi;
      const p = rig.midOf(bone, Math.min(1, local));
      const height = H * (0.10 + 0.16 * Math.sin(Math.PI * Math.min(1, t * 1.25)));
      G.bindTo([bone, spineBones[Math.min(spineBones.length - 1, bi + 1)]], 3.0);
      G.plate({
        centre: [p[0], p[1] + H * 0.15 + height * 0.4, p[2]],
        halfX: H * 0.014, halfY: height * 0.5,
        ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0.94, -0.34).normalize(),
        bulge: H * 0.012, thickness: 0.014, rows: 2, cols: 3, taper: 0.35,
      });
    }
  }
  // Skull plate over the cranium, so the head has hard geometry over soft.
  G.rigidTo('head');
  {
    const c = rig.midOf('head', 0.46);
    G.plate({
      centre: [c[0], c[1] + H * 0.10, c[2] + H * 0.02], halfX: H * 0.085, halfY: H * 0.10,
      ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0.3, 1).normalize(),
      bulge: H * 0.030, thickness: 0.016, rows: 3, cols: 5, taper: 0.25,
    });
    pair((s) => {
      G.spike({
        from: [c[0] + s * H * 0.070, c[1] + H * 0.09, c[2] - H * 0.03],
        dir: [s * 0.42, 0.34, -0.84], length: H * 0.22, radius: H * 0.020,
        curve: 0.28, segments: 4, radial: 4,
      });
    });
  }

  E.bindTo(['head'], 5.0);
  eyes(E, rig, { radius: H * 0.026, sep: H * 0.058, fwd: H * 0.135, at: 0.40, lift: H * 0.028 });
  return { body: B, gear: G, glow: E };
}

/* ==========================================================================
 * CASTER — a tall narrow flame
 * ========================================================================== */
function buildCaster(rig, arch, seed) {
  const B = new SkinBuilder(rig, 'caster.body');
  const G = new SkinBuilder(rig, 'caster.gear');
  const E = new SkinBuilder(rig, 'caster.glow');
  const H = arch.height;

  // ---- the robe IS the body ------------------------------------------------
  // One continuous surface from the shoulders to the floor with no waist and no
  // legs. The hem is 4 cm above the ground in bind pose so the figure appears to
  // hover, which is the read.
  B.bindTo(['pelvis', 'spine', 'chest', 'robeF*', 'robeB*'], 2.0).setWarp(0.006, seed + 1);
  {
    const shoulderY = rig.headOf('chest')[1] + H * 0.055;
    B.patch({
      rows: 10, cols: 14, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        // Radius grows from the shoulders to a wide skirt, then pulls in at the
        // very bottom so the hem reads as fabric gathering, not as a cone.
        const t = v;
        const r = H * (0.088 + 0.135 * Math.pow(t, 1.7) - 0.035 * Math.pow(t, 9));
        const k = superEllipse(a, 2.3);
        // Vertical folds. Six of them, deeper toward the hem.
        const fold = 1 + 0.055 * Math.sin(a * 6 + t * 1.4) * t;
        out.set(
          Math.sin(a) * r * k * fold,
          shoulderY - t * (shoulderY - H * 0.022),
          Math.cos(a) * r * k * fold * 0.86 + t * t * H * 0.02
        );
      },
    });
  }
  // ---- the hood ------------------------------------------------------------
  // High, pointed, and EMPTY: the cowl overhangs the face so the eyes sit in a
  // shadow. Nothing else in the game has a pointed head.
  B.bindTo(['head', 'neck', 'chest'], 3.0);
  {
    const c = rig.midOf('head', 0.35);
    const R = H * 0.070;
    B.patch({
      rows: 9, cols: 12, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const t = v;
        // A teardrop: pointed at the crown, flaring to the shoulders, with the
        // front edge cut back to open the cowl.
        const flare = 0.35 + 2.05 * Math.pow(t, 1.5);
        const open = Math.max(0, Math.cos(a)) * Math.max(0, 0.55 - t) * 2.4;
        const k = superEllipse(a, 2.1);
        out.set(
          Math.sin(a) * R * flare * k,
          c[1] + R * 1.55 - t * R * 2.9,
          c[2] + Math.cos(a) * R * flare * k * 0.9 - open * R * 0.9 - R * 0.08
        );
      },
    });
    // A face-plate deep inside the hood: a flat oval that catches the eye glow
    // and stops the cowl reading as a hole in the mesh.
    B.rigidTo('head');
    B.plate({
      centre: [c[0], c[1] + R * 0.10, c[2] - R * 0.12], halfX: R * 0.42, halfY: R * 0.58,
      ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 1, 0),
      bulge: R * 0.18, thickness: 0.012, rows: 2, cols: 4,
    });
  }
  // ---- sleeves: the arms are cloth tubes with skeletal hands ---------------
  B.setWarp(0.005, seed + 3);
  pair((s, L) => {
    B.bindTo([`arm${L}`, `forearm${L}`, 'chest', `clav${L}`], 2.6);
    limb(B, rig, `arm${L}`, `arm${L}`, {
      radius: H * 0.040, radial: 7, profile: [1.15, 1.0, 0.86, 0.82, 0.9],
    });
    B.bindTo([`forearm${L}`, `hand${L}`, `sleeve${L}0`, `sleeve${L}1`], 2.4);
    limb(B, rig, `forearm${L}`, `forearm${L}`, {
      radius: H * 0.046, radial: 7, profile: [0.92, 1.0, 1.12, 1.24, 1.3],
    });
  });

  // ---- gear: staff, hands, censer (bone) ----------------------------------
  G.setWarp(0.003, seed + 5);
  pair((s, L) => {
    G.bindTo([`hand${L}`, `forearm${L}`], 4.5);
    claws(G, rig, `hand${L}`, {
      palm: H * 0.019, claw: H * 0.040, curl: 0.55, count: 3, spread: 0.07, clawR: H * 0.006,
    });
  });
  G.rigidTo('handR').setWarp(0, 0);
  {
    // A bent staff, held across the body and taller than the caster. The bend is
    // deliberate: a straight pole reads as a primitive.
    const h = rig.tailOf('handR');
    const top = [h[0] - H * 0.10, h[1] + H * 0.72, h[2] + H * 0.10];
    const bottom = [h[0] + H * 0.02, h[1] - H * 0.34, h[2] - H * 0.02];
    G.tube({
      path: [
        bottom,
        [h[0] + H * 0.005, h[1] + H * 0.05, h[2] + H * 0.01],
        [h[0] - H * 0.045, h[1] + H * 0.38, h[2] + H * 0.06],
        top,
      ],
      radial: 5, capStart: true, capEnd: true,
      radius: (t) => H * (0.012 + 0.006 * Math.sin(t * Math.PI * 3)),
    });
    // Three claws cradling the head of the staff.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      G.spike({
        from: [top[0] + Math.cos(a) * H * 0.012, top[1] - H * 0.03, top[2] + Math.sin(a) * H * 0.012],
        dir: [Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55],
        length: H * 0.075, radius: H * 0.010, curve: -0.45, segments: 4, radial: 4,
      });
    }
  }

  // ---- glow: eyes, the staff's crystal, a rune band on the hem ------------
  E.rigidTo('head');
  eyes(E, rig, { radius: H * 0.015, sep: H * 0.026, fwd: -H * 0.005, at: 0.36, lift: H * 0.006 });
  E.rigidTo('handR');
  {
    const h = rig.tailOf('handR');
    const top = [h[0] - H * 0.10, h[1] + H * 0.72, h[2] + H * 0.10];
    // The focus crystal: an octahedron. Faceted, so it reads as cut stone and
    // catches a hard specular even at this distance.
    E.patch({
      rows: 2, cols: 4, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const r = Math.sin(v * Math.PI) * H * 0.030;
        out.set(top[0] + Math.cos(a) * r, top[1] + H * 0.028 - Math.cos(v * Math.PI) * H * 0.045,
          top[2] + Math.sin(a) * r);
      },
    });
  }
  // A ring of glyph marks around the robe at knee height. Faint, but it gives
  // the tall dark shape a horizontal accent so it does not read as a monolith.
  E.bindTo(['pelvis', 'spine'], 2.2);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const y = H * 0.30;
    const r = H * 0.195;
    E.patch({
      rows: 1, cols: 2,
      fn: (u, v, out) => {
        const aa = a + (u - 0.5) * 0.13;
        out.set(Math.sin(aa) * r, y + (0.5 - v) * H * 0.05, Math.cos(aa) * r * 0.88);
      },
    });
  }
  return { body: B, gear: G, glow: E };
}

/* ==========================================================================
 * BRUTE — an inverted triangle
 * ========================================================================== */
function buildBrute(rig, arch, seed) {
  const B = new SkinBuilder(rig, 'brute.body');
  const G = new SkinBuilder(rig, 'brute.gear');
  const E = new SkinBuilder(rig, 'brute.glow');
  const H = arch.height;

  B.bindTo(['pelvis', 'spine', 'chest', 'neck'], 2.8).setWarp(0.008, seed + 1);
  torso(B, rig, ['pelvis', 'spine', 'chest'], {
    radius: H * 0.145, radial: 12,
    // Almost all the mass at the top: the profile more than doubles from hips
    // to shoulders. That single curve IS the inverted triangle.
    profile: [0.58, 0.72, 1.05, 1.30, 1.24],
    squash: (t) => 0.66 + 0.16 * t,
  });
  // The head, sunk between the shoulders and barely visible. Deliberately small
  // — a big head would flatten the triangle's apex.
  B.bindTo(['head', 'neck', 'chest'], 3.4);
  skull(B, rig, { radius: H * 0.052, jut: 1.15, flat: 0.94, at: 0.44 });

  B.setWarp(0.007, seed + 3);
  pair((s, L) => {
    // Asymmetric arms: the right is the maul arm and is 35% thicker.
    const bulk = s > 0 ? 0.058 : 0.079;
    B.bindTo([`clav${L}`, 'chest'], 3.2);
    limb(B, rig, `clav${L}`, `clav${L}`, { radius: H * (bulk + 0.012), radial: 7, capStart: true });
    B.bindTo([`arm${L}`, `forearm${L}`, `clav${L}`], 3.0);
    limb(B, rig, `arm${L}`, `arm${L}`, {
      radius: H * bulk, radial: 8, profile: [1.15, 1.05, 0.9, 0.86, 0.94],
      bow: H * 0.02, bowDir: [s * 0.6, 0, 0.8],
    });
    B.bindTo([`forearm${L}`, `hand${L}`, `arm${L}`], 3.2);
    limb(B, rig, `forearm${L}`, `forearm${L}`, {
      radius: H * bulk * 0.92, radial: 8, profile: [0.95, 1.0, 0.92, 0.84, 0.86],
    });
    B.bindTo([`hand${L}`, `forearm${L}`], 4.2);
    limb(B, rig, `hand${L}`, `hand${L}`, {
      radius: H * bulk * 0.85, radial: 6, capStart: true, capEnd: true,
      profile: [1.0, 1.05, 0.9, 0.7, 0.5],
    });
  });
  pair((s, L) => {
    B.bindTo([`thigh${L}`, 'pelvis', `shin${L}`], 3.0);
    limb(B, rig, `thigh${L}`, `thigh${L}`, {
      radius: H * 0.062, radial: 8, profile: [1.05, 1.0, 0.86, 0.76, 0.8],
      bow: H * 0.02, bowDir: [s * 0.7, 0, 0.7],
    });
    B.bindTo([`shin${L}`, `thigh${L}`, `foot${L}`], 3.2);
    limb(B, rig, `shin${L}`, `shin${L}`, { radius: H * 0.052, radial: 7, profile: [0.9, 0.86, 0.74, 0.72, 0.8] });
    B.bindTo([`foot${L}`, `shin${L}`], 4.2);
    claws(B, rig, `foot${L}`, { palm: H * 0.046, claw: H * 0.042, curl: 0.15, count: 3, spread: 0.14, clawR: H * 0.012 });
  });

  // ---- gear: shoulder spikes, chains, and the maul (metal) ----------------
  G.setWarp(0.004, seed + 6);
  pair((s, L) => {
    const sh = rig.tailOf(`clav${L}`);
    G.bindTo([`clav${L}`, 'chest'], 4.0);
    // A slab of iron bolted over each shoulder, plus three spikes. The slabs are
    // what push the shoulder line past the arms in silhouette.
    G.plate({
      centre: [sh[0] + s * H * 0.030, sh[1] + H * 0.020, sh[2]],
      halfX: H * 0.085, halfY: H * 0.055,
      ex: new THREE.Vector3(0, 0, 1), ey: new THREE.Vector3(s * 0.55, 0.84, 0).normalize(),
      bulge: H * 0.026, thickness: 0.022, rows: 3, cols: 5,
    });
    for (let i = 0; i < 3; i++) {
      const t = (i / 2 - 0.5) * 1.4;
      G.spike({
        from: [sh[0] + s * H * 0.055, sh[1] + H * 0.045, sh[2] + t * H * 0.055],
        dir: [s * 0.55, 0.80, t * 0.5], length: H * (0.075 - Math.abs(t) * 0.02),
        radius: H * 0.014, curve: 0.15, segments: 3, radial: 4,
      });
    }
  });
  if (rig.has('chain0')) {
    G.bindTo(['chain*', 'chest'], 2.6);
    let i = 0;
    while (rig.has(`chain${i}`)) {
      const a = rig.headOf(`chain${i}`), b = rig.tailOf(`chain${i}`);
      G.tube({ path: [a, b], radial: 4, radius: () => H * 0.011, capStart: true, capEnd: true });
      i++;
    }
  }
  G.rigidTo('handR').setWarp(0, 0);
  {
    // The maul. Its head is the size of the brute's own skull and, in bind pose,
    // it TOUCHES THE FLOOR — the drag is the character note.
    const h = rig.tailOf('handR');
    const headP = [h[0] + H * 0.10, H * 0.075, h[2] + H * 0.34];
    G.tube({
      path: [[h[0], h[1] + H * 0.05, h[2] + H * 0.02], headP],
      radial: 5, radius: (t) => H * (0.016 + t * 0.006), capStart: true, capEnd: false,
    });
    // A hexagonal block for the head, banded.
    G.patch({
      rows: 4, cols: 6, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const k = superEllipse(a, 4.5);
        const band = 1 + (v > 0.25 && v < 0.42 ? 0.10 : 0) + (v > 0.6 && v < 0.77 ? 0.10 : 0);
        const r = H * 0.062 * k * band;
        out.set(headP[0] + Math.sin(a) * r * 0.9,
          headP[1] + H * 0.085 - v * H * 0.19,
          headP[2] + Math.cos(a) * r);
      },
    });
  }
  if (rig.has('hide0')) {
    G.bindTo(['hide*', 'pelvis'], 2.0);
    G.rag({
      top: rig.headOf('hide0'), ex: [1, 0, 0], span: H * 0.20, drop: H * 0.24,
      jag: 0.30, sway: 0.02, seed: seed + 9, rows: 3, cols: 4,
    });
  }

  E.bindTo(['head'], 5.0);
  eyes(E, rig, { radius: H * 0.011, sep: H * 0.020, fwd: H * 0.045, at: 0.44, lift: 0 });
  return { body: B, gear: G, glow: E };
}

/* ==========================================================================
 * BOSS — a mountain with a lit hole
 * ========================================================================== */
function buildBoss(rig, arch, seed) {
  const B = new SkinBuilder(rig, 'boss.body');
  const G = new SkinBuilder(rig, 'boss.gear');
  const E = new SkinBuilder(rig, 'boss.glow');
  const H = arch.height;

  // ---- the torso: a cathedral buttress with a hole cut through it ----------
  // The chest cavity is the whole design. Everything else in this body exists to
  // frame a violet light burning inside a five-metre statue.
  B.bindTo(['pelvis', 'spine', 'chest'], 3.2).setWarp(0.012, seed + 1);
  {
    const y0 = rig.headOf('pelvis')[1];
    const y1 = rig.tailOf('chest')[1];
    B.patch({
      rows: 14, cols: 16, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const t = v;
        const y = y1 - t * (y1 - y0);
        // Wide at the shoulders, pinched at a false waist, flaring to the hips:
        // an hourglass read at 5 m tall so the mass does not read as a slab.
        // The top of the curve is deliberately heavy — a boss whose torso is
        // narrower than its arm span photographs as a spider.
        const prof = curve([1.24, 1.16, 0.92, 0.80, 0.94, 1.02], t);
        const k = superEllipse(a, 3.4);
        // The cavity: the front face is pushed IN over an elliptical region at
        // chest height. A silhouette hole would be lost against a dark room, so
        // the hole is a deep recess whose interior is lit instead.
        const cav = Math.max(0, Math.cos(a)) *
          Math.exp(-Math.pow((t - 0.24) / 0.16, 2)) *
          Math.exp(-Math.pow(Math.sin(a) / 0.55, 2));
        const r = H * 0.205 * prof * (1 - cav * 0.62);
        // Vertical masonry ribs, six of them, so the surface is not a smooth
        // blob at any distance.
        const rib = 1 + 0.035 * Math.max(0, Math.sin(a * 6));
        out.set(Math.sin(a) * r * k * rib, y, Math.cos(a) * r * k * rib * 0.86);
      },
    });
  }

  // ---- the crown of broken arch ribs --------------------------------------
  // Seven ribs off the shoulders, two of them snapped short. The crown is what
  // makes the silhouette read as a CATHEDRAL rather than as a giant.
  B.rigidTo('chest');
  {
    const c = rig.tailOf('chest');
    const broken = [2, 5];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.25;
      // Shorter and thicker than the first build: long thin ribs read as legs
      // from directly above and turned the crown into another set of limbs.
      const len = broken.includes(i) ? H * 0.115 : H * (0.215 + 0.065 * Math.cos(a));
      B.spike({
        from: [c[0] + Math.sin(a) * H * 0.17, c[1] + H * 0.02, c[2] + Math.cos(a) * H * 0.15],
        dir: [Math.sin(a) * 0.30, 1, Math.cos(a) * 0.30],
        length: len, radius: H * 0.046, curve: -0.34, segments: 5, radial: 5, sharpness: 0.55,
      });
    }
  }

  // ---- head: a helm-mask sunk into the shoulders ---------------------------
  B.bindTo(['head', 'neck'], 4.0).setWarp(0.008, seed + 2);
  {
    const c = rig.midOf('head', 0.42);
    const R = H * 0.082;
    B.patch({
      rows: 7, cols: 10, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const k = superEllipse(a, 3.8);
        const prof = curve([0.30, 0.86, 1.0, 0.94, 0.62], v);
        // A vertical blade down the face, like a helm's nasal grown to a fin.
        const fin = Math.max(0, Math.cos(a)) > 0.94 ? 0.20 : 0;
        out.set(Math.sin(a) * R * k * prof,
          c[1] + R * 1.1 - v * R * 2.3,
          c[2] + Math.cos(a) * R * k * prof * (1 + fin));
      },
    });
  }

  // ---- arms ---------------------------------------------------------------
  B.setWarp(0.009, seed + 3);
  pair((s, L) => {
    // Great arms.
    B.bindTo([`clav${L}`, 'chest'], 3.6);
    limb(B, rig, `clav${L}`, `clav${L}`, { radius: H * 0.070, radial: 8, capStart: true });
    B.bindTo([`arm${L}`, `forearm${L}`, `clav${L}`], 3.2);
    limb(B, rig, `arm${L}`, `arm${L}`, {
      radius: H * 0.062, radial: 9, profile: [1.15, 1.05, 0.88, 0.82, 0.9],
      bow: H * 0.03, bowDir: [s * 0.6, 0, 0.8],
    });
    B.bindTo([`forearm${L}`, `hand${L}`, `arm${L}`], 3.4);
    limb(B, rig, `forearm${L}`, `forearm${L}`, {
      radius: H * 0.056, radial: 9, profile: [0.95, 1.05, 1.0, 0.9, 0.86],
    });
    B.bindTo([`hand${L}`, `forearm${L}`], 4.2);
    claws(B, rig, `hand${L}`, {
      palm: H * 0.050, claw: H * 0.095, curl: 0.4, count: 4, spread: 0.22, clawR: H * 0.016,
    });
    // Vestigial arms: folded tight against the ribs, never animated far. They
    // exist to break the torso's outline with two hard diagonals.
    if (rig.has(`arm2${L}`)) {
      B.bindTo([`arm2${L}`, `forearm2${L}`, `clav2${L}`], 3.2);
      limb(B, rig, `arm2${L}`, `arm2${L}`, { radius: H * 0.030, radial: 6, profile: [1.05, 0.95, 0.8, 0.76, 0.8] });
      B.bindTo([`forearm2${L}`, `hand2${L}`, `arm2${L}`], 3.4);
      limb(B, rig, `forearm2${L}`, `forearm2${L}`, { radius: H * 0.026, radial: 6, profile: [0.9, 0.82, 0.72, 0.7, 0.74] });
      B.bindTo([`hand2${L}`, `forearm2${L}`], 4.4);
      claws(B, rig, `hand2${L}`, { palm: H * 0.022, claw: H * 0.042, curl: 0.55, count: 3, spread: 0.09, clawR: H * 0.008 });
    }
  });

  // ---- legs: buttresses ----------------------------------------------------
  pair((s, L) => {
    B.bindTo([`thigh${L}`, 'pelvis', `shin${L}`], 3.2);
    limb(B, rig, `thigh${L}`, `thigh${L}`, {
      radius: H * 0.082, radial: 9, profile: [1.1, 1.02, 0.86, 0.74, 0.72],
      bow: H * 0.035, bowDir: [s * 0.7, 0, 0.7],
    });
    B.bindTo([`shin${L}`, `thigh${L}`, `foot${L}`], 3.4);
    limb(B, rig, `shin${L}`, `shin${L}`, { radius: H * 0.068, radial: 8, profile: [0.92, 0.88, 0.76, 0.72, 0.82] });
    B.bindTo([`foot${L}`, `shin${L}`], 4.4);
    const f0 = rig.headOf(`foot${L}`), f1 = rig.tailOf(`foot${L}`);
    B.tube({
      path: [f0, [(f0[0] + f1[0]) * 0.5, f1[1] + H * 0.012, (f0[2] + f1[2]) * 0.5], f1],
      radial: 7, capStart: true, capEnd: true, squash: () => 0.72,
      radius: (t) => H * 0.062 * (1 - t * 0.45),
    });
  });

  // ---- gear: banding, the flail, the shroud (metal) -----------------------
  G.setWarp(0.004, seed + 6);
  {
    // Three iron bands clamping the torso, spaced unevenly. Uniform spacing
    // reads as a decorative pattern; uneven spacing reads as repair work.
    const y0 = rig.headOf('pelvis')[1], y1 = rig.tailOf('chest')[1];
    for (const t of [0.18, 0.46, 0.78]) {
      const y = y0 + (y1 - y0) * t;
      const prof = curve([1.24, 1.16, 0.92, 0.80, 0.94, 1.02], 1 - t);
      G.bindTo(['chest', 'spine', 'pelvis'], 3.0);
      G.shell({
        rows: 1, cols: 16, closeU: true, thickness: 0.030, rimEdges: 'v',
        fn: (u, v, out) => {
          const a = u * Math.PI * 2;
          const k = superEllipse(a, 3.4);
          const r = H * 0.213 * prof;
          out.set(Math.sin(a) * r * k, y + (0.5 - v) * H * 0.030, Math.cos(a) * r * k * 0.86);
        },
      });
    }
  }
  if (rig.has('flail0')) {
    G.bindTo(['flail*', 'handL'], 2.4);
    let i = 0;
    while (rig.has(`flail${i}`)) {
      const a = rig.headOf(`flail${i}`), b = rig.tailOf(`flail${i}`);
      G.tube({ path: [a, b], radial: 5, radius: () => H * 0.017, capStart: true, capEnd: true });
      i++;
    }
    // The head of the flail: a spiked ball on the last link. Heavy enough that
    // the chain's swing reads as mass.
    const last = i - 1;
    const p = rig.tailOf(`flail${last}`);
    G.bindTo([`flail${last}`], 5.0);
    G.patch({
      rows: 4, cols: 6, closeU: true,
      fn: (u, v, out) => {
        const aa = u * Math.PI * 2;
        const th = v * Math.PI;
        const r = H * 0.055;
        out.set(p[0] + Math.sin(aa) * Math.sin(th) * r, p[1] - Math.cos(th) * r,
          p[2] + Math.cos(aa) * Math.sin(th) * r);
      },
    });
    for (let s = 0; s < 6; s++) {
      const aa = (s / 6) * Math.PI * 2;
      const el = s % 2 ? 0.5 : -0.35;
      G.spike({
        from: [p[0] + Math.sin(aa) * H * 0.045, p[1] + el * H * 0.045, p[2] + Math.cos(aa) * H * 0.045],
        dir: [Math.sin(aa), el, Math.cos(aa)], length: H * 0.045, radius: H * 0.012,
        segments: 3, radial: 4,
      });
    }
  }
  if (rig.has('shroud0')) {
    G.bindTo(['shroud*', 'pelvis'], 1.9);
    G.rag({
      top: rig.headOf('shroud0'), ex: [1, 0, 0], span: H * 0.34, drop: H * 0.34,
      jag: 0.28, sway: 0.06, seed: seed + 12, rows: 5, cols: 6,
    });
  }

  // ---- glow: THE CORE, the eyes, and the seams ---------------------------
  // The core is a sphere set deep inside the chest recess. It is the single
  // brightest object on any enemy in the game and the boss's whole read at
  // distance: a violet hole in a mountain.
  E.bindTo(['chest', 'spine'], 3.0);
  {
    const y0 = rig.headOf('pelvis')[1], y1 = rig.tailOf('chest')[1];
    const cy = y1 - 0.24 * (y1 - y0);
    E.patch({
      rows: 6, cols: 10, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const th = v * Math.PI;
        const r = H * 0.062;
        out.set(Math.sin(a) * Math.sin(th) * r, cy - Math.cos(th) * r,
          H * 0.055 + Math.cos(a) * Math.sin(th) * r * 0.8);
      },
    });
    // Four seams radiating from the cavity, like cracks letting the light out.
    for (let i = 0; i < 4; i++) {
      const a0 = (i / 4) * Math.PI * 2 + 0.6;
      E.patch({
        rows: 4, cols: 1,
        fn: (u, v, out) => {
          const spread = (u - 0.5) * H * 0.016;
          const t = v;
          const a = a0 * 0.25 + t * 0.9 * Math.cos(a0);
          const rr = H * 0.16 + t * H * 0.02;
          out.set(Math.sin(a) * rr + spread, cy + Math.sin(a0) * t * H * 0.42,
            Math.cos(a) * rr * 0.86);
        },
      });
    }
  }
  E.rigidTo('head');
  eyes(E, rig, { radius: H * 0.020, sep: H * 0.034, fwd: H * 0.070, at: 0.40, lift: H * 0.004 });
  return { body: B, gear: G, glow: E };
}

/* ==========================================================================
 * SHADE — the default shadow soldier body
 * ========================================================================== */
function buildShade(rig, arch, seed) {
  const B = new SkinBuilder(rig, 'shade.body');
  const G = new SkinBuilder(rig, 'shade.gear');
  const E = new SkinBuilder(rig, 'shade.glow');
  const H = arch.height;

  B.bindTo(['pelvis', 'spine', 'chest', 'neck'], 3.0).setWarp(0.005, seed + 1);
  torso(B, rig, ['pelvis', 'spine', 'chest'], {
    radius: H * 0.118, radial: 10, profile: [0.78, 0.92, 1.0, 0.94, 0.80],
    squash: (t) => 0.62 + 0.10 * Math.sin(t * Math.PI),
  });
  B.bindTo(['head', 'neck'], 4.0);
  // A featureless helm-head. A shadow soldier is an ANONYMOUS thing; giving it a
  // face makes it a character, and the army has to read as an army.
  {
    const c = rig.midOf('head', 0.42);
    const R = H * 0.068;
    B.patch({
      rows: 7, cols: 10, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const k = superEllipse(a, 2.8);
        const prof = curve([0.35, 0.92, 1.0, 0.88, 0.5], v);
        const point = Math.max(0, Math.cos(a)) * Math.max(0, 0.5 - v) * 0.9;
        out.set(Math.sin(a) * R * k * prof, c[1] + R * 1.1 - v * R * 2.2,
          c[2] + Math.cos(a) * R * k * prof * (1 + point));
      },
    });
    pair((s) => {
      B.spike({
        from: [c[0] + s * R * 0.55, c[1] + R * 0.55, c[2] - R * 0.30],
        dir: [s * 0.42, 0.72, -0.55], length: H * 0.10, radius: H * 0.010,
        curve: 0.22, segments: 3, radial: 4,
      });
    });
  }
  B.setWarp(0.004, seed + 3);
  pair((s, L) => {
    B.bindTo([`clav${L}`, 'chest'], 3.4);
    limb(B, rig, `clav${L}`, `clav${L}`, { radius: H * 0.040, radial: 6, capStart: true });
    B.bindTo([`arm${L}`, `forearm${L}`, `clav${L}`], 3.2);
    limb(B, rig, `arm${L}`, `arm${L}`, { radius: H * 0.038, radial: 7, profile: [1.05, 0.98, 0.86, 0.82, 0.88] });
    B.bindTo([`forearm${L}`, `hand${L}`, `arm${L}`], 3.4);
    limb(B, rig, `forearm${L}`, `forearm${L}`, { radius: H * 0.032, radial: 6, profile: [0.9, 0.86, 0.76, 0.74, 0.82] });
    B.bindTo([`hand${L}`, `forearm${L}`], 4.4);
    claws(B, rig, `hand${L}`, { palm: H * 0.026, claw: H * 0.040, curl: 0.35, clawR: H * 0.007 });
  });
  pair((s, L) => {
    B.bindTo([`thigh${L}`, 'pelvis', `shin${L}`], 3.2);
    limb(B, rig, `thigh${L}`, `thigh${L}`, { radius: H * 0.048, radial: 7, profile: [1.05, 1.0, 0.86, 0.76, 0.76] });
    B.bindTo([`shin${L}`, `thigh${L}`, `foot${L}`], 3.4);
    limb(B, rig, `shin${L}`, `shin${L}`, { radius: H * 0.038, radial: 6, profile: [0.9, 0.84, 0.7, 0.68, 0.76] });
    B.bindTo([`foot${L}`, `shin${L}`], 4.4);
    const f0 = rig.headOf(`foot${L}`), f1 = rig.tailOf(`foot${L}`);
    B.tube({
      path: [f0, f1], radial: 5, capStart: true, capEnd: true, squash: () => 0.6,
      radius: (t) => H * 0.034 * (1 - t * 0.5),
    });
  });

  // A blade in the right hand: the army has to look armed.
  G.rigidTo('handR');
  {
    const h = rig.tailOf('handR');
    G.tube({
      path: [[h[0], h[1] + H * 0.06, h[2]], [h[0], h[1] - H * 0.02, h[2]]],
      radial: 4, radius: () => H * 0.010, capStart: true, capEnd: true,
    });
    G.patch({
      rows: 5, cols: 4, closeU: true,
      fn: (u, v, out) => {
        const a = u * Math.PI * 2;
        const w = H * 0.026 * (1 - Math.pow(v, 2.4)) + 0.002;
        out.set(h[0] + Math.sin(a) * w, h[1] - H * 0.02 - v * H * 0.52, h[2] + Math.cos(a) * H * 0.006);
      },
    });
  }
  for (const key of ['tatterL', 'tatterR', 'wisp']) {
    if (!rig.has(`${key}0`)) continue;
    G.bindTo([`${key}*`], 2.0);
    G.rag({
      top: rig.headOf(`${key}0`), ex: [1, 0, key === 'wisp' ? -0.4 : 0.2],
      span: H * (key === 'wisp' ? 0.26 : 0.16), drop: H * (key === 'wisp' ? 0.48 : 0.28),
      jag: 0.38, sway: 0.04, seed: seed + key.length * 13, rows: 4, cols: 4,
    });
  }

  E.bindTo(['head'], 5.0);
  eyes(E, rig, { radius: H * 0.017, sep: H * 0.028, fwd: H * 0.060, at: 0.40, lift: H * 0.006 });
  return { body: B, gear: G, glow: E };
}

/* ==========================================================================
 * entry point
 * ========================================================================== */

const BUILDERS = {
  ghoul: buildGhoul, knight: buildKnight, beast: buildBeast,
  caster: buildCaster, brute: buildBrute, boss: buildBoss, shade: buildShade,
};

/**
 * Build one archetype's geometry set.
 *
 * @returns {{ geometries: {body,gear,glow}, triangles, vertices }}
 *   Any slot may be null when an archetype does not use it.
 */
export function buildBody(id, rig, arch, seed, uvScale = null) {
  const fn = BUILDERS[id] ?? BUILDERS.ghoul;
  const built = fn(rig, arch, seed >>> 0);
  const geometries = {};
  let triangles = 0, vertices = 0;
  const bounds = { height: arch.height, radius: arch.radius };
  for (const slot of SLOTS) {
    const b = built[slot];
    if (b && uvScale && uvScale[slot]) b.uvScale = uvScale[slot];
    const geo = b ? b.build(bounds) : null;
    geometries[slot] = geo;
    if (geo) {
      vertices += geo.attributes.position.count;
      triangles += geo.index.count / 3;
    }
  }
  return { geometries, triangles: Math.round(triangles), vertices };
}
