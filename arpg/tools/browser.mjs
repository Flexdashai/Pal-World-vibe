/**
 * Shared browser + dev-server plumbing for every tool in this directory.
 *
 * TWO THINGS DIFFER FROM THE SIBLING PROJECT'S HARNESS and both are mandatory
 * here:
 *
 *  1. `executablePath`. The installed playwright expects a chromium build that is
 *     not on this image; the image ships one at /opt/pw-browsers/chromium. Without
 *     this, every launch fails with "Executable doesn't exist".
 *  2. There is NO GPU. Chromium runs ANGLE-over-SwiftShader, a CPU rasteriser, so
 *     a 720p frame costs ~0.4-1.5 s. Defaults here are 1280x720 and a small settle
 *     count for that reason. Never read an fps number out of this container.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

export const ROOT = resolve(import.meta.dirname, '..');
export const REPO = resolve(ROOT, '..');
export const CHROME = process.env.MN_CHROME ?? '/opt/pw-browsers/chromium';
export const DEFAULT_PORT = 5273;

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    })
  );
}

export const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

/** Start vite on `port` if nothing is listening. Returns the child, or null if a
 *  server was already up (in which case the caller must not kill it). */
export async function ensureServer(port = DEFAULT_PORT) {
  if (await portOpen(port)) return null;
  const p = spawn(resolve(REPO, 'node_modules/.bin/vite'), ['--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    // No hot reload: a file saved mid-run by a concurrently-working agent would
    // reload the page under playwright and fail with "Execution context destroyed".
    env: { ...process.env, MN_NO_HMR: '1' },
  });
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(port)) return p;
  }
  p.kill();
  throw new Error(`vite failed to start on ${port}`);
}

export function launch(extraArgs = []) {
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      // SwiftShader is what we get; say so explicitly rather than relying on the
      // fallback path, and allow it under the unsafe-swiftshader gate.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--force-color-profile=srgb',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-frame-rate-limit',
      '--js-flags=--max-old-space-size=4096',
      ...extraArgs,
    ],
  });
}

/** Attach console/error capture to a page and return the (growing) log array. */
export function trackLogs(page) {
  const logs = [];
  page.on('console', (m) => m.type() !== 'debug' && logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`));
  return logs;
}

export const errorsOnly = (logs) => logs.filter((l) => /^\[(pageerror|error)\]/.test(l));

export function url(port, { shot, lockstep = true, quality, seed, extra = '' } = {}) {
  const q = new URLSearchParams({ capture: '1' });
  if (lockstep) q.set('lockstep', '1');
  if (shot) q.set('shot', shot);
  if (quality) q.set('q', quality);
  if (seed !== undefined) q.set('seed', String(seed));
  return `http://127.0.0.1:${port}/?${q}${extra ? `&${extra}` : ''}`;
}
