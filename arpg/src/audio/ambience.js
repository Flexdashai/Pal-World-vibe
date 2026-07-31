/**
 * ambience.js — the crypt bed and its scattered events.
 *
 * Two halves, and they do different jobs:
 *
 *   THE BED is a seamless stereo loop: a sub rumble, two independently wandering
 *   wind bands, and a handful of very quiet resonators tuned to the room's air
 *   modes. The resonators are the part that matters — noise through a filter
 *   sounds like noise through a filter, but noise exciting a set of low-Q modes
 *   sounds like *a space*, because that is literally what a room does to noise.
 *
 *   THE SCATTER is everything you actually notice: drips, distant stone settling,
 *   brazier crackle, a gust finding a gap in the masonry. All of it is randomised
 *   in time from `ctx.rng` and placed in the world around the listener, so it is
 *   spatialised and occluded like any other sound. A drip that always comes from
 *   the centre of the stereo field is a menu, not a dungeon.
 *
 * The scatter's weighting changes with the room type, which is the cheapest way to
 * make a corridor and a cathedral feel different before the reverb even changes.
 */

import {
  Sig, Noise, Osc, Biquad, SVF, Resonator, CONTROL_BLOCK,
  foldTailIntoHead, normalizePeak, softLimit, resampleLinear, clamp,
} from './dsp.js';

const LOOP = 9.4;   // seconds of raw material
const FADE = 1.6;   // crossfade -> 7.8 s seamless loop

/**
 * Event weighting per room. Numbers are relative probabilities; a corridor drips
 * and a cathedral howls.
 */
const SCATTER = {
  crypt:     { 'amb.drip': 5.0, 'amb.settle': 1.4, 'amb.crackle': 2.0, 'amb.howl': 0.7, 'amb.chain': 1.0 },
  cathedral: { 'amb.drip': 2.0, 'amb.settle': 1.6, 'amb.crackle': 2.4, 'amb.howl': 2.6, 'amb.chain': 1.4 },
  arena:     { 'amb.drip': 1.2, 'amb.settle': 2.6, 'amb.crackle': 2.2, 'amb.howl': 1.6, 'amb.chain': 2.2 },
  open:      { 'amb.drip': 0.6, 'amb.settle': 1.0, 'amb.crackle': 1.0, 'amb.howl': 3.6, 'amb.chain': 0.8 },
};

/**
 * Bake the bed. `character` shifts the wind band and the room modes so the crypt
 * bed and the cathedral bed are genuinely different recordings, not the same one
 * at a different volume.
 */
export function bakeBed(sampleRate, rng, character = 'crypt') {
  const big = character === 'cathedral' || character === 'arena';
  // Half rate, like the choir. The bed's highest component is a 5 kHz "air" band
  // and everything else lives under 1.5 kHz, so 24 kHz internally is transparent
  // and halves the cost of the single largest background bake in the subsystem.
  const sr = sampleRate > 32000 ? sampleRate / 2 : sampleRate;
  const sig = Sig.seconds(sr, LOOP + FADE, 2);
  const L = sig.data[0], R = sig.data[1];
  const n = sig.length;
  const noise = new Noise(rng);

  /* sub rumble — the mass of stone above you */
  const subFilt = new Biquad().setLowpass(big ? 46 : 62, 0.9, sr);
  const subLfo = new Osc(sr, rng.float());

  /* two wind bands, wandering independently per ear */
  const windL = new SVF(), windR = new SVF();
  let wanderL = 0, wanderR = 0;
  const windBase = big ? 240 : 420;
  const windSpan = big ? 900 : 620;

  /* room modes — Helmholtz-ish resonances of the actual volume */
  const modeF = big ? [31.7, 48.3, 71.9, 104.6] : [58.4, 87.1, 133.7, 191.2];
  const modes = [];
  for (let i = 0; i < modeF.length; i++) {
    const res = new Resonator().set(modeF[i] * (1 + rng.signed() * 0.02), big ? 2.4 : 1.1, sr);
    modes.push({ res, g: 0.32 / (1 + i * 0.8) });
  }
  const modeDrive = new Biquad().setLowpass(260, 0.7, sr);

  /* a very distant, very quiet high band — the "air" of the space */
  const airL = new Biquad().setBandpass(big ? 3400 : 5200, 0.7, sr);
  const airR = new Biquad().setBandpass(big ? 3100 : 4800, 0.7, sr);

  let fL = windBase + 60, fR = windBase + 60, subLfoV = 0.5;
  for (let i = 0; i < n; i++) {
    const w = noise.white();
    const p = noise.pink();

    // Random-walk the wind centre frequency. A sine-modulated filter reads as a
    // machine; a random walk reads as weather. The walk itself is audio-rate
    // (it is integrating noise) but the *filter cutoff* it drives is sampled at
    // control rate — over half a million samples that is half a million Math.sin
    // calls avoided inside the SVF.
    wanderL = wanderL * 0.99985 + w * 0.00015;
    wanderR = wanderR * 0.99985 + noise.white() * 0.00015;
    if ((i % CONTROL_BLOCK) === 0) {
      subLfo.step(0.07 * CONTROL_BLOCK);
      subLfoV = 0.5 + 0.5 * (subLfo.sine() * 0.5 + 0.5);
      fL = Math.max(70, windBase + clamp(wanderL, -1, 1) * windSpan + 60);
      fR = Math.max(70, windBase + clamp(wanderR, -1, 1) * windSpan + 60);
    }
    const sub = subFilt.process(noise.brown()) * subLfoV;
    windL.process(p * 3.2, fL, 2.4, sr);
    windR.process(noise.pink() * 3.2, fR, 2.4, sr);

    const drive = modeDrive.process(w * 0.25);
    let modal = 0;
    for (let m = 0; m < modes.length; m++) modal += modes[m].res.process(drive) * modes[m].g;

    L[i] = sub * 0.7 + windL.band * 0.5 + modal + airL.process(p) * 0.06;
    R[i] = sub * 0.68 + windR.band * 0.5 + modal * 0.94 + airR.process(noise.pink()) * 0.06;
  }

  const folded = foldTailIntoHead(sig, Math.round(FADE * sr));
  if (sr === sampleRate) {
    softLimit(folded, 1.02);
    normalizePeak(folded, 0.55);
    return folded;
  }
  const ratio = sr / sampleRate;
  const up = new Sig(sampleRate, Math.round(folded.length / ratio), 2);
  for (let c = 0; c < 2; c++) up.data[c].set(resampleLinear(folded.data[c], ratio).subarray(0, up.length));
  softLimit(up, 1.02);
  normalizePeak(up, 0.55);
  return up;
}

export class AmbienceDirector {
  /**
   * @param playFn  (cue, opts) => voice|null — the spatial play entry point owned
   *                by index.js. Injected rather than imported so this file never
   *                needs to know how a voice is allocated.
   */
  constructor(audioCtx, mixer, bank, rng, budget, playFn) {
    this.ac = audioCtx;
    this.mixer = mixer;
    this.bank = bank;
    this.rng = rng;
    this.budget = budget;
    this.play = playFn;
    this.sr = audioCtx.sampleRate;

    this.room = 'crypt';
    this.enabled = true;
    this.intensity = 0;      // combat intensity; ambience recedes during a fight

    this.bedGain = audioCtx.createGain();
    this.bedGain.gain.value = 0;
    this.bedGain.connect(mixer.ambIn);
    this.bedSend = audioCtx.createGain();
    this.bedSend.gain.value = 0.25;
    this.bedGain.connect(this.bedSend);
    this.bedSend.connect(mixer.reverb.send);

    /** Two bed slots so a room change can crossfade between characters. */
    this.beds = new Map();
    this.bedSource = null;
    this.bedCharacter = null;

    this.jobs = [{ character: 'crypt' }];
    this.nextEvent = 1.5;
    this.fired = 0;

    /** Positions of fire sources, if anyone tells us. `world` or `fx` may call
     *  `setFireSources` with brazier positions; until then crackle is placed in a
     *  ring around the listener, which is convincing enough that nobody has ever
     *  noticed in playtest. */
    this.fireSources = null;
    this._pos = { x: 0, y: 0, z: 0 };
    // Preallocated playback options — rule 5 applies to the scheduler too, even
    // though it only fires a few times a minute.
    this._opts = { position: this._pos, gain: 1, pitch: 0 };
  }

  /** Bake pending beds within a time budget. */
  pump(ms) {
    if (!this.jobs.length) return 0;
    const t0 = performance.now();
    while (this.jobs.length && performance.now() - t0 < ms) {
      const job = this.jobs.shift();
      if (this.beds.has(job.character)) continue;
      try {
        const sig = bakeBed(this.sr, this.rng.fork(), job.character);
        const buf = sig.toAudioBuffer(this.ac);
        buf.mnBytes = sig.bytes;
        this.beds.set(job.character, buf);
        if (!this.bedSource) this._startBed(job.character);
      } catch (err) {
        console.warn('[audio] ambience bed failed', err);
      }
    }
    return performance.now() - t0;
  }

  _startBed(character) {
    const buf = this.beds.get(character);
    if (!buf) return;
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.bedGain);
    // Random start offset so two sessions never open on the same gust.
    try { src.start(this.ac.currentTime + 0.05, this.rng.float() * buf.duration); } catch { src.start(); }
    if (this.bedSource) {
      const old = this.bedSource;
      try { old.stop(this.ac.currentTime + 2.2); } catch { /* closed */ }
    }
    this.bedSource = src;
    this.bedCharacter = character;
    this.bedGain.gain.setTargetAtTime(1, this.ac.currentTime, 1.2);
  }

  /** Follow the reverb's room. A big room gets the big bed. */
  setRoom(room) {
    if (room === this.room) return;
    this.room = room;
    const character = room === 'cathedral' || room === 'arena' ? 'cathedral' : room === 'open' ? 'open' : 'crypt';
    if (character === this.bedCharacter) return;
    if (this.beds.has(character)) this._startBed(character);
    else this.jobs.push({ character });
  }

  setIntensity(v) { this.intensity = clamp(v, 0, 1); }

  /**
   * Positions of live fire sources so brazier crackle comes from the brazier.
   * @param {Array<{x:number,y:number,z:number}>|null} list
   */
  setFireSources(list) { this.fireSources = list && list.length ? list : null; }

  /**
   * @param dt seconds of wall time
   * @param listener {x,y,z} world position of the ear
   */
  tick(dt, listener) {
    if (!this.enabled) return;
    // The bed pulls back during combat so the fight has room, and comes back up
    // in the silence afterwards — the contrast is what sells the silence.
    const bedTarget = this.bedSource ? 1 - this.intensity * 0.45 : 0;
    this.bedGain.gain.setTargetAtTime(bedTarget, this.ac.currentTime, 1.5);

    this.nextEvent -= dt;
    if (this.nextEvent > 0) return;

    // Poisson-ish spacing: exponential inter-arrival times around the configured
    // rate. Uniform spacing sounds scheduled, which it is, and you can hear it.
    const perMinute = this.budget.ambienceDensity * (1 - this.intensity * 0.5);
    const mean = 60 / Math.max(2, perMinute);
    this.nextEvent = mean * (0.35 + -Math.log(1 - this.rng.float() * 0.95) * 0.9);

    const cue = this._pickCue();
    if (!cue) return;
    this._placeFor(cue, listener);
    this._opts.gain = 0.6 + this.rng.float() * 0.5;
    this._opts.pitch = this.rng.signed() * 3;
    this.play(cue, this._opts);
    this.fired++;
  }

  _pickCue() {
    const table = SCATTER[this.room] ?? SCATTER.crypt;
    let total = 0;
    for (const k in table) total += table[k];
    let r = this.rng.float() * total;
    for (const k in table) {
      r -= table[k];
      if (r <= 0) return k;
    }
    return 'amb.drip';
  }

  _placeFor(cue, listener) {
    const lx = listener?.x ?? 0, ly = listener?.y ?? 0, lz = listener?.z ?? 0;
    if (cue === 'amb.crackle' && this.fireSources) {
      const f = this.fireSources[this.rng.u32() % this.fireSources.length];
      this._pos.x = f.x; this._pos.y = f.y; this._pos.z = f.z;
      return;
    }
    // Distance band per cue: a drip is close and above you, a settle is far and
    // below, a howl is very far. Getting these bands right is most of what makes
    // ambience feel like it has a shape.
    let rMin = 3, rMax = 9, yMin = 0.2, yMax = 2.4;
    if (cue === 'amb.settle') { rMin = 10; rMax = 26; yMin = -1; yMax = 1.5; }
    else if (cue === 'amb.howl') { rMin = 14; rMax = 30; yMin = 1.5; yMax = 5; }
    else if (cue === 'amb.crackle') { rMin = 3; rMax = 11; yMin = 0.6; yMax = 1.6; }
    else if (cue === 'amb.chain') { rMin = 4; rMax = 14; yMin = 1.8; yMax = 4.5; }
    else if (cue === 'amb.drip') { rMin = 2.5; rMax = 10; yMin = 1.6; yMax = 3.2; }
    const a = this.rng.float() * Math.PI * 2;
    const r = rMin + this.rng.float() * (rMax - rMin);
    this._pos.x = lx + Math.cos(a) * r;
    this._pos.y = ly + yMin + this.rng.float() * (yMax - yMin);
    this._pos.z = lz + Math.sin(a) * r;
  }

  stats() {
    let bytes = 0;
    for (const b of this.beds.values()) bytes += b.mnBytes ?? 0;
    return {
      room: this.room,
      bed: this.bedCharacter,
      beds: this.beds.size,
      pending: this.jobs.length,
      fired: this.fired,
      nextIn: +this.nextEvent.toFixed(2),
      megabytes: +(bytes / (1 << 20)).toFixed(2),
    };
  }

  dispose() {
    try {
      this.bedSource?.stop();
      this.bedSource?.disconnect();
      this.bedGain.disconnect();
      this.bedSend.disconnect();
    } catch { /* context closed */ }
    this.beds.clear();
    this.jobs.length = 0;
  }
}
