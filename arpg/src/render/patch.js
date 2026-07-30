import * as THREE from 'three';
import { OCCLUDER_FADE, OCCLUDER_UNIFORMS } from './glsl.js';
import { TUNE } from './tuning.js';

/**
 * Global lit-material patch.
 *
 * Three things the renderer owns have to happen INSIDE other agents' materials,
 * because there is no correct way to do them afterwards:
 *
 *  1. **Screen-space ambient occlusion** must multiply the INDIRECT terms only.
 *     Multiplying the final HDR colour by AO — the cheap way every WebGL demo
 *     does it — darkens direct light too, so a brazier-lit wall gets a dirty
 *     smear where the wall meets the floor instead of a soft contact shadow.
 *     three's `aomap_fragment` chunk sits in exactly the right place, after
 *     `lights_fragment_end`, and already does the correct thing with specular
 *     occlusion; we just replace the source of `ambientOcclusion` with our
 *     screen-space buffer.
 *  2. **Occluder fade** needs a per-fragment test (is this fragment in front of
 *     the player, near them on screen?) plus a `discard`. That is a shader edit.
 *  3. **`userData.mnGlow`** scales emissive radiance, which is what drives the
 *     threshold-free bloom pyramid.
 *
 * Mechanism: `material.onBeforeCompile` plus `customProgramCacheKey`. The
 * uniforms we inject are attached AFTER three has cloned the built-in uniform
 * set, using shared `{ value }` objects, so one assignment updates every
 * material in the game. (Adding them to `THREE.ShaderLib` instead does not work:
 * `UniformsUtils.clone` deep-copies uniform values and explicitly nulls render
 * target textures.)
 *
 * Cost control: the injected code is ~10 ALU plus one bilinear tap on the
 * quarter-area AO buffer. The fade block is behind `if ( mnFade > 0.0 )`, and
 * `mnFade` is a uniform, so on a software rasteriser it is a genuinely predicted
 * branch that costs nothing for the 95% of materials that never fade.
 */

/** Bumped whenever the injected GLSL changes, so a hot-reloaded material with a
 *  stale patch is re-patched rather than silently keeping the old code. */
const PATCH_VERSION = 3;

const AO_APPLY = /* glsl */ `
	// --- MONARCH screen-space AO -------------------------------------------
	// One bilinear tap on the half-resolution, already-denoised AO buffer.
	// A depth-aware upsample here would be 4-5 taps across every lit pixel in
	// the frame; the AO pass does its bilateral filtering at half res instead,
	// where it costs a quarter as much.
	float mnAO = texture2D( mnAoTex, gl_FragCoord.xy * mnScreen.zw ).r;
	mnAO = mix( 1.0, mnAO, mnAoParams.x );

	#ifdef USE_AOMAP
		mnAO *= ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	#endif

	reflectedLight.indirectDiffuse *= mnAO;

	#if defined( USE_CLEARCOAT )
		clearcoatSpecularIndirect *= mnAO;
	#endif

	#if defined( USE_SHEEN )
		sheenSpecularIndirect *= mnAO;
	#endif

	#if defined( STANDARD )
		// Specular occlusion: a crevice occludes grazing reflections much more
		// than it occludes diffuse, which is what stops AO'd stone from looking
		// like it has a plastic sheen in the corners.
		float mnDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( mnDotNV, mnAO, material.roughness );
	#endif

	// A small amount of AO on DIRECT light as well. Physically this is wrong,
	// but a punctual light has no area, so nothing else in the model can
	// darken the corner where two walls meet, and Diablo IV's crypts are built
	// almost entirely out of that corner. Kept low so it reads as bounce
	// occlusion rather than as dirt.
	reflectedLight.directDiffuse *= mix( 1.0, mnAO, mnAoParams.y );
`;

const GLOW_APPLY = /* glsl */ `
	totalEmissiveRadiance *= mnGlow;
`;

const PATCHABLE = (m) =>
  m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial ||
        m.isMeshPhongMaterial || m.isMeshLambertMaterial || m.isMeshToonMaterial);

export class MaterialPatcher {
  /**
   * @param {object} shared - shared uniform holders owned by RenderSystem:
   *   { aoTex, screen, fadeParams, aoParams }
   */
  constructor(shared) {
    this.shared = shared;
    this.patched = new Set();
    /** Materials that belong to a registered occluder this frame. Rebuilt by
     *  `RenderSystem._collect`, so a mesh that stops being an occluder stops
     *  paying for the branch. */
    this.count = 0;
  }

  /**
   * Patch one material. Safe to call repeatedly; only the first call per
   * material triggers a recompile.
   *
   * Other subsystems should call `render.registerMaterial(m)` on anything they
   * build during `prewarmMaterials()` but do not add to `ctx.scene` until later
   * — otherwise the material compiles unpatched during pre-warm and recompiles
   * the first frame it is drawn, which is precisely the stall pre-warm exists
   * to prevent.
   */
  patch(material) {
    if (!PATCHABLE(material)) return false;
    if (material.userData.__mnPatch === PATCH_VERSION) return false;

    material.userData.__mnPatch = PATCH_VERSION;
    this.patched.add(material);
    this.count = this.patched.size;

    // Per-material uniforms. `mnFade` and `mnGlow` are per material (a wall kit
    // fades, a floor never does); everything else is shared by reference.
    const uFade = { value: 0 };
    const uGlow = { value: 1 };
    material.userData.__mnFade = uFade;
    material.userData.__mnGlow = uGlow;

    const shared = this.shared;
    const prev = material.onBeforeCompile;

    material.onBeforeCompile = function (shader, renderer) {
      if (typeof prev === 'function') prev.call(this, shader, renderer);

      shader.uniforms.mnAoTex = shared.aoTex;
      shader.uniforms.mnScreen = shared.screen;
      shader.uniforms.mnFadeParams = shared.fadeParams;
      shader.uniforms.mnAoParams = shared.aoParams;
      shader.uniforms.mnFrame = shared.frame;
      shader.uniforms.mnFade = uFade;
      shader.uniforms.mnGlow = uGlow;

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D mnAoTex;
uniform vec2 mnAoParams;   // x = indirect strength, y = direct strength
uniform float mnGlow;
${OCCLUDER_UNIFORMS}
#define MN_FADE_CORE ${TUNE.occluder.core.toFixed(3)}
#define MN_FADE_MIN ${TUNE.occluder.minAlpha.toFixed(3)}`
        )
        // Earliest safe discard point in a lit material's main().
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${OCCLUDER_FADE}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GLOW_APPLY}`)
        .replace('#include <aomap_fragment>', AO_APPLY);
    };

    // Without a distinct cache key three would hand a patched material the
    // program compiled for an identical unpatched one.
    material.customProgramCacheKey = () => `mn${PATCH_VERSION}`;
    material.needsUpdate = true;
    return true;
  }

  /** Per-frame: set this material's occluder-fade amount (0..1). */
  setFade(material, amount) {
    const u = material?.userData?.__mnFade;
    if (u) u.value = amount;
  }

  /** Per-frame: set this material's emissive multiplier. */
  setGlow(material, amount) {
    const u = material?.userData?.__mnGlow;
    if (u) u.value = amount;
  }

  dispose() {
    // Materials are owned by other subsystems; we only remove our hook so a
    // disposed renderer does not keep references alive through the closure.
    for (const m of this.patched) {
      m.onBeforeCompile = THREE.Material.prototype.onBeforeCompile;
      m.customProgramCacheKey = THREE.Material.prototype.customProgramCacheKey;
      delete m.userData.__mnPatch;
      m.needsUpdate = true;
    }
    this.patched.clear();
    this.count = 0;
  }
}
