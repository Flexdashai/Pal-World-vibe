import { Builder, SECTION, SURF, bladeRings, hash01 } from './geokit.js';

/**
 * MONARCH — the item meshes.
 *
 * ARCHITECTURE.md: "A dropped item is a real procedural mesh with a silhouette
 * specific to its base type — a greatsword is not a scaled long sword."
 *
 * Every recipe here is authored to be read as a SILHOUETTE at ~40 px, which is
 * what a drop occupies at the gameplay camera. The rules that follow from that:
 *
 *  - The outline carries the identity. An axe is identified by the asymmetric
 *    mass at one end of a stick; a bow by the D; a helm by the T of its face
 *    opening. Interior detail below ~2 cm is invisible and is not modelled.
 *  - Every item has at least three MATERIALS in it (plate / leather / accent),
 *    because a single-material object at this size reads as a paper cutout. The
 *    accent is `SURF.rune`, whose `emit` mask is what the rarity material lights
 *    up — so escalating rarity changes the object's material treatment rather
 *    than its shape, exactly as the contract requires.
 *  - Proportions are deliberately stylised: blades are ~15% wider and pommels
 *    ~30% larger than real, because real proportions vanish at this distance.
 *
 * Two variants per base, chosen by the item's seed, so a floor covered in swords
 * is not a floor covered in ONE sword.
 */

/** Every base id → builder. Keys must match `bases.js`'s `mesh` field. */
export const MESH_BUILDERS = {};

/* ==========================================================================
 * shared parts
 * ========================================================================== */

/** A wrapped grip with a visible binding: a tapered oct sweep plus three rings
 *  of a second material. The rings are 4 mm and still read, because they break
 *  the specular along the length. */
function grip(B, y0, y1, r0, r1, wrapSurf = SURF.leather, bindSurf = SURF.brass) {
  const n = 5;
  const rings = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // A grip is not a cylinder — it swells at the middle so the hand locates it.
    const swell = 1 + Math.sin(t * Math.PI) * 0.16;
    rings.push({ y: y0 + (y1 - y0) * t, sx: (r0 + (r1 - r0) * t) * swell });
  }
  B.sweep(SECTION.oct, rings, wrapSurf);
  for (let i = 0; i < 3; i++) {
    const t = 0.18 + i * 0.32;
    const y = y0 + (y1 - y0) * t;
    const r = (r0 + (r1 - r0) * t) * 1.14;
    B.torus(0, y, 0, r * 0.72, r * 0.34, 8, 4, bindSurf, 0.6);
  }
}

/** A faceted gem: two cones back to back, with a flat table on top. */
function gem(B, cx, cy, cz, r, h, surf = SURF.gem, sides = 6) {
  B.push().translate(cx, cy, cz);
  B.sweep(SECTION.round, [
    { y: -h * 0.62, sx: 0 },
    { y: -h * 0.10, sx: r },
    { y: h * 0.22, sx: r * 0.86 },
    { y: h * 0.38, sx: r * 0.52 },
  ], surf, { capBottom: false, capTop: true });
  B.pop();
  void sides;
}

/** A short spike, for pommels, crests and axe backs. */
function spike(B, x, y, z, r, len, surf, tiltZ = 0) {
  B.push().translate(x, y, z).rotateZ(tiltZ);
  B.sweep(SECTION.hex, [
    { y: 0, sx: r },
    { y: len * 0.55, sx: r * 0.55 },
    { y: len, sx: 0 },
  ], surf, { capBottom: true, capTop: false });
  B.pop();
}

/* ==========================================================================
 * WEAPONS
 * ========================================================================== */

MESH_BUILDERS.sword = (v) => {
  const B = new Builder();
  const k = hash01(v, 11);
  const len = 0.60 + k * 0.06;
  const half = 0.049 + k * 0.006;

  // Blade. The widest point is 12% up from the ricasso, not at the guard — a
  // blade that is widest where it meets the hilt reads as a shard of metal.
  B.sweep(SECTION.blade, bladeRings(-0.02, len, 7,
    (t) => half * (1 + 0.10 * Math.sin(t * Math.PI * 0.8)) * (1 - t * t * 0.86),
    (t) => 0.0125 * (1 - t * 0.72)), SURF.steel);
  // Fuller — a shallow inset groove carrying the rarity accent.
  B.sweep(SECTION.strap, bladeRings(0.02, len * 0.78, 4,
    (t) => half * 0.24 * (1 - t * 0.55),
    () => 0.0135), SURF.rune);
  // Ricasso and crossguard. The guard is swept forward, which is what makes it
  // read as a guard rather than as a plus sign.
  B.box(0, -0.045, 0, 0.017, 0.030, 0.016, SURF.steelDark);
  B.push().translate(0, -0.062, 0).rotateX(0.16);
  B.sweep(SECTION.strap, [
    { y: -0.014, sx: 0.150, sz: 0.020 },
    { y: 0.006, sx: 0.168, sz: 0.026 },
    { y: 0.022, sx: 0.128, sz: 0.018 },
  ], SURF.brass);
  B.pop();
  // Grip and pommel.
  grip(B, -0.30, -0.072, 0.0165, 0.0195);
  B.torus(0, -0.318, 0, 0.021, 0.0165, 10, 6, SURF.brass, 0.85);
  gem(B, 0, -0.318, 0, 0.0125, 0.024, SURF.gem);
  return B.finish('mn.loot.sword');
};

MESH_BUILDERS.greatsword = (v) => {
  const B = new Builder();
  const k = hash01(v, 23);
  const len = 0.88 + k * 0.08;
  const half = 0.079 + k * 0.008;

  B.sweep(SECTION.blade, bladeRings(0.03, len, 8,
    (t) => half * (1 + 0.06 * Math.sin(t * Math.PI * 0.7)) * (1 - Math.pow(t, 2.3) * 0.90),
    (t) => 0.0175 * (1 - t * 0.62)), SURF.steel);
  // Twin fullers — two grooves, which is what says "greatsword" rather than
  // "long sword scaled up".
  for (const off of [-0.026, 0.026]) {
    B.push().translate(off, 0, 0);
    B.sweep(SECTION.strap, bladeRings(0.08, len * 0.70, 4,
      (t) => 0.0125 * (1 - t * 0.5), () => 0.019), SURF.rune);
    B.pop();
  }
  // Ricasso with a leather-wrapped false grip, and parrying lugs.
  B.box(0, -0.02, 0, 0.026, 0.062, 0.022, SURF.steelDark);
  for (const s of [-1, 1]) B.box(s * 0.043, 0.005, 0, 0.020, 0.011, 0.013, SURF.iron, 0.6);
  // Quillons: long, down-swept, with terminal knobs.
  B.push().translate(0, -0.088, 0).rotateX(0.10);
  for (const s of [-1, 1]) {
    B.push().translate(0, 0, 0).rotateZ(s * -0.30);
    B.sweep(SECTION.hex, [
      { y: 0, sx: 0.024 },
      { y: s * 0, sx: 0.020 },
    ], SURF.brass, { capTop: false });
    B.box(s * 0.115, 0.004, 0, 0.118, 0.014, 0.017, SURF.brass, 0.72);
    B.pop();
    B.torus(s * 0.222, -0.028, 0, 0.017, 0.013, 8, 5, SURF.gold, 0.9);
  }
  B.pop();
  grip(B, -0.40, -0.10, 0.020, 0.024, SURF.leather, SURF.gold);
  B.sweep(SECTION.round, [
    { y: -0.455, sx: 0 }, { y: -0.428, sx: 0.031 },
    { y: -0.398, sx: 0.034 }, { y: -0.372, sx: 0.020 },
  ], SURF.gold);
  gem(B, 0, -0.418, 0.031, 0.014, 0.024, SURF.gem);
  return B.finish('mn.loot.greatsword');
};

MESH_BUILDERS.axe = (v) => {
  const B = new Builder();
  const k = hash01(v, 31);

  // Haft, slightly bowed so it is not a dowel.
  B.sweep(SECTION.oct, [
    { y: -0.42, sx: 0.0165, ox: 0.004 },
    { y: -0.10, sx: 0.0180, ox: 0.000 },
    { y: 0.16, sx: 0.0175, ox: -0.003 },
    { y: 0.40, sx: 0.0155, ox: -0.004 },
  ], SURF.wood);
  grip(B, -0.40, -0.16, 0.019, 0.020, SURF.leather, SURF.iron);
  // Butt cap and a langet up the haft.
  B.torus(0.004, -0.415, 0, 0.014, 0.010, 8, 4, SURF.iron, 0.8);
  B.box(-0.003, 0.24, 0, 0.006, 0.10, 0.019, SURF.iron);

  // The head. All the identity is here: a broad crescent bit on +X, a socket
  // wrapping the haft, and a spike on −X for the asymmetry.
  const bit = 0.176 + k * 0.024;
  B.push().translate(0, 0.31, 0);
  B.sweep(SECTION.edged, [
    { y: -0.098, sx: bit * 0.52, sz: 0.0155, ox: bit * 0.30 },
    { y: -0.040, sx: bit * 0.92, sz: 0.0135, ox: bit * 0.46 },
    { y: 0.030, sx: bit * 1.00, sz: 0.0120, ox: bit * 0.50 },
    { y: 0.086, sx: bit * 0.60, sz: 0.0135, ox: bit * 0.32 },
  ], SURF.steel);
  // The bevel band along the cutting edge, in the accent material.
  B.sweep(SECTION.strap, [
    { y: -0.082, sx: 0.010, sz: 0.013, ox: bit * 0.80 },
    { y: 0.020, sx: 0.011, sz: 0.011, ox: bit * 0.95 },
    { y: 0.072, sx: 0.009, sz: 0.012, ox: bit * 0.62 },
  ], SURF.rune);
  // Socket.
  B.sweep(SECTION.hex, [
    { y: -0.086, sx: 0.030 }, { y: -0.02, sx: 0.034 }, { y: 0.072, sx: 0.028 },
  ], SURF.ironDull);
  spike(B, -0.030, 0.012, 0, 0.016, 0.088, SURF.steelDark, -Math.PI * 0.5);
  B.pop();
  return B.finish('mn.loot.axe');
};

MESH_BUILDERS.dagger = (v) => {
  const B = new Builder();
  const k = hash01(v, 41);
  const len = 0.27 + k * 0.04;

  // A leaf blade with a pronounced belly — the outline that says "dagger" and
  // not "small sword".
  B.sweep(SECTION.blade, bladeRings(-0.01, len, 6,
    (t) => (0.030 + 0.016 * Math.sin(t * Math.PI)) * (1 - Math.pow(t, 2.6) * 0.94),
    (t) => 0.0085 * (1 - t * 0.6)), SURF.blackSteel);
  B.sweep(SECTION.strap, bladeRings(0.01, len * 0.72, 3,
    (t) => 0.007 * (1 - t * 0.4), () => 0.0092), SURF.rune);
  // A guard that sweeps toward the blade — the classic parrying dagger read.
  B.push().translate(0, -0.028, 0).rotateX(0.22);
  B.sweep(SECTION.strap, [
    { y: -0.008, sx: 0.052, sz: 0.013 },
    { y: 0.008, sx: 0.062, sz: 0.017 },
    { y: 0.020, sx: 0.040, sz: 0.011 },
  ], SURF.gold);
  B.pop();
  grip(B, -0.128, -0.036, 0.0125, 0.0145, SURF.leather, SURF.gold);
  B.sweep(SECTION.hex, [
    { y: -0.152, sx: 0 }, { y: -0.140, sx: 0.020 }, { y: -0.124, sx: 0.013 },
  ], SURF.gold);
  return B.finish('mn.loot.dagger');
};

MESH_BUILDERS.bow = (v) => {
  const B = new Builder();
  const k = hash01(v, 53);
  const H = 0.60 + k * 0.05;

  // A recurve stave: the limb bends back on itself near the tip, which is the
  // whole silhouette. Built as a path in XY and swept as a ribbon.
  const path = [];
  const N = 11;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 - 1;                    // −1 .. 1
    const a = t * 1.16;
    // Belly curve, plus a recurve term that pulls the last 18% forward.
    const rec = Math.pow(Math.max(0, Math.abs(t) - 0.80) / 0.20, 2) * 0.085;
    path.push([Math.cos(a) * 0.30 - 0.30 + rec, Math.sin(a) * H]);
  }
  B.push().rotateY(Math.PI * 0.5);
  B.ribbon(path, (t) => 0.020 * (1 - Math.abs(t * 2 - 1) * 0.55) + 0.006, 0.0085, SURF.woodPale);
  // Accent inlay down the belly of the stave.
  B.push().translate(0.010, 0, 0);
  B.ribbon(path, () => 0.005, 0.0095, SURF.rune);
  B.pop();
  // String: a straight line between the tips.
  const t0 = path[0], t1 = path[path.length - 1];
  B.ribbon([[t0[0], t0[1]], [t1[0], t1[1]]], () => 0.0025, 0.0025, SURF.cloth);
  B.pop();
  // Grip and arrow shelf.
  grip(B, -0.075, 0.075, 0.0165, 0.0165, SURF.leather, SURF.brass);
  B.box(0.026, 0.028, 0, 0.014, 0.007, 0.013, SURF.iron, 0.7);
  return B.finish('mn.loot.bow');
};

MESH_BUILDERS.staff = (v) => {
  const B = new Builder();
  const k = hash01(v, 67);

  B.sweep(SECTION.oct, [
    { y: -0.66, sx: 0.0135 },
    { y: -0.30, sx: 0.0165, ox: 0.004 },
    { y: 0.10, sx: 0.0175, ox: -0.002 },
    { y: 0.44, sx: 0.0155 },
  ], SURF.wood);
  // Iron ferrule and three binding rings up the shaft — the vertical rhythm is
  // what stops a staff reading as a broom handle.
  B.sweep(SECTION.round, [
    { y: -0.70, sx: 0.010 }, { y: -0.655, sx: 0.017 }, { y: -0.60, sx: 0.0145 },
  ], SURF.ironDull);
  for (let i = 0; i < 3; i++) {
    B.torus(0, -0.34 + i * 0.24, 0, 0.019, 0.006, 10, 4, SURF.brass, 0.9);
  }
  grip(B, -0.18, 0.06, 0.019, 0.019, SURF.leather, SURF.brass);

  // The head: three claws curling inward around a floating shard.
  const claws = 3;
  const lean = 0.30 + k * 0.10;
  B.push().translate(0, 0.46, 0);
  for (let i = 0; i < claws; i++) {
    B.push().rotateY((i / claws) * Math.PI * 2);
    B.sweep(SECTION.hex, [
      { y: 0, sx: 0.014, ox: 0.014 },
      { y: 0.060, sx: 0.012, ox: 0.052 },
      { y: 0.115, sx: 0.009, ox: 0.060 },
      { y: 0.160, sx: 0.005, ox: 0.030 },
    ], SURF.blackSteel);
    B.pop();
    void lean;
  }
  B.sweep(SECTION.round, [
    { y: -0.020, sx: 0.026 }, { y: 0.010, sx: 0.030 }, { y: 0.036, sx: 0.020 },
  ], SURF.gold);
  // The shard. Bigger than a gem — it is the item's read at distance.
  B.push().translate(0, 0.112, 0);
  B.sweep(SECTION.hex, [
    { y: -0.052, sx: 0 }, { y: -0.014, sx: 0.030 },
    { y: 0.022, sx: 0.026 }, { y: 0.062, sx: 0 },
  ], SURF.gem, { capBottom: false, capTop: false });
  B.pop();
  B.pop();
  return B.finish('mn.loot.staff');
};

/* ==========================================================================
 * OFF-HAND
 * ========================================================================== */

MESH_BUILDERS.shield = (v) => {
  const B = new Builder();
  const k = hash01(v, 71);
  const W = 0.20 + k * 0.02, H = 0.32;

  // Kite outline. The point is 62% of the way down, not at the bottom centre —
  // a symmetric kite reads as a diamond.
  const outline = [];
  const N = 14;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const a = t * Math.PI * 2;
    const y = Math.cos(a);
    const x = Math.sin(a);
    const taper = y > 0 ? 1 : Math.pow(1 + y, 0.62);
    outline.push([x * W * taper, y * H * (y > 0 ? 0.78 : 1.0)]);
  }
  // Face: fan from the centre, bulged forward so it is not a flat card.
  B.push().rotateY(Math.PI * 0.5);
  for (let i = 0; i < N; i++) {
    const p = outline[i], q = outline[(i + 1) % N];
    const bulge = (a) => -0.030 * (1 - Math.min(1, Math.hypot(a[0] / W, a[1] / H)));
    B.tri([0, 0, -0.048], [p[0], p[1], bulge(p) - 0.014], [q[0], q[1], bulge(q) - 0.014], SURF.iron);
    B.tri([0, 0, 0.012], [q[0], q[1], 0.010], [p[0], p[1], 0.010], SURF.leather);
  }
  B.ribbon(outline, () => 0.013, 0.014, SURF.brass, true);
  B.pop();
  // Boss and a vertical accent band.
  B.push().rotateY(Math.PI * 0.5).translate(0, 0.045, 0).rotateX(-Math.PI * 0.5);
  B.sweep(SECTION.round, [
    { y: 0.030, sx: 0.048 }, { y: 0.058, sx: 0.040 }, { y: 0.076, sx: 0 },
  ], SURF.steel, { capBottom: true, capTop: false });
  B.pop();
  B.push().rotateY(Math.PI * 0.5);
  B.ribbon([[0, H * 0.72], [0, -H * 0.94]], () => 0.014, 0.020, SURF.rune);
  B.pop();
  return B.finish('mn.loot.shield');
};

MESH_BUILDERS.orb = (v) => {
  const B = new Builder();
  const k = hash01(v, 83);
  const R = 0.088 + k * 0.010;

  // The glass. A sweep of a circle through a sine profile is a sphere, and 8
  // rings of 12 sides is enough at this size.
  const rings = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    rings.push({ y: -R + 2 * R * t, sx: R * Math.sin(t * Math.PI) });
  }
  B.sweep(SECTION.round, rings, SURF.gemDeep, { capBottom: false, capTop: false });
  // Something suspended inside, so the orb is not an empty ball.
  B.sweep(SECTION.hex, [
    { y: -0.030, sx: 0 }, { y: -0.006, sx: 0.024 },
    { y: 0.014, sx: 0.020 }, { y: 0.038, sx: 0 },
  ], SURF.gem, { capBottom: false, capTop: false });
  // The cage: three great circles of metal, each rotated onto its own axis.
  B.torus(0, 0, 0, R * 1.02, 0.0085, 16, 5, SURF.gold, 1);
  B.push().rotateZ(Math.PI * 0.5);
  B.torus(0, 0, 0, R * 1.02, 0.0085, 16, 5, SURF.gold, 1);
  B.pop();
  B.push().rotateX(Math.PI * 0.5);
  B.torus(0, 0, 0, R * 1.02, 0.007, 16, 5, SURF.brass, 1);
  B.pop();
  // Crown and hanging loop, so it has a top.
  B.sweep(SECTION.round, [
    { y: R * 0.86, sx: 0.030 }, { y: R * 1.10, sx: 0.024 }, { y: R * 1.24, sx: 0.014 },
  ], SURF.gold);
  B.torus(0, R * 1.40, 0, 0.017, 0.0055, 10, 4, SURF.gold, 1);
  return B.finish('mn.loot.orb');
};

/* ==========================================================================
 * ARMOUR
 * ========================================================================== */

MESH_BUILDERS.helm = (v) => {
  const B = new Builder();
  const k = hash01(v, 97);

  // Skull: an egg, longer front-to-back than side-to-side.
  const rings = [];
  for (let i = 0; i <= 7; i++) {
    const t = i / 7;
    const r = Math.sin(Math.pow(t, 0.86) * Math.PI * 0.98);
    rings.push({ y: -0.085 + 0.185 * t, sx: 0.088 * r, sz: 0.100 * r });
  }
  B.sweep(SECTION.round, rings, SURF.steel, { capBottom: false, capTop: false });
  // Face opening: a T. Two cheek plates leaving a vertical slot, which is the
  // barbute's entire signature and survives at 30 px.
  for (const s of [-1, 1]) {
    B.push().translate(s * 0.052, -0.052, 0.058).rotateY(s * 0.34);
    B.sweep(SECTION.strap, [
      { y: -0.030, sx: 0.034, sz: 0.012 },
      { y: 0.036, sx: 0.040, sz: 0.014 },
    ], SURF.steelDark);
    B.pop();
  }
  // Brow band and crest.
  B.torus(0, -0.014, 0, 0.090, 0.0095, 16, 5, SURF.brass, 0.55);
  B.push().translate(0, 0.052, 0);
  B.ribbon([[-0.088, 0.006], [-0.040, 0.030], [0.030, 0.032], [0.086, 0.004]],
    (t) => 0.010 + 0.010 * Math.sin(t * Math.PI), 0.010, SURF.rune);
  B.pop();
  // Nasal.
  B.box(0, -0.040, 0.096, 0.010, 0.038, 0.011, SURF.steelDark, 0.7);
  // Neck guard flaring at the back.
  B.push().translate(0, -0.086, -0.030).rotateX(0.42);
  B.sweep(SECTION.tear, [
    { y: 0, sx: 0.080, sz: 0.060 },
    { y: 0.040, sx: 0.092, sz: 0.070 },
  ], SURF.iron, { capBottom: false, capTop: false });
  B.pop();
  void k;
  return B.finish('mn.loot.helm');
};

MESH_BUILDERS.chest = (v) => {
  const B = new Builder();
  const k = hash01(v, 101);

  // Torso: wide at the chest, pinched at the waist, flared at the fauld. The
  // pinch is the read — a straight tube is a barrel, not a cuirass.
  B.sweep(SECTION.tear, [
    { y: -0.19, sx: 0.130, sz: 0.088 },
    { y: -0.10, sx: 0.118, sz: 0.078 },
    { y: 0.00, sx: 0.126, sz: 0.084 },
    { y: 0.10, sx: 0.152, sz: 0.098 },
    { y: 0.17, sx: 0.146, sz: 0.092 },
  ], SURF.steel, { capBottom: false, capTop: false });
  // Layered plates across the abdomen — four lames, each proud of the one below.
  for (let i = 0; i < 4; i++) {
    const y = -0.175 + i * 0.045;
    const r = 1.0 + i * 0.02;
    B.sweep(SECTION.tear, [
      { y, sx: 0.128 * r, sz: 0.086 * r },
      { y: y + 0.020, sx: 0.134 * r, sz: 0.090 * r },
    ], SURF.steelDark, { capBottom: false, capTop: false });
  }
  // Collar.
  B.torus(0, 0.176, 0, 0.098, 0.016, 14, 5, SURF.brass, 0.7);
  // The central accent: a sternum ridge with a stone set in it.
  B.push().translate(0, 0.02, 0.090);
  B.ribbon([[0, 0.128], [0, -0.150]], (t) => 0.020 - 0.008 * t, 0.012, SURF.rune);
  B.pop();
  gem(B, 0, 0.088, 0.104, 0.021, 0.036, SURF.gem);
  // Rivets down each side, which is most of what makes plate read as plate.
  for (let i = 0; i < 5; i++) {
    for (const s of [-1, 1]) {
      B.torus(s * 0.118, -0.15 + i * 0.075, 0.030, 0.0055, 0.0035, 6, 3, SURF.iron, 1);
    }
  }
  void k;
  return B.finish('mn.loot.chest');
};

MESH_BUILDERS.gloves = (v) => {
  const B = new Builder();
  const k = hash01(v, 103);

  // Flared cuff.
  B.sweep(SECTION.tear, [
    { y: -0.100, sx: 0.070, sz: 0.056 },
    { y: -0.050, sx: 0.052, sz: 0.044 },
    { y: -0.010, sx: 0.048, sz: 0.042 },
  ], SURF.steel, { capBottom: false, capTop: false });
  B.torus(0, -0.098, 0, 0.070, 0.0090, 12, 4, SURF.brass, 0.7);
  // Hand: a wedge, tapering into fingers.
  B.sweep(SECTION.strap, [
    { y: -0.010, sx: 0.046, sz: 0.028 },
    { y: 0.036, sx: 0.048, sz: 0.024 },
    { y: 0.062, sx: 0.042, sz: 0.020 },
  ], SURF.leather, { capBottom: false });
  // Four knuckle plates and four fingers. Splayed, so the silhouette has gaps
  // in it — a solid mitten reads as a rock.
  for (let i = 0; i < 4; i++) {
    const x = -0.033 + i * 0.022;
    const lean = (i - 1.5) * 0.13;
    B.box(x, 0.048, 0.012, 0.0095, 0.010, 0.014, SURF.steelDark);
    B.push().translate(x, 0.062, 0.004).rotateZ(lean);
    B.sweep(SECTION.strap, [
      { y: 0, sx: 0.0095, sz: 0.011 },
      { y: 0.026, sx: 0.0085, sz: 0.010 },
      { y: 0.046, sx: 0.006, sz: 0.008 },
    ], SURF.steelDark);
    B.pop();
  }
  // Thumb.
  B.push().translate(0.044, 0.014, 0.006).rotateZ(-0.72);
  B.sweep(SECTION.strap, [
    { y: 0, sx: 0.012, sz: 0.013 }, { y: 0.040, sx: 0.009, sz: 0.010 },
  ], SURF.steelDark);
  B.pop();
  // Accent across the back of the hand.
  B.push().translate(0, 0.020, 0.026);
  B.ribbon([[-0.030, -0.020], [0, 0.006], [0.030, -0.020]], () => 0.007, 0.008, SURF.rune);
  B.pop();
  void k;
  return B.finish('mn.loot.gloves');
};

MESH_BUILDERS.boots = (v) => {
  const B = new Builder();
  const k = hash01(v, 107);

  // Greave: tapering shin.
  B.sweep(SECTION.tear, [
    { y: -0.070, sx: 0.052, sz: 0.056 },
    { y: 0.030, sx: 0.044, sz: 0.048 },
    { y: 0.110, sx: 0.056, sz: 0.058 },
  ], SURF.steel, { capBottom: false, capTop: false });
  // Knee cop — a dome with a small spike, which is the whole top silhouette.
  B.push().translate(0, 0.112, 0.010);
  B.sweep(SECTION.round, [
    { y: 0, sx: 0.058 }, { y: 0.026, sx: 0.048 }, { y: 0.046, sx: 0.022 },
  ], SURF.steelDark, { capBottom: false });
  B.pop();
  spike(B, 0, 0.158, 0.014, 0.012, 0.036, SURF.iron);
  // Ankle and foot. The foot points +Z and is the reason this is a boot rather
  // than a tube.
  B.sweep(SECTION.tear, [
    { y: -0.098, sx: 0.048, sz: 0.052 },
    { y: -0.070, sx: 0.052, sz: 0.056 },
  ], SURF.leather, { capBottom: false, capTop: false });
  B.push().translate(0, -0.112, 0.036).rotateX(Math.PI * 0.5);
  B.sweep(SECTION.tear, [
    { y: -0.020, sx: 0.048, sz: 0.030 },
    { y: 0.055, sx: 0.043, sz: 0.026 },
    { y: 0.092, sx: 0.030, sz: 0.020 },
  ], SURF.steelDark);
  B.pop();
  // Straps and accent.
  for (let i = 0; i < 2; i++) {
    B.torus(0, -0.040 + i * 0.062, 0, 0.050, 0.0075, 10, 4, SURF.leatherPale, 0.65);
  }
  B.push().translate(0, 0.020, 0.052);
  B.ribbon([[0, 0.078], [0, -0.086]], () => 0.008, 0.008, SURF.rune);
  B.pop();
  void k;
  return B.finish('mn.loot.boots');
};

MESH_BUILDERS.pauldron = (v) => {
  const B = new Builder();
  const k = hash01(v, 109);

  // Three overlapping lames, each larger and lower than the one above. A
  // pauldron read at 30 px is a stack of arcs.
  for (let i = 0; i < 3; i++) {
    const s = 1 + i * 0.20;
    const y = 0.058 - i * 0.052;
    B.push().translate(0, y, 0).rotateX(0.10 * i);
    B.sweep(SECTION.tear, [
      { y: 0, sx: 0.078 * s, sz: 0.062 * s },
      { y: 0.030, sx: 0.070 * s, sz: 0.056 * s },
    ], i === 0 ? SURF.steel : SURF.steelDark, { capBottom: false, capTop: false });
    B.pop();
  }
  // Crown plate with a spine of small spikes.
  B.push().translate(0, 0.086, 0);
  B.sweep(SECTION.tear, [
    { y: 0, sx: 0.072, sz: 0.058 },
    { y: 0.030, sx: 0.050, sz: 0.040 },
    { y: 0.048, sx: 0.022, sz: 0.018 },
  ], SURF.steel, { capBottom: false });
  B.pop();
  for (let i = 0; i < 3; i++) {
    spike(B, (i - 1) * 0.030, 0.132, -0.004 + Math.abs(i - 1) * 0.010, 0.0085, 0.034, SURF.blackSteel);
  }
  B.torus(0, 0.084, 0, 0.075, 0.0085, 14, 4, SURF.brass, 0.7);
  B.push().translate(0, 0.030, 0.062);
  B.ribbon([[-0.036, 0.030], [0, 0.048], [0.036, 0.030]], () => 0.008, 0.010, SURF.rune);
  B.pop();
  void k;
  return B.finish('mn.loot.pauldron');
};

MESH_BUILDERS.belt = (v) => {
  const B = new Builder();
  const k = hash01(v, 113);

  // The strap, as a closed loop with a square section.
  B.torus(0, 0, 0, 0.108, 0.020, 20, 4, SURF.leather, 0.42);
  // Studs.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    B.torus(Math.cos(a) * 0.118, 0, Math.sin(a) * 0.118, 0.0075, 0.005, 6, 3, SURF.iron, 1);
  }
  // Buckle: a plate with a rectangular void suggested by two bars.
  B.push().translate(0, 0, 0.122);
  B.box(0, 0, 0, 0.048, 0.030, 0.010, SURF.gold);
  B.box(0, 0, 0.012, 0.030, 0.016, 0.008, SURF.blackSteel);
  B.pop();
  gem(B, 0, 0.002, 0.140, 0.016, 0.028, SURF.gem);
  // Tassets hanging from the front quarters.
  for (const s of [-1, 1]) {
    B.push().translate(s * 0.068, -0.052, 0.086).rotateX(0.14);
    B.sweep(SECTION.tear, [
      { y: 0, sx: 0.032, sz: 0.016 },
      { y: -0.070, sx: 0.028, sz: 0.014 },
    ], SURF.steelDark, { capBottom: false, capTop: false });
    B.pop();
  }
  void k;
  return B.finish('mn.loot.belt');
};

MESH_BUILDERS.legs = (v) => {
  const B = new Builder();
  const k = hash01(v, 127);

  // Fauld: a flared skirt of four lames.
  for (let i = 0; i < 4; i++) {
    const y = 0.130 - i * 0.036;
    const s = 1 + i * 0.06;
    B.sweep(SECTION.tear, [
      { y, sx: 0.118 * s, sz: 0.086 * s },
      { y: y - 0.024, sx: 0.124 * s, sz: 0.090 * s },
    ], i % 2 ? SURF.steelDark : SURF.steel, { capBottom: false, capTop: false });
  }
  // Two cuisses hanging below, splayed so the outline has a notch in it.
  for (const s of [-1, 1]) {
    B.push().translate(s * 0.058, -0.070, 0).rotateZ(s * 0.10);
    B.sweep(SECTION.tear, [
      { y: 0, sx: 0.056, sz: 0.052 },
      { y: -0.090, sx: 0.048, sz: 0.046 },
      { y: -0.150, sx: 0.040, sz: 0.040 },
    ], SURF.steel, { capBottom: false, capTop: false });
    B.pop();
    B.torus(s * 0.058, -0.156, 0, 0.045, 0.0075, 10, 4, SURF.brass, 0.7);
  }
  B.torus(0, 0.140, 0, 0.116, 0.014, 16, 5, SURF.leather, 0.5);
  B.push().translate(0, 0.060, 0.096);
  B.ribbon([[0, 0.058], [0, -0.078]], () => 0.010, 0.010, SURF.rune);
  B.pop();
  void k;
  return B.finish('mn.loot.legs');
};

/* ==========================================================================
 * JEWELLERY
 * ========================================================================== */

MESH_BUILDERS.ring = (v) => {
  const B = new Builder();
  const k = hash01(v, 131);
  const R = 0.062 + k * 0.006;

  B.torus(0, 0, 0, R, 0.0135, 18, 6, SURF.gold, 1);
  // The bezel sits proud of the band, which is the only way a ring reads at
  // this size — a plain torus is a washer.
  B.push().translate(0, R * 0.92, 0);
  B.sweep(SECTION.hex, [
    { y: -0.012, sx: 0.030 }, { y: 0.006, sx: 0.034 }, { y: 0.018, sx: 0.026 },
  ], SURF.gold);
  B.pop();
  gem(B, 0, R * 0.98, 0, 0.024, 0.040, SURF.gem);
  // Two small claws either side of the stone.
  for (const s of [-1, 1]) spike(B, s * 0.030, R * 0.90, 0, 0.007, 0.024, SURF.brass, s * -0.4);
  // Engraved shoulders in the accent material.
  for (const s of [-1, 1]) {
    B.push().translate(s * 0.050, R * 0.34, 0).rotateZ(s * -0.9);
    B.box(0, 0, 0, 0.014, 0.006, 0.014, SURF.rune);
    B.pop();
  }
  return B.finish('mn.loot.ring');
};

MESH_BUILDERS.amulet = (v) => {
  const B = new Builder();
  const k = hash01(v, 137);

  // The chain, as an arc of small links. Twelve links is enough to read as a
  // chain and cheap enough not to care.
  const links = 12;
  for (let i = 0; i <= links; i++) {
    const t = i / links;
    const a = Math.PI * (0.18 + t * 0.64);
    const x = Math.cos(a) * 0.115;
    const y = Math.sin(a) * 0.100 + 0.055;
    B.push().translate(x, y, 0).rotateZ(a).rotateX(i % 2 ? Math.PI * 0.5 : 0);
    B.torus(0, 0, 0, 0.0105, 0.0038, 7, 4, SURF.gold, 1);
    B.pop();
  }
  // Pendant: a shield-shaped plate with a stone and a hanging point.
  B.torus(0, 0.042, 0, 0.014, 0.005, 8, 4, SURF.gold, 1);
  B.push().translate(0, -0.028, 0);
  B.sweep(SECTION.tear, [
    { y: 0.062, sx: 0.052, sz: 0.013 },
    { y: 0.010, sx: 0.060, sz: 0.016 },
    { y: -0.048, sx: 0.044, sz: 0.013 },
    { y: -0.088, sx: 0.010, sz: 0.008 },
  ], SURF.gold, { capBottom: true, capTop: true });
  B.pop();
  // Inlay + stone.
  B.push().translate(0, -0.028, 0.017);
  B.ribbon([[-0.030, 0.036], [0, 0.048], [0.030, 0.036], [0, -0.052]],
    () => 0.006, 0.006, SURF.rune);
  B.pop();
  gem(B, 0, -0.010, 0.021, 0.023, 0.034, SURF.gem);
  void k;
  return B.finish('mn.loot.amulet');
};

/* ==========================================================================
 * the cache
 * ========================================================================== */

/**
 * Two variants of every base, built once at init.
 *
 * Geometry is SHARED across every drop of the same base and variant — an item
 * on the floor is a transform and a material, nothing more. That is what makes
 * twenty simultaneous drops affordable on a software rasteriser.
 */
export const VARIANTS = 2;

export function buildAllMeshes() {
  const map = new Map();
  let tris = 0;
  for (const key in MESH_BUILDERS) {
    const list = [];
    for (let v = 0; v < VARIANTS; v++) {
      const g = MESH_BUILDERS[key](v);
      tris += g.userData.triangles;
      list.push(g);
    }
    map.set(key, list);
  }
  return { map, triangles: tris };
}
