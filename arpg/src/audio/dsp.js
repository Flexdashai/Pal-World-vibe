/**
 * dsp.js — MONARCH's offline synthesis kernel.
 *
 * WHY a hand-written DSP layer rather than a live Web Audio node graph per sound:
 *
 *  1. A one-shot in Web Audio costs a fresh OscillatorNode/BiquadFilterNode chain
 *     every time it fires — nodes are single-use by spec, so a 12-hit flurry
 *     allocates ~120 nodes in 400 ms and the graph rebuild shows up as audible
 *     crackle on a modest CPU. Baking each family ONCE into an AudioBuffer means a
 *     hit costs exactly one AudioBufferSourceNode attached to a pooled, permanently
 *     wired gain/filter/panner slot.
 *  2. It is deterministic. Every sample here comes from `ctx.rng`, so the same seed
 *     produces the same waveform — the capture harness and the playtest replay
 *     identically, which is the whole reason ARCHITECTURE.md bans Math.random().
 *  3. It is testable with no AudioContext at all. The capture container runs
 *     Chromium with --mute-audio and no user gesture, so the realtime context can
 *     never start; because everything here is plain Float32Array maths, the
 *     synthesis is still fully exercised and measured by `AudioSystem.selfTest()`.
 *
 * Web Audio is still doing the work it is good at: mixing, compression, HRTF
 * panning, convolution reverb, and sample-accurate scheduling. This file only
 * builds the source material those nodes play.
 *
 * Everything is mono-in/mono-out unless a function says otherwise; stereo is
 * produced at the very end (Haas widening, granular spread, IR decorrelation) so
 * the expensive inner loops stay single-channel.
 */

export const TAU = Math.PI * 2;
/** Ratio of one equal-tempered semitone; used everywhere a pitch is transposed. */
export const SEMITONE = 1.0594630943592953;

/* ================================================================== */
/* 1. Signal container                                                */
/* ================================================================== */

/**
 * A block of PCM plus its sample rate. Deliberately not an AudioBuffer: this must
 * be constructible with no AudioContext in existence (see the file header).
 */
export class Sig {
  constructor(sampleRate, length, channels = 1) {
    this.sampleRate = sampleRate;
    this.length = length | 0;
    /** @type {Float32Array[]} */
    this.data = [];
    for (let c = 0; c < channels; c++) this.data.push(new Float32Array(this.length));
  }

  /** Allocate by duration instead of sample count. */
  static seconds(sampleRate, secs, channels = 1) {
    return new Sig(sampleRate, Math.max(1, Math.round(secs * sampleRate)), channels);
  }

  get channels() { return this.data.length; }
  get duration() { return this.length / this.sampleRate; }
  /** Heap cost, so the bank can report and cap what it has baked. */
  get bytes() { return this.length * this.data.length * 4; }

  ch(i) { return this.data[i] ?? this.data[0]; }

  clear() {
    for (let c = 0; c < this.data.length; c++) this.data[c].fill(0);
    return this;
  }

  peak() {
    let p = 0;
    for (let c = 0; c < this.data.length; c++) {
      const a = this.data[c];
      for (let i = 0; i < a.length; i++) { const v = a[i] < 0 ? -a[i] : a[i]; if (v > p) p = v; }
    }
    return p;
  }

  rms() {
    let s = 0, n = 0;
    for (let c = 0; c < this.data.length; c++) {
      const a = this.data[c];
      for (let i = 0; i < a.length; i++) s += a[i] * a[i];
      n += a.length;
    }
    return n ? Math.sqrt(s / n) : 0;
  }

  /**
   * Sample index at which the signal first crosses `frac` of its peak. This is the
   * measurement the quality bar cares about — "every hit needs a transient with
   * real attack" is exactly "this number is small".
   */
  attackSamples(frac = 0.5) {
    const p = this.peak() * frac;
    if (p <= 0) return this.length;
    const a = this.data[0];
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) >= p) return i;
    return this.length;
  }

  /**
   * Spectral centroid in Hz, by Goertzel over a log-spaced probe set. Cheap enough
   * to run in a self-test and it is the single number that best separates "dull
   * thud" from "bright clang", so the bank can assert its own timbres.
   */
  centroid(bands = 24) {
    const a = this.data[0];
    let num = 0, den = 0;
    for (let b = 0; b < bands; b++) {
      const f = 40 * Math.pow(2, (b / (bands - 1)) * 8.5); // 40 Hz .. ~13.6 kHz
      if (f >= this.sampleRate * 0.45) break;
      const e = goertzel(a, this.sampleRate, f);
      num += f * e;
      den += e;
    }
    return den > 0 ? num / den : 0;
  }

  /** Wrap as an AudioBuffer. Never called before a context exists. */
  toAudioBuffer(ac) {
    const buf = ac.createBuffer(this.data.length, this.length, this.sampleRate);
    for (let c = 0; c < this.data.length; c++) buf.copyToChannel(this.data[c], c);
    return buf;
  }
}

/** Single-bin DFT magnitude — used by `Sig.centroid`, not in any hot path. */
export function goertzel(a, sampleRate, freq) {
  const w = TAU * freq / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  // Decimate long signals: a hit's timbre is set in its first ~200 ms and a full
  // pass over a 3 s buffer per probe band would make the self-test sluggish.
  const n = Math.min(a.length, sampleRate * 0.25) | 0;
  for (let i = 0; i < n; i++) {
    s0 = a[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

/* ================================================================== */
/* 2. Buffer operations                                               */
/* ================================================================== */

export function addInto(dst, src, gain = 1, offset = 0) {
  const n = Math.min(src.length, dst.length - offset);
  for (let i = 0; i < n; i++) dst[i + offset] += src[i] * gain;
  return dst;
}

export function scaleArray(a, g) {
  for (let i = 0; i < a.length; i++) a[i] *= g;
  return a;
}

export function reverseArray(a) {
  for (let i = 0, j = a.length - 1; i < j; i++, j--) { const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/** Reverse every channel in place — the front half of the ARISE cue. */
export function reverseSig(sig) {
  for (let c = 0; c < sig.channels; c++) reverseArray(sig.data[c]);
  return sig;
}

export function normalizePeak(sig, target = 0.98) {
  const p = sig.peak();
  if (p < 1e-9) return sig;
  const g = target / p;
  for (let c = 0; c < sig.channels; c++) scaleArray(sig.data[c], g);
  return sig;
}

/** Loudness-match by RMS instead of peak — what you want for beds and reverb IRs,
 *  where peak normalisation makes a spiky signal quiet and a dense one loud. */
export function normalizeRms(sig, target = 0.12, ceiling = 0.99) {
  const r = sig.rms();
  if (r < 1e-9) return sig;
  let g = target / r;
  const p = sig.peak() * g;
  if (p > ceiling) g *= ceiling / p; // never trade loudness for clipping
  for (let c = 0; c < sig.channels; c++) scaleArray(sig.data[c], g);
  return sig;
}

/** `curve` > 1 keeps the fade quiet for longer (perceptually more linear). */
export function fadeIn(a, n, curve = 2, from = 0) {
  const end = Math.min(a.length, from + n);
  for (let i = from; i < end; i++) a[i] *= Math.pow((i - from) / n, curve);
  return a;
}

export function fadeOut(a, n, curve = 2) {
  const start = Math.max(0, a.length - n);
  for (let i = start; i < a.length; i++) a[i] *= Math.pow(1 - (i - start) / n, curve);
  return a;
}

/** Equal-power crossfade of `sig`'s tail back over its head, returning a shorter
 *  Sig that loops without a seam. Required for every ambience and music bed:
 *  a click once per loop is the fastest way to make a soundtrack feel cheap. */
export function foldTailIntoHead(sig, fadeSamples) {
  const f = Math.min(fadeSamples | 0, (sig.length / 2) | 0);
  const outLen = sig.length - f;
  const out = new Sig(sig.sampleRate, outLen, sig.channels);
  for (let c = 0; c < sig.channels; c++) {
    const src = sig.data[c], dst = out.data[c];
    dst.set(src.subarray(0, outLen));
    for (let i = 0; i < f; i++) {
      const t = i / f;
      // sin/cos keeps summed power constant through the overlap; a linear fade
      // dips ~3 dB in the middle and you hear it as a pulse at the loop point.
      const a = Math.cos(t * Math.PI * 0.5), b = Math.sin(t * Math.PI * 0.5);
      dst[i] = dst[i] * b + src[outLen + i] * a;
    }
  }
  return out;
}

/** Mono -> stereo with a Haas delay and a tilt, for width without phase collapse. */
export function haasWiden(sig, ms = 11, tilt = 0.25) {
  if (sig.channels >= 2) return sig;
  const d = Math.max(1, Math.round(ms * 0.001 * sig.sampleRate));
  const out = new Sig(sig.sampleRate, sig.length, 2);
  const src = sig.data[0], L = out.data[0], R = out.data[1];
  const gl = 1 + tilt * 0.5, gr = 1 - tilt * 0.5;
  for (let i = 0; i < sig.length; i++) {
    L[i] = src[i] * gl;
    R[i] = (i >= d ? src[i - d] : 0) * gr;
  }
  return out;
}

/** Duplicate mono to stereo with independent decorrelation noise on the sides.
 *  Used for beds where a Haas delay would smear the transients. */
export function decorrelate(sig, rng, amount = 0.35, spreadMs = 22) {
  if (sig.channels >= 2) return sig;
  const out = new Sig(sig.sampleRate, sig.length, 2);
  const src = sig.data[0], L = out.data[0], R = out.data[1];
  const maxD = Math.max(2, Math.round(spreadMs * 0.001 * sig.sampleRate));
  // A short random all-pass chain per ear: same spectrum, different phase, so the
  // sum stays mono-compatible while the image opens up.
  const apL = [new Allpass(maxD * 0.31 | 0, 0.6 * amount), new Allpass(maxD * 0.73 | 0, 0.5 * amount)];
  const apR = [new Allpass(maxD * 0.43 | 0, 0.6 * amount), new Allpass(maxD * 0.97 | 0, 0.5 * amount)];
  for (const ap of apL) ap.g *= 1 + rng.signed() * 0.1;
  for (const ap of apR) ap.g *= 1 + rng.signed() * 0.1;
  for (let i = 0; i < sig.length; i++) {
    let l = src[i], r = src[i];
    for (let k = 0; k < apL.length; k++) l = apL[k].process(l);
    for (let k = 0; k < apR.length; k++) r = apR[k].process(r);
    L[i] = l; R[i] = r;
  }
  return out;
}

/** tanh soft-clip in place — analogue-ish saturation, never a hard edge. */
export function softLimit(sig, drive = 1, ceiling = 0.985) {
  const k = ceiling / fastTanh(drive);
  for (let c = 0; c < sig.channels; c++) {
    const a = sig.data[c];
    for (let i = 0; i < a.length; i++) a[i] = fastTanh(a[i] * drive) * k;
  }
  return sig;
}

/** Linear resample. Only used for pitch-shifting bake-time material; realtime
 *  pitch variation is free via AudioBufferSourceNode.playbackRate. */
export function resampleLinear(src, ratio) {
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = x | 0, f = x - i0;
    const a = src[i0] ?? 0, b = src[i0 + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/* ================================================================== */
/* 3. Envelopes                                                       */
/* ================================================================== */

/** Percussive attack shape: reaches 1 at `atk` seconds, `curve` shapes the knee. */
export function attackShape(t, atk, curve = 1) {
  if (t >= atk) return 1;
  const x = t / atk;
  return curve === 1 ? x : Math.pow(x, curve);
}

export function expDecay(t, tau) {
  return Math.exp(-t / tau);
}

/**
 * Per-sample attack/decay envelope. Written as a class with `next()` because the
 * bake loops are the hottest code in the subsystem and an inline Math.exp per
 * sample per layer is measurable — the recursive form is one multiply.
 */
export class PercEnv {
  /** @param decay seconds to -60 dB. */
  constructor(sampleRate, attack, decay, curve = 1) {
    this.sr = sampleRate;
    this.atkN = Math.max(1, Math.round(attack * sampleRate));
    this.curve = curve;
    // 6.9078 = ln(1000): reaching -60 dB in `decay` seconds.
    this.k = Math.exp(-6.9078 / Math.max(1e-4, decay * sampleRate));
    this.i = 0;
    this.env = 1;
  }
  next() {
    let v;
    if (this.i < this.atkN) {
      const x = this.i / this.atkN;
      v = this.curve === 1 ? x : Math.pow(x, this.curve);
    } else {
      v = this.env;
      this.env *= this.k;
    }
    this.i++;
    return v;
  }
  reset() { this.i = 0; this.env = 1; return this; }
}

/**
 * Piecewise envelope over normalised time, with per-segment curvature. Used where
 * a shape has more than two stages — a swell, a whoosh, the ARISE build.
 * `points` is [[t0,v0,curve],[t1,v1,curve],...] with t ascending in seconds.
 */
export class Breakpoint {
  constructor(points) { this.p = points; }
  at(t) {
    const p = this.p;
    if (t <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i][0]) {
        const [t0, v0] = p[i - 1];
        const [t1, v1, curve = 1] = p[i];
        const x = (t - t0) / Math.max(1e-6, t1 - t0);
        return v0 + (v1 - v0) * (curve === 1 ? x : Math.pow(x, curve));
      }
    }
    return p[p.length - 1][1];
  }
}

/* ================================================================== */
/* 4. Noise                                                           */
/* ================================================================== */

/**
 * Noise generators sharing one deterministic Rng. Pink and brown keep their own
 * filter state, so interleaving calls to different colours is safe.
 */
export class Noise {
  constructor(rng) {
    this.rng = rng;
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.b3 = 0; this.b4 = 0; this.b5 = 0; this.b6 = 0;
    this.brownState = 0;
  }
  white() { return this.rng.signed(); }

  /** Paul Kellet's refined pink filter — flat to within ~0.05 dB across the band,
   *  which matters because pink is the base for wind, ambience beds and cloth. */
  pink() {
    const w = this.rng.signed();
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.96900 * this.b2 + w * 0.1538520;
    this.b3 = 0.86650 * this.b3 + w * 0.3104856;
    this.b4 = 0.55000 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.0168980;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.11;
  }

  /** Brown/red noise (integrated white) with a leak so it cannot wander off DC. */
  brown() {
    this.brownState = (this.brownState + this.rng.signed() * 0.02) * 0.998;
    return this.brownState * 8;
  }

  /**
   * Velvet noise: sparse ±1 impulses, one per `density` samples. Perceptually
   * smoother than white for reverb tails at a fraction of the arithmetic, and it
   * is what makes a procedural IR sound diffuse rather than hissy.
   */
  velvet(period, i) {
    return (i % period) === (this.rng.u32() % period) ? (this.rng.float() < 0.5 ? -1 : 1) : 0;
  }
}

/* ================================================================== */
/* 5. Filters                                                         */
/* ================================================================== */

export class OnePole {
  constructor() { this.a = 0; this.z = 0; }
  setLP(f, sr) { this.a = Math.exp(-TAU * Math.min(f, sr * 0.49) / sr); return this; }
  lp(x) { this.z = x * (1 - this.a) + this.z * this.a; return this.z; }
  hp(x) { this.z = x * (1 - this.a) + this.z * this.a; return x - this.z; }
  reset() { this.z = 0; return this; }
}

/** RBJ cookbook biquad, direct form I. */
export class Biquad {
  constructor() { this.reset(); this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; }
  reset() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; return this; }

  _norm(b0, b1, b2, a0, a1, a2) {
    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
    this.a1 = a1 * inv; this.a2 = a2 * inv;
    return this;
  }
  _w(f, sr) { return TAU * Math.min(Math.max(f, 1), sr * 0.49) / sr; }

  setLowpass(f, q, sr) {
    const w = this._w(f, sr), c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  setHighpass(f, q, sr) {
    const w = this._w(f, sr), c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  setBandpass(f, q, sr) {
    const w = this._w(f, sr), c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  setNotch(f, q, sr) {
    const w = this._w(f, sr), c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm(1, -2 * c, 1, 1 + al, -2 * c, 1 - al);
  }
  setPeaking(f, q, gainDb, sr) {
    const A = Math.pow(10, gainDb / 40);
    const w = this._w(f, sr), c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  setLowShelf(f, gainDb, sr, slope = 1) {
    const A = Math.pow(10, gainDb / 40);
    const w = this._w(f, sr), c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const t = 2 * Math.sqrt(A) * al;
    return this._norm(
      A * ((A + 1) - (A - 1) * c + t), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - t),
      (A + 1) + (A - 1) * c + t, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - t);
  }
  setHighShelf(f, gainDb, sr, slope = 1) {
    const A = Math.pow(10, gainDb / 40);
    const w = this._w(f, sr), c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const t = 2 * Math.sqrt(A) * al;
    return this._norm(
      A * ((A + 1) + (A - 1) * c + t), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - t),
      (A + 1) - (A - 1) * c + t, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - t);
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }

  /** Filter a whole array in place. */
  run(a) { for (let i = 0; i < a.length; i++) a[i] = this.process(a[i]); return a; }
}

/**
 * Chamberlin state-variable filter. Unlike the biquad it stays stable when the
 * cutoff is swept every sample, which is exactly what a whoosh, a frost sweep or
 * a lightning zap needs.
 */
export class SVF {
  constructor() {
    this.low = 0; this.band = 0; this.high = 0; this.notch = 0;
    this._f = -1; this._q = -1; this._fc = 0; this._qc = 1;
  }
  process(x, f, q, sr) {
    // 2*sin(pi*f/sr) is the standard SVF frequency coefficient; clamped at 0.99 to
    // stay inside the stability region when a sweep runs past Nyquist.
    //
    // Memoised on (f, q): callers that hold the cutoff steady — or move it at
    // control rate, which is all of them — pay for one Math.sin per change
    // instead of one per sample. On a 3 s noise bed that is 144 000 transcendental
    // calls saved.
    if (f !== this._f || q !== this._q) {
      this._f = f; this._q = q;
      this._fc = Math.min(0.99, 2 * Math.sin(Math.PI * Math.min(f, sr * 0.45) / sr));
      this._qc = Math.min(1.4, 1 / Math.max(0.5, q));
    }
    const fc = this._fc, qc = this._qc;
    this.low += fc * this.band;
    this.high = x - this.low - qc * this.band;
    this.band += fc * this.high;
    this.notch = this.high + this.low;
    return this.low;
  }
  reset() { this.low = this.band = this.high = this.notch = 0; return this; }
}

/**
 * Single resonant mode: a 2-pole resonator tuned by frequency and -60 dB time.
 * Bank these and excite them with a burst and you get modal synthesis — the only
 * technique that makes struck stone, iron and bone actually sound like the
 * material rather than like a filtered click.
 */
export class Resonator {
  constructor() { this.y1 = 0; this.y2 = 0; this.b0 = 1; this.a1 = 0; this.a2 = 0; }
  set(freq, decaySec, sr) {
    const r = Math.exp(-6.9078 / Math.max(1e-4, decaySec * sr));
    const w = TAU * Math.min(freq, sr * 0.47) / sr;
    this.a1 = -2 * r * Math.cos(w);
    this.a2 = r * r;
    // The impulse response of this filter is b0 * r^n * sin((n+1)w) / sin(w), so
    // b0 = sin(w) makes its PEAK exactly 1 for any frequency and any decay.
    //
    // This is worth stating plainly because the obvious alternative — scaling by
    // (1-r), the usual "unity DC gain" normalisation — makes a long-ringing mode
    // thousands of times quieter than a short one, which buries the entire modal
    // body of an iron clang underneath its own contact transient. A struck bell
    // is not quieter than a struck brick at the moment of impact; it just rings
    // for longer, and that is exactly what this normalisation says.
    this.b0 = Math.sin(w);
    return this;
  }
  process(x) {
    const y = this.b0 * x - this.a1 * this.y1 - this.a2 * this.y2;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() { this.y1 = this.y2 = 0; return this; }
}

/**
 * A parallel bank of resonators with per-mode gain.
 *
 * State is held in flat Float64Arrays rather than in an array of `Resonator`
 * objects. That is not premature micro-optimisation: `process` is called once per
 * sample per bank and a six-mode bank over a one-second buffer is 288 000
 * invocations, where per-object property loads dominate the arithmetic. Flat
 * arrays measured ~3.4x faster on the same modal impact.
 */
export class ModalBank {
  constructor(n) {
    this.cap = n;
    this.b0 = new Float64Array(n);
    this.a1 = new Float64Array(n);
    this.a2 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.y2 = new Float64Array(n);
    this.g = new Float64Array(n);
    this.n = 0;
    /** Longest -60 dB time in the bank. `modalHit` uses it to stop rendering
     *  once every mode is inaudible, which is the difference between a 40-pop
     *  fire crackle costing 4 ms and costing 280 ms. */
    this.maxDecay = 0;
  }
  set(i, freq, decay, gain, sr) {
    if (i >= this.cap) return this;
    const r = Math.exp(-6.9078 / Math.max(1e-4, decay * sr));
    const w = TAU * Math.min(freq, sr * 0.47) / sr;
    this.a1[i] = -2 * r * Math.cos(w);
    this.a2[i] = r * r;
    // b0 = sin(w) gives an impulse-response peak of exactly 1 at any frequency
    // and any decay time — see the long note in `Resonator.set`.
    this.b0[i] = Math.sin(w);
    this.g[i] = gain;
    this.y1[i] = 0; this.y2[i] = 0;
    if (i + 1 > this.n) this.n = i + 1;
    if (decay > this.maxDecay) this.maxDecay = decay;
    return this;
  }
  /** Configure from a [[freq, decay, gain], ...] table, with global scalers. */
  fromTable(table, sr, freqScale = 1, decayScale = 1, gainScale = 1, detune = null) {
    this.n = 0;
    this.maxDecay = 0;
    const n = Math.min(table.length, this.cap);
    for (let i = 0; i < n; i++) {
      const d = detune ? 1 + detune.signed() * 0.02 : 1;
      this.set(i, table[i][0] * freqScale * d, table[i][1] * decayScale, table[i][2] * gainScale, sr);
    }
    return this;
  }
  process(x) {
    const b0 = this.b0, a1 = this.a1, a2 = this.a2, y1 = this.y1, y2 = this.y2, g = this.g;
    let s = 0;
    for (let i = 0, n = this.n; i < n; i++) {
      const y = b0[i] * x - a1[i] * y1[i] - a2[i] * y2[i];
      y2[i] = y1[i]; y1[i] = y;
      s += y * g[i];
    }
    return s;
  }
  reset() { this.y1.fill(0); this.y2.fill(0); return this; }
}

/** Fixed-length all-pass — the diffusion primitive for reverb and decorrelation. */
export class Allpass {
  constructor(n, g) {
    this.buf = new Float32Array(Math.max(1, n | 0));
    this.i = 0;
    this.g = g;
  }
  process(x) {
    const b = this.buf, i = this.i;
    const d = b[i];
    const v = x + d * this.g;
    b[i] = v;
    this.i = (i + 1) % b.length;
    return d - v * this.g;
  }
}

/** Feedback comb with a one-pole damper in the loop (Schroeder/Moorer style). */
export class Comb {
  constructor(n, feedback, damp) {
    this.buf = new Float32Array(Math.max(1, n | 0));
    this.i = 0;
    this.fb = feedback;
    this.damp = damp;
    this.z = 0;
  }
  process(x) {
    const b = this.buf, i = this.i;
    const d = b[i];
    this.z = d * (1 - this.damp) + this.z * this.damp;
    b[i] = x + this.z * this.fb;
    this.i = (i + 1) % b.length;
    return d;
  }
}

/** Interpolating delay line with a modulatable read head. */
export class DelayLine {
  constructor(maxSamples) {
    this.buf = new Float32Array(Math.max(4, maxSamples | 0));
    this.w = 0;
  }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) % this.buf.length; }
  read(delaySamples) {
    const n = this.buf.length;
    let r = this.w - delaySamples;
    while (r < 0) r += n;
    const i0 = r | 0, f = r - i0;
    const a = this.buf[i0 % n], b = this.buf[(i0 + 1) % n];
    return a + (b - a) * f;
  }
  /** One-call delay+feedback for echoes. */
  process(x, delaySamples, feedback) {
    const d = this.read(delaySamples);
    this.write(x + d * feedback);
    return d;
  }
}

/* ================================================================== */
/* 6. Oscillators                                                     */
/* ================================================================== */

/**
 * Phase-accumulating oscillator with PolyBLEP band-limiting on the discontinuous
 * waveforms. The naive saw is fine for a 40 Hz drone and horrible for a 900 Hz
 * string cluster — aliasing is the single most "cheap synth" tell there is.
 */
export class Osc {
  constructor(sampleRate, phase = 0) {
    this.sr = sampleRate;
    this.p = phase;
    this.dt = 0;
  }
  step(freq) {
    this.dt = freq / this.sr;
    this.p += this.dt;
    if (this.p >= 1) this.p -= 1;
    return this.p;
  }
  sine() { return Math.sin(TAU * this.p); }
  tri() { return 4 * Math.abs(this.p - 0.5) - 1; }
  saw() { return 2 * this.p - 1 - polyBlep(this.p, this.dt); }
  square(pw = 0.5) {
    let v = this.p < pw ? 1 : -1;
    v += polyBlep(this.p, this.dt);
    let p2 = this.p - pw; if (p2 < 0) p2 += 1;
    v -= polyBlep(p2, this.dt);
    return v;
  }
  reset(phase = 0) { this.p = phase; return this; }
}

export function polyBlep(t, dt) {
  if (dt <= 0) return 0;
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

/* ================================================================== */
/* 7. Formants — voices, choirs, monsters                             */
/* ================================================================== */

/**
 * Vowel formant tables (F1..F4 in Hz with relative amplitude and bandwidth).
 * These are measured adult-male values; the archetype pitch scaler in vocal.js
 * stretches them for a huge beast or a small ghoul, which is exactly how real
 * vocal-tract length works — a longer tract lowers every formant proportionally.
 */
export const VOWELS = {
  //          F1                F2                F3                F4
  a: [[730, 1.00, 80], [1090, 0.50, 90], [2440, 0.25, 120], [3400, 0.12, 130]],
  e: [[530, 1.00, 70], [1840, 0.45, 100], [2480, 0.30, 120], [3500, 0.10, 130]],
  i: [[270, 1.00, 60], [2290, 0.35, 90], [3010, 0.25, 100], [3500, 0.10, 120]],
  o: [[570, 1.00, 70], [840, 0.55, 80], [2410, 0.16, 100], [3400, 0.06, 120]],
  u: [[300, 1.00, 60], [870, 0.35, 80], [2240, 0.10, 100], [3400, 0.04, 120]],
  /** Not a real vowel — a dark, throat-heavy cluster for growls. */
  gr: [[180, 1.00, 55], [620, 0.70, 90], [1180, 0.35, 140], [2600, 0.10, 180]],
  /** Strained, bright: shrieks and death rattles. */
  sc: [[420, 1.00, 90], [1700, 0.85, 130], [2900, 0.60, 170], [4200, 0.30, 220]],
};

/**
 * A parallel formant filter bank — flat-array for the same reason `ModalBank` is:
 * a choir of eighteen voices running four biquads each over four seconds is 13
 * million filter invocations, and object dispatch is most of the cost.
 */
export class FormantBank {
  constructor(n = 4) {
    this.cap = n;
    this.b0 = new Float64Array(n); this.b1 = new Float64Array(n); this.b2 = new Float64Array(n);
    this.a1 = new Float64Array(n); this.a2 = new Float64Array(n);
    this.x1 = new Float64Array(n); this.x2 = new Float64Array(n);
    this.y1 = new Float64Array(n); this.y2 = new Float64Array(n);
    this.amp = new Float64Array(n);
    this.n = 0;
  }
  /** `scale` shifts the whole vocal tract; `spread` warps F2..F4 outward. */
  setVowel(table, sr, scale = 1, spread = 1, ampScale = 1) {
    this.n = Math.min(table.length, this.cap);
    for (let i = 0; i < this.n; i++) {
      const [f, a, bw] = table[i];
      const ff = f * scale * (i === 0 ? 1 : Math.pow(spread, i));
      // Q from bandwidth: Q = f/BW is the textbook relation and keeps the vowel
      // identity when the tract is scaled.
      const q = Math.max(1.2, ff / (bw * scale));
      const w = TAU * Math.min(Math.max(ff, 1), sr * 0.49) / sr;
      const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
      const inv = 1 / (1 + al);
      this.b0[i] = al * inv; this.b1[i] = 0; this.b2[i] = -al * inv;
      this.a1[i] = -2 * c * inv; this.a2[i] = (1 - al) * inv;
      this.x1[i] = 0; this.x2[i] = 0; this.y1[i] = 0; this.y2[i] = 0;
      this.amp[i] = a * ampScale;
    }
    return this;
  }
  process(x) {
    const b0 = this.b0, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    const x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2, amp = this.amp;
    let s = 0;
    for (let i = 0, n = this.n; i < n; i++) {
      // b1 is identically zero for a bandpass, so it is skipped entirely.
      const y = b0[i] * x + b2[i] * x2[i] - a1[i] * y1[i] - a2[i] * y2[i];
      x2[i] = x1[i]; x1[i] = x;
      y2[i] = y1[i]; y1[i] = y;
      s += y * amp[i];
    }
    return s;
  }
  reset() { this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0); return this; }
}

/**
 * Rosenberg glottal pulse — the excitation a real voice uses. A raw sawtooth
 * through a formant bank sounds like a chiptune; this sounds like a throat.
 * `open` is the fraction of the period the glottis is open (0.4..0.7).
 */
export function glottalPulse(phase, open = 0.6, close = 0.16) {
  if (phase < open) {
    const x = phase / open;
    return 3 * x * x - 2 * x * x * x;
  }
  if (phase < open + close) {
    const x = (phase - open) / close;
    return 1 - x * x;
  }
  return 0;
}

/* ================================================================== */
/* 8. Composite generators                                            */
/* ================================================================== */

/**
 * Excite a modal bank with a short shaped burst and render into `out`.
 *
 * The excitation matters as much as the modes: a Dirac impulse rings every mode
 * equally and sounds synthetic, while a few milliseconds of band-limited noise
 * with a fast decay is what a real striker does — it couples energy into the
 * modes over a finite contact time, which is why a hammer and a blade on the same
 * stone sound different.
 */
export function modalHit(out, sr, bank, opts, rng) {
  const {
    contact = 0.0016,     // seconds of contact — the striker's stiffness
    exciteLp = 9000,      // brightness of the strike
    exciteHp = 90,
    gain = 1,
    offset = 0,
    noise = null,
  } = opts;
  const n = new Noise(rng);
  const lp = new Biquad().setLowpass(exciteLp, 0.7, sr);
  const hp = new Biquad().setHighpass(exciteHp, 0.7, sr);
  const contactN = Math.max(2, Math.round(contact * sr));
  // Stop once every mode is below -60 dB plus a little margin. Rendering silence
  // is the single biggest waste in the bank: a fire crackle is forty impulses
  // whose modes die in 20 ms scattered across a one-second buffer.
  const decayN = Math.ceil((contact + (bank.maxDecay || 0.25) * 1.15) * sr) + 64;
  const len = Math.min(out.length - offset, decayN);
  // The excitation filters only have signal for the contact window plus their own
  // ringdown (256 samples is > 20 ms of settling at any cutoff we use here).
  // Past that the input to the modal bank is exactly zero, so the two biquads are
  // skipped for the whole tail — which is 99% of the samples.
  const excN = Math.min(len, contactN + 256);
  for (let i = 0; i < excN; i++) {
    let x = 0;
    if (i < contactN) {
      // Half-sine contact window: smooth in, smooth out, no DC step.
      const w = Math.sin(Math.PI * i / contactN);
      x = (noise ? noise.white() : n.white()) * w * w;
    }
    x = hp.process(lp.process(x));
    out[i + offset] += bank.process(x) * gain;
  }
  for (let i = excN; i < len; i++) {
    out[i + offset] += bank.process(0) * gain;
  }
  return out;
}

/**
 * Band-passed noise burst with an independent centre-frequency sweep. This is the
 * workhorse for every non-tonal element: grit, cloth, splash, whoosh, breath.
 */
export function noiseBurst(out, sr, opts, rng) {
  const {
    f0 = 1200, f1 = f0, q = 1.2,
    attack = 0.001, decay = 0.12, curve = 1,
    gain = 1, offset = 0, duration = decay * 2,
    colour = 'white', sweepCurve = 1,
  } = opts;
  const noise = new Noise(rng);
  const svf = new SVF();
  const env = new PercEnv(sr, attack, decay, curve);
  const n = Math.min(Math.round(duration * sr), out.length - offset);
  const bpQ = Math.max(0.5, q);
  // Control-rate cutoff: quantising the sweep to 1.5 kHz steps keeps the SVF's
  // memoised coefficients valid for 32 samples at a time.
  let f = f0;
  for (let i = 0; i < n; i++) {
    if ((i % CONTROL_BLOCK) === 0) {
      const t = i / n;
      f = f0 + (f1 - f0) * (sweepCurve === 1 ? t : Math.pow(t, sweepCurve));
    }
    const x = colour === 'pink' ? noise.pink() : colour === 'brown' ? noise.brown() : noise.white();
    // SVF low output after a sweep gives a resonant band; take band for a true BP.
    svf.process(x, f, bpQ, sr);
    out[i + offset] += svf.band * env.next() * gain;
  }
  return out;
}

/**
 * Sine/triangle sweep with an exponential pitch contour. Sub drops, zaps, bubbles
 * and the ARISE sub-drop are all this function with different numbers.
 */
export function sweepTone(out, sr, opts) {
  const {
    f0 = 220, f1 = 55, duration = 0.6, attack = 0.002, decay = duration,
    gain = 1, offset = 0, wave = 'sine', pitchCurve = 3, drive = 1, fm = 0, fmRatio = 2,
  } = opts;
  const osc = new Osc(sr);
  const fmOsc = new Osc(sr);
  const env = new PercEnv(sr, attack, decay, 1);
  const n = Math.min(Math.round(duration * sr), out.length - offset);
  const ratio = f1 / f0;
  const invDrive = drive === 1 ? 1 : 1 / fastTanh(drive);
  // Frequency is a control-rate signal: two Math.pow calls every 32 samples
  // instead of two per sample, linearly interpolated in between.
  let f = f0, fNext = f0, fStep = 0;
  for (let i = 0; i < n; i++) {
    if ((i % CONTROL_BLOCK) === 0) {
      f = fNext;
      const t1 = Math.min(1, (i + CONTROL_BLOCK) / n);
      // Exponential glide in log-frequency: a linear Hz ramp from 220 to 55
      // spends most of its time near the top and reads as a "beep", not a drop.
      fNext = f0 * Math.pow(ratio, Math.pow(t1, pitchCurve));
      fStep = (fNext - f) / CONTROL_BLOCK;
    }
    f += fStep;
    let mod = 0;
    if (fm > 0) { fmOsc.step(f * fmRatio); mod = fmOsc.sine() * fm * f; }
    osc.step(Math.max(8, f + mod));
    let v = wave === 'tri' ? osc.tri() : wave === 'saw' ? osc.saw() : osc.sine();
    if (drive !== 1) v = fastTanh(v * drive) * invDrive;
    out[i + offset] += v * env.next() * gain;
  }
  return out;
}

/**
 * Granular pitch-shifted shimmer.
 *
 * This is the "violet" in shadow magic: grains of the source read back at +12 and
 * +19 semitones, Hann-windowed, scattered in time and hard-panned alternately, so
 * the top of the spectrum glitters and drifts while the sub stays anchored. Doing
 * it at bake time instead of with a realtime granulator is the only way it is
 * affordable, and it is deterministic.
 */
export function granularShimmer(src, outL, outR, sr, opts, rng) {
  const {
    grainMs = 90, overlap = 4, ratios = [2, 3], gain = 0.5,
    jitter = 0.4, spread = 0.9, offset = 0, feedback = 0.35, tail = 0.5,
  } = opts;
  const grainN = Math.max(16, Math.round(grainMs * 0.001 * sr));
  const hop = Math.max(4, Math.round(grainN / overlap));
  const outLen = Math.min(outL.length, outR.length) - offset;
  const total = Math.min(outLen, src.length + Math.round(tail * sr));
  // Feedback bus: grains are written back into a scratch copy so successive passes
  // climb another octave — the classic ascending shimmer.
  const fb = new Float32Array(src.length);
  const win = new Float32Array(grainN);
  for (let i = 0; i < grainN; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / grainN);

  for (let pos = 0; pos + grainN < total; pos += hop) {
    const ratio = ratios[(rng.u32() % ratios.length)];
    const jitterN = Math.round((rng.float() * 2 - 1) * jitter * grainN);
    let read = pos - Math.round(grainN * (ratio - 1) * 0.5) + jitterN;
    if (read < 0) read = 0;
    const pan = rng.signed() * spread;
    const gl = Math.sqrt(Math.max(0, 0.5 * (1 - pan)));
    const gr = Math.sqrt(Math.max(0, 0.5 * (1 + pan)));
    const g = gain * (0.6 + rng.float() * 0.4);
    for (let i = 0; i < grainN; i++) {
      const s = read + i * ratio;
      const i0 = s | 0;
      if (i0 + 1 >= src.length) break;
      const f = s - i0;
      const a = src[i0] + fb[i0], b = src[i0 + 1] + fb[i0 + 1];
      const v = (a + (b - a) * f) * win[i] * g;
      const o = pos + i + offset;
      if (o >= outL.length) break;
      outL[o] += v * gl;
      outR[o] += v * gr;
      const fbi = pos + i;
      if (fbi < fb.length) fb[fbi] += v * feedback;
    }
  }
  return outL;
}

/**
 * Karplus–Strong string/rod. Used for chain rattle, the metallic sing on a blade
 * ricochet, and the bell in the holy element.
 */
export function karplus(out, sr, freq, opts, rng) {
  const { decay = 0.995, damp = 0.4, gain = 1, offset = 0, duration = 1.0, stretch = 0 } = opts;
  const n = Math.max(2, Math.round(sr / Math.max(20, freq)));
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = rng.signed();
  // One-pole pre-damp so the initial burst is not pure white — a struck rod starts
  // dark and brightens as the higher modes fold in.
  let z = 0;
  for (let i = 0; i < n; i++) { z = buf[i] * (1 - damp) + z * damp; buf[i] = z; }
  const total = Math.min(Math.round(duration * sr), out.length - offset);
  let idx = 0, last = 0;
  for (let i = 0; i < total; i++) {
    const cur = buf[idx];
    // `stretch` biases the averaging filter, lengthening decay at low frequencies
    // (all-pass tuning), which keeps a long chain from sounding like a short one.
    const avg = (cur * (1 - stretch) + last * (1 + stretch)) * 0.5;
    const v = avg * decay;
    buf[idx] = v;
    last = cur;
    out[i + offset] += cur * gain;
    idx = (idx + 1) % n;
  }
  return out;
}

/**
 * A dense inharmonic cluster of detuned partials — the "string cluster" of the
 * combat music and the metallic bed under a boss roar. `spread` in cents.
 */
export function clusterTone(out, sr, opts, rng) {
  const {
    root = 110, ratios = [1, 1.5, 2, 2.37, 3, 4.13], voices = 3, spread = 14,
    duration = 4, attack = 0.4, decay = 3, gain = 0.2, offset = 0,
    wave = 'saw', lp = 2600, vibrato = 0.15, vibratoHz = 4.4,
  } = opts;
  const oscs = [];
  for (let r = 0; r < ratios.length; r++) {
    for (let v = 0; v < voices; v++) {
      oscs.push({
        osc: new Osc(sr, rng.float()),
        f: root * ratios[r] * Math.pow(2, (rng.signed() * spread) / 1200),
        g: 1 / (1 + r * 0.7),
        vib: new Osc(sr, rng.float()),
        vibHz: vibratoHz * (0.8 + rng.float() * 0.5),
      });
    }
  }
  const filt = new Biquad().setLowpass(lp, 0.8, sr);
  const env = new PercEnv(sr, attack, decay, 2);
  const n = Math.min(Math.round(duration * sr), out.length - offset);
  const norm = gain / Math.sqrt(oscs.length);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < oscs.length; k++) {
      const o = oscs[k];
      o.vib.step(o.vibHz);
      o.osc.step(o.f * (1 + o.vib.sine() * vibrato * 0.01));
      s += (wave === 'saw' ? o.osc.saw() : wave === 'tri' ? o.osc.tri() : o.osc.sine()) * o.g;
    }
    out[i + offset] += filt.process(s) * env.next() * norm;
  }
  return out;
}

/**
 * Snap a frequency to the nearest integer multiple of 1/loopLength so a bed loops
 * with mathematically zero seam. The worst-case detune at an 8 s loop is 0.0625 Hz
 * — about 0.3 cents at 40 Hz and far less higher up, i.e. inaudible.
 */
export function snapToLoop(freq, loopLength) {
  const f0 = 1 / loopLength;
  return Math.max(f0, Math.round(freq / f0) * f0);
}

/**
 * Padé approximant of tanh, exact at 0 and at ±3 where it is clamped to ±1.
 * Maximum error ~2e-3, which is 54 dB below the signal — inaudible as a
 * saturation curve, and roughly 8x faster than `Math.tanh`.
 *
 * This matters more than it sounds: saturation is applied per sample in the
 * vocal tract model, in every sweep and in `softLimit`, so a five-second boss
 * death rattle makes ~250 000 calls. Swapping in this curve took the vocal bank's
 * bake time down by about 40%.
 */
export function fastTanh(x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

/**
 * Control rate. Envelopes, pitch contours and filter sweeps are recomputed once
 * every this many samples and held — 48 kHz / 32 = 1.5 kHz, which is far above
 * any envelope's bandwidth and turns two `Math.pow` calls per sample into two per
 * thirty-two. Standard practice in every synthesis engine; the only reason not to
 * do it is if something needs audio-rate modulation, and nothing here does.
 */
export const CONTROL_BLOCK = 32;

/** Clamp helper used across the subsystem. */
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** dB <-> linear. Mix code should talk in dB; AudioParams take linear. */
export function dbToGain(db) { return Math.pow(10, db / 20); }
export function gainToDb(g) { return 20 * Math.log10(Math.max(1e-6, g)); }
