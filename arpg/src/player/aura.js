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
 * LIGHT BUDGET, AND THE CROSS-SUBSYSTEM TRAP
 *
 * TWO punctual lights, both registered with `render.addLight` so they
 * participate in the fixed slot mechanism. Neither is ever added or removed —
 * only their `intensity` moves, including to zero — because the visible light
 * COUNT is a shader permutation key and toggling `visible` would recompile every
 * lit material in the scene (ARCHITECTURE.md, "The visible point-light count").
 *
 * They are also deliberately WEAK and SHORT-RANGE, and that is not a rendering
 * decision, it is an interoperability one. `sky` feeds its volumetric march and
 * its ground mist from the two highest-scoring point lights in the scene, scored
 * as `intensity / (1 + d²)` about the camera focus — and the camera focus is the
 * player. Anything bright bolted to the hero therefore (a) displaces both
 * braziers from the fog solution and (b) lights the fog volume standing directly
 * between the camera and the hero's chest. A capture with a strong character
 * fill produced exactly that: a white cloud where the cuirass should be. The
 * brightness the hero needs is bought in `appearance.js` instead, by raising
 * reflectance, which no other subsystem can see.
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
      rim.intensity * 4.2,
      // 3.6 m of reach, not 7.5. Both hero lights are deliberately SHORT-RANGE
      // and HIGH, and the reason is `sky`'s ground mist: a long-reach light near
      // the floor lit the fog volume between the camera and the hero into a
      // white cloud that covered them from the waist down. Three's distance
      // window falls off as (1 − (d/D)⁴)², so pulling D in from 7.5 to 3.6 costs
      // the head 4% and costs the fog at the hero's feet 60%.
      3.6,
      2.0   // physically correct inverse-square falloff
    );
    this.light.position.set(0, 2.30, -0.95);
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
    // above.
    //
    // Reach is 3 m and the source sits 2.15 m up, which puts the floor at the
    // hero's feet outside the distance window entirely while the chest sits at
    // 0.9 m. The crypt stays dark; only the subject lifts.
    //
    // The offset is pushed OFF THE SILHOUETTE rather than straight toward the
    // camera. `sky`'s volumetric march puts a soft glow ball at every point
    // light, and with the fill directly camera-side of the hero that ball
    // projected onto their chest and washed the cuirass out. Dotted with the
    // camera's right vector (cos45, 0, −sin45) this offset lands ~0.9 m to
    // screen-right and above, so the glow sits beside the hero instead of on
    // them and still fills the camera-facing planes of the armour.
    this.fill = new THREE.PointLight(
      new THREE.Color().setRGB(0.26, 0.29, 0.42, THREE.LinearSRGBColorSpace),
      4.2, 3.0, 2.0
    );
    this.fill.castShadow = false;
    this.fill.name = 'mn.player.fill';
    ctx.scene.add(this.fill);
    ctx.get('render').addLight(this.fill);
    this.fillBase = 4.2;
    this._fillOffset = new THREE.Vector3(1.25, 2.15, 0.02);

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
    //
    // BACK FACES ONLY. This is the whole design of the piece.
    //
    // The first version was two nested double-sided shells: four layers of
    // additive violet between the camera and the hero, which at power 1.0 turned
    // the ARISE frame — the frame this game most needs to be good — into a
    // white cone with a person somewhere inside it. Rendering only back faces
    // draws just the FAR wall of the cylinder, so the column stands BEHIND the
    // hero and their silhouette cuts into it. That is also what the reference
    // actually looks like.
    const colGeo = buildColumn(0.78, 3.6, 26, 9);
    this._geo.push(colGeo);
    this.columnMat = makeAdditiveMaterial('auraColumn', SHADOW.core, 0.0);
    this.columnMat.vertexColors = true;
    this.columnMat.side = THREE.BackSide;
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
    // `core` rather than `light`: additive blending saturates the blue channel
    // first, so the near-pure-blue core stays violet as it stacks and blooms,
    // where the pastel `light` washes straight to white.
    this.glyphMat = makeAdditiveMaterial('auraGlyphs', SHADOW.core, 0.0);
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
    const colA = Math.max(0, p * 0.42 + flash * 0.20 - 0.012);
    this.column.visible = colA > 0.004;
    if (this.column.visible) {
      this.columnMat.opacity = colA;
      const cs = 0.72 + p * 0.42;
      this.column.scale.set(cs, 0.80 + p * 0.45, cs);
      // Counter-rotate against the glyphs so the two layers shear.
      this.column.rotation.y = -this.time * 0.35;
    }

    const glyA = Math.max(0, p * 0.95 + flash * 0.35 - 0.02);
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
 * A double-walled cylinder with a vertical brightness gradient in the vertex
 * colours: bright at the base, gone by the top, plus a hot band at the very
 * bottom where the column meets the floor. Vertex colours because an additive
 * material needs SOME spatial variation or it reads as a solid tube, and a
 * gradient texture is a texture we would have to generate and upload.
 *
 * Both walls are wound outward and the material draws BACK faces only, so what
 * reaches the screen is the far side of both shells — a column standing behind
 * the hero rather than a fog draped over them. See the constructor.
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
        // BOTH shells wound outward. The material culls front faces, so each
        // shell contributes only its far wall — two thin arcs of light behind
        // the hero, not four layers of haze in front of them.
        idx.push(a, b, c, a, c, d);
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
