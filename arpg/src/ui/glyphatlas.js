/**
 * Procedural glyph atlas for world-space text (damage numbers, floating
 * labels). Built once at init from a canvas — no font files, no SDF tooling.
 *
 * THE PACKING is the interesting part. A single-channel coverage mask can only
 * produce flat tinted text, and flat text over a dark-fantasy scene is
 * illegible the moment it crosses a brazier. Instead each glyph is rendered
 * three times into three channels:
 *
 *   R  the fill      — the body of the glyph
 *   G  the outline   — a thick stroke, used as a near-black rim so the number
 *                      reads against ANY background without a drop shadow
 *   B  a blurred fill — an outer halo the shader adds as a soft glow, which is
 *                      what makes a crit look like it is emitting light rather
 *                      than being painted on
 *
 * The shader mixes rim -> body across R, adds B as coloured bloom, and takes
 * alpha from max(R,G) plus a fraction of B. One texture fetch, three effects.
 */

import * as THREE from 'three';

/** Deliberately small: digits, the punctuation a damage feed needs, and caps. */
export const CHARSET = '0123456789.,+-!%: ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const COLS = 12;
const CELL_W = 80;
const CELL_H = 76;
const FONT_PX = 52;
const STROKE_PX = 7.5;
/** Blur radius of the halo channel, in atlas pixels. */
const HALO_PX = 5;

export class GlyphAtlas {
  constructor() {
    const rows = Math.ceil(CHARSET.length / COLS);
    this.cols = COLS;
    this.rows = rows;
    this.width = COLS * CELL_W;
    this.height = rows * CELL_H;
    this.cellAspect = CELL_W / CELL_H;

    /** char -> { u, v, du, dv, adv } where `adv` is the advance in units of
     *  cell HEIGHT, so laying out text only needs the glyph pixel height. */
    this.map = new Map();

    const mk = () => {
      const cv = document.createElement('canvas');
      cv.width = this.width; cv.height = this.height;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.clearRect(0, 0, this.width, this.height);
      c.font = `700 ${FONT_PX}px "DejaVu Sans", "Liberation Sans", Arial, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineJoin = 'round';
      c.miterLimit = 2;
      return { cv, c };
    };

    const fill = mk();
    const outline = mk();
    const halo = mk();

    for (let i = 0; i < CHARSET.length; i++) {
      const ch = CHARSET[i];
      const col = i % COLS, row = (i / COLS) | 0;
      const cx = col * CELL_W + CELL_W * 0.5;
      const cy = row * CELL_H + CELL_H * 0.5;

      const w = fill.c.measureText(ch).width;
      // Advance includes a little tracking; damage numbers set tight but not
      // touching, and a monospaced advance for digits keeps a counter stable.
      const isDigit = ch >= '0' && ch <= '9';
      const advPx = (isDigit ? FONT_PX * 0.60 : w) + FONT_PX * 0.055;

      fill.c.fillStyle = '#fff';
      fill.c.fillText(ch, cx, cy);

      outline.c.strokeStyle = '#fff';
      outline.c.lineWidth = STROKE_PX;
      outline.c.strokeText(ch, cx, cy);

      halo.c.save();
      halo.c.filter = `blur(${HALO_PX}px)`;
      halo.c.fillStyle = '#fff';
      halo.c.fillText(ch, cx, cy);
      halo.c.restore();

      this.map.set(ch, {
        u: (col * CELL_W) / this.width,
        v: (row * CELL_H) / this.height,
        du: CELL_W / this.width,
        dv: CELL_H / this.height,
        adv: advPx / CELL_H,
      });
    }

    // --- pack the three masks into one RGBA image ---------------------------
    const out = fill.c.createImageData(this.width, this.height);
    const A = fill.c.getImageData(0, 0, this.width, this.height).data;
    const B = outline.c.getImageData(0, 0, this.width, this.height).data;
    const C = halo.c.getImageData(0, 0, this.width, this.height).data;
    const D = out.data;
    for (let p = 0; p < D.length; p += 4) {
      const a = A[p + 3], b = B[p + 3], c = C[p + 3];
      D[p] = a;
      D[p + 1] = b;
      D[p + 2] = c;
      D[p + 3] = 255;
    }
    const packed = document.createElement('canvas');
    packed.width = this.width; packed.height = this.height;
    packed.getContext('2d').putImageData(out, 0, 0);

    this.canvas = packed;
    this.texture = new THREE.CanvasTexture(packed);
    // flipY=false so atlas rects can be expressed in canvas pixel coordinates
    // with y down, which is how they were drawn.
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.NoColorSpace; // this is data, not colour
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
    this.texture.needsUpdate = true;

    this.missing = this.map.get(' ');
  }

  glyph(ch) {
    return this.map.get(ch) ?? this.missing;
  }

  /** Total advance of `text` in units of glyph pixel height. */
  measure(text) {
    let w = 0;
    for (let i = 0; i < text.length; i++) w += this.glyph(text[i]).adv;
    return w;
  }

  dispose() {
    this.texture.dispose();
  }
}
