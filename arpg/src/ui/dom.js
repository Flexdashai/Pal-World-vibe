/**
 * Minimal DOM plumbing.
 *
 * There is no framework here on purpose — a HUD is ~200 nodes that never change
 * shape, only content. What it does need, and what a framework would hide, is
 * strict WRITE ELISION: the engine calls `lateUpdate` 60x/second and a naive
 * `node.textContent = x` or `node.style.transform = ...` on every widget every
 * frame is both a string allocation and a style recalculation. Every setter
 * below caches its last value on the node and returns early when nothing moved.
 *
 * The cache lives in a `_mn` bag on the element rather than a WeakMap because
 * the lookup is on the hot path and a property read is an order of magnitude
 * cheaper than a WeakMap get.
 */

const NS_SVG = 'http://www.w3.org/2000/svg';

function bag(node) {
  return node._mn ?? (node._mn = { t: null, w: -1, h: -1, x: null, s: null, o: -1, c: null, v: null });
}

/** Create an element, optionally classed and parented, in one call. */
export function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

export function svg(tag, parent) {
  const n = document.createElementNS(NS_SVG, tag);
  if (parent) parent.appendChild(n);
  return n;
}

/**
 * A canvas with a backing store of `w x h` device pixels.
 *
 * Deliberately does NOT set an inline width/height style: every canvas in this
 * subsystem is sized by the stylesheet in `--u` units, and an inline `148px`
 * would win the cascade and freeze the HUD at its design scale on any display
 * that is not exactly 1280x720.
 */
export function canvas(w, h, cls, parent) {
  const c = el('canvas', cls, parent);
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Text write, elided when unchanged. */
export function setText(node, text) {
  const b = bag(node);
  if (b.t === text) return false;
  b.t = text;
  node.textContent = text;
  return true;
}

/** Class toggle, elided when unchanged (classList.toggle is not free). */
export function setClass(node, cls, on) {
  const key = `c_${cls}`;
  const b = bag(node);
  if (b[key] === on) return false;
  b[key] = on;
  node.classList.toggle(cls, !!on);
  return true;
}

/**
 * Horizontal fill via `transform: scaleX`. Bars are scaled, never resized:
 * `width` triggers layout for the element AND its siblings, `transform` is a
 * compositor-only property. Quantised to 1/2048 so a bar creeping by a
 * ten-thousandth does not rewrite the style string.
 */
export function setScaleX(node, v) {
  const q = Math.round(Math.max(0, Math.min(1, v)) * 2048);
  const b = bag(node);
  if (b.w === q) return false;
  b.w = q;
  node.style.transform = `scaleX(${q / 2048})`;
  return true;
}

/** Vertical fill (globe liquid masks, radial timers). */
export function setScaleY(node, v) {
  const q = Math.round(Math.max(0, Math.min(1, v)) * 2048);
  const b = bag(node);
  if (b.h === q) return false;
  b.h = q;
  node.style.transform = `scaleY(${q / 2048})`;
  return true;
}

/**
 * Opacity, quantised to 1/255 — finer than anyone can see and cheap to compare.
 *
 * ALWAYS writes a value, including at 1.0. Clearing the inline style at full
 * opacity looks like a tidy optimisation and is a trap: several widgets here
 * declare `opacity: 0` in the stylesheet as their resting state, so clearing
 * the inline value hands control back to the sheet and the element vanishes at
 * exactly the moment it was supposed to be fully visible. The ARISE banner was
 * invisible for precisely this reason.
 */
export function setOpacity(node, v) {
  const q = Math.round(Math.max(0, Math.min(1, v)) * 255);
  const b = bag(node);
  if (b.o === q) return false;
  b.o = q;
  node.style.opacity = String(q / 255);
  return true;
}

/** `display:none` toggle that also short-circuits all downstream work. */
export function setShown(node, on) {
  const b = bag(node);
  if (b.v === on) return false;
  b.v = on;
  node.style.display = on ? '' : 'none';
  return true;
}

/** Arbitrary transform, cached by the caller-provided key string. */
export function setTransform(node, value) {
  const b = bag(node);
  if (b.x === value) return false;
  b.x = value;
  node.style.transform = value;
  return true;
}

/** Custom property write, cached. */
export function setVar(node, name, value) {
  const key = `v_${name}`;
  const b = bag(node);
  if (b[key] === value) return false;
  b[key] = value;
  node.style.setProperty(name, value);
  return true;
}

/** Direct style write, cached by property name. */
export function setStyle(node, prop, value) {
  const key = `s_${prop}`;
  const b = bag(node);
  if (b[key] === value) return false;
  b[key] = value;
  node.style[prop] = value;
  return true;
}

/**
 * Restart a CSS keyframe animation. Removing and re-adding the class in the
 * same task is coalesced by the style engine and does nothing; forcing a reflow
 * between the two is the only reliable way, and `offsetWidth` is the cheapest
 * read that triggers one.
 */
export function retrigger(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
  bag(node)[`c_${cls}`] = true;
}

/** Integer with thin-space thousands separators — HUD numbers must not use
 *  commas, which read as decimal points to half the world. */
const GROUP = ' ';
export function groupNum(n) {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += GROUP;
    out += s[i];
  }
  return out;
}

/** Compact form for damage feeds: 12904 -> 12.9K, 1204000 -> 1.20M. */
export function compactNum(n) {
  const v = Math.round(n);
  if (v < 10000) return groupNum(v);
  if (v < 1e6) return `${(v / 1000).toFixed(v < 1e5 ? 1 : 0)}K`;
  return `${(v / 1e6).toFixed(2)}M`;
}

/** Seconds -> "12.4" / "3" for cooldown pips. Under 3s keeps a decimal because
 *  that is the window where the player is actually watching the number. */
export function cdText(s) {
  if (s <= 0) return '';
  if (s < 3) return s.toFixed(1);
  return String(Math.ceil(s));
}

/** Remove every child without touching innerHTML (which reparses). */
export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
