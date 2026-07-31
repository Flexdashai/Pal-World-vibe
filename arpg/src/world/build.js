import * as THREE from 'three';
import { ARCH, DRESS, DEBRIS, SURFACE, LIGHTING, clamp } from './tuning.js';
import { DIR, DIAG_YAW, toWorld } from './layout.js';
import {
  wallRun, lowWall, archedWall, buttress, column, arcade, vaultBay, barrelVault,
  ceilingSlab, roseWindow, lancet, floorSlab, dais, stairs, niche, rubblePile, matAt,
  springerGeo,
} from './kit.js';
import {
  kneelingSaint, gargoyle, brokenAngel, sarcophagus, altar, runeMonolith,
  portcullis, ironGate, hangingChain, banner, roots, brokenWeapon, urn, scatter,
} from './props.js';
import { brazier, sconce, candelabrum, candleCluster } from './fire.js';
import { blockGeo, prismGeo, floorGeo, GeoBucket } from './geom.js';

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
// material dressing
// ===========================================================================

/**
 * The material set for a room kind.
 *
 * `env` — the `envMapIntensity` multiplier — is doing the heaviest lifting in
 * this file and deserves its own note. The measured defect on the previous build
 * was "44% of the frame crushed to information-free black". Raising exposure
 * would lift the crushed pixels AND the lit ones and just grey the image; adding
 * more braziers measurably made it WORSE, because auto-exposure meters the frame
 * and stops down. The only lever that adds information to the dark half WITHOUT
 * touching the lit half is the indirect term, and because render's GTAO
 * multiplies indirect INSIDE the material, every crevice, column base and arch
 * soffit stays dark while the open floor picks up sky. That is what these
 * numbers are, and they are per room so a sealed crypt can still be genuinely
 * black next to a hall open to the night.
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
    default:
      break;
  }
  void room;
  return spec;
}

// ===========================================================================
// shared sub-assemblies
// ===========================================================================

/** A wall run with a gap in it for a door. `t` is the gap centre along the run. */
function wallWithGap(B, o) {
  const { x0, z0, x1, z1 } = o;
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
  const g0 = clamp(o.gapT * len - o.gapWidth * 0.5, 0, len);
  const g1 = clamp(o.gapT * len + o.gapWidth * 0.5, 0, len);
  if (g0 > 0.4) wallRun(B, { ...o, x1: x0 + ux * g0, z1: z0 + uz * g0 });
  if (len - g1 > 0.4) wallRun(B, { ...o, x0: x0 + ux * g1, z0: z0 + uz * g1 });
}

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
  // lancets and gargoyles. This wall IS the top third of the hero shot.
  wallRun(B, {
    x0: minX + c, z0: minZ, x1: maxX, z1: minZ, nx: 0, nz: -1,
    height: perimeterHeight(0, -1, tall, low), ruin: 0.18, group: 'far',
  });
  buttressRun(B, { x0: minX + c, z0: minZ, x1: maxX, z1: minZ, nx: 0, nz: -1, height: tall * 0.72, spacing: 6.2, group: 'far' });
  windowRun(B, { x0: minX + c + 2, z0: minZ + 0.1, x1: maxX - 2, z1: minZ + 0.1, nx: 0, nz: -1, sill: 5.4, height: 3.4, spacing: 5.6, group: 'far' });

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
  portcullis(B, { x: gate.x, z: gate.z, y: 0, width: gate.width - 0.25, height: 3.9, yaw: DIAG_YAW + Math.PI * 0.5 });
  // Two great braziers flanking the gate, INSIDE the hall — they are what makes
  // the gate read as the way on, and they rim-light the portcullis bars.
  for (const s of [-1, 1]) {
    const bx = gate.x + DIR.screenDown[0] * 2.2 + s * 1.9 * Math.SQRT1_2;
    const bz = gate.z + DIR.screenDown[1] * 2.2 - s * 1.9 * Math.SQRT1_2;
    brazier(B, { x: bx, z: bz, kind: 'great' });
    B.keepOut(bx, bz, 1.6);
  }

  // South (camera side): a low screen wall with piers, broken open where the
  // stair to the undercroft goes down.
  const stairDoor = room.doors.find((d) => d.id === 'undercroftStair');
  const stairT = clamp((stairDoor.x - minX) / (maxX - minX), 0.08, 0.92);
  lowWall(B, { x0: minX, z0: maxZ, x1: stairDoor.x - 2.2, z1: maxZ, nx: 0, nz: 1, height: low, group: 'near' });
  lowWall(B, { x0: stairDoor.x + 2.2, z0: maxZ, x1: maxX, z1: maxZ, nx: 0, nz: 1, height: low, group: 'near' });
  void stairT;
  stairs(B, {
    x: stairDoor.x, y: 0, z: maxZ + 0.4, width: 3.0, steps: 7, rise: 0.30, run: 0.46,
    yaw: 0, group: 'near',
  });

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
  floorSlab(B, { x: room.x, z: room.z, w: W + 1.5, d: L + 1.5, y: 0, resolution: 2.0 });

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

  floorSlab(B, { x: room.x, z: room.z, w: W + 1.2, d: L + 1.2, y: 0, resolution: 1.8 });

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

  barrelVault(B, { x: room.x, z: room.z, yaw: room.yaw, width: W + 0.3, length: L, springY, ribEvery: L / room.bays, segments: 11 });

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
  const sconces = Math.max(2, Math.round(L / 6.5));
  for (let i = 0; i < sconces; i++) {
    const lz = -L * 0.5 + (L / sconces) * (i + 0.55);
    toWorld(room, -W * 0.5 + 0.1, lz, p);
    sconce(B, { x: p.x, y: 1.95, z: p.z, yaw: room.yaw + Math.PI * 0.5, group: 'far' });
  }
  // One brazier at the midpoint, on the floor, so there is a single strong pool
  // somewhere along the walk. Off the centre line so the player can pass it.
  toWorld(room, W * 0.28, rng.range(-L * 0.1, L * 0.2), p);
  brazier(B, { x: p.x, z: p.z, kind: 'small' });
  B.keepOut(p.x, p.z, 1.3);

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

  sconce(B, { x: room.x - hw + 0.35, y: 2.0, z: room.z, yaw: -Math.PI * 0.5, group: 'far' });
  candleCluster(B, { x: room.x - hw * 0.4, z: room.z + hd * 0.35, count: rng.int(3, 6), radius: 0.55 });
  for (let i = 0; i < rng.int(1, 3); i++) {
    sarcophagus(B, {
      x: room.x + rng.range(-hw * 0.5, hw * 0.5), z: room.z + rng.range(-hd * 0.5, hd * 0.5),
      yaw: rng.range(0, Math.PI), open: rng.float() < 0.6,
    });
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

  // The stair up to the hall, in the −Z wall.
  stairs(B, { x: room.x + (room.doors[0]?.x ?? 0), y, z: room.z - hd - 0.5, width: 3.0, steps: 7, rise: 0.3, run: 0.46, yaw: Math.PI, group: 'far' });

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
    sconce(B, { x: room.x - hw + 0.35, y: y + 2.2, z: room.z + (i - 0.5) * room.d * 0.5, yaw: -Math.PI * 0.5, group: 'far' });
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
  floorSlab(B, { x: room.x, z: room.z, w: L + 1, d: W + 1, y: room.y, resolution: 1.6 });

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
  barrelVault(B, { x: room.x, z: room.z, yaw: room.yaw + Math.PI * 0.5, width: W + 0.3, length: L, springY: room.y + 1.9, ribEvery: 2.4, segments: 9 });

  const n = Math.max(1, Math.round(L / 7));
  for (let i = 0; i < n; i++) {
    toWorld(room, -L * 0.5 + (L / n) * (i + 0.5), -W * 0.5 + 0.12, p);
    sconce(B, { x: p.x, y: room.y + 1.7, z: p.z, yaw: room.yaw - Math.PI * 0.5, group: 'far' });
  }
  dressDebris(B, room, { x: room.x, z: room.z, hw: L * 0.4, hd: W * 0.3, y: room.y, density: 0.7, bones: true, shards: false });
  void rng;
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
};

