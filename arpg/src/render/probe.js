import * as THREE from 'three';
import { ENV, LIGHTS, ELEMENTS } from '../core/palette.js';

/**
 * Renderer diagnostic scene — `?renderdebug=1` ONLY.
 *
 * This is not content and it is not `world`'s job being done here. It exists
 * because several passes in this pipeline cannot be verified against an empty
 * stub scene at all:
 *
 *   - SSR needs a low-roughness surface AND something bright to reflect;
 *   - bloom needs real emissive radiance, not a lit diffuse surface;
 *   - the contact-hardening shadow filter needs an occluder close to a wall and
 *     another one far from it, in the same frame;
 *   - the grade needs a violet source to prove hue-selective saturation works;
 *   - the occluder fade needs something registered to fade.
 *
 * Everything is procedural, seeded from `ctx.rng.fork()`, and disposed with the
 * subsystem. It is never constructed unless the URL parameter is present, so it
 * cannot affect any other agent's capture.
 */
export class RenderProbeScene {
  constructor(ctx, render) {
    this.ctx = ctx;
    this.render = render;
    this.rng = ctx.rng.fork();
    this.root = new THREE.Group();
    this.root.name = 'mn.renderProbe';
    ctx.scene.add(this.root);

    this._materials = [];
    this._geometries = [];
    this._t = 0;

    const col = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);

    // --- wet flagstone slab -------------------------------------------------
    // Low roughness so SSR actually traces; this is the surface the flames must
    // appear in.
    const floorGeo = new THREE.PlaneGeometry(26, 26, 1, 1);
    const floorMat = new THREE.MeshStandardMaterial({
      color: col(ENV.flagstone), roughness: 0.22, metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.011;
    floor.receiveShadow = true;
    this.root.add(floor);
    this._track(floorGeo, floorMat);

    // --- pillars, roughness sweep -------------------------------------------
    const pillarGeo = new THREE.CylinderGeometry(0.42, 0.5, 4.4, 12, 1);
    this._geometries.push(pillarGeo);
    for (let i = 0; i < 6; i++) {
      const rough = 0.18 + i * 0.14;
      const mat = new THREE.MeshStandardMaterial({
        color: col(ENV.stoneCold), roughness: rough, metalness: i === 5 ? 1.0 : 0.0,
      });
      const m = new THREE.Mesh(pillarGeo, mat);
      const a = (i / 6) * Math.PI * 2 + 0.4;
      m.position.set(Math.cos(a) * 6.5, 2.2, Math.sin(a) * 6.5);
      m.castShadow = m.receiveShadow = true;
      this.root.add(m);
      this._materials.push(mat);
    }

    // --- a wall that occludes the player, registered for the fade -----------
    const wallGeo = new THREE.BoxGeometry(11, 5.2, 0.7);
    const wallMat = new THREE.MeshStandardMaterial({ color: col(ENV.stoneWarm), roughness: 0.78 });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(3.6, 2.6, 3.6);
    wall.rotation.y = -Math.PI / 4;
    wall.castShadow = wall.receiveShadow = true;
    this.root.add(wall);
    this._track(wallGeo, wallMat);
    render.registerOccluderFade(wall);

    // --- contact-hardening test: a bar close to the wall, an arch far from it
    const barGeo = new THREE.BoxGeometry(0.14, 0.14, 3.2);
    const barMat = new THREE.MeshStandardMaterial({ color: col(ENV.ironDark), roughness: 0.42, metalness: 1.0 });
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.set(2.2, 3.4, 2.2);
    bar.rotation.y = -Math.PI / 4;
    bar.castShadow = true;
    this.root.add(bar);
    this._track(barGeo, barMat);

    const archGeo = new THREE.TorusGeometry(2.2, 0.22, 8, 20, Math.PI);
    const archMat = new THREE.MeshStandardMaterial({ color: col(ENV.stoneCold), roughness: 0.86 });
    const arch = new THREE.Mesh(archGeo, archMat);
    arch.position.set(-7.5, 0.05, -7.5);
    arch.rotation.y = Math.PI * 0.25;
    arch.castShadow = arch.receiveShadow = true;
    this.root.add(arch);
    this._track(archGeo, archMat);

    // --- rubble: AO in crevices, varied instance transforms ------------------
    const rubbleGeo = new THREE.IcosahedronGeometry(0.34, 0);
    this._geometries.push(rubbleGeo);
    const rubbleMat = new THREE.MeshStandardMaterial({ color: col(ENV.stoneCold), roughness: 0.9 });
    this._materials.push(rubbleMat);
    const rubble = new THREE.InstancedMesh(rubbleGeo, rubbleMat, 40);
    rubble.castShadow = rubble.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const eu = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (let i = 0; i < 40; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const rr = this.rng.range(1.6, 9.5);
      pos.set(Math.cos(a) * rr, this.rng.range(0.08, 0.3), Math.sin(a) * rr);
      eu.set(this.rng.range(0, 6.28), this.rng.range(0, 6.28), this.rng.range(0, 6.28));
      qt.setFromEuler(eu);
      const s = this.rng.range(0.5, 1.5);
      scl.set(s, s * this.rng.range(0.6, 1.0), s);
      rubble.setMatrixAt(i, m4.compose(pos, qt, scl));
    }
    rubble.instanceMatrix.needsUpdate = true;
    this.root.add(rubble);
    this.rubble = rubble;

    // --- brazier: the key light, and the thing SSR must reflect -------------
    const bowlGeo = new THREE.CylinderGeometry(0.44, 0.26, 0.42, 12);
    const bowlMat = new THREE.MeshStandardMaterial({ color: col(ENV.ironDark), roughness: 0.55, metalness: 1.0 });
    const bowl = new THREE.Mesh(bowlGeo, bowlMat);
    bowl.position.set(4.0, 1.35, -3.0);
    bowl.castShadow = true;
    this.root.add(bowl);
    this._track(bowlGeo, bowlMat);

    const flameGeo = new THREE.SphereGeometry(0.34, 12, 10);
    const flameMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0, 0, 0),
      emissive: col(ELEMENTS.fire.core),
      // Real radiance, not a colour: this is what drives the threshold-free
      // bloom pyramid and what SSR picks up off the wet floor.
      emissiveIntensity: 34,
      roughness: 1.0,
    });
    this.flame = new THREE.Mesh(flameGeo, flameMat);
    this.flame.position.set(4.0, 1.72, -3.0);
    this.flame.userData.mnGlow = 1.4;
    this.flame.userData.mnNoShadow = true;
    this.root.add(this.flame);
    this._track(flameGeo, flameMat);

    this.brazierLight = new THREE.PointLight(col(LIGHTS.brazier.color), LIGHTS.brazier.intensity, LIGHTS.brazier.radius, 2);
    this.brazierLight.position.copy(this.flame.position);
    this.root.add(this.brazierLight);
    render.addLight(this.brazierLight);

    // --- shadow-magic shrine: the one saturated colour in the frame ---------
    const crystalGeo = new THREE.OctahedronGeometry(0.62, 0);
    const crystalMat = new THREE.MeshStandardMaterial({
      color: col(ENV.crystal),
      emissive: col(ELEMENTS.shadow.core),
      emissiveIntensity: 12,
      roughness: 0.18,
      metalness: 0.0,
    });
    this.crystal = new THREE.Mesh(crystalGeo, crystalMat);
    this.crystal.position.set(-5.0, 1.1, -4.4);
    this.crystal.userData.mnGlow = 1.2;
    this.root.add(this.crystal);
    this._track(crystalGeo, crystalMat);

    this.riftLight = new THREE.PointLight(col(LIGHTS.shadowRift.color), LIGHTS.shadowRift.intensity, LIGHTS.shadowRift.radius, 2);
    this.riftLight.position.copy(this.crystal.position);
    this.root.add(this.riftLight);
    render.addLight(this.riftLight);
  }

  _track(geo, mat) {
    this._geometries.push(geo);
    this._materials.push(mat);
  }

  update(ctx) {
    // Flicker driven by the clock only (deterministic in capture: the harness
    // pumps a fixed number of fixed-length frames).
    const t = ctx.time.elapsed;
    const f = 0.82 + 0.18 * Math.sin(t * 11.3) * Math.sin(t * 6.7) + 0.06 * Math.sin(t * 23.1);
    this.brazierLight.intensity = LIGHTS.brazier.intensity * f;
    this.flame.scale.setScalar(0.92 + 0.12 * f);
    this.crystal.rotation.y = t * 0.35;
    this.riftLight.intensity = LIGHTS.shadowRift.intensity * (0.9 + 0.1 * Math.sin(t * 2.1));
  }

  dispose() {
    this.root.parent?.remove(this.root);
    for (const g of this._geometries) g.dispose();
    for (const m of this._materials) m.dispose();
    this._geometries.length = 0;
    this._materials.length = 0;
  }
}
