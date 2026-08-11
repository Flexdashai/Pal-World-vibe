/**
 * audio/index.js — the MONARCH audio subsystem.
 *
 * Owns: the Web Audio graph, every synthesised sound in the game, the mix, the
 * reverb rooms, spatialisation, the adaptive score and the ambience director.
 * Depends on nothing; reaches `physics` and `player` at runtime through
 * `ctx.peek` and works correctly when neither exists.
 *
 * ══ THE BOOT CONTRACT ═════════════════════════════════════════════════
 * The capture harness runs Chromium with `--mute-audio` and never produces a user
 * gesture, so an AudioContext can never start there. This subsystem therefore:
 *
 *   - constructs NOTHING in `init()`. No AudioContext, no buffers, no timers.
 *     `init` wires event listeners and returns; it is sub-millisecond.
 *   - never constructs an AudioContext in capture/deterministic mode at all, so
 *     the harness does not even see Chromium's "AudioContext was not allowed to
 *     start" warning.
 *   - builds the entire graph lazily on the first real user gesture, and every
 *     step of that build is wrapped: a browser that refuses to give us audio
 *     leaves the game running silently rather than throwing into the boot path.
 *   - keeps running its *logic* when the graph does not exist — cue resolution,
 *     surface queries, footstep cadence, combat intensity and the music director's
 *     state machine all advance, so a playtest exercises the subsystem and so
 *     the mix is already in the right state the instant a player clicks.
 *
 * ══ WHAT LISTENS TO WHAT ══════════════════════════════════════════════
 * Everything is event-driven; nothing here polls another subsystem. The one
 * exception is a `physics.groundAt` query on each footstep and a budgeted
 * `physics.lineOfSight` for occlusion, both of which are pull-style spatial
 * queries physics exists to answer, not state polling.
 */

import * as THREE from 'three';

import { audioBudget } from './quality.js';
import { Mixer } from './mixer.js';
import { SoundBank } from './banks.js';
import { VoicePool } from './spatial.js';
import { MusicDirector } from './music.js';
import { AmbienceDirector } from './ambience.js';
import { buildAriseCue, ARISE_DROP_TIME, ARISE_DURATION } from './arise.js';
import { resolveRoom, ROOMS } from './reverb.js';
import {
  resolveCue, impactCue, elementImpactCue, explosionCue, castCue, footCue, voxCue,
  safeArchetype, safeSurface, safeWeapon, substituteCue, SURFACES, ELEMENT_NAMES,
} from './cues.js';
import { clamp } from './dsp.js';

/** Cues baked in the background as soon as audio starts, in this order. These are
 *  the ones whose first-use inline bake would be noticeable, or that must be
 *  instant the first time they are needed. */
const PREWARM_CUES = [
  'hit.blade.flesh', 'hit.blade.stone', 'hit.blade.metal', 'hit.blunt.flesh',
  'hit.magic.flesh', 'hit.magic.stone', 'swing.blade', 'swing.blunt',
  'foot.flagstone', 'foot.stone', 'foot.flagstone.run', 'foot.stone.run',
  'foley.armour', 'foley.cloth',
  'magic.cast.shadow', 'magic.impact.shadow', 'magic.explosion.shadow',
  'shadow.extract', 'shadow.arise',
  'ui.click', 'ui.system', 'ui.levelup', 'ui.skillready',
  'player.dash', 'player.hurt',
  'music.kick', 'music.taiko', 'music.shaker', 'music.metal', 'music.tom',
  'amb.drip', 'amb.crackle', 'amb.settle',
  'vox.ghoul.alert', 'vox.ghoul.attack', 'vox.ghoul.death',
  'loot.drop.rare', 'loot.pickup',
];

/** Stride length in metres between footsteps. Walking humans average ~0.75 m per
 *  step; the player is a heroic 1.9 m tall and moves at 6.2 m/s, so a longer
 *  stride keeps the cadence from sounding like a sewing machine. */
const STRIDE_WALK = 1.55;
const STRIDE_RUN = 2.05;

/** Minimum seconds between full ARISE cues. Summoning eight soldiers should be
 *  one cinematic moment with eight materialisations inside it, not eight. */
const ARISE_COOLDOWN = 7.0;

export class AudioSystem {
  static id = 'audio';
  static deps = [];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.budget = audioBudget(ctx.config);

    /* ---- state that exists with or without a graph ---------------- */
    this.enabled = false;          // graph built and context running
    this.starting = false;
    this.failed = false;
    this.ac = null;
    this.mixer = null;
    this.bank = null;
    this.voices = null;
    this.music = null;
    this.ambience = null;
    this.physics = null;
    this.player = null;

    /** Capture / deterministic runs never touch Web Audio at all. */
    this.captureMode = !!ctx.config.deterministic;

    this.room = 'crypt';
    this.masterMuted = false;
    this.intensity = 0;            // combat intensity, drives the score
    this._intensityTarget = 0;
    this._lastAriseAt = -1e9;
    this._ariseTimeout = null;
    /** Pending reverb crossfade time, or null. See `setRoom`. */
    this._roomPending = null;

    /* counters — cheap observability for probe.mjs */
    this.counters = {
      cues: 0, silent: 0, substituted: 0, played: 0, footsteps: 0, hits: 0,
      kills: 0, casts: 0, explosions: 0, vox: 0, arise: 0, errors: 0,
    };

    /* ---- preallocated scratch (rule 5: nothing per frame) --------- */
    this._pos = { x: 0, y: 0, z: 0 };
    this._playerPos = new THREE.Vector3();
    this._playerVel = new THREE.Vector3();
    this._ear = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._opts = { position: null, gain: 1, pitch: 0, reverb: undefined, bus: undefined, priority: undefined, pan: 0, occluded: undefined };
    this._playerMoving = false;
    this._playerDashing = false;
    this._wasDashing = false;
    this._strideAccum = 0;
    this._lastFootAt = 0;
    this._footRng = this.rng.fork();
    this._lastHitAt = -1e9;
    this._lastHitPos = { x: 0, y: 0, z: 0 };
    this._clock = 0;              // unscaled seconds since init
    this._tickLast = 0;
    this._timer = null;

    /* ---- events --------------------------------------------------- */
    this._offs = [];
    this._wireEvents();
    this._installGestureHooks();

    // `?audio=1` forces the graph up with no gesture. Development and CI only:
    // it is how `probe.mjs` exercises the live playback path in a container where
    // an AudioContext can never actually start.
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('audio') === '1') {
      this.enable({ force: true, ignoreState: true });
    }

    // Nothing else happens here. See the boot contract in the file header.
  }

  /* ================================================================ */
  /* Lifecycle                                                        */
  /* ================================================================ */

  _installGestureHooks() {
    if (this.captureMode || typeof window === 'undefined') return;
    const kick = () => { this.enable(); };
    this._gestureKick = kick;
    // `once` on each: the first of whichever arrives wins, and the others are
    // cleaned up in `_removeGestureHooks`.
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(type, kick, { once: true, passive: true });
    }
  }

  _removeGestureHooks() {
    if (!this._gestureKick) return;
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      window.removeEventListener(type, this._gestureKick);
    }
    this._gestureKick = null;
  }

  /**
   * Bring the audio graph up. Safe to call any number of times, from anywhere,
   * at any point in the frame. Returns true if audio is (or is becoming) live.
   *
   * @param {{force?: boolean}} opts `force` overrides the capture-mode refusal;
   *        only the dev console and the settings UI should ever pass it.
   */
  enable(opts = {}) {
    if (this.enabled || this.starting || this.failed) return this.enabled;
    if (this.captureMode && !opts.force) return false;
    this.starting = true;
    try {
      this._start(opts);
    } catch (err) {
      // A failure here must never reach the caller: the caller is a DOM event
      // handler or the boot path, and a game with no sound must still run.
      this.failed = true;
      this.starting = false;
      this.counters.errors++;
      console.warn('[audio] disabled —', err?.message ?? err);
      return false;
    }
    this.starting = false;
    return this.enabled;
  }

  _start(opts = {}) {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (typeof Ctor !== 'function') throw new Error('Web Audio unavailable');

    // `interactive` asks for the smallest buffer the platform will give us. A
    // 512-frame buffer at 48 kHz is ~11 ms, which is the difference between a
    // sword hit that feels connected to the animation and one that does not.
    const ac = new Ctor({ latencyHint: 'interactive' });
    this.ac = ac;

    // resume() may reject (no gesture yet) or never settle. Fire and forget; the
    // statechange handler is what actually flips us live.
    ac.resume?.().catch(() => { /* stays suspended until a real gesture */ });

    this.mixer = new Mixer(ac, this.rng.fork(), this.budget);
    this.bank = new SoundBank(ac.sampleRate, this.rng.fork(), this.budget, ac);
    this.voices = new VoicePool(ac, this.mixer, this.budget);
    this.music = new MusicDirector(ac, this.mixer, this.bank, this.rng.fork(), this.budget);
    this.ambience = new AmbienceDirector(
      ac, this.mixer, this.bank, this.rng.fork(), this.budget,
      // Bound once, not per call: the ambience director fires a few times a
      // minute but the binding would otherwise allocate on every construction.
      (cue, o) => this._play(cue, o)
    );

    // Occlusion predicate, if physics is up. Re-checked in update() because a
    // subsystem may finish initialising after us in a hot-reload.
    this._attachPhysics();

    // The first impulse response costs ~40-70 ms to generate. Deferring it to the
    // first update() keeps that off the click handler that started us, where a
    // stall is visible as an input hitch.
    this._roomPending = 0.01;
    this.ambience.setRoom(this.room);

    // Gameplay one-shots first, two variants each — someone may swing a sword one
    // second from now. The signature cue is queued behind them: it is ~6.4 s of
    // stereo synthesis and by far the largest single bake, and nobody can possibly
    // extract a shadow inside the half-second the light cues take to drain.
    for (const cue of PREWARM_CUES) this.bank.enqueueAll(cue, 2);
    this.bank.enqueueAll('arise.cue');

    ac.onstatechange = () => {
      const running = ac.state === 'running';
      if (running && !this.enabled) {
        this.enabled = true;
        this._startTimer();
        this._removeGestureHooks();
      } else if (!running && this.enabled) {
        this.enabled = false;
        this._stopTimer();
      }
    };
    if (ac.state === 'running' || opts.ignoreState) {
      // `ignoreState` is the `?audio=1` CI path: it drives the whole live graph —
      // voice allocation, scheduling, ducking, the bake queue — against a context
      // that Chromium will never let leave the suspended state, which is the only
      // way to smoke-test the playback path in a headless container. Nothing is
      // audible and `currentTime` never advances; the point is that nothing throws.
      this.enabled = true;
      this._startTimer();
      this._removeGestureHooks();
    }
  }

  _attachPhysics() {
    if (!this.voices) return;
    const phys = this.ctx.peek?.('physics');
    if (phys && typeof phys.lineOfSight === 'function') {
      this.physics = phys;
      // Bound once at attach time — never per query.
      this.voices.losFn = (a, b) => {
        try { return phys.lineOfSight(a, b); } catch { return true; }
      };
    }
  }

  /**
   * The audio clock. Scheduling percussion and ambience from the render frame
   * would couple the score to the frame rate; on this software rasteriser that is
   * one frame per second and the music would stutter into uselessness. A 25 ms
   * timer with a 350 ms lookahead is the standard Web Audio scheduling pattern.
   */
  _startTimer() {
    if (this._timer !== null) return;
    this._tickLast = this.ac.currentTime;
    this._timer = setInterval(() => {
      try { this._tick(); } catch (err) {
        this.counters.errors++;
        console.warn('[audio] scheduler tick threw', err);
      }
    }, 25);
  }

  _stopTimer() {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    if (!this.enabled || !this.ac) return;
    const now = this.ac.currentTime;
    const dt = clamp(now - this._tickLast, 0, 0.5);
    this._tickLast = now;
    this.music.schedule(0.35);
    this.ambience.tick(dt, this.voices.earPos);
  }

  /* ================================================================ */
  /* Frame update                                                     */
  /* ================================================================ */

  update(dt, ctx) {
    // Wall time, not scaled time: hit-stop must not slow the music down.
    const raw = ctx.time.rawDt || dt;
    this._clock += raw;

    /* ---- intensity model runs whether or not audio is live -------- */
    // Rise is event-driven (see `_bumpIntensity`); this is the decay. ~14 s from
    // full to zero, which is long enough that a two-wave fight stays hot.
    this._intensityTarget = Math.max(0, this._intensityTarget - raw * 0.075);
    this.intensity += (this._intensityTarget - this.intensity) *
      clamp(raw * (this._intensityTarget > this.intensity ? 3.0 : 0.5), 0, 1);

    /* ---- player state + footsteps (logic runs while silent) ------- */
    this._trackPlayer(raw, ctx);

    if (!this.enabled) return;

    /* ---- deferred room change (IR generation) --------------------- */
    if (this._roomPending !== null && this._roomPending !== undefined) {
      const fade = this._roomPending;
      this._roomPending = null;
      this.mixer.reverb.setRoom(this.room, fade);
    }

    /* ---- background baking, inside a strict time budget ----------- */
    // Priority: gameplay one-shots first (someone may be about to need them),
    // then the ambience bed, then the score. Each pump stops as soon as the
    // budget is spent, so this never costs more than `bakeBudgetMs` per frame
    // no matter how much work is outstanding.
    const ms = this.budget.bakeBudgetMs;
    const t0 = performance.now();
    this.bank.pump(ms);
    let left = ms - (performance.now() - t0);
    if (left > 0.5 && this.bank.queue.length === 0) {
      left -= this.ambience.pump(left);
      if (left > 0.5) this.music.pump(left);
    }

    /* ---- listener ------------------------------------------------- */
    this._updateListener(ctx);

    /* ---- voices, score, ambience level ---------------------------- */
    this.voices.update(raw);
    this.music.setTarget(this.intensity);
    this.music.update(raw);
    this.ambience.setIntensity(this.intensity);

    if (!this.physics) this._attachPhysics();
  }

  /**
   * Ear placement. See the long note at the top of spatial.js — the listener sits
   * on the camera boom between the player and the camera so that screen-space
   * left/right and gameplay-space distance are both correct.
   */
  _updateListener(ctx) {
    const cam = ctx.camera;
    const player = this.player ?? (this.player = ctx.peek?.('player') ?? null);
    const pp = player?.position ?? this._playerPos;

    // getWorldDirection refreshes the camera's world matrix for us, so the basis
    // vectors read out of it below are this frame's, not last frame's.
    cam.getWorldDirection(this._fwd);
    const e = cam.matrixWorld.elements;
    this._up.set(e[4], e[5], e[6]).normalize();

    // 0.35 of the way from the player to the eye. At a 21 m boom that is a ~7 m
    // offset, which is `refDistance`, so the player's own sounds are unity gain.
    const k = 0.35;
    this._ear.set(
      pp.x + (cam.position.x - pp.x) * k,
      pp.y + (cam.position.y - pp.y) * k,
      pp.z + (cam.position.z - pp.z) * k
    );
    this.voices.setListener(
      this._ear.x, this._ear.y, this._ear.z,
      this._fwd.x, this._fwd.y, this._fwd.z,
      this._up.x, this._up.y, this._up.z
    );
  }

  /**
   * Footstep cadence, dash detection and armour foley. Driven by distance
   * travelled rather than by a timer, so it stays in step with the animation at
   * any speed and never fires while the player is standing still and sliding.
   */
  _trackPlayer(dt, ctx) {
    const player = this.player ?? (this.player = ctx.peek?.('player') ?? null);
    if (player?.position) {
      this._playerVel.subVectors(player.position, this._playerPos).divideScalar(Math.max(1e-4, dt));
      this._playerPos.copy(player.position);
    }
    const speed = this._playerVel.length();
    const moving = this._playerMoving || speed > 0.4;

    if (this._playerDashing && !this._wasDashing) {
      this._play('player.dash', this._at(this._playerPos, 1.0, 0.9 + this._footRng.float() * 0.3));
    }
    this._wasDashing = this._playerDashing;

    if (!moving) { this._strideAccum = 0; return; }
    const running = speed > 4.0;
    this._strideAccum += Math.min(speed, 12) * dt;
    const stride = running ? STRIDE_RUN : STRIDE_WALK;
    if (this._strideAccum < stride) return;
    this._strideAccum -= stride;
    // Rate limit as well as distance limit: a teleport or a physics glitch must
    // not machine-gun the footstep bank.
    if (this._clock - this._lastFootAt < 0.14) return;
    this._lastFootAt = this._clock;

    const surface = this._surfaceUnder(this._playerPos.x, this._playerPos.z);
    const o = this._at(this._playerPos, 0.9 + this._footRng.float() * 0.25, this._footRng.signed() * 2.2);
    o.position.y = this._playerPos.y + 0.06;   // feet, not centre of mass
    this._play(footCue(surface, running), o);
    this.counters.footsteps++;

    // Armour and cloth on roughly every other step, offset slightly so it reads
    // as gear moving with the body rather than as part of the footfall.
    const r = this._footRng.float();
    if (r < 0.45) {
      const o2 = this._at(this._playerPos, 0.5 + this._footRng.float() * 0.3, this._footRng.signed() * 3);
      this._play(r < 0.22 ? 'foley.armour' : 'foley.cloth', o2);
    }
  }

  /** Surface under a world point, via physics. Falls back to flagstone. */
  _surfaceUnder(x, z) {
    const phys = this.physics ?? this.ctx.peek?.('physics');
    if (!phys?.groundAt) return 'flagstone';
    try {
      const g = phys.groundAt(x, z);
      return g?.surface ? safeSurface(g.surface) : 'flagstone';
    } catch {
      return 'flagstone';
    }
  }

  /* ================================================================ */
  /* Playback                                                         */
  /* ================================================================ */

  /** Fill the shared options object. Never allocates. */
  _at(position, gain = 1, pitch = 0) {
    const o = this._opts;
    if (position) {
      this._pos.x = position.x; this._pos.y = position.y; this._pos.z = position.z;
      o.position = this._pos;
    } else {
      o.position = null;
    }
    o.gain = gain;
    o.pitch = pitch;
    o.reverb = undefined;
    o.bus = undefined;
    o.priority = undefined;
    o.pan = 0;
    o.occluded = undefined;
    return o;
  }

  /**
   * The single playback entry point. Everything — events, ambience, music
   * stingers, the public API — funnels through here.
   *
   * Runs its full parameter resolution even when the graph does not exist, so a
   * headless playtest exercises this path and `counters.silent` proves it did.
   */
  _play(cue, opts) {
    this.counters.cues++;
    let params = resolveCue(cue);
    if (!this.enabled || !this.bank) { this.counters.silent++; return null; }

    let variants = this.bank.variantsOf(cue);
    let entry = variants ? this.bank.get(cue, this.rng.u32() % variants) : null;
    if (!entry?.buffer) {
      // Heavy recipe still in the queue (or an unknown name): fall back once to a
      // warm relative rather than dropping the sound entirely. `bank.get` has
      // already enqueued the real recipe, so this only ever happens once per cue.
      const alt = substituteCue(cue);
      if (!alt) { this.counters.silent++; return null; }
      this.counters.substituted++;
      variants = this.bank.variantsOf(alt);
      entry = variants ? this.bank.get(alt, this.rng.u32() % variants) : null;
      if (!entry?.buffer) { this.counters.silent++; return null; }
      // Keep the ORIGINAL cue's routing — the substitute is a different waveform
      // playing the same role, so it should duck and reverberate identically.
      params = resolveCue(cue);
    }

    // Per-cue pitch variation on top of whatever the caller asked for. This is
    // the cheapest possible defence against sample fatigue and it costs one
    // playbackRate write.
    const jitter = params.pitchVar ? this.rng.signed() * params.pitchVar : 0;
    const prevPitch = opts.pitch ?? 0;
    opts.pitch = prevPitch + jitter;
    const slot = this.voices.play(entry.buffer, params, opts);
    opts.pitch = prevPitch;
    if (!slot) return null;

    this.counters.played++;
    if (params.duck > 0) this.mixer.duck(params.duck);
    return slot;
  }

  /* ================================================================ */
  /* Public API for other subsystems (reached via ctx.get('audio'))   */
  /* ================================================================ */

  /**
   * Play a cue. `position` may be a THREE.Vector3, a plain {x,y,z}, or null for
   * a non-positional sound.
   */
  play(cue, position = null, gain = 1, pitch = 0) {
    return this._play(cue, this._at(position, gain, pitch));
  }

  /** Crossfade the reverb + ambience to a room archetype. */
  setRoom(name, fade = 1.5) {
    const room = resolveRoom(name);
    if (room === this.room) return room;
    this.room = room;
    if (this.enabled) {
      // Queued, not immediate: a room change may arrive mid-frame from a
      // `world:room` event and generating an impulse response inside an event
      // handler is exactly the kind of stall that shows up as a dropped frame.
      this._roomPending = fade;
      this.ambience.setRoom(room);
    }
    return room;
  }

  /** The signature cue. Rate-limited; returns false if it was suppressed. */
  playArise(force = false) {
    if (!force && this._clock - this._lastAriseAt < ARISE_COOLDOWN) return false;
    this._lastAriseAt = this._clock;
    this.counters.arise++;
    if (!this.enabled) return false;
    // `get` returns null while the recipe is still in the background queue —
    // which only happens in the first second or two of a session, before the
    // player could possibly have extracted anything.
    const entry = this.bank.get('arise.cue', 0);
    if (!entry?.buffer) return false;

    const params = resolveCue('arise.cue');
    const o = this._at(null, 1.0, 0);
    o.bus = 'sfx';
    o.reverb = 0.7;
    const slot = this.voices.play(entry.buffer, params, o);
    if (!slot) return false;

    // The mix gets out of the way, and then gets destroyed at the drop. The duck
    // is scheduled to *lead* the drop by 120 ms: a duck that starts on the
    // transient is heard as a duck, one that starts before it is heard as space.
    this.mixer.duck(0.55, 0.35, ARISE_DROP_TIME - 0.5, 0.4);
    this.music.suppress(ARISE_DURATION);
    const ac = this.ac;
    const dropAt = ac.currentTime + ARISE_DROP_TIME;
    // Schedule the second, deeper duck and the reverb bloom on the drop itself.
    // setTimeout is fine here: it is a one-off ~2.5 s out and a few milliseconds
    // of jitter on a 1.5 s ducking envelope is inaudible.
    this._ariseTimeout = setTimeout(() => {
      if (!this.enabled) return;
      this.mixer.duck(1.0, 0.02, 1.4, 1.8);
      this.mixer.reverb.bloom(0.7, 0.04, 0.5, 2.4);
    }, Math.max(0, (dropAt - ac.currentTime - 0.12) * 1000));
    return true;
  }

  setMuted(v) {
    this.masterMuted = !!v;
    this.mixer?.setMuted(this.masterMuted);
    return this.masterMuted;
  }

  /** Bus trim in dB: 'master' | 'sfx' | 'ui' | 'music' | 'ambience' | 'voice'. */
  setBusGain(bus, db) { return this.mixer?.setBusGain(bus, db) ?? false; }

  /** Fire-source positions for brazier crackle; `world` or `fx` may call this. */
  setFireSources(list) { this.ambience?.setFireSources(list); }

  /* ================================================================ */
  /* Event wiring                                                     */
  /* ================================================================ */

  _wireEvents() {
    const on = (type, fn) => this._offs.push(this.ctx.events.on(type, fn));

    /* ---- player -------------------------------------------------- */
    on('player:state', (e) => {
      if (!e) return;
      if (e.position) this._playerPos.copy(e.position);
      if (e.velocity) this._playerVel.copy(e.velocity);
      this._playerMoving = !!e.moving;
      this._playerDashing = !!e.dashing;
    });

    /* ---- casting ------------------------------------------------- */
    on('player:cast', (e) => {
      if (!e) return;
      this.counters.casts++;
      const element = this._elementOf(e.skill, e.element);
      const pos = e.origin ?? this._playerPos;
      this._play(castCue(element), this._at(pos, 1, 0));
      // A melee skill also swings something through the air.
      const weapon = this._weaponOf(e.skill);
      if (element === 'physical') this._play(`swing.${weapon}`, this._at(pos, 0.9, 0));
      this._bumpIntensity(0.1);
    });

    on('skill:ready', () => this._play('ui.skillready', this._at(null, 1, 0)));

    /* ---- impacts ------------------------------------------------- */
    on('combat:hit', (e) => {
      if (!e) return;
      this.counters.hits++;
      const pos = e.position ?? e.target?.position ?? this._playerPos;
      this._lastHitAt = this._clock;
      this._lastHitPos.x = pos.x; this._lastHitPos.y = pos.y; this._lastHitPos.z = pos.z;

      const element = ELEMENT_NAMES.includes(e.element) ? e.element : 'physical';
      // Anything with an actor on the receiving end is flesh unless told
      // otherwise; a skeleton or a construct sets `surface` on the payload.
      const surface = safeSurface(e.surface ?? (e.target?.isShadow ? 'ash' : 'flesh'));
      const weapon = this._weaponOf(e.source?.skill ?? e.skill ?? e.weapon);

      const mag = clamp((e.amount ?? 10) / 40, 0.35, 1.6);
      const o = this._at(pos, 0.8 + mag * 0.45, e.crit ? 1.2 : 0);
      this._play(impactCue(weapon, surface, element), o);

      if (element !== 'physical') {
        this._play(elementImpactCue(element), this._at(pos, 0.7 + mag * 0.3, 0));
      }
      if (e.crit) {
        // The crit layer is a bright glassy ping from the same material matrix —
        // reusing crystal here keeps crits inside the game's sonic palette
        // instead of importing an arcade "ding".
        this._play('hit.blade.crystal', this._at(pos, 0.5, 6));
      }
      if (e.target?.isPlayer) {
        this._play('player.hurt', this._at(null, clamp(mag, 0.5, 1.2), 0));
        this._bumpIntensity(0.22);
      } else {
        // The victim reacts. Not on every hit — an enemy that grunts twelve times
        // a second is comedy — so it is gated on stagger or on a dice roll.
        if (e.stagger > 0 || this.rng.float() < 0.35) {
          this._playVox(e.target, 'hurt', pos);
        }
        this._bumpIntensity(0.13);
      }
    });

    on('combat:miss', (e) => {
      if (!e) return;
      const weapon = this._weaponOf(e.source?.skill);
      this._play(`swing.${weapon}`, this._at(e.position ?? this._playerPos, 0.85, 0));
    });

    on('combat:kill', (e) => {
      if (!e) return;
      this.counters.kills++;
      const pos = e.position ?? e.actor?.position ?? this._playerPos;
      this._playVox(e.actor, 'death', pos);
      // The body hitting the floor, a beat later. `fist` on `flesh` is exactly
      // the right excitation for a corpse landing.
      this._play('hit.fist.flesh', this._at(pos, 0.7, -3));
      if (e.actor?.isPlayer) this._play('player.death', this._at(null, 1.2, 0));
      this._bumpIntensity(0.2);
    });

    on('actor:stagger', (e) => {
      if (!e?.actor) return;
      this._play('foley.armour', this._at(e.actor.position ?? this._playerPos, 0.8, 0));
      if (this.rng.float() < 0.5) this._playVox(e.actor, 'hurt', e.actor.position);
    });

    on('actor:spawn', (e) => {
      const a = e?.actor;
      if (!a) return;
      const arch = safeArchetype(a.archetype ?? a.kind ?? a.type ?? a.name);
      if (arch === 'boss') { this.music?.setBoss(true); this._bumpIntensity(0.6); }
      // Not every spawn announces itself: in a pack of eight that would be a wall
      // of noise. One in three, and always for a boss.
      if (arch === 'boss' || this.rng.float() < 0.34) {
        this._playVox(a, arch === 'boss' ? 'shriek' : 'alert', a.position);
      }
    });

    /* ---- surfaces / fx ------------------------------------------- */
    on('fx:impact', (e) => {
      if (!e) return;
      const pos = e.position ?? this._playerPos;
      // Dedupe against the combat:hit that almost certainly just fired for the
      // same collision: same instant, same place, two sounds, audible flam.
      if (this._clock - this._lastHitAt < 0.045) {
        const dx = pos.x - this._lastHitPos.x, dy = pos.y - this._lastHitPos.y, dz = pos.z - this._lastHitPos.z;
        if (dx * dx + dy * dy + dz * dz < 0.36) return;
      }
      const surface = safeSurface(e.surface);
      const element = ELEMENT_NAMES.includes(e.element) ? e.element : 'physical';
      const mag = clamp(e.magnitude ?? 1, 0.2, 2);
      this._play(impactCue(element === 'physical' ? 'blade' : 'magic', surface, element),
        this._at(pos, 0.55 + mag * 0.35, 0));
    });

    on('fx:explosion', (e) => {
      if (!e) return;
      this.counters.explosions++;
      const pos = e.position ?? this._playerPos;
      const element = ELEMENT_NAMES.includes(e.element) ? e.element : 'physical';
      const mag = clamp(e.magnitude ?? 1, 0.4, 2);
      this._play(explosionCue(element), this._at(pos, 0.8 + mag * 0.35, -mag * 2));
      this.mixer?.reverb.bloom(0.3 * mag, 0.05, 0.2, 1.4);
      this._bumpIntensity(0.28);
    });

    on('camera:shake', (e) => {
      // A big shake gets a sub rumble underneath it. Reusing the taiko pitched
      // down two octaves gives a real membrane rather than a sine, and costs
      // nothing extra in the bank.
      const amount = e?.amount ?? 0;
      if (amount < 0.45) return;
      this._play('music.taiko', this._at(null, clamp(amount, 0.4, 1.2) * 0.5, -24));
    });

    on('time:hitstop', (e) => {
      this.mixer?.impactDip(clamp(e?.duration ?? 0.06, 0.02, 0.2), 1 - clamp(e?.scale ?? 0.04, 0, 1));
    });

    /* ---- shadow -------------------------------------------------- */
    on('shadow:extract', (e) => {
      const pos = e?.position ?? e?.actor?.position ?? this._playerPos;
      this._play('shadow.extract', this._at(pos, 1, 0));
      this.mixer?.reverb.bloom(0.35, 0.2, 0.3, 1.6);
      this._bumpIntensity(0.3);
    });

    on('shadow:arise', (e) => {
      const pos = e?.position ?? e?.soldier?.position ?? this._playerPos;
      this._play('shadow.arise', this._at(pos, 1, 0));
      // The full cue is the *moment*, not the per-soldier effect; the cooldown
      // inside playArise collapses a mass summon into one cinematic hit.
      this.playArise();
      this._bumpIntensity(0.45);
    });

    /* ---- loot / progression -------------------------------------- */
    on('loot:drop', (e) => {
      const rarity = e?.item?.rarity ?? 'common';
      this._play(`loot.drop.${rarity}`, this._at(e?.position ?? this._playerPos, 1, 0));
    });
    on('loot:pickup', () => this._play('loot.pickup', this._at(null, 1, 0)));
    on('level:up', () => {
      this._play('ui.levelup', this._at(null, 1, 0));
      this.mixer?.reverb.bloom(0.25, 0.1, 0.4, 1.6);
    });
    on('ui:system', () => this._play('ui.system', this._at(null, 1, 0)));
    on('ui:toast', () => this._play('ui.click', this._at(null, 0.6, 0)));

    /* ---- world --------------------------------------------------- */
    on('world:ready', (e) => {
      this.setRoom(e?.room?.kind ?? 'crypt', 0.5);
      this.music?.setBoss(false);
    });
    on('world:room', (e) => {
      const kind = e?.room?.kind ?? e?.room?.type ?? e?.room?.archetype ?? e?.room?.name;
      if (kind) this.setRoom(kind);
      if (e?.cleared) {
        // A cleared room drops intensity hard: the silence after a fight is what
        // makes the next fight land.
        this._intensityTarget = Math.min(this._intensityTarget, 0.12);
        this.music?.setBoss(false);
      }
    });

    /* ---- generic ------------------------------------------------- */
    on('audio:cue', (e) => {
      if (!e?.cue) return;
      if (e.cue === 'arise') { this.playArise(true); return; }
      this._play(e.cue, this._at(e.position ?? null, e.gain ?? 1, e.pitch ?? 0));
    });
  }

  /** Enemy vocalisation, with the archetype resolved from whatever `ai` set. */
  _playVox(actor, kind, position) {
    if (!actor) return null;
    const arch = safeArchetype(actor.archetype ?? actor.kind ?? actor.type ?? actor.name);
    this.counters.vox++;
    const pos = position ?? actor.position ?? this._playerPos;
    const o = this._at(pos, 0.9 + this.rng.float() * 0.25, 0);
    // Voices come from the head, not the feet.
    o.position.y = (pos.y ?? 0) + (actor.height ?? 1.8) * 0.82;
    return this._play(voxCue(arch, kind), o);
  }

  /** Element from a skill descriptor, best-effort. */
  _elementOf(skill, explicit) {
    if (ELEMENT_NAMES.includes(explicit)) return explicit;
    const name = typeof skill === 'string' ? skill : (skill?.element ?? skill?.id ?? skill?.name ?? '');
    if (ELEMENT_NAMES.includes(name)) return name;
    const k = String(name).toLowerCase();
    for (const el of ELEMENT_NAMES) if (k.includes(el)) return el;
    if (/fire|flame|burn|ember|pyre/.test(k)) return 'fire';
    if (/frost|ice|cold|chill/.test(k)) return 'frost';
    if (/light|bolt|shock|storm|thunder/.test(k)) return 'lightning';
    if (/holy|light|divine|sacred/.test(k)) return 'holy';
    if (/shadow|dark|void|monarch|arise|soul/.test(k)) return 'shadow';
    return 'physical';
  }

  /** Weapon class from a skill descriptor, best-effort. */
  _weaponOf(skill) {
    const name = typeof skill === 'string' ? skill : (skill?.weapon ?? skill?.id ?? skill?.name ?? '');
    const k = String(name).toLowerCase();
    if (/hammer|mace|maul|smash|slam|crush|blunt/.test(k)) return 'blunt';
    if (/spear|thrust|pierce|stab|arrow|bolt|dagger/.test(k)) return 'pierce';
    if (/claw|rake|rend|bite/.test(k)) return 'claw';
    if (/punch|fist|kick|shove/.test(k)) return 'fist';
    if (/spell|magic|bolt|nova|shadow|fire|frost/.test(k)) return 'magic';
    return safeWeapon('blade');
  }

  /** Raise the combat intensity target. Saturating, never above 1. */
  _bumpIntensity(amount) {
    this._intensityTarget = clamp(this._intensityTarget + amount, 0, 1);
  }

  /* ================================================================ */
  /* Introspection                                                    */
  /* ================================================================ */

  stats() {
    return {
      enabled: this.enabled,
      state: this.ac?.state ?? (this.captureMode ? 'capture-mode' : 'not-started'),
      sampleRate: this.ac?.sampleRate ?? 0,
      room: this.room,
      intensity: +this.intensity.toFixed(3),
      counters: { ...this.counters },
      budget: this.budget,
      bank: this.bank?.stats() ?? null,
      voices: this.voices?.stats() ?? null,
      music: this.music?.stats() ?? null,
      ambience: this.ambience?.stats() ?? null,
      ariseReady: !!this.bank?.cache.has('arise.cue|0'),
      reverbMb: this.mixer ? +(this.mixer.reverb.bytes() / (1 << 20)).toFixed(2) : 0,
      reduction: this.mixer ? +this.mixer.reduction().toFixed(2) : 0,
    };
  }

  /**
   * Synthesis self-test. Runs the whole DSP path with NO AudioContext, which is
   * the only way to verify the sound design inside the capture container.
   *
   * For each probed cue it reports the measurements that actually correspond to
   * the quality bar: duration, peak, RMS, attack time in milliseconds (the
   * "transient with real attack" requirement) and spectral centroid (the number
   * that separates a dull thud from a bright clang). It also verifies that every
   * cue the event layer can name has a recipe.
   *
   *   node arpg/tools/probe.mjs --port=5286 --eval="ctx.peek('audio').selfTest()"
   */
  selfTest(opts = {}) {
    const sampleRate = opts.sampleRate ?? 48000;
    const bank = new SoundBank(sampleRate, this.rng.fork(), this.budget, null);

    const probes = opts.cues ?? [
      'hit.blade.flesh', 'hit.blade.stone', 'hit.blade.metal', 'hit.blade.bone',
      'hit.blunt.flesh', 'hit.blunt.stone', 'hit.claw.flesh', 'hit.magic.crystal',
      'swing.blade', 'foot.flagstone', 'foot.stone.run', 'foley.chain',
      'magic.cast.shadow', 'magic.impact.shadow', 'magic.impact.fire',
      'magic.impact.frost', 'magic.impact.lightning',
      'shadow.arise', 'ui.click', 'ui.system', 'ui.levelup',
      'vox.ghoul.growl', 'vox.beast.growl', 'vox.wraith.shriek', 'vox.boss.growl',
      'music.kick', 'music.taiko', 'amb.drip', 'loot.drop.mythic',
    ];

    const t0 = performance.now();
    const results = [];
    for (const cue of probes) {
      const entry = bank.recipes.has(cue) ? bank._bake(cue, 0, bank.recipes.get(cue)) : null;
      if (!entry) { results.push({ cue, error: 'no recipe' }); continue; }
      const sig = entry.sig;
      results.push({
        cue,
        ms: +(sig.duration * 1000).toFixed(0),
        ch: sig.channels,
        peak: +sig.peak().toFixed(3),
        rms: +sig.rms().toFixed(4),
        attackMs: +(sig.attackSamples(0.5) / sampleRate * 1000).toFixed(2),
        centroidHz: Math.round(sig.centroid()),
      });
    }

    // Coverage: every cue the event layer can produce must have a recipe.
    const missing = [];
    for (const s of SURFACES) {
      for (const w of ['blade', 'blunt', 'pierce', 'claw', 'fist', 'magic']) {
        if (!bank.has(`hit.${w}.${s}`)) missing.push(`hit.${w}.${s}`);
      }
      if (!bank.has(`foot.${s}`)) missing.push(`foot.${s}`);
      if (!bank.has(`foot.${s}.run`)) missing.push(`foot.${s}.run`);
    }
    for (const e of ELEMENT_NAMES) {
      for (const p of ['magic.cast', 'magic.impact', 'magic.explosion']) {
        if (!bank.has(`${p}.${e}`)) missing.push(`${p}.${e}`);
      }
    }
    for (const a of ['ghoul', 'knight', 'beast', 'wraith', 'shade', 'boss']) {
      for (const k of ['growl', 'shriek', 'attack', 'alert', 'hurt', 'death']) {
        if (!bank.has(`vox.${a}.${k}`)) missing.push(`vox.${a}.${k}`);
      }
    }

    // The signature cue and one impulse response, measured in full.
    let arise = null;
    if (opts.arise !== false) {
      const sig = buildAriseCue(sampleRate, this.rng.fork());
      arise = {
        ms: +(sig.duration * 1000).toFixed(0),
        peak: +sig.peak().toFixed(3),
        rms: +sig.rms().toFixed(4),
        megabytes: +(sig.bytes / (1 << 20)).toFixed(2),
      };
    }

    const summary = {
      ok: missing.length === 0 && results.every((r) => !r.error && r.peak > 0.05),
      sampleRate,
      probed: results.length,
      missing: missing.slice(0, 12),
      missingCount: missing.length,
      recipes: bank.recipes.size,
      bakeMs: +bank.bakeMs.toFixed(1),
      totalMs: +(performance.now() - t0).toFixed(1),
      megabytes: +(bank.bytes / (1 << 20)).toFixed(2),
      rooms: Object.keys(ROOMS),
      arise,
      results,
    };
    bank.dispose();
    return summary;
  }

  /* ================================================================ */
  /* Teardown                                                         */
  /* ================================================================ */

  dispose() {
    this._stopTimer();
    if (this._ariseTimeout) { clearTimeout(this._ariseTimeout); this._ariseTimeout = null; }
    this._removeGestureHooks();
    for (const off of this._offs) { try { off(); } catch { /* bus already cleared */ } }
    this._offs.length = 0;

    this.music?.dispose();
    this.ambience?.dispose();
    this.voices?.dispose();
    this.mixer?.dispose();
    this.bank?.dispose();
    if (this.ac) {
      try { this.ac.onstatechange = null; this.ac.close(); } catch { /* already closed */ }
    }
    this.ac = null;
    this.mixer = null;
    this.bank = null;
    this.voices = null;
    this.music = null;
    this.ambience = null;
    this.enabled = false;
  }
}
