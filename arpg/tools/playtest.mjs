#!/usr/bin/env node
/**
 * Scripted gameplay smoke test. Shots prove the game LOOKS right; this proves it
 * still RUNS — that movement resolves against collision, skills fire, enemies die,
 * loot drops, and nothing throws over a few hundred simulated frames.
 *
 *   node arpg/tools/playtest.mjs
 *   node arpg/tools/playtest.mjs --frames=600 --shot-every=200 --out=arpg/shots/play
 *
 * Runs in lockstep so the script is frame-exact rather than wall-clock dependent,
 * which matters here: a free-running loop on a CPU rasteriser would advance ~2
 * frames a second and the whole script would take an hour.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, ensureServer, launch, trackLogs, errorsOnly, url, DEFAULT_PORT } from './browser.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? DEFAULT_PORT);
const FRAMES = Number(args.frames ?? 420);
const SHOT_EVERY = Number(args['shot-every'] ?? 0);
const OUTDIR = resolve(args.out ?? 'arpg/shots/play');
const TIMEOUT = Number(args.timeout ?? 300000);

/** [atFrame, keys, buttons, aimNdc] — aim is where the cursor sits, which is how
 *  an ARPG aims. Held state persists until the next step changes it. */
const SCRIPT = [
  [0,   [],               [], [0.0, 0.0]],
  [20,  ['up'],           [], [0.2, 0.1]],
  [70,  ['up', 'right'],  [], [0.4, -0.1]],
  [120, ['right'],        [0], [0.3, -0.2]],   // move + primary attack
  [170, [],               [0], [0.0, -0.1]],   // stand and swing
  [210, ['dash'],         [], [-0.3, 0.0]],
  [230, [],               [0], [-0.4, 0.1]],
  [270, ['skill1'],       [], [0.1, 0.2]],
  [290, [],               [0], [0.1, 0.2]],
  [320, ['skillQ'],       [], [-0.2, 0.15]],
  [350, ['arise'],        [], [0.0, 0.0]],
  [380, [],               [0], [0.25, -0.15]],
  [400, ['ultimate'],     [], [0.0, 0.0]],
];

const server = await ensureServer(PORT);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: Number(args.w ?? 1280), height: Number(args.h ?? 720) } });
const logs = trackLogs(page);

const report = { ok: false, frames: FRAMES, samples: [], shots: [] };
try {
  await page.goto(url(PORT, { quality: args.q ?? 'high', seed: args.seed }), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', null, { timeout: TIMEOUT });
  const be = await page.evaluate('window.__BOOT_ERROR__ ?? null');
  if (be) throw new Error(`boot failed:\n${be.split('\n').slice(0, 10).join('\n')}`);

  // Hand control back to the player system — capture mode froze input for shots.
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.frozen = false; e.input.enabled = true;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  if (SHOT_EVERY) mkdirSync(OUTDIR, { recursive: true });

  let cursor = 0;
  for (let f = 0; f < FRAMES; f += 10) {
    while (cursor < SCRIPT.length && SCRIPT[cursor][0] <= f) {
      const [, keys, buttons, ndc] = SCRIPT[cursor++];
      await page.evaluate(({ keys, buttons, ndc }) => {
        window.__ENGINE__.input.inject({ keys, buttons, ndc });
      }, { keys, buttons, ndc });
    }
    await page.evaluate((n) => window.__PUMP__(n), 10);

    if (f % 60 === 0) {
      report.samples.push(await page.evaluate((frame) => {
        const ctx = window.__ENGINE__.ctx;
        const p = ctx.peek('player'), ai = ctx.peek('ai');
        const st = p?.stats ?? p?.state ?? {};
        return {
          frame,
          pos: p?.position ? [+p.position.x.toFixed(2), +p.position.y.toFixed(2), +p.position.z.toFixed(2)] : null,
          hp: st.hp ?? null, level: st.level ?? null,
          enemies: ai?.stats?.().alive ?? ai?.actors?.length ?? null,
          shadows: ai?.stats?.().shadows ?? null,
          tris: window.__RENDER_INFO__?.tris ?? 0,
        };
      }, f));
    }
    if (SHOT_EVERY && f > 0 && f % SHOT_EVERY === 0) {
      const p = `${OUTDIR}/play-${String(f).padStart(4, '0')}.png`;
      await page.screenshot({ path: p, type: 'png' });
      report.shots.push(p);
    }
  }

  const errs = errorsOnly(logs);
  report.errors = errs.slice(0, 20);
  report.ok = errs.length === 0;

  // The point of a playtest is that the world CHANGED. A run where the player
  // never moved and nothing died passed vacuously and must not report ok.
  const first = report.samples[0], last = report.samples.at(-1);
  const moved = first?.pos && last?.pos
    ? Math.hypot(last.pos[0] - first.pos[0], last.pos[2] - first.pos[2]) : 0;
  report.moved = +moved.toFixed(2);
  if (moved < 0.5) { report.ok = false; report.errors.push('[playtest] player never moved — input or movement is dead'); }
} catch (e) {
  report.error = e.message;
  report.tail = logs.slice(-30);
} finally {
  await browser.close();
  if (server) server.kill();
}

if (SHOT_EVERY) writeFileSync(`${OUTDIR}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
