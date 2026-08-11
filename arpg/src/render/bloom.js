import * as THREE from 'three';
import { postMaterial } from './quad.js';
import { COLOR_LIB } from './glsl.js';
import { colorTarget, disposeTarget } from './targets.js';
import { TUNE } from './tuning.js';

/**
 * Threshold-free, energy-conserving bloom pyramid.
 *
 * There is no brightness threshold anywhere in this pass, on purpose. A
 * threshold is a lie about how a lens works — light scatters proportionally at
 * every intensity — and it produces the two artefacts that instantly mark a
 * renderer as hobbyist: a visible "popping" ring where pixels cross the
 * threshold as the camera moves, and a bloom that disappears entirely when auto
 * exposure stops the scene down. Instead the whole HDR image is blurred by a
 * proper pyramid and the composite LERPS toward it by a few percent. Real
 * emissive intensity — a brazier at 26 cd, a spell core at 200 — is what makes
 * the glow, exactly as it should be.
 *
 * Downsample is the 13-tap Call-of-Duty kernel with a Karis average on the first
 * level (weight each 2x2 box by 1/(1+luma) before averaging), which is what stops
 * a single one-pixel spark from becoming a permanent flickering star.
 *
 * The pyramid starts at QUARTER resolution. Bloom is by definition low
 * frequency; a half-res base costs four times the fill for a difference nobody
 * has ever noticed, and on a CPU rasteriser that is the difference between an
 * affordable pass and an unaffordable one.
 */

const DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uKaris;

${COLOR_LIB}

vec3 box( vec3 a, vec3 b, vec3 c, vec3 d ) {
	if ( uKaris > 0.5 ) {
		// Karis average: weight by 1/(1+luma) so an isolated very bright texel
		// contributes its share of the box and not the whole box.
		float wa = 1.0 / ( 1.0 + mnLuminance( a ) );
		float wb = 1.0 / ( 1.0 + mnLuminance( b ) );
		float wc = 1.0 / ( 1.0 + mnLuminance( c ) );
		float wd = 1.0 / ( 1.0 + mnLuminance( d ) );
		return ( a * wa + b * wb + c * wc + d * wd ) / max( 1e-5, wa + wb + wc + wd );
	}
	return ( a + b + c + d ) * 0.25;
}

void main() {

	vec2 t = uTexel;

	vec3 A = texture2D( tSrc, vUv + vec2( -2.0, -2.0 ) * t ).rgb;
	vec3 B = texture2D( tSrc, vUv + vec2(  0.0, -2.0 ) * t ).rgb;
	vec3 C = texture2D( tSrc, vUv + vec2(  2.0, -2.0 ) * t ).rgb;
	vec3 D = texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * t ).rgb;
	vec3 E = texture2D( tSrc, vUv + vec2(  1.0, -1.0 ) * t ).rgb;
	vec3 F = texture2D( tSrc, vUv + vec2( -2.0,  0.0 ) * t ).rgb;
	vec3 G = texture2D( tSrc, vUv ).rgb;
	vec3 H = texture2D( tSrc, vUv + vec2(  2.0,  0.0 ) * t ).rgb;
	vec3 I = texture2D( tSrc, vUv + vec2( -1.0,  1.0 ) * t ).rgb;
	vec3 J = texture2D( tSrc, vUv + vec2(  1.0,  1.0 ) * t ).rgb;
	vec3 K = texture2D( tSrc, vUv + vec2( -2.0,  2.0 ) * t ).rgb;
	vec3 L = texture2D( tSrc, vUv + vec2(  0.0,  2.0 ) * t ).rgb;
	vec3 M = texture2D( tSrc, vUv + vec2(  2.0,  2.0 ) * t ).rgb;

	vec3 c = box( D, E, I, J ) * 0.5;
	c += box( A, B, G, F ) * 0.125;
	c += box( B, C, H, G ) * 0.125;
	c += box( F, G, L, K ) * 0.125;
	c += box( G, H, M, L ) * 0.125;

	gl_FragColor = vec4( max( c, 0.0 ), 1.0 );

}
`;

const UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uScatter;

void main() {

	vec2 t = uTexel;

	// 3x3 tent. Cheaper and smoother than a Gaussian at this scale because the
	// pyramid has already band-limited the signal.
	vec3 c = texture2D( tSrc, vUv + vec2( -1.0,  1.0 ) * t ).rgb * 1.0;
	c += texture2D( tSrc, vUv + vec2(  0.0,  1.0 ) * t ).rgb * 2.0;
	c += texture2D( tSrc, vUv + vec2(  1.0,  1.0 ) * t ).rgb * 1.0;
	c += texture2D( tSrc, vUv + vec2( -1.0,  0.0 ) * t ).rgb * 2.0;
	c += texture2D( tSrc, vUv ).rgb * 4.0;
	c += texture2D( tSrc, vUv + vec2(  1.0,  0.0 ) * t ).rgb * 2.0;
	c += texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * t ).rgb * 1.0;
	c += texture2D( tSrc, vUv + vec2(  0.0, -1.0 ) * t ).rgb * 2.0;
	c += texture2D( tSrc, vUv + vec2(  1.0, -1.0 ) * t ).rgb * 1.0;

	gl_FragColor = vec4( c * ( uScatter / 16.0 ), 1.0 );

}
`;

/** How much of each coarser level is folded back into the finer one. Higher
 *  spreads the glow further; 0.68 gives a halo about a fifth of the screen wide
 *  around a brazier, which matches the reference frames. */
const SCATTER = 0.68;

export class BloomPass {
  constructor(renderer, quad, quality) {
    this.renderer = renderer;
    this.quad = quad;
    this.enabled = !!quality.bloom;
    this.maxLevels = quality.bloomLevels;
    this.levels = [];
    /** 1 / total pyramid gain, so the composite's `strength` stays an honest
     *  fraction regardless of how many levels the quality preset allows. */
    this.normalisation = 1;

    this.matDown = postMaterial({
      name: 'mn.bloom.down',
      fragment: DOWN_FRAG,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uKaris: { value: 0 },
      },
    });

    this.matUp = postMaterial({
      name: 'mn.bloom.up',
      fragment: UP_FRAG,
      blending: THREE.AdditiveBlending,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uScatter: { value: SCATTER },
      },
    });

    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
  }

  get texture() {
    return this.enabled && this.levels.length ? this.levels[0].texture : this.black;
  }

  resize(fullW, fullH) {
    for (const rt of this.levels) disposeTarget(rt);
    this.levels.length = 0;
    if (!this.enabled) return;

    let w = Math.max(1, Math.floor(fullW / TUNE.bloom.baseDivisor));
    let h = Math.max(1, Math.floor(fullH / TUNE.bloom.baseDivisor));

    for (let i = 0; i < this.maxLevels; i++) {
      this.levels.push(colorTarget(w, h, `mn.bloom.${i}`));
      if (w <= 8 || h <= 8) break;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }

    // Geometric sum of the scatter weights fed back into level 0.
    const n = this.levels.length;
    this.normalisation = n > 1 ? (1 - SCATTER) / (1 - Math.pow(SCATTER, n)) : 1;
    this.fullW = fullW;
    this.fullH = fullH;
  }

  render(sourceTexture) {
    if (!this.enabled || !this.levels.length) return;
    const r = this.renderer;
    const down = this.matDown;
    const up = this.matUp;

    // Level 0 is a 4x reduction in one step; spacing the 13-tap kernel two
    // source texels apart makes it cover the whole 8x8 footprint, so no source
    // detail is skipped even though we jump two mip levels.
    down.uniforms.tSrc.value = sourceTexture;
    down.uniforms.uTexel.value.set(2 / this.fullW, 2 / this.fullH);
    down.uniforms.uKaris.value = TUNE.bloom.karis ? 1 : 0;
    this.quad.render(r, down, this.levels[0]);

    down.uniforms.uKaris.value = 0;
    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1];
      down.uniforms.tSrc.value = src.texture;
      down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.quad.render(r, down, this.levels[i]);
    }

    for (let i = this.levels.length - 1; i > 0; i--) {
      const src = this.levels[i];
      up.uniforms.tSrc.value = src.texture;
      up.uniforms.uTexel.value.set(TUNE.bloom.filterRadius / src.width, TUNE.bloom.filterRadius / src.height);
      this.quad.render(r, up, this.levels[i - 1]);
    }
  }

  stats() {
    return this.enabled
      ? { on: true, levels: this.levels.length, base: this.levels.length ? `${this.levels[0].width}x${this.levels[0].height}` : '-' }
      : { on: false };
  }

  dispose() {
    for (const rt of this.levels) disposeTarget(rt);
    this.levels.length = 0;
    this.matDown.dispose();
    this.matUp.dispose();
    this.black.dispose();
  }
}
