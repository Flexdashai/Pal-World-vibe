import * as THREE from 'three';
import { ARCH, DRESS, DEBRIS, SURFACE, LIGHTING, clamp } from './tuning.js';
import { DIR, DIAG_YAW, toWorld } from './layout.js';
import {
  wallRun, lowWall, archedWall, buttress, column, arcade, vaultBay, barrelVault,
  ceilingSlab, roseWindow, lancet, floorSlab, dais, flight, niche, rubblePile,
  matAt, springerGeo, inOpening,
} from './kit.js';
import {
  kneelingSaint, gargoyle, brokenAngel, sarcophagus, altar, runeMonolith,
  portcullis, ironGate, hangingChain, banner, roots, brokenWeapon, urn, scatter,
} from './props.js';
import { brazier, sconce, candelabrum, candleCluster } from './fire.js';
import { blockGeo, prismGeo, floorGeo, archRingGeo, roseWindowGeo, GeoBucket } from './geom.js';

/**
 * MONARCH — the room builder.
 *
 * Turns the room graph from `layout.js` into geometry, collision, practicals and
 * flames. One `Builder` per room; the subsystem merges each builder's buckets
 * into a handful of meshes parented to that room's group, which is what makes
 * room streaming a single `group.visible = false`.
 *
 * ---------------------------------------------------------------------------
 * HOW A ROOM IS COMPOSED, EVERY TIME
 *
 * 1. FLOOR first, because it decides the room's level and its collider.
 * 2. PERIMETER, with the height of each run driven by which way it faces:
 *    a wall whose outward normal points −X−Z is BACKDROP and gets the full
 *    elevation; one pointing +X+Z is between the lens and the player and is
 *    kept under ~2.5 m. `perimeterHeight` is the one function that decides this
 *    and every room calls it.
 * 3. INTERNAL ORDER — arcades, piers, vaults. This is the silhouette.
 * 4. FURNITURE — tombs, altars, statues. This is what the room is FOR.
 * 5. PRACTICALS, placed to light item 4 rather than to cover item 1.
 * 6. DEBRIS last, so it can avoid everything already placed.
 */

/**
 * Wall height from the direction it faces.
 *
 *   t = (nx + nz)/√2 ∈ [−1, 1]; −1 is dead up-screen, +1 is dead at the lens.
 *
 * A hard "tall if up-screen else short" switch produces a visible step where two
 * runs meet at a corner. Interpolating means the two side walls of a room step
 * down gradually toward the camera, which reads as a building that has partly
 * collapsed toward you rather than as a set with one wall missing.
 */
export function perimeterHeight(nx, nz, tall, low) {
  const t = clamp((nx + nz) * Math.SQRT1_2, -1, 1);
  const k = 0.5 - 0.5 * t;                       // 1 at backdrop, 0 at the lens
  return low + (tall - low) * Math.pow(k, 0.85);
}

/**
 * Collects everything one room produces.
 *
 * `push` goes into a merge bucket (one draw call per material per group);
 * `instance` goes into an InstancedMesh (so `materials`' per-instance variation,
 * which hashes the instance origin, gives every rock its own tint);
 * `solid` records a collision OBB; `light` and `flame` are handed to lighting.js
 * and fire.js respectively.
 */
export class Builder {
  constructor(room, rng, matSpec) {
    this.room = room;
    this.rng = rng;
    /**
     * Every doorway that touches this room, as world circles. `kit.wallRun`
     * splits itself around these and `kit.inOpening` keeps piers, tombs and
     * braziers out of them — so a link in the graph becomes a hole in whatever
     * masonry happens to be in the way, without any builder knowing which wall
     * that is. See the `openSegments` header for why this is not per-builder.
     */
    this.openings = openingsFor(room);
    this.bucket = new GeoBucket();
    this.matSpec = matSpec;
    /** Logical material name -> preset name, for the kit's `B.mat.wall` idiom. */
    this.mat = {};
    for (const k of Object.keys(matSpec)) this.mat[k] = k;
    this.colliders = [];
    this.lights = [];
    this.flames = [];
    /** kind -> array of Matrix4 (copied, because the caller reuses its scratch) */
    this.instances = new Map();
    /** Keep-out circles for the debris scatter. */
    this.avoid = [];
  }

  push(mat, group, geo, matrix = null, uvMode = 'world') {
    this.bucket.add(mat, group, geo, matrix, uvMode);
    return this;
  }

  instance(mat, kind, matrix) {
    const key = `${mat}|${kind}`;
    let list = this.instances.get(key);
    if (!list) { list = { mat, kind, mats: [] }; this.instances.set(key, list); }
    list.mats.push(matrix.clone());
    return this;
  }

  solid(x, y, z, hx, hy, hz, yaw, surface) {
    this.colliders.push({ x, y, z, hx, hy, hz, yaw, surface: surface ?? SURFACE.wall });
    return this;
  }

  light(spec) { this.lights.push(spec); return this; }
  flame(spec) { this.flames.push(spec); return this; }
  keepOut(x, z, r) { this.avoid.push({ x, z, r }); return this; }
}

// ===========================================================================
// doorways and throats
// ===========================================================================

/**
 * The world circles a room must leave open, one set per link that touches it.
 *
 * Sampled ALONG the throat rather than only at its ends: a link 5 m long can be
 * crossed by a wall anywhere along its length (the hall's south wall, the
 * undercroft's north wall and the two cheek walls of the stair between them all
 * cross the same throat), and a hole at the ends only would leave a wall
 * standing across the middle of the doorway.
 */
export function openingsFor(room) {
  const out = [];
  for (const L of room.links ?? []) {
    const n = Math.max(2, Math.ceil(L.len / 1.4) + 1);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      out.push({ x: L.ax + (L.bx - L.ax) * t, z: L.az + (L.bz - L.az) * t, r: L.clear });
    }
  }
  return out;
}

/**
 * Realise one link: the floor the player actually walks on between two rooms.
 *
 * Built by exactly ONE of the two rooms (`L.owner`) so the geometry exists once
 * and lives in one streamable group. What it produces:
 *
 *   - a floor slab along the throat, oriented along the direction of travel, or
 *   - a single flight of steps where the two rooms are at different heights,
 *   - low jamb walls down both sides so the gap reads as a passage rather than
 *     as a missing wall,
 *   - an arch ring over the threshold.
 *
 * This is the whole fix for the measured connectivity failure: with the throats
 * in place every room in the level is reachable from the spawn, where before
 * five of nine were not.
 */
export function buildThroat(B, L) {
  const rng = B.rng;
  const dy = L.yb - L.ya;
  const width = L.width;
  // Even a zero-length link (two rooms sharing a wall) gets a metre of floor, so
  // the threshold cell itself is never the one cell with no ground under it.
  const len = Math.max(L.len, 1.2);
  const mx = (L.ax + L.bx) * 0.5, mz = (L.az + L.bz) * 0.5;

  if (Math.abs(dy) > 0.35) {
    // A flight, with a landing at each end so the throat's floor meets both
    // rooms' floors at their own heights rather than at the stair's.
    const pad = 1.1;
    const s0 = { x: L.ax + L.ux * pad, z: L.az + L.uz * pad };
    const s1 = { x: L.bx - L.ux * pad, z: L.bz - L.uz * pad };
    floorSlab(B, {
      x: L.ax - L.ux * 0.3, z: L.az - L.uz * 0.3, w: width + 1.4, d: pad * 2 + 0.8,
      y: L.ya, yaw: L.yaw, resolution: 1.6,
    });
    floorSlab(B, {
      x: L.bx + L.ux * 0.3, z: L.bz + L.uz * 0.3, w: width + 1.4, d: pad * 2 + 0.8,
      y: L.yb, yaw: L.yaw, resolution: 1.6,
    });
    flight(B, {
      x0: s0.x, z0: s0.z, y0: L.ya, x1: s1.x, z1: s1.z, y1: L.yb,
      width, group: 'far',
    });
  } else {
    floorSlab(B, {
      x: mx, z: mz, w: width + 1.4, d: len + 1.6, y: L.ya,
      yaw: L.yaw, resolution: 1.8,
    });
    // Jambs. Low, because a throat is nearly always on the camera side of one of
    // the two rooms it joins and a 4 m wall there would be a bar across the frame.
    if (len > 2.2) {
      for (const s of [-1, 1]) {
        const ox = s * (width * 0.5 + 0.4);
        const px = mx + Math.cos(L.yaw) * ox, pz = mz - Math.sin(L.yaw) * ox;
        B.push(B.mat.wall, 'near', blockGeo(0.5, 1.75, len * 0.94, rng, 0.04),
          matAt(px, 0.875 + L.ya, pz, L.yaw));
        B.solid(px, 0.875 + L.ya, pz, 0.25, 0.875, len * 0.47, L.yaw, SURFACE.wall);
      }
    }
  }

  // The arch over the threshold. Springs at 2.6 m, which clears the navigation
  // grid's 1.9 m head-clearance test with room for a shadow soldier.
  if (L.kind !== 'breach') {
    const ring = archRingGeo(width + 0.5, 1.15, 0.42, 0.75, rng, 7);
    if (ring) {
      B.push(B.mat.wall, 'far', ring, matAt(L.ax, L.ya + 2.35, L.az, L.yaw + Math.PI * 0.5));
    }
  }
  B.keepOut(mx, mz, width * 0.5 + 0.6);
}

// ===========================================================================
// material dressing
// ===========================================================================

/**
 * The material set for a room kind.
 *
 * Two things live here and nothing else: WHICH library recipe each logical
 * surface resolves to, and how filthy the room is. Between them they are the
 * biggest lever on whether two rooms feel like different places, because the
 * shapes are all built from the same kit.
 *
 * `env` — the `envMapIntensity` multiplier — is carried through but is currently
 * INERT: see the DRESS note in tuning.js for the measurement (1.6 vs 7 vs 300
 * produced three captures `analyze.mjs` scored identically). It is kept correct
 * so it starts working the day the indirect path does. The fill that actually
 * reaches the frame is the hemisphere light in lighting.js, which lands in the
 * same `reflectedLight.indirectDiffuse` term and is therefore multiplied by
 * render's GTAO exactly as the env would have been.
 *
 * Every entry goes through `materials.get()`. Nothing in this subsystem builds
 * a THREE material for a world surface except the coal (`__ember`) and the
 * flame, neither of which the library has a recipe for.
 */
export function materialsFor(kind, room) {
  const d = DRESS[kind] ?? DRESS.chamber;
  const common = { envMapIntensity: d.env };
  const wet = d.wet, moss = d.moss, grime = d.grime, soot = d.soot, dust = d.dust;

  const spec = {
    floor: { name: 'floor.crypt', opts: { ...common, wet, moss: moss * 0.8, grime } },
    wall: { name: 'wall.block', opts: { ...common, wet: wet * 0.75, moss, grime, varyUv: 0.05 } },
    vault: { name: 'ceil.vault', opts: { ...common, envMapIntensity: d.env * 0.8, soot, grime, dust } },
    iron: { name: 'metal.brazier', opts: { triplanar: true, soot: clamp(soot + 0.5, 0, 1), envMapIntensity: d.env * 0.8 } },
    steel: { name: 'metal.rust', opts: { triplanar: true, grime, envMapIntensity: d.env * 0.8 } },
    wood: { name: 'wood.beam', opts: { triplanar: true, moss, grime, envMapIntensity: d.env } },
    root: { name: 'wood.beam', opts: { triplanar: true, moss: clamp(moss + 0.25, 0, 1), wet, envMapIntensity: d.env } },
    bone: { name: 'organic.bone', opts: { ...common, grime, dust } },
    wax: { name: 'organic.bone', opts: { ...common, grime: 0.1, dust: 0.05, roughness: 0.75 } },
    banner: { name: 'cloth.banner', opts: { ...common, soot, grime, side: 'double' } },
    rune: { name: 'arcane.rune', opts: { emissive: 2.4, moss: 0.05, envMapIntensity: d.env } },
    crystal: { name: 'arcane.crystal', opts: { emissive: 2.2, envMapIntensity: d.env } },
    water: { name: 'water.still', opts: { envMapIntensity: d.env * 1.4 } },
    ember: { name: '__ember', opts: null },     // built by the subsystem, not the library
  };

  // Room-specific swaps. These are the ones that make a room's SURFACE identity
  // as distinct as its shape — an ossuary whose floor is bone litter is a
  // different place from one that is merely decorated with bones.
  switch (kind) {
    case 'cathedral':
      // Flagstone, not marble. `flagstone` is the only 'hero'-tier floor in the
      // catalogue (1024 px with parallax) and it is the surface the hero shot
      // spends half its pixels on; a 'main'-tier marble would look worse AND
      // cost a second full texture bake at boot.
      spec.floor = { name: 'floor.crypt', opts: { ...common, wet, moss: moss * 0.5, grime, dust } };
      break;
    case 'ossuary':
      spec.floor = { name: 'floor.ossuary', opts: { ...common, grime, dust } };
      break;
    case 'undercroft':
      spec.floor = { name: 'floor.flooded', opts: { ...common, wet: 0.9, moss: moss, grime } };
      spec.wall = { name: 'wall.blockWet', opts: { ...common, wet: 0.7, moss: clamp(moss + 0.12, 0, 1), grime } };
      break;
    case 'shrine':
      spec.floor = { name: 'floor.crypt', opts: { ...common, wet: 0.45, moss: 0.05, grime: 0.35 } };
      break;
    case 'corridor':
    case 'passage':
      spec.vault = { name: 'ceil.vaultSooted', opts: { ...common, envMapIntensity: d.env * 0.7, soot: 0.85, grime } };
      break;
    case 'arena':
      // Soot, not the `ash` surface: the arena floor is burnt flagstone, and
      // driving the soot overlay to 0.6 on the floor material we have already
      // baked gets there without a second bake.
      spec.floor = { name: 'floor.crypt', opts: { ...common, soot: 0.6, wet: 0.18, grime: 0.6 } };
      break;
    case 'cloister':
    case 'nave':
    case 'bridge':
      // The three roofless rooms. Rain-washed rather than groundwater-damp:
      // high moss on the masonry, and a floor that is wet in the open and
      // mossy at the edges where nothing walks.
      spec.floor = { name: 'floor.crypt', opts: { ...common, wet, moss: clamp(moss + 0.15, 0, 1), grime } };
      spec.wall = { name: 'wall.blockWet', opts: { ...common, wet: wet * 0.8, moss: clamp(moss + 0.1, 0, 1), grime, varyUv: 0.06 } };
      break;
    case 'gallery':
      spec.floor = { name: 'floor.crypt', opts: { ...common, wet, moss: moss * 0.7, grime, dust } };
      break;
    case 'reliquary':
      // The one tended room in the level: the floor is swept, and the shrine
      // furniture reads as gilded because everything around it does not.
      spec.floor = { name: 'floor.crypt', opts: { ...common, wet: 0.14, moss: 0.01, grime: 0.22, dust } };
      spec.gold = { name: 'metal.brazier', opts: { triplanar: true, soot: 0.05, envMapIntensity: d.env * 2.2 } };
      break;
    case 'catacomb':
      spec.floor = { name: 'floor.ossuary', opts: { ...common, grime, dust } };
      spec.vault = { name: 'ceil.vaultSooted', opts: { ...common, envMapIntensity: d.env * 0.7, soot: 0.7, grime } };
      break;
    default:
      break;
  }
  void room;
  return spec;
}

// ===========================================================================
// shared sub-assemblies
// ===========================================================================

// `wallWithGap` used to live here: a wall run split around a hand-placed gap,
// expressed as a fraction along the run. It is gone because every one of its
// call sites was a doorway whose position was maintained BY HAND in two places
// — the builder that drew the wall and the builder on the other side of it —
// and the measured result was five unreachable rooms. `kit.wallRun` now splits
// itself around `Builder.openings`, which is derived from the same link records
// navigation reads. See `openSegments`.

/**
 * A run of buttresses stepping along the OUTSIDE of a wall.
 *
 * They cost almost nothing and they are the difference between a wall and a
 * cathedral: at 45° yaw the camera sees both faces of every buttress, so a plain
 * elevation becomes an alternating rhythm of lit face / dark return all the way
 * up the frame.
 */
function buttressRun(B, o) {
  const len = Math.hypot(o.x1 - o.x0, o.z1 - o.z0);
  const n = Math.max(1, Math.round(len / (o.spacing ?? 6.0)));
  const ux = (o.x1 - o.x0) / len, uz = (o.z1 - o.z0) / len;
  for (let i = 0; i <= n; i++) {
    const t = (i + 0.5) / (n + 1);
    if (B.rng.float() < (o.skip ?? 0.12)) continue;
    buttress(B, {
      x: o.x0 + ux * len * t, z: o.z0 + uz * len * t,
      nx: o.nx, nz: o.nz,
      height: o.height * B.rng.range(0.78, 0.94),
      width: (o.width ?? 1.25) * B.rng.range(0.9, 1.1),
      projection: (o.projection ?? 1.5) * B.rng.range(0.85, 1.15),
      stages: B.rng.int(2, 3),
      group: o.group,
    });
  }
}

/** Windows punched along a backdrop wall, with a gargoyle above every third. */
function windowRun(B, o) {
  const len = Math.hypot(o.x1 - o.x0, o.z1 - o.z0);
  const n = Math.max(1, Math.round(len / (o.spacing ?? 5.5)));
  const ux = (o.x1 - o.x0) / len, uz = (o.z1 - o.z0) / len;
  const yaw = Math.atan2(ux, uz) + Math.PI * 0.5;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x = o.x0 + ux * len * t, z = o.z0 + uz * len * t;
    lancet(B, { x, y: o.sill, z, width: o.width ?? 0.95, height: o.height ?? 2.8, yaw, group: o.group });
    if (i % 3 === 1 && o.gargoyles !== false) {
      gargoyle(B, {
        x: x + o.nx * 0.55, y: o.sill + (o.height ?? 2.8) + 1.5, z: z + o.nz * 0.55,
        yaw: Math.atan2(o.nx, o.nz), scale: B.rng.range(0.85, 1.15), group: o.group,
      });
    }
  }
}

/** Scatter every debris kind a room asks for, avoiding its keep-outs. */
function dressDebris(B, room, o) {
  const rng = B.rng;
  const hw = o.hw, hd = o.hd;
  const q = o.density ?? 1;
  const rr = (r) => Math.round(rng.range(r[0], r[1]) * q);

  scatter(B, {
    mat: 'wall', kind: 'rock', count: rr(DEBRIS.rubblePerRoom),
    x: o.x, z: o.z, hw, hd, y: o.y, scale: [0.16, 0.52], avoid: B.avoid,
  });
  scatter(B, {
    mat: 'wall', kind: 'brick', count: Math.round(rr(DEBRIS.rubblePerRoom) * 0.6),
    x: o.x, z: o.z, hw, hd, y: o.y, scale: [0.5, 1.25], avoid: B.avoid,
  });
  if (o.shards !== false) {
    scatter(B, {
      mat: 'wall', kind: 'shard', count: rr(DEBRIS.shardsPerRoom),
      x: o.x, z: o.z, hw, hd, y: o.y, scale: [0.35, 0.95], upright: true, avoid: B.avoid,
    });
  }
  if (o.bones) {
    scatter(B, {
      mat: 'bone', kind: 'bone', count: rr(DEBRIS.bonesPerRoom),
      x: o.x, z: o.z, hw, hd, y: o.y, lift: 0.03, scale: [0.7, 1.5], avoid: B.avoid,
    });
    scatter(B, {
      mat: 'bone', kind: 'skull', count: rr(DEBRIS.skullsPerRoom),
      x: o.x, z: o.z, hw, hd, y: o.y, lift: 0.06, scale: [0.75, 1.3], avoid: B.avoid,
    });
  }
  void room;
}

// ===========================================================================
// 1. the cathedral hall
// ===========================================================================

export function buildCathedral(B, room) {
  const rng = B.rng;
  const { minX, maxX, minZ, maxZ } = room.bounds;
  const c = room.chamfer;
  const naveN = room.naveZ - room.naveHalf;    // north (up-screen) arcade line
  const naveS = room.naveZ + room.naveHalf;    // south (camera-side) arcade line
  const tall = ARCH.hallBackdrop;
  const low = ARCH.hallCamSide;

  // --- 1. floor, sanctuary dais, and the subsided patch under the broken vault
  const dipX = room.x - room.w * 0.12;
  floorSlab(B, {
    x: room.x, z: room.z, w: room.w + 2, d: room.d + 2, y: 0, resolution: 2.2,
    dip: { x: dipX - room.x, z: room.naveZ - room.z, radius: 5.5, depth: 0.30 },
  });

  const sancX = minX + 4.6;
  dais(B, { x: sancX, z: room.naveZ, w: 8.0, d: room.naveHalf * 2 + 1.2, height: 0.92, steps: 3, tread: 0.5 });
  B.keepOut(sancX, room.naveZ, 6.0);

  // --- 2. perimeter ---------------------------------------------------------
  // North (backdrop): the full elevation, buttressed, with a clerestory of
  // lancets and gargoyles. This wall IS the top third of the hero shot — but
  // ONLY west of `ruinFromX`.
  //
  // East of that it is a ruined stretch barely three metres high, and that is a
  // camera decision, not a story one. The lamp walk now runs up-screen-right
  // from this wall, and eleven metres of clerestory standing on the down-screen
  // side of a room is eleven metres of masonry between that room and the lens.
  // Broken to waist height, the same wall becomes the thing that lets the player
  // stand in the walk and look down into the lit nave — two rooms in one frame
  // for the cost of lowering a wall. The hero landmark sits at `hall.x − 5`,
  // eight metres west of the break, so the shot that this elevation exists for
  // is unaffected.
  const ruinX = clamp(room.ruinFromX, minX + c + 6, maxX - 3);
  wallRun(B, {
    x0: minX + c, z0: minZ, x1: ruinX, z1: minZ, nx: 0, nz: -1,
    height: perimeterHeight(0, -1, tall, low), ruin: 0.18, group: 'far',
  });
  wallRun(B, {
    x0: ruinX, z0: minZ, x1: maxX, z1: minZ, nx: 0, nz: -1,
    height: 3.1, plinth: 0.4, stringCourse: 0, ruin: 0.65, group: 'far',
  });
  buttressRun(B, { x0: minX + c, z0: minZ, x1: ruinX, z1: minZ, nx: 0, nz: -1, height: tall * 0.72, spacing: 6.2, group: 'far' });
  windowRun(B, { x0: minX + c + 2, z0: minZ + 0.1, x1: ruinX - 2, z1: minZ + 0.1, nx: 0, nz: -1, sill: 5.4, height: 3.4, spacing: 5.6, group: 'far' });
  // The rubble the fallen stretch left, on the hall side of it.
  rubblePile(B, { x: (ruinX + maxX) * 0.5, z: minZ + 1.6, radius: 2.8, height: 1.1, count: 14 });
  B.keepOut((ruinX + maxX) * 0.5, minZ + 1.6, 3.0);

  // West (backdrop): the sanctuary wall, carrying the rose window.
  wallRun(B, {
    x0: minX, z0: minZ + c, x1: minX, z1: maxZ, nx: -1, nz: 0,
    height: perimeterHeight(-1, 0, tall, low), ruin: 0.10, group: 'far',
  });
  buttressRun(B, { x0: minX, z0: minZ + c, x1: minX, z1: maxZ, nx: -1, nz: 0, height: tall * 0.78, spacing: 7.0, group: 'far' });
  roseWindow(B, { x: minX + 0.42, y: 7.4, z: room.naveZ, radius: 2.9, spokes: rng.int(8, 12), yaw: Math.PI * 0.5, group: 'far' });

  // Chamfer: the canted corner with the gate to the processional way.
  const gate = room.doors.find((d) => d.id === 'gate');
  archedWall(B, {
    x: (minX + minX + c) * 0.5, z: (minZ + c + minZ) * 0.5,
    yaw: DIAG_YAW, width: c * Math.SQRT2, height: tall * 0.82,
    span: gate.width, rise: ARCH.archRise, sill: 0, nx: -0.7, nz: -0.7, group: 'far',
  });
  // The grille's local +X is its WIDTH, so it takes the wall's own yaw. At
  // DIAG_YAW + PI/2 it stood edge-on in the opening — a row of bars seen from
  // the side, which is invisible and useless.
  portcullis(B, { x: gate.x, z: gate.z, y: 0, width: gate.width - 0.25, height: 3.9, yaw: DIAG_YAW });
  // Lighting the gate, which is the entire `depth` shot.
  //
  // The two great braziers stand WIDE of the opening, not in front of it: at
  // 1.9 m they sat exactly where the arch projects on screen and the shot came
  // back as two bright blobs pasted over a black hole. Pushed out to 3.6 m they
  // rake across the jambs instead, and the reveal reads as thick masonry.
  for (const s of [-1, 1]) {
    const bx = gate.x + DIR.screenDown[0] * 1.4 + s * 3.6 * Math.SQRT1_2;
    const bz = gate.z + DIR.screenDown[1] * 1.4 - s * 3.6 * Math.SQRT1_2;
    brazier(B, { x: bx, z: bz, kind: 'great' });
    B.keepOut(bx, bz, 1.6);
  }
  // Sconces on the chamfer wall either side of the arch. Small, and the only
  // thing that puts any value on nine metres of otherwise unlit backdrop.
  for (const s of [-1, 1]) {
    const sx = gate.x + s * 2.9 * Math.SQRT1_2 + DIR.screenDown[0] * 0.5;
    const sz = gate.z - s * 2.9 * Math.SQRT1_2 + DIR.screenDown[1] * 0.5;
    // `sconce`'s yaw is the direction the BRACKET REACHES, not the wall normal.
    // The chamfer wall's outward normal points up-screen, so the bracket has to
    // reach back into the hall — DIAG_YAW, not DIAG_YAW + PI, which buries the
    // cup and its flame inside a metre of masonry where nothing can see it.
    sconce(B, { x: sx, y: 3.3, z: sz, yaw: DIAG_YAW, group: 'far' });
  }
  // And a great brazier three metres THROUGH the gate, standing in the
  // processional. This is what makes the opening a bright hole in a dark wall
  // instead of a dark hole in a dark wall, and it is the whole read of the
  // `depth` shot: you can see that there is somewhere to go.
  {
    const tx = gate.x + DIR.screenUp[0] * 3.4;
    const tz = gate.z + DIR.screenUp[1] * 3.4;
    brazier(B, { x: tx, z: tz, kind: 'great' });
    B.keepOut(tx, tz, 1.6);
  }

  // South (camera side): one continuous low screen wall with piers. It opens
  // itself where the undercroft stair crosses it — see `openSegments` — and the
  // stair itself belongs to the LINK, not to this room. It used to be built
  // here, rising south out of the wall, while the undercroft built a second
  // flight rising north through the same three cubic metres; the two of them
  // sealed the only route west and made five rooms unreachable.
  lowWall(B, { x0: minX, z0: maxZ, x1: maxX, z1: maxZ, nx: 0, nz: 1, height: low, group: 'near' });

  // East (camera side): low, with the crypt door punched through a taller porch.
  const cryptDoor = room.doors.find((d) => d.id === 'cryptMouth');
  lowWall(B, { x0: maxX, z0: minZ, x1: maxX, z1: cryptDoor.z - 2.4, nx: 1, nz: 0, height: low, group: 'near' });
  lowWall(B, { x0: maxX, z0: cryptDoor.z + 2.4, x1: maxX, z1: maxZ, nx: 1, nz: 0, height: low, group: 'near' });
  archedWall(B, {
    x: maxX, z: cryptDoor.z, yaw: Math.PI * 0.5, width: 4.8, height: 3.6,
    span: cryptDoor.width, rise: 1.15, sill: 0, nx: 1, nz: 0, group: 'near',
  });
  // A hinged iron gate standing open in it. Two leaves at different angles put
  // a tangle of thin verticals across the doorway, and thin verticals in front
  // of a lit opening are the cheapest depth cue in the frame.
  ironGate(B, { x: maxX - 0.2, z: cryptDoor.z, y: 0, width: cryptDoor.width - 0.2, height: 2.9, yaw: Math.PI * 0.5 });

  // --- 3. the two arcades ---------------------------------------------------
  // Bay width ~3.6 m. Gothic naves run 4-5 m, but the pier is the unit the eye
  // counts and a denser rhythm is what makes a colonnade read as one object
  // at 24 m rather than as four separate pillars.
  const bays = clamp(Math.round((maxX - minX - 8) / rng.range(3.3, 3.9)), 5, 9);
  const arcX0 = minX + 8.4, arcX1 = maxX - 1.4;

  // North arcade: complete, with a clerestory wall above and a vaulted aisle
  // behind it. Up-screen, so it can be as tall as it likes.
  const capsN = arcade(B, {
    x0: arcX0, z0: naveN, x1: arcX1, z1: naveN, bays,
    capitalHeight: 5.6, wallAbove: 3.2, depth: 1.0, rise: ARCH.archRise, group: 'far',
  });

  // South arcade: RUINED. Columns and springers only.
  //
  // This is a deliberate camera decision dressed as a story. The south arcade
  // stands between the lens and the player; complete arches there would put a
  // band of masonry across the middle of every hall shot. Broken, it gives the
  // frame a foreground rhythm of vertical piers with open sky between them —
  // which is better composition AND a better room.
  const capsS = arcade(B, {
    x0: arcX0, z0: naveS, x1: arcX1, z1: naveS, bays,
    capitalHeight: 4.9, wallAbove: 0, depth: 0.9, rise: ARCH.archRise,
    ruin: 1.0, group: 'near',
  });

  // --- 4. vaults ------------------------------------------------------------
  // Over the north aisle only, plus the two westernmost nave bays. Everything
  // east of that is open to the sky, which is where the moon shafts come down
  // and where the rubble on the floor came from.
  const aisleD = naveN - minZ;
  for (let i = 0; i < bays; i++) {
    const a = capsN[i], b = capsN[i + 1];
    const bx = (a.x + b.x) * 0.5;
    const bw = Math.abs(b.x - a.x);
    vaultBay(B, {
      x: bx, z: minZ + aisleD * 0.5, w: bw, d: aisleD,
      springY: 5.6, rise: Math.min(bw, aisleD) * 0.34, group: 'vault',
      collapsed: rng.float() < 0.18,
    });
  }
  // THE NAVE HAS NO VAULT, and that is a decision rather than an omission.
  //
  // At this camera the nave IS the play space, and anything spanning it at 9 m
  // sits between the lens and the floor for the whole width of the frame. Two
  // bays of nave vaulting were built first and they put three hard black slabs
  // across the hero shot — see the `case 'vault'` note in index.js. The room
  // that survives is the one the story wants anyway: the high vault came down
  // long ago, the springers are still there on the piers, the rubble is still
  // on the floor, and the night sky is the ceiling.
  //
  // What replaces it is the SPRINGERS: the first two voussoirs of each rib,
  // still sitting on the capitals and stopping in mid-air. They cost 60
  // triangles a bay and they are the whole reason the missing vault reads as
  // lost rather than as never built.
  for (let i = 1; i < bays; i++) {
    const cap = capsN[i];
    for (const s of [-1, 1]) {
      const stub = springerGeo(room.naveHalf * 2.4, 0.66, 0.24, 0.28, rng.range(0.18, 0.34));
      if (stub) B.push('wall', 'far', stub, matAt(cap.x, 8.5, naveN + 0.35, s * 0.68));
    }
  }
  // Where the rubble of the fallen vault lies, in nave-bay units from the west.
  const naveVaultBays = Math.max(2, Math.round(bays * 0.45));
  // The rubble the collapsed bays dropped, right under the hole.
  const holeX = capsN[naveVaultBays - 1] ? (capsN[naveVaultBays - 1].x + capsN[naveVaultBays].x) * 0.5 : room.x;
  rubblePile(B, { x: holeX + rng.range(-1, 1), z: room.naveZ + rng.range(-1.5, 1.5), radius: 3.4, height: 1.25, count: 18 });
  B.keepOut(holeX, room.naveZ, 3.6);
  // The cold pool of sky light under the hole. This is fill, not a source — see
  // LIGHTING.moonPool.
  B.light({ kind: 'moonPool', x: holeX, y: LIGHTING.moonPool.height, z: room.naveZ, phase: 0, rate: 0 });

  // --- 5. furniture ---------------------------------------------------------
  altar(B, { x: sancX - 1.2, z: room.naveZ, y: 0.92, yaw: Math.PI * 0.5 });
  candelabrum(B, { x: sancX - 1.2, z: room.naveZ - 2.4, y: 0.92, arms: rng.int(4, 6), height: 1.35 });
  candelabrum(B, { x: sancX - 1.2, z: room.naveZ + 2.4, y: 0.92, arms: rng.int(4, 6), height: 1.35 });
  candleCluster(B, { x: sancX + 2.6, z: room.naveZ + rng.range(-1, 1), y: 0.0, count: rng.int(5, 9), radius: 0.7 });

  // Saints along the north aisle wall, facing the nave.
  for (let i = 0; i < bays; i++) {
    if (rng.float() < 0.34) continue;
    const x = capsN[i].x + (capsN[i + 1].x - capsN[i].x) * 0.5;
    kneelingSaint(B, { x, z: minZ + 1.5, yaw: rng.range(2.6, 3.7), scale: rng.range(0.92, 1.12), group: 'far' });
    B.keepOut(x, minZ + 1.5, 1.4);
  }
  // Banners hung from the clerestory between the arcade bays.
  for (let i = 1; i < bays; i++) {
    if (rng.float() < 0.45) continue;
    banner(B, {
      x: capsN[i].x, y: 7.2, z: naveN - 0.55, yaw: 0,
      width: rng.range(1.0, 1.4), height: rng.range(2.6, 3.8),
    });
  }
  // Tombs along the south aisle, in the shadow of the ruined arcade.
  for (let i = 0; i < bays; i++) {
    if (rng.float() < 0.45) continue;
    const x = capsS[i].x + (capsS[i + 1].x - capsS[i].x) * 0.5 + rng.range(-0.6, 0.6);
    const z = naveS + rng.range(1.8, Math.max(2.2, maxZ - naveS - 1.6));
    sarcophagus(B, { x, z, yaw: rng.range(-0.12, 0.12) + Math.PI * 0.5, group: 'near' });
    B.keepOut(x, z, 1.8);
  }

  // --- 6. practicals --------------------------------------------------------
  //
  // Three braziers in the nave, at a spacing that leaves genuine darkness
  // between them, each placed against something worth lighting: a column base,
  // the sanctuary steps, the rubble pile. Never a grid.
  const naveLights = [
    // ON the sanctuary dais, beside the altar: the vanishing point of the hero
    // shot has to be the brightest thing in it or the eye has nowhere to go.
    { x: sancX + 1.6, z: room.naveZ - room.naveHalf * 0.62, y: 0.92, kind: 'great' },
    { x: sancX + 4.0, z: room.naveZ + room.naveHalf * 0.62, kind: 'standard' },
    { x: room.x - 4.5, z: room.naveZ + room.naveHalf * 0.62, kind: 'standard' },
    { x: room.x + 3.0, z: room.naveZ - room.naveHalf * 0.55, kind: 'great' },
    { x: maxX - 5.0, z: room.naveZ + room.naveHalf * 0.50, kind: 'standard' },
  ];
  for (const l of naveLights) { brazier(B, { x: l.x, y: l.y ?? 0, z: l.z, kind: l.kind }); B.keepOut(l.x, l.z, 1.5); }
  // Sconces on the north aisle wall, low and dim: they define the wall plane
  // without competing with the braziers for the eye.
  for (let i = 0; i < bays; i += 2) {
    const x = capsN[i].x + rng.range(-0.5, 0.5);
    sconce(B, { x, y: 3.1, z: minZ + 0.55, yaw: 0, group: 'far' });
  }
  // SCONCES ON THE PIERS THEMSELVES, facing into the nave.
  //
  // "Light placement should sculpt: rim-lighting the columns, silhouetting
  // arches." A brazier standing on the floor lights a pier's plinth and leaves
  // four metres of shaft in the dark, so the colonnade photographs as a row of
  // black slots. A sconce bracketed to the pier at 3.2 m rakes UP the shaft and
  // across the capital, and because it is on the nave face the far side of every
  // pier stays black — which is the contrast that makes the row read as round.
  //
  // Alternated between the two arcades so the nave is lit from one side then the
  // other down its length, never symmetrically.
  for (let i = 1; i < bays; i++) {
    const north = i % 2 === 1;
    const cap = north ? capsN[i] : capsS[i];
    const r = ARCH.columnRadius * 1.15;
    sconce(B, {
      x: cap.x, y: 3.15 + rng.range(-0.12, 0.12), z: cap.z + (north ? r : -r),
      yaw: north ? 0 : Math.PI, group: north ? 'far' : 'near',
    });
  }

  // --- 7. debris ------------------------------------------------------------
  dressDebris(B, room, { x: room.x, z: room.z, hw: room.w * 0.46, hd: room.d * 0.46, y: 0, density: 1.0, bones: false });
  // Lifted paving in the nave: flat slabs tipped out of the floor by
  // subsidence. Nearly free (they are the `slab` instance kind) and they are
  // what stops the middle of the hero shot being an empty grey plane.
  scatter(B, {
    mat: 'wall', kind: 'slab', count: rng.int(14, 26),
    x: room.x, z: room.naveZ, hw: room.w * 0.42, hd: room.naveHalf * 0.95,
    y: 0, lift: -0.06, scale: [0.6, 1.5], upright: true, avoid: B.avoid,
  });
  for (let i = 0; i < rng.int(2, 5); i++) {
    brokenWeapon(B, {
      x: room.x + rng.range(-room.w * 0.35, room.w * 0.35),
      z: room.naveZ + rng.range(-room.naveHalf, room.naveHalf),
    });
  }
}

// ===========================================================================
// 2. the processional way
// ===========================================================================

export function buildProcessional(B, room) {
  const rng = B.rng;
  const W = room.w, L = room.d;
  const bays = room.bays;
  const bayLen = L / bays;
  const capH = 7.4;
  const p = { x: 0, z: 0 };

  // Floor: a raised causeway between two shallow gutters, so the walk has a
  // centre line and the water/rubble collects at the edges.
  floorSlab(B, { x: room.x, z: room.z, w: W + 1.5, d: L + 1.5, y: 0, yaw: room.yaw, resolution: 2.0 });

  // Two colonnades running the length, in the room's LOCAL frame.
  for (const side of [-1, 1]) {
    const lx = side * W * 0.5;
    toWorld(room, lx, -L * 0.5, p); const x0 = p.x, z0 = p.z;
    toWorld(room, lx, L * 0.5, p); const x1 = p.x, z1 = p.z;
    // Local +X maps to world screen-right, local −X to screen-left. The
    // screen-left colonnade is backdrop and gets the full treatment; the
    // screen-right one is nearer the lens, so its arches are broken out.
    const isNear = side > 0;
    arcade(B, {
      x0, z0, x1, z1, bays,
      capitalHeight: capH, wallAbove: isNear ? 0 : 3.4, depth: 1.15,
      rise: ARCH.archRise, radius: 0.58,
      ruin: isNear ? 0.75 : 0.15,
      group: isNear ? 'near' : 'far',
    });
    // The outer wall behind each colonnade.
    toWorld(room, lx + side * 2.3, -L * 0.5, p); const wx0 = p.x, wz0 = p.z;
    toWorld(room, lx + side * 2.3, L * 0.5, p); const wx1 = p.x, wz1 = p.z;
    const nx = side * Math.SQRT1_2, nz = -side * Math.SQRT1_2;
    if (isNear) {
      lowWall(B, { x0: wx0, z0: wz0, x1: wx1, z1: wz1, nx, nz, height: 2.4, group: 'near', ruin: 0.4 });
    } else {
      wallRun(B, { x0: wx0, z0: wz0, x1: wx1, z1: wz1, nx, nz, height: 10.5, ruin: 0.30, group: 'far' });
      buttressRun(B, { x0: wx0, z0: wz0, x1: wx1, z1: wz1, nx, nz, height: 7.0, spacing: bayLen, group: 'far' });
      windowRun(B, { x0: wx0, z0: wz0, x1: wx1, z1: wz1, nx, nz, sill: 4.6, height: 3.0, spacing: bayLen, group: 'far' });
    }
  }

  // Vaults bay by bay, with the recorded bays open to the sky.
  for (let i = 0; i < bays; i++) {
    const lz = -L * 0.5 + bayLen * (i + 0.5);
    toWorld(room, 0, lz, p);
    const open = room.openBays.includes(i);
    vaultBay(B, {
      x: p.x, z: p.z, w: W, d: bayLen, yaw: room.yaw,
      springY: capH + 0.4, rise: W * 0.30, collapsed: open, group: 'vault',
    });
    if (open) {
      // Where the sky comes in, so does the rubble and a cold pool of fill.
      rubblePile(B, { x: p.x + rng.range(-1.5, 1.5), z: p.z + rng.range(-1.5, 1.5), radius: 2.6, height: 1.0, count: 12 });
      B.keepOut(p.x, p.z, 2.8);
      B.light({ kind: 'moonPool', x: p.x, y: LIGHTING.moonPool.height, z: p.z, phase: 0, rate: 0 });
    }
  }

  // Braziers, alternating sides down the length so the walk is a zigzag of light
  // and shadow rather than a lit tunnel. Every third bay only.
  for (let i = 0; i < bays; i++) {
    if (i % 3 !== 1) continue;
    const side = i % 6 === 1 ? -1 : 1;
    toWorld(room, side * (W * 0.5 - 1.3), -L * 0.5 + bayLen * (i + 0.5), p);
    brazier(B, { x: p.x, z: p.z, kind: 'great' });
    B.keepOut(p.x, p.z, 1.6);
  }

  // Banners between the backdrop colonnade's bays — the processional dressing.
  for (let i = 1; i < bays; i++) {
    if (rng.float() < 0.4) continue;
    toWorld(room, -W * 0.5 + 0.9, -L * 0.5 + bayLen * i, p);
    banner(B, { x: p.x, y: 6.6, z: p.z, yaw: room.yaw + Math.PI * 0.5, width: rng.range(1.1, 1.5), height: rng.range(3.0, 4.2) });
  }

  // Saints on plinths facing the axis, at the bays with no brazier.
  for (let i = 0; i < bays; i++) {
    if (i % 3 === 1 || rng.float() < 0.45) continue;
    const side = rng.float() < 0.5 ? -1 : 1;
    toWorld(room, side * (W * 0.5 - 1.1), -L * 0.5 + bayLen * (i + 0.5), p);
    kneelingSaint(B, { x: p.x, z: p.z, yaw: room.yaw + (side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5), scale: rng.range(1.0, 1.2) });
    B.keepOut(p.x, p.z, 1.3);
  }

  dressDebris(B, room, { x: room.x, z: room.z, hw: W * 0.4, hd: L * 0.44, y: 0, density: 0.8, bones: false });
}

// ===========================================================================
// 3. the boss arena
// ===========================================================================

export function buildArena(B, room) {
  const rng = B.rng;
  const R = room.radius;
  const sides = room.sides;
  const pit = room.pitDepth;

  // Sunken floor, a ring of steps, and the surrounding ambulatory at y=0.
  floorSlab(B, { x: room.x, z: room.z, w: R * 1.55, d: R * 1.55, y: -pit, resolution: 2.4, surface: 'ash' });
  floorSlab(B, { x: room.x, z: room.z, w: R * 2.3, d: R * 2.3, y: 0, resolution: 2.6 });

  // The steps down: three concentric octagonal rings.
  const rings = 3;
  for (let r = 0; r < rings; r++) {
    const rr = R * 0.78 + (R * 0.16 * r) / rings;
    const y = -pit + (pit * (r + 1)) / rings;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const mx = room.x + Math.cos((a0 + a1) * 0.5) * rr;
      const mz = room.z + Math.sin((a0 + a1) * 0.5) * rr;
      const segLen = 2 * rr * Math.sin(Math.PI / sides) * 1.04;
      const yaw = -(a0 + a1) * 0.5;
      B.push('wall', 'far', blockGeo(1.1, pit / rings, segLen, rng, 0.03), matAt(mx, y - pit / rings * 0.5, mz, yaw));
      B.solid(mx, y - pit / rings * 0.5, mz, 0.6, pit / rings * 0.5, segLen * 0.5, yaw, SURFACE.wall);
    }
  }

  // Perimeter: a polygon of wall runs, each height driven by which way it faces.
  const entryA = Math.atan2(DIR.screenDown[1], DIR.screenDown[0]);
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
    const am = (a0 + a1) * 0.5;
    // Leave the segment facing the processional way open — that is the way in.
    // `entryA` points from the arena centre back down the axis, so the entry
    // segment is the one whose outward normal is closest to it. Wrapped into
    // (−pi, pi] first, or a segment at 350 deg never matches one at 10 deg.
    let da = (am - entryA + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    const isEntry = Math.abs(da) < (Math.PI / sides) * 1.15;
    const x0 = room.x + Math.cos(a0) * R, z0 = room.z + Math.sin(a0) * R;
    const x1 = room.x + Math.cos(a1) * R, z1 = room.z + Math.sin(a1) * R;
    const nx = Math.cos(am), nz = Math.sin(am);
    const h = perimeterHeight(nx, nz, ARCH.arenaBackdrop, ARCH.arenaCamSide);
    if (isEntry) {
      archedWall(B, {
        x: (x0 + x1) * 0.5, z: (z0 + z1) * 0.5, yaw: -am + Math.PI * 0.5,
        width: Math.hypot(x1 - x0, z1 - z0) + 0.6, height: Math.max(6.5, h),
        span: 5.0, rise: ARCH.archRise, sill: 0, nx, nz, group: 'far',
      });
      continue;
    }
    wallRun(B, { x0, z0, x1, z1, nx, nz, height: h, ruin: h > 6 ? 0.35 : 0.2, group: nx + nz > 0.3 ? 'near' : 'far' });
    if (h > 7) {
      buttress(B, { x: x0, z: z0, nx, nz, height: h * 0.7, width: 1.5, projection: 1.8, stages: 3, group: 'far' });
      // Piers rising above the wall, carrying the stumps of the lost dome ribs.
      const px = room.x + Math.cos(am) * (R - 1.2), pz = room.z + Math.sin(am) * (R - 1.2);
      B.push('wall', 'far', prismGeo(1.0, 0.72, h + 2.4, 8, rng.range(-0.1, 0.1)), matAt(px, (h + 2.4) * 0.5, pz, rng.range(0, 3.1)));
      B.solid(px, (h + 2.4) * 0.5, pz, 0.9, (h + 2.4) * 0.5, 0.9, 0, SURFACE.wall);
      // Chains hanging from where the dome was.
      if (rng.float() < 0.6) {
        hangingChain(B, {
          x: px + rng.range(-1.5, 1.5), y: h + 2.0, z: pz + rng.range(-1.5, 1.5),
          length: rng.range(3.0, 6.5), ring: rng.float() < 0.5, ringRadius: rng.range(0.3, 0.6),
        });
      }
    }
  }

  // The broken angel, off-centre and turned away from the entry so the camera
  // sees the three-quarter view of the standing stump and the fallen torso lies
  // across the frame rather than into it.
  const angleA = entryA + Math.PI + rng.range(-0.4, 0.4);
  brokenAngel(B, {
    x: room.x + Math.cos(angleA) * R * 0.34, z: room.z + Math.sin(angleA) * R * 0.34,
    y: -pit, yaw: -angleA + rng.range(-0.4, 0.4), scale: 1.35,
  });
  B.keepOut(room.x + Math.cos(angleA) * R * 0.34, room.z + Math.sin(angleA) * R * 0.34, 5.5);

  // A low central platform: the boss's ground, and the thing the camera frames.
  dais(B, { x: room.x, z: room.z, y: -pit, w: R * 0.52, d: R * 0.52, height: 0.55, steps: 2, tread: 0.55 });
  B.keepOut(room.x, room.z, R * 0.42);

  // Rim braziers: six great ones on the ambulatory, spaced so the pit floor has
  // pools and shadows rather than an even wash.
  const nB = 6;
  for (let i = 0; i < nB; i++) {
    const a = entryA + Math.PI * 0.35 + (i / nB) * Math.PI * 1.7 + rng.range(-0.08, 0.08);
    const r = R * rng.range(0.86, 0.94);
    const bx = room.x + Math.cos(a) * r, bz = room.z + Math.sin(a) * r;
    brazier(B, { x: bx, z: bz, kind: 'great' });
    B.keepOut(bx, bz, 1.6);
  }
  // Candelabra on the central platform: the one warm detail at the focus.
  for (let i = 0; i < 3; i++) {
    const a = rng.range(0, Math.PI * 2);
    candelabrum(B, {
      x: room.x + Math.cos(a) * R * 0.22, z: room.z + Math.sin(a) * R * 0.22,
      y: -pit + 0.55, arms: rng.int(3, 5), height: rng.range(1.1, 1.5),
    });
  }
  // Cold fill under the lost dome: the arena is open to the sky by definition.
  B.light({ kind: 'moonPool', x: room.x, y: LIGHTING.moonPool.height - pit, z: room.z, phase: 0, rate: 0 });

  dressDebris(B, room, { x: room.x, z: room.z, hw: R * 0.62, hd: R * 0.62, y: -pit, density: 1.5, bones: true });
  for (let i = 0; i < rng.int(5, 10); i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(R * 0.25, R * 0.7);
    brokenWeapon(B, { x: room.x + Math.cos(a) * r, y: -pit, z: room.z + Math.sin(a) * r });
  }
}

// ===========================================================================
// 4. the crypt corridor
// ===========================================================================

export function buildCorridor(B, room) {
  const rng = B.rng;
  const W = room.w, L = room.d;
  const springY = 2.15;
  const p = { x: 0, z: 0 };

  floorSlab(B, { x: room.x, z: room.z, w: W + 1.2, d: L + 1.2, y: 0, yaw: room.yaw, resolution: 1.8 });

  for (const side of [-1, 1]) {
    const lx = side * (W * 0.5 + ARCH.partitionThick * 0.5);
    toWorld(room, lx, -L * 0.5, p); const x0 = p.x, z0 = p.z;
    toWorld(room, lx, L * 0.5, p); const x1 = p.x, z1 = p.z;
    const nx = side * Math.SQRT1_2, nz = -side * Math.SQRT1_2;
    wallRun(B, {
      x0, z0, x1, z1, nx, nz, thick: ARCH.partitionThick,
      height: side > 0 ? ARCH.cryptBackdrop * 0.62 : ARCH.cryptBackdrop,
      stringCourse: 0, ruin: 0.0, group: side > 0 ? 'near' : 'far',
    });
  }

  barrelVault(B, {
    x: room.x, z: room.z, yaw: room.yaw, width: W + 0.3, length: L, springY,
    rise: 1.35, ribEvery: L / room.bays, segments: 11,
  });

  // Niches down the screen-left (backdrop) wall, most of them occupied. This is
  // the wall the camera actually sees down the corridor's axis, and the niches
  // are what give it depth once GTAO fills them.
  const rows = room.nicheRows;
  const perRow = Math.max(2, Math.round(L / 3.2));
  for (let r = 0; r < rows; r++) {
    const y = 0.55 + r * 1.05;
    if (y + 1.0 > springY) break;
    for (let i = 0; i < perRow; i++) {
      const lz = -L * 0.5 + (L / perRow) * (i + 0.5) + rng.range(-0.2, 0.2);
      toWorld(room, -W * 0.5 + 0.06, lz, p);
      const n = niche(B, { x: p.x, y, z: p.z, width: 0.72, height: 0.95, depth: 0.46, yaw: room.yaw + Math.PI * 0.5, group: 'far' });
      if (rng.float() > DEBRIS.nicheFill) continue;
      // What is in it: skulls, an urn, or a stack of long bones.
      const roll = rng.float();
      if (roll < 0.55) {
        for (let k = 0; k < rng.int(1, 3); k++) {
          B.instance('bone', 'skull', new THREE.Matrix4().compose(
            new THREE.Vector3(n.x + rng.range(-0.18, 0.18), n.y + 0.12, n.z + rng.range(-0.12, 0.12)),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.2, 0.2), rng.range(0, 6.28), rng.range(-0.2, 0.2))),
            new THREE.Vector3(1, 1, 1)
          ));
        }
      } else if (roll < 0.8) {
        urn(B, { x: n.x, y: n.y + 0.02, z: n.z, height: rng.range(0.4, 0.6), group: 'far' });
      } else {
        for (let k = 0; k < rng.int(2, 4); k++) {
          B.instance('bone', 'bone', new THREE.Matrix4().compose(
            new THREE.Vector3(n.x + rng.range(-0.1, 0.1), n.y + 0.05 + k * 0.06, n.z + rng.range(-0.2, 0.2)),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, 6.28), Math.PI * 0.5 + rng.range(-0.1, 0.1))),
            new THREE.Vector3(1, 1, 1)
          ));
        }
      }
    }
  }

  // Sconces on the backdrop wall — dim, every third rib, so the corridor reads
  // as a chain of small pools rather than a lit tube.
  // One sconce every ~4.5 m. A 22 m corridor with three lights in it is not
  // atmospheric, it is unlit: the pools have to overlap at their feet or the
  // player walks through stretches with no information in them at all.
  const sconces = Math.max(3, Math.round(L / 4.5));
  for (let i = 0; i < sconces; i++) {
    const lz = -L * 0.5 + (L / sconces) * (i + 0.55);
    toWorld(room, -W * 0.5 + 0.1, lz, p);
    sconce(B, { x: p.x, y: 1.95, z: p.z, yaw: room.yaw + Math.PI * 0.5, group: 'far' });
  }
  // One brazier at the midpoint, on the floor, so there is a single strong pool
  // somewhere along the walk. Off the centre line so the player can pass it.
  for (const t of [-0.22, 0.30]) {
    toWorld(room, W * 0.26 * (t < 0 ? 1 : -1), L * t, p);
    brazier(B, { x: p.x, z: p.z, kind: 'small' });
    B.keepOut(p.x, p.z, 1.3);
  }

  // Damp: roots through the vault haunch, and water-worn debris in the gutters.
  for (let i = 0; i < rng.int(1, 3); i++) {
    toWorld(room, -W * 0.5 + 0.3, rng.range(-L * 0.4, L * 0.4), p);
    roots(B, { x: p.x, y: springY - 0.3, z: p.z, dx: Math.SQRT1_2, dz: -Math.SQRT1_2, count: 2, length: 2.2, radius: 0.10 });
  }
  dressDebris(B, room, { x: room.x, z: room.z, hw: W * 0.34, hd: L * 0.44, y: 0, density: 0.75, bones: true, shards: false });
}

// ===========================================================================
// 5. the ossuary
// ===========================================================================

export function buildOssuary(B, room) {
  const rng = B.rng;
  const hw = room.w * 0.5, hd = room.d * 0.5;
  floorSlab(B, { x: room.x, z: room.z, w: room.w + 1, d: room.d + 1, y: 0, resolution: 2.0, surface: 'bone' });

  const corners = [
    [-hw, -hd, hw, -hd, 0, -1], [hw, -hd, hw, hd, 1, 0],
    [hw, hd, -hw, hd, 0, 1], [-hw, hd, -hw, -hd, -1, 0],
  ];
  for (const [ax, az, bx, bz, nx, nz] of corners) {
    const h = perimeterHeight(nx, nz, ARCH.cryptBackdrop, ARCH.cryptCamSide);
    wallRun(B, {
      x0: room.x + ax, z0: room.z + az, x1: room.x + bx, z1: room.z + bz,
      nx, nz, height: h, thick: ARCH.wallThick * 0.8, stringCourse: 0,
      ruin: nx + nz > 0.3 ? 0.4 : 0.12, group: nx + nz > 0.3 ? 'near' : 'far',
    });
  }

  // Four squat piers carrying a low groin vault: an ossuary is a undercroft.
  const cols = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = room.x + sx * room.w * 0.22, z = room.z + sz * room.d * 0.22;
      cols.push(column(B, { x, z, height: 3.1, radius: 0.55, group: sx + sz > 0 ? 'near' : 'far' }));
      B.keepOut(x, z, 1.2);
    }
  }
  vaultBay(B, { x: room.x, z: room.z, w: room.w * 0.5, d: room.d * 0.5, springY: 3.1, rise: 1.1, group: 'vault' });
  // A LEDGE, not a lid. A full ceiling slab over an isometric room roofs the
  // camera out of it entirely — you see the top of the slab and nothing else.
  // Two strips along the up-screen walls give the room a lid where the lens
  // looks INTO it and leave the rest open.
  ceilingSlab(B, { x: room.x, z: room.z - hd * 0.68, w: room.w * 1.02, d: room.d * 0.32, y: ARCH.cryptBackdrop - 0.45, group: 'vault' });
  ceilingSlab(B, { x: room.x - hw * 0.72, z: room.z, w: room.w * 0.28, d: room.d * 1.02, y: ARCH.cryptBackdrop - 0.45, group: 'vault' });

  // Bone stacks against the backdrop walls: a wall of long bones with a course
  // of skulls on top, which is what an ossuary actually is.
  for (let w = 0; w < 2; w++) {
    const alongX = w === 0;
    const len = alongX ? room.w - 3 : room.d - 3;
    const n = Math.round(len / 0.42);
    for (let i = 0; i < n; i++) {
      const t = -len * 0.5 + (len / n) * (i + 0.5);
      const bx = alongX ? room.x + t : room.x - hw + 1.0;
      const bz = alongX ? room.z - hd + 1.0 : room.z + t;
      const stackH = rng.int(3, 6);
      for (let k = 0; k < stackH; k++) {
        B.instance('bone', 'bone', new THREE.Matrix4().compose(
          new THREE.Vector3(bx + rng.range(-0.06, 0.06), 0.06 + k * 0.11, bz + rng.range(-0.06, 0.06)),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(
            0, alongX ? Math.PI * 0.5 + rng.range(-0.08, 0.08) : rng.range(-0.08, 0.08), Math.PI * 0.5
          )),
          new THREE.Vector3(1, 1, 1.0)
        ));
      }
      if (rng.float() < 0.5) {
        B.instance('bone', 'skull', new THREE.Matrix4().compose(
          new THREE.Vector3(bx, 0.12 + stackH * 0.11, bz),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.15, 0.15), rng.range(0, 6.28), rng.range(-0.15, 0.15))),
          new THREE.Vector3(1, 1, 1)
        ));
      }
    }
    B.keepOut(alongX ? room.x : room.x - hw + 1.0, alongX ? room.z - hd + 1.0 : room.z, 1.6);
  }

  // Tombs in the middle, one of them opened.
  for (let i = 0; i < rng.int(2, 4); i++) {
    const x = room.x + rng.range(-room.w * 0.2, room.w * 0.2);
    const z = room.z + rng.range(-room.d * 0.2, room.d * 0.2);
    sarcophagus(B, { x, z, yaw: rng.range(0, Math.PI), open: i === 0 });
    B.keepOut(x, z, 1.9);
  }

  brazier(B, { x: room.x + room.w * 0.26, z: room.z - room.d * 0.24, kind: 'standard' });
  B.keepOut(room.x + room.w * 0.26, room.z - room.d * 0.24, 1.4);
  candleCluster(B, { x: room.x - room.w * 0.2, z: room.z + room.d * 0.16, count: rng.int(4, 8), radius: 0.8 });
  dressDebris(B, room, { x: room.x, z: room.z, hw: hw - 1.5, hd: hd - 1.5, y: 0, density: 1.2, bones: true });
}

// ===========================================================================
// 6. a collapsed side chamber
// ===========================================================================

export function buildChamber(B, room) {
  const rng = B.rng;
  const hw = room.w * 0.5, hd = room.d * 0.5;
  const collapsed = room.tags.includes('collapsed');

  floorSlab(B, {
    x: room.x, z: room.z, w: room.w + 1, d: room.d + 1, y: 0, resolution: 1.8,
    dip: collapsed ? { x: hw * 0.3, z: -hd * 0.3, radius: 3.0, depth: 0.35 } : null,
  });

  const runs = [
    [-hw, -hd, hw, -hd, 0, -1], [hw, -hd, hw, hd, 1, 0],
    [hw, hd, -hw, hd, 0, 1], [-hw, hd, -hw, -hd, -1, 0],
  ];
  for (const [ax, az, bx, bz, nx, nz] of runs) {
    wallRun(B, {
      x0: room.x + ax, z0: room.z + az, x1: room.x + bx, z1: room.z + bz,
      nx, nz, height: perimeterHeight(nx, nz, ARCH.cryptBackdrop, ARCH.cryptCamSide),
      thick: ARCH.partitionThick, stringCourse: 0,
      ruin: collapsed ? 0.6 : 0.2, group: nx + nz > 0.3 ? 'near' : 'far',
    });
  }

  if (collapsed) {
    // The ceiling came down in one corner: a heap of masonry, roots through the
    // hole, and a cold pool of sky light on the heap.
    const cx = room.x + hw * 0.35, cz = room.z - hd * 0.35;
    rubblePile(B, { x: cx, z: cz, radius: 3.2, height: 1.8, count: 22, scale: 1.3 });
    B.keepOut(cx, cz, 3.4);
    for (let i = 0; i < rng.int(2, 4); i++) {
      roots(B, {
        x: cx + rng.range(-1.6, 1.6), y: 2.6 + rng.range(-0.4, 0.6), z: cz + rng.range(-1.6, 1.6),
        dx: rng.signed() * 0.6, dz: rng.signed() * 0.6, count: 2, length: 3.0, radius: 0.16,
      });
    }
    B.light({ kind: 'moonPool', x: cx, y: LIGHTING.moonPool.height + 0.5, z: cz, phase: 0, rate: 0 });
    ceilingSlab(B, { x: room.x - hw * 0.55, z: room.z - hd * 0.1, w: room.w * 0.4, d: room.d * 0.8, y: 3.2, group: 'vault' });
  } else {
    // See the ossuary: a ledge along the two up-screen walls, never a lid.
    ceilingSlab(B, { x: room.x, z: room.z - hd * 0.66, w: room.w, d: room.d * 0.34, y: 3.3, group: 'vault' });
    ceilingSlab(B, { x: room.x - hw * 0.7, z: room.z, w: room.w * 0.3, d: room.d, y: 3.3, group: 'vault' });
  }

  // A BIG chamber needs internal order or it is a shed. Four squat piers and the
  // vault they carry cost ~1.5k triangles and turn a 24 x 18 box into a space
  // with a middle and four corners — which is the difference between the sluice
  // reading as a room and reading as the gap between two doorways.
  const big = room.w * room.d > 210;
  if (big) {
    const caps = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = room.x + sx * room.w * 0.24, z = room.z + sz * room.d * 0.24;
        if (inOpening(B, x, z, 1.0)) { caps.push(null); continue; }
        caps.push(column(B, { x, z, height: 3.2, radius: 0.58, group: sx + sz > 0 ? 'near' : 'far' }));
        B.keepOut(x, z, 1.3);
      }
    }
    vaultBay(B, {
      x: room.x, z: room.z, w: room.w * 0.48, d: room.d * 0.48,
      springY: 3.2, rise: Math.min(room.w, room.d) * 0.16, group: 'vault',
      collapsed: collapsed,
    });
    for (let i = 0; i < rng.int(2, 4); i++) {
      const a = rng.range(0, Math.PI * 2);
      hangingChain(B, {
        x: room.x + Math.cos(a) * room.w * 0.3, y: 3.0, z: room.z + Math.sin(a) * room.d * 0.3,
        length: rng.range(1.4, 2.4), ring: rng.float() < 0.4,
      });
    }
  }

  sconce(B, { x: room.x - hw + 0.35, y: 2.0, z: room.z, yaw: Math.PI * 0.5, group: 'far' });
  if (big) {
    sconce(B, { x: room.x - hw * 0.2, y: 2.0, z: room.z - hd + 0.35, yaw: 0, group: 'far' });
    const bx = room.x + hw * 0.5, bz = room.z - hd * 0.5;
    if (!inOpening(B, bx, bz, 1.4)) { brazier(B, { x: bx, z: bz, kind: 'standard' }); B.keepOut(bx, bz, 1.5); }
  }
  candleCluster(B, { x: room.x - hw * 0.4, z: room.z + hd * 0.35, count: rng.int(3, 6), radius: 0.55 });
  for (let i = 0; i < rng.int(1, big ? 5 : 3); i++) {
    const sx = room.x + rng.range(-hw * 0.6, hw * 0.6), sz = room.z + rng.range(-hd * 0.6, hd * 0.6);
    if (inOpening(B, sx, sz, 1.6)) continue;
    sarcophagus(B, { x: sx, z: sz, yaw: rng.range(0, Math.PI), open: rng.float() < 0.6 });
    B.keepOut(sx, sz, 1.8);
  }
  dressDebris(B, room, { x: room.x, z: room.z, hw: hw - 1, hd: hd - 1, y: 0, density: collapsed ? 1.6 : 0.9, bones: true });
}

// ===========================================================================
// 7. the flooded undercroft
// ===========================================================================

export function buildUndercroft(B, room) {
  const rng = B.rng;
  const hw = room.w * 0.5, hd = room.d * 0.5;
  const y = room.y;

  floorSlab(B, { x: room.x, z: room.z, w: room.w + 1, d: room.d + 1, y, resolution: 2.0 });

  // The water. A separate, perfectly flat plane a few centimetres below the
  // lowest floor point, with the `water.still` surface — near-mirror roughness,
  // so render's SSR puts every flame in the room on it. This is the single
  // strongest "Diablo IV interior" cue available and it costs one quad.
  const wg = floorGeo(room.w - 1.2, room.d - 1.2, 6, rng, { amplitude: 0.12 });
  B.push('water', 'water', wg, matAt(room.x, room.waterY, room.z, 0), 'keep');

  const runs = [
    [-hw, -hd, hw, -hd, 0, -1], [hw, -hd, hw, hd, 1, 0],
    [hw, hd, -hw, hd, 0, 1], [-hw, hd, -hw, -hd, -1, 0],
  ];
  for (const [ax, az, bx, bz, nx, nz] of runs) {
    wallRun(B, {
      x0: room.x + ax, z0: room.z + az, x1: room.x + bx, z1: room.z + bz,
      nx, nz, height: perimeterHeight(nx, nz, room.ceiling, 2.0) , thick: ARCH.wallThick,
      stringCourse: 0, ruin: 0.25, group: nx + nz > 0.3 ? 'near' : 'far',
    });
  }

  // A grid of squat piers standing in the water, carrying a low groin vault.
  // Reflections of the piers in the water are what sell the depth of the room.
  const nx3 = 3, nz3 = 3;
  const caps = [];
  for (let i = 0; i < nx3; i++) {
    for (let j = 0; j < nz3; j++) {
      const x = room.x + (i / (nx3 - 1) - 0.5) * room.w * 0.62;
      const z = room.z + (j / (nz3 - 1) - 0.5) * room.d * 0.62;
      caps.push(column(B, { x, z, height: 3.4, radius: 0.62, group: (i + j) > 2 ? 'near' : 'far' }));
      B.keepOut(x, z, 1.3);
    }
  }
  for (let i = 0; i < nx3 - 1; i++) {
    for (let j = 0; j < nz3 - 1; j++) {
      const a = caps[i * nz3 + j], b = caps[(i + 1) * nz3 + j + 1];
      vaultBay(B, {
        x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5,
        w: Math.abs(b.x - a.x), d: Math.abs(b.z - a.z),
        springY: y + 3.4, rise: Math.abs(b.x - a.x) * 0.3, group: 'vault',
        collapsed: rng.float() < 0.22,
      });
    }
  }

  // Half-drowned tombs, a couple of them tipped.
  for (let i = 0; i < rng.int(2, 4); i++) {
    const x = room.x + rng.range(-hw * 0.55, hw * 0.55);
    const z = room.z + rng.range(-hd * 0.55, hd * 0.55);
    sarcophagus(B, { x, z, yaw: rng.range(0, Math.PI), open: rng.float() < 0.7 });
    B.keepOut(x, z, 1.9);
  }
  // Chains from the vault down into the water.
  for (let i = 0; i < rng.int(2, 5); i++) {
    hangingChain(B, {
      x: room.x + rng.range(-hw * 0.7, hw * 0.7), y: y + 3.2, z: room.z + rng.range(-hd * 0.7, hd * 0.7),
      length: rng.range(1.6, 2.9), ring: rng.float() < 0.4,
    });
  }

  // Practicals: two braziers on the DRY ledges only, so the light rakes across
  // the water instead of standing in it.
  brazier(B, { x: room.x - hw + 1.8, z: room.z - hd + 1.8, kind: 'standard' });
  brazier(B, { x: room.x + hw * 0.5, z: room.z + hd - 2.0, kind: 'standard' });
  B.keepOut(room.x - hw + 1.8, room.z - hd + 1.8, 1.4);
  B.keepOut(room.x + hw * 0.5, room.z + hd - 2.0, 1.4);
  for (let i = 0; i < 2; i++) {
    sconce(B, { x: room.x - hw + 0.35, y: y + 2.2, z: room.z + (i - 0.5) * room.d * 0.5, yaw: Math.PI * 0.5, group: 'far' });
  }

  dressDebris(B, room, { x: room.x, z: room.z, hw: hw - 1.5, hd: hd - 1.5, y, density: 0.8, bones: true });
}

// ===========================================================================
// 8. the shadow shrine
// ===========================================================================

export function buildShrine(B, room) {
  const rng = B.rng;
  const hw = room.w * 0.5, hd = room.d * 0.5;
  const y = room.y;

  floorSlab(B, { x: room.x, z: room.z, w: room.w + 1, d: room.d + 1, y, resolution: 1.8 });

  const runs = [
    [-hw, -hd, hw, -hd, 0, -1], [hw, -hd, hw, hd, 1, 0],
    [hw, hd, -hw, hd, 0, 1], [-hw, hd, -hw, -hd, -1, 0],
  ];
  for (const [ax, az, bx, bz, nx, nz] of runs) {
    wallRun(B, {
      x0: room.x + ax, z0: room.z + az, x1: room.x + bx, z1: room.z + bz,
      nx, nz, height: perimeterHeight(nx, nz, room.ceiling, 2.2), thick: ARCH.wallThick,
      ruin: 0.22, group: nx + nz > 0.3 ? 'near' : 'far',
    });
  }
  buttressRun(B, { x0: room.x - hw, z0: room.z - hd, x1: room.x + hw, z1: room.z - hd, nx: 0, nz: -1, height: room.ceiling * 0.6, spacing: 4.5, group: 'far' });

  // The dais and the monolith, placed up-screen of the shrine landmark so the
  // camera looks straight at the violet.
  const mx = room.focusX, mz = room.focusZ;
  dais(B, { x: mx, z: mz, y, w: 5.2, d: 5.2, height: 0.62, steps: 2, tread: 0.55 });
  runeMonolith(B, { x: mx, z: mz, y: y + 0.62, height: rng.range(3.4, 4.2), width: rng.range(1.1, 1.4), yaw: rng.range(-0.15, 0.15), shards: rng.int(4, 7) });
  B.keepOut(mx, mz, 4.0);

  // A ring of kneeling saints facing the monolith. Repetition is the point here
  // — a congregation reads as ritual — but every one is a different size, a
  // different rotation and a different break.
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.15, 0.15);
    const r = rng.range(5.0, Math.min(hw, hd) - 1.4);
    const sx = mx + Math.cos(a) * r, sz = mz + Math.sin(a) * r;
    kneelingSaint(B, { x: sx, z: sz, y, yaw: -a + Math.PI * 0.5, scale: rng.range(0.85, 1.15) });
    B.keepOut(sx, sz, 1.2);
  }

  // Candles on the dais steps: the shrine's only WARM light, and the reason the
  // violet reads as violet. A purely violet room has nothing to be violet
  // against and the eye white-balances it away within a second.
  for (let i = 0; i < 3; i++) {
    const a = rng.range(0, Math.PI * 2);
    candleCluster(B, {
      x: mx + Math.cos(a) * rng.range(2.4, 3.2), z: mz + Math.sin(a) * rng.range(2.4, 3.2),
      y, count: rng.int(4, 9), radius: 0.7,
    });
  }
  brazier(B, { x: room.x + hw * 0.55, z: room.z + hd * 0.5, kind: 'standard' });
  B.keepOut(room.x + hw * 0.55, room.z + hd * 0.5, 1.4);

  // The rift light itself is registered by lighting.js as a `shadowRift`.
  B.light({ kind: 'shadowRift', x: mx, y: y + 2.6, z: mz, phase: rng.range(0, 100), rate: 0.35 });

  dressDebris(B, room, { x: room.x, z: room.z, hw: hw - 1.5, hd: hd - 1.5, y, density: 0.6, bones: false });
}

// ===========================================================================
// 9. a plain passage (the loop)
// ===========================================================================

export function buildPassage(B, room) {
  const rng = B.rng;
  const W = room.d, L = room.w;      // this room is authored long-side-along-X
  const p = { x: 0, z: 0 };
  // `w` is the slab's LOCAL X and this room is authored long-side-along-X, so
  // the slab takes the room's own yaw unrotated. (`barrelVault` below wants
  // +90 degrees because its length runs along local Z instead — the two kit
  // pieces genuinely disagree, which is why both calls say why.)
  floorSlab(B, { x: room.x, z: room.z, w: L + 1, d: W + 1, y: room.y, yaw: room.yaw, resolution: 1.6 });

  for (const side of [-1, 1]) {
    const lz = side * (W * 0.5);
    toWorld(room, -L * 0.5, lz, p); const x0 = p.x, z0 = p.z;
    toWorld(room, L * 0.5, lz, p); const x1 = p.x, z1 = p.z;
    const nx = -Math.sin(room.yaw) * side, nz = -Math.cos(room.yaw) * side;
    wallRun(B, {
      x0, z0, x1, z1, nx, nz, thick: ARCH.partitionThick,
      height: perimeterHeight(nx, nz, 3.4, 1.5), stringCourse: 0, ruin: 0.35,
      group: nx + nz > 0.3 ? 'near' : 'far',
    });
  }
  barrelVault(B, {
    x: room.x, z: room.z, yaw: room.yaw + Math.PI * 0.5, width: W + 0.3, length: L,
    springY: room.y + 1.9, rise: 1.05, ribEvery: 2.4, segments: 9,
  });

  const n = Math.max(1, Math.round(L / 7));
  for (let i = 0; i < n; i++) {
    toWorld(room, -L * 0.5 + (L / n) * (i + 0.5), -W * 0.5 + 0.12, p);
    sconce(B, { x: p.x, y: room.y + 1.7, z: p.z, yaw: room.yaw, group: 'far' });
  }
  dressDebris(B, room, { x: room.x, z: room.z, hw: L * 0.4, hd: W * 0.3, y: room.y, density: 0.7, bones: true, shards: false });
  void rng;
}

// ===========================================================================
// 10. the lamp walk — a gallery that crosses the frame instead of receding
// ===========================================================================

/**
 * THE ROOM THAT ANSWERS "WIDER".
 *
 * Everything in the old level ran up-screen or down-screen, so the whole
 * building photographed as a vertical strip. This one is authored long-side
 * along the room's local +X, which at `DIAG_YAW` is the world direction
 * (+1, 0, −1)/√2 — dead screen-RIGHT. Thirty metres of arcade therefore cross
 * the frame horizontally, and because the camera's horizontal field is 1.78×
 * its vertical one, that is the direction with the most room to spend.
 *
 * Its up-screen side is an OPEN arcade rather than a wall: the reliquary porch
 * stands three metres beyond it, so the eye reads walk → arcade → lit chapel,
 * which is the second of the level's two composed three-space views.
 */
export function buildGallery(B, room) {
  const rng = B.rng;
  const L = room.w, W = room.d;             // long side along local X
  const bays = room.bays;
  const p = { x: 0, z: 0 };
  const capH = 5.4;

  floorSlab(B, { x: room.x, z: room.z, w: L + 1.4, d: W + 1.4, y: room.y, yaw: room.yaw, resolution: 2.0 });

  // Up-screen: the open arcade. Piers and arches only, with a clerestory band
  // above so the silhouette has a top edge.
  toWorld(room, -L * 0.5, -W * 0.5, p); const ax0 = p.x, az0 = p.z;
  toWorld(room, L * 0.5, -W * 0.5, p); const ax1 = p.x, az1 = p.z;
  const caps = arcade(B, {
    x0: ax0, z0: az0, x1: ax1, z1: az1, bays,
    capitalHeight: capH, wallAbove: 2.6, depth: 1.0, rise: ARCH.archRise,
    ruin: 0.18, group: 'far',
  });
  buttressRun(B, {
    x0: ax0, z0: az0, x1: ax1, z1: az1,
    nx: DIR.screenUp[0], nz: DIR.screenUp[1], height: capH * 0.8, spacing: L / bays, group: 'far',
  });

  // Camera side: a balustrade, so the walk is enclosed but the lens sees over it.
  toWorld(room, -L * 0.5, W * 0.5, p); const bx0 = p.x, bz0 = p.z;
  toWorld(room, L * 0.5, W * 0.5, p); const bx1 = p.x, bz1 = p.z;
  lowWall(B, {
    x0: bx0, z0: bz0, x1: bx1, z1: bz1,
    nx: DIR.screenDown[0], nz: DIR.screenDown[1], height: 1.85, ruin: 0.3,
    pierSpacing: L / bays, group: 'near',
  });

  // The two ends.
  for (const side of [-1, 1]) {
    toWorld(room, side * L * 0.5, 0, p);
    wallRun(B, {
      x0: p.x - Math.sin(room.yaw + Math.PI * 0.5) * W * 0.5,
      z0: p.z - Math.cos(room.yaw + Math.PI * 0.5) * W * 0.5,
      x1: p.x + Math.sin(room.yaw + Math.PI * 0.5) * W * 0.5,
      z1: p.z + Math.cos(room.yaw + Math.PI * 0.5) * W * 0.5,
      nx: DIR.screenRight[0] * side, nz: DIR.screenRight[1] * side,
      height: side > 0 ? 4.6 : 3.4, ruin: 0.3, group: side > 0 ? 'far' : 'near',
    });
  }

  // THE VAULT COVERS THE UP-SCREEN HALF ONLY, and that is a camera decision.
  //
  // Vaulted full width first, and the capture came back with a black web of
  // ribs across the top two thirds of the frame: this room is twelve metres
  // deep and its long axis runs ACROSS the screen, so a vault spanning it sits
  // between the lens and the floor for the entire width of the picture. Same
  // failure the cathedral nave hit, same fix — the outer half of the walk lost
  // its roof, the inner half kept it, and the springers on the arcade capitals
  // say the rest fell rather than was never built.
  const bayLen = L / bays;
  const openFrom = rng.int(2, Math.max(2, bays - 3));
  for (let i = 0; i < bays; i++) {
    const open = i >= openFrom && i < openFrom + 2;
    toWorld(room, -L * 0.5 + bayLen * (i + 0.5), -W * 0.26, p);
    vaultBay(B, {
      x: p.x, z: p.z, w: bayLen, d: W * 0.48, yaw: room.yaw,
      springY: capH + 0.3, rise: W * 0.16, collapsed: open, group: 'vault',
      transverse: false,
    });
    if (!open) {
      const stub = springerGeo(W * 0.85, 0.62, 0.22, 0.26, rng.range(0.20, 0.36));
      toWorld(room, -L * 0.5 + bayLen * (i + 0.5), -W * 0.10, p);
      if (stub) B.push('wall', 'far', stub, matAt(p.x, capH + 0.3, p.z, room.yaw + Math.PI * 0.5));
    }
    toWorld(room, -L * 0.5 + bayLen * (i + 0.5), 0, p);
    if (open) {
      rubblePile(B, { x: p.x + rng.range(-1, 1), z: p.z + rng.range(-1, 1), radius: 2.4, height: 0.9, count: 11 });
      B.keepOut(p.x, p.z, 2.6);
      B.light({ kind: 'moonPool', x: p.x, y: LIGHTING.moonPool.height, z: p.z, phase: 0, rate: 0 });
    }
  }

  // THE LAMPS. A great brazier every third bay on alternating sides, which is
  // what the room is named for and what makes a thirty-metre walk read as a
  // sequence of pools rather than as one lit tube.
  for (let i = 0; i < bays; i++) {
    if (i % 3 !== 1) continue;
    const side = i % 6 === 1 ? -1 : 1;
    toWorld(room, -L * 0.5 + bayLen * (i + 0.5), side * (W * 0.5 - 1.4), p);
    if (inOpening(B, p.x, p.z, 1.2)) continue;
    brazier(B, { x: p.x, z: p.z, kind: 'great' });
    B.keepOut(p.x, p.z, 1.6);
  }
  // Sconces on the arcade piers, facing into the walk.
  for (let i = 1; i < caps.length - 1; i += 2) {
    const c = caps[i];
    if (c.missing) continue;
    sconce(B, { x: c.x + DIR.screenDown[0] * 0.5, y: 3.2, z: c.z + DIR.screenDown[1] * 0.5, yaw: room.yaw + Math.PI, group: 'far' });
  }
  // Banners between the arcade bays.
  for (let i = 1; i < caps.length - 1; i++) {
    if (rng.float() < 0.45) continue;
    banner(B, {
      x: caps[i].x + DIR.screenDown[0] * 0.4, y: 5.0, z: caps[i].z + DIR.screenDown[1] * 0.4,
      yaw: room.yaw, width: rng.range(1.0, 1.4), height: rng.range(2.2, 3.2),
    });
  }
  // Tomb slabs set INTO the floor down the centre line — a cloister walk is a
  // burial ground, and slabs cost one flat box each.
  for (let i = 0; i < bays; i++) {
    if (rng.float() < 0.35) continue;
    toWorld(room, -L * 0.5 + bayLen * (i + 0.5) + rng.range(-0.4, 0.4), rng.range(-0.8, 0.8), p);
    if (inOpening(B, p.x, p.z, 0.8)) continue;
    B.push('wall', 'floor', blockGeo(2.1, 0.12, 1.0, rng, 0.03), matAt(p.x, room.y + 0.06, p.z, room.yaw + rng.range(-0.05, 0.05)));
  }
  dressDebris(B, room, { x: room.x, z: room.z, hw: L * 0.42, hd: W * 0.34, y: room.y, density: 0.7, bones: false });
}

// ===========================================================================
// 11. the cloister — an open court, and the widest room in the level
// ===========================================================================

export function buildCloister(B, room) {
  const rng = B.rng;
  const hw = room.w * 0.5, hd = room.d * 0.5;
  const walk = room.walkW;
  const y = room.y;
  const tall = ARCH.cloisterBackdrop, low = ARCH.cloisterCamSide;

  floorSlab(B, { x: room.x, z: room.z, w: room.w + 1.5, d: room.d + 1.5, y, resolution: 2.4 });
  // The court itself sits one step below the walk, which is what a real garth
  // does and what stops thirty-two metres of floor reading as one plane.
  const gw = room.w - walk * 2, gd = room.d - walk * 2;
  floorSlab(B, {
    x: room.x, z: room.z, w: gw, d: gd, y: y - 0.28, resolution: 2.0, surface: 'dirt',
    mat: 'floor', amplitude: 2.2,
  });
  for (const [ax, az, bx, bz] of [
    [-gw * 0.5, -gd * 0.5, gw * 0.5, -gd * 0.5], [gw * 0.5, -gd * 0.5, gw * 0.5, gd * 0.5],
    [gw * 0.5, gd * 0.5, -gw * 0.5, gd * 0.5], [-gw * 0.5, gd * 0.5, -gw * 0.5, -gd * 0.5],
  ]) {
    const cx = room.x + (ax + bx) * 0.5, cz = room.z + (az + bz) * 0.5;
    const len = Math.hypot(bx - ax, bz - az);
    B.push('wall', 'floor', blockGeo(Math.abs(bx - ax) + 0.5, 0.3, Math.abs(bz - az) + 0.5, rng, 0.02),
      matAt(cx, y - 0.14, cz, 0));
    void len;
  }

  // The outer wall of each walk, and the arcade that faces the court.
  const runs = [
    [-hw, -hd, hw, -hd, 0, -1], [hw, -hd, hw, hd, 1, 0],
    [hw, hd, -hw, hd, 0, 1], [-hw, hd, -hw, -hd, -1, 0],
  ];
  for (const [ax, az, bx, bz, nx, nz] of runs) {
    const h = perimeterHeight(nx, nz, tall, low);
    wallRun(B, {
      x0: room.x + ax, z0: room.z + az, x1: room.x + bx, z1: room.z + bz,
      nx, nz, height: h, ruin: 0.32, group: nx + nz > 0.3 ? 'near' : 'far',
    });
    if (h > 5) {
      buttressRun(B, {
        x0: room.x + ax, z0: room.z + az, x1: room.x + bx, z1: room.z + bz,
        nx, nz, height: h * 0.7, spacing: 5.4, group: 'far',
      });
      windowRun(B, {
        x0: room.x + ax * 0.86, z0: room.z + az * 0.86, x1: room.x + bx * 0.86, z1: room.z + bz * 0.86,
        nx, nz, sill: 3.0, height: 2.4, spacing: 5.0, group: 'far', gargoyles: false,
      });
    }
    // The arcade round the garth. Paired shafts, low, and the single most
    // repeated silhouette in the level — a cloister IS its arcade.
    const ix = ax * (1 - walk / hw * 0.98), iz = az * (1 - walk / hd * 0.98);
    const jx = bx * (1 - walk / hw * 0.98), jz = bz * (1 - walk / hd * 0.98);
    arcade(B, {
      x0: room.x + ix, z0: room.z + iz, x1: room.x + jx, z1: room.z + jz,
      bays: room.bays, capitalHeight: 3.5, wallAbove: 0.9, depth: 0.75,
      radius: 0.3, rise: 1.18, ruin: nx + nz > 0.3 ? 0.5 : 0.12,
      group: nx + nz > 0.3 ? 'near' : 'far',
    });
    // A lean-to roof over each walk, only on the two up-screen sides.
    if (nx + nz < -0.3) {
      const mx = room.x + (ax + jx) * 0.5, mz = room.z + (az + jz) * 0.5;
      // A lean-to over the two BACKDROP walks only. The two camera-side walks
      // stay open: a roof there is a slab between the lens and the court, and
      // the court is the whole reason this room exists.
      ceilingSlab(B, {
        x: mx, z: mz,
        w: Math.abs(bx - ax) > Math.abs(bz - az) ? room.w * 0.98 : walk,
        d: Math.abs(bx - ax) > Math.abs(bz - az) ? walk : room.d * 0.98,
        y: 4.5, group: 'vault',
      });
    }
  }

  // The well: the thing at the centre of every cloister, and the thing that
  // makes the court read as a place rather than as a gap between four walks.
  const wx = room.x + rng.range(-1.5, 1.5), wz = room.z + rng.range(-1.5, 1.5);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    B.push('wall', 'far', blockGeo(0.55, 0.95, 0.42, rng, 0.05),
      matAt(wx + Math.cos(a) * 1.35, y - 0.28 + 0.48, wz + Math.sin(a) * 1.35, -a));
  }
  B.solid(wx, y + 0.2, wz, 1.7, 0.6, 1.7, 0, SURFACE.wall);
  hangingChain(B, { x: wx, y: y + 2.9, z: wz, length: 2.4, ring: true, ringRadius: 0.42 });
  for (const s of [-1, 1]) {
    B.push('wall', 'far', prismGeo(0.18, 0.15, 3.0, 6, 0), matAt(wx + s * 1.3, y + 1.2, wz, 0));
  }
  B.push('steel', 'iron', blockGeo(3.0, 0.16, 0.16, rng, 0.02), matAt(wx, y + 2.9, wz, 0));
  B.keepOut(wx, wz, 2.6);

  // What grows in a courtyard nobody has swept for a century.
  for (let i = 0; i < rng.int(4, 7); i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(gw * 0.18, gw * 0.46);
    roots(B, {
      x: room.x + Math.cos(a) * r, y: y + rng.range(0.4, 1.4), z: room.z + Math.sin(a) * r,
      dx: rng.signed() * 0.5, dz: rng.signed() * 0.5, count: 2, length: rng.range(2.2, 3.6), radius: 0.15,
    });
  }
  for (let i = 0; i < rng.int(2, 4); i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(gw * 0.15, gw * 0.42);
    kneelingSaint(B, {
      x: room.x + Math.cos(a) * r, z: room.z + Math.sin(a) * r, y: y - 0.28,
      yaw: rng.range(0, 6.28), scale: rng.range(0.9, 1.2),
    });
  }
  // Braziers: three, on the WALK not in the court, so the light rakes along the
  // arcade and the middle of the garth stays a cold blue hole.
  const corners = [[-1, -1], [1, -1], [-1, 1]];
  for (const [sx, sz] of corners) {
    const bx = room.x + sx * (hw - walk * 0.5), bz = room.z + sz * (hd - walk * 0.5);
    if (inOpening(B, bx, bz, 1.4)) continue;
    brazier(B, { x: bx, y, z: bz, kind: 'great' });
    B.keepOut(bx, bz, 1.6);
  }
  B.light({ kind: 'moonPool', x: room.x, y: y + LIGHTING.moonPool.height, z: room.z, phase: 0, rate: 0 });
  candleCluster(B, { x: wx + 2.2, z: wz + 1.4, y: y - 0.28, count: rng.int(4, 8), radius: 0.8 });

  dressDebris(B, room, { x: room.x, z: room.z, hw: hw - 1.5, hd: hd - 1.5, y, density: 0.9, bones: false });
}

// ===========================================================================
// 12. the reliquary — the dead end that is worth the walk
// ===========================================================================

export function buildReliquary(B, room) {
  const rng = B.rng;
  const R = room.w * 0.5;
  const sides = room.sides;
  const y = room.y;

  floorSlab(B, { x: room.x, z: room.z, w: R * 1.95, d: R * 1.95, y, resolution: 2.0 });

  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
    const am = (a0 + a1) * 0.5;
    const x0 = room.x + Math.cos(a0) * R, z0 = room.z + Math.sin(a0) * R;
    const x1 = room.x + Math.cos(a1) * R, z1 = room.z + Math.sin(a1) * R;
    const nx = Math.cos(am), nz = Math.sin(am);
    const h = perimeterHeight(nx, nz, room.ceiling, 2.3);
    wallRun(B, { x0, z0, x1, z1, nx, nz, height: h, ruin: 0.10, group: nx + nz > 0.3 ? 'near' : 'far' });
    // A niche in every up-screen bay, with a reliquary jar in most of them.
    if (nx + nz < -0.2) {
      const n = niche(B, {
        x: room.x + Math.cos(am) * (R - 0.1), y: y + 1.05, z: room.z + Math.sin(am) * (R - 0.1),
        width: 0.9, height: 1.25, depth: 0.5, yaw: -am + Math.PI * 0.5, group: 'far',
      });
      if (rng.float() < 0.78) urn(B, { x: n.x, y: n.y + 0.02, z: n.z, height: rng.range(0.5, 0.72), mat: 'gold', group: 'far' });
      sconce(B, { x: room.x + Math.cos(am) * (R - 0.45), y: y + 2.9, z: room.z + Math.sin(am) * (R - 0.45), yaw: -am + Math.PI * 0.5 + Math.PI, group: 'far' });
    }
  }
  // The rose window in the up-screen wall, and a vault over that half only.
  {
    const a = Math.atan2(DIR.screenUp[1], DIR.screenUp[0]);
    roseWindow(B, {
      x: room.x + Math.cos(a) * (R - 0.35), y: y + 5.0, z: room.z + Math.sin(a) * (R - 0.35),
      radius: R * 0.30, spokes: rng.int(8, 12), yaw: -a + Math.PI * 0.5, group: 'far',
    });
  }
  vaultBay(B, {
    x: room.x + DIR.screenUp[0] * R * 0.42, z: room.z + DIR.screenUp[1] * R * 0.42,
    w: R * 1.2, d: R * 1.0, yaw: DIAG_YAW, springY: 4.6, rise: R * 0.30, group: 'vault',
  });

  // THE RELIQUARY ITSELF: a gilded chest on a stepped dais, the one object in
  // the level made of a bright metal, lit from four sides by candles.
  dais(B, { x: room.x, z: room.z, y, w: 4.4, d: 4.4, height: 0.72, steps: 3, tread: 0.5 });
  const gold = B.mat.gold ? 'gold' : 'iron';
  B.push(gold, 'iron', blockGeo(1.9, 0.95, 1.15, rng, 0.02), matAt(room.x, y + 1.2, room.z, rng.range(-0.06, 0.06)));
  B.push(gold, 'iron', prismGeo(1.05, 0.32, 0.55, 4, 0), matAt(room.x, y + 1.9, room.z, Math.PI * 0.25));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    B.push(gold, 'iron', prismGeo(0.12, 0.09, 1.5, 6, 0),
      matAt(room.x + Math.cos(a) * 0.85, y + 1.35, room.z + Math.sin(a) * 0.85, 0));
  }
  B.solid(room.x, y + 1.2, room.z, 1.1, 0.9, 0.8, 0, SURFACE.metal);
  B.keepOut(room.x, room.z, 3.4);

  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rng.range(-0.2, 0.2);
    candleCluster(B, {
      x: room.x + Math.cos(a) * rng.range(2.6, 3.4), z: room.z + Math.sin(a) * rng.range(2.6, 3.4),
      y, count: rng.int(5, 10), radius: 0.75,
    });
  }
  for (let i = 0; i < 2; i++) {
    const a = Math.atan2(DIR.screenDown[1], DIR.screenDown[0]) + (i - 0.5) * 1.4;
    candelabrum(B, {
      x: room.x + Math.cos(a) * R * 0.55, z: room.z + Math.sin(a) * R * 0.55, y,
      arms: rng.int(4, 6), height: 1.5,
    });
  }
  {
    const a = Math.atan2(DIR.screenRight[1], DIR.screenRight[0]);
    const bx = room.x + Math.cos(a) * R * 0.62, bz = room.z + Math.sin(a) * R * 0.62;
    if (!inOpening(B, bx, bz, 1.4)) { brazier(B, { x: bx, y, z: bz, kind: 'standard' }); B.keepOut(bx, bz, 1.5); }
  }
  dressDebris(B, room, { x: room.x, z: room.z, hw: R * 0.6, hd: R * 0.6, y, density: 0.35, bones: false });
}

// ===========================================================================
// 13. the fallen nave — forty metres of ruin, across the frame
// ===========================================================================

export function buildFallenNave(B, room) {
  const rng = B.rng;
  const L = room.w, W = room.d;             // long side along local X = screen right
  const bays = room.bays;
  const y = room.y;
  const p = { x: 0, z: 0 };
  const tall = ARCH.naveBackdrop, low = ARCH.naveCamSide;
  const bayLen = L / bays;

  floorSlab(B, {
    x: room.x, z: room.z, w: L + 1.5, d: W + 1.5, y, yaw: room.yaw, resolution: 2.4,
    dip: { x: rng.range(-L * 0.2, L * 0.2), z: rng.range(-2, 2), radius: 5.0, depth: 0.34 },
  });

  // Up-screen: the surviving elevation. This is the room's whole silhouette and
  // the only tall thing on the level's west side.
  toWorld(room, -L * 0.5, -W * 0.5, p); const ux0 = p.x, uz0 = p.z;
  toWorld(room, L * 0.5, -W * 0.5, p); const ux1 = p.x, uz1 = p.z;
  wallRun(B, {
    x0: ux0, z0: uz0, x1: ux1, z1: uz1,
    nx: DIR.screenUp[0], nz: DIR.screenUp[1], height: tall, ruin: 0.55, group: 'far',
  });
  buttressRun(B, {
    x0: ux0, z0: uz0, x1: ux1, z1: uz1,
    nx: DIR.screenUp[0], nz: DIR.screenUp[1], height: tall * 0.66, spacing: bayLen, group: 'far',
  });
  windowRun(B, {
    x0: ux0 + DIR.screenRight[0] * 2.5, z0: uz0 + DIR.screenRight[1] * 2.5,
    x1: ux1 - DIR.screenRight[0] * 2.5, z1: uz1 - DIR.screenRight[1] * 2.5,
    nx: DIR.screenUp[0], nz: DIR.screenUp[1], sill: 3.8, height: 3.2, spacing: bayLen, group: 'far',
  });

  // Camera side: broken to knee height, so the lens looks straight in.
  toWorld(room, -L * 0.5, W * 0.5, p); const dx0 = p.x, dz0 = p.z;
  toWorld(room, L * 0.5, W * 0.5, p); const dx1 = p.x, dz1 = p.z;
  lowWall(B, {
    x0: dx0, z0: dz0, x1: dx1, z1: dz1,
    nx: DIR.screenDown[0], nz: DIR.screenDown[1], height: low, ruin: 0.6, pierSpacing: bayLen, group: 'near',
  });
  // The two gable ends.
  for (const side of [-1, 1]) {
    toWorld(room, side * L * 0.5, 0, p);
    const ex = p.x, ez = p.z;
    wallRun(B, {
      x0: ex + Math.cos(room.yaw) * 0 + Math.sin(room.yaw) * (-W * 0.5),
      z0: ez + Math.cos(room.yaw) * (-W * 0.5),
      x1: ex + Math.sin(room.yaw) * (W * 0.5), z1: ez + Math.cos(room.yaw) * (W * 0.5),
      nx: DIR.screenRight[0] * side, nz: DIR.screenRight[1] * side,
      height: side < 0 ? tall * 0.8 : 3.0, ruin: 0.5, group: side < 0 ? 'far' : 'near',
    });
  }

  // TWO ARCADES down the length, both broken. The point of a roofless nave is
  // that you see the sky through the arches, so `ruin` is high on both and the
  // springers are what is left.
  const capsAll = [];
  for (const side of [-1, 1]) {
    toWorld(room, -L * 0.5 + 1.5, side * W * 0.22, p); const x0 = p.x, z0 = p.z;
    toWorld(room, L * 0.5 - 1.5, side * W * 0.22, p); const x1 = p.x, z1 = p.z;
    capsAll.push(arcade(B, {
      x0, z0, x1, z1, bays: bays - 1,
      capitalHeight: side < 0 ? 6.2 : 5.2, wallAbove: 0, depth: 0.95,
      rise: ARCH.archRise, ruin: side < 0 ? 0.62 : 0.85,
      group: side < 0 ? 'far' : 'near',
    }));
  }
  // Springers on the surviving piers: the reason a missing vault reads as lost.
  for (const caps of capsAll) {
    for (let i = 1; i < caps.length - 1; i++) {
      if (caps[i].missing || rng.float() < 0.35) continue;
      const stub = springerGeo(W * 0.9, 0.7, 0.24, 0.28, rng.range(0.16, 0.30));
      if (stub) B.push('wall', 'far', stub, matAt(caps[i].x, caps[i].top + 0.1, caps[i].z, room.yaw + rng.range(-0.1, 0.1)));
    }
  }

  // What came down, and what grew afterwards.
  for (let i = 0; i < rng.int(3, 5); i++) {
    toWorld(room, rng.range(-L * 0.42, L * 0.42), rng.range(-W * 0.3, W * 0.3), p);
    rubblePile(B, { x: p.x, z: p.z, y, radius: rng.range(2.4, 4.0), height: rng.range(0.9, 1.7), count: rng.int(12, 20) });
    B.keepOut(p.x, p.z, 3.0);
    B.light({ kind: 'moonPool', x: p.x, y: y + LIGHTING.moonPool.height, z: p.z, phase: 0, rate: 0 });
  }
  // A fallen rose window lying face-up in the floor, which is the one object
  // that says "this was the great church and it fell".
  {
    toWorld(room, rng.range(-L * 0.25, L * 0.1), rng.range(-1, 3), p);
    const g = fallenRoseGeo(rng.range(3.0, 4.0), rng.int(8, 12), rng);
    if (g) B.push('wall', 'far', g, matAt(p.x, y + 0.12, p.z, rng.range(0, 3.14)));
    B.keepOut(p.x, p.z, 3.0);
  }
  for (let i = 0; i < rng.int(4, 7); i++) {
    toWorld(room, rng.range(-L * 0.45, L * 0.45), rng.range(-W * 0.35, W * 0.35), p);
    roots(B, {
      x: p.x, y: y + rng.range(0.2, 1.2), z: p.z, dx: rng.signed() * 0.6, dz: rng.signed() * 0.6,
      count: 2, length: rng.range(2.4, 3.8), radius: 0.17,
    });
  }
  // Sparse fire: this room is lit by the sky, and two braziers is enough to say
  // somebody still comes here.
  for (const t of [-0.30, 0.24]) {
    toWorld(room, L * t, W * (t < 0 ? 0.30 : -0.26), p);
    if (inOpening(B, p.x, p.z, 1.4)) continue;
    brazier(B, { x: p.x, y, z: p.z, kind: 'great' });
    B.keepOut(p.x, p.z, 1.6);
  }
  for (let i = 0; i < rng.int(2, 4); i++) {
    toWorld(room, rng.range(-L * 0.4, L * 0.4), -W * 0.42, p);
    sarcophagus(B, { x: p.x, y, z: p.z, yaw: room.yaw + rng.range(-0.15, 0.15), open: rng.float() < 0.6, group: 'far' });
    B.keepOut(p.x, p.z, 1.9);
  }
  dressDebris(B, room, { x: room.x, z: room.z, hw: L * 0.42, hd: W * 0.4, y, density: 1.5, bones: false });
  for (let i = 0; i < rng.int(3, 7); i++) {
    toWorld(room, rng.range(-L * 0.4, L * 0.4), rng.range(-W * 0.35, W * 0.35), p);
    brokenWeapon(B, { x: p.x, y, z: p.z });
  }
}

/** A rose window that has fallen out of its wall: the same tracery, laid flat.
 *  Built in the XY plane like every other opening, then tipped onto its back. */
function fallenRoseGeo(radius, spokes, rng) {
  const g = roseWindowGeo(radius, spokes, 0.26, rng);
  if (!g) return null;
  g.rotateX(-Math.PI * 0.5);
  return g;
}

// ===========================================================================
// 14. the chain span — a bridge with nothing under it
// ===========================================================================

/**
 * The only room in the level with a hole in its floor, and the hole is the
 * point: the deck is five metres wide across a twenty-metre void, so the player
 * can see all the way down and the navigation grid has exactly one route across.
 *
 * Collision is built for the DECK ONLY. Nothing is placed over the chasm, so
 * `physics.groundAt` returns nothing there, `ai`'s grid marks it solid, and the
 * flow field routes the horde over the bridge rather than through the air —
 * which is the whole reason to build a chasm rather than paint one.
 */
export function buildBridge(B, room) {
  const rng = B.rng;
  const L = room.w, W = room.d;             // deck runs along local X
  const half = room.deckHalf;
  const p = { x: 0, z: 0 };
  const y = room.y;

  // The two landings, one at each end, full room width.
  for (const side of [-1, 1]) {
    toWorld(room, side * (L * 0.5 - 2.2), 0, p);
    floorSlab(B, { x: p.x, z: p.z, w: 5.4, d: W, y, yaw: room.yaw, resolution: 1.8 });
    // The chasm's lip: a broken edge of masonry looking into the drop.
    for (const s of [-1, 1]) {
      toWorld(room, side * (L * 0.5 - 4.6), s * (W * 0.5 - 1.0), p);
      B.push('wall', s > 0 ? 'near' : 'far', blockGeo(1.4, 1.1, W * 0.42, rng, 0.08),
        matAt(p.x, y - 0.35, p.z, room.yaw));
    }
  }

  // The deck.
  const gapC = -L * 0.5 + L * room.gapT;
  const gapHalf = 1.35;
  for (const [a, b] of [[-L * 0.5 + 1.6, gapC - gapHalf], [gapC + gapHalf, L * 0.5 - 1.6]]) {
    if (b - a < 0.6) continue;
    toWorld(room, (a + b) * 0.5, 0, p);
    floorSlab(B, { x: p.x, z: p.z, w: b - a, d: half * 2, y, yaw: room.yaw, resolution: 1.6 });
    // Parapets. Low enough to see over from this camera, high enough to read.
    for (const s of [-1, 1]) {
      toWorld(room, (a + b) * 0.5, s * (half + 0.3), p);
      B.push('wall', s > 0 ? 'near' : 'far', blockGeo(b - a, 0.95, 0.42, rng, 0.06),
        matAt(p.x, y + 0.48, p.z, room.yaw));
      B.solid(p.x, y + 0.48, p.z, (b - a) * 0.5, 0.48, 0.21, room.yaw, SURFACE.wall);
    }
    // Arch ribs under the deck, springing from the dark. Cheap, and they are
    // what makes the span read as built rather than as a plank in the air.
    const ribs = Math.max(1, Math.round((b - a) / 4.5));
    for (let i = 0; i < ribs; i++) {
      toWorld(room, a + ((b - a) * (i + 0.5)) / ribs, 0, p);
      const rib = archRingGeo(half * 2.4, 0.9, 0.4, half * 1.7, rng, 7);
      if (rib) B.push('wall', 'far', rib, matAt(p.x, y - 0.35, p.z, room.yaw));
    }
  }
  // The broken bay, planked. Walkable, and the planks are the only wood in the
  // level that is holding anything up.
  {
    toWorld(room, gapC, 0, p);
    for (let i = 0; i < 5; i++) {
      const off = (i - 2) * 0.44;
      const px = p.x + Math.cos(room.yaw) * off, pz = p.z - Math.sin(room.yaw) * off;
      B.push('wood', 'far', blockGeo(gapHalf * 2.3, 0.11, 0.36, rng, 0.02),
        matAt(px, y - 0.04, pz, room.yaw + rng.range(-0.02, 0.02)));
    }
    B.solid(p.x, y - 0.2, p.z, gapHalf * 1.2, 0.2, half, room.yaw, SURFACE.wood);
    for (const s of [-1, 1]) {
      hangingChain(B, { x: p.x + Math.cos(room.yaw) * gapHalf * s, y: y + 3.4, z: p.z - Math.sin(room.yaw) * gapHalf * s, length: rng.range(2.6, 3.6), ring: true });
    }
  }

  // Posts and chains: the span's name, and the vertical rhythm that keeps a
  // horizontal object from reading as a stripe.
  const posts = Math.max(3, Math.round(L / 5.5));
  for (let i = 0; i <= posts; i++) {
    const t = -L * 0.5 + (L / posts) * i;
    for (const s of [-1, 1]) {
      toWorld(room, t, s * (half + 0.3), p);
      B.push('wall', s > 0 ? 'near' : 'far', prismGeo(0.34, 0.28, 2.3, 6, 0), matAt(p.x, y + 1.15, p.z, rng.range(0, 3.1)));
      B.solid(p.x, y + 1.15, p.z, 0.3, 1.15, 0.3, 0, SURFACE.wall);
    }
    if (i % 2 === 1 && i < posts) {
      toWorld(room, t, 0, p);
      hangingChain(B, { x: p.x, y: y + 5.6, z: p.z, length: rng.range(2.0, 3.4), ring: rng.float() < 0.5 });
    }
  }
  // Braziers on the two centre posts.
  for (const t of [-L * 0.22, L * 0.22]) {
    toWorld(room, t, -(half + 0.3), p);
    if (inOpening(B, p.x, p.z, 1.2)) continue;
    brazier(B, { x: p.x, y: y + 2.3, z: p.z, kind: 'small' });
  }
  // Down in the dark: ledges of fallen masonry catching the light, so the drop
  // has a floor the eye can find and the depth reads as real.
  for (let i = 0; i < rng.int(5, 9); i++) {
    toWorld(room, rng.range(-L * 0.42, L * 0.42), rng.range(-W * 0.46, W * 0.46), p);
    const dy = -rng.range(2.0, room.chasmDepth);
    B.push('wall', 'far', blockGeo(rng.range(1.2, 3.0), rng.range(0.4, 0.9), rng.range(1.0, 2.6), rng, 0.09),
      matAt(p.x, y + dy, p.z, rng.range(0, 3.1)));
  }
  B.light({ kind: 'moonPool', x: room.x, y: y + LIGHTING.moonPool.height, z: room.z, phase: 0, rate: 0 });
}

// ===========================================================================
// 15. the catacomb — burial alleys, low and wide
// ===========================================================================

export function buildCatacomb(B, room) {
  const rng = B.rng;
  const hw = room.w * 0.5, hd = room.d * 0.5;
  const y = room.y;

  floorSlab(B, { x: room.x, z: room.z, w: room.w + 1, d: room.d + 1, y, resolution: 2.0, surface: 'bone' });

  const runs = [
    [-hw, -hd, hw, -hd, 0, -1], [hw, -hd, hw, hd, 1, 0],
    [hw, hd, -hw, hd, 0, 1], [-hw, hd, -hw, -hd, -1, 0],
  ];
  for (const [ax, az, bx, bz, nx, nz] of runs) {
    wallRun(B, {
      x0: room.x + ax, z0: room.z + az, x1: room.x + bx, z1: room.z + bz,
      nx, nz, height: perimeterHeight(nx, nz, ARCH.cryptBackdrop, ARCH.cryptCamSide),
      thick: ARCH.wallThick * 0.8, stringCourse: 0,
      ruin: nx + nz > 0.3 ? 0.35 : 0.1, group: nx + nz > 0.3 ? 'near' : 'far',
    });
  }

  // LOCULI WALLS: rows of shelved burial walls running along X, with a gap at
  // one end of each so the room is a set of alleys rather than a grid of cells.
  // This is what makes a catacomb feel different from an ossuary that happens to
  // be bigger — you walk BETWEEN things rather than across a floor.
  const rows = room.aisles;
  for (let r = 0; r < rows; r++) {
    const z = room.z - hd + (room.d * (r + 1)) / (rows + 1);
    const gapSide = r % 2 === 0 ? 1 : -1;
    const x0 = room.x - hw + 1.2 + (gapSide < 0 ? room.w * 0.30 : 0);
    const x1 = room.x + hw - 1.2 - (gapSide > 0 ? room.w * 0.30 : 0);
    wallRun(B, {
      x0, z0: z, x1, z1: z, nx: 0, nz: -1, height: 2.35,
      thick: ARCH.partitionThick * 1.5, plinth: 0.2, stringCourse: 0, ruin: 0.25,
      group: r > rows * 0.5 ? 'near' : 'far',
    });
    // The shelves themselves, and what is on them.
    const n = Math.max(2, Math.round((x1 - x0) / 1.5));
    for (let i = 0; i < n; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
      if (inOpening(B, x, z, 0.6)) continue;
      for (let k = 0; k < 3; k++) {
        const sy = y + 0.42 + k * 0.62;
        B.push('wall', 'far', blockGeo(1.35, 0.10, 0.95, rng, 0.02), matAt(x, sy, z - 0.42, 0));
        if (rng.float() < 0.62) {
          B.instance('bone', 'skull', new THREE.Matrix4().compose(
            new THREE.Vector3(x + rng.range(-0.4, 0.4), sy + 0.14, z - 0.5),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.2, 0.2), rng.range(0, 6.28), rng.range(-0.2, 0.2))),
            new THREE.Vector3(1, 1, 1)
          ));
        }
        for (let j = 0; j < rng.int(0, 3); j++) {
          B.instance('bone', 'bone', new THREE.Matrix4().compose(
            new THREE.Vector3(x + rng.range(-0.5, 0.5), sy + 0.06, z - 0.35 + rng.range(-0.15, 0.15)),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(-0.3, 0.3), Math.PI * 0.5)),
            new THREE.Vector3(1, 1, 1)
          ));
        }
      }
    }
    // A sconce on the down-screen face of each burial wall. This is the only
    // light that reaches down an aisle, and without it the alleys between the
    // walls are the darkest thing in the level by a wide margin.
    sconce(B, {
      x: room.x + (gapSide > 0 ? -room.w * 0.18 : room.w * 0.18), y: y + 1.9, z: z + 0.42,
      yaw: Math.PI, group: r > rows * 0.5 ? 'near' : 'far',
    });
    B.keepOut(room.x, z, 1.3);
  }
  // A lid over the two up-screen strips only — never over the play space.
  ceilingSlab(B, { x: room.x, z: room.z - hd * 0.74, w: room.w * 1.02, d: room.d * 0.26, y: ARCH.cryptBackdrop - 0.5, group: 'vault' });
  ceilingSlab(B, { x: room.x - hw * 0.78, z: room.z, w: room.w * 0.22, d: room.d * 1.02, y: ARCH.cryptBackdrop - 0.5, group: 'vault' });

  // The reward end: a tomb with its lid off and candles round it.
  {
    const tx = room.x + DIR.screenUp[0] * hw * 0.5, tz = room.z + DIR.screenUp[1] * hd * 0.5;
    sarcophagus(B, { x: tx, z: tz, y, yaw: rng.range(0, Math.PI), open: true });
    candleCluster(B, { x: tx + 1.6, z: tz + 1.2, y, count: rng.int(6, 10), radius: 0.85 });
    B.keepOut(tx, tz, 2.2);
  }
  for (const [sx, sz] of [[0.55, -0.6], [-0.5, 0.55]]) {
    const bx = room.x + hw * sx, bz = room.z + hd * sz;
    if (!inOpening(B, bx, bz, 1.4)) { brazier(B, { x: bx, y, z: bz, kind: 'standard' }); B.keepOut(bx, bz, 1.5); }
  }
  for (let i = 0; i < 3; i++) {
    sconce(B, { x: room.x - hw + 0.4, y: y + 2.0, z: room.z + (i - 1) * room.d * 0.3, yaw: Math.PI * 0.5, group: 'far' });
  }
  dressDebris(B, room, { x: room.x, z: room.z, hw: hw - 1.5, hd: hd - 1.5, y, density: 1.0, bones: true });
}

/** Dispatch. */
export const ROOM_BUILDERS = {
  cathedral: buildCathedral,
  processional: buildProcessional,
  arena: buildArena,
  corridor: buildCorridor,
  ossuary: buildOssuary,
  chamber: buildChamber,
  undercroft: buildUndercroft,
  shrine: buildShrine,
  passage: buildPassage,
  gallery: buildGallery,
  cloister: buildCloister,
  reliquary: buildReliquary,
  nave: buildFallenNave,
  bridge: buildBridge,
  catacomb: buildCatacomb,
};

