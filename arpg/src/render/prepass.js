import * as THREE from 'three';
import { OCCLUDER_FADE, OCCLUDER_UNIFORMS } from './glsl.js';
import { TUNE } from './tuning.js';

/**
 * Depth / normal / velocity prepass into an MRT.
 *
 * WHY A SEPARATE PASS instead of writing extra attachments from the lit pass:
 * the lit materials belong to other subsystems and are built-in `MeshStandard`
 * materials, which three compiles with exactly one colour output. Adding a
 * second output would mean rewriting every material's fragment stage. A prepass
 * costs one extra geometry submission with a ~15-instruction shader, and pays
 * for itself twice over: it gives early-Z rejection for the genuinely expensive
 * lit pass, and it gives GTAO/SSR/DOF a depth buffer containing OPAQUE geometry
 * only, which is what all three of them actually want.
 *
 * MRT layout (see targets.js):
 *   COLOR0  rgb = view-space normal      a = perceptual roughness
 *   COLOR1  rg  = motion vector (UV)     b = metalness   a = coverage
 *
 * Skinning, instancing, batching and morph targets need no work here: three
 * derives `USE_SKINNING` / `USE_INSTANCING` / `USE_BATCHING` / `USE_MORPHTARGETS`
 * from the OBJECT, not the material, and applies them to `ShaderMaterial` too —
 * so one material definition covers a static wall, an InstancedMesh of pillars
 * and a skinned enemy, with three compiling the three programs automatically.
 */

const VERT = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>

uniform mat4 mnPrevViewProj;
uniform mat4 mnProjNoJitter;
uniform mat3 mnUvTransform;

varying vec3 vMnNormal;
varying vec2 vMnUv;
varying vec4 vMnClipCur;
varying vec4 vMnClipPrev;

void main() {

	#include <batching_vertex>

	vMnUv = ( mnUvTransform * vec3( uv, 1.0 ) ).xy;

	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>

	vMnNormal = transformedNormal;

	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>

	// Object -> world, mirroring the chain <project_vertex> uses for
	// object -> view, so instanced and batched geometry gets correct motion.
	vec4 mnObj = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		mnObj = batchingMatrix * mnObj;
	#endif
	#ifdef USE_INSTANCING
		mnObj = instanceMatrix * mnObj;
	#endif
	vec4 mnWorld = modelMatrix * mnObj;

	// Both clip positions use the UNJITTERED projection: TAA needs a motion
	// vector that describes scene motion only. Folding the jitter into it would
	// make the history lookup chase the jitter pattern instead of the geometry.
	vMnClipCur  = mnProjNoJitter * viewMatrix * mnWorld;
	vMnClipPrev = mnPrevViewProj * mnWorld;

}
`;

const FRAG = /* glsl */ `
#include <common>

uniform float mnRoughness;
uniform float mnMetalness;

#ifdef MN_ROUGHNESSMAP
	uniform sampler2D mnRoughnessMap;
#endif

#ifdef MN_ALPHATEST
	uniform sampler2D mnAlphaTex;
	uniform float mnAlphaCutoff;
#endif

${OCCLUDER_UNIFORMS}

varying vec3 vMnNormal;
varying vec2 vMnUv;
varying vec4 vMnClipCur;
varying vec4 vMnClipPrev;

layout(location = 0) out vec4 gNormalRough;
layout(location = 1) out vec4 gVelMetal;

void main() {

	#ifdef MN_ALPHATEST
		if ( texture2D( mnAlphaTex, vMnUv ).a < mnAlphaCutoff ) discard;
	#endif

	// The prepass has to dither out with the lit pass, or SSR keeps reflecting
	// off a wall the player can see straight through and AO keeps occluding
	// under it.
${OCCLUDER_FADE}

	float rough = mnRoughness;
	#ifdef MN_ROUGHNESSMAP
		rough *= texture2D( mnRoughnessMap, vMnUv ).g;
	#endif

	vec3 n = normalize( vMnNormal );
	#ifdef MN_DOUBLE_SIDED
		if ( ! gl_FrontFacing ) n = -n;
	#endif

	vec2 cur = vMnClipCur.xy / vMnClipCur.w;
	vec2 prv = vMnClipPrev.xy / vMnClipPrev.w;

	gNormalRough = vec4( n, clamp( rough, 0.015, 1.0 ) );
	// * 0.5 converts NDC delta to UV delta.
	gVelMetal = vec4( ( cur - prv ) * 0.5, clamp( mnMetalness, 0.0, 1.0 ), 1.0 );

}
`;

/** Layer used to select which meshes participate in the prepass.
 *  RESERVED BY `render`. No other subsystem may use layer 31. */
export const PREPASS_LAYER = 31;

export class Prepass {
  constructor(shared, quality) {
    this.shared = shared;
    this.quality = quality;
    /** source material -> prepass variant */
    this._variants = new Map();
    /** Meshes swapped this frame, so the restore loop touches nothing else. */
    this._swapped = [];
    this._prevViewProj = new THREE.Matrix4();
    this._projNoJitter = new THREE.Matrix4();
    this._identityUv = new THREE.Matrix3();
    this._programs = 0;
  }

  /**
   * Get (and lazily build) the prepass variant of a source material.
   * Variants share one program per define-set; the per-material cost is a
   * uniform block, not a shader compile.
   */
  variantFor(src) {
    let v = this._variants.get(src);
    if (v && v.userData.__srcVersion === src.version) return v;

    if (!v) {
      const defines = {};
      // Roughness maps matter: they are how a floor gets wet patches, and SSR
      // reads roughness to decide how much to blur and whether to trace at all.
      const rmap = src.roughnessMap ?? null;
      if (rmap) defines.MN_ROUGHNESSMAP = '';
      const alphaTex = src.alphaTest > 0 ? (src.alphaMap ?? src.map ?? null) : null;
      if (alphaTex) defines.MN_ALPHATEST = '';
      if (src.side === THREE.DoubleSide) defines.MN_DOUBLE_SIDED = '';
      defines.MN_FADE_CORE = TUNE.occluder.core.toFixed(3);
      defines.MN_FADE_MIN = TUNE.occluder.minAlpha.toFixed(3);

      v = new THREE.ShaderMaterial({
        name: `mn.prepass(${src.name || src.type})`,
        glslVersion: THREE.GLSL3,      // required: two `layout(location=N) out` targets
        defines,
        uniforms: {
          mnPrevViewProj: { value: this._prevViewProj },
          mnProjNoJitter: { value: this._projNoJitter },
          mnUvTransform: { value: new THREE.Matrix3() },
          mnRoughness: { value: 1 },
          mnMetalness: { value: 0 },
          mnRoughnessMap: { value: rmap },
          mnAlphaTex: { value: alphaTex },
          mnAlphaCutoff: { value: 0.5 },
          mnScreen: this.shared.screen,
          mnFadeParams: this.shared.fadeParams,
          mnFrame: this.shared.frame,
          mnFade: { value: 0 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        lights: false,
        fog: false,
        toneMapped: false,
        side: src.side,
        depthTest: true,
        depthWrite: true,
      });
      v.userData.__src = src;
      this._variants.set(src, v);
      this._programs++;
    }

    this._sync(v, src);
    v.userData.__srcVersion = src.version;
    return v;
  }

  /** Copy the values (not the structure) of the source material across. */
  _sync(v, src) {
    const u = v.uniforms;
    u.mnRoughness.value = src.roughness ?? 0.85;
    u.mnMetalness.value = src.metalness ?? 0.0;
    u.mnAlphaCutoff.value = src.alphaTest ?? 0.5;
    v.side = src.side;

    // UV transform: prefer the map three would actually use, so tiling matches.
    const tex = src.roughnessMap ?? src.alphaMap ?? src.map ?? null;
    if (tex) {
      if (tex.matrixAutoUpdate) tex.updateMatrix();
      u.mnUvTransform.value.copy(tex.matrix);
    } else {
      u.mnUvTransform.value.identity();
    }
  }

  /**
   * Swap in prepass materials for the collected meshes.
   * @param {THREE.Mesh[]} meshes  already filtered by `_collect`
   */
  bind(meshes) {
    const swapped = this._swapped;
    swapped.length = 0;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      const src = m.material;
      if (!src || Array.isArray(src)) continue;   // multi-material meshes: skip, rare and not worth the branch
      const v = this.variantFor(src);
      // Mirror the occluder fade amount so depth and normals dissolve with the
      // shaded surface.
      v.uniforms.mnFade.value = src.userData?.__mnFade?.value ?? 0;
      m.userData.__mnSrcMat = src;
      m.material = v;
      swapped.push(m);
    }
  }

  /** Put the real materials back. Must run even if the render threw. */
  unbind() {
    const swapped = this._swapped;
    for (let i = 0; i < swapped.length; i++) {
      const m = swapped[i];
      m.material = m.userData.__mnSrcMat;
      m.userData.__mnSrcMat = null;
    }
    swapped.length = 0;
  }

  /** Called once per frame before `bind()`. */
  setMatrices(projNoJitter, prevViewProj) {
    this._projNoJitter.copy(projNoJitter);
    this._prevViewProj.copy(prevViewProj);
  }

  stats() { return { variants: this._variants.size }; }

  dispose() {
    for (const v of this._variants.values()) v.dispose();
    this._variants.clear();
    this._swapped.length = 0;
  }
}
