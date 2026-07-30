/**
 * The action bar: six chamfered skill slots plus two round sockets for the
 * signature abilities (the Monarch ultimate and ARISE).
 *
 * Every readout a player actually uses mid-fight is here, and each one exists
 * because its absence is felt:
 *   - the cooldown SWEEP (how long until I can press this again) with a bright
 *     leading edge, because a uniform grey wedge has no readable rate;
 *   - the cooldown NUMBER, because a sweep cannot answer "3 seconds or 8?";
 *   - CHARGE PIPS, because a charge system with no pip count is unplayable;
 *   - the KEYBIND, always, never on hover;
 *   - a desaturated + dimmed state when the skill is unaffordable, which is the
 *     fastest possible answer to "why did nothing happen when I pressed it".
 *
 * Cooldown wedges are drawn into a per-slot canvas rather than a CSS
 * conic-gradient because a CSS gradient means building a new style string every
 * frame for every slot; canvas arc arguments are numbers.
 */

import { M, alpha, clamp01 } from './theme.js';
import { el, canvas as mkCanvas, setText, setClass, retrigger } from './dom.js';
import { bakeSlotFrame, bakeRoundSlot, offscreen, toUrl } from './ornament.js';
import { drawSkillIcon } from './icons.js';

/**
 * The default loadout. `combat` owns real skills; the HUD must still be
 * complete and plausible before that system exists, and these are the ids it
 * will map onto (`ctx.input` ACTIONS: skill1-4, skillQ, skillE, ultimate, arise).
 */
export const DEFAULT_SKILLS = [
  { id: 'skill1', key: '1', glyph: 'cleave', element: 'physical', name: 'Rupture',        cost: 0,  cd: 0,    charges: 0 },
  { id: 'skill2', key: '2', glyph: 'dash',   element: 'shadow',   name: 'Shadow Step',    cost: 14, cd: 6.0,  charges: 2 },
  { id: 'skill3', key: '3', glyph: 'lance',  element: 'frost',    name: 'Rime Lance',     cost: 22, cd: 9.0,  charges: 0 },
  { id: 'skill4', key: '4', glyph: 'nova',   element: 'fire',     name: 'Ember Nova',     cost: 35, cd: 14.0, charges: 0 },
  { id: 'skillQ', key: 'Q', glyph: 'siphon', element: 'shadow',   name: 'Soul Siphon',    cost: 28, cd: 11.0, charges: 0 },
  { id: 'skillE', key: 'E', glyph: 'ward',   element: 'holy',     name: 'Aegis of Ash',   cost: 18, cd: 18.0, charges: 0 },
];

export const SIGNATURE_SKILLS = [
  { id: 'ultimate', key: 'R', glyph: 'domain', element: 'shadow', name: "Monarch's Domain", cost: 0, cd: 60.0, charges: 0 },
  { id: 'arise',    key: 'F', glyph: 'arise',  element: 'shadow', name: 'Arise',            cost: 0, cd: 24.0, charges: 0 },
];

class Slot {
  constructor(parent, def, round) {
    this.def = def;
    this.round = round;
    this.root = el('div', round ? 'mn-round' : 'mn-slot', parent);
    this.frame = el('div', 'frm', this.root);
    this.cvIcon = mkCanvas(round ? M.slotRound : M.slot, round ? M.slotRound : M.slot, 'ico', this.root);
    this.cvCd = mkCanvas(round ? M.slotRound : M.slot, round ? M.slotRound : M.slot, 'cd', this.root);
    this.cIcon = this.cvIcon.getContext('2d');
    this.cCd = this.cvCd.getContext('2d');

    this.elKey = el('div', 'key', this.root);
    setText(this.elKey, def.key);
    if (!round) {
      this.elCdText = el('div', 'cdt', this.root);
      this.elPips = el('div', 'pips', this.root);
      this.pips = [];
      for (let i = 0; i < (def.charges || 0); i++) this.pips.push(el('i', '', this.elPips));
      el('div', 'rdy', this.root);
    }

    // live state
    this.cd = 0;          // remaining seconds
    this.cdTotal = def.cd || 1;
    this.charges = def.charges || 0;
    this.affordable = true;
    this._lastSweep = -1;
    this._lastCdText = '';
    this._baked = 0;
  }

  bake(u, frameUrl) {
    const px = Math.max(20, Math.round((this.round ? M.slotRound : M.slot) * u));
    this.frame.style.backgroundImage = frameUrl;
    if (px === this._baked) return;
    this._baked = px;
    for (const cv of [this.cvIcon, this.cvCd]) {
      cv.width = px; cv.height = px;
      cv.style.width = '100%'; cv.style.height = '100%';
    }
    this.cIcon.clearRect(0, 0, px, px);
    drawSkillIcon(this.cIcon, px, this.def.glyph, this.def.element);
    this._lastSweep = -1;
  }

  /** Redraw the cooldown wedge only when the covered fraction actually moves. */
  _sweep() {
    const f = this.cdTotal > 0 ? clamp01(this.cd / this.cdTotal) : 0;
    const q = Math.round(f * 256);
    if (q === this._lastSweep) return;
    this._lastSweep = q;

    const c = this.cCd;
    const S = this._baked;
    c.clearRect(0, 0, S, S);
    if (q <= 0) return;

    const cx = S * 0.5, cy = S * 0.5, r = S * 0.78;
    const start = -Math.PI * 0.5;
    const end = start + Math.PI * 2 * (q / 256);

    // The covered wedge. Drawn from the centre so it is a true radial wipe.
    c.save();
    if (this.round) { c.beginPath(); c.arc(cx, cy, S * 0.40, 0, Math.PI * 2); c.clip(); }
    c.fillStyle = 'rgba(3,3,6,0.74)';
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, r, start, end);
    c.closePath();
    c.fill();

    // Leading edge: a bright radial line so the rate of recharge is visible.
    c.strokeStyle = 'rgba(255,238,198,0.72)';
    c.lineWidth = Math.max(1, S * 0.028);
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(end) * r, cy + Math.sin(end) * r);
    c.stroke();
    c.restore();

    // A ring that drains with the wedge — visible even when the icon is dark.
    c.save();
    c.strokeStyle = 'rgba(255,226,170,0.55)';
    c.lineWidth = Math.max(1.4, S * 0.045);
    c.beginPath();
    c.arc(cx, cy, S * 0.44, end, start + Math.PI * 2);
    c.stroke();
    c.restore();
  }

  update() {
    this._sweep();
    if (!this.round) {
      const txt = this.cd > 0 ? (this.cd < 3 ? this.cd.toFixed(1) : String(Math.ceil(this.cd))) : '';
      if (txt !== this._lastCdText) { this._lastCdText = txt; setText(this.elCdText, txt); }
      for (let i = 0; i < this.pips.length; i++) setClass(this.pips[i], 'on', i < this.chargesLeft());
    }
    setClass(this.root, 'poor', !this.affordable && this.cd <= 0);
  }

  chargesLeft() {
    if (!this.charges) return 0;
    // A charge system recharges one charge per cooldown; the remaining charges
    // are the whole ones plus whichever is refilling.
    return this._chargesLeft ?? this.charges;
  }

  flashReady() {
    if (this.round) return;
    retrigger(this.root, 'flash');
  }

  dispose() { this.root.remove(); }
}

export class SkillBar {
  constructor(parent, rng) {
    this.root = el('div', 'mn-bar', parent);
    this.rng = rng;
    this.slots = [];
    this.byId = new Map();

    for (const def of DEFAULT_SKILLS) {
      const s = new Slot(this.root, def, false);
      this.slots.push(s);
      this.byId.set(def.id, s);
    }
    for (const def of SIGNATURE_SKILLS) {
      const s = new Slot(this.root, def, true);
      this.slots.push(s);
      this.byId.set(def.id, s);
    }
    this._baked = 0;
  }

  bake(u, rng, noise) {
    const sq = Math.max(24, Math.round(M.slot * u * 2));   // 2x supersample: the
    const rd = Math.max(20, Math.round(M.slotRound * u * 2)); // frame is a bitmap
    if (this._baked !== sq) {                                 // stretched by CSS
      this._baked = sq;
      const a = offscreen(sq, sq);
      bakeSlotFrame(a.c, sq, rng, noise, {});
      this._squareUrl = toUrl(a.cv);
      const b = offscreen(rd, rd);
      bakeRoundSlot(b.c, rd, rng, noise);
      this._roundUrl = toUrl(b.cv);
    }
    for (const s of this.slots) s.bake(u, s.round ? this._roundUrl : this._squareUrl);
  }

  /** Set a cooldown directly (used by events and by debugState). */
  setCooldown(id, remaining, total) {
    const s = this.byId.get(id);
    if (!s) return;
    const wasDown = s.cd > 0;
    s.cd = Math.max(0, remaining);
    if (total) s.cdTotal = total;
    if (wasDown && s.cd <= 0) s.flashReady();
  }

  setAffordable(id, ok) {
    const s = this.byId.get(id);
    if (s) s.affordable = ok;
  }

  setCharges(id, left) {
    const s = this.byId.get(id);
    if (s) s._chargesLeft = left;
  }

  /** Ultimate socket glows when it is off cooldown — a deliberate "press me". */
  update(dt) {
    for (const s of this.slots) {
      if (s.cd > 0) s.cd = Math.max(0, s.cd - dt);
      s.update();
    }
    const ult = this.byId.get('ultimate');
    if (ult) setClass(ult.root, 'charged', ult.cd <= 0);
    const ari = this.byId.get('arise');
    if (ari) setClass(ari.root, 'charged', ari.cd <= 0);
  }

  /** Total resource cost of a skill, for the affordability pass. */
  costOf(id) {
    return this.byId.get(id)?.def.cost ?? 0;
  }

  reset() {
    for (const s of this.slots) {
      s.cd = 0;
      s.affordable = true;
      s._chargesLeft = s.charges;
      s._lastSweep = -1;
    }
  }

  dispose() {
    for (const s of this.slots) s.dispose();
    this.root.remove();
  }
}

/** Buff row above the bar. Small, fast to read, never more than six. */
export class BuffRow {
  constructor(parent) {
    this.root = el('div', 'mn-buffs', parent);
    this.pool = [];
    this._baked = 0;
  }

  _acquire(i) {
    let b = this.pool[i];
    if (!b) {
      const root = el('div', 'mn-buff', this.root);
      const cv = mkCanvas(28, 28, '', root);
      el('div', 'bx', root);
      const t = el('div', 't', root);
      const st = el('div', 'st', root);
      b = { root, cv, c: cv.getContext('2d'), t, st, glyph: null, baked: 0, lastT: '', lastS: '' };
      this.pool[i] = b;
    }
    return b;
  }

  /** `list` is [{ glyph, element, seconds, stacks }] — reused array, not copied. */
  set(list, u) {
    const px = Math.max(16, Math.round(28 * u));
    for (let i = 0; i < this.pool.length; i++) {
      if (i >= list.length) this.pool[i].root.style.display = 'none';
    }
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      const b = this._acquire(i);
      b.root.style.display = '';
      if (b.glyph !== d.glyph || b.element !== d.element || b.baked !== px) {
        b.glyph = d.glyph; b.element = d.element; b.baked = px;
        b.cv.width = px; b.cv.height = px;
        b.cv.style.width = '100%'; b.cv.style.height = '100%';
        b.c.clearRect(0, 0, px, px);
        // buff icons reuse the skill emblem renderer at a smaller scale
        drawSkillIcon(b.c, px, d.glyph, d.element);
      }
      const tt = d.seconds > 0 ? (d.seconds < 10 ? d.seconds.toFixed(1) : String(Math.round(d.seconds))) : '';
      if (tt !== b.lastT) { b.lastT = tt; setText(b.t, tt); }
      const ss = d.stacks > 1 ? `x${d.stacks}` : '';
      if (ss !== b.lastS) { b.lastS = ss; setText(b.st, ss); }
    }
  }

  clear() {
    for (const b of this.pool) b.root.style.display = 'none';
  }

  dispose() { this.root.remove(); }
}

/** Colour helper shared with the tooltip renderer. */
export const slotGlowCss = (element) => alpha(element, 0.6);
