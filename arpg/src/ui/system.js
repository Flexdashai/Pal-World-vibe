/**
 * THE SYSTEM WINDOW — the Solo Leveling language.
 *
 * This element is deliberately alien to the rest of the HUD. The Diablo chrome
 * is brass, textured, warm, and hugs the frame edge; the SYSTEM window is a
 * hard-edged translucent blue plate that appears in the middle of the screen
 * with a 1px cyan hairline and no texture at all. That tension is the point: it
 * has to read as a notification interrupting reality, not as a game tooltip.
 *
 * THE TIMING IS THE WHOLE EFFECT and it is asymmetric on purpose
 * (see SYSTEM_TIMING in theme.js):
 *
 *   0.000  the rule and the corner brackets exist at zero width
 *   0.000  a white blowout covers the panel
 *   0.115  panel has snapped from 0.94 scale to 1.0, opacity 1        <- SNAP
 *   0.160  the horizontal rule has drawn out from the centre
 *   0.16+  text types on at 68 cps with a block caret                 <- REVEAL
 *   ~2.6s  hold, unchanging, long enough to read the whole thing twice
 *   +0.62  fade out with a slow upward drift                          <- FADE
 *
 * A symmetric 0.3s ease-in/ease-out on both ends is what makes a system window
 * read as a web modal. It must arrive faster than the eye can track and leave
 * slower than the eye expects.
 *
 * Everything is driven from `ctx.time.raw` rather than CSS transitions so the
 * capture harness lands on a deterministic phase; only the ambient loops (the
 * scanline sweep, the caret blink) are CSS.
 */

import { SYSTEM_TIMING as T, clamp01, easeOutQuint, easeOutExpo } from './theme.js';
import { el, setText, setOpacity, setTransform, setShown, clearNode } from './dom.js';

const LINE_CLASS = { em: 'ln em', gold: 'ln gd', violet: 'ln vi', plain: 'ln' };

class Window {
  constructor(parent) {
    this.root = el('div', 'mn-win', parent);
    this.body = el('div', 'bd', this.root);
    for (const c of ['tl', 'tr', 'bl', 'br']) el('div', `cn ${c}`, this.body);
    el('div', 'scan', this.body);
    this.pop = el('div', 'pop', this.root);
    this.elTitle = el('div', 'ttl', this.body);
    this.elRule = el('div', 'rule', this.body);
    this.elText = el('div', 'txt', this.body);
    this.lines = [];
    this.caret = el('i', 'car');
    this.active = false;
  }

  /** @param {{kind,title,lines,duration}} d */
  open(d, now) {
    this.data = d;
    this.t0 = now;
    this.active = true;
    this.dismissAt = Infinity;
    this.closing = -1;

    setText(this.elTitle, `[ ${String(d.title ?? 'System').toUpperCase()} ]`);

    // Build the line nodes. Windows are rare (a few per minute) so building the
    // DOM per open is fine and keeps every window independent.
    clearNode(this.elText);
    this.lines.length = 0;
    this.total = 0;
    for (const raw of d.lines ?? []) {
      const text = typeof raw === 'string' ? raw : raw.text;
      const tone = typeof raw === 'string' ? 'plain' : (raw.tone ?? 'plain');
      const node = el('div', LINE_CLASS[tone] ?? 'ln', this.elText);
      this.lines.push({ node, text, shown: -1 });
      this.total += text.length;
    }

    this.duration = Math.max(T.holdMin, d.duration ?? 3.4);
    setShown(this.root, true);
    setOpacity(this.root, 0);
    this._reveal(0);
  }

  /** Force the window straight into its hold phase, mid-reveal. Used by the
   *  screenshot harness so any settle count lands on a good-looking frame. */
  poseHold(now, revealed = 0.92) {
    this.t0 = now - (T.snap + this.total * revealed / T.typeCps);
    this.dismissAt = Infinity;
    this.closing = -1;
  }

  close(now) {
    if (this.closing < 0) this.closing = now;
  }

  update(now) {
    if (!this.active) return false;
    const age = now - this.t0;

    // --- enter ------------------------------------------------------------
    const snap = clamp01(age / T.snap);
    const s = 0.945 + 0.055 * easeOutQuint(snap);
    let alphaV = snap;
    let dy = 0;

    // --- exit -------------------------------------------------------------
    if (this.closing >= 0) {
      const f = clamp01((now - this.closing) / T.fade);
      alphaV *= 1 - f * f;                  // starts slow, so it lingers
      dy = -f * 14;
      if (f >= 1) { this.active = false; setShown(this.root, false); return false; }
    } else if (age > T.snap + this.total / T.typeCps + this.duration) {
      this.closing = now;
    }

    setOpacity(this.root, alphaV);
    setTransform(this.root, `translateY(${dy.toFixed(2)}px) scale(${s.toFixed(4)})`);

    // The one-frame blowout. Nothing else in this UI is allowed to be pure
    // white; that is what makes it register as an impact.
    const flash = 1 - clamp01(age / T.flash);
    setOpacity(this.pop, flash * flash * 0.85);

    // The rule draws out from the centre slightly after the panel snaps.
    const rule = easeOutExpo(clamp01((age - T.snap * 0.45) / T.borderDraw));
    setTransform(this.elRule, `scaleX(${rule.toFixed(3)})`);

    this._reveal(Math.max(0, age - T.snap));
    return true;
  }

  _reveal(elapsed) {
    let budget = Math.floor(elapsed * T.typeCps);
    let caretPlaced = false;
    for (let i = 0; i < this.lines.length; i++) {
      const L = this.lines[i];
      const n = Math.max(0, Math.min(L.text.length, budget));
      budget -= L.text.length;
      if (n !== L.shown) {
        L.shown = n;
        setText(L.node, n >= L.text.length ? L.text : L.text.slice(0, n));
      }
      // The caret sits at the head of the reveal and disappears when done.
      if (!caretPlaced && n < L.text.length) {
        if (this.caret.parentNode !== L.node) L.node.appendChild(this.caret);
        caretPlaced = true;
      }
    }
    if (!caretPlaced && this.caret.parentNode) this.caret.remove();
  }

  dispose() { this.root.remove(); }
}

/**
 * The stack. Windows queue rather than overlap: three on screen at once is the
 * most that can be read, and a fourth arriving must wait rather than shove.
 */
export class SystemStack {
  constructor(parent) {
    this.root = el('div', 'mn-sys', parent);
    this.pool = [];
    this.live = [];
    this.queue = [];
    this.maxLive = 3;
  }

  _acquire() {
    for (const w of this.pool) if (!w.active) return w;
    const w = new Window(this.root);
    this.pool.push(w);
    return w;
  }

  push(d, now) {
    if (this.live.length >= this.maxLive) {
      if (this.queue.length < 6) this.queue.push(d);
      return null;
    }
    const w = this._acquire();
    w.open(d, now);
    // DOM order controls stacking; move the freshly opened window to the end so
    // new windows always appear below older ones, like a log.
    this.root.appendChild(w.root);
    this.live.push(w);
    return w;
  }

  /** Immediately show a window already parked in its hold phase. */
  pose(d, now, revealed) {
    const w = this.push(d, now);
    if (w) w.poseHold(now, revealed);
    return w;
  }

  update(now) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (!this.live[i].update(now)) this.live.splice(i, 1);
    }
    while (this.live.length < this.maxLive && this.queue.length) {
      this.push(this.queue.shift(), now);
    }
  }

  clear() {
    this.queue.length = 0;
    for (const w of this.pool) {
      w.active = false;
      setShown(w.root, false);
    }
    this.live.length = 0;
  }

  dispose() {
    for (const w of this.pool) w.dispose();
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------
// canonical window contents
// ---------------------------------------------------------------------------

/**
 * The exact copy for each system beat. Kept here, not at the call site, because
 * the voice of the SYSTEM is a character: terse, declarative, never
 * enthusiastic, always second person. "You have reached Level 14." — not
 * "Level up!".
 */
export const WINDOWS = {
  levelUp: (level, points) => ({
    kind: 'levelup',
    title: 'Level Up',
    duration: 3.6,
    lines: [
      { text: `You have reached Level ${level}.`, tone: 'em' },
      { text: `+${points} stat points available.`, tone: 'gold' },
      { text: 'All wounds have been mended.', tone: 'plain' },
    ],
  }),

  skillUnlock: (name, rank) => ({
    kind: 'skill',
    title: 'Skill Acquired',
    duration: 3.4,
    lines: [
      { text: `${name}  [${rank}]`, tone: 'em' },
      { text: 'Has been added to your arsenal.', tone: 'plain' },
    ],
  }),

  extraction: (name, rank, chance) => ({
    kind: 'extract',
    title: 'System',
    duration: 3.2,
    lines: [
      { text: `Do you wish to extract the shadow of`, tone: 'plain' },
      { text: `"${name}"?`, tone: 'em' },
      { text: `Success rate: ${chance}%`, tone: 'violet' },
    ],
  }),

  arisen: (name, rank) => ({
    kind: 'arise',
    title: 'Shadow Extraction',
    duration: 3.8,
    lines: [
      { text: 'Extraction successful.', tone: 'plain' },
      { text: `${name.toUpperCase()}  —  ${rank.toUpperCase()} RANK`, tone: 'violet' },
      { text: 'has risen as your shadow.', tone: 'plain' },
    ],
  }),

  quest: (title, objective) => ({
    kind: 'quest',
    title: 'Quest',
    duration: 4.2,
    lines: [
      { text: title, tone: 'em' },
      { text: objective, tone: 'plain' },
      { text: 'Failure to comply carries a penalty.', tone: 'gold' },
    ],
  }),

  danger: (line) => ({
    kind: 'warning',
    title: 'Warning',
    duration: 3.0,
    lines: [{ text: line, tone: 'em' }],
  }),
};
