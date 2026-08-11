/**
 * math.js — the allocation-free geometric kernel the whole physics system stands on.
 *
 * Everything here takes *scalar components* and writes into a caller-supplied
 * record. That is deliberate and non-negotiable: BVH traversal, capsule sweeps and
 * contact generation run tens of thousands of times per fixed step, and a single
 * `new THREE.Vector3()` inside one of them would put the GC on the critical path of
 * a 60 Hz simulation. Records are plain objects with a fixed shape so V8 keeps the
 * call sites monomorphic and can inline them.
 *
 * Conventions, matching ARCHITECTURE.md:
 *   - Right-handed, **Y up**, metres, seconds, kilograms. Ground is the XZ plane.
 *   - A capsule is the Minkowski sum of a segment (p0..p1) and a sphere of radius r.
 *     p0/p1 are the *sphere centres*, never the tips — so a 1.82 m character with
 *     0.36 m radius has its segment from y=0.36 to y=1.46.
 *   - Triangle winding is CCW seen from the front; the geometric normal is
 *     normalize(cross(b-a, c-a)).
 *   - "t" on a ray/sweep is a distance in metres because directions are unit.
 */

import * as THREE from 'three';

export const EPS = 1e-9;
/** Contact/skin tolerance. 0.1 mm — below the smallest feature we model. */
export const TOL = 1e-4;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function saturate(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth interpolant used for falloffs (explosion strength, drag ramps). */
export function smoothstep(a, b, x) {
  const t = saturate((x - a) / (b - a || EPS));
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

/** Closest-feature record: `a*` on the first primitive, `b*` on the second. */
export function makeClosest() {
  return { d2: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, s: 0, t: 0 };
}

/**
 * A hit record. The scalar fields are what the hot loops write; `point`/`normal`
 * are THREE.Vector3 mirrors filled by `syncHit()` exactly once, at the end of a
 * query, because every consumer outside this directory (fx, combat, ai, loot)
 * thinks in Vector3 and none of them should have to touch `hit.px`.
 *
 * The object is REUSED between queries — copy anything you intend to keep.
 */
export function makeHit() {
  return {
    hit: false,
    /** Distance along the query direction, metres. */
    t: 0,
    distance: 0,
    px: 0, py: 0, pz: 0,
    nx: 0, ny: 1, nz: 0,
    /** Triangle index inside the static soup, or -1. */
    tri: -1,
    /** Surface enum index; `surface` is the string name. */
    surfaceId: 0,
    surface: 'stone',
    /** Static collider object id, or -1. */
    object: -1,
    /** Collision layer bit of whatever was hit. */
    layer: 0,
    frontFace: true,
    /** 'static' | 'actor' | 'body' | 'ragdoll' | 'none' */
    kind: 'none',
    /** For capsule sweeps: parameter along the capsule axis where contact landed,
     *  0 = bottom sphere centre, 1 = top. Lets a controller tell a foot scrape
     *  from a head bump without re-deriving it. */
    contactS: 0,
    /** Populated for dynamic hits. */
    actor: null,
    body: null,
    mesh: null,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
  };
}

/** Mirror the scalar fields of a hit record into its Vector3s. Call once. */
export function syncHit(h) {
  h.point.set(h.px, h.py, h.pz);
  h.normal.set(h.nx, h.ny, h.nz);
  h.distance = h.t;
  return h;
}

export function clearHit(h) {
  h.hit = false;
  h.t = 0;
  h.distance = 0;
  h.tri = -1;
  h.object = -1;
  h.layer = 0;
  h.kind = 'none';
  h.contactS = 0;
  h.actor = null;
  h.body = null;
  h.mesh = null;
  h.surfaceId = 0;
  h.surface = 'stone';
  h.nx = 0; h.ny = 1; h.nz = 0;
  return h;
}

/* ------------------------------------------------------------------ */
/* Ray primitives                                                      */
/* ------------------------------------------------------------------ */

/**
 * Möller–Trumbore ray/triangle. Returns the ray parameter t, or -1 on miss.
 * Backfaces are NOT culled: a raycast that starts inside a wall (a spell cast
 * from a pillar's interior, a projectile spawned flush against geometry) must
 * still report the exit face rather than silently pass through the level.
 */
export function rayTriangle(
  ox, oy, oz, dx, dy, dz,
  ax, ay, az, bx, by, bz, cx, cy, cz,
  out
) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1; // ray parallel to the plane
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1.000001) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-6 || u + v > 1.000001) return -1;
  if (out) out.frontFace = det > 0;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/**
 * Slab test against an AABB with a precomputed reciprocal direction.
 * Returns the entry distance, or Infinity on miss. A ray whose origin is inside
 * the box returns 0 rather than a negative entry, so traversal orders correctly.
 *
 * Reciprocals of zero components must be ±Infinity, not NaN — callers guard by
 * substituting 1e-30 for a zero component before dividing.
 */
export function rayAabb(
  ox, oy, oz, ix, iy, iz,
  minx, miny, minz, maxx, maxy, maxz,
  tmax
) {
  let t0 = (minx - ox) * ix;
  let t1 = (maxx - ox) * ix;
  let lo = t0 < t1 ? t0 : t1;
  let hi = t0 < t1 ? t1 : t0;
  t0 = (miny - oy) * iy;
  t1 = (maxy - oy) * iy;
  const lo1 = t0 < t1 ? t0 : t1;
  const hi1 = t0 < t1 ? t1 : t0;
  if (lo1 > lo) lo = lo1;
  if (hi1 < hi) hi = hi1;
  t0 = (minz - oz) * iz;
  t1 = (maxz - oz) * iz;
  const lo2 = t0 < t1 ? t0 : t1;
  const hi2 = t0 < t1 ? t1 : t0;
  if (lo2 > lo) lo = lo2;
  if (hi2 < hi) hi = hi2;
  if (hi < 0 || lo > hi || lo > tmax) return Infinity;
  return lo < 0 ? 0 : lo;
}

/** Ray vs sphere. Returns the entry distance in [0,maxDist], or -1. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1; // outside and pointing away
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq; // origin inside the sphere
  if (t < 0 || t > maxDist) return -1;
  return t;
}

/**
 * Ray vs capsule (segment a..b, radius r). Solved as ray-vs-infinite-cylinder
 * clipped to the segment, unioned with the two cap spheres. Returns -1 on miss.
 *
 * This is the workhorse for "did the projectile hit that enemy" — every actor is
 * a capsule and every projectile a swept sphere, so we call it with the capsule
 * inflated by the projectile radius (Minkowski) rather than doing a true
 * capsule/capsule sweep.
 */
export function rayCapsule(
  ox, oy, oz, dx, dy, dz,
  ax, ay, az, bx, by, bz, r, maxDist
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const aox = ox - ax, aoy = oy - ay, aoz = oz - az;
  const abab = abx * abx + aby * aby + abz * abz;
  if (abab < EPS) return raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r, maxDist);
  const m = (abx * dx + aby * dy + abz * dz) / abab;
  const n = (abx * aox + aby * aoy + abz * aoz) / abab;
  const qx = dx - abx * m, qy = dy - aby * m, qz = dz - abz * m;
  const sx = aox - abx * n, sy = aoy - aby * n, sz = aoz - abz * n;
  const A = qx * qx + qy * qy + qz * qz;
  const B = 2 * (qx * sx + qy * sy + qz * sz);
  const C = sx * sx + sy * sy + sz * sz - r * r;
  let best = -1;
  if (A > EPS) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t = (-B - sq) / (2 * A);
      if (t < 0) t = (-B + sq) / (2 * A);
      if (t >= 0 && t <= maxDist) {
        const k = n + t * m; // parameter along the capsule axis
        if (k >= 0 && k <= 1) best = t;
      }
    }
  } else if (C <= 0) {
    best = 0; // parallel to the axis and already inside the cylinder
  }
  const t1 = raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r, maxDist);
  if (t1 >= 0 && (best < 0 || t1 < best)) best = t1;
  const t2 = raySphere(ox, oy, oz, dx, dy, dz, bx, by, bz, r, maxDist);
  if (t2 >= 0 && (best < 0 || t2 < best)) best = t2;
  return best;
}

/** Ray vs oriented box. `inv` is a Matrix4.elements array holding world→local. */
export function rayObb(ox, oy, oz, dx, dy, dz, inv, hx, hy, hz, maxDist) {
  const lx = inv[0] * ox + inv[4] * oy + inv[8] * oz + inv[12];
  const ly = inv[1] * ox + inv[5] * oy + inv[9] * oz + inv[13];
  const lz = inv[2] * ox + inv[6] * oy + inv[10] * oz + inv[14];
  const ldx = inv[0] * dx + inv[4] * dy + inv[8] * dz;
  const ldy = inv[1] * dx + inv[5] * dy + inv[9] * dz;
  const ldz = inv[2] * dx + inv[6] * dy + inv[10] * dz;
  const t = rayAabb(
    lx, ly, lz,
    1 / (ldx || 1e-30), 1 / (ldy || 1e-30), 1 / (ldz || 1e-30),
    -hx, -hy, -hz, hx, hy, hz,
    maxDist
  );
  return t === Infinity ? -1 : t;
}

/* ------------------------------------------------------------------ */
/* Closest-feature queries                                             */
/* ------------------------------------------------------------------ */

/** Ericson, Real-Time Collision Detection §5.1.5. Writes out.b* = point on tri. */
export function closestPtPointTriangle(
  px, py, pz,
  ax, ay, az, bx, by, bz, cx, cy, cz,
  out
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out.bx = ax; out.by = ay; out.bz = az; return; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out.bx = bx; out.by = by; out.bz = bz; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out.bx = ax + abx * v; out.by = ay + aby * v; out.bz = az + abz * v;
    return;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out.bx = cx; out.by = cy; out.bz = cz; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out.bx = ax + acx * w; out.by = ay + acy * w; out.bz = az + acz * w;
    return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out.bx = bx + (cx - bx) * w; out.by = by + (cy - by) * w; out.bz = bz + (cz - bz) * w;
    return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out.bx = ax + abx * v + acx * w;
  out.by = ay + aby * v + acy * w;
  out.bz = az + abz * v + acz * w;
}

/** Closest point on segment ab to point p. Writes out.b* and returns the param. */
export function closestPtPointSegment(px, py, pz, ax, ay, az, bx, by, bz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > EPS) t = clamp(((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2, 0, 1);
  out.bx = ax + abx * t; out.by = ay + aby * t; out.bz = az + abz * t;
  out.t = t;
  return t;
}

/**
 * Closest points between segments p1q1 and p2q2 (Ericson §5.1.9).
 * Writes out.a* (on segment 1), out.b* (on segment 2), out.s/out.t, out.d2.
 */
export function closestPtSegSeg(
  p1x, p1y, p1z, q1x, q1y, q1z,
  p2x, p2y, p2z, q2x, q2y, q2z,
  out
) {
  const dx1 = q1x - p1x, dy1 = q1y - p1y, dz1 = q1z - p1z;
  const dx2 = q2x - p2x, dy2 = q2y - p2y, dz2 = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = dx1 * dx1 + dy1 * dy1 + dz1 * dz1;
  const e = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
  const f = dx2 * rx + dy2 * ry + dz2 * rz;
  let s, t;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = dx1 * rx + dy1 * ry + dz1 * rz;
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dx1 * dx2 + dy1 * dy2 + dz1 * dz2;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const ax = p1x + dx1 * s, ay = p1y + dy1 * s, az = p1z + dz1 * s;
  const bx = p2x + dx2 * t, by = p2y + dy2 * t, bz = p2z + dz2 * t;
  out.ax = ax; out.ay = ay; out.az = az;
  out.bx = bx; out.by = by; out.bz = bz;
  out.s = s; out.t = t;
  const ex = ax - bx, ey = ay - by, ez = az - bz;
  out.d2 = ex * ex + ey * ey + ez * ez;
  return out.d2;
}

const _tmp = makeClosest();

/**
 * Squared distance between segment p0p1 and triangle abc, plus the closest pair
 * (out.a* on the segment, out.b* on the triangle).
 *
 * This is the single hottest routine in the system: capsule sweeps, capsule
 * overlap, ragdoll bone collision and rigid-body probes all reduce to it. The
 * plane-straddle early-out at the top matters — when the segment actually pierces
 * the triangle (the common case while depenetrating) it skips all five sub-queries.
 */
export function segTriangleClosest(
  p0x, p0y, p0z, p1x, p1y, p1z,
  ax, ay, az, bx, by, bz, cx, cy, cz,
  out
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const d0 = nx * (p0x - ax) + ny * (p0y - ay) + nz * (p0z - az);
  const d1 = nx * (p1x - ax) + ny * (p1y - ay) + nz * (p1z - az);
  if ((d0 > 0) !== (d1 > 0)) {
    const denom = d0 - d1;
    if (denom !== 0) {
      const u = d0 / denom;
      const ix = p0x + (p1x - p0x) * u;
      const iy = p0y + (p1y - p0y) * u;
      const iz = p0z + (p1z - p0z) * u;
      const vx = ix - ax, vy = iy - ay, vz = iz - az;
      const d00 = abx * abx + aby * aby + abz * abz;
      const d01 = abx * acx + aby * acy + abz * acz;
      const d11 = acx * acx + acy * acy + acz * acz;
      const d20 = vx * abx + vy * aby + vz * abz;
      const d21 = vx * acx + vy * acy + vz * acz;
      const den = d00 * d11 - d01 * d01;
      if (den !== 0) {
        const v = (d11 * d20 - d01 * d21) / den;
        const w = (d00 * d21 - d01 * d20) / den;
        if (v >= 0 && w >= 0 && v + w <= 1) {
          out.d2 = 0;
          out.ax = ix; out.ay = iy; out.az = iz;
          out.bx = ix; out.by = iy; out.bz = iz;
          out.s = u; out.t = 0;
          return 0;
        }
      }
    }
  }

  let best = Infinity;

  closestPtPointTriangle(p0x, p0y, p0z, ax, ay, az, bx, by, bz, cx, cy, cz, _tmp);
  let ex = p0x - _tmp.bx, ey = p0y - _tmp.by, ez = p0z - _tmp.bz;
  let d = ex * ex + ey * ey + ez * ez;
  if (d < best) {
    best = d;
    out.ax = p0x; out.ay = p0y; out.az = p0z;
    out.bx = _tmp.bx; out.by = _tmp.by; out.bz = _tmp.bz;
    out.s = 0;
  }
  closestPtPointTriangle(p1x, p1y, p1z, ax, ay, az, bx, by, bz, cx, cy, cz, _tmp);
  ex = p1x - _tmp.bx; ey = p1y - _tmp.by; ez = p1z - _tmp.bz;
  d = ex * ex + ey * ey + ez * ez;
  if (d < best) {
    best = d;
    out.ax = p1x; out.ay = p1y; out.az = p1z;
    out.bx = _tmp.bx; out.by = _tmp.by; out.bz = _tmp.bz;
    out.s = 1;
  }

  d = closestPtSegSeg(p0x, p0y, p0z, p1x, p1y, p1z, ax, ay, az, bx, by, bz, _tmp);
  if (d < best) {
    best = d;
    out.ax = _tmp.ax; out.ay = _tmp.ay; out.az = _tmp.az;
    out.bx = _tmp.bx; out.by = _tmp.by; out.bz = _tmp.bz;
    out.s = _tmp.s;
  }
  d = closestPtSegSeg(p0x, p0y, p0z, p1x, p1y, p1z, bx, by, bz, cx, cy, cz, _tmp);
  if (d < best) {
    best = d;
    out.ax = _tmp.ax; out.ay = _tmp.ay; out.az = _tmp.az;
    out.bx = _tmp.bx; out.by = _tmp.by; out.bz = _tmp.bz;
    out.s = _tmp.s;
  }
  d = closestPtSegSeg(p0x, p0y, p0z, p1x, p1y, p1z, cx, cy, cz, ax, ay, az, _tmp);
  if (d < best) {
    best = d;
    out.ax = _tmp.ax; out.ay = _tmp.ay; out.az = _tmp.az;
    out.bx = _tmp.bx; out.by = _tmp.by; out.bz = _tmp.bz;
    out.s = _tmp.s;
  }

  out.d2 = best;
  return best;
}

/* ------------------------------------------------------------------ */
/* Overlap tests                                                       */
/* ------------------------------------------------------------------ */

/**
 * Triangle vs axis-aligned box, Akenine-Möller SAT (13 axes).
 * Used by box overlap queries and by the debug "what is under the cursor" probe.
 * `h*` are half-extents around centre `c*`.
 */
export function triAabb(
  ccx, ccy, ccz, hx, hy, hz,
  ax, ay, az, bx, by, bz, cx, cy, cz
) {
  // Move the triangle into the box's frame.
  const v0x = ax - ccx, v0y = ay - ccy, v0z = az - ccz;
  const v1x = bx - ccx, v1y = by - ccy, v1z = bz - ccz;
  const v2x = cx - ccx, v2y = cy - ccy, v2z = cz - ccz;

  // 3 box face normals.
  if (Math.min(v0x, v1x, v2x) > hx || Math.max(v0x, v1x, v2x) < -hx) return false;
  if (Math.min(v0y, v1y, v2y) > hy || Math.max(v0y, v1y, v2y) < -hy) return false;
  if (Math.min(v0z, v1z, v2z) > hz || Math.max(v0z, v1z, v2z) < -hz) return false;

  const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
  const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
  const e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;

  // 1 triangle plane.
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  const dPlane = nx * v0x + ny * v0y + nz * v0z;
  const rPlane = hx * Math.abs(nx) + hy * Math.abs(ny) + hz * Math.abs(nz);
  if (Math.abs(dPlane) > rPlane) return false;

  // 9 edge cross products, expanded to avoid a function call per axis.
  // axis = boxAxis x triEdge
  let p0, p1, p2, r, mn, mx;

  // e0
  p0 = e0z * v0y - e0y * v0z; p1 = e0z * v1y - e0y * v1z; p2 = e0z * v2y - e0y * v2z;
  r = hy * Math.abs(e0z) + hz * Math.abs(e0y);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;
  p0 = -e0z * v0x + e0x * v0z; p1 = -e0z * v1x + e0x * v1z; p2 = -e0z * v2x + e0x * v2z;
  r = hx * Math.abs(e0z) + hz * Math.abs(e0x);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;
  p0 = e0y * v0x - e0x * v0y; p1 = e0y * v1x - e0x * v1y; p2 = e0y * v2x - e0x * v2y;
  r = hx * Math.abs(e0y) + hy * Math.abs(e0x);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;

  // e1
  p0 = e1z * v0y - e1y * v0z; p1 = e1z * v1y - e1y * v1z; p2 = e1z * v2y - e1y * v2z;
  r = hy * Math.abs(e1z) + hz * Math.abs(e1y);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;
  p0 = -e1z * v0x + e1x * v0z; p1 = -e1z * v1x + e1x * v1z; p2 = -e1z * v2x + e1x * v2z;
  r = hx * Math.abs(e1z) + hz * Math.abs(e1x);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;
  p0 = e1y * v0x - e1x * v0y; p1 = e1y * v1x - e1x * v1y; p2 = e1y * v2x - e1x * v2y;
  r = hx * Math.abs(e1y) + hy * Math.abs(e1x);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;

  // e2
  p0 = e2z * v0y - e2y * v0z; p1 = e2z * v1y - e2y * v1z; p2 = e2z * v2y - e2y * v2z;
  r = hy * Math.abs(e2z) + hz * Math.abs(e2y);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;
  p0 = -e2z * v0x + e2x * v0z; p1 = -e2z * v1x + e2x * v1z; p2 = -e2z * v2x + e2x * v2z;
  r = hx * Math.abs(e2z) + hz * Math.abs(e2x);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;
  p0 = e2y * v0x - e2x * v0y; p1 = e2y * v1x - e2x * v1y; p2 = e2y * v2x - e2x * v2y;
  r = hx * Math.abs(e2y) + hy * Math.abs(e2x);
  mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
  if (mn > r || mx < -r) return false;

  return true;
}

/**
 * Is a point inside a cone?  `flat` collapses the test to the XZ plane, which is
 * what an ARPG cleave actually wants: an enemy standing on a step 40 cm higher
 * must still be inside the swing arc or the combat reads as broken.
 *
 * `slack` is an angular widening in radians derived from the target's radius —
 * pass `Math.asin(min(1, r/d))` so fat targets are caught by their edge, not
 * only by their centre.
 */
export function pointInCone(
  pxv, pyv, pzv,
  ox, oy, oz, dx, dy, dz,
  range, cosHalf, flat
) {
  let vx = pxv - ox, vy = pyv - oy, vz = pzv - oz;
  if (flat) vy = 0;
  const d2 = vx * vx + vy * vy + vz * vz;
  if (d2 > range * range) return -1;
  if (d2 < EPS) return 0;
  const inv = 1 / Math.sqrt(d2);
  let ddx = dx, ddy = dy, ddz = dz;
  if (flat) {
    const l = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
    ddx /= l; ddy = 0; ddz /= l;
  }
  const c = (vx * ddx + vy * ddy + vz * ddz) * inv;
  return c >= cosHalf ? Math.sqrt(d2) : -1;
}

/* ------------------------------------------------------------------ */
/* Rotation helpers on raw floats                                      */
/* ------------------------------------------------------------------ */

/** Rotate (vx,vy,vz) by quaternion (qx,qy,qz,qw). Writes out.x/y/z. */
export function quatRotate(qx, qy, qz, qw, vx, vy, vz, out) {
  // t = 2 * (q.xyz x v); v' = v + qw*t + q.xyz x t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Inverse-rotate (world → local for a unit quaternion). */
export function quatRotateInv(qx, qy, qz, qw, vx, vy, vz, out) {
  return quatRotate(-qx, -qy, -qz, qw, vx, vy, vz, out);
}

/**
 * Integrate a quaternion by an angular velocity for dt and renormalise.
 * `q` is any object with x/y/z/w (THREE.Quaternion works).
 *
 * The first-order update is exact enough at 60 Hz for debris; at very high spin
 * rates the renormalisation is what keeps it stable, so it is unconditional.
 */
export function quatIntegrate(q, wx, wy, wz, dt) {
  const hx = wx * dt * 0.5, hy = wy * dt * 0.5, hz = wz * dt * 0.5;
  const dxq = hx * q.w + hy * q.z - hz * q.y;
  const dyq = hy * q.w + hz * q.x - hx * q.z;
  const dzq = hz * q.w + hx * q.y - hy * q.x;
  const dwq = -(hx * q.x + hy * q.y + hz * q.z);
  let x = q.x + dxq, y = q.y + dyq, z = q.z + dzq, w = q.w + dwq;
  const inv = 1 / (Math.hypot(x, y, z, w) || 1);
  q.x = x * inv; q.y = y * inv; q.z = z * inv; q.w = w * inv;
  return q;
}

/**
 * Shortest-arc quaternion taking unit vector `from` to unit vector `to`.
 * Written onto `q`. Handles the antiparallel case by picking any perpendicular.
 */
export function quatFromTo(fx, fy, fz, tx, ty, tz, q) {
  const d = fx * tx + fy * ty + fz * tz;
  if (d >= 0.999999) { q.x = 0; q.y = 0; q.z = 0; q.w = 1; return q; }
  if (d <= -0.999999) {
    // 180°: rotate about any axis perpendicular to `from`.
    let ax = 0, ay = 0, az = 0;
    if (Math.abs(fx) < 0.9) { ax = 1; } else { ay = 1; }
    let cx = fy * az - fz * ay, cy = fz * ax - fx * az, cz = fx * ay - fy * ax;
    const l = Math.hypot(cx, cy, cz) || 1;
    q.x = cx / l; q.y = cy / l; q.z = cz / l; q.w = 0;
    return q;
  }
  const cx = fy * tz - fz * ty;
  const cy = fz * tx - fx * tz;
  const cz = fx * ty - fy * tx;
  const s = Math.sqrt((1 + d) * 2);
  const inv = 1 / s;
  q.x = cx * inv; q.y = cy * inv; q.z = cz * inv; q.w = s * 0.5;
  return q;
}

/**
 * Build a rotation whose local +Y maps to the unit vector (ux,uy,uz) and whose
 * local +Z is as close as possible to the reference (rx,ry,rz). Ragdoll bones use
 * this: the bone direction is fully determined by two particles, but the *twist*
 * around the bone is not, so it is carried by a reference vector to stop limbs
 * spinning about their own axis frame to frame.
 */
export function quatLookUp(ux, uy, uz, rx, ry, rz, q) {
  // z' = normalize(ref - up*(ref·up)), x' = up x z'
  let d = rx * ux + ry * uy + rz * uz;
  let zx = rx - ux * d, zy = ry - uy * d, zz = rz - uz * d;
  let l = Math.hypot(zx, zy, zz);
  if (l < 1e-5) {
    // Reference parallel to the bone: pick a stable fallback.
    zx = Math.abs(uy) < 0.9 ? 0 : 1; zy = 0; zz = Math.abs(uy) < 0.9 ? 1 : 0;
    d = zx * ux + zy * uy + zz * uz;
    zx -= ux * d; zy -= uy * d; zz -= uz * d;
    l = Math.hypot(zx, zy, zz) || 1;
  }
  zx /= l; zy /= l; zz /= l;
  const xx = uy * zz - uz * zy;
  const xy = uz * zx - ux * zz;
  const xz = ux * zy - uy * zx;

  // Matrix → quaternion (columns x', up, z').
  const m00 = xx, m01 = ux, m02 = zx;
  const m10 = xy, m11 = uy, m12 = zy;
  const m20 = xz, m21 = uz, m22 = zz;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q.w = 0.25 / s; q.x = (m21 - m12) * s; q.y = (m02 - m20) * s; q.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q.w = (m21 - m12) / s; q.x = 0.25 * s; q.y = (m01 + m10) / s; q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q.w = (m02 - m20) / s; q.x = (m01 + m10) / s; q.y = 0.25 * s; q.z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q.w = (m10 - m01) / s; q.x = (m02 + m20) / s; q.y = (m12 + m21) / s; q.z = 0.25 * s;
  }
  return q;
}

/* ------------------------------------------------------------------ */
/* Velocity clipping — the core of "slide along a wall"                */
/* ------------------------------------------------------------------ */

/**
 * Quake-style velocity clip: remove the component of `v` entering the plane and
 * add a small overbounce so the next sweep starts outside it.
 *
 * `overbounce` slightly above 1 is what stops a character re-colliding with the
 * same plane every substep and stalling in a doorway. 1.001 is the classic value.
 */
export function clipVelocity(vx, vy, vz, nx, ny, nz, overbounce, out) {
  const backoff = (vx * nx + vy * ny + vz * nz) * overbounce;
  out.x = vx - nx * backoff;
  out.y = vy - ny * backoff;
  out.z = vz - nz * backoff;
  return out;
}
