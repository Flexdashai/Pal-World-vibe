import * as THREE from 'three';
import { CAMERA } from '../core/config.js';
import { TUNE } from './tuning.js';

/**
 * Shadows for a FIXED isometric camera.
 *
 * The whole design follows from one fact in `config.CAMERA`: yaw and pitch never
 * change. The region of ground the player can see is therefore always the same
 * trapezoid; it only translates. That makes general cascaded shadow maps the
 * wrong tool — cascades exist to handle a camera that can look at the horizon,
 * they cost N scene re-renders, and they bring seams and blend bands with them.
 *
 * Instead there is ONE shadow map, refit every frame to exactly the visible
 * ground, snapped to its own texel grid. At boom 24 / fov 34 that is roughly a
 * 40 m ortho over 1536 texels — about 26 mm per texel, which is denser than a
 * three-cascade rig gives you in its near cascade, for a third of the cost.
 *
 * Three pieces make it not look like a Three.js shadow:
 *
 *  - **Texel snapping.** The shadow origin is quantised to the shadow map's own
 *    texel grid in light space. Without it, the map's sample points slide
 *    sub-texel as the camera follows the player and every shadow edge crawls.
 *  - **Normal-offset bias** scaled by the world size of a texel, which kills
 *    acne without the peter-panning that constant depth bias causes.
 *  - **Contact-hardening PCF (PCSS).** A blocker search estimates how far the
 *    occluder is from the receiver and widens the filter accordingly, so a chain
 *    hanging 5 cm off a wall casts a sharp shadow and a distant arch a soft one.
 *    Uniform-radius PCF cannot do both, and picking one is exactly what makes a
 *    hobby renderer look like a hobby renderer.
 */

/** Poisson-ish disc, generated once by hand from a relaxed dart-throwing pass.
 *  Hardcoded rather than RNG-generated so shaders are byte-identical run to run
 *  (and because ARCHITECTURE.md forbids Math.random anywhere). */
const DISC16 = [
  [-0.6135, 0.3162], [0.3181, 0.5876], [0.6934, -0.1497], [-0.1962, -0.7365],
  [-0.9151, -0.2168], [0.1289, 0.9285], [0.8722, 0.4130], [-0.4483, -0.2716],
  [0.4025, -0.6417], [-0.2438, 0.1206], [0.0621, -0.2033], [0.5768, 0.1442],
  [-0.6941, 0.7018], [0.9575, -0.2662], [-0.0329, 0.4712], [-0.4126, -0.8846],
];

function discGlsl(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = DISC16[i % DISC16.length];
    items.push(`vec2(${x.toFixed(4)},${y.toFixed(4)})`);
  }
  return `const vec2 MN_DISC[${n}] = vec2[${n}](${items.join(',')});`;
}

/**
 * Build the replacement `getShadow()`.
 *
 * This is installed as a global `THREE.ShaderChunk` override rather than a
 * per-material patch on purpose: shadow filtering is a property of the renderer,
 * not of any one material, and every lit material in the game — including ones
 * other agents create at runtime — has to agree on it. The override runs in
 * `RenderSystem.init()`, which the registry guarantees happens before any other
 * subsystem compiles anything.
 */
function buildShadowChunk() {
  const s = TUNE.shadow;
  const nBlocker = s.blockerSamples;
  const nPcf = s.pcfSamples;
  const nDisc = Math.max(nBlocker, nPcf);

  return /* glsl */ `
	${discGlsl(nDisc)}

	vec2 mnRotate2( vec2 v, vec2 r ) {
		return vec2( v.x * r.x - v.y * r.y, v.x * r.y + v.y * r.x );
	}

	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

		float shadow = 1.0;

		shadowCoord.xyz /= shadowCoord.w;
		shadowCoord.z += shadowBias;

		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		bool frustumTest = inFrustum && shadowCoord.z <= 1.0;

		if ( frustumTest ) {

			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;

			// Per-pixel kernel rotation. A fixed sample pattern turns into a
			// visible repeating lace along every penumbra; rotating it converts
			// that structured artefact into noise, which TAA then resolves away.
			float mnAng = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
			vec2 mnRot = vec2( cos( mnAng ), sin( mnAng ) );

			// ---- blocker search -------------------------------------------------
			// Average depth of everything between this receiver and the light.
			float blockerSum = 0.0;
			float blockerCount = 0.0;

			for ( int i = 0; i < ${nBlocker}; i ++ ) {

				vec2 o = mnRotate2( MN_DISC[ i ], mnRot ) * ${s.blockerRadius.toFixed(2)} * texelSize;
				float d = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + o ) );

				#ifdef USE_REVERSED_DEPTH_BUFFER
					if ( d > shadowCoord.z ) { blockerSum += d; blockerCount += 1.0; }
				#else
					if ( d < shadowCoord.z ) { blockerSum += d; blockerCount += 1.0; }
				#endif

			}

			// ---- penumbra estimate ----------------------------------------------
			float penumbra = ${s.minPenumbra.toFixed(3)};

			if ( blockerCount > 0.0 ) {

				// Similar triangles. The receiver-to-blocker gap drives the
				// filter width; a contact point has gap ~0 and collapses to the
				// minimum, which is the whole point of the pass.
				//
				// 'shadowRadius' is NOT three's blur radius here: ShadowFitter
				// writes the metres-of-gap -> texels-of-penumbra conversion into
				// it every frame, derived from the ortho depth range it actually
				// fitted. That is what keeps the softening rate physical when the
				// map size or the covered region changes.
				float avgBlocker = blockerSum / blockerCount;
				float gap = abs( shadowCoord.z - avgBlocker );
				penumbra = clamp( gap * shadowMapSize.x * shadowRadius,
				                  ${s.minPenumbra.toFixed(3)}, ${s.maxPenumbra.toFixed(3)} );

			}

			// ---- filtered comparison --------------------------------------------
			float sum = 0.0;

			for ( int i = 0; i < ${nPcf}; i ++ ) {

				vec2 o = mnRotate2( MN_DISC[ i ], mnRot ) * penumbra * texelSize;
				sum += texture2DCompare( shadowMap, shadowCoord.xy + o, shadowCoord.z );

			}

			shadow = sum * ${(1 / nPcf).toFixed(8)};

			// The fitted map covers only the visible ground. Without this ramp its
			// boundary is a hard line of "everything beyond here is lit" straight
			// across the floor, which is far more obvious than a missing shadow.
			vec2 mnEdge = abs( shadowCoord.xy - 0.5 ) * 2.0;
			shadow = mix( 1.0, shadow, 1.0 - smoothstep( 0.90, 1.0, max( mnEdge.x, mnEdge.y ) ) );

		}

		return mix( 1.0, shadow, shadowIntensity );

	}

`;
}

/** Swap our `getShadow` into three's shadow chunk. Idempotent. */
export function installShadowChunk() {
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (src.includes('MN_DISC')) return true;

  // The published three build strips comments out of its shader chunks, so the
  // end marker has to be the next real declaration rather than the `cubeToUV`
  // comment block that follows `getShadow` in the source tree.
  const start = src.indexOf('float getShadow( sampler2D shadowMap');
  const end = src.indexOf('vec2 cubeToUV(');
  if (start < 0 || end < 0 || end < start) {
    // A three upgrade moved the markers. Fail loudly in the console but keep the
    // stock filter so the game still boots — a soft shadow regression is
    // survivable, a boot failure blocks every other agent.
    console.warn('[render] shadow chunk markers not found; falling back to stock PCF');
    return false;
  }

  THREE.ShaderChunk.shadowmap_pars_fragment = src.slice(0, start) + buildShadowChunk() + src.slice(end);
  return true;
}

/**
 * Per-frame tight fit of the directional shadow(s) to the visible ground.
 */
export class ShadowFitter {
  constructor(config) {
    this.config = config;
    // Never exceed the budget, and deliberately spend less than it: the fit
    // below is so tight that 1536 texels over a ~40 m ortho is ~26 mm per texel,
    // which is already finer than a 720p frame can resolve at this camera
    // distance. Every doubling past that is pure depth-only fill on a CPU
    // rasteriser, paid on every frame of every other agent's capture loop.
    this.mapSize = Math.min(config.q.shadowMapSize, 1536);
    this.lights = [];
    this.radius = 0;
    this.texelWorld = 0;

    // Preallocated scratch — this runs every frame.
    this._fwd = new THREE.Vector3();
    this._lightDir = new THREE.Vector3();
    this._centre = new THREE.Vector3();
    this._camGround = new THREE.Vector3();
    this._groundFwd = new THREE.Vector3();
    this._xAxis = new THREE.Vector3();
    this._yAxis = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();
    this._lightWorld = new THREE.Vector3();
    this._targetWorld = new THREE.Vector3();
    this._warned = false;
  }

  /** Called by `_collect` for every directional light found in the scene. */
  register(light) {
    if (!light.castShadow) return;
    if (this.lights.includes(light)) return;

    this.lights.push(light);
    if (this.lights.length > 1 && !this._warned) {
      this._warned = true;
      console.warn(
        '[render] more than one shadow-casting directional light; each one is a ' +
        'full extra scene render into a shadow map. Prefer one key + unshadowed fills.'
      );
    }

    const sh = light.shadow;
    if (sh.mapSize.x !== this.mapSize || sh.mapSize.y !== this.mapSize) {
      sh.mapSize.set(this.mapSize, this.mapSize);
      // Changing mapSize after the map exists needs the target dropped, or three
      // keeps rendering into the old one at the old resolution.
      if (sh.map) { sh.map.dispose(); sh.map = null; }
    }
    sh.bias = TUNE.shadow.bias;
    sh.intensity = 1.0;
    // `sh.radius` is repurposed as the PCSS gap->penumbra conversion and is
    // written every frame by `_fit()`; see the note in the shader chunk.
    sh.autoUpdate = true;
    // The default target is a bare Object3D that is not in the scene, so
    // `scene.updateMatrixWorld()` never touches it. We drive it by hand below.
    if (!light.target) light.target = new THREE.Object3D();
  }

  forget(light) {
    const i = this.lights.indexOf(light);
    if (i >= 0) this.lights.splice(i, 1);
  }

  /**
   * Recompute the covered region from the live camera and refit every
   * registered light. Runs before `renderer.render()` so three picks up the new
   * matrices when it renders the shadow map.
   */
  update(camera) {
    if (!this.lights.length) return;

    camera.getWorldDirection(this._fwd);

    // --- analytic extent of the visible ground -------------------------------
    // The camera is above the ground looking down at a fixed angle, so the near
    // and far ground intersections of the frustum are a closed form. Deriving
    // them (rather than hardcoding a radius) means the fit stays tight when a
    // shot pushes the boom to 26 or widens the fov to 36.
    const h = Math.max(1.0, camera.position.y);
    const el = Math.max(0.05, Math.asin(Math.min(1, Math.max(-1, -this._fwd.y))));
    const halfV = THREE.MathUtils.degToRad(camera.fov) * 0.5;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);

    const elNear = Math.min(Math.PI * 0.5 - 1e-3, el + halfV);
    const elFar = Math.max(0.08, el - halfV);
    const dNear = h / Math.tan(elNear);
    const maxDist = this.config.q.shadowDistance;
    const dFar = Math.min(maxDist, h / Math.tan(elFar));

    const depthSpan = Math.max(4, dFar - dNear);
    const slantFar = Math.sqrt(dFar * dFar + h * h);
    const widthFar = Math.min(maxDist * 1.6, 2 * slantFar * Math.tan(halfH));

    // Bounding circle of the covered rectangle. A circle (not a light-space
    // AABB) is what makes the fit rotation-invariant: if `sky` swings the moon
    // across the night, an AABB fit would change size every frame and the texel
    // grid would slide, undoing the snap.
    let radius = 0.5 * Math.sqrt(depthSpan * depthSpan + widthFar * widthFar);
    // Quantise so a 1 cm camera drift cannot change the ortho size at all.
    radius = Math.max(9, Math.ceil(radius / 2) * 2);
    this.radius = radius;

    const centreDist = (dNear + dFar) * 0.5;
    this._camGround.set(camera.position.x, 0, camera.position.z);
    this._groundFwd.set(this._fwd.x, 0, this._fwd.z);
    if (this._groundFwd.lengthSq() < 1e-8) this._groundFwd.set(0, 0, -1);
    this._groundFwd.normalize();

    const texel = (2 * radius) / this.mapSize;
    this.texelWorld = texel;

    for (const light of this.lights) {
      this._fit(light, centreDist, radius, texel);
    }
  }

  _fit(light, centreDist, radius, texel) {
    // Direction from the covered region TOWARD the light, in world space.
    // Re-derived from the light's own transform every frame so that if `sky`
    // animates the moon we follow it, but taken from the cached value if we were
    // the last one to write the position (which is every frame after the first).
    const ud = light.userData;
    light.updateWorldMatrix(true, false);
    this._lightWorld.setFromMatrixPosition(light.matrixWorld);
    light.target.updateWorldMatrix(true, false);
    this._targetWorld.setFromMatrixPosition(light.target.matrixWorld);

    const moved = !ud._mnLastEye || this._lightWorld.distanceToSquared(ud._mnLastEye) > 1e-6;
    if (moved || !ud._mnDir) {
      const d = this._lightDir.copy(this._lightWorld).sub(this._targetWorld);
      if (d.lengthSq() < 1e-8) d.set(-0.45, 0.8, -0.35);
      d.normalize();
      ud._mnDir = (ud._mnDir ?? new THREE.Vector3()).copy(d);
    }
    this._lightDir.copy(ud._mnDir);

    // Region centre on the ground, biased slightly beyond the focus point:
    // at a 52 degree pitch there is more visible ground past the player than in
    // front of them, so a centre exactly at the focus wastes a third of the map.
    this._centre.copy(this._camGround).addScaledVector(this._groundFwd, centreDist);

    // --- texel snap in light space -------------------------------------------
    this._xAxis.crossVectors(this._up, this._lightDir);
    if (this._xAxis.lengthSq() < 1e-6) this._xAxis.set(1, 0, 0);   // light straight overhead
    this._xAxis.normalize();
    this._yAxis.crossVectors(this._lightDir, this._xAxis).normalize();

    const cx = this._centre.dot(this._xAxis);
    const cy = this._centre.dot(this._yAxis);
    const dx = Math.round(cx / texel) * texel - cx;
    const dy = Math.round(cy / texel) * texel - cy;
    this._centre.addScaledVector(this._xAxis, dx).addScaledVector(this._yAxis, dy);

    // --- write the light rig --------------------------------------------------
    const pad = TUNE.shadow.depthPad;
    this._tmp.copy(this._centre).addScaledVector(this._lightDir, pad);

    // `position` is parent-local; converting keeps us correct if the light was
    // parented into a group by `world` or `sky`.
    if (light.parent) light.parent.worldToLocal(this._tmp);
    light.position.copy(this._tmp);
    light.updateMatrix();
    light.updateWorldMatrix(false, false);
    ud._mnLastEye = (ud._mnLastEye ?? new THREE.Vector3()).setFromMatrixPosition(light.matrixWorld);

    this._tmp.copy(this._centre);
    if (light.target.parent) light.target.parent.worldToLocal(this._tmp);
    light.target.position.copy(this._tmp);
    light.target.updateMatrixWorld(true);

    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 0.5;
    cam.far = pad + radius + 24;
    cam.updateProjectionMatrix();

    // Metres of occluder gap -> texels of penumbra, for the PCSS filter. One
    // unit of shadow-map depth spans (far - near) metres, so the conversion has
    // to be recomputed whenever the fit changes — which is every frame.
    const depthRange = cam.far - cam.near;
    light.shadow.radius = (TUNE.shadow.penumbraTexelsPerMetre * depthRange) / this.mapSize;

    // Normal-offset bias in WORLD units, tied to the texel footprint. This is
    // the term that actually removes acne; the constant depth bias stays tiny so
    // contact points do not detach.
    light.shadow.normalBias = texel * TUNE.shadow.normalBiasTexels;
  }

  stats() {
    return {
      lights: this.lights.length,
      mapSize: this.mapSize,
      radius: +this.radius.toFixed(1),
      texelMm: +(this.texelWorld * 1000).toFixed(1),
    };
  }
}

/** The camera constants this module is built around, re-exported so a reader can
 *  see at a glance what "fixed" means without opening config.js. */
export const FIXED_CAMERA = CAMERA;
