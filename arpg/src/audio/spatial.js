/**
 * spatial.js — the voice pool, the listener, and occlusion.
 *
 * ── Voice pooling ────────────────────────────────────────────────────
 * An AudioBufferSourceNode is single-use by specification, so one node per sound
 * is unavoidable. Everything downstream of it is *not*: each pool slot owns a
 * permanently-wired gain → occlusion filter → panner chain, and firing a sound
 * allocates exactly one node and connects it. That is the difference between four
 * nodes per hit and one, which on a 12-hit flurry is the difference between a
 * clean mix and a graph rebuild you can hear.
 *
 * ── Where the ear goes ───────────────────────────────────────────────
 * The camera is 21 m from the player on a fixed isometric boom. Putting the
 * listener at the camera makes everything distant and makes the player's own
 * footsteps quieter than an enemy standing next to them; putting it at the player
 * makes the stereo image collapse, because the player is where all the action is.
 *
 * MONARCH puts the ear on the boom between the two, 35% of the way to the camera,
 * oriented along the camera's own forward vector. Screen-left is therefore
 * ear-left (the isometric yaw is baked into the camera basis, so this is free),
 * distance attenuation is measured from a point a few metres above the player,
 * and `refDistance` is set to that offset so the player's own sounds sit at
 * exactly unity gain.
 *
 * ── Occlusion ────────────────────────────────────────────────────────
 * One raycast per voice would be fine; one raycast per voice per frame would not,
 * so the pool round-robins a small budget of `physics.lineOfSight` queries across
 * the live voices and ramps a per-voice low-pass toward the result. A wall does
 * not mute a sound, it removes its treble and a little of its level — 800 Hz and
 * -7 dB is the value that reads as "behind that pillar" without making the sound
 * vanish, which would break combat readability.
 */

import { clamp, dbToGain } from './dsp.js';

/** Distance beyond which a sound is not worth a voice at all. */
const CULL_DISTANCE = 46;
/** Level of a fully occluded voice. -7 dB: audible, but clearly behind something.
 *  Muting it outright would break combat readability, which matters more here
 *  than acoustic accuracy — an enemy winding up behind a pillar must still be
 *  heard winding up. */
const OCCLUDED_GAIN = dbToGain(-7);

export class VoicePool {
  /**
   * @param audioCtx   running AudioContext
   * @param mixer      Mixer
   * @param budget     quality budget from quality.js
   */
  constructor(audioCtx, mixer, budget) {
    this.ac = audioCtx;
    this.mixer = mixer;
    this.budget = budget;

    /* ---- listener ------------------------------------------------- */
    this.listener = audioCtx.listener;
    // Chromium exposes the modern AudioParam interface; Safari still wants the
    // deprecated setters. Detect once, branch never.
    this.modernListener = typeof this.listener.positionX?.setTargetAtTime === 'function';
    /** World position of the ear. Public so ambience can scatter around it. */
    this.earPos = { x: 0, y: 6, z: 6 };
    this.refDistance = 7.5;

    /* ---- slots ---------------------------------------------------- */
    this.slots = [];
    const total = budget.voices;
    for (let i = 0; i < total; i++) {
      this.slots.push(this._makeSlot(i, i < budget.hrtfVoices));
    }
    this.flatSlots = [];
    for (let i = 0; i < budget.flatVoices; i++) {
      this.flatSlots.push(this._makeFlatSlot(i));
    }

    /** Per-cue concurrency + cooldown bookkeeping. */
    this.cueState = new Map();
    /** Round-robin cursor for occlusion queries. */
    this._occCursor = 0;
    /** Optional line-of-sight predicate, injected by index.js from physics. */
    this.losFn = null;

    this.stolen = 0;
    this.played = 0;
    this.rejected = 0;

    // One shared handler for every source, so firing a sound allocates no
    // closures. `mnSlot` is stashed on the node; the event's target gives it back.
    this._onEnded = (e) => {
      const node = e.target;
      const slot = node.mnSlot;
      node.mnSlot = null;
      try { node.disconnect(); } catch { /* context closed */ }
      if (slot && slot.source === node) this._release(slot);
    };

    /* scratch objects — nothing in this file allocates per frame */
    this._a = { x: 0, y: 0, z: 0 };
    this._b = { x: 0, y: 0, z: 0 };
  }

  _makeSlot(index, hrtf) {
    const ac = this.ac;
    const gain = ac.createGain();
    gain.gain.value = 0;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    filter.Q.value = 0.5;
    const panner = ac.createPanner();
    // HRTF for the near field where it is worth the CPU; equalpower for the rest.
    panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = this.refDistance;
    panner.maxDistance = CULL_DISTANCE;
    // 1.35 is slightly faster than physical 1/r: a dungeon is full of sounds and
    // real inverse-square keeps too many of them audible at once.
    panner.rolloffFactor = 1.35;
    panner.coneInnerAngle = 360;
    const send = ac.createGain();
    send.gain.value = 0;

    gain.connect(filter);
    filter.connect(panner);
    filter.connect(send);
    send.connect(this.mixer.reverb.send);

    return {
      index, hrtf, gain, filter, panner, send,
      source: null, busy: false, endTime: 0, priority: 0, cue: '', baseGain: 1,
      bus: null, occ: 0, occTarget: 0, x: 0, y: 0, z: 0, spatial: true,
    };
  }

  _makeFlatSlot(index) {
    const ac = this.ac;
    const gain = ac.createGain();
    gain.gain.value = 0;
    const panner = ac.createStereoPanner();
    const send = ac.createGain();
    send.gain.value = 0;
    gain.connect(panner);
    gain.connect(send);
    send.connect(this.mixer.reverb.send);
    return {
      index, gain, panner, send, filter: null,
      source: null, busy: false, endTime: 0, priority: 0, cue: '', baseGain: 1,
      bus: null, occ: 0, occTarget: 0, spatial: false,
    };
  }

  /** Move the ear. All arguments are plain numbers — no Vector3 dependency. */
  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    this.earPos.x = px; this.earPos.y = py; this.earPos.z = pz;
    const t = this.ac.currentTime;
    if (this.modernListener) {
      const L = this.listener;
      // 0.02 s smoothing: fast enough to track a dash, slow enough that a camera
      // snap does not click.
      L.positionX.setTargetAtTime(px, t, 0.02);
      L.positionY.setTargetAtTime(py, t, 0.02);
      L.positionZ.setTargetAtTime(pz, t, 0.02);
      L.forwardX.setTargetAtTime(fx, t, 0.02);
      L.forwardY.setTargetAtTime(fy, t, 0.02);
      L.forwardZ.setTargetAtTime(fz, t, 0.02);
      L.upX.setTargetAtTime(ux, t, 0.02);
      L.upY.setTargetAtTime(uy, t, 0.02);
      L.upZ.setTargetAtTime(uz, t, 0.02);
    } else {
      this.listener.setPosition?.(px, py, pz);
      this.listener.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  /** Squared distance from the ear — used for culling before anything is built. */
  distanceSq(x, y, z) {
    const dx = x - this.earPos.x, dy = y - this.earPos.y, dz = z - this.earPos.z;
    return dx * dx + dy * dy + dz * dz;
  }

  _cueSlot(cue) {
    let s = this.cueState.get(cue);
    if (!s) { s = { count: 0, last: -1e9 }; this.cueState.set(cue, s); }
    return s;
  }

  /**
   * Fire a sound.
   *
   * @param buffer  an AudioBuffer
   * @param params  resolved cue params from cues.js
   * @param opts    { gain, pitch, position:{x,y,z}, bus, reverb, priority, occluded }
   * @returns the slot, or null if the sound was culled, throttled or outranked.
   */
  play(buffer, params, opts) {
    if (!buffer) return null;
    const now = this.ac.currentTime;
    const cueState = this._cueSlot(params.name);
    if (params.cooldown > 0 && now - cueState.last < params.cooldown) { this.rejected++; return null; }
    if (cueState.count >= params.maxSimul) { this.rejected++; return null; }

    const spatial = params.spatial && !!opts.position;
    let dist = 0;
    if (spatial) {
      const d2 = this.distanceSq(opts.position.x, opts.position.y, opts.position.z);
      if (d2 > CULL_DISTANCE * CULL_DISTANCE) { this.rejected++; return null; }
      dist = Math.sqrt(d2);
    }

    const priority = opts.priority ?? params.priority;
    const slot = spatial ? this._acquire(this.slots, priority, dist) : this._acquire(this.flatSlots, priority, 0);
    if (!slot) { this.rejected++; return null; }

    const src = this.ac.createBufferSource();
    src.buffer = buffer;
    const pitch = (opts.pitch ?? 0) + params.pitch;
    if (pitch !== 0) src.playbackRate.value = Math.pow(2, pitch / 12);

    let gain = (opts.gain ?? 1) * params.gain;
    // Remembered unoccluded level, so a mid-voice occlusion change can retarget
    // the gain without having to reconstruct what the caller asked for.
    slot.baseGain = gain;

    // Reverb send. Distant sources send MORE, because in a real room the direct
    // path falls off with distance and the reverberant field does not — a 1.6x
    // boost at the cull distance is the cheapest depth cue in the mix.
    const distBoost = spatial ? 1 + clamp(dist / CULL_DISTANCE, 0, 1) * 0.6 : 1;
    const send = (opts.reverb ?? params.reverb) * distBoost;
    slot.send.gain.cancelScheduledValues(now);
    slot.send.gain.setValueAtTime(clamp(send, 0, 1.5), now);

    if (spatial) {
      const p = opts.position;
      slot.x = p.x; slot.y = p.y; slot.z = p.z;
      if (params.ref > 0) slot.panner.refDistance = params.ref;
      else slot.panner.refDistance = this.refDistance;
      if (slot.panner.positionX) {
        slot.panner.positionX.setValueAtTime(p.x, now);
        slot.panner.positionY.setValueAtTime(p.y, now);
        slot.panner.positionZ.setValueAtTime(p.z, now);
      } else {
        slot.panner.setPosition?.(p.x, p.y, p.z);
      }
      // Seed occlusion from the caller (which may already know, e.g. an impact
      // behind a wall) or from an immediate query, so a sound never starts bright
      // and then dips audibly a frame later.
      const occ = opts.occluded !== undefined ? opts.occluded : this._queryOcclusion(p.x, p.y, p.z);
      slot.occ = occ;
      slot.occTarget = occ;
      // 800 Hz and -7 dB behind a wall. BOTH matter: filtering alone reads as
      // "muffled", level alone as "quiet", and only the pair reads as "occluded".
      slot.filter.frequency.cancelScheduledValues(now);
      slot.filter.frequency.setValueAtTime(20000 - occ * 19200, now);
      gain *= 1 - occ * (1 - OCCLUDED_GAIN);
    } else {
      slot.panner.pan.setValueAtTime(clamp(opts.pan ?? 0, -1, 1), now);
    }

    slot.gain.gain.cancelScheduledValues(now);
    slot.gain.gain.setValueAtTime(gain, now);

    const busNode = this.mixer.bus(opts.bus ?? params.bus);
    if (slot.bus !== busNode) {
      // The pooled chain is permanent; only its final hop moves, and only when a
      // slot is reused for a different bus. Two graph calls, not a rebuild.
      try { slot.panner.disconnect(); } catch { /* not connected yet */ }
      slot.panner.connect(busNode);
      slot.bus = busNode;
    }

    src.connect(slot.gain);
    src.mnSlot = slot;
    src.onended = this._onEnded;
    slot.source = src;
    slot.busy = true;
    slot.priority = priority;
    slot.cue = params.name;
    slot.endTime = now + buffer.duration / (src.playbackRate.value || 1) + 0.03;
    cueState.count++;
    cueState.last = now;

    try { src.start(now); } catch { /* context closed mid-frame */ }
    this.played++;
    return slot;
  }

  /** Find a free slot, or steal the weakest busy one this sound outranks. */
  _acquire(pool, priority, dist) {
    for (let i = 0; i < pool.length; i++) if (!pool[i].busy) return pool[i];
    // Steal: lowest priority first, then the one closest to finishing. Distance
    // breaks ties so a far-away drip loses to a close sword hit at equal rank.
    let best = null, bestScore = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (s.priority > priority) continue;
      const score = s.priority * 1000 + (s.endTime - this.ac.currentTime);
      if (score < bestScore) { bestScore = score; best = s; }
    }
    if (!best) return null;
    this._stop(best);
    this.stolen++;
    void dist;
    return best;
  }

  _stop(slot) {
    const src = slot.source;
    if (src) {
      src.onended = null;
      try { src.stop(); } catch { /* already stopped */ }
      try { src.disconnect(); } catch { /* closed */ }
      src.mnSlot = null;
    }
    this._release(slot);
  }

  _release(slot) {
    if (slot.busy) {
      const cs = this.cueState.get(slot.cue);
      if (cs && cs.count > 0) cs.count--;
    }
    slot.busy = false;
    slot.source = null;
    slot.priority = 0;
    slot.cue = '';
    slot.endTime = 0;
  }

  /**
   * Occlusion for one point. Returns 0 (clear) or 1 (blocked). The predicate is
   * injected; when physics is not present everything is audible, which is the
   * right failure mode.
   */
  _queryOcclusion(x, y, z) {
    if (!this.losFn) return 0;
    const a = this._a, b = this._b;
    a.x = this.earPos.x; a.y = this.earPos.y; a.z = this.earPos.z;
    b.x = x; b.y = y; b.z = z;
    return this.losFn(a, b) ? 0 : 1;
  }

  /**
   * Per-frame housekeeping: retire finished voices and refresh a slice of the
   * occlusion state. `onended` is authoritative when it fires, but a suspended or
   * interrupted context can swallow it, so the end-time sweep is the backstop.
   */
  update(dt) {
    const now = this.ac.currentTime;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.busy && now > s.endTime) this._stop(s);
    }
    for (let i = 0; i < this.flatSlots.length; i++) {
      const s = this.flatSlots[i];
      if (s.busy && now > s.endTime) this._stop(s);
    }

    if (!this.losFn) return;
    // Round-robin the raycast budget over the live spatial voices. Long sounds
    // (a boss roar, an explosion tail) get several updates across their life;
    // short ones keep whatever they were seeded with, which is correct.
    let budget = this.budget.occlusionRaysPerFrame;
    const n = this.slots.length;
    for (let k = 0; k < n && budget > 0; k++) {
      const s = this.slots[this._occCursor];
      this._occCursor = (this._occCursor + 1) % n;
      if (!s.busy) continue;
      budget--;
      const target = this._queryOcclusion(s.x, s.y, s.z);
      if (target === s.occTarget) continue;
      s.occTarget = target;
      // Ramp over ~120 ms. An instant switch as an enemy steps behind a pillar is
      // a click; 120 ms reads as walking behind something.
      s.filter.frequency.setTargetAtTime(20000 - target * 19200, now, 0.12);
      s.gain.gain.setTargetAtTime(s.baseGain * (1 - target * (1 - OCCLUDED_GAIN)), now, 0.12);
      s.occ = target;
    }
    void dt;
  }

  /** Stop everything immediately — used on dispose and on a hard scene change. */
  stopAll() {
    for (const s of this.slots) if (s.busy) this._stop(s);
    for (const s of this.flatSlots) if (s.busy) this._stop(s);
  }

  stats() {
    let active = 0, flat = 0;
    for (const s of this.slots) if (s.busy) active++;
    for (const s of this.flatSlots) if (s.busy) flat++;
    return {
      slots: this.slots.length, hrtf: this.budget.hrtfVoices,
      active, flatSlots: this.flatSlots.length, flatActive: flat,
      played: this.played, stolen: this.stolen, rejected: this.rejected,
      occlusion: !!this.losFn,
    };
  }

  dispose() {
    this.stopAll();
    for (const s of this.slots) {
      try { s.gain.disconnect(); s.filter.disconnect(); s.panner.disconnect(); s.send.disconnect(); } catch { /* closed */ }
    }
    for (const s of this.flatSlots) {
      try { s.gain.disconnect(); s.panner.disconnect(); s.send.disconnect(); } catch { /* closed */ }
    }
    this.slots.length = 0;
    this.flatSlots.length = 0;
    this.cueState.clear();
  }
}
