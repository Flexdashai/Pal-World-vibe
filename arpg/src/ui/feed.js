/**
 * Killfeed / combat log and the toast strip.
 *
 * The log answers the two questions an ARPG player asks between packs — "what
 * did I just kill" and "what did that hit for" — without them having to watch
 * the damage numbers. It is right-aligned under the minimap, newest at the top,
 * and every row fades on its own timer so the column empties itself.
 *
 * A fixed pool of seven rows is rotated rather than creating and destroying
 * nodes: a fight generates several entries a second and DOM churn at that rate
 * is a layout thrash for the whole overlay.
 *
 * The glyphs are restricted to the Geometric Shapes block plus U+2605, which
 * DejaVu Sans definitely has. A missing-glyph box in a killfeed is the single
 * most amateur thing a HUD can display, and there is no webfont to fall back
 * on here.
 */

import { RARITY, UI, ELEMENTS } from '../core/palette.js';
import { el, setText, setOpacity, setStyle, setShown, groupNum, compactNum } from './dom.js';
import { damp, mixHex, alpha } from './theme.js';

const ROWS = 7;
const ROW_LIFE = 7.5;
const ROW_FADE = 1.6;

export const FEED_KIND = {
  kill:   { g: '◆', c: UI.textPrimary },
  crit:   { g: '★', c: UI.critYellow },
  loot:   { g: '◈', c: RARITY.rare.srgb },
  shadow: { g: '▲', c: '#c9a8ff' },
  level:  { g: '●', c: UI.xpGold },
  warn:   { g: '■', c: mixHex(UI.hpRed, '#ffb3a2', 0.45) },
  quest:  { g: '◇', c: UI.systemBlue },
};

export class KillFeed {
  constructor(parent) {
    this.root = el('div', 'mn-feed', parent);
    this.rows = [];
    for (let i = 0; i < ROWS; i++) {
      const r = el('div', 'row', this.root);
      const g = el('span', 'g', r);
      const t = el('b', '', r);
      const s = el('span', '', r);
      const d = el('span', 'd', r);
      this.rows.push({ node: r, g, t, s, d, age: 1e9 });
      setOpacity(r, 0);
    }
  }

  /**
   * `kind` selects the glyph and colour; `name` is bolded; `suffix` is the
   * plain-text tail; `value` renders as a coloured number at the end.
   */
  push(kind, name, suffix = '', value = 0, valueColour = null) {
    const k = FEED_KIND[kind] ?? FEED_KIND.kill;
    // Rotate: shift every row down one, reuse the last as the new first.
    const recycled = this.rows.pop();
    this.rows.unshift(recycled);
    this.root.insertBefore(recycled.node, this.root.firstChild);

    recycled.age = 0;
    setText(recycled.g, k.g);
    setStyle(recycled.g, 'color', k.c);
    setText(recycled.t, name ?? '');
    setText(recycled.s, suffix ? ` ${suffix}` : '');
    setText(recycled.d, value ? ` ${compactNum(value)}` : '');
    setStyle(recycled.d, 'color', valueColour ?? k.c);
    setShown(recycled.node, true);
    setOpacity(recycled.node, 1);
  }

  update(dt) {
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.age > 1e8) continue;
      r.age += dt;
      // Rows further down the stack are dimmer even before they expire; that
      // gradient is what makes the column read as "history" at a glance.
      const depth = 1 - i * 0.09;
      const fade = r.age > ROW_LIFE ? Math.max(0, 1 - (r.age - ROW_LIFE) / ROW_FADE) : 1;
      const o = depth * fade;
      setOpacity(r.node, o);
      if (fade <= 0) { r.age = 1e9; setShown(r.node, false); }
    }
  }

  clear() {
    for (const r of this.rows) { r.age = 1e9; setOpacity(r.node, 0); setShown(r.node, false); }
  }

  dispose() { this.root.remove(); }
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------

const TOASTS = 4;
const TOAST_LIFE = 2.4;

export class ToastStrip {
  constructor(parent) {
    this.root = el('div', 'mn-toasts', parent);
    this.pool = [];
    for (let i = 0; i < TOASTS; i++) {
      const n = el('div', 'mn-toast', this.root);
      setShown(n, false);
      this.pool.push({ node: n, age: 1e9 });
    }
  }

  push(text, tone = '') {
    let slot = this.pool.find((p) => p.age > 1e8);
    if (!slot) {
      slot = this.pool.reduce((a, b) => (a.age > b.age ? a : b));
    }
    slot.age = 0;
    slot.node.className = `mn-toast${tone ? ` ${tone}` : ''}`;
    setText(slot.node, text);
    setShown(slot.node, true);
    setOpacity(slot.node, 0);
  }

  update(dt) {
    for (const p of this.pool) {
      if (p.age > 1e8) continue;
      p.age += dt;
      const inA = Math.min(1, p.age / 0.10);
      const out = p.age > TOAST_LIFE ? Math.max(0, 1 - (p.age - TOAST_LIFE) / 0.5) : 1;
      setOpacity(p.node, inA * out);
      if (out <= 0) { p.age = 1e9; setShown(p.node, false); }
    }
  }

  clear() {
    for (const p of this.pool) { p.age = 1e9; setShown(p.node, false); }
  }

  dispose() { this.root.remove(); }
}

/** Colour for a damage value in the log, by element. */
export function elementFeedColour(element) {
  return (ELEMENTS[element] ?? ELEMENTS.physical).srgb;
}
