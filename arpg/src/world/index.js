import * as THREE from 'three';
import { ENV, LIGHTS } from '../core/palette.js';

/** STUB — replaced by the world agent. Enough geometry and light that the capture
 *  harness produces a real, non-black frame and every integration point is live. */
export class WorldSystem {
  static id = 'world';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    ctx.scene.add(this.root);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60, 40, 40),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...ENV.flagstone), roughness: 0.72, metalness: 0.0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.root.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...ENV.stoneCold), roughness: 0.85 });
    const rng = ctx.rng.fork();
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(rng.range(1, 3), rng.range(1.5, 3.5), rng.range(1, 3)), wallMat);
      const a = (i / 24) * Math.PI * 2;
      m.position.set(Math.cos(a) * rng.range(9, 16), 1.2, Math.sin(a) * rng.range(9, 16));
      m.rotation.y = rng.range(0, Math.PI);
      m.castShadow = m.receiveShadow = true;
      this.root.add(m);
    }

    const key = new THREE.DirectionalLight(new THREE.Color().setRGB(...LIGHTS.moon.color), 2.2);
    key.position.set(-9, 14, -6);
    key.castShadow = true;
    key.shadow.mapSize.set(ctx.config.q.shadowMapSize, ctx.config.q.shadowMapSize);
    const c = key.shadow.camera;
    c.left = -22; c.right = 22; c.top = 22; c.bottom = -22; c.near = 1; c.far = 60;
    this.root.add(key);
    this.root.add(new THREE.HemisphereLight(0x2a3550, 0x0a0806, 0.5));

    const brazier = new THREE.PointLight(new THREE.Color().setRGB(...LIGHTS.brazier.color), LIGHTS.brazier.intensity, LIGHTS.brazier.radius, 2);
    brazier.position.set(4, 1.6, -3);
    this.root.add(brazier);

    ctx.events.emit('world:ready', { level: 1, rooms: 1, spawn: new THREE.Vector3(0, 0, 0) });
  }

  /** Named landmarks the shot harness frames. Coordinates never leave this file. */
  debugFocus(name) {
    const spots = {
      hall: { pos: [0, 0, 0], look: [0, 0, 0] },
      corridor: { pos: [8, 0, 6], look: [8, 0, 6] },
      shrine: { pos: [-8, 0, -6], look: [-8, 0, -6] },
      arena: { pos: [0, 0, -12], look: [0, 0, -12] },
      gate: { pos: [12, 0, 0], look: [12, 0, 0] },
    };
    return spots[name] ?? spots.hall;
  }

  debugStage() {}
  stats() { return { meshes: this.root.children.length }; }
  dispose() { this.root.parent?.remove(this.root); }
}
