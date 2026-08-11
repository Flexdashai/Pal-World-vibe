import * as THREE from 'three';
import { RARITY } from '../core/palette.js';
import { RARITY_ORDER } from './tuning.js';

/**
 * MONARCH — the loot material set.
 *
 * ---------------------------------------------------------------------------
 * ONE MATERIAL PER RARITY, NOT ONE PER ITEM
 *
 * ARCHITECTURE.md requires rarity to escalate through MATERIAL TREATMENT —
 * "dull iron → polished with trim → cut runes with an ember glow → violet
 * energy bleeding off the edges" — while the geometry stays whatever the base
 * type is. That is exactly five materials, shared by every drop on the floor,
 * so a legendary greatsword and a common greatsword are the same geometry drawn
 * with a different material and nothing else.
 *
 * The per-vertex `aSurf` attribute (roughness, metalness, emissive mask) built
 * by `geokit.js` is what lets one material draw steel, leather, gold and a
 * glowing rune in a single draw call. Three declares `roughnessFactor` and
 * `metalnessFactor` as LOCALS inside their chunks, so overriding them per
 * fragment is a two-line injection rather than a bespoke material — which
 * matters, because a bespoke material would not receive `render`'s AO, occluder
 * fade or bloom-glow patch.
 *
 * ---------------------------------------------------------------------------
 * PATCH COMPOSITION — the subtle part
 *
 * `render.registerMaterial()` chains onto `onBeforeCompile` and replaces the
 * same chunk tokens this file replaces. So every injection here APPENDS after
 * the token and leaves the token in place, letting render's later replace still
 * match. Removing a token would silently drop render's AO or glow from these
 * materials, and the loss is invisible in a screenshot.
 *
 * `defines.MN_LOOT` is not decoration: three folds `material.defines` into the
 * program cache key, and render's patcher overwrites `customProgramCacheKey`
 * with a constant. Without a define these materials could be handed a program
 * compiled for someone else's MeshStandardMaterial with the same flags.
 */

/**
 * Per-rarity treatment.
 *
 *   emit       radiance multiplier on the `aSurf.z` rune mask
 *   rim        fresnel-edge radiance — the "energy bleeding off the edges"
 *   desat      pulls the albedo toward its own luminance. A common item is
 *              nearly monochrome, which is what makes the violet on a mythic
 *              read as the only saturated thing in frame (the 0.30 luminance-
 *              weighted saturation target in ARCHITECTURE.md)
 *   rough      roughness bias. Negative = polished.
 *   pulse      amplitude of the slow breathing on the emissive
 *   glow       userData.mnGlow — how much of the emissive reaches the bloom
 *              pyramid. Kept below 2 even on mythic: the measured brazier
 *              defect in this build is a blown-out white disc, and the fix
 *              there was small bright AREA with a strong gradient, not less
 *              brightness. The same discipline applies here.
 */
export const TREATMENT = {
  common: { emit: 0.0, rim: 0.02, desat: 0.72, rough: 0.20, pulse: 0.0, glow: 1.0 },
  magic: { emit: 0.85, rim: 0.10, desat: 0.42, rough: 0.02, pulse: 0.10, glow: 1.1 },
  rare: { emit: 1.7, rim: 0.20, desat: 0.24, rough: -0.06, pulse: 0.14, glow: 1.25 },
  legendary: { emit: 3.4, rim: 0.52, desat: 0.10, rough: -0.10, pulse: 0.20, glow: 1.55 },
  mythic: { emit: 4.6, rim: 0.95, desat: 0.00, rough: -0.13, pulse: 0.26, glow: 1.8 },
};

/* ==========================================================================
 * the item material
 * ========================================================================== */

const ITEM_VERT_DECL = /* glsl */ `
attribute vec3 aSurf;
varying vec3 vLootSurf;
`;

const ITEM_FRAG_DECL = /* glsl */ `
varying vec3 vLootSurf;
uniform vec4 uLootTreat;   // x emit, y rim, z desat, w roughness bias
uniform vec3 uLootEmit;    // rarity colour, LINEAR, already gained
uniform float uLootTime;
uniform float uLootPulse;
`;

/**
 * The emissive term.
 *
 * Two independent contributions with different spatial distributions, which is
 * what stops it reading as "the whole object is glowing":
 *
 *  1. the rune mask — cut grooves, inlays and gems only, a few per cent of the
 *     surface area, so it can be genuinely bright without clipping a big patch
 *  2. a fresnel rim — grazing angles only, so it traces the SILHOUETTE. That is
 *     the "violet energy bleeding off the edges" read, and it is also the only
 *     part of this that survives at 30 px, because at that size the silhouette
 *     is most of what the eye receives.
 *
 * The pulse is a single slow sine on the rune term only. The rim is steady: a
 * pulsing silhouette reads as a flicker bug rather than as power.
 */
const ITEM_EMISSIVE = /* glsl */ `
	{
		float mnMask = vLootSurf.z;
		float mnPulse = 1.0 + uLootPulse * sin( uLootTime * 1.9 + vLootSurf.x * 9.0 );
		vec3 mnN = normalize( normal );
		vec3 mnV = normalize( vViewPosition );
		float mnNdV = clamp( dot( mnN, mnV ), 0.0, 1.0 );
		float mnRim = pow( 1.0 - mnNdV, 3.4 );
		totalEmissiveRadiance += uLootEmit * ( mnMask * uLootTreat.x * mnPulse + mnRim * uLootTreat.y );
	}
`;

/** Albedo desaturation, applied after three's vertex-colour multiply. */
const ITEM_DESAT = /* glsl */ `
	{
		float mnLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( mnLum ), uLootTreat.z );
	}
`;

export function createItemMaterial(rarity) {
  const T = TREATMENT[rarity] ?? TREATMENT.common;
  const lin = RARITY[rarity]?.linear ?? RARITY.common.linear;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.5,
    // `emissive` must be non-black or three compiles the material without the
    // emissive path at all and the injection above writes into a variable that
    // is then discarded. A tiny non-zero value costs nothing and keeps the
    // uniform live.
    emissive: new THREE.Color(0.004, 0.004, 0.005),
    emissiveIntensity: 1.0,
    side: THREE.FrontSide,
    dithering: true,
  });
  mat.name = `mn.loot.item.${rarity}`;
  mat.defines = { MN_LOOT: '' };

  const uTreat = { value: new THREE.Vector4(T.emit, T.rim, T.desat, T.rough) };
  const uEmit = { value: new THREE.Color().setRGB(lin[0], lin[1], lin[2], THREE.LinearSRGBColorSpace) };
  const uTime = { value: 0 };
  const uPulse = { value: T.pulse };

  mat.userData.mnLoot = { uTreat, uEmit, uTime, uPulse, rarity, glow: T.glow };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLootTreat = uTreat;
    shader.uniforms.uLootEmit = uEmit;
    shader.uniforms.uLootTime = uTime;
    shader.uniforms.uLootPulse = uPulse;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ITEM_VERT_DECL}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvLootSurf = aSurf;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ITEM_FRAG_DECL}`)
      // Append, never replace: render's patcher matches these same tokens.
      .replace('#include <color_fragment>', `#include <color_fragment>\n${ITEM_DESAT}`)
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = clamp( vLootSurf.x + uLootTreat.w, 0.045, 1.0 );')
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n\tmetalnessFactor = clamp( vLootSurf.y, 0.0, 1.0 );')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${ITEM_EMISSIVE}`);
  };

  return mat;
}

/** All five, built once. */
export function createItemMaterials() {
  const map = new Map();
  for (const r of RARITY_ORDER) map.set(r, createItemMaterial(r));
  return map;
}

/* ==========================================================================
 * the beam
 * ========================================================================== */

/**
 * The rarity beam.
 *
 * A tapered open cylinder drawn additively, one instanced draw call for every
 * drop on the floor. The whole read comes from three terms:
 *
 *  1. a vertical falloff, `pow(1-h, 2.2)`, so 80% of the emitted light is in the
 *     bottom quarter. The tall part of the beam is a hint, not a lamp — that is
 *     both how a real light shaft looks and what keeps the bright AREA small
 *     enough that the tone mapper never clips a big patch to white
 *  2. an INVERTED fresnel: the cylinder is brightest where its surface is
 *     edge-on to the camera, which is what makes a hollow tube read as a
 *     volume of glowing air rather than as a piece of curved paper
 *  3. two counter-scrolling striation bands, so it has internal motion without
 *     any per-frame CPU work
 *
 * `aBeam` is (gain, phase, rank, riseT); `aBeamCol` is the linear rarity colour.
 * Both are per instance, so a single material serves all five rarities.
 */
export function createBeamMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec4 aBeam;
      attribute vec3 aBeamCol;
      varying vec2 vUvB;
      varying vec4 vBeam;
      varying vec3 vColB;
      varying vec3 vNrmW;
      varying vec3 vViewW;

      void main() {
        vUvB = uv;
        vBeam = aBeam;
        vColB = aBeamCol;
        vec4 world = instanceMatrix * vec4( position, 1.0 );
        world = modelMatrix * world;
        // The normal only needs to be right up to sign for the fresnel term,
        // and the beam is always axis-aligned and uniformly scaled in XZ, so
        // the cheap transform is exact here.
        vec3 n = mat3( instanceMatrix ) * normalize( vec3( position.x, 0.0, position.z ) );
        vNrmW = normalize( mat3( modelMatrix ) * n );
        vViewW = normalize( cameraPosition - world.xyz );
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUvB;
      varying vec4 vBeam;
      varying vec3 vColB;
      varying vec3 vNrmW;
      varying vec3 vViewW;
      uniform float uTime;

      void main() {
        float h = clamp( vUvB.y, 0.0, 1.0 );
        float gain = vBeam.x;
        float phase = vBeam.y;
        float rank = vBeam.z;
        float rise = clamp( vBeam.w, 0.0, 1.0 );

        // Vertical envelope. The extra floor term keeps a faint column all the
        // way to the top so the beam has a visible LENGTH — a pure power curve
        // vanishes at 40% and the beam stops reading across the room.
        float body = pow( 1.0 - h, 2.2 ) * 0.86 + pow( 1.0 - h, 0.55 ) * 0.14;
        // Hide the hard intersection with the floor: the bottom 7% ramps in.
        body *= smoothstep( 0.0, 0.07, h );
        // The rise envelope sweeps a bright front upward as the beam punches in.
        body *= smoothstep( rise * 1.35 + 0.02, rise * 1.35 - 0.20, h );

        // Inverted fresnel — bright at the silhouette of the tube.
        float ndv = abs( dot( normalize( vNrmW ), normalize( vViewW ) ) );
        float edge = pow( 1.0 - ndv, 1.7 ) * 0.80 + 0.20;

        // Internal motion: two counter-scrolling bands at incommensurate rates,
        // never noise — this has to be identical frame for frame in a capture.
        float t = uTime + phase;
        float s1 = 0.5 + 0.5 * sin( h * 26.0 - t * 1.6 );
        float s2 = 0.5 + 0.5 * sin( h * 11.0 + t * 0.9 + 2.1 );
        float striate = mix( 0.80, 1.20, s1 * 0.55 + s2 * 0.45 );

        // Rank >= 1 (legendary and up) gets a slow spiral, which is the single
        // clearest "this one is different" cue at a distance where the colour
        // is already competing with the braziers.
        float spiral = 1.0;
        if ( rank > 0.5 ) {
          float a = atan( vNrmW.z, vNrmW.x );
          spiral = mix( 0.72, 1.34, 0.5 + 0.5 * sin( a * 3.0 + h * 9.0 - t * 2.2 ) );
        }

        float a = body * edge * striate * spiral * gain;
        gl_FragColor = vec4( vColB * a, 1.0 );
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  mat.name = 'mn.loot.beam';
  return mat;
}

/* ==========================================================================
 * the ground pool
 * ========================================================================== */

/**
 * The disc of light under a drop.
 *
 * Does three jobs at once and each one matters: it GROUNDS the floating item
 * (a mesh hovering over a floor with no light under it reads as a bug), it
 * hides the beam's intersection with the flagstones, and above legendary it
 * carries a rotating rune ring which is the "this is a big one" tell that reads
 * even when the item itself is behind a column.
 *
 * Bright at the RIM rather than the centre. A uniformly bright disc is the
 * fastest way to produce the blown-out white patch this build is already
 * fighting; a ring keeps the lit area to a few hundred square centimetres.
 */
export function createGlowMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec4 aBeam;
      attribute vec3 aBeamCol;
      varying vec2 vUvG;
      varying vec4 vBeam;
      varying vec3 vColB;
      void main() {
        vUvG = uv;
        vBeam = aBeam;
        vColB = aBeamCol;
        vec4 world = modelMatrix * instanceMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUvG;
      varying vec4 vBeam;
      varying vec3 vColB;
      uniform float uTime;

      void main() {
        vec2 p = vUvG * 2.0 - 1.0;
        float r = length( p );
        if ( r > 1.0 ) discard;
        float gain = vBeam.x;
        float phase = vBeam.y;
        float rank = vBeam.z;
        float rise = clamp( vBeam.w, 0.0, 1.0 );
        float t = uTime + phase;

        // Pool: a soft interior with a defined rim at 0.62 of the radius.
        float pool = pow( 1.0 - r, 2.4 ) * 0.55;
        float rim = exp( -pow( ( r - 0.60 ) * 6.5, 2.0 ) ) * 0.85;

        float a = pool + rim;

        // Rune ring: six spokes and a broken circle, rotating slowly. Cheap —
        // two trig calls — and it is the difference between "a light on the
        // floor" and "a summoning circle".
        if ( rank > 0.5 ) {
          float ang = atan( p.y, p.x ) + t * 0.55;
          float spokes = pow( abs( sin( ang * 3.0 ) ), 22.0 );
          float band = exp( -pow( ( r - 0.80 ) * 16.0, 2.0 ) );
          float glyphs = exp( -pow( ( r - 0.44 ) * 20.0, 2.0 ) )
                       * pow( abs( sin( ang * 6.0 + 0.6 ) ), 8.0 );
          a += band * ( 0.30 + spokes * 1.5 ) + glyphs * 1.1;
        }

        a *= gain * rise;
        gl_FragColor = vec4( vColB * a, 1.0 );
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  mat.name = 'mn.loot.glow';
  return mat;
}

/* ==========================================================================
 * geometry for the two instanced pools
 * ========================================================================== */

/** A tapered open cylinder, base at y = 0, height 1, radius 1 at the base. */
export function beamGeometry() {
  const g = new THREE.CylinderGeometry(0.52, 1.0, 1.0, 10, 1, true);
  g.translate(0, 0.5, 0);
  g.name = 'mn.loot.beam.geo';
  return g;
}

/** A unit disc lying in the XZ plane, facing +Y. */
export function glowGeometry() {
  const g = new THREE.CircleGeometry(1, 22);
  g.rotateX(-Math.PI * 0.5);
  g.name = 'mn.loot.glow.geo';
  return g;
}
