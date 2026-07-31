/**
 * MONARCH — static collision handoff.
 *
 * ---------------------------------------------------------------------------
 * WHY BOXES AND NOT THE RENDERED TRIANGLES
 *
 * The level draws about 400k triangles. Handing those to the BVH would give a
 * build measured in seconds, a tree deep enough that every character sweep walks
 * forty nodes, and collision against a 6 cm chamfer on a voussoir — which no
 * player will ever feel and which will snag them.
 *
 * So the builders record an ORIENTED BOX for every solid thing as they place it,
 * and this file turns those into triangles. The result is ~2–5k triangles for a
 * whole level: a BVH that builds in a few milliseconds and queries in
 * microseconds, with collision that matches what the player believes about the
 * space rather than what the renderer happens to have drawn.
 *
 * Surfaces are tagged at the source (a wall says `stone`, a floor says
 * `flagstone`, a brazier says `metal`, the water says `water`), which is what
 * makes footstep audio, impact FX and decals pick the right response — that
 * whole chain is dead if the tag is guessed from a mesh name.
 *
 * One collider object is registered PER SURFACE TAG, not per box, because
 * `physics.addStaticTriangles` stores one surface per object. That is also the
 * cheapest possible registration: a dozen objects instead of a thousand.
 */

/** Unit cube corner offsets, in the order the two triangles below index. */
const CORNERS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

/** Twelve triangles, wound counter-clockwise seen from outside. */
const FACES = [
  [0, 2, 1], [0, 3, 2],   // -Z
  [4, 5, 6], [4, 6, 7],   // +Z
  [0, 4, 7], [0, 7, 3],   // -X
  [1, 2, 6], [1, 6, 5],   // +X
  [3, 7, 6], [3, 6, 2],   // +Y
  [0, 1, 5], [0, 5, 4],   // -Y
];

/**
 * Group oriented boxes by surface tag and emit one Float32Array of triangles per
 * tag.
 *
 * @param {Array<{x,y,z,hx,hy,hz,yaw,surface}>} boxes
 * @returns {Map<string, {positions: Float32Array, count: number}>}
 */
export function bakeColliders(boxes) {
  const bySurface = new Map();
  for (const b of boxes) {
    const s = b.surface || 'stone';
    let list = bySurface.get(s);
    if (!list) { list = []; bySurface.set(s, list); }
    list.push(b);
  }

  const out = new Map();
  const c = new Float32Array(24);
  for (const [surface, list] of bySurface) {
    const triCount = list.length * 12;
    const positions = new Float32Array(triCount * 9);
    let w = 0;
    for (const b of list) {
      const cy = Math.cos(b.yaw || 0), sy = Math.sin(b.yaw || 0);
      for (let i = 0; i < 8; i++) {
        const lx = CORNERS[i][0] * b.hx;
        const ly = CORNERS[i][1] * b.hy;
        const lz = CORNERS[i][2] * b.hz;
        // Yaw about Y: local +X -> (cos, 0, -sin), local +Z -> (sin, 0, cos).
        c[i * 3 + 0] = b.x + cy * lx + sy * lz;
        c[i * 3 + 1] = b.y + ly;
        c[i * 3 + 2] = b.z - sy * lx + cy * lz;
      }
      for (const f of FACES) {
        for (let k = 0; k < 3; k++) {
          const v = f[k] * 3;
          positions[w++] = c[v];
          positions[w++] = c[v + 1];
          positions[w++] = c[v + 2];
        }
      }
    }
    out.set(surface, { positions, count: triCount });
  }
  return out;
}

/**
 * Register the baked colliders with physics.
 *
 * Tolerates a missing physics subsystem: `world` must boot and photograph
 * correctly whether or not `physics` is registered, because the two are
 * developed in parallel by different agents.
 *
 * @returns {number[]} collider ids, for `dispose()`
 */
export function registerColliders(physics, boxes, nameHint = 'world') {
  const ids = [];
  if (!physics?.addStaticTriangles) return ids;
  const baked = bakeColliders(boxes);
  for (const [surface, { positions, count }] of baked) {
    const id = physics.addStaticTriangles(positions, count, {
      surface,
      name: `${nameHint}.${surface}`,
    });
    if (id >= 0) ids.push(id);
  }
  return ids;
}

/** Total triangle count a collider set will produce — for `stats()`. */
export function colliderTriangles(boxes) {
  return boxes.length * 12;
}
