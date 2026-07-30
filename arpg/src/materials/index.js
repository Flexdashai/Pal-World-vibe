import * as THREE from 'three';
import { TextureForge, FORGE_VERSION } from './forge.js';
import { MaterialLibrary, PRESETS } from './library.js';
import { SURFACES, SURFACE_BY_ID, CORE_SURFACES } from './surfaces.js';
import { MaterialProbeScene } from './probe.js';

/**
 * MONARCH — procedural material subsystem.
 *
 *   id    'materials'
 *   deps  ['render']   (needs the WebGLRenderer to bake into render targets,
 *                       and `registerMaterial` to patch what it builds)
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS OWNS
 *
 *   forge.js      the GPU texture forge: two shader passes per surface into an
 *                 MRT, producing albedo / normal+height / ORM+cavity
 *   noise.glsl.js periodic noise. Everything tiles seamlessly, by construction
 *   patterns.*    masonry, slabs, planks, weave, facets, runes
 *   surfaces.js   25 surface recipes, each a fragment-shader body
 *   pbr.js        the shading layer: POM, triplanar, detail, macro variation,
 *                 per-instance variation, and the overlay set
 *   library.js    option resolution, the two-level cache, the named presets
 *   probe.js      an opt-in showcase scene (`?matdebug=1`) for reviewing the
 *                 whole catalogue in one frame
 *
 * ---------------------------------------------------------------------------
 * WHAT OTHER SUBSYSTEMS SHOULD CALL
 *
 *   const m = ctx.get('materials');
 *
 *   m.get('flagstone', { wet: 0.6, moss: 0.2, tile: 2.0 })  -> THREE.Material
 *   m.get('wall.block')                                     -> a named preset
 *   m.get('gravel', { triplanar: true })                    -> no UVs needed
 *   m.setOverlay(mat, { wet: 0.9 })                         -> retune in place
 *   m.surfaceTag('wall.block')                              -> 'stone'
 *   m.naturalTile('flagstone')                              -> 1.75 (metres)
 *   m.textures('flagstone')                                 -> the raw maps
 *   m.list()                                                -> what exists
 *   m.prefetch([...])                                       -> bake ahead of use
 *
 * Materials are SHARED and cached. Never mutate one you did not build; ask for
 * another with different options instead — that is what the cache is for.
 *
 * THE ONE CONVENTION THAT MATTERS: build geometry with **UVs in metres**. Then
 * every surface lands at its intended texel density with no per-mesh tuning,
 * `tile` means what it says, and parallax depth is physically correct. Meshes
 * that cannot do that should pass `{ triplanar: true }`.
 */
export class MaterialSystem {
  static id = 'materials';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.q = ctx.config.q;

    const render = ctx.get('render');
    this.render = render;
    this.renderer = render.renderer;

    this.forge = new TextureForge(this.renderer, this.q);
    this.library = new MaterialLibrary(ctx, this.forge, render);

    // The shared detail/variation texture is a hard dependency of every
    // material's fragment shader, so it is the one thing baked eagerly. It is
    // 256px and costs a few milliseconds.
    this.library.shared.detailTex.value = this.forge.bakeDetail();

    // Preallocated scratch for prewarm. Nothing in this subsystem runs per
    // frame, but the rule is the rule and a stray allocation in prewarm shows
    // up as a GC pause on the first captured frame.
    this._warmGroup = new THREE.Group();
    this._warmGroup.name = 'mn.materials.prewarm';
    this._warmGeo = null;
    this._warmRT = null;

    this._t0 = performance.now();
    this._initMs = 0;

    // Opt-in showcase. Never constructed unless the URL asks for it, so it can
    // never affect another agent's capture.
    this.probe = null;
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    if (params?.get('matdebug') === '1' || params?.get('matdebug') === 'grid') {
      this.probe = new MaterialProbeScene(ctx, this, params.get('matdebug') === 'grid');
    }
    // `?matbake=all` forces the whole catalogue to bake up front. Useful when
    // reviewing the library; too slow on a CPU rasteriser to be the default.
    if (params?.get('matbake') === 'all') this.prefetch(SURFACES.map((s) => s.id));

    this._initMs = performance.now() - this._t0;
    console.info(
      `[materials] forge v${FORGE_VERSION} | ${SURFACES.length} surfaces, ${Object.keys(PRESETS).length} presets | ` +
      `tiers ${this.forge.sizeFor('hero')}/${this.forge.sizeFor('main')}/${this.forge.sizeFor('minor')} ` +
      `aniso ${this.q.anisotropy} | pom ${this.library.pomSteps.join('-')} steps | init ${this._initMs.toFixed(0)}ms`
    );
  }

  // =========================================================================
  // public API — see the class docblock
  // =========================================================================

  get(name, opts) { return this.library.get(name, opts); }
  has(name, opts) { return this.library.has(name, opts); }
  setOverlay(mat, amounts) { return this.library.setOverlay(mat, amounts); }
  surfaceTag(name) { return this.library.surfaceTag(name); }
  naturalTile(name) { return this.library.naturalTile(name); }
  list() { return this.library.list(); }

  /** The raw baked maps for a surface, for a subsystem that wants to build its
   *  own material (fx decals reading the same normal map, for instance). */
  textures(name) {
    const id = PRESETS[name]?.surface ?? name;
    const set = this.forge.bake(id);
    return { albedo: set.albedo, normal: set.normal, orm: set.orm, size: set.size };
  }

  /** The shared 256px detail/variation texture. rg = micro normal, b = value,
   *  a = a blobby uncorrelated mask field. */
  get detailTexture() { return this.forge.detail; }

  /**
   * Bake a list of surfaces without building materials for them. Call this from
   * a loading screen for anything a later room will need, so the bake does not
   * land in the middle of a fight.
   */
  prefetch(names) {
    let n = 0;
    for (const raw of names) {
      const id = PRESETS[raw]?.surface ?? raw;
      if (!SURFACE_BY_ID.has(id) || this.forge.has(id)) continue;
      this.forge.bake(id);
      n++;
    }
    return n;
  }

  // =========================================================================
  // pre-warm
  // =========================================================================

  /**
   * Contract: build and compile every material this subsystem can produce,
   * without spawning gameplay objects or touching the clock or the RNG.
   *
   * Two deliberate departures, both forced by the software rasteriser:
   *
   *  1. Only `CORE_SURFACES` are BAKED here. Baking all 25 recipes at their
   *     assigned tiers is several seconds of pure fragment work that most levels
   *     never need; the rest bake on first `get()`, which for anything `world`
   *     places still happens before the first frame because `world.init()` runs
   *     before any `prewarmMaterials`. `prefetch()` exists for the case where it
   *     does not.
   *
   *  2. Compilation covers every DEFINE PERMUTATION rather than every material.
   *     Two materials that differ only in a uniform share a program, and the
   *     program is the expensive thing — so one representative per
   *     (pom, triplanar, overlay, emissive, alpha-cutout) tuple compiles the
   *     whole space at a twentieth of the cost.
   *
   * `renderer.compile(scene, camera, targetScene)` is used with the prewarm
   * group as `scene` and `ctx.scene` as `targetScene`, so the light count baked
   * into the program cache key is the REAL one. Compiling against an empty
   * scene warms a zero-light variant that is thrown away on the first frame.
   */
  async prewarmMaterials(ctx) {
    const t0 = performance.now();
    const baked = this.prefetch(CORE_SURFACES);

    // One representative material per define permutation. Emissive and cutout
    // are properties of the surface, so those two axes are covered by choosing
    // surfaces that have them.
    const variants = [
      ['flagstone', { pom: true, overlay: true, wet: 0.4, moss: 0.2 }],
      ['flagstone', { pom: false, overlay: true }],
      ['granite', { pom: true, overlay: true, varyUv: 0.06 }],
      ['gravel', { triplanar: true, overlay: true }],
      ['gravel', { triplanar: true, overlay: false }],
      ['marble', { pom: false, overlay: false }],
      ['runestone', { pom: true, overlay: true, emissive: 8.0, wax: 0.3 }],
      ['crystal', { pom: true, overlay: true, emissive: 9.0 }],
      ['banner', { pom: false, overlay: true, side: 'double' }],
      ['iron', { pom: true, overlay: true, soot: 0.5 }],
    ];

    if (!this._warmGeo) this._warmGeo = new THREE.PlaneGeometry(0.02, 0.02, 1, 1);

    for (const [name, opts] of variants) {
      const mat = this.library.get(name, opts);
      const mesh = new THREE.Mesh(this._warmGeo, mat);
      // Parked far below the level so that, in the vanishingly unlikely case a
      // frame is drawn while the group is attached, it cannot be seen.
      mesh.position.set(0, -4000, 0);
      mesh.frustumCulled = false;
      mesh.userData.mnNoShadow = true;
      this._warmGroup.add(mesh);
    }

    ctx.scene.add(this._warmGroup);
    this._warmGroup.updateMatrixWorld(true);

    // A render target must be bound while compiling: `outputColorSpace` is read
    // off the CURRENTLY BOUND target and is part of the program cache key, so a
    // compile against the canvas warms a variant that is never used.
    if (!this._warmRT) {
      this._warmRT = new THREE.WebGLRenderTarget(4, 4, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false,
      });
      this._warmRT.texture.colorSpace = THREE.NoColorSpace;
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._warmRT);
    this.renderer.compile(this._warmGroup, ctx.camera, ctx.scene);
    this.renderer.setRenderTarget(prev);

    ctx.scene.remove(this._warmGroup);
    for (const m of this._warmGroup.children) m.material = null;
    this._warmGroup.clear();

    console.info('[materials] prewarm', {
      baked,
      surfaces: this.forge.stats.surfaces,
      textures: this.forge.stats.textures,
      materials: this.library.materials.size,
      vramMB: this.forge.vramMB(),
      bakeMs: +this.forge.stats.bakeMs.toFixed(0),
      ms: +(performance.now() - t0).toFixed(0),
    });
  }

  update(dt, ctx) {
    this.probe?.update(dt, ctx);
  }

  // =========================================================================
  // introspection
  // =========================================================================

  /**
   * Textures generated, VRAM, cache hit rate — plus the two numbers that
   * actually explain a slow boot: total bake milliseconds and which tier each
   * surface landed in.
   */
  stats() {
    const f = this.forge.stats;
    const c = this.library.counters;
    return {
      forgeVersion: FORGE_VERSION,
      catalogue: { surfaces: SURFACES.length, presets: Object.keys(PRESETS).length },
      generated: { surfaces: f.surfaces, textures: f.textures, megatexels: +(f.pixels / 1e6).toFixed(2) },
      vramMB: this.forge.vramMB(),
      bake: { totalMs: +f.bakeMs.toFixed(1), lastMs: +f.lastBakeMs.toFixed(1) },
      tiers: { hero: this.forge.sizeFor('hero'), main: this.forge.sizeFor('main'), minor: this.forge.sizeFor('minor') },
      materials: this.library.materials.size,
      cache: {
        requests: c.requests, hits: c.hits, misses: c.misses,
        hitRate: this.library.hitRate(),
      },
      pomSteps: this.library.pomSteps,
      anisotropy: this.q.anisotropy,
      baked: [...this.forge.sets.keys()],
      initMs: +this._initMs.toFixed(1),
      probe: this.probe ? this.probe.stats() : null,
    };
  }

  dispose() {
    this.probe?.dispose();
    this.library.dispose();
    this.forge.dispose();
    this._warmGeo?.dispose();
    this._warmRT?.dispose();
    this._warmGroup.clear();
    this._warmGeo = null;
    this._warmRT = null;
  }
}
