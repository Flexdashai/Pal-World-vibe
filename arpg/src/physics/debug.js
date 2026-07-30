/**
 * debug.js — physics debug visualisation.
 *
 * Everything renders into ONE LineSegments with a preallocated vertex buffer and
 * per-vertex colour. One draw call, no allocation, no material permutations, and
 * it can be switched on and off from `tools/probe.mjs` without touching a file:
 *
 *   node arpg/tools/probe.mjs --port=5284 \
 *     --eval="ctx.peek('physics').setDebug({ bvh: 3, characters: true })"
 *
 * Flags (all default off):
 *   bvh          number  — draw BVH node boxes down to this depth (0 = off)
 *   bvhLeaves    bool    — draw leaf boxes only, coloured by triangle count
 *   tris         bool    — draw the static triangle soup as wireframe (expensive)
 *   characters   bool    — capsules, ground normals, blocked normals
 *   actors       bool    — spatial-hash proxies and the occupied grid cells
 *   bodies       bool    — rigid-body shapes and sleep state
 *   ragdolls     bool    — ragdoll particles and bones
 *   chains       bool    — constraint chains
 *   projectiles  bool    — live projectiles and their velocity vectors
 *   rays         bool    — the last N raycasts issued through the public API
 *   xray         bool    — draw with depthTest off, so it reads through walls
 *
 * The object is only added to the scene when something is enabled, so a shipping
 * frame pays nothing at all for this file.
 */

import * as THREE from 'three';

const MAX_VERTS = 240000; // 120k line segments; more than any sane debug view

/** Colour table, kept desaturated so debug lines never get mistaken for VFX. */
const C = {
  bvh: [0.18, 0.30, 0.42],
  bvhLeaf: [0.22, 0.52, 0.36],
  tri: [0.28, 0.26, 0.24],
  capsule: [0.35, 0.85, 0.55],
  capsuleAir: [0.90, 0.65, 0.20],
  normal: [0.30, 0.70, 1.00],
  blocked: [1.00, 0.25, 0.20],
  actor: [0.55, 0.35, 1.00],
  actorDead: [0.35, 0.20, 0.28],
  cell: [0.16, 0.16, 0.22],
  body: [0.95, 0.75, 0.35],
  bodySleep: [0.34, 0.30, 0.26],
  ragdoll: [1.00, 0.35, 0.45],
  bone: [0.95, 0.80, 0.72],
  chain: [0.60, 0.60, 0.70],
  proj: [0.45, 0.85, 1.00],
  ray: [1.00, 0.90, 0.40],
  rayMiss: [0.40, 0.36, 0.30],
};

export class PhysicsDebug {
  constructor() {
    this.flags = {
      bvh: 0, bvhLeaves: false, tris: false,
      characters: false, actors: false, bodies: false,
      ragdolls: false, chains: false, projectiles: false, rays: false,
      xray: false,
    };
    this.enabled = false;

    this.positions = new Float32Array(MAX_VERTS * 3);
    this.colors = new Float32Array(MAX_VERTS * 3);
    this.vertexCount = 0;

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setDrawRange(0, 0);
    // A generous static sphere: recomputing bounds every frame for a debug view
    // would cost more than the view itself, and culling it is never desirable.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });

    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.name = 'physics:debug';
    this.object.frustumCulled = false;
    this.object.renderOrder = 9000;
    // Keep debug geometry out of every pipeline stage that would be confused by
    // it — the depth/normal prepass, shadows, and the bloom-emissive buffer.
    this.object.userData.mnNoPrepass = true;
    this.object.userData.mnNoShadow = true;
    this.object.visible = false;

    this._scene = null;
    /** Preallocated scratch. Debug is dev-only, but "allocate nothing per frame"
     *  applies here too — a debug view that triggers a GC pause is a debug view
     *  that changes the thing you are trying to measure. */
    this._bvhStack = new Int32Array(4096);   // pairs of (node, depth)
    this._corners = new Float32Array(24);
    /** Ring buffer of recent raycasts, drawn when `rays` is on. */
    this.rayLog = new Float32Array(64 * 8); // ox oy oz  hx hy hz  hit  age
    this.rayLogCount = 0;
    this.rayLogHead = 0;
  }

  attach(scene) {
    this._scene = scene;
    return this;
  }

  set(flags = {}) {
    Object.assign(this.flags, flags);
    const f = this.flags;
    this.enabled = !!(f.bvh || f.bvhLeaves || f.tris || f.characters || f.actors ||
      f.bodies || f.ragdolls || f.chains || f.projectiles || f.rays);
    this.material.depthTest = !f.xray;
    if (this.enabled && this._scene && !this.object.parent) this._scene.add(this.object);
    if (!this.enabled && this.object.parent) this.object.parent.remove(this.object);
    this.object.visible = this.enabled;
    return this.flags;
  }

  /** Record a raycast so `rays` can draw it. Called by the public raycast API. */
  logRay(ox, oy, oz, hx, hy, hz, hit) {
    if (!this.flags.rays) return;
    const i = this.rayLogHead * 8;
    this.rayLog[i] = ox; this.rayLog[i + 1] = oy; this.rayLog[i + 2] = oz;
    this.rayLog[i + 3] = hx; this.rayLog[i + 4] = hy; this.rayLog[i + 5] = hz;
    this.rayLog[i + 6] = hit ? 1 : 0;
    this.rayLog[i + 7] = 0;
    this.rayLogHead = (this.rayLogHead + 1) % 64;
    if (this.rayLogCount < 64) this.rayLogCount++;
  }

  /* ---------------------------------------------------------------- */
  /* Primitive emitters                                                */
  /* ---------------------------------------------------------------- */

  begin() {
    this.vertexCount = 0;
  }

  line(ax, ay, az, bx, by, bz, c) {
    const n = this.vertexCount;
    if (n + 2 > MAX_VERTS) return;
    const p = this.positions, col = this.colors;
    let o = n * 3;
    p[o] = ax; p[o + 1] = ay; p[o + 2] = az;
    col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
    o += 3;
    p[o] = bx; p[o + 1] = by; p[o + 2] = bz;
    col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
    this.vertexCount = n + 2;
  }

  box(mnx, mny, mnz, mxx, mxy, mxz, c) {
    this.line(mnx, mny, mnz, mxx, mny, mnz, c);
    this.line(mxx, mny, mnz, mxx, mny, mxz, c);
    this.line(mxx, mny, mxz, mnx, mny, mxz, c);
    this.line(mnx, mny, mxz, mnx, mny, mnz, c);
    this.line(mnx, mxy, mnz, mxx, mxy, mnz, c);
    this.line(mxx, mxy, mnz, mxx, mxy, mxz, c);
    this.line(mxx, mxy, mxz, mnx, mxy, mxz, c);
    this.line(mnx, mxy, mxz, mnx, mxy, mnz, c);
    this.line(mnx, mny, mnz, mnx, mxy, mnz, c);
    this.line(mxx, mny, mnz, mxx, mxy, mnz, c);
    this.line(mxx, mny, mxz, mxx, mxy, mxz, c);
    this.line(mnx, mny, mxz, mnx, mxy, mxz, c);
  }

  circle(cx, cy, cz, r, axis, c, segments = 16) {
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const s = Math.sin(a) * r, co = Math.cos(a) * r;
      let x, y, z;
      if (axis === 0) { x = cx; y = cy + co; z = cz + s; }
      else if (axis === 1) { x = cx + co; y = cy; z = cz + s; }
      else { x = cx + co; y = cy + s; z = cz; }
      if (i > 0) this.line(px, py, pz, x, y, z, c);
      px = x; py = y; pz = z;
    }
  }

  /** Feet-anchored capsule: two rings, a top/bottom cap, and four verticals. */
  capsule(x, y, z, radius, height, c) {
    const y0 = y + radius;
    const y1 = y + Math.max(radius, height - radius);
    this.circle(x, y0, z, radius, 1, c);
    this.circle(x, y1, z, radius, 1, c);
    this.circle(x, y + height * 0.5, z, radius, 1, c, 12);
    this.line(x + radius, y0, z, x + radius, y1, z, c);
    this.line(x - radius, y0, z, x - radius, y1, z, c);
    this.line(x, y0, z + radius, x, y1, z + radius, c);
    this.line(x, y0, z - radius, x, y1, z - radius, c);
    this.circle(x, y0, z, radius, 0, c, 10);
    this.circle(x, y1, z, radius, 2, c, 10);
    this.line(x, y, z, x, y + height, z, c);
  }

  cross(x, y, z, r, c) {
    this.line(x - r, y, z, x + r, y, z, c);
    this.line(x, y - r, z, x, y + r, z, c);
    this.line(x, y, z - r, x, y, z + r, c);
  }

  /** Oriented box from a position + quaternion + half extents. */
  obb(pos, quat, half, c) {
    const hx = half.x, hy = half.y, hz = half.z;
    const cs = [
      -hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz,
      -hx, hy, -hz, hx, hy, -hz, hx, hy, hz, -hx, hy, hz,
    ];
    const w = this._corners;
    for (let i = 0; i < 8; i++) {
      const vx = cs[i * 3], vy = cs[i * 3 + 1], vz = cs[i * 3 + 2];
      // inline quaternion rotate
      const tx = 2 * (quat.y * vz - quat.z * vy);
      const ty = 2 * (quat.z * vx - quat.x * vz);
      const tz = 2 * (quat.x * vy - quat.y * vx);
      w[i * 3] = pos.x + vx + quat.w * tx + (quat.y * tz - quat.z * ty);
      w[i * 3 + 1] = pos.y + vy + quat.w * ty + (quat.z * tx - quat.x * tz);
      w[i * 3 + 2] = pos.z + vz + quat.w * tz + (quat.x * ty - quat.y * tx);
    }
    const E = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e] * 3, b = E[e + 1] * 3;
      this.line(w[a], w[a + 1], w[a + 2], w[b], w[b + 1], w[b + 2], c);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scene builders                                                    */
  /* ---------------------------------------------------------------- */

  drawBvh(bvh) {
    const f = this.flags;
    if (!bvh || bvh.nodeCount === 0) return;
    const nb = bvh.nodeBounds, nm = bvh.nodeMeta;
    // Iterative DFS on a preallocated stack of (node, depth) pairs.
    const stack = this._bvhStack;
    const cap = stack.length - 4;
    let sp = 0;
    stack[sp++] = 0; stack[sp++] = 0;
    while (sp > 0) {
      const depth = stack[--sp];
      const node = stack[--sp];
      const count = nm[node * 2 + 1];
      const o = node * 6;
      const isLeaf = count > 0;
      if (f.bvhLeaves ? isLeaf : depth <= f.bvh) {
        const c = isLeaf ? C.bvhLeaf : C.bvh;
        this.box(nb[o], nb[o + 1], nb[o + 2], nb[o + 3], nb[o + 4], nb[o + 5], c);
      }
      if (!isLeaf && (f.bvhLeaves || depth < f.bvh) && sp < cap) {
        const left = nm[node * 2];
        stack[sp++] = left; stack[sp++] = depth + 1;
        stack[sp++] = left + 1; stack[sp++] = depth + 1;
      }
    }
  }

  drawTris(bvh) {
    if (!bvh || bvh.triCount === 0) return;
    const p = bvh.pos;
    // Hard cap: 12k triangles is already 36k lines and any more is unreadable.
    const n = Math.min(bvh.triCount, 12000);
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      this.line(p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], C.tri);
      this.line(p[o + 3], p[o + 4], p[o + 5], p[o + 6], p[o + 7], p[o + 8], C.tri);
      this.line(p[o + 6], p[o + 7], p[o + 8], p[o], p[o + 1], p[o + 2], C.tri);
    }
  }

  drawCharacters(controllers) {
    for (const ch of controllers) {
      if (!ch || !ch.enabled) continue;
      const c = ch.grounded ? C.capsule : C.capsuleAir;
      this.capsule(ch.position.x, ch.position.y, ch.position.z, ch.radius, ch.height, c);
      if (ch.grounded) {
        this.line(
          ch.position.x, ch.position.y, ch.position.z,
          ch.position.x + ch.groundNormal.x * 0.6,
          ch.position.y + ch.groundNormal.y * 0.6,
          ch.position.z + ch.groundNormal.z * 0.6,
          C.normal
        );
      }
      if (ch.blocked) {
        const y = ch.position.y + ch.height * 0.5;
        this.line(
          ch.position.x, y, ch.position.z,
          ch.position.x + ch.blockedNormal.x * 0.8, y + ch.blockedNormal.y * 0.8,
          ch.position.z + ch.blockedNormal.z * 0.8, C.blocked
        );
      }
    }
  }

  drawActors(hash) {
    if (!hash) return;
    const cell = hash.cell;
    for (let i = 0; i < hash.count; i++) {
      const a = hash.actors[i];
      if (!a) continue;
      const c = hash.live[i] ? C.actor : C.actorDead;
      this.circle(hash.px[i], hash.py[i] + 0.02, hash.pz[i], hash.radius[i], 1, c, 14);
      this.line(hash.px[i], hash.py[i], hash.pz[i],
        hash.px[i], hash.py[i] + hash.height[i], hash.pz[i], c);
      if (this.flags.actors === 'cells') {
        const gx = hash.cx[i] * cell, gz = hash.cz[i] * cell;
        this.box(gx, hash.py[i], gz, gx + cell, hash.py[i] + 0.02, gz + cell, C.cell);
      }
    }
  }

  drawBodies(bodyWorld) {
    if (!bodyWorld) return;
    for (let i = 0; i < bodyWorld.capacity; i++) {
      const b = bodyWorld.bodies[i];
      if (!b.active) continue;
      const c = b.sleeping ? C.bodySleep : C.body;
      if (b.shape === 'sphere') {
        this.circle(b.position.x, b.position.y, b.position.z, b.radius, 1, c, 12);
        this.circle(b.position.x, b.position.y, b.position.z, b.radius, 0, c, 12);
      } else {
        this.obb(b.position, b.quaternion, b.half, c);
      }
    }
  }

  drawRagdolls(ragWorld) {
    if (!ragWorld) return;
    for (let i = 0; i < ragWorld.capacity; i++) {
      const d = ragWorld.dolls[i];
      if (!d.active) continue;
      for (let p = 0; p < d.px.length; p++) {
        this.cross(d.px[p], d.py[p], d.pz[p], d.pradius[p], d.settled ? C.bodySleep : C.ragdoll);
      }
      for (const bone of d.bones) {
        const hx = bone.length * 0.5;
        // Bone axis is local +Y under `quaternion`.
        const q = bone.quaternion;
        const vx = 0, vy = hx, vz = 0;
        const tx = 2 * (q.y * vz - q.z * vy);
        const ty = 2 * (q.z * vx - q.x * vz);
        const tz = 2 * (q.x * vy - q.y * vx);
        const ex = vx + q.w * tx + (q.y * tz - q.z * ty);
        const ey = vy + q.w * ty + (q.z * tx - q.x * tz);
        const ez = vz + q.w * tz + (q.x * ty - q.y * tx);
        this.line(
          bone.position.x - ex, bone.position.y - ey, bone.position.z - ez,
          bone.position.x + ex, bone.position.y + ey, bone.position.z + ez,
          C.bone
        );
      }
    }
  }

  drawChains(constraintWorld) {
    if (!constraintWorld) return;
    for (let i = 0; i < constraintWorld.capacity; i++) {
      const c = constraintWorld.chains[i];
      if (!c.active) continue;
      for (let p = 0; p < c.count - 1; p++) {
        this.line(c.px[p], c.py[p], c.pz[p], c.px[p + 1], c.py[p + 1], c.pz[p + 1], C.chain);
      }
      this.cross(c.anchor.x, c.anchor.y, c.anchor.z, 0.08, C.chain);
    }
  }

  drawProjectiles(projWorld) {
    if (!projWorld) return;
    for (let i = 0; i < projWorld.capacity; i++) {
      const p = projWorld.list[i];
      if (!p.active) continue;
      this.cross(p.position.x, p.position.y, p.position.z, p.radius, C.proj);
      this.line(
        p.position.x, p.position.y, p.position.z,
        p.position.x + p.velocity.x * 0.06,
        p.position.y + p.velocity.y * 0.06,
        p.position.z + p.velocity.z * 0.06,
        C.proj
      );
    }
  }

  drawRays() {
    for (let i = 0; i < this.rayLogCount; i++) {
      const o = i * 8;
      const c = this.rayLog[o + 6] ? C.ray : C.rayMiss;
      this.line(
        this.rayLog[o], this.rayLog[o + 1], this.rayLog[o + 2],
        this.rayLog[o + 3], this.rayLog[o + 4], this.rayLog[o + 5], c
      );
      if (this.rayLog[o + 6]) {
        this.cross(this.rayLog[o + 3], this.rayLog[o + 4], this.rayLog[o + 5], 0.06, C.ray);
      }
    }
  }

  /** Push the accumulated vertices to the GPU. */
  end() {
    this.geometry.setDrawRange(0, this.vertexCount);
    if (this.vertexCount > 0) {
      // Upload only the vertices we actually wrote. The backing arrays are 2.8 MB
      // each; on a software rasteriser a full re-upload every frame would cost
      // more than the debug view is worth. Ranges must be cleared first or they
      // accumulate one entry per frame forever.
      this.posAttr.clearUpdateRanges();
      this.colAttr.clearUpdateRanges();
      this.posAttr.addUpdateRange(0, this.vertexCount * 3);
      this.colAttr.addUpdateRange(0, this.vertexCount * 3);
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
  }

  dispose() {
    if (this.object.parent) this.object.parent.remove(this.object);
    this.geometry.dispose();
    this.material.dispose();
    this._scene = null;
  }
}
