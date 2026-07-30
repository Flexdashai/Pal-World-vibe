/**
 * The ground cursor.
 *
 * Two halves that must agree: a crisp DOM reticle at the pointer (so the cursor
 * never lags a frame behind the mouse — the OS pointer is hidden by
 * `#game { cursor: none }`), and a world-space decal projected onto the ground
 * plane, which is what actually tells the player where a ground-targeted skill
 * will land in an isometric view.
 *
 * The decal lives in `ctx.uiScene`, so it is drawn after the world with a
 * cleared depth buffer and can never be swallowed by fog or by a prop. It is
 * additive and thin on purpose: a heavy opaque ring drawn over everything reads
 * as a bug the moment it crosses the player's silhouette.
 *
 * Like the damage numbers, its shader divides out the current auto-exposure so
 * the ring has the same apparent brightness in a black corridor and beside a
 * brazier.
 */

import * as THREE from 'three';
import { ELEMENTS, UI } from '../core/palette.js';
import { el } from './dom.js';
import { hexToRgb } from './theme.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform float uHostile;
uniform float uAlpha;
uniform float uClick;
uniform vec3 uColor;
uniform vec3 uHostileColor;
uniform sampler2D tExposure;
uniform float uUseExposure;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length( p );
  if ( r > 1.0 ) discard;
  float a = atan( p.y, p.x );

  vec3 col = mix( uColor, uHostileColor, uHostile );
  float acc = 0.0;

  // A very soft pool of light so the ring is grounded rather than floating.
  acc += pow( max( 0.0, 1.0 - r ), 3.2 ) * 0.13;

  // Screen-space-constant line width via derivatives: the ring stays one pixel
  // thick whatever the camera distance, which is the whole reason it reads as
  // a HUD element and not as a painted decal.
  float w = fwidth( r ) * 1.7 + 0.0035;

  // Main ring, broken into three rotating arcs.
  float ring = smoothstep( w, 0.0, abs( r - 0.62 ) );
  float seg = abs( fract( ( a + uTime * 0.55 ) / 2.0943951 ) - 0.5 ) * 2.0;
  ring *= smoothstep( 0.05, 0.30, seg );
  acc += ring * 0.95;

  // Inner continuous ring.
  acc += smoothstep( w, 0.0, abs( r - 0.30 ) ) * 0.34;

  // Four counter-rotating ticks on the outside.
  float ta = a - uTime * 0.34;
  float tick = smoothstep( 0.91, 1.0, abs( cos( ta * 2.0 ) ) );
  acc += tick * smoothstep( 0.13, 0.0, abs( r - 0.82 ) ) * 0.8;

  // Centre pip.
  acc += smoothstep( 0.06, 0.0, r ) * 1.15;

  // Click ripple.
  float ct = uClick / 0.42;
  if ( uClick >= 0.0 && ct < 1.0 ) {
    float rr = 0.12 + ct * 0.86;
    acc += smoothstep( w * 2.4, 0.0, abs( r - rr ) ) * ( 1.0 - ct ) * 1.5;
  }

  float ev = mix( 1.0, texture2D( tExposure, vec2( 0.5 ) ).g, uUseExposure );
  gl_FragColor = vec4( col * acc * 2.0 / max( ev, 1e-4 ), clamp( acc, 0.0, 1.0 ) * uAlpha );
}
`;

export class GroundCursor {
  constructor(ctx, parent) {
    this.ctx = ctx;

    // ---- world decal -------------------------------------------------------
    this.geo = new THREE.PlaneGeometry(1.72, 1.72, 1, 1);
    this.geo.rotateX(-Math.PI / 2);
    const shadow = ELEMENTS.shadow;
    this._white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._white.needsUpdate = true;

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uHostile: { value: 0 },
        uAlpha: { value: 0.9 },
        uClick: { value: -1 },
        uColor: { value: new THREE.Vector3(0.62, 0.55, 1.0) },
        uHostileColor: { value: new THREE.Vector3(1.0, 0.16, 0.09) },
        tExposure: { value: this._white },
        uUseExposure: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    // Colour comes from the palette's shadow element, lifted toward white so the
    // ring stays neutral enough to read against violet spell VFX.
    this.mat.uniforms.uColor.value.set(
      shadow.light[0] * 0.55 + 0.35, shadow.light[1] * 0.55 + 0.32, shadow.light[2] * 0.55 + 0.42
    );
    const hostile = hexToRgb(UI.hpRed).map((c) => Math.pow(c / 255, 2.2) * 2.4);
    this.mat.uniforms.uHostileColor.value.set(hostile[0], hostile[1], hostile[2]);

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 890;
    this.mesh.userData.mnNoPrepass = true;
    this.mesh.userData.mnNoShadow = true;
    ctx.uiScene.add(this.mesh);

    // ---- DOM reticle -------------------------------------------------------
    this.dom = el('div', 'mn-cursor', parent);
    el('i', 'h t', this.dom);
    el('i', 'h b', this.dom);
    el('i', 'v lf', this.dom);
    el('i', 'v rt', this.dom);
    el('i', 'dot', this.dom);

    // ---- preallocated projection ------------------------------------------
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._ray = new THREE.Ray();
    this._hit = new THREE.Vector3();
    this._ndc = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._proj = new THREE.Vector3();
    this._parked = new THREE.Vector3();
    this.ground = new THREE.Vector3();
    /** Where the player is standing, so a parked cursor tracks them. */
    this.anchor = new THREE.Vector3();
    /**
     * Where the reticle parks when no pointer has ever moved (capture mode).
     *
     * Under the fixed 45-degree yaw, screen-right is (+0.707, 0, -0.707) and
     * screen-up is (-0.707, 0, -0.707). This is ~3.5 m right and ~1 m down from
     * the player, which reads as "aiming at something beside them" and, just as
     * importantly, keeps the ring clear of the centre of frame where the SYSTEM
     * windows live.
     */
    this._POSE_OFFSET = new THREE.Vector3(3.2, 0, -1.8);
    this._clickT = -1;
    this._exposure = null;
    this._lastX = -9999;
    this._lastY = -9999;
    this.hostile = 0;
    this.enabled = true;
  }

  /** Project the pointer onto y=0 without allocating and without depending on
   *  whoever else happens to have called `input.sample` this frame. */
  _project(camera, ndcX, ndcY) {
    this._ndc.set(ndcX, ndcY, 0.5).unproject(camera);
    this._origin.copy(camera.position);
    this._dir.copy(this._ndc).sub(this._origin).normalize();
    this._ray.set(this._origin, this._dir);
    const hit = this._ray.intersectPlane(this._plane, this._hit);
    if (hit) this.ground.copy(hit);
    this._proj.set(ndcX, ndcY, 0);
    return !!hit;
  }

  /** The inverse: a world point back to NDC, so the DOM reticle can follow a
   *  decal that was placed by something other than the pointer. */
  _projectPoint(camera, p) {
    this.ground.copy(p);
    this._proj.copy(p).setY(0.9).project(camera);
  }

  update(dt, ctx, w, h) {
    if (!this._exposure) {
      const tex = ctx.peek('render')?.exposure?.texture ?? null;
      if (tex) {
        this._exposure = tex;
        this.mat.uniforms.tExposure.value = tex;
        this.mat.uniforms.uUseExposure.value = 1;
      }
    }

    const input = ctx.input;
    if (input.mousePressed?.(0)) this._clickT = 0;
    if (this._clickT >= 0) {
      this._clickT += dt;
      if (this._clickT > 0.42) this._clickT = -1;
    }

    this.mat.uniforms.uTime.value = ctx.time.raw;
    this.mat.uniforms.uClick.value = this._clickT;
    this.mat.uniforms.uHostile.value = this.hostile;
    this.mat.uniforms.uAlpha.value = this.enabled ? 0.95 : 0;
    this.mesh.visible = this.enabled;
    this.dom.style.display = this.enabled ? '' : 'none';
    if (!this.enabled) return;

    // In capture mode no pointer event has ever fired, so the NDC is (0,0) and
    // the ground point lands dead centre of frame — which, with the player at
    // the lower third, puts the reticle floating in mid-air above their head.
    // Park it a few metres up-screen of the player instead, which is where a
    // player actually holds the cursor.
    let nx = input.ndc.x, ny = input.ndc.y;
    if (input.frozen && nx === 0 && ny === 0) {
      this._parked ??= new THREE.Vector3();
      this._parked.copy(this.anchor).add(this._POSE_OFFSET);
      this.mesh.position.set(this._parked.x, 0.012, this._parked.z);
      this._projectPoint(ctx.camera, this._parked);
    } else if (this._project(ctx.camera, nx, ny)) {
      // Lift a hair off the floor: uiScene has no depth test, but a decal at
      // exactly y=0 will z-fight with itself under TAA jitter if anything ever
      // re-enables depth for this pass.
      this.mesh.position.set(this.ground.x, 0.012, this.ground.z);
    }

    // The DOM reticle sits wherever the world decal ended up — including the
    // parked position — so the two halves never disagree.
    const px = (this._proj.x * 0.5 + 0.5) * w;
    const py = (-this._proj.y * 0.5 + 0.5) * h;
    if (Math.abs(px - this._lastX) > 0.4 || Math.abs(py - this._lastY) > 0.4) {
      this._lastX = px; this._lastY = py;
      this.dom.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
    }
    this.dom.classList.toggle('hostile', this.hostile > 0.5);
  }

  setHostile(v) { this.hostile = v ? 1 : 0; }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
    this._white.dispose();
    this.dom.remove();
  }
}
