import * as THREE from 'three';
import { Registry, EventBus } from './registry.js';
import { FIXED_DT, MAX_SUBSTEPS, CAMERA } from './config.js';
import { Input } from './input.js';
import { Rng } from './rng.js';

/**
 * The Engine owns the frame loop and the shared context handed to every
 * subsystem. It does NOT know what any subsystem does — it only sequences them.
 *
 * Frame order:
 *   1. input.beginFrame()
 *   2. fixedUpdate(FIXED_DT) xN   — physics, deterministic gameplay
 *   3. update(dt)                 — animation, cameras, AI decisions
 *   4. lateUpdate(dt)             — anything that must observe final transforms
 *   5. render subsystem draws
 *   6. input.endFrame()
 */
export class Engine {
  constructor({ canvas, config }) {
    this.canvas = canvas;
    this.config = config;
    this.registry = new Registry();
    this.events = new EventBus();
    this.input = new Input(canvas, config);
    this.rng = new Rng(config.deterministic ? config.seed >>> 0 : (Math.random() * 2 ** 32) >>> 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
    this.camera.rotation.order = 'YXZ';
    // eye = focus - forward*boom; see the sign note in src/dev/shots.js.
    this.camera.position.set(
      Math.sin(CAMERA.yaw) * CAMERA.boom * Math.cos(CAMERA.pitch),
      -Math.sin(CAMERA.pitch) * CAMERA.boom,
      Math.cos(CAMERA.yaw) * CAMERA.boom * Math.cos(CAMERA.pitch)
    );
    this.camera.rotation.set(CAMERA.pitch, CAMERA.yaw, 0);

    /** Overlay scene drawn after the world with a cleared depth buffer, for things
     *  that must never be occluded: selection rings, world-space damage numbers,
     *  the ground cursor. Uses the SAME projection as `camera` so world positions
     *  map 1:1 — it is a depth-cleared pass, not a different view. */
    this.uiScene = new THREE.Scene();
    this.uiCamera = this.camera;

    this.time = {
      /** Seconds since start, scaled by hit-stop / slow-mo. */ elapsed: 0,
      /** Unscaled wall-clock seconds since start. */ raw: 0,
      /** Last frame delta, scaled and clamped. */ dt: 0,
      /** Unscaled frame delta — UI animation only. */ rawDt: 0,
      /** Fixed step. */ fixed: FIXED_DT,
      /** Interpolation alpha between the last two fixed steps, 0..1. */ alpha: 0,
      /** Driven by `time:hitstop`. Gameplay reads dt, which already includes it. */
      scale: 1,
      frame: 0,
    };

    this.ctx = {
      engine: this,
      scene: this.scene,
      camera: this.camera,
      uiScene: this.uiScene,
      uiCamera: this.uiCamera,
      canvas,
      config,
      events: this.events,
      input: this.input,
      time: this.time,
      rng: this.rng,
      get: (id) => this.registry.get(id),
      peek: (id) => this.registry.peek(id),
      has: (id) => this.registry.has(id),
    };

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._hitstop = 0;
    this._hitstopScale = 0;
    this._onResize = () => this.resize();

    // Hit-stop is owned by the engine because it must gate the fixed-step
    // accumulator, which no subsystem can reach. `combat` emits, engine applies.
    this.events.on('time:hitstop', (e) => {
      const d = Math.min(this.config.hitstopMax, e?.duration ?? 0.06);
      // Overlapping hits extend rather than restart — a 6-hit flurry should not
      // freeze for 6x as long as one hit.
      if (d > this._hitstop) {
        this._hitstop = d;
        this._hitstopScale = e?.scale ?? 0.04;
      }
    });
  }

  add(SystemClass, opts) {
    this.registry.add(new SystemClass(opts));
    return this;
  }

  async init() {
    const order = this.registry.resolve();
    for (const sys of order) {
      const t0 = performance.now();
      await sys.init?.(this.ctx);
      const ms = performance.now() - t0;
      if (ms > 50) console.info(`[engine] ${sys.constructor.id} init ${ms.toFixed(0)}ms`);
    }
    this.input.attach();
    addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const sys of this.registry.with('resize')) sys.resize(w, h, this.ctx);
    this.events.emit('resize', { width: w, height: h });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  stop() { this._running = false; }

  _loop(now) {
    if (!this._running) return;
    requestAnimationFrame(this._loop);
    this.step(now);
  }

  /** Advance one frame. Exposed so the capture harness can pump frames by hand. */
  step(now = performance.now()) {
    const t = this.time;
    // Clamp so a tab-switch, a breakpoint, or a 1.2 s software-rendered frame
    // doesn't teleport the simulation.
    const rawDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    t.raw += rawDt;
    t.rawDt = rawDt;

    if (this._hitstop > 0) {
      this._hitstop -= rawDt;
      t.scale = this._hitstopScale;
      if (this._hitstop <= 0) { this._hitstop = 0; t.scale = 1; }
    } else if (t.scale !== 1) {
      t.scale = 1;
    }

    t.dt = rawDt * t.scale;
    t.elapsed += t.dt;
    t.frame++;

    this.input.beginFrame();

    this._accum += t.dt;
    let steps = 0;
    const fixedSystems = this.registry.with('fixedUpdate');
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const sys of fixedSystems) sys.fixedUpdate(FIXED_DT, this.ctx);
      this._accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._accum = 0; // shed backlog rather than spiral
    t.alpha = this._accum / FIXED_DT;

    for (const sys of this.registry.with('update')) sys.update(t.dt, this.ctx);
    for (const sys of this.registry.with('lateUpdate')) sys.lateUpdate(t.dt, this.ctx);

    const renderSystem = this.registry.peek('render');
    if (typeof renderSystem?.render === 'function') renderSystem.render(this.ctx);

    this.input.endFrame();
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.input.detach();
    for (const sys of [...this.registry.ordered].reverse()) sys.dispose?.();
    this.events.clear();
  }
}
