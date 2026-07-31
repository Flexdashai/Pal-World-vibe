import * as THREE from 'three';
import { ELEMENTS, LIGHTS } from '../core/palette.js';

/**
 * STUB — still owned by the `world` agent, still to be replaced by a real
 * procedural dungeon generator. What it is no longer is a scene of untextured
 * primitives lit by a placeholder sun.
 *
 * INTEGRATION-GATE NOTE (read this before rewriting the file)
 * ----------------------------------------------------------
 * This stub exists to keep every published cross-subsystem contract LIVE, so the
 * subsystems that depend on `world` can be reviewed at all. Four contracts were
 * dead before and are exercised here; a rewrite must keep exercising them:
 *
 *  1. `ctx.get('materials').get(name, opts)` — every world surface comes from the
 *     shared library. Nothing here constructs a THREE material for a world
 *     surface. Geometry is built with **UVs in metres** (see `boxUvMetres` and
 *     the floor), which is the one convention the library requires; geometry
 *     that cannot do that asks for `{ triplanar: true }`.
 *
 *  2. `sky` owns the key light. This file deliberately creates **no directional
 *     and no hemisphere light**. `sky._electKeyLight` adopts any shadow-casting
 *     directional it finds and then stops driving the moon from its own
 *     ephemeris — so the placeholder `DirectionalLight(intensity 2.2)` that used
 *     to live here silently disabled the whole atmosphere model and flat-lit
 *     every frame (analyze.mjs read it as FLAT_CONTRAST on six of thirteen
 *     shots). In a crypt the key IS the brazier, exactly as ARCHITECTURE.md
 *     says, and ambient comes from sky's PMREM rather than from a hemisphere
 *     light stacked on top of it.
 *
 *  3. `ctx.peek('physics').addStatic(mesh, { surface })` — collision is
 *     registered explicitly with real surface tags, which retires physics'
 *     fallback scene scan and is what makes footstep audio, impact FX and decals
 *     pick the right surface.
 *
 *  4. `render.registerOccluderFade(mesh)` — at this camera pitch the −X/−Z walls
 *     stand between the camera and the player, so they are registered and dither
 *     open around them.
 *
 * The layout itself is throwaway: one flagstone hall with a colonnade, a shrine
 * alcove, a corridor spur and a lower arena, sized so the five debug landmarks
 * the shot harness frames all land on something worth photographing.
 */

/** Room half-extent in metres. The camera sees roughly 30 m across at the hero
 *  boom, so this is a little over one screen in each direction — enough that a
 *  shot never frames the void, small enough to be one BVH build. */
const HALF = 26;
/** Walls sit just above the 4 m occlusion threshold ARCHITECTURE.md calls out:
 *  tall enough to enclose, short enough that the occluder fade has to actually
 *  work rather than being decorative. */
const WALL_H = 4.4;
const WALL_T = 1.1;

/**
 * Rewrite a BoxGeometry's UVs from three's per-face 0..1 into metres.
 *
 * The material library is calibrated on "geometry UVs are in metres" — that is
 * what makes `tile` mean metres-per-repeat and what makes parallax depth
 * physically correct. A default box hands every face a 0..1 square regardless of
 * that face's size, so a 36 m wall and a 1 m block would get the same number of
 * repeats, and the difference in texel density between two adjacent objects is
 * the most visible tiling artefact there is.
 *
 * three lays BoxGeometry faces out in the fixed order px, nx, py, ny, pz, nz,
 * four vertices each for an unsegmented box, so the per-face metre extents are
 * known without inspecting positions.
 */
function boxUvMetres(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const ext = [
    [d, h], [d, h],   // +X, -X
    [w, d], [w, d],   // +Y, -Y
    [w, h], [w, h],   // +Z, -Z
  ];
  for (let f = 0; f < 6; f++) {
    const su = ext[f][0], sv = ext[f][1];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/** Named landmarks the shot harness frames. Coordinates never leave this file. */
const LANDMARKS = {
  hall: { pos: [0.5, 0, -1.5], look: [0.5, 0, -1.5] },
  corridor: { pos: [7.0, 0, 6.4], look: [7.0, 0, 6.4] },
  // On the shrine's low bottom step, just clear of the 0.64 m DAIS. The harness
  // teleports the player onto the landmark, so a landmark inside the dais gets
  // the capsule depenetrated up onto it and hidden behind the monolith — the
  // `shrine` shot came back with no player in it at all. Standing on the 0.22 m
  // step is fine and reads as approaching the altar.
  shrine: { pos: [-5.0, 0, -1.7], look: [-5.0, 0, -1.7] },
  arena: { pos: [-1.0, 0, -13.0], look: [-1.0, 0, -13.0] },
  gate: { pos: [12.6, 0, 2.4], look: [12.6, 0, 2.4] },
};

export class WorldSystem {
  static id = 'world';
  /** `physics` is reached through `ctx.peek` at runtime and is optional, but
   *  `render` and `materials` are hard prerequisites — declaring them makes the
   *  registry order us after them instead of leaving it to registration luck. */
  static deps = ['render', 'materials'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();

    const mats = ctx.get('materials');
    const render = ctx.get('render');
    const physics = ctx.peek('physics');

    this.root = new THREE.Group();
    this.root.name = 'mn.world';
    ctx.scene.add(this.root);

    /** Everything we created, so dispose() is exhaustive rather than a guess.
     *  Library materials are NOT in here — `materials` owns and disposes those. */
    this._geometries = [];
    this._braziers = [];
    this._staticIds = [];
    this.walls = [];

    this._buildFloor(mats, physics);
    this._buildWalls(mats, render, physics);
    this._buildColonnade(mats, physics);
    this._buildShrine(mats, physics);
    this._buildRubble(mats, physics);
    this._buildBraziers(mats, render, physics);

    // Preallocated: the payload is emitted once, but `spawn` is a live reference
    // other subsystems may hold.
    this._spawn = new THREE.Vector3(0, 0, 0);
    this._ready = { level: 1, rooms: Object.keys(LANDMARKS).length, spawn: this._spawn };

    ctx.events.emit('world:ready', this._ready);
  }

  // =========================================================================
  // construction
  // =========================================================================

  /**
   * The floor: a 64 m flagstone slab whose UVs are its metre coordinates, with a
   * few centimetres of long-wavelength sag baked into the vertices.
   *
   * The sag is not decoration. `floor.crypt` is a wet material, and a perfectly
   * planar floor gives the entire specular lobe one identical normal, so a
   * brazier reflects as a single symmetric blob. A ±4 cm undulation over a ~9 m
   * period pools the highlight into streaks, which is the whole "damp flagstone"
   * read that Diablo IV interiors are built on.
   */
  _buildFloor(mats, physics) {
    const S = HALF * 2 + 12;
    const geo = new THREE.PlaneGeometry(S, S, 64, 64);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      // Two incommensurate sine pairs: no visible repeat at this scale, no noise
      // texture needed, and identical on every run.
      pos.setY(
        i,
        Math.sin(x * 0.34) * Math.cos(z * 0.29) * 0.030 +
        Math.sin(x * 0.11 + 1.7) * Math.sin(z * 0.13 - 0.6) * 0.045
      );
      uv.setXY(i, x, z);           // UVs in metres — the library's hard convention
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this._geometries.push(geo);

    const floor = new THREE.Mesh(geo, mats.get('floor.crypt', { wet: 0.34, moss: 0.13 }));
    floor.name = 'mn.world.floor';
    floor.receiveShadow = true;
    floor.castShadow = false;
    this.root.add(floor);
    this.floor = floor;

    // 8k near-planar triangles would dominate the BVH for no accuracy at all.
    // `box:true` is the documented escape hatch and gives a flat collider at y≈0.
    this._addStatic(physics, floor, { surface: 'flagstone', box: true });
  }

  /**
   * Perimeter walls: runs with a gate gap on +X (the `gate` landmark) and a
   * corridor mouth on +Z, so `depth` has a real sightline to look down.
   */
  _buildWalls(mats, render, physics) {
    const wallMat = mats.get('wall.block', { moss: 0.16, wet: 0.22 });

    // [centre x, centre z, length, axis] — 'x' means the run extends along X.
    const runs = [
      [-8, -HALF, 36, 'x'],
      [14, -HALF, 12, 'x'],
      [-HALF, -6, 40, 'z'],
      [-HALF, 20, 12, 'z'],
      [-6, HALF, 40, 'x'],
      [HALF, -14, 24, 'z'],
      [HALF, 16, 20, 'z'],
    ];

    for (const run of runs) {
      const [cx, cz, len, axis] = run;
      const w = axis === 'x' ? len : WALL_T;
      const d = axis === 'x' ? WALL_T : len;
      const geo = boxUvMetres(new THREE.BoxGeometry(w, WALL_H, d), w, WALL_H, d);
      this._geometries.push(geo);

      const m = new THREE.Mesh(geo, wallMat);
      m.name = 'mn.world.wall';
      m.position.set(cx, WALL_H * 0.5, cz);
      m.castShadow = true;
      m.receiveShadow = true;
      this.root.add(m);
      this.walls.push(m);

      // Registration is per mesh but the hole is per fragment, so a wall the
      // player is merely near is unaffected — only the part genuinely between
      // them and the camera opens.
      render.registerOccluderFade(m);
      this._addStatic(physics, m, { surface: 'stone', box: true });
    }
  }

  /** Eight granite pillars. Round geometry has no usable UV layout for a tiling
   *  stone, so these ask for triplanar and let the material project from world
   *  space — which is exactly what the flag exists for. */
  _buildColonnade(mats, physics) {
    const mat = mats.get('wall.block', { triplanar: true, moss: 0.20, wet: 0.25 });
    const shaftGeo = new THREE.CylinderGeometry(0.62, 0.78, 3.9, 12, 1);
    const capGeo = new THREE.BoxGeometry(1.9, 0.42, 1.9);
    this._geometries.push(shaftGeo, capGeo);

    this.pillars = [];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      g.position.set(i < 4 ? -9.5 : 9.5, 0, -13 + (i % 4) * 8.5);
      // Every instance rotated differently so the triplanar projection samples a
      // different part of the noise field per pillar; no two read alike.
      g.rotation.y = this.rng.range(0, Math.PI * 2);

      const shaft = new THREE.Mesh(shaftGeo, mat);
      shaft.position.y = 1.95;
      shaft.castShadow = shaft.receiveShadow = true;
      g.add(shaft);

      const top = new THREE.Mesh(capGeo, mat);
      top.position.y = 4.05;
      top.castShadow = top.receiveShadow = true;
      g.add(top);

      const base = new THREE.Mesh(capGeo, mat);
      base.position.y = 0.21;
      base.scale.setScalar(1.12);
      base.castShadow = base.receiveShadow = true;
      g.add(base);

      this.root.add(g);
      this.pillars.push(g);
      this._addStatic(physics, shaft, { surface: 'stone', box: true });
    }
  }

  /**
   * The shadow shrine at (−8, −6): a raised dais and a rune monolith.
   *
   * This is the only place in the stub where the signature violet appears with
   * no combat running, which is exactly what the `shrine` shot exists to review.
   * The emissive colour comes from the `arcane.rune` recipe, which reads it out
   * of `palette.ELEMENTS.shadow`; nothing here hardcodes a spell colour.
   */
  _buildShrine(mats, physics) {
    const stone = mats.get('wall.block', { wet: 0.30, moss: 0.24 });
    const rune = mats.get('arcane.rune', { emissive: 1.7, moss: 0.06 });

    const stepGeo = boxUvMetres(new THREE.BoxGeometry(9.0, 0.22, 9.0), 9.0, 0.22, 9.0);
    const daisGeo = boxUvMetres(new THREE.BoxGeometry(7.5, 0.42, 7.5), 7.5, 0.42, 7.5);
    const monoGeo = boxUvMetres(new THREE.BoxGeometry(1.15, 3.4, 0.85), 1.15, 3.4, 0.85);
    this._geometries.push(stepGeo, daisGeo, monoGeo);

    const g = new THREE.Group();
    g.position.set(-8, 0, -6);
    g.rotation.y = 0.18;

    const step = new THREE.Mesh(stepGeo, stone);
    step.position.y = 0.11;
    step.receiveShadow = true;
    g.add(step);

    const dais = new THREE.Mesh(daisGeo, stone);
    dais.position.y = 0.43;
    dais.castShadow = dais.receiveShadow = true;
    g.add(dais);

    const mono = new THREE.Mesh(monoGeo, rune);
    mono.position.set(0, 2.34, 0);
    mono.rotation.z = 0.035;              // nothing perfectly straight
    mono.castShadow = mono.receiveShadow = true;
    // The rune channels are the brightest thing in the shrine frame; push them
    // into the bloom-only emissive buffer so they bleed like a magic source.
    mono.userData.mnGlow = 1.4;
    g.add(mono);

    // A cold violet practical so the shrine lights its own dais. The one
    // non-fire light in the level, and it uses the canonical rift colour.
    const rift = new THREE.PointLight(
      new THREE.Color().setRGB(
        LIGHTS.shadowRift.color[0], LIGHTS.shadowRift.color[1], LIGHTS.shadowRift.color[2],
        THREE.LinearSRGBColorSpace
      ),
      LIGHTS.shadowRift.intensity * 0.55,
      LIGHTS.shadowRift.radius,
      2
    );
    rift.position.set(0, 2.5, 0);
    rift.name = 'mn.world.shrineRift';
    g.add(rift);
    this._riftLight = rift;

    this.root.add(g);
    this.shrine = g;
    this._addStatic(physics, dais, { surface: 'stone', box: true });
    this._addStatic(physics, mono, { surface: 'crystal', box: true });
  }

  /** Scattered rubble. Triplanar granite, every instance a different rotation and
   *  a different non-uniform scale — "nothing repeated" applies to instances as
   *  much as to texels. */
  _buildRubble(mats, physics) {
    const mat = mats.get('rubble.granite', { moss: 0.20, wet: 0.28 });
    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    this._geometries.push(geo);

    const COUNT = 34;
    const inst = new THREE.InstancedMesh(geo, mat, COUNT);
    inst.name = 'mn.world.rubble';
    inst.castShadow = inst.receiveShadow = true;
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    // Local scratch, used only during construction — not a per-frame allocation.
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();

    for (let i = 0; i < COUNT; i++) {
      // Kept off the centre so the player spawn and the shot framing are never
      // blocked by a boulder sitting on the camera axis.
      const a = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(5.5, HALF - 3);
      p.set(Math.cos(a) * r, this.rng.range(-0.12, 0.18), Math.sin(a) * r);
      e.set(this.rng.range(0, 6.283), this.rng.range(0, 6.283), this.rng.range(0, 6.283));
      q.setFromEuler(e);
      const k = this.rng.range(0.45, 1.5);
      s.set(k * this.rng.range(0.8, 1.3), k * this.rng.range(0.6, 1.0), k * this.rng.range(0.8, 1.3));
      inst.setMatrixAt(i, m.compose(p, q, s));
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();

    this.root.add(inst);
    this.rubble = inst;
    this._addStatic(physics, inst, { surface: 'stone', box: true });
  }

  /**
   * The braziers — the key light of the whole level.
   *
   * ARCHITECTURE.md: "In a crypt the key IS the brazier — it must flicker, and
   * everything near it must respond." `LIGHTS.brazier` supplies colour,
   * intensity and cull radius; nothing here invents a value.
   *
   * TEN of them, at ~7-9 m spacing, so wherever the player stands two or three
   * are inside their 11 m falloff and the room reads as lit rather than as a
   * pool of light in a void.
   *
   * Ten and not more: this was tried at fourteen and the frame got WORSE, for a
   * reason worth recording. Auto-exposure meters the frame and pins its average
   * near 4% (TUNE.exposure.compensationEV = -2.35), so adding emitters does not
   * lift the dark parts of the image — it stops the camera down and darkens
   * them, while the extra fires spread the eye across a field of identical
   * bright dots with no focal point. `analyze.mjs` measured the crushed
   * fraction going UP, from 49% to 51%, on twice the light. The dark half of
   * this frame is set by the exposure compensation and by the ambient floor
   * `sky` provides, and no amount of world lighting will move it.
   *
   * Neither the light count nor the draw count is a problem, and both are worth
   * spelling out because they look like they should be:
   *
   *  - LIGHTS: `LightBudget` freezes the point-light slot count at 8 before the
   *    first material compiles, and every frame it ranks the real lights by
   *    contribution at the camera focus and tops the visible count up with
   *    zero-intensity ballast. Fourteen lights therefore change WHICH eight are
   *    lit, never how many, and cost no shader permutation.
   *  - DRAWS: the body is one LatheGeometry (a brazier is a surface of
   *    revolution, so foot + stem + bowl are one profile, not three cylinders)
   *    and both body and coal bed are InstancedMesh. Ten braziers are 2 draw
   *    calls; five hand-built ones were 20.
   */
  _buildBraziers(mats, render, physics) {
    const iron = mats.get('metal.brazier', { triplanar: true, soot: 0.9 });

    // The one material in this file that is not from the library, because the
    // library has no "glowing coal" recipe and inventing one is the materials
    // agent's call, not the integration gate's. Registered with render so it is
    // patched (and therefore bloom-eligible) before its first draw.
    const emberMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.04, 0.012, 0.004, THREE.LinearSRGBColorSpace),
      emissive: new THREE.Color().setRGB(
        ELEMENTS.fire.core[0], ELEMENTS.fire.core[1], ELEMENTS.fire.core[2],
        THREE.LinearSRGBColorSpace
      ),
      // Tuned by capture. `mnGlow` multiplies this again (x1.2 below), so the
      // radiance reaching the tone mapper is ~1.14x fire.core. It started at
      // 5.5 x 3.0 and the coal bed rendered as a flat white bulb: past roughly
      // 5x, the AgX shoulder has clipped all three channels, so every extra stop
      // only widens the bloom halo and destroys the orange.
      emissiveIntensity: 0.95,
      roughness: 0.85,
      metalness: 0.0,
    });
    emberMat.name = 'mn.world.ember';
    render.registerMaterial(emberMat);
    this._emberMat = emberMat;

    // Lathe profile, in metres: (radius, height) up the silhouette. Foot, waist,
    // stem, flare, bowl wall, rim, and back down the inside so the bowl is a
    // real vessel rather than a solid cone seen from above.
    const profile = [
      new THREE.Vector2(0.00, 0.000),
      new THREE.Vector2(0.50, 0.010),
      new THREE.Vector2(0.48, 0.110),
      new THREE.Vector2(0.19, 0.190),
      new THREE.Vector2(0.105, 0.560),
      new THREE.Vector2(0.135, 1.010),
      new THREE.Vector2(0.30, 1.150),
      new THREE.Vector2(0.58, 1.545),
      new THREE.Vector2(0.545, 1.560),
      new THREE.Vector2(0.27, 1.215),
    ];
    // 16 radial segments: at the hero boom a brazier is ~40 px across, so the
    // facet count stops being visible well before 16 and every extra segment is
    // 14 more triangles through a software rasteriser.
    const bodyGeo = new THREE.LatheGeometry(profile, 16);
    bodyGeo.computeVertexNormals();
    // Sunk far enough that the dome's crown (y 1.50) sits BELOW the bowl rim
    // (y 1.545). At the first attempt it stood proud of the rim and every
    // brazier in the room read as a white ball on a stick; tucked inside, what
    // you see is a bowl full of light, which is what a brazier is.
    const emberGeo = new THREE.SphereGeometry(0.34, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.46);
    this._geometries.push(bodyGeo, emberGeo);

    // Hand-placed rather than scattered, because two constraints have to hold at
    // once and rejection sampling for them is more code than the list:
    //   - at least ~3 m from every debug landmark. The shot harness teleports
    //     the player onto the landmark and frames it, so a brazier on top of one
    //     puts a blown-out emissive dome in the middle of the review shot —
    //     which is exactly what `detail` (boom 9.5) looked like before.
    //   - at least ~1.6 m from a pillar and off the shrine dais.
    const spots = [
      [3.2, -2.4], [10.8, 9.6], [-6.6, -12.2], [-2.6, -15.4], [15.2, 4.6],
      [-12.6, 6.4], [5.4, 13.2], [0.0, -8.0], [-14.0, -4.0], [13.5, -8.5],
    ];

    const bodies = new THREE.InstancedMesh(bodyGeo, iron, spots.length);
    bodies.name = 'mn.world.brazier.body';
    bodies.castShadow = bodies.receiveShadow = true;
    bodies.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const embers = new THREE.InstancedMesh(emberGeo, emberMat, spots.length);
    embers.name = 'mn.world.brazier.ember';
    // The coal bed IS the light source: it must not cast a shadow into the bowl
    // it sits in, and it stays out of the shadow pass so nothing self-occludes.
    embers.castShadow = false;
    embers.receiveShadow = false;
    embers.userData.mnNoShadow = true;
    embers.userData.mnGlow = 1.2;
    embers.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    // Construction-time scratch only — this whole function runs once in init().
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);

    for (let i = 0; i < spots.length; i++) {
      const x = spots[i][0], z = spots[i][1];

      // A degree or two off plumb, different per instance. Nothing in a crypt is
      // straight, and a row of perfectly vertical identical props is the single
      // most obvious tell that a level was placed by a loop.
      e.set(this.rng.range(-0.035, 0.035), this.rng.range(0, Math.PI * 2), this.rng.range(-0.035, 0.035));
      q.setFromEuler(e);

      p.set(x, 0, z);
      bodies.setMatrixAt(i, m.compose(p, q, one));
      // Same rotation for the coal bed, lifted to sit in the bowl — composing it
      // from the same quaternion is what keeps the ember inside a tilted bowl.
      p.set(x, 1.16, z);
      embers.setMatrixAt(i, m.compose(p, q, one));

      const light = new THREE.PointLight(
        new THREE.Color().setRGB(
          LIGHTS.brazier.color[0], LIGHTS.brazier.color[1], LIGHTS.brazier.color[2],
          THREE.LinearSRGBColorSpace
        ),
        LIGHTS.brazier.intensity,
        LIGHTS.brazier.radius,
        2
      );
      light.position.set(x, 1.62, z);
      light.name = 'mn.world.brazier';
      light.matrixAutoUpdate = false;
      light.updateMatrix();
      this.root.add(light);
      render.addLight(light);

      this._braziers.push({
        light,
        base: LIGHTS.brazier.intensity,
        // Phase drawn once from the seeded fork, never from the clock, so two
        // captures of the same frame index show identical flames.
        phase: this.rng.range(0, 100),
        rate: this.rng.range(0.72, 1.18),
      });
    }

    bodies.instanceMatrix.needsUpdate = true;
    embers.instanceMatrix.needsUpdate = true;
    bodies.computeBoundingSphere();
    embers.computeBoundingSphere();
    this.root.add(bodies);
    this.root.add(embers);
    this.brazierBodies = bodies;
    this.brazierEmbers = embers;

    // The whole instanced set as one collider: 14 boxes, one BVH object.
    this._addStatic(physics, bodies, { surface: 'metal', box: true });
  }

  /** The single place that talks to physics, so a missing physics subsystem
   *  degrades to "no collision" rather than a boot failure. */
  _addStatic(physics, mesh, opts) {
    if (!physics?.addStatic) return -1;
    const id = physics.addStatic(mesh, opts);
    if (id >= 0) this._staticIds.push(id);
    return id;
  }

  // =========================================================================
  // frame
  // =========================================================================

  /**
   * Brazier flicker. Three sines at incommensurate rates give a flame's
   * characteristic 1/f-ish wobble with no noise lookup and no allocation.
   *
   * Only the LIGHTS flicker. All ten coal beds share one instanced material
   * so their emissive cannot vary per instance, and driving that one shared
   * value would make every visible fire in the room pulse in lockstep — far more
   * obviously wrong than a coal bed that holds steady while its light breathes.
   * The eye reads flicker from what the light does to the floor, not from the
   * ember. Animated per-ember brightness is `fx`'s job, along with the flame.
   *
   * Driven from `time.elapsed` (scaled), so hit-stop freezes the fire along with
   * everything else — a flame that keeps flickering through a freeze frame is
   * the most common tell that hit-stop was bolted on afterwards.
   */
  update(dt, ctx) {
    const t = ctx.time.elapsed;
    for (let i = 0; i < this._braziers.length; i++) {
      const b = this._braziers[i];
      const p = b.phase + t * b.rate;
      b.light.intensity = b.base * (1 +
        Math.sin(p * 7.3) * 0.055 +
        Math.sin(p * 3.1 + 1.3) * 0.075 +
        Math.sin(p * 1.7 + 2.9) * 0.055);
    }
  }

  // =========================================================================
  // debug hooks (called only from src/dev/shots.js and tools/)
  // =========================================================================

  debugFocus(name) {
    return LANDMARKS[name] ?? LANDMARKS.hall;
  }

  /** `clean` | `lit` | `dark`. Brazier gain only — the stub has no set dressing
   *  to add or remove. */
  debugStage(name) {
    const gain = name === 'dark' ? 0.30 : name === 'lit' ? 1.55 : 1.0;
    for (const b of this._braziers) b.base = LIGHTS.brazier.intensity * gain;
    return name ?? 'clean';
  }

  stats() {
    return {
      stub: true,
      meshes: this.root.children.length,
      braziers: this._braziers.length,
      walls: this.walls.length,
      colliders: this._staticIds.length,
      geometries: this._geometries.length,
    };
  }

  dispose() {
    for (const g of this._geometries) g.dispose();
    this._geometries.length = 0;
    this._emberMat?.dispose();
    const physics = this.ctx?.peek?.('physics');
    if (physics?.removeStatic) for (const id of this._staticIds) physics.removeStatic(id);
    this._staticIds.length = 0;
    this._braziers.length = 0;
    this.walls.length = 0;
    this.root?.parent?.remove(this.root);
  }
}
