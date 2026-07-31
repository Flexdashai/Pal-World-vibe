/**
 * music.js — the adaptive score.
 *
 * Four sustained layers plus a scheduled percussion track, all driven by one
 * number: combat intensity, which rises on hits, kills and casts and decays when
 * the room goes quiet. Nothing here polls another subsystem; `index.js` feeds
 * intensity from the event bus and this file decides what that should sound like.
 *
 *   drone     always audible. D1 sub + a detuned D2 pair through a slow filter.
 *   tension   a minor-second cluster, entering around 25% intensity. Its whole
 *             job is to be uncomfortable without being noticeable.
 *   strings   a rising tremolo cluster from ~55% intensity; this is the layer the
 *             player actually hears arrive.
 *   choir     boss only. Formant voices on the same D-Aeolian stack as ARISE.
 *   percussion a scheduled pattern that gains subdivisions as intensity climbs.
 *
 * ── Why the sustained layers are baked loops ─────────────────────────
 * A live oscillator bank for the strings layer is ~18 oscillators plus filters
 * running forever, on the main thread, in a browser that is also software-
 * rasterising a dungeon. Baking two bars once and looping the buffer costs one
 * AudioBufferSourceNode per layer and zero ongoing synthesis. The loop is
 * seamless because every partial's frequency is snapped to an exact multiple of
 * the loop's fundamental (see `snapToLoop`) and the noise components are
 * crossfaded through `foldTailIntoHead`.
 *
 * ── Why percussion is scheduled and not baked ────────────────────────
 * Because it has to *change*. A baked percussion loop cannot add a sixteenth-note
 * fill the moment a fight escalates, and the escalation is the entire point.
 */

import {
  Sig, Noise, Osc, Biquad, SVF, CONTROL_BLOCK, snapToLoop, foldTailIntoHead,
  normalizePeak, softLimit, clamp,
} from './dsp.js';
import { buildChoirCluster } from './vocal.js';

/** 84 BPM — slow enough to feel like dread, fast enough that a sixteenth-note
 *  layer reads as urgency rather than as a machine gun. */
export const BPM = 84;
export const BEAT = 60 / BPM;
export const STEP = BEAT / 4;          // sixteenth note
export const BARS = 2;
export const LOOP = BEAT * 4 * BARS;   // 5.714 s
const STEPS_PER_LOOP = 16 * BARS;

/** D Aeolian. The same root as ARISE so the cue lands inside the score's key. */
const ROOT = 36.7081;                  // D1

/* ================================================================== */
/* 1. Layer synthesis                                                 */
/* ================================================================== */

/** Common preamble: allocate a loop buffer with room for the crossfade tail. */
function loopSig(sr, fadeSec) {
  return Sig.seconds(sr, LOOP + fadeSec, 2);
}

/** Finish a loop layer: fold the tail into the head and normalise. */
function finishLoop(sig, sr, fadeSec, peak) {
  const folded = foldTailIntoHead(sig, Math.round(fadeSec * sr));
  softLimit(folded, 1.05);
  normalizePeak(folded, peak);
  return folded;
}

/**
 * Layer 1 — the drone. A sub sine, a detuned saw pair a fifth apart, and a slow
 * sweeping formant-ish band. Its filter LFO completes exactly two cycles per loop
 * so the movement lines up with the bar.
 */
function bakeDrone(sr, rng) {
  const fade = 0.6;
  const sig = loopSig(sr, fade);
  const L = sig.data[0], R = sig.data[1];
  const n = sig.length;
  const noise = new Noise(rng);

  const subF = snapToLoop(ROOT, LOOP);
  const sawA = snapToLoop(ROOT * 2 * Math.pow(2, 7 / 1200), LOOP);
  const sawB = snapToLoop(ROOT * 2 * Math.pow(2, -9 / 1200), LOOP);
  const fifth = snapToLoop(ROOT * 3, LOOP);         // A2, a just fifth above D1
  const lfoF = 2 / LOOP;                            // exactly two cycles per loop

  const sub = new Osc(sr, 0), a = new Osc(sr, rng.float()), b = new Osc(sr, rng.float());
  const fi = new Osc(sr, rng.float()), lfo = new Osc(sr, 0);
  const svfL = new SVF(), svfR = new SVF();
  const hiss = new Biquad().setBandpass(2200, 0.6, sr);

  let cut = 500;
  for (let i = 0; i < n; i++) {
    if ((i % CONTROL_BLOCK) === 0) {
      lfo.step(lfoF * CONTROL_BLOCK);
      cut = 240 + (lfo.sine() * 0.5 + 0.5) * 520;
    }
    sub.step(subF); a.step(sawA); b.step(sawB); fi.step(fifth);
    // The saws carry the harmonic content; the sub carries the weight. Keeping
    // them separate means the filter can move without thinning the bottom.
    const body = a.saw() * 0.5 + b.saw() * 0.45 + fi.saw() * 0.22;
    svfL.process(body, cut, 1.5, sr);
    svfR.process(body, cut * 1.09, 1.5, sr);
    const air = hiss.process(noise.pink()) * 0.05;
    const subv = sub.sine() * 0.55;
    L[i] = svfL.low * 0.6 + subv + air;
    R[i] = svfR.low * 0.6 + subv + air * 0.9;
  }
  return finishLoop(sig, sr, fade, 0.82);
}

/**
 * Layer 2 — tension. A cluster of minor seconds two octaves up, very quiet, with
 * a slow amplitude beat between the voices. Deliberately almost inaudible in
 * isolation: it works by making the drone feel wrong.
 */
function bakeTension(sr, rng) {
  const fade = 0.8;
  const sig = loopSig(sr, fade);
  const L = sig.data[0], R = sig.data[1];
  const n = sig.length;

  // D4, Eb4, A4, Bb4 — two minor seconds, the most unstable interval available.
  const notes = [293.66, 311.13, 440.0, 466.16];
  const voices = [];
  for (let k = 0; k < notes.length; k++) {
    for (let v = 0; v < 2; v++) {
      voices.push({
        osc: new Osc(sr, rng.float()),
        f: snapToLoop(notes[k] * Math.pow(2, (v === 0 ? -6 : 6) / 1200), LOOP),
        // Each voice breathes at its own rate, snapped so the whole layer loops.
        amp: new Osc(sr, rng.float()),
        ampF: snapToLoop(0.18 + rng.float() * 0.3, LOOP),
        pan: (k / (notes.length - 1) - 0.5) * 1.5,
      });
    }
  }
  const lpL = new Biquad().setLowpass(2400, 0.8, sr);
  const lpR = new Biquad().setLowpass(2400, 0.8, sr);
  for (let i = 0; i < n; i++) {
    let sl = 0, sr2 = 0;
    for (let k = 0; k < voices.length; k++) {
      const v = voices[k];
      v.osc.step(v.f);
      v.amp.step(v.ampF);
      const g = (0.35 + 0.65 * (v.amp.sine() * 0.5 + 0.5)) / voices.length;
      const s = v.osc.tri() * g;
      sl += s * Math.sqrt(clamp(0.5 * (1 - v.pan), 0, 1));
      sr2 += s * Math.sqrt(clamp(0.5 * (1 + v.pan), 0, 1));
    }
    L[i] = lpL.process(sl);
    R[i] = lpR.process(sr2);
  }
  return finishLoop(sig, sr, fade, 0.5);
}

/**
 * Layer 3 — the rising string cluster. Bowed-ish saws with a tremolo locked to
 * the eighth note, plus a slow upward glissando across the loop that resets at
 * the seam. The reset is masked by the crossfade and reads as a repeating swell,
 * which is exactly the effect a Hollywood string riser has.
 */
function bakeStrings(sr, rng) {
  const fade = 1.0;
  const sig = loopSig(sr, fade);
  const L = sig.data[0], R = sig.data[1];
  const n = sig.length;

  // D3 F3 A3 D4 Bb3 — the Aeolian stack again, an octave up from the drone.
  const notes = [146.83, 174.61, 220.0, 293.66, 233.08];
  const voices = [];
  for (let k = 0; k < notes.length; k++) {
    for (let v = 0; v < 2; v++) {
      voices.push({
        osc: new Osc(sr, rng.float()),
        base: snapToLoop(notes[k], LOOP) * Math.pow(2, (rng.signed() * 11) / 1200),
        g: 1 / (1 + k * 0.35),
        pan: rng.signed() * 0.85,
        gl: 0, gr: 0,
      });
    }
  }
  for (const v of voices) {
    v.gl = Math.sqrt(clamp(0.5 * (1 - v.pan), 0, 1));
    v.gr = Math.sqrt(clamp(0.5 * (1 + v.pan), 0, 1));
  }
  // Bow noise: real strings hiss, and it is most of why a sampled string library
  // sounds alive where a saw does not. One shared hiss per side rather than one
  // per voice — the ear cannot separate ten decorrelated hisses anyway, and the
  // per-voice version cost more than the ten oscillators put together.
  const bow = new Noise(rng);
  const bowL = new Biquad().setBandpass(3400, 1.4, sr);
  const bowR = new Biquad().setBandpass(4100, 1.4, sr);
  const trem = new Osc(sr, 0);
  const tremF = Math.round(LOOP / (BEAT / 2)) / LOOP;  // eighth notes, snapped
  const swell = new Osc(sr, 0);
  const svfL = new SVF(), svfR = new SVF();
  const norm = 1 / Math.sqrt(voices.length);

  let glide = 1, cut = 2500, tr = 1;
  for (let i = 0; i < n; i++) {
    trem.step(tremF);
    tr = 0.72 + 0.28 * (trem.sine() * 0.5 + 0.5);
    if ((i % CONTROL_BLOCK) === 0) {
      const t = (i / sr) / LOOP;
      // Glissando: a semitone up across the loop. Small enough to read as tension
      // rather than as a key change.
      glide = Math.pow(2, (t % 1) * (1 / 12));
      swell.step((1 / LOOP) * CONTROL_BLOCK);
      // Filter opens across the loop with the swell — brightness is what the ear
      // reads as "louder" long before the fader moves.
      cut = 700 + (swell.sine() * 0.5 + 0.5) * 3600;
    }
    let sl = 0, sr2 = 0;
    for (let k = 0; k < voices.length; k++) {
      const v = voices[k];
      v.osc.step(v.base * glide);
      const s = v.osc.saw() * v.g * tr;
      sl += s * v.gl;
      sr2 += s * v.gr;
    }
    const hiss = bow.white();
    svfL.process((sl * 0.7 + bowL.process(hiss) * 0.4) * norm, cut, 1.1, sr);
    svfR.process((sr2 * 0.7 + bowR.process(hiss) * 0.4) * norm, cut * 1.06, 1.1, sr);
    L[i] = svfL.low;
    R[i] = svfR.low;
  }
  return finishLoop(sig, sr, fade, 0.7);
}

/** Layer 4 — the boss choir. Two bars of sustained voices, crossfaded to loop. */
function bakeChoir(sr, rng) {
  const fade = 1.2;
  const chord = [73.42, 110.0, 146.83, 174.61, 233.08];
  // Build longer than the loop, then fold: the choir's own attack and release
  // become the crossfade material, so the loop point lands mid-phrase.
  const raw = buildChoirCluster(sr, rng, chord, {
    duration: LOOP + fade, attack: 1.4, release: 1.4, vowel: 'u',
    tract: 0.8, voices: 2, gain: 0.75, breath: 0.3, swell: 1.4, detune: 14,
  });  // halfRate + 3 formants by default — see buildChoirCluster
  return finishLoop(raw, sr, fade, 0.62);
}

/* ================================================================== */
/* 2. Percussion patterns                                             */
/* ================================================================== */

/**
 * Patterns are 32 sixteenth-note steps (two bars). Each entry is
 * [step, cue, gain]. Tiers are additive: tier 2 plays tier 1's pattern as well.
 * The escalation is deliberately *rhythmic*, not just louder — a fight that gets
 * denser feels faster even at a fixed tempo.
 */
const PATTERNS = [
  // tier 0 — exploration. A heartbeat on the downbeat of each bar.
  [[0, 'music.kick', 0.7], [16, 'music.kick', 0.55]],
  // tier 1 — contact. Adds the backbeat and a soft off-beat pulse.
  [[8, 'music.taiko', 0.6], [24, 'music.taiko', 0.7], [12, 'music.kick', 0.35], [28, 'music.kick', 0.4]],
  // tier 2 — engaged. Eighth-note taiko drive and metal accents.
  [[4, 'music.shaker', 0.4], [12, 'music.shaker', 0.45], [20, 'music.shaker', 0.4], [28, 'music.shaker', 0.5],
   [6, 'music.metal', 0.32], [22, 'music.metal', 0.36], [2, 'music.tom', 0.3]],
  // tier 3 — overwhelming. Sixteenth ghost notes and a two-bar fill.
  [[14, 'music.tom', 0.45], [15, 'music.tom', 0.35], [30, 'music.tom', 0.5], [31, 'music.tom', 0.6],
   [10, 'music.shaker', 0.3], [26, 'music.shaker', 0.32], [18, 'music.metal', 0.3],
   [7, 'music.kick', 0.3], [23, 'music.kick', 0.32]],
];

/* ================================================================== */
/* 3. The director                                                    */
/* ================================================================== */

export class MusicDirector {
  /**
   * @param audioCtx running AudioContext
   * @param mixer    Mixer instance (music bus, reverb send)
   * @param bank     SoundBank, for the percussion one-shots
   * @param rng      forked deterministic stream
   * @param budget   quality budget
   */
  constructor(audioCtx, mixer, bank, rng, budget) {
    this.ac = audioCtx;
    this.mixer = mixer;
    this.bank = bank;
    this.rng = rng;
    this.budget = budget;
    this.sr = audioCtx.sampleRate;

    this.intensity = 0;
    this.target = 0;
    this.boss = false;
    this.enabled = true;
    /** Set while the ARISE cue owns the mix; the score gets out of the way. */
    this.suppressed = 0;

    // One gain per layer, permanently wired. Sources are attached when their
    // buffer finishes baking, so a layer that is not ready yet is simply silent.
    this.layers = {};
    const defs = [
      ['drone', bakeDrone, 0.0],
      ['tension', bakeTension, 0.0],
      ['strings', bakeStrings, 0.0],
      ['choir', bakeChoir, 0.0],
    ];
    this.jobs = [];
    for (const [name, bake, g] of defs) {
      // The third layer is the most expensive to bake and the least essential;
      // low presets skip it entirely.
      if (name === 'strings' && !budget.fullMusic) continue;
      const gain = audioCtx.createGain();
      gain.gain.value = g;
      gain.connect(mixer.musicIn);
      // Every layer also feeds the reverb, at a fixed low level: the score should
      // sit in the same room as the game, or the mix splits in two.
      const send = audioCtx.createGain();
      send.gain.value = name === 'choir' ? 0.35 : 0.16;
      gain.connect(send);
      send.connect(mixer.reverb.send);
      this.layers[name] = { gain, send, source: null, buffer: null, target: 0 };
      this.jobs.push({ name, bake });
    }

    /* percussion scheduling state */
    this.step = 0;
    this.nextStepTime = 0;
    this.started = false;
    this.percussionGain = audioCtx.createGain();
    this.percussionGain.gain.value = 0;
    this.percussionGain.connect(mixer.musicIn);
    this.percussionSend = audioCtx.createGain();
    this.percussionSend.gain.value = 0.22;
    this.percussionGain.connect(this.percussionSend);
    this.percussionSend.connect(mixer.reverb.send);

    this._onEnded = (e) => { try { e.target.disconnect(); } catch { /* closed */ } };
    this.scheduled = 0;
  }

  /** Bake pending layers within a time budget. Returns work done in ms. */
  pump(ms) {
    if (!this.jobs.length) return 0;
    const t0 = performance.now();
    while (this.jobs.length && performance.now() - t0 < ms) {
      const job = this.jobs.shift();
      const layer = this.layers[job.name];
      if (!layer) continue;
      try {
        const sig = job.bake(this.sr, this.rng.fork());
        layer.buffer = sig.toAudioBuffer(this.ac);
        layer.bytes = sig.bytes;
        this._startLayer(job.name);
      } catch (err) {
        console.warn(`[audio] music layer "${job.name}" failed`, err);
      }
    }
    return performance.now() - t0;
  }

  _startLayer(name) {
    const layer = this.layers[name];
    if (!layer?.buffer || layer.source) return;
    const src = this.ac.createBufferSource();
    src.buffer = layer.buffer;
    src.loop = true;
    src.connect(layer.gain);
    // All layers start on the same context time boundary so they stay phase
    // locked with each other and with the percussion grid forever.
    const t = this._gridTime();
    try { src.start(t); } catch { src.start(); }
    layer.source = src;
  }

  /** Next loop-aligned context time, so a late-baked layer still lands on grid. */
  _gridTime() {
    const now = this.ac.currentTime + 0.06;
    if (!this.origin) this.origin = now;
    const k = Math.ceil((now - this.origin) / LOOP);
    return this.origin + k * LOOP;
  }

  /** Combat intensity target, 0..1. Set by the event wiring in index.js. */
  setTarget(v) { this.target = clamp(v, 0, 1); }
  setBoss(v) { this.boss = !!v; }

  /**
   * Per-frame. `dt` is unscaled wall time — the music must not slow down during
   * hit-stop, or every impact sounds like the tape stopped.
   */
  update(dt) {
    // Rise fast, fall slow. A fight that flares should be met immediately; a
    // fight that ends should decay over ~8 s so the room does not go dead.
    const rate = this.target > this.intensity ? 2.6 : 0.16;
    this.intensity += (this.target - this.intensity) * clamp(dt * rate, 0, 1);
    if (this.suppressed > 0) this.suppressed = Math.max(0, this.suppressed - dt);

    const I = this.intensity;
    const suppress = this.suppressed > 0 ? 0.25 : 1;

    // Layer levels. Each uses a smoothstep window so a layer fades in over a band
    // of intensity rather than switching on at a threshold.
    const band = (lo, hi) => {
      const x = clamp((I - lo) / (hi - lo), 0, 1);
      return x * x * (3 - 2 * x);
    };
    this._setLayer('drone', (0.55 + 0.3 * band(0.0, 0.6)) * suppress);
    this._setLayer('tension', band(0.18, 0.55) * 0.75 * suppress);
    this._setLayer('strings', band(0.5, 0.92) * 0.85 * suppress);
    this._setLayer('choir', (this.boss ? band(0.25, 0.7) : 0) * 0.8 * suppress);

    const perc = band(0.16, 0.45) * 0.85 * suppress;
    this.percussionGain.gain.setTargetAtTime(perc, this.ac.currentTime, 0.5);
  }

  _setLayer(name, target) {
    const layer = this.layers[name];
    if (!layer) return;
    if (Math.abs(layer.target - target) < 0.004) return;
    layer.target = target;
    // setTargetAtTime with a 0.8 s constant: musical fades, not automation jumps.
    layer.gain.gain.setTargetAtTime(target, this.ac.currentTime, 0.8);
  }

  /**
   * Percussion lookahead scheduler. Called from the audio clock tick, not from
   * the render frame: at one frame per second on this container a frame-driven
   * scheduler would produce a stuttering pulse, and on real hardware it would jitter.
   */
  schedule(lookahead = 0.35) {
    if (!this.enabled) return;
    const now = this.ac.currentTime;
    if (!this.started) {
      this.nextStepTime = this._gridTime();
      this.started = true;
    }
    // Catch up if the tab was backgrounded — never try to replay the missed bars.
    if (this.nextStepTime < now - 0.5) {
      const skipped = Math.ceil((now - this.nextStepTime) / STEP);
      this.nextStepTime += skipped * STEP;
      this.step += skipped;
    }
    while (this.nextStepTime < now + lookahead) {
      this._scheduleStep(this.step % STEPS_PER_LOOP, this.nextStepTime);
      this.nextStepTime += STEP;
      this.step++;
    }
  }

  _scheduleStep(step, when) {
    const I = this.intensity;
    if (I < 0.06 && !this.boss) return;
    // Tier from intensity; the boss fight is always at least tier 2.
    let tier = I < 0.22 ? 0 : I < 0.5 ? 1 : I < 0.78 ? 2 : 3;
    if (this.boss) tier = Math.max(tier, 2);
    for (let t = 0; t <= tier; t++) {
      const pattern = PATTERNS[t];
      for (let k = 0; k < pattern.length; k++) {
        const [s, cue, g] = pattern[k];
        if (s !== step) continue;
        // Humanise: +/-6 ms and +/-15% velocity. A perfectly quantised drum
        // machine under a dark-fantasy fight sounds like a placeholder.
        const jitter = this.rng.signed() * 0.006;
        const vel = g * (0.85 + this.rng.float() * 0.3) * (0.6 + I * 0.6);
        this._hit(cue, when + jitter, vel);
      }
    }
  }

  _hit(cue, when, gain) {
    const entry = this.bank.get(cue, this.rng.u32() % this.bank.variantsOf(cue));
    if (!entry?.buffer) return;
    const src = this.ac.createBufferSource();
    src.buffer = entry.buffer;
    // A little pitch variation per hit; drums that are pitch-identical every bar
    // are the loudest possible "this is a sample" tell.
    src.playbackRate.value = Math.pow(2, (this.rng.signed() * 0.6) / 12);
    const g = this.ac.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.percussionGain);
    src.onended = this._onEnded;
    try { src.start(Math.max(when, this.ac.currentTime)); } catch { /* context closed */ }
    this.scheduled++;
  }

  /** Push the score out of the way for `seconds` — used by the ARISE cue. */
  suppress(seconds) { this.suppressed = Math.max(this.suppressed, seconds); }

  stats() {
    let bytes = 0, ready = 0;
    for (const k in this.layers) { bytes += this.layers[k].bytes ?? 0; if (this.layers[k].source) ready++; }
    return {
      intensity: +this.intensity.toFixed(3),
      target: +this.target.toFixed(3),
      boss: this.boss,
      layers: ready,
      pending: this.jobs.length,
      scheduled: this.scheduled,
      megabytes: +(bytes / (1 << 20)).toFixed(2),
    };
  }

  dispose() {
    for (const k in this.layers) {
      const l = this.layers[k];
      try { l.source?.stop(); l.source?.disconnect(); l.gain.disconnect(); l.send.disconnect(); } catch { /* closed */ }
    }
    try { this.percussionGain.disconnect(); this.percussionSend.disconnect(); } catch { /* closed */ }
    this.jobs.length = 0;
  }
}
