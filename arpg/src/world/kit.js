import * as THREE from 'three';
import { ARCH, SURFACE } from './tuning.js';
import {
  blockGeo, prismGeo, archRingGeo, archedWallGeo, ribVaultGeo, ribGeo,
  roseWindowGeo, stairsGeo, floorGeo, normalise, mergeAll,
} from './geom.js';

/**
 * MONARCH — the modular gothic kit.
 *
 * Every function here takes a `Builder` (see build.js) and emits masonry into
 * it. Nothing returns a mesh: geometry goes into the builder's buckets and is
 * merged once per material at the end, so a whole cathedral is a handful of
 * draw calls.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT SHAPES EVERY PIECE IN THIS FILE
 *
 * "NOTHING PERFECTLY STRAIGHT OR REPEATED." A grid of identical arches is the
 * single most common tell of procedural architecture, so every function takes
 * the builder's seeded RNG and varies:
 *
 *   - bay WIDTH, not just bay contents (a real arcade has an irregular last bay
 *     where it met the wall it was built up to),
 *   - arch RISE within ±6% (masons worked to a template, not to a CAD model),
 *   - block sizes, mortar joint widths and corner chips per stone,
 *   - which pieces are broken, and how far,
 *   - a fraction of a degree of lean on anything vertical.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER RULE: WHICH SIDE OF THE ROOM IT IS ON
 *
 * The camera eye sits at +X +Y +Z of its focus. So −X/−Z geometry is BACKDROP
 * (seen in full elevation, gets all the height and all the tracery) and +X/+Z
 * geometry is CAMERA-SIDE (stands between lens and player, must be low or open,
 * and goes into the `near` bucket so `render.registerOccluderFade` can test a
 * bounding sphere that actually bounds it).
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
/** Scratch scale vector. Never the same object as the position passed to
 *  `Matrix4.compose`, which reads all three arguments. */
const _s = new THREE.Vector3(1, 1, 1);

/** Which mesh group a piece belongs to, from the side of the room it is on.
 *  `nx`/`nz` are the outward normal of the wall in world space. */
export function sideGroup(nx, nz) {
  return nx > 0.3 || nz > 0.3 ? 'near' : 'far';
}

// ===========================================================================
// doorways
// ===========================================================================

/**
 * The stretches of a wall run that are NOT inside a doorway.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS IN `wallRun` AND NOT IN EACH ROOM BUILDER
 *
 * The previous version left every hole to the builder that owned the wall, via
 * hand-placed `wallWithGap` calls whose gap parameter was a fraction along the
 * run. Measured against `ai`'s navigation grid, five of nine rooms were then
 * unreachable from the spawn: a doorway is a property of the LINK between two
 * rooms, the wall that has to open for it may belong to either room, and any
 * scheme where each builder independently remembers to leave a gap fails the
 * first time a seeded dimension moves a wall.
 *
 * So `layout.js` publishes a link's threshold as a circle, `Builder.openings`
 * carries every circle that touches this room, and EVERY wall run in the kit
 * splits itself around them — core, plinth, string course, proud stones, broken
 * top and collision, all from the same list. A doorway is therefore constructed
 * by the same data that navigation reads, and the two cannot disagree.
 *
 * Returned as [t0, t1] pairs in run-local coordinates, i.e. −len/2 … +len/2.
 */
export function openSegments(B, cx, cz, ux, uz, len) {
  const ops = B?.openings;
  const segs = [[-len * 0.5, len * 0.5]];
  if (!ops || !ops.length) return segs;
  for (const o of ops) {
    const rx = o.x - cx, rz = o.z - cz;
    const along = rx * ux + rz * uz;
    const across = Math.abs(rx * uz - rz * ux);
    if (across >= o.r) continue;                       // this run misses the doorway
    const half = Math.sqrt(o.r * o.r - across * across);
    const h0 = along - half, h1 = along + half;
    for (let i = segs.length - 1; i >= 0; i--) {
      const [a, b] = segs[i];
      if (h1 <= a || h0 >= b) continue;                // no intersection
      segs.splice(i, 1);
      if (h0 - a > 0.35) segs.splice(i, 0, [a, h0]);
      if (b - h1 > 0.35) segs.splice(i, 0, [h1, b]);
    }
  }
  return segs;
}

/** Is this world point inside one of the room's doorways? Anything SOLID —
 *  a pier, a tomb, a brazier — asks before it is placed. */
export function inOpening(B, x, z, extra = 0) {
  const ops = B?.openings;
  if (!ops) return false;
  for (const o of ops) {
    const r = o.r + extra;
    if ((x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < r * r) return true;
  }
  return false;
}

// ===========================================================================
// walls
// ===========================================================================

/**
 * A straight wall run from (x0,z0) to (x1,z1).
 *
 * Built as a solid core plus applied detail rather than as thousands of
 * individual blocks. The masonry COURSING comes from the granite surface's baked
 * texture and its parallax, which resolves at 2.4 m per repeat; what geometry
 * has to supply is the stuff a texture cannot fake at this camera pitch:
 *
 *   - a plinth that projects, so the wall/floor junction has a real shadow line
 *     instead of a seam,
 *   - a string course at 3.4 m breaking the elevation horizontally,
 *   - individual stones standing proud by 5–12 cm, catching the brazier on their
 *     top arris, which is what stops a wall reading as a printed panel,
 *   - a broken, uneven top edge when `ruin > 0`.
 *
 * ~30 boxes per run. A wall of 400 individual blocks was tried first and cost
 * 6.3k triangles for a difference that vanished beyond four metres.
 */
export function wallRun(B, o) {
  const { x0, z0, x1, z1 } = o;
  const height = o.height ?? 4.0;
  const thick = o.thick ?? ARCH.wallThick;
  const mat = o.mat ?? B.mat.wall;
  const ruin = o.ruin ?? 0;
  const rng = B.rng;

  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return;
  const yaw = Math.atan2(dx, dz);          // rotation about Y that maps +Z to the run
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  // Outward normal: perpendicular to the run, pointing away from the room centre.
  const nx = o.nx ?? 0, nz = o.nz ?? 0;
  const group = o.group ?? sideGroup(nx, nz);

  const put = (geo, lx, ly, lz, extraYaw = 0) => {
    _e.set(0, yaw + extraYaw, 0);
    _q.setFromEuler(_e);
    _m.compose(
      _v.set(cx + Math.cos(yaw) * lx + Math.sin(yaw) * lz, ly, cz - Math.sin(yaw) * lx + Math.cos(yaw) * lz),
      _q, _s.set(1, 1, 1)
    );
    B.push(mat, group, geo, _m);
  };

  // Doorways. Everything below is built per surviving stretch, so a wall that a
  // link crosses opens for it — including its collider.
  const ux = dx / len, uz = dz / len;
  const segs = o.solidRun ? [[-len * 0.5, len * 0.5]] : openSegments(B, cx, cz, ux, uz, len);
  const inHole = (t) => {
    for (const s of segs) if (t >= s[0] && t <= s[1]) return false;
    return true;
  };

  // --- core -----------------------------------------------------------------
  const coreH = height * (ruin > 0 ? 0.86 : 1.0);
  const pH = o.plinth ?? ARCH.plinth;
  const sc = o.stringCourse ?? (height > 5 ? ARCH.stringCourse : 0);
  for (const [s0, s1] of segs) {
    const sl = s1 - s0, sm = (s0 + s1) * 0.5;
    put(blockGeo(thick, coreH, sl, rng, 0.03), 0, coreH * 0.5, sm);
    B.solid(
      cx + Math.cos(yaw) * 0 + Math.sin(yaw) * sm, coreH * 0.5,
      cz - Math.sin(yaw) * 0 + Math.cos(yaw) * sm,
      thick * 0.5, coreH * 0.5, sl * 0.5, yaw, o.surface ?? SURFACE.wall
    );
    // --- plinth -------------------------------------------------------------
    if (pH > 0) put(blockGeo(thick + 0.34, pH, sl, rng, 0.02), 0, pH * 0.5, sm);
    // --- string course ------------------------------------------------------
    if (sc > 0 && sc < coreH - 0.4) put(blockGeo(thick + 0.22, 0.28, sl, rng, 0.02), 0, sc, sm);
    // A doorway cut through a thick wall shows its REVEAL, and a reveal with no
    // edge treatment reads as a hole punched in cardboard. One jamb stone at
    // each end of each surviving stretch, projecting slightly, is the whole fix.
    if (sl < len - 0.5) {
      for (const [t, at] of [[s0, s0 === -len * 0.5], [s1, s1 === len * 0.5]]) {
        if (at) continue;
        put(blockGeo(thick + 0.16, Math.min(coreH, height * 0.92), 0.34, rng, 0.02),
          0, Math.min(coreH, height * 0.92) * 0.5, t + (t < sm ? 0.17 : -0.17));
      }
    }
  }

  // --- proud stones ---------------------------------------------------------
  // Only in the lower 4.5 m: above that the camera never gets close enough for
  // a 8 cm projection to be worth a draw's worth of vertices.
  const proud = Math.max(2, Math.round(len * 0.55));
  for (let i = 0; i < proud; i++) {
    const bw = rng.range(0.55, 1.35);
    const bh = rng.range(0.26, 0.52);
    const along = rng.range(-len * 0.5 + bw, len * 0.5 - bw);
    const y = rng.range(pH + 0.15, Math.min(coreH - 0.4, 4.5));
    const out = rng.range(0.045, 0.115);
    if (inHole(along)) continue;
    put(blockGeo(thick + out * 2, bh, bw, rng, 0.035), 0, y, along);
  }

  // --- broken top -----------------------------------------------------------
  if (ruin > 0) {
    const merlons = Math.max(3, Math.round(len / rng.range(1.1, 2.2)));
    for (let i = 0; i < merlons; i++) {
      if (rng.float() < ruin * 0.55) continue;      // this stretch has fallen
      const w = (len / merlons) * rng.range(0.72, 1.0);
      const h = (height - coreH) * rng.range(0.35, 1.25);
      const along = -len * 0.5 + (len / merlons) * (i + 0.5);
      if (inHole(along)) continue;
      put(blockGeo(thick * rng.range(0.8, 1.0), h, w, rng, 0.05), 0, coreH + h * 0.5, along);
    }
  }
}

/**
 * A low camera-side wall: a plinth wall with piers, i.e. what you build when the
 * room must be enclosed but the lens has to see over it.
 *
 * This is the answer to "anything taller than 4 m near the player will occlude
 * them" — rather than fading a tall wall out and leaving a hole in the space,
 * the +X/+Z sides are genuinely low, and read as a chancel screen or a
 * balustrade, which is architecture rather than a compromise.
 */
export function lowWall(B, o) {
  const height = o.height ?? ARCH.hallCamSide;
  wallRun(B, { ...o, height, thick: o.thick ?? ARCH.partitionThick, plinth: 0.28, stringCourse: 0, ruin: o.ruin ?? 0.25 });

  // Piers punctuating it, carrying nothing — which is exactly what a ruined
  // arcade looks like once the arches above have gone.
  const { x0, z0, x1, z1 } = o;
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / (o.pierSpacing ?? 6.5)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    if (inOpening(B, x, z, 0.4)) continue;
    const h = height + B.rng.range(0.5, 1.55);
    const r = B.rng.range(0.34, 0.46);
    B.push(o.mat ?? B.mat.wall, o.group ?? 'near',
      prismGeo(r * 1.12, r, h, 6, B.rng.range(-0.08, 0.08)), matAt(x, h * 0.5, z, B.rng.range(0, 3.14)));
    B.solid(x, h * 0.5, z, r, h * 0.5, r, 0, SURFACE.wall);
  }
}

/** Local helper: a translation+yaw matrix without allocating. */
function matAt(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(0, ry, 0);
  _q.setFromEuler(_e);
  _m.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
  return _m;
}
export { matAt };

/**
 * A wall run with an arched opening in it. Used for every doorway, gate mouth
 * and window in the level.
 *
 * The opening is real: the reveal has the wall's full thickness and the arch has
 * voussoirs, so at this camera pitch you can see INTO the jamb, which is the
 * difference between a doorway and a hole.
 */
export function archedWall(B, o) {
  const width = o.width;
  const height = o.height ?? 5.0;
  const thick = o.thick ?? ARCH.wallThick;
  const span = o.span ?? Math.min(width - 1.6, 3.4);
  const sill = o.sill ?? 0;
  /**
   * HEADROOM. An arch apex is `sill + span/2 · rise`, and the lintel above it is
   * a real collider. `ai`'s navigation grid marks a cell solid if anything is
   * within 1.9 m of the floor, so the crypt door — 3.4 m span at rise 1.15,
   * apex 1.96 m — was a doorway no actor could path through, and the four rooms
   * behind it were unreachable. A doorway a character cannot walk under is not a
   * doorway, so a ground-level opening's rise is raised until its apex clears.
   */
  const minHead = o.minHead ?? (sill < 0.25 ? 2.75 : 0);
  let rise = o.rise ?? ARCH.archRise * B.rng.range(0.94, 1.06);
  if (minHead > 0) rise = Math.max(rise, (2 * (minHead - sill)) / span);
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? sideGroup(o.nx ?? 0, o.nz ?? 0);

  const geo = archedWallGeo(width, height, thick, span, rise, sill, B.rng);
  if (geo) B.push(mat, group, geo, matAt(o.x, 0, o.z, o.yaw ?? 0));

  // Collision: two jambs and a lintel, so the player can walk through the hole
  // but not through the wall.
  const jamb = (width - span) * 0.5;
  const cy = Math.cos(o.yaw ?? 0), sy = Math.sin(o.yaw ?? 0);
  const apex = sill + span * 0.5 * rise;
  if (jamb > 0.05) {
    for (const s of [-1, 1]) {
      const ox = s * (span * 0.5 + jamb * 0.5);
      B.solid(o.x + cy * ox, height * 0.5, o.z - sy * ox, jamb * 0.5, height * 0.5, thick * 0.5, o.yaw ?? 0, SURFACE.wall);
    }
  }
  if (height > apex + 0.1) {
    B.solid(o.x, (height + apex) * 0.5, o.z, span * 0.5, (height - apex) * 0.5, thick * 0.5, o.yaw ?? 0, SURFACE.wall);
  }
  if (sill > 0.1) {
    B.solid(o.x, sill * 0.5, o.z, span * 0.5, sill * 0.5, thick * 0.5, o.yaw ?? 0, SURFACE.wall);
  }
}

/**
 * Stepped buttress standing off a wall face. Two or three diminishing stages
 * with a weathered set-off between each.
 *
 * Buttresses are the cheapest silhouette in gothic architecture: they turn a
 * flat elevation into a rhythm of light and shadow, and at 45° yaw the camera
 * sees their return faces, so each one reads as a solid mass rather than as a
 * pilaster strip.
 */
export function buttress(B, o) {
  if (inOpening(B, o.x, o.z, 0.6)) return;
  const h = o.height ?? 6.0;
  const w = o.width ?? 1.25;
  const proj = o.projection ?? 1.5;
  const stages = o.stages ?? 3;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? sideGroup(o.nx ?? 0, o.nz ?? 0);
  const yaw = Math.atan2(o.nx ?? 0, o.nz ?? 0);
  const rng = B.rng;

  let y = 0;
  for (let s = 0; s < stages; s++) {
    const t = s / stages;
    const sh = (h / stages) * rng.range(0.85, 1.15);
    const sw = w * (1 - t * 0.30);
    const sp = proj * (1 - t * 0.42);
    const cx = o.x + Math.sin(yaw) * (sp * 0.5);
    const cz = o.z + Math.cos(yaw) * (sp * 0.5);
    B.push(mat, group, blockGeo(sw, sh, sp, rng, 0.04), matAt(cx, y + sh * 0.5, cz, yaw));
    B.solid(cx, y + sh * 0.5, cz, sw * 0.5, sh * 0.5, sp * 0.5, yaw, SURFACE.wall);
    // Weathered set-off: a sloped stone shedding water off the top of the stage.
    const capH = 0.22;
    B.push(mat, group, blockGeo(sw + 0.12, capH, sp + 0.12, rng, 0.02),
      matAt(cx, y + sh + capH * 0.5, cz, yaw));
    y += sh + capH;
  }
  // Gabled top.
  if (o.gable !== false) {
    const g = prismGeo(w * 0.55, 0.05, w * 0.9, 4, 0);
    B.push(mat, group, g, matAt(o.x + Math.sin(yaw) * proj * 0.25, y + w * 0.45, o.z + Math.cos(yaw) * proj * 0.25, yaw + Math.PI * 0.25));
  }
}

// ===========================================================================
// columns and arcades
// ===========================================================================

/**
 * A compound gothic pier: a faceted core with four attached shafts, a moulded
 * base and a foliate capital abstracted to two flared drums.
 *
 * ~360 triangles. The attached shafts are what make it read gothic rather than
 * classical, and they cost 4 short prisms.
 */
export function column(B, o) {
  const h = o.height ?? 5.4;
  const r = o.radius ?? ARCH.columnRadius;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? 'far';
  const rng = B.rng;
  const lean = o.lean ?? rng.range(-0.010, 0.010);   // a fraction of a degree
  const spin = rng.range(0, Math.PI * 2);

  const put = (geo, y, ry = 0, sx = 1, sy = 1, sz = 1) => {
    _e.set(lean, spin + ry, lean * 0.7);
    _q.setFromEuler(_e);
    _m.compose(_v.set(o.x, y, o.z), _q, _s.set(sx, sy, sz));
    B.push(mat, group, geo, _m);
  };

  const baseH = 0.44;
  const capH = 0.52;
  const shaftH = h - baseH - capH;

  // Base: two drums, the lower one square-ish (a plinth) and the upper round.
  put(blockGeo(r * ARCH.baseFlare * 1.06, baseH * 0.55, r * ARCH.baseFlare * 1.06, rng, 0.03), baseH * 0.27);
  put(prismGeo(r * ARCH.baseFlare * 0.5, r * 1.12, baseH * 0.5, ARCH.columnSides, 0), baseH * 0.72);

  // Shaft.
  put(prismGeo(r, r * ARCH.columnTaper, shaftH, ARCH.columnSides, rng.range(-0.05, 0.05)), baseH + shaftH * 0.5);

  // Attached shafts: four slim rolls in the hollows, stopping short of the cap.
  const ar = r * 0.24;
  for (let i = 0; i < 4; i++) {
    const a = spin + (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const ax = o.x + Math.cos(a) * (r * 0.96);
    const az = o.z + Math.sin(a) * (r * 0.96);
    _e.set(lean, 0, lean * 0.7);
    _q.setFromEuler(_e);
    _m.compose(_v.set(ax, baseH + shaftH * 0.5, az), _q, _s.set(1, 1, 1));
    B.push(mat, group, prismGeo(ar, ar * 0.94, shaftH * 0.97, 6, 0), _m);
  }

  // Capital: a bell and an abacus. The abacus is square and rotated off the
  // shaft's facets, which is what makes the join read as two carved pieces.
  put(prismGeo(r * 1.05, r * ARCH.capitalFlare, capH * 0.62, ARCH.columnSides, 0), h - capH * 0.68);
  put(blockGeo(r * ARCH.capitalFlare * 1.28, capH * 0.34, r * ARCH.capitalFlare * 1.28, rng, 0.02), h - capH * 0.17, 0.22);

  B.solid(o.x, h * 0.5, o.z, r * 1.05, h * 0.5, r * 1.05, 0, SURFACE.wall);
  return { x: o.x, z: o.z, top: h - capH * 0.34 };
}

/**
 * An arcade: a line of piers with pointed arches sprung between them, plus the
 * wall above if `wallAbove > 0` (a clerestory).
 *
 * Bay widths are jittered ±9% and the LAST bay is deliberately different, which
 * is the single most effective anti-repetition move available: real arcades were
 * built up to an existing wall and the builder took up the slack in one bay.
 *
 * @returns the capital positions, so a vault can be sprung off them.
 */
export function arcade(B, o) {
  const { x0, z0, x1, z1 } = o;
  const bays = o.bays ?? 5;
  const capH = o.capitalHeight ?? 5.2;
  const rng = B.rng;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? 'far';
  const dx = x1 - x0, dz = z1 - z0;
  const total = Math.hypot(dx, dz);
  const ux = dx / total, uz = dz / total;
  const yaw = Math.atan2(ux, uz);

  // Jittered bay widths that still sum exactly to the run.
  const w = [];
  let sum = 0;
  for (let i = 0; i < bays; i++) { const k = rng.range(0.91, 1.09); w.push(k); sum += k; }
  for (let i = 0; i < bays; i++) w[i] = (w[i] / sum) * total;

  const caps = [];
  let t = 0;
  const radius = o.radius ?? ARCH.columnRadius;
  for (let i = 0; i <= bays; i++) {
    const px = x0 + ux * t, pz = z0 + uz * t;
    // A pier standing in a doorway is a pier the player walks into. The arch
    // above it still springs from the recorded capital, so the arcade's rhythm
    // survives losing one of its supports — which is what a ruin looks like.
    if (inOpening(B, px, pz, 0.2)) caps.push({ x: px, z: pz, top: capH - 0.18, missing: true });
    else caps.push(column(B, { x: px, z: pz, height: capH, radius, mat, group }));
    if (i < bays) t += w[i];
  }

  // Arches between consecutive capitals.
  const rise = o.rise ?? ARCH.archRise;
  for (let i = 0; i < bays; i++) {
    const a = caps[i], b = caps[i + 1];
    const span = Math.hypot(b.x - a.x, b.z - a.z) - radius * 0.5;
    const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
    const springY = Math.min(a.top, b.top);
    // Broken arch: a ruined arcade is missing one or two of its heads, and the
    // gap is where the sky and the moonlight get in.
    if (o.ruin && rng.float() < o.ruin) {
      const geo = archRingGeo(span, rise * rng.range(0.94, 1.06), ARCH.archRing, o.depth ?? 0.9, rng, 9);
      if (geo) {
        // Keep only the springing stones: chop the geometry above 45% of the rise.
        const kept = cutAboveY(geo, span * 0.5 * rise * 0.45);
        if (kept) B.push(mat, group, kept, matAt(mx, springY, mz, yaw + Math.PI * 0.5));
        geo.dispose();
      }
      continue;
    }
    const geo = archRingGeo(span, rise * rng.range(0.94, 1.06), ARCH.archRing, o.depth ?? 0.9, rng, 9);
    if (geo) B.push(mat, group, geo, matAt(mx, springY, mz, yaw + Math.PI * 0.5));
    // Hood mould over the arch — a projecting drip course. Cheap, and it doubles
    // the silhouette's edge count where it matters most.
    const hood = ribGeo(span * 1.06, rise * 1.02, 0.16, (o.depth ?? 0.9) + 0.24, 7);
    if (hood) B.push(mat, group, hood, matAt(mx, springY + ARCH.archRing, mz, yaw + Math.PI * 0.5));

    // Spandrel above the arch, up to the clerestory sill.
    if (o.wallAbove > 0) {
      const apex = springY + span * 0.5 * rise + ARCH.archRing;
      const topY = capH + o.wallAbove;
      if (topY > apex + 0.2) {
        B.push(mat, group, blockGeo(span * 0.62, topY - apex, (o.depth ?? 0.9) * 0.8, rng, 0.04),
          matAt(mx, (topY + apex) * 0.5, mz, yaw + Math.PI * 0.5));
      }
    }
  }
  return caps;
}

/**
 * A SPRINGER: the first stones of a rib, still sitting on its capital and
 * stopping in mid-air where the rest of the vault fell.
 *
 * `keep` is the fraction of the rib's rise that survives. This is the whole
 * reason a missing vault reads as *lost* rather than as never built, and it is
 * two arch segments — about 60 triangles.
 */
export function springerGeo(span, riseRatio, thickness, depth, keep = 0.24) {
  const full = ribGeo(span, riseRatio, thickness, depth, 10);
  if (!full) return null;
  const cut = cutAboveY(full, span * 0.5 * riseRatio * keep);
  full.dispose();
  return cut;
}

/** Discard every triangle whose lowest vertex is above `y`. Used to break an
 *  arch or a vault open without authoring a second "ruined" variant. */
export function cutAboveY(geo, y) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const keep = [];
  for (let i = 0; i < pos.count; i += 3) {
    const lo = Math.min(pos.getY(i), pos.getY(i + 1), pos.getY(i + 2));
    if (lo <= y) keep.push(i);
  }
  if (!keep.length) return null;
  const p = new Float32Array(keep.length * 9);
  const n = new Float32Array(keep.length * 9);
  const u = new Float32Array(keep.length * 6);
  for (let k = 0; k < keep.length; k++) {
    for (let v = 0; v < 3; v++) {
      const s = keep[k] + v;
      p[k * 9 + v * 3] = pos.getX(s); p[k * 9 + v * 3 + 1] = pos.getY(s); p[k * 9 + v * 3 + 2] = pos.getZ(s);
      if (nrm) { n[k * 9 + v * 3] = nrm.getX(s); n[k * 9 + v * 3 + 1] = nrm.getY(s); n[k * 9 + v * 3 + 2] = nrm.getZ(s); }
      if (uv) { u[k * 6 + v * 2] = uv.getX(s); u[k * 6 + v * 2 + 1] = uv.getY(s); }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(p, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(u, 2));
  return out;
}

// ===========================================================================
// vaults and ceilings
// ===========================================================================

/**
 * One quadripartite vault bay with its diagonal and transverse ribs.
 *
 * A vault over the PLAYER would occlude them, so the caller only ever places
 * these over the −X/−Z half of a room and over aisles; everything emitted here
 * still goes into a bucket the subsystem registers for occluder fade, because
 * the boom can be pulled in and the rule has to survive that.
 */
export function vaultBay(B, o) {
  const w = o.w, d = o.d;
  const springY = o.springY ?? 5.4;
  const rise = o.rise ?? Math.min(w, d) * ARCH.vaultRise;
  const mat = o.mat ?? B.mat.vault;
  const group = o.group ?? 'vault';
  const rng = B.rng;

  if (o.collapsed) {
    // A collapsed bay is not an absent bay: the springing stones survive and the
    // web is gone, which is what makes the hole read as damage rather than as an
    // unbuilt room. The rubble that fell out of it is placed by the caller.
    const web = ribVaultGeo(w, d, rise, ARCH.vaultSeg, 0.3);
    const stub = cutAboveY(web, rise * 0.22);
    web.dispose();
    if (stub) B.push(mat, group, stub, matAt(o.x, springY, o.z, o.yaw ?? 0), 'keep');
  } else {
    const web = ribVaultGeo(w, d, rise, ARCH.vaultSeg, 0.34);
    B.push(mat, group, web, matAt(o.x, springY, o.z, o.yaw ?? 0), 'keep');
  }

  // Diagonal ribs — the defining feature. Two of them, crossing at the boss.
  const diag = Math.hypot(w, d);
  const rr = o.ribRise ?? (rise / (diag * 0.5)) * 1.06;
  for (const s of [1, -1]) {
    const rib = ribGeo(diag, rr, 0.22, 0.26, 8);
    if (rib) B.push(B.mat.wall, group, rib, matAt(o.x, springY, o.z, (o.yaw ?? 0) + s * Math.atan2(w, d)));
  }
  // Transverse ribs across the short axis at both ends of the bay.
  if (o.transverse !== false) {
    for (const s of [1, -1]) {
      const rib = ribGeo(w, (rise / (w * 0.5)) * 1.0, 0.26, 0.34, 6);
      if (rib) B.push(B.mat.wall, group, rib, matAt(o.x, springY, o.z + s * d * 0.5, o.yaw ?? 0));
    }
  }
  // Boss at the crossing.
  if (!o.collapsed) {
    B.push(B.mat.wall, group, prismGeo(0.30, 0.20, 0.34, 8, 0), matAt(o.x, springY + rise - 0.12, o.z, rng.range(0, 3.1)));
  }
}

/** A flat sooted ceiling slab, for low crypt rooms that never had a vault. */
export function ceilingSlab(B, o) {
  const g = blockGeo(o.w, 0.4, o.d, B.rng, 0.02);
  B.push(o.mat ?? B.mat.vault, o.group ?? 'vault', g, matAt(o.x, o.y + 0.2, o.z, o.yaw ?? 0));
}

/**
 * A barrel vault: a half-cylinder ceiling with transverse ribs, which is what a
 * crypt corridor actually has. Cheaper than a ribbed vault and it gives the
 * corridor shot its rhythm of arches receding into the dark.
 */
export function barrelVault(B, o) {
  const { width, length, springY } = o;
  const seg = o.segments ?? 9;
  const mat = o.mat ?? B.mat.vault;
  const group = o.group ?? 'vault';
  // SEGMENTAL, not semicircular. A true half-round barrel over a 5 m corridor
  // puts its crown at 2.5 m above the springing, which is a metre higher than
  // the corridor is supposed to be, and at this camera the transverse ribs of
  // that arch read as a row of black bars laid across the floor rather than as
  // a ceiling. Real crypt vaults are segmental for the same structural reason
  // they are here: less height for the same span.
  const rise = o.rise ?? width * 0.32;
  const squash = rise / (width * 0.5);

  // Half-cylinder, open ended, wound to be seen from below.
  const cyl = new THREE.CylinderGeometry(width * 0.5, width * 0.5, length, seg, 1, true, 0, Math.PI);
  cyl.rotateZ(Math.PI * 0.5);
  cyl.rotateY(Math.PI * 0.5);
  // three's open cylinder faces outward; a vault is seen from inside, so flip.
  const flipped = cyl.index ? cyl.toNonIndexed() : cyl;
  if (flipped !== cyl) cyl.dispose();
  const p = flipped.attributes.position;
  for (let i = 0; i < p.count; i += 3) {
    const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i);
    p.setXYZ(i, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
    p.setXYZ(i + 2, ax, ay, az);
  }
  p.needsUpdate = true;
  flipped.computeVertexNormals();
  flipped.scale(1, squash, 1);
  flipped.computeVertexNormals();
  B.push(mat, group, flipped, matAt(o.x, springY, o.z, o.yaw ?? 0));

  // Transverse ribs every `ribEvery` metres, each a shallow arch under the web.
  const every = o.ribEvery ?? 2.6;
  const n = Math.max(1, Math.round(length / every));
  for (let i = 0; i <= n; i++) {
    const t = -length * 0.5 + (length * i) / n;
    // Rib rise matches the web it follows, and the section is slim: a 24 cm
    // rib on a 5 m span is a girder, and from above it is a bar.
    const rib = ribGeo(width * 1.02, squash * 1.04, 0.15, 0.26, 7);
    if (!rib) continue;
    _e.set(0, o.yaw ?? 0, 0);
    _q.setFromEuler(_e);
    _m.compose(
      _v.set(o.x + Math.cos(o.yaw ?? 0) * 0 + Math.sin(o.yaw ?? 0) * t, springY, o.z + Math.cos(o.yaw ?? 0) * t),
      _q, _s.set(1, 1, 1)
    );
    B.push(B.mat.wall, group, rib, _m);
  }
}

// ===========================================================================
// openings, floors, level changes
// ===========================================================================

/** A rose window set in an opening: tracery plus a thin glazing plane behind it
 *  so the sky (or nothing) reads through the openings. */
export function roseWindow(B, o) {
  const geo = roseWindowGeo(o.radius, o.spokes ?? 8, 0.24, B.rng);
  if (geo) B.push(o.mat ?? B.mat.wall, o.group ?? 'far', geo, matAt(o.x, o.y, o.z, o.yaw ?? 0));
}

/**
 * A lancet window: a tall narrow opening with a moulded surround. Built as the
 * surround only — the opening itself is a genuine hole in the wall run, which
 * the caller arranges by splitting the run.
 */
export function lancet(B, o) {
  const w = o.width ?? 0.9;
  const h = o.height ?? 3.0;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? 'far';
  const yaw = o.yaw ?? 0;
  const rng = B.rng;
  for (const s of [-1, 1]) {
    B.push(mat, group, blockGeo(0.26, h, 0.34, rng, 0.02),
      matAt(o.x + Math.cos(yaw) * s * (w * 0.5 + 0.13), o.y + h * 0.5, o.z - Math.sin(yaw) * s * (w * 0.5 + 0.13), yaw));
  }
  const head = archRingGeo(w + 0.52, 1.5, 0.26, 0.34, rng, 7);
  if (head) B.push(mat, group, head, matAt(o.x, o.y + h, o.z, yaw));
  // Sill, sloped outward.
  B.push(mat, group, blockGeo(w + 0.7, 0.16, 0.42, rng, 0.02), matAt(o.x, o.y - 0.08, o.z, yaw));
}

/**
 * Room floor: a subsiding flagstone slab, optionally with a collapsed dip.
 *
 * `yaw` IS NOT OPTIONAL FOR A ROTATED ROOM, and leaving it out was a measured
 * hole in the level rather than a cosmetic slip. The slab and its collider were
 * always built axis-aligned, so the crypt corridor — a 26 m room at 45° — got a
 * 5 × 26 m box of floor laid across it at the wrong angle: `physics.groundAt`
 * returned null at three points along its centre line, the navigation grid cut
 * the corridor into pieces, and the four rooms beyond it were unreachable from
 * the spawn. Every caller now passes `room.yaw`.
 */
export function floorSlab(B, o) {
  const geo = floorGeo(o.w, o.d, o.resolution ?? 2.4, B.rng, { dip: o.dip ?? null, amplitude: o.amplitude ?? 1 });
  const yaw = o.yaw ?? 0;
  B.push(o.mat ?? B.mat.floor, o.group ?? 'floor', geo, matAt(o.x, o.y ?? 0, o.z, yaw), 'keep');
  // One flat collider. The undulation is ±5 cm and the character controller
  // ground-snaps, so 8k near-planar triangles in the BVH would buy nothing.
  B.solid(o.x, (o.y ?? 0) - 0.5, o.z, o.w * 0.5, 0.5, o.d * 0.5, yaw, o.surface ?? SURFACE.floor);
}

/**
 * A flight of steps between two EXPLICIT world points at two explicit heights.
 *
 * `stairs()` takes a position, a yaw and a step count and rises in its own local
 * +Z, which puts the burden of working out which way is down on the caller —
 * and the caller got it wrong: the hall built a flight rising SOUTH out of its
 * own south wall while the undercroft built one rising NORTH through the same
 * three cubic metres, so the only route between them was a solid wedge of
 * masonry and the entire west half of the level was unreachable.
 *
 * This takes both ends. There is no way to point it the wrong way.
 */
export function flight(B, o) {
  const rng = B.rng;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? 'far';
  const dx = o.x1 - o.x0, dz = o.z1 - o.z0;
  const run = Math.hypot(dx, dz);
  if (run < 0.2) return;
  const ux = dx / run, uz = dz / run;
  const yaw = Math.atan2(ux, uz);
  const dy = o.y1 - o.y0;
  const width = o.width ?? 3.2;
  // ~0.17 m per step is a cathedral stair; anything over 0.24 is a ladder and
  // the character controller's step height (0.55) starts snapping through it.
  const steps = Math.max(2, Math.round(Math.abs(dy) / 0.19) || 2);
  const tread = run / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const x = o.x0 + ux * run * t, z = o.z0 + uz * run * t;
    // Each tread is a slab from this step back to the LOW end, so the flight is
    // solid underneath and every collider is trivially the same box as the mesh.
    const yTop = o.y0 + dy * ((i + 1) / steps);
    const low = Math.min(o.y0, o.y1) - 0.6;
    const h = yTop - low;
    B.push(mat, group, blockGeo(width, h, tread * 1.02, rng, 0.02), matAt(x, low + h * 0.5, z, yaw));
    B.solid(x, low + h * 0.5, z, width * 0.5, h * 0.5, tread * 0.51, yaw, o.surface ?? SURFACE.floor);
  }
  // Cheek walls: a flight with no side is a floating staircase, and at this
  // camera pitch you see straight down the open edge into nothing.
  if (o.cheeks !== false) {
    for (const s of [-1, 1]) {
      const cw = 0.42;
      const cx = (o.x0 + o.x1) * 0.5 + s * (width * 0.5 + cw * 0.5) * Math.cos(yaw);
      const cz = (o.z0 + o.z1) * 0.5 - s * (width * 0.5 + cw * 0.5) * Math.sin(yaw);
      const h = Math.abs(dy) + 0.5;
      const ym = Math.min(o.y0, o.y1) - 0.6;
      B.push(mat, group, blockGeo(cw, h, run, rng, 0.03), matAt(cx, ym + h * 0.5, cz, yaw));
      B.solid(cx, ym + h * 0.5, cz, cw * 0.5, h * 0.5, run * 0.5, yaw, SURFACE.wall);
    }
  }
}

/**
 * A raised dais with a flight of steps on one side.
 *
 * Every important thing in the level stands on one of these. A 0.9 m platform
 * separates the altar from the floor plane at this camera pitch, which is what
 * makes a sanctuary read as a place rather than as a patch of floor.
 */
export function dais(B, o) {
  const rng = B.rng;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? 'far';
  const h = o.height ?? 0.9;
  const steps = o.steps ?? 3;
  const riser = h / steps;

  for (let i = 0; i < steps; i++) {
    const inset = (steps - 1 - i) * (o.tread ?? 0.42);
    const w = o.w + inset * 2;
    const d = o.d + inset * 2;
    B.push(mat, group, blockGeo(w, riser, d, rng, 0.02), matAt(o.x, (o.y ?? 0) + riser * (i + 0.5), o.z, o.yaw ?? 0));
    B.solid(o.x, (o.y ?? 0) + riser * (i + 0.5), o.z, w * 0.5, riser * 0.5, d * 0.5, o.yaw ?? 0, SURFACE.wall);
  }
}

/** A straight flight of stairs connecting two floor levels. */
export function stairs(B, o) {
  const steps = o.steps ?? 6;
  const rise = o.rise ?? 0.28;
  const run = o.run ?? 0.44;
  const geo = stairsGeo(o.width, steps, rise, run, B.rng);
  if (geo) B.push(o.mat ?? B.mat.wall, o.group ?? 'far', geo, matAt(o.x, o.y ?? 0, o.z, o.yaw ?? 0));
  const cy = Math.cos(o.yaw ?? 0), sy = Math.sin(o.yaw ?? 0);
  for (let i = 0; i < steps; i++) {
    const depth = run * (steps - i);
    const lz = i * run + depth * 0.5;
    B.solid(
      o.x + sy * lz, (o.y ?? 0) + rise * (i + 0.5), o.z + cy * lz,
      o.width * 0.5, rise * 0.5, depth * 0.5, o.yaw ?? 0, SURFACE.wall
    );
  }
}

/**
 * A wall niche: a recess with an arched head, into which the caller puts a
 * skull, an urn or a saint.
 *
 * Recesses are the cheapest way to give a corridor wall depth, and once GTAO
 * lands in them they are the darkest thing in the frame, which is what the eye
 * needs to read the wall as thick.
 */
export function niche(B, o) {
  const w = o.width ?? 0.75;
  const h = o.height ?? 1.15;
  const depth = o.depth ?? 0.4;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? 'far';
  const yaw = o.yaw ?? 0;
  const rng = B.rng;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);

  // Back, two jambs, floor and an arched head — a five-sided box open on one
  // face, which is exactly what a recess is.
  const put = (g, lx, ly, lz) => B.push(mat, group, g, matAt(o.x + cy * lx + sy * lz, o.y + ly, o.z - sy * lx + cy * lz, yaw));
  put(blockGeo(w + 0.3, h + 0.5, 0.12, rng, 0.01), 0, h * 0.5, -depth);
  put(blockGeo(0.16, h + 0.4, depth, rng, 0.01), -(w * 0.5 + 0.08), h * 0.5, -depth * 0.5);
  put(blockGeo(0.16, h + 0.4, depth, rng, 0.01), w * 0.5 + 0.08, h * 0.5, -depth * 0.5);
  put(blockGeo(w + 0.3, 0.1, depth, rng, 0.01), 0, 0, -depth * 0.5);
  const head = archRingGeo(w + 0.28, 1.25, 0.2, depth + 0.08, rng, 6);
  if (head) B.push(mat, group, head, matAt(o.x + sy * (-depth * 0.5), o.y + h, o.z + cy * (-depth * 0.5), yaw));
  return { x: o.x + sy * (-depth * 0.55), y: o.y, z: o.z + cy * (-depth * 0.55), yaw };
}

/**
 * A section of masonry that has fallen: a heap of ashlar blocks in a rough cone,
 * for use under a collapsed vault or a breached wall.
 *
 * Placed with real physics-free stacking (each block sits on the pile's implied
 * surface), which is far more convincing than a scatter at random heights — the
 * eye reads "this fell" from the fact that the blocks are supporting each other.
 */
export function rubblePile(B, o) {
  const rng = B.rng;
  const n = o.count ?? 14;
  const R = o.radius ?? 2.2;
  const mat = o.mat ?? B.mat.wall;
  const group = o.group ?? 'far';
  for (let i = 0; i < n; i++) {
    // Bias toward the middle so the heap has a peak instead of a rim.
    const rr = Math.sqrt(rng.float()) * R;
    const a = rng.range(0, Math.PI * 2);
    const x = o.x + Math.cos(a) * rr;
    const z = o.z + Math.sin(a) * rr;
    const pileY = (o.height ?? 0.9) * Math.max(0, 1 - (rr / R) ** 1.6);
    const s = rng.range(0.28, 0.72) * (o.scale ?? 1);
    _e.set(rng.range(-0.5, 0.5), rng.range(0, 6.283), rng.range(-0.5, 0.5));
    _q.setFromEuler(_e);
    _m.compose(_v.set(x, (o.y ?? 0) + pileY * rng.range(0.25, 0.85) + s * 0.3, z), _q, _s.set(1, 1, 1));
    B.push(mat, group, blockGeo(s * rng.range(0.8, 1.9), s * rng.range(0.5, 0.9), s * rng.range(0.8, 1.5), rng, 0.06), _m);
  }
  // One collider for the whole heap — the player should be blocked by it, not
  // trip over fourteen individual boxes.
  B.solid(o.x, (o.y ?? 0) + (o.height ?? 0.9) * 0.35, o.z, R * 0.75, (o.height ?? 0.9) * 0.5, R * 0.75, 0, SURFACE.wall);
}

/** A trio of merged geometries used often enough to be worth caching by the
 *  caller: exported so `props.js` can build on the same primitives. */
export const KIT_PRIMS = { blockGeo, prismGeo, normalise, mergeAll };
