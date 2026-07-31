import * as THREE from 'three';
import { spriteUv } from './atlas.js';

/**
 * MONARCH — mesh-based effects: shockwave rings, energy columns, beams, ground
 * glyphs and the ARISE silhouette.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE MESHES AND NOT PARTICLES
 *
 * A particle is a quad with a fixed 128 px sprite. That is exactly right for
 * something small and numerous, and exactly wrong for something large and
 * singular: a 6 m nova ring drawn as one sprite is four texels per metre, and it
 * reads as a blurry disc. Anything whose SHAPE is the effect — a ring, a column,
 * a beam, a silhouette — is geometry with a procedural shader, so its edge is as
 * sharp as the framebuffer and its animation is a uniform write rather than a
 * respawn.
 *
 * Every pool member is a separate mesh with a CLONED material, so each carries
 * its own uniforms. That costs nothing in program count: three's cache key for a
 * ShaderMaterial is its source plus its defines, so N clones of one shader share
 * one compiled program.
 *
 * ---------------------------------------------------------------------------
 * EVERY EFFECT HERE IS SOFT AGAINST THE DEPTH BUFFER
 *
 * All four shaders take `render.depthTexture` through the same shared uniform
 * objects the particle system uses. A shockwave ring that cuts a hard line into
 * the base of a wall is the single most obvious tell in this whole subsystem,
 * because the ring is big and the line is long.
 */

/* ==========================================================================
 * Shared GLSL
 * ========================================================================== */

const DEPTH_UNIFORMS = /* glsl */ `
uniform sampler2D uDepth;
uniform vec4 uProj;
uniform vec4 uScreen;
uniform float uHasDepth;

float mnLinearDepth( float d ) {
  float n = uProj.x, f = uProj.y;
  float z = d * 2.0 - 1.0;
  return ( 2.0 * n * f ) / ( f + n - z * ( f - n ) );
}

float mnSoft( float viewZ, float fade ) {
  if ( uHasDepth < 0.5 ) return 1.0;
  float d = texture2D( uDepth, gl_FragCoord.xy * uScreen.zw ).x;
  return clamp( ( mnLinearDepth( d ) - viewZ ) / fade, 0.0, 1.0 );
}
`;

/** Bind the four shared depth uniform OBJECTS (by reference) into a set. */
function depthUniforms(shared) {
  return {
    uDepth: shared.uDepth,
    uProj: shared.uProj,
    uScreen: shared.uScreen,
    uHasDepth: shared.uHasDepth,
  };
}

/* ==========================================================================
 * 1. Shockwave ring — a flat expanding pressure front on the ground
 * ========================================================================== */

/**
 * A NARROW annulus, from 0.80 to 1.06 of the mesh scale.
 *
 * Two reasons, and the second one was measured rather than predicted:
 *
 *  - Fill. A full disc rasterises the whole circle every frame; at a 4 m ARISE
 *    shockwave that is a fifth of the screen for a front occupying a fiftieth
 *    of it.
 *  - Bloom. The first draft used 0.55..1.06 — a 2 m wide band at a 4 m radius.
 *    Even with the alpha concentrated in a thin lip, the band's own soft
 *    shoulders were bright enough to feed render's 6-level bloom pyramid, and
 *    the pyramid turned every shockwave into a 2 m soft white arc that washed
 *    the room out. A pressure front has to be geometrically thin, not just
 *    shaded thin.
 */
function ringGeometry(segments = 56) {
  const inner = 0.80, outer = 1.06;
  const pos = new Float32Array((segments + 1) * 2 * 3);
  const aR = new Float32Array((segments + 1) * 2);
  const aA = new Float32Array((segments + 1) * 2);
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const k = i * 2;
    pos[k * 3] = c * inner; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = s * inner;
    pos[(k + 1) * 3] = c * outer; pos[(k + 1) * 3 + 1] = 0; pos[(k + 1) * 3 + 2] = s * outer;
    aR[k] = 0; aR[k + 1] = 1;
    aA[k] = a; aA[k + 1] = a;
    if (i < segments) {
      const b = k + 2;
      idx.push(k, k + 1, b, k + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aR', new THREE.BufferAttribute(aR, 1));
  g.setAttribute('aA', new THREE.BufferAttribute(aA, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const RING_VERT = /* glsl */ `
attribute float aR;
attribute float aA;
varying float vR;
varying float vA;
varying float vViewZ;
void main() {
  vR = aR;
  vA = aA;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const RING_FRAG = /* glsl */ `
precision highp float;
${DEPTH_UNIFORMS}
uniform vec3 uColor;
uniform vec4 uParams;   // x = intensity, y = front sharpness, z = time, w = wobble
varying float vR;
varying float vA;
varying float vViewZ;

void main() {
  // The front is at the OUTER edge and is sharp; the wake trails inward and is
  // soft. A symmetric band reads as a ring of light; this reads as a pressure
  // wave, and the difference is entirely in the asymmetry.
  float front = pow( clamp( vR, 0.0, 1.0 ), uParams.y );
  float lip   = exp( -pow( ( vR - 0.80 ) * 4.6, 2.0 ) );
  float wake  = pow( 1.0 - clamp( vR, 0.0, 1.0 ), 1.7 ) * 0.30;

  // Azimuthal break-up: a perfectly even ring is a procedural artefact. Two
  // incommensurate harmonics, phase-advanced by time so the front boils.
  float az = 0.72 + 0.28 * sin( vA * 9.0 + uParams.z * 4.1 )
                  + 0.16 * sin( vA * 23.0 - uParams.z * 2.3 );
  az = clamp( az * ( 1.0 + uParams.w * sin( vA * 3.0 + uParams.z ) ), 0.0, 1.6 );

  // The LIP carries the energy, not the band. At front*0.55 the whole 0.5-unit
  // annulus glowed and a 3 m shockwave rendered as a 1.4 m wide soft doughnut;
  // a pressure front is a LINE with a faint wake behind it.
  float a = ( front * 0.14 + lip * 1.45 + wake * 0.45 ) * az * uParams.x;
  a *= mnSoft( vViewZ, 0.55 );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor * ( 0.55 + 1.05 * lip ), a );
}
`;

/* ==========================================================================
 * 2. Energy column — the extraction vortex and the monarch aura
 * ========================================================================== */

const COLUMN_VERT = /* glsl */ `
varying float vY;
varying float vA;
varying float vRim;
varying float vViewZ;
void main() {
  vY = uv.y;
  vA = uv.x * 6.2831853;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewZ = -mv.z;
  vec3 n = normalize( normalMatrix * normal );
  vec3 v = normalize( -mv.xyz );
  // Edge-on is brighter: a hollow tube presents more material along its
  // silhouette than through its middle, and that single term is what stops a
  // cylinder from reading as a cylinder.
  vRim = 1.0 - abs( dot( n, v ) );
  gl_Position = projectionMatrix * mv;
}
`;

const COLUMN_FRAG = /* glsl */ `
precision highp float;
${DEPTH_UNIFORMS}
uniform vec3 uColor;
uniform vec3 uHot;
uniform vec4 uParams;   // x = intensity, y = time, z = rise speed, w = fill (0..1)
varying float vY;
varying float vA;
varying float vRim;
varying float vViewZ;

void main() {
  // Vertical streaks that travel UPWARD. Downward streaks read as a waterfall;
  // upward ones read as something being drawn out of the ground, which is the
  // entire Solo Leveling extraction beat.
  float t = uParams.y;
  float streak = 0.55 + 0.45 * sin( vA * 7.0 + vY * 14.0 - t * uParams.z );
  streak *= 0.60 + 0.40 * sin( vA * 17.0 - vY * 23.0 - t * uParams.z * 1.7 );

  // Body: dense at the base, thinning to nothing at the top.
  float body = pow( max( 0.0, 1.0 - vY ), 1.7 );
  // The fill front: the column builds from the ground up.
  float fill = 1.0 - smoothstep( uParams.w - 0.22, uParams.w + 0.03, vY );
  float edge = exp( -pow( ( vY - uParams.w ) * 11.0, 2.0 ) );

  // RIM-DOMINATED, with almost no floor. A hollow tube whose face is lit at a
  // constant 0.25 rasterises as a solid cylinder of milk — measured, and it was
  // the single worst artefact in the first ARISE capture. Nearly all of the
  // energy has to live on the silhouette and in the streaks, so that what the
  // eye sees is two bright vertical edges with structure travelling up them.
  float rim = pow( clamp( vRim, 0.0, 1.0 ), 2.6 );
  float a = ( body * ( 0.05 + 0.45 * streak ) * ( 0.03 + 1.0 * rim ) + edge * 0.38 ) * fill * uParams.x;
  a *= mnSoft( vViewZ, 0.6 );
  if ( a < 0.004 ) discard;

  vec3 c = mix( uColor, uHot, clamp( edge * 1.3 + rim * 0.35, 0.0, 1.0 ) );
  gl_FragColor = vec4( c, a );
}
`;

/* ==========================================================================
 * 3. The ARISE silhouette
 * ========================================================================== */

const SIL_VERT = /* glsl */ `
varying float vY;
varying float vRim;
varying float vViewZ;
uniform vec4 uParams;
void main() {
  vY = uv.y;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewZ = -mv.z;
  vec3 n = normalize( normalMatrix * normal );
  vec3 v = normalize( -mv.xyz );
  vRim = 1.0 - abs( dot( n, v ) );
  gl_Position = projectionMatrix * mv;
}
`;

const SIL_FRAG = /* glsl */ `
precision highp float;
${DEPTH_UNIFORMS}
uniform vec3 uCore;     // violet rim
uniform vec3 uDeep;     // the body — near black, NOT black
uniform vec4 uParams;   // x = reveal 0..1, y = opacity, z = time, w = rim gain
varying float vY;
varying float vRim;
varying float vViewZ;

void main() {
  // Materialise from the feet up, with a hot violet line at the front. This is
  // the shape of the beat: the shadow does not fade in, it is DRAWN.
  float reveal = uParams.x;
  float below = 1.0 - smoothstep( reveal - 0.14, reveal + 0.02, vY );
  float edge = exp( -pow( ( vY - reveal ) * 13.0, 2.0 ) );

  // Exponent 4.5, not 2.3, and this is the difference between a shadow soldier
  // and a glowing statue. The camera looks down at 52 degrees, so a vertical
  // surface facing the lens still has n.v = cos(52) = 0.62 and therefore a
  // fresnel term of 0.38 — at a low exponent the ENTIRE FRONT of the figure
  // lights up, not just its outline, and at 90 px of screen height that is the
  // whole silhouette. A high exponent keeps the violet on the two-pixel rim
  // where it belongs.
  float rim = pow( clamp( vRim, 0.0, 1.0 ), 4.5 ) * uParams.w;

  // ARCHITECTURE.md: "Shadow soldiers are near-black, which is NOT flat black —
  // without a violet fresnel and faint internal variation they become a hole in
  // the frame." The internal variation is a slow vertical banding, deliberately
  // low contrast, so the body has a surface without becoming a texture.
  float grain = 0.85 + 0.15 * sin( vY * 26.0 + uParams.z * 1.7 );

  // The rim and the front are ACCENTS on a black body, not the body itself.
  // MEASURED: at rim*2.6 + edge*4.0 the fresnel alone reached 2.6 linear and the
  // materialisation front reached 4.0, both far past the AgX shoulder, and the
  // "near-black soldier" rendered as a white vase. A shadow soldier is defined
  // by the light it BLOCKS; the violet is a hairline around it.
  // Clamped: an unbounded sum here is what let the fresnel and the front stack
  // past the tone curve's shoulder and turn a black body white.
  vec3 c = uDeep * grain + uCore * min( 1.15, rim * 0.85 + edge * 1.35 );
  // Nearly opaque in the body: the whole point is that the soldier blocks the
  // room behind it.
  // COVERAGE, not opacity. This material is OPAQUE — see the note on the
  // material below — so the reveal is a discard threshold rather than an alpha
  // ramp, and the edge band is what hides the hard boundary.
  float cov = ( 0.95 + rim * 0.30 + edge * 0.45 ) * below * uParams.y;
  if ( cov < 0.42 ) discard;
  gl_FragColor = vec4( c, 1.0 );
}
`;

/**
 * The silhouette's profile: a cloaked figure, revolved.
 *
 * Revolved rather than modelled because the shape has to read from 360 degrees
 * with no rig, no animation and no skinning, for about 400 ms. The proportions
 * are the ones that make a black shape read as a person at 120 px of height:
 * a wide hem, a narrow waist at 0.55, a hard shoulder shelf at 0.80, and a head
 * that is deliberately slightly too small, which is what makes the shoulders
 * read as broad.
 */
function silhouetteGeometry(segments = 22) {
  const profile = [
    [0.00, 0.00], [0.34, 0.01], [0.40, 0.10], [0.36, 0.28],
    [0.30, 0.44], [0.25, 0.58], [0.28, 0.68], [0.38, 0.775],
    [0.40, 0.805], [0.24, 0.825], [0.12, 0.845], [0.10, 0.875],
    [0.15, 0.915], [0.16, 0.955], [0.10, 0.99], [0.00, 1.0],
  ];
  const pts = profile.map((p) => new THREE.Vector2(Math.max(1e-4, p[0]), p[1]));
  const g = new THREE.LatheGeometry(pts, segments);
  // LatheGeometry's v runs along the profile, which is what the shader reads as
  // height — but it is normalised over the profile INDEX, not over y. Rewrite it
  // so `uv.y` is true normalised height and the reveal front is horizontal.
  const uv = g.getAttribute('uv');
  const pos = g.getAttribute('position');
  for (let i = 0; i < uv.count; i++) uv.setY(i, pos.getY(i));
  uv.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ==========================================================================
 * 4. Ground glyph — a large sprite quad laid flat, for magic circles
 * ========================================================================== */

const GLYPH_VERT = /* glsl */ `
varying vec2 vUv;
varying float vViewZ;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const GLYPH_FRAG = /* glsl */ `
precision highp float;
${DEPTH_UNIFORMS}
uniform sampler2D uAtlas;
uniform vec4 uRect;      // atlas sub-rectangle: x, y, w, h
uniform vec3 uColor;
uniform vec4 uParams;    // x = intensity, y = scribe 0..1, z = time, w = spin
varying vec2 vUv;
varying float vViewZ;

void main() {
  // Spin about the centre, in UV space, so the mesh never has to be re-oriented.
  vec2 p = vUv - 0.5;
  float s = sin( uParams.w ), c = cos( uParams.w );
  p = vec2( p.x * c - p.y * s, p.x * s + p.y * c );
  vec4 tex = texture2D( uAtlas, uRect.xy + ( p + 0.5 ) * uRect.zw );

  // "Scribe": the glyph draws itself anticlockwise from the top rather than
  // fading in, which is what makes it read as being WRITTEN. The wedge is in
  // polar angle, so the reveal follows the circle.
  float ang = atan( p.y, p.x );
  float u = fract( ( ang + 1.5707963 ) / 6.2831853 );
  float scribe = smoothstep( uParams.y, uParams.y - 0.22, u );
  float head = exp( -pow( ( u - uParams.y ) * 26.0, 2.0 ) ) * step( uParams.y, 1.0 );

  float a = tex.a * ( scribe + head * 1.4 ) * uParams.x;
  a *= mnSoft( vViewZ, 0.45 );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor * tex.rgb * ( 1.0 + head * 2.2 ), a );
}
`;

/* ==========================================================================
 * 5. Beam — a tapered tube between two points
 * ========================================================================== */

const BEAM_FRAG = /* glsl */ `
precision highp float;
${DEPTH_UNIFORMS}
uniform vec3 uColor;
uniform vec3 uHot;
uniform vec4 uParams;   // x = intensity, y = time, z = travel 0..1, w = unused
varying float vY;
varying float vA;
varying float vRim;
varying float vViewZ;

void main() {
  float travel = 1.0 - smoothstep( uParams.z - 0.10, uParams.z, vY );
  float rim = pow( clamp( vRim, 0.0, 1.0 ), 1.5 );
  // Longitudinal ripple travelling along the beam.
  float ripple = 0.6 + 0.4 * sin( vY * 34.0 - uParams.y * 22.0 + vA * 2.0 );
  float a = ( 0.30 + 0.95 * rim ) * ripple * travel * uParams.x;
  a *= mnSoft( vViewZ, 0.35 );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( mix( uColor, uHot, rim * 0.7 ), a );
}
`;

/* ==========================================================================
 * The pool
 * ========================================================================== */

/** Common material settings for every additive effect mesh. */
function additive(uniforms, vert, frag, name, side = THREE.DoubleSide) {
  const m = new THREE.ShaderMaterial({
    uniforms, vertexShader: vert, fragmentShader: frag,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side, toneMapped: false,
  });
  m.name = name;
  return m;
}

class Slot {
  constructor(mesh, material) {
    this.mesh = mesh;
    this.material = material;
    this.busy = false;
    this.ticket = 0;
    this.age = 0;
    this.life = 1;
  }
}

/**
 * Manages four small pools of effect meshes. Everything is built in the
 * constructor — nothing is created or destroyed at runtime.
 */
export class MeshFx {
  constructor(scene, sharedUniforms, atlas) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'mn.fx.mesh';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    const D = () => depthUniforms(sharedUniforms);
    this._nextTicket = 1;

    // ---- rings -------------------------------------------------------------
    this.ringGeo = ringGeometry();
    this.ringBase = additive({
      ...D(),
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uParams: { value: new THREE.Vector4(1, 3, 0, 0) },
    }, RING_VERT, RING_FRAG, 'mn.fx.ring');
    this.rings = this._makePool(6, this.ringGeo, this.ringBase, 'ring', 20);

    // ---- columns -----------------------------------------------------------
    // Open-ended so there is no cap to see through, 20 radial segments (a 1.2 m
    // column is ~90 px wide at the gameplay camera and 20 segments is already
    // sub-pixel), and 6 height segments so the fill front has something to
    // interpolate across.
    this.columnGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 6, true);
    this.columnGeo.translate(0, 0.5, 0);   // origin at the base, not the centre
    this.columnBase = additive({
      ...D(),
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uHot: { value: new THREE.Vector3(1, 1, 1) },
      uParams: { value: new THREE.Vector4(1, 0, 6, 1) },
    }, COLUMN_VERT, COLUMN_FRAG, 'mn.fx.column');
    this.columns = this._makePool(4, this.columnGeo, this.columnBase, 'column', 21);

    // ---- beams -------------------------------------------------------------
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 8, true);
    this.beamGeo.translate(0, 0.5, 0);
    this.beamBase = additive({
      ...D(),
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uHot: { value: new THREE.Vector3(1, 1, 1) },
      uParams: { value: new THREE.Vector4(1, 0, 1, 0) },
    }, COLUMN_VERT, BEAM_FRAG, 'mn.fx.beam');
    this.beams = this._makePool(3, this.beamGeo, this.beamBase, 'beam', 21);

    // ---- ground glyphs -----------------------------------------------------
    this.glyphGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.glyphGeo.rotateX(-Math.PI * 0.5);
    this.glyphBase = additive({
      ...D(),
      uAtlas: { value: atlas },
      uRect: { value: new THREE.Vector4(0, 0, 0.25, 0.25) },
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uParams: { value: new THREE.Vector4(1, 1, 0, 0) },
    }, GLYPH_VERT, GLYPH_FRAG, 'mn.fx.glyph', THREE.DoubleSide);
    this.glyphs = this._makePool(4, this.glyphGeo, this.glyphBase, 'glyph', 5);

    // ---- silhouettes -------------------------------------------------------
    this.silGeo = silhouetteGeometry();
    /**
     * The silhouette is the ONE thing in this file that is OPAQUE, and that is
     * the most important line in the class.
     *
     * MEASURED. As a transparent material it was excluded from render's MRT
     * prepass (which is correct for a gas), so `sky`'s fog and volumetric passes
     * — which reconstruct world position from the prepass DEPTH — computed their
     * in-scattering for the FLOOR BEHIND the figure and then painted it over the
     * figure's pixels. A soldier whose body is 0.02 linear came out the same
     * grey-lavender as the fog around it, and the magic circle on the ground
     * showed through him. No amount of shader tuning could fix it, because the
     * fog was applied after this material had already had its say.
     *
     * Opaque + depth-writing puts him in the prepass, so the fog is computed at
     * HIS distance, GTAO grounds him, and he occludes what is behind him — all
     * of which is exactly what a solid body should do. The cost is that the
     * materialisation reveal becomes a discard rather than a fade, which the
     * bright `edge` band was already covering.
     */
    this.silBase = new THREE.ShaderMaterial({
      uniforms: {
        ...D(),
        uCore: { value: new THREE.Vector3(0.6, 0.4, 1) },
        uDeep: { value: new THREE.Vector3(0.012, 0.008, 0.03) },
        uParams: { value: new THREE.Vector4(0, 1, 0, 1) },
      },
      vertexShader: SIL_VERT,
      fragmentShader: SIL_FRAG,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NoBlending,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    this.silBase.name = 'mn.fx.silhouette';
    this.silhouettes = this._makePool(3, this.silGeo, this.silBase, 'silhouette', 22, true);

    this._uv = { x: 0, y: 0, w: 0, h: 0 };
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  _makePool(n, geo, baseMat, name, renderOrder, solid = false) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const mat = i === 0 ? baseMat : baseMat.clone();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `mn.fx.${name}.${i}`;
      mesh.visible = false;
      mesh.frustumCulled = false;
      // Even the solid one never casts: it exists for 400 ms and a shadow-map
      // refit for it would cost more than the effect.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // `solid` members STAY in the prepass so fog, GTAO and SSR treat them as
      // the geometry they are. Everything else is a gas and must not.
      mesh.userData.mnNoPrepass = !solid;
      mesh.userData.mnNoShadow = true;
      mesh.renderOrder = renderOrder;
      this.group.add(mesh);
      out.push(new Slot(mesh, mat));
    }
    return out;
  }

  _take(pool, life) {
    let slot = -1;
    for (let i = 0; i < pool.length; i++) if (!pool[i].busy) { slot = i; break; }
    if (slot < 0) {
      // Steal the one closest to the end of its life.
      let best = -1;
      for (let i = 0; i < pool.length; i++) {
        const left = pool[i].life - pool[i].age;
        if (best < 0 || left < pool[best].life - pool[best].age) best = i;
      }
      slot = best;
    }
    const s = pool[slot];
    s.busy = true;
    s.age = 0;
    s.life = life;
    s.ticket = this._nextTicket++;
    s.mesh.visible = true;
    return slot;
  }

  /* ---------------------------------------------------------------- rings -- */

  /**
   * A ground shockwave.
   * @returns {number} slot index
   */
  ring(o) {
    const i = this._take(this.rings, o.life ?? 0.5);
    const s = this.rings[i];
    s.r0 = o.radius0 ?? 0.3;
    s.r1 = o.radius ?? 3.0;
    s.tilt = o.tilt ?? 0;
    s.intensity = o.intensity ?? 3.0;
    s.sharp = o.sharp ?? 3.2;
    s.wobble = o.wobble ?? 0.12;
    s.mesh.position.set(o.x, o.y + 0.03, o.z);
    s.mesh.rotation.set(s.tilt, o.yaw ?? 0, 0);
    s.mesh.scale.setScalar(s.r0);
    const c = o.color ?? WHITE;
    s.material.uniforms.uColor.value.set(c[0], c[1], c[2]);
    s.material.uniforms.uParams.value.set(s.intensity, s.sharp, 0, s.wobble);
    return i;
  }

  /* -------------------------------------------------------------- columns -- */

  column(o) {
    const i = this._take(this.columns, o.life ?? 1.0);
    const s = this.columns[i];
    s.radius = o.radius ?? 0.8;
    s.height = o.height ?? 3.0;
    s.intensity = o.intensity ?? 2.0;
    s.rise = o.rise ?? 6.0;
    s.fill = o.fill ?? 1;
    s.follow = o.follow ?? null;
    s.mesh.position.set(o.x, o.y, o.z);
    s.mesh.scale.set(s.radius, s.height, s.radius);
    const c = o.color ?? WHITE;
    const h = o.hot ?? c;
    s.material.uniforms.uColor.value.set(c[0], c[1], c[2]);
    s.material.uniforms.uHot.value.set(h[0], h[1], h[2]);
    s.material.uniforms.uParams.value.set(s.intensity, 0, s.rise, s.fill);
    return i;
  }

  /** Retune a live column — the extraction drives radius, fill and intensity
   *  across its whole timeline from one place. */
  setColumn(i, o) {
    const s = this.columns[i];
    if (!s?.busy) return false;
    if (o.x !== undefined) s.mesh.position.set(o.x, o.y, o.z);
    if (o.radius !== undefined) s.radius = o.radius;
    if (o.height !== undefined) s.height = o.height;
    s.mesh.scale.set(s.radius, s.height, s.radius);
    if (o.intensity !== undefined) s.intensity = o.intensity;
    if (o.fill !== undefined) s.fill = o.fill;
    if (o.color) s.material.uniforms.uColor.value.set(o.color[0], o.color[1], o.color[2]);
    if (o.hot) s.material.uniforms.uHot.value.set(o.hot[0], o.hot[1], o.hot[2]);
    return true;
  }

  /* ---------------------------------------------------------------- beams -- */

  /** A beam from (x0,y0,z0) to (x1,y1,z1). */
  beam(o) {
    const i = this._take(this.beams, o.life ?? 0.3);
    const s = this.beams[i];
    const dx = o.x1 - o.x0, dy = o.y1 - o.y0, dz = o.z1 - o.z0;
    const len = Math.hypot(dx, dy, dz) || 1e-3;
    s.mesh.position.set(o.x0, o.y0, o.z0);
    this._v.set(dx / len, dy / len, dz / len);
    this._q.setFromUnitVectors(this._up, this._v);
    s.mesh.quaternion.copy(this._q);
    s.mesh.scale.set(o.radius ?? 0.16, len, o.radius ?? 0.16);
    s.intensity = o.intensity ?? 3.0;
    s.travel = o.travel ?? 0;
    const c = o.color ?? WHITE;
    const h = o.hot ?? c;
    s.material.uniforms.uColor.value.set(c[0], c[1], c[2]);
    s.material.uniforms.uHot.value.set(h[0], h[1], h[2]);
    s.material.uniforms.uParams.value.set(s.intensity, 0, s.travel, 0);
    return i;
  }

  /* --------------------------------------------------------------- glyphs -- */

  /** A magic circle on the ground that scribes itself. */
  glyph(o) {
    const i = this._take(this.glyphs, o.life ?? 1.0);
    const s = this.glyphs[i];
    s.intensity = o.intensity ?? 2.0;
    s.spinRate = o.spin ?? 0.5;
    s.scribe = o.scribe ?? 0.35;   // seconds to draw itself
    s.size = o.size ?? 2.0;
    s.mesh.position.set(o.x, o.y + 0.02, o.z);
    s.mesh.scale.setScalar(s.size);
    spriteUv(o.sprite ?? 14, this._uv);
    s.material.uniforms.uRect.value.set(this._uv.x, this._uv.y, this._uv.w, this._uv.h);
    const c = o.color ?? WHITE;
    s.material.uniforms.uColor.value.set(c[0], c[1], c[2]);
    s.material.uniforms.uParams.value.set(s.intensity, 0, 0, 0);
    return i;
  }

  /* ---------------------------------------------------------- silhouettes -- */

  silhouette(o) {
    const i = this._take(this.silhouettes, o.life ?? 0.6);
    const s = this.silhouettes[i];
    s.height = o.height ?? 1.85;
    s.opacity = o.opacity ?? 1;
    s.rimGain = o.rim ?? 1;
    s.mesh.position.set(o.x, o.y, o.z);
    s.mesh.rotation.set(0, o.yaw ?? 0, 0);
    s.mesh.scale.set(s.height * 0.62, s.height, s.height * 0.62);
    const c = o.color ?? WHITE;
    s.material.uniforms.uCore.value.set(c[0], c[1], c[2]);
    const d = o.deep ?? [0.012, 0.008, 0.03];
    s.material.uniforms.uDeep.value.set(d[0], d[1], d[2]);
    s.material.uniforms.uParams.value.set(0, s.opacity, 0, s.rimGain);
    return i;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Drive every live mesh's own timeline.
   *
   * Each pool has its OWN curve, which is the point: a ring expands with an
   * exponential out (violent, then settling), a column fills with a cubic ease
   * and then holds, a silhouette reveals linearly and then holds, and a glyph
   * scribes fast and rotates forever. Sharing one curve is what makes a set of
   * effects read as a single sprite being scaled.
   */
  update(dt, time) {
    // ---- rings: expand fast, thin out ------------------------------------
    for (const s of this.rings) {
      if (!s.busy) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) { s.busy = false; s.mesh.visible = false; continue; }
      const e = 1 - Math.pow(2, -9 * t);       // expo out
      const r = s.r0 + (s.r1 - s.r0) * e;
      s.mesh.scale.setScalar(r);
      // Energy is conserved as the front expands: a ring that keeps its
      // brightness while growing gains total energy and reads as a light being
      // turned up rather than as a wave losing pressure.
      const decay = Math.pow(1 - t, 1.5) * (s.r0 + 0.5) / (r + 0.5);
      const u = s.material.uniforms.uParams.value;
      // 0.55, not the 3.4 the first draft used. The ring is drawn additively
      // over a scene whose average is ~4% linear grey, so a gain here is worth
      // far more than it looks in isolation — and anything it pushes above 1.0
      // is then spread across a sixth of the screen by render's bloom pyramid.
      // MEASURED against a control capture of the same framing with no fx: at
      // 3.4 the shockwave alone lifted the whole room out of its brazier pools.
      u.x = s.intensity * decay * 0.55;
      u.z = time;
    }

    // ---- columns ---------------------------------------------------------
    for (const s of this.columns) {
      if (!s.busy) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) { s.busy = false; s.mesh.visible = false; continue; }
      const u = s.material.uniforms.uParams.value;
      u.x = s.intensity;
      u.y = time;
      u.z = s.rise;
      u.w = s.fill;
    }

    // ---- beams -----------------------------------------------------------
    for (const s of this.beams) {
      if (!s.busy) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) { s.busy = false; s.mesh.visible = false; continue; }
      const u = s.material.uniforms.uParams.value;
      // Fires out along its length in the first 25%, then decays.
      u.z = Math.min(1.05, t * 4.2);
      u.x = s.intensity * Math.pow(1 - t, 1.8);
      u.y = time;
    }

    // ---- glyphs ----------------------------------------------------------
    for (const s of this.glyphs) {
      if (!s.busy) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) { s.busy = false; s.mesh.visible = false; continue; }
      const u = s.material.uniforms.uParams.value;
      u.y = Math.min(1, s.age / s.scribe);
      u.z = time;
      u.w = time * s.spinRate;
      // Hold, then fade over the last third.
      u.x = s.intensity * (t < 0.66 ? 1 : 1 - (t - 0.66) / 0.34);
    }

    // ---- silhouettes -----------------------------------------------------
    for (const s of this.silhouettes) {
      if (!s.busy) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) { s.busy = false; s.mesh.visible = false; continue; }
      const u = s.material.uniforms.uParams.value;
      // Reveal over the first 55%, hold, then dissolve away over the last 20%.
      u.x = Math.min(1.08, t / 0.55);
      u.y = s.opacity * (t < 0.80 ? 1 : 1 - (t - 0.80) / 0.20);
      u.z = time;
    }
  }

  /** Position and progress of a live silhouette's head, for the eye flare. */
  silhouetteHead(i, out) {
    const s = this.silhouettes[i];
    if (!s?.busy) return null;
    out.set(s.mesh.position.x, s.mesh.position.y + s.height * 0.90, s.mesh.position.z);
    return out;
  }

  isBusy(pool, i) {
    const p = this[pool];
    return !!(p && p[i] && p[i].busy);
  }

  clear() {
    for (const pool of [this.rings, this.columns, this.beams, this.glyphs, this.silhouettes]) {
      for (const s of pool) { s.busy = false; s.mesh.visible = false; s.age = 0; }
    }
  }

  stats() {
    const c = (p) => p.reduce((n, s) => n + (s.busy ? 1 : 0), 0);
    return {
      rings: `${c(this.rings)}/${this.rings.length}`,
      columns: `${c(this.columns)}/${this.columns.length}`,
      beams: `${c(this.beams)}/${this.beams.length}`,
      glyphs: `${c(this.glyphs)}/${this.glyphs.length}`,
      silhouettes: `${c(this.silhouettes)}/${this.silhouettes.length}`,
    };
  }

  dispose() {
    for (const pool of [this.rings, this.columns, this.beams, this.glyphs, this.silhouettes]) {
      for (const s of pool) { this.group.remove(s.mesh); s.material.dispose(); }
      pool.length = 0;
    }
    this.ringGeo.dispose();
    this.columnGeo.dispose();
    this.beamGeo.dispose();
    this.glyphGeo.dispose();
    this.silGeo.dispose();
    this.group.parent?.remove(this.group);
  }
}

const WHITE = [1, 1, 1];
