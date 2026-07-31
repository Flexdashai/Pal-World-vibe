/**
 * MONARCH — the shadow spear.
 *
 * A ranged skill needs three things to read at 21 m: a BODY with a silhouette
 * (a lance, not a ball), a TRAIL so the eye can track it across the room, and a
 * light so it illuminates what it passes. All three are here; the flight itself
 * belongs to `physics.spawnProjectile`, which owns the swept collision.
 *
 * ---------------------------------------------------------------------------
 * THE TRAIL
 *
 * A ribbon built from a ring buffer of the last 16 positions, billboarded to the
 * camera each frame and tapered from full width at the head to nothing at the
 * tail. Two things make it read as motion rather than as a tube:
 *
 *   - the width taper is CUBIC, so the ribbon is a spike not a sausage;
 *   - the brightness taper is on a different curve from the width, so the trail
 *     goes from white at the head through violet in the middle to nothing.
 *
 * The ring buffer is filled from the projectile's real position every frame, so
 * an arc from gravity or a ricochet is drawn exactly as it happened.
 */

import * as THREE from 'three';
import { VFX, GLOW, clamp01 } from './tuning.js';
import { makeSpellMaterial, tagEffect, buildLance, elementRgb } from './fxkit.js';
import { ELEMENTS } from '../core/palette.js';

/** Concurrent spears in flight. Four: the skill fires one, but the shot harness
 *  poses a volley and a future rank of the skill will fire three. */
const SPEAR_SLOTS = 4;
/** Trail samples. 16 at 60 Hz is 0.27 s of history, which at 34 m/s is a 9 m
 *  ribbon — long enough to cross a room, short enough not to lag behind the
 *  head when the spear turns. */
const TRAIL_SEGMENTS = 16;

export class SpearVolley {
  constructor(ctx, rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.name = 'mn.combat.spears';
    ctx.scene.add(this.group);

    this._geo = [];
    this._mat = [];
    const render = ctx.peek('render');

    this.lanceGeo = buildLance(1.55, 0.115, 6);
    this._geo.push(this.lanceGeo);

    this.slots = [];
    for (let i = 0; i < SPEAR_SLOTS; i++) {
      const bodyMat = makeSpellMaterial(`spearBody${i}`, ELEMENTS.shadow.glow, { opacity: 1 });
      const trailMat = makeSpellMaterial(`spearTrail${i}`, ELEMENTS.shadow.core, { opacity: 1 });
      this._mat.push(bodyMat, trailMat);
      render?.registerMaterial?.(bodyMat);
      render?.registerMaterial?.(trailMat);

      const body = new THREE.Mesh(this.lanceGeo, bodyMat);
      body.name = `mn.combat.spear${i}`;
      tagEffect(body, GLOW.core, 10);

      // Trail geometry: a strip of TRAIL_SEGMENTS quads, rewritten each frame.
      const verts = TRAIL_SEGMENTS * 2;
      const pos = new Float32Array(verts * 3);
      const col = new Float32Array(verts * 3);
      const idx = new Uint16Array((TRAIL_SEGMENTS - 1) * 6);
      for (let s = 0; s < TRAIL_SEGMENTS - 1; s++) {
        const v = s * 2, o = s * 6;
        idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 3;
        idx[o + 3] = v; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
      }
      const tg = new THREE.BufferGeometry();
      tg.name = `mn.combat.spearTrail${i}`;
      tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      tg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      tg.setIndex(new THREE.BufferAttribute(idx, 1));
      tg.setDrawRange(0, 0);
      this._geo.push(tg);

      const trail = new THREE.Mesh(tg, trailMat);
      trail.name = `mn.combat.spearTrailMesh${i}`;
      tagEffect(trail, GLOW.trail, 9);

      this.group.add(body, trail);
      this.slots.push({
        body, trail, bodyMat, trailMat, geo: tg,
        pos, col,
        used: false,
        /** Ring buffer of world positions, newest at `head`. */
        hx: new Float32Array(TRAIL_SEGMENTS),
        hy: new Float32Array(TRAIL_SEGMENTS),
        hz: new Float32Array(TRAIL_SEGMENTS),
        filled: 0,
        head: 0,
        fade: 0,          // >0 while the trail dissolves after the spear is gone
        element: 'shadow',
        width: 0.24,
      });
    }

    this._right = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._toCam = new THREE.Vector3();
    this._frozen = false;

    this.lightX = 0; this.lightY = 0; this.lightZ = 0;
    this.lightPeak = 0;
    this.lightColour = ELEMENTS.shadow.light;
  }

  /**
   * Claim a slot for a new spear and return the mesh `physics` should drive.
   * The caller passes the returned mesh as `spawnProjectile({ mesh })`.
   */
  acquire(x, y, z, element) {
    let slot = this.slots.find(free) ?? this.slots[0];
    slot.used = true;
    slot.fade = 0;
    slot.filled = 0;
    slot.head = 0;
    slot.element = element;
    slot.body.visible = true;
    slot.body.position.set(x, y, z);
    slot.trail.visible = false;
    slot.geo.setDrawRange(0, 0);

    const glow = elementRgb(element, 'glow', 1.35);
    slot.bodyMat.color.setRGB(glow[0], glow[1], glow[2], THREE.LinearSRGBColorSpace);
    slot.bodyMat.opacity = 1;
    const core = elementRgb(element, 'core', 1.0);
    slot.trailMat.color.setRGB(core[0], core[1], core[2], THREE.LinearSRGBColorSpace);
    slot.trailMat.opacity = 1;

    // Seed the whole history at the muzzle so the first frame draws a point
    // rather than a ribbon stretching back to the world origin.
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      slot.hx[i] = x; slot.hy[i] = y; slot.hz[i] = z;
    }
    slot.filled = 1;
    return slot;
  }

  /** Release a slot when the projectile expires or lands. The trail keeps
   *  drawing for `trailLife` seconds and dissolves from the tail forward, which
   *  is what a real trail does — it does not vanish with its emitter. */
  release(slot) {
    if (!slot) return;
    slot.body.visible = false;
    slot.fade = VFX.spear.trailLife;
  }

  /** Muzzle flare + light when a spear is thrown. */
  launch(slot, x, y, z, motes) {
    this.lightX = x; this.lightY = y; this.lightZ = z;
    this.lightPeak = 14;
    this.lightColour = ELEMENTS[slot?.element]?.light ?? ELEMENTS.shadow.light;
    if (!motes) return;
    const rng = this.rng;
    for (let i = 0; i < 14; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = rng.range(0.05, 0.32);
      motes.spawn(
        x + Math.cos(a) * r, y + rng.range(-0.2, 0.2), z + Math.sin(a) * r,
        rng.range(-2.2, 2.2), rng.range(-0.6, 2.2), rng.range(-2.2, 2.2),
        rng.range(0.20, 0.55), rng.range(0.02, 0.05), rng.range(0.8, 1.6),
        { gravity: -3.5, drag: 3.0 }
      );
    }
  }

  /**
   * Rebuild every live trail. Called once per frame with the camera, because
   * the ribbon is billboarded and there is no cheaper way to make a strip of
   * quads face the eye.
   */
  update(dt, camera) {
    const step = this._frozen ? 0 : dt;
    let anyLive = false;

    for (const s of this.slots) {
      if (!s.used) continue;

      // Push the current head position into the ring buffer. Frozen (posed for
      // a shot) means the ribbon holds its shape rather than collapsing onto a
      // single point over the settle frames.
      if (s.body.visible && !this._frozen) {
        s.head = (s.head + 1) % TRAIL_SEGMENTS;
        s.hx[s.head] = s.body.position.x;
        s.hy[s.head] = s.body.position.y;
        s.hz[s.head] = s.body.position.z;
        if (s.filled < TRAIL_SEGMENTS) s.filled++;
      }

      if (s.fade > 0) {
        s.fade -= step;
        if (s.fade <= 0) {
          s.used = false;
          s.trail.visible = false;
          s.geo.setDrawRange(0, 0);
          continue;
        }
      }
      anyLive = true;

      const fadeA = s.fade > 0 ? clamp01(s.fade / VFX.spear.trailLife) : 1;
      this._buildRibbon(s, camera, fadeA);
    }

    if (this.lightPeak > 0 && !this._frozen) {
      // The muzzle light decays fast; the in-flight light is handled by
      // `lightIntensity` reading the live head position.
      this.lightPeak *= Math.exp(-step * 7.5);
      if (this.lightPeak < 0.05) this.lightPeak = 0;
    }
    void anyLive;
  }

  _buildRibbon(s, camera, fadeA) {
    const n = s.filled;
    if (n < 2) { s.trail.visible = false; s.geo.setDrawRange(0, 0); return; }
    const pos = s.pos, col = s.col;

    for (let i = 0; i < n; i++) {
      // i = 0 is the head (newest), i = n-1 the tail.
      const idx = (s.head - i + TRAIL_SEGMENTS * 2) % TRAIL_SEGMENTS;
      const x = s.hx[idx], y = s.hy[idx], z = s.hz[idx];

      // Direction along the ribbon, for the side vector.
      const nIdx = (s.head - Math.min(i + 1, n - 1) + TRAIL_SEGMENTS * 2) % TRAIL_SEGMENTS;
      this._fwd.set(s.hx[nIdx] - x, s.hy[nIdx] - y, s.hz[nIdx] - z);
      if (this._fwd.lengthSq() < 1e-8) this._fwd.set(0, 0, 1);
      this._toCam.set(camera.position.x - x, camera.position.y - y, camera.position.z - z);
      this._side.crossVectors(this._fwd, this._toCam);
      if (this._side.lengthSq() < 1e-10) this._side.set(1, 0, 0);
      this._side.normalize();

      const t = i / (n - 1);
      // Cubic width taper: a spike, not a sausage.
      const w = s.width * Math.pow(1 - t, 3.0) * (0.35 + 0.65 * fadeA);
      // Brightness on a DIFFERENT curve from the width, so the ribbon reads as
      // white at the head, violet through the middle and gone at the tail.
      const b = Math.pow(1 - t, 1.35) * fadeA;

      const v = i * 6;
      pos[v] = x - this._side.x * w; pos[v + 1] = y - this._side.y * w; pos[v + 2] = z - this._side.z * w;
      pos[v + 3] = x + this._side.x * w; pos[v + 4] = y + this._side.y * w; pos[v + 5] = z + this._side.z * w;
      col[v] = b; col[v + 1] = b; col[v + 2] = b;
      col[v + 3] = b; col[v + 4] = b; col[v + 5] = b;
    }

    s.trail.visible = true;
    s.geo.setDrawRange(0, (n - 1) * 6);
    s.geo.attributes.position.needsUpdate = true;
    s.geo.attributes.color.needsUpdate = true;
  }

  /** The light a spear carries with it. Reads the live head of whichever slot
   *  is closest to the camera focus, so a spear crossing a dark room lights the
   *  floor under it. */
  lightIntensity() {
    let best = 0;
    for (const s of this.slots) {
      if (!s.used || !s.body.visible) continue;
      best = 9.0;
      this.lightX = s.body.position.x;
      this.lightY = s.body.position.y;
      this.lightZ = s.body.position.z;
      this.lightColour = ELEMENTS[s.element]?.light ?? ELEMENTS.shadow.light;
    }
    return Math.max(best, this.lightPeak);
  }

  setFrozen(v) { this._frozen = !!v; }

  clear() {
    for (const s of this.slots) {
      s.used = false;
      s.fade = 0;
      s.filled = 0;
      s.body.visible = false;
      s.trail.visible = false;
      s.geo.setDrawRange(0, 0);
    }
    this.lightPeak = 0;
  }

  dispose() {
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this.group.removeFromParent();
  }
}

function free(s) { return !s.used; }
