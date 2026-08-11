/**
 * MONARCH — the combat VFX kit.
 *
 * Shared materials, geometry builders, a light pool and a camera-facing mote
 * field, used by every skill effect in this directory.
 *
 * ---------------------------------------------------------------------------
 * WHY COMBAT DRAWS ANYTHING AT ALL
 *
 * `fx` owns generic particles, blood, decals, trails and screen impulses.
 * `combat` owns the SKILLS — and a skill's own signature geometry (the arc a
 * cleave leaves in the air, the shockwave a nova pushes out, the dome of the
 * Monarch's Domain) is part of the skill's definition in the same way its
 * damage curve is. The split we keep to:
 *
 *   combat draws   the spell itself: arcs, rings, domes, spires, runes, the
 *                  projectile body, the hit flash on a struck actor.
 *   fx draws       what the world does about it: sparks, blood, smoke, dust,
 *                  decals, gibs, screen distortion.
 *
 * Combat therefore emits `fx:impact` and `fx:explosion` at every point where
 * `fx` should take over, and never draws those itself.
 *
 * ---------------------------------------------------------------------------
 * RULES OBEYED THROUGHOUT THIS DIRECTORY
 *
 *  - Additive, depth-tested, no depth write, `mnNoPrepass`, `mnNoShadow`.
 *    An additive spell that writes depth punches a hole in TAA and in the AO.
 *  - `mnGlow` set from `tuning.GLOW`, so the bloom-only buffer sees the right
 *    radiance without the material itself being blown out.
 *  - Colours come from `core/palette.js`. Nothing here hardcodes a spell colour.
 *  - `visible = false` when idle. An additive material at opacity 0 still costs
 *    a draw call and still fills.
 *  - Every geometry and material is created once, in `init`, and disposed.
 */

import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';
import { VFX, GLOW, clamp01 } from './tuning.js';

/* ==================================================================== */
/* Materials                                                            */
/* ==================================================================== */

/**
 * The one material factory for this subsystem.
 *
 * `MeshBasicMaterial` and not a custom ShaderMaterial on purpose: every distinct
 * shader in the scene is a program permutation, and on a software rasteriser a
 * program compile is a visible stall. All the spatial variation these effects
 * need comes from vertex colours, which cost nothing.
 */
export function makeSpellMaterial(name, colourLinear, opts = {}) {
  const m = new THREE.MeshBasicMaterial({
    name: `mn.combat.${name}`,
    color: new THREE.Color().setRGB(colourLinear[0], colourLinear[1], colourLinear[2],
      THREE.LinearSRGBColorSpace),
    transparent: true,
    opacity: opts.opacity ?? 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: opts.depthTest !== false,
    side: opts.side ?? THREE.DoubleSide,
    vertexColors: opts.vertexColors !== false,
    toneMapped: true,
    fog: opts.fog === true,
  });
  m.userData.mnNoPrepass = true;
  return m;
}

/** Tag a mesh as a spell effect: out of the prepass, out of shadows, into the
 *  bloom-only buffer at `glow`, drawn after the world. */
export function tagEffect(mesh, glow, order = 8) {
  mesh.userData.mnNoPrepass = true;
  mesh.userData.mnNoShadow = true;
  mesh.userData.mnGlow = glow;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = order;
  // Spell effects live at the camera focus and change shape every frame; a
  // bounding sphere computed at build time is wrong the moment they scale.
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

/* ==================================================================== */
/* Lights                                                               */
/* ==================================================================== */

/**
 * A fixed pool of point lights for spell illumination.
 *
 * ARCHITECTURE.md's trap: the number of VISIBLE point lights is a shader
 * permutation key, so a light appearing recompiles every lit material in the
 * scene. `render/lights.js` solves it with a frozen slot count plus ballast —
 * but only for lights that EXIST BEFORE THE FREEZE. So these are created in
 * `init()`, never added or removed afterwards, and driven purely by intensity.
 * `LightBudget` hides a zero-intensity light and tops the count up with ballast,
 * so an idle spell light costs nothing and moves no pixel.
 *
 * Three slots, matching the +3 headroom `LightBudget.freeze` allocates for
 * combat and fx. Anything more would push a real brazier out of the budget,
 * which is a worse trade than one spell light fewer.
 *
 * They are also SHORT-RANGE by policy. `sky` feeds its volumetric march from the
 * two highest-scoring point lights around the camera focus — which is the
 * player. A long-reach spell light at the player's feet lights the fog volume
 * standing between the camera and the hero and turns them into a white cloud.
 * See the same note in `player/aura.js`; it was found the expensive way.
 */
export class SpellLights {
  constructor(ctx, count = 3) {
    this.ctx = ctx;
    this.lights = [];
    const render = ctx.peek('render');
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0x000000, 0, 8, 2);
      l.name = `mn.combat.spell${i}`;
      l.castShadow = false;
      l.position.set(0, -1000, 0);
      ctx.scene.add(l);
      render?.addLight?.(l);
      this.lights.push(l);
    }
    this._c = new THREE.Color();
  }

  /**
   * Drive one slot. `intensity` of 0 parks it (the budget then hides it and
   * substitutes ballast, so the visible count never moves).
   */
  set(i, x, y, z, colourLinear, intensity, distance) {
    const l = this.lights[i];
    if (!l) return;
    if (!(intensity > 0)) { l.intensity = 0; return; }
    l.position.set(x, y, z);
    l.color.setRGB(colourLinear[0], colourLinear[1], colourLinear[2], THREE.LinearSRGBColorSpace);
    l.intensity = intensity;
    l.distance = distance;
  }

  clear() { for (const l of this.lights) l.intensity = 0; }

  dispose() {
    const render = this.ctx.peek('render');
    for (const l of this.lights) {
      render?.removeLight?.(l);
      l.removeFromParent();
      l.dispose?.();
    }
    this.lights.length = 0;
  }
}

/* ==================================================================== */
/* Geometry builders                                                    */
/* ==================================================================== */

/**
 * A flat annulus in the XZ plane with a radial brightness gradient in the vertex
 * colours: dark at the inner edge, hot in the middle, dark at the outer.
 *
 * That three-band profile is what makes an expanding ring read as a shockwave
 * rather than as a disc with a hole in it — a real shock front is brightest at
 * the front and trails off behind.
 */
export function buildShockRing(inner, outer, segments = 64, bands = 5) {
  const pos = [];
  const col = [];
  const idx = [];
  for (let b = 0; b <= bands; b++) {
    const t = b / bands;
    const r = inner + (outer - inner) * t;
    // Peak at 62% of the way out: the front edge is sharper than the trail.
    const d = (t - 0.62) / (t < 0.62 ? 0.62 : 0.38);
    const bright = Math.exp(-d * d * 2.6);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      // Every ring is scalloped slightly, and the scallop phase varies per band,
      // so the front is never a perfect circle. Nothing in this game is
      // perfectly round.
      const wob = 1 + Math.sin(a * 7 + b * 1.7) * 0.018 + Math.sin(a * 3 - b) * 0.012;
      pos.push(Math.sin(a) * r * wob, 0, Math.cos(a) * r * wob);
      col.push(bright, bright, bright);
    }
  }
  for (let b = 0; b < bands; b++) {
    for (let s = 0; s < segments; s++) {
      const a = b * segments + s;
      const bb = b * segments + ((s + 1) % segments);
      const c = (b + 1) * segments + ((s + 1) % segments);
      const d = (b + 1) * segments + s;
      idx.push(a, bb, c, a, c, d);
    }
  }
  return finish('shockRing', pos, col, idx);
}

/**
 * A hemispherical shell, wound outward and drawn BACK FACE ONLY.
 *
 * Back faces only is the same trick `player/aura.js` uses for the monarch
 * column, and for the same reason: a double-sided additive dome puts two layers
 * of violet between the camera and everything inside it, so the boss you are
 * fighting disappears into a purple fog. Drawing only the far wall means the
 * dome stands BEHIND the fight and silhouettes cut into it.
 *
 * Brightness is concentrated at the horizon and at the very top, with the
 * mid-latitudes almost clear, so the dome reads as a boundary rather than a
 * balloon.
 */
export function buildDomeShell(radius, rings = 14, segments = 48, opts = {}) {
  const apex = opts.apex ?? 0.0;
  const base = opts.base ?? 1.0;
  const stripeGain = opts.stripeGain ?? 1.35;
  const floor = opts.floor ?? 0.055;
  const pos = [];
  const col = [];
  const idx = [];
  for (let iy = 0; iy <= rings; iy++) {
    const t = iy / rings;
    const phi = t * Math.PI * 0.5;
    const y = Math.sin(phi) * radius;
    const r = Math.cos(phi) * radius;
    // Hot at the base (where it meets the ground), optionally a second lift at
    // the apex, and a long clear middle.
    //
    // `apex` DEFAULTS TO ZERO and that is load-bearing. The camera looks down
    // from 52 deg, so from outside a big dome the apex is most of what is on
    // screen: the first ultimate capture had a lift there and the whole frame
    // filled with the dome's ceiling. Only a small dome the camera is genuinely
    // outside of (the nova's core, the ward) wants an apex.
    const bright = Math.pow(1 - t, 3.2) * base + Math.pow(t, 7.0) * apex + floor;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      // Vertical striations: eight brighter meridians so the dome has structure
      // instead of being a smooth gradient, which at this distance reads as fog.
      const stripe = 1 + Math.pow(Math.abs(Math.sin(a * 4)), 8) * stripeGain;
      pos.push(Math.sin(a) * r, y, Math.cos(a) * r);
      const b = bright * stripe;
      col.push(b, b, b);
    }
  }
  for (let iy = 0; iy < rings; iy++) {
    for (let s = 0; s < segments; s++) {
      const a = iy * segments + s;
      const b = iy * segments + ((s + 1) % segments);
      const c = (iy + 1) * segments + ((s + 1) % segments);
      const d = (iy + 1) * segments + s;
      idx.push(a, b, c, a, c, d);
    }
  }
  return finish('domeShell', pos, col, idx);
}

/**
 * A crescent blade arc: a tapered ribbon swept through `spanRadians`, tilted out
 * of the horizontal by `tilt`, hot along its leading edge and fading to nothing
 * at the trailing one.
 *
 * The taper is the whole thing. A constant-width arc reads as a hoop; an arc
 * that is wide at the middle of the swing and vanishes at both ends reads as a
 * blade that accelerated through the target and left the air burning.
 *
 * Vertex `x` is normalised sweep position 0..1 in the u channel so a caller can
 * animate the sweep by scaling — but we bake the whole arc and animate opacity,
 * scale and rotation instead, because a per-frame vertex rewrite of 500 verts
 * on a CPU rasteriser is not free.
 */
export function buildArcRibbon(radius, spanRadians, thickness, tilt, steps = 34, headBias = 0) {
  const pos = [];
  const col = [];
  const idx = [];
  const half = spanRadians * 0.5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = -half + spanRadians * t;
    // Taper: sin^0.65 is fat through the middle and pointed at the tips.
    //
    // `headBias` additionally pushes the energy toward the END of the sweep —
    // the blade's leading edge — so a full-circle ribbon reads as a smear
    // TRAILING a moving edge instead of as a hoop. Without it the finisher's
    // 360 deg arc drew a uniformly bright torus around the hero, which at 720p
    // looked like a ring of dust.
    const taper = Math.pow(Math.sin(Math.PI * t), 0.65) *
      (headBias > 0 ? Math.pow(t, headBias) : 1);
    // Nothing in this game is perfectly clean. Three incommensurate harmonics
    // wobble the radius, the width and the brightness independently, so the arc
    // is a torn edge rather than a CAD circle — the finisher's full-circle
    // ribbon in particular read as a perfect white hoop without this.
    const wob = 1 + Math.sin(a * 9.0 + 0.7) * 0.022 + Math.sin(a * 17.0) * 0.013;
    const wWob = 1 + Math.sin(a * 6.3 + 2.1) * 0.20 + Math.sin(a * 13.7) * 0.11;
    const bWob = 1 + Math.sin(a * 4.1 + 1.3) * 0.16 + Math.sin(a * 11.3 + 0.4) * 0.10;
    const w = thickness * taper * wWob;
    // The arc rises through the swing, so it is not a flat disc on the floor.
    const lift = Math.sin(Math.PI * t) * tilt;
    const r = radius * wob;
    const rIn = r - w * 0.5;
    const rOut = r + w * 0.5;
    // Leading edge (outer) is hot; the inner edge is the smear behind the blade.
    const hot = (0.35 + 0.65 * taper) * bWob;
    pos.push(Math.sin(a) * rIn, lift * 0.55, Math.cos(a) * rIn);
    col.push(hot * 0.30, hot * 0.30, hot * 0.30);
    pos.push(Math.sin(a) * rOut, lift, Math.cos(a) * rOut);
    col.push(hot, hot, hot);
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 3, d = i * 2 + 2;
    idx.push(a, b, c, a, c, d);
  }
  return finish('arcRibbon', pos, col, idx);
}

/**
 * A ring of vertical spikes rising out of the ground — the spires a nova throws
 * up and the pillars that bound the domain.
 *
 * Each spike is a four-sided pyramid with a bright base and a dark tip, and its
 * height/phase varies per index from a deterministic sequence so the ring is
 * never uniform. Twenty identical spikes is exactly the tell the quality bar
 * calls out.
 *
 * **UNITS ARE NORMALISED TO THE RING RADIUS.** Callers scale the mesh
 * UNIFORMLY by the ring radius every frame — including Y — so `height` and
 * `baseWidth` here are FRACTIONS of that radius, not metres. Getting this wrong
 * is not subtle: scaling X and Z by a 4 m ring radius while leaving Y at 1
 * turned a 0.42 m spike into a 1.7 m flat sheet, and the first nova capture was
 * nothing but purple slabs.
 */
export function buildSpireRing(count, radius, height, baseWidth, rng) {
  const pos = [];
  const col = [];
  const idx = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (rng ? rng.range(-0.06, 0.06) : 0);
    const h = height * (rng ? rng.range(0.62, 1.25) : 1);
    const w = baseWidth * (rng ? rng.range(0.75, 1.3) : 1);
    const r = radius * (rng ? rng.range(0.93, 1.07) : 1);
    const cx = Math.sin(a) * r, cz = Math.cos(a) * r;
    // Spikes lean outward, like something erupting from a centre.
    const lean = (rng ? rng.range(0.05, 0.28) : 0.15);
    const tipX = cx + Math.sin(a) * h * lean;
    const tipZ = cz + Math.cos(a) * h * lean;
    const base = pos.length / 3;
    // Four base corners in a square around (cx, cz), rotated to face outward.
    const tx = Math.cos(a), tz = -Math.sin(a);
    const bx = Math.sin(a), bz = Math.cos(a);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [u, v] of corners) {
      pos.push(cx + tx * u * w * 0.5 + bx * v * w * 0.5, 0.0,
        cz + tz * u * w * 0.5 + bz * v * w * 0.5);
      col.push(1.0, 1.0, 1.0);
    }
    pos.push(tipX, h, tipZ);
    col.push(0.06, 0.06, 0.06);
    const tip = base + 4;
    for (let k = 0; k < 4; k++) idx.push(base + k, base + ((k + 1) & 3), tip);
  }
  return finish('spireRing', pos, col, idx);
}

/**
 * Angular runes laid FLAT on the ground in a ring — the domain's inscription.
 * Each rune is a handful of strokes drawn from the RNG so no two are alike, and
 * the ring as a whole is drawn in the XZ plane so it lies on the floor.
 *
 * **UNITS ARE NORMALISED TO THE RING'S OWN SCALE FACTOR.** The mesh is scaled
 * uniformly by the domain radius every frame, so `radius` is a fraction of it
 * and `scale` sizes the strokes in the same space. At the domain's 13.5 m a
 * `scale` of 1.0 produces strokes up to 5.7 m long — the first ultimate capture
 * was a floor covered in giant violet slabs for exactly this reason. A rune that
 * reads at this camera wants to be ~0.8 m tall, i.e. `scale ≈ 0.14`.
 */
export function buildGroundRunes(rng, count, radius, scale = 1) {
  const pos = [];
  const col = [];
  const idx = [];
  for (let g = 0; g < count; g++) {
    const a = (g / count) * Math.PI * 2;
    const cx = Math.sin(a) * radius;
    const cz = Math.cos(a) * radius;
    // Local frame: +u points along the ring, +v points outward from the centre.
    const ux = Math.cos(a), uz = -Math.sin(a);
    const vx = Math.sin(a), vz = Math.cos(a);
    const strokes = 3 + (rng.u32() % 4);
    for (let s = 0; s < strokes; s++) {
      const w = rng.range(0.05, 0.16) * scale;
      const h = rng.range(0.10, 0.42) * scale;
      const ou = rng.range(-0.28, 0.28) * scale;
      const ov = rng.range(-0.30, 0.30) * scale;
      const skew = rng.range(-0.4, 0.4);
      const bright = rng.range(0.55, 1.0);
      const base = pos.length / 3;
      const quad = [
        [ou - w * 0.5, ov - h * 0.5],
        [ou + w * 0.5, ov - h * 0.5 + skew * h],
        [ou + w * 0.5, ov + h * 0.5 + skew * h],
        [ou - w * 0.5, ov + h * 0.5],
      ];
      for (const [u, v] of quad) {
        pos.push(cx + ux * u + vx * v, 0, cz + uz * u + vz * v);
        col.push(bright, bright, bright);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return finish('groundRunes', pos, col, idx);
}

/**
 * A tapered lance along +Z: a hexagonal bipyramid with a long point.
 *
 * The shadow spear's body. Hot at the tip and dark at the tail so it reads as
 * travelling, not as a floating stick, and the cross-section is hexagonal
 * because a four-sided one shows its flat faces at this camera angle.
 */
export function buildLance(length, radius, sides = 6) {
  const pos = [];
  const col = [];
  const idx = [];
  // tip, then two rings, then tail.
  pos.push(0, 0, length * 0.62); col.push(1.6, 1.6, 1.6);           // 0 tip
  const ringA = 1, ringB = 1 + sides;
  for (let r = 0; r < 2; r++) {
    const z = r === 0 ? length * 0.20 : -length * 0.10;
    const rad = r === 0 ? radius : radius * 0.72;
    const bright = r === 0 ? 0.95 : 0.45;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, Math.sin(a) * rad, z);
      col.push(bright, bright, bright);
    }
  }
  const tail = pos.length / 3;
  pos.push(0, 0, -length * 0.38); col.push(0.06, 0.06, 0.06);
  for (let s = 0; s < sides; s++) {
    const n = (s + 1) % sides;
    idx.push(0, ringA + s, ringA + n);
    idx.push(ringA + s, ringB + s, ringB + n, ringA + s, ringB + n, ringA + n);
    idx.push(ringB + s, tail, ringB + n);
  }
  return finish('lance', pos, col, idx);
}

/** A flat disc in the XZ plane with a soft centre-out falloff — the ground scar
 *  a nova leaves, and the pool of light under the domain. */
export function buildGroundDisc(radius, segments = 48, rings = 4, power = 2.2) {
  const pos = [0, 0, 0];
  const col = [1, 1, 1];
  const idx = [];
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    const rad = radius * t;
    const bright = Math.pow(1 - t, power);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const wob = 1 + Math.sin(a * 5 + r) * 0.03;
      pos.push(Math.sin(a) * rad * wob, 0, Math.cos(a) * rad * wob);
      col.push(bright, bright, bright);
    }
  }
  for (let s = 0; s < segments; s++) {
    idx.push(0, 1 + s, 1 + ((s + 1) % segments));
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = 1 + r * segments + s;
      const b = 1 + r * segments + ((s + 1) % segments);
      const c = 1 + (r + 1) * segments + ((s + 1) % segments);
      const d = 1 + (r + 1) * segments + s;
      idx.push(a, b, c, a, c, d);
    }
  }
  return finish('groundDisc', pos, col, idx);
}

function finish(name, pos, col, idx) {
  const g = new THREE.BufferGeometry();
  g.name = `mn.combat.${name}`;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/* ==================================================================== */
/* Mote field — embers, motes, sparks                                   */
/* ==================================================================== */

/**
 * A pool of camera-facing quads with independent lives.
 *
 * Used for: the motes converging on a nova's anticipation phase, the embers
 * drifting off a cleave, the sparks of a hit flash, the rising ash inside the
 * domain. One geometry, one draw call, one material, N independent particles.
 *
 * `fx` owns GPU particles for the world at large; this is a small local pool so
 * combat's own effects are complete on their own, and it is budgeted against
 * `config.q.particleBudget` like everything else.
 */
export class MoteField {
  constructor(capacity, colourLinear, glow = GLOW.spark, order = 11) {
    this.capacity = capacity;
    this.count = 0;

    // Per-mote state, all typed, all preallocated.
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.bright = new Float32Array(capacity);
    /** 0 = ballistic drift, 1 = converge on a target point (nova gather). */
    this.mode = new Uint8Array(capacity);
    this.tx = new Float32Array(capacity);
    this.ty = new Float32Array(capacity);
    this.tz = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this._free = new Int32Array(capacity);
    this._freeCount = capacity;
    for (let i = 0; i < capacity; i++) this._free[i] = capacity - 1 - i;
    this._alive = new Uint8Array(capacity);

    const positions = new Float32Array(capacity * 4 * 3);
    const colours = new Float32Array(capacity * 4 * 3);
    const index = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4, o = i * 6;
      index[o] = v; index[o + 1] = v + 1; index[o + 2] = v + 2;
      index[o + 3] = v; index[o + 4] = v + 2; index[o + 5] = v + 3;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.name = 'mn.combat.motes';
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this._pos = positions;
    this._col = colours;

    this.material = makeSpellMaterial('motes', colourLinear, { opacity: 1 });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'mn.combat.motes';
    tagEffect(this.mesh, glow, order);
    this.mesh.visible = true;

    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  /**
   * Emit one mote. Silently drops when the pool is exhausted — a spell that
   * cannot emit its 200th ember is not a bug worth an allocation.
   */
  spawn(x, y, z, vx, vy, vz, life, size, bright, opts = {}) {
    if (this._freeCount === 0) return -1;
    const i = this._free[--this._freeCount];
    this._alive[i] = 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size; this.bright[i] = bright;
    this.mode[i] = opts.converge ? 1 : 0;
    this.tx[i] = opts.tx ?? 0; this.ty[i] = opts.ty ?? 0; this.tz[i] = opts.tz ?? 0;
    this.drag[i] = opts.drag ?? 1.9;
    this.gravity[i] = opts.gravity ?? 0;
    this.count++;
    return i;
  }

  /** Integrate and rebuild the vertex buffer. One pass, no allocation. */
  update(dt, camera) {
    if (this.count === 0) {
      if (this.geometry.drawRange.count !== 0) this.geometry.setDrawRange(0, 0);
      return;
    }
    // Camera basis for the billboard, computed once for the whole field.
    this._right.setFromMatrixColumn(camera.matrixWorld, 0);
    this._up.setFromMatrixColumn(camera.matrixWorld, 1);
    const rx = this._right.x, ry = this._right.y, rz = this._right.z;
    const ux = this._up.x, uy = this._up.y, uz = this._up.z;

    const pos = this._pos, col = this._col;
    let write = 0;

    for (let i = 0; i < this.capacity; i++) {
      if (!this._alive[i]) continue;
      let t = (this.life[i] -= dt);
      if (t <= 0) {
        this._alive[i] = 0;
        this._free[this._freeCount++] = i;
        this.count--;
        continue;
      }
      const age = 1 - t / this.maxLife[i];

      if (this.mode[i]) {
        // Converge: accelerate toward the target, harder as it gets closer, so
        // the motes visibly ACCELERATE into the caster instead of drifting in.
        // That acceleration is the entire read of an anticipation phase.
        const dx = this.tx[i] - this.px[i];
        const dy = this.ty[i] - this.py[i];
        const dz = this.tz[i] - this.pz[i];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
        const pull = 26 * dt / Math.max(0.45, d);
        this.vx[i] += dx * pull; this.vy[i] += dy * pull; this.vz[i] += dz * pull;
      } else {
        this.vy[i] += this.gravity[i] * dt;
      }
      const damp = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= damp; this.vy[i] *= damp; this.vz[i] *= damp;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      // Brightness: a hot flash for the first 15% of life, then a long ease out.
      // Linear alpha is the tell this whole codebase is written to avoid.
      const b = this.bright[i] * (age < 0.15
        ? 0.35 + age / 0.15 * 0.65
        : Math.pow(1 - (age - 0.15) / 0.85, 2.3));
      // Motes shrink as they die; embers do not vanish at full size.
      const s = this.size[i] * (0.45 + 0.55 * (1 - age * 0.75));

      const v = write * 12;
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      pos[v] = x - rx * s - ux * s; pos[v + 1] = y - ry * s - uy * s; pos[v + 2] = z - rz * s - uz * s;
      pos[v + 3] = x + rx * s - ux * s; pos[v + 4] = y + ry * s - uy * s; pos[v + 5] = z + rz * s - uz * s;
      pos[v + 6] = x + rx * s + ux * s; pos[v + 7] = y + ry * s + uy * s; pos[v + 8] = z + rz * s + uz * s;
      pos[v + 9] = x - rx * s + ux * s; pos[v + 10] = y - ry * s + uy * s; pos[v + 11] = z - rz * s + uz * s;
      for (let k = 0; k < 4; k++) {
        col[v + k * 3] = b; col[v + k * 3 + 1] = b; col[v + k * 3 + 2] = b;
      }
      write++;
    }

    // Draw only the compacted prefix. Everything past `write` is stale but never
    // referenced, so it costs nothing to leave it.
    this.geometry.setDrawRange(0, write * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  clear() {
    this._alive.fill(0);
    this._freeCount = this.capacity;
    for (let i = 0; i < this.capacity; i++) this._free[i] = this.capacity - 1 - i;
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

/* ==================================================================== */
/* Shared colour helpers                                                */
/* ==================================================================== */

/** Element colour with a per-channel gain, written into a scratch array so the
 *  callers never allocate. */
const _rgb = [0, 0, 0];
export function elementRgb(element, channel = 'core', gain = 1) {
  const e = ELEMENTS[element] ?? ELEMENTS.physical;
  const c = e[channel] ?? e.core;
  _rgb[0] = c[0] * gain * VFX.gain;
  _rgb[1] = c[1] * gain * VFX.gain;
  _rgb[2] = c[2] * gain * VFX.gain;
  return _rgb;
}

/**
 * A phase timeline evaluator. Given the four canonical phase durations and an
 * elapsed time, returns which phase we are in and how far through it, so an
 * effect can be authored as "anticipation / strike / bloom-out / dissipation"
 * instead of as one lerp.
 */
export function phaseOf(t, anticipation, strike, bloom, dissipate, out) {
  const b1 = anticipation, b2 = b1 + strike, b3 = b2 + bloom, b4 = b3 + dissipate;
  if (t < b1) { out.phase = 0; out.t = clamp01(t / Math.max(1e-5, anticipation)); }
  else if (t < b2) { out.phase = 1; out.t = clamp01((t - b1) / Math.max(1e-5, strike)); }
  else if (t < b3) { out.phase = 2; out.t = clamp01((t - b2) / Math.max(1e-5, bloom)); }
  else { out.phase = 3; out.t = clamp01((t - b3) / Math.max(1e-5, dissipate)); }
  out.done = t >= b4;
  out.total = b4;
  return out;
}

export function makePhase() { return { phase: 0, t: 0, done: false, total: 1 }; }
