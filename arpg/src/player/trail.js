import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';
import { makeAdditiveMaterial } from './appearance.js';

/**
 * MONARCH — the dash trail.
 *
 * A ribbon of violet that persists for a moment after a shadow step, plus a
 * short ground streak. It exists for two reasons beyond looking good:
 *
 *  1. **It communicates i-frames.** The player has to be able to tell, from the
 *     frame alone, that the dash they just pressed made them untouchable. The
 *     trail is at full brightness exactly across the invulnerable window and
 *     fades out with it.
 *  2. **It sells the distance.** A 4.6 m dash resolved in 0.30 s covers most of
 *     the screen; without a trail the hero appears to teleport, and teleporting
 *     reads as a bug the first time a player sees it.
 *
 * ---------------------------------------------------------------------------
 * IMPLEMENTATION
 *
 * One preallocated ribbon of `SEGMENTS` quads whose vertices are rewritten in
 * place every frame — no geometry is ever created or destroyed after init, and
 * the whole thing is a single additive draw call with depth writes off (so it is
 * automatically excluded from render's prepass, which is what we want: a trail
 * must not occlude in AO or appear in SSR).
 *
 * The ribbon is built in WORLD space and the mesh sits at the origin with an
 * identity transform, because a trail that follows the character's transform is
 * not a trail — it is a scarf.
 */

const SEGMENTS = 22;
/** Seconds a sample survives. Slightly longer than the dash so the tail is
 *  still visible when the hero has already recovered. */
const LIFE = 0.42;

export class DashTrail {
  constructor(ctx, scene) {
    this.ctx = ctx;

    // Ring buffer of world-space samples: position, up-axis width, age.
    this.n = SEGMENTS;
    this.px = new Float32Array(this.n);
    this.py = new Float32Array(this.n);
    this.pz = new Float32Array(this.n);
    this.age = new Float32Array(this.n).fill(1e9);
    this.head = 0;
    this.live = 0;

    this.geo = new THREE.BufferGeometry();
    this.geo.name = 'mn.player.dashTrail';
    // Two vertices per sample (left/right edge of the ribbon).
    this._pos = new Float32Array(this.n * 2 * 3);
    this._col = new Float32Array(this.n * 2 * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this._col, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2 + 1, d = (i + 1) * 2;
      idx.push(a, b, c, a, c, d);
    }
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);
    // Fixed, generous bounds: the ribbon is world-space and rebuilt every frame,
    // so a computed bounding sphere would be stale the instant it was made.
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.mat = makeAdditiveMaterial('dashTrail', ELEMENTS.shadow.core, 1.0);
    this.mat.vertexColors = true;
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    this.mesh.userData.mnNoShadow = true;
    this.mesh.userData.mnNoPrepass = true;
    this.mesh.userData.mnGlow = 2.4;
    scene.add(this.mesh);
    ctx.get('render').registerMaterial(this.mat);

    // Ground streak: a stretched quad laid on the floor along the dash line.
    this.streakGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.streakGeo.rotateX(-Math.PI / 2);
    this.streakMat = makeAdditiveMaterial('dashStreak', ELEMENTS.shadow.dark, 0);
    this.streak = new THREE.Mesh(this.streakGeo, this.streakMat);
    this.streak.position.y = 0.02;
    this.streak.frustumCulled = false;
    this.streak.renderOrder = 4;
    this.streak.visible = false;
    this.streak.userData.mnNoShadow = true;
    this.streak.userData.mnNoPrepass = true;
    this.streak.userData.mnGlow = 1.4;
    scene.add(this.streak);
    ctx.get('render').registerMaterial(this.streakMat);

    this._start = new THREE.Vector3();
    this._end = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this.emitting = false;
    this._streakLife = 0;
  }

  /** Begin (or end) laying samples. */
  setEmitting(on, position) {
    if (on && !this.emitting) {
      this.head = 0;
      this.live = 0;
      this.age.fill(1e9);
      this._start.copy(position);
    }
    if (!on && this.emitting) {
      this._end.copy(position);
      this._streakLife = 0.55;
    }
    this.emitting = on;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} pos    world position to sample (chest height)
   * @param {THREE.Vector3} camPos camera position, for the ribbon's facing
   */
  update(dt, pos, camPos) {
    // Age everything, then add a sample if we are emitting.
    let anyLive = false;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] < LIFE) anyLive = true;
    }

    if (this.emitting) {
      this.px[this.head] = pos.x;
      this.py[this.head] = pos.y;
      this.pz[this.head] = pos.z;
      this.age[this.head] = 0;
      this.head = (this.head + 1) % this.n;
      this.live = Math.min(this.n, this.live + 1);
      anyLive = true;
    }

    if (!anyLive) {
      this.mesh.visible = false;
      this._updateStreak(dt);
      return;
    }

    // Rebuild the strip from oldest to newest.
    let w = 0;
    const core = ELEMENTS.shadow.core;
    const hot = ELEMENTS.shadow.glow;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head + k) % this.n;
      const a = this.age[i];
      if (a >= LIFE) continue;
      const t = 1 - a / LIFE;            // 1 = fresh
      // Width tapers to nothing at the tail, so the ribbon is a comet rather
      // than a strip of tape.
      const width = 0.30 * Math.pow(t, 0.55) + 0.02;

      this._dir.set(this.px[i] - camPos.x, this.py[i] - camPos.y, this.pz[i] - camPos.z);
      // Sideways axis: perpendicular to the view direction and to world up, so
      // the ribbon always presents its face to the camera.
      this._side.set(-this._dir.z, 0, this._dir.x);
      const l = this._side.length();
      if (l < 1e-4) this._side.set(1, 0, 0);
      else this._side.multiplyScalar(width / l);

      const o = w * 6;
      this._pos[o] = this.px[i] - this._side.x;
      this._pos[o + 1] = this.py[i] - this._side.y;
      this._pos[o + 2] = this.pz[i] - this._side.z;
      this._pos[o + 3] = this.px[i] + this._side.x;
      this._pos[o + 4] = this.py[i] + this._side.y;
      this._pos[o + 5] = this.pz[i] + this._side.z;

      // The freshest samples are hot violet, the tail is the deep core colour.
      const f = t * t;
      const r = core[0] + (hot[0] - core[0]) * f;
      const g = core[1] + (hot[1] - core[1]) * f;
      const b = core[2] + (hot[2] - core[2]) * f;
      const bright = t * t * 1.4;
      this._col[o] = r * bright; this._col[o + 1] = g * bright; this._col[o + 2] = b * bright;
      this._col[o + 3] = r * bright; this._col[o + 4] = g * bright; this._col[o + 5] = b * bright;
      w++;
    }

    this.mesh.visible = w >= 2;
    this.geo.setDrawRange(0, Math.max(0, (w - 1) * 6));
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;

    this._updateStreak(dt);
  }

  _updateStreak(dt) {
    if (this._streakLife <= 0) {
      this.streak.visible = false;
      return;
    }
    this._streakLife -= dt;
    const t = Math.max(0, this._streakLife / 0.55);
    this._dir.subVectors(this._end, this._start);
    this._dir.y = 0;
    const len = this._dir.length();
    if (len < 0.2) { this.streak.visible = false; return; }
    this.streak.visible = true;
    this.streak.position.set(
      (this._start.x + this._end.x) * 0.5, 0.02, (this._start.z + this._end.z) * 0.5
    );
    this.streak.rotation.y = Math.atan2(this._dir.x, this._dir.z);
    // Widens as it fades: a dissipating smear, not a shrinking line.
    this.streak.scale.set(0.55 + (1 - t) * 0.85, 1, len * 1.05);
    this.streakMat.opacity = t * t * 0.55;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.streakGeo.dispose();
    this.streakMat.dispose();
    this.mesh.removeFromParent();
    this.streak.removeFromParent();
  }
}
