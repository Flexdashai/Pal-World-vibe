#!/usr/bin/env node
/**
 * Capture the whole review set — what the critic agents actually look at.
 *
 * Each shot gets a FRESH PAGE. The sibling project learned this the hard way:
 * reusing one page across shots leaks particle age, decal buffers, auto-exposure
 * state and animation phase forward, so two identical runs differed on 10 of 11
 * shots and no pixel gate was possible. Isolation costs a boot per shot (~15-25 s
 * under SwiftShader) and buys reproducibility, which is worth far more.
 *
 *   node arpg/tools/shotset.mjs --out=arpg/shots/r1
 *   node arpg/tools/shotset.mjs --out=arpg/shots/r1 --shots=hero,combat,arise
 *   node arpg/tools/shotset.mjs --out=arpg/shots/r1 --jobs=2
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, ensureServer, launch, trackLogs, errorsOnly, url, DEFAULT_PORT } from './browser.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? DEFAULT_PORT);
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const SETTLE = Number(args.settle ?? 28);
const SHUTTER = Number(args.shutter ?? 180000);
const OUTDIR = resolve(args.out ?? 'arpg/shots/set');
const TIMEOUT = Number(args.timeout ?? 240000);
// 4 cores and a CPU rasteriser: 2 pages in flight is the throughput sweet spot,
// more just thrashes.
const JOBS = Math.max(1, Number(args.jobs ?? 2));

const server = await ensureServer(PORT);
const browser = await launch();
mkdirSync(OUTDIR, { recursive: true });

// Discover the shot list from a throwaway page so the tool never goes stale.
const probe = await browser.newPage({ viewport: { width: 320, height: 200 } });
await probe.goto(url(PORT, {}), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
await probe.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', null, { timeout: TIMEOUT });
const bootErr = await probe.evaluate('window.__BOOT_ERROR__ ?? null');
if (bootErr) {
  console.error(JSON.stringify({ ok: false, error: 'boot failed', detail: bootErr.split('\n').slice(0, 12) }, null, 2));
  await browser.close(); if (server) server.kill();
  process.exit(1);
}
const all = await probe.evaluate('Object.keys(window.__SHOTS__ ?? {})');
await probe.close();

const wanted = args.shots ? String(args.shots).split(',').map((s) => s.trim()).filter(Boolean) : all;
const report = { ok: true, outDir: OUTDIR, size: `${W}x${H}`, settle: SETTLE, isolated: true, shots: [], errors: [] };

const t0 = Date.now();
async function shoot(name) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const logs = trackLogs(page);
  const st = Date.now();
  try {
    await page.goto(url(PORT, { shot: name, quality: args.q, seed: args.seed, extra: args.query }),
      { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', null, { timeout: TIMEOUT });
    const be = await page.evaluate('window.__BOOT_ERROR__ ?? null');
    if (be) throw new Error('boot failed');

    const applied = await page.evaluate(
      ({ s, settle }) => window.__APPLY_SHOT__(s, { grabFrame: settle }), { s: name, settle: SETTLE });

    // Drop temporal history so accumulation starts from a known phase.
    await page.evaluate(() => window.__ENGINE__?.ctx?.peek?.('render')?.resetTemporal?.());
    // Advance exactly SETTLE engine frames. In lockstep the page runs no loop of
    // its own, so nothing advances during the round trips or the screenshot —
    // `time.frame` at the shutter is a constant on every run and every machine.
    await page.evaluate((n) => window.__PUMP__(n), SETTLE);
    await page.evaluate(() => window.__PRESENT__(2));

    await page.screenshot({ path: `${OUTDIR}/${name}.png`, type: 'png', timeout: SHUTTER });
    const info = await page.evaluate('window.__RENDER_INFO__ ?? null');
    const errs = errorsOnly(logs);
    if (errs.length) report.ok = false;
    report.shots.push({ shot: name, ok: errs.length === 0 && !applied?.error, secs: +((Date.now() - st) / 1000).toFixed(1), applied, info, errors: errs.slice(0, 6) });
  } catch (e) {
    report.ok = false;
    report.shots.push({ shot: name, ok: false, secs: +((Date.now() - st) / 1000).toFixed(1), error: e.message, tail: logs.slice(-12) });
  } finally {
    await page.close();
  }
}

const queue = [...wanted];
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
  while (queue.length) await shoot(queue.shift());
}));

report.shots.sort((a, b) => wanted.indexOf(a.shot) - wanted.indexOf(b.shot));
report.errors = report.shots.flatMap((s) => s.errors ?? []);
report.totalSecs = +((Date.now() - t0) / 1000).toFixed(1);
await browser.close();
if (server) server.kill();

writeFileSync(`${OUTDIR}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
