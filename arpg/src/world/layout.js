import { CELL, snap, clamp } from './tuning.js';

/**
 * MONARCH — the dungeon generator.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A MAZE ALGORITHM
 *
 * Every "procedural dungeon" that starts from BSP splits, cellular automata or
 * random walks produces the same thing: a plausible FLOOR PLAN and a completely
 * unmemorable SPACE. That is because the interesting properties of a level —
 * a sightline that lands on the boss door, a room you enter on the axis of its
 * best view, a corridor whose vanishing point is a lit gate — are all properties
 * of the CAMERA, and no plan-space algorithm knows the camera exists.
 *
 * This generator is therefore a parameterised AUTHORED graph. The topology, the
 * order of the rooms along the critical path, and which axis each room is
 * entered on are fixed, because those are the decisions that make the level read
 * as designed. Everything else is seeded: dimensions, bay counts, which vaults
 * have fallen, corridor lengths, where the loop rejoins, the position and
 * dressing of every prop. Two seeds give two genuinely different buildings; no
 * seed gives a bad camera.
 *
 * ---------------------------------------------------------------------------
 * THE ONE GEOMETRIC RULE THAT DECIDES THE WHOLE PLAN
 *
 * The camera's yaw is fixed at 45°, so "up the screen" is the world direction
 * (−1, 0, −1)/√2. A corridor along a world AXIS therefore crosses the frame
 * diagonally and you can only ever see about (width/0.707) metres of it before
 * the sightline leaves through a side wall — which is why axis-aligned corridors
 * in isometric games never read as long.
 *
 * So the two corridors that MUST read as long — the processional way to the boss
 * and the crypt corridor — are rotated 45°, and everything else is axis-aligned.
 * The contrast is not a compromise, it is the plan: the diagonal ways are the
 * building's two processional axes, the orthogonal rooms are the fabric around
 * them, and the canted corner where the hall meets the processional is a real
 * gothic device (a squinch across a corner) rather than a hack.
 */

/** Unit world vectors, named by what they do ON SCREEN. */
const DIR = {
  screenUp: [-Math.SQRT1_2, -Math.SQRT1_2],
  screenDown: [Math.SQRT1_2, Math.SQRT1_2],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
  north: [0, -1],
};

/** The yaw that maps a room's local +Z onto `screenDown` and its local −Z onto
 *  `screenUp`. Both diagonal ways use it; see the file header. */
const DIAG_YAW = Math.PI / 4;

let _uid = 0;

function makeRoom(spec) {
  const r = {
    uid: _uid++,
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    x: spec.x, z: spec.z,
    y: spec.y ?? 0,
    w: spec.w, d: spec.d,
    yaw: spec.yaw ?? 0,
    ceiling: spec.ceiling ?? 6,
    doors: [],
    neighbours: [],
    tags: spec.tags ?? [],
    /** Filled by `finalise` — world AABB including the walls and the ceiling. */
    aabb: null,
    /** Populated by build.js so the subsystem can toggle whole rooms. */
    group: null,
  };
  return r;
}

/** World AABB of a rotated rectangle, padded for wall thickness and height. */
function finalise(room, pad = 1.6) {
  const c = Math.abs(Math.cos(room.yaw)), s = Math.abs(Math.sin(room.yaw));
  const hx = (room.w * 0.5 + pad) * c + (room.d * 0.5 + pad) * s;
  const hz = (room.w * 0.5 + pad) * s + (room.d * 0.5 + pad) * c;
  room.aabb = {
    minX: room.x - hx, maxX: room.x + hx,
    minZ: room.z - hz, maxZ: room.z + hz,
    minY: room.y - 2, maxY: room.y + room.ceiling + 4,
  };
  return room;
}

/** Local-to-world for a room's own frame: local +X across, +Z along. */
export function toWorld(room, lx, lz, out = { x: 0, z: 0 }) {
  const c = Math.cos(room.yaw), s = Math.sin(room.yaw);
  out.x = room.x + c * lx + s * lz;
  out.z = room.z - s * lx + c * lz;
  return out;
}

/**
 * Generate the level.
 *
 * @param {import('../core/rng.js').Rng} rng  a fork owned by the caller
 * @param {number} seed                       for the record only; rng is already seeded
 */
export function generateLevel(rng, seed) {
  _uid = 0;
  const rooms = [];
  const byId = new Map();
  const edges = [];
  const add = (r) => { rooms.push(r); byId.set(r.id, r); return r; };
  const link = (a, b, kind = 'path') => {
    edges.push({ a, b, kind });
    byId.get(a).neighbours.push(b);
    byId.get(b).neighbours.push(a);
  };

  // =========================================================================
  // 1. THE CATHEDRAL HALL — the room the game starts in and is photographed in
  // =========================================================================
  //
  // Sized so that at the hero boom (24 m, 34° fov) the frame is filled edge to
  // edge with architecture from a landmark near its east end: the nave recedes
  // up-screen-left, the north aisle arcade climbs up-screen-right, and the
  // sanctuary sits at the vanishing point. A room much larger photographs as a
  // field with walls at the horizon; much smaller and the near arcade crowds the
  // player out of their own frame.
  const hallW = snap(rng.range(30, 34));
  const hallD = snap(rng.range(20, 24));
  const hall = add(finalise(makeRoom({
    id: 'hall', kind: 'cathedral', name: 'The Sunken Nave',
    // The east end is pinned at x = +12 so the spawn point and every hall-framed
    // shot land in the same part of the room whatever the seed does to its size.
    x: 12 - hallW * 0.5, z: -3, w: hallW, d: hallD, ceiling: 12.5,
    tags: ['start', 'lit', 'open-sky'],
  })));
  // Nave / aisle division. The nave is the lit centre; the aisles are the dark
  // flanks whose arcades are the room's silhouette.
  // A ten-metre nave, not fourteen. Wider than this and the two arcades fall
  // outside a 26 m frame at the hero boom, and the shot becomes a field of
  // floor with architecture at its edges.
  hall.naveHalf = snap(clamp(hallD * 0.235, 4.4, 5.4), 0.2);
  hall.naveZ = hall.z;
  // The canted corner carrying the gate to the processional way. This is the
  // whole reason the boss approach can be photographed down its own axis.
  hall.chamfer = snap(clamp(rng.range(8, 10), 8, 11));

  const hallMinX = hall.x - hallW * 0.5, hallMaxX = hall.x + hallW * 0.5;
  const hallMinZ = hall.z - hallD * 0.5, hallMaxZ = hall.z + hallD * 0.5;
  hall.bounds = { minX: hallMinX, maxX: hallMaxX, minZ: hallMinZ, maxZ: hallMaxZ };

  // The gate sits at the midpoint of the chamfer, facing up-screen.
  const gateX = hallMinX + hall.chamfer * 0.5;
  const gateZ = hallMinZ + hall.chamfer * 0.5;
  hall.doors.push({ id: 'gate', x: gateX, z: gateZ, yaw: DIAG_YAW, width: snap(rng.range(4, 5), 0.5), kind: 'portal' });

  // =========================================================================
  // 2. THE PROCESSIONAL WAY — 45°, the game's one true vanishing-point shot
  // =========================================================================
  const procLen = snap(rng.range(24, 32));
  const procW = snap(rng.range(8, 10));
  const procCx = gateX + DIR.screenUp[0] * procLen * 0.5;
  const procCz = gateZ + DIR.screenUp[1] * procLen * 0.5;
  const proc = add(finalise(makeRoom({
    id: 'processional', kind: 'processional', name: 'The Processional Way',
    x: procCx, z: procCz, w: procW, d: procLen, yaw: DIAG_YAW, ceiling: 11.0,
    tags: ['corridor', 'lit', 'open-sky'],
  })));
  proc.bays = clamp(Math.round(procLen / rng.range(3.6, 4.6)), 5, 9);
  // Which bays lost their vault. Two, never adjacent, so the shafts of moonlight
  // land in two separate places down the length instead of one big gap.
  proc.openBays = [];
  {
    const a = rng.int(1, proc.bays - 3);
    proc.openBays.push(a, clamp(a + rng.int(2, 3), 0, proc.bays - 1));
  }
  link('hall', 'processional');

  // =========================================================================
  // 3. THE BOSS ARENA — at the head of the processional axis
  // =========================================================================
  const arenaR = snap(rng.range(14, 17));
  const arenaCx = gateX + DIR.screenUp[0] * (procLen + arenaR + 2.5);
  const arenaCz = gateZ + DIR.screenUp[1] * (procLen + arenaR + 2.5);
  const arena = add(finalise(makeRoom({
    id: 'arena', kind: 'arena', name: 'The Reliquary of Ash',
    x: snap(arenaCx), z: snap(arenaCz), w: arenaR * 2, d: arenaR * 2, ceiling: 14.0,
    tags: ['boss', 'open-sky'],
  })));
  arena.radius = arenaR;
  // Sunk, with a ring of steps down. A sunken arena reads as an ARENA from
  // above; a flat one reads as another room.
  arena.pitDepth = snap(clamp(rng.range(1.0, 1.6), 1.0, 1.8), 0.2);
  arena.sides = rng.int(8, 10);
  link('processional', 'arena');

  // =========================================================================
  // 4. THE CRYPT CORRIDOR — 45° the other way, down-screen from the hall
  // =========================================================================
  const cryptLen = snap(rng.range(20, 26));
  const cryptW = snap(clamp(rng.range(4.5, 5.5), 4, 6), 0.5);
  // Mouth in the hall's east wall, in the south aisle so it is clear of the nave.
  const mouthZ = snap(clamp(hall.naveZ + hall.naveHalf + 1.5, hallMinZ + 3, hallMaxZ - 2));
  const cryptCx = hallMaxX + DIR.screenDown[0] * cryptLen * 0.5;
  const cryptCz = mouthZ + DIR.screenDown[1] * cryptLen * 0.5;
  const crypt = add(finalise(makeRoom({
    id: 'crypt', kind: 'corridor', name: 'The Bone Walk',
    x: cryptCx, z: cryptCz, w: cryptW, d: cryptLen, yaw: DIAG_YAW, ceiling: 3.8,
    tags: ['corridor', 'dark', 'damp'],
  })));
  crypt.bays = clamp(Math.round(cryptLen / rng.range(2.4, 3.0)), 6, 12);
  crypt.nicheRows = rng.int(2, 4);
  hall.doors.push({ id: 'cryptMouth', x: hallMaxX, z: mouthZ, yaw: 0, width: 3.4, kind: 'door' });
  link('hall', 'crypt');

  // =========================================================================
  // 5. THE OSSUARY — at the foot of the crypt corridor
  // =========================================================================
  const ossW = snap(rng.range(14, 18));
  const ossD = snap(rng.range(12, 16));
  const cryptEndX = hallMaxX + DIR.screenDown[0] * cryptLen;
  const cryptEndZ = mouthZ + DIR.screenDown[1] * cryptLen;
  const oss = add(finalise(makeRoom({
    id: 'ossuary', kind: 'ossuary', name: 'The Ossuary',
    x: snap(cryptEndX + DIR.screenDown[0] * (ossD * 0.5 + 1)),
    z: snap(cryptEndZ + DIR.screenDown[1] * (ossD * 0.5 + 1)),
    w: ossW, d: ossD, ceiling: 4.6,
    tags: ['chamber', 'dark', 'bones'],
  })));
  link('crypt', 'ossuary');

  // =========================================================================
  // 6. A COLLAPSED CELL off the crypt corridor
  // =========================================================================
  const cellT = rng.range(0.42, 0.66);          // where along the corridor
  const cellW = snap(rng.range(8, 11));
  const cellD = snap(rng.range(7, 10));
  // Off the corridor's local +X side, which at this yaw is screen-right.
  const cellOff = cryptW * 0.5 + cellD * 0.5 + 0.8;
  const cellAnchorX = hallMaxX + DIR.screenDown[0] * cryptLen * cellT;
  const cellAnchorZ = mouthZ + DIR.screenDown[1] * cryptLen * cellT;
  const cell = add(finalise(makeRoom({
    id: 'cell', kind: 'chamber', name: 'The Broken Cell',
    x: snap(cellAnchorX + Math.SQRT1_2 * cellOff), z: snap(cellAnchorZ - Math.SQRT1_2 * cellOff),
    w: cellW, d: cellD, ceiling: 3.9,
    tags: ['chamber', 'dark', 'collapsed', 'roots'],
  })));
  link('crypt', 'cell');

  // =========================================================================
  // 7. THE FLOODED UNDERCROFT — down a stair from the hall's south aisle
  // =========================================================================
  const uW = snap(rng.range(16, 20));
  const uD = snap(rng.range(14, 18));
  const stairX = snap(clamp(hallMinX + rng.range(5, 9), hallMinX + 4, hall.x));
  const under = add(finalise(makeRoom({
    id: 'undercroft', kind: 'undercroft', name: 'The Drowned Undercroft',
    x: snap(stairX - 2), z: snap(hallMaxZ + 4 + uD * 0.5),
    w: uW, d: uD, y: -snap(clamp(rng.range(1.6, 2.2), 1.4, 2.4), 0.2), ceiling: 5.2,
    tags: ['chamber', 'water', 'damp'],
  })));
  under.waterY = under.y + snap(clamp(rng.range(0.35, 0.6), 0.3, 0.7), 0.05);
  hall.doors.push({ id: 'undercroftStair', x: stairX, z: hallMaxZ, yaw: Math.PI, width: 3.2, kind: 'stair' });
  link('hall', 'undercroft');

  // =========================================================================
  // 8. THE SHADOW SHRINE — off the undercroft, up two steps and dry
  // =========================================================================
  const sW = snap(rng.range(14, 18));
  const sD = snap(rng.range(13, 17));
  const shrine = add(finalise(makeRoom({
    id: 'shrine', kind: 'shrine', name: 'The Shrine of the Monarch',
    x: snap(under.x - uW * 0.5 - sW * 0.5 - 2), z: snap(under.z + rng.range(-2, 2)),
    w: sW, d: sD, y: under.y + 0.6, ceiling: 7.0,
    tags: ['shrine', 'violet'],
  })));
  link('undercroft', 'shrine');

  // =========================================================================
  // 9. THE LOOP — a second way between the ossuary and the cell
  // =========================================================================
  // Optional, and the graph records it as such. A loop is what turns a level
  // from a corridor into a place: it means the player can be flanked, can
  // retreat a different way, and can see a room they have already been in from a
  // new angle, which is the cheapest way to make a small level feel large.
  const loopFrom = { x: cell.x, z: cell.z + cellD * 0.5 };
  const loopTo = { x: oss.x - ossW * 0.5, z: oss.z };
  const loop = add(finalise(makeRoom({
    id: 'loop', kind: 'passage', name: 'The Sagging Passage',
    x: snap((loopFrom.x + loopTo.x) * 0.5), z: snap((loopFrom.z + loopTo.z) * 0.5),
    w: snap(clamp(Math.hypot(loopTo.x - loopFrom.x, loopTo.z - loopFrom.z), 6, 22), 0.5),
    d: 3.2,
    yaw: Math.atan2(loopTo.z - loopFrom.z, loopTo.x - loopFrom.x) * -1,
    ceiling: 3.2,
    tags: ['corridor', 'dark', 'optional'],
  })));
  link('cell', 'loop', 'loop');
  link('loop', 'ossuary', 'loop');

  // =========================================================================
  // spawn + landmarks
  // =========================================================================
  //
  // Landmarks are the highest-leverage thing in this file: the shot harness
  // teleports the player onto one and frames it isometrically, so each one is a
  // composed marketing shot rather than a coordinate. The rule for all five is
  // the same — stand so that the subject is UP-SCREEN, i.e. at −X −Z of the
  // landmark, because that is the half of the world the camera can see.
  // ON THE NAVE CENTRE LINE, five metres west of the room's middle.
  //
  // Derived, not guessed. At the hero boom the ground is visible from 5.3 m
  // down-screen of the focus to 12.2 m up-screen of it (boom 24, fov 34,
  // pitch -52: the top ray meets the ground at h/tan(35deg) and the bottom at
  // h/tan(69deg)). Standing here puts the north arcade 4.2 m up-screen-right,
  // the ruined south arcade 4.2 m down-screen-left, and the sanctuary steps
  // 70% of the way up the frame — so the nave recedes between two colonnades to
  // a lit altar, which is the shot.
  const spawn = { x: snap(hall.x - 5, 1), y: 0, z: snap(hall.naveZ, 1) };

  const landmarks = {
    hall: [snap(hall.x - 5, 1), 0, snap(hall.naveZ, 1)],

    // Twelve metres up the crypt corridor, looking back toward the hall: the
    // corridor's rhythm of ribs recedes straight up the frame and terminates on
    // the lit archway, which is the only bright thing in the shot.
    corridor: [
      snap(hallMaxX + DIR.screenDown[0] * Math.min(13, cryptLen * 0.55), 0.5),
      0,
      snap(mouthZ + DIR.screenDown[1] * Math.min(13, cryptLen * 0.55), 0.5),
    ],

    // Just inside the gate, on the processional axis. The portcullis frames the
    // top of the shot and the whole 28 m of colonnade runs away up-screen to the
    // arena mouth.
    gate: [snap(gateX + DIR.screenDown[0] * 3.2, 0.5), 0, snap(gateZ + DIR.screenDown[1] * 3.2, 0.5)],

    // The near lip of the arena floor, so the sunken ring, the broken angel and
    // the far rim braziers are all up-screen.
    arena: [
      snap(arena.x + DIR.screenDown[0] * arenaR * 0.52, 0.5), -arena.pitDepth,
      snap(arena.z + DIR.screenDown[1] * arenaR * 0.52, 0.5),
    ],

    // At the foot of the monolith's dais, close enough that the slab lands at
    // about two thirds of the frame height at the shrine boom (18 m) rather
    // than running off the top of it.
    shrine: [
      snap(shrine.x + DIR.screenDown[0] * 2.6, 0.5), shrine.y,
      snap(shrine.z + DIR.screenDown[1] * 2.6, 0.5),
    ],
  };

  // The monolith the shrine landmark looks at. Kept on the room so build.js and
  // the landmark table cannot disagree about where it is.
  shrine.focusX = shrine.x + DIR.screenUp[0] * 1.2;
  shrine.focusZ = shrine.z + DIR.screenUp[1] * 1.2;

  const level = {
    seed,
    rooms,
    byId,
    edges,
    spawn,
    landmarks,
    criticalPath: ['hall', 'processional', 'arena'],
    optional: ['crypt', 'ossuary', 'cell', 'undercroft', 'shrine', 'loop'],
    cell: CELL,
  };

  // Sanity: overlapping room AABBs would mean two sets of walls in the same
  // place, which reads as a rendering bug rather than as a level. Reported
  // rather than thrown — a slight overlap between a corridor and the room it
  // enters is legitimate and expected.
  level.overlaps = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i].aabb, b = rooms[j].aabb;
      if (rooms[i].neighbours.includes(rooms[j].id)) continue;
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (ox > 2.5 && oz > 2.5) level.overlaps.push([rooms[i].id, rooms[j].id, +ox.toFixed(1), +oz.toFixed(1)]);
    }
  }

  return level;
}

export { DIR, DIAG_YAW };
