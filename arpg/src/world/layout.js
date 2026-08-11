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
 * (−1, 0, −1)/√2 and "right across the screen" is (+1, 0, −1)/√2. Two
 * consequences run through every coordinate below:
 *
 *  1. A corridor along a world AXIS crosses the frame diagonally and you can
 *     only ever see about (width/0.707) metres of it before the sightline leaves
 *     through a side wall — which is why axis-aligned corridors in isometric
 *     games never read as long. So the ways that MUST read as long are rotated
 *     45°: the processional to the boss, the crypt corridor, the lamp walk and
 *     the chain span. Everything else is axis-aligned fabric around them.
 *
 *  2. **SCREEN WIDTH AND SCREEN DEPTH ARE THE TWO DIAGONALS OF THE WORLD, NOT
 *     ITS AXES.** Screen width is the spread of (x − z); screen depth is the
 *     spread of (x + z). The previous plan put every room on ONE of those
 *     diagonals — the whole level lived within a spread of 67 m of (x−z) against
 *     139 m of (x+z), so it photographed as a tall narrow strip and the player
 *     read it, correctly, as a corridor with bulges. This one is laid out in
 *     SCREEN coordinates first (`screenAt` below) and converted, and its two
 *     spreads are within 5% of each other.
 *
 * Placing along the anti-diagonal is also nearly free in world-AABB terms: a
 * room moved 40 m to the screen-right moves +28 in x and −28 in z, so it widens
 * the picture without pushing either world bound. That is why this level is
 * 2.9× the walkable area of the old one inside a world box only 1.2× as wide.
 *
 * ---------------------------------------------------------------------------
 * LINKS ARE PART OF THE GRAPH, NOT AN EMERGENT PROPERTY OF TWO WALLS MEETING
 *
 * The previous generator recorded `edges` and trusted the room builders to
 * leave holes in the right places. Measured against the real navigation grid,
 * that produced a level where **five of nine rooms could not be reached from
 * the spawn at all** (2 072 of 3 323 walkable cells reachable): the crypt
 * corridor's floor had holes in it, and the hall's stair to the undercroft ran
 * UP into the room's own south wall while the undercroft's stair ran up through
 * the same cubic metres in the opposite direction.
 *
 * So every edge here carries a LINK record — a threshold point, a travel
 * direction, a width, and the two floor heights — and `build.js` realises it as
 * a throat with real floor, real jambs and, where the levels differ, a real
 * flight of steps. `wallRun` punches itself open wherever a link crosses it
 * (see `B.openings`). Connectivity is therefore constructed rather than hoped
 * for, and `stats().reach` reports it.
 */

/** Unit world vectors, named by what they do ON SCREEN. */
const DIR = {
  screenUp: [-Math.SQRT1_2, -Math.SQRT1_2],
  screenDown: [Math.SQRT1_2, Math.SQRT1_2],
  screenRight: [Math.SQRT1_2, -Math.SQRT1_2],
  screenLeft: [-Math.SQRT1_2, Math.SQRT1_2],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
  north: [0, -1],
};

/** The yaw that maps a room's local +Z onto `screenDown`, its local −Z onto
 *  `screenUp` and its local +X onto `screenRight`. Every room that must read as
 *  long (along −Z) or as WIDE (along +X) uses it; see the file header. */
const DIAG_YAW = Math.PI / 4;

/**
 * Screen coordinates → world.
 *
 * `right` is metres across the frame (positive = screen right), `up` is metres
 * up the frame. This is the function the whole plan is authored in.
 */
function screenAt(right, up) {
  return {
    x: (right - up) * Math.SQRT1_2,
    z: -(right + up) * Math.SQRT1_2,
  };
}

/** World → screen, for the landmark maths and for `stats()`. */
function screenOf(x, z) {
  return { right: (x - z) * Math.SQRT1_2, up: -(x + z) * Math.SQRT1_2 };
}

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
    /** Link records touching this room, filled by `link()`. */
    links: [],
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
  // Half-extents of the AABB, in the shape `ui`'s minimap duck-types. Its
  // `normaliseRoom` needs `{x, z, hw, hh}` or `{x, z, w, h}`; it was being
  // handed `{x, z, w, d}`, matched no branch, and returned null for EVERY room,
  // so the minimap has been drawing an empty layout since it was written. These
  // two fields are the whole fix, and they carry the rotation because they come
  // off the AABB rather than off `w`/`d`.
  room.hw = hx;
  room.hh = hz;
  return room;
}

/** Local-to-world for a room's own frame: local +X across, +Z along. */
export function toWorld(room, lx, lz, out = { x: 0, z: 0 }) {
  const c = Math.cos(room.yaw), s = Math.sin(room.yaw);
  out.x = room.x + c * lx + s * lz;
  out.z = room.z - s * lx + c * lz;
  return out;
}

/** World-to-local for a room's own frame. The inverse of `toWorld`. */
export function toLocal(room, wx, wz, out = { x: 0, z: 0 }) {
  const c = Math.cos(room.yaw), s = Math.sin(room.yaw);
  const dx = wx - room.x, dz = wz - room.z;
  out.x = c * dx - s * dz;
  out.z = s * dx + c * dz;
  return out;
}

/**
 * Where a ray from a room's centre in world direction (dx, dz) leaves its
 * rectangle. Used to find both ends of every link, so a threshold sits on the
 * wall it is a hole in rather than at a hand-typed coordinate that rots the
 * moment a seeded dimension changes.
 */
function edgePoint(room, dx, dz, extra = 0) {
  const c = Math.cos(room.yaw), s = Math.sin(room.yaw);
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  const tx = Math.abs(lx) > 1e-6 ? (room.w * 0.5) / Math.abs(lx) : Infinity;
  const tz = Math.abs(lz) > 1e-6 ? (room.d * 0.5) / Math.abs(lz) : Infinity;
  const t = Math.min(tx, tz) + extra;
  return { x: room.x + dx * t, z: room.z + dz * t };
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
  const links = [];
  const add = (r) => { rooms.push(r); byId.set(r.id, r); return r; };

  /**
   * Join two rooms and build the link record between them.
   *
   * `opts.from` / `opts.to` override the world points the throat runs between
   * (a chamfered corner, a stair head, the mouth of a bridge); otherwise both
   * ends are found on the straight line between the two centres. The link is
   * OWNED by exactly one room so its geometry is built exactly once and lives in
   * one streamable group.
   */
  const link = (aId, bId, opts = {}) => {
    const a = byId.get(aId), b = byId.get(bId);
    edges.push({ a: aId, b: bId, kind: opts.kind === 'loop' ? 'loop' : 'path' });
    a.neighbours.push(bId);
    b.neighbours.push(aId);

    let ax, az, bx, bz;
    if (opts.from && opts.to) {
      ax = opts.from.x; az = opts.from.z; bx = opts.to.x; bz = opts.to.z;
    } else {
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      const ea = opts.from ?? edgePoint(a, ux, uz, opts.insetA ?? 0);
      const eb = opts.to ?? edgePoint(b, -ux, -uz, opts.insetB ?? 0);
      ax = ea.x; az = ea.z; bx = eb.x; bz = eb.z;
    }
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ux = len > 1e-4 ? dx / len : 1, uz = len > 1e-4 ? dz / len : 0;
    const rec = {
      a: aId, b: bId,
      kind: opts.kind ?? 'door',
      x: (ax + bx) * 0.5, z: (az + bz) * 0.5,
      ax, az, bx, bz,
      ux, uz, len,
      /** Yaw such that the run's +Z axis points from a to b. */
      yaw: Math.atan2(ux, uz),
      width: opts.width ?? 3.4,
      ya: a.y, yb: b.y,
      owner: opts.owner ?? (len > 0.1 ? aId : aId),
      /** Radius of the hole punched in any wall crossing this throat. */
      clear: (opts.width ?? 3.4) * 0.5 + 0.55,
    };
    links.push(rec);
    a.links.push(rec);
    b.links.push(rec);
    return rec;
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
  // player out of their own frame. It is therefore the ONE room in the level
  // that is not allowed to grow — the level got bigger by gaining rooms.
  const hallW = snap(rng.range(30, 34));
  const hallD = snap(rng.range(21, 25));
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
  const gateW = snap(rng.range(4, 5), 0.5);
  hall.doors.push({ id: 'gate', x: gateX, z: gateZ, yaw: DIAG_YAW, width: gateW, kind: 'portal' });

  // Where the lamp walk leaves the north wall. Everything EAST of this point is
  // a low ruined stretch rather than the full clerestory elevation: a room built
  // up-screen of the hall would otherwise have eleven metres of the hall's own
  // backdrop wall standing between it and the lens. See `buildCathedral`.
  const northDoorX = snap(clamp(hall.x + hallW * 0.28, hallMinX + hall.chamfer + 4, hallMaxX - 5), 0.5);
  hall.northDoorX = northDoorX;
  hall.ruinFromX = northDoorX - 4.5;
  hall.doors.push({ id: 'northWalk', x: northDoorX, z: hallMinZ, yaw: Math.PI, width: 4.0, kind: 'arch' });

  // =========================================================================
  // 2. THE PROCESSIONAL WAY — 45°, the game's one true vanishing-point shot
  // =========================================================================
  const procLen = snap(rng.range(26, 32));
  const procW = snap(rng.range(9, 11));
  const procCx = gateX + DIR.screenUp[0] * (procLen * 0.5 + 1.5);
  const procCz = gateZ + DIR.screenUp[1] * (procLen * 0.5 + 1.5);
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
  link('hall', 'processional', {
    kind: 'portal', width: gateW,
    from: { x: gateX, z: gateZ },
    to: { x: gateX + DIR.screenUp[0] * 2.0, z: gateZ + DIR.screenUp[1] * 2.0 },
  });

  // =========================================================================
  // 3. THE BOSS ARENA — at the head of the processional axis
  // =========================================================================
  const arenaR = snap(rng.range(15.5, 17.5));
  const arenaCx = gateX + DIR.screenUp[0] * (procLen + arenaR + 4.0);
  const arenaCz = gateZ + DIR.screenUp[1] * (procLen + arenaR + 4.0);
  const arena = add(finalise(makeRoom({
    id: 'arena', kind: 'arena', name: 'The Court of Ash',
    x: snap(arenaCx), z: snap(arenaCz), w: arenaR * 2, d: arenaR * 2, ceiling: 14.0,
    tags: ['boss', 'open-sky'],
  })));
  arena.radius = arenaR;
  // Sunk, with a ring of steps down. A sunken arena reads as an ARENA from
  // above; a flat one reads as another room.
  arena.pitDepth = snap(clamp(rng.range(1.0, 1.6), 1.0, 1.8), 0.2);
  arena.sides = rng.int(8, 10);
  link('processional', 'arena', { kind: 'arch', width: 5.0 });

  // =========================================================================
  // 4. THE CRYPT CORRIDOR — 45° the other way, down-screen from the hall
  // =========================================================================
  const cryptLen = snap(rng.range(22, 28));
  const cryptW = snap(clamp(rng.range(4.5, 5.5), 4, 6), 0.5);
  // Mouth in the hall's east wall, in the south aisle so it is clear of the nave.
  const mouthZ = snap(clamp(hall.naveZ + hall.naveHalf + 1.5, hallMinZ + 3, hallMaxZ - 2));
  const cryptCx = hallMaxX + DIR.screenDown[0] * (cryptLen * 0.5 + 1.2);
  const cryptCz = mouthZ + DIR.screenDown[1] * (cryptLen * 0.5 + 1.2);
  const crypt = add(finalise(makeRoom({
    id: 'crypt', kind: 'corridor', name: 'The Bone Walk',
    x: cryptCx, z: cryptCz, w: cryptW, d: cryptLen, yaw: DIAG_YAW, ceiling: 3.8,
    tags: ['corridor', 'dark', 'damp'],
  })));
  crypt.bays = clamp(Math.round(cryptLen / rng.range(2.4, 3.0)), 6, 12);
  crypt.nicheRows = rng.int(2, 4);
  hall.doors.push({ id: 'cryptMouth', x: hallMaxX, z: mouthZ, yaw: 0, width: 3.4, kind: 'door' });
  link('hall', 'crypt', {
    kind: 'door', width: 3.4,
    from: { x: hallMaxX, z: mouthZ },
    to: { x: cryptCx + DIR.screenUp[0] * cryptLen * 0.5, z: cryptCz + DIR.screenUp[1] * cryptLen * 0.5 },
  });

  // =========================================================================
  // 5. THE OSSUARY — at the foot of the crypt corridor
  // =========================================================================
  const ossW = snap(rng.range(18, 22));
  const ossD = snap(rng.range(16, 20));
  const cryptEndX = cryptCx + DIR.screenDown[0] * cryptLen * 0.5;
  const cryptEndZ = cryptCz + DIR.screenDown[1] * cryptLen * 0.5;
  const oss = add(finalise(makeRoom({
    id: 'ossuary', kind: 'ossuary', name: 'The Ossuary',
    x: snap(cryptEndX + DIR.screenDown[0] * (ossD * 0.5 + 1.4)),
    z: snap(cryptEndZ + DIR.screenDown[1] * (ossD * 0.5 + 1.4)),
    w: ossW, d: ossD, ceiling: 4.8,
    tags: ['chamber', 'dark', 'bones'],
  })));
  link('crypt', 'ossuary', { kind: 'arch', width: 3.6 });

  // =========================================================================
  // 6. A COLLAPSED CELL off the crypt corridor
  // =========================================================================
  const cellW = snap(rng.range(9, 12));
  const cellD = snap(rng.range(8, 11));
  // Off the corridor's local +X side, which at this yaw is screen-right.
  const cellT = rng.range(0.40, 0.58);
  const cellOff = cryptW * 0.5 + cellD * 0.5 + 1.2;
  const cellAnchorX = cryptCx + DIR.screenUp[0] * cryptLen * (0.5 - cellT);
  const cellAnchorZ = cryptCz + DIR.screenUp[1] * cryptLen * (0.5 - cellT);
  const cell = add(finalise(makeRoom({
    id: 'cell', kind: 'chamber', name: 'The Broken Cell',
    x: snap(cellAnchorX + DIR.screenRight[0] * cellOff), z: snap(cellAnchorZ + DIR.screenRight[1] * cellOff),
    w: cellW, d: cellD, ceiling: 3.9,
    tags: ['chamber', 'dark', 'collapsed', 'roots'],
  })));
  link('crypt', 'cell', { kind: 'door', width: 2.8 });

  // =========================================================================
  // 7. THE CATACOMB — a wide hall of burial alleys beyond the ossuary
  // =========================================================================
  // The bottom of the level used to end at the ossuary, one room down-screen and
  // one room right of the hall. This pushes it down AND LEFT, which is where the
  // old plan had nothing at all: the whole lower half of the frame was empty on
  // the screen-left side.
  const catW = snap(rng.range(24, 28));
  const catD = snap(rng.range(20, 22));
  const catP = screenAt(screenOf(oss.x, oss.z).right - snap(rng.range(14, 18)),
                        screenOf(oss.x, oss.z).up - (ossD * 0.5 + catD * 0.5 + 3));
  const cat = add(finalise(makeRoom({
    id: 'catacomb', kind: 'catacomb', name: 'The Catacomb of Nine Hundred',
    x: snap(catP.x), z: snap(catP.z), w: catW, d: catD, ceiling: 4.2,
    tags: ['chamber', 'dark', 'bones', 'reward'],
  })));
  cat.aisles = rng.int(3, 4);
  link('ossuary', 'catacomb', { kind: 'arch', width: 3.4 });

  // =========================================================================
  // 8. THE LOOP — a second way between the ossuary and the cell
  // =========================================================================
  // Optional, and the graph records it as such. A loop is what turns a level
  // from a corridor into a place: it means the player can be flanked, can
  // retreat a different way, and can see a room they have already been in from a
  // new angle, which is the cheapest way to make a small level feel large.
  // Routed down the SCREEN-RIGHT side of the crypt corridor, never across it.
  // A straight line from the cell to the ossuary's near wall cuts the corridor
  // in half — two sets of walls in the same cubic metre, which reads as a
  // rendering bug rather than as a level. `stats().overlaps` catches this.
  const loopFrom = {
    x: cell.x + DIR.screenDown[0] * cellD * 0.45 + DIR.screenRight[0] * 2.0,
    z: cell.z + DIR.screenDown[1] * cellD * 0.45 + DIR.screenRight[1] * 2.0,
  };
  const loopTo = {
    x: oss.x + DIR.screenRight[0] * ossW * 0.40,
    z: oss.z + DIR.screenRight[1] * ossW * 0.40,
  };
  const loop = add(finalise(makeRoom({
    id: 'loop', kind: 'passage', name: 'The Sagging Passage',
    x: snap((loopFrom.x + loopTo.x) * 0.5), z: snap((loopFrom.z + loopTo.z) * 0.5),
    w: snap(clamp(Math.hypot(loopTo.x - loopFrom.x, loopTo.z - loopFrom.z), 8, 24), 0.5),
    d: 3.4,
    yaw: Math.atan2(loopTo.z - loopFrom.z, loopTo.x - loopFrom.x) * -1,
    ceiling: 3.2,
    tags: ['corridor', 'dark', 'optional'],
  })));
  link('cell', 'loop', { kind: 'loop', width: 2.6 });
  link('loop', 'ossuary', { kind: 'loop', width: 2.6 });

  // =========================================================================
  // 9. THE FLOODED UNDERCROFT — down a stair from the hall's south aisle
  // =========================================================================
  const uW = snap(rng.range(20, 24));
  const uD = snap(rng.range(18, 22));
  const stairX = snap(clamp(hallMinX + rng.range(6, 10), hallMinX + 4, hall.x), 0.5);
  const underY = -snap(clamp(rng.range(1.6, 2.2), 1.4, 2.4), 0.2);
  const under = add(finalise(makeRoom({
    id: 'undercroft', kind: 'undercroft', name: 'The Drowned Undercroft',
    x: snap(stairX - 1), z: snap(hallMaxZ + 5.5 + uD * 0.5),
    w: uW, d: uD, y: underY, ceiling: 5.4,
    tags: ['chamber', 'water', 'damp'],
  })));
  under.waterY = under.y + snap(clamp(rng.range(0.35, 0.6), 0.3, 0.7), 0.05);
  hall.doors.push({ id: 'undercroftStair', x: stairX, z: hallMaxZ, yaw: Math.PI, width: 3.4, kind: 'stair' });
  // A REAL flight, not two flights facing each other. The old plan built one
  // stair rising south out of the hall and another rising north out of the
  // undercroft, both solid, occupying the same 3 m of ground — which is why the
  // undercroft, the shrine, the ossuary, the cell and the passage were all
  // unreachable. This link is one throat from the hall's threshold to the
  // undercroft's, and `build.js` puts exactly one flight of steps in it.
  link('hall', 'undercroft', {
    kind: 'stair', width: 3.4,
    from: { x: stairX, z: hallMaxZ },
    to: { x: under.x + (stairX - under.x) * 0.35, z: under.z - uD * 0.5 },
  });

  // =========================================================================
  // 10. THE CISTERN — a second, deeper tank off the undercroft
  // =========================================================================
  // Down-screen-left, i.e. into the one quadrant of the frame the old plan never
  // used. Deeper than the undercroft and darker, and its far end is a dead drop
  // into black water, which is the only place in the level with no floor at all.
  const cisW = snap(rng.range(24, 28));
  const cisD = snap(rng.range(20, 24));
  const cisP = screenAt(screenOf(under.x, under.z).right - snap(rng.range(12, 16)),
                        screenOf(under.x, under.z).up - (uD * 0.5 + cisD * 0.5 + 3.0));
  const cistern = add(finalise(makeRoom({
    id: 'cistern', kind: 'undercroft', name: 'The Great Cistern',
    x: snap(cisP.x), z: snap(cisP.z), w: cisW, d: cisD,
    y: under.y - snap(clamp(rng.range(0.6, 1.0), 0.6, 1.0), 0.2), ceiling: 6.0,
    tags: ['chamber', 'water', 'damp', 'reward'],
  })));
  cistern.waterY = cistern.y + snap(clamp(rng.range(0.45, 0.7), 0.4, 0.8), 0.05);
  link('undercroft', 'cistern', { kind: 'stair', width: 3.4 });

  // =========================================================================
  // 10b. THE SLUICE — the room that closes the bottom loop
  // =========================================================================
  // Sits in the one large hole left in the plan, between the cistern (bottom
  // left of frame) and the catacomb (bottom right), and joins them. That single
  // edge turns the entire lower half of the level from two dead-end branches
  // into one circuit: hall → crypt → ossuary → catacomb → sluice → cistern →
  // undercroft → hall. A loop is what lets a player be flanked and lets them
  // come back a different way, and it costs one room.
  const sluW = snap(rng.range(22, 26));
  const sluD = snap(rng.range(16, 19));
  const catS = screenOf(cat.x, cat.z);
  const cisS = screenOf(cistern.x, cistern.z);
  const sluP = screenAt((catS.right + cisS.right) * 0.5, (catS.up + cisS.up) * 0.5 - 3);
  const sluice = add(finalise(makeRoom({
    id: 'sluice', kind: 'chamber', name: 'The Sluice',
    x: snap(sluP.x), z: snap(sluP.z), w: sluW, d: sluD,
    y: cistern.y + 0.4, ceiling: 4.6,
    tags: ['chamber', 'dark', 'damp', 'collapsed', 'roots'],
  })));
  link('cistern', 'sluice', { kind: 'stair', width: 3.4 });
  link('sluice', 'catacomb', { kind: 'loop', width: 3.4 });

  // =========================================================================
  // 11. THE SHADOW SHRINE — off the undercroft, up two steps and dry
  // =========================================================================
  const sW = snap(rng.range(18, 22));
  const sD = snap(rng.range(16, 20));
  const shrine = add(finalise(makeRoom({
    id: 'shrine', kind: 'shrine', name: 'The Shrine of the Monarch',
    x: snap(under.x - uW * 0.5 - sW * 0.5 - 3), z: snap(under.z + rng.range(-2, 2)),
    w: sW, d: sD, y: under.y + 0.6, ceiling: 7.4,
    tags: ['shrine', 'violet'],
  })));
  link('undercroft', 'shrine', { kind: 'stair', width: 3.6 });

  // =========================================================================
  // 12. THE FALLEN NAVE — the west range, roofless, and WIDE
  // =========================================================================
  // Long axis along `screenRight`, so it crosses the frame horizontally instead
  // of receding up it. This is the single biggest contributor to the level's
  // screen width, and it is what the player is looking at when they stand in the
  // shrine door and look up-screen.
  const naveLen = snap(rng.range(38, 42));
  const naveD = snap(rng.range(19, 22));
  const shrineS = screenOf(shrine.x, shrine.z);
  const naveP = screenAt(shrineS.right - snap(rng.range(3, 6)),
                         shrineS.up + (sD * 0.5 + naveD * 0.5 + 4.0));
  const fallen = add(finalise(makeRoom({
    id: 'nave', kind: 'nave', name: 'The Fallen Nave',
    x: snap(naveP.x), z: snap(naveP.z), w: naveLen, d: naveD,
    yaw: DIAG_YAW, y: shrine.y + 0.4, ceiling: 9.8,
    tags: ['open-sky', 'ruin', 'wide'],
  })));
  fallen.bays = clamp(Math.round(naveLen / rng.range(4.4, 5.4)), 6, 9);
  link('shrine', 'nave', { kind: 'stair', width: 4.2 });

  // =========================================================================
  // 13. THE CHAIN SPAN — a bridge over a chasm, back onto the critical path
  // =========================================================================
  // The nave's screen-right end and the processional's screen-left flank are
  // about twenty metres apart with nothing between them. That gap is the chasm,
  // and the span across it closes the level's biggest loop: the whole west range
  // is now a route to the boss rather than a cul-de-sac.
  const naveEnd = {
    x: fallen.x + DIR.screenRight[0] * naveLen * 0.5,
    z: fallen.z + DIR.screenRight[1] * naveLen * 0.5,
  };
  const procMidT = rng.range(0.30, 0.46);          // where along the processional it lands
  const procSide = {
    x: proc.x + DIR.screenDown[0] * procLen * (0.5 - procMidT) + DIR.screenLeft[0] * (procW * 0.5 + 2.4),
    z: proc.z + DIR.screenDown[1] * procLen * (0.5 - procMidT) + DIR.screenLeft[1] * (procW * 0.5 + 2.4),
  };
  const spanLen = Math.hypot(procSide.x - naveEnd.x, procSide.z - naveEnd.z);
  const span = add(finalise(makeRoom({
    id: 'span', kind: 'bridge', name: 'The Chain Span',
    x: snap((naveEnd.x + procSide.x) * 0.5, 0.5), z: snap((naveEnd.z + procSide.z) * 0.5, 0.5),
    w: snap(clamp(spanLen, 14, 30), 0.5), d: snap(rng.range(11, 13)),
    yaw: Math.atan2(procSide.z - naveEnd.z, procSide.x - naveEnd.x) * -1,
    y: 0, ceiling: 7.0,
    tags: ['open-sky', 'chasm', 'wide'],
  })));
  span.deckHalf = snap(clamp(rng.range(2.1, 2.8), 2.0, 3.0), 0.1);
  span.chasmDepth = snap(rng.range(7, 10));
  span.gapT = rng.range(0.42, 0.60);      // where the deck is broken and planked
  link('nave', 'span', { kind: 'arch', width: 4.0 });
  link('span', 'processional', { kind: 'breach', width: 4.0 });

  // =========================================================================
  // 14. THE LAMP WALK — the east range's spine, along screen-right
  // =========================================================================
  const galLen = snap(rng.range(28, 32));
  const galD = snap(rng.range(11, 13));
  const galStart = { x: northDoorX, z: hallMinZ - 1.0 };
  const galP = {
    x: galStart.x + DIR.screenRight[0] * (galLen * 0.5 + 2.0) + DIR.screenUp[0] * (galD * 0.5 + 1.5),
    z: galStart.z + DIR.screenRight[1] * (galLen * 0.5 + 2.0) + DIR.screenUp[1] * (galD * 0.5 + 1.5),
  };
  const gallery = add(finalise(makeRoom({
    id: 'gallery', kind: 'gallery', name: 'The Lamp Walk',
    x: snap(galP.x, 0.5), z: snap(galP.z, 0.5), w: galLen, d: galD,
    yaw: DIAG_YAW, ceiling: 7.6,
    tags: ['corridor', 'lit', 'wide'],
  })));
  gallery.bays = clamp(Math.round(galLen / rng.range(4.0, 4.8)), 6, 9);
  link('hall', 'gallery', {
    kind: 'arch', width: 4.0,
    from: { x: northDoorX, z: hallMinZ },
    to: {
      x: gallery.x + DIR.screenLeft[0] * galLen * 0.5 + DIR.screenDown[0] * galD * 0.28,
      z: gallery.z + DIR.screenLeft[1] * galLen * 0.5 + DIR.screenDown[1] * galD * 0.28,
    },
  });

  // =========================================================================
  // 15. THE CLOISTER — an open court, the widest room in the level
  // =========================================================================
  const cloW = snap(rng.range(32, 36));
  const cloD = snap(rng.range(28, 32));
  const galEnd = {
    x: gallery.x + DIR.screenRight[0] * galLen * 0.5,
    z: gallery.z + DIR.screenRight[1] * galLen * 0.5,
  };
  const cloister = add(finalise(makeRoom({
    id: 'cloister', kind: 'cloister', name: 'The Cloister of Ashes',
    x: snap(galEnd.x + DIR.screenRight[0] * ((cloW + cloD) * 0.25 + 2.5)),
    z: snap(galEnd.z + DIR.screenRight[1] * ((cloW + cloD) * 0.25 + 2.5)),
    w: cloW, d: cloD, ceiling: 7.2,
    tags: ['open-sky', 'wide', 'lit'],
  })));
  cloister.walkW = snap(clamp(rng.range(4.2, 5.0), 4.0, 5.2), 0.2);
  cloister.bays = rng.int(5, 7);
  link('gallery', 'cloister', { kind: 'arch', width: 4.2 });

  // =========================================================================
  // 16. THE RELIQUARY — the dead end that is worth the walk
  // =========================================================================
  // Up-screen of the lamp walk, so from the hall's north door the eye runs
  // straight down the walk, through the cloister arcade and onto its lit porch:
  // three rooms deep, which is the thing a big isometric level is FOR.
  const relR = snap(rng.range(11, 13));
  const relP = {
    x: gallery.x + DIR.screenUp[0] * (galD * 0.5 + relR + 3.0) + DIR.screenRight[0] * galLen * 0.10,
    z: gallery.z + DIR.screenUp[1] * (galD * 0.5 + relR + 3.0) + DIR.screenRight[1] * galLen * 0.10,
  };
  const reliquary = add(finalise(makeRoom({
    id: 'reliquary', kind: 'reliquary', name: 'The Reliquary of Saint Vess',
    x: snap(relP.x), z: snap(relP.z), w: relR * 2, d: relR * 2,
    y: 0.6, ceiling: 8.4,
    tags: ['chamber', 'reward', 'lit'],
  })));
  reliquary.sides = rng.int(8, 8);
  link('gallery', 'reliquary', { kind: 'stair', width: 3.6 });

  // =========================================================================
  // 17. THE CHAPTER CHAMBER — a small dead end on the camera side of the walk
  // =========================================================================
  const chapW = snap(rng.range(12, 15));
  const chapD = snap(rng.range(10, 13));
  const chapP = {
    x: gallery.x + DIR.screenDown[0] * (galD * 0.5 + chapD * 0.5 + 1.6) + DIR.screenRight[0] * galLen * 0.24,
    z: gallery.z + DIR.screenDown[1] * (galD * 0.5 + chapD * 0.5 + 1.6) + DIR.screenRight[1] * galLen * 0.24,
  };
  add(finalise(makeRoom({
    id: 'chapter', kind: 'chamber', name: 'The Chapter Room',
    x: snap(chapP.x), z: snap(chapP.z), w: chapW, d: chapD, ceiling: 4.2,
    tags: ['chamber', 'dark', 'reward'],
  })));
  link('gallery', 'chapter', { kind: 'door', width: 2.8 });

  // =========================================================================
  // AABBs must contain their links
  // =========================================================================
  // A throat is walkable floor, and `ai`'s flow field marks any cell outside
  // every room AABB solid before it even raycasts — so a doorway that pokes past
  // the 1.6 m pad is floor the navigation grid refuses to use, which is exactly
  // the failure mode that made half the old level unreachable. Growing the two
  // endpoint boxes to contain the throat is one line and removes the whole class.
  for (const L of links) {
    const pad = L.width * 0.5 + 1.2;
    for (const id of [L.a, L.b]) {
      const a = byId.get(id).aabb;
      a.minX = Math.min(a.minX, L.ax - pad, L.bx - pad);
      a.maxX = Math.max(a.maxX, L.ax + pad, L.bx + pad);
      a.minZ = Math.min(a.minZ, L.az - pad, L.bz - pad);
      a.maxZ = Math.max(a.maxZ, L.az + pad, L.bz + pad);
    }
  }
  for (const r of rooms) {
    r.hw = (r.aabb.maxX - r.aabb.minX) * 0.5;
    r.hh = (r.aabb.maxZ - r.aabb.minZ) * 0.5;
  }

  // =========================================================================
  // spawn + landmarks
  // =========================================================================
  //
  // Landmarks are the highest-leverage thing in this file: the shot harness
  // teleports the player onto one and frames it isometrically, so each one is a
  // composed marketing shot rather than a coordinate. The rule for all of them
  // is the same — stand so that the subject is UP-SCREEN, i.e. at −X −Z of the
  // landmark, because that is the half of the world the camera can see.
  //
  // Derived, not guessed. At the hero boom the ground is visible from 5.3 m
  // down-screen of the focus to 12.2 m up-screen of it (boom 24, fov 34,
  // pitch -52: the top ray meets the ground at h/tan(35deg) and the bottom at
  // h/tan(69deg)).
  const spawn = { x: snap(hall.x - 5, 1), y: 0, z: snap(hall.naveZ, 1) };

  const landmarks = {
    // ON THE NAVE CENTRE LINE, five metres west of the room's middle: the north
    // arcade 4.2 m up-screen-right, the ruined south arcade 4.2 m
    // down-screen-left, and the sanctuary steps 70% of the way up the frame.
    hall: [snap(hall.x - 5, 1), 0, snap(hall.naveZ, 1)],

    // TEN metres up the crypt corridor, not fourteen. Looking back toward the
    // hall, the corridor's rhythm of ribs recedes straight up the frame and
    // terminates on the lit archway — but only if the archway is INSIDE the
    // visible band. At a −52° pitch the ground is visible about 0.53·boom metres
    // up-screen of the focus, i.e. 9 m at the corridor shot's 17 m boom and 11 m
    // at the gameplay boom, so at fourteen the hall was off the top of frame and
    // the measured sightline depth was two rooms. At ten it is four: corridor,
    // side cell, hall, and the passage past them.
    corridor: [
      snap(hallMaxX + DIR.screenDown[0] * Math.min(10, cryptLen * 0.42), 0.5),
      0,
      snap(mouthZ + DIR.screenDown[1] * Math.min(10, cryptLen * 0.42), 0.5),
    ],

    // Just inside the gate, on the processional axis.
    //
    // Honest about what "a long sightline" can mean at a −52 degree pitch: the
    // ground is only visible about 13 m up-screen of the focus at the `depth`
    // boom, so a 28 m colonnade does NOT recede to a vanishing point — it leaves
    // the top of the frame after four bays. What the shot actually delivers is a
    // nine-metre wall of masonry with a lit hole in it at 40% frame height, the
    // portcullis hanging in that hole, and a brazier three metres beyond it, so
    // the eye reads depth from the value break rather than from perspective.
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

    // ---- the new precinct --------------------------------------------------

    // THE LEVEL'S SECOND THREE-ROOM SIGHTLINE, and the one that reads best.
    // Standing at the hall end of the lamp walk the frame contains, in order up
    // the screen: the walk's own arcade, the cloister court behind it, and the
    // lit porch of the reliquary above that. Placed a third of the way along so
    // the arcade has somewhere to recede TO.
    vista: [
      snap(gallery.x + DIR.screenLeft[0] * galLen * 0.30 + DIR.screenDown[0] * galD * 0.16, 0.5), 0,
      snap(gallery.z + DIR.screenLeft[1] * galLen * 0.30 + DIR.screenDown[1] * galD * 0.16, 0.5),
    ],
    gallery: [
      snap(gallery.x + DIR.screenDown[0] * galD * 0.26, 0.5), 0,
      snap(gallery.z + DIR.screenDown[1] * galD * 0.26, 0.5),
    ],
    // On the court's down-screen walk, so the whole open square, the well and
    // the far arcade are up-screen and the sky is the ceiling.
    cloister: [
      snap(cloister.x + DIR.screenDown[0] * (cloW + cloD) * 0.17, 0.5), 0,
      snap(cloister.z + DIR.screenDown[1] * (cloW + cloD) * 0.17, 0.5),
    ],
    reliquary: [
      snap(reliquary.x + DIR.screenDown[0] * relR * 0.55, 0.5), reliquary.y,
      snap(reliquary.z + DIR.screenDown[1] * relR * 0.55, 0.5),
    ],
    // THE THIRD SIGHTLINE: down-screen of the nave's centre line, so the eye
    // runs along forty metres of broken arcade, out of its far end, across the
    // chain span and into the lit processional beyond.
    nave: [
      snap(fallen.x + DIR.screenDown[0] * naveD * 0.30 + DIR.screenLeft[0] * naveLen * 0.20, 0.5), fallen.y,
      snap(fallen.z + DIR.screenDown[1] * naveD * 0.30 + DIR.screenLeft[1] * naveLen * 0.20, 0.5),
    ],
    // Mid-deck, biased toward the processional end. The chasm falls away on both
    // sides and fills the lower half of the frame; the fallen nave closes the
    // left of it and the processional's lit breach the right, so the shot is
    // three spaces across rather than three spaces deep — which is the only way
    // to be three spaces anything at a −52° pitch over a 20 m gap.
    span: [
      snap(span.x + DIR.screenRight[0] * span.w * 0.14, 0.5), 0,
      snap(span.z + DIR.screenRight[1] * span.w * 0.14, 0.5),
    ],
    catacomb: [
      snap(cat.x + DIR.screenDown[0] * catD * 0.30, 0.5), 0,
      snap(cat.z + DIR.screenDown[1] * catD * 0.30, 0.5),
    ],
    sluice: [
      snap(sluice.x + DIR.screenDown[0] * sluD * 0.30, 0.5), sluice.y,
      snap(sluice.z + DIR.screenDown[1] * sluD * 0.30, 0.5),
    ],
    cistern: [
      snap(cistern.x + DIR.screenDown[0] * cisD * 0.32, 0.5), cistern.y,
      snap(cistern.z + DIR.screenDown[1] * cisD * 0.32, 0.5),
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
    links,
    spawn,
    landmarks,
    criticalPath: ['hall', 'processional', 'arena'],
    optional: ['crypt', 'ossuary', 'cell', 'catacomb', 'sluice', 'loop', 'undercroft',
               'cistern', 'shrine', 'nave', 'span', 'gallery', 'cloister', 'reliquary',
               'chapter'],
    cell: CELL,
  };

  // Sanity: two rooms occupying the same cubic metre means two sets of walls in
  // one place, which reads as a rendering bug rather than as a level. Reported
  // rather than thrown — a corridor overlapping the room it enters is correct
  // and expected, so only NON-NEIGHBOURS are checked.
  //
  // The test is a separating-axis test on the rooms' real ROTATED rectangles,
  // not on their AABBs. Five of this level's rooms are at 45 degrees and their
  // axis-aligned bounds are 1.4x their true footprint, so an AABB test reports
  // an overlap between the crypt corridor and a passage that runs ten metres
  // clear of it — a false alarm that is worse than no check at all, because it
  // trains whoever reads `stats()` to ignore the field.
  level.overlaps = [];
  const rectOf = (r) => {
    const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
    return { cx: r.x, cz: r.z, hx: r.w * 0.5, hz: r.d * 0.5, ax: [c, -s], az: [s, c] };
  };
  const project = (rc, axis) =>
    Math.abs(rc.ax[0] * axis[0] + rc.ax[1] * axis[1]) * rc.hx +
    Math.abs(rc.az[0] * axis[0] + rc.az[1] * axis[1]) * rc.hz;
  const obbOverlap = (a, b) => {
    const dx = b.cx - a.cx, dz = b.cz - a.cz;
    for (const axis of [a.ax, a.az, b.ax, b.az]) {
      const d = Math.abs(dx * axis[0] + dz * axis[1]);
      if (d > project(a, axis) + project(b, axis)) return 0;
    }
    // Overlapping on every axis: report the smallest penetration as a severity.
    let worst = Infinity;
    for (const axis of [a.ax, a.az, b.ax, b.az]) {
      const d = Math.abs(dx * axis[0] + dz * axis[1]);
      worst = Math.min(worst, project(a, axis) + project(b, axis) - d);
    }
    return worst;
  };
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (rooms[i].neighbours.includes(rooms[j].id)) continue;
      const pen = obbOverlap(rectOf(rooms[i]), rectOf(rooms[j]));
      if (pen > 1.5) level.overlaps.push([rooms[i].id, rooms[j].id, +pen.toFixed(1)]);
    }
  }

  return level;
}

export { DIR, DIAG_YAW, screenAt, screenOf, edgePoint };
