/**
 * mixer.js — the bus topology, dynamics and ducking.
 *
 * Signal flow:
 *
 *   sfx voices ─┐
 *               ├─► sfxIn ─► sfxComp ─► sfxTilt ─► sfxGain ──┐
 *   ui voices ──┼─► uiIn  ─────────────────────► uiGain ─────┤
 *   music ──────┼─► musicIn ─► musicDuck ─────► musicGain ───┼─► master ─► limiter ─► out
 *   ambience ───┴─► ambIn  ─► ambDuck ───────► ambGain ──────┤
 *                                                             │
 *   any voice ────► reverb.send ─► convolver A/B ─► return ───┘
 *
 * Three decisions worth explaining:
 *
 * 1. **Compression sits on sfx only.** A crypt bed and a drone are already
 *    controlled; squashing them costs the mix its depth. Combat is the thing with
 *    a 30 dB dynamic range between a footstep and a shadow explosion, so that is
 *    where the 4:1 lives.
 *
 * 2. **Ducking is feed-forward, not sidechained.** A real sidechain compressor
 *    needs the sfx signal routed into a compressor's control input, which the Web
 *    Audio API does not expose. Instead every loud cue declares how much it should
 *    duck (`cues.js`), and the mixer schedules an explicit gain dip on music and
 *    ambience. That is *better* here: the duck can start slightly before the
 *    transient, which no feedback detector can do, and the amount is authored per
 *    cue rather than falling out of a level detector.
 *
 * 3. **The limiter is a DynamicsCompressor with a fast attack and 20:1.** It is
 *    not transparent, but its job is to make an ARISE cue land at full weight
 *    without clipping the DAC, and its pumping is inaudible under a sub-drop.
 */

import { dbToGain, clamp } from './dsp.js';
import { ReverbUnit } from './reverb.js';

/**
 * Default bus trims in dB.
 *
 * Every baked one-shot is peak-normalised to ~0.93, so an untrimmed single sword
 * hit would land at -0.6 dBFS and five overlapping hits would slam the limiter.
 * -9 dB on the sfx bus puts one hit at about -10 dBFS and a dense flurry at -2,
 * which leaves the compressor doing 3-6 dB of gain reduction in a real fight
 * instead of 23. Measured with `stats().reduction` under a twelve-hit burst.
 *
 * The rest of the buses are set relative to that: a footstep ends up ~28 dB under
 * a shadow explosion, and the score never fights a vocalisation.
 */
export const BUS_TRIM = {
  master: 0,
  sfx: -9.0,
  ui: -12.0,
  music: -16.0,
  ambience: -20.0,
  voice: -10.0,
};

export class Mixer {
  /**
   * @param audioCtx  a running (or at least constructed) AudioContext
   * @param rng       deterministic stream, forked by the caller
   * @param budget    from `quality.js` — governs how much of the graph exists
   */
  constructor(audioCtx, rng, budget) {
    const ac = audioCtx;
    this.ac = ac;
    this.budget = budget;
    this.muted = false;
    this._masterTrim = dbToGain(BUS_TRIM.master);

    /* ---- master ---------------------------------------------------- */
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -3.0;
    this.limiter.knee.value = 2.0;
    this.limiter.ratio.value = 20.0;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.16;
    this.limiter.connect(ac.destination);

    this.master = ac.createGain();
    this.master.gain.value = this._masterTrim;
    this.master.connect(this.limiter);

    /* ---- sfx bus --------------------------------------------------- */
    this.sfxComp = ac.createDynamicsCompressor();
    // 3.5:1 at -16 dB with a soft 9 dB knee: glues a flurry of hits together
    // without turning individual transients to mush. 3 ms attack lets the very
    // front of a transient through, which is the whole point of an impact.
    this.sfxComp.threshold.value = -16.0;
    this.sfxComp.knee.value = 9.0;
    this.sfxComp.ratio.value = 3.5;
    this.sfxComp.attack.value = 0.003;
    this.sfxComp.release.value = 0.18;

    // A tilt EQ after the compressor. Compression brings up the noise floor of
    // every hit; a gentle 2.5 dB shelf at 4.5 kHz keeps blades sounding sharp and
    // a small 120 Hz cut stops the low thump of simultaneous hits stacking up.
    this.sfxTilt = ac.createBiquadFilter();
    this.sfxTilt.type = 'highshelf';
    this.sfxTilt.frequency.value = 4500;
    this.sfxTilt.gain.value = 2.5;
    this.sfxLowCut = ac.createBiquadFilter();
    this.sfxLowCut.type = 'peaking';
    this.sfxLowCut.frequency.value = 120;
    this.sfxLowCut.Q.value = 0.8;
    this.sfxLowCut.gain.value = -1.5;

    this.sfxGain = ac.createGain();
    this.sfxGain.gain.value = dbToGain(BUS_TRIM.sfx);

    /**
     * Hit-stop colour. When the engine freezes time on an impact, dipping the sfx
     * bus's brightness for the duration makes the freeze feel like a physical
     * blow rather than a dropped frame. Idle it sits wide open at 20 kHz so it is
     * a no-op.
     */
    this.sfxImpactLp = ac.createBiquadFilter();
    this.sfxImpactLp.type = 'lowpass';
    this.sfxImpactLp.frequency.value = 20000;
    this.sfxImpactLp.Q.value = 0.7;

    this.sfxIn = ac.createGain();
    this.sfxIn.connect(this.sfxComp);
    this.sfxComp.connect(this.sfxLowCut);
    this.sfxLowCut.connect(this.sfxTilt);
    this.sfxTilt.connect(this.sfxImpactLp);
    this.sfxImpactLp.connect(this.sfxGain);
    this.sfxGain.connect(this.master);

    /* ---- voice bus (enemy vocalisations) --------------------------- */
    // Vocals get their own trim and their own path into the sfx compressor, so a
    // boss roar ducks the rest of the sfx bus by compressing it — the one place
    // where letting the compressor do the work is exactly right.
    this.voiceIn = ac.createGain();
    this.voiceIn.gain.value = dbToGain(BUS_TRIM.voice);
    this.voiceIn.connect(this.sfxComp);

    /* ---- ui bus ---------------------------------------------------- */
    this.uiGain = ac.createGain();
    this.uiGain.gain.value = dbToGain(BUS_TRIM.ui);
    this.uiIn = ac.createGain();
    this.uiIn.connect(this.uiGain);
    this.uiGain.connect(this.master);

    /* ---- music bus ------------------------------------------------- */
    this.musicDuck = ac.createGain();
    this.musicDuck.gain.value = 1;
    this.musicGain = ac.createGain();
    this.musicGain.gain.value = dbToGain(BUS_TRIM.music);
    this.musicIn = ac.createGain();
    this.musicIn.connect(this.musicDuck);
    this.musicDuck.connect(this.musicGain);
    this.musicGain.connect(this.master);

    /* ---- ambience bus ---------------------------------------------- */
    this.ambDuck = ac.createGain();
    this.ambDuck.gain.value = 1;
    this.ambGain = ac.createGain();
    this.ambGain.gain.value = dbToGain(BUS_TRIM.ambience);
    this.ambIn = ac.createGain();
    this.ambIn.connect(this.ambDuck);
    this.ambDuck.connect(this.ambGain);
    this.ambGain.connect(this.master);

    /* ---- reverb ---------------------------------------------------- */
    // Returns land on master, NOT on the sfx compressor: a reverb tail feeding a
    // compressor that is being hammered by the dry hits pumps horribly.
    this.reverb = new ReverbUnit(ac, this.master, rng.fork(), budget.maxReverbSeconds);

    /**
     * Ducking state. `_duckUntil` is context time; a new duck only extends, never
     * restarts, so a six-hit flurry does not hold the music down for six times as
     * long as one hit (the same rule the engine applies to hit-stop).
     */
    this._duckAmount = 0;
    this._duckUntil = 0;
    this._lpUntil = 0;

    this.buses = {
      sfx: this.sfxIn, ui: this.uiIn, music: this.musicIn,
      ambience: this.ambIn, voice: this.voiceIn,
    };
  }

  /** Bus input node by name, defaulting to sfx (the only bus a cue can omit). */
  bus(name) { return this.buses[name] ?? this.sfxIn; }

  setBusGain(name, db) {
    const map = {
      master: this.master, sfx: this.sfxGain, ui: this.uiGain,
      music: this.musicGain, ambience: this.ambGain, voice: this.voiceIn,
    };
    const node = map[name];
    if (!node) return false;
    const g = dbToGain(db);
    node.gain.setTargetAtTime(this.muted && name === 'master' ? 0 : g, this.ac.currentTime, 0.02);
    if (name === 'master') this._masterTrim = g;
    return true;
  }

  setMuted(v) {
    this.muted = !!v;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this._masterTrim, this.ac.currentTime, 0.03);
  }

  /**
   * Duck music + ambience.
   * @param amount 0..1, where 1 is a full -18 dB dip (the ARISE cue).
   * @param attack seconds to reach the dip. Short = punchy, long = cinematic.
   * @param hold   seconds at the dip.
   * @param release seconds back to unity.
   */
  duck(amount, attack = 0.03, hold = 0.12, release = 0.55) {
    const a = clamp(amount, 0, 1);
    if (a <= 0.001) return;
    const now = this.ac.currentTime;
    const end = now + attack + hold + release;
    // Extend-don't-restart: only take over if this duck is deeper or lasts longer.
    if (a < this._duckAmount && end < this._duckUntil) return;
    // The remembered depth decays toward zero over the tail of the previous duck,
    // so two medium ducks 400 ms apart do not accumulate into a full one.
    const remaining = clamp((this._duckUntil - now) / 0.6, 0, 1);
    this._duckAmount = clamp(Math.max(a, this._duckAmount * remaining), 0, 1);
    this._duckUntil = Math.max(this._duckUntil, end);

    // -18 dB at full duck. Ambience ducks 30% harder than music because a bed of
    // wind masks a spell far more than a drone does.
    const musicTarget = dbToGain(-18 * a);
    const ambTarget = dbToGain(-18 * a * 1.3);
    for (const [param, target] of [[this.musicDuck.gain, musicTarget], [this.ambDuck.gain, ambTarget]]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, now + attack);
      param.setValueAtTime(target, now + attack + hold);
      // Exponential-ish recovery reads as the mix "breathing back in".
      param.setTargetAtTime(1, now + attack + hold, release * 0.35);
    }
  }

  /**
   * The hit-stop colour dip. Called from `time:hitstop`; a short, deep low-pass
   * for the frozen frames then an instant snap back as time resumes.
   */
  impactDip(duration, strength = 1) {
    const now = this.ac.currentTime;
    if (now < this._lpUntil) return;
    const f = this.sfxImpactLp.frequency;
    const target = 900 + (1 - clamp(strength, 0, 1)) * 6000;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    f.linearRampToValueAtTime(target, now + 0.012);
    f.setValueAtTime(target, now + Math.max(0.02, duration));
    f.exponentialRampToValueAtTime(20000, now + Math.max(0.02, duration) + 0.09);
    this._lpUntil = now + Math.max(0.02, duration) + 0.09;
  }

  /** Live compressor reduction in dB (negative). Useful in `stats()` and for the
   *  UI's optional mix meter; costs nothing to read. */
  reduction() { return this.sfxComp.reduction ?? 0; }

  dispose() {
    this.reverb.dispose();
    const nodes = [
      this.limiter, this.master, this.sfxComp, this.sfxTilt, this.sfxLowCut,
      this.sfxImpactLp, this.sfxGain, this.sfxIn, this.voiceIn, this.uiGain,
      this.uiIn, this.musicDuck, this.musicGain, this.musicIn, this.ambDuck,
      this.ambGain, this.ambIn,
    ];
    for (const n of nodes) { try { n.disconnect(); } catch { /* context closed */ } }
  }
}
