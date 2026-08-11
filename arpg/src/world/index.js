import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';
import { STREAM, DRESS } from './tuning.js';
import { generateLevel } from './layout.js';
import { Builder, ROOM_BUILDERS, materialsFor, buildThroat } from './build.js';
import { debrisGeometry } from './props.js';
import { createFlameMaterial, buildFlameGeometry } from './fire.js';
import { Practicals } from './lighting.js';
import { registerColliders, colliderTriangles } from './collision.js';

/**
 * ============================================================================
 * MONARCH — `world` subsystem.  PUBLIC API.
 * ============================================================================
 *
 *   id    'world'
 *   deps  ['render', 'materials']   (`physics` and `sky` are reached with
 *                                    `ctx.peek` and are optional)
 *
 * `const w = ctx.get('world')`. Nothing outside `src/world/` imports a module
 * from this directory.
 *
 *   w.debugFocus(name)   -> { pos:[x,y,z], look:[x,y,z] }
 *                           'hall' | 'corridor' | 'shrine' | 'arena' | 'gate' |
 *                           'vista' | 'gallery' | 'cloister' | 'reliquary' |
 *                           'nave' | 'span' | 'catacomb' | 'cistern'
 *   w.debugStage(name)   -> 'clean' | 'lit' | 'dark'
 *   w.debugReach()       -> connectivity from the spawn, measured against the
 *                           real colliders. See its header.
 *   w.level              -> the generated room graph (see layout.js)
 *   w.roomAt(x, z)       -> the room containing a point, or null
 *   w.spawn              -> THREE.Vector3, the player start
 *   w.stats()
 *
 * Events emitted:
 *   `world:ready`  { level, rooms, spawn }   once, at the end of init()
 *   `world:room`   { room, cleared }         when the player changes room
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DIRECTORY OWNS, AND THE ORDER IT HAPPENS IN
 *
 *   layout.js    the seeded room graph. Authored topology, seeded everything
 *                else — see its header for why this is not a maze algorithm
 *   geom.js      build-time geometry: world-space metre UVs, chipped blocks,
 *                pointed arches, ribbed vaults, tracery, merging
 *   kit.js       the modular gothic kit built out of those primitives
 *   props.js     statuary, tombs, ironwork, banners, roots, debris
 *   fire.js      braziers, flames, candles — the key light of the whole game
 *   build.js     composes one room from the kit; owns the material dressing
 *   lighting.js  the practicals, the flicker, and the light-slot discipline
 *   collision.js oriented boxes -> triangles -> physics, tagged by surface
 *
 * ---------------------------------------------------------------------------
 * THE THREE CONTRACTS THIS FILE IS RESPONSIBLE FOR KEEPING ALIVE
 *
 *  1. `materials.get(name, opts)` for EVERY surface. Nothing here constructs a
 *     THREE material for a world surface except the two that the library has no
 *     recipe for (glowing coal, and the flame's additive shader), and both of
 *     those are registered with `render.registerMaterial` before their first
 *     draw. All geometry is built with UVs IN METRES, projected from world
 *     space, which is the one convention the library requires.
 *
 *  2. `sky` owns the key light. This subsystem creates NO directional and NO
 *     hemisphere light. `sky._electKeyLight` adopts any shadow-casting
 *     directional it finds and then stops driving the moon from its own
 *     ephemeris, so a stray directional here would silently disable the whole
 *     atmosphere model. In a crypt the key IS the brazier.
 *
 *  3. `render.registerOccluderFade(mesh)` on everything that can stand between
 *     the lens and the player — the `near` and `vault` mesh groups — and, more
 *     importantly, an architecture that mostly does not need it: the +X/+Z side
 *     of every room is built low on purpose. See `perimeterHeight` in build.js.
 */
export class WorldSystem {
  static id = 'world';
  static deps = ['render', 'materials'];

  async init(ctx) {
    this.ctx = ctx;
    const t0 = performance.now();

    // ONE fork, taken here and never re-forked, so the whole level is a pure
    // function of `config.seed` and two captures of the same seed are identical.
    this.rng = ctx.rng.fork();

    const mats = ctx.get('materials');
    const render = ctx.get('render');
    const physics = ctx.peek('physics');
    this.render = render;
    this.mats = mats;

    this.root = new THREE.Group();
    this.root.name = 'mn.world';
    ctx.scene.add(this.root);

    /** Everything we allocate, so `dispose()` is exhaustive rather than a guess.
     *  Library materials are NOT in here — `materials` owns and disposes those. */
    this._geometries = [];
    this._ownMaterials = [];
    this._staticIds = [];
    this._rooms = [];
    this._occluderMeshes = [];

    // ---- the two materials the library has no recipe for --------------------
    this._emberMat = this._makeEmberMaterial(render);
    this._flameMat = createFlameMaterial();
    this._ownMaterials.push(this._emberMat, this._flameMat);

    // ---- generate ------------------------------------------------------------
    this.level = generateLevel(this.rng, ctx.config.seed);
    this.spawn = new THREE.Vector3(this.level.spawn.x, this.level.spawn.y, this.level.spawn.z);

    // ---- build ---------------------------------------------------------------
    /** kind -> BufferGeometry, shared by every InstancedMesh of that kind. */
    this._debrisGeo = new Map();
    const allColliders = [];
    const allLights = [];
    let triangles = 0;
    let draws = 0;

    for (const room of this.level.rooms) {
      const spec = materialsFor(room.kind, room);
      const B = new Builder(room, this.rng, spec);
      const fn = ROOM_BUILDERS[room.kind] ?? ROOM_BUILDERS.chamber;
      fn(B, room);
      // The doorways. Built AFTER the room so a throat's floor and its flight of
      // steps overwrite whatever the perimeter put there, and built by exactly
      // one of the two rooms a link joins so the geometry exists once.
      for (const L of room.links) if (L.owner === room.id) buildThroat(B, L);

      const built = this._realiseRoom(room, B, spec, render, mats);
      triangles += built.triangles;
      draws += built.draws;

      for (const c of B.colliders) allColliders.push(c);
      for (const l of B.lights) allLights.push(l);
      this._rooms.push(room);
    }

    // ---- practicals ----------------------------------------------------------
    // Parented to `root`, NOT to a room group: a light inside a streamed-out
    // group is invisible to the renderer but still counted by render's light
    // budget, and the mismatch recompiles every material in the scene. See
    // lighting.js.
    this.practicals = new Practicals(this.root, render);
    const landmarkList = Object.values(this.level.landmarks);
    const lightCount = this.practicals.createAll(allLights, landmarkList);

    // ---- collision -----------------------------------------------------------
    this._colliderCount = allColliders.length;
    this._staticIds = registerColliders(physics, allColliders, 'world');

    // ---- streaming state -----------------------------------------------------
    this._focus = new THREE.Vector3().copy(this.spawn);
    this._camGround = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._currentRoom = null;
    this._roomPayload = { room: null, cleared: false };
    /** Preallocated scratch for the streaming sort — one slot per room. */
    this._streamOrder = this._rooms.map(() => ({ room: null, d: 0 }));
    this._roomsDrawn = 0;
    this._streamTick = 0;
    this._hasPlayer = false;
    this._offPlayer = ctx.events.on('player:state', (e) => {
      if (e?.position) { this._focus.copy(e.position); this._hasPlayer = true; }
    });
    this._updateStreaming(true);

    // ---- ready ---------------------------------------------------------------
    // Reused payload: emitted once here, but `spawn` is a live reference other
    // subsystems may hold on to.
    this._ready = {
      level: 1,
      name: 'The Sunken Cathedral',
      rooms: this.level.rooms.map((r) => ({
        id: r.id, kind: r.kind, name: r.name,
        x: r.x, z: r.z, y: r.y, w: r.w, d: r.d, yaw: r.yaw,
        // `hw`/`hh` are the AABB half-extents and they are not decoration: this
        // is the only shape `ui`'s minimap can duck-type. It reads
        // `{x, z, w, h}` or `{x, z, hw, hh}`, was handed `{x, z, w, d}`, matched
        // neither, and silently dropped EVERY room — so the minimap has been
        // drawing fog-of-war over an empty layout. Half-extents rather than
        // `w`/`d` because five rooms here are at 45 degrees and their plan
        // footprint is not their dimensions.
        hw: r.hw, hh: r.hh,
        aabb: r.aabb, neighbours: r.neighbours, tags: r.tags,
      })),
      edges: this.level.edges,
      links: this.level.links.map((L) => ({
        a: L.a, b: L.b, kind: L.kind, x: L.x, z: L.z, width: L.width,
      })),
      criticalPath: this.level.criticalPath,
      spawn: this.spawn,
    };

    this._buildMs = performance.now() - t0;
    console.info(
      `[world] "${this._ready.name}" seed 0x${(ctx.config.seed >>> 0).toString(16)} | ` +
      `${this.level.rooms.length} rooms, ${draws} meshes, ${(triangles / 1000).toFixed(1)}k tris | ` +
      `${lightCount} practicals, ${this._flameCount} flames | ` +
      `${this._colliderCount} colliders (${colliderTriangles(allColliders)} tris) | ` +
      `${this._buildMs.toFixed(0)}ms` +
      (this.level.overlaps.length ? ` | WARNING overlapping rooms: ${JSON.stringify(this.level.overlaps)}` : '')
    );

    ctx.events.emit('world:ready', this._ready);
  }

  // =========================================================================
  // construction
  // =========================================================================

  /**
   * The one material this subsystem invents: glowing coal.
   *
   * The library has no "ember" recipe and inventing one is the materials agent's
   * call, not ours. Registered with `render` so it is patched — and therefore
   * bloom-eligible and AO-correct — before its first draw.
   *
   * `emissiveIntensity` is deliberately modest. The previous build ran the coal
   * bed at ~1.14x `fire.core` on a smooth 0.34 m dome and it rendered as a flat
   * white disc: past roughly 1.2x linear, the AgX shoulder has clipped all three
   * channels, so every extra stop only widens the bloom halo and destroys the
   * orange. The heat now comes from the flame's additive plume, which is small
   * and has a real gradient; the coals only have to look hot, not bright.
   */
  _makeEmberMaterial(render) {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.030, 0.010, 0.004, THREE.LinearSRGBColorSpace),
      emissive: new THREE.Color().setRGB(
        ELEMENTS.fire.core[0], ELEMENTS.fire.core[1], ELEMENTS.fire.core[2],
        THREE.LinearSRGBColorSpace
      ),
      emissiveIntensity: 0.20,
      roughness: 0.86,
      metalness: 0.0,
    });
    m.name = 'mn.world.ember';
    render.registerMaterial(m);
    return m;
  }

  /** Resolve a builder's logical material name to a real THREE material. */
  _resolveMaterial(spec, logical, mats) {
    if (logical === 'ember') return this._emberMat;
    const s = spec[logical];
    if (!s) return this._emberMat;
    return mats.get(s.name, s.opts ?? undefined);
  }

  /**
   * Turn one Builder's buckets into meshes under a room group.
   *
   * Mesh group semantics, which every room builder relies on:
   *   'floor'  receives shadow, never casts, never fades
   *   'far'    backdrop masonry: casts and receives
   *   'near'   camera-side masonry: casts, receives, AND is registered for the
   *            occluder fade with its own bounding sphere
   *   'vault'  ceilings: registered for the fade for the same reason
   *   'ember'  emissive coal: no shadow either way, pushed into the bloom buffer
   *   'water'  never casts (a shadow from a water plane is nonsense) and stays
   *            in the prepass so SSR can reflect off it
   */
  _realiseRoom(room, B, spec, render, mats) {
    const group = new THREE.Group();
    group.name = `mn.world.${room.id}`;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    this.root.add(group);
    room.group = group;

    let triangles = 0;
    let draws = 0;

    for (const part of B.bucket.build()) {
      const material = this._resolveMaterial(spec, part.mat, mats);
      const mesh = new THREE.Mesh(part.geo, material);
      mesh.name = `mn.world.${room.id}.${part.mat}.${part.group}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this._geometries.push(part.geo);
      triangles += part.geo.attributes.position.count / 3;
      draws++;

      switch (part.group) {
        case 'vault':
          // CEILINGS DO NOT CAST SHADOWS. This is the single most important
          // line in the file and it was found with `?renderview=normal`.
          //
          // A vault web is a single-sided surface wound to be seen from BELOW,
          // so from this camera — which is 19 m above the floor looking down at
          // 52 degrees — it is back-face culled and invisible. It was still in
          // the shadow map, so every bay of vaulting laid a hard-edged,
          // information-free black slab across the floor of the room underneath
          // it, cast by geometry the player cannot see. Three of those slabs
          // covered half the hero shot.
          //
          // An isometric game cannot roof its play space. Vaults here exist for
          // the SILHOUETTE at the up-screen edge of a room, so they keep their
          // geometry and lose their shadow. Contact darkening under an arch
          // still happens, from render's GTAO, which is screen-space and
          // therefore honest about what is actually visible.
          mesh.castShadow = false;
          mesh.receiveShadow = true;
          mesh.userData.mnNoShadow = true;
          break;
        case 'floor':
          mesh.castShadow = false; mesh.receiveShadow = true;
          break;
        case 'water':
          mesh.castShadow = false; mesh.receiveShadow = true;
          mesh.userData.mnNoShadow = true;
          break;
        case 'ember':
          mesh.castShadow = false; mesh.receiveShadow = false;
          mesh.userData.mnNoShadow = true;
          // Into the bloom-only emissive buffer, so the coals bleed like a real
          // source without their diffuse being lifted.
          mesh.userData.mnGlow = 1.0;
          break;
        case 'rune':
          mesh.castShadow = true; mesh.receiveShadow = true;
          mesh.userData.mnGlow = 1.5;
          break;
        case 'cloth':
          mesh.castShadow = true; mesh.receiveShadow = true;
          break;
        default:
          mesh.castShadow = true; mesh.receiveShadow = true;
          break;
      }

      // Registration is per mesh but the hole is per fragment, so a wall the
      // player merely stands near is unaffected — only the part genuinely
      // between them and the camera opens.
      if (part.group === 'near' || part.group === 'vault') {
        render.registerOccluderFade(mesh);
        this._occluderMeshes.push(mesh);
      }
      group.add(mesh);
    }

    // ---- instanced debris ---------------------------------------------------
    for (const list of B.instances.values()) {
      if (!list.mats.length) continue;
      let geo = this._debrisGeo.get(list.kind);
      if (!geo) {
        geo = debrisGeometry(list.kind, this.rng);
        this._debrisGeo.set(list.kind, geo);
        this._geometries.push(geo);
      }
      const material = this._resolveMaterial(spec, list.mat, mats);
      const inst = new THREE.InstancedMesh(geo, material, list.mats.length);
      inst.name = `mn.world.${room.id}.debris.${list.kind}`;
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (let i = 0; i < list.mats.length; i++) inst.setMatrixAt(i, list.mats[i]);
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.matrixAutoUpdate = false;
      inst.updateMatrix();
      group.add(inst);
      triangles += (geo.attributes.position.count / 3) * list.mats.length;
      draws++;
    }

    // ---- flames -------------------------------------------------------------
    // One mesh per room, all sharing one material, so a room that is streamed
    // out costs nothing and `uTime` is written once for the whole level.
    this._flameCount = (this._flameCount ?? 0) + B.flames.length;
    const flameGeo = buildFlameGeometry(B.flames);
    if (flameGeo) {
      const mesh = new THREE.Mesh(flameGeo, this._flameMat);
      mesh.name = `mn.world.${room.id}.flames`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      // Additive and depth-write-off already excludes it from the prepass, but
      // saying so explicitly documents that a flame must not occlude, reflect or
      // shade anything.
      mesh.userData.mnNoPrepass = true;
      mesh.userData.mnNoShadow = true;
      // Drawn last within the room so it composites over the coals.
      mesh.renderOrder = 5;
      group.add(mesh);
      this._geometries.push(flameGeo);
      triangles += flameGeo.attributes.position.count / 3;
      draws++;
    }

    return { triangles, draws };
  }

  // =========================================================================
  // frame
  // =========================================================================

  update(dt, ctx) {
    const t = ctx.time.elapsed;
    // Flicker and flame share one clock and one phase family, so the floor
    // brightens on the same beat the plume leans. Both read `elapsed`, which is
    // the SCALED clock, so hit-stop freezes the fire with everything else.
    this.practicals.update(t, ctx.time.rawDt || dt);
    this._flameMat.uniforms.uTime.value = t;

    // Streaming is not free (one AABB test per room) but it is not per-frame
    // work either: a player crosses a 34 m radius in about six seconds.
    if ((this._streamTick++ & 7) === 0) this._updateStreaming(false);
  }

  /**
   * Room streaming.
   *
   * A room outside the draw radius has `group.visible = false`, which removes it
   * from `traverseVisible` entirely: no draw, no shadow-map pass, no MRT
   * prepass, no material patching, no bounding-sphere maths. On a software
   * rasteriser that is the single largest saving available, and it is why the
   * level can be 80 m across.
   *
   * Hysteresis matters more than it looks: without it a player standing on the
   * boundary toggles a room every frame, and every toggle invalidates the shadow
   * map and re-collects the scene.
   */
  _updateStreaming(force) {
    const ctx = this.ctx;
    // Prefer the player; fall back to where the camera is actually looking, so
    // a posed shot with no player still streams in the room it frames.
    if (!this._hasPlayer) {
      const cam = ctx.camera;
      cam.getWorldDirection(this._camDir);
      const t = this._camDir.y < -1e-3 ? -cam.position.y / this._camDir.y : 0;
      this._camGround.copy(cam.position).addScaledVector(this._camDir, t);
      this._focus.copy(this._camGround);
    }

    const fx = this._focus.x, fz = this._focus.z;
    let inside = null;
    let nearest = null;
    let nearestD = Infinity;

    const order = this._streamOrder;
    let n = 0;
    for (const room of this._rooms) {
      const a = room.aabb;
      const dx = Math.max(a.minX - fx, 0, fx - a.maxX);
      const dz = Math.max(a.minZ - fz, 0, fz - a.maxZ);
      const d = Math.hypot(dx, dz);
      // Hysteresis only applies to a room that was ALREADY drawn, and only on a
      // steady-state pass. On the forced first call every group is still at its
      // default `visible = true`, so honouring hysteresis there would widen the
      // radius for every room in the level and stream the whole thing in.
      const was = !force && room.group.visible;
      const limit = STREAM.drawRadius + (was ? STREAM.hysteresis : 0);
      room.group.visible = d <= limit;
      if (room.group.visible) {
        // Preallocated: `order` is sized to the room count in init(), so this
        // whole pass allocates nothing however many rooms are in range.
        order[n].room = room; order[n].d = d; n++;
      }
      if (d === 0 && inside === null) inside = room;
      if (d < nearestD) { nearestD = d; nearest = room; }
    }

    // HARD CAP, applied after the radius. See STREAM.maxRooms: a radius alone
    // does not bound the frame, it bounds the DISTANCE, and at a junction where
    // four rooms meet the two are not the same thing. Insertion sort because n
    // is single digits and `Array.sort` on a subrange would need a slice.
    if (n > STREAM.maxRooms) {
      for (let i = 1; i < n; i++) {
        const r = order[i].room, d = order[i].d;
        let j = i - 1;
        while (j >= 0 && order[j].d > d) { order[j + 1].room = order[j].room; order[j + 1].d = order[j].d; j--; }
        order[j + 1].room = r; order[j + 1].d = d;
      }
      for (let i = STREAM.maxRooms; i < n; i++) order[i].room.group.visible = false;
      n = STREAM.maxRooms;
    }
    this._roomsDrawn = n;

    // Always draw at least the nearest room, whatever the radius says — a debug
    // landmark may legitimately sit just outside every AABB and an empty frame
    // reads as a boot failure rather than as a framing mistake.
    if (nearest && !nearest.group.visible) { nearest.group.visible = true; this._roomsDrawn++; }

    const current = inside ?? nearest;
    if (current && (force || current !== this._currentRoom)) {
      this._currentRoom = current;
      this._roomPayload.room = current;
      this._roomPayload.cleared = false;
      ctx.events.emit('world:room', this._roomPayload);
      // Per-room atmosphere. `sky` owns the fog model; we only say how thick the
      // air is in this room, which is the difference between a flooded undercroft
      // and a hall open to the night sky.
      const sky = ctx.peek('sky');
      if (sky?.setFogDensity) sky.setFogDensity(this._fogFor(current));
      // Bounce fill follows the room: a sealed crypt gets a third of what a
      // hall with half its vault missing gets. One hemisphere light, retuned —
      // see tuning.js AMBIENT for why it is not one light per room.
      this.practicals.setRoomFill(current.kind);
      if (force) this.practicals.snapFill();
    }
  }

  /** Fog multiplier per room kind. Thick where the air should read as damp and
   *  thin where a long sightline has to survive it. */
  _fogFor(room) {
    switch (room.kind) {
      // Fog is the second fill lever and the only one that lifts the blacks
      // WITHOUT lifting a lit surface: in-scattering adds to empty air, so a
      // dark corridor gains information and a brazier pool does not change.
      // It also does the depth separation the frame needs, which is why the
      // long-sightline rooms get LESS of it, not more.
      case 'undercroft': return 2.0;
      case 'corridor': return 1.60;
      case 'passage': return 1.55;
      case 'ossuary': return 1.35;
      case 'chamber': return 1.30;
      case 'arena': return 0.95;
      case 'processional': return 0.85;
      case 'shrine': return 1.20;
      case 'catacomb': return 1.45;
      // The roofless rooms. Thin air, because their whole job is the long view:
      // a courtyard you cannot see across is just a dark room with no ceiling.
      case 'cloister': return 0.62;
      case 'nave': return 0.68;
      case 'bridge': return 0.55;
      case 'gallery': return 0.95;
      case 'reliquary': return 1.05;
      default: return 1.25;
    }
  }

  // =========================================================================
  // queries
  // =========================================================================

  /**
   * The room containing a world point, or null.
   *
   * TWO PASSES, AND THE ORDER MATTERS. A room at 45 degrees has an axis-aligned
   * bounding box 1.4x its real footprint, so the crypt corridor's AABB entirely
   * contains the side cell's — an AABB-only test returned `crypt` for every
   * point in the cell, which is wrong for the `world:room` event, wrong for the
   * per-room fog and the bounce fill, and wrong for anything that asks where the
   * player is. So the ROTATED rectangle is tested first and the AABB is only the
   * fallback, for the doorways and thresholds that sit outside every rectangle.
   */
  roomAt(x, z) {
    for (const room of this._rooms) {
      const dx = x - room.x, dz = z - room.z;
      const c = Math.cos(room.yaw), s = Math.sin(room.yaw);
      const lx = c * dx - s * dz, lz = s * dx + c * dz;
      if (Math.abs(lx) <= room.w * 0.5 + 0.9 && Math.abs(lz) <= room.d * 0.5 + 0.9) return room;
    }
    let best = null, bestD = Infinity;
    for (const room of this._rooms) {
      const a = room.aabb;
      if (x < a.minX || x > a.maxX || z < a.minZ || z > a.maxZ) continue;
      const d = (x - room.x) * (x - room.x) + (z - room.z) * (z - room.z);
      if (d < bestD) { bestD = d; best = room; }
    }
    return best;
  }

  get currentRoom() { return this._currentRoom; }

  // =========================================================================
  // debug hooks (called only from src/dev/shots.js and tools/)
  // =========================================================================

  /**
   * Where the shot harness stands the player and points the camera.
   *
   * These five coordinates are the highest-leverage thing in this subsystem:
   * every environment shot a critic sees is composed here. The rule for all of
   * them is the same — the SUBJECT must be up-screen of the landmark, i.e. at
   * −X −Z, because the camera eye sits at +X +Y +Z of its focus and that is the
   * only half of the world it can see. See layout.js for what each one frames.
   */
  debugFocus(name) {
    const l = this.level.landmarks[name] ?? this.level.landmarks.hall;
    return { pos: l, look: l };
  }

  /**
   * `clean` | `lit` | `dark`. Brazier gain plus the debris pass, so a critic can
   * separate "is the lighting wrong" from "is there too much stuff".
   */
  debugStage(name) {
    const stage = name ?? 'clean';
    this.practicals.setGain(stage === 'dark' ? 0.28 : stage === 'lit' ? 1.6 : 1.0);
    this._flameMat.uniforms.uParams.value.x = stage === 'dark' ? 0.35 : stage === 'lit' ? 1.4 : 1.0;
    return stage;
  }

  /**
   * What is under this screen point?
   *
   * `node arpg/tools/probe.mjs --shot=hero --eval="ctx.peek('world').debugPick(-0.37,-0.11)"`
   *
   * Exists because "why is that part of the frame black" is not answerable from
   * a screenshot: a shadow, a dark material and a piece of geometry the camera
   * should not be seeing all look identical, and each has a completely different
   * fix. NDC in [-1,1], y up. Dev only — it allocates.
   */
  debugPick(ndcX, ndcY, limit = 4) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.ctx.camera);
    const hits = rc.intersectObject(this.ctx.scene, true);
    return hits.slice(0, limit).map((h) => ({
      name: h.object.name || h.object.type,
      dist: +h.distance.toFixed(2),
      point: [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)],
      mat: h.object.material?.name || h.object.material?.userData?.mnSurface || '?',
    }));
  }

  /** Force every room visible, for a whole-level overview screenshot. */
  debugShowAll(on = true) {
    for (const r of this._rooms) r.group.visible = !!on;
    return this._rooms.length;
  }

  /**
   * CAN THE PLAYER ACTUALLY GET THERE?
   *
   * `node arpg/tools/probe.mjs --eval="ctx.peek('world').debugReach()"`
   *
   * The most valuable measurement in this subsystem, and the one whose absence
   * cost the most: the previous level looked correct in every screenshot and in
   * every stats() field while **five of its nine rooms were unreachable from the
   * spawn** — the crypt corridor's floor had holes in it because a rotated room
   * was given an axis-aligned slab, the crypt door's arch was 1.96 m to its
   * lintel collider so no actor could path under it, and the hall and undercroft
   * each built a solid flight of steps through the same three cubic metres.
   * None of those is visible in a frame. All three are obvious here.
   *
   * Floods a grid over the level using the same two questions `ai` asks —
   * is there ground, and is there 1.9 m of air above it — and reports how much
   * of the walkable floor the spawn can reach. Dev only: it allocates and it
   * costs a raycast per cell.
   */
  debugReach(cell = 1.0) {
    const physics = this.ctx.peek('physics');
    if (!physics?.groundAt) return { error: 'physics not registered' };
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of this._rooms) {
      minX = Math.min(minX, r.aabb.minX); maxX = Math.max(maxX, r.aabb.maxX);
      minZ = Math.min(minZ, r.aabb.minZ); maxZ = Math.max(maxZ, r.aabb.maxZ);
    }
    const w = Math.ceil((maxX - minX) / cell), h = Math.ceil((maxZ - minZ) / cell);
    const solid = new Uint8Array(w * h);
    const perRoom = new Map();
    let walkable = 0;
    for (let iz = 0; iz < h; iz++) {
      for (let ix = 0; ix < w; ix++) {
        const i = iz * w + ix;
        const x = minX + (ix + 0.5) * cell, z = minZ + (iz + 0.5) * cell;
        const room = this.roomAt(x, z);
        if (!room) { solid[i] = 1; continue; }
        const g = physics.groundAt(x, z, 12);
        if (!g) { solid[i] = 1; continue; }
        const up = physics.raycastFrom?.(x, g.y + 0.25, z, 0, 1, 0, 1.9);
        if (up?.hit) { solid[i] = 1; continue; }
        walkable++;
        perRoom.set(room.id, (perRoom.get(room.id) ?? 0) + 1);
      }
    }
    // Four-connected flood from the spawn: an actor with a body radius cannot
    // squeeze through a corner where two solids touch diagonally, so counting
    // that as connected would report a level as reachable that is not.
    const seen = new Uint8Array(w * h);
    const q = new Int32Array(w * h);
    let head = 0, tail = 0, reached = 0;
    const sx = Math.floor((this.spawn.x - minX) / cell), sz = Math.floor((this.spawn.z - minZ) / cell);
    const s0 = sz * w + sx;
    if (sx >= 0 && sz >= 0 && sx < w && sz < h && !solid[s0]) { q[tail++] = s0; seen[s0] = 1; }
    const hit = new Map();
    while (head < tail) {
      const i = q[head++]; reached++;
      const ix = i % w, iz = (i / w) | 0;
      const room = this.roomAt(minX + (ix + 0.5) * cell, minZ + (iz + 0.5) * cell);
      if (room) hit.set(room.id, (hit.get(room.id) ?? 0) + 1);
      if (ix > 0 && !solid[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; q[tail++] = i - 1; }
      if (ix < w - 1 && !solid[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; q[tail++] = i + 1; }
      if (iz > 0 && !solid[i - w] && !seen[i - w]) { seen[i - w] = 1; q[tail++] = i - w; }
      if (iz < h - 1 && !solid[i + w] && !seen[i + w]) { seen[i + w] = 1; q[tail++] = i + w; }
    }
    const rooms = this._rooms.map((r) => ({
      id: r.id, kind: r.kind, walk: perRoom.get(r.id) ?? 0, reach: hit.get(r.id) ?? 0,
    }));
    return {
      grid: `${w}x${h}`, cell,
      aabb: { minX: +minX.toFixed(1), maxX: +maxX.toFixed(1), minZ: +minZ.toFixed(1), maxZ: +maxZ.toFixed(1) },
      spanX: +(maxX - minX).toFixed(1), spanZ: +(maxZ - minZ).toFixed(1),
      walkable, reached, unreachable: walkable - reached,
      sealedRooms: rooms.filter((r) => r.reach === 0).map((r) => r.id),
      rooms,
    };
  }

  stats() {
    let tris = 0, meshes = 0, visible = 0;
    for (const r of this._rooms) {
      if (r.group.visible) visible++;
      r.group.traverse((o) => {
        if (!o.isMesh) return;
        meshes++;
        const c = o.geometry?.attributes?.position?.count ?? 0;
        tris += (c / 3) * (o.isInstancedMesh ? o.count : 1);
      });
    }
    return {
      name: this._ready?.name,
      seed: `0x${(this.ctx.config.seed >>> 0).toString(16)}`,
      buildMs: +this._buildMs.toFixed(0),
      rooms: this._rooms.length,
      roomKinds: this._rooms.reduce((m, r) => { m[r.kind] = (m[r.kind] ?? 0) + 1; return m; }, {}),
      roomsVisible: visible,
      roomsDrawn: this._roomsDrawn,
      streamCap: STREAM.maxRooms,
      worldAabb: (() => {
        let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
        for (const r of this._rooms) {
          a = Math.min(a, r.aabb.minX); b = Math.max(b, r.aabb.maxX);
          c = Math.min(c, r.aabb.minZ); d = Math.max(d, r.aabb.maxZ);
        }
        return { minX: +a.toFixed(1), maxX: +b.toFixed(1), minZ: +c.toFixed(1), maxZ: +d.toFixed(1),
                 spanX: +(b - a).toFixed(1), spanZ: +(d - c).toFixed(1) };
      })(),
      links: this.level.links.length,
      meshes,
      triangles: Math.round(tris),
      colliders: this._colliderCount,
      colliderTris: this._colliderCount * 12,
      staticObjects: this._staticIds.length,
      flames: this._flameCount ?? 0,
      practicals: this.practicals.stats(),
      occluders: this._occluderMeshes.length,
      currentRoom: this._currentRoom?.id ?? null,
      landmarks: this.level.landmarks,
      overlaps: this.level.overlaps,
      graph: this.level.edges.map((e) => `${e.a}-${e.b}${e.kind === 'loop' ? '*' : ''}`),
      dress: Object.keys(DRESS),
    };
  }

  dispose() {
    this._offPlayer?.();
    this.practicals?.dispose();

    const physics = this.ctx?.peek?.('physics');
    if (physics?.removeStatic) for (const id of this._staticIds) physics.removeStatic(id);
    this._staticIds.length = 0;

    for (const m of this._occluderMeshes) this.render?.unregisterOccluderFade?.(m);
    this._occluderMeshes.length = 0;

    for (const g of this._geometries) g.dispose();
    this._geometries.length = 0;
    for (const m of this._ownMaterials) m.dispose();
    this._ownMaterials.length = 0;
    this._debrisGeo.clear();
    this._rooms.length = 0;

    this.root?.parent?.remove(this.root);
  }
}
