/**
 * cues.js — the audio vocabulary: how a cue name is routed, mixed and spatialised,
 * and how an element's colour becomes an element's timbre.
 *
 * A "cue" is a dotted name (`hit.blade.stone`, `vox.wraith.shriek`, `ui.levelup`).
 * `banks.js` knows how to *synthesise* one; this file knows what it should *sound
 * like in the mix* — which bus, how loud, how much reverb, how much it ducks the
 * music, how many can overlap, and how urgently it should steal a voice.
 *
 * Names are resolved by family prefix with per-cue overrides, so the 72-entry
 * weapon x surface impact matrix does not need 72 table rows, and a cue that
 * `banks.js` can build but nobody thought to route still lands somewhere sane.
 */

import { ELEMENTS } from '../core/palette.js';
import { clamp } from './dsp.js';

/* ================================================================== */
/* 1. Element timbre, derived from the palette                        */
/* ================================================================== */

/**
 * MONARCH's colour identity lives in exactly one file, and the same should be
 * true of its *sonic* identity — an element that is violet on screen should
 * glitter in the same part of the spectrum that violet occupies in the eye.
 *
 * The mapping is a real synaesthetic one, not decoration:
 *
 *   luma of `glow`  → overall brightness of the noise layer. Lightning (near
 *                     white, luma ~0.95) is a broadband crack; shadow (deep
 *                     violet, luma ~0.45) keeps its energy low and its detail up
 *                     in a narrow shimmer band.
 *   blue fraction   → shimmer centre frequency. Blue/violet is the short end of
 *                     the visible spectrum, so it maps to the short end of the
 *                     audible one; frost and shadow glitter, fire does not.
 *   red fraction    → saturation drive and low-mid body. Warm colours get
 *                     harmonic distortion and a fatter fundamental.
 *
 * What colour genuinely cannot encode is *time* — how fast a fire whoosh blooms
 * versus how slowly a shadow swell rises — so the temporal half of each element's
 * character is authored here explicitly.
 */
function deriveTimbre(el, temporal) {
  const e = ELEMENTS[el] ?? ELEMENTS.physical;
  const [gr, gg, gb] = e.glow;
  const [cr, cg, cb] = e.core;
  const sum = gr + gg + gb + 1e-6;
  const luma = 0.2126 * gr + 0.7152 * gg + 0.0722 * gb;
  const blue = gb / sum;
  const red = gr / sum;
  // The core colour is the hot centre of the effect, so its saturation drives how
  // "focused" the sound is — a highly saturated core gets a narrower, more tonal
  // band, a desaturated one a broader noise.
  const mx = Math.max(cr, cg, cb), mn = Math.min(cr, cg, cb);
  const sat = mx > 1e-5 ? (mx - mn) / mx : 0;

  return {
    ...temporal,
    /** Centre of the "glitter" band, 700 Hz (warm) .. 7.5 kHz (violet/white). */
    shimmerHz: 700 * Math.pow(2, 3.4 * clamp(blue * 2.2, 0, 1)),
    /** Cutoff of the broadband noise layer. */
    noiseHz: 900 + luma * 9000,
    /** Body resonance — where the element's weight sits. */
    bodyHz: 55 + red * 190,
    /** tanh drive on the tonal layer. Fire is dirty, frost is clean. */
    drive: 1 + red * 5.5,
    /** Bandpass Q of the tonal layer. */
    focus: 0.8 + sat * 4.0,
    /** Relative level of the sub layer. */
    sub: temporal.sub ?? clamp(1.25 - luma, 0.05, 1),
    luma, blue, red, sat,
  };
}

/**
 * Temporal character per element. These are the numbers a colour cannot tell you.
 * `swell` is the pre-impact rise, `tail` the decay, `grain` how granular/shimmery
 * the top end is, `crack` the transient hardness.
 */
export const ELEMENT_TIMBRE = {
  physical: deriveTimbre('physical', { swell: 0.0, tail: 0.22, grain: 0.0, crack: 1.0, sub: 0.35 }),
  shadow:   deriveTimbre('shadow',   { swell: 0.45, tail: 1.35, grain: 1.0, crack: 0.55, sub: 1.0 }),
  fire:     deriveTimbre('fire',     { swell: 0.16, tail: 0.95, grain: 0.35, crack: 0.7, sub: 0.55 }),
  frost:    deriveTimbre('frost',    { swell: 0.22, tail: 1.1, grain: 0.8, crack: 0.85, sub: 0.3 }),
  lightning:deriveTimbre('lightning',{ swell: 0.0, tail: 0.75, grain: 0.5, crack: 1.0, sub: 0.45 }),
  holy:     deriveTimbre('holy',     { swell: 0.35, tail: 1.6, grain: 0.6, crack: 0.5, sub: 0.4 }),
  blood:    deriveTimbre('blood',    { swell: 0.05, tail: 0.4, grain: 0.15, crack: 0.6, sub: 0.6 }),
};

export function timbreFor(element) {
  return ELEMENT_TIMBRE[element] ?? ELEMENT_TIMBRE.physical;
}

/* ================================================================== */
/* 2. Cue routing                                                     */
/* ================================================================== */

/**
 * @typedef {Object} CueParams
 * @property {string}  bus       'sfx' | 'ui' | 'music' | 'ambience' | 'voice'
 * @property {number}  gain      linear, pre-bus
 * @property {number}  pitch     semitones offset
 * @property {number}  pitchVar  +/- semitones of random variation
 * @property {number}  reverb    send level 0..1
 * @property {number}  priority  higher wins a voice-steal contest
 * @property {number}  duck      0..1 amount of music/ambience duck
 * @property {boolean} spatial   use a 3D panner
 * @property {number}  maxSimul  concurrent instances of this exact cue
 * @property {number}  cooldown  seconds before this cue may retrigger
 * @property {number}  ref       panner reference distance override, metres
 */

const BASE = {
  bus: 'sfx', gain: 1, pitch: 0, pitchVar: 0.5, reverb: 0.3, priority: 3,
  duck: 0, spatial: true, maxSimul: 4, cooldown: 0, ref: 0,
};

/**
 * Family defaults, matched by longest prefix. The ordering of this object is
 * irrelevant — resolution picks the longest matching key.
 */
const FAMILY = {
  'hit':        { gain: 0.95, pitchVar: 1.4, reverb: 0.26, priority: 6, duck: 0.10, maxSimul: 5 },
  'hit.blunt':  { gain: 1.1, pitchVar: 1.1, reverb: 0.34, priority: 7, duck: 0.18 },
  'hit.magic':  { gain: 1.0, reverb: 0.42, priority: 7, duck: 0.16 },
  'swing':      { gain: 0.5, pitchVar: 2.0, reverb: 0.12, priority: 2, maxSimul: 3 },
  'foot':       { gain: 0.34, pitchVar: 2.2, reverb: 0.22, priority: 1, maxSimul: 4, ref: 3.0 },
  'foley':      { gain: 0.30, pitchVar: 2.6, reverb: 0.16, priority: 1, maxSimul: 3, ref: 3.0 },
  'magic':      { gain: 1.0, pitchVar: 0.8, reverb: 0.45, priority: 7, duck: 0.2 },
  'magic.cast': { gain: 0.85, reverb: 0.38, priority: 6, duck: 0.12 },
  'magic.explosion': { gain: 1.25, pitchVar: 0.6, reverb: 0.62, priority: 9, duck: 0.45, maxSimul: 3 },
  'vox':        { bus: 'voice', gain: 0.9, pitchVar: 1.6, reverb: 0.4, priority: 5, maxSimul: 3, ref: 6.0 },
  'vox.boss':   { gain: 1.15, pitchVar: 0.7, reverb: 0.7, priority: 9, duck: 0.35, maxSimul: 1 },
  'ui':         { bus: 'ui', gain: 0.7, pitchVar: 0.2, reverb: 0.08, priority: 8, spatial: false, maxSimul: 2 },
  'amb':        { bus: 'ambience', gain: 0.6, pitchVar: 3.0, reverb: 0.7, priority: 1, maxSimul: 3 },
  'music':      { bus: 'music', gain: 0.8, pitchVar: 0.1, reverb: 0.3, priority: 4, spatial: false },
  'loot':       { gain: 0.55, pitchVar: 1.2, reverb: 0.3, priority: 4, maxSimul: 3 },
  'player':     { gain: 0.8, pitchVar: 1.0, reverb: 0.24, priority: 7, spatial: false },
  'arise':      { gain: 1.3, pitchVar: 0, reverb: 0.75, priority: 10, duck: 1.0, spatial: false, maxSimul: 1 },
  'shadow':     { gain: 1.05, pitchVar: 0.6, reverb: 0.6, priority: 8, duck: 0.4, maxSimul: 2 },
};

/** Explicit overrides for individual cues that do not want their family default. */
const OVERRIDE = {
  'hit.blade.flesh':   { gain: 1.0, reverb: 0.18 },   // wet hits do not ring the room
  'hit.blade.metal':   { gain: 0.95, reverb: 0.5 },   // clangs do
  'hit.blade.crystal': { gain: 0.9, reverb: 0.55 },
  'hit.blunt.flesh':   { gain: 1.2, duck: 0.22 },
  'hit.blunt.stone':   { gain: 1.15, reverb: 0.45, duck: 0.2 },
  'hit.claw.flesh':    { gain: 0.85, pitchVar: 1.8 },
  'ui.levelup':        { gain: 1.0, reverb: 0.3, duck: 0.3, priority: 10, maxSimul: 1 },
  'ui.system':         { gain: 0.75, reverb: 0.16, priority: 9, maxSimul: 1 },
  'ui.skillready':     { gain: 0.45, priority: 4 },
  'player.hurt':       { gain: 1.0, duck: 0.25, priority: 9, maxSimul: 1, cooldown: 0.18 },
  'player.death':      { gain: 1.3, duck: 0.8, priority: 10, maxSimul: 1 },
  'player.dash':       { gain: 0.6, reverb: 0.2, maxSimul: 2 },
  'loot.drop.legendary': { gain: 0.9, reverb: 0.5, duck: 0.15, priority: 8 },
  'loot.drop.mythic':  { gain: 1.0, reverb: 0.6, duck: 0.25, priority: 9 },
  'shadow.extract':    { gain: 1.1, reverb: 0.7, duck: 0.5, priority: 9, maxSimul: 2 },
  'shadow.arise':      { gain: 1.0, reverb: 0.65, duck: 0.35, priority: 9, maxSimul: 3 },
  'amb.drip':          { gain: 0.5, reverb: 0.9, maxSimul: 4 },
  'amb.settle':        { gain: 0.45, reverb: 0.95 },
  'amb.howl':          { gain: 0.4, reverb: 0.95 },
  'amb.crackle':       { gain: 0.5, reverb: 0.4, ref: 4.0, maxSimul: 6 },
  'magic.explosion.shadow': { gain: 1.35, duck: 0.55 },
};

/** Resolved-params cache. Cue resolution happens on every single sound, and the
 *  result is immutable, so it is computed once per name and then read. */
const _cache = new Map();

export function resolveCue(name) {
  let p = _cache.get(name);
  if (p) return p;
  p = { ...BASE };
  // Longest matching family prefix wins, applied shortest-first so a more
  // specific family layers over a more general one.
  const parts = name.split('.');
  for (let n = 1; n <= parts.length; n++) {
    const key = parts.slice(0, n).join('.');
    const fam = FAMILY[key];
    if (fam) Object.assign(p, fam);
  }
  const ov = OVERRIDE[name];
  if (ov) Object.assign(p, ov);
  p.name = name;
  _cache.set(name, p);
  return p;
}

/* ================================================================== */
/* 3. Event → cue naming                                              */
/* ================================================================== */

/** The shared surface vocabulary from ARCHITECTURE.md. Duplicated (not imported)
 *  because importing `physics/surfaces.js` would violate the ownership rule. */
export const SURFACES = [
  'stone', 'flagstone', 'dirt', 'wood', 'metal', 'bone',
  'flesh', 'cloth', 'water', 'crystal', 'ash', 'blood',
];
const SURFACE_SET = new Set(SURFACES);

export const WEAPON_CLASSES = ['blade', 'blunt', 'pierce', 'claw', 'fist', 'magic'];
const WEAPON_SET = new Set(WEAPON_CLASSES);

export const ELEMENT_NAMES = ['physical', 'shadow', 'fire', 'frost', 'lightning', 'holy'];

/** Enemy archetypes we can vocalise. `ai` picks these; anything unknown falls
 *  back to `ghoul`, which is the generic mid-sized humanoid. */
export const ARCHETYPES = ['ghoul', 'knight', 'beast', 'wraith', 'shade', 'boss'];
const ARCH_SET = new Set(ARCHETYPES);

export function safeSurface(s) {
  return SURFACE_SET.has(s) ? s : 'stone';
}
export function safeWeapon(w) {
  return WEAPON_SET.has(w) ? w : 'blade';
}
export function safeArchetype(a) {
  if (!a) return 'ghoul';
  const k = String(a).toLowerCase();
  if (ARCH_SET.has(k)) return k;
  // Best-effort mapping from whatever `ai` decided to call its enemies.
  if (/boss|monarch|lord|king|ant|statue/.test(k)) return 'boss';
  if (/knight|armour|armor|guard|soldier|revenant/.test(k)) return 'knight';
  if (/beast|hound|wolf|spider|worm|brute|ogre/.test(k)) return 'beast';
  if (/wraith|spectre|specter|ghost|phantom/.test(k)) return 'wraith';
  if (/shade|shadow|soldier/.test(k)) return 'shade';
  return 'ghoul';
}

/**
 * Choose the impact cue for a `combat:hit` / `fx:impact` payload.
 * Magic elements get their own layer on top of a soft physical hit, which is why
 * `magic` is a weapon class as well as an element.
 */
export function impactCue(weapon, surface, element) {
  const el = element && element !== 'physical' ? element : null;
  if (el) return `hit.magic.${safeSurface(surface)}`;
  return `hit.${safeWeapon(weapon)}.${safeSurface(surface)}`;
}

export function elementImpactCue(element) {
  return `magic.impact.${ELEMENT_NAMES.includes(element) ? element : 'physical'}`;
}

export function explosionCue(element) {
  return `magic.explosion.${ELEMENT_NAMES.includes(element) ? element : 'physical'}`;
}

export function castCue(element) {
  return `magic.cast.${ELEMENT_NAMES.includes(element) ? element : 'physical'}`;
}

export function footCue(surface, running) {
  return `foot.${safeSurface(surface)}${running ? '.run' : ''}`;
}

export function voxCue(archetype, kind) {
  return `vox.${safeArchetype(archetype)}.${kind}`;
}

/**
 * Stand-in for a cue whose recipe is still in the background bake queue.
 *
 * The expensive cues — explosions, death rattles, the shadow-extraction vortex —
 * are baked lazily, so the very first fire explosion of a run can arrive before
 * its buffer exists. Silence on the first explosion of a session is a far worse
 * failure than a slightly wrong sound, so each heavy cue names a cheaper relative
 * that is already warm. Returns null when nothing sensible exists.
 */
export function substituteCue(name) {
  if (name.startsWith('magic.explosion.')) return `magic.impact.${name.slice(16)}`;
  if (name === 'shadow.extract') return 'magic.cast.shadow';
  if (name === 'player.death') return 'player.hurt';
  if (name === 'player.levelup') return 'ui.skillready';
  if (name === 'amb.howl') return 'amb.settle';
  if (name.startsWith('vox.') && name.endsWith('.death')) return `${name.slice(0, -6)}.growl`;
  return null;
}
