import * as THREE from 'three';
import { NOISE_GLSL } from './noise.glsl.js';
import { PATTERNS_GLSL } from './patterns.glsl.js';
import { PALETTE_GLSL, SURFACE_BY_ID } from './surfaces.js';

/**
 * MONARCH — the GPU procedural texture forge.
 *
 * There are no image files in this game and there never will be. Every texel of
 * every surface is produced here, by a fragment shader, into a render target, at
 * load time.
 *
 * ---------------------------------------------------------------------------
 * TWO PASSES, AND WHY
 *
 *   FIELD    evaluates the surface recipe once per texel. This is where all the
 *            expensive noise lives — typically 300-800 ALU per texel — so it must
 *            run exactly once. Writes to a HALF-FLOAT MRT because the derived
 *            normal is a *derivative* of the height channel, and an 8-bit height
 *            quantises to 1/255, which Sobel amplifies into visible terracing
 *            across every gently sloping surface.
 *
 *   RESOLVE  reads the field and derives everything that is a spatial operator
 *            on it: the tangent-space normal (3x3 Sobel), ambient occlusion
 *            (horizon search over 8 directions), and cavity (one-texel
 *            occlusion). Packs the result into three 8-bit textures.
 *
 * Splitting them means the noise is evaluated once and the ~26 neighbourhood
 * taps read a cached texture instead of re-running the recipe 26 times. On a CPU
 * rasteriser that is the difference between a 6-second boot and a 3-minute one.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT LAYOUT — the contract with pbr.js
 *
 *   albedo   SRGB8_ALPHA8   rgb = linear reflectance (hardware-encoded on write,
 *                                 hardware-decoded on sample: no shader cost and
 *                                 no banding in the 0.02-0.15 range where this
 *                                 game's entire stone palette lives)
 *                             a = opacity mask, OR the emissive mask for
 *                                 surfaces that declare `emissive` — no surface
 *                                 needs both, and a fourth texture would cost
 *                                 33% more VRAM for one channel
 *   normal   RGBA8            rgb = tangent-space normal, a = height
 *                                 (height lives here so the parallax march and
 *                                 the normal fetch hit the same cache line)
 *   orm      RGBA8            r = AO, g = roughness, b = metalness, a = cavity
 *                                 (glTF ORM order on purpose: three's own
 *                                 aoMap/roughnessMap/metalnessMap chunks read
 *                                 exactly .r/.g/.b, so the fallback path works
 *                                 with no patching at all)
 *
 * Three RGBA8 textures per surface. At 512x512 that is 3 MB + 33% mip chain per
 * surface; the whole catalogue at its assigned tiers is under 40 MB.
 */

/** Bumped when the packing or the derivation changes, so a stale cached set is
 *  never silently reused across a hot reload. */
export const FORGE_VERSION = 4;

// ---------------------------------------------------------------------------
// shared shader source
// ---------------------------------------------------------------------------

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Declarations every field shader gets: the field struct, the palette, the
 *  noise library and the pattern library, in dependency order. */
function fieldPrelude() {
  return `
precision highp float;

struct MnField {
	vec3 albedo;
	float height;
	float rough;
	float metal;
	float alpha;
	float emissiveMask;
};

${PALETTE_GLSL()}
${NOISE_GLSL}
${PATTERNS_GLSL}
`;
}

const FIELD_FRAG_TAIL = /* glsl */ `

varying vec2 vUv;

layout(location = 0) out vec4 gAlbedoHeight;
layout(location = 1) out vec4 gParams;

void main() {
	MnField f;
	// Defaults, so a recipe only has to write what it cares about.
	f.albedo = vec3( 0.5 );
	f.height = 0.5;
	f.rough = 0.85;
	f.metal = 0.0;
	f.alpha = 1.0;
	f.emissiveMask = 0.0;

	mnSurface( vUv, f );

	gAlbedoHeight = vec4( max( f.albedo, vec3( 0.0 ) ), clamp( f.height, 0.0, 1.0 ) );
	gParams = vec4(
		clamp( f.rough, 0.015, 1.0 ),
		clamp( f.metal, 0.0, 1.0 ),
		clamp( f.alpha, 0.0, 1.0 ),
		clamp( f.emissiveMask, 0.0, 1.0 )
	);
}
`;

/**
 * The resolve pass.
 *
 * NORMAL: a 3x3 Sobel rather than a 2-tap central difference. Central
 * differences on a height field that contains hard steps (a mortar joint is a
 * step) alias badly — every joint becomes a one-texel line of near-horizontal
 * normals that flickers under mip filtering. The Sobel kernel is a low-pass and
 * a derivative at once, which is exactly what is wanted.
 *
 * AO: a horizon search. For each of 8 directions the maximum elevation angle to
 * the height field is found over three radii, and the visible fraction of the
 * hemisphere is accumulated. This is genuinely different from "1 - blurred
 * height": it darkens the *inside* of a narrow joint far more than the shallow
 * dish in the middle of a slab, which is the whole reason baked AO is worth
 * having on top of the screen-space AO the render pipeline already provides.
 *
 * CAVITY: single-texel occlusion, i.e. the high-frequency remainder that both
 * baked AO and screen-space AO are too coarse to see. It is applied to DIRECT
 * light in pbr.js, where nothing else in the lighting model can darken a
 * one-millimetre crevice.
 */
const RESOLVE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D mnField0;      // rgb albedo, a height
uniform sampler2D mnField1;      // r rough, g metal, b alpha, a emissive mask
uniform vec2 mnTexel;            // 1 / size
uniform vec4 mnParams;           // x = normal strength, y = AO strength,
                                 // z = AO radius in texels, w = cavity strength
uniform float mnAlphaIsEmissive; // 1 = pack the emissive mask into albedo.a

varying vec2 vUv;

layout(location = 0) out vec4 gAlbedo;
layout(location = 1) out vec4 gNormalHeight;
layout(location = 2) out vec4 gOrm;

float H( vec2 uv ) { return texture( mnField0, uv ).a; }

void main() {
	vec4 f0 = texture( mnField0, vUv );
	vec4 f1 = texture( mnField1, vUv );
	float h = f0.a;

	vec2 t = mnTexel;

	// ---- 3x3 Sobel ------------------------------------------------------
	float h00 = H( vUv + vec2( -t.x, -t.y ) );
	float h10 = H( vUv + vec2(  0.0, -t.y ) );
	float h20 = H( vUv + vec2(  t.x, -t.y ) );
	float h01 = H( vUv + vec2( -t.x,  0.0 ) );
	float h21 = H( vUv + vec2(  t.x,  0.0 ) );
	float h02 = H( vUv + vec2( -t.x,  t.y ) );
	float h12 = H( vUv + vec2(  0.0,  t.y ) );
	float h22 = H( vUv + vec2(  t.x,  t.y ) );

	float gx = ( h00 + 2.0 * h01 + h02 ) - ( h20 + 2.0 * h21 + h22 );
	float gy = ( h00 + 2.0 * h10 + h20 ) - ( h02 + 2.0 * h12 + h22 );

	// The 1/8 normalises the Sobel kernel; mnParams.x converts height units to
	// texel units so the slope is physically meaningful.
	vec3 n = normalize( vec3( gx * 0.125 * mnParams.x, gy * 0.125 * mnParams.x, 1.0 ) );

	// ---- horizon-search AO ----------------------------------------------
	// 8 directions x 2 radii = 16 taps. Three radii is visibly better on a GPU
	// and costs 50% more here for a difference that does not survive the tone
	// curve; the near radius finds the joint the texel is sitting in and the far
	// one finds the shadow of the neighbouring block, which is the whole effect.
	float ao = 0.0;
	const int DIRS = 8;
	for ( int d = 0; d < DIRS; d ++ ) {
		float a = ( float( d ) + 0.5 ) * ( 6.2831853 / float( DIRS ) );
		vec2 dir = vec2( cos( a ), sin( a ) );
		float maxSlope = 0.0;
		for ( int s = 0; s < 2; s ++ ) {
			float r = mnParams.z * ( s == 0 ? 1.0 : 3.0 );
			float hs = H( vUv + dir * t * r );
			// Slope in "height units per texel", scaled to world proportions by
			// the same factor the normal uses.
			maxSlope = max( maxSlope, ( hs - h ) * mnParams.x / r );
		}
		// sin(horizon angle) is the occluded fraction of that direction's arc.
		float occ = maxSlope / sqrt( 1.0 + maxSlope * maxSlope );
		ao += 1.0 - max( occ, 0.0 );
	}
	ao /= float( DIRS );
	ao = clamp( mix( 1.0, ao, mnParams.y ), 0.0, 1.0 );

	// ---- cavity ----------------------------------------------------------
	float blur = ( h00 + h10 + h20 + h01 + h21 + h02 + h12 + h22 ) * 0.125;
	float cav = clamp( 1.0 - ( blur - h ) * mnParams.w, 0.0, 1.0 );

	gAlbedo = vec4( f0.rgb, mix( f1.b, f1.a, mnAlphaIsEmissive ) );
	gNormalHeight = vec4( n * 0.5 + 0.5, h );
	gOrm = vec4( ao, f1.r, f1.g, cav );
}
`;

/**
 * The shared detail texture.
 *
 * ONE 256x256 texture, sampled by every material at two very different
 * frequencies, doing two jobs that between them are most of what stops this
 * looking procedural:
 *
 *   at high frequency  a micro-normal and a micro-value break-up that keeps a
 *                      surface alive at the 'detail' shot's 9.5 m boom, well
 *                      below the base texture's texel size
 *   at low frequency   the macro variation that destroys tiling. A texture that
 *                      repeats every 1.75 m repeats eleven times across the
 *                      frame; modulating its value and hue with a field whose
 *                      period is ~7 m is what makes the repetition invisible to
 *                      both the eye and to `analyze.mjs --tile`.
 *
 * rg = micro normal xy, b = value variation, a = an uncorrelated mask field for
 * moss/blood/soot patchiness.
 */
const DETAIL_FRAG = /* glsl */ `
precision highp float;
${NOISE_GLSL}

varying vec2 vUv;
layout(location = 0) out vec4 gDetail;

float mnDetailHeight( vec2 uv ) {
	// Three uncorrelated grain populations. The Worley term is what gives the
	// micro-normal an actual granular structure instead of a soft cloud.
	float a = mnFbm( uv * 24.0, vec2( 24.0 ), 4, 0.55 );
	vec4 w = mnWorley( uv * 40.0, vec2( 40.0 ), 1.0 );
	float b = smoothstep( 0.0, 0.42, w.x );
	float c = mnFbm( uv * 96.0, vec2( 96.0 ), 2, 0.5 );
	return a * 0.45 + b * 0.35 + c * 0.20;
}

void main() {
	vec2 t = vec2( 1.0 / 256.0 );
	float h = mnDetailHeight( vUv );
	float hx = mnDetailHeight( vUv + vec2( t.x, 0.0 ) );
	float hy = mnDetailHeight( vUv + vec2( 0.0, t.y ) );

	// Strength 7 is tuned so the micro-normal is clearly present in a 2x centre
	// crop but never overwhelms the surface's own normal at 1x. The encoding
	// below turns the gradient into the xy of a unit normal, so this number is a
	// slope, not an amplitude, and it saturates rather than clipping.
	vec2 n = vec2( -( hx - h ), -( hy - h ) ) * 7.0 * 256.0 / 24.0;
	n = n / sqrt( 1.0 + dot( n, n ) );

	float value = mnFbm( vUv * 12.0 + 3.0, vec2( 12.0 ), 4, 0.55 );
	// The mask field is deliberately blobby and low-frequency: patchiness, not
	// noise, is what makes moss and blood read as things that happened rather
	// than as a filter.
	float mask = mnBillow( mnWarp( vUv * 5.0 + 11.0, vec2( 5.0 ), 0.5, 2 ), vec2( 5.0 ), 4, 0.6 );

	gDetail = vec4( n * 0.5 + 0.5, value, mask );
}
`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function outputTarget(size, anisotropy) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    anisotropy,
    count: 3,
  });
  // Per-attachment colour space. three picks the GL internal format per texture
  // (see WebGLTextures.setupFrameBufferTexture), so attachment 0 becomes
  // SRGB8_ALPHA8 and gets hardware encode-on-write / decode-on-sample, while the
  // data channels stay strictly linear RGBA8. Setting this AFTER the target is
  // first bound would be too late — the format is chosen at setup.
  rt.textures[0].colorSpace = THREE.SRGBColorSpace;
  rt.textures[1].colorSpace = THREE.NoColorSpace;
  rt.textures[2].colorSpace = THREE.NoColorSpace;
  for (const t of rt.textures) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy;
  }
  return rt;
}

function fieldTarget(size) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    // Half float: the height channel is differentiated by the resolve pass and
    // 8-bit quantisation would terrace every slope in the game.
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    // NEAREST, deliberately. The resolve pass takes 24 neighbourhood samples per
    // texel and every one of them wants a specific texel, not a blend of four:
    // the Sobel offsets are exact texel steps, and the AO horizon search is
    // sampling a height field where a bilinear blur would only soften the joints
    // it exists to find. On a software rasteriser a bilinear fetch is roughly
    // three times the cost of a point fetch, so this is also the single largest
    // saving in the whole bake.
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    // Repeat wrapping is what makes the resolve pass's neighbourhood taps
    // seamless across the tile boundary: a Sobel or an AO search that clamps at
    // the edge bakes a bright rim into every texture, and that rim IS the seam.
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count: 2,
  });
  for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;
  return rt;
}

// ---------------------------------------------------------------------------
// TextureForge
// ---------------------------------------------------------------------------

export class TextureForge {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} q  the active quality preset (config.q)
   */
  constructor(renderer, q) {
    this.renderer = renderer;
    this.q = q;

    // Fullscreen triangle, shared by every pass. One geometry upload, ever.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this._geo = g;
    this._quad = new THREE.Mesh(g, null);
    this._quad.frustumCulled = false;
    this._quad.matrixAutoUpdate = false;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    /** surface id -> { albedo, normal, orm, size, target } */
    this.sets = new Map();
    /** surface id -> field-pass ShaderMaterial (kept: a re-bake at another size
     *  must not recompile the recipe, which is the expensive part). */
    this._fieldMats = new Map();
    /** size -> scratch field target, shared by every surface of that size. */
    this._fieldTargets = new Map();

    this._resolveMat = new THREE.ShaderMaterial({
      name: 'mn.forge.resolve',
      glslVersion: THREE.GLSL3,
      uniforms: {
        mnField0: { value: null },
        mnField1: { value: null },
        mnTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        mnParams: { value: new THREE.Vector4(10, 1, 1.5, 6) },
        mnAlphaIsEmissive: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: RESOLVE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.detail = null;
    this._detailRT = null;

    this.stats = {
      textures: 0,
      surfaces: 0,
      bakeMs: 0,
      lastBakeMs: 0,
      bytes: 0,
      pixels: 0,
    };
  }

  // -------------------------------------------------------------------------
  // sizing
  // -------------------------------------------------------------------------

  /**
   * Bake resolution for a surface tier.
   *
   * `config.q.textureSize` is the ceiling; each tier steps down from it. A crypt
   * has three surfaces the player looks at for hours and twenty they walk past,
   * and spending the same texel budget on both is how a load screen becomes a
   * minute long — which on this software rasteriser it genuinely would.
   *
   * The per-tier CAPS are a second, independent limit, and they are the reason
   * `ultra` does not simply bake everything at 1024:
   *
   *   The tightest shot in the review set ('detail') is a 9.5 m boom at 30 deg
   *   FOV, which puts about 116 screen pixels on a world metre. The floor tiles
   *   every 1.75 m, so 512 texels across that repeat is 293 texels/m — already
   *   2.5x the screen's sampling rate. Every texel above that is invisible, and
   *   on a CPU rasteriser it is not free: it costs bake time quadratically and
   *   it costs cache misses in the lit pass, which is the most expensive pass in
   *   the frame. Sub-texel detail is supplied by the shared detail layer and by
   *   parallax instead, where it costs a fetch rather than 12 MB.
   */
  sizeFor(tier) {
    const base = this.q.textureSize || 512;
    const req = tier === 'hero' ? base : tier === 'main' ? base / 2 : base / 4;
    const cap = tier === 'hero' ? 512 : tier === 'main' ? 256 : 128;
    return Math.max(128, Math.min(cap, Math.round(req)));
  }

  // -------------------------------------------------------------------------
  // baking
  // -------------------------------------------------------------------------

  _fieldMaterial(surface) {
    let m = this._fieldMats.get(surface.id);
    if (m) return m;

    m = new THREE.ShaderMaterial({
      name: `mn.forge.field(${surface.id})`,
      glslVersion: THREE.GLSL3,
      uniforms: {},
      vertexShader: QUAD_VERT,
      fragmentShader: `${fieldPrelude()}
void mnSurface( vec2 uv, inout MnField f ) {
${surface.glsl}
}
${FIELD_FRAG_TAIL}`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this._fieldMats.set(surface.id, m);
    return m;
  }

  _fieldTargetFor(size) {
    let rt = this._fieldTargets.get(size);
    if (!rt) {
      rt = fieldTarget(size);
      this._fieldTargets.set(size, rt);
    }
    return rt;
  }

  _draw(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quad, this._cam);
  }

  /**
   * Bake (or return the cached bake of) one surface.
   * @param {string} id  a key of SURFACE_BY_ID
   * @returns {{ albedo:THREE.Texture, normal:THREE.Texture, orm:THREE.Texture,
   *            size:number, surface:object }}
   */
  bake(id) {
    const cached = this.sets.get(id);
    if (cached) return cached;

    const surface = SURFACE_BY_ID.get(id);
    if (!surface) throw new Error(`[materials] unknown surface "${id}"`);

    const t0 = performance.now();
    const size = this.sizeFor(surface.tier);
    const prevTarget = this.renderer.getRenderTarget();

    // ---- pass 1: the field ------------------------------------------------
    const field = this._fieldTargetFor(size);
    this._draw(this._fieldMaterial(surface), field);

    // ---- pass 2: resolve --------------------------------------------------
    const out = outputTarget(size, this.q.anisotropy || 4);
    out.textures[0].name = `mn.${id}.albedo`;
    out.textures[1].name = `mn.${id}.normalHeight`;
    out.textures[2].name = `mn.${id}.orm`;

    const u = this._resolveMat.uniforms;
    u.mnField0.value = field.textures[0];
    u.mnField1.value = field.textures[1];
    u.mnTexel.value.set(1 / size, 1 / size);

    // Height -> texel slope conversion. `heightScale` is the peak-to-trough
    // relief in metres and `tile` the world size of one repeat, so one unit of
    // height spans (heightScale / (tile / size)) texels of run.
    //
    // The cap matters: a mortar joint is a genuine vertical step, and an
    // uncapped slope there produces a normal lying flat in the tangent plane,
    // which shades to black and aliases into a crawling line under mip
    // filtering. 14 is where a 45-degree-plus wall still reads as a wall.
    const physical = (surface.heightScale * size) / surface.tile;
    const strength = Math.min(14, physical);
    u.mnParams.value.set(
      strength,
      surface.aoStrength ?? 1.0,
      // AO search radius in texels, scaled with resolution so the world-space
      // radius is constant across tiers.
      Math.max(1.0, size / 340),
      surface.cavityStrength ?? 5.0
    );
    u.mnAlphaIsEmissive.value = surface.emissive ? 1 : 0;

    this._draw(this._resolveMat, out);
    this.renderer.setRenderTarget(prevTarget);

    const set = {
      id,
      surface,
      size,
      target: out,
      albedo: out.textures[0],
      normal: out.textures[1],
      orm: out.textures[2],
      normalStrength: strength,
    };
    this.sets.set(id, set);

    const ms = performance.now() - t0;
    this.stats.surfaces++;
    this.stats.textures += 3;
    this.stats.bakeMs += ms;
    this.stats.lastBakeMs = ms;
    this.stats.pixels += size * size * 3;
    // 4 bytes per texel per texture, plus the 1/3 mip tail.
    this.stats.bytes += size * size * 4 * 3 * 1.3333;
    return set;
  }

  /** Build the shared detail/variation texture. Idempotent. */
  bakeDetail() {
    if (this.detail) return this.detail;

    const size = 256;
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
      anisotropy: this.q.anisotropy || 4,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.name = 'mn.detail';

    const mat = new THREE.ShaderMaterial({
      name: 'mn.forge.detail',
      glslVersion: THREE.GLSL3,
      uniforms: {},
      vertexShader: QUAD_VERT,
      fragmentShader: DETAIL_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const t0 = performance.now();
    const prev = this.renderer.getRenderTarget();
    this._draw(mat, rt);
    this.renderer.setRenderTarget(prev);
    mat.dispose();

    this._detailRT = rt;
    this.detail = rt.texture;
    this.stats.textures++;
    this.stats.bakeMs += performance.now() - t0;
    this.stats.bytes += size * size * 4 * 1.3333;
    return this.detail;
  }

  /** True if `id` has already been baked. */
  has(id) { return this.sets.has(id); }

  vramMB() { return +(this.stats.bytes / (1024 * 1024)).toFixed(2); }

  dispose() {
    for (const set of this.sets.values()) set.target.dispose();
    this.sets.clear();
    for (const rt of this._fieldTargets.values()) rt.dispose();
    this._fieldTargets.clear();
    for (const m of this._fieldMats.values()) m.dispose();
    this._fieldMats.clear();
    this._resolveMat.dispose();
    this._detailRT?.dispose();
    this._detailRT = null;
    this.detail = null;
    this._geo.dispose();
    this._quad.material = null;
  }
}
