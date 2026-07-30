#!/usr/bin/env node
/**
 * Review aids built from an existing shot directory. No browser needed.
 *
 *   node arpg/tools/contact.mjs --in=arpg/shots/r1 --out=arpg/shots/r1
 *
 * Produces:
 *   _sheet.png    every shot on one grid, 3 across, so a critic can judge the
 *                 SET (consistency of grade, of contrast, of colour) rather than
 *                 one frame at a time. Set-level drift is the defect a per-shot
 *                 review structurally cannot see.
 *   <shot>.z2.png a 2x nearest-neighbour blow-up of the centre 40%. Material
 *                 detail arguments are unresolvable at 1280x720 — half the
 *                 "looks untextured" complaints are actually "I cannot see it".
 *
 * Nearest-neighbour on purpose: a smooth resample invents detail that is not in
 * the frame, which is exactly the thing under review.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const IN = resolve(args.in ?? 'arpg/shots/set');
const OUT = resolve(args.out ?? IN);
const COLS = Number(args.cols ?? 3);
const CELL_W = Number(args.cell ?? 620);

if (!existsSync(IN)) { console.error(`no such directory: ${IN}`); process.exit(1); }
const names = readdirSync(IN)
  .filter((f) => f.endsWith('.png') && !/\.(diff|z2)\.png$/.test(f) && !f.startsWith('_'))
  .sort();
if (!names.length) { console.error(`no shots in ${IN}`); process.exit(1); }

const imgs = names.map((f) => ({ name: f.replace(/\.png$/, ''), png: PNG.sync.read(readFileSync(join(IN, f))) }));

// ---- 5x7 bitmap font, enough for [a-z0-9_-] shot labels -------------------
const GLYPHS = {
  a: '01110 10001 10001 11111 10001', b: '11110 10001 11110 10001 11110',
  c: '01111 10000 10000 10000 01111', d: '11110 10001 10001 10001 11110',
  e: '11111 10000 11110 10000 11111', f: '11111 10000 11110 10000 10000',
  g: '01111 10000 10011 10001 01111', h: '10001 10001 11111 10001 10001',
  i: '11111 00100 00100 00100 11111', j: '00011 00001 00001 10001 01110',
  k: '10001 10010 11100 10010 10001', l: '10000 10000 10000 10000 11111',
  m: '10001 11011 10101 10001 10001', n: '10001 11001 10101 10011 10001',
  o: '01110 10001 10001 10001 01110', p: '11110 10001 11110 10000 10000',
  q: '01110 10001 10101 10010 01101', r: '11110 10001 11110 10010 10001',
  s: '01111 10000 01110 00001 11110', t: '11111 00100 00100 00100 00100',
  u: '10001 10001 10001 10001 01110', v: '10001 10001 10001 01010 00100',
  w: '10001 10001 10101 11011 10001', x: '10001 01010 00100 01010 10001',
  y: '10001 01010 00100 00100 00100', z: '11111 00010 00100 01000 11111',
  0: '01110 10011 10101 11001 01110', 1: '00100 01100 00100 00100 01110',
  2: '01110 10001 00110 01000 11111', 3: '11110 00001 01110 00001 11110',
  4: '10010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 11110',
  6: '01110 10000 11110 10001 01110', 7: '11111 00001 00010 00100 01000',
  8: '01110 10001 01110 10001 01110', 9: '01110 10001 01111 00001 01110',
  '-': '00000 00000 11111 00000 00000', _: '00000 00000 00000 00000 11111',
  ' ': '00000 00000 00000 00000 00000',
};

function drawText(png, text, ox, oy, scale = 2, rgb = [255, 240, 200]) {
  let cx = ox;
  for (const ch of String(text).toLowerCase()) {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    const rows = g.split(' ');
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (rows[r][c] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const x = cx + c * scale + sx, y = oy + r * scale + sy;
          if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
          const i = (y * png.width + x) * 4;
          png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
        }
      }
    }
    cx += 6 * scale;
  }
}

/** Box-filter downscale — for the sheet only, where the point is composition. */
function fit(src, w, h) {
  const dst = new PNG({ width: w, height: h });
  const fx = src.width / w, fy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.min(src.height, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.min(src.width, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * src.width + sx) * 4;
        r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++;
      }
      const o = (y * w + x) * 4;
      dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = b / n; dst.data[o + 3] = 255;
    }
  }
  return dst;
}

const aspect = imgs[0].png.height / imgs[0].png.width;
const cw = CELL_W, ch = Math.round(CELL_W * aspect);
const pad = 8, label = 22;
const rows = Math.ceil(imgs.length / COLS);
const sheet = new PNG({ width: COLS * (cw + pad) + pad, height: rows * (ch + label + pad) + pad });
sheet.data.fill(12);
for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;

imgs.forEach((im, idx) => {
  const col = idx % COLS, row = (idx / COLS) | 0;
  const ox = pad + col * (cw + pad), oy = pad + row * (ch + label + pad) + label;
  const small = fit(im.png, cw, ch);
  for (let y = 0; y < ch; y++) {
    const so = y * cw * 4, doff = ((oy + y) * sheet.width + ox) * 4;
    sheet.data.set(small.data.subarray(so, so + cw * 4), doff);
  }
  drawText(sheet, im.name, ox + 2, oy - label + 5, 2, [230, 214, 170]);
});
writeFileSync(join(OUT, '_sheet.png'), PNG.sync.write(sheet));

// ---- per-shot 2x centre crops --------------------------------------------
let crops = 0;
for (const im of imgs) {
  const { width: W, height: H } = im.png;
  const cwid = Math.round(W * 0.40), chei = Math.round(H * 0.40);
  const x0 = ((W - cwid) >> 1), y0 = Math.round(H * 0.28);
  const z = new PNG({ width: cwid * 2, height: chei * 2 });
  for (let y = 0; y < chei * 2; y++) {
    for (let x = 0; x < cwid * 2; x++) {
      const sx = Math.min(W - 1, x0 + (x >> 1)), sy = Math.min(H - 1, y0 + (y >> 1));
      const a = (sy * W + sx) * 4, b = (y * z.width + x) * 4;
      z.data[b] = im.png.data[a]; z.data[b + 1] = im.png.data[a + 1];
      z.data[b + 2] = im.png.data[a + 2]; z.data[b + 3] = 255;
    }
  }
  writeFileSync(join(OUT, `${im.name}.z2.png`), PNG.sync.write(z));
  crops++;
}

console.log(JSON.stringify({
  ok: true, sheet: join(OUT, '_sheet.png'),
  sheetSize: `${sheet.width}x${sheet.height}`, shots: imgs.length, crops,
}, null, 2));
