import { ENV, ELEMENTS } from '../core/palette.js';

/**
 * MONARCH — the surface catalogue.
 *
 * Each entry is a recipe for ONE tileable PBR surface. The `glsl` body is
 * compiled into the forge's field shader as the body of
 *
 *     void mnSurface( vec2 uv, out MnField f )
 *
 * with `uv` in 0..1 across one texture repeat and `MnField` declared as
 *
 *     struct MnField { vec3 albedo; float height; float rough; float metal; float alpha; };
 *
 * The contract every body must honour:
 *
 *   f.albedo   LINEAR reflectance. Read the base colour from the injected
 *              palette constants (MN_STONE_COLD, MN_DIRT, ...) and modulate;
 *              never write a colour literal. Keep dielectrics inside 0.02-0.9.
 *   f.height   0..1. This drives the derived normal, the derived AO, the
 *              parallax march and every overlay's "does it collect here" mask,
 *              so it is by far the most important channel. Aim to use the full
 *              range: a height field that only spans 0.4-0.6 produces a flat
 *              normal map no matter how much you scale it afterwards.
 *   f.rough    perceptual roughness. VARY IT. A constant-roughness surface is
 *              the single most common tell of a procedural material — real
 *              stone is polished where it is walked on and chalky where it is
 *              sheltered.
 *   f.metal    0 or 1 almost always. Rust, patina and paint on metal are
 *              dielectric, so a metal surface that corrodes must write 0 there.
 *   f.alpha    opacity mask, 1 unless the surface has holes (torn cloth).
 *
 * Every noise lookup must be periodic — see noise.glsl.js. The period passed to
 * a noise function has to be the number of cells across ONE repeat, and it must
 * be an integer, or the tile seam becomes visible and `analyze.mjs` reports it.
 *
 * `tier` picks the bake resolution:
 *   hero  = full `config.q.textureSize`   — the floor and the wall the camera
 *           spends the entire game looking at
 *   main  = half                          — everything else the player walks past
 *   minor = quarter                       — props, small trim, rarely near camera
 *
 * `tile` is the natural world size of one repeat in metres. `world` gets this
 * for free through `materials.get()`, so a wall built with UVs in metres lands
 * at the right texel density without anyone having to tune it per mesh.
 */

/** Palette constants injected into every bake shader. Kept in one place so a
 *  palette edit propagates to all 25 surfaces. */
export const PALETTE_GLSL = () => {
  const c = (name, rgb) => `const vec3 ${name} = vec3( ${rgb[0].toFixed(5)}, ${rgb[1].toFixed(5)}, ${rgb[2].toFixed(5)} );`;
  return [
    c('MN_STONE_COLD', ENV.stoneCold),
    c('MN_STONE_WARM', ENV.stoneWarm),
    c('MN_FLAGSTONE', ENV.flagstone),
    c('MN_MORTAR', ENV.mortar),
    c('MN_DIRT', ENV.dirt),
    c('MN_ASH', ENV.ash),
    c('MN_BONE', ENV.bone),
    c('MN_IRON_DARK', ENV.ironDark),
    c('MN_GOLD', ENV.gold),
    c('MN_MOSS', ENV.moss),
    c('MN_WOOD', ENV.wood),
    c('MN_CLOTH', ENV.cloth),
    c('MN_CRYSTAL', ENV.crystal),
    c('MN_BLOOD_CORE', ELEMENTS.blood.core),
    c('MN_BLOOD_DARK', ELEMENTS.blood.dark),
    c('MN_FIRE_DARK', ELEMENTS.fire.dark),
    c('MN_FIRE_CORE', ELEMENTS.fire.core),
    c('MN_SHADOW_CORE', ELEMENTS.shadow.core),
    c('MN_SHADOW_GLOW', ELEMENTS.shadow.glow),
    c('MN_HOLY_CORE', ELEMENTS.holy.core),
    // A METAL'S ALBEDO IS ITS SPECULAR COLOUR, and the environment palette is
    // written for dielectrics, so ENV.ironDark (0.045) used directly makes a
    // mirror that reflects 4% of the light — a black hole with a highlight.
    // Blackened wrought iron measures around F0 = 0.13-0.20. This factor is the
    // documented correction, applied only on the metal branch of a surface.
    'const float MN_METAL_F0_GAIN = 3.4;',
  ].join('\n');
};

export const SURFACES = [
  // =========================================================================
  // ARCHITECTURE
  // =========================================================================
  {
    id: 'flagstone',
    tag: 'flagstone',
    tier: 'hero',
    // 2.4 m per repeat: at the 'detail' shot's 116 screen-pixels-per-metre that
    // is a 278 px period, deliberately outside the 16-256 px window
    // analyze.mjs's autocorrelation searches — and far enough apart that the eye
    // does not lock onto it either.
    tile: 2.4,
    // 7.5 cm from the top of a flag to the bottom of its joint. That is a real
    // measurement off a cathedral floor, and it is also the number that decides
    // whether the parallax march is visible: at this camera the offset works out
    // near seven screen pixels, which is where a recessed joint stops reading as
    // a painted line and starts reading as a hole.
    heightScale: 0.075,
    roughHint: 0.78,
    doc: 'Cracked flagstone floor. The single most-seen surface in the game.',
    glsl: /* glsl */ `
	// 5 x 4 flags over a 2.4 m repeat: 48 x 60 cm stones, the size a real flagged
	// floor uses. Integer cell counts = seamless.
	const vec2 CELLS = vec2( 5.0, 4.0 );

	// A WARPED RECTANGULAR LATTICE, not a Voronoi diagram.
	//
	// This was built on Voronoi first and it is worth recording why that failed:
	// a jittered Voronoi always relaxes toward hexagons, so however the jitter
	// and the warp are tuned the result reads unmistakably as river cobbles or
	// crazy paving. Dressed flagstone is sawn square. The lattice supplies the
	// squareness; the warp only makes each joint wander a couple of centimetres,
	// which is what a hand-laid floor actually does, and the per-flag width
	// jitter stops every vertical joint in a course lining up into a grid.
	vec2 wuv = mnWarp( uv * 4.0, vec2( 4.0 ), 0.085, 2 ) * 0.25;
	vec4 br = mnBrick( wuv, CELLS, 0.5, 0.30 );
	vec2 local = br.xy;
	float id = br.z;
	float id2 = mnHash11( id * 53.1 + 0.7 );
	local.x = clamp( ( local.x - 0.5 ) * ( 1.0 + ( id - 0.5 ) * 0.35 ) + 0.5, 0.0, 1.0 );

	// Aspect-corrected edge distance, so a 48 x 60 cm flag gets the same physical
	// joint width on all four sides.
	float border = mnRectEdge( local, vec2( 1.0, CELLS.y / CELLS.x ) );
	// 0 in the middle of a flag, 1 at its edge — the same sense the wear and
	// dish terms below expect.
	float central = 1.0 - clamp( border * 2.4, 0.0, 1.0 );

	// ---- joint ---------------------------------------------------------
	// Joint width varies per stone AND along its length. A constant-width joint
	// is the second-strongest procedural tell after constant roughness, and it
	// is what makes a floor read as an outlined diagram.
	float jointW = ( 0.016 + 0.026 * mnHash11( id * 37.1 ) )
		* ( 0.65 + 0.70 * mnFbm( uv * 16.0, vec2( 16.0 ), 2, 0.5 ) );
	float joint = 1.0 - smoothstep( jointW * 0.22, jointW, border );

	// ---- slab body -----------------------------------------------------
	// Each flag sits at its own level (quarried stone is never coplanar) and is
	// very slightly dished by foot traffic.
	//
	// The dish was four times deeper at first and it turned every flag into a
	// pillow: a radial term centred on each cell puts an identical dome in the
	// normal map of every stone, and a hundred identical domes is a pattern, not
	// a floor. Wear is a PATCH that crosses several flags (see wearField below),
	// so almost all of it lives in the albedo instead.
	float slabLift = ( id - 0.5 ) * 0.15;
	float dish = -0.022 * ( 1.0 - central ) * ( 1.0 - central );

	// Three relief bands. Rotating the two upper bands per stone stops the same
	// bump pattern appearing on every flag, which is otherwise obvious the
	// moment two neighbours are compared.
	vec2 rp = mnRot90( ( uv - 0.5 ) * 26.0, int( floor( id2 * 3.999 ) ) ) + 0.5;
	float coarse = mnFbm( uv * 11.0, vec2( 11.0 ), 3, 0.55 );
	float mid = mnFbm( rp * 1.9, vec2( 26.0 * 1.9 ), 3, 0.5 );
	float fine = mnFbm( rp * 4.6, vec2( 26.0 * 4.6 ), 3, 0.5 );
	float pit = mnSpeckle( uv * 54.0, vec2( 54.0 ), 0.20, 0.32 );

	// The mid and fine bands carry most of the visible micro-relief: the Sobel
	// that derives the normal is a high-pass, so amplitude at 3-6 cm matters far
	// more to how the surface lights than amplitude at 20 cm does.
	float body = 0.70 + slabLift + dish
		+ ( coarse - 0.5 ) * 0.09 + ( mid - 0.5 ) * 0.10 + ( fine - 0.5 ) * 0.075 - pit * 0.075;

	// ---- damage --------------------------------------------------------
	// Chipped arrises: erosion concentrates on the edges, gated so only some
	// corners are actually broken.
	float chipMask = smoothstep( 0.15, 0.015, border ) * smoothstep( 0.44, 0.74, mnFbm( uv * 8.0 + 13.0, vec2( 8.0 ), 3, 0.5 ) );
	body -= chipMask * 0.15;

	// Cracks across the flag faces, stopped short of the joints so they read as
	// fracture rather than as more mortar.
	float crack = mnCracks( uv, vec2( 1.0 ), 6.0, 0.085, 0.22 ) * smoothstep( 0.02, 0.12, border );
	body -= crack * 0.10;

	// ---- joint fill ----------------------------------------------------
	// The joint is not empty: it holds compacted grit sitting below the flag
	// face but well above the theoretical bottom of the gap.
	float gritH = 0.26 + 0.12 * mnFbm( uv * 38.0, vec2( 38.0 ), 2, 0.5 );
	f.height = clamp( mix( body, gritH, joint ), 0.0, 1.0 );

	// ---- albedo --------------------------------------------------------
	// Per-flag value + temperature variation. Real flagstone is quarried from
	// several beds; the hue spread is small but the value spread is large, and
	// under-doing it is what makes a procedural floor read as one grey sheet.
	vec3 base = mix( MN_FLAGSTONE, MN_STONE_COLD, id );
	base *= 0.42 + 1.45 * id2;
	base = mix( base, MN_STONE_WARM, 0.34 * mnFbm( uv * 2.0, vec2( 2.0 ), 2, 0.5 ) );

	// Aggregate: pale quartz grains and dark inclusions. This is the layer that
	// keeps the stone legible at 0.5 m and it has to survive mipmapping, so it
	// is biased bright rather than symmetric. Two grain sizes, because a single
	// speckle population reads as film noise rather than as rock.
	float quartz = mnSpeckle( rp * 5.6, vec2( 26.0 * 5.6 ), 0.32, 0.20 );
	float quartzL = mnSpeckle( rp * 2.4 + 3.0, vec2( 26.0 * 2.4 ), 0.20, 0.26 );
	float dark = mnSpeckle( rp * 3.3 + 7.0, vec2( 26.0 * 3.3 ), 0.26, 0.30 );
	base *= 1.0 + quartz * 1.35 + quartzL * 0.75 - dark * 0.45;
	// Mottling at the 5-10 cm scale — weathering, not grain. Without a band here
	// the stone face is a smooth gradient between the aggregate specks.
	base *= 0.74 + 0.54 * mid;
	base *= 0.90 + 0.22 * fine;

	// Traffic polish. This is a PATCH FIELD, not a per-flag radial term: people
	// walk in lines, so the wear crosses several stones and stops, and it is
	// only pulled back from the joints because the edges of a flag never see a
	// boot sole. A per-cell radial highlight — the obvious implementation — puts
	// the same bright oval in the middle of every stone and is instantly read as
	// a repeat.
	float wearField = mnFbm( uv * 2.6 + 19.0, vec2( 3.0 ), 3, 0.55 );
	float worn = smoothstep( 0.46, 0.82, wearField ) * ( 1.0 - central * 0.65 ) * ( 0.5 + 0.7 * id );
	base *= 1.0 + worn * 0.20;

	// Joint fill is dirt-coloured, not stone-coloured, and it is LIGHTER than
	// the geometry-driven shading suggests — the baked AO and the cavity term
	// already darken the joint twice, so a dark fill on top gives ink lines.
	vec3 grit = mix( MN_MORTAR * 1.15, MN_DIRT * 1.6, 0.55 ) * ( 0.72 + 0.62 * mnFbm( uv * 42.0, vec2( 42.0 ), 2, 0.5 ) );
	f.albedo = mix( base, grit, joint );
	f.albedo *= 1.0 - crack * 0.30;
	f.albedo *= 1.0 - chipMask * 0.16;

	// ---- roughness -----------------------------------------------------
	f.rough = 0.74 - worn * 0.30 + ( fine - 0.5 ) * 0.16 + quartz * 0.12 - ( mid - 0.5 ) * 0.10;
	f.rough = mix( f.rough, 0.95, joint );
	f.rough = mix( f.rough, 0.88, chipMask );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'cobble',
    tag: 'stone',
    tier: 'main',
    tile: 1.4,
    heightScale: 0.075,
    roughHint: 0.74,
    doc: 'Wet cobble — rounded setts with deep joints. Reads best with wet > 0.4.',
    glsl: /* glsl */ `
	const vec2 CELLS = vec2( 7.0, 7.0 );

	// Low jitter keeps the setts roughly in courses, as a laid road is.
	vec2 p = uv * CELLS;
	vec4 v = mnWorleyVec( p, CELLS, 0.62 );
	float border = mnWorleyBorder( p, CELLS, 0.62, v.xy );
	float id = v.z;

	// Dome: each sett is a squashed sphere, so height falls off with the
	// distance to its own border rather than to its centre. That keeps small and
	// large setts equally proud instead of making big ones into hills.
	float dome = smoothstep( 0.0, 0.30, border );
	dome = sqrt( dome );

	float grit = mnFbm( uv * 30.0, vec2( 30.0 ), 3, 0.5 );
	float pits = mnSpeckle( uv * 60.0, vec2( 60.0 ), 0.22, 0.30 );

	f.height = clamp( dome * ( 0.72 + 0.20 * id ) + ( grit - 0.5 ) * 0.07 - pits * 0.05, 0.0, 1.0 );

	vec3 base = mix( MN_STONE_COLD, MN_FLAGSTONE, id );
	base *= 0.55 + 1.0 * mnHash11( id * 41.7 );
	base *= 0.88 + 0.24 * grit;
	// Sand and silt washed into the joints.
	vec3 fill = mix( MN_DIRT, MN_MORTAR * 0.4, 0.4 ) * ( 0.7 + 0.7 * mnFbm( uv * 44.0, vec2( 44.0 ), 2, 0.5 ) );
	float joint = 1.0 - smoothstep( 0.0, 0.12, border );

	f.albedo = mix( base, fill, joint );
	// Crowns are polished by traffic; the flanks and joints are not.
	float crown = smoothstep( 0.55, 0.95, f.height );
	f.rough = mix( 0.80, 0.42, crown ) + ( grit - 0.5 ) * 0.12;
	f.rough = mix( f.rough, 0.96, joint );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'granite',
    tag: 'stone',
    tier: 'hero',
    tile: 2.4,
    heightScale: 0.05,
    roughHint: 0.80,
    doc: 'Carved granite block wall — running bond, chiselled faces, chipped arrises.',
    glsl: /* glsl */ `
	const vec2 COUNTS = vec2( 3.0, 5.0 );      // blocks across, courses down: 80 x 48 cm
	vec4 br = mnBrick( uv, COUNTS, 0.5, 0.10 );
	vec2 local = br.xy;
	float id = br.z;

	// Aspect correction so the chamfer is the same physical width on all four
	// sides of a block that is wider than it is tall.
	vec2 aspect = vec2( 1.0, COUNTS.y / COUNTS.x );
	float edge = mnRectEdge( local, aspect );

	// ---- joint ---------------------------------------------------------
	float jointW = 0.035 + 0.020 * mnHash11( id * 19.3 );
	float joint = 1.0 - smoothstep( jointW * 0.4, jointW, edge );

	// ---- block face ----------------------------------------------------
	// Chisel dressing: fine parallel tool marks at a per-block angle. Every
	// mason works a block in one direction and the next block differently, and
	// that alternation is instantly readable as hand-worked stone.
	int rot = int( floor( mnHash11( id * 7.7 ) * 3.999 ) );
	vec2 cp = mnRot90( ( uv - 0.5 ) * 30.0, rot ) + 0.5;
	float chisel = mnStreak( cp, vec2( 30.0 ), 7.0, 3 );

	// Granite aggregate: three grain populations at different scales.
	float g1 = mnSpeckle( uv * 90.0, vec2( 90.0 ), 0.30, 0.26 );        // quartz
	float g2 = mnSpeckle( uv * 58.0 + 3.0, vec2( 58.0 ), 0.26, 0.34 );  // feldspar
	float g3 = mnSpeckle( uv * 130.0 + 9.0, vec2( 130.0 ), 0.10, 0.20 );// mica flecks

	float face = 0.80 + ( id - 0.5 ) * 0.10 + ( chisel - 0.5 ) * 0.07
		+ ( g1 - 0.5 ) * 0.030 - g2 * 0.020;

	// Slight pillow: blocks bulge a touch in the middle from dressing.
	face += smoothstep( 0.0, 0.30, edge ) * 0.025;

	// ---- damage --------------------------------------------------------
	// Broken arrises. Concentrated on edges, gated so only some blocks are hurt.
	float dmg = smoothstep( 0.60, 0.85, mnFbm( uv * 5.0 + 21.0, vec2( 5.0 ), 3, 0.55 ) );
	float chip = smoothstep( 0.10, 0.0, edge ) * dmg;
	face -= chip * 0.16;
	// Spalled patches in the middle of a face expose fresh, brighter aggregate.
	float spall = smoothstep( 0.72, 0.92, mnFbm( uv * 12.0 + 41.0, vec2( 12.0 ), 3, 0.5 ) ) * smoothstep( 0.06, 0.18, edge );
	face -= spall * 0.06;

	float mortarH = 0.42 + 0.10 * mnFbm( uv * 50.0, vec2( 50.0 ), 2, 0.5 );
	f.height = clamp( mix( face, mortarH, joint ), 0.0, 1.0 );

	// ---- albedo --------------------------------------------------------
	vec3 base = mix( MN_STONE_COLD, MN_STONE_WARM, id * 0.7 );
	base *= 0.70 + 0.72 * mnHash11( id * 23.9 );
	base *= 0.90 + 0.20 * chisel;
	base *= 1.0 + g1 * 0.95 + g3 * 1.9 - g2 * 0.30;
	// Fresh spall is lighter than the weathered face.
	base = mix( base, base * 1.55, spall );

	vec3 mortarC = MN_MORTAR * ( 0.55 + 0.55 * mnFbm( uv * 55.0, vec2( 55.0 ), 2, 0.5 ) );
	f.albedo = mix( base, mortarC, joint );
	f.albedo *= 1.0 - chip * 0.10;

	// ---- roughness -----------------------------------------------------
	// Mica flecks are the only smooth thing on granite; everything else is matte.
	f.rough = 0.78 + ( chisel - 0.5 ) * 0.14 - g3 * 0.42 + g1 * 0.08;
	f.rough = mix( f.rough, 0.93, joint );
	f.rough = mix( f.rough, 0.88, spall );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'marble',
    tag: 'stone',
    tier: 'main',
    tile: 2.6,
    heightScale: 0.012,
    roughHint: 0.26,
    doc: 'Cathedral marble — veined, polished, large panels.',
    glsl: /* glsl */ `
	const vec2 COUNTS = vec2( 2.0, 2.0 );
	vec4 br = mnBrick( uv, COUNTS, 0.0, 0.0 );
	float edge = mnRectEdge( br.xy, vec2( 1.0 ) );
	float id = br.z;

	// Panel joints are thin and precise — this is dressed, not rubble, masonry.
	float joint = 1.0 - smoothstep( 0.004, 0.010, edge );

	// ---- veining -------------------------------------------------------
	// Two vein systems at different scales, each a heavily warped ridge field.
	// Marble veins are calcite intrusions: they branch, they are darker than the
	// matrix, and they run in a dominant direction set by the bedding plane.
	vec2 dir = vec2( 1.0, 0.42 );
	vec2 q = mnWarp( uv * dir * 3.0, vec2( 3.0, 3.0 ), 0.85, 3 );
	float vein1 = smoothstep( 0.62, 0.97, mnRidged( q, vec2( 3.0 ), 4, 0.55 ) );
	vec2 q2 = mnWarp( uv * dir * 8.0 + 31.0, vec2( 8.0, 8.0 ), 0.55, 2 );
	float vein2 = smoothstep( 0.74, 0.99, mnRidged( q2, vec2( 8.0 ), 3, 0.5 ) ) * 0.6;
	float vein = clamp( vein1 + vein2, 0.0, 1.0 );

	// Cloudy matrix — marble is never one flat value.
	float cloud = mnFbmP( uv * 4.0, vec2( 4.0 ), 4, 0.55 );
	float polish = mnFbm( uv * 70.0, vec2( 70.0 ), 2, 0.5 );

	// Height barely moves; a polished slab is flat and its relief comes almost
	// entirely from the veins being slightly proud after differential wear.
	f.height = clamp( 0.72 + vein * 0.10 + ( cloud - 0.5 ) * 0.05 - joint * 0.5, 0.0, 1.0 );

	// ---- albedo --------------------------------------------------------
	// Warm bone-white matrix, cold grey veins — the classic crypt marble.
	// Aged, not gleaming. A cathedral marble at its quarry-fresh reflectance
	// (~0.6) is four times brighter than every other surface in a crypt and
	// pulls the eye straight off the character; centuries of soot and candle
	// smoke take it a long way down, and that is what this palette wants.
	vec3 matrix = mix( MN_BONE * 0.24, MN_BONE * 0.36, cloud );
	matrix *= 0.86 + 0.28 * mnHash11( id * 13.1 );
	vec3 veinC = mix( MN_STONE_COLD * 1.4, MN_STONE_WARM * 0.8, cloud );
	f.albedo = mix( matrix, veinC, vein * 0.85 );
	f.albedo *= 0.95 + 0.10 * polish;
	f.albedo = mix( f.albedo, MN_MORTAR * 0.35, joint );

	// Polished stone: low roughness with a slow, wide variation from hand
	// polishing plus micro-scratches. A constant 0.2 here looks like plastic.
	f.rough = 0.20 + ( polish - 0.5 ) * 0.16 + cloud * 0.10 + vein * 0.14;
	f.rough = mix( f.rough, 0.90, joint );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'plaster',
    tag: 'stone',
    tier: 'main',
    tile: 2.2,
    heightScale: 0.03,
    roughHint: 0.88,
    doc: 'Crumbling plaster over brick — peeled patches expose the masonry beneath.',
    glsl: /* glsl */ `
	// ---- the brick substrate that shows through -------------------------
	const vec2 COUNTS = vec2( 6.0, 12.0 );
	vec4 br = mnBrick( uv, COUNTS, 0.5, 0.08 );
	float bEdge = mnRectEdge( br.xy, vec2( 1.0, COUNTS.y / COUNTS.x ) );
	float bJoint = 1.0 - smoothstep( 0.03, 0.09, bEdge );
	float brickH = mix( 0.52 + ( br.z - 0.5 ) * 0.06, 0.36, bJoint );
	vec3 brickC = mix( MN_STONE_WARM * ( 0.7 + 0.9 * br.z ), MN_MORTAR * 0.5, bJoint );

	// ---- the plaster skin ----------------------------------------------
	// Where the render survives. The mask is warped so the failure boundary is
	// ragged; a smooth boundary reads as an airbrushed decal.
	vec2 w = mnWarp( uv * 3.4, vec2( 3.4 ), 0.55, 3 );
	float intact = smoothstep( 0.40, 0.56, mnFbm( w, vec2( 3.4 ), 4, 0.55 ) );

	// Trowel undulation and a fine sandy float coat.
	float trowel = mnFbmP( uv * 5.0, vec2( 5.0 ), 3, 0.55 );
	float sand = mnFbm( uv * 90.0, vec2( 90.0 ), 2, 0.5 );
	float plasterH = 0.80 + ( trowel - 0.5 ) * 0.09 + ( sand - 0.5 ) * 0.035;

	// Crazing: the fine map of hairline cracks that covers old lime plaster.
	float craze = mnCracks( uv, vec2( 1.0 ), 14.0, 0.10, 0.85 );
	plasterH -= craze * 0.035;

	// A raised lip where the plaster has broken away — the edge of a spall is
	// always thicker than the field, and that lip is what sells the depth.
	float lip = smoothstep( 0.0, 0.10, intact ) * ( 1.0 - smoothstep( 0.10, 0.30, intact ) );
	plasterH += lip * 0.05;

	f.height = clamp( mix( brickH, plasterH, intact ), 0.0, 1.0 );

	// ---- albedo --------------------------------------------------------
	// Lime plaster is much lighter than the stone it covers — that value break
	// is most of the visual interest in the surface.
	vec3 plasterC = mix( MN_MORTAR * 1.25, MN_BONE * 0.30, 0.35 + 0.4 * trowel );
	plasterC *= 0.88 + 0.24 * sand;

	// Water staining running down from above. Streaks are vertical, long, and
	// concentrated below the failures.
	float stain = mnStreak( vec2( uv.y * 3.0, uv.x * 26.0 ), vec2( 3.0, 26.0 ), 5.0, 3 );
	plasterC *= mix( 1.0, 0.52, smoothstep( 0.45, 0.80, stain ) * 0.85 );
	plasterC = mix( plasterC, plasterC * mix( vec3( 1.0 ), MN_DIRT * 9.0, 0.5 ), smoothstep( 0.5, 0.9, stain ) * 0.6 );

	f.albedo = mix( brickC, plasterC, intact );
	f.albedo *= 1.0 - craze * intact * 0.30;

	f.rough = mix( 0.90, 0.86, intact ) + ( sand - 0.5 ) * 0.10 + craze * 0.06;
	f.rough = mix( f.rough, 0.95, bJoint * ( 1.0 - intact ) );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'mortar',
    tag: 'stone',
    tier: 'minor',
    tile: 1.2,
    heightScale: 0.02,
    roughHint: 0.93,
    doc: 'Coarse lime mortar / rendered rubble core. A filler surface for foundations and joints.',
    glsl: /* glsl */ `
	float coarse = mnFbm( uv * 12.0, vec2( 12.0 ), 4, 0.55 );
	float grain = mnFbm( uv * 64.0, vec2( 64.0 ), 3, 0.5 );
	// Aggregate stones pressed into the mix, half-exposed. Kept LOW contrast on
	// purpose: a bright, sparse aggregate on a dark matrix reads as white dots
	// on asphalt, which is the failure mode this surface fell into first.
	vec4 agg = mnWorley( uv * 20.0, vec2( 20.0 ), 0.9 );
	float exposed = smoothstep( 0.30, 0.08, agg.x ) * smoothstep( 0.35, 0.75, mnHash11( agg.z * 33.0 ) );
	float pit = mnSpeckle( uv * 55.0, vec2( 55.0 ), 0.28, 0.35 );

	f.height = clamp( 0.60 + ( coarse - 0.5 ) * 0.22 + ( grain - 0.5 ) * 0.08 + exposed * 0.10 - pit * 0.10, 0.0, 1.0 );

	vec3 base = MN_MORTAR * ( 0.48 + 0.72 * coarse );
	base = mix( base, MN_STONE_COLD * ( 1.0 + 0.9 * agg.z ), exposed * 0.5 );
	base *= 0.86 + 0.30 * grain;
	f.albedo = base;

	f.rough = 0.94 - exposed * 0.20 + ( grain - 0.5 ) * 0.08;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'vault',
    tag: 'stone',
    tier: 'main',
    tile: 2.4,
    heightScale: 0.045,
    roughHint: 0.83,
    doc: 'Ribbed vault stone — voussoir courses with radial joints, for arches and ceilings.',
    glsl: /* glsl */ `
	// Voussoirs run along x; the skew makes the joints splay as they would on a
	// real arch, so a straight mesh still reads as curved masonry.
	vec4 vs = mnVoussoir( uv, 7.0, 0.55 );
	float along = vs.x;
	float id = vs.z;

	// Courses across the rib.
	float courses = 2.0;
	float cy = uv.y * courses;
	float ci = floor( cy );
	float cl = cy - ci;
	float cid = mnHash11( mod( ci, courses ) * 9.1 + id );

	float edge = min( min( along, 1.0 - along ), min( cl, 1.0 - cl ) * 0.7 );
	float joint = 1.0 - smoothstep( 0.012, 0.040, edge );

	// Each voussoir face is slightly convex and slightly out of plane.
	float face = 0.80 + ( id - 0.5 ) * 0.11 + ( cid - 0.5 ) * 0.06;
	face += smoothstep( 0.0, 0.25, edge ) * 0.03;

	// Fine claw-chisel dressing along the course direction, plus soot pitting.
	float claw = mnStreak( vec2( uv.y * 40.0, uv.x * 40.0 ), vec2( 40.0 ), 9.0, 3 );
	float pit = mnSpeckle( uv * 70.0, vec2( 70.0 ), 0.14, 0.28 );
	face += ( claw - 0.5 ) * 0.05 - pit * 0.05;

	float mortarH = 0.44 + 0.10 * mnFbm( uv * 46.0, vec2( 46.0 ), 2, 0.5 );
	f.height = clamp( mix( face, mortarH, joint ), 0.0, 1.0 );

	vec3 base = mix( MN_STONE_COLD, MN_STONE_WARM, 0.35 + 0.5 * id );
	base *= 0.72 + 0.66 * cid;
	base *= 0.90 + 0.20 * claw;
	float fleck = mnSpeckle( uv * 96.0, vec2( 96.0 ), 0.20, 0.26 );
	base *= 1.0 + fleck * 0.55;
	f.albedo = mix( base, MN_MORTAR * ( 0.5 + 0.5 * mnFbm( uv * 50.0, vec2( 50.0 ), 2, 0.5 ) ), joint );

	f.rough = 0.82 + ( claw - 0.5 ) * 0.12 - fleck * 0.18;
	f.rough = mix( f.rough, 0.94, joint );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  // =========================================================================
  // GROUND
  // =========================================================================
  {
    id: 'dirt',
    tag: 'dirt',
    tier: 'main',
    tile: 1.6,
    heightScale: 0.035,
    roughHint: 0.94,
    doc: 'Packed earth floor — trodden, cracked, studded with small stones.',
    glsl: /* glsl */ `
	// Broad undulation: a dirt floor is never level, and the low frequency is
	// what makes light rake across it instead of hitting it uniformly.
	float macro = mnFbmP( uv * 3.0, vec2( 3.0 ), 4, 0.55 );
	float mid = mnFbm( uv * 14.0, vec2( 14.0 ), 3, 0.55 );
	float fine = mnFbm( uv * 55.0, vec2( 55.0 ), 3, 0.5 );

	// Pebbles pressed into the surface, only partly proud.
	vec4 peb = mnWorley( uv * 26.0, vec2( 26.0 ), 0.95 );
	float pebble = smoothstep( 0.26, 0.04, peb.x ) * step( 0.55, mnHash11( peb.z * 27.0 ) );

	// Dried-mud polygon cracking, shallow and only where the ground is high and
	// therefore dry.
	float dryness = smoothstep( 0.45, 0.75, macro );
	vec4 mud = mnSlabs( uv, vec2( 9.0 ), 0.95, 0.35, vec2( 1.0 ) );
	float mudCrack = ( 1.0 - smoothstep( 0.0, 0.045, mud.x ) ) * dryness;

	float h = 0.55 + ( macro - 0.5 ) * 0.30 + ( mid - 0.5 ) * 0.16 + ( fine - 0.5 ) * 0.06;
	h += pebble * 0.09;
	h -= mudCrack * 0.10;
	f.height = clamp( h, 0.0, 1.0 );

	vec3 base = MN_DIRT * ( 0.62 + 1.0 * macro );
	base = mix( base, MN_ASH * 0.7, 0.30 * mid );          // ash worked into the earth
	base *= 0.85 + 0.30 * fine;
	base = mix( base, MN_STONE_COLD * ( 0.8 + 1.0 * peb.z ), pebble * 0.9 );
	base *= 1.0 - mudCrack * 0.35;
	f.albedo = base;

	f.rough = 0.96 - pebble * 0.22 + ( fine - 0.5 ) * 0.06;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'gravel',
    tag: 'dirt',
    tier: 'main',
    tile: 1.1,
    heightScale: 0.06,
    roughHint: 0.88,
    doc: 'Loose gravel / rubble scree. Deep interstices, strong baked AO.',
    glsl: /* glsl */ `
	// Two stone populations. Real scree has a wide size distribution and the
	// small stones fill the gaps between the large ones.
	const vec2 C1 = vec2( 13.0 );
	const vec2 C2 = vec2( 27.0 );

	vec4 a = mnWorleyVec( uv * C1, C1, 1.0 );
	float ba = mnWorleyBorder( uv * C1, C1, 1.0, a.xy );
	vec4 b = mnWorleyVec( uv * C2, C2, 1.0 );
	float bb = mnWorleyBorder( uv * C2, C2, 1.0, b.xy );

	// Height of each stone: a dome over its own cell, lifted by a per-stone
	// hash so they are not all the same size.
	float ha = sqrt( smoothstep( 0.0, 0.34, ba ) ) * ( 0.55 + 0.45 * a.z );
	float hb = sqrt( smoothstep( 0.0, 0.30, bb ) ) * ( 0.30 + 0.30 * b.z );

	// The larger population wins where it exists; smaller stones sit between.
	float h = max( ha, hb * 0.85 );
	float grain = mnFbm( uv * 70.0, vec2( 70.0 ), 3, 0.5 );
	f.height = clamp( h * 0.9 + ( grain - 0.5 ) * 0.07 + 0.06, 0.0, 1.0 );

	// Which stone owns this pixel decides its colour, and stone-to-stone value
	// variation is the whole read of gravel.
	float id = ha > hb * 0.85 ? a.z : b.z;
	vec3 base = mix( MN_STONE_COLD, MN_FLAGSTONE, id );
	base *= 0.42 + 1.35 * mnHash11( id * 61.3 );
	base = mix( base, MN_STONE_WARM * 1.3, 0.30 * mnHash11( id * 17.9 ) );
	base *= 0.86 + 0.28 * grain;

	// Dust and fines in the gaps.
	float gap = 1.0 - smoothstep( 0.0, 0.16, max( ba, bb ) );
	f.albedo = mix( base, MN_DIRT * ( 0.7 + 0.6 * grain ), gap * 0.85 );

	f.rough = 0.86 - id * 0.14 + ( grain - 0.5 ) * 0.10;
	f.rough = mix( f.rough, 0.97, gap );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'ash',
    tag: 'ash',
    tier: 'minor',
    tile: 1.5,
    heightScale: 0.02,
    roughHint: 0.97,
    doc: 'Ash and cinder drift. Soft dunes, no hard edges, very high roughness.',
    glsl: /* glsl */ `
	// Wind-formed: the dunes are stretched along one axis and the fine grain is
	// isotropic. Ash has no structure below the grain scale, which is exactly
	// why it must be given structure ABOVE it or it renders as grey fog.
	float dune = mnFbmP( vec2( uv.x * 4.0, uv.y * 9.0 ), vec2( 4.0, 9.0 ), 4, 0.6 );
	float ripple = mnStreak( uv * 30.0, vec2( 30.0 ), 6.0, 3 );
	float grain = mnFbm( uv * 110.0, vec2( 110.0 ), 2, 0.5 );

	f.height = clamp( 0.5 + ( dune - 0.5 ) * 0.55 + ( ripple - 0.5 ) * 0.14 + ( grain - 0.5 ) * 0.05, 0.0, 1.0 );

	// Cinders: unburnt fragments, much darker than the ash around them.
	float cinder = mnSpeckle( uv * 34.0, vec2( 34.0 ), 0.16, 0.30 );
	vec3 base = MN_ASH * ( 0.55 + 0.95 * dune );
	base = mix( base, MN_IRON_DARK * 0.7, cinder * 0.8 );
	base *= 0.88 + 0.24 * grain;
	f.albedo = base;

	// Ash is the most Lambertian thing in the game. Cinders are slightly glassy.
	f.rough = 0.985 - cinder * 0.22;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'bonelitter',
    tag: 'bone',
    tier: 'main',
    tile: 1.8,
    heightScale: 0.05,
    roughHint: 0.80,
    doc: 'Bone litter over packed earth — the crypt floor of an ossuary.',
    glsl: /* glsl */ `
	// The ground the bones lie on. Kept simple; it is mostly hidden.
	float macro = mnFbm( uv * 6.0, vec2( 6.0 ), 3, 0.55 );
	float fine = mnFbm( uv * 60.0, vec2( 60.0 ), 3, 0.5 );
	float groundH = 0.40 + ( macro - 0.5 ) * 0.18 + ( fine - 0.5 ) * 0.07;
	vec3 groundC = MN_DIRT * ( 0.6 + 0.9 * macro ) * ( 0.85 + 0.3 * fine );

	// Two shard populations: long bones and smaller chips.
	//
	// The chip population was 14 cells across a 1.8 m repeat, which put its
	// shards at about one screen pixel and turned the whole surface into white
	// static. Anything meant to be READ as an object rather than as a texture
	// has to be at least three or four pixels across at the distance it is seen,
	// and on this floor that means nothing below about 8 cm.
	vec3 big = mnShards( uv, vec2( 5.0 ), 0.60, 0.70, 0.135 );
	vec3 small = mnShards( uv + 0.37, vec2( 9.0 ), 0.34, 0.48, 0.105 );

	float m = max( big.x, small.x * 0.9 );
	float id = big.x >= small.x * 0.9 ? big.y : small.y;
	float dome = big.x >= small.x * 0.9 ? big.z : small.z;

	f.height = clamp( mix( groundH, 0.58 + dome * 0.36, m ), 0.0, 1.0 );

	// Bone is the lightest thing on a crypt floor and needs to stay that way or
	// the litter stops reading — but not by so much that it blows out: at 0.42
	// linear it is eight times the reflectance of the flagstone around it, so
	// the range here is pulled down and the staining below does the rest.
	vec3 boneC = MN_BONE * ( 0.38 + 0.42 * mnHash11( id * 43.1 ) );
	float stain = smoothstep( 0.7, 0.1, dome ) * ( 0.4 + 0.6 * mnFbm( uv * 40.0, vec2( 40.0 ), 2, 0.5 ) );
	boneC = mix( boneC, boneC * mix( vec3( 1.0 ), MN_DIRT * 12.0, 0.55 ), stain * 0.75 );
	// Longitudinal striations along each shard.
	float striae = mnStreak( uv * 90.0, vec2( 90.0 ), 8.0, 2 );
	boneC *= 0.90 + 0.20 * striae;

	f.albedo = mix( groundC, boneC, m );
	f.rough = mix( 0.96, 0.52 + stain * 0.30 + ( striae - 0.5 ) * 0.10, m );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'water',
    tag: 'water',
    tier: 'main',
    tile: 3.0,
    heightScale: 0.004,
    roughHint: 0.08,
    doc: 'Standing water. Near-mirror; the render pipeline\'s SSR does the rest.',
    glsl: /* glsl */ `
	// Two crossed capillary wave trains plus a slow swell. Real standing water in
	// a still room is not flat — it has a millimetre of wander that smears every
	// reflected flame into a vertical streak, and that streak is the effect.
	float w1 = mnPerlin( vec2( uv.x * 9.0 + uv.y * 2.0, uv.y * 11.0 ), vec2( 9.0, 11.0 ) );
	float w2 = mnPerlin( vec2( uv.x * 17.0 - uv.y * 4.0, uv.y * 6.0 ) + 13.0, vec2( 17.0, 6.0 ) );
	float swell = mnFbmP( uv * 3.0, vec2( 3.0 ), 3, 0.6 );

	f.height = clamp( 0.5 + ( w1 - 0.5 ) * 0.45 + ( w2 - 0.5 ) * 0.30 + ( swell - 0.5 ) * 0.5, 0.0, 1.0 );

	// Water's diffuse albedo is essentially the silt below it. Very dark, very
	// slightly green-brown, so the specular does all the work.
	vec3 silt = mix( MN_DIRT * 0.55, MN_MOSS * 0.7, 0.35 + 0.3 * swell );
	f.albedo = silt * ( 0.7 + 0.6 * swell );

	// Scum and dust film breaks the mirror in patches — a perfectly uniform
	// roughness on water is the giveaway that it is a shader and not a puddle.
	float film = smoothstep( 0.55, 0.85, mnFbm( uv * 7.0 + 5.0, vec2( 7.0 ), 3, 0.55 ) );
	f.rough = mix( 0.045, 0.34, film );
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  // =========================================================================
  // METAL
  // =========================================================================
  {
    id: 'iron',
    tag: 'metal',
    tier: 'main',
    tile: 0.9,
    heightScale: 0.02,
    roughHint: 0.46, metalHint: 1.0,
    doc: 'Blackened wrought iron — hammered, scaled, forge-finished.',
    glsl: /* glsl */ `
	// Hammer planishing: overlapping shallow facets left by the smith's hammer.
	const vec2 C = vec2( 11.0 );
	vec4 hv = mnWorleyVec( uv * C, C, 0.85 );
	float hb = mnWorleyBorder( uv * C, C, 0.85, hv.xy );
	float facet = smoothstep( 0.0, 0.28, hb );
	float dent = ( 1.0 - facet ) * 0.5 + facet * ( 0.6 + 0.4 * hv.z );

	// Forge scale: the flaky black oxide that forms on hot-worked iron. It is
	// what makes wrought iron read as *forged* rather than as cast or machined.
	float scale = mnFbm( uv * 30.0, vec2( 30.0 ), 4, 0.55 );
	float flake = smoothstep( 0.58, 0.72, scale );
	float grind = mnStreak( uv * 60.0, vec2( 60.0 ), 10.0, 3 );

	f.height = clamp( 0.62 + ( dent - 0.5 ) * 0.28 + ( scale - 0.5 ) * 0.10 - flake * 0.06 + ( grind - 0.5 ) * 0.03, 0.0, 1.0 );

	// A metal's albedo IS its F0. See MN_METAL_F0_GAIN in surfaces.js.
	vec3 base = MN_IRON_DARK * MN_METAL_F0_GAIN;
	base *= 0.80 + 0.45 * scale;
	base = mix( base, base * 0.55, flake );              // scale is darker than steel
	f.albedo = base;

	// Roughness is where blackened iron lives: dark, but with a broad, dirty
	// specular lobe that catches every brazier.
	f.rough = 0.44 + ( scale - 0.5 ) * 0.30 + flake * 0.26 - ( grind - 0.5 ) * 0.12;
	f.rough = mix( f.rough, f.rough * 0.72, facet );      // planished faces are smoother
	f.metal = 1.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'rustiron',
    tag: 'metal',
    tier: 'main',
    tile: 0.9,
    heightScale: 0.03,
    roughHint: 0.70, metalHint: 0.45,
    doc: 'Rusted iron. Rust is a DIELECTRIC, so metalness genuinely varies across the map.',
    glsl: /* glsl */ `
	float scale = mnFbm( uv * 26.0, vec2( 26.0 ), 4, 0.55 );
	float grind = mnStreak( uv * 55.0, vec2( 55.0 ), 10.0, 3 );

	// Rust blooms: billowed noise thresholded, then eaten into by a second
	// field so the boundary is scalloped rather than a smooth iso-contour.
	vec2 w = mnWarp( uv * 5.0, vec2( 5.0 ), 0.5, 3 );
	float bloom = mnBillow( w, vec2( 5.0 ), 4, 0.6 );
	float rust = smoothstep( 0.30, 0.62, bloom );
	// Rust runs downwards from where it starts; streaks are a strong cue.
	float runs = mnStreak( vec2( uv.y * 8.0, uv.x * 40.0 ), vec2( 8.0, 40.0 ), 7.0, 3 );
	rust = clamp( rust + smoothstep( 0.55, 0.9, runs ) * 0.45 * smoothstep( 0.2, 0.5, bloom ), 0.0, 1.0 );

	// Deep pitting only where the rust has been working for a long time.
	float pit = mnSpeckle( uv * 48.0, vec2( 48.0 ), 0.35, 0.42 ) * smoothstep( 0.5, 0.95, rust );
	// Scabby, blistered rust surface.
	float scab = mnFbm( uv * 60.0, vec2( 60.0 ), 3, 0.5 );

	f.height = clamp( 0.66 + ( scale - 0.5 ) * 0.10 - pit * 0.30 + rust * ( scab - 0.5 ) * 0.22 - rust * 0.05, 0.0, 1.0 );

	vec3 metal = MN_IRON_DARK * MN_METAL_F0_GAIN * ( 0.8 + 0.45 * scale );
	// Iron oxide: orange-brown, built from the fire and dirt palette entries so
	// it sits inside the game's colour identity instead of next to it.
	vec3 rustC = mix( MN_FIRE_DARK * 2.4, MN_DIRT * 3.2, 0.45 + 0.35 * scab );
	rustC *= 0.70 + 0.75 * scab;
	rustC = mix( rustC, rustC * 0.45, smoothstep( 0.6, 1.0, rust ) * 0.5 );   // old rust is darker

	f.albedo = mix( metal, rustC, rust );
	f.rough = mix( 0.46 + ( scale - 0.5 ) * 0.26 - ( grind - 0.5 ) * 0.12, 0.92 + ( scab - 0.5 ) * 0.12, rust );
	// The whole point of this surface: metalness is a MAP, not a constant.
	f.metal = 1.0 - smoothstep( 0.15, 0.55, rust );
	f.alpha = 1.0;
`,
  },

  {
    id: 'bronze',
    tag: 'metal',
    tier: 'main',
    tile: 0.7,
    heightScale: 0.025,
    roughHint: 0.38, metalHint: 0.85,
    doc: 'Cast bronze / gilt trim with patina in the recesses.',
    glsl: /* glsl */ `
	// Cast surface: fine porosity from the mould plus the mould's own texture.
	float porosity = mnSpeckle( uv * 80.0, vec2( 80.0 ), 0.24, 0.30 );
	float castTex = mnFbm( uv * 40.0, vec2( 40.0 ), 3, 0.5 );

	// Engraved banding — a repeating chased ornament along the trim. Two
	// frequencies so it reads as designed rather than as a corrugation.
	float bandCoord = uv.y * 6.0;
	float band = abs( fract( bandCoord ) - 0.5 ) * 2.0;
	float groove = 1.0 - smoothstep( 0.22, 0.42, band );
	float bead = smoothstep( 0.70, 0.95, band ) * ( 0.5 + 0.5 * sin( uv.x * 6.2831853 * 12.0 ) );

	float h = 0.72 - groove * 0.26 + bead * 0.10 + ( castTex - 0.5 ) * 0.06 - porosity * 0.10;

	// Patina collects in the recesses; it is a corrosion product, so it is both
	// dielectric and rough, and it only forms where water sits.
	float patina = smoothstep( 0.55, 0.85, mnFbm( uv * 9.0 + 17.0, vec2( 9.0 ), 4, 0.55 ) );
	patina = clamp( patina + groove * 0.55, 0.0, 1.0 ) * smoothstep( 0.75, 0.35, h );
	h -= patina * 0.03;
	f.height = clamp( h, 0.0, 1.0 );

	vec3 metal = MN_GOLD * ( 0.80 + 0.35 * castTex );
	// Verdigris, mixed from the moss entry so it stays inside the palette.
	vec3 pat = mix( MN_MOSS * 4.5, MN_STONE_COLD * 2.0, 0.35 );
	pat *= 0.7 + 0.7 * mnFbm( uv * 34.0, vec2( 34.0 ), 3, 0.5 );

	f.albedo = mix( metal, pat, patina );
	f.rough = mix( 0.30 + ( castTex - 0.5 ) * 0.22 + porosity * 0.30, 0.88, patina );
	f.metal = 1.0 - smoothstep( 0.2, 0.6, patina );
	f.alpha = 1.0;
`,
  },

  {
    id: 'steel',
    tag: 'metal',
    tier: 'main',
    tile: 0.6,
    heightScale: 0.006,
    roughHint: 0.17, metalHint: 1.0,
    doc: 'Polished steel — blade and plate armour. Fine directional scratches.',
    glsl: /* glsl */ `
	// Polishing scratches at two angles: the coarse pass and the finishing pass.
	float s1 = mnStreak( uv * vec2( 120.0, 120.0 ), vec2( 120.0 ), 26.0, 3 );
	vec2 rp = mnRot90( ( uv - 0.5 ) * 120.0, 1 ) + 60.0;
	float s2 = mnStreak( rp, vec2( 120.0 ), 18.0, 2 );
	// Isolated deeper scratches — battle damage, not manufacturing.
	float deep = smoothstep( 0.80, 0.97, mnStreak( uv * vec2( 40.0, 40.0 ) + 7.0, vec2( 40.0 ), 30.0, 2 ) );

	float dings = mnSpeckle( uv * 26.0, vec2( 26.0 ), 0.12, 0.28 );

	f.height = clamp( 0.80 + ( s1 - 0.5 ) * 0.05 + ( s2 - 0.5 ) * 0.03 - deep * 0.10 - dings * 0.12, 0.0, 1.0 );

	// Polished steel reflectance is high and neutral; derive it from the iron
	// entry so a palette shift moves both together.
	vec3 base = MN_IRON_DARK * MN_METAL_F0_GAIN * 3.6;
	base *= 0.94 + 0.10 * s1;
	// Heat colouring near the edge of a forged blade.
	float temper = smoothstep( 0.35, 0.75, mnFbm( uv * 4.0, vec2( 4.0 ), 3, 0.55 ) );
	f.albedo = mix( base, base * mix( vec3( 1.0 ), MN_FIRE_CORE, 0.16 ), temper * 0.5 );

	f.rough = 0.13 + ( s1 - 0.5 ) * 0.12 + ( s2 - 0.5 ) * 0.07 + deep * 0.30 + dings * 0.25;
	f.metal = 1.0;
	f.alpha = 1.0;
`,
  },

  // =========================================================================
  // ORGANIC
  // =========================================================================
  {
    id: 'plank',
    tag: 'wood',
    tier: 'main',
    tile: 1.5,
    heightScale: 0.03,
    roughHint: 0.88,
    doc: 'Rotted wood plank — boards, grain, knots, splits, nail heads.',
    glsl: /* glsl */ `
	const float BOARDS = 5.0;
	vec4 pl = mnPlanks( uv, BOARDS, 0.35 );
	float local = pl.x;
	float id = pl.y;
	float edge = pl.z;

	// Gap between boards. Boards cup and warp, so the gap is not constant.
	float gapW = 0.030 + 0.030 * mnHash11( id * 11.7 );
	float gap = 1.0 - smoothstep( gapW * 0.4, gapW, edge );

	// Grain runs along x. Each board is cut from a different part of the log, so
	// its ring density and its phase differ.
	vec2 gp = vec2( uv.x * 26.0, ( local + id * 3.1 ) * 5.0 );
	float grain = mnGrain( gp, vec2( 26.0, BOARDS * 5.0 ), 3.0 + id * 2.0, 0.55 );
	float coarse = mnStreak( vec2( uv.x * 40.0, ( local + id ) * 30.0 ), vec2( 40.0, BOARDS * 30.0 ), 12.0, 3 );

	// Cupping: the board's face is concave across its width after years damp.
	float cup = ( local - 0.5 ) * ( local - 0.5 ) * 4.0;

	// Splits and checks along the grain — the signature of rotten timber.
	float split = smoothstep( 0.86, 0.99, mnStreak( vec2( uv.x * 16.0, ( local + id * 7.0 ) * 18.0 ), vec2( 16.0, BOARDS * 18.0 ), 20.0, 3 ) );

	// Knots: a few per board, with the grain swirling around them.
	float knot = mnSpeckle( vec2( uv.x * 7.0, ( local + id * 5.0 ) * 2.0 ), vec2( 7.0, BOARDS * 2.0 ), 0.16, 0.30 );

	float h = 0.76 + ( id - 0.5 ) * 0.08 + cup * 0.09 - grain * 0.07 - ( coarse - 0.5 ) * 0.05;
	h -= split * 0.20;
	h += knot * 0.05;
	float gapH = 0.24 + 0.10 * mnFbm( uv * 40.0, vec2( 40.0 ), 2, 0.5 );
	f.height = clamp( mix( h, gapH, gap ), 0.0, 1.0 );

	// ---- albedo --------------------------------------------------------
	vec3 base = MN_WOOD * ( 0.62 + 0.95 * mnHash11( id * 29.3 ) );
	// Latewood bands are darker and denser.
	base *= 1.0 - grain * 0.45;
	base *= 0.88 + 0.26 * coarse;
	// Silvered, sun/damp-bleached surface where the wood is exposed.
	float weather = smoothstep( 0.35, 0.80, mnFbm( uv * 6.0 + 3.0, vec2( 6.0 ), 3, 0.55 ) );
	base = mix( base, mix( base, MN_ASH * 0.85, 0.60 ), weather * 0.7 );
	// Wet rot: dark, almost black, spreading from the gaps.
	float rot = smoothstep( 0.45, 0.85, mnFbm( uv * 4.0 + 21.0, vec2( 4.0 ), 4, 0.6 ) ) * ( 0.4 + 0.6 * gap );
	base = mix( base, base * 0.28, rot );
	base = mix( base, base * 0.45, split * 0.8 );
	base = mix( base, MN_WOOD * 0.35, knot * 0.7 );

	// Hand-forged nail heads: two per board, square, proud, and rusted.
	float nail = mnSpeckle( vec2( uv.x * 3.0, ( local + id * 3.0 ) * 1.0 ), vec2( 3.0, BOARDS ), 0.55, 0.11 );
	f.height = clamp( f.height + nail * 0.14, 0.0, 1.0 );
	vec3 nailC = mix( MN_FIRE_DARK * 2.0, MN_IRON_DARK * MN_METAL_F0_GAIN, 0.45 );

	f.albedo = mix( mix( base, MN_DIRT * 1.6, gap * 0.7 ), nailC, nail );
	f.rough = mix( 0.88 + grain * 0.08 - weather * 0.05 + rot * 0.06, 0.62, nail );
	f.metal = nail * 0.55;
	f.alpha = 1.0;
`,
  },

  {
    id: 'beam',
    tag: 'wood',
    tier: 'minor',
    tile: 2.2,
    heightScale: 0.04,
    roughHint: 0.90,
    doc: 'Weathered structural beam — adze facets, deep checks, iron banding marks.',
    glsl: /* glsl */ `
	// Adze facets: a hewn beam is a series of shallow scoops along its length.
	float facetX = uv.x * 9.0;
	float fi = floor( facetX );
	float fl = facetX - fi;
	float fid = mnHash11( mod( fi, 9.0 ) * 3.7 );
	float scoop = sin( fl * 3.14159265 ) * ( 0.6 + 0.4 * fid );

	// Grain along the beam with strong medullary figure.
	float grain = mnGrain( vec2( uv.x * 30.0, uv.y * 6.0 ), vec2( 30.0, 6.0 ), 4.0, 0.7 );
	float fibre = mnStreak( vec2( uv.x * 70.0, uv.y * 45.0 ), vec2( 70.0, 45.0 ), 16.0, 3 );

	// Drying checks: long, deep, following the grain. On a big timber these are
	// centimetres wide and they catch light like nothing else on the surface.
	float check = smoothstep( 0.80, 0.98, mnStreak( vec2( uv.x * 10.0, uv.y * 13.0 ) + 11.0, vec2( 10.0, 13.0 ), 26.0, 3 ) );

	float h = 0.78 + scoop * 0.10 - grain * 0.06 - ( fibre - 0.5 ) * 0.05 - check * 0.26;
	f.height = clamp( h, 0.0, 1.0 );

	vec3 base = MN_WOOD * ( 0.55 + 0.7 * fid );
	base *= 1.0 - grain * 0.40;
	base *= 0.86 + 0.28 * fibre;
	float weather = smoothstep( 0.30, 0.75, mnFbmP( uv * 3.0, vec2( 3.0 ), 3, 0.55 ) );
	base = mix( base, mix( base, MN_ASH * 0.75, 0.65 ), weather * 0.75 );
	base = mix( base, base * 0.30, check );
	f.albedo = base;

	f.rough = 0.90 - weather * 0.06 + grain * 0.06 + check * 0.05;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'banner',
    tag: 'cloth',
    tier: 'main',
    tile: 1.2,
    heightScale: 0.012,
    roughHint: 0.90,
    alphaTest: 0.45,
    doc: 'Torn cloth banner. Uses the ALPHA channel — the bottom edge is genuinely ragged.',
    glsl: /* glsl */ `
	const vec2 THREADS = vec2( 90.0, 90.0 );
	vec2 wv = mnWeave( uv, THREADS );

	// Drape: broad folds that the normal map has to carry, because the geometry
	// is a flat quad and everything that makes it read as cloth lives here.
	float fold = mnFbmP( vec2( uv.x * 3.0, uv.y * 1.5 ), vec2( 3.0, 2.0 ), 3, 0.6 );
	float crease = mnStreak( vec2( uv.y * 5.0, uv.x * 3.0 ), vec2( 5.0, 3.0 ), 4.0, 2 );

	// Thread irregularity — hand-woven cloth has slubs.
	float slub = mnFbm( uv * 40.0, vec2( 40.0 ), 2, 0.5 );

	f.height = clamp( 0.55 + wv.x * 0.5 + ( fold - 0.5 ) * 0.42 + ( crease - 0.5 ) * 0.16 + ( slub - 0.5 ) * 0.10, 0.0, 1.0 );

	// ---- dye + wear -----------------------------------------------------
	// A once-red banner, sun-bleached and filthy. The dye survives in the folds
	// where light never reached it.
	vec3 dye = mix( MN_CLOTH, MN_BLOOD_CORE * 0.5, 0.55 );
	float bleach = smoothstep( 0.25, 0.85, mnFbmP( uv * 2.5, vec2( 3.0 ), 3, 0.55 ) );
	vec3 base = mix( dye, mix( dye, MN_ASH * 0.8, 0.7 ), bleach );
	// Warp and weft take dye differently, which is what stops flat cloth colour.
	base *= mix( 0.86, 1.10, wv.y );
	base *= 0.86 + 0.28 * slub;
	// Grime along the bottom and in the creases.
	base *= mix( 1.0, 0.55, smoothstep( 0.45, 1.0, uv.y ) * 0.8 );
	f.albedo = base;

	// ---- tearing --------------------------------------------------------
	// The lower edge is eaten away, and there are holes higher up. The mask is
	// thresholded from a warped field so the tear follows the weave.
	vec2 tw = mnWarp( uv * 7.0, vec2( 7.0 ), 0.6, 3 );
	float rot = mnFbm( tw, vec2( 7.0 ), 4, 0.6 );
	float hemDist = smoothstep( 0.60, 1.0, uv.y );        // 0 at top, 1 at hem
	float holes = smoothstep( 0.70, 0.78, rot ) * smoothstep( 0.1, 0.5, uv.y );
	float alpha = 1.0 - clamp( holes + smoothstep( 0.42, 0.68, rot ) * hemDist * 1.6, 0.0, 1.0 );

	// Frayed threads: near the cut, alpha becomes stringy along the weave.
	float fray = smoothstep( 0.30, 0.0, abs( alpha - 0.5 ) ) * ( 0.5 + 0.5 * sin( uv.x * THREADS.x * 3.14159265 ) );
	f.alpha = clamp( alpha + fray * 0.35, 0.0, 1.0 );

	// Cloth is rough everywhere; the variation is in how compressed the weave is.
	f.rough = 0.90 - wv.x * 0.10 + ( slub - 0.5 ) * 0.10;
	f.metal = 0.0;
`,
  },

  {
    id: 'leather',
    tag: 'cloth',
    tier: 'main',
    tile: 0.8,
    heightScale: 0.018,
    roughHint: 0.62,
    doc: 'Oiled leather — pebbled grain, creases, worn edges.',
    glsl: /* glsl */ `
	// Pebble grain: the follicle pattern of a hide. Small, dense, irregular.
	const vec2 C = vec2( 42.0 );
	vec4 pv = mnWorleyVec( uv * C, C, 1.0 );
	float pb = mnWorleyBorder( uv * C, C, 1.0, pv.xy );
	float pebble = smoothstep( 0.0, 0.22, pb );

	// Creases from flexing — long, branching, and much deeper than the grain.
	vec2 w = mnWarp( uv * 4.0, vec2( 4.0 ), 0.7, 3 );
	float crease = smoothstep( 0.55, 0.95, mnRidged( w, vec2( 4.0 ), 4, 0.55 ) );

	// Pores.
	float pore = mnSpeckle( uv * 100.0, vec2( 100.0 ), 0.30, 0.24 );

	f.height = clamp( 0.72 + pebble * 0.18 - crease * 0.26 - pore * 0.08, 0.0, 1.0 );

	vec3 base = mix( MN_WOOD * 1.5, MN_CLOTH, 0.35 );
	base *= 0.78 + 0.45 * pv.z;
	base *= 0.90 + 0.20 * pebble;
	// Wear: the high points are rubbed pale and smooth, the creases hold oil.
	float wear = smoothstep( 0.55, 0.95, mnFbmP( uv * 3.0, vec2( 3.0 ), 3, 0.55 ) );
	base = mix( base, base * 1.9, wear * pebble * 0.5 );
	base = mix( base, base * 0.45, crease );
	f.albedo = base;

	f.rough = 0.62 - wear * 0.24 * pebble + crease * 0.22 + pore * 0.10;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'flesh',
    tag: 'flesh',
    tier: 'main',
    tile: 0.7,
    heightScale: 0.02,
    roughHint: 0.40,
    doc: 'Raw flesh / exposed muscle. Wet, veined, unpleasant.',
    glsl: /* glsl */ `
	// Muscle fibre bundles running in one direction.
	float fibre = mnStreak( vec2( uv.x * 26.0, uv.y * 90.0 ), vec2( 26.0, 90.0 ), 14.0, 3 );
	float bundle = mnStreak( vec2( uv.x * 7.0, uv.y * 26.0 ), vec2( 7.0, 26.0 ), 8.0, 3 );

	// Vasculature: a branching ridged network, warped hard so it does not read
	// as noise. Veins sit proud of the surface and are darker.
	vec2 w = mnWarp( uv * 5.0, vec2( 5.0 ), 0.9, 3 );
	float vein = smoothstep( 0.66, 0.95, mnRidged( w, vec2( 5.0 ), 4, 0.6 ) );
	float capil = smoothstep( 0.74, 0.97, mnRidged( mnWarp( uv * 16.0 + 9.0, vec2( 16.0 ), 0.6, 2 ), vec2( 16.0 ), 3, 0.55 ) );

	float lump = mnFbmP( uv * 6.0, vec2( 6.0 ), 3, 0.6 );

	f.height = clamp( 0.66 + ( lump - 0.5 ) * 0.30 + ( bundle - 0.5 ) * 0.18 + ( fibre - 0.5 ) * 0.10 + vein * 0.10, 0.0, 1.0 );

	// Desaturated meat: built from the blood palette so it belongs to the same
	// world as the decals fx will spray on top of it.
	vec3 muscle = mix( MN_BLOOD_CORE * 0.75, MN_BLOOD_DARK * 3.0, 0.45 + 0.35 * lump );
	muscle *= 0.80 + 0.45 * bundle;
	muscle = mix( muscle, MN_BLOOD_DARK * 1.6, vein * 0.8 );
	muscle = mix( muscle, MN_BLOOD_CORE * 0.35, capil * 0.5 );
	// Fascia: pale, silvery connective sheets over some of the bundles.
	float fascia = smoothstep( 0.62, 0.88, mnFbm( uv * 9.0 + 4.0, vec2( 9.0 ), 3, 0.55 ) );
	muscle = mix( muscle, mix( muscle, MN_BONE * 0.45, 0.65 ), fascia * 0.7 );
	f.albedo = muscle;

	// Wet everywhere, wetter in the hollows. This is what makes it revolting.
	f.rough = 0.34 + ( 1.0 - f.height ) * 0.18 + fascia * 0.16 - vein * 0.08;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'chitin',
    tag: 'flesh',
    tier: 'main',
    tile: 0.6,
    heightScale: 0.025,
    roughHint: 0.32,
    doc: 'Insectoid chitin plate — overlapping scutes with a hard, dark sheen.',
    glsl: /* glsl */ `
	// Overlapping scutes. A brick lattice with a strong stagger reads as an
	// armoured carapace once each unit is domed and its leading edge is sharp.
	const vec2 COUNTS = vec2( 7.0, 11.0 );
	vec4 br = mnBrick( uv, COUNTS, 0.5, 0.06 );
	vec2 local = br.xy;
	float id = br.z;

	// Dome each scute, biased so the trailing edge is thin (it slides under the
	// next plate) and the leading edge is thick.
	float dx = ( local.x - 0.5 ) * 2.0;
	float dome = sqrt( max( 0.0, 1.0 - dx * dx ) ) * smoothstep( 0.0, 0.55, local.y );
	float lip = smoothstep( 0.90, 1.0, local.y );

	// Concentric growth ridges on each plate.
	float ridge = 0.5 + 0.5 * sin( ( local.y * 9.0 + id * 6.0 ) * 3.14159265 );
	ridge *= smoothstep( 0.05, 0.35, local.y );
	// Fine pitting.
	float pit = mnSpeckle( uv * 90.0, vec2( 90.0 ), 0.22, 0.26 );

	float h = 0.42 + dome * 0.42 + ridge * 0.05 - pit * 0.06 + lip * 0.06;
	float seam = 1.0 - smoothstep( 0.0, 0.05, min( local.y, 1.0 - local.y ) );
	f.height = clamp( mix( h, 0.24, seam ), 0.0, 1.0 );

	// Near-black with a hue that shifts across the dome — a cheap stand-in for
	// the thin-film iridescence of a real carapace, which MeshStandard cannot do.
	vec3 base = mix( MN_IRON_DARK * 1.6, MN_CRYSTAL * 0.22, 0.35 + 0.5 * dome );
	base = mix( base, MN_BLOOD_DARK * 2.2, ( 1.0 - dome ) * 0.4 );
	base *= 0.70 + 0.55 * id;
	base *= 0.92 + 0.16 * ridge;
	f.albedo = base;

	// Hard and glossy on the crown, matte where it is scuffed and in the seams.
	float scuff = smoothstep( 0.55, 0.9, mnFbm( uv * 12.0, vec2( 12.0 ), 3, 0.55 ) );
	f.rough = 0.22 + scuff * 0.35 + pit * 0.20 + seam * 0.30 - dome * 0.06;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'bone',
    tag: 'bone',
    tier: 'main',
    tile: 0.9,
    heightScale: 0.02,
    roughHint: 0.72,
    doc: 'Old bone — porous, striated, stained in the pits.',
    glsl: /* glsl */ `
	// Cortical porosity: many small foramina, a few large ones.
	float pore = mnSpeckle( uv * 70.0, vec2( 70.0 ), 0.34, 0.30 );
	float bigPore = mnSpeckle( uv * 22.0 + 3.0, vec2( 22.0 ), 0.16, 0.28 );

	// Longitudinal striations from the vascular canals.
	float striae = mnStreak( vec2( uv.x * 55.0, uv.y * 20.0 ), vec2( 55.0, 20.0 ), 12.0, 3 );
	// Broad surface undulation — bone is never a plane.
	float macro = mnFbmP( uv * 4.0, vec2( 4.0 ), 3, 0.6 );
	// Hairline cracks from drying.
	float crack = mnCracks( uv, vec2( 1.0 ), 9.0, 0.09, 0.5 );

	f.height = clamp( 0.76 + ( macro - 0.5 ) * 0.22 + ( striae - 0.5 ) * 0.10 - pore * 0.14 - bigPore * 0.22 - crack * 0.12, 0.0, 1.0 );

	vec3 base = MN_BONE * ( 0.62 + 0.5 * macro );
	base *= 0.90 + 0.20 * striae;
	// Age staining: tannin and grave-dirt collecting in every recess. Without
	// this, bone renders as a clean white plastic and reads as a prop.
	float low = 1.0 - smoothstep( 0.55, 0.95, f.height );
	vec3 stainC = mix( MN_DIRT * 6.0, MN_WOOD * 3.0, 0.4 );
	base = mix( base, base * 0.35 + stainC * 0.10, low * 0.85 );
	base = mix( base, base * 0.5, crack * 0.7 );
	f.albedo = base;

	// Dry bone is chalky; the stained recesses are slightly waxy.
	f.rough = 0.72 - low * 0.16 + pore * 0.14 + ( striae - 0.5 ) * 0.08;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  // =========================================================================
  // ARCANE
  // =========================================================================
  {
    id: 'obsidian',
    tag: 'crystal',
    tier: 'main',
    tile: 1.3,
    heightScale: 0.03,
    roughHint: 0.16,
    doc: 'Obsidian — conchoidal fracture, flat facets, near-mirror.',
    glsl: /* glsl */ `
	// Large facets from a plane-per-cell decomposition, plus a second finer
	// generation so the fracture has scale hierarchy the way real glass does.
	vec3 f1 = mnFacets( uv, vec2( 4.0 ), 0.9, 0.30 );
	vec3 f2 = mnFacets( uv + 0.31, vec2( 11.0 ), 0.9, 0.14 );

	float h = f1.x * 0.72 + f2.x * 0.28;
	// Conchoidal ripples: the concentric shell marks left by a shear fracture.
	float ripple = 0.5 + 0.5 * sin( ( f1.x * 26.0 + f2.x * 9.0 ) * 3.14159265 );
	h += ripple * 0.02 * ( 1.0 - f1.z );
	f.height = clamp( h, 0.0, 1.0 );

	// Volcanic glass is essentially black with a faint warm-brown transmission
	// at thin edges — approximated here as a brightening on the crease lines.
	vec3 base = MN_IRON_DARK * 0.55;
	base = mix( base, mix( MN_IRON_DARK * 2.0, MN_FIRE_DARK * 1.2, 0.5 ), f1.z * 0.6 + f2.z * 0.3 );
	// Flow banding — the frozen record of the lava it came from.
	float band = mnStreak( vec2( uv.x * 8.0, uv.y * 30.0 ), vec2( 8.0, 30.0 ), 9.0, 3 );
	base *= 0.82 + 0.36 * band;
	base *= 0.85 + 0.30 * f1.y;
	f.albedo = base;

	// Very smooth on the faces, frosted along the creases where the fracture
	// chattered. That contrast is the whole material.
	f.rough = 0.075 + f1.z * 0.42 + f2.z * 0.22 + ( band - 0.5 ) * 0.05;
	f.metal = 0.0;
	f.alpha = 1.0;
`,
  },

  {
    id: 'crystal',
    tag: 'crystal',
    tier: 'main',
    tile: 1.0,
    heightScale: 0.04,
    roughHint: 0.18,
    emissive: 'shadow',
    doc: 'Violet shadow crystal. The signature colour. Emissive mask = facet cores.',
    glsl: /* glsl */ `
	// Prismatic facets: fewer, larger, more regular than obsidian's fracture.
	vec3 fa = mnFacets( uv, vec2( 3.0 ), 0.55, 0.42 );
	vec3 fb = mnFacets( uv * 1.0 + 0.53, vec2( 8.0 ), 0.7, 0.16 );

	// Internal fracture planes, visible through the surface.
	float flaw = smoothstep( 0.62, 0.92, mnRidged( mnWarp( uv * 7.0, vec2( 7.0 ), 0.5, 2 ), vec2( 7.0 ), 3, 0.55 ) );

	float h = fa.x * 0.74 + fb.x * 0.26;
	f.height = clamp( h + flaw * 0.03, 0.0, 1.0 );

	// Deep violet body. The crystal palette entry is already the right hue; the
	// variation here is in saturation and value, never in hue, because shadow
	// violet is the one colour in the game that must stay exactly on-model.
	vec3 base = MN_CRYSTAL * ( 0.35 + 0.75 * fa.y );
	base = mix( base, MN_SHADOW_CORE * 0.55, fb.y * 0.35 );
	// Crease lines scatter light and look pale.
	base = mix( base, mix( base, MN_SHADOW_GLOW * 0.4, 0.7 ), ( fa.z * 0.7 + fb.z * 0.4 ) );
	base = mix( base, base * 1.8, flaw * 0.5 );
	f.albedo = base;

	f.rough = 0.10 + fa.z * 0.40 + fb.z * 0.20 + flaw * 0.12;
	f.metal = 0.0;
	f.alpha = 1.0;

	// Light comes from INSIDE the stone: the facet crowns and the internal
	// fracture planes carry it, the creases between facets do not.
	f.emissiveMask = clamp( smoothstep( 0.42, 0.92, h ) * 0.85 + flaw * 0.6, 0.0, 1.0 );
`,
  },

  {
    id: 'runestone',
    tag: 'stone',
    tier: 'hero',
    tile: 1.6,
    heightScale: 0.05,
    roughHint: 0.80,
    emissive: 'shadow',
    doc: 'Rune-carved stone. Deep glyph channels — the best POM showcase in the set.',
    glsl: /* glsl */ `
	// ---- the stone the runes are cut into -------------------------------
	float chisel = mnStreak( uv * 26.0, vec2( 26.0 ), 8.0, 3 );
	float coarse = mnFbm( uv * 11.0, vec2( 11.0 ), 3, 0.55 );
	float fleck = mnSpeckle( uv * 84.0, vec2( 84.0 ), 0.26, 0.26 );
	float darkFleck = mnSpeckle( uv * 52.0 + 5.0, vec2( 52.0 ), 0.20, 0.32 );

	// A shallow border frame, as an inscribed slab has.
	vec2 fd = min( uv, 1.0 - uv );
	float frame = 1.0 - smoothstep( 0.035, 0.055, min( fd.x, fd.y ) );
	float framePanel = smoothstep( 0.055, 0.075, min( fd.x, fd.y ) );

	float stone = 0.84 + ( coarse - 0.5 ) * 0.12 + ( chisel - 0.5 ) * 0.06 - darkFleck * 0.03;
	stone -= frame * 0.10;
	stone -= ( 1.0 - framePanel ) * 0.02;

	// ---- the carving ----------------------------------------------------
	// One inscription at 53 cm per glyph plus a sparse marginal gloss. This was
	// four glyph columns and a dense second layer first, and at the sizes this
	// texture is actually seen at the strokes merged into blobs — the thing that
	// makes a rune read as writing is the WHITE SPACE around a thin stroke, so
	// the cell count comes down and the stroke width comes down with it.
	float g1 = mnRunes( uv, vec2( 3.0, 3.0 ), 0.072 );
	float g2 = mnRunes( uv * 1.0 + 0.5, vec2( 6.0, 6.0 ), 0.055 ) * 0.42;
	float glyph = clamp( max( g1, g2 ) * framePanel, 0.0, 1.0 );

	// A V-cut channel: deepest in the middle of the stroke.
	float depth = glyph * glyph * ( 3.0 - 2.0 * glyph );
	f.height = clamp( stone - depth * 0.42, 0.0, 1.0 );

	// ---- albedo ---------------------------------------------------------
	vec3 base = mix( MN_STONE_COLD, MN_STONE_WARM, 0.30 + 0.4 * coarse );
	base *= 0.80 + 0.45 * coarse;
	base *= 1.0 + fleck * 0.80 - darkFleck * 0.30;
	base *= 0.90 + 0.20 * chisel;
	// The cut faces are fresher stone: lighter, and they hold shadow-black soot
	// from whatever was burned in the channels.
	base = mix( base, base * 1.35, glyph * 0.5 );
	base = mix( base, base * 0.30, depth * 0.7 );
	f.albedo = base;

	f.rough = 0.80 + ( chisel - 0.5 ) * 0.14 - fleck * 0.28 + depth * 0.10;
	f.metal = 0.0;
	f.alpha = 1.0;

	// The emissive mask rides in the carved depth, and it is deliberately TIGHT:
	// only the bottom of a channel glows, so the light reads as coming from
	// inside the rock rather than as paint smeared over the carving.
	f.emissiveMask = smoothstep( 0.45, 0.86, depth );
`,
  },
];

/** id -> entry, built once. */
export const SURFACE_BY_ID = new Map(SURFACES.map((s) => [s.id, s]));

/** Surfaces baked eagerly during `prewarmMaterials`. Everything else bakes the
 *  first time someone asks for it, which on this software rasteriser is the
 *  difference between a 6-second boot and a 25-second one. The list is exactly
 *  what a first room needs to draw. */
export const CORE_SURFACES = ['flagstone', 'granite', 'vault', 'dirt', 'iron', 'plank', 'runestone', 'gravel'];
