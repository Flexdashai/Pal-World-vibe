import * as THREE from 'three';
import { ELEMENTS, LIGHTS } from '../core/palette.js';
import { makeAdditiveMaterial } from './appearance.js';

/**
 * MONARCH — the hero's own light and the monarch aura.
 *
 * Three things live here, and all three exist to solve measured problems in the
 * current build rather than to decorate:
 *
 *  1. **A violet rim light on the player.** The analyser reports 44.8% of the
 *     frame crushed to information-free black; the lit pools around the braziers
 *     are fine and everything between them is void. The hero spends most of a
 *     run in that void. A single point light at chest height, using the
 *     palette's `playerRim`, means the character is never a black cut-out — and
 *     because it is violet it also spills a little shadow-colour onto the floor
 *     under them, which is the Solo Leveling read.
 *
 *  2. **A ground ring.** A soft additive disc under the feet. It grounds the
 *     hero (an isometric character with no contact cue floats), and it grows
 *     with the shadow army, so the power fantasy is legible in the frame and
 *     not only in the HUD.
 *
 *  3. **The monarch aura** — a standing column of violet with orbiting glyphs,
 *     ramped up during ARISE and the ultimate. This is the "overwhelming power"
 *     beat and it is off (opacity 0) the rest of the time so the world stays
 *     near-monochrome.
 *
 * ---------------------------------------------------------------------------
 * LIGHT BUDGET
 *
 * Exactly ONE punctual light, registered with `render.addLight` so it
 * participates in the fixed slot mechanism. The rig never adds or removes it —
 * it drives `intensity` instead, including to zero — because the visible light
 * COUNT is a shader permutation key and toggling `visible` would recompile every
 * lit material in the scene (ARCHITECTURE.md, "The visible point-light count").
 */

const SHADOW = ELEMENTS.shadow;

export class MonarchAura {
  constructor(ctx, root, rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.name = 'mn.player.aura';
    root.add(this.group);

    this._geo = [];
    this._mat = [];

    // ---- rim light ---------------------------------------------------------
    //
    // ABOVE AND BEHIND THE HEAD, at a distance. Two earlier placements were
    // wrong in opposite directions and both were caught by capturing:
    //
    //   0.30 m behind the sternum → 0.35 m from the pauldron, and under
    //     inverse-square that is 8x the irradiance of a metre away. The frame
    //     showed a blown white disc on the shoulder with no shape left in it.
    //   0.62 m behind the head at low intensity → no blowout, but the plate
    //     (metalness 1, so no diffuse term at all) went to pure black and the
    //     hero became a violet outline around a hole.
    //
    // 1.05 m back and 2.35 m up with a matching intensity puts every part of
    // the figure between 1.2 m and 2.4 m from the source: a 4:1 falloff across
    // the body, which is a gradient rather than either a hotspot or nothing.
    const rim = LIGHTS.playerRim;
    this.light = new THREE.PointLight(
      new THREE.Color().setRGB(rim.color[0], rim.color[1], rim.color[2], THREE.LinearSRGBColorSpace),
      rim.intensity * 6.6,
      // 5.6 m of reach, not 7.5. The extra two metres bought nothing on the
      // hero (they are 2.4 m from the source at most) and spilled a visible
      // violet pool onto the wall behind them.
      5.6,
      2.0   // physically correct inverse-square falloff
    );
    this.light.position.set(0, 2.35, -1.05);
    this.light.castShadow = false;   // the key light already casts; two is noise
    this.light.name = 'mn.player.rim';
    this.group.add(this.light);
    ctx.get('render').addLight(this.light);
    this.baseIntensity = this.light.intensity;

    // ---- fill light --------------------------------------------------------
    //
    // The second of the hero's two slots, and the one that makes the armour
    // read as a solid object instead of a silhouette.
    //
    // It lives in the SCENE, not in the player group, and is repositioned each
    // frame to a fixed CAMERA-SIDE offset. The camera yaw is locked at 45°, so
    // "camera side" is the constant world direction (+X, +Z) — a fill parented
    // to the hero would swing round behind them the moment they turned and stop
    // filling anything.
    //
    // Cold and desaturated on purpose: the brazier key is warm, the rim is
    // violet, and a third saturated colour would push the frame's
    // luminance-weighted saturation further over the 0.30 target it is already
    // above. Two slots out of eight is a real cost to the brazier budget, and
    // it is the right trade — the hero is the subject of every frame in the
    // game and 44.8% of that frame is measured as information-free black.
    //
    // Reach is deliberately short (4.2 m) and the source sits high. A fill with
    // a long reach lit the flagstones for two metres around the hero and, worse,
    // ignited `sky`'s ground mist into a white cloud at their feet. High and
    // near gives a 3.8:1 ratio between the hero's chest and the floor they are
    // standing on, so the crypt stays dark and only the subject lifts.
    this.fill = new THREE.PointLight(
      new THREE.Color().setRGB(0.30, 0.33, 0.46, THREE.LinearSRGBColorSpace),
      11.0, 4.2, 2.0
    );
    this.fill.castShadow = false;
    this.fill.name = 'mn.player.fill';
    ctx.scene.add(this.fill);
    ctx.get('render').addLight(this.fill);
    this.fillBase = 11.0;
    this._fillOffset = new THREE.Vector3(0.85, 2.25, 0.85);

    // ---- ground ring -------------------------------------------------------
    // A flat annulus, faintly hot at the inner edge. Drawn additive with no
    // depth write, and lifted 1.5 cm so it never z-fights the floor.
    // Sized to the hero's actual footprint (the coat hem reaches 0.42 m), not to
    // a decorative halo: at 0.86 m the first pass drew a 1.7 m purple disc that
    // was the largest object in the frame.
    const ringGeo = new THREE.RingGeometry(0.24, 0.60, 40, 3);
    ringGeo.rotateX(-Math.PI / 2);
    this._geo.push(ringGeo);
    this.ringMat = makeAdditiveMaterial('auraRing', SHADOW.core, 0.0);
    this._mat.push(this.ringMat);
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.position.y = 0.015;
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 6;
    this.ring.userData.mnNoShadow = true;
    this.ring.userData.mnNoPrepass = true;
    this.group.add(this.ring);

    // ---- column ------------------------------------------------------------
    // Two nested open cylinders with reversed winding, so the column reads as a
    // volume of light rather than as a tube. Vertical UV fade is baked into the
    // geometry's vertex colours because an additive material with a texture
    // would need a texture, and everything here is generated.
    const colGeo = buildColumn(1.05, 4.6, 26, 8);
    this._geo.push(colGeo);
    this.columnMat = makeAdditiveMaterial('auraColumn', SHADOW.core, 0.0);
    this.columnMat.vertexColors = true;
    this._mat.push(this.columnMat);
    this.column = new THREE.Mesh(colGeo, this.columnMat);
    this.column.frustumCulled = false;
    this.column.renderOrder = 5;
    this.column.userData.mnNoShadow = true;
    this.column.userData.mnNoPrepass = true;
    this.column.visible = false;
    this.group.add(this.column);

    // ---- glyphs ------------------------------------------------------------
    // Six angular runes orbiting at chest height. Built as one geometry with
    // per-glyph vertices so the whole ring is a single draw call; the orbit is
    // done by rotating the parent, not by moving vertices.
    const glyphGeo = buildGlyphRing(rng, 6, 1.15);
    this._geo.push(glyphGeo);
    this.glyphMat = makeAdditiveMaterial('auraGlyphs', SHADOW.light, 0.0);
    this._mat.push(this.glyphMat);
    this.glyphs = new THREE.Mesh(glyphGeo, this.glyphMat);
    this.glyphs.position.y = 1.05;
    this.glyphs.frustumCulled = false;
    this.glyphs.renderOrder = 7;
    this.glyphs.userData.mnNoShadow = true;
    this.glyphs.userData.mnNoPrepass = true;
    this.glyphs.visible = false;
    this.group.add(this.glyphs);

    for (const m of this._mat) {
      // Bloom picks these up through the emissive buffer; `mnGlow` is what
      // scales their contribution to it.
      ctx.get('render').registerMaterial(m);
    }
    this.ring.userData.mnGlow = 1.6;
    this.column.userData.mnGlow = 2.2;
    this.glyphs.userData.mnGlow = 3.0;

    // ---- state -------------------------------------------------------------
    /** 0..1 — the "big moment" ramp, driven by ARISE / ultimate. */
    this.power = 0;
    this.powerTarget = 0;
    /** 0..1 — army fullness, drives the resting ring brightness. */
    this.army = 0;
    this.time = 0;
    this._flash = 0;
  }

  /** Ramp the aura up (1) or down (0). */
  setPower(v) { this.powerTarget = THREE.MathUtils.clamp(v, 0, 1); }

  /** A one-frame surge — an extraction, a level up. */
  flash(amount = 1) { this._flash = Math.max(this._flash, amount); }

  /** 0..1 from the shadow army's fullness. */
  setArmy(v) { this.army = THREE.MathUtils.clamp(v, 0, 1); }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} [worldPos]  the hero's world position; the fill light
   *   is not parented to them, so it has to be told where they are.
   */
  update(dt, worldPos) {
    this.time += dt;
    if (worldPos) {
      this.fill.position.copy(worldPos).add(this._fillOffset);
    }
    this.power += (this.powerTarget - this.power) * Math.min(1, dt * 4.2);
    this._flash *= Math.exp(-dt * 3.4);
    if (this._flash < 1e-3) this._flash = 0;

    const p = this.power;
    const flash = this._flash;

    // ---- rim light ---------------------------------------------------------
    // Base + a slow breath + the army + the big-moment ramp. The breath is
    // 6% and slow: a hero whose personal light pulses visibly reads as a
    // machine, but a perfectly constant one reads as a lamp bolted to them.
    const breath = 1 + 0.06 * Math.sin(this.time * 1.35) + 0.03 * Math.sin(this.time * 3.1 + 1.2);
    this.light.intensity = this.baseIntensity * breath * (1 + this.army * 0.55 + p * 3.2 + flash * 2.4);
    this.light.distance = 7.5 + p * 5.0;
    // The fill barely moves: it is there to hold the armour's form, and a fill
    // that pulses is a fill the eye starts watching. It only lifts for the big
    // moments, where everything lifts.
    this.fill.intensity = this.fillBase * (1 + p * 0.85 + flash * 0.5);

    // ---- ring --------------------------------------------------------------
    const ringA = 0.055 + this.army * 0.11 + p * 0.42 + flash * 0.30;
    this.ringMat.opacity = ringA;
    const s = 1 + this.army * 0.22 + p * 0.55 + Math.sin(this.time * 1.9) * 0.02;
    this.ring.scale.set(s, 1, s);

    // ---- column + glyphs ---------------------------------------------------
    const colA = Math.max(0, p * 0.30 + flash * 0.16 - 0.012);
    this.column.visible = colA > 0.004;
    if (this.column.visible) {
      this.columnMat.opacity = colA;
      const cs = 0.55 + p * 0.6;
      this.column.scale.set(cs, 0.75 + p * 0.55, cs);
      // Counter-rotate against the glyphs so the two layers shear.
      this.column.rotation.y = -this.time * 0.35;
    }

    const glyA = Math.max(0, p * 0.85 + flash * 0.35 - 0.02);
    this.glyphs.visible = glyA > 0.004;
    if (this.glyphs.visible) {
      this.glyphMat.opacity = glyA;
      this.glyphs.rotation.y = this.time * 0.85;
      this.glyphs.position.y = 1.05 + Math.sin(this.time * 1.1) * 0.05 + p * 0.15;
      const gs = 0.8 + p * 0.45;
      this.glyphs.scale.set(gs, gs, gs);
    }
  }

  dispose() {
    const render = this.ctx.peek('render');
    render?.removeLight?.(this.light);
    render?.removeLight?.(this.fill);
    this.fill.removeFromParent();
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this.group.removeFromParent();
  }
}

/**
 * An open double-walled cylinder with a vertical brightness gradient in the
 * vertex colours: bright at the base, gone by the top, plus a hot band at the
 * very bottom where the column meets the floor. Vertex colours because an
 * additive material needs SOME spatial variation or it reads as a solid tube,
 * and a gradient texture is a texture we would have to generate and upload.
 */
function buildColumn(radius, height, segments, rings) {
  const pos = [];
  const col = [];
  const idx = [];
  const push = (r, y, a, bright) => {
    pos.push(Math.sin(a) * r, y, Math.cos(a) * r);
    col.push(bright, bright, bright);
    return pos.length / 3 - 1;
  };

  for (let shell = 0; shell < 2; shell++) {
    const r = radius * (shell === 0 ? 1 : 0.62);
    const base = pos.length / 3;
    for (let iy = 0; iy <= rings; iy++) {
      const t = iy / rings;
      const y = t * height;
      // Fast falloff with a lift at the very bottom: light columns are brightest
      // where they emerge and dissipate long before their nominal top.
      const bright = (Math.pow(1 - t, 2.6) * 0.9 + Math.exp(-t * 22) * 0.6) * (shell === 0 ? 1 : 0.65);
      for (let ia = 0; ia < segments; ia++) push(r, y, (ia / segments) * Math.PI * 2, bright);
    }
    for (let iy = 0; iy < rings; iy++) {
      for (let ia = 0; ia < segments; ia++) {
        const a = base + iy * segments + ia;
        const b = base + iy * segments + ((ia + 1) % segments);
        const c = base + (iy + 1) * segments + ((ia + 1) % segments);
        const d = base + (iy + 1) * segments + ia;
        if (shell === 0) idx.push(a, b, c, a, c, d);
        else idx.push(a, c, b, a, d, c);   // inner shell faces inward
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.name = 'mn.player.auraColumn';
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Angular runes on a ring: each is a small closed polygon extruded to a quad
 * strip. The shapes are drawn from a deterministic RNG so the aura is the same
 * on every capture, but they are all different from each other — a ring of six
 * identical glyphs reads as a UI element rather than as magic.
 */
function buildGlyphRing(rng, count, radius) {
  const pos = [];
  const idx = [];
  for (let g = 0; g < count; g++) {
    const a = (g / count) * Math.PI * 2;
    const cx = Math.sin(a) * radius;
    const cz = Math.cos(a) * radius;
    // Local frame: the glyph faces outward from the ring's centre.
    const tx = Math.cos(a), tz = -Math.sin(a);

    const strokes = 2 + (rng.u32() % 3);
    for (let s = 0; s < strokes; s++) {
      const w = rng.range(0.03, 0.075);
      const h = rng.range(0.05, 0.16);
      const ox = rng.range(-0.07, 0.07);
      const oy = rng.range(-0.10, 0.10);
      const skew = rng.range(-0.35, 0.35);
      const base = pos.length / 3;
      // Quad in the glyph's own plane: right = (tx, 0, tz), up = +Y.
      const corners = [
        [ox - w * 0.5, oy - h * 0.5],
        [ox + w * 0.5, oy - h * 0.5 + skew * h],
        [ox + w * 0.5, oy + h * 0.5 + skew * h],
        [ox - w * 0.5, oy + h * 0.5],
      ];
      for (const [u, v] of corners) {
        pos.push(cx + tx * u, v, cz + tz * u);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.name = 'mn.player.auraGlyphs';
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
