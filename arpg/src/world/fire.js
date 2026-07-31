import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';
import { normalise, mergeAll, prismGeo, blockGeo, toFlat } from './geom.js';
import { matAt } from './kit.js';

/**
 * MONARCH — fire.
 *
 * Braziers are the KEY LIGHT of this game. ARCHITECTURE.md: "In a crypt the key
 * IS the brazier — it must flicker, and everything near it must respond." So the
 * fire is not decoration on top of a light; the light is the shadow the fire
 * casts, and both live here.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREVIOUS BRAZIER RENDERED AS A BLOWN-OUT WHITE DISC, AND WHAT FIXED IT
 *
 * The measured defect was a 0.34 m emissive DOME at ~1.14x `fire.core` radiance.
 * Three separate things were wrong and all three are addressed here:
 *
 *  1. AREA. A smooth hemisphere presents one large, almost uniformly bright
 *     region to the camera. Once the AgX shoulder has clipped all three channels
 *     across that whole region there is no orange left anywhere in it — it is
 *     white by definition, and the bloom pyramid then spreads the white. Fire is
 *     replaced here by a TALL, NARROW, POINTED plume whose bright part is a few
 *     hundred square centimetres, plus a bed of small separate coals. The lit
 *     area drops by ~4x and the peak can stay high without clipping a big patch.
 *
 *  2. GRADIENT. A dome shaded by `emissiveIntensity` has one value. A real flame
 *     runs from near-white at the base through orange to deep red at the tip and
 *     falls to nothing over 40 cm. That gradient is authored in the fragment
 *     shader below and it is what makes the thing read as FIRE rather than as a
 *     light bulb, because the eye identifies fire by its colour ramp.
 *
 *  3. MOTION. A static flame is a lamp. The plume is displaced in the vertex
 *     shader by summed sines — NEVER by per-frame random, which strobes and is
 *     not reproducible in a capture — and the light's intensity is driven by the
 *     same phase, so the floor brightens when the flame leans toward it.
 *
 * ---------------------------------------------------------------------------
 * COST
 *
 * Every flame in the level is ONE draw call: the plumes are baked into a single
 * world-space geometry with a per-vertex phase attribute, so there is no
 * instancing permutation, no per-frame matrix upload and no uniform array. One
 * `uTime` write per frame drives all of them.
 */

/** Vertices per plume: 8 radial by 6 vertical = 96 triangles. Below 7 radial the
 *  silhouette polygonalises; above 9 nothing changes and it is a software
 *  rasteriser. */
const PLUME_RADIAL = 8;
const PLUME_RINGS = 6;

/**
 * Flame silhouette. Widest at ~30% of the height, pointed at the tip, and NOT
 * widest at the base — a fire narrows where it leaves the fuel and balloons
 * where the volatiles ignite, and getting that one inflection right is most of
 * the read.
 */
function plumeRadius(t) {
  return Math.pow(1 - t, 0.82) * (0.46 + 0.54 * Math.sin(Math.min(1, t * 3.1) * Math.PI * 0.5));
}

/**
 * Build one plume in LOCAL space (base at origin, tip at +Y·height).
 * `uv.x` is the angular coordinate, `uv.y` is the normalised height, which the
 * shader uses for both the colour ramp and the sway amplitude.
 */
function plumeGeo(height, radius) {
  const R = PLUME_RADIAL, N = PLUME_RINGS;
  const verts = (R + 1) * (N + 1);
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const idx = [];
  for (let j = 0; j <= N; j++) {
    // Bias the rings toward the base, where the gradient is steepest.
    const t = Math.pow(j / N, 0.85);
    const r = plumeRadius(t) * radius;
    for (let i = 0; i <= R; i++) {
      const a = (i / R) * Math.PI * 2;
      const k = (j * (R + 1) + i);
      pos[k * 3] = Math.cos(a) * r;
      pos[k * 3 + 1] = t * height;
      pos[k * 3 + 2] = Math.sin(a) * r;
      nrm[k * 3] = Math.cos(a);
      nrm[k * 3 + 1] = 0.25;
      nrm[k * 3 + 2] = Math.sin(a);
      uv[k * 2] = i / R;
      uv[k * 2 + 1] = t;
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < R; i++) {
      const a = j * (R + 1) + i, b = a + 1, c = a + R + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * The flame material.
 *
 * Additive into the linear HDR buffer, so the numbers below ARE radiance and the
 * exposure system is what decides how bright they look. `depthWrite:false` keeps
 * it out of the depth buffer entirely (and therefore out of render's MRT prepass,
 * SSR and GTAO — a flame must not occlude, reflect or shade).
 */
export function createFlameMaterial() {
  const hot = ELEMENTS.fire.glow;     // pale orange, the base of the plume
  const core = ELEMENTS.fire.core;    // saturated orange, the body
  const dark = ELEMENTS.fire.dark;    // deep red, the guttering tip

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      /** x = master gain, y = sway metres per unit height, z = tip flutter. */
      uParams: { value: new THREE.Vector3(1.0, 0.055, 0.35) },
      uHot: { value: new THREE.Vector3(hot[0], hot[1], hot[2]) },
      uCore: { value: new THREE.Vector3(core[0], core[1], core[2]) },
      uDark: { value: new THREE.Vector3(dark[0], dark[1], dark[2]) },
    },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      attribute float aGain;
      attribute vec3 aBase;
      varying float vT;
      varying float vPhase;
      varying float vGain;
      varying vec3 vNrm;
      varying vec3 vView;
      uniform float uTime;
      uniform vec3 uParams;

      void main() {
        vT = uv.y;
        vPhase = aPhase;
        vGain = aGain;

        vec3 p = position;
        // Sway: three incommensurate sines, amplitude growing as the square of
        // height so the base stays welded to the coals and only the tip wanders.
        // Summed sines rather than noise because this must be reproducible frame
        // for frame in a capture, and because a 1/f-ish sum is what a real flame
        // spectrum looks like anyway.
        float t = uTime * 1.7 + aPhase;
        float amp = uParams.y * vT * vT;
        p.x += ( sin( t * 3.10 ) * 0.6 + sin( t * 1.31 + 1.7 ) * 0.4 ) * amp;
        p.z += ( sin( t * 2.70 + 2.2 ) * 0.6 + sin( t * 1.07 + 0.4 ) * 0.4 ) * amp;
        // Height flutter: the plume stretches and gutters. Never below 0.55 of
        // its rest height or the fire visibly "blinks out", which reads as a bug.
        float stretch = 1.0 + uParams.z * ( sin( t * 2.3 ) * 0.5 + sin( t * 0.91 + 2.6 ) * 0.5 );
        p.y *= max( 0.55, stretch );
        // Pinch the waist when the plume stretches — conservation of fuel, and it
        // is what stops the stretch reading as a uniform scale.
        p.xz *= mix( 1.06, 0.92, clamp( stretch - 0.7, 0.0, 1.0 ) );

        vec4 world = modelMatrix * vec4( aBase + p, 1.0 );
        vNrm = normalize( mat3( modelMatrix ) * normal );
        vView = normalize( cameraPosition - world.xyz );
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vT;
      varying float vPhase;
      varying float vGain;
      varying vec3 vNrm;
      varying vec3 vView;
      uniform float uTime;
      uniform vec3 uParams;
      uniform vec3 uHot;
      uniform vec3 uCore;
      uniform vec3 uDark;

      void main() {
        // --- colour ramp -------------------------------------------------
        // Near-white at the root, saturated orange through the body, deep red
        // guttering at the tip. Two mixes rather than one because the middle of
        // the ramp is where fire actually lives and a single lerp spends most of
        // its range on the two ends.
        vec3 c = mix( uHot, uCore, smoothstep( 0.0, 0.34, vT ) );
        c = mix( c, uDark * 3.4, smoothstep( 0.34, 1.0, vT ) );

        // --- brightness --------------------------------------------------
        // Falls off fast: 80% of the emitted light comes from the bottom third,
        // which is what keeps the bright AREA small enough that the tone mapper
        // never clips a large patch to white.
        float a = pow( 1.0 - vT, 2.1 );
        // Flicker, same phase family as the light's, so the floor brightens on
        // the same beat the flame does.
        float t = uTime * 1.7 + vPhase;
        a *= 0.80 + 0.20 * ( sin( t * 5.3 ) * 0.5 + sin( t * 2.17 + 1.1 ) * 0.5 );
        // Volume cue: the plume is a hollow shell drawn double-sided, so a ray
        // through the middle crosses two sheets and one along the silhouette
        // crosses them at a grazing angle. Weighting by facing makes the core
        // read as denser than the edge, which is what a real plume does.
        float facing = abs( dot( normalize( vNrm ), normalize( vView ) ) );
        a *= 0.42 + 0.58 * facing;

        // Ragged tip: two travelling sine bands eat into the top of the plume so
        // the silhouette is never a clean cone.
        float lick = 0.5 + 0.5 * sin( vT * 11.0 - uTime * 5.5 + vPhase * 3.0 );
        a *= mix( 1.0, lick, smoothstep( 0.45, 1.0, vT ) * 0.65 );

        gl_FragColor = vec4( c * a * vGain * uParams.x, 1.0 );
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  mat.name = 'mn.world.flame';
  return mat;
}

/**
 * Bake every flame in the level into ONE geometry.
 *
 * @param {Array<{x,y,z,height,radius,gain,phase}>} plumes
 */
export function buildFlameGeometry(plumes) {
  if (!plumes.length) return null;
  const parts = [];
  const phases = [];
  const gains = [];
  const bases = [];
  const m = new THREE.Matrix4();

  for (const p of plumes) {
    const src = plumeGeo(p.height, p.radius);
    const g = toFlat(src);
    if (g !== src) src.dispose();
    // The plume's own vertices stay in LOCAL space; the world position rides in
    // `aBase`, so the vertex shader can sway around the base rather than around
    // the world origin.
    const n = g.attributes.position.count;
    for (let i = 0; i < n; i++) { phases.push(p.phase); gains.push(p.gain); bases.push(p.x, p.y, p.z); }
    parts.push(g);
    void m;
  }

  const merged = mergeAll(parts, true);
  if (!merged) return null;
  merged.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(phases), 1));
  merged.setAttribute('aGain', new THREE.BufferAttribute(new Float32Array(gains), 1));
  merged.setAttribute('aBase', new THREE.BufferAttribute(new Float32Array(bases), 3));
  // The bounding sphere has to cover the world-space bases, not the local
  // plumes, or frustum culling drops every flame the moment the camera moves.
  let cx = 0, cy = 0, cz = 0;
  for (const p of plumes) { cx += p.x; cy += p.y; cz += p.z; }
  cx /= plumes.length; cy /= plumes.length; cz /= plumes.length;
  let r = 0;
  for (const p of plumes) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy, p.z - cz) + p.height * 2);
  merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r + 1);
  return merged;
}

/**
 * The iron body of a floor brazier: a surface of revolution, so the foot, the
 * stem and the bowl are ONE lathe rather than three stacked cylinders.
 *
 * The profile returns down the inside of the bowl, so it is a real vessel: at
 * this camera pitch you look into it, and a solid cone would be obvious.
 */
export function brazierBodyGeo(scale = 1) {
  const profile = [
    new THREE.Vector2(0.00, 0.000),
    new THREE.Vector2(0.50, 0.010),
    new THREE.Vector2(0.48, 0.110),
    new THREE.Vector2(0.19, 0.190),
    new THREE.Vector2(0.105, 0.560),
    new THREE.Vector2(0.135, 1.010),
    new THREE.Vector2(0.30, 1.150),
    new THREE.Vector2(0.58, 1.545),
    new THREE.Vector2(0.545, 1.560),
    new THREE.Vector2(0.27, 1.215),
  ].map((v) => new THREE.Vector2(v.x * scale, v.y * scale));
  // 14 radial segments: at the hero boom a brazier is ~40 px across, so the
  // facet count stops being visible well before 14 and every extra segment is
  // another 14 triangles through a software rasteriser.
  const g = new THREE.LatheGeometry(profile, 14);
  g.computeVertexNormals();
  return g;
}

/**
 * A tripod stand for a great brazier — three splayed iron legs with a ring.
 * Only the hall and the arena get these; it is what makes a great brazier read
 * as a different OBJECT from a corridor sconce rather than as the same one
 * scaled up.
 */
export function brazierStandGeo(scale, rng) {
  const parts = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rng.range(-0.05, 0.05);
    const leg = prismGeo(0.075 * scale, 0.05 * scale, 1.25 * scale, 4, 0);
    e.set(Math.cos(a) * 0.20, -a, Math.sin(a) * 0.20);
    q.setFromEuler(e);
    m.compose(v.set(Math.cos(a) * 0.20 * scale, 0.62 * scale, Math.sin(a) * 0.20 * scale), q, s);
    leg.applyMatrix4(m);
    parts.push(normalise(leg));
    // Foot.
    const foot = blockGeo(0.20 * scale, 0.07 * scale, 0.30 * scale, rng, 0.01);
    m.makeTranslation(Math.cos(a) * 0.40 * scale, 0.035 * scale, Math.sin(a) * 0.40 * scale);
    foot.applyMatrix4(m);
    parts.push(normalise(foot));
  }
  const ring = new THREE.TorusGeometry(0.30 * scale, 0.032 * scale, 4, 12);
  ring.rotateX(Math.PI * 0.5);
  m.makeTranslation(0, 0.86 * scale, 0);
  ring.applyMatrix4(m);
  parts.push(normalise(ring));
  return mergeAll(parts, true);
}

/**
 * The coal bed: five to eight SEPARATE lumps, not a dome.
 *
 * Separate is the whole point. Individual coals have gaps between them that stay
 * dark, so the bed has internal contrast and the eye reads embers; a single
 * emissive hemisphere has none and reads as a bulb. They also sit BELOW the bowl
 * rim, so what you see is a bowl full of light rather than a ball on a stick.
 */
export function coalBedGeo(radius, rng) {
  const parts = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();
  const n = rng.int(6, 10);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * radius * 0.86;
    const k = rng.range(0.055, 0.115) * (radius / 0.34);
    const g = new THREE.IcosahedronGeometry(k, 0);
    e.set(rng.range(0, 3.14), rng.range(0, 3.14), rng.range(0, 3.14));
    q.setFromEuler(e);
    s.set(rng.range(0.8, 1.4), rng.range(0.5, 0.9), rng.range(0.8, 1.4));
    m.compose(v.set(Math.cos(a) * r, rng.range(-0.02, 0.05), Math.sin(a) * r), q, s);
    g.applyMatrix4(m);
    parts.push(normalise(g));
  }
  return mergeAll(parts, true);
}

/**
 * A wall sconce: an iron bracket with a shallow cup, carrying one small flame.
 * The corridor's light source, and much dimmer than a brazier — the contrast
 * between the two is what makes a corridor feel like a corridor.
 */
export function sconceGeo(rng) {
  const parts = [];
  const m = new THREE.Matrix4();
  // Back plate against the wall.
  parts.push(normalise(blockGeo(0.19, 0.30, 0.06, rng, 0.01)));
  // Arm curving out and up.
  const arm = prismGeo(0.030, 0.026, 0.42, 4, 0);
  m.makeRotationX(-0.85);
  arm.applyMatrix4(m);
  m.makeTranslation(0, 0.12, 0.16);
  arm.applyMatrix4(m);
  parts.push(normalise(arm));
  // Cup.
  const cup = new THREE.LatheGeometry([
    new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.10, 0.02),
    new THREE.Vector2(0.135, 0.10), new THREE.Vector2(0.125, 0.115), new THREE.Vector2(0.075, 0.03),
  ], 10);
  m.makeTranslation(0, 0.30, 0.31);
  cup.applyMatrix4(m);
  parts.push(normalise(cup));
  return mergeAll(parts, true);
}

/**
 * A candelabrum: an iron stem on a tripod foot with N arms, each carrying a
 * candle. Used on altars, in the shrine and around the arena's central platform.
 */
export function candelabrumGeo(arms, height, rng) {
  const parts = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);

  parts.push(normalise(prismGeo(0.05, 0.035, height, 6, 0.2)).translate(0, height * 0.5, 0));
  // Foot: three splayed toes.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const toe = blockGeo(0.09, 0.05, 0.30, rng, 0.006);
    e.set(0, -a, 0);
    q.setFromEuler(e);
    m.compose(v.set(Math.cos(a) * 0.14, 0.03, Math.sin(a) * 0.14), q, s);
    toe.applyMatrix4(m);
    parts.push(normalise(toe));
  }
  const cups = [];
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rng.range(-0.08, 0.08);
    const reach = 0.34 + rng.range(-0.03, 0.03);
    const y = height * (0.82 + rng.range(-0.04, 0.04));
    // Arm: a short bar sloping up and out.
    const bar = prismGeo(0.022, 0.020, reach * 1.25, 4, 0);
    e.set(Math.PI * 0.5 - 0.42, -a, 0, 'YXZ');
    q.setFromEuler(e);
    m.compose(v.set(Math.cos(a) * reach * 0.5, y - 0.06, Math.sin(a) * reach * 0.5), q, s);
    bar.applyMatrix4(m);
    parts.push(normalise(bar));
    const cy = y + reach * 0.42;
    const pan = new THREE.LatheGeometry([
      new THREE.Vector2(0, 0), new THREE.Vector2(0.07, 0.008), new THREE.Vector2(0.075, 0.03),
    ], 8);
    m.makeTranslation(Math.cos(a) * reach, cy, Math.sin(a) * reach);
    pan.applyMatrix4(m);
    parts.push(normalise(pan));
    cups.push({ x: Math.cos(a) * reach, y: cy + 0.02, z: Math.sin(a) * reach });
  }
  return { geo: mergeAll(parts, true), cups };
}

/** A wax candle stub. Kept as its own geometry so it can use a bone-ish
 *  material rather than iron — wax next to iron is a value break the eye needs. */
export function candleGeo(height, radius, rng) {
  const g = new THREE.CylinderGeometry(radius * 0.94, radius, height, 7, 1);
  const p = g.attributes.position;
  // Melted: the top rim slumps unevenly and the sides run.
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > height * 0.3) {
      const a = Math.atan2(p.getZ(i), p.getX(i));
      p.setY(i, y - Math.abs(Math.sin(a * 3.0 + rng.float() * 0.1)) * height * 0.12);
    }
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  const flat = toFlat(g);
  if (flat !== g) g.dispose();
  return flat;
}

/**
 * Attach a brazier: emits the iron body, the stand, the coal bed, the collision
 * box, one plume record and one light record.
 *
 * `class` decides everything: a `great` brazier is a 1.4x bonfire on a tripod
 * that lights half a hall; a `standard` one is a bowl on a stem; a `sconce` is a
 * bracket on a wall. Three classes with genuinely different intensities is what
 * produces pools of light with real darkness between them instead of a uniform
 * wash — which is the difference between art direction and coverage.
 */
export function brazier(B, o) {
  const rng = B.rng;
  const kind = o.kind ?? 'standard';
  const scale = kind === 'great' ? 1.42 : kind === 'small' ? 0.78 : 1.0;
  const yaw = rng.range(0, Math.PI * 2);
  // A degree or two off plumb, different per instance. Nothing in a crypt is
  // straight, and a row of perfectly vertical identical props is the most
  // obvious tell that a level was placed by a loop.
  const tiltX = rng.range(-0.035, 0.035);
  const tiltZ = rng.range(-0.035, 0.035);

  const put = (geo, mat, group, lift = 0) => {
    if (!geo) return;
    const e = new THREE.Euler(tiltX, yaw, tiltZ);
    const q = new THREE.Quaternion().setFromEuler(e);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(o.x, (o.y ?? 0) + lift, o.z), q, new THREE.Vector3(1, 1, 1)
    );
    B.push(mat, group, geo, m);
  };

  if (kind === 'great') put(brazierStandGeo(scale, rng), B.mat.iron, 'iron');
  put(brazierBodyGeo(scale), B.mat.iron, 'iron', kind === 'great' ? 1.05 * scale : 0);

  const bowlY = (kind === 'great' ? 1.05 * scale : 0) + 1.17 * scale;
  put(coalBedGeo(0.34 * scale, rng), B.mat.ember, 'ember', bowlY);

  B.solid(o.x, (o.y ?? 0) + 0.8 * scale, o.z, 0.55 * scale, 0.8 * scale, 0.55 * scale, 0, 'metal');

  const flameY = bowlY + 0.06 * scale;
  B.flame({
    x: o.x, y: (o.y ?? 0) + flameY, z: o.z,
    height: (kind === 'great' ? 0.95 : 0.62) * scale,
    radius: (kind === 'great' ? 0.26 : 0.185) * scale,
    gain: kind === 'great' ? 1.15 : 1.0,
    phase: rng.range(0, 100),
  });
  B.light({
    kind: kind === 'great' ? 'brazierGreat' : 'brazier',
    x: o.x, y: (o.y ?? 0) + flameY + 0.10, z: o.z,
    phase: rng.range(0, 100), rate: rng.range(0.70, 1.20),
  });
}

/** A wall sconce with its bracket, flame and light. `yaw` faces AWAY from the
 *  wall (the direction the bracket reaches). */
export function sconce(B, o) {
  const rng = B.rng;
  const geo = sconceGeo(rng);
  if (geo) B.push(B.mat.iron, o.group ?? 'far', geo, matAt(o.x, o.y, o.z, o.yaw ?? 0));
  const cy = Math.cos(o.yaw ?? 0), sy = Math.sin(o.yaw ?? 0);
  const fx = o.x + sy * 0.31, fz = o.z + cy * 0.31;
  B.flame({ x: fx, y: o.y + 0.34, z: fz, height: 0.30, radius: 0.085, gain: 0.85, phase: rng.range(0, 100) });
  B.light({ kind: 'sconce', x: fx, y: o.y + 0.40, z: fz, phase: rng.range(0, 100), rate: rng.range(0.8, 1.4) });
}

/** A candelabrum with N lit candles. One light for the whole stand — N point
 *  lights for N candles would eat the entire slot budget for 3 lux. */
export function candelabrum(B, o) {
  const rng = B.rng;
  const arms = o.arms ?? rng.int(3, 5);
  const h = o.height ?? rng.range(0.95, 1.35);
  const { geo, cups } = candelabrumGeo(arms, h, rng);
  const yaw = o.yaw ?? rng.range(0, Math.PI * 2);
  if (geo) B.push(B.mat.iron, 'iron', geo, matAt(o.x, o.y ?? 0, o.z, yaw));
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  for (const c of cups) {
    const wx = o.x + cy * c.x + sy * c.z;
    const wz = o.z - sy * c.x + cy * c.z;
    const ch = rng.range(0.10, 0.24);
    B.push(B.mat.wax, 'wax', candleGeo(ch, 0.026, rng), matAt(wx, (o.y ?? 0) + c.y + ch * 0.5, wz, 0));
    B.flame({
      x: wx, y: (o.y ?? 0) + c.y + ch + 0.012, z: wz,
      height: 0.085, radius: 0.020, gain: 0.55, phase: rng.range(0, 100),
    });
  }
  B.light({
    kind: 'candle', x: o.x, y: (o.y ?? 0) + h * 0.95, z: o.z,
    phase: rng.range(0, 100), rate: rng.range(0.9, 1.6),
  });
  B.solid(o.x, (o.y ?? 0) + h * 0.5, o.z, 0.22, h * 0.5, 0.22, 0, 'metal');
}

/** A cluster of free-standing candles melted onto a floor or a step. No light of
 *  its own — these are texture, and their job is to give the shrine's violet
 *  something warm to be measured against. */
export function candleCluster(B, o) {
  const rng = B.rng;
  const n = o.count ?? rng.int(3, 7);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.float()) * (o.radius ?? 0.5);
    const x = o.x + Math.cos(a) * r, z = o.z + Math.sin(a) * r;
    const h = rng.range(0.07, 0.26);
    // Wax pool under the candle: a squashed disc.
    B.push(B.mat.wax, 'wax', prismGeo(rng.range(0.05, 0.09), rng.range(0.04, 0.07), 0.018, 7, 0),
      matAt(x, (o.y ?? 0) + 0.009, z, 0));
    B.push(B.mat.wax, 'wax', candleGeo(h, rng.range(0.019, 0.027), rng), matAt(x, (o.y ?? 0) + h * 0.5 + 0.015, z, 0));
    B.flame({ x, y: (o.y ?? 0) + h + 0.028, z, height: 0.07, radius: 0.017, gain: 0.5, phase: rng.range(0, 100) });
  }
  if (o.light !== false) {
    B.light({ kind: 'candle', x: o.x, y: (o.y ?? 0) + 0.35, z: o.z, phase: rng.range(0, 100), rate: rng.range(1.0, 1.7) });
  }
}
