import * as THREE from 'three';
import { LIGHTS } from '../core/palette.js';

import { ATMOS, FOG, MOON, MIST, IBL, VOLUME, budgetsFor } from './tuning.js';
import { VARIANTS, bodyDirections, resolveTime } from './presets.js';
import { buildCloudNoise2D, buildFogNoise3D, buildBlueNoise } from './noise.js';
import { buildAtmosphereLuts } from './atmosphere.js';
import { SkyDome } from './dome.js';
import { StarField } from './stars.js';
import { IblGenerator } from './ibl.js';
import { VolumetricFog } from './volumetrics.js';
import { GroundMist } from './mist.js';
import { SkyDebug } from './debug.js';

/**
 * ============================================================================
 * MONARCH — `sky` subsystem.  PUBLIC API.
 * ============================================================================
 *
 *   id    'sky'
 *   deps  ['render']
 *
 * `const sky = ctx.get('sky')`. Nothing outside `src/sky/` imports a module from
 * this directory.
 *
 *   sky.setTimeOfDay(hours [, variant])   1.2 = the default moonlit night.
 *                                         Accepts 'night' | 'bloodmoon' |
 *                                         'predawn' as well as an hour.
 *   sky.envMap                            PMREM environment. `render`'s
 *                                         `requestEnvMap()` finds this.
 *   sky.keyLight                          the effective directional key light,
 *                                         whether `sky` owns it or `world` does
 *   sky.moonLight                         the light `sky` owns, or null if it
 *                                         yielded to one `world` created
 *   sky.moonDirection                     unit Vector3 TOWARD the moon
 *   sky.ambientRadiance                   the sky's average radiance, which is
 *                                         what the fog and the mist are lit by
 *   sky.setFogDensity(scale)              per-room fog multiplier for `world`
 *   sky.addRipple(pos, radius)            part the ground mist (fx explosions do
 *                                         this automatically via `fx:explosion`)
 *   sky.refreshEnv()                      force an IBL regeneration
 *   sky.resetTemporal()                   drop the volumetric history
 *   sky.stats()
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS OWNS, and the order it happens in every frame
 *
 *   dome.js         the sky you see through a gate: scattering from a baked LUT,
 *                   a limb-darkened moon, two cloud layers, the galaxy
 *   stars.js        1500 stars with a real magnitude distribution, blackbody
 *                   colours and airmass-scaled scintillation
 *   ibl.js          a CPU-evaluated equirect -> PMREM, regenerated lazily. This
 *                   is the ambient term for every material in the game
 *   volumetrics.js  exponential height fog + ray-marched light shafts, quarter
 *                   res, blue-noise dithered, temporally accumulated, bilaterally
 *                   upsampled, composited into the HDR buffer
 *   mist.js         the ground mist card that pools in low areas and is parted by
 *                   the player and by explosions
 *
 * ---------------------------------------------------------------------------
 * THE KEY LIGHT, and why this subsystem might not own it
 *
 * `sky` owns the moon, so by default it creates the directional key light and
 * drives it from the ephemeris. But `world` may legitimately want to light a
 * sealed crypt with its own rig, and TWO shadow-casting directional lights cost
 * a second full shadow-map render every frame — which on a software rasteriser
 * is the most expensive thing either subsystem could do to the other.
 *
 * So the decision is deferred to `world:ready`: if `world` has already put a
 * shadow-casting directional light in the scene, `sky` ADOPTS it — it never
 * creates a second one, it reads that light's direction and colour for the fog,
 * the shafts and the IBL, and it points the visible moon disc along it so the
 * sky and the shadows agree about where the light is coming from. If there is no
 * such light, `sky` creates and owns one.
 *
 * Either way `sky.keyLight` is the answer and the volumetric march samples that
 * light's shadow map, so a shaft is genuinely occluded by geometry.
 */
export class SkySystem {
  static id = 'sky';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.q = ctx.config.q;
    const render = ctx.get('render');
    this.render = render;

    const t0 = performance.now();

    // Everything random in this subsystem comes from ONE fork, taken here and
    // never touched again after init. The star field and the noise volumes are
    // therefore identical on every run, which is what makes a capture stable.
    this.rng = ctx.rng.fork();

    // ---- procedural resources ------------------------------------------------
    this.cloudNoise = buildCloudNoise2D(this.rng, 256);
    this.fogNoise = buildFogNoise3D(this.rng, 32);
    this.blueNoise = buildBlueNoise(this.rng, 32);
    this.lut = buildAtmosphereLuts();

    // ---- scene objects -------------------------------------------------------
    this.root = new THREE.Group();
    this.root.name = 'mn.sky';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    this.dome = new SkyDome(this.cloudNoise, this.lut);
    this.root.add(this.dome.mesh);

    this.stars = new StarField(this.rng, this.dome.uniforms, this.lut.transmittance);
    this.root.add(this.stars.points);

    this.budgets = budgetsFor(ctx.config);
    this.mist = new GroundMist(this.fogNoise, Math.min(2, this.budgets.lights || 2));
    this.root.add(this.mist.mesh);

    // ---- fog / volumetrics ---------------------------------------------------
    this.fog = new VolumetricFog(
      render.renderer, ctx.config,
      { fogNoise: this.fogNoise, blueNoise: this.blueNoise },
      this.budgets
    );
    this.fog.resize(render.screenSize.width, render.screenSize.height);

    // Registered at `stage: 'hdr'` so the fog lands on the linear HDR buffer
    // before SSR, TAA and the grade — fog is scene radiance and has to be
    // anti-aliased, exposed and tone mapped with the world. `order: 10` leaves
    // room below for anything `fx` wants to distort before the air is added.
    this.pass = render.registerPass({
      stage: 'hdr',
      order: 10,
      render: (renderer, api) => {
        // The shadow map for THIS frame has just been rendered by the lit pass,
        // so `light.shadow.matrix` and `light.shadow.map` are both current. This
        // is the only moment in the frame where that is true.
        this.fog.setShadowLight(this._shadowLight);
        this.fog.render(renderer, api);
      },
    });

    // ---- IBL -----------------------------------------------------------------
    this.ibl = new IblGenerator(render.renderer, this.lut);
    this._envDirty = true;
    this._envForce = true;
    this._envAt = -1e9;

    // ---- the moon ------------------------------------------------------------
    // Created but NOT added to the scene: `_electKeyLight` decides at
    // `world:ready` whether this subsystem should own the key at all. Adding a
    // second shadow-casting directional light and then removing it would still
    // have cost a shader permutation and a shadow-map allocation.
    this.moonLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.moonLight.name = 'mn.sky.moon';
    this.moonLight.target = new THREE.Object3D();
    this.moonLight.target.name = 'mn.sky.moon.target';
    this.moonLight.castShadow = true;
    this.moonLight.shadow.mapSize.set(this.q.shadowMapSize, this.q.shadowMapSize);
    this.moonLight.shadow.camera.near = 0.5;
    this.moonLight.shadow.camera.far = 120;
    this._ownsKey = false;
    this._elected = false;
    this.keyLight = null;
    this._shadowLight = null;

    // ---- state ---------------------------------------------------------------
    this.time = { hours: 1.2, variant: 'moonlit', explicitVariant: false };
    this.preset = VARIANTS.moonlit;
    /** Set once the first `setTimeOfDay` has actually pushed a preset through;
     *  until then even a "matching" request has to do the work. */
    this._applied = false;
    this.fogDensityScale = 1.0;

    this.moonDirection = new THREE.Vector3(0, 1, 0);
    this.sunDirection = new THREE.Vector3(0, -1, 0);
    this.ambientRadiance = new THREE.Vector3(0.004, 0.005, 0.008);

    // ---- preallocated scratch (nothing below allocates per frame) -------------
    this._bodies = { moon: new THREE.Vector3(), sun: new THREE.Vector3() };
    this._v3 = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._tx = new THREE.Vector3();
    this._ty = new THREE.Vector3();
    this._tint = new THREE.Vector3();
    this._shaft = new THREE.Vector3();
    this._adopted = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this._playerPos = new THREE.Vector3();
    this._hasPlayer = false;
    this._playerMoving = false;
    this._moonIrradiance = new THREE.Vector3();
    this._moonColor = new THREE.Vector3();
    this._fogAmbient = new THREE.Vector3();
    this._lightWorld = new THREE.Vector3();
    this._targetWorld = new THREE.Vector3();

    // Cached point-light list. A full scene traversal every frame is real CPU
    // cost in a level with hundreds of props, and lights do not appear and
    // disappear at frame rate — so it is refreshed on a slow cadence and on the
    // events that can actually change it.
    this._pointLights = [];
    this._lightSlots = [];
    for (let i = 0; i < 8; i++) {
      this._lightSlots.push({
        pos: new THREE.Vector3(), rgb: new THREE.Vector3(), cutoff: 0, score: 0,
        // Spot lights only. `axis` is null for a point light, which is what the
        // march's cone test keys off.
        axis: null, _axis: new THREE.Vector3(), cosOuter: -2,
      });
    }
    this._activeLights = [];
    this._iblLights = [];
    for (let i = 0; i < 4; i++) {
      this._iblLights.push({ dir: new THREE.Vector3(), rgb: new THREE.Vector3() });
    }
    /** Reused list handed to the IBL generator. Regeneration is rare, but rule 5
     *  is rule 5 and a GC pause landing on the frame that also runs PMREM is the
     *  worst possible time for one. */
    this._iblList = [];
    this._lightScanFrame = -1e9;
    this._lightSignature = 0;
    this._visitLight = (o) => { if (o.isPointLight || o.isSpotLight) this._pointLights.push(o); };

    // ---- events ---------------------------------------------------------------
    this._offs = [];
    this._offs.push(ctx.events.on('player:state', (e) => {
      if (e?.position) {
        this._playerPos.copy(e.position);
        this._hasPlayer = true;
        this._playerMoving = !!(e.moving || e.dashing);
      }
    }));
    this._offs.push(ctx.events.on('fx:explosion', (e) => {
      if (e?.position) this.addRipple(e.position, e.radius ?? MIST.explosionRadius);
    }));
    this._offs.push(ctx.events.on('world:ready', () => {
      this._electKeyLight();
      this._lightScanFrame = -1e9;   // rescan practicals immediately
      this._envDirty = true;
      this._envForce = true;
      this.fog.reset();
    }));
    this._offs.push(ctx.events.on('shot:applied', () => {
      // A shot teleports the camera. Drop the volumetric history or the previous
      // framing smears across the new one for a dozen frames.
      this.fog.reset();
    }));

    // ---- URL overrides --------------------------------------------------------
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const wanted = params?.get('sky');
    this.debug = new SkyDebug(this, params?.get('skyview') ?? null);

    this.setTimeOfDay(wanted ?? 1.2, wanted && VARIANTS[wanted] ? wanted : undefined);

    this._initMs = performance.now() - t0;
    console.info(
      `[sky] lut ${ATMOS.lutW}x${ATMOS.lutH} (${this.lut.bakeMs.toFixed(0)}ms) | ` +
      `stars ${this.stars.geometry.attributes.position.count} (${this.stars.brightCount} brighter than mag 2) | ` +
      `fog ${this.budgets.enabled ? `${this.budgets.steps} steps, ${this.budgets.lights} lights, ${this.fog.lowWidth}x${this.fog.lowHeight}` : 'analytic only'} | ` +
      `init ${this._initMs.toFixed(0)}ms`
    );
  }

  // =========================================================================
  // public API
  // =========================================================================

  /**
   * Set the time of day.
   *
   * `hours` may be a number (0-24), or one of the shorthands 'night',
   * 'bloodmoon', 'predawn'. `variant` overrides the mood explicitly. The shot
   * harness calls this with a bare hour, so a bare hour has to produce a
   * complete, correct look on its own.
   */
  setTimeOfDay(hours, variant) {
    const t = resolveTime(hours, variant, this.time);

    // Early-out on a no-op. This matters more than it looks: EVERY shot in the
    // capture harness calls `setTimeOfDay(1.2)`, which is already the default,
    // and a time change forces an immediate PMREM regeneration past the rate
    // limit — ~1 s on this software rasteriser. Without this guard every agent
    // in the fleet pays that second on every capture, forever, for nothing.
    if (this._applied && t.hours === this.time.hours && t.variant === this.time.variant) {
      this.time = t;
      return { hours: +t.hours.toFixed(3), variant: t.variant, unchanged: true };
    }

    this.time = t;
    this.preset = VARIANTS[t.variant];
    this._applied = true;

    bodyDirections(t.hours, this._bodies);
    this.moonDirection.copy(this._bodies.moon);
    this.sunDirection.copy(this._bodies.sun);

    this._applyPreset();

    // The environment map is the ambient light for the whole game; a mood change
    // that does not reach it leaves every shadowed surface lit by the previous
    // sky. Forced past the rate limit because a time change is deliberate and
    // rare, unlike a brazier flicker.
    this._envDirty = true;
    this._envForce = true;
    this.fog.reset();

    return { hours: +t.hours.toFixed(3), variant: t.variant };
  }

  /** Per-room fog multiplier. `world` can make a flooded crypt thicker than a
   *  cathedral hall without knowing anything about the fog model. */
  setFogDensity(scale) {
    this.fogDensityScale = Math.max(0, scale);
    const k = this.preset.fogDensityScale * this.fogDensityScale;
    this.fog.setFogParams({ density: FOG.density * k, uniform: FOG.densityUniform * k });
    return this.fogDensityScale;
  }

  /** Part the ground mist at a point. `fx:explosion` does this automatically. */
  addRipple(position, radius = MIST.explosionRadius) {
    this.mist.addRipple(position, radius);
  }

  /** The PMREM environment currently lighting the scene. `render.requestEnvMap()`
   *  reads this. */
  get envMap() { return this.ibl?.texture ?? null; }

  /** Force an IBL regeneration on the next update, past the rate limit. */
  refreshEnv() { this._envDirty = true; this._envForce = true; }

  /** Drop the volumetric temporal history. */
  resetTemporal() { this.fog.reset(); }

  /**
   * Debug view. Also reachable as `?skyview=<name>` on the URL, which is how the
   * capture harness gets at it (it can pass query parameters but cannot evaluate
   * code before the shutter).
   *
   *   'off'    normal rendering
   *   'dome'   the whole sky as an equirectangular panorama, stars included.
   *            The camera pitch is fixed at -52 degrees, so the sky is NEVER
   *            visible in a normal shot and this is the only way to review it
   *   'moon'   a 3-degree gnomonic field on the moon: limb, maria, terminator
   *   'fog'    the raw quarter-resolution march buffer, in-scatter on the left
   *            and transmittance on the right
   *   'env'    the generated IBL equirect before PMREM
   *   'nofog'  the A/B control — everything runs, the fog composite is muted
   */
  debugView(name) { return this.debug.set(name); }

  // =========================================================================
  // frame
  // =========================================================================

  update(dt, ctx) {
    const cam = ctx.camera;
    const time = ctx.time.elapsed;

    // ---- focus point ---------------------------------------------------------
    // The player if anyone has said where they are; otherwise the point the
    // camera is looking at on the ground. Used to place the mist card, to rank
    // the practicals, and as the origin for the IBL's local bounce.
    if (this._hasPlayer) {
      this._focus.copy(this._playerPos);
    } else {
      cam.getWorldDirection(this._v3);
      const t = this._v3.y < -1e-3 ? -cam.position.y / this._v3.y : 0;
      this._focus.copy(cam.position).addScaledVector(this._v3, t);
    }

    // ---- key light -----------------------------------------------------------
    // Elected at `world:ready`, but a world that never emits it must not leave
    // the game unlit — so elect lazily on the first frame too.
    if (!this._elected) this._electKeyLight();
    this._syncKeyLight();

    // ---- sky objects ---------------------------------------------------------
    this.dome.update(cam, time);
    this.stars.update(cam, time, this.render.screenSize.height);

    // ---- practicals ----------------------------------------------------------
    this._gatherLights(ctx);
    this.fog.setLights(this._activeLights);
    this.mist.setLights(this._activeLights);

    // ---- ground mist ---------------------------------------------------------
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    this.mist.setProjection(cam.near, cam.far, tanHalf, cam.aspect);
    this.mist.setScreen(this.render.screenSize.width, this.render.screenSize.height);
    if (this._hasPlayer) this.mist.setPlayer(this._playerPos, this._playerMoving);
    this.mist.update(dt, this._focus, time, this.render.depthTexture);

    // ---- IBL ------------------------------------------------------------------
    this._maybeRegenerateEnv(ctx);

    this.debug.update(ctx);
  }

  resize(w, h, ctx) {
    // The fog runs at the RENDERER's internal resolution, which is the canvas
    // size times `q.renderScale` — not the canvas size.
    const s = this.render.screenSize;
    this.fog.resize(s.width, s.height);
    this.mist.setScreen(s.width, s.height);
    this.stars.uniforms.uPixelHeight.value = s.height;
  }

  // =========================================================================
  // internals
  // =========================================================================

  /**
   * Push the active preset into every consumer.
   *
   * One function, called from exactly one place, because the failure mode of
   * spreading this out is a mood change that reaches the sky but not the fog —
   * a red moon over blue fog, which reads as a bug in a way that is hard to
   * name and impossible to unsee.
   */
  _applyPreset() {
    const p = this.preset;
    const u = this.dome.uniforms;

    u.uSkyIrradiance.value = p.skyIrradiance;
    u.uRayleighTint.value.fromArray(p.rayleighTint);
    u.uMieTint.value.fromArray(p.mieTint);
    u.uNightFloor.value.fromArray(p.nightFloor);
    u.uNightHorizon.value = p.nightHorizon;
    u.uLightColor.value.fromArray(p.moonColor);

    u.uMoonDir.value.copy(this.moonDirection);
    u.uMoonColor.value.fromArray(p.moonColor);

    const radius = THREE.MathUtils.degToRad(MOON.angularRadiusDeg * p.moonSize);
    // .w is the exponent that produces the tight aureole: chosen so the glow has
    // fallen to half at `glowRadius` moon radii. Solving
    // cos(r * glowRadius)^k = 0.5 for k gives this.
    const glowK = Math.log(0.5) / Math.log(Math.max(1e-6, Math.cos(radius * MOON.glowRadius)));
    u.uMoonDisc.value.set(Math.cos(radius), Math.sin(radius), MOON.radiance * p.moonRadiance, glowK);

    // Where the moon is lit from. The phase angle is measured from the
    // anti-solar point: fraction 1 is full (sun behind us), 0 is new. Building
    // the direction in the SAME tangent frame the shader derives means the
    // terminator lands where the shader expects it to.
    const md = this.moonDirection;
    const up = Math.abs(md.y) < 0.985 ? this._up.set(0, 1, 0) : this._up.set(1, 0, 0);
    const tx = this._tx.crossVectors(up, md).normalize();
    const ty = this._ty.crossVectors(md, tx);
    const alpha = Math.acos(THREE.MathUtils.clamp(2 * p.moonPhase - 1, -1, 1));
    const axisX = Math.cos(p.moonPhaseAngle), axisY = Math.sin(p.moonPhaseAngle);
    // Rotate -moonDir (the full-moon illumination direction) by alpha about the
    // in-plane axis given by the phase angle.
    const s = Math.sin(alpha), c = Math.cos(alpha);
    u.uMoonSun.value.set(
      -md.x * c + (tx.x * axisX + ty.x * axisY) * s,
      -md.y * c + (tx.y * axisX + ty.y * axisY) * s,
      -md.z * c + (tx.z * axisX + ty.z * axisY) * s
    ).normalize();

    u.uCloudHigh.value.y = Math.max(0.05, u.uCloudHigh.value.y);
    u.uCloudHigh.value.y = 0.56 + p.cloudCoverage;
    u.uCloudLow.value.y = 0.62 + p.cloudCoverage;
    u.uCloudHigh.value.w = 0.55 * p.cloudDensity;
    u.uCloudLow.value.w = 1.5 * p.cloudDensity;
    u.uCloudTint.value.fromArray(p.cloudTint);

    u.uMwParams.value.x = p.milkyWay;
    this.stars.setBrightness(p.starBrightness);

    // ---- irradiance the rest of the subsystem is driven by -------------------
    this._moonColor.fromArray(p.moonColor);
    this._moonIrradiance.copy(this._moonColor).multiplyScalar(p.moonIntensity);
    // When `sky` yielded the key to `world`, the SHAFTS must match the light
    // that is actually casting the shadows, not the preset's idea of the moon —
    // a shaft four times dimmer than the light that made it reads as a bug. The
    // mood (sky colour, disc colour) stays with the preset either way.
    if (!this._ownsKey && this.keyLight) this._readAdoptedIrradiance();

    // Fog ambient: the sky's average radiance (irradiance / pi) tinted by the
    // mood and scaled down, because the fog in a sealed crypt sees very little
    // of the sky. Until the first IBL generation there is no measured irradiance,
    // so fall back to the preset's own scale.
    this._updateFogAmbient();

    this.fog.setFogParams({
      density: FOG.density * p.fogDensityScale * this.fogDensityScale,
      uniform: FOG.densityUniform * p.fogDensityScale * this.fogDensityScale,
      height: FOG.height,
      baseY: FOG.baseY,
      maxDistance: FOG.maxDistance,
      ambient: this._fogAmbient,
      moonDir: this.moonDirection,
      moonIrradiance: this._shaft.copy(this._moonIrradiance).multiplyScalar(VOLUME.moonShaftBoost),
    });

    this.mist.setSky({
      ambient: this._fogAmbient,
      moonDir: this.moonDirection,
      moonIrradiance: this._moonIrradiance,
      opacity: MIST.opacity * (0.8 + 0.4 * p.fogDensityScale),
    });

    this._applyMoonLight();
  }

  /** Sky ambient in-scatter for the fog and the mist. */
  _updateFogAmbient() {
    const p = this.preset;
    const E = this.ibl?.generations ? this.ibl.skyIrradiance : null;
    if (E) {
      this._fogAmbient.set(E.x, E.y, E.z).multiplyScalar(1 / Math.PI);
    } else {
      // Rough stand-in until the first generation: hemispheric irradiance of a
      // uniform sky of radiance `skyIrradiance * 0.35` is pi times that.
      this._fogAmbient.set(p.skyIrradiance * 0.35, p.skyIrradiance * 0.38, p.skyIrradiance * 0.48);
    }
    this._fogAmbient.multiply(this._tint.fromArray(p.fogTint)).multiplyScalar(FOG.ambientScale);
    // Never exactly zero: fog with no ambient at all is a black wash in every
    // corner a brazier does not reach, which reads as a rendering failure rather
    // than as darkness.
    this._fogAmbient.x = Math.max(this._fogAmbient.x, 3e-4);
    this._fogAmbient.y = Math.max(this._fogAmbient.y, 3.4e-4);
    this._fogAmbient.z = Math.max(this._fogAmbient.z, 5e-4);
  }

  /**
   * Decide whether `sky` owns the key light. See the class docblock.
   * Idempotent, and safe to call before `world` exists.
   */
  _electKeyLight() {
    if (this._elected) return;

    // Only a SHADOW-CASTING foreign directional is a reason to yield. The whole
    // justification for yielding is that a second shadow map is a second full
    // scene render every frame; a fill light that casts nothing costs a shader
    // slot the budget already reserves two of, and adopting one would leave the
    // volumetric march with no shadow map to sample — unoccluded god rays, which
    // is the specific failure this subsystem exists to avoid.
    let foreign = null;
    let bestScore = -1;
    this.ctx.scene.traverse((o) => {
      if (!o.isDirectionalLight || o === this.moonLight) return;
      if (o.userData._mnBallast || !o.castShadow) return;
      if (o.intensity > bestScore) { bestScore = o.intensity; foreign = o; }
    });

    if (foreign) {
      // `world` lit the scene. Adopt its light rather than adding a second one:
      // two shadow-casting directionals is a second full shadow-map render every
      // frame, which is the most expensive thing this subsystem could do to
      // everyone else's capture loop.
      this._ownsKey = false;
      this.keyLight = foreign;
      console.info(
        '[sky] adopting an existing directional light as the key ' +
        `("${foreign.name || 'unnamed'}", intensity ${foreign.intensity.toFixed(2)}). ` +
        'sky.moonLight is null; drive the moon through sky.setTimeOfDay().'
      );
    } else {
      this._ownsKey = true;
      this.keyLight = this.moonLight;
      this.ctx.scene.add(this.moonLight);
      this.ctx.scene.add(this.moonLight.target);
      this.render.addLight(this.moonLight);
      this._applyMoonLight();
    }

    this._shadowLight = this.keyLight?.castShadow ? this.keyLight : null;
    this._elected = true;
  }

  /** Write the ephemeris into the light `sky` owns. No-op when it yielded. */
  _applyMoonLight() {
    if (!this._ownsKey || !this.moonLight) return;
    const p = this.preset;
    this.moonLight.color.setRGB(p.moonColor[0], p.moonColor[1], p.moonColor[2], THREE.LinearSRGBColorSpace);
    this.moonLight.intensity = p.moonIntensity;

    // `render`'s ShadowFitter repositions this light every frame and re-derives
    // its direction from (position - target). To change the DIRECTION we
    // therefore have to move the position relative to wherever the fitter last
    // put the target, not to the origin.
    const t = this.moonLight.target;
    t.updateWorldMatrix(true, false);
    this._targetWorld.setFromMatrixPosition(t.matrixWorld);
    this._v3.copy(this._targetWorld).addScaledVector(this.moonDirection, 90);
    if (this.moonLight.parent) this.moonLight.parent.worldToLocal(this._v3);
    this.moonLight.position.copy(this._v3);
    this.moonLight.updateMatrix();
    this.moonLight.updateMatrixWorld(true);
  }

  /**
   * Keep the moon disc pointing along whatever light is actually casting the
   * shadows. When `sky` yielded, `world`'s light is the source of truth and the
   * visible moon has to follow it — a moon in the sky at odds with the direction
   * the shadows fall is the kind of mistake nobody can name but everybody sees.
   */
  _syncKeyLight() {
    const key = this.keyLight;
    if (!key) return;
    this._shadowLight = key.castShadow ? key : null;
    if (this._ownsKey) return;

    key.updateWorldMatrix(true, false);
    this._lightWorld.setFromMatrixPosition(key.matrixWorld);
    if (key.target) {
      key.target.updateWorldMatrix(true, false);
      this._targetWorld.setFromMatrixPosition(key.target.matrixWorld);
    } else {
      this._targetWorld.set(0, 0, 0);
    }
    this._v3.copy(this._lightWorld).sub(this._targetWorld);
    if (this._v3.lengthSq() < 1e-8) return;
    this._v3.normalize();

    // Only rewrite the uniforms when the direction has actually moved; this runs
    // every frame and `_applyPreset` is not cheap.
    if (this._v3.dot(this.moonDirection) < 0.99995) {
      this.moonDirection.copy(this._v3);
      this._applyPreset();
      return;
    }

    // The adopted light's intensity can be animated by whoever owns it (a
    // flicker, a room transition), so the shaft irradiance is re-read every
    // frame. Six float writes, no allocation, and it is the only thing keeping
    // the shafts locked to the light that casts the shadows.
    this._readAdoptedIrradiance();
    this.fog.setFogParams({
      moonIrradiance: this._shaft.copy(this._moonIrradiance).multiplyScalar(VOLUME.moonShaftBoost),
    });
    this.mist.setSky({ moonIrradiance: this._moonIrradiance });
  }

  /** Colour x intensity of the adopted key light, in the same linear units the
   *  fog's in-scatter integral expects (irradiance on a surface facing it). */
  _readAdoptedIrradiance() {
    const k = this.keyLight;
    if (!k) return;
    this._adopted.set(k.color.r, k.color.g, k.color.b).multiplyScalar(k.intensity);
    this._moonIrradiance.copy(this._adopted);
  }

  /**
   * Find the practicals the fog and the mist scatter from.
   *
   * The scene traversal is on a slow cadence — lights do not appear at frame
   * rate, and a full traverse of a dressed level is real CPU cost that would be
   * paid on top of the renderer's own traverse. The RANKING is per frame,
   * because a brazier's contribution changes as the player walks past it.
   */
  _gatherLights(ctx) {
    const frame = ctx.time.frame;
    if (frame - this._lightScanFrame > 15) {
      this._lightScanFrame = frame;
      this._pointLights.length = 0;
      ctx.scene.traverse(this._visitLight);
    }

    const slots = this._lightSlots;
    let n = 0;
    for (let i = 0; i < this._pointLights.length && n < slots.length; i++) {
      const l = this._pointLights[i];
      if (!l.parent || l.visible === false || l.intensity <= 0) continue;
      if (l.userData._mnBallast) continue;
      const s = slots[n];
      s.pos.setFromMatrixPosition(l.matrixWorld);
      const d2 = s.pos.distanceToSquared(this._focus);
      const cutoff = l.distance ?? 0;
      if (cutoff > 0 && d2 > cutoff * cutoff * 1.44) continue;
      s.rgb.set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity);
      s.cutoff = cutoff;
      s.score = l.intensity / (1 + d2);

      if (l.isSpotLight) {
        // Axis from the light toward its target, in world space. `light.target`
        // is usually a bare Object3D that the scene graph never updates, so its
        // world matrix has to be forced here.
        l.target?.updateWorldMatrix(true, false);
        if (l.target) this._targetWorld.setFromMatrixPosition(l.target.matrixWorld);
        else this._targetWorld.set(s.pos.x, s.pos.y - 1, s.pos.z);
        s._axis.copy(this._targetWorld).sub(s.pos);
        if (s._axis.lengthSq() < 1e-8) s._axis.set(0, -1, 0);
        s._axis.normalize();
        s.axis = s._axis;
        s.cosOuter = Math.cos(Math.min(Math.PI * 0.5 - 1e-3, l.angle ?? 0.6));
      } else {
        s.axis = null;
        s.cosOuter = -2;
      }
      n++;
    }

    // Insertion sort: n is at most 8 and almost always already ordered, so this
    // is a handful of comparisons and no allocation. `Array.sort` would need a
    // comparator closure, which is a per-frame allocation.
    for (let i = 1; i < n; i++) {
      const s = slots[i];
      let j = i - 1;
      while (j >= 0 && slots[j].score < s.score) { slots[j + 1] = slots[j]; j--; }
      slots[j + 1] = s;
    }

    this._activeLights.length = 0;
    for (let i = 0; i < n; i++) this._activeLights.push(slots[i]);

    // A cheap signature of the dominant lighting, used to decide whether the IBL
    // is stale. Quantised hard so a flickering brazier — which changes intensity
    // at 20 Hz and must NOT trigger a 150 ms PMREM — does not move it.
    let sig = 0;
    for (let i = 0; i < Math.min(3, n); i++) {
      const s = slots[i];
      sig = (sig * 31 + Math.round(s.pos.x * 0.5) + Math.round(s.pos.z * 0.5) * 7
        + Math.round(Math.log2(1 + s.rgb.x + s.rgb.y + s.rgb.z) * 2) * 113) | 0;
    }
    if (sig !== this._lightSignature) {
      this._lightSignature = sig;
      this._envDirty = true;
    }
  }

  /** Regenerate the environment map if it is stale, subject to the rate limit. */
  _maybeRegenerateEnv(ctx) {
    if (!this._envDirty) return;
    const now = ctx.time.raw;
    if (!this._envForce && now - this._envAt < IBL.minInterval) return;

    // Local bounce sources, as directions from the focus point. The env map is a
    // distant-lighting approximation, so a light three metres away is entered as
    // the DIRECTION it comes from and the irradiance it delivers here.
    const lights = this._iblList;
    lights.length = 0;
    for (let i = 0; i < Math.min(4, this._activeLights.length); i++) {
      const s = this._activeLights[i];
      const dst = this._iblLights[i];
      dst.dir.copy(s.pos).sub(this._focus);
      const d2 = Math.max(0.25, dst.dir.lengthSq());
      dst.dir.normalize();
      // three's attenuation, so the bounce matches the direct lighting.
      let atten = 1 / Math.max(d2, 0.01);
      if (s.cutoff > 0) {
        const t = Math.max(0, 1 - Math.pow(Math.sqrt(d2) / s.cutoff, 4));
        atten *= t * t;
      }
      dst.rgb.copy(s.rgb).multiplyScalar(atten);
      lights.push(dst);
    }

    const p = this.preset;
    this.ibl.generate({
      skyIrradiance: p.skyIrradiance,
      rayleighTint: p.rayleighTint,
      mieTint: p.mieTint,
      nightFloor: p.nightFloor,
      nightHorizon: p.nightHorizon,
      starBrightness: p.starBrightness,
      lightColor: p.moonColor,
      moonDir: this.moonDirection,
    }, lights);

    ctx.scene.environment = this.ibl.texture;
    ctx.scene.environmentIntensity = IBL.intensity;

    // The fog's ambient is derived from the irradiance the generator measured,
    // so it can only be correct AFTER the first generation.
    this._updateFogAmbient();
    this.fog.setFogParams({ ambient: this._fogAmbient });
    this.mist.setSky({ ambient: this._fogAmbient });

    this._envDirty = false;
    this._envForce = false;
    this._envAt = now;
  }

  // =========================================================================
  // pre-warm
  // =========================================================================

  /**
   * Contract: compile everything this subsystem can produce, without spawning
   * gameplay objects, drawing a gameplay frame, or touching the clock or RNG.
   *
   * `render.prewarmMaterials` runs first (it has no deps) and already drew one
   * frame containing the dome, the stars and the mist, and already ran the
   * registered fog pass — so the forward variants are warm. What is left is:
   *
   *   1. elect the key light, if `world` never emitted `world:ready`;
   *   2. compile PMREM's own shaders and generate the first environment map.
   *      Without this the first `generate()` costs an extra ~300 ms of shader
   *      compilation, and it would land on whichever frame first changed the
   *      time of day — i.e. in the middle of a capture;
   *   3. run the march and the composite once more now that the environment and
   *      the shadow map exist, so the exact variants the game uses are compiled
   *      rather than a null-shadow-map variant that is thrown away.
   */
  async prewarmMaterials(ctx) {
    const t0 = performance.now();

    this._electKeyLight();
    this._syncKeyLight();

    // Rank whatever lights exist so the first environment map has the braziers
    // in it. Uses the camera-ground focus; no clock, no RNG.
    ctx.camera.getWorldDirection(this._v3);
    const t = this._v3.y < -1e-3 ? -ctx.camera.position.y / this._v3.y : 0;
    this._focus.copy(ctx.camera.position).addScaledVector(this._v3, t);
    this._gatherLights(ctx);
    this.fog.setLights(this._activeLights);
    this.mist.setLights(this._activeLights);

    this.ibl.compile();
    this._envDirty = true;
    this._envForce = true;
    this._maybeRegenerateEnv(ctx);

    // Compile the dome / stars / mist against a FLOAT target: `outputColorSpace`
    // and `toneMapping` are part of the program cache key and are read off the
    // currently bound target, so compiling against the canvas warms variants the
    // game never uses. A 4x4 scratch target of our own is used rather than the
    // renderer's HDR buffer, so nothing here depends on `render`'s internals.
    const renderer = this.render.renderer;
    if (!this._warmRT) {
      this._warmRT = new THREE.WebGLRenderTarget(4, 4, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false,
      });
      this._warmRT.texture.colorSpace = THREE.NoColorSpace;
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this._warmRT);
    renderer.compile(this.root, ctx.camera, ctx.scene);
    renderer.setRenderTarget(prev);

    console.info('[sky] prewarm', {
      variant: this.time.variant,
      hours: +this.time.hours.toFixed(2),
      key: this._ownsKey ? 'sky.moon' : (this.keyLight?.name || 'adopted'),
      shadowed: !!this._shadowLight,
      env: `${IBL.width}x${IBL.height} -> pmrem, ${this.ibl.lastMs.toFixed(0)}ms`,
      lights: this._activeLights.length,
      ms: +(performance.now() - t0).toFixed(0),
    });
  }

  // =========================================================================
  // introspection
  // =========================================================================

  stats() {
    const p = this.preset;
    const md = this.moonDirection;
    return {
      time: { hours: +this.time.hours.toFixed(2), variant: this.time.variant },
      moon: {
        dir: [+md.x.toFixed(3), +md.y.toFixed(3), +md.z.toFixed(3)],
        altitudeDeg: +(Math.asin(THREE.MathUtils.clamp(md.y, -1, 1)) * 180 / Math.PI).toFixed(1),
        intensity: +p.moonIntensity.toFixed(3),
        phase: p.moonPhase,
        owned: this._ownsKey,
        key: this.keyLight ? (this.keyLight.name || '(unnamed directional)') : null,
        shadowed: !!this._shadowLight,
      },
      sky: {
        irradiance: +p.skyIrradiance.toFixed(5),
        ambient: [
          +this._fogAmbient.x.toFixed(5),
          +this._fogAmbient.y.toFixed(5),
          +this._fogAmbient.z.toFixed(5),
        ],
        stars: this.stars.geometry.attributes.position.count,
        lutBakeMs: +this.lut.bakeMs.toFixed(1),
      },
      env: {
        generations: this.ibl.generations,
        lastMs: +this.ibl.lastMs.toFixed(1),
        size: `${IBL.width}x${IBL.height}`,
        installed: this.ctx.scene.environment === this.ibl.texture,
        irradiance: [
          +this.ibl.skyIrradiance.x.toFixed(5),
          +this.ibl.skyIrradiance.y.toFixed(5),
          +this.ibl.skyIrradiance.z.toFixed(5),
        ],
      },
      fog: this.fog.stats(),
      mist: {
        opacity: +this.mist.uniforms.uOpacity.value.toFixed(3),
        lights: this.mist.lightSlots,
        pushers: MIST.pushers,
      },
      practicals: this._activeLights.length,
      initMs: +this._initMs.toFixed(1),
      debug: this.debug.mode,
    };
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;

    this.render?.removePass?.(this.pass);
    this.debug?.dispose();

    if (this._ownsKey && this.moonLight) {
      this.render?.removeLight?.(this.moonLight);
      this.moonLight.parent?.remove(this.moonLight);
      this.moonLight.target?.parent?.remove(this.moonLight.target);
      this.moonLight.shadow?.map?.dispose();
      this.moonLight.dispose?.();
    }

    if (this.ctx?.scene?.environment === this.ibl?.texture) this.ctx.scene.environment = null;

    this.fog.dispose();
    this.mist.dispose();
    this.stars.dispose();
    this.dome.dispose();
    this.ibl.dispose();

    this._warmRT?.dispose();
    this._warmRT = null;
    this.cloudNoise.dispose();
    this.fogNoise.dispose();
    this.blueNoise.dispose();
    this.lut.texture.dispose();
    this.lut.transmittance.dispose();

    this.root.parent?.remove(this.root);
  }
}
