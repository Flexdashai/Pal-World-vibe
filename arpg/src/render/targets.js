import * as THREE from 'three';

/**
 * Render-target allocation for the HDR pipeline.
 *
 * Two rules the rest of the directory relies on:
 *
 *  1. Every colour target is `HalfFloatType`. The scene is lit with real
 *     candela-scale intensities from palette.LIGHTS, so a brazier is genuinely
 *     ~26 units of radiance at 1 m; an 8-bit target clips it to white before
 *     bloom or the tone curve ever see it, and that single decision is the
 *     difference between "fire" and "white blob".
 *  2. Nothing is ever reallocated outside `resize()`. Passes hold texture
 *     references through `SharedUniform` objects that `resize()` re-points, so
 *     no per-frame lookup is needed.
 */

const COMMON = {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
};

/** Colour target, no depth. */
export function colorTarget(w, h, name, extra = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { ...COMMON, ...extra });
  rt.texture.name = name;
  // NoColorSpace == the linear working space. Setting SRGBColorSpace here would
  // make three inject a decode when the texture is sampled by a built-in
  // material, which would double-decode our HDR data.
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

/**
 * The depth/normal/velocity prepass target.
 *
 * MRT layout (MAX_DRAW_BUFFERS is 6 on this ANGLE/SwiftShader build; we use 2,
 * because everything else the pipeline needs is derivable and each extra
 * attachment is a full-resolution write on a CPU rasteriser):
 *
 *   COLOR0  rgb = view-space normal, a = perceptual roughness
 *   COLOR1  rg  = screen-space motion vector (UV units, current -> previous)
 *           b   = metalness, a = coverage mask (1 = geometry, 0 = sky)
 *   DEPTH   sampled hardware depth, 24-bit
 *
 * The depth texture deliberately belongs to THIS target and not to the HDR
 * target. Sharing one depth attachment between the prepass and the lit pass
 * would save a depth clear, but it would also mean `r.depthTexture` is bound as
 * a framebuffer attachment while `fx` samples it for soft particles during the
 * lit pass — an undefined-behaviour feedback loop. Keeping them separate also
 * means the sampled depth contains opaque geometry only, which is exactly what
 * SSR, GTAO and DOF want.
 */
export function prepassTarget(w, h) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    count: 2,
  });
  rt.textures[0].name = 'mn.normalRoughness';
  rt.textures[1].name = 'mn.velocityMetal';
  for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;

  const depth = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h));
  depth.type = THREE.UnsignedIntType;   // DEPTH_COMPONENT24 — near=1 far=140 has room to spare
  depth.format = THREE.DepthFormat;
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;
  depth.name = 'mn.depth';
  rt.depthTexture = depth;
  return rt;
}

/** The HDR scene target. Owns its own depth RENDERBUFFER (not a texture), see
 *  the note on `prepassTarget`. */
export function hdrTarget(w, h) {
  const rt = colorTarget(w, h, 'mn.hdr', { depthBuffer: true });
  return rt;
}

/** Dispose a target and (for MRT) all of its attachments. */
export function disposeTarget(rt) {
  if (!rt) return;
  rt.depthTexture?.dispose?.();
  rt.dispose();
}

/**
 * Bookkeeping for a ping-pong pair. Temporal passes (TAA, AO history, SSR
 * history) all want "read last frame, write this frame, swap"; doing it by hand
 * in four places is how a swap gets missed and a pass silently reads its own
 * output.
 */
export class PingPong {
  constructor(make) {
    this._make = make;
    this.a = null;
    this.b = null;
  }

  allocate(w, h) {
    disposeTarget(this.a);
    disposeTarget(this.b);
    this.a = this._make(w, h, 'a');
    this.b = this._make(w, h, 'b');
  }

  /** Target written this frame. */
  get write() { return this.a; }
  /** Target written last frame. */
  get read() { return this.b; }

  swap() { const t = this.a; this.a = this.b; this.b = t; }

  dispose() {
    disposeTarget(this.a);
    disposeTarget(this.b);
    this.a = this.b = null;
  }
}
