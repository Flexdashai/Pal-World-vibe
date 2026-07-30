import * as THREE from 'three';
import { CAMERA, UNITS } from '../core/config.js';

/** STUB — replaced by the player agent. */
export class PlayerSystem {
  static id = 'player';
  static deps = ['render', 'world'];

  async init(ctx) {
    this.ctx = ctx;
    this.isPlayer = true;
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.radius = UNITS.playerRadius;
    this.height = UNITS.playerHeight;
    this.stats = { hp: 100, hpMax: 100, level: 1, armour: 0, poise: 40 };
    this.alive = true;
    this.controlEnabled = true;

    this.root = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(this.radius, this.height - this.radius * 2, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x2a2733, roughness: 0.6, metalness: 0.2 })
    );
    body.position.y = this.height * 0.5;
    body.castShadow = true;
    this.root.add(body);
    ctx.scene.add(this.root);
    this._focus = new THREE.Vector3();
  }

  setControlEnabled(v) { this.controlEnabled = v; }
  teleport(p) { this.position.copy(p); this.position.y = 0; this.root.position.copy(this.position); }
  debugPose() {}

  update(dt, ctx) {
    if (this.controlEnabled) {
      ctx.input.sample(ctx.camera, 0);
      const a = ctx.input.moveAxis;
      if (a.lengthSq() > 0) {
        // WASD is camera-relative: screen up is -X-Z, screen right is +X-Z.
        const s = Math.sin(CAMERA.yaw), c = Math.cos(CAMERA.yaw);
        this.velocity.set(a.x * c + a.y * s, 0, -a.x * s + a.y * c).normalize().multiplyScalar(6.2);
      } else this.velocity.set(0, 0, 0);
      this.position.addScaledVector(this.velocity, dt);
      this.root.position.copy(this.position);
    }
    // CONTRACT: when control is disabled the shot harness owns the camera. A
    // player system that keeps driving it silently overrides every shot's framing.
    if (!this.controlEnabled) return;
    this._focus.copy(this.position); this._focus.y += CAMERA.focusLift;
    const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch);
    ctx.camera.position.set(
      this._focus.x + Math.sin(CAMERA.yaw) * CAMERA.boom * cp,
      this._focus.y - sp * CAMERA.boom,
      this._focus.z + Math.cos(CAMERA.yaw) * CAMERA.boom * cp
    );
    ctx.camera.rotation.set(CAMERA.pitch, CAMERA.yaw, 0);
  }

  dispose() { this.root.parent?.remove(this.root); }
}
