/**
 * vocal.js — enemy vocalisations by formant synthesis.
 *
 * Everything that has a throat in this game gets its voice from the same source
 * model, because that is what makes a crypt full of different monsters sound like
 * one world rather than a sample pack:
 *
 *   excitation → jitter/subharmonics → formant bank → chest resonance → shaping
 *
 * The parts that do the work:
 *
 * ROSENBERG GLOTTAL PULSE. A sawtooth through a formant filter sounds like a
 * synthesiser playing a vowel. A real glottis opens slowly and slams shut, and
 * that asymmetric pulse is what gives a voice its buzz and its body.
 *
 * JITTER AND SHIMMER. Cycle-to-cycle perturbation of period (jitter) and
 * amplitude (shimmer). A perfectly periodic voice reads as synthetic instantly;
 * 2-4% jitter reads as "rough", 8%+ as "wrong with it", which is exactly what a
 * ghoul should be.
 *
 * SUBHARMONICS. Alternating pulse amplitude halves the effective period, adding
 * an octave-down component (diplophonia). It is what real large predators do to
 * sound larger, and it is why the beast archetype is terrifying at a pitch a
 * human could produce.
 *
 * VOCAL TRACT LENGTH. Formants scale inversely with tract length. Scaling *all*
 * formants by 0.7 makes a big animal; dropping only the pitch makes a small
 * animal on a slowed-down tape, which everyone can hear.
 */

import {
  Sig, Noise, Biquad, FormantBank, VOWELS, Resonator, Osc, CONTROL_BLOCK,
  glottalPulse, noiseBurst, normalizePeak, normalizeRms, softLimit, fadeOut,
  fastTanh, resampleLinear, clamp,
} from './dsp.js';

/**
 * Per-archetype voice.
 *   f0        base pitch in Hz
 *   tract     formant scale — < 1 is a longer tract, i.e. a bigger creature
 *   jitter    cycle-to-cycle period perturbation, fraction
 *   shimmer   cycle-to-cycle amplitude perturbation, fraction
 *   sub       subharmonic depth 0..1 (period doubling)
 *   breath    aspiration noise mixed into the excitation
 *   drive     waveshaper drive on the output — chest compression
 *   chest     resonant body frequency; big creatures resonate low
 *   vowels    [start, end] morph pair, from dsp.VOWELS
 *   rasp      high-frequency irregular noise burst density (a wet throat)
 */
export const VOCAL_ARCHETYPES = {
  // The default mid-sized humanoid undead. Dry, papery, mid pitch.
  ghoul: { f0: 96, tract: 0.94, jitter: 0.055, shimmer: 0.16, sub: 0.35, breath: 0.35, drive: 1.9, chest: 190, vowels: ['gr', 'a'], rasp: 0.5, dur: 1.0 },
  // Armoured revenant: lower, hollow, filtered by a helm — narrow and boxy.
  knight: { f0: 74, tract: 0.86, jitter: 0.03, shimmer: 0.1, sub: 0.45, breath: 0.22, drive: 2.4, chest: 150, vowels: ['o', 'gr'], rasp: 0.25, dur: 1.0 },
  // Large quadruped: heavy subharmonics, long tract, a real roar.
  beast: { f0: 58, tract: 0.62, jitter: 0.07, shimmer: 0.2, sub: 0.85, breath: 0.4, drive: 3.4, chest: 92, vowels: ['gr', 'o'], rasp: 0.7, dur: 1.25 },
  // Incorporeal: high, thin, almost no chest, heavy breath, strained formants.
  wraith: { f0: 168, tract: 1.22, jitter: 0.09, shimmer: 0.3, sub: 0.1, breath: 0.8, drive: 1.3, chest: 420, vowels: ['sc', 'i'], rasp: 0.85, dur: 1.15 },
  // The player's own shadow soldiers: the ghoul model dropped an octave, smooth.
  shade: { f0: 62, tract: 0.8, jitter: 0.02, shimmer: 0.08, sub: 0.6, breath: 0.3, drive: 1.6, chest: 120, vowels: ['u', 'gr'], rasp: 0.15, dur: 1.1 },
  // Boss: everything turned up. Longest tract in the game, deepest chest.
  boss: { f0: 44, tract: 0.5, jitter: 0.06, shimmer: 0.18, sub: 1.0, breath: 0.45, drive: 4.2, chest: 66, vowels: ['gr', 'a'], rasp: 0.6, dur: 1.8 },
};

/**
 * Per-utterance shape. `contour` is the f0 multiplier over normalised time,
 * `amp` the amplitude envelope, `open` the vowel morph position, and `aperiodic`
 * how much the source degenerates into noise by the end (the death rattle).
 */
const UTTERANCES = {
  growl: {
    dur: 1.15, contour: [[0, 0.92], [0.25, 1.0], [1, 0.84]], amp: [[0, 0], [0.12, 1, 1.5], [0.75, 0.9], [1, 0, 1.6]],
    morph: [[0, 0], [1, 0.25]], aperiodic: 0.1, attack: 0.05, bright: 0.85, gain: 0.9,
  },
  shriek: {
    dur: 1.0, contour: [[0, 1.4], [0.15, 2.35], [0.55, 2.2], [1, 1.5]], amp: [[0, 0], [0.06, 1, 0.7], [0.6, 0.85], [1, 0, 1.4]],
    morph: [[0, 0.6], [1, 1]], aperiodic: 0.3, attack: 0.012, bright: 1.5, gain: 1.0,
  },
  attack: {
    dur: 0.5, contour: [[0, 1.55], [0.2, 1.25], [1, 0.95]], amp: [[0, 0], [0.03, 1, 0.6], [0.4, 0.7], [1, 0, 1.2]],
    morph: [[0, 0.35], [1, 0.9]], aperiodic: 0.18, attack: 0.006, bright: 1.25, gain: 1.0,
  },
  alert: {
    dur: 0.62, contour: [[0, 0.85], [0.5, 1.15], [1, 1.35]], amp: [[0, 0], [0.1, 0.85, 1.2], [0.7, 0.8], [1, 0, 1.3]],
    morph: [[0, 0.1], [1, 0.55]], aperiodic: 0.12, attack: 0.03, bright: 1.0, gain: 0.75,
  },
  hurt: {
    dur: 0.42, contour: [[0, 1.3], [0.3, 1.05], [1, 0.8]], amp: [[0, 0], [0.02, 1, 0.5], [0.3, 0.55], [1, 0, 1.1]],
    morph: [[0, 0.5], [1, 0.85]], aperiodic: 0.35, attack: 0.004, bright: 1.15, gain: 0.95,
  },
  death: {
    dur: 2.1, contour: [[0, 1.2], [0.2, 0.95], [0.6, 0.72], [1, 0.5]], amp: [[0, 0], [0.05, 1, 0.8], [0.45, 0.6], [0.8, 0.28], [1, 0, 1.5]],
    // Ends almost entirely aperiodic: the voice stops being a voice and becomes
    // air moving through a body that no longer controls it.
    morph: [[0, 0.4], [1, 0.05]], aperiodic: 0.95, attack: 0.008, bright: 0.9, gain: 1.0,
  },
};

function contourAt(points, t) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i][0]) {
      const [t0, v0] = points[i - 1], [t1, v1] = points[i];
      const x = (t - t0) / Math.max(1e-6, t1 - t0);
      // Smoothstep between breakpoints: a linear pitch contour has audible corners.
      return v0 + (v1 - v0) * (x * x * (3 - 2 * x));
    }
  }
  return points[points.length - 1][1];
}

/**
 * Synthesise one vocalisation.
 * @param {number} sr
 * @param {object} rng deterministic stream
 * @param {string} archetype key of VOCAL_ARCHETYPES
 * @param {string} kind      key of UTTERANCES
 * @param {number} intensity 0..1.5, scales pitch, roughness and drive
 */
export function buildVocalisation(sr, rng, archetype, kind, intensity = 1) {
  const A = VOCAL_ARCHETYPES[archetype] ?? VOCAL_ARCHETYPES.ghoul;
  const U = UTTERANCES[kind] ?? UTTERANCES.growl;
  const inten = clamp(intensity, 0.4, 1.6);

  const dur = U.dur * A.dur * (0.9 + rng.float() * 0.2);
  const sig = Sig.seconds(sr, dur + 0.1, 1);
  const out = sig.data[0];
  const n = Math.round(dur * sr);
  const noise = new Noise(rng);

  /* ---- formant path: two banks, morphed ------------------------- */
  const vowA = VOWELS[A.vowels[0]] ?? VOWELS.gr;
  const vowB = VOWELS[A.vowels[1]] ?? VOWELS.a;
  const bankA = new FormantBank(4);
  const bankB = new FormantBank(4);
  // Per-utterance tract variation: no two members of a species have identical
  // anatomy, and 6% is enough that a pack does not sound cloned.
  const tract = A.tract * (0.94 + rng.float() * 0.12) * (1 / (0.85 + inten * 0.15));
  bankA.setVowel(vowA, sr, tract, 1.0, 1);
  bankB.setVowel(vowB, sr, tract, 1.0, 1);

  /* ---- chest resonance ------------------------------------------ */
  const chest = new Resonator().set(A.chest * tract * 1.06, 0.09, sr);
  // Aspiration takes a different path to the mouth than voicing does: it is
  // shaped mostly by the front cavity, so it gets its own brighter filter.
  const aspFilt = new Biquad().setBandpass(1400 * tract, 0.8, sr);
  const preEmph = new Biquad().setHighpass(70, 0.7, sr);
  const tilt = new Biquad().setHighShelf(2600, -6 + U.bright * 6, sr);

  /* ---- glottal source ------------------------------------------- */
  const f0Base = A.f0 * (0.92 + rng.float() * 0.16) * (0.9 + inten * 0.18);
  let phase = 0;
  let period = sr / f0Base;
  let cycle = 0;             // which glottal cycle we are in (for subharmonics)
  let cycleAmp = 1;
  let jitterWalk = 0;
  const vibrato = new Osc(sr, rng.float());
  const vibHz = 5.2 + rng.float() * 2.6;

  // Contours are control-rate (see CONTROL_BLOCK in dsp.js): an envelope has no
  // business being evaluated 48 000 times a second, and three breakpoint lookups
  // per sample was the single largest cost in the vocal bank.
  let f0 = f0Base, amp = 0, morph = 0, aper = 0;
  const drive = A.drive * (0.7 + inten * 0.5);
  const invDrive = 1 / fastTanh(drive);

  for (let i = 0; i < n; i++) {
    if ((i % CONTROL_BLOCK) === 0) {
      const t = i / n;
      f0 = f0Base * contourAt(U.contour, t);
      amp = contourAt(U.amp, t);
      morph = contourAt(U.morph, t);
      aper = U.aperiodic * (0.3 + t * 0.7);
    }

    /* advance the glottal cycle */
    phase += 1 / period;
    if (phase >= 1) {
      phase -= 1;
      cycle++;
      // Jitter is a random walk, not white noise: real perturbation is correlated
      // from cycle to cycle and a white jitter sounds like a bad pitch-shifter.
      jitterWalk = jitterWalk * 0.6 + rng.signed() * A.jitter * (0.6 + aper * 1.4);
      // Subharmonic: every other cycle is quieter, halving the effective period.
      const subDip = (cycle & 1) ? 1 - A.sub * 0.8 : 1;
      cycleAmp = subDip * (1 - A.shimmer * rng.float() * (0.5 + aper));
      // Aperiodic phase: cycles start dropping out and the period wanders wildly.
      if (aper > 0.4 && rng.float() < (aper - 0.4) * 0.9) cycleAmp *= 0.15;
      vibrato.step(vibHz);
      const vib = vibrato.sine() * 0.012 * (kind === 'shriek' ? 3 : 1);
      period = sr / Math.max(20, f0 * (1 + jitterWalk + vib) * (1 + rng.signed() * aper * 0.35));
    }

    /* excitation = glottal pulse + aspiration */
    const pulse = (glottalPulse(phase, 0.56 + A.breath * 0.08, 0.14) * 2 - 0.7) * cycleAmp;
    const breath = noise.white() * (A.breath * (0.5 + aper * 1.6));
    let ex = pulse * (1 - aper * 0.55) + breath;
    // Rasp: wet throat tissue flapping — sparse high-frequency impulses locked to
    // the glottal cycle rather than free-running, which is what makes it read as
    // part of the voice and not as added noise.
    if (A.rasp > 0 && phase < 0.12 && rng.float() < A.rasp * 0.35) {
      ex += rng.signed() * 0.6 * A.rasp;
    }
    ex = preEmph.process(ex);

    /* formant morph */
    const va = bankA.process(ex);
    const vb = bankB.process(ex);
    let v = va * (1 - morph) + vb * morph;
    v += aspFilt.process(breath) * 0.4 * A.breath;
    v += chest.process(ex) * 0.55;

    /* chest compression / roar shaping */
    v = fastTanh(v * drive) * invDrive;
    out[i] = tilt.process(v) * amp;
  }

  /* ---- onset transient ------------------------------------------ */
  // The lips/jaw opening. A vocalisation without one starts like a fade-in.
  noiseBurst(out, sr, {
    f0: 1800 * tract, f1: 700 * tract, q: 1.1,
    attack: 0.0006, decay: U.attack, duration: 0.08,
    gain: 0.35 * U.bright,
  }, rng);

  /* ---- death rattle tail ---------------------------------------- */
  if (kind === 'death') {
    // Irregular wet clicks over the last third: fluid in the airway. Sparse,
    // random, and the single most effective detail in the whole file.
    const start = Math.round(n * 0.55);
    const count = 8 + (rng.u32() % 10);
    for (let c = 0; c < count; c++) {
      const at = start + Math.round(rng.float() * (n - start) * 0.95);
      noiseBurst(out, sr, {
        f0: 400 + rng.float() * 1400, f1: 200, q: 2.4,
        attack: 0.0008, decay: 0.012 + rng.float() * 0.03, duration: 0.08,
        gain: 0.1 + rng.float() * 0.22, offset: at,
      }, rng);
    }
  }

  fadeOut(out, Math.round(0.03 * sr), 2);
  softLimit(sig, 1.1);
  // RMS-normalise, not peak-normalise. A vocalisation is a *sustained* signal and
  // a struck impact is a transient; peak-matching the two makes every growl about
  // 12 dB louder than a sword hit and the mix never recovers. 0.18 RMS puts a
  // roar a few dB above a blade on flesh, which is where it belongs.
  normalizeRms(sig, 0.18 * U.gain, 0.96);
  return sig;
}

/**
 * A choir-like formant cluster: several voices on a chord, each with its own
 * tract, jitter and vibrato. This is the top layer of the ARISE cue and the pad
 * under a boss entrance — the one place in the score where "human" is the point.
 *
 * @param {number[]} chord frequencies in Hz
 */
export function buildChoirCluster(sampleRate, rng, chord, opts = {}) {
  const {
    duration = 3.0, attack = 0.8, release = 1.2, vowel = 'o', tract = 1.0,
    voices = 3, gain = 0.6, breath = 0.25, swell = 2.0, detune = 12,
    halfRate = true, formants = 3,
  } = opts;
  // A choir has no content above its fourth formant — about 3.5 kHz — so it is
  // synthesised at half the output rate and linearly upsampled. That halves the
  // cost of the single most expensive thing in the whole subsystem (the ARISE
  // cue's twelve-voice cluster) and the only audible consequence is that the
  // breath noise is band-limited to 12 kHz, which is flattering.
  const sr = halfRate && sampleRate > 32000 ? sampleRate / 2 : sampleRate;
  const sig = Sig.seconds(sr, duration, 2);
  const L = sig.data[0], R = sig.data[1];
  const n = sig.length;
  const full = VOWELS[vowel] ?? VOWELS.o;
  // F4 sits 18-24 dB below F1 and is masked by everything else in the mix; three
  // formants carry the whole vowel identity at 25% less work per voice.
  const table = formants < full.length ? full.slice(0, formants) : full;
  const envAtkN = Math.max(1, Math.round(attack * sr));
  const envRelN = Math.max(1, Math.round(release * sr));

  for (let c = 0; c < chord.length; c++) {
    for (let v = 0; v < voices; v++) {
      const noise = new Noise(rng);
      const bank = new FormantBank(table.length);
      // Each singer has a slightly different tract; the spread across a section
      // is what makes a choir sound like people instead of like one detuned saw.
      const tr = tract * (0.93 + rng.float() * 0.14);
      bank.setVowel(table, sr, tr, 1.0, 1);
      const f0 = chord[c] * Math.pow(2, (rng.signed() * detune) / 1200);
      const vib = new Osc(sr, rng.float());
      const vibHz = 4.6 + rng.float() * 1.8;
      const vibDepth = 0.006 + rng.float() * 0.008;
      // Singers do not enter together. 0-180 ms of stagger is what a real
      // section does and it removes the "sample triggered" feel entirely.
      const startN = Math.round(rng.float() * 0.18 * sr);
      const pan = (c / Math.max(1, chord.length - 1) - 0.5) * 1.4 + rng.signed() * 0.25;
      const gl = Math.sqrt(clamp(0.5 * (1 - pan), 0, 1));
      const gr = Math.sqrt(clamp(0.5 * (1 + pan), 0, 1));
      let phase = rng.float();
      let period = sr / f0;
      let jitterWalk = 0;
      const chestRes = new Resonator().set(200 * tr, 0.12, sr);

      let env = 0, t = 0;
      for (let i = startN; i < n; i++) {
        if (((i - startN) % CONTROL_BLOCK) === 0) {
          t = (i - startN) / n;
          env =
            i - startN < envAtkN ? Math.pow((i - startN) / envAtkN, swell)
              : i > n - envRelN ? Math.pow((n - i) / envRelN, 1.4)
                : 1;
        }
        vib.step(vibHz);
        phase += 1 / period;
        if (phase >= 1) {
          phase -= 1;
          jitterWalk = jitterWalk * 0.7 + rng.signed() * 0.008;
          period = sr / (f0 * (1 + jitterWalk + vib.sine() * vibDepth * Math.min(1, t * 3)));
        }
        const ex = (glottalPulse(phase, 0.6, 0.15) * 2 - 0.75) + noise.white() * breath;
        const s = (bank.process(ex) + chestRes.process(ex) * 0.3) * env;
        L[i] += s * gl;
        R[i] += s * gr;
      }
    }
  }
  if (sr !== sampleRate) {
    const up = new Sig(sampleRate, Math.round(duration * sampleRate), 2);
    const ratio = sr / sampleRate;
    for (let c = 0; c < 2; c++) up.data[c].set(resampleLinear(sig.data[c], ratio));
    softLimit(up, 1.05);
    normalizePeak(up, gain);
    return up;
  }
  softLimit(sig, 1.05);
  normalizePeak(sig, gain);
  return sig;
}
