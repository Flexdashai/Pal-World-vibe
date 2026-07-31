import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';

/**
 * MONARCH — the hero's material set.
 *
 * Seven materials, one per visual substance, because the brief is explicit that
 * metal, leather and cloth must separate. On this camera the separation cannot
 * come from texture detail (the hero is 89 px tall in the wide shot) — it has to
 * come from **roughness and specular behaviour**, which survive at any size:
 *
 *   plate   metal = 1, roughness 0.30-0.42  → a hard, moving highlight
 *   trim    metal = 1, near-black, violet emissive → the only saturated thing
 *   leather roughness 0.62, metal 0         → a broad, soft sheen
 *   coat    roughness 0.86, metal 0         → almost none; reads as a void
 *   lining  roughness 0.70 + violet tint    → the flash when the coat opens
 *   skin    roughness 0.55, subsurface-ish pale tint
 *   hair    roughness 0.44 anisotropic-ish, near black
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS THE LIBRARY DOES THAT A CHARACTER MUST TURN OFF
 *
 * `materials` is built for architecture, and three of its features are
 * world-space. On a moving character they are bugs, and each one was found by
 * capturing and then walking:
 *
 *  1. `macro*` projects the detail texture from `vMnWorldPos.xz`, so the hero's
 *     value variation SLIDES ACROSS HIM as he walks. All macro amounts are 0.
 *  2. `vary*` is seeded from `modelMatrix[3]` — the object's world origin —
 *     which for the player changes every frame, so his albedo hue would shimmer
 *     as he moves. All vary amounts are 0.
 *  3. `pom` needs a stable tangent frame and a large, continuous UV chart.
 *     Character charts are small and curved; parallax at those scales produces
 *     smeared silhouettes at every seam. Off everywhere.
 *  4. `triplanar` is world-space by definition and would swim under animation.
 *     Never used here; every generator writes real UVs in metres instead.
 *
 * ---------------------------------------------------------------------------
 * COLOUR
 *
 * The world's luminance-weighted saturation is already slightly over target, so
 * the hero is built almost entirely out of near-neutral blacks (albedo 0.02-0.06,
 * which is real-world charcoal/black-dyed-leather territory and inside the
 * 0.02-0.9 physical range). The ONLY saturated colour on him is the shadow
 * violet, and it appears as emissive rather than albedo so it survives the fact
 * that he stands in the dark most of the time.
 */

const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

/** Shared knobs for every library material the hero uses. See the docblock. */
const CHAR_BASE = {
  pom: false,
  triplanar: false,
  macroValue: 0, macroRough: 0, macroHue: 0,
  varyValue: 0, varyHue: 0, varyRough: 0, varyUv: 0,
  // The hero is lit by braziers 4-10 m away and by his own rim light; the env
  // contribution is what keeps him from going to pure black in between.
  //
  // 1.9, not 1.0. The measured build crushes 44.8% of the frame to
  // information-free black and the hero spends most of a run in that part of
  // it. Raising EXPOSURE to fix that would lift the whole image and destroy the
  // crypt; raising the SUBJECT's indirect response lifts only the subject. It is
  // also defensible physically: black plate has a strong Fresnel response and
  // a real one in a dark room is visible almost entirely through what it
  // reflects, which is exactly the env term.
  envMapIntensity: 1.9,
  dust: 0.0,
};

/**
 * Build the hero's materials.
 *
 * @param {object} ctx    engine context
 * @returns {{ byKey: Record<string, THREE.Material>, own: THREE.Material[] }}
 *   `own` is only the materials this module CREATED (and must dispose).
 *   Library materials are owned and disposed by `materials`.
 */
export function buildAppearance(ctx) {
  const m = ctx.get('materials');
  const render = ctx.get('render');
  const own = [];
  const byKey = {};

  const shadowCore = ELEMENTS.shadow.core;
  const shadowGlow = ELEMENTS.shadow.glow;

  // ---- plate ---------------------------------------------------------------
  // `steel` baked at a 0.34 m tile: the forge's steel recipe has ~4 cm features,
  // so at this tile they land at ~9 mm on the armour — hammer planishing scale,
  // which is right for a cuirass and reads as texture rather than as noise.
  // Tint is a cold near-black; real blackened plate is about 4% reflectance.
  byKey.plate = m.get('steel', {
    ...CHAR_BASE,
    tile: 0.34,
    // 0.075 rather than the 0.052 of the first pass. Blackened steel is around
    // 6-8% reflectance in reality; the darker value was inside the physical
    // range but put the whole figure below the point where the tone curve has
    // any gradient left, and the character rendered as a hole.
    tint: [0.075, 0.080, 0.100],
    // 0.46 multiplier on the baked ORM. Polished plate is the only thing on the
    // hero that produces a hard specular, and that highlight is what draws the
    // armour's shape in a dark room — but at 0.36 the lobe was tight enough
    // that the rim light produced a single blown disc on the pauldron instead
    // of a moving edge highlight. 0.46 spreads it over the whole lame.
    roughness: 0.46,
    metalness: 1.0,
    roughHint: 0.34,
    metalHint: 1.0,
    grime: 0.26,
    soot: 0.28,
    detailScale: 4.2,
    detailNormal: 0.62,
    detailRough: 0.30,
    aoIntensity: 1.05,
  });

  // A second, darker and rougher plate for the underlayers (lames, greaves) so
  // the armour has depth instead of reading as one continuous shell.
  byKey.plateDark = m.get('iron', {
    ...CHAR_BASE,
    tile: 0.28,
    tint: [0.048, 0.050, 0.062],
    roughness: 0.62,
    metalness: 1.0,
    roughHint: 0.44,
    metalHint: 1.0,
    grime: 0.40,
    soot: 0.48,
    detailScale: 5.0,
    detailNormal: 0.70,
  });

  // ---- leather -------------------------------------------------------------
  byKey.leather = m.get('leather', {
    ...CHAR_BASE,
    tile: 0.30,
    tint: [0.058, 0.048, 0.048],
    roughness: 0.92,
    metalness: 0,
    roughHint: 0.62,
    metalHint: 0,
    grime: 0.35,
    detailScale: 5.5,
    detailNormal: 0.55,
  });

  // ---- coat ----------------------------------------------------------------
  // `banner` is the library's woven-cloth recipe. Double-sided is deliberate:
  // the coat is a surface, and during a dash the camera sees the underside of
  // the hem before the lining shell has any thickness to hide behind.
  byKey.coat = m.get('banner', {
    ...CHAR_BASE,
    tile: 0.26,
    // Black wool is ~4.5% reflectance. Below about 0.04 the coat and the
    // unlit floor become the same pixel value and the hero's whole lower half
    // stops existing between braziers.
    tint: [0.046, 0.044, 0.058],
    roughness: 0.92,
    metalness: 0,
    roughHint: 0.82,
    metalHint: 0,
    grime: 0.28,
    soot: 0.20,
    detailScale: 6.0,
    detailNormal: 0.85,
    detailRough: 0.30,
    side: 'double',
  });

  // The inside of the coat. Violet, but as ALBEDO not emissive — it must go
  // dark when it is in shadow, or the coat looks like it is lined with neon.
  byKey.lining = m.get('banner', {
    ...CHAR_BASE,
    tile: 0.22,
    tint: [0.085, 0.045, 0.30],
    roughness: 0.86,
    metalness: 0,
    roughHint: 0.74,
    metalHint: 0,
    grime: 0.18,
    detailScale: 6.5,
    detailNormal: 0.7,
    side: 'double',
  });

  // ---- skin ----------------------------------------------------------------
  // Not the `flesh` surface: that recipe is wet and bloody, built for gore. A
  // face wants a dry, slightly translucent read, so it is `plaster` retinted —
  // the same fine pore-scale noise, none of the viscera.
  byKey.skin = m.get('plaster', {
    ...CHAR_BASE,
    tile: 0.20,
    // Deliberately under real skin (~0.35 for a pale complexion). At 0.30 the
    // face was six times the albedo of everything around it and became the only
    // bright shape on the model — a floating mask. Pulling it to 0.20 keeps the
    // eyes as the focal point, which is where they belong.
    tint: [0.205, 0.150, 0.124],
    roughness: 0.62,
    metalness: 0,
    roughHint: 0.52,
    metalHint: 0,
    grime: 0.12,
    moss: 0,
    detailScale: 8.0,
    detailNormal: 0.30,
    detailAlbedo: 0.15,
    aoIntensity: 1.3,
  });

  // ---- hair ----------------------------------------------------------------
  // Rough but not matte: hair's specular is a broad band, which at 89 px is the
  // only thing that stops the head reading as a black blob against a black wall.
  byKey.hair = m.get('banner', {
    ...CHAR_BASE,
    tile: 0.10,
    tint: [0.020, 0.019, 0.026],
    roughness: 0.58,
    metalness: 0,
    roughHint: 0.44,
    metalHint: 0,
    grime: 0.0,
    soot: 0.0,
    detailScale: 14.0,
    detailNormal: 1.1,
    detailRough: 0.35,
  });

  // ---- emissive trim -------------------------------------------------------
  // Hand-built rather than taken from the library: this is a 6 mm strip and it
  // needs full control of emissive intensity with no baked mask fighting it.
  // Registered with `render` so it still gets the screen-space AO patch and,
  // more importantly, the `mnGlow` uniform that drives the bloom pyramid.
  const trim = new THREE.MeshStandardMaterial({
    name: 'mn.player.trim',
    color: lin(0.012, 0.011, 0.020),
    roughness: 0.30,
    metalness: 1.0,
    emissive: lin(shadowCore[0], shadowCore[1], shadowCore[2]),
    // 2.6 nits-ish against a scene whose brazier key is ~26 cd. High enough to
    // survive bloom thresholding, low enough that it does not blow to white and
    // lose its hue — the failure mode the braziers currently have.
    emissiveIntensity: 2.6,
    toneMapped: true,
  });
  byKey.trim = trim;
  own.push(trim);

  // ---- eyes ----------------------------------------------------------------
  // The single most important 40 px² in the game. Pure hot violet, unlit
  // (MeshBasicMaterial would skip the AO/glow patch, so it is a Standard with a
  // black albedo and a large emissive — same result, still patched).
  const eyes = new THREE.MeshStandardMaterial({
    name: 'mn.player.eyes',
    color: lin(0, 0, 0),
    roughness: 1.0,
    metalness: 0,
    emissive: lin(shadowGlow[0], shadowGlow[1], shadowGlow[2]),
    emissiveIntensity: 9.0,
    toneMapped: true,
  });
  byKey.eyes = eyes;
  own.push(eyes);

  for (const key of Object.keys(byKey)) render.registerMaterial(byKey[key]);

  return { byKey, own };
}

/**
 * Additive material for the aura, the dash trail and the ARISE glyphs.
 *
 * Additive rather than normal-blended because these are light, not surfaces:
 * a violet ribbon over a black floor must ADD violet, and a normal blend over
 * black would make the trail darker than the floor wherever its alpha ramps.
 *
 * `depthWrite:false` keeps it out of render's prepass automatically (see
 * `_collect`'s eligibility test), which is what we want — a trail must not
 * write depth, occlude with AO, or appear in SSR.
 */
export function makeAdditiveMaterial(name, colorLinear, opacity = 1.0) {
  const mat = new THREE.MeshBasicMaterial({
    name: `mn.player.${name}`,
    color: new THREE.Color().setRGB(colorLinear[0], colorLinear[1], colorLinear[2],
      THREE.LinearSRGBColorSpace),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: true,
    fog: false,
  });
  mat.userData.mnNoPrepass = true;
  return mat;
}
