import * as THREE from 'three';
import { SURFACE } from './tuning.js';
import { blockGeo, prismGeo, chainGeo, rockGeo, boneGeo, skullGeo, normalise, mergeAll } from './geom.js';
import { matAt } from './kit.js';

/**
 * MONARCH — set dressing.
 *
 * Statuary, tombs, altars, ironwork, banners, bones, roots and rubble. Same
 * contract as `kit.js`: everything is emitted into the builder, nothing returns
 * a mesh.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIGURES ARE BUILT OUT OF BOXES AND PRISMS
 *
 * There is no model pipeline and no sculpting tool; every vertex in this game is
 * computed. A believable statue at this camera is therefore not a question of
 * anatomy — a kneeling saint occupies about 60x120 screen pixels at the hero
 * boom — it is a question of SILHOUETTE and of whether the light breaks across
 * it in more than one plane. Nine tapered boxes at plausible proportions, tilted
 * off axis, with a broken head, read as a statue. A smooth capsule does not,
 * however many triangles it has.
 *
 * Every figure is therefore assembled from primitives with:
 *   - a real contrapposto lean (nothing is bilaterally symmetric),
 *   - at least one broken or missing part per instance,
 *   - a per-instance rotation so no two face the same way.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Compose a local transform inside a prop's own frame, then into world. */
function local(px, py, pz, rx, ry, rz, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return _m.compose(_v.set(px, py, pz), _q, _s.set(sx, sy, sz));
}

/**
 * Collect a figure's parts in LOCAL space, merge them, then place the whole
 * thing once. Merging first means a statue is one contribution to the room's
 * stone bucket rather than nine, and it lets the caller rotate and scale the
 * finished figure without the parts drifting.
 */
class Figure {
  constructor() { this.parts = []; }
  add(geo, matrix) {
    const g = normalise(geo);
    if (matrix) g.applyMatrix4(matrix);
    this.parts.push(g);
    return this;
  }
  build() { return mergeAll(this.parts, true); }
}

// ===========================================================================
// statuary
// ===========================================================================

/**
 * A kneeling saint on a plinth: robed, head bowed, hands together. Broken in one
 * of four ways per instance so a row of them never repeats.
 */
export function kneelingSaint(B, o) {
  const rng = B.rng;
  const f = new Figure();
  const scale = o.scale ?? 1;
  const damage = rng.int(0, 3);

  // Plinth.
  f.add(blockGeo(1.05, 0.42, 1.05, rng, 0.03), local(0, 0.21, 0, 0, 0, 0));
  f.add(blockGeo(0.92, 0.14, 0.92, rng, 0.02), local(0, 0.48, 0, 0, 0, 0));

  // Robe: a tapered eight-sided mass, widest at the hem, with a fold cut into
  // it by a second offset prism. The fold is what stops it reading as a cone.
  f.add(prismGeo(0.56, 0.30, 1.02, 8, 0.18), local(0, 1.06, 0, 0.06, 0.3, 0.03));
  f.add(prismGeo(0.30, 0.24, 0.62, 6, -0.2), local(0.12, 1.62, 0.04, 0.10, 0.9, -0.05));

  // Shoulders and cowl.
  f.add(blockGeo(0.62, 0.26, 0.42, rng, 0.03), local(0.02, 1.94, 0.02, 0.04, 0.25, -0.06));
  // Arms folded forward — two short prisms angled in.
  f.add(prismGeo(0.115, 0.10, 0.62, 6, 0), local(-0.20, 1.72, 0.26, 1.05, 0, 0.28));
  f.add(prismGeo(0.115, 0.10, 0.62, 6, 0), local(0.20, 1.72, 0.26, 1.05, 0, -0.28));

  // Head, bowed. Missing entirely on damage type 0, which is the most striking
  // and the most common thing to happen to a stone saint.
  if (damage !== 0) {
    f.add(prismGeo(0.19, 0.15, 0.30, 8, 0), local(0.03, 2.16, 0.10, 0.34, 0.2, 0));
    f.add(prismGeo(0.22, 0.20, 0.14, 8, 0), local(0.03, 2.28, 0.06, 0.34, 0.2, 0)); // hood brim
  }
  // Weathered stump where an arm or the head broke away.
  if (damage === 1) f.add(rockGeo(0.16, 0, rng, 0.5), local(0.24, 1.70, 0.30, 0, 0, 0));

  const geo = f.build();
  if (!geo) return;
  B.push(o.mat ?? B.mat.wall, o.group ?? 'far', geo,
    matAt(o.x, o.y ?? 0, o.z, o.yaw ?? rng.range(0, Math.PI * 2), scale, scale, scale));
  B.solid(o.x, (o.y ?? 0) + 1.05 * scale, o.z, 0.55 * scale, 1.05 * scale, 0.55 * scale, 0, SURFACE.wall);
}

/**
 * A gargoyle crouched on a corbel: a hunched body, folded wings and a spout.
 * Placed high on a wall, so it is read almost entirely as silhouette against the
 * sky or against the fog — hence the wings, which are the only part that matters.
 */
export function gargoyle(B, o) {
  const rng = B.rng;
  const f = new Figure();
  // Corbel it crouches on.
  f.add(blockGeo(0.66, 0.30, 0.90, rng, 0.03), local(0, 0.15, 0.16, 0, 0, 0));
  // Body.
  f.add(prismGeo(0.30, 0.22, 0.62, 6, 0.3), local(0, 0.58, 0.10, 1.15, 0.1, 0));
  // Haunches.
  for (const s of [-1, 1]) {
    f.add(prismGeo(0.16, 0.11, 0.42, 5, 0), local(s * 0.22, 0.40, 0.02, 0.6, 0, s * 0.35));
  }
  // Head thrust forward with a spout.
  f.add(blockGeo(0.30, 0.24, 0.44, rng, 0.03), local(0, 0.74, 0.46, 0.25, 0, 0));
  f.add(prismGeo(0.10, 0.075, 0.44, 6, 0), local(0, 0.70, 0.72, 1.35, 0, 0));
  // Wings: two thin swept slabs. One is broken short on half the instances.
  const wingLen = 0.95;
  for (const s of [-1, 1]) {
    const broken = rng.float() < 0.45 && s < 0;
    f.add(blockGeo(0.07, 0.72, broken ? wingLen * 0.42 : wingLen, rng, 0.03),
      local(s * 0.30, 0.86, -0.14, -0.28, s * 0.45, s * 0.22));
  }
  const geo = f.build();
  if (!geo) return;
  B.push(o.mat ?? B.mat.wall, o.group ?? 'far', geo,
    matAt(o.x, o.y, o.z, o.yaw ?? 0, o.scale ?? 1, o.scale ?? 1, o.scale ?? 1));
}

/**
 * The broken angel: the arena's centrepiece. A colossal winged figure, snapped
 * at the waist, its upper half lying across the floor beside the stump.
 *
 * The most important prop in the level. It is the one silhouette in the game
 * that reads at 30 m, and it is what makes the boss arena a PLACE.
 */
export function brokenAngel(B, o) {
  const rng = B.rng;
  const yaw = o.yaw ?? 0;
  const S = o.scale ?? 1;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? 'far';

  // --- the standing stump: plinth, legs, drapery, snapped at the waist ------
  const stump = new Figure();
  stump.add(blockGeo(3.4, 0.55, 3.4, rng, 0.05), local(0, 0.27, 0, 0, 0, 0));
  stump.add(blockGeo(2.9, 0.30, 2.9, rng, 0.04), local(0, 0.68, 0, 0, 0, 0));
  stump.add(prismGeo(1.30, 0.86, 3.10, 10, 0.14), local(0, 2.36, 0, 0.02, 0.4, 0.015));
  // Drapery folds: three offset slabs down the front.
  for (let i = 0; i < 3; i++) {
    stump.add(blockGeo(0.28, 2.2 - i * 0.4, 0.22, rng, 0.03),
      local(-0.45 + i * 0.45, 1.9 + i * 0.15, 0.82 - i * 0.06, 0.03, rng.range(-0.2, 0.2), rng.range(-0.06, 0.06)));
  }
  // The break: a jagged plane of rubble where the torso came away.
  for (let i = 0; i < 7; i++) {
    const a = rng.range(0, 6.283);
    const r = rng.range(0.1, 0.82);
    stump.add(rockGeo(rng.range(0.18, 0.38), 0, rng, 0.55),
      local(Math.cos(a) * r, 3.86 + rng.range(-0.12, 0.16), Math.sin(a) * r, rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)));
  }
  // One wing still attached, rising behind — the vertical in the silhouette.
  const wing = new Figure();
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    wing.add(blockGeo(0.20, 3.4 - t * 1.9, 0.5 + t * 0.4, rng, 0.05),
      local(-0.1 - t * 0.55, 3.4 + t * 1.5, -0.9 - t * 0.75, -0.18 - t * 0.1, 0, -0.22 - t * 0.16));
  }
  const wingGeo = wing.build();
  if (wingGeo) stump.parts.push(normalise(wingGeo));

  const stumpGeo = stump.build();
  if (stumpGeo) {
    B.push(mat, group, stumpGeo, matAt(o.x, o.y ?? 0, o.z, yaw, S, S, S));
    B.solid(o.x, (o.y ?? 0) + 2.0 * S, o.z, 1.6 * S, 2.0 * S, 1.6 * S, yaw, SURFACE.wall);
  }

  // --- the fallen torso, lying across the floor ----------------------------
  const torso = new Figure();
  torso.add(prismGeo(1.15, 0.78, 2.5, 9, -0.1), local(0, 0, 0, 0, 0.2, 0));
  torso.add(blockGeo(1.5, 0.62, 0.9, rng, 0.05), local(0, 1.45, 0.05, 0, 0.15, 0));       // shoulders
  torso.add(prismGeo(0.44, 0.36, 0.7, 8, 0), local(0.06, 2.0, 0.1, 0.1, 0.2, 0.06));      // head
  // An arm flung out, and a hand that broke off a metre away.
  torso.add(prismGeo(0.22, 0.17, 1.7, 6, 0), local(-0.85, 1.25, 0.15, 0.2, 0, 1.1));
  const torsoGeo = torso.build();
  if (torsoGeo) {
    const tx = o.x + Math.cos(yaw + 1.1) * 4.6 * S;
    const tz = o.z - Math.sin(yaw + 1.1) * 4.6 * S;
    // Lying on its side, half buried: rotate 82° about the fall direction.
    _e.set(0, yaw + 1.1, Math.PI * 0.46);
    _q.setFromEuler(_e);
    _m.compose(_v.set(tx, (o.y ?? 0) + 0.85 * S, tz), _q, _s.set(S, S, S));
    B.push(mat, group, torsoGeo, _m);
    B.solid(tx, (o.y ?? 0) + 0.7 * S, tz, 1.5 * S, 0.7 * S, 1.5 * S, yaw + 1.1, SURFACE.wall);
  }
}

// ===========================================================================
// tombs and altars
// ===========================================================================

/**
 * A sarcophagus: a chest with a moulded lid, sometimes slid open, sometimes
 * with a recumbent effigy carved on top.
 *
 * `open` is the interesting case — a shifted lid puts a black slot in the middle
 * of the prop, and the eye reads the darkness as a hole rather than as a shadow,
 * which is what makes a crypt feel disturbed.
 */
export function sarcophagus(B, o) {
  const rng = B.rng;
  const f = new Figure();
  const L = o.length ?? 2.35;
  const W = o.width ?? 1.05;
  const H = o.height ?? 0.78;
  const open = o.open ?? rng.float() < 0.4;

  f.add(blockGeo(W + 0.22, 0.14, L + 0.22, rng, 0.02), local(0, 0.07, 0, 0, 0, 0));   // base course
  f.add(blockGeo(W, H, L, rng, 0.035), local(0, H * 0.5 + 0.1, 0, 0, 0, 0));           // chest
  // Blind arcading along the long sides — the standard tomb-chest decoration and
  // the reason a sarcophagus does not read as a crate.
  const arcs = Math.max(3, Math.round(L / 0.55));
  for (let i = 0; i < arcs; i++) {
    const z = -L * 0.5 + (L / arcs) * (i + 0.5);
    for (const s of [-1, 1]) {
      f.add(blockGeo(0.09, H * 0.62, 0.09, rng, 0.01), local(s * (W * 0.5 + 0.02), H * 0.52, z, 0, 0, 0));
    }
  }
  // Lid, possibly slid off.
  const slide = open ? rng.range(0.22, 0.55) : 0;
  const tilt = open ? rng.range(0.03, 0.11) : 0;
  f.add(blockGeo(W + 0.16, 0.20, L + 0.16, rng, 0.03),
    local(open ? rng.range(-0.14, 0.14) : 0, H + 0.20, slide * L * 0.5, tilt, rng.range(-0.02, 0.02), 0));
  if (!open && rng.float() < 0.55) {
    // Recumbent effigy: a low relief figure, abstracted to three masses.
    f.add(prismGeo(0.30, 0.24, L * 0.62, 8, 0), local(0, H + 0.40, -0.05, Math.PI * 0.5, 0, 0));
    f.add(prismGeo(0.16, 0.13, 0.24, 8, 0), local(0, H + 0.42, -L * 0.34, Math.PI * 0.5, 0, 0));
    f.add(blockGeo(0.34, 0.10, 0.30, rng, 0.02), local(0, H + 0.44, L * 0.16, 0, 0, 0));  // hands on the chest
  }

  const geo = f.build();
  if (!geo) return;
  const yaw = o.yaw ?? 0;
  B.push(o.mat ?? B.mat.wall, o.group ?? 'far', geo, matAt(o.x, o.y ?? 0, o.z, yaw));
  B.solid(o.x, (o.y ?? 0) + (H + 0.3) * 0.5, o.z, W * 0.62, (H + 0.3) * 0.5, L * 0.62, yaw, SURFACE.wall);
  return { open };
}

/**
 * An altar: a mensa slab on a moulded base, with a reredos behind it.
 * The reredos is where the level's one violet accent goes in the cathedral.
 */
export function altar(B, o) {
  const rng = B.rng;
  const f = new Figure();
  f.add(blockGeo(2.3, 0.22, 1.15, rng, 0.02), local(0, 0.11, 0, 0, 0, 0));
  f.add(blockGeo(1.75, 0.72, 0.82, rng, 0.03), local(0, 0.58, 0, 0, 0, 0));
  f.add(blockGeo(2.45, 0.18, 1.25, rng, 0.02), local(0, 1.03, 0, 0.004, 0, 0.003));  // mensa, not quite level
  const geo = f.build();
  if (geo) B.push(o.mat ?? B.mat.wall, o.group ?? 'far', geo, matAt(o.x, o.y ?? 0, o.z, o.yaw ?? 0));
  B.solid(o.x, (o.y ?? 0) + 0.6, o.z, 1.25, 0.6, 0.65, o.yaw ?? 0, SURFACE.wall);
}

/**
 * The shrine monolith: a leaning slab of rune-carved stone.
 *
 * Uses the `arcane.rune` recipe, whose emissive colour is read out of
 * `palette.ELEMENTS.shadow` by the materials library — nothing here hardcodes a
 * spell colour, and the whole game's violet identity therefore stays in one file.
 */
export function runeMonolith(B, o) {
  const rng = B.rng;
  const h = o.height ?? 3.6;
  const w = o.width ?? 1.25;
  const geo = blockGeo(w, h, w * 0.62, rng, 0.06);
  B.push(B.mat.rune, 'rune', geo, matAt(o.x, (o.y ?? 0) + h * 0.5, o.z, o.yaw ?? 0));
  B.solid(o.x, (o.y ?? 0) + h * 0.5, o.z, w * 0.6, h * 0.5, w * 0.4, o.yaw ?? 0, SURFACE.crystal);

  // Shards of the same stone driven into the ground around it. Small, angled
  // outward, and the thing that turns one slab into a shrine.
  const n = o.shards ?? 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const r = rng.range(1.5, 2.9);
    const sh = rng.range(0.5, 1.5);
    _e.set(rng.range(0.1, 0.34) * Math.cos(a), rng.range(0, 6.283), rng.range(0.1, 0.34) * Math.sin(a));
    _q.setFromEuler(_e);
    _m.compose(_v.set(o.x + Math.cos(a) * r, (o.y ?? 0) + sh * 0.42, o.z + Math.sin(a) * r), _q, _s.set(1, 1, 1));
    B.push(B.mat.rune, 'rune', prismGeo(rng.range(0.12, 0.26), 0.04, sh, 5, 0), _m);
  }
}

// ===========================================================================
// ironwork
// ===========================================================================

/**
 * A portcullis: a grid of iron bars in a stone opening, raised part-way.
 *
 * Half-raised on purpose. A closed grille blocks the sightline the `depth` shot
 * exists to show; a fully raised one is invisible. Left hanging, it puts a row
 * of vertical bars across the top of the gate arch and their shadows across the
 * floor, which is the single strongest cue that the corridor beyond is lit.
 */
export function portcullis(B, o) {
  const rng = B.rng;
  const w = o.width ?? 4.2;
  const h = o.height ?? 4.0;
  const bars = Math.max(4, Math.round(w / 0.55));
  const raised = o.raised ?? rng.range(0.42, 0.62);
  const f = new Figure();

  for (let i = 0; i < bars; i++) {
    const x = -w * 0.5 + (w / (bars - 1)) * i;
    f.add(prismGeo(0.055, 0.05, h, 4, 0), local(x, h * 0.5, 0, 0, rng.range(0, 0.8), rng.range(-0.006, 0.006)));
    // Spiked foot.
    f.add(prismGeo(0.07, 0.005, 0.26, 4, 0), local(x, -0.13, 0, 0, 0.4, 0));
  }
  const rails = 3;
  for (let j = 0; j < rails; j++) {
    const y = h * (0.22 + 0.32 * j);
    f.add(blockGeo(w + 0.1, 0.075, 0.075, rng, 0.005), local(0, y, 0, 0, 0, rng.range(-0.004, 0.004)));
  }
  const geo = f.build();
  if (!geo) return;
  B.push(B.mat.iron, 'iron', geo, matAt(o.x, (o.y ?? 0) + raised * h, o.z, o.yaw ?? 0));
  // The bar bottoms hang above head height, so no collider: the player walks
  // under it, which is the whole point of leaving it raised.
}

/**
 * A hinged iron gate in a doorway — two leaves, one swung open.
 */
export function ironGate(B, o) {
  const rng = B.rng;
  const w = (o.width ?? 2.6) * 0.5;
  const h = o.height ?? 2.9;
  const leaf = (swing) => {
    const f = new Figure();
    const bars = Math.max(3, Math.round(w / 0.42));
    for (let i = 0; i < bars; i++) {
      const x = (w / bars) * (i + 0.5);
      f.add(prismGeo(0.038, 0.034, h, 4, 0), local(x, h * 0.5, 0, 0, 0.3, 0));
    }
    f.add(blockGeo(w, 0.07, 0.07, rng, 0.004), local(w * 0.5, h * 0.18, 0, 0, 0, 0));
    f.add(blockGeo(w, 0.07, 0.07, rng, 0.004), local(w * 0.5, h * 0.78, 0, 0, 0, 0));
    f.add(prismGeo(0.055, 0.05, h, 4, 0), local(0, h * 0.5, 0, 0, 0, 0));   // hanging stile
    const g = f.build();
    if (!g) return;
    _e.set(0, (o.yaw ?? 0) + swing.a, 0);
    _q.setFromEuler(_e);
    _m.compose(_v.set(o.x + swing.x, o.y ?? 0, o.z + swing.z), _q, _s.set(swing.mirror ?? 1, 1, 1));
    B.push(B.mat.iron, 'iron', g, _m);
  };
  const cy = Math.cos(o.yaw ?? 0), sy = Math.sin(o.yaw ?? 0);
  leaf({ x: -cy * w, z: sy * w, a: rng.range(0.9, 1.5), mirror: 1 });
  leaf({ x: cy * w, z: -sy * w, a: -rng.range(0.05, 0.25), mirror: -1 });
}

/**
 * A hanging chain with something on the end — a ring, a censer, or nothing.
 * Chains hang from the arena's lost dome and from the undercroft's ceiling, and
 * they are the only vertical line in a room that is otherwise all horizontals.
 */
export function hangingChain(B, o) {
  const rng = B.rng;
  const links = o.links ?? Math.round((o.length ?? 4) / 0.28);
  const geo = chainGeo(links, 0.28, 0.035);
  if (!geo) return;
  // A slight sway baked in per instance: chains are never plumb.
  const lean = rng.range(0.01, 0.05);
  _e.set(lean, rng.range(0, 6.283), rng.range(-0.03, 0.03));
  _q.setFromEuler(_e);
  _m.compose(_v.set(o.x, o.y, o.z), _q, _s.set(1, 1, 1));
  B.push(B.mat.iron, 'iron', geo, _m);

  if (o.ring) {
    const r = new THREE.TorusGeometry(o.ringRadius ?? 0.45, 0.045, 4, 14);
    r.rotateX(Math.PI * 0.5);
    B.push(B.mat.iron, 'iron', r, matAt(o.x, o.y - links * 0.28 - 0.1, o.z, rng.range(0, 3.1)));
  }
}

/**
 * A tattered banner hanging from a wall or a rib.
 *
 * Uses the `cloth.banner` surface, which carries a real ALPHA channel — the
 * bottom edge is genuinely ragged rather than a straight cut, which is the only
 * way a hanging cloth reads at this distance. Built as a subdivided plane with a
 * baked catenary sag and a slow twist, so it is not a flat card.
 */
export function banner(B, o) {
  const rng = B.rng;
  const w = o.width ?? 1.15;
  const h = o.height ?? 3.2;
  const g = new THREE.PlaneGeometry(w, h, 3, 8);
  const pos = g.attributes.position;
  const twist = rng.range(-0.25, 0.25);
  const bow = rng.range(0.05, 0.16);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const t = (h * 0.5 - y) / h;             // 0 at the top, 1 at the hem
    // Cloth hanging from a rod: it bows away from the wall and the hem swings.
    pos.setZ(i, -Math.sin(t * Math.PI) * bow - t * t * 0.10);
    pos.setX(i, x * (1 + t * 0.06) + Math.sin(t * 3.0 + twist) * 0.05);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  // UVs in metres so the weave lands at its natural density.
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  uv.needsUpdate = true;

  B.push(B.mat.banner, 'cloth', g, matAt(o.x, o.y, o.z, o.yaw ?? 0), 'keep');

  // The rod it hangs from.
  const rod = prismGeo(0.035, 0.035, w * 1.25, 5, 0);
  rod.rotateZ(Math.PI * 0.5);
  B.push(B.mat.iron, 'iron', rod, matAt(o.x, o.y + h * 0.5 + 0.04, o.z, o.yaw ?? 0));
}

// ===========================================================================
// organic / ruin
// ===========================================================================

/**
 * A root system breaking through the masonry: a thick trunk emerging from a
 * joint, splitting into tapering branches that run along the wall and floor.
 *
 * Recursive, depth-limited to 3. Roots are the only NON-ORTHOGONAL, non-straight
 * thing in the level's architecture, and that contrast is exactly why they read
 * as nature reclaiming a building.
 */
export function roots(B, o) {
  const rng = B.rng;
  const parts = new Figure();

  const branch = (px, py, pz, dx, dy, dz, r, len, depth) => {
    const steps = Math.max(2, Math.round(len / 0.34));
    let cx = px, cy = py, cz = pz;
    let vx = dx, vy = dy, vz = dz;
    let rad = r;
    for (let i = 0; i < steps; i++) {
      const seg = len / steps;
      // Wander: roots follow the mortar and then give up and dive.
      vx += rng.range(-0.35, 0.35) * seg;
      vy += (rng.range(-0.45, 0.15) - 0.20) * seg;
      vz += rng.range(-0.35, 0.35) * seg;
      const l = Math.hypot(vx, vy, vz) || 1;
      vx /= l; vy /= l; vz /= l;
      const nx = cx + vx * seg, ny = cy + vy * seg, nz = cz + vz * seg;
      const g = prismGeo(rad, rad * 0.86, seg * 1.12, 5, rng.range(-0.4, 0.4));
      // Orient the segment along the travel direction.
      const yaw = Math.atan2(vx, vz);
      const pitch = Math.acos(Math.max(-1, Math.min(1, vy)));
      _e.set(pitch, yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_v.set((cx + nx) * 0.5, (cy + ny) * 0.5, (cz + nz) * 0.5), _q, _s.set(1, 1, 1));
      parts.add(g, _m);
      cx = nx; cy = ny; cz = nz;
      rad *= 0.90;
      if (depth < 3 && i > 0 && rng.float() < 0.30) {
        branch(cx, cy, cz, vx + rng.signed() * 0.8, vy * 0.4, vz + rng.signed() * 0.8,
          rad * 0.62, len * rng.range(0.35, 0.6), depth + 1);
      }
    }
  };

  const n = o.count ?? 2;
  for (let i = 0; i < n; i++) {
    branch(
      o.x + rng.range(-0.4, 0.4), o.y + rng.range(0, 0.5), o.z + rng.range(-0.4, 0.4),
      (o.dx ?? 0) + rng.range(-0.3, 0.3), -0.25, (o.dz ?? 0) + rng.range(-0.3, 0.3),
      o.radius ?? 0.14, o.length ?? 2.6, 1
    );
  }
  const geo = parts.build();
  if (geo) B.push(B.mat.root, 'root', geo, null);
}

/**
 * A broken weapon half-buried in the floor: a blade or a haft driven in at an
 * angle, with a hilt. Reads as a battlefield the moment there is more than one.
 */
export function brokenWeapon(B, o) {
  const rng = B.rng;
  const f = new Figure();
  const kind = rng.int(0, 2);
  if (kind === 0) {
    // Sword, snapped, point down.
    f.add(blockGeo(0.09, 1.05, 0.022, rng, 0.008), local(0, 0.52, 0, 0, 0, 0));
    f.add(blockGeo(0.34, 0.05, 0.05, rng, 0.004), local(0, 1.02, 0, 0, 0, 0));
    f.add(prismGeo(0.035, 0.03, 0.30, 5, 0), local(0, 1.18, 0, 0, 0, 0));
  } else if (kind === 1) {
    // Spear haft with a leaf head.
    f.add(prismGeo(0.030, 0.026, 1.6, 5, 0), local(0, 0.8, 0, 0, 0, 0));
    f.add(blockGeo(0.07, 0.34, 0.02, rng, 0.006), local(0, 1.72, 0, 0, 0, 0));
  } else {
    // Shield boss and a splintered rim.
    f.add(prismGeo(0.42, 0.30, 0.07, 8, 0), local(0, 0.05, 0, Math.PI * 0.44, 0, 0));
    f.add(prismGeo(0.11, 0.06, 0.12, 6, 0), local(0, 0.16, 0.05, Math.PI * 0.44, 0, 0));
  }
  const geo = f.build();
  if (!geo) return;
  const lean = rng.range(0.15, 0.55) * (rng.float() < 0.5 ? 1 : -1);
  _e.set(lean, rng.range(0, 6.283), rng.range(-0.2, 0.2));
  _q.setFromEuler(_e);
  _m.compose(_v.set(o.x, (o.y ?? 0) - 0.08, o.z), _q, _s.set(1, 1, 1));
  B.push(kind === 2 ? B.mat.iron : B.mat.steel, 'iron', geo, _m);
}

/** A stone urn / reliquary jar, for niches and altar steps. */
export function urn(B, o) {
  const rng = B.rng;
  const f = new Figure();
  const h = o.height ?? 0.5;
  f.add(prismGeo(h * 0.30, h * 0.46, h * 0.55, 8, 0.1), local(0, h * 0.30, 0, 0, 0, 0));
  f.add(prismGeo(h * 0.46, h * 0.22, h * 0.40, 8, 0.1), local(0, h * 0.75, 0, 0, 0, 0));
  if (rng.float() < 0.7) f.add(prismGeo(h * 0.26, h * 0.10, h * 0.14, 8, 0), local(0, h * 1.00, 0, 0, 0, 0));
  const geo = f.build();
  if (geo) B.push(o.mat ?? B.mat.wall, o.group ?? 'far', geo, matAt(o.x, o.y ?? 0, o.z, rng.range(0, 3.14)));
}

// ===========================================================================
// instanced debris — see build.js for how these become InstancedMesh
// ===========================================================================

/**
 * Scatter debris of one kind inside a rectangle, avoiding a keep-out list.
 *
 * Instanced rather than merged, for one specific reason: `materials`' per-
 * instance variation hashes `instanceMatrix[3].xyz`, so every instance of a
 * scattered rock gets its own value, hue, roughness and UV offset for free. Merge
 * them and the whole scatter shares one hash and reads as a hundred copies of the
 * same stone.
 */
export function scatter(B, o) {
  const rng = B.rng;
  const n = o.count | 0;
  if (n <= 0) return;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    let x = 0, z = 0, ok = false;
    // Rejection sampling against the keep-outs. Ten tries then give up: a
    // debris instance that cannot find a spot simply is not placed, which is
    // cheaper and safer than pushing it somewhere invalid.
    for (let t = 0; t < 10 && !ok; t++) {
      x = o.x + rng.range(-o.hw, o.hw);
      z = o.z + rng.range(-o.hd, o.hd);
      ok = true;
      if (o.avoid) {
        for (const a of o.avoid) {
          if (Math.abs(x - a.x) < a.r && Math.abs(z - a.z) < a.r) { ok = false; break; }
        }
      }
      if (ok && o.ring) {
        const d = Math.hypot(x - o.x, z - o.z);
        if (d < o.ring[0] || d > o.ring[1]) ok = false;
      }
    }
    if (!ok) continue;

    const s = rng.range(o.scale[0], o.scale[1]);
    e.set(
      o.upright ? rng.range(-0.12, 0.12) : rng.range(0, 6.283),
      rng.range(0, 6.283),
      o.upright ? rng.range(-0.12, 0.12) : rng.range(0, 6.283)
    );
    q.setFromEuler(e);
    p.set(x, (o.y ?? 0) + (o.lift ?? 0) + rng.range(-0.04, 0.06), z);
    sc.set(s * rng.range(0.82, 1.22), s * rng.range(0.7, 1.1), s * rng.range(0.82, 1.22));
    B.instance(o.mat, o.kind, m.compose(p, q, sc));
  }
}

/** The geometry factories the instanced debris kinds resolve to. Keyed by name
 *  so `build.js` can create exactly one geometry per kind for the whole level. */
export function debrisGeometry(kind, rng) {
  switch (kind) {
    case 'rock': return rockGeo(0.5, 0, rng, 0.34);
    case 'rockBig': return rockGeo(0.85, 1, rng, 0.28);
    case 'slab': return blockGeo(0.9, 0.22, 0.7, rng, 0.09);
    case 'bone': return boneGeo(0.46, 0.045, rng);
    case 'skull': return skullGeo(0.115);
    case 'shard': return prismGeo(0.14, 0.02, 0.55, 4, 0.3);
    case 'brick': return blockGeo(0.42, 0.20, 0.26, rng, 0.05);
    default: return rockGeo(0.4, 0, rng, 0.3);
  }
}
