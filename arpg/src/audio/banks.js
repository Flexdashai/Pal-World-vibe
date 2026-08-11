/**
 * banks.js — every one-shot in the game, synthesised.
 *
 * The bank is a registry of *recipes*, not of buffers. A recipe knows how to
 * build one deterministic variation of a cue at a given sample rate; buffers are
 * baked on first use and cached. That matters because the impact matrix alone is
 * six weapon classes x twelve surfaces x N variants, and baking all of it up
 * front would cost hundreds of milliseconds and tens of megabytes for sounds a
 * given run may never trigger. A crypt level that never contains crystal never
 * pays for crystal.
 *
 * Two bake paths:
 *   - light recipes (< ~0.7 s) bake inline on first request. Measured at 0.6-3 ms
 *     each, which is under a frame even on this software rasteriser.
 *   - `heavy` recipes (explosions, the ARISE cue, beds) are queued and built by
 *     `AudioSystem.update` inside a time budget, and the pre-warm list makes sure
 *     the ones that must never stall are ready before combat starts.
 *
 * ── The physical model ────────────────────────────────────────────────
 * An impact is four layers, and all four are needed for it to read as an object
 * hitting a material rather than as a sample:
 *
 *   1. CONTACT TRANSIENT   sub-millisecond, broadband, shaped by how hard and how
 *                          sharp the striker is. This is the "attack with real
 *                          attack" the quality bar demands; without it a hit
 *                          arrives late no matter how loud it is.
 *   2. MODAL BODY          the material ringing. A bank of resonators at the
 *                          material's inharmonic mode frequencies, excited by the
 *                          contact. This is what makes iron iron and bone bone.
 *   3. TEXTURE             the grit, the wetness, the splash — band-limited noise
 *                          with the material's own colour and decay.
 *   4. SUB                 the weight. A short pitch-dropping sine, scaled by the
 *                          striker's mass and the surface's softness.
 */

import {
  Sig, Noise, SVF, ModalBank, PercEnv, Osc, Breakpoint, FormantBank, VOWELS,
  CONTROL_BLOCK, modalHit, noiseBurst, sweepTone, granularShimmer, karplus,
  glottalPulse, normalizePeak, softLimit, fadeOut, addInto, fastTanh, clamp,
} from './dsp.js';
import { timbreFor, SURFACES, WEAPON_CLASSES, ELEMENT_NAMES, ARCHETYPES } from './cues.js';
import { buildVocalisation, VOCAL_ARCHETYPES } from './vocal.js';
import { buildAriseCue } from './arise.js';

/* ================================================================== */
/* 1. Material acoustics                                              */
/* ================================================================== */

/**
 * Per-surface acoustic signature.
 *
 *   modes    [frequency Hz, -60 dB decay seconds, relative gain]. Deliberately
 *            inharmonic: a struck plate or slab has modes at irrational ratios,
 *            and integer ratios instantly read as a musical note instead.
 *   texture  noise colour + band + decay for layer 3.
 *   sub      how much low-end weight the material transmits.
 *   ring     master multiplier on modal decay.
 *   bright   how much contact transient survives (a hard surface reflects it,
 *            a soft one swallows it).
 *   tail     nominal total duration in seconds.
 */
export const SURFACE_ACOUSTICS = {
  // Dressed masonry: bright, short, a hard grit layer, almost no sub.
  stone: {
    modes: [[421, 0.085, 1.0], [773, 0.062, 0.62], [1319, 0.045, 0.38], [2137, 0.031, 0.2], [3491, 0.02, 0.1]],
    texture: { colour: 'white', f0: 3400, f1: 1500, q: 0.9, decay: 0.05 },
    sub: 0.12, ring: 1.0, bright: 1.0, tail: 0.34, trim: 1.0,
  },
  // Damp floor slabs: everything stone does, lower and wetter.
  flagstone: {
    modes: [[298, 0.105, 1.0], [561, 0.075, 0.55], [977, 0.05, 0.32], [1583, 0.033, 0.16]],
    texture: { colour: 'white', f0: 2600, f1: 1100, q: 0.85, decay: 0.06 },
    sub: 0.2, ring: 0.9, bright: 0.85, tail: 0.36, trim: 0.98,
  },
  // Packed grave soil: no modes worth the name, all thud and dust.
  dirt: {
    modes: [[96, 0.07, 1.0], [163, 0.045, 0.4]],
    texture: { colour: 'brown', f0: 900, f1: 380, q: 0.7, decay: 0.1 },
    sub: 0.7, ring: 0.5, bright: 0.22, tail: 0.3, trim: 0.86,
  },
  // Rotted beams and coffin lids: hollow, woody, a real body resonance.
  wood: {
    modes: [[181, 0.155, 1.0], [287, 0.12, 0.5], [433, 0.105, 0.55], [861, 0.07, 0.3], [1489, 0.045, 0.15]],
    texture: { colour: 'white', f0: 2100, f1: 900, q: 1.1, decay: 0.045 },
    sub: 0.35, ring: 1.15, bright: 0.65, tail: 0.42, trim: 0.94,
  },
  // Iron banding, portcullis, brazier bowls: long ringing inharmonic clang.
  metal: {
    modes: [[617, 0.85, 1.0], [1487, 0.72, 0.72], [2381, 0.58, 0.5], [3559, 0.44, 0.34], [5231, 0.3, 0.2], [7109, 0.2, 0.12]],
    texture: { colour: 'white', f0: 6800, f1: 3200, q: 1.4, decay: 0.03 },
    sub: 0.1, ring: 1.0, bright: 1.15, tail: 1.05, trim: 0.9,
  },
  // Ossuary walls: brittle dry clatter, fast decay, mid-focused.
  bone: {
    modes: [[523, 0.115, 1.0], [1129, 0.078, 0.6], [1871, 0.052, 0.36], [2903, 0.034, 0.2], [4297, 0.022, 0.1]],
    texture: { colour: 'white', f0: 4200, f1: 2000, q: 1.2, decay: 0.035 },
    sub: 0.14, ring: 0.85, bright: 0.95, tail: 0.32, trim: 0.95,
  },
  // Actors and corpses: a low body thump under a wet burst. Barely rings at all.
  flesh: {
    modes: [[74, 0.09, 1.0], [147, 0.055, 0.4], [268, 0.035, 0.18]],
    texture: { colour: 'white', f0: 1500, f1: 420, q: 0.75, decay: 0.09 },
    sub: 1.0, ring: 0.55, bright: 0.28, tail: 0.34, trim: 1.0,
  },
  // Banners and shrouds: eats the impact entirely; a soft slap and a rustle.
  cloth: {
    modes: [[143, 0.05, 1.0]],
    texture: { colour: 'pink', f0: 2400, f1: 1300, q: 0.6, decay: 0.075 },
    sub: 0.16, ring: 0.4, bright: 0.2, tail: 0.24, trim: 0.62,
  },
  // Standing crypt water: broadband splash sweeping down, plus bubbles.
  water: {
    modes: [[210, 0.06, 0.5], [430, 0.04, 0.3]],
    texture: { colour: 'white', f0: 7000, f1: 700, q: 0.6, decay: 0.22 },
    sub: 0.35, ring: 0.4, bright: 0.5, tail: 0.55, trim: 0.8,
  },
  // Shadow-rift growth: glassy, very bright, long high modes and a shatter.
  crystal: {
    modes: [[1753, 0.48, 1.0], [2609, 0.4, 0.7], [3907, 0.33, 0.5], [5413, 0.25, 0.32], [7919, 0.17, 0.2], [10331, 0.11, 0.1]],
    texture: { colour: 'white', f0: 9000, f1: 5000, q: 1.6, decay: 0.05 },
    sub: 0.08, ring: 1.0, bright: 1.2, tail: 0.75, trim: 0.85,
  },
  // Burnt-out pyre: a puff. No ring whatsoever.
  ash: {
    modes: [[128, 0.05, 1.0]],
    texture: { colour: 'brown', f0: 700, f1: 260, q: 0.55, decay: 0.16 },
    sub: 0.4, ring: 0.35, bright: 0.14, tail: 0.34, trim: 0.7,
  },
  // Pooled blood: a wet splat, slippery and low.
  blood: {
    modes: [[112, 0.06, 1.0], [223, 0.04, 0.35]],
    texture: { colour: 'white', f0: 1900, f1: 500, q: 0.7, decay: 0.13 },
    sub: 0.6, ring: 0.45, bright: 0.3, tail: 0.38, trim: 0.88,
  },
};

/**
 * Per-weapon-class excitation. `force` scales everything, `sharp` biases the
 * transient towards treble (a blade) or bass (a hammer), `pitchScale` retunes the
 * material (a heavy strike couples into the lower modes), `hits` renders multiple
 * offset contacts for claws.
 */
export const WEAPON_EXCITATION = {
  blade:  { force: 0.85, sharp: 1.0, contact: 0.0011, pitchScale: 1.06, decayScale: 0.9, sub: 0.5, tailScale: 1.0, hits: 1, sing: 0.35, tear: 0.15 },
  blunt:  { force: 1.0, sharp: 0.35, contact: 0.0042, pitchScale: 0.84, decayScale: 1.35, sub: 1.0, tailScale: 1.25, hits: 1, sing: 0.0, tear: 0.0 },
  pierce: { force: 0.7, sharp: 0.8, contact: 0.0009, pitchScale: 1.16, decayScale: 0.75, sub: 0.35, tailScale: 0.85, hits: 1, sing: 0.15, tear: 0.45 },
  claw:   { force: 0.62, sharp: 0.9, contact: 0.0008, pitchScale: 1.22, decayScale: 0.6, sub: 0.25, tailScale: 0.8, hits: 3, sing: 0.0, tear: 0.7 },
  fist:   { force: 0.75, sharp: 0.25, contact: 0.005, pitchScale: 0.9, decayScale: 1.0, sub: 0.8, tailScale: 0.9, hits: 1, sing: 0.0, tear: 0.0 },
  magic:  { force: 0.6, sharp: 0.5, contact: 0.0025, pitchScale: 1.0, decayScale: 1.15, sub: 0.7, tailScale: 1.15, hits: 1, sing: 0.0, tear: 0.0 },
};

/* ================================================================== */
/* 2. Impact synthesis                                                */
/* ================================================================== */

function buildImpact(sr, rng, variant, weapon, surface) {
  const acou = SURFACE_ACOUSTICS[surface] ?? SURFACE_ACOUSTICS.stone;
  const w = WEAPON_EXCITATION[weapon] ?? WEAPON_EXCITATION.blade;
  const dur = clamp(acou.tail * w.tailScale + 0.09, 0.14, 1.5);
  const sig = Sig.seconds(sr, dur, 1);
  const out = sig.data[0];
  const noise = new Noise(rng);

  // Per-variant material detune. Two strikes on the same slab never ring at the
  // same frequency because they never land on the same spot.
  const detune = 1 + rng.signed() * 0.05;
  const forceVar = w.force * (0.85 + rng.float() * 0.3);

  for (let h = 0; h < w.hits; h++) {
    // Claws: three contacts 9-22 ms apart, each weaker and slightly higher.
    const off = h === 0 ? 0 : Math.round((0.009 + rng.float() * 0.013) * h * sr);
    if (off >= out.length - 32) break;
    const hitGain = forceVar * Math.pow(0.72, h);
    const hitDetune = detune * (1 + h * 0.06);

    /* --- 2. modal body ------------------------------------------- */
    const bank = new ModalBank(acou.modes.length);
    bank.fromTable(acou.modes, sr, w.pitchScale * hitDetune, acou.ring * w.decayScale, 1, rng);
    modalHit(out, sr, bank, {
      contact: w.contact * (0.85 + rng.float() * 0.3),
      // A sharp striker deposits energy across a wider band; a blunt one is a
      // low-pass on the excitation before it ever reaches the material.
      exciteLp: 1200 + w.sharp * 11000 * acou.bright,
      exciteHp: 60 + w.sharp * 120,
      gain: hitGain * 0.9,
      offset: off,
    }, rng);

    /* --- 1. contact transient ------------------------------------ */
    // Rendered second so it sums on top of the body it excited. Sub-millisecond
    // attack, 4-9 ms decay: this is the click your hand feels.
    noiseBurst(out, sr, {
      f0: 1800 + w.sharp * 6500 * acou.bright,
      f1: 700 + w.sharp * 2400,
      q: 0.75 + w.sharp * 0.6,
      attack: 0.0004, decay: 0.004 + (1 - w.sharp) * 0.006, curve: 1,
      duration: 0.03, gain: hitGain * 0.85 * acou.bright, offset: off,
    }, rng);

    /* --- 3. material texture ------------------------------------- */
    const tex = acou.texture;
    noiseBurst(out, sr, {
      f0: tex.f0 * (0.9 + rng.float() * 0.2), f1: tex.f1, q: tex.q,
      attack: 0.0009, decay: tex.decay * (0.85 + rng.float() * 0.3), curve: 1,
      duration: Math.min(dur - off / sr, tex.decay * 4 + 0.05),
      gain: hitGain * 0.55, offset: off, colour: tex.colour, sweepCurve: 0.6,
    }, rng);

    /* --- 4. sub weight ------------------------------------------- */
    const subAmt = acou.sub * w.sub * hitGain;
    if (subAmt > 0.04) {
      const f0 = 118 + rng.float() * 34;
      sweepTone(out, sr, {
        f0, f1: f0 * 0.42, duration: Math.min(0.22, dur - off / sr),
        attack: 0.0016, decay: 0.075 + acou.sub * 0.07,
        gain: subAmt * 0.85, offset: off, pitchCurve: 2.2, drive: 1.5,
      });
    }

    /* --- weapon-specific colour ---------------------------------- */
    if (w.sing > 0 && acou.bright > 0.6) {
      // A blade skidding off stone or iron sings: a short high plucked mode.
      karplus(out, sr, 2100 + rng.float() * 2600, {
        decay: 0.985, damp: 0.25, gain: hitGain * w.sing * 0.3,
        offset: off + Math.round(0.0015 * sr), duration: Math.min(0.28, dur), stretch: 0.05,
      }, rng);
    }
    if (w.tear > 0 && (surface === 'flesh' || surface === 'cloth' || surface === 'blood')) {
      // The rip. A rising narrow band with a fast, irregular amplitude — that
      // irregularity is what makes it sound organic rather than like a filter.
      const svf = new SVF();
      const env = new PercEnv(sr, 0.004, 0.12 + rng.float() * 0.06, 1);
      const n = Math.min(Math.round(0.2 * sr), out.length - off);
      let flutter = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        flutter = flutter * 0.86 + noise.white() * 0.14;
        const f = 700 + t * 2400 + flutter * 900;
        svf.process(noise.white(), f, 2.2, sr);
        out[i + off] += svf.band * env.next() * hitGain * w.tear * 0.42;
      }
    }
  }

  /* --- surface specials ------------------------------------------ */
  if (surface === 'water') {
    // Bubbles: short rising sine chirps, which is genuinely how a bubble sounds
    // (its resonant frequency climbs as it shrinks).
    const count = 5 + (rng.u32() % 6);
    for (let b = 0; b < count; b++) {
      const at = Math.round(rng.range(0.01, 0.32) * sr);
      const f = 380 + rng.float() * 1500;
      sweepTone(out, sr, {
        f0: f, f1: f * 1.9, duration: 0.03 + rng.float() * 0.05,
        attack: 0.001, decay: 0.03, gain: 0.1 + rng.float() * 0.14,
        offset: at, pitchCurve: 0.7,
      });
    }
  }
  if (surface === 'crystal') {
    // Shards: a scatter of very short high plucks after the main strike.
    const count = 6 + (rng.u32() % 7);
    for (let s = 0; s < count; s++) {
      const at = Math.round(rng.range(0.015, 0.42) * sr);
      karplus(out, sr, 2600 + rng.float() * 6500, {
        decay: 0.978, damp: 0.12, gain: 0.06 + rng.float() * 0.1,
        offset: at, duration: 0.3, stretch: 0,
      }, rng);
    }
  }
  if (surface === 'metal') {
    // Iron does not stop ringing when the strike ends; a slow beating between two
    // near-identical modes is the tell of a real bell or plate.
    const beat = new ModalBank(2);
    beat.set(0, 1487 * detune, 1.4, 0.35, sr);
    beat.set(1, 1487 * detune * 1.006, 1.35, 0.35, sr);
    modalHit(out, sr, beat, { contact: 0.002, exciteLp: 6000, exciteHp: 400, gain: forceVar * 0.3 }, rng);
  }

  fadeOut(out, Math.round(0.02 * sr), 2);
  softLimit(sig, 1.15);
  normalizePeak(sig, 0.93 * (acou.trim ?? 1));
  return sig;
}

/* ================================================================== */
/* 3. Swings, footsteps, foley                                        */
/* ================================================================== */

/** Weapon swing: a band-passed noise whoosh whose centre frequency rises then
 *  falls — the Doppler of a blade passing the ear. */
function buildSwing(sr, rng, variant, weapon) {
  const w = WEAPON_EXCITATION[weapon] ?? WEAPON_EXCITATION.blade;
  const dur = 0.34 + (1 - w.sharp) * 0.16;
  const sig = Sig.seconds(sr, dur, 1);
  const out = sig.data[0];
  const noise = new Noise(rng);
  const svf = new SVF();
  const n = out.length;
  const peakAt = 0.55 + rng.signed() * 0.08;
  // Heavier weapons whoosh lower and slower.
  const base = 380 + w.sharp * 900;
  const top = base * (2.6 + w.sharp * 1.4);
  const env = new Breakpoint([[0, 0], [dur * peakAt, 1, 2.2], [dur, 0, 0.55]]);
  const q = 1.5 + w.sharp * 1.2;
  let f = base, e = 0;
  for (let i = 0; i < n; i++) {
    if ((i % CONTROL_BLOCK) === 0) {
      const x = i / n;
      // Frequency follows a raised cosine peaking where the blade passes closest.
      const prox = Math.pow(Math.max(0, 1 - Math.abs(x - peakAt) / peakAt), 1.6);
      f = base + (top - base) * prox;
      e = env.at(i / sr);
    }
    svf.process(noise.pink() * 3, f, q, sr);
    out[i] += svf.band * e;
  }
  // Blades add a faint tonal edge — air over a sharpened edge whistles.
  if (w.sing > 0) {
    const osc = new Osc(sr);
    for (let i = 0; i < n; i++) {
      const x = i / n;
      const prox = Math.pow(Math.max(0, 1 - Math.abs(x - peakAt) / peakAt), 3);
      osc.step(1500 + prox * 2200);
      out[i] += osc.sine() * prox * 0.06;
    }
  }
  normalizePeak(sig, 0.8);
  return sig;
}

/**
 * Footstep. Two contacts — heel then ball — 28-55 ms apart, because a single
 * impulse reads as a stamp, not a step. The surface decides the texture and how
 * much of the heel survives.
 */
function buildFootstep(sr, rng, variant, surface, running) {
  const acou = SURFACE_ACOUSTICS[surface] ?? SURFACE_ACOUSTICS.flagstone;
  const dur = clamp(acou.tail * 0.7 + 0.12, 0.16, 0.5);
  const sig = Sig.seconds(sr, dur, 1);
  const out = sig.data[0];
  const gap = Math.round((running ? 0.022 : 0.038) * (0.75 + rng.float() * 0.5) * sr);
  const heelGain = running ? 0.85 : 0.55;

  for (let part = 0; part < 2; part++) {
    const off = part === 0 ? 0 : gap;
    const g = (part === 0 ? heelGain : 1.0) * (running ? 1.15 : 0.8);
    const bank = new ModalBank(Math.min(3, acou.modes.length));
    // A boot is a big soft striker: it couples into the low modes only.
    bank.fromTable(acou.modes.slice(0, 3), sr, 0.72 * (1 + rng.signed() * 0.04), acou.ring * 0.55, 1, rng);
    modalHit(out, sr, bank, {
      contact: 0.004 + rng.float() * 0.002,
      exciteLp: 900 + acou.bright * 3200,
      exciteHp: 70,
      gain: g * 0.5, offset: off,
    }, rng);
    const tex = acou.texture;
    noiseBurst(out, sr, {
      f0: tex.f0 * 0.6, f1: tex.f1 * 0.5, q: tex.q,
      attack: 0.0012, decay: tex.decay * (running ? 1.0 : 0.75),
      duration: Math.min(0.2, dur), gain: g * 0.4, offset: off, colour: tex.colour,
    }, rng);
    // Body weight through the floor.
    sweepTone(out, sr, {
      f0: 96 + rng.float() * 26, f1: 44, duration: 0.11,
      attack: 0.003, decay: 0.05 + acou.sub * 0.05,
      gain: g * 0.5 * (0.3 + acou.sub * 0.7), offset: off, pitchCurve: 2,
    });
  }
  // A scuff on the push-off: quiet, but its absence is what makes footsteps sound
  // like a metronome instead of a person.
  noiseBurst(out, sr, {
    f0: 2600, f1: 1100, q: 0.8, attack: 0.006, decay: 0.05,
    duration: Math.min(0.16, dur), gain: 0.16 * acou.bright,
    offset: gap + Math.round(0.02 * sr), colour: 'pink',
  }, rng);

  fadeOut(out, Math.round(0.02 * sr), 2);
  normalizePeak(sig, 0.72);
  return sig;
}

/** Armour / chain / cloth / leather rattle, triggered by movement and hits. */
function buildFoley(sr, rng, variant, kind) {
  const dur = kind === 'chain' ? 0.55 : 0.34;
  const sig = Sig.seconds(sr, dur, 1);
  const out = sig.data[0];

  if (kind === 'chain' || kind === 'armour') {
    // A scatter of small metal collisions. Count and pitch separate a mail
    // hauberk (many small, high) from a hanging chain (few large, low).
    const count = kind === 'chain' ? 5 + (rng.u32() % 5) : 9 + (rng.u32() % 8);
    const f0 = kind === 'chain' ? 900 : 1900;
    for (let i = 0; i < count; i++) {
      const at = Math.round(rng.range(0, dur * 0.6) * sr);
      const bank = new ModalBank(3);
      const f = f0 * (0.7 + rng.float() * 0.9);
      bank.set(0, f, 0.09 + rng.float() * 0.1, 1.0, sr);
      bank.set(1, f * 2.37, 0.06, 0.5, sr);
      bank.set(2, f * 4.11, 0.04, 0.25, sr);
      modalHit(out, sr, bank, {
        contact: 0.0006, exciteLp: 12000, exciteHp: 500,
        gain: 0.25 + rng.float() * 0.4, offset: at,
      }, rng);
    }
  } else {
    // Cloth / leather: sparse bursts of pink noise with a soft attack. Leather
    // creaks (a slow amplitude wobble), cloth just rustles.
    const count = 3 + (rng.u32() % 4);
    for (let i = 0; i < count; i++) {
      const at = Math.round(rng.range(0, dur * 0.55) * sr);
      noiseBurst(out, sr, {
        f0: kind === 'leather' ? 900 : 2400, f1: kind === 'leather' ? 420 : 1200,
        q: 0.7, attack: 0.008, decay: 0.05 + rng.float() * 0.05,
        duration: 0.2, gain: 0.4 + rng.float() * 0.4, offset: at, colour: 'pink',
      }, rng);
    }
    if (kind === 'leather') {
      const osc = new Osc(sr);
      const env = new PercEnv(sr, 0.02, 0.18, 1);
      const n = Math.min(Math.round(0.25 * sr), out.length);
      for (let i = 0; i < n; i++) {
        osc.step(180 + Math.sin(i / sr * 17) * 40);
        out[i] += osc.tri() * env.next() * 0.05;
      }
    }
  }
  normalizePeak(sig, 0.6);
  return sig;
}

/* ================================================================== */
/* 4. Magic                                                           */
/* ================================================================== */

/**
 * The cast: a rising swell into a release. `swell` from the element's timbre sets
 * how long the charge is; shadow takes almost half a second to gather, lightning
 * has no charge at all and simply cracks.
 */
function buildMagicCast(sr, rng, variant, element) {
  const T = timbreFor(element);
  const swell = 0.16 + T.swell * 0.6;
  const dur = swell + 0.45 + T.tail * 0.4;
  const sig = Sig.seconds(sr, dur, 2);
  const L = sig.data[0], R = sig.data[1];
  const mono = new Float32Array(sig.length);
  const noise = new Noise(rng);

  /* rising body: a filtered saw cluster climbing an octave into the release */
  const osc = new Osc(sr, rng.float());
  const osc2 = new Osc(sr, rng.float());
  const filt = new SVF();
  const swellN = Math.round(swell * sr);
  const baseF = T.bodyHz * 1.6;
  const q = 1.6 + T.focus * 0.4;
  const invDrive = 1 / T.drive;
  let f = baseF, cutoff = 220, ramp = 0;
  for (let i = 0; i < swellN; i++) {
    if ((i % CONTROL_BLOCK) === 0) {
      const t = i / swellN;
      f = baseF * Math.pow(2, t * 1.6);
      cutoff = 220 + Math.pow(t, 1.6) * T.noiseHz;
      // Cubic ramp keeps the charge quiet until the last moment, which is what
      // makes the release feel earned.
      ramp = Math.pow(t, 2.4) * 0.55;
    }
    osc.step(f);
    osc2.step(f * 1.497); // a fifth: adds weight without implying a key
    filt.process(osc.saw() * 0.6 + osc2.saw() * 0.35, cutoff, q, sr);
    mono[i] += fastTanh(filt.band * T.drive) * invDrive * ramp;
  }
  /* release transient + tail */
  noiseBurst(mono, sr, {
    f0: T.noiseHz * 1.3, f1: T.noiseHz * 0.3, q: 0.8 + T.focus * 0.5,
    attack: 0.0006, decay: 0.05 + T.tail * 0.12, duration: 0.4,
    gain: 0.7 * (0.5 + T.crack * 0.7), offset: swellN,
  }, rng);
  sweepTone(mono, sr, {
    f0: T.bodyHz * 2.4, f1: T.bodyHz * 0.75, duration: 0.42,
    attack: 0.001, decay: 0.1 + T.tail * 0.2, gain: 0.6 * T.sub,
    offset: swellN, pitchCurve: 2.4, drive: T.drive * 0.5,
  });
  // Element-specific colour on the release.
  if (element === 'fire') {
    // Crackle: sparse impulses through a resonant band. Fire is not noise, it is
    // thousands of tiny individual pops.
    for (let i = 0; i < 90; i++) {
      const at = swellN + Math.round(rng.range(0, 0.5) * sr);
      if (at >= mono.length - 8) continue;
      const bank = new ModalBank(1);
      bank.set(0, 900 + rng.float() * 3400, 0.012 + rng.float() * 0.02, 1, sr);
      modalHit(mono, sr, bank, { contact: 0.0004, exciteLp: 14000, exciteHp: 700, gain: 0.1 + rng.float() * 0.18, offset: at }, rng);
    }
  } else if (element === 'frost') {
    for (let i = 0; i < 26; i++) {
      const at = swellN + Math.round(rng.range(0, 0.55) * sr);
      karplus(mono, sr, 2800 + rng.float() * 5200, { decay: 0.982, damp: 0.1, gain: 0.08 + rng.float() * 0.1, offset: at, duration: 0.3 }, rng);
    }
  } else if (element === 'lightning') {
    // Arc: rapid random retriggering of a high resonant band.
    for (let i = 0; i < 40; i++) {
      const at = swellN + Math.round(rng.range(0, 0.3) * sr);
      noiseBurst(mono, sr, { f0: 3000 + rng.float() * 6000, f1: 1400, q: 3.5, attack: 0.0002, decay: 0.006, duration: 0.03, gain: 0.2 + rng.float() * 0.3, offset: at }, rng);
    }
  } else if (element === 'holy') {
    // A struck bell in the release: inharmonic partials at bell ratios.
    const bell = new ModalBank(5);
    const f = 523.25;
    const ratios = [0.5, 1.0, 1.183, 1.506, 2.0];
    for (let m = 0; m < ratios.length; m++) bell.set(m, f * ratios[m], 2.2 - m * 0.25, 1 / (1 + m * 0.6), sr);
    modalHit(mono, sr, bell, { contact: 0.0015, exciteLp: 7000, exciteHp: 200, gain: 0.5, offset: swellN }, rng);
  }

  /* stereo: shimmer for the granular elements, Haas for the rest */
  if (T.grain > 0.25) {
    granularShimmer(mono, L, R, sr, {
      grainMs: 70 + T.grain * 50, overlap: 4, ratios: [2, 3], gain: 0.32 * T.grain,
      jitter: 0.5, spread: 0.85, feedback: 0.3, tail: T.tail * 0.5,
    }, rng);
  }
  for (let i = 0; i < mono.length; i++) { L[i] += mono[i]; R[i] += mono[i] * 0.97; }
  softLimit(sig, 1.1);
  normalizePeak(sig, 0.9);
  return sig;
}

/** The impact half of a spell: the element hitting something. Short, hard. */
function buildMagicImpact(sr, rng, variant, element) {
  const T = timbreFor(element);
  const dur = 0.25 + T.tail * 0.55;
  const sig = Sig.seconds(sr, dur, 2);
  const mono = new Float32Array(sig.length);

  noiseBurst(mono, sr, {
    f0: T.noiseHz * 1.5, f1: T.noiseHz * 0.25, q: 0.7 + T.focus * 0.6,
    attack: 0.0003, decay: 0.03 + T.tail * 0.07, duration: dur * 0.7,
    gain: 0.8 * (0.4 + T.crack), offset: 0,
  }, rng);
  sweepTone(mono, sr, {
    f0: T.bodyHz * 3.2, f1: T.bodyHz * 0.6, duration: Math.min(0.4, dur),
    attack: 0.0008, decay: 0.06 + T.tail * 0.14, gain: 0.75 * T.sub,
    pitchCurve: 2.6, drive: T.drive * 0.6,
  });
  // The element's own resonance: a short high-Q band that makes frost tinkle,
  // lightning zap and shadow hum without any of them sharing a sample.
  const bank = new ModalBank(3);
  for (let m = 0; m < 3; m++) {
    bank.set(m, T.shimmerHz * (1 + m * 0.61) * (0.95 + rng.float() * 0.1), 0.08 + T.tail * 0.22 * (1 - m * 0.25), 1 / (1 + m), sr);
  }
  modalHit(mono, sr, bank, { contact: 0.0008, exciteLp: 16000, exciteHp: 300, gain: 0.42 * (0.3 + T.grain) }, rng);

  const L = sig.data[0], R = sig.data[1];
  if (T.grain > 0.3) {
    granularShimmer(mono, L, R, sr, {
      grainMs: 55, overlap: 4, ratios: [2, 3], gain: 0.3 * T.grain,
      jitter: 0.6, spread: 0.9, feedback: 0.25, tail: T.tail * 0.35,
    }, rng);
  }
  for (let i = 0; i < mono.length; i++) { L[i] += mono[i]; R[i] += mono[i] * 0.96; }
  softLimit(sig, 1.2);
  normalizePeak(sig, 0.94);
  return sig;
}

/** The big one: an AoE detonation. Heavy — always background-baked. */
function buildExplosion(sr, rng, variant, element) {
  const T = timbreFor(element);
  const dur = 1.5 + T.tail * 1.2;
  const sig = Sig.seconds(sr, dur, 2);
  const mono = new Float32Array(sig.length);
  const noise = new Noise(rng);

  /* the crack — 3 ms of full-band energy. Without it an explosion is a swell. */
  noiseBurst(mono, sr, {
    f0: 9000, f1: 2500, q: 0.6, attack: 0.0002, decay: 0.012,
    duration: 0.1, gain: 0.9 * (0.4 + T.crack * 0.8),
  }, rng);
  /* the body — a big downward sub sweep with heavy drive */
  sweepTone(mono, sr, {
    f0: 165, f1: 27, duration: Math.min(1.1, dur), attack: 0.001,
    decay: 0.3 + T.tail * 0.3, gain: 0.95 * (0.5 + T.sub * 0.6),
    pitchCurve: 2.8, drive: 2.4, fm: 0.04, fmRatio: 0.5,
  });
  /* the roar — filtered noise with a slow decay, swept down over a second */
  {
    const svf = new SVF();
    const env = new PercEnv(sr, 0.004, 0.55 + T.tail * 0.5, 1);
    const n = Math.min(Math.round((1.1 + T.tail * 0.6) * sr), mono.length);
    let f = T.noiseHz * 1.1 + 90;
    for (let i = 0; i < n; i++) {
      if ((i % CONTROL_BLOCK) === 0) f = (T.noiseHz * 1.1) * Math.pow(0.12, i / n) + 90;
      svf.process(noise.brown() * 1.6 + noise.white() * 0.5, f, 0.8, sr);
      mono[i] += svf.low * env.next() * 0.55;
    }
  }
  /* debris — a scatter of small impacts through the tail */
  const debris = 20 + (rng.u32() % 18);
  for (let d = 0; d < debris; d++) {
    const at = Math.round(rng.range(0.05, dur * 0.7) * sr);
    const bank = new ModalBank(2);
    const f = 260 + rng.float() * 1500;
    bank.set(0, f, 0.05 + rng.float() * 0.08, 1, sr);
    bank.set(1, f * 1.73, 0.03, 0.4, sr);
    modalHit(mono, sr, bank, { contact: 0.0009, exciteLp: 9000, exciteHp: 200, gain: 0.06 + rng.float() * 0.14, offset: at }, rng);
  }

  const L = sig.data[0], R = sig.data[1];
  if (T.grain > 0.25) {
    granularShimmer(mono, L, R, sr, {
      grainMs: 110, overlap: 3, ratios: [2, 3, 4], gain: 0.28 * T.grain,
      jitter: 0.7, spread: 1.0, feedback: 0.4, tail: T.tail,
    }, rng);
  }
  // Haas-widen the mono core so the detonation is not a point source.
  const d = Math.round(0.009 * sr);
  for (let i = 0; i < mono.length; i++) {
    L[i] += mono[i];
    R[i] += (i >= d ? mono[i - d] : 0) * 0.95;
  }
  softLimit(sig, 1.35);
  normalizePeak(sig, 0.97);
  return sig;
}

/* ================================================================== */
/* 5. Shadow-specific cues                                            */
/* ================================================================== */

/** Shadow extraction: the corpse dissolving into the violet vortex. A reversed
 *  suck-in, a sub swell, and shimmer that climbs as the soul comes out. */
function buildShadowExtract(sr, rng, variant) {
  const T = timbreFor('shadow');
  const dur = 1.6;
  const sig = Sig.seconds(sr, dur, 2);
  const L = sig.data[0], R = sig.data[1];
  const mono = new Float32Array(sig.length);

  // Inhale: build the swell forwards then reverse it, so the amplitude ramps in
  // from nothing — the psychoacoustic signature of "something being pulled".
  const swell = new Float32Array(Math.round(0.9 * sr));
  noiseBurst(swell, sr, { f0: 5200, f1: 900, q: 1.4, attack: 0.002, decay: 0.35, duration: 0.9, gain: 0.5, colour: 'pink' }, rng);
  {
    const osc = new Osc(sr, 0);
    const n = swell.length;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      osc.step(T.bodyHz * 2 * Math.pow(2, t * 1.2));
      swell[i] += osc.saw() * Math.pow(1 - t, 1.5) * 0.25;
    }
  }
  for (let i = 0, j = swell.length - 1; i < j; i++, j--) { const t = swell[i]; swell[i] = swell[j]; swell[j] = t; }
  addInto(mono, swell, 1, 0);

  // The release: sub swell up and a wet bloom.
  sweepTone(mono, sr, {
    f0: 30, f1: 92, duration: 0.55, attack: 0.05, decay: 0.5,
    gain: 0.75, offset: Math.round(0.82 * sr), pitchCurve: 0.55, drive: 1.8,
  });
  noiseBurst(mono, sr, {
    f0: 800, f1: 4200, q: 1.1, attack: 0.02, decay: 0.3,
    duration: 0.7, gain: 0.32, offset: Math.round(0.85 * sr), sweepCurve: 0.6,
  }, rng);

  granularShimmer(mono, L, R, sr, {
    grainMs: 85, overlap: 4, ratios: [2, 3], gain: 0.42,
    jitter: 0.55, spread: 0.95, feedback: 0.45, tail: 0.5,
  }, rng);
  for (let i = 0; i < mono.length; i++) { L[i] += mono[i] * 0.9; R[i] += mono[i] * 0.88; }
  softLimit(sig, 1.1);
  normalizePeak(sig, 0.92);
  return sig;
}

/** A shadow soldier materialising: a short violet whump with a formant sigh. */
function buildShadowArise(sr, rng, variant) {
  const dur = 1.15;
  const sig = Sig.seconds(sr, dur, 2);
  const mono = new Float32Array(sig.length);
  sweepTone(mono, sr, { f0: 140, f1: 38, duration: 0.5, attack: 0.004, decay: 0.28, gain: 0.8, pitchCurve: 2.2, drive: 2.0 });
  noiseBurst(mono, sr, { f0: 4200, f1: 600, q: 0.9, attack: 0.001, decay: 0.14, duration: 0.5, gain: 0.45 }, rng);
  // A brief voiced sigh: the soldier's first breath. Formants, not a filter
  // sweep — the shadow soldier is a person, and the ear needs to know that.
  {
    const fb = new FormantBank(4).setVowel(VOWELS.gr, sr, 0.82, 1.0, 1);
    const env = new PercEnv(sr, 0.05, 0.45, 1);
    const delay = Math.round(0.1 * sr);            // the breath follows the whump
    const n = Math.min(Math.round(0.7 * sr), mono.length - delay);
    const osc = new Osc(sr);
    const noise = new Noise(rng);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      osc.step(62 * (1 - t * 0.18));
      const ex = glottalPulse(osc.p, 0.58, 0.14) * 2 - 0.6 + noise.white() * 0.25;
      mono[i + delay] += fb.process(ex) * env.next() * 0.4;
    }
  }
  const L = sig.data[0], R = sig.data[1];
  granularShimmer(mono, L, R, sr, { grainMs: 70, overlap: 3, ratios: [2, 3], gain: 0.3, jitter: 0.5, spread: 0.9, feedback: 0.3, tail: 0.3 }, rng);
  for (let i = 0; i < mono.length; i++) { L[i] += mono[i]; R[i] += mono[i] * 0.96; }
  softLimit(sig, 1.1);
  normalizePeak(sig, 0.9);
  return sig;
}

/* ================================================================== */
/* 6. UI, loot, player                                                */
/* ================================================================== */

function buildUi(sr, rng, variant, kind) {
  switch (kind) {
    case 'hover': {
      const sig = Sig.seconds(sr, 0.1, 1);
      noiseBurst(sig.data[0], sr, { f0: 5200, f1: 3400, q: 2.2, attack: 0.0005, decay: 0.02, duration: 0.09, gain: 0.5 }, rng);
      normalizePeak(sig, 0.5);
      return sig;
    }
    case 'click': {
      const sig = Sig.seconds(sr, 0.16, 1);
      const bank = new ModalBank(3);
      bank.set(0, 1480, 0.05, 1, sr);
      bank.set(1, 2960, 0.03, 0.4, sr);
      bank.set(2, 5200, 0.02, 0.18, sr);
      modalHit(sig.data[0], sr, bank, { contact: 0.0005, exciteLp: 14000, exciteHp: 800, gain: 0.7 }, rng);
      normalizePeak(sig, 0.7);
      return sig;
    }
    case 'error': {
      const sig = Sig.seconds(sr, 0.34, 1);
      sweepTone(sig.data[0], sr, { f0: 220, f1: 138, duration: 0.3, attack: 0.002, decay: 0.16, gain: 0.6, wave: 'tri', pitchCurve: 1, drive: 2 });
      normalizePeak(sig, 0.7);
      return sig;
    }
    case 'skillready': {
      // Two notes a fifth apart, short and bright — reads as "available" without
      // competing with combat.
      const sig = Sig.seconds(sr, 0.34, 1);
      const out = sig.data[0];
      const f = [880, 1318.5];
      for (let i = 0; i < 2; i++) {
        const bank = new ModalBank(2);
        bank.set(0, f[i], 0.16, 1, sr);
        bank.set(1, f[i] * 2.01, 0.09, 0.3, sr);
        modalHit(out, sr, bank, { contact: 0.0008, exciteLp: 10000, exciteHp: 400, gain: 0.5, offset: Math.round(i * 0.055 * sr) }, rng);
      }
      normalizePeak(sig, 0.62);
      return sig;
    }
    case 'system': {
      // The Solo Leveling blue window. Glassy, synthetic, slightly cold — a
      // detuned pair of high sines through a short reverse swell.
      const sig = Sig.seconds(sr, 0.75, 2);
      const mono = new Float32Array(sig.length);
      const pre = new Float32Array(Math.round(0.2 * sr));
      noiseBurst(pre, sr, { f0: 3000, f1: 8000, q: 2.5, attack: 0.001, decay: 0.12, duration: 0.2, gain: 0.4 }, rng);
      for (let i = 0, j = pre.length - 1; i < j; i++, j--) { const t = pre[i]; pre[i] = pre[j]; pre[j] = t; }
      addInto(mono, pre, 1, 0);
      const bank = new ModalBank(4);
      const base = 1174.7; // D6 — cold and clean
      bank.set(0, base, 0.5, 1, sr);
      bank.set(1, base * 1.5, 0.42, 0.55, sr);
      bank.set(2, base * 2.005, 0.3, 0.3, sr);
      bank.set(3, base * 3.01, 0.2, 0.14, sr);
      modalHit(mono, sr, bank, { contact: 0.0009, exciteLp: 15000, exciteHp: 600, gain: 0.6, offset: pre.length }, rng);
      const L = sig.data[0], R = sig.data[1];
      const d = Math.round(0.013 * sr);
      for (let i = 0; i < mono.length; i++) { L[i] += mono[i]; R[i] += (i >= d ? mono[i - d] : 0) * 0.9; }
      normalizePeak(sig, 0.7);
      return sig;
    }
    case 'levelup':
    default: {
      // A rising perfect-fifth stack with a shimmer tail. Triumphant but still in
      // the game's palette: no major-key fanfare, this world does not do those.
      const sig = Sig.seconds(sr, 2.0, 2);
      const mono = new Float32Array(sig.length);
      const notes = [293.66, 440, 587.33, 880]; // D4 A4 D5 A5
      for (let i = 0; i < notes.length; i++) {
        const bank = new ModalBank(3);
        bank.set(0, notes[i], 1.1 - i * 0.12, 1, sr);
        bank.set(1, notes[i] * 2.002, 0.6, 0.4, sr);
        bank.set(2, notes[i] * 3.01, 0.3, 0.18, sr);
        modalHit(mono, sr, bank, {
          contact: 0.0012, exciteLp: 12000, exciteHp: 250,
          gain: 0.5 - i * 0.05, offset: Math.round(i * 0.085 * sr),
        }, rng);
      }
      sweepTone(mono, sr, { f0: 55, f1: 147, duration: 0.6, attack: 0.02, decay: 0.5, gain: 0.35, pitchCurve: 0.6, drive: 1.6 });
      const L = sig.data[0], R = sig.data[1];
      granularShimmer(mono, L, R, sr, { grainMs: 90, overlap: 4, ratios: [2, 3], gain: 0.26, jitter: 0.5, spread: 0.9, feedback: 0.4, tail: 0.6 }, rng);
      for (let i = 0; i < mono.length; i++) { L[i] += mono[i] * 0.9; R[i] += mono[i] * 0.88; }
      softLimit(sig, 1.1);
      normalizePeak(sig, 0.88);
      return sig;
    }
  }
}

function buildLoot(sr, rng, variant, rarity) {
  // Rarity is expressed as pitch, ring length and how much shimmer sits on top —
  // the same escalation the item beam gets visually.
  const tier = { common: 0, magic: 1, rare: 2, legendary: 3, mythic: 4 }[rarity] ?? 0;
  const dur = 0.4 + tier * 0.3;
  const sig = Sig.seconds(sr, dur, 2);
  const mono = new Float32Array(sig.length);

  // The physical drop: metal or leather hitting stone.
  const bank = new ModalBank(4);
  const f = 620 * (1 + tier * 0.12);
  bank.set(0, f, 0.1 + tier * 0.14, 1, sr);
  bank.set(1, f * 1.73, 0.08 + tier * 0.1, 0.6, sr);
  bank.set(2, f * 2.41, 0.06 + tier * 0.08, 0.35, sr);
  bank.set(3, f * 4.07, 0.04 + tier * 0.05, 0.18, sr);
  modalHit(mono, sr, bank, { contact: 0.0009, exciteLp: 11000, exciteHp: 300, gain: 0.6 }, rng);
  noiseBurst(mono, sr, { f0: 3200, f1: 1400, q: 0.9, attack: 0.0005, decay: 0.03, duration: 0.12, gain: 0.35 }, rng);

  if (tier >= 2) {
    // Rare and above get a tail: a soft bell an octave up, arriving 60 ms late so
    // it reads as the item's aura rather than as part of the impact.
    const bell = new ModalBank(3);
    for (let m = 0; m < 3; m++) bell.set(m, f * 2 * (1 + m * 0.5), 0.6 + tier * 0.2, 1 / (1 + m), sr);
    modalHit(mono, sr, bell, { contact: 0.0015, exciteLp: 9000, exciteHp: 400, gain: 0.14 + tier * 0.05, offset: Math.round(0.06 * sr) }, rng);
  }
  const L = sig.data[0], R = sig.data[1];
  if (tier >= 3) {
    granularShimmer(mono, L, R, sr, { grainMs: 70, overlap: 3, ratios: [2, 3], gain: 0.12 * tier, jitter: 0.5, spread: 0.8, feedback: 0.3, tail: 0.4 }, rng);
  }
  for (let i = 0; i < mono.length; i++) { L[i] += mono[i]; R[i] += mono[i] * 0.95; }
  normalizePeak(sig, 0.8);
  return sig;
}

function buildPlayer(sr, rng, variant, kind) {
  switch (kind) {
    case 'dash': {
      // A short cloth-and-air whoosh with a sub push, plus the shadow signature
      // because the player's dash is a shadow-step.
      const sig = Sig.seconds(sr, 0.5, 2);
      const mono = new Float32Array(sig.length);
      noiseBurst(mono, sr, { f0: 600, f1: 3200, q: 1.1, attack: 0.004, decay: 0.09, duration: 0.3, gain: 0.55, colour: 'pink', sweepCurve: 0.7 }, rng);
      sweepTone(mono, sr, { f0: 90, f1: 42, duration: 0.22, attack: 0.002, decay: 0.1, gain: 0.4, pitchCurve: 2 });
      const L = sig.data[0], R = sig.data[1];
      granularShimmer(mono, L, R, sr, { grainMs: 50, overlap: 3, ratios: [2, 3], gain: 0.18, jitter: 0.6, spread: 1.0, feedback: 0.2, tail: 0.2 }, rng);
      for (let i = 0; i < mono.length; i++) { L[i] += mono[i]; R[i] += mono[i] * 0.95; }
      normalizePeak(sig, 0.75);
      return sig;
    }
    case 'hurt': {
      // A grunt plus the armour taking the blow.
      const sig = buildVocalisation(sr, rng, 'knight', 'hurt', 1.0);
      const bank = new ModalBank(3);
      bank.set(0, 1400, 0.12, 1, sr);
      bank.set(1, 2470, 0.08, 0.5, sr);
      bank.set(2, 3910, 0.05, 0.25, sr);
      modalHit(sig.data[0], sr, bank, { contact: 0.0007, exciteLp: 12000, exciteHp: 600, gain: 0.45 }, rng);
      normalizePeak(sig, 0.9);
      return sig;
    }
    case 'death':
    default: {
      const sig = Sig.seconds(sr, 2.2, 2);
      const mono = new Float32Array(sig.length);
      const vox = buildVocalisation(sr, rng, 'knight', 'death', 1.0);
      addInto(mono, vox.data[0], 0.9, 0);
      sweepTone(mono, sr, { f0: 70, f1: 24, duration: 1.6, attack: 0.02, decay: 1.1, gain: 0.55, pitchCurve: 1.6, drive: 1.8 });
      // The world dropping away: a long descending noise band.
      noiseBurst(mono, sr, { f0: 2600, f1: 180, q: 0.9, attack: 0.05, decay: 1.0, duration: 2.0, gain: 0.3, colour: 'pink', sweepCurve: 1.4 }, rng);
      const L = sig.data[0], R = sig.data[1];
      for (let i = 0; i < mono.length; i++) { L[i] += mono[i]; R[i] += mono[i] * 0.94; }
      normalizePeak(sig, 0.9);
      return sig;
    }
  }
}

/* ================================================================== */
/* 7. Ambience one-shots and music percussion                         */
/* ================================================================== */

function buildAmbience(sr, rng, variant, kind) {
  switch (kind) {
    case 'drip': {
      // A water drop is a bubble oscillation: a short sine whose pitch RISES
      // sharply. Everyone's first attempt is a falling pitch and it sounds wrong.
      const sig = Sig.seconds(sr, 0.35, 1);
      const f = 620 + rng.float() * 1500;
      sweepTone(sig.data[0], sr, { f0: f, f1: f * (1.7 + rng.float() * 0.8), duration: 0.09, attack: 0.0008, decay: 0.035, gain: 0.8, pitchCurve: 0.55 });
      noiseBurst(sig.data[0], sr, { f0: 4200, f1: 2400, q: 1.6, attack: 0.0004, decay: 0.008, duration: 0.04, gain: 0.25 }, rng);
      normalizePeak(sig, 0.75);
      return sig;
    }
    case 'settle': {
      // Distant stone shifting: a low grinding rumble with grit.
      const sig = Sig.seconds(sr, 1.6, 1);
      const out = sig.data[0];
      noiseBurst(out, sr, { f0: 220, f1: 90, q: 1.1, attack: 0.06, decay: 0.5, duration: 1.4, gain: 0.6, colour: 'brown' }, rng);
      const grains = 14 + (rng.u32() % 12);
      for (let i = 0; i < grains; i++) {
        const at = Math.round(rng.range(0.02, 1.0) * sr);
        const bank = new ModalBank(2);
        const f = 300 + rng.float() * 700;
        bank.set(0, f, 0.05, 1, sr);
        bank.set(1, f * 1.9, 0.03, 0.4, sr);
        modalHit(out, sr, bank, { contact: 0.001, exciteLp: 5000, exciteHp: 120, gain: 0.06 + rng.float() * 0.1, offset: at }, rng);
      }
      normalizePeak(sig, 0.6);
      return sig;
    }
    case 'crackle': {
      // Brazier: a burst of tiny resonant pops over a breath of noise.
      const sig = Sig.seconds(sr, 1.1, 1);
      const out = sig.data[0];
      noiseBurst(out, sr, { f0: 900, f1: 500, q: 0.6, attack: 0.05, decay: 0.5, duration: 1.05, gain: 0.22, colour: 'pink' }, rng);
      const pops = 20 + (rng.u32() % 22);
      for (let i = 0; i < pops; i++) {
        const at = Math.round(rng.range(0, 0.95) * sr);
        const bank = new ModalBank(1);
        bank.set(0, 1100 + rng.float() * 4200, 0.008 + rng.float() * 0.02, 1, sr);
        modalHit(out, sr, bank, { contact: 0.0004, exciteLp: 16000, exciteHp: 900, gain: 0.1 + rng.float() * 0.25, offset: at }, rng);
      }
      normalizePeak(sig, 0.6);
      return sig;
    }
    case 'howl': {
      // Wind finding a gap in the masonry: a slow formant sweep on filtered noise.
      const sig = Sig.seconds(sr, 3.4, 2);
      const mono = new Float32Array(sig.length);
      const noise = new Noise(rng);
      const svf = new SVF();
      const env = new Breakpoint([[0, 0], [1.1, 1, 1.6], [2.2, 0.7], [3.4, 0, 1.4]]);
      const n = mono.length;
      let wander = 0, f = 300, e = 0;
      for (let i = 0; i < n; i++) {
        wander = wander * 0.9995 + noise.white() * 0.0005;
        // The gust's centre frequency is a sub-hertz signal; sampling it at
        // control rate keeps the SVF coefficients (and their Math.sin) cached.
        if ((i % CONTROL_BLOCK) === 0) {
          const t = i / sr;
          f = 300 + Math.sin(t * 0.9) * 130 + wander * 4000 + t * 40;
          e = env.at(t);
        }
        svf.process(noise.pink() * 4, f, 3.2, sr);
        mono[i] = svf.band * e;
      }
      // 21 ms of Haas offset: wide enough that the gust wraps around the head,
      // short enough that it never separates into two events.
      const L = sig.data[0], R = sig.data[1];
      const d = Math.round(0.021 * sr);
      for (let i = 0; i < n; i++) { L[i] = mono[i]; R[i] = (i >= d ? mono[i - d] : 0) * 0.9; }
      normalizePeak(sig, 0.5);
      return sig;
    }
    case 'chain':
    default:
      return buildFoley(sr, rng, variant, 'chain');
  }
}

/** Percussion for the adaptive score. Built here so the music layer can stay
 *  about arrangement rather than synthesis. */
function buildDrum(sr, rng, variant, kind) {
  switch (kind) {
    case 'kick': {
      const sig = Sig.seconds(sr, 0.7, 1);
      sweepTone(sig.data[0], sr, { f0: 132, f1: 41, duration: 0.5, attack: 0.001, decay: 0.19, gain: 0.95, pitchCurve: 3.2, drive: 1.9 });
      noiseBurst(sig.data[0], sr, { f0: 2600, f1: 900, q: 0.8, attack: 0.0002, decay: 0.008, duration: 0.05, gain: 0.22 }, rng);
      normalizePeak(sig, 0.95);
      return sig;
    }
    case 'taiko': {
      // A big skin drum: a low membrane mode pair plus a body thump.
      const sig = Sig.seconds(sr, 1.0, 1);
      const bank = new ModalBank(4);
      const f = 78 * (1 + rng.signed() * 0.03);
      // Membrane modes are Bessel ratios, not harmonics — that is what makes a
      // drum a drum instead of a bass note.
      const ratios = [1, 1.593, 2.135, 2.917];
      for (let m = 0; m < 4; m++) bank.set(m, f * ratios[m], 0.42 - m * 0.07, 1 / (1 + m * 0.9), sr);
      modalHit(sig.data[0], sr, bank, { contact: 0.0035, exciteLp: 2400, exciteHp: 40, gain: 0.9 }, rng);
      noiseBurst(sig.data[0], sr, { f0: 1400, f1: 500, q: 0.7, attack: 0.0006, decay: 0.03, duration: 0.15, gain: 0.28 }, rng);
      normalizePeak(sig, 0.92);
      return sig;
    }
    case 'tom': {
      const sig = Sig.seconds(sr, 0.6, 1);
      const bank = new ModalBank(3);
      const f = 148 * (1 + rng.signed() * 0.04);
      const ratios = [1, 1.593, 2.135];
      for (let m = 0; m < 3; m++) bank.set(m, f * ratios[m], 0.3 - m * 0.06, 1 / (1 + m), sr);
      modalHit(sig.data[0], sr, bank, { contact: 0.0022, exciteLp: 3400, exciteHp: 60, gain: 0.8 }, rng);
      normalizePeak(sig, 0.85);
      return sig;
    }
    case 'metal': {
      // A struck anvil / chain hit for the combat layer's off-beats.
      const sig = Sig.seconds(sr, 1.3, 1);
      const bank = new ModalBank(6);
      const f = 1180 * (1 + rng.signed() * 0.05);
      const ratios = [1, 1.71, 2.39, 3.11, 4.37, 6.02];
      for (let m = 0; m < 6; m++) bank.set(m, f * ratios[m], 0.9 - m * 0.11, 1 / (1 + m * 0.7), sr);
      modalHit(sig.data[0], sr, bank, { contact: 0.0007, exciteLp: 16000, exciteHp: 500, gain: 0.75 }, rng);
      normalizePeak(sig, 0.8);
      return sig;
    }
    case 'shaker':
    default: {
      const sig = Sig.seconds(sr, 0.22, 1);
      noiseBurst(sig.data[0], sr, { f0: 7200, f1: 4200, q: 1.1, attack: 0.0008, decay: 0.035, duration: 0.18, gain: 0.6 }, rng);
      normalizePeak(sig, 0.55);
      return sig;
    }
  }
}

/* ================================================================== */
/* 8. Recipe registry                                                 */
/* ================================================================== */

/**
 * Build the full recipe map. Names follow `cues.js`'s vocabulary exactly; a cue
 * that resolves in `cues.js` but has no recipe here is a bug, and `selfTest`
 * checks for exactly that.
 */
function buildRecipeMap() {
  const r = new Map();
  const add = (name, build, opts = {}) => r.set(name, { build, variants: opts.variants ?? 0, heavy: !!opts.heavy });

  // impacts: 6 weapons x 12 surfaces
  for (const w of WEAPON_CLASSES) {
    for (const s of SURFACES) {
      add(`hit.${w}.${s}`, (sr, rng, v) => buildImpact(sr, rng, v, w, s));
    }
    add(`swing.${w}`, (sr, rng, v) => buildSwing(sr, rng, v, w));
  }
  // footsteps: walk + run per surface
  for (const s of SURFACES) {
    add(`foot.${s}`, (sr, rng, v) => buildFootstep(sr, rng, v, s, false));
    add(`foot.${s}.run`, (sr, rng, v) => buildFootstep(sr, rng, v, s, true));
  }
  for (const k of ['armour', 'chain', 'cloth', 'leather']) {
    add(`foley.${k}`, (sr, rng, v) => buildFoley(sr, rng, v, k));
  }
  // magic
  for (const e of ELEMENT_NAMES) {
    add(`magic.cast.${e}`, (sr, rng, v) => buildMagicCast(sr, rng, v, e));
    add(`magic.impact.${e}`, (sr, rng, v) => buildMagicImpact(sr, rng, v, e));
    add(`magic.explosion.${e}`, (sr, rng, v) => buildExplosion(sr, rng, v, e), { heavy: true, variants: 2 });
  }
  // shadow signatures
  add('shadow.extract', buildShadowExtract, { heavy: true, variants: 2 });
  add('shadow.arise', buildShadowArise, { variants: 2 });
  // The signature cue. One variant only — it is a fixed piece of music, and
  // hearing a different ARISE each time would rob it of its identity. Heavy, so
  // it goes through the background queue and never stalls a frame.
  add('arise.cue', (sr, rng) => buildAriseCue(sr, rng), { heavy: true, variants: 1 });
  // ui
  for (const k of ['hover', 'click', 'error', 'skillready', 'system', 'levelup']) {
    add(`ui.${k}`, (sr, rng, v) => buildUi(sr, rng, v, k), { variants: k === 'levelup' || k === 'system' ? 1 : 0 });
  }
  // loot
  for (const k of ['common', 'magic', 'rare', 'legendary', 'mythic']) {
    add(`loot.drop.${k}`, (sr, rng, v) => buildLoot(sr, rng, v, k), { variants: 2 });
  }
  add('loot.pickup', (sr, rng, v) => buildLoot(sr, rng, v, 'magic'), { variants: 2 });
  // player
  for (const k of ['dash', 'hurt', 'death']) {
    add(`player.${k}`, (sr, rng, v) => buildPlayer(sr, rng, v, k), { heavy: k === 'death' });
  }
  add('player.levelup', (sr, rng, v) => buildUi(sr, rng, v, 'levelup'), { variants: 1, heavy: true });
  // ambience
  for (const k of ['drip', 'settle', 'crackle', 'howl', 'chain']) {
    add(`amb.${k}`, (sr, rng, v) => buildAmbience(sr, rng, v, k), { heavy: k === 'howl' });
  }
  // music percussion
  for (const k of ['kick', 'taiko', 'tom', 'metal', 'shaker']) {
    add(`music.${k}`, (sr, rng, v) => buildDrum(sr, rng, v, k));
  }
  // enemy vocalisations
  for (const a of ARCHETYPES) {
    for (const k of ['growl', 'shriek', 'attack', 'alert', 'hurt', 'death']) {
      add(`vox.${a}.${k}`, (sr, rng, v) => buildVocalisation(sr, rng, a, k, 1), { heavy: k === 'death' });
    }
  }
  return r;
}

/** Cheap deterministic string hash — seeds the per-cue RNG so a cue's waveform
 *  depends only on its name and variant, never on bake order. */
function hashName(s, variant) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= variant * 0x9e3779b9;
  return h >>> 0;
}

export class SoundBank {
  /**
   * @param sampleRate the AudioContext's rate; buffers baked at any other rate
   *                   would be resampled on every playback.
   * @param rng        a forked deterministic stream owned by the caller
   * @param budget     from quality.js
   * @param audioCtx   used only to wrap Sigs as AudioBuffers; may be null while
   *                   the context has not started, in which case `get` returns
   *                   the raw Sig and the caller does not play it.
   */
  constructor(sampleRate, rng, budget, audioCtx = null) {
    this.sr = sampleRate;
    this.rng = rng;
    this.scratch = rng.fork();
    this.budget = budget;
    this.ac = audioCtx;
    this.recipes = buildRecipeMap();
    /** name|variant -> { sig, buffer } */
    this.cache = new Map();
    this.queue = [];
    this.queued = new Set();
    this.bytes = 0;
    this.bakeCount = 0;
    this.bakeMs = 0;
    this.missing = 0;
  }

  has(name) { return this.recipes.has(name); }

  /** Number of variants for a cue, capped by the quality budget. */
  variantsOf(name) {
    const rec = this.recipes.get(name);
    if (!rec) return 0;
    return Math.max(1, Math.min(rec.variants || this.budget.variants, this.budget.variants));
  }

  /**
   * Fetch a baked variation. Bakes inline unless the recipe is `heavy`, in which
   * case it is queued and null is returned — the caller then either plays a
   * lighter substitute or skips the sound entirely for one occurrence.
   */
  get(name, variant = 0) {
    const rec = this.recipes.get(name);
    if (!rec) { this.missing++; return null; }
    const v = variant % this.variantsOf(name);
    const key = `${name}|${v}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (rec.heavy) { this.enqueue(name, v); return null; }
    return this._bake(name, v, rec);
  }

  /** Queue a bake without needing the result now. */
  enqueue(name, variant = 0) {
    const rec = this.recipes.get(name);
    if (!rec) return false;
    const v = variant % this.variantsOf(name);
    const key = `${name}|${v}`;
    if (this.cache.has(key) || this.queued.has(key)) return false;
    this.queued.add(key);
    this.queue.push({ name, variant: v, rec, key });
    return true;
  }

  /**
   * Queue variants of a cue. `max` caps how many — the pre-warm list asks for two
   * rather than the full four, because two variations are enough that the first
   * few seconds of combat do not sound repetitive, and the other two bake on
   * demand later for a third of the up-front memory and bake time.
   */
  enqueueAll(name, max = Infinity) {
    const n = Math.min(this.variantsOf(name), max);
    for (let v = 0; v < n; v++) this.enqueue(name, v);
  }

  _bake(name, variant, rec) {
    const t0 = performance.now();
    // Reseeding the scratch stream by name+variant makes every waveform a pure
    // function of its identity — reproducible across sessions and bake orders.
    this.scratch.seed(hashName(name, variant));
    let sig;
    try {
      sig = rec.build(this.sr, this.scratch, variant);
    } catch (err) {
      console.warn(`[audio] recipe "${name}" failed to bake`, err);
      return null;
    }
    const entry = { sig, buffer: null, name, variant };
    if (this.ac) {
      try { entry.buffer = sig.toAudioBuffer(this.ac); } catch { entry.buffer = null; }
    }
    this.cache.set(`${name}|${variant}`, entry);
    this.bytes += sig.bytes;
    this.bakeCount++;
    this.bakeMs += performance.now() - t0;
    if (this.bytes > this.budget.bakeBytesMax) this._evict();
    return entry;
  }

  /**
   * Evict the least recently baked non-essential entries. In practice this never
   * fires — the whole bank is ~20 MB at ultra — but a level that cycles through
   * every surface and archetype should degrade rather than grow without bound.
   */
  _evict() {
    const keep = /^(ui\.|player\.|arise|music\.|shadow\.)/;
    for (const [key, entry] of this.cache) {
      if (keep.test(entry.name)) continue;
      this.cache.delete(key);
      this.bytes -= entry.sig.bytes;
      if (this.bytes <= this.budget.bakeBytesMax * 0.8) break;
    }
  }

  /**
   * Drain the queue for at most `ms` milliseconds. Called from update(); the
   * budget is what keeps a background bake from ever costing a frame.
   */
  pump(ms) {
    if (!this.queue.length) return 0;
    const t0 = performance.now();
    let n = 0;
    while (this.queue.length && performance.now() - t0 < ms) {
      const job = this.queue.shift();
      this.queued.delete(job.key);
      if (!this.cache.has(job.key)) this._bake(job.name, job.variant, job.rec);
      n++;
    }
    return n;
  }

  /** Called once the AudioContext exists, to wrap everything baked before it. */
  attachContext(audioCtx) {
    this.ac = audioCtx;
    for (const entry of this.cache.values()) {
      if (!entry.buffer) {
        try { entry.buffer = entry.sig.toAudioBuffer(audioCtx); } catch { /* ignore */ }
      }
    }
  }

  stats() {
    return {
      recipes: this.recipes.size,
      baked: this.cache.size,
      queued: this.queue.length,
      megabytes: +(this.bytes / (1 << 20)).toFixed(2),
      bakeMs: +this.bakeMs.toFixed(1),
      avgBakeMs: this.bakeCount ? +(this.bakeMs / this.bakeCount).toFixed(2) : 0,
      missing: this.missing,
    };
  }

  dispose() {
    this.cache.clear();
    this.queue.length = 0;
    this.queued.clear();
    this.bytes = 0;
  }
}

export { VOCAL_ARCHETYPES };
