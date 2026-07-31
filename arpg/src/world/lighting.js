import * as THREE from 'three';
import { LIGHTS } from '../core/palette.js';
import { LIGHTING, AMBIENT, clamp } from './tuning.js';

/**
 * MONARCH — the level's practicals.
 *
 * ---------------------------------------------------------------------------
 * THE POINT-LIGHT PERMUTATION RULE, AND HOW THIS FILE OBEYS IT
 *
 * ARCHITECTURE.md: three bakes the number of VISIBLE point lights into every lit
 * material's program cache key, so one brazier crossing a cull radius recompiles
 * the whole scene. `render`'s `LightBudget` solves it centrally by freezing a
 * slot count before the first compile and topping the visible count up with
 * zero-intensity ballast every frame.
 *
 * What THIS file has to do to stay inside that contract is precise, and it is
 * not obvious:
 *
 *  1. Every light is parented to ONE always-visible group, never to a room
 *     group. Room streaming sets `group.visible = false`, and three's
 *     `projectObject` skips an invisible subtree entirely — so a light inside a
 *     streamed-out room would be counted as visible by the budget (it sets
 *     `light.visible = true`) but would never reach the renderer. The real count
 *     would then be below the slot count and every material would recompile on
 *     the frame a room streamed out. Lights live in a flat group; culling is the
 *     budget's job and it does it by contribution, which is strictly better than
 *     by room anyway.
 *
 *  2. Nothing here creates a light after `init()`. `LightBudget.freeze()` runs
 *     during pre-warm, after every subsystem's `init()`, so all of ours are
 *     counted before the count is fixed.
 *
 *  3. No point light casts a shadow. A shadow-casting point light is a CUBE map
 *     — six renders of the scene per light per frame — and this container has no
 *     GPU. The key shadow comes from `sky`'s single directional; contact
 *     darkening comes from render's GTAO; and the geometry is built with real
 *     recesses so there is something for the AO to find.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT IS ART DIRECTION
 *
 * "Never lay down uniform coverage. Darkness between lights is what makes the
 * lit parts read." The classes below exist so a room can have a bonfire, a
 * hearth and a candle in it that differ by more than an order of magnitude:
 *
 *   brazierGreat  35 cd  r 13    a signpost. Two or three per room, never more.
 *   brazier       26 cd  r 11    the workhorse.
 *   sconce        12 cd   r 5.5  rakes a wall plane or a pier shaft; lights
 *                                nothing beyond about two metres.
 *   candle         3.2 cd r 4    a warm point for the eye, not illumination.
 *   moonPool       3.2 cd r 22   COLD, wide, low fill under a hole in the roof.
 *   shadowRift    10 cd   r 9    the shrine's violet, the signature colour.
 *
 * The cold `moonPool` class is doing double duty: it and the hemisphere fill are
 * the only lights in the game that are not fire, so they are what keeps the
 * frame's luminance-weighted saturation down. Adding cold light lowers it;
 * removing warm light would too, but it would also remove the art direction.
 * Measured across the rewrite: 0.346 -> 0.271 against a 0.30 target.
 */

/** Class table. `gain` multiplies the palette intensity; `radius` overrides it. */
const CLASSES = {
  brazierGreat: { base: 'brazier', gain: LIGHTING.gainGreat, radius: 13.0, flicker: 1.0, cold: false },
  brazier: { base: 'brazier', gain: LIGHTING.gainStandard, radius: 11.0, flicker: 1.0, cold: false },
  sconce: { base: 'brazier', gain: LIGHTING.gainSconce, radius: 5.5, flicker: 1.25, cold: false },
  candle: { base: 'candle', gain: LIGHTING.gainCandle, radius: 4.0, flicker: 1.6, cold: false },
  moonPool: { base: 'moon', gain: 1.0, radius: LIGHTING.moonPool.radius, flicker: 0.0, cold: true },
  shadowRift: { base: 'shadowRift', gain: 0.55, radius: 9.0, flicker: 0.4, cold: true },
};

function paletteFor(base) {
  if (base === 'moon') {
    return { color: LIGHTS.moon.color, intensity: LIGHTING.moonPool.intensity };
  }
  const p = LIGHTS[base] ?? LIGHTS.brazier;
  return { color: p.color, intensity: p.intensity };
}

export class Practicals {
  /**
   * @param {THREE.Object3D} parent  an ALWAYS-VISIBLE node (see the header)
   * @param {object} render          the render subsystem
   */
  constructor(parent, render) {
    this.render = render;
    this.group = new THREE.Group();
    this.group.name = 'mn.world.practicals';
    this.group.matrixAutoUpdate = false;
    parent.add(this.group);

    /** { light, base, phase, rate, amp, kind } — the flicker driver's state. */
    this.entries = [];
    this._gain = 1.0;
    this._counts = {};

    // ---- the one bounce-fill hemisphere light ------------------------------
    // See tuning.js AMBIENT for why this is a hemisphere light, why there is
    // exactly one, and why it costs no shader permutation. In short: it lands in
    // `reflectedLight.indirectDiffuse`, which is the term render's GTAO patch
    // multiplies, so it is fill that respects occlusion; and `LightBudget`
    // already reserves one hemisphere slot filled by ballast, so replacing the
    // ballast with a real light changes no visible count.
    const sky = new THREE.Color().setRGB(
      LIGHTS.moon.color[0], LIGHTS.moon.color[1], LIGHTS.moon.color[2], THREE.LinearSRGBColorSpace
    );
    // Ground half: the cold bounce warmed toward firelight, because a crypt
    // floor is lit by braziers and everything facing down sees that floor.
    const ground = new THREE.Color().setRGB(
      LIGHTS.moonBounce.color[0], LIGHTS.moonBounce.color[1], LIGHTS.moonBounce.color[2],
      THREE.LinearSRGBColorSpace
    ).lerp(
      new THREE.Color().setRGB(
        LIGHTS.brazier.color[0], LIGHTS.brazier.color[1], LIGHTS.brazier.color[2],
        THREE.LinearSRGBColorSpace
      ),
      AMBIENT.groundWarmth
    );
    this.fill = new THREE.HemisphereLight(sky, ground, AMBIENT.base);
    this.fill.name = 'mn.world.bounceFill';
    this.fill.position.set(0, 1, 0);
    this.fill.matrixAutoUpdate = false;
    this.fill.updateMatrix();
    this.fill.updateMatrixWorld(true);
    this.group.add(this.fill);
    render?.addLight?.(this.fill);

    this._fillTarget = AMBIENT.base;
    this._fillNow = AMBIENT.base;
  }

  /** Jump the bounce fill to its target with no cross-fade. Used once at level
   *  load, and by the capture harness, so a screenshot never catches the fade. */
  snapFill() { this._fillNow = this._fillTarget; this.fill.intensity = this._fillNow * this._gain; }

  /** Retarget the bounce fill for a room kind. Cross-faded in `update`. */
  setRoomFill(kind) {
    const k = AMBIENT.perKind[kind] ?? 0.5;
    this._fillTarget = AMBIENT.base * k;
    return this._fillTarget;
  }

  /**
   * Create every light the builders asked for.
   *
   * @param {Array} specs  { kind, x, y, z, phase, rate }
   * @param {Array<[number,number]>} landmarks  keep-out points; a practical on
   *   top of a debug landmark puts a blown-out emitter in the middle of every
   *   review shot, which is exactly what the shot harness is for.
   */
  createAll(specs, landmarks) {
    for (const s of specs) {
      const cls = CLASSES[s.kind] ?? CLASSES.brazier;
      // Landmark clearance. Only for real sources — a cold fill pool has no
      // visible emitter and may sit anywhere.
      if (!cls.cold && landmarks) {
        let blocked = false;
        for (const L of landmarks) {
          if (Math.hypot(s.x - L[0], s.z - L[2]) < LIGHTING.landmarkClear) { blocked = true; break; }
        }
        if (blocked) continue;
      }

      const p = paletteFor(cls.base);
      const light = new THREE.PointLight(
        new THREE.Color().setRGB(p.color[0], p.color[1], p.color[2], THREE.LinearSRGBColorSpace),
        p.intensity * cls.gain,
        cls.radius,
        2
      );
      light.name = `mn.world.light.${s.kind}`;
      light.position.set(s.x, s.y, s.z);
      // The budget reads `matrixWorld` every frame to rank lights; with
      // auto-update off it has to be baked once, here.
      light.matrixAutoUpdate = false;
      light.updateMatrix();
      light.updateMatrixWorld(true);
      // Never. See the header — a cube shadow map on a software rasteriser is
      // six scene renders per light per frame.
      light.castShadow = false;
      this.group.add(light);
      this.render?.addLight?.(light);

      this.entries.push({
        light,
        kind: s.kind,
        base: p.intensity * cls.gain,
        amp: cls.flicker,
        phase: s.phase ?? 0,
        rate: s.rate ?? 1,
      });
      this._counts[s.kind] = (this._counts[s.kind] ?? 0) + 1;
    }
    return this.entries.length;
  }

  /**
   * Flicker.
   *
   * Three incommensurate sines summed. NOT per-frame random: random flicker
   * strobes (successive frames are uncorrelated, so the eye sees a buzz rather
   * than a flame) and it is not reproducible, which would make every capture of
   * the same frame index different.
   *
   * Driven from `time.elapsed`, which is the SCALED clock, so hit-stop freezes
   * the fire along with everything else. A flame that keeps guttering through a
   * freeze frame is the most common tell that hit-stop was bolted on afterwards.
   */
  update(t, dt = 1 / 60) {
    const g = this._gain;
    const F = LIGHTING.flicker;

    // Bounce fill cross-fade. Exponential, framerate-independent, and slow —
    // it is standing in for an eye adapting to a new room, and a step change
    // reads as somebody flicking a switch.
    const k = 1 - Math.exp(-dt / Math.max(1e-3, AMBIENT.blend));
    this._fillNow += (this._fillTarget - this._fillNow) * k;
    this.fill.intensity = this._fillNow * g;

    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.amp === 0) { e.light.intensity = e.base * g; continue; }
      const p = e.phase + t * e.rate;
      const w = 1 +
        (Math.sin(p * 7.3) * F.a +
         Math.sin(p * 3.1 + 1.3) * F.b +
         Math.sin(p * 1.7 + 2.9) * F.c) * e.amp;
      // Never let a source reach zero: `LightBudget` only shows a light whose
      // intensity is > 0, so a flicker that touched zero would drop the light
      // out of its slot for one frame and let a ballast take it.
      e.light.intensity = e.base * g * Math.max(0.25, w);
    }
  }

  /** `clean` | `lit` | `dark`, for the shot harness's `debugStage`. */
  setGain(g) { this._gain = clamp(g, 0, 4); return this._gain; }

  stats() {
    return {
      total: this.entries.length,
      byKind: { ...this._counts },
      gain: this._gain,
      fill: +this._fillNow.toFixed(4),
      fillTarget: +this._fillTarget.toFixed(4),
    };
  }

  dispose() {
    this.render?.removeLight?.(this.fill);
    this.fill.parent?.remove(this.fill);
    this.fill.dispose?.();
    for (const e of this.entries) {
      this.render?.removeLight?.(e.light);
      e.light.parent?.remove(e.light);
      e.light.dispose?.();
    }
    this.entries.length = 0;
    this.group.parent?.remove(this.group);
  }
}
