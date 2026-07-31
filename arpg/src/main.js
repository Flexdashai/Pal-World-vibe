import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { CombatSystem } from './combat/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { LootSystem } from './loot/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { PerfSystem } from './core/perf.js';
import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing need the loop to free-run.
const lockstep = capture && params.get('lockstep') === '1';

const config = createConfig({
  quality: params.get('q') ?? (capture ? 'ultra' : 'high'),
  deterministic: capture,
  seed: params.get('seed') ? Number(params.get('seed')) >>> 0 : undefined,
});

const canvas = document.getElementById('game');
const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(CombatSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(LootSystem)
  .add(UiSystem)
  .add(AudioSystem)
  .add(PerfSystem);

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  window.__BOOT_ERROR__ = String(err?.stack ?? err?.message ?? err);
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

const warmup =
  params.get('prewarm') === '0'
    ? { ok: false, reason: 'disabled by ?prewarm=0' }
    : await prewarm(engine);
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

engine.start();

// Capture harness handshake: only flag ready once frames have actually landed.
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at the same engine
// frame, no matter how long boot took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) { window.__READY__ = true; return; }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
