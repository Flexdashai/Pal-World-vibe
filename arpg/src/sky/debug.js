import * as THREE from 'three';

/**
 * Opt-in debug views for `sky`.
 *
 * These exist for the same reason `render.debugView` does: "is the sky any good"
 * is not answerable from a crypt interior, because the sky is four percent of
 * the frame. And "is the volumetric march producing shafts or producing noise"
 * is not answerable from the composited frame at all, because the fog is a low
 * contrast term added on top of everything else.
 *
 * Reachable as `?skyview=dome|fog|env` on the URL — which is how the capture
 * harness gets at them, since it can pass query parameters but cannot evaluate
 * code before the shutter — or as `sky.debugView('dome')` at runtime.
 *
 * NOTHING here is constructed unless a mode is actually requested, so it can
 * never cost another agent's capture anything.
 */

const BLIT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

const BLIT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec4 uMode;   // 0 = rgb, 1 = alpha (transmittance), gain, unused, unused

vec3 srgb( vec3 c ) {
  c = clamp( c, 0.0, 1.0 );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
}

void main() {
  vec4 s = texture2D( tSrc, vUv );
  // Split screen: in-scatter on the left, transmittance on the right, so one
  // capture answers both "are there shafts" and "is the fog eating the room".
  vec3 c = vUv.x < 0.5 ? s.rgb * uMode.y : vec3( s.a );
  // A one-pixel divider, because at a glance the two halves of a fog buffer look
  // alike and it is easy to misread which is which.
  if ( abs( vUv.x - 0.5 ) < 0.0008 ) c = vec3( 1.0, 0.2, 0.05 );
  gl_FragColor = vec4( srgb( c ), 1.0 );
}
`;

const EQUIRECT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec4 uMode;   // gain in .y

vec3 srgb( vec3 c ) {
  c = clamp( c, 0.0, 1.0 );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
}

void main() {
  // Letterboxed 2:1 so the equirect is not stretched to the frame's aspect,
  // which would make the horizon band impossible to judge.
  vec2 uv = vUv;
  float band = 0.25;
  if ( uv.y < band || uv.y > 1.0 - band ) { gl_FragColor = vec4( 0.02, 0.02, 0.025, 1.0 ); return; }
  uv.y = ( uv.y - band ) / ( 1.0 - 2.0 * band );
  vec3 c = texture2D( tSrc, uv ).rgb * uMode.y;
  gl_FragColor = vec4( srgb( c ), 1.0 );
}
`;

class Quad {
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.geometry = g;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(g, null);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }
  render(renderer, material) {
    this.mesh.material = material;
    renderer.setRenderTarget(null);
    renderer.render(this.mesh, this.camera);
  }
  dispose() { this.geometry.dispose(); this.mesh.material = null; }
}

/**
 * `nofog` is the A/B control. "Is the fog helping?" is the only question that
 * matters about this subsystem and it cannot be answered from one frame — it
 * needs the same frame with the air taken out. Having the control built in means
 * the comparison is one capture away instead of a code edit away, which is the
 * difference between checking and assuming.
 */
const MODES = new Set(['off', 'dome', 'moon', 'fog', 'env', 'nofog']);

/** Display gain for the panorama views. A moonlit sky is ~0.005 in the same
 *  linear units where a brazier is 26, so it needs about five stops of push to
 *  be reviewable at all. */
const PANO_EXPOSURE = 42;
/** Display gain for the zoomed moon view: the disc is ~34 in the same units, so
 *  this lands it just past mid grey after the Reinhard roll-off. */
const MOON_EXPOSURE = 0.055;

export class SkyDebug {
  constructor(sky, initial) {
    this.sky = sky;
    this.mode = 'off';
    this.quad = null;
    this.fogMat = null;
    this.envMat = null;
    this.pass = null;
    if (initial) this.set(initial);
  }

  set(name) {
    const m = MODES.has(String(name)) ? String(name) : 'off';
    if (m === this.mode) return m;
    this.mode = m;

    // The fog pass keeps running when `nofog` is set so its cost stays in the
    // measurement; only its output is suppressed. Comparing a frame with the fog
    // to a frame that also skipped a quarter-resolution march would confound the
    // look with the timing.
    this.sky.fog.setMuted(m === 'nofog');
    this.sky.mist.setVisible(m !== 'nofog');

    const overlay = m === 'fog' || m === 'env' || m === 'dome' || m === 'moon';
    if (overlay) this._ensurePass();
    if (this.pass) this.pass.enabled = overlay;
    return m;
  }

  _ensurePass() {
    if (this.pass) return;
    this.quad = new Quad();

    this.fogMat = new THREE.ShaderMaterial({
      name: 'mn.sky.debug.fog',
      uniforms: { tSrc: { value: null }, uMode: { value: new THREE.Vector4(0, 26, 0, 0) } },
      vertexShader: BLIT_VERT, fragmentShader: BLIT_FRAG,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.envMat = new THREE.ShaderMaterial({
      name: 'mn.sky.debug.env',
      uniforms: { tSrc: { value: null }, uMode: { value: new THREE.Vector4(0, 60, 0, 0) } },
      vertexShader: BLIT_VERT, fragmentShader: EQUIRECT_FRAG,
      depthTest: false, depthWrite: false, toneMapped: false,
    });

    // `stage: 'final'` draws to the canvas in display space, after the composite
    // — which is exactly right for a diagnostic: it must not be tone mapped,
    // graded or bloomed, or the numbers being inspected are not the numbers the
    // pass produced.
    this.pass = this.sky.render.registerPass({
      stage: 'final',
      order: 900,
      enabled: false,
      render: (renderer) => {
        if (this.mode === 'fog') {
          const src = this.sky.fog.compositeMaterial.uniforms.tVolume.value;
          if (!src) return;
          this.fogMat.uniforms.tSrc.value = src;
          this.quad.render(renderer, this.fogMat);
        } else if (this.mode === 'env') {
          this.envMat.uniforms.tSrc.value = this.sky.ibl.equirect;
          this.quad.render(renderer, this.envMat);
        } else if (this.mode === 'dome') {
          // Sky panorama: the dome's own shader re-projected to lat-long, then
          // the star field on top through the same projection. Both share the
          // live uniforms, so what is on screen is what the sky is.
          const a = this.sky.render.screenSize.width / this.sky.render.screenSize.height;
          this.quad.render(renderer, this.sky.dome.panoramaMaterial(PANO_EXPOSURE, 1, a));
          const pts = this.sky.stars.panoramaObject(PANO_EXPOSURE);
          renderer.setRenderTarget(null);
          renderer.render(pts, this.quad.camera);
        } else if (this.mode === 'moon') {
          // Three-degree gnomonic field on the moon. The exposure is five stops
          // down from the panorama's because the disc is four orders of
          // magnitude above the sky it sits in.
          const a = this.sky.render.screenSize.width / this.sky.render.screenSize.height;
          this.quad.render(renderer, this.sky.dome.panoramaMaterial(MOON_EXPOSURE, 60, a));
        }
      },
    });
  }

  update() { /* nothing per-frame; the pass reads live references */ }

  dispose() {
    if (this.pass) this.sky.render.removePass(this.pass);
    this.fogMat?.dispose();
    this.envMat?.dispose();
    this.quad?.dispose();
    this.pass = null;
  }
}
