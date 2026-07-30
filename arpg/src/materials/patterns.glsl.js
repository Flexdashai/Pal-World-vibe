/**
 * MONARCH — structural pattern primitives (GLSL ES 3.00).
 *
 * The noise library gives fields; this gives *architecture*. Every surface in a
 * gothic crypt is built out of a small number of repeating layouts — running
 * bond masonry, irregular slabs, voussoir courses, planks, woven thread — and
 * each of those layouts wants the same four outputs:
 *
 *   local   position inside the unit (0..1), for grain, bevels and wear
 *   id      a stable per-unit hash, for colour/height/rotation variation
 *   edge    distance to the unit's border, in unit-local space — this is what
 *           mortar joints, chamfers and chipped corners are all cut from
 *   index   the integer cell, so a caller can re-derive its own hashes
 *
 * All of them tile: every integer index is taken modulo the pattern's period
 * before it is hashed, exactly as in noise.glsl.js.
 *
 * A note on why `edge` is a separate output rather than `min(local, 1-local)`:
 * for a rectangular unit the two are the same, but for a Worley slab they are
 * not, and the entire visual difference between "cracked flagstone" and "grid of
 * squares" lives in that distinction.
 */

export const PATTERNS_GLSL = /* glsl */ `

// ===========================================================================
// rectangular masonry
// ===========================================================================

/**
 * Running-bond brick lattice.
 *
 * @param uv       0..1 texture space
 * @param counts   bricks across, courses down (must be integral to tile)
 * @param stagger  fraction of a brick each successive course is shifted by
 *                 (0.5 = classic running bond, 0.0 = stack bond)
 * @param jitterX  per-course random extra shift, in bricks. Nothing in a real
 *                 wall is perfectly staggered; without this the eye locks onto
 *                 the vertical joint rhythm immediately.
 *
 * returns .xy = local 0..1 inside the brick, .z = brick id hash, .w = row index
 */
vec4 mnBrick( vec2 uv, vec2 counts, float stagger, float jitterX ) {
	vec2 p = uv * counts;
	float row = floor( p.y );
	float rowMod = mod( row, counts.y );

	// Per-course shift. The jitter term is hashed from the WRAPPED row index so
	// the top and bottom courses of the tile still line up.
	float shift = stagger * mod( rowMod, 2.0 ) + jitterX * ( mnHash11( rowMod * 7.13 + 0.5 ) - 0.5 );
	p.x += shift;

	float col = floor( p.x );
	vec2 local = fract( p );
	vec2 cell = vec2( mod( col, counts.x ), rowMod );
	return vec4( local, mnHash21( cell + 3.7 ), row );
}

/** Distance to the nearest edge of a rectangular unit, corrected for the unit's
 *  aspect so a long thin brick does not get a fat chamfer on its short sides. */
float mnRectEdge( vec2 local, vec2 aspect ) {
	vec2 d = min( local, 1.0 - local ) * aspect;
	return min( d.x, d.y );
}

/**
 * Voussoir course — the wedge blocks of an arch or a ribbed vault, laid out
 * along x with radial joints. 'skew' tilts the joints progressively so the
 * course reads as curving even on flat geometry.
 * returns .xy = local, .z = block id, .w = signed distance across the joint
 */
vec4 mnVoussoir( vec2 uv, float blocks, float skew ) {
	float x = uv.x * blocks + uv.y * skew;
	float i = floor( x );
	float local = x - i;
	float id = mnHash11( mod( i, blocks ) * 13.1 + 0.3 );
	return vec4( local, uv.y, id, min( local, 1.0 - local ) );
}

// ===========================================================================
// irregular slabs (the flagstone workhorse)
// ===========================================================================

/**
 * Irregular slab field from a jittered Worley cell decomposition.
 *
 * returns:
 *   .x  border distance (0 at a joint, grows into the slab)
 *   .y  slab id hash
 *   .z  distance to the slab's feature point, normalised — a "how central am I"
 *       term used for the subtle dish worn into the middle of a trodden stone
 *   .w  a second per-slab hash, for rotating the slab's own detail
 *
 * 'warp' bends the cell boundaries so joints are not straight lines between
 * feature points; a real flagstone floor has slightly curved, chipped joints and
 * this is the cheapest way to get them.
 */
vec4 mnSlabs( vec2 uv, vec2 cells, float jitter, float warp, vec2 warpFreq ) {
	vec2 p = uv * cells;
	// The warp field is evaluated at the SLAB scale, so it moves whole joints
	// rather than adding high-frequency fuzz to them.
	vec2 w = mnWarp( p * warpFreq, cells * warpFreq, warp, 2 ) / max( warpFreq, vec2( 1e-3 ) );

	vec4 v = mnWorleyVec( w, cells, jitter );
	float border = mnWorleyBorder( w, cells, jitter, v.xy );
	return vec4( border, v.z, clamp( v.w, 0.0, 1.0 ), mnHash11( v.z * 31.7 + 1.3 ) );
}

/**
 * Crack network. A ridged field thresholded into thin lines, then thinned
 * further where a second field says the stone is sound. Cracks read as damage
 * only if they are sparse, branch, and *stop*; a uniform craquelure looks like
 * a wireframe.
 *
 * returns 0..1, 1 in the middle of a crack.
 */
float mnCracks( vec2 uv, vec2 per, float scale, float width, float density ) {
	vec2 p = uv * scale;
	vec2 pp = per * scale;
	vec2 q = mnWarp( p, pp, 0.55, 2 );
	float r = mnRidged( q, pp, 3, 0.55 );
	float line = smoothstep( 1.0 - width, 1.0, r );
	// Sparsity mask: large blobs where the stone is simply intact.
	float sound = smoothstep( 0.35, 0.62, mnFbm( p * 0.31, max( pp * 0.31, vec2( 1.0 ) ), 3, 0.5 ) );
	return line * mix( 1.0 - sound, 1.0, density );
}

// ===========================================================================
// timber
// ===========================================================================

/**
 * Plank layout along +x with a gap between boards.
 * returns .x = local across the board (0..1), .y = board id,
 *         .z = distance to the board edge, .w = board index
 */
vec4 mnPlanks( vec2 uv, float boards, float lengthJitter ) {
	float y = uv.y * boards;
	float i = floor( y );
	float local = y - i;
	float id = mnHash11( mod( i, boards ) * 5.31 + 0.17 );
	// Boards are not all the same width; nudge the local coordinate by the id.
	local = clamp( ( local - 0.5 ) * ( 1.0 + ( id - 0.5 ) * lengthJitter ) + 0.5, 0.0, 1.0 );
	return vec4( local, id, min( local, 1.0 - local ), i );
}

/**
 * Wood grain: rings stretched along the board with knot centres.
 * 'p' should already be in board-local space with x running along the grain.
 */
float mnGrain( vec2 p, vec2 per, float ringDensity, float wobble ) {
	// Rings are concentric in the cross-section, which for a flat-sawn board
	// projects to long parallel bands that swell around knots.
	float w = mnFbmP( vec2( p.x * 0.35, p.y * 2.1 ), max( per * vec2( 0.35, 2.1 ), vec2( 1.0 ) ), 3, 0.5 );
	float rings = fract( ( p.y + ( w - 0.5 ) * wobble ) * ringDensity );
	// Sharp latewood band, wide earlywood — that asymmetry is what makes it
	// read as timber rather than as a sine wave.
	return smoothstep( 0.0, 0.22, rings ) * ( 1.0 - smoothstep( 0.28, 0.55, rings ) );
}

// ===========================================================================
// woven cloth
// ===========================================================================

/**
 * Plain weave. Warp threads run along y, weft along x; each crosses over its
 * neighbour alternately, which is what produces the checkerboard highlight.
 * returns .x = height, .y = which thread family owns the pixel (0 warp, 1 weft)
 */
vec2 mnWeave( vec2 uv, vec2 threads ) {
	vec2 p = uv * threads;
	vec2 c = floor( p );
	vec2 f = p - c;
	float over = mod( c.x + c.y, 2.0 );          // alternating over/under

	// Each thread is a half-cylinder; the height is the cylinder cross-section.
	float warp = sqrt( max( 0.0, 1.0 - pow( ( f.x - 0.5 ) * 2.0, 2.0 ) ) );
	float weft = sqrt( max( 0.0, 1.0 - pow( ( f.y - 0.5 ) * 2.0, 2.0 ) ) );

	float h = mix( warp * 0.9 + weft * 0.35, weft * 0.9 + warp * 0.35, over );
	return vec2( h * 0.5, over );
}

// ===========================================================================
// faceted / crystalline
// ===========================================================================

/**
 * Fractured facet field — conchoidal fracture (obsidian) and prismatic crystal.
 *
 * Each Worley cell becomes a PLANE with a random tilt; the height is the plane's
 * value at the sample, so cell boundaries are sharp creases and each face is
 * genuinely flat. A smoothed height field cannot produce that read, and flat
 * faces with sharp creases is the entire visual signature of fractured glass.
 *
 * returns .x = height, .y = facet id, .z = crease proximity (1 at a crease)
 */
vec3 mnFacets( vec2 uv, vec2 cells, float jitter, float tilt ) {
	vec2 p = uv * cells;
	vec4 v = mnWorleyVec( p, cells, jitter );
	float border = mnWorleyBorder( p, cells, jitter, v.xy );

	// Plane through the feature point with a hashed gradient.
	vec2 g = ( mnHash22( vec2( v.z * 91.7, v.z * 37.1 ) ) * 2.0 - 1.0 ) * tilt;
	float h = 0.5 + dot( g, -v.xy ) + ( v.z - 0.5 ) * 0.25;

	return vec3( clamp( h, 0.0, 1.0 ), v.z, 1.0 - smoothstep( 0.0, 0.09, border ) );
}

// ===========================================================================
// rune carving
// ===========================================================================

/**
 * Procedural rune glyphs on a coarse grid.
 *
 * Each cell draws two or three straight strokes chosen from a hashed set of
 * endpoints on a 3x3 node lattice, plus an optional terminal bar. This produces
 * angular, futhark-like marks that read as *language* rather than as decoration,
 * which is the whole point — a glyph the eye can almost parse is far more
 * unsettling than a random squiggle.
 *
 * returns the carved depth mask, 1 inside a stroke.
 */
float mnStrokeSeg( vec2 p, vec2 a, vec2 b, float w ) {
	vec2 pa = p - a, ba = b - a;
	float t = clamp( dot( pa, ba ) / max( dot( ba, ba ), 1e-5 ), 0.0, 1.0 );
	return 1.0 - smoothstep( w * 0.55, w, length( pa - ba * t ) );
}

float mnRunes( vec2 uv, vec2 cells, float width ) {
	vec2 p = uv * cells;
	vec2 n = floor( p );
	vec2 f = p - n;
	vec2 cell = mod( n, cells );

	// Leave many cells blank: inscriptions have spacing, and a wall of solid
	// glyphs reads as a texture pattern instead of as writing.
	float present = mnHash21( cell + 61.3 );
	if ( present < 0.42 ) return 0.0;

	vec3 h = mnHash23( cell * 1.7 + 5.0 );
	float g = 0.0;

	// Node lattice: quantise hashed positions to 0, 0.5, 1 so strokes meet.
	vec2 n0 = floor( vec2( h.x, h.y ) * 2.999 ) * 0.5;
	vec2 n1 = floor( vec2( h.z, mnHash11( h.x * 13.0 ) ) * 2.999 ) * 0.5;
	vec2 n2 = floor( vec2( mnHash11( h.y * 7.0 ), mnHash11( h.z * 11.0 ) ) * 2.999 ) * 0.5;

	// Inset into the cell so glyphs never touch their neighbours.
	vec2 lo = vec2( 0.22 ), hi = vec2( 0.78 );
	n0 = mix( lo, hi, n0 ); n1 = mix( lo, hi, n1 ); n2 = mix( lo, hi, n2 );

	// A vertical stave is present in most runes and is what makes the set read
	// as one alphabet rather than as three unrelated scribbles.
	g = max( g, mnStrokeSeg( f, vec2( 0.5, 0.18 ), vec2( 0.5, 0.82 ), width ) );
	g = max( g, mnStrokeSeg( f, n0, n1, width ) );
	if ( present > 0.68 ) g = max( g, mnStrokeSeg( f, n1, n2, width ) );

	return g;
}

// ===========================================================================
// scattered debris
// ===========================================================================

/**
 * Scattered elongated fragments — bone shards, splinters, tile chips.
 * Each cell places one capsule with a hashed direction, length and thickness.
 * returns .x = coverage mask, .y = fragment id, .z = height (domed across the
 * shard so it lights like a solid object rather than a decal)
 */
vec3 mnShards( vec2 uv, vec2 cells, float density, float len, float thick ) {
	vec2 p = uv * cells;
	vec2 n = floor( p );
	vec2 f = p - n;

	float best = 0.0, id = 0.0, h = 0.0;

	for ( int j = -1; j <= 1; j ++ ) {
		for ( int i = -1; i <= 1; i ++ ) {
			vec2 g = vec2( float( i ), float( j ) );
			vec2 cell = mod( n + g, cells );
			vec3 r = mnHash23( cell + 23.0 );
			if ( r.z > density ) continue;

			float ang = mnHash11( r.x * 51.7 ) * 3.14159265;
			vec2 dir = vec2( cos( ang ), sin( ang ) );
			float l = len * ( 0.55 + r.z * 1.4 );
			vec2 c = g + r.xy;

			vec2 pa = f - ( c - dir * l * 0.5 );
			vec2 ba = dir * l;
			float t = clamp( dot( pa, ba ) / max( dot( ba, ba ), 1e-5 ), 0.0, 1.0 );
			float d = length( pa - ba * t );
			// Taper: shards are thicker in the middle, which also gives the dome.
			float w = thick * ( 0.45 + 0.55 * sin( t * 3.14159265 ) );
			float m = 1.0 - smoothstep( w * 0.7, w, d );
			if ( m > best ) {
				best = m;
				id = mnHash11( r.y * 77.3 );
				h = sqrt( max( 0.0, 1.0 - min( 1.0, d / max( w, 1e-4 ) ) ) );
			}
		}
	}
	return vec3( best, id, h );
}
`;
