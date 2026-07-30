import * as THREE from 'three';
import { TUNE } from './tuning.js';

/**
 * Punctual light budget and the fixed slot mechanism.
 *
 * ARCHITECTURE.md documents the trap: three bakes the number of VISIBLE lights
 * of each type into every lit material's program cache key. One brazier crossing
 * a cull radius therefore recompiles every material in the scene — measured on
 * the sibling project at +33 programs and 640-900 ms on that single frame. In a
 * game whose whole combat loop spawns and kills light sources, that is not an
 * edge case, it is every fight.
 *
 * The fix has to live in ONE place or it will be got wrong. It lives here:
 *
 *  - The renderer owns a fixed number of slots per light type, decided once,
 *    before the first material compiles, and never changed afterwards.
 *  - Ballast lights (intensity exactly 0) are parked in the scene and made
 *    visible or invisible so that `visible count == slots` on EVERY frame,
 *    whatever gameplay is doing. A light whose colour x intensity is 0 adds a
 *    float 0.0 into the irradiance accumulator, so extra lit slots cannot move a
 *    pixel — they only cost ALU.
 *  - Real lights beyond the budget are hidden, chosen by their actual
 *    contribution at the camera focus, so what gets dropped is always the light
 *    that was contributing least.
 *
 * `world` and `fx` cannot get this wrong because they do not participate: every
 * light in the scene is discovered automatically during `_collect`, whether or
 * not anybody remembered to call `addLight`.
 */

const TYPES = ['point', 'spot', 'dir', 'hemi'];

function typeOf(light) {
  if (light.isPointLight) return 'point';
  if (light.isSpotLight) return 'spot';
  if (light.isDirectionalLight) return 'dir';
  if (light.isHemisphereLight) return 'hemi';
  return null;
}

export class LightBudget {
  constructor(config) {
    this.config = config;
    this.maxPointSlots = Math.max(
      TUNE.lights.minSlots,
      Math.min(TUNE.lights.maxSlots, Math.round(config.q.maxLights * TUNE.lights.slotFraction))
    );

    /** Slot counts. Frozen by `freeze()` before the first material compiles. */
    this.slots = { point: TUNE.lights.minSlots, spot: 0, dir: TUNE.lights.dirSlots, hemi: 1 };
    this.frozen = false;

    this.registered = new Set();
    this.ballast = { point: [], spot: [], dir: [], hemi: [] };
    this.group = new THREE.Group();
    this.group.name = 'mn.lightBallast';
    this.group.matrixAutoUpdate = false;

    /** Scratch, reused every frame. */
    this._focus = new THREE.Vector3();
    this._lightPos = new THREE.Vector3();
    this._sortable = [];
    this._counts = { point: 0, spot: 0, dir: 0, hemi: 0 };
    this._visible = { point: 0, spot: 0, dir: 0, hemi: 0 };
    // Bound once: `Array.sort` takes a comparator, and building a closure over
    // the focus point every frame is a per-frame allocation.
    this._cmp = (a, b) => scoreOf(b, this._focus, this._lightPos) - scoreOf(a, this._focus, this._lightPos);
  }

  attach(scene) {
    scene.add(this.group);
  }

  /** Register a light. Idempotent, and safe to call for a light already in the
   *  scene — discovery calls it too. */
  add(light) {
    if (!light || this.registered.has(light)) return light;
    // Ballast lives in the scene, so scene discovery finds it too; it must never
    // be treated as a real light or the slot arithmetic double-counts.
    if (light.userData._mnBallast) return light;
    const t = typeOf(light);
    if (!t) return light;

    this.registered.add(light);
    const ud = light.userData;
    ud._mnOwnerVisible = light.visible;
    ud._mnSetVisible = light.visible;

    // A spot light appearing at all forces the spot slot count open. Doing it
    // once, at registration, keeps the recompile at load time instead of during
    // a fight — but a spot light created at runtime WILL cost one recompile, so
    // prefer point lights.
    if (t === 'spot' && this.slots.spot === 0) {
      this.slots.spot = TUNE.lights.spotSlots;
      if (this.frozen) {
        console.warn('[render] a spot light was registered after the light slot count was frozen; ' +
                     'this costs one full material recompile. Create spot lights during init().');
      }
      this._syncBallast();
    }
    return light;
  }

  remove(light) {
    this.registered.delete(light);
  }

  /**
   * Decide the final slot counts from what actually exists, then build the
   * ballast. Called from `prewarmMaterials`, i.e. after every subsystem's
   * `init()` has run and before anything has been drawn.
   */
  freeze(scene) {
    this.discover(scene);

    const counts = { point: 0, spot: 0, dir: 0, hemi: 0 };
    for (const l of this.registered) counts[typeOf(l)]++;

    // Headroom of 3 point slots for the lights combat and fx spawn (explosion
    // flashes, spell cores, the shadow-extraction rift), clamped by the quality
    // budget. Under-allocating means a light gets dropped, which is invisible;
    // over-allocating costs ALU on every lit pixel forever, which is not.
    this.slots.point = Math.max(
      TUNE.lights.minSlots,
      Math.min(this.maxPointSlots, counts.point + 3)
    );
    this.slots.dir = Math.max(TUNE.lights.dirSlots, counts.dir);
    this.slots.hemi = Math.max(1, counts.hemi);
    if (counts.spot > 0) this.slots.spot = Math.max(TUNE.lights.spotSlots, counts.spot);

    this._syncBallast();
    this.frozen = true;
    return { ...this.slots };
  }

  /** Walk the scene and register anything punctual we have not seen. Cheap:
   *  one Set lookup per light, and there are a handful of lights. */
  discover(scene) {
    scene.traverse((o) => { if (o.isLight) this.add(o); });
  }

  _syncBallast() {
    for (const t of TYPES) {
      const list = this.ballast[t];
      while (list.length < this.slots[t]) {
        const l = this._makeBallast(t);
        list.push(l);
        this.group.add(l);
      }
      while (list.length > this.slots[t]) {
        const l = list.pop();
        this.group.remove(l);
        l.dispose?.();
      }
    }
  }

  _makeBallast(type) {
    let l;
    if (type === 'point') l = new THREE.PointLight(0x000000, 0, 0.01, 2);
    else if (type === 'spot') l = new THREE.SpotLight(0x000000, 0, 0.01, 0.2, 0.5, 2);
    else if (type === 'dir') l = new THREE.DirectionalLight(0x000000, 0);
    else l = new THREE.HemisphereLight(0x000000, 0x000000, 0);
    l.name = `mn.ballast.${type}`;
    l.userData._mnBallast = true;
    l.intensity = 0;
    l.castShadow = false;
    l.visible = false;
    l.matrixAutoUpdate = false;
    // Park them well outside any room so a nonzero intensity written by mistake
    // could not light anything either.
    l.position.set(0, -1000, 0);
    l.updateMatrix();
    l.updateMatrixWorld(true);
    return l;
  }

  /**
   * Per-frame: choose which real lights are visible and top the counts up with
   * ballast. Must run every frame, before the scene is rendered.
   */
  update(focus) {
    this._focus.copy(focus);

    for (const t of TYPES) { this._counts[t] = 0; this._visible[t] = 0; }

    // --- rank the point/spot lights by their contribution at the focus -------
    const sortable = this._sortable;
    sortable.length = 0;

    for (const light of this.registered) {
      const t = typeOf(light);
      if (!t) continue;
      // A light `fx` spawned for an explosion and then removed from the scene
      // must leave the registry, or the slot budget stays permanently allocated
      // to something that no longer exists and the real lights get culled.
      if (light.parent === null) { this.registered.delete(light); continue; }
      const ud = light.userData;

      // Detect an owner-driven visibility change: anything that does not match
      // what we wrote last frame is the owner's intent and must be respected.
      if (ud._mnSetVisible === undefined || light.visible !== ud._mnSetVisible) {
        ud._mnOwnerVisible = light.visible;
      }

      this._counts[t]++;

      if (t === 'point' || t === 'spot') {
        sortable.push(light);
      } else {
        // Directional and hemisphere lights are global; they are never culled.
        const want = ud._mnOwnerVisible !== false;
        const show = want && this._visible[t] < this.slots[t];
        light.visible = show;
        ud._mnSetVisible = show;
        if (show) this._visible[t]++;
      }
    }

    // Contribution heuristic: inverse-square falloff, hard zero beyond the
    // light's own cull distance. Sorting by this means the light we drop is
    // always the one already contributing least, so the cut is invisible.
    sortable.sort(this._cmp);

    for (let i = 0; i < sortable.length; i++) {
      const light = sortable[i];
      const t = typeOf(light);
      const want = light.userData._mnOwnerVisible !== false;
      const show = want && this._visible[t] < this.slots[t] && light.intensity > 0;
      light.visible = show;
      light.userData._mnSetVisible = show;
      if (show) this._visible[t]++;
    }

    // --- top up with ballast so the visible count is EXACTLY the slot count --
    for (const t of TYPES) {
      const list = this.ballast[t];
      const need = this.slots[t] - this._visible[t];
      for (let i = 0; i < list.length; i++) list[i].visible = i < need;
    }
  }

  stats() {
    return {
      slots: { ...this.slots },
      registered: this.registered.size,
      visible: { ...this._visible },
      present: { ...this._counts },
    };
  }

  dispose() {
    for (const t of TYPES) {
      for (const l of this.ballast[t]) { this.group.remove(l); l.dispose?.(); }
      this.ballast[t].length = 0;
    }
    this.group.parent?.remove(this.group);
    this.registered.clear();
  }
}

function scoreOf(light, focus, tmp) {
  tmp.setFromMatrixPosition(light.matrixWorld);
  const d2 = tmp.distanceToSquared(focus);
  const cull = light.distance ?? 0;
  if (cull > 0 && d2 > cull * cull) return -1;
  return light.intensity / (1 + d2);
}
