import * as THREE from 'three';
import { MIST, FOG } from './tuning.js';
import { DEPTH_GLSL, HASH_GLSL, LIGHT_ATTEN_GLSL } from './glsl.js';

/**
 * GROUND MIST — the low card that pools on the floor and is parted by the
 * player and by explosions.
 *
 * WHY THIS IS NOT PART OF THE VOLUMETRIC MARCH. The march is a screen-space
 * integral: it knows the density field and the lights, and it knows nothing
 * about what is standing in it. Mist that a running character does not disturb
 * reads as a texture on the floor. Mist that opens around them, and closes again
 * behind them, reads as air. That interaction needs a surface, so it gets one.
 *
 * POOLING IN LOW AREAS COMES FROM THE DEPTH BUFFER, not from a heightfield.
 * The card sits at a fixed 10 cm above the nominal floor and is depth-TESTED
 * against the world. Where the floor is lower than the card, the card is in
 * front of it and draws. Where the floor is higher — a dais, a stair, a raised
 * shrine — the card is behind it and is rejected. So the mist fills the sunken
 * parts of a room and leaves the raised parts clear, for free, with no knowledge
 * of the level whatsoever. That is what makes this work with a procedural world
 * that `sky` cannot see.
 *
 * The card is drawn in the LIT pass as a transparent object, which means:
 *   - it is automatically excluded from the depth/normal prepass (render's
 *     `_collect` drops anything with `transparent === true`), so it does not
 *     pollute SSR or GTAO;
 *   - it is composited before the volumetric pass, so the height fog is applied
 *     over it. That is the correct order — the mist is IN the room, the fog is
 *     BETWEEN the room and the camera.
 */

const MIST_VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uOrigin;      // card centre in world space, XZ tracked to the camera

varying vec3 vWorld;
varying float vViewZ;
varying vec2 vScreenUv;

void main() {
  // The plane is built in XY and rotated by the mesh transform, so the local
  // position already arrives as a world offset once the model matrix is applied.
  vec4 world = modelMatrix * vec4( position, 1.0 );

  // A very slow vertical undulation. Two incommensurate frequencies so the
  // surface never reads as a sine wave; amplitude is centimetres, which is all
  // it takes to stop the card from looking like a sheet of glass at grazing
  // angles.
  float w = sin( world.x * 0.21 + uTime * 0.15 ) * cos( world.z * 0.17 - uTime * 0.11 );
  world.y += w * 0.075;

  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vViewZ = -mv.z;
  vec4 clip = projectionMatrix * mv;
  vScreenUv = ( clip.xy / max( 1e-5, clip.w ) ) * 0.5 + 0.5;
  gl_Position = clip;
}
`;

const MIST_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;

varying vec3 vWorld;
varying float vViewZ;
varying vec2 vScreenUv;

uniform sampler2D tDepth;
uniform sampler3D uMistNoise;
uniform vec4 uScreen;          // w, h, 1/w, 1/h of the internal render target
uniform float uTime;
uniform vec3 uFocus;
uniform vec4 uNoiseA;          // scale, drift.x, drift.y, phase
uniform vec4 uNoiseB;
uniform vec2 uCoverage;        // threshold, softness
uniform float uOpacity;
uniform vec2 uFade;            // start, end distance from focus
uniform vec3 uAmbient;
uniform vec3 uMoonIrradiance;
uniform vec3 uMoonDir;
uniform vec4 uPush[ MN_MIST_PUSHERS ];   // xyz = centre, w = radius (0 = inactive)
uniform float uPushStrength[ MN_MIST_PUSHERS ];

#if MN_MIST_LIGHTS > 0
uniform vec4 uLightPos[ MN_MIST_LIGHTS ];
uniform vec4 uLightColor[ MN_MIST_LIGHTS ];
#endif

${DEPTH_GLSL}
${HASH_GLSL}
${LIGHT_ATTEN_GLSL}

void main() {

  // ---- displacement by the things standing in the mist ---------------------
  // Each pusher does two things: it clears a hole, and it drags the noise
  // OUTWARD at the rim. The drag is what turns a hole into a bow wave — without
  // it, a running character punches a clean circle and the effect reads as a
  // decal rather than as displaced air.
  vec2 p = vWorld.xz;
  float clear = 1.0;
  for ( int i = 0; i < MN_MIST_PUSHERS; i ++ ) {
    vec4 pu = uPush[ i ];
    if ( pu.w <= 0.0 ) continue;
    vec2 d = p - pu.xz;
    float r = length( d );
    if ( r > pu.w * 2.2 ) continue;
    float s = uPushStrength[ i ];
    float core = 1.0 - smoothstep( pu.w * 0.35, pu.w, r );
    clear -= core * s;
    float rim = ( 1.0 - smoothstep( pu.w * 0.6, pu.w * 1.9, r ) ) * s;
    p += normalize( d + vec2( 1e-4, 0.0 ) ) * rim * ${MIST.swirl.toFixed(3)};
  }
  clear = clamp( clear, 0.0, 1.0 );

  // ---- density -------------------------------------------------------------
  // Sampled from the SAME volume the height fog marches, so the mist is thick
  // where the fog is thick. Two layers drifting against each other, which is
  // what makes the patches breathe instead of slide.
  vec3 q1 = vec3( p.x, vWorld.y * 0.6 + uNoiseA.w, p.y ) * uNoiseA.x + vec3( uNoiseA.y, 0.02, uNoiseA.z ) * uTime;
  vec3 q2 = vec3( p.x, vWorld.y * 0.6, p.y ) * uNoiseB.x + vec3( uNoiseB.y, -0.03, uNoiseB.z ) * uTime;
  vec4 n1 = texture( uMistNoise, q1 );
  vec4 n2 = texture( uMistNoise, q2 );
  // Weighted heavily toward the LOW octave. Averaging three fields evenly is a
  // central-limit machine: the result clusters hard around 0.5 and the coverage
  // threshold then produces a uniform half-strength sheet instead of banks with
  // clear floor between them. The detail octaves are here to break up the edges
  // of the banks, not to define them.
  float field = n1.r * 0.72 + n2.g * 0.18 + n2.a * 0.10;

  float cover = smoothstep( uCoverage.x, uCoverage.x + uCoverage.y, field );
  float alpha = cover * uOpacity * clear;

  // ---- fades ----------------------------------------------------------------
  // Distance from the focus, so the finite card has no visible edge.
  float dFocus = length( vWorld.xz - uFocus.xz );
  alpha *= 1.0 - smoothstep( uFade.x, uFade.y, dFocus );

  // Soft-depth: fade out as the card approaches whatever is behind it, so the
  // intersection with a wall or a pillar is a gradient rather than a cut line.
  // This is the single change that separates a mist card from a mistake.
  float sceneD = texture2D( tDepth, gl_FragCoord.xy * uScreen.zw ).r;
  float sceneZ = sceneD >= 0.999999 ? uProj.y : mnLinearDepth( sceneD );
  alpha *= clamp( ( sceneZ - vViewZ ) / ${MIST.softDepth.toFixed(3)}, 0.0, 1.0 );

  // Grazing-angle fade. A flat card seen edge-on has infinite optical depth in
  // the maths and zero thickness in reality; without this the card's far edge is
  // a hard bright band across the room.
  vec3 viewDir = normalize( vWorld - cameraPosition );
  alpha *= clamp( abs( viewDir.y ) * 2.6, 0.0, 1.0 );

  if ( alpha < 0.003 ) discard;

  // ---- shading --------------------------------------------------------------
  // Ambient sky, plus a forward-scattering term for every nearby practical. The
  // attenuation is byte-identical to three's, so the mist glows over exactly the
  // area of floor the brazier lights and not a metre more.
  vec3 col = uAmbient * ( 1.0 + ${FOG.groundBounce.toFixed(3)} );

  // The moon rakes across the mist: a low moon lights the tops of the banks.
  // The coefficient is the single-scattering albedo of a 1 m column of mist —
  // small, because a card is not a cloud. At 0.10 the mist was brighter than the
  // moonlit stone under it and read as a sheet of glowing plastic.
  float moonWrap = clamp( uMoonDir.y * 0.5 + 0.5, 0.0, 1.0 );
  col += uMoonIrradiance * ( 0.035 * moonWrap );

  #if MN_MIST_LIGHTS > 0
  for ( int L = 0; L < MN_MIST_LIGHTS; L ++ ) {
    vec4 lc = uLightColor[ L ];
    if ( lc.a < 0.5 ) continue;
    vec4 lp = uLightPos[ L ];
    vec3 toL = lp.xyz - vWorld;
    float dist = length( toL );
    float atten = mnDistanceAttenuation( dist, lp.w );
    // Forward scattering toward the camera: the mist between the eye and the
    // brazier is what glows, not the mist behind it.
    float fwd = 0.55 + 0.45 * max( 0.0, dot( normalize( toL ), -viewDir ) );
    col += lc.rgb * ( atten * fwd * 0.16 );
  }
  #endif

  // Density modulates brightness slightly as well as opacity: a thick bank is
  // both more opaque AND brighter, because there is more of it scattering.
  col *= 0.75 + 0.55 * cover;

  // Dither the alpha by a per-pixel gradient noise. The card covers a large,
  // very low-contrast area of the frame and a half-float HDR buffer still
  // quantises it into visible rings without this.
  alpha += ( mnIgn( gl_FragCoord.xy ) - 0.5 ) * 0.012;

  gl_FragColor = vec4( col, clamp( alpha, 0.0, 1.0 ) );
}
`;

export class GroundMist {
  constructor(fogNoise, lightSlots) {
    this.lightSlots = Math.min(2, Math.max(0, lightSlots));

    const geo = new THREE.PlaneGeometry(MIST.size, MIST.size, MIST.segments, MIST.segments);
    geo.rotateX(-Math.PI / 2);
    this.geometry = geo;

    this.push = [];
    this.pushStrength = new Float32Array(MIST.pushers);
    for (let i = 0; i < MIST.pushers; i++) this.push.push(new THREE.Vector4(0, 0, 0, 0));

    this.lightPos = [];
    this.lightColor = [];
    for (let i = 0; i < Math.max(1, this.lightSlots); i++) {
      this.lightPos.push(new THREE.Vector4());
      this.lightColor.push(new THREE.Vector4());
    }

    this.uniforms = {
      tDepth: { value: null },
      uMistNoise: { value: fogNoise },
      uScreen: { value: new THREE.Vector4(1280, 720, 1 / 1280, 1 / 720) },
      uProj: { value: new THREE.Vector4(1, 140, 0.3, 1.777) },
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uFocus: { value: new THREE.Vector3() },
      uNoiseA: { value: new THREE.Vector4(MIST.scale, MIST.drift[0], MIST.drift[1], 0.31) },
      uNoiseB: { value: new THREE.Vector4(MIST.scale2, MIST.drift2[0], MIST.drift2[1], 0.0) },
      uCoverage: { value: new THREE.Vector2(MIST.coverage, MIST.soft) },
      uOpacity: { value: MIST.opacity },
      uFade: { value: new THREE.Vector2(MIST.fadeStart, MIST.fadeEnd) },
      uAmbient: { value: new THREE.Vector3(0.006, 0.007, 0.011) },
      uMoonIrradiance: { value: new THREE.Vector3() },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uPush: { value: this.push },
      uPushStrength: { value: this.pushStrength },
      ...(this.lightSlots > 0
        ? { uLightPos: { value: this.lightPos }, uLightColor: { value: this.lightColor } }
        : {}),
    };

    this.material = new THREE.ShaderMaterial({
      name: 'mn.sky.mist',
      defines: {
        MN_MIST_PUSHERS: MIST.pushers,
        MN_MIST_LIGHTS: this.lightSlots,
      },
      uniforms: this.uniforms,
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'mn.sky.mist';
    this.mesh.position.y = MIST.y;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.mnNoShadow = true;
    this.mesh.userData.mnNoPrepass = true;
    // Draw after the world's own transparents so the mist sits in front of
    // ground decals but behind spell VFX, which `fx` will order above 2000.
    this.mesh.renderOrder = 20;

    // Ripple bookkeeping. Slot 0 is reserved for the player, so a burst of
    // explosions can never push the player's own hole out of the list.
    this._rippleTime = new Float32Array(MIST.pushers);
    this._rippleLife = new Float32Array(MIST.pushers);
    this._next = 1;
    this._tmp = new THREE.Vector3();
  }

  /** Screen size of the renderer's internal target, for the soft-depth fetch. */
  setScreen(w, h) {
    this.uniforms.uScreen.value.set(w, h, 1 / w, 1 / h);
  }

  setProjection(near, far, tanHalf, aspect) {
    this.uniforms.uProj.value.set(near, far, tanHalf, aspect);
  }

  /** Track the card to the camera focus so it always covers the visible ground,
   *  and age the ripples. Noise is sampled in WORLD space, so moving the card
   *  does not make the pattern swim. */
  update(dt, focus, time, depthTexture) {
    this.mesh.position.x = focus.x;
    this.mesh.position.z = focus.z;
    this.uniforms.uFocus.value.copy(focus);
    this.uniforms.uOrigin.value.copy(this.mesh.position);
    this.uniforms.uTime.value = time;
    this.uniforms.tDepth.value = depthTexture;

    for (let i = 1; i < MIST.pushers; i++) {
      if (this.push[i].w <= 0) continue;
      this._rippleTime[i] += dt;
      const k = this._rippleTime[i] / Math.max(0.05, this._rippleLife[i]);
      if (k >= 1) { this.push[i].w = 0; this.pushStrength[i] = 0; continue; }
      // Expand and fade: a blast wave clears a growing ring that heals from the
      // centre outward.
      this.push[i].w = MIST.explosionRadius * (0.35 + 0.65 * Math.sqrt(k));
      this.pushStrength[i] = (1 - k) * (1 - k);
    }
  }

  /** The player parts the mist. Slot 0, always present, never expires. */
  setPlayer(position, moving) {
    const p = this.push[0];
    p.x = position.x; p.y = position.y; p.z = position.z;
    p.w = MIST.playerRadius * (moving ? 1.25 : 1.0);
    this.pushStrength[0] = moving ? 0.95 : 0.72;
  }

  /** An explosion blows a hole in it. */
  addRipple(position, radius = MIST.explosionRadius, life = MIST.pushDecay) {
    const i = this._next;
    this._next = 1 + ((this._next) % (MIST.pushers - 1));
    this.push[i].set(position.x, position.y, position.z, Math.max(0.5, radius) * 0.35);
    this.pushStrength[i] = 1.0;
    this._rippleTime[i] = 0;
    this._rippleLife[i] = life;
  }

  setLights(lights) {
    for (let i = 0; i < this.lightSlots; i++) {
      const l = lights[i];
      if (l) {
        this.lightPos[i].set(l.pos.x, l.pos.y, l.pos.z, l.cutoff);
        this.lightColor[i].set(l.rgb.x, l.rgb.y, l.rgb.z, 1);
      } else {
        this.lightColor[i].w = 0;
      }
    }
  }

  setSky({ ambient, moonDir, moonIrradiance, opacity, coverage }) {
    if (ambient) this.uniforms.uAmbient.value.copy(ambient);
    if (moonDir) this.uniforms.uMoonDir.value.copy(moonDir);
    if (moonIrradiance) this.uniforms.uMoonIrradiance.value.copy(moonIrradiance);
    if (opacity !== undefined) this.uniforms.uOpacity.value = opacity;
    if (coverage !== undefined) this.uniforms.uCoverage.value.x = coverage;
  }

  setVisible(v) { this.mesh.visible = v; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
