#!/usr/bin/env node
/**
 * Per-pass cost attribution by ablation.
 *
 * There is no GPU in this container, so no fps number measured here is meaningful
 * as an fps number. What IS meaningful is the RATIO between passes: a fullscreen
 * pass that costs 30% of the frame here is fill-rate bound, and fill-rate bound
 * passes are fill-rate bound on a real GPU too. Ablation measures that ratio
 * without needing a timer query extension SwiftShader does not implement.
 *
 * Method: boot once, measure the frame time with everything on, then stub out one
 * pass at a time and re-measure. The delta is that pass's share. Passes are
 * restored between measurements so the ablations do not compound.
 *
 * The frame timing is real because __PUMP__ does a one-pixel readPixels after
 * every step, which cannot return until the queued work has actually executed
 * (see the note in src/dev/shots.js).
 *
 *   node arpg/tools/passcost.mjs --port=5299 --frames=4
 *   node arpg/tools/passcost.mjs --q=medium --w=960 --h=540
 */
import { parseArgs, ensureServer, launch, trackLogs, url, DEFAULT_PORT } from './browser.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? DEFAULT_PORT);
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const N = Number(args.frames ?? 4);
const TIMEOUT = Number(args.timeout ?? 600000);

/** Each entry stubs one thing. `path` is resolved off the render system. */
const ABLATIONS = [
  { key: 'prepass', doc: 'depth/normal/velocity MRT prepass' },
  { key: 'shadows', doc: 'shadow map render' },
  { key: 'ao', doc: 'ground-truth ambient occlusion' },
  { key: 'ssr', doc: 'screen-space reflections' },
  { key: 'taa', doc: 'temporal antialiasing' },
  { key: 'bloom', doc: 'bloom pyramid' },
  { key: 'dof', doc: 'depth of field' },
  { key: 'exposure', doc: 'auto-exposure metering' },
  { key: 'composite', doc: 'tonemap + grade + vignette + grain' },
];

const server = await ensureServer(PORT);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = trackLogs(page);

const out = { size: `${W}x${H}`, quality: args.q ?? 'high', frames: N, passes: [] };
try {
  await page.goto(url(PORT, { shot: 'hero', quality: args.q }), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', null, { timeout: TIMEOUT });
  if (await page.evaluate('window.__BOOT_ERROR__ ?? null')) throw new Error('boot failed');
  await page.evaluate(() => window.__APPLY_SHOT__('hero', { grabFrame: 8 }));

  // Install the ablation harness inside the page.
  await page.evaluate(() => {
    const r = window.__ENGINE__.ctx.peek('render');
    window.__ABL__ = {
      saved: {},
      off(key) {
        const obj = r[key];
        if (!obj || typeof obj.render !== 'function') return false;
        if (!this.saved[key]) this.saved[key] = obj.render;
        obj.render = function () {};
        return true;
      },
      on(key) {
        const obj = r[key];
        if (obj && this.saved[key]) { obj.render = this.saved[key]; delete this.saved[key]; }
      },
      // Shadows and the prepass are called through the renderer rather than a
      // pass object on some builds; fall back to a flag the render system reads.
      flag(key, v) { r[`_skip_${key}`] = v; },
    };
  });

  const time = async (n) => page.evaluate(async (k) => {
    // Two warm frames so a just-swapped function is compiled and any lazily
    // created target exists before the clock starts.
    await window.__PUMP__(2);
    const t0 = performance.now();
    await window.__PUMP__(k);
    return (performance.now() - t0) / k;
  }, n);

  const base = await time(N);
  out.baselineMs = +base.toFixed(1);

  for (const a of ABLATIONS) {
    const applied = await page.evaluate((k) => window.__ABL__.off(k), a.key);
    if (!applied) { out.passes.push({ ...a, note: 'no render() to stub — skipped' }); continue; }
    const t = await time(N);
    await page.evaluate((k) => window.__ABL__.on(k), a.key);
    const saved = base - t;
    out.passes.push({
      ...a,
      ms: +t.toFixed(1),
      savedMs: +saved.toFixed(1),
      sharePct: +((100 * saved) / base).toFixed(1),
    });
  }

  out.passes.sort((x, y) => (y.savedMs ?? -1) - (x.savedMs ?? -1));
  out.stats = await page.evaluate('window.__RENDER_INFO__');
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = e.message;
  out.tail = logs.slice(-20);
} finally {
  await browser.close();
  if (server) server.kill();
}

console.log(JSON.stringify(out, null, 2));
if (out.ok) {
  console.error('\n-- cost share, most expensive first --');
  for (const p of out.passes) {
    console.error(
      `${String(p.key).padEnd(10)} ${p.note ?? `${String(p.sharePct).padStart(5)}%  (${p.savedMs} ms)  ${p.doc}`}`
    );
  }
  console.error(`baseline   ${out.baselineMs} ms/frame at ${out.size}`);
}
process.exit(out.ok ? 0 : 1);
