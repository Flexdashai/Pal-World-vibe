/**
 * arise.js — the ARISE cue.
 *
 * This is the signature audio moment of MONARCH: the instant the player claims a
 * corpse and an army answers. It is the one sound in the game allowed to take
 * over the entire mix, and it is built as a piece of music rather than as a sound
 * effect, in four parts:
 *
 *   0.00 - 2.55  REVERSED SWELL. Built forwards as a bright decaying wash and
 *                then reversed, so its amplitude *accelerates* into the drop. The
 *                ear cannot predict where a reversed envelope ends, which is
 *                precisely why every trailer in existence uses one.
 *   1.00 - 2.55  ACCELERATING PULSE. Eight sub impacts whose spacing shrinks
 *                geometrically. This is the part that tells the listener a
 *                specific moment is coming without telling them when.
 *   2.46 - 2.55  THE GAP. Ninety milliseconds of near-silence. A drop into a full
 *                mix is loud; a drop out of a hole is *violent*. This costs
 *                nothing and doubles the impact.
 *   2.55 - 6.20  THE DROP. A 96 → 24 Hz sub sweep with heavy drive, a broadband
 *                crack, a struck-cathedral modal boom, a six-voice choir cluster
 *                on a D-Aeolian stack, and granular violet shimmer climbing two
 *                octaves above it.
 *
 * The choir is real formant synthesis (see vocal.js), not a filtered saw. The
 * shimmer is the same granular engine that gives shadow magic its violet, an
 * octave and a twelfth up with feedback — so the biggest moment in the game is
 * made of the same material as its smallest spell, which is what makes it feel
 * like the same world rather than a licensed stinger.
 */

import {
  Sig, Noise, ModalBank, Osc, Biquad, SVF, PercEnv, CONTROL_BLOCK,
  modalHit, noiseBurst, sweepTone, granularShimmer, karplus,
  normalizePeak, softLimit, fadeOut, addInto, reverseArray, clamp,
} from './dsp.js';
import { buildChoirCluster } from './vocal.js';
import { timbreFor } from './cues.js';

/** D Aeolian stack: D2 A2 D3 F3 Bb3 C4. Minor with a flat sixth and a flat
 *  seventh — no leading tone anywhere, so it never resolves and never lifts. */
const CHOIR_CHORD = [73.42, 110.0, 146.83, 174.61, 233.08, 261.63];

const DROP_AT = 2.55;
const TOTAL = 6.4;

export function buildAriseCue(sampleRate, rng) {
  const sr = sampleRate;
  const T = timbreFor('shadow');
  const sig = Sig.seconds(sr, TOTAL, 2);
  const L = sig.data[0], R = sig.data[1];
  const mono = new Float32Array(sig.length);
  const noise = new Noise(rng);
  const dropN = Math.round(DROP_AT * sr);

  /* ================================================================ */
  /* 1. Reversed swell                                                */
  /* ================================================================ */
  {
    const swellSec = 2.55;
    const swell = new Float32Array(Math.round(swellSec * sr));
    // Forward material: a long bright decay. Three components so the reversal has
    // internal detail rather than being one smooth ramp.
    noiseBurst(swell, sr, {
      f0: 9000, f1: 700, q: 0.8, attack: 0.001, decay: 0.95,
      duration: swellSec, gain: 0.5, colour: 'white', sweepCurve: 1.4,
    }, rng);
    // A struck cathedral bell, decaying — reversed, it becomes a bell being
    // *un*-struck, which is an unnatural sound the ear leans into.
    const bell = new ModalBank(6);
    const bf = 146.83;
    const ratios = [1, 2.0, 2.76, 3.94, 5.42, 7.11];
    for (let m = 0; m < 6; m++) bell.set(m, bf * ratios[m], 2.4 - m * 0.28, 1 / (1 + m * 0.55), sr);
    modalHit(swell, sr, bell, { contact: 0.0015, exciteLp: 9000, exciteHp: 120, gain: 0.12 }, rng);
    // A rising saw riser in the forward domain becomes a *falling* one reversed,
    // so it is built already inverted: it descends forwards to ascend backwards.
    {
      const osc = new Osc(sr, 0);
      const filt = new SVF();
      const n = swell.length;
      // Control-rate pitch, cutoff and envelope: three Math.pow calls per sample
      // over 122 000 samples is ~10 ms of pure transcendental, and none of these
      // three signals has any content above a few hertz.
      let f = 420, cut = 5460, env = 1;
      for (let i = 0; i < n; i++) {
        if ((i % CONTROL_BLOCK) === 0) {
          const t = i / n;
          f = 420 * Math.pow(0.28, t);
          cut = 260 + (1 - t) * 5200;
          env = Math.pow(1 - t, 1.3) * 0.22;
        }
        osc.step(f);
        filt.process(osc.saw(), cut, 1.4, sr);
        swell[i] += filt.band * env;
      }
    }
    reverseArray(swell);
    // The reversal leaves a hard edge at the very end (what was the attack); fade
    // the last 25 ms so it hands over to the gap cleanly.
    const edge = Math.round(0.025 * sr);
    for (let i = 0; i < edge; i++) swell[swell.length - 1 - i] *= i / edge;
    // Normalise the swell to a fixed 0.38 of full scale before mixing it in. The
    // whole cue lives or dies on the drop being *much* louder than everything
    // before it, and leaving the swell's level to fall out of three independently
    // tuned layer gains meant it arrived within 0.2 dB of the drop and the cue
    // had no dynamic at all. Measured target: swell RMS ~0.10, drop RMS ~0.55.
    let sp = 0;
    for (let i = 0; i < swell.length; i++) { const v = swell[i] < 0 ? -swell[i] : swell[i]; if (v > sp) sp = v; }
    addInto(mono, swell, sp > 1e-6 ? 0.38 / sp : 1, 0);
  }

  /* ================================================================ */
  /* 2. Accelerating pulse                                            */
  /* ================================================================ */
  {
    // Geometric spacing: each gap is 0.68 of the previous, so the last four
    // impacts land inside 300 ms and the body reads it as a rising heartbeat.
    let gap = 0.42;
    let t = DROP_AT - 1.55;
    for (let k = 0; k < 9 && t < DROP_AT - 0.1; k++) {
      const at = Math.round(t * sr);
      const g = 0.18 + k * 0.055;
      sweepTone(mono, sr, {
        f0: 104, f1: 46, duration: 0.24, attack: 0.001, decay: 0.09,
        gain: g, offset: at, pitchCurve: 2.6, drive: 1.7,
      });
      noiseBurst(mono, sr, {
        f0: 3400, f1: 1200, q: 0.9, attack: 0.0003, decay: 0.01,
        duration: 0.06, gain: g * 0.5, offset: at,
      }, rng);
      t += gap;
      gap *= 0.68;
    }
  }

  /* ================================================================ */
  /* 4. The drop                                                      */
  /* ================================================================ */

  /* 4a. transient — broadband crack plus a struck-room boom */
  noiseBurst(mono, sr, {
    f0: 11000, f1: 2200, q: 0.6, attack: 0.0002, decay: 0.016,
    duration: 0.14, gain: 0.85, offset: dropN,
  }, rng);
  {
    const boom = new ModalBank(5);
    // Low inharmonic modes: the whole crypt being struck like a drum.
    const bm = [41.2, 63.7, 97.3, 148.1, 226.4];
    for (let m = 0; m < 5; m++) boom.set(m, bm[m], 1.8 - m * 0.22, 1 / (1 + m * 0.7), sr);
    modalHit(mono, sr, boom, { contact: 0.004, exciteLp: 1800, exciteHp: 25, gain: 0.3, offset: dropN }, rng);
  }

  /* 4b. the sub drop — the reason the cue exists */
  sweepTone(mono, sr, {
    f0: 96, f1: 24, duration: 2.4, attack: 0.002, decay: 1.5,
    gain: 1.0, offset: dropN, pitchCurve: 2.4, drive: 2.6, fm: 0.02, fmRatio: 0.5,
  });
  // A second sub an octave up, dropping slightly later. Two-stage drops read as
  // much deeper than one because the ear tracks the interval, not the absolute.
  sweepTone(mono, sr, {
    f0: 192, f1: 48, duration: 1.8, attack: 0.004, decay: 0.9,
    gain: 0.42, offset: dropN + Math.round(0.035 * sr), pitchCurve: 2.8, drive: 2.0,
  });

  /* 4c. the roar bed under the choir */
  {
    const svf = new SVF();
    const env = new PercEnv(sr, 0.02, 1.9, 1);
    const n = Math.min(Math.round(3.2 * sr), mono.length - dropN);
    let f = 2710;
    for (let i = 0; i < n; i++) {
      // Control rate again, and this one matters twice over: holding `f` steady
      // for 32 samples also keeps the SVF's memoised coefficients valid, so the
      // Math.sin inside the filter is skipped too.
      if ((i % CONTROL_BLOCK) === 0) f = 2600 * Math.pow(0.1, i / n) + 110;
      svf.process(noise.brown() * 1.4 + noise.white() * 0.35, f, 0.85, sr);
      mono[dropN + i] += svf.low * env.next() * 0.4;
    }
  }

  /* 4d. debris and chain — the room reacting */
  for (let d = 0; d < 26; d++) {
    const at = dropN + Math.round(rng.range(0.02, 1.5) * sr);
    if (at >= mono.length - 64) continue;
    const bank = new ModalBank(2);
    const f = 320 + rng.float() * 1700;
    bank.set(0, f, 0.06 + rng.float() * 0.1, 1, sr);
    bank.set(1, f * 1.77, 0.04, 0.4, sr);
    modalHit(mono, sr, bank, { contact: 0.0008, exciteLp: 11000, exciteHp: 260, gain: 0.015 + rng.float() * 0.035, offset: at }, rng);
  }
  for (let c = 0; c < 5; c++) {
    karplus(mono, sr, 900 + rng.float() * 1800, {
      decay: 0.991, damp: 0.2, gain: 0.05 + rng.float() * 0.07,
      offset: dropN + Math.round(rng.range(0.05, 1.1) * sr), duration: 0.9, stretch: 0.02,
    }, rng);
  }

  /* ================================================================ */
  /* 5. Stereo: shimmer, then the choir on top                        */
  /* ================================================================ */
  granularShimmer(mono, L, R, sr, {
    grainMs: 95, overlap: 4, ratios: [2, 3], gain: 0.34 * (0.6 + T.grain * 0.4),
    jitter: 0.55, spread: 1.0, feedback: 0.48, tail: 1.2,
  }, rng);
  for (let i = 0; i < mono.length; i++) { L[i] += mono[i]; R[i] += mono[i] * 0.97; }

  /* the choir — entering exactly on the drop, swelling over 900 ms */
  {
    const choir = buildChoirCluster(sr, rng, CHOIR_CHORD, {
      duration: Math.min(3.6, TOTAL - DROP_AT), attack: 0.9, release: 1.3,
      // Two singers per note across six notes is twelve voices — enough spread
      // that it reads as a section, cheap enough to bake without a hitch.
      vowel: 'o', tract: 0.78, voices: 2, gain: 0.62, breath: 0.22, swell: 1.7, detune: 18,
    });
    // High-pass the choir at 120 Hz so it never competes with the sub. The chord's
    // bottom note is D2; its fundamental is deliberately sacrificed to the drop
    // and the ear restores it from the upper partials anyway.
    const hpL = new Biquad().setHighpass(120, 0.7, sr);
    const hpR = new Biquad().setHighpass(120, 0.7, sr);
    const cn = Math.min(choir.length, sig.length - dropN);
    for (let i = 0; i < cn; i++) {
      L[dropN + i] += hpL.process(choir.data[0][i]) * 0.9;
      R[dropN + i] += hpR.process(choir.data[1][i]) * 0.9;
    }
    // Shimmer the choir too, one octave up only — this is the violet halo that
    // sits above the voices and it is what makes it read as *shadow* magic.
    const choirMono = new Float32Array(cn);
    for (let i = 0; i < cn; i++) choirMono[i] = (choir.data[0][i] + choir.data[1][i]) * 0.5;
    const shL = new Float32Array(sig.length), shR = new Float32Array(sig.length);
    granularShimmer(choirMono, shL, shR, sr, {
      grainMs: 120, overlap: 3, ratios: [2], gain: 0.22,
      jitter: 0.4, spread: 0.95, feedback: 0.35, tail: 0.9, offset: dropN,
    }, rng);
    for (let i = 0; i < sig.length; i++) { L[i] += shL[i]; R[i] += shR[i]; }
  }

  /* ================================================================ */
  /* 6. THE GAP                                                       */
  /* ================================================================ */
  // Applied here, at the very end, and to the mixed stereo — not to `mono`
  // before the shimmer runs. The granular shimmer has a 1.2 s tail and 48%
  // feedback, so grains launched during the build spill straight across the gap
  // and refill it; ducking the source did nothing measurable (the gap measured
  // -3.7 dB instead of the intended -24). Ducking the output is unambiguous.
  {
    const gapN = Math.round(0.09 * sr);
    const rampN = Math.round(0.03 * sr);
    for (let i = 0; i < gapN; i++) {
      const idx = dropN - gapN + i;
      if (idx < 0 || idx >= sig.length) continue;
      // Ramped, not gated: a hard gate is a click, a 30 ms ramp is a held breath.
      const k = i < rampN ? clamp(1 - (i / rampN) * 0.94, 0.06, 1) : 0.06;
      L[idx] *= k;
      R[idx] *= k;
    }
  }

  fadeOut(L, Math.round(0.35 * sr), 1.6);
  fadeOut(R, Math.round(0.35 * sr), 1.6);
  // Gentle limiting only: at 1.25 the whole cue was crushed to an RMS of 0.7,
  // which is nearly a square wave and left the drop no louder than the build.
  softLimit(sig, 1.0);
  normalizePeak(sig, 0.985);
  return sig;
}

/** When the drop lands, relative to the start of the buffer. The mixer schedules
 *  its duck and the reverb bloom against this, and `fx` could use it too. */
export const ARISE_DROP_TIME = DROP_AT;
export const ARISE_DURATION = TOTAL;
