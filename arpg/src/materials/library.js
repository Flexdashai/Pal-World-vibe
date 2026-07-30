import * as THREE from 'three';
import { ENV, ELEMENTS } from '../core/palette.js';
import { SURFACE_BY_ID } from './surfaces.js';
import { buildMaterial, SharedMaterialUniforms } from './pbr.js';

/**
 * MONARCH — the shared material library.
 *
 * This is the public face of the subsystem. `world`, `ai`, `loot` and `fx` all
 * reach it through `ctx.get('materials').get(name, opts)`.
 *
 * ---------------------------------------------------------------------------
 * THE CACHE, AND WHY IT IS AGGRESSIVE
 *
 * Two levels:
 *
 *   TEXTURE SET   one bake per surface id, in `forge.js`. Baking the same
 *                 surface twice on a CPU rasteriser costs whole seconds.
 *   MATERIAL      one THREE.Material per (surface, quantised options) tuple.
 *
 * The second level is what makes the overlays free. `wet`, `moss`, `soot` and
 * the rest are UNIFORMS, not baked channels, so `flagstone` under six metres of
 * standing water and `flagstone` in a dry vestibule are the same three
 * megabytes of texture and two different 400-byte material objects. That is
 * what lets `world` vary a room's mood per room without a load screen, and it
 * is why the overlays are masked at shade time from the baked height/AO fields
 * rather than composited at bake time.
 *
 * Option values are quantised before they become part of the key, so
 * `{ wet: 0.601 }` and `{ wet: 0.604 }` share a material instead of quietly
 * doubling the program count.
 *
 * ---------------------------------------------------------------------------
 * UV CONVENTION — the one thing callers must know
 *
 * Textures are handed to three with `repeat` left at (1,1) and scaled inside the
 * shader instead, so many materials at many scales can share one baked texture
 * (a render-target texture cannot be cloned — the clone has no image data and
 * uploads black).
 *
 * `scale` is therefore TEXTURE REPEATS PER UV UNIT, and the whole system is
 * calibrated on the assumption that **geometry UVs are in metres**. Build a
 * 4 m x 3 m wall with uv spanning 0..4 by 0..3 and every surface lands at its
 * intended real-world texel density with no per-mesh tuning. Pass
 * `{ tile: metres }` to say it the other way round.
 *
 * For geometry with no usable UV layout — rotated rubble, organic props,
 * anything the generator scatters — pass `{ triplanar: true }` and the material
 * projects from world space instead. Triplanar is three fetches per map, so it
 * disables parallax.
 */

/**
 * Per-surface default dressing. Kept here rather than in `surfaces.js` because
 * it is art direction (how filthy is this room) rather than material physics
 * (what is this substance), and the two want to be edited at different times.
 */
const SURFACE_DEFAULTS = {
  flagstone: { grime: 0.45, moss: 0.10, wet: 0.18, dust: 0.06, varyUv: 0.0 },
  cobble: { grime: 0.50, moss: 0.20, wet: 0.35 },
  granite: { grime: 0.40, moss: 0.08, dust: 0.10, varyUv: 0.05 },
  marble: { grime: 0.22, dust: 0.10, wet: 0.05 },
  plaster: { grime: 0.45, moss: 0.10, soot: 0.10, dust: 0.10 },
  mortar: { grime: 0.55, moss: 0.12 },
  vault: { grime: 0.35, soot: 0.28, dust: 0.08, varyUv: 0.05 },
  dirt: { grime: 0.30, wet: 0.10, moss: 0.05 },
  gravel: { grime: 0.35, wet: 0.12 },
  ash: { grime: 0.10, soot: 0.35 },
  bonelitter: { grime: 0.35, dust: 0.12 },
  water: { wet: 1.0, grime: 0.0, overlay: true },
  iron: { grime: 0.35, soot: 0.20 },
  rustiron: { grime: 0.40, moss: 0.05 },
  bronze: { grime: 0.30, dust: 0.05 },
  steel: { grime: 0.10 },
  plank: { grime: 0.40, moss: 0.10, wet: 0.10 },
  beam: { grime: 0.35, moss: 0.08, soot: 0.12 },
  banner: { grime: 0.35, soot: 0.15, dust: 0.10 },
  leather: { grime: 0.30 },
  flesh: { wet: 0.25, blood: 0.25, bloodDry: 0.2 },
  chitin: { grime: 0.18, wet: 0.10 },
  bone: { grime: 0.35, dust: 0.10 },
  obsidian: { grime: 0.12, dust: 0.05 },
  crystal: { grime: 0.08 },
  runestone: { grime: 0.35, moss: 0.10, dust: 0.08 },
};

/**
 * Named recipes. A caller that wants "the floor of a flooded crypt" should not
 * have to know that means flagstone at wet 0.75 with the moss pushed into the
 * joints — that is a decision the material system owns, so every room in the
 * game that wants it gets the same one.
 */
export const PRESETS = {
  'floor.crypt': { surface: 'flagstone', wet: 0.22, moss: 0.10, grime: 0.5 },
  'floor.flooded': { surface: 'flagstone', wet: 0.85, moss: 0.28, grime: 0.55 },
  'floor.cathedral': { surface: 'marble', wet: 0.10, grime: 0.25, dust: 0.14 },
  'floor.street': { surface: 'cobble', wet: 0.55, moss: 0.22, grime: 0.55 },
  'floor.earth': { surface: 'dirt', wet: 0.10, grime: 0.3 },
  'floor.ossuary': { surface: 'bonelitter', grime: 0.4, dust: 0.15 },
  'floor.scree': { surface: 'gravel', grime: 0.4, wet: 0.15 },
  'floor.ash': { surface: 'ash', soot: 0.4 },
  'water.still': { surface: 'water', wet: 1.0 },

  'wall.block': { surface: 'granite', grime: 0.42, moss: 0.10, varyUv: 0.06 },
  'wall.blockWet': { surface: 'granite', grime: 0.5, moss: 0.35, wet: 0.45 },
  'wall.plaster': { surface: 'plaster', grime: 0.45, moss: 0.12 },
  'wall.marble': { surface: 'marble', grime: 0.2, dust: 0.12 },
  'wall.foundation': { surface: 'mortar', grime: 0.6, moss: 0.25, wet: 0.3 },
  'wall.rune': { surface: 'runestone', grime: 0.35, moss: 0.08, emissive: 6.0 },

  'ceil.vault': { surface: 'vault', grime: 0.3, soot: 0.45, dust: 0.05 },
  'ceil.vaultSooted': { surface: 'vault', grime: 0.3, soot: 0.85 },

  'metal.iron': { surface: 'iron', grime: 0.3, soot: 0.25 },
  'metal.brazier': { surface: 'iron', grime: 0.25, soot: 0.9 },
  'metal.rust': { surface: 'rustiron', grime: 0.4 },
  'metal.gold': { surface: 'bronze', grime: 0.25, dust: 0.06 },
  'metal.steel': { surface: 'steel', grime: 0.12 },

  'wood.plank': { surface: 'plank', grime: 0.4, moss: 0.1 },
  'wood.beam': { surface: 'beam', grime: 0.35, soot: 0.15 },
  'cloth.banner': { surface: 'banner', grime: 0.35, side: 'double' },
  'cloth.leather': { surface: 'leather', grime: 0.3 },

  'organic.flesh': { surface: 'flesh', wet: 0.3, blood: 0.35 },
  'organic.chitin': { surface: 'chitin', wet: 0.15 },
  'organic.bone': { surface: 'bone', grime: 0.35 },

  'arcane.obsidian': { surface: 'obsidian', grime: 0.1 },
  'arcane.crystal': { surface: 'crystal', emissive: 9.0 },
  'arcane.rune': { surface: 'runestone', emissive: 8.0, moss: 0.05 },

  // Rubble, boulders and anything the generator rotates: no usable UVs.
  'rubble.stone': { surface: 'gravel', triplanar: true, grime: 0.45, moss: 0.15 },
  'rubble.granite': { surface: 'granite', triplanar: true, grime: 0.45, moss: 0.12 },
};

const SIDES = { front: THREE.FrontSide, back: THREE.BackSide, double: THREE.DoubleSide };

/** Quantise so near-identical requests share a material. `step` is chosen per
 *  field: overlay amounts are perceptually coarse, scale is not. */
const q = (v, step) => Math.round(v / step) * step;

export class MaterialLibrary {
  /**
   * @param {object} ctx
   * @param {import('./forge.js').TextureForge} forge
   * @param {object} render  the render subsystem (for registerMaterial), may be null
   */
  constructor(ctx, forge, render) {
    this.ctx = ctx;
    this.forge = forge;
    this.render = render;
    this.q = ctx.config.q;

    this.shared = new SharedMaterialUniforms({
      moss: ENV.moss,
      blood: ELEMENTS.blood.core,
      dust: ENV.ash,
      grime: ENV.dirt,
    });

    /** cache key -> material */
    this.materials = new Map();
    this.counters = { requests: 0, hits: 0, misses: 0, built: 0 };

    // Parallax step counts scale with the preset. The container has no GPU and
    // the floor covers most of the frame, so this is the single most effective
    // quality dial in the subsystem.
    const ts = this.q.textureSize || 512;
    this.pomSteps = ts >= 1024 ? [6, 14] : ts >= 512 ? [5, 10] : [3, 6];
  }

  // -------------------------------------------------------------------------
  // option resolution
  // -------------------------------------------------------------------------

  /** Resolve a name (surface id or preset) plus options into a full spec. */
  resolve(name, opts = {}) {
    const preset = PRESETS[name];
    const id = preset ? preset.surface : name;
    const surface = SURFACE_BY_ID.get(id);
    if (!surface) throw new Error(`[materials] unknown surface or preset "${name}"`);

    const o = { ...SURFACE_DEFAULTS[id], ...preset, ...opts };

    // --- scale ------------------------------------------------------------
    // `tile` (metres per repeat) and `scale` (repeats per uv unit) are two ways
    // to say the same thing; `tile` is the one that reads naturally at a call
    // site placing a 4-metre wall.
    const naturalTile = surface.tile;
    const tile = o.tile ?? (o.scale ? 1 / o.scale : naturalTile);
    const uvScale = 1 / tile;

    const triplanar = !!o.triplanar;
    // Parallax is worth its cost on anything with real relief, and is pointless
    // on a surface that is essentially flat (marble, steel, water). It is also
    // mutually exclusive with triplanar, which already costs three fetches.
    const pom = o.pom ?? (!triplanar && surface.heightScale >= 0.018);

    const overlay = o.overlay ?? true;

    const emissive = o.emissive ?? (surface.emissive ? 4.0 : 0);
    const emissiveColorName = o.emissiveElement ?? surface.emissive ?? 'shadow';
    const emissiveColor = ELEMENTS[emissiveColorName]?.core ?? ELEMENTS.shadow.core;

    const spec = {
      id,
      tile,
      uvScale,
      triplanar,
      pom,
      overlay,
      pomMin: this.pomSteps[0],
      pomMax: this.pomSteps[1],

      // Relief in UV units: metres of relief times repeats per metre.
      pomRelief: surface.heightScale * uvScale * (o.reliefGain ?? 1.0),
      pomNear: o.pomNear ?? 10.0,
      pomFar: o.pomFar ?? 22.0,

      // Normal strength compensation. The map was baked assuming one repeat
      // spans `surface.tile` metres; stretching it over more world shallows the
      // real slope by the same factor.
      normalScale: (o.normalScale ?? 1.0) * Math.min(2.5, naturalTile / tile),

      detailScale: o.detailScale ?? 3.0,
      detailNormal: (o.detail ?? 1.0) * (o.detailNormal ?? 0.45),
      detailAlbedo: (o.detail ?? 1.0) * (o.detailAlbedo ?? 0.34),
      detailRough: (o.detail ?? 1.0) * (o.detailRough ?? 0.22),
      detailFadeNear: o.detailFadeNear ?? 14.0,
      detailFadeFar: o.detailFadeFar ?? 70.0,

      // ~7 m period: long enough that it is never mistaken for the texture's own
      // structure, short enough that a single room contains several cycles.
      macroScale: o.macroScale ?? 0.145,
      macroValue: o.macroValue ?? 0.44,
      macroRough: o.macroRough ?? 0.18,
      macroHue: o.macroHue ?? 0.40,

      varyValue: o.varyValue ?? 0.24,
      varyHue: o.varyHue ?? 0.32,
      varyRough: o.varyRough ?? 0.16,
      varyUv: o.varyUv ?? 0.0,

      moss: o.moss ?? 0,
      grime: o.grime ?? 0,
      soot: o.soot ?? 0,
      wet: o.wet ?? 0,
      blood: o.blood ?? 0,
      bloodDry: o.bloodDry ?? 0.55,
      dust: o.dust ?? 0,
      wax: o.wax ?? 0,

      cavity: o.cavity ?? 0.60,
      aoIntensity: o.aoIntensity ?? 1.0,
      envMapIntensity: o.envMapIntensity ?? 1.0,
      // Multipliers on the baked ORM map.
      roughness: o.roughness ?? 1.0,
      metalness: o.metalness ?? 1.0,
      // Hints written into `material.roughness` / `material.metalness` for
      // render's prepass, which cannot evaluate the map. The metal hint in
      // particular is load-bearing: SSR reads it out of the G-buffer to pick
      // F0, and a stone floor claiming metal=1 becomes a mirror.
      roughHint: o.roughHint ?? surface.roughHint ?? (surface.tag === 'metal' ? 0.42 : 0.8),
      metalHint: (o.metalHint ?? surface.metalHint ?? (surface.tag === 'metal' ? 1.0 : 0.0)) * (o.metalness ?? 1.0),
      tint: o.tint ?? [1, 1, 1],
      side: SIDES[o.side] ?? THREE.FrontSide,

      emissive,
      emissiveColor,
      emissiveGain: o.emissiveGain ?? 1.0,
      // Runes glow in the carved channels, crystal on the facet crowns; both are
      // the same ramp with the edges swapped.
      emissiveLo: o.emissiveLo ?? 0.25,
      emissiveHi: o.emissiveHi ?? 0.85,
      suffix: '',
    };

    return spec;
  }

  /** Cache key. Everything that changes a uniform or a define must appear. */
  key(spec) {
    return [
      spec.id,
      q(spec.tile, 0.05).toFixed(2),
      spec.triplanar ? 't' : '', spec.pom ? 'p' : '', spec.overlay ? 'o' : '',
      q(spec.moss, 0.05), q(spec.grime, 0.05), q(spec.soot, 0.05), q(spec.wet, 0.05),
      q(spec.blood, 0.05), q(spec.bloodDry, 0.1), q(spec.dust, 0.05), q(spec.wax, 0.05),
      q(spec.emissive, 0.5), q(spec.emissiveLo, 0.05), q(spec.emissiveHi, 0.05),
      q(spec.roughness, 0.05), q(spec.metalness, 0.05), q(spec.cavity, 0.05),
      q(spec.detailNormal, 0.05), q(spec.macroValue, 0.05), q(spec.varyValue, 0.05), q(spec.varyUv, 0.02),
      q(spec.normalScale, 0.05), q(spec.envMapIntensity, 0.1), q(spec.aoIntensity, 0.1),
      spec.side,
      spec.tint.map((c) => q(c, 0.05).toFixed(2)).join(':'),
    ].join('|');
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  /**
   * Get a cached, disposal-tracked material.
   *
   *   const m = ctx.get('materials');
   *   const floor = m.get('flagstone', { wet: 0.6, moss: 0.2, tile: 2.0 });
   *   const wall  = m.get('wall.block');
   *
   * The returned material is shared. Never mutate it — call `get()` again with
   * different options, or use `setOverlay()` if the change must apply to every
   * mesh already using it.
   */
  get(name, opts) {
    this.counters.requests++;
    const spec = this.resolve(name, opts);
    const key = this.key(spec);

    const hit = this.materials.get(key);
    if (hit) { this.counters.hits++; return hit; }
    this.counters.misses++;

    const set = this.forge.bake(spec.id);
    // Deterministic, readable material names: they show up in three's program
    // cache and in the renderer's info, which is how a stray permutation gets
    // found later.
    spec.suffix = `[${spec.tile.toFixed(2)}m${spec.pom ? '+pom' : ''}${spec.triplanar ? '+tri' : ''}]`;

    const mat = buildMaterial(set, spec, this.shared);
    mat.userData.mnKey = key;

    // Patch into render's pipeline BEFORE the material is ever compiled. Doing
    // it later means one compile for the unpatched variant and a second for the
    // patched one, which is exactly the stall pre-warm exists to prevent.
    this.render?.registerMaterial?.(mat);

    this.materials.set(key, mat);
    this.counters.built++;
    return mat;
  }

  /** True if this exact request is already cached (no bake, no build). */
  has(name, opts) {
    try { return this.materials.has(this.key(this.resolve(name, opts))); }
    catch { return false; }
  }

  /**
   * Retune a LIVE material's overlays. Every mesh sharing it updates on the next
   * frame with no rebuild and no recompile — this is how a room floods, a
   * brazier starts smoking, or an arena floor accumulates blood over a fight.
   *
   * @param {THREE.Material} mat  a material returned by `get()`
   * @param {{moss,grime,soot,wet,blood,bloodDry,dust,wax}} amounts
   */
  setOverlay(mat, amounts = {}) {
    const u = mat?.userData?.mnUniforms;
    if (!u) return mat;
    const a = u.mnOvA.value, b = u.mnOvB.value;
    if (amounts.moss !== undefined) a.x = amounts.moss;
    if (amounts.grime !== undefined) a.y = amounts.grime;
    if (amounts.soot !== undefined) a.z = amounts.soot;
    if (amounts.wet !== undefined) a.w = amounts.wet;
    if (amounts.blood !== undefined) b.x = amounts.blood;
    if (amounts.bloodDry !== undefined) b.y = amounts.bloodDry;
    if (amounts.dust !== undefined) b.z = amounts.dust;
    if (amounts.wax !== undefined) b.w = amounts.wax;
    return mat;
  }

  /** The physics/audio/fx surface tag for a surface or preset name. One of the
   *  ARCHITECTURE.md vocabulary: stone, flagstone, dirt, wood, metal, bone,
   *  flesh, cloth, water, crystal, ash, blood. */
  surfaceTag(name) {
    const id = PRESETS[name]?.surface ?? name;
    return SURFACE_BY_ID.get(id)?.tag ?? 'stone';
  }

  /** Metres covered by one texture repeat at this surface's natural density. */
  naturalTile(name) {
    const id = PRESETS[name]?.surface ?? name;
    return SURFACE_BY_ID.get(id)?.tile ?? 1.0;
  }

  list() {
    return { surfaces: [...SURFACE_BY_ID.keys()], presets: Object.keys(PRESETS) };
  }

  hitRate() {
    const r = this.counters.requests;
    return r ? +(this.counters.hits / r).toFixed(3) : 0;
  }

  dispose() {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
  }
}
