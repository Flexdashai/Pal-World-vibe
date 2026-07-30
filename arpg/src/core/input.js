import * as THREE from 'three';

/**
 * ARPG input. Unlike an FPS there is no pointer lock — the cursor is the aim, so
 * the two things every system asks for are "where on the ground is the mouse" and
 * "is button/skill X held or freshly pressed this frame".
 *
 * Edge state (`pressed` / `released`) is latched during the frame and cleared in
 * `endFrame()`, so a system that runs late in the frame order sees the same edges
 * as one that runs early.
 */

/** Action names are stable across the codebase; rebinding only changes the map. */
export const ACTIONS = {
  KeyW: 'up', KeyA: 'left', KeyS: 'down', KeyD: 'right',
  ArrowUp: 'up', ArrowLeft: 'left', ArrowDown: 'down', ArrowRight: 'right',
  Space: 'dash',
  ShiftLeft: 'forceStand', ShiftRight: 'forceStand',
  Digit1: 'skill1', Digit2: 'skill2', Digit3: 'skill3', Digit4: 'skill4',
  KeyQ: 'skillQ', KeyE: 'skillE', KeyR: 'ultimate', KeyF: 'arise',
  Tab: 'inventory', KeyC: 'character', KeyM: 'map', Escape: 'menu',
  KeyG: 'pickup',
};

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    /** Cursor in normalised device coords, -1..1, y up. */
    this.ndc = new THREE.Vector2(0, 0);
    /** Cursor in CSS pixels. */
    this.screen = new THREE.Vector2(0, 0);
    /** Cursor projected onto the y = groundY plane. Refreshed by `sample()`. */
    this.ground = new THREE.Vector3(0, 0, 0);
    /** True once the cursor ray actually hit the ground plane this frame. */
    this.groundValid = false;

    this.buttons = new Set();      // 0 left, 2 right
    this.buttonsPressed = new Set();
    this.buttonsReleased = new Set();
    this.keys = new Set();         // action names
    this.keysPressed = new Set();
    this.keysReleased = new Set();
    this.wheel = 0;

    /** Movement intent from WASD, normalised, in WORLD space (camera-relative). */
    this.moveAxis = new THREE.Vector2(0, 0);

    /** Set true by the capture harness so a stray real event cannot move the game. */
    this.frozen = false;
    this.enabled = true;

    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._ray = new THREE.Raycaster();
    this._hit = new THREE.Vector3();
    this._attached = false;

    this._onMove = this._onMove.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onContext = (e) => e.preventDefault();
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    const c = this.canvas;
    c.addEventListener('pointermove', this._onMove);
    c.addEventListener('pointerdown', this._onDown);
    addEventListener('pointerup', this._onUp);
    addEventListener('keydown', this._onKeyDown);
    addEventListener('keyup', this._onKeyUp);
    c.addEventListener('wheel', this._onWheel, { passive: false });
    c.addEventListener('contextmenu', this._onContext);
    addEventListener('blur', this._onBlur);
  }

  detach() {
    if (!this._attached) return;
    this._attached = false;
    const c = this.canvas;
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerdown', this._onDown);
    removeEventListener('pointerup', this._onUp);
    removeEventListener('keydown', this._onKeyDown);
    removeEventListener('keyup', this._onKeyUp);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('contextmenu', this._onContext);
    removeEventListener('blur', this._onBlur);
  }

  _setNdc(x, y) {
    const r = this.canvas.getBoundingClientRect();
    this.screen.set(x - r.left, y - r.top);
    this.ndc.set(
      ((x - r.left) / Math.max(1, r.width)) * 2 - 1,
      -(((y - r.top) / Math.max(1, r.height)) * 2 - 1)
    );
  }

  _onMove(e) {
    if (this.frozen || !this.enabled) return;
    this._setNdc(e.clientX, e.clientY);
  }

  _onDown(e) {
    if (this.frozen || !this.enabled) return;
    this._setNdc(e.clientX, e.clientY);
    if (!this.buttons.has(e.button)) this.buttonsPressed.add(e.button);
    this.buttons.add(e.button);
    e.preventDefault();
  }

  _onUp(e) {
    if (this.frozen || !this.enabled) return;
    if (this.buttons.delete(e.button)) this.buttonsReleased.add(e.button);
  }

  _onKeyDown(e) {
    if (this.frozen || !this.enabled) return;
    const a = ACTIONS[e.code];
    if (!a) return;
    if (!e.repeat && !this.keys.has(a)) this.keysPressed.add(a);
    this.keys.add(a);
    // Tab and Space would otherwise scroll or move focus out of the canvas.
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
  }

  _onKeyUp(e) {
    if (this.frozen || !this.enabled) return;
    const a = ACTIONS[e.code];
    if (a && this.keys.delete(a)) this.keysReleased.add(a);
  }

  _onWheel(e) {
    if (this.frozen || !this.enabled) return;
    this.wheel += Math.sign(e.deltaY);
    e.preventDefault();
  }

  /** Losing focus must drop every held key, or the player runs forever. */
  _onBlur() {
    for (const a of this.keys) this.keysReleased.add(a);
    for (const b of this.buttons) this.buttonsReleased.add(b);
    this.keys.clear();
    this.buttons.clear();
  }

  // ---- per-frame ----------------------------------------------------------

  beginFrame() {
    const up = (this.keys.has('up') ? 1 : 0) - (this.keys.has('down') ? 1 : 0);
    const right = (this.keys.has('right') ? 1 : 0) - (this.keys.has('left') ? 1 : 0);
    // Screen "up" is -X-Z and screen "right" is +X-Z under the fixed 45° yaw, so
    // WASD maps onto the world basis rotated by the camera yaw.
    this.moveAxis.set(right, up);
    if (this.moveAxis.lengthSq() > 1) this.moveAxis.normalize();
  }

  endFrame() {
    this.buttonsPressed.clear();
    this.buttonsReleased.clear();
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.wheel = 0;
  }

  /**
   * Project the cursor onto the ground plane at height `y`. Call once per frame
   * from whoever owns the camera (player), before anything reads `.ground`.
   */
  sample(camera, y = 0) {
    this._plane.constant = -y;
    this._ray.setFromCamera(this.ndc, camera);
    const hit = this._ray.ray.intersectPlane(this._plane, this._hit);
    this.groundValid = !!hit;
    if (hit) this.ground.copy(this._hit);
    return this.ground;
  }

  // ---- queries ------------------------------------------------------------

  down(action) { return this.keys.has(action); }
  pressed(action) { return this.keysPressed.has(action); }
  released(action) { return this.keysReleased.has(action); }
  mouse(btn = 0) { return this.buttons.has(btn); }
  mousePressed(btn = 0) { return this.buttonsPressed.has(btn); }
  mouseReleased(btn = 0) { return this.buttonsReleased.has(btn); }

  /** Force-feed state from a script (playtest harness, shot definitions). */
  inject({ ndc, keys, buttons } = {}) {
    if (ndc) this.ndc.set(ndc[0], ndc[1]);
    if (keys) {
      for (const k of keys) if (!this.keys.has(k)) this.keysPressed.add(k);
      for (const k of this.keys) if (!keys.includes(k)) this.keysReleased.add(k);
      this.keys = new Set(keys);
    }
    if (buttons) {
      for (const b of buttons) if (!this.buttons.has(b)) this.buttonsPressed.add(b);
      this.buttons = new Set(buttons);
    }
  }
}
