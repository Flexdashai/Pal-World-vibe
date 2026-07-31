#!/usr/bin/env node
/**
 * Fold the production build into ONE self-contained .html file.
 *
 * This exists because the game cannot be played in the container that builds it —
 * there is no GPU here, and a frame costs about ten seconds under SwiftShader. The
 * only way to actually play it is to hand the whole thing to a machine that has a
 * GPU, and a single file with nothing external in it is the lowest-friction way to
 * do that: it opens from a file:// URL, and it survives being published to a host
 * with a strict CSP that blocks every external request.
 *
 * That works at all only because of a decision made at the start of the project:
 * there are no art assets. Every texture, mesh, animation and sound is generated
 * procedurally at load time, so the bundle references no images, no models, no
 * audio, and no fonts. Vite emits one chunk with zero dynamic imports, and it
 * inlines cleanly.
 *
 *   npm run arpg:build && node arpg/tools/bundle.mjs --out=arpg/monarch.html
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(args.dist ?? join(ROOT, 'dist'));
const OUT = resolve(args.out ?? join(ROOT, 'monarch.html'));
/** Emit page CONTENT only — no doctype/html/head/body — for hosts that wrap it. */
const FRAGMENT = !!args.fragment;

if (!existsSync(DIST)) {
  console.error(`no build at ${DIST} — run "npm run arpg:build" first`);
  process.exit(1);
}

const assets = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
if (assets.length !== 1) {
  // More than one chunk means code splitting appeared, and inlining would need to
  // resolve the import graph. Fail loudly rather than emit a page that 404s.
  console.error(`expected exactly one JS chunk, found ${assets.length}: ${assets.join(', ')}`);
  process.exit(1);
}
const js = readFileSync(join(DIST, 'assets', assets[0]), 'utf8');

// A literal </script> inside a string in the bundle would terminate the inline
// script tag early. Vite has no reason to emit one, but assert rather than trust.
if (/<\/script/i.test(js)) {
  console.error('bundle contains a literal </script> and cannot be inlined verbatim');
  process.exit(1);
}

// The overlay is deliberately diegetic: it is the game's own SYSTEM window, the
// translucent blue panel Solo Leveling uses for progression notifications, not a
// web page's start button. It also earns its keep technically — an AudioContext
// cannot start without a user gesture, so the game's entire synthesized audio
// layer depends on there being a click before play begins.
const SHELL = `
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #05050a; }
  body {
    font-family: "Inter", "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }
  #game { display: block; width: 100vw; height: 100vh; touch-action: none; cursor: none; }
  #ui { position: fixed; inset: 0; pointer-events: none; z-index: 10; }

  #boot {
    position: fixed; inset: 0; z-index: 100;
    display: grid; place-items: center;
    background: radial-gradient(ellipse at 50% 45%, #0d0a18 0%, #05050a 70%);
    cursor: pointer;
    transition: opacity .5s ease;
  }
  #boot.gone { opacity: 0; pointer-events: none; }
  .sys {
    position: relative;
    min-width: min(520px, 88vw);
    padding: 30px 34px 26px;
    background: rgba(14, 24, 44, .74);
    border: 1px solid rgba(140, 190, 255, .55);
    box-shadow: 0 0 0 1px rgba(10,14,26,.9), 0 0 34px rgba(90,140,255,.16), inset 0 0 42px rgba(70,110,220,.10);
    overflow: hidden;
  }
  /* The corner ticks and the sweep are what make the panel read as a system
     interrupt rather than a modal. Both are pure CSS so nothing is fetched. */
  .sys::before {
    content: ""; position: absolute; inset: 5px; pointer-events: none;
    border: 1px solid rgba(120, 170, 240, .18);
  }
  .sys::after {
    content: ""; position: absolute; left: 0; right: 0; height: 2px; top: -2px;
    background: linear-gradient(90deg, transparent, rgba(160,210,255,.75), transparent);
    animation: sweep 4.5s ease-in-out infinite;
  }
  @keyframes sweep { 0% { top: -2px } 55% { top: 100% } 100% { top: 100% } }
  @media (prefers-reduced-motion: reduce) { .sys::after { animation: none; opacity: .35 } }

  .eyebrow {
    font-size: 11px; letter-spacing: .34em; text-transform: uppercase;
    color: #6fd4ff; margin-bottom: 14px;
  }
  h1 {
    font-size: 30px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
    color: #e8e2d4; margin-bottom: 4px;
  }
  .sub { font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: #9b8ec9; margin-bottom: 22px; }
  .keys { display: grid; grid-template-columns: auto 1fr; gap: 7px 16px; font-size: 12.5px; color: #b9b3a6; }
  .keys b {
    color: #e8e2d4; font-weight: 600; font-family: ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: .04em;
  }
  .go {
    margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(120,170,240,.20);
    font-size: 12px; letter-spacing: .3em; text-transform: uppercase; color: #c9a8ff;
    animation: pulse 2.2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
  @media (prefers-reduced-motion: reduce) { .go { animation: none } }
  .warn { margin-top: 16px; font-size: 12px; color: #ff9d7a; line-height: 1.5; display: none; }
</style>

<canvas id="game"></canvas>
<div id="ui"></div>

<div id="boot">
  <div class="sys">
    <div class="eyebrow">System</div>
    <h1>Monarch</h1>
    <div class="sub">Shadow Ascension</div>
    <div class="keys">
      <b>WASD</b><span>Move</span>
      <b>Mouse</b><span>Aim — the cursor is where you strike</span>
      <b>LMB</b><span>Attack</span>
      <b>Space</b><span>Dash (invulnerable through the roll)</span>
      <b>1–4 / Q / E</b><span>Skills</span>
      <b>R</b><span>Monarch's Domain — the ultimate</span>
      <b>F</b><span>Arise — extract a shadow from a corpse</span>
      <b>Tab / C</b><span>Inventory and character</span>
      <b>Wheel</b><span>Zoom</span>
    </div>
    <div class="warn" id="warn"></div>
    <div class="go">Click to begin</div>
  </div>
</div>

<script>
  // Fail with an explanation rather than a black rectangle. The renderer needs
  // WebGL2 and float render targets; a machine without them cannot run this at all.
  (function () {
    var c = document.createElement('canvas');
    var gl = c.getContext('webgl2');
    var w = document.getElementById('warn');
    if (!gl) {
      w.style.display = 'block';
      w.textContent = 'This browser has no WebGL2. The renderer needs it and cannot start.';
    } else if (!gl.getExtension('EXT_color_buffer_float')) {
      w.style.display = 'block';
      w.textContent = 'WebGL2 is present but float render targets are missing. The HDR pipeline will not run.';
    }
  })();

  document.getElementById('boot').addEventListener('click', function () {
    this.classList.add('gone');
    // Everything you hear is synthesized at runtime — there are no audio files —
    // and none of it can start before a gesture. This click is that gesture.
    try { window.__ENGINE__ && window.__ENGINE__.ctx.peek('audio') &&
          window.__ENGINE__.ctx.peek('audio').resume &&
          window.__ENGINE__.ctx.peek('audio').resume(); } catch (e) {}
    document.getElementById('game').focus();
  }, { once: true });
</script>

<script type="module">
${js}
</script>
`;

const page = FRAGMENT
  ? `<title>MONARCH — Shadow Ascension</title>\n${SHELL}`
  : `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <link rel="icon" href="data:," />
    <title>MONARCH — Shadow Ascension</title>
  </head>
  <body>
${SHELL}
  </body>
</html>`;

writeFileSync(OUT, page);
console.log(JSON.stringify({
  ok: true, out: OUT, fragment: FRAGMENT,
  bundleKB: +(js.length / 1024).toFixed(0),
  pageKB: +(page.length / 1024).toFixed(0),
}, null, 2));
