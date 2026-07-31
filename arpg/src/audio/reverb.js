/**
 * reverb.js — procedurally generated impulse responses and the room crossfade.
 *
 * There are no .wav files in this project and there never will be, so the crypt's
 * reverb is *computed*: a shoebox image-source model for the early reflections
 * (which is what tells you the size and shape of the room) stapled to a
 * multi-band exponentially decaying diffuse tail (which is what tells you the
 * material). Getting both halves right is the difference between "there is reverb
 * on this" and "I am standing in a stone corridor".
 *
 * Three rooms, chosen because they are the three the level actually contains:
 *
 *   crypt     — narrow, low, parallel stone walls. Short RT60, strong flutter,
 *               very dark: masonry eats treble at roughly 4x the rate of bass.
 *   cathedral — the big vaulted hall. Long, dense, late-blooming, a pre-delay you
 *               can hear, and a low-mid bloom from the vault.
 *   arena     — the boss room. Wide and open, less flutter than the corridor, a
 *               faint metallic modal ring from the iron cage furniture.
 *
 * Crossfading is done with two ConvolverNodes (A/B) and equal-power return gains.
 * Swapping the buffer on a live ConvolverNode resets its internal state and clicks,
 * so the incoming IR is always loaded into whichever convolver is currently
 * silent, then the pair is crossfaded over ~1.5 s — long enough that a doorway
 * transition reads as walking into a bigger space rather than as a mix cut.
 */

import { Sig, Noise, Biquad, Allpass, normalizeRms, clamp } from './dsp.js';

/**
 * Room definitions. Dimensions are in metres and are deliberately those of the
 * dungeon kit: `world` builds on a 2 m grid, corridors are 2 cells wide, the
 * cathedral vault is 12 m to the boss, the arena is 24 m across.
 *
 *   rt60      seconds to -60 dB in the mid band
 *   hfRatio   RT60 multiplier above ~4 kHz (stone is very absorbent up there)
 *   lfRatio   RT60 multiplier below ~250 Hz (bass builds up in masonry)
 *   predelay  seconds before the first reflection — reads directly as room size
 *   diffusion 0..1, how quickly discrete echoes smear into a wash
 *   damp      0..1, extra per-bounce absorption in the early reflection model
 *   wet       default send level for this room
 */
export const ROOMS = {
  crypt: {
    dims: [4.2, 3.0, 22.0], rt60: 1.25, hfRatio: 0.28, lfRatio: 1.5,
    predelay: 0.009, diffusion: 0.62, damp: 0.34, wet: 0.30, modal: 0.10, label: 'crypt corridor',
  },
  cathedral: {
    dims: [17.0, 12.5, 30.0], rt60: 3.6, hfRatio: 0.36, lfRatio: 1.35,
    predelay: 0.038, diffusion: 0.9, damp: 0.20, wet: 0.42, modal: 0.05, label: 'cathedral hall',
  },
  arena: {
    dims: [24.0, 9.0, 24.0], rt60: 2.35, hfRatio: 0.42, lfRatio: 1.15,
    predelay: 0.026, diffusion: 0.8, damp: 0.26, wet: 0.36, modal: 0.22, label: 'boss arena',
  },
  /** Outdoors / ruined roof: almost no tail, just a slap. Used for the entrance. */
  open: {
    dims: [40.0, 24.0, 40.0], rt60: 0.9, hfRatio: 0.5, lfRatio: 0.9,
    predelay: 0.05, diffusion: 0.45, damp: 0.55, wet: 0.16, modal: 0.0, label: 'open ruin',
  },
};

/** Room-name aliases so `world:room` can hand us whatever vocabulary it settled
 *  on without the two subsystems having to negotiate. */
const ROOM_ALIASES = {
  corridor: 'crypt', hall: 'cathedral', nave: 'cathedral', chapel: 'cathedral',
  shrine: 'cathedral', crypt: 'crypt', tomb: 'crypt', cell: 'crypt', vault: 'cathedral',
  arena: 'arena', boss: 'arena', ossuary: 'crypt', gate: 'open', entrance: 'open',
  courtyard: 'open', ruin: 'open', cavern: 'arena', library: 'cathedral',
};

export function resolveRoom(name) {
  if (!name) return 'crypt';
  const k = String(name).toLowerCase();
  if (ROOMS[k]) return k;
  for (const alias in ROOM_ALIASES) if (k.includes(alias)) return ROOM_ALIASES[alias];
  return 'crypt';
}

const SPEED_OF_SOUND = 343;

/**
 * First- and second-order image sources for a shoebox. Returns a flat array of
 * [delaySeconds, gain, azimuth] triples sorted by delay.
 *
 * Only the geometry-derived timing matters here; the exact absorption is fudged
 * per bounce. The point is that a 4 m wide corridor produces its first lateral
 * reflection at 4/343 = 11.7 ms and a 24 m arena at 70 ms, and the ear reads that
 * gap as room width without being told.
 */
/**
 * Mirror a source coordinate into image cell `n` along an axis of length `L`.
 * Even cells are translations of the source, odd cells are reflections — the
 * standard Allen–Berkley image formulation, and the reason a 4 m corridor
 * produces its first lateral reflection at exactly 11.7 ms.
 */
function imageCoord(n, L, s) {
  return (n & 1) === 0 ? n * L + s : (n + 1) * L - s;
}

function imageSources(room, rng) {
  const [w, h, d] = room.dims;
  const out = [];
  // Listener is a third of the way along the room, off the centreline, so the two
  // side walls do not arrive at the same instant — a perfectly centred listener in
  // a symmetric box gives a comb filter, not a room.
  const lx = w * (0.5 + rng.signed() * 0.12);
  const ly = 1.65;
  const lz = d * (0.35 + rng.float() * 0.1);
  const sx = lx + rng.signed() * 0.6, sy = 1.4, sz = lz + 1.2;
  const absorb = 1 - room.damp;

  const push = (px, py, pz, order) => {
    const dist = Math.hypot(px - lx, py - ly, pz - lz);
    if (dist < 0.4) return;
    // 1/r spreading plus per-bounce absorption; the extra 0.86^order accounts for
    // the fact that real walls are not flat and scatter energy out of the specular
    // path with every reflection.
    const g = (1 / dist) * Math.pow(absorb, order) * Math.pow(0.86, order);
    const az = Math.atan2(px - lx, pz - lz);
    out.push([dist / SPEED_OF_SOUND, g, az]);
  };

  for (let ix = -2; ix <= 2; ix++) {
    for (let iy = -1; iy <= 1; iy++) {
      for (let iz = -2; iz <= 2; iz++) {
        const order = Math.abs(ix) + Math.abs(iy) + Math.abs(iz);
        if (order === 0 || order > 3) continue;
        push(imageCoord(ix, w, sx), imageCoord(iy, h, sy), imageCoord(iz, d, sz), order);
      }
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * Build one stereo impulse response.
 *
 * Structure, in order of arrival:
 *   1. direct-ish pre-delay gap (silence)
 *   2. image-source early reflections, panned by their azimuth, each smeared by a
 *      short all-pass burst so it is a "reflection off a rough wall" not a click
 *   3. a diffuse tail: three independently band-filtered noise fields, each with
 *      its own exponential decay, summed. Independent per ear = a wide tail that
 *      still collapses to mono correctly.
 *   4. optional modal ring: a few long high-Q resonances for the arena's ironwork
 */
export function buildImpulseResponse(sampleRate, roomName, rng, maxSeconds = 4.0) {
  const room = ROOMS[roomName] ?? ROOMS.crypt;
  // `maxSeconds` comes from the quality budget: convolution cost is linear in IR
  // length, so a low preset gets a shorter cathedral rather than no cathedral.
  const len = Math.round(sampleRate *
    Math.min(maxSeconds, room.rt60 * 1.15 + room.predelay + 0.05));
  const ir = new Sig(sampleRate, len, 2);
  const L = ir.data[0], R = ir.data[1];
  const noise = new Noise(rng);

  /* ---- 2. early reflections ------------------------------------- */
  const early = imageSources(room, rng);
  const preN = Math.round(room.predelay * sampleRate);
  // A reflection off chipped masonry is a short burst, not an impulse. Length
  // scales with diffusion: a smooth cathedral wall keeps it tight, a rubble-strewn
  // crypt smears it.
  const smearN = Math.max(2, Math.round((0.0006 + room.diffusion * 0.0022) * sampleRate));
  for (let e = 0; e < early.length; e++) {
    const [t, g, az] = early[e];
    const at = preN + Math.round(t * sampleRate);
    if (at + smearN >= len) continue;
    const pan = clamp(Math.sin(az), -1, 1);
    const gl = Math.sqrt(0.5 * (1 - pan)) * g;
    const gr = Math.sqrt(0.5 * (1 + pan)) * g;
    for (let i = 0; i < smearN; i++) {
      const w = 1 - i / smearN;
      const v = noise.white() * w * w;
      L[at + i] += v * gl;
      R[at + i] += v * gr;
    }
  }
  // Early reflections carry a lot of the loudness; scale so the tail is audible
  // next to them. 0.35 was set by ear against the tail level below.
  for (let i = 0; i < len; i++) { L[i] *= 0.35; R[i] *= 0.35; }

  /* ---- 3. diffuse tail ------------------------------------------ */
  // Three bands with different RT60s. Splitting the decay by band is the single
  // most important thing here: a broadband exponential sounds like a spring, while
  // "bass rings for 4 s, treble is gone in 1 s" sounds like stone.
  const bands = [
    { f: 250, kind: 'low', rt: room.rt60 * room.lfRatio, gain: 1.0 },
    { f: 1800, kind: 'mid', rt: room.rt60, gain: 0.8 },
    { f: 5200, kind: 'high', rt: room.rt60 * room.hfRatio, gain: 0.45 },
  ];
  // One noise field per ear, filtered three ways. Generating independent noise
  // per band would be both wrong (a real room decays ONE excitation at different
  // rates per band, it does not sum three unrelated fields) and three times as
  // expensive — random number generation dominates this loop.
  const field = new Float32Array(len);
  const buildN = Math.round((0.012 + room.diffusion * 0.05) * sampleRate);
  for (let c = 0; c < 2; c++) {
    const dst = c === 0 ? L : R;
    for (let i = 0; i < len; i++) field[i] = noise.white();
    for (const b of bands) {
      const filt = new Biquad();
      if (b.kind === 'low') filt.setLowpass(b.f, 0.7, sampleRate);
      else if (b.kind === 'high') filt.setHighpass(b.f, 0.7, sampleRate);
      else filt.setBandpass(b.f, 0.6, sampleRate);
      const k = Math.exp(-6.9078 / Math.max(1, b.rt * sampleRate));
      const g = b.gain * 0.5;
      let env = 1;
      for (let i = 0; i < len; i++) {
        // Build-up: real tails ramp in over the first few tens of ms as the echo
        // density rises, they do not start at full level.
        const build = i < preN ? 0 : (i - preN < buildN ? (i - preN) / buildN : 1);
        dst[i] += filt.process(field[i]) * env * build * g;
        env *= k;
      }
    }
  }

  /* ---- diffusion pass ------------------------------------------- */
  // Two all-pass stages per ear with mutually prime delays break up the residual
  // periodicity of the noise field. Prime lengths avoid a repeating flutter.
  const primes = [1051, 337, 887, 227];
  for (let c = 0; c < 2; c++) {
    const dst = c === 0 ? L : R;
    const a1 = new Allpass(primes[c * 2] , 0.5 + room.diffusion * 0.25);
    const a2 = new Allpass(primes[c * 2 + 1], 0.4 + room.diffusion * 0.25);
    for (let i = 0; i < len; i++) dst[i] = a2.process(a1.process(dst[i]));
  }

  /* ---- flutter echo (crypt only, and it is the point of a crypt) - */
  if (room.dims[0] < 8) {
    // Two parallel stone walls 4 m apart make a repeating slap every 2*4/343 =
    // 23 ms. It is the acoustic signature of a corridor and it must be there.
    const flutterN = Math.round((2 * room.dims[0] / SPEED_OF_SOUND) * sampleRate);
    const taps = Math.min(14, Math.floor((len - preN) / flutterN));
    for (let t = 1; t <= taps; t++) {
      const at = preN + t * flutterN;
      const g = Math.pow(0.62, t) * 0.30;
      const jitterN = Math.round(rng.signed() * flutterN * 0.03);
      const burst = Math.max(3, Math.round(0.0016 * sampleRate));
      for (let i = 0; i < burst; i++) {
        const idx = at + jitterN + i;
        if (idx < 0 || idx >= len) continue;
        const w = 1 - i / burst;
        L[idx] += noise.white() * w * g;
        R[idx] += noise.white() * w * g * 0.9;
      }
    }
  }

  /* ---- 4. modal ring -------------------------------------------- */
  if (room.modal > 0) {
    // Long high-Q resonances: the arena's hanging iron and the cathedral's
    // vault-supported air modes. Kept quiet — audible as colour, not as a tone.
    const modes = [63.4, 97.1, 148.3, 231.7, 372.9];
    for (let m = 0; m < modes.length; m++) {
      const f = modes[m] * (1 + rng.signed() * 0.03);
      const rt = room.rt60 * (1.5 - m * 0.15);
      const r = Math.exp(-6.9078 / Math.max(1, rt * sampleRate));
      const w = 2 * Math.PI * f / sampleRate;
      const a1 = -2 * r * Math.cos(w), a2 = r * r;
      const g = room.modal * (0.5 / (1 + m));
      for (let c = 0; c < 2; c++) {
        const dst = c === 0 ? L : R;
        let y1 = 0, y2 = 0;
        const phase = rng.float() * 6.283;
        for (let i = preN; i < len; i++) {
          const x = i === preN ? Math.cos(phase) : 0;
          const y = x - a1 * y1 - a2 * y2;
          y2 = y1; y1 = y;
          dst[i] += y * g;
        }
      }
    }
  }

  // Hard fade to zero at the end: a truncated tail is a click on every impulse.
  const fadeN = Math.round(0.08 * sampleRate);
  for (let c = 0; c < 2; c++) {
    const dst = ir.data[c];
    for (let i = 0; i < fadeN; i++) {
      const idx = len - fadeN + i;
      dst[idx] *= Math.pow(1 - i / fadeN, 2);
    }
  }

  // RMS-normalise so switching rooms changes the *character* of the reverb and not
  // its level; the room's own `wet` value is what sets how much you hear.
  normalizeRms(ir, 0.055, 0.9);
  return ir;
}

/**
 * Two convolvers, one send, an equal-power crossfade between them. Owns nothing
 * else; the mixer wires the send and returns.
 */
export class ReverbUnit {
  constructor(audioCtx, destination, rng, maxSeconds = 4.0) {
    this.ac = audioCtx;
    this.rng = rng;
    this.maxSeconds = maxSeconds;
    this.sampleRate = audioCtx.sampleRate;

    /** Everything that wants reverb connects here. */
    this.send = audioCtx.createGain();
    this.send.gain.value = 1;

    // A gentle high-pass on the send: sub energy in a convolution reverb turns
    // into mud and eats headroom without adding any sense of space.
    this.sendFilter = audioCtx.createBiquadFilter();
    this.sendFilter.type = 'highpass';
    this.sendFilter.frequency.value = 160;
    this.sendFilter.Q.value = 0.6;
    this.send.connect(this.sendFilter);

    this.slots = [];
    for (let i = 0; i < 2; i++) {
      const conv = audioCtx.createConvolver();
      conv.normalize = false; // we normalise the IR ourselves, by RMS
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      this.sendFilter.connect(conv);
      conv.connect(gain);
      gain.connect(destination);
      this.slots.push({ conv, gain, room: null });
    }

    this.active = 0;
    this.room = null;
    /** Cache of built IRs, keyed by room name. Building one costs ~15-40 ms. */
    this.cache = new Map();
    this.pending = null;
  }

  /** Build (or fetch) the IR for a room. Synchronous and deterministic. */
  irFor(roomName) {
    let ir = this.cache.get(roomName);
    if (!ir) {
      // Fork per room so adding a room later cannot shift another room's noise.
      const sig = buildImpulseResponse(this.sampleRate, roomName, this.rng.fork(), this.maxSeconds);
      ir = sig.toAudioBuffer(this.ac);
      ir.mnBytes = sig.bytes;
      this.cache.set(roomName, ir);
    }
    return ir;
  }

  /**
   * Crossfade to `roomName` over `fade` seconds. Loading into the silent slot
   * means the convolver reset that comes with a buffer assignment is inaudible.
   */
  setRoom(roomName, fade = 1.5) {
    const name = resolveRoom(roomName);
    if (name === this.room) return false;
    const now = this.ac.currentTime;
    const cur = this.slots[this.active];
    const next = this.slots[this.active ^ 1];

    next.conv.buffer = this.irFor(name);
    next.room = name;

    const wet = (ROOMS[name] ?? ROOMS.crypt).wet;
    const curWet = this.room ? (ROOMS[this.room] ?? ROOMS.crypt).wet : 0;

    // cancelScheduledValues + setValueAtTime(current) is the only safe way to
    // retarget a ramp mid-flight; without it a second room change inside the fade
    // window jumps the gain. `curWet` is read only for the stats view — the ramp
    // always starts from wherever the parameter actually is right now.
    void curWet;
    cur.gain.gain.cancelScheduledValues(now);
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, now);
    cur.gain.gain.linearRampToValueAtTime(0, now + fade);
    next.gain.gain.cancelScheduledValues(now);
    next.gain.gain.setValueAtTime(next.gain.gain.value, now);
    next.gain.gain.linearRampToValueAtTime(wet, now + fade);

    this.active ^= 1;
    this.room = name;
    return true;
  }

  /** Momentarily push the wet level up — used on explosions and the ARISE cue,
   *  where a bloom of reverb is what makes the room feel like it got hit. */
  bloom(amount = 0.5, attack = 0.05, hold = 0.15, release = 1.1) {
    const slot = this.slots[this.active];
    const base = (ROOMS[this.room] ?? ROOMS.crypt).wet;
    const now = this.ac.currentTime;
    const g = slot.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(base + amount, now + attack);
    g.setValueAtTime(base + amount, now + attack + hold);
    g.linearRampToValueAtTime(base, now + attack + hold + release);
  }

  bytes() {
    let n = 0;
    for (const ir of this.cache.values()) n += ir.mnBytes ?? 0;
    return n;
  }

  dispose() {
    try {
      this.send.disconnect();
      this.sendFilter.disconnect();
      for (const s of this.slots) { s.conv.disconnect(); s.gain.disconnect(); s.conv.buffer = null; }
    } catch { /* the context may already be closed */ }
    this.cache.clear();
    this.slots.length = 0;
  }
}
