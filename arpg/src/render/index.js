import * as THREE from 'three';
import { CAMERA } from '../core/config.js';
import { ENV, LIGHTS } from '../core/palette.js';

import { TUNE } from './tuning.js';
import { ScreenQuad, SharedUniform } from './quad.js';
import { prepassTarget, hdrTarget, disposeTarget } from './targets.js';
import { installShadowChunk, ShadowFitter } from './shadows.js';
import { MaterialPatcher } from './patch.js';
import { Prepass, PREPASS_LAYER } from './prepass.js';
import { AoPass } from './ao.js';
import { SsrPass } from './ssr.js';
import { BloomPass } from './bloom.js';
import { ExposurePass } from './exposure.js';
import { TaaPass } from './taa.js';
import { DofPass } from './dof.js';
import { CompositePass } from './composite.js';
import { LightBudget } from './lights.js';
import { RenderProbeScene } from './probe.js';

/**
 * MONARCH — the HDR render pipeline.
 *
 * Frame graph, in order. Every step's placement is forced by a dependency, not
 * by preference:
 *
 *   1  collect        walk the scene once: honour the userData opt-outs, patch
 *                     new materials, tag prepass eligibility, discover lights
 *   2  camera         cache the unjittered matrices, then apply the TAA jitter
 *   3  shadow fit     refit + texel-snap the one tight shadow map
 *   4  light budget   fix the visible light count so nothing recompiles
 *   5  PREPASS        depth + view normal/roughness + motion/metalness (MRT)
 *   6  GTAO           half res, from the prepass. MUST be before the lit pass,
 *                     because AO has to multiply the indirect terms INSIDE the
 *                     material, not the final colour afterwards
 *   7  LIT PASS       three renders the shadow map then the scene into HDR
 *   8  uiScene        depth cleared, into the same HDR buffer so world-space
 *                     overlays are graded and bloomed with everything else
 *   9  SSR            half res, needs the lit colour; resolved additively
 *  10  TAA            resolve into the history buffer
 *  11  exposure       measure the resolved frame, adapt
 *  12  bloom          pyramid off the resolved frame
 *  13  DOF            half-res gather off the resolved frame
 *  14  composite      CA, DOF blend, bloom, vignette, exposure, AgX, sRGB,
 *                     grade LUT, grain -> canvas
 *
 * Everything from step 5 to step 13 is float; steps 6, 9, 12 and 13 run at half
 * or quarter resolution, because this container has no GPU and full-resolution
 * float passes are the single most expensive thing available.
 */
export class RenderSystem {
  static id = 'render';
  static deps = [];

  async init(ctx) {
    this.ctx = ctx;
    const q = ctx.config.q;
    this.q = q;

    // ---- shadow filter override, BEFORE anything compiles --------------------
    // The registry guarantees `render` initialises first (deps: []), so this is
    // the only place in the codebase where a global ShaderChunk edit is safe.
    this.shadowChunkOk = installShadowChunk();

    // ---- renderer -----------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      canvas: ctx.canvas,
      antialias: false,          // TAA does the anti-aliasing; MSAA cannot help a float chain
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(1);
    // The canvas is the only sRGB surface in the pipeline. Everything upstream is
    // linear working space; the composite applies the transfer function by hand
    // so it lands exactly once, in a known place.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // No tone mapping in materials: the composite owns the film response, and
    // toneMapping is part of the program cache key, so leaving it set would make
    // the pre-warmed variants differ from the drawn ones.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;

    const gl = this.renderer.getContext();
    this.caps = {
      renderer: gl.getParameter(gl.RENDERER),
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS ?? 0x8824) || 1,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      float: !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float'),
    };

    // ---- shared uniform holders --------------------------------------------
    // These objects are attached BY REFERENCE into every patched material and
    // every post pass, so one assignment updates the whole pipeline. See the
    // note in quad.js on why they cannot live in THREE.ShaderLib.
    this.shared = {
      screen: new SharedUniform(new THREE.Vector4(1, 1, 1, 1)),
      fadeParams: new SharedUniform(new THREE.Vector4(0.5, 0.5, 1, TUNE.occluder.radius)),
      aoParams: new SharedUniform(new THREE.Vector2(1, 0.22)),
      aoTex: new SharedUniform(null),
      depth: new SharedUniform(null),
      normal: new SharedUniform(null),
      velocity: new SharedUniform(null),
      projParams: new SharedUniform(new THREE.Vector4(CAMERA.near, CAMERA.far, 0.3, 1.777)),
      frame: new SharedUniform(0),
      reset: new SharedUniform(0),
    };

    this.quad = new ScreenQuad();

    // ---- passes -------------------------------------------------------------
    this.patcher = new MaterialPatcher(this.shared);
    this.shadows = new ShadowFitter(ctx.config);
    this.lightBudget = new LightBudget(ctx.config);
    this.lightBudget.attach(ctx.scene);

    this.prepass = new Prepass(this.shared, q);
    this.ao = new AoPass(this.renderer, this.quad, this.shared, q);
    this.ssr = new SsrPass(this.renderer, this.quad, this.shared, q);
    this.taa = new TaaPass(this.renderer, this.quad, this.shared, q);
    this.exposure = new ExposurePass(this.renderer, this.quad, this.shared, ctx.config);
    this.bloom = new BloomPass(this.renderer, this.quad, q);
    this.dof = new DofPass(this.renderer, this.quad, this.shared, q);
    this.composite = new CompositePass(this.renderer, this.quad, this.shared, q);

    this.shared.aoTex.value = this.ao.texture;

    // ---- state --------------------------------------------------------------
    this.screenSize = { width: 1, height: 1 };
    this.canvasSize = { width: 1, height: 1 };

    this._passes = [];
    this._occluders = [];
    this._prepassMeshes = [];
    this._glowMaterials = new Set();
    this._customEnv = null;
    this._envRT = null;

    // Preallocated scratch. Nothing in `render()` may allocate.
    this._projNoJitter = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._viewProjJitter = new THREE.Matrix4();
    this._playerPos = new THREE.Vector3(0, 0, 0);
    this._focusPoint = new THREE.Vector3(0, 0, 0);
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector4();
    this._sphere = new THREE.Sphere();
    this._hasPlayer = false;
    this._resetPending = true;
    this._visit = this._visitObject.bind(this);

    this._timings = {
      frame: 0, prepass: 0, ao: 0, lit: 0, ui: 0, ssr: 0, taa: 0,
      exposure: 0, bloom: 0, dof: 0, composite: 0,
    };
    this._t = 0;

    // `player:state` is the canonical source of the player's position and is
    // what the occluder fade and the depth-of-field focus both key off.
    this._offPlayer = ctx.events.on('player:state', (e) => {
      if (e?.position) { this._playerPos.copy(e.position); this._hasPlayer = true; }
    });

    // ---- targets ------------------------------------------------------------
    this.rtPrepass = null;
    this.rtHDR = null;
    this.resize(
      Math.max(1, ctx.canvas.clientWidth || 1280),
      Math.max(1, ctx.canvas.clientHeight || 720),
      ctx
    );

    // Diagnostic scene for verifying SSR / bloom / AO before `world` exists.
    // Strictly opt-in: `?renderdebug=1`.
    this.probeScene = null;
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    if (params?.get('renderdebug') === '1') this.probeScene = new RenderProbeScene(ctx, this);
    if (params?.has('renderview')) this.debugView(params.get('renderview'));

    console.info(
      `[render] ${this.caps.renderer} | MRT ${this.caps.maxDrawBuffers} | ` +
      `internal ${this.screenSize.width}x${this.screenSize.height} @${q.renderScale} | ` +
      `shadow ${this.shadows.mapSize} | taa=${this.taa.enabled} gtao=${this.ao.enabled} ` +
      `ssr=${this.ssr.enabled} dof=${this.dof.enabled}`
    );
  }

  // =========================================================================
  // public surface (ARCHITECTURE.md "Render integration")
  // =========================================================================

  /**
   * Insert a custom post pass.
   * @param {{ stage?: 'hdr'|'final', order?: number, material?: THREE.Material,
   *           render?: (renderer, api) => void }} pass
   *   `stage:'hdr'`   runs on the linear HDR buffer, before SSR/TAA — the right
   *                   place for anything that must be anti-aliased and graded
   *                   with the world (volumetrics, distortion).
   *   `stage:'final'` runs after the composite, drawing to the canvas in
   *                   display space — the right place for a full-screen UI
   *                   effect that must not be tone mapped.
   *   A pass with a `material` is drawn as a fullscreen triangle; a pass with a
   *   `render` function is called with `(renderer, api)` and owns its own draws.
   */
  registerPass(pass) {
    if (!pass) return pass;
    pass.stage ??= 'final';
    pass.order ??= 0;
    this._passes.push(pass);
    this._passes.sort((a, b) => a.order - b.order);
    return pass;
  }

  removePass(pass) {
    const i = this._passes.indexOf(pass);
    if (i >= 0) this._passes.splice(i, 1);
  }

  /**
   * Register a punctual light so it participates in culling and the fixed slot
   * budget. Calling this is optional — every light in the scene is discovered
   * automatically — but it is cheaper and it documents intent.
   */
  addLight(light) {
    this.lightBudget.add(light);
    if (light?.isDirectionalLight && light.castShadow) this.shadows.register(light);
    return light;
  }

  removeLight(light) {
    this.lightBudget.remove(light);
    this.shadows.forget(light);
    return light;
  }

  /**
   * Patch a material into the pipeline (screen-space AO, occluder fade, glow)
   * without waiting for it to appear in the scene.
   *
   * Call this from `prewarmMaterials()` for anything you build there but do not
   * add to `ctx.scene` until gameplay starts — otherwise the material compiles
   * unpatched during pre-warm and recompiles on the first frame it is drawn,
   * which is exactly the stall pre-warm exists to prevent.
   */
  registerMaterial(material) {
    if (Array.isArray(material)) { for (const m of material) this.patcher.patch(m); return material; }
    this.patcher.patch(material);
    return material;
  }

  /** The PMREM environment currently lighting the scene, or null. */
  requestEnvMap() {
    return this.ctx.scene.environment ?? this.ctx.peek('sky')?.envMap ?? null;
  }

  /** Linear-sampleable hardware depth of the opaque scene. */
  get depthTexture() { return this.rtPrepass?.depthTexture ?? null; }
  /** View-space normal in rgb, perceptual roughness in a. */
  get normalTexture() { return this.rtPrepass?.textures[0] ?? null; }
  /** Screen-space motion vector in rg (UV units), metalness in b. */
  get velocityTexture() { return this.rtPrepass?.textures[1] ?? null; }
  /** Denoised half-resolution ambient occlusion. */
  get aoTexture() { return this.ao.texture; }
  /** The linear HDR scene colour, before tone mapping. */
  get hdrTexture() { return this.rtHDR?.texture ?? null; }

  /**
   * Dither this mesh out when it stands between the camera and the player.
   *
   * The hole is computed per fragment from the player's screen position and
   * depth, so it works for InstancedMesh and BatchedMesh too, and a wall the
   * player is merely standing near is not affected — only the part of it that is
   * genuinely in front of them. Registration marks the mesh's MATERIAL as
   * eligible, which is what you want: a wall kit shares one material and all of
   * it should open, while the floor that shares nothing with it never does.
   */
  registerOccluderFade(mesh) {
    if (!mesh || this._occluders.includes(mesh)) return mesh;
    mesh.userData.mnOccluder = true;
    mesh.userData._mnFadeAmt = 0;
    this._occluders.push(mesh);
    if (mesh.material && !Array.isArray(mesh.material)) this.patcher.patch(mesh.material);
    return mesh;
  }

  unregisterOccluderFade(mesh) {
    const i = this._occluders.indexOf(mesh);
    if (i >= 0) {
      this._occluders.splice(i, 1);
      this.patcher.setFade(mesh.material, 0);
      mesh.userData.mnOccluder = false;
    }
  }

  /**
   * Show a G-buffer instead of the graded frame.
   *
   * `render.debugView('ao' | 'normal' | 'depth' | 'ssr' | 'velocity' | 'bloom' |
   * 'roughness' | 'off')`, or `?renderview=ao` on the URL — which is how the
   * capture harness reaches it, since it can pass query parameters but cannot
   * evaluate code before the shutter.
   *
   * This exists because "is the ambient occlusion actually doing anything" is
   * not answerable from a graded screenshot, and because `fx`, `world` and `sky`
   * all consume `depthTexture` / `normalTexture` and need to be able to look at
   * what they are consuming.
   */
  debugView(name) {
    const modes = { off: 0, ao: 1, normal: 2, depth: 3, ssr: 4, velocity: 5, bloom: 6, roughness: 7 };
    const v = typeof name === 'number' ? name : (modes[String(name).toLowerCase()] ?? 0);
    this.composite.setDebugView(v);
    return v;
  }

  /** Drop every temporal history and snap exposure. The capture harness calls
   *  this before pumping settle frames so a shot converges from a known state. */
  resetTemporal() {
    this._resetPending = true;
    this.taa.reset();
  }

  // =========================================================================
  // sizing
  // =========================================================================

  resize(w, h, ctx = this.ctx) {
    const q = this.q;
    this.canvasSize.width = w;
    this.canvasSize.height = h;
    this.renderer.setSize(w, h, false);

    const rw = Math.max(16, Math.round(w * q.renderScale));
    const rh = Math.max(16, Math.round(h * q.renderScale));
    if (rw === this.screenSize.width && rh === this.screenSize.height && this.rtHDR) return;

    this.screenSize.width = rw;
    this.screenSize.height = rh;

    disposeTarget(this.rtPrepass);
    disposeTarget(this.rtHDR);
    this.rtPrepass = prepassTarget(rw, rh);
    this.rtHDR = hdrTarget(rw, rh);

    this.shared.screen.value.set(rw, rh, 1 / rw, 1 / rh);
    this.shared.depth.value = this.rtPrepass.depthTexture;
    this.shared.normal.value = this.rtPrepass.textures[0];
    this.shared.velocity.value = this.rtPrepass.textures[1];

    this.ao.resize(rw, rh);
    this.ssr.resize(rw, rh);
    this.taa.resize(rw, rh);
    this.bloom.resize(rw, rh);
    this.dof.resize(rw, rh);
    this.exposure.resize(rw, rh);
    this.composite.resize(rw, rh);
    this.shared.aoTex.value = this.ao.texture;

    if (ctx?.camera) this.ao.setProjection(THREE.MathUtils.degToRad(ctx.camera.fov));
    this.resetTemporal();
  }

  // =========================================================================
  // per-frame scene walk
  // =========================================================================

  /**
   * One traversal per frame that does everything scene-wide:
   *   - honours `mnNoShadow` / `mnNoPrepass` / `mnGlow`
   *   - patches materials the first time they are seen, BEFORE they are drawn,
   *     so the patch costs exactly one compile and not two
   *   - tags prepass eligibility on the reserved layer
   *   - discovers lights so the slot budget can never be bypassed
   */
  _collect(ctx) {
    const scene = ctx.scene;
    this._prepassMeshes.length = 0;

    // Glow is per material but declared per mesh, so anything that stopped
    // glowing has to be reset before the walk rather than left latched on.
    for (const m of this._glowMaterials) this.patcher.setGlow(m, 1);
    this._glowMaterials.clear();

    // The visitor is bound once in init(), not created here: `traverseVisible`
    // takes a callback, and a fresh arrow function every frame is exactly the
    // kind of per-frame allocation ARCHITECTURE.md rule 5 forbids.
    scene.traverseVisible(this._visit);
  }

  _visitObject(o) {
    if (o.isLight) {
      this.lightBudget.add(o);
      if (o.isDirectionalLight && o.castShadow) this.shadows.register(o);
      return;
    }
    if (!o.isMesh) return;

    const ud = o.userData;
    const mat = o.material;

    if (ud.mnNoShadow === true && o.castShadow) o.castShadow = false;

    if (mat && !Array.isArray(mat)) {
      this.patcher.patch(mat);
      if (ud.mnGlow !== undefined && ud.mnGlow !== 1) {
        const u = mat.userData.__mnGlow;
        // Materials shared by several meshes take the strongest request.
        if (u) u.value = this._glowMaterials.has(mat) ? Math.max(u.value, ud.mnGlow) : ud.mnGlow;
        this._glowMaterials.add(mat);
      }

      // Prepass eligibility. Transparent geometry is excluded on purpose: a
      // particle sheet writing depth and normals would make SSR reflect the
      // smoke and GTAO occlude under it.
      const eligible =
        ud.mnNoPrepass !== true &&
        mat.transparent !== true &&
        mat.depthWrite !== false &&
        mat.colorWrite !== false;

      if (eligible) { o.layers.enable(PREPASS_LAYER); this._prepassMeshes.push(o); }
      else o.layers.disable(PREPASS_LAYER);
    } else {
      o.layers.disable(PREPASS_LAYER);
    }
  }

  /**
   * Occluder fade. The CPU test only decides WHICH materials are eligible this
   * frame; the shape of the hole is per fragment, driven by the player's screen
   * position and depth (see glsl.js OCCLUDER_FADE).
   */
  _updateOccluders(ctx, dt) {
    const list = this._occluders;
    if (!list.length) return;

    const cam = ctx.camera;
    const vp = this._viewProjJitter;
    const k = 1 - Math.exp(-dt / Math.max(1e-3, TUNE.occluder.fadeTime));

    // Reset every eligible material first; the loop below takes the maximum
    // over all meshes sharing it.
    for (let i = 0; i < list.length; i++) {
      const u = list[i].material?.userData?.__mnFade;
      if (u) u.value = 0;
    }

    const playerUvX = this.shared.fadeParams.value.x;
    const playerUvY = this.shared.fadeParams.value.y;
    const playerDepth = this.shared.fadeParams.value.z;
    const radius = this.shared.fadeParams.value.w;
    const aspect = this.screenSize.width / this.screenSize.height;

    for (let i = 0; i < list.length; i++) {
      const mesh = list[i];
      let target = 0;

      if (mesh.visible && mesh.parent) {
        // An InstancedMesh / BatchedMesh keeps its own bounding sphere over all
        // instances; the geometry's sphere only covers one of them, which for a
        // wall kit is a rounding error next to the wall it is supposed to bound.
        const geo = mesh.geometry;
        let src = null;
        if (mesh.isInstancedMesh || mesh.isBatchedMesh) {
          if (!mesh.boundingSphere) mesh.computeBoundingSphere();
          src = mesh.boundingSphere;
        } else if (geo) {
          if (!geo.boundingSphere) geo.computeBoundingSphere();
          src = geo.boundingSphere;
        }
        if (src) {
          this._sphere.copy(src).applyMatrix4(mesh.matrixWorld);

          const c = this._sphere.center;
          this._v4.set(c.x, c.y, c.z, 1).applyMatrix4(vp);
          const w = Math.max(1e-5, this._v4.w);
          const sx = (this._v4.x / w) * 0.5 + 0.5;
          const sy = (this._v4.y / w) * 0.5 + 0.5;
          const sz = (this._v4.z / w) * 0.5 + 0.5;

          // Screen radius of the bounding sphere, in UV.
          const viewZ = Math.max(0.1, this._v3.copy(c).applyMatrix4(cam.matrixWorldInverse).z * -1);
          const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
          const srad = this._sphere.radius / (viewZ * tanHalf * 2);

          const dx = (sx - playerUvX) * aspect;
          const dy = sy - playerUvY;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // In front of the player, and overlapping the hole on screen.
          if (sz < playerDepth && dist < radius + srad) target = 1;
        }
      }

      const prev = mesh.userData._mnFadeAmt ?? 0;
      const amt = prev + (target - prev) * k;
      mesh.userData._mnFadeAmt = amt;

      const u = mesh.material?.userData?.__mnFade;
      if (u && amt > u.value) u.value = amt;
    }
  }

  // =========================================================================
  // the frame
  // =========================================================================

  render(ctx) {
    const t0 = performance.now();
    const r = this.renderer;
    const cam = ctx.camera;
    const W = this.screenSize.width;
    const H = this.screenSize.height;
    const dt = Math.min(0.1, Math.max(1e-4, ctx.time.rawDt || 1 / 60));

    r.info.reset();
    this.shared.frame.value = ctx.time.frame;
    this.shared.reset.value = this._resetPending ? 1 : 0;

    this._collect(ctx);
    this.probeScene?.update(ctx);

    // ---- 2. camera matrices + TAA jitter ------------------------------------
    if (cam.parent === null) cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    this._projNoJitter.copy(cam.projectionMatrix);
    this._viewProj.multiplyMatrices(this._projNoJitter, cam.matrixWorldInverse);

    const jit = this.taa.nextJitter();
    // Sub-pixel offset injected into the projection centre. This is the ONLY
    // place the camera is touched; it is restored at the end of the frame so
    // `player` and `dev/shots` always see the matrix they set.
    cam.projectionMatrix.elements[8] += (2 * jit.x) / W;
    cam.projectionMatrix.elements[9] += (2 * jit.y) / H;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this._viewProjJitter.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    this.shared.projParams.value.set(cam.near, cam.far, tanHalf, cam.aspect);
    this.ao.setProjection(THREE.MathUtils.degToRad(cam.fov));

    // ---- focus point: the player, or the ground under the camera ------------
    // `player:state` is the documented source, but a subsystem that has not
    // started emitting it yet must not leave the occluder fade and the depth of
    // field focused on nothing — so fall back to the live actor reference, and
    // then to the point the camera is actually looking at on the ground.
    if (!this._hasPlayer) {
      this._playerSys ??= ctx.peek('player');
      const p = this._playerSys?.position;
      if (p && p.isVector3) {
        this._playerPos.copy(p);
      } else {
        cam.getWorldDirection(this._v3);
        const t = this._v3.y < -1e-3 ? -cam.position.y / this._v3.y : 0;
        this._playerPos.copy(cam.position).addScaledVector(this._v3, t);
      }
    }
    this._focusPoint.copy(this._playerPos);

    // Player screen position + window depth, for the occluder hole.
    this._v4.set(this._playerPos.x, this._playerPos.y + 1.0, this._playerPos.z, 1)
      .applyMatrix4(this._viewProjJitter);
    const pw = Math.max(1e-5, this._v4.w);
    this.shared.fadeParams.value.set(
      (this._v4.x / pw) * 0.5 + 0.5,
      (this._v4.y / pw) * 0.5 + 0.5,
      (this._v4.z / pw) * 0.5 + 0.5,
      TUNE.occluder.radius
    );
    this._updateOccluders(ctx, dt);

    // Depth of field focuses on the player.
    const focusZ = Math.max(1, -this._v3.copy(this._playerPos).applyMatrix4(cam.matrixWorldInverse).z + TUNE.dof.focusLift);
    this.dof.setFocus(focusZ);
    this.composite.setFocus(focusZ);

    // ---- 3/4. shadows and light slots ---------------------------------------
    this.shadows.update(cam);
    this.lightBudget.update(this._focusPoint);

    // ---- 5. depth / normal / velocity prepass -------------------------------
    this._t = performance.now();
    this.prepass.setMatrices(this._projNoJitter, this._prevViewProj);
    this.prepass.bind(this._prepassMeshes);

    const camMask = cam.layers.mask;
    const bg = ctx.scene.background;
    const env = ctx.scene.environment;
    ctx.scene.background = null;
    ctx.scene.environment = null;
    cam.layers.set(PREPASS_LAYER);
    // The lit pass renders the shadow map; if the prepass did too we would pay
    // for it twice per frame.
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = false;

    r.setRenderTarget(this.rtPrepass);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(ctx.scene, cam);

    cam.layers.mask = camMask;
    ctx.scene.background = bg;
    ctx.scene.environment = env;
    this.prepass.unbind();
    r.shadowMap.autoUpdate = true;
    this._timings.prepass = this._lap();

    // ---- 6. ambient occlusion (before the lit pass, by necessity) -----------
    this.ao.render();
    this.shared.aoTex.value = this.ao.texture;
    this._timings.ao = this._lap();

    // ---- 7. lit pass ---------------------------------------------------------
    r.setRenderTarget(this.rtHDR);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(ctx.scene, cam);
    this._timings.lit = this._lap();

    // ---- 8. uiScene, depth cleared -------------------------------------------
    // Into the HDR buffer on purpose: a selection ring or a world-space damage
    // number should be graded, bloomed and exposed with the world, or it looks
    // pasted on. Anything that must stay pixel-crisp belongs in the DOM overlay
    // or in a `registerPass({ stage: 'final' })`.
    if (ctx.uiScene.children.length) {
      r.clearDepth();
      r.render(ctx.uiScene, ctx.uiCamera);
    }
    this._timings.ui = this._lap();

    this._runPasses('hdr', this.rtHDR);

    // ---- 9. screen-space reflections -----------------------------------------
    if (this.ssr.enabled) {
      this.ssr.render(this.rtHDR.texture);
      this.composite.addSsr(this.rtHDR, this.ssr.texture);
    }
    this._timings.ssr = this._lap();

    // ---- 10. TAA -------------------------------------------------------------
    this.taa.render(this.rtHDR.texture);
    const resolved = this.taa.texture;
    this._timings.taa = this._lap();

    // ---- 11-13. exposure, bloom, DOF ----------------------------------------
    this.exposure.render(resolved, dt);
    this._timings.exposure = this._lap();

    this.bloom.render(resolved);
    this._timings.bloom = this._lap();

    this.dof.render(resolved);
    this._timings.dof = this._lap();

    // ---- 14. composite -------------------------------------------------------
    this.composite.render({
      color: resolved,
      bloom: this.bloom.texture,
      bloomNorm: this.bloom.normalisation,
      dof: this.dof.texture,
      exposure: this.exposure.texture,
      ssr: this.ssr.texture,
      target: null,
    });
    this._runPasses('final', null);
    this._timings.composite = this._lap();

    // ---- restore -------------------------------------------------------------
    cam.projectionMatrix.copy(this._projNoJitter);
    cam.projectionMatrixInverse.copy(this._projNoJitter).invert();
    this._prevViewProj.copy(this._viewProj);
    this._resetPending = false;

    r.setRenderTarget(null);
    // Exponential moving average: a single frame time on a software rasteriser
    // is dominated by whatever the OS scheduler did, and is not information.
    const ms = performance.now() - t0;
    this._timings.frame = this._timings.frame * 0.9 + ms * 0.1;
  }

  _lap() {
    const now = performance.now();
    const d = now - this._t;
    this._t = now;
    return d;
  }

  _runPasses(stage, target) {
    for (let i = 0; i < this._passes.length; i++) {
      const p = this._passes[i];
      if (p.stage !== stage || p.enabled === false) continue;
      if (typeof p.render === 'function') {
        p.render(this.renderer, this._passApi(target));
      } else if (p.material) {
        this.quad.render(this.renderer, p.material, target);
      }
    }
  }

  _passApi(target) {
    // Reused object: `registerPass` consumers must not retain it.
    this._api ??= {};
    const a = this._api;
    a.target = target;
    a.quad = this.quad;
    a.hdr = this.rtHDR;
    a.depth = this.depthTexture;
    a.normal = this.normalTexture;
    a.velocity = this.velocityTexture;
    a.ao = this.ao.texture;
    a.exposure = this.exposure.texture;
    a.size = this.screenSize;
    a.ctx = this.ctx;
    return a;
  }

  // =========================================================================
  // pre-warm
  // =========================================================================

  /**
   * Compile every permutation this pipeline can produce, with a render target
   * bound, before the first frame.
   *
   * Runs FIRST among all subsystems (render has no deps), which is exactly what
   * we need: freezing the light slot count and patching every material already
   * in the scene here means every other subsystem's own `prewarmMaterials`
   * compiles the final variant rather than one that will be thrown away.
   *
   * `renderer.compile()` alone only reaches the forward lit variant. The shadow
   * pass uses `MeshDepthMaterial` clones keyed per light and the prepass uses
   * our own MRT materials, and neither is reachable that way — so both are
   * warmed by actually rendering one frame into an offscreen target. No clock
   * is read, no RNG is touched and no gameplay object is created.
   */
  async prewarmMaterials(ctx) {
    const r = this.renderer;
    const cam = ctx.camera;

    // 1. Fix the light slot count for the lifetime of the process.
    const slots = this.lightBudget.freeze(ctx.scene);
    this.lightBudget.update(this._focusPoint);

    // 2. Patch everything already in the scene, and register shadow casters.
    this._collect(ctx);
    for (const light of this.lightBudget.registered) {
      if (light.isDirectionalLight && light.castShadow) this.shadows.register(light);
    }
    this.shadows.update(cam);

    // 3. Fallback environment. `sky` owns IBL; if it has not provided one by the
    //    time we get here there is no indirect term at all, which means AO has
    //    nothing to multiply and every unlit surface is pure void. A very dim
    //    procedural gradient keeps the model complete and is released the moment
    //    `sky` assigns a real one.
    if (!ctx.scene.environment) this._installFallbackEnv(ctx);

    // 4. Forward lit variants, with a float target bound so `outputColorSpace`
    //    and `toneMapping` match what the real frame will use.
    r.setRenderTarget(this.rtHDR);
    r.compile(ctx.scene, cam);

    // 5. Prepass MRT variants + the shadow depth materials, by rendering once.
    this.prepass.setMatrices(cam.projectionMatrix, this._viewProj);
    this.prepass.bind(this._prepassMeshes);
    const camMask = cam.layers.mask;
    const bg = ctx.scene.background;
    ctx.scene.background = null;
    cam.layers.set(PREPASS_LAYER);
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = false;
    r.setRenderTarget(this.rtPrepass);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(ctx.scene, cam);
    cam.layers.mask = camMask;
    ctx.scene.background = bg;
    this.prepass.unbind();

    r.shadowMap.autoUpdate = true;
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.rtHDR);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(ctx.scene, cam);

    // 6. The post chain. The composite MUST be compiled against the canvas:
    //    `outputColorSpace` is read off the currently bound target and is part of
    //    the program cache key, so compiling it against a float target warms a
    //    variant that will never be used.
    this.ao.render();
    this.shared.aoTex.value = this.ao.texture;
    if (this.ssr.enabled) {
      this.ssr.render(this.rtHDR.texture);
      this.composite.addSsr(this.rtHDR, this.ssr.texture);
    }
    this.taa.render(this.rtHDR.texture);
    const resolved = this.taa.texture;
    this.exposure.render(resolved, 1 / 60);
    this.bloom.render(resolved);
    this.dof.render(resolved);
    this.composite.render({
      color: resolved,
      bloom: this.bloom.texture,
      bloomNorm: this.bloom.normalisation,
      dof: this.dof.texture,
      exposure: this.exposure.texture,
      ssr: this.ssr.texture,
      target: null,
    });
    this._runPasses('hdr', this.rtHDR);
    this._runPasses('final', null);

    r.setRenderTarget(null);
    this.resetTemporal();

    console.info('[render] prewarm', {
      slots,
      materials: this.patcher.count,
      prepassVariants: this.prepass.stats().variants,
      programs: r.info.programs?.length ?? 0,
    });
  }

  /** A 16x8 equirect gradient -> PMREM. Deliberately dim and cold; this is a
   *  floor under the lighting model, not a look. */
  _installFallbackEnv(ctx) {
    const w = 16, h = 8;
    const data = new Float32Array(w * h * 4);
    const sky = LIGHTS.moon.color;
    const ground = ENV.dirt;
    for (let y = 0; y < h; y++) {
      const t = y / (h - 1);            // 0 = top of the sphere
      // Slightly more light from above than below, with a warm bounce off the
      // floor so the underside of geometry is not the same colour as the sky.
      const up = Math.pow(1 - t, 1.4);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i + 0] = (sky[0] * 0.055 * up + ground[0] * 0.05 * (1 - up));
        data[i + 1] = (sky[1] * 0.055 * up + ground[1] * 0.05 * (1 - up));
        data[i + 2] = (sky[2] * 0.055 * up + ground[2] * 0.05 * (1 - up));
        data[i + 3] = 1;
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    this._envRT = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    tex.dispose();

    this._customEnv = this._envRT.texture;
    ctx.scene.environment = this._customEnv;
    ctx.scene.environmentIntensity = TUNE.ambient.envIntensity;
  }

  /** Release the fallback the moment `sky` provides a real environment. */
  update() {
    if (this._customEnv && this.ctx.scene.environment !== this._customEnv) {
      this._envRT?.dispose();
      this._envRT = null;
      this._customEnv = null;
    }
  }

  // =========================================================================
  // introspection
  // =========================================================================

  stats() {
    const info = this.renderer.info;
    const t = this._timings;
    const round = (x) => +x.toFixed(2);
    return {
      device: this.caps.renderer,
      size: `${this.screenSize.width}x${this.screenSize.height}`,
      canvas: `${this.canvasSize.width}x${this.canvasSize.height}`,
      renderScale: this.q.renderScale,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      ms: {
        frame: round(t.frame),
        prepass: round(t.prepass), ao: round(t.ao), lit: round(t.lit), ui: round(t.ui),
        ssr: round(t.ssr), taa: round(t.taa), exposure: round(t.exposure),
        bloom: round(t.bloom), dof: round(t.dof), composite: round(t.composite),
      },
      passes: {
        ao: this.ao.stats(),
        ssr: this.ssr.stats(),
        bloom: this.bloom.stats(),
        taa: this.taa.stats(),
        dof: this.dof.stats(),
        custom: this._passes.length,
      },
      exposure: this.exposure.readState(),
      shadows: this.shadows.stats(),
      lights: this.lightBudget.stats(),
      materials: { patched: this.patcher.count, prepassVariants: this.prepass.stats().variants },
      occluders: this._occluders.length,
      prepassMeshes: this._prepassMeshes.length,
      shadowChunk: this.shadowChunkOk,
      env: this._customEnv ? 'fallback' : (this.ctx.scene.environment ? 'sky' : 'none'),
    };
  }

  dispose() {
    this._offPlayer?.();
    this.probeScene?.dispose();

    this.prepass.dispose();
    this.ao.dispose();
    this.ssr.dispose();
    this.taa.dispose();
    this.exposure.dispose();
    this.bloom.dispose();
    this.dof.dispose();
    this.composite.dispose();
    this.patcher.dispose();
    this.lightBudget.dispose();
    this.quad.dispose();

    disposeTarget(this.rtPrepass);
    disposeTarget(this.rtHDR);
    this._envRT?.dispose();
    if (this.ctx?.scene?.environment === this._customEnv) this.ctx.scene.environment = null;

    this.renderer.dispose();
  }
}
