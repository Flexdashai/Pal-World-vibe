import * as THREE from 'three';
import { ELEMENTS, ENV } from '../core/palette.js';

/**
 * MONARCH — `ai`'s material set.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUBSYSTEM BUILDS ITS OWN MATERIALS INSTEAD OF ASKING `materials`
 *
 * `materials.get()` returns a SHARED, CACHED material — which is exactly right
 * for a wall kit and exactly wrong for a character, because four things here
 * have to be per-actor:
 *
 *   1. the materialisation dissolve on a shadow soldier,
 *   2. the near-black + violet-rim treatment that turns any body into a shadow,
 *   3. a per-instance tint, so twenty ghouls are not twenty copies of one value,
 *   4. `fx.hitFlash`, which writes `emissive` on the struck actor's materials
 *      and explicitly REFUSES to do so on a material it has seen on two
 *      different roots (see fx/flash.js). Shared materials means no hit flash,
 *      which is the single most legible damage feedback in the genre.
 *
 * So the TEXTURES come from `materials.textures(name)` — the public hook that
 * exists for precisely this — and the materials are ours. Nothing here bakes a
 * texture; nothing here disposes one either, because the forge owns them.
 *
 * ---------------------------------------------------------------------------
 * ONE INJECTED SHADER, SHARED BY EVERY MATERIAL IN THIS DIRECTORY
 *
 * `render/patch.js` sets `customProgramCacheKey = () => 'mn3'` on every material
 * it patches. That means two materials with the same three.js parameter set and
 * DIFFERENT injected GLSL would collide in the program cache and one would be
 * drawn with the other's shader. So every material here shares one `onBeforeCompile`
 * and drives all its behaviour from uniforms, and the key is overridden to
 * `mn3.ai` after registration so it can never collide with an unpatched or a
 * plain-patched material either.
 *
 * The cost of uniform-driven rather than define-driven is about 20 ALU per
 * fragment on a character, which at 120 px of screen height is nothing.
 *
 * ---------------------------------------------------------------------------
 * TEXEL DENSITY
 *
 * Geometry is authored with UVs in metres. The forge's maps represent a patch
 * of `TILE` metres, so the mesh's UVs are pre-multiplied by `1 / TILE` in
 * `SkinBuilder.build`. Setting `.repeat` on the forge's textures instead would
 * re-scale every wall in the level, because those textures are shared.
 */

/** Metres covered by one tile of each family's baked maps. Characters want a
 *  finer density than architecture — a 0.35 m tile on a 2 m body gives roughly
 *  six texture repeats head to foot, which is the point at which bone grain and
 *  plate scratches are legible at 0.5 m and invisible at 21 m. */
const TILE = { bone: 0.34, metal: 0.30, flesh: 0.40, cloth: 0.44, stone: 0.85 };

/**
 * Family → forge surface + shading constants.
 *
 * Material separation is mandatory (ARCHITECTURE.md): plate, leather, cloth and
 * bone need visibly different roughness AND different normal detail scale. That
 * is what the `tile` column above and the `roughness`/`metalness` pair below
 * are for; one roughness across a character reads as plastic.
 */
const FAMILY = {
  bone: {
    surface: 'bone', colour: [0.128, 0.120, 0.100],
    roughness: 0.86, metalness: 0.0, normalScale: 1.15, aoIntensity: 1.0,
  },
  metal: {
    // Metals are 0 or 1 — never in between. Weathered plate is metal 1 with a
    // high roughness and a dirty albedo, not metal 0.4.
    surface: 'iron', colour: [0.30, 0.30, 0.315],
    roughness: 0.62, metalness: 1.0, normalScale: 1.05, aoIntensity: 1.0,
  },
  flesh: {
    surface: 'flesh', colour: [0.105, 0.078, 0.070],
    roughness: 0.70, metalness: 0.0, normalScale: 1.30, aoIntensity: 1.0,
  },
  cloth: {
    surface: 'banner', colour: [0.058, 0.048, 0.042],
    roughness: 0.94, metalness: 0.0, normalScale: 1.45, aoIntensity: 1.0,
    // A torn rag genuinely has two sides, and every rag in `bodies.js` is a
    // single open sheet: single-sided, half of them vanish depending on which
    // way the actor is facing. Cloth is the only family that pays for this.
    side: THREE.DoubleSide,
  },
  stone: {
    surface: 'granite', colour: [0.072, 0.070, 0.076],
    roughness: 0.88, metalness: 0.0, normalScale: 1.20, aoIntensity: 1.0,
  },
};

/** Which family each archetype's three parts use, and the emissive colour of
 *  its `glow` part. The glow colour is a character note: undead burn violet-
 *  cold, the knight burns holy-gold because it was consecrated, the beast burns
 *  blood-red, and the boss burns the signature shadow violet. */
export const SKINS = {
  ghoul: { body: 'bone', gear: 'cloth', eye: ELEMENTS.shadow.core, eyeGain: 3.1,
    tint: [1.0, 0.98, 0.94] },
  knight: { body: 'metal', gear: 'cloth', eye: ELEMENTS.holy.core, eyeGain: 2.4,
    tint: [0.92, 0.94, 1.0] },
  beast: { body: 'flesh', gear: 'bone', eye: ELEMENTS.blood.glow, eyeGain: 3.6,
    tint: [1.0, 0.95, 0.92] },
  caster: { body: 'cloth', gear: 'bone', eye: ELEMENTS.frost.core, eyeGain: 3.4,
    tint: [0.90, 0.93, 1.0] },
  brute: { body: 'flesh', gear: 'metal', eye: ELEMENTS.fire.core, eyeGain: 2.9,
    tint: [1.0, 0.93, 0.88] },
  // The boss's core is a LARGE emissive surface, not a pair of 3 px eyes, so
  // its gain is a third of an enemy's. Measured: at 5.2 the core rendered as a
  // white ball that erased the chest cavity framing it — the shadow palette's
  // `core` is 0.19/0.075/1.0, so anything above ~2 clips blue to full and the
  // AgX shoulder takes the rest to white. `glow` (0.60/0.40/1.0) clips to
  // violet-white instead, which is the colour this is supposed to be.
  boss: { body: 'stone', gear: 'metal', eye: ELEMENTS.shadow.glow, eyeGain: 0.85,
    tint: [0.96, 0.95, 1.0] },
  shade: { body: 'bone', gear: 'cloth', eye: ELEMENTS.shadow.glow, eyeGain: 4.4,
    tint: [1.0, 1.0, 1.0] },
};

/** UV scale (1/tile) for an archetype's three parts. */
export function uvScaleFor(skin) {
  return {
    body: 1 / TILE[skin.body],
    gear: 1 / TILE[skin.gear],
    // The glow part is untextured, so its UVs are irrelevant — leave them in
    // metres so a future emissive map lands at the same density as the body.
    glow: 1,
  };
}

/* ==========================================================================
 * the injected shader
 * ========================================================================== */

const VERT_HEAD = /* glsl */ `
varying vec3 vMnObj;
`;

// `transformed` is post-skinning object space, which is what the dissolve wants:
// a body authored feet-at-zero dissolves bottom-up regardless of where it is
// standing or which way it is facing.
const VERT_BODY = /* glsl */ `
	vMnObj = transformed;
`;

const FRAG_HEAD = /* glsl */ `
varying vec3 vMnObj;
uniform vec3 mnAiTint;
uniform vec4 mnAiRim;     // rgb = rim colour, a = strength
uniform vec2 mnAiForm;    // x = materialisation 0..1, y = body height in metres
uniform vec2 mnAiShade;   // x = shadow-soldier amount, y = emissive gain
uniform vec2 mnAiWear;    // x = blood/soot darkening, y = value variation

// Cheap 3D value hash. The dissolve front has to be RAGGED — a clean horizontal
// cut reads as a clipping plane, which is exactly the wrong idea.
float mnHash3( vec3 p ) {
	p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

// Normalised height up the body, 0 at the feet.
float mnBodyT() {
	return clamp( vMnObj.y / max( 0.001, mnAiForm.y ), 0.0, 1.0 );
}

// Where the dissolve front currently sits, in the same 0..1 space. Overshoots
// both ends so form = 0 hides everything and form = 1 shows everything even
// with the noise offset applied.
float mnFront() {
	return mnAiForm.x * 1.24 - 0.12;
}
`;

const FRAG_DISCARD = /* glsl */ `
	if ( mnAiForm.x < 0.999 ) {
		float mnJ = mnHash3( floor( vMnObj * 22.0 ) ) * 0.17;
		if ( mnBodyT() > mnFront() + mnJ ) discard;
	}
`;

const FRAG_COLOR = /* glsl */ `
	diffuseColor.rgb *= mnAiTint;
	// Per-actor value variation from object-space position, so two ghouls sharing
	// one geometry do not share one value. Cheap, and it is the difference
	// between "a horde" and "one mesh drawn twenty times".
	diffuseColor.rgb *= 1.0 - mnAiWear.y * ( 0.5 + 0.5 * mnHash3( floor( vMnObj * 3.0 ) ) );
	// Grime pooling downward: bodies that fight in a crypt are dirtier at the
	// hem than at the shoulder.
	diffuseColor.rgb *= 1.0 - mnAiWear.x * ( 1.0 - mnBodyT() ) * 0.55;
	// THE SHADOW TREATMENT. Near-black is NOT black: without the floor term and
	// the violet bias a shadow soldier becomes a hole in the frame, which the eye
	// reads as missing geometry rather than as a soldier.
	diffuseColor.rgb = mix(
		diffuseColor.rgb,
		diffuseColor.rgb * vec3( 0.11, 0.093, 0.17 ) + vec3( 0.0105, 0.0082, 0.0225 ),
		mnAiShade.x
	);
`;

const FRAG_EMISSIVE = /* glsl */ `
	{
		// Fresnel rim. On an ordinary enemy this is a faint cold edge that lifts
		// the silhouette off a black wall; on a shadow soldier it is the violet
		// that makes it read at all.
		float mnNdV = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
		// Exponent 2.6, not 3.4. At 3.4 the rim is a one-pixel line on a 30 px
		// limb and does nothing for readability; 2.2 wraps it far enough round
		// the form to separate a body from the wall behind it at 21 m.
		float mnF = pow( 1.0 - mnNdV, 2.6 );
		totalEmissiveRadiance += mnAiRim.rgb * ( mnAiRim.a * mnF );
		totalEmissiveRadiance *= mnAiShade.y;

		// The materialisation front: a hot band riding the dissolve edge. This is
		// the whole reason the soldier reads as being DRAWN rather than faded in.
		if ( mnAiForm.x < 0.999 ) {
			float mnJ = mnHash3( floor( vMnObj * 22.0 ) ) * 0.17;
			float mnD = abs( mnBodyT() - mnFront() - mnJ );
			float mnBand = 1.0 - clamp( mnD / 0.075, 0.0, 1.0 );
			totalEmissiveRadiance += mnAiRim.rgb * mnBand * mnBand * 7.5;
		}
	}
`;

/**
 * ONE function object shared by every material this subsystem builds — see the
 * class docblock for why that is load-bearing rather than a tidiness choice.
 */
function injectAi(shader) {
  const u = this.userData.mnAi;
  shader.uniforms.mnAiTint = u.tint;
  shader.uniforms.mnAiRim = u.rim;
  shader.uniforms.mnAiForm = u.form;
  shader.uniforms.mnAiShade = u.shade;
  shader.uniforms.mnAiWear = u.wear;

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
    .replace('#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>\n${FRAG_DISCARD}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
    .replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);
}

/* ==========================================================================
 * the set
 * ========================================================================== */

export class EnemyMaterials {
  /**
   * @param ctx        engine context
   * @param archetypes archetype id -> tuning entry, for the height of each body
   */
  constructor(ctx, archetypes) {
    this.ctx = ctx;
    this.archetypes = archetypes;
    this.render = ctx.peek('render');
    this.mats = ctx.peek('materials');

    /** family -> the template material every clone descends from. */
    this.templates = new Map();
    /** Everything we ever built, so `dispose()` is exhaustive. */
    this.owned = [];
    this.missingTextures = [];

    for (const [name, spec] of Object.entries(FAMILY)) {
      this.templates.set(name, this._buildFamily(name, spec));
    }
    this.glowTemplate = this._buildGlow();
  }

  _buildFamily(name, spec) {
    let maps = null;
    try {
      maps = this.mats?.textures?.(spec.surface) ?? null;
    } catch (err) {
      // A surface the forge cannot bake is not fatal — the material still
      // renders, it is simply flat. Recorded so `stats()` can report it rather
      // than the defect being invisible.
      this.missingTextures.push(`${spec.surface}: ${err?.message ?? err}`);
    }
    const m = new THREE.MeshStandardMaterial({
      name: `mn.ai.${name}`,
      color: new THREE.Color().setRGB(spec.colour[0], spec.colour[1], spec.colour[2],
        THREE.LinearSRGBColorSpace),
      roughness: spec.roughness,
      metalness: spec.metalness,
      emissive: new THREE.Color(0, 0, 0),
      emissiveIntensity: 1,
      // Enemies are solid. Transparency on a character is a per-frame sort and a
      // guaranteed artefact against the fog; the materialisation dissolve is a
      // discard for exactly that reason.
      transparent: false,
      side: spec.side ?? THREE.FrontSide,
      dithering: true,
    });
    if (maps?.albedo) {
      m.map = maps.albedo;
      m.normalMap = maps.normal;
      m.normalScale = new THREE.Vector2(spec.normalScale, spec.normalScale);
      // glTF ORM packing from the forge: r = AO, g = roughness, b = metalness.
      m.roughnessMap = maps.orm;
      m.metalnessMap = maps.orm;
      m.aoMap = maps.orm;
      m.aoMapIntensity = spec.aoIntensity;
    }
    this._attach(m, spec);
    return m;
  }

  _buildGlow() {
    // No maps at all. The glow part is a couple of hundred triangles of pure
    // emissive; a texture on it would be invisible and would cost a fetch on
    // every one of the brightest pixels in the frame.
    const m = new THREE.MeshStandardMaterial({
      name: 'mn.ai.glow',
      color: new THREE.Color(0, 0, 0),
      roughness: 0.4,
      metalness: 0,
      emissive: new THREE.Color(1, 1, 1),
      emissiveIntensity: 3,
      transparent: false,
      side: THREE.DoubleSide,
    });
    this._attach(m, { roughness: 0.4, metalness: 0 });
    return m;
  }

  /** Give a material its uniform block, the shared injection, and the patch. */
  _attach(m) {
    m.userData.mnAi = {
      tint: { value: new THREE.Vector3(1, 1, 1) },
      rim: { value: new THREE.Vector4(0.42, 0.30, 0.95, 0.0) },
      form: { value: new THREE.Vector2(1, 2) },
      shade: { value: new THREE.Vector2(0, 1) },
      wear: { value: new THREE.Vector2(0.18, 0.10) },
    };
    m.onBeforeCompile = injectAi;
    this.owned.push(m);
    // Register so render's AO / occluder-fade / glow patch is applied BEFORE the
    // first draw. The patcher chains our `onBeforeCompile` (it calls the
    // previous one first) and then overwrites the cache key, so we put ours back
    // — see the class docblock.
    this.render?.registerMaterial?.(m);
    m.customProgramCacheKey = () => 'mn3.ai';
    m.needsUpdate = true;
    return m;
  }

  /**
   * A per-actor clone. Textures, and therefore GPU memory, are shared; what is
   * private is the uniform block, the emissive (so `fx.hitFlash` can own it)
   * and the program cache key (which is identical, so no new program).
   */
  clone(family) {
    const src = family === 'glow' ? this.glowTemplate : this.templates.get(family);
    if (!src) return null;
    const m = src.clone();
    m.name = `${src.name}.i`;
    // `Material.clone()` copies userData by reference for objects, which would
    // make every clone share one uniform block — the exact bug this class
    // exists to avoid. Rebuild it.
    m.userData = { mnAi: null };
    this._attach(m);
    return m;
  }

  /**
   * Configure one actor's three materials for an archetype.
   *
   * @param set   { body, gear, glow } materials from `clone()`
   * @param skin  an entry from SKINS
   * @param o     { height, tint:[r,g,b], shadow:0..1, rim:[r,g,b], rimStrength,
   *                glowGain, wear, variation }
   */
  configure(set, skin, o = {}) {
    const h = o.height ?? 1.9;
    const shadow = o.shadow ?? 0;
    const tint = o.tint ?? skin.tint ?? [1, 1, 1];
    const rim = o.rim ?? (shadow > 0 ? ELEMENTS.shadow.glow : [0.34, 0.40, 0.62]);
    /**
     * MEASURED. The first build ran ordinary enemies at 0.14 and they were
     * invisible: at 21 m an unlit enemy against an unlit wall is two hundred
     * pixels of the same near-black, and `analyze.mjs` already reports 44% of
     * the frame crushed to information-free black.
     *
     * 0.95 with a COLD, desaturated colour is the fix that does not lift the
     * blacks: it puts light only on the grazing edge, which is exactly where a
     * silhouette lives, and it reads as moonlight rather than as a rim shader.
     * 1.55 was tried and overshot — the horde came back looking like pale
     * silver ghosts rather than like dead things standing in the dark.
     * The shadow soldiers get 2.2 in violet, because that contrast — the one
     * saturated thing in the frame being the player's army — IS the art
     * direction.
     */
    const rimK = o.rimStrength ?? (shadow > 0 ? 2.0 : 0.95);

    for (const key of ['body', 'gear', 'glow']) {
      const m = set[key];
      if (!m) continue;
      const u = m.userData.mnAi;
      u.tint.value.set(tint[0], tint[1], tint[2]);
      u.form.value.set(o.form ?? 1, h);
      u.rim.value.set(rim[0], rim[1], rim[2], key === 'glow' ? 0 : rimK);
      u.shade.value.set(key === 'glow' ? 0 : shadow, o.glowGain ?? 1);
      u.wear.value.set(o.wear ?? 0.18, o.variation ?? 0.10);
    }

    // The eyes. Their colour is per-archetype and their gain is the one number
    // that decides whether an enemy reads at 40 px, so it is set here and
    // modulated per-frame by the actor (alert, wind-up, death).
    const glow = set.glow;
    if (glow) {
      const c = o.eye ?? skin.eye ?? ELEMENTS.shadow.core;
      glow.emissive.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
      glow.emissiveIntensity = (o.eyeGain ?? skin.eyeGain ?? 3) * (shadow > 0 ? 1.3 : 1);
    }
    return set;
  }

  /** Per-frame: how far a materialising body has been drawn, 0..1. */
  setForm(set, form) {
    for (const key of ['body', 'gear', 'glow']) {
      const m = set[key];
      if (m) m.userData.mnAi.form.value.x = form;
    }
  }

  /** Per-frame: emissive gain, for a wind-up glow or a boss's exposed core. */
  setGlowGain(set, gain) {
    for (const key of ['body', 'gear']) {
      const m = set[key];
      if (m) m.userData.mnAi.shade.value.y = gain;
    }
  }

  setRimStrength(set, k) {
    for (const key of ['body', 'gear']) {
      const m = set[key];
      if (m) m.userData.mnAi.rim.value.w = k;
    }
  }

  stats() {
    return {
      families: this.templates.size,
      instances: this.owned.length,
      missingTextures: this.missingTextures.length ? this.missingTextures : 'none',
    };
  }

  /** Only the materials are ours; the forge owns the textures and disposes
   *  them, so nothing here touches `map`/`normalMap`/`roughnessMap`. */
  dispose() {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.templates.clear();
  }
}

export { FAMILY, TILE, ENV };
