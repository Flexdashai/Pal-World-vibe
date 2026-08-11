/**
 * MONARCH — periodic procedural noise library (GLSL ES 3.00).
 *
 * Everything here is PERIODIC. A texture whose tiling seam is visible is an
 * automatic critic failure, and the only reliable way to avoid one is to make
 * the *noise itself* wrap: every lattice lookup is taken modulo an integer
 * period, so the function is mathematically identical at u and u+1. Blending or
 * mirroring the edges of a non-periodic field always leaves a visible ghost of
 * the blend region at exactly the tile frequency, which is what
 * `analyze.mjs --tile` measures.
 *
 * Conventions used by every function in this file:
 *
 *   `p`    lattice-space position. One texture repeat spans `per` lattice cells,
 *          so callers pass `uv * per`.
 *   `per`  integer period in lattice cells. MUST be integral, and must double
 *          alongside the frequency in an fbm — hence every fbm here carries the
 *          period through the octave loop instead of only scaling `p`.
 *
 * Cost notes, because this runs on a CPU rasteriser:
 *   - No `sin`/`cos` in the hashes. The classic `fract(sin(dot(p,k))*c)` hash is
 *     both slower here and numerically unstable at large coordinates; the
 *     Hoskins-style integer-lattice hashes below are pure mul/fract.
 *   - Value noise is preferred over gradient noise wherever the difference is
 *     not visible, because it costs 4 hashes instead of 4 hashes + 4 dots.
 *   - Every loop has a compile-time constant bound with an early `break`, which
 *     lets the SwiftShader GLSL compiler unroll rather than emitting a loop.
 */

export const NOISE_GLSL = /* glsl */ `

// ===========================================================================
// hashing
// ===========================================================================

float mnHash11( float p ) {
	vec3 p3 = fract( vec3( p ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

float mnHash21( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 mnHash22( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.xx + p3.yz ) * p3.zy );
}

vec3 mnHash23( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yxz + 33.33 );
	return fract( ( p3.xxy + p3.yzz ) * p3.zyx );
}

// ===========================================================================
// interpolants
// ===========================================================================

/** Hermite. Cheap, C1, the default for value noise. */
vec2 mnQuintic2( vec2 f ) { return f * f * ( 3.0 - 2.0 * f ); }
/** Perlin's C2 quintic — no visible lattice creases in a derived normal map,
 *  which matters a great deal once a Sobel filter runs over the height field. */
vec2 mnSmooth5( vec2 f ) { return f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 ); }

// ===========================================================================
// periodic value noise
// ===========================================================================

float mnValue( vec2 p, vec2 per ) {
	vec2 i = floor( p );
	vec2 f = p - i;
	vec2 u = mnSmooth5( f );

	// mod() on the lattice index is what makes the field wrap. 'per' is integral
	// so this is exact; a fractional period would shear the noise at the seam.
	vec2 i0 = mod( i, per );
	vec2 i1 = mod( i + 1.0, per );

	float a = mnHash21( i0 );
	float b = mnHash21( vec2( i1.x, i0.y ) );
	float c = mnHash21( vec2( i0.x, i1.y ) );
	float d = mnHash21( i1 );

	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

/** Periodic gradient (Perlin) noise, remapped to 0..1. Used where the field must
 *  have zero mean and no lattice-aligned blobbing — veins, flow, wood grain. */
float mnPerlin( vec2 p, vec2 per ) {
	vec2 i = floor( p );
	vec2 f = p - i;
	vec2 u = mnSmooth5( f );

	vec2 i0 = mod( i, per );
	vec2 i1 = mod( i + 1.0, per );

	// Gradients from a 2D hash mapped onto the unit circle without trig: take a
	// hash in 0..1, turn it into a point in the square, normalise.
	vec2 ga = normalize( mnHash22( i0 ) * 2.0 - 1.0 + 1e-4 );
	vec2 gb = normalize( mnHash22( vec2( i1.x, i0.y ) ) * 2.0 - 1.0 + 1e-4 );
	vec2 gc = normalize( mnHash22( vec2( i0.x, i1.y ) ) * 2.0 - 1.0 + 1e-4 );
	vec2 gd = normalize( mnHash22( i1 ) * 2.0 - 1.0 + 1e-4 );

	float a = dot( ga, f );
	float b = dot( gb, f - vec2( 1.0, 0.0 ) );
	float c = dot( gc, f - vec2( 0.0, 1.0 ) );
	float d = dot( gd, f - vec2( 1.0, 1.0 ) );

	// * 0.7071 normalises the theoretical range of 2D Perlin to about -1..1.
	return clamp( mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 1.4142 * 0.5 + 0.5, 0.0, 1.0 );
}

// ===========================================================================
// fractal sums
// ===========================================================================

/** Standard fbm. The period doubles with the frequency so the sum stays
 *  periodic — forgetting that is the single most common cause of a seam. */
float mnFbm( vec2 p, vec2 per, int oct, float gain ) {
	float amp = 0.5;
	float sum = 0.0;
	float norm = 0.0;
	vec2 pp = per;
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= oct ) break;
		sum += amp * mnValue( p, pp );
		norm += amp;
		amp *= gain;
		p *= 2.0;
		pp *= 2.0;
	}
	return sum / max( norm, 1e-4 );
}

/** fbm of gradient noise — smoother, no axis-aligned clumping. */
float mnFbmP( vec2 p, vec2 per, int oct, float gain ) {
	float amp = 0.5;
	float sum = 0.0;
	float norm = 0.0;
	vec2 pp = per;
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= oct ) break;
		sum += amp * mnPerlin( p, pp );
		norm += amp;
		amp *= gain;
		p *= 2.0;
		pp *= 2.0;
	}
	return sum / max( norm, 1e-4 );
}

/** Ridged multifractal — sharp creases. Cracks, veins, wood grain, rock strata. */
float mnRidged( vec2 p, vec2 per, int oct, float gain ) {
	float amp = 0.5;
	float sum = 0.0;
	float norm = 0.0;
	vec2 pp = per;
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= oct ) break;
		float n = 1.0 - abs( mnPerlin( p, pp ) * 2.0 - 1.0 );
		sum += amp * n * n;
		norm += amp;
		amp *= gain;
		p *= 2.0;
		pp *= 2.0;
	}
	return sum / max( norm, 1e-4 );
}

/** Billowed fbm — rounded lobes. Rust blooms, moss clumps, ash dunes. */
float mnBillow( vec2 p, vec2 per, int oct, float gain ) {
	float amp = 0.5;
	float sum = 0.0;
	float norm = 0.0;
	vec2 pp = per;
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= oct ) break;
		sum += amp * abs( mnPerlin( p, pp ) * 2.0 - 1.0 );
		norm += amp;
		amp *= gain;
		p *= 2.0;
		pp *= 2.0;
	}
	return sum / max( norm, 1e-4 );
}

/**
 * Domain warp. Two extra fbm evaluations bend the sample position before the
 * real lookup, which is what turns "computer noise" into something that reads as
 * erosion, grain or flow. The warp field is itself periodic, so the result still
 * tiles.
 */
vec2 mnWarp( vec2 p, vec2 per, float amt, int oct ) {
	float wx = mnFbm( p + vec2( 11.7, 3.1 ), per, oct, 0.5 );
	float wy = mnFbm( p + vec2( 5.2, 19.3 ), per, oct, 0.5 );
	return p + ( vec2( wx, wy ) * 2.0 - 1.0 ) * amt;
}

// ===========================================================================
// cellular / Worley
// ===========================================================================

/**
 * Periodic Worley. Returns
 *   .x  F1  — distance to the nearest feature point
 *   .y  F2  — distance to the second nearest
 *   .z  id  — hash of the winning cell, 0..1 (per-cell colour/height variation)
 *   .w  unused, kept so callers can pack their own value
 *
 * 'jitter' in 0..1 slides the feature point inside its cell: 1.0 is fully
 * random (organic), 0.0 collapses to a regular grid (masonry).
 */
vec4 mnWorley( vec2 p, vec2 per, float jitter ) {
	vec2 n = floor( p );
	vec2 f = p - n;

	float f1 = 8.0, f2 = 8.0, id = 0.0;

	for ( int j = -1; j <= 1; j ++ ) {
		for ( int i = -1; i <= 1; i ++ ) {
			vec2 g = vec2( float( i ), float( j ) );
			vec2 cell = mod( n + g, per );
			vec2 o = mnHash22( cell );
			vec2 r = g + 0.5 + ( o - 0.5 ) * jitter - f;
			float d = dot( r, r );                 // squared; sqrt once at the end
			if ( d < f1 ) {
				f2 = f1; f1 = d;
				id = mnHash21( cell + 17.0 );
			} else if ( d < f2 ) {
				f2 = d;
			}
		}
	}
	return vec4( sqrt( f1 ), sqrt( f2 ), id, 0.0 );
}

/**
 * Worley variant that also returns the vector to the winning feature point, so a
 * second pass can measure distance to the CELL BORDER rather than to the point.
 * Border distance is what a mortar joint actually is: constant width regardless
 * of how big the two neighbouring stones are. F2-F1 looks similar but pinches to
 * zero at three-cell junctions, which reads as a blob of mortar at every corner.
 *
 *   .xy  vector from the sample to the winning feature point
 *   .z   winning cell hash
 *   .w   F1
 */
vec4 mnWorleyVec( vec2 p, vec2 per, float jitter ) {
	vec2 n = floor( p );
	vec2 f = p - n;

	vec2 mr = vec2( 0.0 );
	vec2 mg = vec2( 0.0 );
	float md = 8.0;

	for ( int j = -1; j <= 1; j ++ ) {
		for ( int i = -1; i <= 1; i ++ ) {
			vec2 g = vec2( float( i ), float( j ) );
			vec2 o = mnHash22( mod( n + g, per ) );
			vec2 r = g + 0.5 + ( o - 0.5 ) * jitter - f;
			float d = dot( r, r );
			if ( d < md ) { md = d; mr = r; mg = g; }
		}
	}
	return vec4( mr, mnHash21( mod( n + mg, per ) + 17.0 ), sqrt( md ) );
}

/** Distance to the border of the Worley cell that owns 'p' (Quilez's method).
 *  Pass the 'mr' returned by mnWorleyVec. */
float mnWorleyBorder( vec2 p, vec2 per, float jitter, vec2 mr ) {
	vec2 n = floor( p );
	vec2 f = p - n;
	float md = 8.0;

	for ( int j = -2; j <= 2; j ++ ) {
		for ( int i = -2; i <= 2; i ++ ) {
			vec2 g = vec2( float( i ), float( j ) );
			vec2 o = mnHash22( mod( n + g, per ) );
			vec2 r = g + 0.5 + ( o - 0.5 ) * jitter - f;
			vec2 d = r - mr;
			// Skip the winning cell itself; its own bisector is degenerate.
			if ( dot( d, d ) > 1e-5 ) {
				md = min( md, dot( 0.5 * ( mr + r ), normalize( r - mr ) ) );
			}
		}
	}
	return md;
}

// ===========================================================================
// shaping helpers
// ===========================================================================

/** Smooth minimum — merges two height fields without a crease. */
float mnSmin( float a, float b, float k ) {
	float h = clamp( 0.5 + 0.5 * ( b - a ) / k, 0.0, 1.0 );
	return mix( b, a, h ) - k * h * ( 1.0 - h );
}

/** Remap x from [a,b] to [0,1], clamped. */
float mnLin( float x, float a, float b ) { return clamp( ( x - a ) / ( b - a ), 0.0, 1.0 ); }

/** Symmetric band pass: 1 inside [a,b], falling off over 'w'. */
float mnBand( float x, float a, float b, float w ) {
	return smoothstep( a - w, a + w, x ) * ( 1.0 - smoothstep( b - w, b + w, x ) );
}

/** Contrast about a pivot. Cheaper and better behaved than pow() for masks. */
float mnContrast( float x, float k, float pivot ) {
	return clamp( ( x - pivot ) * k + pivot, 0.0, 1.0 );
}

/** Periodic rotation of the sample plane. Rotating a tiling field breaks its
 *  periodicity in general, so this is only used at 90 degree multiples. */
vec2 mnRot90( vec2 p, int k ) {
	if ( k == 1 ) return vec2( -p.y, p.x );
	if ( k == 2 ) return -p;
	if ( k == 3 ) return vec2( p.y, -p.x );
	return p;
}

/**
 * Anisotropic streak noise: fine, elongated scratches along +x. Used for chisel
 * marks, brushed metal, wood grain and wax runs. 'stretch' is how many times
 * longer than wide the features are.
 */
float mnStreak( vec2 p, vec2 per, float stretch, int oct ) {
	// Only x is compressed, so the period along x must be scaled to match or the
	// field stops tiling horizontally.
	vec2 q = vec2( p.x / stretch, p.y );
	vec2 pq = vec2( max( 1.0, floor( per.x / stretch + 0.5 ) ), per.y );
	return mnFbm( q, pq, oct, 0.55 );
}

/** Sparse impulse field: 'density' in 0..1 controls how many cells fire.
 *  Returns the impulse strength (0 outside), radial falloff inside. */
float mnSpeckle( vec2 p, vec2 per, float density, float radius ) {
	vec2 n = floor( p );
	vec2 f = p - n;
	float acc = 0.0;
	for ( int j = -1; j <= 1; j ++ ) {
		for ( int i = -1; i <= 1; i ++ ) {
			vec2 g = vec2( float( i ), float( j ) );
			vec2 cell = mod( n + g, per );
			vec3 h = mnHash23( cell );
			if ( h.z > 1.0 - density ) {
				vec2 r = g + h.xy - f;
				float d = length( r ) / max( radius, 1e-3 );
				acc = max( acc, 1.0 - smoothstep( 0.0, 1.0, d ) );
			}
		}
	}
	return acc;
}
`;
