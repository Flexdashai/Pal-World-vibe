#!/usr/bin/env node
/**
 * Objective frame statistics + automatic defect detection.
 *
 * A critic agent looking at a PNG will happily say "the lighting feels flat"
 * without being able to say how flat. This turns the recurring complaints into
 * numbers, so a fix can be verified instead of re-argued:
 *
 *   contrast   RMS contrast and the 1st/99th luminance percentiles. Diablo IV
 *              interiors sit around p1<6, p99>170 with RMS 40-60. A frame with
 *              p1=30 has lifted blacks; one with RMS<25 is flat.
 *   local      Mean |Laplacian| over 3x3 — surface detail. A frame full of
 *              untextured planes scores <2.5 no matter how good the silhouettes.
 *   sat        Mean HSV saturation, plus the fraction of pixels above 0.45. The
 *              art direction wants a near-monochrome world with violet accents:
 *              satMean < 0.20 and satHot between 1% and 12% is the target band.
 *              satHot near 0 means the shadow magic is not reading.
 *   dyn        Fraction of pixels crushed to <8/255 and blown above 250/255.
 *              >35% crushed is an unreadable frame, not an atmospheric one.
 *   tiling     Autocorrelation peak of the luminance signal at 16..256 px lags.
 *              A strong non-trivial peak means a texture is visibly repeating.
 *   hue        Mean hue split into warm (fire/brazier) / cold (moon) / violet
 *              (shadow) buckets by pixel share, so "is the signature colour
 *              actually on screen" is answerable.
 *
 *   node arpg/tools/analyze.mjs arpg/shots/r1
 *   node arpg/tools/analyze.mjs arpg/shots/r1 --json
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
const dir = resolve(argv.find((a) => !a.startsWith('--')) ?? 'arpg/shots/set');
const asJson = argv.includes('--json');

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function analyse(file) {
  const png = PNG.sync.read(readFileSync(file));
  const { width: W, height: H, data } = png;
  const N = W * H;
  const L = new Float32Array(N);
  const hist = new Uint32Array(256);
  let satSum = 0, satW = 0, satHot = 0, warm = 0, cold = 0, violet = 0, lit = 0;
  let sr = 0, sg = 0, sb = 0;

  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sr += r; sg += g; sb += b;
    const l = lum(r, g, b);
    L[p] = l;
    hist[Math.min(255, Math.round(l))]++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    // HSV saturation explodes at low luminance — a near-black pixel of (2,2,5)
    // scores 0.6 and would report a coal-black crypt as "oversaturated". Weight
    // by luminance so the number answers the question actually being asked:
    // how colourful is the part of the frame a viewer can see?
    const s = mx > 0 ? (mx - mn) / mx : 0;
    const w = Math.min(1, l / 48);
    satSum += s * w;
    satW += w;
    if (s > 0.45 && l > 12) {
      satHot++;
      // Bucket by which channel leads, with violet requiring blue-leading AND a
      // real red component — that is what separates shadow magic from moonlight.
      if (r >= g && r >= b) warm++;
      else if (b > r && b > g && r > g * 1.05) violet++;
      else cold++;
    }
    if (l > 10) lit++;
  }

  let mean = 0;
  for (let p = 0; p < N; p++) mean += L[p];
  mean /= N;
  let vsum = 0;
  for (let p = 0; p < N; p++) { const d = L[p] - mean; vsum += d * d; }
  const rms = Math.sqrt(vsum / N);

  const pct = (q) => { let c = 0; const t = N * q; for (let i = 0; i < 256; i++) { c += hist[i]; if (c >= t) return i; } return 255; };
  let crushed = 0, blown = 0;
  for (let i = 0; i < 8; i++) crushed += hist[i];
  for (let i = 250; i < 256; i++) blown += hist[i];

  // Local detail: mean |4*c - N4| on a 2-px stride, skipping the HUD band so a
  // dark bottom bar cannot fake a low score.
  let lap = 0, lapN = 0;
  const yEnd = Math.floor(H * 0.86);
  for (let y = 2; y < yEnd; y += 2) {
    for (let x = 2; x < W - 2; x += 2) {
      const c = L[y * W + x];
      const v = Math.abs(4 * c - L[(y - 1) * W + x] - L[(y + 1) * W + x] - L[y * W + x - 1] - L[y * W + x + 1]);
      lap += v; lapN++;
    }
  }

  // Tiling: autocorrelation of a mid-frame horizontal luminance scanline bundle.
  const row0 = Math.floor(H * 0.55), rows = 12;
  const sig = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let k = 0; k < rows; k++) s += L[(row0 + k * 3) * W + x];
    sig[x] = s / rows;
  }
  // High-pass first. A smooth lighting gradient autocorrelates near 1.0 at EVERY
  // lag, so raw autocorrelation reports "tiling" on an empty floor. Subtracting a
  // 33-px moving average leaves only structure at the scale a repeating texture
  // actually lives at.
  const lp = new Float32Array(W);
  const R = 16;
  let acc = 0;
  for (let x = 0; x < Math.min(W, R + 1); x++) acc += sig[x];
  for (let x = 0; x < W; x++) {
    const add = x + R, rem = x - R - 1;
    if (x > 0) { if (add < W) acc += sig[add]; if (rem >= 0) acc -= sig[rem]; }
    const n = Math.min(W - 1, x + R) - Math.max(0, x - R) + 1;
    lp[x] = acc / n;
  }
  for (let x = 0; x < W; x++) sig[x] -= lp[x];
  let e0 = 0; for (let x = 0; x < W; x++) e0 += sig[x] * sig[x];
  let tilePeak = 0, tileLag = 0;
  for (let lag = 16; lag < Math.min(257, W >> 1); lag++) {
    let s = 0;
    for (let x = 0; x + lag < W; x++) s += sig[x] * sig[x + lag];
    const c = e0 > 1e-6 ? s / e0 : 0;
    if (c > tilePeak) { tilePeak = c; tileLag = lag; }
  }

  return {
    size: `${W}x${H}`,
    meanRgb: [sr / N, sg / N, sb / N].map((v) => +v.toFixed(1)),
    lum: { mean: +mean.toFixed(1), p1: pct(0.01), p50: pct(0.5), p99: pct(0.99), rms: +rms.toFixed(1) },
    local: +(lap / lapN).toFixed(2),
    sat: { mean: +(satSum / Math.max(1, satW)).toFixed(3), hotPct: +((100 * satHot) / N).toFixed(2) },
    hue: satHot > 0
      ? { warmPct: +((100 * warm) / N).toFixed(2), coldPct: +((100 * cold) / N).toFixed(2), violetPct: +((100 * violet) / N).toFixed(2) }
      : { warmPct: 0, coldPct: 0, violetPct: 0 },
    dyn: { crushedPct: +((100 * crushed) / N).toFixed(2), blownPct: +((100 * blown) / N).toFixed(3), litPct: +((100 * lit) / N).toFixed(1) },
    tiling: { peak: +tilePeak.toFixed(3), lag: tileLag },
  };
}

/** Thresholds are calibrated against what the two references actually look like,
 *  not against taste. Each flag names the fix, because a bare number is not
 *  actionable to the agent that has to act on it. */
function flags(a, name) {
  const out = [];
  if (a.lum.rms < 26) out.push(`FLAT_CONTRAST rms=${a.lum.rms} — no key/fill separation; the brazier is not acting as a key light`);
  if (a.lum.p1 > 14) out.push(`LIFTED_BLACKS p1=${a.lum.p1} — ambient term too high, shadows are washing out`);
  if (a.local < 2.6) out.push(`LOW_DETAIL local=${a.local} — surfaces read as untextured planes at this camera distance`);
  if (a.dyn.crushedPct > 38) out.push(`CRUSHED dark=${a.dyn.crushedPct}% — dark is not the same as unreadable; lift with bounce, not exposure`);
  if (a.dyn.litPct < 42) out.push(`UNDER_LIT lit=${a.dyn.litPct}% — most of the frame carries no information`);
  if (a.dyn.blownPct > 1.6) out.push(`BLOWN hot=${a.dyn.blownPct}% — highlights are clipping instead of rolling off`);
  if (a.sat.mean > 0.30) out.push(`OVERSATURATED sat=${a.sat.mean} — the world must stay near-monochrome so violet reads`);
  if (a.tiling.peak > 0.55) out.push(`TILING peak=${a.tiling.peak} at ${a.tiling.lag}px — a texture is visibly repeating`);
  if (/nova|arise|ultimate|shrine/.test(name) && a.hue.violetPct < 0.6) {
    out.push(`NO_SIGNATURE violet=${a.hue.violetPct}% — this shot exists to show shadow magic and it is not on screen`);
  }
  if (/hero|corridor|detail|depth/.test(name) && a.sat.hotPct > 14) {
    out.push(`NOISY_COLOUR hot=${a.sat.hotPct}% — an environment shot should not be this colourful`);
  }
  return out;
}

const files = existsSync(dir) && statSync(dir).isDirectory()
  ? readdirSync(dir).filter((f) => f.endsWith('.png') && !f.includes('.diff.')).sort()
  : [dir.split('/').pop()];
const base = existsSync(dir) && statSync(dir).isDirectory() ? dir : resolve(dir, '..');

const results = {};
for (const f of files) {
  const p = join(base, f);
  if (!existsSync(p)) continue;
  const name = f.replace(/\.png$/, '');
  const a = analyse(p);
  a.flags = flags(a, name);
  results[name] = a;
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const [name, a] of Object.entries(results)) {
    console.log(
      `${name.padEnd(11)} L${String(a.lum.mean).padStart(5)} rms${String(a.lum.rms).padStart(5)} ` +
      `p1=${String(a.lum.p1).padStart(3)} p99=${String(a.lum.p99).padStart(3)} det=${String(a.local).padStart(5)} ` +
      `sat=${a.sat.mean.toFixed(3)} hot=${String(a.sat.hotPct).padStart(5)}% ` +
      `V/W/C=${a.hue.violetPct}/${a.hue.warmPct}/${a.hue.coldPct} ` +
      `dark=${String(a.dyn.crushedPct).padStart(5)}% lit=${String(a.dyn.litPct).padStart(4)}% tile=${a.tiling.peak}`
    );
    for (const f of a.flags) console.log(`            ! ${f}`);
  }
}
