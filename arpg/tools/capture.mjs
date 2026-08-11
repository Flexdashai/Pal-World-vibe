#!/usr/bin/env node
/**
 * Single-shot screenshot. The tool every agent runs to see its own work.
 *
 *   node arpg/tools/capture.mjs --shot=hero --out=arpg/shots/hero.png
 *   node arpg/tools/capture.mjs --shot=combat --w=1600 --h=900 --settle=40
 *   node arpg/tools/capture.mjs --list
 *
 * Exits non-zero and prints the last 40 console lines if the page threw, so
 * `capture || exit` is a usable build gate.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs, ensureServer, launch, trackLogs, errorsOnly, url, DEFAULT_PORT } from './browser.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? DEFAULT_PORT);
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const SHOT = args.shot ?? 'hero';
const OUT = resolve(args.out ?? `arpg/shots/${SHOT}.png`);
const TIMEOUT = Number(args.timeout ?? 600000);
// Frames rendered before the shutter: lets TAA converge and transients land.
// Software rendering makes every one of these cost ~0.5-1.5 s, hence the low
// default compared to a GPU harness.
const SETTLE = Number(args.settle ?? 28);
const SHUTTER = Number(args.shutter ?? 180000);

const server = await ensureServer(PORT);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = trackLogs(page);

let failed = null;
let out = null;
try {
  await page.goto(url(PORT, { shot: SHOT, quality: args.q, seed: args.seed, extra: args.query }), {
    waitUntil: 'domcontentloaded', timeout: TIMEOUT,
  });
  await page.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', null, { timeout: TIMEOUT });

  const bootErr = await page.evaluate('window.__BOOT_ERROR__ ?? null');
  if (bootErr) throw new Error(`boot failed:\n${bootErr}`);

  if (args.list) {
    const shots = await page.evaluate(
      'Object.fromEntries(Object.entries(window.__SHOTS__ ?? {}).map(([k,v])=>[k, v.doc]))'
    );
    console.log(JSON.stringify(shots, null, 2));
  } else {
    const applied = await page.evaluate(
      ({ s, settle }) => window.__APPLY_SHOT__(s, { grabFrame: settle }), { s: SHOT, settle: SETTLE }
    );
    if (applied?.error) throw new Error(applied.error);

    await page.evaluate(() => window.__ENGINE__?.ctx?.peek?.('render')?.resetTemporal?.());
    await page.evaluate((n) => window.__PUMP__(n), SETTLE);
    await page.evaluate(() => window.__PRESENT__(2));

    mkdirSync(dirname(OUT), { recursive: true });
    // Generous: on a software rasteriser the shutter may still be draining a
    // frame, and playwright's 30 s default fires long before that finishes.
    await page.screenshot({ path: OUT, type: 'png', timeout: SHUTTER });
    out = OUT;

    const info = await page.evaluate('window.__RENDER_INFO__ ?? null');
    const errs = errorsOnly(logs);
    console.log(JSON.stringify({ ok: errs.length === 0, out: OUT, shot: SHOT, size: `${W}x${H}`, applied, info, errors: errs.slice(0, 8) }, null, 2));
    if (errs.length) failed = new Error(`${errs.length} page error(s)`);
  }
} catch (e) {
  failed = e;
} finally {
  if (failed) {
    if (args.log) writeFileSync(resolve(String(args.log)), logs.join('\n'));
    console.error('---- last 40 console lines ----');
    console.error(logs.slice(-40).join('\n'));
  }
  await browser.close();
  if (server) server.kill();
}

if (failed) {
  console.error(JSON.stringify({ ok: false, shot: SHOT, out, error: failed.message }));
  process.exit(1);
}
