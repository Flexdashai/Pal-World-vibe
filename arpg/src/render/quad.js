import * as THREE from 'three';
import { QUAD_VERT } from './glsl.js';

/**
 * Fullscreen-triangle post-pass plumbing.
 *
 * A single shared triangle mesh is re-pointed at each pass's material, so the
 * whole post chain costs exactly one geometry upload and zero per-frame
 * allocation. `renderer.render( mesh, camera )` is legal — three accepts any
 * Object3D as the scene argument, and a non-Scene root skips background, fog and
 * environment handling, which is what we want here.
 */
export class ScreenQuad {
  constructor() {
    const g = new THREE.BufferGeometry();
    // A triangle twice the size of the viewport. Using one primitive instead of
    // two avoids the diagonal derivative seam that shows up in any pass using
    // dFdx/dFdy or in bilinear-heavy filters at the quad boundary.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.geometry = g;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(g, null);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Draw `material` over `target` (null = canvas). */
  render(renderer, material, target = null) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.camera);
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material = null;
  }
}

/**
 * Build a post-pass material. Every pass in this directory goes through here so
 * the depth/blend/tone-mapping state is identical and cannot drift: a post pass
 * that accidentally leaves depth testing on renders nothing on the first frame
 * and everything on the second, which is a miserable bug to find.
 */
export function postMaterial({ name, fragment, uniforms, defines = {}, blending = THREE.NoBlending, glslVersion = null }) {
  const m = new THREE.ShaderMaterial({
    name,
    uniforms,
    defines,
    vertexShader: QUAD_VERT,
    fragmentShader: fragment,
    depthTest: false,
    depthWrite: false,
    blending,
    // Our HDR targets are linear working space and we tone map by hand in the
    // composite, so three must never inject its own tone map or transfer curve.
    toneMapped: false,
  });
  if (glslVersion) m.glslVersion = glslVersion;
  return m;
}

/**
 * A uniform value holder that is SHARED by reference across many materials.
 *
 * three's `UniformsUtils.clone()` deep-copies uniform values when a built-in
 * material's uniform set is created, and explicitly nulls render-target textures
 * with a warning. Everything the renderer injects into other agents' materials
 * therefore has to be attached AFTER that clone (in `onBeforeCompile`) using the
 * same object identity, so that updating `.value` here updates every material at
 * once. This class exists to make that contract obvious at the call site.
 */
export class SharedUniform {
  constructor(value) { this.value = value; }
  set(v) { this.value = v; return this; }
}
