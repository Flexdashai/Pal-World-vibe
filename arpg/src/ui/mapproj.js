/**
 * THE MAP PROJECTION. One rotation constant, shared by the minimap dial, the
 * full-screen map, the blip layer and the player arrow.
 *
 * ---------------------------------------------------------------------------
 * IT WAS 90 DEGREES WRONG, AND THAT IS THE WHOLE "THE MAP DOES NOT FOLLOW ME"
 * COMPLAINT
 *
 * The camera is fixed at 45 degrees of yaw, so on screen
 *
 *     +X is right-and-DOWN        (canvas  +0.707, +0.707)
 *     +Z is left-and-DOWN         (canvas  -0.707, +0.707)
 *     screen up  = -X-Z           screen right = +X-Z
 *
 * A canvas rotated by `r` sends world (dx, dz) to
 *
 *     ( dx*cos r - dz*sin r ,  dx*sin r + dz*cos r )      (canvas y is DOWN)
 *
 * so +X lands right-and-down only when `r = +45 deg`. The dial was rotated by
 * -45, which sends +X up-and-right and +Z down-and-right: the entire map was
 * turned a quarter turn. Walking screen-up scrolled the map sideways, which is
 * exactly what "it does not follow the character" feels like from the chair.
 *
 * MEASURED, end to end, by projecting a world offset through the real camera and
 * through the dial's own pixels and comparing the two angles (see the report):
 *
 *     axis                camera screen angle   dial angle   error
 *     screen up  (-X-Z)        -88.96 deg       -177.39 deg  -88.43 deg
 *     screen right(+X-Z)         0.00 deg        -88.74 deg  -88.74 deg
 *
 * The comment above the old `c.rotate(-Math.PI * 0.25)` claimed it aligned
 * map-up with screen-up. It did the opposite. Everything that needs the map
 * basis now goes through this file so the dial, the blips, the arrow and the
 * full-screen map cannot drift apart again.
 *
 * (The per-axis errors for a pure +X or +Z offset come out at -84 / -102 rather
 * than -90 because the camera is a PERSPECTIVE camera: the screen angle of a
 * world axis depends on where in the frame you measure it. The two diagonals —
 * which are the directions a player actually reads a map by — bracket -88.6.)
 */

/** Canvas rotation, in radians, that makes map-up equal screen-up. */
export const MAP_ROT = Math.PI * 0.25;
export const MAP_COS = Math.cos(MAP_ROT);
export const MAP_SIN = Math.sin(MAP_ROT);

/**
 * World XZ delta -> canvas delta (unscaled). `out` is a caller-owned 2-array,
 * because this runs inside draw loops and must not allocate.
 */
export function mapDelta(dx, dz, out) {
  out[0] = dx * MAP_COS - dz * MAP_SIN;
  out[1] = dx * MAP_SIN + dz * MAP_COS;
  return out;
}

/**
 * Canvas rotation for a marker whose art points at -Y (screen up) when the
 * rotation is 0, given a world-space heading `atan2(vx, vz)`.
 *
 * Derived from `mapDelta`, never hand-written: the arrow used to carry its own
 * copy of the rotation (`pface - PI/4`) which was a MIRROR of the map's basis
 * rather than a rotation of it, so the arrow and the terrain under it agreed
 * only when the player happened to be running due screen-right.
 */
export function markerRotation(heading) {
  const dx = Math.sin(heading), dz = Math.cos(heading);
  return Math.atan2(dx * MAP_COS - dz * MAP_SIN, -(dx * MAP_SIN + dz * MAP_COS));
}

/**
 * Duck-type whatever `world` puts in `world:ready`. Returns a normalised room
 * box `{x, z, hw, hh, rot, ...}`, or null.
 *
 * `rot` IS THE CANVAS ROTATION, NOT THE ROOM'S YAW, and the distinction is not
 * cosmetic:
 *
 *  - `world` publishes BOTH the plan dimensions (`w`, `d`, `yaw`) and the
 *    axis-aligned AABB half-extents (`hw`, `hh`) of the same room. `hw`/`hh`
 *    already have the rotation folded in and are padded by the wall thickness,
 *    so drawing them AND rotating by `yaw` inflates every angled room and tilts
 *    it a second time. Five rooms on this floor sit at 45 degrees. The true
 *    footprint is `w x d` turned by `yaw`, so that is what is preferred, and
 *    `hw`/`hh` are the fallback for a payload that has nothing better — drawn
 *    unrotated, because they are already an AABB.
 *
 *  - the room frame's local-to-world (`layout.toWorld`) is
 *    `[[cos, sin], [-sin, cos]]`, which is a rotation by MINUS yaw in the
 *    (x, z) plane the canvas is drawing in. `rot = -yaw`.
 */
export function normaliseRoom(r) {
  if (!r) return null;
  const yaw = typeof r.yaw === 'number' ? r.yaw : 0;
  const meta = (b, rot) => {
    b.id = r.id;
    b.name = r.name ?? null;
    b.kind = r.kind ?? null;
    b.rot = rot;
    b.cleared = !!r.cleared;
    b.seen = !!r.seen;
    return b;
  };
  if (typeof r.x === 'number' && typeof r.z === 'number') {
    // plan dimensions + yaw: the true footprint
    if (typeof r.w === 'number' && typeof r.d === 'number') {
      return meta({ x: r.x, z: r.z, hw: Math.abs(r.w) * 0.5, hh: Math.abs(r.d) * 0.5 }, -yaw);
    }
    if (typeof r.w === 'number' && typeof r.h === 'number') {
      return meta({ x: r.x, z: r.z, hw: Math.abs(r.w) * 0.5, hh: Math.abs(r.h) * 0.5 }, -yaw);
    }
    // AABB half-extents: already axis-aligned, must NOT be rotated again
    if (typeof r.hw === 'number') {
      return meta({ x: r.x, z: r.z, hw: r.hw, hh: r.hh ?? r.hw }, 0);
    }
  }
  if (r.aabb && typeof r.aabb.minX === 'number') {
    const a = r.aabb;
    return meta({
      x: (a.minX + a.maxX) * 0.5, z: (a.minZ + a.maxZ) * 0.5,
      hw: Math.abs(a.maxX - a.minX) * 0.5, hh: Math.abs(a.maxZ - a.minZ) * 0.5,
    }, 0);
  }
  if (r.min && r.max) {
    return meta({
      x: (r.min.x + r.max.x) * 0.5, z: (r.min.z + r.max.z) * 0.5,
      hw: Math.abs(r.max.x - r.min.x) * 0.5, hh: Math.abs(r.max.z - r.min.z) * 0.5,
    }, 0);
  }
  if (r.center && r.size) {
    return meta({
      x: r.center.x, z: r.center.z,
      hw: Math.abs(r.size.x) * 0.5, hh: Math.abs(r.size.z) * 0.5,
    }, 0);
  }
  if (r.position && typeof r.radius === 'number') {
    return meta({ x: r.position.x, z: r.position.z, hw: r.radius, hh: r.radius }, 0);
  }
  return null;
}

/**
 * AABB over normalised rooms. Returns null when there is nothing to bound, so
 * callers keep whatever default they had rather than collapsing to a point.
 *
 * The room footprint is rotated by `yaw` for five of this level's rooms, so the
 * bound uses the rotated extents — a level sized from the unrotated boxes comes
 * out short on exactly the rooms that stick out furthest.
 */
export function roomsBounds(rooms, pad = 0) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of rooms) {
    const c = Math.abs(Math.cos(r.rot ?? 0)), s = Math.abs(Math.sin(r.rot ?? 0));
    const hx = r.hw * c + r.hh * s;
    const hz = r.hw * s + r.hh * c;
    if (r.x - hx < minX) minX = r.x - hx;
    if (r.x + hx > maxX) maxX = r.x + hx;
    if (r.z - hz < minZ) minZ = r.z - hz;
    if (r.z + hz > maxZ) maxZ = r.z + hz;
  }
  if (!Number.isFinite(minX)) return null;
  return {
    minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad,
    spanX: (maxX - minX) + pad * 2, spanZ: (maxZ - minZ) + pad * 2,
    cx: (minX + maxX) * 0.5, cz: (minZ + maxZ) * 0.5,
  };
}

/** ±1 corner signs, module-level so the bounds pass allocates nothing. */
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/**
 * Bounds of the level IN MAP SPACE — the box the drawn level actually occupies
 * on a rotated canvas.
 *
 * Fitting the world-space AABB and then rotating IT is what a naive fit does,
 * and it is wrong by a large margin here: the dungeon is a star of rooms, so its
 * world AABB is 137 x 147 m but its rotated AABB is 219 m on both axes — 60%
 * bigger, all of it empty corner. The full-screen map fitted to that leaves the
 * level occupying about a third of the screen it was opened to fill.
 */
export function roomsScreenBounds(rooms, pad = 0) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const r of rooms) {
    const c = Math.cos(r.rot ?? 0), s = Math.sin(r.rot ?? 0);
    for (let i = 0; i < 4; i++) {
      const lx = CORNERS[i][0] * r.hw, lz = CORNERS[i][1] * r.hh;
      const wx = r.x + lx * c - lz * s;
      const wz = r.z + lx * s + lz * c;
      const uu = wx * MAP_COS - wz * MAP_SIN;
      const vv = wx * MAP_SIN + wz * MAP_COS;
      if (uu < minU) minU = uu;
      if (uu > maxU) maxU = uu;
      if (vv < minV) minV = vv;
      if (vv > maxV) maxV = vv;
    }
  }
  if (!Number.isFinite(minU)) return null;
  minU -= pad; maxU += pad; minV -= pad; maxV += pad;
  const cu = (minU + maxU) * 0.5, cvv = (minV + maxV) * 0.5;
  return {
    spanU: maxU - minU, spanV: maxV - minV,
    // the world point at the centre of that box (inverse of the map rotation)
    cx: cu * MAP_COS + cvv * MAP_SIN,
    cz: -cu * MAP_SIN + cvv * MAP_COS,
  };
}
