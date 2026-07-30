import * as THREE from 'three';

/**
 * STUB — replaced by the render agent.
 * Owns the WebGLRenderer, the HDR pipeline and the final composite. This version
 * exists only so the boot path, the shot harness and every other subsystem's
 * integration points are real from day one.
 */
export class RenderSystem {
  static id = 'render';
  static deps = [];

  async init(ctx) {
    this.ctx = ctx;
    this.renderer = new THREE.WebGLRenderer({
      canvas: ctx.canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = ctx.config.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.screenSize = { width: 1, height: 1 };
    this._lights = [];
    this._passes = [];
    this._occluders = [];
  }

  addLight(l) { this._lights.push(l); return l; }
  registerPass(p) { this._passes.push(p); return p; }
  registerOccluderFade(m) { this._occluders.push(m); return m; }
  requestEnvMap() { return this.ctx.peek('sky')?.envMap ?? null; }
  resetTemporal() {}

  resize(w, h) {
    this.screenSize.width = w; this.screenSize.height = h;
    this.renderer.setSize(w, h, false);
  }

  render(ctx) {
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(ctx.scene, ctx.camera);
    if (ctx.uiScene.children.length) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(ctx.uiScene, ctx.uiCamera);
      this.renderer.autoClear = true;
    }
  }

  dispose() { this.renderer?.dispose(); }
}
