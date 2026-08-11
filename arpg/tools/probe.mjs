#!/usr/bin/env node
/**
 * Runtime introspection without a screenshot — the cheap inner loop.
 *
 * Boots the game, waits for ready, and prints boot health plus whatever the
 * caller asks for. Costs one boot (~15 s) instead of a boot + 28 rendered frames
 * (~45 s), so use it while iterating on logic and only screenshot when the change
 * is visual.
 *
 *   node arpg/tools/probe.mjs
 *   node arpg/tools/probe.mjs --eval="ctx.peek('world').stats()"
 *   node arpg/tools/probe.mjs --shot=combat --pump=20 --eval="ctx.peek('ai').stats()"
 *
 * Inside --eval you get `engine`, `ctx` and `THREE`-free plain JS. The value is
 * JSON-serialised, so return plain objects.
 */
import { parseArgs, ensureServer, launch, trackLogs, errorsOnly, url, DEFAULT_PORT } from './browser.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? DEFAULT_PORT);
const TIMEOUT = Number(args.timeout ?? 600000);
const PUMP = Number(args.pump ?? 0);

const server = await ensureServer(PORT);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: Number(args.w ?? 960), height: Number(args.h ?? 540) } });
const logs = trackLogs(page);

const out = { ok: false };
try {
  await page.goto(url(PORT, { shot: args.shot, quality: args.q, seed: args.seed, extra: args.query }),
    { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', null, { timeout: TIMEOUT });

  out.bootError = await page.evaluate('window.__BOOT_ERROR__ ?? null');
  if (out.bootError) throw new Error('boot failed');

  out.prewarm = await page.evaluate('window.__PREWARM__ ?? null');
  out.systems = await page.evaluate('[...window.__ENGINE__.registry.ordered].map(s=>s.constructor.id)');

  if (args.shot) {
    out.applied = await page.evaluate(
      ({ s, n }) => window.__APPLY_SHOT__(s, { grabFrame: n }), { s: args.shot, n: PUMP || 1 });
  }
  if (PUMP) await page.evaluate((n) => window.__PUMP__(n), PUMP);

  out.render = await page.evaluate('window.__RENDER_INFO__ ?? null');

  if (args.eval) {
    out.eval = await page.evaluate((src) => {
      const engine = window.__ENGINE__, ctx = engine.ctx;
      // eslint-disable-next-line no-new-func
      const v = new Function('engine', 'ctx', `return (${src});`)(engine, ctx);
      return JSON.parse(JSON.stringify(v ?? null, (k, x) =>
        typeof x === 'number' ? +x.toFixed(4) : x));
    }, String(args.eval));
  }

  const errs = errorsOnly(logs);
  out.errors = errs.slice(0, 20);
  out.warnings = logs.filter((l) => l.startsWith('[warning]')).slice(0, 10);
  out.ok = errs.length === 0;
} catch (e) {
  out.error = e.message;
  out.tail = logs.slice(-30);
} finally {
  await browser.close();
  if (server) server.kill();
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
