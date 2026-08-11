import * as THREE from 'three';

/**
 * MONARCH — the shading side of the material system.
 *
 * `forge.js` produces the textures; this turns them into a lit material. It is a
 * stock `THREE.MeshStandardMaterial` with an `onBeforeCompile` that takes over
 * every map fetch and adds the five things that separate a Diablo IV surface
 * from a textured plane:
 *
 *  1. PARALLAX OCCLUSION MAPPING. At this camera the floor is most of the frame
 *     and it is seen at about 38 degrees to the surface — close to the grazing
 *     angle where POM is at its most convincing. A flagstone joint that actually
 *     recedes as the camera moves is the cheapest "expensive" effect available,
 *     and it costs nothing beyond ~9 m because it fades out with distance.
 *
 *  2. TRIPLANAR PROJECTION. Rubble, boulders, organic props and anything the
 *     world generator rotates arbitrarily have no usable UV layout. Triplanar
 *     costs three fetches per map, so it is opt-in per material and mutually
 *     exclusive with POM.
 *
 *  3. A DETAIL LAYER. One shared 256 px texture sampled in world space at ~3
 *     repeats per metre, adding a micro-normal and value break-up below the base
 *     texture's texel size. This is what survives the 'detail' shot's 9.5 m boom.
 *
 *  4. MACRO VARIATION. The same shared texture sampled at ~1/7 m, modulating
 *     value, hue and roughness. A 1.75 m texture repeats eleven times across the
 *     frame; without a variation field whose period is much longer than the tile,
 *     the repetition is obvious to the eye and measurable by `analyze.mjs`'s
 *     autocorrelation.
 *
 *  5. PER-INSTANCE VARIATION. A hash of each object's own world origin, computed
 *     in the vertex shader, drives small shifts in value, hue, roughness and UV
 *     offset. It works for `Mesh`, `InstancedMesh` and `BatchedMesh` identically
 *     and needs nothing from the caller — a hundred instanced blocks stop being
 *     a hundred identical blocks for free.
 *
 * On top of those sit the OVERLAYS: moss, grime, soot, wetness, blood, dust and
 * wax, each masked by the baked height/AO fields so they collect where they
 * would actually collect. They are what make a room look inhabited rather than
 * generated, and they are uniforms, so `world` can vary them per room without
 * re-baking anything.
 *
 * ---------------------------------------------------------------------------
 * COOPERATING WITH `render`
 *
 * `render.registerMaterial()` wraps `onBeforeCompile` a second time and injects
 * screen-space AO, the occluder fade and the glow multiplier. Its replacements
 * target `#include <common>`, `#include <clipping_planes_fragment>`,
 * `#include <emissivemap_fragment>` and `#include <aomap_fragment>`, so:
 *
 *   - every replacement here keeps the original include marker in its output, so
 *     render's `String.replace` still finds it;
 *   - `#include <aomap_fragment>` is left completely alone — that one is render's;
 *   - the emissive block MULTIPLIES `totalEmissiveRadiance` rather than assigning
 *     it, so render's `*= mnGlow` composes with it in either order.
 *
 * Declarations go in at `#include <clipping_planes_pars_fragment>`, the LAST
 * pars include in `meshphysical_frag`. Injecting them at `<common>` — the
 * obvious-looking choice — puts them before `map_pars_fragment` declares the
 * samplers this code fetches from, and the shader fails to compile.
 */

// ---------------------------------------------------------------------------
// vertex
// ---------------------------------------------------------------------------

const VERT_PARS = /* glsl */ `
varying vec3 vMnWorldPos;
varying float vMnVary;

/** Same float hash the forge uses, so CPU-side and GPU-side variation agree. */
float mnHashV( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.yzx + 33.33 );
	return fract( ( p.x + p.y ) * p.z );
}
`;

const VERT_BODY = /* glsl */ `
	// World position, mirroring the exact transform chain <project_vertex> uses
	// for object -> view, so instanced and batched geometry lands in the right
	// place. Getting this wrong shows up as triplanar sliding across instances.
	vec4 mnObj = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		mnObj = batchingMatrix * mnObj;
	#endif
	#ifdef USE_INSTANCING
		mnObj = instanceMatrix * mnObj;
	#endif
	vMnWorldPos = ( modelMatrix * mnObj ).xyz;

	// Per-instance seed: the object's own origin in world space. Constant across
	// the instance because the matrix is, so no 'flat' qualifier is needed and
	// the interpolator costs nothing.
	vec3 mnOrigin = modelMatrix[ 3 ].xyz;
	#ifdef USE_BATCHING
		mnOrigin = ( modelMatrix * vec4( batchingMatrix[ 3 ].xyz, 1.0 ) ).xyz;
	#endif
	#ifdef USE_INSTANCING
		mnOrigin = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
	#endif
	vMnVary = mnHashV( mnOrigin * 3.137 + 7.0 );
`;

// ---------------------------------------------------------------------------
// fragment declarations
// ---------------------------------------------------------------------------

const FRAG_PARS = /* glsl */ `
varying vec3 vMnWorldPos;
varying float vMnVary;

uniform sampler2D mnDetailTex;
uniform vec4 mnUvScale;      // xy = repeats per UV unit, zw = offset
uniform vec4 mnPom;          // x = relief in uv units, y = fade start (m), z = fade end (m)
uniform vec4 mnDetail;       // x = repeats/m, y = normal amt, z = albedo amt, w = roughness amt
uniform vec4 mnMacro;        // x = repeats/m, y = value amt, z = roughness amt, w = hue amt
uniform vec4 mnVary;         // x = value, y = hue, z = roughness, w = uv jitter
uniform vec4 mnOvA;          // x = moss, y = grime, z = soot, w = wet
uniform vec4 mnOvB;          // x = blood, y = blood dryness, z = dust, w = wax
uniform vec4 mnEmis;         // x = gain, y = lo edge, z = hi edge
uniform vec3 mnCavAo;        // x = cavity->diffuse, y = detail fade start (m), z = end (m)
uniform vec2 mnMul;          // x = roughness multiplier, y = metalness multiplier
uniform vec3 mnMossCol;
uniform vec3 mnBloodCol;
uniform vec3 mnDustCol;
uniform vec3 mnGrimeCol;
uniform float mnTriScale;    // repeats per metre for the triplanar projection

// Written by the prepare block, read by the map replacements below. Global so
// the six channels are fetched exactly once per fragment.
vec2  mnUv;
vec2  mnDdx;
vec2  mnDdy;
vec2  mnProj;
vec3  mnWorldN;
vec4  mnDet;
vec4  mnMac;
vec3  mnVar3;
float mnDetFade;
float mnEmissiveMask;
#ifdef MN_TRIPLANAR
	vec3 mnTriW;
	vec2 mnTriUvX;
	vec2 mnTriUvY;
	vec2 mnTriUvZ;
#endif

/** Tangent frame, self-contained so this material does not depend on which of
 *  three's optional chunks happen to be in scope at the injection point. */
mat3 mnTangentFrame( vec3 eyePos, vec3 n, vec2 uv ) {
	vec3 q0 = dFdx( eyePos );
	vec3 q1 = dFdy( eyePos );
	vec2 st0 = dFdx( uv );
	vec2 st1 = dFdy( uv );
	vec3 q1perp = cross( q1, n );
	vec3 q0perp = cross( n, q0 );
	vec3 T = q1perp * st0.x + q0perp * st1.x;
	vec3 B = q1perp * st0.y + q0perp * st1.y;
	float det = max( dot( T, T ), dot( B, B ) );
	float s = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
	return mat3( T * s, B * s, n );
}

/**
 * Add a 2D perturbation to the working normal.
 *
 * In the planar path the working normal is tangent space, so this is a plain
 * xy add. Under triplanar it is already WORLD space, and adding to .xy would
 * tilt a wall sideways instead of roughening it — so a world tangent basis is
 * built from the geometric normal and the perturbation is applied in that.
 */
vec3 mnPerturbN( vec3 n, vec2 d ) {
	#ifdef MN_TRIPLANAR
		vec3 up = abs( mnWorldN.y ) > 0.9 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 );
		vec3 t = normalize( cross( mnWorldN, up ) );
		return n + t * d.x + cross( mnWorldN, t ) * d.y;
	#else
		return vec3( n.xy + d, n.z );
	#endif
}

#ifdef MN_POM
/**
 * Parallax occlusion mapping against the height packed in normalMap.a.
 *
 * Linear search plus one secant refinement. The refinement is not optional: a
 * pure linear search with 8 steps stair-steps visibly along every mortar joint,
 * and one extra fetch is far cheaper than doubling the step count.
 *
 * Every fetch uses textureGrad with the derivatives of the UNPARALLAXED uv.
 * Implicit derivatives inside a loop with a data-dependent break are undefined,
 * and at a parallax silhouette the offset uv jumps, which drives implicit mip
 * selection to level 0 and makes the whole surface shimmer under TAA.
 */
vec2 mnParallax( vec2 uv, vec3 vts, float relief ) {
	float nz = max( abs( vts.z ), 0.30 );
	// More steps at grazing angles, where the ray travels furthest through the
	// height field and a coarse march breaks up into stripes.
	float steps = mix( float( MN_POM_MAX ), float( MN_POM_MIN ), clamp( nz, 0.0, 1.0 ) );
	float layer = 1.0 / steps;
	vec2 delta = ( vts.xy / nz ) * relief * layer;

	float depth = 0.0;
	vec2 p = uv;
	float h = 1.0 - textureGrad( normalMap, p, mnDdx, mnDdy ).a;

	for ( int i = 0; i < MN_POM_MAX; i ++ ) {
		if ( depth >= h ) break;
		if ( float( i ) >= steps ) break;
		p -= delta;
		depth += layer;
		h = 1.0 - textureGrad( normalMap, p, mnDdx, mnDdy ).a;
	}

	vec2 prev = p + delta;
	float after = h - depth;
	float before = ( 1.0 - textureGrad( normalMap, prev, mnDdx, mnDdy ).a ) - depth + layer;
	float w = after / max( after - before, 1e-4 );
	return mix( p, prev, clamp( w, 0.0, 1.0 ) );
}
#endif

/** Fetch the three packed maps at 'uv'. Split out because the triplanar path
 *  calls it three times and the planar path once. */
void mnFetch( vec2 uv, out vec4 alb, out vec4 nrm, out vec4 orm ) {
	alb = textureGrad( map, uv, mnDdx, mnDdy );
	nrm = textureGrad( normalMap, uv, mnDdx, mnDdy );
	orm = textureGrad( roughnessMap, uv, mnDdx, mnDdy );
}
`;

/**
 * Everything that has to happen before the first map fetch: the world normal,
 * the parallax offset, the triplanar setup, the two detail taps and the
 * per-instance hash. Injected at `<logdepthbuf_fragment>`, which sits after the
 * occluder-fade discard render inserts and before `<map_fragment>`.
 */
const FRAG_PREPARE = /* glsl */ `
	// World-space geometric normal from the interpolated view normal. Cheaper
	// than a dedicated varying by three floats of interpolator bandwidth.
	#ifdef FLAT_SHADED
		vec3 mnGeoNv = normalize( cross( dFdx( - vViewPosition ), dFdy( - vViewPosition ) ) );
		mnWorldN = normalize( cross( dFdx( vMnWorldPos ), dFdy( vMnWorldPos ) ) );
	#else
		vec3 mnGeoNv = normalize( vNormal );
		mnWorldN = normalize( mnGeoNv * mat3( viewMatrix ) );
	#endif

	mnVar3 = fract( vMnVary * vec3( 1.0, 17.31, 91.71 ) );

	float mnViewDist = length( vViewPosition );
	mnDetFade = 1.0 - smoothstep( mnCavAo.y, mnCavAo.z, mnViewDist );

	// Detail and macro are both projected on the dominant world axis. That keeps
	// them continuous across a floor built from many separate meshes and stops
	// them smearing on a wall, for one texture fetch each instead of three.
	vec3 mnAbsN = abs( mnWorldN );
	mnProj = mnAbsN.y > max( mnAbsN.x, mnAbsN.z )
		? vMnWorldPos.xz
		: ( mnAbsN.x > mnAbsN.z ? vMnWorldPos.zy : vMnWorldPos.xy );

	mnDet = texture2D( mnDetailTex, mnProj * mnDetail.x );
	mnMac = texture2D( mnDetailTex, mnProj * mnMacro.x );

	#ifdef MN_TRIPLANAR

		vec3 mnTri = vMnWorldPos * mnTriScale;
		// Sharp blend exponent: a soft blend triple-samples a wide band of the
		// surface and the overlap reads as a smudge along every 45-degree face.
		vec3 mnBw = pow( mnAbsN, vec3( 6.0 ) );
		mnTriW = mnBw / max( dot( mnBw, vec3( 1.0 ) ), 1e-4 );
		// Mirror two projections so the texture does not read backwards on the
		// far side of the object.
		mnTriUvX = vec2( mnTri.z * sign( mnWorldN.x ), -mnTri.y );
		mnTriUvY = vec2( mnTri.x, mnTri.z * sign( mnWorldN.y ) );
		mnTriUvZ = vec2( mnTri.x * -sign( mnWorldN.z ), -mnTri.y );
		mnUv = mnTriUvY;
		mnDdx = dFdx( mnTriUvY );
		mnDdy = dFdy( mnTriUvY );

	#else

		vec2 mnUvBase = vMapUv * mnUvScale.xy + mnUvScale.zw;
		// Per-instance UV jitter: shifts the texture inside each instance so a
		// wall kit built from one geometry does not show the same chip in the
		// same corner of every block.
		mnUvBase += ( mnVar3.xy - 0.5 ) * mnVary.w;

		mnDdx = dFdx( mnUvBase );
		mnDdy = dFdy( mnUvBase );
		mnUv = mnUvBase;

		#ifdef MN_POM
			float mnPomFade = 1.0 - smoothstep( mnPom.y, mnPom.z, mnViewDist );
			if ( mnPomFade > 0.01 ) {
				// The frame must be in the same space as 'eyePos', i.e. view space.
				#ifdef USE_TANGENT
					mat3 mnTBN = mat3( normalize( vTangent ), normalize( vBitangent ), mnGeoNv );
				#else
					mat3 mnTBN = mnTangentFrame( - vViewPosition, mnGeoNv, mnUvBase );
				#endif
				vec3 mnVts = normalize( vViewPosition * mnTBN );
				mnUv = mnParallax( mnUvBase, mnVts, mnPom.x * mnPomFade );
			}
		#endif

	#endif
`;

/**
 * The single place all six channels are assembled. Runs at `<map_fragment>` and
 * leaves its results in locals that the roughness/metalness/normal/emissive
 * replacements read, so nothing is fetched twice.
 */
const FRAG_SAMPLE = /* glsl */ `
	vec4 mnAlb, mnNrm, mnOrm;

	#ifdef MN_TRIPLANAR

		vec4 aX, nX, oX, aY, nY, oY, aZ, nZ, oZ;
		mnFetch( mnTriUvX, aX, nX, oX );
		mnFetch( mnTriUvY, aY, nY, oY );
		mnFetch( mnTriUvZ, aZ, nZ, oZ );
		mnAlb = aX * mnTriW.x + aY * mnTriW.y + aZ * mnTriW.z;
		mnOrm = oX * mnTriW.x + oY * mnTriW.y + oZ * mnTriW.z;

		// Whiteout normal blend. Each projection's tangent normal is swung into
		// world space by adding the geometric normal's in-plane components and
		// taking |z| along the projection axis; blending the raw tangent normals
		// instead flattens every 45-degree face to nothing.
		vec3 tX = nX.xyz * 2.0 - 1.0;
		vec3 tY = nY.xyz * 2.0 - 1.0;
		vec3 tZ = nZ.xyz * 2.0 - 1.0;
		tX = vec3( tX.xy + mnWorldN.zy, abs( tX.z ) * mnWorldN.x );
		tY = vec3( tY.xy + mnWorldN.xz, abs( tY.z ) * mnWorldN.y );
		tZ = vec3( tZ.xy + mnWorldN.xy, abs( tZ.z ) * mnWorldN.z );
		vec3 mnWorldPerturbed = normalize( tX.zyx * mnTriW.x + tY.xzy * mnTriW.y + tZ.xyz * mnTriW.z );
		mnNrm = vec4( mnWorldPerturbed, nX.a * mnTriW.x + nY.a * mnTriW.y + nZ.a * mnTriW.z );
		vec3 mnNTS = mnWorldPerturbed;

	#else

		mnFetch( mnUv, mnAlb, mnNrm, mnOrm );
		vec3 mnNTS = mnNrm.xyz * 2.0 - 1.0;

	#endif

	vec3 mnAlbedo = mnAlb.rgb;
	float mnHeight = mnNrm.a;
	float mnBakedAO = mnOrm.r;
	float mnRough = mnOrm.g;
	float mnMetal = mnOrm.b;
	float mnCavity = mnOrm.a;
	mnEmissiveMask = mnAlb.a;

	// ---- detail ----------------------------------------------------------
	// Value and roughness break-up below the base texture's texel size. Faded
	// with distance because at 20 m it is pure aliasing.
	float mnDv = ( mnDet.b - 0.5 ) * mnDetFade;
	mnAlbedo *= 1.0 + mnDv * mnDetail.z;
	mnRough += mnDv * mnDetail.w;
	// The micro-normal is GATED ON ROUGHNESS. A near-mirror surface — standing
	// water, polished marble, obsidian, steel — turns a high-frequency normal
	// perturbation into a field of specular sparkles: the highlight is narrower
	// than a texel, so every texel either catches it or does not, and the result
	// is white static that no amount of TAA can settle. Rough surfaces have a
	// wide enough lobe to integrate it, which is where the detail belongs.
	float mnGloss = smoothstep( 0.07, 0.32, mnRough );
	mnNTS = mnPerturbN( mnNTS, ( mnDet.rg * 2.0 - 1.0 ) * mnDetail.y * mnDetFade * mnGloss );

	// ---- macro variation (the anti-tiling layer) --------------------------
	float mnMv = mnMac.b - 0.5;
	mnAlbedo *= 1.0 + mnMv * mnMacro.y;
	mnRough += mnMv * mnMacro.z;
	// Hue drift between a cold and a warm cast of the same colour. Small, but it
	// is what stops the eye locking onto the repeat.
	vec3 mnWarmC = mnAlbedo * vec3( 1.10, 1.00, 0.88 );
	vec3 mnColdC = mnAlbedo * vec3( 0.90, 0.98, 1.14 );
	mnAlbedo = mix( mnAlbedo, mix( mnColdC, mnWarmC, mnMac.a ), mnMacro.w );

	// ---- per-instance variation ------------------------------------------
	mnAlbedo *= 1.0 + ( mnVar3.x - 0.5 ) * mnVary.x;
	mnAlbedo = mix( mnAlbedo, mnAlbedo * vec3( 1.08, 1.0, 0.90 ), ( mnVar3.y - 0.5 ) * mnVary.y );
	mnRough += ( mnVar3.z - 0.5 ) * mnVary.z;

	#ifdef MN_OVERLAY
		float mnLow = 1.0 - mnHeight;
		float mnCrev = 1.0 - mnBakedAO;
		float mnUpF = clamp( mnWorldN.y, 0.0, 1.0 );
		float mnPatch = mnMac.a;
		float mnPatch2 = mnDet.a;

		// ---- wet ----------------------------------------------------------
		// Water fills the low ground first and pools in the crevices; the
		// surface of a pool is FLAT, which is why the normal is lerped toward
		// the geometric normal rather than merely being made smoother. Without
		// that flattening, "wet" just looks like shiny bumps.
		float mnWetM = clamp( mnOvA.w * ( 0.30 + 1.30 * mnLow ) * ( 0.55 + 0.75 * mnCrev ), 0.0, 1.0 );
		float mnPool = smoothstep( 0.45, 0.95, mnWetM );
		mnAlbedo *= mix( 1.0, 0.44, mnWetM );
		mnRough = mix( mnRough, 0.055, mnWetM * 0.92 );
		mnNTS = mix( mnNTS, mnFlatN, mnPool * 0.85 );
		mnCavity = mix( mnCavity, 1.0, mnPool * 0.6 );

		// ---- grime --------------------------------------------------------
		float mnGrimeM = clamp( mnOvA.y * ( 0.30 + 0.85 * mnCrev ), 0.0, 1.0 );
		mnAlbedo = mix( mnAlbedo, mnAlbedo * 0.42 + mnGrimeCol * 0.5, mnGrimeM );
		mnRough = mix( mnRough, 0.93, mnGrimeM * 0.65 );

		// ---- moss / lichen -------------------------------------------------
		// Only in the crevices, only in patches, and only where water sits.
		float mnMossM = clamp( mnOvA.x * smoothstep( 0.30, 0.78, mnPatch ) *
			( 0.15 + 1.10 * mnCrev ) * ( 0.25 + 0.95 * mnLow ), 0.0, 1.0 );
		mnAlbedo = mix( mnAlbedo, mnMossCol * ( 0.55 + 1.10 * mnDet.b ), mnMossM );
		mnRough = mix( mnRough, 0.96, mnMossM );
		mnNTS = mnPerturbN( mnNTS, ( mnDet.rg * 2.0 - 1.0 ) * mnMossM * 1.8 );
		mnCavity = mix( mnCavity, mnCavity * 0.85, mnMossM );

		// ---- soot ----------------------------------------------------------
		// Soot rises: it lands on up-facing surfaces and on the proud edges,
		// exactly the opposite mask to grime, which is why both are needed.
		float mnSootM = clamp( mnOvA.z * ( 0.25 + 0.85 * mnUpF ) *
			( 0.30 + 0.90 * mnHeight ) * ( 0.35 + 0.85 * mnPatch2 ), 0.0, 1.0 );
		mnAlbedo *= mix( 1.0, 0.09, mnSootM );
		mnRough = mix( mnRough, 0.975, mnSootM );

		// ---- blood ----------------------------------------------------------
		float mnBloodM = clamp( mnOvB.x * smoothstep( 0.38, 0.80, mnPatch2 ) *
			( 0.30 + 1.00 * mnLow ), 0.0, 1.0 );
		// Fresh blood is a dark red mirror; dried blood is a brown matte crust.
		vec3 mnBloodShade = mix( mnBloodCol * 0.55, mnBloodCol * 0.30 + mnGrimeCol * 0.25, mnOvB.y );
		mnAlbedo = mix( mnAlbedo, mnBloodShade, mnBloodM );
		mnRough = mix( mnRough, mix( 0.14, 0.80, mnOvB.y ), mnBloodM );
		mnNTS = mix( mnNTS, mnFlatN, mnBloodM * ( 1.0 - mnOvB.y ) * 0.7 );

		// ---- dust ------------------------------------------------------------
		float mnDustM = clamp( mnOvB.z * ( 0.15 + 1.0 * mnUpF ) * smoothstep( 0.25, 0.85, mnHeight ), 0.0, 1.0 );
		mnAlbedo = mix( mnAlbedo, mnDustCol, mnDustM * 0.75 );
		mnRough = mix( mnRough, 0.985, mnDustM );

		#ifdef MN_WAX
			// Wax runs downhill and pools on the first ledge it finds, so the
			// mask is a vertical streak gated on an up-facing surface.
			float mnStreakM = texture2D( mnDetailTex, vec2( mnProj.x * mnDetail.x * 3.0, mnProj.y * mnDetail.x * 0.22 ) ).a;
			float mnWaxM = clamp( mnOvB.w * smoothstep( 0.45, 0.85, mnStreakM ) * ( 0.25 + 0.9 * mnUpF ), 0.0, 1.0 );
			mnAlbedo = mix( mnAlbedo, mnDustCol * 1.5, mnWaxM );
			mnRough = mix( mnRough, 0.34, mnWaxM );
			mnNTS = mix( mnNTS, mnFlatN, mnWaxM * 0.5 );
		#endif
	#endif

	mnRough = clamp( mnRough, 0.02, 1.0 );

	// Cavity into diffuse. Physically this belongs in the direct-light term, but
	// a punctual light has no area and nothing else in the lighting model can
	// darken a one-millimetre crevice; folding it into albedo affects diffuse
	// only (a dielectric's F0 is a constant) and is what production engines do.
	diffuseColor.rgb *= mnAlbedo * mix( 1.0, mnCavity, mnCavAo.x );

	#ifdef MN_ALPHA
		diffuseColor.a *= mnAlb.a;
	#endif
`;

/** The "unperturbed" direction used when an overlay flattens the normal. Under
 *  triplanar the working normal is world space, otherwise tangent space. */
const FRAG_FLATN = /* glsl */ `
	#ifdef MN_TRIPLANAR
		vec3 mnFlatN = mnWorldN;
	#else
		vec3 mnFlatN = vec3( 0.0, 0.0, 1.0 );
	#endif
`;

/**
 * Roughness and metalness come from the ORM map and a scalar multiplier — NOT
 * from `material.roughness` / `material.metalness`.
 *
 * Those two three-native scalars are deliberately left carrying a per-surface
 * HINT instead, because render's depth prepass reads them directly
 * (`prepass.js._sync` copies `src.roughness` and `src.metalness` into the MRT
 * shader) and has no way to evaluate this material's map. With the obvious
 * `metalness = 1` multiplier there, every stone floor in the game would be
 * tagged metal=1 in the G-buffer and SSR would give it a metal's F0 of 0.62 —
 * a mirror-bright crypt. The hint is the surface's dominant value, so the
 * prepass gets something true and the lit pass gets the map.
 */
const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = mnRough * mnMul.x;
`;

const FRAG_METAL = /* glsl */ `
float metalnessFactor = mnMetal * mnMul.y;
`;

const FRAG_NORMAL = /* glsl */ `
	#ifdef MN_TRIPLANAR
		// Already world space; bring it into view space, which is where the rest
		// of three's lighting expects 'normal' to be.
		normal = normalize( ( viewMatrix * vec4( normalize( mnNTS ), 0.0 ) ).xyz );
	#else
		vec3 mnMapN = mnNTS;
		mnMapN.xy *= normalScale;
		#ifdef USE_TANGENT
			mat3 mnTanFrame = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
		#else
			mat3 mnTanFrame = mnTangentFrame( - vViewPosition, normal, mnUv );
		#endif
		#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
			mnTanFrame[ 0 ] *= faceDirection;
			mnTanFrame[ 1 ] *= faceDirection;
		#endif
		normal = normalize( mnTanFrame * normalize( mnMapN ) );
	#endif
`;

const FRAG_EMISSIVE = /* glsl */ `
	#ifdef MN_EMISSIVE
		// A shaped ramp on the baked emissive mask. 'lo' may exceed 'hi', which
		// inverts the ramp — that one uniform pair covers both "glows in the
		// carved grooves" (runes) and "glows on the facet crowns" (crystal).
		float mnEmT = clamp( ( mnEmissiveMask - mnEmis.y ) / ( mnEmis.z - mnEmis.y ), 0.0, 1.0 );
		totalEmissiveRadiance *= mnEmis.x * mnEmT * mnEmT * ( 3.0 - 2.0 * mnEmT );
	#endif
`;

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

/** Uniform blocks shared by every MONARCH material, so a palette or detail
 *  change is one assignment rather than a walk over the whole cache. */
export class SharedMaterialUniforms {
  constructor(palette) {
    this.detailTex = { value: null };
    this.mossCol = { value: new THREE.Color().setRGB(...palette.moss, THREE.LinearSRGBColorSpace) };
    this.bloodCol = { value: new THREE.Color().setRGB(...palette.blood, THREE.LinearSRGBColorSpace) };
    this.dustCol = { value: new THREE.Color().setRGB(...palette.dust, THREE.LinearSRGBColorSpace) };
    this.grimeCol = { value: new THREE.Color().setRGB(...palette.grime, THREE.LinearSRGBColorSpace) };
  }
}

/**
 * Build one MONARCH standard material.
 *
 * @param {object} set    a baked surface set from TextureForge
 * @param {object} spec   resolved options — see library.js `resolve()`
 * @param {SharedMaterialUniforms} shared
 */
export function buildMaterial(set, spec, shared) {
  const surface = set.surface;

  const mat = new THREE.MeshStandardMaterial({
    name: `mn.${set.id}${spec.suffix}`,
    color: new THREE.Color().setRGB(spec.tint[0], spec.tint[1], spec.tint[2], THREE.LinearSRGBColorSpace),
    // Hints for render's prepass only — see FRAG_ROUGH above.
    roughness: spec.roughHint,
    metalness: spec.metalHint,
    map: set.albedo,
    normalMap: set.normal,
    roughnessMap: set.orm,
    metalnessMap: set.orm,
    // aoMap is what render's screen-space AO patch multiplies into the indirect
    // terms. It samples at the plain UV, which is exact for the planar path and
    // slightly stale under parallax — acceptable for an indirect-only term, but
    // meaningless under triplanar, so it is left off there.
    aoMap: spec.triplanar ? null : set.orm,
    aoMapIntensity: spec.aoIntensity,
    normalScale: new THREE.Vector2(spec.normalScale, spec.normalScale),
    side: spec.side,
    envMapIntensity: spec.envMapIntensity,
    dithering: false,
  });

  if (surface.alphaTest) {
    mat.alphaTest = surface.alphaTest;
    mat.transparent = false;   // cutout, not blending: stays in the depth prepass
  }

  if (surface.emissive) {
    mat.emissive = new THREE.Color().setRGB(
      spec.emissiveColor[0], spec.emissiveColor[1], spec.emissiveColor[2], THREE.LinearSRGBColorSpace
    );
    mat.emissiveIntensity = spec.emissive;
  }

  const u = {
    mnDetailTex: shared.detailTex,
    mnUvScale: { value: new THREE.Vector4(spec.uvScale, spec.uvScale, 0, 0) },
    mnPom: { value: new THREE.Vector4(spec.pomRelief, spec.pomNear, spec.pomFar, 0) },
    mnDetail: { value: new THREE.Vector4(spec.detailScale, spec.detailNormal, spec.detailAlbedo, spec.detailRough) },
    mnMacro: { value: new THREE.Vector4(spec.macroScale, spec.macroValue, spec.macroRough, spec.macroHue) },
    mnVary: { value: new THREE.Vector4(spec.varyValue, spec.varyHue, spec.varyRough, spec.varyUv) },
    mnOvA: { value: new THREE.Vector4(spec.moss, spec.grime, spec.soot, spec.wet) },
    mnOvB: { value: new THREE.Vector4(spec.blood, spec.bloodDry, spec.dust, spec.wax) },
    mnEmis: { value: new THREE.Vector4(spec.emissiveGain, spec.emissiveLo, spec.emissiveHi, 0) },
    mnCavAo: { value: new THREE.Vector3(spec.cavity, spec.detailFadeNear, spec.detailFadeFar) },
    mnMul: { value: new THREE.Vector2(spec.roughness, spec.metalness) },
    mnMossCol: shared.mossCol,
    mnBloodCol: shared.bloodCol,
    mnDustCol: shared.dustCol,
    mnGrimeCol: shared.grimeCol,
    mnTriScale: { value: spec.uvScale },
  };
  // Kept on the material so the library can retune a LIVE material (a room that
  // floods, a brazier that starts smoking) without rebuilding anything.
  mat.userData.mnUniforms = u;
  mat.userData.mnSurface = set.id;
  mat.userData.mnTag = surface.tag;
  mat.userData.mnSpec = spec;

  // Defines are part of three's own program cache key, which matters because
  // render's patcher overwrites `customProgramCacheKey` with a constant. Two
  // MONARCH materials that differ only in a define still get separate programs.
  const defines = {
    MN_POM_MIN: String(spec.pomMin),
    MN_POM_MAX: String(spec.pomMax),
  };
  if (spec.pom) defines.MN_POM = '';
  if (spec.triplanar) defines.MN_TRIPLANAR = '';
  if (spec.overlay) defines.MN_OVERLAY = '';
  if (spec.wax > 0) defines.MN_WAX = '';
  if (surface.emissive) defines.MN_EMISSIVE = '';
  if (surface.alphaTest) defines.MN_ALPHA = '';
  mat.defines = defines;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      // LAST pars include: everything this code fetches from is declared by now.
      .replace(
        '#include <clipping_planes_pars_fragment>',
        `#include <clipping_planes_pars_fragment>\n${FRAG_PARS}`
      )
      .replace('#include <logdepthbuf_fragment>', `#include <logdepthbuf_fragment>\n${FRAG_PREPARE}`)
      .replace('#include <map_fragment>', `${FRAG_FLATN}\n${FRAG_SAMPLE}`)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', FRAG_METAL)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      // Keeps the marker: render appends its glow multiply right after it, and
      // both multiplies compose in either order.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);
  };

  return mat;
}
