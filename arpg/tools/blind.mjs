#!/usr/bin/env node
/**
 * Blind A/B sheets.
 *
 * A critic told "this is round 4, round 3 scored 5.2" will score round 4 higher.
 * That is not a hypothesis, it is the failure mode the sibling project hit — its
 * scores went 3.59 -> 4.14 -> 4.05 -> 5.05 while the defect count went UP in the
 * middle rounds, which only surfaced because the frames were re-examined.
 *
 * This tool pairs the same shot from two directories into one image, side by side,
 * labelled only LEFT and RIGHT, with the assignment chosen by a seed the critic
 * never sees. The key is written to a file the critic is not given. The critic
 * says which side is better and why; the caller decodes afterwards.
 *
 *   node arpg/tools/blind.mjs --a=arpg/shots/r3 --b=arpg/shots/r4 \
 *                             --out=arpg/shots/blind34 --seed=7
 *
 * Writes <shot>.ab.png per shot plus KEY.json (the decode) and MANIFEST.json
 * (safe to show a critic — it lists the files and nothing else).
 *
 * The same mechanism works against any reference frames placed in a directory,
 * if this container ever gets outbound network access to obtain them.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const A = resolve(args.a ?? (() => { throw new Error('--a required'); })());
const B = resolve(args.b ?? (() => { throw new Error('--b required'); })());
const OUT = resolve(args.out ?? 'arpg/shots/blind');
const GAP = 14;

// Deterministic assignment: same seed reproduces the same sheet, so a disputed
// result can be re-derived instead of re-rolled.
let s = (Number(args.seed ?? 1) >>> 0) || 1;
const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };

mkdirSync(OUT, { recursive: true });
const shots = readdirSync(A)
  .filter((f) => f.endsWith('.png') && !/\.(diff|z2|ab)\.png$/.test(f) && !f.startsWith('_'))
  .filter((f) => existsSync(join(B, f)))
  .sort();
if (!shots.length) { console.error(`no shots common to ${A} and ${B}`); process.exit(1); }

const GLYPH = { // 5x7 for the two words we need
  l: '10000 10000 10000 10000 11111', e: '11111 10000 11110 10000 11111',
  f: '11111 10000 11110 10000 10000', t: '11111 00100 00100 00100 00100',
  r: '11110 10001 11110 10010 10001', i: '11111 00100 00100 00100 11111',
  g: '01111 10000 10011 10001 01111', h: '10001 10001 11111 10001 10001',
  ' ': '00000 00000 00000 00000 00000',
};
function text(png, str, ox, oy, scale, rgb) {
  let cx = ox;
  for (const ch of str.toLowerCase()) {
    const rows = (GLYPH[ch] ?? GLYPH[' ']).split(' ');
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      if (rows[r][c] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const x = cx + c * scale + sx, y = oy + r * scale + sy;
        if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
        const i = (y * png.width + x) * 4;
        png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
      }
    }
    cx += 6 * scale;
  }
}

const key = {};
const manifest = { out: OUT, pairs: [] };

for (const f of shots) {
  const name = f.replace(/\.png$/, '');
  const pa = PNG.sync.read(readFileSync(join(A, f)));
  const pb = PNG.sync.read(readFileSync(join(B, f)));
  if (pa.width !== pb.width || pa.height !== pb.height) {
    console.error(`size mismatch on ${name}, skipping`); continue;
  }
  const flip = rand() < 0.5;
  const left = flip ? pb : pa, right = flip ? pa : pb;
  key[name] = { left: flip ? 'b' : 'a', right: flip ? 'a' : 'b', a: A, b: B };

  const LBL = 26;
  const sheet = new PNG({ width: pa.width * 2 + GAP, height: pa.height + LBL });
  sheet.data.fill(10);
  for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;
  for (let y = 0; y < pa.height; y++) {
    const row = y * pa.width * 4;
    sheet.data.set(left.data.subarray(row, row + pa.width * 4), ((y + LBL) * sheet.width) * 4);
    sheet.data.set(right.data.subarray(row, row + pa.width * 4), ((y + LBL) * sheet.width + pa.width + GAP) * 4);
  }
  text(sheet, 'left', 8, 6, 3, [225, 225, 225]);
  text(sheet, 'right', pa.width + GAP + 8, 6, 3, [225, 225, 225]);
  writeFileSync(join(OUT, `${name}.ab.png`), PNG.sync.write(sheet));
  manifest.pairs.push({ shot: name, file: `${name}.ab.png`, size: `${sheet.width}x${sheet.height}` });
}

writeFileSync(join(OUT, 'KEY.json'), JSON.stringify(key, null, 2));
writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({
  ok: true, out: OUT, pairs: manifest.pairs.length,
  note: 'KEY.json holds the decode — do not show it to the critic.',
}, null, 2));
