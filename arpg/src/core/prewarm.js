/**
 * Shader pre-warm.
 *
 * Every material/light-count/shadow permutation compiles here, before the frame
 * loop starts, so nothing compiles lazily mid-fight. On the sibling FPS project
 * this removed 728-1236 ms stalls; on a software rasteriser a lazy compile is
 * worse still because the whole pipeline is CPU-bound.
 *
 * CONTRACT for `prewarmMaterials(ctx)` implementers: build and compile every
 * material you can produce, without spawning gameplay objects, drawing a gameplay
 * frame, or touching the clock/RNG. Two traps:
 *
 *  - A render target must be bound while compiling. `outputColorSpace` and
 *    `toneMapping` are part of the program cache key and are read off the
 *    *currently bound* target, so compiling against the canvas warms the wrong
 *    variant.
 *  - `renderer.compileAsync(scene, camera)` only reaches the forward lit variant.
 *    The shadow pass and the MRT prepass use `scene.overrideMaterial` and need
 *    their own compile, which `render.prewarmMaterials` handles centrally.
 */
export async function prewarm(engine) {
  const t0 = performance.now();
  const ctx = engine.ctx;
  const render = ctx.peek('render');
  if (!render?.renderer) return { ok: false, reason: 'no render system' };

  const report = { ok: true, systems: [], programs0: render.renderer.info.programs?.length ?? 0 };

  for (const sys of engine.registry.ordered) {
    if (typeof sys.prewarmMaterials !== 'function') continue;
    const t = performance.now();
    try {
      await sys.prewarmMaterials(ctx);
      report.systems.push({ id: sys.constructor.id, ms: +(performance.now() - t).toFixed(0) });
    } catch (err) {
      report.ok = false;
      report.systems.push({ id: sys.constructor.id, error: String(err?.message ?? err) });
      console.warn(`[prewarm] ${sys.constructor.id} threw`, err);
    }
  }

  report.programs = render.renderer.info.programs?.length ?? 0;
  report.ms = +(performance.now() - t0).toFixed(0);
  return report;
}
