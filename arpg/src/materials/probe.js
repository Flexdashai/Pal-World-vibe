import * as THREE from 'three';
import { LIGHTS } from '../core/palette.js';
import { SURFACES } from './surfaces.js';

/**
 * MONARCH — material showcase scene. `?matdebug=1` (or `?matdebug=grid`) ONLY.
 *
 * This is not content and it is not `world`'s job being done here. It exists
 * because a material library cannot be reviewed against an empty stub scene:
 * parallax needs a surface seen at a grazing angle with something to cast into
 * the joints, triplanar needs a rotated mesh with no UV layout, per-instance
 * variation needs a hundred instances in one frame, and the overlays need a
 * surface with real crevices for them to collect in.
 *
 * It builds at the landmarks `world.debugFocus()` reports, so the standard
 * `hero`, `corridor` and `detail` shots frame it with no harness change:
 *
 *   'corridor'  a real corridor — flagstone floor, granite block walls, a
 *               ribbed vault, a rune slab, rubble, timber and a brazier. This is
 *               what the `detail` shot pushes into at a 9.5 m boom, and it is
 *               where texel density, POM and crevice grime are judged.
 *   'hall'      a wider floor with a marble inlay, pillars, standing water and
 *               an instanced block field, for the `hero` shot.
 *
 * `?matdebug=grid` replaces both with one slab per surface in a grid, for
 * reviewing the whole catalogue in a single frame.
 *
 * Everything is procedural, seeded from `ctx.rng.fork()`, and disposed with the
 * subsystem. It is never constructed unless the URL parameter is present, so it
 * cannot affect another agent's capture.
 */

/**
 * Rescale a geometry's UVs from 0..1 to METRES.
 *
 * This is the convention the whole material system is calibrated on, and this
 * helper is here as much to document it as to use it: a mesh whose UVs are in
 * metres gets correct texel density, correct parallax depth and continuous
 * detail across mesh boundaries from every surface in the library, with no
 * per-mesh tuning at the call site.
 */
function metricUvPlane(geo, w, h) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  uv.needsUpdate = true;
  return geo;
}

/**
 * The same for a box. three's BoxGeometry emits its six faces in the fixed
 * order +X, -X, +Y, -Y, +Z, -Z, each with (segA+1)*(segB+1) vertices, and each
 * face's UV spans a different pair of the box's dimensions — so a single global
 * scale would stretch the texture on four of the six.
 */
function metricUvBox(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const faces = [
    { sx: d, sy: h },   // +X
    { sx: d, sy: h },   // -X
    { sx: w, sy: d },   // +Y
    { sx: w, sy: d },   // -Y
    { sx: w, sy: h },   // +Z
    { sx: w, sy: h },   // -Z
  ];
  // One segment per face => four vertices each; BoxGeometry with default
  // segments emits exactly 24.
  let i = 0;
  for (const f of faces) {
    for (let k = 0; k < 4 && i < uv.count; k++, i++) uv.setXY(i, uv.getX(i) * f.sx, uv.getY(i) * f.sy);
  }
  uv.needsUpdate = true;
  return geo;
}

export class MaterialProbeScene {
  constructor(ctx, system, gridMode = false) {
    this.ctx = ctx;
    this.system = system;
    this.mats = system.library;
    this.rng = ctx.rng.fork();
    this.gridMode = gridMode;

    this.root = new THREE.Group();
    this.root.name = 'mn.materialProbe';
    ctx.scene.add(this.root);

    this._geometries = [];
    this._lights = [];
    this._meshes = 0;

    // Preallocated compose scratch for the instanced fields.
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();

    if (gridMode) this._buildGrid();
    else { this._buildCorridor(); this._buildHall(); }
  }

  // -------------------------------------------------------------------------
  // helpers — all positions are LOCAL to `parent`
  // -------------------------------------------------------------------------

  _track(geo) { this._geometries.push(geo); return geo; }

  _add(parent, geo, mat, x, y, z, ry = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    this._meshes++;
    return m;
  }

  /** A metric-UV floor slab lying in XZ. */
  _floor(parent, w, d, mat, x, y, z, spin = 0) {
    const geo = this._track(metricUvPlane(new THREE.PlaneGeometry(w, d, 1, 1), w, d));
    const m = this._add(parent, geo, mat, x, y, z, 0);
    m.rotation.set(-Math.PI / 2, 0, spin);
    m.castShadow = false;
    return m;
  }

  /** A metric-UV box. */
  _box(parent, w, h, d, mat, x, y, z, ry = 0) {
    const geo = this._track(metricUvBox(new THREE.BoxGeometry(w, h, d), w, h, d));
    return this._add(parent, geo, mat, x, y, z, ry);
  }

  _light(parent, color, intensity, radius, x, y, z) {
    const l = new THREE.PointLight(
      new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace),
      intensity, radius, 2
    );
    l.position.set(x, y, z);
    parent.add(l);
    this._lights.push(l);
    this.system.render?.addLight?.(l);
    return l;
  }

  /** Where a landmark actually is. Read from the live world so this keeps
   *  working after `world` replaces its stub. */
  _spot(name, fx, fz) {
    const s = this.ctx.peek('world')?.debugFocus?.(name);
    const p = s?.look ?? s?.pos;
    return p ? { x: p[0], z: p[2] } : { x: fx, z: fz };
  }

  // -------------------------------------------------------------------------
  // the corridor — what the `detail` and `corridor` shots frame
  // -------------------------------------------------------------------------

  _buildCorridor() {
    const M = this.mats;
    const at = this._spot('corridor', 8, 6);

    // The corridor runs along -X-Z, which is screen "up" at this camera, so the
    // walls frame the shot instead of lying across it. Everything below is in
    // the group's local space, with +Z running down the corridor.
    const g = new THREE.Group();
    g.position.set(at.x, 0, at.z);
    g.rotation.y = Math.PI * 0.25;
    this.root.add(g);
    this.corridor = g;

    // ---- floor -----------------------------------------------------------
    // Damp flagstone. The wet mask is what puts the brazier's reflection into
    // the joints, which is the single strongest Diablo IV surface cue.
    this._floor(g, 9, 24, M.get('floor.crypt', { wet: 0.42, moss: 0.16, grime: 0.55 }), 0, 0.02, 0);
    // A worn strip down the middle: SAME texture set, drier and more polished.
    // Two materials sharing one bake is the point of uniform-driven overlays.
    this._floor(g, 2.6, 24, M.get('floor.crypt', { wet: 0.16, moss: 0.02, grime: 0.28, tile: 1.9 }), 0, 0.03, 0);

    // ---- walls -----------------------------------------------------------
    const wallMat = M.get('wall.block', { moss: 0.22, grime: 0.5, varyUv: 0.07 });
    const wallLow = M.get('wall.foundation', { wet: 0.55, moss: 0.42 });
    for (const s of [-1, 1]) {
      // Plinth course — wetter and mossier, because that is where water wicks up.
      this._box(g, 0.85, 0.55, 24, wallLow, s * 4.3, 0.275, 0);
      // Three courses, so the block pattern is not one continuous stripe.
      for (let c = 0; c < 3; c++) {
        const w = this._box(g, 0.7, 1.15, 24, wallMat, s * 4.3, 0.55 + 1.15 * c + 0.575, 0);
        // The +X+Z wall stands between the camera and the corridor floor at this
        // yaw. Registering it means render dithers a hole in it around the
        // player instead of the shot being half wall.
        if (s > 0) this.system.render?.registerOccluderFade?.(w);
      }
    }

    // ---- vault ------------------------------------------------------------
    // A ribbed vault over the whole corridor was the obvious thing to build and
    // it was wrong: at a 9.5 m boom and a -52 deg pitch, ANY beam at 4 m lies
    // directly between the camera and the floor, and the 'detail' shot came back
    // as three black bands with slivers of stone between them. The ribs live at
    // the far end only, where they read as depth instead of as an occluder, and
    // the end wall carries the same surface at eye height where it can be seen.
    const ribMat = M.get('ceil.vault', { soot: 0.72, grime: 0.35 });
    for (const z of [-8.2, -10.6]) this._box(g, 9.4, 0.6, 0.8, ribMat, 0, 3.9, z);
    // End wall, stepped like a blind arcade so it is not one flat panel.
    this._box(g, 9.4, 2.2, 0.6, ribMat, 0, 1.1, -11.6);
    this._box(g, 6.2, 1.5, 0.5, M.get('wall.block', { moss: 0.3, grime: 0.5 }), 0, 3.0, -11.5);

    // ---- the rune slab: the parallax showcase -----------------------------
    this._box(g, 1.8, 2.7, 0.34, M.get('wall.rune', { emissive: 7.0, moss: 0.05, grime: 0.3 }), -3.75, 1.5, -4.0);

    // ---- brazier: iron under heavy soot, plus the key light ---------------
    this._box(g, 0.74, 0.34, 0.74, M.get('metal.brazier'), 3.0, 1.30, 1.2);
    this._box(g, 0.26, 1.30, 0.26, M.get('metal.rust'), 3.0, 0.65, 1.2);
    // Half a metre above the bowl, not sitting in it. A 26 cd point light 10 cm
    // from a surface delivers ~2600 lux to it and the bowl blew to white, which
    // reads as a bug rather than as a fire.
    this._light(g, LIGHTS.brazier.color, LIGHTS.brazier.intensity * 0.7, LIGHTS.brazier.radius, 3.0, 2.05, 1.2);
    // A cooler fill from up the corridor so the far end is not void.
    this._light(g, LIGHTS.candle.color, LIGHTS.candle.intensity * 3.2, 9.0, -2.0, 2.2, -6.5);

    // ---- timber, cloth, bone, crystal -------------------------------------
    this._box(g, 1.15, 0.95, 0.85, M.get('wood.plank', { wet: 0.2 }), -3.2, 0.5, 3.4, 0.24);
    this._box(g, 0.24, 3.4, 0.24, M.get('wood.beam'), 3.6, 1.7, -2.4);

    const bannerGeo = this._track(metricUvPlane(new THREE.PlaneGeometry(1.3, 2.4, 1, 1), 1.3, 2.4));
    const banner = this._add(g, bannerGeo, M.get('cloth.banner', { grime: 0.45, soot: 0.25 }), -3.9, 2.5, 1.0, Math.PI / 2);
    // A torn cutout costs a shadow-material permutation for very little return.
    banner.castShadow = false;
    banner.userData.mnNoShadow = true;

    this._floor(g, 2.4, 2.0, M.get('floor.ossuary'), 2.4, 0.05, -5.0);

    const crystalGeo = this._track(new THREE.OctahedronGeometry(0.44, 0));
    const crystal = this._add(g, crystalGeo, M.get('arcane.crystal', { emissive: 10.0, triplanar: true, tile: 0.7 }), 3.2, 0.55, -5.6);
    crystal.userData.mnGlow = 1.3;
    this._light(g, LIGHTS.shadowRift.color, LIGHTS.shadowRift.intensity * 0.6, 6.5, 3.2, 0.85, -5.6);

    this._rubble(g);
  }

  /**
   * Instanced rubble. Two things are on trial here: triplanar projection on a
   * mesh with a meaningless UV layout and an arbitrary rotation, and
   * per-instance variation — every one of these stones is a different value,
   * hue and roughness from a hash of its own world origin, with nothing at all
   * passed in from this side.
   */
  _rubble(parent) {
    const geo = this._track(new THREE.IcosahedronGeometry(0.30, 0));
    const mat = this.mats.get('rubble.stone', { tile: 0.55, moss: 0.25, wet: 0.3 });
    const N = 46;
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    for (let i = 0; i < N; i++) {
      // Rubble collects against the walls, not down the middle of the corridor.
      const side = this.rng.float() < 0.5 ? -1 : 1;
      this._p.set(side * this.rng.range(2.5, 3.9), this.rng.range(0.06, 0.18), this.rng.range(-10.5, 10.5));
      this._e.set(this.rng.range(0, 6.283), this.rng.range(0, 6.283), this.rng.range(0, 6.283));
      this._q.setFromEuler(this._e);
      const s = this.rng.range(0.45, 1.35);
      this._s.set(s, s * this.rng.range(0.6, 1.0), s * this.rng.range(0.8, 1.2));
      mesh.setMatrixAt(i, this._m4.compose(this._p, this._q, this._s));
    }
    mesh.instanceMatrix.needsUpdate = true;
    parent.add(mesh);
    this._meshes++;
    this.rubble = mesh;
  }

  // -------------------------------------------------------------------------
  // the hall — what the `hero` shot frames
  // -------------------------------------------------------------------------

  _buildHall() {
    const M = this.mats;
    const at = this._spot('hall', 0, 0);
    const g = new THREE.Group();
    g.position.set(at.x, 0, at.z);
    this.root.add(g);
    this.hall = g;

    // A large floor over the stub world's flat plane. Two concentric surfaces,
    // so the hero frame has a material break in it rather than one texture from
    // edge to edge.
    this._floor(g, 48, 48, M.get('floor.crypt', { wet: 0.30, moss: 0.10, grime: 0.5 }), 0, 0.02, 0);
    this._floor(g, 11, 11, M.get('floor.cathedral', { tile: 3.2, wet: 0.2 }), 0, 0.035, 0, Math.PI * 0.25);

    // Standing water in a low corner: near-mirror roughness, so every flame in
    // the room ends up in it once SSR is running.
    this._floor(g, 5.5, 4.0, M.get('water.still', { tile: 3.6 }), -7.5, 0.045, 6.0);

    // Pillars, alternating stone types so the eye has something to compare.
    const pillarA = M.get('wall.block', { moss: 0.18, grime: 0.45, varyUv: 0.08 });
    const pillarB = M.get('wall.marble', { tile: 2.2 });
    const cap = M.get('wall.block');
    const base = M.get('wall.foundation', { wet: 0.5, moss: 0.35 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.39;
      const x = Math.cos(a) * 8.0;
      const z = Math.sin(a) * 8.0;
      this._box(g, 0.95, 4.4, 0.95, i % 2 ? pillarA : pillarB, x, 2.2, z, a);
      // Capital and base: silhouette break, and a second material on the same
      // object so instance variation reads against a fixed neighbour.
      this._box(g, 1.25, 0.28, 1.25, cap, x, 4.46, z, a);
      this._box(g, 1.25, 0.30, 1.25, base, x, 0.15, z, a);
    }

    this._blockField(g);

    // Scree, ash and earth, so every ground material is in one frame.
    this._floor(g, 6.0, 5.0, M.get('floor.scree', { tile: 1.3 }), 9.0, 0.04, -7.0, 0.3);
    this._floor(g, 5.0, 5.0, M.get('floor.ash'), -9.5, 0.04, -8.0, -0.4);
    this._floor(g, 5.0, 4.0, M.get('floor.earth', { wet: 0.15 }), 8.0, 0.04, 8.0, 0.7);

    this._light(g, LIGHTS.brazier.color, LIGHTS.brazier.intensity, LIGHTS.brazier.radius, 4.0, 1.7, -3.0);
  }

  _blockField(parent) {
    const w = 0.92, h = 0.62, d = 0.92;
    const geo = this._track(metricUvBox(new THREE.BoxGeometry(w, h, d), w, h, d));
    const mat = this.mats.get('wall.block', {
      tile: 1.2, moss: 0.14, grime: 0.45, varyUv: 0.10, varyValue: 0.34, varyHue: 0.40,
    });
    const N = 60;
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // A collapsed stack: a grid with enough jitter that it reads as ruin rather
    // than as a demonstration of instancing.
    let i = 0;
    for (let gz = 0; gz < 10 && i < N; gz++) {
      for (let gx = 0; gx < 6 && i < N; gx++, i++) {
        this._p.set(
          -14.0 + gx * (w + 0.05) + this.rng.range(-0.05, 0.05),
          h * 0.5 + Math.max(0, 2 - gz * 0.34) * h * this.rng.float(),
          -3.0 + gz * (d + 0.05) + this.rng.range(-0.05, 0.05)
        );
        this._e.set(this.rng.range(-0.05, 0.05), this.rng.range(-0.18, 0.18), this.rng.range(-0.05, 0.05));
        this._q.setFromEuler(this._e);
        this._s.set(1, 1, 1);
        mesh.setMatrixAt(i, this._m4.compose(this._p, this._q, this._s));
      }
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    parent.add(mesh);
    this._meshes++;
    this.blocks = mesh;
  }

  // -------------------------------------------------------------------------
  // grid mode — one slab per surface
  // -------------------------------------------------------------------------

  _buildGrid() {
    const cols = 5;
    const pitch = 2.6;
    const size = 2.3;
    const g = this.root;

    // A dark backdrop, so a bright surface is not judged against void.
    this._floor(g, 60, 60, this.mats.get('floor.earth', { grime: 0.6 }), 0, 0.0, 0);

    SURFACES.forEach((s, i) => {
      const gx = i % cols;
      const gz = Math.floor(i / cols);
      // A slab rather than a plane: the vertical face shows the normal map and
      // the AO at a completely different light angle from the top face, which is
      // where a bad bake gives itself away.
      const geo = this._track(metricUvBox(new THREE.BoxGeometry(size, 0.55, size), size, 0.55, size));
      const m = this._add(g, geo, this.mats.get(s.id, { grime: 0.3 }),
        (gx - (cols - 1) / 2) * pitch, 0.30, (gz - 2) * pitch);
      m.userData.mnSurfaceId = s.id;
    });

    this._light(g, LIGHTS.brazier.color, LIGHTS.brazier.intensity * 1.4, 24, 3.5, 3.2, 3.5);
    this._light(g, LIGHTS.moon.color, 12.0, 26, -6.0, 5.0, -6.0);
  }

  // -------------------------------------------------------------------------

  /** Static showcase: nothing animates, so captures are byte-stable. */
  update() {}

  stats() {
    return { mode: this.gridMode ? 'grid' : 'rooms', meshes: this._meshes, lights: this._lights.length };
  }

  dispose() {
    this.root.parent?.remove(this.root);
    for (const l of this._lights) this.system.render?.removeLight?.(l);
    this._lights.length = 0;
    for (const g of this._geometries) g.dispose();
    this._geometries.length = 0;
    this.rubble = null;
    this.blocks = null;
  }
}
