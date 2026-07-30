/**
 * The three linear readouts: experience, current target, and boss.
 *
 * All three share one mechanic that is most of what makes an AAA health bar
 * feel expensive — the DAMAGE LAG. Two stacked fills: the real one snaps to the
 * new value the instant damage lands, and a pale "ghost" behind it holds for a
 * beat then drains to meet it. The width of the pale strip IS the size of the
 * hit, so a big hit is legible as a big hit without a number. Diablo IV, every
 * fighting game, and every MMO worth naming does this; a single-fill bar is the
 * clearest tell of a hobby HUD.
 *
 * The boss bar additionally carries NAMED PHASES, because a boss whose health
 * simply goes down is a damage sponge, and a boss whose bar says
 * "PHASE II — WRATH" is an encounter.
 */

import { UI } from '../core/palette.js';
import { M, damp, clamp01, mixHex, alpha } from './theme.js';
import { el, setText, setScaleX, setShown, setStyle, groupNum } from './dom.js';
import { bakeBarFrame, offscreen, toUrl } from './ornament.js';

/**
 * Shared two-fill track. The brass surround has to overhang the track on all
 * four sides, and the track itself has to clip its fills, so they cannot be the
 * same element: `.trkw` positions both, `.trk` clips, `.frm` overhangs.
 */
function buildTrack(parent) {
  const wrap = el('div', 'trkw', parent);
  const trk = el('div', 'trk', wrap);
  const lag = el('div', 'lag', trk);
  const fil = el('div', 'fil', trk);
  el('div', 'gls', trk);
  el('div', 'seg', trk);
  const frm = el('div', 'frm', wrap);
  return { wrap, trk, lag, fil, frm };
}

class LaggedFill {
  constructor(nodes) {
    this.n = nodes;
    this.value = 1;
    this.shown = 1;
    this.ghost = 1;
    this.hold = 0;
  }

  set(v) {
    const nv = clamp01(v);
    if (nv < this.value) this.hold = 0.28; // beat before the ghost starts to fall
    this.value = nv;
  }

  update(dt) {
    // The real fill tracks fast but not instantly — a single frame jump reads as
    // a glitch, 22/s reads as impact.
    this.shown = damp(this.shown, this.value, 22, dt);
    if (this.hold > 0) this.hold -= dt;
    else this.ghost = damp(this.ghost, this.value, 4.2, dt);
    if (this.ghost < this.shown) this.ghost = this.shown;
    setScaleX(this.n.fil, this.shown);
    setScaleX(this.n.lag, this.ghost);
  }

  snap(v) {
    this.value = this.shown = this.ghost = clamp01(v);
    this.hold = 0;
    setScaleX(this.n.fil, this.shown);
    setScaleX(this.n.lag, this.ghost);
  }
}

// ---------------------------------------------------------------------------
// experience
// ---------------------------------------------------------------------------

export class XpBar {
  constructor(parent) {
    this.root = el('div', 'mn-xp', parent);
    el('div', 'trk', this.root);
    this.fil = el('div', 'fil', this.root);
    el('div', 'tick', this.root);
    el('div', 'shn', this.root);

    // "LEVEL 14" then the progress, reading left to right in the order the eye
    // wants it — the label first, the number it qualifies second.
    const l = el('div', 'plate l', this.root);
    this.elLevelLbl = el('span', '', l);
    setText(this.elLevelLbl, 'Level');
    this.elLevel = el('b', '', l);

    const r = el('div', 'plate r', this.root);
    this.elPct = el('span', '', r);
    this.elNextLbl = el('span', '', r);
    setText(this.elNextLbl, 'to Level');
    this.elNext = el('b', '', r);

    this.value = 0;
    this.shown = 0;
    this.level = 1;
    this._lastPct = -1;
  }

  set(xp, next, level) {
    const v = next > 0 ? clamp01(xp / next) : 0;
    // Wrapping past 100% must not animate backwards through the whole bar.
    if (v < this.value - 0.4) this.shown = 0;
    this.value = v;
    this.xp = xp;
    this.next = next;
    this.level = level;
  }

  update(dt) {
    this.shown = damp(this.shown, this.value, 6, dt);
    setScaleX(this.fil, this.shown);
    const pct = Math.round(this.shown * 1000);
    if (pct !== this._lastPct) {
      this._lastPct = pct;
      setText(this.elPct, `${(pct / 10).toFixed(1)}%`);
      setText(this.elLevel, String(this.level));
      setText(this.elNext, String(this.level + 1));
    }
  }

  dispose() { this.root.remove(); }
}

// ---------------------------------------------------------------------------
// current target
// ---------------------------------------------------------------------------

const RANK_COLOUR = {
  normal: UI.textDim,
  elite: UI.critYellow,
  champion: mixHex(UI.manaViolet, '#c9a8ff', 0.6),
  boss: UI.hpRed,
};

export class TargetBar {
  constructor(parent) {
    this.root = el('div', 'mn-target', parent);
    const hdr = el('div', 'hdr', this.root);
    this.elName = el('span', 'nm', hdr);
    this.elLevel = el('span', 'lv', hdr);
    this.elRank = el('span', 'rank', hdr);
    this.nodes = buildTrack(this.root);
    this.elAff = el('div', 'aff', this.root);
    this.fill = new LaggedFill(this.nodes);
    this.visible = false;
    this.timeout = 0;
    setShown(this.root, false);
  }

  bake(u, url) { setStyle(this.nodes.frm, 'backgroundImage', url); }

  /** `t` is a plain descriptor, not an actor reference — the HUD never retains
   *  gameplay objects, so a dead actor cannot leak through the UI. */
  show(t) {
    setText(this.elName, t.name);
    setText(this.elLevel, `Lv ${t.level}`);
    setText(this.elRank, t.rank === 'normal' ? '' : t.rank);
    setStyle(this.elRank, 'color', RANK_COLOUR[t.rank] ?? UI.textDim);
    setShown(this.elRank, t.rank !== 'normal');
    setText(this.elAff, t.affixes ? t.affixes.join('  •  ') : '');
    setShown(this.elAff, !!t.affixes?.length);
    if (!this.visible) this.fill.snap(t.hpFrac);
    else this.fill.set(t.hpFrac);
    this.visible = true;
    this.timeout = t.sticky ? Infinity : 5.0;
    setShown(this.root, true);
  }

  setFrac(f) { this.fill.set(f); this.timeout = Math.min(this.timeout, 5.0); }

  hide() { this.visible = false; setShown(this.root, false); }

  /** `topOffset` in design px — the target bar drops below the boss bar. */
  layout(topDesign) { setStyle(this.root, 'top', `calc(${topDesign} * var(--u))`); }

  update(dt) {
    if (!this.visible) return;
    if (this.timeout !== Infinity) {
      this.timeout -= dt;
      if (this.timeout <= 0) { this.hide(); return; }
    }
    this.fill.update(dt);
  }

  dispose() { this.root.remove(); }
}

// ---------------------------------------------------------------------------
// boss
// ---------------------------------------------------------------------------

export class BossBar {
  constructor(parent) {
    this.root = el('div', 'mn-boss', parent);
    this.elName = el('div', 'nm', this.root);
    this.elSub = el('div', 'sub', this.root);
    this.nodes = buildTrack(this.root);
    this.elPips = el('div', 'pips', this.root);
    this.pips = [];
    this.fill = new LaggedFill(this.nodes);
    this.visible = false;
    setShown(this.root, false);
  }

  bake(u, url) { setStyle(this.nodes.frm, 'backgroundImage', url); }

  /** `b = { name, title, phases: [names], phase, hpFrac }` */
  show(b) {
    setText(this.elName, b.name);
    this._phases = b.phases ?? ['I'];
    while (this.pips.length < this._phases.length) this.pips.push(el('i', '', this.elPips));
    for (let i = 0; i < this.pips.length; i++) {
      setShown(this.pips[i], i < this._phases.length);
      this.pips[i].classList.toggle('on', i <= (b.phase ?? 0));
    }
    this.setPhase(b.phase ?? 0, b.title);
    if (!this.visible) this.fill.snap(b.hpFrac ?? 1);
    else this.fill.set(b.hpFrac ?? 1);
    this.visible = true;
    setShown(this.root, true);
  }

  setPhase(i, title) {
    const roman = ['I', 'II', 'III', 'IV', 'V'][Math.min(4, i)] ?? 'I';
    const nm = this._phases?.[i] ?? '';
    setText(this.elSub, title ? `${title} — Phase ${roman} · ${nm}` : `Phase ${roman} — ${nm}`);
    for (let k = 0; k < this.pips.length; k++) this.pips[k].classList.toggle('on', k <= i);
  }

  setFrac(f) { this.fill.set(f); }

  hide() { this.visible = false; setShown(this.root, false); }

  update(dt) {
    if (!this.visible) return;
    this.fill.update(dt);
  }

  dispose() { this.root.remove(); }
}

// ---------------------------------------------------------------------------
// shared frame bake
// ---------------------------------------------------------------------------

/**
 * The brass surround for the two health tracks. Baked once at 2x and stretched
 * — these are wide, thin strips whose only fine detail is at the end caps, and
 * a horizontal stretch of a 2x bitmap is indistinguishable from a native bake
 * at this size while costing one canvas instead of two.
 */
export function bakeBarFrames(u, rng, noise) {
  const bw = Math.round((M.bossBar + 18) * u), bh = Math.round(30 * u);
  const a = offscreen(bw, bh);
  bakeBarFrame(a.c, bw, bh, u, rng, noise, { inset: 4 * u });

  const tw = Math.round((M.targetBar + 18) * u), th = Math.round(25 * u);
  const b = offscreen(tw, th);
  bakeBarFrame(b.c, tw, th, u, rng, noise, { inset: 4 * u, tint: 0.85 });

  return { boss: toUrl(a.cv), target: toUrl(b.cv) };
}

/** Shadow-army roster — the Solo Leveling status readout, top-left. */
export class ShadowRoster {
  constructor(parent) {
    this.root = el('div', 'mn-shadows', parent);
    const hd = el('div', 'hd', this.root);
    setText(hd, 'Shadow Army');
    this.elCount = el('div', 'ct', this.root);
    this.elNum = el('span', '', this.elCount);
    this.elCap = el('small', '', this.elCount);
    this.elPips = el('div', 'pips', this.root);
    this.pips = [];
    this.count = 0;
    this.max = 0;
    setShown(this.root, false);
  }

  set(count, max) {
    this.count = count; this.max = max;
    while (this.pips.length < max) this.pips.push(el('i', '', this.elPips));
    for (let i = 0; i < this.pips.length; i++) {
      setShown(this.pips[i], i < max);
      this.pips[i].classList.toggle('on', i < count);
    }
    setText(this.elNum, String(count));
    setText(this.elCap, ` / ${max}`);
    setShown(this.root, max > 0);
  }

  hide() { setShown(this.root, false); }
  dispose() { this.root.remove(); }
}

/** Formats a big damage value the way the feed and tooltips both want it. */
export const bigNum = groupNum;
export const trackGlow = (c) => alpha(c, 0.55);
